import { describe, it, expect } from "vitest";
import { findDexArbPairs, type DexAsset } from "../dex-asset-map.js";

function makeAsset(overrides: Partial<DexAsset> & Pick<DexAsset, "raw" | "base" | "dex" | "markPrice" | "fundingRate">): DexAsset {
  return {
    maxLeverage: 10,
    openInterest: 1000,
    volume24h: 50000,
    szDecimals: 3,
    ...overrides,
  };
}

describe("findDexArbPairs — exact name matching", () => {
  it("finds arb pair for TSLA across xyz and cash dexes", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:TSLA", base: "TSLA", dex: "xyz", markPrice: 392.81, fundingRate: 0.00001 }),
      makeAsset({ raw: "cash:TSLA", base: "TSLA", dex: "cash", markPrice: 392.65, fundingRate: -0.00005 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].underlying).toBe("TSLA");
    expect(pairs[0].long.dex).not.toBe(pairs[0].short.dex);
    expect(pairs[0].annualSpread).toBeGreaterThan(0);
    expect(pairs[0].priceGapPct).toBeLessThan(1);
  });

  it("finds multiple pairs for NVDA across 4 dexes", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:NVDA", base: "NVDA", dex: "xyz", markPrice: 175.97, fundingRate: 0.00004 }),
      makeAsset({ raw: "flx:NVDA", base: "NVDA", dex: "flx", markPrice: 176.02, fundingRate: 0.0 }),
      makeAsset({ raw: "km:NVDA", base: "NVDA", dex: "km", markPrice: 176.01, fundingRate: -0.00006 }),
      makeAsset({ raw: "cash:NVDA", base: "NVDA", dex: "cash", markPrice: 176.19, fundingRate: -0.000001 }),
    ];

    const pairs = findDexArbPairs(assets);
    // 4 dexes → C(4,2) = 6 pairs
    expect(pairs.length).toBe(6);
    // All should be NVDA
    for (const p of pairs) {
      expect(p.underlying).toBe("NVDA");
    }
    // Sorted by spread descending
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i].annualSpread).toBeLessThanOrEqual(pairs[i - 1].annualSpread);
    }
  });

  it("includes native HL perps when includeNative=true", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "BTC", base: "BTC", dex: "hl", markPrice: 68000, fundingRate: 0.00001 }),
      makeAsset({ raw: "hyna:BTC", base: "BTC", dex: "hyna", markPrice: 68010, fundingRate: 0.00003 }),
    ];

    const withNative = findDexArbPairs(assets, { includeNative: true });
    expect(withNative).toHaveLength(1);
    expect(withNative[0].underlying).toBe("BTC");

    const withoutNative = findDexArbPairs(assets, { includeNative: false });
    expect(withoutNative).toHaveLength(0); // only 1 non-native asset
  });
});

describe("findDexArbPairs — alias matching", () => {
  it("matches CL and OIL as same underlying (CRUDE_OIL_WTI)", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:CL", base: "CL", dex: "xyz", markPrice: 93.34, fundingRate: -0.0005 }),
      makeAsset({ raw: "flx:OIL", base: "OIL", dex: "flx", markPrice: 93.38, fundingRate: 0.0 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].underlying).toBe("CRUDE_OIL_WTI");
  });

  it("matches kPEPE and 1000PEPE as same underlying", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "kPEPE", base: "kPEPE", dex: "hl", markPrice: 0.015, fundingRate: 0.0001 }),
      makeAsset({ raw: "hyna:1000PEPE", base: "1000PEPE", dex: "hyna", markPrice: 0.0151, fundingRate: 0.0003 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].underlying).toBe("1000PEPE");
  });
});

describe("findDexArbPairs — blacklist & price gap filtering", () => {
  it("rejects USAR vs US500 (blacklisted)", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:USAR", base: "USAR", dex: "xyz", markPrice: 17.63, fundingRate: 0.0003 }),
      makeAsset({ raw: "km:US500", base: "US500", dex: "km", markPrice: 666.69, fundingRate: 0.00001 }),
    ];

    // Even without blacklist, price gap (>5%) would filter this out
    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(0);
  });

  it("rejects SEMI vs SEMIS (blacklisted)", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "km:SEMI", base: "SEMI", dex: "km", markPrice: 319.38, fundingRate: 0.00008 }),
      makeAsset({ raw: "vntl:SEMIS", base: "SEMIS", dex: "vntl", markPrice: 381.21, fundingRate: 0.00001 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(0);
  });

  it("rejects pairs with >5% price gap even if same name", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "dexA:FOO", base: "FOO", dex: "dexA", markPrice: 100, fundingRate: 0.001 }),
      makeAsset({ raw: "dexB:FOO", base: "FOO", dex: "dexB", markPrice: 110, fundingRate: -0.001 }),
    ];

    // ~9.5% gap → should be filtered
    const pairs = findDexArbPairs(assets, { maxPriceGapPct: 5 });
    expect(pairs).toHaveLength(0);

    // Increase tolerance
    const pairsLoose = findDexArbPairs(assets, { maxPriceGapPct: 15 });
    expect(pairsLoose).toHaveLength(1);
  });

  it("accepts pairs with <5% price gap", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:GOLD", base: "GOLD", dex: "xyz", markPrice: 5164.60, fundingRate: -0.00001 }),
      makeAsset({ raw: "cash:GOLD", base: "GOLD", dex: "cash", markPrice: 5176.04, fundingRate: -0.00005 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].priceGapPct).toBeLessThan(1);
  });
});

