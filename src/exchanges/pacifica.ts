import { nonEmptyOrListed, symbolNotFound } from "./unknown-symbol.js";
import { assertCandleInterval, withTapeSkipped, type FundingHistoryRow } from "./interface.js";
import { Keypair } from "@solana/web3.js";
import { PacificaClient, type Network } from "../pacifica/index.js";
import { isPacificaRateLimited } from "../pacifica/rate-limit.js";
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
} from "./interface.js";
import type { ResolvedSlippage } from "./slippage.js";
import type { SolanaSigner } from "../signer/index.js";
import { LocalSolanaSigner } from "../signer/index.js";
import type { AgentMeta } from "../settings.js";
import { isExpired } from "../agent-wallet/expiry.js";
import { isPacificaPerpetual } from "../ws/pacifica-instrument.js";
import { randomUUID } from "crypto";
import { PerpError, extractErrorMessage, isDefiniteOrderFailure, orderNotSent, orderOutcomeUnknown } from "../errors.js";
import { parseFiniteVenueNumber, venueRateField } from "../utils/numeric.js";
import type { MarketInfo } from "../pacifica/types/market.js";
import type { TimeInForce as PacificaTif } from "../pacifica/types/order.js";
import type { IocOutcome } from "./ioc-outcome.js";
import { unsupported, validateLegacyTif } from "./trading-v2.js";
import { floorSize, requireOnTick, subDecimal } from "./precision.js";
import { requireCapabilities } from "./venue.js";
import { PACIFICA_UUID_RE, pacificaVenue } from "./venues/pacifica.js";
import { approvalFromCeiling, builderGateOf, rateToBps, requireFeeBps, type BuilderApproval, type BuilderDecision, type BuilderFeeGate, type BuilderTarget, NO_BUILDER } from "./builder-fee.js";

/**
 * CLI TIF → Pacifica TIF. GTC / IOC / ALO / TOB are native; venue
 * aliases GTT → GTC and GTX → ALO; no TIF → GTC (uniform default). FOK (never
 * emulated) and unknown values → uniform CAPABILITY_UNSUPPORTED.
 */
export function pacificaTif(tif: string | undefined): PacificaTif {
  if (tif === undefined || tif.trim() === "") return "GTC";
  return validateLegacyTif(pacificaVenue, requireCapabilities(pacificaVenue), tif) as PacificaTif;
}

/**
 * Generated client_order_id carrying the order's TIF (like Ondo's
 * `pcli-<p|n>-…`): Pacifica takes a full UUID and never returns the TIF (GET /orders has no
 * tif field), so amend recovers it from the id. Layout: a UUID v4 whose first 6 hex digits are
 * `5ac1f` + TIF code (1 GTC, 2 IOC, 3 ALO, 4 TOB). The native edit keeps the client_order_id.
 */
const PACIFICA_TIF_CODE: Readonly<Record<PacificaTif, string>> = { GTC: "1", IOC: "2", ALO: "3", TOB: "4" };
const PACIFICA_CLOID_RE = /^5ac1f([1-4])[0-9a-f]{2}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function pacificaClientOrderId(tif: PacificaTif): string {
  return `5ac1f${PACIFICA_TIF_CODE[tif]}${randomUUID().slice(6)}`;
}

/**
 * A caller's client order id: Pacifica takes a "Full UUID string" (docs.pacifica.fi rest-api
 * orders/create-limit-order + create-market-order: `client_order_id` | Full UUID string | optional
 * | "Client-defined order ID" | f47ac10b-58cc-4372-a567-0e02b2c3d479). Anything else →
 * INVALID_PARAMS before sending. An id in the reserved generated layout (`5ac1f` + TIF code) must
 * state the order's own TIF `tif` (amend trusts it); null `tif` = the order has none (market).
 */
export function requirePacificaClientOrderId(id: string, tif: PacificaTif | null): string {
  if (!PACIFICA_UUID_RE.test(id)) {
    throw new PerpError("INVALID_PARAMS", `Client order id "${id}" is not valid on Pacifica (a full UUID, e.g. f47ac10b-58cc-4372-a567-0e02b2c3d479)`, {
      exchange: "pacifica", remediation: "Pass a UUID as --client-id, or use --auto-id (a UUID is generated and reported)",
    });
  }
  const encoded = pacificaTifOf(id.toLowerCase());
  if (encoded !== null && encoded !== tif) {
    throw new PerpError("INVALID_PARAMS", `Client order id "${id}" uses the reserved 5ac1f prefix that encodes TIF ${encoded}, but the order is ${tif === null ? "a market order" : tif}`, {
      exchange: "pacifica", remediation: "Use a UUID that does not start with 5ac1f, or --auto-id",
    });
  }
  return id;
}

