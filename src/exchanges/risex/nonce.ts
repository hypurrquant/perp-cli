/**
 * RISEx permit nonces: (anchor uint48, bit 0..207) pairs, each consumable once on-chain.
 *
 * Allocation (one per signed action), under an exclusive per-account file lock:
 *   remote  = GET /v1/nonce-state/{account}  → nonce_anchor A
 *   base    = (A + 1, bit 0)                  — "sign with nonce_anchor + 1 and start at bit 0"
 *   local   = last pair THIS machine handed out for the account (~/.perp/risex-nonce/…)
 *   next    = local successor when local ≥ base (bit + 1; after bit 207 the next anchor), else base
 * The contract accepts only the current anchor or current + 1, so a successor beyond A + 1 (208
 * permits signed on A + 1 while the chain has not caught up) is refused, never guessed.
 * `current_bitmap_index` describes the CURRENT anchor A, which perp-cli deliberately never signs on
 * (developer.rise.trade "Integration" → Nonces: "Sign with nonce_anchor + 1 and start at bit 0 …
 * starting a fresh anchor guarantees you cannot collide with a permit already in flight"), so it
 * does not enter the rule. Gaps in a bitmap are harmless (same doc).
 *
 * The allocated pair is persisted BEFORE the caller signs or sends: a pair is handed out once and
 * never reused, even when the send fails or its outcome is unknown (an unknown outcome burns the
 * bit). Restart-safe: the next allocation takes the max of the chain state and the local file.
 * The state file holds no secrets.
 */

import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { perpPath } from "../../paths.js";
import { PerpError } from "../../errors.js";
import type { Network } from "../venue-types.js";
import type { NonceSlot } from "./typed-data.js";

export const RISEX_MAX_BIT = 207;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 60_000;

export interface RemoteNonceState { anchor: bigint; currentBitmapIndex: number }

export function risexNonceDir(): string {
  return perpPath("risex-nonce");
}

function statePath(dir: string, net: Network, account: string): string {
  return resolve(dir, `${net}-${account.toLowerCase()}.json`);
}

function readLocal(path: string): NonceSlot | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf-8")); } catch { parsed = null; }
  const p = parsed as { anchor?: unknown; bit?: unknown } | null;
  if (p === null || typeof p.anchor !== "string" || !/^\d+$/.test(p.anchor) || typeof p.bit !== "number" || !Number.isInteger(p.bit) || p.bit < 0 || p.bit > RISEX_MAX_BIT) {
    throw new PerpError("INVALID_PARAMS", `RISEx nonce state ${path} is corrupt`, {
      exchange: "risex",
      remediation: `Delete ${path} (it only records the last permit nonce handed out; the chain state is re-read) and retry`,
    });
  }
  return { anchor: BigInt(p.anchor), bit: p.bit };
}

function writeLocal(path: string, slot: NonceSlot): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ anchor: slot.anchor.toString(), bit: slot.bit, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  renameSync(tmp, path);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * A lock is stale only when it is older than LOCK_STALE_MS AND its holder process is gone. A young
 * lock, a live holder, or unparseable content (never written that way — the lock is linked into
 * place complete) is respected.
 */
function lockIsStale(content: string, mtimeMs: number): boolean {
  if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false;
  const pid = Number(content.split("\n")[0]);
  return !pidAlive(pid);
}

/**
 * Take over a stale lock without racing another process doing the same: the lock is RENAMED to a
 * name unique to this process (atomic — only one taker wins), and only if the moved file is still
 * the one judged stale is it deleted; a fresh lock moved by mistake is put back (link fails if a
 * new lock already exists, in which case that one stands).
 */
