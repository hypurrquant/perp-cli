/**
 * Variational (Omni) — market data only, OFFICIAL read-only API: parsing of a recorded
 * /metadata/v2/stats payload (live 2026-10-19, trimmed to 16 listings), funding semantics / units,
 * null handling, symbol mapping, the RFQ-quote book, the rate limit + shared cache (one request
 * serves many commands), health, the funding comparison, and the write-refusal table (every write
 * path refuses with CAPABILITY_UNSUPPORTED and makes zero network calls, also with --dry-run).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const mem = vi.hoisted(() => new Map<string, { ts: number; ttl: number; data: unknown }>());
vi.mock("../../cache.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../cache.js")>();
  return {
    ...orig,
    getCached: (key: string) => {
      const e = mem.get(key);
      return e !== undefined && Date.now() - e.ts < e.ttl ? e.data : null;
    },
    setCached: (key: string, data: unknown, ttl: number) => { mem.set(key, { ts: Date.now(), ttl, data }); },
  };
});

import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenue, requireCapabilities, resolveVenueId } from "../../exchanges/venue.js";
import { rateToHourly } from "../../exchanges/venue-types.js";
import { VariationalClient } from "../../exchanges/variational/client.js";
import {
  fetchVariationalFundingRates, fetchVariationalMarkets, parseVariationalStats, perpRateConsistent, resolveVariationalListing,
  statsCacheKey, toVariationalVenueMarket, VARIATIONAL_STATS_TTL_MS, type VariationalPublicDeps,
} from "../../exchanges/variational/public.js";
import { VariationalPublicAdapter } from "../../exchanges/variational/adapter.js";
import { fetchVenuesRates } from "../../funding/rates.js";
import { probeVenueHealth } from "../../venue-health.js";
import { buildProgram } from "../../cli-program.js";

const FIXTURE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/variational/stats-v2.json"), "utf-8")) as {
  listings: Array<Record<string, unknown>>;
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const listing = (ticker: string) => clone(FIXTURE.listings.find(l => l.ticker === ticker)!);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Injected deps: in-memory cache, counted stats calls, captured warnings. */
function deps(body: unknown = FIXTURE): VariationalPublicDeps & { calls: () => number; warns: string[]; store: Map<string, unknown> } {
  let n = 0;
  const store = new Map<string, unknown>();
  const warns: string[] = [];
  return {
    stats: async () => { n++; return clone(body); },
    cache: { get: k => store.get(k) ?? null, set: (k, v) => { store.set(k, v); } },
    warn: m => { warns.push(m); },
    calls: () => n,
    warns,
    store,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mem.clear();
  fetchMock = vi.fn(async (url: string) => { throw new Error(`unexpected network call: ${url}`); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.exitCode = 0;
});

describe("Variational venue definition", () => {
  it("is market-data only, OFFICIAL API, funding verified by its documented unit, aliases var / omni, no testnet / ws", () => {
    const def = getVenue("variational");
    expect(def.roles).toEqual(["marketData"]);
    expect(def.capabilities).toBeNull();
    expect(def.apiStatus).toEqual({ kind: "official" });
    expect(def.fundingVerified).toBe(true);
    expect(def.fundingRateBasis).toBe("perMarket");
    expect(resolveVenueId("var")).toBe("variational");
    expect(resolveVenueId("omni")).toBe("variational");
    expect(def.networks.testnet).toBeNull();
    expect(def.networks.mainnet.restUrl).toBe("https://omni-client-api.prod.ap-northeast-1.variational.io");
    expect(def.networks.mainnet.wsUrl).toBeNull();
    // Documented: 10 requests / 10 s per IP.
    expect(def.rateLimit).toEqual({ capacity: 10, refillPerSec: 1, weights: null });
  });

  it("requireCapabilities refuses with CAPABILITY_UNSUPPORTED and the read-only remediation", () => {
    let err: unknown;
    try { requireCapabilities(getVenue("variational")); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PerpError);
    const s = (err as PerpError).structured;
    expect(s.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(s.remediation).toMatch(/^Variational is read-only \(market data\) in perp-cli; Variational has no public trading API yet/);
  });
});

describe("parsing the recorded stats payload", () => {
  it("parses every listing; perp symbol = base, swap keeps its suffix; nothing dropped", () => {
    const warn = vi.fn();
    const ls = parseVariationalStats(FIXTURE, warn);
    expect(warn).not.toHaveBeenCalled();
    expect(ls).toHaveLength(FIXTURE.listings.length);
    expect(ls.map(l => l.symbol)).toEqual(expect.arrayContaining(["BTC", "XAU", "XAU-SWAP", "US500", "US500-SWAP", "OPN_OPINION"]));
    const btc = ls.find(l => l.ticker === "BTC-PERP")!;
    expect(btc).toMatchObject({ contractType: "perpetual", symbol: "BTC", name: "Bitcoin", markPrice: listing("BTC-PERP").mark_price });
    expect(btc.quotes!.tiers.map(t => t.tier)).toEqual(["base", "size_1k", "size_100k", "size_1m"]);
    expect(btc.quotes!.tiers.map(t => t.notionalUsd)).toEqual([null, "1000", "100000", "1000000"]);
    // Decimal values stay the venue's strings.
    for (const t of btc.quotes!.tiers) { expect(typeof t.bid).toBe("string"); expect(typeof t.ask).toBe("string"); }
  });

  it("asset class and canonical symbols: ticker identity for crypto / equity, explicit commodities, SPY override, swaps / pre-IPO never matched", () => {
    const ls = parseVariationalStats(FIXTURE, vi.fn());
    const by = (t: string) => ls.find(l => l.ticker === t)!;
    expect(by("BTC-PERP")).toMatchObject({ assetClass: "crypto", canonical: "BTC" });
    expect(by("SPX-PERP")).toMatchObject({ assetClass: "crypto", canonical: "SPX" }); // SPX6900 (same token as HL SPX)
    expect(by("US500-PERP")).toMatchObject({ assetClass: "etf", canonical: "SPY" }); // SPDR S&P 500 ETF, not the index
    expect(by("XAU-PERP")).toMatchObject({ assetClass: "commodity", canonical: "GOLD" });
    expect(by("CL-PERP")).toMatchObject({ assetClass: "commodity", canonical: "CRUDE_OIL_WTI" });
    expect(by("AAPL-PERP")).toMatchObject({ assetClass: "equity", canonical: "AAPL" });
    expect(by("QQQ-PERP")).toMatchObject({ assetClass: "etf", canonical: "QQQ" });
    expect(by("QNTX-PERP")).toMatchObject({ assetClass: "equity", canonical: "QNTX" });
    expect(by("ANTHROPIC-PERP")).toMatchObject({ assetClass: "preIpo", canonical: null });
    expect(by("XAU-SWAP")).toMatchObject({ assetClass: "commodity", canonical: null });
    expect(by("US500-SWAP")).toMatchObject({ assetClass: "index", canonical: null });
    expect(by("DXI-SWAP")).toMatchObject({ assetClass: "fx", canonical: null });
  });

  it("an unclassified TradFi-looking perp is equity with NO canonical (never merged by ticker)", () => {
    const row = { ...listing("AAPL-PERP"), ticker: "NEWCO-PERP", name: "Newco Holdings, Inc." };
    const [l] = parseVariationalStats({ listings: [row] }, vi.fn());
    expect(l).toMatchObject({ symbol: "NEWCO", assetClass: "equity", canonical: null });
    const [c] = parseVariationalStats({ listings: [{ ...listing("STO-PERP"), ticker: "NEWTOKEN-PERP", name: "New Token" }] }, vi.fn());
    expect(c).toMatchObject({ assetClass: "crypto", canonical: "NEWTOKEN" });
  });

  it("a malformed listing is dropped with a warning naming it; an unknown contract type / unclassified swap is skipped", () => {
    const warn = vi.fn();
    const rows = [
      listing("BTC-PERP"),
      { ...listing("ETH-PERP"), mark_price: 2371.5 },                // number, not a decimal string
      { ...listing("STO-PERP"), contract_type: "future" },          // unknown type
      { ...listing("XAU-SWAP"), ticker: "ZZZ-SWAP" },               // unclassified swap
      { ...listing("ERA-PERP"), contract_type: "swap" },            // suffix disagrees with type
    ];
    const ls = parseVariationalStats({ listings: rows }, warn);
    expect(ls.map(l => l.ticker)).toEqual(["BTC-PERP"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/dropped 4 listing/);
    expect(msg).toMatch(/ETH-PERP \(mark_price is not a decimal string\)/);
    expect(msg).toMatch(/STO-PERP \(unknown contract_type future\)/);
    expect(msg).toMatch(/ZZZ-SWAP \(unclassified swap market\)/);
    expect(msg).toMatch(/ERA-PERP \(ticker suffix PERP disagrees/);
  });

  it("payload drift (not an object / no listings array) is EXCHANGE_ERROR, never an empty list", () => {
    for (const body of [null, [], "x", { listings: {} }, {}]) {
      expect(() => parseVariationalStats(body, vi.fn())).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
    }
  });
});

describe("funding semantics and units", () => {
  it("perp: fundingRate = funding.last.interval_rate (per interval), basis perHours(interval_seconds / 3600), per market", async () => {
    const d = deps();
    const ms = await fetchVariationalMarkets("mainnet", d);
    const btc = ms.find(m => m.symbol === "BTC")!;
    const btcRaw = listing("BTC-PERP").funding as { last: { interval_rate: string; annualized_rate: string } };
    expect(btc.fundingRate).toBe(btcRaw.last.interval_rate);
    expect(btc.fundingRateBasis).toEqual({ kind: "perHours", hours: 8 });
    expect(btc.settlementIntervalHours).toBe(8);
    const era = ms.find(m => m.symbol === "ERA")!;
    expect(era.fundingRateBasis).toEqual({ kind: "perHours", hours: 1 });
    const sto = ms.find(m => m.symbol === "STO")!;
    expect(sto.fundingRateBasis).toEqual({ kind: "perHours", hours: 4 });
    // Hourly normalization agrees with the venue's annualized rate (rate × 365 d / interval).
    const hourly = rateToHourly(Number(btc.fundingRate), btc.fundingRateBasis);
    expect(hourly * 24 * 365).toBeCloseTo(Number(btcRaw.last.annualized_rate), 4);
  });

  it("STO's baseline 0.1095 annualized over 4h is 0.000050 per interval (0.00125 %/h)", () => {
    expect(perpRateConsistent({ annualized: "0.1095", interval: "0.000050" }, 14_400)).toBe(true);
    expect(rateToHourly(0.00005, { kind: "perHours", hours: 4 })).toBeCloseTo(0.0000125, 12);
  });

  it("a perp whose interval and annualized rates disagree (unit drift) gets NO rate and a warning", async () => {
    const bad = listing("BTC-PERP");
    (bad.funding as { last: { interval_rate: string } }).last.interval_rate = "0.0082"; // 100× off
    const d = deps({ listings: [bad] });
    const [m] = await fetchVariationalMarkets("mainnet", d);
    expect(m.fundingRate).toBeNull();
    expect(d.warns.join("\n")).toMatch(/BTC-PERP: interval_rate 0\.0082 disagrees with annualized_rate/);
    expect(await fetchVariationalFundingRates("mainnet", deps({ listings: [bad] }))).toEqual([]);
  });

  it("funding rows: tradable perps with a rate only; nextFundingTime in ms; swaps excluded (no single rate)", async () => {
    const rows = await fetchVariationalFundingRates("mainnet", deps());
    expect(rows.some(r => r.symbol.endsWith("-SWAP"))).toBe(false);
    const btc = rows.find(r => r.symbol === "BTC")!;
    const raw = listing("BTC-PERP").funding as { next_timestamp: number };
    expect(btc).toMatchObject({ venue: "variational", venueSymbol: "BTC-PERP", canonical: "BTC", basis: { kind: "perHours", hours: 8 }, nextFundingTime: raw.next_timestamp * 1000 });
    expect(typeof btc.rate).toBe("string");
    expect(rows.find(r => r.symbol === "ANTHROPIC")!.canonical).toBeNull();
  });

  it("swap funding: long / short rates kept on the Variational row, fundingRate null, next / next_timestamp nullable", async () => {
    const a = new VariationalPublicAdapter(getVenue("variational"), "mainnet");
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    const t = await a.getFundingTerms("xau-swap");
    expect(t).toMatchObject({ contractType: "swap", rateKind: null, intervalRate: null, hourlyRate: null, intervalHours: 24 });
    expect(t.swap!.last).toMatchObject({ annualizedLong: expect.any(String), annualizedShort: expect.any(String) });
    const xau = (await a.getMarkets()).find(m => m.symbol === "XAU-SWAP")!;
    expect(xau.fundingRate).toBeNull();
    expect(xau.swapFunding).not.toBeNull();
  });

  it("perp funding terms: per interval, hourly and APR % like arb scan, rateKind predicted", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    const a = new VariationalPublicAdapter(getVenue("variational"), "mainnet");
    const t = await a.getFundingTerms("ETH");
    const raw = listing("ETH-PERP").funding as { last: { interval_rate: string; annualized_rate: string }; interval_seconds: number; next_timestamp: number };
    expect(t).toMatchObject({ kind: "variationalCurrentFunding", ticker: "ETH-PERP", rateKind: "predicted", intervalRate: raw.last.interval_rate, intervalHours: 8, nextFundingTime: raw.next_timestamp * 1000, venueAnnualizedRate: raw.last.annualized_rate });
    expect(t.hourlyRate).toBeCloseTo(Number(raw.last.interval_rate) / 8, 15);
    expect(t.annualizedPct).toBeCloseTo(Number(raw.last.interval_rate) / 8 * 8760 * 100, 9);
  });
});

describe("null handling (unknown is null, never 0)", () => {
  it("no index / tick / lot / leverage / base-unit OI is published → null; USD OI kept as strings", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    const a = new VariationalPublicAdapter(getVenue("variational"), "mainnet");
    const btc = (await a.getMarkets()).find(m => m.symbol === "BTC")!;
    expect(btc).toMatchObject({ indexPrice: null, openInterest: null, maxLeverage: null, stepSize: null, sizeDecimals: null, marginTiers: null, fundingHours: 8, venueApi: "official", fundingRateKind: "predicted" });
    expect(btc.openInterestUsd).toEqual({ long: expect.any(String), short: expect.any(String) });
    const vm = (await fetchVariationalMarkets("mainnet", deps())).find(m => m.symbol === "BTC")!;
    expect(vm).toMatchObject({ indexPrice: null, openInterest: null, tickSize: null, stepSize: null, minSize: null, minNotional: null, maxLeverage: null, quoteAsset: "USDC" });
  });

  it("documented omissions: no quotes → not tradable, no name / spread → null", async () => {
    const row = listing("AAPL-PERP");
    delete row.quotes; delete row.name; delete row.base_spread_bps;
    const [l] = parseVariationalStats({ listings: [row] }, vi.fn());
    expect(l).toMatchObject({ quotes: null, name: null, baseSpreadBps: null });
    expect(toVariationalVenueMarket(l, vi.fn())!.tradable).toBe(false);
    // A missing individual quote size is simply absent.
    const r2 = listing("BTC-PERP");
    delete (r2.quotes as Record<string, unknown>).size_1m;
    const [l2] = parseVariationalStats({ listings: [r2] }, vi.fn());
    expect(l2.quotes!.tiers.map(t => t.tier)).toEqual(["base", "size_1k", "size_100k"]);
  });

  it("funding null: listed on the adapter with funding N/A, but left out of VenueMarket rows (interval unknown) with a warning", async () => {
    const row = { ...listing("ETH-PERP"), funding: null };
    const d = deps({ listings: [row, listing("BTC-PERP")] });
    const ms = await fetchVariationalMarkets("mainnet", d);
    expect(ms.map(m => m.symbol)).toEqual(["BTC"]);
    expect(d.warns.join("\n")).toMatch(/1 market\(s\) publish no funding terms .*ETH-PERP/);
    fetchMock.mockResolvedValue(jsonResponse(200, { listings: [row] }));
    const [eth] = await new VariationalPublicAdapter(getVenue("variational"), "mainnet").getMarkets();
    expect(eth).toMatchObject({ symbol: "ETH", fundingRate: null, fundingHours: null, nextFundingTime: null, fundingRateKind: null });
  });

  it("funding is documented as always present: a listing without the key is dropped (shape drift)", () => {
    const row = listing("BTC-PERP");
    delete row.funding;
    const warn = vi.fn();
    expect(parseVariationalStats({ listings: [row] }, warn)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toMatch(/funding is missing/);
  });
});

describe("symbol mapping", () => {
  const ls = parseVariationalStats(FIXTURE, () => undefined);
  it("resolves btc / BTC-PERP / xau-swap; XAU is the perp, not the swap", () => {
    expect(resolveVariationalListing(ls, "btc").ticker).toBe("BTC-PERP");
    expect(resolveVariationalListing(ls, "BTC-PERP").ticker).toBe("BTC-PERP");
    expect(resolveVariationalListing(ls, "xau-swap").ticker).toBe("XAU-SWAP");
    expect(resolveVariationalListing(ls, "XAU").ticker).toBe("XAU-PERP");
    expect(resolveVariationalListing(ls, "opn_opinion").ticker).toBe("OPN_OPINION-PERP");
  });
  it("an unknown symbol is SYMBOL_NOT_FOUND with the listing command", () => {
    let err: unknown;
    try { resolveVariationalListing(ls, "NOPE"); } catch (e) { err = e; }
    expect((err as PerpError).structured).toMatchObject({ code: "SYMBOL_NOT_FOUND", remediation: "List markets: perp -e variational market list" });
  });
});

describe("VariationalClient error mapping", () => {
  const client = () => new VariationalClient("https://x.test", getVenue("variational").rateLimit);
  it("HTTP 429 → RATE_LIMITED with retry_after_seconds from the documented body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { retry_after_seconds: 7 }));
    await expect(client().stats()).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: expect.objectContaining({ retryAfterMs: 7000 }) } });
  });
  it("HTTP 5xx → EXCHANGE_ERROR; network failure → EXCHANGE_UNREACHABLE; non-JSON → EXCHANGE_ERROR (shape)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, "busy"));
    await expect(client().stats()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(client().stats()).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(client().stats()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR", message: expect.stringMatching(/not JSON/) } });
  });
  it("calls GET /metadata/v2/stats", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    await client().stats();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://x.test/metadata/v2/stats");
  });
});