describe("findDexArbPairs — spread calculation", () => {
  it("correctly determines long/short direction", () => {
    const assets: DexAsset[] = [
      // dexA: high positive funding → expensive to be long
      makeAsset({ raw: "dexA:ETH", base: "ETH", dex: "dexA", markPrice: 1974, fundingRate: 0.001 }),
      // dexB: negative funding → get paid to be long
      makeAsset({ raw: "dexB:ETH", base: "ETH", dex: "dexB", markPrice: 1975, fundingRate: -0.001 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(1);

    // Should long on dexB (lower funding) and short on dexA (higher funding)
    expect(pairs[0].long.dex).toBe("dexB");
    expect(pairs[0].short.dex).toBe("dexA");
  });

  it("all dexes use 1h funding period (including HIP-3 deployed)", () => {
    const assets: DexAsset[] = [
      // Native HL: 1h funding
      makeAsset({ raw: "BTC", base: "BTC", dex: "hl", markPrice: 68000, fundingRate: 0.001 }),
      // Deployed dex: also 1h funding (same rate = no spread)
      makeAsset({ raw: "hyna:BTC", base: "BTC", dex: "hyna", markPrice: 68010, fundingRate: 0.001 }),
    ];

    const pairs = findDexArbPairs(assets, { minAnnualSpread: 0 });
    // Same rate on both → spread ≈ 0
    if (pairs.length > 0) {
      expect(pairs[0].annualSpread).toBeLessThan(1);
    }
  });

  it("filters by minAnnualSpread", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:TSLA", base: "TSLA", dex: "xyz", markPrice: 392, fundingRate: 0.00001 }),
      makeAsset({ raw: "cash:TSLA", base: "TSLA", dex: "cash", markPrice: 393, fundingRate: 0.00002 }),
    ];

    const allPairs = findDexArbPairs(assets, { minAnnualSpread: 0 });
    expect(allPairs.length).toBeGreaterThanOrEqual(1);

    const highOnly = findDexArbPairs(assets, { minAnnualSpread: 999 });
    expect(highOnly).toHaveLength(0);
  });
});

describe("findDexArbPairs — same dex exclusion", () => {
  it("does not pair assets from the same dex", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:TSLA", base: "TSLA", dex: "xyz", markPrice: 392, fundingRate: 0.001 }),
      makeAsset({ raw: "xyz:NVDA", base: "NVDA", dex: "xyz", markPrice: 176, fundingRate: -0.001 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(0); // different assets, no match
  });

  it("does not pair same asset within same dex", () => {
    // Edge case: shouldn't happen but be safe
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:TSLA", base: "TSLA", dex: "xyz", markPrice: 392, fundingRate: 0.001 }),
      makeAsset({ raw: "xyz:TSLA", base: "TSLA", dex: "xyz", markPrice: 392, fundingRate: 0.001 }),
    ];

    const pairs = findDexArbPairs(assets);
    expect(pairs).toHaveLength(0);
  });
});

describe("findDexArbPairs — edge cases", () => {
  it("handles empty assets list", () => {
    expect(findDexArbPairs([])).toHaveLength(0);
  });

  it("handles single asset", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "BTC", base: "BTC", dex: "hl", markPrice: 68000, fundingRate: 0.001 }),
    ];
    expect(findDexArbPairs(assets)).toHaveLength(0);
  });

  it("handles all assets from one dex only", () => {
    const assets: DexAsset[] = [
      makeAsset({ raw: "xyz:TSLA", base: "TSLA", dex: "xyz", markPrice: 392, fundingRate: 0.001 }),
      makeAsset({ raw: "xyz:NVDA", base: "NVDA", dex: "xyz", markPrice: 176, fundingRate: -0.001 }),
      makeAsset({ raw: "xyz:GOLD", base: "GOLD", dex: "xyz", markPrice: 5164, fundingRate: 0.0 }),
    ];

    expect(findDexArbPairs(assets)).toHaveLength(0);
  });
});
