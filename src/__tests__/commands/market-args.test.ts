/**
 * `perp market` argument rules, the same on every venue (QA 0.15.0 group-4 audit):
 *  S3 --start / --end: unix ms or ISO date (parseInt("2026-10-18") read 2026 ms); start > end → INVALID_PARAMS.
 *  S4 market info accepts the symbol forms book / funding accept (BTC-PERP, BTC-USD, TSLA_24_5-USD, BTC-USDC).
 *  S5 market book --depth reaches the adapter and cuts the JSON too (it printed the full book).
 *  S6 --limit / -l / --depth: positive integers only (GRVT took 0 / -5 as 1, "abc" → ok []; TxFlow -5 → 295 rows).
 *  S9 funding table: "Price" (venue reference price), not "Oracle", plus the interval.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerMarketCommands, parseTimeArg, parsePositiveIntArg, bareSymbolOf } from "../../commands/market.js";
import type { ExchangeAdapter, ExchangeMarketInfo } from "../../exchanges/interface.js";

afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

const BTC: ExchangeMarketInfo = {
  symbol: "BTC", markPrice: "83000", indexPrice: null, fundingRate: "0.0001", volume24h: null, openInterest: "1",
  maxLeverage: 40, sizeDecimals: 5, stepSize: null, fundingHours: 1, marginTiers: null,
};

async function run(adapter: Partial<ExchangeAdapter>, argv: string[]) {
  const program = new Command();
  program.exitOverride();
  program.option("-e, --exchange <exchange>", "", "hyperliquid");
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMarketCommands(program, async () => ({ name: "hyperliquid", ...adapter } as ExchangeAdapter), () => true);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  let error: unknown = null;
  try { await program.parseAsync(["node", "perp", "-e", "hyperliquid", ...argv]); } catch (e) { error = e; }
  return { out: out.join("\n"), error };
}

const code = (e: unknown) => (e as { structured?: { code?: string } }).structured?.code;

describe("S3 --start / --end", () => {
  it("unix ms and ISO dates; anything else is INVALID_PARAMS", () => {
    expect(parseTimeArg("1792368000000", "--start")).toBe(1792368000000);
    expect(parseTimeArg("2026-10-18", "--start")).toBe(Date.parse("2026-10-18T00:00:00Z"));
    expect(parseTimeArg("2026-10-18T12:00:00Z", "--start")).toBe(Date.parse("2026-10-18T12:00:00Z"));
    for (const bad of ["abc", "", "12:00", "1.5", "-5"]) expect(() => parseTimeArg(bad, "--start")).toThrow(/unix milliseconds or an ISO date/);
  });

  it("kline passes parsed times; start after end → INVALID_PARAMS before any request", async () => {
    const getKlines = vi.fn(async () => []);
    await run({ getKlines }, ["market", "kline", "BTC", "1h", "--start", "2026-10-18", "--end", "2026-10-19"]);
    expect(getKlines).toHaveBeenCalledWith("BTC", "1h", Date.parse("2026-10-18T00:00:00Z"), Date.parse("2026-10-19T00:00:00Z"));
    getKlines.mockClear();
    const { error } = await run({ getKlines }, ["market", "kline", "BTC", "1h", "--start", "2026-10-19", "--end", "2026-10-18"]);
    expect(code(error)).toBe("INVALID_PARAMS");
    expect(getKlines).not.toHaveBeenCalled();
  });
});

describe("S6 positive-integer --limit / -l / --depth", () => {
  it.each(["0", "-5", "abc", "1.5", ""])("%s → INVALID_PARAMS", (bad) => {
    expect(() => parsePositiveIntArg(bad, "--limit")).toThrow(/positive integer/);
  });

  it("trades / funding / book refuse a bad value before any request", async () => {
    const getRecentTrades = vi.fn(async () => []);
    const getFundingHistory = vi.fn(async () => []);
    const getOrderbook = vi.fn(async () => ({ bids: [], asks: [] }));
    expect(code((await run({ getRecentTrades }, ["market", "trades", "BTC", "--limit", "-5"])).error)).toBe("INVALID_PARAMS");
    expect(code((await run({ getFundingHistory }, ["market", "funding", "BTC", "-l", "abc"])).error)).toBe("INVALID_PARAMS");
    expect(code((await run({ getOrderbook }, ["market", "book", "BTC", "--depth", "0"])).error)).toBe("INVALID_PARAMS");
    expect(getRecentTrades).not.toHaveBeenCalled();
    expect(getFundingHistory).not.toHaveBeenCalled();
    expect(getOrderbook).not.toHaveBeenCalled();
  });
});

describe("S5 market book --depth", () => {
  it("is passed to the adapter and cuts the JSON book", async () => {
    const lv = (n: number): [string, string][] => Array.from({ length: n }, (_, i) => [String(100 + i), "1"]);
    const getOrderbook = vi.fn(async () => ({ bids: lv(50), asks: lv(50) }));
    const { out } = await run({ getOrderbook }, ["market", "book", "BTC", "--depth", "3"]);
    expect(getOrderbook).toHaveBeenCalledWith("BTC", 3);
    const j = JSON.parse(out);
    expect(j.data.bids).toHaveLength(3);
    expect(j.data.asks).toHaveLength(3);
  });
});

describe("S4 market info symbol forms", () => {
  it.each(["BTC", "btc", "BTC-PERP", "BTC-USD", "BTC-USDC", "BTC-USDT"])("%s finds BTC", async (arg) => {
    const { out, error } = await run({ getMarkets: async () => [BTC] }, ["market", "info", arg]);
    expect(error).toBeNull();
    expect(JSON.parse(out).data.symbol).toBe("BTC");
  });

  it("Extended _24_5 wire names and HIP-3 prefixes", async () => {
    expect(bareSymbolOf("TSLA_24_5-USD")).toBe("TSLA");
    expect(bareSymbolOf("xyz:XYZ100")).toBe("xyz:XYZ100");
    const hip3 = { ...BTC, symbol: "xyz:XYZ100" };
    expect(JSON.parse((await run({ getMarkets: async () => [hip3] }, ["market", "info", "XYZ100"])).out).data.symbol).toBe("xyz:XYZ100");
  });
});

describe("T3 one history order on every venue", () => {
  it("funding history and trades newest first, klines oldest first — whatever the adapter answered", async () => {
    const f = (t: number) => ({ time: t, rate: "0.0001", price: null, intervalHours: 1, rateKind: "lastSettled" as const });
    const fund = await run({ getFundingHistory: async () => [f(1), f(3), f(2)] }, ["market", "funding", "BTC"]);
    expect(JSON.parse(fund.out).data.map((r: { time: number }) => r.time)).toEqual([3, 2, 1]);
    const tr = (t: number) => ({ time: t, symbol: "BTC", side: "buy" as const, price: "1", size: "1", fee: null });
    const trades = await run({ getRecentTrades: async () => [tr(1), tr(2)] }, ["market", "trades", "BTC"]);
    expect(JSON.parse(trades.out).data.map((r: { time: number }) => r.time)).toEqual([2, 1]);
    const k = (t: number) => ({ time: t, open: "1", high: "1", low: "1", close: "1", volume: null, quoteVolume: null, trades: null });
    const kl = await run({ getKlines: async () => [k(3), k(1), k(2)] }, ["market", "kline", "BTC", "1h"]);
    expect(JSON.parse(kl.out).data.map((r: { time: number }) => r.time)).toEqual([1, 2, 3]);
  });
});
