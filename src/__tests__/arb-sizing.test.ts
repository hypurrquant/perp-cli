import { describe, it, expect } from "vitest";
import { computeMatchedSize } from "../arb-sizing.js";

describe("computeMatchedSize", () => {
  it("should compute size respecting least precise exchange", () => {
    // HL (1 decimal) + Lighter (2 decimals) -> use 1 decimal
    const result = computeMatchedSize(100, 50, "hyperliquid", "lighter");
    expect(result).not.toBeNull();
    expect(result!.size).toBe("2.0"); // 100/50 = 2.0
    expect(result!.notional).toBe(100);
  });

  it("should round down to avoid exceeding requested size", () => {
    const result = computeMatchedSize(100, 33, "hyperliquid", "lighter");
    expect(result).not.toBeNull();
    // 100/33 = 3.0303... -> floor to 3.0 (HL=1 decimal)
    expect(result!.size).toBe("3.0");
    expect(result!.notional).toBeLessThanOrEqual(100);
  });

  it("should return null when price is 0", () => {
    expect(computeMatchedSize(100, 0, "hyperliquid", "lighter")).toBeNull();
  });

  it("should return null when size is too small for min notional", () => {
    // $5 / $100000 = 0.00005 -> rounds to 0.0 for HL (1 decimal)
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
    expect(result!.size).toBe("10.0");
  });

  it("should try rounding up if floor is below min notional", () => {
    // $12 / $3500 = 0.00342... -> floor to 0.0 (HL 1 decimal) -> try round up to 0.1
    // 0.1 * 3500 = 350 which is way more than 12*1.2=14.4, so should return null
    expect(computeMatchedSize(12, 3500, "hyperliquid", "lighter")).toBeNull();
  });

  it("should meet min notional of both exchanges", () => {
    // Both HL and LT need $10 min
    const result = computeMatchedSize(15, 150, "hyperliquid", "lighter");
    expect(result).not.toBeNull();
    expect(result!.notional).toBeGreaterThanOrEqual(10);
  });
});
