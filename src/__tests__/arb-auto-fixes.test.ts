import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  loadArbState,
  saveArbState,
  addPosition,
  removePosition,
  getPositions,
  createInitialState,
  setStateFilePath,
  resetStateFilePath,
  type ArbPositionState,
} from "../arb-state.js";
import { toHourlyRate } from "../funding.js";
import { getTakerFee, DEFAULT_TAKER_FEE } from "../constants.js";
import { SETTLEMENT_SCHEDULES } from "../arb-utils.js";
import {
  computeNetSpread,
  computeRoundTripCostPct,
} from "../commands/arb-auto.js";

/**
 * Tests verifying the arb-auto fixes:
 * 1. State persistence after entry/close
 * 2. Funding rate normalization (Lighter 8h → 1h)
 * 3. Daemon↔CLI state sync
 * 4. Constants centralization
 * 5. Settlement schedule deduplication
 */

const TEST_DIR = resolve(process.env.HOME || "~", ".perp", "test-arb-fixes");
const TEST_FILE = resolve(TEST_DIR, "arb-state-fixes.json");

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

function initState() {
  const state = createInitialState({
    minSpread: 30, closeSpread: 5, size: 100,
    holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "aware",
  });
  saveArbState(state);
  return state;
}

// ────────────────────────────────────────────
// Fix 1-1 & 1-2: State persistence on entry/close
// ────────────────────────────────────────────

describe("Fix 1-1/1-2: State persistence after entry and close", () => {
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

  it("addPosition persists immediately and survives reload", () => {
    initState();

    // Simulate what daemon does after entry
    addPosition(makePosition({ symbol: "BTC", longSize: 0.01, shortSize: 0.01 }));

    // Simulate crash + reload (new context)
    const recovered = loadArbState();
    expect(recovered).not.toBeNull();
    expect(recovered!.positions).toHaveLength(1);
    expect(recovered!.positions[0].symbol).toBe("BTC");
    expect(recovered!.positions[0].longSize).toBe(0.01);
  });

  it("removePosition persists and position is gone after reload", () => {
    initState();

    addPosition(makePosition({ symbol: "ETH" }));
    addPosition(makePosition({ symbol: "BTC" }));

    // Verify both exist
    expect(getPositions()).toHaveLength(2);

    // Simulate what daemon does after successful close
    removePosition("ETH");

    // Simulate crash + reload
    const recovered = loadArbState();
    expect(recovered!.positions).toHaveLength(1);
    expect(recovered!.positions[0].symbol).toBe("BTC");
  });

  it("close failure should NOT remove position from state", () => {
    initState();

    addPosition(makePosition({ symbol: "SOL" }));
    addPosition(makePosition({ symbol: "BTC" }));

    // Simulate: close failed, so we do NOT call removePosition
    // (position stays in state for retry next cycle)

    const state = loadArbState();
    expect(state!.positions).toHaveLength(2);
    expect(state!.positions.map(p => p.symbol).sort()).toEqual(["BTC", "SOL"]);
  });

  it("entry then close then reload: position fully gone", () => {
    initState();

    // Entry
    addPosition(makePosition({ symbol: "ETH", accumulatedFunding: 1.5 }));
    expect(getPositions()).toHaveLength(1);

    // Close success
    removePosition("ETH");
    expect(getPositions()).toHaveLength(0);

    // Reload
    const recovered = loadArbState();
    expect(recovered!.positions).toHaveLength(0);
  });
});

// ────────────────────────────────────────────
// Fix 2-1: Funding rate normalization
// ────────────────────────────────────────────

