/**
 * Hyperliquid public read path (0.15.1 bug-hunt F1–F8 + minor items), replayed from responses
 * recorded live from api.hyperliquid.xyz/info on 2026-10-19 (fixtures/hyperliquid/
 * read-path-2026-10-19.json — see its `_note` for the projections kept).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("../../cache.js", async () => ({
  withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  fetchAndCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidateCache: () => {},
  TTL_ACCOUNT: 1000,
  TTL_MARKETS: 1000,
  TTL_PRICES: 1000,
}));

import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { venueCapOf } from "../../exchanges/venue-cap.js";
import { PerpError } from "../../errors.js";
import REC from "../fixtures/hyperliquid/read-path-2026-10-19.json";

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;

/** fundingHistory as HL serves it: rows with time ≥ startTime, oldest first, at most 500. */
const FUNDING_BTC: Row[] = (() => {
  const byTime = new Map<number, Row>();
  for (const r of [...REC.fundingBTC600h.page1, ...REC.fundingBTC600h.page2] as Row[]) byTime.set(Number(r.time), r);
  return [...byTime.values()].sort((a, b) => Number(a.time) - Number(b.time));
})();

/** Info routes answering with the recorded responses (native perps or the km dex). */
function recorded(dex = ""): Record<string, (b: Body) => unknown> {
  return {
    meta: (b) => (b.dex === "km" ? REC.kmMeta : REC.meta),
    metaAndAssetCtxs: (b) => (b.dex === "km" ? REC.kmMetaAndAssetCtxs : REC.metaAndAssetCtxs),
    allMids: () => REC.allMids,
    perpDexs: () => REC.perpDexs,
    allPerpMetas: () => REC.allPerpMetas,
    recentTrades: (b) => (b.coin === "BTC" ? REC.recentTradesBTC : b.coin === "MATIC" ? REC.recentTradesMATIC : b.coin === "km:US500" ? REC.recentTradesKmUS500 : null),
    fundingHistory: (b) => (b.coin === "MATIC" ? REC.fundingMATIC : FUNDING_BTC.filter(r => Number(r.time) >= Number(b.startTime)).slice(0, 500)),
    l2Book: () => REC.l2BookBTC,
    candleSnapshot: () => { throw new Error(`candleSnapshot route not set for dex "${dex}"`); },
  };
}

function adapterWith(routes: Record<string, (b: Body) => unknown>, dex = "") {
  const hl = new HyperliquidAdapter(undefined, false);
  if (dex) hl.setDex(dex);
  const calls: Body[] = [];
  (hl as unknown as { _infoPost: (b: Body) => Promise<unknown> })._infoPost = async (b) => {
    calls.push(b);
    const r = routes[String(b.type)];
    if (!r) throw new Error(`unexpected info ${String(b.type)}`);
    return r(b);
  };
  return { hl, calls };
}

