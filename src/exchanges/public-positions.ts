/**
 * Open positions of ANY account by its public address, keyless (`perp account positions
 * --address`, MCP get_positions_by_address). Wired into the registry through
 * VenuePublicData.fetchPositionsByAddress (+ addressKind); the rows come from the same mappers as
 * the keyed adapters' getPositions (hlPositionRows / lighterPositionRows / pacificaPositionRows),
 * with plain symbols. Read-only GETs / info POSTs; nothing is signed, no key is loaded.
 */
import { classifyError, PerpError } from "../errors.js";
import { getVenue, type Network, type PublicPosition, type PublicPositionsOptions, type PublicPositionsResult, type RateLimitPolicy } from "./venue.js";
import type { LighterVenueId } from "./venues/lighter-family.js";
import { acquireRate } from "./rate-limiter.js";

function errorOf(e: unknown, venue: string): { code: string; message: string } {
  const s = classifyError(e, venue);
  return { code: s.code, message: s.message };
}

/** A venue read failure as a typed error (the public HTTP helpers throw plain Errors on HTTP status). */
async function typed<T>(venue: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (e) {
    if (e instanceof PerpError) throw e;
    const s = classifyError(e, venue);
    throw new PerpError(s.code === "UNKNOWN" ? "EXCHANGE_ERROR" : s.code, s.message, { exchange: venue });
  }
}

/** Requests of a HIP-3 per-dex fan-out in flight at once. */
export const HL_DEX_FANOUT_CONCURRENCY = 4;
/** Burst of the fan-out's token bucket, in HL weight units (clearinghouseState weighs 2 → 10 requests). */
export const HL_DEX_FANOUT_BURST = 20;

/**
 * One `read` per HIP-3 dex, paced: at most HL_DEX_FANOUT_CONCURRENCY in flight, and every request
 * takes its weight from a token bucket refilled at the venue's documented rate
 * (hyperliquidVenue.rateLimit: 1200 weight / min = 20 / s; clearinghouseState weight 2) with a
 * small burst (HL_DEX_FANOUT_BURST) instead of the full minute's budget. HL mainnet lists ~10
 * dexes (no wait); testnet ~272, where an unpaced burst got HTTP 429 on 62 of 272 reads at
 * concurrency 4 — paced, the fan-out takes ~25 s instead. A failed read stays that dex's
 * (settled per dex); nothing is retried.
 */
export async function hlDexFanOut<T>(net: Network, dexes: readonly string[], read: (dex: string) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const venuePolicy = getVenue("hyperliquid").rateLimit;
  const policy: RateLimitPolicy = { capacity: HL_DEX_FANOUT_BURST, refillPerSec: venuePolicy.refillPerSec, weights: venuePolicy.weights };
  const out: PromiseSettledResult<T>[] = new Array(dexes.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < dexes.length) {
      const i = next++;
      try {
        await acquireRate(`hyperliquid:hip3-fanout:${net}`, policy, "clearinghouseState");
        out[i] = { status: "fulfilled", value: await read(dexes[i]) };
      } catch (e) {
        out[i] = { status: "rejected", reason: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HL_DEX_FANOUT_CONCURRENCY, dexes.length) }, worker));
  return out;
}

/** Hyperliquid `perpDexs` → HIP-3 dex names (the first entry, null, is the native dex). */
export function hlDexNamesOf(j: unknown): string[] {
  if (!Array.isArray(j)) throw new PerpError("EXCHANGE_ERROR", "hyperliquid perpDexs: expected an array", { exchange: "hyperliquid" });
  return (j as unknown[]).flatMap(d => (d !== null && typeof d === "object" && typeof (d as { name?: unknown }).name === "string" ? [(d as { name: string }).name] : []));
}

/** Account index of a Lighter account object. */
export function lighterAccountIndexOf(a: Record<string, unknown>): number {
  return Number(a.account_index ?? a.index);
}

/** The accounts of an address a read covers: every one, or the one of `accountIndex` (not one of the address's → INVALID_PARAMS). */
export function chooseLighterAccounts(venue: LighterVenueId, accounts: Array<Record<string, unknown>>, accountIndex: number | undefined): Array<Record<string, unknown>> {
  if (accountIndex === undefined) return accounts;
  const chosen = accounts.filter(a => lighterAccountIndexOf(a) === accountIndex);
  if (chosen.length === 0) {
    throw new PerpError("INVALID_PARAMS", `${venue}: account index ${accountIndex} is not an account of this address (accounts: ${accounts.map(lighterAccountIndexOf).join(", ")})`, {
      exchange: venue, remediation: `Use one of: ${accounts.map(lighterAccountIndexOf).join(", ")} — or drop --account-index for every account`,
    });
  }
  return chosen;
}

