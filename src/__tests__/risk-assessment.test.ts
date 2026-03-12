import { describe, it, expect } from "vitest";
import { assessRisk, preTradeCheck, calcLiquidationDistance, getLiquidationDistances, effectiveLimit, type RiskLimits } from "../risk.js";
import type { ExchangeBalance, ExchangePosition } from "../exchanges/interface.js";

const defaultLimits: RiskLimits = {
  maxDrawdownUsd: 500,
  maxPositionUsd: 5000,
  maxTotalExposureUsd: 20000,
  dailyLossLimitUsd: 200,
  maxPositions: 10,
  maxLeverage: 20,
  maxMarginUtilization: 80,
  minLiquidationDistance: 30,
};

function makeBalance(equity: number, available: number, marginUsed: number, pnl: number): ExchangeBalance {
  return { equity: String(equity), available: String(available), marginUsed: String(marginUsed), unrealizedPnl: String(pnl) };
}

function makePosition(symbol: string, side: "long" | "short", size: number, markPrice: number, leverage: number, pnl: number, liquidationPrice = "0"): ExchangePosition {
  return { symbol, side, size: String(size), entryPrice: String(markPrice), markPrice: String(markPrice), liquidationPrice, unrealizedPnl: String(pnl), leverage };
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

describe("calcLiquidationDistance", () => {
  it("should calculate distance for long position (liq below mark)", () => {
    // Long at $100000, liq at $80000 → 20% distance
    const dist = calcLiquidationDistance(100000, 80000, "long");
    expect(dist).toBeCloseTo(20, 1);
  });

  it("should calculate distance for short position (liq above mark)", () => {
    // Short at $100000, liq at $120000 → 20% distance
    const dist = calcLiquidationDistance(100000, 120000, "short");
    expect(dist).toBeCloseTo(20, 1);
  });

  it("should return Infinity when liquidation price is 0 or N/A", () => {
    expect(calcLiquidationDistance(100000, 0, "long")).toBe(Infinity);
    expect(calcLiquidationDistance(0, 80000, "long")).toBe(Infinity);
  });

  it("should handle very close liquidation (dangerous)", () => {
    // Long at $100000, liq at $95000 → 5% distance
    const dist = calcLiquidationDistance(100000, 95000, "long");
    expect(dist).toBeCloseTo(5, 1);
  });

  it("should handle very safe distance", () => {
    // Long at $100000, liq at $50000 → 50% distance
    const dist = calcLiquidationDistance(100000, 50000, "long");
    expect(dist).toBeCloseTo(50, 1);
  });
});

describe("getLiquidationDistances", () => {
  it("should return sorted by distance (closest first)", () => {
    const positions = [
      { exchange: "hl", position: makePosition("ETH", "long", 1, 3500, 5, 0, "3000") },   // ~14.3%
      { exchange: "pac", position: makePosition("BTC", "long", 0.01, 100000, 2, 0, "50000") }, // 50%
      { exchange: "hl", position: makePosition("SOL", "short", 10, 150, 10, 0, "165") },   // 10%
    ];
    const distances = getLiquidationDistances(positions, defaultLimits);
    expect(distances.length).toBe(3);
    expect(distances[0].symbol).toBe("SOL");  // closest to liq
    expect(distances[1].symbol).toBe("ETH");
    expect(distances[2].symbol).toBe("BTC");  // safest
  });

  it("should assign correct status based on limits", () => {
    const limits = { ...defaultLimits, minLiquidationDistance: 30 };
    const positions = [
      { exchange: "a", position: makePosition("A", "long", 1, 100, 2, 0, "85") },   // 15% → danger (< 30% user limit)
      { exchange: "b", position: makePosition("B", "long", 1, 100, 2, 0, "78") },   // 22% → danger (< 30% user limit)
      { exchange: "c", position: makePosition("C", "long", 1, 100, 2, 0, "65") },   // 35% → warning (< 30% * 1.5 = 45%)
      { exchange: "d", position: makePosition("D", "long", 1, 100, 2, 0, "40") },   // 60% → safe
    ];
    const distances = getLiquidationDistances(positions, limits);
    expect(distances.find(d => d.symbol === "A")!.status).toBe("danger");
    expect(distances.find(d => d.symbol === "B")!.status).toBe("danger");
    expect(distances.find(d => d.symbol === "C")!.status).toBe("warning");
    expect(distances.find(d => d.symbol === "D")!.status).toBe("safe");
  });

  it("should skip positions with liquidationPrice 0 or N/A", () => {
    const positions = [
      { exchange: "a", position: makePosition("BTC", "long", 1, 100000, 5, 0, "0") },
      { exchange: "b", position: makePosition("ETH", "long", 1, 3500, 5, 0, "N/A") },
      { exchange: "c", position: makePosition("SOL", "long", 1, 150, 5, 0, "120") },  // valid
    ];
    const distances = getLiquidationDistances(positions, defaultLimits);
    expect(distances.length).toBe(1);
    expect(distances[0].symbol).toBe("SOL");
  });
});

describe("Liquidation Distance in assessRisk", () => {
  it("should add violation when position is below user limit", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }];
    // BTC long at $100000, liq at $90000 → 10% distance (below 30% user limit)
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 10, 0, "90000") }];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.violations.some(v => v.rule === "min_liquidation_distance")).toBe(true);
  });

  it("should not add violation when distance is above user limit", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }];
    // BTC long at $100000, liq at $50000 → 50% distance (safe)
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 2, 0, "50000") }];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.violations.some(v => v.rule === "min_liquidation_distance")).toBe(false);
  });

  it("should report minLiquidationDistancePct in metrics", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }];
    const positions = [
      { exchange: "a", position: makePosition("BTC", "long", 0.01, 100000, 2, 0, "60000") }, // 40%
      { exchange: "b", position: makePosition("ETH", "short", 1, 3500, 5, 0, "4200") },      // 20%
    ];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.metrics.minLiquidationDistancePct).toBeCloseTo(20, 1);
  });

  it("should report -1 for minLiquidationDistancePct when no positions", () => {
    const result = assessRisk([], [], defaultLimits);
    expect(result.metrics.minLiquidationDistancePct).toBe(-1);
  });

  it("should include liquidationDistances array in assessment", () => {
    const balances = [{ exchange: "test", balance: makeBalance(10000, 8000, 2000, 0) }];
    // BTC long at $100000, liq at $30000 → 70% distance (well above 30% * 1.5 = 45% → safe)
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.01, 100000, 2, 0, "30000") }];
    const result = assessRisk(balances, positions, defaultLimits);

    expect(result.liquidationDistances).toHaveLength(1);
    expect(result.liquidationDistances[0].symbol).toBe("BTC");
    expect(result.liquidationDistances[0].distancePct).toBeCloseTo(70, 1);
    expect(result.liquidationDistances[0].status).toBe("safe");
  });
});


