/**
 * resolveSlippage: one resolver for every market-type order.
 * Precedence: --slippage-bps flag → settings.slippageBps[venue] → settings.defaultSlippageBps.
 * Out of range (< 1 or > venue maxSlippageBps) → INVALID_PARAMS before sending; NEVER clamped.
 *
 * HOME is isolated (helpers/isolate-home.ts): settings.json is written to a temp dir.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAdapterSlippage, resolveSlippage, venueMaxSlippageBps } from "../../exchanges/slippage.js";
import { SHIPPED_DEFAULT_SLIPPAGE_BPS } from "../../settings.js";

const perpDir = join(process.env.HOME as string, ".perp");
const settingsFile = join(perpDir, "settings.json");

function writeSettings(obj: Record<string, unknown>): void {
  mkdirSync(perpDir, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(obj));
}

function errOf(fn: () => unknown): { code?: string; message: string } {
  try { fn(); } catch (e) { return { code: (e as { structured?: { code?: string } }).structured?.code, message: (e as Error).message }; }
  throw new Error("expected a throw");
}

beforeEach(() => {
  rmSync(settingsFile, { force: true });
});

describe("resolveSlippage — precedence", () => {
  it("no settings file → shipped default (source 'default')", () => {
    expect(resolveSlippage("hyperliquid", null)).toEqual({ bps: SHIPPED_DEFAULT_SLIPPAGE_BPS, source: "default" });
  });

  it("settings.defaultSlippageBps applies when no per-venue value or flag", () => {
    writeSettings({ defaultSlippageBps: 80 });
    expect(resolveSlippage("hyperliquid", null)).toEqual({ bps: 80, source: "default" });
  });

  it("settings.slippageBps[venue] beats defaultSlippageBps", () => {
    writeSettings({ defaultSlippageBps: 80, slippageBps: { hyperliquid: 30 } });
    expect(resolveSlippage("hyperliquid", null)).toEqual({ bps: 30, source: "venue" });
  });

  it("per-venue value applies only to its own venue", () => {
    writeSettings({ defaultSlippageBps: 80, slippageBps: { hyperliquid: 30 } });
    expect(resolveSlippage("pacifica", null)).toEqual({ bps: 80, source: "default" });
  });

  it("the flag beats both settings values", () => {
    writeSettings({ defaultSlippageBps: 80, slippageBps: { hyperliquid: 30 } });
    expect(resolveSlippage("hyperliquid", 12)).toEqual({ bps: 12, source: "flag" });
  });

  it("resolveAdapterSlippage resolves by the adapter's venue id (bot/arb paths: no flag)", () => {
    writeSettings({ slippageBps: { aster: 25 } });
    expect(resolveAdapterSlippage({ name: "aster" }, null)).toEqual({ bps: 25, source: "venue" });
  });

  it("resolveAdapterSlippage refuses an unregistered adapter name (UNKNOWN_VENUE)", () => {
    expect(errOf(() => resolveAdapterSlippage({ name: "test-exchange" }, null)).code).toBe("UNKNOWN_VENUE");
  });
});

describe("resolveSlippage — validation (never clamps)", () => {
  it("flag above the venue max → INVALID_PARAMS naming --slippage-bps", () => {
    const max = venueMaxSlippageBps("arcus");
    const e = errOf(() => resolveSlippage("arcus", max + 1));
    expect(e.code).toBe("INVALID_PARAMS");
    expect(e.message).toContain("--slippage-bps");
  });

  it("flag exactly at the venue max is accepted unchanged", () => {
    const max = venueMaxSlippageBps("arcus");
    expect(resolveSlippage("arcus", max)).toEqual({ bps: max, source: "flag" });
  });

  it("flag below 1 bps → INVALID_PARAMS", () => {
    expect(errOf(() => resolveSlippage("hyperliquid", 0.5)).code).toBe("INVALID_PARAMS");
  });

  it("non-finite flag → INVALID_PARAMS", () => {
    expect(errOf(() => resolveSlippage("hyperliquid", Number.NaN)).code).toBe("INVALID_PARAMS");
    expect(errOf(() => resolveSlippage("hyperliquid", Number.POSITIVE_INFINITY)).code).toBe("INVALID_PARAMS");
  });

  it("a per-venue setting above the venue max is rejected (names the setting), not clamped", () => {
    writeSettings({ slippageBps: { arcus: venueMaxSlippageBps("arcus") + 1 } });
    const e = errOf(() => resolveSlippage("arcus", null));
    expect(e.code).toBe("INVALID_PARAMS");
    expect(e.message).toContain("slippageBps.arcus");
  });

  it("a default above the venue max is rejected for that venue only", () => {
    writeSettings({ defaultSlippageBps: 2000 }); // > arcus max (1000), < hyperliquid max (5000)
    expect(errOf(() => resolveSlippage("arcus", null)).message).toContain("defaultSlippageBps");
    expect(resolveSlippage("hyperliquid", null)).toEqual({ bps: 2000, source: "default" });
  });
});

describe("settings slippage parsing is strict (no silent default substitution)", () => {
  it("non-numeric defaultSlippageBps → INVALID_PARAMS", () => {
    writeSettings({ defaultSlippageBps: "50" });
    expect(errOf(() => resolveSlippage("hyperliquid", null)).code).toBe("INVALID_PARAMS");
  });

  it("slippageBps for an unknown venue → INVALID_PARAMS", () => {
    writeSettings({ slippageBps: { "test-exchange": 50 } });
    expect(errOf(() => resolveSlippage("hyperliquid", null)).message).toContain('unknown venue "test-exchange"');
  });

  it("slippageBps value below 1 → INVALID_PARAMS", () => {
    writeSettings({ slippageBps: { hyperliquid: 0 } });
    expect(errOf(() => resolveSlippage("hyperliquid", null)).code).toBe("INVALID_PARAMS");
  });

  it("malformed JSON → INVALID_PARAMS (not defaults)", () => {
    mkdirSync(perpDir, { recursive: true });
    writeFileSync(settingsFile, "{not json");
    expect(errOf(() => resolveSlippage("hyperliquid", null)).code).toBe("INVALID_PARAMS");
  });
});
