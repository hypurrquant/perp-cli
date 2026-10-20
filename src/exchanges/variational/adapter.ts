/**
 * Variational public-only adapter — OFFICIAL read-only API (venues/variational.ts).
 *
 * Markets, current funding terms and the OLP's indicative RFQ quotes come from the one stats
 * payload (variational/public.ts). Variational is an RFQ venue with a single maker, so there is no
 * order book, trade tape or candle feed in the API: getOrderbook / getRecentTrades / getKlines /
 * getFundingHistory refuse with CAPABILITY_UNSUPPORTED (with the command that does work), and every
 * account / trading method refuses before any request.
 */

import type {
  CurrentFundingTerms, RfqQuotes,
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
  FundingHistoryRow
} from "../interface.js";
import { unsupported } from "../trading-v2.js";
import { roleUnsupported, type VenueDefinition } from "../venue.js";
import { rateToHourly, type Network } from "../venue-types.js";
import { annualizeHourlyRate } from "../../funding/normalize.js";
import {
  currentPerpRate, fetchVariationalListings, fundingBasisOf, resolveVariationalListing,
  type VariationalListing, type VariationalSwapRate,
} from "./public.js";

/** Legacy market row plus the Variational-only fields every row carries in JSON output. */
export type VariationalMarketInfo = ExchangeMarketInfo & {
  venueApi: "official";
  ticker: string;
  contractType: "perpetual" | "swap";
  name: string | null;
  /** "predicted" for a perpetual with a rate; null otherwise. */
  fundingRateKind: "predicted" | null;
  nextFundingTime: number | null;
  /** USDC, single-sided (trader positions only; the OLP is the counterparty). */
  openInterestUsd: { long: string; short: string };
  swapFunding: { last: VariationalSwapRate | null; next: VariationalSwapRate | null } | null;
};

const RFQ_NOTE = "Variational is an RFQ venue: the single market maker (OLP) quotes every trade. These are its INDICATIVE quotes at fixed notionals (may be cached up to 600 s), not order-book levels; the executed price is a firm quote at submit time.";

export class VariationalPublicAdapter implements ExchangeAdapter {
  readonly name = "variational" as const;
  readonly aliases = ["var", "omni"] as const;

  constructor(readonly venue: VenueDefinition, readonly network: Network) {}

  private warn(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }

  private async listing(symbol: string): Promise<VariationalListing> {
    return resolveVariationalListing(await fetchVariationalListings(this.network), symbol);
  }

  // ── Market data ──

  async getMarkets(): Promise<VariationalMarketInfo[]> {
    return (await fetchVariationalListings(this.network)).map(l => {
      const rate = currentPerpRate(l, m => this.warn(m));
      const f = l.funding;
      return {
        symbol: l.symbol,
        markPrice: l.markPrice,
        indexPrice: null,
        fundingRate: rate,
        volume24h: l.volume24h,
        // Base-unit OI is not published (USD, single-sided only — see openInterestUsd).
        openInterest: null,
        maxLeverage: null,
        sizeDecimals: null,
        stepSize: null,
        fundingHours: f === null ? null : f.intervalSeconds / 3600,
        marginTiers: null,
        venueApi: "official",
        ticker: l.ticker,
        contractType: l.contractType,
        name: l.name,
        fundingRateKind: rate === null ? null : "predicted",
        nextFundingTime: f === null ? null : f.nextFundingTime,
        openInterestUsd: { long: l.longOpenInterestUsd, short: l.shortOpenInterestUsd },
        swapFunding: f !== null && f.kind === "swap" ? { last: f.last, next: f.next } : null,
      };
    });
  }

