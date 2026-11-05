/**
 * WebSocket Feed Manager for Dashboard.
 *
 * Connects to exchange WS APIs for real-time account data (balance, positions, orders).
 * Falls back to REST polling if WS connection fails.
 * Arb/market data stays on REST (cross-exchange aggregation, no single WS covers it).
 */

import { WebSocket as NodeWebSocket } from "ws";
import type { ExchangeAdapter, ExchangeBalance, ExchangePosition, ExchangeOrder } from "../exchanges/index.js";
import type { DashboardExchange } from "./server.js";
import type { LighterAdapter } from "../exchanges/lighter.js";
import type { PacificaAdapter } from "../exchanges/pacifica.js";
import { hlOpenOrderRows } from "../exchanges/hyperliquid.js";
import { formatComputedPrice } from "../exchanges/precision.js";
import { VENUE_STATIC } from "../ws/venue-static.js";

/** Balance as the dashboard knows it: unrealizedPnl null = the venue feed does not report it / unknown. */
export type DashboardBalance = Omit<ExchangeBalance, "unrealizedPnl"> & { unrealizedPnl: string | null };
/** Position as the dashboard knows it: a price / PnL / leverage the WS message did not carry is null (unknown), never "0" / 1. */
export type DashboardPosition = Omit<ExchangePosition, "entryPrice" | "markPrice" | "unrealizedPnl" | "leverage"> & {
  entryPrice: string | null;
  markPrice: string | null;
  unrealizedPnl: string | null;
  leverage: number | null;
};

/** Venue number → string, or null when the field is absent / not a finite number. */
function numStr(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(v) : null;
}

export interface WsFeedState {
  /** null = not read yet (never a zero placeholder). */
  balance: DashboardBalance | null;
  /** null = not read yet. */
  positions: DashboardPosition[] | null;
  /** null = not read yet. */
  orders: ExchangeOrder[] | null;
  lastUpdate: number;
  mode: "ws" | "rest" | "connecting";
  /** Last time a venue read / WS message was applied successfully (ms), null = never. */
  lastOkAt: number | null;
  /** Last read / parse failure ("<source>: <message>"), null = none since the feed started. */
  lastError: string | null;
  lastErrorAt: number | null;
}

/** A feed is stale when it has no data yet, its last failure is newer than its last success,
 *  or its last success is older than this — in every mode: a live socket is fresh only while
 *  the venue keeps confirming it. */
export const FEED_STALE_MS = 30_000;

export function isFeedStale(state: WsFeedState, now = Date.now()): boolean {
  if (state.lastOkAt === null) return true;
  if (state.lastErrorAt !== null && state.lastErrorAt > state.lastOkAt) return true;
  return now - state.lastOkAt > FEED_STALE_MS;
}

/** Log the first failure of a source, then every Nth consecutive one (avoid log spam). */
const LOG_EVERY_N_FAILURES = 20;

export interface WsFeedManagerOpts {
  onUpdate: (exchange: string, state: WsFeedState) => void;
  signal?: AbortSignal;
}

const MAX_RECONNECT_DELAY = 30_000;

// ── Base WS Feed ──

abstract class ExchangeWsFeed {
  protected ws: NodeWebSocket | null = null;
  protected state: WsFeedState = {
    balance: null, positions: null, orders: null, lastUpdate: 0, mode: "connecting",
    lastOkAt: null, lastError: null, lastErrorAt: null,
  };
  protected failureCounts = new Map<string, number>();
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

  /** A read / parse succeeded: the data is fresh again. */
  protected recordOk(source: string) {
    this.state.lastOkAt = Date.now();
    this.failureCounts.delete(source);
  }

  /** An auxiliary REST read (balance / mark poll) succeeded. In ws mode it does not make the feed
   *  fresh: only the socket (data or pong) does, or a silent socket would never turn stale. */
  protected recordAuxOk(source: string) {
    if (this.state.mode !== "ws") this.state.lastOkAt = Date.now();
    this.failureCounts.delete(source);
  }

