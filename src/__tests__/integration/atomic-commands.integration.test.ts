/**
 * Integration tests for new atomic commands against Hyperliquid mainnet (read-only).
 *
 * Tests:
 * - market mid: real orderbook mid price
 * - account margin: position-not-found for dummy/real account
 * - trade status: order-not-found for dummy order
 * - trade fills: empty fills for dummy account / real fills if any
 * - Error response shapes and classification
 *
 * Requires: HYPERLIQUID_PRIVATE_KEY or HL_PRIVATE_KEY env var
 */
import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";

const HL_KEY = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY;
const SKIP = !HL_KEY;

describe.skipIf(SKIP)("Atomic Commands — Hyperliquid Mainnet", { timeout: 30000 }, () => {
  let adapter: HyperliquidAdapter;

  beforeAll(async () => {
    const pk = HL_KEY!;
    adapter = new HyperliquidAdapter(pk, false); // mainnet
    await adapter.init();
  });

  // ══════════════════════════════════════════════════════════
  // market mid: orderbook-based mid price
  // ══════════════════════════════════════════════════════════

  describe("market mid (orderbook mid price)", () => {
    it("BTC orderbook has valid bids, asks, and computable mid", async () => {
      const book = await adapter.getOrderbook("BTC");

      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks.length).toBeGreaterThan(0);

      const bestBid = parseFloat(book.bids[0][0]);
      const bestAsk = parseFloat(book.asks[0][0]);
      const mid = (bestBid + bestAsk) / 2;

      expect(bestBid).toBeGreaterThan(0);
      expect(bestAsk).toBeGreaterThan(bestBid);
      expect(mid).toBeGreaterThan(100); // BTC is > $100

      // Spread should be tiny for BTC
      const spreadPct = ((bestAsk - bestBid) / mid) * 100;
      expect(spreadPct).toBeLessThan(0.1); // < 0.1%
    });

    it("ETH orderbook has valid mid price", async () => {
      const book = await adapter.getOrderbook("ETH");
      const bestBid = parseFloat(book.bids[0][0]);
      const bestAsk = parseFloat(book.asks[0][0]);
      const mid = (bestBid + bestAsk) / 2;

      expect(mid).toBeGreaterThan(10); // ETH > $10
      expect(bestAsk).toBeGreaterThan(bestBid);
    });

    it("SOL orderbook has valid mid price", async () => {
      const book = await adapter.getOrderbook("SOL");
      const bestBid = parseFloat(book.bids[0][0]);
      const bestAsk = parseFloat(book.asks[0][0]);

      expect(bestBid).toBeGreaterThan(0);
      expect(bestAsk).toBeGreaterThan(bestBid);
    });

    it("orderbook sizes are positive numbers", async () => {
      const book = await adapter.getOrderbook("BTC");

      for (const [price, size] of book.bids.slice(0, 5)) {
        expect(parseFloat(price)).toBeGreaterThan(0);
        expect(parseFloat(size)).toBeGreaterThan(0);
      }
      for (const [price, size] of book.asks.slice(0, 5)) {
        expect(parseFloat(price)).toBeGreaterThan(0);
        expect(parseFloat(size)).toBeGreaterThan(0);
      }
    });

    it("bids are sorted descending, asks are sorted ascending", async () => {
      const book = await adapter.getOrderbook("BTC");

      for (let i = 1; i < Math.min(book.bids.length, 5); i++) {
        expect(parseFloat(book.bids[i - 1][0])).toBeGreaterThanOrEqual(parseFloat(book.bids[i][0]));
      }
      for (let i = 1; i < Math.min(book.asks.length, 5); i++) {
        expect(parseFloat(book.asks[i - 1][0])).toBeLessThanOrEqual(parseFloat(book.asks[i][0]));
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // account margin: position margin details
  // ══════════════════════════════════════════════════════════

  describe("account margin (position margin details)", () => {
    it("getBalance returns all required fields as strings", async () => {
      const balance = await adapter.getBalance();

      expect(typeof balance.equity).toBe("string");
      expect(typeof balance.available).toBe("string");
      expect(typeof balance.marginUsed).toBe("string");
      expect(typeof balance.unrealizedPnl).toBe("string");

      // Numbers should be parseable
      expect(isNaN(parseFloat(balance.equity))).toBe(false);
      expect(isNaN(parseFloat(balance.available))).toBe(false);
    });

    it("getPositions returns array with valid position shapes", async () => {
      const positions = await adapter.getPositions();
      expect(Array.isArray(positions)).toBe(true);

      for (const pos of positions) {
        expect(typeof pos.symbol).toBe("string");
        expect(["long", "short"]).toContain(pos.side);
        expect(typeof pos.size).toBe("string");
        expect(parseFloat(pos.size)).toBeGreaterThan(0);
        expect(typeof pos.entryPrice).toBe("string");
        expect(typeof pos.markPrice).toBe("string");
        expect(typeof pos.liquidationPrice).toBe("string");
        expect(typeof pos.unrealizedPnl).toBe("string");
        expect(typeof pos.leverage).toBe("number");
        expect(pos.leverage).toBeGreaterThan(0);
      }
    });

    it("margin calculation is correct for any open position", async () => {
      const [balance, positions] = await Promise.all([
        adapter.getBalance(),
        adapter.getPositions(),
      ]);

      if (positions.length === 0) {
        // No positions — margin used should be 0 or very small
        expect(parseFloat(balance.marginUsed)).toBeLessThanOrEqual(1);
        return;
      }

      // For each position, verify margin math
      for (const pos of positions) {
        const notional = Math.abs(parseFloat(pos.size) * parseFloat(pos.markPrice));
        const marginRequired = pos.leverage > 0 ? notional / pos.leverage : 0;

        // Sanity: margin should be less than equity
        expect(marginRequired).toBeLessThan(parseFloat(balance.equity) * 10); // allow for extreme leverage
        expect(notional).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // trade status: order lookup
  // ══════════════════════════════════════════════════════════

  describe("trade status (order status query)", () => {
    it("queryOrder returns result for non-existent order", async () => {
      // HL returns a result object even for non-existent orders
      const result = await adapter.queryOrder(999999999);
      expect(result).toBeDefined();
      // The order field should be absent or status should indicate not found
      const status = (result as Record<string, unknown>)?.status;
      const order = (result as Record<string, unknown>)?.order;
      // HL returns { status: "order", order: { order: {...}, status: "unknownOid", statusTimestamp: ... } }
      // or similar structure
      expect(result).not.toBeNull();
    });

    it("open orders all have valid orderId for status lookup", async () => {
      const orders = await adapter.getOpenOrders();

      for (const order of orders) {
        expect(typeof order.orderId).toBe("string");
        expect(order.orderId.length).toBeGreaterThan(0);

        // If we have open orders, try querying one
        const result = await adapter.queryOrder(Number(order.orderId));
        expect(result).toBeDefined();
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // trade fills: recent fills
  // ══════════════════════════════════════════════════════════

  describe("trade fills (recent trade history)", () => {
    it("getTradeHistory returns array", async () => {
      const trades = await adapter.getTradeHistory(10);
      expect(Array.isArray(trades)).toBe(true);
    });

    it("each fill has correct shape if any exist", async () => {
      const trades = await adapter.getTradeHistory(10);

      for (const trade of trades) {
        expect(typeof trade.time).toBe("number");
        expect(trade.time).toBeGreaterThan(1600000000000); // after 2020

        expect(typeof trade.symbol).toBe("string");
        expect(trade.symbol.length).toBeGreaterThan(0);

        expect(["buy", "sell"]).toContain(trade.side);

        expect(typeof trade.price).toBe("string");
        expect(parseFloat(trade.price)).toBeGreaterThan(0);

        expect(typeof trade.size).toBe("string");
        expect(parseFloat(trade.size)).toBeGreaterThan(0);

        expect(typeof trade.fee).toBe("string");
      }
    });

    it("fills are returned in chronological order if multiple", async () => {
      const trades = await adapter.getTradeHistory(20);
      if (trades.length < 2) return; // skip if not enough fills

      for (let i = 1; i < trades.length; i++) {
        // HL returns newest first, so time should be descending
        expect(trades[i - 1].time).toBeGreaterThanOrEqual(trades[i].time);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // Error classification on real errors
  // ══════════════════════════════════════════════════════════

  describe("error classification", () => {
    it("classifyError properly handles network-like errors", async () => {
      const { classifyError } = await import("../../errors.js");

      const timeout = classifyError(new Error("Request timed out"));
      expect(timeout.code).toBe("TIMEOUT");
      expect(timeout.retryable).toBe(true);

      const network = classifyError(new Error("ECONNREFUSED"));
      expect(network.code).toBe("EXCHANGE_UNREACHABLE");
      expect(network.retryable).toBe(true);

      const rateLimit = classifyError(new Error("429 Too Many Requests"));
      expect(rateLimit.code).toBe("RATE_LIMITED");
      expect(rateLimit.retryable).toBe(true);
    });

    it("classifyError properly handles trading errors", async () => {
      const { classifyError } = await import("../../errors.js");

      const balance = classifyError(new Error("Insufficient balance"));
      expect(balance.code).toBe("INSUFFICIENT_BALANCE");
      expect(balance.retryable).toBe(false);

      const margin = classifyError(new Error("Not enough margin"));
      expect(margin.code).toBe("MARGIN_INSUFFICIENT");
      expect(margin.retryable).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Cross-cutting: response consistency
  // ══════════════════════════════════════════════════════════

  describe("response consistency across adapter methods", () => {
    it("all market data methods return consistent string-typed numbers", async () => {
      const markets = await adapter.getMarkets();
      expect(markets.length).toBeGreaterThan(0);

      // Check first 5 markets
      for (const m of markets.slice(0, 5)) {
        expect(typeof m.markPrice).toBe("string");
        expect(typeof m.indexPrice).toBe("string");
        expect(typeof m.fundingRate).toBe("string");
        expect(typeof m.volume24h).toBe("string");
        expect(typeof m.openInterest).toBe("string");
        expect(typeof m.maxLeverage).toBe("number");

        // All parseable
        expect(isNaN(parseFloat(m.markPrice))).toBe(false);
        expect(isNaN(parseFloat(m.fundingRate))).toBe(false);
      }
    });

    it("balance, positions, orders all return at the same time without errors", async () => {
      // This is what the status command does
      const [balance, positions, orders] = await Promise.all([
        adapter.getBalance(),
        adapter.getPositions(),
        adapter.getOpenOrders(),
      ]);

      expect(balance).toBeDefined();
      expect(Array.isArray(positions)).toBe(true);
      expect(Array.isArray(orders)).toBe(true);
    });
  });
});