describe("rate limit and shared cache: one request serves many reads", () => {
  it("concurrent markets + funding reads share ONE in-flight request; within the TTL the cache serves; after it, one new request", async () => {
    const d = deps();
    await Promise.all([fetchVariationalMarkets("mainnet", d), fetchVariationalFundingRates("mainnet", d), fetchVariationalMarkets("mainnet", d)]);
    expect(d.calls()).toBe(1);
    await fetchVariationalFundingRates("mainnet", d);
    expect(d.calls()).toBe(1);
    expect(d.store.has(statsCacheKey("mainnet"))).toBe(true);
    d.store.clear(); // TTL expiry
    await fetchVariationalMarkets("mainnet", d);
    expect(d.calls()).toBe(2);
  });

  it("a failed request is never cached or replaced by stale data: the error surfaces, the next read retries live", async () => {
    let n = 0;
    const d = { ...deps(), stats: async () => { n++; if (n === 1) throw new PerpError("EXCHANGE_UNREACHABLE", "down"); return clone(FIXTURE); } };
    await expect(fetchVariationalMarkets("mainnet", d)).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
    expect(d.store.size).toBe(0);
    expect((await fetchVariationalMarkets("mainnet", d)).length).toBeGreaterThan(0);
    expect(n).toBe(2);
  });

  it("the cache holds only the raw JSON body (JSON-safe) with the short TTL", async () => {
    const set = vi.fn();
    const d = { ...deps(), cache: { get: () => null, set } };
    await fetchVariationalMarkets("mainnet", d);
    expect(set).toHaveBeenCalledWith(statsCacheKey("mainnet"), FIXTURE, VARIATIONAL_STATS_TTL_MS);
    expect(VARIATIONAL_STATS_TTL_MS).toBeLessThanOrEqual(10_000);
    expect(JSON.parse(JSON.stringify(set.mock.calls[0][1]))).toEqual(FIXTURE);
  });

  it("CLI: market list + info + book + funding + prices inside the window cost ONE HTTP request", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    for (const args of [["market", "list"], ["market", "info", "BTC"], ["market", "book", "BTC"], ["market", "funding", "ETH"], ["market", "prices"]]) {
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
      const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
      await program.parseAsync(["node", "perp", "--json", "-e", "variational", ...args]);
      vi.restoreAllMocks();
      vi.stubGlobal("fetch", fetchMock);
      expect(JSON.parse(out.join("")).ok).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("every request takes a limiter token (10 / 10 s): a burst beyond the bucket waits for refill", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse(200, FIXTURE));
    const c = new VariationalClient("https://x.test", getVenue("variational").rateLimit);
    const all = Promise.all(Array.from({ length: 12 }, () => c.stats()));
    await vi.advanceTimersByTimeAsync(0);
    const immediate = fetchMock.mock.calls.length;
    expect(immediate).toBeLessThanOrEqual(10);
    expect(immediate).toBeLessThan(12);
    await vi.advanceTimersByTimeAsync(15_000);
    await all;
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });
});

