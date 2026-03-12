/**
 * Shared constants for perp-cli.
 */

/** Default taker fee per exchange (as fraction, e.g. 0.00035 = 0.035%) */
export const TAKER_FEES: Record<string, number> = {
  hyperliquid: 0.00035,
  pacifica: 0.00035,
  lighter: 0.00035,
};

/** Get taker fee for an exchange, with fallback. */
export function getTakerFee(exchange: string): number {
  return TAKER_FEES[exchange.toLowerCase()] ?? 0.00035;
}

/** Default taker fee for single-exchange use. */
export const DEFAULT_TAKER_FEE = 0.00035;
