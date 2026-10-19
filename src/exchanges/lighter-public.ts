/**
 * Lighter-family public market data (`lighter`, `lighter-rh`).
 *
 * Sources (REST base from venues/lighter-family.ts, per venue + network):
 *   GET /api/v1/orderBookDetails  → perps in `order_book_details` (decimals, min
 *       amounts, status, mark/index price, IMF, OI, volume). It carries every
 *       field /orderBooks has, so /orderBooks is not fetched (one fewer call
 *       under the 60 req/min standard limit).
 *   WS market_stats/all (first frame) → per market `funding_rate` (LAST SETTLED, percent per
 *       1 h; = the newest GET /fundings print) and `current_funding_rate` (predicted). REST
 *       /funding-rates is the predicted rate × 8 and is not read here (fetchLighterFundingStats).
 *
 * FUNDING: market / funding rows carry the settled rate per 1 h (hourly settlement; Lighter and
 * Lighter RH identical).
 *
 * ASSET CLASS: the API has no asset-class field (the undocumented
 * `strategy_index` groups markets on Lighter main but is 0 for every RH market),
 * so classification is an explicit per-venue table built from live listings on
 * 2026-09-30:
 *   - lighter-rh: every listed perp is in RH_CLASS. An unlisted symbol is
 *     "unclassified" (listed, canonical null) until it is classified (RH lists
 *     mostly equities, so no class can be assumed).
 *   - lighter: crypto-centric venue. LIGHTER_NON_CRYPTO lists every non-crypto
 *     perp; any other symbol is crypto by this venue's definition.
 *     LIGHTER_AMBIGUOUS tickers are "unclassified" (listed, canonical null) so
 *     they cannot produce a false cross-venue match.
 *
 * OPEN INTEREST: `open_interest` in base units (same value legacy getMarkets reports).
 */

import { PerpError } from "../errors.js";
import { acquireRate, rateLimitedError } from "./rate-limiter.js";
import { canonicalFor } from "./canonical-symbols.js";
import { isLighterMarketLive } from "../ws/lighter-market.js";
import { addDecimal } from "./precision.js";
import { shiftDecimal } from "../ws/dec.js";
import type { AssetClass, FundingRateBasis, Network, VenueFundingRate, VenueMarket } from "./venue-types.js";
import type { VenuePublicData } from "./venue.js";
import { lighterFamilyNetworks, lighterFamilyRateLimit } from "./venues/lighter-family.js";
import type { LighterVenueId } from "./venues/lighter-family.js";

/** Market rows / funding rows carry the settled HOURLY rate (market_stats funding_rate): per 1 h. */
const BASIS_1H: FundingRateBasis = { kind: "perHours", hours: 1 };
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

/**
 * Asset class for a venue symbol; "unclassified" (canonical null — listed, never matched across
 * venues) when it is ambiguous or not mapped.
 */
