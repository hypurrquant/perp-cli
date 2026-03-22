/**
 * Trade journal: JSONL-based persistent trade log
 * Stores: { timestamp, strategy, symbol, side, size, price, pnl, fees, holdingPeriod }
 * Location: ~/.perp/trade-journal.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface JournalEntry {
  timestamp: number;
  strategy: string;
  symbol: string;
  exchange: string;
  side: "buy" | "sell";
  size: string;
  entryPrice: string;
  exitPrice?: string;
  pnl?: number;
  fees?: number;
  holdingPeriodMs?: number;
  tags?: string[];
}

function journalPath(): string {
  return join(homedir(), ".perp", "trade-journal.jsonl");
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function appendJournal(entry: JournalEntry): void {
  const path = journalPath();
  ensureDir(path);
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

export function readJournal(filter?: {
  strategy?: string;
  symbol?: string;
  from?: number;
  to?: number;
}): JournalEntry[] {
  const path = journalPath();
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const entries: JournalEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JournalEntry;
      if (filter?.strategy && entry.strategy !== filter.strategy) continue;
      if (filter?.symbol && entry.symbol !== filter.symbol) continue;
      if (filter?.from !== undefined && entry.timestamp < filter.from) continue;
      if (filter?.to !== undefined && entry.timestamp > filter.to) continue;
      entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

export function clearJournal(): void {
  const path = journalPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
