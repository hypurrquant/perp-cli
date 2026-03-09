import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { ExchangeAdapter, ExchangeBalance, ExchangePosition } from "./exchanges/interface.js";

// ── Risk Configuration ──

export interface RiskLimits {
  maxDrawdownUsd: number;       // close all if uPnL below this (default 500)
  maxPositionUsd: number;       // max single position notional (default 5000)
  maxTotalExposureUsd: number;  // max total notional across all positions (default 20000)
  dailyLossLimitUsd: number;    // stop trading if daily realized loss exceeds this (default 200)
  maxPositions: number;         // max number of simultaneous positions (default 10)
  maxLeverage: number;          // max leverage per position (default 20)
  maxMarginUtilization: number; // max margin/equity ratio % (default 80)
}

const DEFAULT_LIMITS: RiskLimits = {
  maxDrawdownUsd: 500,
  maxPositionUsd: 5000,
  maxTotalExposureUsd: 20000,
  dailyLossLimitUsd: 200,
  maxPositions: 10,
  maxLeverage: 20,
  maxMarginUtilization: 80,
};

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
  };
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

  // Check violations
  if (totalUnrealizedPnl < -lim.maxDrawdownUsd) {
    violations.push({
      rule: "max_drawdown",
      severity: "critical",
      message: `Unrealized loss $${Math.abs(totalUnrealizedPnl).toFixed(2)} exceeds max drawdown $${lim.maxDrawdownUsd}`,
      current: Math.abs(totalUnrealizedPnl),
      limit: lim.maxDrawdownUsd,
    });
  }

  if (largestPositionUsd > lim.maxPositionUsd) {
    violations.push({
      rule: "max_position_size",
      severity: "high",
      message: `Largest position $${largestPositionUsd.toFixed(2)} exceeds limit $${lim.maxPositionUsd}`,
      current: largestPositionUsd,
      limit: lim.maxPositionUsd,
    });
  }

  if (totalExposure > lim.maxTotalExposureUsd) {
    violations.push({
      rule: "max_total_exposure",
      severity: "high",
      message: `Total exposure $${totalExposure.toFixed(2)} exceeds limit $${lim.maxTotalExposureUsd}`,
      current: totalExposure,
      limit: lim.maxTotalExposureUsd,
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
    },
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

  if (newOrderNotional > lim.maxPositionUsd) {
    return { allowed: false, reason: `Order notional $${newOrderNotional.toFixed(0)} exceeds max position size $${lim.maxPositionUsd}` };
  }

  if (assessment.metrics.totalExposure + newOrderNotional > lim.maxTotalExposureUsd) {
    return { allowed: false, reason: `Would exceed total exposure limit ($${(assessment.metrics.totalExposure + newOrderNotional).toFixed(0)} > $${lim.maxTotalExposureUsd})` };
  }

  if (assessment.metrics.positionCount + 1 > lim.maxPositions) {
    return { allowed: false, reason: `Would exceed max positions (${assessment.metrics.positionCount + 1} > ${lim.maxPositions})` };
  }

  if (newOrderLeverage > lim.maxLeverage) {
    return { allowed: false, reason: `Leverage ${newOrderLeverage}x exceeds max ${lim.maxLeverage}x` };
  }

  return { allowed: true };
}
