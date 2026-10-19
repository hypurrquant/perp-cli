/**
 * Extended public market data — GET /api/v1/info/markets (one call serves markets and funding).
 * Docs: https://api.docs.extended.exchange/ ("Get markets").
 *
 * Mapping:
 *  - Only `type: "PERPETUAL"` rows with `status` ACTIVE or REDUCE_ONLY are markets here. The
 *    `active` flag is NOT a listing state (live 2026-10-19: 54 DELISTED and 12 PRELISTED rows have
 *    `active: true`); SPOT rows carry perp fields as 0 (docs) and are excluded.
 *  - venueSymbol = `name` ("BTC-USD", "TSLA_24_5-USD", "SPX500m-USD"), the wire id of every
 *    per-market endpoint. symbol = `assetName` upper-cased with the `_24_5` naming suffix removed
 *    ("TSLA_24_5" → "TSLA", "SPX500m" → "SPX500M"). Two listed markets with one symbol: the single
 *    ACTIVE one is kept, else both are skipped (warned).
 *  - tradable = status ACTIVE && !isOffHours (docs "Trading hours": while isOffHours, order
 *    placement and execution are unavailable). REDUCE_ONLY rows are listed, not tradable.
 *  - tick = tradingConfig.minPriceChange, step = minOrderSizeChange, min size = minOrderSize,
 *    maxLeverage = tradingConfig.maxLeverage; marginTiers from riskFactorConfig (rows available to
 *    users; leverage = 1 / riskFactor — the first tier equals maxLeverage on every live market).
 *  - open interest = marketStats.openInterestBase (base units); 24h volume = dailyVolume (USD).
 *
 * Asset class (`category` / `subCategory`): Crypto → crypto; RWA → Equity: equity, Commodity:
 * commodity, FX: fx, Pre-market: preIpo, ETF/Index: etf for the ETFs in EXTENDED_ETFS, else index.
 * Any other category / subCategory is skipped with a warning (never guessed).
 *
 * Canonical (cross-venue key, canonical-symbols.ts): crypto and equity / ETF by ticker identity;
 * index / commodity / fx / preIpo only through EXPLICIT_CANONICAL. An RWA ticker that is also a
 * crypto ticker is NEVER matched (canonical null): EXTENDED_RWA_CRYPTO_COLLISIONS (PURR =
 * Hyperliquid Strategies Inc. vs the PURR token; QNT = Quantinuum vs Quant; BB = BlackBerry vs
 * BounceBit; ON = ON Semiconductor vs the ON token; ADI = Analog Devices vs the ADI token). An RWA
 * ticker equal to one of Extended's own crypto symbols is never matched either: symbols are unique per
 * listing (dedupeSymbols). The crypto SPX market (SPX6900) is ambiguous with the S&P 500 index
 * canonical "SPX" and is never matched (EXTENDED_AMBIGUOUS_CRYPTO, as Hyperliquid's SPX). XIAOMI is
 * not matched (EXTENDED_UNMATCHED_EQUITIES): ~7.8× the Lighter / Aster XIAOMI price on 2026-10-19,
 * i.e. a different unit (HKD-per-share vs a USD-quoted product), not the same contract.
 *
 * Funding (docs "Get funding rates history" + docs.extended.exchange funding-payments):
 *  - applied once per hour ("While the funding rate is calculated every minute, it is only applied
 *    once per hour"); payment = position size × mark price × (−rate).
 *  - marketStats.fundingRate is a FRACTION per hour (crypto interest component 0.01 % / 8 h =
 *    0.0000125 / h, published as "0.000013"; RWA 0.0035 % / 8 h → "0.000004").
 *  - it is the CURRENT hour's rate, recomputed every minute (accruing): it can differ from the last
 *    applied print in /info/<market>/funding mid-hour, and becomes that print at the hour.
 *  - marketStats.nextFundingRate is (despite its name) the timestamp (ms) of the next application.
 *  - rates are published ROUNDED TO 6 DECIMALS (resolution 0.000001 / h ≈ 0.876 % APR): the
 *    0.0000125 baseline reads "0.000013", and a rate below 0.0000005 / h reads "0.000000".
 *  - `_24_5` RWA equities print 0 while their underlying is closed (TSLA_24_5-USD: 34 of 43
 *    weekend prints were 0), so an hourly rate × 8760 overstates them — the venue is
 *    fundingVerified false (venues/extended.ts).
 */

