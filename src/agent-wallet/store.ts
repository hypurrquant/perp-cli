import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { AgentMeta, AgentSource, AnyAgentMeta, ArcusAgentMeta, OndoAgentMeta, QfexAgentMeta, RisexAgentMeta, TxflowAgentMeta } from "../settings.js";
import { loadSettings, saveSettings } from "../settings.js";
import { PerpError } from "../errors.js";
import type { Network } from "../exchanges/venue-types.js";

const PERP_DIR = resolve(process.env["HOME"] ?? "~", ".perp");
const LOCKS_DIR = resolve(PERP_DIR, "locks");

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

function lockPath(exchange: string): string {
  return resolve(LOCKS_DIR, `agent-approve-${exchange}.lock`);
}

/**
 * Attempt to acquire the lockfile for an exchange's agent-approve operation.
 * Returns void on success. Throws LOCK_HELD if another live process holds it.
 * Auto-clears stale locks (>5 min old OR dead PID).
 *
 * Exported so callers can hold the lock across multiple operations (e.g. the
 * full approve flow) before calling setAgent.
 */
export function acquireLock(exchange: string): void {
  mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });
  const path = lockPath(exchange);

  if (existsSync(path)) {
    const contents = readFileSync(path, "utf-8");
    const [pidStr, tsStr] = contents.trim().split("\n");
    const pid = parseInt(pidStr ?? "", 10);
    const ts = tsStr ? new Date(tsStr).getTime() : 0;
    const age = Date.now() - ts;

    const isStaleByTime = isNaN(ts) || age > LOCK_STALE_MS;
    const isDeadPid = !isPidAlive(pid);

    if (!isStaleByTime && !isDeadPid) {
      throw new PerpError(
        "LOCK_HELD",
        `Agent approve lock held by PID ${pid} (started ${tsStr ?? "unknown"})`,
        {
          remediation: `Wait 5s and retry, or remove ~/.perp/locks/agent-approve-${exchange}.lock if stale`,
        },
      );
    }

    // Stale lock — clear it
    unlinkSync(path);
  }

  writeFileSync(path, `${process.pid}\n${new Date().toISOString()}`, { mode: 0o600 });
}

export function releaseLock(exchange: string): void {
  const path = lockPath(exchange);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Best effort — ignore failures on lock release
  }
}

/**
 * Returns true if the current process already holds the lock for this exchange.
 * Used by setAgent to implement re-entrant locking.
 */
function callerHoldsLock(exchange: string): boolean {
  const path = lockPath(exchange);
  if (!existsSync(path)) return false;
  try {
    const contents = readFileSync(path, "utf-8");
    const [pidStr] = contents.trim().split("\n");
    return parseInt(pidStr ?? "", 10) === process.pid;
  } catch {
    return false;
  }
}

/** Check whether a PID is alive via signal 0.
 *
 * `process.kill(pid, 0)` throws:
 *   - ESRCH  → no such process (dead)
 *   - EPERM  → process exists but we lack permission (alive — e.g. PID 1 on macOS)
 * Any other error is treated conservatively as "alive" to avoid clearing valid locks.
 */
