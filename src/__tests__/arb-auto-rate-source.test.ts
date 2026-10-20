/**
 * `arb auto` reads the SAME funding rows as `arb scan --rates` (fetchVenuesRates): keyed by
 * canonical symbol (an unclassified / ambiguous ticker has no row there, so it never pairs), each
 * rate kept in its venue's basis for the snapshot math, each leg labelled with its rateKind.
 * SymbolFundingComparison.mixedKinds flags rows whose rates are of different kinds.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExchangeFundingRate } from "../funding/rates.js";

const row = (exchange: ExchangeFundingRate["exchange"], canonical: string, hourlyRate: number, rateKind: ExchangeFundingRate["rateKind"], basisHours = 1): ExchangeFundingRate => ({
  exchange, symbol: canonical, canonical, fundingRate: hourlyRate * basisHours, basis: { kind: "perHours", hours: basisHours }, hourlyRate,
  annualizedPct: hourlyRate * 8760 * 100, markPrice: 100, nextFundingTime: null, historicalAvg: null, fundingVerified: true, apiStatus: "official", rateKind,
});

vi.mock("../funding/rates.js", async (orig) => ({
  ...(await orig<typeof import("../funding/rates.js")>()),
  fetchVenuesRates: vi.fn(async () => ({
    rates: [row("lighter", "BTC", 0.000012, "lastSettled"), row("hyperliquid", "BTC", 0.00005, "accruing"), row("aster", "BTC", 0.0000125, "accruing", 8),
      // An aliased asset: Hyperliquid kPEPE and Lighter 1000PEPE share the canonical 1000PEPE.
      { ...row("hyperliquid", "1000PEPE", 0.0004, "accruing"), symbol: "kPEPE" }, row("lighter", "1000PEPE", 0.00001, "lastSettled"),
      // A row labelled unverified (would be the short leg of ETH at 0.01/h): never a leg.
      row("lighter", "ETH", 0.00001, "lastSettled"), row("hyperliquid", "ETH", 0.00002, "accruing"), { ...row("pacifica", "ETH", 0.01, "lastSettled"), fundingVerified: false }],
    exchangeStatus: { lighter: "ok", hyperliquid: "ok", aster: "ok", pacifica: "ok" }, exchangeErrors: {},
  })),
}));

import "../exchanges/venues/index.js";
import { getFundingHours } from "../funding.js";
import { fetchFundingSpreads, legSymbol } from "../commands/arb-auto.js";

describe("arb auto funding source", () => {
  it("rows from fetchVenuesRates: rates in each venue's basis, legs labelled with rateKind", async () => {
    const s = (await fetchFundingSpreads()).find(x => x.symbol === "BTC")!;
    expect(s.symbol).toBe("BTC");
    expect(s.ltRate).toBeCloseTo(0.000012 * getFundingHours("lighter"), 12);
    expect(s.hlRate).toBeCloseTo(0.00005 * getFundingHours("hyperliquid"), 12);
    expect(s.astRate).toBeCloseTo(0.0001, 12); // Aster: the row's own per-symbol basis (8 h)
    expect(s.astHours).toBe(8);
    expect(s.rateKinds).toEqual({ lighter: "lastSettled", hyperliquid: "accruing", aster: "accruing" });
    expect([s.longExch, s.shortExch]).toEqual(["lighter", "hyperliquid"]);
  });

  it("a row labelled fundingVerified false is never a leg (ETH pairs lighter / hyperliquid, not pacifica)", async () => {
    const s = (await fetchFundingSpreads()).find(x => x.symbol === "ETH")!;
    expect([s.longExch, s.shortExch]).toEqual(["lighter", "hyperliquid"]);
    expect(s.rateKinds?.pacifica).toBeUndefined(); // no pacifica leg data at all
  });

  it("an aliased row carries each venue's own symbol: the HL leg trades kPEPE, the Lighter leg 1000PEPE", async () => {
    const s = (await fetchFundingSpreads()).find(x => x.symbol === "1000PEPE")!;
    expect(s.venueSymbols).toEqual({ hyperliquid: "kPEPE", lighter: "1000PEPE" });
    expect([s.longExch, s.shortExch]).toEqual(["lighter", "hyperliquid"]);
    expect(legSymbol(s, s.longExch)).toBe("1000PEPE");
    expect(legSymbol(s, s.shortExch)).toBe("kPEPE");
  });
});