describe("Percentage-based Risk Limits", () => {
  it("effectiveLimit should return min of USD and pct-of-equity", () => {
    expect(effectiveLimit(500, 10, 1000)).toBe(100);  // 10% of $1000 = $100 < $500
    expect(effectiveLimit(500, 10, 10000)).toBe(500);  // 10% of $10000 = $1000 > $500
    expect(effectiveLimit(500, undefined, 1000)).toBe(500); // no pct → use USD
    expect(effectiveLimit(500, 10, 0)).toBe(500);      // zero equity → use USD
  });

  it("should use pct-based drawdown when equity is small", () => {
    const limits: RiskLimits = { ...defaultLimits, maxDrawdownPct: 10 };
    // equity = $100, 10% = $10 effective drawdown limit. uPnL = -$15 > $10 → critical
    const balances = [{ exchange: "test", balance: makeBalance(100, 80, 20, -15) }];
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.0001, 100000, 2, -15) }];
    const result = assessRisk(balances, positions, limits);

    expect(result.violations.some(v => v.rule === "max_drawdown")).toBe(true);
    expect(result.level).toBe("critical");
  });

  it("should use pct-based position limit when equity is small", () => {
    const limits: RiskLimits = { ...defaultLimits, maxPositionPct: 25 };
    // equity = $200, 25% = $50 effective position limit. Position = $100 > $50 → violation
    const balances = [{ exchange: "test", balance: makeBalance(200, 150, 50, 0) }];
    const positions = [{ exchange: "test", position: makePosition("BTC", "long", 0.001, 100000, 2, 0) }]; // $100
    const result = assessRisk(balances, positions, limits);

    expect(result.violations.some(v => v.rule === "max_position_size")).toBe(true);
  });

  it("preTradeCheck should use pct-based limits", () => {
    const limits: RiskLimits = { ...defaultLimits, maxPositionPct: 25 };
    // equity = $200, 25% = $50 effective position limit
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(200, 150, 50, 0) }],
      [],
      limits,
    );
    expect(preTradeCheck(assessment, 60, 2).allowed).toBe(false); // $60 > $50
    expect(preTradeCheck(assessment, 40, 2).allowed).toBe(true);  // $40 < $50
  });

  it("should use stricter of USD and pct limits", () => {
    const limits: RiskLimits = { ...defaultLimits, maxPositionUsd: 100, maxPositionPct: 25 };
    // equity = $1000, 25% = $250. USD limit = $100. Effective = $100 (USD is stricter)
    const assessment = assessRisk(
      [{ exchange: "test", balance: makeBalance(1000, 800, 200, 0) }],
      [],
      limits,
    );
    expect(preTradeCheck(assessment, 120, 2).allowed).toBe(false); // $120 > $100
    expect(preTradeCheck(assessment, 80, 2).allowed).toBe(true);   // $80 < $100
  });
});
