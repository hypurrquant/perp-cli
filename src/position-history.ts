/**
 * Position history — persists position lifecycle events to ~/.perp/positions.jsonl
 * Enables agents to review past trades, analyze P&L, and learn from history.
 */

import { existsSync, appendFileSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { StreamEvent } from "./event-stream.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const POSITIONS_FILE = resolve(PERP_DIR, "positions.jsonl");

export interface PositionRecord {
  id: string;                    // unique per open→close cycle
  exchange: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: string;
  exitPrice?: string;
  size: string;
  realizedPnl?: string;
  unrealizedPnl?: string;
  openedAt: string;              // ISO timestamp
  closedAt?: string;             // ISO timestamp
  updatedAt: string;
  status: "open" | "closed" | "updated";
  duration?: number;             // ms from open to close
  meta?: Record<string, unknown>;
}

export interface PositionStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
  avgDuration: number;
  longestTrade: number;
  shortestTrade: number;
  bySymbol: Record<string, { trades: number; pnl: number; winRate: number }>;
  byExchange: Record<string, { trades: number; pnl: number }>;
}

function ensureDir() {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append a position record to the log */
export function logPosition(record: PositionRecord): void {
  ensureDir();
  appendFileSync(POSITIONS_FILE, JSON.stringify(record) + "\n", { mode: 0o600 });
}

/** Read position history with optional filters */
export function readPositionHistory(opts?: {
  symbol?: string;
  exchange?: string;
  status?: string;
  limit?: number;
  since?: string;
}): PositionRecord[] {
  if (!existsSync(POSITIONS_FILE)) return [];

  const lines = readFileSync(POSITIONS_FILE, "utf-8").trim().split("\n").filter(Boolean);
  let records: PositionRecord[] = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  // Apply filters
  if (opts?.exchange) {
    records = records.filter(r => r.exchange === opts.exchange);
  }
  if (opts?.symbol) {
    records = records.filter(r => r.symbol.toUpperCase().includes(opts.symbol!.toUpperCase()));
  }
  if (opts?.status) {
    records = records.filter(r => r.status === opts.status);
  }
  if (opts?.since) {
    const sinceDate = new Date(opts.since).getTime();
    records = records.filter(r => new Date(r.updatedAt).getTime() >= sinceDate);
  }

  // Sort newest first
  records.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  // Limit
  if (opts?.limit) {
    records = records.slice(0, opts.limit);
  }

  return records;
}

/** Compute aggregate stats from closed position records */
export function getPositionStats(opts?: {
  exchange?: string;
  since?: string;
}): PositionStats {
  const records = readPositionHistory({
    exchange: opts?.exchange,
    status: "closed",
    since: opts?.since,
  });

  const stats: PositionStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalPnl: 0,
    avgPnl: 0,
    bestTrade: 0,
    worstTrade: 0,
    avgDuration: 0,
    longestTrade: 0,
    shortestTrade: Infinity,
    bySymbol: {},
    byExchange: {},
  };

  if (records.length === 0) {
    stats.shortestTrade = 0;
    return stats;
  }

  let totalDuration = 0;
  let durationCount = 0;

  for (const r of records) {
    stats.totalTrades++;
    const pnl = Number(r.realizedPnl ?? 0);

    if (pnl > 0) stats.wins++;
    else if (pnl < 0) stats.losses++;

    stats.totalPnl += pnl;
    if (pnl > stats.bestTrade) stats.bestTrade = pnl;
    if (pnl < stats.worstTrade) stats.worstTrade = pnl;

    if (r.duration !== undefined && r.duration > 0) {
      totalDuration += r.duration;
      durationCount++;
      if (r.duration > stats.longestTrade) stats.longestTrade = r.duration;
      if (r.duration < stats.shortestTrade) stats.shortestTrade = r.duration;
    }

    // By symbol
    if (!stats.bySymbol[r.symbol]) {
      stats.bySymbol[r.symbol] = { trades: 0, pnl: 0, winRate: 0 };
    }
    stats.bySymbol[r.symbol].trades++;
    stats.bySymbol[r.symbol].pnl += pnl;

    // By exchange
    if (!stats.byExchange[r.exchange]) {
      stats.byExchange[r.exchange] = { trades: 0, pnl: 0 };
    }
    stats.byExchange[r.exchange].trades++;
    stats.byExchange[r.exchange].pnl += pnl;
  }

  stats.winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0;
  stats.avgPnl = stats.totalTrades > 0 ? stats.totalPnl / stats.totalTrades : 0;
  stats.avgDuration = durationCount > 0 ? totalDuration / durationCount : 0;

  if (stats.shortestTrade === Infinity) stats.shortestTrade = 0;

  // Compute per-symbol win rates
  // We need to recount wins per symbol from the records
  const symbolWins: Record<string, number> = {};
  for (const r of records) {
    const pnl = Number(r.realizedPnl ?? 0);
    if (pnl > 0) {
      symbolWins[r.symbol] = (symbolWins[r.symbol] ?? 0) + 1;
    }
  }
  for (const sym of Object.keys(stats.bySymbol)) {
    const wins = symbolWins[sym] ?? 0;
    stats.bySymbol[sym].winRate = stats.bySymbol[sym].trades > 0
      ? (wins / stats.bySymbol[sym].trades) * 100
      : 0;
  }

  return stats;
}

