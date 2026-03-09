import { describe, it, expect } from "vitest";
import {
  getFundingHours,
  toHourlyRate,
  annualizeRate,
  computeAnnualSpread,
  estimateHourlyFunding,
} from "../funding.js";

// ──────────────────────────────────────────────
// getFundingHours
// ──────────────────────────────────────────────

describe("getFundingHours", () => {
  it("returns 1 for hyperliquid", () => {
    expect(getFundingHours("hyperliquid")).toBe(1);
  });

  it("returns 8 for pacifica", () => {
    expect(getFundingHours("pacifica")).toBe(8);
  });

  it("returns 8 for lighter", () => {
    expect(getFundingHours("lighter")).toBe(8);
  });

  it("defaults to 8 for unknown exchanges", () => {
    expect(getFundingHours("binance")).toBe(8);
    expect(getFundingHours("unknown_dex")).toBe(8);
  });

  it("is case-insensitive", () => {
    expect(getFundingHours("Hyperliquid")).toBe(1);
    expect(getFundingHours("PACIFICA")).toBe(8);
    expect(getFundingHours("Lighter")).toBe(8);
  });
});

// ──────────────────────────────────────────────
// toHourlyRate
// ──────────────────────────────────────────────

describe("toHourlyRate", () => {
  it("divides by 1 for hyperliquid (rate is already per-hour)", () => {
    const hourly = toHourlyRate(0.0001, "hyperliquid");
    expect(hourly).toBeCloseTo(0.0001);
  });

  it("divides by 8 for pacifica", () => {
    const hourly = toHourlyRate(0.0008, "pacifica");
    expect(hourly).toBeCloseTo(0.0001);
  });

  it("divides by 8 for lighter", () => {
    const hourly = toHourlyRate(0.0016, "lighter");
    expect(hourly).toBeCloseTo(0.0002);
  });

  it("divides by 8 for unknown exchanges (default)", () => {
    const hourly = toHourlyRate(0.0008, "someExchange");
    expect(hourly).toBeCloseTo(0.0001);
  });

  it("handles zero rate", () => {
    expect(toHourlyRate(0, "hyperliquid")).toBe(0);
    expect(toHourlyRate(0, "pacifica")).toBe(0);
  });

  it("handles negative rate", () => {
    const hourly = toHourlyRate(-0.0008, "pacifica");
    expect(hourly).toBeCloseTo(-0.0001);
  });
});

// ──────────────────────────────────────────────
// annualizeRate
// ──────────────────────────────────────────────

describe("annualizeRate", () => {
  it("annualizes hyperliquid rate (hourly * 8760 * 100)", () => {
    // rate = 0.0001 per hour → annualized = 0.0001 * 8760 * 100 = 87.6%
    const annual = annualizeRate(0.0001, "hyperliquid");
    expect(annual).toBeCloseTo(87.6);
  });

  it("annualizes pacifica rate (divide by 8, then * 8760 * 100)", () => {
    // rate = 0.0008 per 8h → hourly = 0.0001 → annualized = 87.6%
    const annual = annualizeRate(0.0008, "pacifica");
    expect(annual).toBeCloseTo(87.6);
  });

  it("produces same annualized rate for equivalent rates across exchanges", () => {
    // 0.0001/h (HL) should equal 0.0008/8h (pacifica)
    const hlAnnual = annualizeRate(0.0001, "hyperliquid");
    const pacAnnual = annualizeRate(0.0008, "pacifica");
    expect(hlAnnual).toBeCloseTo(pacAnnual);
  });

  it("handles zero rate", () => {
    expect(annualizeRate(0, "hyperliquid")).toBe(0);
    expect(annualizeRate(0, "pacifica")).toBe(0);
  });

  it("handles negative rates", () => {
    const annual = annualizeRate(-0.0001, "hyperliquid");
    expect(annual).toBeCloseTo(-87.6);
  });
});

// ──────────────────────────────────────────────
// computeAnnualSpread
// ──────────────────────────────────────────────

