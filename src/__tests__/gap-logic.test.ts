import { describe, it, expect } from "vitest";

/**
 * Tests for cross-exchange price gap calculations (extracted from gap.ts).
 */

interface PriceGap {
  symbol: string;
  pacPrice: number;
  hlPrice: number;
  gapPct: number;
  direction: "PAC>HL" | "HL>PAC";
}

function computeGap(symbol: string, pacPrice: number, hlPrice: number): PriceGap | null {
  if (pacPrice <= 0 || hlPrice <= 0) return null;
  const mid = (pacPrice + hlPrice) / 2;
  const gapPct = ((pacPrice - hlPrice) / mid) * 100;
  return {
    symbol,
    pacPrice,
    hlPrice,
    gapPct,
    direction: pacPrice > hlPrice ? "PAC>HL" : "HL>PAC",
  };
}

describe("Price gap computation", () => {
  it("positive gap when PAC > HL", () => {
    const gap = computeGap("BTC", 100100, 99900);
    expect(gap).not.toBeNull();
    expect(gap!.gapPct).toBeCloseTo(0.2, 1);
    expect(gap!.direction).toBe("PAC>HL");
  });

  it("negative gap when HL > PAC", () => {
    const gap = computeGap("ETH", 3490, 3510);
    expect(gap).not.toBeNull();
    expect(gap!.gapPct).toBeLessThan(0);
    expect(gap!.direction).toBe("HL>PAC");
  });

  it("zero gap when equal", () => {
    const gap = computeGap("SOL", 150, 150);
    expect(gap).not.toBeNull();
    expect(gap!.gapPct).toBe(0);
  });

  it("returns null for zero prices", () => {
    expect(computeGap("X", 0, 100)).toBeNull();
    expect(computeGap("X", 100, 0)).toBeNull();
  });

  it("handles large gaps", () => {
    const gap = computeGap("MEME", 1.0, 0.5);
    expect(gap).not.toBeNull();
    // (1.0 - 0.5) / 0.75 * 100 ≈ 66.67%
    expect(gap!.gapPct).toBeCloseTo(66.67, 1);
  });
});
