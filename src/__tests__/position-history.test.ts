import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import {
  logPosition,
  readPositionHistory,
  getPositionStats,
  attachPositionLogger,
  type PositionRecord,
} from "../position-history.js";
import type { StreamEvent } from "../event-stream.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const POSITIONS_FILE = resolve(PERP_DIR, "positions.jsonl");
const BACKUP_FILE = resolve(PERP_DIR, "positions.jsonl.test-backup");

beforeEach(() => {
  // Backup existing file if present
  if (existsSync(POSITIONS_FILE)) {
    const content = readFileSync(POSITIONS_FILE, "utf-8");
    writeFileSync(BACKUP_FILE, content);
  }
  // Clear for test
  if (existsSync(POSITIONS_FILE)) unlinkSync(POSITIONS_FILE);
});

afterEach(() => {
  // Restore original file
  if (existsSync(POSITIONS_FILE)) unlinkSync(POSITIONS_FILE);
  if (existsSync(BACKUP_FILE)) {
    renameSync(BACKUP_FILE, POSITIONS_FILE);
  }
});

function makeRecord(overrides?: Partial<PositionRecord>): PositionRecord {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    exchange: "test",
    symbol: "BTC",
    side: "long",
    entryPrice: "100000",
    size: "0.1",
    openedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "open",
    ...overrides,
  };
}

describe("logPosition + readPositionHistory", () => {
  it("should log a position record and read it back", () => {
    const record = makeRecord({ symbol: "BTC", side: "long" });
    logPosition(record);

    const records = readPositionHistory();
    expect(records).toHaveLength(1);
    expect(records[0].symbol).toBe("BTC");
    expect(records[0].side).toBe("long");
    expect(records[0].id).toBe(record.id);
  });

  it("should log multiple records", () => {
    logPosition(makeRecord({ symbol: "BTC" }));
    logPosition(makeRecord({ symbol: "ETH" }));
    logPosition(makeRecord({ symbol: "SOL" }));

    const records = readPositionHistory();
    expect(records).toHaveLength(3);
  });

  it("should sort newest first", async () => {
    const now = Date.now();
    logPosition(makeRecord({ symbol: "FIRST", updatedAt: new Date(now - 2000).toISOString() }));
    logPosition(makeRecord({ symbol: "SECOND", updatedAt: new Date(now - 1000).toISOString() }));
    logPosition(makeRecord({ symbol: "THIRD", updatedAt: new Date(now).toISOString() }));

    const records = readPositionHistory();
    expect(records[0].symbol).toBe("THIRD");
    expect(records[1].symbol).toBe("SECOND");
    expect(records[2].symbol).toBe("FIRST");
  });

  it("should limit results", () => {
    for (let i = 0; i < 10; i++) {
      logPosition(makeRecord({ symbol: `SYM${i}` }));
    }
    const records = readPositionHistory({ limit: 3 });
    expect(records).toHaveLength(3);
  });
});

