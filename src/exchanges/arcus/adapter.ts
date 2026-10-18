/**
 * Arcus adapter — native TradingV2 + legacy ExchangeAdapter shim.
 *
 * Signing: the agent API key is an Ed25519 key in OWS wallet
 * `meta.agentWalletName` (raw signMessage on the Solana account — no prefix).
 * Account = meta.ownerAddress, subaccount = meta.accountIndex. Without an agent
 * (master creds only, for spot swaps) every perp private call throws
 * AGENT_NOT_REGISTERED from requireAccount().
 *
 * Order entry rules (docs.arcus.xyz):
 * - every order carries goodTilTime ≥ 1 month ahead (ARCUS_GOOD_TIL_HORIZON_MS),
 *   body in µs, signed `g` in ns;
 * - market orders = IOC LIMIT at a protection price derived from mark and an
 *   explicit slippage bound, rejected locally when > 10 % from mark;
 * - TIF: common GTC is sent as GTT with goodTil = now +
 *   ARCUS_GOOD_TIL_HORIZON_MS (recorded as execution.expiresAt); IOC / FOK / ALO
 *   are native; a limit order without a TIF is GTC;
 * - clientId is always sent (orderAck async) and every OrderResult from a
 *   placement is `accepted` / `pending` unless the gateway already had state;
 * - stop / TP-SL orders exist only as batchPlaceOrders groupings: a standalone
 *   stop is a 1-leg `partialTpsl` (reduce-only), TP/SL attached to an entry is
 *   an `entryTpsl` bundle.
 */

import { PerpError } from "../../errors.js";
import type { ArcusAgentMeta } from "../../settings.js";
import type { EvmSigner } from "../../signer/interface.js";
import { OwsEvmSigner } from "../../signer/ows-evm.js";
import { OwsSolanaSigner } from "../../signer/ows-solana.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo,
  ExchangeOrder, ExchangePosition, ExchangeTrade, ExchangePublicTrade,
} from "../interface.js";
import type { ResolvedSlippage } from "../slippage.js";
import { alignProtectionPrice, floorSize, mulDecimal, requirePositive, slippagePrice, subDecimal, toUnitsExact, unitsToString } from "../precision.js";
import {
  newClientOrderId, unsupported, validateLegacyTif, validateOrderRequest, type TradingV2,
} from "../trading-v2.js";
import type { VenueCapabilities, VenueCreateContext, VenueDefinition } from "../venue.js";
import { networkConfig, requireCapabilities } from "../venue.js";
import {
  parseOrderRef, toLegacyMarketInfo,
  type AmendRequest, type CancelResult, type LeverageResult, type Network, type OrderRef, type OrderRequest,
  type OrderExecution, type OrderResult, type OrderStatus, type VenueMarket,
} from "../venue-types.js";
import { ArcusClient, arcusLeverageRejectError, arcusRejectionError } from "./client.js";
import { ed25519PubHexFromBase58 } from "./agent.js";
import { fetchArcusRawMarkets, onlineArcusMarkets, toArcusVenueMarket, type ArcusRawMarket } from "./public.js";
import {
  QUOTE_QUANTUM, assertArcusClientId, canonicalJson, cancelPayload, modifyPayload, nowNs, placePayload,
  signUtf8Hex, splitEvmSignature, withdrawTypedData, type ArcusTif, type Ed25519SignFn,
} from "./signing.js";

/**
 * goodTilTime horizon. Arcus rejects anything nearer than one month at
 * handling time (31 days covers every calendar month); the docs' examples use
 * now + 40 days, which also leaves headroom for clock skew.
 */
export const ARCUS_GOOD_TIL_HORIZON_MS = 40 * 86_400_000;
/** Arcus rejects MARKET protection prices more than 10 % from mark (also enforced locally for IOC limits). */
export const ARCUS_MAX_PROTECTION_DEVIATION = 0.10;
/** clientId max (36) minus the "-tp"/"-sl" suffix of entryTpsl child legs. */
export const ARCUS_TPSL_CLIENT_ID_MAX = 33;
/** Metadata (ids, ticks, steps) cache; prices are always re-fetched where they matter. */
const MARKETS_TTL_MS = 60_000;
const ORDERBOOK_LEVELS = 50;
const CLIENT_ID_HISTORY_SCAN = 200;
/** GET /v1/openOrders page cap (default = max = 1000). */
const OPEN_ORDERS_PAGE = 1000;
const CANDLE_TIMEFRAMES: ReadonlySet<string> = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w"]);
/** Bar length (ms) per timeframe — sizes the GET /v1/candles windows. */
const CANDLE_MS: Readonly<Record<string, number>> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
  "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
};
/**
 * GET /v1/candles returns at most 1500 candles (newest first; live 2026-10-13: a 48 h 1m request
 * answers `total: 1500` covering the newest ~25 h). Ranges are read in windows of this many bars.
 */
const CANDLE_WINDOW_BARS = 1450;
/** Window cap per call (≈ 72 500 bars); a wider range is refused rather than truncated. */
const CANDLE_MAX_WINDOWS = 50;

// ── Raw response shapes (docs openapi) ──

interface RawOrder {
  orderId: string;
  clientId?: string;
  marketId: number;
  marketDisplayName: string;
  side: "BUY" | "SELL";
  type?: "LIMIT" | "MARKET";
  status: string;
  price: string;
  originalSize: string;
  filledSize?: string;
  remainingSize: string;
  avgFillPrice?: string;
  timeInForce?: string;
  goodTilTime?: string;
  reduceOnly?: boolean;
  triggerPrice?: string;
  tpslType?: string;
  createdAt?: number;
  updatedAt: number;
}

interface RawPlaceResponse {
  orderId: string;
  clientId?: string;
  status: string;
  /** OrderResponse.quantity (required on placeOrder; absent on modify/batch rows). */
  quantity?: string;
  filledSize?: string;
  remainingSize?: string;
  rejectionReason?: string;
  error?: string;
}

interface RawBatchResponse { responses: Array<RawPlaceResponse & { marketId: number }> }

interface RawCancelResponse {
  orderId?: string;
  clientId?: string;
  status: string;
  rejectionReason?: string;
}

interface RawPosition {
  marketId: number;
  marketDisplayName: string;
  side: "LONG" | "SHORT";
  size: string;
  averageEntryPrice: string;
  leverage: string;
  marginMode: "CROSS" | "ISOLATED";
  marginUsed: string;
  unrealizedPnl: string;
  markPx: string;
}

interface RawAccount { equity: string; freeCollateral: string }

interface RawFill {
  tradeId: string;
  orderId: string;
  marketDisplayName: string;
  side: "BUY" | "SELL";
  size: string;
  price: string;
  fee: string;
  createdAt: number;
}

interface RawSetLeverage {
  leverage: number;
  marginMode?: "CROSS" | "ISOLATED";
  status: "ACK" | "APPLIED" | "REJECTED";
  rejectReason?: string;
}

// ── Helpers ──

const STATUS_MAP: Readonly<Record<string, OrderStatus>> = {
  ACK: "accepted",
  PENDING: "accepted",
  TPSL_TRIGGERED: "accepted",
  CANCEL_ACKNOWLEDGED: "accepted",
  CANCEL_PENDING: "accepted",
  OPEN: "open",
  UNTRIGGERED: "open",
  TPSL_PLACED: "open",
  PARTIALLY_FILLED: "partiallyFilled",
  FILLED: "filled",
  LIQUIDATED: "filled",
  ADL: "filled",
  CANCELED: "cancelled",
  MARGIN_CANCELED: "cancelled",
  TPSL_CANCELED: "cancelled",
  REJECTED: "rejected",
};

function mapStatus(s: string): OrderStatus {
  const m = STATUS_MAP[s];
  if (!m) throw new PerpError("EXCHANGE_ERROR", `Arcus: unknown order status "${s}"`);
  return m;
}

function finalityOf(s: OrderStatus): "final" | "pending" {
  return s === "filled" || s === "rejected" || s === "cancelled" ? "final" : "pending";
}

const usToMs = (us: number): number => Math.floor(us / 1000);

function sideLower(s: "BUY" | "SELL"): "buy" | "sell" { return s === "BUY" ? "buy" : "sell"; }

function tifFromRead(t: string | undefined): ArcusTif {
  // Reads report resting (GTT) orders as the legacy "GTC".
  switch (t) {
    case "GTC": case "GTT": return "GTT";
    case "IOC": return "IOC";
    case "FOK": return "FOK";
    case "ALO": return "ALO";
    default: throw new PerpError("EXCHANGE_ERROR", `Arcus: unknown timeInForce "${String(t)}" on order`);
  }
}

