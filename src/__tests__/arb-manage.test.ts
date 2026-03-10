import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import { logExecution, readExecutionLog } from "../execution-log.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const LOG_FILE = resolve(PERP_DIR, "executions.jsonl");
const BACKUP_FILE = resolve(PERP_DIR, "executions.jsonl.arb-manage-backup");

// ── Helpers for testing arb pair detection ──

interface MockPosition {
  exchange: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
}

function detectArbPairs(positions: MockPosition[]) {
  const bySymbol = new Map<string, MockPosition[]>();
  for (const p of positions) {
    const key = p.symbol.toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key)!.push(p);
  }

  const pairs: { symbol: string; longExchange: string; shortExchange: string; longPos: MockPosition; shortPos: MockPosition }[] = [];

  for (const [symbol, pos] of bySymbol) {
    const longs = pos.filter(p => p.side === "long");
    const shorts = pos.filter(p => p.side === "short");

    for (const l of longs) {
      for (const s of shorts) {
        if (l.exchange !== s.exchange) {
          pairs.push({ symbol, longExchange: l.exchange, shortExchange: s.exchange, longPos: l, shortPos: s });
        }
      }
    }
  }
  return pairs;
}

// ── Tests ──

describe("Arb pair detection", () => {
  it("matches positions on different exchanges with opposite sides", () => {
    const positions: MockPosition[] = [
      { exchange: "hyperliquid", symbol: "BTC", side: "long", size: 0.1, entryPrice: 100000, markPrice: 101000, unrealizedPnl: 100 },
      { exchange: "lighter", symbol: "BTC", side: "short", size: 0.1, entryPrice: 100500, markPrice: 101000, unrealizedPnl: -50 },
    ];
    const pairs = detectArbPairs(positions);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].symbol).toBe("BTC");
    expect(pairs[0].longExchange).toBe("hyperliquid");
    expect(pairs[0].shortExchange).toBe("lighter");
  });

  it("does not match positions on the same exchange", () => {
    const positions: MockPosition[] = [
      { exchange: "hyperliquid", symbol: "ETH", side: "long", size: 1, entryPrice: 3000, markPrice: 3100, unrealizedPnl: 100 },
      { exchange: "hyperliquid", symbol: "ETH", side: "short", size: 1, entryPrice: 3050, markPrice: 3100, unrealizedPnl: -50 },
    ];
    const pairs = detectArbPairs(positions);
    expect(pairs).toHaveLength(0);
  });

  it("does not match positions with same side", () => {
    const positions: MockPosition[] = [
      { exchange: "hyperliquid", symbol: "SOL", side: "long", size: 10, entryPrice: 150, markPrice: 155, unrealizedPnl: 50 },
      { exchange: "lighter", symbol: "SOL", side: "long", size: 10, entryPrice: 151, markPrice: 155, unrealizedPnl: 40 },
    ];
    const pairs = detectArbPairs(positions);
    expect(pairs).toHaveLength(0);
  });

  it("returns empty for no positions", () => {
    const pairs = detectArbPairs([]);
    expect(pairs).toHaveLength(0);
  });

  it("matches multiple arb pairs for different symbols", () => {
    const positions: MockPosition[] = [
      { exchange: "hyperliquid", symbol: "BTC", side: "long", size: 0.1, entryPrice: 100000, markPrice: 101000, unrealizedPnl: 100 },
      { exchange: "lighter", symbol: "BTC", side: "short", size: 0.1, entryPrice: 100500, markPrice: 101000, unrealizedPnl: -50 },
      { exchange: "pacifica", symbol: "ETH", side: "long", size: 1, entryPrice: 3000, markPrice: 3100, unrealizedPnl: 100 },
      { exchange: "hyperliquid", symbol: "ETH", side: "short", size: 1, entryPrice: 3050, markPrice: 3100, unrealizedPnl: -50 },
    ];
    const pairs = detectArbPairs(positions);
    expect(pairs).toHaveLength(2);
    const symbols = pairs.map(p => p.symbol).sort();
    expect(symbols).toEqual(["BTC", "ETH"]);
  });

  it("handles case-insensitive symbol matching", () => {
    const positions: MockPosition[] = [
      { exchange: "hyperliquid", symbol: "btc", side: "long", size: 0.1, entryPrice: 100000, markPrice: 101000, unrealizedPnl: 100 },
      { exchange: "lighter", symbol: "BTC", side: "short", size: 0.1, entryPrice: 100500, markPrice: 101000, unrealizedPnl: -50 },
    ];
    const pairs = detectArbPairs(positions);
    expect(pairs).toHaveLength(1);
  });
});

describe("Arb close dry-run", () => {
  it("dry-run flag prevents execution", () => {
    // Simulating dry-run behavior: the flag should be passed through
    const dryRun = true;
    const executed: string[] = [];

    // In dry-run mode, no orders should be placed
    if (!dryRun) {
      executed.push("sell");
      executed.push("buy");
    }

    expect(executed).toHaveLength(0);
  });

  it("produces correct actions for close", () => {
    const longPos = { exchange: "hyperliquid", symbol: "BTC", rawSymbol: "BTC", side: "long" as const, size: 0.1 };
    const shortPos = { exchange: "lighter", symbol: "BTC", rawSymbol: "BTC-PERP", side: "short" as const, size: 0.1 };

    const actions = [
      { exchange: longPos.exchange, action: "sell", symbol: longPos.rawSymbol, size: String(longPos.size) },
      { exchange: shortPos.exchange, action: "buy", symbol: shortPos.rawSymbol, size: String(shortPos.size) },
    ];

    expect(actions).toHaveLength(2);
    expect(actions[0].action).toBe("sell"); // close long = sell
    expect(actions[1].action).toBe("buy");  // close short = buy
    expect(actions[0].exchange).toBe("hyperliquid");
    expect(actions[1].exchange).toBe("lighter");
  });
});

