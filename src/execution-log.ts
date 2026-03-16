import { existsSync, appendFileSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const LOG_FILE = resolve(PERP_DIR, "executions.jsonl");

export interface ExecutionRecord {
  id: string;
  timestamp: string;
  type: "market_order" | "limit_order" | "cancel" | "stop_order" | "edit_order" | "rebalance" | "arb_entry" | "arb_close" | "bridge" | "multi_leg" | "multi_leg_rollback" | "split_order";
  exchange: string;
  symbol: string;
  side: string;
  size: string;
  price?: string;
  notional?: number;
  status: "success" | "failed" | "simulated" | "unverified";
  error?: string;
  meta?: Record<string, unknown>;
  dryRun: boolean;
}

function ensureDir() {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append an execution record to the log */
export function logExecution(record: Omit<ExecutionRecord, "id" | "timestamp">): ExecutionRecord {
  ensureDir();
  const full: ExecutionRecord = {
    id: genId(),
    timestamp: new Date().toISOString(),
    ...record,
  };
  appendFileSync(LOG_FILE, JSON.stringify(full) + "\n", { mode: 0o600 });
  return full;
}

/** Read execution log with optional filters */
export function readExecutionLog(opts?: {
  limit?: number;
  exchange?: string;
  symbol?: string;
  type?: string;
  since?: string;  // ISO date string
  dryRunOnly?: boolean;
}): ExecutionRecord[] {
  if (!existsSync(LOG_FILE)) return [];

  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
  let records: ExecutionRecord[] = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  // Apply filters
  if (opts?.exchange) {
    records = records.filter(r => r.exchange === opts.exchange);
  }
  if (opts?.symbol) {
    records = records.filter(r => r.symbol.toUpperCase().includes(opts.symbol!.toUpperCase()));
  }
  if (opts?.type) {
    records = records.filter(r => r.type === opts.type);
  }
  if (opts?.since) {
    const sinceDate = new Date(opts.since).getTime();
    records = records.filter(r => new Date(r.timestamp).getTime() >= sinceDate);
  }
  if (opts?.dryRunOnly) {
    records = records.filter(r => r.dryRun);
  }

  // Sort newest first
  records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Limit
  if (opts?.limit) {
    records = records.slice(0, opts.limit);
  }

  return records;
}

/** Get execution stats summary */
export function getExecutionStats(since?: string): {
  totalTrades: number;
  successRate: number;
  byExchange: Record<string, number>;
  byType: Record<string, number>;
  recentErrors: string[];
} {
  const records = readExecutionLog({ since });
  const successful = records.filter(r => r.status === "success");

  const byExchange: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const recentErrors: string[] = [];

  for (const r of records) {
    byExchange[r.exchange] = (byExchange[r.exchange] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
    if (r.status === "failed" && r.error && recentErrors.length < 5) {
      recentErrors.push(`[${r.exchange}] ${r.error}`);
    }
  }

  return {
    totalTrades: records.length,
    successRate: records.length > 0 ? (successful.length / records.length) * 100 : 0,
    byExchange,
    byType,
    recentErrors,
  };
}

/** Clear old records (keep last N days) */
export function pruneExecutionLog(keepDays: number = 30): number {
  if (!existsSync(LOG_FILE)) return 0;

  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;

  const kept = lines.filter(line => {
    try {
      const r = JSON.parse(line);
      return new Date(r.timestamp).getTime() >= cutoff;
    } catch {
      return false;
    }
  });

  const pruned = lines.length - kept.length;
  ensureDir();
  writeFileSync(LOG_FILE, kept.join("\n") + (kept.length > 0 ? "\n" : ""), { mode: 0o600 });
  return pruned;
}
