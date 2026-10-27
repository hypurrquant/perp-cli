/**
 * Pre-release QA sweep (0.15.0) — `arb scan --basis`.
 *
 * It paired unrelated assets that share a ticker (BB on Lighter 8.4985 vs Aster 0.0091; MEME on HL
 * 0.000527 vs Aster 0.01176) because it matched raw symbols across four hard-coded venues. Basis is
 * a PRICE comparison, so it now reads every trading venue's market directory (publicData
 * .fetchMarkets — independent of funding: a market with a null rate, or a venue whose funding is
 * unverified, still has a price), groups by canonical symbol with the perp-perp scan's median
 * price-outlier drop, and requires the cheap / rich pair to agree within MAX_PRICE_DEVIATION_PCT.
 * Venue scope: venues with the "trading" role (both legs must be executable) — TxFlow (market
 * data only) is out.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../funding/history.js", () => ({ getHistoricalAverages: () => new Map() }));

import { handleBasisScan } from "../commands/arb.js";
import { listVenues } from "../exchanges/venue.js";
import type { VenueFundingRate, VenueId, VenueMarket } from "../exchanges/venue-types.js";
import "../exchanges/venues/index.js";

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

const mkt = (venue: VenueId, symbol: string, canonical: string | null, mark: string, extra: Partial<VenueMarket> = {}): VenueMarket => ({
  venue, venueSymbol: symbol, symbol, canonical, markPrice: mark, tradable: true, quoteAsset: "USD", fundingRate: null,
  ...extra,
} as VenueMarket);

const HOURLY = { kind: "perHours", hours: 1 } as const;
const rate = (venue: VenueId, symbol: string, mark: string, r: string): VenueFundingRate => ({
  venue, venueSymbol: symbol, symbol, canonical: symbol, rate: r, basis: HOURLY, markPrice: mark, nextFundingTime: null,
});

function venuesReturn(markets: Partial<Record<VenueId, VenueMarket[]>>, rates: Partial<Record<VenueId, VenueFundingRate[]>> = {}) {
  const spies = new Map<VenueId, ReturnType<typeof vi.fn>>();
  for (const v of listVenues()) {
    const m = markets[v.id];
    spies.set(v.id, vi.spyOn(v.publicData, "fetchMarkets").mockImplementation(async () => {
      if (m === undefined) throw new Error(`${v.id} offline`);
      return m;
    }) as never);
    vi.spyOn(v.publicData, "fetchFundingRates").mockImplementation(async () => rates[v.id] ?? []);
  }
  return spies;
}

async function scan(minBasis = "0", symbol?: string) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as never);
  await handleBasisScan(() => true, { minBasis, symbol });
  return { data: JSON.parse(out[out.length - 1]).data as Array<{ symbol: string; prices: Record<string, number>; buyOn: string; sellOn: string; pctDiff: number }>, err };
}

describe("arb scan --basis", () => {
  it("never pairs the same ticker on unrelated assets (BB 8.4985 vs 0.0091)", async () => {
    venuesReturn({
      lighter: [mkt("lighter", "BB", "BB", "8.4985"), mkt("lighter", "BTC", "BTC", "83000")],
      aster: [mkt("aster", "BB", "BB", "0.00911904"), mkt("aster", "BTC", "BTC", "83050")],
    });
    const { data } = await scan();
    expect(data.map((o) => o.symbol)).toEqual(["BTC"]);
    expect(data[0]).toMatchObject({ buyOn: "lighter", sellOn: "aster", prices: { lighter: 83000, aster: 83050 } });
  });

  it("an outlier venue is dropped and the rest of the group still compares (MEME)", async () => {
    venuesReturn({
      hyperliquid: [mkt("hyperliquid", "MEME", "MEME", "0.000527")],
      lighter: [mkt("lighter", "MEME", "MEME", "0.000529")],
      pacifica: [mkt("pacifica", "MEME", "MEME", "0.000528")],
      aster: [mkt("aster", "MEME", "MEME", "0.01176")],
    });
    const { data } = await scan();
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0].prices).sort()).toEqual(["hyperliquid", "lighter", "pacifica"]);
  });

  it("the chosen PRICE pair must agree within MAX_PRICE_DEVIATION_PCT even when the median filter keeps both", async () => {
    // median 103.5: each venue within 5% of it, but the price extremes are 6.8% apart.
    venuesReturn({
      hyperliquid: [mkt("hyperliquid", "XYZ", "XYZ", "100")],
      lighter: [mkt("lighter", "XYZ", "XYZ", "103.5")],
      pacifica: [mkt("pacifica", "XYZ", "XYZ", "107")],
    });
    const { data, err } = await scan();
    expect(data).toEqual([]);
    expect(err.join("\n")).toMatch(/\[basis-scan\] excluded XYZ hyperliquid↔pacifica: mark gap 6\.8% > 5%/);
  });

  it("is independent of funding: a market with a null rate is priced and compared", async () => {
    venuesReturn({
      hyperliquid: [mkt("hyperliquid", "ETH", "ETH", "2500", { fundingRate: null })],
      aster: [mkt("aster", "ETH", "ETH", "2501", { fundingRate: null })],
    });
    const { data } = await scan();
    expect(data.map((o) => o.symbol)).toEqual(["ETH"]);
  });

  it("is independent of funding: the FUNDING-extreme pair's price gap does not drop a group", async () => {
    // Funding extremes are hyperliquid (lowest) ↔ pacifica (highest), 6% apart in their funding-row
    // marks — the funding comparison drops that group; the price group itself agrees within 1%.
    venuesReturn(
      {
        hyperliquid: [mkt("hyperliquid", "SOL", "SOL", "100")],
        lighter: [mkt("lighter", "SOL", "SOL", "100.5")],
        pacifica: [mkt("pacifica", "SOL", "SOL", "100.8")],
      },
      {
        hyperliquid: [rate("hyperliquid", "SOL", "97", "-0.001")],
        lighter: [rate("lighter", "SOL", "100", "0")],
        pacifica: [rate("pacifica", "SOL", "103", "0.001")],
      },
    );
    const { data } = await scan();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ symbol: "SOL", buyOn: "hyperliquid", sellOn: "pacifica" });
  });

  it("venue scope = trading venues, funding-verified or not: QFEX and TxFlow in, market-data-only Variational out", async () => {
    const spies = venuesReturn({
      qfex: [mkt("qfex", "AAPL", "AAPL", "341.3")],
      ondo: [mkt("ondo", "AAPL", "AAPL", "341.1")],
      txflow: [mkt("txflow", "AAPL", "AAPL", "341.2")],
      variational: [mkt("variational", "AAPL", "AAPL", "341.0")],
    });
    const { data } = await scan();
    expect(Object.keys(data[0].prices).sort()).toEqual(["ondo", "qfex", "txflow"]);
    expect(spies.get("variational")).not.toHaveBeenCalled();
  });

  it("an unclassified ticker (canonical null) or a non-tradable market never pairs", async () => {
    venuesReturn({
      lighter: [mkt("lighter", "OIL", null, "94"), mkt("lighter", "TSLA", "TSLA", "250", { tradable: false })],
      aster: [mkt("aster", "OIL", null, "95"), mkt("aster", "TSLA", "TSLA", "251")],
    });
    expect((await scan()).data).toEqual([]);
  });

  it("covers every trading venue, not the former four", async () => {
    venuesReturn({
      ondo: [mkt("ondo", "AAPL", "AAPL", "341.1")],
      arcus: [mkt("arcus", "AAPL", "AAPL", "341.3")],
      "lighter-rh": [mkt("lighter-rh", "AAPL", "AAPL", "341.4")],
    });
    const { data } = await scan();
    expect(Object.keys(data[0].prices).sort()).toEqual(["arcus", "lighter-rh", "ondo"]);
  });

  it("--basis <symbol> filters by canonical symbol", async () => {
    venuesReturn({
      lighter: [mkt("lighter", "BTC", "BTC", "83000"), mkt("lighter", "ETH", "ETH", "2500")],
      aster: [mkt("aster", "BTC", "BTC", "83050"), mkt("aster", "ETH", "ETH", "2501")],
    });
    expect((await scan("0", "eth")).data.map((o) => o.symbol)).toEqual(["ETH"]);
  });

  it("a failed venue is reported on stderr, never silently absent", async () => {
    venuesReturn({ lighter: [mkt("lighter", "BTC", "BTC", "83000")] });
    const { err } = await scan();
    expect(err.some((e) => /\[basis-scan\] aster fetch failed: aster offline/.test(e))).toBe(true);
  });
});
