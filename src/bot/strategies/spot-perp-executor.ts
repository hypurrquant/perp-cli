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
import {
  getSpotAdapter as getSpotAdapterUtil,
  transferUsdcToSpot, transferUsdcToPerp,
  getPerpSymbol, matchSymbol, getPriceEstimate,
  isPositionGone,
} from "./funding-arb-utils.js";

// ── Result types ──

export interface ExecutionResult {
  success: boolean;
  size?: string;
  notional?: number;
  error?: string;
}

// ── Executor ──

export class SpotPerpExecutor {
  private _spotAdapterCache = new Map<string, SpotAdapter>();

  /** Get or create cached spot adapter. */
  async getSpotAdapter(name: string, adapter: ExchangeAdapter): Promise<SpotAdapter | null> {
    const cached = this._spotAdapterCache.get(name);
    if (cached) return cached;
    const spot = await getSpotAdapterUtil(name, adapter);
    if (spot) this._spotAdapterCache.set(name, spot);
    return spot;
  }

  /** Transfer USDC: perp -> spot account. */
  async transferToSpot(spotAdapter: SpotAdapter, exchange: string, amount: number): Promise<void> {
    await transferUsdcToSpot(spotAdapter, exchange, amount);
  }

  /** Transfer USDC: spot -> perp account. */
  async transferToPerp(spotAdapter: SpotAdapter, exchange: string, amount: number): Promise<void> {
    await transferUsdcToPerp(spotAdapter, exchange, amount);
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
      const perpDec = perpMarkets.find(m => matchSymbol(m.symbol, perpSymbol) || matchSymbol(m.symbol, symbol))?.sizeDecimals;
      const matched = computeSpotPerpMatchedSize(liq.adjustedSizeUsd, price, spotExchange, perpExchange, spotDec, perpDec);
      if (!matched) {
        log(`  [SPA] Skip ${symbol}: matched size fail (spotDec=${spotDec}, perpDec=${perpDec}, price=${price.toFixed(2)}, sizeUsd=${liq.adjustedSizeUsd.toFixed(2)})`);
        return { success: false, error: "matched size fail" };
      }

      log(`  [SPA] Opening: ${matched.size} ${symbol} ($${matched.notional.toFixed(0)}) ${spotExchange}-spot<>${perpExchange}`);

      // Transfer USDC to spot account — only transfer the shortfall, track actual amount
      const tAmt = Math.ceil(matched.notional * 1.02);
      let spotUsdcAvailable = 0;
      try {
        const spotBals = await spotAdapter.getSpotBalances();
        const usdcBal = spotBals.find(b => b.token.toUpperCase().startsWith("USDC"));
        spotUsdcAvailable = usdcBal ? parseFloat(usdcBal.available) : 0;
      } catch { /* ignore */ }

      let actualTransferred = 0;
      if (spotUsdcAvailable >= tAmt) {
        log(`  [SPA] Spot already has $${spotUsdcAvailable.toFixed(2)} USDC, skipping transfer`);
      } else {
        actualTransferred = Math.ceil(tAmt - spotUsdcAvailable);
        try {
          await transferUsdcToSpot(spotAdapter, spotExchange, actualTransferred);
          log(`  [SPA] Transferred $${actualTransferred} USDC to ${spotExchange} spot`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`  [SPA] USDC transfer to spot failed: ${msg}`);
          return { success: false, error: `transfer: ${msg}` };
        }
      }

      // Step 1: Buy spot
      try {
        await spotAdapter.spotMarketOrder(symbol, "buy", matched.size);
        logExecution({ type: "arb_entry", exchange: `${spotExchange}-spot`, symbol, side: "buy", size: matched.size, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "spot" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] Spot buy failed: ${msg}`);
        if (actualTransferred > 0) {
          try { await transferUsdcToPerp(spotAdapter, spotExchange, actualTransferred); log(`  [SPA] Recovered $${actualTransferred} USDC back to perp`); } catch { /* best effort */ }
        }
        return { success: false, error: `spot buy: ${msg}` };
      }

      // Step 1b: Verify spot actually bought (safety net for "assuming executed" false positive)
      try {
        invalidateCache("acct");
        const postBals = await spotAdapter.getSpotBalances();
        const bought = postBals.find(b => b.token.toUpperCase().replace(/-SPOT$/, "") === symbol.toUpperCase());
        const boughtAmt = bought ? parseFloat(bought.total) : 0;
        if (boughtAmt < parseFloat(matched.size) * 0.8) {
          log(`  [SPA] Spot buy returned OK but ${symbol} balance too low (${boughtAmt.toFixed(4)} < ${matched.size} × 80%) — aborting`);
          if (actualTransferred > 0) {
            try { await transferUsdcToPerp(spotAdapter, spotExchange, actualTransferred); } catch { /* best effort */ }
          }
          return { success: false, error: "spot buy not confirmed by balance" };
        }
      } catch { /* balance check failed, proceed optimistically */ }

      // Step 2: Short perp
      try {
        await perpAdapter.marketOrder(perpSymbol, "sell", matched.size);
        logExecution({ type: "arb_entry", exchange: perpExchange, symbol, side: "sell", size: matched.size, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "perp" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] Perp short failed: ${msg} -- ROLLING BACK spot`);
        try {
          await spotAdapter.spotMarketOrder(symbol, "sell", matched.size);
          logExecution({ type: "multi_leg_rollback", exchange: `${spotExchange}-spot`, symbol, side: "sell", size: matched.size, status: "success", dryRun: false });
          if (actualTransferred > 0) { try { await transferUsdcToPerp(spotAdapter, spotExchange, actualTransferred); } catch { /* best effort */ } }
        } catch (rbErr) {
          log(`  [SPA] CRITICAL: Spot rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
        return { success: false, error: `perp short: ${msg}` };
      }

      // Position verification
      invalidateCache("acct");
      try {
        const perpPositions = await perpAdapter.getPositions();
        const hasPerp = perpPositions.some(x => matchSymbol(x.symbol, perpSymbol) && parseFloat(x.size) > 0);
        if (!hasPerp) {
          log(`  [SPA] WARNING: Perp position not visible (cache delay?)`);
        }
      } catch (err) { log(`  [SPA] Verify error: ${err instanceof Error ? err.message : String(err)}`); }

      return { success: true, size: matched.size, notional: matched.notional };
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
   */
  async closePosition(params: {
    symbol: string;
    spotExchange: string;
    perpExchange: string;
    spotAdapter: SpotAdapter;
    perpAdapter: ExchangeAdapter;
    size: string;
    log: (msg: string) => void;
  }): Promise<boolean> {
    const { symbol, spotExchange, perpExchange, spotAdapter, perpAdapter, size, log } = params;
    const perpSym = getPerpSymbol(symbol, perpExchange);

    try {
      // Step 1: Close perp short FIRST (reduceOnly) — if this fails, hedge is still intact
      try {
        await perpAdapter.marketOrder(perpSym, "buy", size, { reduceOnly: true });
        logExecution({ type: "arb_close", exchange: perpExchange, symbol, side: "buy", size, status: "success", dryRun: false, meta: { mode: "spot-perp" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ReduceOnly rejected = position already gone, proceed to sell spot
        if (isPositionGone(msg)) {
          log(`  [SPA] Perp already closed (ReduceOnly rejected)`);
        } else {
          log(`  [SPA] Perp close failed, hedge intact: ${msg}`);
          return false;
        }
      }

      // Step 2: Sell spot
      try {
        await spotAdapter.spotMarketOrder(symbol, "sell", size);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] Spot sell failed: ${msg} -- re-opening perp hedge`);
        try { await perpAdapter.marketOrder(perpSym, "sell", size); } catch (rbErr) {
          log(`  [SPA] CRITICAL: Perp re-hedge failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
        return false;
      }

      // Step 2b: Verify spot actually sold (safety net for "assuming executed" false positive)
      try {
        invalidateCache("acct");
        const postBals = await spotAdapter.getSpotBalances();
        const remaining = postBals.find(b => b.token.toUpperCase().replace(/-SPOT$/, "") === symbol.toUpperCase());
        const remainingAmt = remaining ? parseFloat(remaining.total) : 0;
        if (remainingAmt >= parseFloat(size) * 0.8) {
          log(`  [SPA] CRITICAL: Spot sell returned OK but ${symbol} balance unchanged (${remainingAmt.toFixed(4)} >= ${size} × 80%) — re-hedging perp`);
          try { await perpAdapter.marketOrder(perpSym, "sell", size); } catch (rbErr) {
            log(`  [SPA] CRITICAL: Perp re-hedge failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
          }
          return false;
        }
      } catch { /* balance check failed, proceed optimistically */ }

      // Step 3: Transfer USDC back to perp (always — lighter/HL both need this)
      try {
        const spotBals = await spotAdapter.getSpotBalances();
        const usdcBal = spotBals.find(b => b.token.toUpperCase().startsWith("USDC"));
        const usdcAmount = usdcBal ? parseFloat(usdcBal.total) : 0;
        if (usdcAmount > 1) {
          await transferUsdcToPerp(spotAdapter, spotExchange, Math.floor(usdcAmount));
          log(`  [SPA] Transferred $${Math.floor(usdcAmount)} USDC back to perp`);
        }
      } catch { /* non-fatal */ }

      return true;
    } catch (err) {
      log(`  [SPA] Close failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Rotate perp short to better exchange:
   * 1. Set leverage on new exchange
   * 2. Close current perp short (reduceOnly)
   * 3. Open new perp short on new exchange
   * 4. Rollback if new short fails
   * Spot stays unchanged.
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
  }): Promise<boolean> {
    const { symbol, currentExchange, newExchange, currentAdapter, newAdapter, size, leverage, log } = params;
    const oldSym = getPerpSymbol(symbol, currentExchange);
    const newSym = getPerpSymbol(symbol, newExchange);

    // Set leverage on new exchange
    try {
      await newAdapter.setLeverage(newSym, leverage, "cross");
    } catch (err) {
      log(`  [SPA] Rotation setLeverage failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    // Close old short
    try {
      await currentAdapter.marketOrder(oldSym, "buy", size, { reduceOnly: true });
      logExecution({ type: "arb_close", exchange: currentExchange, symbol, side: "buy", size, status: "success", dryRun: false, meta: { rotation: true } });
    } catch (err) {
      log(`  [SPA] Rotation close failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    // Open new short
    try {
      await newAdapter.marketOrder(newSym, "sell", size);
      logExecution({ type: "arb_entry", exchange: newExchange, symbol, side: "sell", size, status: "success", dryRun: false, meta: { rotation: true } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  [SPA] Rotation new short failed: ${msg} -- rolling back`);
      try {
        await currentAdapter.marketOrder(oldSym, "sell", size);
        log(`  [SPA] Rotation rollback OK`);
        logExecution({ type: "multi_leg_rollback", exchange: currentExchange, symbol, side: "sell", size, status: "success", dryRun: false });
      } catch (rbErr) {
        log(`  [SPA] CRITICAL: Rotation rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        logExecution({ type: "multi_leg_rollback", exchange: currentExchange, symbol, side: "sell", size, status: "failed", error: rbErr instanceof Error ? rbErr.message : String(rbErr), dryRun: false });
      }
      return false;
    }

    return true;
  }
}
