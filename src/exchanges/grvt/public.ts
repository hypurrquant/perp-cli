/**
 * GRVT public market data — official Market Data REST API (api-docs.grvt.io/market_data_api/).
 *
 * Sources (all `POST https://market-data.grvt.io/full/v1/…`, no key):
 *   instruments {kind:["PERPETUAL"], is_active:true, limit}  directory: instrument "BTC_USDT_Perp",
 *        base, quote, kind, settlement_period, tick_size, min_size, min_notional,
 *        funding_interval_hours (4 or 8, PER INSTRUMENT), asset_class (CRYPTO / EQUITY / COMMODITY),
 *        status. No leverage and no lot step (base_decimals is the signing multiplier, not a lot).
 *   ticker {instrument}       one instrument per call (no bulk ticker exists): mark / index / last /
 *        best bid / best ask prices, open_interest (base), buy/sell_volume_24h_q (quote = USDT),
 *        funding_rate, next_funding_time (ns).
 *   margin_rules {instrument} risk_brackets → max_leverage of tier 1 (= maxLeverage) and the tiers.
 *
 * Mapping:
 *  - symbol = `base` ("BTC", "KPEPE"); venueSymbol = instrument ("BTC_USDT_Perp"); canonical via
 *    canonical-symbols.ts (crypto by ticker + denomination aliases, equity / etf by ticker,
 *    commodity explicit only). Pre-IPO markets (listed by GRVT as EQUITY) are preIpo → no canonical.
 *  - funding: `funding_rate` is the venue's INDICATIVE rate for the active interval (the interval
 *    ending at next_funding_time) — kind "predicted", a moving estimate. Its unit is PERCENT per the
 *    market's funding interval: settled history (/full/v1/funding, "percentage points") prints the
 *    same magnitude (BTC 0.01 = HL-style 0.01 %/8 h baseline; ticker 0.0063). The ticker schema says
 *    "centibeeps", which would make every rate 100× smaller than its own settled prints — not used.
 *    Converted to a fraction per interval by an exact × 0.01; basis perHours = funding_interval_hours.
 *  - volume24h = buy + sell 24 h quote volume (the docs' "24 hour volume"), exact decimal sum.
 *  - unknown / absent values are null; a ticker without a mark price drops the market (warned).
 */

import { canonicalFor } from "../canonical-symbols.js";
import { addDecimal, mulDecimal } from "../precision.js";
import { symbolNotFound } from "../unknown-symbol.js";
import { networkConfig, type VenuePublicData } from "../venue.js";
import type { AssetClass, FundingRateBasis, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import { grvtVenue } from "../venues/grvt.js";
import { grvtShapeError, GrvtClient } from "./client.js";

/** Requests in flight at once for the per-instrument fan-out (ticker / margin_rules). */
export const GRVT_FANOUT_CONCURRENCY = 8;

/**
 * Markets GRVT lists as EQUITY that are pre-IPO private companies: never matched by ticker (a
 * pre-IPO perp references a private valuation, not an exchange-listed share).
 */
const PRE_IPO: ReadonlySet<string> = new Set(["ANTHROPIC", "OPENAI", "SPACEX"]);

/** Exchange-traded funds among GRVT's EQUITY markets (label only; matching is by ticker either way). */
const ETF: ReadonlySet<string> = new Set([
  "SPY", "QQQ", "IWM", "EWJ", "EWT", "EWY", "EWZ", "SOXL", "TQQQ", "SQQQ", "UVXY", "URNM", "XLE", "KORU", "KODEX200",
]);

// ── Directory ──

export interface GrvtMarketMeta {
  instrument: string;
  symbol: string;
  quote: string;
  tickSize: string;
  minSize: string;
  minNotional: string | null;
  /** funding_interval_hours of this instrument (required by the schema; drift is EXCHANGE_ERROR). */
  fundingIntervalHours: number;
  assetClass: AssetClass;
  canonical: string | null;
  tradable: boolean;
}

const DEC = /^-?\d+(\.\d+)?$/;

function decOrNull(v: unknown): string | null {
  return typeof v === "string" && DEC.test(v) ? v : null;
}

function positiveDec(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v) || !(Number(v) > 0)) throw grvtShapeError(`${what} is not a positive decimal`);
  return v;
}

function assetClassOf(symbol: string, raw: unknown): AssetClass | null {
  switch (raw) {
    case "CRYPTO": return "crypto";
    case "COMMODITY": return "commodity";
    case "EQUITY": return PRE_IPO.has(symbol) ? "preIpo" : ETF.has(symbol) ? "etf" : "equity";
    default: return null;
  }
}

/**
 * Parse one instruments row. Returns null for a row that is not a listed perpetual (another kind,
 * an expiring settlement period); shape drift on a perpetual row is EXCHANGE_ERROR.
 */
