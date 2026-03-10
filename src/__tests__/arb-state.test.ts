import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
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
  type ArbDaemonState,
  type ArbPositionState,
} from "../arb-state.js";

const TEST_DIR = resolve(process.env.HOME || "~", ".perp", "test-arb-state");
const TEST_FILE = resolve(TEST_DIR, "arb-state.json");

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

describe("Arb State Persistence", () => {
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

  it("loadArbState returns null when no file exists", () => {
    const state = loadArbState();
    expect(state).toBeNull();
  });

  it("saveArbState + loadArbState roundtrip", () => {
    const state = createInitialState({
      minSpread: 30,
      closeSpread: 5,
      size: 100,
      holdDays: 7,
      bridgeCost: 0.5,
      maxPositions: 5,
      settleStrategy: "aware",
    });
    state.positions.push(makePosition({ symbol: "BTC", longSize: 0.01, shortSize: 0.01 }));

    saveArbState(state);

    const loaded = loadArbState();
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.config.minSpread).toBe(30);
    expect(loaded!.config.closeSpread).toBe(5);
    expect(loaded!.config.size).toBe(100);
    expect(loaded!.positions).toHaveLength(1);
    expect(loaded!.positions[0].symbol).toBe("BTC");
    expect(loaded!.positions[0].longSize).toBe(0.01);
  });

  it("addPosition adds to existing state", () => {
    const state = createInitialState({
      minSpread: 30,
      closeSpread: 5,
      size: 100,
      holdDays: 7,
      bridgeCost: 0.5,
      maxPositions: 5,
      settleStrategy: "aware",
    });
    saveArbState(state);

    addPosition(makePosition({ symbol: "ETH" }));
    addPosition(makePosition({ symbol: "BTC" }));

    const positions = getPositions();
    expect(positions).toHaveLength(2);
    expect(positions.map(p => p.symbol).sort()).toEqual(["BTC", "ETH"]);
  });

  it("addPosition replaces duplicate symbol", () => {
    const state = createInitialState({
      minSpread: 30,
      closeSpread: 5,
      size: 100,
      holdDays: 7,
      bridgeCost: 0.5,
      maxPositions: 5,
      settleStrategy: "aware",
    });
    saveArbState(state);

    addPosition(makePosition({ symbol: "ETH", longSize: 1.0 }));
    addPosition(makePosition({ symbol: "ETH", longSize: 2.0 }));

    const positions = getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].longSize).toBe(2.0);
  });

  it("removePosition removes by symbol", () => {
    const state = createInitialState({
      minSpread: 30,
      closeSpread: 5,
      size: 100,
      holdDays: 7,
      bridgeCost: 0.5,
      maxPositions: 5,
      settleStrategy: "aware",
    });
    saveArbState(state);

    addPosition(makePosition({ symbol: "ETH" }));
    addPosition(makePosition({ symbol: "BTC" }));
    addPosition(makePosition({ symbol: "SOL" }));

    removePosition("BTC");

    const positions = getPositions();
    expect(positions).toHaveLength(2);
    expect(positions.map(p => p.symbol).sort()).toEqual(["ETH", "SOL"]);
  });

  it("removePosition is a no-op for unknown symbol", () => {
    const state = createInitialState({
      minSpread: 30,
      closeSpread: 5,
      size: 100,
      holdDays: 7,
      bridgeCost: 0.5,
      maxPositions: 5,
      settleStrategy: "aware",
    });
    saveArbState(state);

    addPosition(makePosition({ symbol: "ETH" }));
    removePosition("NONEXISTENT");

    const positions = getPositions();
    expect(positions).toHaveLength(1);
  });

  it("updatePosition updates partial fields", () => {
    const state = createInitialState({
      minSpread: 30,
      closeSpread: 5,
      size: 100,
      holdDays: 7,
      bridgeCost: 0.5,
      maxPositions: 5,
      settleStrategy: "aware",
    });
    saveArbState(state);

    addPosition(makePosition({
      symbol: "ETH",
      accumulatedFunding: 0,
      lastCheckTime: "2025-01-15T10:00:00.000Z",
    }));

    updatePosition("ETH", {
      accumulatedFunding: 1.234,
      lastCheckTime: "2025-01-15T12:00:00.000Z",
    });

    const positions = getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].accumulatedFunding).toBe(1.234);
    expect(positions[0].lastCheckTime).toBe("2025-01-15T12:00:00.000Z");
    // Other fields unchanged
    expect(positions[0].symbol).toBe("ETH");
    expect(positions[0].longExchange).toBe("hyperliquid");
  });

  it("updatePosition is a no-op for unknown symbol", () => {
    const state = createInitialState({
      minSpread: 30,
      closeSpread: 5,
      size: 100,
      holdDays: 7,
      bridgeCost: 0.5,
      maxPositions: 5,
      settleStrategy: "aware",
    });
    saveArbState(state);
    addPosition(makePosition({ symbol: "ETH" }));

    updatePosition("NONEXISTENT", { accumulatedFunding: 999 });

    const positions = getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("ETH");
  });

  it("getPositions returns empty list when no state", () => {
    const positions = getPositions();
    expect(positions).toEqual([]);
  });

  it("state survives simulated crash (save, reload in new context)", () => {
    // Simulate a daemon saving state then crashing
    const state = createInitialState({
      minSpread: 25,
      closeSpread: 3,
      size: "auto" as unknown as number,
      holdDays: 5,
      bridgeCost: 1.0,
      maxPositions: 3,
      settleStrategy: "aware",
    });
    state.positions.push(makePosition({ symbol: "ETH", accumulatedFunding: 5.67 }));
    state.positions.push(makePosition({ symbol: "BTC", accumulatedFunding: 12.34 }));
    state.lastScanTime = "2025-01-15T12:00:00.000Z";
    saveArbState(state);

    // Simulate crash: reset in-memory state by reloading
    const recovered = loadArbState();
    expect(recovered).not.toBeNull();
    expect(recovered!.positions).toHaveLength(2);
    expect(recovered!.positions.find(p => p.symbol === "ETH")!.accumulatedFunding).toBe(5.67);
    expect(recovered!.positions.find(p => p.symbol === "BTC")!.accumulatedFunding).toBe(12.34);
    expect(recovered!.config.minSpread).toBe(25);
    expect(recovered!.config.size).toBe("auto");
    expect(recovered!.lastScanTime).toBe("2025-01-15T12:00:00.000Z");
  });

  it("loadArbState returns null for corrupt JSON", () => {
    writeFileSync(TEST_FILE, "not valid json{{{", { mode: 0o600 });
    const state = loadArbState();
    expect(state).toBeNull();
  });

  it("loadArbState returns null for wrong version", () => {
    writeFileSync(TEST_FILE, JSON.stringify({ version: 99 }), { mode: 0o600 });
    const state = loadArbState();
    expect(state).toBeNull();
  });

  it("saveArbState uses atomic write (no .tmp left after success)", () => {
    const state = createInitialState({
      minSpread: 30, closeSpread: 5, size: 100,
      holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "aware",
    });
    saveArbState(state);
    // Main file should exist, .tmp should NOT exist after successful save
    expect(existsSync(TEST_FILE)).toBe(true);
    expect(existsSync(TMP_FILE)).toBe(false);
  });

  it("loadArbState recovers from .tmp when main is corrupted", () => {
    // Simulate: valid .tmp exists but main file is corrupted (crash mid-rename)
    const state = createInitialState({
      minSpread: 25, closeSpread: 3, size: 200,
      holdDays: 5, bridgeCost: 1.0, maxPositions: 3, settleStrategy: "aware",
    });
    state.positions.push(makePosition({ symbol: "BTC", accumulatedFunding: 99.99 }));

    // Write valid state to .tmp, corrupt data to main
    writeFileSync(TMP_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    writeFileSync(TEST_FILE, "corrupted{{{partial write", { mode: 0o600 });

    const recovered = loadArbState();
    expect(recovered).not.toBeNull();
    expect(recovered!.positions).toHaveLength(1);
    expect(recovered!.positions[0].symbol).toBe("BTC");
    expect(recovered!.positions[0].accumulatedFunding).toBe(99.99);
    // After recovery, .tmp should be promoted to main
    expect(existsSync(TEST_FILE)).toBe(true);
  });

  it("loadArbState recovers from .tmp when main is missing", () => {
    const state = createInitialState({
      minSpread: 30, closeSpread: 5, size: 100,
      holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "aware",
    });
    state.positions.push(makePosition({ symbol: "SOL" }));

    // Only .tmp exists (crash before rename completed)
    writeFileSync(TMP_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

    const recovered = loadArbState();
    expect(recovered).not.toBeNull();
    expect(recovered!.positions[0].symbol).toBe("SOL");
  });

  it("loadArbState returns null when both main and .tmp are corrupt", () => {
    writeFileSync(TEST_FILE, "corrupt main{{{", { mode: 0o600 });
    writeFileSync(TMP_FILE, "corrupt tmp{{{", { mode: 0o600 });

    const state = loadArbState();
    expect(state).toBeNull();
  });

  it("createInitialState produces valid structure", () => {
    const state = createInitialState({
      minSpread: 20,
      closeSpread: 5,
      size: 200,
      holdDays: 10,
      bridgeCost: 0.3,
      maxPositions: 8,
      settleStrategy: "disabled",
    });

    expect(state.version).toBe(1);
    expect(state.positions).toEqual([]);
    expect(state.config.minSpread).toBe(20);
    expect(state.config.maxPositions).toBe(8);
    expect(state.lastStartTime).toBeTruthy();
    expect(state.lastScanTime).toBeTruthy();
  });
});
