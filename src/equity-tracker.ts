/**
 * Equity Tracker — time-series equity snapshots for PnL analysis.
 *
 * Stores snapshots in ~/.perp/equity-history/YYYY-MM.jsonl (monthly files).
 * Computes daily PnL, Sharpe ratio, max drawdown, win/loss stats.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, appendFileSync, existsSync, readdirSync, readFileSync } from "fs";

const BASE_DIR = join(homedir(), ".perp", "equity-history");

export interface EquitySnapshot {
  ts: string;         // ISO timestamp
  exchange: string;
  equity: number;
  available: number;
  marginUsed: number;
  unrealizedPnl: number;
  positionCount: number;
}

export interface DailyPnl {
  date: string;        // YYYY-MM-DD
  exchange: string;
  startEquity: number;
  endEquity: number;
  pnl: number;
  pnlPct: number;
}

export interface PnlMetrics {
  totalReturn: number;
  totalReturnPct: number;
  dailyReturns: DailyPnl[];
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  winDays: number;
  lossDays: number;
  winRate: number;
  peakEquity: number;
  currentDrawdown: number;
  currentDrawdownPct: number;
  bestDay: DailyPnl | null;
  worstDay: DailyPnl | null;
  avgDailyPnl: number;
  period: { from: string; to: string; days: number };
}

// ── Storage ──

function getFilePath(date: Date): string {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return join(BASE_DIR, `${ym}.jsonl`);
}

export function saveEquitySnapshot(snap: EquitySnapshot): void {
  mkdirSync(BASE_DIR, { recursive: true });
  const file = getFilePath(new Date(snap.ts));
  appendFileSync(file, JSON.stringify(snap) + "\n");
}

export function readEquityHistory(opts?: {
  exchange?: string;
  since?: Date;
  until?: Date;
}): EquitySnapshot[] {
  if (!existsSync(BASE_DIR)) return [];

  const files = readdirSync(BASE_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .sort();

  const results: EquitySnapshot[] = [];
  for (const file of files) {
    // Skip files clearly before range by filename (YYYY-MM.jsonl)
    if (opts?.since) {
      const ym = file.replace(".jsonl", "");
      const fileMonth = new Date(ym + "-01");
      const sinceMonth = new Date(opts.since.getFullYear(), opts.since.getMonth(), 1);
      if (fileMonth < sinceMonth) continue;
    }

    const content = readFileSync(join(BASE_DIR, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line) as EquitySnapshot;
        if (opts?.exchange && snap.exchange !== opts.exchange) continue;
        const ts = new Date(snap.ts);
        if (opts?.since && ts < opts.since) continue;
        if (opts?.until && ts > opts.until) continue;
        results.push(snap);
      } catch { /* skip malformed lines */ }
    }
  }
  return results;
}

// ── Analysis ──

/** Group snapshots by date, take first and last per day for daily PnL. */
export function computeDailyPnl(snapshots: EquitySnapshot[], exchange?: string): DailyPnl[] {
  // If exchange filter provided, apply it
  const filtered = exchange
    ? snapshots.filter(s => s.exchange === exchange)
    : snapshots;

  // Aggregate across exchanges if no specific exchange requested
  const byTimestamp = new Map<string, number>();
  for (const s of filtered) {
    const key = s.ts;
    byTimestamp.set(key, (byTimestamp.get(key) ?? 0) + s.equity);
  }

  // Group by date
  const byDate = new Map<string, { first: { ts: string; eq: number }; last: { ts: string; eq: number } }>();
  for (const s of filtered) {
    const date = s.ts.slice(0, 10); // YYYY-MM-DD
    const eq = exchange ? s.equity : (byTimestamp.get(s.ts) ?? s.equity);
    const existing = byDate.get(date);
    if (!existing) {
      byDate.set(date, { first: { ts: s.ts, eq }, last: { ts: s.ts, eq } });
    } else {
      if (s.ts < existing.first.ts) existing.first = { ts: s.ts, eq };
      if (s.ts > existing.last.ts) existing.last = { ts: s.ts, eq };
    }
  }

  const daily: DailyPnl[] = [];
  const dates = [...byDate.keys()].sort();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const day = byDate.get(date)!;
    // Use previous day's end as start, or this day's first if no prev
    const startEquity = i > 0 ? byDate.get(dates[i - 1])!.last.eq : day.first.eq;
    const endEquity = day.last.eq;
    const pnl = endEquity - startEquity;
    const pnlPct = startEquity > 0 ? (pnl / startEquity) * 100 : 0;
    daily.push({
      date,
      exchange: exchange ?? "all",
      startEquity,
      endEquity,
      pnl,
      pnlPct,
    });
  }
  return daily;
}

