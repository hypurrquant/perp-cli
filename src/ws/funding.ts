/**
 * Funding comparator + toHourly/toApr (§4). Compares like-for-like rate kinds: a leg without the
 * requested kind has rate null and `kindUnavailable: true` (never substituted). Rates stay raw (Dec,
 * per the venue's interval); annualize only with toApr.
 *
 * kind:
 *  - "current" (default): each leg's `rate`; rows whose legs differ in rateKind → mixedKinds.
 *  - "predicted": predictedRate (or rate when its kind is "predicted").
 *  - "lastSettled" / "accruing": rate only when its kind matches.
 *  - "next": the forward-looking rate per venue — accruing when published, else predicted.
 *    A venue with only a lastSettled rate is flagged (kindUnavailable), not substituted.
 */

import { WsError } from "./errors.js";
import type { VenueId } from "./ids.js";
import { VENUE_STATIC } from "./venue-static.js";
import type {
  Canonicalize, Dec, MarketDirectoryEntry, MarketUpdate, RateKind, StreamControl, Subscription, VenueStream,
} from "./types.js";

export type ComparatorKind = RateKind | "current" | "next";

const COMPARATOR_KINDS: ReadonlyArray<ComparatorKind> = ["current", "next", "predicted", "lastSettled", "accruing"];

export interface FundingLeg {
  venue: VenueId;
  dex: string | null;
  symbol: string;
  quote: string | null;
  mark: Dec | null;
  /** The rate of the requested kind, in the venue's interval (funding.rateIntervalHours). */
  rate: Dec | null;
  rateKind: RateKind | null;
  /** The venue does not publish the requested kind for this market (rate is null, not substituted). */
  kindUnavailable: boolean;
  funding: MarketUpdate["funding"];
  fundingVerified: boolean;
  asOf: number | null;
  stale: boolean;
}

export interface FundingRow {
  canonical: string;
  mixedKinds: boolean;
  legs: FundingLeg[];
}

export interface FundingComparatorOptions {
  streams: VenueStream[];
  /** Minimum venues with a non-null rate for a row to be listed (default 2). */
  minVenues?: number;
  /** Canonical allowlist. */
  include?: string[];
  canonicalize?: Canonicalize;
  kind?: ComparatorKind;
  /** Leg stale when the stream ≠ live or now − asOf > this (default 2 × venue staleAfterMs; Arcus 3×). */
  staleAfterMs?: number;
  /** Stream control events (state / error) of the underlying subscriptions, and errors thrown by
   * a comparator `subscribe` listener (`listener-error`; the other listeners still run). */
  onControl?: (c: StreamControl | ComparatorListenerError) => void;
  clock?: () => number;
}

export interface ComparatorListenerError {
  type: "listener-error";
  message: string;
}

export interface FundingComparator {
  rows(): FundingRow[];
  subscribe(cb: (rows: FundingRow[], changed: string[]) => void): () => void;
  close(): void;
}

/**
 * Rate per hour as a FRACTION (0.0000125 = 0.00125 %/h): `rate / rateIntervalHours`.
 * @experimental 0.15.x (stable from 0.16.0 after consumer sign-off)
 */
export function toHourly(rate: Dec | null, rateIntervalHours: number | null): number | null {
  if (rate === null || rateIntervalHours === null || !(rateIntervalHours > 0)) return null;
  const n = Number(rate);
  return Number.isFinite(n) ? n / rateIntervalHours : null;
}

/**
 * Simple annualized rate as a FRACTION, not a percent: `toHourly × 24 × 365` (0.0000125/h → 0.1095,
 * i.e. 10.95 %). The CLI's `annualizedPct` (`arb scan --rates`, MCP `get_funding_rates`) is the same
 * quantity in PERCENT (10.95): multiply `toApr` by 100 to compare the two.
 * @experimental 0.15.x (stable from 0.16.0 after consumer sign-off)
 */
export function toApr(rate: Dec | null, rateIntervalHours: number | null): number | null {
  const h = toHourly(rate, rateIntervalHours);
  return h === null ? null : h * 24 * 365;
}

