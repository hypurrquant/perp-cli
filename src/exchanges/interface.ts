import { PerpError } from "../errors.js";
import type { ResolvedSlippage } from "./slippage.js";

/**
 * Common exchange interface for multi-DEX CLI support.
 * All exchange adapters (Pacifica, Hyperliquid, Lighter) implement this.
 */

export interface ExchangeMarketInfo {
  symbol: string;
  markPrice: string;
  /** null = venue does not publish an index/oracle price for this market */
  indexPrice: string | null;
  fundingRate: string | null;  // null = rate unavailable (don't assume 0)
  /** 24h volume in USD notional; null = venue does not publish 24h volume */
  volume24h: string | null;
  /**
   * Open interest in BASE-asset units (contracts of the underlying, e.g. BTC) — every venue
   * publishes it that way, so it is never a USD figure. null = venue does not publish it
   * (never "0" as a stand-in). One side where known (Lighter / Lighter RH: one side — inferred,
   * not documented by the venue). The perp-ws `openInterest` is a different field with its own `unit` (Lighter:
   * USD) — never compare the two without converting.
   */
  openInterest: string | null;
  /** null = the venue does not publish it (Aster: the public exchangeInfo carries no leverage) */
  maxLeverage: number | null;
  /** quantity precision (e.g. 0 = integers only, 2 = 0.01); null = unknown */
  sizeDecimals: number | null;
  /** lot step size (e.g. "1", "0.1", "0.001"); null = unknown */
  stepSize: string | null;
  /** hours one quoted fundingRate covers; null = use the venue definition's fundingRateBasis */
  fundingHours: number | null;
  /**
   * Notional-tiered leverage caps, ascending by `lowerBound` (USD notional).
   * `maxLeverage` above is the TOP tier — the cap falls as size grows, so a
   * pre-trade check that uses it alone passes orders the venue will reject.
   * Resolve with `maxLeverageForNotional()`. null when the venue does not
   * publish tiers (then `maxLeverage` applies at every size).
   */
  marginTiers: Array<{ lowerBound: number; maxLeverage: number }> | null;
  /**
   * Listed but not tradable right now (VenueMarket.tradable: off-hours, reduce-only, halted, paused)
   * → false. Delisted / disabled / inactive markets are not listed at all (each venue's eligibility
   * rule). Absent = the venue publishes no tradability flag (its adapter lists live markets only).
   */
  tradable?: boolean;
  /**
   * Why a listed market is not tradable (with `tradable: false`), e.g. "nonUsdQuote", "offHours",
   * "reduceOnly", "halted"; or the venue's own status. Absent / null = no reason published.
   */
  status?: string | null;
  /**
   * What `fundingRate` is, in the WS `rateKind` vocabulary: "accruing" (the current period so far),
   * "predicted" (the rate expected at the next payment), "lastSettled" (the last payment). null =
   * not verified for this venue's REST field. Absent on rows built before 0.15.1 conventions.
   */
  fundingRateKind?: FundingRateKind | null;
}

export type FundingRateKind = "accruing" | "predicted" | "lastSettled";

/**
 * Effective max leverage for an order of `notional` USD.
 *
 * A venue that publishes no tiers (`marginTiers === null`) has one flat cap,
 * `maxLeverage`, at every size — that is the venue's definition, not a fallback.
 */
export function maxLeverageForNotional(market: ExchangeMarketInfo, notional: number): number | null {
  if (!Number.isFinite(notional)) {
    throw new Error(`maxLeverageForNotional: notional must be finite (got ${notional})`);
  }
  const tiers = market.marginTiers;
  if (tiers === null || tiers.length === 0) return market.maxLeverage; // null = not published
  // No headline but published tiers: the first (lowest-notional) tier is the cap below every threshold.
  let effective = market.maxLeverage ?? tiers[0].maxLeverage;
  for (const t of tiers) {
    if (notional >= t.lowerBound) effective = t.maxLeverage;
  }
  return effective;
}

export interface ExchangePosition {
  symbol: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  markPrice: string;
  /** null = venue does not report a liquidation price */
  liquidationPrice: string | null;
  unrealizedPnl: string;
  leverage: number;
  /** Margin mode of the position, set only by adapters whose venue reports it per position. */
  marginMode?: "cross" | "isolated";
}

export interface ExchangeOrder {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  filled: string;
  status: string;
  type: string;
  /** Trigger (stop) price of a stop / TP / SL order; null for plain orders or when the venue does not report it. */
  triggerPrice: string | null;
}

export interface ExchangeBalance {
  equity: string;
  available: string;
  marginUsed: string;
  unrealizedPnl: string;
}

