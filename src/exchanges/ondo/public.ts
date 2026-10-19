/**
 * Ondo Perps public market data.
 *
 * Sources (all public, live-verified 2026-09-30):
 *   GET /v1/markets           result.perps.tradingPairs[] — increments, margin
 *                             brackets, tags (asset class), trading schedule
 *   GET /v1/perps/contracts   result[] — ticker, funding, OI, volume, status
 *   GET /v1/perps/mark_prices result{market: MarkPrice} — mark price and the
 *                             weekend discovery band (discoveryLower/Upper,
 *                             inPriceDiscovery; not in the OpenAPI spec but
 *                             returned live)
 *
 * Funding is hourly: `fundingRate` is a 1h rate (docs funding-rates), so the
 * basis is perHours 1 and settlement is every hour.
 *
 * Symbols: venue symbol "TSLA-USD.P" → CLI symbol "TSLA". Spot pairs
 * (result.spot) are not perp markets; OndoSpotAdapter reads them via
 * fetchOndoSpotTradingPairs.
 */

import { PerpError } from "../../errors.js";
import { canonicalFor } from "../canonical-symbols.js";
import type { VenuePublicData } from "../venue.js";
import { networkConfig } from "../venue.js";
import type { AssetClass, FundingRateBasis, MarketSession, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import { ondoVenue } from "../venues/ondo.js";
import { OndoClient } from "./client.js";

export const ONDO_PERP_SUFFIX = "-USD.P";
export const ONDO_FUNDING_BASIS: FundingRateBasis = { kind: "perHours", hours: 1 };
export const ONDO_SETTLEMENT_HOURS = 1;

// ── Raw shapes (OpenAPI rest-spec.json + live responses) ──

export interface OndoMarginBracket {
  positionBracketUsd: string;
  maxLeverage: string;
  maintenanceMarginRate: string;
  maintenanceAmount: string;
}

export interface OndoTradingPair {
  market: string;
  pair: { base: string; quote: string };
  baseIncrement: string;
  quoteIncrement: string;
  marginInfo: OndoMarginBracket[];
  tags: string[] | null;
  /** Present on listings with a trading schedule (non-crypto); absent for 24/7 crypto. */
  schedule?: unknown;
  /** Present (true) on delisted / paused listings. */
  disabled?: boolean;
}

/** Spot pair from /v1/markets result.spot.tradingPairs (live; not in the OpenAPI spec). */
export interface OndoSpotTradingPair {
  market: string;
  pair: { base: string; quote: string };
  longName?: string;
  baseIncrement: string;
  quoteIncrement: string;
  makerFee: string;
  takerFee: string;
  tags: string[] | null;
  /** Present (true) on pairs that are listed but not tradable. */
  disabled?: boolean;
}

interface OndoMarketsResult {
  perps: { tradingPairs: OndoTradingPair[] };
  spot: { tradingPairs: OndoSpotTradingPair[] };
}

export interface OndoContract {
  market: string;
  disabled: boolean;
  lastPrice?: string;
  usdVolume?: string;
  openInterest?: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingRateTimestamp?: string;
  isClosed?: boolean;
  reduceOnly?: boolean;
  tags?: string[];
}

export interface OndoMarkPrice {
  market: string;
  markPrice: string;
  oraclePrice: string;
  discoveryLower?: string;
  discoveryUpper?: string;
  inPriceDiscovery?: boolean;
}

// ── Helpers ──

const TAG_TO_ASSET_CLASS: Readonly<Record<string, AssetClass>> = {
  Crypto: "crypto",
  Stock: "equity",
  ETF: "etf",
  Index: "index",
  Commodity: "commodity",
  FX: "fx",
  "Pre-IPO": "preIpo", // live 2026-10-19: OPENAI-USD.P
};

export function ondoAssetClass(market: string, tags: readonly string[] | null | undefined): AssetClass {
  if (tags === null || tags === undefined) {
    throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: ${market} has no tags; cannot classify asset class`);
  }
  const known = tags.map(t => TAG_TO_ASSET_CLASS[t]).filter((c): c is AssetClass => c !== undefined);
  if (known.length !== 1) {
    throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: cannot classify ${market} from tags ${JSON.stringify(tags)}`, {
      remediation: "Update TAG_TO_ASSET_CLASS in src/exchanges/ondo/public.ts for the new venue tag",
    });
  }
  return known[0];
}

