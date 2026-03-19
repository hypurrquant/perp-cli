/**
 * Orderbook-aware split order execution.
 *
 * Unlike TWAP (time-based splitting), this strategy reads the orderbook
 * before each slice and calculates optimal slice sizes based on available
 * depth. Each slice is placed as an IOC limit order at the worst acceptable
 * price within the slippage tolerance, ensuring no sweep beyond the target.
 *
 * Flow per slice:
 *   1. Fetch fresh orderbook
 *   2. Walk levels via computeExecutableSize to find fillable amount
 *   3. Place IOC limit at best price + slippage tolerance
 *   4. Wait for book to refresh, then repeat
 */

import type { ExchangeAdapter } from "../exchanges/index.js";
import { computeExecutableSize } from "../liquidity.js";
import { logExecution } from "../execution-log.js";

export interface SplitOrderParams {
  symbol: string;
  side: "buy" | "sell";
  totalSizeUsd: number;        // total notional to execute
  maxSlippagePct?: number;     // max slippage per slice (default: 0.3%)
  maxSlices?: number;          // max number of slices (default: 10)
  delayMs?: number;            // delay between slices (default: 1000ms)
  minSliceUsd?: number;        // minimum slice size (default: 100)
}

export interface SplitSlice {
  index: number;
  size: string;                // base size
  price: string;               // limit price used
  notionalUsd: number;
  slippagePct: number;
  method: "limit_ioc" | "market";
  status: "filled" | "partial" | "failed";
}

export interface SplitOrderResult {
  symbol: string;
  side: "buy" | "sell";
  requestedUsd: number;
  filledUsd: number;
  filledSize: number;
  avgPrice: number;
  totalSlippagePct: number;
  slices: SplitSlice[];
  status: "complete" | "partial" | "failed";
  runtime: number;
}

/**
 * Infer price precision (decimal places) from an orderbook price string.
 */
function pricePrecision(priceStr: string): number {
  return priceStr.includes(".") ? priceStr.split(".")[1].length : 0;
}

/**
 * Execute a split order: orderbook-aware slicing with IOC limits.
 */
export async function runSplitOrder(
  adapter: ExchangeAdapter,
  params: SplitOrderParams,
  log: (msg: string) => void = console.log,
): Promise<SplitOrderResult> {
  const {
    symbol, side, totalSizeUsd,
    maxSlippagePct = 0.3,
    maxSlices = 10,
    delayMs = 1000,
    minSliceUsd = 100,
  } = params;
  const startedAt = Date.now();
  const slices: SplitSlice[] = [];
  let remainingUsd = totalSizeUsd;
  let totalFilledSize = 0;
  let totalFilledNotional = 0;

  // Capture initial best price for overall slippage calculation
  let initialBestPrice = 0;
  try {
    const initialBook = await adapter.getOrderbook(symbol);
    const initialLevels = side === "buy" ? initialBook.asks : initialBook.bids;
    if (initialLevels.length > 0) {
      initialBestPrice = Number(initialLevels[0][0]);
    }
  } catch {
    // Will be recaptured on first slice
  }

  log(`[SPLIT] ${side.toUpperCase()} $${totalSizeUsd.toFixed(0)} of ${symbol} | max slippage: ${maxSlippagePct}% | max slices: ${maxSlices}`);

  for (let i = 0; i < maxSlices && remainingUsd >= minSliceUsd; i++) {
    // 1. Fetch fresh orderbook
    const book = await adapter.getOrderbook(symbol);
    const levels = side === "buy" ? book.asks : book.bids;

    if (levels.length === 0) {
      log(`[SPLIT] No ${side === "buy" ? "asks" : "bids"} in orderbook, stopping`);
      break;
    }

    // Capture initial best if we missed it
    if (initialBestPrice === 0) {
      initialBestPrice = Number(levels[0][0]);
    }

    // 2. Calculate how much we can execute within slippage on this depth
    const check = computeExecutableSize(levels, remainingUsd, maxSlippagePct);

    if (check.maxSize <= 0) {
      log(`[SPLIT] Insufficient liquidity within ${maxSlippagePct}% slippage, stopping`);
      break;
    }

    // Slice size: what we can fill within slippage, capped by remaining
    const sliceNotional = Math.min(check.maxSize * check.avgFillPrice, remainingUsd);
    const sliceSize = sliceNotional / check.avgFillPrice;

    // 3. Calculate IOC limit price (worst acceptable within slippage)
    const bestPrice = Number(levels[0][0]);
    const limitPrice = side === "buy"
      ? bestPrice * (1 + maxSlippagePct / 100)
      : bestPrice * (1 - maxSlippagePct / 100);

    const decimals = pricePrecision(levels[0][0]);
    const formattedPrice = limitPrice.toFixed(decimals);
    const formattedSize = sliceSize.toFixed(6);

    log(`[SPLIT] Slice ${i + 1}: ${formattedSize} @ limit $${formattedPrice} (~$${sliceNotional.toFixed(0)}) | depth: $${check.depthUsd.toFixed(0)}`);

    // 4. Execute IOC limit order
    let slice: SplitSlice;
    try {
      await adapter.limitOrder(symbol, side, formattedPrice, formattedSize, { tif: "IOC" });

      slice = {
        index: i,
        size: formattedSize,
        price: formattedPrice,
        notionalUsd: sliceNotional,
        slippagePct: check.slippagePct,
        method: "limit_ioc",
        status: "filled",
      };

      totalFilledSize += sliceSize;
      totalFilledNotional += sliceNotional;
      remainingUsd -= sliceNotional;

      logExecution({
        type: "limit_order", exchange: adapter.name, symbol,
        side, size: formattedSize, price: formattedPrice,
        notional: sliceNotional, status: "success", dryRun: false,
        meta: { action: "split-order", slice: i + 1, totalSlices: maxSlices },
      });
    } catch (err) {
      log(`[SPLIT] Slice ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      slice = {
        index: i, size: formattedSize, price: formattedPrice,
        notionalUsd: 0, slippagePct: 0, method: "limit_ioc", status: "failed",
      };

      logExecution({
        type: "limit_order", exchange: adapter.name, symbol,
        side, size: formattedSize, price: formattedPrice,
        notional: 0, status: "failed", dryRun: false,
        error: err instanceof Error ? err.message : String(err),
        meta: { action: "split-order", slice: i + 1, totalSlices: maxSlices },
      });
    }

    slices.push(slice);

    // 5. Delay before next slice (let the book refresh)
    if (remainingUsd >= minSliceUsd && i < maxSlices - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const avgPrice = totalFilledSize > 0 ? totalFilledNotional / totalFilledSize : 0;
  const totalSlippage = initialBestPrice > 0
    ? Math.abs((avgPrice - initialBestPrice) / initialBestPrice) * 100
    : 0;

  const status = totalFilledNotional >= totalSizeUsd * 0.95 ? "complete"
    : totalFilledNotional > 0 ? "partial"
    : "failed";

  log(`[SPLIT] Done: ${slices.length} slices | filled $${totalFilledNotional.toFixed(0)}/$${totalSizeUsd.toFixed(0)} | avg price: $${avgPrice.toFixed(2)} | slippage: ${totalSlippage.toFixed(3)}%`);

  return {
    symbol, side,
    requestedUsd: totalSizeUsd,
    filledUsd: totalFilledNotional,
    filledSize: totalFilledSize,
    avgPrice,
    totalSlippagePct: totalSlippage,
    slices,
    status,
    runtime: (Date.now() - startedAt) / 1000,
  };
}
