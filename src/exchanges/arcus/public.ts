/**
 * Arcus public market data — GET /v1/markets (one call serves both markets
 * and funding rates).
 *
 * Mapping notes:
 * - symbol: `baseAsset` (plain ticker, e.g. "TSLA"); venueSymbol: display name
 *   ("TSLA-USD") which is also the `market` key for l2OrderBook/trades/candles.
 * - tickSize / stepSize: the top-level fields. `tickTiers` (per-price-band
 *   placement grid) is NOT folded into VenueMarket — the signed integer price
 *   always divides by the top-level tickSize; tiers only restrict which limit
 *   prices are accepted. The adapter validates/aligns against the tier tick
 *   (see tickForPrice) using the raw market.
 * - maxLeverage: floor(1 / initialMarginFraction) (regular-hours IMF).
 * - assetClass from `category`: CRYPTO → crypto, EQUITIES → equity,
 *   FOREX → fx. COMMODITIES / INDICES listings on Arcus are ETFs (GLD, SLV,
 *   USO, CPER, SPY, QQQ …) → "etf" when `fullAssetName` names an ETF/Trust/
 *   Fund/Shares; otherwise commodity / index (canonical then comes only from the
 *   explicit table).
 * - session: only for markets with `regularTradingHours` (24/7 crypto → null).
 *   underlyingOpen = !isOutsideRth; priceBand = off-hours trading bounds when
 *   published; marginMultiplier = offHoursIMF / IMF.
 * - funding: hourly (`fundingRate` is the per-hour fraction last charged);
 *   `nextFundingAt` is Unix seconds.
 * - tradable: status === "ONLINE".
 */