/** Common / venue TIF → Arcus wire TIF. GTC (resting until cancelled) is sent as GTT at the max horizon. */
function toArcusTif(venue: VenueDefinition, t: string): ArcusTif {
  if (t === "GTC") return "GTT";
  if (t === "GTT" || t === "IOC" || t === "FOK" || t === "ALO") return t;
  throw unsupported(venue.displayName, "timeInForce", `time-in-force ${t} is not offered`, "Use one of: GTC, IOC, FOK, ALO");
}

/** All-null execution record with the given method (fields set by the caller). */
function execution(method: string, partial: Partial<Omit<OrderExecution, "method">>): OrderExecution {
  return {
    method,
    slippageBps: partial.slippageBps ?? null,
    slippageSource: partial.slippageSource ?? null,
    protectionPrice: partial.protectionPrice ?? null,
    referencePrice: partial.referencePrice ?? null,
    tifRequested: partial.tifRequested ?? null,
    tifSent: partial.tifSent ?? null,
    expiresAt: partial.expiresAt ?? null,
    builderFee: partial.builderFee ?? null,
    notes: partial.notes ?? [],
  };
}

/** |protection − reference| in bps after tick alignment (the bound actually applied). */
function appliedBps(protection: string, ref: string): number {
  return Number((Math.abs(Number(protection) - Number(ref)) / Number(ref) * 10_000).toFixed(4));
}

/** goodTilTime (µs, decimal string) → unix ms; null when absent. */
function goodTilMs(us: string | undefined): number | null {
  return us === undefined ? null : Number(BigInt(us) / 1000n);
}

/** Execution record for an order read back from the venue (status reads). */
function readExecution(o: RawOrder): OrderExecution {
  const method = o.tpslType ? (o.type === "LIMIT" ? "triggerLimit" : "trigger") : "limit";
  const resting = o.timeInForce === "GTC" || o.timeInForce === "GTT" || o.timeInForce === "ALO";
  return execution(method, {
    tifSent: o.timeInForce === "GTC" ? "GTT" : (o.timeInForce ?? null),
    expiresAt: resting ? goodTilMs(o.goodTilTime) : null,
    referencePrice: o.triggerPrice ?? null,
  });
}

/**
 * Placement grid tick for a price: tickTiers band tick, or the top-level tickSize.
 * `upToPrice` is an EXCLUSIVE upper bound (openapi MarketInfo.tickTiers), so a
 * price equal to it belongs to the next band — hence `p < upToPrice`.
 */
function tickForPrice(m: ArcusRawMarket, price: string): string {
  if (!m.tickTiers || m.tickTiers.length === 0) return m.tickSize;
  const p = Number(price);
  for (const t of m.tickTiers) {
    if (t.upToPrice === undefined || p < Number(t.upToPrice)) return t.tick;
  }
  return m.tickTiers[m.tickTiers.length - 1].tick;
}

/** goodTilTime (unix ms) for a placement made now: now + ARCUS_GOOD_TIL_HORIZON_MS. */
function goodTilAtMs(): number {
  return Date.now() + ARCUS_GOOD_TIL_HORIZON_MS;
}

function isArcusMeta(a: unknown): a is ArcusAgentMeta {
  return !!a && typeof a === "object" && (a as { kind?: unknown }).kind === "arcus";
}

interface MarketIndex { at: number; bySymbol: Map<string, ArcusRawMarket>; byId: Map<number, ArcusRawMarket> }

/** One element of a placement (single order or batch leg), unsigned. */
interface Leg {
  side: "buy" | "sell";
  size: string;
  quantums: bigint;
  price: string;
  priceTicks: bigint;
  tif: ArcusTif;
  orderType: "LIMIT" | "MARKET";
  reduceOnly: boolean;
  clientId: string;
  tpsl: { type: "STOP_LOSS" | "TAKE_PROFIT"; stopPrice: string } | null;
}

export class ArcusAdapter implements ExchangeAdapter, TradingV2 {
  readonly name = "arcus" as const;
  readonly venue: VenueDefinition;
  readonly network: Network;
  private readonly caps: VenueCapabilities;
  private readonly client: ArcusClient;
  private readonly account: { owner: `0x${string}`; sub: number } | null;
  private readonly masterCreds: { wallet: string; passphrase: string | null } | null;
  private readonly masterPk: string | null;
  private markets: MarketIndex | null = null;

  constructor(def: VenueDefinition, ctx: VenueCreateContext) {
    this.venue = def;
    this.network = ctx.network;
    this.caps = requireCapabilities(def);
    networkConfig(def, ctx.network); // throws when the network is not offered

    if (ctx.readOnly) {
      this.client = new ArcusClient(ctx.network, null);
      this.account = null;
      this.masterCreds = null;
      this.masterPk = null;
      return;
    }
    this.masterCreds = ctx.credentials.owsWallet !== null
      ? { wallet: ctx.credentials.owsWallet, passphrase: ctx.credentials.owsPassphrase }
      : null;
    this.masterPk = ctx.credentials.pk;
    const hasMaster = this.masterCreds !== null || this.masterPk !== null;
    // --no-agent ignores the agent key; an absent agent key is the same situation.
    const meta = ctx.noAgent ? null : ctx.credentials.agent;
    if (meta === null) {
      if (!hasMaster) {
        // no agent key and no master EVM key — nothing can sign.
        throw new PerpError("NO_SIGNER_AVAILABLE", "No Arcus signer: no agent API key and no master EVM wallet / private key", {
          remediation: "Spot swaps: pass --wallet <ows-wallet> (master EVM key). Perp trading: perp wallet agent approve arcus --master <ows-wallet>",
        });
      }
      // Master-only (also --no-agent): spot swaps (master EVM signer) work; perp
      // private calls throw AGENT_NOT_REGISTERED in requireAccount().
      this.client = new ArcusClient(ctx.network, null);
      this.account = null;
      return;
    }
    if (!isArcusMeta(meta)) {
      throw new PerpError("AGENT_NOT_REGISTERED", "No Arcus agent API key configured", {
        remediation: "Run: perp wallet agent approve arcus --master <ows-wallet>",
      });
    }
    if (meta.network !== ctx.network) {
      throw new PerpError("AGENT_NOT_REGISTERED", `Arcus API key "${meta.agentName}" was registered on ${String(meta.network)}, not ${ctx.network}`, {
        remediation: `Register a ${ctx.network} key: perp wallet agent approve arcus --master <ows-wallet>${ctx.network === "testnet" ? " -n testnet" : ""}`,
      });
    }
    if (!(Date.parse(meta.validUntil) > Date.now())) {
      throw new PerpError("AGENT_EXPIRED", `Arcus API key "${meta.agentName}" expired at ${meta.validUntil}`, {
        remediation: "Re-register: perp wallet agent approve arcus --master <ows-wallet>",
      });
    }
    if (!(Number.isInteger(meta.accountIndex) && meta.accountIndex >= 0 && meta.accountIndex <= 9)) {
      throw new PerpError("INVALID_PARAMS", `Arcus agent "${meta.agentName}" is scoped to accountIndex ${meta.accountIndex}; trading needs a single subaccount 0–9`, {
        remediation: "Approve a key for one subaccount: perp wallet agent approve arcus --account-index <0-9>",
      });
    }
    // Agent wallets are created with an empty passphrase (Pacifica agent pattern).
    const agentSigner = OwsSolanaSigner.create(meta.agentWalletName, "");
    const pubHex = ed25519PubHexFromBase58(agentSigner.getPublicKeyBase58());
    if (pubHex !== meta.apiKeyHex.toLowerCase()) {
      throw new PerpError("KEY_NOT_FOUND", `OWS wallet "${meta.agentWalletName}" does not hold Arcus API key ${meta.apiKeyHex}`, {
        remediation: "Re-register: perp wallet agent approve arcus --master <ows-wallet>",
      });
    }
    const sign: Ed25519SignFn = m => agentSigner.signMessage(m);
    this.client = new ArcusClient(ctx.network, { apiKeyHex: pubHex, sign, ownerAddress: meta.ownerAddress });
    this.account = { owner: meta.ownerAddress, sub: meta.accountIndex };
  }

  // ── Internals ──

