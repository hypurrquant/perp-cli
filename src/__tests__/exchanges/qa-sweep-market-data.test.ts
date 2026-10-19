/**
 * Pre-release QA sweep (0.15.0) — venue market data: unknown is null, never 0.
 *  1. Public trade tape rows carry fee null (the tape has no fee for the viewer), not "0".
 *  2. Lighter /candles has no per-candle trade count → trades null; V is the quote volume.
 *  3. QFEX /candles leaves baseTokenVolume "0" next to a populated usdVolume → volume null,
 *     quoteVolume mapped from usdVolume.
 *  4. Ondo /v1/perps/contracts reports indexPrice "0" on disabled contracts → null.
 *  5. Hyperliquid: delisted assets (meta isDelisted) are not listed; an unlisted coin is
 *     SYMBOL_NOT_FOUND with remediation on book / trades (the venue answers null), never an empty book.
 *  6. QFEX book / kline / funding of an unknown symbol → SYMBOL_NOT_FOUND (was the venue's 404 as
 *     a retryable EXCHANGE_ERROR); Lighter's unknown market carries the market-list remediation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { seedAsterDirectory } from "./aster-directory.js";

vi.mock("../../cache.js", async () => ({
  withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  fetchAndCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidateCache: () => {},
  TTL_ACCOUNT: 1000,
  TTL_MARKETS: 1000,
  TTL_PRICES: 1000,
  TTL_MARKET: 1000,
}));

import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { LighterAdapter } from "../../exchanges/lighter.js";
import { qfexCandleVolumes } from "../../exchanges/qfex/adapter.js";
import { priceOrNull } from "../../exchanges/ondo/public.js";
import "../../exchanges/venues/index.js";

afterEach(() => vi.restoreAllMocks());

function hl(routes: Record<string, (b: Record<string, unknown>) => unknown>): HyperliquidAdapter {
  const a = new HyperliquidAdapter(undefined, false);
  (a as unknown as { _infoPost: (b: Record<string, unknown>) => Promise<unknown> })._infoPost = async (b) => {
    const r = routes[String(b.type)];
    if (!r) throw new Error(`unexpected info ${String(b.type)}`);
    return r(b);
  };
  const t = a as unknown as { _assetMap: Map<string, number>; _assetMapReverse: Map<number, string> };
  t._assetMap.set("BTC-PERP", 0);
  t._assetMap.set("MATIC-PERP", 1);
  return a;
}

function lighter(): LighterAdapter {
  const a = new LighterAdapter("0xabc", false);
  (a as unknown as { _marketMap: Map<string, number> })._marketMap = new Map([["BTC", 1]]);
  (a as unknown as { ensureMarketMap: () => Promise<void> }).ensureMarketMap = async () => {};
  return a;
}

describe("1. public trade tape: fee is null, not 0", () => {
  it("Hyperliquid recentTrades", async () => {
    const a = hl({ recentTrades: () => [{ coin: "BTC", side: "B", px: "83256.0", sz: "0.05", time: 1, users: ["0x1", "0x2"] }] });
    const [t] = await a.getRecentTrades("BTC");
    expect(t).toMatchObject({ side: "buy", price: "83256.0", size: "0.05", fee: null });
  });

  it("Lighter recentTrades: taker_fee / maker_fee are rates, not the viewer's fee", async () => {
    const a = lighter();
    (a as unknown as { restGet: () => Promise<unknown> }).restGet = async () => ({
      trades: [{ timestamp: 1791945367971, price: "83213.8", size: "0.00003", is_maker_ask: true, taker_fee: 100, maker_fee: 40 }],
    });
    const [t] = await a.getRecentTrades("BTC", 1);
    expect(t.fee).toBeNull();
  });

  it("Aster /fapi/v3/trades", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const a = new AsterAdapter(undefined, false);
    seedAsterDirectory(a);
    (a as unknown as Record<string, unknown>)._publicGet = vi.fn(async () => [{ time: 1, symbol: "BTCUSDT", isBuyerMaker: false, price: "83000", qty: "0.1" }]);
    const [t] = await a.getRecentTrades("BTC");
    expect(t).toMatchObject({ side: "buy", fee: null });
  });
});

describe("2. Lighter candles: no trade count → null; V → quoteVolume", () => {
  it("live /candles shape (t o h l c v V i)", async () => {
    const a = lighter();
    (a as unknown as { getCandles: () => Promise<unknown> }).getCandles = async () => ({
      code: 200, r: "1h", c: [{ t: 1791939600000, o: 83379, h: 83419.2, l: 83123.3, c: 83286.9, v: 407.19, V: 33903932.72, i: 34504959654 }],
    });
    const [k] = await a.getKlines("BTC", "1h", 1791939600000, 1791939600000);
    expect(k.trades).toBeNull();
    expect(k.volume).toBe("407.19");
    expect(k.quoteVolume).toBe("33903932.72");
  });
});

describe("3. QFEX candle volumes", () => {
  it("base '0' next to a populated usdVolume is a placeholder → volume null, quoteVolume mapped", () => {
    expect(qfexCandleVolumes({ baseTokenVolume: "0", usdVolume: "52534.48506" })).toEqual({ volume: null, quoteVolume: "52534.48506" });
  });
  it("both zero = a candle that really had no volume", () => {
    expect(qfexCandleVolumes({ baseTokenVolume: "0", usdVolume: "0" })).toEqual({ volume: "0", quoteVolume: "0" });
  });
  it("a populated base volume is kept", () => {
    expect(qfexCandleVolumes({ baseTokenVolume: "12.5", usdVolume: "1175" })).toEqual({ volume: "12.5", quoteVolume: "1175" });
  });
  it("a non-decimal field is a payload error, not a guess", () => {
    expect(() => qfexCandleVolumes({ baseTokenVolume: "0", usdVolume: undefined })).toThrow(/usdVolume/);
  });
});

describe("4. Ondo index price", () => {
  it("'0' (disabled contract) → null; a real price is kept; missing → null", () => {
    expect(priceOrNull("0")).toBeNull();
    expect(priceOrNull("0.0")).toBeNull();
    expect(priceOrNull("236.2")).toBe("236.2");
    expect(priceOrNull(undefined)).toBeNull();
    expect(priceOrNull("")).toBeNull();
  });
});

describe("5. Hyperliquid delisted assets and unlisted coins", () => {
  const META = [
    { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "MATIC", szDecimals: 1, maxLeverage: 20, isDelisted: true }] },
    [{ markPx: "83000", oraclePx: "83010", funding: "0.0000125", dayNtlVlm: "1000", openInterest: "100" },
      { markPx: "0.37621", oraclePx: "0.37621", funding: "0.0", dayNtlVlm: "0.0", openInterest: "0.0" }],
  ];

  it("getMarkets omits isDelisted assets (their zeroed funding / volume / OI are not market data)", async () => {
    const a = hl({ metaAndAssetCtxs: () => META, allMids: () => ({ BTC: "83000", MATIC: "0.37621" }) });
    const m = await a.getMarkets();
    expect(m.map((x) => x.symbol)).toEqual(["BTC-PERP"]);
    expect(m[0]).toMatchObject({ openInterest: "100", fundingRate: "0.0000125" });
  });

  it("a delisted coin still resolves for orders / positions: getAssetIndex, szDecimals, lot step", async () => {
    const a = hl({ metaAndAssetCtxs: () => META, allMids: () => ({}) });
    (a as unknown as { _szDecimalsMap: Map<string, number> })._szDecimalsMap.set("MATIC-PERP", 1);
    await a.getMarkets();
    await expect(a.getAssetIndex("MATIC")).resolves.toBe(1);
    expect(a.getSzDecimals("MATIC")).toBe(1);
    expect(a.lotStepOf("MATIC")).toBe("0.1");
    // the close path's mark price reads meta directly, not the filtered market list
    await expect(a.markPrice("MATIC")).resolves.toBe(0.37621);
  });

  it("delistedMessage names a delisted coin (market info says why it is not listed)", async () => {
    const a = hl({ metaAndAssetCtxs: () => META, allMids: () => ({}) });
    await a.getMarkets();
    expect(a.delistedMessage("matic")).toMatch(/MATIC is delisted on Hyperliquid \(positions \/ history still readable\)/);
    expect(a.delistedMessage("BTC")).toBeNull();
    expect(a.delistedMessage("NOPE")).toBeNull();
  });

  it("legacy public rows (market data / funding scans) skip delisted assets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(META), { status: 200 })));
    try {
      const { legacyPublicData } = await import("../../funding/legacy-public.js");
      const rows = await legacyPublicData("hyperliquid").fetchMarkets("mainnet");
      expect(rows.map((r) => r.symbol)).toEqual(["BTC"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parseHyperliquidMetaRaw (arb scans) skips delisted assets", async () => {
    const { parseHyperliquidMetaRaw } = await import("../../api/public/hyperliquid.js");
    const { rates, prices } = parseHyperliquidMetaRaw(META);
    expect([...rates.keys()]).toEqual(["BTC"]);
    expect([...prices.keys()]).toEqual(["BTC"]);
  });

  it("l2Book null (unlisted coin) → SYMBOL_NOT_FOUND with the market-list remediation, not an empty book", async () => {
    const a = hl({ l2Book: () => null });
    await expect(a.getOrderbook("NOPE")).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", remediation: "List markets: perp -e hyperliquid market list" }),
    });
  });

  it("recentTrades of an unlisted coin → SYMBOL_NOT_FOUND before the request (the venue answers HTTP 500 \"null\")", async () => {
    const recentTrades = vi.fn(() => { throw new Error("Hyperliquid info recentTrades failed (500): null"); });
    const a = hl({ recentTrades });
    await expect(a.getRecentTrades("NOPE")).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", retryable: false, remediation: "List markets: perp -e hyperliquid market list" }),
    });
    expect(recentTrades).not.toHaveBeenCalled();
  });

  it("a listed coin with an empty book stays a (two-empty-sides) book", async () => {
    const a = hl({ l2Book: () => ({ coin: "MATIC", levels: [[], []] }) });
    await expect(a.getOrderbook("MATIC")).resolves.toEqual({ bids: [], asks: [] });
  });
});

describe("6. unknown-symbol errors carry remediation", () => {
  it("Lighter unknown market", async () => {
    const a = lighter();
    await expect(a.getOrderbook("NOPE")).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", remediation: "List markets: perp -e lighter market list" }),
    });
  });

  it("Hyperliquid klines of an unlisted coin → SYMBOL_NOT_FOUND before the request (candleSnapshot answers HTTP 500)", async () => {
    const candleSnapshot = vi.fn(() => { throw new Error("Hyperliquid info candleSnapshot failed (500): null"); });
    const a = hl({ candleSnapshot });
    await expect(a.getKlines("NOPE", "1h", Date.now() - 3_600_000, Date.now())).rejects.toMatchObject({ structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", retryable: false }) });
    expect(candleSnapshot).not.toHaveBeenCalled();
  });

  it("Aster public read answering -1121 Invalid symbol → SYMBOL_NOT_FOUND (was UNKNOWN 500)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 })));
    try {
      const { AsterAdapter } = await import("../../exchanges/aster.js");
      const a = new AsterAdapter(undefined, false);
      await expect(a.getOrderbook("NOPE")).rejects.toMatchObject({
        structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", remediation: "List markets: perp -e aster market list" }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Aster: any other HTTP error stays a plain venue error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    try {
      const { AsterAdapter } = await import("../../exchanges/aster.js");
      const a = new AsterAdapter(undefined, false);
      await expect(a.getOrderbook("BTC")).rejects.toThrow(/failed \(502\)/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("QFEX book / klines / funding resolve the symbol against refdata first (no 404 → EXCHANGE_ERROR)", async () => {
    const { QfexAdapter } = await import("../../exchanges/qfex/adapter.js");
    const a = Object.create(QfexAdapter.prototype) as InstanceType<typeof QfexAdapter>;
    const publicGet = vi.fn(async () => { throw new Error("must not reach the venue"); });
    Object.assign(a as object, { instruments: { at: Date.now(), bySymbol: new Map() }, client: { publicGet } });
    for (const call of [() => a.getOrderbook("NOPE"), () => a.getKlines("NOPE", "1h", 0, 1), () => a.getFundingHistory("NOPE", 2)]) {
      await expect(call()).rejects.toMatchObject({
        structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", retryable: false, remediation: "List markets: perp -e qfex market list" }),
      });
    }
    expect(publicGet).not.toHaveBeenCalled();
  });
});