describe("readPositionHistory — filtering", () => {
  it("should filter by symbol", () => {
    logPosition(makeRecord({ symbol: "BTC" }));
    logPosition(makeRecord({ symbol: "ETH" }));
    logPosition(makeRecord({ symbol: "BTC-PERP" }));

    const records = readPositionHistory({ symbol: "BTC" });
    expect(records).toHaveLength(2);
    expect(records.every(r => r.symbol.includes("BTC"))).toBe(true);
  });

  it("should filter by exchange", () => {
    logPosition(makeRecord({ exchange: "hyperliquid" }));
    logPosition(makeRecord({ exchange: "pacifica" }));
    logPosition(makeRecord({ exchange: "hyperliquid" }));

    const records = readPositionHistory({ exchange: "hyperliquid" });
    expect(records).toHaveLength(2);
    expect(records.every(r => r.exchange === "hyperliquid")).toBe(true);
  });

  it("should filter by status", () => {
    logPosition(makeRecord({ status: "open" }));
    logPosition(makeRecord({ status: "closed", closedAt: new Date().toISOString() }));
    logPosition(makeRecord({ status: "updated" }));
    logPosition(makeRecord({ status: "closed", closedAt: new Date().toISOString() }));

    const records = readPositionHistory({ status: "closed" });
    expect(records).toHaveLength(2);
    expect(records.every(r => r.status === "closed")).toBe(true);
  });

  it("should filter by since date", () => {
    const old = new Date(Date.now() - 7 * 86400000).toISOString();
    const recent = new Date().toISOString();

    logPosition(makeRecord({ symbol: "OLD", updatedAt: old }));
    logPosition(makeRecord({ symbol: "NEW", updatedAt: recent }));

    const since = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    const records = readPositionHistory({ since });
    expect(records).toHaveLength(1);
    expect(records[0].symbol).toBe("NEW");
  });

  it("should combine filters", () => {
    logPosition(makeRecord({ exchange: "hl", symbol: "BTC", status: "closed" }));
    logPosition(makeRecord({ exchange: "hl", symbol: "ETH", status: "closed" }));
    logPosition(makeRecord({ exchange: "pac", symbol: "BTC", status: "closed" }));
    logPosition(makeRecord({ exchange: "hl", symbol: "BTC", status: "open" }));

    const records = readPositionHistory({ exchange: "hl", symbol: "BTC", status: "closed" });
    expect(records).toHaveLength(1);
    expect(records[0].exchange).toBe("hl");
    expect(records[0].symbol).toBe("BTC");
    expect(records[0].status).toBe("closed");
  });
});

describe("readPositionHistory — edge cases", () => {
  it("should return empty array when file does not exist", () => {
    const records = readPositionHistory();
    expect(records).toEqual([]);
  });

  it("should handle empty file", () => {
    writeFileSync(POSITIONS_FILE, "", { mode: 0o600 });
    const records = readPositionHistory();
    expect(records).toEqual([]);
  });

  it("should skip malformed lines", () => {
    writeFileSync(POSITIONS_FILE, "not json\n" + JSON.stringify(makeRecord({ symbol: "OK" })) + "\n", { mode: 0o600 });
    const records = readPositionHistory();
    expect(records).toHaveLength(1);
    expect(records[0].symbol).toBe("OK");
  });
});

