import type {
  ExchangeAdapter,
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
  ExchangePublicTrade,
  ExchangeFundingPayment,
  ExchangeKline,
  FundingHistoryRow
} from "./interface.js";
import { assertCandleInterval } from "./interface.js";
import type { ResolvedSlippage } from "./slippage.js";
import type { EvmSigner } from "../signer/index.js";
import { LocalEvmSigner } from "../signer/index.js";
import type { AgentMeta } from "../settings.js";
import { DEFINITE_ORDER_FAILURE_CODES, PerpError, classifyError, extractErrorMessage, orderNotSent, orderOutcomeUnknown, sendFailure, type ErrorCode, noAccountKeyError } from "../errors.js";
import { parseFiniteVenueNumber, venueRateField } from "../utils/numeric.js";
import { alignProtectionPrice, floorSize, formatComputedPrice, slippagePrice, subDecimal } from "./precision.js";
import { unsupported } from "./trading-v2.js";
import { buildHlUserSignedAction, hlUserSignedNonceField, signHlL1Action, signHlUserSignedAction, type HlSignature, type HlUserSignedType } from "./hl-signing.js";
import type { Network } from "./venue.js";
import { HL_CLOID_RE } from "./venues/hyperliquid.js";
import { rateLimitedError } from "./rate-limiter.js";
import { fetchAndCache, withCache, TTL_ACCOUNT } from "../cache.js";
import { approvalFromMax, builderGateOf, hlFeeTenthsBps, NO_BUILDER, requireFeeBps, type BuilderApproval, type BuilderDecision, type BuilderFeeGate, type BuilderTarget } from "./builder-fee.js";

/** HL native time-in-force values. */
export type HlTif = "Gtc" | "Ioc" | "Alo";

/**
 * Map a TIF input to HL's native value. Accepts the common names
 * GTC/IOC/ALO and the native spellings case-insensitively. FOK is not offered by
 * HL (no FOK emulation) → CAPABILITY_UNSUPPORTED; anything else likewise.
 */
export function hlTif(raw: string): HlTif {
  const t = raw.trim().toUpperCase();
  if (t === "GTC") return "Gtc";
  if (t === "IOC") return "Ioc";
  if (t === "ALO") return "Alo";
  if (t === "FOK") {
    throw unsupported("Hyperliquid", "fok", "Hyperliquid has no fill-or-kill time-in-force (partial IOC fills cannot be undone)", "Use --tif IOC (partial fills possible) or GTC");
  }
  throw unsupported("Hyperliquid", "timeInForce", `time-in-force ${raw} is not offered`, "Use one of: GTC, IOC, ALO");
}

/** HL lot step implied by szDecimals ("1" for 0, "0.001" for 3) — sizes are floored to it (floorSize). */
export function hlSizeStep(szDecimals: number): string {
  return szDecimals <= 0 ? "1" : `0.${"0".repeat(szDecimals - 1)}1`;
}

/**
 * Slippage-bounded IOC protection price.
 *
 * `reference` × (1 ± bps/10000), then aligned TOWARD CROSSING (buy → up, sell →
 * down) on HL's price grid: at most 5 significant figures and at most
 * `maxDecimals − szDecimals` decimals (maxDecimals 6 perps / 8 spot); integer
 * prices are always valid. The returned `appliedBps` is the bound actually sent
 * (after rounding) relative to the reference — it can exceed the requested bps
 * by up to one grid step because alignment never narrows the bound toward
 * not-crossing.
 */
export function hlProtectionPrice(
  reference: number, side: "buy" | "sell", bps: number, szDecimals: number, maxDecimals: 6 | 8,
): { protectionPrice: string; appliedBps: number } {
  const raw = slippagePrice(String(reference), side, bps);
  const px = Number(raw);
  let e = Math.floor(Math.log10(px));
  if (10 ** (e + 1) <= px) e += 1;
  if (10 ** e > px) e -= 1;
  const decimals = Math.max(0, Math.min(maxDecimals - szDecimals, 4 - e));
  const tick = decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
  const protectionPrice = alignProtectionPrice(raw, tick, side);
  const appliedBps = Math.abs(Number(protectionPrice) - reference) / reference * 10_000;
  return { protectionPrice, appliedBps };
}

/**
 * A USER-SUPPLIED limit / trigger / modify price checked against HL's price grid:
 * an off-grid limit price is refused, never rounded — rounding to nearest can move a buy price UP.
 * HL docs (trading/tick-and-lot-size): "Prices can have up to 5 significant figures, but no more
 * than MAX_DECIMALS - szDecimals decimal places where MAX_DECIMALS is 6 for perps and 8 for spot.
 * Integer prices are always allowed, regardless of the number of significant figures."
 * Non-numeric / non-positive → INVALID_PARAMS; off-grid → INVALID_TICK (with the nearest on-grid
 * prices below / above). Returns the price normalized (no leading / trailing zeros). Computed
 * prices (protection, market-trigger `p`) are aligned with hlProtectionPrice instead.
 */
export function hlRequirePriceOnGrid(price: string, szDecimals: number, maxDecimals: 6 | 8, what: string): string {
  const s = String(price).trim();
  if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid ${what} must be a positive plain decimal (got "${price}")`, {
      exchange: "hyperliquid", remediation: "Pass a plain decimal price such as 3012.5 (no exponent, sign or spaces)",
    });
  }
  const [ipRaw, fpRaw = ""] = s.split(".");
  const ip = ipRaw.replace(/^0+(?=\d)/, "");
  const fp = fpRaw.replace(/0+$/, "");
  const normalized = fp === "" ? ip : `${ip}.${fp}`;
  if (fp === "") return normalized; // integer prices are always valid
  const maxDec = Math.max(0, maxDecimals - szDecimals);
  const sigFigs = (ip + fp).replace(/^0+/, "").length;
  if (fp.length <= maxDec && sigFigs <= 5) return normalized;
  // Nearest on-grid prices: the grid tick at this magnitude (≤ 5 sig figs, ≤ maxDec decimals).
  const px = Number(normalized);
  const e = Math.floor(Math.log10(px));
  const decimals = Math.max(0, Math.min(maxDec, 4 - e));
  const tick = decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
  const above = alignProtectionPrice(normalized, tick, "buy");
  const below = px >= Number(tick) ? alignProtectionPrice(normalized, tick, "sell") : null;
  throw new PerpError("INVALID_TICK", `Hyperliquid ${what} ${price} is off the price grid (max 5 significant figures and ${maxDec} decimals for szDecimals ${szDecimals}); nothing was sent`, {
    exchange: "hyperliquid",
    remediation: `Use an on-grid price, e.g. ${below !== null ? `${below} or ` : ""}${above}`,
  });
}

/** CCTP destinations for Hyperliquid withdrawals (Circle CCTP domain ids: Ethereum 0, Arbitrum 3, Base 6). */
export type HlCctpChain = "arbitrum" | "ethereum" | "base";
export const HL_CCTP_ROUTES: Record<HlCctpChain, { cctpDomain: number; forwardingFeeUsdc: string | null }> = {
  // Forwarding fee: Circle documents 0.2 USDC for Arbitrum; other chains' fee is not published (null = unknown).
  arbitrum: { cctpDomain: 3, forwardingFeeUsdc: "0.2" },
  ethereum: { cctpDomain: 0, forwardingFeeUsdc: null },
  base: { cctpDomain: 6, forwardingFeeUsdc: null },
};

/**
 * A COMPUTED price (strategy quote, grid level, slice limit) moved onto the HL price grid in the
 * passive direction: "down" for a buy, "up" for a sell — never more aggressive than computed.
 * User-supplied prices are never aligned (hlRequirePriceOnGrid refuses them instead).
 */
export function hlAlignPriceToGrid(price: string, szDecimals: number, maxDecimals: 6 | 8, direction: "down" | "up"): string {
  const s = String(price).trim();
  if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid computed price must be a positive plain decimal (got "${price}")`, { exchange: "hyperliquid" });
  }
  const px = Number(s);
  const maxDec = Math.max(0, maxDecimals - szDecimals);
  const e = Math.floor(Math.log10(px));
  // ≤ 5 significant figures at this magnitude, ≤ maxDec decimals; integers are always valid.
  const decimals = Math.max(0, Math.min(maxDec, 4 - e));
  const tick = decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
  const aligned = alignProtectionPrice(s, tick, direction === "up" ? "buy" : "sell");
  if (!(Number(aligned) > 0)) {
    throw new PerpError("INVALID_TICK", `Hyperliquid computed price ${price} aligns to 0 on the grid`, { exchange: "hyperliquid" });
  }
  // Aligning up across a power of ten (e.g. 9.99995 → 10.0000) stays valid: hlRequirePriceOnGrid re-checks.
  return hlRequirePriceOnGrid(aligned, szDecimals, maxDecimals, "computed price");
}

/**
 * Grid rounding (toward crossing) can widen the bound past the requested bps; a bound
 * actually sent above the venue's maxSlippageBps → INVALID_PARAMS before anything is sent.
 * (slippage.js is imported lazily: it loads settings and the venue registry.)
 */
export async function assertHlAppliedBps(appliedBps: number, what: string): Promise<void> {
  const { venueMaxSlippageBps } = await import("./slippage.js");
  const max = venueMaxSlippageBps("hyperliquid");
  if (!(appliedBps <= max)) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid ${what}: the bound after HL price-grid rounding is ${appliedBps.toFixed(2)} bps, above the venue maximum ${max} bps`, {
      exchange: "hyperliquid",
      remediation: "Lower --slippage-bps, or place a limit order",
    });
  }
}

/**
 * Definite IOC outcome of a raw HL `order` response (shared contract with the
 * perp-order lane). Reads `response.data.statuses[0]`:
 * - `{ filled: { totalSz } }` with a plain decimal totalSz → that size, final;
 * - `{ error }` that is HL's IOC no-match cancel ("could not immediately match")
 *   → the venue explicitly cancelled the IOC with nothing filled → "0", final;
 * - anything else (resting, other errors, unexpected shape) → null: the shape
 *   does not prove a final fill size.
 */
export function hlIocOutcome(raw: unknown): { filledSize: string; final: true } | null {
  const statuses = (raw as { response?: { data?: { statuses?: unknown } } } | null)?.response?.data?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return null;
  const st = statuses[0] as Record<string, unknown> | null;
  if (!st || typeof st !== "object") return null;
  const filled = st.filled as { totalSz?: unknown } | undefined;
  if (filled && typeof filled === "object") {
    return typeof filled.totalSz === "string" && /^\d+(\.\d+)?$/.test(filled.totalSz)
      ? { filledSize: filled.totalSz, final: true }
      : null;
  }
  if (st.resting === undefined && typeof st.error === "string" && /could not immediately match/i.test(st.error)) {
    return { filledSize: "0", final: true };
  }
  return null;
}

/**
 * Decimal amount string for HL actions ("12.50" → "12.5"). Non-positive / non-numeric → INVALID_PARAMS
 * (nothing is rounded or substituted).
 */
export function hlAmountString(amount: string): string {
  const a = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(a) || !(Number(a) > 0)) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid amount must be a positive decimal (got "${amount}")`, { exchange: "hyperliquid" });
  }
  const noLead = a.replace(/^0+(?=\d)/, "");
  return noLead.includes(".") ? noLead.replace(/\.?0+$/, "") : noLead;
}

/**
 * Verdict of a twapOrder / twapCancel response. The envelope is "ok" even when the TWAP was
 * refused: the verdict is `response.data.status` — `{ running: { twapId } }` (placed), the string
 * "success" (cancelled) or `{ error }` (refused → ORDER_REJECTED). Any other shape → ORDER_PENDING.
 */
export function hlValidateTwapResult(result: unknown, what: string): void {
  const status = (result as { response?: { data?: { status?: unknown } } } | null)?.response?.data?.status;
  if (status === "success") return;
  if (status !== null && typeof status === "object") {
    const st = status as { error?: unknown; running?: { twapId?: unknown } };
    if (typeof st.error === "string" && st.error !== "") {
      throw new PerpError("ORDER_REJECTED", `Hyperliquid ${what} rejected: ${st.error}`, { exchange: "hyperliquid" });
    }
    if (st.running !== null && typeof st.running === "object" && typeof st.running.twapId === "number") return;
  }
  throw orderOutcomeUnknown("hyperliquid", what, new Error(`unexpected TWAP response ${JSON.stringify(result).slice(0, 200)}`),
    "Do NOT resubmit — check the account's TWAP orders on Hyperliquid first");
}

/** HL TWAP running time bounds in minutes: "from 5 minutes to 7 days" (docs trading/order-types, TWAP details). */
export const HL_TWAP_MIN_MINUTES = 5;
export const HL_TWAP_MAX_MINUTES = 7 * 24 * 60;
/** HL TWAP "$100 minimum total order size" (same page). */
export const HL_TWAP_MIN_NOTIONAL_USD = 100;

/**
 * Pre-check of a native TWAP against the venue's documented bounds — docs trading/order-types:
 * "Running time can be set from 5 minutes to 7 days, with a $100 minimum total order size."
 * The total order size is valued at the mark price. Nothing is sent when it throws.
 */
export function hlAssertTwapBounds(symbol: string, size: string, durationMinutes: number, markPrice: number): void {
  if (!Number.isInteger(durationMinutes) || durationMinutes < HL_TWAP_MIN_MINUTES || durationMinutes > HL_TWAP_MAX_MINUTES) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid TWAP running time must be a whole number of minutes from ${HL_TWAP_MIN_MINUTES} to ${HL_TWAP_MAX_MINUTES} (7 days); got ${durationMinutes}`, {
      exchange: "hyperliquid", remediation: `Pass a duration between ${HL_TWAP_MIN_MINUTES} and ${HL_TWAP_MAX_MINUTES} minutes`,
    });
  }
  const sz = Number(size);
  if (!(sz > 0) || !Number.isFinite(sz)) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid TWAP size must be a positive number (got "${size}")`, { exchange: "hyperliquid" });
  }
  const notional = sz * markPrice;
  if (notional < HL_TWAP_MIN_NOTIONAL_USD) {
    throw new PerpError("SIZE_TOO_SMALL", `Hyperliquid TWAP total order size must be at least $${HL_TWAP_MIN_NOTIONAL_USD}; ${size} ${symbol.toUpperCase()} is ~$${notional.toFixed(2)} at mark ${markPrice}`, {
      exchange: "hyperliquid", remediation: `Raise the size to at least $${HL_TWAP_MIN_NOTIONAL_USD} notional, or place a regular order`,
    });
  }
}

/**
 * "sl" when the trigger is on the adverse side of the reference (buy ≥ ref, sell ≤ ref), else "tp".
 * The reference must be the MARK price — docs trading/take-profit-and-stop-loss-orders-tp-sl:
 * "The mark price is used to trigger TP/SL orders."
 */
export function hlTriggerKind(side: "buy" | "sell", trigger: number, reference: number): "tp" | "sl" {
  return (side === "buy" ? trigger >= reference : trigger <= reference) ? "sl" : "tp";
}

/** HL spot coin names: "@<pair index>" or "<BASE>/<QUOTE>" (e.g. "@107", "PURR/USDC"). Perp coins are neither. */
/** Markets without a position whose setting `account settings` reads (recent fills, activeAssetData weight 20 each). */
export const HL_SETTINGS_FILL_MARKETS = 5;

export function hlIsSpotCoin(coin: string): boolean {
  return coin.startsWith("@") || coin.includes("/");
}

/**
 * Destination of a withdraw3 / usdSend: a 20-byte hex address, sent lower-cased (the venue
 * hashes the string as signed; the official SDKs send lower-case). Anything else → INVALID_PARAMS.
 */
