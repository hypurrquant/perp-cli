/**
 * `backtest funding-arb` (live check 2026-11-04): every holding time was "NaNh" (the hour keys
 * "2026-11-04T03" are not parseable by Date), income was summed with Math.abs (an hour whose spread
 * flipped counted as income) over N + 1 samples for an N-hour hold, and a position still open at
 * the end of the data was dropped. The history is the real local snapshot store
 * (saveFundingSnapshot) in the isolated HOME.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { saveFundingSnapshot } from "../../funding-history.js";
import type { ExchangeFundingRate } from "../../funding/rates.js";
import { registerBacktestCommands } from "../../commands/backtest.js";

const T0 = Date.parse("2026-10-10T00:00:00Z");
const HOUR = 3_600_000;

const rate = (exchange: "hyperliquid" | "lighter", symbol: string, hourlyRate: number): ExchangeFundingRate => ({
  exchange, symbol, canonical: symbol, fundingRate: hourlyRate, basis: { kind: "perHours", hours: 1 }, hourlyRate,
  annualizedPct: hourlyRate * 8760 * 100, markPrice: 100, nextFundingTime: null, historicalAvg: null,
  fundingVerified: true, apiStatus: "official", rateKind: "lastSettled",
});

/** One snapshot per hour from T0: [hyperliquid, lighter] hourly rates. */
function record(symbol: string, hours: Array<[number, number]>): void {
  hours.forEach(([a, b], h) => {
    vi.setSystemTime(T0 + h * HOUR);
    saveFundingSnapshot([rate("hyperliquid", symbol, a), rate("lighter", symbol, b)]);
  });
}

type Trade = { entryTime: string; exitTime: string; holdingHours: number | null; fundingCollected: number; openAtEnd?: boolean };

async function backtest(symbol: string, hours: number, ...flags: string[]): Promise<{ trades: Trade[]; avgHoldingPeriod: string; netPnl: string }> {
  vi.setSystemTime(T0 + hours * HOUR);
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { printed.push(a.map(String).join(" ")); });
  const program = new Command();
  program.exitOverride();
  registerBacktestCommands(program, () => true);
  await program.parseAsync(["node", "perp", "backtest", "funding-arb", "--symbol", symbol, "--days", "1", "--exchanges", "hyperliquid,lighter", ...flags]);
  return JSON.parse(printed.join("\n")).data;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("backtest funding-arb", () => {
  it("holding time is the hours between entry and exit (was NaNh)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 87.6 %/yr for three hours (enter ≥ 10 %), then 0 (close < 5 %).
    record("BTC", [[0.0001, 0], [0.0001, 0], [0.0001, 0], [0, 0]]);
    const r = await backtest("BTC", 4);
    expect(r.trades[0].holdingHours).toBe(3);
  });

  it("a flipped spread closes the position at the flip: a 1 h hold earns its one hour (0.10), never the flipped one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Entered short hyperliquid / long lighter (+0.0001 / h); next hour lighter funds above (-0.00002 / h).
    record("ETH", [[0.0001, 0], [0, 0.00002], [0, 0]]);
    const r = await backtest("ETH", 3);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ exitTime: "2026-10-10T01" });
    expect(r.trades[0].fundingCollected).toBeCloseTo(0.0001 * 1000, 10);
  });

  it("with a negative --spread-close, a flipped hour the position holds through is a cost", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // +0.0001 / h, then -0.00002 / h (-17.5 %/yr, above -50 %: held), then -87.6 %/yr (closed).
    record("AVAX", [[0.0001, 0], [0, 0.00002], [0, 0.0001]]);
    const r = await backtest("AVAX", 3, "--spread-close=-50");
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].fundingCollected).toBeCloseTo((0.0001 - 0.00002) * 1000, 10);
  });

  it("a position still open at the end of the data is reported, closed at the last data point", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    record("SOL", [[0.0001, 0], [0.0001, 0]]);
    const r = await backtest("SOL", 2);
    expect(r.trades).toEqual([expect.objectContaining({ entryTime: "2026-10-10T00", exitTime: "2026-10-10T01", holdingHours: 1, openAtEnd: true })]);
  });

  it("a negative amount reads -$3.70, not $-3.70", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Three hours at 0.0001 / h on $1000 = $0.30 of funding against $4.00 of trading costs.
    record("DOGE", [[0.0001, 0], [0.0001, 0], [0.0001, 0], [0, 0]]);
    const r = await backtest("DOGE", 4);
    expect(r.netPnl).toBe("-$3.70");
  });
});
