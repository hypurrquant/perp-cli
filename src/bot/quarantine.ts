/**
 * Position quarantine — GLOBAL per symbol.
 *
 * A spot leg whose outcome is unknown (ORDER_PENDING), a perp leg that could not be
 * confirmed, a close whose post-trade verification failed, or a position left unhedged
 * by a failed rollback must NOT be retried automatically: a retry can double-buy,
 * double-sell or open a naked perp. Such a symbol is quarantined here, persisted in
 * ~/.perp/bot-quarantine.json, and skipped by EVERY automated path — the bot strategies
 * (funding-arb, funding-arb-v2, spot-perp-arb, funding-auto), `perp arb exec` (perp-perp
 * and spot:<venue>) and the `perp arb auto` / `arb dex-auto` daemons — no entry, no close,
 * no rotation — until a human clears it (`perp arb close` refuses it without --force):
 *
 *   perp strategy quarantine                       # list
 *   perp strategy quarantine-clear <symbol> [--strategy <source>]
 *
 * Entries are stored per source ("<source>:<KEY>", source = strategy name or CLI path)
 * but CHECKED by the canonical key alone (quarantineKey: HIP-3 dex prefix and "-PERP"
 * stripped, DENOMINATION_ALIASES applied, uppercased — "xyz:TSLA" ≡ "TSLA", "KPEPE" ≡
 * "1000PEPE"): one venue's unknown outcome blocks the underlying for all strategies,
 * venues and processes. `entry.symbol` keeps the symbol as the source reported it. The file is re-read on every check, so a clear
 * from the CLI takes effect in running bots on their next tick (no restart). Only an
 * entry whose persist failed is held in process memory (logged CRITICAL); it holds
 * until that process stops.
 *
 * Network scope: an entry records the network it was set on (`network`); a process that called
 * setQuarantineNetwork(n) sees only entries of n plus entries of unknown network (null — set by
 * a process that never declared its network: they apply to EVERY network, fail closed). Entries
 * written before network scoping have no tag and are MAINNET (like the arb state's legacy file).
 * A process that never declared its network sees every entry (fail closed). Mainnet / unknown
 * entries keep the legacy key "<source>:<KEY>"; testnet ones are keyed "testnet:<source>:<KEY>".
 * Every load → modify → save of the file holds the cross-process lock (withFileLock).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";
import { PerpError } from "../errors.js";
import { DENOMINATION_ALIASES } from "../exchanges/canonical-symbols.js";
import type { Network } from "../exchanges/venue-types.js";
import { withFileLock } from "../arb/file-lock.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
export const QUARANTINE_FILE = resolve(PERP_DIR, "bot-quarantine.json");

export interface QuarantineEntry {
  /** Who quarantined it: a strategy name or a CLI path ("arb-exec"). */
  strategy: string;
  /** The symbol as the source reported it (display); matched via quarantineKey(). */
  symbol: string;
  /** What happened (the CRITICAL log line). */
  reason: string;
  /** What the human must check before clearing. */
  remediation: string;
  time: string; // ISO
  /** Network the entry was set on; null = unknown (applies to every network). Legacy untagged entries load as "mainnet". */
  network: Network | null;
}

interface QuarantineFile {
  version: 1;
  entries: Record<string, QuarantineEntry>;
}

/** Entries whose persist failed, by "<source>:<KEY>" (this process only). */
const unpersisted = new Map<string, QuarantineEntry>();

/**
 * Canonical quarantine key for a symbol — the ONLY way a symbol is compared here (set,
 * check, clear): uppercased, HIP-3 dex prefix ("xyz:") and "-PERP" suffix stripped,
 * DENOMINATION_ALIASES applied (KPEPE → 1000PEPE, UBTC → BTC).
 */
export function quarantineKey(symbol: string): string {
  let up = symbol.trim().toUpperCase();
  const colon = up.lastIndexOf(":");
  if (colon >= 0) up = up.slice(colon + 1);
  up = up.replace(/-PERP$/, "");
  return DENOMINATION_ALIASES[up] ?? up;
}

/** The network this process trades on (setQuarantineNetwork); null = not declared → every entry applies. */
let activeNetwork: Network | null = null;

/** Declare the network this process trades on: entries are set on it and checked against it. */
export function setQuarantineNetwork(network: Network): void {
  activeNetwork = network;
}

/** Test hook: back to "network not declared". */
export function resetQuarantineNetwork(): void {
  activeNetwork = null;
}

function keyOf(source: string, symbol: string, network: Network | null): string {
  return `${network === "testnet" ? "testnet:" : ""}${source}:${quarantineKey(symbol)}`;
}

/** Does `e` block on this process's network? (unknown on either side → yes, fail closed) */
function applies(e: QuarantineEntry): boolean {
  return activeNetwork === null || e.network === null || e.network === activeNetwork;
}

