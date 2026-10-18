/**
 * GRVT (market data only in this version, official API): parsing of recorded mainnet responses
 * (src/__tests__/fixtures/grvt, 2026-10-19), funding semantics and units (percent per the market's
 * own 4 h / 8 h interval → exact fraction; indicative vs settled), null handling, symbol mapping,
 * error mapping, rate-limit sizing, health inclusion, and the write-refusal table (every write path
 * refuses with CAPABILITY_UNSUPPORTED and the GRVT remediation, with zero network calls).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenue, resolveVenueId, requireCapabilities } from "../../exchanges/venue.js";
import { GrvtClient } from "../../exchanges/grvt/client.js";
import {
  clearGrvtCaches, fetchGrvtFundingRates, fetchGrvtMarkets, grvtPercentToFraction, grvtPublicData, resolveGrvtMarket, toGrvtLeverage,
  toGrvtMarketMeta, toGrvtTicker, GRVT_SHORT_TTL_MS, type GrvtMarketMeta,
} from "../../exchanges/grvt/public.js";
import { startJob } from "../../jobs.js";
import { GrvtPublicAdapter } from "../../exchanges/grvt/adapter.js";
import { GRVT_OTHER_RATE_LIMIT, GRVT_READ_ONLY_REMEDIATION, GRVT_TICKER_RATE_LIMIT } from "../../exchanges/venues/grvt.js";
import { probeVenueHealth } from "../../venue-health.js";
import { buildProgram } from "../../cli-program.js";
import { parseVenueList, resolveSetupVenue } from "../../commands/init.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "grvt");
const fx = <T = unknown>(name: string): T => JSON.parse(readFileSync(resolve(FIX, name), "utf-8")) as T;

const INSTRUMENTS = fx<{ result: Record<string, unknown>[] }>("instruments.json");
const TICKERS = fx<Record<string, { result: Record<string, unknown> }>>("tickers.json");
const MARGIN_BTC = fx<Record<string, unknown>>("margin-rules-btc.json");

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Routes POST /full/v1/<endpoint> to the recorded fixtures. */
function routeFixtures(overrides: { ticker?: (instrument: string) => unknown; tickerStatus?: (instrument: string) => number | null; kline?: (body: Record<string, unknown>) => unknown } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const endpoint = url.split("/full/v1/")[1];
    const body = JSON.parse(String(init?.body ?? "{}")) as { instrument?: string };
    switch (endpoint) {
      case "instruments": return jsonResponse(200, INSTRUMENTS);
      case "ticker": {
        const status = overrides.tickerStatus?.(body.instrument!) ?? null;
        if (status !== null) return jsonResponse(status, { code: status === 429 ? 1006 : 1002, message: "fail", status });
        const t = overrides.ticker?.(body.instrument!) ?? TICKERS[body.instrument!];
        return t === undefined ? jsonResponse(400, { code: 1003, message: "Request could not be processed due to malformed syntax", status: 400 }) : jsonResponse(200, t);
      }
      case "margin_rules": return jsonResponse(200, body.instrument === "BTC_USDT_Perp" ? MARGIN_BTC : { instrument: body.instrument, risk_brackets: [] });
      case "book": return jsonResponse(200, fx("book-btc.json"));
      case "trade": return jsonResponse(200, fx("trades-btc.json"));
      case "funding": return jsonResponse(200, fx(body.instrument === "SAMSUNG_USDT_Perp" ? "funding-samsung.json" : "funding-btc.json"));
      case "kline": return jsonResponse(200, overrides.kline?.(body as Record<string, unknown>) ?? fx("kline-btc-1h.json"));
      default: throw new Error(`unexpected endpoint ${endpoint}`);
    }
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearGrvtCaches();
  fetchMock = vi.fn(async (url: string) => { throw new Error(`unexpected network call: ${url}`); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const metas = (): GrvtMarketMeta[] => INSTRUMENTS.result.map(r => toGrvtMarketMeta(r, () => undefined)).filter((m): m is GrvtMarketMeta => m !== null);
const bySymbol = <T extends { symbol: string }>(rows: T[], s: string): T => {
  const hit = rows.find(r => r.symbol === s);
  if (hit === undefined) throw new Error(`no ${s}`);
  return hit;
};

describe("GRVT venue definition", () => {
  it("is market-data only, official API, unverified per-market funding, alias grv, testnet available", () => {
    const def = getVenue("grvt");
    expect(resolveVenueId("grv")).toBe("grvt");
    expect(def.roles).toEqual(["marketData"]);
    expect(def.capabilities).toBeNull();
    expect(def.apiStatus).toEqual({ kind: "official" });
    expect(def.fundingVerified).toBe(false);
    expect(def.fundingRateBasis).toBe("perMarket");
    expect(def.settlementIntervalHours).toBe("perMarket");
    expect(def.networks.mainnet.restUrl).toBe("https://market-data.grvt.io");
    expect(def.networks.testnet?.restUrl).toBe("https://market-data.testnet.grvt.io");
    expect(def.restrictedRegions).toEqual(expect.arrayContaining(["US", "CA", "SG", "HK"]));
  });

  it("requireCapabilities refuses with the GRVT read-only remediation", () => {
    try {
      requireCapabilities(getVenue("grvt"));
      throw new Error("not refused");
    } catch (e) {
      expect(e).toBeInstanceOf(PerpError);
      expect((e as PerpError).structured).toMatchObject({ code: "CAPABILITY_UNSUPPORTED", remediation: GRVT_READ_ONLY_REMEDIATION });
    }
    expect(GRVT_READ_ONLY_REMEDIATION).toBe("GRVT is read-only (market data) in this version; trading is planned for a later release");
  });

  it("rate-limit buckets never exceed the documented per-minute limits in any 60 s window", () => {
    // help.grvt.io: Ticker / MiniTicker / GetInstrument 1500 / min, all others 500 / min.
    expect(GRVT_TICKER_RATE_LIMIT.capacity + 60 * GRVT_TICKER_RATE_LIMIT.refillPerSec).toBeLessThanOrEqual(1500);
    expect(GRVT_OTHER_RATE_LIMIT.capacity + 60 * GRVT_OTHER_RATE_LIMIT.refillPerSec).toBeLessThanOrEqual(500);
    expect(getVenue("grvt").rateLimit).toBe(GRVT_OTHER_RATE_LIMIT);
  });
});

describe("instruments → directory (recorded fixture)", () => {
  it("maps base ticker, instrument name, tick / min size / notional, per-market interval", () => {
    const dir = metas();
    expect(dir.map(m => m.symbol)).toEqual(["AAPL", "BTC", "ETH", "KPEPE", "NATGAS", "OPENAI", "SAMSUNG", "SPY", "XAU"]);
    expect(bySymbol(dir, "BTC")).toEqual({
      instrument: "BTC_USDT_Perp", symbol: "BTC", quote: "USDT", tickSize: "0.1", minSize: "0.001", minNotional: "100.0",
      fundingIntervalHours: 8, assetClass: "crypto", canonical: "BTC", tradable: true,
    });
    expect(bySymbol(dir, "XAU").fundingIntervalHours).toBe(4);
    expect(bySymbol(dir, "SAMSUNG").fundingIntervalHours).toBe(4);
  });

  it("symbol mapping: crypto aliases, equities / ETFs by ticker, commodities explicit, pre-IPO never matched", () => {
    const dir = metas();
    const of = (s: string) => ({ cls: bySymbol(dir, s).assetClass, canonical: bySymbol(dir, s).canonical });
    expect(of("KPEPE")).toEqual({ cls: "crypto", canonical: "1000PEPE" });
    expect(of("AAPL")).toEqual({ cls: "equity", canonical: "AAPL" });
    expect(of("SAMSUNG")).toEqual({ cls: "equity", canonical: "SAMSUNG" });
    expect(of("SPY")).toEqual({ cls: "etf", canonical: "SPY" });
    expect(of("XAU")).toEqual({ cls: "commodity", canonical: "GOLD" });
    expect(of("NATGAS")).toEqual({ cls: "commodity", canonical: null });
    expect(of("OPENAI")).toEqual({ cls: "preIpo", canonical: null });
  });

  it("non-perpetual rows are skipped; an unknown asset_class is warned and skipped; drift is EXCHANGE_ERROR", () => {
    const btc = INSTRUMENTS.result.find(r => r.instrument === "BTC_USDT_Perp")!;
    expect(toGrvtMarketMeta({ ...btc, kind: "FUTURE" }, () => undefined)).toBeNull();
    expect(toGrvtMarketMeta({ ...btc, kind: "STABLE_PERP" }, () => undefined)).toBeNull();
    const warn = vi.fn();
    expect(toGrvtMarketMeta({ ...btc, asset_class: "FX" }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown asset_class"));
    for (const bad of [{ tick_size: undefined }, { min_size: "0" }, { funding_interval_hours: undefined }, { funding_interval_hours: 0 }, { base: "" }]) {
      expect(() => toGrvtMarketMeta({ ...btc, ...bad }, () => undefined)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
    }
    expect(toGrvtMarketMeta({ ...btc, status: "HALTED" }, () => undefined)?.tradable).toBe(false);
  });

  it("resolves CLI symbols; unknown → SYMBOL_NOT_FOUND via unknown-symbol.ts", () => {
    const dir = metas();
    for (const s of ["btc", "BTC", "BTC-PERP", "BTC_USDT_Perp", "btc-usdt", "BTC/USDT"]) expect(resolveGrvtMarket(dir, s).instrument).toBe("BTC_USDT_Perp");
    expect(() => resolveGrvtMarket(dir, "NOPE")).toThrow(expect.objectContaining({
      structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", remediation: "List markets: perp -e grvt market list" }),
    }));
  });
});

describe("funding semantics and units", () => {
  it("percent → fraction, exact (no float maths)", () => {
    expect(grvtPercentToFraction("0.0062")).toBe("0.000062");
    expect(grvtPercentToFraction("-0.0195")).toBe("-0.000195");
    expect(grvtPercentToFraction("0.01")).toBe("0.0001");
    expect(grvtPercentToFraction("0.0")).toBe("0");
    expect(grvtPercentToFraction(null)).toBeNull();
  });

  it("ticker funding is the indicative rate per the market's interval; settled history uses the same percent unit", () => {
    const t = toGrvtTicker(TICKERS.BTC_USDT_Perp.result);
    expect(t.fundingPct).toBe("0.0062");
    expect(t.nextFundingTime).toBe(1_792_368_000_000);
    // Settled BTC prints (percentage points) are the same order of magnitude as the ticker value —
    // the evidence for percent (the ticker schema's "centibeeps" would be 100× smaller).
    const settled = fx<{ result: Array<{ funding_rate: string; funding_interval_hours: number; funding_time: string }> }>("funding-btc.json").result;
    expect(settled.map(r => r.funding_rate)).toEqual(["0.01", "0.0075", "0.01", "0.0062", "0.0024"]);
    expect(settled.every(r => r.funding_interval_hours === 8)).toBe(true);
    // next_funding_time − last settlement = the instrument's 8 h interval.
    expect((BigInt(TICKERS.BTC_USDT_Perp.result.next_funding_time as string) - BigInt(settled[0].funding_time)) / 3_600_000_000_000n).toBe(8n);
  });

  it("fetchGrvtFundingRates: fraction per interval with a per-market basis (8 h / 4 h)", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const rows = await fetchGrvtFundingRates("mainnet", { warn: () => undefined });
    expect(rows).toHaveLength(9);
    expect(bySymbol(rows, "BTC")).toEqual({
      venue: "grvt", venueSymbol: "BTC_USDT_Perp", symbol: "BTC", canonical: "BTC", rate: "0.000062",
      basis: { kind: "perHours", hours: 8 }, markPrice: "81129.562093259", nextFundingTime: 1_792_368_000_000,
    });
    expect(bySymbol(rows, "XAU").basis).toEqual({ kind: "perHours", hours: 4 });
    expect(bySymbol(rows, "KPEPE").rate).toBe("-0.000195");
    // No margin_rules fan-out for funding.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/margin_rules"))).toBe(false);
  });

  it("a ticker without funding_rate gives no funding row and fundingRate null (never 0)", async () => {
    fetchMock.mockImplementation(routeFixtures({
      ticker: i => (i === "ETH_USDT_Perp" ? { result: { ...TICKERS.ETH_USDT_Perp.result, funding_rate: undefined } } : undefined),
    }));
    const rows = await fetchGrvtFundingRates("mainnet", { warn: () => undefined });
    expect(rows.map(r => r.symbol)).not.toContain("ETH");
    const markets = await fetchGrvtMarkets("mainnet", { leverage: true }, { warn: () => undefined });
    expect(bySymbol(markets, "ETH").fundingRate).toBeNull();
  });
});

describe("markets (recorded fixtures)", () => {
  it("mark / index / last / bid / ask / OI / 24 h volume, leverage from margin rules, null where unpublished", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const markets = await fetchGrvtMarkets("mainnet", { leverage: true }, { warn: () => undefined });
    const btc = bySymbol(markets, "BTC");
    expect(btc).toMatchObject({
      venue: "grvt", venueSymbol: "BTC_USDT_Perp", quoteAsset: "USDT", settle: "USDT",
      markPrice: "81129.562093259", indexPrice: "81165.931336857", lastPrice: "81151.9", bestBid: "81124.9", bestAsk: "81125.0",
      openInterest: "2504.60832092", fundingRate: "0.000062", fundingRateBasis: { kind: "perHours", hours: 8 }, settlementIntervalHours: 8,
      tickSize: "0.1", stepSize: null, minSize: "0.001", minNotional: "100.0", maxLeverage: 50, session: null, tradable: true,
    });
    // volume24h = buy + sell 24 h quote volume, exact.
    const t = TICKERS.BTC_USDT_Perp.result;
    expect(btc.volume24h).toBe("167664349.3289");
    expect(Number(t.buy_volume_24h_q) + Number(t.sell_volume_24h_q)).toBeCloseTo(167664349.3289, 3);
    expect(btc.marginTiers?.[0]).toEqual({ lowerBound: 0, maxLeverage: 50 });
    expect(btc.marginTiers?.map(x => x.lowerBound)).toEqual([...(btc.marginTiers ?? [])].map(x => x.lowerBound).sort((a, b) => a - b));
    // No brackets published → maxLeverage / marginTiers null.
    expect(bySymbol(markets, "ETH")).toMatchObject({ maxLeverage: null, marginTiers: null });
  });

  it("ticker nulls stay null; a market without a mark price is dropped with a warning", async () => {
    const t = toGrvtTicker({ mark_price: "1.5" });
    expect(t).toEqual({
      markPrice: "1.5", indexPrice: null, lastPrice: null, bestBid: null, bestAsk: null, openInterest: null,
      volume24hQuote: null, fundingPct: null, nextFundingTime: null,
    });
    expect(toGrvtTicker({ mark_price: "1", buy_volume_24h_q: "10" }).volume24hQuote).toBeNull();
    expect(toGrvtTicker({ mark_price: "1", best_bid_price: "" }).bestBid).toBeNull();
    fetchMock.mockImplementation(routeFixtures({ ticker: i => (i === "SPY_USDT_Perp" ? { result: { instrument: i } } : undefined) }));
    const warn = vi.fn();
    const markets = await fetchGrvtMarkets("mainnet", { leverage: true }, { warn });
    expect(markets.map(m => m.symbol)).not.toContain("SPY");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without a mark price are not shown: SPY"));
  });

  it("margin rules: tier-1 max leverage; malformed brackets → null", () => {
    expect(toGrvtLeverage(MARGIN_BTC)?.maxLeverage).toBe(50);
    expect(toGrvtLeverage({ risk_brackets: [{ notional_floor: "0.0", max_leverage: "50" }] })).toBeNull();
    expect(toGrvtLeverage({})).toBeNull();
  });

  it("testnet reads the testnet host", async () => {
    fetchMock.mockImplementation(routeFixtures());
    await fetchGrvtFundingRates("testnet", { warn: () => undefined });
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith("https://market-data.testnet.grvt.io/full/v1/"))).toBe(true);
  });
});

describe("transport error mapping", () => {
  const client = () => new GrvtClient("https://market-data.grvt.io", "mainnet");
  it("400 → EXCHANGE_ERROR, 429 → RATE_LIMITED, 5xx → EXCHANGE_UNREACHABLE, non-JSON / no result → EXCHANGE_ERROR, network → EXCHANGE_UNREACHABLE", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { code: 1003, message: "Request could not be processed due to malformed syntax", status: 400 }));
    await expect(client().result("ticker", { instrument: "X" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { code: 1006, message: "rate limit", status: 429 }, { "retry-after": "2" }));
    await expect(client().result("ticker", { instrument: "X" })).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { code: 1002, message: "Internal Server Error", status: 500 }));
    await expect(client().result("book", { instrument: "X" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(client().result("book", { instrument: "X" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    await expect(client().result("book", { instrument: "X" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client().result("book", { instrument: "X" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
  });

  it("sends a JSON POST to /full/v1/<endpoint>", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: [] }));
    await client().result("trade", { instrument: "BTC_USDT_Perp", limit: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://market-data.grvt.io/full/v1/trade");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ instrument: "BTC_USDT_Perp", limit: 3 });
  });
});

describe("public-only adapter", () => {
  const adapter = () => new GrvtPublicAdapter(getVenue("grvt"), "mainnet");

  it("orderbook: [price, size] strings from the recorded book", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const book = await adapter().getOrderbook("BTC");
    expect(book.bids).toHaveLength(10);
    expect(book.bids[0]).toEqual(["81124.9", "3.923"]);
    expect(book.asks[0]).toEqual(["81125.0", "3.45"]);
    const bookCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/book"))!;
    expect(JSON.parse(String((bookCall[1] as RequestInit).body))).toEqual({ instrument: "BTC_USDT_Perp", depth: 50 });
  });

  it("orderbook is sliced to the requested depth (GRVT serves 10 / 50 / 100 / 500)", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const book = await adapter().getOrderbook("BTC", 5);
    expect(book.bids).toHaveLength(5);
    expect(book.asks).toHaveLength(5);
    const bookCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/book"))!;
    expect(JSON.parse(String((bookCall[1] as RequestInit).body))).toMatchObject({ depth: 10 });
  });

  it("klines follow the `next` cursor past a full 1000-bar page; a cap warns", async () => {
    const bar = (t: number) => ({ open_time: `${t}000000`, close_time: `${t + 59_999}000000`, open: "1", close: "1", high: "1", low: "1", volume_b: "1", volume_q: "1", trades: 1, instrument: "BTC_USDT_Perp" });
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => bar(from - i * 60_000));
    const bodies: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(routeFixtures({
      kline: b => {
        bodies.push(b);
        return b.cursor === undefined ? { result: page(1_800_000_000_000, 1000), next: "c1" } : { result: page(1_800_000_000_000 - 1000 * 60_000, 3), next: "c2" };
      },
    }));
    const k = await adapter().getKlines("BTC", "1m", 0, 1_800_000_000_000);
    expect(k).toHaveLength(1003);
    expect(bodies.map(b => b.cursor)).toEqual([undefined, "c1"]);
    expect(k[0].time).toBeLessThan(k[k.length - 1].time);

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockImplementation(routeFixtures({ kline: () => ({ result: page(1_800_000_000_000, 1000), next: "again" }) }));
    expect(await adapter().getKlines("BTC", "1m", 0, 1_800_000_000_000)).toHaveLength(10_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stopped after 10000 bars"));
  });

  it("recent trades: taker side, ns → ms, no fee", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const trades = await adapter().getRecentTrades("btc", 3);
    expect(trades).toHaveLength(3);
    expect(trades[0]).toEqual({ time: 1_792_343_786_845, symbol: "BTC", side: "sell", price: "81148.5", size: "0.002", fee: null });
  });

  it("funding history: settled rates as fractions per the record's interval (8 h BTC, 4 h SAMSUNG)", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const a = adapter();
    const btc = await a.getFundingHistory("BTC", 5);
    expect(btc[0]).toEqual({ time: 1_792_339_200_000, rate: "0.0001", price: "81140.410874762", intervalHours: 8, rateKind: "lastSettled" });
    const sam = await a.getFundingHistory("SAMSUNG", 3);
    expect(sam[0]).toMatchObject({ rate: "-0.000162", intervalHours: 4, rateKind: "lastSettled" });
  });

  it("klines ascending by open time; unsupported interval → INVALID_PARAMS", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const k = await adapter().getKlines("BTC", "1h", 0, 1_792_344_000_000);
    expect(k.map(c => c.time)).toEqual([...k.map(c => c.time)].sort((x, y) => x - y));
    expect(k[0]).toMatchObject({ open: expect.any(String), volume: expect.any(String), quoteVolume: expect.any(String) });
    await expect(adapter().getKlines("BTC", "7m", 0, 1)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("an unknown symbol is SYMBOL_NOT_FOUND from the directory — the venue is never asked for it", async () => {
    fetchMock.mockImplementation(routeFixtures());
    await expect(adapter().getOrderbook("NOPE")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
    expect(fetchMock.mock.calls.map(([u]) => String(u).split("/full/v1/")[1])).toEqual(["instruments"]);
  });

  it("market rows carry fundingRateKind predicted, fundingVerified false and the per-market interval", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const rows = await adapter().getMarkets();
    const xau = bySymbol(rows, "XAU");
    expect(xau).toMatchObject({ fundingHours: 4, fundingRateKind: "predicted", fundingVerified: false, venueSymbol: "XAU_USDT_Perp", sizeDecimals: null, stepSize: null });
    expect(bySymbol(rows, "BTC").maxLeverage).toBe(50);
  });

  it("every account / trading method refuses with CAPABILITY_UNSUPPORTED and sends nothing", async () => {
    const a = adapter();
    const calls: Array<() => Promise<unknown>> = [
      () => a.getBalance(), () => a.getPositions(), () => a.getOpenOrders(), () => a.getOrderHistory(), () => a.getTradeHistory(),
      () => a.getFundingPayments(), () => a.marketOrder(), () => a.limitOrder(), () => a.editOrder(), () => a.cancelOrder(),
      () => a.cancelAllOrders(), () => a.setLeverage(), () => a.stopOrder(),
    ];
    for (const c of calls) {
      await expect(c()).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", remediation: GRVT_READ_ONLY_REMEDIATION } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const endpointsCalled = (): string[] => fetchMock.mock.calls.map(([u]) => String(u).split("/full/v1/")[1]);
const countOf = (e: string): number => endpointsCalled().filter(x => x === e).length;

describe("request budget", () => {
  it("price mode (registry path: MCP get_prices / market://prices): instruments + tickers once, then reused; never margin_rules", async () => {
    fetchMock.mockImplementation(routeFixtures());
    for (let i = 0; i < 3; i++) expect(await grvtPublicData.fetchMarkets("mainnet")).toHaveLength(9);
    expect(countOf("instruments")).toBe(1);
    expect(countOf("ticker")).toBe(9);
    expect(countOf("margin_rules")).toBe(0);
    expect((await grvtPublicData.fetchMarkets("mainnet")).every(m => m.maxLeverage === null)).toBe(true);
  });

  it("after the short TTL the tickers are read again", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await grvtPublicData.fetchFundingRates("mainnet");
    now.mockReturnValue(t0 + GRVT_SHORT_TTL_MS + 1);
    await grvtPublicData.fetchFundingRates("mainnet");
    expect(countOf("instruments")).toBe(2);
    expect(countOf("ticker")).toBe(18);
  });

  it("market list fetches margin_rules once; they come from the long-lived cache afterwards", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const a = new GrvtPublicAdapter(getVenue("grvt"), "mainnet");
    expect(bySymbol(await a.getMarkets(), "BTC").maxLeverage).toBe(50);
    now.mockReturnValue(t0 + GRVT_SHORT_TTL_MS + 1); // in-process tickers expired, margin cache (6 h) not
    expect(bySymbol(await a.getMarkets(), "BTC").maxLeverage).toBe(50);
    expect(countOf("margin_rules")).toBe(9);
    expect(countOf("ticker")).toBe(18);
  });

  it("market info <sym>: the directory, ONE ticker and ONE margin_rules read", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const info = await new GrvtPublicAdapter(getVenue("grvt"), "mainnet").getMarketInfo("btc");
    expect(info).toMatchObject({ symbol: "BTC", markPrice: "81129.562093259", maxLeverage: 50, fundingHours: 8, fundingRateKind: "predicted" });
    expect(endpointsCalled()).toEqual(["instruments", "ticker", "margin_rules"]);
    await expect(new GrvtPublicAdapter(getVenue("grvt"), "mainnet").getMarketInfo("NOPE")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
    expect(endpointsCalled()).toEqual(["instruments", "ticker", "margin_rules"]);
  });

  it("CLI `market info BTC -e grvt` takes the single-market path", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
    vi.spyOn(process.stdout, "write").mockImplementation((m) => { out.push(String(m)); return true; });
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    await program.parseAsync(["node", "perp", "--json", "-e", "grvt", "market", "info", "BTC"]);
    vi.restoreAllMocks();
    const env = JSON.parse(out.join("").trim()) as { ok: boolean; data: { symbol: string; maxLeverage: number } };
    expect(env).toMatchObject({ ok: true, data: { symbol: "BTC", maxLeverage: 50 } });
    expect(endpointsCalled()).toEqual(["instruments", "ticker", "margin_rules"]);
  });
});

describe("per-market failure isolation", () => {
  it("a failed ticker drops only that market, with a warning naming it", async () => {
    fetchMock.mockImplementation(routeFixtures({ tickerStatus: i => (i === "ETH_USDT_Perp" ? 500 : null) }));
    const warn = vi.fn();
    const rows = await fetchGrvtFundingRates("mainnet", { warn });
    expect(rows.map(r => r.symbol)).not.toContain("ETH");
    expect(rows).toHaveLength(8);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 market\(s\) whose ticker could not be read are not shown: ETH \(GRVT ticker: HTTP 500/));
  });

  it("every ticker failing fails the venue with the first error", async () => {
    fetchMock.mockImplementation(routeFixtures({ tickerStatus: () => 500 }));
    await expect(fetchGrvtFundingRates("mainnet", { warn: () => undefined })).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
  });

  it("RATE_LIMITED fails the venue and stops the remaining workers", async () => {
    // 184 live markets: the first 429 stops the fan-out long before all of them are asked.
    let tickers = 0;
    const all = fx<{ result: unknown[] }>("instruments-all.json");
    const route = routeFixtures({ tickerStatus: () => 429 });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/instruments")) return jsonResponse(200, all);
      if (String(url).endsWith("/ticker")) tickers++;
      return route(url, init);
    });
    await expect(fetchGrvtFundingRates("mainnet", { warn: () => undefined })).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    expect(tickers).toBeLessThanOrEqual(8); // at most one request per worker in flight
  });

  it("a failed margin_rules read leaves that market's leverage unknown (null, warned, not cached)", async () => {
    const route = routeFixtures();
    let failBtc = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/margin_rules") && failBtc && String(init?.body).includes("BTC_USDT_Perp")) {
        return jsonResponse(500, { code: 1002, message: "Internal Server Error", status: 500 });
      }
      return route(url, init);
    });
    const warn = vi.fn();
    const first = await fetchGrvtMarkets("mainnet", { leverage: true }, { warn });
    expect(bySymbol(first, "BTC")).toMatchObject({ maxLeverage: null, marginTiers: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("margin rules unreadable for 1 market(s) — max leverage unknown: BTC_USDT_Perp"));
    failBtc = false;
    const second = await fetchGrvtMarkets("mainnet", { leverage: true }, { warn });
    expect(bySymbol(second, "BTC").maxLeverage).toBe(50);
    expect(countOf("margin_rules")).toBe(10); // 9, then only BTC again
  });
});

describe("equity whitelist (full live list, instruments-all.json 2026-10-19)", () => {
  it("classifies every live EQUITY market without an unreviewed warning", () => {
    const all = fx<{ result: Array<Record<string, unknown>> }>("instruments-all.json").result;
    expect(all).toHaveLength(184);
    const warn = vi.fn();
    const dir = all.map(r => toGrvtMarketMeta(r, warn)).filter((m): m is GrvtMarketMeta => m !== null);
    expect(dir).toHaveLength(184);
    expect(warn).not.toHaveBeenCalled();
    const equities = dir.filter((_, i) => all[i].asset_class === "EQUITY");
    expect(equities).toHaveLength(98);
    const nullCanon = equities.filter(m => m.canonical === null).map(m => m.symbol).sort();
    expect(nullCanon).toEqual(["ANTHROPIC", "BBX", "BRKB", "CBRS", "DRAM", "KSTR", "OPENAI", "PAYP", "QNTX", "SAMSUNGEM", "SKHY", "SPACEX", "STXX"]);
    for (const m of equities) if (m.canonical !== null) expect(m.canonical).toBe(m.symbol);
    expect(equities.filter(m => m.assetClass === "preIpo").map(m => m.symbol).sort()).toEqual(["ANTHROPIC", "OPENAI", "SPACEX"]);
    expect(equities.filter(m => m.assetClass === "etf")).toHaveLength(15);
  });

  it("a new, unreviewed EQUITY ticker is explicit-only (canonical null) and warned once", () => {
    const btc = INSTRUMENTS.result.find(r => r.instrument === "BTC_USDT_Perp")!;
    const warn = vi.fn();
    const row = { ...btc, instrument: "NEWIPO_USDT_Perp", base: "NEWIPO", asset_class: "EQUITY" };
    expect(toGrvtMarketMeta(row, warn)).toMatchObject({ symbol: "NEWIPO", assetClass: "equity", canonical: null });
    toGrvtMarketMeta(row, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NEWIPO: equity market not yet reviewed"));
  });
});

describe("health", () => {
  it("GRVT is probed with one instrument read and counted as an official venue", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { result: {} }));
    const h = await probeVenueHealth("mainnet", ["grvt"]);
    expect(h.probes).toEqual([expect.objectContaining({ venue: "grvt", ok: true, probe: "ping", status: 200, error: null, apiStatus: "official" })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://market-data.grvt.io/full/v1/instrument");
    expect(h.skipped).toEqual([]);
  });
});

describe("background jobs", () => {
  it("startJob refuses grvt / grv (venue or exchange) through the registry role check", () => {
    const base = { strategy: "twap", exchange: "grvt", network: "mainnet" as const, dryRun: false, params: {}, cliArgs: [], selectors: { ows: null, wallet: null, noAgent: false, dex: null, noBuilder: false } };
    for (const o of [base, { ...base, exchange: "hyperliquid", venue: "GRV" }]) {
      try {
        startJob(o as never);
        throw new Error("not refused");
      } catch (e) {
        expect((e as PerpError).structured).toMatchObject({ code: "CAPABILITY_UNSUPPORTED", remediation: GRVT_READ_ONLY_REMEDIATION });
        expect((e as Error).message).toMatch(/^Background job "twap" refused: GRVT has no trading in perp-cli — /);
      }
    }
  });
});

describe("setup trading selection", () => {
  it("grvt / grv as a setup venue → CAPABILITY_UNSUPPORTED with the GRVT remediation", () => {
    for (const v of ["grvt", "grv"]) {
      expect(() => resolveSetupVenue(v, "mainnet")).toThrow(expect.objectContaining({
        structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED", remediation: GRVT_READ_ONLY_REMEDIATION }),
      }));
    }
    // `perp setup --venues hyperliquid,grvt` (non-interactive) refuses the whole list.
    expect(() => parseVenueList("hyperliquid,grvt", "mainnet")).toThrow(expect.objectContaining({
      structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }),
    }));
  });
});

