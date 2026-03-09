/**
 * Funding rate normalization.
 *
 * Different exchanges report funding rates at different intervals:
 * - Hyperliquid: per HOUR (settles every 1h)
 * - Lighter: per 8 HOURS (Binance convention)
 * - Pacifica: per 8 HOURS
 *
 * To compare rates across exchanges, we normalize everything to
 * a per-hour basis, then annualize from there.
 */

/** Funding periods per year by convention */
const HOURLY_PERIODS = 24 * 365;   // 8760
const EIGHT_H_PERIODS = 3 * 365;   // 1095

/** How many hours each exchange's rate covers */
const EXCHANGE_FUNDING_HOURS: Record<string, number> = {
  hyperliquid: 1,
  pacifica: 8,
  lighter: 8,
};

/**
 * HIP-3 deployed dexes settle funding every 8 hours.
 * Use this when the exchange string is a dex name (e.g., "xyz", "vntl").
 */
export function getFundingHours(exchange: string): number {
  return EXCHANGE_FUNDING_HOURS[exchange.toLowerCase()] ?? 8;
}

/** Convert a raw funding rate to per-hour rate */
export function toHourlyRate(rate: number, exchange: string): number {
  const hours = EXCHANGE_FUNDING_HOURS[exchange.toLowerCase()] ?? 8;
  return rate / hours;
}

/** Annualize a raw rate from a specific exchange */
export function annualizeRate(rate: number, exchange: string): number {
  const hourlyRate = toHourlyRate(rate, exchange);
  return hourlyRate * HOURLY_PERIODS * 100; // as percentage
}

/**
 * Compute annualized spread between two exchange rates.
 * Normalizes both to hourly before comparing.
 */
export function computeAnnualSpread(
  rateA: number, exchangeA: string,
  rateB: number, exchangeB: string,
): number {
  const hourlyA = toHourlyRate(rateA, exchangeA);
  const hourlyB = toHourlyRate(rateB, exchangeB);
  return Math.abs(hourlyA - hourlyB) * HOURLY_PERIODS * 100;
}

/**
 * Estimate hourly funding payment for a position.
 * @param rate - raw funding rate from the exchange
 * @param exchange - exchange name
 * @param positionUsd - position notional in USD
 * @param side - "long" or "short" (longs pay positive rate, shorts receive)
 * @returns hourly payment in USD (positive = you pay, negative = you receive)
 */
export function estimateHourlyFunding(
  rate: number, exchange: string,
  positionUsd: number, side: "long" | "short",
): number {
  const hourlyRate = toHourlyRate(rate, exchange);
  // Long pays positive funding, short receives positive funding
  const multiplier = side === "long" ? 1 : -1;
  return hourlyRate * positionUsd * multiplier;
}
