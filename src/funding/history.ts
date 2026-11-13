/**
 * Historical funding rate tracking.
 *
 * Stores funding rate snapshots as JSONL files in ~/.perp/funding-rates/
 * organized by month (YYYY-MM.jsonl). Provides averaging and trend analysis
 * over configurable time windows.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { perpPath } from "../paths.js";
import { join } from "node:path";
import type { ExchangeFundingRate } from "./rates.js";

// ── Types ──

export interface FundingHistoryEntry {
  ts: string;          // ISO timestamp
  symbol: string;      // e.g. "BTC"
  exchange: string;    // e.g. "hyperliquid"
  rate: number;        // raw funding rate
  hourlyRate: number;  // normalized to per-hour
}

export interface HistoricalAverages {
  avg1h: number | null;
  avg8h: number | null;
  avg24h: number | null;
  avg7d: number | null;
}

// ── Constants ──

function dataDir(): string { return perpPath("funding-rates"); }
const DEDUP_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const CLEANUP_MAX_AGE_DAYS = 30;

// ── Internal helpers ──

function ensureDataDir(): void {
  mkdirSync(dataDir(), { recursive: true });
}

function getMonthKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getFilePath(monthKey: string): string {
  return join(dataDir(), `${monthKey}.jsonl`);
}

/** Read all entries from a JSONL file, returning [] if file doesn't exist. */
function readJsonlFile(filePath: string): FundingHistoryEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    const entries: FundingHistoryEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as FundingHistoryEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Append entries to a JSONL file. */
function appendToJsonl(filePath: string, entries: FundingHistoryEntry[]): void {
  if (entries.length === 0) return;
  const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  try {
    // Append to existing file or create new
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    const needsNewline = existing.length > 0 && !existing.endsWith("\n");
    writeFileSync(filePath, existing + (needsNewline ? "\n" : "") + lines);
  } catch {
    // If append fails, try writing fresh
    writeFileSync(filePath, lines);
  }
}

/** Get entries across all relevant month files for a time range. */
function getEntriesInRange(startTime: Date, endTime: Date): FundingHistoryEntry[] {
  ensureDataDir();

  // Determine which month files to read
  const monthKeys = new Set<string>();
  const cur = new Date(startTime);
  while (cur <= endTime) {
    monthKeys.add(getMonthKey(cur));
    cur.setMonth(cur.getMonth() + 1);
    cur.setDate(1); // reset to 1st to avoid day overflow
  }
  // Always include the end month
  monthKeys.add(getMonthKey(endTime));

  const allEntries: FundingHistoryEntry[] = [];
  for (const key of monthKeys) {
    const filePath = getFilePath(key);
    const entries = readJsonlFile(filePath);
    for (const entry of entries) {
      const entryTime = new Date(entry.ts).getTime();
      if (entryTime >= startTime.getTime() && entryTime <= endTime.getTime()) {
        allEntries.push(entry);
      }
    }
  }

  return allEntries;
}

// ── Public API ──

/**
 * Clean up JSONL files older than 30 days.
 * Called automatically on startup / first save.
 */
let _cleanupDone = false;
export function cleanupOldFiles(): void {
  if (_cleanupDone) return;
  _cleanupDone = true;

  ensureDataDir();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CLEANUP_MAX_AGE_DAYS);
  const cutoffKey = getMonthKey(cutoff);

  try {
    const files = readdirSync(dataDir());
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const monthKey = file.replace(".jsonl", "");
      // Compare YYYY-MM strings lexicographically
      if (monthKey < cutoffKey) {
        try {
          unlinkSync(join(dataDir(), file));
        } catch {
          // ignore deletion errors
        }
      }
    }
  } catch {
    // ignore
  }
}

// Export for testing
export function _resetCleanupFlag(): void {
  _cleanupDone = false;
}

/**
 * Save current funding rates as a historical snapshot.
 * Deduplicates: skips entries if same symbol+exchange was saved within 5 minutes.
 */
export function saveFundingSnapshot(rates: ExchangeFundingRate[]): void {
  cleanupOldFiles();
  ensureDataDir();

  const now = new Date();
  const monthKey = getMonthKey(now);
  const filePath = getFilePath(monthKey);
  const ts = now.toISOString();

  // Read existing entries for dedup check (only current month file)
  const existing = readJsonlFile(filePath);

  // Build a map of latest timestamps for each symbol+exchange
  const latestTs = new Map<string, number>();
  for (const entry of existing) {
    const key = `${entry.symbol}:${entry.exchange}`;
    const entryTime = new Date(entry.ts).getTime();
    const current = latestTs.get(key) ?? 0;
    if (entryTime > current) latestTs.set(key, entryTime);
  }

  // Filter out rates that would be duplicates (within 5 min)
  const nowMs = now.getTime();
  const toSave: FundingHistoryEntry[] = [];
  for (const r of rates) {
    if (!r.symbol) continue;
    const key = `${r.symbol.toUpperCase()}:${r.exchange}`;
    const lastSaved = latestTs.get(key) ?? 0;
    if (nowMs - lastSaved < DEDUP_INTERVAL_MS) continue;

    toSave.push({
      ts,
      symbol: r.symbol.toUpperCase(),
      exchange: r.exchange,
      rate: r.fundingRate,
      hourlyRate: r.hourlyRate,
    });
  }

  appendToJsonl(filePath, toSave);
}

