/**
 * Review HIGH (7a82269): the funding rows are keyed by CANONICAL symbol (Hyperliquid kPEPE and
 * Lighter 1000PEPE both → 1000PEPE), but orders, position reads and closes must use each venue's
 * OWN symbol. `perp strategy funding-arb` opens, reads and closes a kPEPE (HL) / 1000PEPE (Lighter)
 * pair with the venue symbols; `arb auto`'s snapshot carries them (legSymbol) and its --symbols
 * filter accepts either form.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExchangeFundingRate } from "../funding/rates.js";

const row = (exchange: ExchangeFundingRate["exchange"], symbol: string, canonical: string, hourlyRate: number): ExchangeFundingRate => ({
  exchange, symbol, canonical, fundingRate: hourlyRate, basis: { kind: "perHours", hours: 1 }, hourlyRate, annualizedPct: hourlyRate * 876_000,
  markPrice: 0.01, nextFundingTime: null, historicalAvg: null, fundingVerified: true, apiStatus: "official", rateKind: "lastSettled",
});

const h = vi.hoisted(() => ({ cycle: 0, open: [] as unknown[], close: [] as unknown[], posReads: [] as string[] }));

vi.mock("../funding/rates.js", async (orig) => ({
  ...(await orig<typeof import("../funding/rates.js")>()),
  fetchVenuesRates: vi.fn(async () => {
    h.cycle++;
    // cycle 1: a wide spread (entry); cycle 2: no spread (close); then the test stops the loop.
    const spread = h.cycle === 1 ? 0.0005 : 0;
    if (h.cycle >= 2) setTimeout(() => process.emit("SIGINT"), 0);
    return {
      rates: [row("lighter", "1000PEPE", "1000PEPE", 0.00001), row("hyperliquid", "kPEPE", "1000PEPE", 0.00001 + spread)],
      exchangeStatus: { lighter: "ok", hyperliquid: "ok" }, exchangeErrors: {},
    };
  }),
}));
vi.mock("../commands/arb-auto.js", async (orig) => ({
  ...(await orig<typeof import("../commands/arb-auto.js")>()),
  openPerpPairVerified: vi.fn(async (p: { longSym: string; shortSym: string }) => { h.open.push(p); return { status: "opened", hedged: "1000", trimmed: "0" }; }),
  closePerpPairVerified: vi.fn(async (p: { longSym: string; shortSym: string }) => { h.close.push(p); return { status: "closed" }; }),
}));
vi.mock("../liquidity.js", async (orig) => ({
  ...(await orig<typeof import("../liquidity.js")>()),
  checkArbLiquidity: vi.fn(async () => ({ viable: true, adjustedSizeUsd: 10, longSlippage: 0, shortSlippage: 0 })),
}));
vi.mock("../rebalance.js", async (orig) => ({
  ...(await orig<typeof import("../rebalance.js")>()),
  fetchBalancesWithFailures: vi.fn(async () => ({ snapshots: [], failed: [] })),
  hasEnoughBalance: vi.fn(() => true),
  marketLeverageOf: vi.fn(async () => 5),
}));
vi.mock("../arb-sizing.js", async (orig) => ({
  ...(await orig<typeof import("../arb-sizing.js")>()),
  computeMatchedSize: vi.fn(() => ({ size: "1000", notional: 10 })),
}));
vi.mock("../exchanges/trading-v2.js", async (orig) => ({ ...(await orig<typeof import("../exchanges/trading-v2.js")>()), assertCanClosePositions: vi.fn() }));

import "../exchanges/venues/index.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { runFundingArb } from "../strategies/funding-arb.js";
import { legSymbol, matchesSymbolFilter } from "../commands/arb-auto.js";

function adapter(name: string, sym: string): ExchangeAdapter {
  return {
    name,
    getMarkets: async () => [{ symbol: sym, sizeDecimals: 0 }],
    getPositions: async () => { h.posReads.push(`${name}:${sym}`); return [{ symbol: sym, side: name === "lighter" ? "long" : "short", size: "1000" }]; },
  } as unknown as ExchangeAdapter;
}

describe("venue symbols of an aliased pair (HL kPEPE ↔ Lighter 1000PEPE)", () => {
  it("strategy funding-arb: open, position read and close use each venue's own symbol; --symbols kPEPE matches", async () => {
    const logs: string[] = [];
    const adapters = new Map([["lighter", adapter("lighter", "1000PEPE")], ["hyperliquid", adapter("hyperliquid", "kPEPE")]]);
    await runFundingArb(adapters, { minSpread: 1, closeSpread: 5, size: "1000", intervalSec: 0, autoExecute: true, symbols: ["kPEPE"] }, undefined, (m) => logs.push(m));
    expect(h.open).toHaveLength(1);
    expect(h.open[0]).toMatchObject({ longExch: "lighter", longSym: "1000PEPE", shortExch: "hyperliquid", shortSym: "kPEPE" });
    expect(h.close).toHaveLength(1);
    expect(h.close[0]).toMatchObject({ longSym: "1000PEPE", shortSym: "kPEPE" });
    expect(h.posReads.sort()).toEqual(["hyperliquid:kPEPE", "lighter:1000PEPE"]);
  });

  it("arb auto: a snapshot leg trades the venue's own symbol; --symbols accepts the canonical or a venue form", () => {
    const snap = { symbol: "1000PEPE", venueSymbols: { hyperliquid: "kPEPE", lighter: "1000PEPE" } };
    expect(legSymbol(snap, "hyperliquid")).toBe("kPEPE");
    expect(legSymbol(snap, "lighter")).toBe("1000PEPE");
    expect(legSymbol({ symbol: "BTC" }, "hyperliquid")).toBe("BTC");
    expect(matchesSymbolFilter(snap, ["kpepe"])).toBe(true);
    expect(matchesSymbolFilter(snap, ["1000PEPE"])).toBe(true);
    expect(matchesSymbolFilter(snap, ["BTC"])).toBe(false);
  });
});
