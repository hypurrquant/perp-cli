/**
 * Options venues (read-only market data). Separate from the perp venue registry (`venue.ts`):
 * an options venue is not a perp venue, so it never appears in `perp health`, arb scans or the
 * perp market commands. `perp options` and the MCP `get_option_*` tools resolve venues here only.
 */

import { PerpError } from "../errors.js";
import type { OptionsVenue } from "./options-interface.js";
import type { Network } from "./venue-types.js";

interface OptionsVenueEntry {
  id: string;
  aliases: readonly string[];
  displayName: string;
  /** Lazy: the venue module is only loaded when options data is requested. */
  create(network: Network): Promise<OptionsVenue>;
}

const OPTIONS_VENUES: readonly OptionsVenueEntry[] = [
  {
    id: "derive",
    aliases: ["drv"],
    displayName: "Derive",
    async create(network) {
      const { DeriveOptionsVenue } = await import("./derive/options.js");
      return DeriveOptionsVenue.forNetwork(network);
    },
  },
];

/** Option venue ids and aliases (for argv classification). */
export function optionsVenueWords(): string[] {
  return OPTIONS_VENUES.flatMap(v => [v.id, ...v.aliases]);
}

export function listOptionsVenueIds(): string[] {
  return OPTIONS_VENUES.map(v => v.id);
}

/** The options venue `input` names (id or alias, case-insensitive) — CAPABILITY_UNSUPPORTED otherwise. */
export async function getOptionsVenue(input: string, network: Network): Promise<OptionsVenue> {
  const want = input.trim().toLowerCase();
  const entry = OPTIONS_VENUES.find(v => v.id === want || v.aliases.includes(want));
  if (entry === undefined) {
    throw new PerpError("CAPABILITY_UNSUPPORTED", `"${input}" has no options market data in perp-cli; options venues: ${listOptionsVenueIds().join(", ")}`, {
      remediation: `Use -e ${OPTIONS_VENUES[0].id} (e.g. perp -e ${OPTIONS_VENUES[0].id} options expiries ETH)`,
    });
  }
  return entry.create(network);
}
