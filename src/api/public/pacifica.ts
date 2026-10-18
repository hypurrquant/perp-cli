import { PACIFICA_API_URL, PACIFICA_INFO_URL, sharedApiNetwork } from "./urls.js";
import { PerpError } from "../../errors.js";
import { isPacificaPerpetual } from "../../ws/pacifica-instrument.js";
import { assertOk } from "./_http.js";
import { withCache, TTL_MARKET } from "../../cache.js";

// ── Types ──

interface PacificaAsset {
  symbol: string;
  funding: number;
  mark: number;
}

// ── Fetchers ──

/**
 * Symbols of GET /info rows with instrument_type "perpetual". `/info/prices` also lists spot
 * markets (SOL-USDC) — they must not reach arb / funding-arb as perps. A row without the field
 * cannot be classified → EXCHANGE_ERROR (same rule as the adapter's getMarkets).
 */
function fetchPacificaPerpSymbols(): Promise<Set<string>> {
  return withCache(`pub:pac:${sharedApiNetwork()}:perps`, TTL_MARKET, async () => {
    const res = await fetch(PACIFICA_INFO_URL);
    await assertOk(res, "Pacifica info");
    const json = (await res.json()) as Record<string, unknown>;
    if (!Array.isArray(json.data)) {
      throw new PerpError("EXCHANGE_ERROR", "Pacifica GET /info has no data array", { exchange: "pacifica" });
    }
    const out = new Set<string>();
    for (const m of json.data as Record<string, unknown>[]) {
      if (typeof m.instrument_type !== "string") {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica /info row ${String(m.symbol)} has no instrument_type`, { exchange: "pacifica" });
      }
      if (isPacificaPerpetual(m)) out.add(String(m.symbol));
    }
    return out;
  });
}

/** `/info/prices` envelope reduced to perp rows (`{ data }`, the shape parsePacificaRaw reads). */
async function fetchPacificaPerpPrices(): Promise<{ data: Record<string, unknown>[] }> {
  const [res, perps] = await Promise.all([fetch(PACIFICA_API_URL), fetchPacificaPerpSymbols()]);
  await assertOk(res, "Pacifica prices");
  const json = await res.json();
  const data = (json as Record<string, unknown>).data ?? json;
  if (!Array.isArray(data)) return { data: [] };
  return { data: (data as Record<string, unknown>[]).filter((p) => perps.has(String(p.symbol))) };
}

export function fetchPacificaPrices(): Promise<PacificaAsset[]> {
  // SSOT rule #2: error must propagate. Row-level skipping is applied for
  // missing/invalid mark or funding so a 0 doesn't reach downstream paths.
  return withCache(`pub:pac:${sharedApiNetwork()}:prices:perp`, TTL_MARKET, async () => {
    const { data } = await fetchPacificaPerpPrices();
    const out: PacificaAsset[] = [];
    for (const p of data) {
      const symbol = String(p.symbol ?? "");
      const fundingRaw = p.next_funding ?? p.funding;
      const funding = Number(fundingRaw);
      const mark = Number(p.mark);
      if (!symbol || fundingRaw === undefined || !Number.isFinite(funding) || !Number.isFinite(mark) || mark <= 0) {
        continue;
      }
      out.push({ symbol, funding, mark });
    }
    return out;
  });
}

export function fetchPacificaPricesRaw(): Promise<unknown> {
  // SSOT rule #2: caller is responsible for error handling. Removed silent
  // `.catch(() => null)` so a network failure surfaces as a rejected Promise.
  // Callers should wrap with Promise.allSettled to keep multi-DEX comparisons
  // running when one DEX is down. Non-2xx responses are also rejected so a
  // 5xx JSON body cannot fulfill as if it were valid data.
  // Perp rows only (spot SOL-USDC dropped via /info instrument_type).
  return withCache(`pub:pac:${sharedApiNetwork()}:prices:raw:perp`, TTL_MARKET, fetchPacificaPerpPrices);
}

export function parsePacificaRaw(raw: unknown): { rates: Map<string, number>; prices: Map<string, number> } {
  const rates = new Map<string, number>();
  const prices = new Map<string, number>();
  const data = (raw as Record<string, unknown>)?.data ?? raw;
  if (!Array.isArray(data)) return { rates, prices };
  for (const p of data as Record<string, unknown>[]) {
    const sym = String(p.symbol ?? "");
    if (!sym) continue;
    // SSOT rule #2: skip rows missing real funding/mark; never publish 0.
    const fundingRaw = p.next_funding ?? p.funding;
    const fundingNumber = Number(fundingRaw);
    if (fundingRaw !== undefined && Number.isFinite(fundingNumber)) {
      rates.set(sym, fundingNumber);
    }
    const markCandidates = [Number(p.mark), Number(p.price)];
    const mark = markCandidates.find(v => Number.isFinite(v) && v > 0);
    if (mark !== undefined) prices.set(sym, mark);
  }
  return { rates, prices };
}

// ── Health check ──

export async function pingPacifica(): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const start = Date.now();
  try {
    const res = await fetch(PACIFICA_API_URL);
    return { ok: res.ok, latencyMs: Date.now() - start, status: res.status };
  } catch {
    return { ok: false, latencyMs: Date.now() - start, status: 0 };
  }
}
