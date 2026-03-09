import { describe, it, expect, vi, beforeEach } from "vitest";

// ══════════════════════════════════════════════
// Strategy Calculators — Pure Logic Tests
//
// These tests focus on the calculation logic in the strategy modules,
// not the I/O-heavy run loops. We test:
// - TWAP: slice sizing, interval computation, last-slice remainder
// - Grid: validation, grid line generation, step calculation
// - DCA: parameter handling, state initialization
// ══════════════════════════════════════════════

// We import types and test the computational parts by exercising
// the functions with mocked adapters, using short timeouts.

// Mock jobs module to prevent file I/O
vi.mock("../jobs.js", () => ({
  updateJobState: vi.fn(),
}));

// ── Mock adapter factory ──

function mockAdapter(overrides?: Partial<Record<string, unknown>>) {
  return {
    name: "test",
    getMarkets: vi.fn().mockResolvedValue([
      { symbol: "BTC", markPrice: "60000", indexPrice: "60000", fundingRate: "0.0001", volume24h: "1000000", openInterest: "500000", maxLeverage: 20 },
    ]),
    getBalance: vi.fn().mockResolvedValue({ equity: "10000", available: "8000", marginUsed: "2000", unrealizedPnl: "0" }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [["59990", "1"]], asks: [["60010", "1"]] }),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    marketOrder: vi.fn().mockResolvedValue({ orderId: "m1", price: "60000" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "l1" }),
    editOrder: vi.fn().mockResolvedValue({}),
    cancelOrder: vi.fn().mockResolvedValue({}),
    cancelAllOrders: vi.fn().mockResolvedValue({}),
    setLeverage: vi.fn().mockResolvedValue({}),
    stopOrder: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any;
}

// ══════════════════════════════════════════════
// TWAP Strategy Tests
// ══════════════════════════════════════════════

describe("TWAP — runTWAP", () => {
  it("computes correct totalSlices from duration (default: 1 slice per 30s)", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    const result = await runTWAP(adapter, {
      symbol: "BTC",
      side: "buy",
      totalSize: 1.0,
      durationSec: 3, // 3 seconds / 30 = 0.1 → Math.max(floor, 2) = 2 slices
    }, undefined, log);

    expect(result.totalSlices).toBe(2);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(2);
  });

  it("uses custom slice count when provided", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    const result = await runTWAP(adapter, {
      symbol: "BTC",
      side: "sell",
      totalSize: 0.5,
      durationSec: 5,
      slices: 5,
    }, undefined, log);

    expect(result.totalSlices).toBe(5);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(5);
  });

  it("fills the exact total size across all slices (no dust)", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    const result = await runTWAP(adapter, {
      symbol: "BTC",
      side: "buy",
      totalSize: 1.0,
      durationSec: 1,
      slices: 3,
    }, undefined, log);

    expect(result.filled).toBeCloseTo(1.0);
  });

  it("last slice handles remainder correctly", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    // 1.0 / 3 = 0.3333... per slice. Last slice should do remaining.
    await runTWAP(adapter, {
      symbol: "BTC",
      side: "buy",
      totalSize: 1.0,
      durationSec: 1,
      slices: 3,
    }, undefined, log);

    const calls = adapter.marketOrder.mock.calls;
    expect(calls).toHaveLength(3);
    // First two slices: 1/3 = 0.3333...
    const slice1 = parseFloat(calls[0][2]);
    const slice2 = parseFloat(calls[1][2]);
    const slice3 = parseFloat(calls[2][2]);
    expect(slice1).toBeCloseTo(1 / 3, 4);
    expect(slice2).toBeCloseTo(1 / 3, 4);
    // Last slice = remainder (handles dust)
    expect(slice1 + slice2 + slice3).toBeCloseTo(1.0, 6);
  });

  it("handles order errors without aborting (continues other slices)", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    let callCount = 0;
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.reject(new Error("temporary error"));
        return Promise.resolve({ orderId: "ok", price: "60000" });
      }),
    });
    const log = vi.fn();

    const result = await runTWAP(adapter, {
      symbol: "BTC",
      side: "buy",
      totalSize: 1.0,
      durationSec: 1,
      slices: 4,
    }, undefined, log);

    expect(result.errors).toBe(1);
    expect(result.slicesDone).toBe(3); // 4 attempts, 1 failed, 3 succeeded
  });

  it("aborts when too many errors (>50% of slices)", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockRejectedValue(new Error("always fails")),
    });
    const log = vi.fn();

    const result = await runTWAP(adapter, {
      symbol: "BTC",
      side: "buy",
      totalSize: 1.0,
      durationSec: 1,
      slices: 4,
    }, undefined, log);

    // Should abort after 3rd error (3 > 4*0.5)
    expect(result.errors).toBeGreaterThan(0);
    expect(result.slicesDone).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Too many errors"));
  });

  it("passes correct side to market orders", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    await runTWAP(adapter, {
      symbol: "ETH",
      side: "sell",
      totalSize: 2.0,
      durationSec: 1,
      slices: 2,
    }, undefined, log);

    for (const call of adapter.marketOrder.mock.calls) {
      expect(call[0]).toBe("ETH");
      expect(call[1]).toBe("sell");
    }
  });
});

