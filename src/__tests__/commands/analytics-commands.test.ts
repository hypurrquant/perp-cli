import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerHistoryCommands } from "../../commands/history.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

// ── Mocks ──

vi.mock("../../execution-log.js", () => ({
  readExecutionLog: vi.fn(() => []),
  getExecutionStats: vi.fn(() => ({
    totalTrades: 0,
    successRate: 0,
    byExchange: {},
    byType: {},
    recentErrors: [],
  })),
  pruneExecutionLog: vi.fn(() => 0),
}));

vi.mock("../../position-history.js", () => ({
  readPositionHistory: vi.fn(() => []),
  getPositionStats: vi.fn(() => ({ total: 0, byStatus: {} })),
}));

vi.mock("../../equity-tracker.js", () => ({
  saveEquitySnapshot: vi.fn(),
  readEquityHistory: vi.fn(() => []),
  computePnlMetrics: vi.fn(() => ({})),
  computeDailyPnl: vi.fn(() => []),
  aggregateWeekly: vi.fn(() => []),
}));

vi.mock("../../arb/state.js", () => ({
  loadArbState: vi.fn(() => ({
    version: 1,
    positions: [
      {
        id: "arb-1",
        symbol: "ETH",
        longExchange: "hyperliquid",
        shortExchange: "lighter",
        longSize: 1.0,
        shortSize: 1.0,
        entryTime: new Date(Date.now() - 14 * 86400000).toISOString(),
        entrySpread: 15.2,
        entryLongPrice: 3500,
        entryShortPrice: 3510,
        accumulatedFunding: 42.5,
        lastCheckTime: new Date().toISOString(),
        mode: "perp-perp",
      },
      {
        id: "arb-2",
        symbol: "BTC",
        longExchange: "lighter",
        shortExchange: "pacifica",
        longSize: 0.1,
        shortSize: 0.1,
        entryTime: new Date(Date.now() - 7 * 86400000).toISOString(),
        entrySpread: 22.0,
        entryLongPrice: 95000,
        entryShortPrice: 95100,
        accumulatedFunding: 18.0,
        lastCheckTime: new Date().toISOString(),
        mode: "perp-perp",
      },
    ],
    lastStartTime: new Date().toISOString(),
    lastScanTime: new Date().toISOString(),
    lastSuccessfulScanTime: new Date().toISOString(),
    config: { minSpread: 5, closeSpread: 2, size: 100, holdDays: 30, bridgeCost: 0, maxPositions: 5, settleStrategy: "manual" },
  })),
}));

// ── Mock adapter ──

const now = Date.now();
const day = 86400000;

function mockAdapter(exchange: string): ExchangeAdapter {
  return {
    name: exchange,
    getMarkets: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ equity: "10000", available: "8000", marginUsed: "2000", unrealizedPnl: "100" }),
    getPositions: vi.fn().mockResolvedValue([
      { symbol: "ETH", side: "long", size: "1.0", entryPrice: "3500", markPrice: "3520", liquidationPrice: "3000", unrealizedPnl: "20", leverage: 2 },
    ]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([
      { time: now - 2 * day, symbol: "ETH", side: "buy", price: "3500", size: "1.0", fee: "1.75" },
      { time: now - 1 * day, symbol: "ETH", side: "sell", price: "3520", size: "0.5", fee: "0.88" },
    ]),
    getFundingPayments: vi.fn().mockResolvedValue([
      { time: now - 2 * day, symbol: "ETH", payment: "5.20" },
      { time: now - 1 * day, symbol: "ETH", payment: "4.80" },
      { time: now, symbol: "ETH", payment: "5.50" },
    ]),
    marketOrder: vi.fn(),
    limitOrder: vi.fn(),
    editOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    setLeverage: vi.fn(),
    stopOrder: vi.fn(),
  } as ExchangeAdapter;
}

// ── Test helpers ──

let output: string;
let program: Command;

function captureOutput() {
  output = "";
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    output += args.map(String).join(" ") + "\n";
  };
  return () => { console.log = origLog; };
}

async function run(args: string[]) {
  const restore = captureOutput();
  try {
    await program.parseAsync(["node", "perp", "--json", ...args]);
  } finally {
    restore();
  }
  return JSON.parse(output.trim());
}

beforeEach(() => {
  output = "";
  program = new Command();
  program.option("--json", "JSON output");
  const isJson = () => program.opts().json ?? false;
  const getAdapter = async (ex: string) => mockAdapter(ex);
  registerHistoryCommands(program, isJson, getAdapter);
});

// ── Tests ──

