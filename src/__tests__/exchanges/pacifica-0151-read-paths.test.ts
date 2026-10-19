/**
 * 0.15.1 Pacifica read-path regressions, on recorded live answers
 * (src/__tests__/fixtures/pacifica/market-data-live.json, 2026-10-19):
 *  - k-prefixed markets (kPEPE): the CLI's upper-cased KPEPE is resolved to the venue spelling
 *    before every request; a casing miss can never pass as "no data"
 *  - spot SOL-USDC is refused by the perp reads (book / trades / kline / funding)
 *  - kline: intervals checked locally (2m / 6h → INVALID_PARAMS), > 4000 bars paged
 *  - funding: > 4000 rows paged with the cursor; trades: --limit above the 20-fill tape refused
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PacificaAdapter } from "../../exchanges/pacifica.js";

type Env = { success: boolean; data: unknown; error?: string | null; code?: number | null; has_more?: boolean; next_cursor?: string };
const FX = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/pacifica/market-data-live.json"), "utf8")) as {
  info: Env & { data: Array<{ symbol: string; instrument_type: string }> };
  casing: Record<"venue" | "upper", Record<"trades" | "funding" | "kline" | "book", Env>>;
  solUsdcBook: Env;
  klineErrors: Record<"2m" | "6h" | "range4001x1m", Env>;
  fundingPages: Array<{ request: { limit: number; cursor?: string }; response: Env & { data: unknown[] } }>;
  klinePages: { start: number; end: number; pages: Array<Env & { data: Array<{ t: number }> }> };
};

afterEach(() => vi.restoreAllMocks());

/**
 * A recorded Pacifica: answers by the exact (case-sensitive) symbol the request carries, as the
 * venue does — kPEPE has rows, KPEPE `200 []` (book: HTTP 400 "Book not found").
 */
function recordedClient() {
  const byCase = (symbol: string) => (symbol === "kPEPE" ? FX.casing.venue : symbol === "KPEPE" ? FX.casing.upper : null);
  const unwrap = (e: Env, path: string) => {
    if (!e.success) throw new Error(`GET ${path} failed (400): ${JSON.stringify(e)}`);
    return e.data;
  };
  return {
    getInfo: vi.fn(async () => FX.info.data),
    getTrades: vi.fn(async (s: string) => (s === "SOL-USDC" ? FX.casing.venue.trades.data : unwrap(byCase(s)!.trades, "/trades"))),
    getKline: vi.fn(async (s: string) => (s === "SOL-USDC" ? [] : unwrap(byCase(s)!.kline, "/kline"))),
    getBook: vi.fn(async (s: string) => (s === "SOL-USDC" ? unwrap(FX.solUsdcBook, "/book") : unwrap(byCase(s)!.book, "/book"))),
    getFundingHistory: vi.fn(async (s: string) => byCase(s)!.funding.data),
    getEnvelope: vi.fn(async (_p: string, q: Record<string, string>) => byCase(q.symbol)!.funding),
  };
}

function pac(client: Record<string, unknown>): PacificaAdapter {
  const a = Object.create(PacificaAdapter.prototype) as PacificaAdapter;
  Object.assign(a as object, { client, _marketsCache: null, _marketsCacheTime: 0, _infoCache: null, _getPrices: async () => [] });
  return a;
}

describe("Pacifica k-prefixed markets (KPEPE typed, kPEPE on the venue)", () => {
  it("the recorded venue answers KPEPE with 200 [] (book: 400) and kPEPE with rows", () => {
    expect(FX.casing.upper.trades.data).toEqual([]);
    expect(FX.casing.upper.funding.data).toEqual([]);
    expect(FX.casing.upper.kline.data).toEqual([]);
    expect(FX.casing.upper.book.success).toBe(false);
    expect((FX.casing.venue.trades.data as unknown[]).length).toBeGreaterThan(0);
  });

  it("trades / kline / funding / book for KPEPE read kPEPE's rows", async () => {
    const c = recordedClient();
    const a = pac(c);
    const trades = await a.getRecentTrades("KPEPE", 20);
    expect(trades.length).toBeGreaterThan(0);
    expect(c.getTrades).toHaveBeenCalledWith("kPEPE");
    const now = (FX.casing.venue.kline.data as Array<{ t: number }>).at(-1)!.t;
    expect((await a.getKlines("KPEPE", "1h", now - 3 * 3_600_000, now)).length).toBeGreaterThan(0);
    expect(c.getKline.mock.calls[0][0]).toBe("kPEPE");
    expect((await a.getFundingHistory("KPEPE", 3)).length).toBe(3);
    expect(c.getEnvelope.mock.calls[0][1]).toMatchObject({ symbol: "kPEPE" });
    expect((await a.getOrderbook("KPEPE")).bids.length).toBeGreaterThan(0);
    expect(c.getBook).toHaveBeenCalledWith("kPEPE");
  });

  it("an unlisted symbol is SYMBOL_NOT_FOUND before any market-data request", async () => {
    const c = recordedClient();
    const a = pac(c);
    await expect(a.getRecentTrades("NOPE")).rejects.toMatchObject({ structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }) });
    expect(c.getTrades).not.toHaveBeenCalled();
  });
});