  /** Current funding terms of one market (the API publishes no funding history). */
  async getFundingTerms(symbol: string): Promise<CurrentFundingTerms> {
    const l = await this.listing(symbol);
    const f = l.funding;
    const rate = currentPerpRate(l, m => this.warn(m));
    const base = { kind: "currentFunding" as const, venue: "variational" as const, symbol: l.symbol, ticker: l.ticker, contractType: l.contractType };
    if (f === null) {
      return { ...base, rateKind: null, intervalRate: null, intervalHours: null, hourlyRate: null, annualizedPct: null, venueAnnualizedRate: null, nextFundingTime: null, swap: null, note: "Variational publishes no funding terms for this market right now" };
    }
    const intervalHours = f.intervalSeconds / 3600;
    if (f.kind === "swap") {
      return {
        ...base, rateKind: null, intervalRate: null, intervalHours, hourlyRate: null, annualizedPct: null, venueAnnualizedRate: null,
        nextFundingTime: f.nextFundingTime, swap: { last: f.last, next: f.next },
        note: "Swap: separate long / short rates paid once per trading day (positive long rate = longs pay, positive short rate = shorts receive); no single funding rate",
      };
    }
    const hourlyRate = rate === null ? null : rateToHourly(Number(rate), fundingBasisOf(f));
    return {
      ...base,
      rateKind: rate === null ? null : "predicted",
      intervalRate: rate,
      intervalHours,
      hourlyRate,
      annualizedPct: hourlyRate === null ? null : annualizeHourlyRate(hourlyRate),
      venueAnnualizedRate: f.last.annualized,
      nextFundingTime: f.nextFundingTime,
      swap: null,
      note: rate === null
        ? "The published interval and annualized rates disagree; funding is not shown"
        : `Current (predicted) rate for the ${intervalHours}h window ending at nextFundingTime; positive = longs pay. Variational publishes no funding history`,
    };
  }

  /** The OLP's indicative RFQ quotes (Variational has no order book). */
  async getRfqQuotes(symbol: string): Promise<RfqQuotes> {
    const l = await this.listing(symbol);
    return {
      kind: "rfqQuotes",
      venue: "variational",
      symbol: l.symbol,
      ticker: l.ticker,
      markPrice: l.markPrice,
      updatedAt: l.quotes === null ? null : l.quotes.updatedAt,
      baseSpreadBps: l.baseSpreadBps,
      quotes: l.quotes === null ? [] : l.quotes.tiers,
      note: RFQ_NOTE,
    };
  }

  async getOrderbook(): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    throw unsupported("variational", "orderbook", "Variational is an RFQ venue with a single market maker (OLP); there is no order book",
      "See the OLP's indicative RFQ quotes at fixed notionals: perp -e variational market book <symbol>");
  }

  async getRecentTrades(): Promise<ExchangePublicTrade[]> {
    throw unsupported("variational", "recentTrades", "Variational's public API publishes no trade tape",
      "Market stats (24h volume, open interest): perp -e variational market info <symbol>");
  }

  async getFundingHistory(): Promise<FundingHistoryRow[]> {
    throw unsupported("variational", "fundingHistory", "Variational's public API publishes no funding history",
      "Current funding terms: perp -e variational market funding <symbol>, or perp arb scan --rates");
  }

  async getKlines(): Promise<ExchangeKline[]> {
    throw unsupported("variational", "klines", "Variational's public API publishes no candles",
      "Current mark price: perp -e variational market info <symbol>");
  }

  // ── Account / trading: refused (market-data-only venue, no public trading API) ──

  private refuse(feature: string): never {
    throw roleUnsupported(this.venue, feature);
  }

  async getBalance(): Promise<ExchangeBalance> { return this.refuse("account"); }
  async getPositions(): Promise<ExchangePosition[]> { return this.refuse("account"); }
  async getOpenOrders(): Promise<ExchangeOrder[]> { return this.refuse("account"); }
  async getOrderHistory(): Promise<ExchangeOrder[]> { return this.refuse("account"); }
  async getTradeHistory(): Promise<ExchangeTrade[]> { return this.refuse("account"); }
  async getFundingPayments(): Promise<ExchangeFundingPayment[]> { return this.refuse("account"); }
  async marketOrder(): Promise<unknown> { return this.refuse("trading"); }
  async limitOrder(): Promise<unknown> { return this.refuse("trading"); }
  async editOrder(): Promise<unknown> { return this.refuse("trading"); }
  async cancelOrder(): Promise<unknown> { return this.refuse("trading"); }
  async cancelAllOrders(): Promise<unknown> { return this.refuse("trading"); }
  async setLeverage(): Promise<unknown> { return this.refuse("trading"); }
  async stopOrder(): Promise<unknown> { return this.refuse("trading"); }
}
