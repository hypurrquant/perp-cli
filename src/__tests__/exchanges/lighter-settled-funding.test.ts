/**
 * Lighter / Lighter RH market rows carry the LAST SETTLED hourly rate, per 1 h, from the WS
 * `market_stats/all` snapshot (= the newest /fundings print, = the perp-ws `rate`); REST
 * /funding-rates (predicted × 8) is not read for market rows. Ambiguous tickers are listed as
 * "unclassified" (canonical null).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { sent, state } = vi.hoisted(() => ({ sent: [] as string[], state: { frames: [] as unknown[] } }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWs extends EventEmitter {
    constructor(readonly url: string) { super(); setTimeout(() => this.emit("open"), 0); }
    send(d: string) { sent.push(d); for (const f of state.frames) setTimeout(() => this.emit("message", JSON.stringify(f)), 0); }
    close() { /* closed */ }
  }
  return { default: FakeWs, WebSocket: FakeWs };
});

import "../../exchanges/venues/index.js";
import { fetchLighterFundingStats, lighterPublicData } from "../../exchanges/lighter-public.js";

afterEach(() => { vi.unstubAllGlobals(); sent.length = 0; });

const detail = (symbol: string, market_id: number) => ({
  symbol, market_id, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, min_base_amount: "0.001", min_quote_amount: "10",
  min_initial_margin_fraction: 200, mark_price: "100", index_price: "100", open_interest: 1, daily_quote_token_volume: 1,
});

describe("Lighter settled funding (market_stats snapshot)", () => {
  it("reads funding_rate / current_funding_rate (percent per 1 h) as fractions per 1 h, keyed by market_id", async () => {
    state.frames = [{ type: "connected" }, { type: "subscribed/market_stats", market_stats: { "0": { funding_rate: "0.0012", current_funding_rate: "0.0009" }, "1": { funding_rate: "-0.0004", current_funding_rate: null } } }];
    const m = await fetchLighterFundingStats("lighter", "testnet");
    expect(JSON.parse(sent[0])).toEqual({ type: "subscribe", channel: "market_stats/all" });
    expect(m.get(0)).toEqual({ rate: "0.000012", predictedRate: "0.000009" });
    expect(m.get(1)).toEqual({ rate: "-0.000004", predictedRate: null });
  });

  it("public directory: settled rate per 1 h, BB listed as unclassified (canonical null); funding rows per 1 h", async () => {
    state.frames = [{ market_stats: { "1": { funding_rate: "0.0012", current_funding_rate: "0.0009" }, "7": { funding_rate: "0.0001", current_funding_rate: "0.0001" } } }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ order_book_details: [detail("BTC", 1), detail("BB", 7)] }), { status: 200 })));
    const rows = await lighterPublicData("lighter-rh").fetchMarkets("mainnet");
    expect(rows.find(r => r.symbol === "BTC")).toMatchObject({ fundingRate: "0.000012", fundingRateBasis: { kind: "perHours", hours: 1 } });
    expect(rows.find(r => r.symbol === "BB")).toMatchObject({ assetClass: "unclassified", canonical: null });
    const rates = await lighterPublicData("lighter-rh").fetchFundingRates("mainnet");
    expect(rates.find(r => r.symbol === "BTC")).toMatchObject({ rate: "0.000012", basis: { kind: "perHours", hours: 1 }, markPrice: "100" });
  });
});