// ══════════════════════════════════════════════
// Grid Strategy Tests
// ══════════════════════════════════════════════

describe("Grid — runGrid validation", () => {
  it("rejects upperPrice <= lowerPrice", async () => {
    const { runGrid } = await import("../strategies/grid.js");
    const adapter = mockAdapter();

    await expect(runGrid(adapter, {
      symbol: "BTC",
      side: "neutral",
      upperPrice: 100,
      lowerPrice: 100,
      grids: 5,
      totalSize: 1,
    })).rejects.toThrow("upperPrice must be > lowerPrice");
  });

  it("rejects fewer than 2 grid lines", async () => {
    const { runGrid } = await import("../strategies/grid.js");
    const adapter = mockAdapter();

    await expect(runGrid(adapter, {
      symbol: "BTC",
      side: "neutral",
      upperPrice: 200,
      lowerPrice: 100,
      grids: 1,
      totalSize: 1,
    })).rejects.toThrow("at least 2 grid lines");
  });
});

describe("Grid — order placement", () => {
  it("places correct number of grid orders", async () => {
    const { runGrid } = await import("../strategies/grid.js");
    const adapter = mockAdapter({
      // Return no open orders to prevent fill-monitoring from running
      getOpenOrders: vi.fn().mockResolvedValue(
        // Return all grid order IDs as still open to prevent fill loop churn
        Array.from({ length: 5 }, (_, i) => ({
          orderId: "l1",
          symbol: "BTC",
          side: "buy",
          price: String(59000 + i * 500),
          size: "0.2",
          filled: "0",
          status: "open",
          type: "limit",
        })),
      ),
    });
    const log = vi.fn();

    // Use maxRuntime to stop quickly
    const resultPromise = runGrid(adapter, {
      symbol: "BTC",
      side: "neutral",
      upperPrice: 61000,
      lowerPrice: 59000,
      grids: 5,
      totalSize: 1,
      intervalSec: 0.01,
      maxRuntime: 0.05, // stop after 50ms
    }, undefined, log);

    const result = await resultPromise;
    // Should have placed 5 initial grid orders
    expect(adapter.limitOrder).toHaveBeenCalledTimes(5);
  });

  it("computes correct step size", async () => {
    const { runGrid } = await import("../strategies/grid.js");
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue(
        Array.from({ length: 3 }, () => ({
          orderId: "l1", symbol: "BTC", side: "buy", price: "60000", size: "0.1",
          filled: "0", status: "open", type: "limit",
        })),
      ),
    });
    const log = vi.fn();

    await runGrid(adapter, {
      symbol: "BTC",
      side: "neutral",
      upperPrice: 62000,
      lowerPrice: 60000,
      grids: 3,
      totalSize: 0.3,
      intervalSec: 0.01,
      maxRuntime: 0.05,
    }, undefined, log);

    // step = (62000 - 60000) / (3-1) = 1000
    // Grid lines at: 60000, 61000, 62000
    const calls = adapter.limitOrder.mock.calls;
    expect(calls).toHaveLength(3);

    const prices = calls.map((c: any[]) => parseFloat(c[2]));
    prices.sort((a: number, b: number) => a - b);
    expect(prices[0]).toBeCloseTo(60000);
    expect(prices[1]).toBeCloseTo(61000);
    expect(prices[2]).toBeCloseTo(62000);
  });

  it("distributes size equally across grid lines", async () => {
    const { runGrid } = await import("../strategies/grid.js");
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue(
        Array.from({ length: 4 }, () => ({
          orderId: "l1", symbol: "BTC", side: "buy", price: "60000", size: "0.25",
          filled: "0", status: "open", type: "limit",
        })),
      ),
    });
    const log = vi.fn();

    await runGrid(adapter, {
      symbol: "BTC",
      side: "neutral",
      upperPrice: 62000,
      lowerPrice: 60000,
      grids: 4,
      totalSize: 2.0,
      intervalSec: 0.01,
      maxRuntime: 0.05,
    }, undefined, log);

    // Each grid line gets 2.0/4 = 0.5
    for (const call of adapter.limitOrder.mock.calls) {
      expect(parseFloat(call[3])).toBeCloseTo(0.5);
    }
  });

  it("assigns buy below current price and sell above for neutral side", async () => {
    const { runGrid } = await import("../strategies/grid.js");
    const adapter = mockAdapter({
      getMarkets: vi.fn().mockResolvedValue([
        { symbol: "BTC", markPrice: "61000", indexPrice: "61000", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 20 },
      ]),
      getOpenOrders: vi.fn().mockResolvedValue(
        Array.from({ length: 5 }, () => ({
          orderId: "l1", symbol: "BTC", side: "buy", price: "60000", size: "0.1",
          filled: "0", status: "open", type: "limit",
        })),
      ),
    });
    const log = vi.fn();

    await runGrid(adapter, {
      symbol: "BTC",
      side: "neutral",
      upperPrice: 63000,
      lowerPrice: 59000,
      grids: 5, // step = 1000. Lines: 59000, 60000, 61000, 62000, 63000
      totalSize: 0.5,
      intervalSec: 0.01,
      maxRuntime: 0.05,
    }, undefined, log);

    // Current price = 61000
    // 59000 → buy, 60000 → buy, 61000 → sell (>=61000), 62000 → sell, 63000 → sell
    const calls = adapter.limitOrder.mock.calls;
    const orders = calls.map((c: any[]) => ({ side: c[1], price: parseFloat(c[2]) }));
    orders.sort((a: {price:number}, b: {price:number}) => a.price - b.price);

    // Lines below current (59000, 60000) should be buy
    expect(orders[0].side).toBe("buy");
    expect(orders[1].side).toBe("buy");
    // Lines at or above current (61000, 62000, 63000) should be sell
    expect(orders[2].side).toBe("sell");
    expect(orders[3].side).toBe("sell");
    expect(orders[4].side).toBe("sell");
  });

  it("sets leverage if provided", async () => {
    const { runGrid } = await import("../strategies/grid.js");
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue([
        { orderId: "l1", symbol: "BTC", side: "buy", price: "60000", size: "0.5", filled: "0", status: "open", type: "limit" },
        { orderId: "l1", symbol: "BTC", side: "sell", price: "62000", size: "0.5", filled: "0", status: "open", type: "limit" },
      ]),
    });
    const log = vi.fn();

    await runGrid(adapter, {
      symbol: "BTC",
      side: "neutral",
      upperPrice: 62000,
      lowerPrice: 60000,
      grids: 2,
      totalSize: 1,
      leverage: 5,
      intervalSec: 0.01,
      maxRuntime: 0.05,
    }, undefined, log);

    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 5);
  });
});