function pick(u: MarketUpdate, kind: ComparatorKind, predictedPublished: boolean): { rate: Dec | null; rateKind: RateKind | null; field: "rate" | "predictedRate"; unavailable: boolean } {
  const f = u.funding;
  const predicted = (): { rate: Dec | null; rateKind: RateKind | null; field: "rate" | "predictedRate"; unavailable: boolean } => {
    if (f.rateKind === "predicted") return { rate: f.rate, rateKind: "predicted", field: "rate", unavailable: false };
    return predictedPublished
      ? { rate: f.predictedRate, rateKind: "predicted", field: "predictedRate", unavailable: false }
      : { rate: null, rateKind: null, field: "predictedRate", unavailable: true };
  };
  switch (kind) {
    case "current":
      return { rate: f.rate, rateKind: f.rateKind, field: "rate", unavailable: false };
    case "predicted":
      return predicted();
    case "lastSettled":
    case "accruing":
      return f.rateKind === kind
        ? { rate: f.rate, rateKind: kind, field: "rate", unavailable: false }
        : { rate: null, rateKind: null, field: "rate", unavailable: true };
    case "next":
      if (f.rateKind === "accruing") return { rate: f.rate, rateKind: "accruing", field: "rate", unavailable: false };
      return predicted();
  }
}

