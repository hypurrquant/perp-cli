/**
 * Pre-release QA sweep (0.15.0) — MCP market-data tools.
 *  1. get_prices: each row tags the venues in it that are read through an undocumented API
 *     (unofficialApiVenues), like get_markets' venueApi tag; a venue (QFEX) appears in every row
 *     whose symbol it lists. No registered venue is unofficial since TxFlow published its official
 *     API, so the tag is exercised by relabelling TxFlow for that test.
 *  2. get_funding_rates: includeUnverified (default false) mirrors the CLI
 *     `arb scan --include-unverified` — unverified venues (QFEX, TxFlow) only on request, tagged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, ToolHandler>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, h: ToolHandler) { tools.set(name, h); }
    resource() { /* not used */ }
    prompt() { /* not used */ }
    async connect() { /* no transport in tests */ }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../funding/history.js", () => ({ getHistoricalAverages: () => new Map() }));

import { listVenues } from "../exchanges/venue.js";
import type { VenueFundingRate, VenueId, VenueMarket } from "../exchanges/venue-types.js";

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { throw new Error(`unexpected network call: ${u}`); }));
  if (tools.size === 0) await import("../mcp-server.js");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text) as { ok: boolean; data: unknown; meta?: Record<string, unknown> };

const market = (venue: VenueId, symbol: string, mark: string) => ({ venue, symbol, venueSymbol: symbol, markPrice: mark } as unknown as VenueMarket);
const rate = (venue: VenueId, symbol: string, mark: string, r: string): VenueFundingRate => ({
  venue, venueSymbol: symbol, symbol, canonical: symbol, rate: r, basis: { kind: "perHours", hours: 1 }, markPrice: mark, nextFundingTime: null,
});

describe("get_prices", () => {
  it("tags unofficial-API venues per row; QFEX appears where it lists the symbol", async () => {
    const rows: Partial<Record<VenueId, VenueMarket[]>> = {
      hyperliquid: [market("hyperliquid", "BTC", "83000"), market("hyperliquid", "CL", "94.0")],
      qfex: [market("qfex", "CL", "94.01")],
      txflow: [market("txflow", "BTC", "82990"), market("txflow", "CL", "93.98")],
    };
    for (const v of listVenues()) vi.spyOn(v.publicData, "fetchMarkets").mockResolvedValue(rows[v.id] ?? []);
    const prices = async () => parse(await tools.get("get_prices")!({ symbols: ["BTC", "CL"] }));
    // TxFlow is an official API now: no row is tagged.
    expect((await prices()).data).toEqual([
      { symbol: "BTC", prices: { hyperliquid: 83000, txflow: 82990 }, unofficialApiVenues: [] },
      { symbol: "CL", prices: { hyperliquid: 94, qfex: 94.01, txflow: 93.98 }, unofficialApiVenues: [] },
    ]);
    const txflow = listVenues().find(v => v.id === "txflow")!;
    const saved = txflow.apiStatus;
    (txflow as { apiStatus: typeof saved }).apiStatus = { kind: "unofficial", note: "test", docs: null };
    try {
      const env = await prices();
      expect(env.ok).toBe(true);
      expect(env.data).toEqual([
        { symbol: "BTC", prices: { hyperliquid: 83000, txflow: 82990 }, unofficialApiVenues: ["txflow"] },
        { symbol: "CL", prices: { hyperliquid: 94, qfex: 94.01, txflow: 93.98 }, unofficialApiVenues: ["txflow"] },
      ]);
    } finally {
      (txflow as { apiStatus: typeof saved }).apiStatus = saved;
    }
  });

  it("a row with only official venues has an empty tag list", async () => {
    for (const v of listVenues()) vi.spyOn(v.publicData, "fetchMarkets").mockResolvedValue(v.id === "aster" ? [market("aster", "ETH", "2500")] : []);
    const env = parse(await tools.get("get_prices")!({}));
    expect(env.data).toEqual([{ symbol: "ETH", prices: { aster: 2500 }, unofficialApiVenues: [] }]);
  });
});

describe("get_funding_rates includeUnverified", () => {
  function venues() {
    const rows: Partial<Record<VenueId, VenueFundingRate[]>> = {
      hyperliquid: [rate("hyperliquid", "BTC", "83000", "0.00001")],
      aster: [rate("aster", "BTC", "83010", "0.00003")],
      txflow: [rate("txflow", "BTC", "82990", "0.002")],
    };
    const spies = new Map<VenueId, ReturnType<typeof vi.fn>>();
    for (const v of listVenues()) spies.set(v.id, vi.spyOn(v.publicData, "fetchFundingRates").mockResolvedValue(rows[v.id] ?? []) as never);
    return spies;
  }
  const venuesOf = (env: { data: unknown }) => (env.data as { symbols: Array<{ rates: Array<{ exchange: string; fundingVerified: boolean; apiStatus: string }> }> }).symbols
    .flatMap((s) => s.rates);

  it("default: unverified venues are not fetched", async () => {
    const spies = venues();
    const env = parse(await tools.get("get_funding_rates")!({ symbols: ["BTC"] }));
    expect(venuesOf(env).map((r) => r.exchange).sort()).toEqual(["aster", "hyperliquid"]);
    expect(spies.get("txflow")).not.toHaveBeenCalled();
    expect(spies.get("qfex")).not.toHaveBeenCalled();
  });

  it("includeUnverified: true adds them, tagged fundingVerified:false / apiStatus", async () => {
    venues();
    const env = parse(await tools.get("get_funding_rates")!({ symbols: ["BTC"], includeUnverified: true }));
    const tx = venuesOf(env).find((r) => r.exchange === "txflow");
    expect(tx).toMatchObject({ fundingVerified: false, apiStatus: "official" });
  });
});
