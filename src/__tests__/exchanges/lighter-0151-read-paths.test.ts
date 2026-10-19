/**
 * 0.15.1 Lighter / Lighter RH read-path regressions, on recorded live answers
 * (src/__tests__/fixtures/lighter/*-live.json, 2026-10-19):
 *  - market kline honours --start (count_back = bars in the window, rows filtered, 500-bar paging, `r` checked)
 *  - market book: orders aggregated into price levels (REST = WS order_book levels), limit 250
 *  - market list / prices / info: inactive markets excluded; CLI and WS list the same set
 *  - typed errors: unsupported interval, trades limit, spot book read failure
 *  - WS open_interest: USD, one side; WS last "0" → null
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LighterAdapter, LIGHTER_CANDLES_PER_CALL } from "../../exchanges/lighter.js";
import { LighterSpotAdapter } from "../../exchanges/lighter-spot.js";
import { lighterBook, lighterBookLevels } from "../../exchanges/lighter-public.js";
import { lighter, lighterRh } from "../../ws/codecs/lighter.js";
import type { CodecContext, MarketPatch } from "../../ws/types.js";
import { fakeFetch } from "../ws/helpers.js";

const FIX = resolve(import.meta.dirname, "../fixtures/lighter");
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIX, name), "utf8")) as T;

type Candle = { t: number } & Record<string, unknown>;
type CandleAnswer = { code: number; r: string; c: Candle[] };
const CANDLES = load<{ pages: CandleAnswer[]; legacyCountBack100: { request: { start_timestamp: number; end_timestamp: number; count_back: number }; response: CandleAnswer } }>("candles-btc-1h-live.json");
const BOOK = load<{ trump: { ws: { order_book: { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> } }; rest250: { bids: unknown[]; asks: unknown[] } }; btc: { rest250: { bids: Array<{ price: string; remaining_base_amount: string }>; asks: unknown[] } } }>("book-live.json");
const MARKETS = load<Record<"lighter" | "lighter-rh", { orderBooks: { order_books: Array<Record<string, unknown>> }; orderBookDetails: { order_book_details: Array<Record<string, unknown>> } }>>("markets-live.json");

const H = 3_600_000;
afterEach(() => vi.restoreAllMocks());

/** Every recorded 1h bar (two consecutive live 500-bar answers), oldest first. */
const SERIES: Candle[] = [...CANDLES.pages[1].c, ...CANDLES.pages[0].c];

/**
 * The venue's /candles rule (probed live): max(count_back, bars in window) newest bars opening before
 * end_timestamp (exclusive, whole seconds) and from start_timestamp (inclusive), ≤ 500.
 */
function venueCandles(start: number, end: number, countBack: number): CandleAnswer {
  const upToEnd = SERIES.filter((c) => c.t < Math.floor(end / 1000) * 1000);
  const inWindow = upToEnd.filter((c) => c.t >= start).length;
  return { code: 200, r: "1h", c: upToEnd.slice(-Math.min(LIGHTER_CANDLES_PER_CALL, Math.max(countBack, inWindow))) };
}

function adapter(venue: "lighter" | "lighter-rh" = "lighter", testnet = false): LighterAdapter {
  const a = LighterAdapter.forVenue(venue, "0xabc", testnet);
  (a as unknown as { _marketMap: Map<string, number> })._marketMap = new Map([["BTC", 1]]);
  return a;
}

