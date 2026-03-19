import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { ExchangeAdapter, ExchangeBalance, ExchangePosition } from "./exchanges/index.js";

// ── Risk Configuration ──

export interface RiskLimits {
  maxDrawdownUsd: number;       // close all if uPnL below this (default 500)
  maxPositionUsd: number;       // max single position notional (default 5000)
  maxTotalExposureUsd: number;  // max total notional across all positions (default 20000)
  dailyLossLimitUsd: number;    // stop trading if daily realized loss exceeds this (default 200)
  maxPositions: number;         // max number of simultaneous positions (default 10)
  maxLeverage: number;          // max leverage per position (default 20)
  maxMarginUtilization: number; // max margin/equity ratio % (default 80)
  minLiquidationDistance: number; // min % distance from liquidation price (default 5)
  // Percentage-based limits (% of total equity). When both USD and % are set, the stricter one applies.
  maxDrawdownPct?: number;      // max drawdown as % of equity (default: 10)
  maxPositionPct?: number;      // max single position as % of equity (default: 25)
  maxExposurePct?: number;      // max total exposure as % of equity (default: none)
  dailyLossPct?: number;        // daily loss limit as % of equity (default: none)
}

const DEFAULT_LIMITS: RiskLimits = {
  maxDrawdownUsd: 100000,
  maxPositionUsd: 100000,
  maxTotalExposureUsd: 500000,
  dailyLossLimitUsd: 50000,
  maxPositions: 50,
  maxLeverage: 50,
  maxMarginUtilization: 95,
  minLiquidationDistance: 5,
  maxDrawdownPct: undefined,
  maxPositionPct: undefined,
};

/** Resolve effective USD limit: min of fixed USD and pct-of-equity (if both set) */
export function effectiveLimit(usdLimit: number, pctLimit: number | undefined, totalEquity: number): number {
  if (pctLimit == null || totalEquity <= 0) return usdLimit;
  const pctInUsd = (pctLimit / 100) * totalEquity;
  return Math.min(usdLimit, pctInUsd);
}


const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const RISK_FILE = resolve(PERP_DIR, "risk.json");

