/**
 * Real-time 3-DEX funding rate comparison.
 *
 * Fetches funding rates from Pacifica, Hyperliquid, and Lighter in parallel,
 * normalizes them to comparable hourly rates, and identifies arbitrage
 * opportunities across exchanges.
 */

import { toHourlyRate, computeAnnualSpread, estimateHourlyFunding } from "./funding.js";

// ── API URLs ──

const PACIFICA_API = "https://api.pacifica.fi/api/v1/info/prices";
const HYPERLIQUID_API = "https://api.hyperliquid.xyz/info";
const LIGHTER_API = "https://mainnet.zklighter.elliot.ai";

// ── Types ──

export interface ExchangeFundingRate {
  exchange: "pacifica" | "hyperliquid" | "lighter";
  symbol: string;
  fundingRate: number;       // raw rate (period depends on exchange)
  hourlyRate: number;        // normalized to per-hour
  annualizedPct: number;     // annualized percentage
  markPrice: number;
  nextFundingTime?: number;  // unix ms, if available
}

export interface SymbolFundingComparison {
  symbol: string;
  rates: ExchangeFundingRate[];
  maxSpreadAnnual: number;      // annualized spread between extremes
  longExchange: string;         // go long where funding is lowest (you get paid)
  shortExchange: string;        // go short where funding is highest (you get paid)
  bestMarkPrice: number;        // best available mark price (prefer HL)
  estHourlyIncomeUsd: number;   // estimated hourly income for $1000 notional
}

export interface FundingRateSnapshot {
  timestamp: string;
  symbols: SymbolFundingComparison[];
  exchangeStatus: Record<string, "ok" | "error">;
}

// ── Default top symbols to track ──

export const TOP_SYMBOLS = [
  "BTC", "ETH", "SOL", "DOGE", "SUI", "AVAX", "LINK", "ARB",
  "WIF", "PEPE", "ONDO", "SEI", "TIA", "INJ", "NEAR",
  "APT", "OP", "FIL", "AAVE", "MKR",
];

// ── Fetchers ──

async function fetchPacificaRates(): Promise<ExchangeFundingRate[]> {
  try {
    const res = await fetch(PACIFICA_API);
    const json = await res.json();
    const data = (json as Record<string, unknown>).data ?? json;
    if (!Array.isArray(data)) return [];
    return data.map((p: Record<string, unknown>) => {
      const rate = Number(p.funding ?? 0);
      const hourly = toHourlyRate(rate, "pacifica");
      return {
        exchange: "pacifica" as const,
        symbol: String(p.symbol ?? ""),
        fundingRate: rate,
        hourlyRate: hourly,
        annualizedPct: hourly * 24 * 365 * 100,
        markPrice: Number(p.mark ?? 0),
        nextFundingTime: p.next_funding ? Number(p.next_funding) : undefined,
      };
    });
  } catch {
    return [];
  }
}

async function fetchHyperliquidRates(): Promise<ExchangeFundingRate[]> {
  try {
    const res = await fetch(HYPERLIQUID_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    });
    const json = await res.json() as unknown[];
    const universe = ((json[0] ?? {}) as Record<string, unknown>).universe ?? [];
    const ctxs = (json[1] ?? []) as Record<string, unknown>[];
    return (universe as Record<string, unknown>[]).map((asset, i: number) => {
      const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
      const rate = Number(ctx.funding ?? 0);
      const hourly = toHourlyRate(rate, "hyperliquid");
      return {
        exchange: "hyperliquid" as const,
        symbol: String(asset.name ?? ""),
        fundingRate: rate,
        hourlyRate: hourly,
        annualizedPct: hourly * 24 * 365 * 100,
        markPrice: Number(ctx.markPx ?? 0),
      };
    });
  } catch {
    return [];
  }
}