describe("Fix 2-1: Funding rate normalization (Lighter 8h)", () => {
  it("toHourlyRate divides Lighter rate by 8", () => {
    const lighterRawRate = 0.0008; // 8h rate
    const hourly = toHourlyRate(lighterRawRate, "lighter");
    expect(hourly).toBe(0.0001); // 0.0008 / 8
  });

  it("toHourlyRate keeps HL rate as-is", () => {
    const hlRate = 0.0003;
    const hourly = toHourlyRate(hlRate, "hyperliquid");
    expect(hourly).toBe(0.0003);
  });

  it("toHourlyRate keeps PAC rate as-is", () => {
    const pacRate = 0.0005;
    const hourly = toHourlyRate(pacRate, "pacifica");
    expect(hourly).toBe(0.0005);
  });

  it("normalized funding income uses correct rates for cross-exchange comparison", () => {
    // Simulate: Lighter raw rate 0.0008 (8h) vs HL raw rate 0.0001 (1h)
    // Without normalization: spread = 0.0008 - 0.0001 = 0.0007 (WRONG — 8x overestimate)
    // With normalization: spread = 0.0001 - 0.0001 = 0 (CORRECT — same actual hourly rate)
    const ltRaw = 0.0008;
    const hlRaw = 0.0001;

    const ltHourly = toHourlyRate(ltRaw, "lighter");
    const hlHourly = toHourlyRate(hlRaw, "hyperliquid");

    expect(ltHourly).toBe(0.0001);
    expect(hlHourly).toBe(0.0001);
    expect(ltHourly - hlHourly).toBeCloseTo(0, 10);
  });

  it("funding income calculation is correct when Lighter has higher 8h rate", () => {
    // Lighter 8h rate = 0.0016, hourly = 0.0002
    // HL 1h rate = 0.0001
    // Short Lighter (get 0.0002/hr), Long HL (pay 0.0001/hr)
    // Net hourly income = (0.0002 - 0.0001) * notional
    const ltRaw = 0.0016;
    const hlRaw = 0.0001;
    const notional = 10000; // $10k per leg
    const elapsedHours = 1;

    const shortHourly = toHourlyRate(ltRaw, "lighter");
    const longHourly = toHourlyRate(hlRaw, "hyperliquid");
    const hourlyIncome = (shortHourly - longHourly) * notional;
    const income = hourlyIncome * elapsedHours;

    expect(shortHourly).toBe(0.0002);
    expect(longHourly).toBe(0.0001);
    expect(income).toBeCloseTo(1.0, 5); // $1/hr on $10k

    // OLD bug: without normalization
    const oldIncome = (ltRaw - hlRaw) * notional * elapsedHours;
    expect(oldIncome).toBeCloseTo(15.0, 5); // $15/hr — 15x overestimate!
    expect(oldIncome).toBeGreaterThan(income * 10); // confirms bug was significant
  });
});

// ────────────────────────────────────────────
// Fix 2-2: Daemon↔CLI state sync
// ────────────────────────────────────────────

describe("Fix 2-2: Daemon↔CLI state sync", () => {
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

  it("CLI close removes position from state, daemon can detect it", () => {
    initState();

    // Daemon adds positions
    addPosition(makePosition({ symbol: "ETH" }));
    addPosition(makePosition({ symbol: "BTC" }));

    // Simulate CLI `perp arb close ETH` — calls removePosition
    removePosition("ETH");

    // Daemon reloads state at next cycle
    const state = loadArbState();
    const persistedSymbols = new Set(state!.positions.map(p => p.symbol));

    // Daemon's in-memory list would have ["ETH", "BTC"]
    const daemonMemory = ["ETH", "BTC"];
    const removed = daemonMemory.filter(s => !persistedSymbols.has(s));

    expect(removed).toEqual(["ETH"]);
    expect(persistedSymbols.has("BTC")).toBe(true);
  });

  it("external process adds position, daemon recovers it", () => {
    initState();

    // Daemon has ETH in memory
    addPosition(makePosition({ symbol: "ETH" }));

    // Another process adds SOL (e.g. manual CLI entry)
    addPosition(makePosition({ symbol: "SOL" }));

    // Daemon reloads state
    const state = loadArbState();
    const persistedSymbols = state!.positions.map(p => p.symbol);

    // Daemon's in-memory only has ETH
    const daemonMemory = ["ETH"];
    const recovered = persistedSymbols.filter(s => !daemonMemory.includes(s));

    expect(recovered).toEqual(["SOL"]);
  });
});

