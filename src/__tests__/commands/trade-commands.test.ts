import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerTradeCommands } from "../../commands/trade.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

// ── Mock dependencies to prevent file I/O ──

vi.mock("../../execution-log.js", () => ({
  logExecution: vi.fn(),
}));

vi.mock("../../client-id-tracker.js", () => ({
  generateClientId: vi.fn(() => "test-id-123"),
  logClientId: vi.fn(),
  isOrderDuplicate: vi.fn(() => false),
}));

vi.mock("../../trade-validator.js", () => ({
  validateTrade: vi.fn().mockResolvedValue({
    valid: true,
    checks: [],
    warnings: [],
    timestamp: new Date().toISOString(),
  }),
}));

// Import mocked modules so we can control their behavior per-test
import { generateClientId, logClientId, isOrderDuplicate } from "../../client-id-tracker.js";
import { logExecution } from "../../execution-log.js";

// ── Mock adapter factory ──

function mockAdapter(overrides?: Record<string, unknown>) {
  return {
    name: "test-exchange",
    marketOrder: vi.fn().mockResolvedValue({ orderId: "m1", status: "filled" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "l1", status: "open" }),
    stopOrder: vi.fn().mockResolvedValue({ orderId: "s1" }),
    cancelOrder: vi.fn().mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ cancelled: 3 }),
    editOrder: vi.fn().mockResolvedValue({ success: true }),
    setLeverage: vi.fn().mockResolvedValue({ leverage: 10 }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({
      equity: "1000",
      available: "800",
      marginUsed: "200",
      unrealizedPnl: "0",
    }),
    getMarkets: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ExchangeAdapter;
}

// ── Helper: create a program, register commands, and parse ──

function createProgram(adapter: ExchangeAdapter) {
  const program = new Command();
  program.exitOverride(); // Prevent process.exit on parse errors
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerTradeCommands(
    program,
    async () => adapter,
    () => false, // isJson = false
  );
  return program;
}