import { PerpError } from "../../errors.js";
import { canonicalFor } from "../canonical-symbols.js";
import { networkConfig, type VenuePublicData } from "../venue.js";
import type { AssetClass, FundingRateBasis, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import { extendedVenue } from "../venues/extended.js";
import { symbolNotFound } from "../unknown-symbol.js";
import { EXTENDED_MARKET_NOT_FOUND, ExtendedClient, extendedShapeError } from "./client.js";

export const EXTENDED_FUNDING_BASIS: FundingRateBasis = { kind: "perHours", hours: 1 };

/** RWA "ETF/Index" markets that are ETFs (the rest of that subCategory are indices). */
export const EXTENDED_ETFS: ReadonlySet<string> = new Set(["DRAM", "SOXL", "EWY", "KORU"]);

/**
 * RWA tickers that are also crypto tickers on other venues (live 2026-10-19) — never matched.
 * ADI: Analog Devices vs Lighter's ADI token. BOT: RoboStrategy (PRELISTED on 2026-10-19) vs the BOT
 * token (Lighter LIGHTER_AMBIGUOUS). WEN (also Lighter-ambiguous) is not listed on Extended.
 */
export const EXTENDED_RWA_CRYPTO_COLLISIONS: ReadonlySet<string> = new Set(["PURR", "QNT", "BB", "ON", "ADI", "BOT"]);

/** RWA markets whose product differs from the same ticker elsewhere (XIAOMI: ~7.8× Lighter / Aster). */
export const EXTENDED_UNMATCHED_EQUITIES: ReadonlySet<string> = new Set(["XIAOMI"]);

/** Crypto tickers that name an index elsewhere — never matched (SPX-USD = SPX6900, not the S&P 500). */
export const EXTENDED_AMBIGUOUS_CRYPTO: ReadonlySet<string> = new Set(["SPX"]);

const LISTED_STATUSES: ReadonlySet<string> = new Set(["ACTIVE", "REDUCE_ONLY"]);
const DEC = /^-?\d+(\.\d+)?$/;

export interface ExtendedMarketMeta {
  /** Wire id ("BTC-USD"). */
  name: string;
  symbol: string;
  assetClass: AssetClass;
  canonical: string | null;
  status: "ACTIVE" | "REDUCE_ONLY";
  isRfq: boolean;
  isOffHours: boolean;
  tradingHours: string;
}

export interface ExtendedMarketRow { meta: ExtendedMarketMeta; market: VenueMarket; nextFundingTime: number | null }

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") throw extendedShapeError(`${where}.${key} is not a string`);
  return v;
}

function decStr(o: Record<string, unknown>, key: string, where: string): string {
  const v = str(o, key, where);
  if (!DEC.test(v)) throw extendedShapeError(`${where}.${key} "${v}" is not a decimal string`);
  return v;
}

/** A published decimal string, or null when absent / not a decimal. */
function decOrNull(v: unknown): string | null {
  return typeof v === "string" && DEC.test(v) ? v : null;
}

function positiveOrNull(v: unknown): string | null {
  const d = decOrNull(v);
  return d !== null && Number(d) > 0 ? d : null;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw extendedShapeError(`${where} is not an object`);
  return v as Record<string, unknown>;
}

/** "TSLA_24_5" → "TSLA"; "SPX500m" → "SPX500M". */
export function extendedSymbolOf(assetName: string): string {
  return assetName.replace(/_24_5$/, "").toUpperCase();
}

