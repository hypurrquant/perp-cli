/**
 * perp-cli/ws codecs (plan ws-0.14.4 Phase 1): every recorded Phase 0 fixture decodes through a fake
 * transport; rate kinds, units and nullability are pinned per venue.
 */
import { describe, expect, it } from "vitest";
import { createVenueStream } from "../../ws/stream.js";
import { hyperliquid } from "../../ws/codecs/hyperliquid.js";
import { pacifica } from "../../ws/codecs/pacifica.js";
import { lighter, lighterRh } from "../../ws/codecs/lighter.js";
import { aster } from "../../ws/codecs/aster.js";
import { arcus } from "../../ws/codecs/arcus.js";
import type { MarketUpdate, StreamControl, VenueCodec, VenueStreamOptions } from "../../ws/types.js";
import {
  ARCUS_ROUTES, ASTER_ROUTES, HL_ROUTES, LIGHTER_RH_ROUTES, LIGHTER_ROUTES, PACIFICA_ROUTES,
  fakeFetch, fakeTransport, fixtureFrames, flush,
} from "./helpers.js";

async function run(codec: VenueCodec, routes: Record<string, unknown>, frames: unknown[], opts: VenueStreamOptions = {}, target: { kind: "allMarkets"; symbols?: string[] } = { kind: "allMarkets" }) {
  const t = fakeTransport();
  const stream = createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null, ...opts });
  const sub = stream.subscribe(target);
  const events: Array<MarketUpdate | StreamControl> = [];
  sub.on(e => events.push(e as MarketUpdate | StreamControl));
  await flush(30);
  const ws = t.last();
  ws.open();
  for (const f of frames) ws.message(f);
  const markets = events.filter((e): e is MarketUpdate => e.type === "market");
  const errors = events.filter((e): e is Extract<StreamControl, { type: "error" }> => e.type === "error");
  const last = (symbol: string) => markets.filter(m => m.symbol === symbol).at(-1);
  return { stream, sub, ws, events, markets, errors, last };
}

const NO_FIELD_IS_ZERO_PLACEHOLDER = (u: MarketUpdate) => {
  // Every Dec is a string or null — never a number placeholder.
  for (const v of [u.mark, u.index, u.bestBid, u.bestAsk, u.last, u.funding.rate, u.funding.predictedRate, u.openInterest.value, u.volume24hNotional]) {
    expect(v === null || typeof v === "string").toBe(true);
  }
};

describe("hyperliquid codec", () => {
  it("allDexsAssetCtxs: one wire sub, positional mapping per dex, filtered by hip3Dexes", async () => {
    const r = await run(hyperliquid, HL_ROUTES, fixtureFrames("hyperliquid", "allDexsAssetCtxs"), { hip3Dexes: ["xyz"] });
    expect(r.ws.sentJson()).toEqual([{ method: "subscribe", subscription: { type: "allDexsAssetCtxs" } }]);
    expect(r.errors).toEqual([]);
    const btc = r.markets.find(m => m.symbol === "BTC")!; // first frame
    expect(btc).toMatchObject({
      venue: "hyperliquid", dex: null, symbol: "BTC", quote: "USDC", canonical: "BTC", mark: "83238.0", index: "83280.0",
      bestBid: null, bestAsk: null, last: null, volume24hNotional: "3107616136.9192795753",
      openInterest: { value: "38255.44852", unit: "base", sides: "one" },
    });
    expect(btc.funding).toMatchObject({
      rate: "0.0000031342", rateKind: "accruing", rateIntervalHours: 1, settlementIntervalHours: 1,
      intervalSource: "venue-definition", predictedRate: null,
    });
    expect(btc.funding.nextFundingTime! % 3_600_000).toBe(0);
    expect(r.markets.find(m => m.symbol === "xyz:TSLA")).toMatchObject({ dex: "xyz", canonical: "xyz:TSLA", mark: "373.85" });
    // abcd not selected; delisted MATIC is not a market.
    expect(r.markets.some(m => m.dex === "abcd" || m.symbol === "MATIC")).toBe(false);
    // first frame after subscribe = snapshot, then ws
    expect(r.markets[0].source).toBe("snapshot");
    expect(r.markets.at(-1)!.source).toBe("ws");
    r.markets.forEach(NO_FIELD_IS_ZERO_PLACEHOLDER);
  });

  it("rejects a ctx length mismatch per dex (WS_PROTOCOL_ERROR, never mis-assigned)", async () => {
    const frame = structuredClone(fixtureFrames("hyperliquid", "allDexsAssetCtxs")[0]) as { data: { ctxs: [string, unknown[]][] } };
    frame.data.ctxs[0][1].pop();
    const r = await run(hyperliquid, HL_ROUTES, [frame]);
    expect(r.markets.filter(m => m.dex === null)).toEqual([]);
    expect(r.errors[0]).toMatchObject({ code: "WS_PROTOCOL_ERROR", fatal: false });
    expect(r.errors[0].message).toMatch(/dex "" has 5 ctxs but the directory has 6/);
  });

  it("activeAssetCtx (kind market) and control frames classify", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null, hip3Dexes: ["xyz"] });
    const sub = stream.subscribe({ kind: "market", symbol: "xyz:XYZ100", channels: ["market"] });
    const ev: Array<{ type: string }> = [];
    sub.on(e => ev.push(e));
    await flush(30);
    t.last().open();
    expect(t.last().sentJson()).toEqual([{ method: "subscribe", subscription: { type: "activeAssetCtx", coin: "xyz:XYZ100" } }]);
    for (const f of fixtureFrames("hyperliquid", "activeAssetCtx")) t.last().message(f);
    const [ack, , pong] = fixtureFrames("hyperliquid", "control");
    t.last().message(ack);
    t.last().message(pong);
    const markets = ev.filter(e => e.type === "market") as MarketUpdate[];
    expect(markets.map(m => m.symbol)).toEqual(["xyz:XYZ100", "xyz:XYZ100"]); // BTC frames are another wire's symbol filter
    expect(markets[0].funding.rate).toBe("0.00000625");
    expect(ev.filter(e => e.type === "error")).toEqual([]);
    // the error frame for an unknown subscription TYPE is surfaced
    t.last().message(fixtureFrames("hyperliquid", "control")[3]);
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "WS_PROTOCOL_ERROR" });
    await expect(sub.ready).resolves.toBeUndefined();
  });

  it("unknown HIP-3 dex → INVALID_PARAMS before any socket opens", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null, hip3Dexes: ["nope"] });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await expect(sub.ready).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(t.sockets).toHaveLength(0);
  });
});