async function caught(p: Promise<unknown>): Promise<PerpError> {
  try { await p; } catch (e) { if (e instanceof PerpError) return e; throw e; }
  throw new Error("expected a PerpError");
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(REC.recordedAt); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("F1: klines beyond HL's most recent 5000 candles are never returned as complete", () => {
  it("1m over 10 days: rows carry venueCap { truncated, availableFrom = first candle }", async () => {
    const c = REC.candles1m10d;
    const { hl } = adapterWith({ ...recorded(), candleSnapshot: () => [...c.head, ...c.tail] });
    const rows = await hl.getKlines("BTC", "1m", c.req.startTime, c.req.endTime);
    const cap = venueCapOf(rows);
    expect(cap).toMatchObject({ cappedAt: 5000, truncated: true, availableFrom: c.head[0].t });
    expect(cap!.availableFrom!).toBeGreaterThan(c.req.startTime + 60_000);
  });

  it("a range wholly older than the venue window (answered []) → INVALID_PARAMS naming the earliest time", async () => {
    const c = REC.candles1mOld;
    expect(c.rows).toEqual([]);
    const { hl } = adapterWith({ ...recorded(), candleSnapshot: () => c.rows });
    const e = await caught(hl.getKlines("BTC", "1m", c.req.startTime, c.req.endTime));
    expect(e.structured).toMatchObject({ code: "INVALID_PARAMS", retryable: false });
    expect(e.message).toMatch(/most recent 5000 1m candles \(from about 2026-/);
  });

  it("a range inside the window: no cap signal; only the in-progress last candle is closed:false", async () => {
    const c = REC.candles1h24h;
    const { hl } = adapterWith({ ...recorded(), candleSnapshot: () => c.rows });
    const rows = await hl.getKlines("BTC", "1h", c.req.startTime, c.req.endTime);
    expect(venueCapOf(rows)).toBeNull();
    expect(rows.at(-1)!.closed).toBe(false);
    expect(rows.slice(0, -1).every(r => r.closed)).toBe(true);
  });
});

describe("F3: unsupported intervals and HL 422 are INVALID_PARAMS, not a retryable venue error", () => {
  it("'7m' is refused before any request", async () => {
    const { hl, calls } = adapterWith(recorded());
    const e = await caught(hl.getKlines("BTC", "7m", 0, REC.recordedAt));
    expect(e.structured).toMatchObject({ code: "INVALID_PARAMS", retryable: false });
    expect(e.structured.remediation).toContain("1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M");
    expect(calls.some(b => b.type === "candleSnapshot")).toBe(false);
  });

  it("an info call answered 422 (recorded deserialize error) → INVALID_PARAMS, retryable false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(REC.candleBadInterval.body, { status: REC.candleBadInterval.status })));
    const hl = new HyperliquidAdapter(undefined, false);
    const post = (hl as unknown as { _infoPost: (b: Body) => Promise<unknown> })._infoPost.bind(hl);
    const e = await caught(post({ type: "fundingHistory", coin: "BTC", startTime: "x" }));
    expect(e.structured).toMatchObject({ code: "INVALID_PARAMS", retryable: false });
    expect(e.message).toContain("Failed to deserialize");
  });
});

describe("F4: market funding --limit N reads N hourly rows, paging HL's 500-row cap", () => {
  it("limit 600 → 600 distinct rows, oldest first, over two pages", async () => {
    const { hl, calls } = adapterWith(recorded());
    const rows = await hl.getFundingHistory("BTC", 600);
    expect(rows).toHaveLength(600);
    expect(new Set(rows.map(r => r.time)).size).toBe(600);
    expect(rows.every((r, i) => i === 0 || r.time > rows[i - 1].time)).toBe(true);
    expect(rows.at(-1)!.time).toBe(Number(FUNDING_BTC.at(-1)!.time));
    const pages = calls.filter(b => b.type === "fundingHistory");
    expect(pages).toHaveLength(2);
    expect(pages[1].startTime).toBe(Number(REC.fundingBTC600h.page1.at(-1)!.time));
  });

  it("limit 48 (above the old 24 h window) → 48 rows", async () => {
    const { hl } = adapterWith(recorded());
    expect(await hl.getFundingHistory("BTC", 48)).toHaveLength(48);
  });

  it.each([0, -3, 1.5, Number.NaN])("limit %s → INVALID_PARAMS before any request", async (limit) => {
    const { hl, calls } = adapterWith(recorded());
    const e = await caught(hl.getFundingHistory("BTC", limit));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(calls.some(b => b.type === "fundingHistory")).toBe(false);
  });
});

describe("F5: market trades reports HL's 10-trade tape cap", () => {
  it("limit 20 → the 10 rows served + venueCap { cappedAt 10, requested 20 }", async () => {
    const { hl } = adapterWith(recorded());
    const rows = await hl.getRecentTrades("BTC", 20);
    expect(rows).toHaveLength(10);
    expect(venueCapOf(rows)).toMatchObject({ cappedAt: 10, requested: 20, returned: 10, truncated: true });
    // the rows themselves are unchanged (non-enumerable signal)
    expect(Object.keys(rows)).toHaveLength(10);
  });

  it("limit 5 → 5 rows, no cap signal", async () => {
    const { hl } = adapterWith(recorded());
    const rows = await hl.getRecentTrades("BTC", 5);
    expect(rows).toHaveLength(5);
    expect(venueCapOf(rows)).toBeNull();
  });
});

describe("F6: per-symbol reads refuse delisted markets (SYMBOL_NOT_FOUND, reason delisted)", () => {
  const reads: Array<[string, (hl: HyperliquidAdapter, s: string) => Promise<unknown>]> = [
    ["trades", (hl, s) => hl.getRecentTrades(s, 20)],
    ["funding", (hl, s) => hl.getFundingHistory(s, 10)],
    ["book", (hl, s) => hl.getOrderbook(s)],
    ["kline", (hl, s) => hl.getKlines(s, "1h", REC.recordedAt - 86_400_000, REC.recordedAt)],
  ];

  it.each(reads)("native MATIC %s (venue serves 2024 trades / zero funding rows)", async (_n, read) => {
    const { hl, calls } = adapterWith(recorded());
    const e = await caught(read(hl, "MATIC"));
    expect(e.structured).toMatchObject({ code: "SYMBOL_NOT_FOUND", details: { reason: "delisted" } });
    expect(e.message).toMatch(/MATIC is delisted on Hyperliquid/);
    expect(calls.some(b => ["recentTrades", "fundingHistory", "l2Book", "candleSnapshot"].includes(String(b.type)))).toBe(false);
  });

  it.each(reads)("HIP-3 --dex km US500 %s", async (_n, read) => {
    const { hl } = adapterWith(recorded("km"), "km");
    const e = await caught(read(hl, "US500"));
    expect(e.structured).toMatchObject({ code: "SYMBOL_NOT_FOUND", details: { reason: "delisted" } });
    expect(e.structured.remediation).toContain("--dex km");
  });

  it("a listed market still reads (BTC trades / book)", async () => {
    const { hl } = adapterWith(recorded());
    await expect(hl.getRecentTrades("BTC", 3)).resolves.toHaveLength(3);
    const book = await hl.getOrderbook("BTC");
    expect(book.bids).toHaveLength(20);
    expect(venueCapOf(book)).toMatchObject({ cappedAt: 20, truncated: false });
  });

  it("orders / positions still resolve a delisted asset (getAssetIndex)", async () => {
    const { hl } = adapterWith(recorded());
    await expect(hl.getAssetIndex("MATIC")).resolves.toBe(2);
  });
});

describe("F7: --dex km market info US500 (bare name) says delisted, with --dex in the remediation", () => {
  it("delistedMessage / delistedError match the bare HIP-3 name", async () => {
    const { hl } = adapterWith(recorded("km"), "km");
    const markets = await hl.getMarkets();
    expect(markets).toHaveLength(0); // every km asset is delisted (2026-10-19)
    expect(hl.delistedMessage("US500")).toBe("km:US500 is delisted on Hyperliquid (positions / history still readable)");
    expect(hl.delistedMessage("km:US500")).not.toBeNull();
    const e = hl.delistedError("US500")!;
    expect(e.structured).toMatchObject({ code: "SYMBOL_NOT_FOUND", details: { reason: "delisted" } });
    expect(e.structured.remediation).toBe("List live markets: perp -e hyperliquid --dex km market list");
  });

  it("native delisted coin keeps the 0.15.0 message", async () => {
    const { hl } = adapterWith(recorded());
    await hl.getMarkets();
    expect(hl.delistedMessage("matic")).toBe("MATIC is delisted on Hyperliquid (positions / history still readable)");
    expect(hl.delistedError("BTC")).toBeNull();
  });
});

describe("F8: market hip3 counts live assets, marks delisted dexes, reads the deployer", () => {
  it("recorded allPerpMetas + perpDexs", async () => {
    const { hl } = adapterWith(recorded());
    const dexes = await hl.listDeployedDexes();
    const by = Object.fromEntries(dexes.map(d => [d.name, d]));
    for (const name of ["km", "flx", "hyna", "cash", "vntl", "abcd"]) {
      expect(by[name]).toMatchObject({ delisted: true, assets: [] });
      expect(by[name].delistedAssets.length).toBeGreaterThan(0);
    }
    expect(by.xyz.delisted).toBe(false);
    expect(by.xyz.assets).toHaveLength(115);
    expect(by.xyz.delistedAssets).toHaveLength(21);
    expect(by.km.deployer).toBe(REC.perpDexs[5]!.deployer);
    expect(dexes.every(d => /^0x[0-9a-f]{40}$/.test(d.deployer))).toBe(true);
  });
});

describe("marginTiers: single-tier tables (id < 50) emit the implicit tier", () => {
  it("MATIC (marginTableId 20, delisted — not listed), kPEPE table 52 from marginTables; ETH 55", async () => {
    const { hl } = adapterWith(recorded());
    const m = await hl.getMarkets();
    const by = Object.fromEntries(m.map(x => [x.symbol, x]));
    expect(by["kPEPE-PERP"].marginTiers?.length).toBeGreaterThan(0);
    expect(by["BTC-PERP"].marginTiers?.[0]).toMatchObject({ lowerBound: 0, maxLeverage: 40 });
  });

  it("an id below 50 is a single tier with max leverage = id (docs \"Margin tiers\")", async () => {
    const { hlMarginTiersOf } = await import("../../exchanges/hyperliquid.js");
    expect(hlMarginTiersOf(20, new Map())).toEqual([{ lowerBound: 0, maxLeverage: 20 }]);
    expect(hlMarginTiersOf(56, new Map())).toBeNull();
  });
});