describe("getPositionStats", () => {
  it("should return zeroed stats when no data", () => {
    const stats = getPositionStats();
    expect(stats.totalTrades).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.totalPnl).toBe(0);
    expect(stats.avgPnl).toBe(0);
    expect(stats.bestTrade).toBe(0);
    expect(stats.worstTrade).toBe(0);
    expect(stats.shortestTrade).toBe(0);
    expect(stats.longestTrade).toBe(0);
  });

  it("should compute stats from closed positions", () => {
    // 3 closed trades: +100, -50, +200
    logPosition(makeRecord({
      status: "closed",
      realizedPnl: "100",
      exchange: "hl",
      symbol: "BTC",
      duration: 60000,
    }));
    logPosition(makeRecord({
      status: "closed",
      realizedPnl: "-50",
      exchange: "hl",
      symbol: "ETH",
      duration: 120000,
    }));
    logPosition(makeRecord({
      status: "closed",
      realizedPnl: "200",
      exchange: "pac",
      symbol: "BTC",
      duration: 30000,
    }));
    // Open positions should be ignored
    logPosition(makeRecord({
      status: "open",
      unrealizedPnl: "999",
      exchange: "hl",
      symbol: "SOL",
    }));

    const stats = getPositionStats();

    expect(stats.totalTrades).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBeCloseTo(66.67, 0);
    expect(stats.totalPnl).toBe(250);
    expect(stats.avgPnl).toBeCloseTo(83.33, 0);
    expect(stats.bestTrade).toBe(200);
    expect(stats.worstTrade).toBe(-50);
    expect(stats.avgDuration).toBeCloseTo(70000, -3);
    expect(stats.longestTrade).toBe(120000);
    expect(stats.shortestTrade).toBe(30000);
  });

  it("should compute bySymbol stats", () => {
    logPosition(makeRecord({ status: "closed", realizedPnl: "100", symbol: "BTC", duration: 1000 }));
    logPosition(makeRecord({ status: "closed", realizedPnl: "-30", symbol: "BTC", duration: 2000 }));
    logPosition(makeRecord({ status: "closed", realizedPnl: "50", symbol: "ETH", duration: 3000 }));

    const stats = getPositionStats();

    expect(stats.bySymbol.BTC.trades).toBe(2);
    expect(stats.bySymbol.BTC.pnl).toBe(70);
    expect(stats.bySymbol.BTC.winRate).toBe(50);

    expect(stats.bySymbol.ETH.trades).toBe(1);
    expect(stats.bySymbol.ETH.pnl).toBe(50);
    expect(stats.bySymbol.ETH.winRate).toBe(100);
  });

  it("should compute byExchange stats", () => {
    logPosition(makeRecord({ status: "closed", realizedPnl: "100", exchange: "hl", duration: 1000 }));
    logPosition(makeRecord({ status: "closed", realizedPnl: "-20", exchange: "pac", duration: 2000 }));
    logPosition(makeRecord({ status: "closed", realizedPnl: "50", exchange: "hl", duration: 3000 }));

    const stats = getPositionStats();

    expect(stats.byExchange.hl.trades).toBe(2);
    expect(stats.byExchange.hl.pnl).toBe(150);
    expect(stats.byExchange.pac.trades).toBe(1);
    expect(stats.byExchange.pac.pnl).toBe(-20);
  });

  it("should filter stats by exchange", () => {
    logPosition(makeRecord({ status: "closed", realizedPnl: "100", exchange: "hl", duration: 1000 }));
    logPosition(makeRecord({ status: "closed", realizedPnl: "-20", exchange: "pac", duration: 2000 }));

    const stats = getPositionStats({ exchange: "hl" });
    expect(stats.totalTrades).toBe(1);
    expect(stats.totalPnl).toBe(100);
  });
});

