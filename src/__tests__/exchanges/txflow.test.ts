/**
 * TxFlow (market data only, UNOFFICIAL API): exact unit conversions, the id → symbol join,
 * error mapping of the undocumented endpoint, the one-shot WS snapshot, the "unofficial" label,
 * and the write-refusal table (every write path refuses with CAPABILITY_UNSUPPORTED and makes
 * zero network calls).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenue, requireCapabilities, resolveVenueId } from "../../exchanges/venue.js";
import { fetchAllAssetCtxsOnce, TxflowClient, type WsFactory, type WsLike } from "../../exchanges/txflow/client.js";
import {
  fetchTxflowFundingRates, fetchTxflowMarkets, joinSnapshot, percentToFraction, stepFromSzDecimals, toTxflowMarketMeta,
  type TxflowMarketMeta,
} from "../../exchanges/txflow/public.js";
import { TxflowPublicAdapter } from "../../exchanges/txflow/adapter.js";
import { buildProgram } from "../../cli-program.js";
import { parseVenueList, resolveSetupVenue } from "../../commands/init.js";

const META = {
  universe: [
    { name: "BTC-USDC", baseCurrency: "BTC", quoteCurrency: "USDC", szDecimals: 4, maxLeverage: 75, index: 1, priceTick: "0.1", haltTrading: false, delisted: false, tagIds: [1] },
    { name: "DOGE-USDC", baseCurrency: "DOGE", quoteCurrency: "USDC", szDecimals: -1, maxLeverage: 20, index: 10, priceTick: "0.00001", haltTrading: false, delisted: false, tagIds: [7] },
    { name: "XAU-USDC", baseCurrency: "XAU", quoteCurrency: "USDC", szDecimals: 3, maxLeverage: 20, index: 120, priceTick: "0.1", haltTrading: true, delisted: false, tagIds: [5] },
    { name: "OLD-USDC", baseCurrency: "OLD", quoteCurrency: "USDC", szDecimals: 0, maxLeverage: 3, index: 99, priceTick: "0.01", haltTrading: false, delisted: true, tagIds: [1] },
  ],
};
const ctx = (funding: string, markPx: string, extra: Record<string, unknown> = {}) => ({
  funding, markPx, oraclePx: markPx, openInterest: "12.5", nextFundingTime: 1_791_907_200_000, prevFundingTime: 1_791_903_600_000, ...extra,
});
const CTXS = [
  { coin: "10", ctx: ctx("-0.00310218", "0.2424") },
  { coin: "1", ctx: ctx("0.00125000", "83263.0") },
  { coin: "120", ctx: ctx("0.00125000", "2400.5", { prevFundingTime: 1_791_900_000_000 }) },
  { coin: "777", ctx: ctx("0.00125000", "1") },
];

function fakeWs(frames: unknown[] | null, opts: { error?: boolean } = {}): { factory: WsFactory; sent: string[]; closed: () => boolean } {
  const sent: string[] = [];
  let closed = false;
  const factory: WsFactory = () => {
    const handlers: Record<string, (x?: unknown) => void> = {};
    const ws: WsLike = {
      on: ((ev: string, cb: (x?: unknown) => void) => { handlers[ev] = cb; return ws; }) as WsLike["on"],
      send: (d: string) => {
        sent.push(d);
        if (frames !== null) setTimeout(() => { for (const f of frames) handlers.message?.(JSON.stringify(f)); }, 1);
      },
      close: () => { closed = true; },
    };
    setTimeout(() => (opts.error ? handlers.error?.(new Error("boom")) : handlers.open?.()), 1);
    return ws;
  };
  return { factory, sent, closed: () => closed };
}

/** allMarketTickers rows in the live shape (2026-10-19): BTC traded, DOGE "" (no volume), a spot row ≥ 10000. */
const TICKERS = [
  { coin: "BTC", instrumentId: 1, lastPrice: "82089.2", markPx: "82106.5", oraclePx: "82140.2", openInterest: "182.0786", fundingRate: "0.00095808", nextFundingTime: 1792407600000, blockTime: 1792406000324, dayNtlVlm: "70157052.3703057", prevDayPx: "82107.2", change24h: "-18.0", change24hPct: "-0.02" },
  { coin: "DOGE", instrumentId: 10, lastPrice: "", markPx: "", oraclePx: "", openInterest: "", fundingRate: "", nextFundingTime: 0, blockTime: 0, dayNtlVlm: "", prevDayPx: "", change24h: "", change24hPct: "" },
  { coin: "BTC/USDC", instrumentId: 10000, lastPrice: "82149.72", markPx: "", oraclePx: "", openInterest: "", fundingRate: "", nextFundingTime: 0, blockTime: 0, dayNtlVlm: "514808.5476593", prevDayPx: "82144.14", change24h: "5.58", change24hPct: "0.01" },
];