  /** A read / parse failed: record it on the state (the UI marks the feed stale) and log it
   *  on the first failure and every LOG_EVERY_N_FAILURES consecutive ones after that. */
  protected recordError(source: string, err: unknown) {
    const msg = this.logFailure(source, err);
    this.state.lastError = `${source}: ${msg}`;
    this.state.lastErrorAt = Date.now();
    this.onUpdate(this.state);
  }

  /** Log-only (data is still flowing from another path, e.g. REST while WS reconnects). */
  protected logFailure(source: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const n = (this.failureCounts.get(source) ?? 0) + 1;
    this.failureCounts.set(source, n);
    if (n === 1 || n % LOG_EVERY_N_FAILURES === 0) {
      process.stderr.write(`[warn] dashboard ${this.exchange.name} ${source} failed (${n}x): ${msg}\n`);
    }
    return msg;
  }

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

  /** New data was applied. Only data from the open socket makes it the live source (stops the
   *  REST fallback): a REST read (fromWs false) never stops REST polling itself. */
  protected emitUpdate(fromWs = true) {
    this.state.lastUpdate = Date.now();
    // In ws mode only socket data confirms the feed (a REST-side update does not).
    if (fromWs || this.state.mode !== "ws") this.state.lastOkAt = this.state.lastUpdate;
    if (fromWs && this.ws?.readyState === NodeWebSocket.OPEN) {
      this.wsDataReceived = true;
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
      // Only data actually read is shared — an unread (null) part is never cached as empty.
      if (this.state.balance) setCached(`dash:${name}:balance`, this.state.balance, TTL_ACCOUNT);
      if (this.state.positions) setCached(`dash:${name}:positions`, this.state.positions, TTL_ACCOUNT);
      if (this.state.orders) setCached(`dash:${name}:orders`, this.state.orders, TTL_ACCOUNT);
    } catch { /* non-fatal */ }
  }

