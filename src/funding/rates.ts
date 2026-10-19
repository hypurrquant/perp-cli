/**
 * Real-time cross-venue funding rate comparison.
 *
 * Fans out over every venue with the "marketData" role using
 * each venue's `publicData.fetchFundingRates(net)`, normalizes every row to a
 * per-hour rate with the row's own basis (Lighter
 * family 8h, Aster per-symbol), and matches markets across venues by
 * `canonical` (null → excluded).
 *
 * A venue that fails is reported in `exchangeStatus` ("error") and
 * `exchangeErrors` (message) — its rows are absent, never silently empty.
 */

import { annualizeHourlyRate, estimateHourlyFundingFromHourly } from "./normalize.js";
import { getHistoricalAverages, type HistoricalAverages } from "./history.js";
import { SPOT_PERP_TOKEN_MAP, MAX_PRICE_DEVIATION_PCT } from "../exchanges/index.js";
import { getVenue, listVenuesWithRole, READ_ONLY_CREDENTIALS, type VenueDefinition } from "../exchanges/venue.js";
import { rateToHourly, type FundingRateBasis, type Network, type VenueFundingRate, type VenueId } from "../exchanges/venue-types.js";
import { ensureVenuesRegistered } from "../exchanges/venues/index.js";
import { sharedApiNetwork } from "../api/public/urls.js";
import { PerpError } from "../errors.js";

// ── Types ──

export interface ExchangeFundingRate {
  exchange: VenueId;
  /** Venue display symbol (e.g. "kPEPE", "BTC"). */
  symbol: string;
  /** Cross-venue matching key (canonical-symbols.ts). */
  canonical: string;
  fundingRate: number;       // raw quoted rate (period given by `basis`)
  basis: FundingRateBasis;   // what one quoted rate covers
  hourlyRate: number;        // normalized to per-hour with `basis`
  annualizedPct: number;     // annualized percentage
  markPrice: number;
  nextFundingTime: number | null;  // unix ms; null = venue does not publish it
  historicalAvg: HistoricalAverages | null;  // avg rates over time windows
  /** false = the venue's funding rate is unverified (VenueDefinition.fundingVerified) — shown only on explicit request. */
  fundingVerified: boolean;
  /** How the row was read: "unofficial" = an undocumented venue API (VenueDefinition.apiStatus) — may change without notice. */
  apiStatus: "official" | "unofficial";
}

export interface SymbolFundingComparison {
  /** Canonical symbol shared by every row. */
  symbol: string;
  rates: ExchangeFundingRate[];
  maxSpreadAnnual: number;      // annualized spread between extremes
  longExchange: string;         // go long where funding is lowest (you get paid)
  shortExchange: string;        // go short where funding is highest (you get paid)
  bestMarkPrice: number;        // mark price of the most liquid venue present (MARK_PRICE_PREFERENCE)
  estHourlyIncomeUsd: number;   // estimated hourly income for $1000 notional
  /**
   * false = a leg of the long/short pair sits on a venue without the trading role (RISEx while its
   * trading is gated in this release): the spread is data only — `arb exec` refuses it.
   */
  executable: boolean;
  /** Venues of the long/short pair that perp-cli cannot trade (read-only); [] when executable. */
  readOnlyLegs: string[];
}

export interface FundingRateSnapshot {
  timestamp: string;
  symbols: SymbolFundingComparison[];
  exchangeStatus: Record<string, "ok" | "error">;
  /** Error message per venue whose status is "error". */
  exchangeErrors: Record<string, string>;
}

// ── Default top symbols to track ──

export const TOP_SYMBOLS = [
  "BTC", "ETH", "SOL", "DOGE", "SUI", "AVAX", "LINK", "ARB",
  "WIF", "PEPE", "ONDO", "SEI", "TIA", "INJ", "NEAR",
  "APT", "OP", "FIL", "AAVE", "MKR",
];

/** Mark-price source preference for `bestMarkPrice` (most liquid first). */
const MARK_PRICE_PREFERENCE: readonly VenueId[] = [
  "hyperliquid", "pacifica", "lighter", "aster", "lighter-rh", "ondo", "arcus", "risex", "qfex", "grvt", "extended",
  // RFQ venue: the mark is the single maker's (OLP) price.
  "variational",
  // Unofficial API: last resort as a mark-price source.
  "txflow",
];