function takeOverStale(lock: string, seen: string): void {
  const mine = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try { renameSync(lock, mine); } catch { return; } // another process took it first
  let moved: string | null = null;
  try { moved = readFileSync(mine, "utf-8"); } catch { /* vanished */ }
  if (moved !== null && moved !== seen) {
    try { linkSync(mine, lock); } catch { /* a newer lock exists: it stands */ }
  }
  try { unlinkSync(mine); } catch { /* already gone */ }
}

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = `${process.pid}\n${Date.now()}\n${Math.random().toString(36).slice(2)}`;
  for (;;) {
    // The lock is written to a private temp file first and LINKED into place (link fails if the
    // lock exists), so a reader never sees an empty or partial lock.
    const tmp = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, token, { mode: 0o600 });
    try {
      linkSync(tmp, lock);
      unlinkSync(tmp);
      break;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* gone */ }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let content: string;
      let mtimeMs: number;
      try {
        content = readFileSync(lock, "utf-8");
        mtimeMs = statSync(lock).mtimeMs;
      } catch { continue; } // released between the open and the read: try again
      if (lockIsStale(content, mtimeMs)) {
        takeOverStale(lock, content);
        continue;
      }
      if (Date.now() > deadline) {
        throw new PerpError("LOCK_HELD", `RISEx nonce state is locked by another perp process (${lock})`, {
          exchange: "risex", remediation: `Retry shortly; if no other perp process is running, delete ${lock}`,
        });
      }
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock (never one a stale-takeover replaced).
    try { if (readFileSync(lock, "utf-8") === token) unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** Pure allocation rule (see module doc). */
export function nextSlot(remote: RemoteNonceState, local: NonceSlot | null): NonceSlot {
  const base: NonceSlot = { anchor: remote.anchor + 1n, bit: 0 };
  let next = base;
  if (local !== null && (local.anchor > base.anchor || (local.anchor === base.anchor && local.bit >= base.bit))) {
    next = local.bit + 1 > RISEX_MAX_BIT ? { anchor: local.anchor + 1n, bit: 0 } : { anchor: local.anchor, bit: local.bit + 1 };
  }
  if (next.anchor > remote.anchor + 1n) {
    throw new PerpError("EXCHANGE_ERROR", `RISEx nonce anchor ${remote.anchor + 1n} is used up locally and the chain still reports anchor ${remote.anchor} — nothing was signed`, {
      exchange: "risex", remediation: "Wait a few seconds for pending RISEx actions to land, then retry",
    });
  }
  return next;
}

export function parseRemoteNonceState(data: unknown): RemoteNonceState {
  const d = data as { nonce_anchor?: unknown; current_bitmap_index?: unknown } | null;
  if (d === null || typeof d.nonce_anchor !== "string" || !/^\d+$/.test(d.nonce_anchor) || typeof d.current_bitmap_index !== "number") {
    throw new PerpError("EXCHANGE_ERROR", `RISEx /v1/nonce-state: malformed response ${JSON.stringify(data).slice(0, 120)}`, { exchange: "risex" });
  }
  return { anchor: BigInt(d.nonce_anchor), currentBitmapIndex: d.current_bitmap_index };
}

/**
 * Allocate one nonce pair for `account` and persist it before returning (burned from here on).
 * `fetchRemote` reads /v1/nonce-state inside the lock.
 */
export async function allocateNonce(net: Network, account: string, fetchRemote: () => Promise<RemoteNonceState>, dir: string = risexNonceDir()): Promise<NonceSlot> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = statePath(dir, net, account);
  return withLock(path, async () => {
    const remote = await fetchRemote();
    const slot = nextSlot(remote, readLocal(path));
    writeLocal(path, slot);
    return slot;
  });
}

/** Last pair handed out on this machine (diagnostics / reconciliation), or null. */
export function lastAllocated(net: Network, account: string, dir: string = risexNonceDir()): NonceSlot | null {
  return readLocal(statePath(dir, net, account));
}

/** Whether (anchor, bit) is consumed according to /v1/nonce-state's `bitmap` (only when the anchor matches). null = cannot tell. */
export function bitConsumed(state: { anchor: bigint; bitmap: string | null }, slot: NonceSlot): boolean | null {
  if (state.anchor > slot.anchor) return null; // the chain moved past this anchor: the bitmap no longer describes it
  if (state.anchor < slot.anchor) return false; // the anchor was never reached on-chain
  if (state.bitmap === null || !/^0x[0-9a-fA-F]+$/.test(state.bitmap)) return null;
  return ((BigInt(state.bitmap) >> BigInt(slot.bit)) & 1n) === 1n;
}
