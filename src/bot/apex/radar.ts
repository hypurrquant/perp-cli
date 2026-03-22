/**
 * Radar: 4-stage scoring funnel (0-400 points)
 * Stage 1: Market Structure (35%, 0-140) -- volume, OI, liquidity depth
 * Stage 2: Technicals (30%, 0-120) -- RSI, EMA trend, pattern
 * Stage 3: Funding (20%, 0-80) -- rate extremes, direction bias
 * Stage 4: BTC Macro (15%, 0-60) -- BTC trend alignment, regime
 */

import type { EnrichedSnapshot } from "../strategy-types.js";
import { calculateEMA, calculateRSI, detectRegime } from "../indicators.js";

export interface RadarScore {
  symbol: string;
  total: number;
  structure: number;
  technicals: number;
  funding: number;
  btcMacro: number;
}

// ── Stage 1: Market Structure (0-140) ──

function scoreStructure(snapshot: EnrichedSnapshot): number {
  let score = 0;

  // Volume component (0-50): higher 24h volume = more liquid
  const vol = snapshot.volume24h;
  if (vol > 100_000_000) score += 50;
  else if (vol > 50_000_000) score += 40;
  else if (vol > 10_000_000) score += 30;
  else if (vol > 1_000_000) score += 15;

  // OI component (0-50): higher open interest = more conviction
  const oi = parseFloat(snapshot.openInterest);
  if (oi > 50_000_000) score += 50;
  else if (oi > 20_000_000) score += 40;
  else if (oi > 5_000_000) score += 25;
  else if (oi > 1_000_000) score += 10;

  // Liquidity depth component (0-40): tight spread = deep book
  const spread = snapshot.spreadPct;
  if (spread < 0.01) score += 40;
  else if (spread < 0.03) score += 30;
  else if (spread < 0.05) score += 20;
  else if (spread < 0.1) score += 10;

  return Math.min(score, 140);
}

// ── Stage 2: Technicals (0-120) ──

function scoreTechnicals(snapshot: EnrichedSnapshot): number {
  let score = 0;
  const klines = snapshot.klines;
  if (klines.length < 20) return 0;

  const closes = klines.map(k => parseFloat(k.close));

  // RSI component (0-40): extreme RSI = strong signal
  const rsi = calculateRSI(closes, 14);
  if (rsi <= 25 || rsi >= 75) score += 40;       // extreme
  else if (rsi <= 30 || rsi >= 70) score += 30;   // strong
  else if (rsi <= 35 || rsi >= 65) score += 15;   // moderate

  // EMA trend alignment (0-40): price above EMA20 = bullish, below = bearish
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, Math.min(50, closes.length));
  if (ema20.length > 0 && ema50.length > 0) {
    const lastEma20 = ema20[ema20.length - 1];
    const lastEma50 = ema50[ema50.length - 1];
    const price = snapshot.price;
    // Clear trend: price and short EMA aligned relative to long EMA
    const bullTrend = price > lastEma20 && lastEma20 > lastEma50;
    const bearTrend = price < lastEma20 && lastEma20 < lastEma50;
    if (bullTrend || bearTrend) score += 40;
    else if (price > lastEma20 || price < lastEma20) score += 15;
  }

  // Pattern component (0-40): recent volatility contraction then expansion
  const recentVol = snapshot.volatility24h;
  if (recentVol > 5) score += 40;        // high volatility breakout
  else if (recentVol > 3) score += 25;
  else if (recentVol > 1.5) score += 10;

  return Math.min(score, 120);
}

// ── Stage 3: Funding (0-80) ──

function scoreFunding(snapshot: EnrichedSnapshot): number {
  let score = 0;
  const fr = snapshot.fundingRate;
  const absFr = Math.abs(fr);

  // Extreme funding = contrarian opportunity (0-50)
  if (absFr > 0.001) score += 50;        // >0.1% per period
  else if (absFr > 0.0005) score += 35;  // >0.05%
  else if (absFr > 0.0002) score += 15;  // >0.02%

  // Direction bias bonus (0-30): extreme negative = long opportunity, extreme positive = short
  if (fr < -0.0005) score += 30;         // heavy short bias → long signal
  else if (fr > 0.0005) score += 30;     // heavy long bias → short signal
  else if (absFr > 0.0002) score += 10;

  return Math.min(score, 80);
}

// ── Stage 4: BTC Macro (0-60) ──

function scoreBtcMacro(btcSnapshot: EnrichedSnapshot | null): number {
  if (!btcSnapshot) return 30; // neutral if no BTC data

  let score = 0;
  const klines = btcSnapshot.klines;
  if (klines.length < 20) return 30;

  const closes = klines.map(k => parseFloat(k.close));
  const regime = detectRegime(closes, 20);

  // Trending regime favors directional trades (0-35)
  if (regime === "low-vol-trending") score += 35;
  else if (regime === "high-vol-trending") score += 25;
  else if (regime === "low-vol-ranging") score += 10;
  // high-vol-ranging = 0 (unfavorable)

  // BTC trend alignment (0-25): clear BTC direction helps alts
  const ema20 = calculateEMA(closes, 20);
  if (ema20.length > 0) {
    const btcPrice = btcSnapshot.price;
    const lastEma = ema20[ema20.length - 1];
    const pctAbove = (btcPrice - lastEma) / lastEma;
    if (Math.abs(pctAbove) > 0.02) score += 25;       // strong BTC trend
    else if (Math.abs(pctAbove) > 0.005) score += 15;  // moderate
  }

  return Math.min(score, 60);
}

// ── Main scorer ──

export function scoreOpportunity(
  snapshot: EnrichedSnapshot,
  btcSnapshot: EnrichedSnapshot | null,
): RadarScore {
  const structure = scoreStructure(snapshot);
  const technicals = scoreTechnicals(snapshot);
  const funding = scoreFunding(snapshot);
  const btcMacro = scoreBtcMacro(btcSnapshot);

  return {
    symbol: snapshot.klines[0]?.close ? "unknown" : "unknown", // caller sets symbol
    total: structure + technicals + funding + btcMacro,
    structure,
    technicals,
    funding,
    btcMacro,
  };
}