  /**
   * Single guard for every perp private call (orders / cancel / amend /
   * leverage / private reads / withdraw): they all need the Ed25519 agent key.
   * Master-only adapters (spot swaps) and read-only adapters land here.
   */
  private requireAccount(): { owner: `0x${string}`; sub: number } {
    if (!this.account) {
      throw new PerpError("AGENT_NOT_REGISTERED", "Arcus perp calls need an agent API key, and none is registered", {
        exchange: "arcus", remediation: "perp wallet agent approve arcus",
      });
    }
    return this.account;
  }

  private accountQuery(extra: Record<string, string | number | null> = {}): Record<string, string | number | null> {
    const a = this.requireAccount();
    return { address: a.owner, accountIndex: a.sub, ...extra };
  }

  private async loadMarkets(fresh: boolean): Promise<MarketIndex> {
    if (!fresh && this.markets && Date.now() - this.markets.at < MARKETS_TTL_MS) return this.markets;
    const raw = await fetchArcusRawMarkets(this.client);
    const bySymbol = new Map<string, ArcusRawMarket>();
    const byId = new Map<number, ArcusRawMarket>();
    for (const m of raw) {
      bySymbol.set(m.baseAsset.toUpperCase(), m);
      bySymbol.set(m.marketDisplayName.toUpperCase(), m);
      byId.set(m.marketId, m);
    }
    this.markets = { at: Date.now(), bySymbol, byId };
    return this.markets;
  }

