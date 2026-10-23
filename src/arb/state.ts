import { copyFileSync, constants as fsConstants, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { resolve } from "path";
import { PerpError } from "../errors.js";
import { withFileLock } from "./file-lock.js";
import type { Network } from "../exchanges/venue-types.js";

/**
 * Arb daemon state is PER NETWORK (review N2): a testnet run must never read, close, or
 * overwrite mainnet positions, and vice versa.
 *
 *   mainnet → ~/.perp/arb-state.json          (the pre-network path, unchanged)
 *   testnet → ~/.perp/arb-state.testnet.json
 *
 * Every saved file carries `network`; a load whose tag does not match the requested
 * network throws. Files written before this change have no tag. They are MAINNET by
 * definition (mainnet was — and is — the documented default network, and the mainnet
 * path is unchanged), so a mainnet load adopts an untagged file and tags it in place
 * (atomic tmp+rename, after a one-time backup copy `arb-state.json.pre-network.bak`).
 * The history does NOT prove an untagged file could only come from mainnet (`-n testnet`
 * routed `arb exec/auto` to testnet adapters since 2026-03 and they wrote the same file),
 * so a TESTNET load refuses while an untagged legacy file exists — the user decides
 * (adopt as mainnet, or move it to the testnet path). Nothing is ever dropped or copied
 * into both networks.
 */
const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const STATE_FILE = resolve(PERP_DIR, "arb-state.json");

// Allow overriding the (mainnet) state file path for testing; testnet derives from it.
let stateFilePath = STATE_FILE;

export function setStateFilePath(path: string): void {
  stateFilePath = path;
}

export function resetStateFilePath(): void {
  stateFilePath = STATE_FILE;
}

/** Absolute state-file path for `network` (mainnet = the pre-network path). */
export function arbStateFilePath(network: Network): string {
  if (network === "mainnet") return stateFilePath;
  return stateFilePath.endsWith(".json") ? `${stateFilePath.slice(0, -5)}.testnet.json` : `${stateFilePath}.testnet`;
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
  /** null = no verified fill price was reported for the leg (a strategy-bot entry; never a guess). */
  entryLongPrice: number | null;
  entryShortPrice: number | null;
  accumulatedFunding: number;
  lastCheckTime: string; // ISO
  /** "perp-perp" (default) or "spot-perp" */
  mode?: "perp-perp" | "spot-perp";
  /** Spot leg exchange name (for spot-perp mode) */
  spotExchange?: string;
  /** Spot symbol, e.g. "ETH/USDC" (for spot-perp mode) */
  spotSymbol?: string;
  /**
   * The legs' VENUE symbols when they differ from `symbol` (the canonical key): Hyperliquid
   * kPEPE ↔ Lighter 1000PEPE. Absent = both legs trade as `symbol`.
   */
  longSymbol?: string;
  shortSymbol?: string;
}

export interface ArbDaemonState {
  version: 1;
  /** Network the positions live on. Absent only in files written before per-network state (= mainnet). */
  network?: Network;
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

function ensureDir(path: string): void {
  const dir = resolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Parse a state file's tag without the .tmp recovery (used for the legacy-file guard). */
function readTag(path: string): { untagged: boolean } | null {
  if (!existsSync(path)) return null;
  let parsed: { network?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as { network?: unknown };
  } catch (e) {
    throw new PerpError("INVALID_PARAMS", `Arb state ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — refusing to guess its network`, {
      remediation: `Inspect or restore ${path} (a .tmp / .pre-network.bak copy may exist next to it)`,
    });
  }
  return { untagged: parsed.network === undefined };
}

/** Load the daemon state for `network`. Falls back to .tmp if main file is corrupted. */
export function loadArbState(network: Network, opts: { readOnly: boolean } = { readOnly: false }): ArbDaemonState | null {
  if (network === "testnet") {
    const legacy = readTag(arbStateFilePath("mainnet"));
    if (legacy?.untagged) {
      const main = arbStateFilePath("mainnet");
      throw new PerpError("INVALID_PARAMS", `Untagged arb state ${main} (written before per-network state) exists — refusing to guess its network on testnet`, {
        remediation: `If it holds MAINNET positions (the default network), adopt it once with any mainnet arb read: perp -n mainnet arb status. `
          + `If it holds TESTNET positions, move it: mv ${main} ${arbStateFilePath("testnet")}`,
      });
    }
  }
  const state = loadArbStateFile(arbStateFilePath(network));
  if (state === null) return null;
  if (state.network === undefined) {
    // Only reachable for mainnet (testnet refused above / its path never held untagged data).
    // A read-only (dry-run) load tags the copy in memory and leaves the file untouched.
    if (opts.readOnly) state.network = "mainnet";
    else adoptLegacyAsMainnet(state);
    return state;
  }
  if (state.network !== network) {
    throw new PerpError("INVALID_PARAMS", `Arb state ${arbStateFilePath(network)} is tagged ${state.network}, not ${network}`, {
      remediation: `The file was moved or edited by hand. Restore it to ${arbStateFilePath(state.network)}`,
    });
  }
  return state;
}

/** One-time adoption of a pre-network (untagged) state file as mainnet: backup copy, then atomic in-place tag. */
function adoptLegacyAsMainnet(state: ArbDaemonState): void {
  const path = arbStateFilePath("mainnet");
  const backup = `${path}.pre-network.bak`;
  if (!existsSync(backup)) copyFileSync(path, backup, fsConstants.COPYFILE_EXCL);
  state.network = "mainnet";
  writeStateAtomic(path, state);
}

function loadArbStateFile(stateFilePath: string): ArbDaemonState | null {
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
export function saveArbState(network: Network, state: ArbDaemonState): void {
  if (state.network !== undefined && state.network !== network) {
    throw new PerpError("INVALID_PARAMS", `Refusing to save ${state.network} arb state as ${network}`, {
      remediation: "This is a bug — the state object was loaded for another network. Re-run the command.",
    });
  }
  // Same network on the -n testnet path: never let a testnet save land while an untagged legacy file is unresolved.
  if (network === "testnet") loadArbState("testnet");
  writeStateAtomic(arbStateFilePath(network), { ...state, network });
}

function writeStateAtomic(path: string, state: ArbDaemonState): void {
  ensureDir(path);
  const tmpPath = path + ".tmp";
  const json = JSON.stringify(state, null, 2);
  writeFileSync(tmpPath, json, { mode: 0o600 });
  renameSync(tmpPath, path);
}

/** Identity of a state entry: symbol + long venue + short venue + mode (absent mode = perp-perp). */
export function positionKey(p: Pick<ArbPositionState, "symbol" | "longExchange" | "shortExchange" | "mode">): string {
  return `${p.symbol.toUpperCase()}|${p.longExchange}|${p.shortExchange}|${p.mode ?? "perp-perp"}`;
}

/**
 * Put `pos` into `positions`: an entry with the same key is replaced (a re-record of the same
 * pair); an entry of the same symbol on OTHER venues / another mode is never overwritten —
 * RISK_VIOLATION (the state tracks one pair per symbol; overwriting would drop a live pair).
 */
export function upsertPosition(positions: ArbPositionState[], pos: ArbPositionState): ArbPositionState[] {
  const key = positionKey(pos);
  const other = positions.find(p => p.symbol.toUpperCase() === pos.symbol.toUpperCase() && positionKey(p) !== key);
  if (other !== undefined) {
    throw new PerpError("RISK_VIOLATION", `Arb state already tracks ${other.symbol} as ${other.mode ?? "perp-perp"} long ${other.longExchange} / short ${other.shortExchange} — refusing to overwrite it with ${pos.mode ?? "perp-perp"} long ${pos.longExchange} / short ${pos.shortExchange}`, {
      remediation: `Both pairs may be open: check ${pos.symbol} on ${[...new Set([other.longExchange, other.shortExchange, pos.longExchange, pos.shortExchange])].join(", ")} (perp arb status), close one by hand, then record / drop it (perp arb close ${pos.symbol} --state-only)`,
    });
  }
  return [...positions.filter(p => positionKey(p) !== key), pos];
}

/** Load → modify → save of the state for `network` under the cross-process lock. */
function withStateLock<T>(network: Network, fn: () => T): T {
  return withFileLock(arbStateFilePath(network), `Arb state (${network})`, fn);
}

/** Add a position to the persisted state for `network`. Auto-initializes state if missing. Throws RISK_VIOLATION for a conflicting entry (upsertPosition). */
export function addPosition(network: Network, pos: ArbPositionState): void {
  withStateLock(network, () => {
    let state = loadArbState(network);
    if (!state) {
      // State was lost — create minimal valid state to avoid losing position tracking
      state = createInitialState({ minSpread: 0, closeSpread: 0, size: 0, holdDays: 0, bridgeCost: 0, maxPositions: 10, settleStrategy: "off" });
    }
    state.positions = upsertPosition(state.positions, pos);
    saveArbState(network, state);
  });
}

/** Remove a position by symbol from the persisted state for `network` (one entry per symbol: upsertPosition). */
export function removePosition(network: Network, symbol: string): void {
  withStateLock(network, () => {
    const state = loadArbState(network);
    if (!state) return;
    state.positions = state.positions.filter(p => p.symbol !== symbol);
    saveArbState(network, state);
  });
}

/** Remove exactly the entry with `entry`'s key (symbol + venues + mode); another pair of the symbol is left alone. */
export function removePositionEntry(network: Network, entry: Pick<ArbPositionState, "symbol" | "longExchange" | "shortExchange" | "mode">): void {
  withStateLock(network, () => {
    const state = loadArbState(network);
    if (!state) return;
    const key = positionKey(entry);
    state.positions = state.positions.filter(p => positionKey(p) !== key);
    saveArbState(network, state);
  });
}

/** Update a position by symbol with partial updates. */
export function updatePosition(network: Network, symbol: string, updates: Partial<ArbPositionState>): void {
  withStateLock(network, () => {
    const state = loadArbState(network);
    if (!state) return;
    const idx = state.positions.findIndex(p => p.symbol === symbol);
    if (idx === -1) return;
    state.positions[idx] = { ...state.positions[idx], ...updates };
    saveArbState(network, state);
  });
}

/** Update exactly the entry with `entry`'s key (symbol + venues + mode). */
export function updatePositionEntry(network: Network, entry: Pick<ArbPositionState, "symbol" | "longExchange" | "shortExchange" | "mode">, updates: Partial<ArbPositionState>): void {
  withStateLock(network, () => {
    const state = loadArbState(network);
    if (!state) return;
    const key = positionKey(entry);
    const idx = state.positions.findIndex(p => positionKey(p) === key);
    if (idx === -1) return;
    state.positions[idx] = { ...state.positions[idx], ...updates };
    saveArbState(network, state);
  });
}

/** Get all persisted positions for `network`. */
export function getPositions(network: Network): ArbPositionState[] {
  const state = loadArbState(network);
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

/** State access for the `arb auto` daemon (see createDaemonStateStore). */
export interface DaemonStateStore {
  load(): ArbDaemonState | null;
  save(next: ArbDaemonState): void;
  add(pos: ArbPositionState): void;
  remove(symbol: string): void;
}

/**
 * Live: the per-network state file. Dry-run (review N3): an in-memory copy seeded READ-ONLY
 * from the real state — nothing is ever written to disk, so a simulated entry is never picked
 * up by a live run and a simulated close never drops a real position from tracking.
 */
export function createDaemonStateStore(network: Network, dryRun: boolean, config: ArbDaemonState["config"]): DaemonStateStore {
  if (!dryRun) {
    return {
      load: () => loadArbState(network),
      save: (next) => saveArbState(network, next),
      add: (pos) => addPosition(network, pos),
      remove: (symbol) => removePosition(network, symbol),
    };
  }
  let sim: ArbDaemonState | null = structuredClone(loadArbState(network, { readOnly: true }));
  return {
    load: () => structuredClone(sim),
    save: (next) => { sim = structuredClone(next); },
    add: (pos) => {
      const next = sim ?? createInitialState(config);
      next.positions = upsertPosition(next.positions, structuredClone(pos));
      sim = next;
    },
    remove: (symbol) => {
      if (sim !== null) sim.positions = sim.positions.filter(p => p.symbol !== symbol);
    },
  };
}
