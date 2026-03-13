/**
 * Unified market data feeds for CLI streaming commands.
 *
 * - Hyperliquid: native WebSocket (allMids, l2Book, trades, candle)
 * - Lighter: REST polling (no public market data WS)
 * - Pacifica: handled via existing PacificaWSClient in stream.ts
 */

import { EventEmitter } from "events";

export interface PriceUpdate { symbol: string; mid: number; funding?: number }
export interface BookUpdate { bids: [string, string][]; asks: [string, string][] }
export interface TradeUpdate { side: string; price: string; size: string; time: number }
export interface CandleUpdate { o: string; h: string; l: string; c: string; v: string; t: number }

// ── Hyperliquid Market Feed (native WebSocket) ──

export class HyperliquidMarketFeed extends EventEmitter {
  private ws: import("ws").WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subs: Array<Record<string, unknown>> = [];

  get wsUrl() { return "wss://api.hyperliquid.xyz/ws"; }

  async connect(): Promise<void> {
    const { WebSocket } = await import("ws");
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on("open", () => {
        // Re-subscribe on reconnect
        for (const sub of this.subs) this.send({ method: "subscribe", subscription: sub });
        this.emit("connected");
        resolve();
      });
      this.ws.on("error", (err) => {
        if (!this.closed) reject(err);
      });
      this.ws.on("close", () => {
        if (!this.closed) {
          this.emit("disconnected");
          this.scheduleReconnect();
        }
      });
      this.ws.on("message", (raw) => {
        try { this.handleMessage(JSON.parse(String(raw))); } catch { /* ignore */ }
      });
    });
  }

  private send(data: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(data));
  }

  private sub(subscription: Record<string, unknown>) {
    this.subs.push(subscription);
    this.send({ method: "subscribe", subscription });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(async () => {
      try { await this.connect(); } catch { this.scheduleReconnect(); }
    }, 3000);
  }

  subscribePrices() { this.sub({ type: "allMids" }); }
  subscribeBook(symbol: string) { this.sub({ type: "l2Book", coin: symbol.toUpperCase() }); }
  subscribeTrades(symbol: string) { this.sub({ type: "trades", coin: symbol.toUpperCase() }); }
  subscribeCandle(symbol: string, interval: string) {
    this.sub({ type: "candle", coin: symbol.toUpperCase(), interval });
  }

  private handleMessage(msg: Record<string, unknown>) {
    const channel = String(msg.channel ?? "");
    const data = msg.data;
    if (!data) return;

    if (channel === "allMids") {
      const mids = ((data as Record<string, unknown>).mids ?? data) as Record<string, string>;
      const updates: PriceUpdate[] = Object.entries(mids).map(([symbol, mid]) => ({
        symbol, mid: Number(mid),
      }));
      this.emit("prices", updates);
    } else if (channel === "l2Book") {
      const d = data as Record<string, unknown>;
      const levels = d.levels as [Record<string, string>[], Record<string, string>[]] | undefined;
      if (levels) {
        this.emit("book", {
          bids: levels[0].map((l) => [l.px, l.sz] as [string, string]),
          asks: levels[1].map((l) => [l.px, l.sz] as [string, string]),
        } satisfies BookUpdate);
      }
    } else if (channel === "trades") {
      const trades = Array.isArray(data) ? data as Record<string, unknown>[] : [];
      for (const t of trades) {
        // HL side: "A" = sell (ask), "B" = buy (bid)
        const rawSide = String(t.side ?? "");
        this.emit("trade", {
          side: rawSide === "A" ? "sell" : rawSide === "B" ? "buy" : rawSide,
          price: String(t.px ?? ""),
          size: String(t.sz ?? ""),
          time: Number(t.time ?? Date.now()),
        } satisfies TradeUpdate);
      }
    } else if (channel === "candle") {
      const d = data as Record<string, unknown>;
      this.emit("candle", {
        o: String(d.o ?? ""), h: String(d.h ?? ""), l: String(d.l ?? ""),
        c: String(d.c ?? ""), v: String(d.v ?? ""), t: Number(d.t ?? 0),
      } satisfies CandleUpdate);
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}

// ── Lighter Market Feed (REST polling) ──

const LIGHTER_BASE = "https://mainnet.zklighter.elliot.ai/api/v1";

export interface LighterFeedOpts {
  /** Polling interval for prices in ms (default: 3000) */
  pricesIntervalMs?: number;
  /** Polling interval for book/trades in ms (default: 2000) */
  bookIntervalMs?: number;
  /** Polling interval for candles in ms (default: 5000) */
  candleIntervalMs?: number;
}

export class LighterMarketFeed extends EventEmitter {
  private closed = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private marketMap = new Map<string, number>();
  private pricesMs: number;
  private bookMs: number;
  private candleMs: number;

  constructor(opts?: LighterFeedOpts) {
    super();
    this.pricesMs = opts?.pricesIntervalMs ?? 3000;
    this.bookMs = opts?.bookIntervalMs ?? 2000;
    this.candleMs = opts?.candleIntervalMs ?? 5000;
  }

  async connect(): Promise<void> {
    const res = await fetch(`${LIGHTER_BASE}/orderBookDetails`);
    const json = await res.json() as {
      order_book_details?: Array<{ symbol: string; market_id: number; market_type: string }>;
    };
    for (const m of json.order_book_details ?? []) {
      if (m.market_type === "perp") this.marketMap.set(m.symbol.toUpperCase(), m.market_id);
    }
    this.emit("connected");
  }

  private getMarketId(symbol: string): number {
    const id = this.marketMap.get(symbol.toUpperCase());
    if (id === undefined) throw new Error(`Unknown Lighter market: ${symbol}`);
    return id;
  }

  private poll(fn: () => Promise<void>, intervalMs: number) {
    fn().catch(() => {});
    this.timers.push(setInterval(() => { if (!this.closed) fn().catch(() => {}); }, intervalMs));
  }

  subscribePrices() {
    this.poll(async () => {
      const res = await fetch(`${LIGHTER_BASE}/orderBookDetails`);
      const json = await res.json() as {
        order_book_details?: Array<{ symbol: string; last_trade_price: number; market_type: string }>;
      };
      const updates: PriceUpdate[] = (json.order_book_details ?? [])
        .filter(m => m.market_type === "perp")
        .map(m => ({ symbol: m.symbol, mid: m.last_trade_price }));
      this.emit("prices", updates);
    }, this.pricesMs);
  }

  subscribeBook(symbol: string) {
    const marketId = this.getMarketId(symbol);
    this.poll(async () => {
      const res = await fetch(`${LIGHTER_BASE}/orderBookOrders?market_id=${marketId}&limit=20`);
      const json = await res.json() as {
        bids?: Array<{ price: string; remaining_base_amount: string }>;
        asks?: Array<{ price: string; remaining_base_amount: string }>;
      };
      this.emit("book", {
        bids: (json.bids ?? []).map(b => [b.price, b.remaining_base_amount] as [string, string]),
        asks: (json.asks ?? []).map(a => [a.price, a.remaining_base_amount] as [string, string]),
      } satisfies BookUpdate);
    }, this.bookMs);
  }

  subscribeTrades(symbol: string) {
    const marketId = this.getMarketId(symbol);
    let lastTid = 0;
    this.poll(async () => {
      const res = await fetch(`${LIGHTER_BASE}/recentTrades?market_id=${marketId}&limit=20`);
      const json = await res.json() as {
        trades?: Array<{ price: string; size: string; is_maker_ask: boolean; timestamp: number }>;
      };
      for (const t of json.trades ?? []) {
        if (t.timestamp > lastTid) {
          lastTid = t.timestamp;
          this.emit("trade", {
            side: t.is_maker_ask ? "buy" : "sell",
            price: t.price,
            size: t.size,
            time: t.timestamp,
          } satisfies TradeUpdate);
        }
      }
    }, this.bookMs);
  }

  subscribeCandle(symbol: string, interval: string) {
    const marketId = this.getMarketId(symbol);
    this.poll(async () => {
      const now = Math.floor(Date.now() / 1000);
      const res = await fetch(
        `${LIGHTER_BASE}/candles?market_id=${marketId}&resolution=${interval}&count_back=1&end_timestamp=${now}`,
      );
      const json = await res.json() as {
        candles?: Array<{ open: string; high: string; low: string; close: string; volume: string; timestamp: number }>;
      };
      const c = json.candles?.[0];
      if (c) {
        this.emit("candle", {
          o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, t: c.timestamp,
        } satisfies CandleUpdate);
      }
    }, this.candleMs);
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

// ── Factory ──

export function createMarketFeed(exchange: string): HyperliquidMarketFeed | LighterMarketFeed {
  if (exchange === "hyperliquid") return new HyperliquidMarketFeed();
  if (exchange === "lighter") return new LighterMarketFeed();
  throw new Error(`Use PacificaWSClient for pacifica, not createMarketFeed`);
}
