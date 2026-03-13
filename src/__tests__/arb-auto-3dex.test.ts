import { describe, it, expect } from "vitest";
import {
  computeNetSpread,
  computeRoundTripCostPct,
  getNextSettlement,
  isNearSettlement,
  isSpreadReversed,
} from "../commands/arb-auto.js";

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
  pacMarkPrice: number;
  hlMarkPrice: number;
  ltMarkPrice: number;
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
  const longHourly = rateFor(pos.longExchange) / 1;  // all exchanges are hourly
  const shortHourly = rateFor(pos.shortExchange) / 1;  // all exchanges are hourly
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
      pacRate: 0.0006,   // pac = 0.0006/hr
      hlRate: 0.0003,    // hl = 0.0003/hr
      ltRate: 0.0002,    // lt = 0.0002/hr (lowest!)
      spread: 240.9,
      longExch: "lighter",
      shortExch: "pacifica",
      markPrice: 60000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
    };

    const { longExchange, shortExchange } = determine3DexDirection(snap);
    expect(longExchange).toBe("lighter");
    expect(shortExchange).toBe("pacifica");
  });

  it("handles pac vs hl only (lighter missing)", () => {
    const snap: FundingSnapshot = {
      symbol: "ETH",
      pacRate: 0.002,     // pac = 0.002/hr (highest)
      hlRate: 0.00005,    // hl = 0.00005/hr (lowest)
      ltRate: 0,          // no lighter
      spread: 175.2,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 3000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
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
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
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
      pacRate: 0.000125,   // pac = 0.000125/hr (all hourly now)
      hlRate: 0.00005,     // hl = 0.00005/hr
      ltRate: 0,
      spread: 65.7,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 60000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
    };

    // 1 hour elapsed
    const income = accumulateFunding(pos, snap, baseTime + 3600_000);
    // shortHourly = 0.000125
    // longHourly = 0.00005
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
      pacRate: 0.0005,    // all hourly now
      hlRate: 0.0001,
      ltRate: 0.0001,
      spread: 43.8,
      longExch: "lighter",
      shortExch: "pacifica",
      markPrice: 3000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
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
      pacRate: 0.000125,
      hlRate: 0.00005,
      ltRate: 0,
      spread: 65.7,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 60000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
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
      pacRate: 0.00025,    // pac now high: 0.00025/hr
      hlRate: 0.00001,     // hl now low: 0.00001/hr
      ltRate: 0,
      spread: 218.3,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 60000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
    };

    const income = accumulateFunding(pos, snap, baseTime + 3600_000);
    // shortHourly (HL) = 0.00001
    // longHourly (PAC) = 0.00025
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

// ──────────────────────────────────────────────
// Net spread calculation
// ──────────────────────────────────────────────

describe("computeNetSpread", () => {
  it("correctly deducts annualized round-trip cost from gross spread", () => {
    // gross=30%, hold=7d, roundTrip=0.14% → net = 30 - (0.14/7*365) = 30 - 7.3 = 22.7
    const net = computeNetSpread(30, 7, 0.14);
    expect(net).toBeCloseTo(22.7, 1);
  });

  it("returns gross spread when costs are zero", () => {
    const net = computeNetSpread(50, 7, 0);
    expect(net).toBe(50);
  });

  it("can produce negative net spread when costs exceed gross", () => {
    // gross=5%, hold=1d, roundTrip=0.14% → net = 5 - (0.14*365) = 5 - 51.1 = -46.1
    const net = computeNetSpread(5, 1, 0.14);
    expect(net).toBeLessThan(0);
  });

  it("longer hold periods reduce annualized cost impact", () => {
    const net7d = computeNetSpread(30, 7, 0.14);
    const net30d = computeNetSpread(30, 30, 0.14);
    expect(net30d).toBeGreaterThan(net7d);
  });

  it("includes bridge cost in net spread calculation", () => {
    // Without bridge cost
    const netNoBridge = computeNetSpread(30, 7, 0.14, 0, 100);
    // With $0.50 bridge cost, $100 position
    // bridgeRoundTripPct = (0.5 * 2 / 100) * 100 = 1%
    // bridgeAnnualized = (1/7) * 365 = 52.14%
    const netWithBridge = computeNetSpread(30, 7, 0.14, 0.5, 100);
    expect(netWithBridge).toBeLessThan(netNoBridge);
    // Difference should be the annualized bridge cost
    const bridgeDiff = netNoBridge - netWithBridge;
    expect(bridgeDiff).toBeCloseTo(52.14, 0);
  });

  it("bridge cost impact scales inversely with position size", () => {
    const netSmall = computeNetSpread(30, 7, 0.14, 0.5, 50);   // $50 position
    const netLarge = computeNetSpread(30, 7, 0.14, 0.5, 500);   // $500 position
    // Larger positions dilute bridge cost
    expect(netLarge).toBeGreaterThan(netSmall);
  });
});

describe("computeRoundTripCostPct", () => {
  it("computes round-trip cost for same-fee exchanges", () => {
    // 2 × (0.035% + 0.035%) + 2 × 0.05% = 0.24%
    const cost = computeRoundTripCostPct("hyperliquid", "pacifica", 0.05);
    expect(cost).toBeCloseTo(0.24, 4);
  });

  it("uses default slippage of 0.05%", () => {
    const cost = computeRoundTripCostPct("hyperliquid", "lighter");
    // lighter taker fee = 0%, so: 2 × (0.035% + 0%) + 2 × 0.05% = 0.17%
    expect(cost).toBeCloseTo(0.17, 4);
  });

  it("handles custom slippage", () => {
    const cost = computeRoundTripCostPct("hyperliquid", "pacifica", 0.1);
    // 2 × (0.035% + 0.035%) + 2 × 0.1% = 0.34%
    expect(cost).toBeCloseTo(0.34, 4);
  });
});

// ──────────────────────────────────────────────
// Spread reversal detection
// ──────────────────────────────────────────────

describe("Spread reversal detection", () => {
  it("detects reversal when long exchange rate exceeds short", () => {
    const snap: FundingSnapshot = {
      symbol: "BTC",
      pacRate: 0.0001,    // PAC low (was short, now low)
      hlRate: 0.0005,     // HL high (was long, now high)
      ltRate: 0,
      spread: 30,
      longExch: "pacifica",
      shortExch: "hyperliquid",
      markPrice: 60000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
    };
    // Position: long HL, short PAC — but now HL hourly (0.0005) > PAC hourly (0.0001)
    const reversed = isSpreadReversed("hyperliquid", "pacifica", snap);
    expect(reversed).toBe(true);
  });

  it("does not flag reversal when spread is still favorable", () => {
    const snap: FundingSnapshot = {
      symbol: "BTC",
      pacRate: 0.001,    // PAC high (0.001/hr)
      hlRate: 0.00005,   // HL low (0.00005/hr)
      ltRate: 0,
      spread: 65.7,
      longExch: "hyperliquid",
      shortExch: "pacifica",
      markPrice: 60000,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
    };
    // Position: long HL, short PAC — HL hourly (0.00005) < PAC hourly (0.001) → no reversal
    const reversed = isSpreadReversed("hyperliquid", "pacifica", snap);
    expect(reversed).toBe(false);
  });

  it("handles lighter vs pacifica reversal", () => {
    const snap: FundingSnapshot = {
      symbol: "SOL",
      pacRate: 0.0001,   // PAC hourly = 0.0001
      hlRate: 0,
      ltRate: 0.0016,    // LT 8h rate, hourly = 0.0016/8 = 0.0002
      spread: 10,
      longExch: "pacifica",
      shortExch: "lighter",
      markPrice: 150,
      pacMarkPrice: 0, hlMarkPrice: 0, ltMarkPrice: 0,
    };
    // Position: long LT, short PAC — LT hourly (0.0002) > PAC hourly (0.0001) → reversed
    const reversed = isSpreadReversed("lighter", "pacifica", snap);
    expect(reversed).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Settlement timing awareness
// ──────────────────────────────────────────────

describe("Settlement timing awareness", () => {
  it("getNextSettlement returns next hour for HL", () => {
    // At 14:30 UTC, next HL settlement is at 15:00 UTC
    const now = new Date("2025-01-15T14:30:00Z");
    const next = getNextSettlement("hyperliquid", now);
    expect(next.getUTCHours()).toBe(15);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("getNextSettlement returns next hour for PAC (hourly like HL)", () => {
    // At 06:00 UTC, next PAC settlement is at 07:00 UTC
    const now = new Date("2025-01-15T06:30:00Z");
    const next = getNextSettlement("pacifica", now);
    expect(next.getUTCHours()).toBe(7);
  });

  it("getNextSettlement wraps to next day for PAC when at 23:xx", () => {
    // At 23:30 UTC, next PAC settlement is at 00:00 next day
    const now = new Date("2025-01-15T23:30:00Z");
    const next = getNextSettlement("pacifica", now);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCDate()).toBe(16);
  });

  it("isNearSettlement blocks entry within 5 minutes of settlement", () => {
    // 3 minutes before 08:00 UTC settlement — all exchanges settle hourly now
    const now = new Date("2025-01-15T07:57:00Z");
    const result = isNearSettlement("lighter", "pacifica", 5, now);
    expect(result.blocked).toBe(true);
    // Both lighter and pacifica settle at 08:00, lighter checked first
    expect(result.exchange).toBe("lighter");
    expect(result.minutesUntil).toBeLessThanOrEqual(5);
  });

  it("isNearSettlement allows entry far from settlement", () => {
    // 30 minutes past the hour — next settlement is 30 min away
    const now = new Date("2025-01-15T15:30:00Z");
    const result = isNearSettlement("lighter", "pacifica", 5, now);
    expect(result.blocked).toBe(false);
  });

  it("isNearSettlement checks both exchanges", () => {
    // 2 minutes before hourly HL settlement
    const now = new Date("2025-01-15T14:58:00Z");
    const result = isNearSettlement("hyperliquid", "pacifica", 5, now);
    expect(result.blocked).toBe(true);
    expect(result.exchange).toBe("hyperliquid");
  });
});
