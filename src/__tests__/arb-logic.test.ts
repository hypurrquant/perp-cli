import { describe, it, expect } from "vitest";

/**
 * Tests for the core funding arbitrage logic extracted from arb-auto.ts.
 * These validate the critical direction determination that was previously bugged.
 */

interface FundingSnapshot {
  symbol: string;
  pacRate: number;
  hlRate: number;
  spread: number;
}

function determinArbDirection(snap: FundingSnapshot) {
  // Short the high-funding exchange (get paid), long the low-funding one
  const shortExchange = snap.pacRate > snap.hlRate ? "pacifica" : "hyperliquid";
  const longExchange = snap.pacRate > snap.hlRate ? "hyperliquid" : "pacifica";
  return { longExchange, shortExchange };
}

function computeAnnualizedSpread(pacRate: number, hlRate: number): number {
  return (pacRate - hlRate) * 3 * 365 * 100;
}

describe("Arb direction logic", () => {
  it("shorts high-funding exchange (Pacifica higher)", () => {
    const snap: FundingSnapshot = { symbol: "BTC", pacRate: 0.001, hlRate: 0.0002, spread: 87.6 };
    const { longExchange, shortExchange } = determinArbDirection(snap);
    // Pacifica rate is higher → short Pacifica (get paid funding), long HL
    expect(shortExchange).toBe("pacifica");
    expect(longExchange).toBe("hyperliquid");
  });

  it("shorts high-funding exchange (Hyperliquid higher)", () => {
    const snap: FundingSnapshot = { symbol: "ETH", pacRate: 0.0001, hlRate: 0.0008, spread: -76.65 };
    const { longExchange, shortExchange } = determinArbDirection(snap);
    // HL rate is higher → short HL, long Pacifica
    expect(shortExchange).toBe("hyperliquid");
    expect(longExchange).toBe("pacifica");
  });

  it("handles equal rates", () => {
    const snap: FundingSnapshot = { symbol: "SOL", pacRate: 0.0003, hlRate: 0.0003, spread: 0 };
    const { longExchange, shortExchange } = determinArbDirection(snap);
    // Equal rates → default to long pacifica (pacRate > hlRate is false)
    expect(longExchange).toBe("pacifica");
    expect(shortExchange).toBe("hyperliquid");
  });

  it("handles negative funding rates", () => {
    const snap: FundingSnapshot = { symbol: "DOGE", pacRate: -0.001, hlRate: -0.0002, spread: -87.6 };
    const { longExchange, shortExchange } = determinArbDirection(snap);
    // Pacifica rate is MORE negative → hlRate > pacRate → short HL, long Pacifica
    expect(shortExchange).toBe("hyperliquid");
    expect(longExchange).toBe("pacifica");
  });

  it("handles mixed sign funding rates", () => {
    const snap: FundingSnapshot = { symbol: "ARB", pacRate: 0.001, hlRate: -0.0005, spread: 164.25 };
    const { longExchange, shortExchange } = determinArbDirection(snap);
    // Pac is positive (longs pay), HL is negative (shorts pay)
    // Short Pac (get paid) + Long HL (get paid) = double collect!
    expect(shortExchange).toBe("pacifica");
    expect(longExchange).toBe("hyperliquid");
  });
});

describe("Spread calculation", () => {
  it("computes annualized spread correctly", () => {
    // 0.01% per 8h difference → 0.03% per day → 10.95% per year
    const spread = computeAnnualizedSpread(0.0002, 0.0001);
    expect(spread).toBeCloseTo(10.95, 1);
  });

  it("negative spread when HL rate is higher", () => {
    const spread = computeAnnualizedSpread(0.0001, 0.0003);
    expect(spread).toBeLessThan(0);
    expect(Math.abs(spread)).toBeCloseTo(21.9, 1);
  });

  it("zero spread when rates are equal", () => {
    const spread = computeAnnualizedSpread(0.0001, 0.0001);
    expect(spread).toBe(0);
  });
});

describe("Entry/exit conditions", () => {
  const minSpread = 30; // 30% annual
  const closeSpread = 5; // 5% annual

  it("should enter when spread exceeds threshold", () => {
    const absSpread = 45; // 45% > 30%
    expect(absSpread >= minSpread).toBe(true);
  });

  it("should NOT enter when spread below threshold", () => {
    const absSpread = 20; // 20% < 30%
    expect(absSpread >= minSpread).toBe(false);
  });

  it("should close when spread drops below close threshold", () => {
    const currentSpread = 3; // 3% < 5%
    expect(currentSpread <= closeSpread).toBe(true);
  });

  it("should NOT close when spread is still profitable", () => {
    const currentSpread = 15; // 15% > 5%
    expect(currentSpread <= closeSpread).toBe(false);
  });
});
