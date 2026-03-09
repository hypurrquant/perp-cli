import { describe, it, expect, vi } from "vitest";
import { computeExecutableSize, checkArbLiquidity } from "../liquidity.js";

// ──────────────────────────────────────────────
// computeExecutableSize — orderbook walking
// ──────────────────────────────────────────────

describe("computeExecutableSize — empty book", () => {
  it("returns zeroed result for empty levels", () => {
    const result = computeExecutableSize([], 1000);
    expect(result.maxSize).toBe(0);
    expect(result.avgFillPrice).toBe(0);
    expect(result.slippagePct).toBe(0);
    expect(result.depthUsd).toBe(0);
    expect(result.canFillFull).toBe(false);
    expect(result.recommendedSize).toBe(0);
  });
});

describe("computeExecutableSize — single level", () => {
  it("fills entirely from one level when sufficient", () => {
    // One level at $100, size 100 = $10,000 USD. Request $500.
    const result = computeExecutableSize([["100", "100"]], 500);
    expect(result.maxSize).toBeCloseTo(5); // $500 / $100
    expect(result.avgFillPrice).toBeCloseTo(100);
    expect(result.slippagePct).toBeCloseTo(0);
    expect(result.canFillFull).toBe(true);
    expect(result.depthUsd).toBeCloseTo(10000);
  });

  it("partially fills when level is insufficient", () => {
    // One level at $100, size 2 = $200 USD. Request $500.
    const result = computeExecutableSize([["100", "2"]], 500);
    expect(result.maxSize).toBeCloseTo(2);
    expect(result.avgFillPrice).toBeCloseTo(100);
    // Can't fill 95% → canFillFull = false
    expect(result.canFillFull).toBe(false);
    expect(result.depthUsd).toBeCloseTo(200);
  });
});

describe("computeExecutableSize — multiple levels", () => {
  it("walks through levels to fill requested size", () => {
    // Use prices well within slippage tolerance (default 0.5%)
    // bestPrice = 100, slippageLimit = 100.5
    // All prices must be <= 100.5 to not be stopped by slippage check
    const levels: [string, string][] = [
      ["100", "5"],     // $500
      ["100.2", "5"],   // $501 — well within 0.5% of $100
      ["100.4", "10"],  // $1004 — also within 0.5%
    ];
    // Request $1000. Level 1: $500 fully consumed (5 units).
    // Level 2: remaining $500, levelUsd $501 > $500, partial fill: 500/100.2 ≈ 4.99 units.
    const result = computeExecutableSize(levels, 1000);
    expect(result.maxSize).toBeCloseTo(5 + 500 / 100.2, 2);
    expect(result.canFillFull).toBe(true);
    expect(result.avgFillPrice).toBeCloseTo(1000 / result.maxSize, 2);
    expect(result.slippagePct).toBeGreaterThan(0);
    expect(result.slippagePct).toBeLessThan(0.5);
  });

  it("computes slippage as avg fill vs best price", () => {
    // Use wider slippage tolerance (5%) so all levels are included
    const levels: [string, string][] = [
      ["1000", "0.1"],  // $100
      ["1010", "0.1"],  // $101
      ["1020", "10"],   // $10,200
    ];
    // With 5% tolerance, slippageLimit = 1000 * 1.05 = 1050
    // All levels are within tolerance.
    // Request $10,000. Level 1: $100 (fully consumed). Level 2: $101 (fully consumed).
    // Level 3: remaining = $9799, levelUsd = $10200 > remaining → partial fill.
    const result = computeExecutableSize(levels, 10000, 5);
    // Most of the fill happens at $1020
    expect(result.avgFillPrice).toBeGreaterThan(1000);
    // slippagePct = abs((avgFillPrice - 1000) / 1000) * 100
    expect(result.slippagePct).toBeGreaterThan(1);
    expect(result.slippagePct).toBeLessThan(3);
  });

  it("stops walking when slippage limit is exceeded", () => {
    const levels: [string, string][] = [
      ["100", "1"],     // $100
      ["100.4", "1"],   // $100.40 — within 0.5%
      ["101", "100"],   // $10,100 — 1% above best, exceeds 0.5% default
    ];
    // Request $5000 with default 0.5% slippage.
    // slippageLimit = 100 * (1 + 0.5/100) = 100.5
    // Level 1: $100 (consumed), level 2: $100.4 (consumed), level 3: $101 > $100.5 → stop
    const result = computeExecutableSize(levels, 5000, 0.5);
    // Should only consume levels 1 and 2
    expect(result.maxSize).toBeCloseTo(2);
    expect(result.canFillFull).toBe(false);
  });

  it("respects custom slippage tolerance", () => {
    const levels: [string, string][] = [
      ["100", "1"],
      ["102", "100"], // 2% above best
    ];
    // With 3% tolerance, level 2 is within range
    const result = computeExecutableSize(levels, 5000, 3);
    expect(result.canFillFull).toBe(true);
    expect(result.maxSize).toBeGreaterThan(1);
  });

  it("considers canFillFull at 95% threshold", () => {
    // Need $1000. If we fill $950, canFillFull = true (95%)
    const levels: [string, string][] = [
      ["100", "9.5"], // $950
    ];
    const result = computeExecutableSize(levels, 1000);
    expect(result.canFillFull).toBe(true);

    // Need $1000. If we fill $940, canFillFull = false (94%)
    const levels2: [string, string][] = [
      ["100", "9.4"], // $940
    ];
    const result2 = computeExecutableSize(levels2, 1000);
    expect(result2.canFillFull).toBe(false);
  });
});

