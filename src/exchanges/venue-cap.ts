/**
 * Venue-cap signal for market-data reads whose venue serves fewer rows than asked for (a fixed
 * tape / book / candle window). Carried on the returned array as a NON-enumerable property, like
 * TAPE_SKIPPED, so the rows themselves are unchanged; `market` commands print it as
 * `meta.venueCap` (JSON) or a warning (human output). Absent = the venue did not cap the read.
 */
export interface VenueCap {
  /** The venue's fixed maximum (rows / levels / candles) for this read. */
  cappedAt: number;
  /** Rows the caller asked for, when the read takes a count (trades, book depth); null otherwise. */
  requested: number | null;
  /** Rows returned. */
  returned: number;
  /** Klines: open time (unix ms) of the earliest candle returned when the requested range starts before it; null otherwise. */
  availableFrom: number | null;
  /** True when rows the request covers were not served (data before availableFrom / beyond the cap). */
  truncated: boolean;
  reason: string;
}

export const VENUE_CAP: unique symbol = Symbol.for("perp-cli.venueCap");

/** Attach `cap` to a read result (rows array or order book), non-enumerable; returns `result`. */
export function withVenueCap<T extends object>(result: T, cap: VenueCap | null): T {
  if (cap !== null) Object.defineProperty(result, VENUE_CAP, { value: cap, enumerable: false });
  return result;
}

/** The venue-cap signal of a read result, or null. Accepts any result (book objects carry it too). */
export function venueCapOf(result: unknown): VenueCap | null {
  if (result === null || typeof result !== "object") return null;
  const v = (result as { [VENUE_CAP]?: VenueCap })[VENUE_CAP];
  return v === undefined ? null : v;
}

