/**
 * Tests for `perp funding positions` command.
 */
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

function createMockAdapter(
  name: string,
  positions: unknown[] = [],
  markets: unknown[] = [],
) {
  return {
    name,
    getPositions: vi.fn().mockResolvedValue(positions),
    getMarkets: vi.fn().mockResolvedValue(markets),
    getBalance: vi.fn().mockResolvedValue({ equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "0" }),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    marketOrder: vi.fn().mockResolvedValue({ orderId: "123" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "456" }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    cancelAllOrders: vi.fn().mockResolvedValue(undefined),
    getAccountTrades: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
  };
}

async function setupFunding(
  getAdapter: (exchange: string) => Promise<unknown>,
) {
  const { registerFundingCommands } = await import("../commands/funding.js");
  const program = new Command();
  program.exitOverride();
  registerFundingCommands(
    program,
    () => true, // isJson
    getAdapter as (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
  );
  return program;
}

/** Capture console.log output and parse JSON */
async function runAndCapture(program: Command, args: string[]) {
  const origLog = console.log;
  const chunks: string[] = [];
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(" ")); };
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = origLog;
  }
  return JSON.parse(chunks.join(""));
}

describe("funding positions", () => {
  it("shows funding impact for open positions", async () => {
    const adapter = createMockAdapter("hyperliquid", [
      {
        symbol: "ETH", side: "long", size: "0.5",
        entryPrice: "3500", markPrice: "3600",
        liquidationPrice: "3000", unrealizedPnl: "50", leverage: 5,
      },
    ], [
      {
        symbol: "ETH", markPrice: "3600", indexPrice: "3598",
        fundingRate: "0.0001", volume24h: "1000000",
        openInterest: "500000", maxLeverage: 50,
      },
    ]);

    const program = await setupFunding(vi.fn().mockResolvedValue(adapter));
    const json = await runAndCapture(program, ["funding", "positions", "--exchanges", "hyperliquid"]);

    expect(json.ok).toBe(true);
    expect(json.data.positions).toHaveLength(1);

    const pos = json.data.positions[0];
    expect(pos.exchange).toBe("hyperliquid");
    expect(pos.symbol).toBe("ETH");
    expect(pos.side).toBe("long");
    expect(pos.fundingRate).toBe(0.0001);
    expect(pos.notionalUsd).toBe(1800); // 0.5 * 3600
    expect(pos.hourlyPayment).toBeGreaterThan(0); // long pays positive funding
    expect(pos.dailyPayment).toBeGreaterThan(0);
  });

  it("returns totals aggregated across positions", async () => {
    const adapter = createMockAdapter("hyperliquid", [
      { symbol: "ETH", side: "long", size: "1", entryPrice: "3500", markPrice: "3600", liquidationPrice: "3000", unrealizedPnl: "100", leverage: 5 },
      { symbol: "BTC", side: "short", size: "0.01", entryPrice: "95000", markPrice: "94000", liquidationPrice: "100000", unrealizedPnl: "10", leverage: 10 },
    ], [
      { symbol: "ETH", markPrice: "3600", indexPrice: "3598", fundingRate: "0.0001", volume24h: "0", openInterest: "0", maxLeverage: 50 },
      { symbol: "BTC", markPrice: "94000", indexPrice: "93900", fundingRate: "0.0002", volume24h: "0", openInterest: "0", maxLeverage: 50 },
    ]);

    const program = await setupFunding(vi.fn().mockResolvedValue(adapter));
    const json = await runAndCapture(program, ["funding", "positions", "--exchanges", "hyperliquid"]);

    expect(json.ok).toBe(true);
    expect(json.data.positions).toHaveLength(2);
    expect(json.data.totals.notionalUsd).toBeGreaterThan(0);
    expect(json.data.totals.hourlyPayment).toBeDefined();
    expect(json.data.totals.dailyPayment).toBeDefined();
  });

  it("returns empty positions when no open positions", async () => {
    const adapter = createMockAdapter("hyperliquid", [], []);
    const program = await setupFunding(vi.fn().mockResolvedValue(adapter));
    const json = await runAndCapture(program, ["funding", "positions", "--exchanges", "hyperliquid"]);

    expect(json.ok).toBe(true);
    expect(json.data.positions).toHaveLength(0);
    expect(json.data.totals.hourlyPayment).toBe(0);
  });

  it("queries multiple exchanges when no --exchanges flag", async () => {
    const hlAdapter = createMockAdapter("hyperliquid", [
      { symbol: "ETH", side: "long", size: "0.5", entryPrice: "3500", markPrice: "3600", liquidationPrice: "3000", unrealizedPnl: "50", leverage: 5 },
    ], [
      { symbol: "ETH", markPrice: "3600", indexPrice: "3598", fundingRate: "0.0001", volume24h: "0", openInterest: "0", maxLeverage: 50 },
    ]);

    const pacAdapter = createMockAdapter("pacifica", [
      { symbol: "SOL", side: "short", size: "10", entryPrice: "180", markPrice: "175", liquidationPrice: "200", unrealizedPnl: "50", leverage: 3 },
    ], [
      { symbol: "SOL", markPrice: "175", indexPrice: "175", fundingRate: "-0.0002", volume24h: "0", openInterest: "0", maxLeverage: 20 },
    ]);

    const getAdapter = vi.fn().mockImplementation(async (ex: string) => {
      if (ex === "hyperliquid") return hlAdapter;
      if (ex === "pacifica") return pacAdapter;
      throw new Error("No key for " + ex);
    });

    const program = await setupFunding(getAdapter);
    const json = await runAndCapture(program, ["funding", "positions"]);

    expect(json.ok).toBe(true);
    expect(json.data.positions.length).toBeGreaterThanOrEqual(2);
    const exchanges = json.data.positions.map((p: { exchange: string }) => p.exchange);
    expect(exchanges).toContain("hyperliquid");
    expect(exchanges).toContain("pacifica");
  });

  it("reports exchange errors gracefully", async () => {
    const getAdapter = vi.fn().mockRejectedValue(new Error("No private key"));
    const program = await setupFunding(getAdapter);
    const json = await runAndCapture(program, ["funding", "positions", "--exchanges", "hyperliquid"]);

    expect(json.ok).toBe(true);
    expect(json.data.positions).toHaveLength(0);
    expect(json.data.errors.hyperliquid).toContain("No private key");
  });

  it("short position receives positive funding (you earn)", async () => {
    const adapter = createMockAdapter("pacifica", [
      { symbol: "ETH", side: "short", size: "1", entryPrice: "3500", markPrice: "3500", liquidationPrice: "5000", unrealizedPnl: "0", leverage: 5 },
    ], [
      { symbol: "ETH", markPrice: "3500", indexPrice: "3500", fundingRate: "0.0005", volume24h: "0", openInterest: "0", maxLeverage: 50 },
    ]);

    const program = await setupFunding(vi.fn().mockResolvedValue(adapter));
    const json = await runAndCapture(program, ["funding", "positions", "--exchanges", "pacifica"]);

    const pos = json.data.positions[0];
    // Short receives positive funding → hourlyPayment negative (you receive)
    expect(pos.hourlyPayment).toBeLessThan(0);
    expect(pos.dailyPayment).toBeLessThan(0);
  });

  it("long position with negative funding receives payment", async () => {
    const adapter = createMockAdapter("hyperliquid", [
      { symbol: "DOGE", side: "long", size: "1000", entryPrice: "0.15", markPrice: "0.16", liquidationPrice: "0.10", unrealizedPnl: "10", leverage: 3 },
    ], [
      { symbol: "DOGE", markPrice: "0.16", indexPrice: "0.16", fundingRate: "-0.0003", volume24h: "0", openInterest: "0", maxLeverage: 20 },
    ]);

    const program = await setupFunding(vi.fn().mockResolvedValue(adapter));
    const json = await runAndCapture(program, ["funding", "positions", "--exchanges", "hyperliquid"]);

    const pos = json.data.positions[0];
    // Long + negative funding → you receive
    expect(pos.hourlyPayment).toBeLessThan(0);
  });
});
