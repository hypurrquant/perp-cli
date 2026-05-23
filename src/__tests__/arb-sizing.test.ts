import { describe, it, expect } from "vitest";
import { computeMatchedSize, computeSpotPerpMatchedSize } from "../arb-sizing.js";

describe("computeMatchedSize", () => {
  it("should compute size respecting least precise exchange", () => {
    // HL (2 decimal fallback) + Lighter (2 decimals) -> use 2 decimals
    const result = computeMatchedSize(100, 50, "hyperliquid", "lighter");
    expect(result).not.toBeNull();
    expect(result!.size).toBe("2.00"); // 100/50 = 2.0
    expect(result!.notional).toBe(100);
  });

  it("should round down to avoid exceeding requested size", () => {
    const result = computeMatchedSize(100, 33, "hyperliquid", "lighter");
    expect(result).not.toBeNull();
    // 100/33 = 3.0303... -> floor to 3.03 (2 decimals)
    expect(result!.size).toBe("3.03");
    expect(result!.notional).toBeLessThanOrEqual(100);
  });

  it("should return null when price is 0", () => {
    expect(computeMatchedSize(100, 0, "hyperliquid", "lighter")).toBeNull();
  });

  it("should return null when size is too small for min notional", () => {
    // $5 / $100000 = 0.00005 -> rounds to 0.00 for HL (2 decimal fallback)
    expect(computeMatchedSize(5, 100000, "hyperliquid", "lighter")).toBeNull();
  });

  it("should use more precision for pacifica", () => {
    // Pacifica (4 decimals) + Lighter (2 decimals) -> use 2 decimals
    const result = computeMatchedSize(100, 3500, "pacifica", "lighter");
    expect(result).not.toBeNull();
    // 100/3500 = 0.02857... -> floor to 0.02
    expect(result!.size).toBe("0.02");
  });

  it("should handle same exchange pair", () => {
    const result = computeMatchedSize(1000, 100, "hyperliquid", "hyperliquid");
    expect(result).not.toBeNull();
    expect(result!.size).toBe("10.00");
  });

  it("should try rounding up if floor is below min notional", () => {
    // $12 / $3500 = 0.00342... -> floor to 0.00 (2 decimals) -> try round up to 0.01
    // 0.01 * 3500 = 35 which is > 12*1.2=14.4, so should return null
    expect(computeMatchedSize(12, 3500, "hyperliquid", "lighter")).toBeNull();
  });

  it("should meet min notional of both exchanges", () => {
    // Both HL and LT need $10 min
    const result = computeMatchedSize(15, 150, "hyperliquid", "lighter");
    expect(result).not.toBeNull();
    expect(result!.notional).toBeGreaterThanOrEqual(10);
  });

  it("should use explicit szDecimals when provided", () => {
    // BTC: HL szDec=5, LT szDec=6 → use min(5,6)=5
    const result = computeMatchedSize(100, 100000, "hyperliquid", "lighter", {
      longSizeDecimals: 5,
      shortSizeDecimals: 6,
    });
    expect(result).not.toBeNull();
    expect(result!.size).toBe("0.00100"); // 5 decimals
  });
});

describe("computeMatchedSize — lotSize option (integer-quantum coins)", () => {
  it("floors to nearest lotSize multiple when lotSize is an integer >= 1 (BTC-style quantum)", () => {
    // rawSize = 1000/100 = 10 → floor(10/3)*3 = 9 → notional 900 ≥ min 10
    // formatSize: lotSize >= 1 → String(Math.round(9)) = "9"
    const result = computeMatchedSize(1000, 100, "hyperliquid", "lighter", { lotSize: 3 });
    expect(result).not.toBeNull();
    expect(result!.size).toBe("9");
    expect(result!.notional).toBe(900);
  });

  it("floors to nearest lotSize multiple when lotSize < 1 and formats with szDecimals", () => {
    // rawSize = 100/1000 = 0.1, lotSize=0.001 → floor(0.1/0.001)*0.001 = 0.1
    // formatSize: lotSize < 1 → 0.1.toFixed(2) = "0.10" (szDecimals=min(2,2)=2)
    const result = computeMatchedSize(100, 1000, "hyperliquid", "lighter", { lotSize: 0.001 });
    expect(result).not.toBeNull();
    expect(result!.size).toBe("0.10");
    expect(result!.notional).toBeCloseTo(100, 4);
  });

  it("returns null when lotSize forces rawSize to floor to 0", () => {
    // rawSize = 5/100 = 0.05, lotSize=1 → floor(0.05)*1 = 0 → null (before round-up branch)
    expect(computeMatchedSize(5, 100, "hyperliquid", "lighter", { lotSize: 1 })).toBeNull();
  });

  it("falls back to ceil-by-lotSize when floor result is below minNotional and ceil is within 20% bound", () => {
    // rawSize = 10/3 ≈ 3.333, lotSize=1
    // floor: floor(3.333)*1 = 3, notional = 9 < min 10 → enter round-up branch
    // ceil:  ceil(3.333)*1  = 4, notionalUp = 12, sizeUsd*1.2 = 12 → 12 ≤ 12 → success
    // formatSize: lotSize >= 1 → String(Math.round(4)) = "4"
    const result = computeMatchedSize(10, 3, "hyperliquid", "lighter", { lotSize: 1 });
    expect(result).not.toBeNull();
    expect(result!.size).toBe("4");
    expect(result!.notional).toBe(12);
  });
});

