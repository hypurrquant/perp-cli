import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// Use vi.hoisted so TEST_DIR is available when vi.mock runs (hoisted)
const { TEST_DIR } = vi.hoisted(() => {
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  return {
    TEST_DIR: join(tmpdir(), `perp-funding-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  };
});

// Mock the homedir to redirect storage to our test directory
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(TEST_DIR, "home"),
  };
});

import {
  saveFundingSnapshot,
  getAvgFundingRate,
  getHistoricalRates,
  getHistoricalAverages,
  getCompoundedAnnualReturn,
  getExchangeCompoundingHours,
  cleanupOldFiles,
  _resetCleanupFlag,
  type FundingHistoryEntry,
} from "../funding-history.js";

import type { ExchangeFundingRate } from "../funding-rates.js";

const DATA_DIR = join(TEST_DIR, "home", ".perp", "funding-rates");

function makeRate(overrides: Partial<ExchangeFundingRate> = {}): ExchangeFundingRate {
  return {
    exchange: "hyperliquid",
    symbol: "BTC",
    canonical: "BTC",
    fundingRate: 0.0001,
    basis: { kind: "perHours", hours: 1 },
    hourlyRate: 0.0001,
    annualizedPct: 87.6,
    markPrice: 50000,
    nextFundingTime: null,
    historicalAvg: null,
    fundingVerified: true,
    apiStatus: "official",
    rateKind: "accruing",
    ...overrides,
  } as ExchangeFundingRate;
}

function readJsonl(filePath: string): FundingHistoryEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as FundingHistoryEntry);
}

function getMonthKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

describe("funding-history", () => {
  beforeEach(() => {
    _resetCleanupFlag();
    mkdirSync(DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ──────────────────────────────────────────────
  // saveFundingSnapshot
  // ──────────────────────────────────────────────

  describe("saveFundingSnapshot", () => {
    it("writes JSONL correctly", () => {
      const rates = [
        makeRate({ exchange: "hyperliquid", symbol: "BTC", fundingRate: 0.0001, hourlyRate: 0.0001 }),
        makeRate({ exchange: "pacifica", symbol: "ETH", fundingRate: 0.0008, hourlyRate: 0.0001 }),
      ];

      saveFundingSnapshot(rates);

      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);
      expect(existsSync(filePath)).toBe(true);

      const entries = readJsonl(filePath);
      expect(entries).toHaveLength(2);
      expect(entries[0].symbol).toBe("BTC");
      expect(entries[0].exchange).toBe("hyperliquid");
      expect(entries[0].rate).toBe(0.0001);
      expect(entries[0].hourlyRate).toBe(0.0001);
      expect(entries[0].ts).toBeDefined();

      expect(entries[1].symbol).toBe("ETH");
      expect(entries[1].exchange).toBe("pacifica");
    });

    it("deduplicates entries within 5 minutes", () => {
      const rates = [makeRate({ symbol: "BTC", exchange: "hyperliquid" })];

      // Save twice in quick succession
      saveFundingSnapshot(rates);
      saveFundingSnapshot(rates);

      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);
      const entries = readJsonl(filePath);

      // Should only have 1 entry due to dedup
      expect(entries).toHaveLength(1);
    });

    it("allows entries after 5 minute gap", () => {
      const rates = [makeRate({ symbol: "BTC", exchange: "hyperliquid" })];

      // Write an entry with a timestamp 6 minutes ago
      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);
      const oldTs = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const oldEntry: FundingHistoryEntry = {
        ts: oldTs,
        symbol: "BTC",
        exchange: "hyperliquid",
        rate: 0.0001,
        hourlyRate: 0.0001,
      };
      writeFileSync(filePath, JSON.stringify(oldEntry) + "\n");

      // Now save new snapshot
      saveFundingSnapshot(rates);

      const entries = readJsonl(filePath);
      expect(entries).toHaveLength(2);
    });

    it("uppercases symbol names", () => {
      const rates = [makeRate({ symbol: "btc" as string })];
      saveFundingSnapshot(rates);

      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);
      const entries = readJsonl(filePath);
      expect(entries[0].symbol).toBe("BTC");
    });

    it("skips entries with empty symbol", () => {
      const rates = [makeRate({ symbol: "" })];
      saveFundingSnapshot(rates);

      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);
      // File may or may not exist; if it does, it should be empty
      if (existsSync(filePath)) {
        const entries = readJsonl(filePath);
        expect(entries).toHaveLength(0);
      }
    });
  });

  // ──────────────────────────────────────────────
  // getAvgFundingRate
  // ──────────────────────────────────────────────

  describe("getAvgFundingRate", () => {
    it("returns correct average", () => {
      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);

      // Write 3 entries with different hourly rates at recent times
      const entries: FundingHistoryEntry[] = [
        { ts: new Date(Date.now() - 30 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0001, hourlyRate: 0.0001 },
        { ts: new Date(Date.now() - 20 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0002, hourlyRate: 0.0002 },
        { ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0003, hourlyRate: 0.0003 },
      ];
      writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

      const avg = getAvgFundingRate("BTC", "hyperliquid", 1);
      expect(avg).toBeCloseTo(0.0002); // (0.0001 + 0.0002 + 0.0003) / 3
    });

    it("returns null when no data available", () => {
      const avg = getAvgFundingRate("NOEXIST", "hyperliquid", 24);
      expect(avg).toBeNull();
    });

    it("filters by symbol and exchange correctly", () => {
      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);

      const entries: FundingHistoryEntry[] = [
        { ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0001, hourlyRate: 0.0001 },
        { ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), symbol: "ETH", exchange: "hyperliquid", rate: 0.0005, hourlyRate: 0.0005 },
        { ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "pacifica", rate: 0.0008, hourlyRate: 0.0001 },
      ];
      writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

      const avgBtcHL = getAvgFundingRate("BTC", "hyperliquid", 1);
      expect(avgBtcHL).toBeCloseTo(0.0001);

      const avgEthHL = getAvgFundingRate("ETH", "hyperliquid", 1);
      expect(avgEthHL).toBeCloseTo(0.0005);

      const avgBtcPac = getAvgFundingRate("BTC", "pacifica", 1);
      expect(avgBtcPac).toBeCloseTo(0.0001);
    });

    it("only includes entries within the time window", () => {
      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);

      const entries: FundingHistoryEntry[] = [
        { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.001, hourlyRate: 0.001 },
        { ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0001, hourlyRate: 0.0001 },
      ];
      writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

      // Only 1h window should exclude the 3h-old entry
      const avg1h = getAvgFundingRate("BTC", "hyperliquid", 1);
      expect(avg1h).toBeCloseTo(0.0001);

      // 4h window should include both
      const avg4h = getAvgFundingRate("BTC", "hyperliquid", 4);
      expect(avg4h).toBeCloseTo(0.00055); // (0.001 + 0.0001) / 2
    });
  });

  // ──────────────────────────────────────────────
  // getHistoricalRates
  // ──────────────────────────────────────────────

  describe("getHistoricalRates", () => {
    it("returns sorted entries in time range", () => {
      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);

      const t1 = new Date(Date.now() - 30 * 60 * 1000);
      const t2 = new Date(Date.now() - 20 * 60 * 1000);
      const t3 = new Date(Date.now() - 10 * 60 * 1000);

      const entries: FundingHistoryEntry[] = [
        { ts: t3.toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0003, hourlyRate: 0.0003 },
        { ts: t1.toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0001, hourlyRate: 0.0001 },
        { ts: t2.toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0002, hourlyRate: 0.0002 },
      ];
      writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

      const startTime = new Date(Date.now() - 60 * 60 * 1000);
      const endTime = new Date();
      const result = getHistoricalRates("BTC", "hyperliquid", startTime, endTime);

      expect(result).toHaveLength(3);
      // Should be sorted by time ascending
      expect(result[0].rate).toBe(0.0001);
      expect(result[1].rate).toBe(0.0002);
      expect(result[2].rate).toBe(0.0003);
    });
  });

  // ──────────────────────────────────────────────
  // getHistoricalAverages
  // ──────────────────────────────────────────────

  describe("getHistoricalAverages", () => {
    it("handles missing data (returns null)", () => {
      const result = getHistoricalAverages(["BTC"], ["hyperliquid"]);
      const avgs = result.get("BTC:hyperliquid");

      expect(avgs).toBeDefined();
      expect(avgs!.avg1h).toBeNull();
      expect(avgs!.avg8h).toBeNull();
      expect(avgs!.avg24h).toBeNull();
      expect(avgs!.avg7d).toBeNull();
    });

    it("computes averages for different time windows", () => {
      const monthKey = getMonthKey(new Date());
      const filePath = join(DATA_DIR, `${monthKey}.jsonl`);

      const entries: FundingHistoryEntry[] = [
        // Within 1h
        { ts: new Date(Date.now() - 30 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0002, hourlyRate: 0.0002 },
        // Within 8h but not 1h
        { ts: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), symbol: "BTC", exchange: "hyperliquid", rate: 0.0004, hourlyRate: 0.0004 },
      ];
      writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

      const result = getHistoricalAverages(["BTC"], ["hyperliquid"]);
      const avgs = result.get("BTC:hyperliquid");

      expect(avgs).toBeDefined();
      expect(avgs!.avg1h).toBeCloseTo(0.0002);  // only the 30-min-old entry
      expect(avgs!.avg8h).toBeCloseTo(0.0003);  // both entries: (0.0002 + 0.0004) / 2
      expect(avgs!.avg24h).toBeCloseTo(0.0003); // both entries
      expect(avgs!.avg7d).toBeCloseTo(0.0003);  // both entries
    });

    it("generates correct keys for multiple symbols and exchanges", () => {
      const result = getHistoricalAverages(["BTC", "ETH"], ["hyperliquid", "pacifica"]);

      expect(result.has("BTC:hyperliquid")).toBe(true);
      expect(result.has("BTC:pacifica")).toBe(true);
      expect(result.has("ETH:hyperliquid")).toBe(true);
      expect(result.has("ETH:pacifica")).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // cleanupOldFiles
  // ──────────────────────────────────────────────

  describe("cleanupOldFiles", () => {
    it("removes files older than 30 days", () => {
      // Create a file from 3 months ago
      const oldDate = new Date();
      oldDate.setMonth(oldDate.getMonth() - 3);
      const oldKey = getMonthKey(oldDate);
      const oldFilePath = join(DATA_DIR, `${oldKey}.jsonl`);
      writeFileSync(oldFilePath, '{"ts":"old","symbol":"BTC","exchange":"hl","rate":0.01,"hourlyRate":0.01}\n');

      // Create a current month file
      const curKey = getMonthKey(new Date());
      const curFilePath = join(DATA_DIR, `${curKey}.jsonl`);
      writeFileSync(curFilePath, '{"ts":"now","symbol":"BTC","exchange":"hl","rate":0.01,"hourlyRate":0.01}\n');

      _resetCleanupFlag();
      cleanupOldFiles();

      expect(existsSync(oldFilePath)).toBe(false);
      expect(existsSync(curFilePath)).toBe(true);
    });

    it("keeps recent files", () => {
      const curKey = getMonthKey(new Date());
      const curFilePath = join(DATA_DIR, `${curKey}.jsonl`);
      writeFileSync(curFilePath, '{"ts":"now","symbol":"BTC","exchange":"hl","rate":0.01,"hourlyRate":0.01}\n');

      _resetCleanupFlag();
      cleanupOldFiles();

      expect(existsSync(curFilePath)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // getCompoundedAnnualReturn
  // ──────────────────────────────────────────────

  describe("getCompoundedAnnualReturn", () => {
    it("calculates correct compounded return for HL (1h compounding)", () => {
      // hourlyRate = 0.01% = 0.0001
      // periodRate = 0.0001 * 1 = 0.0001
      // periodsPerYear = 8760/1 = 8760
      // (1 + 0.0001)^8760 - 1
      const result = getCompoundedAnnualReturn(0.0001, 1);
      // Expected: (1.0001)^8760 - 1 = ~1.3964 (139.64%)
      expect(result).toBeCloseTo(Math.pow(1.0001, 8760) - 1, 2);
      expect(result).toBeGreaterThan(0.876); // Should be > simple rate of 87.6%
    });

    it("calculates correct compounded return for PAC/LT (1h compounding, same as HL)", () => {
      // hourlyRate = 0.0001
      // periodRate = 0.0001 * 1 = 0.0001
      // periodsPerYear = 8760/1 = 8760
      // (1 + 0.0001)^8760 - 1
      const result = getCompoundedAnnualReturn(0.0001, 1);
      expect(result).toBeCloseTo(Math.pow(1.0001, 8760) - 1, 2);
    });

    it("returns 0 for zero rate", () => {
      expect(getCompoundedAnnualReturn(0, 1)).toBe(0);
    });

    it("handles negative rates", () => {
      const result = getCompoundedAnnualReturn(-0.0001, 1);
      // (1 - 0.0001)^8760 - 1 should be negative
      expect(result).toBeLessThan(0);
      expect(result).toBeCloseTo(Math.pow(1 - 0.0001, 8760) - 1, 2);
    });

    it("all exchanges compound at the same frequency (1h)", () => {
      const hourlyRate = 0.0001;
      const hl = getCompoundedAnnualReturn(hourlyRate, 1);   // compound every 1h
      const pac = getCompoundedAnnualReturn(hourlyRate, 1);   // compound every 1h (same as HL)

      // Same compounding frequency, same effective annual return
      expect(hl).toBeCloseTo(pac, 10);
    });

    it("simple rate sanity check: small rate, compounded vs simple", () => {
      const hourlyRate = 0.0001;
      const simpleAnnual = hourlyRate * 8760; // 0.876
      const compoundedAnnual = getCompoundedAnnualReturn(hourlyRate, 1);

      // Compounded should always be greater than simple for positive rates
      expect(compoundedAnnual).toBeGreaterThan(simpleAnnual);
    });
  });

  // ──────────────────────────────────────────────
  // getExchangeCompoundingHours
  // ──────────────────────────────────────────────

  describe("getExchangeCompoundingHours", () => {
    it("returns 1 for hyperliquid", () => {
      expect(getExchangeCompoundingHours("hyperliquid")).toBe(1);
    });

    it("returns 1 for pacifica", () => {
      expect(getExchangeCompoundingHours("pacifica")).toBe(1);
    });

    it("returns 1 for lighter", () => {
      expect(getExchangeCompoundingHours("lighter")).toBe(1);
    });

    it("returns 1 for unknown exchanges", () => {
      expect(getExchangeCompoundingHours("binance")).toBe(1);
    });
  });
});