describe("market book: RFQ quotes, not an order book", () => {
  it("getOrderbook refuses (no order book); market book returns the labelled indicative quotes", async () => {
    const a = new VariationalPublicAdapter(getVenue("variational"), "mainnet");
    await expect(a.getOrderbook()).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    const q = await a.getRfqQuotes("btc");
    expect(q).toMatchObject({ kind: "rfqQuotes", venue: "variational", ticker: "BTC-PERP", updatedAt: expect.any(String) });
    expect(q.quotes[3]).toMatchObject({ tier: "size_1m", notionalUsd: "1000000" });
    expect(q.note).toMatch(/RFQ venue.*INDICATIVE quotes.*not order-book levels/);
    // A closed swap publishes no quotes: empty, with updatedAt null.
    expect(await a.getRfqQuotes("XAU-SWAP")).toMatchObject({ quotes: [], updatedAt: null });
  });
});

describe("health and the funding comparison", () => {
  it("perp health probes Variational through its market-data read, tagged official", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    const h = await probeVenueHealth("mainnet", ["variational"]);
    expect(h.probes).toEqual([expect.objectContaining({ venue: "variational", ok: true, probe: "markets", status: null, error: null, apiStatus: "official" })]);
    const t = await probeVenueHealth("testnet", ["variational"]);
    expect(t.skipped.map(s => s.venue)).toEqual(["variational"]);
  });

  it("a failing stats read is a health failure with its message", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, "down"));
    const h = await probeVenueHealth("mainnet", ["variational"]);
    expect(h.probes[0]).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 500/) });
  });

  it("arb funding comparison includes Variational rows by default (verified, official), normalized per market interval", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE));
    const { rates, exchangeStatus } = await fetchVenuesRates([getVenue("variational")], "mainnet", false);
    expect(exchangeStatus).toEqual({ variational: "ok" });
    const btc = rates.find(r => r.canonical === "BTC")!;
    expect(btc).toMatchObject({ exchange: "variational", apiStatus: "official", fundingVerified: true, basis: { kind: "perHours", hours: 8 } });
    expect(btc.hourlyRate).toBeCloseTo(btc.fundingRate / 8, 15);
    expect(rates.find(r => r.canonical === "SPY")!.symbol).toBe("US500");
    expect(rates.some(r => r.symbol.endsWith("-SWAP") || r.symbol === "ANTHROPIC")).toBe(false);
  });
});

