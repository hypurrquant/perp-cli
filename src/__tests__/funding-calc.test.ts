import { describe, it, expect } from "vitest";
import { annualizeRate, computeAnnualSpread, toHourlyRate, estimateHourlyFunding } from "../funding.js";

describe("Funding Rate Normalization", () => {
  describe("toHourlyRate", () => {
    it("should return HL rate as-is (already hourly)", () => {
      expect(toHourlyRate(0.001, "hyperliquid")).toBeCloseTo(0.001);
    });

    it("should divide Pacifica 8h rate by 8", () => {
      expect(toHourlyRate(0.008, "pacifica")).toBeCloseTo(0.001);
    });

    it("should divide Lighter 8h rate by 8", () => {
      expect(toHourlyRate(0.008, "lighter")).toBeCloseTo(0.001);
    });
  });

  describe("annualizeRate", () => {
    it("should annualize HL hourly rate correctly", () => {
      // 0.01% per hour * 8760 hours = 87.6%
      const result = annualizeRate(0.0001, "hyperliquid");
      expect(result).toBeCloseTo(87.6, 0);
    });

    it("should annualize Pacifica 8h rate correctly", () => {
      // 0.08% per 8h = 0.01% per hour * 8760 = 87.6%
      const result = annualizeRate(0.0008, "pacifica");
      expect(result).toBeCloseTo(87.6, 0);
    });

    it("should handle zero rate", () => {
      expect(annualizeRate(0, "hyperliquid")).toBe(0);
    });

    it("should handle negative rates", () => {
      expect(annualizeRate(-0.0001, "hyperliquid")).toBeLessThan(0);
    });
  });

  describe("computeAnnualSpread", () => {
    it("should compute spread between different exchanges", () => {
      // HL: 0.01% hourly, PAC: 0.001% per 8h = 0.000125% hourly
      // Spread = |0.01% - 0.000125%| * 8760 = ~86.5%
      const spread = computeAnnualSpread(0.0001, "hyperliquid", 0.00001, "pacifica");
      expect(spread).toBeGreaterThan(0);
    });

    it("should return positive spread when rates are ordered correctly", () => {
      const spread = computeAnnualSpread(0.001, "hyperliquid", 0.0001, "hyperliquid");
      expect(spread).toBeGreaterThan(0);
    });

    it("should handle same exchange same rate (zero spread)", () => {
      const spread = computeAnnualSpread(0.0001, "hyperliquid", 0.0001, "hyperliquid");
      expect(spread).toBeCloseTo(0, 1);
    });

    it("should normalize before computing (HL hourly vs PAC 8h)", () => {
      // Same effective rate: HL 0.001 hourly = PAC 0.008 per 8h
      const spread = computeAnnualSpread(0.001, "hyperliquid", 0.008, "pacifica");
      expect(Math.abs(spread)).toBeLessThan(1); // should be ~0
    });
  });

  describe("estimateHourlyFunding", () => {
    it("should estimate funding cost for long position (positive rate = longs pay)", () => {
      // Positive rate, long position = pay funding (positive return means you pay)
      const result = estimateHourlyFunding(0.0001, "hyperliquid", 10000, "long");
      expect(result).toBeGreaterThan(0); // longs pay when rate is positive
    });

    it("should estimate funding income for short position (positive rate = shorts receive)", () => {
      // Positive rate, short position = receive funding (negative return means you receive)
      const result = estimateHourlyFunding(0.0001, "hyperliquid", 10000, "short");
      expect(result).toBeLessThan(0); // shorts receive when rate is positive
    });

    it("should scale with position size", () => {
      const small = estimateHourlyFunding(0.0001, "hyperliquid", 1000, "long");
      const big = estimateHourlyFunding(0.0001, "hyperliquid", 10000, "long");
      expect(Math.abs(big)).toBeCloseTo(Math.abs(small) * 10, 2);
    });
  });
});
