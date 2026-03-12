import { describe, it, expect, vi } from "vitest";
import {
  checkChainMargins,
  isCriticalMargin,
  shouldBlockEntries,
  computeAutoSize,
  type ChainMarginStatus,
} from "../cross-chain-margin.js";
import type { ExchangeAdapter, ExchangeBalance } from "../exchanges/interface.js";

// ── Mock adapter factory ──

function mockAdapter(opts: {
  name: string;
  equity: number;
  marginUsed: number;
  available?: number;
  asks?: [string, string][];
  bids?: [string, string][];
}): ExchangeAdapter {
  const bal: ExchangeBalance = {
    equity: String(opts.equity),
    available: String(opts.available ?? opts.equity - opts.marginUsed),
    marginUsed: String(opts.marginUsed),
    unrealizedPnl: "0",
  };

  return {
    name: opts.name,
    getBalance: vi.fn().mockResolvedValue(bal),
    getOrderbook: vi.fn().mockResolvedValue({
      asks: opts.asks ?? [["100", "10"], ["101", "5"], ["102", "3"]],
      bids: opts.bids ?? [["99", "8"], ["98", "6"], ["97", "4"]],
    }),
    getMarkets: vi.fn(),
    getRecentTrades: vi.fn(),
    getFundingHistory: vi.fn(),
    getKlines: vi.fn(),
    getPositions: vi.fn(),
    getOpenOrders: vi.fn(),
    getOrderHistory: vi.fn(),
    getTradeHistory: vi.fn(),
    getFundingPayments: vi.fn(),
    marketOrder: vi.fn(),
    limitOrder: vi.fn(),
    editOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    setLeverage: vi.fn(),
    stopOrder: vi.fn(),
  } as unknown as ExchangeAdapter;
}

// ── checkChainMargins ──

describe("checkChainMargins", () => {
  it("returns correct margin status for healthy exchange", async () => {
    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set("hyperliquid", mockAdapter({ name: "hyperliquid", equity: 1000, marginUsed: 200 }));

    const statuses = await checkChainMargins(adapters, 30);

    expect(statuses).toHaveLength(1);
    expect(statuses[0].exchange).toBe("hyperliquid");
    expect(statuses[0].chain).toBe("hyperliquid");
    expect(statuses[0].equity).toBe(1000);
    expect(statuses[0].usedMargin).toBe(200);
    expect(statuses[0].freeMargin).toBe(800);
    // marginRatio = (800/1000)*100 = 80%
    expect(statuses[0].marginRatio).toBe(80);
    expect(statuses[0].belowThreshold).toBe(false);
  });

  it("detects low margin below threshold", async () => {
    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set("lighter", mockAdapter({ name: "lighter", equity: 1000, marginUsed: 800 }));

    const statuses = await checkChainMargins(adapters, 30);

    expect(statuses).toHaveLength(1);
    // marginRatio = (200/1000)*100 = 20% < 30%
    expect(statuses[0].marginRatio).toBe(20);
    expect(statuses[0].belowThreshold).toBe(true);
  });

  it("handles multiple exchanges", async () => {
    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set("hyperliquid", mockAdapter({ name: "hyperliquid", equity: 1000, marginUsed: 100 }));
    adapters.set("pacifica", mockAdapter({ name: "pacifica", equity: 500, marginUsed: 400 }));
    adapters.set("lighter", mockAdapter({ name: "lighter", equity: 2000, marginUsed: 500 }));

    const statuses = await checkChainMargins(adapters, 30);

    expect(statuses).toHaveLength(3);

    const hl = statuses.find(s => s.exchange === "hyperliquid")!;
    expect(hl.marginRatio).toBe(90); // (900/1000)*100
    expect(hl.belowThreshold).toBe(false);
    expect(hl.chain).toBe("hyperliquid");

    const pac = statuses.find(s => s.exchange === "pacifica")!;
    expect(pac.marginRatio).toBe(20); // (100/500)*100
    expect(pac.belowThreshold).toBe(true);
    expect(pac.chain).toBe("solana");

    const lt = statuses.find(s => s.exchange === "lighter")!;
    expect(lt.marginRatio).toBe(75); // (1500/2000)*100
    expect(lt.belowThreshold).toBe(false);
    expect(lt.chain).toBe("arbitrum");
  });

  it("handles zero equity", async () => {
    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set("hyperliquid", mockAdapter({ name: "hyperliquid", equity: 0, marginUsed: 0 }));

    const statuses = await checkChainMargins(adapters, 30);

    expect(statuses[0].marginRatio).toBe(0);
    expect(statuses[0].belowThreshold).toBe(true);
  });
});

