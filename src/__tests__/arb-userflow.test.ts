import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { resolve } from "path";

// ── Imports from actual source files ──
import { toHourlyRate, computeAnnualSpread, estimateHourlyFunding } from "../funding.js";
import {
  computeNetSpread,
  computeRoundTripCostPct,
  isNearSettlement,
  isSpreadReversed,
  getNextSettlement,
} from "../commands/arb-auto.js";
import {
  getMinutesSinceSettlement,
  aggressiveSettleBoost,
  computeBasisRisk,
  formatNotifyMessage,
  sendNotification,
  notifyIfEnabled,
  getLastSettlement,
  type ArbNotifyEvent,
} from "../arb-utils.js";
import {
  loadArbState,
  saveArbState,
  addPosition,
  removePosition,
  updatePosition,
  getPositions,
  createInitialState,
  setStateFilePath,
  resetStateFilePath,
  type ArbPositionState,
  type ArbDaemonState,
} from "../arb-state.js";
import {
  computeEnhancedStats,
  normalizeExchangePair,
  getTimeBucket,
  type ArbTradeForStats,
} from "../arb-history-stats.js";
import { logExecution, readExecutionLog } from "../execution-log.js";

// ── Test file paths ──
const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const LOG_FILE = resolve(PERP_DIR, "executions.jsonl");
const LOG_BACKUP = resolve(PERP_DIR, "executions.jsonl.userflow-backup");
const TEST_STATE_DIR = resolve(PERP_DIR, "test-arb-userflow");
const TEST_STATE_FILE = resolve(TEST_STATE_DIR, "arb-state.json");

// ── Helpers ──

function makeDefaultConfig(): ArbDaemonState["config"] {
  return {
    minSpread: 30,
    closeSpread: 5,
    size: 100,
    holdDays: 7,
    bridgeCost: 0.5,
    maxPositions: 5,
    settleStrategy: "aware",
  };
}

function makePosition(overrides: Partial<ArbPositionState> = {}): ArbPositionState {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    symbol: "ETH",
    longExchange: "hyperliquid",
    shortExchange: "pacifica",
    longSize: 0.5,
    shortSize: 0.5,
    entryTime: "2025-01-15T10:00:00.000Z",
    entrySpread: 35.2,
    entryLongPrice: 3200.5,
    entryShortPrice: 3201.0,
    accumulatedFunding: 0,
    lastCheckTime: "2025-01-15T10:00:00.000Z",
    ...overrides,
  };
}

// The FundingSnapshot type is not exported from arb-auto, so we recreate it locally for tests.
interface FundingSnapshot {
  symbol: string;
  pacRate: number;
  hlRate: number;
  ltRate: number;
  spread: number;
  longExch: string;
  shortExch: string;
  markPrice: number;
}

// ─────────────────────────────────────────────────────────
// Flow 1: Spread scan → opportunity evaluation → entry decision
// ─────────────────────────────────────────────────────────