/**
 * Hyperliquid: info `clearinghouseState` {user} for the native perp dex plus {user, dex} for every
 * HIP-3 dex of `perpDexs` (one request each, paced: hlDexFanOut). Native rows carry `dex: null`, HIP-3 rows their dex
 * and the prefixed coin ("xyz:GOLD"), as the HIP-3 market rows. A dex (or the dex list) that
 * fails is an `errors` entry ("hip3:<dex>") — its rows are unknown, never silently dropped; the
 * native read failing fails the venue.
 */
export async function hyperliquidPositionsByAddress(net: Network, address: string): Promise<PublicPositionsResult> {
  const { legacyPublicJson } = await import("../funding/legacy-public.js");
  const { legacyPublicBaseUrl } = await import("../api/public/urls.js");
  const { hlPositionRows } = await import("./hyperliquid.js");
  const url = `${legacyPublicBaseUrl("hyperliquid", net)}/info`;
  const post = (body: Record<string, unknown>, label: string) => legacyPublicJson("hyperliquid", url, label, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const errors: PublicPositionsResult["errors"] = {};
  const [native, dexList] = await Promise.all([
    typed("hyperliquid", () => post({ type: "clearinghouseState", user: address }, "info clearinghouseState")),
    post({ type: "perpDexs" }, "info perpDexs").then(
      hlDexNamesOf,
      (e: unknown) => { errors.hip3 = errorOf(e, "hyperliquid"); return [] as string[]; },
    ),
  ]);
  const positions: PublicPosition[] = hlPositionRows(native as Record<string, unknown>, coin => coin).map(r => ({ ...r, dex: null }));
  const perDex = await hlDexFanOut(net, dexList, dex => post({ type: "clearinghouseState", user: address, dex }, `info clearinghouseState dex ${dex}`));
  perDex.forEach((res, i) => {
    const dex = dexList[i];
    if (res.status === "rejected") { errors[`hip3:${dex}`] = errorOf(res.reason, "hyperliquid"); return; }
    try {
      positions.push(...hlPositionRows(res.value as Record<string, unknown>, coin => (coin.includes(":") ? coin : `${dex}:${coin}`)).map(r => ({ ...r, dex })));
    } catch (e) { errors[`hip3:${dex}`] = errorOf(e, "hyperliquid"); }
  });
  return { positions, errors, notes: [] };
}

/**
 * Lighter / Lighter RH: `GET /account?by=l1_address` lists every account of the address
 * (sub-accounts); each account's rows are tagged with its `accountIndex`. The venue keeps a
 * zero-size row for every market an account ever touched: those are dropped by the mapper.
 * `accountIndex` narrows to one account (not one of the address's → INVALID_PARAMS).
 */
export async function lighterPositionsByAddress(venue: LighterVenueId, net: Network, address: string, opts: PublicPositionsOptions): Promise<PublicPositionsResult> {
  const { fetchLighterAccountsByL1, fetchLighterPriceDecimals } = await import("./lighter-public.js");
  const { lighterPositionRows } = await import("./lighter.js");
  const accounts = await fetchLighterAccountsByL1(venue, net, address);
  if (accounts === null || accounts.length === 0) return { positions: [], errors: {}, notes: [`no ${venue === "lighter" ? "Lighter" : "Lighter RH"} account for this address`] };
  const chosen = chooseLighterAccounts(venue, accounts, opts.accountIndex);
  const open = (a: Record<string, unknown>) => (Array.isArray(a.positions) ? a.positions as Array<Record<string, unknown>> : []).some(p => Number(p.position) !== 0);
  // Price decimals only when there is a mark to format (an account without positions costs one read).
  const decimals = chosen.some(open) ? await fetchLighterPriceDecimals(venue, net) : new Map<string, number>();
  const positions: PublicPosition[] = chosen.flatMap(a => lighterPositionRows(a.positions, venue, sym => decimals.get(sym.toUpperCase())).map(r => ({ ...r, accountIndex: lighterAccountIndexOf(a) })));
  return { positions, errors: {}, notes: [] };
}

/**
 * Pacifica: `GET /positions?account=` marked with `/info/prices`; unresolved leverage from the
 * account's public `/account/settings`, then the market max (`/info`). The address is validated
 * as base58 32 bytes by the caller (an EVM address would be answered `success: true, []`).
 */
export async function pacificaPositionsByAddress(net: Network, address: string): Promise<PublicPositionsResult> {
  const { PacificaClient } = await import("../pacifica/client.js");
  const { pacificaPositionRows } = await import("./pacifica.js");
  const { legacyPublicData } = await import("../funding/legacy-public.js");
  const client = new PacificaClient({ network: net });
  const [rows, prices] = await typed("pacifica", () => Promise.all([client.getPositions(address), client.getPrices()]));
  const positions = await pacificaPositionRows(rows, prices, {
    accountSettings: () => client.getAccountSettings(address),
    maxLeverage: async () => new Map((await legacyPublicData("pacifica").fetchMarkets(net)).map(m => [m.symbol, m.maxLeverage])),
  });
  return { positions, errors: {}, notes: [] };
}
