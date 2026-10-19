/**
 * TxFlow public market data — UNOFFICIAL API (see venues/txflow.ts).
 *
 * Sources:
 *   POST /info {type:"perpMeta", dex:""}   market directory: index (numeric coin id, with gaps),
 *                                         name "BTC-USDC", baseCurrency, szDecimals (can be
 *                                         NEGATIVE: lot 10, 100 …), priceTick, maxLeverage,
 *                                         haltTrading, delisted, tagIds
 *   POST /info {type:"allMarketTickers"}  per instrument: dayNtlVlm (24 h USD notional), prevDayPx …;
 *                                         `instrumentId` == perpMeta `index` (spot rows ≥ 10000),
 *                                         empty fields are "" (→ null). `market list|prices` only.
 *   WS allAssetCtxs (one-shot snapshot)   per coin: markPx, oraclePx, funding, openInterest,
 *                                         nextFundingTime, prevFundingTime. `coin` == perpMeta
 *                                         `index` (as a string) — joined by id, never by position.
 *
 * Funding: `funding` is PERCENT per hour (settlementIntervalMs 3600000 on every market; 0.00125 is
 * the HL-style 0.00125 %/h baseline). Converted to a fraction per hour by an exact two-place decimal
 * shift (no float maths). The value moves every tick: an accruing / predicted estimate, not a
 * settled print — the venue is fundingVerified false. A market whose next − prev funding time is
 * not one hour gets no funding row.
 */