describe("computeMatchedSize — round-up fallback (no lotSize)", () => {
  it("rounds UP when floor lands below minNotional and the resulting notional is within 20% of sizeUsd", () => {
    // aster szDecimals=0 → rawSize=8/3≈2.667 → floor=2 → notional=6 < min 10 → round-up
    // ceil=3 → notionalUp=9 → sizeUsd*1.2=9.6 → 9 ≤ 9.6 → success
    // NOTE: notionalUp (9) is still below minNotional (10); current logic does NOT
    // re-check min on the round-up path — this guard pins that behavior.
    const result = computeMatchedSize(8, 3, "aster", "aster");
    expect(result).not.toBeNull();
    expect(result!.size).toBe("3");
    expect(result!.notional).toBe(9);
  });

  it("returns null when the round-up notional exceeds the 20% bound (oversize protection)", () => {
    // aster szDecimals=0 → rawSize=13/8=1.625 → floor=1 → notional=8 < min 10 → round-up
    // ceil=2 → notionalUp=16 → sizeUsd*1.2=15.6 → 16 > 15.6 → null
    expect(computeMatchedSize(13, 8, "aster", "aster")).toBeNull();
  });
});

describe("computeMatchedSize — pacifica has $1 minNotional (vs $10 for HL / LT / aster)", () => {
  it("permits a $5 notional on a pacifica-only pair (pacifica min is $1)", () => {
    // rawSize=5/100=0.05, szDecimals=min(4,4)=4 → floor=0.0500 → notional=5
    // minNotional = max(pacifica $1, pacifica $1) = $1 → 5 ≥ 1 → OK
    const result = computeMatchedSize(5, 100, "pacifica", "pacifica");
    expect(result).not.toBeNull();
    expect(result!.notional).toBeCloseTo(5, 4);
    expect(Number(result!.size)).toBeCloseTo(0.05, 4);
  });

  it("returns null on the same $0.5 notional when pacifica is paired with lighter ($10 min wins)", () => {
    // szDecimals=min(pac=4, lt=2)=2; rawSize=0.5/100=0.005 → floor(0.5)/100 = 0 → null
    expect(computeMatchedSize(0.5, 100, "pacifica", "lighter")).toBeNull();
  });
});

describe("computeSpotPerpMatchedSize", () => {
  it("returns null when price is 0", () => {
    expect(computeSpotPerpMatchedSize(100, 0, "hyperliquid", "hyperliquid")).toBeNull();
  });

  it("matches sizes using the min of spot + perp decimals (defaults)", () => {
    // spot:hyperliquid default=2, hyperliquid default=2 → min=2
    // rawSize = 100/50 = 2.0 → "2.00", notional 100, min = max(spot:hl $10, hl $10) = $10
    const result = computeSpotPerpMatchedSize(100, 50, "hyperliquid", "hyperliquid");
    expect(result).not.toBeNull();
    expect(result!.size).toBe("2.00");
    expect(result!.notional).toBe(100);
  });

  it("honors explicit decimals when provided (overrides exchange defaults)", () => {
    // spotDec=5, perpDec=6 → szDecimals=5
    // rawSize = 100/100000 = 0.001 → factor=100000 → floor(100)/100000 = 0.001
    const result = computeSpotPerpMatchedSize(100, 100000, "hyperliquid", "hyperliquid", 5, 6);
    expect(result).not.toBeNull();
    expect(result!.size).toBe("0.00100");
    expect(result!.notional).toBe(100);
  });

  it("rounds UP when floor lands below minNotional and round-up is within 20% bound", () => {
    // explicit szDec=0 → rawSize=8/3≈2.667 → floor=2 → notional=6 < min 10 → round-up
    // ceil=3 → notionalUp=9 ≤ sizeUsd*1.2=9.6 → success → "3" (toFixed(0))
    const result = computeSpotPerpMatchedSize(8, 3, "hyperliquid", "hyperliquid", 0, 0);
    expect(result).not.toBeNull();
    expect(result!.size).toBe("3");
    expect(result!.notional).toBe(9);
  });

  it("returns null when round-up exceeds the 20% bound", () => {
    // explicit szDec=0 → rawSize=13/8=1.625 → floor=1 → notional=8 < 10 → round-up
    // ceil=2 → notionalUp=16 > sizeUsd*1.2=15.6 → null
    expect(computeSpotPerpMatchedSize(13, 8, "hyperliquid", "hyperliquid", 0, 0)).toBeNull();
  });

  it("returns null when rawSize floors to 0 (dust input)", () => {
    // sizeUsd=0.005, price=100, szDec=2 → rawSize=0.00005 → floor(0.005)/100 = 0 → null
    expect(computeSpotPerpMatchedSize(0.005, 100, "hyperliquid", "hyperliquid", 2, 2)).toBeNull();
  });
});
