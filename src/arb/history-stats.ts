/**
 * Enhanced arb history statistics: exchange pair performance,
 * time-of-day analysis, and optimal hold time calculation.
 */

export interface ArbTradeForStats {
  symbol: string;
  exchanges: string; // e.g., "hyperliquid+pacifica"
  entryDate: string; // ISO
  exitDate: string | null;
  holdDurationMs: number;
  entrySpread: number | null;
  exitSpread: number | null;
  netReturn: number;
  status: "completed" | "open" | "failed";
}

export interface ExchangePairPerf {
  pair: string; // e.g., "HL/PAC"
  trades: number;
  winRate: number;
  avgNetPnl: number;
  avgHoldTime: string;
  avgHoldTimeMs: number;
}

export interface TimeOfDayPerf {
  bucket: string; // e.g., "00-04 UTC"
  trades: number;
  winRate: number;
  avgNetPnl: number;
}

export interface EnhancedHistoryStats {
  avgEntrySpread: number;
  avgExitSpread: number;
  avgSpreadDecay: number; // percentage points of decay
  byExchangePair: ExchangePairPerf[];
  byTimeOfDay: TimeOfDayPerf[];
  optimalHoldTime: string | null;
  optimalHoldTimeMs: number | null;
}

const EXCHANGE_ABBREVS: Record<string, string> = {
  hyperliquid: "HL",
  pacifica: "PAC",
  lighter: "LT",
};

function abbrevExchange(name: string): string {
  return EXCHANGE_ABBREVS[name.toLowerCase()] ?? name.toUpperCase().slice(0, 3);
}

/** Normalize exchange pair string to a short abbreviation like "HL/PAC" */
export function normalizeExchangePair(exchanges: string): string {
  // exchanges format: "hyperliquid+pacifica" or "lighter+hyperliquid"
  const parts = exchanges.split("+").map(e => abbrevExchange(e.trim()));
  parts.sort(); // alphabetical for consistency
  return parts.join("/");
}

/** Get 4-hour UTC time bucket for a timestamp */
export function getTimeBucket(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const hour = date.getUTCHours();
  const bucketStart = Math.floor(hour / 4) * 4;
  const bucketEnd = bucketStart + 4;
  return `${String(bucketStart).padStart(2, "0")}-${String(bucketEnd).padStart(2, "0")} UTC`;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return `${days}d ${remainingHours}h`;
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(ms / (1000 * 60));
  return `${minutes}m`;
}

/** Compute enhanced statistics from a list of trades */
export function computeEnhancedStats(trades: ArbTradeForStats[]): EnhancedHistoryStats {
  const completed = trades.filter(t => t.status === "completed");

  // Average entry/exit spreads
  const entrySpreads = completed
    .map(t => t.entrySpread)
    .filter((s): s is number => s !== null);
  const exitSpreads = completed
    .map(t => t.exitSpread)
    .filter((s): s is number => s !== null);

  const avgEntrySpread = entrySpreads.length > 0
    ? entrySpreads.reduce((s, v) => s + v, 0) / entrySpreads.length
    : 0;
  const avgExitSpread = exitSpreads.length > 0
    ? exitSpreads.reduce((s, v) => s + v, 0) / exitSpreads.length
    : 0;

  // Average spread decay: how much spread typically decays from entry to exit
  const spreadDecays: number[] = [];
  for (const t of completed) {
    if (t.entrySpread !== null && t.exitSpread !== null) {
      spreadDecays.push(t.entrySpread - t.exitSpread);
    }
  }
  const avgSpreadDecay = spreadDecays.length > 0
    ? spreadDecays.reduce((s, v) => s + v, 0) / spreadDecays.length
    : 0;

  // ── By Exchange Pair ──
  const pairMap = new Map<string, ArbTradeForStats[]>();
  for (const t of completed) {
    const pair = normalizeExchangePair(t.exchanges);
    if (!pairMap.has(pair)) pairMap.set(pair, []);
    pairMap.get(pair)!.push(t);
  }

  const byExchangePair: ExchangePairPerf[] = [];
  for (const [pair, pairTrades] of pairMap) {
    const wins = pairTrades.filter(t => t.netReturn > 0).length;
    const avgPnl = pairTrades.reduce((s, t) => s + t.netReturn, 0) / pairTrades.length;
    const avgHoldMs = pairTrades.reduce((s, t) => s + t.holdDurationMs, 0) / pairTrades.length;
    byExchangePair.push({
      pair,
      trades: pairTrades.length,
      winRate: (wins / pairTrades.length) * 100,
      avgNetPnl: avgPnl,
      avgHoldTime: formatDuration(avgHoldMs),
      avgHoldTimeMs: avgHoldMs,
    });
  }
  // Sort by trade count descending
  byExchangePair.sort((a, b) => b.trades - a.trades);

  // ── By Time of Day ──
  const bucketMap = new Map<string, ArbTradeForStats[]>();
  for (const t of completed) {
    const bucket = getTimeBucket(t.entryDate);
    if (!bucketMap.has(bucket)) bucketMap.set(bucket, []);
    bucketMap.get(bucket)!.push(t);
  }

  const byTimeOfDay: TimeOfDayPerf[] = [];
  // Ensure all 6 buckets are represented (even if empty) for completeness
  const allBuckets = ["00-04 UTC", "04-08 UTC", "08-12 UTC", "12-16 UTC", "16-20 UTC", "20-24 UTC"];
  for (const bucket of allBuckets) {
    const bucketTrades = bucketMap.get(bucket) ?? [];
    if (bucketTrades.length === 0) continue; // skip empty buckets in output
    const wins = bucketTrades.filter(t => t.netReturn > 0).length;
    const avgPnl = bucketTrades.reduce((s, t) => s + t.netReturn, 0) / bucketTrades.length;
    byTimeOfDay.push({
      bucket,
      trades: bucketTrades.length,
      winRate: (wins / bucketTrades.length) * 100,
      avgNetPnl: avgPnl,
    });
  }

  // ── Optimal Hold Time ──
  // Median hold time of profitable completed trades
  const profitableHoldTimes = completed
    .filter(t => t.netReturn > 0)
    .map(t => t.holdDurationMs)
    .sort((a, b) => a - b);

  let optimalHoldTimeMs: number | null = null;
  if (profitableHoldTimes.length > 0) {
    const mid = Math.floor(profitableHoldTimes.length / 2);
    optimalHoldTimeMs = profitableHoldTimes.length % 2 === 0
      ? (profitableHoldTimes[mid - 1] + profitableHoldTimes[mid]) / 2
      : profitableHoldTimes[mid];
  }

  return {
    avgEntrySpread,
    avgExitSpread,
    avgSpreadDecay,
    byExchangePair,
    byTimeOfDay,
    optimalHoldTime: optimalHoldTimeMs !== null ? formatDuration(optimalHoldTimeMs) : null,
    optimalHoldTimeMs,
  };
}
