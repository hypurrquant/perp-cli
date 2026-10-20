/**
 * `perp arb scan` (QA 0.15.0):
 *  5. A pair with an unverified-funding leg (QFEX) showed executable: true, readOnlyLegs: [] under
 *     --rates --include-unverified, although such a venue is display only. Now executable: false
 *     with `unverifiedLegs`.
 *  6. --gaps matched SAMSUNG / SKHYNIX across venues whose listings are different instruments
 *     (Pacifica 165.8 USD vs Lighter 220,597, KRW-quoted) → a 199.7 % "gap". The funding scan's
 *     price-outlier guard now applies to gaps.
 * 10. spot-perp rows named the spreads grossSpreadPct / netSpreadPct while perp-perp / all rows
 *     used grossSpread / netSpread; every row now carries both names (additive).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../exchanges/venues/index.js";
import { pairExecutability } from "../funding/rates.js";
import { buildGapSnapshots } from "../commands/arb.js";

afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("../funding/rates.js"); });

describe("5. unverified-funding legs are never executable", () => {
  it("qfex leg → executable false, unverifiedLegs [qfex]; verified trading pair stays executable", () => {
    expect(pairExecutability("qfex", "hyperliquid")).toEqual({ executable: false, readOnlyLegs: [], unverifiedLegs: ["qfex"] });
    expect(pairExecutability("hyperliquid", "pacifica")).toEqual({ executable: true, readOnlyLegs: [], unverifiedLegs: [] });
    // Read-only and unverified at once (GRVT: market data only, funding unverified).
    expect(pairExecutability("grvt", "lighter")).toMatchObject({ executable: false, readOnlyLegs: ["grvt"], unverifiedLegs: ["grvt"] });
  });
});

describe("6. --gaps drops prices that disagree beyond the outlier guard", () => {
  it("SAMSUNG Pacifica 165.8 vs Lighter 220,597 (QA x_gaps) is not a gap; BTC still is", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pac = new Map([["SAMSUNG", 165.8], ["BTC", 82761]]);
    const hl = new Map([["BTC", 82750]]);
    const lt = new Map([["SAMSUNG", 220597], ["BTC", 82700]]);
    const snaps = buildGapSnapshots(pac, hl, lt);
    expect(snaps.map(s => s.symbol)).toEqual(["BTC"]);
    expect(snaps[0].maxGapPct).toBeLessThan(0.1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SAMSUNG"));
  });

  it("an outlier among three venues is dropped and the gap is computed from the agreeing two", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const [s] = buildGapSnapshots(new Map([["XYZ", 10]]), new Map([["XYZ", 10.1]]), new Map([["XYZ", 1000]]));
    expect(s).toMatchObject({ symbol: "XYZ", pacPrice: 10, hlPrice: 10.1, ltPrice: null });
  });
});

describe("10. arb scan spread field names", () => {
  it("spot-perp rows carry grossSpread / netSpread next to grossSpreadPct / netSpreadPct", async () => {
    vi.doMock("../funding/rates.js", async (orig) => ({
      ...(await orig<typeof import("../funding/rates.js")>()),
      fetchSpotPerpSpreads: async () => ({ spreads: [{ symbol: "ETH", perpExchange: "hyperliquid", spotExchanges: ["hyperliquid"], annualSpreadPct: 20, perpFundingRate: 0.0001, direction: "long-spot-short-perp", bestMarkPrice: 2400, estHourlyIncomeUsd: 0.02 }] }),
    }));
    const { Command } = await import("commander");
    const { registerArbAutoCommands } = await import("../commands/arb-auto.js");
    const program = new Command();
    program.exitOverride();
    program.option("-n, --network <net>", "", "mainnet");
    program.command("arb");
    registerArbAutoCommands(program, async () => { throw new Error("no adapter"); }, () => true);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", "arb", "scan", "--mode", "spot-perp", "--top", "5"]);
    const row = JSON.parse(out.join("\n")).data[0];
    expect(row).toMatchObject({ grossSpreadPct: 20, grossSpread: 20 });
    expect(row.netSpread).toBe(row.netSpreadPct);
  });
});
