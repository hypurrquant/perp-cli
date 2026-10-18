/**
 * Verified perp market order for bot / arb legs.
 *
 * A resolved `marketOrder()` promise does not prove a fill: Lighter returns success
 * when its /tx poll times out ("assuming executed") or the IOC filled nothing, and a
 * transport failure after the request leaves the outcome unknown. Every bot perp leg
 * that hedges (or un-hedges) another leg goes through placePerpVerified():
 *
 *  - the position on the venue is read BEFORE the order (failure → ORDER_REJECTED,
 *    nothing sent);
 *  - the order call throws a TYPED definite rejection (isDefiniteOrderFailure) → rethrown
 *    unchanged;
 *  - otherwise — a resolved call, or ANY other thrown value (untyped Error, transport
 *    failure, HL "HL exchange API error (5xx)", Pacifica "POST … failed (5xx)", any
 *    non-definite PerpError) — the fill is MEASURED as the position delta (uncached
 *    reads, polled): moved ≥ 80% of the size (or a reduce-only order flattened the
 *    position) → filled; no such movement, or an unreadable position → ORDER_PENDING
 *    (do NOT resubmit, the caller quarantines). An untyped error is never read as a
 *    rejection. The one measured exception: a reduce-only order that threw a plain venue
 *    message while the position was flat before AND after cannot have done anything →
 *    ORDER_REJECTED carrying the venue message and details.reduceOnlyFlat (isPositionGone()).
 *    Likewise a plain (non-transport, non-5xx) "not a multiple of lot size N" rejection with
 *    the position measured unchanged → ORDER_REJECTED with details.lotSize (rejectedLotSize()).
 *
 * Venue-final IOC outcome: when the adapter is IocOutcomeCapable and
 * iocOutcomeOf(raw) reports the order's FINAL filled size, that report is authoritative
 * (no 80% rule) once cross-checked against the measured position delta (tolerance one lot
 * step, taken from the precision of the order size / reported fill):
 *  - final 0 and the position did not move → ORDER_REJECTED (definite, nothing filled);
 *    the position DID move → the measured delta is returned (discrepancy logged to stderr);
 *  - final 0 < filled ≤ size and the delta agrees → filledSize = the venue-reported size
 *    (a final partial fill — callers size the 2nd leg / trim / residual-close from it);
 *    the delta never agrees (or the position is unreadable) → ORDER_PENDING.
 * No outcome (adapter not capable, or iocOutcomeOf → null) → the measurement path above.
 */

import type { ExchangeAdapter } from "../exchanges/index.js";
import { invalidateCache } from "../cache.js";
import { resolveAdapterSlippage, type ResolvedSlippage } from "../exchanges/slippage.js";
import { PerpError, extractErrorMessage, isDefiniteOrderFailure, isTransportFailure, isUnknownOutcomeServerError, orderNotSent, orderOutcomeUnknown } from "../errors.js";
import { fillSizeString, sizeDecimalsOf } from "../exchanges/spot-result.js";
import { iocLotTolerance, isIocOutcomeCapable } from "../exchanges/ioc-outcome.js";
import { matchSymbol } from "./strategies/funding-arb-utils.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";

export interface PerpFill {
  /** Base units filled, > 0: the measured position delta, or the venue-final IOC fill cross-checked against it. */
  filledSize: number;
  /** The adapter's raw result (null when the call threw but the position moved). */
  raw: unknown;
}

/** Share of the requested size the position must move by to count as filled (measured path only — not for venue-final outcomes). */
const MIN_FILL_RATIO = 0.8;
/**
 * Position polls after the order (ms between reads; ~10 s in total). Venue account reads can
 * lag the fill (Lighter testnet: /account showed the position a few seconds after the tx
 * executed), so the window is bounded but long enough; a match ends the polling early.
 */
const POLL_DELAYS_MS = [0, 1000, 1500, 2000, 2500, 3000];