describe("pacifica codec", () => {
  it("prices: lastSettled rate + predicted next_funding, OI base, mark/oracle", async () => {
    const r = await run(pacifica, PACIFICA_ROUTES, [...fixtureFrames("pacifica", "control").slice(0, 1), ...fixtureFrames("pacifica", "prices"), fixtureFrames("pacifica", "control")[2]]);
    expect(r.ws.sentJson()).toEqual([{ method: "subscribe", params: { source: "prices" } }]);
    expect(r.errors).toEqual([]);
    const btc = r.markets.find(m => m.symbol === "BTC")!;
    expect(btc).toMatchObject({
      quote: "USDC", canonical: "BTC", mark: "83238.731962", index: "83281.383863", bestBid: null, last: null,
      openInterest: { value: "493.94911", unit: "base" }, volume24hNotional: "485331489.28508", venueTs: 1791900006320,
    });
    expect(btc.funding).toMatchObject({ rate: "0.00000429", rateKind: "lastSettled", predictedRate: "0.00000325", rateIntervalHours: 1, nextFundingTime: null });
    await expect(r.sub.ready).resolves.toBeUndefined();
  });

  it("allMarkets{symbols} emits only the listed markets", async () => {
    const r = await run(pacifica, PACIFICA_ROUTES, fixtureFrames("pacifica", "prices"), {}, { kind: "allMarkets", symbols: ["ETH"] });
    expect(new Set(r.markets.map(m => m.symbol))).toEqual(new Set(["ETH"]));
  });

  it("an unknown symbol → INVALID_PARAMS before subscribing (the venue would ack silently)", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets", symbols: ["BTC", "NOPE"] });
    await expect(sub.ready).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(t.sockets).toHaveLength(0);
  });
});

