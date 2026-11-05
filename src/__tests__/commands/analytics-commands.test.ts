import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerHistoryCommands } from "../../commands/history.js";
import { addRootSafetyOptions } from "../../cli-flags.js";
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

// Default exchange list = venues with configured credentials. HOME is isolated in
// tests (helpers/isolate-home.ts), so pin the configured set explicitly.
vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  listConfiguredAccountVenues: vi.fn(async () => ["pacifica", "hyperliquid", "lighter"]),
}));

// ── Mock adapter ──

const now = Date.now();
const day = 86400000;

function mockAdapter(exchange: string): ExchangeAdapter {
  return {
    name: exchange,
    historyReach: { funding: "all", trades: "all" },
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
  // Root -n / --dry-run (history reads the per-network arb state via networkOf).
  addRootSafetyOptions(program);
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

describe("analytics report — failed venue reads are reported, never counted as 0", () => {
  function programWith(getAdapter: (ex: string) => Promise<ExchangeAdapter>) {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, getAdapter);
  }

  it("all venues answer → partial false, errors empty", async () => {
    const res = await run(["analytics", "report"]);
    expect(res.data).toMatchObject({ partial: false, errors: {}, venuesRead: 3, venuesRequested: 3 });
  });

  it("adapter / trades / funding failures are keyed per venue; totals cover only the venues that answered", async () => {
    programWith(async (ex) => {
      if (ex === "lighter") throw new Error("no credentials");
      const a = mockAdapter(ex);
      if (ex === "pacifica") (a.getTradeHistory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 500"));
      return a;
    });
    const res = await run(["analytics", "report"]);
    expect(res.ok).toBe(true);
    expect(res.data.partial).toBe(true);
    expect(res.data.venuesRead).toBe(2);
    expect(res.data.errors).toEqual({ "lighter.adapter": "no credentials", "pacifica.trades": "HTTP 500" });
    expect(res.data.portfolio.totalEquity).toBe(20000);
    expect(res.data.costs.totalFees).toBeCloseTo(2.63, 6); // hyperliquid only
  });
});

describe("analytics pnl — failed venue reads are reported, never counted as 0", () => {
  it("adapter / funding failures land in errors with partial true; totals cover the rest", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => {
      if (ex === "lighter") throw new Error("no credentials");
      const a = mockAdapter(ex);
      if (ex === "pacifica") (a.getFundingPayments as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 503"));
      return a;
    });
    const res = await run(["analytics", "pnl"]);
    expect(res.ok).toBe(true);
    expect(res.data.partial).toBe(true);
    expect(res.data.errors).toEqual({ "lighter.adapter": "no credentials", "pacifica.funding": "HTTP 503" });
    expect(res.data.totalFunding).toBeCloseTo(15.5, 6); // hyperliquid only (5.20 + 4.80 + 5.50)
    expect(res.data.totalTrades).toBe(4);               // hyperliquid + pacifica trades
  });

  it("all venues answer → partial false", async () => {
    const res = await run(["analytics", "pnl"]);
    expect(res.data).toMatchObject({ partial: false, errors: {} });
  });

  it("--period with a history not proven to cover it: summed, listed in incomplete", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => ({ ...mockAdapter(ex), historyReach: undefined }));
    const res = await run(["analytics", "pnl", "--period", "30"]);
    const back = (t: number) => `read back to ${new Date(t).toISOString()} only`;
    expect(res.data.incomplete["hyperliquid.funding"]).toBe(`funding ${back(now - 2 * day)}`);
    expect(res.data.incomplete["hyperliquid.trades"]).toBe(`trades ${back(now - 2 * day)}`);
  });
});