export interface ExchangeTrade {
  time: number;       // unix ms
  symbol: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  fee: string;
}

/**
 * A row of the PUBLIC trade tape (getRecentTrades). The tape carries no fee for the viewer —
 * a fee exists only on the account's own fills (getTradeHistory) — so `fee` is always null
 * here, never "0" as a stand-in.
 */
export interface ExchangePublicTrade extends Omit<ExchangeTrade, "fee"> {
  fee: null;
}

/**
 * Rows of a public tape the adapter left out because they carry a value the venue documents but
 * does not declare exhaustive (e.g. a new Pacifica event_type) — never guessed into a direction.
 * Attached to the returned array under this symbol key (not serialized); `market trades` reports
 * it as `meta.skippedRows`. Absent = nothing skipped.
 */
export const TAPE_SKIPPED: unique symbol = Symbol.for("perp-cli.tapeSkipped");
export interface TapeSkipped { count: number; reason: string }

export function withTapeSkipped<T>(rows: T[], skipped: TapeSkipped | null): T[] {
  if (skipped !== null && skipped.count > 0) Object.defineProperty(rows, TAPE_SKIPPED, { value: skipped, enumerable: false });
  return rows;
}

/**
 * Rows sorted by time (a copy), keeping every non-index property the adapter attached to the
 * array (TAPE_SKIPPED and any other symbol / metadata key, with its descriptor) — a plain
 * `[...rows].sort()` drops them.
 */
export function sortByTime<T extends { time: number }>(rows: readonly T[], order: "asc" | "desc"): T[] {
  const out = [...rows].sort((a, b) => (order === "asc" ? a.time - b.time : b.time - a.time));
  for (const key of Reflect.ownKeys(rows)) {
    if (key === "length" || (typeof key === "string" && /^\d+$/.test(key))) continue;
    const d = Object.getOwnPropertyDescriptor(rows, key);
    if (d !== undefined) Object.defineProperty(out, key, d);
  }
  return out;
}

export function tapeSkippedOf(rows: readonly unknown[]): TapeSkipped | null {
  const v = (rows as unknown as { [TAPE_SKIPPED]?: TapeSkipped })[TAPE_SKIPPED];
  return v === undefined ? null : v;
}

export interface ExchangeFundingPayment {
  time: number;       // unix ms
  symbol: string;
  payment: string;
}

/**
 * One row of `market funding` (getFundingHistory). `rate` is a fraction per `intervalHours`
 * (the hours one printed rate covers; null = unknown for that market), positive = longs pay.
 * `rateKind` "lastSettled" = a rate the venue applied at `time`; null = the venue does not say.
 */
export interface FundingHistoryRow {
  time: number;
  /** null = the venue published no rate for that print (e.g. the market was closed). Never "0" as a stand-in. */
  rate: string | null;
  price: string | null;
  intervalHours: number | null;
  rateKind: "lastSettled" | null;
  /** true = the underlying market was closed for this print (no funding accrued); absent = not reported. */
  marketClosed?: boolean;
}

export interface ExchangeKline {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Base-asset volume of the candle; null = venue does not publish it (never "0" as a stand-in) */
  volume: string | null;
  /** Quote (USD) notional volume of the candle; null = venue does not publish it */
  quoteVolume: string | null;
  /** null = venue does not publish a trade count for the candle */
  trades: number | null;
}

/**
 * Guard for a candle row that states its own interval (HL / TxFlow / Pacifica `i`, RISEx
 * `interval`): a row of another interval than requested is never returned as the requested one
 * (RISEx answers unsupported intervals with 1m bars). `rowInterval` undefined = the row carries
 * no interval field (nothing to check).
 */
export function assertCandleInterval(venue: string, requested: string, rowInterval: unknown, remediation?: string): void {
  if (rowInterval === undefined || rowInterval === requested) return;
  throw new PerpError("EXCHANGE_ERROR", `${venue} candles: requested ${requested} candles, got a row labelled ${JSON.stringify(rowInterval)}`, {
    exchange: venue,
    remediation: remediation ?? `Use an interval ${venue} serves (see perp -e ${venue} market kline --help)`,
  });
}

/** One indicative quote of an RFQ venue's maker at a fixed size. */
export interface RfqQuoteTier {
  /** Venue tier id ("base" = the market's minimum order size). */
  tier: string;
  /** USD notional of the tier; null when the venue does not publish it (minimum order size). */
  notionalUsd: string | null;
  bid: string;
  ask: string;
}

