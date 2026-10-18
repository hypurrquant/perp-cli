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
  fetchGrvtFundingRates, fetchGrvtMarkets, grvtPercentToFraction, resolveGrvtMarket, toGrvtLeverage, toGrvtMarketMeta, toGrvtTicker,
  type GrvtMarketMeta,
} from "../../exchanges/grvt/public.js";
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
function routeFixtures(overrides: { ticker?: (instrument: string) => unknown } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const endpoint = url.split("/full/v1/")[1];
    const body = JSON.parse(String(init?.body ?? "{}")) as { instrument?: string };
    switch (endpoint) {
      case "instruments": return jsonResponse(200, INSTRUMENTS);
      case "ticker": {
        const t = overrides.ticker?.(body.instrument!) ?? TICKERS[body.instrument!];
        return t === undefined ? jsonResponse(400, { code: 1003, message: "Request could not be processed due to malformed syntax", status: 400 }) : jsonResponse(200, t);
      }
      case "margin_rules": return jsonResponse(200, body.instrument === "BTC_USDT_Perp" ? MARGIN_BTC : { instrument: body.instrument, risk_brackets: [] });
      case "book": return jsonResponse(200, fx("book-btc.json"));
      case "trade": return jsonResponse(200, fx("trades-btc.json"));
      case "funding": return jsonResponse(200, fx(body.instrument === "SAMSUNG_USDT_Perp" ? "funding-samsung.json" : "funding-btc.json"));
      case "kline": return jsonResponse(200, fx("kline-btc-1h.json"));
      default: throw new Error(`unexpected endpoint ${endpoint}`);
    }
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
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
    const markets = await fetchGrvtMarkets("mainnet", { warn: () => undefined });
    expect(bySymbol(markets, "ETH").fundingRate).toBeNull();
  });
});

describe("markets (recorded fixtures)", () => {
  it("mark / index / last / bid / ask / OI / 24 h volume, leverage from margin rules, null where unpublished", async () => {
    fetchMock.mockImplementation(routeFixtures());
    const markets = await fetchGrvtMarkets("mainnet", { warn: () => undefined });
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
    const markets = await fetchGrvtMarkets("mainnet", { warn });
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