function classify(venue: LighterVenueId, symbol: string): AssetClass {
  const up = symbol.toUpperCase();
  switch (venue) {
    case "lighter-rh":
      return RH_CLASS[up] ?? "unclassified";
    case "lighter":
      if (LIGHTER_AMBIGUOUS.has(up)) return "unclassified";
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

/**
 * A GET /orderBookOrders answer → price levels per side, cut to `depth`. A side whose page is full
 * (LIGHTER_BOOK_ORDERS_LIMIT orders, the endpoint max) but aggregates to fewer than `depth` levels
 * cannot be paged: INVALID_PARAMS naming the 250-order cap, never a silently shallower book.
 */
export function lighterBook(venue: string, res: { asks?: unknown; bids?: unknown }, what: string, depth?: number): { bids: [string, string][]; asks: [string, string][] } {
  const bids = lighterBookLevels(venue, res.bids, `${what} bids`);
  const asks = lighterBookLevels(venue, res.asks, `${what} asks`);
  if (depth === undefined) return { bids, asks };
  const full = (rows: unknown) => Array.isArray(rows) && rows.length >= LIGHTER_BOOK_ORDERS_LIMIT;
  for (const [side, rows, levels] of [["bids", res.bids, bids], ["asks", res.asks, asks]] as const) {
    if (full(rows) && levels.length < depth) {
      throw new PerpError("INVALID_PARAMS", `${venue} order book: ${what} ${side} — ${LIGHTER_BOOK_ORDERS_LIMIT} orders (the endpoint max, no paging) make only ${levels.length} price levels; --depth ${depth} cannot be served`, {
        exchange: venue, remediation: `Use --depth ${levels.length} or less`,
      });
    }
  }
  return { bids: bids.slice(0, depth), asks: asks.slice(0, depth) };
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

/** One market's funding from the WS `market_stats/all` snapshot, fractions per 1 h. */
export interface LighterFundingStat {
  /** Last settled hourly rate (market_stats funding_rate; = the newest GET /fundings print). */
  rate: string | null;
  /** Predicted rate of the running hour (market_stats current_funding_rate). */
  predictedRate: string | null;
}

/** market_stats rates are PERCENT per 1 h (codec notes): an exact 2-place decimal shift. */
function percentToFraction(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
  if (s === null || s === "") return null;
  const f = shiftDecimal(s, -2);
  return f === undefined ? null : f;
}

const STATS_TTL_MS = 10_000;
const STATS_TIMEOUT_MS = 10_000;
const statsCache = new Map<string, { at: number; value: Promise<Map<number, LighterFundingStat>> }>();

/**
 * Settled + predicted hourly funding of every market, keyed by market_id: the first frame of the
 * WS `market_stats/all` channel (the source of the perp-ws `rate` / `predictedRate`). REST has no
 * bulk settled source: /funding-rates is the PREDICTED rate × 8 (live 2026-10-19: ETH 0.0009 % /h
 * predicted → 0.000072; settled 0.0012 % /h), and /fundings is one market per request. One
 * snapshot per venue / network is shared for STATS_TTL_MS.
 */
export function fetchLighterFundingStats(venue: LighterVenueId, net: Network): Promise<Map<number, LighterFundingStat>> {
  const key = `${venue}:${net}`;
  const hit = statsCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < STATS_TTL_MS) return hit.value;
  const value = readFundingStats(venue, net);
  statsCache.set(key, { at: Date.now(), value });
  value.catch(() => statsCache.delete(key));
  return value;
}

async function readFundingStats(venue: LighterVenueId, net: Network): Promise<Map<number, LighterFundingStat>> {
  const url = lighterFamilyNetworks(venue)[net].wsUrl;
  if (url === null) {
    throw new PerpError("EXCHANGE_UNREACHABLE", `${venue} ${net} has no WebSocket endpoint: the settled funding rate (market_stats) cannot be read`, { exchange: venue });
  }
  const { default: WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const done = (err: unknown, value?: Map<number, LighterFundingStat>) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err !== null) reject(err); else resolve(value!);
    };
    const timer = setTimeout(() => done(new PerpError("EXCHANGE_UNREACHABLE", `${venue} market_stats: no snapshot within ${STATS_TIMEOUT_MS / 1000} s`, { exchange: venue })), STATS_TIMEOUT_MS);
    ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", channel: "market_stats/all" })));
    ws.on("error", (e: Error) => done(new PerpError("EXCHANGE_UNREACHABLE", `${venue} market_stats: ${e.message}`, { exchange: venue })));
    ws.on("message", (data: unknown) => {
      let f: Record<string, unknown>;
      try { f = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
      if (f.error !== undefined) {
        done(new PerpError("EXCHANGE_ERROR", `${venue} market_stats: ${JSON.stringify(f.error).slice(0, 200)}`, { exchange: venue }));
        return;
      }
      const stats = f.market_stats;
      if (stats === null || typeof stats !== "object") return; // a frame before the snapshot (connected)
      const out = new Map<number, LighterFundingStat>();
      for (const [id, r] of Object.entries(stats as Record<string, Record<string, unknown>>)) {
        if (r === null || typeof r !== "object") continue;
        out.set(Number(id), { rate: percentToFraction(r.funding_rate), predictedRate: percentToFraction(r.current_funding_rate) });
      }
      done(null, out);
    });
  });
}

function stepFromDecimals(d: number): string {
  return d === 0 ? "1" : `0.${"0".repeat(d - 1)}1`;
}

function toMarket(venue: LighterVenueId, net: Network, d: RawDetail, assetClass: AssetClass, fr: LighterFundingStat | undefined): VenueMarket {
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
    // Last settled hourly rate (market_stats funding_rate), per 1 h — the perp-ws `rate`.
    fundingRate: fr?.rate ?? null,
    fundingRateBasis: BASIS_1H,
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
      // The settled rate is the WS snapshot: unreadable → the rows are listed with fundingRate null
      // (unknown, never 0), and the reason is printed.
      const [details, funding] = await Promise.all([
        fetchPerpDetails(venue, net),
        fetchLighterFundingStats(venue, net).catch((e: unknown) => {
          console.warn(`[${venue}] settled funding rate unavailable (fundingRate null): ${e instanceof Error ? e.message : String(e)}`);
          return new Map<number, LighterFundingStat>();
        }),
      ]);
      const out: VenueMarket[] = [];
      for (const d of details) {
        // Live markets only (the rule of market list / the WS directory); inactive ones are not listed.
        if (!isLighterMarketLive(d)) continue;
        const cls = classify(venue, d.symbol);
        out.push(toMarket(venue, net, d, cls, funding.get(d.market_id)));
      }
      return out;
    },

    async fetchFundingRates(net) {
      // Settled hourly rates of the live markets (the market rows' fundingRate). A failed snapshot
      // propagates: the venue is reported as failed, never a list without Lighter rates.
      const [details, funding] = await Promise.all([fetchPerpDetails(venue, net), fetchLighterFundingStats(venue, net)]);
      const out: VenueFundingRate[] = [];
      for (const d of details) {
        if (!isLighterMarketLive(d)) continue;
        const rate = funding.get(d.market_id)?.rate ?? null;
        if (rate === null) continue; // no settled print yet: unknown, not 0
        out.push({
          venue,
          venueSymbol: String(d.market_id),
          symbol: d.symbol,
          canonical: canonicalFor(venue, d.symbol, classify(venue, d.symbol)),
          rate,
          basis: BASIS_1H,
          markPrice: d.mark_price,
          nextFundingTime: null, // not published
        });
      }
      return out;
    },
  };
}
