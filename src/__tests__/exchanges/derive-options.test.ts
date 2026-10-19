/**
 * Derive options (read-only): parsing of recorded mainnet responses (fixtures/derive, captured
 * 2026-10-18), null handling for empty sides / uncomputable IV / missing pricing, expiry and
 * strike selection, one get_tickers call per chain, unknown instrument / underlying / expiry →
 * SYMBOL_NOT_FOUND, the JSON-RPC error envelope, pagination, and the CLI / MCP surfaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PerpError } from "../../errors.js";
import { DERIVE_RATE_LIMIT, DeriveClient } from "../../exchanges/derive/client.js";
import {
  DeriveOptionsVenue, expiriesOf, normalizeExpiry, normalizeUnderlying, parseDeriveInstrument,
  parseDeriveOptionTicker, strikesAround,
} from "../../exchanges/derive/options.js";
import { getOptionsVenue } from "../../exchanges/options-venues.js";
import { buildProgram } from "../../cli-program.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "derive");
const fx = (name: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(FIX, name), "utf-8")) as Record<string, unknown>;

const INSTRUMENTS = fx("get_all_instruments.ETH.json");
const TICKERS_1019 = fx("get_tickers.ETH.20261019.json");
const INST_3500P = fx("get_instrument.ETH-20261225-3500-P.json");
const TICK_3500P = fx("get_ticker.ETH-20261225-3500-P.json");
const INST_PERP = fx("get_instrument.ETH-PERP.json");
const ERR_NOT_FOUND = fx("error.instrument_not_found.json");
const ERR_TICKER = fx("error.ticker_not_found.json");
const ERR_EXPIRY = fx("error.expiry_required.json");
const ERR_CURRENCY = fx("error.unknown_currency.json");
const CURRENCIES = fx("get_all_currencies.json");

type RawInst = Record<string, unknown> & { instrument_name: string; is_active: boolean; option_details: { expiry: number } };
const rawInstruments = (INSTRUMENTS.result as { instruments: RawInst[] }).instruments;
const rawTickers = (TICKERS_1019.result as { tickers: Record<string, Record<string, unknown>> }).tickers;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** fetch fake: method → body (or a function of the params); every call recorded. */
type Route = unknown | ((params: Record<string, unknown>) => unknown);
let calls: Array<{ method: string; params: Record<string, unknown> }>;
function routeFetch(routes: Record<string, Route>, status = 200): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string, init: { body: string }) => {
    const method = url.split("/public/")[1];
    const params = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, params });
    if (!(method in routes)) throw new Error(`unexpected Derive call ${method}`);
    const r = routes[method];
    return jsonResponse(status, typeof r === "function" ? (r as (p: Record<string, unknown>) => unknown)(params) : r);
  });
  vi.stubGlobal("fetch", f);
  return f;
}

/** A venue on a test base URL with its own (unthrottled) bucket. */
const testVenue = () => new DeriveOptionsVenue(new DeriveClient("mainnet", "https://derive.test/v3", { capacity: 1000, refillPerSec: 1000, weights: null }));

async function caught(p: Promise<unknown>): Promise<PerpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PerpError) return e;
    throw e;
  }
  throw new Error("expected a PerpError");
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ── parsing ──

describe("parseDeriveInstrument (recorded get_all_instruments)", () => {
  it("parses every recorded option instrument", () => {
    const all = rawInstruments.map(parseDeriveInstrument);
    expect(all).toHaveLength(142);
    const p = all.find(i => i.name === "ETH-20261225-3500-P");
    expect(p).toMatchObject({
      underlying: "ETH", quoteCurrency: "USDC", kind: "put", strike: "3500",
      expiryMs: 1_798_185_600_000, expiry: "2026-12-25", isActive: true,
    });
    expect(all.filter(i => !i.isActive).map(i => i.expiry)).toEqual(["2027-12-31", "2027-12-31", "2027-12-31", "2027-12-31"]);
  });

  it("shape drift is EXCHANGE_ERROR, never a guess", () => {
    const bad = clone(rawInstruments[0]);
    (bad.option_details as Record<string, unknown>).option_type = "X";
    expect(() => parseDeriveInstrument(bad)).toThrow(/option_type "X"/);
    const noStrike = clone(rawInstruments[0]);
    delete (noStrike.option_details as Record<string, unknown>).strike;
    try {
      parseDeriveInstrument(noStrike);
      throw new Error("no throw");
    } catch (e) {
      expect((e as PerpError).structured.code).toBe("EXCHANGE_ERROR");
    }
  });
});

