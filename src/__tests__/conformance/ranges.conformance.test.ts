/**
 * Row caps, ranges and intervals (docs/TESTING.md §5.4) — per venue, over
 * src/__tests__/fixtures/conformance/ranges-<venue>.json:
 *
 *  1. limit honoured — a `--limit` / time range the venue holds data for returns exactly `limit`
 *     rows / the full range. A response at a server cap (SERVER_CAPS) must trigger paging: the cap
 *     cells ask for more rows than one page; silent truncation fails.
 *  2. no silent empty — an empty array for a range / interval that has data fails (the venue must
 *     throw a typed error instead).
 *  3. interval verified — every interval of KLINE_INTERVALS has a recorded cell whose bars are
 *     spaced by exactly that interval; an unsupported interval is refused before any I/O.
 *  4. documented caps — SERVER_CAPS is the one table of measured caps the cells reference.
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
import { listVenues } from "../../exchanges/venue.js";
import type { VenueId } from "../../exchanges/venue-types.js";
import { VENUE_CONFORMANCE } from "./capabilities.js";
import { hasFixture, IS_LIVE, MODE, runCli, Session, VENUE_FILTER, type CliRun } from "./harness.js";
import { expectCheck, staleKnownFailures } from "./known-failures.js";
import { CAP_TABLE_AGREEMENT, intervalMs, KLINE_INTERVALS, REFUSED_CAPS, SERVER_CAPS, UNSUPPORTED_INTERVAL, UNMEASURED_CAPS, type ServerCap } from "./server-caps.js";

const ALL = listVenues().map(v => v.id);
const VENUES = ALL.filter(v => (VENUE_FILTER === null || VENUE_FILTER.has(v)));
/** Bars per interval cell: the window is this many intervals back from now. */
const WINDOW_BARS = 6;
const DAY = 86_400_000;

describe("caps + interval tables cover the registry", () => {
  for (const v of ALL) {
    it(`${v}: has a KLINE_INTERVALS entry and either measured caps or a documented UNMEASURED_CAPS note`, () => {
      expect(KLINE_INTERVALS[v], `add ${v} to KLINE_INTERVALS (server-caps.ts)`).toBeDefined();
      const measured = SERVER_CAPS.some(c => c.venue === v);
      if (KLINE_INTERVALS[v].length > 0 && !measured) expect(UNMEASURED_CAPS[v], `measure ${v}'s caps or list them in UNMEASURED_CAPS`).toBeDefined();
    });
  }
  it("refused caps (cannot be paged) are positive integers of registered venues; the CLI tables agree with the adapter constants", () => {
    for (const c of REFUSED_CAPS) {
      expect(ALL, `${c.venue} (${c.command}) is not a registered venue`).toContain(c.venue);
      expect(Number.isInteger(c.max) && c.max > 0, `${c.venue} ${c.command} max ${c.max}`).toBe(true);
    }
    for (const a of CAP_TABLE_AGREEMENT) expect(a.table, a.what).toBe(a.adapter);
  });
  it("every measured cap records a date and the measurement", () => {
    for (const c of SERVER_CAPS) {
      expect(c.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.how.length).toBeGreaterThan(20);
    }
  });
});

const times = (r: CliRun): number[] => (Array.isArray(r.envelope.data) ? (r.envelope.data as Array<{ time: number }>).map(k => k.time) : []);

function spacingProblem(raw: number[], iv: string): string | null {
  // Order is checked by the kline cell of venues.conformance.test.ts; spacing is about the set of opens.
  const ts = [...raw].sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const ms = intervalMs(iv);
  const diffs = ts.slice(1).map((t, i) => t - ts[i]);
  if (iv.endsWith("M")) {
    // Months: 28–31 days apart (calendar months, or Hyperliquid's fixed 30-day "1M").
    const bad = diffs.filter(d => d < 28 * DAY || d > 31 * DAY).length;
    return bad === 0 ? null : `${bad} bar(s) not monthly`;
  }
  const min = Math.min(...diffs);
  if (min !== ms) return `bars ${min / 60_000} min apart, requested ${iv} (${ms / 60_000} min)`;
  const off = diffs.filter(d => d % ms !== 0).length;
  return off === 0 ? null : `${off} gap(s) not a multiple of ${iv}`;
}

function capCell(cap: ServerCap): { cell: string; argv: (now: number) => string[]; expected: number; slack: number } {
  const symbol = VENUE_CONFORMANCE[cap.venue].symbol;
  if ("limit" in cap.request) {
    const limit = cap.request.limit;
    return { cell: `cap:funding:${limit}`, argv: () => ["-e", cap.venue, "market", "funding", symbol, "--limit", String(limit)], expected: limit, slack: 0 };
  }
  const { interval, rows } = cap.request;
  const ms = intervalMs(interval);
  return {
    cell: `cap:kline:${interval}:${rows}`,
    argv: (now: number) => {
      const end = Math.floor(now / ms) * ms;
      return ["-e", cap.venue, "market", "kline", symbol, interval, "--start", String(end - rows * ms), "--end", String(end)];
    },
    expected: rows,
    slack: 1,
  };
}