// ══════════════════════════════════════════════
// DCA Strategy Tests
// ══════════════════════════════════════════════

describe("DCA — runDCA", () => {
  it("places the specified number of orders then stops", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    const result = await runDCA(adapter, {
      symbol: "BTC",
      side: "buy",
      amountPerOrder: 0.01,
      intervalSec: 0.001, // 1ms intervals for fast test
      totalOrders: 3,
    }, undefined, log);

    expect(result.ordersPlaced).toBe(3);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(3);
  });

  it("passes correct symbol, side, and size to each order", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    await runDCA(adapter, {
      symbol: "ETH",
      side: "sell",
      amountPerOrder: 0.5,
      intervalSec: 0.001,
      totalOrders: 2,
    }, undefined, log);

    for (const call of adapter.marketOrder.mock.calls) {
      expect(call[0]).toBe("ETH");
      expect(call[1]).toBe("sell");
      expect(call[2]).toBe("0.5");
    }
  });

  it("tracks total filled amount", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    const result = await runDCA(adapter, {
      symbol: "BTC",
      side: "buy",
      amountPerOrder: 0.1,
      intervalSec: 0.001,
      totalOrders: 5,
    }, undefined, log);

    expect(result.totalFilled).toBeCloseTo(0.5);
  });

  it("computes average price from fill prices", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    let callNum = 0;
    const prices = [59000, 60000, 61000];
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockImplementation(() => {
        const price = prices[callNum++];
        return Promise.resolve({ orderId: `m${callNum}`, price: String(price) });
      }),
    });
    const log = vi.fn();

    const result = await runDCA(adapter, {
      symbol: "BTC",
      side: "buy",
      amountPerOrder: 1,
      intervalSec: 0.001,
      totalOrders: 3,
    }, undefined, log);

    // avg = (1*59000 + 1*60000 + 1*61000) / 3 = 60000
    expect(result.avgPrice).toBeCloseTo(60000);
  });

  it("continues on individual order errors", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    // DCA keeps going until ordersPlaced reaches totalOrders.
    // If one call fails, it retries on the next loop iteration.
    // So with totalOrders=3, it needs 4 calls: succeed, fail, succeed, succeed → 3 placed.
    const marketOrderMock = vi.fn()
      .mockResolvedValueOnce({ orderId: "m1", price: "60000" })
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ orderId: "m3", price: "60000" })
      .mockResolvedValueOnce({ orderId: "m4", price: "60000" });
    const adapter = mockAdapter({ marketOrder: marketOrderMock });
    const log = vi.fn();

    const result = await runDCA(adapter, {
      symbol: "BTC",
      side: "buy",
      amountPerOrder: 0.1,
      intervalSec: 0.001,
      totalOrders: 3,
    }, undefined, log);

    // 4 marketOrder calls: 3 succeeded, 1 failed
    expect(marketOrderMock).toHaveBeenCalledTimes(4);
    expect(result.ordersPlaced).toBe(3);
    // Verify an error was logged
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Order error"));
  });

  it("stops when too many errors (errors > ordersPlaced and errors > 10)", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockRejectedValue(new Error("always fails")),
    });
    const log = vi.fn();

    const result = await runDCA(adapter, {
      symbol: "BTC",
      side: "buy",
      amountPerOrder: 0.1,
      intervalSec: 0.001,
      totalOrders: 100, // high count but errors will stop it
    }, undefined, log);

    // Stops at 11 errors (>10 and >0 placed)
    expect(result.ordersPlaced).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Too many errors"));
  });

  it("skips order when buy price exceeds price limit", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    const adapter = mockAdapter({
      getMarkets: vi.fn().mockResolvedValue([
        { symbol: "BTC", markPrice: "65000", indexPrice: "65000", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 20 },
      ]),
    });
    const log = vi.fn();

    // Price limit of $60000, but market is at $65000 — should skip
    // With totalOrders=0 this would loop forever, so we use maxRuntime
    const result = await runDCA(adapter, {
      symbol: "BTC",
      side: "buy",
      amountPerOrder: 0.1,
      intervalSec: 0.001,
      totalOrders: 2,
      priceLimit: 60000,
      maxRuntime: 0.1, // 100ms timeout
    }, undefined, log);

    expect(result.ordersPlaced).toBe(0);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("respects maxRuntime", async () => {
    const { runDCA } = await import("../strategies/dca.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    const start = Date.now();
    const result = await runDCA(adapter, {
      symbol: "BTC",
      side: "buy",
      amountPerOrder: 0.01,
      intervalSec: 0.01, // 10ms intervals (short enough to not block)
      totalOrders: 0,     // unlimited
      maxRuntime: 0.1,    // 100ms max
    }, undefined, log);

    const elapsed = Date.now() - start;
    // Should stop within a reasonable time (definitely under 5s)
    expect(elapsed).toBeLessThan(5000);
    // With 10ms intervals and 100ms runtime, should place a handful of orders but not many
    expect(result.ordersPlaced).toBeGreaterThanOrEqual(1);
    expect(result.ordersPlaced).toBeLessThan(50); // sanity check
  });
});