  protected scheduleReconnect() {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectDelay = 1000; // reset on success
        this.failureCounts.delete("ws-reconnect");
      } catch (e) {
        // REST fallback keeps the data flowing; the reconnect failure is logged, not hidden.
        this.logFailure("ws-reconnect", e);
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
        // Polling stopped (socket data arrived) while this read was in flight: it is older than
        // what the socket delivered — discarded, never applied over it.
        if (this.restFallbackTimer !== timer) return;
        this.state.balance = balance;
        this.state.positions = positions.filter(p => Number(p.size) !== 0);
        this.state.orders = orders;
        this.emitUpdate(false);
      } catch (e) {
        if (this.restFallbackTimer !== timer) return; // an obsolete read's failure says nothing
        // Keep the last-read data but mark the feed stale (lastError) — never blank it to 0 / empty.
        this.recordError("rest-poll", e);
      }
    };
    const timer = setInterval(doRestPoll, 5000);
    this.restFallbackTimer = timer;
    void doRestPoll(); // immediate first fetch
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
  /** The venue refused a subscription on the current socket (error frame): REST stays the source. */
  private refused = false;

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
    // HIP-3 dex accounts: REST polling (this feed subscribes the native dex only)
    if (this.dex) {
      this.startRestFallback();
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        this.ws = new NodeWebSocket(this.wsUrl);

        this.ws.on("open", () => {
          this.refused = false;
          // Documented user channels (webData2 is refused by the venue): positions + open orders,
          // each a full snapshot on subscribe, re-pushed every few seconds.
          for (const type of ["clearinghouseState", "openOrders"]) {
            this.ws!.send(JSON.stringify({ method: "subscribe", subscription: { type, user: this.address } }));
          }
          // Balance via REST (clearinghouseState doesn't include dex pool funds)
          this.startBalancePolling();
          // Start data timeout — switch to REST if no data within 5s
          this.startWsDataTimeout();
          resolve();
        });

        this.ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.channel === "error") {
              // A refused subscription: this socket will not carry the full state — REST at once,
              // not after WS_DATA_TIMEOUT.
              this.refused = true;
              this.recordError("ws-error", new Error(String(msg.data)));
              this.startRestFallback();
            } else if (this.refused) {
              return; // a partial state never replaces the REST data
            } else if (msg.channel === "clearinghouseState" && msg.data?.clearinghouseState) {
              this.handleClearinghouseState(msg.data.clearinghouseState);
            } else if (msg.channel === "openOrders" && Array.isArray(msg.data?.orders)) {
              this.handleOpenOrders(msg.data.orders);
            }
          } catch (e) { this.recordError("ws-parse", e); }
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

  /** Poll balance via REST (clearinghouseState doesn't include dex pool funds) */
  private startBalancePolling() {
    if (this.balanceTimer) return;
    const poll = async () => {
      try {
        this.state.balance = await this.exchange.adapter.getBalance();
        this.recordAuxOk("balance-poll");
      } catch (e) { this.recordError("balance-poll", e); }
    };
    poll(); // immediate
    this.balanceTimer = setInterval(poll, 5000);
  }

  private stopBalancePolling() {
    if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null; }
  }

  /** clearinghouseState frame: positions (the balance is handled by REST polling, it includes dex pool funds). */
  private handleClearinghouseState(chs: Record<string, unknown>) {
    try {
      const assetPositions = (chs.assetPositions ?? []) as Array<Record<string, unknown>>;
      this.state.positions = assetPositions
        .filter((ap) => {
          const pos = (ap.position ?? ap) as Record<string, unknown>;
          const szi = numStr(pos.szi);
          if (szi === null) throw new Error(`clearinghouseState position without szi: ${JSON.stringify(pos).slice(0, 200)}`);
          return Number(szi) !== 0;
        })
        .map((ap) => {
          const pos = (ap.position ?? ap) as Record<string, string>;
          const szi = Number(pos.szi);
          const posValue = numStr(pos.positionValue);
          const leverage = numStr((pos.leverage as unknown as { value?: number } | undefined)?.value);
          return {
            symbol: String(pos.coin ?? ""),
            side: (szi > 0 ? "long" : "short") as "long" | "short",
            size: String(Math.abs(szi)),
            // A field the message did not carry is unknown (null), never "0".
            entryPrice: numStr(pos.entryPx),
            markPrice: posValue !== null ? formatComputedPrice(Number(posValue) / Math.abs(szi)) : null, // as hlPositionRows
            liquidationPrice: pos.liquidationPx ?? null, // HL sends null when there is no liquidation price
            unrealizedPnl: numStr(pos.unrealizedPnl),
            leverage: leverage === null ? null : Number(leverage), // position.leverage {type, value}
          };
        });
      this.emitUpdate();
    } catch (e) { this.recordError("ws-clearinghouseState", e); }
  }

  /** openOrders frame: the account's open orders (frontendOpenOrders rows). */
  private handleOpenOrders(openOrders: Array<Record<string, unknown>>) {
    try {
      // The REST read's mapper: spot rows left out, an unreadable row throws (recorded below).
      this.state.orders = hlOpenOrderRows(openOrders, (coin) => coin);
      this.emitUpdate();
    } catch (e) { this.recordError("ws-openOrders", e); }
  }

  close() {
    this.stopBalancePolling();
    super.close();
  }
}

// ── Pacifica WS Feed ──

/** How often the Pacifica open orders are re-read over REST (reconciles an update the stream missed). */
const ORDERS_RECONCILE_MS = 60_000;
/** Order updates kept while the open-orders snapshot is unread / in flight. */
const MAX_PENDING_ORDER_UPDATES = 1000;

class PacificaFeed extends ExchangeWsFeed {
  private account: string;
  private markPriceTimer: ReturnType<typeof setInterval> | null = null;
  private markPrices = new Map<string, string>();
  /** Open orders by id. account_order_updates is a change stream without a snapshot: the list is
   *  read over REST at every (re)subscribe and again every ORDERS_RECONCILE_MS (an update missed
   *  while the subscription became active is not left until the next reconnect), and each update is
   *  applied to it. Updates that arrive while a read is in flight are replayed over its answer (an
   *  upsert / removal by id is idempotent). null = not read yet. */
  private orderMap: Map<string, ExchangeOrder> | null = null;
  private pendingOrderUpdates: unknown[] = [];
  private ordersLoading = false;
  private ordersReadAt = 0;
  /** Spot symbols (SOL-USDC …): their order updates are left out, as getOpenOrders leaves them out. */
  private spotSymbols = new Set<string>();