/**
 * HIP-3 dex coin key ("xyz:TSLA"): the order symbol and the position's coin go through
 * the SAME resolution the HL adapter uses for dex markets (resolveSymbol + dex prefix),
 * so "TSLA", "xyz:TSLA" and "XYZ:TSLA" all name one position.
 */
function hlDexCoinKey(adapter: HyperliquidAdapter, sym: string): string {
  const resolved = adapter.resolveSymbol(sym);
  return (resolved.includes(":") ? resolved : `${adapter.dex}:${resolved}`).toUpperCase();
}

/** Net signed position (long > 0, short < 0) for `symbol`, read uncached. Throws on a bad read. */
export async function signedPerpPosition(adapter: ExchangeAdapter, symbol: string): Promise<number> {
  invalidateCache("acct");
  let matches = (posSym: string): boolean => matchSymbol(posSym, symbol);
  if (adapter instanceof HyperliquidAdapter && adapter.dex !== "") {
    const target = hlDexCoinKey(adapter, symbol);
    matches = (posSym) => hlDexCoinKey(adapter, posSym) === target;
  }
  let net = 0;
  for (const p of await adapter.getPositions()) {
    if (!matches(p.symbol)) continue;
    const n = Math.abs(Number(p.size));
    if (!Number.isFinite(n)) throw new PerpError("EXCHANGE_ERROR", `${adapter.name} position size for ${p.symbol} is not a number: ${p.size}`);
    net += p.side === "long" ? n : -n;
  }
  return net;
}

/** First HL-style per-order status in a raw result, or null. */
function firstVenueStatus(raw: unknown): Record<string, unknown> | null {
  const statuses = (raw as { response?: { data?: { statuses?: Array<Record<string, unknown>> } } } | null)?.response?.data?.statuses;
  return Array.isArray(statuses) && statuses.length > 0 ? statuses[0] : null;
}

/** HL-style per-order status in a raw result: error → definite rejection; 0 fill → definite. */
function checkVenueStatus(venue: string, what: string, raw: unknown): void {
  const st = firstVenueStatus(raw);
  if (st === null) return;
  if (st.error) throw new PerpError("ORDER_REJECTED", `${venue} ${what}: ${String(st.error)}`, { exchange: venue });
  const filled = st.filled as { totalSz?: string } | undefined;
  if (st.resting === undefined && filled !== undefined && Number(filled.totalSz ?? 0) === 0) {
    throw new PerpError("ORDER_REJECTED", `${venue} ${what}: 0 fill`, { exchange: venue });
  }
}