describe("computeExecutableSize — depth calculation", () => {
  it("accumulates total depth across all iterated levels", () => {
    const levels: [string, string][] = [
      ["100", "10"],   // $1000
      ["101", "10"],   // $1010
      ["102", "10"],   // $1020
    ];
    // Request $500. Level 1 has $1000 > $500, so partial fill on level 1.
    // But the loop: totalDepthUsd is accumulated BEFORE checking remainingUsd.
    // So level 1: totalDepthUsd += $1000, then fills $500 partial, then remainingUsd = 0.
    // Level 2: totalDepthUsd += $1010 (accumulated before the break on remainingUsd <= 0).
    // Actually: after level 1 fill, filledNotional = $500, so remainingUsd = 0 → breaks at start of level 2.
    // Wait — let's trace: for level 1, totalDepthUsd += 1000, price 100 not > slippageLimit,
    // remaining = 500, levelUsd = 1000 > 500 → partial fill. filledNotional = 500.
    // Next iteration level 2: totalDepthUsd += 1010, then remaining = 500 - 500 = 0 → break.
    // So totalDepthUsd = 1000 + 1010 = 2010.
    const result = computeExecutableSize(levels, 500);
    expect(result.depthUsd).toBeCloseTo(2010);
    // But only $500 was actually filled from level 1
    expect(result.maxSize).toBeCloseTo(5); // 500 / 100
    expect(result.canFillFull).toBe(true);
  });
});

// ──────────────────────────────────────────────
// checkArbLiquidity — cross-exchange check
// ──────────────────────────────────────────────

function mockAdapter(name: string, asks: [string, string][], bids: [string, string][]) {
  return {
    name,
    getOrderbook: vi.fn().mockResolvedValue({ asks, bids }),
    getMarkets: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "0" }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    marketOrder: vi.fn().mockResolvedValue({}),
    limitOrder: vi.fn().mockResolvedValue({}),
    editOrder: vi.fn().mockResolvedValue({}),
    cancelOrder: vi.fn().mockResolvedValue({}),
    cancelAllOrders: vi.fn().mockResolvedValue({}),
    setLeverage: vi.fn().mockResolvedValue({}),
    stopOrder: vi.fn().mockResolvedValue({}),
  } as any;
}

