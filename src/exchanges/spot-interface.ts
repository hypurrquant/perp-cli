/**
 * Spot trading interface for exchanges that support both spot and perp.
 * Separate from ExchangeAdapter because spot uses balance-based tracking
 * (not position-based) and has no leverage, liquidation, or funding concepts.
 *
 * Supported: Hyperliquid, Lighter (Pacifica is perp-only)
 */

export interface SpotMarketInfo {
  symbol: string;        // "ETH/USDC"
  baseToken: string;     // "ETH"
  quoteToken: string;    // "USDC"
  markPrice: string;
  volume24h: string;
  sizeDecimals: number;
  priceDecimals: number;
}

export interface SpotBalance {
  token: string;         // "ETH", "USDC"
  total: string;
  available: string;     // total - held in orders
  held: string;
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

  // Trading
  spotMarketOrder(symbol: string, side: "buy" | "sell", size: string): Promise<unknown>;
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
};

/** Reverse: perp symbol → U-token spot name on HL */
export const PERP_TO_SPOT_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SPOT_PERP_TOKEN_MAP).map(([k, v]) => [v, k]),
);

/** Maximum price deviation (%) between spot and perp to be considered same underlying */
export const MAX_PRICE_DEVIATION_PCT = 5;
