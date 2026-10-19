/**
 * Pre-release QA sweep (0.15.0), review M4 / L6 — candle volume is a number or null, never "" or
 * "undefined":
 *  - Lighter / Hyperliquid candles without a volume field gave String(undefined ?? "") = "".
 *  - Aster k[7] (quote volume) missing gave "undefined"; it is now a payload error like the open
 *    time / trade count.
 *  - Strategies treat any non-finite volume as unknown (no VWAP, no volume-confirmed breakout)
 *    and momentum-breakout logs "no volume" once per run, not every tick.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import { klineVolumes } from "../bot/indicators.js";
import { MomentumBreakoutStrategy } from "../bot/strategies/momentum-breakout.js";
import type { ExchangeKline } from "../exchanges/interface.js";

afterEach(() => vi.restoreAllMocks());

describe("adapters: missing candle volume → null", () => {
  it("Lighter: no v / V → volume null, quoteVolume null", async () => {
    const a = new LighterAdapter("0xabc", false);
    (a as unknown as { getCandles: () => Promise<unknown> }).getCandles = async () => ({ code: 200, r: "1h", c: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5 }] });
    const [k] = await a.getKlines("BTC", "1h", 0, 1);
    expect(k.volume).toBeNull();
    expect(k.quoteVolume).toBeNull();
  });

  it("Hyperliquid: no v → volume null", async () => {
    const a = new HyperliquidAdapter(undefined, false);
    (a as unknown as { _assetMap: Map<string, number> })._assetMap.set("BTC-PERP", 0);
    (a as unknown as { _infoPost: unknown })._infoPost = async () => [{ t: 1, o: "1", h: "2", l: "0.5", c: "1.5", n: 3 }];
    const [k] = await a.getKlines("BTC", "1h", 0, 1);
    expect(k.volume).toBeNull();
    expect(k.trades).toBe(3);
  });

  it("Aster: a row without k[7] (quote volume) is a payload error, not \"undefined\"", async () => {
    const { AsterAdapter } = await import("../exchanges/aster.js");
    const a = new AsterAdapter(undefined, false);
    (a as unknown as Record<string, unknown>)._publicGet = vi.fn(async () => [[1000, "1", "2", "0.5", "1.5", "10", 1999, undefined, 7]]);
    await expect(a.getKlines("BTC", "1m", 1000, 2000)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

const k = (volume: string | null, close = "100"): ExchangeKline => ({ time: 0, open: close, high: close, low: close, close, volume, quoteVolume: null, trades: null });

describe("klineVolumes", () => {
  it("all finite → numbers; null, '', 'undefined' or NaN anywhere → null (unknown)", () => {
    expect(klineVolumes([k("1"), k("2.5")])).toEqual([1, 2.5]);
    for (const bad of [null, "", "undefined", "NaN"]) expect(klineVolumes([k("1"), k(bad)])).toBeNull();
  });
});

describe("momentum-breakout without candle volume", () => {
  it("logs once per run (not every tick) and opens nothing", async () => {
    const s = new MomentumBreakoutStrategy();
    const logs: string[] = [];
    const ctx = { config: { lookbackPeriod: 3 }, state: new Map<string, unknown>(), log: (m: string) => logs.push(m), tick: 0, symbol: "BTC", adapter: {} } as never;
    const snap = { price: 200, klines: [k(""), k(""), k(""), k(""), k("")], orderbook: { bids: [], asks: [] }, openInterest: null } as never;
    await s.init(ctx, snap);
    const a1 = await s.onTick(ctx, snap);
    const a2 = await s.onTick(ctx, snap);
    expect([...a1, ...a2]).toEqual([]);
    expect(logs.filter((l) => /no candle volume/.test(l))).toHaveLength(1);
  });
});
