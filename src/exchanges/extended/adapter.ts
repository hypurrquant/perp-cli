/**
 * Extended public-only adapter — official API, MARKET DATA ONLY in this version (venues/extended.ts).
 *
 * Market data (markets, orderbook, trades, funding history, candles) is implemented with the
 * documented public endpoints (https://api.docs.extended.exchange/ "Public REST-API"). Every
 * account / trading method refuses with CAPABILITY_UNSUPPORTED before any request — there is no
 * Extended account, order or signing code.
 *
 * A symbol is resolved first (resolveExtendedMarketRemote: `?market=<name>` reads, the full listing
 * only when no wire-name candidate matches), so an unlisted symbol is SYMBOL_NOT_FOUND before any
 * per-market request (the orderbook of an unknown market answers `{"status":"OK"}` without data,
 * its trades `[]` — live 2026-10-19).
 */

import { PerpError } from "../../errors.js";
import { annualizeHourlyRate } from "../../funding/normalize.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
} from "../interface.js";
import { roleUnsupported, type VenueDefinition } from "../venue.js";
import { toLegacyMarketInfo, type AssetClass, type Network } from "../venue-types.js";
import { extendedShapeError, type ExtendedClient } from "./client.js";
import { extendedClient, fetchExtendedMarketRows, resolveExtendedMarketRemote, type ExtendedMarketMeta } from "./public.js";

/** CLI candle interval → Extended ISO-8601 duration (docs "Get candles history" / candles stream). */
export const EXTENDED_KLINE_INTERVALS: Readonly<Record<string, { wire: string; ms: number }>> = {
  "1m": { wire: "PT1M", ms: 60_000 },
  "5m": { wire: "PT5M", ms: 300_000 },
  "15m": { wire: "PT15M", ms: 900_000 },
  "30m": { wire: "PT30M", ms: 1_800_000 },
  "1h": { wire: "PT1H", ms: 3_600_000 },
  "2h": { wire: "PT2H", ms: 7_200_000 },
  "4h": { wire: "PT4H", ms: 14_400_000 },
  "8h": { wire: "PT8H", ms: 28_800_000 },
  "12h": { wire: "PT12H", ms: 43_200_000 },
  "1d": { wire: "PT24H", ms: 86_400_000 },
  "1w": { wire: "P7D", ms: 604_800_000 },
  // P30D answers calendar-month candles (live 2026-10-19: opens on the 1st, 00:00 UTC); ms is
  // the nominal 30 d used only to size requests.
  "1M": { wire: "P30D", ms: 2_592_000_000 },
};

/** Documented per-request maximum of the candles and funding-history endpoints (accepted `limit`). */
export const EXTENDED_MAX_RECORDS = 10_000;
/**
 * Real server caps, measured live 2026-10-19 (BTC-USD; no pagination field, no error): candles
 * return at most 2800 rows (PT1M / PT5M; PT24H answered 816 = the whole history), funding
 * history at most 1000 (the newest). Both page backwards with `endTime` = before the oldest row.
 * A page with exactly the cap is never taken as the end.
 */
export const EXTENDED_CANDLES_PAGE_CAP = 2800;
export const EXTENDED_FUNDING_PAGE_CAP = 1000;
const EXTENDED_MAX_PAGES = 50;
export const EXTENDED_TRADES_CAP = 50;

/** Legacy market row plus the Extended fields shown in JSON (asset class, precision, schedule). */
export type ExtendedMarketInfo = ExchangeMarketInfo & {
  venueSymbol: string;
  canonical: string | null;
  assetClass: AssetClass;
  tickSize: string;
  minSize: string;
  tradable: boolean;
  status: "ACTIVE" | "REDUCE_ONLY";
  isRfq: boolean;
  tradingHours: string;
  isOffHours: boolean;
  /** `fundingRate` is the current hour's accruing rate (fraction per hour), applied at nextFundingTime. */
  fundingRateKind: "accruing";
  nextFundingTime: number | null;
};

/** One applied hourly funding print (fraction per hour) with its normalization. */
export interface ExtendedFundingPrint {
  time: number;
  rate: string;
  price: null;
  rateKind: "lastSettled";
  intervalHours: 1;
  /** rate × 24 × 365 × 100 (APR %, simple). */
  annualizedPct: number;
}

const DEC = /^-?\d+(\.\d+)?$/;

