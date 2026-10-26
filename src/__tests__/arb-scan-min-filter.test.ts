/**
 * Dogfood 0.15.1: `arb scan --rates` with `--min` (default 10) silently dropped every pair below
 * the threshold. The threshold and the hidden count are now in the `--json` meta and data
 * (`minSpread`, `belowMinSpread`), and the human table says "N pairs below --min X% hidden".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../funding-history.js", async (orig) => ({
  ...(await orig<typeof import("../funding-history.js")>()),
  saveFundingSnapshot: vi.fn(),
  getHistoricalRates: vi.fn(() => []),
  getHistoricalAverages: vi.fn(() => new Map()),
}));

import "../exchanges/venues/index.js";
import { listVenuesWithRole, type VenueDefinition } from "../exchanges/venue.js";
import type { VenueFundingRate } from "../exchanges/venue-types.js";
import { handleRates } from "../commands/arb.js";

const row = (venue: string, canonical: string, rate: string): VenueFundingRate => ({
  venue: venue as VenueFundingRate["venue"], venueSymbol: canonical, symbol: canonical, canonical, rate,
  basis: { kind: "perHours", hours: 1 }, markPrice: "100", nextFundingTime: null,
});

function stubVenues(rows: Record<string, VenueFundingRate[]>): void {
  for (const def of listVenuesWithRole("marketData") as VenueDefinition[]) {
    vi.spyOn(def.publicData, "fetchFundingRates").mockResolvedValue(rows[def.id] ?? []);
  }
}

// BTC: 0.00002/h spread ≈ 17.5 %/yr (shown at --min 10); ETH / SOL: ≈ 0.9 %/yr (hidden).
const ROWS = {
  hyperliquid: [row("hyperliquid", "BTC", "0.00001"), row("hyperliquid", "ETH", "0.00001"), row("hyperliquid", "SOL", "0.00001")],
  lighter: [row("lighter", "BTC", "0.00003"), row("lighter", "ETH", "0.000011"), row("lighter", "SOL", "0.000011")],
};

function capture(): string[] {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("arb scan --rates --min: hidden pairs are reported", () => {
  it("--json: meta and data carry minSpread and belowMinSpread", async () => {
    stubVenues(ROWS);
    const out = capture();
    await handleRates(() => true, { symbols: "BTC,ETH,SOL", minSpread: "10" });
    const env = JSON.parse(out.join("\n"));
    expect(env.data.symbols.map((s: { symbol: string }) => s.symbol)).toEqual(["BTC"]);
    expect(env.meta).toMatchObject({ minSpread: 10, belowMinSpread: 2 });
    expect(env.data).toMatchObject({ minSpread: 10, belowMinSpread: 2 });
  });

  it("--min 0 hides nothing (belowMinSpread 0)", async () => {
    stubVenues(ROWS);
    const out = capture();
    await handleRates(() => true, { symbols: "BTC,ETH,SOL", minSpread: "0" });
    const env = JSON.parse(out.join("\n"));
    expect(env.data.symbols).toHaveLength(3);
    expect(env.meta).toMatchObject({ minSpread: 0, belowMinSpread: 0 });
  });

  it("human: a hint names the hidden count and the threshold", async () => {
    stubVenues(ROWS);
    const out = capture();
    await handleRates(() => false, { symbols: "BTC,ETH,SOL", minSpread: "10" });
    expect(out.join("\n")).toMatch(/2 pairs below --min 10% hidden \(show them: --min 0\)/);
  });
});