/** "TSLA-USD.P" → "TSLA". Throws for non-perp symbols. */
export function ondoPlainSymbol(venueSymbol: string): string {
  if (!venueSymbol.endsWith(ONDO_PERP_SUFFIX)) {
    throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: unexpected perp market symbol "${venueSymbol}"`);
  }
  return venueSymbol.slice(0, -ONDO_PERP_SUFFIX.length);
}

/**
 * The one Ondo symbol normalizer, used by every command: "tsla", "TSLA", "TSLA-USD", "TSLA-USD.P",
 * "TSLA-PERP" → venue symbol "TSLA-USD.P". 0.15.0 appended the suffix to whatever it was given
 * ("AAPL-USD" → "AAPL-USD-USD.P", "AAPL-PERP" → "AAPL-PERP-USD.P").
 */
export function ondoVenueSymbol(symbol: string): string {
  const base = symbol.trim().toUpperCase().replace(/(-USD\.P|-PERP|-USD)$/, "");
  if (base.length === 0) throw new PerpError("INVALID_PARAMS", "symbol is empty");
  return `${base}${ONDO_PERP_SUFFIX}`;
}

/**
 * Listing state of an Ondo perp. "disabled" = delisted / paused (`disabled: true` on the
 * /v1/markets pair or the /v1/perps/contracts row; its price fields are zeroed or frozen and its
 * fundingRate is stale); "closed" = `isClosed` (no new trading); "reduceOnly" = closes only.
 * Only "active" is tradable.
 */
export type OndoMarketStatus = "active" | "disabled" | "closed" | "reduceOnly";
/** State of a LISTED market: a disabled one is not listed (listing policy: delisted / disabled / inactive → not listed). */
export type OndoListedStatus = Exclude<OndoMarketStatus, "disabled">;

/** The one "disabled" predicate (listing and every per-symbol read): either source flags it. */
export function ondoDisabled(pair: Pick<OndoTradingPair, "disabled">, contract: Pick<OndoContract, "disabled"> | null): boolean {
  return pair.disabled === true || contract?.disabled === true;
}

export function ondoMarketStatus(pair: Pick<OndoTradingPair, "disabled">, contract: Pick<OndoContract, "disabled" | "isClosed" | "reduceOnly"> | null): OndoMarketStatus {
  if (ondoDisabled(pair, contract)) return "disabled";
  if (contract?.isClosed === true) return "closed";
  if (contract?.reduceOnly === true) return "reduceOnly";
  return "active";
}

/** Empty string / absent → null. Ondo omits or blanks fields it does not publish. */
export function strOrNull(v: string | undefined | null): string | null {
  return v === undefined || v === null || v === "" ? null : v;
}

/**
 * A price field that the venue zeroes when it has no value: /v1/perps/contracts reports
 * indexPrice "0" (and lastPrice "0") on disabled contracts (live 2026-10-14: ADBE, BE, CELH, IBM,
 * NOK, OKLO, RDDT, SHEIN, SMCI, IBB, VXX, EURUSD — all `disabled: true`). A price is never 0, so
 * "0" means "no index" → null (unknown), never $0.00. Volume / OI zeros stay: 0 is a real amount.
 */
export function priceOrNull(v: string | undefined | null): string | null {
  const s = strOrNull(v);
  return s === null || Number(s) === 0 ? null : s;
}

export function parseOndoTime(iso: string, what: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: invalid ${what} timestamp "${iso}"`);
  return t;
}

