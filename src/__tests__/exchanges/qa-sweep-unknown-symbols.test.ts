/**
 * Pre-release QA sweep (0.15.0), part 2 — every venue's market info / book / trades / kline /
 * funding of an unknown symbol is SYMBOL_NOT_FOUND with remediation (venue behaviour verified
 * live 2026-10-14):
 *  - Pacifica GET /book → HTTP 400 "Book not found: NOPE" (was UNKNOWN); /trades, /kline,
 *    /funding_rate/history → 200 [] (was ok:true with []).
 *  - Ondo /v1/perps/trades and candles → 200 [] (was ok:true with []).
 *  - Aster /fapi/v3/fundingRate → 200 []; HL fundingHistory → HTTP 500 "null"; Lighter funding
 *    → [] from the rate map.
 * An empty answer is checked against the venue's market directory: a listed market with no rows
 * is still a real empty result.
 *
 * Plus the Pacifica public tape side: each fill is listed as a fulfill_taker and a fulfill_maker
 * row with that party's position effect; the tape is the taker rows, open_long / close_short buy,
 * open_short / close_long sell (was every row of both parties → "sell").
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../cache.js", async () => ({
  withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  fetchAndCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidateCache: () => {},
  TTL_ACCOUNT: 1000,
  TTL_MARKETS: 1000,
  TTL_PRICES: 1000,
  TTL_MARKET: 1000,
}));

import { PacificaAdapter, pacificaFillSide } from "../../exchanges/pacifica.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { LighterAdapter } from "../../exchanges/lighter.js";
import { listsSymbol, nonEmptyOrListed } from "../../exchanges/unknown-symbol.js";
import { tapeSkippedOf } from "../../exchanges/interface.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const NOT_FOUND = (venue: string) => ({
  structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", retryable: false, remediation: `List markets: perp -e ${venue} market list` }),
});

function stubAdapter<T extends object>(proto: T, name: string, fields: Record<string, unknown>, listed: string[]): T {
  const a = Object.create(proto) as Record<string, unknown>;
  Object.defineProperty(a, "name", { value: name });
  Object.assign(a, fields);
  a.getMarkets = vi.fn(async () => listed.map((symbol) => ({ symbol })));
  return a as unknown as T;
}

describe("nonEmptyOrListed", () => {
  const adapter = (listed: string[]) => ({ name: "pacifica", getMarkets: vi.fn(async () => listed.map((symbol) => ({ symbol }))) });

  it("rows are returned as-is without reading the directory", async () => {
    const a = adapter([]);
    await expect(nonEmptyOrListed(a, "NOPE", [1])).resolves.toEqual([1]);
    expect(a.getMarkets).not.toHaveBeenCalled();
  });
  it("empty + not listed → SYMBOL_NOT_FOUND", async () => {
    await expect(nonEmptyOrListed(adapter(["BTC"]), "NOPE", [])).rejects.toMatchObject(NOT_FOUND("pacifica"));
  });
  it("empty + listed → the real empty result", async () => {
    await expect(nonEmptyOrListed(adapter(["BTC"]), "btc", [])).resolves.toEqual([]);
  });
  it("compares the directory form of a venue-form symbol (passed by the adapter)", async () => {
    await expect(nonEmptyOrListed(adapter(["TSLA"]), "TSLA-USD.P", [], "TSLA")).resolves.toEqual([]);
  });
  it("a failing directory read keeps its code / retryable and says what was being checked", async () => {
    const { PerpError } = await import("../../errors.js");
    const a = { name: "ondo", getMarkets: vi.fn(async () => { throw new PerpError("RATE_LIMITED", "429 Too Many Requests"); }) };
    await expect(nonEmptyOrListed(a, "NOPE", [])).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "RATE_LIMITED", retryable: true, message: expect.stringMatching(/ondo: NOPE returned no rows and the market list could not be read to check the symbol — 429 Too Many Requests/) }),
    });
    const b = { name: "aster", getMarkets: vi.fn(async () => { throw new Error("fetch failed"); }) };
    await expect(nonEmptyOrListed(b, "NOPE", [])).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_UNREACHABLE", retryable: true }) });
  });
  it("matches case-insensitively, ignoring a -PERP suffix", () => {
    expect(listsSymbol([{ symbol: "BTC-PERP" }], "btc")).toBe(true);
    expect(listsSymbol([{ symbol: "BTC" }], "BTC-PERP")).toBe(true);
    expect(listsSymbol([{ symbol: "BTC" }], "BTCX")).toBe(false);
  });
});

describe("Pacifica", () => {
  const TAPE = [
    { event_type: "fulfill_taker", price: "83693", amount: "0.00015", side: "open_short", cause: "normal", created_at: 3 },
    { event_type: "fulfill_maker", price: "83693", amount: "0.00015", side: "close_short", cause: "normal", created_at: 3 },
    { event_type: "fulfill_taker", price: "83672", amount: "0.5", side: "close_short", cause: "normal", created_at: 2 },
    { event_type: "fulfill_maker", price: "83672", amount: "0.5", side: "close_long", cause: "normal", created_at: 2 },
    // one taker order filling two makers at the same price / amount: two fills, never merged
    { event_type: "fulfill_taker", price: "83600", amount: "0.1", side: "open_long", cause: "normal", created_at: 1 },
    { event_type: "fulfill_taker", price: "83600", amount: "0.1", side: "open_long", cause: "normal", created_at: 1 },
    { event_type: "fulfill_taker", price: "83500", amount: "0.2", side: "close_long", cause: "normal", created_at: 0 },
  ];
  const pac = (client: Record<string, unknown>, listed = ["BTC"]) => stubAdapter(PacificaAdapter.prototype, "pacifica", { client }, listed);

  it("tape = taker rows with the taker's direction (open_long / close_short buy, open_short / close_long sell)", async () => {
    const t = await pac({ getTrades: vi.fn(async () => TAPE) }).getRecentTrades("BTC", 20);
    expect(t.map((x) => [x.time, x.side, x.price, x.size])).toEqual([
      [3, "sell", "83693", "0.00015"],
      [2, "buy", "83672", "0.5"],
      [1, "buy", "83600", "0.1"],
      [1, "buy", "83600", "0.1"],
      [0, "sell", "83500", "0.2"],
    ]);
    expect(t.every((x) => x.fee === null)).toBe(true);
  });

  it("an undocumented event_type / side row is skipped (stderr warning + count), never given a guessed direction", async () => {
    // docs (api/rest-api/markets/get-recent-trades) list event_type fulfill_taker / fulfill_maker and
    // side open_long / open_short / close_long / close_short, without stating the sets are closed.
    const warn = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const rows = await pac({ getTrades: vi.fn(async () => [
      TAPE[0],
      { ...TAPE[0], event_type: "fulfill_rfq_taker", created_at: 9 },
      { ...TAPE[2], side: "flip", created_at: 8 },
    ]) }).getRecentTrades("BTC");
    expect(rows.map((r) => r.time)).toEqual([3]);
    expect(tapeSkippedOf(rows)).toEqual({ count: 2, reason: expect.stringMatching(/undocumented event_type "fulfill_rfq_taker".*side "flip"/) });
    expect(String(warn.mock.calls.flat().join(""))).toMatch(/\[pacifica\] \/trades: skipped 2 row\(s\)/);
  });

  it("nothing skipped → no annotation", async () => {
    const rows = await pac({ getTrades: vi.fn(async () => TAPE) }).getRecentTrades("BTC");
    expect(tapeSkippedOf(rows)).toBeNull();
  });

  it("pacificaFillSide is the one mapping (public tape and account fills)", () => {
    expect(["open_long", "close_short", "bid"].map((s) => pacificaFillSide(s, "x"))).toEqual(["buy", "buy", "buy"]);
    expect(["open_short", "close_long", "ask"].map((s) => pacificaFillSide(s, "x"))).toEqual(["sell", "sell", "sell"]);
    expect(() => pacificaFillSide("bogus", "/trades")).toThrow(/unknown side "bogus"/);
  });

  it("account fills keep the same mapping", async () => {
    const a = pac({ getTradeHistory: vi.fn(async () => [
      { symbol: "BTC", side: "close_short", price: "1", amount: "1", fee: "0.01", created_at: 1 },
      { symbol: "BTC", side: "close_long", price: "1", amount: "1", fee: "0.01", created_at: 2 },
    ]) });
    Object.assign(a as object, { _hasRealKey: true, account: "acct" });
    expect((await a.getTradeHistory(2)).map((t) => t.side)).toEqual(["buy", "sell"]);
  });

  it("book: HTTP 400 'Book not found' → SYMBOL_NOT_FOUND; other failures pass through", async () => {
    const notFound = new Error('GET /book failed (400): {"success":false,"data":null,"error":"Book not found: NOPE","code":400}');
    await expect(pac({ getBook: vi.fn(async () => { throw notFound; }) }).getOrderbook("NOPE")).rejects.toMatchObject(NOT_FOUND("pacifica"));
    const other = new Error("GET /book failed (503): upstream");
    await expect(pac({ getBook: vi.fn(async () => { throw other; }) }).getOrderbook("BTC")).rejects.toBe(other);
  });

  it("trades / kline / funding: 200 [] for an unlisted symbol → SYMBOL_NOT_FOUND; [] for a listed one stays []", async () => {
    const client = { getTrades: vi.fn(async () => []), getKline: vi.fn(async () => []), getFundingHistory: vi.fn(async () => []) };
    const a = pac(client);
    await expect(a.getRecentTrades("NOPE")).rejects.toMatchObject(NOT_FOUND("pacifica"));
    await expect(a.getKlines("NOPE", "1h", 0, 1)).rejects.toMatchObject(NOT_FOUND("pacifica"));
    await expect(a.getFundingHistory("NOPE")).rejects.toMatchObject(NOT_FOUND("pacifica"));
    await expect(a.getRecentTrades("BTC")).resolves.toEqual([]);
    await expect(a.getKlines("BTC", "1h", 0, 1)).resolves.toEqual([]);
  });
});

describe("Pacifica funding history is strict (review L2)", () => {
  const pac = (rows: unknown) => stubAdapter(PacificaAdapter.prototype, "pacifica", { client: { getFundingHistory: vi.fn(async () => rows) } }, ["BTC"]);

  it("maps the live row shape", async () => {
    const r = await pac([{ oracle_price: "83703.548788", funding_rate: "0.0000125", next_funding_rate: "0.0000125", created_at: 1791950402115 }]).getFundingHistory("BTC");
    expect(r).toEqual([{ time: 1791950402115, rate: "0.0000125", price: "83703.548788", intervalHours: 1, rateKind: "lastSettled" }]);
  });
  it("a non-list answer is EXCHANGE_ERROR, not []", async () => {
    await expect(pac({ unexpected: true }).getFundingHistory("BTC")).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
  it("a row without created_at is EXCHANGE_ERROR (never time 0); a missing oracle_price is null (never \"0\")", async () => {
    await expect(pac([{ funding_rate: "0.0000125", oracle_price: "1" }]).getFundingHistory("BTC")).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    const [row] = await pac([{ funding_rate: "0.0000125", created_at: 5 }]).getFundingHistory("BTC");
    expect(row.price).toBeNull();
  });
});

/** /v1/markets body (read by the disabled-listing check of every Ondo per-symbol read). */
const ONDO_PAIRS = (listed: string[]) => ({ perps: { tradingPairs: listed.map(s => ({ market: `${s}-USD.P` })) }, spot: { tradingPairs: [] } });