export function toGrvtMarketMeta(raw: unknown, warn: (msg: string) => void): GrvtMarketMeta | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw grvtShapeError("instruments row is not an object");
  const r = raw as Record<string, unknown>;
  if (r.kind !== "PERPETUAL" || r.settlement_period !== "PERPETUAL") return null;
  if (typeof r.instrument !== "string" || typeof r.base !== "string" || r.base === "" || typeof r.quote !== "string") {
    throw grvtShapeError(`instrument row ${String(r.instrument)} has no instrument / base / quote`);
  }
  const symbol = r.base.toUpperCase();
  const assetClass = assetClassOf(symbol, r.asset_class);
  if (assetClass === null) {
    warn(`[grvt] skipped ${r.instrument}: unknown asset_class "${String(r.asset_class)}"`);
    return null;
  }
  const fi = r.funding_interval_hours;
  if (typeof fi !== "number" || !Number.isInteger(fi) || fi <= 0) throw grvtShapeError(`${r.instrument} funding_interval_hours ${String(fi)} is not a positive integer`);
  return {
    instrument: r.instrument,
    symbol,
    quote: r.quote,
    tickSize: positiveDec(r.tick_size, `${r.instrument} tick_size`),
    minSize: positiveDec(r.min_size, `${r.instrument} min_size`),
    minNotional: decOrNull(r.min_notional),
    fundingIntervalHours: fi,
    assetClass,
    canonical: canonicalFor("grvt", symbol, assetClass),
    tradable: r.status === "ACTIVE",
  };
}

export async function fetchGrvtDirectory(client: GrvtClient, warn: (msg: string) => void): Promise<GrvtMarketMeta[]> {
  const rows = await client.result<unknown>("instruments", { kind: ["PERPETUAL"], is_active: true, limit: 100000 });
  if (!Array.isArray(rows)) throw grvtShapeError("instruments result is not an array");
  const out: GrvtMarketMeta[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const m = toGrvtMarketMeta(row, warn);
    if (m === null) continue;
    if (seen.has(m.symbol)) throw grvtShapeError(`instruments list ${m.symbol} twice`);
    seen.add(m.symbol);
    out.push(m);
  }
  return out;
}

/** Resolve a CLI symbol ("btc", "BTC-PERP", "BTC_USDT_Perp", "BTC-USDT") against the directory. */
export function resolveGrvtMarket(dir: readonly GrvtMarketMeta[], input: string): GrvtMarketMeta {
  const up = input.trim().toUpperCase().replace(/-PERP$/, "").replace(/_PERP$/, "").replace(/[-_/]USDT$/, "");
  const hit = dir.find(m => m.symbol === up);
  if (hit === undefined) throw symbolNotFound("grvt", input);
  return hit;
}

// ── Ticker ──

export interface GrvtTicker {
  markPrice: string | null;
  indexPrice: string | null;
  lastPrice: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  openInterest: string | null;
  volume24hQuote: string | null;
  /** Percent per the market's funding interval, as published. */
  fundingPct: string | null;
  /** ms; null when absent. */
  nextFundingTime: number | null;
}

function nsToMsOrNull(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const ms = Number(BigInt(v) / 1_000_000n);
  return ms > 0 ? ms : null;
}

export function toGrvtTicker(raw: unknown): GrvtTicker {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw grvtShapeError("ticker result is not an object");
  const r = raw as Record<string, unknown>;
  const bv = decOrNull(r.buy_volume_24h_q);
  const sv = decOrNull(r.sell_volume_24h_q);
  return {
    markPrice: decOrNull(r.mark_price),
    indexPrice: decOrNull(r.index_price),
    lastPrice: decOrNull(r.last_price),
    bestBid: decOrNull(r.best_bid_price),
    bestAsk: decOrNull(r.best_ask_price),
    openInterest: decOrNull(r.open_interest),
    volume24hQuote: bv !== null && sv !== null ? addDecimal(bv, sv) : null,
    fundingPct: decOrNull(r.funding_rate),
    nextFundingTime: nsToMsOrNull(r.next_funding_time),
  };
}

/** Percent → fraction, exactly ("0.0063" → "0.000063"); null stays null (unknown, never 0). */
export function grvtPercentToFraction(pct: string | null): string | null {
  return pct === null ? null : mulDecimal(pct, "0.01");
}

export function grvtFundingBasis(m: Pick<GrvtMarketMeta, "fundingIntervalHours">): FundingRateBasis {
  return { kind: "perHours", hours: m.fundingIntervalHours };
}

// ── Margin rules ──

export interface GrvtLeverage {
  maxLeverage: number;
  tiers: Array<{ lowerBound: number; maxLeverage: number }>;
}

/** risk_brackets → tier-1 max leverage and the notional tiers (ascending); null when unpublished. */
export function toGrvtLeverage(raw: unknown): GrvtLeverage | null {
  const brackets = (raw as { risk_brackets?: unknown } | null)?.risk_brackets;
  if (!Array.isArray(brackets) || brackets.length === 0) return null;
  const tiers: GrvtLeverage["tiers"] = [];
  for (const b of brackets) {
    const x = b as { notional_floor?: unknown; max_leverage?: unknown };
    const floor = decOrNull(x.notional_floor);
    if (floor === null || typeof x.max_leverage !== "number" || !Number.isInteger(x.max_leverage) || x.max_leverage <= 0) return null;
    tiers.push({ lowerBound: Number(floor), maxLeverage: x.max_leverage });
  }
  tiers.sort((a, b) => a.lowerBound - b.lowerBound);
  return { maxLeverage: tiers[0].maxLeverage, tiers };
}

