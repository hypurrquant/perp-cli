/**
 * QFEX public market data.
 *
 * Sources (all public):
 *   GET /refdata                 instruments: tick, lot, min/max quantity, price band, status,
 *                                quote / margin asset, allowed order types + TIFs, market hours
 *   MDS market_stats snapshot    mark price (each entry with its own `time`), open interest,
 *                                24h notional volume
 *   GET /md/contracts            funding_rate / next_funding_rate_timestamp (funding reads);
 *                                index_price (market rows, best effort)
 *
 * Coupling: order-entry precision comes from /refdata ALONE (fetchQfexInstruments).
 * Markets need /refdata + the MDS snapshot; /md/contracts only adds indexPrice — its failure
 * leaves indexPrice null (unknown) with a warning, never fails market listing or order entry.
 * Funding reads need /md/contracts.
 *
 * indexPrice = /md/contracts `index_price` (docs contract-specifications: the Index Price is "the
 * reference spot price for the asset"; the OpenAPI field has no description). Live 2026-10-19 it
 * tracked the MDS `underlier` channel (AAPL 342.47 = 342.47, GOLD 4170.22 vs 4170.05, SAMSUNG-KRW
 * 220092 vs 220082 KRW), moved on 122 of 222 markets within 45 s, and sat a median 0.015 % from
 * the mark (max 5 %, CVNA pre-market). It is in the quote currency (`index_currency`), like the mark.
 * /md/contracts lists ACTIVE markets only; a non-positive / missing value is null.
 *
 * Funding is UNVERIFIED (venue flag fundingVerified: false, Q4): the rate's unit is not
 * confirmed against settled payments and `funding_rate` vs `next_funding_rate` is undecided.
 * Markets therefore carry fundingRate null; fetchFundingRates returns the raw `funding_rate`
 * for the explicit, flagged reads only (`perp funding`, `arb scan --include-unverified`).
 *
 * Symbols: "AAPL-USD" → CLI symbol "AAPL". Non-USD quotes keep the suffix ("SKHYNIX-KRW"),
 * have no canonical symbol and are NOT tradable through perp-cli (USD-assuming sizing / risk).
 */

import { PerpError } from "../../errors.js";
import { canonicalFor } from "../canonical-symbols.js";
import type { VenuePublicData } from "../venue.js";
import type { AssetClass, FundingRateBasis, MarketSession, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import { QFEX_ENDPOINTS } from "../venues/qfex.js";
import { QfexClient } from "./client.js";
import { fetchQfexMarketStats, QFEX_MDS_TIMEOUT_MS } from "./ws-transport.js";

export const QFEX_FUNDING_BASIS: FundingRateBasis = { kind: "perHours", hours: 1 };
export const QFEX_SETTLEMENT_HOURS = 1;
export const QFEX_USD_SUFFIX = "-USD";

/**
 * Pre-IPO perps (docs /qfex/pre-ipo-stocks). /refdata does not mark them (they are listed as
 * EQUITY), so the list is explicit; its completeness is Q12. Their price convention (implied
 * valuation per notional share count) is venue-specific → never matched across venues.
 */
export const QFEX_PRE_IPO: ReadonlySet<string> = new Set(["ANTHROPIC", "OPENAI"]);

// ── Raw shapes ──

export interface QfexSessionWindow { session: string; open: string; close: string }

export interface QfexRefdataRow {
  symbol: string;
  status: string;
  product_category: string;
  tick_size: string;
  lot_size: string;
  min_price: string;
  max_price: string;
  min_quantity: string;
  max_quantity: string;
  default_max_leverage: number;
  base_asset: string;
  quote_asset: string;
  margin_asset: string;
  order_types: string[];
  order_time_in_force: string[];
  market_hours: Record<string, unknown> | null;
}

export interface QfexContractRow {
  ticker_id: string;
  funding_rate: string;
  next_funding_rate: string;
  next_funding_rate_timestamp: number;
  /** Index (reference spot) price in the quote currency — see the module header. */
  index_price?: string;
  /**
   * NOT USD on a non-USD market despite the name: live 2026-10-19 SAMSUNG-KRW 1,234,418 =
   * open_interest 5.58 × index 221,118 → KRW (as is target_volume). Nothing reads it; never wire it
   * up as a USD figure. OI is reported in base units (VenueMarket.openInterest, MDS open_interests).
   */
  open_interest_usd?: string;
}

/** One instrument, as order entry needs it — from /refdata only. */
export interface QfexInstrument {
  venueSymbol: string;
  symbol: string;
  status: string;
  assetClass: AssetClass;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
  maxQuantity: string;
  /** Current price band (orders outside it are rejected before the engine). */
  band: { lower: string; upper: string };
  maxLeverage: number;
  quoteAsset: string;
  marginAsset: string;
  orderTypes: readonly string[];
  timeInForce: readonly string[];
  marketHours: Record<string, unknown> | null;
}

// ── Symbols ──

/** "AAPL-USD" → "AAPL"; a non-USD quote keeps its suffix ("SKHYNIX-KRW"). */
export function qfexPlainSymbol(venueSymbol: string): string {
  return venueSymbol.endsWith(QFEX_USD_SUFFIX) ? venueSymbol.slice(0, -QFEX_USD_SUFFIX.length) : venueSymbol;
}

/** CLI symbol ("aapl", "AAPL", "AAPL-USD", "SKHYNIX-KRW") → venue symbol. A bare ticker is the USD market. */
export function qfexVenueSymbol(symbol: string): string {
  const up = symbol.trim().toUpperCase().replace(/-PERP$/, "");
  if (up.length === 0) throw new PerpError("INVALID_PARAMS", "symbol is empty");
  return up.includes("-") ? up : `${up}${QFEX_USD_SUFFIX}`;
}

const CATEGORY_TO_ASSET_CLASS: Readonly<Record<string, AssetClass>> = {
  EQUITY: "equity",
  INDEX: "index",
  COMMODITY: "commodity",
  FX: "fx",
};

export function qfexAssetClass(row: Pick<QfexRefdataRow, "symbol" | "product_category" | "base_asset">): AssetClass {
  const c = CATEGORY_TO_ASSET_CLASS[row.product_category];
  if (c === undefined) {
    throw new PerpError("EXCHANGE_ERROR", `QFEX: cannot classify ${row.symbol} (product_category ${JSON.stringify(row.product_category)})`, {
      remediation: "Update CATEGORY_TO_ASSET_CLASS in src/exchanges/qfex/public.ts for the new venue category",
    });
  }
  return c === "equity" && QFEX_PRE_IPO.has(row.base_asset) ? "preIpo" : c;
}

function requireString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string" || v === "") throw new PerpError("EXCHANGE_ERROR", `QFEX /refdata: ${String(row.symbol)} has no ${key}`);
  return v;
}

