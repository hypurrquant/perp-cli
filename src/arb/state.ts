import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { resolve } from "path";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const STATE_FILE = resolve(PERP_DIR, "arb-state.json");

// Allow overriding the state file path for testing
let stateFilePath = STATE_FILE;

export function setStateFilePath(path: string): void {
  stateFilePath = path;
}

export function resetStateFilePath(): void {
  stateFilePath = STATE_FILE;
}

export interface ArbPositionState {
  id: string;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longSize: number;
  shortSize: number;
  entryTime: string; // ISO
  entrySpread: number; // annualized %
  entryLongPrice: number;
  entryShortPrice: number;
  accumulatedFunding: number;
  lastCheckTime: string; // ISO
  /** "perp-perp" (default) or "spot-perp" */
  mode?: "perp-perp" | "spot-perp";
  /** Spot leg exchange name (for spot-perp mode) */
  spotExchange?: string;
  /** Spot symbol, e.g. "ETH/USDC" (for spot-perp mode) */
  spotSymbol?: string;
}

export interface ArbDaemonState {
  version: 1;
  lastStartTime: string;
  lastScanTime: string;
  lastSuccessfulScanTime: string;
  positions: ArbPositionState[];
  config: {
    minSpread: number;
    closeSpread: number;
    size: number | "auto";
    holdDays: number;
    bridgeCost: number;
    maxPositions: number;
    settleStrategy: string;
    notifyUrl?: string;
  };
}

function ensureDir(): void {
  const dir = resolve(stateFilePath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Load daemon state from disk. Falls back to .tmp if main file is corrupted. */
export function loadArbState(): ArbDaemonState | null {
  const tmpPath = stateFilePath + ".tmp";

  // Try main file first
  if (existsSync(stateFilePath)) {
    try {
      const raw = readFileSync(stateFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.version === 1) return parsed as ArbDaemonState;
    } catch {
      // Main file corrupted — try .tmp fallback
    }
  }

  // Fallback: recover from .tmp if main is missing or corrupted
  if (existsSync(tmpPath)) {
    try {
      const raw = readFileSync(tmpPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.version === 1) {
        // Promote .tmp to main
        try { renameSync(tmpPath, stateFilePath); } catch { /* best effort */ }
        return parsed as ArbDaemonState;
      }
    } catch {
      // .tmp also corrupted — give up
    }
  }

  return null;
}

/**
 * Save daemon state to disk using atomic write pattern.
 * Writes to .tmp first, then renames to main file.
 * If crash occurs mid-write, .tmp is partial but main file is intact.
 */
export function saveArbState(state: ArbDaemonState): void {
  ensureDir();
  const tmpPath = stateFilePath + ".tmp";
  const json = JSON.stringify(state, null, 2);
  writeFileSync(tmpPath, json, { mode: 0o600 });
  renameSync(tmpPath, stateFilePath);
}

/** Add a position to the persisted state. */
export function addPosition(pos: ArbPositionState): void {
  const state = loadArbState();
  if (!state) {
    throw new Error("No daemon state found. Initialize state before adding positions.");
  }
  // Avoid duplicates by symbol
  state.positions = state.positions.filter(p => p.symbol !== pos.symbol);
  state.positions.push(pos);
  saveArbState(state);
}

/** Remove a position by symbol from the persisted state. */
export function removePosition(symbol: string): void {
  const state = loadArbState();
  if (!state) return;
  state.positions = state.positions.filter(p => p.symbol !== symbol);
  saveArbState(state);
}

/** Update a position by symbol with partial updates. */
export function updatePosition(symbol: string, updates: Partial<ArbPositionState>): void {
  const state = loadArbState();
  if (!state) return;
  const idx = state.positions.findIndex(p => p.symbol === symbol);
  if (idx === -1) return;
  state.positions[idx] = { ...state.positions[idx], ...updates };
  saveArbState(state);
}

/** Get all persisted positions. */
export function getPositions(): ArbPositionState[] {
  const state = loadArbState();
  if (!state) return [];
  return state.positions;
}

/** Create a default empty daemon state with the given config. */
export function createInitialState(config: ArbDaemonState["config"]): ArbDaemonState {
  return {
    version: 1,
    lastStartTime: new Date().toISOString(),
    lastScanTime: new Date().toISOString(),
    lastSuccessfulScanTime: new Date().toISOString(),
    positions: [],
    config,
  };
}
