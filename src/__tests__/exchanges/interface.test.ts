import { describe, it, expect, beforeEach } from "vitest";
import { MockAdapter, createMockMarkets, createMockPositions, createMockOrders } from "./mock-adapter.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

describe("ExchangeAdapter interface compliance", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter("test-exchange");
  });

  it("has a name property", () => {
    expect(adapter.name).toBe("test-exchange");
  });

  describe("getMarkets", () => {
    it("returns market info array", async () => {
      adapter.marketsResponse = createMockMarkets(3);
      const markets = await adapter.getMarkets();
      expect(markets).toHaveLength(3);
      expect(markets[0]).toHaveProperty("symbol");
      expect(markets[0]).toHaveProperty("markPrice");
      expect(markets[0]).toHaveProperty("fundingRate");
      expect(markets[0]).toHaveProperty("maxLeverage");
    });

    it("market info has correct types", async () => {
      adapter.marketsResponse = createMockMarkets(1);
      const [market] = await adapter.getMarkets();
      expect(typeof market.symbol).toBe("string");
      expect(typeof market.markPrice).toBe("string");
      expect(typeof market.indexPrice).toBe("string");
      expect(typeof market.fundingRate).toBe("string");
      expect(typeof market.volume24h).toBe("string");
      expect(typeof market.openInterest).toBe("string");
      expect(typeof market.maxLeverage).toBe("number");
    });
  });

  describe("getOrderbook", () => {
    it("returns bids and asks", async () => {
      adapter.orderbookResponse = {
        bids: [["99000", "1.5"], ["98900", "2.0"]],
        asks: [["100100", "0.8"], ["100200", "1.2"]],
      };
      const book = await adapter.getOrderbook("BTC");
      expect(book.bids).toHaveLength(2);
      expect(book.asks).toHaveLength(2);
      expect(book.bids[0]).toEqual(["99000", "1.5"]);
      expect(adapter.getCallsFor("getOrderbook")[0].args).toEqual(["BTC"]);
    });
  });

  describe("getBalance", () => {
    it("returns balance info", async () => {
      const balance = await adapter.getBalance();
      expect(balance).toHaveProperty("equity");
      expect(balance).toHaveProperty("available");
      expect(balance).toHaveProperty("marginUsed");
      expect(balance).toHaveProperty("unrealizedPnl");
      expect(Number(balance.equity)).toBeGreaterThan(0);
    });
  });

  describe("getPositions", () => {
    it("returns positions array", async () => {
      adapter.positionsResponse = createMockPositions(2);
      const positions = await adapter.getPositions();
      expect(positions).toHaveLength(2);
      expect(positions[0].side).toBe("long");
      expect(positions[1].side).toBe("short");
    });

    it("position has required fields", async () => {
      adapter.positionsResponse = createMockPositions(1);
      const [pos] = await adapter.getPositions();
      expect(pos).toHaveProperty("symbol");
      expect(pos).toHaveProperty("side");
      expect(pos).toHaveProperty("size");
      expect(pos).toHaveProperty("entryPrice");
      expect(pos).toHaveProperty("markPrice");
      expect(pos).toHaveProperty("liquidationPrice");
      expect(pos).toHaveProperty("unrealizedPnl");
      expect(pos).toHaveProperty("leverage");
    });
  });

  describe("getOpenOrders", () => {
    it("returns orders array", async () => {
      adapter.ordersResponse = createMockOrders(2);
      const orders = await adapter.getOpenOrders();
      expect(orders).toHaveLength(2);
      expect(orders[0].side).toBe("buy");
      expect(orders[1].side).toBe("sell");
    });
  });

  describe("marketOrder", () => {
    it("places market order with correct params", async () => {
      await adapter.marketOrder("BTC", "buy", "0.1");
      const calls = adapter.getCallsFor("marketOrder");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["BTC", "buy", "0.1"]);
    });

    it("records sell orders", async () => {
      await adapter.marketOrder("ETH", "sell", "1.0");
      const calls = adapter.getCallsFor("marketOrder");
      expect(calls[0].args).toEqual(["ETH", "sell", "1.0"]);
    });
  });

  describe("limitOrder", () => {
    it("places limit order with correct params", async () => {
      await adapter.limitOrder("BTC", "buy", "95000", "0.05");
      const calls = adapter.getCallsFor("limitOrder");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["BTC", "buy", "95000", "0.05"]);
    });
  });

  describe("cancelOrder", () => {
    it("cancels with symbol and orderId", async () => {
      await adapter.cancelOrder("BTC", "12345");
      const calls = adapter.getCallsFor("cancelOrder");
      expect(calls[0].args).toEqual(["BTC", "12345"]);
    });
  });

  describe("cancelAllOrders", () => {
    it("cancels all for specific symbol", async () => {
      await adapter.cancelAllOrders("BTC");
      const calls = adapter.getCallsFor("cancelAllOrders");
      expect(calls[0].args).toEqual(["BTC"]);
    });

    it("cancels all without symbol", async () => {
      await adapter.cancelAllOrders();
      const calls = adapter.getCallsFor("cancelAllOrders");
      expect(calls[0].args).toEqual([undefined]);
    });
  });

  describe("adapter type safety", () => {
    it("satisfies ExchangeAdapter interface", () => {
      const _check: ExchangeAdapter = adapter;
      expect(_check).toBeDefined();
    });
  });
});
