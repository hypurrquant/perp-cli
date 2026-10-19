/**
 * Cross-venue conformance suite — every registered venue × every read command (docs/TESTING.md §3).
 *
 * Data-driven over the venue registry: a new venue is included automatically, and the suite fails
 * when it has no capability-table entry (capabilities.ts) or no recorded fixture
 * (src/__tests__/fixtures/conformance/<venue>.json), unless OPT_OUT documents why.
 *
 * Each cell runs the REAL `perp --json …` command tree in-process (src/cli-program.ts → venue
 * definition → adapter → cache / limiter → fetch); only the transport is replayed from the fixture
 * (harness.ts). The output is validated against the one shared contract (contracts.ts) and the
 * per-cell invariants (checks.ts); current failures are asserted through KNOWN_FAILURES.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ws", async (importOriginal) => {
  const real = await importOriginal<typeof import("ws")>();
  const { activeSession } = await import("./harness.js");
  const Real = real.default as unknown as new (...a: unknown[]) => never;
  const Wrapped = new Proxy(Real, {
    construct: (_t, args: unknown[]) => new (activeSession().wrapWs(Real as never) as unknown as new (...a: unknown[]) => object)(...args),
  });
  return { ...real, default: Wrapped, WebSocket: Wrapped };
});

import "../../exchanges/venues/index.js";
import { listVenues, type VenueDefinition } from "../../exchanges/venue.js";
import type { VenueId } from "../../exchanges/venue-types.js";
import {
  argvOf, expectOf, OPT_OUT, READ_COMMANDS, SYMBOL_COMMANDS, UNKNOWN_SYMBOL, VENUE_CONFORMANCE, type ReadCommand,
} from "./capabilities.js";
import { baseOf, cellChecks, unknownSymbolCheck } from "./checks.js";
import { hasFixture, IS_LIVE, MODE, runCli, Session, VENUE_FILTER, type CliRun } from "./harness.js";
import { expectCheck, staleKnownFailures } from "./known-failures.js";

const ALL = listVenues();
const VENUES = ALL.filter(v => VENUE_FILTER === null || VENUE_FILTER.has(v.id));
const CELL_TIMEOUT = IS_LIVE ? 600_000 : 120_000;

const runnable = (def: VenueDefinition): boolean =>
  VENUE_CONFORMANCE[def.id] !== undefined && OPT_OUT[def.id] === undefined && (IS_LIVE || hasFixture(def.id));

/** Every run of every venue, for the cross-venue checks at the end. */
const RESULTS = new Map<VenueId, { runs: Map<string, CliRun>; now: number }>();

describe("registry coverage (a new venue is included automatically)", () => {
  for (const def of ALL) {
    it(`${def.id}: has a capability-table entry`, () => {
      expect(VENUE_CONFORMANCE[def.id], `add ${def.id} to VENUE_CONFORMANCE in src/__tests__/conformance/capabilities.ts`).toBeDefined();
    });
    it(`${def.id}: has a recorded fixture or a documented opt-out`, () => {
      const reason = OPT_OUT[def.id];
      if (reason !== undefined) {
        expect(reason.trim().length, `OPT_OUT.${def.id} needs a documented reason`).toBeGreaterThan(10);
        return;
      }
      expect(hasFixture(def.id), `record fixtures: pnpm conformance:record --venue ${def.id}`).toBe(true);
    });
  }
  it("OPT_OUT and the capability table name only registered venues", () => {
    const ids = new Set(ALL.map(v => v.id as string));
    expect(Object.keys(OPT_OUT).filter(id => !ids.has(id))).toEqual([]);
    expect(Object.keys(VENUE_CONFORMANCE).filter(id => !ids.has(id))).toEqual([]);
  });
  it("every venue serves market data (the read commands' role)", () => {
    expect(ALL.filter(v => !v.roles.includes("marketData")).map(v => v.id)).toEqual([]);
  });
});

