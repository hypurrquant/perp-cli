import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerMarketCommands } from "../../commands/market.js";
import { registerAccountCommands } from "../../commands/account.js";
import { registerTradeCommands } from "../../commands/trade.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

// ── Mock dependencies ──

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

// ── Mock adapter factory ──

function mockAdapter(overrides?: Record<string, unknown>) {
  return {
    name: "test-exchange",
    marketOrder: vi.fn().mockResolvedValue({ orderId: "m1" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "l1" }),
    stopOrder: vi.fn().mockResolvedValue({ orderId: "s1" }),
    cancelOrder: vi.fn().mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ cancelled: 3 }),
    editOrder: vi.fn().mockResolvedValue({ success: true }),
    setLeverage: vi.fn().mockResolvedValue({ leverage: 10 }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({
      equity: "10000",
      available: "8000",
      marginUsed: "2000",
      unrealizedPnl: "150",
    }),
    getMarkets: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({
      bids: [["42000.50", "1.5"], ["41999.00", "2.0"]],
      asks: [["42001.50", "1.2"], ["42002.00", "3.0"]],
    }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ExchangeAdapter;
}

// ── Helpers ──

function createMarketProgram(adapter: ExchangeAdapter, json = false) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMarketCommands(program, async () => adapter, () => json);
  return program;
}

function createAccountProgram(adapter: ExchangeAdapter, json = false) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAccountCommands(program, async () => adapter, () => json);
  return program;
}

function createTradeProgram(adapter: ExchangeAdapter, json = false) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTradeCommands(program, async () => adapter, () => json);
  return program;
}

async function run(program: Command, args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await program.parseAsync(["node", "perp", ...args]);
    return log.mock.calls;
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

function parseJsonOutput(calls: unknown[][]): unknown {
  // Find the call that contains JSON output
  for (const call of calls) {
    const str = String(call[0]);
    try {
      return JSON.parse(str);
    } catch {
      // not JSON, continue
    }
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════
// 1. market mid <symbol>
// ══════════════════════════════════════════════════════════════

describe("market mid", () => {
  it("calls getOrderbook with uppercased symbol", async () => {
    const adapter = mockAdapter();
    const program = createMarketProgram(adapter);
    await run(program, ["market", "mid", "btc"]);
    expect(adapter.getOrderbook).toHaveBeenCalledWith("BTC");
  });

  it("returns mid price in JSON mode", async () => {
    const adapter = mockAdapter();
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "eth"]);
    const output = parseJsonOutput(calls);
    expect(output).toMatchObject({
      ok: true,
      data: {
        symbol: "ETH",
        mid: expect.any(String),
        bid: "42000.50",
        ask: "42001.50",
        spread: expect.any(String),
      },
      meta: { timestamp: expect.any(String) },
    });
  });

  it("calculates correct mid from bid/ask", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["100.00", "1"]],
        asks: [["102.00", "1"]],
      }),
    });
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "SOL"]);
    const output = parseJsonOutput(calls) as { data: { mid: string; spread: string } };
    expect(output.data.mid).toBe("101");
    // spread = (102-100)/101 * 100 = 1.980198...%
    expect(parseFloat(output.data.spread)).toBeCloseTo(1.9802, 3);
  });

  it("handles empty orderbook gracefully in JSON mode", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    });
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; error?: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("SYMBOL_NOT_FOUND");
  });

  it("handles ask-only orderbook (no bids)", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [],
        asks: [["50000", "1"]],
      }),
    });
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { mid: string; bid: string | null } };
    expect(output.ok).toBe(true);
    expect(output.data.mid).toBe("50000");
    expect(output.data.bid).toBeNull();
  });

  it("handles bid-only orderbook (no asks)", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["49000", "1"]],
        asks: [],
      }),
    });
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { mid: string; ask: string | null } };
    expect(output.ok).toBe(true);
    expect(output.data.mid).toBe("49000");
    expect(output.data.ask).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// 2. account margin <symbol>
// ══════════════════════════════════════════════════════════════