// ── Per-venue fetch ──

function errorMessage(e: unknown): string {
  if (e instanceof PerpError) return e.structured.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Funding rows for one venue, normalized. Rows the venue publishes without a
 * mark price are priced from the same venue's markets (by venueSymbol); rows
 * still unpriced, or without a canonical symbol, are excluded (never 0).
 */
async function fetchVenueRates(def: VenueDefinition, net: Network): Promise<ExchangeFundingRate[]> {
  const rows = await def.publicData.fetchFundingRates(net);
  let markBySymbol: Map<string, string> | null = null;
  if (rows.some(r => r.markPrice === null)) {
    const markets = await def.publicData.fetchMarkets(net);
    markBySymbol = new Map(markets.map(m => [m.venueSymbol, m.markPrice]));
  }

  const out: ExchangeFundingRate[] = [];
  const unpriced: string[] = [];
  for (const r of rows) {
    if (r.canonical === null) continue; // not matchable across venues
    // Outside its funding hours (QFEX market_hours) a market has no rate: never ranked, snapshotted
    // (saveFundingSnapshot) or averaged as a 0.
    if (r.rate === null || r.marketClosed === true) continue;
    const markRaw = r.markPrice !== null ? r.markPrice : markBySymbol?.get(r.venueSymbol);
    const markPrice = markRaw === undefined ? NaN : Number(markRaw);
    if (!Number.isFinite(markPrice) || markPrice <= 0) { unpriced.push(r.symbol); continue; }
    out.push(toExchangeRate({ ...r, rate: r.rate }, r.canonical, markPrice, def.fundingVerified, def.apiStatus.kind));
  }
  if (unpriced.length > 0) {
    console.warn(`[${def.id}] excluded ${unpriced.length} funding row(s) without a mark price: ${unpriced.join(", ")}`);
  }
  return out;
}

function toExchangeRate(r: VenueFundingRate & { rate: string }, canonical: string, markPrice: number, fundingVerified: boolean, apiStatus: "official" | "unofficial"): ExchangeFundingRate {
  const fundingRate = Number(r.rate);
  if (!Number.isFinite(fundingRate)) {
    throw new PerpError("EXCHANGE_ERROR", `${r.venue} ${r.symbol}: non-numeric funding rate "${r.rate}"`);
  }
  const hourlyRate = rateToHourly(fundingRate, r.basis);
  return {
    exchange: r.venue,
    symbol: r.symbol,
    canonical,
    fundingRate,
    basis: r.basis,
    hourlyRate,
    annualizedPct: annualizeHourlyRate(hourlyRate),
    markPrice,
    nextFundingTime: r.nextFundingTime,
    historicalAvg: null,
    fundingVerified,
    apiStatus,
  };
}

/**
 * Fetch every venue in `venues` concurrently; failures land in status/errors.
 * Venues whose funding is unverified (VenueDefinition.fundingVerified false — QFEX until its
 * rate unit is confirmed) are DROPPED unless `includeUnverified`: every consumer that ranks,
 * alerts on or trades funding spreads (arb scan, MCP, alerts, dashboard, portfolio) leaves it
 * false. Only explicit, labelled reads pass true (`arb scan --include-unverified`).
 */
export async function fetchVenuesRates(venues: VenueDefinition[], net: Network, includeUnverified: boolean): Promise<{
  rates: ExchangeFundingRate[];
  exchangeStatus: Record<string, "ok" | "error">;
  exchangeErrors: Record<string, string>;
}> {
  venues = venues.filter(v => v.fundingVerified || includeUnverified);
  const settled = await Promise.allSettled(venues.map(v => fetchVenueRates(v, net)));
  const exchangeStatus: Record<string, "ok" | "error"> = {};
  const exchangeErrors: Record<string, string> = {};
  const rates: ExchangeFundingRate[] = [];
  settled.forEach((res, i) => {
    const id = venues[i].id;
    if (res.status === "fulfilled") {
      exchangeStatus[id] = "ok";
      rates.push(...res.value);
    } else {
      exchangeStatus[id] = "error";
      exchangeErrors[id] = errorMessage(res.reason);
    }
  });
  return { rates, exchangeStatus, exchangeErrors };
}

const _warnedPriceMismatch = new Set<string>();

/**
 * Same canonical ticker on two venues is not proof of the same asset (e.g. two
 * unrelated tokens both listed as "PRL"). Within a canonical group, drop any
 * venue whose mark price deviates more than MAX_PRICE_DEVIATION_PCT from the
 * group median, with a one-time stderr warning per (symbol, venue).
 */
function dropPriceOutliers<T extends { exchange: VenueId; markPrice: number }>(canonical: string, list: T[], tag = "funding"): T[] {
  if (list.length < 2) return list;
  const sorted = list.map(r => r.markPrice).sort((x, y) => x - y);
  const mid = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  if (!(mid > 0)) return list;
  return list.filter(r => {
    const devPct = Math.abs(r.markPrice - mid) / mid * 100;
    if (devPct <= MAX_PRICE_DEVIATION_PCT) return true;
    const key = `${canonical}:${r.exchange}`;
    if (!_warnedPriceMismatch.has(key)) {
      _warnedPriceMismatch.add(key);
      process.stderr.write(`[${tag}] excluded ${r.exchange} ${canonical}: mark ${r.markPrice} deviates ${devPct.toFixed(1)}% from cross-venue median ${mid} (likely a different asset with the same ticker)\n`);
    }
    return false;
  });
}

function groupByCanonical<T extends { exchange: VenueId; canonical: string; markPrice: number }>(rates: T[], symbols: string[] | undefined, tag = "funding"): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rates) {
    if (symbols && !symbols.includes(r.canonical)) continue;
    const list = out.get(r.canonical);
    if (list) list.push(r);
    else out.set(r.canonical, [r]);
  }
  for (const [canonical, list] of [...out]) {
    const kept = dropPriceOutliers(canonical, list, tag);
    if (kept.length === 0) out.delete(canonical); // every venue disagreed — not comparable
    else out.set(canonical, kept);
  }
  return out;
}

