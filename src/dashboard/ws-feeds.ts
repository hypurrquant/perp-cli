/**
 * WebSocket Feed Manager for Dashboard.
 *
 * Connects to exchange WS APIs for real-time account data (balance, positions, orders).
 * Falls back to REST polling if WS connection fails.
 * Arb/market data stays on REST (cross-exchange aggregation, no single WS covers it).
 */

import { WebSocket as NodeWebSocket } from "ws";
import type { ExchangeBalance, ExchangePosition, ExchangeOrder } from "../exchanges/index.js";
import type { DashboardExchange } from "./server.js";

export interface WsFeedState {
  balance: ExchangeBalance;
  positions: ExchangePosition[];
  orders: ExchangeOrder[];
  lastUpdate: number;
  mode: "ws" | "rest" | "connecting";
}

export interface WsFeedManagerOpts {
  onUpdate: (exchange: string, state: WsFeedState) => void;
  signal?: AbortSignal;
}

const EMPTY_BALANCE: ExchangeBalance = { equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0" };
const MAX_RECONNECT_DELAY = 30_000;

// ── Base WS Feed ──

abstract class ExchangeWsFeed {
  protected ws: NodeWebSocket | null = null;
  protected state: WsFeedState = { balance: { ...EMPTY_BALANCE }, positions: [], orders: [], lastUpdate: 0, mode: "connecting" };
  protected reconnectDelay = 1000;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected closed = false;
  protected restFallbackTimer: ReturnType<typeof setInterval> | null = null;
  protected wsDataTimer: ReturnType<typeof setTimeout> | null = null;
  private wsDataReceived = false;

  /** How long to wait for WS data before falling back to REST (ms) */
  protected WS_DATA_TIMEOUT = 5000;

  constructor(
    protected exchange: DashboardExchange,
    protected onUpdate: (state: WsFeedState) => void,
  ) {}

  abstract connect(): Promise<void>;
  abstract get wsUrl(): string;

  getState(): WsFeedState { return this.state; }

  /** Start a timer: if no WS data arrives within WS_DATA_TIMEOUT, switch to REST */
  protected startWsDataTimeout() {
    if (this.wsDataTimer) clearTimeout(this.wsDataTimer);
    this.wsDataReceived = false;
    this.wsDataTimer = setTimeout(() => {
      if (!this.wsDataReceived && !this.closed) {
        this.startRestFallback();
      }
    }, this.WS_DATA_TIMEOUT);
  }

  protected emitUpdate() {
    this.state.lastUpdate = Date.now();
    this.wsDataReceived = true;
    // WS is delivering data — stop REST fallback if running
    if (this.state.mode === "rest" && this.ws?.readyState === NodeWebSocket.OPEN) {
      this.state.mode = "ws";
      this.stopRestFallback();
    }
    this.onUpdate(this.state);
    // Also write to file cache for CLI cross-process sharing
    this.writeToCache().catch(() => {});
  }

  private async writeToCache() {
    try {
      const { setCached, TTL_ACCOUNT } = await import("../cache.js");
      const name = this.exchange.name;
      setCached(`dash:${name}:balance`, this.state.balance, TTL_ACCOUNT);
      setCached(`dash:${name}:positions`, this.state.positions, TTL_ACCOUNT);
      setCached(`dash:${name}:orders`, this.state.orders, TTL_ACCOUNT);
    } catch { /* non-fatal */ }
  }

  protected scheduleReconnect() {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectDelay = 1000; // reset on success
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  protected startRestFallback() {
    if (this.restFallbackTimer || this.closed) return;
    this.state.mode = "rest";
    const doRestPoll = async () => {
      try {
        const adapter = this.exchange.adapter;
        const [balance, positions, orders] = await Promise.all([
          adapter.getBalance(),
          adapter.getPositions(),
          adapter.getOpenOrders(),
        ]);
        this.state.balance = balance;
        this.state.positions = positions.filter(p => Number(p.size) !== 0);
        this.state.orders = orders;
        this.emitUpdate();
      } catch { /* ignore */ }
    };
    doRestPoll(); // immediate first fetch
    this.restFallbackTimer = setInterval(doRestPoll, 5000);
  }

  protected stopRestFallback() {
    if (this.restFallbackTimer) {
      clearInterval(this.restFallbackTimer);
      this.restFallbackTimer = null;
    }
  }

  close() {
    this.closed = true;
    this.stopRestFallback();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.wsDataTimer) clearTimeout(this.wsDataTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ── Hyperliquid WS Feed ──

class HyperliquidFeed extends ExchangeWsFeed {
  private address: string;
  private dex: string;
  private balanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(exchange: DashboardExchange, onUpdate: (state: WsFeedState) => void) {
    super(exchange, onUpdate);
    // Extract address and dex from adapter
    const adapter = exchange.adapter as unknown as Record<string, unknown>;
    this.address = String(adapter._address ?? adapter.address ?? "");
    this.dex = String(adapter._dex ?? "");
  }

  get wsUrl() { return "wss://api.hyperliquid.xyz/ws"; }

  async connect(): Promise<void> {
    if (!this.address) {
      this.startRestFallback();
      return;
    }
    // HIP-3 dex accounts: webData2 doesn't support dex param — use REST
    if (this.dex) {
      this.startRestFallback();
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        this.ws = new NodeWebSocket(this.wsUrl);

        this.ws.on("open", () => {
          this.state.mode = "ws";
          // Subscribe to webData2 (positions + orders in real-time)
          this.ws!.send(JSON.stringify({
            method: "subscribe",
            subscription: { type: "webData2", user: this.address },
          }));
          // Balance via REST (webData2 clearinghouse doesn't include dex pool funds)
          this.startBalancePolling();
          // Start data timeout — switch to REST if no data within 5s
          this.startWsDataTimeout();
          resolve();
        });

        this.ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.channel === "webData2" && msg.data) {
              this.handleWebData2(msg.data);
            }
          } catch { /* ignore parse errors */ }
        });

        this.ws.on("close", () => {
          this.stopBalancePolling();
          if (!this.closed) {
            this.startRestFallback();
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (err) => {
          if (this.state.mode === "connecting") {
            this.startRestFallback();
            reject(err);
          }
        });
      } catch (err) {
        this.startRestFallback();
        reject(err);
      }
    });
  }

  /** Poll balance via REST (webData2 clearinghouse doesn't include dex pool funds) */
  private startBalancePolling() {
    if (this.balanceTimer) return;
    const poll = async () => {
      try {
        this.state.balance = await this.exchange.adapter.getBalance();
      } catch { /* ignore */ }
    };
    poll(); // immediate
    this.balanceTimer = setInterval(poll, 5000);
  }

  private stopBalancePolling() {
    if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null; }
  }

  private handleWebData2(data: Record<string, unknown>) {
    try {
      // Balance is handled by REST polling (includes dex pool funds)
      // WS handles positions + orders only
      const chs = data.clearinghouseState as Record<string, unknown> | undefined;
      if (chs) {
        const assetPositions = (chs.assetPositions ?? []) as Array<Record<string, unknown>>;
        this.state.positions = assetPositions
          .filter((ap) => {
            const pos = (ap.position ?? ap) as Record<string, unknown>;
            return Number(pos.szi ?? 0) !== 0;
          })
          .map((ap) => {
            const pos = (ap.position ?? ap) as Record<string, string>;
            const szi = Number(pos.szi);
            return {
              symbol: String(pos.coin ?? ""),
              side: (szi > 0 ? "long" : "short") as "long" | "short",
              size: String(Math.abs(szi)),
              entryPrice: pos.entryPx ?? "0",
              markPrice: String(pos.positionValue ? (Number(pos.positionValue) / Math.abs(szi)).toFixed(2) : "0"),
              liquidationPrice: pos.liquidationPx ?? "N/A",
              unrealizedPnl: pos.unrealizedPnl ?? "0",
              leverage: Number((ap.leverage as Record<string, { value?: number }>)?.value ?? 1),
            };
          });
      }

      // Open orders
      const openOrders = data.openOrders as Array<Record<string, unknown>> | undefined;
      if (openOrders) {
        this.state.orders = openOrders.map((o) => ({
          orderId: String(o.oid ?? ""),
          symbol: String(o.coin ?? ""),
          side: o.side === "B" ? "buy" as const : "sell" as const,
          price: String(o.limitPx ?? "0"),
          size: String(o.sz ?? ""),
          filled: "0",
          status: "open",
          type: String(o.orderType ?? "limit"),
        }));
      }

      this.emitUpdate();
    } catch { /* ignore */ }
  }

  close() {
    this.stopBalancePolling();
    super.close();
  }
}

