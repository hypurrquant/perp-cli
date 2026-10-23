import { describe, it, expect } from "vitest";
import { canonicalQuerySymbol } from "../exchanges/canonical-symbols.js";

describe("canonicalQuerySymbol (user-typed symbol → cross-venue canonical key)", () => {
  it.each([
    ["kPEPE", "1000PEPE"], ["1000pepe", "1000PEPE"], ["kSHIB", "1000SHIB"], ["UBTC", "BTC"],
    ["BTC-PERP", "BTC"], ["eth", "ETH"],
    // explicit-table venue tickers whose venues all agree
    ["XAU", "GOLD"], ["CL", "CRUDE_OIL_WTI"], ["BZ", "CRUDE_OIL_BRENT"], ["US500", "SPX"],
    // already canonical / unmapped
    ["GOLD", "GOLD"], ["SPX", "SPX"], ["NOPE", "NOPE"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalQuerySymbol(input)).toBe(expected);
  });
});