/** Compute comprehensive PnL metrics from equity snapshots. */
export function computePnlMetrics(snapshots: EquitySnapshot[], exchange?: string): PnlMetrics {
  const daily = computeDailyPnl(snapshots, exchange);

  if (daily.length === 0) {
    return {
      totalReturn: 0, totalReturnPct: 0, dailyReturns: [],
      sharpeRatio: 0, maxDrawdown: 0, maxDrawdownPct: 0,
      winDays: 0, lossDays: 0, winRate: 0,
      peakEquity: 0, currentDrawdown: 0, currentDrawdownPct: 0,
      bestDay: null, worstDay: null, avgDailyPnl: 0,
      period: { from: "", to: "", days: 0 },
    };
  }

  const firstEquity = daily[0].startEquity;
  const lastEquity = daily[daily.length - 1].endEquity;
  const totalReturn = lastEquity - firstEquity;
  const totalReturnPct = firstEquity > 0 ? (totalReturn / firstEquity) * 100 : 0;

  // Win/loss stats
  const winDays = daily.filter(d => d.pnl > 0).length;
  const lossDays = daily.filter(d => d.pnl < 0).length;
  const winRate = daily.length > 0 ? (winDays / daily.length) * 100 : 0;

  // Best/worst day
  const bestDay = daily.reduce((a, b) => (b.pnl > a.pnl ? b : a), daily[0]);
  const worstDay = daily.reduce((a, b) => (b.pnl < a.pnl ? b : a), daily[0]);

  // Average daily PnL
  const avgDailyPnl = daily.reduce((sum, d) => sum + d.pnl, 0) / daily.length;

  // Sharpe ratio (annualized, assuming 365 trading days for crypto)
  const dailyReturns = daily.map(d => d.pnlPct / 100);
  const meanReturn = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(365) : 0;

  // Max drawdown
  let peakEquity = 0;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const d of daily) {
    if (d.endEquity > peakEquity) peakEquity = d.endEquity;
    const dd = peakEquity - d.endEquity;
    const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = ddPct;
    }
  }
  const currentDrawdown = peakEquity - lastEquity;
  const currentDrawdownPct = peakEquity > 0 ? (currentDrawdown / peakEquity) * 100 : 0;

  return {
    totalReturn,
    totalReturnPct,
    dailyReturns: daily,
    sharpeRatio,
    maxDrawdown,
    maxDrawdownPct,
    winDays,
    lossDays,
    winRate,
    peakEquity,
    currentDrawdown,
    currentDrawdownPct,
    bestDay,
    worstDay,
    avgDailyPnl,
    period: {
      from: daily[0].date,
      to: daily[daily.length - 1].date,
      days: daily.length,
    },
  };
}

/** Compute weekly PnL from daily PnL data. */
export function aggregateWeekly(daily: DailyPnl[]): DailyPnl[] {
  if (daily.length === 0) return [];

  const weeks = new Map<string, { start: DailyPnl; end: DailyPnl }>();
  for (const d of daily) {
    // ISO week start (Monday)
    const dt = new Date(d.date);
    const day = dt.getDay();
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - ((day + 6) % 7));
    const weekKey = monday.toISOString().slice(0, 10);

    const existing = weeks.get(weekKey);
    if (!existing) {
      weeks.set(weekKey, { start: d, end: d });
    } else {
      if (d.date < existing.start.date) existing.start = d;
      if (d.date > existing.end.date) existing.end = d;
    }
  }

  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, { start, end }]) => ({
    date: weekStart,
    exchange: start.exchange,
    startEquity: start.startEquity,
    endEquity: end.endEquity,
    pnl: end.endEquity - start.startEquity,
    pnlPct: start.startEquity > 0 ? ((end.endEquity - start.startEquity) / start.startEquity) * 100 : 0,
  }));
}
