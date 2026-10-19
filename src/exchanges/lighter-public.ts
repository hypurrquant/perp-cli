/**
 * Lighter-family public market data (`lighter`, `lighter-rh`).
 *
 * Sources (REST base from venues/lighter-family.ts, per venue + network):
 *   GET /api/v1/orderBookDetails  → perps in `order_book_details` (decimals, min
 *       amounts, status, mark/index price, IMF, OI, volume). It carries every
 *       field /orderBooks has, so /orderBooks is not fetched (one fewer call
 *       under the 60 req/min standard limit).
 *   GET /api/v1/funding-rates     → MULTI-EXCHANGE aggregate (binance/bybit/
 *       hyperliquid/lighter). Only rows with exchange === "lighter" are the
 *       venue's own; the RH host labels its own rows "lighter" too (live
 *       2026-09-30: 57 "lighter" rows = RH's 57 perps, matched by market_id).
 *
 * FUNDING: basis 8h per quoted rate, hourly settlement (Lighter
 * and Lighter RH identical).
 *
 * ASSET CLASS: the API has no asset-class field (the undocumented
 * `strategy_index` groups markets on Lighter main but is 0 for every RH market),
 * so classification is an explicit per-venue table built from live listings on
 * 2026-09-30:
 *   - lighter-rh: every listed perp is in RH_CLASS. An unlisted symbol is
 *     excluded with a warning until it is classified (RH lists mostly equities,
 *     so no class can be assumed).
 *   - lighter: crypto-centric venue. LIGHTER_NON_CRYPTO lists every non-crypto
 *     perp; any other symbol is crypto by this venue's definition.
 *     LIGHTER_AMBIGUOUS tickers are excluded with a warning so they cannot
 *     produce a false cross-venue match.
 *
 * OPEN INTEREST: `open_interest` in base units (same value legacy getMarkets reports).
 */

import { PerpError } from "../errors.js";
import { venueRateField } from "../utils/numeric.js";
import { acquireRate, rateLimitedError } from "./rate-limiter.js";
import { canonicalFor } from "./canonical-symbols.js";
import { isLighterMarketLive } from "../ws/lighter-market.js";
import { addDecimal } from "./precision.js";
import type { AssetClass, FundingRateBasis, Network, VenueFundingRate, VenueMarket } from "./venue-types.js";
import type { VenuePublicData } from "./venue.js";
import { lighterFamilyNetworks, lighterFamilyRateLimit } from "./venues/lighter-family.js";
import type { LighterVenueId } from "./venues/lighter-family.js";

const BASIS_8H: FundingRateBasis = { kind: "perHours", hours: 8 };
const SETTLEMENT_INTERVAL_HOURS = 1;

// ── Classification tables (live listings 2026-09-30) ──

const RH_CLASS: Readonly<Record<string, AssetClass>> = {
  // crypto
  BTC: "crypto", ETH: "crypto", SOL: "crypto", HYPE: "crypto", ZEC: "crypto", LIT: "crypto",
  VVV: "crypto", SUI: "crypto", NEAR: "crypto", XRP: "crypto", CASHCAT: "crypto", PONS: "crypto",
  // commodity (canonical via EXPLICIT_CANONICAL: XAU → GOLD, XAG → SILVER)
  XAU: "commodity", XAG: "commodity",
  // etf
  SPY: "etf", QQQ: "etf", SOXL: "etf", SLV: "etf", USO: "etf", SGOV: "etf",
  // equity
  AAPL: "equity", AMZN: "equity", GOOGL: "equity", META: "equity", MSFT: "equity", NVDA: "equity",
  TSLA: "equity", AMD: "equity", INTC: "equity", MU: "equity", TSM: "equity", ORCL: "equity",
  PLTR: "equity", COIN: "equity", CRCL: "equity", CRWV: "equity", BABA: "equity", SNDK: "equity",
  SMCI: "equity", SOFI: "equity", AMC: "equity", RGTI: "equity", QBTS: "equity", CLSK: "equity",
  IREN: "equity", WULF: "equity", LUNR: "equity", ASTS: "equity", BE: "equity", USAR: "equity",
  SPCX: "equity", SKHY: "equity",
  // pre-IPO / private (explicit-only canonical → null unless mapped)
  OPENAI: "preIpo", ANTHROPIC: "preIpo", SHEIN: "preIpo", ANSEM: "preIpo", AI: "preIpo",
};

