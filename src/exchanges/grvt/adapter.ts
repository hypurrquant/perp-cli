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
  fetchGrvtMarket, fetchGrvtMarkets, grvtClient, grvtDirectory, resolveGrvtMarket,
  type GrvtMarketMeta, type GrvtVenueMarket,
} from "./public.js";

/** perp-cli interval → GRVT CandlestickInterval (api-docs.grvt.io/schemas/candlestick_interval). */
export const GRVT_KLINE_INTERVALS: Readonly<Record<string, string>> = {
  "1m": "CI_1_M", "3m": "CI_3_M", "5m": "CI_5_M", "15m": "CI_15_M", "30m": "CI_30_M",
  "1h": "CI_1_H", "2h": "CI_2_H", "4h": "CI_4_H", "6h": "CI_6_H", "8h": "CI_8_H", "12h": "CI_12_H",
  "1d": "CI_1_D", "3d": "CI_3_D", "5d": "CI_5_D", "1w": "CI_1_W", "2w": "CI_2_W", "3w": "CI_3_W", "4w": "CI_4_W",
};

/** Fixed-length intervals (ms): `start_time` is floored to their boundary (epoch-aligned, UTC). */
const GRVT_KLINE_FIXED_MS: Readonly<Record<string, number>> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
  "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000,
};
const GRVT_KLINE_NOMINAL_MS: Readonly<Record<string, number>> = {
  ...GRVT_KLINE_FIXED_MS, "3d": 259_200_000, "5d": 432_000_000, "1w": 604_800_000, "2w": 1_209_600_000, "3w": 1_814_400_000, "4w": 2_419_200_000,
};

/**
 * Bars per kline page (the documented max) and the most pages one read may take. The `next`
 * cursor runs dry after ~1000 bars (live 2026-10-19: page 2 had 2 rows and `next` ""), so pages
 * walk `end_time` back to just before the oldest bar returned instead.
 */
export const GRVT_KLINE_PAGE = 1000;
/**
 * Pages actually read before giving up. Real pages hold fewer than 1000 bars (minutes without a
 * bar: 40 d of 1m took 58 pages for 57,583 bars), so the read budget is 25 % above the nominal
 * GRVT_KLINE_MAX_PAGES. 75 requests stay well inside GRVT's 500 market-data requests / minute.
 */
export const GRVT_KLINE_READ_PAGES = 75;
/** Measured live 2026-10-19: /trade answers at most 1000 rows (limit 1500 → 1000, no cursor). */
export const GRVT_TRADES_CAP = 1000;
/** Measured live 2026-10-19: /funding honours limit 10,000 in one answer (BTC). */
export const GRVT_FUNDING_CAP = 10_000;
export const GRVT_KLINE_MAX_PAGES = 60;

