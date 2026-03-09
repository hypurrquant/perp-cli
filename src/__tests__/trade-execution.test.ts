import { describe, it, expect, beforeEach } from "vitest";
import { MockAdapter, createMockPositions } from "./exchanges/mock-adapter.js";

describe("Trade Execution", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter("test-exchange");
    adapter.orderResult = { status: "ok", orderId: "test-123" };
  });

  describe("Market Orders", () => {
    it("should place a buy market order with correct params", async () => {
      await adapter.marketOrder("BTC", "buy", "0.1");
      const calls = adapter.getCallsFor("marketOrder");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["BTC", "buy", "0.1"]);
    });

    it("should place a sell market order", async () => {
      await adapter.marketOrder("ETH", "sell", "1.5");
      const calls = adapter.getCallsFor("marketOrder");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["ETH", "sell", "1.5"]);
    });

    it("should return order result", async () => {
      const result = await adapter.marketOrder("BTC", "buy", "0.1");
      expect(result).toEqual({ status: "ok", orderId: "test-123" });
    });
  });

  describe("Limit Orders", () => {
    it("should place limit order with price and size", async () => {
      await adapter.limitOrder("BTC", "buy", "95000", "0.05");
      const calls = adapter.getCallsFor("limitOrder");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["BTC", "buy", "95000", "0.05"]);
    });
  });

  describe("Stop Orders", () => {
    it("should place stop order with trigger price", async () => {
      await adapter.stopOrder("BTC", "sell", "0.1", "90000", { reduceOnly: true });
      const calls = adapter.getCallsFor("stopOrder");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["BTC", "sell", "0.1", "90000", { reduceOnly: true }]);
    });

    it("should place stop-limit order", async () => {
      await adapter.stopOrder("ETH", "buy", "1.0", "4000", { limitPrice: "4050", reduceOnly: false });
      const calls = adapter.getCallsFor("stopOrder");
      expect(calls[0].args[4]).toEqual({ limitPrice: "4050", reduceOnly: false });
    });
  });

  describe("Order Management", () => {
    it("should cancel specific order", async () => {
      await adapter.cancelOrder("BTC", "order-456");
      expect(adapter.getCallsFor("cancelOrder")[0].args).toEqual(["BTC", "order-456"]);
    });

    it("should cancel all orders", async () => {
      await adapter.cancelAllOrders();
      expect(adapter.getCallsFor("cancelAllOrders")).toHaveLength(1);
    });

    it("should cancel orders for specific symbol", async () => {
      await adapter.cancelAllOrders("ETH");
      expect(adapter.getCallsFor("cancelAllOrders")[0].args).toEqual(["ETH"]);
    });

    it("should edit existing order", async () => {
      await adapter.editOrder("BTC", "order-789", "96000", "0.2");
      expect(adapter.getCallsFor("editOrder")[0].args).toEqual(["BTC", "order-789", "96000", "0.2"]);
    });
  });

  describe("Position Close Logic", () => {
    it("should close long position with sell order", async () => {
      adapter.positionsResponse = createMockPositions(1); // long BTC 0.1
      const positions = await adapter.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].side).toBe("long");

      // Close: sell the same size
      await adapter.marketOrder(positions[0].symbol, "sell", positions[0].size);
      const calls = adapter.getCallsFor("marketOrder");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["BTC", "sell", "0.1"]);
    });

    it("should close short position with buy order", async () => {
      adapter.positionsResponse = [{
        symbol: "ETH", side: "short", size: "2.0",
        entryPrice: "3500", markPrice: "3400", liquidationPrice: "4500",
        unrealizedPnl: "200", leverage: 5,
      }];
      const positions = await adapter.getPositions();

      await adapter.marketOrder(positions[0].symbol, "buy", positions[0].size);
      const calls = adapter.getCallsFor("marketOrder");
      expect(calls[0].args).toEqual(["ETH", "buy", "2.0"]);
    });

    it("should close all positions with opposite-side orders", async () => {
      adapter.positionsResponse = [
        { symbol: "BTC", side: "long", size: "0.1", entryPrice: "100000", markPrice: "101000", liquidationPrice: "90000", unrealizedPnl: "100", leverage: 10 },
        { symbol: "ETH", side: "short", size: "1.5", entryPrice: "3500", markPrice: "3400", liquidationPrice: "4500", unrealizedPnl: "150", leverage: 5 },
      ];
      const positions = await adapter.getPositions();

      for (const pos of positions) {
        const closeSide = pos.side === "long" ? "sell" : "buy";
        await adapter.marketOrder(pos.symbol, closeSide, pos.size);
      }

      const calls = adapter.getCallsFor("marketOrder");
      expect(calls).toHaveLength(2);
      expect(calls[0].args).toEqual(["BTC", "sell", "0.1"]);
      expect(calls[1].args).toEqual(["ETH", "buy", "1.5"]);
    });

    it("should reduce position by percentage", async () => {
      adapter.positionsResponse = [{
        symbol: "BTC", side: "long", size: "1.0",
        entryPrice: "100000", markPrice: "101000", liquidationPrice: "90000",
        unrealizedPnl: "1000", leverage: 10,
      }];
      const positions = await adapter.getPositions();
      const pos = positions[0];
      const reducePct = 50;
      const reduceSize = (Number(pos.size) * reducePct / 100).toString();

      await adapter.marketOrder(pos.symbol, "sell", reduceSize);
      const calls = adapter.getCallsFor("marketOrder");
      expect(calls[0].args).toEqual(["BTC", "sell", "0.5"]);
    });
  });

  describe("Leverage Management", () => {
    it("should set leverage with cross margin", async () => {
      await adapter.setLeverage("BTC", 20, "cross");
      expect(adapter.getCallsFor("setLeverage")[0].args).toEqual(["BTC", 20, "cross"]);
    });

    it("should set leverage with isolated margin", async () => {
      await adapter.setLeverage("ETH", 5, "isolated");
      expect(adapter.getCallsFor("setLeverage")[0].args).toEqual(["ETH", 5, "isolated"]);
    });
  });
});
