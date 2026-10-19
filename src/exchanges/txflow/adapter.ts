/**
 * TxFlow public-only adapter — UNOFFICIAL read-only API (see venues/txflow.ts).
 *
 * Market data (markets, orderbook, trades, klines) is implemented. Funding history is not
 * readable (the unofficial API refuses it) and every account / trading method refuses with
 * CAPABILITY_UNSUPPORTED before any request — there is no TxFlow account or order code.
 */

import { PerpError } from "../../errors.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
  FundingHistoryRow
} from "../interface.js";
import { assertCandleInterval } from "../interface.js";
import { unsupported } from "../trading-v2.js";
import { roleUnsupported, networkConfig, type VenueDefinition } from "../venue.js";
import { toLegacyMarketInfo, type Network, type VenueMarket } from "../venue-types.js";
import { txflowShapeError, TxflowClient } from "./client.js";
import { fetchTxflowDirectory, fetchTxflowMarkets, resolveTxflowMarket, type TxflowMarketMeta } from "./public.js";

/**
 * Candle intervals that return bars (verified live 2026-10-19, coin 1). 3d / 1w / 1M are
 * accepted by the API but answer [] for every window, so they are not offered.
 */
export const TXFLOW_KLINE_MS: Readonly<Record<string, number>> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
  "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000,
};
export const TXFLOW_KLINE_INTERVALS: ReadonlySet<string> = new Set(Object.keys(TXFLOW_KLINE_MS));
/**
 * candleSnapshot answers `200 []` (no error) when the window spans more than ~3000 bars
 * (measured 2026-10-19: 3000 bars OK, 3050 → [] at 1h; same at 1m / 5m / 1d), so ranges are
 * read in windows of at most 2900 bars and merged.
 */
export const TXFLOW_KLINE_WINDOW_BARS = 2900;
export const TXFLOW_KLINE_MAX_WINDOWS = 50;

/** Legacy market row plus the labels every TxFlow row carries in JSON output. */
export type TxflowMarketInfo = ExchangeMarketInfo & { venueApi: "unofficial"; fundingVerified: false };

function dec(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v)) throw txflowShapeError(`${what} is not a decimal string`);
  return v;
}

export class TxflowPublicAdapter implements ExchangeAdapter {
  readonly name = "txflow" as const;
  readonly aliases = ["txf"] as const;
  private readonly client: TxflowClient;
  private dir: Promise<TxflowMarketMeta[]> | null = null;

  constructor(readonly venue: VenueDefinition, readonly network: Network) {
    this.client = new TxflowClient(networkConfig(venue, network).restUrl, venue.rateLimit);
  }

  private async market(symbol: string): Promise<TxflowMarketMeta> {
    if (this.dir === null) {
      this.dir = fetchTxflowDirectory(this.client);
      this.dir.catch(() => { this.dir = null; });
    }
    return resolveTxflowMarket(await this.dir, symbol);
  }

  // ── Market data ──

  async getVenueMarkets(): Promise<VenueMarket[]> {
    return fetchTxflowMarkets(this.network);
  }

  async getMarkets(): Promise<TxflowMarketInfo[]> {
    return (await this.getVenueMarkets()).map(m => ({ ...toLegacyMarketInfo(m), venueApi: "unofficial", fundingVerified: false }));
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const m = await this.market(symbol);
    const res = await this.client.info<{ levels?: unknown }>({ type: "l2Book", coin: String(m.index) });
    const levels = res?.levels;
    if (!Array.isArray(levels) || levels.length !== 2 || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) {
      throw txflowShapeError("l2Book has no [bids, asks] levels");
    }
    const side = (rows: unknown[]): [string, string][] => rows.map(r => {
      const x = r as { px?: unknown; sz?: unknown };
      return [dec(x.px, "l2Book px"), dec(x.sz, "l2Book sz")];
    });
    return { bids: side(levels[0] as unknown[]), asks: side(levels[1] as unknown[]) };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<ExchangePublicTrade[]> {
    const m = await this.market(symbol);
    const res = await this.client.info<unknown>({ type: "trades", coin: String(m.index) });
    if (!Array.isArray(res)) throw txflowShapeError("trades is not an array");
    return res.slice(0, limit).map(t => {
      const x = t as { side?: unknown; px?: unknown; sz?: unknown; time?: unknown };
      if (x.side !== "B" && x.side !== "A") throw txflowShapeError(`trade side ${String(x.side)}`);
      if (typeof x.time !== "number") throw txflowShapeError("trade without time");
      // Public tape: no fee applies to the viewer → null (ExchangePublicTrade), never "0".
      return { time: x.time, symbol: m.symbol, side: x.side === "B" ? "buy" : "sell", price: dec(x.px, "trade px"), size: dec(x.sz, "trade sz"), fee: null };
    });
  }

  async getFundingHistory(): Promise<FundingHistoryRow[]> {
    throw unsupported("txflow", "fundingHistory", "TxFlow's unofficial API refuses funding-history reads (HTTP 403)",
      "Current TxFlow funding (unverified, per hour): perp -e txflow market info <symbol>, or perp arb scan --rates --include-unverified");
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const ms = TXFLOW_KLINE_MS[interval];
    if (ms === undefined) {
      throw new PerpError("INVALID_PARAMS", `TxFlow: unsupported candle interval "${interval}"`, {
        remediation: `Use one of: ${[...TXFLOW_KLINE_INTERVALS].join(", ")}`,
      });
    }
    const span = TXFLOW_KLINE_WINDOW_BARS * ms;
    const windows = Math.max(1, Math.ceil((endTime - startTime) / span));
    if (windows > TXFLOW_KLINE_MAX_WINDOWS) {
      throw new PerpError("INVALID_PARAMS", `TxFlow: ${interval} candles over this range need ${windows} requests (max ${TXFLOW_KLINE_MAX_WINDOWS})`, {
        remediation: "Narrow --start / --end or use a longer interval",
      });
    }
    const m = await this.market(symbol);
    const byTime = new Map<number, ExchangeKline>();
    // Disjoint windows [from, to), each within the venue's silent ~3000-bar cap; merged by open time.
    for (let from = startTime; ; from += span) {
      const to = Math.min(from + span, endTime);
      const res = await this.client.info<unknown>({ type: "candleSnapshot", req: { coin: String(m.index), interval, startTime: from, endTime: to } });
      if (!Array.isArray(res)) throw txflowShapeError("candleSnapshot is not an array");
      for (const c of res) {
        const x = c as Record<string, unknown>;
        if (typeof x.t !== "number") throw txflowShapeError("candle without t");
        assertCandleInterval("txflow", interval, x.i);
        byTime.set(x.t, {
          time: x.t,
          open: dec(x.o, "candle o"), high: dec(x.h, "candle h"), low: dec(x.l, "candle l"), close: dec(x.c, "candle c"),
          volume: dec(x.v, "candle v"),
          quoteVolume: null,
          trades: typeof x.n === "number" ? x.n : null,
        });
      }
      if (to >= endTime) break;
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }


  // ── Account / trading: refused (market-data-only venue, unofficial API) ──

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