describe("attachPositionLogger", () => {
  it("should forward all events to the original callback", () => {
    const received: StreamEvent[] = [];
    const originalOnEvent = (e: StreamEvent) => received.push(e);
    const wrapped = attachPositionLogger(originalOnEvent);

    const heartbeat: StreamEvent = {
      type: "heartbeat",
      exchange: "test",
      timestamp: new Date().toISOString(),
      data: { cycle: 1 },
    };

    wrapped(heartbeat);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("heartbeat");
  });

  it("should log position_opened events", () => {
    const received: StreamEvent[] = [];
    const wrapped = attachPositionLogger((e) => received.push(e));

    const event: StreamEvent = {
      type: "position_opened",
      exchange: "test-ex",
      timestamp: new Date().toISOString(),
      data: { symbol: "BTC", side: "long", size: "0.5", entryPrice: "65000", unrealizedPnl: "0" },
    };

    wrapped(event);

    // Event should be forwarded
    expect(received).toHaveLength(1);

    // Position should be logged
    const positions = readPositionHistory({ exchange: "test-ex" });
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("BTC");
    expect(positions[0].side).toBe("long");
    expect(positions[0].status).toBe("open");
    expect(positions[0].entryPrice).toBe("65000");
    expect(positions[0].size).toBe("0.5");
  });

  it("should log position_updated events", () => {
    const wrapped = attachPositionLogger(() => {});

    // First open the position
    wrapped({
      type: "position_opened",
      exchange: "test-ex",
      timestamp: new Date().toISOString(),
      data: { symbol: "ETH", side: "short", size: "5", entryPrice: "2000", unrealizedPnl: "0" },
    });

    // Then update it
    wrapped({
      type: "position_updated",
      exchange: "test-ex",
      timestamp: new Date().toISOString(),
      data: { symbol: "ETH", side: "short", size: "10", entryPrice: "2000", unrealizedPnl: "-20", prevSize: "5", prevSide: "short" },
    });

    const positions = readPositionHistory({ status: "updated" });
    expect(positions).toHaveLength(1);
    expect(positions[0].size).toBe("10");
    expect(positions[0].status).toBe("updated");
    expect(positions[0].meta?.prevSize).toBe("5");
  });

  it("should log position_closed events with duration", () => {
    const wrapped = attachPositionLogger(() => {});

    const openTime = new Date("2026-03-08T10:00:00.000Z");
    const closeTime = new Date("2026-03-08T10:05:00.000Z");

    wrapped({
      type: "position_opened",
      exchange: "test-ex",
      timestamp: openTime.toISOString(),
      data: { symbol: "SOL", side: "long", size: "100", entryPrice: "150", unrealizedPnl: "0" },
    });

    wrapped({
      type: "position_closed",
      exchange: "test-ex",
      timestamp: closeTime.toISOString(),
      data: { symbol: "SOL", side: "long", size: "100", entryPrice: "150", unrealizedPnl: "50" },
    });

    const closed = readPositionHistory({ status: "closed" });
    expect(closed).toHaveLength(1);
    expect(closed[0].status).toBe("closed");
    expect(closed[0].realizedPnl).toBe("50");
    expect(closed[0].closedAt).toBe(closeTime.toISOString());
    expect(closed[0].duration).toBe(300000); // 5 minutes in ms
  });

  it("should track multiple positions independently", () => {
    const wrapped = attachPositionLogger(() => {});
    const ts = new Date().toISOString();

    wrapped({
      type: "position_opened",
      exchange: "ex",
      timestamp: ts,
      data: { symbol: "BTC", side: "long", size: "0.1", entryPrice: "65000", unrealizedPnl: "0" },
    });
    wrapped({
      type: "position_opened",
      exchange: "ex",
      timestamp: ts,
      data: { symbol: "ETH", side: "short", size: "5", entryPrice: "2000", unrealizedPnl: "0" },
    });

    // Close only BTC
    wrapped({
      type: "position_closed",
      exchange: "ex",
      timestamp: ts,
      data: { symbol: "BTC", side: "long", size: "0.1", entryPrice: "65000", unrealizedPnl: "100" },
    });

    const all = readPositionHistory({ exchange: "ex" });
    // 2 opens + 1 close = 3 records
    expect(all).toHaveLength(3);

    const closed = readPositionHistory({ exchange: "ex", status: "closed" });
    expect(closed).toHaveLength(1);
    expect(closed[0].symbol).toBe("BTC");
  });

  it("should handle position_closed without prior open gracefully", () => {
    const wrapped = attachPositionLogger(() => {});

    // Close without opening (e.g., logger started mid-session)
    wrapped({
      type: "position_closed",
      exchange: "test",
      timestamp: new Date().toISOString(),
      data: { symbol: "BTC", side: "long", size: "0.1", entryPrice: "65000", unrealizedPnl: "0" },
    });

    const closed = readPositionHistory({ status: "closed" });
    expect(closed).toHaveLength(1);
    // Duration should be undefined since we don't know when it opened
  });

  it("should not log non-position events", () => {
    const wrapped = attachPositionLogger(() => {});

    wrapped({
      type: "order_placed",
      exchange: "test",
      timestamp: new Date().toISOString(),
      data: { orderId: "o1", symbol: "BTC" },
    });

    wrapped({
      type: "balance_update",
      exchange: "test",
      timestamp: new Date().toISOString(),
      data: { equity: "1000" },
    });

    const positions = readPositionHistory();
    expect(positions).toHaveLength(0);
  });
});
