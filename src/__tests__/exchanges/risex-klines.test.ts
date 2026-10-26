/**
 * RISEx klines (perp_app report, 0.15.0): /trading-view-data answers an interval it does not
 * serve (3m, 30m, 2h, 8h, 12h, 3d) with 1m bars and no error, and the adapter listed "30m" and
 * never checked the rows' `interval`. Verified live 2026-10-19: 1m 5m 15m 1h 4h 1d 1w return
 * rows of their own interval. Fixtures: live answers for 30m (rows labelled "1m") and 1h.
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { RisexAdapter, KLINE_INTERVAL_MS } from "../../exchanges/risex/adapter.js";
import LIVE_30M from "../fixtures/risex/trading-view-30m-returns-1m.json";
import LIVE_1H from "../fixtures/risex/trading-view-1h.json";

function adapterReturning(body: unknown) {
  const get = vi.fn(async () => body);
  const a = Object.create(RisexAdapter.prototype) as RisexAdapter;
  Object.assign(a as object, { market: vi.fn(async () => ({ market_id: 1 })), client: { get } });
  return { a, get };
}

describe("RISEx getKlines", () => {
  it("the table holds only the live-verified intervals (30m dropped, 1w added)", () => {
    expect(Object.keys(KLINE_INTERVAL_MS)).toEqual(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]);
  });

  it.each(["30m", "3m", "2h", "8h", "12h", "3d", "1M"])("%s → INVALID_PARAMS listing the supported intervals, before any request", async (iv) => {
    const { a, get } = adapterReturning(LIVE_30M.data);
    await expect(a.getKlines("BTC", iv, 0, 1)).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "INVALID_PARAMS", remediation: "Use one of: 1m, 5m, 15m, 1h, 4h, 1d, 1w" }),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rows of another interval than requested → EXCHANGE_ERROR (live 30m answer, relabelled request 1h)", async () => {
    const { a } = adapterReturning(LIVE_30M.data);
    await expect(a.getKlines("BTC", "1h", 0, 1)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("matching rows are returned", async () => {
    const { a, get } = adapterReturning(LIVE_1H.data);
    const k = await a.getKlines("BTC", "1h", 0, 1);
    expect(k.length).toBe(LIVE_1H.data.data.length);
    expect(k.every(c => c.time % 3_600_000 === 0)).toBe(true);
    expect((get.mock.calls[0] as unknown[])[1]).toMatchObject({ interval: "3600000000000" });
  });
});

describe("candle interval guard on the other venues whose rows state their interval", () => {
  it("hyperliquid: a row whose `i` differs from the request → EXCHANGE_ERROR; matching rows pass", async () => {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const a = new HyperliquidAdapter(undefined, false);
    (a as unknown as { _assetMap: Map<string, number> })._assetMap.set("BTC", 0);
    // Live candleSnapshot row shape (2026-10-19).
    const row = { t: 1792396800000, T: 1792400399999, s: "BTC", i: "1h", o: "82701.0", c: "82805.0", h: "82944.0", l: "82555.0", v: "1150.99381", n: 10424 };
    (a as unknown as { _infoPost: unknown })._infoPost = vi.fn(async () => [row]);
    // A recent window: a start before HL's 5000-candle window is refused up front (INVALID_PARAMS).
    const end = Date.now(), start = end - 3_600_000;
    expect(await a.getKlines("BTC", "1h", start, end)).toHaveLength(1);
    await expect(a.getKlines("BTC", "4h", start, end)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("pacifica: same guard on /kline `i`", async () => {
    const { PacificaAdapter } = await import("../../exchanges/pacifica.js");
    const row = { t: 1792400400000, T: 1792404000000, s: "BTC", i: "1h", o: "82794", c: "82758", h: "83065", l: "82723", v: "188.75248", n: 855 };
    const a = Object.create(PacificaAdapter.prototype) as InstanceType<typeof PacificaAdapter>;
    // /info (wireSymbol resolves the venue spelling, perp-only reads).
    Object.assign(a as object, { client: { getKline: vi.fn(async () => [row]), getInfo: vi.fn(async () => [{ symbol: "BTC", instrument_type: "perpetual" }]) } });
    expect(await a.getKlines("BTC", "1h", 0, 1)).toHaveLength(1);
    await expect(a.getKlines("BTC", "15m", 0, 1)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("txflow: same guard on candleSnapshot `i`", async () => {
    const { TxflowPublicAdapter } = await import("../../exchanges/txflow/adapter.js") as unknown as { TxflowPublicAdapter: new (...a: unknown[]) => object };
    const row = { t: 1792400400000, o: "82707.4", h: "82988", l: "82621.7", c: "82650", v: "25.2125", n: 883, s: "1", i: "1h", T: 1792403999999 };
    const a = Object.create(TxflowPublicAdapter.prototype) as { getKlines: (s: string, i: string, a: number, b: number) => Promise<unknown[]> };
    Object.assign(a, { market: vi.fn(async () => ({ index: 1 })), client: { info: vi.fn(async () => [row]) } });
    expect(await a.getKlines("BTC", "1h", 0, 1)).toHaveLength(1);
    await expect(a.getKlines("BTC", "4h", 0, 1)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

describe("RISEx funding history paging (live: any -l ≥ 169 returned 168 rows)", () => {
  it("sends start_time = now − limit·1h and follows page / has_next_page", async () => {
    const H = 3_600_000;
    const now = 1792404000000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const rec = (t: number) => ({ funding_rate: "-0.000007566719954101", end_time: `${t}000000`, index_price: "82711.36" });
    const get = vi.fn(async (_p: string, q: { limit: number; page: number; start_time: string }) => {
      // The venue: hourly prints since start_time, newest first, `limit` per page.
      const startMs = Number(BigInt(q.start_time) / 1_000_000n);
      const all: number[] = [];
      for (let t = now; t >= startMs; t -= H) all.push(t);
      const rows = all.slice((q.page - 1) * q.limit, q.page * q.limit);
      return { records: rows.map(rec), page: q.page, has_next_page: q.page * q.limit < all.length };
    });
    const a = Object.create(RisexAdapter.prototype) as RisexAdapter;
    Object.assign(a as object, { market: vi.fn(async () => ({ market_id: 1 })), client: { get } });
    const rows = await a.getFundingHistory("BTC", 1500);
    expect(rows).toHaveLength(1500);
    expect(rows[0].time).toBe(now);
    expect(get.mock.calls.length).toBe(2);
    expect(get.mock.calls[0][1]).toMatchObject({ limit: 1000, page: 1 });
    expect(Number(BigInt(get.mock.calls[0][1].start_time) / 1_000_000n)).toBe(now - 1501 * H);
    vi.restoreAllMocks();
  });
});

describe("RISEx book depth / trades cap (S5, S6)", () => {
  it("book depth is sent (was always 50) and bounded by the API max 250; trades above 1000 are refused, not clamped", async () => {
    const get = vi.fn(async (_p: string, _q: Record<string, unknown>) => ({ bids: [], asks: [], trades: [] }));
    const a = Object.create(RisexAdapter.prototype) as RisexAdapter;
    Object.assign(a as object, { market: vi.fn(async () => ({ market_id: 1 })), client: { get } });
    await a.getOrderbook("BTC", 200);
    expect(get.mock.calls[0][1]).toMatchObject({ limit: 200 });
    await expect(a.getOrderbook("BTC", 251)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
    await expect(a.getRecentTrades("BTC", 1500)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
  });
});

describe("RISEx OHLC pass-through (conformance U1)", () => {
  it("a live bar whose open lies below its low is returned exactly as published (field-name mapping, no clamping)", async () => {
    // Live 1m row, 2026-10-19: open 83305.4 < low 83317.3 — RISEx opens at the previous close.
    const row = { market_id: "1", interval: "1m", time: "1791977520000000000", low: "83317.3", high: "83350.6", open: "83305.4", close: "83350.6", volume: "0.03077" };
    const { a } = adapterReturning({ data: [row] });
    const [k] = await a.getKlines("BTC", "1m", 0, 1);
    expect(k).toEqual({ time: 1791977520000, open: "83305.4", high: "83350.6", low: "83317.3", close: "83350.6", volume: "0.03077", quoteVolume: null, trades: null });
  });
});