describe("computeAnnualSpread", () => {
  it("computes spread between two different exchanges", () => {
    // HL rate 0.0002/h, pacifica rate 0.0008/8h=0.0001/h → spread = 0.0001/h * 8760 * 100 = 87.6%
    const spread = computeAnnualSpread(0.0002, "hyperliquid", 0.0008, "pacifica");
    expect(spread).toBeCloseTo(87.6);
  });

  it("returns 0 when rates are identical (after normalization)", () => {
    // HL 0.0001/h and pacifica 0.0008/8h = same hourly rate
    const spread = computeAnnualSpread(0.0001, "hyperliquid", 0.0008, "pacifica");
    expect(spread).toBeCloseTo(0);
  });

  it("returns absolute value regardless of which rate is higher", () => {
    const spread1 = computeAnnualSpread(0.0003, "hyperliquid", 0.0001, "hyperliquid");
    const spread2 = computeAnnualSpread(0.0001, "hyperliquid", 0.0003, "hyperliquid");
    expect(spread1).toBeCloseTo(spread2);
    expect(spread1).toBeGreaterThan(0);
  });

  it("computes spread with same exchange type (both 8h)", () => {
    // pacifica 0.001/8h and lighter 0.0005/8h
    // hourly: 0.000125 and 0.0000625
    // diff: 0.0000625/h * 8760 * 100 = 54.75%
    const spread = computeAnnualSpread(0.001, "pacifica", 0.0005, "lighter");
    expect(spread).toBeCloseTo(54.75);
  });

  it("handles zero rates", () => {
    const spread = computeAnnualSpread(0, "hyperliquid", 0, "pacifica");
    expect(spread).toBe(0);
  });

  it("handles one zero rate", () => {
    const spread = computeAnnualSpread(0.0001, "hyperliquid", 0, "pacifica");
    // hourly diff = 0.0001, spread = 0.0001 * 8760 * 100 = 87.6%
    expect(spread).toBeCloseTo(87.6);
  });

  it("handles negative rates (one exchange paying, other receiving)", () => {
    // HL pays +0.0001/h, pacifica -0.0008/8h = -0.0001/h
    // diff = |0.0001 - (-0.0001)| = 0.0002/h * 8760 * 100 = 175.2%
    const spread = computeAnnualSpread(0.0001, "hyperliquid", -0.0008, "pacifica");
    expect(spread).toBeCloseTo(175.2);
  });
});

// ──────────────────────────────────────────────
// estimateHourlyFunding
// ──────────────────────────────────────────────

describe("estimateHourlyFunding", () => {
  it("long pays positive funding (positive rate)", () => {
    // rate = 0.0001/h (HL), position = $10000
    // hourly payment = 0.0001 * 10000 * 1 = $1
    const payment = estimateHourlyFunding(0.0001, "hyperliquid", 10000, "long");
    expect(payment).toBeCloseTo(1);
  });

  it("short receives positive funding (positive rate)", () => {
    // rate = 0.0001/h (HL), position = $10000
    // hourly payment = 0.0001 * 10000 * (-1) = -$1 (receiving)
    const payment = estimateHourlyFunding(0.0001, "hyperliquid", 10000, "short");
    expect(payment).toBeCloseTo(-1);
  });

  it("long receives negative funding (negative rate)", () => {
    // rate = -0.0001/h, position = $10000
    // hourly = -0.0001 * 10000 * 1 = -$1 (receiving)
    const payment = estimateHourlyFunding(-0.0001, "hyperliquid", 10000, "long");
    expect(payment).toBeCloseTo(-1);
  });

  it("short pays negative funding (negative rate)", () => {
    // rate = -0.0001/h, position = $10000
    // hourly = -0.0001 * 10000 * (-1) = $1 (paying)
    const payment = estimateHourlyFunding(-0.0001, "hyperliquid", 10000, "short");
    expect(payment).toBeCloseTo(1);
  });

  it("normalizes 8h rate to hourly for pacifica", () => {
    // rate = 0.0008/8h (pacifica) → 0.0001/h, position = $10000
    // long pays: 0.0001 * 10000 = $1
    const payment = estimateHourlyFunding(0.0008, "pacifica", 10000, "long");
    expect(payment).toBeCloseTo(1);
  });

  it("returns 0 for zero funding rate", () => {
    expect(estimateHourlyFunding(0, "hyperliquid", 10000, "long")).toBeCloseTo(0);
    expect(estimateHourlyFunding(0, "pacifica", 10000, "short")).toBeCloseTo(0);
  });

  it("returns 0 for zero position size", () => {
    expect(estimateHourlyFunding(0.0001, "hyperliquid", 0, "long")).toBe(0);
  });

  it("scales linearly with position size", () => {
    const small = estimateHourlyFunding(0.0001, "hyperliquid", 1000, "long");
    const large = estimateHourlyFunding(0.0001, "hyperliquid", 10000, "long");
    expect(large).toBeCloseTo(small * 10);
  });
});