/** Asset class from category / subCategory; null = unknown (the row is skipped with a warning). */
export function extendedAssetClass(category: string, subCategory: string | null, symbol: string): AssetClass | null {
  if (category === "Crypto") return "crypto";
  if (category !== "RWA") return null;
  switch (subCategory) {
    case "Equity": return "equity";
    case "Commodity": return "commodity";
    case "FX": return "fx";
    case "Pre-market": return "preIpo";
    case "ETF/Index": return EXTENDED_ETFS.has(symbol) ? "etf" : "index";
    default: return null;
  }
}

/** Canonical key, or null when the market must not be matched across venues. */
export function extendedCanonical(symbol: string, assetClass: AssetClass): string | null {
  if (assetClass === "crypto" && EXTENDED_AMBIGUOUS_CRYPTO.has(symbol)) return null;
  if (assetClass !== "crypto" && (EXTENDED_RWA_CRYPTO_COLLISIONS.has(symbol) || EXTENDED_UNMATCHED_EQUITIES.has(symbol))) return null;
  return canonicalFor("extended", symbol, assetClass);
}

function marginTiersOf(tc: Record<string, unknown>, where: string): Array<{ lowerBound: number; maxLeverage: number }> {
  const raw = tc.riskFactorConfig;
  if (!Array.isArray(raw) || raw.length === 0) throw extendedShapeError(`${where}.riskFactorConfig is not a list`);
  const tiers: Array<{ lowerBound: number; maxLeverage: number }> = [];
  let lower = 0;
  for (const t of raw) {
    const r = obj(t, `${where}.riskFactorConfig[]`);
    const upper = Number(decStr(r, "upperBound", `${where}.riskFactorConfig[]`));
    const rf = Number(decStr(r, "riskFactor", `${where}.riskFactorConfig[]`));
    if (typeof r.isAvailableForUsers !== "boolean") throw extendedShapeError(`${where}.riskFactorConfig[].isAvailableForUsers is not a boolean`);
    if (!(rf > 0)) throw extendedShapeError(`${where}.riskFactorConfig[].riskFactor ${rf} is not positive`);
    if (r.isAvailableForUsers) tiers.push({ lowerBound: lower, maxLeverage: 1 / rf });
    lower = upper;
  }
  if (tiers.length === 0) throw extendedShapeError(`${where} has no risk tier available to users`);
  return tiers;
}

interface RawRow { raw: Record<string, unknown>; name: string; symbol: string; assetClass: AssetClass; status: "ACTIVE" | "REDUCE_ONLY" }

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Classify one /info/markets row: a listed perpetual, or null (not a listed perp). Shape drift throws. */
function classifyRow(item: unknown, unclassified: string[]): RawRow | null {
  const r = obj(item, "/info/markets data[]");
  const name = str(r, "name", "market");
  const where = `market ${name}`;
  if (str(r, "type", where) !== "PERPETUAL") return null;
  const status = str(r, "status", where);
  if (!LISTED_STATUSES.has(status)) return null;
  const symbol = extendedSymbolOf(str(r, "assetName", where));
  const sub = r.subCategory;
  const assetClass = extendedAssetClass(str(r, "category", where), typeof sub === "string" ? sub : null, symbol);
  if (assetClass === null) { unclassified.push(`${name} (${String(r.category)}/${String(sub)})`); return null; }
  return { raw: r, name, symbol, assetClass, status: status as "ACTIVE" | "REDUCE_ONLY" };
}

/**
 * One symbol per market: when several listed rows map to one symbol (a ticker migration such as
 * NOW_24_5-USD → NOW-USD), the single ACTIVE row is kept and the others dropped; with no single
 * ACTIVE row, every row of that symbol is skipped. Both cases are warned, never silent.
 */
