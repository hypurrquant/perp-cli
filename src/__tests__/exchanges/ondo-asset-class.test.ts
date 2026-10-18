/**
 * Ondo Perps asset classes come from the venue's market `tags`; an unknown tag fails visibly
 * (never guessed). "Pre-IPO" appeared live on 2026-10-19 (OPENAI-USD.P) and broke every
 * Ondo market read until mapped.
 */
import { describe, it, expect } from "vitest";
import { ondoAssetClass } from "../../exchanges/ondo/public.js";

describe("ondoAssetClass", () => {
  it("maps every known venue tag", () => {
    expect(ondoAssetClass("BTC-USD.P", ["Crypto"])).toBe("crypto");
    expect(ondoAssetClass("TSLA-USD.P", ["Stock"])).toBe("equity");
    expect(ondoAssetClass("SPY-USD.P", ["ETF"])).toBe("etf");
    expect(ondoAssetClass("OPENAI-USD.P", ["Pre-IPO"])).toBe("preIpo");
  });

  it("refuses an unknown or ambiguous tag set instead of guessing", () => {
    expect(() => ondoAssetClass("X-USD.P", ["Mystery"])).toThrow(/cannot classify/);
    expect(() => ondoAssetClass("X-USD.P", ["Stock", "ETF"])).toThrow(/cannot classify/);
    expect(() => ondoAssetClass("X-USD.P", undefined)).toThrow(/no tags/);
  });
});
