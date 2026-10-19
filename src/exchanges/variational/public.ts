/**
 * Variational public market data — the OFFICIAL read-only API (venues/variational.ts).
 *
 * Source: `GET /metadata/v2/stats` (docs.variational.io/technical-documentation/api). One call
 * returns every listing; it is shared by every reader for VARIATIONAL_STATS_TTL_MS through the
 * file cache (cache.ts, cross-process, raw JSON body only) plus an in-process in-flight promise,
 * so `market list` + `arb scan` + `perp health` inside the window cost ONE request.
 *
 * Listings (575 on 2026-10-19: 557 perpetuals, 18 swaps):
 *  - ticker "BTC-PERP" / "XAU-SWAP", contract_type "perpetual" | "swap". Perp display symbol =
 *    the base ("BTC"); a swap keeps its suffix ("XAU-SWAP") so it never collides with "XAU" perp.
 *  - mark_price, volume_24h (USDC), open_interest.{long,short}_open_interest (USDC, single-sided:
 *    trader positions only — the OLP is the other side). Base-unit OI is NOT published, so the
 *    legacy openInterest (base units) is null; the USD figures are carried separately.
 *  - quotes.{base,size_1k,size_100k,size_1m}.{bid,ask}: the OLP's INDICATIVE RFQ quotes at fixed
 *    notionals (may be cached up to 600 s; quotes.updated_at). Omitted while a market is closed.
 *
 * Funding (docs.variational.io/omni/trading/funding-rates):
 *  - perpetual: funding.last.interval_rate is a decimal fraction for ONE interval_seconds window
 *    (1h / 4h / 8h, per market), positive = longs pay. annualized_rate is the same rate × 365 d /
 *    interval — the identity is checked per row; a row that breaks it gets no rate (warned).
 *  - rateKind "predicted": `last` is recomputed during the window (live samples 2026-10-19: 175
 *    of 557 perps changed within 2 min under the same next_timestamp) and `next` ("predicted
 *    funding rate for the next interval") equals it. It is the rate the OLP will charge at
 *    next_timestamp, not a settled print.
 *  - swap: separate long / short rates paid once per trading day — there is no single funding
 *    rate, so fundingRate is null and swaps are never matched across venues (canonical null);
 *    the long / short rates are shown on the Variational rows only.
 */

