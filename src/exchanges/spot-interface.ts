/**
 * Spot trading interface for exchanges that support both spot and perp.
 * Separate from ExchangeAdapter because spot uses balance-based tracking
 * (not position-based) and has no leverage, liquidation, or funding concepts.
 *
 * Venues declare spot support in their VenueDefinition (`spot`);
 * adapters are created only through `getSpotAdapter()` in spot-factory.ts.
 *
 * Symbol rule: `SpotMarketInfo.symbol` is "BASE/QUOTE". Adapter
 * methods accept a bare base ("ETH" → BASE/quoteAssets[0]) or "BASE/QUOTE"
 * and translate to the venue's wire form.
 */

import type { ResolvedSlippage } from "./slippage.js";

export interface SpotMarketInfo {
  symbol: string;        // "ETH/USDC"
  baseToken: string;     // "ETH"
  quoteToken: string;    // "USDC"
  /**
   * null = the venue has no usable price for this market right now (no mark and no
   * two-sided book). Never "0" or a stale last trade (Rule #2). Consumers skip it for
   * valuation / matching.
   */
  markPrice: string | null;
  volume24h: string | null;  // null = venue does not publish 24h volume
  sizeDecimals: number;
  priceDecimals: number;
}

export interface SpotBalance {
  token: string;         // "ETH", "USDC"
  total: string;
  available: string;     // total - held in orders
  held: string;
  entryNtl?: string;     // cost basis in USDC (HL only)
  /**
   * true = this balance is the same money as the perp account (Pacifica USDC,
   * HL unified). Aggregators must not add it on top of perp equity.
   */
  shared: boolean;
}

/** Normalized spot order result for venue-definition spot venues (legacy HL/Lighter return unknown). */
export interface SpotOrderResult {
  venue: string;
  symbol: string;
  orderId: string | null;
  status: "filled" | "partial" | "open" | "pending" | "rejected" | "cancelled";
  /** null = venue did not report it */
  filledSize: string | null;
  avgPrice: string | null;
  /** "pending" = submitted but not confirmed final — do NOT resubmit. */
  finality: "final" | "pending";
  /** Token actually received (Arcus router may deliver a wrapped token); null when not applicable. */
  receivedToken: string | null;
  remediation: string | null;
  venueRaw: unknown;
}

/**
 * `venueRaw.fillSource` marker for a fill parsed from a tx event (Lighter event_info
 * `is` − `rs`): spotMarketFill() cross-checks such fills against a fresh balance delta.
 */
export const TX_EVENT_FILL_SOURCE = "tx-event-info";

/** Spot ↔ perp transfer for `accountModel: "separate" | "runtime"` venues. Amount is a decimal string. */
export interface SpotTransferCapable {
  transferToSpot(amount: string, asset: string): Promise<unknown>;
  transferToPerp(amount: string, asset: string): Promise<unknown>;
}

/**
 * Uncached balance read. REQUIRED for any adapter whose getSpotBalances() is served
 * from the shared TTL cache (src/cache.ts `acct:` keys — Lighter, Hyperliquid): fill
 * measurement and post-trade verification must never see a pre-trade cached row.
 * Adapters without it read live on every getSpotBalances() call.
 */
export interface SpotFreshBalancesCapable {
  getSpotBalancesFresh(): Promise<SpotBalance[]>;
}

export function isSpotFreshBalancesCapable(a: SpotAdapter): a is SpotAdapter & SpotFreshBalancesCapable {
  return typeof (a as unknown as Record<string, unknown>).getSpotBalancesFresh === "function";
}

export interface SpotOpenOrdersCapable {
  getSpotOpenOrders(symbol: string | null): Promise<Array<{ orderId: string; symbol: string; side: "buy" | "sell"; price: string; size: string; filled: string }>>;
}

export interface SpotCancelAllCapable {
  spotCancelAllOrders(symbol: string | null): Promise<unknown>;
}