const LIGHTER_NON_CRYPTO: Readonly<Record<string, AssetClass>> = {
  // commodity
  XAU: "commodity", XAG: "commodity", XPD: "commodity", XPT: "commodity", XCU: "commodity",
  WTI: "commodity", BRENTOIL: "commodity", NATGAS: "commodity", WHEAT: "commodity", URA: "commodity",
  H100: "commodity",
  // fx
  EURUSD: "fx", GBPUSD: "fx", AUDUSD: "fx", NZDUSD: "fx", USDJPY: "fx", USDCAD: "fx",
  USDCHF: "fx", USDHKD: "fx", USDKRW: "fx",
  // index
  US500: "index", US100: "index", US10Y: "index", KRCOMP: "index",
  // etf
  SPY: "etf", QQQ: "etf", IWM: "etf", DIA: "etf", SOXL: "etf", SOXS: "etf", SOXX: "etf",
  BOTZ: "etf", MAGS: "etf", EWY: "etf", KORU: "etf",
  // equity (US)
  AAPL: "equity", AMZN: "equity", GOOGL: "equity", META: "equity", MSFT: "equity", NVDA: "equity",
  TSLA: "equity", AMD: "equity", INTC: "equity", MU: "equity", TSM: "equity", ORCL: "equity",
  PLTR: "equity", COIN: "equity", CRCL: "equity", CRWV: "equity", BABA: "equity", SNDK: "equity",
  MSTR: "equity", ARM: "equity", NBIS: "equity", BMNR: "equity", CBRS: "equity", AVGO: "equity",
  IBM: "equity", GEV: "equity", MRVL: "equity", HOOD: "equity", LITE: "equity", QCOM: "equity",
  BE: "equity", AAOI: "equity", AXTI: "equity", GME: "equity", NOK: "equity", TTWO: "equity",
  RKLB: "equity", MRNA: "equity", DELL: "equity", NOW: "equity", ASML: "equity", STRC: "equity",
  SPCX: "equity", DRAM: "equity", WDC: "equity",
  // equity (Asia)
  SAMSUNG: "equity", SAMSUNGUSD: "equity", HYUNDAI: "equity", HYUNDAIUSD: "equity", HANMI: "equity",
  SKHYNIX: "equity", SKHYNIXUSD: "equity", SKHY: "equity", BYD: "equity", TENCENT: "equity",
  POPMART: "equity", KIOXIA: "equity", SMIC: "equity", XIAOMI: "equity",
  // pre-IPO / private / unclear listing status (explicit-only canonical)
  OPENAI: "preIpo", ANTHROPIC: "preIpo", SPACEX: "preIpo", SHEIN: "preIpo", CXMT: "preIpo",
  ZHIPU: "preIpo", UNITREE: "preIpo", MINIMAX: "preIpo", AI: "preIpo", ANSEM: "preIpo",
  STABLECOINX: "preIpo", OURA: "preIpo", PRL: "preIpo", ADI: "preIpo",
};

/**
 * Excluded from cross-venue data until mapped explicitly:
 * - BB, BOT, WEN, QNT: Lighter groups them with US equities, but each is also a live crypto ticker elsewhere.
 * - SPX: the SPX6900 token on Lighter; its ticker equals the canonical key of the S&P 500 index ("SPX").
 */
const LIGHTER_AMBIGUOUS: ReadonlySet<string> = new Set(["BB", "BOT", "WEN", "QNT", "SPX"]);

/** Asset class for a venue symbol, or null when it must be excluded (unclassified / ambiguous). */
function classify(venue: LighterVenueId, symbol: string): AssetClass | null {
  const up = symbol.toUpperCase();
  switch (venue) {
    case "lighter-rh":
      return RH_CLASS[up] ?? null;
    case "lighter":
      if (LIGHTER_AMBIGUOUS.has(up)) return null;
      return LIGHTER_NON_CRYPTO[up] ?? "crypto"; // crypto-centric venue: non-crypto is listed explicitly
  }
}

function warnExcluded(venue: LighterVenueId, what: string, symbols: string[]): void {
  if (symbols.length > 0) {
    console.warn(`[${venue}] excluded ${symbols.length} ${what}: ${symbols.join(", ")}`);
  }
}

// ── HTTP ──

/**
 * The venue's firewall answering instead of the API: HTTP 405 / 403 with a non-JSON (HTML
 * "Human Verification") body → typed RATE_LIMITED, never the HTML in the message; null for any
 * other response. Live 2026-10-05: after a burst Lighter mainnet answers EVERY request (public
 * GET /orderBooks included) this way for 1–2 minutes. Docs (apidocs.lighter.xyz/docs/rate-limits):
 * a breached limit answers "HTTP 429, or HTTP 405"; cooldown "Firewall: 60 seconds, static".
 * The API's own answers are JSON, so a JSON 405 / 403 is not a challenge.
 */
