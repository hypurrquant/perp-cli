/**
 * Spot-Perp Executor — handles ALL exchange interactions for spot-perp arbitrage.
 *
 * Stateless except for spot adapter cache. Never makes trading decisions.
 * Strategy calls executor methods; executor handles error recovery / rollback.
 */

import type { ExchangeAdapter } from "../../exchanges/index.js";
import type { SpotAdapter } from "../../exchanges/spot-interface.js";
import { logExecution } from "../../execution-log.js";
import { invalidateCache } from "../../cache.js";
import { checkSpotPerpLiquidity } from "../../liquidity.js";
import { computeSpotPerpMatchedSize } from "../../arb-sizing.js";
import { findSpotQuoteBalance, getBotSpotAdapter, spotNetworkOf, spotTokenBase } from "../../exchanges/spot-factory.js";
import { getVenue } from "../../exchanges/venue.js";
import { PerpError } from "../../errors.js";
import { fillSizeString, readSpotBalancesFresh, sizeDecimalsOf, spotLotStepOf, spotMarketFill, type SpotFill } from "../../exchanges/spot-result.js";
import { floorToStep, lotStepOf } from "../../exchanges/precision.js";
import type { SpotBalance } from "../../exchanges/spot-interface.js";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified, type PerpCloseResult } from "../perp-order.js";
import {
  transferUsdcToSpot, transferUsdcToPerp,
  getPerpSymbol, matchSymbol, getPriceEstimate,
  isPositionGone,
} from "./funding-arb-utils.js";

// ── Result types ──

export type ExecutionResult =
  | {
    success: true;
    /** Perp short size (= the hedged spot, on the perp lot grid). */
    size: string;
    notional: number;
    /** Spot base units bought (the verified fill). */
    spotSize: number;
    /** The spot fill's average price; null = the venue reported none. */
    spotAvgPrice: number | null;
    /** The venue's entry price of the perp short after the hedge; null = not readable. */
    perpEntryPrice: number | null;
  }
  | {
    success: false;
    error: string;
    /** true = outcome unknown or a leg left unhedged: the caller must quarantine the symbol (no retry). */
    manual?: boolean;
  };

/**
 * closed = position fully closed; remainingSize = partially closed, this size is still open (hedged).
 * manual = the outcome is unknown / unverified or a leg is unhedged: the caller must quarantine
 * the position and never retry it automatically.
 */
export type CloseResult =
  | { closed: true; remainingSize: null; manual: false }
  | { closed: false; remainingSize: string | null; manual: false }
  | { closed: false; remainingSize: null; manual: true; reason: string };

/** Rotation outcome (ok: the venue's entry price of the new short, null = not readable); manual = a leg's state is unknown or unhedged: the caller must quarantine. */
export type RotationResult =
  | { ok: true; entryPrice: number | null }
  | { ok: false; manual: false }
  | { ok: false; manual: true; reason: string };

// ── Executor ──

export class SpotPerpExecutor {
  /** Spot adapter for a bot spot venue (factory-cached); null outside the bot spot scope. */
  async getSpotAdapter(name: string, adapter: ExchangeAdapter): Promise<SpotAdapter | null> {
    return getBotSpotAdapter(name, adapter);
  }

  /** Transfer the spot quote asset perp -> spot. false = shared margin (nothing moved). */
  async transferToSpot(spotAdapter: SpotAdapter, amount: number): Promise<boolean> {
    return transferUsdcToSpot(spotAdapter, amount);
  }

  /** Transfer the spot quote asset spot -> perp. false = shared margin (nothing moved). */
  async transferToPerp(spotAdapter: SpotAdapter, amount: number): Promise<boolean> {
    return transferUsdcToPerp(spotAdapter, amount);
  }