// ── Pacifica WS Feed ──

class PacificaFeed extends ExchangeWsFeed {
  private account: string;
  private markPriceTimer: ReturnType<typeof setInterval> | null = null;
  private markPrices = new Map<string, string>();

  constructor(exchange: DashboardExchange, onUpdate: (state: WsFeedState) => void) {
    super(exchange, onUpdate);
    const adapter = exchange.adapter as unknown as Record<string, unknown>;
    this.account = String(adapter.publicKey ?? adapter.account ?? "");
  }

  get wsUrl() { return "wss://ws.pacifica.fi/ws"; }

  async connect(): Promise<void> {
    if (!this.account) {
      this.startRestFallback();
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        this.ws = new NodeWebSocket(this.wsUrl);

        this.ws.on("open", () => {
          this.state.mode = "ws";
          // Subscribe to private channels
          const sub = (source: string) =>
            this.ws!.send(JSON.stringify({ method: "subscribe", params: { source, account: this.account } }));
          sub("account_info");
          sub("account_positions");
          sub("account_order_updates");
          // Heartbeat
          this._heartbeat = setInterval(() => {
            if (this.ws?.readyState === NodeWebSocket.OPEN) {
              this.ws.send(JSON.stringify({ method: "ping" }));
            }
          }, 30000);
          // Poll mark prices (WS positions don't include them)
          this.startMarkPricePolling();
          // Start data timeout — switch to REST if no data within 5s
          this.startWsDataTimeout();
          resolve();
        });

        this.ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            const ch = msg.channel || msg.source;
            if (ch === "account_info") this.handleAccountInfo(msg.data ?? msg);
            else if (ch === "account_positions") this.handlePositions(msg.data ?? msg);
            else if (ch === "account_order_updates") this.handleOrders(msg.data ?? msg);
          } catch { /* ignore */ }
        });

        this.ws.on("close", () => {
          this.clearHeartbeat();
          if (!this.closed) {
            this.startRestFallback();
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (err) => {
          if (this.state.mode === "connecting") {
            this.startRestFallback();
            reject(err);
          }
        });
      } catch (err) {
        this.startRestFallback();
        reject(err);
      }
    });
  }

  private _heartbeat: ReturnType<typeof setInterval> | null = null;

  private clearHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  /** Poll mark prices from adapter (WS positions don't include mark prices) */
  private startMarkPricePolling() {
    if (this.markPriceTimer) return;
    const poll = async () => {
      try {
        // Use adapter's getPositions which includes mark prices
        const positions = await this.exchange.adapter.getPositions();
        for (const p of positions) {
          this.markPrices.set(p.symbol, p.markPrice);
        }
        // Update existing WS positions with mark prices + compute PnL
        if (this.state.positions.length > 0) {
          let changed = false;
          for (const pos of this.state.positions) {
            const mark = this.markPrices.get(pos.symbol);
            if (mark && mark !== "0" && pos.markPrice === "0") {
              pos.markPrice = mark;
              const markNum = Number(mark);
              const entry = Number(pos.entryPrice);
              const amount = Number(pos.size);
              const pnl = pos.side === "long"
                ? (markNum - entry) * amount
                : (entry - markNum) * amount;
              pos.unrealizedPnl = pnl.toFixed(4);
              changed = true;
            }
          }
          if (changed) this.emitUpdate();
        }
      } catch { /* ignore */ }
    };
    poll(); // immediate
    this.markPriceTimer = setInterval(poll, 5000);
  }

  private stopMarkPricePolling() {
    if (this.markPriceTimer) { clearInterval(this.markPriceTimer); this.markPriceTimer = null; }
  }

  private handleAccountInfo(data: Record<string, unknown>) {
    // Abbreviated fields: ae=account_equity, as=available_to_spend, mu=margin_used
    const eq = String(data.ae ?? data.account_equity ?? this.state.balance.equity);
    const av = String(data.as ?? data.available_to_spend ?? this.state.balance.available);
    const mu = String(data.mu ?? data.margin_used ?? this.state.balance.marginUsed);
    this.state.balance = { equity: eq, available: av, marginUsed: mu, unrealizedPnl: this.state.balance.unrealizedPnl };
    this.emitUpdate();
  }

  private handlePositions(data: unknown) {
    if (!Array.isArray(data)) return;
    // WS uses abbreviated fields: s=symbol, d=side, a=amount, p=entry_price, l=liquidation, m=margin
    this.state.positions = data
      .filter((p: Record<string, unknown>) => {
        const amount = Number(p.a ?? p.amount ?? 0);
        const symbol = p.s ?? p.symbol;
        return amount !== 0 && symbol;
      })
      .map((p: Record<string, unknown>) => {
        const symbol = String(p.s ?? p.symbol ?? "");
        const side = String(p.d ?? p.side ?? "") === "bid" ? "long" as const : "short" as const;
        const size = Number(p.a ?? p.amount ?? 0);
        const entryPrice = Number(p.p ?? p.entry_price ?? 0);
        const mark = this.markPrices.get(symbol);
        const markNum = mark ? Number(mark) : 0;
        const pnl = markNum > 0
          ? (side === "long" ? (markNum - entryPrice) * size : (entryPrice - markNum) * size)
          : 0;
        return {
          symbol,
          side,
          size: String(size),
          entryPrice: String(entryPrice),
          markPrice: mark ?? "0",
          liquidationPrice: String(p.l ?? p.liquidation_price ?? "N/A"),
          unrealizedPnl: pnl.toFixed(4),
          leverage: Number(p.leverage ?? 1),
        };
      });
    this.emitUpdate();
  }

  private handleOrders(data: unknown) {
    if (!Array.isArray(data)) return;
    this.state.orders = data
      .filter((o: Record<string, unknown>) => String(o.os ?? o.order_status ?? "") === "open")
      .map((o: Record<string, unknown>) => ({
        orderId: String(o.i ?? o.order_id ?? ""),
        symbol: String(o.s ?? o.symbol ?? ""),
        side: (o.d ?? o.side) === "bid" ? "buy" as const : "sell" as const,
        price: String(o.p ?? o.price ?? "0"),
        size: String(o.a ?? o.amount ?? ""),
        filled: String(o.f ?? o.filled ?? "0"),
        status: "open",
        type: String(o.ot ?? o.order_type ?? ""),
      }));
    this.emitUpdate();
  }

  close() {
    this.clearHeartbeat();
    this.stopMarkPricePolling();
    super.close();
  }
}