describe("Flow 1: 스프레드 스캔 → 기회 평가 → 진입 판단", () => {
  // Realistic funding rates:
  //   PAC: 0.005% per hour = 0.00005
  //   HL:  0.0001% per hour = 0.000001
  //   LT:  0.002% per hour = 0.00002
  const pacRawRate = 0.00005;
  const hlRawRate = 0.000001;
  const ltRawRate = 0.00002;

  it("toHourlyRate normalizes each exchange rate to per-hour", () => {
    const pacHourly = toHourlyRate(pacRawRate, "pacifica");
    const hlHourly = toHourlyRate(hlRawRate, "hyperliquid");
    const ltHourly = toHourlyRate(ltRawRate, "lighter");
    // All exchanges are hourly, so rates remain unchanged
    expect(pacHourly).toBe(pacRawRate);
    expect(hlHourly).toBe(hlRawRate);
    expect(ltHourly).toBe(ltRawRate);
  });

  it("computeAnnualSpread finds best pair (PAC vs HL has largest spread)", () => {
    const pacHl = computeAnnualSpread(pacRawRate, "pacifica", hlRawRate, "hyperliquid");
    const pacLt = computeAnnualSpread(pacRawRate, "pacifica", ltRawRate, "lighter");
    const hlLt = computeAnnualSpread(hlRawRate, "hyperliquid", ltRawRate, "lighter");
    // PAC-HL has the biggest difference, then PAC-LT, then HL-LT
    expect(pacHl).toBeGreaterThan(pacLt);
    expect(pacLt).toBeGreaterThan(hlLt);
    // PAC-HL: |0.00005 - 0.000001| * 8760 * 100 = 0.000049 * 876000 = 42.924%
    expect(pacHl).toBeCloseTo(42.924, 1);
  });

  it("direction is correct: long HL (low rate), short PAC (high rate)", () => {
    const pacHourly = toHourlyRate(pacRawRate, "pacifica");
    const hlHourly = toHourlyRate(hlRawRate, "hyperliquid");
    // PAC rate > HL rate → short PAC (receive funding), long HL (pay less)
    expect(pacHourly).toBeGreaterThan(hlHourly);
    // This means: longExchange = hyperliquid, shortExchange = pacifica
  });

  it("gross annual spread exceeds 30% minimum", () => {
    const grossSpread = computeAnnualSpread(pacRawRate, "pacifica", hlRawRate, "hyperliquid");
    expect(grossSpread).toBeGreaterThan(30);
  });

  it("computeRoundTripCostPct calculates trading costs", () => {
    const cost = computeRoundTripCostPct("hyperliquid", "pacifica");
    // 2 * (0.035 + 0.035) + 2 * 0.05 = 0.24%
    expect(cost).toBeCloseTo(0.24, 2);
  });

  it("computeNetSpread subtracts costs from gross spread", () => {
    const grossSpread = computeAnnualSpread(pacRawRate, "pacifica", hlRawRate, "hyperliquid");
    const roundTripCost = computeRoundTripCostPct("hyperliquid", "pacifica");
    // With a longer hold period, costs are amortized and net spread remains positive
    const holdDays = 30;
    const netSpread = computeNetSpread(grossSpread, holdDays, roundTripCost, 0.5, 100);
    // Net should be less than gross
    expect(netSpread).toBeLessThan(grossSpread);
    // Positive with a reasonable hold period
    expect(netSpread).toBeGreaterThan(0);
    // Short hold period with bridge cost can make net negative (costs exceed spread)
    const shortHoldNet = computeNetSpread(grossSpread, 1, roundTripCost, 0.5, 100);
    expect(shortHoldNet).toBeLessThan(0);
  });

  it("net spread properly accounts for bridge costs", () => {
    const grossSpread = computeAnnualSpread(pacRawRate, "pacifica", hlRawRate, "hyperliquid");
    const roundTripCost = computeRoundTripCostPct("hyperliquid", "pacifica");
    const noBridge = computeNetSpread(grossSpread, 7, roundTripCost, 0, 0);
    const withBridge = computeNetSpread(grossSpread, 7, roundTripCost, 2, 100);
    expect(withBridge).toBeLessThan(noBridge);
  });

  it("--min-spread threshold accepts good opportunity", () => {
    const grossSpread = computeAnnualSpread(pacRawRate, "pacifica", hlRawRate, "hyperliquid");
    const roundTripCost = computeRoundTripCostPct("hyperliquid", "pacifica");
    const netSpread = computeNetSpread(grossSpread, 7, roundTripCost);
    const minSpread = 30;
    expect(netSpread >= minSpread).toBe(true);
  });

  it("--min-spread threshold rejects weak opportunity", () => {
    // Use rates that produce a small spread
    const weakPacRate = 0.000012;
    const weakHlRate = 0.00001;
    const grossSpread = computeAnnualSpread(weakPacRate, "pacifica", weakHlRate, "hyperliquid");
    const roundTripCost = computeRoundTripCostPct("hyperliquid", "pacifica");
    const netSpread = computeNetSpread(grossSpread, 7, roundTripCost);
    const minSpread = 30;
    expect(netSpread >= minSpread).toBe(false);
  });

  it("longer hold period amortizes costs and increases net spread", () => {
    const grossSpread = computeAnnualSpread(pacRawRate, "pacifica", hlRawRate, "hyperliquid");
    const roundTripCost = computeRoundTripCostPct("hyperliquid", "pacifica");
    const short7d = computeNetSpread(grossSpread, 7, roundTripCost, 0.5, 100);
    const long30d = computeNetSpread(grossSpread, 30, roundTripCost, 0.5, 100);
    expect(long30d).toBeGreaterThan(short7d);
  });
});

// ─────────────────────────────────────────────────────────
// Flow 2: Daemon lifecycle — entry → funding accumulation → exit
// ─────────────────────────────────────────────────────────

