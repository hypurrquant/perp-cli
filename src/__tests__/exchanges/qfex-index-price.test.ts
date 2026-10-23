/**
 * QFEX indexPrice = /md/contracts `index_price` (was always null). Real /refdata, /md/contracts,
 * MDS market_stats and the MDS `underlier` channel captured 2026-10-19 ~11:31Z: the index tracks
 * the underlier and sits next to the mark, in the market's quote currency. /md/contracts failing
 * leaves indexPrice null — market listing never fails on it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));
const marketStats = vi.fn();
vi.mock("../../exchanges/qfex/ws-transport.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/qfex/ws-transport.js")>()),
  fetchQfexMarketStats: (...a: unknown[]) => marketStats(...a),
}));

import "../../exchanges/venues/index.js";
import { READ_ONLY_CREDENTIALS } from "../../exchanges/venue.js";
import { qfexVenue } from "../../exchanges/venues/qfex.js";
import { QfexAdapter } from "../../exchanges/qfex/adapter.js";
import { parseMarketStats } from "../../exchanges/qfex/ws-transport.js";

const FX = JSON.parse(readFileSync(new URL("../fixtures/qfex/index-price-2026-10-19T1131Z.json", import.meta.url), "utf8")) as {
  refdata: unknown; contracts: unknown; marketStats: Record<string, unknown>; underlier: Array<{ symbol: string; price: string }>;
};
let contractsOk: boolean;

function adapter(): QfexAdapter {
  return new QfexAdapter(qfexVenue, { network: "mainnet", credentials: READ_ONLY_CREDENTIALS, noAgent: false, hlDex: null, readOnly: true, noBuilder: false });
}

beforeEach(() => {
  contractsOk = true;
  marketStats.mockReset();
  marketStats.mockImplementation(async () => parseMarketStats(FX.marketStats));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    const body = path === "/refdata" ? FX.refdata : path === "/md/contracts" && contractsOk ? FX.contracts : undefined;
    if (body === undefined) return { ok: false, status: 503, headers: new Headers(), text: async () => "unavailable" };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  }));
});

describe("QFEX indexPrice", () => {
  it("is /md/contracts index_price: next to the MDS underlier and the mark, in the quote currency", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await adapter().getMarkets();
    const by = (s: string) => rows.find(m => m.symbol === s)!;
    expect(by("AAPL").indexPrice).toBe("342.47");
    expect(by("GOLD").indexPrice).toBe("4170.21999999");
    expect(by("SAMSUNG-KRW")).toMatchObject({ indexPrice: "220092.36054959", quoteAsset: "KRW" });
    for (const u of FX.underlier.filter(x => rows.some(m => m.symbol === x.symbol.replace(/-USD$/, "")))) {
      const m = by(u.symbol.replace(/-USD$/, ""));
      expect(Math.abs(Number(m.indexPrice) / Number(u.price) - 1)).toBeLessThan(0.001);
      expect(Math.abs(Number(m.indexPrice) / Number(m.markPrice) - 1)).toBeLessThan(0.01);
    }
  });

  it("/md/contracts down → indexPrice null (unknown), the listing still answers", async () => {
    contractsOk = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await adapter().getMarkets();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(m => m.indexPrice === null)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/index prices unavailable/));
  });
});