function marginTiersOf(pair: OndoTradingPair): { maxLeverage: number; tiers: Array<{ lowerBound: number; maxLeverage: number }> } {
  if (pair.marginInfo.length === 0) {
    throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: ${pair.market} has no marginInfo brackets`);
  }
  // Brackets are ascending by positionBracketUsd (the bracket's upper bound).
  const tiers: Array<{ lowerBound: number; maxLeverage: number }> = [];
  let lower = 0;
  for (const b of pair.marginInfo) {
    const lev = Number(b.maxLeverage);
    const upper = Number(b.positionBracketUsd);
    if (!Number.isFinite(lev) || lev <= 0 || !Number.isFinite(upper)) {
      throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: ${pair.market} invalid margin bracket ${JSON.stringify(b)}`);
    }
    tiers.push({ lowerBound: lower, maxLeverage: lev });
    lower = upper;
  }
  return { maxLeverage: Math.max(...tiers.map(t => t.maxLeverage)), tiers };
}

/**
 * Weekend/holiday discovery band (docs weekend-trading). Only non-crypto
 * listings carry a schedule; for 24/7 crypto the session is null.
 * `inPriceDiscovery` = external feeds unavailable (underlying closed) and the
 * mark is bounded by [discoveryLower, discoveryUpper].
 */
function sessionOf(pair: OndoTradingPair, mark: OndoMarkPrice): MarketSession | null {
  if (pair.schedule === undefined || pair.schedule === null) return null;
  if (typeof mark.inPriceDiscovery !== "boolean") return null;
  if (!mark.inPriceDiscovery) return { underlyingOpen: true, priceBand: null, marginMultiplier: null };
  const lower = strOrNull(mark.discoveryLower);
  const upper = strOrNull(mark.discoveryUpper);
  return {
    underlyingOpen: false,
    priceBand: lower !== null && upper !== null ? { lower, upper } : null,
    marginMultiplier: null,
  };
}

// ── Fetchers ──

export function ondoPublicClient(net: Network): OndoClient {
  return new OndoClient({
    restUrl: networkConfig(ondoVenue, net).restUrl,
    network: net,
    rateLimit: ondoVenue.rateLimit,
    credentials: null,
  });
}

export async function fetchOndoTradingPairs(client: OndoClient): Promise<OndoTradingPair[]> {
  const r = await client.publicGet<OndoMarketsResult>("/v1/markets", null);
  return r.perps.tradingPairs;
}

export async function fetchOndoSpotTradingPairs(client: OndoClient): Promise<OndoSpotTradingPair[]> {
  const r = await client.publicGet<OndoMarketsResult>("/v1/markets", null);
  if (r.spot === undefined || !Array.isArray(r.spot.tradingPairs)) {
    throw new PerpError("EXCHANGE_ERROR", "Ondo Perps: /v1/markets has no result.spot.tradingPairs");
  }
  return r.spot.tradingPairs;
}

function byMarket<T extends { market: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map(r => [r.market, r]));
}

