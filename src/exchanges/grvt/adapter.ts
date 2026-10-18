/**
 * GRVT public-only adapter — official Market Data API, read-only in this version (venues/grvt.ts).
 *
 * Market data (markets, orderbook, trades, funding history, klines) is implemented. Every account /
 * trading method refuses with CAPABILITY_UNSUPPORTED before any request — there is no GRVT account,
 * signing or order code. Unknown symbols are SYMBOL_NOT_FOUND from the instrument directory (GRVT
 * answers an unknown instrument with HTTP 400 "malformed syntax", so it is never asked).
 */

import { PerpError } from "../../errors.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
} from "../interface.js";
import { mulDecimal } from "../precision.js";
import { roleUnsupported, type VenueDefinition } from "../venue.js";
import type { Network } from "../venue-types.js";
import { grvtShapeError, type GrvtClient } from "./client.js";
import {
  fetchGrvtDirectory, fetchGrvtMarkets, grvtClient, resolveGrvtMarket,
  type GrvtMarketMeta, type GrvtVenueMarket,
} from "./public.js";

/** perp-cli interval → GRVT CandlestickInterval (api-docs.grvt.io/schemas/candlestick_interval). */
export const GRVT_KLINE_INTERVALS: Readonly<Record<string, string>> = {
  "1m": "CI_1_M", "3m": "CI_3_M", "5m": "CI_5_M", "15m": "CI_15_M", "30m": "CI_30_M",
  "1h": "CI_1_H", "2h": "CI_2_H", "4h": "CI_4_H", "6h": "CI_6_H", "8h": "CI_8_H", "12h": "CI_12_H",
  "1d": "CI_1_D", "3d": "CI_3_D", "5d": "CI_5_D", "1w": "CI_1_W", "2w": "CI_2_W", "3w": "CI_3_W", "4w": "CI_4_W",
};

/** Order book depths GRVT serves (api_orderbook_levels_request). */
export const GRVT_BOOK_DEPTHS = [10, 50, 100, 500] as const;

/**
 * Legacy market row plus GRVT's extra fields: last / best bid / best ask, minimum size / notional,
 * tick, next funding time, the funding interval, and the funding labels (`fundingRateKind`
 * "predicted" = the indicative rate of the active interval; fundingVerified false).
 */
export type GrvtMarketInfo = ExchangeMarketInfo & {
  venueSymbol: string;
  lastPrice: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  tickSize: string;
  minSize: string | null;
  minNotional: string | null;
  nextFundingTime: number | null;
  fundingRateKind: "predicted";
  fundingVerified: false;
};

/** A funding-history row: the SETTLED rate (fraction per `intervalHours`) at `time`. */
export type GrvtFundingHistoryRow = { time: number; rate: string; price: string | null; intervalHours: number; rateKind: "lastSettled" };

const DEC = /^-?\d+(\.\d+)?$/;

function dec(v: unknown, what: string): string {
  if (typeof v !== "string" || !DEC.test(v)) throw grvtShapeError(`${what} is not a decimal string`);
  return v;
}

function nsToMs(v: unknown, what: string): number {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw grvtShapeError(`${what} is not a nanosecond timestamp`);
  return Number(BigInt(v) / 1_000_000n);
}

function msToNs(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}

export function toGrvtMarketInfo(m: GrvtVenueMarket): GrvtMarketInfo {
  return {
    symbol: m.symbol,
    markPrice: m.markPrice,
    indexPrice: m.indexPrice,
    fundingRate: m.fundingRate,
    volume24h: m.volume24h,
    openInterest: m.openInterest,
    maxLeverage: m.maxLeverage,
    sizeDecimals: null,
    stepSize: m.stepSize,
    fundingHours: m.settlementIntervalHours,
    marginTiers: m.marginTiers,
    venueSymbol: m.venueSymbol,
    lastPrice: m.lastPrice,
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
    tickSize: m.tickSize,
    minSize: m.minSize,
    minNotional: m.minNotional,
    nextFundingTime: m.nextFundingTime,
    fundingRateKind: "predicted",
    fundingVerified: false,
  };
}

export class GrvtPublicAdapter implements ExchangeAdapter {
  readonly name = "grvt" as const;
  readonly aliases = ["grv"] as const;
  private readonly client: GrvtClient;
  private dir: Promise<GrvtMarketMeta[]> | null = null;

  constructor(readonly venue: VenueDefinition, readonly network: Network) {
    this.client = grvtClient(network);
  }

  private async market(symbol: string): Promise<GrvtMarketMeta> {
    if (this.dir === null) {
      this.dir = fetchGrvtDirectory(this.client, msg => process.stderr.write(`${msg}\n`));
      this.dir.catch(() => { this.dir = null; });
    }
    return resolveGrvtMarket(await this.dir, symbol);
  }

