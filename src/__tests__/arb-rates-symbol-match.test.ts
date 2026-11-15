/**
 * Live 2026-11-04: `arb scan --rates --symbol XAU|kPEPE|US500` returned nothing (only the canonical
 * GOLD / 1000PEPE / SPX matched, while `--compare XAU` resolved the alias), the default top-symbol
 * entry "PEPE" matched no canonical row (Hyperliquid kPEPE / Lighter 1000PEPE are "1000PEPE"), and a
 * symbol named with --symbols that one venue quotes (BMT: Aster only) was dropped without a word.
 * The default scan (top symbols) still lists symbols quoted by two venues or more only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../exchanges/venues/index.js";
import { listVenuesWithRole, type VenueDefinition } from "../exchanges/venue.js";
import type { VenueFundingRate } from "../exchanges/venue-types.js";
import { handleRates } from "../commands/arb.js";

const row = (venue: string, symbol: string, canonical: string, rate: string): VenueFundingRate => ({
  venue: venue as VenueFundingRate["venue"], venueSymbol: symbol, symbol, canonical, rate,
  basis: { kind: "perHours", hours: 1 }, markPrice: "100", nextFundingTime: null,
});

const ROWS: Record<string, VenueFundingRate[]> = {
  hyperliquid: [row("hyperliquid", "BTC", "BTC", "0.00001"), row("hyperliquid", "kPEPE", "1000PEPE", "0.00002")],
  lighter: [row("lighter", "BTC", "BTC", "0.00003"), row("lighter", "1000PEPE", "1000PEPE", "0.00004")],
  aster: [row("aster", "BMT", "BMT", "0.00005"), row("aster", "MKR", "MKR", "0.00005")],
  ondo: [row("ondo", "XAU", "GOLD", "0.00001"), row("ondo", "US500", "SPX", "0.00001")],
  "lighter-rh": [row("lighter-rh", "XAU", "GOLD", "0.00002")],
  arcus: [row("arcus", "SPX", "SPX", "0.00003")],
};

function stubVenues(): void {
  for (const def of listVenuesWithRole("marketData") as VenueDefinition[]) {
    vi.spyOn(def.publicData, "fetchFundingRates").mockResolvedValue(ROWS[def.id] ?? []);
  }
}

async function ratesJson(opts: { symbol?: string; symbols?: string }): Promise<{ symbols: Array<{ symbol: string; rates: Array<{ exchange: string }>; longExchange: string | null }> }> {
  stubVenues();
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await handleRates(() => true, { ...opts, minSpread: "0" });
  return JSON.parse(out.join("\n")).data;
}

afterEach(() => vi.restoreAllMocks());

describe("arb scan --rates symbol matching", () => {
  it.each([["XAU", "GOLD"], ["kPEPE", "1000PEPE"], ["US500", "SPX"]])("--symbol %s selects the canonical row %s", async (asked, canonical) => {
    const d = await ratesJson({ symbol: asked });
    expect(d.symbols.map(s => s.symbol)).toEqual([canonical]);
  });

  it("the default top symbols include the 1000PEPE row (Hyperliquid kPEPE / Lighter 1000PEPE)", async () => {
    const d = await ratesJson({});
    expect(d.symbols.map(s => s.symbol)).toContain("1000PEPE");
  });

  it("a symbol named with --symbols that one venue quotes is a display-only row (no ranked pair), not dropped", async () => {
    const d = await ratesJson({ symbols: "BTC,BMT" });
    expect(d.symbols.map(s => s.symbol)).toEqual(["BTC", "BMT"]);
    expect(d.symbols[1]).toMatchObject({ rates: [expect.objectContaining({ exchange: "aster" })], longExchange: null });
  });

  it("the default scan (top symbols) leaves out a top symbol one venue quotes (MKR: Aster only)", async () => {
    const d = await ratesJson({});
    expect(d.symbols.map(s => s.symbol)).not.toContain("MKR");
  });
});