describe("parseDeriveOptionTicker (recorded get_ticker / get_tickers)", () => {
  const inst = parseDeriveInstrument(INST_3500P.result);

  it("maps every field verbatim (strings), timestamp and trades as numbers", () => {
    const q = parseDeriveOptionTicker(TICK_3500P.result, inst);
    const t = TICK_3500P.result as Record<string, unknown> & { option_pricing: Record<string, string>; stats: Record<string, unknown> };
    expect(q).toMatchObject({
      schema: 1, venue: "derive", instrument: "ETH-20261225-3500-P", kind: "put", strike: "3500", expiry: "2026-12-25",
      bid: { price: t.b, size: t.B }, ask: { price: t.a, size: t.A }, mark: t.M, index: t.I,
      forward: t.option_pricing.f, discountFactor: t.option_pricing.df,
      greeks: { delta: t.option_pricing.d, gamma: t.option_pricing.g, theta: t.option_pricing.t, vega: t.option_pricing.v, rho: t.option_pricing.r },
      openInterest: t.stats.oi, timestampMs: t.t,
    });
    expect(q.iv.mark).toBe(t.option_pricing.i);
    for (const v of [q.mark, q.index, q.forward, q.greeks?.delta, q.openInterest]) expect(typeof v).toBe("string");
  });

  const all1019 = rawInstruments.filter(i => i.option_details.expiry === 1_792_396_800).map(parseDeriveInstrument);
  const quotes = all1019.map(i => parseDeriveOptionTicker(rawTickers[i.name], i));

  it("an empty book side (\"0\" / \"0\") is null, and so is its IV", () => {
    const emptyBid = all1019.filter(i => rawTickers[i.name].b === "0");
    expect(emptyBid.length).toBeGreaterThan(0);
    for (const i of emptyBid) {
      const q = quotes.find(x => x.instrument === i.name)!;
      expect(q.bid).toBeNull();
      expect(q.iv.bid).toBeNull();
    }
  });

  it("an IV the pricer could not compute (\"0\" with a live quote) is null, not 0", () => {
    const noIv = all1019.filter(i => rawTickers[i.name].b !== "0" && (rawTickers[i.name].option_pricing as Record<string, string>).bi === "0");
    expect(noIv.length).toBeGreaterThan(0);
    for (const i of noIv) {
      const q = quotes.find(x => x.instrument === i.name)!;
      expect(q.bid).not.toBeNull();
      expect(q.iv.bid).toBeNull();
    }
  });

  it("24h high / low are null without trades, verbatim with trades", () => {
    const traded = quotes.filter(q => q.stats24h.trades > 0);
    const quiet = quotes.filter(q => q.stats24h.trades === 0);
    expect(traded.length).toBeGreaterThan(0);
    expect(quiet.every(q => q.stats24h.high === null && q.stats24h.low === null)).toBe(true);
    for (const q of traded) expect(q.stats24h.high).toBe((rawTickers[q.instrument].stats as Record<string, string>).h);
  });

  it("real zeros stay \"0\": a delta of 0 and a mark of 0 are venue values, not unknowns", () => {
    const zeroDelta = all1019.filter(i => (rawTickers[i.name].option_pricing as Record<string, string>).d === "0");
    const zeroMark = all1019.filter(i => rawTickers[i.name].M === "0");
    expect(zeroDelta.length).toBeGreaterThan(0);
    expect(zeroMark.length).toBeGreaterThan(0);
    for (const i of zeroDelta) expect(quotes.find(x => x.instrument === i.name)!.greeks!.delta).toBe("0");
    for (const i of zeroMark) expect(quotes.find(x => x.instrument === i.name)!.mark).toBe("0");
  });

  it("no option_pricing → greeks / forward / IV null (never 0)", () => {
    const t = clone(TICK_3500P.result as Record<string, unknown>);
    t.option_pricing = null;
    const q = parseDeriveOptionTicker(t, inst);
    expect(q.greeks).toBeNull();
    expect(q.forward).toBeNull();
    expect(q.discountFactor).toBeNull();
    expect(q.iv).toEqual({ mark: null, bid: null, ask: null });
    expect(q.bid).not.toBeNull();
  });

  it("a missing or non-decimal field is EXCHANGE_ERROR", () => {
    const t = clone(TICK_3500P.result as Record<string, unknown>);
    delete t.M;
    expect(() => parseDeriveOptionTicker(t, inst)).toThrow(/\.M is not a string/);
    const t2 = clone(TICK_3500P.result as Record<string, unknown>);
    t2.b = "abc";
    expect(() => parseDeriveOptionTicker(t2, inst)).toThrow(/not a decimal/);
  });
});

