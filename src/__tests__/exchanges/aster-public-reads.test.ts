/**
 * Aster public reads (reported from the perp_app port against v0.14.2):
 *  1. exchangeInfo has no maxLeverage → null (was a hard-coded 50 on every market).
 *  2. A symbol missing from premiumIndex is not listed (was listed at last price / "0").
 *  3. USD1 / U quoted perps are not listed (the CLI symbol mapping only addresses USDT).
 *  4. klines are paged in 1500-bar requests (was cut to the first 500 bars).
 */
import { describe, it, expect, vi } from "vitest";

const SYMBOLS = [
  { symbol: "BTCUSDT", contractType: "PERPETUAL", status: "TRADING", quoteAsset: "USDT", quantityPrecision: 3, filters: [{ filterType: "LOT_SIZE", stepSize: "0.001" }] },
  { symbol: "ETHUSDT", contractType: "PERPETUAL", status: "TRADING", quoteAsset: "USDT", quantityPrecision: 3, filters: [] },
  { symbol: "BTCUSD1", contractType: "PERPETUAL", status: "TRADING", quoteAsset: "USD1", quantityPrecision: 3, filters: [] },
  { symbol: "ETHU", contractType: "PERPETUAL", status: "TRADING", quoteAsset: "U", quantityPrecision: 3, filters: [] },
];

async function adapter(publicGet: (path: string, params?: Record<string, string>) => unknown) {
  const { AsterAdapter } = await import("../../exchanges/aster.js");
  const a = new AsterAdapter(undefined, false);
  const t = a as unknown as Record<string, unknown>;
  t._publicGet = vi.fn(async (path: string, params?: Record<string, string>) => publicGet(path, params));
  t._loadFundingInfo = vi.fn(async () => undefined);
  return a;
}

const marketsRoute = (premiums: unknown) => (path: string) => {
  if (path === "/fapi/v3/exchangeInfo") return { symbols: SYMBOLS };
  if (path === "/fapi/v3/ticker/24hr") return [{ symbol: "BTCUSDT", lastPrice: "83000", quoteVolume: "1" }, { symbol: "ETHUSDT", lastPrice: "2500", quoteVolume: "1" }];
  if (path === "/fapi/v3/premiumIndex") return premiums;
  throw new Error(`unexpected ${path}`);
};

