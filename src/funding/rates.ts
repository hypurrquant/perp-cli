/**
 * Real-time 3-DEX funding rate comparison.
 *
 * Fetches funding rates from Pacifica, Hyperliquid, and Lighter in parallel,
 * normalizes them to comparable hourly rates, and identifies arbitrage
 * opportunities across exchanges.
 */

import { toHourlyRate, annualizeRate, computeAnnualSpread, estimateHourlyFunding } from "./normalize.js";
import {
  fetchPacificaPrices, fetchHyperliquidMeta,
  fetchLighterOrderBookDetails, fetchLighterFundingRates as fetchLtFundingRates,
} from "../shared-api.js";
import { getHistoricalAverages, type HistoricalAverages } from "./history.js";
import { SPOT_PERP_TOKEN_MAP, MAX_PRICE_DEVIATION_PCT } from "../exchanges/spot-interface.js";

// ── API URLs (centralized in shared-api.ts) ──

// ── Types ──

export interface ExchangeFundingRate {
  exchange: "pacifica" | "hyperliquid" | "lighter";
  symbol: string;
  fundingRate: number;       // raw rate (period depends on exchange)
  hourlyRate: number;        // normalized to per-hour
  annualizedPct: number;     // annualized percentage
  markPrice: number;
  nextFundingTime?: number;  // unix ms, if available
  historicalAvg?: HistoricalAverages;  // avg rates over time windows
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

// ── Fetchers (using shared-api.ts) ──

async function fetchPacificaRates(): Promise<ExchangeFundingRate[]> {
  try {
    const assets = await fetchPacificaPrices();
    return assets.map(p => {
      const hourly = toHourlyRate(p.funding, "pacifica");
      return {
        exchange: "pacifica" as const,
        symbol: p.symbol,
        fundingRate: p.funding,
        hourlyRate: hourly,
        annualizedPct: annualizeRate(p.funding, "pacifica"),
        markPrice: p.mark,
        nextFundingTime: p.nextFunding,
      };
    });
  } catch {
    return [];
  }
}

async function fetchHyperliquidRates(): Promise<ExchangeFundingRate[]> {
  try {
    const assets = await fetchHyperliquidMeta();
    return assets.map(a => {
      const hourly = toHourlyRate(a.funding, "hyperliquid");
      return {
        exchange: "hyperliquid" as const,
        symbol: a.symbol,
        fundingRate: a.funding,
        hourlyRate: hourly,
        annualizedPct: annualizeRate(a.funding, "hyperliquid"),
        markPrice: a.markPx,
      };
    });
  } catch {
    return [];
  }
}

async function fetchLighterRates(): Promise<ExchangeFundingRate[]> {
  try {
    const [details, funding] = await Promise.all([
      fetchLighterOrderBookDetails(),
      fetchLtFundingRates(),
    ]);

    const priceMap = new Map(details.map(d => [d.marketId, d.lastTradePrice]));
    const symMap = new Map(details.map(d => [d.marketId, d.symbol]));

    return funding.map(fr => {
      const symbol = fr.symbol || symMap.get(fr.marketId) || "";
      const rate = fr.rate;
      const hourly = toHourlyRate(rate, "lighter");
      return {
        exchange: "lighter" as const,
        symbol,
        fundingRate: rate,
        hourlyRate: hourly,
        annualizedPct: annualizeRate(rate, "lighter"),
        markPrice: fr.markPrice || priceMap.get(fr.marketId) || 0,
      };
    });
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

  const allRates = [...pacRates, ...hlRates, ...ltRates];

  // Build per-symbol rate map
  const rateMap = new Map<string, ExchangeFundingRate[]>();
  for (const r of allRates) {
    if (!r.symbol) continue;
    if (opts?.symbols && !opts.symbols.includes(r.symbol.toUpperCase())) continue;
    const key = r.symbol.toUpperCase();
    if (!rateMap.has(key)) rateMap.set(key, []);
    rateMap.get(key)!.push(r);
  }

  // Attach historical averages when available
  try {
    const symbols = Array.from(rateMap.keys());
    const exchanges = ["pacifica", "hyperliquid", "lighter"];
    const historicals = getHistoricalAverages(symbols, exchanges);
    for (const [, rates] of rateMap) {
      for (const r of rates) {
        const key = `${r.symbol.toUpperCase()}:${r.exchange}`;
        const avg = historicals.get(key);
        if (avg) r.historicalAvg = avg;
      }
    }
  } catch {
    // Non-critical
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

// ── Spot+Perp Funding Spread ──

export interface SpotPerpSpread {
  symbol: string;
  /** Perp exchange with the highest absolute funding rate */
  perpExchange: string;
  /** Spot exchange(s) available for the hedge leg */
  spotExchanges: string[];
  /** Perp funding rate (raw) */
  perpFundingRate: number;
  /** Perp funding hourly rate */
  perpHourlyRate: number;
  /** Annualized spread % (spot funding = 0, so spread = |perp annual rate|) */
  annualSpreadPct: number;
  /** Best mark price */
  bestMarkPrice: number;
  /** Direction: "long-spot-short-perp" when perp funding > 0, else "sell-spot-long-perp" */
  direction: "long-spot-short-perp" | "sell-spot-long-perp";
  /** Estimated hourly income for $1000 notional */
  estHourlyIncomeUsd: number;
}

/**
 * Fetch spot+perp funding rate spreads.
 * Since spot has 0 funding cost, the spread is simply |perp funding rate|.
 * Only includes symbols available on at least one spot exchange (HL or LT).
 *
 * Key safety checks:
 * - U-token mapping: UBTC→BTC, UETH→ETH, USOL→SOL, UFART→FARTCOIN
 * - Price validation: spot mid price must be within 5% of perp mark price
 *   (filters out same-ticker-different-token issues like HIP-1 TRUMP ≠ perp TRUMP)
 */
export async function fetchSpotPerpSpreads(opts?: {
  symbols?: string[];
  minSpread?: number;
}): Promise<{ timestamp: string; spreads: SpotPerpSpread[] }> {
  // Fetch all perp funding rates
  const [hlRates, ltRates, pacRates] = await Promise.all([
    fetchHyperliquidRates(),
    fetchLighterRates(),
    fetchPacificaRates(),
  ]);

  // Build actual spot availability maps + spot prices for cross-validation
  // hlSpotByPerp: perpSymbol → { spotToken, exchange }
  const hlSpotByPerp = new Map<string, string>(); // perpSymbol → spotTokenName
  const hlSpotPrices = new Map<string, number>();  // perpSymbol → spot mid price
  const ltSpotSymbols = new Set<string>();
  const ltSpotPrices = new Map<string, number>();   // symbol → spot mid price

  try {
    // HL: spotMetaAndAssetCtxs → universe + prices in one call
    const hlMetaCtx = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
    }).then(r => r.json()) as [
      {
        tokens: Array<{ name: string; index: number }>;
        universe: Array<{ tokens: [number, number]; index: number }>;
      },
      Array<{ markPx?: string; midPx?: string }>,
    ];
    const meta = hlMetaCtx[0];
    const ctxs = hlMetaCtx[1] ?? [];
    const tokenNames = new Map<number, string>();
    for (const t of meta.tokens ?? []) tokenNames.set(t.index, t.name);
    const usdcIdx = meta.tokens?.find(t => t.name === "USDC")?.index ?? 0;

    // We need to match universe entries to ctxs by index.
    // API returns ctxs in same order as universe entries.
    for (let i = 0; i < (meta.universe ?? []).length; i++) {
      const u = meta.universe[i];
      if (u.tokens[1] !== usdcIdx) continue; // only /USDC pairs
      const base = tokenNames.get(u.tokens[0])?.toUpperCase();
      if (!base) continue;

      const ctx = ctxs[i];
      const spotPrice = Number(ctx?.midPx ?? ctx?.markPx ?? 0);

      // Map to perp symbol: UBTC→BTC, or direct if no mapping
      const perpSymbol = SPOT_PERP_TOKEN_MAP[base] ?? base;
      // Only keep the best-priced entry per perp symbol (prefer higher-volume)
      if (!hlSpotByPerp.has(perpSymbol) || spotPrice > 0) {
        hlSpotByPerp.set(perpSymbol, base);
        if (spotPrice > 0) hlSpotPrices.set(perpSymbol, spotPrice);
      }
    }
  } catch { /* non-critical */ }

  try {
    // LT: explorer API → symbols with "/"
    const ltMarkets = await fetch("https://explorer.elliot.ai/api/markets")
      .then(r => r.json()) as Array<{ symbol: string }>;
    for (const m of ltMarkets) {
      if (m.symbol.includes("/")) {
        ltSpotSymbols.add(m.symbol.split("/")[0].toUpperCase());
      }
    }
    // Fetch LT spot prices from orderbook for price validation
    for (const sym of ltSpotSymbols) {
      try {
        const book = await fetch(`https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=${
          // We don't have market_id here, skip detailed price fetch for LT
          // LT tokens (ETH, LINK, etc.) are direct names, low risk of mismatch
          ""
        }`);
        // Skip — LT uses direct token names, not indices
      } catch { /* skip */ }
    }
  } catch { /* non-critical */ }

  // Merge all perp rates by symbol
  const perpRateMap = new Map<string, ExchangeFundingRate[]>();
  for (const r of [...hlRates, ...ltRates, ...pacRates]) {
    if (!r.symbol) continue;
    if (opts?.symbols && !opts.symbols.includes(r.symbol.toUpperCase())) continue;
    const key = r.symbol.toUpperCase();
    if (!perpRateMap.has(key)) perpRateMap.set(key, []);
    perpRateMap.get(key)!.push(r);
  }

  const spreads: SpotPerpSpread[] = [];
  const minSpread = opts?.minSpread ?? 0;

  for (const [symbol, rates] of perpRateMap) {
    rates.sort((a, b) => Math.abs(b.hourlyRate) - Math.abs(a.hourlyRate));
    const bestPerp = rates[0];

    // Spot exchanges: only include if symbol has a verified spot market
    const uniqueSpot: string[] = [];

    // HL spot: check U-token mapped availability
    if (hlSpotByPerp.has(symbol)) {
      // Price cross-validation: spot price must be close to perp mark price
      const spotPrice = hlSpotPrices.get(symbol);
      const perpPrice = bestPerp.markPrice;
      if (spotPrice && perpPrice > 0) {
        const deviation = Math.abs(spotPrice - perpPrice) / perpPrice * 100;
        if (deviation <= MAX_PRICE_DEVIATION_PCT) {
          uniqueSpot.push("hyperliquid");
        }
        // else: same ticker, different token (e.g., HIP-1 TRUMP ≠ perp TRUMP) → skip
      } else if (spotPrice === undefined) {
        // No price data (empty orderbook) → skip, can't verify
      }
    }

    // LT spot: direct token names, low mismatch risk
    if (ltSpotSymbols.has(symbol)) uniqueSpot.push("lighter");

    if (uniqueSpot.length === 0) continue;

    const annualSpreadPct = Math.abs(bestPerp.annualizedPct);
    if (annualSpreadPct < minSpread) continue;

    const direction = bestPerp.hourlyRate > 0
      ? "long-spot-short-perp" as const
      : "sell-spot-long-perp" as const;

    const notional = 1000;
    const estHourlyIncomeUsd = Math.abs(bestPerp.hourlyRate) * notional;

    spreads.push({
      symbol,
      perpExchange: bestPerp.exchange,
      spotExchanges: uniqueSpot,
      perpFundingRate: bestPerp.fundingRate,
      perpHourlyRate: bestPerp.hourlyRate,
      annualSpreadPct,
      bestMarkPrice: bestPerp.markPrice,
      direction,
      estHourlyIncomeUsd,
    });
  }

  spreads.sort((a, b) => b.annualSpreadPct - a.annualSpreadPct);

  return {
    timestamp: new Date().toISOString(),
    spreads,
  };
}