describe("analytics funding", () => {
  it("returns funding aggregated by exchange×symbol with --json", async () => {
    const res = await run(["analytics", "funding"]);
    expect(res.ok).toBe(true);
    expect(res.data.totalPayments).toBeGreaterThan(0);
    expect(res.data.totalFunding).toBeGreaterThan(0);
    expect(res.data.byExchangeSymbol).toBeInstanceOf(Array);
    expect(res.data.byExchangeSymbol.length).toBeGreaterThan(0);
    expect(res.data.byExchangeSymbol[0]).toHaveProperty("exchange");
    expect(res.data.byExchangeSymbol[0]).toHaveProperty("symbol");
    expect(res.data.byExchangeSymbol[0]).toHaveProperty("total");
    expect(res.data.byExchangeSymbol[0]).toHaveProperty("annualizedRate");
  });

  it("includes arb position breakdown", async () => {
    const res = await run(["analytics", "funding"]);
    expect(res.data.arbPositions).toBeInstanceOf(Array);
    // ETH arb position should have funding matched
    const ethArb = res.data.arbPositions.find((a: any) => a.symbol === "ETH");
    if (ethArb) {
      expect(ethArb.longExchange).toBe("hyperliquid");
      expect(ethArb.shortExchange).toBe("lighter");
      expect(ethArb).toHaveProperty("netFunding");
      expect(ethArb).toHaveProperty("daysSinceEntry");
    }
  });

  it("respects --period filter", async () => {
    const res = await run(["analytics", "funding", "--period", "30d"]);
    expect(res.ok).toBe(true);
    expect(res.data.period).toBe("30d");
    expect(res.data.periodDays).toBe(30);
  });

  it("includes daily breakdown with --daily", async () => {
    const res = await run(["analytics", "funding", "--daily"]);
    expect(res.ok).toBe(true);
    expect(res.data.daily).toBeInstanceOf(Array);
    expect(res.data.daily.length).toBeGreaterThan(0);
    expect(res.data.daily[0]).toHaveProperty("date");
    expect(res.data.daily[0]).toHaveProperty("amount");
  });

  it("omits daily when --daily not specified", async () => {
    const res = await run(["analytics", "funding"]);
    expect(res.data.daily).toBeUndefined();
  });
});

describe("analytics pnl", () => {
  it("returns combined fees + funding PnL with --json", async () => {
    const res = await run(["analytics", "pnl"]);
    expect(res.ok).toBe(true);
    expect(res.data).toHaveProperty("totalTrades");
    expect(res.data).toHaveProperty("totalVolume");
    expect(res.data).toHaveProperty("totalFees");
    expect(res.data).toHaveProperty("totalFunding");
    expect(res.data).toHaveProperty("netPnl");
    // Net PnL = funding - fees
    expect(res.data.netPnl).toBeCloseTo(res.data.totalFunding - res.data.totalFees, 2);
  });

  it("includes per-exchange breakdown", async () => {
    const res = await run(["analytics", "pnl"]);
    expect(res.data.byExchange).toBeDefined();
    const exchanges = Object.keys(res.data.byExchange);
    expect(exchanges.length).toBeGreaterThan(0);
    const first = res.data.byExchange[exchanges[0]];
    expect(first).toHaveProperty("trades");
    expect(first).toHaveProperty("volume");
    expect(first).toHaveProperty("fees");
    expect(first).toHaveProperty("funding");
    expect(first).toHaveProperty("netPnl");
  });

  it("includes daily PnL rows", async () => {
    const res = await run(["analytics", "pnl"]);
    expect(res.data.daily).toBeInstanceOf(Array);
    expect(res.data.daily.length).toBeGreaterThan(0);
    expect(res.data.daily[0]).toHaveProperty("date");
    expect(res.data.daily[0]).toHaveProperty("fees");
    expect(res.data.daily[0]).toHaveProperty("funding");
    expect(res.data.daily[0]).toHaveProperty("net");
  });

  it("respects --period filter", async () => {
    const res = await run(["analytics", "pnl", "--period", "7d"]);
    expect(res.ok).toBe(true);
    expect(res.data.period).toBe("7d");
  });
});

describe("analytics compare", () => {
  it("returns arb position comparison with --json", async () => {
    const res = await run(["analytics", "compare"]);
    expect(res.ok).toBe(true);
    expect(res.data.positionCount).toBe(2);
    expect(res.data.positions).toBeInstanceOf(Array);
    expect(res.data.positions.length).toBe(2);
  });

  it("includes ROI and funding metrics per position", async () => {
    const res = await run(["analytics", "compare"]);
    const pos = res.data.positions[0];
    expect(pos).toHaveProperty("symbol");
    expect(pos).toHaveProperty("longExchange");
    expect(pos).toHaveProperty("shortExchange");
    expect(pos).toHaveProperty("daysHeld");
    expect(pos).toHaveProperty("funding");
    expect(pos).toHaveProperty("pricePnl");
    expect(pos).toHaveProperty("totalPnl");
    expect(pos).toHaveProperty("roi");
    expect(pos).toHaveProperty("annualizedRoi");
  });

  it("includes totals", async () => {
    const res = await run(["analytics", "compare"]);
    expect(res.data.totals).toHaveProperty("funding");
    expect(res.data.totals).toHaveProperty("pricePnl");
    expect(res.data.totals).toHaveProperty("totalPnl");
    expect(res.data.totals).toHaveProperty("roi");
  });

  it("handles empty arb state gracefully", async () => {
    const { loadArbState } = await import("../../arb/state.js");
    vi.mocked(loadArbState).mockReturnValueOnce(null);
    const res = await run(["analytics", "compare"]);
    expect(res.ok).toBe(true);
    expect(res.data.positions).toEqual([]);
  });
});
