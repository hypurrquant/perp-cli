/**
 * Shared constants for perp-cli.
 */

import { loadSettings } from "./settings.js";

/**
 * Published taker fee per venue (fraction, e.g. 0.00035 = 0.035%) — configuration, not a
 * fallback (SSOT Rule #2 shipped defaults): used when settings.fees has no entry for the venue.
 */
export const TAKER_FEES: Record<string, number> = {
  // Hyperliquid base tier (docs trading/fees; info userFees of a zero-volume address:
  // userCrossRate 0.00045 / userAddRate 0.00015, read 2026-11-04): taker 0.045%, maker 0.015%.
  hyperliquid: 0.00045,
  // Pacifica tier 1 (docs trading-fees, read 2026-11-04): taker 0.040%, maker 0.015%.
  pacifica: 0.0004,
  lighter: 0,
  aster: 0.0004, // 0.04% taker fee
  // Ondo Perps base rate (docs.ondoperps.xyz/fees, 2026-10-02): taker 5 bps. A limited-time
  // 50% promotion (2.5 bps) is NOT assumed — it can end without notice; set
  // settings.fees.ondo to use the promotional or a volume-tier rate.
  ondo: 0.0005,
  // Arcus mainnet tier 0 "Base" since 2026-10-23 (GET https://api.arcus.xyz/v1/feetiers Base
  // maker_fee_ppm 150 / taker_fee_ppm 450; GET /v1/markets effectiveTakerFeePpm, read
  // 2026-11-04): crypto markets taker 450 ppm — the HIGHER class rate, so RWA orders (equities,
  // commodities, indices: taker 225 / maker 0 ppm) are never under-estimated. Higher-volume
  // tiers are cheaper (Bronze 380 … Max 190 ppm). The docs publish no rates ("read fees from the API").
  arcus: 0.00045,
  // Lighter RH "Standard" (default) account tier: 0% / 0% (apidocs.lighter.xyz lighter-rh).
  // "Plus" is 0.005%/0.005%; "Premium" is 0.0120%/0.0350% (maker/taker) down to
  // 0.0084%/0.0245% by 14-day volume — Premium accounts must set settings.fees["lighter-rh"].
  "lighter-rh": 0,
  // QFEX entry tier ("Tier 5", < $2m 30-day effective volume; docs.qfex.com/qfex/fees, read
  // 2026-10-04): taker 0.10% on single stocks — the HIGHEST class rate, so index / commodity
  // orders (0.05%) are never under-estimated. Lower tiers / the lifetime-tier promotion: set
  // settings.fees.qfex.
  qfex: 0.001,
  // RISEx Tier 1 ($0 rolling 14-day volume; docs.risechain.com/docs/risex/trading/fees, read
  // 2026-10-14): taker 3.00 bps, maker 1.00 bps; higher tiers down to 1.50 / 0.00 bps — set
  // settings.fees.risex for a higher tier.
  risex: 0.0003,
  // TxFlow: no trading in perp-cli (market data only) — no fee entry on purpose.
};

/**
 * Published maker fee per venue (fraction; negative = rebate). Only venues whose base-tier
 * maker rate is published and verified are listed; others resolve to 0 in getMakerFee().
 */
export const MAKER_FEES: Record<string, number> = {
  hyperliquid: 0.00015, // base tier 0.015%; see TAKER_FEES.hyperliquid
  pacifica: 0.00015,   // tier 1 0.015%; see TAKER_FEES.pacifica
  ondo: 0.0002,        // base 2 bps; promotional 1 bp not assumed (see TAKER_FEES.ondo)
  arcus: 0.00015,      // mainnet Base tier, crypto markets 150 ppm (RWA 0); see TAKER_FEES.arcus
  // Aster perpetuals, Crypto — General (docs.asterdex.com trading/perpetuals/fees-and-specs/fees,
  // read 2026-10-02): maker 0%, taker 0.04% (TAKER_FEES.aster). RWA markets: maker 0 bps.
  aster: 0,
  "lighter-rh": 0,     // Standard tier (Premium: 0.012% under $1M 14-day volume)
  qfex: 0.0005,        // Tier 5 single stocks 0.05% (indices / commodities 0.02%); see TAKER_FEES.qfex
  risex: 0.0001,       // Tier 1 maker 1.00 bps; see TAKER_FEES.risex
};

/**
 * Taker fee for a venue: settings.fees[venue].taker → TAKER_FEES[venue] → DEFAULT_TAKER_FEE
 * (estimate for venues without a published entry). loadSettings() errors (malformed
 * settings.json) propagate — never replaced by the built-in fees.
 */
export function getTakerFee(exchange: string): number {
  const key = exchange.toLowerCase();
  const configured = loadSettings().fees[key]?.taker;
  if (configured !== undefined) return configured;
  return TAKER_FEES[key] ?? DEFAULT_TAKER_FEE;
}

/**
 * Maker fee for a venue: settings.fees[venue].maker → MAKER_FEES[venue] → 0 (no maker fee
 * published/configured). loadSettings() errors propagate.
 */
export function getMakerFee(exchange: string): number {
  const key = exchange.toLowerCase();
  const configured = loadSettings().fees[key]?.maker;
  if (configured !== undefined) return configured;
  return MAKER_FEES[key] ?? 0;
}

/**
 * Taker-fee estimate for an id with no TAKER_FEES entry. Every venue id in VENUE_IDS has
 * a published entry above, so this applies only to genuinely unknown ids — e.g. arb-auto's
 * getTakerFee("default") and the venue-agnostic arb fee estimates. The Hyperliquid base taker
 * (0.045%), no lower than the other base takers of the original perp-perp arb venues (Pacifica
 * 0.040%, Aster 0.04%, Lighter 0%), so those estimates do not understate their fees.
 */
export const DEFAULT_TAKER_FEE = 0.00045;

/**
 * Hyperliquid's minimum order value, venue-wide (native perps and HIP-3 dexes): the venue refuses
 * smaller orders with "Order must have minimum value of $10". It is a documented constant, not a
 * field of `meta` / `metaAndAssetCtxs`, so it is the one order minimum that lives in code.
 */
export const HL_MIN_ORDER_VALUE_USD = "10";
