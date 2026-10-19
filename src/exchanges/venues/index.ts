/**
 * Venue registry bootstrap: registers every venue definition exactly once.
 * Importing this module (for its side effect) makes getVenue()/listVenues() usable.
 */

import { registerVenue, tryResolveVenueId } from "../venue.js";
import { arcusVenue } from "./arcus.js";
import { asterVenue } from "./aster.js";
import { hyperliquidVenue } from "./hyperliquid.js";
import { lighterRhVenue } from "./lighter-rh.js";
import { lighterVenue } from "./lighter.js";
import { ondoVenue } from "./ondo.js";
import { pacificaVenue } from "./pacifica.js";
import { qfexVenue } from "./qfex.js";
import { risexVenue } from "./risex.js";
import { txflowVenue } from "./txflow.js";
import { variationalVenue } from "./variational.js";
import { grvtVenue } from "./grvt.js";

export const ALL_VENUES = [
  pacificaVenue, hyperliquidVenue, lighterVenue, asterVenue,
  lighterRhVenue, ondoVenue, arcusVenue, qfexVenue, risexVenue, txflowVenue, variationalVenue, grvtVenue,
] as const;

/** Idempotent: registers all venues on first call, no-op afterwards. */
export function ensureVenuesRegistered(): void {
  for (const def of ALL_VENUES) {
    if (tryResolveVenueId(def.id) === null) registerVenue(def);
  }
}

ensureVenuesRegistered();

export {
  pacificaVenue, hyperliquidVenue, lighterVenue, asterVenue,
  lighterRhVenue, ondoVenue, arcusVenue, qfexVenue, risexVenue, txflowVenue, variationalVenue, grvtVenue,
};
