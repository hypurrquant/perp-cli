/**
 * Cross-venue canonical symbols — the single mapping source used to decide
 * that two markets on different venues are the same underlying.
 *
 * Rules by asset class:
 * - crypto:  ticker identity after the adapter strips its quote suffix, plus
 *            DENOMINATION_ALIASES (kPEPE ≡ 1000PEPE, UBTC ≡ BTC ...).
 * - equity / etf: exchange-listed ticker identity (TSLA on Ondo ≡ TSLA on
 *            Arcus ≡ TSLA on Lighter RH ≡ xyz:TSLA on HIP-3). Adapters must
 *            pass the plain ticker (e.g. strip Ondo's "-USD.P").
 * - index / commodity / fx / preIpo: EXPLICIT table only. Same-looking names
 *            are frequently different products (US500 vs USA500, USOIL vs CL),
 *            so an unmapped market returns null and is excluded from matching.
 */

import type { AssetClass, VenueId } from "./venue-types.js";

/** Denomination / wrapper aliases → canonical crypto ticker. */
export const DENOMINATION_ALIASES: Readonly<Record<string, string>> = {
  KPEPE: "1000PEPE",
  "1000PEPE": "1000PEPE",
  KSHIB: "1000SHIB",
  KBONK: "1000BONK",
  KFLOKI: "1000FLOKI",
  KLUNC: "1000LUNC",
  KNEIRO: "1000NEIRO",
  KDOGS: "1000DOGS",
  // Hyperliquid spot wrapper tokens (was SPOT_PERP_TOKEN_MAP)
  UBTC: "BTC",
  UETH: "ETH",
  USOL: "SOL",
  UFART: "FARTCOIN",
  UPUMP: "PUMP",
  LINK0: "LINK",
  AVAX0: "AVAX",
  AAVE0: "AAVE",
};

/**
 * Explicit mapping for index / commodity / fx / preIpo markets.
 * Key: `${venue}|${symbol}` (symbol as the adapter reports it; for HIP-3 use `hl:<dex>` as venue).
 */
export const EXPLICIT_CANONICAL: Readonly<Record<string, string>> = {
  // Gold / silver spot-referenced perps
  "ondo|XAU": "GOLD",
  "ondo|XAG": "SILVER",
  "lighter-rh|XAU": "GOLD",
  "lighter-rh|XAG": "SILVER",
  "hl:xyz|GOLD": "GOLD",
  "hl:xyz|SILVER": "SILVER",
  "qfex|GOLD": "GOLD",
  "qfex|SILVER": "SILVER",
  "risex|XAU": "GOLD",
  "risex|XAG": "SILVER",
  "txflow|XAU": "GOLD",
  "txflow|XAG": "SILVER",
  "variational|XAU": "GOLD",
  "variational|XAG": "SILVER",
  // Crude oil (WTI)
  "ondo|WTI": "CRUDE_OIL_WTI",
  "hl:xyz|CL": "CRUDE_OIL_WTI",
  "hl:flx|OIL": "CRUDE_OIL_WTI",
  // QFEX CL blends expiring futures; roll-week gaps are caught by the cross-venue price filter.
  "qfex|CL": "CRUDE_OIL_WTI",
  "risex|CL": "CRUDE_OIL_WTI",
  // Brent crude
  "risex|BZ": "CRUDE_OIL_BRENT",
  "txflow|BZ": "CRUDE_OIL_BRENT",
  "txflow|CL": "CRUDE_OIL_WTI",
  "variational|BZ": "CRUDE_OIL_BRENT",
  "variational|CL": "CRUDE_OIL_WTI",
  // US equity indices
  "ondo|US500": "SPX",
  "ondo|US100": "NDX",
  "qfex|US500": "SPX",
  "qfex|US100": "NDX",
  // FX
  "ondo|USDJPY": "USDJPY",
};

/** Pairs verified to be DIFFERENT products despite similar names. Never match. */
export const NEVER_MATCH: ReadonlySet<string> = new Set([
  "USAR:US500", "USAR:USA500", "US500:USA500",
  "SEMI:SEMIS",
  "USOIL:CL", "USOIL:OIL",
  "GOLDJM:GOLD", "GLDMINE:GOLD",
  "SILVERJM:SILVER",
  "URNM:URANIUM",
  "NUCLEAR:ENERGY", "NUCLEAR:USENERGY",
]);

export function isNeverMatch(a: string, b: string): boolean {
  return NEVER_MATCH.has(`${a}:${b}`) || NEVER_MATCH.has(`${b}:${a}`);
}

/**
 * Canonical key for a market, or null when it must not be matched across venues.
 * @param venueKey venue id, or `hl:<dex>` for HIP-3 dex markets
 * @param symbol   plain symbol as reported by the adapter (no quote suffix, no dex prefix)
 */
export function canonicalFor(venueKey: VenueId | `hl:${string}`, symbol: string, assetClass: AssetClass): string | null {
  const up = symbol.toUpperCase();
  switch (assetClass) {
    case "crypto":
      return DENOMINATION_ALIASES[up] ?? up; // ticker identity is the rule for crypto; the alias table overrides it
    case "equity":
    case "etf":
      return up;
    case "index":
    case "commodity":
    case "fx":
    case "preIpo":
      return EXPLICIT_CANONICAL[`${venueKey}|${up}`] ?? null;
  }
}
