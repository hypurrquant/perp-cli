/**
 * Pulse: 5-tier signal taxonomy for momentum detection.
 * FIRST_JUMP (100): first sector mover, OI + volume breakout
 * CONTRIB_EXPLOSION (95): OI +15% AND volume 5x simultaneously
 * IMMEDIATE_MOVER (80): OI +15% OR volume 5x
 * NEW_ENTRY_DEEP (65): OI growth 8%+ with low volume (smart money)
 * DEEP_CLIMBER (55): sustained OI climb 5%+ per window over 3+ scans
 */

import type { EnrichedSnapshot } from "../strategy-types.js";

export type PulseTier =
  | "FIRST_JUMP"
  | "CONTRIB_EXPLOSION"
  | "IMMEDIATE_MOVER"
  | "NEW_ENTRY_DEEP"
  | "DEEP_CLIMBER"
  | "NONE";

export interface PulseSignal {
  symbol: string;
  tier: PulseTier;
  confidence: number;
  oiChange: number;
  volumeRatio: number;
}

/** Tier ordering for comparison */
const TIER_RANK: Record<PulseTier, number> = {
  FIRST_JUMP: 100,
  CONTRIB_EXPLOSION: 95,
  IMMEDIATE_MOVER: 80,
  NEW_ENTRY_DEEP: 65,
  DEEP_CLIMBER: 55,
  NONE: 0,
};

export function tierRank(tier: PulseTier): number {
  return TIER_RANK[tier];
}

export function detectPulse(
  current: EnrichedSnapshot,
  history: Map<string, { oi: number; volume: number }[]>,
): PulseSignal {
  const symbol = "unknown"; // caller sets the actual symbol
  const currentOi = parseFloat(current.openInterest);
  const currentVolume = current.volume24h;

  const past = history.get(symbol) ?? [];
  if (past.length === 0) {
    return { symbol, tier: "NONE", confidence: 0, oiChange: 0, volumeRatio: 0 };
  }

  // Compare against the most recent historical entry
  const prev = past[past.length - 1];
  const oiChange = prev.oi > 0 ? (currentOi - prev.oi) / prev.oi : 0;
  const volumeRatio = prev.volume > 0 ? currentVolume / prev.volume : 0;

  // Thresholds
  const oiBreakout = oiChange >= 0.15;     // +15%
  const volumeBreakout = volumeRatio >= 5;  // 5x volume
  const oiDeep = oiChange >= 0.08;          // +8% OI
  const lowVolume = volumeRatio < 1.5;      // below 1.5x → quiet accumulation

  // ── Tier detection (highest priority first) ──

  // FIRST_JUMP: OI + volume breakout when no other symbol in sector moved
  // Simplified: both OI and volume spike with OI being the dominant factor
  if (oiBreakout && volumeBreakout && oiChange >= 0.2) {
    return {
      symbol,
      tier: "FIRST_JUMP",
      confidence: Math.min(oiChange * 3 + volumeRatio * 0.1, 1),
      oiChange,
      volumeRatio,
    };
  }

  // CONTRIB_EXPLOSION: OI +15% AND volume 5x simultaneously
  if (oiBreakout && volumeBreakout) {
    return {
      symbol,
      tier: "CONTRIB_EXPLOSION",
      confidence: Math.min(oiChange * 2.5 + volumeRatio * 0.08, 1),
      oiChange,
      volumeRatio,
    };
  }

  // IMMEDIATE_MOVER: OI +15% OR volume 5x
  if (oiBreakout || volumeBreakout) {
    return {
      symbol,
      tier: "IMMEDIATE_MOVER",
      confidence: Math.min(Math.max(oiChange * 2, volumeRatio * 0.15), 1),
      oiChange,
      volumeRatio,
    };
  }

  // NEW_ENTRY_DEEP: OI growth 8%+ with low volume (smart money accumulation)
  if (oiDeep && lowVolume) {
    return {
      symbol,
      tier: "NEW_ENTRY_DEEP",
      confidence: Math.min(oiChange * 3, 1),
      oiChange,
      volumeRatio,
    };
  }

  // DEEP_CLIMBER: sustained OI climb 5%+ per window over 3+ consecutive scans
  if (past.length >= 3) {
    let consecutiveClimbs = 0;
    for (let i = 1; i < past.length; i++) {
      const prevOi = past[i - 1].oi;
      const currOi = past[i].oi;
      if (prevOi > 0 && (currOi - prevOi) / prevOi >= 0.05) {
        consecutiveClimbs++;
      } else {
        consecutiveClimbs = 0;
      }
    }
    // Also check current vs last
    if (prev.oi > 0 && oiChange >= 0.05) consecutiveClimbs++;

    if (consecutiveClimbs >= 3) {
      return {
        symbol,
        tier: "DEEP_CLIMBER",
        confidence: Math.min(consecutiveClimbs * 0.2, 1),
        oiChange,
        volumeRatio,
      };
    }
  }

  return { symbol, tier: "NONE", confidence: 0, oiChange, volumeRatio };
}