for (const venue of VENUES) {
  const intervals = KLINE_INTERVALS[venue as VenueId] ?? [];
  const caps = SERVER_CAPS.filter(c => c.venue === venue);
  if (intervals.length === 0 && caps.length === 0) continue;
  const name = `ranges-${venue}`;
  const runnable = IS_LIVE || hasFixture(name);

  describe(`ranges ${venue} (${MODE})`, () => {
    it("has a recorded fixture (pnpm conformance:record --ranges)", () => expect(runnable).toBe(true));
    if (!runnable) return;
    const runs = new Map<string, CliRun>();
    const calls = new Map<string, number>();
    const symbol = VENUE_CONFORMANCE[venue as VenueId].symbol;

    beforeAll(async () => {
      const session = new Session(name, VENUE_CONFORMANCE[venue as VenueId].keep);
      session.start();
      try {
        // Warm cell: its requests mark the adapter start-up, so the refusal cell measures the interval check alone.
        session.begin("warm");
        await runCli(["-e", venue, "market", "info", symbol]);
        for (const iv of intervals) {
          const cell = `kline:${iv}`;
          session.begin(cell);
          const ms = intervalMs(iv);
          const now = Date.now();
          runs.set(cell, await runCli(["-e", venue, "market", "kline", symbol, iv, "--start", String(now - WINDOW_BARS * ms), "--end", String(now)]));
        }
        session.begin("kline:unsupported");
        runs.set("kline:unsupported", await runCli(["-e", venue, "market", "kline", symbol, UNSUPPORTED_INTERVAL]));
        for (const cap of caps) {
          const c = capCell(cap);
          session.begin(c.cell, { full: true });
          runs.set(c.cell, await runCli(c.argv(Date.now())));
          if (MODE === "record") {
            // Measurement: record the next page(s) beside the full page at the cap.
            const capped = session.lastHttp(c.cell, cap.match);
            if (capped === null) throw new Error(`${c.cell}: no request matching "${cap.match}" — update SERVER_CAPS`);
            for (const p of cap.nextPage(capped)) await fetch(p.url, p.body === null ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: p.body });
          }
        }
        for (const [cell, n] of session.calls) calls.set(cell, n);
        // Requests of the refusal cell that the warm `market info` cell made too are the adapter's own
        // start-up (Hyperliquid info meta, Aster /time, Lighter market directory) — every command
        // makes them in a fresh process. The interval check is measured by what remains.
        const startup = new Set(session.requestKeys.get("warm") ?? []);
        calls.set("kline:unsupported", (session.requestKeys.get("kline:unsupported") ?? []).filter(k => !startup.has(k)).length);
        session.finalize();
        if (session.misses.length > 0) console.warn(`[conformance] ${name}: requests missing from the fixture:\n  ${session.misses.join("\n  ")}`);
      } finally {
        session.stop();
      }
    }, IS_LIVE ? 900_000 : 120_000);

    for (const iv of intervals) {
      describe(`kline ${iv}`, () => {
        it("no silent empty (bars exist for the window)", () => {
          const r = runs.get(`kline:${iv}`)!;
          const fail = !r.envelope.ok ? `ok:false ${r.envelope.error?.code}: ${r.envelope.error?.message?.slice(0, 120)}`
            : times(r).length === 0 ? `[] for the last ${WINDOW_BARS} × ${iv}` : null;
          expectCheck(`${venue}:kline-${iv}:no-silent-empty`, fail);
        });
        it(`bars are spaced by ${iv}`, () => {
          expectCheck(`${venue}:kline-${iv}:spacing`, spacingProblem(times(runs.get(`kline:${iv}`)!), iv));
        });
      });
    }

    if (intervals.length > 0) {
      it(`unsupported interval ${UNSUPPORTED_INTERVAL} is refused before any I/O`, () => {
        const r = runs.get("kline:unsupported")!;
        const n = calls.get("kline:unsupported") ?? 0;
        const fail = r.envelope.ok ? `ok:true (${times(r).length} bars)`
          : !["INVALID_PARAMS", "CAPABILITY_UNSUPPORTED"].includes(r.envelope.error!.code) ? `code ${r.envelope.error!.code}`
          : n > 0 ? `refused after ${n} request(s) beyond the adapter start-up` : null;
        expectCheck(`${venue}:kline-unsupported:refused-before-io`, fail);
      });
    }

    for (const cap of caps) {
      const c = capCell(cap);
      it(`${c.cell}: a request past the measured cap (${cap.measuredRows}) returns every row (paging, no truncation, no empty)`, () => {
        const r = runs.get(c.cell)!;
        const n = Array.isArray(r.envelope.data) ? (r.envelope.data as unknown[]).length : -1;
        const fail = !r.envelope.ok ? `ok:false ${r.envelope.error?.code}: ${r.envelope.error?.message?.slice(0, 120)}`
          : n === 0 ? `[] (silent empty) for ${c.expected} rows`
          : Math.abs(n - c.expected) > c.slack ? `${n} rows for ${c.expected} requested${n === cap.measuredRows ? " (= the server cap: no paging)" : ""}`
          : null;
        expectCheck(`${venue}:${c.cell}:limit-honoured`, fail);
      });
    }
  });
}

afterAll(() => {
  if (VENUE_FILTER !== null) return;
  expect(staleKnownFailures(ALL.flatMap(v => [`${v}:kline-`, `${v}:cap:`])), "stale KNOWN_FAILURES entries").toEqual([]);
});