function dedupeSymbols(listed: RawRow[], warn: (msg: string) => void): RawRow[] {
  const groups = new Map<string, RawRow[]>();
  for (const l of listed) {
    const g = groups.get(l.symbol);
    if (g === undefined) groups.set(l.symbol, [l]);
    else g.push(l);
  }
  const out: RawRow[] = [];
  for (const [symbol, g] of groups) {
    if (g.length === 1) { out.push(g[0]); continue; }
    const active = g.filter(l => l.status === "ACTIVE");
    const names = g.map(l => `${l.name} (${l.status})`).join(", ");
    if (active.length === 1) {
      out.push(active[0]);
      warn(`[extended] ${g.length} listed markets map to symbol ${symbol}: ${names} — kept the ACTIVE ${active[0].name}`);
    } else {
      warn(`[extended] ${g.length} listed markets map to symbol ${symbol}: ${names} — no single ACTIVE row, all skipped`);
    }
  }
  return out;
}

function buildRow(l: RawRow): ExtendedMarketRow | "unpriced" {
  const { raw: r, name, symbol, assetClass, status } = l;
  const where = `market ${name}`;
  const stats = obj(r.marketStats, `${where}.marketStats`);
  const tc = obj(r.tradingConfig, `${where}.tradingConfig`);
  const mark = positiveOrNull(stats.markPrice);
  if (mark === null) return "unpriced";
  if (typeof r.isRfq !== "boolean" || typeof r.isOffHours !== "boolean") throw extendedShapeError(`${where} has no isRfq / isOffHours flags`);
  const maxLeverage = Number(decStr(tc, "maxLeverage", `${where}.tradingConfig`));
  if (!(maxLeverage > 0)) throw extendedShapeError(`${where}.tradingConfig.maxLeverage is not positive`);
  const next = stats.nextFundingRate;
  const nextFundingTime = typeof next === "number" && Number.isInteger(next) && next > 0 ? next : null;
  const canonical = extendedCanonical(symbol, assetClass);
  const meta: ExtendedMarketMeta = {
    name, symbol, assetClass, canonical, status,
    isRfq: r.isRfq, isOffHours: r.isOffHours, tradingHours: str(r, "tradingHours", where),
  };
  return {
    meta,
    nextFundingTime,
    market: {
      venue: "extended",
      venueSymbol: name,
      symbol,
      canonical,
      assetClass,
      settle: "USD",
      quoteAsset: str(r, "collateralAssetName", where),
      markPrice: mark,
      indexPrice: positiveOrNull(stats.indexPrice),
      fundingRate: decOrNull(stats.fundingRate),
      fundingRateBasis: EXTENDED_FUNDING_BASIS,
      settlementIntervalHours: 1,
      openInterest: decOrNull(stats.openInterestBase),
      volume24h: decOrNull(stats.dailyVolume),
      tickSize: decStr(tc, "minPriceChange", `${where}.tradingConfig`),
      stepSize: decStr(tc, "minOrderSizeChange", `${where}.tradingConfig`),
      minSize: decStr(tc, "minOrderSize", `${where}.tradingConfig`),
      minNotional: null,
      maxLeverage,
      marginTiers: marginTiersOf(tc, `${where}.tradingConfig`),
      session: null,
      tradable: status === "ACTIVE" && !r.isOffHours,
    },
  };
}

/**
 * Parse /info/markets `data` into listed perpetual markets. A row that does not match the
 * documented shape is skipped with a warning naming it (one drifted row never hides the others);
 * rows of an unknown category, without a mark price, or sharing a symbol (dedupeSymbols) are
 * skipped with a warning too. EXCHANGE_ERROR only for envelope drift (`data` not a list) or when
 * malformed rows leave no market at all.
 */
