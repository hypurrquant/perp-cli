/**
 * Venue-level data contracts.
 *
 * SSOT Rule #2: every "unknown" value is `T | null`, never optional, never a
 * silently substituted default.
 */

import type { ExchangeMarketInfo } from "./interface.js";
import type { ResolvedSlippage, SlippageSource } from "./slippage.js";
import type { AppliedBuilderFee } from "./builder-fee.js";

export type VenueId =
  | "pacifica" | "hyperliquid" | "lighter" | "aster"
  | "lighter-rh" | "ondo" | "arcus" | "qfex" | "risex" | "txflow" | "variational" | "grvt";

export type LegacyVenueId = "pacifica" | "hyperliquid" | "lighter" | "aster";

export const VENUE_IDS: readonly VenueId[] = [
  "pacifica", "hyperliquid", "lighter", "aster",
  "lighter-rh", "ondo", "arcus", "qfex", "risex", "txflow", "variational", "grvt",
] as const;

export const LEGACY_VENUE_IDS: readonly LegacyVenueId[] = ["pacifica", "hyperliquid", "lighter", "aster"] as const;

export function isVenueId(s: string): s is VenueId {
  return (VENUE_IDS as readonly string[]).includes(s);
}

export function isLegacyVenueId(s: string): s is LegacyVenueId {
  return (LEGACY_VENUE_IDS as readonly string[]).includes(s);
}

export type Network = "mainnet" | "testnet";

// ── Funding ──

/** How many hours one quoted funding rate covers (used for normalization). */
export type FundingRateBasis = { kind: "perHours"; hours: number } | { kind: "annualized" };

/** Convert a raw quoted rate to a per-hour rate. */
export function rateToHourly(rate: number, basis: FundingRateBasis): number {
  if (basis.kind === "perHours") return rate / basis.hours;
  return rate / (24 * 365);
}

// ── Markets ──

export type AssetClass = "crypto" | "equity" | "index" | "etf" | "commodity" | "fx" | "preIpo";

export interface MarketSession {
  /** Whether the underlying (e.g. US equity) market is open right now. */
  underlyingOpen: boolean;
  /** Venue-enforced price band while the underlying is closed (Ondo weekend band, Arcus). */
  priceBand: { lower: string; upper: string } | null;
  /** Initial-margin multiplier while the underlying is closed (Arcus 1.5x). */
  marginMultiplier: number | null;
}

export interface VenueMarket {
  venue: VenueId;
  /** Venue-native identifier used on the wire ("TSLA-USD.P", "16", "BTC"). */
  venueSymbol: string;
  /** Display symbol used by the CLI (e.g. "TSLA", "BTC"). */
  symbol: string;
  /** Cross-venue matching key from canonical-symbols.ts; null = not matchable. */
  canonical: string | null;
  assetClass: AssetClass;
  settle: string;
  /**
   * Currency prices are quoted in ("USD", "KRW", ...); null = this venue's data path does not
   * record it. A non-USD quote is never traded through perp-cli (sizing, risk limits and
   * notionals assume USD) — see QFEX,.
   */
  quoteAsset: string | null;
  markPrice: string;
  indexPrice: string | null;
  fundingRate: string | null;
  fundingRateBasis: FundingRateBasis;
  settlementIntervalHours: number;
  openInterest: string | null;
  volume24h: string | null;
  /** null = venue publishes no tick (read-only venues). Trading venues must set it. */
  tickSize: string | null;
  /** null = venue publishes no lot step (read-only venues). Trading venues must set it. */
  stepSize: string | null;
  minSize: string | null;
  minNotional: string | null;
  /** null = venue publishes no leverage cap (read-only venues). */
  maxLeverage: number | null;
  marginTiers: Array<{ lowerBound: number; maxLeverage: number }> | null;
  session: MarketSession | null;
  /** false = listed but not tradable right now (offline / paused / corporate action). */
  tradable: boolean;
}

function decimalsOf(step: string): number {
  const s = step.includes("e") || step.includes("E") ? Number(step).toFixed(20).replace(/0+$/, "") : step;
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Pure mapping used by new-venue adapters to serve the legacy getMarkets(). */
/** Tick/step/leverage required for order entry. Throws when the venue did not publish them. */
export function requireTradingPrecision(m: VenueMarket): { tickSize: string; stepSize: string; maxLeverage: number } {
  if (m.tickSize === null || m.stepSize === null || m.maxLeverage === null) {
    throw new Error(`${m.venue} ${m.symbol}: tick size / step size / max leverage not published — market is not tradable via API`);
  }
  return { tickSize: m.tickSize, stepSize: m.stepSize, maxLeverage: m.maxLeverage };
}

export function toLegacyMarketInfo(m: VenueMarket): ExchangeMarketInfo {
  const p = requireTradingPrecision(m);
  const hours = m.fundingRateBasis.kind === "perHours" ? m.fundingRateBasis.hours : null;
  return {
    symbol: m.symbol,
    markPrice: m.markPrice,
    indexPrice: m.indexPrice,
    fundingRate: m.fundingRate,
    volume24h: m.volume24h,
    openInterest: m.openInterest,
    maxLeverage: p.maxLeverage,
    sizeDecimals: decimalsOf(p.stepSize),
    stepSize: p.stepSize,
    fundingHours: hours,
    marginTiers: m.marginTiers,
  };
}

export interface VenueFundingRate {
  venue: VenueId;
  venueSymbol: string;
  symbol: string;
  canonical: string | null;
  rate: string;
  basis: FundingRateBasis;
  markPrice: string | null;
  nextFundingTime: number | null;
}

// ── Orders ──

/** CLI-level TIF inputs. "TOB" = Pacifica top-of-book, "GTX" = Aster post-only. */
export type TimeInForce = "GTC" | "GTT" | "IOC" | "FOK" | "ALO" | "TOB" | "GTX";
export type OrderType = "market" | "limit" | "stopMarket" | "stopLimit";

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  size: string;
  /** Required for limit/stopLimit. */
  price: string | null;
  /** Required for stopMarket/stopLimit. */
  triggerPrice: string | null;
  triggerSource: "mark" | "last" | "mid" | null;
  /** Required for limit/stopLimit; only null is allowed for market/stopMarket. */
  tif: TimeInForce | null;
  reduceOnly: boolean;
  /** Required when the venue's orderAck is "async". */
  clientOrderId: string | null;
  /**
   * Resolved slippage bound (resolveSlippage()). Required for
   * type "market"; adapters whose stopMarket / TP-SL legs are protection-priced
   * (Arcus) require it there too. null only for orders that carry no market leg.
   */
  slippage: ResolvedSlippage | null;
  tpsl: { tp: string | null; sl: string | null } | null;
}

