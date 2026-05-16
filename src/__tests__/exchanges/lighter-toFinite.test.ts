import { describe, expect, it } from "vitest";
import { LighterAdapter } from "../../exchanges/lighter.js";
import { PerpError } from "../../errors.js";

/**
 * Unit tests for `LighterAdapter._toFiniteNumber` — the venue-payload
 * coercion helper used by getBalance / getPositions to reject NaN and
 * Infinity instead of silently substituting 0.
 *
 * Same Rule #2 spirit as the v0.13.0 cycle's `_computeMidSum` /
 * `_assertOutcomeRange` helpers: nullish input is allowed (venue may
 * legitimately omit a field for an empty account), but corrupted
 * values must throw rather than masquerade as zero balance.
 */

describe("LighterAdapter._toFiniteNumber — Rule #2 venue-payload coercion", () => {
  it("returns finite numbers unchanged", () => {
    expect(LighterAdapter._toFiniteNumber(0, "x")).toBe(0);
    expect(LighterAdapter._toFiniteNumber(1234.56, "x")).toBe(1234.56);
    expect(LighterAdapter._toFiniteNumber(-50, "x")).toBe(-50);
  });

  it("parses numeric strings into finite numbers", () => {
    expect(LighterAdapter._toFiniteNumber("0", "x")).toBe(0);
    expect(LighterAdapter._toFiniteNumber("123.45", "x")).toBe(123.45);
    expect(LighterAdapter._toFiniteNumber("-1.5", "x")).toBe(-1.5);
  });

  it("returns the default value (0) for undefined / null — venue may omit a field", () => {
    expect(LighterAdapter._toFiniteNumber(undefined, "x")).toBe(0);
    expect(LighterAdapter._toFiniteNumber(null, "x")).toBe(0);
  });

  it("respects a custom default value", () => {
    expect(LighterAdapter._toFiniteNumber(undefined, "x", 1)).toBe(1);
    expect(LighterAdapter._toFiniteNumber(null, "x", -42)).toBe(-42);
  });

  it("throws EXCHANGE_ERROR for NaN — silent zero substitution would mask broken accounting", () => {
    expect(() => LighterAdapter._toFiniteNumber(NaN, "total_asset_value")).toThrow(PerpError);
    try {
      LighterAdapter._toFiniteNumber(NaN, "total_asset_value");
      expect.fail("expected throw");
    } catch (e) {
      const err = e as PerpError;
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      expect(err.message).toMatch(/`total_asset_value` is not a finite number/);
      // Exchange tag is nested under `details` per PerpError constructor
      // (third-arg `details` are stripped of `remediation` and bagged into
      // `structured.details`). classifyError later promotes it to top-level.
      expect((err.structured as { details?: { exchange?: string } }).details?.exchange).toBe("lighter");
    }
  });

  it("throws EXCHANGE_ERROR for ±Infinity", () => {
    expect(() => LighterAdapter._toFiniteNumber(Infinity, "x")).toThrow(/not a finite number/);
    expect(() => LighterAdapter._toFiniteNumber(-Infinity, "x")).toThrow(/not a finite number/);
  });

  it("throws EXCHANGE_ERROR for non-numeric strings (Number(s) → NaN)", () => {
    expect(() => LighterAdapter._toFiniteNumber("abc", "x")).toThrow(/not a finite number/);
    expect(() => LighterAdapter._toFiniteNumber("12abc", "x")).toThrow(/not a finite number/);
  });

  // qa/2026-05-16 strict-policy update:
  // The earlier policy (26d78d7) allowed Number("") === 0 — empty string
  // was treated as "venue stringified zero". That made "" indistinguishable
  // from a stale-cache partial response and surfaced as a phantom $0
  // balance downstream (rebalance plan, event-stream balance_update,
  // outcome time). The strict policy now rejects "" alongside NaN/Infinity;
  // truly absent fields must use undefined/null at the adapter layer.
  it("throws EXCHANGE_ERROR for empty string '' — corruption, not 'venue stringified zero'", () => {
    expect(() => LighterAdapter._toFiniteNumber("", "available_balance")).toThrow(PerpError);
    expect(() => LighterAdapter._toFiniteNumber("", "available_balance"))
      .toThrow(/empty string/);
    try {
      LighterAdapter._toFiniteNumber("", "available_balance");
      expect.fail("expected throw");
    } catch (e) {
      const err = e as PerpError;
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      expect(err.message).toMatch(/`available_balance` is an empty string/);
      expect(err.message).toMatch(/use null for missing data/);
      expect((err.structured as { details?: { exchange?: string } }).details?.exchange).toBe("lighter");
    }
  });

  it("includes the field name in the error so the failing endpoint is attributable", () => {
    expect(() => LighterAdapter._toFiniteNumber("xyz", "available_balance")).toThrow(/`available_balance`/);
    expect(() => LighterAdapter._toFiniteNumber(NaN, "position.unrealized_pnl")).toThrow(/`position\.unrealized_pnl`/);
  });

  it("includes the original (stringified) value in the error message for triage", () => {
    expect(() => LighterAdapter._toFiniteNumber("garbled", "x")).toThrow(/"garbled"/);
  });
});