import { PerpError } from "../../errors.js";
import { isArcusOnlineMarket } from "../../ws/arcus-market.js";
import { canonicalFor } from "../canonical-symbols.js";
import type { AssetClass, MarketSession, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import type { VenuePublicData } from "../venue.js";
import { arcusVenue } from "../venues/arcus.js";
import { ArcusClient } from "./client.js";

export interface ArcusTickTier { upToPrice?: string; tick: string }

export interface ArcusRawMarket {
  marketDisplayName: string;
  fullAssetName?: string;
  marketId: number;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  tickTiers: ArcusTickTier[] | null;
  minOrderNotional: string | null;
  minOrderSize: string | null;
  maxOrderSize: string | null;
  oraclePrice?: string;
  markPrice?: string;
  fundingRate?: string;
  nextFundingAt?: number;
  volume24h?: string;
  volume24hNotional?: string;
  openInterest?: string;
  initialMarginFraction?: string;
  maintenanceMarginFraction?: string;
  offHoursInitialMarginFraction?: string;
  regularTradingHours: unknown | null;
  isOutsideRth: boolean;
  upperTradingBound: string | null;
  lowerTradingBound: string | null;
  category: string;
}

const FUNDING_BASIS = { kind: "perHours", hours: 1 } as const;

export async function fetchArcusRawMarkets(client: ArcusClient): Promise<ArcusRawMarket[]> {
  const res = await client.get<{ markets?: unknown }>("/v1/markets", "markets");
  if (!res || !Array.isArray(res.markets)) {
    throw new PerpError("EXCHANGE_ERROR", "Arcus /v1/markets: missing markets array");
  }
  return res.markets as ArcusRawMarket[];
}

/** Fund-style names seen on Arcus COMMODITIES/INDICES listings (GLD "SPDR Gold Shares", SLV "iShares Silver Trust", USO/CPER "… Fund", SPY "SPDR S&P 500 ETF Trust"). */
const ETF_NAME = /\b(ETF|Trust|Fund|Shares|iShares|SPDR)\b/i;

export function arcusAssetClass(m: ArcusRawMarket): AssetClass {
  switch (m.category) {
    case "CRYPTO": return "crypto";
    case "EQUITIES": return "equity";
    case "FOREX": return "fx";
    case "COMMODITIES": return m.fullAssetName && ETF_NAME.test(m.fullAssetName) ? "etf" : "commodity";
    case "INDICES": return m.fullAssetName && ETF_NAME.test(m.fullAssetName) ? "etf" : "index";
    default:
      throw new PerpError("EXCHANGE_ERROR", `Arcus market ${m.marketDisplayName}: unknown category "${m.category}"`);
  }
}

function numOrNull(s: string | null | undefined): string | null {
  return typeof s === "string" && s.length > 0 && Number.isFinite(Number(s)) ? s : null;
}

function maxLeverageOf(m: ArcusRawMarket): number {
  const imf = Number(m.initialMarginFraction);
  if (!(imf > 0)) {
    throw new PerpError("EXCHANGE_ERROR", `Arcus market ${m.marketDisplayName}: invalid initialMarginFraction "${m.initialMarginFraction}"`);
  }
  // 1/0.025 is exactly 40 in binary FP for current markets; epsilon guards 1/0.1-style drift.
  return Math.floor(1 / imf + 1e-9);
}

function sessionOf(m: ArcusRawMarket): MarketSession | null {
  if (m.regularTradingHours === null || m.regularTradingHours === undefined) return null;
  const lower = numOrNull(m.lowerTradingBound);
  const upper = numOrNull(m.upperTradingBound);
  const imf = Number(m.initialMarginFraction);
  const offImf = Number(m.offHoursInitialMarginFraction);
  return {
    underlyingOpen: !m.isOutsideRth,
    priceBand: lower !== null && upper !== null ? { lower, upper } : null,
    // Rounded to 6 dp to drop binary-FP noise (0.0375/0.025 → 1.4999999999999998).
    marginMultiplier: imf > 0 && offImf > 0 ? Math.round((offImf / imf) * 1e6) / 1e6 : null,
  };
}

export function toArcusVenueMarket(m: ArcusRawMarket): VenueMarket {
  const assetClass = arcusAssetClass(m);
  const mark = numOrNull(m.markPrice);
  if (mark === null || !(Number(mark) > 0)) {
    throw new PerpError("EXCHANGE_ERROR", `Arcus market ${m.marketDisplayName}: missing / non-positive markPrice (${JSON.stringify(m.markPrice)})`);
  }
  return {
    venue: "arcus",
    venueSymbol: m.marketDisplayName,
    symbol: m.baseAsset,
    canonical: canonicalFor("arcus", m.baseAsset, assetClass),
    assetClass,
    settle: arcusVenue.networks.mainnet.collateral[0],
    quoteAsset: m.quoteAsset,
    markPrice: mark,
    indexPrice: numOrNull(m.oraclePrice),
    fundingRate: numOrNull(m.fundingRate),
    fundingRateBasis: FUNDING_BASIS,
    settlementIntervalHours: 1,
    openInterest: numOrNull(m.openInterest),
    volume24h: numOrNull(m.volume24hNotional),
    tickSize: m.tickSize,
    stepSize: m.stepSize,
    minSize: numOrNull(m.minOrderSize),
    minNotional: numOrNull(m.minOrderNotional),
    maxLeverage: maxLeverageOf(m),
    marginTiers: null,
    session: sessionOf(m),
    tradable: isArcusOnlineMarket(m),
  };
}

/**
 * Markets that are not ONLINE carry placeholder values (live 2026-10-13: the OFFLINE markets
 * F, BAC, CCL, VT, SGOV, RVI report markPrice "0" and fundingRate "0") — they are left out of
 * market / funding lists rather than listed at a $0 price and 0 % funding.
 */
export function onlineArcusMarkets(raw: ArcusRawMarket[]): ArcusRawMarket[] {
  return raw.filter(isArcusOnlineMarket);
}

async function fetchMarkets(net: Network): Promise<VenueMarket[]> {
  const raw = await fetchArcusRawMarkets(new ArcusClient(net, null));
  return onlineArcusMarkets(raw).map(toArcusVenueMarket);
}

async function fetchFundingRates(net: Network): Promise<VenueFundingRate[]> {
  const raw = await fetchArcusRawMarkets(new ArcusClient(net, null));
  const out: VenueFundingRate[] = [];
  const missing: string[] = [];
  for (const m of onlineArcusMarkets(raw)) {
    const rate = numOrNull(m.fundingRate);
    if (rate === null) { missing.push(m.marketDisplayName); continue; }
    const assetClass = arcusAssetClass(m);
    out.push({
      venue: "arcus",
      venueSymbol: m.marketDisplayName,
      symbol: m.baseAsset,
      canonical: canonicalFor("arcus", m.baseAsset, assetClass),
      rate,
      basis: FUNDING_BASIS,
      markPrice: numOrNull(m.markPrice),
      nextFundingTime: typeof m.nextFundingAt === "number" ? m.nextFundingAt * 1000 : null,
    });
  }
  if (missing.length > 0) {
    console.warn(`[arcus] excluded ${missing.length} market(s) without a published funding rate: ${missing.join(", ")}`);
  }
  return out;
}

export const arcusPublicData: VenuePublicData = { fetchMarkets, fetchFundingRates };