  constructor(exchange: DashboardExchange, onUpdate: (state: WsFeedState) => void) {
    super(exchange, onUpdate);
    const adapter = exchange.adapter as unknown as Record<string, unknown>;
    this.account = String(adapter.publicKey ?? adapter.account ?? "");
  }

  /** The open-orders snapshot of socket `ws` (dropped when a newer socket replaced it). */
  private async loadOpenOrders(ws: NodeWebSocket | null) {
    if (this.ordersLoading) return;
    this.ordersLoading = true;
    try {
      const adapter = this.exchange.adapter as ExchangeAdapter & Pick<PacificaAdapter, "nonPerpSymbols">;
      const [orders, spot] = await Promise.all([adapter.getOpenOrders(), adapter.nonPerpSymbols()]);
      if (ws !== this.ws) return;
      this.spotSymbols = spot;
      this.orderMap = new Map(orders.map(o => [o.orderId, o]));
      this.ordersReadAt = Date.now();
      this.ordersLoading = false; // the replay below applies, it is not buffered again
      this.handleOrders(this.pendingOrderUpdates.splice(0), false);
    } catch (e) {
      if (this.orderMap !== null) this.pendingOrderUpdates = []; // a failed re-read: those updates are applied already
      this.recordError("orders-snapshot", e);
    } finally {
      this.ordersLoading = false;
    }
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
          // Subscribe to private channels
          const sub = (source: string) =>
            this.ws!.send(JSON.stringify({ method: "subscribe", params: { source, account: this.account } }));
          sub("account_info");
          sub("account_positions");
          sub("account_order_updates");
          this.orderMap = null;
          this.pendingOrderUpdates = [];
          void this.loadOpenOrders(this.ws);
          // Heartbeat: Pacifica closes a socket after 60 s without a client message. The pong also
          // confirms the (change-only) account channels are live, so ping well within FEED_STALE_MS.
          this._heartbeat = setInterval(() => {
            if (this.ws?.readyState === NodeWebSocket.OPEN) {
              this.ws.send(JSON.stringify({ method: "ping" }));
            }
          }, FEED_STALE_MS / 3);
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
            if (ch === "pong" && this.state.mode === "ws") this.recordOk("ws-pong"); // confirms only the live source
            else if (ch === "account_info") this.handleAccountInfo(msg.data ?? msg);
            else if (ch === "account_positions") this.handlePositions(msg.data ?? msg);
            else if (ch === "account_order_updates") this.handleOrders(msg.data ?? msg);
          } catch (e) { this.recordError("ws-parse", e); }
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
      // A failed open-orders snapshot is read again (the order updates cannot rebuild the list), and
      // a read one is re-read every ORDERS_RECONCILE_MS.
      if (this.ws?.readyState === NodeWebSocket.OPEN && (this.orderMap === null || Date.now() - this.ordersReadAt >= ORDERS_RECONCILE_MS)) {
        void this.loadOpenOrders(this.ws);
      }
      try {
        // Use adapter's getPositions which includes mark prices
        const positions = await this.exchange.adapter.getPositions();
        for (const p of positions) {
          this.markPrices.set(p.symbol, p.markPrice);
        }
        this.recordAuxOk("mark-poll");
        // Update existing WS positions with mark prices + compute PnL
        if (this.state.positions && this.state.positions.length > 0) {
          let changed = false;
          for (const pos of this.state.positions) {
            const mark = this.markPrices.get(pos.symbol);
            if (mark && Number(mark) > 0 && pos.markPrice !== mark) {
              pos.markPrice = mark;
              if (pos.entryPrice !== null) {
                const markNum = Number(mark);
                const entry = Number(pos.entryPrice);
                const amount = Number(pos.size);
                const pnl = pos.side === "long"
                  ? (markNum - entry) * amount
                  : (entry - markNum) * amount;
                pos.unrealizedPnl = pnl.toFixed(4);
              }
              changed = true;
            }
          }
          if (changed && this.state.balance) this.state.balance = { ...this.state.balance, unrealizedPnl: this.positionsUpnl() };
          if (changed) this.emitUpdate(false);
        }
      } catch (e) { this.recordError("mark-poll", e); }
    };
    poll(); // immediate
    this.markPriceTimer = setInterval(poll, 5000);
  }

  private stopMarkPricePolling() {
    if (this.markPriceTimer) { clearInterval(this.markPriceTimer); this.markPriceTimer = null; }
  }

  private handleAccountInfo(data: Record<string, unknown>) {
    // Abbreviated fields: ae=account_equity, as=available_to_spend, mu=margin_used
    // A field missing from this (partial) update keeps its previously-read value; with no
    // previous value it is unknown → the update is rejected (recorded), never read as 0.
    const prev = this.state.balance;
    const eq = numStr(data.ae ?? data.account_equity) ?? prev?.equity;
    const av = numStr(data.as ?? data.available_to_spend) ?? prev?.available;
    const mu = numStr(data.mu ?? data.margin_used) ?? prev?.marginUsed;
    if (eq == null || av == null || mu == null) {
      this.recordError("ws-account_info", new Error("account_info without equity / available / margin_used"));
      return;
    }
    // account_info carries no unrealized PnL: the sum of the positions' PnL when all are known, else null.
    this.state.balance = { equity: eq, available: av, marginUsed: mu, unrealizedPnl: this.positionsUpnl() };
    this.emitUpdate();
  }

  /** Sum of the positions' unrealized PnL; null when positions are unread or any PnL is unknown. */
  private positionsUpnl(): string | null {
    const ps = this.state.positions;
    if (!ps || ps.some(p => p.unrealizedPnl === null)) return null;
    return ps.reduce((s, p) => s + Number(p.unrealizedPnl), 0).toFixed(4);
  }

  private handlePositions(data: unknown) {
    if (!Array.isArray(data)) return;
    // WS uses abbreviated fields: s=symbol, d=side, a=amount, p=entry_price, l=liquidation, m=margin
    const positions: DashboardPosition[] = [];
    for (const p of data as Record<string, unknown>[]) {
      const symbol = p.s ?? p.symbol;
      const amount = numStr(p.a ?? p.amount);
      if (!symbol || amount === null) {
        // A row without a symbol / amount cannot be shown — reported, not read as "no position".
        this.recordError("ws-account_positions", new Error(`position row without symbol/amount: ${JSON.stringify(p).slice(0, 200)}`));
        continue;
      }
      const size = Number(amount);
      if (size === 0) continue;
      const side = String(p.d ?? p.side ?? "") === "bid" ? "long" as const : "short" as const;
      const entry = numStr(p.p ?? p.entry_price);
      const mark = this.markPrices.get(String(symbol)) ?? null;
      const markNum = mark !== null ? Number(mark) : NaN;
      // PnL needs both prices; unknown (null) otherwise — never 0.
      const pnl = entry !== null && markNum > 0
        ? (side === "long" ? (markNum - Number(entry)) * size : (Number(entry) - markNum) * size).toFixed(4)
        : null;
      positions.push({
        symbol: String(symbol),
        side,
        size: String(size),
        entryPrice: entry,
        markPrice: mark,
        liquidationPrice: p.l != null ? String(p.l) : p.liquidation_price != null ? String(p.liquidation_price) : null,
        unrealizedPnl: pnl,
        leverage: numStr(p.leverage) === null ? null : Number(p.leverage), // not in account_positions: unknown
      });
    }
    this.state.positions = positions;
    if (this.state.balance) this.state.balance = { ...this.state.balance, unrealizedPnl: this.positionsUpnl() };
    this.emitUpdate();
  }

  /** account_order_updates rows: one change per order (open / partially_filled rest on the book, any
   *  other status left it); `ip` is the order price (`p` is the average fill price). */
  private handleOrders(data: unknown, fromWs = true) {
    if (!Array.isArray(data)) return;
    if (this.orderMap === null || this.ordersLoading) {
      this.pendingOrderUpdates.push(...data);
      // Bounded: the oldest are the ones the snapshot (read after them) already reflects.
      if (this.pendingOrderUpdates.length > MAX_PENDING_ORDER_UPDATES) this.pendingOrderUpdates.splice(0, this.pendingOrderUpdates.length - MAX_PENDING_ORDER_UPDATES);
      if (this.orderMap === null) return;
    }
    for (const o of data as Record<string, unknown>[]) {
      const id = String(o.i ?? o.order_id ?? "");
      if (this.spotSymbols.has(String(o.s ?? o.symbol ?? ""))) continue;
      const status = String(o.os ?? o.order_status ?? "");
      if (status === "") {
        // Unknown status: neither kept nor removed on a guess — reported (the order stays as last read).
        this.recordError("order-row", `order ${id || "?"} without status`);
        continue;
      }
      if (status !== "open" && status !== "partially_filled") { this.orderMap.delete(id); continue; }
      // A row without a readable price / size / filled amount is reported, never shown as "0".
      const price = numStr(o.ip ?? o.price), size = numStr(o.a ?? o.amount), filled = numStr(o.f ?? o.filled);
      if (price === null || size === null || filled === null) {
        this.recordError("order-row", `order ${id || "?"} without price / amount / filled`);
        continue;
      }
      this.orderMap.set(id, {
        orderId: id,
        symbol: String(o.s ?? o.symbol ?? ""),
        side: (o.d ?? o.side) === "bid" ? "buy" : "sell",
        price, size, filled, status,
        type: String(o.ot ?? o.order_type ?? ""),
        triggerPrice: Number(o.sp ?? o.stop_price) > 0 ? String(o.sp ?? o.stop_price) : null,
      });
    }
    this.state.orders = [...this.orderMap.values()];
    this.emitUpdate(fromWs);
  }

  close() {
    this.clearHeartbeat();
    this.stopMarkPricePolling();
    super.close();
  }
}