/**
 * Get average funding rate for a symbol+exchange over the last N hours.
 * Returns null if no data available.
 */
export function getAvgFundingRate(symbol: string, exchange: string, hours: number): number | null {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

  const entries = getEntriesInRange(startTime, endTime);
  const filtered = entries.filter(
    e => e.symbol === symbol.toUpperCase() && e.exchange === exchange.toLowerCase()
  );

  if (filtered.length === 0) return null;

  const sum = filtered.reduce((acc, e) => acc + e.hourlyRate, 0);
  return sum / filtered.length;
}

/**
 * Get all historical rates for a symbol+exchange in a time range.
 */
export function getHistoricalRates(
  symbol: string,
  exchange: string,
  startTime: Date,
  endTime: Date,
): { ts: string; rate: number; hourlyRate: number }[] {
  const entries = getEntriesInRange(startTime, endTime);
  return entries
    .filter(e => e.symbol === symbol.toUpperCase() && e.exchange === exchange.toLowerCase())
    .map(e => ({ ts: e.ts, rate: e.rate, hourlyRate: e.hourlyRate }))
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

/**
 * Get averaged rates for all symbols across time windows.
 * Returns a Map with key format "SYMBOL:exchange".
 */
export function getHistoricalAverages(
  symbols: string[],
  exchanges: string[],
): Map<string, HistoricalAverages> {
  const result = new Map<string, HistoricalAverages>();
  const now = new Date();

  // Read all entries from the last 7 days (covers all windows)
  const startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const allEntries = getEntriesInRange(startTime, now);

  // Group entries by symbol:exchange
  const grouped = new Map<string, FundingHistoryEntry[]>();
  for (const entry of allEntries) {
    const key = `${entry.symbol}:${entry.exchange}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(entry);
  }

  const windows = [
    { key: "avg1h" as const, ms: 1 * 60 * 60 * 1000 },
    { key: "avg8h" as const, ms: 8 * 60 * 60 * 1000 },
    { key: "avg24h" as const, ms: 24 * 60 * 60 * 1000 },
    { key: "avg7d" as const, ms: 7 * 24 * 60 * 60 * 1000 },
  ];

  for (const symbol of symbols) {
    for (const exchange of exchanges) {
      const key = `${symbol.toUpperCase()}:${exchange.toLowerCase()}`;
      const entries = grouped.get(key) ?? [];

      const avgs: HistoricalAverages = { avg1h: null, avg8h: null, avg24h: null, avg7d: null };

      for (const w of windows) {
        const cutoff = now.getTime() - w.ms;
        const inWindow = entries.filter(e => new Date(e.ts).getTime() >= cutoff);
        if (inWindow.length > 0) {
          const sum = inWindow.reduce((acc, e) => acc + e.hourlyRate, 0);
          avgs[w.key] = sum / inWindow.length;
        }
      }

      result.set(key, avgs);
    }
  }

  return result;
}

/**
 * Calculate effective annualized return considering compounding frequency.
 *
 * All three main exchanges (HL, PAC, LT) compound every 1h (8760 times/year).
 *
 * Formula: (1 + rate)^(8760/compoundingHours) - 1
 *
 * @param hourlyRate - the per-hour funding rate
 * @param compoundingHours - how often the exchange compounds (1 for all main exchanges)
 * @returns effective annualized return as a decimal (not percentage)
 */
export function getCompoundedAnnualReturn(hourlyRate: number, compoundingHours: number): number {
  // The rate per compounding period
  const periodRate = hourlyRate * compoundingHours;
  // Number of compounding periods per year
  const periodsPerYear = 8760 / compoundingHours;
  // Compounded annual return
  return Math.pow(1 + periodRate, periodsPerYear) - 1;
}

/**
 * Get the compounding hours for an exchange.
 * All main exchanges (HL, PAC, LT) compound every 1h.
 */
export function getExchangeCompoundingHours(exchange: string): number {
  // All main exchanges compound hourly
  return 1;
}
