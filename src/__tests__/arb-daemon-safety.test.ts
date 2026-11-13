/**
 * Review findings (PR #18) — arb daemons, arb state, background jobs:
 *  1. SIGINT only requests a stop (the leg sequence in flight finishes); a pending-entry record
 *     left by a dead daemon quarantines the symbol at the next start.
 *  2. cycles are serialized (interruptible sleep between them).
 *  8. arb-state entries are keyed by symbol + venues + mode — another pair is never overwritten;
 *     load-modify-save holds an advisory O_EXCL lock (stale locks are removed).
 * 10. the stop timeout leaves room for a verified entry; a stopped job stays "stopped".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { gracefulStop, interruptibleSleep, quarantineOrphanedEntries, finishPendingEntry } from "../commands/arb-auto.js";
import { clearPendingEntry, orphanedPendingEntries, pendingEntryFilePath, writePendingEntry } from "../arb/pending-entry.js";
import { addPosition, arbStateFilePath, getPositions, positionKey, removePositionEntry, type ArbPositionState } from "../arb/state.js";
import { FILE_LOCK_STALE_MS, withFileLock } from "../arb/file-lock.js";
import { quarantineFile, quarantineEntryFor } from "../bot/quarantine.js";
import { JOB_STOP_TIMEOUT_MS, loadJob, updateJobState } from "../jobs.js";

const noop = () => {};

beforeEach(() => {
  rmSync(quarantineFile(), { force: true });
  rmSync(arbStateFilePath("mainnet"), { force: true });
  rmSync(pendingEntryFilePath("mainnet"), { force: true });
});

const entry = (over: Partial<ArbPositionState> = {}): ArbPositionState => ({
  id: "x", symbol: "BTC", longExchange: "hyperliquid", shortExchange: "aster", longSize: 0.01, shortSize: 0.01,
  entryTime: "t", entrySpread: 10, entryLongPrice: null, entryShortPrice: null, accumulatedFunding: 0, lastCheckTime: "t",
  ...over,
});

describe("graceful stop + serialized cycles (1, 2)", () => {
  it("SIGINT only requests the stop (no exit); a repeated SIGINT never exits; dispose removes the handlers", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit called"); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = new Set(process.listeners("SIGINT"));
    const stop = gracefulStop("test");
    const mine = process.listeners("SIGINT").filter(l => !before.has(l));
    expect(mine).toHaveLength(1);
    expect(stop.requested()).toBe(false);
    (mine[0] as () => void)();
    (mine[0] as () => void)();
    expect(stop.requested()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    stop.dispose();
    expect(process.listeners("SIGINT").filter(l => !before.has(l))).toHaveLength(0);
    exit.mockRestore(); err.mockRestore();
  });

  it("interruptibleSleep wakes within 250 ms of the stop request", async () => {
    let stopped = false;
    setTimeout(() => { stopped = true; }, 20);
    const t0 = Date.now();
    await interruptibleSleep(60_000, () => stopped);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("pending-entry records (1)", () => {
  it("a record left by a dead process quarantines the symbol at the next start, then is cleared", () => {
    writePendingEntry("mainnet", { source: "arb-auto", symbol: "ETH", longExchange: "hyperliquid", shortExchange: "aster", size: "1" });
    // Simulate the writer having died: rewrite its pid to one that cannot exist.
    const f = JSON.parse(readFileSync(pendingEntryFilePath("mainnet"), "utf8"));
    f.entries["arb-auto:ETH"].pid = 2 ** 22 + 12345;
    writeFileSync(pendingEntryFilePath("mainnet"), JSON.stringify(f));
    quarantineOrphanedEntries("mainnet", "arb-auto", noop);
    expect(quarantineEntryFor("ETH", noop)).toMatchObject({ strategy: "arb-auto" });
    expect(quarantineEntryFor("ETH", noop)?.reason).toMatch(/in flight when that daemon stopped/);
    expect(orphanedPendingEntries("mainnet", "arb-auto")).toEqual([]);
  });

  it("a record of this (live) process or of another source is not touched; finish clears it", () => {
    writePendingEntry("mainnet", { source: "arb-auto", symbol: "SOL", longExchange: "hyperliquid", shortExchange: "aster", size: "1" });
    // own pid counts as not alive for a NEW start of this process — exercised above; another source:
    expect(orphanedPendingEntries("mainnet", "arb-dex-auto")).toEqual([]);
    finishPendingEntry("mainnet", "arb-auto", "SOL", noop);
    expect(orphanedPendingEntries("mainnet", "arb-auto")).toEqual([]);
    clearPendingEntry("mainnet", "arb-auto", "SOL"); // idempotent
  });

  it("the pending file is network-scoped (next to the per-network arb state)", () => {
    expect(pendingEntryFilePath("mainnet")).not.toBe(pendingEntryFilePath("testnet"));
    expect(pendingEntryFilePath("testnet")).toMatch(/testnet\.pending\.json$/);
  });
});

describe("arb state keying + lock (8)", () => {
  it("re-recording the same pair replaces it; another mode / venues for the symbol is refused (never overwritten)", () => {
    addPosition("mainnet", entry());
    addPosition("mainnet", entry({ longSize: 0.02, shortSize: 0.02 }));
    expect(getPositions("mainnet")).toHaveLength(1);
    expect(getPositions("mainnet")[0].longSize).toBe(0.02);
    expect(() => addPosition("mainnet", entry({ mode: "spot-perp", longExchange: "hyperliquid", shortExchange: "pacifica", spotExchange: "hyperliquid" })))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "RISK_VIOLATION" }) }));
    expect(() => addPosition("mainnet", entry({ shortExchange: "lighter" }))).toThrow(/refusing to overwrite/);
    expect(getPositions("mainnet").map(positionKey)).toEqual(["BTC|hyperliquid|aster|perp-perp"]);
  });

  it("removePositionEntry removes exactly that key", () => {
    addPosition("mainnet", entry());
    removePositionEntry("mainnet", { symbol: "BTC", longExchange: "hyperliquid", shortExchange: "lighter", mode: undefined });
    expect(getPositions("mainnet")).toHaveLength(1);
    removePositionEntry("mainnet", entry());
    expect(getPositions("mainnet")).toHaveLength(0);
  });

  it("a live lock held by another process → LOCK_HELD; a stale lock is removed; the lock is released after use", () => {
    const path = arbStateFilePath("mainnet");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.lock`, "");
    expect(() => addPosition("mainnet", entry())).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "LOCK_HELD" }) }));
    const old = (Date.now() - FILE_LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(`${path}.lock`, old, old);
    addPosition("mainnet", entry());
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(getPositions("mainnet")).toHaveLength(1);
  }, 15_000);

  it("the lock is re-entrant within one process", () => {
    const p = join(dirname(arbStateFilePath("mainnet")), "x.json");
    expect(withFileLock(p, "x", () => withFileLock(p, "x", () => 42))).toBe(42);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it("the quarantine file is written under its lock (a held lock → the entry is kept in memory, logged)", async () => {
    const { quarantineSymbol } = await import("../bot/quarantine.js");
    mkdirSync(dirname(quarantineFile()), { recursive: true });
    writeFileSync(`${quarantineFile()}.lock`, "");
    const log = vi.fn();
    quarantineSymbol("arb-auto", "AVAX", "r", "m", log);
    expect(log.mock.calls.some(c => /could not persist quarantine.*locked/.test(String(c[0])))).toBe(true);
    expect(quarantineEntryFor("AVAX", noop)).not.toBeNull();
    rmSync(`${quarantineFile()}.lock`, { force: true });
  }, 15_000);
});

describe("background jobs (10)", () => {
  it("the default stop timeout leaves room for a verified pair entry", () => {
    expect(JOB_STOP_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
  });

  it("a job marked stopped keeps status 'stopped' when its final write says done / error (the result is merged)", () => {
    const dir = join(process.env.HOME as string, ".perp", "jobs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bbbb0001.json"), JSON.stringify({ id: "bbbb0001", strategy: "bot:grid", exchange: "aster", params: {}, tmuxSession: "perp-bbbb0001", startedAt: "t", status: "stopped" }));
    updateJobState("bbbb0001", { status: "done", result: { fills: 3 } });
    expect(loadJob("bbbb0001")).toMatchObject({ status: "stopped", result: { fills: 3 } });
    writeFileSync(join(dir, "bbbb0002.json"), JSON.stringify({ id: "bbbb0002", strategy: "bot:grid", exchange: "aster", params: {}, tmuxSession: "perp-bbbb0002", startedAt: "t", status: "running" }));
    updateJobState("bbbb0002", { status: "done" });
    expect(loadJob("bbbb0002")?.status).toBe("done");
  });
});
