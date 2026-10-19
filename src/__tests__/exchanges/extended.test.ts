/**
 * Extended (official API, market data only in this version): parsing against recorded live
 * responses (src/__tests__/fixtures/extended/), funding semantics and units, null handling,
 * symbol / canonical mapping incl. RWA ↔ crypto collision safety, transport errors, health and
 * funding-comparison inclusion, and the write-refusal table (every write path refuses with
 * CAPABILITY_UNSUPPORTED and the read-only remediation, makes zero network calls, also under
 * --dry-run).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenue, listVenues, requireCapabilities, resolveVenueId, roleUnsupported } from "../../exchanges/venue.js";
import { rateToHourly } from "../../exchanges/venue-types.js";
import { ExtendedClient } from "../../exchanges/extended/client.js";
import {
  EXTENDED_FUNDING_BASIS, extendedAssetClass, extendedCanonical, extendedSymbolOf, fetchExtendedFundingRates, fetchExtendedMarkets,
  extendedWireCandidates, parseExtendedMarkets, resolveExtendedMarket, resolveExtendedMarketRemote, toExtendedFundingRates,
} from "../../exchanges/extended/public.js";
import { ExtendedPublicAdapter } from "../../exchanges/extended/adapter.js";
import { EXTENDED_READ_ONLY_REMEDIATION } from "../../exchanges/venues/extended.js";
import { fetchVenuesRates } from "../../funding/rates.js";
import { probeVenueHealth } from "../../venue-health.js";
import { buildProgram } from "../../cli-program.js";
import { startJob } from "../../jobs.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "extended");
const fixture = <T = { status: string; data: unknown }>(name: string): T => JSON.parse(readFileSync(resolve(FIX, name), "utf-8")) as T;
const MARKETS = fixture<{ status: string; data: Array<Record<string, unknown>> }>("markets.json");
const BOOK = fixture("orderbook-btc.json");
const TRADES = fixture("trades-btc.json");
const FUNDING = fixture<{ status: string; data: Array<{ m: string; f: string; T: number }> }>("funding-history-btc.json");
const CANDLES = fixture("candles-btc-1h.json");

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const row = (name: string): Record<string, unknown> => clone(MARKETS.data.find(r => r.name === name) as Record<string, unknown>);
const parse = (data: unknown, warn = vi.fn()) => parseExtendedMarkets(data, warn);
const bySymbol = (rows: ReturnType<typeof parse>, s: string) => rows.find(r => r.market.symbol === s);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
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

/** Route GETs by path to recorded bodies. */
function routeFetch(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    if (!(path in routes)) throw new Error(`unexpected network call: ${url}`);
    return jsonResponse(200, routes[path]);
  });
}

describe("Extended venue definition", () => {
  it("market data only, official API, UNVERIFIED hourly funding, aliases ext / x10, mainnet + Sepolia testnet", () => {
    const def = getVenue("extended");
    expect(def.roles).toEqual(["marketData"]);
    expect(def.capabilities).toBeNull();
    expect(def.apiStatus).toEqual({ kind: "official" });
    // Not checked against an account funding payment; `_24_5` equities print 0 off hours.
    expect(def.fundingVerified).toBe(false);
    expect(def.fundingRateBasis).toEqual({ kind: "perHours", hours: 1 });
    expect(def.settlementIntervalHours).toBe(1);
    expect(resolveVenueId("ext")).toBe("extended");
    expect(resolveVenueId("x10")).toBe("extended");
    expect(def.networks.mainnet.restUrl).toBe("https://api.starknet.extended.exchange/api/v1");
    expect(def.networks.testnet?.restUrl).toBe("https://api.starknet.sepolia.extended.exchange/api/v1");
    // Docs: 1,000 requests / minute per IP — the limiter stays below it.
    expect(def.rateLimit.refillPerSec * 60).toBeLessThan(1000);
  });

  it("refusals carry the read-only remediation (readOnlyRemediation) with the generic reason", () => {
    const e = roleUnsupported(getVenue("extended"), "trading");
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.structured.message).toBe("extended does not support trading — Extended is available for market data only (no trading role)");
    expect(getVenue("extended").readOnlyRemediation).toBe(EXTENDED_READ_ONLY_REMEDIATION);
    expect(e.structured.remediation).toBe(EXTENDED_READ_ONLY_REMEDIATION);
    expect(e.structured.remediation).toMatch(/^Extended is read-only \(market data\) in this version; trading is planned for a later release/);
    expect(() => requireCapabilities(getVenue("extended"))).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }) }));
  });

  it("other venues keep the generic wording", () => {
    expect(getVenue("txflow").readOnlyRemediation).toBeUndefined();
    expect(roleUnsupported(getVenue("txflow"), "trading").structured.remediation).toMatch(/Trade on the TxFlow website/);
  });
});