/**
 * Returns a wrapper around the event callback that intercepts position events
 * and logs them to the position history file.
 *
 * Usage:
 *   const loggedOnEvent = attachPositionLogger(originalOnEvent);
 *   startEventStream(adapter, { onEvent: loggedOnEvent, ... });
 */
export function attachPositionLogger(
  onEvent: (event: StreamEvent) => void,
): (event: StreamEvent) => void {
  // Track open positions to compute duration on close
  const openPositions = new Map<string, { id: string; openedAt: string; entryPrice: string }>();

  return (event: StreamEvent) => {
    const ts = event.timestamp;
    const exchange = event.exchange;
    const data = event.data;

    if (event.type === "position_opened") {
      const id = genId();
      const symbol = String(data.symbol ?? "");
      const side = String(data.side ?? "long") as "long" | "short";
      const key = `${exchange}:${symbol}`;

      openPositions.set(key, { id, openedAt: ts, entryPrice: String(data.entryPrice ?? "") });

      logPosition({
        id,
        exchange,
        symbol,
        side,
        entryPrice: String(data.entryPrice ?? ""),
        size: String(data.size ?? ""),
        unrealizedPnl: String(data.unrealizedPnl ?? ""),
        openedAt: ts,
        updatedAt: ts,
        status: "open",
      });
    } else if (event.type === "position_updated") {
      const symbol = String(data.symbol ?? "");
      const side = String(data.side ?? "long") as "long" | "short";
      const key = `${exchange}:${symbol}`;
      const tracked = openPositions.get(key);

      logPosition({
        id: tracked?.id ?? genId(),
        exchange,
        symbol,
        side,
        entryPrice: String(data.entryPrice ?? tracked?.entryPrice ?? ""),
        size: String(data.size ?? ""),
        unrealizedPnl: String(data.unrealizedPnl ?? ""),
        openedAt: tracked?.openedAt ?? ts,
        updatedAt: ts,
        status: "updated",
        meta: {
          prevSize: data.prevSize,
          prevSide: data.prevSide,
        },
      });
    } else if (event.type === "position_closed") {
      const symbol = String(data.symbol ?? "");
      const side = String(data.side ?? "long") as "long" | "short";
      const key = `${exchange}:${symbol}`;
      const tracked = openPositions.get(key);

      const openedAt = tracked?.openedAt ?? ts;
      const duration = new Date(ts).getTime() - new Date(openedAt).getTime();
      const realizedPnl = String(data.unrealizedPnl ?? "0");

      logPosition({
        id: tracked?.id ?? genId(),
        exchange,
        symbol,
        side,
        entryPrice: String(data.entryPrice ?? tracked?.entryPrice ?? ""),
        size: String(data.size ?? ""),
        realizedPnl,
        openedAt,
        closedAt: ts,
        updatedAt: ts,
        status: "closed",
        duration: duration > 0 ? duration : undefined,
      });

      openPositions.delete(key);
    }

    // Always forward the event to the original callback
    onEvent(event);
  };
}