export async function placePerpVerified(
  adapter: ExchangeAdapter,
  venue: string,
  symbol: string,
  side: "buy" | "sell",
  size: string,
  opts: {
    reduceOnly?: boolean;
    /**
     * Sends the order instead of adapter.marketOrder (e.g. an IOC limit from smartOrder).
     * It must place exactly `side` `size` `symbol` (reduce-only when opts.reduceOnly);
     * the fill is measured the same way.
     */
    place?: () => Promise<unknown>;
    /** Slippage bound for adapter.marketOrder; omitted → resolveSlippage(venue, null) (bot/arb paths). */
    slippage?: ResolvedSlippage;
    /** Market lot step when known: fill comparisons tolerate half a lot (else float-noise epsilon). */
    stepSize?: string | null;
  } = {},
): Promise<PerpFill> {
  const what = `perp ${side} ${size} ${symbol}${opts.reduceOnly ? " (reduce-only)" : ""}`;
  const requested = Number(size);
  if (!(requested > 0)) throw new PerpError("INVALID_PARAMS", `${what}: size must be positive`);

  let before: number;
  try {
    before = await signedPerpPosition(adapter, symbol);
  } catch (e) {
    throw orderNotSent(venue, `${what} (pre-order position read failed)`, e);
  }

  /** Base units moved in the order's direction (null when no fill is observable yet) and the last read position. */
  const measure = async (): Promise<{ moved: number | null; last: number }> => {
    let last = before;
    for (const delay of POLL_DELAYS_MS) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      last = await signedPerpPosition(adapter, symbol);
      const moved = side === "buy" ? last - before : before - last;
      if (moved >= requested * MIN_FILL_RATIO) return { moved: Math.min(moved, requested), last };
      if (opts.reduceOnly && moved > 0 && Math.abs(last) < requested * 1e-6) return { moved, last }; // flattened a smaller position
    }
    return { moved: null, last };
  };

  let raw: unknown;
  try {
    raw = opts.place !== undefined
      ? await opts.place()
      : await adapter.marketOrder(symbol, side, size, { reduceOnly: opts.reduceOnly === true, slippage: opts.slippage ?? resolveAdapterSlippage(adapter, null) });
  } catch (e) {
    if (isDefiniteOrderFailure(e)) {
      if (opts.reduceOnly === true && e instanceof PerpError && e.structured.code === "POSITION_NOT_FOUND") {
        // The adapter read the position, found none and sent nothing (QFEX; details.sent === false):
        // the same typed "nothing to reduce" as below (isPositionGone()) — no poll, no quarantine.
        throw new PerpError("ORDER_REJECTED", `${venue} ${what}: ${e.message} (no ${symbol} position to reduce)`, { exchange: venue, reduceOnlyFlat: true });
      }
      throw e;
    }
    // Not a typed rejection → the order may have been placed: measure, never assume.
    let m: { moved: number | null; last: number };
    try {
      m = await measure();
    } catch (readErr) {
      throw orderOutcomeUnknown(venue, what, e, `Do NOT resubmit — check the ${venue} ${symbol} position (position read also failed: ${readErr instanceof Error ? readErr.message : String(readErr)})`);
    }
    if (m.moved !== null) return { filledSize: m.moved, raw: null };
    const postSend = e instanceof PerpError || isTransportFailure(e) || isUnknownOutcomeServerError(e);
    const flat = (n: number) => Math.abs(n) < requested * 1e-6;
    const lot = !postSend ? /not a multiple of lot size (\d+(?:\.\d+)?)/.exec(extractErrorMessage(e)) : null;
    if (lot !== null && flat(m.last - before)) {
      // Venue lot-size validation rejection (e.g. Pacifica 4xx) and the position did not move: not placed.
      throw new PerpError("ORDER_REJECTED", `${venue} ${what}: ${extractErrorMessage(e)}`, { exchange: venue, lotSize: Number(lot[1]) });
    }
    if (opts.reduceOnly && !postSend && flat(before) && flat(m.last)) {
      // Reduce-only cannot open a position: flat before and after = nothing happened (position already gone).
      throw new PerpError("ORDER_REJECTED", `${venue} ${what}: ${extractErrorMessage(e)} (no ${symbol} position to reduce)`, { exchange: venue, reduceOnlyFlat: true });
    }
    throw orderOutcomeUnknown(venue, what, e, `Do NOT resubmit — the order may still execute. Check the ${venue} ${symbol} position`);
  }

  // Venue-final IOC outcome: the venue reported what this order filled; nothing more can fill.
  const outcome = isIocOutcomeCapable(adapter) ? adapter.iocOutcomeOf(raw) : null;
  if (outcome !== null) {
    const reported = Number(outcome.filledSize);
    if (!(Number.isFinite(reported) && reported >= 0)) {
      throw orderOutcomeUnknown(venue, what, new Error(`venue reported an unusable final fill "${outcome.filledSize}"`));
    }
    const tol = iocLotTolerance(size, outcome.filledSize, opts.stepSize);
    if (reported > requested + tol) {
      throw orderOutcomeUnknown(venue, what, new Error(`venue reported a final fill of ${outcome.filledSize}, more than the ${size} ordered`));
    }
    let measured = 0;
    let last = before;
    try {
      for (const delay of POLL_DELAYS_MS) {
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        last = await signedPerpPosition(adapter, symbol);
        measured = side === "buy" ? last - before : before - last;
        // 0 reported: keep polling the whole schedule so a lagging fill is still seen.
        if (reported > 0 ? Math.abs(measured - reported) <= tol : measured > tol) break;
      }
    } catch (readErr) {
      throw orderOutcomeUnknown(venue, what, new Error(`venue reported a final fill of ${outcome.filledSize} but the position could not be read: ${readErr instanceof Error ? readErr.message : String(readErr)}`));
    }
    if (reported === 0) {
      if (!(measured > tol)) {
        const venueError = firstVenueStatus(raw)?.error;
        // Reduce-only with the position flat before and after: nothing to reduce (isPositionGone()).
        const flat = (n: number) => Math.abs(n) < requested * 1e-6;
        const gone = opts.reduceOnly === true && flat(before) && flat(last);
        throw new PerpError("ORDER_REJECTED",
          `${venue} ${what}: ${venueError ? String(venueError) : "IOC filled nothing"} (venue-final, position unchanged)${gone ? ` (no ${symbol} position to reduce)` : ""}`,
          { exchange: venue, ...(gone ? { reduceOnlyFlat: true } : {}) });
      }
      process.stderr.write(`[warn] ${venue} ${what}: venue reported a final fill of 0 but the position moved ${measured} — using the measured fill\n`);
      return { filledSize: Math.min(measured, requested), raw };
    }
    if (Math.abs(measured - reported) > tol) {
      throw orderOutcomeUnknown(venue, what, new Error(`venue reported a final fill of ${outcome.filledSize} but the ${symbol} position moved ${measured} (before ${before})`),
        `Do NOT resubmit — check the ${venue} ${symbol} position`);
    }
    return { filledSize: Math.min(reported, requested), raw };
  }

  checkVenueStatus(venue, what, raw);
  let moved: number | null;
  try {
    moved = (await measure()).moved;
  } catch (readErr) {
    throw orderOutcomeUnknown(venue, what, new Error(`order acknowledged but the position could not be read: ${readErr instanceof Error ? readErr.message : String(readErr)}`));
  }
  if (moved === null) {
    throw orderOutcomeUnknown(venue, what, new Error(`order acknowledged but the ${symbol} position did not move (before ${before})`),
      `Do NOT resubmit — the order may be unconfirmed. Check the ${venue} ${symbol} position`);
  }
  return { filledSize: moved, raw };
}