describe("Flow 2: 데몬 라이프사이클 — 진입 → 펀딩 축적 → 스프레드 하락 청산", () => {
  beforeEach(() => {
    if (!existsSync(TEST_STATE_DIR)) mkdirSync(TEST_STATE_DIR, { recursive: true });
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    setStateFilePath(TEST_STATE_FILE);
    // Backup execution log
    if (existsSync(LOG_FILE)) writeFileSync(LOG_BACKUP, readFileSync(LOG_FILE, "utf-8"));
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    resetStateFilePath();
    // Restore execution log
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
    if (existsSync(LOG_BACKUP)) renameSync(LOG_BACKUP, LOG_FILE);
  });

  it("step 1: settlement timing does not block entry (mid-hour)", () => {
    // At 14:30, next settlement is 15:00 → 30 min away, not within 5 min buffer
    const now = new Date("2025-01-15T14:30:00Z");
    const result = isNearSettlement("hyperliquid", "pacifica", 5, now);
    expect(result.blocked).toBe(false);
  });

  it("step 2: aggressiveSettleBoost applies when just after settlement", () => {
    // 2 minutes after settlement at 14:00
    const now = new Date("2025-01-15T14:02:00Z");
    const boost = aggressiveSettleBoost("hyperliquid", "pacifica", 10, now);
    expect(boost).toBeGreaterThan(1.0);
    // At 2 min into 10 min window: 1 + 0.5*(1 - 2/10) = 1.4
    expect(boost).toBeCloseTo(1.4, 1);
  });

  it("step 3: entry spread passes minSpread threshold", () => {
    const pacRate = 0.00005;
    const hlRate = 0.000001;
    const grossSpread = computeAnnualSpread(pacRate, "pacifica", hlRate, "hyperliquid");
    const rtCost = computeRoundTripCostPct("hyperliquid", "pacifica");
    const netSpread = computeNetSpread(grossSpread, 7, rtCost);
    const minSpread = 30;
    expect(netSpread).toBeGreaterThanOrEqual(minSpread);
  });

  it("step 4: position tracked in arb-state after entry", () => {
    const state = createInitialState(makeDefaultConfig());
    saveArbState(state);

    const pos = makePosition({
      symbol: "BTC",
      longExchange: "hyperliquid",
      shortExchange: "pacifica",
      entrySpread: 42.9,
      longSize: 0.001,
      shortSize: 0.001,
    });
    addPosition(pos);

    const positions = getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("BTC");
    expect(positions[0].entrySpread).toBe(42.9);
  });

  it("step 5: funding accumulation over time (shortRate - longRate) x notional x hours", () => {
    const shortRate = 0.00005; // PAC rate (short side receives)
    const longRate = 0.000001; // HL rate (long side pays)
    const notionalUsd = 1000;
    const hours = 168; // 7 days

    // Short side receives positive funding
    const shortFundingPerHour = estimateHourlyFunding(shortRate, "pacifica", notionalUsd, "short");
    // Long side pays positive funding (but rate is very low)
    const longFundingPerHour = estimateHourlyFunding(longRate, "hyperliquid", notionalUsd, "long");

    // Net hourly: short receives (negative = receive), long pays (positive = pay)
    // Net = shortReceive - longPay = (-shortFunding) - longFunding
    const netPerHour = Math.abs(shortFundingPerHour) - Math.abs(longFundingPerHour);
    const totalFunding = netPerHour * hours;

    expect(netPerHour).toBeGreaterThan(0); // Positive net collection
    expect(totalFunding).toBeCloseTo((shortRate - longRate) * notionalUsd * hours, 4);
    // (0.00005 - 0.000001) * 1000 * 168 = 0.000049 * 168000 = 8.232
    expect(totalFunding).toBeCloseTo(8.232, 2);
  });

  it("step 6+7: spread drops below closeSpread, not reversed → exit", () => {
    const closeSpread = 5;

    // Current spread dropped to 3%
    const currentGross = 3;
    const rtCost = computeRoundTripCostPct("hyperliquid", "pacifica");
    // For exit check we compare gross spread to closeSpread threshold
    expect(currentGross <= closeSpread).toBe(true);

    // Verify spread is NOT reversed (short still has higher rate)
    const snapshot: FundingSnapshot = {
      symbol: "BTC",
      pacRate: 0.000015, // still higher than HL
      hlRate: 0.000012,
      ltRate: 0.000013,
      spread: currentGross,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 100000,
    };
    const reversed = isSpreadReversed("hyperliquid", "pacifica", snapshot);
    expect(reversed).toBe(false);
  });

  it("step 8+9: position removed and exit logged", () => {
    const state = createInitialState(makeDefaultConfig());
    saveArbState(state);
    addPosition(makePosition({ symbol: "BTC" }));

    // Remove the position
    removePosition("BTC");
    const positions = getPositions();
    expect(positions).toHaveLength(0);

    // Log the exit
    const exitRecord = logExecution({
      type: "arb_close",
      exchange: "hyperliquid+pacifica",
      symbol: "BTC",
      side: "close",
      size: "0.001",
      status: "success",
      dryRun: false,
      meta: { exitReason: "spread", netPnl: 8.23 },
    });
    expect(exitRecord.type).toBe("arb_close");
    expect(exitRecord.meta?.exitReason).toBe("spread");

    const records = readExecutionLog({ type: "arb_close" });
    expect(records).toHaveLength(1);
    expect(records[0].meta?.exitReason).toBe("spread");
  });
});

// ─────────────────────────────────────────────────────────
// Flow 3: Reversal → emergency close
// ─────────────────────────────────────────────────────────

