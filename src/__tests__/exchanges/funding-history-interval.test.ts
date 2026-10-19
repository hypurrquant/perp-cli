/**
 * QA 0.15.0: `market funding` rows on hyperliquid (incl. HIP-3), pacifica, lighter, lighter-rh,
 * aster, ondo, arcus, qfex and risex were only {time, rate, price}; grvt / extended already
 * labelled them. Every history row now carries `intervalHours` (hours one printed rate covers)
 * and `rateKind: "lastSettled"`. `market info` on hyperliquid / pacifica / lighter / lighter-rh
 * left `fundingHours` null although the interval is fixed by the venue definition.
 * Raw rows below are the venues' live answers (QA run 2026-10-19).
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { getVenue } from "../../exchanges/venue.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { ArcusAdapter } from "../../exchanges/arcus/adapter.js";
import { RisexAdapter } from "../../exchanges/risex/adapter.js";
import { LighterAdapter } from "../../exchanges/lighter.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";

const SETTLED_1H = { intervalHours: 1, rateKind: "lastSettled" };

function bare<T>(proto: T, fields: Record<string, unknown>): T {
  const a = Object.create(proto as object) as Record<string, unknown>;
  Object.assign(a, fields);
  return a as T;
}

describe("funding history rows carry intervalHours + rateKind", () => {
  it("hyperliquid (core and HIP-3): hourly, and -l above 24 widens the window", async () => {
    const a = new HyperliquidAdapter(undefined, false);
    const info = vi.fn(async () => [{ coin: "BTC", fundingRate: "0.0000125", premium: "0.0001", time: 1792371600050 }]);
    (a as unknown as { _infoPost: unknown })._infoPost = info;
    (a as unknown as { _assetMap: Map<string, number> })._assetMap.set("BTC", 0);
    const now = Date.now();
    const rows = await a.getFundingHistory("BTC", 48);
    expect(rows[0]).toEqual({ time: 1792371600050, rate: "0.0000125", price: null, ...SETTLED_1H });
    const startTime = (info.mock.calls[0] as unknown as [{ startTime: number }])[0].startTime;
    expect(now - startTime).toBeGreaterThanOrEqual(48 * 3_600_000);
  });

  it("ondo: hourly", async () => {
    const a = bare(OndoAdapter.prototype, { pairsCache: null, client: { publicGet: vi.fn(async (path: string) => path === "/v1/markets"
      ? { perps: { tradingPairs: [{ market: "BTC-USD.P" }] }, spot: { tradingPairs: [] } }
      : [{ market: "BTC-USD.P", time: "2026-10-19T10:00:00.017Z", fundingRate: "0.0000125" }]) } });
    expect((await a.getFundingHistory("BTC", 1))[0]).toMatchObject({ rate: "0.0000125", ...SETTLED_1H });
  });

  it("arcus: hourly", async () => {
    const a = bare(ArcusAdapter.prototype, {
      market: vi.fn(async () => ({ marketDisplayName: "BTC-USD" })),
      client: { get: vi.fn(async () => ({ fundingRates: [{ fundingRate: "0.000007703166719716", time: 1792404000000000 }] })) },
    });
    expect((await a.getFundingHistory("BTC", 1))[0]).toEqual({ time: 1792404000000, rate: "0.000007703166719716", price: null, ...SETTLED_1H });
  });

  it("risex: hourly", async () => {
    const a = bare(RisexAdapter.prototype, {
      market: vi.fn(async () => ({ market_id: 1 })),
      client: { get: vi.fn(async () => ({ records: [{ funding_rate: "-0.000007566719954101", end_time: "1792404000000000000", index_price: "82711.359932255203" }] })) },
    });
    expect((await a.getFundingHistory("BTC", 1))[0]).toEqual({ time: 1792404000000, rate: "-0.000007566719954101", price: "82711.359932255203", ...SETTLED_1H });
  });
});

describe("market info fundingHours from the venue definition", () => {
  it("hyperliquid: 1", async () => {
    const a = new HyperliquidAdapter(undefined, false);
    (a as unknown as { _infoPost: unknown })._infoPost = vi.fn(async (body: { type: string }) => {
      if (body.type === "metaAndAssetCtxs") return [{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 0 }], marginTables: [] }, [{ markPx: "82695.0", oraclePx: "82730.0", funding: "0.0000043461", dayNtlVlm: "1", openInterest: "1" }]];
      if (body.type === "allMids") return { BTC: "82695" };
      return [];
    });
    const m = (await a.getMarkets()).find(x => x.symbol.startsWith("BTC"));
    expect(m?.fundingHours).toBe(1);
  });

  it("pacifica: 1", async () => {
    const a = bare(PacificaAdapter.prototype, {
      client: { getInfo: vi.fn(async () => [{ symbol: "BTC", instrument_type: "perpetual", lot_size: "0.00001", max_leverage: 50, funding_rate: "0.0000125", next_funding_rate: "0.0000125" }]) },
      _getPrices: vi.fn(async () => [{ symbol: "BTC", mark: "82761", oracle: "82760", volume_24h: "1", open_interest: "1" }]),
    });
    expect((await a.getMarkets())[0].fundingHours).toBe(1);
  });

  it.each(["lighter", "lighter-rh"] as const)("%s: 8 (the /funding-rates value is per 8 h)", async (venue) => {
    const a = new LighterAdapter("0xabc", true, undefined, venue);
    const t = a as unknown as Record<string, unknown>;
    t.ensureMarketMap = async () => {};
    t.restGet = vi.fn(async () => ({ order_book_details: [{ symbol: "BTC", market_id: 1, market_type: "perp", mark_price: "82700", index_price: "82710", open_interest: 1, daily_quote_token_volume: 1, min_initial_margin_fraction: 200 }] }));
    t.getFundingRates = vi.fn(async () => new Map([["BTC", { rate: "0.000088", markPrice: null }]]));
    const [m] = await a.getMarkets();
    expect(m).toMatchObject({ fundingRate: "0.000088", fundingHours: 8 });
    expect(getVenue(venue).fundingRateBasis).toEqual({ kind: "perHours", hours: 8 });
  });
});