/** Lot size from a definite lot-size rejection (placePerpVerified ORDER_REJECTED details.lotSize), else null. */
export function rejectedLotSize(e: unknown): number | null {
  if (!(e instanceof PerpError) || e.structured.code !== "ORDER_REJECTED") return null;
  const lot = e.structured.details?.lotSize;
  return typeof lot === "number" && lot > 0 ? lot : null;
}

/** true when `e` says the order outcome is unknown (quarantine, never retry / roll back blindly). */
export function isOutcomeUnknown(e: unknown): boolean {
  return e instanceof PerpError && e.structured.code === "ORDER_PENDING";
}

/**
 * Second-leg residual correction: the second leg is sized to the first
 * leg's VERIFIED fill but may itself fill less (≥ 80% measured, or any venue-final partial fill). Reduce the first leg by exactly
 * this trade's excess (firstFilled − secondFilled, floored to `decimals`) — reduce-only,
 * verified, never the venue's whole position. `firstSide` is the side the first leg
 * opened with. Returns the excess closed ("0" when the legs already match). Throws when
 * the correction was rejected or is unverified: the residual is unhedged → the caller
 * quarantines.
 */
export async function trimFirstLegToHedge(
  adapter: ExchangeAdapter,
  venue: string,
  symbol: string,
  firstSide: "buy" | "sell",
  firstFilled: number,
  secondFilled: number,
  decimals: number,
): Promise<string> {
  const excess = fillSizeString(firstFilled - secondFilled, decimals);
  if (!(Number(excess) > 0)) return "0";
  const c = await closePerpVerified(adapter, venue, symbol, firstSide === "buy" ? "sell" : "buy", excess, { decimals });
  if (c.residual > 0) {
    throw new PerpError("ORDER_PARTIAL", `${venue} trim of ${excess} ${symbol} closed ${c.closed}; ${c.residual} left unhedged${c.note !== null ? ` (${c.note})` : ""}`, { exchange: venue });
  }
  return excess;
}

