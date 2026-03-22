/**
 * Funding rate normalization.
 *
 * Exchange funding rate periods:
 * - Hyperliquid: per 1 HOUR (settles every 1h)
 * - Pacifica: per 1 HOUR (settles every 1h)
 * - Lighter: per 8 HOURS (API returns 8h rate, settles every 1h)
 *
 * HIP-3 deployed dexes on Hyperliquid use 8h funding periods.
 *
 * To compare rates across exchanges, we normalize everything to
 * a per-hour basis, then annualize from there.
 */

/** Funding periods per year by convention */
const HOURLY_PERIODS = 24 * 365;   // 8760

/** How many hours each exchange's rate covers */
const EXCHANGE_FUNDING_HOURS: Record<string, number> = {
  hyperliquid: 1,
  pacifica: 1,
  lighter: 8,
  aster: 8,
};

/**
 * Get funding period in hours for an exchange.
 * HIP-3 deployed dexes (not in the map) default to 1h (API returns hourly).
 * HL and PAC are 1h, Lighter API returns 8h rates.
 */
export function getFundingHours(exchange: string): number {
  return EXCHANGE_FUNDING_HOURS[exchange.toLowerCase()] ?? 1;
}

/** Convert a raw funding rate to per-hour rate */
export function toHourlyRate(rate: number, exchange: string): number {
  const hours = EXCHANGE_FUNDING_HOURS[exchange.toLowerCase()] ?? 1;
  return rate / hours;
}

/** Annualize a raw rate from a specific exchange */
export function annualizeRate(rate: number, exchange: string): number {
  const hourlyRate = toHourlyRate(rate, exchange);
  return hourlyRate * HOURLY_PERIODS * 100; // as percentage
}

/** Annualize an already-normalized hourly rate (no exchange conversion needed) */
export function annualizeHourlyRate(hourlyRate: number): number {
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
