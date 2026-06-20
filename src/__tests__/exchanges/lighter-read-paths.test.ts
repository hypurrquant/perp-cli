/**
 * Regression guards for Lighter read-path / response-parsing fixes (qa/2026-06-21):
 *  - getRecentTrades: `timestamp` is already milliseconds — must NOT ×1000.
 *  - getKlines: /candles returns the array under key `c`, not `candles`.
 *  - getFundingRates: /funding-rates is a multi-exchange aggregate — keep only Lighter's.
 */
import { describe, it, expect } from "vitest";
import { LighterAdapter } from "../../exchanges/lighter.js";

function makeAdapter(): LighterAdapter {
  const a = new LighterAdapter("0xabc", true);
  (a as unknown as { _marketMap: Map<string, number> })._marketMap = new Map([["BTC", 1], ["ETH", 2]]);
  (a as unknown as { ensureMarketMap: () => Promise<void> }).ensureMarketMap = async () => {};
  return a;
}

describe("LighterAdapter read-path parsing regressions", () => {
  it("getRecentTrades keeps the already-millisecond timestamp (no ×1000)", async () => {
    const a = makeAdapter();
    (a as unknown as { restGet: () => Promise<unknown> }).restGet = async () => ({
      trades: [{ timestamp: 1781970606461, price: "63000", size: "0.1", is_maker_ask: true }],
    });
    const trades = await a.getRecentTrades("BTC", 1);
    expect(trades[0].time).toBe(1781970606461); // not 1781970606461000 (year ~58000)
  });

  it("getKlines reads candles from key `c` (not `candles`)", async () => {
    const a = makeAdapter();
    (a as unknown as { getCandles: () => Promise<unknown> }).getCandles = async () => ({
      code: 200, c: [{ t: 1781970000000, o: "1", h: "2", l: "0.5", c: "1.5", v: "10", n: 3 }],
    });
    const klines = await a.getKlines("BTC", "1h", 0, 0);
    expect(klines).toHaveLength(1);
    expect(klines[0].open).toBe("1");
    expect(klines[0].close).toBe("1.5");
  });

  it("getFundingRates keeps only Lighter's rate, dropping other exchanges (last-write-wins contamination)", async () => {
    const a = makeAdapter();
    (a as unknown as { restGet: () => Promise<unknown> }).restGet = async () => ({
      funding_rates: [
        { exchange: "binance", market_id: 1, symbol: "BTC", rate: 0.001 },
        { exchange: "lighter", market_id: 1, symbol: "BTC", rate: 0.00002 },
        { exchange: "bybit", market_id: 1, symbol: "BTC", rate: 0.0005 }, // would win without the filter
      ],
    });
    const map = await (a as unknown as { getFundingRates: () => Promise<Map<string, { rate: string }>> }).getFundingRates();
    expect(map.get("BTC")?.rate).toBe("0.00002");
  });
});