function isPidAlive(pid: number): boolean {
  if (isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process → dead
    // EPERM = no permission to signal → process IS alive
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

/**
 * Returns the specific named agent, or the first non-partial agent when
 * agentName is omitted.
 */
/** Venues whose agents use a non-legacy meta shape (see getVenueAgent). */
const NON_LEGACY_AGENT_VENUES = new Set(["ondo", "arcus", "qfex", "risex", "txflow"]);

function assertLegacyAgentVenue(exchange: string): void {
  if (NON_LEGACY_AGENT_VENUES.has(exchange)) {
    throw new PerpError("INVALID_PARAMS", `${exchange} agents use a venue-specific meta; call getVenueAgent("${exchange}")`);
  }
}

export function getAgent(exchange: string, agentName?: string): AgentMeta | null {
  assertLegacyAgentVenue(exchange);
  const settings = loadSettings();
  const byExchange = settings.agents?.[exchange as keyof typeof settings.agents] as Record<string, AgentMeta> | undefined;
  if (!byExchange) return null;

  if (agentName !== undefined) {
    return byExchange[agentName] ?? null;
  }

  // Return first non-partial agent
  for (const meta of Object.values(byExchange)) {
    if (meta.status !== "partial") {
      return meta;
    }
  }
  return null;
}

/**
 * Venues whose agent approve/rotate was hardwired to mainnet endpoints before
 * agent records carried `network` — an untagged record of these venues was
 * provably registered on mainnet.
 */
const PRE_TAG_MAINNET_ONLY_VENUES = new Set(["aster", "hyperliquid", "pacifica"]);

/**
 * Network a legacy-shaped agent is registered on, or null when it cannot be
 * classified (an untagged Lighter-family record, whose approve always honored -n).
 */
export function recordedAgentNetworkOf(exchange: string, meta: AgentMeta): Network | null {
  if (meta.network !== undefined) return meta.network;
  if (PRE_TAG_MAINNET_ONLY_VENUES.has(exchange)) return "mainnet";
  return null;
}

/**
 * How an agent record got here (AgentMeta.source). Records written before the field existed were
 * all created by `wallet agent approve` (master-signed on this machine), except Ondo keys, which
 * are always created in the Ondo Perps web app.
 */
export function agentSourceOf(exchange: string, meta: AnyAgentMeta): AgentSource {
  if (meta.source !== undefined) return meta.source;
  return exchange === "ondo" || exchange === "qfex" ? "imported" : "approved";
}

/**
 * Network a legacy-shaped agent is registered on. Untagged Lighter-family
 * records (whose approve always honored -n) cannot be classified and throw.
 */
export function agentNetworkOf(exchange: string, meta: AgentMeta): Network {
  const recorded = recordedAgentNetworkOf(exchange, meta);
  if (recorded !== null) return recorded;
  throw new PerpError("AGENT_NOT_REGISTERED", `${exchange} agent "${meta.agentName}" has no recorded network (registered before network tagging)`, {
    remediation: `Set "network": "mainnet" or "testnet" on settings.agents["${exchange}"]["${meta.agentName}"] in ~/.perp/settings.json, or re-register it: perp [-n testnet] wallet agent rotate ${exchange} ${meta.agentName}`,
  });
}

/** Throws AGENT_NOT_REGISTERED when `meta` was registered on a different network than `network`. */
export function assertAgentNetwork(exchange: string, meta: AgentMeta, network: Network): void {
  const registered = agentNetworkOf(exchange, meta);
  if (registered !== network) {
    throw new PerpError("AGENT_NOT_REGISTERED", `${exchange} agent "${meta.agentName}" is registered on ${registered}, not ${network}`, {
      remediation: registered === "mainnet"
        ? `Run without -n testnet to use or manage it, or register a testnet agent: perp -n testnet wallet agent approve ${exchange}`
        : `Run with -n testnet to use or manage it, or register a mainnet agent: perp wallet agent approve ${exchange}`,
    });
  }
}

/** First non-partial agent of `exchange` registered on `network`, or null. */
export function getAgentForNetwork(exchange: string, network: Network): AgentMeta | null {
  assertLegacyAgentVenue(exchange);
  const settings = loadSettings();
  const byExchange = settings.agents?.[exchange as keyof typeof settings.agents] as Record<string, AgentMeta> | undefined;
  if (!byExchange) return null;
  for (const meta of Object.values(byExchange)) {
    if (meta.status !== "partial" && agentNetworkOf(exchange, meta) === network) return meta;
  }
  return null;
}

/**
 * Persist an agent meta entry for the given exchange.
 * Acquires a lockfile before writing to prevent concurrent races (AC-14).
 *
 * Re-entrant: if the calling process already holds the lock (e.g. the approve
 * flow acquired it at the start), this function writes directly without a
 * double-acquire or release.
 */
export function setAgent(exchange: string, meta: AgentMeta): void {
  assertLegacyAgentVenue(exchange);
  const alreadyLocked = callerHoldsLock(exchange);
  if (!alreadyLocked) {
    acquireLock(exchange);
  }
  try {
    const settings = loadSettings();
    if (!settings.agents) {
      settings.agents = {};
    }
    const key = exchange as keyof typeof settings.agents;
    if (!settings.agents[key]) {
      (settings.agents as Record<string, Record<string, AgentMeta>>)[exchange] = {};
    }
    (settings.agents as Record<string, Record<string, AgentMeta>>)[exchange][meta.agentName] = meta;
    saveSettings(settings);
  } finally {
    if (!alreadyLocked) {
      releaseLock(exchange);
    }
  }
}

/**
 * Delete an agent entry. Returns true if it existed and was removed, false if
 * it was already absent (idempotent per AC-4).
 */
export function deleteAgent(exchange: string, agentName: string): boolean {
  const settings = loadSettings();
  const byExchange = settings.agents?.[exchange as keyof typeof settings.agents] as
    | Record<string, AgentMeta>
    | undefined;
  if (!byExchange || !(agentName in byExchange)) {
    return false;
  }
  delete byExchange[agentName];
  saveSettings(settings);
  return true;
}

/**
 * List all registered agents, optionally filtered to a single exchange.
 */
export function listAgents(
  exchange?: string,
): Array<{ exchange: string; meta: AgentMeta }> {
  const settings = loadSettings();
  if (!settings.agents) return [];

  const result: Array<{ exchange: string; meta: AgentMeta }> = [];
  for (const [ex, agents] of Object.entries(settings.agents)) {
    if (exchange !== undefined && ex !== exchange) continue;
    if (NON_LEGACY_AGENT_VENUES.has(ex)) continue; // listed by listVenueAgents()
    if (agents && typeof agents === "object") {
      for (const meta of Object.values(agents as Record<string, AgentMeta>)) {
        result.push({ exchange: ex, meta });
      }
    }
  }
  return result;
}

// ── Venue-specific agent metas (Ondo HMAC key, Arcus Ed25519 key) ──

type VenueAgentMap = { ondo: OndoAgentMeta; arcus: ArcusAgentMeta; qfex: QfexAgentMeta; risex: RisexAgentMeta; txflow: TxflowAgentMeta };

/** Named agent, or the only/first registered one when agentName is omitted. */
export function getVenueAgent<V extends keyof VenueAgentMap>(venue: V, agentName?: string): VenueAgentMap[V] | null {
  const settings = loadSettings();
  const byVenue = settings.agents?.[venue] as Record<string, VenueAgentMap[V]> | undefined;
  if (!byVenue) return null;
  if (agentName !== undefined) return byVenue[agentName] ?? null;
  const first = Object.values(byVenue)[0];
  return first === undefined ? null : first;
}

/** First Ondo/Arcus agent registered on `network` (meta.network), or null — never another network's key. */
export function getVenueAgentForNetwork<V extends keyof VenueAgentMap>(venue: V, network: Network): VenueAgentMap[V] | null {
  const settings = loadSettings();
  const byVenue = settings.agents?.[venue] as Record<string, VenueAgentMap[V]> | undefined;
  if (!byVenue) return null;
  const match = Object.values(byVenue).find(m => m.network === network);
  return match === undefined ? null : match;
}

export function setVenueAgent<V extends keyof VenueAgentMap>(venue: V, meta: VenueAgentMap[V]): void {
  const alreadyLocked = callerHoldsLock(venue);
  if (!alreadyLocked) acquireLock(venue);
  try {
    const settings = loadSettings();
    if (!settings.agents) settings.agents = {};
    const map = (settings.agents[venue] ?? {}) as Record<string, VenueAgentMap[V]>;
    map[meta.agentName] = meta;
    (settings.agents as Record<string, unknown>)[venue] = map;
    saveSettings(settings);
  } finally {
    if (!alreadyLocked) releaseLock(venue);
  }
}

export function deleteVenueAgent(venue: keyof VenueAgentMap, agentName: string): boolean {
  const settings = loadSettings();
  const byVenue = settings.agents?.[venue] as Record<string, unknown> | undefined;
  if (!byVenue || !(agentName in byVenue)) return false;
  delete byVenue[agentName];
  saveSettings(settings);
  return true;
}

export function listVenueAgents(): Array<{ exchange: keyof VenueAgentMap; meta: VenueAgentMap[keyof VenueAgentMap] }> {
  const settings = loadSettings();
  const out: Array<{ exchange: keyof VenueAgentMap; meta: VenueAgentMap[keyof VenueAgentMap] }> = [];
  for (const v of ["ondo", "arcus", "qfex", "risex", "txflow"] as const) {
    const m = settings.agents?.[v] as Record<string, VenueAgentMap[keyof VenueAgentMap]> | undefined;
    if (m) for (const meta of Object.values(m)) out.push({ exchange: v, meta });
  }
  return out;
}
