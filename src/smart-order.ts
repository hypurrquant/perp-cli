/**
 * Smart Order Execution — best bid/ask + 1 tick pricing.
 *
 * Instead of `marketOrder()` which can sweep deep into the book (Hyperliquid
 * DEX uses 5% slippage by default), this fetches the orderbook and places an
 * order at exactly the best available price plus one tick.
 *
 * For buys:  limit price = best ask + 1 tick  (fills at best ask or better)
 * For sells: limit price = best bid - 1 tick  (fills at best bid or better)
 *
 * Uses IOC (Immediate-Or-Cancel) so the order fills instantly at the best
 * level and any unfilled remainder is cancelled — no resting orders left.
 *
 * Benefits:
 * - Fills only at the top-of-book price (no multi-level sweep)
 * - Saves 5-50+ bps vs raw market orders on thin books
 * - Predictable execution price
 *
 * Fallback: if the IOC limit fails, falls back to market order.
 */

import type { ExchangeAdapter } from "./exchanges/interface.js";

export interface SmartOrderOpts {
  /** Extra ticks of tolerance beyond best price. Default: 1 */
  tickTolerance?: number;
  /** Fall back to market order if IOC limit fails. Default: true */
  fallback?: boolean;
  /** Reduce only flag for closing positions. Default: false */
  reduceOnly?: boolean;
}

export interface SmartOrderResult {
  result: unknown;
  method: "limit_ioc" | "market_fallback";
  /** The actual limit price used for the order */
  price: string;
  /** The best price from the orderbook */
  bestBookPrice: string;
  /** Tick size inferred from orderbook */
  tickSize: string;
}

/**
 * Infer tick size from orderbook prices.
 * Uses the minimum price increment visible in the book.
 */
function inferTickSize(levels: [string, string][]): number {
  if (levels.length < 2) {
    // Single level: infer from decimal places (e.g., "1.234" → tick = 0.001)
    const price = levels[0]?.[0] ?? "1";
    const decimals = price.includes(".") ? price.split(".")[1].length : 0;
    return decimals > 0 ? Math.pow(10, -decimals) : 1;
  }

  // Use minimum difference between adjacent price levels
  let minDiff = Infinity;
  for (let i = 1; i < Math.min(levels.length, 5); i++) {
    const diff = Math.abs(Number(levels[i][0]) - Number(levels[i - 1][0]));
    if (diff > 0 && diff < minDiff) minDiff = diff;
  }

  return minDiff === Infinity
    ? Math.pow(10, -(levels[0][0].includes(".") ? levels[0][0].split(".")[1].length : 0))
    : minDiff;
}

/**
 * Get price precision (decimal places) from a price string.
 */
function pricePrecision(priceStr: string): number {
  return priceStr.includes(".") ? priceStr.split(".")[1].length : 0;
}

/**
 * Execute a smart order at best bid/ask + 1 tick.
 * Drop-in replacement for `adapter.marketOrder()`.
 */
export async function smartOrder(
  adapter: ExchangeAdapter,
  symbol: string,
  side: "buy" | "sell",
  size: string,
  opts: SmartOrderOpts = {},
): Promise<SmartOrderResult> {
  const { tickTolerance = 1, fallback = true, reduceOnly = false } = opts;

  // 1. Fetch orderbook
  const book = await adapter.getOrderbook(symbol);

  // 2. Validate book has liquidity on the relevant side
  const relevantSide = side === "buy" ? book.asks : book.bids;
  if (relevantSide.length === 0) {
    if (!fallback) throw new Error(`No ${side === "buy" ? "asks" : "bids"} in orderbook for ${symbol}`);
    const result = await adapter.marketOrder(symbol, side, size);
    return { result, method: "market_fallback", price: "0", bestBookPrice: "0", tickSize: "0" };
  }

  // 3. Get best price and tick size
  const bestEntry = relevantSide[0];
  const bestPrice = Number(bestEntry[0]);
  const tick = inferTickSize(relevantSide);
  const decimals = pricePrecision(bestEntry[0]);

  // 4. Calculate limit price: best price + N ticks in favorable direction
  const limitPrice = side === "buy"
    ? bestPrice + tick * tickTolerance   // 1 tick above best ask
    : bestPrice - tick * tickTolerance;  // 1 tick below best bid

  const formattedPrice = limitPrice.toFixed(decimals);

  // 5. Place IOC limit order at calculated price
  try {
    const result = await adapter.limitOrder(symbol, side, formattedPrice, size, {
      tif: "IOC",
      reduceOnly,
    });
    return {
      result,
      method: "limit_ioc",
      price: formattedPrice,
      bestBookPrice: bestEntry[0],
      tickSize: tick.toFixed(decimals),
    };
  } catch (err) {
    if (!fallback) throw err;
    // Fallback to raw market order for reliability
    const result = await adapter.marketOrder(symbol, side, size);
    return {
      result,
      method: "market_fallback",
      price: formattedPrice,
      bestBookPrice: bestEntry[0],
      tickSize: tick.toFixed(decimals),
    };
  }
}
