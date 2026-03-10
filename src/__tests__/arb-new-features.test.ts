import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

// ── Imports from actual source files ──
import {
  formatNotifyMessage,
  notifyIfEnabled,
  type ArbNotifyEvent,
} from "../arb-utils.js";
import {
  loadArbState,
  saveArbState,
  createInitialState,
  setStateFilePath,
  resetStateFilePath,
  type ArbDaemonState,
} from "../arb-state.js";
import {
  computeNetSpread,
  computeRoundTripCostPct,
  isNearSettlement,
  isSpreadReversed,
  getNextSettlement,
} from "../commands/arb-auto.js";
import { computeEnhancedStats, type ArbTradeForStats } from "../arb-history-stats.js";
import type { ExecutionRecord } from "../execution-log.js";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Promise.allSettled rollback logic (mock-based)
// ══════════════════════════════════════════════════════════════════════════════

describe("Promise.allSettled rollback logic", () => {
  /**
   * Re-implements the decision logic from arb-auto.ts daemon cycle:
   * After calling Promise.allSettled on [longOrder, shortOrder], determine
   * what action to take based on the settlement results.
   */
  function evaluateDualLegResult(
    longResult: PromiseSettledResult<unknown>,
    shortResult: PromiseSettledResult<unknown>,
  ): { action: "success" | "rollback" | "both_failed"; filledSide?: "long" | "short"; failedSide?: "long" | "short" } {
    const longOk = longResult.status === "fulfilled";
    const shortOk = shortResult.status === "fulfilled";

    if (longOk && shortOk) {
      return { action: "success" };
    } else if (longOk !== shortOk) {
      const filledSide = longOk ? "long" as const : "short" as const;
      const failedSide = longOk ? "short" as const : "long" as const;
      return { action: "rollback", filledSide, failedSide };
    } else {
      return { action: "both_failed" };
    }
  }

  it("both fulfilled -> indicates success", () => {
    const longResult: PromiseSettledResult<string> = { status: "fulfilled", value: "order-123" };
    const shortResult: PromiseSettledResult<string> = { status: "fulfilled", value: "order-456" };
    const result = evaluateDualLegResult(longResult, shortResult);
    expect(result.action).toBe("success");
    expect(result.filledSide).toBeUndefined();
    expect(result.failedSide).toBeUndefined();
  });

  it("long fulfilled, short rejected -> should attempt rollback of long", () => {
    const longResult: PromiseSettledResult<string> = { status: "fulfilled", value: "order-123" };
    const shortResult: PromiseSettledResult<string> = { status: "rejected", reason: new Error("insufficient margin") };
    const result = evaluateDualLegResult(longResult, shortResult);
    expect(result.action).toBe("rollback");
    expect(result.filledSide).toBe("long");
    expect(result.failedSide).toBe("short");
  });

  it("short fulfilled, long rejected -> should attempt rollback of short", () => {
    const longResult: PromiseSettledResult<string> = { status: "rejected", reason: new Error("timeout") };
    const shortResult: PromiseSettledResult<string> = { status: "fulfilled", value: "order-789" };
    const result = evaluateDualLegResult(longResult, shortResult);
    expect(result.action).toBe("rollback");
    expect(result.filledSide).toBe("short");
    expect(result.failedSide).toBe("long");
  });

  it("both rejected -> indicates both failed, no rollback needed", () => {
    const longResult: PromiseSettledResult<string> = { status: "rejected", reason: new Error("exchange down") };
    const shortResult: PromiseSettledResult<string> = { status: "rejected", reason: new Error("rate limited") };
    const result = evaluateDualLegResult(longResult, shortResult);
    expect(result.action).toBe("both_failed");
    expect(result.filledSide).toBeUndefined();
    expect(result.failedSide).toBeUndefined();
  });

  it("rollback action determines correct reverse order direction", () => {
    // In arb-auto.ts: rollbackAction = longOk ? "sell" : "buy"
    const longOk = true;
    const shortOk = false;
    const rollbackAction = longOk ? "sell" : "buy";
    expect(rollbackAction).toBe("sell"); // reverse the long (buy) with a sell
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. --min-size threshold
// ══════════════════════════════════════════════════════════════════════════════

describe("--min-size threshold", () => {
  /**
   * Re-implements the min-size gate from arb-auto.ts:
   * if (sizeIsAuto && actualSizeUsd < minSizeUsd) { continue; }
   */
  function shouldSkipForMinSize(
    sizeIsAuto: boolean,
    actualSizeUsd: number,
    minSizeUsd: number,
  ): boolean {
    if (sizeIsAuto && actualSizeUsd < minSizeUsd) return true;
    return false;
  }

  it("auto-size $25 with min-size $30 -> should skip (below floor)", () => {
    expect(shouldSkipForMinSize(true, 25, 30)).toBe(true);
  });

  it("auto-size $50 with min-size $30 -> should proceed", () => {
    expect(shouldSkipForMinSize(true, 50, 30)).toBe(false);
  });

  it("auto-size $30 with min-size $30 -> should proceed (exact boundary)", () => {
    expect(shouldSkipForMinSize(true, 30, 30)).toBe(false);
  });

  it("non-auto mode ignores min-size even when size is below threshold", () => {
    // When sizeIsAuto is false (fixed size mode), min-size check is skipped
    expect(shouldSkipForMinSize(false, 25, 30)).toBe(false);
    expect(shouldSkipForMinSize(false, 10, 30)).toBe(false);
  });

  it("auto-size $0 with any min-size -> should skip", () => {
    expect(shouldSkipForMinSize(true, 0, 30)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Heartbeat notification
// ══════════════════════════════════════════════════════════════════════════════

describe("Heartbeat notification", () => {
  it("formatNotifyMessage('heartbeat') returns proper message with minutes and last scan time", () => {
    const msg = formatNotifyMessage("heartbeat", {
      lastScanTime: "2025-01-15T10:30:00.000Z",
      minutesAgo: 12,
    });
    expect(msg).toContain("HEARTBEAT");
    expect(msg).toContain("12");
    expect(msg).toContain("2025-01-15T10:30:00.000Z");
  });

  it("heartbeat message includes 'minutes' wording", () => {
    const msg = formatNotifyMessage("heartbeat", {
      lastScanTime: "2025-01-15T08:00:00.000Z",
      minutesAgo: 7,
    });
    expect(msg).toContain("minutes");
    expect(msg).toContain("7");
  });

  it("notifyIfEnabled with 'heartbeat' in events -> sends notification", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const events: ArbNotifyEvent[] = ["entry", "exit", "heartbeat"];
    await notifyIfEnabled(
      "https://discord.com/api/webhooks/123/abc",
      events,
      "heartbeat",
      { lastScanTime: "2025-01-15T10:00:00Z", minutesAgo: 10 },
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toContain("HEARTBEAT");
  });

  it("notifyIfEnabled with 'heartbeat' NOT in events -> does not send", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const events: ArbNotifyEvent[] = ["entry", "exit", "reversal"];
    await notifyIfEnabled(
      "https://discord.com/api/webhooks/123/abc",
      events,
      "heartbeat",
      { lastScanTime: "2025-01-15T10:00:00Z", minutesAgo: 10 },
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("notifyIfEnabled with empty events list -> sends (empty = all events)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    // Empty events list means "all events enabled"
    await notifyIfEnabled(
      "https://discord.com/api/webhooks/123/abc",
      [],
      "heartbeat",
      { lastScanTime: "2025-01-15T10:00:00Z", minutesAgo: 5 },
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Exit reason tagging
// ══════════════════════════════════════════════════════════════════════════════

describe("Exit reason tagging", () => {
  /**
   * Re-implements the exit reason derivation from arb-auto.ts:
   * const exitReason = closeReason.includes("REVERSAL") ? "reversal"
   *   : closeReason.includes("spread") ? "spread"
   *   : "manual";
   */
  function deriveExitReason(closeReason: string): "reversal" | "spread" | "manual" {
    if (closeReason.includes("REVERSAL")) return "reversal";
    if (closeReason.includes("spread")) return "spread";
    return "manual";
  }

  it("closeReason containing 'REVERSAL' -> exitReason = 'reversal'", () => {
    const reason = "REVERSAL DETECTED — long exchange now has higher rate than short";
    expect(deriveExitReason(reason)).toBe("reversal");
  });

  it("closeReason containing 'spread' -> exitReason = 'spread'", () => {
    const reason = "spread 3.2% <= 5%";
    expect(deriveExitReason(reason)).toBe("spread");
  });

  it("manual close -> exitReason = 'manual'", () => {
    const reason = "user requested close";
    expect(deriveExitReason(reason)).toBe("manual");
  });

  it("empty closeReason -> exitReason = 'manual'", () => {
    expect(deriveExitReason("")).toBe("manual");
  });

  it("exitReason appears in execution log meta structure", () => {
    // Verify the expected shape of an arb_close execution record with exitReason
    const record: Partial<ExecutionRecord> = {
      type: "arb_close",
      exchange: "hyperliquid+pacifica",
      symbol: "ETH",
      side: "close",
      size: "0.5000",
      status: "success",
      dryRun: false,
      meta: {
        longExchange: "hyperliquid",
        shortExchange: "pacifica",
        currentSpread: 3.2,
        reason: "spread 3.2% <= 5%",
        exitReason: "spread",
      },
    };
    expect(record.meta).toBeDefined();
    expect(record.meta!.exitReason).toBe("spread");
  });

  it("REVERSAL in closeReason takes priority over 'spread' substring", () => {
    // If somehow both words appear, REVERSAL check is first
    const reason = "REVERSAL — spread has flipped";
    expect(deriveExitReason(reason)).toBe("reversal");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Funding reconciliation
// ══════════════════════════════════════════════════════════════════════════════

describe("Funding reconciliation", () => {
  /**
   * Re-implements the diff logic from arb-auto.ts arb status command:
   * const fundingDiff = totalActualFunding - totalEstFunding;
   * const diffPct = totalEstFunding !== 0
   *   ? ((fundingDiff / Math.abs(totalEstFunding)) * 100).toFixed(1)
   *   : "N/A";
   */
  function computeFundingReconciliation(
    estimated: number,
    actual: number,
  ): { diff: number; diffPct: string } {
    const diff = actual - estimated;
    const diffPct = estimated !== 0
      ? ((diff / Math.abs(estimated)) * 100).toFixed(1)
      : "N/A";
    return { diff, diffPct };
  }

  it("computes positive diff when actual > estimated", () => {
    const result = computeFundingReconciliation(10, 12);
    expect(result.diff).toBe(2);
    expect(result.diffPct).toBe("20.0");
  });

  it("computes negative diff when actual < estimated", () => {
    const result = computeFundingReconciliation(10, 8);
    expect(result.diff).toBe(-2);
    expect(result.diffPct).toBe("-20.0");
  });

  it("zero diff when actual = estimated", () => {
    const result = computeFundingReconciliation(5, 5);
    expect(result.diff).toBe(0);
    expect(result.diffPct).toBe("0.0");
  });

  it("handles when estimated = 0 (returns N/A for percentage)", () => {
    const result = computeFundingReconciliation(0, 3.5);
    expect(result.diff).toBe(3.5);
    expect(result.diffPct).toBe("N/A");
  });

  it("handles when actual = 0 (no settled funding yet)", () => {
    const result = computeFundingReconciliation(5, 0);
    expect(result.diff).toBe(-5);
    expect(result.diffPct).toBe("-100.0");
  });

  it("handles negative estimated funding", () => {
    const result = computeFundingReconciliation(-10, -12);
    expect(result.diff).toBe(-2);
    // diff / |estimated| = -2/10 = -20%
    expect(result.diffPct).toBe("-20.0");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. ArbDaemonState with lastSuccessfulScanTime
// ══════════════════════════════════════════════════════════════════════════════

describe("ArbDaemonState with lastSuccessfulScanTime", () => {
  const TEST_DIR = resolve(process.env.HOME || "~", ".perp", "test-arb-new-features");
  const TEST_FILE = resolve(TEST_DIR, "arb-state.json");
  const TMP_FILE = TEST_FILE + ".tmp";

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
    setStateFilePath(TEST_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
    resetStateFilePath();
  });

  it("createInitialState includes lastSuccessfulScanTime", () => {
    const state = createInitialState({
      minSpread: 30, closeSpread: 5, size: 100,
      holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "block",
    });
    expect(state).toHaveProperty("lastSuccessfulScanTime");
    expect(state.lastSuccessfulScanTime).toBeTruthy();
  });

  it("lastSuccessfulScanTime is an ISO timestamp string", () => {
    const state = createInitialState({
      minSpread: 30, closeSpread: 5, size: 100,
      holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "block",
    });
    // Validate ISO format by parsing it
    const parsed = new Date(state.lastSuccessfulScanTime);
    expect(parsed.getTime()).not.toBeNaN();
    expect(state.lastSuccessfulScanTime).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("saveArbState + loadArbState preserves lastSuccessfulScanTime", () => {
    const state = createInitialState({
      minSpread: 30, closeSpread: 5, size: 100,
      holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "block",
    });
    const testTimestamp = "2025-06-15T14:30:00.000Z";
    state.lastSuccessfulScanTime = testTimestamp;

    saveArbState(state);
    const loaded = loadArbState();

    expect(loaded).not.toBeNull();
    expect(loaded!.lastSuccessfulScanTime).toBe(testTimestamp);
  });

  it("lastSuccessfulScanTime survives state update cycle", () => {
    const state = createInitialState({
      minSpread: 30, closeSpread: 5, size: 100,
      holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "block",
    });
    const ts1 = "2025-06-15T10:00:00.000Z";
    state.lastSuccessfulScanTime = ts1;
    saveArbState(state);

    // Simulate daemon updating lastSuccessfulScanTime
    const loaded = loadArbState()!;
    const ts2 = "2025-06-15T11:00:00.000Z";
    loaded.lastSuccessfulScanTime = ts2;
    loaded.lastScanTime = ts2;
    saveArbState(loaded);

    const reloaded = loadArbState()!;
    expect(reloaded.lastSuccessfulScanTime).toBe(ts2);
    expect(reloaded.lastScanTime).toBe(ts2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Exchange downtime detection logic
// ══════════════════════════════════════════════════════════════════════════════

describe("Exchange downtime detection logic", () => {
  /**
   * Re-implements the exchange health check pattern from arb-auto.ts:
   * - Try getMarkets() for each exchange
   * - If it throws, add to downExchanges and blockedExchanges
   * - If a position has an exchange in downExchanges, mark as degraded
   */

  interface ExchangeHealthResult {
    downExchanges: Set<string>;
    blockedExchanges: Set<string>;
  }

  async function checkExchangeHealth(
    exchangeNames: string[],
    getMarketsFn: (name: string) => Promise<unknown>,
  ): Promise<ExchangeHealthResult> {
    const downExchanges = new Set<string>();
    const blockedExchanges = new Set<string>();

    for (const name of exchangeNames) {
      try {
        await getMarketsFn(name);
      } catch {
        downExchanges.add(name);
        blockedExchanges.add(name);
      }
    }

    return { downExchanges, blockedExchanges };
  }

  function isPositionDegraded(
    position: { longExchange: string; shortExchange: string },
    downExchanges: Set<string>,
  ): boolean {
    return downExchanges.has(position.longExchange) || downExchanges.has(position.shortExchange);
  }

  it("getMarkets() success -> not in downExchanges", async () => {
    const getMarkets = vi.fn().mockResolvedValue([{ symbol: "BTC", markPrice: "50000" }]);
    const result = await checkExchangeHealth(["hyperliquid"], getMarkets);
    expect(result.downExchanges.has("hyperliquid")).toBe(false);
    expect(result.blockedExchanges.has("hyperliquid")).toBe(false);
  });

  it("getMarkets() throws -> in downExchanges and blockedExchanges", async () => {
    const getMarkets = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await checkExchangeHealth(["lighter"], getMarkets);
    expect(result.downExchanges.has("lighter")).toBe(true);
    expect(result.blockedExchanges.has("lighter")).toBe(true);
  });

  it("mixed exchange health: some up, some down", async () => {
    const getMarkets = vi.fn()
      .mockImplementation(async (name: string) => {
        if (name === "pacifica") throw new Error("503 service unavailable");
        return [{ symbol: "ETH" }];
      });

    const result = await checkExchangeHealth(
      ["hyperliquid", "pacifica", "lighter"],
      getMarkets,
    );

    expect(result.downExchanges.has("pacifica")).toBe(true);
    expect(result.blockedExchanges.has("pacifica")).toBe(true);
    expect(result.downExchanges.has("hyperliquid")).toBe(false);
    expect(result.downExchanges.has("lighter")).toBe(false);
  });

  it("position on down exchange -> marked as degraded", async () => {
    const downExchanges = new Set(["pacifica"]);
    const position = { longExchange: "hyperliquid", shortExchange: "pacifica" };
    expect(isPositionDegraded(position, downExchanges)).toBe(true);
  });

  it("position on healthy exchanges -> not degraded", () => {
    const downExchanges = new Set<string>();
    const position = { longExchange: "hyperliquid", shortExchange: "lighter" };
    expect(isPositionDegraded(position, downExchanges)).toBe(false);
  });

  it("position degraded when long exchange is down", () => {
    const downExchanges = new Set(["hyperliquid"]);
    const position = { longExchange: "hyperliquid", shortExchange: "pacifica" };
    expect(isPositionDegraded(position, downExchanges)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Additional: computeNetSpread, computeRoundTripCostPct, isNearSettlement
// ══════════════════════════════════════════════════════════════════════════════

describe("computeNetSpread", () => {
  it("deducts round-trip cost annualized over hold period", () => {
    // Gross 50% annual, 0.38% round trip cost, 7 day hold, no bridge
    const net = computeNetSpread(50, 7, 0.38, 0, 0);
    // annualized cost = (0.38 / 7) * 365 = ~19.81%
    // net = 50 - 19.81 = ~30.19%
    expect(net).toBeCloseTo(30.19, 0);
  });

  it("includes bridge cost when provided", () => {
    // Gross 50%, 0.38% RT, 7d hold, $1 bridge, $100 position
    const net = computeNetSpread(50, 7, 0.38, 1, 100);
    // bridge round-trip pct = (1*2/100)*100 = 2%
    // bridge annualized = (2/7)*365 = ~104.3%
    // net = 50 - 19.81 - 104.3 -> very negative
    expect(net).toBeLessThan(0);
  });
});

describe("computeRoundTripCostPct", () => {
  it("computes standard costs for default exchanges", () => {
    const cost = computeRoundTripCostPct("hyperliquid", "pacifica", 0.05);
    // 2 * (0.035 + 0.035) + 2 * 0.05 = 0.14 + 0.10 = 0.24%
    expect(cost).toBeCloseTo(0.24, 2);
  });
});

describe("isNearSettlement", () => {
  it("blocks when within buffer of next settlement", () => {
    // 15:57 UTC, next settlement at 16:00 -> 3 minutes away, within 5 min buffer
    const now = new Date("2024-06-15T15:57:00Z");
    const result = isNearSettlement("hyperliquid", "pacifica", 5, now);
    expect(result.blocked).toBe(true);
    expect(result.minutesUntil).toBeLessThanOrEqual(5);
  });

  it("does not block when far from settlement", () => {
    // 15:30 UTC, next settlement at 16:00 -> 30 minutes away
    const now = new Date("2024-06-15T15:30:00Z");
    const result = isNearSettlement("hyperliquid", "pacifica", 5, now);
    expect(result.blocked).toBe(false);
  });
});

describe("getNextSettlement", () => {
  it("returns next hour for hourly exchanges", () => {
    const now = new Date("2024-06-15T14:30:00Z");
    const next = getNextSettlement("hyperliquid", now);
    expect(next.getUTCHours()).toBe(15);
    expect(next.getUTCMinutes()).toBe(0);
  });
});

describe("isSpreadReversed", () => {
  it("detects reversal when long exchange has higher rate", () => {
    // Long HL, Short PAC. If HL rate > PAC rate hourly -> reversed
    const snapshot = { symbol: "ETH", pacRate: 0.0001, hlRate: 0.0005, ltRate: 0, spread: 0, longExch: "hyperliquid", shortExch: "pacifica", markPrice: 3000 };
    const reversed = isSpreadReversed("hyperliquid", "pacifica", snapshot);
    expect(reversed).toBe(true);
  });

  it("no reversal when short exchange has higher rate", () => {
    // Long HL, Short PAC. PAC rate > HL rate -> NOT reversed
    const snapshot = { symbol: "ETH", pacRate: 0.0005, hlRate: 0.0001, ltRate: 0, spread: 0, longExch: "hyperliquid", shortExch: "pacifica", markPrice: 3000 };
    const reversed = isSpreadReversed("hyperliquid", "pacifica", snapshot);
    expect(reversed).toBe(false);
  });
});