// ── Lighter WS Feed (lighter, lighter-rh) ──
// WS: the adapter's venue+network config (venues/lighter-family.ts); null → REST
// Auth: signer.createAuthToken() passed as `auth` field in subscribe messages
// Channels: account_all_positions/{index} (auth), account_all_orders/{index} (auth),
//           user_stats/{index} (public — balance info)

class LighterFeed extends ExchangeWsFeed {
  private accountIndex: number;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(exchange: DashboardExchange, onUpdate: (state: WsFeedState) => void) {
    super(exchange, onUpdate);
    const adapter = exchange.adapter as unknown as Record<string, unknown>;
    this.accountIndex = Number(adapter._accountIndex ?? -1);
  }

  /** Venue+network WS URL from the adapter's network config; null = none published. */
  private get configuredWsUrl(): string | null {
    return (this.exchange.adapter as unknown as Pick<LighterAdapter, "network">).network.wsUrl;
  }

  get wsUrl(): string {
    const url = this.configuredWsUrl;
    if (url === null) throw new Error(`${this.exchange.name}: no WebSocket URL for this network`);
    return url;
  }

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
    } catch (e) {
      // No token → REST polling serves the data; the signer failure is logged, not hidden.
      this.logFailure("ws-auth", e);
      return null;
    }
  }

  async connect(): Promise<void> {
    if (this.accountIndex < 0 || this.configuredWsUrl === null) {
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
          // Keepalive: Lighter closes a socket after 2 minutes without a client frame. The pong also
          // confirms the (change-only) account channels are live, so ping well within FEED_STALE_MS.
          const ping = VENUE_STATIC[this.exchange.name === "lighter-rh" ? "lighter-rh" : "lighter"].ping!;
          this.keepalive = setInterval(() => {
            if (this.ws?.readyState === NodeWebSocket.OPEN) this.ws.send(ping.message);
          }, Math.min(ping.everyMs, FEED_STALE_MS / 3));
          // Start data timeout — switch to REST if no data within 5s
          this.startWsDataTimeout();
          resolve();
        });

        this.ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            this.handleMessage(msg);
          } catch (e) { this.recordError("ws-parse", e); }
        });

        this.ws.on("close", () => {
          this.stopKeepalive();
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

  private stopKeepalive() {
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
  }

  close() {
    this.stopKeepalive();
    super.close();
  }

  /** Cached position map: market_id → position data (for incremental updates) */
  private positionMap = new Map<string, Record<string, unknown>>();

  private handleMessage(msg: Record<string, unknown>) {
    const type = String(msg.type ?? "");
    if (type === "pong" && this.state.mode === "ws") this.recordOk("ws-pong"); // confirms only the live source

    // Balance: user_stats channel (public, no auth) provides portfolio_value, available_balance, etc.
    if (type.includes("user_stats")) {
      const stats = (msg.stats ?? msg) as Record<string, unknown>;
      // total_stats includes cross-margin + isolated totals
      const src = (stats.total_stats ?? stats) as Record<string, unknown>;
      // A field missing from this update keeps its previously-read value; never read as 0.
      const prev = this.state.balance;
      const equity = numStr(src.portfolio_value ?? src.collateral) ?? prev?.equity;
      const available = numStr(src.available_balance) ?? prev?.available;
      const marginUsed = numStr(src.margin_usage) ?? prev?.marginUsed;
      if (equity == null || available == null || marginUsed == null) {
        this.recordError("ws-user_stats", new Error("user_stats without portfolio_value / available_balance / margin_usage"));
      } else {
        // user_stats carries no unrealized PnL: the sum over the positions when all are known, else null.
        const ps = this.state.positions;
        const upnl = ps && ps.every(p => p.unrealizedPnl !== null)
          ? ps.reduce((s, p) => s + Number(p.unrealizedPnl), 0).toFixed(4)
          : null;
        this.state.balance = { equity, available, marginUsed, unrealizedPnl: upnl };
        this.emitUpdate();
      }
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
          .filter(p => {
            // A position entry without a size cannot be shown — reported, not read as flat.
            if (numStr(p.position) === null) {
              this.recordError("ws-account_all_positions", new Error(`position without size (market ${String(p.market_id)})`));
              return false;
            }
            return Number(p.position) !== 0;
          })
          .map(p => {
            const posSize = Number(p.position);
            const posValue = numStr(p.position_value);
            return {
              symbol: String(p.symbol ?? `Market-${p.market_id}`),
              side: (Number(p.sign) > 0 ? "long" : "short") as "long" | "short",
              size: String(Math.abs(posSize)),
              // A field the message did not carry is unknown (null), never "0".
              entryPrice: numStr(p.avg_entry_price),
              markPrice: posValue !== null ? String((Number(posValue) / Math.abs(posSize)).toFixed(4)) : null,
              liquidationPrice: p.liquidation_price ? String(p.liquidation_price) : null,
              unrealizedPnl: numStr(p.unrealized_pnl),
              leverage: Number(p.initial_margin_fraction ?? 0) > 0
                ? Math.round(10000 / Number(p.initial_margin_fraction))
                : null, // no margin fraction: unknown, never 1
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
        // A row without a readable price / size / filled / type is reported, never shown as "0" / "limit".
        const rows: ExchangeOrder[] = [];
        for (const o of allOrders.filter(o => String(o.status ?? "") === "open")) {
          const price = numStr(o.price);
          const size = numStr(o.remaining_base_amount ?? o.initial_base_amount);
          const filled = numStr(o.filled_base_amount);
          if (price === null || size === null || filled === null || typeof o.type !== "string" || o.type === "") {
            this.recordError("order-row", `order ${String(o.order_id ?? o.order_index ?? "?")} without price / size / filled / type`);
            continue;
          }
          rows.push({
            orderId: String(o.order_id ?? o.order_index ?? ""),
            symbol: String(o.symbol ?? ""),
            side: (o.side === "buy" || o.is_ask === false ? "buy" : "sell") as "buy" | "sell",
            price, size, filled,
            status: "open",
            type: o.type,
            triggerPrice: Number(o.trigger_price) > 0 ? String(o.trigger_price) : null,
          });
        }
        this.state.orders = rows;
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
      } else if (ex.name === "lighter" || ex.name === "lighter-rh") {
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