// ── selection helpers ──

describe("expiry / strike selection", () => {
  it("expiriesOf: active expiries only, soonest first, distinct strikes counted", () => {
    const e = expiriesOf(rawInstruments.map(parseDeriveInstrument));
    expect(e.map(x => x.expiry)).toEqual(["2026-10-19", "2026-12-25"]);
    expect(e[0]).toEqual({ expiry: "2026-10-19", expiryMs: 1_792_396_800_000, strikes: 30, instruments: 60 });
    expect(e[1].instruments).toBe(78);
  });

  it("strikesAround: N closest to the reference, ascending, ties → lower strike", () => {
    const s = ["2000", "2100", "2200", "2300", "2400", "2500"];
    expect(strikesAround(s, "2249", 2)).toEqual(["2200", "2300"]);
    expect(strikesAround(s, "2250", 1)).toEqual(["2200"]);
    expect(strikesAround(s, "9999", 3)).toEqual(["2300", "2400", "2500"]);
    expect(strikesAround(s, "2250", 100)).toEqual(s);
  });

  it("normalizeExpiry accepts YYYY-MM-DD / YYYYMMDD, rejects impossible dates", () => {
    expect(normalizeExpiry("2026-12-25")).toBe("2026-12-25");
    expect(normalizeExpiry("20261225")).toBe("2026-12-25");
    for (const bad of ["2026-02-30", "2026-13-01", "Dec 25", "2026-1-5", "2026-1225", "202612-25"]) {
      expect(() => normalizeExpiry(bad)).toThrow(/Invalid expiry/);
    }
  });

  it("normalizeUnderlying upper-cases and rejects non-tickers", () => {
    expect(normalizeUnderlying(" eth ")).toBe("ETH");
    expect(() => normalizeUnderlying("ETH/USD")).toThrow(/Invalid underlying/);
  });
});

// ── venue (fetch faked with the recorded responses) ──

