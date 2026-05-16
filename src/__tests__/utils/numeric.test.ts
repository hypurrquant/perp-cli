import { describe, expect, it } from "vitest";
import { parseFiniteVenueNumber } from "../../utils/numeric.js";
import { PerpError } from "../../errors.js";

/**
 * Unit tests for `parseFiniteVenueNumber` — the shared venue-payload
 * coercion helper used by all 4 exchange adapters.
 *
 * Pins the qa/2026-05-16 strict policy:
 *  - undefined / null → defaultValue (venue may omit a field)
 *  - empty string "" → throw (corruption, not "stringified zero")
 *  - NaN / Infinity / non-numeric → throw
 *  - finite number / numeric string → pass through
 *
 * Mirrors the historical lighter-toFinite.test.ts contract since this
 * helper is the consolidation of that adapter-local static method.
 */

describe("parseFiniteVenueNumber — happy path", () => {
  it("returns finite numbers unchanged", () => {
    expect(parseFiniteVenueNumber(0, "x", "lighter")).toBe(0);
    expect(parseFiniteVenueNumber(1234.56, "x", "hyperliquid")).toBe(1234.56);
    expect(parseFiniteVenueNumber(-50, "x", "aster")).toBe(-50);
  });

  it("parses numeric strings into finite numbers", () => {
    expect(parseFiniteVenueNumber("0", "x", "pacifica")).toBe(0);
    expect(parseFiniteVenueNumber("123.45", "x", "pacifica")).toBe(123.45);
    expect(parseFiniteVenueNumber("-1.5", "x", "pacifica")).toBe(-1.5);
  });
});

describe("parseFiniteVenueNumber — missing field semantics", () => {
  it("returns 0 by default for undefined / null", () => {
    expect(parseFiniteVenueNumber(undefined, "x", "lighter")).toBe(0);
    expect(parseFiniteVenueNumber(null, "x", "lighter")).toBe(0);
  });

  it("respects custom defaultValue for undefined / null only", () => {
    expect(parseFiniteVenueNumber(undefined, "x", "lighter", { defaultValue: 1 })).toBe(1);
    expect(parseFiniteVenueNumber(null, "x", "lighter", { defaultValue: -42 })).toBe(-42);
    // Custom default does NOT apply to "" / NaN / Infinity — those still throw
    expect(() => parseFiniteVenueNumber("", "x", "lighter", { defaultValue: 99 })).toThrow();
    expect(() => parseFiniteVenueNumber(NaN, "x", "lighter", { defaultValue: 99 })).toThrow();
  });
});

describe("parseFiniteVenueNumber — strict rejection (Rule #2)", () => {
  it("throws EXCHANGE_ERROR for NaN", () => {
    expect(() => parseFiniteVenueNumber(NaN, "total_asset_value", "lighter")).toThrow(PerpError);
    try {
      parseFiniteVenueNumber(NaN, "total_asset_value", "lighter");
      expect.fail("expected throw");
    } catch (e) {
      const err = e as PerpError;
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      expect(err.message).toMatch(/`total_asset_value` is not a finite number/);
      expect((err.structured as { details?: { exchange?: string } }).details?.exchange).toBe("lighter");
    }
  });

  it("throws EXCHANGE_ERROR for ±Infinity", () => {
    expect(() => parseFiniteVenueNumber(Infinity, "x", "hyperliquid")).toThrow(/not a finite number/);
    expect(() => parseFiniteVenueNumber(-Infinity, "x", "hyperliquid")).toThrow(/not a finite number/);
  });

  it("throws EXCHANGE_ERROR for non-numeric strings (Number(s) → NaN)", () => {
    expect(() => parseFiniteVenueNumber("abc", "x", "aster")).toThrow(/not a finite number/);
    expect(() => parseFiniteVenueNumber("12abc", "x", "aster")).toThrow(/not a finite number/);
  });

  it("throws EXCHANGE_ERROR for empty string '' (qa/2026-05-16 strict policy)", () => {
    expect(() => parseFiniteVenueNumber("", "available_balance", "pacifica")).toThrow(PerpError);
    expect(() => parseFiniteVenueNumber("", "available_balance", "pacifica")).toThrow(/empty string/);
    try {
      parseFiniteVenueNumber("", "available_balance", "pacifica");
      expect.fail("expected throw");
    } catch (e) {
      const err = e as PerpError;
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      expect(err.message).toMatch(/`available_balance` is an empty string/);
      expect(err.message).toMatch(/use null for missing data/);
      expect((err.structured as { details?: { exchange?: string } }).details?.exchange).toBe("pacifica");
    }
  });
});

describe("parseFiniteVenueNumber — error context for triage", () => {
  it("includes the field name in the error so the failing endpoint is attributable", () => {
    expect(() => parseFiniteVenueNumber("xyz", "available_balance", "lighter"))
      .toThrow(/`available_balance`/);
    expect(() => parseFiniteVenueNumber(NaN, "position.unrealized_pnl", "hyperliquid"))
      .toThrow(/`position\.unrealized_pnl`/);
  });

  it("includes the original (stringified) value in the error message for triage", () => {
    expect(() => parseFiniteVenueNumber("garbled", "x", "aster")).toThrow(/"garbled"/);
    expect(() => parseFiniteVenueNumber({ broken: true } as unknown, "x", "aster")).toThrow(/not a finite number/);
  });

  it("tags the exchange field consistently across all 4 adapters", () => {
    const exchanges = ["lighter", "hyperliquid", "pacifica", "aster"] as const;
    for (const ex of exchanges) {
      try {
        parseFiniteVenueNumber(NaN, "x", ex);
        expect.fail(`expected throw for ${ex}`);
      } catch (e) {
        const err = e as PerpError;
        expect(
          (err.structured as { details?: { exchange?: string } }).details?.exchange,
          `${ex} tag`,
        ).toBe(ex);
      }
    }
  });
});