import { PerpError } from "../../errors.js";
import { canonicalFor } from "../canonical-symbols.js";
import type { VenuePublicData } from "../venue.js";
import { networkConfig } from "../venue.js";
import type { AssetClass, FundingRateBasis, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import { txflowVenue } from "../venues/txflow.js";
import { fetchAllAssetCtxsOnce, txflowShapeError, TxflowClient, type TxflowRawAssetCtx, type WsFactory, defaultWsFactory } from "./client.js";

export const TXFLOW_FUNDING_BASIS: FundingRateBasis = { kind: "perHours", hours: 1 };
export const TXFLOW_SETTLEMENT_MS = 3_600_000;
/** perpMeta tag id of the TradFi (equity / commodity / ETF) markets. */
export const TXFLOW_TRADFI_TAG = 5;

/**
 * TradFi markets by class. Equities are matched by ticker identity; commodities / ETFs / pre-IPO only
 * through EXPLICIT_CANONICAL. A TradFi market missing here is listed as equity with NO canonical
 * symbol (never matched across venues) until it is classified.
 */
const TRADFI_CLASS: Readonly<Record<string, AssetClass>> = {
  XAU: "commodity", XAG: "commodity", XPD: "commodity", XPT: "commodity", CL: "commodity", BZ: "commodity",
  SPY: "etf", QQQ: "etf", EWJ: "etf", SOXL: "etf", URNM: "etf", UVXY: "etf",
  SPCX: "preIpo",
  MSTR: "equity", CRCL: "equity", TSLA: "equity", COIN: "equity", HOOD: "equity", META: "equity", MU: "equity",
  AAPL: "equity", AMZN: "equity", GOOGL: "equity", INTC: "equity", NVDA: "equity", PLTR: "equity", SNDK: "equity",
  TSM: "equity", MSFT: "equity", AMD: "equity", LITE: "equity", AVGO: "equity", CRWV: "equity", QCOM: "equity",
  ARM: "equity", LRCX: "equity", SKHYNIX: "equity", SAMSUNG: "equity", STXX: "equity",
};

// ── Directory ──

export interface TxflowMarketMeta {
  /** Numeric coin id (perpMeta `index`); its decimal string is the wire id and venueSymbol. */
  index: number;
  name: string;
  symbol: string;
  quote: string;
  tickSize: string;
  stepSize: string;
  maxLeverage: number;
  halted: boolean;
  tagIds: number[];
  assetClass: AssetClass;
  canonical: string | null;
}

/** Lot step from szDecimals, exactly: 4 → "0.0001", 0 → "1", -2 → "100". */
export function stepFromSzDecimals(sz: number): string {
  if (!Number.isInteger(sz)) throw txflowShapeError(`szDecimals ${sz} is not an integer`);
  if (sz > 0) return `0.${"0".repeat(sz - 1)}1`;
  return `1${"0".repeat(-sz)}`;
}

/** Exact percent → fraction (two-place decimal shift on the string; "0.00125" → "0.0000125"). */
export function percentToFraction(pct: string): string {
  const s = pct.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw txflowShapeError(`funding "${pct}" is not a plain decimal`);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [ip, fp = ""] = body.split(".");
  const digits = `${ip}${fp}`;
  const scale = fp.length + 2;
  const padded = digits.padStart(scale + 1, "0");
  let out = `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
  out = out.replace(/0+$/, "").replace(/\.$/, "");
  out = out.replace(/^0+(?=\d)/, "");
  if (/^0(\.0*)?$/.test(out) || out === "") return "0";
  return neg ? `-${out}` : out;
}

function assetClassOf(symbol: string, tagIds: number[]): AssetClass {
  if (!tagIds.includes(TXFLOW_TRADFI_TAG)) return "crypto";
  return TRADFI_CLASS[symbol] ?? "equity";
}

function canonicalOf(symbol: string, tagIds: number[], assetClass: AssetClass): string | null {
  // An unclassified TradFi market is never matched across venues.
  if (tagIds.includes(TXFLOW_TRADFI_TAG) && TRADFI_CLASS[symbol] === undefined) return null;
  return canonicalFor("txflow", symbol, assetClass);
}

/** Parse one perpMeta row; shape drift is EXCHANGE_ERROR. Returns null for a delisted market. */
export function toTxflowMarketMeta(raw: unknown): TxflowMarketMeta | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw txflowShapeError("perpMeta universe row is not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0) throw txflowShapeError(`perpMeta row ${String(r.name)} has a non-numeric index`);
  if (typeof r.name !== "string" || typeof r.baseCurrency !== "string" || r.baseCurrency === "") throw txflowShapeError(`perpMeta row ${r.index} has no name / baseCurrency`);
  if (typeof r.quoteCurrency !== "string") throw txflowShapeError(`perpMeta ${r.name} has no quoteCurrency`);
  if (typeof r.szDecimals !== "number") throw txflowShapeError(`perpMeta ${r.name} has no szDecimals`);
  if (typeof r.priceTick !== "string" || !/^\d+(\.\d+)?$/.test(r.priceTick) || !(Number(r.priceTick) > 0)) throw txflowShapeError(`perpMeta ${r.name} has no valid priceTick`);
  if (typeof r.maxLeverage !== "number" || !(r.maxLeverage > 0)) throw txflowShapeError(`perpMeta ${r.name} has no maxLeverage`);
  if (typeof r.haltTrading !== "boolean" || typeof r.delisted !== "boolean") throw txflowShapeError(`perpMeta ${r.name} has no haltTrading / delisted flags`);
  if (!Array.isArray(r.tagIds) || r.tagIds.some(t => typeof t !== "number")) throw txflowShapeError(`perpMeta ${r.name} has no tagIds`);
  if (r.delisted) return null;
  const symbol = r.baseCurrency.toUpperCase();
  const tagIds = r.tagIds as number[];
  const assetClass = assetClassOf(symbol, tagIds);
  return {
    index: r.index,
    name: r.name,
    symbol,
    quote: r.quoteCurrency,
    tickSize: r.priceTick,
    stepSize: stepFromSzDecimals(r.szDecimals),
    maxLeverage: r.maxLeverage,
    halted: r.haltTrading,
    tagIds,
    assetClass,
    canonical: canonicalOf(symbol, tagIds, assetClass),
  };
}

export async function fetchTxflowDirectory(client: TxflowClient): Promise<TxflowMarketMeta[]> {
  const res = await client.info<{ universe?: unknown }>({ type: "perpMeta", dex: "" });
  if (res === null || typeof res !== "object" || !Array.isArray(res.universe)) throw txflowShapeError("perpMeta has no universe array");
  const out: TxflowMarketMeta[] = [];
  const seen = new Set<string>();
  for (const row of res.universe) {
    const m = toTxflowMarketMeta(row);
    if (m === null) continue;
    if (seen.has(m.symbol)) throw txflowShapeError(`perpMeta lists ${m.symbol} twice`);
    seen.add(m.symbol);
    out.push(m);
  }
  return out;
}

// ── Snapshot join ──

export interface TxflowCtx {
  markPx: string;
  oraclePx: string | null;
  /** Percent per hour, as published; null when absent. */
  fundingPct: string | null;
  openInterest: string | null;
  nextFundingTime: number | null;
  prevFundingTime: number | null;
}

function decOrNull(v: unknown): string | null {
  return typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? v : null;
}

function msOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Join snapshot entries to the directory by coin id. An entry whose coin id is not a listed
 * market is dropped with a warning (never matched by position); an entry without a mark price
 * is dropped too (a market row needs one).
 */
export function joinSnapshot(dir: readonly TxflowMarketMeta[], ctxs: readonly TxflowRawAssetCtx[], warn: (msg: string) => void): Map<number, TxflowCtx> {
  const byIndex = new Map(dir.map(m => [String(m.index), m]));
  const out = new Map<number, TxflowCtx>();
  const unknown: string[] = [];
  const unpriced: string[] = [];
  for (const { coin, ctx } of ctxs) {
    const meta = byIndex.get(coin);
    if (meta === undefined) { unknown.push(coin); continue; }
    const markPx = decOrNull(ctx.markPx);
    if (markPx === null || !(Number(markPx) > 0)) { unpriced.push(meta.symbol); continue; }
    out.set(meta.index, {
      markPx,
      oraclePx: decOrNull(ctx.oraclePx),
      fundingPct: decOrNull(ctx.funding),
      openInterest: decOrNull(ctx.openInterest),
      nextFundingTime: msOrNull(ctx.nextFundingTime),
      prevFundingTime: msOrNull(ctx.prevFundingTime),
    });
  }
  if (unknown.length > 0) warn(`[txflow] dropped ${unknown.length} snapshot entr${unknown.length === 1 ? "y" : "ies"} for unknown coin id(s): ${unknown.join(", ")}`);
  if (unpriced.length > 0) warn(`[txflow] dropped ${unpriced.length} snapshot entr${unpriced.length === 1 ? "y" : "ies"} without a mark price: ${unpriced.join(", ")}`);
  return out;
}

/**
 * Hourly funding fraction for one ctx, or null (unknown) when the rate is absent or the one-hour
 * interval cannot be PROVEN from next − prev funding time (a missing time is unknown, never assumed 1h).
 */
export function hourlyFundingOf(ctx: TxflowCtx): string | null {
  if (ctx.fundingPct === null) return null;
  if (ctx.nextFundingTime === null || ctx.prevFundingTime === null) return null;
  if (ctx.nextFundingTime - ctx.prevFundingTime !== TXFLOW_SETTLEMENT_MS) return null;
  return percentToFraction(ctx.fundingPct);
}

// ── Mapping ──

/** First spot instrumentId in allMarketTickers (perp ids are the perpMeta index, below it). */
export const TXFLOW_SPOT_ID_BASE = 10_000;

/**
 * 24 h USD notional volume per perp coin id from allMarketTickers. "" (no trades) → null, never
 * "0"; a non-list answer or a row without a numeric instrumentId is EXCHANGE_ERROR.
 */
export async function fetchTxflowDayVolumes(client: TxflowClient): Promise<Map<number, string | null>> {
  const res = await client.info<unknown>({ type: "allMarketTickers" });
  if (!Array.isArray(res)) throw txflowShapeError("allMarketTickers is not an array");
  const out = new Map<number, string | null>();
  for (const r of res) {
    const x = r as { instrumentId?: unknown; dayNtlVlm?: unknown };
    if (typeof x.instrumentId !== "number" || !Number.isInteger(x.instrumentId)) throw txflowShapeError("allMarketTickers row without a numeric instrumentId");
    if (x.instrumentId >= TXFLOW_SPOT_ID_BASE) continue;
    out.set(x.instrumentId, decOrNull(x.dayNtlVlm));
  }
  return out;
}

export function toTxflowVenueMarket(m: TxflowMarketMeta, ctx: TxflowCtx, volume24h: string | null): VenueMarket {
  return {
    venue: "txflow",
    venueSymbol: String(m.index),
    symbol: m.symbol,
    canonical: m.canonical,
    assetClass: m.assetClass,
    settle: "USDC",
    quoteAsset: m.quote,
    markPrice: ctx.markPx,
    indexPrice: ctx.oraclePx,
    fundingRate: hourlyFundingOf(ctx),
    fundingRateBasis: TXFLOW_FUNDING_BASIS,
    settlementIntervalHours: 1,
    // Base units (as Hyperliquid publishes it) [inferred].
    openInterest: ctx.openInterest,
    volume24h,
    tickSize: m.tickSize,
    stepSize: m.stepSize,
    minSize: null,
    minNotional: null,
    maxLeverage: m.maxLeverage,
    marginTiers: null,
    session: null,
    tradable: !m.halted,
  };
}

export interface TxflowPublicDeps {
  wsFactory: WsFactory;
  warn: (msg: string) => void;
}

const DEFAULT_DEPS: TxflowPublicDeps = {
  wsFactory: defaultWsFactory,
  warn: msg => process.stderr.write(`${msg}\n`),
};

function clientFor(net: Network): { client: TxflowClient; wsUrl: string } {
  const cfg = networkConfig(txflowVenue, net); // testnet → NOT_IMPLEMENTED (no testnet)
  if (cfg.wsUrl === null) throw new Error("txflow venue definition has no wsUrl");
  return { client: new TxflowClient(cfg.restUrl, txflowVenue.rateLimit), wsUrl: cfg.wsUrl };
}

/** Directory + one snapshot, joined; markets missing from the snapshot are dropped with a warning. */
async function fetchJoined(net: Network, deps: TxflowPublicDeps): Promise<Array<{ meta: TxflowMarketMeta; ctx: TxflowCtx }>> {
  const { client, wsUrl } = clientFor(net);
  const [dir, ctxs] = await Promise.all([fetchTxflowDirectory(client), fetchAllAssetCtxsOnce(wsUrl, deps.wsFactory)]);
  const joined = joinSnapshot(dir, ctxs, deps.warn);
  const out: Array<{ meta: TxflowMarketMeta; ctx: TxflowCtx }> = [];
  const missing: string[] = [];
  for (const meta of dir) {
    const ctx = joined.get(meta.index);
    if (ctx === undefined) { missing.push(meta.symbol); continue; }
    out.push({ meta, ctx });
  }
  if (missing.length > 0) deps.warn(`[txflow] ${missing.length} listed market(s) had no snapshot entry and are not shown: ${missing.join(", ")}`);
  return out;
}

export async function fetchTxflowMarkets(net: Network, deps: TxflowPublicDeps = DEFAULT_DEPS): Promise<VenueMarket[]> {
  const { client } = clientFor(net); // testnet → NOT_IMPLEMENTED before any request
  const [joined, volumes] = await Promise.all([fetchJoined(net, deps), fetchTxflowDayVolumes(client)]);
  // A market absent from allMarketTickers has no published volume → null.
  return joined.map(({ meta, ctx }) => toTxflowVenueMarket(meta, ctx, volumes.has(meta.index) ? volumes.get(meta.index) as string | null : null));
}

export async function fetchTxflowFundingRates(net: Network, deps: TxflowPublicDeps = DEFAULT_DEPS): Promise<VenueFundingRate[]> {
  const out: VenueFundingRate[] = [];
  for (const { meta, ctx } of await fetchJoined(net, deps)) {
    const rate = hourlyFundingOf(ctx);
    if (rate === null) continue;
    out.push({
      venue: "txflow",
      venueSymbol: String(meta.index),
      symbol: meta.symbol,
      canonical: meta.canonical,
      rate,
      basis: TXFLOW_FUNDING_BASIS,
      markPrice: ctx.markPx,
      nextFundingTime: ctx.nextFundingTime,
    });
  }
  return out;
}

export const txflowPublicData: VenuePublicData = {
  fetchMarkets: net => fetchTxflowMarkets(net),
  fetchFundingRates: net => fetchTxflowFundingRates(net),
};

/** Resolve a CLI symbol ("btc", "BTC-USDC", "BTC-PERP", or the numeric coin id) against the directory. */
export function resolveTxflowMarket(dir: readonly TxflowMarketMeta[], input: string): TxflowMarketMeta {
  const up = input.trim().toUpperCase().replace(/-PERP$/, "");
  const hit = dir.find(m => m.symbol === up || m.name.toUpperCase() === up || String(m.index) === up);
  if (hit === undefined) {
    throw new PerpError("SYMBOL_NOT_FOUND", `TxFlow has no listed market ${input}`, {
      exchange: "txflow", remediation: "List markets: perp -e txflow market list",
    });
  }
  return hit;
}
