/**
 * Ambiguous tickers (SPX6900 vs the S&P 500, Pacifica BP / CHIP, …) are LISTED by the public
 * directory — the same market set as `perp market list` — as assetClass "unclassified" with
 * canonical null, so they are never matched across venues (arb, funding comparison, spot-perp).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { canonicalFor } from "../../exchanges/canonical-symbols.js";
import { legacyPublicData } from "../../funding/legacy-public.js";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("unclassified (ambiguous) markets", () => {
  it("canonicalFor never gives an unclassified market a canonical", () => {
    expect(canonicalFor("hyperliquid", "SPX", "unclassified")).toBeNull();
    expect(canonicalFor("hyperliquid", "BTC", "crypto")).toBe("BTC");
  });

  it("hyperliquid public directory lists SPX (SPX6900) as unclassified, canonical null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "SPX", szDecimals: 1, maxLeverage: 10 }] },
      [{ markPx: "82000", oraclePx: "82010", funding: "0.0000125", openInterest: "1", dayNtlVlm: "1" }, { markPx: "1.2", oraclePx: "1.2", funding: "0.00001", openInterest: "1", dayNtlVlm: "1" }],
    ])));
    const rows = await legacyPublicData("hyperliquid").fetchMarkets("mainnet");
    expect(rows.map(r => r.symbol)).toEqual(["BTC", "SPX"]);
    expect(rows[1]).toMatchObject({ assetClass: "unclassified", canonical: null });
    expect(rows[0]).toMatchObject({ assetClass: "crypto", canonical: "BTC" });
  });

  it("pacifica public directory lists BP / CHIP as unclassified, canonical null", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => String(u).endsWith("/info/prices")
      ? json({ success: true, data: [{ symbol: "BTC", mark: "82000", oracle: "82000", funding: "0.00001", next_funding: "0.00002" }, { symbol: "BP", mark: "35", oracle: "35", funding: "0.00001", next_funding: "0.00001" }] })
      : json({ success: true, data: [{ symbol: "BTC", instrument_type: "perpetual", tick_size: "1", lot_size: "0.00001", max_leverage: 50 }, { symbol: "BP", instrument_type: "perpetual", tick_size: "0.01", lot_size: "0.1", max_leverage: 10 }] })));
    const rows = await legacyPublicData("pacifica").fetchMarkets("mainnet");
    expect(rows.find(r => r.symbol === "BP")).toMatchObject({ assetClass: "unclassified", canonical: null });
    // ...and never reaches the cross-venue funding comparison (canonical null rows are skipped there).
    const rates = await legacyPublicData("pacifica").fetchFundingRates("mainnet");
    expect(rates.find(r => r.symbol === "BP")?.canonical ?? null).toBeNull();
  });
});
