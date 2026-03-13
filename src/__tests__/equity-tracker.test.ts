/**
 * Tests for equity tracker — PnL metrics calculation.
 */
import { describe, it, expect } from "vitest";
import {
  computeDailyPnl,
  computePnlMetrics,
  aggregateWeekly,
  type EquitySnapshot,
} from "../equity-tracker.js";

function snap(ts: string, exchange: string, equity: number): EquitySnapshot {
  return {
    ts,
    exchange,
    equity,
    available: equity * 0.8,
    marginUsed: equity * 0.2,
    unrealizedPnl: 0,
    positionCount: 0,
  };
}

describe("computeDailyPnl", () => {
  it("computes daily PnL from snapshots", () => {
    const snapshots: EquitySnapshot[] = [
      snap("2026-03-10T08:00:00Z", "hl", 100),
      snap("2026-03-10T20:00:00Z", "hl", 105),
      snap("2026-03-11T08:00:00Z", "hl", 103),
      snap("2026-03-11T20:00:00Z", "hl", 110),
    ];

    const daily = computeDailyPnl(snapshots, "hl");
    expect(daily).toHaveLength(2);
    expect(daily[0].date).toBe("2026-03-10");
    expect(daily[0].startEquity).toBe(100);
    expect(daily[0].endEquity).toBe(105);
    expect(daily[0].pnl).toBe(5);

    // Day 2: starts at day 1's end (105), ends at 110
    expect(daily[1].date).toBe("2026-03-11");
    expect(daily[1].startEquity).toBe(105);
    expect(daily[1].endEquity).toBe(110);
    expect(daily[1].pnl).toBe(5);
  });

  it("returns empty for no snapshots", () => {
    expect(computeDailyPnl([], "hl")).toEqual([]);
  });

  it("handles single day", () => {
    const snapshots = [
      snap("2026-03-10T08:00:00Z", "hl", 100),
      snap("2026-03-10T20:00:00Z", "hl", 102),
    ];
    const daily = computeDailyPnl(snapshots, "hl");
    expect(daily).toHaveLength(1);
    expect(daily[0].pnl).toBe(2);
    expect(daily[0].pnlPct).toBeCloseTo(2, 1);
  });
});

describe("computePnlMetrics", () => {
  it("calculates total return correctly", () => {
    const snapshots = [
      snap("2026-03-10T08:00:00Z", "hl", 1000),
      snap("2026-03-10T20:00:00Z", "hl", 1050),
      snap("2026-03-11T08:00:00Z", "hl", 1030),
      snap("2026-03-11T20:00:00Z", "hl", 1080),
      snap("2026-03-12T08:00:00Z", "hl", 1060),
      snap("2026-03-12T20:00:00Z", "hl", 1100),
    ];

    const metrics = computePnlMetrics(snapshots, "hl");
    expect(metrics.totalReturn).toBe(100);
    expect(metrics.totalReturnPct).toBeCloseTo(10, 0);
    expect(metrics.period.days).toBe(3);
    expect(metrics.peakEquity).toBe(1100);
  });

  it("calculates win/loss stats", () => {
    const snapshots = [
      snap("2026-03-10T08:00:00Z", "hl", 1000),
      snap("2026-03-10T20:00:00Z", "hl", 1050), // win
      snap("2026-03-11T20:00:00Z", "hl", 1020), // loss
      snap("2026-03-12T20:00:00Z", "hl", 1080), // win
    ];

    const metrics = computePnlMetrics(snapshots, "hl");
    expect(metrics.winDays).toBe(2);
    expect(metrics.lossDays).toBe(1);
    expect(metrics.winRate).toBeCloseTo(66.67, 0);
  });

  it("calculates max drawdown", () => {
    const snapshots = [
      snap("2026-03-10T20:00:00Z", "hl", 1000),
      snap("2026-03-11T20:00:00Z", "hl", 1100), // peak
      snap("2026-03-12T20:00:00Z", "hl", 990),  // drawdown from peak
      snap("2026-03-13T20:00:00Z", "hl", 1050),
    ];

    const metrics = computePnlMetrics(snapshots, "hl");
    expect(metrics.peakEquity).toBe(1100);
    expect(metrics.maxDrawdown).toBe(110); // 1100 - 990
    expect(metrics.maxDrawdownPct).toBeCloseTo(10, 0);
  });

  it("returns zeros for empty snapshots", () => {
    const metrics = computePnlMetrics([]);
    expect(metrics.totalReturn).toBe(0);
    expect(metrics.sharpeRatio).toBe(0);
    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.period.days).toBe(0);
  });

  it("computes Sharpe ratio", () => {
    // Consistent positive daily returns → positive Sharpe
    const snapshots = [
      snap("2026-03-10T20:00:00Z", "hl", 1000),
      snap("2026-03-11T20:00:00Z", "hl", 1010),
      snap("2026-03-12T20:00:00Z", "hl", 1020),
      snap("2026-03-13T20:00:00Z", "hl", 1030),
      snap("2026-03-14T20:00:00Z", "hl", 1040),
    ];

    const metrics = computePnlMetrics(snapshots, "hl");
    expect(metrics.sharpeRatio).toBeGreaterThan(0);
    // Very consistent returns → high Sharpe
    expect(metrics.sharpeRatio).toBeGreaterThan(10);
  });
});

describe("aggregateWeekly", () => {
  it("groups daily PnL into weeks", () => {
    const snapshots = [
      // Week 1 (Mon Mar 9 - Sun Mar 15)
      snap("2026-03-09T20:00:00Z", "hl", 1000),
      snap("2026-03-10T20:00:00Z", "hl", 1010),
      snap("2026-03-11T20:00:00Z", "hl", 1020),
      // Week 2 (Mon Mar 16 - Sun Mar 22)
      snap("2026-03-16T20:00:00Z", "hl", 1030),
      snap("2026-03-17T20:00:00Z", "hl", 1050),
    ];

    const daily = computeDailyPnl(snapshots, "hl");
    const weekly = aggregateWeekly(daily);
    expect(weekly.length).toBeGreaterThanOrEqual(1);
    // Each week should have aggregated PnL
    for (const w of weekly) {
      expect(w).toHaveProperty("pnl");
      expect(w).toHaveProperty("pnlPct");
    }
  });

  it("returns empty for empty input", () => {
    expect(aggregateWeekly([])).toEqual([]);
  });
});