async function run(adapter: ExchangeAdapter, args: string[]) {
  const program = createProgram(adapter);
  // Suppress console output during tests
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await program.parseAsync(["node", "perp", ...args]);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

// ── Shared setup ──

beforeEach(() => {
  vi.clearAllMocks();
  // Reset isOrderDuplicate to default: not a duplicate
  vi.mocked(isOrderDuplicate).mockReturnValue(false);
});

// ══════════════════════════════════════════════════════════════
// 1. Market Order -- parameter correctness
// ══════════════════════════════════════════════════════════════

describe("trade market -- parameter correctness", () => {
  it("calls adapter.marketOrder with uppercased symbol, lowercased side, and string size", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.1");
  });

  it("uppercases mixed-case symbol", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "Eth", "sell", "2.5"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "sell", "2.5");
  });

  it("lowercases the side argument", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "sol", "BUY", "5"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("SOL", "buy", "5");
  });

  it("passes size as a string, not a number", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.001"]);

    const args = vi.mocked(adapter.marketOrder).mock.calls[0];
    expect(typeof args[2]).toBe("string");
    expect(args[2]).toBe("0.001");
  });

  it("rejects invalid side (exits with error)", async () => {
    const adapter = mockAdapter();
    // errorAndExit calls process.exit(1), which we can catch via exitOverride or mock
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "market", "btc", "long", "1"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════
// 2. Market Order -- client ID flow
// ══════════════════════════════════════════════════════════════

describe("trade market -- client ID flow", () => {
  it("with --auto-id: generates client ID and logs pending then submitted", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1", "--auto-id"]);

    // generateClientId was called
    expect(generateClientId).toHaveBeenCalled();

    // logClientId called twice: once pending, once submitted
    expect(logClientId).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(logClientId).mock.calls[0][0];
    const secondCall = vi.mocked(logClientId).mock.calls[1][0];
    expect(firstCall.clientOrderId).toBe("test-id-123");
    expect(firstCall.status).toBe("pending");
    expect(firstCall.symbol).toBe("BTC");
    expect(firstCall.side).toBe("buy");
    expect(firstCall.type).toBe("market");
    expect(secondCall.clientOrderId).toBe("test-id-123");
    expect(secondCall.status).toBe("submitted");

    // Adapter still called
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
  });

  it("with --client-id my-id: uses the provided ID", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1", "--client-id", "my-id"]);

    // generateClientId was NOT called
    expect(generateClientId).not.toHaveBeenCalled();

    // logClientId called with user's ID
    expect(logClientId).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logClientId).mock.calls[0][0].clientOrderId).toBe("my-id");
    expect(vi.mocked(logClientId).mock.calls[1][0].clientOrderId).toBe("my-id");

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
  });

  it("duplicate detection: when isOrderDuplicate returns true, adapter is NOT called", async () => {
    vi.mocked(isOrderDuplicate).mockReturnValue(true);
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1", "--client-id", "dup-id"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    // logClientId should NOT be called for duplicates
    expect(logClientId).not.toHaveBeenCalled();
  });

  it("without --auto-id or --client-id: no client ID tracking", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1"]);

    expect(generateClientId).not.toHaveBeenCalled();
    expect(logClientId).not.toHaveBeenCalled();
    // Adapter still called
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Limit Order -- parameter correctness
// ══════════════════════════════════════════════════════════════

describe("trade limit -- parameter correctness", () => {
  it("calls adapter.limitOrder with uppercased symbol, lowercased side, price, size", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "eth", "sell", "2000", "1.5"]);

    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).toHaveBeenCalledWith("ETH", "sell", "2000", "1.5");
  });

  it("all four args are strings", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "65000", "0.05"]);

    const args = vi.mocked(adapter.limitOrder).mock.calls[0];
    expect(typeof args[0]).toBe("string"); // symbol
    expect(typeof args[1]).toBe("string"); // side
    expect(typeof args[2]).toBe("string"); // price
    expect(typeof args[3]).toBe("string"); // size
  });

  it("client ID works the same as market order", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "60000", "0.1", "--auto-id"]);

    expect(generateClientId).toHaveBeenCalled();
    expect(logClientId).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logClientId).mock.calls[0][0].type).toBe("limit");
    expect(vi.mocked(logClientId).mock.calls[0][0].status).toBe("pending");
    expect(vi.mocked(logClientId).mock.calls[1][0].status).toBe("submitted");
    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
  });

  it("duplicate detection prevents execution for limit orders too", async () => {
    vi.mocked(isOrderDuplicate).mockReturnValue(true);
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "60000", "0.1", "--client-id", "dup"]);

    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Stop Order -- parameter correctness
// ══════════════════════════════════════════════════════════════

describe("trade stop -- parameter correctness", () => {
  it("calls adapter.stopOrder with correct args and options", async () => {
    const adapter = mockAdapter();
    await run(adapter, [
      "trade", "stop", "btc", "sell", "0.1", "60000",
      "--limit-price", "59500", "--reduce-only",
    ]);

    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "BTC",
      "sell",
      "0.1",
      "60000",
      { limitPrice: "59500", reduceOnly: true },
    );
  });

  it("without --limit-price and --reduce-only: options have undefined values", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "btc", "sell", "0.1", "60000"]);

    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "BTC",
      "sell",
      "0.1",
      "60000",
      { limitPrice: undefined, reduceOnly: undefined },
    );
  });

  it("uppercases symbol for stop orders", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "eth", "buy", "1", "3500"]);

    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "ETH",
      "buy",
      "1",
      "3500",
      { limitPrice: undefined, reduceOnly: undefined },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Cancel Order
// ══════════════════════════════════════════════════════════════