function dec(v: unknown, what: string): string {
  if (typeof v !== "string" || !DEC.test(v)) throw extendedShapeError(`${what} is not a decimal string`);
  return v;
}

function ms(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw extendedShapeError(`${what} is not a ms timestamp`);
  return v;
}

export class ExtendedPublicAdapter implements ExchangeAdapter {
  readonly name = "extended" as const;
  readonly aliases = ["ext", "x10"] as const;
  private readonly client: ExtendedClient;

  constructor(readonly venue: VenueDefinition, readonly network: Network) {
    this.client = extendedClient(network);
  }

  /** Per-market reads resolve the symbol with the small `?market=` read (public.ts), not the full listing. */
  private async market(symbol: string): Promise<ExtendedMarketMeta> {
    return resolveExtendedMarketRemote(this.client, symbol);
  }

  // ── Market data ──

  async getMarkets(): Promise<ExtendedMarketInfo[]> {
    const rows = await fetchExtendedMarketRows(this.client);
    return rows.map(({ meta, market, nextFundingTime }) => ({
      ...toLegacyMarketInfo(market),
      venueSymbol: market.venueSymbol,
      canonical: market.canonical,
      assetClass: market.assetClass,
      tickSize: market.tickSize as string,
      minSize: market.minSize as string,
      tradable: market.tradable,
      status: meta.status,
      isRfq: meta.isRfq,
      tradingHours: meta.tradingHours,
      isOffHours: meta.isOffHours,
      fundingRateKind: "accruing",
      nextFundingTime,
    }));
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const m = await this.market(symbol);
    const body = await this.client.get<{ bid?: unknown; ask?: unknown }>(`/info/markets/${encodeURIComponent(m.name)}/orderbook`);
    const data = body.data;
    if (data === undefined || data === null || !Array.isArray(data.bid) || !Array.isArray(data.ask)) {
      throw extendedShapeError(`orderbook of ${m.name} has no bid / ask lists`);
    }
    const side = (rows: unknown[], what: string): [string, string][] => rows.map(r => {
      const x = r as { price?: unknown; qty?: unknown };
      return [dec(x.price, `${what} price`), dec(x.qty, `${what} qty`)];
    });
    return { bids: side(data.bid, "orderbook bid"), asks: side(data.ask, "orderbook ask") };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<ExchangePublicTrade[]> {
    // The endpoint takes no limit and answers the last 50 trades (live 2026-10-19, `limit=500` → 50).
    if (!Number.isInteger(limit) || limit < 1 || limit > EXTENDED_TRADES_CAP) {
      throw new PerpError("INVALID_PARAMS", `Extended: trades limit must be 1..${EXTENDED_TRADES_CAP} (got ${limit})`, { remediation: `Extended publishes only the last ${EXTENDED_TRADES_CAP} trades` });
    }
    const m = await this.market(symbol);
    const body = await this.client.get<unknown>(`/info/markets/${encodeURIComponent(m.name)}/trades`);
    if (!Array.isArray(body.data)) throw extendedShapeError(`trades of ${m.name} is not a list`);
    const trades = body.data.map(t => {
      const x = t as { S?: unknown; T?: unknown; p?: unknown; q?: unknown };
      if (x.S !== "BUY" && x.S !== "SELL") throw extendedShapeError(`trade side ${String(x.S)}`);
      // Public tape carries no fee.
      return { time: ms(x.T, "trade T"), symbol: m.symbol, side: x.S === "BUY" ? "buy" as const : "sell" as const, price: dec(x.p, "trade p"), size: dec(x.q, "trade q"), fee: null };
    });
    // Newest first, like every other venue's tape.
    return trades.sort((a, b) => b.time - a.time).slice(0, limit);
  }

  /**
   * Applied (settled) hourly rates, newest first — fraction per hour; no oracle price published.
   * Paged backwards in pages of EXTENDED_FUNDING_PAGE_CAP until `limit` rows or the window start.
   */
  async getFundingHistory(symbol: string, limit = 10): Promise<ExtendedFundingPrint[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > EXTENDED_MAX_RECORDS) {
      throw new PerpError("INVALID_PARAMS", `Extended: funding history limit must be 1..${EXTENDED_MAX_RECORDS} (got ${limit})`);
    }
    const m = await this.market(symbol);
    const end = Date.now();
    // One record per hour; two spare hours cover the in-progress hour and clock skew.
    const start = end - (limit + 2) * 3_600_000;
    const byTime = new Map<number, ExtendedFundingPrint>();
    let cursor = end;
    for (let page = 0; byTime.size < limit; page++) {
      if (page >= EXTENDED_MAX_PAGES) throw new PerpError("EXCHANGE_ERROR", `Extended: funding history of ${m.name} did not end after ${EXTENDED_MAX_PAGES} pages`);
      const want = Math.min(EXTENDED_FUNDING_PAGE_CAP, limit - byTime.size);
      const body = await this.client.get<unknown>(`/info/${encodeURIComponent(m.name)}/funding`, [
        ["startTime", String(start)], ["endTime", String(cursor)], ["limit", String(want)],
      ]);
      if (!Array.isArray(body.data)) throw extendedShapeError(`funding history of ${m.name} is not a list`);
      const rows = body.data.map(r => {
        const x = r as { T?: unknown; f?: unknown };
        const rate = dec(x.f, "funding f");
        return { time: ms(x.T, "funding T"), rate, price: null, rateKind: "lastSettled" as const, intervalHours: 1 as const, annualizedPct: annualizeHourlyRate(Number(rate)) };
      });
      for (const r of rows) byTime.set(r.time, r);
      // Fewer rows than asked (and below the cap) = the window is exhausted.
      if (rows.length < want || rows.length === 0) break;
      const oldest = Math.min(...rows.map(r => r.time));
      if (oldest <= start) break;
      cursor = oldest - 1;
    }
    return [...byTime.values()].sort((a, b) => b.time - a.time).slice(0, limit);
  }