  /** Rollback transfer spot → perp: failure is logged loudly (funds remain in spot), never swallowed. */
  private async returnToPerp(spotAdapter: SpotAdapter, amount: number, spotExchange: string, log: (msg: string) => void): Promise<void> {
    try {
      if (await transferUsdcToPerp(spotAdapter, amount)) log(`  [SPA] Recovered $${amount} back to perp`);
    } catch (err) {
      log(`  [SPA] WARNING: $${amount} left in ${spotExchange} spot — transfer back to perp failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // isPositionGone() is now in funding-arb-utils.ts

  /**
   * Full spot-perp entry flow:
   * 1. Check liquidity
   * 2. Compute matched size
   * 3. Set leverage on perp
   * 4. Transfer USDC to spot (only the shortfall, track actual transferred)
   * 5. Buy spot
   * 6. Short perp
   * 7. Verify positions
   * On failure: rollback all completed steps.
   */
  async openPosition(params: {
    symbol: string;
    perpSymbol: string;
    spotExchange: string;
    perpExchange: string;
    spotAdapter: SpotAdapter;
    perpAdapter: ExchangeAdapter;
    sizeUsd: number;
    leverage: number;
    log: (msg: string) => void;
  }): Promise<ExecutionResult> {
    const { symbol, perpSymbol, spotExchange, perpExchange, spotAdapter, perpAdapter, sizeUsd, leverage, log } = params;

    try {
      // Set leverage
      try {
        await perpAdapter.setLeverage(perpSymbol, leverage, "cross");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] setLeverage failed: ${msg}`);
        return { success: false, error: `setLeverage: ${msg}` };
      }

      // Price estimate
      const price = await getPriceEstimate(perpAdapter, perpSymbol, symbol);
      if (price <= 0) return { success: false, error: "price <= 0" };

      // Liquidity check
      const liq = await checkSpotPerpLiquidity(spotAdapter, perpAdapter, symbol, perpSymbol, sizeUsd, 0.5, (msg) => log(`  ${msg}`));
      if (!liq.viable) return { success: false, error: "liquidity not viable" };

      // Compute matched size
      const spotMarkets = await spotAdapter.getSpotMarkets();
      const spotDec = spotMarkets.find(m => m.baseToken.toUpperCase() === symbol.toUpperCase())?.sizeDecimals;
      const perpMarkets = await perpAdapter.getMarkets();
      const perpMarket = perpMarkets.find(m => matchSymbol(m.symbol, perpSymbol) || matchSymbol(m.symbol, symbol));
      let perpDec: number | undefined;
      if (perpMarket !== undefined) {
        // Venue listed the market but did not publish its size precision — sizing would be a guess.
        if (perpMarket.sizeDecimals === null) {
          log(`  [SPA] Skip ${symbol}: ${perpExchange} does not publish sizeDecimals for ${perpMarket.symbol}`);
          return { success: false, error: "perp sizeDecimals unknown" };
        }
        perpDec = perpMarket.sizeDecimals;
      }
      const matched = computeSpotPerpMatchedSize(liq.adjustedSizeUsd, price, spotExchange, perpExchange, spotDec, perpDec);
      if (!matched) {
        log(`  [SPA] Skip ${symbol}: matched size fail (spotDec=${spotDec}, perpDec=${perpDec}, price=${price.toFixed(2)}, sizeUsd=${liq.adjustedSizeUsd.toFixed(2)})`);
        return { success: false, error: "matched size fail" };
      }

      log(`  [SPA] Opening: ${matched.size} ${symbol} ($${matched.notional.toFixed(0)}) ${spotExchange}-spot<>${perpExchange}`);

      // Lot steps from the venue market info: the hedge is floored to the perp lot and every fill is
      // judged with a half-lot tolerance. Unknown → stop before any transfer / order (Rule #2).
      let perpStep: string;
      let spotStep: string;
      try {
        perpStep = await lotStepOf(perpAdapter, perpSymbol);
        spotStep = await spotLotStepOf(spotAdapter, symbol);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] Skip ${symbol}: lot step unknown (${msg})`);
        return { success: false, error: `lot step: ${msg}` };
      }

      // Transfer USDC to spot account — only transfer the shortfall, track actual amount
      const tAmt = Math.ceil(matched.notional * 1.02);
      const spotDef = getVenue(spotExchange);
      const quoteBal = findSpotQuoteBalance(spotDef, spotNetworkOf(spotAdapter), await spotAdapter.getSpotBalances());
      const spotUsdcAvailable = quoteBal ? parseFloat(quoteBal.available) : 0;

      let actualTransferred = 0;
      if (spotUsdcAvailable >= tAmt) {
        log(`  [SPA] Spot already has $${spotUsdcAvailable.toFixed(2)} ${quoteBal?.token ?? ""}, skipping transfer`);
      } else {
        const want = Math.ceil(tAmt - spotUsdcAvailable);
        try {
          if (await transferUsdcToSpot(spotAdapter, want)) {
            actualTransferred = want;
            log(`  [SPA] Transferred $${actualTransferred} to ${spotExchange} spot`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`  [SPA] USDC transfer to spot failed: ${msg}`);
          return { success: false, error: `transfer: ${msg}` };
        }
      }

      // Pre-trade base balance: the post-buy check measures the DELTA, not the total
      // (pre-existing holdings must not count as "bought"). A failed read aborts before buying.
      let preBase: number;
      try {
        preBase = await this.baseBalance(spotAdapter, symbol);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] Pre-trade ${symbol} balance read failed: ${msg} — aborting before the spot buy`);
        if (actualTransferred > 0) await this.returnToPerp(spotAdapter, actualTransferred, spotExchange, log);
        return { success: false, error: `pre-trade balance: ${msg}` };
      }

      // Step 1: Buy spot — the hedge is sized to what actually filled
      let fill: SpotFill;
      try {
        fill = await spotMarketFill(spotAdapter, symbol, "buy", matched.size, spotStep);
        if (fill.status === "partial") log(`  [SPA] Spot buy partial: ${fill.filledSize} of ${matched.size} ${symbol} — hedging the filled size`);
        logExecution({ type: "arb_entry", exchange: `${spotExchange}-spot`, symbol, side: "buy", size: String(fill.filledSize), notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "spot", fillStatus: fill.status, requestedSize: matched.size } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] Spot buy failed: ${msg}`);
        if (err instanceof PerpError && err.structured.code === "ORDER_PENDING") {
          // Outcome unknown: the quote may be spent — do not move funds back or retry.
          log(`  [SPA] CRITICAL: spot buy ${symbol} on ${spotExchange} is PENDING — no perp hedge placed. Verify the spot balance manually; do NOT resubmit.`);
          return { success: false, error: `spot buy ${matched.size} on ${spotExchange} pending (no perp hedge placed): ${msg}`, manual: true };
        }
        if (actualTransferred > 0) {
          await this.returnToPerp(spotAdapter, actualTransferred, spotExchange, log);
        }
        return { success: false, error: `spot buy: ${msg}` };
      }

      // Step 1b: Verify the buy by balance delta vs the pre-trade balance. A failed
      // verification STOPS (no perp short on an unverified spot leg).
      const hedgeSize = floorToStep(fill.filledSize, perpStep);
      try {
        const delta = (await this.baseBalance(spotAdapter, symbol)) - preBase;
        if (delta < fill.filledSize * 0.8) {
          log(`  [SPA] CRITICAL: spot buy reported ${fill.filledSize} ${symbol} but the balance rose only ${delta.toFixed(6)} — no perp hedge placed; verify ${spotExchange} spot manually`);
          return { success: false, error: `spot buy reported ${fill.filledSize} but the balance rose only ${delta.toFixed(6)} (no perp hedge placed)`, manual: true };
        }
      } catch (err) {
        log(`  [SPA] CRITICAL: post-buy balance check failed (${err instanceof Error ? err.message : String(err)}) — stopping: ${fill.filledSize} ${symbol} spot is unhedged; verify manually`);
        return { success: false, error: `post-buy balance check failed — ${fill.filledSize} spot unhedged`, manual: true };
      }
      if (!(Number(hedgeSize) > 0)) {
        log(`  [SPA] CRITICAL: spot buy ${symbol} filled only dust (${fill.filledSize}, below one ${perpExchange} lot ${perpStep}) — unhedged spot remains on ${spotExchange}`);
        return { success: false, error: `spot fill ${fill.filledSize} below one perp lot (${perpStep}) — unhedged spot remains`, manual: true };
      }

      // Step 2: Short perp (filled size only), verified by the position delta.
      try {
        const pf = await placePerpVerified(perpAdapter, perpExchange, perpSymbol, "sell", hedgeSize, { stepSize: perpStep });
        logExecution({ type: "arb_entry", exchange: perpExchange, symbol, side: "sell", size: hedgeSize, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "perp", measuredFill: pf.filledSize } });
        // An accepted partial short (≥ 80% measured, or a venue-final partial IOC fill) leaves
        // part of the spot unhedged: never resubmit — stop for a human (caller quarantines).
        const shorted = floorToStep(pf.filledSize, perpStep);
        if (Number(shorted) < Number(hedgeSize)) {
          log(`  [SPA] CRITICAL: perp short filled ${shorted} of ${hedgeSize} ${symbol} on ${perpExchange} — ${floorToStep(Number(hedgeSize) - Number(shorted), perpStep)} spot unhedged`);
          return { success: false, error: `perp short filled ${shorted} of ${hedgeSize} on ${perpExchange}; ${hedgeSize} ${symbol} spot held on ${spotExchange} — spot partly unhedged`, manual: true };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isOutcomeUnknown(err)) {
          // The short may exist: selling the spot now could leave a naked short. Stop.
          log(`  [SPA] CRITICAL: perp short ${hedgeSize} ${symbol} on ${perpExchange} outcome unknown — spot NOT rolled back`);
          return { success: false, error: `perp short outcome unknown (${msg}); ${hedgeSize} ${symbol} spot held on ${spotExchange} — verify the ${perpExchange} position, do NOT resubmit`, manual: true };
        }
        log(`  [SPA] Perp short failed: ${msg} -- ROLLING BACK spot`);
        try {
          const rb = await spotMarketFill(spotAdapter, symbol, "sell", hedgeSize, spotStep);
          logExecution({ type: "multi_leg_rollback", exchange: `${spotExchange}-spot`, symbol, side: "sell", size: String(rb.filledSize), status: rb.status === "partial" ? "failed" : "success", dryRun: false });
          if (rb.status === "partial") {
            log(`  [SPA] CRITICAL: spot rollback sold only ${rb.filledSize} of ${hedgeSize} ${symbol} — unhedged spot remains`);
            return { success: false, error: `perp short failed (${msg}); rollback sold only ${rb.filledSize} of ${hedgeSize} — unhedged spot remains`, manual: true };
          }
          if (actualTransferred > 0) await this.returnToPerp(spotAdapter, actualTransferred, spotExchange, log);
        } catch (rbErr) {
          const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
          log(`  [SPA] CRITICAL: Spot rollback failed: ${rbMsg}`);
          return { success: false, error: `perp short failed (${msg}); spot rollback failed (${rbMsg}) — unhedged spot ${hedgeSize} remains`, manual: true };
        }
        return { success: false, error: `perp short: ${msg}` };
      }

      // Position verification (+ the venue's entry price of the short, recorded in the arb state)
      invalidateCache("acct");
      let perpEntryPrice: number | null = null;
      try {
        const perpPositions = await perpAdapter.getPositions();
        const perpPos = perpPositions.find(x => matchSymbol(x.symbol, perpSymbol) && parseFloat(x.size) !== 0);
        if (!perpPos) {
          log(`  [SPA] WARNING: Perp position not visible (cache delay?)`);
        } else {
          const px = Number(perpPos.entryPrice);
          perpEntryPrice = Number.isFinite(px) && px > 0 ? px : null;
        }
      } catch (err) { log(`  [SPA] Verify error: ${err instanceof Error ? err.message : String(err)}`); }

      return { success: true, size: hedgeSize, notional: matched.notional, spotSize: fill.filledSize, spotAvgPrice: fill.avgPrice, perpEntryPrice };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  [SPA] Open failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Full spot-perp close flow:
   * 1. Close perp short FIRST (reduceOnly) — hedge stays intact if this fails
   * 2. Sell spot
   * 3. Transfer USDC back to perp (always, not just same-exchange)
   *
   * Returns `manual: true` (caller quarantines, never retries) when the spot outcome is
   * unknown (pending sell, failed post-trade verification) or spot is left unhedged.
   * A perp short is re-opened only when THIS call closed it; if the perp was already
   * gone and spot cannot be sold, nothing new is opened — the position is quarantined.
   */
  async closePosition(params: {
    symbol: string;
    spotExchange: string;
    perpExchange: string;
    spotAdapter: SpotAdapter;
    perpAdapter: ExchangeAdapter;
    size: string;
    log: (msg: string) => void;
  }): Promise<CloseResult> {
    const { symbol, spotExchange, perpExchange, spotAdapter, perpAdapter, size, log } = params;
    const perpSym = getPerpSymbol(symbol, perpExchange);
    const notClosed: CloseResult = { closed: false, remainingSize: null, manual: false };
    const manual = (reason: string): CloseResult => {
      log(`  [SPA] CRITICAL: ${symbol} ${spotExchange}-spot<>${perpExchange} needs manual action — ${reason}`);
      return { closed: false, remainingSize: null, manual: true, reason };
    };

    try {
      // Pre-trade base + quote balances (post-sell delta check, proceeds sweep); read before anything moves.
      let preBase: number;
      let preQuote: number;
      try {
        const pre = await readSpotBalancesFresh(spotAdapter);
        preBase = this.baseOf(spotAdapter, pre, symbol);
        preQuote = this.quoteOf(spotExchange, spotAdapter, pre);
      } catch (err) {
        log(`  [SPA] Pre-close ${symbol} balance read failed: ${err instanceof Error ? err.message : String(err)} — close not started`);
        return notClosed;
      }

      // Step 1: Close perp short FIRST (reduceOnly, verified, one residual close) — if this fails, hedge is still intact
      const dec = sizeDecimalsOf(size);
      let perpClosedHere = false;
      /** Base units of the short this call closed (measured). */
      let perpClosed = 0;
      /** Set when the perp close left a residual short open (after one residual close). */
      let perpResidual: PerpCloseResult | null = null;
      try {
        const pc = await closePerpVerified(perpAdapter, perpExchange, perpSym, "buy", size);
        perpClosedHere = true;
        perpClosed = Math.min(pc.closed, Number(size));
        if (pc.residual > 0) perpResidual = pc;
        logExecution({ type: "arb_close", exchange: perpExchange, symbol, side: "buy", size, status: pc.residual > 0 ? "failed" : "success", dryRun: false, meta: { mode: "spot-perp", measuredClose: pc.closed, residual: pc.residual } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isOutcomeUnknown(err)) {
          return manual(`perp close ${size} on ${perpExchange} outcome unknown (${msg}); spot not sold — verify the perp position, do NOT resubmit`);
        }
        // ReduceOnly rejected = position already gone, proceed to sell spot
        if (isPositionGone(err)) {
          log(`  [SPA] Perp already closed (ReduceOnly rejected)`);
        } else {
          log(`  [SPA] Perp close failed, hedge intact: ${msg}`);
          return notClosed;
        }
      }

      // Step 2: Sell spot — sized to the VERIFIED perp close when a perp residual remains
      // (the unsold spot then still hedges the residual short; quarantined below).
      const sellSize = perpResidual === null ? size : fillSizeString(perpClosed, dec);
      const closedStr = fillSizeString(perpClosed, dec);
      const residualNote = perpResidual === null ? "" : `perp close on ${perpExchange} closed ${closedStr} of ${size}, ${perpResidual.residual} short still open${perpResidual.note !== null ? ` (${perpResidual.note})` : ""}`;
      if (perpResidual !== null) {
        log(`  [SPA] ${residualNote} — selling only ${sellSize} spot`);
        if (!(Number(sellSize) > 0)) return manual(`${residualNote}; spot not sold`);
      }
      let fill: SpotFill;
      try {
        fill = await spotMarketFill(spotAdapter, symbol, "sell", sellSize);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof PerpError && err.structured.code === "ORDER_PENDING") {
          // The sell may still execute: re-hedging now could leave a naked short.
          return manual(`spot sell ${sellSize} is PENDING (${msg}); perp is closed — verify ${spotExchange} spot, do NOT resubmit`);
        }
        if (!perpClosedHere) {
          // The perp was already gone before this call: opening a new short here is not a
          // rollback, it is a new position. Leave it to a human.
          return manual(`spot sell ${size} failed (${msg}) and the perp short was already gone — ${size} spot is unhedged`);
        }
        // Definite spot failure (nothing sold): restore the short this call closed (measured), verified.
        log(`  [SPA] Spot sell failed: ${msg} -- re-opening perp hedge ${closedStr}`);
        try {
          const rh = await placePerpVerified(perpAdapter, perpExchange, perpSym, "sell", closedStr);
          if (rh.filledSize < Number(closedStr) * (1 - 1e-6)) {
            return manual(`spot sell failed (${msg}); the perp re-hedge filled ${rh.filledSize} of ${closedStr} — spot partly unhedged`);
          }
        } catch (rbErr) {
          return manual(`spot sell failed (${msg}) and the perp re-hedge failed or is unconfirmed (${rbErr instanceof Error ? rbErr.message : String(rbErr)}) — ${closedStr} spot may be unhedged`);
        }
        if (perpResidual !== null) return manual(`${residualNote}; spot sell failed (${msg}) and the closed part was re-hedged`);
        return notClosed;
      }

      // Step 2b: Verify the sell by a fresh balance delta vs the pre-trade balance; a failed check stops.
      try {
        const sold = preBase - this.baseOf(spotAdapter, await readSpotBalancesFresh(spotAdapter), symbol);
        if (sold < fill.filledSize * 0.8) {
          return manual(`spot sell reported ${fill.filledSize} but the balance fell only ${sold.toFixed(6)}; perp is closed — verify ${spotExchange} spot`);
        }
      } catch (err) {
        return manual(`post-sell balance check failed (${err instanceof Error ? err.message : String(err)}); perp is closed — verify ${spotExchange} spot`);
      }

      // Partial sell: re-hedge the unsold remainder so it stays a hedged position.
      let remainingSize: string | null = null;
      if (fill.status === "partial") {
        const remaining = fillSizeString(Number(sellSize) - fill.filledSize, dec);
        if (Number(remaining) > 0) {
          log(`  [SPA] Spot sell partial: ${fill.filledSize} of ${sellSize} ${symbol} — re-hedging the remaining ${remaining}`);
          try {
            const rh = await placePerpVerified(perpAdapter, perpExchange, perpSym, "sell", remaining);
            if (rh.filledSize < Number(remaining) * (1 - 1e-6)) {
              return manual(`spot sell partial (${fill.filledSize} of ${sellSize}); re-hedge of the unsold ${remaining} filled ${rh.filledSize} — spot partly unhedged`);
            }
            remainingSize = remaining;
          } catch (rbErr) {
            return manual(`re-hedge of the unsold ${remaining} failed or is unconfirmed (${rbErr instanceof Error ? rbErr.message : String(rbErr)}) — unhedged spot may remain`);
          }
        }
      }

      // Step 3: Transfer THIS sale's proceeds back to perp (quote delta since the pre-close
      // read — never quote that was already in spot, e.g. another position's funds).
      try {
        const postQuote = this.quoteOf(spotExchange, spotAdapter, await readSpotBalancesFresh(spotAdapter));
        const proceeds = Math.floor(Math.min(postQuote, postQuote - preQuote));
        if (proceeds > 1 && await transferUsdcToPerp(spotAdapter, proceeds)) {
          log(`  [SPA] Transferred $${proceeds} (sale proceeds) back to perp`);
        }
      } catch (err) {
        // Non-fatal for the close (both legs are done), but surfaced: proceeds remain in spot.
        log(`  [SPA] WARNING: spot→perp transfer after close failed on ${spotExchange}: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (perpResidual !== null) {
        return manual(`${residualNote}; spot sold ${fill.filledSize} — the rest (${fillSizeString(Number(size) - fill.filledSize, dec)} spot vs the residual short) needs a manual check`);
      }
      return remainingSize === null ? { closed: true, remainingSize: null, manual: false } : { closed: false, remainingSize, manual: false };
    } catch (err) {
      log(`  [SPA] Close failed: ${err instanceof Error ? err.message : String(err)}`);
      return notClosed;
    }
  }

  /** Base-token balance (total), read UNCACHED; a token with no balance row holds 0. Errors propagate. */
  private async baseBalance(spotAdapter: SpotAdapter, symbol: string): Promise<number> {
    return this.baseOf(spotAdapter, await readSpotBalancesFresh(spotAdapter), symbol);
  }

  private baseOf(spotAdapter: SpotAdapter, balances: SpotBalance[], symbol: string): number {
    const row = balances.find(b => spotTokenBase(b.token) === symbol.toUpperCase());
    if (row === undefined) return 0;
    const n = parseFloat(row.total);
    if (!Number.isFinite(n)) throw new Error(`${spotAdapter.name} ${symbol} balance is not a number: ${row.total}`);
    return n;
  }

  /** Spot quote total (0 when shared with perp margin — nothing to move, or no quote row). */
  private quoteOf(spotExchange: string, spotAdapter: SpotAdapter, balances: SpotBalance[]): number {
    const quoteBal = findSpotQuoteBalance(getVenue(spotExchange), spotNetworkOf(spotAdapter), balances);
    if (!quoteBal || quoteBal.shared) return 0;
    const n = parseFloat(quoteBal.total);
    if (!Number.isFinite(n)) throw new Error(`${spotExchange} spot ${quoteBal.token} balance is not a number: ${quoteBal.total}`);
    return n;
  }

  /**
   * Rotate perp short to better exchange (spot stays unchanged):
   * 1. Set leverage on new exchange
   * 2. Close current perp short (reduceOnly, verified)
   * 3. Open new perp short on new exchange (verified)
   * 4. If the new short definitely failed: re-open the old short (verified)
   * Any leg whose outcome is unknown, or a failed rollback, returns manual (quarantine):
   * retrying could double-short or leave the spot unhedged.
   */
  async rotateShort(params: {
    symbol: string;
    perpSymbol: string;
    currentExchange: string;
    newExchange: string;
    currentAdapter: ExchangeAdapter;
    newAdapter: ExchangeAdapter;
    size: string;
    leverage: number;
    log: (msg: string) => void;
  }): Promise<RotationResult> {
    const { symbol, currentExchange, newExchange, currentAdapter, newAdapter, size, leverage, log } = params;
    const oldSym = getPerpSymbol(symbol, currentExchange);
    const newSym = getPerpSymbol(symbol, newExchange);
    const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

    // Set leverage on new exchange
    try {
      await newAdapter.setLeverage(newSym, leverage, "cross");
    } catch (err) {
      log(`  [SPA] Rotation setLeverage failed: ${errText(err)}`);
      return { ok: false, manual: false };
    }

    // Close old short (reduce-only, verified, one residual close)
    const dec = sizeDecimalsOf(size);
    let closed: string;
    try {
      const oc = await closePerpVerified(currentAdapter, currentExchange, oldSym, "buy", size);
      closed = fillSizeString(Math.min(oc.closed, Number(size)), dec);
      if (oc.residual > 0) {
        logExecution({ type: "arb_close", exchange: currentExchange, symbol, side: "buy", size, status: "failed", error: `closed ${closed}, residual ${oc.residual}`, dryRun: false, meta: { rotation: true } });
        return { ok: false, manual: true, reason: `rotation close of the ${currentExchange} short closed ${closed} of ${size}, ${oc.residual} still open${oc.note !== null ? ` (${oc.note})` : ""} — no new short placed; ${closed} spot unhedged` };
      }
      logExecution({ type: "arb_close", exchange: currentExchange, symbol, side: "buy", size, status: "success", dryRun: false, meta: { rotation: true, measuredClose: oc.closed } });
    } catch (err) {
      if (isOutcomeUnknown(err)) {
        return { ok: false, manual: true, reason: `rotation close of the ${currentExchange} short ${size} outcome unknown (${errText(err)}) — verify the ${currentExchange} position` };
      }
      log(`  [SPA] Rotation close failed: ${errText(err)}`);
      return { ok: false, manual: false };
    }

    // Open new short sized to the VERIFIED close
    try {
      const nf = await placePerpVerified(newAdapter, newExchange, newSym, "sell", closed);
      logExecution({ type: "arb_entry", exchange: newExchange, symbol, side: "sell", size: closed, status: "success", dryRun: false, meta: { rotation: true, measuredFill: nf.filledSize } });
      if (nf.filledSize < Number(closed) * (1 - 1e-6) || Number(closed) < Number(size)) {
        // Accepted partial fill (or a smaller old short): the spot is no longer fully hedged — never resubmit.
        return { ok: false, manual: true, reason: `rotation: new ${newExchange} short filled ${nf.filledSize} of ${closed} (old ${currentExchange} short closed ${closed} of ${size}) — spot ${size} ${symbol} partly unhedged` };
      }
    } catch (err) {
      const msg = errText(err);
      if (isOutcomeUnknown(err)) {
        // The new short may exist: re-opening the old one could double-short.
        return { ok: false, manual: true, reason: `rotation: new ${newExchange} short ${closed} outcome unknown (${msg}); the ${currentExchange} short is closed — spot may be unhedged or double-hedged` };
      }
      log(`  [SPA] Rotation new short failed: ${msg} -- rolling back`);
      try {
        const rb = await placePerpVerified(currentAdapter, currentExchange, oldSym, "sell", closed);
        if (rb.filledSize < Number(closed) * (1 - 1e-6)) {
          logExecution({ type: "multi_leg_rollback", exchange: currentExchange, symbol, side: "sell", size: closed, status: "failed", error: `re-opened ${rb.filledSize} of ${closed}`, dryRun: false });
          return { ok: false, manual: true, reason: `rotation: new ${newExchange} short failed (${msg}); re-opening the ${currentExchange} short filled ${rb.filledSize} of ${closed} — spot partly unhedged` };
        }
        log(`  [SPA] Rotation rollback OK`);
        logExecution({ type: "multi_leg_rollback", exchange: currentExchange, symbol, side: "sell", size: closed, status: "success", dryRun: false });
      } catch (rbErr) {
        const rbMsg = errText(rbErr);
        logExecution({ type: "multi_leg_rollback", exchange: currentExchange, symbol, side: "sell", size: closed, status: "failed", error: rbMsg, dryRun: false });
        return { ok: false, manual: true, reason: `rotation: new ${newExchange} short failed (${msg}) and re-opening the ${currentExchange} short failed or is unconfirmed (${rbMsg}) — ${closed} ${symbol} spot may be unhedged` };
      }
      return { ok: false, manual: false };
    }

    // The new short's entry price (arb state); a failed read is reported as unknown.
    let entryPrice: number | null = null;
    try {
      invalidateCache("acct");
      const p = (await newAdapter.getPositions()).find(x => matchSymbol(x.symbol, newSym) && parseFloat(x.size) !== 0);
      const px = Number(p?.entryPrice);
      entryPrice = Number.isFinite(px) && px > 0 ? px : null;
    } catch (err) { log(`  [SPA] Rotation: ${newExchange} entry price unreadable (${errText(err)})`); }
    return { ok: true, entryPrice };
  }
}
