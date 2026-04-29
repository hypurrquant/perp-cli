import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { AgentMeta } from "../settings.js";
import { loadSettings, saveSettings } from "../settings.js";
import { PerpError } from "../errors.js";

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
export function getAgent(exchange: string, agentName?: string): AgentMeta | null {
  const settings = loadSettings();
  const byExchange = settings.agents?.[exchange as keyof typeof settings.agents];
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
 * Persist an agent meta entry for the given exchange.
 * Acquires a lockfile before writing to prevent concurrent races (AC-14).
 *
 * Re-entrant: if the calling process already holds the lock (e.g. the approve
 * flow acquired it at the start), this function writes directly without a
 * double-acquire or release.
 */
export function setAgent(exchange: string, meta: AgentMeta): void {
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
    if (agents && typeof agents === "object") {
      for (const meta of Object.values(agents as Record<string, AgentMeta>)) {
        result.push({ exchange: ex, meta });
      }
    }
  }
  return result;
}