/** Read the file. A missing file = nothing quarantined; an unreadable / malformed file throws (never "empty"). */
function load(): QuarantineFile {
  if (!existsSync(QUARANTINE_FILE)) return { version: 1, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(QUARANTINE_FILE, "utf-8"));
  } catch (e) {
    throw new PerpError("INVALID_PARAMS", `Bot quarantine file is unreadable: ${QUARANTINE_FILE} (${e instanceof Error ? e.message : String(e)})`, {
      remediation: `Fix or remove ${QUARANTINE_FILE} after verifying every quarantined position on the venues`,
    });
  }
  const f = parsed as Partial<QuarantineFile> | null;
  if (f === null || f.version !== 1 || typeof f.entries !== "object" || f.entries === null) {
    throw new PerpError("INVALID_PARAMS", `Bot quarantine file has an unexpected shape: ${QUARANTINE_FILE}`, {
      remediation: `Fix or remove ${QUARANTINE_FILE} after verifying every quarantined position on the venues`,
    });
  }
  // Legacy entries (written before network scoping) have no tag: they are mainnet.
  for (const e of Object.values(f.entries as Record<string, Partial<QuarantineEntry>>)) {
    if (e.network === undefined) e.network = "mainnet";
  }
  return f as QuarantineFile;
}

function withQuarantineLock<T>(fn: () => T): T {
  return withFileLock(QUARANTINE_FILE, "Bot quarantine file", fn);
}

function save(f: QuarantineFile): void {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  const tmp = QUARANTINE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
  renameSync(tmp, QUARANTINE_FILE);
}

/**
 * Quarantine `symbol` (for every strategy / CLI path) and log CRITICAL with the
 * remediation. `source` records who did it. If persisting fails the entry is held in
 * this process's memory and the failure is logged loudly.
 */
export function quarantineSymbol(
  source: string,
  symbol: string,
  reason: string,
  remediation: string,
  log: (msg: string) => void,
): void {
  const sym = symbol.toUpperCase();
  const key = quarantineKey(sym);
  const entry: QuarantineEntry = { strategy: source, symbol: sym, reason, remediation, time: new Date().toISOString(), network: activeNetwork };
  const k = keyOf(source, sym, activeNetwork);
  log(`  [QUARANTINE] CRITICAL: ${sym}${key !== sym ? ` (key ${key})` : ""} quarantined by ${source} — ${reason}`);
  log(`  [QUARANTINE] Remediation: ${remediation}`);
  log(`  [QUARANTINE] No bot / arb path will touch ${key} until cleared: perp strategy quarantine-clear ${key}`);
  try {
    withQuarantineLock(() => {
      const f = load();
      // Never narrow: an existing unknown-network entry under this key keeps applying everywhere.
      if (f.entries[k]?.network === null) entry.network = null;
      f.entries[k] = entry;
      save(f);
    });
  } catch (e) {
    unpersisted.set(k, entry);
    log(`  [QUARANTINE] CRITICAL: could not persist quarantine to ${QUARANTINE_FILE} (${e instanceof Error ? e.message : String(e)}) — it holds only until this process stops`);
  }
}

/**
 * The quarantine entry blocking `symbol` (any source), or null. Re-reads the file on
 * every call. An unreadable quarantine file fails CLOSED (a synthetic entry, logged) —
 * never "not quarantined".
 */
export function quarantineEntryFor(symbol: string, log: (msg: string) => void): QuarantineEntry | null {
  const sym = symbol.toUpperCase();
  const key = quarantineKey(sym);
  for (const e of unpersisted.values()) if (quarantineKey(e.symbol) === key && applies(e)) return e;
  try {
    for (const e of Object.values(load().entries)) if (quarantineKey(e.symbol) === key && applies(e)) return e;
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`  [QUARANTINE] CRITICAL: ${msg} — treating ${sym} as quarantined`);
    return { strategy: "quarantine-file", symbol: sym, reason: msg, remediation: `Fix or remove ${QUARANTINE_FILE}`, time: new Date().toISOString(), network: activeNetwork };
  }
}

/** true when `symbol` is quarantined by any strategy / CLI path (see quarantineEntryFor). */
export function isQuarantined(symbol: string, log: (msg: string) => void): boolean {
  return quarantineEntryFor(symbol, log) !== null;
}

/** Entries that apply on this process's network (every entry when it never declared one). */
export function listQuarantine(): QuarantineEntry[] {
  return [...Object.values(load().entries), ...unpersisted.values()].filter(applies);
}

/** Remove entries (that apply on this process's network) whose quarantineKey matches symbol's (one source, or every source when null). Returns the removed entries. */
export function clearQuarantine(symbol: string, strategy: string | null): QuarantineEntry[] {
  return withQuarantineLock(() => {
    const f = load();
    const key = quarantineKey(symbol);
    const removed: QuarantineEntry[] = [];
    const match = (e: QuarantineEntry) => quarantineKey(e.symbol) === key && (strategy === null || e.strategy === strategy) && applies(e);
    for (const [k, e] of Object.entries(f.entries)) {
      if (match(e)) {
        removed.push(e);
        delete f.entries[k];
      }
    }
    for (const [k, e] of unpersisted) {
      if (match(e)) {
        removed.push(e);
        unpersisted.delete(k);
      }
    }
    if (removed.length > 0) save(f);
    return removed;
  });
}
