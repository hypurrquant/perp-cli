/**
 * Public market data for the legacy venues without a native `getVenueMarkets`
 * (pacifica, hyperliquid core, aster). Lighter uses
 * exchanges/lighter-public.ts.
 *
 * Network-aware: the REST base comes from `legacyPublicBaseUrl(venue, net)`,
 * never from the mutable `*_API_URL` globals. A network without a known public
 * API throws NOT_IMPLEMENTED.
 *
 * FUNDING BASIS / SETTLEMENT
 *   pacifica, hyperliquid: the venue definition (fundingBasisOf / settlementIntervalOf).
 *   aster: per symbol from GET /fapi/v3/fundingInfo `fundingIntervalHours`
 *     (live 2026-09-30: 1h/2h/4h/8h mixed). One quoted rate covers one interval,
 *     so basis hours == settlement hours. A symbol missing from fundingInfo is
 *     excluded with a warning (its period would be a guess).
 *
 * ASSET CLASS
 *   hyperliquid core: crypto (HIP-3 dexes are not served here).
 *   pacifica: crypto-centric; PACIFICA_NON_CRYPTO lists every non-crypto perp
 *     listed on 2026-09-30.
 *   aster: exchangeInfo `underlyingSubType` (STOCK / ETF / Commodities / pre-launch).
 *   AMBIGUOUS tickers are excluded with a warning so they cannot produce a false
 *   cross-venue match (SPX = the SPX6900 token, whose ticker equals the S&P 500
 *   canonical key).
 *
 * Fields a venue does not publish on this path are null (HL has no fixed tick
 * size; Aster leverage brackets need a signed call; Aster OI is per-symbol only).
 */

import { HL_MIN_ORDER_VALUE_USD } from "../constants.js";
import { isPacificaPerpetual } from "../ws/pacifica-instrument.js";
import { isAsterListedPerpetual } from "../ws/aster-market.js";
import { PerpError } from "../errors.js";
import { venueRateString } from "../utils/numeric.js";
import { assertOk } from "../api/public/_http.js";
import { legacyPublicBaseUrl } from "../api/public/urls.js";
import { canonicalFor } from "../exchanges/canonical-symbols.js";
import { fundingBasisOf, settlementIntervalOf } from "../exchanges/venue.js";
import type { VenuePublicData } from "../exchanges/venue.js";
import type { AssetClass, Network, VenueFundingRate, VenueMarket } from "../exchanges/venue-types.js";

export type LegacyPublicVenue = "pacifica" | "hyperliquid" | "aster";

interface Row {
  market: VenueMarket;
  nextFundingTime: number | null;
}

// ── Classification ──

const AMBIGUOUS: ReadonlySet<string> = new Set(["SPX"]);

/** Pacifica non-crypto perps (live /info 2026-09-30). BP / CHIP: ticker collides with a listed equity/ETF. */
const PACIFICA_NON_CRYPTO: Readonly<Record<string, AssetClass>> = {
  NVDA: "equity", TSLA: "equity", GOOGL: "equity", PLTR: "equity", HOOD: "equity", CRCL: "equity",
  SPCX: "equity", SKHYNIX: "equity", SAMSUNG: "equity", MSTR: "equity", MU: "equity", SNDK: "equity",
  META: "equity",
  DRAM: "etf", URNM: "etf",
  XAU: "commodity", XAG: "commodity", CL: "commodity", COPPER: "commodity", NATGAS: "commodity",
  PLATINUM: "commodity",
  USDJPY: "fx", EURUSD: "fx",
  SP500: "index",
};
const PACIFICA_AMBIGUOUS: ReadonlySet<string> = new Set(["BP", "CHIP"]);

function classifyPacifica(symbol: string): AssetClass | null {
  const up = symbol.toUpperCase();
  if (AMBIGUOUS.has(up) || PACIFICA_AMBIGUOUS.has(up)) return null;
  return PACIFICA_NON_CRYPTO[up] ?? "crypto"; // crypto-centric venue: non-crypto is listed explicitly
}

function classifyHyperliquid(symbol: string): AssetClass | null {
  return AMBIGUOUS.has(symbol.toUpperCase()) ? null : "crypto";
}

