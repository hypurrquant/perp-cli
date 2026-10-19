/**
 * Venue ids and networks for perp-cli/ws. A local copy (src/ws imports only src/ws/**), kept in
 * line with src/exchanges/venue-types.ts by a parity test. Ids are stable.
 */

/**
 * Every perp-cli venue id. "ondo" and "qfex" are included for type stability but have no perp-cli/ws
 * codec (planned, not yet available: there is no `ondo` / `qfex` export to pass to createVenueStream).
 */
export type VenueId =
  | "pacifica" | "hyperliquid" | "lighter" | "aster"
  | "lighter-rh" | "ondo" | "arcus" | "qfex";

export const VENUE_IDS: readonly VenueId[] = [
  "pacifica", "hyperliquid", "lighter", "aster",
  "lighter-rh", "ondo", "arcus", "qfex",
];

export type Network = "mainnet" | "testnet";
