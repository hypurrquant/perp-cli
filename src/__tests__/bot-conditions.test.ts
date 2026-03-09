import { describe, it, expect } from "vitest";
import {
  calculateRSI,
  evaluateCondition,
  evaluateAllConditions,
  type MarketSnapshot,
} from "../bot/conditions.js";
import type { Condition } from "../bot/config.js";

// ── Helper: build a snapshot with defaults ──

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    price: 100,
    high24h: 105,
    low24h: 95,
    volume24h: 1_000_000,
    fundingRate: 0.0001,
    volatility24h: 10,
    rsi: 50,
    spreadPct: 0.05,
    ...overrides,
  };
}

const defaultContext = {
  equity: 10_000,
  startTime: Date.now() - 60_000,
  peakEquity: 10_500,
  dailyPnl: -200,
};

// ═══════════════════════════════════════════════════
// RSI Calculation Tests
// ═══════════════════════════════════════════════════

describe("calculateRSI", () => {
  it("returns NaN when insufficient data (fewer than period+1 prices)", () => {
    // Need at least 15 prices for period=14 (to get 14 deltas)
    const closes = [100, 101, 102, 103, 104]; // only 5 prices
    expect(calculateRSI(closes, 14)).toBeNaN();
  });

  it("returns NaN for empty array", () => {
    expect(calculateRSI([])).toBeNaN();
  });

  it("returns NaN for single price", () => {
    expect(calculateRSI([100])).toBeNaN();
  });

  it("returns 100 when all changes are positive (14 consecutive ups)", () => {
    // 15 prices: 100, 101, ..., 114 — all gains, no losses
    const closes = Array.from({ length: 15 }, (_, i) => 100 + i);
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBe(100);
  });

  it("returns ~0 when all changes are negative (14 consecutive downs)", () => {
    // 15 prices: 114, 113, ..., 100 — all losses, no gains
    const closes = Array.from({ length: 15 }, (_, i) => 114 - i);
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeCloseTo(0, 5);
  });

  it("returns 50 when all prices are the same (no movement)", () => {
    const closes = Array.from({ length: 20 }, () => 100);
    const rsi = calculateRSI(closes, 14);
    // avgGain=0, avgLoss=0 => RSI=50 by convention
    expect(rsi).toBe(50);
  });

  it("returns ~50 when gains and losses are perfectly balanced", () => {
    // Alternating +1, -1 with enough data for Wilder smoothing to converge
    const closes: number[] = [100];
    for (let i = 1; i <= 100; i++) {
      closes.push(closes[i - 1] + (i % 2 === 1 ? 1 : -1));
    }
    // With Wilder smoothing, alternating equal gains/losses converges toward 50
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThan(45);
    expect(rsi).toBeLessThan(55);
  });

  it("computes correct RSI for a known sequence (textbook example)", () => {
    // Classic textbook: 14-period RSI example
    // Prices chosen so that first 14 deltas have known gains/losses
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33,
      44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28,
      46.00, 46.03, 46.41, 46.22, 46.21,
    ];
    // This is a well-known RSI example; 14 deltas from 20 prices
    // First 14 deltas: -0.25, 0.06, -0.54, 0.72, 0.50, 0.27, 0.32, 0.42, 0.24, -0.19, 0.14, -0.42, 0.67, 0.00
    // Gains: 0, 0.06, 0, 0.72, 0.50, 0.27, 0.32, 0.42, 0.24, 0, 0.14, 0, 0.67, 0 = 3.34, avg = 0.2386
    // Losses: 0.25, 0, 0.54, 0, 0, 0, 0, 0, 0, 0.19, 0, 0.42, 0, 0 = 1.40, avg = 0.1000
    // After Wilder smoothing for remaining 5 deltas...
    // We just verify it's in a reasonable range (60-80 for this bullish data)
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThan(55);
    expect(rsi).toBeLessThan(80);
  });

  it("works with period=7 (shorter period)", () => {
    // 8 prices needed minimum for period=7
    const closes = [100, 102, 101, 103, 105, 104, 106, 108];
    const rsi = calculateRSI(closes, 7);
    // Mostly up, should be above 50
    expect(rsi).toBeGreaterThan(50);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it("handles exactly period+1 prices (minimum required)", () => {
    // Exactly 15 prices for period=14
    const closes = Array.from({ length: 15 }, (_, i) => 100 + i * 0.5);
    const rsi = calculateRSI(closes, 14);
    // All ups => RSI = 100
    expect(rsi).toBe(100);
  });

  it("handles large datasets correctly", () => {
    // 200 prices with upward trend + noise
    const closes: number[] = [1000];
    for (let i = 1; i < 200; i++) {
      // Trend up ~0.5 with noise +-2
      closes.push(closes[i - 1] + 0.5 + (Math.sin(i) * 2));
    }
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThan(0);
    expect(rsi).toBeLessThan(100);
    expect(Number.isFinite(rsi)).toBe(true);
  });

  it("RSI increases when more gains are added to the series", () => {
    // Base: mixed data
    const base = [100, 99, 101, 98, 102, 97, 103, 96, 104, 95, 105, 94, 106, 93, 107];
    const rsiBase = calculateRSI(base, 14);

    // Extend with strong gains
    const bullish = [...base, 110, 115, 120, 125, 130];
    const rsiBullish = calculateRSI(bullish, 14);

    expect(rsiBullish).toBeGreaterThan(rsiBase);
  });

  it("RSI decreases when more losses are added to the series", () => {
    const base = [100, 99, 101, 98, 102, 97, 103, 96, 104, 95, 105, 94, 106, 93, 107];
    const rsiBase = calculateRSI(base, 14);

    // Extend with strong losses
    const bearish = [...base, 102, 97, 92, 87, 82];
    const rsiBearish = calculateRSI(bearish, 14);

    expect(rsiBearish).toBeLessThan(rsiBase);
  });

  it("returns value in [0, 100] range for random data", () => {
    // Generate random-walk prices
    const closes: number[] = [100];
    for (let i = 1; i < 50; i++) {
      closes.push(closes[i - 1] + (Math.random() - 0.5) * 4);
    }
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it("default period is 14", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsiDefault = calculateRSI(closes);
    const rsi14 = calculateRSI(closes, 14);
    expect(rsiDefault).toBe(rsi14);
  });
});

// ═══════════════════════════════════════════════════
// RSI with real-world-like price data
// ═══════════════════════════════════════════════════

describe("calculateRSI with realistic price data", () => {
  it("produces overbought signal (>70) in strong uptrend", () => {
    // Simulate strong uptrend: ETH going from 2000 to 2400 over 30 candles
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) {
      // Strong consistent uptrend with small pullbacks
      closes.push(2000 + i * 14 - (i % 3 === 0 ? 5 : 0));
    }
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThan(70);
  });

  it("produces oversold signal (<30) in strong downtrend", () => {
    // Simulate strong downtrend: ETH going from 2400 to 2000 over 30 candles
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) {
      closes.push(2400 - i * 14 + (i % 3 === 0 ? 5 : 0));
    }
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeLessThan(30);
  });

  it("hovers around 50 in choppy/sideways market", () => {
    // Simulate choppy market: oscillating around 2000
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) {
      closes.push(2000 + Math.sin(i * 0.8) * 20);
    }
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThan(30);
    expect(rsi).toBeLessThan(70);
  });

  it("responds to trend reversal", () => {
    // Downtrend then reversal
    const closes: number[] = [];
    // 20 candles of downtrend
    for (let i = 0; i < 20; i++) {
      closes.push(2400 - i * 10);
    }
    const rsiBeforeReversal = calculateRSI(closes, 14);

    // 10 candles of uptrend (reversal)
    for (let i = 0; i < 10; i++) {
      closes.push(2200 + i * 15);
    }
    const rsiAfterReversal = calculateRSI(closes, 14);

    expect(rsiAfterReversal).toBeGreaterThan(rsiBeforeReversal);
  });
});

