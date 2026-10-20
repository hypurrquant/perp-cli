/**
 * `perp arb auto` at command level (round-2 review BLOCKER): an aliased pair — Hyperliquid kPEPE ↔
 * Lighter 1000PEPE, canonical 1000PEPE — must OPEN and CLOSE each leg with its venue's own symbol,
 * and an entry whose leg the venue rejects must cool the symbol down (no re-entry next cycle).
 *
 * The real daemon runs (registerArbAutoCommands → cycle loop); only the transport-level seams are
 * stubbed: the funding rows (fetchVenuesRates), the verified leg primitives (bot/perp-order.js —
 * they record the venue + symbol of every order) and the margin read. `--interval 0` runs cycles
 * back to back; the rate stub raises SIGINT on the last cycle, the daemon finishes it and exits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExchangeFundingRate } from "../funding/rates.js";

const h = vi.hoisted(() => ({
  cycle: 0,
  /** Hourly rate of the HL leg per cycle (index = cycle - 1); Lighter stays at 0.00001. */
  hlRates: [] as number[],
  stopAt: 3,
  orders: [] as Array<{ kind: "place" | "close"; exch: string; sym: string; side: string }>,
  rejectShort: false,
}));

const row = (exchange: ExchangeFundingRate["exchange"], symbol: string, hourlyRate: number): ExchangeFundingRate => ({
  exchange, symbol, canonical: "1000PEPE", fundingRate: hourlyRate, basis: { kind: "perHours", hours: 1 }, hourlyRate,
  annualizedPct: hourlyRate * 876_000, markPrice: 0.01, nextFundingTime: null, historicalAvg: null,
  fundingVerified: true, apiStatus: "official", rateKind: "lastSettled",
} as ExchangeFundingRate);

vi.mock("../funding/rates.js", async (orig) => ({
  ...(await orig<typeof import("../funding/rates.js")>()),
  fetchVenuesRates: vi.fn(async () => {
    h.cycle++;
    if (h.cycle >= h.stopAt) process.emit("SIGINT");
    const hl = h.hlRates[Math.min(h.cycle, h.hlRates.length) - 1] ?? 0.00001;
    return {
      rates: [row("lighter", "1000PEPE", 0.00001), row("hyperliquid", "kPEPE", hl)],
      exchangeStatus: { lighter: "ok", hyperliquid: "ok" }, exchangeErrors: {},
    };
  }),
}));
vi.mock("../bot/perp-order.js", async (orig) => ({
  ...(await orig<typeof import("../bot/perp-order.js")>()),
  placePerpVerified: vi.fn(async (_a: unknown, exch: string, sym: string, side: string, size: string) => {
    h.orders.push({ kind: "place", exch, sym, side });
    if (h.rejectShort && side === "sell") throw Object.assign(new Error("venue rejected: unknown symbol"), {});
    return { filledSize: Number(size), avgPrice: 0.01 };
  }),
  closePerpVerified: vi.fn(async (_a: unknown, exch: string, sym: string, side: string, size: string) => {
    h.orders.push({ kind: "close", exch, sym, side });
    return { closed: Number(size), residual: 0, note: null };
  }),
  trimFirstLegToHedge: vi.fn(async () => "0"),
}));
vi.mock("../cross-chain-margin.js", async (orig) => ({
  ...(await orig<typeof import("../cross-chain-margin.js")>()),
  checkChainMargins: vi.fn(async () => ({ statuses: [], unknown: [] })),
}));

import { Command } from "commander";
import "../exchanges/venues/index.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { registerArbAutoCommands } from "../commands/arb-auto.js";

function adapter(name: string): ExchangeAdapter {
  return { name, isReadOnly: false, getPositions: async () => [], getMarkets: async () => [] } as unknown as ExchangeAdapter;
}

async function runDaemon(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw Object.assign(new Error("__exit__"), { code }); }) as never);
  const program = new Command();
  program.exitOverride();
  program.option("-n, --network <net>", "", "mainnet");
  program.option("--dry-run");
  program.command("arb");
  const adapters = new Map(["hyperliquid", "lighter", "pacifica", "aster"].map(n => [n, adapter(n)]));
  registerArbAutoCommands(program, async (ex: string) => adapters.get(ex)!, () => false);
  await program.parseAsync(["node", "perp", "arb", "auto", "--interval", "0", "--settle-strategy", "off", "--min-spread", "1", "--close-spread", "5", "--size", "100", ...args])
    .catch((e: Error) => { if (e.message !== "__exit__") throw e; });
  return logs;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.removeAllListeners("SIGINT");
  Object.assign(h, { cycle: 0, hlRates: [], stopAt: 3, orders: [], rejectShort: false });
});

describe("arb auto daemon: aliased pair HL kPEPE ↔ Lighter 1000PEPE", () => {
  it("opens and closes each leg with its venue's own symbol", async () => {
    // cycle 1: wide spread (short HL, long Lighter) → entry; cycle 2: no spread → close; cycle 3: stop.
    h.hlRates = [0.0005, 0.00001, 0.00001];
    await runDaemon(["--symbols", "kPEPE"]);
    const placed = h.orders.filter(o => o.kind === "place").map(o => `${o.exch}:${o.sym}:${o.side}`);
    const closed = h.orders.filter(o => o.kind === "close").map(o => `${o.exch}:${o.sym}:${o.side}`);
    expect(placed).toEqual(["lighter:1000PEPE:buy", "hyperliquid:kPEPE:sell"]);
    expect(closed).toEqual(["lighter:1000PEPE:sell", "hyperliquid:kPEPE:buy"]);
  }, 30_000);

  it("a rejected leg cools the symbol down: no re-entry on the next cycle", async () => {
    h.hlRates = [0.0005, 0.0005, 0.0005];
    h.rejectShort = true;
    const logs = await runDaemon(["--symbols", "1000PEPE", "--cooldown", "30"]);
    // cycle 1: long placed, short rejected, long rolled back. Cycles 2-3: cooldown, nothing sent.
    expect(h.orders.map(o => `${o.kind}:${o.exch}:${o.sym}`)).toEqual(["place:lighter:1000PEPE", "place:hyperliquid:kPEPE", "close:lighter:1000PEPE"]);
    expect(logs.some(l => /SKIP 1000PEPE: cooldown/.test(l))).toBe(true);
  }, 30_000);
});