export function loadRiskLimits(): RiskLimits {
  if (!existsSync(RISK_FILE)) return { ...DEFAULT_LIMITS };
  try {
    const stored = JSON.parse(readFileSync(RISK_FILE, "utf-8"));
    return { ...DEFAULT_LIMITS, ...stored };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

export function saveRiskLimits(limits: RiskLimits): void {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(RISK_FILE, JSON.stringify(limits, null, 2), { mode: 0o600 });
}

// ── Risk Assessment ──

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskViolation {
  rule: string;
  severity: RiskLevel;
  message: string;
  current: number;
  limit: number;
}

export interface LiquidationDistanceInfo {
  exchange: string;
  symbol: string;
  side: "long" | "short";
  markPrice: number;
  liquidationPrice: number;
  distancePct: number;        // % away from liquidation (higher = safer)
  status: "safe" | "warning" | "danger" | "critical";
}

/** Calculate % distance from current price to liquidation price */
export function calcLiquidationDistance(
  markPrice: number,
  liquidationPrice: number,
  side: "long" | "short",
): number {
  if (liquidationPrice <= 0 || markPrice <= 0) return Infinity;
  if (side === "long") {
    // Long: liq price is below mark price
    return ((markPrice - liquidationPrice) / markPrice) * 100;
  } else {
    // Short: liq price is above mark price
    return ((liquidationPrice - markPrice) / markPrice) * 100;
  }
}

export function getLiquidationDistances(
  positions: { exchange: string; position: ExchangePosition }[],
  limits?: RiskLimits,
): LiquidationDistanceInfo[] {
  const lim = limits ?? loadRiskLimits();
  return positions
    .filter(({ position: p }) => p.liquidationPrice !== "N/A" && Number(p.liquidationPrice) > 0)
    .map(({ exchange, position: p }) => {
      const markPrice = Number(p.markPrice);
      const liquidationPrice = Number(p.liquidationPrice);
      const distancePct = calcLiquidationDistance(markPrice, liquidationPrice, p.side);
      let status: LiquidationDistanceInfo["status"] = "safe";
      if (distancePct < lim.minLiquidationDistance) status = "danger";
      else if (distancePct < lim.minLiquidationDistance * 1.5) status = "warning";
      return { exchange, symbol: p.symbol, side: p.side, markPrice, liquidationPrice, distancePct, status };
    })
    .sort((a, b) => a.distancePct - b.distancePct);
}

export interface RiskAssessment {
  level: RiskLevel;
  violations: RiskViolation[];
  metrics: {
    totalEquity: number;
    totalUnrealizedPnl: number;
    totalMarginUsed: number;
    totalExposure: number;
    positionCount: number;
    marginUtilization: number;
    largestPositionUsd: number;
    maxLeverageUsed: number;
    minLiquidationDistancePct: number;
  };
  liquidationDistances: LiquidationDistanceInfo[];
  limits: RiskLimits;
  canTrade: boolean;
}

export function assessRisk(
  balances: { exchange: string; balance: ExchangeBalance }[],
  positions: { exchange: string; position: ExchangePosition }[],
  limits?: RiskLimits,
): RiskAssessment {
  const lim = limits ?? loadRiskLimits();
  const violations: RiskViolation[] = [];

  // Compute metrics
  let totalEquity = 0;
  let totalUnrealizedPnl = 0;
  let totalMarginUsed = 0;
  for (const { balance } of balances) {
    totalEquity += Number(balance.equity);
    totalUnrealizedPnl += Number(balance.unrealizedPnl);
    totalMarginUsed += Number(balance.marginUsed);
  }

  let totalExposure = 0;
  let largestPositionUsd = 0;
  let maxLeverageUsed = 0;
  for (const { position: p } of positions) {
    const notional = Math.abs(Number(p.size) * Number(p.markPrice));
    totalExposure += notional;
    if (notional > largestPositionUsd) largestPositionUsd = notional;
    const lev = Number(p.leverage) || 0;
    if (lev > maxLeverageUsed) maxLeverageUsed = lev;
  }

  const marginUtilization = totalEquity > 0 ? (totalMarginUsed / totalEquity) * 100 : 0;

  // Resolve effective limits (min of USD and % of equity)
  const effDrawdown = effectiveLimit(lim.maxDrawdownUsd, lim.maxDrawdownPct, totalEquity);
  const effPosition = effectiveLimit(lim.maxPositionUsd, lim.maxPositionPct, totalEquity);
  const effExposure = effectiveLimit(lim.maxTotalExposureUsd, lim.maxExposurePct, totalEquity);

  // Check violations
  if (totalUnrealizedPnl < -effDrawdown) {
    violations.push({
      rule: "max_drawdown",
      severity: "critical",
      message: `Unrealized loss $${Math.abs(totalUnrealizedPnl).toFixed(2)} exceeds max drawdown $${effDrawdown.toFixed(2)}${lim.maxDrawdownPct != null ? ` (${lim.maxDrawdownPct}% of equity)` : ""}`,
      current: Math.abs(totalUnrealizedPnl),
      limit: effDrawdown,
    });
  }

  if (largestPositionUsd > effPosition) {
    violations.push({
      rule: "max_position_size",
      severity: "high",
      message: `Largest position $${largestPositionUsd.toFixed(2)} exceeds limit $${effPosition.toFixed(2)}${lim.maxPositionPct != null ? ` (${lim.maxPositionPct}% of equity)` : ""}`,
      current: largestPositionUsd,
      limit: effPosition,
    });
  }

  if (totalExposure > effExposure) {
    violations.push({
      rule: "max_total_exposure",
      severity: "high",
      message: `Total exposure $${totalExposure.toFixed(2)} exceeds limit $${effExposure.toFixed(2)}${lim.maxExposurePct != null ? ` (${lim.maxExposurePct}% of equity)` : ""}`,
      current: totalExposure,
      limit: effExposure,
    });
  }

  if (positions.length > lim.maxPositions) {
    violations.push({
      rule: "max_positions",
      severity: "medium",
      message: `${positions.length} positions exceeds limit of ${lim.maxPositions}`,
      current: positions.length,
      limit: lim.maxPositions,
    });
  }

  if (maxLeverageUsed > lim.maxLeverage) {
    violations.push({
      rule: "max_leverage",
      severity: "high",
      message: `Leverage ${maxLeverageUsed}x exceeds limit ${lim.maxLeverage}x`,
      current: maxLeverageUsed,
      limit: lim.maxLeverage,
    });
  }

  if (marginUtilization > lim.maxMarginUtilization) {
    violations.push({
      rule: "max_margin_utilization",
      severity: marginUtilization > 90 ? "critical" : "high",
      message: `Margin utilization ${marginUtilization.toFixed(1)}% exceeds limit ${lim.maxMarginUtilization}%`,
      current: marginUtilization,
      limit: lim.maxMarginUtilization,
    });
  }

  // Check liquidation distances
  const liquidationDistances = getLiquidationDistances(positions, lim);
  let minLiquidationDistancePct = Infinity;

  for (const ld of liquidationDistances) {
    if (ld.distancePct < minLiquidationDistancePct) {
      minLiquidationDistancePct = ld.distancePct;
    }
    if (ld.distancePct < lim.minLiquidationDistance) {
      violations.push({
        rule: "min_liquidation_distance",
        severity: "high",
        message: `${ld.exchange}:${ld.symbol} is ${ld.distancePct.toFixed(1)}% from liquidation (limit: ${lim.minLiquidationDistance}%)`,
        current: ld.distancePct,
        limit: lim.minLiquidationDistance,
      });
    }
  }

  if (minLiquidationDistancePct === Infinity) minLiquidationDistancePct = -1; // no positions

  // Determine overall risk level
  let level: RiskLevel = "low";
  if (violations.some(v => v.severity === "critical")) level = "critical";
  else if (violations.some(v => v.severity === "high")) level = "high";
  else if (violations.some(v => v.severity === "medium")) level = "medium";

  // Can trade only if no critical violations
  const canTrade = !violations.some(v => v.severity === "critical");

  return {
    level,
    violations,
    metrics: {
      totalEquity,
      totalUnrealizedPnl,
      totalMarginUsed,
      totalExposure,
      positionCount: positions.length,
      marginUtilization,
      largestPositionUsd,
      maxLeverageUsed,
      minLiquidationDistancePct,
    },
    liquidationDistances,
    limits: lim,
    canTrade,
  };
}

/** Pre-trade check: would this new order violate risk limits? */
export function preTradeCheck(
  assessment: RiskAssessment,
  newOrderNotional: number,
  newOrderLeverage: number,
): { allowed: boolean; reason?: string } {
  if (!assessment.canTrade) {
    return { allowed: false, reason: "Trading suspended: critical risk violation active" };
  }

  const lim = assessment.limits;
  const equity = assessment.metrics.totalEquity;
  const effPosition = effectiveLimit(lim.maxPositionUsd, lim.maxPositionPct, equity);
  const effExposure = effectiveLimit(lim.maxTotalExposureUsd, lim.maxExposurePct, equity);

  if (newOrderNotional > effPosition) {
    return { allowed: false, reason: `Order notional $${newOrderNotional.toFixed(0)} exceeds max position size $${effPosition.toFixed(0)}${lim.maxPositionPct != null ? ` (${lim.maxPositionPct}% of $${equity.toFixed(0)} equity)` : ""}` };
  }

  if (assessment.metrics.totalExposure + newOrderNotional > effExposure) {
    return { allowed: false, reason: `Would exceed total exposure limit ($${(assessment.metrics.totalExposure + newOrderNotional).toFixed(0)} > $${effExposure.toFixed(0)})` };
  }

  if (assessment.metrics.positionCount + 1 > lim.maxPositions) {
    return { allowed: false, reason: `Would exceed max positions (${assessment.metrics.positionCount + 1} > ${lim.maxPositions})` };
  }

  if (newOrderLeverage > lim.maxLeverage) {
    return { allowed: false, reason: `Leverage ${newOrderLeverage}x exceeds max ${lim.maxLeverage}x` };
  }

  return { allowed: true };
}