describe("Ondo", () => {
  it("trades / candles: 200 [] for an unlisted market → SYMBOL_NOT_FOUND; a listed market keeps []", async () => {
    const client = { publicGet: vi.fn(async (path: string) => path === "/v1/markets" ? ONDO_PAIRS(["AAPL"]) : []), get: vi.fn(async () => []) };
    const a = stubAdapter(OndoAdapter.prototype, "ondo", { client, pairsCache: null, contractsCache: null }, ["AAPL"]);
    await expect(a.getRecentTrades("NOPE")).rejects.toMatchObject(NOT_FOUND("ondo"));
    await expect(a.getKlines("NOPE", "1h", 0, 3_600_000)).rejects.toMatchObject(NOT_FOUND("ondo"));
    await expect(a.getRecentTrades("AAPL")).resolves.toEqual([]);
  });

  it("a venue-form symbol (TSLA-USD.P) of a listed market with an empty window stays []", async () => {
    const client = { publicGet: vi.fn(async (path: string) => path === "/v1/markets" ? ONDO_PAIRS(["TSLA"]) : []), get: vi.fn(async () => []) };
    const a = stubAdapter(OndoAdapter.prototype, "ondo", { client, pairsCache: null, contractsCache: null }, ["TSLA"]);
    await expect(a.getRecentTrades("TSLA-USD.P")).resolves.toEqual([]);
    await expect(a.getKlines("tsla-usd.p", "1h", 0, 3_600_000)).resolves.toEqual([]);
  });
});