function stringList(row: Record<string, unknown>, key: string): string[] {
  const v = row[key];
  if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new PerpError("EXCHANGE_ERROR", `QFEX /refdata: ${String(row.symbol)} has no ${key} list`);
  return v as string[];
}

export function toQfexInstrument(raw: unknown): QfexInstrument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new PerpError("EXCHANGE_ERROR", "QFEX /refdata: instrument row is not an object");
  const row = raw as Record<string, unknown>;
  const venueSymbol = requireString(row, "symbol");
  const lev = row.default_max_leverage;
  if (typeof lev !== "number" || !Number.isFinite(lev) || lev <= 0) {
    throw new PerpError("EXCHANGE_ERROR", `QFEX /refdata: ${venueSymbol} has no default_max_leverage`);
  }
  const hours = row.market_hours;
  const base = requireString(row, "base_asset");
  const category = requireString(row, "product_category");
  return {
    venueSymbol,
    symbol: qfexPlainSymbol(venueSymbol),
    status: requireString(row, "status"),
    assetClass: qfexAssetClass({ symbol: venueSymbol, product_category: category, base_asset: base }),
    tickSize: requireString(row, "tick_size"),
    lotSize: requireString(row, "lot_size"),
    minQuantity: requireString(row, "min_quantity"),
    maxQuantity: requireString(row, "max_quantity"),
    band: { lower: requireString(row, "min_price"), upper: requireString(row, "max_price") },
    maxLeverage: lev,
    quoteAsset: requireString(row, "quote_asset"),
    marginAsset: requireString(row, "margin_asset"),
    orderTypes: stringList(row, "order_types"),
    timeInForce: stringList(row, "order_time_in_force"),
    marketHours: hours !== null && typeof hours === "object" && !Array.isArray(hours) ? hours as Record<string, unknown> : null,
  };
}

/** Is the market one perp-cli may send orders to? USD-quoted and ACTIVE. */
export function qfexTradable(i: Pick<QfexInstrument, "status" | "quoteAsset">): boolean {
  return i.status === "ACTIVE" && i.quoteAsset === "USD";
}