// ── Lighter WS Feed ──
// WS: wss://mainnet.zklighter.elliot.ai/stream
// Auth: signer.createAuthToken() passed as `auth` field in subscribe messages
// Channels: account_all_positions/{index} (auth), account_all_orders/{index} (auth),
//           user_stats/{index} (public — balance info)

class LighterFeed extends ExchangeWsFeed {
  private accountIndex: number;

  constructor(exchange: DashboardExchange, onUpdate: (state: WsFeedState) => void) {
    super(exchange, onUpdate);
    const adapter = exchange.adapter as unknown as Record<string, unknown>;
    this.accountIndex = Number(adapter._accountIndex ?? -1);
  }

  get wsUrl() { return "wss://mainnet.zklighter.elliot.ai/stream"; }

  private async getAuthToken(): Promise<string | null> {
    try {
      const adapter = this.exchange.adapter as unknown as {
        signer?: { createAuthToken(deadline: number): Promise<{ authToken: string }> };
        isReadOnly?: boolean;
      };
      if (adapter.isReadOnly || !adapter.signer) return null;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const auth = await adapter.signer.createAuthToken(deadline);
      return auth.authToken;
    } catch {
      return null;
    }
  }

  async connect(): Promise<void> {
    if (this.accountIndex < 0) {
      this.startRestFallback();
      return;
    }

    // Get auth token for private channel subscriptions
    const authToken = await this.getAuthToken();
    if (!authToken) {
      // No auth available — use REST fallback
      this.startRestFallback();
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new NodeWebSocket(this.wsUrl);

        this.ws.on("open", () => {
          this.state.mode = "ws";
          // Subscribe to authenticated channels (positions + orders)
          const authChannels = [
            `account_all_positions/${this.accountIndex}`,
            `account_all_orders/${this.accountIndex}`,
          ];
          for (const channel of authChannels) {
            this.ws!.send(JSON.stringify({ type: "subscribe", channel, auth: authToken }));
          }
          // Subscribe to public channel for balance (no auth needed)
          this.ws!.send(JSON.stringify({ type: "subscribe", channel: `user_stats/${this.accountIndex}` }));
          // Start data timeout — switch to REST if no data within 5s
          this.startWsDataTimeout();
          resolve();
        });

        this.ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            this.handleMessage(msg);
          } catch { /* ignore */ }
        });

        this.ws.on("close", () => {
          if (!this.closed) {
            this.startRestFallback();
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (err) => {
          if (this.state.mode === "connecting") {
            this.startRestFallback();
            reject(err);
          }
        });
      } catch (err) {
        this.startRestFallback();
        reject(err);
      }
    });
  }

  /** Cached position map: market_id → position data (for incremental updates) */
  private positionMap = new Map<string, Record<string, unknown>>();

  private handleMessage(msg: Record<string, unknown>) {
    const type = String(msg.type ?? "");

    // Balance: user_stats channel (public, no auth) provides portfolio_value, available_balance, etc.
    if (type.includes("user_stats")) {
      const stats = (msg.stats ?? msg) as Record<string, unknown>;
      // total_stats includes cross-margin + isolated totals
      const src = (stats.total_stats ?? stats) as Record<string, unknown>;
      const equity = String(src.portfolio_value ?? src.collateral ?? this.state.balance.equity);
      const available = String(src.available_balance ?? this.state.balance.available);
      const marginUsed = String(src.margin_usage ?? this.state.balance.marginUsed);
      this.state.balance = { equity, available, marginUsed, unrealizedPnl: this.state.balance.unrealizedPnl };
      this.emitUpdate();
    }

    // Positions: subscribed/ = full snapshot, update/ = incremental
    if (type.includes("account_all_positions")) {
      const positions = msg.positions as Record<string, Record<string, unknown>> | undefined;
      if (positions) {
        const isSnapshot = type.startsWith("subscribed/");
        if (isSnapshot) {
          // Full snapshot — replace everything
          this.positionMap.clear();
          for (const [id, p] of Object.entries(positions)) {
            this.positionMap.set(id, p);
          }
        } else {
          // Incremental update — merge only provided entries
          for (const [id, p] of Object.entries(positions)) {
            this.positionMap.set(id, { ...this.positionMap.get(id), ...p });
          }
        }

        // Rebuild positions from map
        this.state.positions = [...this.positionMap.values()]
          .filter(p => Number(p.position ?? 0) !== 0)
          .map(p => {
            const posSize = Number(p.position ?? 0);
            return {
              symbol: String(p.symbol ?? `Market-${p.market_id}`),
              side: (Number(p.sign) > 0 ? "long" : "short") as "long" | "short",
              size: String(Math.abs(posSize)),
              entryPrice: String(p.avg_entry_price ?? "0"),
              markPrice: posSize !== 0
                ? String((Number(p.position_value ?? 0) / Math.abs(posSize)).toFixed(4))
                : "0",
              liquidationPrice: String(p.liquidation_price || "N/A"),
              unrealizedPnl: String(p.unrealized_pnl ?? "0"),
              leverage: Number(p.initial_margin_fraction ?? 0) > 0
                ? Math.round(10000 / Number(p.initial_margin_fraction))
                : 1,
            };
          });
        this.emitUpdate();
      }
    }

    // Orders: subscribed/ = full snapshot, update/ = incremental
    if (type.includes("account_all_orders")) {
      const orders = msg.orders as Record<string, Record<string, unknown>[]> | undefined;
      if (orders) {
        const allOrders = Object.values(orders).flat();
        this.state.orders = allOrders
          .filter(o => String(o.status ?? "") === "open")
          .map(o => ({
            orderId: String(o.order_id ?? o.order_index ?? ""),
            symbol: String(o.symbol ?? ""),
            side: (o.side === "buy" || o.is_ask === false ? "buy" : "sell") as "buy" | "sell",
            price: String(o.price ?? "0"),
            size: String(o.remaining_base_amount ?? o.initial_base_amount ?? ""),
            filled: String(o.filled_base_amount ?? "0"),
            status: "open",
            type: String(o.type ?? "limit"),
          }));
        this.emitUpdate();
      }
    }
  }
}