export type OrderStatus = "accepted" | "open" | "partiallyFilled" | "filled" | "rejected" | "cancelled";

export interface OrderResult {
  venue: VenueId;
  symbol: string;
  status: OrderStatus;
  /** "pending" = not final yet (async venue ack, or awaitOrderFinal timed out). */
  finality: "final" | "pending";
  /**
   * Invariant: orderId !== null || clientOrderId !== null — except for an order the
   * venue acknowledged without any id (e.g. a legacy-venue trigger order); that
   * result says so in execution.notes and orderRefOf() refuses it.
   */
  orderId: string | null;
  clientOrderId: string | null;
  /** Filled base size; null = the venue response does not report it (never "0" as a stand-in). */
  filledSize: string | null;
  avgPrice: string | null;
  /** How the venue adapter actually executed the request. */
  execution: OrderExecution;
  venueRaw: unknown;
}

/**
 * Transparent record of the venue-specific handling behind a uniform order. Every field is required; a value the
 * venue / adapter did not report is null (SSOT Rule #2), never a guess.
 */
export interface OrderExecution {
  /**
   * Execution method, e.g. "protectedIoc" (IOC limit at a protection price),
   * "venueSlippage" (venue applies a slippage percent), "limit", "trigger",
   * "triggerLimit", "nativeAmend", "cancelReplace".
   */
  method: string;
  /** Slippage bound actually applied (after price-grid rounding when the adapter reports it). */
  slippageBps: number | null;
  slippageSource: SlippageSource | null;
  /** Limit price sent with a market-type order; null = not echoed / computed by the venue. */
  protectionPrice: string | null;
  /** Reference price the protection price was derived from (mark / mid / trigger). */
  referencePrice: string | null;
  /** TIF as requested by the caller (common or venue alias). */
  tifRequested: string | null;
  /** Venue-native TIF actually sent (e.g. "Gtc", "GTT", "GTX"). */
  tifSent: string | null;
  /** Unix ms when a resting order expires (GTC mapped to GTT); null = no venue expiry. */
  expiresAt: number | null;
  /**
   * Builder fee this order carried (settings builder.<venue> + confirmed approval); null = none.
   * A configured fee that was NOT attached says why in `notes`.
   */
  builderFee: AppliedBuilderFee | null;
  notes: string[];
}

/**
 * Attach an execution record to a result built without one. Fields of `partial`
 * that are absent are recorded as null (unknown), never defaulted to a value.
 */
export function withExecution(
  result: Omit<OrderResult, "execution">,
  method: string,
  partial: Partial<Omit<OrderExecution, "method">>,
): OrderResult {
  return {
    ...result,
    execution: {
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
    },
  };
}

export type OrderRef = { kind: "orderId"; value: string } | { kind: "clientOrderId"; value: string };

export interface AmendRequest {
  symbol: string;
  ref: OrderRef;
  price: string;
  size: string;
  /**
   * Time-in-force of the replacement. null = keep the resting order's own TIF
   * (venues that can read it back, e.g. Arcus); cancel→replace venues that cannot
   * read post-only back (Ondo) refuse null.
   */
  tif: TimeInForce | null;
  /**
   * Allow an explicit `tif` that flips the post-only flag encoded in the order's generated
   * client id (Ondo / Pacifica): without it such a conflict is INVALID_PARAMS (CLI --force-tif).
   */
  forceTif?: boolean;
}

export interface CancelResult {
  venue: VenueId;
  /** Only orders whose cancel the venue result proves (per order). */
  cancelled: OrderRef[];
  failed: Array<{ ref: OrderRef | null; error: string }>;
  /** Cancels sent but not proven by the venue result — status pending; verify before acting again. */
  pending?: Array<{ ref: OrderRef | null; reason: string; remediation: string }>;
  venueRaw: unknown;
}

export interface LeverageResult {
  venue: VenueId;
  symbol: string;
  leverage: number;
  marginMode: "cross" | "isolated";
  venueRaw: unknown;
}

export function orderRefOf(r: Pick<OrderResult, "orderId" | "clientOrderId">): OrderRef {
  if (r.orderId !== null) return { kind: "orderId", value: r.orderId };
  if (r.clientOrderId !== null) return { kind: "clientOrderId", value: r.clientOrderId };
  throw new Error("OrderResult invariant violated: neither orderId nor clientOrderId is set");
}

/** Parse a CLI order reference: "c:<id>" → clientOrderId, otherwise orderId. */
export function parseOrderRef(s: string): OrderRef {
  if (s.startsWith("c:")) return { kind: "clientOrderId", value: s.slice(2) };
  return { kind: "orderId", value: s };
}