describe("AsterAdapter.getMarkets", () => {
  it("USDT perps only, mark from premiumIndex, maxLeverage null; a symbol without a mark is not listed at 0", async () => {
    const a = await adapter(marketsRoute([{ symbol: "BTCUSDT", markPrice: "83010", lastFundingRate: "0.0001" }, { symbol: "BTCUSD1", markPrice: "83000" }]));
    const m = await a.getMarkets();
    expect(m.map((x) => x.symbol)).toEqual(["BTC"]); // ETHUSDT has no premiumIndex row; USD1 / U not listed
    expect(m[0]).toMatchObject({ markPrice: "83010", maxLeverage: null, fundingRate: "0.0001" });
  });

  it("an unreadable premiumIndex throws (never a last-trade / zero stand-in)", async () => {
    const a = await adapter(marketsRoute({ code: -1 }));
    await expect(a.getMarkets()).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

describe("AsterAdapter.getKlines — 1500-bar pages", () => {
  const bar = (t: number) => [t, "1", "2", "0.5", "1.5", "10", t + 59_999, "15", 7];

  it("pages from the bar after the last one returned until a short page", async () => {
    const t0 = 1_000_000_020_000;
    const calls: Array<Record<string, string>> = [];
    const a = await adapter((path, p) => {
      calls.push(p!);
      const from = Number(p!.startTime);
      const n = from === t0 ? 1500 : 200;
      return Array.from({ length: n }, (_, i) => bar(from + i * 60_000));
    });
    const k = await a.getKlines("BTC", "1m", t0, t0 + 2000 * 60_000);
    expect(k).toHaveLength(1700);
    expect(calls).toHaveLength(2);
    expect(calls[0].limit).toBe("1500");
    expect(Number(calls[1].startTime)).toBe(t0 + 1499 * 60_000 + 1);
    expect(k[0]).toEqual({ time: t0, open: "1", high: "2", low: "0.5", close: "1.5", volume: "10", quoteVolume: "15", trades: 7 });
  });

  it("a non-list answer or a row without a trade count → EXCHANGE_ERROR (no 0 default)", async () => {
    await expect((await adapter(() => ({ code: -1130 }))).getKlines("BTC", "1m", 0, 60_000)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    await expect((await adapter(() => [[1, "1", "1", "1", "1", "1", 2, "1"]])).getKlines("BTC", "1m", 0, 60_000)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

describe("validateTrade with an unpublished max leverage", () => {
  it("maxLeverageForNotional returns null without tiers when the venue publishes none", async () => {
    const { maxLeverageForNotional } = await import("../../exchanges/interface.js");
    expect(maxLeverageForNotional({ maxLeverage: null, marginTiers: null } as never, 1000)).toBeNull();
    expect(maxLeverageForNotional({ maxLeverage: 40, marginTiers: null } as never, 1000)).toBe(40);
  });
});

describe("Aster getFundingHistory — no fabricated rows (reported from the HypurrQuant port, v0.14.2)", () => {
  it("a non-list body or a row without fundingTime → EXCHANGE_ERROR (was [] / a row at time 0)", async () => {
    await expect((await adapter(() => null)).getFundingHistory("BTC", 5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    await expect((await adapter(() => [{ fundingRate: "0.0001" }])).getFundingHistory("BTC", 5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    expect(await (await adapter(() => [{ fundingTime: 1700000000000, fundingRate: "0.0001", markPrice: "83000" }])).getFundingHistory("BTC", 5))
      .toEqual([{ time: 1700000000000, rate: "0.0001", price: "83000", intervalHours: null, rateKind: "lastSettled" }]);
    // The market's interval from /fapi/v3/fundingInfo labels each row.
    const a = await adapter(() => [{ fundingTime: 1700000000000, fundingRate: "0.0001", markPrice: "83000" }]);
    (a as unknown as { _fundingHoursCache: Map<string, number> })._fundingHoursCache.set("BTC", 4);
    expect((await a.getFundingHistory("BTC", 5))[0]).toMatchObject({ intervalHours: 4, rateKind: "lastSettled" });
  });
});

describe("scoreFunding — a failed read is not 'thin history'", () => {
  it("throws on a failed history read; null only for fewer than 2 points", async () => {
    const { scoreFunding } = await import("../../bot/strategies/funding-arb-utils.js");
    const venue = (h: () => Promise<unknown>) => ({ name: "hyperliquid", getFundingHistory: vi.fn(h) }) as never;
    await expect(scoreFunding(venue(async () => { throw new Error("HTTP 429"); }), "ETH", "hyperliquid", 10)).rejects.toThrow("429");
    expect(await scoreFunding(venue(async () => [{ time: 1, rate: "0.0001", price: null }]), "ETH", "hyperliquid", 10)).toBeNull();
    const ok = await scoreFunding(venue(async () => [{ time: 1, rate: "0.0001", price: null }, { time: 2, rate: "0.0002", price: null }]), "ETH", "hyperliquid", 10);
    expect(ok).toMatchObject({ symbol: "ETH", payments: 2 });
  });
});

describe("Aster edge reads", () => {
  it("klines: start after end → INVALID_PARAMS; a full page that does not advance → EXCHANGE_ERROR", async () => {
    const get = vi.fn(() => []);
    await expect((await adapter(get)).getKlines("BTC", "1m", 2, 1)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
    expect(get).not.toHaveBeenCalled();
    const stuck = await adapter(() => Array.from({ length: 1500 }, () => [5, "1", "1", "1", "1", "1", 6, "1", 1]));
    await expect(stuck.getKlines("BTC", "1m", 10, 10_000_000)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("funding history: an empty-string fundingTime is not time 0", async () => {
    await expect((await adapter(() => [{ fundingTime: "", fundingRate: "0.0001" }])).getFundingHistory("BTC", 5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("getMarkets: an exchangeInfo without a symbol list or a non-list ticker → EXCHANGE_ERROR", async () => {
    const route = (info: unknown, tickers: unknown) => (path: string) =>
      path === "/fapi/v3/exchangeInfo" ? info : path === "/fapi/v3/ticker/24hr" ? tickers : [];
    await expect((await adapter(route({}, []))).getMarkets()).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    await expect((await adapter(route({ symbols: SYMBOLS }, { code: -1 }))).getMarkets()).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

describe("cappedLeverage — an unpublished max is not 1x", () => {
  it("caps by published maxes only, and logs each unknown leg", async () => {
    const { cappedLeverage } = await import("../../bot/strategies/funding-arb-utils.js");
    const log = vi.fn();
    expect(cappedLeverage(3, [{ exchange: "hyperliquid", maxLeverage: 40 }, { exchange: "aster", maxLeverage: undefined }], log)).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("aster");
    expect(cappedLeverage(10, [{ exchange: "hyperliquid", maxLeverage: 5 }], log)).toBe(5);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("SpotPerpArbStrategy.findPerpCandidates — a failed history read", () => {
  it("logs the failing venue and keeps the others", async () => {
    const { SpotPerpArbStrategy } = await import("../../bot/strategies/spot-perp-arb-strategy.js");
    const s = new SpotPerpArbStrategy() as unknown as Record<string, unknown>;
    s.scoreFundingLocal = vi.fn(async (_a: unknown, sym: string, ex: string) => {
      if (ex === "aster") throw new Error("HTTP 429");
      return { symbol: sym, annualized: 12, consistency: 1, payments: 6 };
    });
    const rates = new Map([
      ["aster", new Map([["ETH", { rate: 0.0001, price: 2500 }]])],
      ["hyperliquid", new Map([["ETH", { rate: 0.0001, price: 2500 }]])],
    ]);
    const adapters = new Map([["aster", {}], ["hyperliquid", {}]]);
    const log = vi.fn();
    const find = s.findPerpCandidates as (...a: unknown[]) => Promise<Array<{ exchange: string }>>;
    const out = await find.call(s, "ETH", adapters, rates, new Set(["aster", "hyperliquid"]), log);
    expect(out.map((c) => c.exchange)).toEqual(["hyperliquid"]);
    expect(log.mock.calls.some(([m]) => String(m).includes("aster") && String(m).includes("unreadable"))).toBe(true);
  });
});

describe("maxLeverageForNotional — tiers without a headline", () => {
  it("uses the first tier below every threshold instead of null", async () => {
    const { maxLeverageForNotional } = await import("../../exchanges/interface.js");
    const m = { maxLeverage: null, marginTiers: [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 1e6, maxLeverage: 10 }] } as never;
    expect(maxLeverageForNotional(m, 100)).toBe(20);
    expect(maxLeverageForNotional(m, 2e6)).toBe(10);
  });
});