describe("Pacifica perp reads refuse spot SOL-USDC (served by /book, /trades, /kline)", () => {
  it("the recorded venue serves a SOL-USDC book on the perp endpoint", () => {
    expect(FX.solUsdcBook.success).toBe(true);
    expect(FX.info.data.find((m) => m.symbol === "SOL-USDC")?.instrument_type).toBe("spot");
  });
  it("book / trades / kline / funding → SYMBOL_NOT_FOUND, nothing requested", async () => {
    const c = recordedClient();
    const a = pac(c);
    const nf = { structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", message: expect.stringMatching(/spot market, not a perp/) }) };
    await expect(a.getOrderbook("SOL-USDC")).rejects.toMatchObject(nf);
    await expect(a.getRecentTrades("SOL-USDC")).rejects.toMatchObject(nf);
    await expect(a.getKlines("SOL-USDC", "1h", 0, 1)).rejects.toMatchObject(nf);
    await expect(a.getFundingHistory("SOL-USDC")).rejects.toMatchObject(nf);
    expect([c.getBook, c.getTrades, c.getKline, c.getEnvelope].every((f) => f.mock.calls.length === 0)).toBe(true);
  });
});

describe("Pacifica kline", () => {
  it("2m / 6h (venue: HTTP 400 'Must be one of …') are INVALID_PARAMS, checked locally", async () => {
    expect(FX.klineErrors["2m"].error).toMatch(/Must be one of 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 1w, 1M/);
    const c = recordedClient();
    const a = pac(c);
    for (const iv of ["2m", "6h", "3d"]) {
      await expect(a.getKlines("BTC", iv, 0, 3_600_000)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
    }
    expect(c.getKline).not.toHaveBeenCalled();
  });

  it("a 4001-bar 1m range (venue: HTTP 400 'Max range: 4000 candles') is read in two windows", async () => {
    expect(FX.klineErrors.range4001x1m.error).toMatch(/Max range: 4000 candles/);
    const { start, end, pages } = FX.klinePages;
    const getKline = vi.fn(async (_s: string, _i: string, from: number, to: number) => {
      // The venue: more than 4000 bars → HTTP 400 (recorded).
      if (Math.floor((to - from) / 60_000) >= 4001) throw new Error(`GET /kline failed (400): ${JSON.stringify(FX.klineErrors.range4001x1m)}`);
      return pages[getKline.mock.calls.length - 1].data;
    });
    const a = pac({ getInfo: vi.fn(async () => FX.info.data), getKline });
    const k = await a.getKlines("BTC", "1m", start, end);
    expect(getKline).toHaveBeenCalledTimes(2);
    expect(getKline.mock.calls[0].slice(2)).toEqual([start, start + 4000 * 60_000 - 1]);
    expect(getKline.mock.calls[1].slice(2)).toEqual([start + 4000 * 60_000, end]);
    expect(k.map((x) => x.time)).toEqual([...pages[0].data, ...pages[1].data].map((x) => x.t));
  });
});

describe("Pacifica funding history pages with the cursor (live: limit 4001 → 4000 rows, has_more)", () => {
  it("limit 4001 = the recorded 4000-row page + 1 row read with its next_cursor", async () => {
    const getEnvelope = vi.fn(async (_p: string, q: Record<string, string>) => {
      const page = FX.fundingPages.find((pg) => (pg.request.cursor ?? null) === (q.cursor ?? null))!;
      expect(Number(q.limit)).toBe(page.request.limit);
      return page.response;
    });
    const a = pac({ getInfo: vi.fn(async () => FX.info.data), getEnvelope });
    const rows = await a.getFundingHistory("BTC", 4001);
    expect(rows).toHaveLength(4001);
    expect(getEnvelope).toHaveBeenCalledTimes(2);
    expect(getEnvelope.mock.calls[1][1]).toMatchObject({ cursor: FX.fundingPages[0].response.next_cursor, limit: "1" });
    // newest first, strictly older across the page boundary
    expect(rows[4000].time).toBeLessThan(rows[3999].time);
  });
  it("limit outside 1..40000 is INVALID_PARAMS", async () => {
    const a = pac({ getInfo: vi.fn(async () => FX.info.data), getEnvelope: vi.fn() });
    for (const l of [0, 40_001, 1.5]) await expect(a.getFundingHistory("BTC", l)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
  });
});

describe("Pacifica trades --limit (GET /trades: the last 20 fills, no limit / cursor)", () => {
  it("the recorded tape is 20 taker rows; --limit 21 / 0 is INVALID_PARAMS naming the cap", async () => {
    expect((FX.casing.venue.trades.data as Array<{ event_type: string }>).filter((t) => t.event_type === "fulfill_taker")).toHaveLength(20);
    const c = recordedClient();
    const a = pac(c);
    for (const l of [21, 0, 100]) {
      await expect(a.getRecentTrades("kPEPE", l)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS", message: expect.stringMatching(/1\.\.20/) }) });
    }
    expect(c.getTrades).not.toHaveBeenCalled();
    await expect(a.getRecentTrades("kPEPE", 20)).resolves.toHaveLength(20);
  });
});

describe("Pacifica order / cancel / TP-SL payloads use the venue spelling (kPEPE), nothing sent live", () => {
  function trader() {
    const sent: Record<string, unknown> = {};
    const stop = (name: string) => vi.fn(async (params: unknown) => { sent[name] = params; throw new Error(`${name} captured`); });
    const ok = (name: string) => vi.fn(async (params: unknown) => { sent[name] = params; return { success: true, data: {} }; });
    const client = {
      getInfo: vi.fn(async () => FX.info.data),
      createMarketOrder: stop("market"), createLimitOrder: stop("limit"), createStopOrder: stop("stop"), editOrder: ok("edit"),
      cancelOrder: ok("cancel"), cancelStopOrder: ok("cancelStop"), setTPSL: ok("tpsl"), updateLeverage: ok("leverage"),
    };
    const a = pac(client);
    Object.assign(a as object, { ensureSigner: () => {}, account: "acct", signMessage: async () => new Uint8Array(64), builderCode: async () => null });
    return { a, sent };
  }

  it("market / limit / stop / edit / leverage send kPEPE for KPEPE", async () => {
    const { a, sent } = trader();
    await expect(a.marketOrder("KPEPE", "buy", "1000", { reduceOnly: false, slippage: { bps: 50 } as never })).rejects.toThrow();
    await expect(a.limitOrder("KPEPE", "buy", "0.004", "1000")).rejects.toThrow();
    await expect(a.stopOrder("KPEPE", "sell", "1000", "0.003", { reduceOnly: true })).rejects.toThrow();
    await a.editOrder("KPEPE", "1", "0.004", "1000");
    await a.setLeverage("KPEPE", 3);
    for (const k of ["market", "limit", "stop", "edit", "leverage"]) expect(sent[k]).toMatchObject({ symbol: "kPEPE" });
  });

  it("cancel / cancel-stop / position TP-SL send kPEPE; an unlisted symbol is sent as typed (delisted market cancel)", async () => {
    const { a, sent } = trader();
    await a.cancelOrder("KPEPE", "1");
    await a.cancelStopOrder("KPEPE", "2");
    await a.setPositionTpSl("KPEPE", "long", { tp: "0.005", tpLimit: null, sl: null });
    for (const k of ["cancel", "cancelStop", "tpsl"]) expect(sent[k]).toMatchObject({ symbol: "kPEPE" });
    await a.cancelOrder("GONE", "3");
    expect(sent.cancel).toMatchObject({ symbol: "GONE" });
  });

  it("opening orders on spot SOL-USDC are not sent (definite ORDER_REJECTED-class refusal)", async () => {
    const { a, sent } = trader();
    await expect(a.limitOrder("SOL-USDC", "buy", "100", "1")).rejects.toMatchObject({ structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }) });
    expect(sent.limit).toBeUndefined();
  });
});

describe("Pacifica funding: a short history with has_more is an error", () => {
  it("has_more true without a next_cursor before `limit` rows → EXCHANGE_ERROR", async () => {
    const page = { ...FX.fundingPages[1].response, next_cursor: undefined };
    const a = pac({ getInfo: vi.fn(async () => FX.info.data), getEnvelope: vi.fn(async () => page) });
    await expect(a.getFundingHistory("BTC", 5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR", message: expect.stringMatching(/has_more/) }) });
  });
});