async function fetchLighterRates(): Promise<ExchangeFundingRate[]> {
  try {
    const [detailsRes, fundingRes] = await Promise.all([
      fetch(`${LIGHTER_API}/api/v1/orderBookDetails`).then(r => r.json()),
      fetch(`${LIGHTER_API}/api/v1/funding-rates`).then(r => r.json()),
    ]);

    // Build market_id -> {symbol, price} from details
    const idToMeta = new Map<number, { symbol: string; price: number }>();
    const details = (detailsRes as Record<string, unknown>).order_book_details ?? [];
    for (const m of details as Array<Record<string, unknown>>) {
      idToMeta.set(Number(m.market_id), {
        symbol: String(m.symbol ?? ""),
        price: Number(m.last_trade_price ?? 0),
      });
    }

    const rates: ExchangeFundingRate[] = [];
    const fundingList = (fundingRes as Record<string, unknown>).funding_rates ?? [];
    for (const fr of fundingList as Array<Record<string, unknown>>) {
      const marketId = Number(fr.market_id);
      const symbol = String(fr.symbol ?? "") || idToMeta.get(marketId)?.symbol;
      if (!symbol) continue;
      const rate = Number(fr.rate ?? fr.funding_rate ?? 0);
      const hourly = toHourlyRate(rate, "lighter");
      const price = idToMeta.get(marketId)?.price ?? 0;
      rates.push({
        exchange: "lighter" as const,
        symbol,
        fundingRate: rate,
        hourlyRate: hourly,
        annualizedPct: hourly * 24 * 365 * 100,
        markPrice: price,
      });
    }
    return rates;
  } catch {
    return [];
  }
}

// ── Core comparison logic ──

/**
 * Fetch funding rates from all 3 DEXs in parallel, normalize, and compare.
 * Returns rates sorted by max spread (descending).
 */
export async function fetchAllFundingRates(opts?: {
  symbols?: string[];      // filter to these symbols (default: all)
  minSpread?: number;      // minimum annualized spread % to include
}): Promise<FundingRateSnapshot> {
  const exchangeStatus: Record<string, "ok" | "error"> = {};

  const [pacRates, hlRates, ltRates] = await Promise.all([
    fetchPacificaRates().then(r => { exchangeStatus.pacifica = r.length > 0 ? "ok" : "error"; return r; }),
    fetchHyperliquidRates().then(r => { exchangeStatus.hyperliquid = r.length > 0 ? "ok" : "error"; return r; }),
    fetchLighterRates().then(r => { exchangeStatus.lighter = r.length > 0 ? "ok" : "error"; return r; }),
  ]);

  // Build per-symbol rate map
  const rateMap = new Map<string, ExchangeFundingRate[]>();
  for (const r of [...pacRates, ...hlRates, ...ltRates]) {
    if (!r.symbol) continue;
    if (opts?.symbols && !opts.symbols.includes(r.symbol.toUpperCase())) continue;
    const key = r.symbol.toUpperCase();
    if (!rateMap.has(key)) rateMap.set(key, []);
    rateMap.get(key)!.push(r);
  }

  const comparisons: SymbolFundingComparison[] = [];
  const minSpread = opts?.minSpread ?? 0;

  for (const [symbol, rates] of rateMap) {
    // Need at least 2 exchanges to compare
    if (rates.length < 2) continue;

    // Sort by hourly rate (ascending)
    rates.sort((a, b) => a.hourlyRate - b.hourlyRate);
    const lowest = rates[0];
    const highest = rates[rates.length - 1];

    const maxSpreadAnnual = computeAnnualSpread(
      highest.fundingRate, highest.exchange,
      lowest.fundingRate, lowest.exchange,
    );

    if (maxSpreadAnnual < minSpread) continue;

    // Best mark price: prefer HL (most liquid), then PAC, then LT
    const hlRate = rates.find(r => r.exchange === "hyperliquid");
    const pacRate = rates.find(r => r.exchange === "pacifica");
    const ltRate = rates.find(r => r.exchange === "lighter");
    const bestMarkPrice = hlRate?.markPrice || pacRate?.markPrice || ltRate?.markPrice || 0;

    // Estimate hourly income for $1000 notional arb
    const notional = 1000;
    const longIncome = estimateHourlyFunding(
      lowest.fundingRate, lowest.exchange, notional, "long",
    );
    const shortIncome = estimateHourlyFunding(
      highest.fundingRate, highest.exchange, notional, "short",
    );
    const estHourlyIncomeUsd = -(longIncome + shortIncome); // negate because income = -cost

    comparisons.push({
      symbol,
      rates,
      maxSpreadAnnual,
      longExchange: lowest.exchange,   // long where funding is lowest
      shortExchange: highest.exchange, // short where funding is highest
      bestMarkPrice,
      estHourlyIncomeUsd,
    });
  }

  // Sort by spread descending
  comparisons.sort((a, b) => b.maxSpreadAnnual - a.maxSpreadAnnual);

  return {
    timestamp: new Date().toISOString(),
    symbols: comparisons,
    exchangeStatus,
  };
}

/**
 * Fetch rates for a single symbol across all exchanges.
 */
export async function fetchSymbolFundingRates(symbol: string): Promise<SymbolFundingComparison | null> {
  const snapshot = await fetchAllFundingRates({ symbols: [symbol.toUpperCase()] });
  return snapshot.symbols[0] ?? null;
}