  // ── Market data ──

  async getVenueMarkets(): Promise<GrvtVenueMarket[]> {
    return fetchGrvtMarkets(this.network);
  }

  async getMarkets(): Promise<GrvtMarketInfo[]> {
    return (await this.getVenueMarkets()).map(toGrvtMarketInfo);
  }

  async getOrderbook(symbol: string, depth = 50): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const m = await this.market(symbol);
    // The smallest served depth that covers the request; above 500 levels, the deepest one (500).
    const d = GRVT_BOOK_DEPTHS.find(x => x >= depth) ?? 500;
    const res = await this.client.result<{ bids?: unknown; asks?: unknown }>("book", { instrument: m.instrument, depth: d });
    if (res === null || typeof res !== "object" || !Array.isArray(res.bids) || !Array.isArray(res.asks)) {
      throw grvtShapeError("book has no bids / asks arrays");
    }
    const side = (rows: unknown[], what: string): [string, string][] => rows.map(r => {
      const x = r as { price?: unknown; size?: unknown };
      return [dec(x.price, `${what} price`), dec(x.size, `${what} size`)];
    });
    return { bids: side(res.bids, "bid"), asks: side(res.asks, "ask") };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<ExchangePublicTrade[]> {
    const m = await this.market(symbol);
    const res = await this.client.result<unknown>("trade", { instrument: m.instrument, limit: Math.min(Math.max(1, limit), 1000) });
    if (!Array.isArray(res)) throw grvtShapeError("trade result is not an array");
    return res.map(t => {
      const x = t as { is_taker_buyer?: unknown; price?: unknown; size?: unknown; event_time?: unknown };
      if (typeof x.is_taker_buyer !== "boolean") throw grvtShapeError("trade without is_taker_buyer");
      return {
        time: nsToMs(x.event_time, "trade event_time"),
        symbol: m.symbol,
        side: x.is_taker_buyer ? "buy" : "sell",
        price: dec(x.price, "trade price"),
        size: dec(x.size, "trade size"),
        fee: null,
      };
    });
  }

  /**
   * Settled funding (/full/v1/funding, one record per funding interval, newest first). `rate` is a
   * fraction per the record's `intervalHours` (published in percentage points, converted exactly).
   */
  async getFundingHistory(symbol: string, limit = 100): Promise<GrvtFundingHistoryRow[]> {
    const m = await this.market(symbol);
    const res = await this.client.result<unknown>("funding", { instrument: m.instrument, limit: Math.min(Math.max(1, limit), 1000) });
    if (!Array.isArray(res)) throw grvtShapeError("funding result is not an array");
    return res.map(r => {
      const x = r as { funding_rate?: unknown; funding_time?: unknown; mark_price?: unknown; funding_interval_hours?: unknown };
      const fi = x.funding_interval_hours;
      if (typeof fi !== "number" || !Number.isInteger(fi) || fi <= 0) throw grvtShapeError("funding record without funding_interval_hours");
      const mark = typeof x.mark_price === "string" && DEC.test(x.mark_price) && Number(x.mark_price) > 0 ? x.mark_price : null;
      return {
        time: nsToMs(x.funding_time, "funding_time"),
        rate: mulDecimal(dec(x.funding_rate, "funding_rate"), "0.01"),
        price: mark,
        intervalHours: fi,
        rateKind: "lastSettled" as const,
      };
    });
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const ci = GRVT_KLINE_INTERVALS[interval];
    if (ci === undefined) {
      throw new PerpError("INVALID_PARAMS", `GRVT: unsupported candle interval "${interval}"`, {
        remediation: `Use one of: ${Object.keys(GRVT_KLINE_INTERVALS).join(", ")}`,
      });
    }
    const m = await this.market(symbol);
    const res = await this.client.result<unknown>("kline", {
      instrument: m.instrument, interval: ci, type: "TRADE", start_time: msToNs(startTime), end_time: msToNs(endTime), limit: 1000,
    });
    if (!Array.isArray(res)) throw grvtShapeError("kline result is not an array");
    return res.map(c => {
      const x = c as Record<string, unknown>;
      return {
        time: nsToMs(x.open_time, "kline open_time"),
        open: dec(x.open, "kline open"), high: dec(x.high, "kline high"), low: dec(x.low, "kline low"), close: dec(x.close, "kline close"),
        volume: dec(x.volume_b, "kline volume_b"),
        quoteVolume: typeof x.volume_q === "string" && DEC.test(x.volume_q) ? x.volume_q : null,
        trades: typeof x.trades === "number" ? x.trades : null,
      };
    }).sort((a, b) => a.time - b.time);
  }

  // ── Account / trading: refused (read-only in this version) ──

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
