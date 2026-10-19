/**
 * Venue connectivity probe — the one implementation behind `perp health`,
 * `perp portfolio --health` and the MCP `health_check` tool.
 *
 * Pacifica / Hyperliquid / Lighter / Aster / QFEX / GRVT: a REST ping (status = HTTP status, 0 = no
 * response). Every other venue — including read-only (market-data-only) venues such as TxFlow —
 * is probed with its public market-data read (status null). A venue with no environment on the
 * selected network (TxFlow has no testnet) is not probed and is listed in `skipped`.
 *
 * The ping helpers (shared-api) read the shared API URLs, which follow the network the caller
 * selected (setSharedApiNetwork); Aster / QFEX / market-data probes take `network` directly.
 */

import { extractErrorMessage } from "./errors.js";
import { getVenue, listVenues, networkConfig, type VenueDefinition } from "./exchanges/venue.js";
import type { Network, VenueId } from "./exchanges/venue-types.js";
import { pingHyperliquid, pingLighter, pingPacifica } from "./shared-api.js";
import "./exchanges/venues/index.js";

export interface VenueProbe {
  venue: VenueId;
  ok: boolean;
  latencyMs: number;
  /** HTTP status of a REST ping (0 = no response); null for a market-data probe. */
  status: number | null;
  /** null when ok. */
  error: string | null;
  probe: "ping" | "markets";
  /** "unofficial" = the venue is read through an undocumented API (VenueDefinition.apiStatus). */
  apiStatus: "official" | "unofficial";
}

export interface VenueHealth {
  probes: VenueProbe[];
  /** Venues requested but not probed: no environment on `network`. */
  skipped: Array<{ venue: VenueId; reason: string }>;
  allHealthy: boolean;
}

type Result = Omit<VenueProbe, "venue" | "apiStatus">;

async function timed(probe: VenueProbe["probe"], fn: () => Promise<{ ok: boolean; status: number | null }>): Promise<Result> {
  const start = Date.now();
  try {
    const r = await fn();
    return { ok: r.ok, latencyMs: Date.now() - start, status: r.status, error: r.ok ? null : `HTTP ${r.status}`, probe };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, status: probe === "ping" ? 0 : null, error: extractErrorMessage(e), probe };
  }
}

const restPing = (url: string) => timed("ping", async () => {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status };
});

/** shared-api helpers report a transport failure as status 0 with no message. */
const helperPing = (fn: () => Promise<{ ok: boolean; latencyMs: number; status: number }>) => async (): Promise<Result> => {
  const r = await fn();
  return { ...r, error: r.ok ? null : r.status === 0 ? "no response" : `HTTP ${r.status}`, probe: "ping" };
};

function pingFor(id: VenueId, network: Network): (() => Promise<Result>) | null {
  switch (id) {
    case "pacifica": return helperPing(pingPacifica);
    case "hyperliquid": return helperPing(pingHyperliquid);
    case "lighter": return helperPing(pingLighter);
    case "aster": return () => restPing(`${networkConfig(getVenue("aster"), network).restUrl}/fapi/v1/time`);
    // QFEX: public GET /refdata for one instrument.
    case "qfex": return () => restPing(`${networkConfig(getVenue("qfex"), network).restUrl}/refdata?ticker=AAPL-USD`);
    // GRVT: one public instrument read (the market-data probe would fan out over every ticker).
    case "grvt": return () => timed("ping", async () => {
      const res = await fetch(`${networkConfig(getVenue("grvt"), network).restUrl}/full/v1/instrument`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instrument: "BTC_USDT_Perp" }),
      });
      return { ok: res.ok, status: res.status };
    });
    default: return null;
  }
}

/**
 * Probe `venueIds` (default: every registered venue) on `network`, in parallel. Never throws for a
 * venue failure — each failure is a probe with ok:false and its message.
 */
export async function probeVenueHealth(network: Network, venueIds?: readonly string[]): Promise<VenueHealth> {
  const defs: VenueDefinition[] = venueIds === undefined ? listVenues() : venueIds.map(id => getVenue(id));
  const skipped: VenueHealth["skipped"] = [];
  const probed = defs.filter(v => {
    if (v.networks[network] !== null) return true;
    skipped.push({ venue: v.id, reason: `${v.displayName} has no ${network} environment` });
    return false;
  });
  const results = await Promise.all(probed.map(v => {
    const ping = pingFor(v.id, network);
    return ping !== null
      ? ping()
      : timed("markets", async () => { await v.publicData.fetchMarkets(network, { funding: false }); return { ok: true, status: null }; });
  }));
  const probes = probed.map((v, i): VenueProbe => ({ venue: v.id, ...results[i], apiStatus: v.apiStatus.kind }));
  return { probes, skipped, allHealthy: probes.every(p => p.ok) };
}
