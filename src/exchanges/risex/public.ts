/**
 * RISEx public market data — GET /v1/markets (one call serves markets and funding).
 *
 * Mapping:
 *  - symbol: config.name "BTC/USDC" → "BTC"; venueSymbol = market_id ("1").
 *  - inactive markets (`active: false`, e.g. the deprecated DOGE market 13) are excluded.
 *    tradable = active && config.unlocked && !reduce_only (a reduce-only market can only close).
 *  - tick = config.step_price, step = config.step_size, min size = config.min_order_size.
 *  - assetClass from `category`: crypto / commodity / stocks (→ equity, or etf when tagged
 *    "etf") / index_etf (→ etf). An unknown category is skipped with a warning.
 *  - funding: `current_funding_rate` is a FRACTION PER HOUR and equals the last settled print in
 *    /funding-rate-history (lastSettled) — verified against public funding payments
 *    (payment = position size × index × rate, 2026-10-14). `funding_interval` is in ns and must
 *    be 3600e9; a market with another interval gets no funding row (warned).
 *  - all timestamps are ns → ms.
 */

import { canonicalFor } from "../canonical-symbols.js";
import { networkConfig, type VenuePublicData } from "../venue.js";
import type { AssetClass, FundingRateBasis, Network, VenueFundingRate, VenueMarket } from "../venue-types.js";
import { risexVenue } from "../venues/risex.js";
import { RisexClient } from "./client.js";
import { decOrNull, nsToMsOrNull, positiveOrNull, trimDecimal } from "./units.js";
import { PerpError } from "../../errors.js";

export const RISEX_FUNDING_BASIS: FundingRateBasis = { kind: "perHours", hours: 1 };
export const RISEX_FUNDING_INTERVAL_NS = "3600000000000";

export interface RisexMarketConfig {
  name: string;
  step_size: string;
  step_price: string;
  max_leverage: string;
  min_order_size: string;
  unlocked: boolean;
  match_price_band?: string;
}

export interface RisexRawMarket {
  market_id: string;
  config: RisexMarketConfig;
  mark_price?: string;
  index_price?: string;
  last_price?: string;
  open_interest?: string;
  quote_volume_24h?: string;
  funding_interval?: string;
  next_funding_time?: string;
  current_funding_rate?: string;
  predicted_funding_rate?: string;
  post_only: boolean;
  reduce_only: boolean;
  active: boolean;
  category: string;
  search_tags?: string[];
}

export function risexClient(net: Network): RisexClient {
  return new RisexClient(networkConfig(risexVenue, net).restUrl, risexVenue.rateLimit, `risex:${net}`);
}

export async function fetchRisexRawMarkets(client: RisexClient): Promise<RisexRawMarket[]> {
  const data = await client.get<{ markets?: unknown }>("/v1/markets");
  if (!Array.isArray(data.markets)) throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/markets: missing markets array", { exchange: "risex" });
  for (const m of data.markets as RisexRawMarket[]) {
    if (typeof m?.market_id !== "string" || m.config === null || typeof m.config !== "object" || typeof m.config.name !== "string"
      || typeof m.active !== "boolean" || typeof m.reduce_only !== "boolean" || typeof m.post_only !== "boolean") {
      throw new PerpError("EXCHANGE_ERROR", `RISEx /v1/markets: malformed market row ${JSON.stringify(m).slice(0, 120)}`, { exchange: "risex" });
    }
  }
  return data.markets as RisexRawMarket[];
}

/**
 * A listed market: `active` and not a deprecated listing ("DOGE/USDC [deprecated-…]" — testnet keeps
 * such a market active but locked, next to its replacement with the same base).
 */