describe("write-refusal table: GRVT writes refuse before any I/O", () => {
  type Env = { ok: boolean; error?: { code: string; message: string; remediation?: string; details?: Record<string, unknown> } };
  const run = async (args: string[]): Promise<{ env: Env; docs: number }> => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation((m) => { out.push(String(m)); return true; });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw Object.assign(new Error("__exit__"), { exitCode: code }); }) as never);
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    let thrown: PerpError | null = null;
    try {
      await program.parseAsync(["node", "perp", "--json", ...args]);
    } catch (e) {
      if (e instanceof PerpError) thrown = e;
      else if ((e as Error).message !== "__exit__") throw e;
    } finally {
      vi.restoreAllMocks();
      vi.stubGlobal("fetch", fetchMock);
    }
    if (thrown !== null) return { env: { ok: false, error: thrown.structured as never }, docs: out.join("").trim() === "" ? 1 : 2 };
    return { env: JSON.parse(out.join("").trim()) as Env, docs: 1 };
  };

  const CASES: string[][] = [
    ["-e", "grvt", "trade", "market", "BTC", "buy", "0.001"],
    ["--dry-run", "-e", "grvt", "trade", "market", "BTC", "buy", "0.001"],
    ["-e", "grvt", "trade", "buy", "BTC", "0.001"],
    ["-e", "grvt", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["--dry-run", "-e", "grvt", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["-e", "grvt", "trade", "cancel", "BTC", "123"],
    ["-e", "grvt", "trade", "cancel-all"],
    ["-e", "grvt", "trade", "leverage", "BTC", "5"],
    ["-e", "grvt", "trade", "close", "BTC"],
    ["-e", "grvt", "trade", "tpsl", "BTC", "long", "--tp", "90000"],
    ["-e", "grvt", "trade", "stop", "BTC", "sell", "0.001", "70000"],
    ["-e", "grv", "portfolio"],
    ["-e", "grvt", "account", "trades"],
    ["-e", "grvt", "account", "positions"],
    ["-e", "grvt", "account", "orders"],
    ["funds", "deposit", "grvt", "10"],
    ["--dry-run", "funds", "deposit", "grvt", "10"],
    ["funds", "withdraw", "grvt", "10"],
    ["--dry-run", "funds", "withdraw", "grvt", "10"],
    ["-e", "grvt", "funds", "transfer", "10", "0x0000000000000000000000000000000000000001"],
    ["funds", "rebalance", "execute", "--exchanges", "grvt,hyperliquid"],
    ["wallet", "agent", "approve", "grvt"],
    ["wallet", "agent", "import", "grvt"],
    ["wallet", "agent", "revoke", "grvt", "x"],
    ["wallet", "builder", "approve", "grvt"],
    ["-e", "grvt", "strategy", "twap", "BTC", "buy", "0.01", "10m"],
    ["-e", "grvt", "strategy", "grid", "BTC", "--upper", "90000", "--lower", "80000", "--grids", "5", "--size", "0.001"],
    ["-e", "grvt", "strategy", "dca", "BTC", "buy", "10", "1h"],
    ["-e", "grvt", "strategy", "trailing-stop", "BTC", "--trail", "1"],
    ["-e", "grvt", "strategy", "quick-grid", "BTC"],
    ["arb", "exec", "BTC", "grvt", "hyperliquid", "10"],
    ["--dry-run", "arb", "exec", "BTC", "grvt", "hyperliquid", "10"],
  ];

  for (const args of CASES) {
    it(`perp ${args.join(" ")} → CAPABILITY_UNSUPPORTED, one JSON document, zero fetch`, async () => {
      const { env, docs } = await run(args);
      expect(env.ok).toBe(false);
      expect(env.error!.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(docs).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
