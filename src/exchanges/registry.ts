/**
 * Adapter registry — legacy name/alias API, now derived from the venue
 * definitions (src/exchanges/venues/). New venues are added by
 * registering a VenueDefinition, not here.
 */

import { getVenue, listVenues, tryResolveVenueId, type VenueDefinition } from "./venue.js";
import "./venues/index.js";

export interface AdapterRegistration {
  name: string;
  aliases: string[];
  /**
   * Legacy field = the adapter's `chain` value (pacifica "solana", hyperliquid "evm",
   * lighter "ethereum", aster "bnb"). For key-kind decisions use the venue's
   * masterKeyKind; for where funds live use networks.<net>.settlementChain.
   */
  chain: string;
}

function toRegistration(def: VenueDefinition): AdapterRegistration {
  // HyperliquidAdapter.chain is "evm"; every other adapter's chain is its mainnet settlement chain.
  const chain = def.family === "hyperliquid" ? "evm" : def.networks.mainnet.settlementChain;
  return { name: def.id, aliases: [...def.aliases], chain };
}

/**
 * @deprecated Registration happens through VenueDefinition (registerVenue in ./venue.ts).
 * Kept for API compatibility; throws so a stray call cannot create an adapter-less entry.
 */
export function registerAdapter(reg: AdapterRegistration): void {
  throw new Error(`registerAdapter("${reg.name}") is no longer supported — add a VenueDefinition under src/exchanges/venues/`);
}

export function getAdapterRegistration(nameOrAlias: string): AdapterRegistration | undefined {
  const id = tryResolveVenueId(nameOrAlias);
  return id === null ? undefined : toRegistration(getVenue(id));
}

export function listExchanges(): string[] {
  return listVenues().map(v => v.id);
}

/** Resolve an alias to its canonical venue id. Throws UNKNOWN_VENUE for unknown names. */
export function resolveExchangeName(nameOrAlias: string): string {
  return getVenue(nameOrAlias).id;
}
