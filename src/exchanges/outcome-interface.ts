/**
 * Hyperliquid Outcome Markets (HIP-4) — common adapter interface.
 *
 * Outcome markets are fully-collateralized binary/range contracts that settle
 * within a fixed range. Asset id encoding: `100,000,000 + (10 * outcome + side)`.
 *
 * Probe-confirmed facts (mainnet 2026-05-03):
 *  - Quote token: USDH (NOT USDC)
 *  - Min order notional: $10 USDH (price * size >= 10)
 *  - No leverage / no liquidation
 *  - Order/cancel action shape identical to spot
 *  - Coin name: `#<encoding>` (l2Book/candle/allMids), `+<encoding>` (spot balance)
 */

export interface OutcomeSideInfo {
  /** Side index within the outcome (0, 1, ...) */
  side: number;
  /** Human name (e.g., "Yes", "No") */
  name: string;
  /** Encoding = 10 * outcome + side */
  encoding: number;
  /** Asset id = 100,000,000 + encoding */
  assetId: number;
  /** Last known mid price (USDH per share, e.g., "0.583") — undefined if unloaded */
  mid?: string;
}

export interface OutcomeMarketInfo {
  /** Outcome id from `outcomeMeta.outcomes[].outcome` */
  outcome: number;
  /** Display name (e.g., "Recurring") */
  name: string;
  /** Raw description string (e.g., "class:priceBinary|underlying:BTC|expiry:20260504-0600|targetPrice:78213|period:1d") */
  description: string;
  /** Parsed: class (e.g., "priceBinary") */
  class?: string;
  /** Parsed: underlying asset (e.g., "BTC") */
  underlying?: string;
  /** Parsed: expiry as ms-epoch */
  expiryMs?: number;
  /** Parsed: target price (USD) */
  targetPrice?: number;
  /** Parsed: settlement period (e.g., "1d") */
  period?: string;
  /** All sides for this outcome */
  sides: OutcomeSideInfo[];
}

export interface OutcomePosition {
  outcome: number;
  side: number;
  /** Side display name (resolved from outcomeMeta) */
  sideName: string;
  /** 10 * outcome + side */
  encoding: number;
  /** Shares held (from spotClearinghouseState `total`) */
  size: string;
  /** Cumulative USDH paid in (from `entryNtl`) */
  entryNotional: string;
  /** Last known mid price — undefined if unloaded */
  markPrice?: string;
  /** mark * size - entryNotional, or undefined if mark missing */
  unrealizedPnl?: string;
}

export interface OutcomeOrderbook {
  outcome: number;
  side: number;
  /** [px, sz] tuples sorted highest-first */
  bids: [string, string][];
  /** [px, sz] tuples sorted lowest-first */
  asks: [string, string][];
  /** Server time-ms when book was captured */
  time: number;
}

export interface OutcomeAdapter {
  readonly name: string;
  init(): Promise<void>;
  /** List active outcome markets. Empty array means none live. */
  getMarkets(): Promise<OutcomeMarketInfo[]>;
  /** Positions held by the active account. */
  getPositions(): Promise<OutcomePosition[]>;
  /** L2 orderbook for one (outcome, side). */
  getOrderbook(outcome: number, side: number): Promise<OutcomeOrderbook>;
  /** Place a limit order. Throws INVALID_PARAMS if `price * size < 10` USDH. */
  placeOrder(opts: {
    outcome: number;
    side: number;
    isBuy: boolean;
    price: string;
    size: string;
    tif?: "Gtc" | "Ioc" | "Alo";
  }): Promise<unknown>;
  /** Cancel a resting order. */
  cancelOrder(outcome: number, side: number, oid: number): Promise<unknown>;
  /** All open outcome orders for the active account. */
  getOpenOrders(): Promise<unknown[]>;
}