describe("analytics funding — failed venue reads are reported, never counted as 0", () => {
  it("adapter / funding / positions failures are keyed per venue; totals cover the rest; partial true", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => {
      if (ex === "lighter") throw new Error("no credentials");
      const a = mockAdapter(ex);
      if (ex === "pacifica") (a.getFundingPayments as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 503"));
      if (ex === "hyperliquid") (a.getPositions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"));
      return a;
    });
    const res = await run(["analytics", "funding"]);
    expect(res.ok).toBe(true);
    expect(res.data.partial).toBe(true);
    expect(res.data.errors).toEqual({
      "lighter.adapter": "no credentials",
      "pacifica.funding": "HTTP 503",
      "hyperliquid.positions": "timeout",
    });
    expect(res.data.totalFunding).toBeCloseTo(15.5, 6); // hyperliquid only
    // ETH arb is hyperliquid → lighter: the lighter leg is unknown → netFunding null, not hl-only.
    const eth = res.data.arbPositions.find((a: { symbol: string }) => a.symbol === "ETH");
    expect(eth).toMatchObject({ longFunding: 15.5, shortFunding: null, netFunding: null });
  });

  it("all venues answer → partial false, errors empty", async () => {
    const res = await run(["analytics", "funding"]);
    expect(res.data).toMatchObject({ partial: false, errors: {} });
  });

  it("pnl: an incomplete history alone leaves partial false (partial = a venue read failed)", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => ({ ...mockAdapter(ex), historyReach: undefined }));
    const res = await run(["analytics", "pnl", "--period", "30"]);
    expect(Object.keys(res.data.incomplete).length).toBeGreaterThan(0);
    expect(res.data.partial).toBe(false);
  });

  it("funding: an incomplete history alone leaves partial false (partial = a venue read failed)", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => ({ ...mockAdapter(ex), historyReach: undefined }));
    const res = await run(["analytics", "funding", "--period", "30"]);
    expect(Object.keys(res.data.incomplete).length).toBeGreaterThan(0);
    expect(res.data.partial).toBe(false);
  });

  it("--limit help says it applies only to venues without a period read", () => {
    const analytics = program.commands.find(c => c.name() === "analytics")!;
    for (const sub of ["pnl", "funding"]) {
      const limit = analytics.commands.find(c => c.name() === sub)!.options.find(o => o.long === "--limit")!;
      expect(limit.description).toMatch(/on venues without a period read/);
    }
  });

  it("--period with a funding history not proven to cover it: summed, listed in incomplete", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => ({ ...mockAdapter(ex), historyReach: undefined }));
    const res = await run(["analytics", "funding", "--period", "30"]);
    expect(res.data.incomplete["hyperliquid.funding"]).toBe(`funding read back to ${new Date(now - 2 * day).toISOString()} only`);
  });

  it("a venue's windowed read past its budget: rows beyond --limit still count, listed in incomplete with how far back", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    const from = now - 3 * day;
    const rows = Array.from({ length: 300 }, (_, i) => ({ time: now - i * 1000, symbol: "ETH", payment: "1" }));
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => ({ ...mockAdapter(ex), getFundingPaymentsSince: vi.fn().mockResolvedValue({ rows, from }) }));
    const res = await run(["--json", "analytics", "funding", "--period", "30", "--limit", "200"].slice(1));
    expect(res.data.totalFunding).toBe(300 * 3);
    expect(res.data.incomplete["hyperliquid.funding"]).toBe(`funding read back to ${new Date(from).toISOString()} only`);
  });
});

describe("analytics compare — a failed venue's funding / price is null, never 0 / the entry price", () => {
  it("rows touching a failed venue report null; totals skip them and flag partial", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => {
      const a = mockAdapter(ex);
      // BTC live positions on lighter + pacifica so the BTC row is fully priced.
      (a.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue([
        { symbol: "ETH", side: "long", size: "1.0", entryPrice: "3500", markPrice: "3520", liquidationPrice: null, unrealizedPnl: "20", leverage: 2 },
        { symbol: "BTC", side: "long", size: "0.1", entryPrice: "95000", markPrice: "96000", liquidationPrice: null, unrealizedPnl: "100", leverage: 2 },
      ]);
      // hyperliquid (ETH long leg) funding fails; lighter's positions read is fine.
      if (ex === "hyperliquid") (a.getFundingPayments as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 500"));
      return a;
    });
    const res = await run(["analytics", "compare"]);
    expect(res.ok).toBe(true);
    expect(res.data.partial).toBe(true);
    expect(res.data.errors).toEqual({ "hyperliquid.funding": "HTTP 500" });
    const eth = res.data.positions.find((p: { symbol: string }) => p.symbol === "ETH");
    expect(eth.funding).toBeNull();
    expect(eth.totalPnl).toBeNull();
    expect(eth.roi).toBeNull();
    expect(eth.pricePnl).toBeCloseTo(20 - 10, 6); // prices were read: (3520-3500)*1 + (3510-3520)*1
    const btc = res.data.positions.find((p: { symbol: string }) => p.symbol === "BTC");
    expect(btc.funding).toBe(0); // venues answered, no BTC payments
    expect(btc.pricePnl).toBeCloseTo((96000 - 95000) * 0.1 + (95100 - 96000) * 0.1, 6);
    // Totals: funding / totalPnl cover BTC only (ETH unknown is skipped, not counted as 0 + entry price).
    expect(res.data.totals.totalPnl).toBeCloseTo(btc.totalPnl, 6);
    expect(res.data.totals.notional).toBeCloseTo(95000 * 0.1 + 95100 * 0.1, 6);
  });

  it("a whole venue failing (adapter) → its legs' price PnL null, not priced at the entry", async () => {
    program = new Command();
    addRootSafetyOptions(program);
    program.option("--json", "JSON output");
    registerHistoryCommands(program, () => program.opts().json ?? false, async (ex) => {
      if (ex === "lighter") throw new Error("no credentials");
      return mockAdapter(ex);
    });
    const res = await run(["analytics", "compare"]);
    expect(res.data.errors).toEqual({ "lighter.adapter": "no credentials" });
    for (const p of res.data.positions) {
      expect(p.funding).toBeNull();
      expect(p.pricePnl).toBeNull();
      expect(p.totalPnl).toBeNull();
    }
    expect(res.data.partial).toBe(true);
    expect(res.data.totals.totalPnl).toBe(0);
    expect(res.data.totals.notional).toBe(0);
  });
});