export function lighterWafChallenge(venue: string, status: number, body: string): PerpError | null {
  if (status !== 405 && status !== 403) return null;
  try { JSON.parse(body); return null; } catch { /* not JSON: the firewall's page */ }
  return new PerpError("RATE_LIMITED", `${venue}: blocked by the venue's WAF challenge (HTTP ${status} Human Verification) — wait 1–2 minutes`, {
    exchange: venue, retryAfterMs: 60_000,
    remediation: `Wait 1–2 minutes before the next ${venue} request, then retry at a lower request rate (standard accounts: 60 requests per rolling minute)`,
  });
}

/** `limit` of GET /api/v1/orderBookOrders: the documented maximum (apidocs.lighter.xyz/reference/orderbookorders, 1..250). */
export const LIGHTER_BOOK_ORDERS_LIMIT = 250;

/**
 * One side of GET /api/v1/orderBookOrders (individual resting ORDERS, best price first) → price
 * levels: `remaining_base_amount` summed per price, in the venue's order — the shape of the WS
 * `order_book/{id}` channel (levels). A side of exactly `limit` orders may have more orders at its
 * last price beyond the page, so that (possibly partial) level is dropped. A row without a price /
 * remaining amount is a payload error (never skipped, never "0").
 */
export function lighterBookLevels(venue: string, rows: unknown, what: string, limit = LIGHTER_BOOK_ORDERS_LIMIT): [string, string][] {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) throw new PerpError("EXCHANGE_ERROR", `${venue} orderBookOrders ${what}: side is not a list`, { exchange: venue });
  const levels = new Map<string, string>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const price = r?.price;
    const size = r?.remaining_base_amount ?? r?.size;
    if (typeof price !== "string" || typeof size !== "string" || !Number.isFinite(Number(price)) || !Number.isFinite(Number(size))) {
      throw new PerpError("EXCHANGE_ERROR", `${venue} orderBookOrders ${what}: order without price / remaining size: ${JSON.stringify(r).slice(0, 160)}`, { exchange: venue });
    }
    const prev = levels.get(price);
    levels.set(price, prev === undefined ? size : addDecimal(prev, size));
  }
  const out = Array.from(levels);
  if (rows.length >= limit && out.length > 1) out.pop();
  return out;
}

async function getJson(venue: LighterVenueId, net: Network, path: string, endpoint: string): Promise<unknown> {
  await acquireRate(`${venue}:${net}`, lighterFamilyRateLimit(venue), endpoint);
  const base = lighterFamilyNetworks(venue)[net].restUrl;
  const res = await fetch(`${base}/api/v1${path}`, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (res.status === 429) throw rateLimitedError(venue, res.headers.get("retry-after"), text);
  const waf = lighterWafChallenge(venue, res.status, text);
  if (waf !== null) throw waf;
  if (!res.ok) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} GET ${path} HTTP ${res.status}`, { body: text.slice(0, 500) });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PerpError("EXCHANGE_ERROR", `${venue} GET ${path}: invalid JSON`, { body: text.slice(0, 500) });
  }
}

interface RawDetail {
  symbol: string;
  market_id: number;
  market_type: string;
  status: string;
  is_frozen?: boolean;
  price_decimals: number;
  size_decimals: number;
  min_base_amount: string;
  min_quote_amount: string;
  min_initial_margin_fraction: number;
  mark_price: string;
  index_price?: string;
  open_interest?: number;
  daily_quote_token_volume?: number;
}

interface RawFunding {
  market_id: number;
  exchange: string;
  symbol: string;
  rate: number;
}

function isNumStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && Number.isFinite(Number(v));
}

function validDetail(d: RawDetail): boolean {
  return typeof d.symbol === "string" && Number.isInteger(d.market_id)
    && Number.isInteger(d.price_decimals) && d.price_decimals >= 0
    && Number.isInteger(d.size_decimals) && d.size_decimals >= 0
    && isNumStr(d.min_base_amount) && isNumStr(d.min_quote_amount)
    && typeof d.min_initial_margin_fraction === "number" && d.min_initial_margin_fraction > 0
    && isNumStr(d.mark_price) && typeof d.status === "string";
}

async function fetchPerpDetails(venue: LighterVenueId, net: Network): Promise<RawDetail[]> {
  const json = await getJson(venue, net, "/orderBookDetails", "orderBookDetails");
  const list = (json as { order_book_details?: unknown }).order_book_details;
  if (!Array.isArray(list)) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} orderBookDetails: missing order_book_details array`);
  }
  const out: RawDetail[] = [];
  const malformed: string[] = [];
  for (const d of list as RawDetail[]) {
    if (d.market_type !== "perp") continue;
    if (!validDetail(d)) { malformed.push(String(d.symbol)); continue; }
    out.push(d);
  }
  warnExcluded(venue, "malformed market(s)", malformed);
  return out;
}