import { getCached, setCached } from "../../cache.js";
import { canonicalFor } from "../canonical-symbols.js";
import { networkConfig, type VenuePublicData } from "../venue.js";
import type { AssetClass, FundingRateBasis, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import { variationalVenue } from "../venues/variational.js";
import { variationalShapeError, VariationalClient } from "./client.js";
import { symbolNotFound } from "../unknown-symbol.js";
import type { SwapFundingRates } from "../interface.js";

/** How long one stats payload serves every reader (the venue itself sends max-age=30). */
export const VARIATIONAL_STATS_TTL_MS = 5_000;
const YEAR_SECONDS = 365 * 86_400;
/** interval_rate vs annualized_rate × interval / 365 d: both are rounded to ~4 significant digits. */
const RATE_IDENTITY_REL_TOL = 0.005;
const RATE_IDENTITY_ABS_TOL = 1e-9;

/**
 * TradFi perpetuals by class (the API publishes no asset class). Equities / ETFs match by ticker
 * identity; commodities / pre-IPO only through EXPLICIT_CANONICAL. A perp whose `name` reads like
 * a company or fund but is missing here is listed as equity with NO canonical symbol (never matched
 * across venues) until it is classified — see looksTradFi().
 */
const TRADFI_PERP_CLASS: Readonly<Record<string, AssetClass>> = {
  // Commodities
  XAU: "commodity", XAG: "commodity", XPD: "commodity", XPT: "commodity", CL: "commodity", BZ: "commodity",
  COPPER: "commodity", NATGAS: "commodity",
  // Pre-IPO
  ANTHROPIC: "preIpo", OPENAI: "preIpo",
  // ETFs
  DRAM: "etf", EWJ: "etf", EWT: "etf", EWY: "etf", EWZ: "etf", IWM: "etf", KSTR: "etf", QQQ: "etf", SOXL: "etf",
  SOXS: "etf", SPCX: "etf", TMF: "etf", TZA: "etf", URNM: "etf", UVXY: "etf", XBI: "etf", XLE: "etf", US500: "etf",
  // Equities
  AAOI: "equity", AAPL: "equity", ADBE: "equity", ALAB: "equity", AMAT: "equity", AMD: "equity", AMZN: "equity",
  APP: "equity", ARM: "equity", ASML: "equity", AVGO: "equity", BABA: "equity", BBX: "equity", BE: "equity",
  BMNR: "equity", BNC: "equity", BOT: "equity", BRKB: "equity", BX: "equity", CAT: "equity", CBRS: "equity",
  CIEN: "equity", COIN: "equity", COST: "equity", CRCL: "equity", CRDO: "equity", CRM: "equity", CRWD: "equity",
  CRWV: "equity", CSCO: "equity", DELL: "equity", DIS: "equity", DJT: "equity", DKNG: "equity", EBAY: "equity",
  FLNC: "equity", FWDI: "equity", GLW: "equity", GME: "equity", GOOGL: "equity", GPRO: "equity", HD: "equity",
  HIMS: "equity", HOOD: "equity", HPE: "equity", IBM: "equity", INTC: "equity", IREN: "equity", JPM: "equity",
  KLAC: "equity", KO: "equity", LITE: "equity", LLY: "equity", META: "equity", MRNA: "equity", MRVL: "equity",
  MSFT: "equity", MSTR: "equity", MU: "equity", NBIS: "equity", NFLX: "equity", NOK: "equity", NOW: "equity",
  NVDA: "equity", NVO: "equity", ONDS: "equity", ORCL: "equity", PAYP: "equity", PENG: "equity", PLTR: "equity",
  QCOM: "equity", QNTX: "equity", RDDT: "equity", RIVN: "equity", RKLB: "equity", SHAZ: "equity", SHOP: "equity",
  SKHY: "equity", SMCI: "equity", SNDK: "equity", SNOW: "equity", SOFI: "equity", SONY: "equity", STRC: "equity",
  STXX: "equity", TER: "equity", TSLA: "equity", TSM: "equity", TTWO: "equity", TXN: "equity", UBER: "equity",
  USAR: "equity", VISA: "equity", WEN: "equity", WMT: "equity", ZM: "equity",
};

/**
 * Variational tickers whose canonical symbol is NOT the ticker:
 *  - US500-PERP is "State Street SPDR S&P 500 ETF Trust" (SPY, mark ≈ $760), not the S&P 500 index
 *    that other venues list as US500 (→ SPX).
 * `null` = never matched across venues — the same exclusions the other venues apply:
 *  - SPX-PERP is the SPX6900 token; "SPX" is the canonical key of the S&P 500 index, and
 *    Hyperliquid / Aster / Lighter all exclude their SPX6900 (legacy-public.ts AMBIGUOUS,
 *    lighter-public.ts LIGHTER_AMBIGUOUS), so it could only ever pair with the index.
 *  - QNT-PERP is Quant (crypto); QNT is Quantinuum on Arcus / QFEX (LIGHTER_AMBIGUOUS too).
 *
 * Live cross-venue survey (2026-10-19, 440 Variational canonicals shared with another venue):
 * ZETA (ZetaChain vs QFEX Zeta Global), DIA (DIA oracle vs Lighter DIA ETF) and BEAM (Beam vs QFEX
 * Beam Global) also collide with an equity / ETF elsewhere but are the same token on the crypto
 * venues; the wrong pairing is dropped, with a stderr warning, by the cross-venue price guard
 * (rates.ts dropPriceOutliers / pair gap).
 */
const CANONICAL_OVERRIDE: Readonly<Record<string, string | null>> = {
  US500: "SPY",
  SPX: null,
  QNT: null,
};

/**
 * Hint for a cross-venue lookup by a Variational ticker whose canonical symbol differs (arb scan
 * --compare US500): where it is compared instead, or that it is never matched. null = no override.
 */
export function canonicalHintFor(symbol: string): string | null {
  const up = symbol.trim().toUpperCase().replace(/-PERP$/, "");
  if (!(up in CANONICAL_OVERRIDE)) return null;
  const canonical = CANONICAL_OVERRIDE[up];
  return canonical === null
    ? `Variational's ${up}-PERP is never matched across venues (the ticker means a different asset elsewhere)`
    : `Variational's ${up}-PERP is compared as ${canonical}: perp arb scan --compare ${canonical} --include-unverified`;
}

/** Swaps (daily-funded TradFi swaps) by class — display only: swaps never get a canonical symbol. */
const SWAP_CLASS: Readonly<Record<string, AssetClass>> = {
  XAU: "commodity", XAG: "commodity", UKOIL: "commodity", USOIL: "commodity", HOIL: "commodity", GASOL: "commodity",
  COCOA: "commodity", COPP: "commodity",
  US30: "index", US100: "index", US500: "index", US400: "index", US2K: "index", CNA50: "index", TWI: "index",
  USFNG: "index", VXI: "index",
  DXI: "fx",
};

/** A listing name that reads like a company / fund (an unclassified TradFi perp). */
const TRADFI_NAME = /\b(Inc|Corp|Corporation|Company|Holdings?|Ltd|Limited|plc|N\.V|A\/S|Oyj|ETF|Common Stock|Class [A-Z])\b\.?/i;

export function looksTradFi(name: string | null): boolean {
  return name !== null && TRADFI_NAME.test(name);
}

/** Each distinct warning once per process (the stats body is re-parsed on every read). */
const warned = new Set<string>();
export function warnOnce(warn: (msg: string) => void, msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  warn(msg);
}

// ── Parsed listing ──

export type QuoteTier = "base" | "size_1k" | "size_100k" | "size_1m";
export const QUOTE_TIERS: readonly QuoteTier[] = ["base", "size_1k", "size_100k", "size_1m"];
/** USD notional of each quote tier; "base" = the market's minimum order size (notional not published). */
export const QUOTE_TIER_NOTIONAL_USD: Readonly<Record<QuoteTier, string | null>> = {
  base: null, size_1k: "1000", size_100k: "100000", size_1m: "1000000",
};

export interface VariationalQuote { tier: QuoteTier; notionalUsd: string | null; bid: string; ask: string }
export interface VariationalQuotes { updatedAt: string; tiers: VariationalQuote[] }

export interface VariationalPerpRate { annualized: string; interval: string }
export type VariationalSwapRate = SwapFundingRates;

export type VariationalFunding =
  | { kind: "perpetual"; intervalSeconds: number; nextFundingTime: number | null; last: VariationalPerpRate; next: VariationalPerpRate | null }
  | { kind: "swap"; intervalSeconds: number; nextFundingTime: number | null; last: VariationalSwapRate | null; next: VariationalSwapRate | null };

export interface VariationalListing {
  ticker: string;
  contractType: "perpetual" | "swap";
  /** Display symbol: "BTC" for BTC-PERP, "XAU-SWAP" for a swap. */
  symbol: string;
  base: string;
  name: string | null;
  markPrice: string;
  volume24h: string;
  longOpenInterestUsd: string;
  shortOpenInterestUsd: string;
  funding: VariationalFunding | null;
  baseSpreadBps: string | null;
  quotes: VariationalQuotes | null;
  assetClass: AssetClass;
  canonical: string | null;
}

const DEC = /^-?\d+(\.\d+)?$/;
const isDec = (v: unknown): v is string => typeof v === "string" && DEC.test(v);

class RowError extends Error {}
const bad = (what: string): never => { throw new RowError(what); };
const dec = (v: unknown, what: string): string => (isDec(v) ? v : bad(`${what} is not a decimal string`));
const obj = (v: unknown, what: string): Record<string, unknown> =>
  (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : bad(`${what} is not an object`));

/** Unix seconds → ms; null stays null (documented for swaps). */
function tsMs(v: unknown, what: string, nullable: boolean): number | null {
  if (v === null && nullable) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return bad(`${what} is not a unix-seconds integer`);
  return v * 1000;
}

function perpRate(v: unknown, what: string): VariationalPerpRate {
  const r = obj(v, what);
  return { annualized: dec(r.annualized_rate, `${what}.annualized_rate`), interval: dec(r.interval_rate, `${what}.interval_rate`) };
}

function swapRate(v: unknown, what: string): VariationalSwapRate | null {
  if (v === null) return null;
  const r = obj(v, what);
  return {
    annualizedLong: dec(r.annualized_long_rate, `${what}.annualized_long_rate`),
    annualizedShort: dec(r.annualized_short_rate, `${what}.annualized_short_rate`),
    intervalLong: dec(r.interval_long_rate, `${what}.interval_long_rate`),
    intervalShort: dec(r.interval_short_rate, `${what}.interval_short_rate`),
  };
}

function funding(v: unknown, kind: "perpetual" | "swap"): VariationalFunding | null {
  if (v === null) return null;
  const f = obj(v, "funding");
  const intervalSeconds = f.interval_seconds;
  if (typeof intervalSeconds !== "number" || !Number.isInteger(intervalSeconds) || intervalSeconds <= 0) return bad("funding.interval_seconds is not a positive integer");
  if (kind === "perpetual") {
    return {
      kind, intervalSeconds,
      nextFundingTime: tsMs(f.next_timestamp, "funding.next_timestamp", false),
      last: perpRate(f.last, "funding.last"),
      next: f.next === null ? null : perpRate(f.next, "funding.next"),
    };
  }
  return {
    kind, intervalSeconds,
    nextFundingTime: tsMs(f.next_timestamp, "funding.next_timestamp", true),
    last: swapRate(f.last, "funding.last"),
    next: swapRate(f.next, "funding.next"),
  };
}

function quotes(v: unknown): VariationalQuotes | null {
  if (v === undefined) return null; // documented: omitted when unavailable (e.g. a closed swap)
  const q = obj(v, "quotes");
  if (typeof q.updated_at !== "string" || Number.isNaN(Date.parse(q.updated_at))) return bad("quotes.updated_at is not an ISO time");
  const tiers: VariationalQuote[] = [];
  for (const tier of QUOTE_TIERS) {
    if (q[tier] === undefined) continue; // documented: individual sizes are omitted when unavailable
    const t = obj(q[tier], `quotes.${tier}`);
    tiers.push({ tier, notionalUsd: QUOTE_TIER_NOTIONAL_USD[tier], bid: dec(t.bid, `quotes.${tier}.bid`), ask: dec(t.ask, `quotes.${tier}.ask`) });
  }
  return { updatedAt: q.updated_at, tiers };
}

function classify(base: string, contractType: "perpetual" | "swap", name: string | null): { assetClass: AssetClass; canonical: string | null } | null {
  if (contractType === "swap") {
    const assetClass = SWAP_CLASS[base];
    return assetClass === undefined ? null : { assetClass, canonical: null };
  }
  const known = TRADFI_PERP_CLASS[base];
  const assetClass: AssetClass = known ?? (looksTradFi(name) ? "equity" : "crypto");
  if (known === undefined && assetClass === "equity") return { assetClass, canonical: null }; // unclassified TradFi
  if (base in CANONICAL_OVERRIDE) return { assetClass, canonical: CANONICAL_OVERRIDE[base] };
  return { assetClass, canonical: canonicalFor("variational", base, assetClass) };
}

/** Parse one listing. Throws RowError (caught per row by parseStats) on any shape drift. */
function parseListing(raw: unknown): VariationalListing | { skip: string } {
  const r = obj(raw, "listing");
  if (typeof r.ticker !== "string") return bad("ticker is not a string");
  const m = /^(.+)-(PERP|SWAP)$/.exec(r.ticker);
  if (m === null) return bad(`ticker ${r.ticker} has no -PERP / -SWAP suffix`);
  const contractType = r.contract_type;
  if (contractType !== "perpetual" && contractType !== "swap") return { skip: `unknown contract_type ${String(contractType)}` };
  if ((contractType === "perpetual") !== (m[2] === "PERP")) return bad(`ticker suffix ${m[2]} disagrees with contract_type ${contractType}`);
  const base = m[1].toUpperCase();
  const name = r.name === undefined ? null : typeof r.name === "string" ? r.name.replace(/​/g, "").trim() : bad("name is not a string");
  const markPrice = dec(r.mark_price, "mark_price");
  if (!(Number(markPrice) > 0)) return { skip: "no positive mark price" };
  const oi = obj(r.open_interest, "open_interest");
  if (!("funding" in r)) return bad("funding is missing (documented as always present)");
  const cls = classify(base, contractType, name);
  if (cls === null) return { skip: "unclassified swap market" };
  return {
    ticker: r.ticker,
    contractType,
    symbol: contractType === "perpetual" ? base : r.ticker,
    base,
    name,
    markPrice,
    volume24h: dec(r.volume_24h, "volume_24h"),
    longOpenInterestUsd: dec(oi.long_open_interest, "open_interest.long_open_interest"),
    shortOpenInterestUsd: dec(oi.short_open_interest, "open_interest.short_open_interest"),
    funding: funding(r.funding, contractType),
    baseSpreadBps: r.base_spread_bps === undefined ? null : dec(r.base_spread_bps, "base_spread_bps"),
    quotes: quotes(r.quotes),
    assetClass: cls.assetClass,
    canonical: cls.canonical,
  };
}

/**
 * Parse the stats payload. A non-object payload / missing listings array is EXCHANGE_ERROR; a
 * single malformed or unclassifiable listing is dropped with a warning naming it (never guessed).
 */
export function parseVariationalStats(body: unknown, warn: (msg: string) => void): VariationalListing[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw variationalShapeError("payload is not an object");
  const listings = (body as { listings?: unknown }).listings;
  if (!Array.isArray(listings)) throw variationalShapeError("payload has no listings array");
  const out: VariationalListing[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of listings) {
    const ticker = typeof (raw as { ticker?: unknown } | null)?.ticker === "string" ? (raw as { ticker: string }).ticker : "?";
    try {
      const l = parseListing(raw);
      if ("skip" in l) { dropped.push(`${ticker} (${l.skip})`); continue; }
      if (seen.has(l.symbol)) { dropped.push(`${ticker} (listed twice)`); continue; }
      seen.add(l.symbol);
      out.push(l);
    } catch (e) {
      if (!(e instanceof RowError)) throw e;
      dropped.push(`${ticker} (${e.message})`);
    }
  }
  if (dropped.length > 0) warnOnce(warn, `[variational] dropped ${dropped.length} listing(s): ${dropped.join(", ")}`);
  return out;
}

// ── Funding ──

/** interval_rate agrees with annualized_rate × interval / 365 d (both published, both rounded). */
export function perpRateConsistent(rate: VariationalPerpRate, intervalSeconds: number): boolean {
  const interval = Number(rate.interval);
  const expected = Number(rate.annualized) * intervalSeconds / YEAR_SECONDS;
  return Math.abs(interval - expected) <= Math.max(RATE_IDENTITY_ABS_TOL, Math.abs(expected) * RATE_IDENTITY_REL_TOL);
}

/** Basis of one perp's interval_rate: perHours(interval_seconds / 3600). */
export function fundingBasisOf(f: VariationalFunding): FundingRateBasis {
  return { kind: "perHours", hours: f.intervalSeconds / 3600 };
}

/**
 * The current (predicted) funding rate per interval, or null: swaps (no single rate), no funding
 * terms, or a perp whose two published representations disagree (unit drift — warned).
 */
export function currentPerpRate(l: VariationalListing, warn: (msg: string) => void): string | null {
  const f = l.funding;
  if (f === null || f.kind !== "perpetual") return null;
  if (!perpRateConsistent(f.last, f.intervalSeconds)) {
    warnOnce(warn, `[variational] ${l.ticker}: interval_rate ${f.last.interval} disagrees with annualized_rate ${f.last.annualized} over ${f.intervalSeconds}s — funding not shown`);
    return null;
  }
  return f.last.interval;
}

// ── Fetch (rate-limited, cached, de-duplicated) ──

export interface VariationalPublicDeps {
  stats: (net: Network) => Promise<unknown>;
  cache: { get: (key: string) => unknown; set: (key: string, value: unknown, ttlMs: number) => void };
  warn: (msg: string) => void;
}

function clientFor(net: Network): VariationalClient {
  return new VariationalClient(networkConfig(variationalVenue, net).restUrl, variationalVenue.rateLimit); // testnet → NOT_IMPLEMENTED
}

const DEFAULT_DEPS: VariationalPublicDeps = {
  stats: net => clientFor(net).stats(),
  cache: { get: key => getCached<unknown>(key), set: (key, value, ttl) => setCached(key, value, ttl) },
  warn: msg => process.stderr.write(`${msg}\n`),
};

const inflight = new Map<string, Promise<unknown>>();

export const statsCacheKey = (net: Network): string => `pub:variational:${net}:stats`;

/**
 * The raw stats body: from the cache when fresh, else ONE request shared by every concurrent
 * caller in this process. Only the raw JSON body is cached (JSON-safe); parsing runs per read.
 */
export function fetchVariationalStatsRaw(net: Network, deps: VariationalPublicDeps = DEFAULT_DEPS): Promise<unknown> {
  const key = statsCacheKey(net);
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const p = (async () => {
    const hit = deps.cache.get(key);
    if (hit !== null && hit !== undefined) return hit;
    const body = await deps.stats(net);
    // Only a body of the documented shape is shared; drift fails this read and is never cached.
    if (!Array.isArray((body as { listings?: unknown } | null)?.listings)) throw variationalShapeError("payload has no listings array");
    deps.cache.set(key, body, VARIATIONAL_STATS_TTL_MS);
    return body;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

export async function fetchVariationalListings(net: Network, deps: VariationalPublicDeps = DEFAULT_DEPS): Promise<VariationalListing[]> {
  return parseVariationalStats(await fetchVariationalStatsRaw(net, deps), deps.warn);
}

// ── Mapping ──

/** null when the listing has no funding terms (its interval — part of VenueMarket — is unknown). */
export function toVariationalVenueMarket(l: VariationalListing, warn: (msg: string) => void): VenueMarket | null {
  if (l.funding === null) return null;
  return {
    venue: "variational",
    venueSymbol: l.ticker,
    symbol: l.symbol,
    canonical: l.canonical,
    assetClass: l.assetClass,
    settle: "USDC",
    quoteAsset: "USDC",
    markPrice: l.markPrice,
    // No index / oracle price is published.
    indexPrice: null,
    fundingRate: currentPerpRate(l, warn),
    fundingRateBasis: fundingBasisOf(l.funding),
    settlementIntervalHours: l.funding.intervalSeconds / 3600,
    // Published in USD and single-sided only; base-unit OI is unknown.
    openInterest: null,
    volume24h: l.volume24h,
    tickSize: null,
    stepSize: null,
    minSize: null,
    minNotional: null,
    maxLeverage: null,
    marginTiers: null,
    session: null,
    // Quotes are omitted while a market is closed: no quote → not tradable right now.
    tradable: l.quotes !== null && l.quotes.tiers.length > 0,
  };
}

export async function fetchVariationalMarkets(net: Network, deps: VariationalPublicDeps = DEFAULT_DEPS): Promise<VenueMarket[]> {
  const out: VenueMarket[] = [];
  const noFunding: string[] = [];
  for (const l of await fetchVariationalListings(net, deps)) {
    const m = toVariationalVenueMarket(l, deps.warn);
    if (m === null) noFunding.push(l.ticker);
    else out.push(m);
  }
  if (noFunding.length > 0) warnOnce(deps.warn, `[variational] ${noFunding.length} market(s) publish no funding terms (interval unknown) and are not shown here: ${noFunding.join(", ")}`);
  return out;
}

export async function fetchVariationalFundingRates(net: Network, deps: VariationalPublicDeps = DEFAULT_DEPS): Promise<VenueFundingRate[]> {
  const out: VenueFundingRate[] = [];
  for (const l of await fetchVariationalListings(net, deps)) {
    const m = toVariationalVenueMarket(l, deps.warn);
    if (m === null || !m.tradable || m.fundingRate === null || l.funding === null) continue;
    out.push({
      venue: "variational",
      venueSymbol: m.venueSymbol,
      symbol: m.symbol,
      canonical: m.canonical,
      rate: m.fundingRate,
      basis: m.fundingRateBasis,
      markPrice: m.markPrice,
      nextFundingTime: l.funding.nextFundingTime,
    });
  }
  return out;
}

export const variationalPublicData: VenuePublicData = {
  fetchMarkets: net => fetchVariationalMarkets(net),
  fetchFundingRates: net => fetchVariationalFundingRates(net),
};

/** Resolve a CLI symbol ("btc", "BTC-PERP", "xau-swap") against the parsed listings. */
export function resolveVariationalListing(listings: readonly VariationalListing[], input: string): VariationalListing {
  const up = input.trim().toUpperCase();
  const hit = listings.find(l => l.ticker === up || l.symbol === up);
  if (hit === undefined) throw symbolNotFound("variational", input, `Variational has no listed market ${input}`);
  return hit;
}
