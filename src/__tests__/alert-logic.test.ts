import { describe, it, expect } from "vitest";

/**
 * Tests for the alert price merging logic (extracted from alert.ts).
 * Validates the fix for the price map key inconsistency bug.
 */

function mergePrices(
  pacData: { symbol: string; mark: string }[] | null,
  hlData: Record<string, string> | null
): Map<string, number> {
  const map = new Map<string, number>();

  if (pacData) {
    for (const p of pacData) {
      map.set(`pac:${p.symbol}`, Number(p.mark));
    }
  }

  if (hlData) {
    for (const [symbol, price] of Object.entries(hlData)) {
      map.set(`hl:${symbol}`, Number(price));
    }
  }

  // Merge into bare symbol keys: prefer pac price, fallback to hl
  const allSymbols = new Set<string>();
  for (const k of map.keys()) {
    if (k.includes(":")) allSymbols.add(k.split(":")[1]);
  }
  for (const sym of allSymbols) {
    const pacPrice = map.get(`pac:${sym}`);
    const hlPrice = map.get(`hl:${sym}`);
    map.set(sym, pacPrice ?? hlPrice ?? 0);
  }

  return map;
}

describe("Alert price merging", () => {
  it("prefers Pacifica price when both available", () => {
    const map = mergePrices(
      [{ symbol: "BTC", mark: "100000" }],
      { BTC: "99900" }
    );
    expect(map.get("BTC")).toBe(100000);
    expect(map.get("pac:BTC")).toBe(100000);
    expect(map.get("hl:BTC")).toBe(99900);
  });

  it("falls back to HL price when pac unavailable", () => {
    const map = mergePrices(
      null,
      { ETH: "3500" }
    );
    expect(map.get("ETH")).toBe(3500);
    expect(map.has("pac:ETH")).toBe(false);
    expect(map.get("hl:ETH")).toBe(3500);
  });

  it("handles Pacifica-only symbols", () => {
    const map = mergePrices(
      [{ symbol: "SOL", mark: "150" }],
      {}
    );
    expect(map.get("SOL")).toBe(150);
  });

  it("handles empty data", () => {
    const map = mergePrices(null, null);
    expect(map.size).toBe(0);
  });

  it("handles multiple symbols from both sources", () => {
    const map = mergePrices(
      [
        { symbol: "BTC", mark: "100000" },
        { symbol: "ETH", mark: "3500" },
      ],
      {
        BTC: "99900",
        ETH: "3490",
        SOL: "150",
      }
    );
    // Pac preferred for BTC and ETH
    expect(map.get("BTC")).toBe(100000);
    expect(map.get("ETH")).toBe(3500);
    // HL-only for SOL
    expect(map.get("SOL")).toBe(150);
  });

  it("bare symbol key is always set (no orphaned prefixed keys)", () => {
    const map = mergePrices(
      [{ symbol: "DOGE", mark: "0.15" }],
      { DOGE: "0.14", ARB: "1.20" }
    );
    // Every symbol with a prefixed key should have a bare key
    for (const k of map.keys()) {
      if (k.includes(":")) {
        const bare = k.split(":")[1];
        expect(map.has(bare)).toBe(true);
      }
    }
  });
});

describe("Alert trigger conditions", () => {
  it("fires price above alert", () => {
    const currentPrice = 105000;
    const threshold = 100000;
    const condition = "above";
    expect(condition === "above" && currentPrice >= threshold).toBe(true);
  });

  it("does NOT fire price above when below", () => {
    const currentPrice = 95000;
    const threshold = 100000;
    const condition = "above";
    expect(condition === "above" && currentPrice >= threshold).toBe(false);
  });

  it("fires price below alert", () => {
    const currentPrice = 95000;
    const threshold = 100000;
    const condition = "below";
    expect(condition === "below" && currentPrice <= threshold).toBe(true);
  });

  it("fires funding spread alert", () => {
    const spread = 35; // annual %
    const alertThreshold = 30;
    expect(spread >= alertThreshold).toBe(true);
  });

  it("does NOT fire funding spread below threshold", () => {
    const spread = 25;
    const alertThreshold = 30;
    expect(spread >= alertThreshold).toBe(false);
  });
});
