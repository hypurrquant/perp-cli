/**
 * Dogfood 0.15.1: `arb scan --compare BTC --include-unverified` ranked an unverified leg (Extended,
 * QFEX) as the long / short side and into the spread. Unverified rows are display data: the long /
 * short pair and the spread come from verified rows only (scan --rates, --compare, MCP
 * get_funding_rates — all fetchAllFundingRates); a group with fewer than two verified rows has no
 * ranked pair (nulls). `arb auto` and `strategy funding-arb` never take an unverified row as a leg.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../exchanges/venues/index.js";
import { listVenuesWithRole, type VenueDefinition } from "../exchanges/venue.js";
import type { VenueFundingRate } from "../exchanges/venue-types.js";
import { fetchAllFundingRates, fetchSymbolFundingRates, isRankedComparison } from "../funding/rates.js";

const row = (venue: string, canonical: string, rate: string): VenueFundingRate => ({
  venue: venue as VenueFundingRate["venue"], venueSymbol: canonical, symbol: canonical, canonical, rate,
  basis: { kind: "perHours", hours: 1 }, markPrice: "100", nextFundingTime: null,
});

/** Every market-data venue answers `rows[venue]` (or nothing). */
function stubVenues(rows: Record<string, VenueFundingRate[]>): void {
  for (const def of listVenuesWithRole("marketData") as VenueDefinition[]) {
    vi.spyOn(def.publicData, "fetchFundingRates").mockResolvedValue(rows[def.id] ?? []);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("unverified rows are shown, never ranked", () => {
  const ROWS = {
    hyperliquid: [row("hyperliquid", "BTC", "0.00001"), row("hyperliquid", "SOLO", "0.00001")],
    lighter: [row("lighter", "BTC", "0.00003")],
    // The extremes are unverified: ranking them would give long qfex / short extended.
    extended: [row("extended", "BTC", "0.001"), row("extended", "SOLO", "0.0005")],
    qfex: [row("qfex", "BTC", "-0.001")],
  };

  it("--compare / --rates: long and short are verified venues; the spread is the verified one; unverified rates stay in `rates`", async () => {
    stubVenues(ROWS);
    const c = (await fetchSymbolFundingRates("BTC", true))!;
    expect(c.rates.map(r => r.exchange).sort()).toEqual(["extended", "hyperliquid", "lighter", "qfex"]);
    expect([c.longExchange, c.shortExchange]).toEqual(["hyperliquid", "lighter"]);
    expect(c.maxSpreadAnnual).toBeCloseTo(0.00002 * 8760 * 100, 6);
    expect(c.unverifiedLegs).toEqual([]);
    expect(c.executable).toBe(true);
  });

  it("a group with fewer than two verified rows has no ranked pair (nulls), is never executable and is not dropped by --min", async () => {
    stubVenues(ROWS);
    const snap = await fetchAllFundingRates({ symbols: ["SOLO"], minSpread: 10, includeUnverified: true });
    expect(snap.symbols).toHaveLength(1);
    expect(snap.symbols[0]).toMatchObject({ symbol: "SOLO", longExchange: null, shortExchange: null, maxSpreadAnnual: null, estHourlyIncomeUsd: null, executable: false, unverifiedLegs: ["extended"] });
    expect(isRankedComparison(snap.symbols[0])).toBe(false);
  });

  it("ranked rows sort before display-only rows; without --include-unverified nothing unverified is read", async () => {
    stubVenues(ROWS);
    const all = await fetchAllFundingRates({ symbols: ["BTC", "SOLO"], includeUnverified: true });
    expect(all.symbols.map(s => s.symbol)).toEqual(["BTC", "SOLO"]);
    const verified = await fetchAllFundingRates({ symbols: ["BTC", "SOLO"] });
    expect(verified.symbols.map(s => s.symbol)).toEqual(["BTC"]);
    expect(verified.symbols[0].rates.every(r => r.fundingVerified)).toBe(true);
  });
});