export function parseExtendedMarkets(data: unknown, warn: (msg: string) => void): ExtendedMarketRow[] {
  if (!Array.isArray(data)) throw extendedShapeError("/info/markets data is not a list");
  const malformed: string[] = [];
  const unclassified: string[] = [];
  const listed: RawRow[] = [];
  for (const item of data) {
    try {
      const l = classifyRow(item, unclassified);
      if (l !== null) listed.push(l);
    } catch (e) {
      malformed.push(describe(e));
    }
  }
  if (unclassified.length > 0) warn(`[extended] skipped ${unclassified.length} market(s) of an unknown category: ${unclassified.join(", ")}`);

  const out: ExtendedMarketRow[] = [];
  const unpriced: string[] = [];
  for (const l of dedupeSymbols(listed, warn)) {
    try {
      const row = buildRow(l);
      if (row === "unpriced") unpriced.push(l.name);
      else out.push(row);
    } catch (e) {
      malformed.push(describe(e));
    }
  }
  if (unpriced.length > 0) warn(`[extended] dropped ${unpriced.length} listed market(s) without a mark price: ${unpriced.join(", ")}`);
  if (malformed.length > 0) {
    if (out.length === 0) throw extendedShapeError(`no market parsed (${malformed.length} malformed row(s); first: ${malformed[0]})`);
    warn(`[extended] skipped ${malformed.length} malformed market row(s): ${malformed.slice(0, 5).join("; ")}${malformed.length > 5 ? "; …" : ""}`);
  }
  return out;
}

export function extendedClient(net: Network): ExtendedClient {
  return new ExtendedClient(networkConfig(extendedVenue, net).restUrl, extendedVenue.rateLimit, `extended:${net}`);
}

export interface ExtendedPublicDeps { warn: (msg: string) => void }

const DEFAULT_DEPS: ExtendedPublicDeps = { warn: msg => process.stderr.write(`${msg}\n`) };

export async function fetchExtendedMarketRows(client: ExtendedClient, deps: ExtendedPublicDeps = DEFAULT_DEPS): Promise<ExtendedMarketRow[]> {
  const body = await client.get<unknown>("/info/markets");
  return parseExtendedMarkets(body.data, deps.warn);
}

export async function fetchExtendedMarkets(net: Network, deps: ExtendedPublicDeps = DEFAULT_DEPS): Promise<VenueMarket[]> {
  return (await fetchExtendedMarketRows(extendedClient(net), deps)).map(r => r.market);
}

/** Funding rows: the current hour's accruing rate (fraction per hour); a market without one has no row. */
export function toExtendedFundingRates(rows: readonly ExtendedMarketRow[]): VenueFundingRate[] {
  const out: VenueFundingRate[] = [];
  for (const { market, nextFundingTime } of rows) {
    if (market.fundingRate === null) continue;
    out.push({
      venue: "extended",
      venueSymbol: market.venueSymbol,
      symbol: market.symbol,
      canonical: market.canonical,
      rate: market.fundingRate,
      basis: EXTENDED_FUNDING_BASIS,
      markPrice: market.markPrice,
      nextFundingTime,
    });
  }
  return out;
}

export async function fetchExtendedFundingRates(net: Network, deps: ExtendedPublicDeps = DEFAULT_DEPS): Promise<VenueFundingRate[]> {
  return toExtendedFundingRates(await fetchExtendedMarketRows(extendedClient(net), deps));
}

export const extendedPublicData: VenuePublicData = {
  fetchMarkets: net => fetchExtendedMarkets(net),
  fetchFundingRates: net => fetchExtendedFundingRates(net),
};

/**
 * Resolve a CLI symbol against the listed markets: the wire name ("BTC-USD", "TSLA_24_5-USD")
 * first, then the display symbol ("tsla", "BTC-PERP"), then "<symbol>-USD" ("TSLA-USD").
 * Unlisted → SYMBOL_NOT_FOUND.
 */
export function resolveExtendedMarket(markets: readonly ExtendedMarketMeta[], input: string): ExtendedMarketMeta {
  const up = input.trim().toUpperCase().replace(/-PERP$/, "");
  const matchers: Array<(m: ExtendedMarketMeta) => boolean> = [
    m => m.name.toUpperCase() === up,
    m => m.symbol === up,
    m => `${m.symbol}-USD` === up,
  ];
  for (const match of matchers) {
    const hit = markets.find(match);
    if (hit !== undefined) return hit;
  }
  throw symbolNotFound("extended", input);
}

function isMarketNotFound(e: unknown): boolean {
  return e instanceof PerpError && e.structured.details?.venueCode === EXTENDED_MARKET_NOT_FOUND;
}