describe("DeriveOptionsVenue", () => {
  const tickersFor = (p: Record<string, unknown>) => (p.expiry_date === "20261019" ? TICKERS_1019 : { result: { tickers: {} } });

  it("chain (nearest expiry): one instruments + ONE get_tickers call, full rows, ATM from the forward", async () => {
    routeFetch({ get_all_instruments: INSTRUMENTS, get_tickers: tickersFor });
    const c = await testVenue().getChain({ underlying: "eth", expiry: null, strikesAroundAtm: null });
    expect(calls.map(x => x.method)).toEqual(["get_all_instruments", "get_tickers"]);
    expect(calls[0].params).toEqual({ instrument_type: "option", currency: "ETH", expired: false, page_size: 1000, page: 1 });
    expect(calls[1].params).toEqual({ instrument_type: "option", currency: "ETH", expiry_date: "20261019" });
    expect(c).toMatchObject({ schema: 1, venue: "derive", underlying: "ETH", expiry: "2026-10-19", expirySelection: "nearest", strikesListed: 30, missingTickers: [] });
    expect(c.rows).toHaveLength(30);
    expect(c.rows.map(r => Number(r.strike))).toEqual([...c.rows.map(r => Number(r.strike))].sort((a, b) => a - b));
    expect(c.rows.every(r => r.call?.kind === "call" && r.put?.kind === "put" && r.call.strike === r.strike)).toBe(true);
    // index / forward from the most recent ticker
    const latest = Object.values(rawTickers).reduce((a, b) => ((b.t as number) > (a.t as number) ? b : a));
    expect(c.forward).toBe((latest.option_pricing as Record<string, string>).f);
    expect(c.index).toBe(latest.I);
    expect(c.atm).not.toBeNull();
    expect(c.atm!.reference).toBe("forward");
    const strikes = c.rows.map(r => r.strike);
    expect(strikesAround(strikes, c.atm!.price, 1)).toEqual([c.atm!.strike]);
  });

  it("--strikes N keeps the N strikes closest to the ATM reference", async () => {
    routeFetch({ get_all_instruments: INSTRUMENTS, get_tickers: tickersFor });
    const c = await testVenue().getChain({ underlying: "ETH", expiry: "2026-10-19", strikesAroundAtm: 4 });
    expect(c.expirySelection).toBe("requested");
    expect(c.rows).toHaveLength(4);
    expect(c.strikesListed).toBe(30);
    expect(c.rows.map(r => r.strike)).toContain(c.atm!.strike);
  });

  it("a listed instrument without a ticker leaves its side null and is reported", async () => {
    const partial = clone(TICKERS_1019) as { result: { tickers: Record<string, unknown> } };
    delete partial.result.tickers["ETH-20261019-2400-C"];
    routeFetch({ get_all_instruments: INSTRUMENTS, get_tickers: partial });
    const c = await testVenue().getChain({ underlying: "ETH", expiry: null, strikesAroundAtm: null });
    expect(c.missingTickers).toEqual(["ETH-20261019-2400-C"]);
    const row = c.rows.find(r => r.strike === "2400")!;
    expect(row.call).toBeNull();
    expect(row.put).not.toBeNull();
  });

  it("an expiry that is not listed (or only listed inactive) → SYMBOL_NOT_FOUND naming the active expiries; no ticker call", async () => {
    routeFetch({ get_all_instruments: INSTRUMENTS });
    for (const expiry of ["2026-12-26", "2027-12-31"]) {
      const e = await caught(testVenue().getChain({ underlying: "ETH", expiry, strikesAroundAtm: null }));
      expect(e.structured.code).toBe("SYMBOL_NOT_FOUND");
      expect(e.structured.remediation).toContain("2026-10-19, 2026-12-25");
    }
    expect(calls.every(c => c.method === "get_all_instruments")).toBe(true);
  });

  it("--strikes with no ticker at all (ATM unknown) is an explicit error", async () => {
    routeFetch({ get_all_instruments: INSTRUMENTS, get_tickers: { result: { tickers: {} } } });
    const e = await caught(testVenue().getChain({ underlying: "ETH", expiry: "2026-12-25", strikesAroundAtm: 3 }));
    expect(e.structured.code).toBe("EXCHANGE_ERROR");
    expect(e.message).toMatch(/ATM strike/);
  });

  it("invalid --strikes is INVALID_PARAMS before any request", async () => {
    const f = routeFetch({});
    const e = await caught(testVenue().getChain({ underlying: "ETH", expiry: null, strikesAroundAtm: 0 }));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(f).not.toHaveBeenCalled();
  });

  it("unknown underlying (RPC 12001) → SYMBOL_NOT_FOUND", async () => {
    routeFetch({ get_all_instruments: ERR_CURRENCY });
    const e = await caught(testVenue().listExpiries("NOPE"));
    expect(e.structured.code).toBe("SYMBOL_NOT_FOUND");
    expect(e.structured.retryable).toBe(false);
    expect(e.structured.remediation).toContain("options underlyings");
  });

  it("expiries list from the recorded instruments", async () => {
    routeFetch({ get_all_instruments: INSTRUMENTS });
    const e = await testVenue().listExpiries("ETH");
    expect(e).toMatchObject({ schema: 1, venue: "derive", underlying: "ETH" });
    expect(e.expiries.map(x => x.expiry)).toEqual(["2026-10-19", "2026-12-25"]);
  });

  it("reads every page of get_all_instruments", async () => {
    const half = Math.ceil(rawInstruments.length / 2);
    routeFetch({
      get_all_instruments: (p: Record<string, unknown>) => ({
        result: {
          instruments: p.page === 1 ? rawInstruments.slice(0, half) : rawInstruments.slice(half),
          pagination: { num_pages: 2, count: rawInstruments.length },
        },
      }),
    });
    const e = await testVenue().listExpiries("ETH");
    expect(calls.map(c => c.params.page)).toEqual([1, 2]);
    expect(e.expiries.reduce((n, x) => n + x.instruments, 0)).toBe(138);
  });

  it("underlyings: currencies with an option asset, spot verbatim", async () => {
    routeFetch({ get_all_currencies: CURRENCIES });
    const u = await testVenue().listUnderlyings();
    expect(u.underlyings.map(x => x.underlying)).toEqual(["BTC", "ETH", "HYPE"]);
    const eth = (CURRENCIES.result as Array<Record<string, unknown>>).find(c => c.currency === "ETH")!;
    expect(u.underlyings[1].spotPrice).toBe(eth.spot_price);
  });

  it("quote: instrument + ticker", async () => {
    routeFetch({ get_instrument: INST_3500P, get_ticker: TICK_3500P });
    const q = await testVenue().getQuote("eth-20261225-3500-p");
    expect(calls.map(c => c.params)).toEqual([{ instrument_name: "ETH-20261225-3500-P" }, { instrument_name: "ETH-20261225-3500-P" }]);
    expect(q.instrument).toBe("ETH-20261225-3500-P");
    expect(q.greeks?.delta).toBe((TICK_3500P.result as { option_pricing: Record<string, string> }).option_pricing.d);
  });

  it("quote: unknown instrument (RPC 12001) → SYMBOL_NOT_FOUND", async () => {
    routeFetch({ get_instrument: ERR_NOT_FOUND, get_ticker: ERR_TICKER });
    const e = await caught(testVenue().getQuote("ETH-20261225-3333-P"));
    expect(e.structured.code).toBe("SYMBOL_NOT_FOUND");
    expect(e.structured.remediation).toContain("options chain");
  });

  it("quote: a perp instrument → INVALID_PARAMS", async () => {
    routeFetch({ get_instrument: INST_PERP, get_ticker: TICK_3500P });
    const e = await caught(testVenue().getQuote("ETH-PERP"));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(e.message).toMatch(/perp, not an option/);
  });

  it("quote: an ACTIVE option whose ticker is missing (-32602 \"Ticker not found\", recorded) → EXCHANGE_ERROR with remediation", async () => {
    routeFetch({ get_instrument: INST_3500P, get_ticker: ERR_TICKER });
    const e = await caught(testVenue().getQuote("ETH-20261225-3500-P"));
    expect(e.structured.code).toBe("EXCHANGE_ERROR");
    expect(e.message).toMatch(/no live ticker for active option ETH-20261225-3500-P/);
    expect(e.structured.remediation).toContain("options chain ETH --expiry 2026-12-25");
  });

  it("quote: a listed-but-inactive option → SYMBOL_NOT_FOUND with its activation time", async () => {
    const inactive = rawInstruments.find(i => !i.is_active)!;
    routeFetch({ get_instrument: { result: inactive }, get_ticker: ERR_TICKER });
    const e = await caught(testVenue().getQuote(inactive.instrument_name));
    expect(e.structured.code).toBe("SYMBOL_NOT_FOUND");
    expect(e.message).toMatch(/not active \(activation 2026-12-25T08:00:00.000Z\)/);
  });
});