describe("lighter / lighter-rh codec", () => {
  it("market_stats/all: percent/h → fraction/h by exact shift, OI usd, partial updates merge per market", async () => {
    const r = await run(lighter, LIGHTER_ROUTES, [fixtureFrames("lighter", "control")[0], ...fixtureFrames("lighter", "market_stats-all"), fixtureFrames("lighter", "control")[1]]);
    expect(r.ws.sentJson()).toEqual([{ type: "subscribe", channel: "market_stats/all" }]);
    expect(r.errors).toEqual([]);
    const eth = r.markets.find(m => m.symbol === "ETH")!;
    expect(eth.funding).toMatchObject({
      rate: "0.000002", rateKind: "lastSettled", predictedRate: "0.000002",
      rateIntervalHours: 1, settlementIntervalHours: 1, intervalSource: "venue-definition",
    });
    expect(eth).toMatchObject({ bestBid: "2502.05", bestAsk: "2502.23", last: "2502.23", openInterest: { value: "73458849.714250", unit: "usd" } });
    expect(r.markets.find(m => m.symbol === "BTC")!.funding.rate).toBe("-0.000001");
    expect(eth.volume24hNotional).toBe(String(444635492.772674));
    expect(r.markets.some(m => m.symbol === "NATGAS")).toBe(true);
  });

  it("lighter-rh: separate directory, USDG quote, same units", async () => {
    const r = await run(lighterRh, LIGHTER_RH_ROUTES, fixtureFrames("lighter-rh", "market_stats-all"));
    expect(r.errors).toEqual([]);
    const btc = r.markets.find(m => m.symbol === "BTC")!;
    expect(btc).toMatchObject({ venue: "lighter-rh", quote: "USDG", canonical: "BTC" });
    expect(btc.funding).toMatchObject({ rate: "0.000001", predictedRate: "-0.000004" });
    expect(r.ws.url).toBe("wss://api.rh.lighter.xyz/stream");
  });

  it("lighter-rh testnet → CAPABILITY_UNSUPPORTED (WS answers 403)", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(lighterRh, { transport: t.factory, fetch: fakeFetch({}), visibility: null, network: "testnet" });
    await expect(stream.subscribe({ kind: "allMarkets" }).ready).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(lighterRh.capabilities.networks.testnet).toBe(false);
  });

  it("error frames without a channel: 30005 → INVALID_PARAMS, 20001 → WS_AUTH_FAILED, connected ignored", async () => {
    const [, , , e20001, , e30005] = fixtureFrames("lighter", "control");
    const r = await run(lighter, LIGHTER_ROUTES, [e20001, e30005]);
    expect(r.errors.map(e => e.code)).toEqual(["WS_AUTH_FAILED", "INVALID_PARAMS"]);
    expect(r.errors.every(e => e.fatal === false)).toBe(true); // not attributable to a subscribed wire
  });

  it('empty book side ("") → null, not a protocol error', async () => {
    const frame = structuredClone(fixtureFrames("lighter", "market_stats-all")[0]) as { market_stats: Record<string, Record<string, unknown>> };
    frame.market_stats["158"].best_bid_price = "";
    frame.market_stats["158"].best_ask_price = "";
    const r = await run(lighter, LIGHTER_ROUTES, [frame]);
    expect(r.errors).toEqual([]);
    expect(r.markets.find(m => m.symbol === "NATGAS")).toMatchObject({ bestBid: null, bestAsk: null });
  });
});

describe("aster codec", () => {
  it("markPrice@arr + ticker@arr: accruing r, labelled REST interval (missing → null), all quotes", async () => {
    const r = await run(aster, ASTER_ROUTES, [
      { id: 1, result: null }, { id: 2, result: null },
      ...fixtureFrames("aster", "markPrice-arr"), ...fixtureFrames("aster", "ticker-arr"),
    ]);
    expect(r.ws.url).toBe("wss://fstream.asterdex.com/stream");
    expect(r.ws.sentJson()).toEqual([
      { method: "SUBSCRIBE", params: ["!markPrice@arr@1s"], id: 1 },
      { method: "SUBSCRIBE", params: ["!ticker@arr"], id: 2 },
    ]);
    expect(r.errors).toEqual([]);
    await expect(r.sub.ready).resolves.toBeUndefined();
    const btc = r.last("BTCUSDT")!;
    expect(btc).toMatchObject({ quote: "USDT", canonical: "BTC", last: "83232.1", volume24hNotional: "576558912.67", openInterest: { value: null, unit: null } });
    expect(btc.funding).toMatchObject({
      rateKind: "accruing", rateIntervalHours: 8, settlementIntervalHours: 8, intervalSource: "rest:/fapi/v3/fundingInfo",
      predictedRate: null, nextFundingTime: 1791907200000,
    });
    expect(typeof btc.asOf.fundingInterval).toBe("number");
    expect(r.last("BTCUSD1")).toMatchObject({ quote: "USD1", canonical: null }); // second BTC listing: never matched (asterMatchable)
    const eth = r.last("ETHUSDT")!;
    expect(eth.funding).toMatchObject({ rateIntervalHours: null, intervalSource: null });
    // PYTHUSDT is unlisted (premiumIndex only) → skipped by rule, not an error
    expect(r.markets.some(m => m.symbol === "PYTHUSDT")).toBe(false);
  });
});