// ── Price groups (basis) ──

export interface VenuePrice {
  exchange: VenueId;
  /** Venue display symbol. */
  symbol: string;
  canonical: string;
  markPrice: number;
  apiStatus: "official" | "unofficial";
}

export interface PriceGroupSnapshot {
  /** canonical → venue prices, after the median price-outlier drop (same guard as the funding scan). */
  groups: Map<string, VenuePrice[]>;
  exchangeStatus: Record<string, "ok" | "error">;
  exchangeErrors: Record<string, string>;
}

/**
 * Mark prices of `venues`, grouped by canonical symbol — the grouping and price-outlier guard of
 * the funding comparison, WITHOUT any funding dependency: read from each venue's market directory
 * (publicData.fetchMarkets), so a market with a null funding rate or a venue whose funding is
 * unverified is still priced. Rows without a canonical symbol, not tradable, or without a
 * positive mark are excluded. A venue that fails is reported in exchangeStatus / exchangeErrors.
 */
export async function fetchCanonicalPriceGroups(venues: VenueDefinition[], opts?: { symbols?: string[]; network?: Network; tag?: string }): Promise<PriceGroupSnapshot> {
  ensureVenuesRegistered();
  const net = opts?.network ?? sharedApiNetwork();
  const settled = await Promise.allSettled(venues.map(v => v.publicData.fetchMarkets(net)));
  const exchangeStatus: Record<string, "ok" | "error"> = {};
  const exchangeErrors: Record<string, string> = {};
  const prices: VenuePrice[] = [];
  settled.forEach((res, i) => {
    const def = venues[i];
    if (res.status === "rejected") {
      exchangeStatus[def.id] = "error";
      exchangeErrors[def.id] = errorMessage(res.reason);
      return;
    }
    exchangeStatus[def.id] = "ok";
    for (const m of res.value) {
      if (m.canonical === null || !m.tradable) continue;
      const markPrice = Number(m.markPrice);
      if (!Number.isFinite(markPrice) || markPrice <= 0) continue;
      prices.push({ exchange: def.id, symbol: m.symbol, canonical: m.canonical, markPrice, apiStatus: def.apiStatus.kind });
    }
  });
  return { groups: groupByCanonical(prices, opts?.symbols, opts?.tag ?? "prices"), exchangeStatus, exchangeErrors };
}

/** Whether perp-cli can trade both legs of a long/short pair (the trading role), and which it cannot. */
export function pairExecutability(longExchange: string, shortExchange: string): { executable: boolean; readOnlyLegs: string[] } {
  const readOnlyLegs = [...new Set([longExchange, shortExchange])].filter(v => !getVenue(v).roles.includes("trading"));
  return { executable: readOnlyLegs.length === 0, readOnlyLegs };
}

