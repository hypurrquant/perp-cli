import { PACIFICA_API_URL } from "./urls.js";
import { withCache, TTL_MARKET } from "../../cache.js";

// ── Types ──

interface PacificaAsset {
  symbol: string;
  funding: number;
  mark: number;
  nextFunding?: number;
}

// ── Fetchers ──

export function fetchPacificaPrices(): Promise<PacificaAsset[]> {
  return withCache("pub:pac:prices", TTL_MARKET, async () => {
    try {
      const res = await fetch(PACIFICA_API_URL);
      const json = await res.json();
      const data = (json as Record<string, unknown>).data ?? json;
      if (!Array.isArray(data)) return [];
      return data.map((p: Record<string, unknown>) => ({
        symbol: String(p.symbol ?? ""),
        funding: Number(p.next_funding ?? p.funding ?? 0),
        mark: Number(p.mark ?? 0),
        nextFunding: p.next_funding ? Number(p.next_funding) : undefined,
      }));
    } catch {
      return [];
    }
  });
}

export function fetchPacificaPricesRaw(): Promise<unknown> {
  return withCache("pub:pac:prices:raw", TTL_MARKET, () =>
    fetch(PACIFICA_API_URL).then(r => r.json()).catch(() => null),
  );
}

export function parsePacificaRaw(raw: unknown): { rates: Map<string, number>; prices: Map<string, number> } {
  const rates = new Map<string, number>();
  const prices = new Map<string, number>();
  const data = (raw as Record<string, unknown>)?.data ?? raw;
  if (!Array.isArray(data)) return { rates, prices };
  for (const p of data as Record<string, unknown>[]) {
    const sym = String(p.symbol ?? "");
    if (!sym) continue;
    rates.set(sym, Number(p.next_funding ?? p.funding ?? 0));
    const mark = Number(p.mark ?? p.price ?? 0);
    if (mark > 0) prices.set(sym, mark);
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
