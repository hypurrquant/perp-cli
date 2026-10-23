/**
 * kind:"allMarkets" with `canonicals` (blind dogfood round 3): one subscription works across venues
 * whose directory symbols differ (aster BTCUSDT / BTCUSD1, arcus BTC-USD, lighter-rh USDG, HIP-3
 * "<dex>:<BASE>"). Canonicals a venue does not list → one non-fatal SYMBOL_NOT_FOUND control (details:
 * missing + suggestions), the rest subscribed; none listed, or mixed filters → INVALID_PARAMS.
 */
import { describe, expect, it } from "vitest";
import { createVenueStream } from "../../ws/stream.js";
import { hyperliquid } from "../../ws/codecs/hyperliquid.js";
import { lighterRh } from "../../ws/codecs/lighter.js";
import { aster } from "../../ws/codecs/aster.js";
import { arcus } from "../../ws/codecs/arcus.js";
import type { AllMarketsTarget, MarketUpdate, StreamControl, VenueCodec, VenueStreamOptions } from "../../ws/types.js";
import type { WsError } from "../../ws/errors.js";
import { ARCUS_ROUTES, ASTER_ROUTES, HL_ROUTES, LIGHTER_RH_ROUTES, fakeFetch, fakeTransport, fixtureFrames, flush } from "./helpers.js";

async function run(codec: VenueCodec, routes: Record<string, unknown>, frames: unknown[], target: AllMarketsTarget, opts: VenueStreamOptions = {}) {
  const t = fakeTransport();
  const stream = createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null, ...opts });
  const sub = stream.subscribe(target);
  const events: Array<MarketUpdate | StreamControl> = [];
  sub.on(e => events.push(e as MarketUpdate | StreamControl));
  await flush(30);
  const ws = t.last();
  ws.open();
  for (const f of frames) ws.message(f);
  const symbols = new Set(events.filter((e): e is MarketUpdate => e.type === "market").map(m => m.symbol));
  const errors = events.filter((e): e is Extract<StreamControl, { type: "error" }> => e.type === "error");
  return { stream, sub, t, symbols, errors };
}

const ASTER_FRAMES = [{ id: 1, result: null }, { id: 2, result: null }, ...fixtureFrames("aster", "markPrice-arr"), ...fixtureFrames("aster", "ticker-arr")];