describe("trade cancel -- parameter correctness", () => {
  it("calls adapter.cancelOrder with uppercased symbol and orderId", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "btc", "abc123"]);

    expect(adapter.cancelOrder).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("BTC", "abc123");
  });

  it("uppercases mixed-case symbol", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "Sol", "order-456"]);

    expect(adapter.cancelOrder).toHaveBeenCalledWith("SOL", "order-456");
  });

  it("no other adapter methods are called", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "btc", "abc123"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 6. Cancel All Orders
// ══════════════════════════════════════════════════════════════

describe("trade cancel-all", () => {
  it("calls adapter.cancelAllOrders with no arguments", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel-all"]);

    expect(adapter.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(adapter.cancelAllOrders).toHaveBeenCalledWith();
  });

  it("no other adapter methods are called", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel-all"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 7. Set Leverage
// ══════════════════════════════════════════════════════════════

describe("trade leverage", () => {
  it("calls adapter.setLeverage with uppercased symbol, parsed int, and 'cross' by default", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "btc", "10"]);

    expect(adapter.setLeverage).toHaveBeenCalledTimes(1);
    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 10, "cross");
  });

  it("with --isolated: passes 'isolated' as margin mode", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "btc", "10", "--isolated"]);

    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 10, "isolated");
  });

  it("leverage is parsed as integer", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "eth", "25"]);

    const args = vi.mocked(adapter.setLeverage).mock.calls[0];
    expect(args[1]).toBe(25);
    expect(typeof args[1]).toBe("number");
  });
});

// ══════════════════════════════════════════════════════════════
// 8. Close Position -- side mapping
// ══════════════════════════════════════════════════════════════

describe("trade close -- side mapping", () => {
  it("LONG position -> calls marketOrder with 'sell' (opposite side)", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        {
          symbol: "BTC",
          side: "long",
          size: "0.5",
          entryPrice: "60000",
          markPrice: "61000",
          liquidationPrice: "50000",
          unrealizedPnl: "500",
          leverage: 10,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.5");
  });

  it("SHORT position -> calls marketOrder with 'buy' (opposite side)", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        {
          symbol: "ETH",
          side: "short",
          size: "3.0",
          entryPrice: "3000",
          markPrice: "2900",
          liquidationPrice: "4000",
          unrealizedPnl: "300",
          leverage: 5,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "eth"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "buy", "3.0");
  });

  it("no position -> error, adapter.marketOrder NOT called", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "close", "btc"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("uses the full position size to close", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        {
          symbol: "SOL",
          side: "long",
          size: "100",
          entryPrice: "150",
          markPrice: "155",
          liquidationPrice: "120",
          unrealizedPnl: "500",
          leverage: 3,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "sol"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("SOL", "sell", "100");
  });

  it("logs execution after closing", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        {
          symbol: "BTC",
          side: "long",
          size: "0.1",
          entryPrice: "60000",
          markPrice: "61000",
          liquidationPrice: "50000",
          unrealizedPnl: "100",
          leverage: 10,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(logExecution).toHaveBeenCalledTimes(1);
    expect(logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "market_order",
        symbol: "BTC",
        side: "sell",
        size: "0.1",
        meta: expect.objectContaining({ action: "close", originalSide: "long" }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 9. Close All -- iterates all positions
// ══════════════════════════════════════════════════════════════

describe("trade close-all -- iterates all positions", () => {
  it("3 positions (BTC long, ETH short, SOL long) -> 3 marketOrder calls with correct opposite sides", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "0.5", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "500", leverage: 10 },
        { symbol: "ETH", side: "short", size: "5.0", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "500", leverage: 5 },
        { symbol: "SOL", side: "long", size: "100", entryPrice: "150", markPrice: "155", liquidationPrice: "120", unrealizedPnl: "500", leverage: 3 },
      ]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(3);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "sell", "0.5");
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "buy", "5.0");
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(3, "SOL", "sell", "100");
  });

  it("0 positions -> no marketOrder calls", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("logs execution for each closed position", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "0.5", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "500", leverage: 10 },
        { symbol: "ETH", side: "short", size: "2.0", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "200", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(logExecution).toHaveBeenCalledTimes(2);
    expect(logExecution).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        symbol: "BTC",
        side: "sell",
        meta: expect.objectContaining({ action: "close-all", originalSide: "long" }),
      }),
    );
    expect(logExecution).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        symbol: "ETH",
        side: "buy",
        meta: expect.objectContaining({ action: "close-all", originalSide: "short" }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 10. Flatten -- cancel + close
// ══════════════════════════════════════════════════════════════

describe("trade flatten -- cancel + close", () => {
  it("calls cancelAllOrders first, then marketOrder for each position with opposite side", async () => {
    const callOrder: string[] = [];
    const adapter = mockAdapter({
      cancelAllOrders: vi.fn().mockImplementation(async () => {
        callOrder.push("cancelAllOrders");
        return { cancelled: 2 };
      }),
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "1.0", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 },
        { symbol: "ETH", side: "short", size: "10", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "1000", leverage: 5 },
      ]),
      marketOrder: vi.fn().mockImplementation(async (symbol: string) => {
        callOrder.push(`marketOrder:${symbol}`);
        return { orderId: "flat" };
      }),
    });
    await run(adapter, ["trade", "flatten"]);

    // Verify order: cancel first, then close positions
    expect(callOrder).toEqual(["cancelAllOrders", "marketOrder:BTC", "marketOrder:ETH"]);

    expect(adapter.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(2);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "sell", "1.0");
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "buy", "10");
  });

  it("with no positions: still calls cancelAllOrders, but no marketOrder", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([]),
    });
    await run(adapter, ["trade", "flatten"]);

    expect(adapter.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("logs execution for each position closed during flatten", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "SOL", side: "long", size: "50", entryPrice: "150", markPrice: "155", liquidationPrice: "120", unrealizedPnl: "250", leverage: 3 },
      ]),
    });
    await run(adapter, ["trade", "flatten"]);

    expect(logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "market_order",
        symbol: "SOL",
        side: "sell",
        size: "50",
        meta: expect.objectContaining({ action: "flatten", originalSide: "long" }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 11. Reduce -- percentage calculation
// ══════════════════════════════════════════════════════════════

describe("trade reduce -- percentage calculation", () => {
  it("BTC long size=10, reduce 50% -> marketOrder('BTC', 'sell', '5')", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "5");
  });

  it("BTC short size=4, reduce 25% -> marketOrder('BTC', 'buy', '1')", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "short", size: "4", entryPrice: "60000", markPrice: "59000", liquidationPrice: "70000", unrealizedPnl: "4000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "25"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "1");
  });

  it("reduce 100% -> closes full position", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "ETH", side: "long", size: "5", entryPrice: "3000", markPrice: "3100", liquidationPrice: "2500", unrealizedPnl: "500", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "eth", "100"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "sell", "5");
  });

  it("no position -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "50"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("invalid percent 0 -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "0"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("invalid percent 101 -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "101"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("invalid percent -1 -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "-1"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("logs execution with reduce metadata", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "market_order",
        symbol: "BTC",
        side: "sell",
        size: "5",
        meta: expect.objectContaining({ action: "reduce", percent: 50, originalSize: "10", originalSide: "long" }),
      }),
    );
  });

  it("fractional percentage: reduce 33.3% of size 9 -> '2.9970000000000003' (floating point)", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "9", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "9000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "33.3"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    // 9 * 33.3 / 100 = 2.997
    const callArgs = vi.mocked(adapter.marketOrder).mock.calls[0];
    expect(callArgs[0]).toBe("BTC");
    expect(callArgs[1]).toBe("sell");
    expect(parseFloat(callArgs[2] as string)).toBeCloseTo(2.997, 2);
  });
});