// ── Market hours → session ──

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Session names of the instrument's market_hours that contain `ms` (weekday + local time in its
 * `tz`); [] = no window listed at that time. null = the venue published no usable schedule.
 */
function qfexSessionsAt(marketHours: Record<string, unknown> | null, ms: number): string[] | null {
  if (marketHours === null || typeof marketHours.tz !== "string") return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: marketHours.tz, weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms));
  } catch {
    return null; // an unknown IANA zone name is "no usable schedule", not a closed market
  }
  const get = (t: string): string | undefined => parts.find(p => p.type === t)?.value;
  const weekday = get("weekday")?.toLowerCase();
  const h = get("hour"), m = get("minute"), s = get("second");
  if (weekday === undefined || !WEEKDAYS.includes(weekday) || h === undefined || m === undefined || s === undefined) return null;
  const now = `${h}:${m}:${s}`;
  const day = marketHours[weekday];
  if (day === undefined) return []; // no window listed for this weekday
  if (!Array.isArray(day)) return null;
  const out: string[] = [];
  for (const w of day) {
    if (w === null || typeof w !== "object") return null;
    const win = w as Partial<QfexSessionWindow>;
    if (typeof win.session !== "string" || typeof win.open !== "string" || typeof win.close !== "string") return null;
    if (now >= win.open && now <= win.close) out.push(win.session);
  }
  return out;
}

/**
 * Whether `nowMs` falls inside a `session: "open"` window of the instrument's market_hours.
 * null = the venue published no usable schedule. This is the underlying's regular session only;
 * funding hours are qfexFundingWindowClosed's question.
 */
export function qfexUnderlyingOpen(marketHours: Record<string, unknown> | null, nowMs: number): boolean | null {
  const sessions = qfexSessionsAt(marketHours, nowMs);
  return sessions === null ? null : sessions.includes("open");
}

/** market_hours session names during which no funding accrues. */
const QFEX_NON_FUNDING_SESSIONS: ReadonlySet<string> = new Set(["weekend", "close"]);

/**
 * Was the funding window labelled `windowStartMs` outside the market's funding hours? Docs
 * (docs.qfex.com/qfex/funding): "Funding is only active during a symbol's configured
 * market_hours"; outside them "funding rate is 0 and no funding payment is exchanged".
 *
 * The window labelled T covers the hour BEFORE T (live 2026-10-19, GET /funding, 9 symbols over
 * 10 days: AAPL-USD prints its last non-zero rate at Sat 00:00Z = Fri 20:00 ET and its first at
 * Mon 01:00Z = Sun 21:00 ET, i.e. funding Sun 20:00–Fri 20:00 ET as documented, only when each
 * label is read as the end of its hour).
 *
 * market_hours alone does not say whether an unlisted gap funds (US equities fund overnight
 * between post_market and pre_market; Korean equities do not fund outside "open"), so a window is
 * closed when the venue printed exactly 0 AND no part of the hour was in a funding session
 * (anything but "weekend" / "close"). A non-zero rate is never marked closed, and a 0 inside a
 * session stays a real 0. No usable schedule → never closed.
 *
 * Known limits (review B2-4 / B2-5):
 *  - market holidays are not in market_hours: a holiday inside a configured weekday session
 *    (SAMSUNG-KRW on Hangul Day) prints the venue's 0 as a real-looking "0", marketClosed false;
 *  - US equities fund in the weekday overnight gap (post_market → pre_market, docs "Sunday 20:00 –
 *    Friday 20:00 ET"), so a gap is never closed by schedule alone — only an exact 0 there is, and
 *    a genuine 0 rate in such a gap is (rarely) reported as closed.
 */
export function qfexFundingWindowClosed(marketHours: Record<string, unknown> | null, windowStartMs: number, rate: number): boolean {
  if (rate !== 0) return false;
  const from = windowStartMs - 3_600_000;
  // Sampled inside the hour, never on its edges: market_hours closes are inclusive and often on
  // the hour (GOLD-USD Fri close "17:00:00"), so a sample AT `from` would put the hour after the
  // close inside the session (GOLD printed 0 for Fri 17:00–18:00 ET on 2026-10-09 and 10-16).
  for (const t of [from + 1_000, from + 900_000, from + 1_800_000, from + 2_700_000, windowStartMs - 1_000]) {
    const sessions = qfexSessionsAt(marketHours, t);
    if (sessions === null) return false;
    if (sessions.some(x => !QFEX_NON_FUNDING_SESSIONS.has(x))) return false;
  }
  return true;
}