function checkNames(cmd: ReadCommand, venue: VenueId): string[] {
  const dummy: CliRun = { argv: [], envelope: { ok: false }, docs: 1, stderr: "" };
  return cellChecks(cmd, expectOf(venue, cmd), dummy, { symbol: "", now: 0 }).map(c => c.name);
}

for (const def of VENUES.filter(runnable)) {
  const conf = VENUE_CONFORMANCE[def.id];
  describe(`venue ${def.id} (${MODE})`, () => {
    const runs = new Map<string, CliRun>();
    let now = 0;

    beforeAll(async () => {
      const session = new Session(def.id, conf.keep);
      session.start();
      try {
        for (const cmd of READ_COMMANDS) {
          session.begin(cmd);
          runs.set(cmd, await runCli(argvOf(def.id, cmd, conf.symbol)));
        }
        for (const cmd of SYMBOL_COMMANDS) {
          if (["unsupported", "credentials"].includes(expectOf(def.id, cmd).kind)) continue;
          session.begin(`unknown:${cmd}`);
          runs.set(`unknown:${cmd}`, await runCli(argvOf(def.id, cmd, UNKNOWN_SYMBOL)));
        }
        now = Date.now();
        session.finalize();
        if (session.misses.length > 0) console.warn(`[conformance] ${def.id}: requests missing from the fixture:\n  ${session.misses.join("\n  ")}`);
      } finally {
        session.stop();
      }
      RESULTS.set(def.id, { runs, now });
    }, CELL_TIMEOUT);

    for (const cmd of READ_COMMANDS) {
      const exp = expectOf(def.id, cmd);
      describe(`${cmd}${exp.kind === "ok" ? "" : ` [${exp.kind}${exp.kind === "alt" ? `: ${exp.contract}` : ""}]`}`, () => {
        for (const name of checkNames(cmd, def.id)) {
          it(name, () => {
            const r = runs.get(cmd)!;
            const check = cellChecks(cmd, exp, r, { symbol: conf.symbol, now }).find(c => c.name === name)!;
            expectCheck(`${def.id}:${cmd}:${name}`, check.run());
          });
        }
      });
    }

    describe(`unknown symbol ${UNKNOWN_SYMBOL} → SYMBOL_NOT_FOUND`, () => {
      for (const cmd of SYMBOL_COMMANDS.filter(c => !["unsupported", "credentials"].includes(expectOf(def.id, c).kind))) {
        it(cmd, () => {
          expectCheck(`${def.id}:unknown-${cmd}:unknown-symbol`, unknownSymbolCheck(runs.get(`unknown:${cmd}`)!).run());
        });
      }
    });
  });
}

describe("cross-venue price agreement (same canonical symbol ⇒ same meaning)", () => {
  /** Max relative deviation of a venue's mark from the cross-venue median. Snapshots are minutes apart. */
  const TOLERANCE = 0.02;
  for (const base of ["BTC", "ETH"]) {
    it(`${base}: every venue's market-list mark is within ${TOLERANCE * 100}% of the median`, () => {
      const marks: Array<[string, number]> = [];
      for (const [venue, { runs }] of RESULTS) {
        const list = runs.get("list")?.envelope;
        if (!list?.ok || !Array.isArray(list.data)) continue;
        const row = (list.data as Array<{ symbol: string; markPrice: string }>).find(m => baseOf(m.symbol) === base);
        if (row) marks.push([venue, Number(row.markPrice)]);
      }
      if (VENUE_FILTER === null) expect(marks.length, `${base} listed by too few venues`).toBeGreaterThanOrEqual(5);
      const sorted = marks.map(m => m[1]).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const off = marks.filter(([, p]) => Math.abs(p / median - 1) > TOLERANCE).map(([v, p]) => `${v} ${p} vs median ${median}`);
      expectCheck(`agreement:${base}:mark`, off.length === 0 ? null : off.join("; "));
    });
  }
});

afterAll(() => {
  if (VENUE_FILTER !== null) return;
  const stale = staleKnownFailures([...ALL.map(v => `${v.id}:`), "agreement:"]);
  expect(stale, "KNOWN_FAILURES entries that no check evaluated (remove them)").toEqual([]);
});