export interface PerpCloseResult {
  /** Base units this call closed (measured, both orders). */
  closed: number;
  /** Base units of the requested close still open on the venue (0 = done). > 0 → the caller quarantines. */
  residual: number;
  /** Why a residual remains (residual close failed / position unreadable), or null. */
  note: string | null;
}

/**
 * Verified reduce-only close of `size` with residual handling. placePerpVerified
 * accepts a ≥ 80% measured fill or any venue-final partial IOC fill (cross-checked); a close must
 * not leave the rest silently open, so:
 *  1. reduce-only close of `size` (opts.place, e.g. a smartOrder IOC, or a market order);
 *  2. if it filled less than `size`, re-read the position: the residual is
 *     min(size − closed, open size in the closed direction), floored to `decimals`;
 *  3. residual > 0 → ONE more verified reduce-only MARKET close of the residual;
 *  4. re-read; whatever is still open is returned as `residual` (never retried again).
 * Errors of the FIRST close propagate unchanged (definite → nothing happened; ORDER_PENDING →
 * unknown). Once the first close moved the position, a failed / unknown residual close or an
 * unreadable position is reported as `residual` (> 0) + `note` — the caller quarantines.
 */
export async function closePerpVerified(
  adapter: ExchangeAdapter,
  venue: string,
  symbol: string,
  side: "buy" | "sell",
  size: string,
  opts: { place?: () => Promise<unknown>; decimals?: number; slippage?: ResolvedSlippage; stepSize?: string | null } = {},
): Promise<PerpCloseResult> {
  const requested = Number(size);
  const dec = opts.decimals ?? sizeDecimalsOf(size);
  const slip = { ...(opts.slippage !== undefined ? { slippage: opts.slippage } : {}), ...(opts.stepSize !== undefined ? { stepSize: opts.stepSize } : {}) };
  const first = await placePerpVerified(adapter, venue, symbol, side, size, { reduceOnly: true, ...slip, ...(opts.place !== undefined ? { place: opts.place } : {}) });
  let closed = first.filledSize;
  /** Residual of this close still open on the venue (closing a long = sell → the long part). */
  const openResidual = async (): Promise<number> => {
    const pos = await signedPerpPosition(adapter, symbol);
    const openInDir = side === "sell" ? Math.max(pos, 0) : Math.max(-pos, 0);
    return Number(fillSizeString(Math.min(requested - closed, openInDir), dec));
  };
  if (closed >= requested * (1 - 1e-6)) return { closed, residual: 0, note: null };
  let residual: number;
  try {
    residual = await openResidual();
  } catch (e) {
    return { closed, residual: Number(fillSizeString(requested - closed, dec)), note: `position unreadable after a partial close: ${extractErrorMessage(e)}` };
  }
  if (!(residual > 0)) return { closed, residual: 0, note: null };
  const resStr = fillSizeString(residual, dec);
  try {
    closed += (await placePerpVerified(adapter, venue, symbol, side, resStr, { reduceOnly: true, ...slip })).filledSize;
  } catch (e) {
    return { closed, residual, note: `residual close of ${resStr} ${isOutcomeUnknown(e) ? "unconfirmed" : "failed"}: ${extractErrorMessage(e)}` };
  }
  if (closed >= requested * (1 - 1e-6)) return { closed, residual: 0, note: null };
  try {
    residual = await openResidual();
  } catch (e) {
    return { closed, residual: Number(fillSizeString(requested - closed, dec)), note: `position unreadable after the residual close: ${extractErrorMessage(e)}` };
  }
  return { closed, residual, note: residual > 0 ? `residual close of ${resStr} filled partially` : null };
}
