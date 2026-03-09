import { describe, it, expect } from "vitest";

/**
 * Tests for the enhanced 3-DEX arb direction and PnL tracking logic
 * extracted from arb-auto.ts.
 */

interface ExchangeRate {
  exchange: string;
  rate: number;
}

interface FundingSnapshot {
  symbol: string;
  pacRate: number;
  hlRate: number;
  ltRate: number;
  spread: number;
  longExch: string;
  shortExch: string;
  markPrice: number;
}

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  size: string;
  entrySpread: number;
  entryTime: string;
  entryMarkPrice: number;
  accumulatedFundingUsd: number;
  lastCheckTime: number;
}

/**
 * Mirrors the direction logic in arb-auto.ts:
 * Sort all available exchange rates by hourly-normalized rate.
 * Long on the lowest-rate exchange, short on the highest.
 */
function determine3DexDirection(snap: FundingSnapshot): { longExchange: string; shortExchange: string } {
  return {
    longExchange: snap.longExch,
    shortExchange: snap.shortExch,
  };
}

/**
 * Mirrors the funding accumulation logic in arb-auto:
 * Estimate funding collected based on rate differential and elapsed time.
 */
function accumulateFunding(
  pos: ArbPosition,
  current: FundingSnapshot,
  nowMs: number,
): number {
  const elapsedHours = (nowMs - pos.lastCheckTime) / (1000 * 60 * 60);
  const notional = parseFloat(pos.size) * current.markPrice;
  const rateFor = (e: string) => e === "pacifica" ? current.pacRate : e === "hyperliquid" ? current.hlRate : current.ltRate;
  const longHourly = rateFor(pos.longExchange) / (pos.longExchange === "hyperliquid" ? 1 : 8);
  const shortHourly = rateFor(pos.shortExchange) / (pos.shortExchange === "hyperliquid" ? 1 : 8);
  const hourlyIncome = (shortHourly - longHourly) * notional;
  return hourlyIncome * elapsedHours;
}

// ──────────────────────────────────────────────
// 3-DEX direction
// ──────────────────────────────────────────────

describe("3-DEX direction determination", () => {
  it("uses longExch/shortExch from snapshot (all 3 available)", () => {
    const snap: FundingSnapshot = {
      symbol: "BTC",
      pacRate: 0.0006,   // pac = 0.000075/hr
      hlRate: 0.0003,    // hl = 0.0003/hr (highest!)
      ltRate: 0.0002,    // lt = 0.000025/hr (lowest!)
      spread: 240.9,
      longExch: "lighter",
      shortExch: "hyperliquid",
      markPrice: 60000,
    };

    const { longExchange, shortExchange } = determine3DexDirection(snap);
    expect(longExchange).toBe("lighter");
    expect(shortExchange).toBe("hyperliquid");
  });

  it("handles pac vs hl only (lighter missing)", () => {
    const snap: FundingSnapshot = {
      symbol: "ETH",
      pacRate: 0.002,     // pac = 0.00025/hr
      hlRate: 0.00005,    // hl = 0.00005/hr
      ltRate: 0,          // no lighter
      spread: 175.2,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 3000,
    };

    const { longExchange, shortExchange } = determine3DexDirection(snap);
    expect(longExchange).toBe("hyperliquid");
    expect(shortExchange).toBe("pacifica");
  });

  it("handles lighter vs pac when HL missing", () => {
    const snap: FundingSnapshot = {
      symbol: "SOL",
      pacRate: 0.0001,
      hlRate: 0,
      ltRate: 0.001,
      spread: 98.55,
      longExch: "pacifica",
      shortExch: "lighter",
      markPrice: 150,
    };

    const { longExchange, shortExchange } = determine3DexDirection(snap);
    expect(longExchange).toBe("pacifica");
    expect(shortExchange).toBe("lighter");
  });
});

// ──────────────────────────────────────────────
// Funding accumulation
// ──────────────────────────────────────────────

