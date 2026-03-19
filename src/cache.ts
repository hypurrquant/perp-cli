/**
 * File-based TTL cache for cross-process API call deduplication.
 *
 * Dashboard and CLI share cached data via /tmp/perp-cli-cache/.
 * Writes are atomic (write to .tmp then rename) to prevent partial reads.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CACHE_DIR = join(tmpdir(), "perp-cli-cache");

// TTL presets
export const TTL_ACCOUNT = 5_000;   // 5s — balance, positions, orders
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
    const tmp = file + ".tmp";
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
export function invalidateCache(keyPrefix?: string): void {
  try {
    const prefix = keyPrefix ? safeKey(keyPrefix) : "";
    const files = readdirSync(CACHE_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      if (!prefix || f.startsWith(prefix)) {
        try { unlinkSync(join(CACHE_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}
