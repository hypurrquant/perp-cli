import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { logExecution, readExecutionLog, getExecutionStats, pruneExecutionLog } from "../execution-log.js";
import { existsSync, unlinkSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const LOG_FILE = resolve(PERP_DIR, "executions.jsonl");
const BACKUP_FILE = resolve(PERP_DIR, "executions.jsonl.test-backup");

describe("Execution Log", () => {
  beforeEach(() => {
    // Backup existing log if present
    if (existsSync(LOG_FILE)) {
      const content = readFileSync(LOG_FILE, "utf-8");
      writeFileSync(BACKUP_FILE, content);
    }
    // Clear log for test
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
  });

  afterEach(() => {
    // Restore original log
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
    if (existsSync(BACKUP_FILE)) {
      renameSync(BACKUP_FILE, LOG_FILE);
    }
  });

  it("should log an execution record", () => {
    const record = logExecution({
      type: "market_order",
      exchange: "hyperliquid",
      symbol: "BTC",
      side: "buy",
      size: "0.1",
      price: "100000",
      notional: 10000,
      status: "success",
      dryRun: false,
    });

    expect(record.id).toBeTruthy();
    expect(record.timestamp).toBeTruthy();
    expect(record.exchange).toBe("hyperliquid");
    expect(record.symbol).toBe("BTC");
  });

  it("should read back logged records", () => {
    logExecution({ type: "market_order", exchange: "test", symbol: "BTC", side: "buy", size: "0.1", status: "success", dryRun: false });
    logExecution({ type: "limit_order", exchange: "test", symbol: "ETH", side: "sell", size: "1.0", status: "success", dryRun: false });

    const records = readExecutionLog();
    expect(records).toHaveLength(2);
  });

  it("should filter by exchange", () => {
    logExecution({ type: "market_order", exchange: "hl", symbol: "BTC", side: "buy", size: "0.1", status: "success", dryRun: false });
    logExecution({ type: "market_order", exchange: "pac", symbol: "BTC", side: "buy", size: "0.1", status: "success", dryRun: false });

    const records = readExecutionLog({ exchange: "hl" });
    expect(records).toHaveLength(1);
    expect(records[0].exchange).toBe("hl");
  });

  it("should filter by symbol", () => {
    logExecution({ type: "market_order", exchange: "test", symbol: "BTC", side: "buy", size: "0.1", status: "success", dryRun: false });
    logExecution({ type: "market_order", exchange: "test", symbol: "ETH", side: "sell", size: "1.0", status: "success", dryRun: false });

    const records = readExecutionLog({ symbol: "ETH" });
    expect(records).toHaveLength(1);
    expect(records[0].symbol).toBe("ETH");
  });

  it("should mark dry-run executions", () => {
    logExecution({ type: "market_order", exchange: "test", symbol: "BTC", side: "buy", size: "0.1", status: "simulated", dryRun: true });
    logExecution({ type: "market_order", exchange: "test", symbol: "ETH", side: "sell", size: "1.0", status: "success", dryRun: false });

    const dryRuns = readExecutionLog({ dryRunOnly: true });
    expect(dryRuns).toHaveLength(1);
    expect(dryRuns[0].dryRun).toBe(true);
    expect(dryRuns[0].status).toBe("simulated");
  });

  it("should compute execution stats", () => {
    logExecution({ type: "market_order", exchange: "hl", symbol: "BTC", side: "buy", size: "0.1", status: "success", dryRun: false });
    logExecution({ type: "limit_order", exchange: "pac", symbol: "ETH", side: "sell", size: "1.0", status: "success", dryRun: false });
    logExecution({ type: "market_order", exchange: "hl", symbol: "SOL", side: "buy", size: "10", status: "failed", error: "insufficient balance", dryRun: false });

    const stats = getExecutionStats();
    expect(stats.totalTrades).toBe(3);
    expect(stats.successRate).toBeCloseTo(66.67, 0);
    expect(stats.byExchange.hl).toBe(2);
    expect(stats.byExchange.pac).toBe(1);
    expect(stats.byType.market_order).toBe(2);
    expect(stats.byType.limit_order).toBe(1);
    expect(stats.recentErrors).toHaveLength(1);
  });

  it("should return empty stats when no log file", () => {
    const stats = getExecutionStats();
    expect(stats.totalTrades).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  it("should limit results", () => {
    for (let i = 0; i < 10; i++) {
      logExecution({ type: "market_order", exchange: "test", symbol: "BTC", side: "buy", size: "0.1", status: "success", dryRun: false });
    }
    const records = readExecutionLog({ limit: 3 });
    expect(records).toHaveLength(3);
  });

  it("should sort newest first", async () => {
    logExecution({ type: "market_order", exchange: "test", symbol: "FIRST", side: "buy", size: "0.1", status: "success", dryRun: false });
    // Ensure distinct timestamps (Date.now resolution is 1ms)
    await new Promise((r) => setTimeout(r, 5));
    logExecution({ type: "market_order", exchange: "test", symbol: "SECOND", side: "buy", size: "0.1", status: "success", dryRun: false });

    const records = readExecutionLog();
    expect(records[0].symbol).toBe("SECOND");
    expect(records[1].symbol).toBe("FIRST");
  });
});