// ══════════════════════════════════════════════════════════════
// 12. Edit Order
// ══════════════════════════════════════════════════════════════

describe("trade edit", () => {
  it("calls adapter.editOrder with uppercased symbol, orderId, price, size", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "btc", "order123", "65000", "0.2"]);

    expect(adapter.editOrder).toHaveBeenCalledTimes(1);
    expect(adapter.editOrder).toHaveBeenCalledWith("BTC", "order123", "65000", "0.2");
  });

  it("preserves orderId exactly as provided (case-sensitive)", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "eth", "MyOrder-ABC", "3000", "1"]);

    expect(adapter.editOrder).toHaveBeenCalledWith("ETH", "MyOrder-ABC", "3000", "1");
  });

  it("no other adapter methods are called", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "btc", "order123", "65000", "0.2"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 13. TP/SL side mapping verification (via stopOrder on generic adapter)
// ══════════════════════════════════════════════════════════════

describe("trade tpsl -- side mapping for generic (Lighter-style) adapter", () => {
  // Note: The tpsl command uses instanceof checks (PacificaAdapter, HyperliquidAdapter, LighterAdapter).
  // Our mock adapter won't match any instanceof check, so it will hit the `else` branch
  // and call errorAndExit. However, we CAN test the side mapping logic indirectly
  // through the close/reduce commands, which is already tested above.
  //
  // For completeness, we verify the side mapping expectation documented in the spec:
  // - BUY position (long): close side = "sell"
  // - SELL position (short): close side = "buy"

  it("LONG position close side is 'sell'", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "1.0", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "1.0");
  });

  it("SHORT position close side is 'buy'", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "short", size: "1.0", entryPrice: "60000", markPrice: "59000", liquidationPrice: "70000", unrealizedPnl: "1000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "1.0");
  });

  it("close-all maps sides correctly for mixed positions", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "0.5", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "500", leverage: 10 },
        { symbol: "ETH", side: "short", size: "5.0", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "500", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "sell", "0.5");
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "buy", "5.0");
  });

  it("reduce on LONG uses 'sell'", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "2", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "2000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "1");
  });

  it("reduce on SHORT uses 'buy'", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "short", size: "2", entryPrice: "60000", markPrice: "59000", liquidationPrice: "70000", unrealizedPnl: "2000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "1");
  });
});

