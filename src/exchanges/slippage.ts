/**
 * Single slippage resolver for every market-type order.
 *
 * Precedence (all explicit configuration, no hidden constants):
 *   --slippage-bps flag → settings.slippageBps[venue] → settings.defaultSlippageBps.
 * Adapters never read settings; they receive the resolved value as an argument.
 */

import { PerpError } from "../errors.js";
import { loadSettings, isValidSlippageBps } from "../settings.js";
import { getVenue, listVenuesWithRole, resolveVenueId } from "./venue.js";
import type { VenueId } from "./venue-types.js";
import "./venues/index.js";

export type SlippageSource = "flag" | "venue" | "default";

export interface ResolvedSlippage {
  bps: number;
  source: SlippageSource;
}

/** Largest slippage bound (bps) the venue accepts (VenueDefinition.maxSlippageBps). */
export function venueMaxSlippageBps(venue: VenueId): number {
  return getVenue(venue).maxSlippageBps;
}

/** defaultSlippageBps applies to every trading venue, so it must fit the tightest venue maximum. */
export function maxDefaultSlippageBps(): number {
  return Math.min(...listVenuesWithRole("trading").map(v => v.maxSlippageBps));
}

/**
 * Parse a bps value for a settings key (`defaultSlippageBps` / `slippageBps.<venue>`):
 * a number ≥ 1 and ≤ `max`. Out of range → INVALID_PARAMS; never clamps.
 * Shared by `perp settings set` and `perp setup` so both accept exactly what resolveSlippage() accepts.
 */
export function parseSlippageSettingBps(key: string, value: string, max: number): number {
  const bps = Number(value);
  if (!isValidSlippageBps(bps) || bps > max) {
    throw new PerpError("INVALID_PARAMS", `${key} must be a number of basis points in 1..${max} (got "${value}")`);
  }
  return bps;
}

/**
 * Resolve the slippage bound for a market-type order on `venue`.
 * `flagBps` = caller's explicit per-call value (CLI --slippage-bps), null when absent.
 * Out of range (bps < 1 or > venue max) → INVALID_PARAMS before anything is sent; never clamps.
 */
export function resolveSlippage(venue: VenueId, flagBps: number | null): ResolvedSlippage {
  let resolved: ResolvedSlippage;
  if (flagBps !== null) {
    resolved = { bps: flagBps, source: "flag" };
  } else {
    const s = loadSettings();
    const perVenue = s.slippageBps[venue];
    resolved = perVenue !== undefined
      ? { bps: perVenue, source: "venue" }
      : { bps: s.defaultSlippageBps, source: "default" };
  }
  const max = venueMaxSlippageBps(venue);
  if (!Number.isFinite(resolved.bps) || resolved.bps < 1 || resolved.bps > max) {
    const where = resolved.source === "flag" ? "--slippage-bps"
      : resolved.source === "venue" ? `settings slippageBps.${venue}` : "settings defaultSlippageBps";
    throw new PerpError("INVALID_PARAMS", `Slippage bound ${resolved.bps} bps (from ${where}) is outside 1..${max} bps for ${venue}`, {
      exchange: venue,
      remediation: resolved.source === "flag"
        ? `Pass --slippage-bps between 1 and ${max}`
        : resolved.source === "venue"
          ? `Run: perp settings set slippageBps.${venue} <1..${max}> (or perp settings unset slippageBps.${venue})`
          : `Run: perp settings set defaultSlippageBps <1..${max}> (or perp settings set slippageBps.${venue} <n>)`,
    });
  }
  return resolved;
}

/**
 * resolveSlippage() for an adapter (its `name` is a venue id). Bot/arb paths pass
 * flagBps = null, so the bound comes from settings (slippageBps[venue] → defaultSlippageBps).
 */
export function resolveAdapterSlippage(adapter: { readonly name: string }, flagBps: number | null): ResolvedSlippage {
  return resolveSlippage(resolveVenueId(adapter.name), flagBps);
}
