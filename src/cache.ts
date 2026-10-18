/**
 * File-based TTL cache for cross-process API call deduplication.
 *
 * Dashboard and CLI share cached data via /tmp/perp-cli-cache/.
 * Writes are atomic (write to .tmp then rename) to prevent partial reads.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const CACHE_DIR = join(tmpdir(), "perp-cli-cache");

// TTL presets
export const TTL_ACCOUNT = 15_000;  // 15s — balance, positions, orders (ticks are 30s; 15s ensures same-tick dedup)
export const TTL_MARKET = 30_000;   // 30s — funding rates, prices, markets

interface CacheEntry<T = unknown> {
  ts: number;
  ttl: number;
  data: T;
}

let dirReady = false;

function ensureDir(): void {
  if (dirReady) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    dirReady = true;
  } catch {
    // ignore — reads/writes will fail gracefully
  }
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getCached<T>(key: string): T | null {
  try {
    const raw = readFileSync(join(CACHE_DIR, `${safeKey(key)}.json`), "utf-8");
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (Date.now() - entry.ts < entry.ttl) {
      return entry.data;
    }
    return null;
  } catch {
    return null;
  }
}

export function setCached<T>(key: string, data: T, ttlMs: number): void {
  ensureDir();
  try {
    const entry: CacheEntry<T> = { ts: Date.now(), ttl: ttlMs, data };
    const content = JSON.stringify(entry);
    const file = join(CACHE_DIR, `${safeKey(key)}.json`);
    // Unique per writer: concurrent processes writing the same key must not share one tmp file
    // (a rename of another writer's half-written tmp would publish a partial entry).
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch {
    // cache write failure is non-fatal
  }
}

/**
 * Read-through cache: returns cached data if fresh, else fetches and caches.
 * Used by dashboard and read-only queries.
 */
export async function withCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const cached = getCached<T>(key);
  if (cached !== null) return cached;
  const data = await fetcher();
  setCached(key, data, ttlMs);
  return data;
}

/**
 * Write-through fetch: always fetches live data, then writes to cache for others to use.
 * Used by execution layer (CLI trades) where stale data is unacceptable.
 */
export async function fetchAndCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const data = await fetcher();
  setCached(key, data, ttlMs);
  return data;
}

/**
 * Invalidate cache entries matching a prefix (e.g., "acct" after a trade).
 */
let _accountEpoch = 0;

/**
 * Monotonic counter bumped on every account-cache invalidation. Adapters that keep
 * in-process account / position / order snapshots (Aster) store the epoch with the
 * snapshot and treat a mismatch as stale, so `invalidateCache("acct")` also reaches them.
 */
export function accountCacheEpoch(): number {
  return _accountEpoch;
}

export function invalidateCache(keyPrefix?: string): void {
  if (keyPrefix === undefined || keyPrefix === "acct" || "acct".startsWith(keyPrefix)) _accountEpoch++;
  try {
    const prefix = keyPrefix ? safeKey(keyPrefix) : "";
    const files = readdirSync(CACHE_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue; // also skips in-flight "<key>.json.<pid>.<rand>.tmp" files
      if (!prefix || f.startsWith(prefix)) {
        try { unlinkSync(join(CACHE_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}