describe("checkArbLiquidity", () => {
  it("returns viable when both sides have sufficient liquidity", async () => {
    const longAdapter = mockAdapter("exchange-a",
      [["60000", "10"], ["60010", "10"]], // asks
      [["59990", "10"]],                   // bids
    );
    const shortAdapter = mockAdapter("exchange-b",
      [["60005", "10"]],                   // asks
      [["59995", "10"], ["59985", "10"]], // bids
    );

    const result = await checkArbLiquidity(longAdapter, shortAdapter, "BTC", 1000);
    expect(result.viable).toBe(true);
    expect(result.adjustedSizeUsd).toBeGreaterThan(0);
    expect(result.adjustedSizeUsd).toBeLessThanOrEqual(1000);
  });

  it("returns not viable when liquidity is too thin (less than 20% of requested)", async () => {
    const longAdapter = mockAdapter("exchange-a",
      [["60000", "0.001"]], // asks: ~$60
      [["59990", "1"]],
    );
    const shortAdapter = mockAdapter("exchange-b",
      [["60005", "1"]],
      [["59995", "0.001"]], // bids: ~$60
    );

    // Request $10000. Both sides have ~$60 → way below 20% = $2000 threshold
    const result = await checkArbLiquidity(longAdapter, shortAdapter, "BTC", 10000);
    expect(result.viable).toBe(false);
    expect(result.adjustedSizeUsd).toBe(0);
  });

  it("returns not viable when cross-exchange price gap exceeds 2%", async () => {
    const longAdapter = mockAdapter("exchange-a",
      [["60000", "100"]], // asks
      [["59900", "100"]],
    );
    const shortAdapter = mockAdapter("exchange-b",
      [["62000", "100"]], // asks
      [["61500", "100"]], // bids: $61500 vs longAdapter ask $60000 → gap ~2.5%
    );

    const result = await checkArbLiquidity(longAdapter, shortAdapter, "BTC", 1000);
    expect(result.viable).toBe(false);
  });

  it("adjusts size down when one side has limited liquidity", async () => {
    const longAdapter = mockAdapter("exchange-a",
      [["60000", "0.05"]], // asks: $3000
      [["59990", "10"]],
    );
    const shortAdapter = mockAdapter("exchange-b",
      [["60010", "10"]],
      [["59995", "10"]], // bids: $599,950
    );

    // Request $5000. Long side only has $3000 on asks.
    const result = await checkArbLiquidity(longAdapter, shortAdapter, "BTC", 5000);
    expect(result.viable).toBe(true);
    expect(result.adjustedSizeUsd).toBeLessThan(5000);
    expect(result.adjustedSizeUsd).toBeGreaterThan(0);
  });

  it("returns not viable when orderbook fetch fails", async () => {
    const longAdapter = mockAdapter("exchange-a", [], []);
    longAdapter.getOrderbook = vi.fn().mockRejectedValue(new Error("timeout"));
    const shortAdapter = mockAdapter("exchange-b", [], []);

    const result = await checkArbLiquidity(longAdapter, shortAdapter, "BTC", 1000);
    expect(result.viable).toBe(false);
    expect(result.adjustedSizeUsd).toBe(0);
  });

  it("invokes log callback for diagnostics", async () => {
    const longAdapter = mockAdapter("exchange-a",
      [["60000", "0.001"]], // tiny asks
      [["59990", "1"]],
    );
    const shortAdapter = mockAdapter("exchange-b",
      [["60005", "1"]],
      [["59995", "0.001"]], // tiny bids
    );

    const logFn = vi.fn();
    await checkArbLiquidity(longAdapter, shortAdapter, "BTC", 10000, 0.5, logFn);
    expect(logFn).toHaveBeenCalled();
    expect(logFn.mock.calls[0][0]).toContain("[LIQ]");
  });

  it("caps adjusted size to requested size when liquidity is ample", async () => {
    const longAdapter = mockAdapter("exchange-a",
      [["60000", "100"]], // $6M asks
      [["59990", "100"]],
    );
    const shortAdapter = mockAdapter("exchange-b",
      [["60005", "100"]],
      [["59995", "100"]], // $6M bids
    );

    const result = await checkArbLiquidity(longAdapter, shortAdapter, "BTC", 1000);
    expect(result.viable).toBe(true);
    expect(result.adjustedSizeUsd).toBeLessThanOrEqual(1000);
  });
});