/** Bad options throw INVALID_PARAMS synchronously (never a TypeError later from event dispatch / rows()). */
function checkOptions(opts: FundingComparatorOptions): void {
  const bad = (message: string, remediation: string): never => {
    throw new WsError("INVALID_PARAMS", `createFundingComparator: ${message}`, { remediation });
  };
  if (opts === null || typeof opts !== "object") bad("options must be an object", "Pass { streams: [...] }");
  if (!Array.isArray(opts.streams) || opts.streams.some(s => s === null || typeof s !== "object" || typeof s.subscribe !== "function" || typeof s.markets !== "function")) {
    bad("streams must be an array of VenueStream", "Pass streams created with createVenueStream()");
  }
  if (opts.kind !== undefined && !COMPARATOR_KINDS.includes(opts.kind)) {
    bad(`unknown kind ${JSON.stringify(opts.kind)}`, `Use kind ${COMPARATOR_KINDS.map(k => `"${k}"`).join(" / ")}`);
  }
  if (opts.minVenues !== undefined && !(Number.isInteger(opts.minVenues) && opts.minVenues >= 1)) {
    bad(`minVenues must be a positive integer (got ${String(opts.minVenues)})`, "Pass minVenues ≥ 1, or omit it (default 2)");
  }
  if (opts.include !== undefined && !(Array.isArray(opts.include) && opts.include.every(c => typeof c === "string"))) {
    bad("include must be an array of canonical symbols", "Pass e.g. include: [\"BTC\", \"ETH\"], or omit it");
  }
  if (opts.staleAfterMs !== undefined && !(typeof opts.staleAfterMs === "number" && Number.isFinite(opts.staleAfterMs) && opts.staleAfterMs > 0)) {
    bad(`staleAfterMs must be a positive number (got ${String(opts.staleAfterMs)})`, "Pass milliseconds > 0, or omit it (venue default)");
  }
  for (const k of ["canonicalize", "onControl", "clock"] as const) {
    if (opts[k] !== undefined && typeof opts[k] !== "function") bad(`${k} must be a function`, `Pass a function or omit ${k}`);
  }
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export function createFundingComparator(opts: FundingComparatorOptions): FundingComparator {
  checkOptions(opts);
  const kind: ComparatorKind = opts.kind === undefined ? "current" : opts.kind;
  const minVenues = opts.minVenues === undefined ? 2 : opts.minVenues;
  const include = opts.include === undefined ? null : new Set(opts.include);
  const clock = opts.clock === undefined ? () => Date.now() : opts.clock;
  const latest = new Map<string, { stream: VenueStream; u: MarketUpdate }>();
  const dirs = new Map<VenueStream, Map<string, MarketDirectoryEntry>>();
  const listeners = new Set<(rows: FundingRow[], changed: string[]) => void>();
  const subs: Array<Subscription<MarketUpdate>> = [];
  const pending = new Set<string>();
  let scheduled = false;
  let closed = false;

  function canonicalOf(stream: VenueStream, u: MarketUpdate): string | null {
    if (opts.canonicalize === undefined) return u.canonical;
    const e = dirs.get(stream)?.get(u.symbol);
    if (e === undefined) return null;
    return opts.canonicalize(u.venue, { venueSymbol: u.venueSymbol, dex: u.dex, base: e.base, quote: u.quote });
  }

  function threshold(stream: VenueStream): number {
    if (opts.staleAfterMs !== undefined) return opts.staleAfterMs;
    return (stream.venue === "arcus" ? 3 : 2) * stream.staleAfterMs; // Arcus rates change on settlement
  }

  function leg(stream: VenueStream, u: MarketUpdate, now: number): FundingLeg {
    const p = pick(u, kind, stream.capabilities.fields.predictedRate);
    const at = u.asOf[p.field];
    const asOf = at === undefined ? null : at;
    const st = VENUE_STATIC[u.venue];
    return {
      venue: u.venue, dex: u.dex, symbol: u.symbol, quote: u.quote, mark: u.mark,
      rate: p.rate, rateKind: p.rateKind,
      kindUnavailable: p.unavailable,
      funding: u.funding,
      fundingVerified: st === undefined ? false : st.fundingVerified,
      asOf,
      stale: stream.state.status !== "live" || asOf === null || now - asOf > threshold(stream),
    };
  }

  function rows(): FundingRow[] {
    const now = clock();
    const groups = new Map<string, FundingLeg[]>();
    for (const { stream, u } of latest.values()) {
      const c = canonicalOf(stream, u);
      if (c === null || (include !== null && !include.has(c))) continue;
      let g = groups.get(c);
      if (g === undefined) { g = []; groups.set(c, g); }
      g.push(leg(stream, u, now));
    }
    const out: FundingRow[] = [];
    for (const [canonical, legs] of groups) {
      const withRate = legs.filter(l => l.rate !== null);
      if (new Set(withRate.map(l => l.venue)).size < minVenues) continue;
      const kinds = new Set(withRate.map(l => l.rateKind));
      legs.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : a.symbol < b.symbol ? -1 : 1));
      out.push({ canonical, mixedKinds: kinds.size > 1, legs });
    }
    out.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));
    return out;
  }

  function schedule(changed: string): void {
    pending.add(changed);
    if (scheduled || listeners.size === 0) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      if (closed) return;
      const ch = Array.from(pending);
      pending.clear();
      const r = rows();
      for (const l of listeners) {
        try {
          l(r, ch);
        } catch (e) {
          const message = `funding comparator listener threw: ${e instanceof Error ? e.message : String(e)}`;
          if (opts.onControl !== undefined) {
            try { opts.onControl({ type: "listener-error", message }); } catch { /* the handler itself threw; nothing left to report to */ }
          }
        }
      }
    });
  }

  for (const stream of opts.streams) {
    stream.markets().then(
      (entries) => { dirs.set(stream, new Map(entries.map(e => [e.symbol, e]))); },
      () => undefined, // the subscription below reports the same failure as an error control
    );
    const sub = stream.subscribe({ kind: "allMarkets" });
    subs.push(sub);
    sub.on((e) => {
      if (e.type === "market") {
        latest.set(`${e.venue}|${e.symbol}`, { stream, u: e });
        const c = canonicalOf(stream, e);
        if (c !== null) schedule(c);
        return;
      }
      if (opts.onControl !== undefined) opts.onControl(e);
      if (e.type === "state") {
        for (const { stream: s, u } of latest.values()) {
          if (s !== stream) continue;
          const c = canonicalOf(s, u);
          if (c !== null) schedule(c);
        }
      }
    });
  }

  return {
    rows,
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      for (const s of subs) void s.unsubscribe();
    },
  };
}