  /** Candles paged backwards from `endTime` in pages of EXTENDED_CANDLES_PAGE_CAP (newest first on the wire). */
  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const iv = Object.prototype.hasOwnProperty.call(EXTENDED_KLINE_INTERVALS, interval) ? EXTENDED_KLINE_INTERVALS[interval] : undefined;
    if (iv === undefined) {
      throw new PerpError("INVALID_PARAMS", `Extended: unsupported candle interval "${interval}"`, {
        remediation: `Use one of: ${Object.keys(EXTENDED_KLINE_INTERVALS).join(", ")}`,
      });
    }
    if (!(endTime > startTime)) throw new PerpError("INVALID_PARAMS", "Extended: candle end time must be after the start time");
    const bars = Math.ceil((endTime - startTime) / iv.ms) + 1;
    const pages = Math.ceil(bars / EXTENDED_CANDLES_PAGE_CAP);
    if (pages > EXTENDED_MAX_PAGES) {
      throw new PerpError("INVALID_PARAMS", `Extended: ${interval} candles over this range need ${pages} requests (max ${EXTENDED_MAX_PAGES})`, {
        remediation: "Narrow --start / --end or use a longer interval",
      });
    }
    const m = await this.market(symbol);
    const byTime = new Map<number, ExchangeKline>();
    // `endTime` is exclusive on the wire (a bar opening exactly at it is not returned): +1 ms makes
    // `--end` inclusive like every other venue.
    let cursor = endTime + 1;
    for (let page = 0; page < EXTENDED_MAX_PAGES + 1; page++) {
      const want = Math.min(EXTENDED_CANDLES_PAGE_CAP, Math.ceil((cursor - startTime) / iv.ms) + 1);
      const body = await this.client.get<unknown>(`/info/candles/${encodeURIComponent(m.name)}/trades`, [
        ["interval", iv.wire], ["limit", String(want)], ["endTime", String(cursor)],
      ]);
      if (!Array.isArray(body.data)) throw extendedShapeError(`candles of ${m.name} is not a list`);
      const rows = body.data.map(c => {
        const x = c as Record<string, unknown>;
        return {
          time: ms(x.T, "candle T"),
          open: dec(x.o, "candle o"), high: dec(x.h, "candle h"), low: dec(x.l, "candle l"), close: dec(x.c, "candle c"),
          volume: dec(x.v, "candle v"),
          quoteVolume: null,
          trades: null,
        };
      });
      for (const k of rows) if (k.time >= startTime && k.time <= endTime) byTime.set(k.time, k);
      // A short page means the venue has no older candles; a full page (= the cap) always pages on.
      if (rows.length < want || rows.length === 0) break;
      const oldest = Math.min(...rows.map(k => k.time));
      if (oldest <= startTime) break;
      cursor = oldest - 1;
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  // ── Account / trading: refused (market data only in this version) ──

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
