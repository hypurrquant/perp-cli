import { PACIFICA_API_URL } from "./urls.js";
import { assertOk } from "./_http.js";
import { withCache, TTL_MARKET } from "../../cache.js";

// ── Types ──

interface PacificaAsset {
  symbol: string;
  funding: number;
  mark: number;
}

// ── Fetchers ──

export function fetchPacificaPrices(): Promise<PacificaAsset[]> {
  // SSOT rule #2: error must propagate. Row-level skipping is applied for
  // missing/invalid mark or funding so a 0 doesn't reach downstream paths.
  return withCache("pub:pac:prices", TTL_MARKET, async () => {
    const res = await fetch(PACIFICA_API_URL);
    await assertOk(res, "Pacifica prices");
    const json = await res.json();
    const data = (json as Record<string, unknown>).data ?? json;
    if (!Array.isArray(data)) return [];
    const out: PacificaAsset[] = [];
    for (const p of data as Record<string, unknown>[]) {
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
  return withCache("pub:pac:prices:raw", TTL_MARKET, async () => {
    const res = await fetch(PACIFICA_API_URL);
    await assertOk(res, "Pacifica prices");
    return res.json();
  });
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