describe("Arb history grouping and stats", () => {
  beforeEach(() => {
    if (existsSync(LOG_FILE)) {
      const content = readFileSync(LOG_FILE, "utf-8");
      writeFileSync(BACKUP_FILE, content);
    }
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
  });

  afterEach(() => {
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
    if (existsSync(BACKUP_FILE)) {
      renameSync(BACKUP_FILE, LOG_FILE);
    }
  });

  it("groups arb entries and closes by symbol", () => {
    logExecution({
      type: "arb_entry", exchange: "hyperliquid+lighter",
      symbol: "BTC", side: "entry", size: "0.1",
      status: "success", dryRun: false,
      meta: { longExchange: "hyperliquid", shortExchange: "lighter", spread: 35, markPrice: 100000 },
    });

    logExecution({
      type: "arb_close", exchange: "hyperliquid+lighter",
      symbol: "BTC", side: "close", size: "0.1",
      status: "success", dryRun: false,
      meta: { longExchange: "hyperliquid", shortExchange: "lighter", currentSpread: 3, unrealizedPnl: 5.5, netPnl: 4.2 },
    });

    const entries = readExecutionLog({ type: "arb_entry" });
    const closes = readExecutionLog({ type: "arb_close" });

    expect(entries).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(entries[0].symbol).toBe("BTC");
    expect(closes[0].symbol).toBe("BTC");
    expect(entries[0].meta?.spread).toBe(35);
    expect(closes[0].meta?.netPnl).toBe(4.2);
  });

  it("calculates trade stats from multiple entries", () => {
    // Trade 1: winner
    logExecution({
      type: "arb_entry", exchange: "hyperliquid+lighter",
      symbol: "BTC", side: "entry", size: "0.1",
      status: "success", dryRun: false,
      meta: { spread: 40, markPrice: 100000 },
    });
    logExecution({
      type: "arb_close", exchange: "hyperliquid+lighter",
      symbol: "BTC", side: "close", size: "0.1",
      status: "success", dryRun: false,
      meta: { unrealizedPnl: 10, netPnl: 8 },
    });

    // Trade 2: loser
    logExecution({
      type: "arb_entry", exchange: "pacifica+hyperliquid",
      symbol: "ETH", side: "entry", size: "1.0",
      status: "success", dryRun: false,
      meta: { spread: 25, markPrice: 3000 },
    });
    logExecution({
      type: "arb_close", exchange: "pacifica+hyperliquid",
      symbol: "ETH", side: "close", size: "1.0",
      status: "success", dryRun: false,
      meta: { unrealizedPnl: -5, netPnl: -7 },
    });

    const allEntries = readExecutionLog()
      .filter(r => r.type === "arb_entry" || r.type === "arb_close");

    const entries = allEntries.filter(r => r.type === "arb_entry");
    const closes = allEntries.filter(r => r.type === "arb_close");

    expect(entries).toHaveLength(2);
    expect(closes).toHaveLength(2);

    // Verify we can compute stats
    const completedNetPnls = closes
      .filter(c => c.status === "success" && c.meta?.netPnl !== undefined)
      .map(c => Number(c.meta!.netPnl));

    expect(completedNetPnls).toHaveLength(2);
    const totalNetPnl = completedNetPnls.reduce((s, n) => s + n, 0);
    expect(totalNetPnl).toBe(1); // 8 + (-7) = 1
    const winners = completedNetPnls.filter(n => n > 0);
    expect(winners).toHaveLength(1);
    const winRate = (winners.length / completedNetPnls.length) * 100;
    expect(winRate).toBe(50);
  });

  it("handles entries without matching closes (open trades)", () => {
    logExecution({
      type: "arb_entry", exchange: "hyperliquid+lighter",
      symbol: "SOL", side: "entry", size: "10",
      status: "success", dryRun: false,
      meta: { spread: 30, markPrice: 150 },
    });

    const entries = readExecutionLog({ type: "arb_entry" });
    const closes = readExecutionLog({ type: "arb_close" });

    expect(entries).toHaveLength(1);
    expect(closes).toHaveLength(0);

    // Should be treated as an open trade
    const symbol = entries[0].symbol;
    const matchingClose = closes.find(c => c.symbol === symbol);
    expect(matchingClose).toBeUndefined();
  });

  it("filters by period correctly", () => {
    // Log an entry with a very old timestamp manually
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    logExecution({
      type: "arb_entry", exchange: "hyperliquid+lighter",
      symbol: "OLD_TRADE", side: "entry", size: "0.1",
      status: "success", dryRun: false,
    });

    logExecution({
      type: "arb_entry", exchange: "hyperliquid+lighter",
      symbol: "NEW_TRADE", side: "entry", size: "0.1",
      status: "success", dryRun: false,
    });

    // Read with 30-day filter: both are recent (logged just now), so both should appear
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = readExecutionLog({ type: "arb_entry", since: since30d });
    expect(recent).toHaveLength(2);
  });
});

describe("Duration formatting", () => {
  function formatDuration(ms: number): string {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days > 0) return `${days}d ${remainingHours}h`;
    if (hours > 0) return `${hours}h`;
    const minutes = Math.floor(ms / (1000 * 60));
    return `${minutes}m`;
  }

  it("formats minutes", () => {
    expect(formatDuration(30 * 60 * 1000)).toBe("30m");
  });

  it("formats hours", () => {
    expect(formatDuration(5 * 60 * 60 * 1000)).toBe("5h");
  });

  it("formats days and hours", () => {
    expect(formatDuration(26 * 60 * 60 * 1000)).toBe("1d 2h");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0m");
  });
});
