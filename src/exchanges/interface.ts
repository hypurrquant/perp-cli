/**
 * Common exchange interface for multi-DEX CLI support.
 * All exchange adapters (Pacifica, Hyperliquid, Lighter) implement this.
 */

export interface ExchangeMarketInfo {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string | null;  // null = rate unavailable (don't assume 0)
  volume24h: string;
  openInterest: string;
  maxLeverage: number;
}

export interface ExchangePosition {
  symbol: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  unrealizedPnl: string;
  leverage: number;
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

export interface ExchangeFundingPayment {
  time: number;       // unix ms
  symbol: string;
  payment: string;
}

export interface ExchangeKline {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

export interface ExchangeAdapter {
  readonly name: string;
  readonly chain?: string;
  readonly aliases?: readonly string[];
  init?(): Promise<void>;

  // ── Market Data ──
  getMarkets(): Promise<ExchangeMarketInfo[]>;
  getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }>;
  getRecentTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]>;
  getFundingHistory(symbol: string, limit?: number): Promise<{ time: number; rate: string; price: string | null }[]>;
  getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]>;

  // ── Account ──
  getBalance(): Promise<ExchangeBalance>;
  getPositions(): Promise<ExchangePosition[]>;
  getOpenOrders(): Promise<ExchangeOrder[]>;
  getOrderHistory(limit?: number): Promise<ExchangeOrder[]>;
  getTradeHistory(limit?: number): Promise<ExchangeTrade[]>;
  getFundingPayments(limit?: number): Promise<ExchangeFundingPayment[]>;

  // ── Trading ──
  marketOrder(symbol: string, side: "buy" | "sell", size: string): Promise<unknown>;
  limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string }): Promise<unknown>;
  editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown>;
  cancelOrder(symbol: string, orderId: string): Promise<unknown>;
  cancelAllOrders(symbol?: string): Promise<unknown>;

  // ── Risk ──
  setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<unknown>;
  stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean }): Promise<unknown>;
}
