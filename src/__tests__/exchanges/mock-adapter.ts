import type {
  ExchangeAdapter,
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
  ExchangeFundingPayment,
  ExchangeKline,
} from "../../exchanges/interface.js";

/**
 * Mock adapter for unit testing. Records all calls and returns configurable responses.
 */
export class MockAdapter implements ExchangeAdapter {
  readonly name: string;
  calls: { method: string; args: unknown[] }[] = [];

  // Configurable return values
  marketsResponse: ExchangeMarketInfo[] = [];
  orderbookResponse = { bids: [] as [string, string][], asks: [] as [string, string][] };
  balanceResponse: ExchangeBalance = { equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "50" };
  positionsResponse: ExchangePosition[] = [];
  ordersResponse: ExchangeOrder[] = [];
  orderResult: unknown = { status: "ok", orderId: "12345" };

  constructor(name = "mock") {
    this.name = name;
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  getCallsFor(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.calls = [];
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    this.record("getMarkets", []);
    return this.marketsResponse;
  }

  async getOrderbook(symbol: string) {
    this.record("getOrderbook", [symbol]);
    return this.orderbookResponse;
  }

  async getBalance(): Promise<ExchangeBalance> {
    this.record("getBalance", []);
    return this.balanceResponse;
  }

  async getPositions(): Promise<ExchangePosition[]> {
    this.record("getPositions", []);
    return this.positionsResponse;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    this.record("getOpenOrders", []);
    return this.ordersResponse;
  }

  async marketOrder(symbol: string, side: "buy" | "sell", size: string) {
    this.record("marketOrder", [symbol, side, size]);
    return this.orderResult;
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string) {
    this.record("limitOrder", [symbol, side, price, size]);
    return this.orderResult;
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    this.record("editOrder", [symbol, orderId, price, size]);
    return this.orderResult;
  }

  async cancelOrder(symbol: string, orderId: string) {
    this.record("cancelOrder", [symbol, orderId]);
    return { status: "cancelled" };
  }

  async cancelAllOrders(symbol?: string) {
    this.record("cancelAllOrders", [symbol]);
    return { status: "all_cancelled" };
  }

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated") {
    this.record("setLeverage", [symbol, leverage, marginMode]);
    return { symbol, leverage, marginMode };
  }

  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean }) {
    this.record("stopOrder", [symbol, side, size, triggerPrice, opts]);
    return this.orderResult;
  }

  async getRecentTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]> {
    this.record("getRecentTrades", [symbol, limit]);
    return [];
  }

  async getFundingHistory(symbol: string, limit?: number): Promise<{ time: number; rate: string; price: string }[]> {
    this.record("getFundingHistory", [symbol, limit]);
    return [];
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    this.record("getKlines", [symbol, interval, startTime, endTime]);
    return [];
  }

  async getOrderHistory(limit?: number): Promise<ExchangeOrder[]> {
    this.record("getOrderHistory", [limit]);
    return this.ordersResponse;
  }

  async getTradeHistory(limit?: number): Promise<ExchangeTrade[]> {
    this.record("getTradeHistory", [limit]);
    return [];
  }

  async getFundingPayments(limit?: number): Promise<ExchangeFundingPayment[]> {
    this.record("getFundingPayments", [limit]);
    return [];
  }
}

/** Factory to create mock markets data */
export function createMockMarkets(count = 3): ExchangeMarketInfo[] {
  const symbols = ["BTC", "ETH", "SOL", "DOGE", "ARB"];
  return symbols.slice(0, count).map((symbol) => ({
    symbol,
    markPrice: String(symbol === "BTC" ? 100000 : symbol === "ETH" ? 3500 : 150),
    indexPrice: String(symbol === "BTC" ? 99990 : symbol === "ETH" ? 3498 : 149.5),
    fundingRate: "0.0001",
    volume24h: "1000000",
    openInterest: "500000",
    maxLeverage: symbol === "BTC" ? 100 : 50,
  }));
}

/** Factory to create mock positions */
export function createMockPositions(count = 1): ExchangePosition[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: i === 0 ? "BTC" : "ETH",
    side: (i % 2 === 0 ? "long" : "short") as "long" | "short",
    size: "0.1",
    entryPrice: "100000",
    markPrice: "101000",
    liquidationPrice: "90000",
    unrealizedPnl: "100",
    leverage: 10,
  }));
}

/** Factory to create mock orders */
export function createMockOrders(count = 2): ExchangeOrder[] {
  return Array.from({ length: count }, (_, i) => ({
    orderId: String(1000 + i),
    symbol: "BTC",
    side: (i % 2 === 0 ? "buy" : "sell") as "buy" | "sell",
    price: String(99000 + i * 1000),
    size: "0.05",
    filled: "0",
    status: "open",
    type: "limit",
  }));
}
