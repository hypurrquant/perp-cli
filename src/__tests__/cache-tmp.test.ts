/**
 * cache.ts: each write goes through a tmp file unique per writer (pid + random), so two processes
 * writing the same key never rename each other's half-written file; the entry still round-trips.
 */
import { describe, it, expect, vi } from "vitest";

const writes = vi.hoisted(() => [] as string[]);
vi.mock("fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("fs")>();
  return { ...orig, writeFileSync: ((p: string, d: string) => { writes.push(String(p)); return orig.writeFileSync(p, d); }) as typeof orig.writeFileSync };
});

import { getCached, setCached, invalidateCache } from "../cache.js";

describe("setCached tmp files", () => {
  it("uses a distinct <key>.json.<pid>.<random>.tmp per write, then the entry reads back", () => {
    const key = `cache-tmp-test-${process.pid}`;
    setCached(key, { a: "1" }, 60_000);
    setCached(key, { a: "2" }, 60_000);
    const tmps = writes.filter(p => p.includes(key));
    expect(tmps).toHaveLength(2);
    for (const p of tmps) expect(p).toMatch(new RegExp(`${key}\\.json\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`));
    expect(tmps[0]).not.toBe(tmps[1]);
    expect(getCached<{ a: string }>(key)).toEqual({ a: "2" });
    invalidateCache(key);
    expect(getCached(key)).toBeNull();
  });
});