  private async market(symbol: string, fresh = false): Promise<ArcusRawMarket> {
    const idx = await this.loadMarkets(fresh);
    const m = idx.bySymbol.get(symbol.toUpperCase());
    if (!m) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Arcus: unknown market "${symbol}"`, {
        remediation: "List markets with: perp market list -e arcus",
      });
    }
    return m;
  }

  private async symbolOf(marketId: number): Promise<string> {
    let m = (await this.loadMarkets(false)).byId.get(marketId);
    if (!m) m = (await this.loadMarkets(true)).byId.get(marketId);
    if (!m) throw new PerpError("EXCHANGE_ERROR", `Arcus: unknown marketId ${marketId}`);
    return m.baseAsset;
  }

  /** Protection price: slippage from `ref`, aligned toward crossing on the tier tick, ≤ 10 % from `ref`. */
  private protectionPrice(m: ArcusRawMarket, ref: string, side: "buy" | "sell", bps: number, what: string): string {
    const raw = slippagePrice(ref, side, bps);
    const aligned = alignProtectionPrice(raw, tickForPrice(m, raw), side);
    const dev = Math.abs(Number(aligned) - Number(ref)) / Number(ref);
    if (dev > ARCUS_MAX_PROTECTION_DEVIATION) {
      throw new PerpError("INVALID_PARAMS", `Arcus: protection price ${aligned} is ${(dev * 100).toFixed(2)}% from ${what} ${ref} (max 10%)`, {
        remediation: "Lower --slippage-bps (Arcus rejects protection prices more than 10% from mark)",
      });
    }
    return aligned;
  }

  /** Limit price must sit on its tier's tick; the signed integer always uses the top-level tickSize. */
  private limitTicks(m: ArcusRawMarket, price: string): bigint {
    requirePositive(price, "price");
    toUnitsExact(price, tickForPrice(m, price), "price");
    return toUnitsExact(price, m.tickSize, "price");
  }

  private leg(m: ArcusRawMarket, p: Omit<Leg, "quantums" | "priceTicks" | "size"> & { size: string }): Leg {
    const size = floorSize(p.size, m.stepSize);
    const priceTicks = this.limitTicks(m, p.price);
    // docs.arcus.xyz GET /markets → minOrderNotional: "Flat minimum order notional (`quantity` ×
    // `price`, decimal USD) on position-opening orders. Reduce-only orders (including TPSLs) are
    // exempt." Pre-checked from the market's own value (null = the venue published none).
    if (!p.reduceOnly && m.minOrderNotional !== null) {
      const notional = mulDecimal(size, p.price);
      if (subDecimal(notional, m.minOrderNotional).startsWith("-")) {
        throw new PerpError("SIZE_TOO_SMALL", `Arcus ${m.marketDisplayName}: order notional ${notional} (${size} × ${p.price}) is below the market minimum ${m.minOrderNotional} USD; nothing was sent`, {
          exchange: "arcus", remediation: `Raise the size to at least ${m.minOrderNotional} USD notional (reduce-only orders are exempt)`,
        });
      }
    }
    return { ...p, size, quantums: toUnitsExact(size, m.stepSize, "size"), priceTicks };
  }

  private async signLeg(m: ArcusRawMarket, leg: Leg, ctNs: bigint, g: bigint): Promise<{ body: Record<string, unknown>; signature: string }> {
    const a = this.requireAccount();
    const auth = this.client.requireAuth();
    assertArcusClientId(leg.clientId);
    const payload = placePayload({
      address: a.owner, accountIndex: a.sub, clientId: leg.clientId, ctNs, goodTilNs: g * 1000n,
      marketId: m.marketId, priceTicks: leg.priceTicks, quantums: leg.quantums, reduceOnly: leg.reduceOnly,
      side: leg.side, tif: leg.tif,
    }, leg.tpsl !== null);
    const signature = await signUtf8Hex(auth.sign, payload);
    const body: Record<string, unknown> = {
      address: a.owner,
      accountIndex: a.sub,
      marketId: m.marketId,
      orderSide: leg.side === "buy" ? "BUY" : "SELL",
      orderType: leg.orderType,
      quantity: leg.size,
      price: leg.price,
      timeInForce: leg.tif,
      goodTilTime: g.toString(),
      reduceOnly: leg.reduceOnly,
      clientId: leg.clientId,
      clientTime: ctNs.toString(),
      timestamp: ctNs,
      ...(leg.tpsl ? { tpslType: leg.tpsl.type, stopPrice: leg.tpsl.stopPrice } : {}),
    };
    return { body, signature };
  }

  /**
   * Placement / modify acknowledgement → OrderResult.
   *
   * filledSize (M9): on the 202 path the body is an ACK "carrying no terminal
   * state" and the enrichment fields (filledSize, remainingSize) are omitted
   * (openapi OrderResponse / BatchOrderItemResponse / ModifyOrderResponse). An
   * ACK has not been matched yet, so it has no fills by definition: "0" is used
   * ONLY for status "accepted" (finality pending). On the 200 path the fill is
   * read from filledSize, else derived as quantity − remainingSize (the docs
   * define filledSize = originalSize − remainingSize); otherwise it is unknown
   * and EXCHANGE_ERROR is thrown (the order exists — do not retry blindly).
   */
  private resultFromPlace(symbol: string, r: RawPlaceResponse, fallbackClientId: string | null, raw: unknown, exec: OrderExecution): OrderResult {
    if (r.status === "ERROR") {
      throw arcusRejectionError(r.rejectionReason, `Arcus order rejected: ${r.error ?? r.rejectionReason ?? "ERROR"}`, { venueRaw: raw });
    }
    const status = mapStatus(r.status);
    let filledSize: string;
    if (r.filledSize !== undefined) {
      filledSize = r.filledSize;
    } else if (r.quantity !== undefined && r.remainingSize !== undefined) {
      filledSize = subDecimal(r.quantity, r.remainingSize);
    } else if (status === "accepted") {
      filledSize = "0"; // ACK: not yet matched → no fills (see above)
    } else {
      throw new PerpError("EXCHANGE_ERROR", `Arcus returned status ${r.status} for order ${r.orderId} without a fill size`, {
        venueRaw: raw,
        remediation: `The order exists; do not resubmit. Check it: perp trade status ${r.orderId} --symbol ${symbol} -e arcus`,
      });
    }
    const clientOrderId = r.clientId ?? fallbackClientId;
    const orderId = r.orderId || null;
    if (orderId === null && clientOrderId === null) {
      throw new PerpError("EXCHANGE_ERROR", "Arcus acknowledgement carries neither orderId nor clientId", { venueRaw: raw });
    }
    return {
      venue: "arcus",
      symbol,
      status,
      finality: finalityOf(status),
      orderId,
      clientOrderId,
      filledSize,
      avgPrice: null,
      execution: exec,
      venueRaw: raw,
    };
  }

  /** Order shape: filledSize is optional and documented as originalSize − remainingSize (both required). */
  private filledOf(o: RawOrder): string {
    return o.filledSize ?? subDecimal(o.originalSize, o.remainingSize);
  }

  private orderResultFromRaw(symbol: string, o: RawOrder): OrderResult {
    const status = mapStatus(o.status);
    return {
      venue: "arcus",
      symbol,
      status,
      finality: finalityOf(status),
      orderId: o.orderId,
      clientOrderId: o.clientId ?? null,
      filledSize: this.filledOf(o),
      avgPrice: o.avgFillPrice ?? null,
      execution: readExecution(o),
      venueRaw: o,
    };
  }

  /** TP/SL classification of a reduce-only trigger relative to the current mark. */
  private tpslType(side: "buy" | "sell", trigger: string, mark: string): "STOP_LOSS" | "TAKE_PROFIT" {
    const t = Number(trigger);
    const mk = Number(mark);
    if (t === mk) {
      throw new PerpError("INVALID_PARAMS", `Arcus: trigger ${trigger} equals mark ${mark}; cannot classify as TP or SL`);
    }
    // Closing a long (sell): below mark = stop loss. Closing a short (buy): above mark = stop loss.
    return side === "sell" ? (t < mk ? "STOP_LOSS" : "TAKE_PROFIT") : (t > mk ? "STOP_LOSS" : "TAKE_PROFIT");
  }

  private async findOrder(m: ArcusRawMarket, ref: OrderRef): Promise<RawOrder> {
    if (ref.kind === "orderId") {
      try {
        return await this.client.get<RawOrder>(`/v1/order/${encodeURIComponent(ref.value)}`, "order", this.accountQuery());
      } catch (e) {
        // GET /v1/order/{id}: 404 = "Order not found" (openapi), whatever the message text.
        if (e instanceof PerpError && e.structured.details?.status === 404 && e.structured.code === "EXCHANGE_ERROR") {
          throw new PerpError("ORDER_NOT_FOUND", e.message, e.structured.details);
        }
        throw e;
      }
    }
    const open = await this.client.get<{ orders: RawOrder[] }>("/v1/openOrders", "openOrders", this.accountQuery({ market: m.marketDisplayName }));
    const hit = open.orders.find(o => o.clientId === ref.value);
    if (hit) return hit;
    const hist = await this.client.get<{ orders: RawOrder[] }>("/v1/orders", "orders",
      this.accountQuery({ market: m.marketDisplayName, limit: CLIENT_ID_HISTORY_SCAN }));
    const past = hist.orders.find(o => o.clientId === ref.value);
    if (past) return past;
    throw new PerpError("ORDER_NOT_FOUND", `Arcus: no order with clientId "${ref.value}" on ${m.marketDisplayName}`, {
      remediation: `Only the newest ${CLIENT_ID_HISTORY_SCAN} orders of the market are scanned; query by server order id instead`,
    });
  }

  // ── TradingV2 ──

  async getVenueMarkets(): Promise<VenueMarket[]> {
    const raw = await fetchArcusRawMarkets(this.client);
    return onlineArcusMarkets(raw).map(toArcusVenueMarket);
  }

  async placeOrder(input: OrderRequest): Promise<OrderResult> {
    // GTC is the uniform default for a limit order without a TIF.
    const tifRequested = input.tif;
    const req: OrderRequest = input.type === "limit" && input.tif === null ? { ...input, tif: "GTC" } : input;
    validateOrderRequest(this.venue, this.caps, req);
    this.requireAccount();
    const clientId = req.clientOrderId;
    if (clientId === null) throw new PerpError("INVALID_PARAMS", "unreachable: validateOrderRequest enforces clientOrderId for async venues");
    assertArcusClientId(clientId);

    const isStop = req.type === "stopMarket" || req.type === "stopLimit";
    const needsMark = req.type === "market" || isStop || req.tpsl !== null;
    const m = await this.market(req.symbol, needsMark);
    if (m.status !== "ONLINE") {
      throw new PerpError("INVALID_PARAMS", `Arcus market ${m.marketDisplayName} is ${m.status}`, { remediation: "Market is not tradable right now" });
    }
    const mark = m.markPrice;
    if (needsMark && (mark === undefined || !(Number(mark) > 0))) {
      throw new PerpError("PRICE_STALE", `Arcus ${m.marketDisplayName}: no mark price`);
    }
    // One goodTil for every leg of this placement; resting legs report it as expiresAt.
    const gMs = goodTilAtMs();
    const g = BigInt(gMs) * 1000n;

    // Stop orders: a single reduce-only TPSL leg in a partialTpsl group.
    if (isStop) {
      const trigger = req.triggerPrice as string;           // validated non-null
      toUnitsExact(trigger, tickForPrice(m, trigger), "trigger price");
      const type = this.tpslType(req.side, trigger, mark as string);
      let leg: Leg;
      let exec: OrderExecution;
      if (req.type === "stopMarket") {
        if (req.slippage === null) {
          throw new PerpError("INVALID_PARAMS", "Arcus stop-market legs are protection-priced; the order is missing its resolved slippage bound");
        }
        const px = this.protectionPrice(m, trigger, req.side, req.slippage.bps, "trigger price");
        leg = this.leg(m, { side: req.side, size: req.size, price: px, tif: "IOC", orderType: "MARKET", reduceOnly: true, clientId, tpsl: { type, stopPrice: trigger } });
        exec = execution("trigger", {
          slippageBps: appliedBps(px, trigger), slippageSource: req.slippage.source, protectionPrice: px, referencePrice: trigger, tifSent: "IOC",
          notes: [`${type} leg (partialTpsl); protection price = trigger ± ${req.slippage.bps} bps — may not fill if the price gaps past it`],
        });
      } else {
        const tif = toArcusTif(this.venue, req.tif as string);
        if (tif !== "GTT") {
          throw unsupported(this.venue.displayName, "timeInForce", `stop-limit (TPSL LIMIT) orders rest until triggered (GTC); got ${req.tif}`, "Pass --tif GTC or omit it");
        }
        leg = this.leg(m, { side: req.side, size: req.size, price: req.price as string, tif: "GTT", orderType: "LIMIT", reduceOnly: true, clientId, tpsl: { type, stopPrice: trigger } });
        exec = execution("triggerLimit", {
          referencePrice: trigger, tifRequested: req.tif, tifSent: "GTT", expiresAt: gMs,
          notes: [`${type} leg (partialTpsl)`, ...(req.tif === "GTC" ? [`GTC sent as GTT; expires ${new Date(gMs).toISOString()}`] : [])],
        });
      }
      return this.withFloorNote(await this.sendBatch(req.symbol, m, "partialTpsl", [leg], g, exec), req.size, leg.size);
    }

    let entry: Leg;
    let exec: OrderExecution;
    if (req.type === "market") {
      const slippage = req.slippage as ResolvedSlippage; // validated non-null for market
      const px = this.protectionPrice(m, mark as string, req.side, slippage.bps, "mark");
      entry = this.leg(m, { side: req.side, size: req.size, price: px, tif: "IOC", orderType: "LIMIT", reduceOnly: req.reduceOnly, clientId, tpsl: null });
      exec = execution("protectedIoc", {
        slippageBps: appliedBps(px, mark as string), slippageSource: slippage.source, protectionPrice: px, referencePrice: mark as string, tifSent: "IOC",
        notes: [`resolved bound ${slippage.bps} bps (${slippage.source}); protection price aligned to the tier tick on the mark price`],
      });
    } else {
      const tif = toArcusTif(this.venue, req.tif as string);
      entry = this.leg(m, { side: req.side, size: req.size, price: req.price as string, tif, orderType: "LIMIT", reduceOnly: req.reduceOnly, clientId, tpsl: null });
      const resting = tif === "GTT" || tif === "ALO";
      exec = execution("limit", {
        tifRequested, tifSent: tif, expiresAt: resting ? gMs : null,
        notes: [
          ...(tifRequested === null ? ["no time-in-force given; GTC (uniform default)"] : []),
          ...(req.tif === "GTC" ? [`GTC sent as GTT; expires ${new Date(gMs).toISOString()} (venue horizon)`] : []),
        ],
      });
    }

    if (req.tpsl === null) {
      const res = await this.client.postScheme1<RawPlaceResponse>("/v1/placeOrder", "placeOrder", async ct => {
        const { body, signature } = await this.signLeg(m, entry, ct, g);
        return { bodyJson: canonicalJson(body), signatureHex: signature };
      });
      return this.withFloorNote(this.resultFromPlace(req.symbol, res.data, clientId, res.data, exec), req.size, entry.size);
    }
    if (clientId.length > ARCUS_TPSL_CLIENT_ID_MAX) {
      throw new PerpError("INVALID_PARAMS", `Arcus clientId "${clientId}" is ${clientId.length} chars; with TP/SL legs ("-tp"/"-sl" suffix) it must be at most ${ARCUS_TPSL_CLIENT_ID_MAX}`);
    }

    // Entry + bound TP/SL children (entryTpsl). Children are reduce-only MARKET
    // legs whose protection price needs an explicit slippage bound.
    if (req.slippage === null) {
      throw new PerpError("INVALID_PARAMS", "Arcus TP/SL legs execute as MARKET orders; the order is missing its resolved slippage bound");
    }
    const tpslBps = req.slippage.bps;
    const exitSide = req.side === "buy" ? "sell" : "buy";
    const legs: Leg[] = [entry];
    for (const [kind, trig] of [["TAKE_PROFIT", req.tpsl.tp], ["STOP_LOSS", req.tpsl.sl]] as const) {
      if (trig === null) continue;
      toUnitsExact(trig, tickForPrice(m, trig), "trigger price");
      const px = this.protectionPrice(m, trig, exitSide, tpslBps, "trigger price");
      legs.push(this.leg(m, {
        side: exitSide, size: entry.size, price: px, tif: "IOC", orderType: "MARKET", reduceOnly: true,
        clientId: `${clientId}-${kind === "TAKE_PROFIT" ? "tp" : "sl"}`, tpsl: { type: kind, stopPrice: trig },
      }));
      exec.notes.push(`${kind} leg (entryTpsl): trigger ${trig}, protection price ${px} (${tpslBps} bps, ${req.slippage.source})`);
    }
    return this.withFloorNote(await this.sendBatch(req.symbol, m, "entryTpsl", legs, g, exec), req.size, entry.size);
  }

  /** Size flooring is surfaced, never silent (L2): wrap venueRaw with requested/placed sizes. */
  private withFloorNote(r: OrderResult, requested: string, placed: string): OrderResult {
    if (subDecimal(requested, placed) === "0") return r;
    return { ...r, venueRaw: { requestedSize: requested, placedSize: placed, response: r.venueRaw } };
  }

  /** batchPlaceOrders; returns the first leg's result, throws if any leg failed validation. */
  private async sendBatch(
    symbol: string, m: ArcusRawMarket, grouping: "partialTpsl" | "entryTpsl", legs: Leg[], g: bigint, exec: OrderExecution,
  ): Promise<OrderResult> {
    if (legs.length > (this.caps.batchPlaceMax ?? 0)) throw new PerpError("INVALID_PARAMS", "Arcus batch too large");
    // X-Signature must be present; the batch is verified per element.
    const res = await this.client.postScheme1<RawBatchResponse>("/v1/batchPlaceOrders", "batchPlaceOrders", async ct => {
      const signed = [];
      for (const l of legs) signed.push(await this.signLeg(m, l, ct, g));
      const body = { grouping, orders: signed.map(s => ({ ...s.body, signature: s.signature })) };
      return { bodyJson: canonicalJson(body), signatureHex: signed[0].signature };
    });
    const rows = res.data.responses;
    if (!Array.isArray(rows) || rows.length !== legs.length) {
      throw new PerpError("EXCHANGE_ERROR", "Arcus batchPlaceOrders: unexpected response shape", { venueRaw: res.data });
    }
    const failed = rows.map((r, i) => ({ r, leg: legs[i] })).filter(x => x.r.status === "ERROR");
    if (failed.length > 0) {
      const summary = failed.map(f => `${f.leg.clientId}: ${f.r.error ?? f.r.rejectionReason}`).join("; ");
      const accepted = rows.map((r, i) => ({ r, leg: legs[i] })).filter(x => x.r.status !== "ERROR");
      if (accepted.length === 0) {
        throw arcusRejectionError(failed[0].r.rejectionReason, `Arcus ${grouping}: ${summary}`, { venueRaw: res.data });
      }
      throw new PerpError("ORDER_PARTIAL", `Arcus ${grouping}: some legs failed (${summary}) while others were accepted`, {
        accepted: accepted.map(x => ({ orderId: x.r.orderId || null, clientId: x.leg.clientId, status: x.r.status })),
        venueRaw: res.data,
        remediation: `Do not retry; check open orders and positions: perp account orders -e arcus && perp account positions -e arcus`,
      });
    }
    return this.resultFromPlace(symbol, rows[0], legs[0].clientId, res.data, exec);
  }

  /**
   * modifyOrder (docs modify-order / authentication).
   *
   * Size: the CLI's `req.size` is the new OPEN (unfilled) size, while
   * Arcus modifies take the order's new TOTAL size, filled quantity included
   * (OrderRejectionReason MODIFY_SIZE_ALREADY_FILLED: "the order's new TOTAL size,
   * filled quantity included"). So body `quantity` and signed `q` are
   * filledSize (as read just before) + new open size. A new open size ≤ 0 is a
   * cancel, not a modify. A fill that races the modify shrinks the resting
   * remainder; if fills reach the new total the venue cancels the order and rejects
   * with MODIFY_SIZE_ALREADY_FILLED — reported as the order's read-back (cancelled) state.
   *
   * Identity: the body carries `orderId` only (exactly one of orderId / clientId);
   * the signed payload follows ARCUS_MODIFY_SIGNED_IDENTITY (UNVERIFIED, signing.ts).
   * g/r/s/t echo the resting order; `clientTime` = signed `ct` = X-Timestamp.
   */
  async amendOrder(req: AmendRequest): Promise<OrderResult> {
    const a = this.requireAccount();
    const auth = this.client.requireAuth();
    const m = await this.market(req.symbol);
    const o = await this.findOrder(m, req.ref);
    if (o.marketId !== m.marketId) {
      throw new PerpError("INVALID_PARAMS", `Arcus order ${o.orderId} is on ${o.marketDisplayName}, not ${m.marketDisplayName}`);
    }
    if (o.tpslType) {
      throw unsupported(this.venue.displayName, "amend", "TP/SL orders cannot be modified (MODIFY_TPSL_NOT_SUPPORTED)", "Cancel the TP/SL order and place a new one");
    }
    const newOpen = subDecimal(req.size, "0"); // validates the decimal
    if (newOpen === "0" || newOpen.startsWith("-")) {
      const c = await this.cancelByRef(req.symbol, { kind: "orderId", value: o.orderId });
      if (c.failed.length > 0) {
        throw new PerpError("EXCHANGE_ERROR", `Arcus: amend to size ${req.size} = cancel, and the cancel failed: ${c.failed[0].error}`, { venueRaw: c.venueRaw });
      }
      const st = (c.venueRaw as RawCancelResponse).status;
      return {
        venue: "arcus", symbol: req.symbol, status: st === "CANCELED" ? "cancelled" : "accepted",
        finality: st === "CANCELED" ? "final" : "pending", orderId: o.orderId, clientOrderId: o.clientId ?? null,
        filledSize: this.filledOf(o), avgPrice: o.avgFillPrice ?? null,
        execution: execution("cancel", { notes: [`new open size ${req.size} ≤ 0 → order cancelled instead of modified`] }),
        venueRaw: c.venueRaw,
      };
    }
    if (o.goodTilTime === undefined) {
      throw new PerpError("EXCHANGE_ERROR", `Arcus order ${o.orderId} has no goodTilTime to echo`, { venueRaw: o });
    }
    const openSize = floorSize(req.size, m.stepSize);
    const filled = this.filledOf(o);
    const totalQuantums = toUnitsExact(openSize, m.stepSize, "size") + toUnitsExact(filled, m.stepSize, "filled size");
    const total = unitsToString(totalQuantums, m.stepSize);
    const side = sideLower(o.side);
    const tif = tifFromRead(o.timeInForce);
    if (req.tif !== null && toArcusTif(this.venue, req.tif) !== tif) {
      throw unsupported(this.venue.displayName, "amendTimeInForce", `modify keeps the resting order's time-in-force (${tif}); got ${req.tif}`, "Omit --tif, or cancel and place a new order with the other time-in-force");
    }
    // The modify re-signs reduce-only: a read-back without a boolean reduceOnly would silently
    // turn a reduce-only order into one that can open / flip a position (r=0). Refuse.
    if (typeof o.reduceOnly !== "boolean") {
      throw new PerpError("EXCHANGE_ERROR", `Arcus order ${o.orderId} read-back has no reduceOnly flag (got ${JSON.stringify(o.reduceOnly ?? null)}); refusing to modify`, {
        exchange: "arcus", venueRaw: o,
        remediation: `Cancel it (perp trade cancel ${req.symbol} ${o.orderId} -e arcus) and place a new order`,
      });
    }
    const reduceOnly = o.reduceOnly;
    const gUs = BigInt(o.goodTilTime);
    const priceTicks = this.limitTicks(m, req.price);
    const resting = tif === "GTT" || tif === "ALO";
    const exec = execution("nativeAmend", {
      tifRequested: req.tif, tifSent: tif, expiresAt: resting ? goodTilMs(o.goodTilTime) : null,
      notes: [
        "modifyOrder keeps the resting order's time-in-force, side, reduce-only and goodTil",
        `sent total size ${total} = filled ${filled} + new open ${openSize}`,
      ],
    });
    let res: { data: RawPlaceResponse };
    try {
      res = await this.client.postScheme1<RawPlaceResponse>("/v1/modifyOrder", "modifyOrder", async ct => {
        const payload = modifyPayload({
          address: a.owner, accountIndex: a.sub, clientId: o.clientId ?? null, ctNs: ct, goodTilNs: gUs * 1000n,
          marketId: m.marketId, priceTicks, quantums: totalQuantums, reduceOnly, side, tif,
        }, o.orderId);
        const body = {
          address: a.owner, accountIndex: a.sub, marketId: m.marketId, orderId: o.orderId,
          goodTilTime: o.goodTilTime, quantity: total, price: req.price, side: o.side, timeInForce: tif,
          reduceOnly, clientTime: ct.toString(),
        };
        return { bodyJson: canonicalJson(body), signatureHex: await signUtf8Hex(auth.sign, payload) };
      });
    } catch (e) {
      if (e instanceof PerpError && e.structured.details?.rejectionReason === "MODIFY_SIZE_ALREADY_FILLED") {
        return this.modifyAlreadyFilled(req.symbol, o.orderId, exec);
      }
      throw e;
    }
    if (res.data.status === "ERROR" && res.data.rejectionReason === "MODIFY_SIZE_ALREADY_FILLED") {
      return this.modifyAlreadyFilled(req.symbol, o.orderId, exec);
    }
    const acked = this.resultFromPlace(req.symbol, res.data, o.clientId ?? null, res.data, exec);
    return this.withFloorNote(await this.confirmModify(m, acked, o.orderId, req.price, total), req.size, openSize);
  }

  /**
   * A modify ack (ACK / OPEN) is not the edited order's state: read the order back
   * (GET /v1/order/{id}, bounded 5 × 1 s). Final when it is terminal (filled / cancelled /
   * rejected), or resting with the new price and total size; otherwise the ack stays pending.
   */
  private async confirmModify(m: ArcusRawMarket, acked: OrderResult, orderId: string, price: string, total: string): Promise<OrderResult> {
    if (acked.finality === "final") return acked;
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 1_000));
      let o: RawOrder;
      try {
        o = await this.findOrder(m, { kind: "orderId", value: orderId });
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        continue;
      }
      const read = this.orderResultFromRaw(acked.symbol, o);
      const done = read.finality === "final"
        || ((read.status === "open" || read.status === "partiallyFilled") && Number(o.price) === Number(price) && Number(o.originalSize) === Number(total));
      if (done) {
        return {
          ...read, finality: "final", execution: acked.execution,
          venueRaw: { ack: acked.venueRaw, order: o },
        };
      }
    }
    acked.execution.notes.push(`the edited order was not confirmed at price ${price} / total ${total}${lastErr !== null ? ` (last read error: ${lastErr})` : ""}`);
    return acked;
  }

  /**
   * MODIFY_SIZE_ALREADY_FILLED: fills reached the new total, so the venue cancelled the
   * original order. Report the order's read-back state (cancelled, with its real fills).
   */
  private async modifyAlreadyFilled(symbol: string, orderId: string, exec: OrderExecution): Promise<OrderResult> {
    const m = await this.market(symbol);
    const after = this.orderResultFromRaw(symbol, await this.findOrder(m, { kind: "orderId", value: orderId }));
    return {
      ...after,
      execution: { ...exec, notes: [...exec.notes, "MODIFY_SIZE_ALREADY_FILLED: fills already reached the new size — the original order was cancelled"] },
    };
  }

  async cancelByRef(symbol: string, ref: OrderRef): Promise<CancelResult> {
    const a = this.requireAccount();
    const auth = this.client.requireAuth();
    const m = await this.market(symbol);
    const res = await this.client.postScheme1<RawCancelResponse>("/v1/cancelOrder", "cancelOrder", async ct => {
      const signature = await signUtf8Hex(auth.sign, cancelPayload({ address: a.owner, accountIndex: a.sub, ctNs: ct, marketId: m.marketId, ref }));
      const body = {
        address: a.owner, accountIndex: a.sub, marketId: m.marketId, timestamp: ct,
        ...(ref.kind === "orderId" ? { kind: "orderId", orderId: ref.value } : { kind: "clientId", clientId: ref.value }),
      };
      return { bodyJson: canonicalJson(body), signatureHex: signature };
    });
    const st = res.data.status;
    // CANCEL_ACKNOWLEDGED (202) = forwarded to the engine; CANCELED (200) = definitive.
    if (st === "CANCEL_ACKNOWLEDGED" || st === "CANCELED") {
      return { venue: "arcus", cancelled: [ref], failed: [], venueRaw: res.data };
    }
    return { venue: "arcus", cancelled: [], failed: [{ ref, error: res.data.rejectionReason ?? st }], venueRaw: res.data };
  }

  /**
   * Every open order (GET /v1/openOrders pages hold ≤ 1000 rows, newest first; the next
   * page is `to` = the oldest `createdAt` seen, inclusive → dedupe by orderId).
   */
  private async allOpenOrders(market: string | null): Promise<RawOrder[]> {
    const seen = new Map<string, RawOrder>();
    let to: number | null = null;
    for (;;) {
      const page = await this.client.get<{ orders: RawOrder[] }>("/v1/openOrders", "openOrders",
        this.accountQuery({ market, limit: OPEN_ORDERS_PAGE, to }));
      let added = 0;
      for (const o of page.orders) {
        if (!seen.has(o.orderId)) { seen.set(o.orderId, o); added++; }
      }
      if (page.orders.length < OPEN_ORDERS_PAGE) return [...seen.values()];
      if (added === 0) {
        throw new PerpError("EXCHANGE_ERROR", `Arcus openOrders: a full page of ${OPEN_ORDERS_PAGE} rows added no new order — cannot page further`, {
          remediation: "Cancel per market (perp trade cancel-all <symbol> -e arcus) and retry",
        });
      }
      const oldest = Math.min(...page.orders.map(o => {
        if (o.createdAt === undefined) {
          throw new PerpError("EXCHANGE_ERROR", "Arcus openOrders row without createdAt — cannot page past 1000 open orders", { venueRaw: o });
        }
        return o.createdAt;
      }));
      to = oldest;
    }
  }

  async cancelAllV2(symbol: string | null): Promise<CancelResult> {
    const a = this.requireAccount();
    const m = symbol !== null ? await this.market(symbol) : null;
    const open = { orders: await this.allOpenOrders(m ? m.marketDisplayName : null) };
    const body: Record<string, unknown> = { accountIndex: a.sub, address: a.owner, ...(m ? { marketId: m.marketId } : {}) };
    const res = await this.client.postScheme2<{ status: string }>("cancelAllOrders", body);
    if (res.data.status !== "CANCEL_ALL_ACKNOWLEDGED") {
      throw new PerpError("EXCHANGE_ERROR", `Arcus cancelAllOrders: unexpected status ${res.data.status}`, { venueRaw: res.data });
    }
    // Acknowledged: the orders open just before the request are being cancelled by the engine.
    return {
      venue: "arcus",
      cancelled: open.orders.map(o => ({ kind: "orderId", value: o.orderId })),
      failed: [],
      venueRaw: res.data,
    };
  }

  async applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult> {
    const a = this.requireAccount();
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new PerpError("INVALID_PARAMS", `Arcus leverage must be a positive integer (got ${leverage})`);
    }
    const m = await this.market(symbol);
    const body: Record<string, unknown> = {
      accountIndex: a.sub, address: a.owner, leverage, marketId: m.marketId,
      ...(marginMode !== null ? { isolated: marginMode === "isolated" } : {}),
    };
    const res = await this.client.postScheme2<RawSetLeverage>("setLeverage", body);
    if (res.data.status === "REJECTED") {
      throw arcusLeverageRejectError(res.data.rejectReason, `Arcus setLeverage rejected: ${res.data.rejectReason ?? "REJECTED"}`, { venueRaw: res.data });
    }
    let mode: "cross" | "isolated";
    if (res.data.marginMode) {
      mode = res.data.marginMode === "ISOLATED" ? "isolated" : "cross";
    } else {
      const lev = await this.client.get<{ leverages: Array<{ marketId: number; marginMode: "CROSS" | "ISOLATED" }> }>(
        "/v1/leverages", "leverages", this.accountQuery());
      const entry = lev.leverages.find(l => l.marketId === m.marketId);
      if (!entry) throw new PerpError("EXCHANGE_ERROR", `Arcus /v1/leverages: no entry for ${m.marketDisplayName}`);
      mode = entry.marginMode === "ISOLATED" ? "isolated" : "cross";
    }
    return { venue: "arcus", symbol, leverage: res.data.leverage, marginMode: mode, venueRaw: res.data };
  }

  /**
   * Per-market leverage / margin mode: GET /v1/leverages (docs.arcus.xyz openapi getLeverages:
   * "Returns the effective leverage and margin mode (CROSS/ISOLATED) for `(address,
   * accountIndex)` across every market … Each entry reflects the user's leverage override (set
   * via `POST /v1/setLeverage`) when one exists, otherwise the market default"; LeverageEntry
   * requires marketId, marketDisplayName, leverage (integer ≥ 1), isolated, marginMode).
   */
  async getMarketSettings(): Promise<Array<{ symbol: string; leverage: number; marginMode: "cross" | "isolated" }>> {
    const res = await this.client.get<{ leverages: Array<{ marketId: number; leverage: number; marginMode: "CROSS" | "ISOLATED" }> }>(
      "/v1/leverages", "leverages", this.accountQuery());
    if (!Array.isArray(res.leverages)) throw new PerpError("EXCHANGE_ERROR", "Arcus /v1/leverages: no leverages list");
    const out: Array<{ symbol: string; leverage: number; marginMode: "cross" | "isolated" }> = [];
    for (const l of res.leverages) {
      if (!Number.isInteger(l.leverage) || l.leverage < 1 || (l.marginMode !== "CROSS" && l.marginMode !== "ISOLATED")) {
        throw new PerpError("EXCHANGE_ERROR", `Arcus /v1/leverages: unreadable entry ${JSON.stringify(l).slice(0, 160)}`);
      }
      out.push({ symbol: await this.symbolOf(l.marketId), leverage: l.leverage, marginMode: l.marginMode === "ISOLATED" ? "isolated" : "cross" });
    }
    return out;
  }

  async getOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    const m = await this.market(symbol);
    const r = this.orderResultFromRaw(symbol, await this.findOrder(m, ref));
    // A resting order read back from the venue's order store is a settled observation of this
    // read (it is on the book) — final, like the terminal states. Only an order the venue has
    // merely accepted (not yet on the book) stays pending.
    return r.status === "open" || r.status === "partiallyFilled" ? { ...r, finality: "final" } : r;
  }

  // ── Legacy: market data ──

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    return (await this.getVenueMarkets()).map(toLegacyMarketInfo);
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const m = await this.market(symbol);
    const ob = await this.client.get<{ bids: [string, string][]; asks: [string, string][] }>(
      `/v1/l2OrderBook/${encodeURIComponent(m.marketDisplayName)}`, "l2OrderBook", { nLevels: ORDERBOOK_LEVELS });
    return { bids: ob.bids, asks: ob.asks };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<ExchangePublicTrade[]> {
    const m = await this.market(symbol);
    const res = await this.client.get<{ trades: Array<{ side: "BUY" | "SELL"; price: string; size: string; timestamp: number }> }>(
      "/v1/trades", "trades", { market: m.marketDisplayName, limit });
    // Public tape carries no fee; "0" follows the legacy ExchangeTrade convention for public trades.
    return res.trades.map(t => ({ time: usToMs(t.timestamp), symbol: m.baseAsset, side: sideLower(t.side), price: t.price, size: t.size, fee: null }));
  }

  async getFundingHistory(symbol: string, limit = 100): Promise<{ time: number; rate: string; price: string | null }[]> {
    const m = await this.market(symbol);
    const res = await this.client.get<{ fundingRates: Array<{ fundingRate: string; time: number }> }>(
      "/v1/fundingRates", "fundingRates", { market: m.marketDisplayName, limit });
    return res.fundingRates.map(f => ({ time: usToMs(f.time), rate: f.fundingRate, price: null }));
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    if (!CANDLE_TIMEFRAMES.has(interval)) {
      throw new PerpError("INVALID_PARAMS", `Arcus: unsupported candle interval "${interval}"`, {
        remediation: `Use one of: ${[...CANDLE_TIMEFRAMES].join(", ")}`,
      });
    }
    const m = await this.market(symbol);
    const span = CANDLE_WINDOW_BARS * CANDLE_MS[interval];
    const windows = Math.max(1, Math.ceil((endTime - startTime) / span));
    if (windows > CANDLE_MAX_WINDOWS) {
      throw new PerpError("INVALID_PARAMS", `Arcus: ${interval} candles over this range need ${windows} requests (max ${CANDLE_MAX_WINDOWS})`, {
        remediation: "Narrow --start / --end or use a longer interval",
      });
    }
    // Disjoint windows [from, to) — the venue caps one response at 1500 candles, so one wide
    // request would silently drop the oldest bars. Merged and deduped by open time.
    const byTime = new Map<number, ExchangeKline>();
    for (let from = startTime; from < endTime; from += span) {
      const to = Math.min(from + span, endTime);
      const res = await this.client.get<{ candles: Array<{ openTime: number; open: string; high: string; low: string; close: string; volume: string; tradeCount: number }> }>(
        "/v1/candles", "candles", { market: m.marketDisplayName, timeframe: interval, from: from * 1000, to: to * 1000 });
      for (const c of res.candles) {
        const time = usToMs(c.openTime);
        byTime.set(time, { time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, quoteVolume: null, trades: c.tradeCount });
      }
    }
    return [...byTime.values()].sort((x, y) => x.time - y.time);
  }

  // ── Legacy: account ──

  private async rawPositions(): Promise<RawPosition[]> {
    const res = await this.client.get<{ positions: Record<string, RawPosition> }>("/v1/positions", "positions", this.accountQuery());
    return Object.values(res.positions);
  }

  async getBalance(): Promise<ExchangeBalance> {
    const acct = await this.client.get<RawAccount>("/v1/account", "account", this.accountQuery());
    const positions = await this.rawPositions();
    const upnl = positions.reduce((s, p) => s + Number(p.unrealizedPnl), 0);
    return {
      equity: acct.equity,
      available: acct.freeCollateral,
      // freeCollateral = equity − Σ initial margin required (docs), so margin used is the difference.
      marginUsed: String(Number(acct.equity) - Number(acct.freeCollateral)),
      unrealizedPnl: String(upnl),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const out: ExchangePosition[] = [];
    for (const p of await this.rawPositions()) {
      if (Number(p.size) === 0) continue;
      out.push({
        symbol: await this.symbolOf(p.marketId),
        side: p.side === "LONG" ? "long" : "short",
        size: p.size.startsWith("-") ? p.size.slice(1) : p.size,
        entryPrice: p.averageEntryPrice,
        markPrice: p.markPx,
        liquidationPrice: null, // Arcus does not publish a liquidation price
        unrealizedPnl: p.unrealizedPnl,
        leverage: Number(p.leverage),
      });
    }
    return out;
  }

  private async toLegacyOrders(orders: RawOrder[]): Promise<ExchangeOrder[]> {
    const out: ExchangeOrder[] = [];
    for (const o of orders) {
      out.push({
        orderId: o.orderId,
        symbol: await this.symbolOf(o.marketId),
        side: sideLower(o.side),
        price: o.price,
        size: o.originalSize,
        filled: this.filledOf(o),
        status: o.status,
        type: o.tpslType ?? o.type ?? "LIMIT",
        triggerPrice: o.triggerPrice !== undefined && Number(o.triggerPrice) > 0 ? o.triggerPrice : null,
      });
    }
    return out;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    const res = await this.client.get<{ orders: RawOrder[] }>("/v1/openOrders", "openOrders", this.accountQuery());
    return this.toLegacyOrders(res.orders);
  }

  async getOrderHistory(limit = 100): Promise<ExchangeOrder[]> {
    const res = await this.client.get<{ orders: RawOrder[] }>("/v1/orders", "orders", this.accountQuery({ limit }));
    return this.toLegacyOrders(res.orders);
  }

  async getTradeHistory(limit = 100): Promise<ExchangeTrade[]> {
    const res = await this.client.get<{ fills: RawFill[] }>("/v1/fills", "fills", this.accountQuery({ limit }));
    const out: ExchangeTrade[] = [];
    for (const f of res.fills) {
      out.push({ time: usToMs(f.createdAt), symbol: (await this.market(f.marketDisplayName)).baseAsset, side: sideLower(f.side), price: f.price, size: f.size, fee: f.fee });
    }
    return out;
  }

  async getFundingPayments(limit = 100): Promise<ExchangeFundingPayment[]> {
    const res = await this.client.get<{ fundingPayments: Array<{ marketId: number; payment: string; time: number }> }>(
      "/v1/funding", "funding", this.accountQuery({ limit }));
    const out: ExchangeFundingPayment[] = [];
    for (const p of res.fundingPayments) out.push({ time: usToMs(p.time), symbol: await this.symbolOf(p.marketId), payment: p.payment });
    return out;
  }

  // ── Legacy: trading shims ──

  /** `clientOrderId`: the caller's id when given; otherwise one is generated (orderAck async needs one). */
  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderId?: string }): Promise<unknown> {
    return this.placeOrder({
      symbol, side, type: "market", size, price: null, triggerPrice: null, triggerSource: null, tif: null,
      reduceOnly: opts.reduceOnly, clientOrderId: opts.clientOrderId ?? newClientOrderId(),
      slippage: opts.slippage, tpsl: null,
    });
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string; clientOrderId?: string }): Promise<unknown> {
    const tif = opts?.tif !== undefined ? validateLegacyTif(this.venue, this.caps, opts.tif) : null; // null → GTC (placeOrder)
    return this.placeOrder({
      symbol, side, type: "limit", size, price, triggerPrice: null, triggerSource: null, tif,
      reduceOnly: opts?.reduceOnly === true, clientOrderId: opts?.clientOrderId ?? newClientOrderId(), slippage: null, tpsl: null,
    });
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    return this.amendOrder({ symbol, ref: parseOrderRef(orderId), price, size, tif: null }); // keeps the resting TIF
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    return this.cancelByRef(symbol, parseOrderRef(orderId));
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    return this.cancelAllV2(symbol ?? null);
  }

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<unknown> {
    return this.applyLeverage(symbol, leverage, marginMode ?? null);
  }

  /** `opts.slippage` (resolveSlippage() output) is required for a stop-market: its leg is protection-priced at trigger ± bound. */
  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean; triggerType?: "mark" | "last" | "mid"; slippage?: ResolvedSlippage }): Promise<unknown> {
    if (opts?.triggerType !== undefined) {
      throw unsupported(this.venue.displayName, "triggerSource", `no trigger-price source choice (got --trigger-type ${opts.triggerType})`, "Omit --trigger-type for arcus");
    }
    const isLimit = opts?.limitPrice !== undefined;
    return this.placeOrder({
      symbol, side, type: isLimit ? "stopLimit" : "stopMarket", size,
      price: isLimit ? (opts?.limitPrice as string) : null,
      triggerPrice, triggerSource: null, // Arcus does not expose a trigger-source choice
      tif: isLimit ? "GTC" : null, // sent as GTT at the max horizon
      reduceOnly: opts?.reduceOnly === true, // non-reduce-only → CAPABILITY_UNSUPPORTED in validation
      clientOrderId: newClientOrderId(),
      // The caller's resolved bound (the adapter never reads settings);
      // a stop-market without it → INVALID_PARAMS in placeOrder.
      slippage: isLimit ? null : opts?.slippage ?? null,
      tpsl: null,
    });
  }

  // ── Funds ──

  private masterSigner(): Promise<EvmSigner> | EvmSigner {
    if (this.masterCreds) return OwsEvmSigner.create(this.masterCreds.wallet, this.masterCreds.passphrase ?? undefined);
    if (this.masterPk !== null) {
      return import("../../signer/evm-local.js").then(m => m.LocalEvmSigner.create(this.masterPk as string));
    }
    throw new PerpError("NO_SIGNER_AVAILABLE", "Arcus withdrawals need the master wallet signature, which is not on this computer; the agent API key is trade-only", {
      remediation: "Withdraw in the Arcus app, or add the master wallet (perp wallet import --name <name> --chain evm, then --wallet <name>)",
    });
  }

  private requireMasterKey(): void {
    if (this.masterCreds === null && this.masterPk === null) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "Arcus spot swaps are signed by the master EVM wallet, and none is configured", {
        remediation: "Pass the master OWS wallet: --wallet <name>",
      });
    }
  }

  /** Master EVM signer for on-chain actions outside the Arcus API (spot swaps). */
  async masterEvmSigner(): Promise<EvmSigner> {
    this.requireMasterKey();
    return this.masterSigner();
  }

  /** Sign an unsigned EVM transaction with the master key (digest derived here). Returns a 65-byte 0x signature. */
  async signMasterTransaction(tx: import("ethers").Transaction): Promise<string> {
    this.requireMasterKey();
    const { unsignedTxDigest } = await import("../../signer/ows-evm.js");
    const digest = unsignedTxDigest(tx);
    if (this.masterCreds) {
      const { loadOws } = await import("../../signer/ows-loader.js");
      const { canonicalizeOwsSignature } = await import("../../signer/ows-evm.js");
      return canonicalizeOwsSignature(
        loadOws().signHash(this.masterCreds.wallet, "ethereum", digest, this.masterCreds.passphrase ?? undefined),
      );
    }
    const { SigningKey } = await import("ethers");
    const pk = this.masterPk as string;
    return new SigningKey(pk.startsWith("0x") ? pk : `0x${pk}`).sign(digest).serialized;
  }

  /** The only valid withdraw destination: the account owner (needs the agent API key). */
  get withdrawDestination(): `0x${string}` {
    return this.requireAccount().owner;
  }

  /** Withdraw-to-self (Arcus v0 has no separate recipient). `amount` in USDG. */
  async withdraw(amount: string, destination: string, _opts?: { assetId?: number; routeType?: number }): Promise<unknown> {
    const a = this.requireAccount();
    if (destination.toLowerCase() !== a.owner.toLowerCase()) {
      throw new PerpError("INVALID_PARAMS", `Arcus only withdraws to the account owner ${a.owner}`, {
        remediation: `Use destination ${a.owner}`,
      });
    }
    // Arcus withdraw amounts carry at most 6 decimals (USDG); reject before signing anything.
    if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
      throw new PerpError("INVALID_PARAMS", `Arcus withdraw amount must be a plain decimal with at most 6 decimals (got ${amount})`, {
        remediation: "Round the amount to 6 decimals (USDG precision)",
      });
    }
    const quantums = toUnitsExact(amount, QUOTE_QUANTUM, "amount");
    if (quantums < 1_000_000_000n) {
      throw new PerpError("SIZE_TOO_SMALL", `Arcus minimum withdrawal is 1 USDG (got ${amount})`);
    }
    const signer = await this.masterSigner();
    if (signer.getAddress().toLowerCase() !== a.owner.toLowerCase()) {
      throw new PerpError("INVALID_PARAMS", `Master wallet ${signer.getAddress()} does not own Arcus account ${a.owner}`);
    }
    const chainId = networkConfig(this.venue, this.network).signingChainId;
    if (chainId === null) throw new Error("arcus venue definition is missing signingChainId");
    const nonce = nowNs().toString(); // Unix-ns, monotonic per process (docs: nonce = timestamp string)
    const td = withdrawTypedData({ chainId, ethereumAddress: a.owner, accountIndex: a.sub, amountQuantums: quantums, nonce });
    const signature = splitEvmSignature(await signer.signTypedData(td.domain, td.types, td.message));
    const res = await this.client.postUnsigned("/v1/withdraw", "withdraw", {
      ethereumAddress: a.owner, accountIndex: a.sub, amount: quantums.toString(), nonce, signature,
    });
    return res.data;
  }
}
