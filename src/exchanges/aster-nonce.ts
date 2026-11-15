/**
 * Monotonic Aster V3 request nonce per signer.
 *
 * Aster requires a microsecond `nonce` within ±10 s of server time that is
 * never reused for the same signer. `Date.now() * 1000 + counter % 1000`
 * repeats across processes (two CLI calls in the same millisecond) and after a
 * clock step backwards. This allocator returns max(now µs, last + 1) and
 * persists `last` per signer in `~/.perp/aster-nonces.json` (public state, no
 * secrets), so successive processes never go backwards or collide.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";
import { perpPath } from "../paths.js";
import { PerpError } from "../errors.js";

function noncePath(): string {
  return perpPath("aster-nonces.json");
}

function readNonces(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.values(parsed as Record<string, unknown>).some(v => typeof v !== "string" || !/^\d+$/.test(v))) {
    throw new PerpError("INVALID_PARAMS", `Aster nonce state ${path} is corrupt`, {
      remediation: `Delete ${path} (it only stores the last request nonce per signer) and retry.`,
    });
  }
  return parsed as Record<string, string>;
}

/** How long to wait for another process's nonce lock, and when a lock left by a dead process is stale. */
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

/**
 * Run `fn` holding the exclusive lock file `<path>.lock` (O_EXCL create). The read → +1 → write
 * of the nonce file is not atomic by itself: two processes reading the same `last` would issue
 * the same nonce. A lock older than LOCK_STALE_MS (its holder died) is removed; a live one not
 * released within LOCK_WAIT_MS → LOCK_HELD (nothing is signed with an unreserved nonce).
 */
function withNonceLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue; // released between the open and the stat: try again
      }
      if (stale) {
        try { unlinkSync(lock); } catch { /* another process removed it */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new PerpError("LOCK_HELD", `Aster nonce state is locked by another perp process (${lock})`, {
          remediation: `Retry shortly; if no other perp process is running, delete ${lock}`,
        });
      }
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** Next nonce (µs, decimal string) for `signer`: strictly greater than the last one issued, across processes. */
export function nextAsterNonce(signer: string, nowMs: number = Date.now()): string {
  const path = noncePath();
  const key = signer.toLowerCase();
  const dir = resolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withNonceLock(path, () => {
    const nonces = readNonces(path);
    const now = BigInt(Math.floor(nowMs)) * 1000n;
    const last = nonces[key] !== undefined ? BigInt(nonces[key]) : -1n;
    const next = now > last ? now : last + 1n;
    nonces[key] = next.toString();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(nonces), { mode: 0o600 });
    renameSync(tmp, path);
    return next.toString();
  });
}
