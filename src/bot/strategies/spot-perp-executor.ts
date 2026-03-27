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

  /**
   * Full spot-perp entry flow:
   * 1. Check liquidity
   * 2. Compute matched size
   * 3. Set leverage on perp
   * 4. Transfer USDC to spot
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
    const sameExchange = spotExchange === perpExchange;

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
      const matched = computeSpotPerpMatchedSize(liq.adjustedSizeUsd, price, spotExchange, perpExchange, spotDec);
      if (!matched) {
        log(`  [SPA] Skip ${symbol}: matched size fail`);
        return { success: false, error: "matched size fail" };
      }

      log(`  [SPA] Opening: ${matched.size} ${symbol} ($${matched.notional.toFixed(0)}) ${spotExchange}-spot<>${perpExchange}`);

      // Transfer USDC to spot account
      const tAmt = Math.ceil(matched.notional * 1.02);
      try {
        await transferUsdcToSpot(spotAdapter, spotExchange, tAmt);
        log(`  [SPA] Transferred $${tAmt} USDC to ${spotExchange} spot`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] USDC transfer to spot failed: ${msg}`);
        return { success: false, error: `transfer: ${msg}` };
      }

      // Step 1: Buy spot
      try {
        await spotAdapter.spotMarketOrder(symbol, "buy", matched.size);
        logExecution({ type: "arb_entry", exchange: `${spotExchange}-spot`, symbol, side: "buy", size: matched.size, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "spot" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [SPA] Spot buy failed: ${msg}`);
        try { await transferUsdcToPerp(spotAdapter, spotExchange, tAmt); log(`  [SPA] Recovered $${tAmt} USDC back to perp`); } catch { /* best effort */ }
        return { success: false, error: `spot buy: ${msg}` };
      }

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
          if (sameExchange) { try { await transferUsdcToPerp(spotAdapter, spotExchange, Math.ceil(matched.notional * 1.02)); } catch { /* best effort */ } }
        } catch (rbErr) {
          log(`  [SPA] CRITICAL: Spot rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
        return { success: false, error: `perp short: ${msg}` };
      }

      // Position verification
      invalidateCache("acct");
      await new Promise(resolve => setTimeout(resolve, 2000));
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
   * 1. Sell spot
   * 2. Transfer USDC back to perp (same-exchange)
   * 3. Close perp short (reduceOnly)
   * Handle: ReduceOnly rejected (position gone), rollback.
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
      // Step 1: Sell spot
      try {
        await spotAdapter.spotMarketOrder(symbol, "sell", size);
      } catch (err) {
        log(`  [SPA] Spot sell failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }

      // Transfer USDC back (same-exchange)
      if (spotExchange === perpExchange) {
        try {
          const price = await getPriceEstimate(perpAdapter, perpSym, symbol);
          const proceeds = price * parseFloat(size) * 0.95;
          if (proceeds > 1) await transferUsdcToPerp(spotAdapter, spotExchange, Math.floor(proceeds));
        } catch { /* non-fatal */ }
      }

      // Step 2: Close perp short (reduceOnly)
      try {
        await perpAdapter.marketOrder(perpSym, "buy", size, { reduceOnly: true });
        logExecution({ type: "arb_close", exchange: perpExchange, symbol, side: "buy", size, status: "success", dryRun: false, meta: { mode: "spot-perp" } });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Handle ReduceOnly rejected (position already gone)
        if (msg.includes("ReduceOnly") || msg.includes("reduceOnly") || msg.includes("-2022")) {
          log(`  [SPA] Perp already closed (ReduceOnly rejected)`);
          return true;
        }
        log(`  [SPA] Perp close failed: ${msg} -- rollback spot`);
        try { await spotAdapter.spotMarketOrder(symbol, "buy", size); } catch (rbErr) {
          log(`  [SPA] CRITICAL: Spot rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
        return false;
      }
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