describe("funding history of an unknown symbol", () => {
  it("Aster: 200 [] → SYMBOL_NOT_FOUND", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const a = new AsterAdapter(undefined, false);
    (a as unknown as Record<string, unknown>)._publicGet = vi.fn(async () => []);
    (a as unknown as Record<string, unknown>).getMarkets = vi.fn(async () => [{ symbol: "BTC" }]);
    await expect(a.getFundingHistory("NOPE")).rejects.toMatchObject(NOT_FOUND("aster"));
  });

  it("Aster: a venue-form symbol (BTCUSDT) of a listed market with no rows stays []", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const a = new AsterAdapter(undefined, false);
    (a as unknown as Record<string, unknown>)._publicGet = vi.fn(async () => []);
    (a as unknown as Record<string, unknown>).getMarkets = vi.fn(async () => [{ symbol: "BTC" }]);
    await expect(a.getFundingHistory("BTCUSDT")).resolves.toEqual([]);
  });

  it("Hyperliquid: resolved against the asset map before the request (the venue answers HTTP 500)", async () => {
    const a = new HyperliquidAdapter(undefined, false);
    const info = vi.fn(async () => { throw new Error("Hyperliquid info fundingHistory failed (500): null"); });
    (a as unknown as { _infoPost: unknown })._infoPost = info;
    (a as unknown as { _assetMap: Map<string, number> })._assetMap.set("BTC-PERP", 0);
    await expect(a.getFundingHistory("NOPE")).rejects.toMatchObject(NOT_FOUND("hyperliquid"));
    expect(info).not.toHaveBeenCalled();
  });

  it("Lighter: an unlisted market is SYMBOL_NOT_FOUND, not an empty history", async () => {
    const a = new LighterAdapter("0xabc", false);
    (a as unknown as { _marketMap: Map<string, number> })._marketMap = new Map([["BTC", 1]]);
    (a as unknown as { ensureMarketMap: () => Promise<void> }).ensureMarketMap = async () => {};
    const rates = vi.fn(async () => new Map());
    (a as unknown as { getFundingRates: unknown }).getFundingRates = rates;
    await expect(a.getFundingHistory("NOPE")).rejects.toMatchObject(NOT_FOUND("lighter"));
    expect(rates).not.toHaveBeenCalled();
  });
});