/** The venue's own funding rows, keyed by market_id. */
async function fetchOwnFunding(venue: LighterVenueId, net: Network): Promise<Map<number, RawFunding>> {
  const json = await getJson(venue, net, "/funding-rates", "funding-rates");
  const list = (json as { funding_rates?: unknown }).funding_rates;
  if (!Array.isArray(list)) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} funding-rates: missing funding_rates array`);
  }
  const map = new Map<number, RawFunding>();
  for (const r of list as RawFunding[]) {
    if (r.exchange !== "lighter") continue; // other exchanges' rates in the aggregate
    if (!Number.isInteger(r.market_id) || typeof r.symbol !== "string" || typeof r.rate !== "number" || !Number.isFinite(r.rate)) {
      throw new PerpError("EXCHANGE_ERROR", `${venue} funding-rates: malformed own row ${JSON.stringify(r).slice(0, 200)}`);
    }
    map.set(r.market_id, r);
  }
  return map;
}

function stepFromDecimals(d: number): string {
  return d === 0 ? "1" : `0.${"0".repeat(d - 1)}1`;
}

function toMarket(venue: LighterVenueId, net: Network, d: RawDetail, assetClass: AssetClass, fr: RawFunding | undefined): VenueMarket {
  const settle = lighterFamilyNetworks(venue)[net].collateral[0];
  if (!settle) throw new PerpError("INVALID_PARAMS", `${venue} ${net} network config has no collateral`);
  return {
    venue,
    venueSymbol: String(d.market_id),
    symbol: d.symbol,
    canonical: canonicalFor(venue, d.symbol, assetClass),
    assetClass,
    settle,
    quoteAsset: null,
    markPrice: d.mark_price,
    indexPrice: isNumStr(d.index_price) ? d.index_price : null,
    fundingRate: fr ? venueRateField(fr.rate, "funding-rates rate", venue) : null,
    fundingRateBasis: BASIS_8H,
    settlementIntervalHours: SETTLEMENT_INTERVAL_HOURS,
    openInterest: typeof d.open_interest === "number" ? String(d.open_interest) : null,
    volume24h: typeof d.daily_quote_token_volume === "number" ? String(d.daily_quote_token_volume) : null,
    tickSize: stepFromDecimals(d.price_decimals),
    stepSize: stepFromDecimals(d.size_decimals),
    minSize: d.min_base_amount,
    minNotional: d.min_quote_amount,
    maxLeverage: Math.floor(10000 / d.min_initial_margin_fraction),
    marginTiers: null,
    session: null, // RH: 24/7, no session info published
    tradable: isLighterMarketLive(d),
  };
}

export function lighterPublicData(venue: LighterVenueId): VenuePublicData {
  return {
    async fetchMarkets(net) {
      const [details, funding] = await Promise.all([fetchPerpDetails(venue, net), fetchOwnFunding(venue, net)]);
      const out: VenueMarket[] = [];
      const unclassified: string[] = [];
      for (const d of details) {
        // Live markets only (the rule of market list / the WS directory); inactive ones are not listed.
        if (!isLighterMarketLive(d)) continue;
        const cls = classify(venue, d.symbol);
        if (cls === null) { unclassified.push(d.symbol); continue; }
        out.push(toMarket(venue, net, d, cls, funding.get(d.market_id)));
      }
      warnExcluded(venue, "unclassified/ambiguous market(s)", unclassified);
      return out;
    },

    async fetchFundingRates(net) {
      const funding = await fetchOwnFunding(venue, net);
      const out: VenueFundingRate[] = [];
      const unclassified: string[] = [];
      for (const r of funding.values()) {
        const cls = classify(venue, r.symbol);
        if (cls === null) { unclassified.push(r.symbol); continue; }
        out.push({
          venue,
          venueSymbol: String(r.market_id),
          symbol: r.symbol,
          canonical: canonicalFor(venue, r.symbol, cls),
          rate: venueRateField(r.rate, "funding-rates rate", venue),
          basis: BASIS_8H,
          markPrice: null, // /funding-rates carries no mark price
          nextFundingTime: null, // not published
        });
      }
      warnExcluded(venue, "unclassified/ambiguous market(s)", unclassified);
      return out;
    },
  };
}
