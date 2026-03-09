import type { ExchangeAdapter } from "./exchanges/interface.js";

export interface LiquidityCheck {
  /** Max executable size (base) within slippage tolerance */
  maxSize: number;
  /** Estimated avg fill price for the given size */
  avgFillPrice: number;
  /** Estimated slippage % vs mid price */
  slippagePct: number;
  /** Total depth in USD on the relevant side */
  depthUsd: number;
  /** Whether the full requested size can be filled */
  canFillFull: boolean;
  /** Recommended size (capped by liquidity) */
  recommendedSize: number;
}

/**
 * Walk through orderbook levels and compute how much can be filled
 * within the given slippage tolerance.
 *
 * @param levels - [[price, size], ...] from getOrderbook (asks for buy, bids for sell)
 * @param maxSlippagePct - max acceptable slippage from best price (default 0.5%)
 * @param requestedSizeUsd - desired position size in USD
 */
export function computeExecutableSize(
  levels: [string, string][],
  requestedSizeUsd: number,
  maxSlippagePct: number = 0.5,
): LiquidityCheck {
  if (levels.length === 0) {
    return { maxSize: 0, avgFillPrice: 0, slippagePct: 0, depthUsd: 0, canFillFull: false, recommendedSize: 0 };
  }

  const bestPrice = Number(levels[0][0]);
  const slippageLimit = bestPrice * (1 + maxSlippagePct / 100);

  let filledSize = 0;
  let filledNotional = 0;
  let totalDepthUsd = 0;

  for (const [priceStr, sizeStr] of levels) {
    const price = Number(priceStr);
    const size = Number(sizeStr);
    const levelUsd = price * size;
    totalDepthUsd += levelUsd;

    // Stop walking if we exceed slippage tolerance
    if (price > slippageLimit && filledSize > 0) break;

    const remainingUsd = requestedSizeUsd - filledNotional;
    if (remainingUsd <= 0) break;

    if (levelUsd <= remainingUsd) {
      // Take whole level
      filledSize += size;
      filledNotional += levelUsd;
    } else {
      // Partial fill on this level
      const partialSize = remainingUsd / price;
      filledSize += partialSize;
      filledNotional += remainingUsd;
    }
  }

  const avgFillPrice = filledSize > 0 ? filledNotional / filledSize : bestPrice;
  const slippagePct = bestPrice > 0 ? ((avgFillPrice - bestPrice) / bestPrice) * 100 : 0;
  const canFillFull = filledNotional >= requestedSizeUsd * 0.95; // 95% fill = close enough

  return {
    maxSize: filledSize,
    avgFillPrice,
    slippagePct: Math.abs(slippagePct),
    depthUsd: totalDepthUsd,
    canFillFull,
    recommendedSize: filledSize,
  };
}

/**
 * Check liquidity on both sides for an arb entry.
 * Returns adjusted size or 0 if not viable.
 */
export async function checkArbLiquidity(
  longAdapter: ExchangeAdapter,
  shortAdapter: ExchangeAdapter,
  symbol: string,
  sizeUsd: number,
  maxSlippagePct: number = 0.5,
  log?: (msg: string) => void,
): Promise<{ viable: boolean; adjustedSizeUsd: number; longSlippage: number; shortSlippage: number }> {
  try {
    const [longOB, shortOB] = await Promise.all([
      longAdapter.getOrderbook(symbol),
      shortAdapter.getOrderbook(symbol),
    ]);

    // For long entry we consume asks, for short entry we consume bids
    const longCheck = computeExecutableSize(longOB.asks, sizeUsd, maxSlippagePct);
    const shortCheck = computeExecutableSize(shortOB.bids, sizeUsd, maxSlippagePct);

    // Cross-exchange price gap check
    if (longOB.asks.length > 0 && shortOB.bids.length > 0) {
      const bestAsk = Number(longOB.asks[0][0]);
      const bestBid = Number(shortOB.bids[0][0]);
      const gapPct = Math.abs(bestAsk - bestBid) / Math.min(bestAsk, bestBid) * 100;
      if (gapPct > 2) {
        log?.(`[LIQ] ${symbol}: cross-exchange price gap ${gapPct.toFixed(2)}% too wide`);
        return { viable: false, adjustedSizeUsd: 0, longSlippage: longCheck.slippagePct, shortSlippage: shortCheck.slippagePct };
      }
    }

    // Use whichever side has less available liquidity
    const executableUsd = Math.min(
      longCheck.maxSize * longCheck.avgFillPrice,
      shortCheck.maxSize * shortCheck.avgFillPrice,
    );

    // Minimum viable: at least 20% of requested size
    const minViable = sizeUsd * 0.2;
    if (executableUsd < minViable) {
      log?.(`[LIQ] ${symbol}: only $${executableUsd.toFixed(0)} executable (need min $${minViable.toFixed(0)}) — asks $${longCheck.depthUsd.toFixed(0)} on ${longAdapter.name}, bids $${shortCheck.depthUsd.toFixed(0)} on ${shortAdapter.name}`);
      return { viable: false, adjustedSizeUsd: 0, longSlippage: longCheck.slippagePct, shortSlippage: shortCheck.slippagePct };
    }

    // Cap to what's available
    const adjustedSizeUsd = Math.min(sizeUsd, executableUsd);
    if (adjustedSizeUsd < sizeUsd) {
      log?.(`[LIQ] ${symbol}: size reduced $${sizeUsd} → $${adjustedSizeUsd.toFixed(0)} (limited by orderbook depth)`);
    }

    return {
      viable: true,
      adjustedSizeUsd,
      longSlippage: longCheck.slippagePct,
      shortSlippage: shortCheck.slippagePct,
    };
  } catch {
    log?.(`[LIQ] ${symbol}: orderbook fetch failed, skipping`);
    return { viable: false, adjustedSizeUsd: 0, longSlippage: 0, shortSlippage: 0 };
  }
}
