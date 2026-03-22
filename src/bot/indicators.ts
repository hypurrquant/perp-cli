/**
 * Technical indicator library for trading strategies.
 * Pure functions — no side effects, no API calls.
 */

/** Calculate Exponential Moving Average */
export function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  // SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  ema.push(sum / period);
  // EMA for rest
  for (let i = period; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

/** Calculate Simple Moving Average */
export function calculateSMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const sma: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j];
    sma.push(sum / period);
  }
  return sma;
}

/** Calculate Volume Weighted Average Price */
export function calculateVWAP(candles: { close: number; volume: number }[]): number {
  let cumVolPrice = 0;
  let cumVol = 0;
  for (const c of candles) {
    cumVolPrice += c.close * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumVolPrice / cumVol : 0;
}

/** Calculate Average True Range */
export function calculateATR(candles: { high: number; low: number; close: number }[], period: number): number[] {
  if (candles.length < 2) return [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder smoothing for ATR
  if (tr.length < period) return [];
  const atr: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr.push(sum / period);
  for (let i = period; i < tr.length; i++) {
    atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
  }
  return atr;
}

/** Calculate Bollinger Bands */
export function calculateBollingerBands(prices: number[], period: number, stdDevMultiplier = 2): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = calculateSMA(prices, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < middle.length; i++) {
    const sliceStart = i;
    const slice = prices.slice(sliceStart, sliceStart + period);
    const mean = middle[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    upper.push(mean + stdDevMultiplier * stdDev);
    lower.push(mean - stdDevMultiplier * stdDev);
  }
  return { upper, middle, lower };
}

/** Calculate RSI (extracted from conditions.ts) */
export function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50; // neutral default
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Detect market regime: low-vol-trending, low-vol-ranging, high-vol-trending, high-vol-ranging */
export function detectRegime(prices: number[], period = 20): "low-vol-trending" | "low-vol-ranging" | "high-vol-trending" | "high-vol-ranging" {
  if (prices.length < period) return "low-vol-ranging";
  const recent = prices.slice(-period);
  // Volatility: std dev of returns
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
  }
  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance);
  // Trend: slope of linear regression
  const n = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const normalizedSlope = Math.abs(slope / (sumY / n));
  const isHighVol = vol > 0.02; // >2% daily vol
  const isTrending = normalizedSlope > 0.001;
  if (isHighVol && isTrending) return "high-vol-trending";
  if (isHighVol && !isTrending) return "high-vol-ranging";
  if (!isHighVol && isTrending) return "low-vol-trending";
  return "low-vol-ranging";
}
