/**
 * Venue-final IOC / market order outcome.
 *
 * An adapter whose market / IOC responses report the order's FINAL filled size (nothing
 * of the order can still execute) implements `iocOutcomeOf(raw)` on the RAW result its
 * legacy `marketOrder` / `limitOrder(tif IOC)` / `spotMarketOrder` returned:
 *  - returns `{ filledSize, final: true }` only when `raw` is such a response AND the venue
 *    reported the final filled size of THAT order (e.g. HL `statuses[0].filled.totalSz`,
 *    Lighter tx `event_info` status "filled" or accountOrders `filled_base_amount`, Aster `executedQty` with a terminal status);
 *    `filledSize` is a plain decimal string in base units, "0" = definitely nothing filled;
 *  - returns `null` for anything else (unrecognized shape, resting / open order, no fill
 *    report, not final) — the caller then measures the fill (position / balance delta).
 * It never throws and never guesses: a missing report is `null`, never "0".
 *
 * Consumers (`placePerpVerified`, `closePerpVerified`, `spotMarketFill`) still cross-check
 * the reported fill against a measured delta. Adapters without the method are measured as
 * before (`isIocOutcomeCapable` handles absence).
 */

export interface IocOutcome {
  /** Final filled size in base units (plain decimal string, "0" = nothing filled). */
  filledSize: string;
  final: true;
}

export interface IocOutcomeCapable {
  iocOutcomeOf(raw: unknown): IocOutcome | null;
}

export function isIocOutcomeCapable(a: unknown): a is IocOutcomeCapable {
  return a !== null && typeof a === "object" && typeof (a as { iocOutcomeOf?: unknown }).iocOutcomeOf === "function";
}

/**
 * Tolerance for comparing a venue-final fill with the order size or a measured delta.
 * Never derived from the decimals of the strings ("5" vs "4" would give a 1-lot tolerance
 * and call a partial fill complete):
 *  - market `stepSize` known (> 0) → half a lot: lot multiples differ by at least one lot,
 *    so anything below half a lot is representation noise;
 *  - unknown → float-noise epsilon max(size, fill) × 1e-9.
 */
export function iocLotTolerance(size: string, filledSize: string, stepSize?: string | number | null): number {
  const step = stepSize === undefined || stepSize === null ? NaN : Number(stepSize);
  if (Number.isFinite(step) && step > 0) return step / 2;
  const mag = Math.max(Math.abs(Number(size)), Math.abs(Number(filledSize)));
  return (Number.isFinite(mag) ? mag : 0) * 1e-9;
}

/**
 * The average FILL price the venue reported in a raw order result (plain positive decimal
 * string), or null when it reports none. Read only from fill fields — Hyperliquid
 * `response.data.statuses[0].filled.avgPx`; `avgPrice` of an Aster order object or of a
 * TradingV2 OrderResult — and never from the order's own `price` (the limit / slippage
 * protection price that was SENT, which is not where it filled).
 */
export function reportedAvgFillPrice(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { avgPrice?: unknown; response?: { data?: { statuses?: unknown } } };
  const statuses = r.response?.data?.statuses;
  const first: unknown = Array.isArray(statuses) ? statuses[0] : null;
  const hl = first !== null && typeof first === "object" ? (first as { filled?: { avgPx?: unknown } }).filled?.avgPx : undefined;
  for (const v of [r.avgPrice, hl]) {
    const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
    if (typeof s === "string" && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0) return s;
  }
  return null;
}
