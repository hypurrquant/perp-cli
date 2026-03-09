import { describe, it, expect } from "vitest";
import { assessRisk, preTradeCheck, type RiskLimits } from "../risk.js";
import type { ExchangeBalance, ExchangePosition } from "../exchanges/interface.js";

const defaultLimits: RiskLimits = {
  maxDrawdownUsd: 500,
  maxPositionUsd: 5000,
  maxTotalExposureUsd: 20000,
  dailyLossLimitUsd: 200,
  maxPositions: 10,
  maxLeverage: 20,
  maxMarginUtilization: 80,
};

function makeBalance(equity: number, available: number, marginUsed: number, pnl: number): ExchangeBalance {
  return { equity: String(equity), available: String(available), marginUsed: String(marginUsed), unrealizedPnl: String(pnl) };
}

function makePosition(symbol: string, side: "long" | "short", size: number, markPrice: number, leverage: number, pnl: number): ExchangePosition {
  return { symbol, side, size: String(size), entryPrice: String(markPrice), markPrice: String(markPrice), liquidationPrice: "0", unrealizedPnl: String(pnl), leverage };
}

describe("Risk Assessment", () => {
  it("should return low risk when everything is within limits", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 100) }];
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 5, 50) }];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.level).toBe("low");
    expect(result.violations).toHaveLength(0);
    expect(result.canTrade).toBe(true);
  });

  it("should detect max drawdown violation (critical)", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, -600) }];
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 5, -600) }];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.level).toBe("critical");
    expect(result.violations.some(v => v.rule === "max_drawdown")).toBe(true);
    expect(result.canTrade).toBe(false);
  });

  it("should detect max position size violation", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 5000, 5000, 0) }];
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.1, 100000, 10, 0) }]; // 0.1 * 100000 = $10000 > $5000 limit
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.violations.some(v => v.rule === "max_position_size")).toBe(true);
  });

  it("should detect max total exposure violation", () => {
    const balances = [{ exchange: "test", balance: makeBalance(50000, 30000, 20000, 0) }];
    const positions = [
      { exchange: "test", position: makePosition("BTC", "long", 0.1, 100000, 5, 0) },   // $10000
      { exchange: "test", position: makePosition("ETH", "short", 5, 3500, 5, 0) },       // $17500
    ]; // total = $27500 > $20000
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.violations.some(v => v.rule === "max_total_exposure")).toBe(true);
  });

  it("should detect max positions violation", () => {
    const limits = { ...defaultLimits, maxPositions: 2 };
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }];
    const positions = [
      { exchange: "test", position: makePosition("BTC", "long", 0.001, 100000, 2, 0) },
      { exchange: "test", position: makePosition("ETH", "short", 0.01, 3500, 2, 0) },
      { exchange: "test", position: makePosition("SOL", "long", 0.1, 150, 2, 0) },
    ];
    const result = assessRisk(balances, positions, limits);

    expect(result.violations.some(v => v.rule === "max_positions")).toBe(true);
  });

  it("should detect max leverage violation", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }];
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 50, 0) }]; // 50x > 20x
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.violations.some(v => v.rule === "max_leverage")).toBe(true);
  });

  it("should detect margin utilization violation", () => {
    const balances = [{ exchange: "test", balance: makeBalance(1000, 100, 900, 0) }]; // 90% margin usage
    const positions: { exchange: string; position: ExchangePosition }[] = [];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.violations.some(v => v.rule === "max_margin_utilization")).toBe(true);
  });

  it("should calculate correct metrics", () => {
    const balances = [
      { exchange: "ex1", balance: makeBalance(5000, 3000, 2000, 100) },
      { exchange: "ex2", balance: makeBalance(3000, 2000, 1000, -50) },
    ];
    const positions = [
      { exchange: "ex1", position: makePosition("BTC", "long", 0.02, 100000, 10, 100) },
      { exchange: "ex2", position: makePosition("ETH", "short", 1.0, 3500, 5, -50) },
    ];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.metrics.totalEquity).toBe(8000);
    expect(result.metrics.totalUnrealizedPnl).toBe(50);
    expect(result.metrics.totalMarginUsed).toBe(3000);
    expect(result.metrics.positionCount).toBe(2);
    expect(result.metrics.totalExposure).toBe(2000 + 3500); // 0.02*100000 + 1.0*3500
    expect(result.metrics.largestPositionUsd).toBe(3500);
    expect(result.metrics.maxLeverageUsed).toBe(10);
    expect(result.metrics.marginUtilization).toBeCloseTo(37.5, 1);
  });

  it("should handle empty portfolio", () => {
    const result = assessRisk([], [], defaultLimits);
    expect(result.level).toBe("low");
    expect(result.canTrade).toBe(true);
    expect(result.metrics.totalEquity).toBe(0);
  });

  it("should handle multiple violations and pick highest severity", () => {
    const balances = [{ exchange: "test", balance: makeBalance(1000, 50, 950, -600) }]; // drawdown + margin
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.1, 100000, 50, -600) }]; // position + leverage
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.level).toBe("critical"); // drawdown is critical
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.canTrade).toBe(false);
  });
});

describe("Pre-Trade Check", () => {
  it("should allow trade within limits", () => {
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }],
      [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 5, 0) }],
      defaultLimits,
    );
    const result = preTradeCheck(assessment, 1000, 5);
    expect(result.allowed).toBe(true);
  });

  it("should block trade when trading is suspended (critical violation)", () => {
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, -600) }],
      [],
      defaultLimits,
    );
    const result = preTradeCheck(assessment, 100, 2);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspended");
  });

  it("should block trade exceeding max position size", () => {
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }],
      [],
      defaultLimits,
    );
    const result = preTradeCheck(assessment, 6000, 5); // > $5000 limit
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("max position size");
  });

  it("should block trade exceeding total exposure", () => {
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(50000, 30000, 20000, 0) }],
      [{ exchange: "test", position: makePosition("BTC", "long", 0.19, 100000, 5, 0) }], // $19000
      defaultLimits,
    );
    const result = preTradeCheck(assessment, 2000, 5); // 19000 + 2000 = 21000 > 20000
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("exposure");
  });

  it("should block trade exceeding max positions", () => {
    const limits = { ...defaultLimits, maxPositions: 1 };
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }],
      [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 5, 0) }],
      limits,
    );
    const result = preTradeCheck(assessment, 500, 5); // would be 2nd position
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("max positions");
  });

  it("should block trade exceeding max leverage", () => {
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }],
      [],
      defaultLimits,
    );
    const result = preTradeCheck(assessment, 500, 25); // 25x > 20x limit
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Leverage");
  });
});