// ── transport / error envelope ──

describe("DeriveClient error envelope", () => {
  const client = () => new DeriveClient("mainnet", "https://derive.test/v3", { capacity: 1000, refillPerSec: 1000, weights: null });

  it("JSON-RPC -32602 (recorded) is a Derive-side rejection → EXCHANGE_ERROR (never the user's INVALID_PARAMS)", async () => {
    routeFetch({ get_tickers: ERR_EXPIRY });
    const e = await caught(client().call("get_tickers", { instrument_type: "option", currency: "ETH" }));
    expect(e.structured.code).toBe("EXCHANGE_ERROR");
    expect(e.message).toContain("request rejected by Derive");
    expect(e.structured.remediation).toBeTruthy();
    expect(e.message).toContain("Expiry date is required for options");
    expect(e.structured.details).toMatchObject({ exchange: "derive", rpcCode: -32602, rpcData: "Expiry date is required for options" });
  });

  it("RPC -32000 rate limit → RATE_LIMITED (retryable) with the Retry-after hint", async () => {
    routeFetch({ get_ticker: { error: { code: -32000, message: "Rate limit exceeded", data: "Retry after 1200 ms" } } });
    const e = await caught(client().call("get_ticker", {}));
    expect(e.structured.code).toBe("RATE_LIMITED");
    expect(e.structured.retryable).toBe(true);
    expect(e.structured.details?.retryAfterMs).toBe(1200);
  });

  it("HTTP 429 → RATE_LIMITED", async () => {
    routeFetch({ get_ticker: "Too Many Requests" }, 429);
    expect((await caught(client().call("get_ticker", {}))).structured.code).toBe("RATE_LIMITED");
  });

  it("HTTP 429: the RPC body's Retry-after wins over the retry-after header; the header is used when the body has none", async () => {
    const at429 = (body: unknown, retryAfter: string) => vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 429, headers: { "retry-after": retryAfter } })));
    at429({ error: { code: -32000, message: "Rate limit exceeded", data: "Retry after 700 ms" } }, "3");
    let e = await caught(client().call("get_ticker", {}));
    expect(e.structured.code).toBe("RATE_LIMITED");
    expect(e.structured.details?.retryAfterMs).toBe(700);
    at429({ error: { code: -32000, message: "Rate limit exceeded", data: null } }, "3");
    e = await caught(client().call("get_ticker", {}));
    expect(e.structured.details?.retryAfterMs).toBe(3000);
  });

  it("every client error carries a remediation", async () => {
    const errs: PerpError[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    errs.push(await caught(client().call("get_ticker", {})));
    for (const [status, body] of [[502, "<html/>"], [200, "not json"], [200, { id: 1 }], [200, ERR_EXPIRY], [200, ERR_NOT_FOUND],
      [200, { error: { code: -32000, message: "Rate limit exceeded", data: "Retry after 5 ms" } }], [429, "slow down"]] as Array<[number, unknown]>) {
      routeFetch({ get_ticker: body }, status);
      errs.push(await caught(client().call("get_ticker", {})));
    }
    for (const e of errs) expect(e.structured.remediation, e.message).toMatch(/\S/);
  });

  it("the default bucket never exceeds Derive's 25 requests per 5 s window", () => {
    expect(DERIVE_RATE_LIMIT.capacity + DERIVE_RATE_LIMIT.refillPerSec * 5).toBeLessThanOrEqual(25);
  });

  it("an application error code → EXCHANGE_ERROR carrying the code", async () => {
    routeFetch({ get_ticker: { error: { code: 13000, message: "Something", data: null } } });
    const e = await caught(client().call("get_ticker", {}));
    expect(e.structured.code).toBe("EXCHANGE_ERROR");
    expect(e.structured.details?.rpcCode).toBe(13000);
  });

  it("HTTP 5xx without an RPC body, non-JSON 200, and a body without result are EXCHANGE_ERROR", async () => {
    routeFetch({ get_ticker: "<html>bad gateway</html>" }, 502);
    expect((await caught(client().call("get_ticker", {}))).structured.code).toBe("EXCHANGE_ERROR");
    routeFetch({ get_ticker: "not json" });
    expect((await caught(client().call("get_ticker", {}))).message).toMatch(/non-JSON/);
    routeFetch({ get_ticker: { id: "x" } });
    expect((await caught(client().call("get_ticker", {}))).message).toMatch(/no result/);
  });

  it("transport failure → EXCHANGE_UNREACHABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect((await caught(client().call("get_ticker", {}))).structured.code).toBe("EXCHANGE_UNREACHABLE");
  });

  it("network → base URL", async () => {
    const f = routeFetch({ get_all_currencies: CURRENCIES });
    await new DeriveClient("testnet").call("get_all_currencies", {});
    expect(f.mock.calls[0][0]).toBe("https://testnet.api.derive.xyz/v3/public/get_all_currencies");
  });
});

