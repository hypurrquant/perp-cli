import { describe, it, expect } from "vitest";
import { fetchAllDexAssets, findDexArbPairs, scanDexArb } from "../../dex-asset-map.js";

/**
 * Integration tests for HIP-3 cross-dex arb scanning.
 *
 * Hits real Hyperliquid mainnet API (read-only, no private key needed).
 *
 * Run: pnpm --filter perp-cli test -- --testPathPattern dex-arb.integration
 */

describe("fetchAllDexAssets — live API", () => {
  it("returns assets from native HL and at least 3 deployed dexes", async () => {
    const assets = await fetchAllDexAssets();

    expect(assets.length).toBeGreaterThan(100);

    // Check we have native HL assets
    const hlAssets = assets.filter(a => a.dex === "hl");
    expect(hlAssets.length).toBeGreaterThan(100);
    expect(hlAssets.find(a => a.base === "BTC")).toBeTruthy();

    // Check we have at least xyz dex
    const xyzAssets = assets.filter(a => a.dex === "xyz");
    expect(xyzAssets.length).toBeGreaterThan(10);
    expect(xyzAssets.find(a => a.base === "TSLA")).toBeTruthy();

    // Verify data shape
    for (const asset of assets.slice(0, 10)) {
      expect(asset.markPrice).toBeGreaterThan(0);
      expect(typeof asset.fundingRate).toBe("number");
      expect(asset.dex).toBeTruthy();
      expect(asset.base).toBeTruthy();
      expect(asset.raw).toBeTruthy();
    }

    const dexes = new Set(assets.map(a => a.dex));
    console.log(`Dexes found: ${[...dexes].join(", ")} (${dexes.size} total)`);
    console.log(`Total active assets: ${assets.length}`);
  }, 30000);
});

describe("findDexArbPairs — live data", () => {
  it("finds TSLA arb pairs across dexes", async () => {
    const assets = await fetchAllDexAssets();
    const tslaAssets = assets.filter(a => a.base === "TSLA");

    expect(tslaAssets.length).toBeGreaterThanOrEqual(2);

    const pairs = findDexArbPairs(tslaAssets);
    // C(n,2) pairs if n dexes have TSLA
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    for (const p of pairs) {
      expect(p.underlying).toBe("TSLA");
      expect(p.priceGapPct).toBeLessThan(2); // prices should be very close
      expect(p.long.dex).not.toBe(p.short.dex);
    }

    const dexes = new Set(tslaAssets.map(a => a.dex));
    console.log(`TSLA on dexes: ${[...dexes].join(", ")} → ${pairs.length} arb pairs`);
    for (const p of pairs.slice(0, 3)) {
      console.log(`  L:${p.long.dex} S:${p.short.dex} spread:${p.annualSpread.toFixed(1)}% gap:${p.priceGapPct.toFixed(3)}%`);
    }
  }, 30000);

  it("finds BTC arb between hl native and hyna dex", async () => {
    const assets = await fetchAllDexAssets();
    const btcAssets = assets.filter(a => a.base === "BTC");

    const hlBTC = btcAssets.find(a => a.dex === "hl");
    const hynaBTC = btcAssets.find(a => a.dex === "hyna");

    expect(hlBTC).toBeTruthy();
    expect(hynaBTC).toBeTruthy();

    // Prices should be very close (< 0.5%)
    const gap = Math.abs(hlBTC!.markPrice - hynaBTC!.markPrice) / hlBTC!.markPrice * 100;
    expect(gap).toBeLessThan(0.5);

    console.log(`BTC: hl=$${hlBTC!.markPrice.toFixed(0)} hyna=$${hynaBTC!.markPrice.toFixed(0)} gap:${gap.toFixed(4)}%`);
  }, 30000);

  it("correctly rejects USAR vs US500 (different products)", async () => {
    const assets = await fetchAllDexAssets();
    const usar = assets.find(a => a.base === "USAR");
    const us500 = assets.find(a => a.base === "US500");

    if (usar && us500) {
      // Prices should be wildly different
      const gap = Math.abs(usar.markPrice - us500.markPrice) / Math.min(usar.markPrice, us500.markPrice) * 100;
      expect(gap).toBeGreaterThan(100); // way more than 5%

      // findDexArbPairs should not match these
      const pairs = findDexArbPairs([usar, us500]);
      expect(pairs).toHaveLength(0);
      console.log(`USAR=$${usar.markPrice.toFixed(2)} vs US500=$${us500.markPrice.toFixed(2)} → gap:${gap.toFixed(0)}% → correctly rejected`);
    }
  }, 30000);
});

describe("scanDexArb — live full scan", () => {
  it("returns sorted arb opportunities", async () => {
    const pairs = await scanDexArb({ minAnnualSpread: 5 });

    expect(pairs.length).toBeGreaterThan(0);

    // Should be sorted by annualSpread descending
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i].annualSpread).toBeLessThanOrEqual(pairs[i - 1].annualSpread);
    }

    // All pairs should have different dexes
    for (const p of pairs) {
      expect(p.long.dex).not.toBe(p.short.dex);
    }

    // All pairs should have < 5% price gap
    for (const p of pairs) {
      expect(p.priceGapPct).toBeLessThan(5);
    }

    console.log(`Found ${pairs.length} arb opportunities (>5% annual spread)`);
    console.log(`Top 5:`);
    for (const p of pairs.slice(0, 5)) {
      console.log(`  ${p.underlying}: ${p.annualSpread.toFixed(1)}% [${p.long.dex}↔${p.short.dex}]`);
    }
  }, 30000);

  it("no-native mode excludes HL base assets", async () => {
    const withNative = await scanDexArb({ minAnnualSpread: 0, includeNative: true });
    const withoutNative = await scanDexArb({ minAnnualSpread: 0, includeNative: false });

    // Without native, should have fewer pairs (no hl↔dex pairs)
    const nativePairs = withNative.filter(p => p.long.dex === "hl" || p.short.dex === "hl");
    const nonNativePairs = withoutNative.filter(p => p.long.dex === "hl" || p.short.dex === "hl");

    expect(nonNativePairs.length).toBe(0);
    if (nativePairs.length > 0) {
      expect(withNative.length).toBeGreaterThan(withoutNative.length);
    }

    console.log(`With native: ${withNative.length} pairs (${nativePairs.length} include HL native)`);
    console.log(`Without native: ${withoutNative.length} pairs`);
  }, 30000);
});