function sessionOf(i: QfexInstrument, nowMs: number): MarketSession | null {
  const open = qfexUnderlyingOpen(i.marketHours, nowMs);
  if (open === null) return null;
  return { underlyingOpen: open, priceBand: i.band, marginMultiplier: null };
}

// ── Fetchers ──

export function qfexPublicClient(net: Network): QfexClient {
  const ep = QFEX_ENDPOINTS[net];
  return new QfexClient({ restUrl: ep.rest, bankerUrl: ep.banker, network: net, credentials: null, accountId: null });
}

/** Every instrument of /refdata (all statuses). The only input of order-entry validation. */
export async function fetchQfexInstruments(client: QfexClient): Promise<QfexInstrument[]> {
  const body = await client.publicGet<{ data?: unknown }>("/refdata", null);
  if (!Array.isArray(body.data)) throw new PerpError("EXCHANGE_ERROR", "QFEX /refdata: response has no data list");
  return body.data.map(toQfexInstrument);
}

function canonicalOf(i: QfexInstrument): string | null {
  // A local-currency quote is a different contract from the USD one (ZHIPU-HKD vs ZHIPU-USD).
  if (i.quoteAsset !== "USD") return null;
  return canonicalFor("qfex", i.symbol, i.assetClass);
}

/** venue symbol → /md/contracts `index_price` (positive finite only). */
export function qfexIndexPrices(contracts: readonly Partial<QfexContractRow>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of contracts) {
    const v = c.index_price;
    if (typeof c.ticker_id === "string" && typeof v === "string" && Number.isFinite(Number(v)) && Number(v) > 0) out.set(c.ticker_id, v);
  }
  return out;
}

export function buildQfexMarkets(
  instruments: readonly QfexInstrument[],
  snap: { marks: ReadonlyMap<string, { price: string; time: number }>; openInterest: ReadonlyMap<string, string>; volumeNotional: ReadonlyMap<string, string> },
  nowMs: number,
  indexPrices: ReadonlyMap<string, string> = new Map(),
): { markets: VenueMarket[]; activeWithoutMark: string[] } {
  const markets: VenueMarket[] = [];
  const activeWithoutMark: string[] = [];
  for (const i of instruments) {
    // Listing policy: a DELISTED / INACTIVE market is not listed (per-symbol reads refuse it); only
    // ACTIVE markets are, with tradable false when perp-cli cannot trade them (non-USD quote).
    if (i.status !== "ACTIVE") continue;
    const mark = snap.marks.get(i.venueSymbol);
    if (mark === undefined) {
      if (i.status === "ACTIVE") activeWithoutMark.push(i.venueSymbol);
      continue; // no price feed → cannot be priced; never given a made-up mark
    }
    const oi = snap.openInterest.get(i.venueSymbol);
    const vol = snap.volumeNotional.get(i.venueSymbol);
    markets.push({
      venue: "qfex",
      venueSymbol: i.venueSymbol,
      symbol: i.symbol,
      canonical: canonicalOf(i),
      assetClass: i.assetClass,
      settle: i.marginAsset,
      quoteAsset: i.quoteAsset,
      markPrice: mark.price,
      indexPrice: indexPrices.get(i.venueSymbol) ?? null,
      fundingRate: null, // unverified (Q4) — see module header
      fundingRateBasis: QFEX_FUNDING_BASIS,
      settlementIntervalHours: QFEX_SETTLEMENT_HOURS,
      openInterest: oi === undefined ? null : oi,
      // daily_volumes_notional is in the QUOTE currency (live 2026-10-19: SAMSUNG-KRW 9,827,530 =
      // /md/contracts target_volume 9,763,491 KRW ≈ base_volume 45.16 × ~216,000 KRW, and the
      // 24 hourly candles' usdVolume sum to 9,821,767). VenueMarket.volume24h is USD, and the venue
      // publishes no USD-KRW / JPY / CNY / SEK / HKD rate → null for a non-USD quote.
      volume24h: vol === undefined || i.quoteAsset !== "USD" ? null : vol,
      tickSize: i.tickSize,
      stepSize: i.lotSize,
      minSize: i.minQuantity,
      minNotional: null, // REJECTED_LESS_THAN_MIN_NOTIONAL exists but the threshold is unpublished
      maxLeverage: i.maxLeverage,
      marginTiers: null,
      session: sessionOf(i, nowMs),
      tradable: qfexTradable(i),
    });
  }
  return { markets, activeWithoutMark };
}

/**
 * Priced markets, the /refdata instruments they were built from (status / quote asset per row) and
 * the 24h notional per venue symbol in its QUOTE currency (KRW for SAMSUNG-KRW).
 */