/** The raw create result with the client_order_id that was SENT attached (read back by LegacyTradingV2.result). */
function withSentClientOrderId(raw: unknown, clientOrderId: string | null): unknown {
  if (clientOrderId === null || raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return { ...(raw as Record<string, unknown>), clientOrderId };
}

/** TIF encoded in a generated client_order_id; null = not generated here (attributes unknown). */
export function pacificaTifOf(clientOrderId: unknown): PacificaTif | null {
  if (typeof clientOrderId !== "string") return null;
  const m = PACIFICA_CLOID_RE.exec(clientOrderId);
  if (m === null) return null;
  const hit = (Object.entries(PACIFICA_TIF_CODE) as Array<[PacificaTif, string]>).find(([, c]) => c === m[1]);
  return hit === undefined ? null : hit[0];
}

/** Pacifica POST error that is a venue answer (HTTP 4xx): the request was refused, nothing changed. */
const PACIFICA_TERMINAL_STATUSES = new Set(["filled", "cancelled", "canceled", "rejected"]);

/**
 * The order's current `/orders/history_by_id` row. The array position is not a documented
 * ordering and is never used: the row with the largest `created_at` wins (a timestamp tie →
 * the single terminal row among them; several terminal rows tied → null). When rows lack a
 * numeric `created_at`, only an explicit terminal row (filled / cancelled / rejected) for
 * that order id is taken, and only when it is the only one. null = not proven (the caller
 * polls again or reports pending). Rows of another order id are ignored.
 */
export function pacificaLatestHistoryRow(rows: unknown, orderId: string): Record<string, unknown> | null {
  if (!Array.isArray(rows)) return null;
  const mine = rows.filter((r): r is Record<string, unknown> =>
    r !== null && typeof r === "object" && (r.order_id === undefined || r.order_id === null || String(r.order_id) === orderId));
  if (mine.length === 0) return null;
  const ts = (r: Record<string, unknown>): number | null => {
    const v = r.created_at;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const terminal = (rs: Record<string, unknown>[]) => rs.filter(r => PACIFICA_TERMINAL_STATUSES.has(String(r.order_status ?? "")));
  if (mine.every(r => ts(r) !== null)) {
    const max = Math.max(...mine.map(r => ts(r) as number));
    const top = mine.filter(r => ts(r) === max);
    if (top.length === 1) return top[0];
    const t = terminal(top);
    if (t.length === 1) return t[0];
    return t.length === 0 ? top[0] : null;
  }
  const t = terminal(mine);
  return t.length === 1 ? t[0] : null;
}

/**
 * Venue-final state of a placed order, read from its `/orders/history_by_id` rows
 * (order_status open / partially_filled / filled / cancelled / rejected — docs
 * rest-api/orders/get-order-history-by-id). Attached to the raw create / edit result as
 * `orderOutcome`. open = resting (or an untriggered stop); a resting / cancelled order with
 * a fill → partiallyFilled.
 */
export interface PacificaOrderOutcome {
  status: "open" | "partiallyFilled" | "filled" | "cancelled" | "rejected";
  final: true;
  /** Venue order_status / event_type of the row the outcome was read from. */
  venueStatus: string;
  eventType: string | null;
  orderId: string;
  filledSize: string;
  /** The row's price / initial_amount as the venue reports them (null = not reported). */
  price: string | null;
  size: string | null;
  source: "history_by_id";
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * The order's outcome from its history_by_id rows (pacificaLatestHistoryRow), or null when not
 * proven: no row for `orderId`, an unknown order_status, or no decimal filled_amount.
 * `terminalOnly` (IOC): an open / partially_filled row is not an outcome (the order never rests).
 * `expect` (price / size sent): a row whose price or initial_amount differ is not this
 * placement / edit yet → null.
 */
export function pacificaOrderOutcomeOf(
  rows: unknown, orderId: string, opts: { terminalOnly?: boolean; expect?: { price: string | null; size: string | null } } = {},
): PacificaOrderOutcome | null {
  const row = pacificaLatestHistoryRow(rows, orderId);
  if (row === null || row.order_id === undefined || row.order_id === null) return null;
  const st = String(row.order_status ?? "");
  const filled = String(row.filled_amount ?? "").trim();
  if (!DECIMAL_RE.test(filled)) return null;
  const price = typeof row.price === "string" || typeof row.price === "number" ? String(row.price) : null;
  const size = typeof row.initial_amount === "string" || typeof row.initial_amount === "number" ? String(row.initial_amount) : null;
  const ex = opts.expect;
  if (ex !== undefined) {
    if (ex.price !== null && (price === null || Number(price) !== Number(ex.price))) return null;
    if (ex.size !== null && (size === null || Number(size) !== Number(ex.size))) return null;
  }
  const hasFill = Number(filled) > 0;
  let status: PacificaOrderOutcome["status"];
  if (st === "open") status = hasFill ? "partiallyFilled" : "open";
  else if (st === "partially_filled") status = "partiallyFilled";
  else if (st === "filled") status = "filled";
  else if (st === "cancelled" || st === "canceled") status = hasFill ? "partiallyFilled" : "cancelled";
  else if (st === "rejected") status = "rejected";
  else return null;
  if (opts.terminalOnly === true && (st === "open" || st === "partially_filled")) return null;
  return {
    status, final: true, venueStatus: st, eventType: typeof row.event_type === "string" ? row.event_type : null,
    orderId, filledSize: filled, price, size, source: "history_by_id",
  };
}

/** order_id of a create / edit response ({ success, data: { order_id } }), or null. */
function pacificaCreatedId(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const data = (r.data !== null && typeof r.data === "object" ? r.data : r) as Record<string, unknown>;
  return typeof data.order_id === "number" || typeof data.order_id === "string" ? String(data.order_id) : null;
}

/**
 * A create-order POST the venue refused with HTTP 422 (Pacifica "Business Logic Error", error-codes
 * doc) is a definite pre-trade rejection — no order was created. Live testnet 2026-10-02:
 * POST /orders/create_market 422 {"success":false,"error":"No reasonable price found for SOL-USDC",
 * "code":0,"error_id":"no_reasonable_price"} (an empty book). → ORDER_REJECTED carrying the venue's
 * error / code / error_id — but ONLY for the documented validation codes
 * (PACIFICA_DEFINITE_CREATE_CODES / _ERROR_IDS). Internal or unknown codes → ORDER_PENDING (the
 * order may exist). Anything else (other status, unparseable body, not a create path, already a
 * PerpError) → `e` unchanged.
 */
export function pacificaCreateRejection(e: unknown, what: string): unknown {
  if (e instanceof PerpError) return e;
  const m = /^POST (\/orders\/(?:stop\/)?create\S*) failed \(422\): ([\s\S]*)$/.exec(extractErrorMessage(e));
  if (m === null) return e;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(m[2]);
    if (parsed === null || typeof parsed !== "object") return e;
    body = parsed as Record<string, unknown>;
  } catch {
    return e;
  }
  if (body.success !== false || typeof body.error !== "string" || body.error === "") return e;
  const details = { exchange: "pacifica", venueCode: body.code ?? null, errorId: typeof body.error_id === "string" ? body.error_id : null, path: m[1] };
  // Business-logic codes per docs.pacifica.fi api error-codes (422): 4 INVALID_TICK_LEVEL,
  // 5 INSUFFICIENT_BALANCE, 7 ORDER_AMOUNT_TOO_LOW, 8 ORDER_AMOUNT_TOO_HIGH. All are definite: no order was created.
  const byCode: Record<number, "INVALID_TICK" | "INSUFFICIENT_BALANCE" | "SIZE_TOO_SMALL" | "SIZE_TOO_LARGE"> = {
    4: "INVALID_TICK", 5: "INSUFFICIENT_BALANCE", 7: "SIZE_TOO_SMALL", 8: "SIZE_TOO_LARGE",
  };
  const mapped = typeof body.code === "number" ? byCode[body.code] : undefined;
  if (mapped !== undefined) return new PerpError(mapped, `Pacifica ${what} refused (no order was created): ${body.error}`, details);
  const errorId = typeof body.error_id === "string" ? body.error_id.toLowerCase() : null;
  const definite = (typeof body.code === "number" && PACIFICA_DEFINITE_CREATE_CODES.has(body.code))
    || (errorId !== null && PACIFICA_DEFINITE_CREATE_ERROR_IDS.has(errorId));
  if (definite) return new PerpError("ORDER_REJECTED", `Pacifica ${what} refused (no order was created): ${body.error}`, details);
  // 0 INTERNAL, 14 DATABASE_ERROR, 26 CHANNEL_CLOSED, 27 RESPONSE_DROPPED, or a code this CLI does
  // not know: the venue did not say the order was refused — it may exist.
  return orderOutcomeUnknown("pacifica", what, new Error(`HTTP 422 code ${String(body.code)}${errorId !== null ? ` (${errorId})` : ""}: ${body.error}`),
    "Do NOT resubmit — the order may have been created. Check: perp account orders -e pacifica / perp account positions -e pacifica");
}

/**
 * 422 business codes that say a create was validated and REFUSED (docs.pacifica.fi api
 * error-codes, read 2026-10-05): 1 ACCOUNT_NOT_FOUND, 3 BOOK_NOT_FOUND, 4 INVALID_TICK_LEVEL,
 * 5 INSUFFICIENT_BALANCE, 7/8 ORDER_AMOUNT_TOO_LOW/HIGH, 10 OPEN_ORDER_LIMIT_REACHED,
 * 13 POSITION_NOT_FOUND, 16–23 stop / order-type / reduce-only validation, 25 NO_REASONABLE_PRICE,
 * 28 IMMEDIATE_LIQUIDATION, 30 PRICE_TOO_FAR_FROM_MARK, 36 DUPLICATE_CLIENT_ORDER_ID,
 * 38 TRADING_DISABLED, 41 OPEN_INTEREST_LIMIT_EXCEEDED, 49 POSITION_TPSL_LIMIT_EXCEEDED,
 * 50 INVALID_BUILDER_CODE, 51 UNSUPPORTED_OPERATION, 52 INVALID_TICK_SIZE,
 * 53 ORDER_BLOCKED_BY_LOAN_POOL_STRESS, 55/56 ASSET_NOT_FOUND/NOT_ACTIVE, 59 INVALID_AMOUNT,
 * 62 INSUFFICIENT_SPOT_BALANCE, 63 MISSING_MARK_PRICE, 106–108 spot restrictions,
 * 119 ORACLE_NOT_AVAILABLE. NOT listed (outcome unknown): 0 INTERNAL, 14 DATABASE_ERROR,
 * 26 CHANNEL_CLOSED, 27 RESPONSE_DROPPED and every undocumented code.
 */
export const PACIFICA_DEFINITE_CREATE_CODES: ReadonlySet<number> = new Set([
  1, 3, 4, 5, 7, 8, 10, 13, 16, 17, 18, 19, 20, 21, 22, 23, 25, 28, 30, 36, 38, 41, 49, 50, 51, 52, 53, 55, 56, 59, 62, 63, 106, 107, 108, 119,
]);

/**
 * `error_id` values that are definite on their own: the venue sends some validation refusals
 * under code 0 with a specific error_id (live testnet 2026-10-02: an empty book →
 * {"code":0,"error_id":"no_reasonable_price"}).
 * Live mainnet 2026-10-05: a reduce-only limit with no position →
 * {"code":0,"error_id":"no_position_for_reduce_only_order"} ("No position found for reduce-only order").
 */
export const PACIFICA_DEFINITE_CREATE_ERROR_IDS: ReadonlySet<string> = new Set(["no_reasonable_price", "no_position_for_reduce_only_order"]);

/**
 * Pacifica's documented USDC withdrawal minimum (docs.pacifica.fi "Deposits & Withdrawals":
 * "Minimum withdrawal: $1. Fees: $1 per withdrawal (gas)"). Not the whole rule: testnet refused
 * exactly 1 USDC on 2026-10-02 with 422 code 29 WITHDRAW_AMOUNT_TOO_LOW, so amounts at or just
 * above it are left to the venue (pacificaWithdrawRejection maps the refusal).
 */
export const PACIFICA_WITHDRAW_MIN_USDC = "1";

/**
 * A withdraw POST the venue refused with HTTP 422 (Business Logic Error — nothing was withdrawn):
 * code 29 WITHDRAW_AMOUNT_TOO_LOW → INVALID_PARAMS, code 9 OVER_WITHDRAWAL → INSUFFICIENT_BALANCE,
 * any other explicit refusal → ACTION_REJECTED (codes: docs.pacifica.fi api error-codes). Anything
 * else (other status, unparseable body, already a PerpError) → `e` unchanged (outcome unknown).
 */
export function pacificaWithdrawRejection(e: unknown, amount: string): unknown {
  if (e instanceof PerpError) return e;
  const m = /^POST \/account\/withdraw failed \(422\): ([\s\S]*)$/.exec(extractErrorMessage(e));
  if (m === null) return e;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(m[1]);
    if (parsed === null || typeof parsed !== "object") return e;
    body = parsed as Record<string, unknown>;
  } catch {
    return e;
  }
  if (body.success !== false || typeof body.error !== "string" || body.error === "") return e;
  const details = { exchange: "pacifica", venueCode: body.code ?? null, errorId: typeof body.error_id === "string" ? body.error_id : null };
  if (body.code === 29) {
    return new PerpError("INVALID_PARAMS", `Pacifica withdraw ${amount} USDC refused (nothing was withdrawn): ${body.error}`, {
      ...details,
      remediation: `Withdraw a larger amount — Pacifica documents a ${PACIFICA_WITHDRAW_MIN_USDC} USDC minimum plus a $1 fee per withdrawal, and refused ${amount} USDC`,
    });
  }
  if (body.code === 9) {
    return new PerpError("INSUFFICIENT_BALANCE", `Pacifica withdraw ${amount} USDC refused (nothing was withdrawn): ${body.error}`, {
      ...details, remediation: "Check available_to_withdraw: perp -e pacifica portfolio",
    });
  }
  return new PerpError("ACTION_REJECTED", `Pacifica withdraw ${amount} USDC refused (nothing was withdrawn): ${body.error}`, details);
}

/** A POST the venue refused with HTTP 4xx — incl. RATE_LIMITED (429 / pre-send throttle, nothing sent). */
export function pacificaRefused(e: unknown): boolean {
  if (isPacificaRateLimited(e)) return true;
  return !(e instanceof PerpError) && /^POST \S+ failed \(4\d\d\)/.test(extractErrorMessage(e));
}

/** A cancel the venue refused (HTTP 4xx), settled from the order's own history_by_id rows. */
export type PacificaCancelRefusal = { kind: "failed"; error: string } | { kind: "pending"; reason: string };

/**
 * What a refused cancel (POST /orders/cancel 4xx, e.g. 422 {"error":"Failed to cancel order","code":5}
 * for an already-filled market order — live testnet 2026-10-02) means for the order, from its
 * history_by_id read (`history` = the read's data, or the read's error):
 * - terminal row (filled / cancelled / rejected) → failed: nothing was cancelled by this request;
 * - GET 404 "Order history not found" → failed: the venue has no such order;
 * - a still-open row, no row, or any other read failure → pending (not proven either way).
 * Never "cancelled".
 */
export function pacificaCancelRefusalOf(orderId: string, refusal: string, history: { data: unknown } | { error: unknown }): PacificaCancelRefusal {
  if ("error" in history) {
    const msg = extractErrorMessage(history.error);
    if (/^GET \S*history_by_id failed \(404\)/.test(msg)) {
      return { kind: "failed", error: `order ${orderId} does not exist on Pacifica (history_by_id 404); nothing was cancelled — venue refusal: ${refusal}` };
    }
    return { kind: "pending", reason: `the venue refused the cancel (${refusal}) and the order's state could not be read (${msg})` };
  }
  const out = pacificaOrderOutcomeOf(history.data, orderId);
  if (out === null) return { kind: "pending", reason: `the venue refused the cancel (${refusal}) and history_by_id shows no settled row for order ${orderId}` };
  if (out.venueStatus === "open" || out.venueStatus === "partially_filled") {
    return { kind: "pending", reason: `the venue refused the cancel (${refusal}) but order ${orderId} is still ${out.venueStatus} (filled ${out.filledSize})` };
  }
  return { kind: "failed", error: `order ${orderId} is already ${out.venueStatus} (filled ${out.filledSize}, history_by_id); nothing was cancelled — venue refusal: ${refusal}` };
}

/** `{ success: false }` / `{ error }` body = explicit venue refusal. */
function pacificaBodyError(r: unknown): string | null {
  if (r === null || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (o.success === false || (typeof o.error === "string" && o.error !== "")) return String(o.error ?? "request rejected");
  return null;
}

/** Result of a TIF-preserving amend (see PacificaAdapter.amendKeepingTif). */
export interface PacificaAmendResult {
  method: "nativeAmend" | "cancelReplace";
  /** TIF of the amended / replacement order. */
  tif: PacificaTif;
  /** Order id after the amend: the edited order (native) or the replacement (null = no replacement placed). */
  orderId: string | null;
  clientOrderId: string | null;
  filledBeforeCancel: string | null;
  replacedSize: string | null;
  /** The original order's terminal history row said "filled" (it filled completely before the cancel). */
  filledCompletely: boolean;
  /** Venue-final state of the edited / replacement order (history_by_id); null = unresolved or none placed. */
  outcome: PacificaOrderOutcome | null;
  notes: string[];
  venueRaw: unknown;
}

/** Terminal history_by_id row of a market order, attached to marketOrder's raw result (iocOutcomeOf). */
interface PacificaFillReport {
  orderId: string;
  orderStatus: string;
  filledAmount: string;
}

/** GET /trades answers the last 20 fills (40 taker + maker rows); no limit or cursor. */
export const PACIFICA_TRADES_CAP = 20;
/** GET /funding_rate/history `limit` maximum per request (docs; live 4001 → 4000). */
export const PACIFICA_FUNDING_PAGE = 4000;
/** GET /kline: "Max range: 4000 candles" per request (HTTP 400 beyond, live 2026-10-19). */
export const PACIFICA_KLINE_MAX_BARS = 4000;
/** Requests one funding / kline read may send (the venue meters reads by credits). */
export const PACIFICA_MAX_PAGES = 10;
/**
 * GET /kline intervals (venue error text, live 2026-10-19: "Must be one of 1m, 3m, 5m, 15m, 30m,
 * 1h, 2h, 4h, 8h, 12h, 1d, 1w, 1M"; each answered 200 with rows labelled `i` = the interval).
 * The ms length sizes the 4000-bar request windows (1M: 31 days, the longest month).
 */
export const PACIFICA_KLINE_INTERVALS: Readonly<Record<string, number>> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000,
  "1d": 86_400_000, "1w": 604_800_000, "1M": 2_678_400_000,
};

/** /info rows must carry instrument_type — a row without it cannot be classified perp vs spot. */
function requireInstrumentType(rows: MarketInfo[]): MarketInfo[] {
  for (const m of rows) {
    if (typeof m.instrument_type !== "string") {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /info row ${String(m.symbol)} has no instrument_type`, { exchange: "pacifica" });
    }
  }
  return rows;
}

/** Perp markets of /info: instrument_type "perpetual" only (spot rows such as SOL-USDC, or any other type, excluded). */
function perpInfoRows(rows: MarketInfo[]): MarketInfo[] {
  return requireInstrumentType(rows).filter(isPacificaPerpetual);
}

/** Wire symbols of /info markets that are not perps (spot, any other instrument_type). */
function nonPerpInfoSymbols(rows: MarketInfo[]): Set<string> {
  return new Set(requireInstrumentType(rows).filter((m) => !isPacificaPerpetual(m)).map((m) => m.symbol));
}

/** Pacifica order_type of a stop / TP / SL order (stop_market, stop_limit, take_profit_*, stop_loss_*). */
export function isPacificaStopType(type: string): boolean {
  return /^(stop|take_profit|stop_loss)_/.test(type);
}

/** Fill sides of GET /trades/history (position effect) plus the order sides bid / ask. */
const PACIFICA_FILL_BUY_SIDES: ReadonlySet<string> = new Set(["open_long", "close_short", "bid"]);
const PACIFICA_FILL_SELL_SIDES: ReadonlySet<string> = new Set(["open_short", "close_long", "ask"]);

/**
 * Trade direction of a Pacifica fill `side` (position effect): open_long / close_short buy,
 * open_short / close_long sell; bid / ask for rows that carry an order side. Anything else →
 * EXCHANGE_ERROR (never a guessed direction). Used by the public tape and the account fills.
 */
export function pacificaFillSide(side: string, endpoint: string): "buy" | "sell" {
  if (PACIFICA_FILL_BUY_SIDES.has(side)) return "buy";
  if (PACIFICA_FILL_SELL_SIDES.has(side)) return "sell";
  throw new PerpError("EXCHANGE_ERROR", `Pacifica ${endpoint} row with unknown side "${side}"`, { exchange: "pacifica" });
}

/** `created_at` (ms) of a Pacifica history row; non-numeric → EXCHANGE_ERROR (never NaN). */
function pacificaTime(row: Record<string, unknown>, endpoint: string): number {
  const t = Number(pacificaField(row, "created_at", endpoint));
  if (!Number.isFinite(t)) throw new PerpError("EXCHANGE_ERROR", `Pacifica ${endpoint} row with a non-numeric created_at`, { exchange: "pacifica" });
  return t;
}

/** A required field of a Pacifica history row as a string; missing / empty → EXCHANGE_ERROR. */
function pacificaField(row: Record<string, unknown>, key: string, endpoint: string): string {
  const v = row[key];
  if ((typeof v === "string" && v !== "") || (typeof v === "number" && Number.isFinite(v))) return String(v);
  throw new PerpError("EXCHANGE_ERROR", `Pacifica ${endpoint} row without a readable ${key}: ${JSON.stringify(row).slice(0, 160)}`, { exchange: "pacifica" });
}

export class PacificaAdapter implements ExchangeAdapter {
  readonly name = "pacifica";
  readonly chain = "solana";
  readonly aliases = ["pac"] as const;
  private client: PacificaClient;
  /** Tier 3: PK direct (constructor-supplied keypair). */
  private _solanaSigner: SolanaSigner;
  /** Tier 2: OWS master signer (set via setSigner). */
  private _masterSigner?: SolanaSigner;
  /** Tier 1: agent OWS signer (Phase 2c). */
  private _agentSigner?: SolanaSigner;
  /** Tier 1 metadata. */
  private _agentMeta?: AgentMeta;
  /** --no-agent bypass flag. */
  private _useNoAgent = false;
  /** True when adapter was constructed without a real PK (read-only). */
  private _hasRealKey: boolean;
  /** Public Solana base58 of the active signer (`_resolveSigner().address`). */
  private account: string;
  /** Bound `signMessage` for the active signer (Phase 2c routes through `_resolveSigner`). */
  private signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
  private _marketsCache: ExchangeMarketInfo[] | null = null;
  private _marketsCacheTime = 0;
  private _infoCache: { rows: MarketInfo[]; at: number } | null = null;
  private static readonly CACHE_TTL = 30_000;
  /** Venue network — part of every account cache key (the same key exists on mainnet and testnet). */
  private _network: Network;

  /**
   * Builder-fee gate (settings builder.pacifica + confirmed approval); null = not configured.
   * Set by createPacifica (venues/create-helpers.ts) — the adapter never reads settings.
   */
  builderFee: BuilderFeeGate | null = null;

  constructor(keypair: Keypair, network: Network = "mainnet", hasRealKey = true) {
    this._network = network;
    this._solanaSigner = new LocalSolanaSigner(keypair);
    this._hasRealKey = hasRealKey;
    this.account = this._solanaSigner.getPublicKeyBase58();
    this.client = new PacificaClient({ network });
    // Hot-path methods always go through `_resolveSigner()` so the bound
    // `signMessage` reflects the highest-priority active tier.
    this.signMessage = (msg) => this._resolveSigner().signer.signMessage(msg);
  }

  private ensureSigner(): void {
    // Resolves across all tiers; throws PerpError if none available.
    const r = this._resolveSigner();
    // Sync the client's agent_wallet for the active tier. Agent-signed requests
    // (account = master, signature = agent key) MUST carry agent_wallet, or
    // Pacifica verifies the signature against the master key and rejects every
    // order. Master/PK signers clear it so they self-sign as before.
    this.client.setRequestAgentWallet(r.tier === "agent" ? r.address : undefined);
  }

  /** Resolve the active signer tier and sync agent_wallet on the client (used by PacificaSpotAdapter). */
  prepareSigning(): void {
    this.ensureSigner();
  }

  /**
   * Inject an external Solana signer (Tier 2 — OWS master).
   * Backward-compatible: existing callers (e.g. `perp -e pacifica --ows ...`
   * in `_initWithOws`) continue to work; the master signer is what
   * `_resolveSigner()` falls back to when no agent is registered.
   */
  setSigner(signer: SolanaSigner): void {
    this._masterSigner = signer;
    this._solanaSigner = signer;
    this.account = signer.getPublicKeyBase58();
    this._hasRealKey = true;
    this.signMessage = (msg) => this._resolveSigner().signer.signMessage(msg);
  }

  /** Tier 1: inject agent OWS Solana signer (Phase 2c). */
  setAgentSigner(meta: AgentMeta, signer: SolanaSigner): void {
    this._agentMeta = meta;
    this._agentSigner = signer;
    // The `account` field is the master Solana address (used in REST envelopes
    // as the `account` key) — agent path puts the master in `account` and the
    // agent in `agent_wallet`. Capture the master Solana address from the
    // AgentMeta so REST flows can reference it.
    if (meta.userSolanaAddress) {
      this.account = meta.userSolanaAddress;
    }
  }

  /** Bypass Tier 1 (agent) — used for `--no-agent` flag. */
  setNoAgent(noAgent: boolean): void {
    this._useNoAgent = noAgent;
  }

  /** True only when ALL THREE tiers are unconfigured. */
  get isReadOnly(): boolean {
    return !this._agentSigner && !this._masterSigner && !this._hasRealKey;
  }

  /** Which signer tier is currently active (for debug/diagnostics). */
  get activeSignerTier(): "agent" | "master" | "pk" | null {
    try {
      return this._resolveSigner().tier;
    } catch {
      return null;
    }
  }

  /** Resolve the active signer across three tiers. Mirrors AsterAdapter._resolveSigner. */
  private _resolveSigner(): { tier: "agent" | "master" | "pk"; signer: SolanaSigner; address: string } {
    // Tier 1: agent (when registered, --no-agent NOT set). An expired agent record is an
    // explicit error — never a silent switch to the master signer; --no-agent is the opt-in.
    if (!this._useNoAgent && this._agentSigner && this._agentMeta) {
      if (isExpired(this._agentMeta)) {
        throw new PerpError("AGENT_EXPIRED", `Pacifica agent wallet ${this._agentMeta.agentName} expired at ${this._agentMeta.expiresAt}`, {
          exchange: "pacifica",
          remediation: "Re-approve the agent: perp wallet agent approve pacifica — or sign with the master wallet for this command: --no-agent",
        });
      }
      return { tier: "agent", signer: this._agentSigner, address: this._agentSigner.getPublicKeyBase58() };
    }

    // Tier 2: OWS master
    if (this._masterSigner) {
      return { tier: "master", signer: this._masterSigner, address: this._masterSigner.getPublicKeyBase58() };
    }

    // Tier 3: PK direct
    if (this._hasRealKey) {
      // Guard: legacy test fixtures (e.g. bugfix-v042.test.ts) construct adapters
      // via `Object.create(PacificaAdapter.prototype)` and only set `_hasRealKey = true`
      // — `_solanaSigner` is undefined in that case. Fall back to the cached
      // `account` field when available.
      const address = this._solanaSigner
        ? this._solanaSigner.getPublicKeyBase58()
        : this.account;
      return { tier: "pk", signer: this._solanaSigner, address };
    }

    // No signer at any tier
    throw new PerpError(
      "NO_SIGNER_AVAILABLE",
      "No signing path configured for Pacifica",
      {
        remediation: "Run one of: (a) perp wallet agent approve pacifica --master <wallet>; (b) perp wallet generate && perp -e pacifica --ows <wallet>; (c) export PACIFICA_PRIVATE_KEY=...",
      },
    );
  }

  /**
   * The owner (master) Solana signer for on-chain transactions (deposit, test-token
   * mint) — never the agent, which cannot move funds.
   */
  masterSolanaSigner(): SolanaSigner {
    if (this._masterSigner) return this._masterSigner;
    if (this._hasRealKey && this._solanaSigner) return this._solanaSigner;
    throw new PerpError("NO_SIGNER_AVAILABLE", "No Pacifica master wallet on this computer for an on-chain transaction", {
      remediation: "Select the master wallet (--ows <wallet> or perp wallet use <wallet>), or do it on the Pacifica website",
    });
  }

  /**
   * The active signer for an account request whose body the caller builds itself (Print / vault
   * writes): `account` (master address) and `agentWallet` (agent pubkey, or null when the master
   * signs). Resolving it signs nothing. NO_SIGNER_AVAILABLE / AGENT_EXPIRED as `_resolveSigner`.
   */
  signingIdentity(): { tier: "agent" | "master" | "pk"; account: string; agentWallet: string | null; signMessage: (msg: Uint8Array) => Promise<Uint8Array> } {
    const r = this._resolveSigner();
    return { tier: r.tier, account: this.account, agentWallet: r.tier === "agent" ? r.address : null, signMessage: (msg) => r.signer.signMessage(msg) };
  }

  /** Access the underlying Keypair (only available with LocalSolanaSigner). */
  get keypair(): Keypair {
    if (this._solanaSigner instanceof LocalSolanaSigner) {
      return (this._solanaSigner as unknown as { _keypair: Keypair })._keypair;
    }
    throw new Error("keypair not available with external signer");
  }

  private async _getPrices() {
    const { withCache, TTL_ACCOUNT } = await import("../cache.js");
    return withCache(`acct:pac:${this._network}:prices:${this.account}`, TTL_ACCOUNT, () =>
      this.client.getPrices(),
    );
  }

  private async _getPositions() {
    const { withCache, TTL_ACCOUNT } = await import("../cache.js");
    return withCache(`acct:pac:${this._network}:positions:${this.account}`, TTL_ACCOUNT, () =>
      this.client.getPositions(this.account),
    );
  }

  get publicKey(): string {
    return this.account;
  }

  /** Builder decision for the next perp order (cached approval read; never throws). */
  async builderDecision(): Promise<BuilderDecision> {
    const gate = builderGateOf(this);
    return gate === null ? NO_BUILDER : gate.decide({ hip3: false });
  }

  /** builder_code to send with the next perp order, or null (not configured / not approved). */
  private async builderCode(): Promise<string | null> {
    const d = await this.builderDecision();
    return d.applied === null ? null : d.applied.identity;
  }

  /**
   * Approval of `target.identity` on this account (GET /account/builder_codes/approvals).
   * Pacifica's builder sets its own rate up to the approved max_fee_rate, so the code is
   * attached only while that max ≤ target.feeBps (the user's consent); a higher approved max
   * is "aboveConsent" (not attached, real max reported).
   */
  async builderApprovalOf(target: BuilderTarget): Promise<BuilderApproval> {
    const rows = await this.client.getBuilderApprovals(this.account);
    if (!Array.isArray(rows)) {
      return { status: "unknown", reason: `unexpected approvals response ${JSON.stringify(rows).slice(0, 120)}` };
    }
    const row = rows.find(r => r !== null && typeof r === "object" && (r as Record<string, unknown>).builder_code === target.identity) as Record<string, unknown> | undefined;
    if (row === undefined) return approvalFromCeiling(null, requireFeeBps(target));
    const max = rateToBps(row.max_fee_rate);
    if (max === null) return { status: "unknown", reason: `unreadable max_fee_rate ${JSON.stringify(row.max_fee_rate)}` };
    return approvalFromCeiling(max, requireFeeBps(target));
  }

  get sdk(): PacificaClient {
    return this.client;
  }

  get signer(): (msg: Uint8Array) => Promise<Uint8Array> {
    return this.signMessage;
  }

  /** GET /info rows (every instrument type), one CACHE_TTL cache for symbol resolution and getMarkets. */
  private async infoRows(): Promise<MarketInfo[]> {
    if (!this._infoCache || Date.now() - this._infoCache.at >= PacificaAdapter.CACHE_TTL) {
      this._infoCache = { rows: requireInstrumentType(await this.client.getInfo()), at: Date.now() };
    }
    return this._infoCache.rows;
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    if (this._marketsCache && Date.now() - this._marketsCacheTime < PacificaAdapter.CACHE_TTL) return this._marketsCache;
    const [markets, prices] = await Promise.all([
      this.infoRows(),
      this._getPrices(),
    ]);
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));
    // /info also lists spot markets (e.g. SOL-USDC); those are not perps.
    const result = perpInfoRows(markets).map((m) => {
      const p = priceMap.get(m.symbol);
      // Derive sizeDecimals from lot_size (e.g. "0.001" → 3, "1" → 0)
      const lotSize = m.lot_size != null ? parseFloat(m.lot_size) : null;
      const validLot = lotSize !== null && Number.isFinite(lotSize) && lotSize > 0;
      const sizeDecimals = validLot ? Math.max(0, -Math.floor(Math.log10(lotSize))) : null;
      return {
        symbol: m.symbol,
        markPrice: p?.mark ?? "-",
        indexPrice: p?.oracle ?? null,
        fundingRate: m.next_funding_rate ?? m.funding_rate,
        // /info next_funding_rate = the rate expected at the next settlement; funding_rate = the last.
        fundingRateKind: m.next_funding_rate != null ? "predicted" as const : m.funding_rate != null ? "lastSettled" as const : null,
        volume24h: p?.volume_24h ?? null,
        openInterest: p?.open_interest ?? null,
        maxLeverage: m.max_leverage,
        sizeDecimals,
        stepSize: validLot ? m.lot_size : null,
        // Uniform hourly funding (venue fundingRateBasis perHours 1); no margin tiers published.
        fundingHours: 1,
        marginTiers: null,
      };
    });
    this._marketsCache = result; this._marketsCacheTime = Date.now(); return result;
  }

  /**
   * The venue's own spelling of a perp market typed by the user. Pacifica's API is
   * case-sensitive (kBONK / kPEPE / kSHIB: `KPEPE` answers `200 []` on /trades, /kline and
   * /funding_rate/history and 400 "Book not found" on /book — live 2026-10-19), and the CLI
   * upper-cases the argument. Matched against /info exactly first, then case-insensitively
   * (a "-PERP" display suffix ignored), as `market info` does. A listed non-perp (spot SOL-USDC)
   * is refused before any request: this adapter serves perps only (isPacificaPerpetual).
   */
  async wireSymbol(symbol: string): Promise<string> {
    const rows = await this.infoRows();
    const want = symbol.replace(/-PERP$/i, "");
    const exact = rows.filter((m) => m.symbol === want);
    const matches = exact.length > 0 ? exact : rows.filter((m) => m.symbol.toUpperCase() === want.toUpperCase());
    if (matches.length === 0) throw symbolNotFound("pacifica", symbol);
    if (matches.length > 1) {
      throw new PerpError("INVALID_PARAMS", `Pacifica lists several markets matching ${symbol} (${matches.map((m) => m.symbol).join(", ")}); type the exact symbol`, { exchange: "pacifica" });
    }
    const m = matches[0];
    if (!isPacificaPerpetual(m)) {
      throw symbolNotFound("pacifica", symbol, `Pacifica ${m.symbol} is a ${m.instrument_type} market, not a perp — the perp market data reads serve perpetuals only`);
    }
    return m.symbol;
  }

  /**
   * wireSymbol for an order entry point (market / limit / stop / edit): a resolution failure is
   * a definite "not sent" (orderNotSent re-types a read error), never a retryable code.
   */
  private async orderSymbol(symbol: string, what: string): Promise<string> {
    try {
      return await this.wireSymbol(symbol);
    } catch (e) {
      throw orderNotSent("pacifica", `${what} ${symbol}`, e);
    }
  }

  /**
   * The venue's spelling for a cancel / TP-SL on an existing order or position: resolved as in
   * wireSymbol when /info lists it (any instrument type, case-insensitive); otherwise — not listed
   * (a delisted market) or /info unreadable — sent as typed: a cancel must still reach the venue,
   * whose own answer is final.
   */
  private async listedSymbol(symbol: string): Promise<string> {
    let rows: MarketInfo[];
    try {
      rows = await this.infoRows();
    } catch {
      return symbol;
    }
    const want = symbol.replace(/-PERP$/i, "");
    const exact = rows.filter((m) => m.symbol === want);
    const hits = exact.length > 0 ? exact : rows.filter((m) => m.symbol.toUpperCase() === want.toUpperCase());
    return hits.length === 1 ? hits[0].symbol : symbol;
  }

  async getOrderbook(symbol: string) {
    symbol = await this.wireSymbol(symbol);
    const book = await this.client.getBook(symbol).catch((e: unknown) => {
      // GET /book for an unlisted symbol: HTTP 400 {"error":"Book not found: NOPE"} (live 2026-10-14).
      if (e instanceof Error && /^GET \/book failed \(400\):.*Book not found/.test(e.message)) throw symbolNotFound("pacifica", symbol);
      throw e;
    });
    return {
      bids: book.l[0].map((e) => [e.p, e.a] as [string, string]),
      asks: book.l[1].map((e) => [e.p, e.a] as [string, string]),
    };
  }

  async getBalance(): Promise<ExchangeBalance> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const [info, positions, prices] = await Promise.all([
      this.client.getAccount(this.account),
      this._getPositions(),
      this._getPrices(),
    ]);
    const raw = info as unknown as Record<string, unknown>;
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));

    // API often returns unrealized_pnl=0 — compute from price delta when needed
    let totalPnl = 0;
    for (const p of positions) {
      let upnl = parseFiniteVenueNumber(p.unrealized_pnl, "position.unrealized_pnl", "pacifica");
      const amount = parseFiniteVenueNumber(p.amount, "position.amount", "pacifica");
      if (upnl === 0 && amount > 0) {
        const mark = parseFiniteVenueNumber(
          priceMap.get(p.symbol)?.mark ?? p.mark_price,
          "position.mark", "pacifica",
        );
        const entry = parseFiniteVenueNumber(p.entry_price, "position.entry_price", "pacifica");
        const dir = p.side === "bid" ? 1 : -1;
        if (mark > 0 && entry > 0) upnl = (mark - entry) * amount * dir;
      }
      totalPnl += upnl;
    }

    // Unified margin: a negative USDC `balance` is a loan; `pending_interest` is accrued,
    // unpaid loan interest (docs get-account-info). Surfaced, not folded into equity.
    const usdcBalance = info.balance;
    if (typeof usdcBalance !== "string") {
      throw new PerpError("EXCHANGE_ERROR", "Pacifica account info has no USDC `balance`", { exchange: "pacifica", venueRaw: raw });
    }
    const balance: ExchangeBalance & { usdcBalance: string; borrowedUsdc: string; pendingInterest: string | null; availableToWithdraw: string } = {
      equity: info.account_equity,
      available: info.available_to_spend,
      marginUsed: String(raw.total_margin_used ?? raw.margin_used ?? "0"),
      unrealizedPnl: totalPnl.toFixed(4),
      usdcBalance,
      borrowedUsdc: usdcBalance.startsWith("-") ? usdcBalance.slice(1) : "0",
      pendingInterest: typeof info.pending_interest === "string" ? info.pending_interest : null,
      availableToWithdraw: info.available_to_withdraw,
    };
    return balance;
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const [positions, prices] = await Promise.all([
      this._getPositions(),
      this._getPrices(),
    ]);
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));

    const mapped = positions.map((p) => {
      const mark = priceMap.get(p.symbol)?.mark ?? p.mark_price ?? "0";
      const side = p.side === "bid" ? "long" : "short";
      const size = parseFiniteVenueNumber(p.amount, "position.amount", "pacifica");
      const entry = parseFiniteVenueNumber(p.entry_price, "position.entry_price", "pacifica");
      const markNum = parseFiniteVenueNumber(mark, "position.mark", "pacifica");

      // API often returns unrealized_pnl=0 — compute from price delta when needed
      let upnl = parseFiniteVenueNumber(p.unrealized_pnl, "position.unrealized_pnl", "pacifica");
      if (upnl === 0 && size > 0 && entry > 0 && markNum > 0) {
        const dir = side === "long" ? 1 : -1;
        upnl = (markNum - entry) * size * dir;
      }

      // Leverage, in order: (1) the API's own `leverage` when present; (2) for an ISOLATED
      // position, entry-notional / margin — the docs define `margin` as "Amount of margin
      // allocated to an isolated position (only shown when isolated)", so a cross position
      // reports "0" here; (3)/(4) resolved below from GET /account/settings, then the market max.
      const marginNum = parseFiniteVenueNumber(p.margin ?? p.margin_used, "position.margin", "pacifica", { defaultValue: 0 });
      const apiLev = typeof p.leverage === "number" && p.leverage > 0 ? p.leverage : 0;
      const entryNotional = size * entry;
      const derivedLev = marginNum > 0 && entryNotional > 0 ? Math.round(entryNotional / marginNum) : 0;

      return {
        symbol: p.symbol,
        side: side as "long" | "short",
        size: String(p.amount),
        entryPrice: String(p.entry_price),
        markPrice: mark,
        liquidationPrice: p.liquidation_price != null ? String(p.liquidation_price) : null,
        unrealizedPnl: upnl.toFixed(4),
        // 0 = unresolved; resolved from the account settings / market max below.
        leverage: apiLev > 0 ? apiLev : derivedLev,
      };
    });

    // Unresolved (cross) positions: (3) the symbol's entry in GET /account/settings
    // `margin_settings` — "Current leverage set by the user"; (4) no entry = the symbol is at its
    // default, and the docs (get-account-settings) say "all markets have margin settings default
    // to cross margin and leverage default to max ... will return blank" → the market's max
    // leverage. Neither known → EXCHANGE_ERROR (never a fabricated value). Both reads happen ONLY
    // when something is unresolved; a failure of either propagates.
    if (mapped.some((m) => m.leverage <= 0)) {
      const settings = await this.client.getAccountSettings(this.account) as { margin_settings?: unknown } | null;
      if (settings === null || typeof settings !== "object" || !Array.isArray(settings.margin_settings)) {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica /account/settings returned no margin_settings list (got ${JSON.stringify(settings).slice(0, 160)})`, { exchange: "pacifica" });
      }
      const setLev = new Map<string, number>();
      for (const s of settings.margin_settings as Array<{ symbol?: unknown; leverage?: unknown }>) {
        if (typeof s?.symbol !== "string" || typeof s.leverage !== "number" || !(s.leverage > 0)) {
          throw new PerpError("EXCHANGE_ERROR", `Pacifica /account/settings: malformed margin_settings entry ${JSON.stringify(s)}`, { exchange: "pacifica" });
        }
        setLev.set(s.symbol, s.leverage);
      }
      let maxLevMap: Map<string, number | null> | null = null;
      for (const m of mapped) {
        if (m.leverage > 0) continue;
        const configured = setLev.get(m.symbol);
        if (configured !== undefined) { m.leverage = configured; continue; }
        if (maxLevMap === null) maxLevMap = new Map((await this.getMarkets()).map((mk) => [mk.symbol, mk.maxLeverage]));
        const max = maxLevMap.get(m.symbol);
        if (typeof max !== "number" || !(max > 0)) {
          throw new PerpError("EXCHANGE_ERROR", `Pacifica ${m.symbol}: the position's leverage cannot be determined (no leverage on the position, no /account/settings entry, and no max leverage for the market)`, {
            exchange: "pacifica", remediation: "Check the market: perp -e pacifica market info " + m.symbol,
          });
        }
        m.leverage = max;
      }
    }
    return mapped;
  }

  /**
   * The leverage this account applies to `symbol`: its GET /account/settings `margin_settings`
   * entry ("Current leverage set by the user"); no entry → the market's max leverage (docs
   * get-account-settings: "leverage default to max ... will return blank"). Unreadable → EXCHANGE_ERROR.
   */
  async marketLeverage(symbol: string): Promise<number> {
    const sym = symbol.toUpperCase();
    const settings = await this.client.getAccountSettings(this.account) as { margin_settings?: unknown } | null;
    if (settings === null || typeof settings !== "object" || !Array.isArray(settings.margin_settings)) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /account/settings returned no margin_settings list (got ${JSON.stringify(settings).slice(0, 160)})`, { exchange: "pacifica" });
    }
    const entry = (settings.margin_settings as Array<{ symbol?: unknown; leverage?: unknown }>).find(e => typeof e?.symbol === "string" && e.symbol.toUpperCase() === sym);
    if (entry !== undefined) {
      if (typeof entry.leverage !== "number" || !(entry.leverage >= 1)) {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica /account/settings: malformed margin_settings entry ${JSON.stringify(entry)}`, { exchange: "pacifica" });
      }
      return entry.leverage;
    }
    const max = (await this.getMarkets()).find(m => m.symbol.toUpperCase() === sym)?.maxLeverage;
    if (typeof max !== "number" || !(max >= 1)) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica ${sym}: no /account/settings entry and no max leverage for the market`, { exchange: "pacifica" });
    }
    return max;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    // GET /orders covers every market; spot orders (SOL-USDC) belong to the spot adapter.
    const [orders, info] = await Promise.all([this.client.getOrders(this.account), this.client.getInfo()]);
    const nonPerp = nonPerpInfoSymbols(info);
    return orders.filter((o) => !nonPerp.has(String((o as unknown as Record<string, unknown>).symbol))).map((o) => {
      const raw = o as unknown as Record<string, unknown>;
      return {
        orderId: String(raw.order_id),
        symbol: String(raw.symbol),
        side: raw.side === "bid" ? ("buy" as const) : ("sell" as const),
        price: String(raw.price),
        size: String(raw.initial_amount ?? raw.amount ?? ""),
        filled: String(raw.filled_amount ?? raw.filled ?? "0"),
        status: String(raw.order_status ?? "open"),
        type: String(raw.order_type ?? ""),
        // Stop / TP / SL orders: stop_price is the trigger (a position-level TP/SL lists price 0, amount 0).
        triggerPrice: raw.stop_price !== null && raw.stop_price !== undefined && Number(raw.stop_price) > 0 ? String(raw.stop_price) : null,
      };
    });
  }

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderId?: string }) {
    this.ensureSigner();
    symbol = await this.orderSymbol(symbol, `market ${side} ${size}`);
    // A caller's client order id is sent as client_order_id (validated UUID); none → none sent.
    const cloid = opts.clientOrderId === undefined ? null : requirePacificaClientOrderId(opts.clientOrderId, null);
    const created = await this.client.createMarketOrder(
      {
        symbol, amount: size, side: side === "buy" ? "bid" : "ask", reduce_only: opts.reduceOnly, slippage_percent: String(opts.slippage.bps / 100),
        ...(cloid !== null ? { client_order_id: cloid } : {}),
      },
      this.account,
      this.signMessage,
      await this.builderCode(),
    ).catch((e: unknown) => { throw pacificaCreateRejection(e, `market ${side} ${size} ${symbol}`); });
    const result = withSentClientOrderId(created, cloid);

    // Validate response
    const r = result as Record<string, unknown>;
    const data = (r.data ?? r) as Record<string, unknown>;
    if (r.success === false || r.error) {
      // Explicit venue rejection in the response body: definitely not placed.
      throw new PerpError("ORDER_REJECTED", `Market ${side} ${symbol}: ${r.error ?? 'order rejected'}`, { exchange: "pacifica" });
    }

    // Get order_id from response
    const orderId = data.order_id ? String(data.order_id) : null;

    if (orderId && !(opts?.reduceOnly ?? false)) {
      // Poll order status via history_by_id
      let lastPollError: unknown = null;
      let verdict: PerpError | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const history = await this.client.getOrderHistoryById(Number(orderId));
          const histData = (history as Record<string, unknown>).data ?? history;
          const latest = pacificaLatestHistoryRow(histData, orderId);
          if (latest !== null) {
            const status = String(latest.order_status ?? "");
            const filled = parseFloat(String(latest.filled_amount ?? "0"));
            if (status === "filled" || filled > 0) {
              // Terminal row (filled / cancelled remainder) with a reported filled_amount = the
              // order's final fill. A non-terminal partial row is not final.
              const reported = latest.filled_amount;
              const terminal = status === "filled" || status === "cancelled" || status === "rejected";
              if (terminal && reported !== undefined && reported !== null && String(reported).trim() !== ""
                && Number.isFinite(Number(reported)) && result !== null && typeof result === "object") {
                // The terminal row rides along with the raw result (read back by iocOutcomeOf).
                const fillReport: PacificaFillReport = { orderId, orderStatus: status, filledAmount: String(reported).trim() };
                return { ...(result as Record<string, unknown>), fillReport };
              }
              return result; // confirmed fill (no final report)
            }
            if (status === "cancelled" || status === "rejected") {
              // Definite no-fill ONLY when the venue reports filled_amount and it is 0. A
              // terminal row without filled_amount may be a partially-filled IOC whose
              // remainder was cancelled — leave it untyped so the caller measures the fill.
              if (latest.filled_amount !== undefined && latest.filled_amount !== null && String(latest.filled_amount).trim() !== "" && Number(latest.filled_amount) === 0) {
                throw new PerpError("ORDER_REJECTED", `Market ${side} ${symbol}: order ${orderId} ${status}`, { exchange: "pacifica", orderId });
              }
              // Sent and terminal, but the fill amount is not reported: a partially filled IOC
              // whose remainder was cancelled looks the same — outcome unknown, never resubmit.
              verdict = orderOutcomeUnknown("pacifica", `market ${side} ${size} ${symbol}`,
                new Error(`order ${orderId} ${status} without a reported filled_amount`),
                `Do NOT resubmit — order ${orderId} may have partially filled. Check positions and fills first: perp -e pacifica account positions / trades`);
            }
            // Still processing, retry
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Market ")) throw e;
          lastPollError = e;
        }
        if (verdict !== null) throw verdict;
      }
      // Accepted but not confirmed within the poll window: returned without a fill report, so the
      // caller (iocOutcomeOf → null) reports it unconfirmed — never assumed executed.
      const errDetail = lastPollError instanceof Error ? ` (poll error: ${lastPollError.message})` : "";
      console.error(`[pacifica] Warning: market ${side} ${symbol} order ${orderId} not confirmed after 5s${errDetail} — outcome unconfirmed; check positions before retrying: perp -e pacifica account positions`);
    }

    if (!orderId && !(opts?.reduceOnly ?? false)) {
      console.error(`[pacifica] Warning: market ${side} ${symbol} accepted but no order_id in response — skipping fill verification`);
    }

    return result;
  }

  /**
   * Venue-final outcome of a raw marketOrder() result (IocOutcomeCapable),
   * parsed from the result's content (so copies of it work): its `fillReport` — the terminal
   * history_by_id row (filled / cancelled / rejected) with a reported filled_amount — for the
   * same order id as the create response. null otherwise — reduce-only orders (not polled),
   * a poll that timed out or saw only non-terminal rows, any other raw value. Never guesses.
   */
  iocOutcomeOf(raw: unknown): IocOutcome | null {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const fr = r.fillReport as Record<string, unknown> | null | undefined;
    if (fr === null || typeof fr !== "object") return null;
    const data = (r.data !== null && typeof r.data === "object" ? r.data : r) as Record<string, unknown>;
    const createdId = typeof data.order_id === "number" || typeof data.order_id === "string" ? String(data.order_id) : null;
    if (createdId === null || fr.orderId !== createdId) return null;
    if (fr.orderStatus !== "filled" && fr.orderStatus !== "cancelled" && fr.orderStatus !== "rejected") return null;
    const filled = fr.filledAmount;
    if (typeof filled !== "string" || !/^\d+(\.\d+)?$/.test(filled)) return null;
    return { filledSize: filled, final: true };
  }

  /**
   * Venue-final outcome of a placed / edited order: polls `/orders/history_by_id` (bounded,
   * 6 × 500 ms) until pacificaOrderOutcomeOf proves one. null = still unknown (the caller
   * reports pending). Read failures poll again; the last one is logged when nothing resolved.
   */
  async resolveOrderOutcome(orderId: string, what: string, opts: { terminalOnly?: boolean; expect?: { price: string | null; size: string | null } } = {}): Promise<PacificaOrderOutcome | null> {
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const history = await this.client.getOrderHistoryById(Number(orderId));
        const out = pacificaOrderOutcomeOf((history as Record<string, unknown>).data ?? history, orderId, opts);
        if (out !== null) return out;
      } catch (e) {
        lastErr = extractErrorMessage(e);
      }
    }
    console.error(`[pacifica] Warning: ${what}: order ${orderId} outcome not confirmed${lastErr !== null ? ` (last read error: ${lastErr})` : ""} — verify with: perp account orders -e pacifica`);
    return null;
  }

  /** The raw create result with its resolved `orderOutcome` attached (unchanged when there is no order id / a body error / no outcome). */
  private async withOrderOutcome(raw: unknown, what: string, opts: { terminalOnly?: boolean; expect?: { price: string | null; size: string | null } }): Promise<unknown> {
    const id = pacificaCreatedId(raw);
    if (id === null || pacificaBodyError(raw) !== null || raw === null || typeof raw !== "object") return raw;
    const orderOutcome = await this.resolveOrderOutcome(id, what, opts);
    return orderOutcome === null ? raw : { ...(raw as Record<string, unknown>), orderOutcome };
  }

  /**
   * Limit order. The create response is only an ack ({ order_id }); the placement outcome
   * (resting / filled / cancelled / rejected) is read back from history_by_id and attached as
   * `orderOutcome` (IOC: terminal rows only). Unresolved → no `orderOutcome` (pending).
   */
  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string; clientOrderId?: string }) {
    this.ensureSigner();
    const tif = pacificaTif(opts?.tif); // common mapping; FOK → CAPABILITY_UNSUPPORTED
    // The caller's client order id (validated UUID) is sent as given; without one a generated
    // client_order_id records the TIF for a later TIF-preserving amend. Either way the id sent
    // rides on the result (`clientOrderId`).
    const cloid = opts?.clientOrderId !== undefined ? requirePacificaClientOrderId(opts.clientOrderId, tif) : pacificaClientOrderId(tif);
    symbol = await this.orderSymbol(symbol, `limit ${tif} ${side} ${size}`);
    const raw = await this.client.createLimitOrder(
      { symbol, price, amount: size, side: side === "buy" ? "bid" : "ask", reduce_only: opts?.reduceOnly ?? false, tif, client_order_id: cloid },
      this.account,
      this.signMessage,
      await this.builderCode(),
    ).catch((e: unknown) => { throw pacificaCreateRejection(e, `limit ${tif} ${side} ${size} ${symbol} @ ${price}`); });
    return withSentClientOrderId(
      await this.withOrderOutcome(raw, `limit ${tif} ${side} ${size} ${symbol} @ ${price}`, { terminalOnly: tif === "IOC", expect: { price, size } }),
      cloid,
    );
  }

  async cancelOrder(symbol: string, orderId: string) {
    this.ensureSigner();
    symbol = await this.listedSymbol(symbol);
    return this.client.cancelOrder(
      { symbol, order_id: Number(orderId) },
      this.account,
      this.signMessage
    );
  }

  /**
   * The account's order carrying `clientOrderId`, from the venue's own listings — both document
   * the field: GET /orders and GET /orders/history rows carry `client_order_id` ("CLOID of order
   * if assigned by user", docs.pacifica.fi rest-api orders/get-open-orders, get-order-history).
   * Open orders first, then the latest order-history page (the venue's default page, 100 rows).
   * null = not among them. history_by_id itself takes only `order_id`, so this resolves the id.
   */
  async orderByClientId(clientOrderId: string): Promise<{ orderId: string; symbol: string; type: string; open: boolean } | null> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const wanted = requirePacificaClientOrderId(clientOrderId, pacificaTifOf(clientOrderId.toLowerCase())).toLowerCase();
    const pick = (rows: unknown, open: boolean) => {
      if (!Array.isArray(rows)) {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica ${open ? "/orders" : "/orders/history"} returned no order list`, { exchange: "pacifica" });
      }
      const row = (rows as Array<Record<string, unknown>>).find((o) => typeof o?.client_order_id === "string" && o.client_order_id.toLowerCase() === wanted);
      if (row === undefined) return null;
      if (typeof row.order_id !== "number" && typeof row.order_id !== "string") {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica order with client id ${clientOrderId} has no order_id`, { exchange: "pacifica" });
      }
      return { orderId: String(row.order_id), symbol: String(row.symbol), type: String(row.order_type), open };
    };
    const open = pick(await this.client.getOrders(this.account), true);
    if (open !== null) return open;
    return pick(await this.client.getOrderHistory(this.account), false);
  }

  /**
   * Venue-final state of one order from a single `/orders/history_by_id` read (`trade status`).
   * null outcome = the rows prove no state yet (reported pending). A 404 → ORDER_NOT_FOUND.
   */
  async orderStatusById(orderId: string): Promise<{ outcome: PacificaOrderOutcome | null; clientOrderId: string | null; venueRaw: unknown }> {
    if (!/^\d+$/.test(orderId)) throw new PerpError("INVALID_PARAMS", `Pacifica order id must be numeric (got "${orderId}")`);
    let history: unknown;
    try {
      history = await this.client.getOrderHistoryById(Number(orderId));
    } catch (e) {
      if (/^GET \S*history_by_id failed \(404\)/.test(extractErrorMessage(e))) {
        throw new PerpError("ORDER_NOT_FOUND", `Pacifica order ${orderId} not found`, { exchange: "pacifica" });
      }
      throw e;
    }
    const rows = (history !== null && typeof history === "object" && !Array.isArray(history) && "data" in history) ? (history as Record<string, unknown>).data : history;
    const row = pacificaLatestHistoryRow(rows, orderId);
    if (row === null && (!Array.isArray(rows) || rows.length === 0)) {
      throw new PerpError("ORDER_NOT_FOUND", `Pacifica order ${orderId} not found`, { exchange: "pacifica" });
    }
    return {
      outcome: pacificaOrderOutcomeOf(rows, orderId),
      clientOrderId: row !== null && typeof row.client_order_id === "string" && row.client_order_id !== "" ? row.client_order_id : null,
      venueRaw: rows,
    };
  }

  /** A refused cancel of `orderId` (pacificaRefused error) settled from one history_by_id read (pacificaCancelRefusalOf). */
  async cancelRefusalOutcome(orderId: string, refusal: unknown): Promise<PacificaCancelRefusal> {
    const msg = extractErrorMessage(refusal);
    let history: { data: unknown } | { error: unknown };
    try {
      const h = await this.client.getOrderHistoryById(Number(orderId));
      history = { data: (h as Record<string, unknown> | null)?.data ?? h };
    } catch (e) {
      history = { error: e };
    }
    return pacificaCancelRefusalOf(orderId, msg, history);
  }

  async cancelAllOrders(symbol?: string) {
    this.ensureSigner();
    // Never `cancel_all` with all_symbols:true — it would also cancel spot orders.
    // getOpenOrders() already excludes spot symbols; cancel the perp orders one by one.
    let orders: ExchangeOrder[];
    try { // pre-send: the open-orders listing — nothing is cancelled when it fails
      orders = await this.getOpenOrders();
    } catch (e) {
      throw orderNotSent("pacifica", `cancel-all${symbol ? ` ${symbol.toUpperCase()}` : ""}`, e);
    }
    const targets = symbol ? orders.filter(o => o.symbol.toUpperCase() === symbol.toUpperCase()) : orders;
    // Every target is attempted (like lighter.ts cancelAllOrders): one refused / unknown cancel
    // must not leave the orders after it untouched and unreported. All cancelled → the raw
    // results; any failure → one error carrying the per-order outcome.
    const results: unknown[] = [];
    const perOrder: Array<{ orderId: string; symbol: string; cancelled: boolean; definite: boolean; error: string | null }> = [];
    for (const o of targets) {
      try {
        const r = await this._cancelListed(o);
        const bodyErr = pacificaBodyError(r);
        if (bodyErr !== null) throw new PerpError("ORDER_REJECTED", `Pacifica cancel of ${o.orderId} refused: ${bodyErr}`, { exchange: "pacifica" });
        results.push(r);
        perOrder.push({ orderId: o.orderId, symbol: o.symbol, cancelled: true, definite: true, error: null });
      } catch (e) {
        // A 4xx refusal / explicit body refusal / pre-send refusal is definite (that order was not
        // cancelled by this request); a transport failure, 5xx or anything else leaves it unknown.
        const definite = pacificaRefused(e) || isDefiniteOrderFailure(e);
        perOrder.push({ orderId: o.orderId, symbol: o.symbol, cancelled: false, definite, error: extractErrorMessage(e) });
      }
    }
    const failed = perOrder.filter(r => !r.cancelled);
    if (failed.length === 0) return results;
    const cancelled = perOrder.length - failed.length;
    const code = cancelled > 0 ? "ORDER_PARTIAL" : failed.every(r => r.definite) ? "ORDER_REJECTED" : "ORDER_PENDING";
    throw new PerpError(code, `pacifica cancel-all: ${cancelled} of ${perOrder.length} order(s) cancelled; failed: ${failed.map(r => `${r.orderId} ${r.symbol} (${r.error})`).join("; ")}`, {
      exchange: "pacifica",
      results: perOrder,
      remediation: "Check which orders are still open (perp account orders -e pacifica) and cancel the remaining ones individually",
    });
  }

  /** Stop / TP / SL rows (incl. position-level TP/SL) go to /orders/stop/cancel; /orders/cancel refuses them (422). */
  private _cancelListed(o: ExchangeOrder): Promise<unknown> {
    return isPacificaStopType(o.type) ? this.cancelStopOrder(o.symbol, o.orderId) : this.cancelOrder(o.symbol, o.orderId);
  }

  /**
   * Native edit (POST /orders/edit). Venue semantics (docs rest-api/orders/edit-order,
   * read 2026-10-02): the edit cancels the original and creates a new order with the same
   * side, reduce-only and client_order_id, a new order_id, and TIF = ALO (post-only) —
   * whatever the original TIF was. Post-only is therefore always kept (an ALO original
   * stays ALO); a GTC / TOB original becomes ALO and is rejected instead of crossing.
   * The original TIF is not readable (GET /orders has no tif field), so the conversion
   * cannot be detected per order; callers report it (execution tifSent "ALO").
   */
  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    this.ensureSigner();
    symbol = await this.orderSymbol(symbol, `edit ${orderId}`);
    return this.client.editOrder(
      { symbol, order_id: Number(orderId), price, amount: size },
      this.account,
      this.signMessage
    );
  }

  /**
   * Amend that keeps the order's TIF. `size` = new open size.
   * TIF = `tif` when the caller gives one, else the TIF encoded in the order's generated
   * client_order_id; unknown → uniform CAPABILITY_UNSUPPORTED (never guessed).
   *  - ALO: native edit (the venue re-creates the order as ALO, keeping its client_order_id).
   *  - GTC / TOB: cancel → read the fill at cancel → replace with
   *    size − (filledAtCancel − filledAtRead) at the same TIF / side / reduce-only (≤ 0 or below
   *    the lot → no replacement, reported). Cancel outcome unknown → ORDER_PENDING (no replace);
   *    cancel ok but the fill at cancel unreadable or the replacement refused → ORDER_PARTIAL
   *    { cancelled, placed: null }; replacement outcome unknown → ORDER_PENDING.
   */
  async amendKeepingTif(symbol: string, orderId: string, price: string, size: string, tif: PacificaTif | null, forceTif = false): Promise<PacificaAmendResult> {
    this.ensureSigner();
    if (!/^\d+$/.test(orderId)) throw new PerpError("INVALID_PARAMS", `Pacifica order id must be numeric (got "${orderId}")`);
    if (!(Number(price) > 0) || !(Number(size) > 0)) throw new PerpError("INVALID_PARAMS", `Pacifica amend needs a positive price and size (got ${price} x ${size})`);
    const sym = symbol.toUpperCase();
    const open = await this.client.getOrders(this.account);
    const original = open.find((o) => String(o.order_id) === orderId);
    if (original === undefined) {
      throw new PerpError("ORDER_NOT_FOUND", `Pacifica order ${orderId} is not among the open orders`, { exchange: "pacifica" });
    }
    if (String(original.symbol).toUpperCase() !== sym) {
      throw new PerpError("INVALID_PARAMS", `Order ${orderId} is on ${original.symbol}, not ${sym}`);
    }
    // The venue's own spelling (kPEPE), for the cancel and the replacement.
    const venueSym = String(original.symbol);
    if (original.order_type !== "limit") {
      throw unsupported("Pacifica", "amend", `only open limit orders can be amended (order is ${original.order_type})`,
        `Cancel it (perp trade cancel ${sym} ${orderId} -e pacifica) and place a new order`);
    }
    const encoded = pacificaTifOf(original.client_order_id);
    if (tif !== null && encoded !== null && (tif === "ALO") !== (encoded === "ALO") && !forceTif) {
      throw new PerpError("INVALID_PARAMS", `--tif ${tif} would make order ${orderId} ${encoded === "ALO" ? "no longer post-only" : "post-only"} (its client id encodes TIF ${encoded})`, {
        remediation: "Omit --tif to keep the order's own TIF, or pass --force-tif to change it",
      });
    }
    const keep = tif ?? encoded;
    if (keep === null) {
      throw unsupported("Pacifica", "amend", "original order attributes unknown",
        `pass --tif: perp trade edit ${sym} ${orderId} <price> <size> --tif <GTC|ALO|TOB> -e pacifica`);
    }
    const tifNote = tif !== null ? `TIF ${keep} (from --tif)` : `TIF ${keep} kept (from the order's client id)`;

    if (keep === "ALO") {
      const raw = await this.editOrder(venueSym, orderId, price, size);
      const err = pacificaBodyError(raw);
      if (err !== null) throw new PerpError("ORDER_REJECTED", `Pacifica edit of ${orderId} refused: ${err}`, { exchange: "pacifica" });
      const data = (raw !== null && typeof raw === "object" ? ((raw as Record<string, unknown>).data ?? raw) : null) as Record<string, unknown> | null;
      const newId = data !== null && (typeof data.order_id === "number" || typeof data.order_id === "string") ? String(data.order_id) : null;
      // The edited order (new id) read back with the new price / size verified.
      const outcome = newId === null ? null : await this.resolveOrderOutcome(newId, `edit of ${orderId}`, { expect: { price, size } });
      return {
        method: "nativeAmend", tif: "ALO", orderId: newId, clientOrderId: original.client_order_id ?? null,
        filledBeforeCancel: null, replacedSize: null, filledCompletely: false, outcome,
        notes: [tifNote, "native edit (the venue re-creates the order as ALO with a new order id)"], venueRaw: raw,
      };
    }
    if (keep === "IOC") {
      throw unsupported("Pacifica", "amend", "an IOC order never rests, so there is nothing to amend", "Place a new order");
    }

    // cancel → replace. Validate the replacement before cancelling (bad size/price never loses the original).
    const market = (await this.getMarkets()).find((m) => m.symbol.toUpperCase() === sym);
    if (market === undefined || market.stepSize === null) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Pacifica ${sym}: no lot size published; cannot size a replacement`, { exchange: "pacifica" });
    }
    const lot = market.stepSize;
    floorSize(size, lot);
    // The replacement price must sit on the venue tick BEFORE the original is cancelled — an
    // off-tick price would be refused only after the original is already gone.
    const info = perpInfoRows(await this.client.getInfo()).find((m) => m.symbol.toUpperCase() === sym);
    if (info === undefined || typeof info.tick_size !== "string" || !(Number(info.tick_size) > 0)) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Pacifica ${sym}: no tick size published; cannot validate the replacement price`, { exchange: "pacifica" });
    }
    requireOnTick(price, info.tick_size);
    // The replacement size is derived from filled_amount (size − fills raced in during the cancel):
    // an unreadable one is refused HERE, before the cancel — after it, the original would be gone
    // with no computable replacement.
    const filledAtReadRaw = original.filled_amount;
    if ((typeof filledAtReadRaw !== "string" && typeof filledAtReadRaw !== "number") || !/^\d+(\.\d+)?$/.test(String(filledAtReadRaw).trim())) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica order ${orderId} has no readable filled_amount (got ${JSON.stringify(filledAtReadRaw ?? null)}); nothing was cancelled`, {
        exchange: "pacifica", sent: false,
        remediation: `Retry the amend, or cancel (perp trade cancel ${sym} ${orderId} -e pacifica) and place a new order`,
      });
    }
    const filledAtRead = String(filledAtReadRaw).trim();
    const cancelWhat = `amend: cancel of ${orderId}`;
    let cancelRaw: unknown;
    try {
      cancelRaw = await this.client.cancelOrder({ symbol: venueSym, order_id: Number(orderId) }, this.account, this.signMessage);
    } catch (e) {
      if (pacificaRefused(e)) {
        throw new PerpError("ORDER_REJECTED", `Pacifica ${cancelWhat} refused (${extractErrorMessage(e)}); the original order is untouched, nothing replaced`, { exchange: "pacifica" });
      }
      throw orderOutcomeUnknown("pacifica", cancelWhat, e, `No replacement was placed. Check the original: perp account orders -e pacifica`);
    }
    const cancelErr = pacificaBodyError(cancelRaw);
    if (cancelErr !== null) {
      throw new PerpError("ORDER_REJECTED", `Pacifica ${cancelWhat} refused: ${cancelErr}; the original order is untouched, nothing replaced`, { exchange: "pacifica" });
    }

    // Fill at cancel: the order's terminal history_by_id row with a reported filled_amount.
    let filledAtCancel: string | null = null;
    let terminalStatus: string | null = null;
    let lastReadError: string | null = null;
    for (let attempt = 0; attempt < 6 && filledAtCancel === null; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const history = await this.client.getOrderHistoryById(Number(orderId));
        const latest = pacificaLatestHistoryRow((history as Record<string, unknown>).data ?? history, orderId);
        const st = latest === null ? "" : String(latest.order_status ?? "");
        const fa = latest?.filled_amount;
        if ((st === "cancelled" || st === "filled") && fa !== undefined && fa !== null && /^\d+(\.\d+)?$/.test(String(fa).trim())) {
          filledAtCancel = String(fa).trim();
          terminalStatus = st;
        }
      } catch (e) {
        lastReadError = extractErrorMessage(e); // retried; still unknown after the loop → ORDER_PARTIAL below
      }
    }
    const notes = [tifNote, `cancel→replace: filledAtRead ${filledAtRead}, filledAtCancel ${filledAtCancel ?? "unknown"}`];
    if (filledAtCancel === null) {
      throw new PerpError("ORDER_PARTIAL", `Pacifica amend: order ${orderId} was CANCELLED but its fill at cancel could not be read${lastReadError !== null ? ` (${lastReadError})` : ""}; no replacement was placed`, {
        exchange: "pacifica", cancelled: { orderId, venueRaw: cancelRaw }, placed: null,
        remediation: "The original order is gone; check the position (perp account positions -e pacifica) and place a new order manually",
      });
    }
    const base = { tif: keep, orderId: null, clientOrderId: null, filledBeforeCancel: filledAtCancel, filledCompletely: false, outcome: null } as const;
    if (terminalStatus === "filled") {
      return { ...base, filledCompletely: true, method: "cancelReplace", replacedSize: null, notes: [...notes, `order ${orderId} filled completely before the cancel — no replacement placed`], venueRaw: { cancelled: cancelRaw, placed: null } };
    }
    const raced = subDecimal(filledAtCancel, filledAtRead);
    const replace = subDecimal(size, raced.startsWith("-") ? "0" : raced);
    let replaceSize: string | null = null;
    if (!replace.startsWith("-") && Number(replace) > 0) {
      try {
        replaceSize = floorSize(replace, lot);
      } catch (e) {
        if (!(e instanceof PerpError) || e.structured.code !== "SIZE_TOO_SMALL") throw e;
      }
    }
    if (replaceSize === null) {
      return { ...base, method: "cancelReplace", replacedSize: null, notes: [...notes, `${raced} filled between read and cancel; replacement ${replace} is not above the lot ${lot} — no replacement placed`], venueRaw: { cancelled: cancelRaw, placed: null } };
    }

    const cloid = pacificaClientOrderId(keep);
    let placed: unknown;
    try {
      placed = await this.client.createLimitOrder(
        { symbol: venueSym, price, amount: replaceSize, side: original.side, reduce_only: original.reduce_only === true, tif: keep, client_order_id: cloid },
        this.account, this.signMessage, await this.builderCode(),
      );
    } catch (e) {
      if (pacificaRefused(e)) {
        throw new PerpError("ORDER_PARTIAL", `Pacifica amend: original order ${orderId} was CANCELLED but the replacement was refused: ${extractErrorMessage(e)}`, {
          exchange: "pacifica", cancelled: { orderId, venueRaw: cancelRaw }, placed: null,
          remediation: "The original order is gone; place a new order manually",
        });
      }
      throw new PerpError("ORDER_PENDING", `Pacifica amend: original order ${orderId} was CANCELLED; the replacement outcome is unknown: ${extractErrorMessage(e)}`, {
        exchange: "pacifica", cancelled: { orderId, venueRaw: cancelRaw }, replacementClientOrderId: cloid,
        remediation: "Do NOT resubmit. Check open orders: perp account orders -e pacifica",
      });
    }
    const placeErr = pacificaBodyError(placed);
    if (placeErr !== null) {
      throw new PerpError("ORDER_PARTIAL", `Pacifica amend: original order ${orderId} was CANCELLED but the replacement was refused: ${placeErr}`, {
        exchange: "pacifica", cancelled: { orderId, venueRaw: cancelRaw }, placed: null,
        remediation: "The original order is gone; place a new order manually",
      });
    }
    const pd = (placed !== null && typeof placed === "object" ? ((placed as Record<string, unknown>).data ?? placed) : null) as Record<string, unknown> | null;
    const newId = pd !== null && (typeof pd.order_id === "number" || typeof pd.order_id === "string") ? String(pd.order_id) : null;
    const extra = subDecimal(size, replaceSize) === "0" ? [] : [`replacement size ${replaceSize} (requested open size ${size})`];
    const outcome = newId === null ? null : await this.resolveOrderOutcome(newId, `amend: replacement of ${orderId}`, { expect: { price, size: replaceSize } });
    return {
      ...base, method: "cancelReplace", orderId: newId, clientOrderId: cloid, replacedSize: replaceSize, outcome,
      notes: [...notes, ...extra], venueRaw: { cancelled: cancelRaw, placed },
    };
  }

  /** Cancel a stop / TP / SL order (POST /orders/stop/cancel). An explicit venue refusal → ORDER_REJECTED. */
  async cancelStopOrder(symbol: string, orderId: string): Promise<unknown> {
    this.ensureSigner();
    if (!/^\d+$/.test(orderId)) throw new PerpError("INVALID_PARAMS", `Pacifica stop order id must be numeric (got "${orderId}")`);
    const venueSym = await this.listedSymbol(symbol);
    const raw = await this.client.cancelStopOrder({ symbol: venueSym, order_id: Number(orderId) }, this.account, this.signMessage);
    const err = pacificaBodyError(raw);
    if (err !== null) throw new PerpError("ORDER_REJECTED", `Pacifica cancel of stop order ${orderId} refused: ${err}`, { exchange: "pacifica" });
    return raw;
  }

  /** Open position-level TP/SL orders (order_type take_profit_* / stop_loss_*) on `symbol`. */
  async positionTpSlOrders(symbol: string): Promise<Array<{ orderId: string; type: string; stopPrice: string | null }>> {
    const sym = symbol.toUpperCase();
    const open = await this.client.getOrders(this.account);
    return open
      .filter((o) => String(o.symbol).toUpperCase() === sym && /^(take_profit|stop_loss)_/.test(String(o.order_type)))
      .map((o) => ({ orderId: String(o.order_id), type: String(o.order_type), stopPrice: o.stop_price === null ? null : String(o.stop_price) }));
  }

  /**
   * Position-level TP/SL (POST /positions/tpsl). `positionSide` = the position's side; the
   * venue's `side` field is the TP/SL orders' (CLOSING) side: long → "ask", short → "bid"
   * (pacifica-fi/python-sdk rest/create_position_tpsl.py: a BTC long sends side "ask"; the
   * position side was refused live on testnet 2026-10-02 with 422 "Invalid stop order side").
   * Covers the whole position. An explicit venue refusal → ORDER_REJECTED.
   */
  async setPositionTpSl(symbol: string, positionSide: "long" | "short", tpsl: { tp: string | null; tpLimit: string | null; sl: string | null }): Promise<unknown> {
    this.ensureSigner();
    const params: { symbol: string; side: "bid" | "ask"; take_profit?: { stop_price: string; limit_price?: string }; stop_loss?: { stop_price: string } } = {
      symbol: await this.listedSymbol(symbol),
      side: positionSide === "long" ? "ask" : "bid",
    };
    if (tpsl.tp !== null) params.take_profit = tpsl.tpLimit !== null ? { stop_price: tpsl.tp, limit_price: tpsl.tpLimit } : { stop_price: tpsl.tp };
    if (tpsl.sl !== null) params.stop_loss = { stop_price: tpsl.sl };
    const raw = await this.client.setTPSL(params, this.account, this.signMessage, await this.builderCode());
    const err = pacificaBodyError(raw);
    if (err !== null) throw new PerpError("ORDER_REJECTED", `Pacifica position TP/SL on ${params.symbol} refused: ${err}`, { exchange: "pacifica" });
    return raw;
  }

  async setLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross") {
    this.ensureSigner();
    symbol = await this.orderSymbol(symbol, `leverage ${leverage}x`);
    await this.client.updateLeverage(
      { symbol, leverage },
      this.account,
      this.signMessage
    );
    if (marginMode === "isolated") {
      await this.client.updateMarginMode(
        { symbol, is_isolated: true },
        this.account,
        this.signMessage
      );
    }
    return { symbol, leverage, marginMode };
  }

  /** CLI trigger-type → Pacifica `trigger_price_type` value. Omitted ⇒ venue default (mark_price). */
  private static readonly TRIGGER_TYPE: Record<"mark" | "last" | "mid", string> = {
    mark: "mark_price",
    last: "last_trade_price",
    mid: "mid_price",
  };

  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean; triggerType?: "mark" | "last" | "mid" }) {
    this.ensureSigner();
    const triggerPriceType = opts?.triggerType ? PacificaAdapter.TRIGGER_TYPE[opts.triggerType] : undefined;
    symbol = await this.orderSymbol(symbol, `stop ${side} ${size}`);
    const raw = await this.client.createStopOrder(
      {
        symbol,
        side: side === "buy" ? "bid" : "ask",
        reduce_only: opts?.reduceOnly ?? false,
        stop_order: { stop_price: triggerPrice, amount: size, limit_price: opts?.limitPrice, trigger_price_type: triggerPriceType },
      },
      this.account,
      this.signMessage,
      await this.builderCode(),
    ).catch((e: unknown) => { throw pacificaCreateRejection(e, `stop ${side} ${size} ${symbol} @ ${triggerPrice}`); });
    // The ack carries only the order id: read the untriggered stop's state back (history_by_id).
    return this.withOrderOutcome(raw, `stop ${side} ${size} ${symbol} @ ${triggerPrice}`, { expect: { price: null, size } });
  }

  async withdraw(amount: string, destination: string, _opts?: { assetId?: number; routeType?: number }): Promise<unknown> {
    // A withdrawal moves funds: it is signed by the MASTER wallet only — never by the agent
    // key, even when one is registered (an agent key must not be able to withdraw).
    const master = this._masterSigner ?? (this._hasRealKey && this._solanaSigner ? this._solanaSigner : null);
    if (master === null || master.getPublicKeyBase58() !== this.account) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "Pacifica withdraw must be signed by the account's master wallet (an agent wallet cannot withdraw), and it is not loaded", {
        exchange: "pacifica",
        remediation: "Run with the master wallet: perp -e pacifica --ows <wallet> funds withdraw ... (or withdraw on the Pacifica website)",
      });
    }
    // Pacifica withdrawals ALWAYS go to the account owner's own connected wallet —
    // the REST API has no destination field. Refuse a mismatched destination rather
    // than silently sending to the own wallet (Rule #2: no misdirection / false
    // affordance). An empty destination or the own address is accepted.
    if (destination && destination !== this.account) {
      throw new PerpError(
        "INVALID_PARAMS",
        `Pacifica withdrawals only go to the account owner's own wallet (${this.account}); the API has no destination field, so withdrawing to ${destination} is not possible.`,
        { exchange: "pacifica" },
      );
    }
    if (subDecimal(amount, PACIFICA_WITHDRAW_MIN_USDC).startsWith("-")) {
      throw new PerpError("INVALID_PARAMS", `Pacifica withdraw ${amount} USDC is below the documented minimum of ${PACIFICA_WITHDRAW_MIN_USDC} USDC`, {
        exchange: "pacifica",
        remediation: `Withdraw more than ${PACIFICA_WITHDRAW_MIN_USDC} USDC (a $1 fee is charged per withdrawal)`,
      });
    }
    // Cap by the venue's available_to_withdraw (equity minus margin in use / loans) before signing.
    const info = await this.client.getAccount(this.account);
    const headroom = subDecimal(info.available_to_withdraw, amount);
    if (headroom.startsWith("-")) {
      throw new PerpError("INSUFFICIENT_BALANCE",
        `Pacifica withdraw ${amount} USDC exceeds available_to_withdraw ${info.available_to_withdraw}`, {
          exchange: "pacifica",
          remediation: `Withdraw at most ${info.available_to_withdraw} USDC, or free margin first (close positions / cancel orders / repay a negative USDC balance)`,
        });
    }
    this.client.setRequestAgentWallet(undefined); // master-signed: no agent_wallet field
    return this.client.withdraw({ amount }, this.account, (msg) => master.signMessage(msg))
      .catch((e: unknown) => { throw pacificaWithdrawRejection(e, amount); });
  }

  /**
   * Public tape (GET /trades). Every fill is listed TWICE — a `fulfill_taker` row and a
   * `fulfill_maker` row, each with that party's position effect as `side` (live 2026-10-14:
   * taker `open_short` paired with maker `close_short` at the same time / price / amount). The
   * tape is the taker rows, with the taker's direction: open_long / close_short buy, open_short /
   * close_long sell (the same mapping as the account fills, PACIFICA_FILL_*_SIDES). Was every row
   * of both parties mapped through `side === "bid"` → all "sell". No de-duplication: two taker
   * rows with equal time / price / amount are two fills (one order filling two makers).
   */
  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangePublicTrade[]> {
    // GET /trades has no limit / cursor: it answers the last 40 tape rows = 20 fills (taker +
    // maker row each; live 2026-10-19 on BTC, ETH, SOL, kPEPE, XRP). A larger limit is refused,
    // never silently answered with 20.
    if (!Number.isInteger(limit) || limit < 1 || limit > PACIFICA_TRADES_CAP) {
      throw new PerpError("INVALID_PARAMS", `Pacifica trades limit must be 1..${PACIFICA_TRADES_CAP} (got ${limit})`, {
        exchange: "pacifica", remediation: `Pacifica publishes only the last ${PACIFICA_TRADES_CAP} trades (GET /trades has no limit or cursor)`,
      });
    }
    symbol = await this.wireSymbol(symbol);
    const trades = await this.client.getTrades(symbol) as unknown as Array<Record<string, unknown>>;
    if (!Array.isArray(trades)) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /trades returned no trade list (${JSON.stringify(trades).slice(0, 120)})`, { exchange: "pacifica" });
    }
    // The docs list event_type fulfill_taker / fulfill_maker and side open_long / open_short /
    // close_long / close_short without declaring the sets closed: a row with any other value is
    // skipped (stderr warning + meta.skippedRows), never given a guessed direction, and does not
    // fail the rest of the tape.
    const skippedWhy: string[] = [];
    const rows: ExchangePublicTrade[] = [];
    for (const t of trades) {
      const ev = pacificaField(t, "event_type", "/trades");
      if (ev === "fulfill_maker") continue;
      if (ev !== "fulfill_taker") { skippedWhy.push(`undocumented event_type "${ev}"`); continue; }
      const side = pacificaField(t, "side", "/trades");
      if (!PACIFICA_FILL_BUY_SIDES.has(side) && !PACIFICA_FILL_SELL_SIDES.has(side)) { skippedWhy.push(`undocumented side "${side}"`); continue; }
      if (rows.length >= limit) continue;
      rows.push({
        time: pacificaTime(t, "/trades"),
        symbol,
        side: pacificaFillSide(side, "/trades"),
        price: pacificaField(t, "price", "/trades"),
        size: pacificaField(t, "amount", "/trades"),
        fee: null, // the public tape carries no fee
      });
    }
    const skipped = skippedWhy.length === 0 ? null : { count: skippedWhy.length, reason: [...new Set(skippedWhy)].join(", ") };
    if (skipped !== null) process.stderr.write(`[pacifica] /trades: skipped ${skipped.count} row(s) — ${skipped.reason}\n`);
    return withTapeSkipped(await nonEmptyOrListed(this, symbol, rows), skipped);
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<FundingHistoryRow[]> {
    // `limit` is at most 4000 per request (docs; live: limit 4001 / 5000 → 4000 rows, has_more
    // true): deeper history is paged with `cursor` / `next_cursor`, newest first.
    if (!Number.isInteger(limit) || limit < 1 || limit > PACIFICA_FUNDING_PAGE * PACIFICA_MAX_PAGES) {
      throw new PerpError("INVALID_PARAMS", `Pacifica funding history limit must be 1..${PACIFICA_FUNDING_PAGE * PACIFICA_MAX_PAGES} (got ${limit})`, { exchange: "pacifica" });
    }
    symbol = await this.wireSymbol(symbol);
    const data: unknown[] = [];
    let cursor: string | null = null;
    let hasMore = false;
    for (let page = 0; data.length < limit && page < PACIFICA_MAX_PAGES; page++) {
      const params: Record<string, string> = { symbol, limit: String(Math.min(PACIFICA_FUNDING_PAGE, limit - data.length)) };
      if (cursor !== null) params.cursor = cursor;
      const env = await this.client.getEnvelope("/funding_rate/history", params);
      if (env.success !== true || !Array.isArray(env.data)) {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica /funding_rate/history returned no row list (${JSON.stringify(env).slice(0, 120)})`, { exchange: "pacifica" });
      }
      data.push(...env.data);
      hasMore = env.has_more === true;
      if (!hasMore || typeof env.next_cursor !== "string" || env.next_cursor === "" || env.data.length === 0) break;
      cursor = env.next_cursor;
    }
    // Short of `limit` while the venue says there is more (no cursor / empty page / page budget): never a silent short history.
    if (data.length < limit && hasMore) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /funding_rate/history: ${data.length} of ${limit} rows read and the venue reports more (has_more) without a usable next page`, { exchange: "pacifica" });
    }
    // `200 []` for an unlisted symbol (live): checked against the market directory.
    return nonEmptyOrListed(this, symbol, (data.slice(0, limit) as Array<Record<string, unknown>>).map((h) => {
      const oracle = h.oracle_price;
      return {
        time: pacificaTime(h, "/funding_rate/history"),
        rate: venueRateField(h.funding_rate, "funding history funding_rate", "pacifica"),
        // absent → null (unknown), never "0"
        price: (typeof oracle === "string" && oracle !== "") || (typeof oracle === "number" && Number.isFinite(oracle)) ? String(oracle) : null,
        intervalHours: 1, // hourly settlement (venue fundingRateBasis perHours 1)
        rateKind: "lastSettled" as const,
      };
    }));
  }

  /**
   * GET /kline over [startTime, endTime]. The venue refuses a range over 4000 candles (HTTP 400
   * "Time range too large … Max range: 4000 candles"), so a longer window is read in consecutive
   * 4000-bar windows (at most PACIFICA_MAX_PAGES), merged by open time. Intervals outside
   * PACIFICA_KLINE_INTERVALS are refused locally with INVALID_PARAMS (the venue: HTTP 400).
   */
  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const ivMs = PACIFICA_KLINE_INTERVALS[interval];
    if (ivMs === undefined) {
      throw new PerpError("INVALID_PARAMS", `Pacifica kline interval ${JSON.stringify(interval)} is not served (supported: ${Object.keys(PACIFICA_KLINE_INTERVALS).join(", ")})`, {
        exchange: "pacifica", remediation: `Use one of: ${Object.keys(PACIFICA_KLINE_INTERVALS).join(", ")}`,
      });
    }
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
      throw new PerpError("INVALID_PARAMS", `Pacifica kline window must be start ≤ end (unix ms; got ${startTime}..${endTime})`, { exchange: "pacifica" });
    }
    const span = PACIFICA_KLINE_MAX_BARS * ivMs;
    const pages = Math.ceil((endTime - startTime + 1) / span);
    if (pages > PACIFICA_MAX_PAGES) {
      throw new PerpError("INVALID_PARAMS", `Pacifica kline window spans more than ${PACIFICA_KLINE_MAX_BARS * PACIFICA_MAX_PAGES} ${interval} bars (${PACIFICA_MAX_PAGES} requests of ${PACIFICA_KLINE_MAX_BARS})`, {
        exchange: "pacifica", remediation: "Narrow --start / --end or use a longer interval",
      });
    }
    symbol = await this.wireSymbol(symbol);
    type Kline = Awaited<ReturnType<PacificaClient["getKline"]>>[number];
    const byTime = new Map<number, Kline>();
    for (let from = startTime; from <= endTime; from += span) {
      const to = Math.min(endTime, from + span - 1);
      const raw = await this.client.getKline(symbol, interval as Parameters<typeof this.client.getKline>[1], from, to);
      if (!Array.isArray(raw)) {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica /kline returned no candle list (${JSON.stringify(raw).slice(0, 120)})`, { exchange: "pacifica" });
      }
      // A row of another interval → EXCHANGE_ERROR (assertCandleInterval), never returned.
      for (const k of raw) byTime.set(k.t, (assertCandleInterval("pacifica", interval, (k as { i?: unknown }).i), k));
    }
    const klines = [...byTime.values()].sort((a, b) => a.t - b.t);
    // `200 []` for an unlisted symbol (live): checked against the market directory.
    return nonEmptyOrListed(this, symbol, klines.map((k) => ({
      time: k.t,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
      volume: k.v,
      quoteVolume: null, // /kline carries base volume only
      trades: k.n,
    })));
  }

  /**
   * Recent orders, newest first (GET /orders/history; PacificaClient.get already unwraps the
   * `{success, data}` envelope, so the list is the result itself). A non-list or a row without a
   * readable field → EXCHANGE_ERROR, never an empty list or a placeholder value.
   */
  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const rows = await this.client.getOrderHistory(this.account, { limit });
    if (!Array.isArray(rows)) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /orders/history returned no order list (${JSON.stringify(rows).slice(0, 120)})`, { exchange: "pacifica" });
    }
    const field = (o: Record<string, unknown>, k: string): string => pacificaField(o, k, "/orders/history");
    return (rows as Array<Record<string, unknown>>).slice(0, limit).map((o) => {
      const side = field(o, "side");
      if (side !== "bid" && side !== "ask") {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica order-history row with unknown side "${side}"`, { exchange: "pacifica" });
      }
      return {
        orderId: field(o, "order_id"),
        symbol: field(o, "symbol"),
        side: side === "bid" ? "buy" as const : "sell" as const,
        price: field(o, "initial_price"),
        size: field(o, "amount"),
        filled: field(o, "filled_amount"),
        status: field(o, "order_status"),
        type: field(o, "order_type"),
        triggerPrice: Number(o.stop_price) > 0 ? String(o.stop_price) : null,
      };
    });
  }

  /**
   * Recent fills, newest first (GET /trades/history; the client unwraps `{success, data}`).
   * `side` is the position effect — open_long / close_short buy, open_short / close_long sell
   * (live 2026-10-13: `"side":"close_short"` on a buy-to-close fill); bid / ask are accepted for
   * rows that carry an order side. Anything else, a non-list or an unreadable field → EXCHANGE_ERROR.
   */
  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const rows = await this.client.getTradeHistory(this.account, { limit });
    if (!Array.isArray(rows)) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /trades/history returned no list (${JSON.stringify(rows).slice(0, 120)})`, { exchange: "pacifica" });
    }
    return (rows as Array<Record<string, unknown>>).slice(0, limit).map((t) => {
      const side = pacificaFillSide(pacificaField(t, "side", "/trades/history"), "/trades/history");
      return {
        time: pacificaTime(t, "/trades/history"),
        symbol: pacificaField(t, "symbol", "/trades/history"),
        side,
        price: pacificaField(t, "price", "/trades/history"),
        size: pacificaField(t, "amount", "/trades/history"),
        fee: pacificaField(t, "fee", "/trades/history"),
      };
    });
  }

  /** Funding paid / received per position (GET /funding/history, `payout` signed). Strict like getTradeHistory. */
  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const rows = await this.client.getFundingAccountHistory(this.account, { limit });
    if (!Array.isArray(rows)) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /funding/history returned no list (${JSON.stringify(rows).slice(0, 120)})`, { exchange: "pacifica" });
    }
    return (rows as Array<Record<string, unknown>>).slice(0, limit).map((h) => ({
      time: pacificaTime(h, "/funding/history"),
      symbol: pacificaField(h, "symbol", "/funding/history"),
      payment: pacificaField(h, "payout", "/funding/history"),
    }));
  }
}