describe("write-refusal table: -e variational writes refuse before any I/O", () => {
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
    ["-e", "variational", "trade", "market", "BTC", "buy", "0.001"],
    ["--dry-run", "-e", "variational", "trade", "market", "BTC", "buy", "0.001"],
    ["-e", "var", "trade", "buy", "BTC", "0.001"],
    ["-e", "variational", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["--dry-run", "-e", "variational", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["-e", "variational", "trade", "cancel", "BTC", "123"],
    ["-e", "variational", "trade", "cancel-all"],
    ["-e", "variational", "trade", "leverage", "BTC", "5"],
    ["-e", "variational", "trade", "close", "BTC"],
    ["-e", "variational", "trade", "tpsl", "BTC", "long", "--tp", "90000"],
    ["-e", "variational", "trade", "stop", "BTC", "sell", "0.001", "70000"],
    ["-e", "variational", "portfolio"],
    ["-e", "variational", "account", "positions"],
    ["-e", "variational", "account", "orders"],
    ["-e", "variational", "account", "trades"],
    ["funds", "deposit", "variational", "10"],
    ["--dry-run", "funds", "deposit", "variational", "10"],
    ["funds", "withdraw", "variational", "10"],
    ["--dry-run", "funds", "withdraw", "variational", "10"],
    ["-e", "variational", "funds", "transfer", "10", "0x0000000000000000000000000000000000000001"],
    ["funds", "rebalance", "execute", "--exchanges", "variational,hyperliquid"],
    ["wallet", "agent", "approve", "variational"],
    ["wallet", "agent", "import", "variational"],
    ["wallet", "agent", "revoke", "variational", "x"],
    ["wallet", "builder", "approve", "variational"],
    ["-e", "variational", "strategy", "twap", "BTC", "buy", "0.01", "10m"],
    ["-e", "variational", "strategy", "grid", "BTC", "--upper", "90000", "--lower", "80000", "--grids", "5", "--size", "0.001"],
    ["-e", "variational", "strategy", "dca", "BTC", "buy", "10", "1h"],
    ["arb", "exec", "BTC", "variational", "hyperliquid", "10"],
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

  it("the refusal carries the read-only remediation", async () => {
    const { env } = await run(["-e", "variational", "trade", "market", "BTC", "buy", "0.001"]);
    expect(env.error!.remediation).toMatch(/^Variational is read-only \(market data\) in perp-cli; Variational has no public trading API yet/);
  });

  it("every public-only adapter account / trading method refuses and sends nothing; trades / klines / funding history are unsupported", async () => {
    const a = new VariationalPublicAdapter(getVenue("variational"), "mainnet");
    const calls: Array<() => Promise<unknown>> = [
      () => a.getBalance(), () => a.getPositions(), () => a.getOpenOrders(), () => a.getOrderHistory(), () => a.getTradeHistory(),
      () => a.getFundingPayments(), () => a.marketOrder(), () => a.limitOrder(), () => a.editOrder(), () => a.cancelOrder(),
      () => a.cancelAllOrders(), () => a.setLeverage(), () => a.stopOrder(), () => a.getFundingHistory(), () => a.getRecentTrades(),
      () => a.getKlines(), () => a.getOrderbook(),
    ];
    for (const c of calls) await expect(c()).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