describe("market parsing (recorded /info/markets)", () => {
  it("keeps listed perpetuals only: ACTIVE + REDUCE_ONLY; DELISTED / PRELISTED / SPOT excluded despite active:true", () => {
    const rows = parse(MARKETS.data);
    const names = rows.map(r => r.market.venueSymbol);
    expect(names).toContain("MKR-USD");
    expect(names).not.toContain("NOW_24_5-USD");
    expect(names).not.toContain("NOW-USD");
    expect(names).not.toContain("USDTSPOT-USD");
    expect(MARKETS.data.find(r => r.name === "NOW-USD")?.active).toBe(true);
    expect(rows).toHaveLength(MARKETS.data.length - 3);
  });

  it("BTC: decimal strings, precision, leverage, tiers from riskFactorConfig, base-unit OI", () => {
    const btc = bySymbol(parse(MARKETS.data), "BTC")!.market;
    const raw = row("BTC-USD") as { marketStats: Record<string, unknown> };
    expect(btc).toMatchObject({
      venue: "extended", venueSymbol: "BTC-USD", symbol: "BTC", canonical: "BTC", assetClass: "crypto",
      settle: "USD", quoteAsset: "USD",
      markPrice: raw.marketStats.markPrice, indexPrice: raw.marketStats.indexPrice, fundingRate: "0.000013",
      fundingRateBasis: { kind: "perHours", hours: 1 }, settlementIntervalHours: 1,
      openInterest: raw.marketStats.openInterestBase, volume24h: raw.marketStats.dailyVolume,
      tickSize: "1", stepSize: "0.00001", minSize: "0.0001", minNotional: null, maxLeverage: 50, tradable: true,
    });
    expect(typeof btc.markPrice).toBe("string");
    // Tiers available to users only (the 64M tier is isAvailableForUsers:false); leverage = 1 / riskFactor.
    expect(btc.marginTiers).toEqual([
      { lowerBound: 0, maxLeverage: 50 }, { lowerBound: 4_000_000, maxLeverage: 25 }, { lowerBound: 8_000_000, maxLeverage: 1 / 0.06 },
    ]);
  });

  it("tradable: REDUCE_ONLY and off-hours markets are listed but not tradable", () => {
    const rows = parse(MARKETS.data);
    expect(bySymbol(rows, "MKR")!.market.tradable).toBe(false);
    expect(bySymbol(rows, "SHOP")!.meta.isOffHours).toBe(true);
    expect(bySymbol(rows, "SHOP")!.market.tradable).toBe(false);
  });
});