describe("Flow 3: 리버설 발생 → 긴급 청산", () => {
  beforeEach(() => {
    if (!existsSync(TEST_STATE_DIR)) mkdirSync(TEST_STATE_DIR, { recursive: true });
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    setStateFilePath(TEST_STATE_FILE);
    if (existsSync(LOG_FILE)) writeFileSync(LOG_BACKUP, readFileSync(LOG_FILE, "utf-8"));
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    resetStateFilePath();
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
    if (existsSync(LOG_BACKUP)) renameSync(LOG_BACKUP, LOG_FILE);
  });

  it("detects reversal when long rate exceeds short rate", () => {
    // Originally: long HL (low rate), short PAC (high rate)
    // Reversed: HL rate now HIGHER than PAC rate
    const snapshot: FundingSnapshot = {
      symbol: "ETH",
      pacRate: 0.00001,  // PAC rate dropped
      hlRate: 0.00005,   // HL rate surged
      ltRate: 0.00002,
      spread: 35,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 3200,
    };
    const reversed = isSpreadReversed("hyperliquid", "pacifica", snapshot);
    expect(reversed).toBe(true);
  });

  it("no reversal when short rate is still higher", () => {
    const snapshot: FundingSnapshot = {
      symbol: "ETH",
      pacRate: 0.00005,
      hlRate: 0.000001,
      ltRate: 0.00002,
      spread: 42,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 3200,
    };
    const reversed = isSpreadReversed("hyperliquid", "pacifica", snapshot);
    expect(reversed).toBe(false);
  });

  it("full reversal flow: position open → reversal detected → exit logged → notification sent", async () => {
    // Step 1: Position is open
    const state = createInitialState(makeDefaultConfig());
    saveArbState(state);
    addPosition(makePosition({
      symbol: "WIF",
      longExchange: "hyperliquid",
      shortExchange: "pacifica",
      entrySpread: 45,
    }));
    expect(getPositions()).toHaveLength(1);

    // Step 2: Reversal detected
    const snapshot: FundingSnapshot = {
      symbol: "WIF",
      pacRate: 0.000005,
      hlRate: 0.00008,
      ltRate: 0.00003,
      spread: 65,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 2.5,
    };
    expect(isSpreadReversed("hyperliquid", "pacifica", snapshot)).toBe(true);

    // Step 3: Exit logged with exitReason="reversal"
    const exitRecord = logExecution({
      type: "arb_close",
      exchange: "hyperliquid+pacifica",
      symbol: "WIF",
      side: "close",
      size: "100",
      status: "success",
      dryRun: false,
      meta: { exitReason: "reversal" },
    });
    expect(exitRecord.meta?.exitReason).toBe("reversal");

    // Step 4: Notification contains reversal info
    const msg = formatNotifyMessage("reversal", { symbol: "WIF" });
    expect(msg).toContain("REVERSAL");
    expect(msg).toContain("WIF");
    expect(msg).toContain("emergency close");

    // Step 5: Notification sent with correct filtering
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    await notifyIfEnabled(
      "https://discord.com/api/webhooks/test/abc",
      ["reversal", "entry", "exit"],
      "reversal",
      { symbol: "WIF" },
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).toHaveBeenCalledOnce();

    // Step 6: Position removed from state
    removePosition("WIF");
    expect(getPositions()).toHaveLength(0);
  });

  it("notifyIfEnabled skips notification when event type not in enabled list", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    await notifyIfEnabled(
      "https://discord.com/api/webhooks/test/abc",
      ["entry", "exit"], // reversal NOT included
      "reversal",
      { symbol: "WIF" },
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("notifyIfEnabled skips notification when no webhook URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    await notifyIfEnabled(
      undefined,
      ["reversal"],
      "reversal",
      { symbol: "WIF" },
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────
// Flow 4: Arb history stats analysis
// ─────────────────────────────────────────────────────────

describe("Flow 4: arb history 통계 분석", () => {
  beforeEach(() => {
    if (existsSync(LOG_FILE)) writeFileSync(LOG_BACKUP, readFileSync(LOG_FILE, "utf-8"));
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
  });

  afterEach(() => {
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
    if (existsSync(LOG_BACKUP)) renameSync(LOG_BACKUP, LOG_FILE);
  });

  it("step 1-4: log arb entries and closes, read them back", () => {
    // 3 arb_entry records
    logExecution({
      type: "arb_entry", exchange: "hyperliquid+pacifica", symbol: "BTC",
      side: "entry", size: "0.01", status: "success", dryRun: false,
      meta: { entrySpread: 45, longExchange: "hyperliquid", shortExchange: "pacifica" },
    });
    logExecution({
      type: "arb_entry", exchange: "lighter+pacifica", symbol: "ETH",
      side: "entry", size: "1.0", status: "success", dryRun: false,
      meta: { entrySpread: 35, longExchange: "lighter", shortExchange: "pacifica" },
    });
    logExecution({
      type: "arb_entry", exchange: "hyperliquid+lighter", symbol: "SOL",
      side: "entry", size: "50", status: "success", dryRun: false,
      meta: { entrySpread: 55, longExchange: "hyperliquid", shortExchange: "lighter" },
    });

    // 2 arb_close records (1 winner, 1 loser)
    logExecution({
      type: "arb_close", exchange: "hyperliquid+pacifica", symbol: "BTC",
      side: "close", size: "0.01", status: "success", dryRun: false,
      meta: { exitReason: "spread", netPnl: 15.5 },
    });
    logExecution({
      type: "arb_close", exchange: "lighter+pacifica", symbol: "ETH",
      side: "close", size: "1.0", status: "success", dryRun: false,
      meta: { exitReason: "reversal", netPnl: -3.2 },
    });
    // SOL is still open (no close record)

    const entries = readExecutionLog({ type: "arb_entry" });
    expect(entries).toHaveLength(3);

    const closes = readExecutionLog({ type: "arb_close" });
    expect(closes).toHaveLength(2);
  });

  it("step 5-6: computeEnhancedStats produces correct metrics", () => {
    // Build trades for stats
    const trades: ArbTradeForStats[] = [
      {
        symbol: "BTC",
        exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-10T02:00:00Z", // 00-04 UTC bucket
        exitDate: "2025-01-17T02:00:00Z",
        holdDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        entrySpread: 45,
        exitSpread: 3,
        netReturn: 15.5,
        status: "completed",
      },
      {
        symbol: "ETH",
        exchanges: "lighter+pacifica",
        entryDate: "2025-01-12T10:00:00Z", // 08-12 UTC bucket
        exitDate: "2025-01-14T10:00:00Z",
        holdDurationMs: 2 * 24 * 60 * 60 * 1000, // 2 days
        entrySpread: 35,
        exitSpread: 10,
        netReturn: -3.2,
        status: "completed",
      },
      {
        symbol: "SOL",
        exchanges: "hyperliquid+lighter",
        entryDate: "2025-01-15T22:00:00Z", // 20-24 UTC bucket
        exitDate: null,
        holdDurationMs: 0,
        entrySpread: 55,
        exitSpread: null,
        netReturn: 0,
        status: "open",
      },
    ];

    const stats = computeEnhancedStats(trades);

    // Only completed trades are included in stats
    // avgEntrySpread: (45 + 35) / 2 = 40
    expect(stats.avgEntrySpread).toBeCloseTo(40, 1);
    // avgExitSpread: (3 + 10) / 2 = 6.5
    expect(stats.avgExitSpread).toBeCloseTo(6.5, 1);
    // avgSpreadDecay: ((45-3) + (35-10)) / 2 = (42 + 25) / 2 = 33.5
    expect(stats.avgSpreadDecay).toBeCloseTo(33.5, 1);
  });

  it("step 6: byExchangePair groups correctly", () => {
    const trades: ArbTradeForStats[] = [
      {
        symbol: "BTC", exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-10T02:00:00Z", exitDate: "2025-01-17T02:00:00Z",
        holdDurationMs: 7 * 24 * 3600000, entrySpread: 45, exitSpread: 3,
        netReturn: 15.5, status: "completed",
      },
      {
        symbol: "WIF", exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-11T06:00:00Z", exitDate: "2025-01-13T06:00:00Z",
        holdDurationMs: 2 * 24 * 3600000, entrySpread: 50, exitSpread: 8,
        netReturn: 5.0, status: "completed",
      },
      {
        symbol: "ETH", exchanges: "lighter+pacifica",
        entryDate: "2025-01-12T10:00:00Z", exitDate: "2025-01-14T10:00:00Z",
        holdDurationMs: 2 * 24 * 3600000, entrySpread: 35, exitSpread: 10,
        netReturn: -3.2, status: "completed",
      },
    ];

    const stats = computeEnhancedStats(trades);
    // HL/PAC should have 2 trades, LT/PAC should have 1
    expect(stats.byExchangePair).toHaveLength(2);
    const hlPac = stats.byExchangePair.find(p => p.pair === "HL/PAC");
    expect(hlPac).toBeDefined();
    expect(hlPac!.trades).toBe(2);
    expect(hlPac!.winRate).toBe(100); // both winners

    const ltPac = stats.byExchangePair.find(p => p.pair === "LT/PAC");
    expect(ltPac).toBeDefined();
    expect(ltPac!.trades).toBe(1);
    expect(ltPac!.winRate).toBe(0); // loser
  });

  it("step 6: byTimeOfDay buckets entries correctly", () => {
    const trades: ArbTradeForStats[] = [
      {
        symbol: "BTC", exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-10T02:00:00Z", exitDate: "2025-01-17T02:00:00Z",
        holdDurationMs: 7 * 24 * 3600000, entrySpread: 45, exitSpread: 3,
        netReturn: 15.5, status: "completed",
      },
      {
        symbol: "ETH", exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-12T03:30:00Z", exitDate: "2025-01-14T10:00:00Z",
        holdDurationMs: 2 * 24 * 3600000, entrySpread: 35, exitSpread: 10,
        netReturn: -3.2, status: "completed",
      },
    ];

    const stats = computeEnhancedStats(trades);
    // Both entries are in 00-04 UTC bucket
    const bucket0004 = stats.byTimeOfDay.find(b => b.bucket === "00-04 UTC");
    expect(bucket0004).toBeDefined();
    expect(bucket0004!.trades).toBe(2);
  });

  it("step 6: optimalHoldTime is median of profitable trades", () => {
    const trades: ArbTradeForStats[] = [
      {
        symbol: "A", exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-01T00:00:00Z", exitDate: "2025-01-04T00:00:00Z",
        holdDurationMs: 3 * 24 * 3600000, entrySpread: 40, exitSpread: 3,
        netReturn: 10, status: "completed",
      },
      {
        symbol: "B", exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-01T00:00:00Z", exitDate: "2025-01-08T00:00:00Z",
        holdDurationMs: 7 * 24 * 3600000, entrySpread: 50, exitSpread: 4,
        netReturn: 20, status: "completed",
      },
      {
        symbol: "C", exchanges: "hyperliquid+pacifica",
        entryDate: "2025-01-01T00:00:00Z", exitDate: "2025-01-03T00:00:00Z",
        holdDurationMs: 2 * 24 * 3600000, entrySpread: 30, exitSpread: 15,
        netReturn: -5, status: "completed",  // loser, excluded from optimal calc
      },
    ];

    const stats = computeEnhancedStats(trades);
    // Only profitable: A (3d) and B (7d) → median = (3+7)/2 = 5 days
    const fiveDaysMs = 5 * 24 * 3600000;
    expect(stats.optimalHoldTimeMs).toBeCloseTo(fiveDaysMs, -3);
    expect(stats.optimalHoldTime).toBe("5d 0h");
  });

  it("step 7: exitReason appears in close records", () => {
    logExecution({
      type: "arb_close", exchange: "hyperliquid+pacifica", symbol: "BTC",
      side: "close", size: "0.01", status: "success", dryRun: false,
      meta: { exitReason: "spread" },
    });
    logExecution({
      type: "arb_close", exchange: "lighter+pacifica", symbol: "ETH",
      side: "close", size: "1.0", status: "success", dryRun: false,
      meta: { exitReason: "reversal" },
    });

    const closes = readExecutionLog({ type: "arb_close" });
    const reasons = closes.map(r => r.meta?.exitReason);
    expect(reasons).toContain("spread");
    expect(reasons).toContain("reversal");
  });

  it("normalizeExchangePair produces consistent abbreviations", () => {
    expect(normalizeExchangePair("hyperliquid+pacifica")).toBe("HL/PAC");
    expect(normalizeExchangePair("pacifica+hyperliquid")).toBe("HL/PAC"); // sorted
    expect(normalizeExchangePair("lighter+pacifica")).toBe("LT/PAC");
    expect(normalizeExchangePair("hyperliquid+lighter")).toBe("HL/LT");
  });

  it("getTimeBucket returns correct 4-hour UTC buckets", () => {
    expect(getTimeBucket("2025-01-10T00:30:00Z")).toBe("00-04 UTC");
    expect(getTimeBucket("2025-01-10T03:59:59Z")).toBe("00-04 UTC");
    expect(getTimeBucket("2025-01-10T04:00:00Z")).toBe("04-08 UTC");
    expect(getTimeBucket("2025-01-10T12:00:00Z")).toBe("12-16 UTC");
    expect(getTimeBucket("2025-01-10T23:59:59Z")).toBe("20-24 UTC");
  });
});

// ─────────────────────────────────────────────────────────
// Flow 5: Basis risk monitoring
// ─────────────────────────────────────────────────────────

describe("Flow 5: 베이시스 리스크 모니터링", () => {
  it("no warning when prices are close together", () => {
    const result = computeBasisRisk(100000, 100050, 3);
    // |100000 - 100050| / 100025 * 100 ≈ 0.05% → no warning
    expect(result.divergencePct).toBeLessThan(1);
    expect(result.warning).toBe(false);
  });

  it("warning when 4% divergence", () => {
    const result = computeBasisRisk(100000, 104000, 3);
    // |100000 - 104000| / 102000 * 100 ≈ 3.92% → warning (> 3%)
    expect(result.divergencePct).toBeCloseTo(3.92, 1);
    expect(result.warning).toBe(true);
  });

  it("threshold is configurable: tight threshold triggers warning on smaller divergence", () => {
    // 1% divergence with 0.5% threshold
    const result = computeBasisRisk(100, 101, 0.5);
    expect(result.warning).toBe(true);
    expect(result.divergencePct).toBeCloseTo(1.0, 0);
  });

  it("threshold is configurable: loose threshold does not trigger on moderate divergence", () => {
    // 2% divergence with 5% threshold
    const result = computeBasisRisk(100, 102, 5);
    expect(result.warning).toBe(false);
    expect(result.divergencePct).toBeCloseTo(1.98, 1);
  });

  it("basis risk notification is formatted correctly", () => {
    const msg = formatNotifyMessage("basis", {
      symbol: "BTC",
      divergencePct: 4.2,
      longExchange: "HL",
      shortExchange: "PAC",
    });
    expect(msg).toContain("BASIS RISK");
    expect(msg).toContain("BTC");
    expect(msg).toContain("4.2%");
    expect(msg).toContain("HL/PAC");
  });

  it("zero or negative prices return safe defaults", () => {
    expect(computeBasisRisk(0, 100).warning).toBe(false);
    expect(computeBasisRisk(100, 0).warning).toBe(false);
    expect(computeBasisRisk(0, 0).warning).toBe(false);
    expect(computeBasisRisk(-1, 100).warning).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// Flow 6: Crash recovery scenario
// ─────────────────────────────────────────────────────────

describe("Flow 6: 크래시 복구 시나리오", () => {
  const TMP_FILE = TEST_STATE_FILE + ".tmp";

  beforeEach(() => {
    if (!existsSync(TEST_STATE_DIR)) mkdirSync(TEST_STATE_DIR, { recursive: true });
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
    setStateFilePath(TEST_STATE_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
    resetStateFilePath();
  });

  it("step 1-2: create state, add BTC and ETH positions", () => {
    const state = createInitialState(makeDefaultConfig());
    saveArbState(state);

    addPosition(makePosition({
      symbol: "BTC",
      longExchange: "hyperliquid",
      shortExchange: "pacifica",
      longSize: 0.01,
      shortSize: 0.01,
      accumulatedFunding: 5.67,
    }));
    addPosition(makePosition({
      symbol: "ETH",
      longExchange: "lighter",
      shortExchange: "pacifica",
      longSize: 0.5,
      shortSize: 0.5,
      accumulatedFunding: 12.34,
    }));

    const positions = getPositions();
    expect(positions).toHaveLength(2);
  });

  it("step 3-4: crash recovery — positions preserved after reload", () => {
    // Set up state with positions
    const state = createInitialState(makeDefaultConfig());
    state.lastSuccessfulScanTime = "2025-01-15T14:30:00.000Z";
    saveArbState(state);

    addPosition(makePosition({
      symbol: "BTC",
      accumulatedFunding: 5.67,
    }));
    addPosition(makePosition({
      symbol: "ETH",
      accumulatedFunding: 12.34,
    }));

    // Simulate crash: just reload
    const recovered = loadArbState();
    expect(recovered).not.toBeNull();
    expect(recovered!.positions).toHaveLength(2);

    const btc = recovered!.positions.find(p => p.symbol === "BTC");
    const eth = recovered!.positions.find(p => p.symbol === "ETH");
    expect(btc!.accumulatedFunding).toBe(5.67);
    expect(eth!.accumulatedFunding).toBe(12.34);
  });

  it("step 5: lastSuccessfulScanTime preserved", () => {
    const state = createInitialState(makeDefaultConfig());
    state.lastSuccessfulScanTime = "2025-01-15T14:30:00.000Z";
    saveArbState(state);

    const recovered = loadArbState();
    expect(recovered!.lastSuccessfulScanTime).toBe("2025-01-15T14:30:00.000Z");
  });

  it("step 6: corrupt main file → .tmp recovery works", () => {
    // Write valid state to .tmp
    const state = createInitialState(makeDefaultConfig());
    state.positions.push(makePosition({
      symbol: "SOL",
      accumulatedFunding: 99.99,
    }));
    writeFileSync(TMP_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

    // Corrupt main file
    writeFileSync(TEST_STATE_FILE, "corrupted{{{data", { mode: 0o600 });

    // Recovery should use .tmp
    const recovered = loadArbState();
    expect(recovered).not.toBeNull();
    expect(recovered!.positions).toHaveLength(1);
    expect(recovered!.positions[0].symbol).toBe("SOL");
    expect(recovered!.positions[0].accumulatedFunding).toBe(99.99);
  });

  it("both main and .tmp corrupted → returns null (no crash)", () => {
    writeFileSync(TEST_STATE_FILE, "corrupt main{{{", { mode: 0o600 });
    writeFileSync(TMP_FILE, "corrupt tmp{{{", { mode: 0o600 });

    const state = loadArbState();
    expect(state).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// Flow 7: Heartbeat + exchange down scenario
// ─────────────────────────────────────────────────────────

describe("Flow 7: 하트비트 + 거래소 다운 시나리오", () => {
  beforeEach(() => {
    if (!existsSync(TEST_STATE_DIR)) mkdirSync(TEST_STATE_DIR, { recursive: true });
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    setStateFilePath(TEST_STATE_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    resetStateFilePath();
  });

  it("heartbeat: detects stale scan time (6 min ago exceeds 5 min threshold)", () => {
    const now = new Date("2025-01-15T14:36:00Z");
    const lastScanTime = "2025-01-15T14:30:00Z";
    const minutesAgo = (now.getTime() - new Date(lastScanTime).getTime()) / (1000 * 60);
    expect(minutesAgo).toBe(6);

    const threshold = 5;
    const isStale = minutesAgo > threshold;
    expect(isStale).toBe(true);
  });

  it("heartbeat: formats warning message correctly", () => {
    const msg = formatNotifyMessage("heartbeat", {
      lastScanTime: "2025-01-15T14:30:00Z",
      minutesAgo: 6,
    });
    expect(msg).toContain("HEARTBEAT");
    expect(msg).toContain("6 minutes");
    expect(msg).toContain("2025-01-15T14:30:00Z");
  });

  it("heartbeat: no warning when scan time is recent", () => {
    const now = new Date("2025-01-15T14:31:00Z");
    const lastScanTime = "2025-01-15T14:30:00Z";
    const minutesAgo = (now.getTime() - new Date(lastScanTime).getTime()) / (1000 * 60);
    expect(minutesAgo).toBe(1);
    const isStale = minutesAgo > 5;
    expect(isStale).toBe(false);
  });

  it("blocked exchange prevents new entry (maxPositions simulated with state)", () => {
    const state = createInitialState({
      ...makeDefaultConfig(),
      maxPositions: 2,
    });
    saveArbState(state);

    // Add 2 positions — reaching max
    addPosition(makePosition({ symbol: "BTC" }));
    addPosition(makePosition({ symbol: "ETH" }));

    const positions = getPositions();
    const canEnter = positions.length < state.config.maxPositions;
    expect(canEnter).toBe(false);
  });

  it("positions on down exchange are tracked for degraded state", () => {
    const state = createInitialState(makeDefaultConfig());
    saveArbState(state);

    addPosition(makePosition({
      symbol: "ETH",
      longExchange: "hyperliquid",
      shortExchange: "pacifica",
    }));
    addPosition(makePosition({
      symbol: "BTC",
      longExchange: "lighter",
      shortExchange: "pacifica",
    }));

    const positions = getPositions();
    const downExchange = "lighter";
    const degradedPositions = positions.filter(
      p => p.longExchange === downExchange || p.shortExchange === downExchange,
    );
    expect(degradedPositions).toHaveLength(1);
    expect(degradedPositions[0].symbol).toBe("BTC");
  });

  it("heartbeat notification is sent for stale scans", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    await notifyIfEnabled(
      "https://discord.com/api/webhooks/test/hb",
      ["heartbeat", "reversal"],
      "heartbeat",
      { lastScanTime: "2025-01-15T14:30:00Z", minutesAgo: 6 },
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toContain("HEARTBEAT");
  });

  it("settlement timing: isNearSettlement blocks when within 5 minutes of next hour", () => {
    // At 14:56, next settlement for hourly exchange is 15:00 → 4 min away → blocked
    const now = new Date("2025-01-15T14:56:00Z");
    const result = isNearSettlement("hyperliquid", "pacifica", 5, now);
    expect(result.blocked).toBe(true);
    expect(result.minutesUntil).toBeCloseTo(4, 0);
  });

  it("settlement timing: not blocked when far from settlement", () => {
    const now = new Date("2025-01-15T14:30:00Z");
    const result = isNearSettlement("hyperliquid", "pacifica", 5, now);
    expect(result.blocked).toBe(false);
  });

  it("getNextSettlement returns correct next hour", () => {
    const now = new Date("2025-01-15T14:30:00Z");
    const next = getNextSettlement("hyperliquid", now);
    expect(next.getUTCHours()).toBe(15);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("getLastSettlement returns previous hour boundary", () => {
    const now = new Date("2025-01-15T14:30:00Z");
    const last = getLastSettlement("hyperliquid", now);
    expect(last.getUTCHours()).toBe(14);
    expect(last.getUTCMinutes()).toBe(0);
  });

  it("getMinutesSinceSettlement returns correct value mid-hour", () => {
    const now = new Date("2025-01-15T14:45:00Z");
    const mins = getMinutesSinceSettlement("hyperliquid", now);
    expect(mins).toBeCloseTo(45, 0);
  });
});

// ─────────────────────────────────────────────────────────
// Edge cases and additional cross-cutting scenarios
// ─────────────────────────────────────────────────────────

describe("Cross-cutting: edge cases and combined scenarios", () => {
  beforeEach(() => {
    if (!existsSync(TEST_STATE_DIR)) mkdirSync(TEST_STATE_DIR, { recursive: true });
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    setStateFilePath(TEST_STATE_FILE);
    if (existsSync(LOG_FILE)) writeFileSync(LOG_BACKUP, readFileSync(LOG_FILE, "utf-8"));
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
    if (existsSync(TEST_STATE_FILE + ".tmp")) unlinkSync(TEST_STATE_FILE + ".tmp");
    resetStateFilePath();
    if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
    if (existsSync(LOG_BACKUP)) renameSync(LOG_BACKUP, LOG_FILE);
  });

  it("computeNetSpread returns negative for tiny spread with high costs", () => {
    // Gross spread of 5%, high round-trip cost of 1%, hold 1 day
    // Annualized cost: (1/1)*365 = 365%  →  net = 5 - 365 = -360%
    const net = computeNetSpread(5, 1, 1);
    expect(net).toBeLessThan(0);
  });

  it("isSpreadReversed handles lighter as long exchange", () => {
    const snapshot: FundingSnapshot = {
      symbol: "SOL",
      pacRate: 0.00001,
      hlRate: 0.00002,
      ltRate: 0.00005, // LT rate surged past PAC
      spread: 35,
      longExch: "lighter",
      shortExch: "pacifica",
      markPrice: 150,
    };
    // Long LT at 0.00005, short PAC at 0.00001 → longHourly > shortHourly → reversed
    expect(isSpreadReversed("lighter", "pacifica", snapshot)).toBe(true);
  });

  it("full entry+exit pipeline logs both records with matching symbols", () => {
    const state = createInitialState(makeDefaultConfig());
    saveArbState(state);

    // Entry
    addPosition(makePosition({ symbol: "DOGE", entrySpread: 60 }));
    const entryRec = logExecution({
      type: "arb_entry", exchange: "hyperliquid+pacifica", symbol: "DOGE",
      side: "entry", size: "1000", status: "success", dryRun: false,
      meta: { entrySpread: 60 },
    });

    // Some time passes, then exit
    removePosition("DOGE");
    const exitRec = logExecution({
      type: "arb_close", exchange: "hyperliquid+pacifica", symbol: "DOGE",
      side: "close", size: "1000", status: "success", dryRun: false,
      meta: { exitReason: "spread", netPnl: 25.0 },
    });

    // Read back
    const dogeRecords = readExecutionLog({ symbol: "DOGE" });
    expect(dogeRecords).toHaveLength(2);
    const types = dogeRecords.map(r => r.type).sort();
    expect(types).toEqual(["arb_close", "arb_entry"]);
  });

  it("updatePosition tracks accumulated funding over time", () => {
    const state = createInitialState(makeDefaultConfig());
    saveArbState(state);

    addPosition(makePosition({ symbol: "ETH", accumulatedFunding: 0 }));

    // Simulate hourly funding updates
    updatePosition("ETH", { accumulatedFunding: 0.05, lastCheckTime: "2025-01-15T11:00:00Z" });
    updatePosition("ETH", { accumulatedFunding: 0.10, lastCheckTime: "2025-01-15T12:00:00Z" });
    updatePosition("ETH", { accumulatedFunding: 0.15, lastCheckTime: "2025-01-15T13:00:00Z" });

    const positions = getPositions();
    expect(positions[0].accumulatedFunding).toBe(0.15);
    expect(positions[0].lastCheckTime).toBe("2025-01-15T13:00:00Z");
  });
});
