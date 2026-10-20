/**
 * `perp account positions --address` and MCP get_positions_by_address: one read path over the
 * registry (VenuePublicData.fetchPositionsByAddress). Keyless; nothing is signed.
 */
import { PerpError } from "./errors.js";
import { fetchPositionsByAddress, getVenue, listPublicPositionVenues, type Network, type PublicPosition } from "./exchanges/venue.js";
import { bareSymbolOf } from "./commands/market.js";

export interface AddressPositions {
  venue: string;
  positions: PublicPosition[];
  /** Sub-reads that failed (Hyperliquid HIP-3 dex), keyed "hip3:<dex>". */
  errors: Record<string, { code: string; message: string }>;
  notes: string[];
  /** One human line per failed sub-read: its rows are unknown, not absent. */
  warnings: string[];
}

export interface AddressPositionsOptions {
  accountIndex?: number;
  symbol?: string;
}

/** Rows of `symbol` (plain asset; HIP-3 "xyz:GOLD" also matches "GOLD"; "BTC-PERP" matches "BTC"). */
export function filterPositionsBySymbol<T extends { symbol: string }>(rows: T[], symbol: string | undefined): T[] {
  if (symbol === undefined) return rows;
  const want = bareSymbolOf(symbol).toUpperCase();
  return rows.filter(r => {
    const s = r.symbol.toUpperCase();
    return s === want || bareSymbolOf(r.symbol).toUpperCase() === want || s.split(":").pop() === want;
  });
}

function warningsOf(venue: string, errors: Record<string, { code: string; message: string }>): string[] {
  return Object.entries(errors).map(([src, e]) => `${venue} ${src} unavailable (${e.code}: ${e.message}) — its positions are missing from this answer`);
}

export async function readPositionsByAddress(venue: string, net: Network, address: string, opts: AddressPositionsOptions = {}): Promise<AddressPositions> {
  const id = getVenue(venue).id;
  const r = await fetchPositionsByAddress(id, net, address, { accountIndex: opts.accountIndex });
  return { venue: id, positions: filterPositionsBySymbol(r.positions, opts.symbol), errors: r.errors, notes: r.notes, warnings: warningsOf(id, r.errors) };
}

export interface AddressPositionsFanOut {
  venues: Record<string, PublicPosition[]>;
  /** A venue that failed (`<venue>`) or a failed sub-read of a venue (`<venue>:hip3:<dex>`). */
  errors: Record<string, { code: string; message: string }>;
  notes: Record<string, string[]>;
  warnings: string[];
}

/** Every venue that reads positions by address; a venue that fails (address format included) is an `errors` entry. */
export async function readPositionsByAddressAll(net: Network, address: string, opts: AddressPositionsOptions = {}): Promise<AddressPositionsFanOut> {
  const venues = listPublicPositionVenues().map(v => v.id);
  const out: AddressPositionsFanOut = { venues: {}, errors: {}, notes: {}, warnings: [] };
  const settled = await Promise.allSettled(venues.map(v => readPositionsByAddress(v, net, address, opts.accountIndex !== undefined && v !== "lighter" && v !== "lighter-rh" ? { symbol: opts.symbol } : opts)));
  settled.forEach((res, i) => {
    const v = venues[i];
    if (res.status === "rejected") {
      const e = res.reason;
      out.errors[v] = e instanceof PerpError ? { code: e.structured.code, message: e.structured.message } : { code: "EXCHANGE_ERROR", message: e instanceof Error ? e.message : String(e) };
      return;
    }
    out.venues[v] = res.value.positions;
    for (const [src, e] of Object.entries(res.value.errors)) out.errors[`${v}:${src}`] = e;
    if (res.value.notes.length > 0) out.notes[v] = res.value.notes;
    out.warnings.push(...res.value.warnings);
  });
  return out;
}