/** /info answers by request type: perpMeta → META, allMarketTickers → TICKERS. */
function routeInfo(tickers: unknown = TICKERS) {
  return async (_url: string, init?: RequestInit) => {
    const type = (JSON.parse(String(init?.body)) as { type: string }).type;
    return jsonResponse(200, type === "allMarketTickers" ? tickers : META);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

describe("TxFlow venue definition", () => {
  it("is market-data only, unofficial, unverified funding, alias txf", () => {
    const def = getVenue("txflow");
    expect(def.roles).toEqual(["marketData"]);
    expect(def.capabilities).toBeNull();
    expect(def.fundingVerified).toBe(false);
    expect(def.apiStatus.kind).toBe("unofficial");
    expect(resolveVenueId("txf")).toBe("txflow");
    expect(def.networks.testnet).toBeNull();
  });

  it("requireCapabilities refuses with CAPABILITY_UNSUPPORTED (role-based), not NOT_IMPLEMENTED", () => {
    try {
      requireCapabilities(getVenue("txflow"));
      throw new Error("no throw");
    } catch (e) {
      expect((e as PerpError).structured.code).toBe("CAPABILITY_UNSUPPORTED");
      expect((e as PerpError).structured.details).toMatchObject({ venue: "txflow", feature: "trading" });
      expect((e as PerpError).message).toMatch(/unofficial read-only API/);
    }
  });
});

describe("exact conversions", () => {
  it("stepFromSzDecimals handles negative szDecimals", () => {
    expect(stepFromSzDecimals(4)).toBe("0.0001");
    expect(stepFromSzDecimals(1)).toBe("0.1");
    expect(stepFromSzDecimals(0)).toBe("1");
    expect(stepFromSzDecimals(-1)).toBe("10");
    expect(stepFromSzDecimals(-5)).toBe("100000");
  });

  it("percentToFraction is an exact two-place shift", () => {
    expect(percentToFraction("0.00125")).toBe("0.0000125");
    expect(percentToFraction("0.00125000")).toBe("0.0000125");
    expect(percentToFraction("-0.00310218")).toBe("-0.0000310218");
    expect(percentToFraction("1.5")).toBe("0.015");
    expect(percentToFraction("100")).toBe("1");
    expect(percentToFraction("0")).toBe("0");
    expect(percentToFraction("-0.000")).toBe("0");
    expect(() => percentToFraction("1e-5")).toThrow(PerpError);
  });

  it("perpMeta rows: delisted dropped, halt → not tradable, TradFi classified explicitly", () => {
    const rows = META.universe.map(toTxflowMarketMeta);
    expect(rows[3]).toBeNull();
    expect(rows[1]).toMatchObject({ symbol: "DOGE", stepSize: "10", assetClass: "crypto", canonical: "DOGE" });
    expect(rows[2]).toMatchObject({ symbol: "XAU", assetClass: "commodity", canonical: "GOLD", halted: true });
    expect(() => toTxflowMarketMeta({ ...META.universe[0], index: "1" })).toThrow(/shape changed/);
  });
});

describe("snapshot join (by coin id, never by position)", () => {
  it("joins by id and drops an unknown coin id with a warning", () => {
    const dir = META.universe.map(toTxflowMarketMeta).filter((m): m is TxflowMarketMeta => m !== null);
    const warn = vi.fn();
    const joined = joinSnapshot(dir, CTXS, warn);
    expect(joined.get(1)?.markPx).toBe("83263.0");
    expect(joined.get(10)?.fundingPct).toBe("-0.00310218");
    expect(joined.has(777)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown coin id(s): 777"));
  });
});

describe("TxflowClient error mapping", () => {
  const client = () => new TxflowClient("https://api.txflow.test", { capacity: 100, refillPerSec: 100, weights: null });

  it("HTTP 200 with {message} is EXCHANGE_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { message: "Orderbook for coin '99999' not found" }));
    await expect(client().info({ type: "l2Book", coin: "99999" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("HTTP 403 (allowlist) is EXCHANGE_ERROR with the unofficial remediation, no fallback", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: "This action is not allowed." }));
    const e = await client().info({ type: "meta" }).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("EXCHANGE_ERROR");
    expect(e.structured.remediation).toMatch(/unofficial API refused "meta"/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a network failure is EXCHANGE_UNREACHABLE; a non-JSON body is shape drift", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client().info({ type: "perpMeta" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(client().info({ type: "perpMeta" })).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("one-shot WS snapshot", () => {
  it("subscribes to allAssetCtxs, ignores other frames, resolves the first snapshot and closes", async () => {
    const ws = fakeWs([{ channel: "subscriptionResponse", data: {} }, { channel: "allAssetCtxs", data: { ctxs: CTXS } }]);
    const out = await fetchAllAssetCtxsOnce("wss://x", ws.factory, 1_000);
    expect(out).toHaveLength(4);
    expect(JSON.parse(ws.sent[0])).toEqual({ method: "subscribe", type: "allAssetCtxs", subscription: { type: "allAssetCtxs" } });
    expect(ws.closed()).toBe(true);
  });

  it("no snapshot within the timeout → EXCHANGE_UNREACHABLE", async () => {
    const ws = fakeWs([]);
    await expect(fetchAllAssetCtxsOnce("wss://x", ws.factory, 30)).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
  });

  it("socket error → EXCHANGE_UNREACHABLE; malformed frame → EXCHANGE_ERROR", async () => {
    await expect(fetchAllAssetCtxsOnce("wss://x", fakeWs(null, { error: true }).factory, 1_000)).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
    await expect(fetchAllAssetCtxsOnce("wss://x", fakeWs([{ channel: "allAssetCtxs", data: {} }]).factory, 1_000)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("markets and funding (fixture)", () => {
  const deps = () => ({ wsFactory: fakeWs([{ channel: "allAssetCtxs", data: { ctxs: CTXS } }]).factory, warn: vi.fn() });

  it("markets: DOGE step 10, halted XAU not tradable, missing snapshot rows dropped", async () => {
    fetchMock.mockImplementation(routeInfo());
    const markets = await fetchTxflowMarkets("mainnet", deps());
    const by = Object.fromEntries(markets.map(m => [m.symbol, m]));
    expect(by.DOGE).toMatchObject({ stepSize: "10", venueSymbol: "10", fundingRate: "-0.0000310218" });
    expect(by.BTC).toMatchObject({ fundingRate: "0.0000125", tickSize: "0.1", stepSize: "0.0001", maxLeverage: 75, tradable: true });
    // next − prev funding ≠ 1h → that market's funding is unknown (null), never assumed hourly.
    expect(by.XAU).toMatchObject({ fundingRate: null, tradable: false });
  });

  it("funding rows: percent per hour → fraction per hour, basis 1h, unknown-interval rows omitted", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, META));
    const rates = await fetchTxflowFundingRates("mainnet", deps());
    expect(rates.map(r => [r.symbol, r.rate])).toEqual([["BTC", "0.0000125"], ["DOGE", "-0.0000310218"]]);
    expect(rates[0]).toMatchObject({ basis: { kind: "perHours", hours: 1 }, nextFundingTime: 1_791_907_200_000 });
  });

  it("a missing next / prev funding time leaves the interval unproven → funding null, no funding row", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, META));
    const ctxs = [{ coin: "1", ctx: ctx("0.00125000", "83263.0", { prevFundingTime: undefined }) }];
    fetchMock.mockImplementation(routeInfo());
    const d = { wsFactory: fakeWs([{ channel: "allAssetCtxs", data: { ctxs } }]).factory, warn: vi.fn() };
    expect((await fetchTxflowMarkets("mainnet", d)).find(m => m.symbol === "BTC")?.fundingRate).toBeNull();
    fetchMock.mockResolvedValue(jsonResponse(200, META));
    const d2 = { wsFactory: fakeWs([{ channel: "allAssetCtxs", data: { ctxs } }]).factory, warn: vi.fn() };
    expect(await fetchTxflowFundingRates("mainnet", d2)).toEqual([]);
  });

  it("testnet → NOT_IMPLEMENTED (no testnet)", async () => {
    await expect(fetchTxflowMarkets("testnet", deps())).rejects.toMatchObject({ structured: { code: "NOT_IMPLEMENTED" } });
  });
});

describe("24 h volume from allMarketTickers (QA 0.15.0: volume24h was always null)", () => {
  const deps = () => ({ wsFactory: fakeWs([{ channel: "allAssetCtxs", data: { ctxs: CTXS } }]).factory, warn: vi.fn() });

  it("joined by instrumentId = perpMeta index; \"\" → null; spot ids ≥ 10000 ignored", async () => {
    fetchMock.mockImplementation(routeInfo());
    const by = Object.fromEntries((await fetchTxflowMarkets("mainnet", deps())).map(m => [m.symbol, m]));
    expect(by.BTC.volume24h).toBe("70157052.3703057");
    expect(by.DOGE.volume24h).toBeNull();
    expect(by.XAU.volume24h).toBeNull(); // no ticker row
  });

  it("a non-list answer → EXCHANGE_ERROR (never all-null volumes)", async () => {
    fetchMock.mockImplementation(routeInfo({ message: "nope" }));
    await expect(fetchTxflowMarkets("mainnet", deps())).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("klines (QA 0.15.0, perp_app)", () => {
  const candle = (t: number, i = "1h") => ({ t, o: "1", h: "2", l: "0.5", c: "1.5", v: "3", n: 4, s: "1", i, T: t + 3_599_999 });
  const adapterWith = (info: (body: { req: { startTime: number; endTime: number; interval: string } }) => unknown) => {
    const a = new TxflowPublicAdapter(getVenue("txflow"), "mainnet");
    const spy = vi.fn(async (b: { req: { startTime: number; endTime: number; interval: string } }) => info(b));
    Object.assign(a as object, { market: vi.fn(async () => ({ index: 1, symbol: "BTC" })), client: { info: spy } });
    return { a, spy };
  };

  it("a range above the venue's silent ~3000-bar cap is read in windows of ≤ 2900 bars and merged", async () => {
    const H = 3_600_000;
    const end = 1792404000000;
    const start = end - 200 * 24 * H; // 4800 bars: one request would answer [] (live)
    const { a, spy } = adapterWith(({ req }) => {
      if ((req.endTime - req.startTime) / H > 3000) return []; // venue behaviour
      const out = [];
      for (let t = Math.ceil(req.startTime / H) * H; t <= req.endTime; t += H) out.push(candle(t));
      return out;
    });
    const k = await a.getKlines("BTC", "1h", start, end);
    expect(spy.mock.calls.length).toBe(2);
    expect(spy.mock.calls.every(([b]) => (b.req.endTime - b.req.startTime) / H <= 2900)).toBe(true);
    expect(k.length).toBe(4801);
    expect(new Set(k.map(c => c.time)).size).toBe(k.length);
    expect(k.map(c => c.time)).toEqual([...k.map(c => c.time)].sort((x, y) => x - y));
  });

  it.each(["3d", "1w", "1M"])("%s (advertised, always [] live) → INVALID_PARAMS before any request", async (iv) => {
    const { a, spy } = adapterWith(() => []);
    await expect(a.getKlines("BTC", iv, 0, 1)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("public-only adapter", () => {
  it("every account / trading method refuses with CAPABILITY_UNSUPPORTED and sends nothing", async () => {
    const a = new TxflowPublicAdapter(getVenue("txflow"), "mainnet");
    const calls: Array<() => Promise<unknown>> = [
      () => a.getBalance(), () => a.getPositions(), () => a.getOpenOrders(), () => a.getOrderHistory(), () => a.getTradeHistory(),
      () => a.getFundingPayments(), () => a.marketOrder(), () => a.limitOrder(), () => a.editOrder(), () => a.cancelOrder(),
      () => a.cancelAllOrders(), () => a.setLeverage(), () => a.stopOrder(), () => a.getFundingHistory(),
    ];
    for (const c of calls) await expect(c()).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("market rows carry venueApi: unofficial and fundingVerified: false", async () => {
    fetchMock.mockImplementation(routeInfo());
    const a = new TxflowPublicAdapter(getVenue("txflow"), "mainnet");
    vi.spyOn(a, "getVenueMarkets").mockResolvedValue(await fetchTxflowMarkets("mainnet", { wsFactory: fakeWs([{ channel: "allAssetCtxs", data: { ctxs: CTXS } }]).factory, warn: vi.fn() }));
    const rows = await a.getMarkets();
    expect(rows.every(r => r.venueApi === "unofficial" && r.fundingVerified === false)).toBe(true);
  });
});

describe("write-refusal table: -e txflow writes refuse before any I/O", () => {
  type Env = { ok: boolean; error?: { code: string; message: string; details?: Record<string, unknown> } };
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
    // Exactly one JSON document on stdout (pretty-printed or not).
    return { env: JSON.parse(out.join("").trim()) as Env, docs: 1 };
  };

  const CASES: string[][] = [
    ["-e", "txflow", "trade", "market", "BTC", "buy", "0.001"],
    ["-e", "txflow", "trade", "buy", "BTC", "0.001"],
    ["-e", "txflow", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["-e", "txflow", "trade", "cancel", "BTC", "123"],
    ["-e", "txflow", "trade", "cancel-all"],
    ["-e", "txflow", "trade", "leverage", "BTC", "5"],
    ["-e", "txflow", "trade", "close", "BTC"],
    ["-e", "txflow", "portfolio"],
    ["-e", "txflow", "account", "trades"],
    ["-e", "txflow", "account", "positions"],
    ["-e", "txflow", "account", "orders"],
    ["funds", "deposit", "txflow", "10"],
    ["funds", "withdraw", "txflow", "10"],
    ["--dry-run", "funds", "withdraw", "txflow", "10"],
    ["wallet", "agent", "approve", "txflow"],
    ["wallet", "agent", "import", "txflow"],
    ["wallet", "builder", "approve", "txflow"],
    ["wallet", "agent", "revoke", "txflow", "x"],
    ["-e", "txflow", "trade", "tpsl", "BTC", "long", "--tp", "90000"],
    ["-e", "txflow", "trade", "stop", "BTC", "sell", "0.001", "70000"],
    ["-e", "txflow", "funds", "transfer", "10", "0x0000000000000000000000000000000000000001"],
    ["funds", "rebalance", "execute", "--exchanges", "txflow,hyperliquid"],
    ["-e", "txflow", "strategy", "twap", "BTC", "buy", "0.01", "10m"],
    ["-e", "txflow", "strategy", "grid", "BTC", "--upper", "90000", "--lower", "80000", "--grids", "5", "--size", "0.001"],
    ["-e", "txflow", "strategy", "dca", "BTC", "buy", "10", "1h"],
    ["-e", "txflow", "strategy", "trailing-stop", "BTC", "--trail", "1"],
    ["-e", "txflow", "strategy", "quick-grid", "BTC"],
    ["arb", "exec", "BTC", "txflow", "hyperliquid", "10"],
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

describe("setup venue selection", () => {
  it("txflow / txf is a capability refusal (CAPABILITY_UNSUPPORTED), not an unknown venue", () => {
    for (const v of ["txflow", "txf"]) {
      expect(() => resolveSetupVenue(v, "mainnet")).toThrow(expect.objectContaining({
        structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED", details: expect.objectContaining({ venue: "txflow", feature: "setup" }) }),
      }));
    }
    expect(() => parseVenueList("hyperliquid,txflow", "mainnet")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }) }));
    // A name that is not a venue at all stays INVALID_PARAMS.
    expect(() => resolveSetupVenue("nope", "mainnet")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
});