describe("allMarkets canonicals", () => {
  it("aster: BTC → the one matchable listing (BTCUSDT); BTCUSD1 is not a second BTC leg (canonical null, the CLI rule)", async () => {
    const r = await run(aster, ASTER_ROUTES, ASTER_FRAMES, { kind: "allMarkets", canonicals: ["BTC"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTCUSDT"]));
  });

  it("arcus: BTC → BTC-USD", async () => {
    const control = fixtureFrames("arcus", "control");
    const r = await run(arcus, ARCUS_ROUTES, [control[0], ...fixtureFrames("arcus", "markets"), control[1]], { kind: "allMarkets", canonicals: ["BTC", "ETH"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTC-USD", "ETH-USD"]));
  });

  it("lighter-rh: USDG quote collapses → BTC", async () => {
    const r = await run(lighterRh, LIGHTER_RH_ROUTES, fixtureFrames("lighter-rh", "market_stats-all"), { kind: "allMarkets", canonicals: ["BTC"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTC"]));
  });

  it("hyperliquid: native BTC and HIP-3 \"xyz:TSLA\" (dex prefix rule; BTC does not pull in HIP-3 markets)", async () => {
    const r = await run(hyperliquid, HL_ROUTES, fixtureFrames("hyperliquid", "allDexsAssetCtxs"),
      { kind: "allMarkets", canonicals: ["BTC", "xyz:TSLA"] }, { hip3Dexes: ["xyz"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTC", "xyz:TSLA"]));
  });

  it("same wire subscription as a plain allMarkets (ref-counted, one subscribe sent)", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(aster, { transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null });
    stream.subscribe({ kind: "allMarkets" });
    stream.subscribe({ kind: "allMarkets", canonicals: ["BTC"] });
    await flush(30);
    t.last().open();
    expect(t.sockets).toHaveLength(1);
    expect(t.last().sentJson()).toEqual([
      { method: "SUBSCRIBE", params: ["!markPrice@arr@1s"], id: 1 },
      { method: "SUBSCRIBE", params: ["!ticker@arr"], id: 2 },
    ]);
  });
});

describe("allMarkets canonicals: partial match", () => {
  it("some canonicals missing → active, one non-fatal SYMBOL_NOT_FOUND listing them (with suggestions)", async () => {
    const control = fixtureFrames("arcus", "control");
    const r = await run(arcus, ARCUS_ROUTES, [control[0], ...fixtureFrames("arcus", "markets"), control[1]], { kind: "allMarkets", canonicals: ["BTC", "SOL", "eth"] });
    await expect(r.sub.ready).resolves.toBeUndefined();
    expect(r.symbols).toEqual(new Set(["BTC-USD"]));
    expect(r.errors).toEqual([{
      type: "error", venue: "arcus", code: "SYMBOL_NOT_FOUND", fatal: false, raw: null,
      message: "arcus: no market with canonical(s) SOL, eth (did you mean ETH for eth?); subscribed to the other 1",
      remediation: expect.stringContaining("MarketDirectoryEntry.canonical"),
      details: { missing: ["SOL", "eth"], suggestions: { SOL: [], eth: ["ETH"] } },
    }]);
  });

  it("hyperliquid: \"TSLA\" is not \"xyz:TSLA\" (HIP-3 prefix still required) → warning suggests it, BTC subscribed", async () => {
    const r = await run(hyperliquid, HL_ROUTES, fixtureFrames("hyperliquid", "allDexsAssetCtxs"),
      { kind: "allMarkets", canonicals: ["BTC", "TSLA"] }, { hip3Dexes: ["xyz"] });
    await expect(r.sub.ready).resolves.toBeUndefined();
    expect(r.symbols).toEqual(new Set(["BTC"]));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: "SYMBOL_NOT_FOUND", fatal: false, details: { missing: ["TSLA"], suggestions: { TSLA: ["xyz:TSLA"] } } });
  });

  it("the warning reaches the async iterator too, before the market events", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(aster, { transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets", canonicals: ["BTC", "NOPE"] });
    await flush(30);
    t.last().open();
    for (const f of ASTER_FRAMES) t.last().message(f);
    const it = sub[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toMatchObject({ type: "error", code: "SYMBOL_NOT_FOUND", fatal: false, details: { missing: ["NOPE"] } });
    await stream.close();
  });
});

describe("allMarkets canonicals: warning delivery", () => {
  it("the one-time SYMBOL_NOT_FOUND warning survives the pre-iterator ring (many state events before the iterator)", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(aster, {
      transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null,
      buffer: { size: 3 }, reconnect: { maxAttempts: null, baseMs: 1, maxMs: 2 },
    });
    const sub = stream.subscribe({ kind: "allMarkets", canonicals: ["BTC", "NOPE"] });
    await flush(30);
    for (let i = 0; i < 6; i++) { // each cycle: live → reconnecting → connecting (state controls)
      t.last().open();
      t.last().serverClose(1006);
      await new Promise(r => setTimeout(r, 10));
    }
    const it = sub[Symbol.asyncIterator]();
    const seen: StreamControl[] = [];
    for (let i = 0; i < 3; i++) seen.push((await it.next()).value as StreamControl);
    expect(seen[0]).toMatchObject({ type: "error", code: "STREAM_OVERFLOW", fatal: false }); // older state events were discarded
    expect(seen).toContainEqual(expect.objectContaining({ type: "error", code: "SYMBOL_NOT_FOUND", details: expect.objectContaining({ missing: ["NOPE"] }) }));
    await stream.close();
  });

  it("the canonicals-missing log is written only after the budget checks pass", async () => {
    const logs: string[] = [];
    const t = fakeTransport();
    const stream = createVenueStream(aster, {
      transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null,
      budget: { maxSubscriptions: 1 }, logger: (l) => logs.push(l.event),
    });
    const err = await stream.subscribe({ kind: "allMarkets", canonicals: ["BTC", "NOPE"] }).ready.then(() => null, (e: unknown) => e as WsError);
    expect(err?.structured.code).toBe("SUBSCRIPTION_LIMIT"); // aster allMarkets needs 2 wire subscriptions
    expect(logs).not.toContain("canonicals-missing");
    const ok = createVenueStream(aster, { transport: fakeTransport().factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null, logger: (l) => logs.push(l.event) });
    ok.subscribe({ kind: "allMarkets", canonicals: ["BTC", "NOPE"] });
    await flush(30);
    expect(logs.filter(e => e === "canonicals-missing")).toHaveLength(1);
    await ok.close();
  });
});

describe("allMarkets canonicals: errors", () => {
  async function reject(codec: VenueCodec, routes: Record<string, unknown>, target: AllMarketsTarget, opts: VenueStreamOptions = {}) {
    const t = fakeTransport();
    const stream = createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null, ...opts });
    const err = await stream.subscribe(target).ready.then(() => null, (e: unknown) => e as WsError);
    return { err, t };
  }

  it("none of the canonicals on this venue → INVALID_PARAMS before anything is sent", async () => {
    const { err, t } = await reject(arcus, ARCUS_ROUTES, { kind: "allMarkets", canonicals: ["DOGE", "PEPE"] });
    expect(err?.structured).toMatchObject({ code: "INVALID_PARAMS", message: "arcus: no market with canonical(s) DOGE, PEPE" });
    expect(t.sockets).toHaveLength(0);
  });

  it.each([
    ["case", aster, ASTER_ROUTES, "btc", ["BTC"], {}],
    ["HIP-3 base without the dex prefix", hyperliquid, HL_ROUTES, "TSLA", ["xyz:TSLA"], { hip3Dexes: ["xyz"] }],
  ] as Array<[string, VenueCodec, Record<string, unknown>, string, string[], VenueStreamOptions]>)("%s, nothing else matching → rejected with did-you-mean suggestions", async (_n, codec, routes, c, want, opts) => {
    const { err } = await reject(codec, routes, { kind: "allMarkets", canonicals: [c] }, opts);
    expect(err?.structured.code).toBe("INVALID_PARAMS");
    expect(err?.message).toContain(`did you mean ${want.join(" / ")} for ${c}`);
    expect(err?.structured.details).toEqual({ suggestions: { [c]: want } });
  });

  it.each([
    ["symbols and canonicals together", { kind: "allMarkets", symbols: ["BTCUSDT"], canonicals: ["BTC"] }, "not both"],
    ["empty canonicals", { kind: "allMarkets", canonicals: [] }, "non-empty array"],
    ["canonicals not strings", { kind: "allMarkets", canonicals: [1] }, "non-empty array"],
  ])("%s → INVALID_PARAMS", async (_n, target, text) => {
    const { err, t } = await reject(aster, ASTER_ROUTES, target as AllMarketsTarget);
    expect(err?.structured.code).toBe("INVALID_PARAMS");
    expect(err?.message).toContain(text);
    expect(t.sockets).toHaveLength(0);
  });
});

describe("defaultCanonicalize: the CLI's never-match rule (UNCLASSIFIED_TICKERS)", () => {
  it("ambiguous native tickers are canonical null on their venue; a HIP-3 dex key and other tickers are kept", async () => {
    const { defaultCanonicalize } = await import("../../ws/canonical.js");
    const c = (venue: Parameters<typeof defaultCanonicalize>[0], base: string, dex: string | null = null) => defaultCanonicalize(venue, { venueSymbol: base, dex, base, quote: "USDC" });
    expect(c("hyperliquid", "SPX")).toBeNull();
    expect(c("lighter", "BB")).toBeNull();
    expect(c("pacifica", "CHIP")).toBeNull();
    expect(c("lighter-rh", "USELESS")).toBeNull();
    expect(c("lighter-rh", "TSLA")).toBe("TSLA");
    expect(c("hyperliquid", "BTC")).toBe("BTC");
    expect(c("hyperliquid", "SPX", "xyz")).toBe("xyz:SPX");
  });
});