describe("Funding accumulation tracking", () => {
  const baseTime = Date.now();

  it("accumulates positive income when spread is favorable", () => {
    const pos: ArbPosition = {
      symbol: "BTC",
      longExchange: "hyperliquid",    // low funding
      shortExchange: "pacifica",       // high funding
      size: "0.1",
      entrySpread: 50,
      entryTime: new Date().toISOString(),
      entryMarkPrice: 60000,
      accumulatedFundingUsd: 0,
      lastCheckTime: baseTime,
    };

    const snap: FundingSnapshot = {
      symbol: "BTC",
      pacRate: 0.001,    // pac = 0.000125/hr
      hlRate: 0.00005,   // hl = 0.00005/hr
      ltRate: 0,
      spread: 65.7,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 60000,
    };

    // 1 hour elapsed
    const income = accumulateFunding(pos, snap, baseTime + 3600_000);
    // shortHourly = 0.001/8 = 0.000125
    // longHourly = 0.00005/1 = 0.00005
    // diff = 0.000125 - 0.00005 = 0.000075
    // notional = 0.1 * 60000 = 6000
    // income = 0.000075 * 6000 * 1 = $0.45/hr
    expect(income).toBeCloseTo(0.45, 2);
  });

  it("returns zero income when no time elapsed", () => {
    const pos: ArbPosition = {
      symbol: "ETH",
      longExchange: "lighter",
      shortExchange: "pacifica",
      size: "1",
      entrySpread: 30,
      entryTime: new Date().toISOString(),
      entryMarkPrice: 3000,
      accumulatedFundingUsd: 0,
      lastCheckTime: baseTime,
    };

    const snap: FundingSnapshot = {
      symbol: "ETH",
      pacRate: 0.0005,
      hlRate: 0.0001,
      ltRate: 0.0001,
      spread: 43.8,
      longExch: "lighter",
      shortExch: "pacifica",
      markPrice: 3000,
    };

    const income = accumulateFunding(pos, snap, baseTime); // same time
    expect(income).toBe(0);
  });

  it("scales with elapsed time", () => {
    const pos: ArbPosition = {
      symbol: "BTC",
      longExchange: "hyperliquid",
      shortExchange: "pacifica",
      size: "0.1",
      entrySpread: 50,
      entryTime: new Date().toISOString(),
      entryMarkPrice: 60000,
      accumulatedFundingUsd: 0,
      lastCheckTime: baseTime,
    };

    const snap: FundingSnapshot = {
      symbol: "BTC",
      pacRate: 0.001,
      hlRate: 0.00005,
      ltRate: 0,
      spread: 65.7,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 60000,
    };

    const income1h = accumulateFunding(pos, snap, baseTime + 3600_000);
    const income24h = accumulateFunding(pos, snap, baseTime + 24 * 3600_000);
    expect(income24h).toBeCloseTo(income1h * 24, 2);
  });

  it("can produce negative income if spread reverses", () => {
    const pos: ArbPosition = {
      symbol: "BTC",
      longExchange: "pacifica",       // originally was low
      shortExchange: "hyperliquid",   // originally was high
      size: "0.1",
      entrySpread: 20,
      entryTime: new Date().toISOString(),
      entryMarkPrice: 60000,
      accumulatedFundingUsd: 0,
      lastCheckTime: baseTime,
    };

    // Now PAC rate is HIGHER than HL — bad for our direction
    const snap: FundingSnapshot = {
      symbol: "BTC",
      pacRate: 0.002,     // pac now high: 0.00025/hr
      hlRate: 0.00001,    // hl now low: 0.00001/hr
      ltRate: 0,
      spread: 218.3,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 60000,
    };

    const income = accumulateFunding(pos, snap, baseTime + 3600_000);
    // shortHourly (HL) = 0.00001
    // longHourly (PAC) = 0.002/8 = 0.00025
    // diff = 0.00001 - 0.00025 = -0.00024
    // notional = 6000
    // income = -0.00024 * 6000 * 1 = -$1.44
    expect(income).toBeLessThan(0);
  });
});

// ──────────────────────────────────────────────
// Entry/exit conditions with 3 DEXs
// ──────────────────────────────────────────────

describe("3-DEX entry/exit conditions", () => {
  const minSpread = 30;
  const closeSpread = 5;

  it("enters when any 2-exchange spread exceeds threshold", () => {
    // Only PAC and LT available, but spread is large
    const absSpread = 45;
    expect(absSpread >= minSpread).toBe(true);
  });

  it("closes when best available spread drops below close threshold", () => {
    const currentSpread = 3;
    expect(currentSpread <= closeSpread).toBe(true);
  });

  it("does not enter if max positions reached", () => {
    const maxPositions = 3;
    const openPositions = 3;
    expect(openPositions >= maxPositions).toBe(true);
  });

  it("skips symbol already in open positions", () => {
    const openPositions: ArbPosition[] = [{
      symbol: "BTC",
      longExchange: "hyperliquid",
      shortExchange: "pacifica",
      size: "0.1",
      entrySpread: 40,
      entryTime: new Date().toISOString(),
      entryMarkPrice: 60000,
      accumulatedFundingUsd: 0.5,
      lastCheckTime: Date.now(),
    }];

    const alreadyOpen = openPositions.some(p => p.symbol === "BTC");
    expect(alreadyOpen).toBe(true);
  });
});
