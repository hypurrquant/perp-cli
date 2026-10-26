/**
 * `perp account balance --address` and MCP get_balance_by_address: one read path over the
 * registry (VenuePublicData.fetchBalanceByAddress). Keyless; nothing is signed.
 */
import { PerpError } from "./errors.js";
import { fetchBalanceByAddress, getVenue, listPublicBalanceVenues, type Network, type PublicBalanceResult } from "./exchanges/venue.js";

/**
 * The JSON shape of one venue's answer: `balance` and `spot` always (null = not published / per
 * account), the venue-specific keys only on their venue (Lighter `accounts`, Hyperliquid `dexes` +
 * `accountMode`).
 */
export type BalanceData = Pick<PublicBalanceResult, "balance" | "spot">
  & Partial<{ accounts: NonNullable<PublicBalanceResult["accounts"]>; dexes: NonNullable<PublicBalanceResult["dexes"]>; accountMode: string }>;

export interface AddressBalance {
  venue: string;
  data: BalanceData;
  /** Sub-reads that failed (Hyperliquid HIP-3 dex), keyed "hip3:<dex>". */
  errors: Record<string, { code: string; message: string }>;
  notes: string[];
  /** One human line per failed sub-read: its balance is unknown, not zero. */
  warnings: string[];
}

export interface AddressBalanceOptions {
  accountIndex?: number;
}

function dataOf(r: PublicBalanceResult): BalanceData {
  return {
    balance: r.balance,
    spot: r.spot,
    ...(r.accounts !== null ? { accounts: r.accounts } : {}),
    ...(r.dexes !== null ? { dexes: r.dexes } : {}),
    ...(r.accountMode !== null ? { accountMode: r.accountMode } : {}),
  };
}

function warningsOf(venue: string, errors: Record<string, { code: string; message: string }>): string[] {
  return Object.entries(errors).map(([src, e]) => `${venue} ${src} unavailable (${e.code}: ${e.message}) — its balance is missing from this answer (unknown, not zero)`);
}

export async function readBalanceByAddress(venue: string, net: Network, address: string, opts: AddressBalanceOptions = {}): Promise<AddressBalance> {
  const id = getVenue(venue).id;
  const r = await fetchBalanceByAddress(id, net, address, { accountIndex: opts.accountIndex });
  return { venue: id, data: dataOf(r), errors: r.errors, notes: r.notes, warnings: warningsOf(id, r.errors) };
}

export interface AddressBalanceFanOut {
  venues: Record<string, BalanceData>;
  /** A venue that failed (`<venue>`) or a failed sub-read of a venue (`<venue>:hip3:<dex>`). */
  errors: Record<string, { code: string; message: string }>;
  notes: Record<string, string[]>;
  warnings: string[];
}

/** Every venue that reads balances by address; a venue that fails (address format included) is an `errors` entry. */
export async function readBalanceByAddressAll(net: Network, address: string, opts: AddressBalanceOptions = {}): Promise<AddressBalanceFanOut> {
  const venues = listPublicBalanceVenues().map(v => v.id);
  const out: AddressBalanceFanOut = { venues: {}, errors: {}, notes: {}, warnings: [] };
  const settled = await Promise.allSettled(venues.map(v => readBalanceByAddress(v, net, address, v === "lighter" || v === "lighter-rh" ? opts : {})));
  settled.forEach((res, i) => {
    const v = venues[i];
    if (res.status === "rejected") {
      const e = res.reason;
      out.errors[v] = e instanceof PerpError ? { code: e.structured.code, message: e.structured.message } : { code: "EXCHANGE_ERROR", message: e instanceof Error ? e.message : String(e) };
      return;
    }
    out.venues[v] = res.value.data;
    for (const [src, e] of Object.entries(res.value.errors)) out.errors[`${v}:${src}`] = e;
    if (res.value.notes.length > 0) out.notes[v] = res.value.notes;
    out.warnings.push(...res.value.warnings);
  });
  return out;
}