export function isListedRisexMarket(m: Pick<RisexRawMarket, "active" | "config">): boolean {
  return m.active && !/\[deprecated/i.test(m.config.name);
}

/** "BTC/USDC" → "BTC". */
export function risexSymbolOf(m: Pick<RisexRawMarket, "config">): string {
  const base = m.config.name.split("/")[0].trim().toUpperCase();
  if (base === "") throw new PerpError("EXCHANGE_ERROR", `RISEx market name "${m.config.name}" has no base`, { exchange: "risex" });
  return base;
}

export function risexAssetClass(m: Pick<RisexRawMarket, "category" | "search_tags">): AssetClass | null {
  switch (m.category) {
    case "crypto": return "crypto";
    case "commodity": return "commodity";
    case "stocks": return (m.search_tags ?? []).includes("etf") ? "etf" : "equity";
    case "index_etf": return "etf";
    default: return null;
  }
}

/** Hourly funding fraction, or null when the market's interval is not one hour / no rate is published. */
export function risexHourlyFunding(m: RisexRawMarket): string | null {
  if (m.funding_interval !== RISEX_FUNDING_INTERVAL_NS) return null;
  const r = decOrNull(m.current_funding_rate);
  return r === null ? null : trimDecimal(r);
}

/** Active markets only (inactive / deprecated markets are excluded). Unknown categories are warned and skipped. */
export function toRisexVenueMarkets(raw: readonly RisexRawMarket[], warn: (msg: string) => void): VenueMarket[] {
  const out: VenueMarket[] = [];
  for (const m of raw) {
    if (!isListedRisexMarket(m)) continue;
    const assetClass = risexAssetClass(m);
    if (assetClass === null) {
      warn(`[risex] skipped market ${m.market_id} (${m.config.name}): unknown category "${m.category}"`);
      continue;
    }
    // "0" is RISEx's "none" (positiveOrNull): no price, never a "0" price.
    const mark = positiveOrNull(m.mark_price);
    if (mark === null) {
      warn(`[risex] skipped market ${m.market_id} (${m.config.name}): no mark price`);
      continue;
    }
    if (m.funding_interval !== RISEX_FUNDING_INTERVAL_NS) {
      warn(`[risex] market ${m.config.name}: funding interval ${String(m.funding_interval)} ns is not 1h — funding shown as unknown`);
    }
    const symbol = risexSymbolOf(m);
    const maxLev = Number(m.config.max_leverage);
    const idx = positiveOrNull(m.index_price);
    out.push({
      venue: "risex",
      venueSymbol: m.market_id,
      symbol,
      canonical: canonicalFor("risex", symbol, assetClass),
      assetClass,
      settle: "USDC",
      quoteAsset: "USDC",
      markPrice: mark,
      indexPrice: idx,
      fundingRate: risexHourlyFunding(m),
      fundingRateBasis: RISEX_FUNDING_BASIS,
      settlementIntervalHours: 1,
      // Base units [inferred: BTC open_interest ≈ 204 vs config.open_interest_limit 750 — contracts,
      // not USD; the docs do not state the unit], as Hyperliquid publishes it.
      openInterest: decOrNull(m.open_interest),
      volume24h: decOrNull(m.quote_volume_24h),
      tickSize: decOrNull(m.config.step_price),
      stepSize: decOrNull(m.config.step_size),
      minSize: decOrNull(m.config.min_order_size),
      minNotional: null,
      maxLeverage: Number.isInteger(maxLev) && maxLev > 0 ? maxLev : null,
      marginTiers: null,
      session: null,
      tradable: m.active && m.config.unlocked === true && !m.reduce_only,
    });
  }
  return out;
}

export function toRisexFundingRates(raw: readonly RisexRawMarket[], markets: readonly VenueMarket[]): VenueFundingRate[] {
  const byId = new Map(raw.map(r => [r.market_id, r]));
  const out: VenueFundingRate[] = [];
  for (const m of markets) {
    if (m.fundingRate === null) continue;
    const r = byId.get(m.venueSymbol);
    out.push({
      venue: "risex",
      venueSymbol: m.venueSymbol,
      symbol: m.symbol,
      canonical: m.canonical,
      rate: m.fundingRate,
      basis: RISEX_FUNDING_BASIS,
      markPrice: m.markPrice,
      nextFundingTime: r === undefined ? null : nsToMsOrNull(r.next_funding_time),
    });
  }
  return out;
}

const warnStderr = (msg: string) => { process.stderr.write(`${msg}\n`); };

export const risexPublicData: VenuePublicData = {
  async fetchMarkets(net) {
    return toRisexVenueMarkets(await fetchRisexRawMarkets(risexClient(net)), warnStderr);
  },
  async fetchFundingRates(net) {
    const raw = await fetchRisexRawMarkets(risexClient(net));
    return toRisexFundingRates(raw, toRisexVenueMarkets(raw, warnStderr));
  },
};