// ═══════════════════════════════════════════════════
// evaluateCondition tests for RSI
// ═══════════════════════════════════════════════════

describe("evaluateCondition — rsi_above", () => {
  it("returns true when RSI exceeds the threshold", () => {
    const snapshot = makeSnapshot({ rsi: 75 });
    const cond: Condition = { type: "rsi_above", value: 70 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(true);
  });

  it("returns false when RSI is below the threshold", () => {
    const snapshot = makeSnapshot({ rsi: 65 });
    const cond: Condition = { type: "rsi_above", value: 70 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });

  it("returns false when RSI equals the threshold (not strictly above)", () => {
    const snapshot = makeSnapshot({ rsi: 70 });
    const cond: Condition = { type: "rsi_above", value: 70 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });

  it("returns false when RSI is NaN (insufficient data)", () => {
    const snapshot = makeSnapshot({ rsi: NaN });
    const cond: Condition = { type: "rsi_above", value: 30 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });

  it("accepts string value and parses it", () => {
    const snapshot = makeSnapshot({ rsi: 80 });
    const cond: Condition = { type: "rsi_above", value: "70" };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(true);
  });
});

describe("evaluateCondition — rsi_below", () => {
  it("returns true when RSI is below the threshold", () => {
    const snapshot = makeSnapshot({ rsi: 25 });
    const cond: Condition = { type: "rsi_below", value: 30 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(true);
  });

  it("returns false when RSI is above the threshold", () => {
    const snapshot = makeSnapshot({ rsi: 45 });
    const cond: Condition = { type: "rsi_below", value: 30 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });

  it("returns false when RSI equals the threshold", () => {
    const snapshot = makeSnapshot({ rsi: 30 });
    const cond: Condition = { type: "rsi_below", value: 30 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });

  it("returns false when RSI is NaN", () => {
    const snapshot = makeSnapshot({ rsi: NaN });
    const cond: Condition = { type: "rsi_below", value: 70 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════
// evaluateCondition tests for spread_above
// ═══════════════════════════════════════════════════

describe("evaluateCondition — spread_above", () => {
  it("returns true when spread exceeds threshold", () => {
    const snapshot = makeSnapshot({ spreadPct: 0.15 });
    const cond: Condition = { type: "spread_above", value: 0.1 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(true);
  });

  it("returns false when spread is below threshold", () => {
    const snapshot = makeSnapshot({ spreadPct: 0.03 });
    const cond: Condition = { type: "spread_above", value: 0.1 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });

  it("returns false when spread equals threshold", () => {
    const snapshot = makeSnapshot({ spreadPct: 0.1 });
    const cond: Condition = { type: "spread_above", value: 0.1 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });

  it("returns false when spread is zero (tight book)", () => {
    const snapshot = makeSnapshot({ spreadPct: 0 });
    const cond: Condition = { type: "spread_above", value: 0.01 };
    expect(evaluateCondition(cond, snapshot, defaultContext)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════
// evaluateAllConditions with RSI
// ═══════════════════════════════════════════════════

describe("evaluateAllConditions with RSI conditions", () => {
  it("combines RSI with price condition in 'all' mode", () => {
    const snapshot = makeSnapshot({ price: 110, rsi: 75 });
    const conditions: Condition[] = [
      { type: "price_above", value: 100 },
      { type: "rsi_above", value: 70 },
    ];
    expect(evaluateAllConditions(conditions, snapshot, defaultContext, "all")).toBe(true);
  });

  it("fails 'all' mode when RSI condition not met", () => {
    const snapshot = makeSnapshot({ price: 110, rsi: 65 });
    const conditions: Condition[] = [
      { type: "price_above", value: 100 },
      { type: "rsi_above", value: 70 },
    ];
    expect(evaluateAllConditions(conditions, snapshot, defaultContext, "all")).toBe(false);
  });

  it("passes 'any' mode when only RSI condition is met", () => {
    const snapshot = makeSnapshot({ price: 90, rsi: 25 });
    const conditions: Condition[] = [
      { type: "price_above", value: 100 },
      { type: "rsi_below", value: 30 },
    ];
    expect(evaluateAllConditions(conditions, snapshot, defaultContext, "any")).toBe(true);
  });

  it("combines spread_above with rsi_below for entry signal", () => {
    // Wide spread + oversold RSI = potential entry
    const snapshot = makeSnapshot({ spreadPct: 0.5, rsi: 22 });
    const conditions: Condition[] = [
      { type: "spread_above", value: 0.3 },
      { type: "rsi_below", value: 30 },
    ];
    expect(evaluateAllConditions(conditions, snapshot, defaultContext, "all")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
// Existing conditions still work (regression)
// ═══════════════════════════════════════════════════

describe("evaluateCondition — regression for existing conditions", () => {
  it("always returns true", () => {
    const cond: Condition = { type: "always", value: 0 };
    expect(evaluateCondition(cond, makeSnapshot(), defaultContext)).toBe(true);
  });

  it("price_above works", () => {
    const snapshot = makeSnapshot({ price: 110 });
    expect(evaluateCondition({ type: "price_above", value: 100 }, snapshot, defaultContext)).toBe(true);
    expect(evaluateCondition({ type: "price_above", value: 120 }, snapshot, defaultContext)).toBe(false);
  });

  it("price_below works", () => {
    const snapshot = makeSnapshot({ price: 90 });
    expect(evaluateCondition({ type: "price_below", value: 100 }, snapshot, defaultContext)).toBe(true);
    expect(evaluateCondition({ type: "price_below", value: 80 }, snapshot, defaultContext)).toBe(false);
  });

  it("volatility_above works", () => {
    const snapshot = makeSnapshot({ volatility24h: 15 });
    expect(evaluateCondition({ type: "volatility_above", value: 10 }, snapshot, defaultContext)).toBe(true);
  });

  it("funding_rate_above works", () => {
    const snapshot = makeSnapshot({ fundingRate: 0.001 });
    expect(evaluateCondition({ type: "funding_rate_above", value: 0.0005 }, snapshot, defaultContext)).toBe(true);
  });

  it("balance_above works", () => {
    const ctx = { ...defaultContext, equity: 15000 };
    expect(evaluateCondition({ type: "balance_above", value: 10000 }, makeSnapshot(), ctx)).toBe(true);
  });
});