function classifyAster(symbol: string, subTypes: readonly string[]): AssetClass | null {
  if (AMBIGUOUS.has(symbol.toUpperCase())) return null;
  if (subTypes.includes("pre-launch")) return "preIpo";
  if (subTypes.includes("ETF")) return "etf";
  if (subTypes.includes("STOCK")) return "equity";
  if (subTypes.includes("Commodities")) return "commodity";
  return "crypto";
}

function warnExcluded(venue: LegacyPublicVenue, what: string, symbols: string[]): void {
  if (symbols.length > 0) {
    console.warn(`[${venue}] excluded ${symbols.length} ${what}: ${symbols.join(", ")}`);
  }
}

// ── HTTP ──

async function getJson(venue: LegacyPublicVenue, url: string, label: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  await assertOk(res, `${venue} ${label}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new PerpError("EXCHANGE_ERROR", `${venue} ${label}: invalid JSON`, { body: text.slice(0, 500) });
  }
}

function arrayField(venue: LegacyPublicVenue, label: string, v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) throw new PerpError("EXCHANGE_ERROR", `${venue} ${label}: expected an array`);
  return v as Record<string, unknown>[];
}

function numStr(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return v;
  return null;
}

/** A funding rate field: a JSON number without float noise (venueRateString), a numeric string verbatim; else null. */
function rateStr(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return venueRateString(v);
  return numStr(v);
}

function positiveNumStr(v: unknown): string | null {
  const s = numStr(v);
  return s !== null && Number(s) > 0 ? s : null;
}

function stepFromDecimals(d: number): string {
  return d === 0 ? "1" : `0.${"0".repeat(d - 1)}1`;
}

// ── Pacifica ──

async function pacificaRows(net: Network): Promise<Row[]> {
  const base = legacyPublicBaseUrl("pacifica", net);
  const [infoJson, pricesJson] = await Promise.all([
    getJson("pacifica", `${base}/info`, "info"),
    getJson("pacifica", `${base}/info/prices`, "info/prices"),
  ]);
  const info = arrayField("pacifica", "info", (infoJson as { data?: unknown }).data);
  const prices = arrayField("pacifica", "info/prices", (pricesJson as { data?: unknown }).data);
  const priceBySymbol = new Map(prices.map(p => [String(p.symbol), p]));
  const basis = fundingBasisOf("pacifica");
  const settlement = settlementIntervalOf("pacifica");

  const out: Row[] = [];
  const unclassified: string[] = [];
  const unpriced: string[] = [];
  for (const m of info) {
    // /info lists spot markets too (e.g. SOL-USDC): perps only. A row without the field cannot be classified.
    if (typeof m.instrument_type !== "string") {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica /info row ${String(m.symbol)} has no instrument_type`, { exchange: "pacifica" });
    }
    if (!isPacificaPerpetual(m)) continue;
    const symbol = String(m.symbol ?? "");
    const assetClass = classifyPacifica(symbol);
    if (assetClass === null) { unclassified.push(symbol); continue; }
    const p = priceBySymbol.get(symbol);
    const mark = p ? positiveNumStr(p.mark) : null;
    if (!p || mark === null) { unpriced.push(symbol); continue; }
    const maxLeverage = Number(m.max_leverage);
    out.push({
      market: {
        venue: "pacifica",
        venueSymbol: symbol,
        symbol,
        canonical: canonicalFor("pacifica", symbol, assetClass),
        assetClass,
        settle: "USDC",
        quoteAsset: null,
        markPrice: mark,
        indexPrice: positiveNumStr(p.oracle),
        fundingRate: rateStr(p.next_funding),
        fundingRateBasis: basis,
        settlementIntervalHours: settlement,
        openInterest: numStr(p.open_interest),
        volume24h: numStr(p.volume_24h),
        tickSize: positiveNumStr(m.tick_size),
        stepSize: positiveNumStr(m.lot_size),
        minSize: null,
        minNotional: positiveNumStr(m.min_order_size),
        maxLeverage: Number.isFinite(maxLeverage) && maxLeverage > 0 ? maxLeverage : null,
        marginTiers: null,
        session: null,
        tradable: true,
      },
      nextFundingTime: null, // Pacifica publishes no next-funding timestamp
    });
  }
  warnExcluded("pacifica", "unclassified/ambiguous market(s)", unclassified);
  warnExcluded("pacifica", "market(s) without a mark price", unpriced);
  return out;
}