/** An RFQ venue's indicative maker quotes — NOT order-book levels (`market book` on such a venue). */
export interface RfqQuotes {
  kind: "rfqQuotes";
  venue: string;
  symbol: string;
  ticker: string;
  markPrice: string;
  /** null = no quotes published right now (e.g. a closed market). */
  updatedAt: string | null;
  baseSpreadBps: string | null;
  quotes: RfqQuoteTier[];
  note: string;
}

/** Separate long / short rates of one daily swap funding payment (fractions). */
export interface SwapFundingRates {
  annualizedLong: string;
  annualizedShort: string;
  intervalLong: string;
  intervalShort: string;
}

/** Current funding terms of one market, for a venue that publishes no funding history (`market funding`). */
export interface CurrentFundingTerms {
  kind: "currentFunding";
  venue: string;
  symbol: string;
  ticker: string;
  contractType: "perpetual" | "swap";
  /** "predicted": the rate charged at nextFundingTime, recomputed during the window. */
  rateKind: "predicted" | null;
  /** Fraction per interval as published (perpetual); null for a swap or when unknown. */
  intervalRate: string | null;
  intervalHours: number | null;
  /** intervalRate / intervalHours. */
  hourlyRate: number | null;
  /** hourlyRate × 24 × 365 × 100 (same normalization as arb scan). */
  annualizedPct: number | null;
  /** The venue's own annualized rate (fraction), for cross-checking. */
  venueAnnualizedRate: string | null;
  /** Unix ms; null when not published. */
  nextFundingTime: number | null;
  /** Swap only: long / short rates of the last applied and the upcoming payment. */
  swap: { last: SwapFundingRates | null; next: SwapFundingRates | null } | null;
  note: string;
}

export interface ExchangeAdapter {
  readonly name: string;
  readonly chain?: string;
  readonly aliases?: readonly string[];
  /** True if perp and spot share the same balance (e.g., Hyperliquid). False if separate accounts (e.g., Lighter). */
  readonly isUnifiedAccount?: boolean;
  init?(): Promise<void>;

  // ── Market Data ──
  getMarkets(): Promise<ExchangeMarketInfo[]>;
  /** `depth` (levels per side) sizes the request on venues that take it; callers cut the answer to it. */
  getOrderbook(symbol: string, depth?: number): Promise<{ bids: [string, string][]; asks: [string, string][] }>;
  getRecentTrades(symbol: string, limit?: number): Promise<ExchangePublicTrade[]>;
  getFundingHistory(symbol: string, limit?: number): Promise<FundingHistoryRow[]>;
  getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]>;
  /** RFQ venue (no order book): the maker's indicative quotes. Absent = the venue has an order book. */
  getRfqQuotes?(symbol: string): Promise<RfqQuotes>;
  /** Venue without a funding-history API: the current funding terms. Absent = use getFundingHistory. */
  getFundingTerms?(symbol: string): Promise<CurrentFundingTerms>;

  // ── Account ──
  getBalance(): Promise<ExchangeBalance>;
  getPositions(): Promise<ExchangePosition[]>;
  getOpenOrders(): Promise<ExchangeOrder[]>;
  getOrderHistory(limit?: number): Promise<ExchangeOrder[]>;
  getTradeHistory(limit?: number): Promise<ExchangeTrade[]>;
  getFundingPayments(limit?: number): Promise<ExchangeFundingPayment[]>;

  // ── Trading ──
  /**
   * Market order = IOC within the resolved slippage bound. `opts` is
   * required so every caller states reduceOnly and passes resolveSlippage() output.
   */
  marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage }): Promise<unknown>;
  limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string }): Promise<unknown>;
  editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown>;
  cancelOrder(symbol: string, orderId: string): Promise<unknown>;
  cancelAllOrders(symbol?: string): Promise<unknown>;

  // ── Risk ──
  setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<unknown>;
  /**
   * triggerType selects the trigger price source where the venue supports it
   * (currently Pacifica: "mark" | "last" | "mid"). Adapters that don't support
   * a configurable trigger source ignore the field and use their venue default.
   * `slippage` (resolveSlippage() output) bounds the execution price of a market
   * trigger on venues that send it as a protection-priced limit once triggered
   * (Lighter, Arcus: required there for a market trigger — adapters never read
   * settings); venue-native market triggers ignore it.
   * `kind` ("tp" | "sl") states the protective intent explicitly: venues with distinct
   * take-profit / stop-loss trigger types (Aster, Lighter) send that type as given — no
   * price-based classification — and a trigger already crossed is left for the venue to
   * reject. Omitted (plain `trade stop`): the adapter classifies from the trigger vs its
   * reference price. Venues with a single trigger type ignore it.
   */
  stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean; triggerType?: "mark" | "last" | "mid"; slippage?: ResolvedSlippage; kind?: "tp" | "sl" }): Promise<unknown>;
}