describe("account margin", () => {
  const btcPosition = {
    symbol: "BTC",
    side: "long" as const,
    size: "0.5",
    entryPrice: "100000",
    markPrice: "101000",
    liquidationPrice: "90000",
    unrealizedPnl: "500",
    leverage: 10,
  };

  it("returns margin details for an existing position in JSON mode", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([btcPosition]),
    });
    const program = createAccountProgram(adapter, true);
    const calls = await run(program, ["account", "margin", "btc"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: Record<string, unknown> };

    expect(output.ok).toBe(true);
    expect(output.data.symbol).toBe("BTC");
    expect(output.data.side).toBe("long");
    expect(output.data.leverage).toBe(10);
    // notional = 0.5 * 101000 = 50500
    expect(output.data.notional).toBe("50500.00");
    // marginRequired = 50500 / 10 = 5050
    expect(output.data.marginRequired).toBe("5050.00");
    // marginPct = 5050 / 10000 * 100 = 50.5%
    expect(output.data.marginPctOfEquity).toBe("50.50");
    expect(output.data.accountEquity).toBe("10000");
  });

  it("calls both getPositions and getBalance in parallel", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([btcPosition]),
    });
    const program = createAccountProgram(adapter, true);
    await run(program, ["account", "margin", "BTC"]);
    expect(adapter.getPositions).toHaveBeenCalledTimes(1);
    expect(adapter.getBalance).toHaveBeenCalledTimes(1);
  });

  it("returns POSITION_NOT_FOUND for non-existent position in JSON mode", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const program = createAccountProgram(adapter, true);
    const calls = await run(program, ["account", "margin", "DOGE"]);
    const output = parseJsonOutput(calls) as { ok: boolean; error?: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("POSITION_NOT_FOUND");
  });

  it("matches symbol case-insensitively and with -PERP suffix", async () => {
    const ethPos = { ...btcPosition, symbol: "ETH-PERP" };
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([ethPos]),
    });
    const program = createAccountProgram(adapter, true);
    const calls = await run(program, ["account", "margin", "eth"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { symbol: string } };
    expect(output.ok).toBe(true);
    expect(output.data.symbol).toBe("ETH-PERP");
  });

  it("displays text output for non-JSON mode", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([btcPosition]),
    });
    const program = createAccountProgram(adapter, false);
    const calls = await run(program, ["account", "margin", "BTC"]);
    const allOutput = calls.map(c => String(c[0])).join("\n");
    expect(allOutput).toContain("BTC");
    expect(allOutput).toContain("Margin");
  });

  it("computes zero margin when leverage is 0", async () => {
    const zeroLev = { ...btcPosition, leverage: 0 };
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([zeroLev]),
    });
    const program = createAccountProgram(adapter, true);
    const calls = await run(program, ["account", "margin", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { marginRequired: string } };
    expect(output.ok).toBe(true);
    expect(output.data.marginRequired).toBe("0.00");
  });
});

// ══════════════════════════════════════════════════════════════
// 3. trade status <orderId>
// ══════════════════════════════════════════════════════════════

describe("trade status", () => {
  it("searches open orders and order history for the orderId", async () => {
    const openOrder = {
      orderId: "5555",
      symbol: "BTC",
      side: "buy" as const,
      price: "99000",
      size: "0.1",
      filled: "0",
      status: "open",
      type: "limit",
    };
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue([openOrder]),
      getOrderHistory: vi.fn().mockResolvedValue([]),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "status", "5555"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { orderId: string; status: string } };
    expect(output.ok).toBe(true);
    expect(output.data.orderId).toBe("5555");
    expect(output.data.status).toBe("open");
  });

  it("finds order in history if not in open orders", async () => {
    const filledOrder = {
      orderId: "7777",
      symbol: "ETH",
      side: "sell" as const,
      price: "3500",
      size: "1.0",
      filled: "1.0",
      status: "filled",
      type: "market",
    };
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOrderHistory: vi.fn().mockResolvedValue([filledOrder]),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "status", "7777"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { orderId: string; status: string } };
    expect(output.ok).toBe(true);
    expect(output.data.orderId).toBe("7777");
    expect(output.data.status).toBe("filled");
  });

  it("returns ORDER_NOT_FOUND when order doesn't exist", async () => {
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOrderHistory: vi.fn().mockResolvedValue([]),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "status", "9999"]);
    const output = parseJsonOutput(calls) as { ok: boolean; error?: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("ORDER_NOT_FOUND");
  });

  it("displays text output for non-JSON mode when found", async () => {
    const order = {
      orderId: "1234",
      symbol: "SOL",
      side: "buy" as const,
      price: "150",
      size: "10",
      filled: "5",
      status: "open",
      type: "limit",
    };
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue([order]),
    });
    const program = createTradeProgram(adapter, false);
    const calls = await run(program, ["trade", "status", "1234"]);
    const allOutput = calls.map(c => String(c[0])).join("\n");
    expect(allOutput).toContain("SOL");
    expect(allOutput).toContain("1234");
  });
});