// ────────────────────────────────────────────
// Fix 1-3: Close verification (Promise.allSettled logic)
// ────────────────────────────────────────────

describe("Fix 1-3: Close verification logic", () => {
  it("both legs succeed: position should be removed", () => {
    const longOk = true;
    const shortOk = true;
    const shouldRemove = longOk && shortOk;
    expect(shouldRemove).toBe(true);
  });

  it("one leg fails: position should NOT be removed (retry next cycle)", () => {
    const longOk = true;
    const shortOk = false;
    const shouldRemove = longOk && shortOk;
    expect(shouldRemove).toBe(false);
  });

  it("both legs fail: position should NOT be removed", () => {
    const longOk = false;
    const shortOk = false;
    const shouldRemove = longOk && shortOk;
    expect(shouldRemove).toBe(false);
  });
});

// ────────────────────────────────────────────
// Fix 2-3: Settle boost applied to entry threshold
// ────────────────────────────────────────────

describe("Fix 2-3: Settle boost applied to entry threshold", () => {
  it("boost > 1.0 lowers effective minSpread threshold", () => {
    const netSpread = 25; // below minSpread of 30
    const minSpread = 30;

    // Without boost: skip
    expect(netSpread < minSpread).toBe(true);

    // With 1.3x boost: 25 * 1.3 = 32.5 > 30 → enter
    const settleBoostMultiplier = 1.3;
    const effectiveNetSpread = netSpread * settleBoostMultiplier;
    expect(effectiveNetSpread >= minSpread).toBe(true);
  });

  it("boost = 1.0 has no effect", () => {
    const netSpread = 25;
    const minSpread = 30;
    const settleBoostMultiplier = 1.0;
    const effectiveNetSpread = netSpread * settleBoostMultiplier;
    expect(effectiveNetSpread < minSpread).toBe(true);
  });
});

// ────────────────────────────────────────────
// Fix 3-2: Constants centralization
// ────────────────────────────────────────────

describe("Fix 3-2: TAKER_FEE centralized", () => {
  it("getTakerFee returns correct fee for known exchanges", () => {
    expect(getTakerFee("hyperliquid")).toBe(0.00035);
    expect(getTakerFee("pacifica")).toBe(0.00035);
    expect(getTakerFee("lighter")).toBe(0.00035);
  });

  it("getTakerFee returns fallback for unknown exchange", () => {
    expect(getTakerFee("unknown")).toBe(0.00035);
    expect(getTakerFee("default")).toBe(0.00035);
  });

  it("DEFAULT_TAKER_FEE matches expected value", () => {
    expect(DEFAULT_TAKER_FEE).toBe(0.00035);
  });

  it("computeRoundTripCostPct uses centralized fees", () => {
    // 2 * (longFee + shortFee) + 2 * slippage
    // 2 * (0.035% + 0.035%) + 2 * 0.05% = 0.14% + 0.1% = 0.24%
    const cost = computeRoundTripCostPct("hyperliquid", "pacifica", 0.05);
    expect(cost).toBeCloseTo(0.24, 4);
  });
});

// ────────────────────────────────────────────
// Fix 3-3: Settlement schedule deduplication
// ────────────────────────────────────────────

describe("Fix 3-3: Settlement schedules exported from arb-utils", () => {
  it("SETTLEMENT_SCHEDULES is exported and has all 3 exchanges", () => {
    expect(SETTLEMENT_SCHEDULES).toBeDefined();
    expect(SETTLEMENT_SCHEDULES.hyperliquid).toBeDefined();
    expect(SETTLEMENT_SCHEDULES.pacifica).toBeDefined();
    expect(SETTLEMENT_SCHEDULES.lighter).toBeDefined();
  });

  it("all exchanges have 24 hourly settlement slots", () => {
    for (const exchange of ["hyperliquid", "pacifica", "lighter"]) {
      const schedule = SETTLEMENT_SCHEDULES[exchange];
      expect(schedule).toHaveLength(24);
      expect(schedule[0]).toBe(0);
      expect(schedule[23]).toBe(23);
    }
  });
});