// ── isCriticalMargin ──

describe("isCriticalMargin", () => {
  it("returns true when margin ratio below 15%", () => {
    const status: ChainMarginStatus = {
      exchange: "test",
      chain: "arbitrum",
      equity: 1000,
      usedMargin: 900,
      freeMargin: 100,
      marginRatio: 10,
      belowThreshold: true,
    };
    expect(isCriticalMargin(status)).toBe(true);
  });

  it("returns false when margin ratio above 15%", () => {
    const status: ChainMarginStatus = {
      exchange: "test",
      chain: "arbitrum",
      equity: 1000,
      usedMargin: 700,
      freeMargin: 300,
      marginRatio: 30,
      belowThreshold: false,
    };
    expect(isCriticalMargin(status)).toBe(false);
  });

  it("returns false at exactly 15%", () => {
    const status: ChainMarginStatus = {
      exchange: "test",
      chain: "arbitrum",
      equity: 1000,
      usedMargin: 850,
      freeMargin: 150,
      marginRatio: 15,
      belowThreshold: true,
    };
    expect(isCriticalMargin(status)).toBe(false);
  });
});

// ── shouldBlockEntries ──

describe("shouldBlockEntries", () => {
  it("blocks when below threshold", () => {
    const status: ChainMarginStatus = {
      exchange: "test",
      chain: "solana",
      equity: 1000,
      usedMargin: 800,
      freeMargin: 200,
      marginRatio: 20,
      belowThreshold: true,
    };
    expect(shouldBlockEntries(status, 30)).toBe(true);
  });

  it("allows when above threshold", () => {
    const status: ChainMarginStatus = {
      exchange: "test",
      chain: "solana",
      equity: 1000,
      usedMargin: 500,
      freeMargin: 500,
      marginRatio: 50,
      belowThreshold: false,
    };
    expect(shouldBlockEntries(status, 30)).toBe(false);
  });
});

// ── computeAutoSize ──

describe("computeAutoSize", () => {
  it("picks the smaller side from orderbook depth", async () => {
    // Long side (asks): 3 levels -> $100*10 + $101*5 + $102*3 = $1000+$505+$306 = $1811
    // Short side (bids): 3 levels -> $99*8 + $98*6 + $97*4 = $792+$588+$388 = $1768
    // Min is $1768 (short side)
    const longAdapter = mockAdapter({
      name: "hyperliquid",
      equity: 10000,
      marginUsed: 0,
      asks: [["100", "10"], ["101", "5"], ["102", "3"]],
    });
    const shortAdapter = mockAdapter({
      name: "pacifica",
      equity: 10000,
      marginUsed: 0,
      bids: [["99", "8"], ["98", "6"], ["97", "4"]],
    });

    const size = await computeAutoSize(longAdapter, shortAdapter, "BTC", 5.0);

    // Should be capped by risk maxPositionUsd (5000 default) or the orderbook depth
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(5000); // risk limit
  });

  it("respects 50% free margin cap", async () => {
    // Both sides have huge depth but small free margin
    const longAdapter = mockAdapter({
      name: "hyperliquid",
      equity: 200,
      marginUsed: 100,
      asks: [["100", "100"]], // $10000 depth
    });
    const shortAdapter = mockAdapter({
      name: "pacifica",
      equity: 300,
      marginUsed: 100,
      bids: [["99", "100"]], // $9900 depth
    });

    const size = await computeAutoSize(longAdapter, shortAdapter, "BTC", 5.0);

    // Free margin: long=100, short=200 -> min=100 -> 50% = 50
    expect(size).toBeLessThanOrEqual(50);
    expect(size).toBeGreaterThan(0);
  });

  it("returns 0 when orderbook is empty", async () => {
    const longAdapter = mockAdapter({
      name: "hyperliquid",
      equity: 10000,
      marginUsed: 0,
      asks: [],
    });
    const shortAdapter = mockAdapter({
      name: "pacifica",
      equity: 10000,
      marginUsed: 0,
      bids: [["99", "10"]],
    });

    const size = await computeAutoSize(longAdapter, shortAdapter, "BTC", 0.3);
    expect(size).toBe(0);
  });

  it("caps at maxPositionUsd from risk config", async () => {
    // Huge depth and margin, should be capped by risk limits
    const longAdapter = mockAdapter({
      name: "hyperliquid",
      equity: 1_000_000,
      marginUsed: 0,
      asks: [["100", "10000"]], // $1M depth
    });
    const shortAdapter = mockAdapter({
      name: "pacifica",
      equity: 1_000_000,
      marginUsed: 0,
      bids: [["99", "10000"]], // $990K depth
    });

    const size = await computeAutoSize(longAdapter, shortAdapter, "BTC", 5.0);
    // Default maxPositionUsd is 100000
    expect(size).toBeLessThanOrEqual(100000);
  });
});