const WARN = (msg: string) => { process.stderr.write(`${msg}\n`); };

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
  /** When maxLeverage / marginTiers were read (ISO, possibly from the 6 h cache); null = not read. */
  leverageAsOf: string | null;
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
    leverageAsOf: m.leverageAsOf,
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

  constructor(readonly venue: VenueDefinition, readonly network: Network) {
    this.client = grvtClient(network);
  }

  private async market(symbol: string): Promise<GrvtMarketMeta> {
    return resolveGrvtMarket(await grvtDirectory(this.client, this.network, WARN), symbol);
  }

  // ── Market data ──

  /** Every market with leverage (`market list`): margin_rules come from the 6 h file cache. */
  async getVenueMarkets(): Promise<GrvtVenueMarket[]> {
    return fetchGrvtMarkets(this.network, { leverage: true });
  }

  async getMarkets(): Promise<GrvtMarketInfo[]> {
    return (await this.getVenueMarkets()).map(toGrvtMarketInfo);
  }

  /** One market (`market info`): the directory, its ticker and its margin rules — no fan-out. */
  async getMarketInfo(symbol: string): Promise<GrvtMarketInfo> {
    return toGrvtMarketInfo(await fetchGrvtMarket(this.network, symbol));
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
    // GRVT serves 10 / 50 / 100 / 500 levels: return exactly the `depth` requested.
    return { bids: side(res.bids.slice(0, depth), "bid"), asks: side(res.asks.slice(0, depth), "ask") };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<ExchangePublicTrade[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > GRVT_TRADES_CAP) {
      throw new PerpError("INVALID_PARAMS", `GRVT: trades limit must be 1..${GRVT_TRADES_CAP} (got ${limit})`, {
        remediation: `GRVT serves at most ${GRVT_TRADES_CAP} recent trades per request and no cursor for older ones`,
      });
    }
    const m = await this.market(symbol);
    const res = await this.client.result<unknown>("trade", { instrument: m.instrument, limit });
    if (!Array.isArray(res)) throw grvtShapeError("trade result is not an array");
    // The venue answers oldest first; every venue's tape is newest first.
    return res.map(t => {
      const x = t as { is_taker_buyer?: unknown; price?: unknown; size?: unknown; event_time?: unknown };
      if (typeof x.is_taker_buyer !== "boolean") throw grvtShapeError("trade without is_taker_buyer");
      return {
        time: nsToMs(x.event_time, "trade event_time"),
        symbol: m.symbol,
        side: x.is_taker_buyer ? "buy" as const : "sell" as const,
        price: dec(x.price, "trade price"),
        size: dec(x.size, "trade size"),
        fee: null,
      };
    }).sort((a, b) => b.time - a.time);
  }

  /**
   * Settled funding (/full/v1/funding, one record per funding interval, newest first). `rate` is a
   * fraction per the record's `intervalHours` (published in percentage points, converted exactly).
   */
  async getFundingHistory(symbol: string, limit = 100): Promise<GrvtFundingHistoryRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > GRVT_FUNDING_CAP) {
      throw new PerpError("INVALID_PARAMS", `GRVT: funding history limit must be 1..${GRVT_FUNDING_CAP} (got ${limit})`);
    }
    const m = await this.market(symbol);
    // Sent as asked (it was silently clamped to 1000; the venue serves 10,000 in one answer).
    const res = await this.client.result<unknown>("funding", { instrument: m.instrument, limit });
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
    if (!(endTime > startTime)) throw new PerpError("INVALID_PARAMS", "GRVT: candle end time must be after the start time");
    const fixed = GRVT_KLINE_FIXED_MS[interval];
    // An off-grid start_time makes GRVT answer a truncated first bar labelled off the grid
    // (live: 4h from 05:07 → a 06:00–08:00 bar), so the start is floored to the boundary.
    const start = fixed === undefined ? startTime : Math.floor(startTime / fixed) * fixed;
    const pagesNeeded = Math.ceil((endTime - start) / GRVT_KLINE_NOMINAL_MS[interval] / GRVT_KLINE_PAGE);
    if (pagesNeeded > GRVT_KLINE_MAX_PAGES) {
      throw new PerpError("INVALID_PARAMS", `GRVT: ${interval} candles over this range need ${pagesNeeded} requests (max ${GRVT_KLINE_MAX_PAGES})`, {
        remediation: "Narrow --start / --end or use a longer interval",
      });
    }
    const m = await this.market(symbol);
    // Reverse-chronological pages of up to 1000 bars; the next page ends just before the oldest
    // bar returned. Done when a page is empty or reaches `start` — never on the cursor alone.
    const byOpen = new Map<string, Record<string, unknown>>();
    let end = endTime;
    let oldestSeen = Infinity;
    let exhausted = false;
    for (let page = 0; page < GRVT_KLINE_READ_PAGES; page++) {
      const res = await this.client.post<{ result?: unknown; next?: unknown }>("kline", {
        instrument: m.instrument, interval: ci, type: "TRADE", start_time: msToNs(start), end_time: msToNs(end), limit: GRVT_KLINE_PAGE,
      });
      if (res === null || typeof res !== "object" || !Array.isArray(res.result)) throw grvtShapeError("kline result is not an array");
      if (res.result.length === 0) { exhausted = true; break; } // no older bars: history starts here
      let oldest = Infinity;
      for (const c of res.result as Record<string, unknown>[]) {
        const t = nsToMs(c.open_time, "kline open_time");
        byOpen.set(String(c.open_time), c);
        if (t < oldest) oldest = t;
      }
      if (oldest >= oldestSeen) {
        throw new PerpError("EXCHANGE_ERROR", `GRVT: kline page did not move back past ${new Date(oldestSeen).toISOString()} (venue answered bars outside end_time)`, { exchange: "grvt" });
      }
      oldestSeen = oldest;
      if (oldest <= start) break;
      end = oldest - 1;
    }
    // Ran out of the read budget before reaching `start`: the oldest bars would be missing — never
    // returned as the whole range.
    if (!exhausted && oldestSeen > start) {
      throw new PerpError("EXCHANGE_ERROR", `GRVT: ${interval} candles reached only ${new Date(oldestSeen).toISOString()} after ${GRVT_KLINE_READ_PAGES} pages (requested from ${new Date(start).toISOString()})`, {
        exchange: "grvt", reachedMs: oldestSeen, requestedFromMs: start,
        remediation: `Narrow --start / --end (or use a longer interval); fetch older bars with --end ${oldestSeen - 1}`,
      });
    }
    const rows = [...byOpen.values()];
    const bars = rows.map(c => {
      const x = c as Record<string, unknown>;
      return {
        time: nsToMs(x.open_time, "kline open_time"),
        open: dec(x.open, "kline open"), high: dec(x.high, "kline high"), low: dec(x.low, "kline low"), close: dec(x.close, "kline close"),
        volume: dec(x.volume_b, "kline volume_b"),
        quoteVolume: typeof x.volume_q === "string" && DEC.test(x.volume_q) ? x.volume_q : null,
        trades: typeof x.trades === "number" ? x.trades : null,
        closeMs: nsToMs(x.close_time, "kline close_time"),
      };
    }).sort((a, b) => a.time - b.time);
    // Calendar intervals (3d … 4w) are not floored: a first bar shorter than the interval is a
    // truncated bar (live: the first 1w bar covered 4 days) and is left out. The newest bar may be
    // in progress and is kept.
    const nominal = GRVT_KLINE_NOMINAL_MS[interval];
    const full = fixed === undefined && bars.length > 1 && bars[0].closeMs - bars[0].time + 1 < nominal * 0.99 ? bars.slice(1) : bars;
    return full.map(({ closeMs: _c, ...k }) => k);
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
