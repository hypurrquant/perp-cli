/**
 * Position quarantine: GLOBAL per canonical symbol, persisted, re-read on
 * every check, and FAIL-CLOSED — an unreadable file means "quarantined", never "clear".
 * HOME is isolated (helpers/isolate-home.ts): QUARANTINE_FILE lives in a temp dir.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  QUARANTINE_FILE, clearQuarantine, isQuarantined, listQuarantine, quarantineEntryFor, quarantineKey, quarantineSymbol,
} from "../../bot/quarantine.js";

const noop = () => {};

beforeEach(() => {
  rmSync(QUARANTINE_FILE, { force: true });
});

describe("quarantineKey — canonical symbol", () => {
  it("uppercases and trims", () => {
    expect(quarantineKey("  btc ")).toBe("BTC");
  });

  it("strips the HIP-3 dex prefix", () => {
    expect(quarantineKey("xyz:TSLA")).toBe("TSLA");
    expect(quarantineKey("XYZ:tsla")).toBe("TSLA");
  });

  it("strips the -PERP suffix", () => {
    expect(quarantineKey("ETH-PERP")).toBe("ETH");
  });

  it("applies denomination aliases (kPEPE ≡ 1000PEPE)", () => {
    expect(quarantineKey("kPEPE")).toBe("1000PEPE");
    expect(quarantineKey("1000PEPE")).toBe("1000PEPE");
  });
});

describe("quarantine is global per canonical key", () => {
  it("a quarantine by one source blocks the same underlying under every spelling", () => {
    quarantineSymbol("arb-exec", "xyz:TSLA", "unknown outcome", "check by hand", noop);
    expect(isQuarantined("TSLA", noop)).toBe(true);
    expect(isQuarantined("tsla-perp", noop)).toBe(true);
    expect(isQuarantined("BTC", noop)).toBe(false);
  });

  it("kPEPE quarantine blocks 1000PEPE", () => {
    quarantineSymbol("funding-arb", "kPEPE", "unhedged", "check", noop);
    expect(quarantineEntryFor("1000PEPE", noop)?.strategy).toBe("funding-arb");
  });

  it("persists to the file (survives a fresh read) and keeps the reported symbol for display", () => {
    quarantineSymbol("trade-close", "eth", "residual open", "close by hand", noop);
    const f = JSON.parse(readFileSync(QUARANTINE_FILE, "utf8"));
    expect(f.version).toBe(1);
    expect(f.entries["trade-close:ETH"]).toMatchObject({ strategy: "trade-close", symbol: "ETH", reason: "residual open" });
  });

  it("logs CRITICAL with the remediation and the clear command", () => {
    const log = vi.fn();
    quarantineSymbol("plan-execute", "BTC", "outcome unknown", "check BTC", log);
    const all = log.mock.calls.map(c => c[0]).join("\n");
    expect(all).toContain("CRITICAL");
    expect(all).toContain("check BTC");
    expect(all).toContain("perp strategy quarantine-clear BTC");
  });

  it("a clear from another process (file edit) takes effect on the next check (re-read)", () => {
    quarantineSymbol("arb-auto", "SOL", "r", "m", noop);
    expect(isQuarantined("SOL", noop)).toBe(true);
    writeFileSync(QUARANTINE_FILE, JSON.stringify({ version: 1, entries: {} }));
    expect(isQuarantined("SOL", noop)).toBe(false);
  });
});

describe("clearQuarantine", () => {
  it("clears by canonical key across spellings", () => {
    quarantineSymbol("arb-exec", "xyz:TSLA", "r", "m", noop);
    const removed = clearQuarantine("tsla", null);
    expect(removed).toHaveLength(1);
    expect(isQuarantined("TSLA", noop)).toBe(false);
  });

  it("--strategy clears only that source's entry; the symbol stays blocked by the other", () => {
    quarantineSymbol("arb-exec", "BTC", "r1", "m", noop);
    quarantineSymbol("funding-arb", "BTC", "r2", "m", noop);
    expect(clearQuarantine("BTC", "arb-exec")).toHaveLength(1);
    expect(quarantineEntryFor("BTC", noop)?.strategy).toBe("funding-arb");
    expect(listQuarantine()).toHaveLength(1);
  });
});

describe("fail-closed", () => {
  it("an unreadable (malformed JSON) file → every symbol is treated as quarantined, logged CRITICAL", () => {
    mkdirSync(dirname(QUARANTINE_FILE), { recursive: true });
    writeFileSync(QUARANTINE_FILE, "{ broken");
    const log = vi.fn();
    const e = quarantineEntryFor("BTC", log);
    expect(e).not.toBeNull();
    expect(e?.strategy).toBe("quarantine-file");
    expect(log.mock.calls.map(c => c[0]).join("\n")).toContain("treating BTC as quarantined");
  });

  it("a file with an unexpected shape fails closed too", () => {
    mkdirSync(dirname(QUARANTINE_FILE), { recursive: true });
    writeFileSync(QUARANTINE_FILE, JSON.stringify({ version: 2, entries: {} }));
    expect(isQuarantined("ETH", noop)).toBe(true);
  });

  it("listing / clearing a corrupt file throws (never reports 'nothing quarantined')", () => {
    mkdirSync(dirname(QUARANTINE_FILE), { recursive: true });
    writeFileSync(QUARANTINE_FILE, "not json");
    expect(() => listQuarantine()).toThrow(/unreadable/);
    expect(() => clearQuarantine("BTC", null)).toThrow(/unreadable/);
  });

  it("a quarantine whose persist fails is held in memory and still blocks the symbol", () => {
    mkdirSync(dirname(QUARANTINE_FILE), { recursive: true });
    writeFileSync(QUARANTINE_FILE, "not json"); // load() throws → persist fails
    const log = vi.fn();
    quarantineSymbol("arb-exec", "DOGE", "unknown", "check", log);
    expect(log.mock.calls.map(c => c[0]).join("\n")).toContain("could not persist");
    // Even after the file is repaired, the in-memory entry keeps blocking until this process stops.
    rmSync(QUARANTINE_FILE, { force: true });
    expect(quarantineEntryFor("DOGE", noop)?.strategy).toBe("arb-exec");
    expect(existsSync(QUARANTINE_FILE)).toBe(false);
  });
});