// ── Fan-out ──

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function fetchGrvtTicker(client: GrvtClient, instrument: string): Promise<GrvtTicker> {
  return client.result<unknown>("ticker", { instrument }).then(toGrvtTicker);
}

export function fetchGrvtLeverage(client: GrvtClient, instrument: string): Promise<GrvtLeverage | null> {
  return client.post<unknown>("margin_rules", { instrument }).then(toGrvtLeverage);
}

// ── Mapping ──

export type GrvtVenueMarket = VenueMarket & {
  tickSize: string;
  lastPrice: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  nextFundingTime: number | null;
};

export function toGrvtVenueMarket(m: GrvtMarketMeta, t: GrvtTicker & { markPrice: string }, lev: GrvtLeverage | null): GrvtVenueMarket {
  return {
    venue: "grvt",
    venueSymbol: m.instrument,
    symbol: m.symbol,
    canonical: m.canonical,
    assetClass: m.assetClass,
    settle: "USDT",
    quoteAsset: m.quote,
    markPrice: t.markPrice,
    indexPrice: t.indexPrice,
    fundingRate: grvtPercentToFraction(t.fundingPct),
    fundingRateBasis: grvtFundingBasis(m),
    settlementIntervalHours: m.fundingIntervalHours,
    openInterest: t.openInterest,
    volume24h: t.volume24hQuote,
    tickSize: m.tickSize,
    // No lot step is published (min_size is the minimum, base_decimals the signing multiplier).
    stepSize: null,
    minSize: m.minSize,
    minNotional: m.minNotional,
    maxLeverage: lev === null ? null : lev.maxLeverage,
    marginTiers: lev === null ? null : lev.tiers,
    session: null,
    tradable: m.tradable,
    lastPrice: t.lastPrice,
    bestBid: t.bestBid,
    bestAsk: t.bestAsk,
    nextFundingTime: t.nextFundingTime,
  };
}

export interface GrvtPublicDeps {
  warn: (msg: string) => void;
}

const DEFAULT_DEPS: GrvtPublicDeps = { warn: msg => process.stderr.write(`${msg}\n`) };

export function grvtClient(net: Network): GrvtClient {
  return new GrvtClient(networkConfig(grvtVenue, net).restUrl, net);
}

/** Directory + one ticker per market, joined; a market whose ticker has no mark price is dropped (warned). */
async function fetchPriced(client: GrvtClient, deps: GrvtPublicDeps): Promise<Array<{ meta: GrvtMarketMeta; ticker: GrvtTicker & { markPrice: string } }>> {
  const dir = await fetchGrvtDirectory(client, deps.warn);
  const tickers = await mapLimit(dir, GRVT_FANOUT_CONCURRENCY, m => fetchGrvtTicker(client, m.instrument));
  const out: Array<{ meta: GrvtMarketMeta; ticker: GrvtTicker & { markPrice: string } }> = [];
  const unpriced: string[] = [];
  dir.forEach((meta, i) => {
    const t = tickers[i];
    if (t.markPrice === null || !(Number(t.markPrice) > 0)) { unpriced.push(meta.symbol); return; }
    out.push({ meta, ticker: { ...t, markPrice: t.markPrice } });
  });
  if (unpriced.length > 0) deps.warn(`[grvt] ${unpriced.length} market(s) without a mark price are not shown: ${unpriced.join(", ")}`);
  return out;
}

/** Markets with leverage (margin_rules per market). */
export async function fetchGrvtMarkets(net: Network, deps: GrvtPublicDeps = DEFAULT_DEPS): Promise<GrvtVenueMarket[]> {
  const client = grvtClient(net);
  const priced = await fetchPriced(client, deps);
  const lev = await mapLimit(priced, GRVT_FANOUT_CONCURRENCY, p => fetchGrvtLeverage(client, p.meta.instrument));
  return priced.map((p, i) => toGrvtVenueMarket(p.meta, p.ticker, lev[i]));
}

/** Funding rows (ticker only — no margin_rules): fraction per the market's own interval. */
export async function fetchGrvtFundingRates(net: Network, deps: GrvtPublicDeps = DEFAULT_DEPS): Promise<VenueFundingRate[]> {
  const out: VenueFundingRate[] = [];
  for (const { meta, ticker } of await fetchPriced(grvtClient(net), deps)) {
    const rate = grvtPercentToFraction(ticker.fundingPct);
    if (rate === null) continue;
    out.push({
      venue: "grvt",
      venueSymbol: meta.instrument,
      symbol: meta.symbol,
      canonical: meta.canonical,
      rate,
      basis: grvtFundingBasis(meta),
      markPrice: ticker.markPrice,
      nextFundingTime: ticker.nextFundingTime,
    });
  }
  return out;
}

export const grvtPublicData: VenuePublicData = {
  fetchMarkets: net => fetchGrvtMarkets(net),
  fetchFundingRates: net => fetchGrvtFundingRates(net),
};