// ── Rebalance computation ──

describe("Rebalance computation", () => {
  it("computes correct transfers for 50:50 target", async () => {
    // Import the compute function
    const { computeRebalancePlan } = await import("../rebalance.js");

    const snapshots = [
      { exchange: "lighter", equity: 800, available: 700, marginUsed: 100, unrealizedPnl: 0 },
      { exchange: "pacifica", equity: 200, available: 200, marginUsed: 0, unrealizedPnl: 0 },
    ];

    const plan = computeRebalancePlan(snapshots, {
      weights: { lighter: 0.5, pacifica: 0.5 },
      minMove: 10,
      reserve: 10,
    });

    // Total available = 900, each should have 450
    // Lighter has 700 (surplus ~250), Pacifica has 200 (deficit ~250)
    expect(plan.moves.length).toBeGreaterThan(0);

    // The move should be from lighter to pacifica
    const move = plan.moves[0];
    expect(move.from).toBe("lighter");
    expect(move.to).toBe("pacifica");
    expect(move.amount).toBeGreaterThan(100); // Should move ~230+ (minus reserve)
  });

  it("returns no moves when already balanced", async () => {
    const { computeRebalancePlan } = await import("../rebalance.js");

    const snapshots = [
      { exchange: "lighter", equity: 500, available: 500, marginUsed: 0, unrealizedPnl: 0 },
      { exchange: "pacifica", equity: 500, available: 500, marginUsed: 0, unrealizedPnl: 0 },
    ];

    const plan = computeRebalancePlan(snapshots, {
      weights: { lighter: 0.5, pacifica: 0.5 },
      minMove: 10,
      reserve: 10,
    });

    expect(plan.moves.length).toBe(0);
  });

  it("respects 33:33:33 three-way split", async () => {
    const { computeRebalancePlan } = await import("../rebalance.js");

    const snapshots = [
      { exchange: "lighter", equity: 900, available: 900, marginUsed: 0, unrealizedPnl: 0 },
      { exchange: "pacifica", equity: 0, available: 0, marginUsed: 0, unrealizedPnl: 0 },
      { exchange: "hyperliquid", equity: 0, available: 0, marginUsed: 0, unrealizedPnl: 0 },
    ];

    const plan = computeRebalancePlan(snapshots, {
      weights: { lighter: 1/3, pacifica: 1/3, hyperliquid: 1/3 },
      minMove: 10,
      reserve: 10,
    });

    // Should move funds from lighter to the other two
    expect(plan.moves.length).toBeGreaterThanOrEqual(1);
    for (const m of plan.moves) {
      expect(m.from).toBe("lighter");
      expect(["pacifica", "hyperliquid"]).toContain(m.to);
    }
  });
});
