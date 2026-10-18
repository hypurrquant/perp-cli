/**
 * Spot order outcome → filled size, for bots / arb.
 *
 * A resolved `spotMarketOrder()` promise does NOT mean "filled": the adapters
 * return a `SpotOrderResult` (rejected / cancelled / pending / partial / filled),
 * and the legacy Hyperliquid / Lighter adapters return a venue payload. Every bot /
 * arb spot leg goes through `spotMarketFill()` so the hedge is sized to what
 * actually filled:
 *
 *  - rejected / cancelled (nothing filled)        → throws ORDER_REJECTED
 *  - pending / open / fill size not reported      → throws ORDER_PENDING (do NOT retry)
 *  - the order call itself throws                 → a PerpError with a definite code
 *    (isDefiniteOrderFailure: validation / policy / explicit venue rejection) is
 *    rethrown as a definite failure; ANYTHING else (non-PerpError, EXCHANGE_UNREACHABLE,
 *    TIMEOUT, EXCHANGE_ERROR, RATE_LIMITED, UNKNOWN, …) becomes ORDER_PENDING — the
 *    request may have reached the venue, so callers quarantine instead of retrying.
 *  - partial                                      → returns the filled size
 *  - filled                                       → returns the filled size
 *
 * Legacy results:
 *  - Hyperliquid: `response.data.statuses[0].filled.totalSz` (resting → pending).
 *  - Lighter: the adapter reads the fill from Lighter's own /tx event_info (taker
 *    order "filled") or, for any other status, the order's accountOrders row
 *    (filled_base_amount), and returns a final SpotOrderResult that iocOutcomeOf() reports
 *    (venueFinalSpotFill below). A SpotOrderResult marked TX_EVENT_FILL_SOURCE that is not
 *    routed through iocOutcomeOf is cross-checked as follows; because
 *    the is/rs semantics are not venue-documented, that fill must be backed by a fresh
 *    base-balance delta of ≥ 80% (else ORDER_PENDING). Only when the venue gives no fill
 *    report does it return the raw tx hash; the fill is then MEASURED as the base-token
 *    balance delta around the order using UNCACHED reads (readSpotBalancesFresh). A
 *    zero delta is ORDER_PENDING (the IOC may still be unconfirmed), never "nothing
 *    filled"; a failed read is never zero.
 *
 * Venue-final IOC outcome: when the spot adapter is IocOutcomeCapable
 * and iocOutcomeOf(result) reports the order's FINAL filled size, that report is used in
 * preference to the balance delta, cross-checked against a fresh base-balance delta:
 *  - final 0 and the balance did not move (≤ one lot) → ORDER_REJECTED (definite);
 *    the balance DID move → the measured delta is used (discrepancy logged to stderr);
 *  - final > 0 → filledSize = the reported size when the delta is ≥ 80% of it (base-token
 *    fees), else ORDER_PENDING; an unreadable balance → ORDER_PENDING.
 */

import { PerpError, isDefiniteOrderFailure, orderOutcomeUnknown } from "../errors.js";
import { resolveAdapterSlippage } from "./slippage.js";
import { iocLotTolerance, isIocOutcomeCapable, type IocOutcome } from "./ioc-outcome.js";
import { isSpotFreshBalancesCapable, TX_EVENT_FILL_SOURCE, type SpotAdapter, type SpotBalance, type SpotOrderResult } from "./spot-interface.js";
import { spotTokenBase } from "./spot-factory.js";

export interface SpotFill {
  status: "filled" | "partial";
  /** Base units actually filled (> 0). */
  filledSize: number;
  avgPrice: number | null;
  orderId: string | null;
  /** The adapter's raw result (for logs). */
  raw: unknown;
}

/** A tx-event-derived / venue-final fill must be backed by at least this share of balance movement (base-token fees). */
const TX_FILL_MIN_BALANCE_RATIO = 0.8;

function isTxEventFill(r: SpotOrderResult): boolean {
  const raw = r.venueRaw as { fillSource?: unknown } | null;
  return raw !== null && typeof raw === "object" && raw.fillSource === TX_EVENT_FILL_SOURCE;
}

/** A fill below requested × (1 − this) is reported as "partial" (step flooring dust excluded). */
const FULL_FILL_TOLERANCE = 1e-6;