// ══════════════════════════════════════════════
// TWAP Slice Calculation (unit-level)
// ══════════════════════════════════════════════

describe("TWAP — slice calculation edge cases", () => {
  it("minimum 2 slices even for very short duration", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const adapter = mockAdapter();
    const log = vi.fn();

    const result = await runTWAP(adapter, {
      symbol: "BTC",
      side: "buy",
      totalSize: 0.1,
      durationSec: 1, // 1s / 30 = 0.03 → floor = 0 → max(0, 2) = 2
    }, undefined, log);

    expect(result.totalSlices).toBe(2);
  });

  it("reports correct remaining after partial completion", async () => {
    const { runTWAP } = await import("../strategies/twap.js");
    const marketOrderMock = vi.fn()
      .mockResolvedValueOnce({ orderId: "ok" })
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ orderId: "ok" });
    const adapter = mockAdapter({ marketOrder: marketOrderMock });
    const log = vi.fn();

    const result = await runTWAP(adapter, {
      symbol: "BTC",
      side: "buy",
      totalSize: 1.0,
      durationSec: 1,
      slices: 3,
    }, undefined, log);

    // 3 slices, each nominally 1/3. Slice 2 fails.
    // Slice 1: filled += 1/3, remaining = 2/3
    // Slice 2: fails, no change to filled/remaining
    // Slice 3 is last slice: uses state.remaining = 2/3 as the size
    // Slice 3: filled += 2/3, remaining = 0
    // So final remaining = 0, filled = 1.0
    expect(result.slicesDone).toBe(2);
    expect(result.errors).toBe(1);
    // Last slice picks up all remaining, so total filled = 1/3 + 2/3 = 1.0
    expect(result.remaining).toBeCloseTo(0, 2);
    expect(result.filled).toBeCloseTo(1.0, 2);
  });
});