function requireRow<T>(m: Map<string, T>, market: string, source: string): T {
  const row = m.get(market);
  if (row === undefined) {
    throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: ${market} is missing from ${source}`);
  }
  return row;
}

/**
 * Every listed Ondo perp with its state (getMarkets rows carry `status`; VenueMarket has no field
 * for it). Disabled (delisted / paused) listings are NOT listed — per-symbol reads refuse them —
 * while closed / reduce-only markets stay listed with tradable false.
 */
export async function fetchOndoMarketsWithStatus(net: Network): Promise<Array<{ market: VenueMarket; status: OndoListedStatus }>> {
  const client = ondoPublicClient(net);
  const pairs = await fetchOndoTradingPairs(client);
  const contracts = byMarket(await client.publicGet<OndoContract[]>("/v1/perps/contracts", null));
  const marks = await client.publicGet<Record<string, OndoMarkPrice>>("/v1/perps/mark_prices", null);

  // A listing with no mark price has no price feed (seen on the sandbox, e.g.
  // SHEIN/COPPER/NATGAS with lastPrice 0). It cannot be priced or traded, so it
  // is excluded with a warning rather than given a made-up mark.
  const noMark = pairs.filter(p => marks[p.market] === undefined).map(p => p.market);
  if (noMark.length > 0) {
    console.warn(`[ondo] excluded ${noMark.length} market(s) without a mark price: ${noMark.join(", ")}`);
  }

  const out: Array<{ market: VenueMarket; status: OndoListedStatus }> = [];
  for (const pair of pairs.filter(p => marks[p.market] !== undefined)) {
    const contract = requireRow(contracts, pair.market, "/v1/perps/contracts");
    const mark = marks[pair.market];
    const symbol = ondoPlainSymbol(pair.market);
    const assetClass = ondoAssetClass(pair.market, pair.tags);
    const { maxLeverage, tiers } = marginTiersOf(pair);
    const status = ondoMarketStatus(pair, contract);
    if (status === "disabled") continue;
    out.push({ status, market: {
      venue: "ondo",
      venueSymbol: pair.market,
      symbol,
      canonical: canonicalFor("ondo", symbol, assetClass),
      assetClass,
      settle: "USDC",
      quoteAsset: pair.pair.quote,
      markPrice: mark.markPrice,
      // /v1/perps/contracts `indexPrice` is frozen (live 2026-10-19: BTC 82702.30 unchanged for 17 min
      // while the mark_prices oracle moved 0.5%); the oracle of /v1/perps/mark_prices is the live index.
      indexPrice: priceOrNull(mark.oraclePrice),
      fundingRate: strOrNull(contract.fundingRate),
      fundingRateBasis: ONDO_FUNDING_BASIS,
      settlementIntervalHours: ONDO_SETTLEMENT_HOURS,
      openInterest: strOrNull(contract.openInterest),
      volume24h: strOrNull(contract.usdVolume),
      tickSize: pair.quoteIncrement,
      stepSize: pair.baseIncrement,
      minSize: null,
      minNotional: null,
      maxLeverage,
      marginTiers: tiers,
      session: sessionOf(pair, mark),
      tradable: status === "active",
    } });
  }
  return out;
}

async function fetchMarkets(net: Network): Promise<VenueMarket[]> {
  return (await fetchOndoMarketsWithStatus(net)).map(r => ({ ...r.market, status: r.status }));
}

async function fetchFundingRates(net: Network): Promise<VenueFundingRate[]> {
  const client = ondoPublicClient(net);
  const contracts = await client.publicGet<OndoContract[]>("/v1/perps/contracts", null);
  const marks = await client.publicGet<Record<string, OndoMarkPrice>>("/v1/perps/mark_prices", null);

  const out: VenueFundingRate[] = [];
  for (const c of contracts) {
    if (c.disabled) continue; // delisted/paused listings carry a stale rate and a zero last price
    const rate = strOrNull(c.fundingRate);
    if (rate === null) {
      throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: ${c.market} has no fundingRate in /v1/perps/contracts`);
    }
    const symbol = ondoPlainSymbol(c.market);
    const next = strOrNull(c.nextFundingRateTimestamp);
    const mark = marks[c.market];
    out.push({
      venue: "ondo",
      venueSymbol: c.market,
      symbol,
      canonical: canonicalFor("ondo", symbol, ondoAssetClass(c.market, c.tags)),
      rate,
      basis: ONDO_FUNDING_BASIS,
      markPrice: mark === undefined ? null : mark.markPrice,
      nextFundingTime: next === null ? null : parseOndoTime(next, "nextFundingRateTimestamp"),
    });
  }
  return out;
}

export const ondoPublicData: VenuePublicData = { fetchMarkets, fetchFundingRates };