function isSpotOrderResult(r: unknown): r is SpotOrderResult {
  if (r === null || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return typeof o.status === "string" && (o.finality === "final" || o.finality === "pending") && "filledSize" in o;
}

function pendingError(venue: string, symbol: string, why: string, orderId: string | null, remediation: string | null, raw: unknown): PerpError {
  return new PerpError("ORDER_PENDING", `${venue} spot ${symbol}: ${why}${orderId !== null ? ` (order ${orderId})` : ""}`, {
    exchange: venue,
    orderId,
    raw,
    remediation: remediation ?? `Do NOT resubmit — the order may still fill. Check: perp -e ${venue} trade spot-balance / spot-orders`,
  });
}

function positive(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function classify(filled: number, requested: number): "filled" | "partial" {
  return filled >= requested * (1 - FULL_FILL_TOLERANCE) ? "filled" : "partial";
}

/**
 * Interpret a spot order result. `measuredFill` = base balance delta measured around
 * the order (null when not measured); used only for results that carry no fill report.
 */
export function interpretSpotFill(
  venue: string,
  symbol: string,
  result: unknown,
  requestedSize: number,
  measuredFill: number | null,
): SpotFill {
  if (isSpotOrderResult(result)) {
    const r = result;
    if (r.status === "rejected" || r.status === "cancelled") {
      // "cancelled" with a fill would be "partial" (adapters map it so); here nothing filled.
      throw new PerpError("ORDER_REJECTED", `${venue} spot ${symbol}: order ${r.status}${r.remediation ? ` — ${r.remediation}` : ""}`, {
        exchange: venue, orderId: r.orderId, raw: r.venueRaw,
      });
    }
    if (r.finality === "pending" || r.status === "pending" || r.status === "open") {
      throw pendingError(venue, symbol, `order not final (status ${r.status})`, r.orderId, r.remediation, r.venueRaw);
    }
    const filled = positive(r.filledSize);
    if (filled === null) {
      throw pendingError(venue, symbol, `order ${r.status} but the venue reported no filled size`, r.orderId, null, r.venueRaw);
    }
    return {
      status: r.status === "partial" ? "partial" : classify(filled, requestedSize),
      filledSize: filled,
      avgPrice: positive(r.avgPrice),
      orderId: r.orderId,
      raw: result,
    };
  }

  // Legacy Hyperliquid: { status: "ok", response: { data: { statuses: [{ filled | resting | error }] } } }
  const hl = result as { response?: { data?: { statuses?: Array<Record<string, unknown>> } } } | null;
  const statuses = hl?.response?.data?.statuses;
  if (Array.isArray(statuses)) {
    const st = statuses[0];
    if (st === undefined) throw pendingError(venue, symbol, "no order status in the response", null, null, result);
    if (st.error) throw new PerpError("ORDER_REJECTED", `${venue} spot ${symbol}: ${String(st.error)}`, { exchange: venue });
    const f = st.filled as { totalSz?: string; avgPx?: string; oid?: number } | undefined;
    const filled = positive(f?.totalSz);
    if (filled === null) {
      const resting = st.resting as { oid?: number } | undefined;
      throw pendingError(venue, symbol, "order not filled (resting or unreported)", resting?.oid !== undefined ? String(resting.oid) : null, null, result);
    }
    return { status: classify(filled, requestedSize), filledSize: filled, avgPrice: positive(f?.avgPx), orderId: f?.oid !== undefined ? String(f.oid) : null, raw: result };
  }

  // Legacy Lighter (tx hash only): measured balance delta.
  if (measuredFill === null) {
    throw pendingError(venue, symbol, "the venue reported no fill and none was measured", null, null, result);
  }
  if (!(measuredFill > 0)) {
    throw pendingError(venue, symbol, "no balance change observed after the order (it may still be unconfirmed)", null, null, result);
  }
  return { status: classify(measuredFill, requestedSize), filledSize: Math.min(measuredFill, requestedSize), avgPrice: null, orderId: null, raw: result };
}

/**
 * Uncached spot balances: getSpotBalancesFresh() on adapters whose getSpotBalances()
 * is TTL-cached (SpotFreshBalancesCapable contract), getSpotBalances() on adapters that
 * read live. Use for fill measurement and post-trade verification. Throws on failure.
 */
export async function readSpotBalancesFresh(spot: SpotAdapter): Promise<SpotBalance[]> {
  return isSpotFreshBalancesCapable(spot) ? spot.getSpotBalancesFresh() : spot.getSpotBalances();
}

/** Base-token balance (total) on the spot venue, read uncached; a token with no balance row holds 0. */
async function baseBalance(spot: SpotAdapter, symbol: string): Promise<number> {
  const base = spotTokenBase(symbol.split("/")[0] ?? symbol);
  const row = (await readSpotBalancesFresh(spot)).find(b => spotTokenBase(b.token) === base);
  if (row === undefined) return 0;
  const n = Number(row.total);
  if (!Number.isFinite(n)) throw new PerpError("EXCHANGE_ERROR", `${spot.name} spot balance for ${base} is not a number: ${row.total}`, { exchange: spot.name });
  return n;
}

/**
 * Place a spot market order and return what filled (see header). The base balance is
 * read before the order so venues without a fill report can be measured; a failure of
 * that read aborts BEFORE anything is placed. After the order, errors never throw a
 * retryable error: an unreadable outcome is ORDER_PENDING.
 */
export async function spotMarketFill(spot: SpotAdapter, symbol: string, side: "buy" | "sell", size: string, stepSize: string | null = null): Promise<SpotFill> {
  const requested = Number(size);
  if (!(requested > 0)) throw new PerpError("INVALID_PARAMS", `spot ${side} size must be positive (got ${size})`);
  // Bot/arb spot legs carry no per-call flag: settings slippageBps[venue] → defaultSlippageBps.
  const slippage = resolveAdapterSlippage(spot, null);
  const before = await baseBalance(spot, symbol);
  let result: unknown;
  try {
    result = await spot.spotMarketOrder(symbol, side, size, { slippage });
  } catch (e) {
    if (isDefiniteOrderFailure(e)) throw e;
    // Not a definite rejection: the request may have reached the venue.
    throw orderOutcomeUnknown(spot.name, `spot ${side} ${size} ${symbol}`, e,
      `Do NOT resubmit — the order may still fill. Check: perp -e ${spot.name} trade spot-balance / spot-orders`);
  }
  const outcome = isIocOutcomeCapable(spot) ? spot.iocOutcomeOf(result) : null;
  if (outcome !== null) return venueFinalSpotFill(spot, symbol, side, size, before, result, outcome, stepSize);
  if (isSpotOrderResult(result)) {
    const fill = interpretSpotFill(spot.name, symbol, result, requested, null);
    if (!isTxEventFill(result)) return fill;
    // Lighter-family fills are derived from the tx event_info (`is` − `rs`), whose
    // semantics are not venue-documented: cross-check against a FRESH balance delta.
    let after: number;
    try {
      after = await baseBalance(spot, symbol);
    } catch (e) {
      throw pendingError(spot.name, symbol, `tx reported ${fill.filledSize} filled but the post-order balance could not be read (${e instanceof Error ? e.message : String(e)})`, fill.orderId, null, result);
    }
    const delta = side === "buy" ? after - before : before - after;
    if (delta < fill.filledSize * TX_FILL_MIN_BALANCE_RATIO) {
      throw pendingError(spot.name, symbol, `tx reported ${fill.filledSize} filled but the balance moved only ${delta}`, fill.orderId, null, result);
    }
    return fill;
  }
  const hl = result as { response?: { data?: { statuses?: unknown } } } | null;
  if (Array.isArray(hl?.response?.data?.statuses)) return interpretSpotFill(spot.name, symbol, result, requested, null);
  let after: number;
  try {
    after = await baseBalance(spot, symbol);
  } catch (e) {
    throw pendingError(spot.name, symbol, `order sent but the post-order balance could not be read (${e instanceof Error ? e.message : String(e)})`, null, null, result);
  }
  const delta = side === "buy" ? after - before : before - after;
  return interpretSpotFill(spot.name, symbol, result, requested, delta);
}

/** spotMarketFill for a venue-final IOC outcome (see header): the reported fill, cross-checked against the balance delta. */
async function venueFinalSpotFill(
  spot: SpotAdapter, symbol: string, side: "buy" | "sell", size: string, before: number, result: unknown, outcome: IocOutcome, stepSize: string | null,
): Promise<SpotFill> {
  const requested = Number(size);
  const hlStatus = (result as { response?: { data?: { statuses?: Array<Record<string, unknown>> } } } | null)?.response?.data?.statuses?.[0];
  const hlFilled = hlStatus?.filled as { avgPx?: string; oid?: number } | undefined;
  const orderId = isSpotOrderResult(result) ? result.orderId : hlFilled?.oid !== undefined ? String(hlFilled.oid) : null;
  const reported = Number(outcome.filledSize);
  if (!(Number.isFinite(reported) && reported >= 0)) {
    throw pendingError(spot.name, symbol, `venue reported an unusable final fill "${outcome.filledSize}"`, orderId, null, result);
  }
  const tol = iocLotTolerance(size, outcome.filledSize, stepSize);
  if (reported > requested + tol) {
    throw pendingError(spot.name, symbol, `venue reported a final fill of ${outcome.filledSize}, more than the ${size} ordered`, orderId, null, result);
  }
  let after: number;
  try {
    after = await baseBalance(spot, symbol);
  } catch (e) {
    throw pendingError(spot.name, symbol, `venue reported a final fill of ${outcome.filledSize} but the post-order balance could not be read (${e instanceof Error ? e.message : String(e)})`, orderId, null, result);
  }
  const delta = side === "buy" ? after - before : before - after;
  if (reported === 0) {
    if (!(delta > tol)) {
      const venueError = hlStatus?.error;
      throw new PerpError("ORDER_REJECTED", `${spot.name} spot ${symbol}: ${venueError ? String(venueError) : "IOC filled nothing"} (venue-final, balance unchanged)`, {
        exchange: spot.name, orderId, raw: result,
      });
    }
    process.stderr.write(`[warn] ${spot.name} spot ${side} ${size} ${symbol}: venue reported a final fill of 0 but the balance moved ${delta} — using the measured fill\n`);
    return { status: classify(delta, requested), filledSize: Math.min(delta, requested), avgPrice: null, orderId, raw: result };
  }
  if (delta < reported * TX_FILL_MIN_BALANCE_RATIO) {
    throw pendingError(spot.name, symbol, `venue reported a final fill of ${outcome.filledSize} but the balance moved only ${delta}`, orderId, null, result);
  }
  const avgPrice = isSpotOrderResult(result) ? positive(result.avgPrice) : positive(hlFilled?.avgPx);
  return { status: classify(reported, requested), filledSize: Math.min(reported, requested), avgPrice, orderId, raw: result };
}

/** Decimal string for a filled size (no exponent), floored to `decimals`. */
export function fillSizeString(filled: number, decimals: number): string {
  const f = 10 ** decimals;
  return (Math.floor(filled * f + 1e-9) / f).toFixed(decimals);
}

/** Decimal places of a plain decimal size string ("0.0100" → 4). */
export function sizeDecimalsOf(size: string): number {
  const frac = size.split(".")[1];
  return frac === undefined ? 0 : frac.length;
}

/**
 * Spot lot step (10^-sizeDecimals) from the venue's spot market info. `symbol` is "BASE/QUOTE"
 * or a bare base; a bare base whose markets disagree on the lot, or an unknown market, throws
 * (Rule #2: never size off the typed decimals).
 */
export async function spotLotStepOf(spot: SpotAdapter, symbol: string): Promise<string> {
  const want = symbol.toUpperCase();
  const markets = (await spot.getSpotMarkets()).filter(m => want.includes("/")
    ? m.symbol.toUpperCase() === want
    : spotTokenBase(m.baseToken) === spotTokenBase(want));
  const decs = [...new Set(markets.map(m => m.sizeDecimals))];
  if (decs.length !== 1 || !Number.isInteger(decs[0]) || decs[0] < 0) {
    throw new PerpError(markets.length === 0 ? "SYMBOL_NOT_FOUND" : "EXCHANGE_ERROR",
      `${spot.name} spot ${symbol}: ${markets.length === 0 ? "market not found" : `ambiguous / unusable lot precision (${decs.join(", ")})`} — lot step unknown`, { exchange: spot.name });
  }
  const d = decs[0];
  return d === 0 ? "1" : `0.${"0".repeat(d - 1)}1`;
}