// ── WsFeedManager ──

export class WsFeedManager {
  private feeds = new Map<string, ExchangeWsFeed>();
  private onUpdate: WsFeedManagerOpts["onUpdate"];

  constructor(exchanges: DashboardExchange[], opts: WsFeedManagerOpts) {
    this.onUpdate = opts.onUpdate;

    for (const ex of exchanges) {
      const handler = (state: WsFeedState) => this.onUpdate(ex.name, state);

      let feed: ExchangeWsFeed;
      if (ex.name === "hyperliquid" || ex.name.startsWith("hl:")) {
        feed = new HyperliquidFeed(ex, handler);
      } else if (ex.name === "pacifica") {
        feed = new PacificaFeed(ex, handler);
      } else if (ex.name === "lighter") {
        feed = new LighterFeed(ex, handler);
      } else {
        // Unknown exchange — REST fallback only
        feed = new RestOnlyFeed(ex, handler);
      }
      this.feeds.set(ex.name, feed);
    }

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => this.close(), { once: true });
    }
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.feeds.values()].map((f) => f.connect()),
    );
    // Log failures but don't throw — feeds fall back to REST
    for (const r of results) {
      if (r.status === "rejected") {
        // Feed will have activated REST fallback internally
      }
    }
  }

  getState(exchange: string): WsFeedState | null {
    return this.feeds.get(exchange)?.getState() ?? null;
  }

  getAllStates(): Map<string, WsFeedState> {
    const result = new Map<string, WsFeedState>();
    for (const [name, feed] of this.feeds) {
      result.set(name, feed.getState());
    }
    return result;
  }

  close() {
    for (const feed of this.feeds.values()) {
      feed.close();
    }
  }
}

// Fallback: REST-only feed for unknown exchanges
class RestOnlyFeed extends ExchangeWsFeed {
  get wsUrl() { return ""; }
  async connect(): Promise<void> {
    this.startRestFallback();
  }
}