// ── Hyperliquid core ──

async function hyperliquidRows(net: Network): Promise<Row[]> {
  const base = legacyPublicBaseUrl("hyperliquid", net);
  const json = await getJson("hyperliquid", `${base}/info`, "info metaAndAssetCtxs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!Array.isArray(json) || json.length < 2) {
    throw new PerpError("EXCHANGE_ERROR", "hyperliquid metaAndAssetCtxs: expected [meta, assetCtxs]");
  }
  const universe = arrayField("hyperliquid", "meta.universe", (json[0] as { universe?: unknown }).universe);
  const ctxs = arrayField("hyperliquid", "assetCtxs", json[1]);
  if (ctxs.length !== universe.length) {
    throw new PerpError("EXCHANGE_ERROR", `hyperliquid metaAndAssetCtxs: ${universe.length} assets vs ${ctxs.length} contexts`);
  }
  const basis = fundingBasisOf("hyperliquid");
  const settlement = settlementIntervalOf("hyperliquid");

  const out: Row[] = [];
  const unclassified: string[] = [];
  const unpriced: string[] = [];
  universe.forEach((a, i) => {
    // Delisted assets stay in meta (isDelisted: true) with zeroed funding / volume / OI
    // (live 2026-10-14: 56 of 234) — not a market: excluded from listings, prices and scans.
    if (a.isDelisted === true) return;
    const ctx = ctxs[i];
    const symbol = String(a.name ?? "");
    const assetClass = classifyHyperliquid(symbol);
    if (assetClass === null) { unclassified.push(symbol); return; }
    const mark = positiveNumStr(ctx.markPx);
    if (mark === null) { unpriced.push(symbol); return; }
    const szDecimals = Number(a.szDecimals);
    const maxLeverage = Number(a.maxLeverage);
    out.push({
      market: {
        venue: "hyperliquid",
        venueSymbol: symbol,
        symbol,
        canonical: canonicalFor("hyperliquid", symbol, assetClass),
        assetClass,
        settle: "USDC",
        quoteAsset: null,
        markPrice: mark,
        indexPrice: positiveNumStr(ctx.oraclePx),
        fundingRate: rateStr(ctx.funding),
        fundingRateBasis: basis,
        settlementIntervalHours: settlement,
        openInterest: numStr(ctx.openInterest),
        volume24h: numStr(ctx.dayNtlVlm),
        tickSize: null, // HL prices use a significant-figure rule, not a fixed tick
        stepSize: Number.isInteger(szDecimals) && szDecimals >= 0 ? stepFromDecimals(szDecimals) : null,
        minSize: null,
        minNotional: HL_MIN_ORDER_VALUE_USD,
        maxLeverage: Number.isFinite(maxLeverage) && maxLeverage > 0 ? maxLeverage : null,
        marginTiers: null,
        session: null,
        tradable: true, // delisted assets are skipped above
      },
      nextFundingTime: null, // not published in metaAndAssetCtxs
    });
  });
  warnExcluded("hyperliquid", "unclassified/ambiguous market(s)", unclassified);
  warnExcluded("hyperliquid", "market(s) without a mark price", unpriced);
  return out;
}

// ── Aster ──

function asterFilter(filters: unknown, type: string, field: string): string | null {
  if (!Array.isArray(filters)) return null;
  const f = (filters as Record<string, unknown>[]).find(x => x.filterType === type);
  return f ? positiveNumStr(f[field]) : null;
}