function bestMarkPrice(rates: ExchangeFundingRate[]): number {
  const rank = (id: VenueId) => MARK_PRICE_PREFERENCE.indexOf(id);
  return [...rates].sort((a, b) => rank(a.exchange) - rank(b.exchange))[0].markPrice;
}

// ── Core comparison logic ──

/**
 * Fetch funding rates from every market-data venue in parallel, normalize, and compare.
 * Returns rates sorted by max spread (descending).
 * @param opts.network defaults to the network the CLI selected (setSharedApiNetwork)
 */
export async function fetchAllFundingRates(opts?: {
  symbols?: string[];      // filter to these canonical symbols (default: all)
  minSpread?: number;      // minimum annualized spread % to include
  network?: Network;
  /** Also fetch venues whose funding rate is unverified (default false — see fetchVenuesRates). */
  includeUnverified?: boolean;
}): Promise<FundingRateSnapshot> {
  ensureVenuesRegistered();
  const net = opts?.network ?? sharedApiNetwork();
  const { rates: allRates, exchangeStatus, exchangeErrors } =
    await fetchVenuesRates(listVenuesWithRole("marketData"), net, opts?.includeUnverified === true);

  const rateMap = groupByCanonical(allRates, opts?.symbols);

  // Attach historical averages (keyed by venue symbol + venue, as saved by saveFundingSnapshot)
  const grouped = [...rateMap.values()].flat();
  const historicals = getHistoricalAverages(
    [...new Set(grouped.map(r => r.symbol.toUpperCase()))],
    [...new Set(grouped.map(r => r.exchange))],
  );
  for (const r of grouped) {
    const avg = historicals.get(`${r.symbol.toUpperCase()}:${r.exchange}`);
    if (avg) r.historicalAvg = avg;
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
    // The median filter alone lets a 2-venue group through at up to 2 × MAX_PRICE_DEVIATION_PCT
    // apart (each side deviates half the gap): the CHOSEN pair must itself agree on price.
    const pairGapPct = Math.abs(lowest.markPrice - highest.markPrice) / ((lowest.markPrice + highest.markPrice) / 2) * 100;
    if (!(pairGapPct <= MAX_PRICE_DEVIATION_PCT)) {
      const key = `${symbol}:${lowest.exchange}:${highest.exchange}`;
      if (!_warnedPriceMismatch.has(key)) {
        _warnedPriceMismatch.add(key);
        process.stderr.write(`[funding] excluded ${symbol} ${lowest.exchange}↔${highest.exchange}: pair mark gap ${pairGapPct.toFixed(1)}% > ${MAX_PRICE_DEVIATION_PCT}%\n`);
      }
      continue;
    }

    const maxSpreadAnnual = annualizeHourlyRate(highest.hourlyRate - lowest.hourlyRate);
    if (maxSpreadAnnual < minSpread) continue;

    // Estimate hourly income for $1000 notional arb
    const notional = 1000;
    const longIncome = estimateHourlyFundingFromHourly(lowest.hourlyRate, notional, "long");
    const shortIncome = estimateHourlyFundingFromHourly(highest.hourlyRate, notional, "short");
    const estHourlyIncomeUsd = -(longIncome + shortIncome); // negate because income = -cost

    comparisons.push({
      symbol,
      rates,
      maxSpreadAnnual,
      longExchange: lowest.exchange,   // long where funding is lowest
      shortExchange: highest.exchange, // short where funding is highest
      bestMarkPrice: bestMarkPrice(rates),
      estHourlyIncomeUsd,
      ...pairExecutability(lowest.exchange, highest.exchange),
    });
  }

  // Sort by spread descending
  comparisons.sort((a, b) => b.maxSpreadAnnual - a.maxSpreadAnnual);

  return {
    timestamp: new Date().toISOString(),
    symbols: comparisons,
    exchangeStatus,
    exchangeErrors,
  };
}

/**
 * Fetch rates for a single (canonical) symbol across all exchanges.
 */
