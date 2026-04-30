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
  /**
   * Lighter's funding-rates endpoint sends mark_price intermittently —
   * not every row carries it. Consumers must resolve the actual mark price
   * by falling back to orderBookDetails.lastTradePrice when this is null.
   * SSOT rule #2 lives at the CONSUMER (resolve or skip), not here.
   */
  markPrice: number | null;
}

// ── Fetchers ──

export function fetchLighterOrderBookDetails(): Promise<LighterMarketDetail[]> {
  // SSOT rule #2: error must propagate; callers cannot distinguish "API
  // returned no markets" from "API down" otherwise. Row-level skipping is
  // applied for missing/invalid last_trade_price so we never publish a
  // 0 price downstream.
  return withCache("pub:lt:orderBookDetails", TTL_MARKET, async () => {
    const res = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookDetails`);
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Lighter orderBookDetails returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = await res.json() as Record<string, unknown>;
    const details = (json.order_book_details ?? []) as Array<Record<string, unknown>>;
    const out: LighterMarketDetail[] = [];
    for (const m of details) {
      const marketId = Number(m.market_id);
      const symbol = String(m.symbol ?? "");
      const lastTradePrice = Number(m.last_trade_price);
      if (!Number.isFinite(marketId) || !symbol || !Number.isFinite(lastTradePrice) || lastTradePrice <= 0) {
        continue;
      }
      out.push({ marketId, symbol, lastTradePrice });
    }
    return out;
  });
}

export function fetchLighterOrderBookDetailsRaw(): Promise<unknown> {
  // SSOT rule #2: caller (arb / arb-auto) is responsible for error handling.
  // Removed silent `.catch(() => null)` so a network failure surfaces as a
  // rejected Promise instead of being indistinguishable from "API returned no
  // markets". Non-2xx responses are also rejected so a 5xx JSON body cannot
  // fulfill as if it were valid data.
  return withCache("pub:lt:orderBookDetails:raw", TTL_MARKET, async () => {
    const res = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookDetails`);
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Lighter orderBookDetails returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return res.json();
  });
}

export function fetchLighterFundingRates(): Promise<LighterFundingEntry[]> {
  // SSOT rule #2: error must propagate.
  // Row-level: rate is required (it's the field the endpoint exists for); a
  // missing rate means the row is malformed and we skip it. mark_price is
  // documented as intermittent on Lighter's side — when missing, surface as
  // null so the consumer can apply the orderBookDetails fallback (a
  // documented price-source preference, NOT an error fallback).
  return withCache("pub:lt:fundingRates", TTL_MARKET, async () => {
    const res = await fetch(`${LIGHTER_API_URL}/api/v1/funding-rates`);
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Lighter funding-rates returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = await res.json() as Record<string, unknown>;
    const list = (json.funding_rates ?? []) as Array<Record<string, unknown>>;
    const entries: LighterFundingEntry[] = [];
    for (const fr of list) {
      if (String(fr.exchange ?? "").toLowerCase() !== "lighter") continue;
      const marketId = Number(fr.market_id);
      // symbol is intentionally allowed to be empty — Lighter's funding-rates
      // payload often omits symbol per row, and the consumer resolves it from
      // orderBookDetails by marketId. Required: marketId + valid rate.
      const symbol = String(fr.symbol ?? "");
      const rateRaw = fr.rate ?? fr.funding_rate;
      const rate = Number(rateRaw);
      if (!Number.isFinite(marketId) || rateRaw === undefined || !Number.isFinite(rate)) {
        continue;
      }
      const markPriceRaw = fr.mark_price;
      const markPriceNumber = Number(markPriceRaw);
      const markPrice = markPriceRaw !== undefined && Number.isFinite(markPriceNumber) && markPriceNumber > 0
        ? markPriceNumber
        : null;
      entries.push({ marketId, symbol, rate, markPrice });
    }
    return entries;
  });
}

export function fetchLighterFundingRatesRaw(): Promise<unknown> {
  // SSOT rule #2: error must propagate; see fetchLighterOrderBookDetailsRaw.
  return withCache("pub:lt:fundingRates:raw", TTL_MARKET, async () => {
    const res = await fetch(`${LIGHTER_API_URL}/api/v1/funding-rates`);
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Lighter funding-rates returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return res.json();
  });
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
      if (!Number.isFinite(mid)) continue;
      idToSym.set(mid, String(m.symbol ?? ""));
      const p = Number(m.last_trade_price);
      // SSOT rule #2: only register prices that are real positive numbers;
      // never silently default missing last_trade_price to 0.
      if (Number.isFinite(p) && p > 0) idToPrice.set(mid, p);
    }
  }

  if (fundingRaw) {
    const fundingList = ((fundingRaw as Record<string, unknown>).funding_rates ?? []) as Array<Record<string, unknown>>;
    for (const fr of fundingList) {
      // API returns rates from multiple exchanges — only use Lighter's own rates
      if (String(fr.exchange ?? "").toLowerCase() !== "lighter") continue;
      const sym = String(fr.symbol ?? "") || idToSym.get(Number(fr.market_id)) || "";
      if (!sym || rates.has(sym)) continue;
      const rateRaw = fr.rate ?? fr.funding_rate;
      const rate = Number(rateRaw);
      // SSOT rule #2: skip rows whose funding rate is missing — never publish 0.
      if (rateRaw === undefined || !Number.isFinite(rate)) continue;
      rates.set(sym, rate);
      // Prefer fr.mark_price; fall back to the orderBookDetails last-trade
      // price as a documented price-source preference (NOT an error fallback).
      const directMark = Number(fr.mark_price);
      const fallbackMark = idToPrice.get(Number(fr.market_id));
      const mp = Number.isFinite(directMark) && directMark > 0
        ? directMark
        : (fallbackMark !== undefined && fallbackMark > 0 ? fallbackMark : undefined);
      if (mp !== undefined) prices.set(sym, mp);
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