describe("arcus codec", () => {
  it("markets: lastSettled + predicted, nextFundingAt seconds → ms, OI base one side, notional volume", async () => {
    const control = fixtureFrames("arcus", "control");
    const r = await run(arcus, ARCUS_ROUTES, [control[0], ...fixtureFrames("arcus", "markets"), control[1]]);
    expect(r.ws.sentJson()).toEqual([{ type: "subscribe", channel: "markets" }]);
    expect(r.errors).toEqual([]);
    const btc = r.markets.find(m => m.symbol === "BTC-USD")!;
    expect(btc).toMatchObject({
      quote: "USD", canonical: "BTC", mark: "83151.7", index: "83172.8", last: "83151.6",
      openInterest: { value: "212.92154961", unit: "base", sides: "one" }, volume24hNotional: "165105302.82", venueTs: null,
    });
    expect(btc.funding).toMatchObject({ rate: "0.0000125", rateKind: "lastSettled", predictedRate: "0.0000125", nextFundingTime: 1791903600000 });
    // the venue error frame (no channel) is surfaced
    r.ws.message(control[2]);
    expect(r.events.at(-1)).toMatchObject({ type: "error", code: "WS_PROTOCOL_ERROR" });
  });
});

describe("null rules", () => {
  it("a field never sent is null; a field the latest frame did not carry keeps its last value + asOf", async () => {
    let now = 1_000;
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, clock: () => now });
    const ev: MarketUpdate[] = [];
    stream.subscribe({ kind: "allMarkets" }).on(e => { if (e.type === "market") ev.push(e); });
    await flush(30);
    t.last().open();
    t.last().message({ channel: "prices", data: [{ symbol: "BTC", mark: "1", timestamp: 5 }] });
    expect(ev[0]).toMatchObject({ mark: "1", index: null, funding: { rate: null, predictedRate: null }, openInterest: { value: null }, volume24hNotional: null });
    expect(ev[0].asOf).toEqual({ mark: 1_000 });
    now = 2_000;
    t.last().message({ channel: "prices", data: [{ symbol: "BTC", funding: "0.1", timestamp: 6 }] });
    expect(ev[1]).toMatchObject({ mark: "1", funding: { rate: "0.1" } });
    expect(ev[1].asOf).toEqual({ mark: 1_000, rate: 2_000 });
    expect(ev[1].changed).toEqual(["rate"]);
    // explicit JSON null → null; a garbage value → WS_PROTOCOL_ERROR and the last value stays
    const errs: unknown[] = [];
    stream.subscribe({ kind: "allMarkets" }).on(e => { if (e.type === "error") errs.push(e); });
    await flush(30);
    t.last().message({ channel: "prices", data: [{ symbol: "BTC", mark: { bogus: 1 }, funding: null }] });
    expect(ev.at(-1)).toMatchObject({ mark: "1", funding: { rate: null } });
    expect(errs).toHaveLength(1);
  });

  it("every fixture frame across venues is classified (no unrecognised frames)", async () => {
    const cases: Array<[VenueCodec, Record<string, unknown>, string, string[]]> = [
      [hyperliquid, HL_ROUTES, "hyperliquid", ["allDexsAssetCtxs", "activeAssetCtx"]],
      [pacifica, PACIFICA_ROUTES, "pacifica", ["prices", "control"]],
      [lighter, LIGHTER_ROUTES, "lighter", ["market_stats-all"]],
      [lighterRh, LIGHTER_RH_ROUTES, "lighter-rh", ["market_stats-all"]],
      [aster, ASTER_ROUTES, "aster", ["markPrice-arr", "ticker-arr", "control"]],
      [arcus, ARCUS_ROUTES, "arcus", ["markets"]],
    ];
    for (const [codec, routes, venue, names] of cases) {
      const frames = names.flatMap(n => fixtureFrames(venue, n));
      const r = await run(codec, routes, frames, { hip3Dexes: ["xyz"] });
      expect(r.errors.map(e => e.message), venue).toEqual([]);
    }
  });

  it("a malformed frame → WS_PROTOCOL_ERROR with a ≤200-char excerpt (never dropped)", async () => {
    const r = await run(arcus, ARCUS_ROUTES, ["{not json" + "x".repeat(500), { type: "surprise" }]);
    expect(r.errors.map(e => e.code)).toEqual(["WS_PROTOCOL_ERROR", "WS_PROTOCOL_ERROR"]);
    expect(r.errors[0].raw!.length).toBeLessThanOrEqual(200);
  });
});
