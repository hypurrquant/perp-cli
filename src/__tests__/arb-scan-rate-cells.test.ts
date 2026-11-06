/**
 * Live 2026-11-04, the human `arb scan` tables:
 *  - `--rates` printed each venue's raw rate per its own interval (Aster 8 h / 4 h next to
 *    Hyperliquid 1 h — off by up to 8x; TRUMP looked lowest on Aster at -0.0052 % per 4 h). The
 *    JSON rows were right (hourlyRate); the table now shows that per-hour rate with its unit, to 6
 *    decimals (4 would print 0.0000125 / h as +0.0013 %).
 *  - the default scan's Rates column hid a leg whose rate is exactly 0 (truthiness; Aster equity
 *    perps fund at 0), printed Aster per its interval, and `--live` listed PAC / HL / LT only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import "../exchanges/venues/index.js";
import { listVenuesWithRole, type VenueDefinition } from "../exchanges/venue.js";
import type { VenueFundingRate } from "../exchanges/venue-types.js";
import { handleRates } from "../commands/arb.js";
import { registerArbAutoCommands } from "../commands/arb-auto.js";

const row = (venue: string, rate: string, hours: number): VenueFundingRate => ({
  venue: venue as VenueFundingRate["venue"], venueSymbol: "BTC", symbol: "BTC", canonical: "BTC", rate,
  basis: { kind: "perHours", hours }, markPrice: "100", nextFundingTime: null,
});

function stubVenues(rows: Record<string, VenueFundingRate[]>): void {
  for (const def of listVenuesWithRole("marketData") as VenueDefinition[]) {
    vi.spyOn(def.publicData, "fetchFundingRates").mockResolvedValue(rows[def.id] ?? []);
  }
}

/** Captured stdout lines, ANSI colours stripped. */
function capture(): () => string {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () => out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function scan(...args: string[]): Promise<Command> {
  const program = new Command();
  program.exitOverride();
  program.option("-n, --network <net>", "", "mainnet");
  program.command("arb");
  registerArbAutoCommands(program, async () => { throw new Error("no adapter"); }, () => false);
  return program.parseAsync(["node", "perp", "arb", "scan", ...args]);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("arb scan --rates table", () => {
  it("shows each venue's rate per hour with its unit, 6 decimals (Aster 0.0001 per 8 h → +0.001250%/h)", async () => {
    stubVenues({ hyperliquid: [row("hyperliquid", "0.00002", 1)], aster: [row("aster", "0.0001", 8)] });
    const text = capture();
    await handleRates(() => false, { symbols: "BTC", minSpread: "0" });
    expect(text()).toContain("+0.001250%/h");
  });
});

describe("arb scan Rates column", () => {
  it("shows a leg whose rate is exactly 0", async () => {
    stubVenues({ hyperliquid: [row("hyperliquid", "0.00002", 1)], aster: [row("aster", "0", 8)] });
    const text = capture();
    await scan("--mode", "perp-perp", "--min", "0");
    expect(text()).toContain("AST:0.000000%/h");
  });

  it("shows Aster's rate per hour like the other legs, 6 decimals (0.0001 per 8 h → 0.001250%/h)", async () => {
    stubVenues({ hyperliquid: [row("hyperliquid", "0.00002", 1)], aster: [row("aster", "0.0001", 8)] });
    const text = capture();
    await scan("--mode", "perp-perp", "--min", "0");
    expect(text()).toContain("AST:0.001250%/h");
  });

  it("--live lists the Aster leg too", async () => {
    stubVenues({ hyperliquid: [row("hyperliquid", "0.00002", 1)], aster: [row("aster", "0.0008", 8)] });
    const text = capture();
    // The monitor never returns: its wait between cycles is faked and never elapses.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    void scan("--live", "--interval", "3600", "--min", "0");
    await vi.waitFor(() => expect(text()).toContain("AST:0.010000%/h"));
  });
});
