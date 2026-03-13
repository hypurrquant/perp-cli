import { describe, it, expect } from "vitest";
import { computeMatchedSize } from "../arb-sizing.js";

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
