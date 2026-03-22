/**
 * Shared constants for perp-cli.
 */

import { loadSettings } from "./settings.js";

/** Default taker fee per exchange (as fraction, e.g. 0.00035 = 0.035%) */
export const TAKER_FEES: Record<string, number> = {
  hyperliquid: 0.00035,
  pacifica: 0.00035,
  lighter: 0,
  aster: 0.0004, // 0.04% taker fee
};

/** Get taker fee for an exchange. Uses settings if available, falls back to defaults. */
export function getTakerFee(exchange: string): number {
  const key = exchange.toLowerCase();
  try {
    const settings = loadSettings();
    if (settings.fees[key]?.taker !== undefined) {
      return settings.fees[key].taker;
    }
  } catch { /* fallback to hardcoded */ }
  return TAKER_FEES[key] ?? 0.00035;
}

/** Get maker fee for an exchange. Uses settings if available. */
export function getMakerFee(exchange: string): number {
  const key = exchange.toLowerCase();
  try {
    const settings = loadSettings();
    if (settings.fees[key]?.maker !== undefined) {
      return settings.fees[key].maker;
    }
  } catch { /* fallback */ }
  return 0;
}

/** Default taker fee for single-exchange use (when exchange is unknown). */
export const DEFAULT_TAKER_FEE = 0.00035;
