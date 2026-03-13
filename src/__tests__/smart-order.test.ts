import { describe, it, expect, vi } from "vitest";
import { smartOrder } from "../smart-order.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

function mockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    name: "test",
    getMarkets: vi.fn(),
    getOrderbook: vi.fn().mockResolvedValue({
      bids: [["100.50", "10"], ["100.40", "20"], ["100.30", "15"]],
      asks: [["100.60", "10"], ["100.70", "20"], ["100.80", "15"]],
    }),
    getRecentTrades: vi.fn(),
    getFundingHistory: vi.fn(),
    getKlines: vi.fn(),
    getBalance: vi.fn(),
    getPositions: vi.fn(),
    getOpenOrders: vi.fn(),
    getOrderHistory: vi.fn(),
    getTradeHistory: vi.fn(),
    getFundingPayments: vi.fn(),
    marketOrder: vi.fn().mockResolvedValue({ orderId: "mkt-123" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "lmt-456" }),
    editOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    setLeverage: vi.fn(),
    stopOrder: vi.fn(),
    ...overrides,
  } as ExchangeAdapter;
}

describe("smartOrder", () => {
  it("places IOC limit at best ask + 1 tick for buy", async () => {
    const adapter = mockAdapter();
    const result = await smartOrder(adapter, "BTC", "buy", "0.1");

    expect(result.method).toBe("limit_ioc");
    expect(result.bestBookPrice).toBe("100.60");
    // Tick size from book: 100.70 - 100.60 = 0.10
    // Price = 100.60 + 0.10 = 100.70
    expect(result.price).toBe("100.70");
    expect(result.tickSize).toBe("0.10");
    expect(adapter.limitOrder).toHaveBeenCalledWith(
      "BTC", "buy", "100.70", "0.1",
      { tif: "IOC", reduceOnly: false },
    );
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("places IOC limit at best bid - 1 tick for sell", async () => {
    const adapter = mockAdapter();
    const result = await smartOrder(adapter, "BTC", "sell", "0.1");

    expect(result.method).toBe("limit_ioc");
    expect(result.bestBookPrice).toBe("100.50");
    // Tick size from bids: 100.50 - 100.40 = 0.10
    // Price = 100.50 - 0.10 = 100.40
    expect(result.price).toBe("100.40");
    expect(adapter.limitOrder).toHaveBeenCalledWith(
      "BTC", "sell", "100.40", "0.1",
      { tif: "IOC", reduceOnly: false },
    );
  });

  it("falls back to market order when IOC limit fails", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue(new Error("Rejected")),
    });
    const result = await smartOrder(adapter, "BTC", "buy", "0.1");

    expect(result.method).toBe("market_fallback");
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.1");
  });

  it("throws when IOC limit fails and fallback=false", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue(new Error("Rejected")),
    });

    await expect(
      smartOrder(adapter, "BTC", "buy", "0.1", { fallback: false }),
    ).rejects.toThrow("Rejected");
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("falls back to market when orderbook has no asks (buy)", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["100.50", "10"]],
        asks: [],
      }),
    });
    const result = await smartOrder(adapter, "BTC", "buy", "0.1");

    expect(result.method).toBe("market_fallback");
    expect(adapter.marketOrder).toHaveBeenCalled();
  });

  it("falls back to market when orderbook has no bids (sell)", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [],
        asks: [["100.60", "10"]],
      }),
    });
    const result = await smartOrder(adapter, "BTC", "sell", "0.1");

    expect(result.method).toBe("market_fallback");
    expect(adapter.marketOrder).toHaveBeenCalled();
  });

  it("uses custom tick tolerance", async () => {
    const adapter = mockAdapter();
    const result = await smartOrder(adapter, "BTC", "buy", "0.1", { tickTolerance: 3 });

    // Tick = 0.10, tolerance = 3 ticks
    // Price = 100.60 + 0.10 * 3 = 100.90
    expect(result.price).toBe("100.90");
  });

  it("passes reduceOnly flag", async () => {
    const adapter = mockAdapter();
    await smartOrder(adapter, "BTC", "sell", "0.1", { reduceOnly: true });

    expect(adapter.limitOrder).toHaveBeenCalledWith(
      "BTC", "sell", expect.any(String), "0.1",
      { tif: "IOC", reduceOnly: true },
    );
  });

  it("infers tick from single-level orderbook", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["50.25", "100"]],
        asks: [["50.30", "100"]],
      }),
    });
    const result = await smartOrder(adapter, "SOL", "buy", "1");

    // Single level: tick inferred from decimal places (0.01)
    // Price = 50.30 + 0.01 = 50.31
    expect(result.price).toBe("50.31");
    expect(result.tickSize).toBe("0.01");
  });

  it("handles integer prices (no decimals)", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["100", "10"], ["99", "20"]],
        asks: [["101", "10"], ["102", "20"]],
      }),
    });
    const result = await smartOrder(adapter, "BTC", "buy", "0.01");

    // Tick = 1 (from 102 - 101)
    // Price = 101 + 1 = 102
    expect(result.price).toBe("102");
    expect(result.tickSize).toBe("1");
  });

  it("falls back when IOC succeeds but response contains error (e.g., HL)", async () => {
    // Hyperliquid returns success at HTTP level but embeds error in statuses
    const hlResponse = {
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [{ error: "Order could not immediately match against any resting orders." }],
        },
      },
    };
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockResolvedValue(hlResponse),
    });
    const result = await smartOrder(adapter, "BTC", "sell", "0.1");

    expect(result.method).toBe("market_fallback");
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.1");
  });

  it("rounds tick size to eliminate floating-point noise", async () => {
    // Prices like "1.1" and "1.2" produce diff = 0.10000000000000009 in JS
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["1.2", "10"], ["1.1", "20"], ["1.0", "15"]],
        asks: [["1.3", "10"], ["1.4", "20"], ["1.5", "15"]],
      }),
    });
    const result = await smartOrder(adapter, "TOKEN", "buy", "100");

    // Tick should be exactly 0.1, not 0.10000000000000009
    expect(result.tickSize).toBe("0.1");
    // Price = 1.3 + 0.1 = 1.4
    expect(result.price).toBe("1.4");
  });

  it("does not fallback on embedded error when fallback=false", async () => {
    const hlResponse = {
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [{ error: "Order could not immediately match" }],
        },
      },
    };
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockResolvedValue(hlResponse),
    });
    const result = await smartOrder(adapter, "BTC", "sell", "0.1", { fallback: false });

    // Without fallback, returns the IOC result as-is (caller handles error)
    expect(result.method).toBe("limit_ioc");
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });
});