// ══════════════════════════════════════════════════════════════
// 4. trade fills [symbol]
// ══════════════════════════════════════════════════════════════

describe("trade fills", () => {
  const sampleTrades = [
    { time: 1700000000000, symbol: "BTC", side: "buy" as const, price: "42000", size: "0.1", fee: "4.20" },
    { time: 1700000001000, symbol: "ETH", side: "sell" as const, price: "3500", size: "1.0", fee: "3.50" },
    { time: 1700000002000, symbol: "BTC", side: "sell" as const, price: "42100", size: "0.05", fee: "2.10" },
  ];

  it("returns all fills when no symbol filter", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue(sampleTrades),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "fills"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: unknown[] };
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(3);
  });

  it("filters by symbol when provided", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue(sampleTrades),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "fills", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { symbol: string }[] };
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(2);
    expect(output.data.every(t => t.symbol === "BTC")).toBe(true);
  });

  it("symbol filter is case-insensitive", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue(sampleTrades),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "fills", "eth"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: { symbol: string }[] };
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(1);
    expect(output.data[0].symbol).toBe("ETH");
  });

  it("returns empty array when symbol has no fills", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue(sampleTrades),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "fills", "DOGE"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: unknown[] };
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(0);
  });

  it("respects --limit option", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue(sampleTrades),
    });
    const program = createTradeProgram(adapter, true);
    await run(program, ["trade", "fills", "--limit", "10"]);
    expect(adapter.getTradeHistory).toHaveBeenCalledWith(10);
  });

  it("passes default limit of 30 to getTradeHistory", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue([]),
    });
    const program = createTradeProgram(adapter, true);
    await run(program, ["trade", "fills"]);
    expect(adapter.getTradeHistory).toHaveBeenCalledWith(30);
  });

  it("matches -PERP suffix variants", async () => {
    const perpTrades = [
      { time: 1700000000000, symbol: "SOL-PERP", side: "buy" as const, price: "150", size: "10", fee: "1.50" },
    ];
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue(perpTrades),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "fills", "SOL"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: unknown[] };
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Error handling edge cases (cross-cutting)
// ══════════════════════════════════════════════════════════════

describe("error handling edge cases", () => {
  it("market mid handles adapter error gracefully (text mode)", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockRejectedValue(new Error("Connection refused")),
    });
    const program = createMarketProgram(adapter, false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "perp", "market", "mid", "BTC"]);
      const errOutput = err.mock.calls.map(c => String(c[0])).join("\n");
      expect(errOutput).toContain("Connection refused");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("market mid returns JSON error envelope on adapter failure", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockRejectedValue(new Error("Timeout")),
    });
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; error?: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBeDefined();
  });

  it("account margin handles adapter error gracefully", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockRejectedValue(new Error("Timeout")),
    });
    const program = createAccountProgram(adapter, true);
    const calls = await run(program, ["account", "margin", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; error?: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBeDefined();
  });

  it("trade fills handles empty trade history", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue([]),
    });
    const program = createTradeProgram(adapter, true);
    const calls = await run(program, ["trade", "fills"]);
    const output = parseJsonOutput(calls) as { ok: boolean; data: unknown[] };
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(0);
  });

  it("JSON envelope always has meta.timestamp", async () => {
    const adapter = mockAdapter();
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "BTC"]);
    const output = parseJsonOutput(calls) as { meta?: { timestamp: string } };
    expect(output.meta?.timestamp).toBeDefined();
    // Should be valid ISO 8601
    expect(new Date(output.meta!.timestamp).toISOString()).toBe(output.meta!.timestamp);
  });

  it("JSON error envelope has meta.timestamp", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    });
    const program = createMarketProgram(adapter, true);
    const calls = await run(program, ["market", "mid", "BTC"]);
    const output = parseJsonOutput(calls) as { ok: boolean; meta?: { timestamp: string } };
    expect(output.ok).toBe(false);
    expect(output.meta?.timestamp).toBeDefined();
  });
});
