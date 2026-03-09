import { describe, it, expect } from "vitest";

/**
 * Integration tests for HIP-3 deployed perp dex support.
 *
 * These tests hit the real Hyperliquid mainnet API (read-only)
 * to verify our parsing of allPerpMetas and dex-specific queries.
 *
 * No private key needed — all calls are public info endpoints.
 *
 * Run: pnpm --filter perp-cli test -- --testPathPattern hip3-dex.integration
 */

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

async function infoPost(body: Record<string, unknown>) {
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

describe("HIP-3 Integration — allPerpMetas", () => {
  it("returns an array with native perps as first entry", async () => {
    const data = await infoPost({ type: "allPerpMetas" });

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    // First entry: native perps (BTC, ETH, etc.)
    const native = data[0];
    expect(native).toHaveProperty("universe");
    expect(Array.isArray(native.universe)).toBe(true);
    expect(native.universe.length).toBeGreaterThan(100); // 200+ native perps

    const btc = native.universe.find((a: { name: string }) => a.name === "BTC");
    expect(btc).toBeTruthy();
    expect(btc.maxLeverage).toBeGreaterThanOrEqual(40);
  }, 15000);

  it("has deployed dexes after index 0", async () => {
    const data = await infoPost({ type: "allPerpMetas" });

    expect(data.length).toBeGreaterThan(1); // at least 1 deployed dex

    // Each deployed dex entry has universe with prefixed assets
    for (let i = 1; i < data.length; i++) {
      const entry = data[i];
      expect(entry).toHaveProperty("universe");
      expect(entry).toHaveProperty("collateralToken");

      if (entry.universe.length === 0) continue; // skip empty

      // Assets should have a prefix with colon
      const firstName = entry.universe[0].name;
      expect(firstName).toContain(":");
    }
  }, 15000);

  it("extracts known dex names (xyz, vntl, etc.)", async () => {
    const data = await infoPost({ type: "allPerpMetas" });

    const dexNames: string[] = [];
    for (let i = 1; i < data.length; i++) {
      const universe = data[i]?.universe ?? [];
      if (universe.length === 0) continue;
      const first = universe[0].name;
      const colon = first.indexOf(":");
      if (colon > 0) dexNames.push(first.slice(0, colon));
    }

    expect(dexNames.length).toBeGreaterThan(0);
    // xyz is one of the most established deployed dexes
    expect(dexNames).toContain("xyz");
    console.log("Discovered deployed dexes:", dexNames.join(", "));
  }, 15000);
});

describe("HIP-3 Integration — dex-specific metaAndAssetCtxs", () => {
  it("fetches xyz dex markets with mark prices", async () => {
    const data = await infoPost({ type: "metaAndAssetCtxs", dex: "xyz" });

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2); // [meta, ctxs]

    const universe = data[0]?.universe ?? [];
    const ctxs = data[1] ?? [];

    expect(universe.length).toBeGreaterThan(0);
    expect(ctxs.length).toBe(universe.length);

    // All assets should have xyz: prefix
    for (const asset of universe) {
      expect(asset.name.startsWith("xyz:")).toBe(true);
    }

    // Check TSLA exists and has valid price
    const tslaIdx = universe.findIndex((a: { name: string }) => a.name === "xyz:TSLA");
    expect(tslaIdx).toBeGreaterThanOrEqual(0);

    const tslaCtx = ctxs[tslaIdx];
    expect(Number(tslaCtx.markPx)).toBeGreaterThan(0);
    expect(tslaCtx).toHaveProperty("funding");
    expect(tslaCtx).toHaveProperty("openInterest");

    console.log(`xyz:TSLA — mark: $${tslaCtx.markPx}, funding: ${tslaCtx.funding}, OI: ${tslaCtx.openInterest}`);
  }, 15000);

  it("fetches dex-specific meta (used for asset map)", async () => {
    const data = await infoPost({ type: "meta", dex: "xyz" });

    expect(data).toHaveProperty("universe");
    expect(data.universe.length).toBeGreaterThan(0);
    expect(data.universe[0].name).toContain("xyz:");

    // Verify assets can be mapped to indices
    const assetMap = new Map<string, number>();
    data.universe.forEach((a: { name: string }, i: number) => {
      assetMap.set(a.name, i);
    });

    expect(assetMap.has("xyz:TSLA")).toBe(true);
    expect(assetMap.has("xyz:NVDA")).toBe(true);
    console.log(`xyz dex has ${assetMap.size} assets`);
  }, 15000);
});

describe("HIP-3 Integration — dex-specific clearinghouseState", () => {
  it("returns valid structure for a random address", async () => {
    // Use a zero address — no positions, but structure should be valid
    const address = "0x0000000000000000000000000000000000000001";
    const data = await infoPost({
      type: "clearinghouseState",
      user: address,
      dex: "xyz",
    });

    // Should return clearinghouse state structure
    expect(data).toBeTruthy();
    expect(data).toHaveProperty("assetPositions");
    expect(Array.isArray(data.assetPositions)).toBe(true);

    // Zero address should have no positions
    expect(data.assetPositions.length).toBe(0);

    // Should have margin info
    const hasMoney = data.marginSummary || data.crossMarginSummary;
    expect(hasMoney).toBeTruthy();
  }, 15000);
});

describe("HIP-3 Integration — native vs dex asset separation", () => {
  it("native perps do not have prefixed names", async () => {
    const data = await infoPost({ type: "metaAndAssetCtxs" });
    const universe = data[0]?.universe ?? [];

    // Native assets should NOT have colon prefix
    const btc = universe.find((a: { name: string }) => a.name === "BTC");
    expect(btc).toBeTruthy();
    expect(btc.name).not.toContain(":");

    // None of the native assets should be prefixed
    const prefixed = universe.filter((a: { name: string }) => a.name.includes(":"));
    expect(prefixed.length).toBe(0);
  }, 15000);

  it("dex perps all have matching prefix", async () => {
    const data = await infoPost({ type: "metaAndAssetCtxs", dex: "xyz" });
    const universe = data[0]?.universe ?? [];

    // ALL xyz dex assets should have "xyz:" prefix
    for (const asset of universe) {
      expect(asset.name.startsWith("xyz:")).toBe(true);
    }
  }, 15000);
});