export async function fetchSymbolFundingRates(symbol: string, includeUnverified = false): Promise<SymbolFundingComparison | null> {
  const snapshot = await fetchAllFundingRates({ symbols: [symbol.toUpperCase()], includeUnverified });
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
 * Only includes symbols available on at least one bot spot venue (def.spot).
 *
 * Key safety checks:
 * - U-token mapping: UBTC→BTC, UETH→ETH, USOL→SOL, UFART→FARTCOIN
 * - Price validation: spot mid price must be within 5% of perp mark price
 *   (filters out same-ticker-different-token issues like HIP-1 TRUMP ≠ perp TRUMP)
 */
export async function fetchSpotPerpSpreads(opts?: {
  symbols?: string[];
  minSpread?: number;
  network?: Network;
}): Promise<{
  timestamp: string;
  spreads: SpotPerpSpread[];
  exchangeStatus: Record<string, "ok" | "error">;
  exchangeErrors: Record<string, string>;
}> {
  // Spot legs come from the venue definitions (def.spot): only bot/arb spot venues
  // (separate/runtime account + transfer). Perp legs: those venues + pacifica.
  ensureVenuesRegistered();
  const net = opts?.network ?? sharedApiNetwork();
  const { listBotSpotVenues, requireSpotAdapter, defaultSpotQuote } = await import("../exchanges/spot-factory.js");
  const spotVenues = listBotSpotVenues();
  const perpVenueIds = new Set<VenueId>(["hyperliquid", "lighter", "pacifica", ...spotVenues.map(v => v.id)]);
  const { rates: perpRates, exchangeStatus, exchangeErrors } = await fetchVenuesRates(
    [...perpVenueIds].map(id => getVenue(id)),
    net,
    false,
  );

  // Spot availability + prices per venue: perpSymbol → candidate spot prices (U-tokens map
  // UBTC→BTC; several spot tokens may claim one perp symbol). A failure is reported as
  // "<venue>-spot" in status/errors.
  const spotPricesByVenue = new Map<VenueId, Map<string, number[]>>();
  await Promise.all(spotVenues.map(async def => {
    try {
      if (def.create === null) throw new Error(`${def.id} has no adapter`);
      const perp = await def.create({ network: net, credentials: READ_ONLY_CREDENTIALS, noAgent: true, hlDex: null, readOnly: true, noBuilder: true });
      const spot = await requireSpotAdapter(def.id, perp);
      const quote = defaultSpotQuote(def, net);
      const byPerp = new Map<string, number[]>();
      for (const m of await spot.getSpotMarkets()) {
        if (m.quoteToken.toUpperCase() !== quote || m.markPrice === null) continue; // null = no price → cannot be validated
        const px = Number(m.markPrice);
        if (!Number.isFinite(px) || px <= 0) continue; // no price → cannot be validated → not a candidate
        const base = m.baseToken.toUpperCase();
        const perpSymbol = SPOT_PERP_TOKEN_MAP[base] ?? base;
        const list = byPerp.get(perpSymbol);
        if (list) list.push(px); else byPerp.set(perpSymbol, [px]);
      }
      spotPricesByVenue.set(def.id, byPerp);
      exchangeStatus[`${def.id}-spot`] = "ok";
    } catch (e) {
      exchangeStatus[`${def.id}-spot`] = "error";
      exchangeErrors[`${def.id}-spot`] = errorMessage(e);
    }
  }));

  // Merge all perp rates by canonical symbol
  const perpRateMap = groupByCanonical(perpRates, opts?.symbols);

  const spreads: SpotPerpSpread[] = [];
  const minSpread = opts?.minSpread ?? 0;

  for (const [symbol, rates] of perpRateMap) {
    rates.sort((a, b) => Math.abs(b.hourlyRate) - Math.abs(a.hourlyRate));
    const bestPerp = rates[0];

    // Spot exchanges: only include if the symbol has a spot market whose price is within
    // MAX_PRICE_DEVIATION_PCT of the perp mark (same ticker, different token — e.g. HIP-1
    // TRUMP ≠ perp TRUMP — is skipped).
    const uniqueSpot: string[] = [];
    const perpPrice = bestPerp.markPrice;
    for (const [venueId, byPerp] of spotPricesByVenue) {
      const prices = byPerp.get(symbol);
      if (!prices || !(perpPrice > 0)) continue;
      if (prices.some(px => Math.abs(px - perpPrice) / perpPrice * 100 <= MAX_PRICE_DEVIATION_PCT)) uniqueSpot.push(venueId);
    }

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
    exchangeStatus,
    exchangeErrors,
  };
}