/** Wire names a bare CLI symbol may be ("btc" → BTC-USD, BTC_24_5-USD): every name whose row maps to that symbol. */
export function extendedWireCandidates(symbol: string): string[] {
  const up = extendedSymbolOf(symbol.trim().replace(/-PERP$/i, ""));
  return [`${up}-USD`, `${up}_24_5-USD`];
}

/** Rows of `GET /info/markets?market=<name>`; [] when the venue answers code 1001 (unknown name). */
async function rowsByName(client: ExtendedClient, name: string): Promise<unknown[]> {
  let body: Awaited<ReturnType<ExtendedClient["get"]>>;
  try {
    body = await client.get<unknown>("/info/markets", [["market", name]]);
  } catch (e) {
    if (isMarketNotFound(e)) return [];
    throw e;
  }
  if (!Array.isArray(body.data)) throw extendedShapeError(`/info/markets?market=${name} data is not a list`);
  return body.data;
}

/** The symbol a raw row maps to, or null when the row has no assetName (parseExtendedMarkets reports it). */
function rawSymbolOf(row: unknown): string | null {
  const a = row !== null && typeof row === "object" ? (row as { assetName?: unknown }).assetName : undefined;
  return typeof a === "string" && a !== "" ? extendedSymbolOf(a) : null;
}

/**
 * Resolve a CLI symbol for a per-market read without the ~1 MB full listing, by the SAME rules as
 * the listing (parseExtendedMarkets → dedupeSymbols, with its warning):
 *  1. The symbol's wire names are read with `GET /info/markets?market=<name>` (2–3 KB each;
 *     case-sensitive; unknown = HTTP 400 code 1001): for a bare symbol `<S>-USD` and
 *     `<S>_24_5-USD`; for a wire name ("NOW-USD") that name first, then the other names of the
 *     symbol its row maps to — so a ticker migration (NOW-USD + NOW_24_5-USD) is deduplicated here
 *     exactly as in `market list`.
 *  2. Every returned row goes through parseExtendedMarkets: not a listed perpetual, unpriced, or
 *     losing the duplicate-symbol rule → not a market. resolveExtendedMarket then decides;
 *     nothing left → SYMBOL_NOT_FOUND.
 *  3. Only when EVERY name answered 1001 (no row at all — e.g. "spx500m" for SPX500m-USD) does the
 *     full listing decide.
 * A malformed row in a `?market=` reply is EXCHANGE_ERROR when it leaves no row to parse (the
 * market asked for is unreadable — no fallback to the listing); next to a valid row it is skipped
 * with a warning, as in the listing. Any error other than 1001 is thrown as is.
 */
export async function resolveExtendedMarketRemote(client: ExtendedClient, input: string, deps: ExtendedPublicDeps = DEFAULT_DEPS): Promise<ExtendedMarketMeta> {
  const raw = input.trim().replace(/-PERP$/i, "");
  const up = raw.toUpperCase();
  const rows = new Map<string, unknown>();
  const queried = new Set<string>();
  const read = async (name: string): Promise<unknown[]> => {
    if (queried.has(name)) return [];
    queried.add(name);
    const got = await rowsByName(client, name);
    for (const r of got) {
      const n = r !== null && typeof r === "object" ? (r as { name?: unknown }).name : undefined;
      rows.set(typeof n === "string" ? n : `#${rows.size}`, r);
    }
    return got;
  };
  let names: string[];
  if (up.endsWith("-USD")) {
    let first = await read(raw);
    if (first.length === 0 && up !== raw) first = await read(up);
    const symbols = [...new Set(first.map(rawSymbolOf).filter((x): x is string => x !== null))];
    names = symbols.flatMap(extendedWireCandidates);
  } else {
    names = extendedWireCandidates(up);
  }
  for (const name of names) await read(name);
  if (rows.size === 0) return resolveExtendedMarket((await fetchExtendedMarketRows(client, deps)).map(r => r.meta), input);
  const metas = parseExtendedMarkets([...rows.values()], deps.warn).map(r => r.meta);
  return resolveExtendedMarket(metas, input);
}