export async function fetchQfexMarketsWithInstruments(net: Network): Promise<{ markets: VenueMarket[]; instruments: QfexInstrument[]; volumeNotional: ReadonlyMap<string, string> }> {
  const client = qfexPublicClient(net);
  const instruments = await fetchQfexInstruments(client);
  const snap = await fetchQfexMarketStats(QFEX_ENDPOINTS[net].mdsWs, "*", QFEX_MDS_TIMEOUT_MS);
  let indexPrices = new Map<string, string>();
  try {
    const body = await client.publicGet<{ data?: unknown }>("/md/contracts", null);
    if (!Array.isArray(body.data)) throw new Error("response has no data list");
    indexPrices = qfexIndexPrices(body.data as Partial<QfexContractRow>[]);
  } catch (e) {
    console.warn(`[qfex] index prices unavailable (/md/contracts: ${e instanceof Error ? e.message : String(e)}); indexPrice left null`);
  }
  const { markets, activeWithoutMark } = buildQfexMarkets(instruments, snap, Date.now(), indexPrices);
  if (activeWithoutMark.length > 0) {
    console.warn(`[qfex] excluded ${activeWithoutMark.length} active market(s) without a mark price: ${activeWithoutMark.join(", ")}`);
  }
  return { markets, instruments, volumeNotional: snap.volumeNotional };
}

async function fetchMarkets(net: Network): Promise<VenueMarket[]> {
  return (await fetchQfexMarketsWithInstruments(net)).markets;
}

export function buildQfexFundingRates(
  instruments: readonly QfexInstrument[],
  contracts: readonly QfexContractRow[],
  marks: ReadonlyMap<string, { price: string; time: number }>,
  nowMs: number,
): { rates: VenueFundingRate[]; unlisted: string[] } {
  const byVenueSymbol = new Map(instruments.map(i => [i.venueSymbol, i]));
  const rates: VenueFundingRate[] = [];
  const unlisted: string[] = [];
  for (const c of contracts) {
    const i = byVenueSymbol.get(c.ticker_id);
    if (i === undefined) { unlisted.push(c.ticker_id); continue; }
    if (i.status !== "ACTIVE") continue;
    if (typeof c.funding_rate !== "string" || c.funding_rate === "") {
      throw new PerpError("EXCHANGE_ERROR", `QFEX /md/contracts: ${c.ticker_id} has no funding_rate`);
    }
    const mark = marks.get(c.ticker_id);
    const nextMs = typeof c.next_funding_rate_timestamp === "number" ? c.next_funding_rate_timestamp * 1000 : null;
    // `funding_rate` is the implied rate of the window in progress, labelled by its END (the next
    // top of the hour, = next_funding_rate_timestamp live) — the same window rule as history.
    const marketClosed = qfexFundingWindowClosed(i.marketHours, Math.floor(nowMs / 3_600_000) * 3_600_000 + 3_600_000, Number(c.funding_rate));
    rates.push({
      venue: "qfex",
      venueSymbol: c.ticker_id,
      symbol: i.symbol,
      canonical: canonicalOf(i),
      rate: marketClosed ? null : c.funding_rate,
      marketClosed,
      basis: QFEX_FUNDING_BASIS,
      markPrice: mark === undefined ? null : mark.price,
      // A timestamp in the past is not a "next" funding time (seen on closed markets).
      nextFundingTime: nextMs !== null && nextMs > nowMs ? nextMs : null,
    });
  }
  return { rates, unlisted };
}

async function fetchFundingRates(net: Network): Promise<VenueFundingRate[]> {
  const client = qfexPublicClient(net);
  const instruments = await fetchQfexInstruments(client);
  const body = await client.publicGet<{ data?: unknown }>("/md/contracts", null);
  if (!Array.isArray(body.data)) throw new PerpError("EXCHANGE_ERROR", "QFEX /md/contracts: response has no data list");
  const snap = await fetchQfexMarketStats(QFEX_ENDPOINTS[net].mdsWs, "*", QFEX_MDS_TIMEOUT_MS);
  const { rates, unlisted } = buildQfexFundingRates(instruments, body.data as QfexContractRow[], snap.marks, Date.now());
  if (unlisted.length > 0) {
    console.warn(`[qfex] excluded ${unlisted.length} contract(s) missing from /refdata: ${unlisted.join(", ")}`);
  }
  return rates;
}

export const qfexPublicData: VenuePublicData = { fetchMarkets, fetchFundingRates };