/**
 * Price only the given base tokens (same SpotMarketInfo shape as getSpotMarkets).
 * Required for `accountModel: "wallet"` venues, where pricing the whole market
 * universe is too slow for valuation (Arcus: one router /price call per token).
 */
export interface SpotPricesCapable {
  getSpotPrices(tokens: readonly string[]): Promise<SpotMarketInfo[]>;
}

export function isSpotPricesCapable(a: SpotAdapter): a is SpotAdapter & SpotPricesCapable {
  return typeof (a as unknown as Record<string, unknown>).getSpotPrices === "function";
}

/**
 * A held token's price for valuation only — a token the venue holds in spot but does not list as a
 * spot market (Hyperliquid HIP-4 outcome tokens "+<encoding>"). `quoteToken` = the token its price is
 * quoted in; null = unknown (then the price is unusable). `markPrice` null = no usable price (Rule #2).
 */
export interface SpotHoldingPrice {
  token: string;
  quoteToken: string | null;
  markPrice: string | null;
}

/** Prices for held tokens without a spot market (valuation: portfolio, bot equity). Unpriceable tokens may be omitted. */
export interface SpotHoldingPricesCapable {
  getHoldingPrices(tokens: readonly string[]): Promise<SpotHoldingPrice[]>;
}

export function isSpotHoldingPricesCapable(a: SpotAdapter): a is SpotAdapter & SpotHoldingPricesCapable {
  return typeof (a as unknown as Record<string, unknown>).getHoldingPrices === "function";
}

export function isSpotTransferCapable(a: SpotAdapter): a is SpotAdapter & SpotTransferCapable {
  const r = a as unknown as Record<string, unknown>;
  return typeof r.transferToSpot === "function" && typeof r.transferToPerp === "function";
}

export function isSpotOpenOrdersCapable(a: SpotAdapter): a is SpotAdapter & SpotOpenOrdersCapable {
  return typeof (a as unknown as Record<string, unknown>).getSpotOpenOrders === "function";
}

export interface SpotOrderParams {
  symbol: string;
  side: "buy" | "sell";
  /** Price as number or string — adapter rounds to exchange precision automatically */
  price: number | string;
  /** Size as number or string — adapter rounds to exchange precision automatically */
  size: number | string;
  tif?: string;
}

export interface SpotAdapter {
  readonly name: string;

  // Market data
  getSpotMarkets(): Promise<SpotMarketInfo[]>;
  getSpotOrderbook(symbol: string): Promise<{
    bids: [string, string][];
    asks: [string, string][];
  }>;

  // Account
  getSpotBalances(): Promise<SpotBalance[]>;

  // Trading — accepts raw numbers, adapter handles precision + min size validation
  /** Market order within the resolved slippage bound (same rule as perps). */
  spotMarketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { slippage: ResolvedSlippage }): Promise<unknown>;
  spotLimitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { tif?: string }): Promise<unknown>;
  spotCancelOrder(symbol: string, orderId: string): Promise<unknown>;
}

// ── Token mapping & price verification ──

/**
 * U-token (Unit protocol) → underlying perp symbol mapping.
 * These are bridged tokens on HyperEVM with the same price as the underlying (~0.1% deviation).
 */
export const SPOT_PERP_TOKEN_MAP: Record<string, string> = {
  UBTC: "BTC",
  UETH: "ETH",
  USOL: "SOL",
  UFART: "FARTCOIN",
  UPUMP: "PUMP",
  LINK0: "LINK",
  AVAX0: "AVAX",
  AAVE0: "AAVE",
};

/** Reverse: perp symbol → U-token spot name on HL */
export const PERP_TO_SPOT_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SPOT_PERP_TOKEN_MAP).map(([k, v]) => [v, k]),
);

/** Maximum price deviation (%) between spot and perp to be considered same underlying */
export const MAX_PRICE_DEVIATION_PCT = 5;