describe("symbol + canonical mapping (RWA collision safety)", () => {
  const rows = () => parse(MARKETS.data);
  it.each([
    ["TSLA", "TSLA_24_5-USD", "equity", "TSLA"],
    ["SPX500M", "SPX500m-USD", "index", "SPX"],
    ["TECH100M", "TECH100m-USD", "index", "NDX"],
    ["KR200", "KR200-USD", "index", null],
    ["XAU", "XAU-USD", "commodity", "GOLD"],
    ["WTI", "WTI-USD", "commodity", "CRUDE_OIL_WTI"],
    ["EUR", "EUR-USD", "fx", null],
    ["USDJPY", "USDJPY-USD", "fx", "USDJPY"],
    ["DRAM", "DRAM-USD", "etf", "DRAM"],
    ["ANTHROP", "ANTHROP-USD", "preIpo", null],
    ["PAXG", "PAXG-USD", "crypto", "PAXG"],
    // RWA tickers that are crypto tickers elsewhere are never matched.
    ["PURR", "PURR-USD", "equity", null],
    ["QNT", "QNT-USD", "equity", null],
    // The crypto SPX (SPX6900) is never matched with the S&P 500 canonical.
    ["SPX", "SPX-USD", "crypto", null],
  ])("%s (%s) → %s, canonical %s", (symbol, venueSymbol, assetClass, canonical) => {
    const m = bySymbol(rows(), symbol)!.market;
    expect(m).toMatchObject({ venueSymbol, assetClass, canonical });
  });

  it("no two listed markets share a symbol; the crypto SPX and the index SPX500M stay apart", () => {
    const syms = rows().map(r => r.market.symbol);
    expect(new Set(syms).size).toBe(syms.length);
    const spx = rows().filter(r => r.market.canonical === "SPX");
    expect(spx.map(r => r.market.venueSymbol)).toEqual(["SPX500m-USD"]);
  });

  it("an RWA ticker equal to one of Extended's own crypto symbols (both ACTIVE) → both skipped with a warning, the rest kept", () => {
    const rwa = { ...row("QNT-USD"), name: "ENA_24_5-USD", assetName: "ENA_24_5" };
    const warn = vi.fn();
    const out = parse([row("ENA-USD"), rwa, row("BTC-USD")], warn);
    expect(out.map(r => r.market.venueSymbol)).toEqual(["BTC-USD"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no single ACTIVE row, all skipped"));
  });

  it("helpers: _24_5 suffix, denomination aliases, unknown categories", () => {
    expect(extendedSymbolOf("TSLA_24_5")).toBe("TSLA");
    expect(extendedSymbolOf("SPX500m")).toBe("SPX500M");
    expect(extendedCanonical("KNEIRO", "crypto")).toBe("1000NEIRO");
    expect(extendedCanonical("PURR", "crypto")).toBe("PURR");
    expect(extendedCanonical("PURR", "equity")).toBeNull();
    expect(extendedAssetClass("RWA", "Bonds", "X")).toBeNull();
    expect(extendedAssetClass("Stable", "Stable", "X")).toBeNull();
    expect(extendedAssetClass("RWA", "ETF/Index", "SOXL")).toBe("etf");
  });

  it("ticker migration (NOW_24_5-USD REDUCE_ONLY → NOW-USD ACTIVE): the ACTIVE row is kept, warned", () => {
    const old = { ...row("TSLA_24_5-USD"), name: "NOW_24_5-USD", assetName: "NOW_24_5", status: "REDUCE_ONLY" };
    const cur = { ...row("TSLA_24_5-USD"), name: "NOW-USD", assetName: "NOW", status: "ACTIVE" };
    const warn = vi.fn();
    const out = parse([old, cur], warn);
    expect(out.map(r => r.market.venueSymbol)).toEqual(["NOW-USD"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("kept the ACTIVE NOW-USD"));
  });

  it("collisions: ADI / BOT equities and XIAOMI are never matched", () => {
    expect(extendedCanonical("ADI", "equity")).toBeNull();
    expect(extendedCanonical("BOT", "equity")).toBeNull();
    expect(extendedCanonical("XIAOMI", "equity")).toBeNull();
    expect(extendedCanonical("AAPL", "equity")).toBe("AAPL");
  });

  it("CLI symbol resolution: wire name first, then symbol, then <symbol>-USD; unlisted → SYMBOL_NOT_FOUND", () => {
    const metas = rows().map(r => r.meta);
    expect(resolveExtendedMarket(metas, "tsla").name).toBe("TSLA_24_5-USD");
    expect(resolveExtendedMarket(metas, "TSLA-USD").name).toBe("TSLA_24_5-USD");
    expect(resolveExtendedMarket(metas, "btc-perp").name).toBe("BTC-USD");
    // "SPX-USD" is the crypto market's wire name, not the S&P 500.
    expect(resolveExtendedMarket(metas, "SPX-USD").name).toBe("SPX-USD");
    expect(resolveExtendedMarket(metas, "spx500m").name).toBe("SPX500m-USD");
    expect(() => resolveExtendedMarket(metas, "NOPE")).toThrow(expect.objectContaining({
      structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", remediation: "List markets: perp -e extended market list" }),
    }));
  });
});

describe("null handling", () => {
  it("absent / non-decimal stats are null, never 0; no funding rate → no funding row", () => {
    const r = row("ENA-USD") as { marketStats: Record<string, unknown> };
    delete r.marketStats.indexPrice;
    r.marketStats.openInterestBase = null;
    delete r.marketStats.dailyVolume;
    delete r.marketStats.fundingRate;
    delete r.marketStats.nextFundingRate;
    const [out] = parse([r]);
    expect(out.market).toMatchObject({ indexPrice: null, openInterest: null, volume24h: null, fundingRate: null });
    expect(out.nextFundingTime).toBeNull();
    expect(toExtendedFundingRates([out])).toEqual([]);
  });

  it("a zero / missing mark price drops the market with a warning", () => {
    const r = row("ENA-USD") as { marketStats: Record<string, unknown> };
    r.marketStats.markPrice = "0";
    const warn = vi.fn();
    expect(parse([r], warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENA-USD"));
  });

  it("an unknown category is skipped with a warning", () => {
    const warn = vi.fn();
    expect(parse([{ ...row("ENA-USD"), category: "Bonds" }], warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown category"));
  });

  it("a drifted row is skipped with a warning; the other rows still parse", () => {
    const r = row("BTC-USD") as { tradingConfig: Record<string, unknown> };
    delete r.tradingConfig.minPriceChange;
    const warn = vi.fn();
    const out = parse([r, "not-an-object", row("ENA-USD")], warn);
    expect(out.map(x => x.market.venueSymbol)).toEqual(["ENA-USD"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped 2 malformed market row\(s\).*BTC-USD.*minPriceChange/));
  });

  it("EXCHANGE_ERROR only for envelope drift or when malformed rows leave no market", () => {
    const r = row("BTC-USD") as { tradingConfig: Record<string, unknown> };
    delete r.tradingConfig.minPriceChange;
    expect(() => parse([r])).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
    expect(() => parse({ data: [] })).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
    expect(parse([])).toEqual([]);
  });
});

describe("funding semantics and units", () => {
  it("rows: the accruing rate as published (fraction per hour), basis 1h, next application time", () => {
    const rates = toExtendedFundingRates(parse(MARKETS.data));
    const btc = rates.find(r => r.symbol === "BTC")!;
    expect(btc).toEqual({
      venue: "extended", venueSymbol: "BTC-USD", symbol: "BTC", canonical: "BTC",
      rate: "0.000013", basis: EXTENDED_FUNDING_BASIS, markPrice: bySymbol(parse(MARKETS.data), "BTC")!.market.markPrice,
      nextFundingTime: 1_792_346_400_000,
    });
    // nextFundingRate is a timestamp on an hour boundary.
    expect(btc.nextFundingTime! % 3_600_000).toBe(0);
    // Unit: the crypto interest component 0.01 % / 8 h = 0.0000125 / h, published to 6 dp.
    expect(Number(btc.rate)).toBeCloseTo(0.0001 / 8, 6);
    expect(rateToHourly(Number(btc.rate), btc.basis)).toBe(0.000013);
    // RWA interest component 0.0035 % / 8 h ≈ 0.0000044 / h → "0.000004".
    expect(rates.find(r => r.symbol === "XAU")!.rate).toBe("0.000004");
  });

  it("funding history: applied hourly prints (lastSettled), newest first, APR-normalized, documented query", async () => {
    routeFetch({ "/info/markets": MARKETS, "/info/BTC-USD/funding": FUNDING });
    const a = new ExtendedPublicAdapter(getVenue("extended"), "mainnet");
    const h = await a.getFundingHistory("BTC", 3);
    expect(h).toHaveLength(3);
    expect(h[0]).toEqual({
      time: FUNDING.data[0].T, rate: FUNDING.data[0].f, price: null, rateKind: "lastSettled", intervalHours: 1,
      annualizedPct: Number(FUNDING.data[0].f) * 24 * 365 * 100,
    });
    expect(h.map(x => x.time)).toEqual([...h.map(x => x.time)].sort((x, y) => y - x));
    // Consecutive prints are one hour apart.
    for (let i = 1; i < FUNDING.data.length; i++) expect(Math.round((FUNDING.data[i - 1].T - FUNDING.data[i].T) / 3_600_000)).toBe(1);
    const url = new URL(String(fetchMock.mock.calls.at(-1)![0]));
    expect(url.searchParams.get("limit")).toBe("3");
    expect(Number(url.searchParams.get("endTime")) - Number(url.searchParams.get("startTime"))).toBe(5 * 3_600_000);
  });

  it("evidence: the last accruing value before the hour equals the applied print (recorded across a settlement)", () => {
    const ev = fixture<{ settlements: Array<{ market: string; lastAccruing: string; applied: string; distinctAccruingValuesInWindow: string[] }> }>("funding-settlement-evidence.json");
    expect(ev.settlements.length).toBeGreaterThan(0);
    // Numerically equal ("-0.000010" accruing vs "-0.00001" applied on TSLA_24_5-USD).
    for (const s of ev.settlements) expect(Number(s.applied)).toBe(Number(s.lastAccruing));
    // The published rate moves within the hour (accruing, not the last settled print).
    expect(ev.settlements.some(s => s.distinctAccruingValuesInWindow.length > 1)).toBe(true);
  });

  it("market rows label the funding kind", async () => {
    routeFetch({ "/info/markets": MARKETS });
    const rows = await new ExtendedPublicAdapter(getVenue("extended"), "mainnet").getMarkets();
    expect(rows.find(r => r.symbol === "BTC")).toMatchObject({ fundingRateKind: "accruing", nextFundingTime: 1_792_346_400_000, fundingHours: 1, assetClass: "crypto" });
    expect(rows.find(r => r.symbol === "TSLA")).toMatchObject({ assetClass: "equity", venueSymbol: "TSLA_24_5-USD", isRfq: true });
  });
});

describe("public adapter reads", () => {
  it("orderbook: [price, qty] strings from the recorded book", async () => {
    routeFetch({ "/info/markets": MARKETS, "/info/markets/BTC-USD/orderbook": BOOK });
    const book = await new ExtendedPublicAdapter(getVenue("extended"), "mainnet").getOrderbook("btc");
    const raw = (BOOK.data as { bid: Array<{ price: string; qty: string }>; ask: Array<{ price: string; qty: string }> });
    expect(book.bids[0]).toEqual([raw.bid[0].price, raw.bid[0].qty]);
    expect(book.asks).toHaveLength(raw.ask.length);
    expect(Number(book.bids[0][0])).toBeLessThan(Number(book.asks[0][0]));
  });

  it("an unlisted symbol is SYMBOL_NOT_FOUND before any per-market request", async () => {
    routeFetch({ "/info/markets": MARKETS });
    const a = new ExtendedPublicAdapter(getVenue("extended"), "mainnet");
    for (const read of [() => a.getOrderbook("NOPE"), () => a.getRecentTrades("NOPE"), () => a.getFundingHistory("NOPE"), () => a.getKlines("NOPE", "1h", 0, 1)]) {
      await expect(read()).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
    }
    expect(fetchMock.mock.calls.every(c => new URL(String(c[0])).pathname === "/api/v1/info/markets")).toBe(true);
  });

  it("an orderbook body without data (the venue's answer for an unknown market) → EXCHANGE_ERROR", async () => {
    routeFetch({ "/info/markets": MARKETS, "/info/markets/BTC-USD/orderbook": { status: "OK" } });
    await expect(new ExtendedPublicAdapter(getVenue("extended"), "mainnet").getOrderbook("BTC")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("trades: taker side, newest first, no fee", async () => {
    routeFetch({ "/info/markets": MARKETS, "/info/markets/BTC-USD/trades": TRADES });
    const t = await new ExtendedPublicAdapter(getVenue("extended"), "mainnet").getRecentTrades("BTC", 3);
    expect(t).toHaveLength(3);
    expect(t[0].time).toBeGreaterThanOrEqual(t[1].time);
    expect(t[0]).toMatchObject({ symbol: "BTC", fee: null });
    expect(["buy", "sell"]).toContain(t[0].side);
    expect(typeof t[0].price).toBe("string");
  });

  it("klines: ISO-8601 interval, ascending; unsupported interval → INVALID_PARAMS", async () => {
    routeFetch({ "/info/markets": MARKETS, "/info/candles/BTC-USD/trades": CANDLES });
    const a = new ExtendedPublicAdapter(getVenue("extended"), "mainnet");
    const k = await a.getKlines("BTC", "1h", 0, Date.now());
    expect(k.length).toBe((CANDLES.data as unknown[]).length);
    expect(k[0].time).toBeLessThan(k[k.length - 1].time);
    expect(k[0]).toMatchObject({ quoteVolume: null, trades: null });
    const url = new URL(String(fetchMock.mock.calls.at(-1)![0]));
    expect(url.searchParams.get("interval")).toBe("PT1H");
    await expect(a.getKlines("BTC", "3m", 0, 1)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    await expect(a.getKlines("BTC", "constructor", 0, 1)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("every account / trading method refuses with CAPABILITY_UNSUPPORTED and sends nothing", async () => {
    const a = new ExtendedPublicAdapter(getVenue("extended"), "mainnet");
    const calls: Array<() => Promise<unknown>> = [
      () => a.getBalance(), () => a.getPositions(), () => a.getOpenOrders(), () => a.getOrderHistory(), () => a.getTradeHistory(),
      () => a.getFundingPayments(), () => a.marketOrder(), () => a.limitOrder(), () => a.editOrder(), () => a.cancelOrder(),
      () => a.cancelAllOrders(), () => a.setLeverage(), () => a.stopOrder(),
    ];
    for (const c of calls) await expect(c()).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", remediation: EXTENDED_READ_ONLY_REMEDIATION } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("per-market symbol resolution without the full listing", () => {
  /** Query-aware mock: `?market=<name>` answers that row (or HTTP 400 code 1001), the bare listing MARKETS. */
  function venueMock(extra: Record<string, unknown> = {}): string[] {
    const urls: string[] = [];
    fetchMock.mockImplementation(async (u: string) => {
      urls.push(u);
      const url = new URL(u);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      if (path === "/info/markets") {
        const name = url.searchParams.get("market");
        if (name === null) return jsonResponse(200, MARKETS);
        const hit = MARKETS.data.filter(r => r.name === name);
        return hit.length > 0 ? jsonResponse(200, { status: "OK", data: hit }) : jsonResponse(400, { status: "ERROR", error: { code: 1001, message: "Market not found" } });
      }
      if (path in extra) return jsonResponse(200, extra[path]);
      throw new Error(`unexpected network call: ${u}`);
    });
    return urls;
  }
  const marketReads = (urls: string[]) => urls.filter(u => new URL(u).pathname.endsWith("/info/markets")).map(u => new URL(u).searchParams.get("market"));

  it("wire-name candidates of a bare symbol: <S>-USD and <S>_24_5-USD", () => {
    expect(extendedWireCandidates("btc")).toEqual(["BTC-USD", "BTC_24_5-USD"]);
    expect(extendedWireCandidates("eth-perp")).toEqual(["ETH-USD", "ETH_24_5-USD"]);
    expect(extendedWireCandidates("TSLA_24_5")).toEqual(["TSLA-USD", "TSLA_24_5-USD"]);
  });

  it("bare symbols read every candidate (BTC-USD + BTC_24_5-USD, TSLA-USD + TSLA_24_5-USD); no full listing", async () => {
    const urls = venueMock({ "/info/markets/BTC-USD/orderbook": BOOK, "/info/markets/TSLA_24_5-USD/orderbook": BOOK });
    const a = new ExtendedPublicAdapter(getVenue("extended"), "mainnet");
    await a.getOrderbook("btc");
    await a.getOrderbook("TSLA");
    expect(marketReads(urls)).toEqual(["BTC-USD", "BTC_24_5-USD", "TSLA-USD", "TSLA_24_5-USD"]);
  });

  it("a symbol no candidate matches (spx500m) falls to the full listing once; an unlisted one is SYMBOL_NOT_FOUND", async () => {
    const urls = venueMock();
    expect((await resolveExtendedMarketRemote(new ExtendedClient(getVenue("extended").networks.mainnet.restUrl, getVenue("extended").rateLimit, "extended:test"), "spx500m")).name).toBe("SPX500m-USD");
    expect(marketReads(urls)).toEqual(["SPX500M-USD", "SPX500M_24_5-USD", null]);
    await expect(new ExtendedPublicAdapter(getVenue("extended"), "mainnet").getOrderbook("NOPE")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
  });

  describe("duplicate symbols: the remote path agrees with the listing (dedupeSymbols)", () => {
    const base = () => row("TSLA_24_5-USD");
    const mk = (name: string, status: string) => ({ ...base(), name, assetName: name.replace(/-USD$/, ""), status });
    /** `?market=` answers from `table` (absent = 1001); the bare listing is every row of `table`. */
    function tableMock(table: Record<string, Record<string, unknown>>): string[] {
      const urls: string[] = [];
      fetchMock.mockImplementation(async (u: string) => {
        urls.push(u);
        const url = new URL(u);
        const name = url.searchParams.get("market");
        if (name === null) return jsonResponse(200, { status: "OK", data: Object.values(table) });
        const hit = table[name];
        return hit !== undefined ? jsonResponse(200, { status: "OK", data: [hit] }) : jsonResponse(400, { status: "ERROR", error: { code: 1001, message: "Market not found" } });
      });
      return urls;
    }
    const client = () => new ExtendedClient(getVenue("extended").networks.mainnet.restUrl, getVenue("extended").rateLimit, "extended:test");
    const listingPick = (table: Record<string, Record<string, unknown>>, input: string) => {
      try { return resolveExtendedMarket(parse(Object.values(table)).map(r => r.meta), input).name; } catch (e) { return (e as PerpError).structured.code; }
    };
    const remotePick = async (table: Record<string, Record<string, unknown>>, input: string, warn = vi.fn()) => {
      tableMock(table);
      try { return (await resolveExtendedMarketRemote(client(), input, { warn })).name; } catch (e) { return (e as PerpError).structured.code; }
    };

    it.each([
      ["NOW-USD REDUCE_ONLY + NOW_24_5-USD ACTIVE", "REDUCE_ONLY", "ACTIVE", "NOW_24_5-USD", true],
      ["NOW-USD ACTIVE + NOW_24_5-USD REDUCE_ONLY", "ACTIVE", "REDUCE_ONLY", "NOW-USD", true],
      ["both ACTIVE", "ACTIVE", "ACTIVE", "SYMBOL_NOT_FOUND", true],
      ["both REDUCE_ONLY", "REDUCE_ONLY", "REDUCE_ONLY", "SYMBOL_NOT_FOUND", true],
      ["NOW-USD DELISTED + NOW_24_5-USD ACTIVE", "DELISTED", "ACTIVE", "NOW_24_5-USD", false],
      ["NOW-USD ACTIVE + NOW_24_5-USD DELISTED", "ACTIVE", "DELISTED", "NOW-USD", false],
    ])("%s → %s (bare NOW and wire name NOW-USD agree with the listing)", async (_label, a, b, expected, warned) => {
      const table = { "NOW-USD": mk("NOW-USD", a), "NOW_24_5-USD": mk("NOW_24_5-USD", b) };
      for (const input of ["NOW", "now", "NOW-USD", "NOW_24_5-USD"]) {
        const warn = vi.fn();
        const got = await remotePick(table, input, warn);
        expect(got, input).toBe(listingPick(table, input));
        if (input === "NOW") expect(got).toBe(expected);
        expect(warn.mock.calls.some(c => String(c[0]).includes("map to symbol NOW")), input).toBe(warned);
      }
    });

    it("a migrated wire name reads the sibling name too (NOW-USD → NOW_24_5-USD), never the full listing", async () => {
      const urls = tableMock({ "NOW-USD": mk("NOW-USD", "REDUCE_ONLY"), "NOW_24_5-USD": mk("NOW_24_5-USD", "ACTIVE") });
      await resolveExtendedMarketRemote(client(), "NOW-USD", { warn: vi.fn() });
      expect(marketReads(urls)).toEqual(["NOW-USD", "NOW_24_5-USD"]);
    });

    it("a malformed single row in a ?market= reply → EXCHANGE_ERROR (no fallback to the listing)", async () => {
      const bad = { ...mk("NOW-USD", "ACTIVE") } as Record<string, unknown>;
      delete (bad.tradingConfig as Record<string, unknown>).minPriceChange;
      const urls = tableMock({ "NOW-USD": bad });
      await expect(resolveExtendedMarketRemote(client(), "NOW", { warn: vi.fn() })).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
      expect(marketReads(urls)).not.toContain(null);
    });

    it("a malformed row next to a valid one is handled as in the listing (skipped, warned)", async () => {
      // No status: unreadable before the duplicate rule → skipped, NOW-USD is the only NOW row.
      const noStatus = mk("NOW_24_5-USD", "ACTIVE") as Record<string, unknown>;
      delete noStatus.status;
      let table: Record<string, Record<string, unknown>> = { "NOW-USD": mk("NOW-USD", "ACTIVE"), "NOW_24_5-USD": noStatus };
      const warn = vi.fn();
      expect(await remotePick(table, "NOW", warn)).toBe("NOW-USD");
      expect(listingPick(table, "NOW")).toBe("NOW-USD");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed"));
      // A listed ACTIVE row with a broken trading config still counts in the duplicate rule (two
      // ACTIVE NOW rows → both skipped), in the listing and here alike.
      const badConfig = mk("NOW_24_5-USD", "ACTIVE") as unknown as { tradingConfig: Record<string, unknown> };
      delete badConfig.tradingConfig.minPriceChange;
      table = { "NOW-USD": mk("NOW-USD", "ACTIVE"), "NOW_24_5-USD": badConfig as unknown as Record<string, unknown> };
      expect(await remotePick(table, "NOW")).toBe(listingPick(table, "NOW"));
      expect(listingPick(table, "NOW")).toBe("SYMBOL_NOT_FOUND");
    });
  });

  it("a candidate that is not a listed perpetual (DELISTED NOW_24_5-USD) is not accepted", async () => {
    venueMock();
    const c = new ExtendedClient(getVenue("extended").networks.mainnet.restUrl, getVenue("extended").rateLimit, "extended:test");
    // NOW-USD is PRELISTED and NOW_24_5-USD DELISTED in the recorded listing → neither is a market.
    await expect(resolveExtendedMarketRemote(c, "NOW", { warn: vi.fn() })).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
  });

  it("an error other than 1001 is thrown as is (no fallback)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, "unavailable"));
    const c = new ExtendedClient(getVenue("extended").networks.mainnet.restUrl, getVenue("extended").rateLimit, "extended:test");
    await expect(resolveExtendedMarketRemote(c, "BTC", { warn: vi.fn() })).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR", details: { status: 503 } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("transport", () => {
  const client = () => new ExtendedClient("https://api.example.test/api/v1", { capacity: 100, refillPerSec: 100, weights: null }, "extended:test");

  it("sends the mandatory User-Agent", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "OK", data: [] }));
    await client().get("/info/markets");
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["user-agent"]).toBe("perp-cli");
  });

  it("{status:ERROR} (HTTP 400, code 1001 Market not found) → EXCHANGE_ERROR with the venue code", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { status: "ERROR", error: { code: 1001, message: "Market not found" } }));
    await expect(client().get("/info/NOPE-USD/funding")).rejects.toMatchObject({
      structured: { code: "EXCHANGE_ERROR", details: { exchange: "extended", status: 400, venueCode: 1001 } },
    });
  });

  it("429 → RATE_LIMITED; non-JSON / no status OK → EXCHANGE_ERROR; transport failure → EXCHANGE_UNREACHABLE", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, "slow down", { "retry-after": "2" }));
    await expect(client().get("/info/markets")).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, "<html>"));
    await expect(client().get("/info/markets")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    await expect(client().get("/info/markets")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client().get("/info/markets")).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
  });

  it("testnet reads the Sepolia host", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, MARKETS));
    await fetchExtendedMarkets("testnet", { warn: vi.fn() });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.starknet.sepolia.extended.exchange/api/v1/info/markets");
  });
});

describe("health + funding comparison inclusion", () => {
  it("perp health probes Extended through its market read, as an OFFICIAL venue, on mainnet and testnet", async () => {
    const def = listVenues().find(v => v.id === "extended")!;
    const spy = vi.spyOn(def.publicData, "fetchMarkets").mockResolvedValue([]);
    for (const net of ["mainnet", "testnet"] as const) {
      const h = await probeVenueHealth(net, ["extended"]);
      expect(h.skipped).toEqual([]);
      expect(h.probes).toEqual([expect.objectContaining({ venue: "extended", ok: true, probe: "markets", status: null, error: null, apiStatus: "official" })]);
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("funding comparison: Extended is left out by default (unverified) and shown only with includeUnverified", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, MARKETS));
    const dflt = await fetchVenuesRates([getVenue("extended")], "mainnet", false);
    expect(dflt).toEqual({ rates: [], exchangeStatus: {}, exchangeErrors: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    const { rates, exchangeStatus } = await fetchVenuesRates([getVenue("extended")], "mainnet", true);
    expect(exchangeStatus).toEqual({ extended: "ok" });
    const btc = rates.find(r => r.canonical === "BTC")!;
    expect(btc).toMatchObject({ exchange: "extended", hourlyRate: 0.000013, apiStatus: "official", fundingVerified: false });
    expect(btc.annualizedPct).toBeCloseTo(0.000013 * 8760 * 100, 9);
    // Unmatchable markets (canonical null) never enter the comparison.
    expect(rates.find(r => r.symbol === "PURR")).toBeUndefined();
    expect(rates.find(r => r.symbol === "SPX")).toBeUndefined();
    expect(rates.find(r => r.canonical === "SPX")?.symbol).toBe("SPX500M");
  });

  it("fetchExtendedFundingRates reads one /info/markets call", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, MARKETS));
    const rows = await fetchExtendedFundingRates("mainnet", { warn: vi.fn() });
    expect(rows.length).toBeGreaterThan(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("write-refusal table: -e extended writes refuse before any I/O", () => {
  type Env = { ok: boolean; error?: { code: string; message: string; remediation?: string } };
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
    ["-e", "extended", "trade", "market", "BTC", "buy", "0.001"],
    ["-e", "ext", "trade", "buy", "BTC", "0.001"],
    ["-e", "extended", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["--dry-run", "-e", "extended", "trade", "market", "BTC", "buy", "0.001"],
    ["--dry-run", "-e", "extended", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["-e", "extended", "trade", "cancel", "BTC", "123"],
    ["-e", "extended", "trade", "cancel-all"],
    ["-e", "extended", "trade", "leverage", "BTC", "5"],
    ["-e", "extended", "trade", "close", "BTC"],
    ["-e", "extended", "trade", "tpsl", "BTC", "long", "--tp", "90000"],
    ["-e", "extended", "trade", "stop", "BTC", "sell", "0.001", "70000"],
    ["-e", "extended", "portfolio"],
    ["-e", "extended", "account", "positions"],
    ["-e", "extended", "account", "orders"],
    ["-e", "extended", "account", "trades"],
    ["funds", "deposit", "extended", "10"],
    ["funds", "withdraw", "extended", "10"],
    ["--dry-run", "funds", "deposit", "extended", "10"],
    ["--dry-run", "funds", "withdraw", "extended", "10"],
    ["-e", "extended", "funds", "transfer", "10", "0x0000000000000000000000000000000000000001"],
    ["funds", "rebalance", "execute", "--exchanges", "extended,hyperliquid"],
    ["wallet", "agent", "approve", "extended"],
    ["wallet", "agent", "import", "extended"],
    ["wallet", "agent", "revoke", "extended", "x"],
    ["wallet", "builder", "approve", "extended"],
    ["-e", "extended", "strategy", "twap", "BTC", "buy", "0.01", "10m"],
    ["-e", "extended", "strategy", "grid", "BTC", "--upper", "90000", "--lower", "80000", "--grids", "5", "--size", "0.001"],
    ["arb", "exec", "BTC", "extended", "hyperliquid", "10"],
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

  it("the venue-role refusal carries the read-only remediation", async () => {
    const { env } = await run(["-e", "extended", "trade", "market", "BTC", "buy", "0.001"]);
    expect(env.error!.remediation).toBe(EXTENDED_READ_ONLY_REMEDIATION);
    const funds = await run(["--dry-run", "funds", "withdraw", "extended", "10"]);
    expect(funds.env.error!.remediation).toBe(EXTENDED_READ_ONLY_REMEDIATION);
  });
});

describe("background jobs", () => {
  it("startJob refuses an Extended job (venue or exchange, any alias / case) before tmux is touched", () => {
    const base = { strategy: "twap", exchange: "extended", network: "mainnet" as const, dryRun: false, cliArgs: [], params: {}, selectors: { ows: null, wallet: null, noAgent: false, dex: null, noBuilder: false } };
    for (const o of [base, { ...base, exchange: "hyperliquid", venue: "EXT" }, { ...base, exchange: "X10" }]) {
      let err: unknown = null;
      try { startJob(o as never); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PerpError);
      const e = err as PerpError;
      expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(e.message).toMatch(/^Background job "twap" refused: Extended has no trading in perp-cli — /);
      expect(e.structured.remediation).toBe(EXTENDED_READ_ONLY_REMEDIATION);
    }
  });
});

describe("market list human table: Class column", () => {
  const human = async (rows: unknown[]): Promise<string> => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(ExtendedPublicAdapter.prototype, "getMarkets").mockResolvedValue(rows as never);
    try {
      const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
      await program.parseAsync(["node", "perp", "-e", "extended", "market", "list"]);
    } finally {
      vi.restoreAllMocks();
      vi.stubGlobal("fetch", fetchMock);
    }
    return out.join("\n");
  };
  const base = { symbol: "BTC", markPrice: "1", indexPrice: null, fundingRate: null, volume24h: null, openInterest: null, maxLeverage: 5, sizeDecimals: 0, stepSize: "1", fundingHours: 1, marginTiers: null };

  it("shown when every row has an assetClass", async () => {
    const t = await human([{ ...base, assetClass: "crypto" }, { ...base, symbol: "TSLA", assetClass: "equity" }]);
    expect(t).toContain("Class");
    expect(t).toContain("equity");
  });

  it("not shown when a row has none", async () => {
    const t = await human([{ ...base, assetClass: "crypto" }, { ...base, symbol: "TSLA" }]);
    expect(t).not.toContain("Class");
  });
});