// ── registry / CLI ──

describe("options venue registry", () => {
  it("-e derive with a perp command → UNKNOWN_VENUE whose remediation points at perp options", async () => {
    const { resolveVenueId } = await import("../../exchanges/venue.js");
    await import("../../exchanges/venues/index.js");
    try {
      resolveVenueId("derive");
      throw new Error("no throw");
    } catch (e) {
      expect((e as PerpError).structured.code).toBe("UNKNOWN_VENUE");
      expect((e as PerpError).structured.remediation).toContain("derive is options-only: perp -e derive options");
    }
    try {
      resolveVenueId("nope");
    } catch (e) {
      expect((e as PerpError).structured.remediation).not.toContain("options-only");
    }
  });

  it("resolves derive (and alias drv); a perp venue is CAPABILITY_UNSUPPORTED", async () => {
    expect((await getOptionsVenue("Derive", "mainnet")).id).toBe("derive");
    expect((await getOptionsVenue("drv", "mainnet")).id).toBe("derive");
    const e = await caught(getOptionsVenue("hyperliquid", "mainnet"));
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.structured.remediation).toContain("-e derive");
  });
});

describe("perp options (CLI, --json)", () => {
  type Env = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
  const run = async (args: string[]): Promise<Env> => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    try {
      await program.parseAsync(["node", "perp", "--json", ...args]);
    } catch (e) {
      if (e instanceof PerpError) return { ok: false, error: e.structured };
      throw e;
    } finally {
      vi.mocked(console.log).mockRestore();
    }
    return JSON.parse(out.join("").trim()) as Env;
  };

  it("-e derive options chain ETH --strikes 2 → one {ok,data} document", async () => {
    routeFetch({ get_all_instruments: INSTRUMENTS, get_tickers: TICKERS_1019 });
    const env = await run(["-e", "derive", "options", "chain", "ETH", "--strikes", "2"]);
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ schema: 1, venue: "derive", underlying: "ETH", expiry: "2026-10-19" });
    expect((env.data!.rows as unknown[]).length).toBe(2);
    expect(calls.map(c => c.method)).toEqual(["get_all_instruments", "get_tickers"]);
  });

  it("-n testnet reads the testnet API", async () => {
    const f = routeFetch({ get_all_instruments: INSTRUMENTS });
    const env = await run(["-n", "testnet", "-e", "derive", "options", "expiries", "ETH"]);
    expect(env.ok).toBe(true);
    expect(String(f.mock.calls[0][0])).toMatch(/^https:\/\/testnet\.api\.derive\.xyz\/v3\//);
  });

  it("without -e, or with a perp venue, refuses before any request", async () => {
    const f = routeFetch({});
    expect((await run(["options", "expiries", "ETH"])).error?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect((await run(["-e", "hyperliquid", "options", "quote", "ETH-20261225-3500-P"])).error?.code).toBe("CAPABILITY_UNSUPPORTED");
    const bad = (await run(["-e", "derive", "options", "chain", "ETH", "--strikes", "two"])).error as { code: string; remediation?: string };
    expect(bad.code).toBe("INVALID_PARAMS");
    expect(bad.remediation).toBe("Pass a positive integer, e.g. --strikes 10");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("Derive quote edge cases (audit 0.15.0)", () => {
  // Live get_instrument of an expired, settled option (2026-10-19).
  const EXPIRED = { result: { instrument_type: "option", instrument_name: "ETH-20261019-2400-C", scheduled_activation: 1792051200, scheduled_deactivation: 1792396740, is_active: false, base_currency: "ETH", quote_currency: "USDC", option_details: { index: "ETH-USD", expiry: 1792396800, strike: "2400", option_type: "C", settlement_price: "2430.293794029823" } } };

  it("an expired instrument says expired + settled, not 'listed but not active (activation …)'", async () => {
    routeFetch({ get_instrument: EXPIRED, get_ticker: ERR_TICKER });
    const e = await caught(testVenue().getQuote("ETH-20261019-2400-C"));
    expect(e.structured.code).toBe("SYMBOL_NOT_FOUND");
    expect(e.message).toBe("Derive option ETH-20261019-2400-C expired at 2026-10-19T08:00:00.000Z, settled at 2430.293794029823");
    expect(e.structured.details).toMatchObject({ expired: true, settlementPrice: "2430.293794029823" });
  });

  it("a decimal strike is sent in the venue form (0.0045 → 0_0045)", async () => {
    const { deriveInstrumentName } = await import("../../exchanges/derive/options.js");
    expect(deriveInstrumentName("pump-20261023-0.0045-c")).toBe("PUMP-20261023-0_0045-C");
    expect(deriveInstrumentName("ETH-20261225-3500-P")).toBe("ETH-20261225-3500-P");
  });

  it("greeks are printed by significant figures (theta was -0.000)", async () => {
    const { fmtGreek } = await import("../../commands/options.js");
    expect(fmtGreek("-0.00012345")).toBe("-0.000123");
    expect(fmtGreek("0.5123")).toBe("0.512");
    expect(fmtGreek("0")).toBe("0");
    expect(fmtGreek(null)).not.toMatch(/\d/);
  });
});