export function hlDestination(destination: string): string {
  const d = String(destination).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(d) || /^0x0{40}$/.test(d)) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid destination must be a 0x-prefixed 20-byte address (got "${destination}"); nothing was sent`, { exchange: "hyperliquid" });
  }
  return d.toLowerCase();
}

/**
 * On-disk lifetime of the public market metadata (info `meta`, `perpDexs`) shared by every CLI
 * process (cache.ts). Asset ids are universe positions; a market listed inside this window is
 * unknown (SYMBOL_NOT_FOUND) until the entry expires.
 */
export const HL_MARKET_META_TTL_MS = 5 * 60_000;

/**
 * On-disk lifetime of the user's account abstraction mode (info `userAbstraction`), shared by
 * every CLI process of the same network + address. Docs ("Rate limits and user limits"): "REST
 * requests share an aggregated weight limit of 1200 per minute" and `userAbstraction` is one of
 * "All other documented `info` requests [that] have weight 20" — read on every invocation it was
 * the largest fixed cost of a command. The mode is a per-user setting that only changes by an
 * explicit `userSetAbstraction`; `perp wallet manage account-mode` drops the entry when it sets
 * one and always reads it fresh. A change made outside this CLI (web app) is seen after at most
 * this window. The key is outside the `acct:` prefix, so the per-command account-cache
 * invalidation does not force a re-read.
 */
export const HL_ABSTRACTION_TTL_MS = 60_000;

/** Cache-key prefix of the abstraction mode for a network (invalidateCache prefix: every address). */
export function hlAbstractionCachePrefix(network: string): string {
  return `mode:hl:${network}:abstraction:`;
}

/** Perp universe entry of info `meta` (marginMode / onlyIsolated are present only on restricted assets). */
type HlUniverseAsset = { name: string; szDecimals?: number; marginMode?: string; onlyIsolated?: boolean; isDelisted?: boolean };

/**
 * Margin tiers of a universe entry. Docs "Margin tiers": "For IDs less than 50, there is a single
 * tier with max leverage equal to the ID" — those tables are not in `marginTables`, so the
 * implicit tier is emitted instead of null. Unknown ids ≥ 50 → null.
 */
export function hlMarginTiersOf(marginTableId: unknown, tierMap: ReadonlyMap<number, Array<{ lowerBound: number; maxLeverage: number }>>): Array<{ lowerBound: number; maxLeverage: number }> | null {
  const id = Number(marginTableId);
  const tiers = tierMap.get(id);
  if (tiers !== undefined) return tiers;
  return Number.isInteger(id) && id > 0 && id < 50 ? [{ lowerBound: 0, maxLeverage: id }] : null;
}

/** Venue margin restriction of a universe entry: strictIsolated (no margin removal) / noCross; null = unrestricted. */
export function hlMarginModeOf(asset: { marginMode?: string; onlyIsolated?: boolean }): "strictIsolated" | "noCross" | null {
  if (asset.marginMode === "strictIsolated") return "strictIsolated";
  if (asset.marginMode === "noCross" || asset.onlyIsolated === true) return "noCross";
  return null;
}

/** HIP-3 (builder-deployed) asset ids start at 110000 (110000 + dexIndex × 10000 + universe index). */
export const HIP3_MIN_ASSET_ID = 110_000;

/**
 * HL's documented slippage tolerance for MARKET TP/SL triggers ("TP/SL market orders have a
 * slippage tolerance of 10%", docs trading/take-profit-and-stop-loss-orders-tp-sl). A market
 * trigger's `p` is sent at trigger ± this bound (the official SDK / app send a wide limit, never
 * the trigger itself): if the venue honours `p` as a limit, a `p` equal to the trigger could
 * rest unfilled once the stop fires.
 */
export const HL_MARKET_TPSL_SLIPPAGE_BPS = 1000;

/** A `{"status":"err","response":…}` envelope from POST /exchange: the venue processed the request and refused it. */
export class HlErrResponse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HlErrResponse";
  }
}

/**
 * A user-signed action (withdraw3 / usdSend / usdClassTransfer / approveBuilderFee / tokenDelegate)
 * the venue answered with an `err` envelope executed nothing (live testnet 2026-10-02:
 * withdraw3 → {"status":"err","response":"Error withdrawing from bridge"}, ledger and balance
 * unchanged). A balance / margin refusal keeps its code (INSUFFICIENT_BALANCE — callers size from
 * it); any other refusal → ACTION_REJECTED (definite, non-retryable). Transport / parse failures
 * (no envelope) are returned unchanged — their outcome is unknown.
 */
export function hlUserActionRejection(type: string, e: unknown): unknown {
  if (!(e instanceof HlErrResponse)) return e;
  const c = classifyError(e);
  if (c.code === "INSUFFICIENT_BALANCE" || c.code === "MARGIN_INSUFFICIENT") {
    return new PerpError(c.code, e.message, { exchange: "hyperliquid", action: type });
  }
  return new PerpError("ACTION_REJECTED", `Hyperliquid refused ${type}: ${e.message} — nothing was executed`, {
    exchange: "hyperliquid", action: type, venueResponse: e.message,
    remediation: "The venue refused the request and moved nothing; check the venue message above (balances: perp -e hyperliquid portfolio)",
  });
}

/** L1 action types that place or amend orders (their refusal is ORDER_REJECTED; every other type → ACTION_REJECTED). */
const HL_ORDER_ACTION_TYPES: ReadonlySet<string> = new Set(["order", "batchModify", "modify", "twapOrder"]);

/**
 * An L1 action (order / cancel / updateLeverage / agentSendAsset / …) answered with a top-level
 * `err` envelope was refused as a whole and executed nothing — docs for-developers/api/error-responses:
 * "Some errors are a deterministic function of the payload itself, and these are instead returned
 * earlier as part of pre-validation. In this case only one error is returned for the entire payload".
 * A balance / margin refusal keeps its code; any other refusal → ORDER_REJECTED (order actions) or
 * ACTION_REJECTED — definite and non-retryable, never the retryable EXCHANGE_ERROR. Transport /
 * parse failures (no envelope) are returned unchanged.
 */
export function hlL1ActionRejection(type: string, e: unknown): unknown {
  if (!(e instanceof HlErrResponse)) return e;
  const c = classifyError(e);
  if (c.code === "INSUFFICIENT_BALANCE" || c.code === "MARGIN_INSUFFICIENT") {
    return new PerpError(c.code, e.message, { exchange: "hyperliquid", action: type });
  }
  const isOrder = HL_ORDER_ACTION_TYPES.has(type);
  return new PerpError(isOrder ? "ORDER_REJECTED" : "ACTION_REJECTED", `Hyperliquid refused ${type}: ${e.message} — nothing was executed`, {
    exchange: "hyperliquid", action: type, venueResponse: e.message,
    remediation: "The venue refused the whole request and executed nothing; fix the cause named in the venue message above before sending it again",
  });
}

/** POST /info userFunding page size (docs: at most 500 rows per response). */
const HL_FUNDING_PAGE = 500;
/** 7 days of hourly funding = 168 rows per coin; 20 pages = 10 000 rows (~60 coins). */
const HL_FUNDING_MAX_PAGES = 20;

/**
 * candleSnapshot intervals (docs "Candle snapshot": "Supported intervals") with their nominal
 * length. Anything else is answered 422 "Failed to deserialize" (live 2026-10-19, "7m"), so it is
 * refused as INVALID_PARAMS before sending. "1M" buckets are 30 days, not calendar months
 * (live: consecutive 1M opens 30 d apart); "1w" buckets open on Thursday 00:00 UTC.
 */
export const HL_CANDLE_INTERVAL_MS: Readonly<Record<string, number>> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000,
  "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000, "1M": 2_592_000_000,
};
/** Docs "Candle snapshot": "Only the most recent 5000 candles are available". */
export const HL_CANDLE_CAP = 5000;
/** Earliest candleSnapshot start (unix ms) for `interval` at `now`: now − 5000 × interval. Unknown interval → NaN. */
export function hlEarliestCandleStart(interval: string, now = Date.now()): number {
  return now - HL_CANDLE_CAP * (HL_CANDLE_INTERVAL_MS[interval] ?? Number.NaN);
}
/** recentTrades returns the last 10 trades, with no count parameter (live 2026-10-19). */
export const HL_RECENT_TRADES_CAP = 10;
/** l2Book returns at most 20 levels per side (docs l2Book; live 2026-10-19). */
export const HL_BOOK_LEVELS_CAP = 20;
/** Time-range info responses carry at most 500 elements (docs "Info endpoint" pagination note). */
const HL_INFO_PAGE = 500;
/** Largest `market funding --limit` (hourly rows ≈ 208 days) and the page guard of one read. */
export const HL_FUNDING_HISTORY_MAX_LIMIT = 5000;
const HL_FUNDING_HISTORY_MAX_PAGES = 20;

/** A required field of an HL info row as a string; missing / empty → EXCHANGE_ERROR. */
function hlField(row: Record<string, unknown>, key: string, endpoint: string): string {
  const v = row[key];
  if ((typeof v === "string" && v !== "") || (typeof v === "number" && Number.isFinite(v))) return String(v);
  throw new PerpError("EXCHANGE_ERROR", `Hyperliquid ${endpoint} row without a readable ${key}: ${JSON.stringify(row).slice(0, 160)}`, { exchange: "hyperliquid" });
}

/** historicalOrders status precedence on equal statusTimestamp: open < triggered < any terminal status. */
function hlStatusRank(status: string): number {
  return status === "open" ? 0 : status === "triggered" ? 1 : 2;
}

/** HL side "B" (bid) → buy, "A" (ask) → sell; anything else → EXCHANGE_ERROR. */
function hlSide(v: unknown, endpoint: string): "buy" | "sell" {
  if (v === "B") return "buy";
  if (v === "A") return "sell";
  throw new PerpError("EXCHANGE_ERROR", `Hyperliquid ${endpoint} row with unknown side ${JSON.stringify(v)}`, { exchange: "hyperliquid" });
}

/**
 * Open positions of one clearinghouseState (info `clearinghouseState` {user[, dex]}): rows with
 * szi 0 dropped. The ONE mapper of the keyed `getPositions` and the public-address read
 * (`account positions --address`); `symbolOf` names the row (keyed: the adapter's display name,
 * public: the plain coin — "BTC", HIP-3 "xyz:GOLD").
 */
export function hlPositionRows(state: Record<string, unknown>, symbolOf: (coin: string) => string): ExchangePosition[] {
  const positions = ((state as Record<string, unknown>)?.assetPositions ?? []) as Record<string, unknown>[];
  return positions
    .filter((p: Record<string, unknown>) => {
      const pos = (p.position ?? p) as Record<string, unknown>;
      return parseFiniteVenueNumber(pos.szi, "position.szi", "hyperliquid") !== 0;
    })
    .map((p: Record<string, unknown>) => {
      const pos = (p.position ?? p) as Record<string, unknown>;
      const szi = parseFiniteVenueNumber(pos.szi, "position.szi", "hyperliquid");
      const positionValue = pos.positionValue !== undefined && pos.positionValue !== null
        ? parseFiniteVenueNumber(pos.positionValue, "position.positionValue", "hyperliquid")
        : 0;
      return {
        symbol: symbolOf(String(pos.coin ?? "")),
        side: szi > 0 ? ("long" as const) : ("short" as const),
        size: String(Math.abs(szi)),
        entryPrice: String(pos.entryPx ?? "0"),
        // clearinghouseState has no per-position mark: positionValue / |szi| is computed, so it is
        // formatted (no "2727.2000000000003").
        markPrice: szi !== 0 && positionValue !== 0
          ? formatComputedPrice(positionValue / Math.abs(szi))
          : String(pos.markPx ?? "0"),
        liquidationPrice: pos.liquidationPx != null ? String(pos.liquidationPx) : null,
        unrealizedPnl: String(pos.unrealizedPnl ?? "0"),
        leverage: parseFiniteVenueNumber(
          (pos.leverage as { value?: number })?.value,
          "position.leverage.value",
          "hyperliquid",
          { defaultValue: 1 },
        ),
      };
    });
}

export class HyperliquidAdapter implements ExchangeAdapter {
  readonly name = "hyperliquid";
  readonly chain = "evm";
  readonly aliases = ["hl"] as const;
  /**
   * Reflects whether perp + spot share the same collateral pool (true for unified /
   * portfolio mode — a per-user setting, HIP-3 dexes included) or are separately
   * margined (false for standard / unset "default"). Populated during init() from _getAbstractionMode()
   * (disk-cached for HL_ABSTRACTION_TTL_MS, so init reads the venue at most once per window);
   * defaults to false until init resolves so callers never assume unified
   * semantics for accounts that have never opted in. Codex v0.12.12 final QA #1.
   */
  isUnifiedAccount = false;
  private _address: string;
  private _privateKey: string;
  private _testnet: boolean;
  private _evmSigner?: EvmSigner;          // Tier 2: OWS master
  private _agentSigner?: EvmSigner;         // Tier 1: agent OWS wallet
  private _agentMeta?: AgentMeta;           // Tier 1 metadata
  private _useNoAgent: boolean = false;     // --no-agent bypass flag
  private _assetMap: Map<string, number> = new Map();
  private _assetMapReverse: Map<number, string> = new Map();
  private _szDecimalsMap: Map<string, number> = new Map(); // symbol → szDecimals
  /** symbol → venue marginMode restriction (meta universe `marginMode` / `onlyIsolated`); absent = none. */
  private _marginModeMap: Map<string, "strictIsolated" | "noCross"> = new Map();
  /** HIP-3 deployed perp dex name. Empty string = native (validator) perps. */
  private _dex: string = "";
  /** Why the last asset-map load refused to map the dex (unknown dex / asset id below the HIP-3 range). */
  private _assetMapError: PerpError | null = null;
  private static _lastNonce = 0;
  private _marketsCache: ExchangeMarketInfo[] | null = null;
  private _marketsCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;
  /**
   * Builder-fee gate (settings builder.hyperliquid + confirmed master approval); null = not
   * configured. Set by createHyperliquid — the adapter never reads settings.
   */
  builderFee: BuilderFeeGate | null = null;
  /** recentTrades' fixed tape size (no paging): `market trades` defaults to min(20, this). */
  readonly recentTradesCap = HL_RECENT_TRADES_CAP;

  constructor(privateKey?: string, testnet = false) {
    // No SDK: /info reads go through _infoPost, /exchange actions are signed here (hl-signing.ts).
    this._address = "";
    this._privateKey = privateKey ?? "";
    this._testnet = testnet;
  }

  /** Set the HIP-3 deployed perp dex to query/trade on. */
  setDex(dex: string): void {
    this._dex = dex;
    // Fresh market state for the new dex — NEW objects, never .clear(): a map shared with another
    // adapter (prototype copy) must not be emptied under it. Rebuilt lazily (_loadAssetMap).
    this._assetMap = new Map();
    this._assetMapReverse = new Map();
    this._szDecimalsMap = new Map();
    this._marginModeMap = new Map();
    this._assetMapError = null;
    this._marketsCache = null;
    this._marketsCacheTime = 0;
    this._delisted = new Set();
    this._delistedAssets = new Set();
    this._chsInFlight = null;
    this._collateralTokenIdx = null;
  }

  /**
   * An independent adapter for HIP-3 dex `dex` ("" = native perps) with this adapter's account
   * configuration (key / signers / address / network / builder gate) and its OWN market state
   * (asset maps, markets cache, delisted sets, in-flight reads). Fan-outs over dexes use this:
   * Object.create(adapter) + setDex() shared the prototype's maps, so setDex cleared the native
   * adapter's asset map and the dex copies served the native markets cache.
   */
  forDex(dex: string): HyperliquidAdapter {
    const a = new HyperliquidAdapter(this._privateKey || undefined, this._testnet);
    a._address = this._address;
    a._evmSigner = this._evmSigner;
    a._agentSigner = this._agentSigner;
    a._agentMeta = this._agentMeta;
    a._useNoAgent = this._useNoAgent;
    a.isUnifiedAccount = this.isUnifiedAccount;
    a.builderFee = this.builderFee;
    a.setDex(dex);
    return a;
  }

  get dex(): string {
    return this._dex;
  }

  get address(): string {
    return this._address;
  }

  /**
   * Builder decision for an order on `assetIndex` (null = adapter-level, e.g. dry-run).
   * HIP-3 (this adapter's dex, or a builder-deployed asset id ≥ 100000) never carries it.
   */
  async builderDecision(assetIndex: number | null): Promise<BuilderDecision> {
    const gate = builderGateOf(this);
    if (gate === null) return NO_BUILDER;
    const hip3 = this._dex !== "" || (assetIndex !== null && assetIndex >= 100_000);
    return gate.decide({ hip3 });
  }

  /**
   * HL `order` action. `builder: { b, f }` (f = tenths of a bp, builder-codes docs) is appended
   * only when the gate approves it — key order type, orders, grouping, builder (msgpack hash).
   */
  private async _orderAction(orders: Record<string, unknown>[], grouping: string, assetIndex: number): Promise<Record<string, unknown>> {
    const action: Record<string, unknown> = { type: "order", orders, grouping };
    const d = await this.builderDecision(assetIndex);
    if (d.applied !== null) action.builder = { b: d.applied.identity.toLowerCase(), f: hlFeeTenthsBps(requireFeeBps(d.applied)) };
    return action;
  }

  /**
   * Master approval for `target` (info maxBuilderFee: the approved ceiling in tenths of a bp,
   * 0 = none). Read for this adapter's account address (the master — agents cannot approve).
   */
  async builderApprovalOf(target: BuilderTarget): Promise<BuilderApproval> {
    if (!this._address) return { status: "unknown", reason: "no account address loaded" };
    const max = await this._infoPost({ type: "maxBuilderFee", user: this._address, builder: target.identity });
    if (typeof max !== "number" || !Number.isFinite(max) || max < 0) {
      return { status: "unknown", reason: `unexpected maxBuilderFee response ${JSON.stringify(max).slice(0, 120)}` };
    }
    return approvalFromMax(max === 0 ? null : max / 10, requireFeeBps(target));
  }

  get isTestnet(): boolean {
    return this._testnet;
  }

  /** Inject an external EVM signer. Call before init() to skip LocalEvmSigner creation. */
  setSigner(signer: EvmSigner): void {
    this._evmSigner = signer;
    this._address = signer.getAddress();
  }

  /**
   * Set the user EVM address without attaching a signer. Used by read-only
   * paths (e.g. `wallet manage account-mode` show branch) that need to query
   * `/info` endpoints scoped to a master wallet but never sign.
   */
  setAddress(address: string): void {
    this._address = address;
  }

  /** Tier 1: inject agent OWS wallet signer. */
  setAgentSigner(meta: AgentMeta, signer: EvmSigner): void {
    this._agentMeta = meta;
    this._agentSigner = signer;
  }

  /** Bypass Tier 1 (agent) — use for --no-agent flag. */
  setNoAgent(noAgent: boolean): void {
    this._useNoAgent = noAgent;
  }

  /** True only when ALL THREE tiers are unconfigured. */
  get isReadOnly(): boolean {
    return !this._agentSigner && !this._evmSigner && !this._privateKey;
  }

  /** Which signer tier is currently active (for debug/diagnostics). */
  get activeSignerTier(): "agent" | "master" | "pk" | null {
    try {
      return this._resolveSigner().tier;
    } catch {
      return null;
    }
  }

  /** Resolve the active signer across three tiers. */
  private _resolveSigner(): { tier: "agent" | "master" | "pk"; signer: EvmSigner } {
    // Tier 1: agent (when registered, --no-agent NOT set). An expired agent record is an
    // explicit error — never a silent switch to the master signer; --no-agent is the opt-in.
    if (!this._useNoAgent && this._agentSigner && this._agentMeta) {
      const expiresAt = new Date(this._agentMeta.expiresAt).getTime();
      if (expiresAt < Date.now()) {
        throw new PerpError("AGENT_EXPIRED", `Hyperliquid agent wallet ${this._agentMeta.agentEvmAddress} expired at ${this._agentMeta.expiresAt}`, {
          exchange: "hyperliquid",
          remediation: "Re-approve the agent: perp wallet agent approve hyperliquid — or sign with the master wallet for this command: --no-agent",
        });
      }
      return { tier: "agent", signer: this._agentSigner };
    }

    // Tier 2: OWS master (_evmSigner set via setSigner)
    if (this._evmSigner) {
      return { tier: "master", signer: this._evmSigner };
    }

    // Tier 3: PK direct (_privateKey → _evmSigner created in init())
    // After init(), PK is reflected in _evmSigner. But if init() hasn't run
    // yet, _privateKey is non-empty. Either way this path is reachable only
    // if _evmSigner is set, so Tier 2 catches it. This guard is for the edge
    // case where init() failed but _privateKey is set — throw a clear error.
    if (this._privateKey) {
      throw new PerpError(
        "NO_SIGNER_AVAILABLE",
        "Hyperliquid adapter has a private key but init() has not been called",
        { remediation: "Call adapter.init() before using mutating methods" },
      );
    }

    // No signer at any tier
    throw new PerpError(
      "NO_SIGNER_AVAILABLE",
      "No signing path configured for Hyperliquid",
      {
        remediation: "Run one of: (a) perp wallet agent approve hyperliquid --master <wallet>; (b) perp wallet generate && perp -e hyperliquid --ows <wallet>; (c) export PRIVATE_KEY=0x...",
      },
    );
  }

  async init(): Promise<void> {
    // Initialize EVM signer if not externally injected (skip if no key — read-only mode)
    if (!this._evmSigner && this._privateKey) {
      this._evmSigner = await LocalEvmSigner.create(this._privateKey);
      this._address = this._evmSigner.getAddress();
    } else if (this._evmSigner && !this._address) {
      this._address = this._evmSigner.getAddress();
    }

    // Build asset index map
    await this._loadAssetMap();

    // Resolve abstraction mode → isUnifiedAccount flag for callers
    // (portfolio accounting + spot-perp arb sizing). The mode is per user;
    // standard / "default" accounts are NOT unified.
    // Read-only paths (no address yet) can't query userAbstraction; leave the
    // default false until a downstream caller invokes setAddress + the cache
    // populates during getBalance(). Codex v0.12.12 final QA #1.
    // A failed userAbstraction read propagates: a silently-kept `false` would mis-size
    // every caller that branches on the account mode.
    if (this._address) {
      const mode = await this._getAbstractionMode();
      // dexAbstraction is not unified (USDC stays in the perp balance).
      this.isUnifiedAccount = mode === "unified" || mode === "portfolio";
    }
  }

  /**
   * info `meta` of this adapter's perp dex (universe: names, szDecimals, margin restrictions;
   * collateralToken) — public static metadata, shared on disk by every CLI process for
   * HL_MARKET_META_TTL_MS. Docs ("Rate limits and user limits"): "REST requests share an
   * aggregated weight limit of 1200 per minute" and `meta` is one of "All other documented `info`
   * requests [that] have weight 20" — re-reading it on every invocation (twice on a balance read)
   * was most of a command's weight. Account state is never cached here.
   */
  private _metaCached(): Promise<{ universe?: HlUniverseAsset[]; collateralToken?: unknown } | null> {
    return withCache(`mkt:hl:${this._network}:meta:${this._dex}`, HL_MARKET_META_TTL_MS, () =>
      this._infoPost(this._dex ? { type: "meta", dex: this._dex } : { type: "meta" }) as Promise<{ universe?: HlUniverseAsset[]; collateralToken?: unknown } | null>);
  }

  /** Load asset index map — supports native and HIP-3 dex. */
  private async _loadAssetMap(): Promise<void> {
    this._assetMapError = null;
    this._delistedAssets = new Set();
    try {
      if (this._dex) {
        // HIP-3 deployed dex: asset indices use global offset scheme
        // offset = 110000 + dexListIndex * 10000 (per Python SDK convention)
        const [meta, dexList] = await Promise.all([
          this._metaCached(),
          // The dex list (weight 20) is public static metadata too; cached like `meta`.
          withCache(`mkt:hl:${this._network}:perpDexs`, HL_MARKET_META_TTL_MS, () =>
            this._infoPost({ type: "perpDexs" }) as Promise<({ name: string } | null)[]>),
        ]);

        // Find this dex's position in the list (index 0 is native/null)
        let dexOffset = 0;
        for (let i = 1; i < dexList.length; i++) {
          if (dexList[i]?.name === this._dex) {
            dexOffset = 110000 + (i - 1) * 10000;
            break;
          }
        }
        if (dexOffset === 0) {
          // Fail closed: offset 0 would map every HIP-3 coin onto a NATIVE asset id.
          throw new PerpError("SYMBOL_NOT_FOUND", `Hyperliquid perp dex "${this._dex}" is not in the venue's perpDexs list; no asset ids loaded`, {
            exchange: "hyperliquid", remediation: "Check the dex name: perp -e hyperliquid market dexes",
          });
        }

        if (meta?.universe) {
          meta.universe.forEach((asset, idx) => {
            const globalIdx = dexOffset + idx;
            if (!(globalIdx >= HIP3_MIN_ASSET_ID)) {
              throw new PerpError("SYMBOL_NOT_FOUND", `Hyperliquid dex "${this._dex}" asset ${asset.name} resolved to asset id ${globalIdx} (< ${HIP3_MIN_ASSET_ID}); refusing to load`, { exchange: "hyperliquid" });
            }
            // Store both with and without dex prefix for flexible lookup
            // API returns "km:GOOGL" but callers may use "GOOGL" or "KM:GOOGL"
            const fullName = asset.name; // e.g., "km:GOOGL"
            const baseName = fullName.includes(":") ? fullName.split(":").pop()! : fullName;
            this._assetMap.set(fullName, globalIdx);
            this._assetMap.set(baseName, globalIdx);
            this._assetMapReverse.set(globalIdx, fullName);
            if (asset.isDelisted === true) { this._delistedAssets.add(fullName); this._delistedAssets.add(baseName); }
            // Cache szDecimals for dex assets (critical for order sizing)
            if (asset.szDecimals !== undefined) {
              this._szDecimalsMap.set(fullName, asset.szDecimals);
              this._szDecimalsMap.set(baseName, asset.szDecimals);
            }
            const mm = hlMarginModeOf(asset);
            if (mm !== null) {
              this._marginModeMap.set(fullName, mm);
              this._marginModeMap.set(baseName, mm);
            }
          });
        }
      } else {
        // Native perps keep the "<COIN>-PERP" display names the former SDK symbol
        // conversion produced (market list, positions, orders); _venueCoin() maps back.
        const meta = await this._metaCached();
        if (meta && meta.universe) {
          meta.universe.forEach((asset, idx) => {
            const sym = `${asset.name}-PERP`;
            this._assetMap.set(sym, idx);
            this._assetMapReverse.set(idx, sym);
            if (asset.isDelisted === true) this._delistedAssets.add(sym);
            if (asset.szDecimals !== undefined) {
              this._szDecimalsMap.set(sym, asset.szDecimals);
            }
            const mm = hlMarginModeOf(asset);
            if (mm !== null) this._marginModeMap.set(sym, mm);
          });
        }
      }
    } catch (e) {
      // A HIP-3 map that cannot be proven correct is never left half-loaded.
      if (this._dex) { this._assetMap.clear(); this._assetMapReverse.clear(); }
      // Kept and re-thrown at the point of use (getAssetIndex, getSzDecimals): a failed metadata
      // read (429, transport) must surface as itself, never as "Unknown asset" / "not loaded" for
      // every symbol. Commands that need no market metadata are not failed by it and print nothing.
      this._assetMapError = e instanceof PerpError ? e
        : new PerpError("EXCHANGE_ERROR", `Hyperliquid market metadata could not be loaded: ${e instanceof Error ? e.message : String(e)}`, { exchange: "hyperliquid" });
    }
  }

  /**
   * Resolve a symbol to the canonical name in the asset map.
   * Handles: "ICP" → "ICP-PERP", "BTC-PERP" → "BTC-PERP", "km:GOOGL" → "km:GOOGL"
   */
  resolveSymbol(symbol: string): string {
    const sym = symbol.toUpperCase();
    if (sym.includes(":")) {
      // A dex-prefixed symbol must name THIS adapter's dex — never rewritten onto another dex.
      const [prefix, base] = sym.split(":");
      if (prefix.toLowerCase() !== this._dex.toLowerCase()) {
        throw new PerpError("SYMBOL_NOT_FOUND", `Hyperliquid symbol ${prefix.toLowerCase()}:${base} is on dex "${prefix.toLowerCase()}", not ${this._dex ? `this adapter's dex "${this._dex}"` : "the native perp dex"}`, {
          exchange: "hyperliquid", remediation: `Select the dex: perp -e hyperliquid --dex ${prefix.toLowerCase()} ...`,
        });
      }
      const lower = `${prefix.toLowerCase()}:${base}`;
      if (this._assetMap.has(lower)) return lower;
      if (this._assetMap.has(base)) return base;
      return this._caseInsensitive(sym) ?? sym;
    }
    if (this._assetMap.has(sym)) return sym;
    if (this._assetMap.has(`${sym}-PERP`)) return `${sym}-PERP`;
    if (sym.endsWith("-PERP") && this._assetMap.has(sym.replace(/-PERP$/, ""))) return sym.replace(/-PERP$/, "");
    // Coins whose venue name is not upper-case (kPEPE, kSHIB, …): match the map case-insensitively.
    return this._caseInsensitive(sym) ?? this._caseInsensitive(`${sym}-PERP`) ?? this._caseInsensitive(sym.replace(/-PERP$/, "")) ?? sym; // unknown → as-is, downstream SYMBOL_NOT_FOUND
  }

  /** The asset-map key equal to `upper` ignoring case, when exactly one exists (kPEPE-PERP for KPEPE-PERP). */
  private _caseInsensitive(upper: string): string | null {
    let hit: string | null = null;
    for (const k of this._assetMap.keys()) {
      if (k.toUpperCase() !== upper) continue;
      if (hit !== null && hit !== k) return null;
      hit = k;
    }
    return hit;
  }

  /**
   * szDecimals for a symbol (cached from init/getMeta). Rule #2: never assumed —
   * meta not loaded → PRICE_STALE (retryable); loaded but no entry → SYMBOL_NOT_FOUND.
   */
  getSzDecimals(symbol: string): number {
    const resolved = this.resolveSymbol(symbol.toUpperCase());
    const dec = this._szDecimalsMap.get(resolved);
    if (dec !== undefined) return dec;
    if (this._assetMapError) throw this._assetMapError;
    if (this._szDecimalsMap.size === 0) {
      throw new PerpError("PRICE_STALE", `Hyperliquid market metadata (szDecimals) not loaded for ${symbol.toUpperCase()}`, {
        exchange: "hyperliquid",
        remediation: "Retry shortly — the meta request may have failed",
      });
    }
    throw new PerpError("SYMBOL_NOT_FOUND", `Hyperliquid ${symbol.toUpperCase()}: no szDecimals in market metadata`, {
      exchange: "hyperliquid",
      remediation: "Check the symbol: perp market list -e hyperliquid",
    });
  }

  /** Lot step of a market from the loaded `meta` szDecimals (precision.lotStepOf) — no metaAndAssetCtxs / allMids read per order. */
  lotStepOf(symbol: string): string {
    return hlSizeStep(this.getSzDecimals(symbol));
  }

  async getAssetIndex(symbol: string): Promise<number> {
    // Retry once if asset map is empty (e.g. init failed silently)
    if (this._assetMap.size === 0) {
      await this._loadAssetMap();
    }
    if (this._assetMapError) throw this._assetMapError;
    const resolved = this.resolveSymbol(symbol);
    const idx = this._assetMap.get(resolved);
    if (idx !== undefined) {
      if (this._dex && !(idx >= HIP3_MIN_ASSET_ID)) {
        throw new PerpError("SYMBOL_NOT_FOUND", `Hyperliquid dex "${this._dex}" asset ${symbol} has asset id ${idx} (< ${HIP3_MIN_ASSET_ID}); refusing to trade a native asset id`, { exchange: "hyperliquid" });
      }
      return idx;
    }
    throw this._unknownSymbol(symbol, `Unknown asset: ${symbol}`);
  }

  /** SYMBOL_NOT_FOUND for a coin the venue does not list (on this adapter's dex), with the listing command. */
  private _unknownSymbol(symbol: string, message?: string): PerpError {
    return new PerpError("SYMBOL_NOT_FOUND", message ?? `Hyperliquid has no market ${symbol.toUpperCase()}${this._dex ? ` on dex "${this._dex}"` : ""}`, {
      exchange: "hyperliquid",
      remediation: `List markets: perp -e hyperliquid${this._dex ? ` --dex ${this._dex}` : ""} market list`,
    });
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    if (this._marketsCache && Date.now() - this._marketsCacheTime < HyperliquidAdapter.CACHE_TTL) return this._marketsCache;
    let universe: Record<string, unknown>[];
    let marginTables: unknown;
    let ctxs: Record<string, unknown>[];
    let mids: Record<string, string> = {};

    if (this._dex) {
      // HIP-3: use raw info POST with dex param
      const meta = await this._infoPost({ type: "metaAndAssetCtxs", dex: this._dex }) as [{ universe: Record<string, unknown>[]; marginTables?: unknown }, Record<string, unknown>[]];
      universe = meta[0]?.universe ?? [];
      ctxs = meta[1] ?? [];
      marginTables = meta[0]?.marginTables;
    } else {
      const [meta, allMids] = await Promise.all([
        this._infoPost({ type: "metaAndAssetCtxs" }) as Promise<[{ universe: Record<string, unknown>[]; marginTables?: unknown }, Record<string, unknown>[]]>,
        this._infoPost({ type: "allMids" }) as Promise<Record<string, string>>,
      ]);
      // Native perps: "<COIN>-PERP" display names (see _loadAssetMap); allMids is keyed by the raw coin.
      universe = (meta[0]?.universe ?? []).map(a => ({ ...a, name: `${String(a.name)}-PERP` }));
      ctxs = meta[1] ?? [];
      marginTables = meta[0]?.marginTables;
      for (const [coin, px] of Object.entries(allMids ?? {})) mids[`${coin}-PERP`] = px;
    }

    // `marginTables` rides along in the SAME metaAndAssetCtxs response we
    // already fetch — zero extra network calls. Shape: [[tableId, {description,
    // marginTiers: [{lowerBound, maxLeverage}]}], ...]. `universe[i].maxLeverage`
    // is only the TOP tier: 36 of 233 symbols step down above a notional
    // threshold (BTC 40x, then 20x above $150M), so a pre-trade check that reads
    // the flat value alone waves through orders the venue rejects.
    const tierMap = new Map<number, Array<{ lowerBound: number; maxLeverage: number }>>();
    if (Array.isArray(marginTables)) {
      for (const entry of marginTables as unknown[]) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const id = Number(entry[0]);
        const tiers = (entry[1] as { marginTiers?: Array<Record<string, unknown>> })?.marginTiers;
        if (!Number.isFinite(id) || !Array.isArray(tiers)) continue;
        const parsed = tiers
          .map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: Number(t.maxLeverage) }))
          .filter((t) => Number.isFinite(t.lowerBound) && Number.isFinite(t.maxLeverage) && t.maxLeverage > 0)
          .sort((a, b) => a.lowerBound - b.lowerBound);
        if (parsed.length > 0) tierMap.set(id, parsed);
      }
    }

    // Rebuild asset map if empty (fallback — normally populated by init/_loadAssetMap)
    if (this._assetMap.size === 0 && !this._dex) {
      universe.forEach((asset, i) => {
        const sym = String(asset.name);
        this._assetMap.set(sym, i);
        this._assetMapReverse.set(i, sym);
      });
    }

    // Delisted assets (meta `isDelisted: true`; live 2026-10-14: 56 of 234 native perps, all with
    // funding / dayNtlVlm / openInterest "0.0") are not markets: excluded from the listing and
    // everything built on it. They stay in the asset map (_loadAssetMap), so an explicit symbol
    // still resolves for orders / position reads.
    const delisted = new Set<string>();
    const result = universe.flatMap((asset: Record<string, unknown>, i: number) => {
      if (asset.isDelisted === true) { delisted.add(String(asset.name)); return []; }
      const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
      const sym = String(asset.name);
      const szDec = this._szDecimalsMap.get(sym) ?? (asset.szDecimals !== undefined ? Number(asset.szDecimals) : null);
      return [{
        // One symbol shape on every venue: the plain asset ("BTC"; HIP-3 "km:US500"), the
        // venue's wire coin in venueSymbol. The internal "<COIN>-PERP" key is not shown.
        symbol: sym.replace(/-PERP$/, ""),
        // The coin exactly as the venue names it on the wire (native "kPEPE", HIP-3 "xyz:TSLA" —
        // lower-case dex prefix); _venueCoin upper-cases its input, so it is not used here.
        venueSymbol: sym.replace(/-PERP$/, ""),
        markPrice: String(ctx.markPx ?? mids[sym] ?? "0"),
        indexPrice: ctx.oraclePx != null ? String(ctx.oraclePx) : null,
        fundingRate: ctx.funding != null ? String(ctx.funding) : null,
        // metaAndAssetCtxs `funding` = the running hour's rate (WS allDexsAssetCtxs: accruing).
        fundingRateKind: ctx.funding != null ? "accruing" as const : null,
        volume24h: ctx.dayNtlVlm != null ? String(ctx.dayNtlVlm) : null,
        openInterest: ctx.openInterest != null ? String(ctx.openInterest) : null,
        maxLeverage: Number(asset.maxLeverage ?? 50),
        sizeDecimals: szDec,
        // HL has no separate lot-size field; the step is implied by szDecimals (10^-szDecimals,
        // the same value the keyless MCP get_markets path states).
        stepSize: szDec !== null && Number.isInteger(szDec) && szDec >= 0 ? (szDec === 0 ? "1" : `0.${"0".repeat(szDec - 1)}1`) : null,
        // HL funding is uniform: a fraction per 1 h (venue fundingRateBasis), core and HIP-3.
        fundingHours: 1,
        marginTiers: hlMarginTiersOf(asset.marginTableId, tierMap),
      }];
    });
    this._delisted = delisted;
    this._marketsCache = result; this._marketsCacheTime = Date.now(); return result;
  }

  /** Display names of the delisted assets seen by the last getMarkets() (meta isDelisted). */
  private _delisted = new Set<string>();
  /** Asset-map keys of the delisted assets in `meta` (_loadAssetMap): "MATIC-PERP"; HIP-3 "km:US500" and "US500". */
  private _delistedAssets = new Set<string>();

  /**
   * Why `symbol` is not in getMarkets(): it is delisted (message), or null when it is not a
   * delisted asset. Read after getMarkets() (or once the asset map is loaded). `market info` uses
   * it to say "delisted" rather than "not found" — the asset map still resolves it for orders /
   * positions / history. A HIP-3 bare name ("US500" on --dex km) is matched by its venue coin.
   */
  delistedMessage(symbol: string): string | null {
    const resolved = this.resolveSymbol(symbol.toUpperCase());
    const coin = this._venueCoin(symbol).replace(/^([^:]+):/, (_m, dex: string) => `${dex.toLowerCase()}:`); // "KM:US500" → "km:US500"
    const isDelisted = this._delisted.has(resolved) || this._delisted.has(coin) || this._delistedAssets.has(resolved);
    if (!isDelisted) return null;
    return `${this._dex ? coin : resolved.replace(/-PERP$/, "")} is delisted on Hyperliquid (positions / history still readable)`;
  }

  /** SYMBOL_NOT_FOUND (details.reason "delisted") for a delisted `symbol`, with a dex-aware remediation; null when listed. */
  delistedError(symbol: string): PerpError | null {
    const msg = this.delistedMessage(symbol);
    if (msg === null) return null;
    return new PerpError("SYMBOL_NOT_FOUND", msg, {
      exchange: "hyperliquid",
      reason: "delisted",
      remediation: `List live markets: perp -e hyperliquid${this._dex ? ` --dex ${this._dex}` : ""} market list`,
    });
  }

  /**
   * Per-symbol MARKET-DATA reads (trades, funding, book, klines): the symbol must resolve
   * (SYMBOL_NOT_FOUND) and must not be delisted — HL keeps serving a delisted coin's last tape
   * (MATIC: trades from 2024-09-09) and zero-rate funding rows stamped every hour (live
   * 2026-10-19), which read as a live market. Orders / positions / history do not call this.
   */
  private async _listedMarket(symbol: string): Promise<void> {
    await this.getAssetIndex(symbol);
    const err = this.delistedError(symbol);
    if (err !== null) throw err;
  }

  /**
   * Public order-book read (`market book`, bots, MCP): l2Book serves at most HL_BOOK_LEVELS_CAP
   * (20) levels per side and cannot be paged, so a `depth` above it is INVALID_PARAMS naming the
   * cap. Refuses delisted markets (_listedMarket). Order paths use _l2Book (no delisted gate):
   * a reduce-only close of a delisted asset must still get its reference price.
   */
  async getOrderbook(symbol: string, depth?: number) {
    if (depth !== undefined && !(Number.isInteger(depth) && depth > 0 && depth <= HL_BOOK_LEVELS_CAP)) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid order book: depth must be an integer 1..${HL_BOOK_LEVELS_CAP} (got ${depth}) — l2Book serves at most ${HL_BOOK_LEVELS_CAP} levels per side`, {
        exchange: "hyperliquid", remediation: `Use -d ${HL_BOOK_LEVELS_CAP} or less`,
      });
    }
    await this._listedMarket(symbol);
    return this._l2Book(symbol);
  }

  /** l2Book of `symbol` (native or this adapter's dex), no listing gate. Unlisted coin → SYMBOL_NOT_FOUND. */
  private async _l2Book(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    let levels: Record<string, unknown>[][];

    // l2Book answers `null` for a coin the venue does not list (live 2026-10-14, coin "NOPE"):
    // SYMBOL_NOT_FOUND, never an empty book (which reads as "no liquidity").
    if (this._dex) {
      // HIP-3 dex: full dex-prefixed coin (e.g. "US500" → "km:US500") + dex param
      const book = await this._infoPost({
        type: "l2Book",
        coin: this._venueCoin(symbol),
        dex: this._dex,
      }) as { levels?: Record<string, unknown>[][] } | null;
      if (book === null) throw this._unknownSymbol(symbol);
      levels = book.levels ?? [[], []];
    } else {
      const book = await this._infoPost({ type: "l2Book", coin: this._venueCoin(symbol) }) as { levels?: Record<string, unknown>[][] } | null;
      if (book === null) throw this._unknownSymbol(symbol);
      levels = book.levels ?? [[], []];
    }

    return {
      bids: (levels[0] ?? []).map((l: Record<string, unknown>) => [
        String(l.px ?? "0"),
        String(l.sz ?? "0"),
      ] as [string, string]),
      asks: (levels[1] ?? []).map((l: Record<string, unknown>) => [
        String(l.px ?? "0"),
        String(l.sz ?? "0"),
      ] as [string, string]),
    };
  }

  /**
   * Venue coin for a symbol: native perps drop the "-PERP" display suffix ("BTC-PERP" →
   * "BTC"); HIP-3 coins carry the dex prefix ("US500" → "km:US500").
   */
  private _venueCoin(symbol: string): string {
    const resolved = this.resolveSymbol(symbol.toUpperCase());
    if (this._dex) return resolved.includes(":") ? resolved : `${this._dex}:${resolved}`;
    return resolved.replace(/-PERP$/, "");
  }

  /** Display symbol for a venue coin: a native perp coin "BTC" → "BTC-PERP"; anything else unchanged. */
  private _displaySymbol(coin: string): string {
    return !this._dex && this._assetMap.has(`${coin}-PERP`) ? `${coin}-PERP` : coin;
  }

  private ensureAddress(): void {
    if (!this._address) {
      throw noAccountKeyError(this.name);
    }
  }

  /** The in-flight clearinghouseState read: parallel callers (getBalance + getPositions) share one request. */
  private _chsInFlight: Promise<Record<string, unknown>> | null = null;

  /** Read-through cached clearinghouseState — returns cached data if fresh */
  private async _getClearinghouseState(): Promise<Record<string, unknown>> {
    this.ensureAddress();
    if (this._chsInFlight !== null) return this._chsInFlight;
    const key = this._dex ? `acct:hl:${this._network}:chs:${this._address}:${this._dex}` : `acct:hl:${this._network}:chs:${this._address}`;
    const p = withCache(key, TTL_ACCOUNT, async () => {
      const state = this._dex
        ? await this._infoPost({ type: "clearinghouseState", user: this._address, dex: this._dex }) as Record<string, unknown>
        : await this._infoPost({ type: "clearinghouseState", user: this._address }) as Record<string, unknown>;
      return state as Record<string, unknown>;
    });
    this._chsInFlight = p;
    const clear = () => { if (this._chsInFlight === p) this._chsInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  /**
   * Read the user's account abstraction mode from HL.
   *
   * Abstraction is a property of the USER (not of a dex): it is always queried,
   * HIP-3 dex adapters included.
   *   - "unified"   → spot clearinghouseState is the truth source (one balance per
   *                   collateral token, shared by spot and every perp dex).
   *   - "portfolio" → multi-asset cross-collateral; balances also live in spot state.
   *   - "standard"  → perp clearinghouseState is the truth source (venue "disabled").
   *   - "default"   → the user never set a mode. Not assumed to be either: balances
   *                   are read from the perp state and getBalance() warns when that
   *                   reads 0 while spot holds the collateral token.
   *
   * Per SSOT Rule #2: an unrecognized venue response throws — no silent default.
   *
   * Endpoint: `POST /info {"type":"userAbstraction","user":"0x..."}`.
   */
  async _getAbstractionMode(opts: { fresh?: boolean } = {}): Promise<"unified" | "standard" | "portfolio" | "default" | "dexAbstraction"> {
    this.ensureAddress();
    const key = `${hlAbstractionCachePrefix(this._network)}${this._address.toLowerCase()}`;
    return (opts.fresh === true ? fetchAndCache : withCache)(key, HL_ABSTRACTION_TTL_MS, async () => {
      const raw = (await this._infoPost({ type: "userAbstraction", user: this._address })) as unknown;
      if (raw === "unifiedAccount") return "unified";
      if (raw === "portfolioMargin") return "portfolio";
      if (raw === "disabled") return "standard";
      if (raw === "default") return "default";
      // "dexAbstraction" is HL's discontinued fourth mode, still returned for some users. It is
      // NOT unified: "USDC balances default to perps balance, all other collateral defaults to
      // spot balance" (docs trading/account-abstraction-modes). Handled explicitly in getBalance().
      if (raw === "dexAbstraction") return "dexAbstraction";
      throw new PerpError(
        "INVALID_PARAMS",
        `UNKNOWN_ACCOUNT_MODE: HL returned unrecognized userAbstraction mode: ${JSON.stringify(raw)}`,
        { remediation: "Check app.hyperliquid.xyz Settings → Account Mode" },
      );
    });
  }

  /** Collateral token index of this adapter's perp dex (info `meta{dex}.collateralToken`; 0 = USDC on native perps). */
  private _collateralTokenIdx: number | null = null;
  async _getCollateralToken(): Promise<number> {
    if (this._collateralTokenIdx !== null) return this._collateralTokenIdx;
    const meta = await this._metaCached();
    const idx = meta?.collateralToken;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid meta${this._dex ? `{dex:${this._dex}}` : ""} has no collateralToken (got ${JSON.stringify(idx)})`, {
        exchange: "hyperliquid",
      });
    }
    this._collateralTokenIdx = idx;
    return idx;
  }

  /** Cached spot clearinghouse state (raw venue shape) — shared between getBalance() and HyperliquidSpotAdapter */
  async _getSpotClearinghouseState(opts?: { fresh?: boolean }): Promise<Record<string, unknown>> {
    this.ensureAddress();
    const { withCache, fetchAndCache, TTL_ACCOUNT } = await import("../cache.js");
    const fetcher = async () => await this._infoPost({ type: "spotClearinghouseState", user: this._address }) as Record<string, unknown>;
    const key = `acct:hl:${this._network}:spot_chs:${this._address}`;
    // fresh: bypass the shared TTL cache (fill measurement / post-trade verification).
    return opts?.fresh === true ? fetchAndCache(key, TTL_ACCOUNT, fetcher) : withCache(key, TTL_ACCOUNT, fetcher);
  }

  /** Spot balance row of this dex's collateral token (matched by token index, not by coin name); null = none held. */
  private async _spotCollateralRow(): Promise<{ row: Record<string, unknown> | null; balances: Record<string, unknown>[]; token: number }> {
    const [spotState, token] = await Promise.all([this._getSpotClearinghouseState(), this._getCollateralToken()]);
    const balances = (spotState?.balances ?? []) as Record<string, unknown>[];
    const row = balances.find((b) => Number(b.token) === token) ?? null;
    return { row, balances, token };
  }

  async getBalance(): Promise<ExchangeBalance> {
    const state = await this._getClearinghouseState();
    const s = state as Record<string, unknown>;
    const margin = (s?.marginSummary ?? {}) as Record<string, unknown>;
    const cross = (s?.crossMarginSummary ?? {}) as Record<string, unknown>;

    const marginUsed = parseFiniteVenueNumber(
      margin.totalMarginUsed ?? cross.totalMarginUsed,
      "marginSummary.totalMarginUsed",
      "hyperliquid",
    );
    // Sum unrealized PnL directly from positions (reliable for both main + dex accounts)
    const positions = (s?.assetPositions ?? []) as Record<string, unknown>[];
    let unrealizedPnl = 0;
    for (const entry of positions) {
      const pos = (entry.position ?? entry) as Record<string, unknown>;
      unrealizedPnl += parseFiniteVenueNumber(pos.unrealizedPnl, "position.unrealizedPnl", "hyperliquid");
    }

    let equity: number;
    let available: number;

    // Branch by the user's account abstraction mode (Rule #2: no silent fallback).
    // - "unified" / "portfolio": per HL docs, API users see all balances and holds
    //   in the spot clearinghouse state; the dex's collateral token row (by token
    //   index from meta{dex}.collateralToken) is the equity. Adding perp margin
    //   would double-count.
    // - "standard" / "default": perp clearinghouse (per dex) is the collateral source.
    //
    // Portfolio-margin mode: eligible collateral includes HYPE, BTC, USDT besides
    // USDC. Only the collateral token is counted; a stderr note lists the rest.
    const mode = await this._getAbstractionMode();
    // dexAbstraction (discontinued): USDC (token 0) lives in the NATIVE perp balance, any other
    // collateral token in spot. Native perps → the perp state below. A HIP-3 dex with non-USDC
    // collateral → its spot row. A USDC-collateral HIP-3 dex is refused: its dex state is not the
    // balance ("Cross margin on HIP-3 DEXs does not behave intuitively for DEX abstraction users").
    let spotIsTruth = mode === "unified" || mode === "portfolio";
    if (mode === "dexAbstraction" && this._dex) {
      if (await this._getCollateralToken() === 0) {
        throw new PerpError("NOT_IMPLEMENTED", `Hyperliquid account mode "dexAbstraction" (discontinued by the venue): the USDC balance of HIP-3 dex "${this._dex}" cannot be read reliably`, {
          exchange: "hyperliquid",
          remediation: "Switch the account mode first: perp -e hyperliquid wallet manage account-mode unified (or standard)",
        });
      }
      spotIsTruth = true;
    }
    if (spotIsTruth) {
      const { row, balances, token } = await this._spotCollateralRow();
      const coin = row === null ? `token#${token}` : String(row.coin);
      const spotTotal = parseFiniteVenueNumber(row?.total, `spotBalance.${coin}.total`, "hyperliquid");
      const spotHold = parseFiniteVenueNumber(row?.hold, `spotBalance.${coin}.hold`, "hyperliquid");
      equity = spotTotal;
      available = spotTotal - spotHold;
      if (mode === "portfolio") {
        // Eligible collateral per trading/account-abstraction-modes.md ("eligible
        // assets, which are currently HYPE, BTC, USDC, USDT").
        const PORTFOLIO_COLLATERAL = ["HYPE", "BTC", "USDT"];
        const others = balances.filter((b) => {
          if (Number(b.token) === token) return false;
          const c = String(b.coin);
          // Reject NaN/empty here too — venue payload corruption shouldn't
          // silently filter a token in or out.
          const total = parseFiniteVenueNumber(b.total, `spotBalance.${c}.total`, "hyperliquid");
          if (total <= 0) return false;
          return PORTFOLIO_COLLATERAL.some((p) => c === p || c.startsWith(`${p}-`));
        });
        if (others.length > 0) {
          const summary = others.map((b) => `${b.coin}=${b.total}`).join(", ");
          process.stderr.write(
            `[hl] portfolio mode: non-${coin} collateral present but not counted in equity (${summary}). ` +
            `Equity reflects ${coin} only; full multi-asset accounting pending.\n`,
          );
        }
      }
    } else {
      equity = parseFiniteVenueNumber(
        margin.accountValue ?? cross.accountValue,
        "marginSummary.accountValue",
        "hyperliquid",
      );
      available = parseFiniteVenueNumber(s?.withdrawable, "withdrawable", "hyperliquid");
      if (mode === "default" && equity === 0) {
        // Unset mode: do not assume unified. If the perp side reads 0 while spot holds
        // the collateral token, say so instead of reporting an empty account silently.
        const { row, token } = await this._spotCollateralRow();
        const spotTotal = parseFiniteVenueNumber(row?.total, `spotBalance.token#${token}.total`, "hyperliquid");
        if (spotTotal > 0) {
          process.stderr.write(
            `[hl] account mode is unset ("default"): perp equity${this._dex ? ` on dex ${this._dex}` : ""} is 0 while spot holds ${spotTotal} ${String(row?.coin)}. ` +
            `That spot balance is not perp collateral here. Either switch the account to unified ` +
            `(perp wallet manage account-mode unified) or move it: perp -e hyperliquid trade spot-transfer to-perp <amount>\n`,
          );
        }
      }
    }

    return {
      equity: String(equity),
      available: String(available),
      marginUsed: String(marginUsed),
      unrealizedPnl: String(unrealizedPnl),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    return hlPositionRows(await this._getClearinghouseState(), (coin) => this._displaySymbol(coin));
  }

  /**
   * The leverage this account applies to `symbol`, position or not — info `activeAssetData`
   * {user, coin} → `"leverage": { "type": "cross", "value": 3 }` (docs info-endpoint/perpetuals).
   * Unreadable → EXCHANGE_ERROR.
   */
  async marketLeverage(symbol: string): Promise<number> {
    this.ensureAddress();
    const coin = this._venueCoin(symbol);
    const r = await this._infoPost({ type: "activeAssetData", user: this._address, coin }) as { leverage?: { value?: unknown } } | null;
    const v = r?.leverage?.value;
    if (typeof v !== "number" || !(v >= 1)) {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid activeAssetData ${coin}: unreadable leverage ${JSON.stringify(r?.leverage ?? null)}`, { exchange: "hyperliquid" });
    }
    return v;
  }

  /**
   * Per-market leverage / margin mode:
   *  - every market with a position: the `leverage` object of its `assetPositions` entry of info
   *    `clearinghouseState` (docs info-endpoint/perpetuals: `"leverage": { "rawUsd": "-95.059824",
   *    "type": "isolated", "value": 20 }`);
   *  - markets WITHOUT a position the account traded: the HL_SETTINGS_FILL_MARKETS most recently
   *    traded perp markets of this adapter's dex in info `userFills` ("at most 2000 most recent
   *    fills"; spot "@<i>" / "BASE/QUOTE", HIP-4 "#<enc>", other dexes and delisted coins are not
   *    markets of this adapter and are skipped), each read with info `activeAssetData` {user, coin}
   *    → `"leverage": { "type": "cross", "value": 3 }` (docs info-endpoint/perpetuals; live
   *    2026-10-13 `{"type":"cross","value":20}` for an account that never set ETH).
   * Weight (docs "Rate limits and user limits"): clearinghouseState 2 + userFills 20 (+1 per 20
   * fills) + activeAssetData 20 per market — bounded by HL_SETTINGS_FILL_MARKETS.
   * An unreadable leverage → EXCHANGE_ERROR.
   */
  async getMarketSettings(): Promise<Array<{ symbol: string; leverage: number; marginMode: "cross" | "isolated" }>> {
    const state = await this._getClearinghouseState();
    if (!Array.isArray(state.assetPositions)) {
      throw new PerpError("EXCHANGE_ERROR", "Hyperliquid clearinghouseState has no assetPositions list — per-market settings unknown", { exchange: "hyperliquid" });
    }
    const leverageOf = (lev: unknown, what: string): { leverage: number; marginMode: "cross" | "isolated" } => {
      const l = lev as { type?: unknown; value?: unknown } | null | undefined;
      if ((l?.type !== "cross" && l?.type !== "isolated") || typeof l.value !== "number" || !(l.value > 0)) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid ${what}: unreadable leverage ${JSON.stringify(lev ?? null)}`, { exchange: "hyperliquid" });
      }
      return { leverage: l.value, marginMode: l.type };
    };
    const rows = (state.assetPositions as Record<string, unknown>[]).map((p) => {
      const pos = (p.position ?? p) as Record<string, unknown>;
      return { coin: String(pos.coin), ...leverageOf(pos.leverage, `position ${String(pos.coin)}`) };
    });
    const held = new Set(rows.map(r => r.coin));
    const fills = await this._infoPost({ type: "userFills", user: this._address });
    if (!Array.isArray(fills)) {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid userFills returned no list (got ${JSON.stringify(fills).slice(0, 160)})`, { exchange: "hyperliquid" });
    }
    const listed = (coin: string) => this._dex ? coin.startsWith(`${this._dex}:`) && this._assetMap.has(coin) : this._assetMap.has(`${coin}-PERP`);
    const traded: string[] = [];
    for (const f of [...(fills as Record<string, unknown>[])].sort((a, b) => Number(b.time) - Number(a.time))) {
      const coin = String(f.coin);
      if (traded.length >= HL_SETTINGS_FILL_MARKETS) break;
      if (!held.has(coin) && !traded.includes(coin) && listed(coin)) traded.push(coin);
    }
    for (const coin of traded) {
      const r = await this._infoPost({ type: "activeAssetData", user: this._address, coin }) as { leverage?: unknown } | null;
      rows.push({ coin, ...leverageOf(r?.leverage, `activeAssetData ${coin}`) });
    }
    return rows.map(r => ({ symbol: this._displaySymbol(r.coin), leverage: r.leverage, marginMode: r.marginMode }));
  }

  /**
   * Open orders from info `frontendOpenOrders` (native perps, or the HIP-3 dex): unlike
   * `openOrders` it labels trigger orders (isTrigger, orderType "Stop Market" / "Take Profit
   * Limit" …, triggerPx), so stops / TP / SL are listed as such and cancel-all / flatten cancel
   * them. `type` = the venue orderType for a trigger order, else "limit".
   */
  async getOpenOrders(): Promise<ExchangeOrder[]> {
    this.ensureAddress();
    const req: Record<string, unknown> = { type: "frontendOpenOrders", user: this._address };
    if (this._dex) req.dex = this._dex;
    const orders = await this._infoPost(req) as Record<string, unknown>[];
    // Perp orders only. Without a dex, frontendOpenOrders also lists the account's SPOT orders
    // (coin "@<index>" or "<BASE>/<QUOTE>"): they belong to the spot commands — a perp
    // cancel-all / flatten must neither cancel nor be failed by a resting spot limit.
    if (!Array.isArray(orders)) {
      throw new PerpError("EXCHANGE_ERROR", "Hyperliquid frontendOpenOrders returned no array", { exchange: "hyperliquid", remediation: "Retry: perp -e hyperliquid account orders" });
    }
    // Rule #2: a row without its oid / limitPx / sz is unreadable — never listed as id "" or price/size "0".
    const field = (o: Record<string, unknown>, k: "oid" | "limitPx" | "sz"): string => {
      const v = o[k];
      if ((typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "")) return String(v);
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid frontendOpenOrders row without ${k}: ${JSON.stringify(o).slice(0, 200)}`, {
        exchange: "hyperliquid", remediation: "Retry: perp -e hyperliquid account orders",
      });
    };
    return orders.filter((o) => !hlIsSpotCoin(String(o.coin ?? ""))).map((o) => ({
      orderId: field(o, "oid"),
      symbol: this._dex ? String(o.coin ?? "") : this._displaySymbol(String(o.coin ?? "")),
      side: String(o.side) === "B" ? ("buy" as const) : String(o.side) === "A" ? ("sell" as const) : (String(o.side).toLowerCase() as "buy" | "sell"),
      price: field(o, "limitPx"),
      size: field(o, "sz"),
      filled: "0",
      status: "open",
      type: o.isTrigger === true && typeof o.orderType === "string" ? o.orderType : "limit",
      triggerPrice: o.isTrigger === true && Number(o.triggerPx) > 0 ? String(o.triggerPx) : null,
    }));
  }

  /** HL order id for a cancel: a decimal integer that is exactly representable (else INVALID_PARAMS, nothing sent). */
  /**
   * A Hyperliquid client order id (cloid) as sent / queried: "0x" + 32 lowercase hex chars
   * (exchange-endpoint docs: `c` "an optional 128 bit hex string, e.g.
   * 0x1234567890abcdef1234567890abcdef"). Anything else → INVALID_PARAMS, nothing sent.
   */
  static requireCloid(cloid: string): string {
    if (!HL_CLOID_RE.test(cloid)) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid client order id "${cloid}" must be a 128-bit hex cloid: 0x + 32 lowercase hex chars`, {
        exchange: "hyperliquid", remediation: "Pass e.g. --client-id 0x1234567890abcdef1234567890abcdef, or use --auto-id (a valid cloid is generated and reported)",
      });
    }
    return cloid;
  }

  private _oidOf(orderId: string): number {
    const n = Number(orderId);
    if (!/^\d+$/.test(orderId) || !Number.isSafeInteger(n)) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid order id must be a decimal integer (got "${orderId}"); nothing was cancelled`, {
        exchange: "hyperliquid", remediation: "Look up the order id: perp account orders -e hyperliquid",
      });
    }
    return n;
  }

  private async _invalidateAccountCache() {
    try { const { invalidateCache } = await import("../cache.js"); invalidateCache("acct"); } catch { /* ignore */ }
  }

  /**
   * Validate that an HL order actually filled.
   * HL API returns status "ok" even for 0-fill IoC orders.
   * Response shape: { status: "ok", response: { type: "order", data: { statuses: [...] } } }
   * Each status is one of: { filled: { totalSz, avgPx, oid } }, { resting: { oid } }, { error: "msg" }
   */
  private _validateOrderFill(result: unknown, symbol: string, side: string, requestedSize: string): void {
    const r = result as { status?: string; response?: { type?: string; data?: { statuses?: Array<Record<string, unknown>> } } };
    const statuses = r?.response?.data?.statuses;
    const what = `market ${side} ${requestedSize} ${symbol}`;
    if (!statuses || statuses.length === 0) {
      throw orderOutcomeUnknown("hyperliquid", what, new Error("no order status in response"));
    }
    const st = statuses[0];
    if (st.error) {
      // Explicit per-order venue rejection: definitely not placed.
      throw new PerpError("ORDER_REJECTED", `Market ${side} ${symbol}: ${st.error}`, { exchange: "hyperliquid" });
    }
    const filled = st.filled as { totalSz?: string; avgPx?: string } | undefined;
    if (!filled && st.resting !== undefined) {
      // An IOC reported resting is live on the book — outcome NOT definite.
      throw orderOutcomeUnknown("hyperliquid", what, new Error("the IOC was reported resting on the book"));
    }
    if (!filled) {
      // No filled / resting / error field: unexpected shape — outcome not definite.
      throw orderOutcomeUnknown("hyperliquid", what, new Error("unexpected order status shape (no filled/resting/error)"));
    }
    if (filled.totalSz === undefined || !Number.isFinite(Number(filled.totalSz))) {
      throw orderOutcomeUnknown("hyperliquid", what, new Error("filled status without a readable totalSz"));
    }
    if (Number(filled.totalSz) === 0) {
      // IOC zero-fill: the venue cancelled the remainder — nothing traded (definite).
      throw new PerpError("ORDER_REJECTED", `Market ${side} ${symbol}: order not filled (0 of ${requestedSize}). Check price/liquidity.`, { exchange: "hyperliquid" });
    }
  }

  /**
   * Market order = slippage-bounded IOC limit for
   * native perps and HIP-3 dexes alike. Replaces the SDK's marketOpen/marketClose
   * (hidden built-in slippage) and the former HIP-3 5% constant.
   *
   * Reference price (the single declared source): the l2Book mid
   * (best bid + best ask) / 2 of this coin — see referencePrice(). No runtime
   * substitute (mark, allMids, last trade): a missing side → PRICE_STALE before
   * anything is sent. Protection = reference ± opts.slippage.bps, aligned toward
   * crossing on HL's price grid (hlProtectionPrice, max 6 − szDecimals decimals).
   *
   * reduceOnly is sent as the order's `r` flag: the venue can only reduce the
   * position with it (never open/flip), so the caller's side is used as given.
   */
  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderId?: string }) {
    // Everything before the signed POST /exchange (signer, `meta` asset id, l2Book reference
    // price, builder approval read) is pre-send: a failed read there (429, transport) is a
    // definite "not sent" (orderNotSent), never a retryable error with an unknown write outcome.
    let action: Record<string, unknown>;
    let sentSize: string;
    let protection: Awaited<ReturnType<HyperliquidAdapter["computeProtectionPrice"]>>;
    const cloid = opts.clientOrderId === undefined ? null : HyperliquidAdapter.requireCloid(opts.clientOrderId);
    try {
      this.ensureSigner();
      const assetIndex = await this.getAssetIndex(symbol.toUpperCase());
      const szDec = this.getSzDecimals(symbol);
      // Floor to the szDecimals lot (never round up past the requested size); 0 → SIZE_TOO_SMALL.
      sentSize = floorSize(size, hlSizeStep(szDec));
      protection = await this.computeProtectionPrice(symbol, side, opts.slippage);
      action = await this._orderAction([this._orderWire({
        assetIndex,
        isBuy: side === "buy",
        price: protection.protectionPrice,
        size: sentSize,
        orderType: { limit: { tif: "Ioc" } },
        reduceOnly: opts.reduceOnly,
        cloid,
      })], "na", assetIndex);
    } catch (e) {
      throw orderNotSent("hyperliquid", `market ${side} ${size} ${symbol.toUpperCase()}`, e);
    }
    const result = await this._signAndSendAction(action);
    // Per-order verdict: error → ORDER_REJECTED, zero fill → ORDER_REJECTED, resting/unknown → throws.
    this._validateOrderFill(result, symbol, side, sentSize);
    await this._invalidateAccountCache();
    // The protection actually sent rides along with the raw response (like Lighter's
    // `protection`) so a TradingV2 wrapper records it in execution; `sentSize` is the
    // size actually sent (floored to szDecimals) that verification compares against.
    return { ...(result as Record<string, unknown>), protection, sentSize, ...(cloid !== null ? { clientOrderId: cloid } : {}) };
  }

  /**
   * The single declared reference price for market-type protection prices:
   * l2Book mid = (best bid + best ask) / 2. Works for native perps and HIP-3
   * (_l2Book passes the dex). Either side missing / non-positive → PRICE_STALE. Not gated on
   * delisting: a reduce-only market close of a delisted asset is sent (the venue decides).
   */
  async referencePrice(symbol: string): Promise<number> {
    const book = await this._l2Book(symbol);
    const bid = Number(book.bids[0]?.[0]);
    const ask = Number(book.asks[0]?.[0]);
    if (!(bid > 0) || !(ask > 0) || !Number.isFinite(bid) || !Number.isFinite(ask)) {
      throw new PerpError("PRICE_STALE", `Hyperliquid ${symbol.toUpperCase()}${this._dex ? ` (dex ${this._dex})` : ""}: no two-sided l2Book to derive the mid reference price`, {
        exchange: "hyperliquid",
        remediation: "Retry when the book has both bids and asks, or place a limit order",
      });
    }
    return (bid + ask) / 2;
  }

  /**
   * Venue mark price of `symbol` (info `metaAndAssetCtxs` → `markPx`; passes the dex for HIP-3).
   * Read fresh (never the markets cache, whose markPrice may be an allMids substitute).
   * Missing / non-positive → PRICE_STALE.
   */
  async markPrice(symbol: string): Promise<number> {
    const coin = this._venueCoin(symbol);
    const meta = await this._infoPost(this._dex ? { type: "metaAndAssetCtxs", dex: this._dex } : { type: "metaAndAssetCtxs" }) as
      [{ universe?: { name?: unknown }[] } | null, ({ markPx?: unknown } | null)[] | null] | null;
    const universe = meta?.[0]?.universe;
    const idx = Array.isArray(universe) ? universe.findIndex((a) => a?.name === coin) : -1;
    const raw = idx >= 0 && Array.isArray(meta?.[1]) ? meta[1][idx]?.markPx : undefined;
    const mark = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!(mark > 0) || !Number.isFinite(mark)) {
      throw new PerpError("PRICE_STALE", `Hyperliquid ${symbol.toUpperCase()}${this._dex ? ` (dex ${this._dex})` : ""}: no mark price in metaAndAssetCtxs (got ${JSON.stringify(raw)})`, {
        exchange: "hyperliquid",
        remediation: "Retry when the venue publishes a mark price for this market",
      });
    }
    return mark;
  }

  /**
   * Protection price an IOC market order on `symbol` would be sent with now.
   * Exposed so a TradingV2 wrapper can record execution.{protectionPrice, slippageBps}
   * (appliedBps = the bound after HL rounding).
   */
  async computeProtectionPrice(symbol: string, side: "buy" | "sell", slippage: ResolvedSlippage): Promise<{ referencePrice: string; protectionPrice: string; appliedBps: number }> {
    const ref = await this.referencePrice(symbol);
    const { protectionPrice, appliedBps } = hlProtectionPrice(ref, side, slippage.bps, this.getSzDecimals(symbol), 6);
    await assertHlAppliedBps(appliedBps, `${symbol.toUpperCase()} protection ${protectionPrice} vs reference ${ref}`);
    return { referencePrice: String(ref), protectionPrice, appliedBps };
  }

  /** Definite IOC outcome of a raw order response (see hlIocOutcome). */
  iocOutcomeOf(raw: unknown): { filledSize: string; final: true } | null {
    return hlIocOutcome(raw);
  }

  /**
   * Sign and send any exchange action via raw EIP-712 signing.
   * Bypasses the SDK entirely — works for order, batchModify, twapOrder, etc.
   */
  private ensureSigner(): void {
    // Resolves across all tiers; throws PerpError if none available
    this._resolveSigner();
  }

  /**
   * Normalize trailing zeros from price ('p') and size ('s') string fields
   * in an action object, recursively. Matches the SDK's normalizeTrailingZeros.
   *
   * The HL validator normalizes these fields before hashing; if we hash without
   * normalizing, the recovered signer address won't match → "User or API Wallet
   * does not exist" error.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _normalizeAction(obj: any): any {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => HyperliquidAdapter._normalizeAction(item));
    }
    const result = { ...obj };
    for (const key in result) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
      const value = result[key];
      if (value && typeof value === "object") {
        result[key] = HyperliquidAdapter._normalizeAction(value);
      } else if ((key === "p" || key === "s") && typeof value === "string") {
        let v = value;
        if (v.includes(".")) v = v.replace(/\.?0+$/, "");
        if (v === "-0") v = "0";
        result[key] = v;
      }
    }
    return result;
  }

  /** Monotonic ms nonce: unique even for rapid-fire requests in the same millisecond. */
  private static _nextNonce(): number {
    const now = Date.now();
    HyperliquidAdapter._lastNonce = now > HyperliquidAdapter._lastNonce ? now : HyperliquidAdapter._lastNonce + 1;
    return HyperliquidAdapter._lastNonce;
  }

  private get _network(): Network {
    return this._testnet ? "testnet" : "mainnet";
  }

  /**
   * Sign an L1 action with the active signer tier (agent or master) and POST it.
   * `nonce` must be passed when the action itself carries it (agentSendAsset).
   */
  private async _signAndSendAction(action: Record<string, unknown>, nonce: number = HyperliquidAdapter._nextNonce()): Promise<unknown> {
    const { signer } = this._resolveSigner();

    // Normalize trailing zeros from 'p' and 's' fields before hashing.
    // The HL validator does the same; without this, the hash differs and the
    // recovered signer address is wrong → "User or API Wallet does not exist".
    const normalizedAction = HyperliquidAdapter._normalizeAction(action);

    let signature: HlSignature;
    try {
      signature = await signHlL1Action(signer, normalizedAction, nonce, !this._testnet);
    } catch (e) {
      // Pre-send: nothing reached the venue (definite, never ORDER_PENDING).
      if (e instanceof PerpError) throw e;
      throw new PerpError("SIGNATURE_FAILED", `HL ${String(action.type)} action signing failed: ${e instanceof Error ? e.message : String(e)}`, { exchange: "hyperliquid" });
    }

    try {
      return await this._postExchange({ action, nonce, signature, vaultAddress: null });
    } catch (e) {
      throw hlL1ActionRejection(String(action.type), e);
    }
  }

  /**
   * Sign a USER-signed action (HyperliquidSignTransaction EIP-712) with the MASTER
   * signer and POST it. Agents cannot sign these — no agent fallback: without a
   * master signer this throws NO_SIGNER_AVAILABLE before anything is sent.
   */
  private async _signAndSendUserAction(type: HlUserSignedType, fields: Record<string, unknown>): Promise<unknown> {
    const master = this._evmSigner;
    if (!master) {
      throw new PerpError("NO_SIGNER_AVAILABLE", `Hyperliquid ${type} must be signed by the master wallet (an agent wallet cannot sign it), and none is configured`, {
        exchange: "hyperliquid",
        remediation: "Run with the master wallet: perp -e hyperliquid --ows <wallet> ... (or export PRIVATE_KEY=0x...)",
      });
    }
    const nonce = HyperliquidAdapter._nextNonce();
    const action = buildHlUserSignedAction(type, this._network, { ...fields, [hlUserSignedNonceField(type)]: nonce });
    let signature: HlSignature;
    try {
      signature = await signHlUserSignedAction(master, action);
    } catch (e) {
      if (e instanceof PerpError) throw e;
      throw new PerpError("SIGNATURE_FAILED", `HL ${type} signing failed: ${e instanceof Error ? e.message : String(e)}`, { exchange: "hyperliquid" });
    }
    // User-signed body: {action, nonce, signature} — no vaultAddress (python SDK _post_action
    // sends null for these; the venue reads the signer from the EIP-712 signature).
    try {
      return await this._postExchange({ action, nonce, signature });
    } catch (e) {
      throw hlUserActionRejection(type, e);
    }
  }

  /** POST /exchange request timeout: a request the venue never answers must not hang the CLI. */
  static readonly EXCHANGE_TIMEOUT_MS = 30_000;

  /**
   * POST /exchange; an `err` envelope or a 4xx non-JSON body throws (the venue refused it).
   * Once the signed action is on the wire its outcome is unknown unless the venue answers:
   * a connection reset, timeout, 5xx or unreadable 2xx body → ORDER_PENDING (sendFailure),
   * never a retryable EXCHANGE_UNREACHABLE / TIMEOUT. No connection at all → not sent.
   */
  private async _postExchange(payload: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this._testnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
    const type = String((payload.action as { type?: unknown } | undefined)?.type);
    const what = `${type} action`;
    const remediation = `Do NOT resubmit — the ${type} may have been executed. Check open orders, positions and balances first: perp -e hyperliquid account orders / portfolio`;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${baseUrl}/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HyperliquidAdapter.EXCHANGE_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      throw sendFailure("hyperliquid", what, e, remediation);
    }
    if (res.status >= 500) {
      throw orderOutcomeUnknown("hyperliquid", what, new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), remediation);
    }
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(text);
    } catch {
      if (res.status >= 400) throw new Error(`HL exchange API error (${res.status}): ${text.slice(0, 200)}`);
      throw orderOutcomeUnknown("hyperliquid", what, new Error(`unreadable response (HTTP ${res.status}): ${text.slice(0, 200)}`), remediation);
    }
    if (result?.status === "err") {
      throw new HlErrResponse(typeof result.response === "string" ? result.response : JSON.stringify(result));
    }
    return result;
  }

  /** One order wire (HL `order` action entry); p/s trailing zeros removed (HL API requirement). */
  private _orderWire(opts: {
    assetIndex: number;
    isBuy: boolean;
    price: string;
    size: string;
    orderType: unknown;
    reduceOnly: boolean;
    /** Client order id (`c`), already validated; null = none (the key is omitted). */
    cloid?: string | null;
  }): Record<string, unknown> {
    const trimZeros = (s: string) => {
      if (!s.includes(".")) return s;
      const n = s.replace(/\.?0+$/, "");
      return n === "-0" ? "0" : n;
    };
    // No "dex" field needed — the global asset index (110000+) encodes the dex
    const wire: Record<string, unknown> = {
      a: opts.assetIndex,
      b: opts.isBuy,
      p: trimZeros(opts.price),
      s: trimZeros(opts.size),
      r: opts.reduceOnly,
      t: opts.orderType,
    };
    // `c` last, only when set — the signed msgpack follows key order (python SDK order_request_to_order_wire).
    if (opts.cloid !== undefined && opts.cloid !== null) wire.c = opts.cloid;
    return wire;
  }

  /**
   * Place an order via raw exchange API with EIP-712 signing.
   * This bypasses the SDK's symbolConversion and supports dex-specific orders.
   */
  private async _rawPlaceOrder(opts: { action: Record<string, unknown> }) {
    const result = await this._signAndSendAction(opts.action);
    this._validateVenueAck(result, "order");
    return result;
  }

  /**
   * A computed limit price for `symbol` on the HL grid, aligned passively for `side` (buy ↓,
   * sell ↑). For strategy / grid / slice prices — limitOrder itself refuses off-grid input.
   */
  async alignComputedPrice(symbol: string, side: "buy" | "sell", price: string): Promise<string> {
    await this.getAssetIndex(symbol.toUpperCase()); // loads meta (szDecimals) when empty
    return hlAlignPriceToGrid(price, this.getSzDecimals(symbol), 6, side === "buy" ? "down" : "up");
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string; clientOrderId?: string }) {
    // TIF aliases: GTC/IOC/ALO or native spellings; FOK → CAPABILITY_UNSUPPORTED.
    let action: Record<string, unknown>;
    const cloid = opts?.clientOrderId === undefined ? null : HyperliquidAdapter.requireCloid(opts.clientOrderId);
    try { // pre-send (see marketOrder)
      const tif = hlTif(opts?.tif ?? "GTC");
      const reduceOnly = opts?.reduceOnly ?? false;
      const assetIndex = await this.getAssetIndex(symbol.toUpperCase()); // loads meta (szDecimals) when empty
      // Off-grid price → INVALID_TICK (refused, never rounded); size floored to the lot.
      const szDec = this.getSzDecimals(symbol);
      const roundedPrice = hlRequirePriceOnGrid(price, szDec, 6, "limit price");
      const roundedSize = floorSize(size, hlSizeStep(szDec)); // floored to the lot; 0 → SIZE_TOO_SMALL
      action = await this._orderAction([this._orderWire({
        assetIndex,
        isBuy: side === "buy",
        price: roundedPrice,
        size: roundedSize,
        orderType: { limit: { tif } },
        reduceOnly,
        cloid,
      })], "na", assetIndex);
    } catch (e) {
      throw orderNotSent("hyperliquid", `limit ${side} ${size} ${symbol.toUpperCase()} @ ${price}`, e);
    }
    // Use _rawPlaceOrder for both DEX and non-DEX (SDK exchange.placeOrder is unavailable)
    const result = await this._rawPlaceOrder({ action });
    await this._invalidateAccountCache();
    // The cloid sent rides on the result (`clientOrderId`), like Pacifica's.
    return cloid !== null ? { ...(result as Record<string, unknown>), clientOrderId: cloid } : result;
  }

  /**
   * Cancel one order by client order id — exchange-endpoint docs "Cancel order(s) by cloid":
   * `{ "type": "cancelByCloid", "cancels": [{ "asset": Number, "cloid": String }] }`. The asset is
   * the global id, so a HIP-3 dex order is addressed the same way. Per-entry error → ORDER_REJECTED.
   */
  async cancelByCloid(symbol: string, cloid: string) {
    this.ensureSigner();
    const id = HyperliquidAdapter.requireCloid(cloid);
    let assetIndex: number;
    try { // pre-send: the `meta` read behind the asset id
      assetIndex = await this.getAssetIndex(symbol.toUpperCase());
    } catch (e) {
      throw orderNotSent("hyperliquid", `cancel c:${id} ${symbol.toUpperCase()}`, e);
    }
    const result = await this._signAndSendAction({
      type: "cancelByCloid",
      cancels: [{ asset: assetIndex, cloid: id }],
    });
    this._validateVenueAck(result, `cancel c:${id}`);
    await this._invalidateAccountCache();
    return result;
  }

  async cancelOrder(symbol: string, orderId: string) {
    this.ensureSigner();
    // HL SDK declares exchange.cancelOrder in types but the runtime ExchangeAPI
    // instance (when constructed with our wallet/agent injection path) does not
    // expose it as a callable method. Use raw cancel action via _signAndSendAction
    // instead — same approach as the HIP-3 dex branch — which works uniformly for
    // standard perps and HIP-3 dexes.
    const oid = this._oidOf(orderId);
    let assetIndex: number;
    try { // pre-send (see marketOrder): the `meta` read behind the asset id
      assetIndex = await this.getAssetIndex(symbol.toUpperCase());
    } catch (e) {
      throw orderNotSent("hyperliquid", `cancel ${orderId} ${symbol.toUpperCase()}`, e);
    }
    const result = await this._signAndSendAction({
      type: "cancel",
      cancels: [{ a: assetIndex, o: oid }],
    });
    // A refused cancel (already filled, unknown oid) also comes back under an
    // "ok" envelope — without this the user is told the order was cancelled.
    this._validateVenueAck(result, `cancel ${orderId}`);
    await this._invalidateAccountCache();
    return result;
  }

  async cancelAllOrders(symbol?: string) {
    this.ensureSigner();
    let orders: ExchangeOrder[];
    try { // pre-send: the frontendOpenOrders listing — nothing is cancelled when it fails
      orders = await this.getOpenOrders();
    } catch (e) {
      throw orderNotSent("hyperliquid", `cancel-all${symbol ? ` ${symbol.toUpperCase()}` : ""}`, e);
    }
    const toCancel = symbol
      ? orders.filter((o) => {
          const norm = (s: string) => s.toUpperCase().replace(/-PERP$/, "").replace(/^[^:]+:/, "");
          return norm(o.symbol) === norm(symbol);
        })
      : orders;

    // Use _signAndSendAction uniformly for both standard perps and HIP-3 dexes.
    // SDK exchange.cancelOrder has the same runtime unavailability as single
    // cancelOrder (see comment there); raw cancel action works for both paths.
    // Every target is attempted (like lighter.ts cancelAllOrders): one refused / unknown cancel
    // must not leave the orders after it untouched and unreported. A per-entry "Order was never
    // placed, already canceled, or filled." means the order is no longer open — reported as gone
    // (not cancelled by this call), not a failure. All cancelled / gone → the raw results; any
    // failure → one error carrying the per-order outcome.
    const results: unknown[] = [];
    const perOrder: Array<{ orderId: string; symbol: string; outcome: "cancelled" | "gone" | "failed"; code: string | null; error: string | null }> = [];
    for (const o of toCancel) {
      try {
        const oid = this._oidOf(o.orderId);
        let assetIndex: number;
        try { // pre-send: the `meta` read behind the asset id
          assetIndex = await this.getAssetIndex(o.symbol);
        } catch (e) {
          throw orderNotSent("hyperliquid", `cancel ${o.orderId} ${o.symbol}`, e);
        }
        const res = await this._signAndSendAction({
          type: "cancel",
          cancels: [{ a: assetIndex, o: oid }],
        });
        this._validateVenueAck(res, `cancel ${o.orderId}`);
        results.push(res);
        perOrder.push({ orderId: o.orderId, symbol: o.symbol, outcome: "cancelled", code: null, error: null });
      } catch (e) {
        const venueErrors = e instanceof PerpError ? e.structured.details?.venueErrors : undefined;
        const gone = Array.isArray(venueErrors) && venueErrors.length > 0
          && venueErrors.every(v => typeof v === "string" && /already canceled, or filled/i.test(v));
        perOrder.push({ orderId: o.orderId, symbol: o.symbol, outcome: gone ? "gone" : "failed", code: classifyError(e, "hyperliquid").code, error: extractErrorMessage(e) });
      }
    }
    const failed = perOrder.filter(r => r.outcome === "failed");
    const gone = perOrder.filter(r => r.outcome === "gone");
    if (failed.length === 0) {
      if (gone.length > 0) {
        console.error(`[hyperliquid] cancel-all: ${gone.length} order(s) were no longer open (already cancelled or filled, not cancelled by this call): ${gone.map(r => r.orderId).join(", ")}`);
      }
      return results;
    }
    const cancelled = perOrder.filter(r => r.outcome === "cancelled").length;
    // Some cancelled → ORDER_PARTIAL; none cancelled → ORDER_REJECTED only when every failure is a
    // definite refusal, otherwise the outcome of at least one cancel is unknown (ORDER_PENDING).
    const code = cancelled > 0 ? "ORDER_PARTIAL"
      : failed.every(r => r.code !== null && DEFINITE_ORDER_FAILURE_CODES.has(r.code as ErrorCode)) ? "ORDER_REJECTED" : "ORDER_PENDING";
    throw new PerpError(code, `hyperliquid cancel-all: ${cancelled} of ${perOrder.length} order(s) cancelled${gone.length > 0 ? `, ${gone.length} already gone (cancelled or filled)` : ""}; failed: ${failed.map(r => `${r.orderId} ${r.symbol} (${r.error})`).join("; ")}`, {
      exchange: "hyperliquid",
      results: perOrder,
      remediation: "Check which orders are still open (perp account orders -e hyperliquid) and cancel the remaining ones individually",
    });
  }

  // ── Interface methods ──

  /**
   * Amend via HL native batchModify. `size` = the NEW
   * open (unfilled) size — native-modify semantics, not the original total. The
   * order's own tif (Gtc/Alo) and reduceOnly are read from frontendOpenOrders
   * and preserved; nothing is hardcoded.
   */
  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    // Read the RAW order: the mapped getOpenOrders() hardcodes type:"limit" and
    // drops reduceOnly, so it cannot distinguish a trigger order from a plain
    // limit nor preserve reduce-only across the modify.
    let raw: Record<string, unknown>[];
    try { // pre-send (see marketOrder): the order's own attributes
      raw = await this._infoPost({
        type: "frontendOpenOrders",
        user: this._address,
        ...(this._dex ? { dex: this._dex } : {}),
      }) as Record<string, unknown>[];
    } catch (e) {
      throw orderNotSent("hyperliquid", `edit ${orderId} ${symbol.toUpperCase()}`, e);
    }
    const existing = (raw ?? []).find(o => String(o.oid ?? "") === orderId);
    if (!existing) {
      // Rule #2: never default the side. Guessing "buy" on a resting sell order
      // rewrites it to the opposite side, which can open or flip a position.
      throw new PerpError(
        "ORDER_NOT_FOUND",
        `Hyperliquid order ${orderId} is not among the open orders; refusing to edit (cannot guess its side).`,
        { exchange: "hyperliquid" },
      );
    }
    // L11: the order id must belong to `symbol` — a modify carries the asset index of
    // `symbol`, so a mismatched id would move another market's order onto this one.
    const coinNorm = (s: string) => s.toUpperCase().replace(/-PERP$/, "");
    const coin = String(existing.coin ?? "");
    const base = (s: string) => coinNorm(s.includes(":") ? s.split(":")[1] : s);
    // HIP-3 coins are "<dex>:<BASE>" (the query above is already scoped to this adapter's dex).
    const sameCoin = coinNorm(coin) === coinNorm(symbol) || coinNorm(coin) === coinNorm(this.resolveSymbol(symbol))
      || (coin.includes(":") && !symbol.includes(":") && base(coin) === base(symbol));
    if (!sameCoin) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid order ${orderId} is on ${coin || "an unknown market"}, not ${symbol.toUpperCase()}; refusing to edit`, {
        exchange: "hyperliquid",
        remediation: `Pass the order's own symbol: perp trade edit ${coin || "<symbol>"} ${orderId} ...`,
      });
    }
    if (existing.isTrigger === true) {
      // batchModify is sent without the `a` (always_place) flag. Per the exchange
      // docs, that path requires a NON-trigger order, so the venue rejects a
      // modify into a stop/TP — re-placing it as a plain limit would also drop
      // the trigger. Refuse rather than corrupt the order's semantics.
      throw new PerpError(
        "INVALID_PARAMS",
        `Hyperliquid editOrder only supports non-trigger orders (order ${orderId} is ${String(existing.orderType ?? "a trigger order")}). Cancel and re-place it explicitly.`,
        { exchange: "hyperliquid" },
      );
    }
    const sideRaw = String(existing.side);
    const side = sideRaw === "B" ? "buy" : sideRaw === "A" ? "sell" : sideRaw.toLowerCase();
    if (side !== "buy" && side !== "sell") {
      throw new PerpError(
        "EXCHANGE_ERROR",
        `Hyperliquid order ${orderId} has an unrecognized side "${sideRaw}"; refusing to edit.`,
        { exchange: "hyperliquid" },
      );
    }
    const reduceOnly = existing.reduceOnly === true;
    const tif = existing.tif;
    if (tif !== "Gtc" && tif !== "Alo" && tif !== "Ioc") {
      // Rule #2: never guess the time-in-force (re-placing an ALO as GTC can take liquidity).
      throw unsupported("Hyperliquid", "amend", `original order attributes unknown (order ${orderId} reports tif ${JSON.stringify(tif ?? null)})`,
        `Cancel order ${orderId} and place a new order with an explicit --tif`);
    }
    // Keep the order's cloid across the modify (the modify carries a full order wire; without
    // `c` the edited order would lose the id `trade status/cancel c:<cloid>` address it by).
    const cloid = typeof existing.cloid === "string" && HL_CLOID_RE.test(existing.cloid) ? existing.cloid : null;
    return this.modifyOrder(symbol, parseInt(orderId), side, price, size, { reduceOnly, tif, ...(cloid !== null ? { cloid } : {}) });
  }

  async setLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross") {
    return this.updateLeverage(symbol, leverage, marginMode === "cross");
  }

  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean }) {
    // TP vs SL from the trigger vs the MARK price — HL docs: "The mark price is used to trigger
    // TP/SL orders." Buy at/above or sell at/below the mark = stop (sl); the other side =
    // take-profit (tp). A wrong tpsl would make the venue trigger the order immediately.
    // No mark price → PRICE_STALE.
    const trigger = Number(triggerPrice);
    if (!(trigger > 0) || !Number.isFinite(trigger)) {
      throw new PerpError("INVALID_PARAMS", `Invalid trigger price "${triggerPrice}" for ${symbol.toUpperCase()} stop order`, { exchange: "hyperliquid" });
    }
    let mark: number;
    try { // pre-send (see marketOrder): the metaAndAssetCtxs mark-price read
      mark = await this.markPrice(symbol);
    } catch (e) {
      throw orderNotSent("hyperliquid", `stop ${side} ${size} ${symbol.toUpperCase()} @ ${triggerPrice}`, e);
    }
    const tpsl = hlTriggerKind(side, trigger, mark);
    return this.triggerOrder(symbol, side, size, triggerPrice, tpsl, {
      isMarket: !opts?.limitPrice,
      limitPrice: opts?.limitPrice,
      reduceOnly: opts?.reduceOnly ?? true,
    });
  }

  /**
   * recentTrades: the venue's last HL_RECENT_TRADES_CAP (10) trades — no count parameter, no
   * paging. `limit` undefined = the venue max (10); an explicit `limit` above 10 is INVALID_PARAMS
   * naming the cap (never fewer rows than asked, silently). Row `symbol` is the raw venue coin
   * ("BTC", "km:US500"), as in the WS codec — not the "BTC-PERP" display name of `market list`.
   */
  async getRecentTrades(symbol: string, limit?: number): Promise<ExchangePublicTrade[]> {
    const n = limit ?? HL_RECENT_TRADES_CAP;
    if (!(Number.isInteger(n) && n > 0)) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid trades: limit must be a positive integer (got ${limit})`, { exchange: "hyperliquid" });
    }
    if (n > HL_RECENT_TRADES_CAP) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid trades: limit ${n} exceeds the venue cap of ${HL_RECENT_TRADES_CAP} (recentTrades serves only the last ${HL_RECENT_TRADES_CAP} trades, no paging)`, {
        exchange: "hyperliquid", remediation: `Use --limit ${HL_RECENT_TRADES_CAP} or less`,
      });
    }
    // recentTrades answers HTTP 500 "null" for an unlisted coin (live 2026-10-14), which would read
    // as a retryable venue error: resolve the coin against the asset map first (SYMBOL_NOT_FOUND).
    await this._listedMarket(symbol);
    const trades = await this._infoPost({ type: "recentTrades", coin: this._venueCoin(symbol) }) as Record<string, unknown>[] | null;
    if (trades === null) throw this._unknownSymbol(symbol);
    return trades
      .slice(0, n)
      .map((t) => ({
        time: Number(t.time ?? 0),
        symbol: String(t.coin ?? symbol.toUpperCase()),
        side: String(t.side) === "B" ? "buy" as const : "sell" as const,
        price: String(t.px ?? "0"),
        size: String(t.sz ?? ""),
        fee: null, // the public tape carries no fee
      }));
  }

  /**
   * candleSnapshot. Only the most recent HL_CANDLE_CAP (5000) candles of an interval exist (docs)
   * and older ones cannot be paged to: a `startTime` before hlEarliestCandleStart() is refused
   * up front (INVALID_PARAMS naming the earliest allowed start) — never a silently shortened
   * range. `closed` (additive) is false on the in-progress candle (close time `T`, or open +
   * interval when `T` is absent, still in the future). "1M" = 30-day buckets; "1w" opens
   * Thursday 00:00 UTC.
   */
  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<Array<ExchangeKline & { closed: boolean }>> {
    const ivMs = HL_CANDLE_INTERVAL_MS[interval];
    if (ivMs === undefined) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid has no ${JSON.stringify(interval)} candles`, {
        exchange: "hyperliquid", remediation: `Use one of: ${Object.keys(HL_CANDLE_INTERVAL_MS).join(", ")}`,
      });
    }
    const now = Date.now();
    const earliest = hlEarliestCandleStart(interval, now);
    if (startTime < earliest) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid serves only the most recent ${HL_CANDLE_CAP} ${interval} candles: the earliest allowed start is ${new Date(earliest).toISOString()} (${earliest}); requested ${new Date(startTime).toISOString()}`, {
        exchange: "hyperliquid", remediation: `Use --start ${earliest} or later, or a longer interval`,
      });
    }
    await this._listedMarket(symbol); // unlisted coin: SYMBOL_NOT_FOUND (candleSnapshot answers HTTP 500 "null")
    const candles = await this._infoPost({
      type: "candleSnapshot",
      req: { coin: this._venueCoin(symbol), interval, startTime, endTime },
    }) as Record<string, unknown>[];
    return (candles ?? []).map((c) => {
      assertCandleInterval(this.name, interval, c.i);
      const time = Number(c.t ?? 0);
      const closeAt = Number.isFinite(Number(c.T)) && c.T !== undefined && c.T !== null ? Number(c.T) : time + ivMs;
      return {
        time,
        open: String(c.o ?? "0"),
        high: String(c.h ?? "0"),
        low: String(c.l ?? "0"),
        close: String(c.c ?? "0"),
        // absent / non-numeric → null (never "")
        volume: typeof c.v === "string" && c.v.trim() !== "" && Number.isFinite(Number(c.v)) ? c.v
          : typeof c.v === "number" && Number.isFinite(c.v) ? String(c.v) : null,
        quoteVolume: null, // candleSnapshot carries base volume only
        trades: Number(c.n ?? 0),
        closed: closeAt < now,
      };
    });
  }

  /**
   * Order history: POST /info {type:"historicalOrders"} ("Retrieve a user's historical orders",
   * at most 2000 most recent; live 2026-10-13: newest first, each order listed once per status —
   * e.g. "open" then "filled" — with equal statusTimestamp possible). One row per oid with its
   * final status (latest statusTimestamp; on a tie a non-"open" status wins). Includes canceled /
   * rejected orders (the previous userFills read showed fills only). Unreadable rows → EXCHANGE_ERROR.
   * The info endpoint is account-wide; rows are scoped to this adapter (see _inHistoryScope).
   */
  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    this.ensureAddress();
    const rows = await this._infoPost({ type: "historicalOrders", user: this._address });
    if (!Array.isArray(rows)) {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid historicalOrders returned no list (${JSON.stringify(rows).slice(0, 120)})`, { exchange: "hyperliquid" });
    }
    await this._historyScopeReady();
    const latest = new Map<string, { at: number; status: string; o: Record<string, unknown> }>();
    for (const row of rows as Array<Record<string, unknown>>) {
      const o = row.order as Record<string, unknown> | undefined;
      const at = Number(row.statusTimestamp);
      if (o === undefined || o === null || typeof row.status !== "string" || !Number.isFinite(at) || (typeof o.oid !== "number" && typeof o.oid !== "string")) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid historicalOrders row without order / oid / status / statusTimestamp: ${JSON.stringify(row).slice(0, 160)}`, { exchange: "hyperliquid" });
      }
      if (!this._inHistoryScope(hlField(o, "coin", "historicalOrders"))) continue;
      const key = String(o.oid);
      const prev = latest.get(key);
      if (prev === undefined || at > prev.at || (at === prev.at && hlStatusRank(row.status) > hlStatusRank(prev.status))) {
        latest.set(key, { at, status: row.status, o });
      }
    }
    return [...latest.values()].sort((x, y) => y.at - x.at).slice(0, limit).map(({ status, o }) => {
      const origSz = hlField(o, "origSz", "historicalOrders");
      const remaining = hlField(o, "sz", "historicalOrders");
      const triggerPx = Number(o.triggerPx);
      return {
        orderId: String(o.oid),
        symbol: this._displaySymbol(hlField(o, "coin", "historicalOrders")),
        side: hlSide(o.side, "historicalOrders"),
        price: hlField(o, "limitPx", "historicalOrders"),
        size: origSz,
        filled: subDecimal(origSz, remaining),
        status,
        type: hlField(o, "orderType", "historicalOrders"),
        triggerPrice: o.isTrigger === true && Number.isFinite(triggerPx) && triggerPx > 0 ? String(o.triggerPx) : null,
      };
    });
  }

  /** Fills: POST /info {type:"userFills"} (at most 2000 most recent, newest first — live 2026-10-13). */
  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    this.ensureAddress();
    const fills = await this._infoPost({ type: "userFills", user: this._address });
    if (!Array.isArray(fills)) {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid userFills returned no list (${JSON.stringify(fills).slice(0, 120)})`, { exchange: "hyperliquid" });
    }
    await this._historyScopeReady();
    return (fills as Array<Record<string, unknown>>).filter((f) => this._inHistoryScope(hlField(f, "coin", "userFills"))).slice(0, limit).map((f) => {
      const time = Number(hlField(f, "time", "userFills"));
      if (!Number.isFinite(time)) throw new PerpError("EXCHANGE_ERROR", "Hyperliquid userFills row with a non-numeric time", { exchange: "hyperliquid" });
      return {
        time,
        symbol: this._displaySymbol(hlField(f, "coin", "userFills")),
        side: hlSide(f.side, "userFills"),
        price: hlField(f, "px", "userFills"),
        size: hlField(f, "sz", "userFills"),
        fee: hlField(f, "fee", "userFills"),
      };
    });
  }

  /**
   * Funding payments in this adapter's scope (see _inHistoryScope), newest first, at most `limit`.
   * Reads the last 24 h first and widens to 7 days only when that holds fewer than `limit` rows
   * (POST /info userFunding weighs per row returned; bots poll it).
   */
  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    this.ensureAddress();
    await this._historyScopeReady();
    const now = Date.now();
    let rows = await this._fundingSince(now - 24 * 60 * 60 * 1000);
    if (rows.length < limit) rows = await this._fundingSince(now - 7 * 24 * 60 * 60 * 1000);
    return rows.sort((a, b) => b.time - a.time).slice(0, limit);
  }

  /**
   * Every userFunding row since `startTime`. The endpoint returns rows OLDEST first, at most 500
   * per response (live 2026-10-13), and every coin of a funding hour shares one millisecond — so
   * pages continue from the last row's time INCLUSIVE and rows are deduped by time + coin (funding
   * rows carry a zero hash). A full page that adds nothing new, or more than HL_FUNDING_MAX_PAGES
   * pages → EXCHANGE_ERROR (never a list with payments silently missing).
   */
  private async _fundingSince(startTime: number): Promise<ExchangeFundingPayment[]> {
    const out: ExchangeFundingPayment[] = [];
    const seen = new Set<string>();
    let from = startTime;
    for (let page = 0; ; page++) {
      if (page >= HL_FUNDING_MAX_PAGES) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid funding history needs more than ${HL_FUNDING_MAX_PAGES} pages — the result would be incomplete`, { exchange: "hyperliquid" });
      }
      const rows = await this._infoPost({ type: "userFunding", user: this._address, startTime: from });
      if (!Array.isArray(rows)) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid userFunding returned no list (${JSON.stringify(rows).slice(0, 120)})`, { exchange: "hyperliquid" });
      }
      let last = -Infinity;
      let fresh = 0;
      for (const h of rows as Array<Record<string, unknown>>) {
        const time = Number(h.time);
        const delta = h.delta as Record<string, unknown> | undefined;
        if (!Number.isFinite(time) || delta === undefined || delta === null || typeof delta.coin !== "string" || delta.coin === "" || typeof delta.usdc !== "string" || delta.usdc === "") {
          throw new PerpError("EXCHANGE_ERROR", `Hyperliquid userFunding row without time / delta.coin / delta.usdc: ${JSON.stringify(h).slice(0, 160)}`, { exchange: "hyperliquid" });
        }
        last = Math.max(last, time);
        const key = `${time}|${delta.coin}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh++;
        if (this._inHistoryScope(delta.coin)) out.push({ time, symbol: this._displaySymbol(delta.coin), payment: delta.usdc });
      }
      if (rows.length < HL_FUNDING_PAGE) break;
      if (fresh === 0) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid returned ${HL_FUNDING_PAGE}+ funding rows at one millisecond (${last}) — paging cannot advance`, { exchange: "hyperliquid" });
      }
      from = last;
    }
    return out;
  }

  /** The asset map backs _displaySymbol / _inHistoryScope; load it before mapping history rows. */
  private async _historyScopeReady(): Promise<void> {
    if (this._assetMap.size === 0) await this._loadAssetMap();
    if (this._assetMapError) throw this._assetMapError;
  }

  /**
   * Whether an account-wide history row (historicalOrders / userFills / userFunding carry every
   * dex, spot "@n" / "PAIR/USDC" and outcome "#n" coins) belongs to this adapter: a HIP-3 dex
   * adapter keeps "<dex>:…" coins, the native adapter keeps native perp coins only.
   */
  private _inHistoryScope(coin: string): boolean {
    if (this._dex) return coin.startsWith(`${this._dex}:`);
    return !/[:@#/]/.test(coin);
  }

  /**
   * The last `limit` hourly funding settlements. HL funding is hourly, so the window starts
   * `limit + 1` hours back (one spare hour for a settlement not yet published), and fundingHistory
   * pages are read forward from the last row's time (docs: at most 500 elements per response;
   * "use the last returned timestamp as the next startTime") — deduped by time, oldest first.
   */
  async getFundingHistory(symbol: string, limit = 10): Promise<FundingHistoryRow[]> {
    if (!(Number.isInteger(limit) && limit > 0)) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid funding history: limit must be a positive integer (got ${limit})`, { exchange: "hyperliquid" });
    }
    if (limit > HL_FUNDING_HISTORY_MAX_LIMIT) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid funding history: limit ${limit} exceeds ${HL_FUNDING_HISTORY_MAX_LIMIT} hourly rows`, { exchange: "hyperliquid", remediation: `Use --limit ${HL_FUNDING_HISTORY_MAX_LIMIT} or less` });
    }
    await this._listedMarket(symbol); // unlisted coin: SYMBOL_NOT_FOUND (fundingHistory answers HTTP 500)
    const history = await this._fundingHistorySince(this._venueCoin(symbol), Date.now() - (limit + 1) * 60 * 60 * 1000);
    return history.slice(-limit).map((h) => ({
      time: Number(h.time ?? 0),
      rate: venueRateField(h.fundingRate, "fundingHistory fundingRate", "hyperliquid"),
      price: null,
      intervalHours: 1,
      rateKind: "lastSettled" as const,
    }));
  }

  /** Every fundingHistory row of `coin` since `startTime`, paged forward (500 per response), deduped by time, oldest first. */
  private async _fundingHistorySince(coin: string, startTime: number): Promise<Record<string, unknown>[]> {
    const byTime = new Map<number, Record<string, unknown>>();
    let from = startTime;
    for (let page = 0; ; page++) {
      if (page >= HL_FUNDING_HISTORY_MAX_PAGES) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid fundingHistory needs more than ${HL_FUNDING_HISTORY_MAX_PAGES} pages — the result would be incomplete`, { exchange: "hyperliquid" });
      }
      const rows = await this._infoPost({ type: "fundingHistory", coin, startTime: from });
      if (!Array.isArray(rows)) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid fundingHistory returned no list (${JSON.stringify(rows).slice(0, 120)})`, { exchange: "hyperliquid" });
      }
      let last = -Infinity;
      let fresh = 0;
      for (const h of rows as Record<string, unknown>[]) {
        const t = Number(h.time);
        if (!Number.isFinite(t)) throw new PerpError("EXCHANGE_ERROR", `Hyperliquid fundingHistory row without a numeric time: ${JSON.stringify(h).slice(0, 160)}`, { exchange: "hyperliquid" });
        last = Math.max(last, t);
        if (!byTime.has(t)) { byTime.set(t, h); fresh++; }
      }
      if (rows.length < HL_INFO_PAGE || fresh === 0) break;
      from = last;
    }
    return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  }

  // ────────────────────────────────────────────────────────────
  //  Extended methods (from Python SDK / nktkas TS SDK analysis)
  // ────────────────────────────────────────────────────────────

  /**
   * Place a trigger order (stop loss / take profit).
   * Python SDK: order() with trigger type {"trigger": {triggerPx, isMarket, tpsl: "tp"|"sl"}}
   *
   * Pricing:
   * - isMarket (default): HL native market trigger; `p` = trigger ± 10 % (the venue's documented
   *   market TP/SL slippage tolerance, HL_MARKET_TPSL_SLIPPAGE_BPS), aligned toward crossing.
   * - limit trigger with an explicit `limitPrice`: that price, rounded to HL's grid.
   * - limit trigger without `limitPrice`: protection = TRIGGER price ± opts.slippage.bps
   *   (reference = trigger, not mark), aligned toward crossing. Missing slippage →
   *   INVALID_PARAMS (no implicit zero-slippage limit at the trigger).
   */
  async triggerOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    triggerPrice: string,
    tpsl: "tp" | "sl",
    opts?: { isMarket?: boolean; limitPrice?: string; reduceOnly?: boolean; grouping?: string; slippage?: ResolvedSlippage }
  ) {
    this.ensureSigner();
    const what = `${tpsl} trigger ${side} ${size} ${symbol.toUpperCase()} @ ${triggerPrice}`;
    let assetIndex: number;
    try { // pre-send (see marketOrder)
      assetIndex = await this.getAssetIndex(symbol.toUpperCase());
    } catch (e) {
      throw orderNotSent("hyperliquid", what, e);
    }
    const szDec = this.getSzDecimals(symbol);
    const roundedSize = floorSize(size, hlSizeStep(szDec)); // floored to the lot; 0 → SIZE_TOO_SMALL
    // User-supplied trigger / limit prices: off-grid → INVALID_TICK (never rounded).
    const roundedTrigger = hlRequirePriceOnGrid(triggerPrice, szDec, 6, "trigger price");
    // Stop-limit / TP-limit: the order's limit price is the caller's limitPrice, not the trigger.
    const isMarket = opts?.isMarket ?? true;
    let roundedLimit: string;
    if (opts?.limitPrice !== undefined) {
      roundedLimit = hlRequirePriceOnGrid(opts.limitPrice, szDec, 6, "trigger limit price");
    } else if (isMarket) {
      // Market trigger: `p` = trigger ± the venue's documented market TP/SL tolerance (never the
      // trigger itself — see HL_MARKET_TPSL_SLIPPAGE_BPS), aligned toward crossing.
      roundedLimit = hlProtectionPrice(Number(roundedTrigger), side, HL_MARKET_TPSL_SLIPPAGE_BPS, szDec, 6).protectionPrice;
    } else {
      if (!opts?.slippage) {
        throw new PerpError("INVALID_PARAMS", `Limit trigger order for ${symbol.toUpperCase()} needs a limit price or a resolved slippage bound`, {
          remediation: "Pass --limit-price, or use a market trigger.",
        });
      }
      const pp = hlProtectionPrice(Number(roundedTrigger), side, opts.slippage.bps, szDec, 6);
      await assertHlAppliedBps(pp.appliedBps, `${symbol.toUpperCase()} trigger limit ${pp.protectionPrice} vs trigger ${roundedTrigger}`);
      roundedLimit = pp.protectionPrice;
    }

    // Remove trailing zeros (HL API requirement)
    const trimZeros = (s: string) => {
      if (!s.includes(".")) return s;
      const n = s.replace(/\.?0+$/, "");
      return n === "-0" ? "0" : n;
    };

    const orderWire = {
      a: assetIndex,
      b: side === "buy",
      p: trimZeros(roundedLimit),
      s: trimZeros(roundedSize),
      r: opts?.reduceOnly ?? true,
      t: {
        trigger: {
          isMarket,
          triggerPx: trimZeros(roundedTrigger),
          tpsl,
        },
      },
    };

    let action: Record<string, unknown>;
    try { // pre-send: the builder approval read (info maxBuilderFee) when a builder fee is configured
      action = await this._orderAction([orderWire], opts?.grouping ?? "positionTpsl", assetIndex);
    } catch (e) {
      throw orderNotSent("hyperliquid", what, e);
    }

    // The trigger ack is the bare status "waitingForTrigger" (no oid): the open trigger orders are
    // read before and after so the new order's oid can be identified (_newTriggerOid).
    let coin = "";
    let before: Set<string> | null = null;
    try {
      coin = this._venueCoin(symbol);
      before = await this._triggerOids(coin);
    } catch (e) {
      // Only the oid lookup is skipped (the order is still sent); the result then carries no id.
      console.error(`[hyperliquid] Warning: open-orders read before the trigger order failed (${e instanceof Error ? e.message : String(e)}) — its order id will not be resolved`);
    }
    const result = await this._signAndSendAction(action);
    this._validateVenueAck(result, `${tpsl.toUpperCase()} trigger order for ${symbol.toUpperCase()}`);
    const statuses = (result as { response?: { data?: { statuses?: unknown[] } } } | null)?.response?.data?.statuses;
    if (before === null || !Array.isArray(statuses) || statuses[0] !== "waitingForTrigger") return result;
    const triggerOid = await this._newTriggerOid(coin, before, {
      side: orderWire.b ? "B" : "A", triggerPx: orderWire.t.trigger.triggerPx, sz: orderWire.s, reduceOnly: orderWire.r,
    });
    if (triggerOid === null) {
      console.error(`[hyperliquid] Warning: ${tpsl.toUpperCase()} trigger order for ${symbol.toUpperCase()} placed, but its order id could not be identified — find it with: perp account orders -e hyperliquid`);
      return result;
    }
    return { ...(result as Record<string, unknown>), triggerOid };
  }

  /** Open trigger orders of `coin` (frontendOpenOrders rows with isTrigger), by oid. */
  private async _triggerOids(coin: string): Promise<Set<string>> {
    const req: Record<string, unknown> = { type: "frontendOpenOrders", user: this._address };
    if (this._dex) req.dex = this._dex;
    const rows = await this._infoPost(req);
    if (!Array.isArray(rows)) throw new PerpError("EXCHANGE_ERROR", "frontendOpenOrders returned no array", { exchange: "hyperliquid" });
    return new Set((rows as Record<string, unknown>[]).filter(r => r.coin === coin && r.isTrigger === true).map(r => String(r.oid)));
  }

  /**
   * The oid of the trigger order just placed: the single open trigger order of `coin` not listed
   * before, with the side / trigger price / size / reduce-only sent. Several reads (500 ms apart);
   * none or more than one candidate → null (never guessed).
   */
  private async _newTriggerOid(coin: string, before: Set<string>, sent: { side: "A" | "B"; triggerPx: string; sz: string; reduceOnly: boolean }): Promise<string | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500));
      const req: Record<string, unknown> = { type: "frontendOpenOrders", user: this._address };
      if (this._dex) req.dex = this._dex;
      let rows: unknown;
      try { rows = await this._infoPost(req); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      const hits = (rows as Record<string, unknown>[]).filter(r =>
        r.coin === coin && r.isTrigger === true && !before.has(String(r.oid)) && r.side === sent.side
        && Number(r.triggerPx) === Number(sent.triggerPx) && Number(r.sz) === Number(sent.sz) && r.reduceOnly === sent.reduceOnly
        && typeof r.oid === "number" && Number.isSafeInteger(r.oid));
      if (hits.length === 1) return String(hits[0].oid);
      if (hits.length > 1) return null;
    }
    return null;
  }

  /**
   * Place a TWAP order.
   * Python SDK: not available in old SDK, available via raw exchange action.
   * nktkas TS SDK: twapOrder({twap: {a, b, s, r, m, t}})
   */
  async twapOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    durationMinutes: number,
    opts?: { reduceOnly?: boolean; randomize?: boolean }
  ) {
    const assetIndex = await this.getAssetIndex(symbol);
    hlAssertTwapBounds(symbol, size, durationMinutes, await this.markPrice(symbol));
    const action = {
      type: "twapOrder",
      twap: {
        a: assetIndex,
        b: side === "buy",
        s: size,
        r: opts?.reduceOnly ?? false,
        m: durationMinutes,
        t: opts?.randomize ?? true,
      },
    };
    const result = await this._sendExchangeAction(action);
    hlValidateTwapResult(result, `TWAP ${side} ${size} ${symbol}`);
    return result;
  }

  /**
   * Cancel a TWAP order.
   */
  async twapCancel(symbol: string, twapId: number) {
    const assetIndex = await this.getAssetIndex(symbol);
    const action = {
      type: "twapCancel",
      a: assetIndex,
      t: twapId,
    };
    const result = await this._sendExchangeAction(action);
    hlValidateTwapResult(result, `TWAP cancel ${twapId}`);
    return result;
  }

  /** Venue margin restriction of `symbol` (meta marginMode / onlyIsolated); null = unrestricted. */
  marginModeOf(symbol: string): "strictIsolated" | "noCross" | null {
    return this._marginModeMap.get(this.resolveSymbol(symbol.toUpperCase())) ?? null;
  }

  /**
   * Update leverage for a symbol — L1 action `updateLeverage` (agent-signable),
   * python SDK update_leverage. Cross is refused up front on isolated-only assets.
   */
  async updateLeverage(symbol: string, leverage: number, isCross = true) {
    this.ensureSigner();
    let asset: number;
    try { // pre-send (see marketOrder): the leverage change was not sent
      asset = await this.getAssetIndex(symbol.toUpperCase());
    } catch (e) {
      throw orderNotSent("hyperliquid", `leverage ${leverage}x ${symbol.toUpperCase()}`, e);
    }
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid leverage must be a positive integer (got ${leverage})`, { exchange: "hyperliquid" });
    }
    const mm = this.marginModeOf(symbol);
    if (isCross && mm !== null) {
      throw unsupported("Hyperliquid", "cross margin", `${symbol.toUpperCase()} is isolated-only on the venue (marginMode ${mm})`, "Use --isolated for this market");
    }
    return this._signAndSendAction({ type: "updateLeverage", asset, isCross, leverage });
  }

  /**
   * Add (amount > 0) or remove (amount < 0) isolated margin — L1 action
   * `updateIsolatedMargin`, python SDK update_isolated_margin: `isBuy` is always
   * true and the SIGNED `ntli` (USDC × 1e6) carries the direction.
   */
  async updateIsolatedMargin(symbol: string, amount: number) {
    this.ensureSigner();
    const ntli = Math.round(amount * 1e6);
    if (!Number.isFinite(amount) || ntli === 0) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid isolated margin change must be a non-zero USDC amount (got ${amount})`, { exchange: "hyperliquid" });
    }
    const asset = await this.getAssetIndex(symbol.toUpperCase());
    if (ntli < 0 && this.marginModeOf(symbol) === "strictIsolated") {
      throw unsupported("Hyperliquid", "isolated margin removal", `${symbol.toUpperCase()} is strictIsolated on the venue (margin cannot be removed)`, "Close or reduce the position to release margin");
    }
    return this._signAndSendAction({ type: "updateIsolatedMargin", asset, isBuy: true, ntli });
  }

  /**
   * Withdraw USDC over CCTP (native USDC) — user-signed `sendToEvmWithData` (master only):
   * HyperCore is debited, the USDC is burned on HyperEVM and CCTP mints it on `chain`
   * (default Arbitrum). The Arbitrum Bridge2 `withdraw3` path is no longer used.
   * Docs: developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm —
   * sourceDex "spot" (unified accounts hold USDC in spot) or "" (standard accounts' perp
   * balance); data "0x" = automatic forwarding, which CCTP charges a fixed fee for
   * (Arbitrum 0.2 USDC; an amount below the fee reverts).
   */
  async withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number; chain?: HlCctpChain }) {
    if (opts?.assetId !== undefined || opts?.routeType !== undefined) {
      throw new PerpError("INVALID_PARAMS", "Hyperliquid withdraw takes no assetId / routeType (USDC over CCTP; pick the destination with --chain)", { exchange: "hyperliquid" });
    }
    const chain: HlCctpChain = opts?.chain ?? "arbitrum";
    const route = HL_CCTP_ROUTES[chain];
    const amountStr = hlAmountString(amount);
    if (route.forwardingFeeUsdc !== null && !(Number(amountStr) > Number(route.forwardingFeeUsdc))) {
      throw new PerpError("SIZE_TOO_SMALL", `Hyperliquid CCTP withdraw ${amountStr} USDC does not exceed the ${chain} forwarding fee ${route.forwardingFeeUsdc} USDC (the transfer would revert); nothing was sent`, { exchange: "hyperliquid" });
    }
    return this._signAndSendUserAction("sendToEvmWithData", {
      token: "USDC",
      amount: amountStr,
      sourceDex: this.isUnifiedAccount ? "spot" : "",
      destinationRecipient: hlDestination(destination),
      addressEncoding: "hex",
      destinationChainId: route.cctpDomain,
      gasLimit: 200000,
      data: "0x",
    });
  }

  /**
   * Send USDC to another Hyperliquid account — user-signed `usdSend` (master only),
   * python SDK usd_transfer.
   */
  async usdTransfer(amount: number, destination: string) {
    return this._signAndSendUserAction("usdSend", { destination: hlDestination(destination), amount: hlAmountString(String(amount)) });
  }

  /**
   * Move USDC between this account's spot and perp balances — user-signed
   * `usdClassTransfer` (master only), python SDK usd_class_transfer.
   */
  async usdClassTransfer(amount: string, toPerp: boolean) {
    return this._signAndSendUserAction("usdClassTransfer", { amount: hlAmountString(amount), toPerp });
  }

  /**
   * Move this dex's collateral token between spot and this adapter's perp dex as an
   * L1 action `agentSendAsset` (agent-signable; destination = own account). Spot →
   * perp when `toPerp`, else perp → spot. The token is "<name>:<tokenId>" of the
   * dex collateral token, read from spotMeta (never hardcoded).
   */
  async agentSendAsset(amount: string, toPerp: boolean) {
    this.ensureSigner();
    this.ensureAddress();
    const token = await this._collateralTokenWire();
    const nonce = HyperliquidAdapter._nextNonce();
    const action = {
      type: "agentSendAsset",
      destination: this._address.toLowerCase(),
      sourceDex: toPerp ? "spot" : this._dex,
      destinationDex: toPerp ? this._dex : "spot",
      token,
      amount: hlAmountString(amount),
      fromSubAccount: "",
      nonce,
    };
    return this._signAndSendAction(action, nonce);
  }

  /** "<name>:<tokenId>" of this dex's collateral token (meta{dex}.collateralToken → spotMeta tokens). */
  private async _collateralTokenWire(): Promise<string> {
    const idx = await this._getCollateralToken();
    const spotMeta = await this._infoPost({ type: "spotMeta" }) as { tokens?: Array<{ name?: unknown; index?: unknown; tokenId?: unknown }> } | null;
    const t = (spotMeta?.tokens ?? []).find((x) => x.index === idx);
    if (!t || typeof t.name !== "string" || typeof t.tokenId !== "string" || !/^0x[0-9a-fA-F]+$/.test(t.tokenId)) {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid spotMeta has no token id for collateral token index ${idx}`, { exchange: "hyperliquid" });
    }
    return `${t.name}:${t.tokenId}`;
  }

  /**
   * Create a sub-account.
   */
  async createSubAccount(name: string) {
    const action = {
      type: "createSubAccount",
      name,
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Transfer USD between main and sub-account.
   */
  async subAccountTransfer(subAccountUser: string, isDeposit: boolean, amount: number) {
    const action = {
      type: "subAccountTransfer",
      subAccountUser,
      isDeposit,
      usd: Math.round(amount * 1e6), // 6 decimals
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Modify an existing order (native batchModify). `newSize` = new open size.
   * `tif`/`reduceOnly` must be the original order's (editOrder reads them from
   * frontendOpenOrders) — a modify otherwise silently changes the order's TIF.
   */
  async modifyOrder(
    symbol: string,
    orderId: number,
    newSide: "buy" | "sell",
    newPrice: string,
    newSize: string,
    opts: { reduceOnly: boolean; tif: HlTif; cloid?: string | null }
  ) {
    let assetIndex: number;
    try { // pre-send (see marketOrder)
      assetIndex = await this.getAssetIndex(symbol);
    } catch (e) {
      throw orderNotSent("hyperliquid", `modify ${orderId} ${symbol.toUpperCase()}`, e);
    }
    const szDec = this.getSzDecimals(symbol);
    // Remove trailing zeros (HL API requirement)
    const trimZeros = (s: string) => {
      if (!s.includes(".")) return s;
      const n = s.replace(/\.?0+$/, "");
      return n === "-0" ? "0" : n;
    };
    const action = {
      type: "batchModify",
      modifies: [{
        oid: orderId,
        order: {
          a: assetIndex,
          b: newSide === "buy",
          p: trimZeros(hlRequirePriceOnGrid(newPrice, szDec, 6, "modify price")),
          s: trimZeros(floorSize(newSize, hlSizeStep(szDec))), // floored to the lot; 0 → SIZE_TOO_SMALL
          r: opts.reduceOnly,
          t: { limit: { tif: opts.tif } },
          ...(opts.cloid !== undefined && opts.cloid !== null ? { c: opts.cloid } : {}),
        },
      }],
    };
    const result = await this._signAndSendAction(action);
    this._validateModifyResult(result, orderId);
    return result;
  }

  /**
   * Validate that the venue actually accepted an order/cancel/modify action.
   *
   * HL returns the envelope `status: "ok"` even when the individual entry was
   * rejected — the real verdict is per-entry in `response.data.statuses[]`,
   * where an accepted entry is `{filled}` / `{resting}` / the string "success"
   * and a rejected one is `{error: "..."}`. `_signAndSendAction` only throws on
   * the ENVELOPE, so every path that skipped this check reported a rejection to
   * the user as a green success.
   * A per-entry `{error}` is the venue's definite verdict on that entry — including an
   * IOC's "could not immediately match" (cancelled with nothing filled) — so it is
   * ORDER_REJECTED (definite, never quarantined as an unknown outcome).
   * Also used by HyperliquidSpotAdapter (spot limit orders).
   */
  _validateVenueAck(result: unknown, what: string): void {
    const r = result as { response?: { data?: { statuses?: unknown[] } } };
    const statuses = r?.response?.data?.statuses;
    if (!Array.isArray(statuses) || statuses.length === 0) {
      // The signed action was already accepted by the envelope: without a per-entry verdict the
      // order / modify / cancel may or may not have taken effect (like marketOrder's
      // _validateOrderFill) — ORDER_PENDING, never the retryable EXCHANGE_ERROR.
      throw orderOutcomeUnknown("hyperliquid", what, new Error("no order status in response"),
        /^cancel/i.test(what)
          ? `Do NOT assume the order was cancelled (nor resubmit the cancel blindly) — check open orders first: perp -e hyperliquid account orders`
          : `Do NOT resubmit — the ${what} may have taken effect. Check open orders and positions first: perp -e hyperliquid account orders / portfolio`);
    }
    const errors = statuses
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).error : undefined))
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    if (errors.length > 0) {
      const noMatch = errors.some(e => /could not immediately match/i.test(e));
      throw new PerpError(
        "ORDER_REJECTED",
        `Hyperliquid ${what} rejected: ${errors.join("; ")}${noMatch ? " (IOC cancelled by the venue — nothing filled)" : ""}`,
        { exchange: "hyperliquid", venueErrors: errors },
      );
    }
  }

  private _validateModifyResult(result: unknown, orderId: number): void {
    this._validateVenueAck(result, `modify ${orderId}`);
  }

  /**
   * Schedule cancel: cancel all orders at a future time.
   * Max 10 triggers per day.
   */
  async scheduleCancel(timeMs?: number) {
    // Official python SDK schedule_cancel: the action is {"type": "scheduleCancel"} and
    // `if time is not None: schedule_cancel_action["time"] = time` — when unsetting, the
    // `time` key is absent from BOTH the signed (msgpack) action and the posted JSON.
    const action: Record<string, unknown> = { type: "scheduleCancel" };
    if (timeMs !== undefined) action.time = timeMs;
    return this._sendExchangeAction(action);
  }

  /**
   * Set the account's referrer (one HL `setReferrer` action, signed + sent).
   * Called only from the explicit `wallet manage referral set` command — never on
   * adapter creation. Throws on a venue rejection (SSOT Rule #2).
   */
  async setReferrer(code: string): Promise<unknown> {
    if (!code) {
      throw new PerpError("INVALID_PARAMS", "Hyperliquid referral code is empty", {
        remediation: "Pass a code: perp -e hyperliquid wallet manage referral set <code>",
      });
    }
    const res = await this._sendExchangeAction({ type: "setReferrer", code });
    const r = res as { status?: string; response?: unknown } | null;
    if (r && r.status === "err") {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid setReferrer rejected: ${String(r.response)}`, {
        exchange: "hyperliquid",
        remediation: "A Hyperliquid account can set a referrer only once; the venue message above says why it was rejected",
      });
    }
    return res;
  }


  /**
   * Get user trade fills.
   */
  async getUserFills(startTime?: number, endTime?: number) {
    this.ensureAddress();
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const body: Record<string, unknown> = {
      type: "userFillsByTime",
      user: this._address,
    };
    if (startTime) body.startTime = startTime;
    if (endTime) body.endTime = endTime;
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /**
   * Get user portfolio analytics.
   */
  async getPortfolio() {
    this.ensureAddress();
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "portfolio", user: this._address }),
    });
    return res.json();
  }

  /**
   * Query a specific order by OID.
   */
  /** info `orderStatus`: `oid` "Either u64 representing the order id or 16-byte hex string representing the client order id". */
  async queryOrder(orderId: number | string) {
    this.ensureAddress();
    if (typeof orderId === "string") HyperliquidAdapter.requireCloid(orderId);
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "orderStatus", user: this._address, oid: orderId }),
    });
    return res.json();
  }

  /**
   * Approve a builder fee.
   * Action type: approveBuilderFee
   */
  async approveBuilderFee(builder: string, maxFeeRate: string) {
    // USER-signed (HyperliquidSignTransaction EIP-712), master only — never the L1 scheme.
    return this._signAndSendUserAction("approveBuilderFee", { maxFeeRate, builder: builder.toLowerCase() });
  }

  /**
   * Vault deposit/withdraw.
   */
  async vaultTransfer(vaultAddress: string, isDeposit: boolean, usd: number) {
    const action = {
      type: "vaultTransfer",
      vaultAddress,
      isDeposit,
      usd: Math.round(usd * 1e6),
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Delegate/undelegate tokens for staking.
   */
  async tokenDelegate(validator: string, wei: string, isUndelegate = false) {
    // USER-signed staking action (master only). `wei` is a uint64 sent as a JSON number,
    // so it must be an exact safe integer.
    if (!/^\d+$/.test(wei) || !Number.isSafeInteger(Number(wei)) || Number(wei) === 0) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid tokenDelegate wei must be a positive integer ≤ ${Number.MAX_SAFE_INTEGER} (got ${wei})`, { exchange: "hyperliquid" });
    }
    return this._signAndSendUserAction("tokenDelegate", { validator: validator.toLowerCase(), wei: Number(wei), isUndelegate });
  }

  /**
   * Claim staking rewards.
   */
  async claimRewards() {
    return this._sendExchangeAction({ type: "claimRewards" });
  }

  /**
   * List the HIP-3 deployed perp dexes: allPerpMetas (universe per dex; index 0 = native perps)
   * joined by index with perpDexs (name, deployer — live 2026-10-19 both list the dexes in the
   * same order). `assets` holds the LIVE (non-delisted) assets only; `delistedAssets` the rest and
   * `delisted` is true when every asset of the dex is delisted (km, flx, hyna, cash, vntl, abcd on
   * 2026-10-19). Delisted dexes stay listed: accounts may still hold positions there.
   */
  async listDeployedDexes(): Promise<{ name: string; deployer: string; assets: string[]; delistedAssets: string[]; delisted: boolean }[]> {
    const [allMetas, dexList] = await Promise.all([
      this._infoPost({ type: "allPerpMetas" }) as Promise<Record<string, unknown>[]>,
      withCache(`mkt:hl:${this._network}:perpDexs`, HL_MARKET_META_TTL_MS, () =>
        this._infoPost({ type: "perpDexs" }) as Promise<({ name: string; deployer?: string } | null)[]>),
    ]);
    if (!Array.isArray(allMetas)) return [];

    const dexes: { name: string; deployer: string; assets: string[]; delistedAssets: string[]; delisted: boolean }[] = [];
    for (let i = 1; i < allMetas.length; i++) {
      const universe = (allMetas[i]?.universe ?? []) as { name: string; isDelisted?: boolean }[];
      if (universe.length === 0) continue;
      const firstAsset = universe[0].name;
      const colonIdx = firstAsset.indexOf(":");
      const prefix = colonIdx > 0 ? firstAsset.slice(0, colonIdx) : `dex-${i}`;
      const entry = Array.isArray(dexList) ? dexList[i] : null;
      // The deployer is read from the perpDexs entry of the same dex (by index, checked by name).
      const deployer = entry?.name === prefix && typeof entry.deployer === "string" ? entry.deployer : "";
      const live = universe.filter(a => a.isDelisted !== true).map(a => a.name);
      const gone = universe.filter(a => a.isDelisted === true).map(a => a.name);
      dexes.push({ name: prefix, deployer, assets: live, delistedAssets: gone, delisted: live.length === 0 });
    }
    return dexes;
  }

  /**
   * Get referral info.
   */
  async getReferralInfo() {
    this.ensureAddress();
    return this._infoPost({ type: "referral", user: this._address });
  }

  /**
   * Get fee info.
   */
  async getUserFees() {
    this.ensureAddress();
    return this._infoPost({ type: "userFees", user: this._address });
  }

  /**
   * Get sub-accounts.
   */
  async getSubAccounts() {
    this.ensureAddress();
    return this._infoPost({ type: "subAccounts", user: this._address });
  }

  /**
   * Get historical orders (up to 2000).
   */
  async getHistoricalOrders() {
    this.ensureAddress();
    return this._infoPost({ type: "historicalOrders", user: this._address });
  }

  /**
   * Get approved builders.
   */
  async getApprovedBuilders() {
    this.ensureAddress();
    return this._infoPost({ type: "approvedBuilders", user: this._address });
  }

  /**
   * Get vault details.
   */
  async getVaultDetails(vaultAddress: string) {
    this.ensureAddress();
    return this._infoPost({ type: "vaultDetails", vaultAddress, user: this._address });
  }

  /**
   * Get delegations (staking).
   */
  async getDelegations() {
    this.ensureAddress();
    return this._infoPost({ type: "delegations", user: this._address });
  }

  /**
   * POST to /info endpoint (all reads — no SDK). A non-2xx response throws.
   */
  private async _infoPost(body: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      // HTTP 429 = the IP weight budget is spent (docs "Rate limits and user limits": "REST requests
      // share an aggregated weight limit of 1200 per minute") → typed RATE_LIMITED.
      if (res.status === 429) throw rateLimitedError("hyperliquid", res.headers.get("retry-after"), `info ${String(body.type)}: ${text}`);
      // HTTP 422 "Failed to deserialize the JSON body into the target type" = the request is
      // malformed (bad interval / field type, live 2026-10-19): a caller error, not retryable.
      if (res.status === 422) {
        throw new PerpError("INVALID_PARAMS", `Hyperliquid info ${String(body.type)} rejected the request (422): ${text.slice(0, 200)}`, { exchange: "hyperliquid" });
      }
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid info ${String(body.type)} failed (${res.status}): ${text.slice(0, 200)}`, { exchange: "hyperliquid" });
    }
    return res.json();
  }

  /**
   * Public entry point for sending signed exchange actions.
   * Used by HyperliquidSpotAdapter to delegate signing.
   */
  async exchangeAction(action: Record<string, unknown>): Promise<unknown> {
    return this._signAndSendAction(action);
  }

  /** Sign (L1 scheme, active signer tier) and send an exchange action. */
  private async _sendExchangeAction(action: Record<string, unknown>): Promise<unknown> {
    return this._signAndSendAction(action);
  }
}
