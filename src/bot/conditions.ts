import type { ExchangeAdapter } from "../exchanges/index.js";
import type { Condition } from "./config.js";

export interface MarketSnapshot {
  price: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  fundingRate: number;
  volatility24h: number; // (high - low) / price * 100
  rsi: number;           // 14-period RSI from 1h candles (NaN if insufficient data)
  spreadPct: number;     // best bid-ask spread as percentage of mid price
}

// ── RSI Calculation (Wilder smoothing) ──

/**
 * Calculate RSI from an array of closing prices using Wilder's smoothing method.
 * @param closes Array of closing prices, oldest first.
 * @param period RSI period (default 14).
 * @returns RSI value between 0 and 100, or NaN if insufficient data.
 */
export function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return NaN;

  // Calculate price changes (deltas)
  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }

  // Separate gains and losses
  const gains = deltas.map(d => (d > 0 ? d : 0));
  const losses = deltas.map(d => (d < 0 ? -d : 0));

  // First average: simple mean of first `period` values
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // Subsequent averages: Wilder smoothing
  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  // Handle edge case: no losses at all
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export async function getMarketSnapshot(
  adapter: ExchangeAdapter,
  symbol: string,
): Promise<MarketSnapshot> {
  const markets = await adapter.getMarkets();
  const m = markets.find(mk => mk.symbol.toUpperCase() === symbol.toUpperCase());

  if (!m) {
    throw new Error(`Market "${symbol}" not found on ${adapter.name}`);
  }

  const price = parseFloat(m.markPrice);
  const fundingRate = parseFloat(m.fundingRate ?? "0");
  const volume24h = parseFloat(m.volume24h);

  // Try to get kline data for 24h high/low + RSI
  let high24h = price;
  let low24h = price;
  let rsi = NaN;
  try {
    const now = Date.now();
    // Fetch enough candles for RSI (need period+1 candles minimum; fetch 48h for safety)
    const klines = await adapter.getKlines(symbol, "1h", now - 48 * 3600 * 1000, now);
    if (klines.length > 0) {
      // Sort by time ascending
      klines.sort((a, b) => a.time - b.time);

      // 24h high/low: use only the last 24 candles
      const last24h = klines.filter(k => k.time >= now - 24 * 3600 * 1000);
      if (last24h.length > 0) {
        high24h = Math.max(...last24h.map(k => parseFloat(k.high)));
        low24h = Math.min(...last24h.map(k => parseFloat(k.low)));
      }

      // RSI from all available close prices
      const closes = klines.map(k => parseFloat(k.close));
      rsi = calculateRSI(closes, 14);
    }
  } catch {
    // non-critical
  }

  // Calculate bid-ask spread from orderbook
  let spreadPct = 0;
  try {
    const ob = await adapter.getOrderbook(symbol);
    if (ob.bids.length > 0 && ob.asks.length > 0) {
      const bestBid = parseFloat(ob.bids[0][0]);
      const bestAsk = parseFloat(ob.asks[0][0]);
      const midPrice = (bestBid + bestAsk) / 2;
      if (midPrice > 0) {
        spreadPct = ((bestAsk - bestBid) / midPrice) * 100;
      }
    }
  } catch {
    // non-critical
  }

  const volatility24h = price > 0 ? ((high24h - low24h) / price) * 100 : 0;

  return { price, high24h, low24h, volume24h, fundingRate, volatility24h, rsi, spreadPct };
}

export function evaluateCondition(
  condition: Condition,
  snapshot: MarketSnapshot,
  context: { equity: number; startTime: number; peakEquity: number; dailyPnl: number },
): boolean {
  const val = typeof condition.value === "number" ? condition.value : parseFloat(String(condition.value));

  switch (condition.type) {
    case "always":
      return true;

    case "price_above":
      return snapshot.price > val;

    case "price_below":
      return snapshot.price < val;

    case "volatility_above":
      return snapshot.volatility24h > val;

    case "volatility_below":
      return snapshot.volatility24h < val;

    case "funding_rate_above":
      return snapshot.fundingRate > val;

    case "funding_rate_below":
      return snapshot.fundingRate < val;

    case "rsi_above":
      // RSI was pre-computed in the snapshot from 1h kline data.
      // If RSI is NaN (insufficient data), the condition is not met.
      return !isNaN(snapshot.rsi) && snapshot.rsi > val;

    case "rsi_below":
      return !isNaN(snapshot.rsi) && snapshot.rsi < val;

    case "balance_above":
      return context.equity > val;

    case "balance_below":
      return context.equity < val;

    case "spread_above":
      // Bid-ask spread percentage, pre-computed from orderbook in snapshot.
      return snapshot.spreadPct > val;

    case "time_after": {
      const elapsed = (Date.now() - context.startTime) / 1000;
      return elapsed > val;
    }

    case "max_drawdown":
      return (context.peakEquity - context.equity) > val;

    default:
      return false;
  }
}

export function evaluateAllConditions(
  conditions: Condition[],
  snapshot: MarketSnapshot,
  context: { equity: number; startTime: number; peakEquity: number; dailyPnl: number },
  mode: "all" | "any" = "all",
): boolean {
  if (conditions.length === 0) return true;

  if (mode === "all") {
    return conditions.every(c => evaluateCondition(c, snapshot, context));
  }
  return conditions.some(c => evaluateCondition(c, snapshot, context));
}
