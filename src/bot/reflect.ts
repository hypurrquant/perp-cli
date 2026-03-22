/**
 * REFLECT: Performance analysis + auto-parameter adjustment
 * Metrics: win rate, avg win/loss, fee drag ratio, direction split, holding periods
 * Auto-adjust: within guardrail bounds (e.g., spread ±20%, size ±30%)
 */

import type { JournalEntry } from "./trade-journal.js";

export interface ReflectReport {
  period: { from: number; to: number; days: number };
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  feeDragRatio: number;
  directionSplit: { long: number; short: number };
  avgHoldingPeriodMs: number;
  bestStrategy: string;
  worstStrategy: string;
  suggestions: string[];
}

export function analyzePerformance(entries: JournalEntry[], periodDays = 30): ReflectReport {
  const now = Date.now();
  const from = now - periodDays * 24 * 60 * 60 * 1000;
  const to = now;

  const inPeriod = entries.filter((e) => e.timestamp >= from && e.timestamp <= to);

  if (inPeriod.length === 0) {
    return {
      period: { from, to, days: periodDays },
      totalTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      feeDragRatio: 0,
      directionSplit: { long: 0, short: 0 },
      avgHoldingPeriodMs: 0,
      bestStrategy: "",
      worstStrategy: "",
      suggestions: ["No trades in the selected period."],
    };
  }

  // PnL-based metrics (only entries with pnl defined)
  const withPnl = inPeriod.filter((e) => e.pnl !== undefined);
  const wins = withPnl.filter((e) => (e.pnl ?? 0) > 0);
  const losses = withPnl.filter((e) => (e.pnl ?? 0) <= 0);

  const winRate = withPnl.length > 0 ? wins.length / withPnl.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, e) => s + (e.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, e) => s + (e.pnl ?? 0), 0) / losses.length : 0;

  const totalGross = wins.reduce((s, e) => s + (e.pnl ?? 0), 0);
  const totalLoss = Math.abs(losses.reduce((s, e) => s + (e.pnl ?? 0), 0));
  const profitFactor = totalLoss > 0 ? totalGross / totalLoss : totalGross > 0 ? Infinity : 0;

  // Fee drag: total fees / gross profit
  const totalFees = inPeriod.reduce((s, e) => s + (e.fees ?? 0), 0);
  const feeDragRatio = totalGross > 0 ? totalFees / totalGross : 0;

  // Direction split
  const longs = inPeriod.filter((e) => e.side === "buy").length;
  const shorts = inPeriod.filter((e) => e.side === "sell").length;
  const total = inPeriod.length;
  const directionSplit = {
    long: total > 0 ? longs / total : 0,
    short: total > 0 ? shorts / total : 0,
  };

  // Holding period
  const withHolding = inPeriod.filter((e) => e.holdingPeriodMs !== undefined);
  const avgHoldingPeriodMs =
    withHolding.length > 0
      ? withHolding.reduce((s, e) => s + (e.holdingPeriodMs ?? 0), 0) / withHolding.length
      : 0;

  // Per-strategy PnL
  const strategyPnl: Map<string, number> = new Map();
  for (const e of withPnl) {
    strategyPnl.set(e.strategy, (strategyPnl.get(e.strategy) ?? 0) + (e.pnl ?? 0));
  }

  let bestStrategy = "";
  let worstStrategy = "";
  if (strategyPnl.size > 0) {
    let bestPnl = -Infinity;
    let worstPnl = Infinity;
    for (const [strat, pnl] of strategyPnl) {
      if (pnl > bestPnl) { bestPnl = pnl; bestStrategy = strat; }
      if (pnl < worstPnl) { worstPnl = pnl; worstStrategy = strat; }
    }
  }

  const suggestions = buildSuggestions({ winRate, avgWin, avgLoss, profitFactor, feeDragRatio, directionSplit, avgHoldingPeriodMs, totalTrades: inPeriod.length });

  return {
    period: { from, to, days: periodDays },
    totalTrades: inPeriod.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    feeDragRatio,
    directionSplit,
    avgHoldingPeriodMs,
    bestStrategy,
    worstStrategy,
    suggestions,
  };
}

function buildSuggestions(metrics: {
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  feeDragRatio: number;
  directionSplit: { long: number; short: number };
  avgHoldingPeriodMs: number;
  totalTrades: number;
}): string[] {
  const suggestions: string[] = [];

  if (metrics.winRate < 0.4) {
    suggestions.push("Win rate below 40% — consider tightening entry conditions or widening spread.");
  }
  if (metrics.profitFactor < 1.0 && metrics.totalTrades >= 10) {
    suggestions.push("Profit factor below 1.0 — strategy is net losing; review sizing or stop-loss levels.");
  }
  if (metrics.feeDragRatio > 0.3) {
    suggestions.push("Fee drag exceeds 30% of gross profit — reduce order frequency or increase minimum profit threshold.");
  }
  if (metrics.avgWin > 0 && metrics.avgLoss < 0 && Math.abs(metrics.avgLoss) > metrics.avgWin * 2) {
    suggestions.push("Average loss is more than 2× average win — improve risk/reward ratio or tighten stop-loss.");
  }
  if (metrics.directionSplit.long > 0.8) {
    suggestions.push("Strategy is heavily long-biased (>80%) — consider hedging short exposure.");
  }
  if (metrics.directionSplit.short > 0.8) {
    suggestions.push("Strategy is heavily short-biased (>80%) — verify market regime alignment.");
  }
  if (metrics.avgHoldingPeriodMs > 24 * 60 * 60 * 1000) {
    suggestions.push("Average holding period exceeds 24h — review if overnight risk is compensated.");
  }
  if (suggestions.length === 0) {
    suggestions.push("Performance looks healthy. Keep monitoring.");
  }

  return suggestions;
}

export function suggestAdjustments(
  report: ReflectReport,
): { param: string; current: number; suggested: number; reason: string }[] {
  const adjustments: { param: string; current: number; suggested: number; reason: string }[] = [];

  // Spread adjustment: tighten if win rate is high, widen if low
  if (report.winRate < 0.4 && report.totalTrades >= 10) {
    adjustments.push({
      param: "spread_bps",
      current: 10,
      suggested: Math.round(10 * 1.2), // +20% guardrail
      reason: "Low win rate — widening spread to improve fill quality.",
    });
  } else if (report.winRate > 0.65 && report.profitFactor > 1.5) {
    adjustments.push({
      param: "spread_bps",
      current: 10,
      suggested: Math.round(10 * 0.8), // -20% guardrail
      reason: "Strong win rate — tightening spread to capture more flow.",
    });
  }

  // Size adjustment: reduce if fee drag is high or profit factor < 1
  if (report.feeDragRatio > 0.3 || report.profitFactor < 1.0) {
    adjustments.push({
      param: "size_usd",
      current: 100,
      suggested: Math.round(100 * 0.7), // -30% guardrail
      reason: "High fee drag or negative profit factor — reducing size to limit losses.",
    });
  } else if (report.profitFactor > 2.0 && report.winRate > 0.55) {
    adjustments.push({
      param: "size_usd",
      current: 100,
      suggested: Math.round(100 * 1.3), // +30% guardrail
      reason: "Strong performance — scaling up size within guardrail bounds.",
    });
  }

  return adjustments;
}
