/**
 * Funding rate normalization.
 *
 * The number of hours one quoted rate covers (the funding BASIS) comes from the
 * venue definition — `VenueDefinition.fundingRateBasis`, read through
 * `fundingBasisOf(ref)`. Settlement timing is a separate concept (arb/utils.ts).
 *
 * A venue ref is a venue id/alias, or "hl:<dex>" for Hyperliquid HIP-3 dexes
 * (those resolve to the Hyperliquid core basis — current behavior preserved).
 * Unknown refs throw UNKNOWN_VENUE; per-market venues
 * have no single hours value — use the market's basis with the `*ByBasis`
 * variants below.
 */

import { PerpError } from "../errors.js";
import { fundingBasisOf, parseVenueRef } from "../exchanges/venue.js";
import { rateToHourly, type FundingRateBasis } from "../exchanges/venue-types.js";
import { ensureVenuesRegistered } from "../exchanges/venues/index.js";

/** Funding periods per year by convention */
const HOURLY_PERIODS = 24 * 365;   // 8760

/**
 * Funding basis of a venue ref. Unknown refs (e.g. a stale value in persisted
 * arb/bot state) surface as UNKNOWN_VENUE with remediation instead of an
 * anonymous crash deep inside a strategy loop.
 */
export function venueFundingBasis(ref: string): FundingRateBasis {
  ensureVenuesRegistered();
  try {
    parseVenueRef(ref);
  } catch (err) {
    if (err instanceof PerpError && err.structured.code === "UNKNOWN_VENUE") {
      throw new PerpError("UNKNOWN_VENUE", `Cannot normalize funding for unknown venue reference "${ref}"`, {
        remediation: "Use a registered venue id (or hl:<dex> for HIP-3). If the value came from persisted state "
          + "(~/.perp/arb-state.json or a bot state file), fix or remove that entry.",
      });
    }
    throw err;
  }
  return fundingBasisOf(ref);
}

/**
 * Hours one quoted funding rate covers for a venue ref.
 * Throws INVALID_PARAMS for per-market or annualized venues — use the market's basis.
 */
export function getFundingHours(ref: string): number {
  const basis = venueFundingBasis(ref);
  if (basis.kind !== "perHours") {
    throw new PerpError("INVALID_PARAMS", `Funding basis of "${ref}" is annualized, not a number of hours`, {
      remediation: "Use the market's fundingRateBasis with toHourlyRateByBasis()",
    });
  }
  return basis.hours;
}

/** Convert a raw quoted rate to a per-hour rate using an explicit (market) basis. */
export function toHourlyRateByBasis(rate: number, basis: FundingRateBasis): number {
  return rateToHourly(rate, basis);
}

/** Convert a raw funding rate to per-hour rate using the venue's basis. */
export function toHourlyRate(rate: number, ref: string): number {
  return rateToHourly(rate, venueFundingBasis(ref));
}

/** Annualize a raw rate from a specific exchange */
export function annualizeRate(rate: number, exchange: string): number {
  return annualizeHourlyRate(toHourlyRate(rate, exchange));
}

/** Annualize a raw rate quoted on an explicit (market) basis */
export function annualizeRateByBasis(rate: number, basis: FundingRateBasis): number {
  return annualizeHourlyRate(toHourlyRateByBasis(rate, basis));
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
 * Compute SIGNED annualized spread for an existing arb position.
 * Positive = favorable (short receiving more than long paying).
 * Negative = unfavorable (funding flipped, position losing on funding).
 *
 * For spot-perp: pass longRate=0, longExchange=shortExchange (spot has no funding).
 */
export function computeSignedAnnualSpread(
  shortRate: number, shortExchange: string,
  longRate: number, longExchange: string,
): number {
  const hourlyShort = toHourlyRate(shortRate, shortExchange);
  const hourlyLong = toHourlyRate(longRate, longExchange);
  return (hourlyShort - hourlyLong) * HOURLY_PERIODS * 100;
}

/**
 * Estimate hourly funding payment for a position.
 * @param rate - raw funding rate from the exchange
 * @param exchange - venue ref
 * @param positionUsd - position notional in USD
 * @param side - "long" or "short" (longs pay positive rate, shorts receive)
 * @returns hourly payment in USD (positive = you pay, negative = you receive)
 */
export function estimateHourlyFunding(
  rate: number, exchange: string,
  positionUsd: number, side: "long" | "short",
): number {
  return estimateHourlyFundingFromHourly(toHourlyRate(rate, exchange), positionUsd, side);
}

/** Same as estimateHourlyFunding, from an already-normalized hourly rate. */
export function estimateHourlyFundingFromHourly(
  hourlyRate: number, positionUsd: number, side: "long" | "short",
): number {
  // Long pays positive funding, short receives positive funding
  const multiplier = side === "long" ? 1 : -1;
  return hourlyRate * positionUsd * multiplier;
}