describe("Lighter market kline: the [start, end] window", () => {
  it("the recorded 0.15.0 request (count_back 100, 24-bar window) answers 77 bars before start", () => {
    const { request, response } = CANDLES.legacyCountBack100;
    expect(response.c).toHaveLength(100);
    expect(response.c.filter((c) => c.t < request.start_timestamp)).toHaveLength(77);
    // The simulator reproduces the recorded answer.
    expect(venueCandles(request.start_timestamp, request.end_timestamp, 100).c.map((c) => c.t)).toEqual(response.c.map((c) => c.t));
  });

  for (const [venue, testnet] of [["lighter", false], ["lighter-rh", false], ["lighter", true]] as const) {
    it(`${venue}${testnet ? " testnet" : ""}: a 24-bar window returns exactly those 24 bars`, async () => {
      const a = adapter(venue, testnet);
      const get = vi.fn(async (_s: string, _r: string, s: number, e: number, cb: number) => venueCandles(s, e, cb));
      (a as unknown as { getCandles: typeof get }).getCandles = get;
      const end = SERIES.at(-1)!.t;
      const start = end - 23 * H;
      const k = await a.getKlines("BTC", "1h", start, end);
      expect(k).toHaveLength(24);
      expect(k[0].time).toBe(start);
      expect(k.at(-1)?.time).toBe(end);
      expect(get.mock.calls[0][4]).toBe(24);
    });
  }

  it("a 700-bar window pages backwards in 500-bar chunks by moving end_timestamp", async () => {
    const a = adapter();
    const get = vi.fn(async (_s: string, _r: string, s: number, e: number, cb: number) => venueCandles(s, e, cb));
    (a as unknown as { getCandles: typeof get }).getCandles = get;
    const end = SERIES.at(-1)!.t;
    const start = end - 699 * H;
    const k = await a.getKlines("BTC", "1h", start, end);
    expect(k).toHaveLength(700);
    expect(k.map((x) => x.time)).toEqual(SERIES.slice(-700).map((c) => c.t));
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][4]).toBe(500);
    expect(get.mock.calls[0][3]).toBe(end + 1000); // inclusive --end
    expect(get.mock.calls[1][3]).toBe(SERIES.at(-500)!.t);
    expect(get.mock.calls[1][4]).toBe(200);
  });

  it("a window after the newest bar returns no bars (the venue answers past bars)", async () => {
    const a = adapter();
    (a as unknown as { getCandles: unknown }).getCandles = async (_s: string, _r: string, s: number, e: number, cb: number) => venueCandles(s, e, cb);
    const last = SERIES.at(-1)!.t;
    await expect(a.getKlines("BTC", "1h", last + H, last + 9 * H)).resolves.toEqual([]);
  });

  it("an answer labelled with another resolution is EXCHANGE_ERROR", async () => {
    const a = adapter();
    (a as unknown as { getCandles: unknown }).getCandles = async () => ({ ...CANDLES.pages[0], r: "1m" });
    await expect(a.getKlines("BTC", "1h", SERIES[0].t, SERIES.at(-1)!.t)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("unsupported intervals (3m 2h 8h 1w 1M; venue code 20001) and over-long windows are INVALID_PARAMS before any request", async () => {
    for (const venue of ["lighter", "lighter-rh"] as const) {
      const a = adapter(venue);
      const get = vi.fn();
      (a as unknown as { getCandles: unknown }).getCandles = get;
      for (const iv of ["3m", "2h", "8h", "1w", "1M", "2m", "6h"]) {
        await expect(a.getKlines("BTC", iv, 0, H)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
      }
      await expect(a.getKlines("BTC", "1m", 0, 5001 * 60_000)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
      expect(get).not.toHaveBeenCalled();
    }
  });
});

describe("Lighter market book: price levels, not orders", () => {
  it("BTC: orders at one price are summed into one level (live: 250 asks → fewer distinct prices)", async () => {
    const a = adapter();
    const rest = vi.fn(async () => BOOK.btc.rest250);
    (a as unknown as { restGet: unknown; ensureMarketMap: unknown }).restGet = rest;
    (a as unknown as { ensureMarketMap: unknown }).ensureMarketMap = async () => {};
    const book = await a.getOrderbook("BTC");
    expect(rest.mock.calls[0]).toEqual(["/orderBookOrders", { market_id: "1", limit: "250" }]);
    const prices = book.bids.map(([p]) => p);
    expect(new Set(prices).size).toBe(prices.length);
    expect(new Set(BOOK.btc.rest250.bids.map((o) => o.price)).size).toBeLessThan(BOOK.btc.rest250.bids.length);
    // Each level is the exact sum of its orders (the last, possibly partial, level is dropped).
    const [p0, s0] = book.bids[0];
    const want = BOOK.btc.rest250.bids.filter((o) => o.price === p0).reduce((s, o) => s + Number(o.remaining_base_amount), 0);
    expect(Number(s0)).toBeCloseTo(want, 9);
  });

  it("REST levels equal the WS order_book levels recorded at the same moment (TRUMP)", () => {
    const ws = (side: Array<{ price: string; size: string }>) => side.filter((l) => Number(l.size) > 0).map((l) => [l.price, Number(l.size)]);
    const rest = (side: unknown[]) => lighterBookLevels("lighter", side, "x").map(([p, s]) => [p, Number(s)]);
    expect(rest(BOOK.trump.rest250.bids)).toEqual(ws(BOOK.trump.ws.order_book.bids));
    expect(rest(BOOK.trump.rest250.asks)).toEqual(ws(BOOK.trump.ws.order_book.asks));
  });
});

describe("Lighter market book --depth (250-order page, no paging)", () => {
  const orders = (n: number, levels: number) => Array.from({ length: n }, (_, i) => ({ price: String(100 - (i % levels)), remaining_base_amount: "1" }));
  it("cuts each side to depth", () => {
    const b = lighterBook("lighter", { bids: orders(10, 10), asks: orders(10, 10) }, "BTC", 5);
    expect(b.bids).toHaveLength(5);
    expect(b.asks).toHaveLength(5);
  });
  it("a full 250-order side aggregating to fewer levels than depth → INVALID_PARAMS naming the 250-order cap", () => {
    expect(() => lighterBook("lighter", { bids: orders(250, 30), asks: orders(5, 5) }, "BTC", 50)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS", message: expect.stringContaining("250 orders") }) }));
  });
  it("a short (not full) side is the whole book: fewer levels than depth is returned as is", () => {
    expect(lighterBook("lighter", { bids: orders(5, 5), asks: [] }, "BTC", 50).bids).toHaveLength(5);
  });
});

describe("Lighter market list: live markets only, the same set as the WS directory", () => {
  for (const venue of ["lighter", "lighter-rh"] as const) {
    it(`${venue}: getMarkets drops inactive markets; WS loadDirectory lists the same symbols`, async () => {
      const a = adapter(venue);
      const rec = MARKETS[venue];
      (a as unknown as { ensureMarketMap: unknown }).ensureMarketMap = async () => {};
      (a as unknown as { restGet: unknown }).restGet = async () => rec.orderBookDetails;
      (a as unknown as { getFundingRates: unknown }).getFundingRates = async () => new Map();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const cli = (await a.getMarkets()).map((m) => m.symbol).sort();
      const inactive = rec.orderBookDetails.order_book_details.filter((d) => d.market_type === "perp" && d.status !== "active").map((d) => d.symbol);
      for (const s of inactive) expect(cli).not.toContain(s);

      const codec = venue === "lighter" ? lighter : lighterRh;
      const restUrl = venue === "lighter" ? "https://mainnet.zklighter.elliot.ai" : "https://api.rh.lighter.xyz";
      const ctx: CodecContext = { network: "mainnet", fetch: fakeFetch({ [`GET ${restUrl}/api/v1/orderBooks`]: rec.orderBooks }), restUrl, hip3Dexes: [], canonicalize: (_v, x) => x.base, clock: () => 0 };
      const dir = await codec.loadDirectory(ctx);
      expect(dir.entries.map((e) => e.symbol).sort()).toEqual(cli);
    });
  }

  it("lighter (recorded): 239 detail perps / 235 orderBooks perps → 213 live on both; MYX RESOLV MKR DOLO are inactive", () => {
    const rec = MARKETS.lighter;
    const det = rec.orderBookDetails.order_book_details.filter((d) => d.market_type === "perp");
    const obs = rec.orderBooks.order_books.filter((d) => d.market_type === "perp");
    expect([det.length, obs.length]).toEqual([239, 235]);
    const onlyDetails = det.filter((d) => !obs.some((o) => o.market_id === d.market_id));
    expect(onlyDetails.map((d) => [d.symbol, d.status]).sort()).toEqual([["DOLO", "inactive"], ["MKR", "inactive"], ["MYX", "inactive"], ["RESOLV", "inactive"]]);
  });
});

describe("Lighter typed errors", () => {
  it("trades --limit outside 1..100 (venue: 101 / 0 → code 20001) is INVALID_PARAMS naming the max", async () => {
    const a = adapter();
    const rest = vi.fn();
    (a as unknown as { restGet: unknown }).restGet = rest;
    for (const l of [101, 0, Number.NaN, 2.5]) {
      await expect(a.getRecentTrades("BTC", l)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS", message: expect.stringMatching(/1\.\.100/) }) });
    }
    expect(rest).not.toHaveBeenCalled();
  });

  it("spot orderbook: a failed read throws (never an empty book); orders → levels", async () => {
    const s = Object.create(LighterSpotAdapter.prototype) as LighterSpotAdapter;
    Object.assign(s as object, {
      name: "lighter", init: async () => {}, resolveSymbol: (x: string) => x, _spotMarketMap: new Map([["ETH/USDC", 2048]]),
      _restGet: async () => { throw new Error("GET /orderBookOrders failed (503): upstream"); },
    });
    await expect(s.getSpotOrderbook("ETH/USDC")).rejects.toThrow(/503/);
    await expect(s.getSpotOrderbook("NOPE/USDC")).rejects.toMatchObject({ structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }) });
    Object.assign(s as object, { _restGet: async () => BOOK.btc.rest250 });
    const book = await s.getSpotOrderbook("ETH/USDC");
    expect(new Set(book.bids.map(([p]) => p)).size).toBe(book.bids.length);
  });
});

describe("Lighter WS market_stats", () => {
  it("open_interest is USD, one side — inferred (WS / mark = REST base; the daily exchangeMetrics snapshot read ≈ 2×)", () => {
    expect(lighter.openInterest).toEqual({ unit: "usd", sides: "one" });
    expect(lighterRh.openInterest).toEqual({ unit: "usd", sides: "one" });
    // Live 2026-10-19 BTC: WS 174,882,654.75 USD / mark 82,387.1 = 2,122.69 BTC ≈ REST 2,128.84 (seconds apart);
    // GET /exchangeMetrics?kind=open_interest&filter=byMarket&value=BTC: 336,585,268.97 USD — a daily snapshot
    // (2026-10-18 00:00 UTC) compared with the current one-side value, so ≈ 2× is an inference, not a venue statement.
    expect(174_882_654.751273 / 82_387.1 / 2_128.83729).toBeCloseTo(1, 2);
    expect(336_585_268.97 / (2_128.83729 * 82_329.9)).toBeGreaterThan(1.8);
  });

  it('last_trade_price "0.000" (market without trades, live GME / BE / USDHKD) → last null', async () => {
    const frame = {
      type: "subscribed/market_stats", channel: "market_stats:all", timestamp: 1792400000000,
      market_stats: {
        176: { symbol: "GME", market_id: 176, index_price: "26.774", mark_price: "26.774", best_ask_price: "", best_bid_price: "", open_interest: "0.000000", last_trade_price: "0.000", current_funding_rate: "0.0000", funding_rate: "0.0000", daily_quote_token_volume: 0 },
        1: { symbol: "BTC", market_id: 1, index_price: "82400.1", mark_price: "82387.1", best_ask_price: "82388.0", best_bid_price: "82387.9", open_interest: "174882654.751273", last_trade_price: "82387.9", current_funding_rate: "0.0012", funding_rate: "0.0012", daily_quote_token_volume: 1 },
      },
    };
    const dir = { entries: [], data: { idToSymbol: new Map([["176", "GME"], ["1", "BTC"]]), nonPerp: new Set<string>(), symbolToId: new Map() } };
    const [ev] = lighter.decode(JSON.stringify(frame), dir as never, 1792400000000);
    const patches = (ev as { patches: MarketPatch[] }).patches;
    expect(patches.find((p) => p.symbol === "GME")?.last).toBeNull();
    expect(patches.find((p) => p.symbol === "BTC")?.last).toBe("82387.9");
  });
});

describe("Lighter public data (MCP get_markets): live markets only", () => {
  it("lighter: fetchMarkets drops the recorded inactive markets (was 239 rows incl. 26 inactive)", async () => {
    const { lighterPublicData } = await import("../../exchanges/lighter-public.js");
    const rec = MARKETS.lighter;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.endsWith("/orderBookDetails") ? rec.orderBookDetails : { code: 200, funding_rates: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() };
    }));
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = await lighterPublicData("lighter").fetchMarkets("mainnet");
    const inactive = new Set(rec.orderBookDetails.order_book_details.filter((d) => d.market_type === "perp" && d.status !== "active").map((d) => d.symbol));
    expect(inactive.size).toBe(26);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(213);
    expect(rows.filter((m) => inactive.has(m.symbol))).toEqual([]);
    expect(rows.every((m) => m.tradable)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("Lighter orders on an inactive market (still in the market map for reads and closes)", () => {
  function trader() {
    const a = LighterAdapter.forVenue("lighter", "0xabc", false);
    const o = a as unknown as Record<string, unknown>;
    // The recorded orderBooks rows of SPACEX (inactive) and BTC (active), through the market-map refresh.
    const rows = MARKETS.lighter.orderBooks.order_books.filter((d) => d.symbol === "SPACEX" || d.symbol === "BTC");
    expect(rows.find((d) => d.symbol === "SPACEX")?.status).toBe("inactive");
    o.restGet = async () => ({ code: 200, order_books: rows });
    o.ensureSigner = () => {};
    o.getNextNonce = async () => 7;
    const sign = vi.fn(async () => { throw new Error("signed (test stops here)"); });
    o.signOrder = sign;
    return { a, sign };
  }
  async function loaded() {
    const t = trader();
    const { invalidateCache } = await import("../../cache.js");
    invalidateCache("mkt");
    await (t.a as unknown as { _refreshMarketMap(): Promise<void> })._refreshMarketMap();
    return t;
  }

  it("a non-reduce-only limit / stop order is refused before signing (ORDER_REJECTED, marketInactive)", async () => {
    const { a, sign } = await loaded();
    await expect(a.limitOrder("SPACEX", "buy", "100", "1", { reduceOnly: false })).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "ORDER_REJECTED", message: expect.stringMatching(/SPACEX is inactive/), details: expect.objectContaining({ marketInactive: true }) }),
    });
    await expect(a.stopOrder("SPACEX", "buy", "1", "100", { limitPrice: "101", reduceOnly: false })).rejects.toMatchObject({ structured: expect.objectContaining({ code: "ORDER_REJECTED" }) });
    expect(sign).not.toHaveBeenCalled();
  });

  it("a reduce-only order on the inactive market is still signed; the active market is unaffected", async () => {
    const { a, sign } = await loaded();
    await expect(a.limitOrder("SPACEX", "sell", "100", "1", { reduceOnly: true })).rejects.toThrow(/signed \(test stops here\)/);
    expect(sign).toHaveBeenCalledTimes(1);
    expect((sign.mock.calls[0] as unknown[])[0]).toMatchObject({ reduceOnly: 1 });
    await expect(a.limitOrder("BTC", "buy", "100", "0.001", { reduceOnly: false })).rejects.toThrow(/signed \(test stops here\)/);
    expect(sign).toHaveBeenCalledTimes(2);
  });
});

describe("Lighter kline paging guards", () => {
  it("count_back is the exact number of bar opens in the window and never 0", async () => {
    const a = adapter();
    const get = vi.fn(async (_s: string, _r: string, s: number, e: number, cb: number) => venueCandles(s, e, cb));
    (a as unknown as { getCandles: typeof get }).getCandles = get;
    const t = SERIES.at(-1)!.t;
    // [t − 30 min, t + 30 min] holds one bar open (t), not floor(60 min / 1 h) + 1 = 2.
    await expect(a.getKlines("BTC", "1h", t - H / 2, t + H / 2)).resolves.toHaveLength(1);
    expect(get.mock.calls[0][4]).toBe(1);
    // No bar opens inside [t + 1 min, t + 59 min]: nothing is requested.
    (a as unknown as { ensureMarketMap: unknown }).ensureMarketMap = async () => {};
    await expect(a.getKlines("BTC", "1h", t + 60_000, t + 59 * 60_000)).resolves.toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("a page that does not move backwards is EXCHANGE_ERROR (no endless / silent paging)", async () => {
    const a = adapter();
    (a as unknown as { getCandles: unknown }).getCandles = async () => CANDLES.pages[0]; // always the same 500 bars
    await expect(a.getKlines("BTC", "1h", SERIES[0].t, SERIES.at(-1)!.t)).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "EXCHANGE_ERROR", message: expect.stringMatching(/no progress/) }),
    });
  });
});