// ══════════════════════════════════════════════════════════════
// 14. Symbol uppercasing -- cross-cutting concern
// ══════════════════════════════════════════════════════════════

describe("symbol uppercasing -- cross-cutting", () => {
  it("market order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "doge", "buy", "100"]);
    expect(vi.mocked(adapter.marketOrder).mock.calls[0][0]).toBe("DOGE");
  });

  it("limit order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "arb", "sell", "1.5", "50"]);
    expect(vi.mocked(adapter.limitOrder).mock.calls[0][0]).toBe("ARB");
  });

  it("stop order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "matic", "buy", "1.0", "100"]);
    expect(vi.mocked(adapter.stopOrder).mock.calls[0][0]).toBe("MATIC");
  });

  it("cancel order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "avax", "id1"]);
    expect(vi.mocked(adapter.cancelOrder).mock.calls[0][0]).toBe("AVAX");
  });

  it("edit order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "link", "o1", "20", "5"]);
    expect(vi.mocked(adapter.editOrder).mock.calls[0][0]).toBe("LINK");
  });

  it("leverage uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "near", "5"]);
    expect(vi.mocked(adapter.setLeverage).mock.calls[0][0]).toBe("NEAR");
  });

  it("close uppercases", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "APT", side: "long", size: "10", entryPrice: "10", markPrice: "11", liquidationPrice: "8", unrealizedPnl: "10", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "close", "apt"]);
    expect(vi.mocked(adapter.marketOrder).mock.calls[0][0]).toBe("APT");
  });

  it("reduce uppercases", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "OP", side: "short", size: "20", entryPrice: "2", markPrice: "1.9", liquidationPrice: "3", unrealizedPnl: "2", leverage: 3 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "op", "50"]);
    expect(vi.mocked(adapter.marketOrder).mock.calls[0][0]).toBe("OP");
  });
});

// ══════════════════════════════════════════════════════════════
// 15. No unexpected extra adapter calls
// ══════════════════════════════════════════════════════════════

describe("no unexpected extra adapter calls", () => {
  it("market order only calls marketOrder", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.stopOrder).not.toHaveBeenCalled();
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
    expect(adapter.editOrder).not.toHaveBeenCalled();
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.getPositions).not.toHaveBeenCalled();
  });

  it("limit order only calls limitOrder", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "60000", "0.1"]);

    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.stopOrder).not.toHaveBeenCalled();
  });

  it("stop order only calls stopOrder", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "btc", "sell", "0.1", "60000"]);

    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });

  it("leverage only calls setLeverage", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "btc", "10"]);

    expect(adapter.setLeverage).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("flatten calls cancelAllOrders + getPositions + marketOrder only", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "1", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "flatten"]);

    expect(adapter.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(adapter.getPositions).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.stopOrder).not.toHaveBeenCalled();
    expect(adapter.editOrder).not.toHaveBeenCalled();
  });
});