async function asterRows(net: Network): Promise<Row[]> {
  const base = legacyPublicBaseUrl("aster", net);
  const [infoJson, premiumJson, tickerJson, fundingInfoJson] = await Promise.all([
    getJson("aster", `${base}/fapi/v1/exchangeInfo`, "exchangeInfo"),
    getJson("aster", `${base}/fapi/v1/premiumIndex`, "premiumIndex"),
    getJson("aster", `${base}/fapi/v1/ticker/24hr`, "ticker/24hr"),
    getJson("aster", `${base}/fapi/v3/fundingInfo`, "fundingInfo"),
  ]);
  const symbols = arrayField("aster", "exchangeInfo.symbols", (infoJson as { symbols?: unknown }).symbols);
  const premiumBySymbol = new Map(arrayField("aster", "premiumIndex", premiumJson).map(p => [String(p.symbol), p]));
  const tickerBySymbol = new Map(arrayField("aster", "ticker/24hr", tickerJson).map(t => [String(t.symbol), t]));
  const intervalBySymbol = new Map<string, number>();
  for (const f of arrayField("aster", "fundingInfo", fundingInfoJson)) {
    const h = Number(f.fundingIntervalHours);
    if (Number.isFinite(h) && h > 0) intervalBySymbol.set(String(f.symbol), h);
  }

  const out: Row[] = [];
  const unclassified: string[] = [];
  const unpriced: string[] = [];
  const noInterval: string[] = [];
  for (const s of symbols) {
    // Shared eligibility (SETTLING / PENDING_TRADING rows were listed with tradable false).
    if (!isAsterListedPerpetual(s) || s.quoteAsset !== "USDT") continue;
    const venueSymbol = String(s.symbol);
    const symbol = String(s.baseAsset);
    const subTypes = Array.isArray(s.underlyingSubType) ? (s.underlyingSubType as unknown[]).map(String) : [];
    const assetClass = classifyAster(symbol, subTypes);
    if (assetClass === null) { unclassified.push(venueSymbol); continue; }
    const p = premiumBySymbol.get(venueSymbol);
    const mark = p ? positiveNumStr(p.markPrice) : null;
    if (!p || mark === null) { unpriced.push(venueSymbol); continue; }
    const hours = intervalBySymbol.get(venueSymbol);
    if (hours === undefined) { noInterval.push(venueSymbol); continue; }
    if (typeof s.marginAsset !== "string" || s.marginAsset.length === 0) {
      throw new PerpError("EXCHANGE_ERROR", `aster exchangeInfo: ${venueSymbol} has no marginAsset`);
    }
    const next = Number(p.nextFundingTime);
    const t = tickerBySymbol.get(venueSymbol);
    out.push({
      market: {
        venue: "aster",
        venueSymbol,
        symbol,
        canonical: canonicalFor("aster", symbol, assetClass),
        assetClass,
        settle: s.marginAsset,
        quoteAsset: s.quoteAsset,
        markPrice: mark,
        indexPrice: positiveNumStr(p.indexPrice),
        fundingRate: rateStr(p.lastFundingRate),
        fundingRateBasis: { kind: "perHours", hours },
        settlementIntervalHours: hours,
        openInterest: null, // per-symbol endpoint only
        volume24h: t ? numStr(t.quoteVolume) : null,
        tickSize: asterFilter(s.filters, "PRICE_FILTER", "tickSize"),
        stepSize: asterFilter(s.filters, "LOT_SIZE", "stepSize"),
        minSize: asterFilter(s.filters, "LOT_SIZE", "minQty"),
        minNotional: asterFilter(s.filters, "MIN_NOTIONAL", "notional"),
        maxLeverage: null, // leverage brackets require a signed call
        marginTiers: null,
        session: null,
        tradable: s.status === "TRADING",
      },
      nextFundingTime: Number.isFinite(next) && next > 0 ? next : null,
    });
  }
  warnExcluded("aster", "unclassified/ambiguous market(s)", unclassified);
  warnExcluded("aster", "market(s) without a mark price", unpriced);
  warnExcluded("aster", "market(s) missing from fundingInfo", noInterval);
  return out;
}

// ── VenuePublicData ──

function rowsFor(venue: LegacyPublicVenue, net: Network): Promise<Row[]> {
  switch (venue) {
    case "pacifica": return pacificaRows(net);
    case "hyperliquid": return hyperliquidRows(net);
    case "aster": return asterRows(net);
  }
}

export function legacyPublicData(venue: LegacyPublicVenue): VenuePublicData {
  return {
    async fetchMarkets(net) {
      return (await rowsFor(venue, net)).map(r => r.market);
    },
    async fetchFundingRates(net) {
      const out: VenueFundingRate[] = [];
      for (const { market: m, nextFundingTime } of await rowsFor(venue, net)) {
        if (!m.tradable || m.fundingRate === null) continue;
        out.push({
          venue: m.venue,
          venueSymbol: m.venueSymbol,
          symbol: m.symbol,
          canonical: m.canonical,
          rate: m.fundingRate,
          basis: m.fundingRateBasis,
          markPrice: m.markPrice,
          nextFundingTime,
        });
      }
      return out;
    },
  };
}
