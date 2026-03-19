import { LIGHTER_API_URL } from "./urls.js";
import { withCache, TTL_MARKET } from "../../cache.js";

// ── Types ──

interface LighterMarketDetail {
  marketId: number;
  symbol: string;
  lastTradePrice: number;
}

export interface LighterFundingEntry {
  marketId: number;
  symbol: string;
  rate: number;
  markPrice: number;
}

// ── Fetchers ──

export function fetchLighterOrderBookDetails(): Promise<LighterMarketDetail[]> {
  return withCache("pub:lt:orderBookDetails", TTL_MARKET, async () => {
    try {
      const res = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookDetails`);
      const json = await res.json() as Record<string, unknown>;
      const details = (json.order_book_details ?? []) as Array<Record<string, unknown>>;
      return details.map(m => ({
        marketId: Number(m.market_id),
        symbol: String(m.symbol ?? ""),
        lastTradePrice: Number(m.last_trade_price ?? 0),
      }));
    } catch {
      return [];
    }
  });
}

export function fetchLighterOrderBookDetailsRaw(): Promise<unknown> {
  return withCache("pub:lt:orderBookDetails:raw", TTL_MARKET, () =>
    fetch(`${LIGHTER_API_URL}/api/v1/orderBookDetails`).then(r => r.json()).catch(() => null),
  );
}

export function fetchLighterFundingRates(): Promise<LighterFundingEntry[]> {
  return withCache("pub:lt:fundingRates", TTL_MARKET, async () => {
    try {
      const res = await fetch(`${LIGHTER_API_URL}/api/v1/funding-rates`);
      const json = await res.json() as Record<string, unknown>;
      const list = (json.funding_rates ?? []) as Array<Record<string, unknown>>;
      const entries: LighterFundingEntry[] = [];
      for (const fr of list) {
        if (String(fr.exchange ?? "").toLowerCase() !== "lighter") continue;
        entries.push({
          marketId: Number(fr.market_id),
          symbol: String(fr.symbol ?? ""),
          rate: Number(fr.rate ?? fr.funding_rate ?? 0),
          markPrice: Number(fr.mark_price ?? 0),
        });
      }
      return entries;
    } catch {
      return [];
    }
  });
}

export function fetchLighterFundingRatesRaw(): Promise<unknown> {
  return withCache("pub:lt:fundingRates:raw", TTL_MARKET, () =>
    fetch(`${LIGHTER_API_URL}/api/v1/funding-rates`).then(r => r.json()).catch(() => null),
  );
}

export function parseLighterRaw(
  detailsRaw: unknown,
  fundingRaw: unknown,
): { rates: Map<string, number>; prices: Map<string, number> } {
  const rates = new Map<string, number>();
  const prices = new Map<string, number>();

  const idToSym = new Map<number, string>();
  const idToPrice = new Map<number, number>();
  if (detailsRaw) {
    const details = ((detailsRaw as Record<string, unknown>).order_book_details ?? []) as Array<Record<string, unknown>>;
    for (const m of details) {
      const mid = Number(m.market_id);
      idToSym.set(mid, String(m.symbol ?? ""));
      const p = Number(m.last_trade_price ?? 0);
      if (p > 0) idToPrice.set(mid, p);
    }
  }

  if (fundingRaw) {
    const fundingList = ((fundingRaw as Record<string, unknown>).funding_rates ?? []) as Array<Record<string, unknown>>;
    for (const fr of fundingList) {
      // API returns rates from multiple exchanges — only use Lighter's own rates
      if (String(fr.exchange ?? "").toLowerCase() !== "lighter") continue;
      const sym = String(fr.symbol ?? "") || idToSym.get(Number(fr.market_id)) || "";
      if (!sym || rates.has(sym)) continue;
      rates.set(sym, Number(fr.rate ?? fr.funding_rate ?? 0));
      const mp = Number(fr.mark_price ?? 0) || idToPrice.get(Number(fr.market_id)) || 0;
      if (mp > 0) prices.set(sym, mp);
    }
  }

  for (const [mid, sym] of idToSym) {
    if (!prices.has(sym)) {
      const p = idToPrice.get(mid);
      if (p && p > 0) prices.set(sym, p);
    }
  }

  return { rates, prices };
}

// ── Health check ──

export async function pingLighter(): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookDetails`);
    return { ok: res.ok, latencyMs: Date.now() - start, status: res.status };
  } catch {
    return { ok: false, latencyMs: Date.now() - start, status: 0 };
  }
}
