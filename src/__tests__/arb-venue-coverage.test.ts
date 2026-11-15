/**
 * `arb status` / `arb close` cover every configured trading venue (live 2026-10-05: a filled
 * aster long + arcus short was invisible because the venue list was hard-coded to
 * hyperliquid / lighter / pacifica), a failed positions read is an error, and the state file
 * never makes a position "live" by itself.
 *
 * Parsed through the real root program. Venue adapters are stubs; fetch throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Command } from "commander";
import { PerpError } from "../errors.js";

type Pos = { symbol: string; side: "long" | "short"; size: string; entryPrice: string; markPrice: string; liquidationPrice: null; unrealizedPnl: string; leverage: number };
const pos = (side: "long" | "short", size: string): Pos => ({ symbol: "SOL", side, size, entryPrice: "120.7", markPrice: "121", liquidationPrice: null, unrealizedPnl: "0.01", leverage: 5 });
const positions: Record<string, () => Promise<Pos[]>> = {};
const marketOrder = vi.fn();
const limitOrder = vi.fn();

function stub(name: string) {
  return {
    name, address: "0x1111111111111111111111111111111111111111", marketOrder, limitOrder,
    getPositions: vi.fn(() => (positions[name] ?? (async () => []))()),
    getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
    getOpenOrders: vi.fn(async () => []),
    getMarkets: vi.fn(async () => []),
    getFundingPayments: vi.fn(async () => []),
  };
}

vi.mock("../exchanges/venue.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../exchanges/venue.js")>();
  return {
    ...orig,
    getVenue: (input: string) => {
      const def = orig.getVenue(input);
      return def.create === null ? def : { ...def, create: async () => stub(def.id) };
    },
  };
});
let configured: string[] = [];
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  listConfiguredAccountVenues: vi.fn(async () => configured),
}));
// The stale March entry of the real state file: PURR spot-perp, both legs "hyperliquid".
const STALE = {
  id: "PURR-spot-1773707905440", symbol: "PURR", longExchange: "hyperliquid", shortExchange: "hyperliquid", longSize: 100, shortSize: 100,
  entryTime: "2026-03-17T00:38:25.440Z", entrySpread: 0, entryLongPrice: 0.10573, entryShortPrice: 0.10727, accumulatedFunding: 0,
  lastCheckTime: "2026-03-17T00:38:25.440Z", mode: "spot-perp" as const, spotExchange: "hyperliquid", spotSymbol: "PURR/USDC",
};
vi.mock("../arb/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../arb/state.js")>()),
  getPositions: vi.fn(() => [STALE]),
  loadArbState: vi.fn(() => ({ version: 1, positions: [STALE] })),
  removePosition: vi.fn(),
}));
vi.mock("../bot/quarantine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bot/quarantine.js")>()),
  quarantineEntryFor: vi.fn(() => null),
}));
// The SOL aster/arcus pair was opened by arb: its entry record (arbPairProvenance "executionLog").
const SOL_ENTRY = { id: "e1", timestamp: "2026-10-05T10:00:00.000Z", type: "arb_entry", exchange: "aster+arcus", symbol: "SOL", side: "entry", size: "0.09", status: "success", dryRun: false, meta: { longExchange: "aster", shortExchange: "arcus" } };
let logRecords: Array<Record<string, unknown>> = [];
vi.mock("../execution-log.js", () => ({
  logExecution: vi.fn(),
  readExecutionLog: vi.fn((o?: { type?: string; symbol?: string }) => logRecords.filter(r => (o?.type === undefined || r.type === o.type) && (o?.symbol === undefined || r.symbol === o.symbol))),
}));

const { buildProgram } = await import("../cli-program.js");
const { allCommands } = await import("../cli-flags.js");
const { listArbVenues, readArbVenuePositions, staleArbStateEntries, arbPairProvenance } = await import("../commands/arb/index.js");

function program(): Command {
  const { program: p } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
  for (const c of [p, ...allCommands(p)]) {
    c.exitOverride();
    c.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  }
  return p;
}
const run = (...argv: string[]) => program().parseAsync(["node", "perp", "--json", ...argv]);

let out: string[];
beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  for (const k of Object.keys(positions)) delete positions[k];
  configured = ["hyperliquid", "aster", "arcus"];
  logRecords = [SOL_ENTRY];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubGlobal("fetch", vi.fn(async (u: unknown) => { throw new Error(`unexpected network call: ${String(u)}`); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});
const lastJson = () => JSON.parse(out.filter(l => l.trim().startsWith("{")).at(-1)!);
const liveSolPair = () => {
  positions.aster = async () => [pos("long", "0.09")];
  positions.arcus = async () => [pos("short", "0.09")];
};

describe("arb venue list", () => {
  it("is every configured venue with a trading role — never a fixed list", async () => {
    configured = ["pacifica", "hyperliquid", "lighter", "aster", "ondo", "arcus", "qfex"];
    expect(await listArbVenues()).toEqual(configured);
    configured = ["aster", "arcus"];
    expect(await listArbVenues()).toEqual(["aster", "arcus"]);
  });

  it("a failed positions read on any venue is an error naming the venue, not an empty list", async () => {
    const getAdapter = async (name: string) => ({
      getPositions: async () => { if (name === "arcus") throw new PerpError("EXCHANGE_UNREACHABLE", "arcus gateway timeout"); return [pos("long", "1")]; },
    }) as never;
    const e = await readArbVenuePositions(["aster", "arcus"], getAdapter).catch(x => x) as PerpError;
    expect(e).toBeInstanceOf(PerpError);
    expect(e.structured.code).toBe("EXCHANGE_UNREACHABLE");
    expect(e.message).toBe("Cannot read positions on arcus: arcus gateway timeout");
    expect(e.structured.details).toMatchObject({ exchange: "arcus", venuesChecked: ["aster", "arcus"] });
    // An adapter that cannot be built (no credentials, bad key) is the same error.
    await expect(readArbVenuePositions(["aster"], async () => { throw new Error("no key"); })).rejects.toThrow(/Cannot read positions on aster: no key/);
  });
});

describe("arb status", () => {
  it("reports the aster long + arcus short pair; the stale PURR state entry is listed apart, not as a position", async () => {
    liveSolPair();
    await run("arb", "status");
    const d = lastJson().data;
    expect(d.venuesChecked).toEqual(["hyperliquid", "aster", "arcus"]);
    expect(d.perpPerpPairs).toHaveLength(1);
    expect(d.perpPerpPairs[0]).toMatchObject({ symbol: "SOL", longExchange: "aster", shortExchange: "arcus", longPosition: { size: 0.09 }, shortPosition: { size: 0.09 } });
    expect(d.spotPerpPairs).toEqual([]);
    expect(d.aggregate.totalPositions).toBe(1);
    expect(d.staleStateEntries).toEqual([expect.objectContaining({ id: STALE.id, symbol: "PURR", mode: "spot-perp", reason: "no PURR perp short on hyperliquid" })]);
  });

  it("a venue whose positions cannot be read fails the command instead of showing 0 pairs", async () => {
    liveSolPair();
    positions.arcus = async () => { throw new Error("HTTP 503"); };
    await expect(run("arb", "status")).rejects.toThrow(/Cannot read positions on arcus: HTTP 503/);
  });
});

describe("inferred pairs (live 2026-10-12: a bot's own SOL long on aster was paired with an arb short)", () => {
  it("status lists a long/short with no arb state / entry record under unconfirmedPairs, not as a position", async () => {
    logRecords = [];
    liveSolPair();
    await run("arb", "status");
    const d = lastJson().data;
    expect(d.perpPerpPairs).toEqual([]);
    expect(d.unconfirmedPairs).toEqual([expect.objectContaining({ symbol: "SOL", longExchange: "aster", shortExchange: "arcus", provenance: "inferred" })]);
    expect(d.aggregate.totalPositions).toBe(0);
  });

  it("close refuses an inferred pair without --pair (INVALID_PARAMS naming it), closes it with --pair", async () => {
    logRecords = [];
    liveSolPair();
    await expect(run("--dry-run", "arb", "close", "SOL")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS", remediation: expect.stringContaining("--pair aster:arcus") } });
    await run("--dry-run", "arb", "close", "SOL", "--pair", "aster:arcus");
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, longExchange: "aster", shortExchange: "arcus" } });
  });

  it("an entry record closed since then no longer confirms the pair", async () => {
    logRecords = [SOL_ENTRY, { ...SOL_ENTRY, id: "c1", type: "arb_close", timestamp: "2026-10-06T10:00:00.000Z" }];
    liveSolPair();
    await run("arb", "status");
    expect(lastJson().data.perpPerpPairs).toEqual([]);
  });
});

describe("arbPairProvenance", () => {
  const rec = (o: Record<string, unknown>) => ({ id: "x", side: "x", size: "1", status: "success", dryRun: false, symbol: "SOL", ...o }) as never;
  it("state entry for exactly these legs → state; symbol-only matches never confirm", () => {
    expect(arbPairProvenance("SOL", "aster", "arcus", [{ symbol: "SOL", longExchange: "aster", shortExchange: "arcus" }], [])).toBe("state");
    expect(arbPairProvenance("SOL", "aster", "hyperliquid", [{ symbol: "SOL", longExchange: "aster", shortExchange: "arcus" }], [rec({ type: "arb_entry", timestamp: "2026-10-01T00:00:00Z", exchange: "pacifica+hyperliquid", meta: { longExchange: "pacifica", shortExchange: "hyperliquid" } })])).toBe("inferred");
  });
  it("engine per-leg entries (leg long + leg short within 10 min) confirm; a later per-leg close un-confirms", () => {
    const legs = [
      rec({ type: "arb_entry", timestamp: "2026-10-01T00:00:00Z", exchange: "pacifica", meta: { leg: "long" } }),
      rec({ type: "arb_entry", timestamp: "2026-10-01T00:01:00Z", exchange: "hyperliquid", meta: { leg: "short" } }),
    ];
    expect(arbPairProvenance("SOL", "pacifica", "hyperliquid", [], legs)).toBe("executionLog");
    expect(arbPairProvenance("SOL", "pacifica", "hyperliquid", [], [...legs, rec({ type: "arb_close", timestamp: "2026-10-02T00:00:00Z", exchange: "pacifica", meta: { leg: "long" } })])).toBe("inferred");
  });
});

describe("arb close --state-only", () => {
  it("shows the stale entry without --yes, deletes it with --yes; no order either way", async () => {
    const st = await import("../arb/state.js");
    await run("arb", "close", "PURR", "--state-only");
    expect(lastJson()).toMatchObject({ ok: true, data: { deleted: false, staleStateEntries: [expect.objectContaining({ symbol: "PURR" })] } });
    expect(st.removePosition).not.toHaveBeenCalled();
    await run("arb", "close", "PURR", "--state-only", "--yes");
    expect(lastJson()).toMatchObject({ ok: true, data: { deleted: true } });
    expect(st.removePosition).toHaveBeenCalledWith("mainnet", "PURR");
    expect(marketOrder).not.toHaveBeenCalled();
  });

  it("refuses while the venues still show the position", async () => {
    positions.hyperliquid = async () => [{ ...pos("short", "100"), symbol: "PURR" }];
    await expect(run("arb", "close", "PURR", "--state-only", "--yes")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });
});

describe("staleArbStateEntries", () => {
  it("a state entry is live only when the venues show its legs", () => {
    const pp = { id: "SOL-1", symbol: "sol", longExchange: "aster", shortExchange: "arcus", entryTime: "t" };
    expect(staleArbStateEntries([pp], [{ symbol: "SOL", longExchange: "aster", shortExchange: "arcus" }], [])).toEqual([]);
    expect(staleArbStateEntries([pp], [{ symbol: "SOL", longExchange: "arcus", shortExchange: "aster" }], [])).toMatchObject([{ id: "SOL-1", mode: "perp-perp" }]);
    expect(staleArbStateEntries([STALE], [], [{ symbol: "PURR", spotExchange: "hyperliquid", perpExchange: "hyperliquid" }])).toEqual([]);
    expect(staleArbStateEntries([STALE], [], [])).toHaveLength(1);
  });
});

describe("arb close", () => {
  it("finds the pair on aster + arcus (dry-run plan, nothing sent), with or without --pair", async () => {
    liveSolPair();
    for (const extra of [[], ["--pair", "aster:arcus"]]) {
      await run("--dry-run", "arb", "close", "SOL", ...extra);
      expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, symbol: "SOL", longExchange: "aster", shortExchange: "arcus", longSize: 0.09, shortSize: 0.09 } });
    }
    expect(marketOrder).not.toHaveBeenCalled();
    expect(limitOrder).not.toHaveBeenCalled();
  });

  it("no pair → POSITION_NOT_FOUND error (code + remediation + what was checked), never a bare { error } under ok:true", async () => {
    positions.aster = async () => [pos("long", "0.09")];
    const e = await run("--dry-run", "arb", "close", "SOL").catch(x => x) as PerpError;
    expect(e).toBeInstanceOf(PerpError);
    expect(e.structured.code).toBe("POSITION_NOT_FOUND");
    expect(e.structured.details).toMatchObject({ symbol: "SOL", venuesChecked: ["hyperliquid", "aster", "arcus"], positions: [{ exchange: "aster", side: "long", size: "0.09" }] });
    expect(e.structured.remediation).toMatch(/long 0\.09 on aster/);
    expect(out.filter(l => l.includes('"ok":true') || l.includes('"ok": true'))).toEqual([]);
  });

  it("a wrong --pair, an unknown venue in --pair and an unreadable venue are errors too", async () => {
    liveSolPair();
    await expect(run("--dry-run", "arb", "close", "SOL", "--pair", "arcus:aster")).rejects.toMatchObject({ structured: { code: "POSITION_NOT_FOUND" } });
    await expect(run("--dry-run", "arb", "close", "SOL", "--pair", "aster:nowhere")).rejects.toMatchObject({ structured: { code: "UNKNOWN_VENUE" } });
    await expect(run("--dry-run", "arb", "close", "SOL", "--pair", "aster")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    positions.hyperliquid = async () => { throw new Error("HTTP 500"); };
    await expect(run("--dry-run", "arb", "close", "SOL")).rejects.toThrow(/Cannot read positions on hyperliquid/);
  });
});

describe("arb status funding estimates (a pair whose spread flipped was shown as income)", () => {
  /** Current funding of the venues arb status reads: venue → symbol → hourly rate. */
  async function stubRates(rates: Record<string, Record<string, string>>): Promise<void> {
    const { getVenue } = await import("../exchanges/venue.js");
    for (const v of ["pacifica", "hyperliquid", "lighter", "aster"]) {
      vi.spyOn(getVenue(v).publicData, "fetchFundingRates").mockResolvedValue(Object.entries(rates[v] ?? {}).map(([symbol, rate]) => ({
        venue: v as "hyperliquid", venueSymbol: symbol, symbol, canonical: symbol, rate,
        basis: { kind: "perHours", hours: 1 }, markPrice: "121", nextFundingTime: null,
      })));
    }
  }

  it("perp-perp: long leg funding above the short leg's → negative spread and daily funding (a cost)", async () => {
    // Long SOL on hyperliquid pays 0.00003 / h, short SOL on lighter receives 0.00001 / h: net -0.00002 / h.
    await stubRates({ hyperliquid: { SOL: "0.00003" }, lighter: { SOL: "0.00001" } });
    configured = ["hyperliquid", "lighter"];
    logRecords = [{ ...SOL_ENTRY, exchange: "hyperliquid+lighter", meta: { longExchange: "hyperliquid", shortExchange: "lighter" } }];
    positions.hyperliquid = async () => [pos("long", "1")];
    positions.lighter = async () => [pos("short", "1")];
    await run("arb", "status");
    const [p] = lastJson().data.perpPerpPairs;
    expect(p.currentSpread).toBeCloseTo(-0.00002 * 8760 * 100, 6);
    expect(p.dailyFundingEstimate).toBeLessThan(0);
  });

  it("spot-perp: a negative rate on the short perp leg is a cost (negative currentSpread and daily funding)", async () => {
    // The persisted PURR spot-perp entry (STALE) with its perp short still open on hyperliquid.
    await stubRates({ hyperliquid: { PURR: "-0.0001" } });
    configured = ["hyperliquid"];
    positions.hyperliquid = async () => [{ ...pos("short", "100"), symbol: "PURR" }];
    await run("arb", "status");
    const [sp] = lastJson().data.spotPerpPairs;
    expect(sp.currentSpread).toBeCloseTo(-0.0001 * 8760 * 100, 6);
    expect(sp.dailyFundingEstimate).toBeLessThan(0);
  });

  it("a pair without a current funding rate: dailyFundingEstimate null (never 0), listed in fundingUnknown", async () => {
    liveSolPair(); // aster / arcus: fetch throws, so neither leg has a rate
    await run("arb", "status");
    const d = lastJson().data;
    expect(d.perpPerpPairs[0].dailyFundingEstimate).toBeNull();
    expect(d.aggregate.fundingUnknown).toContain("aster/arcus:SOL");
  });
});
