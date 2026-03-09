import { MAINNET_WS, type Network, getNetworkConfig } from "./constants";
import { buildSignedRequest } from "./signing";
import type {
  Channel,
  PublicChannel,
  PrivateChannel,
  WSTradingResponse,
} from "./types/ws";

type MessageHandler = (data: unknown) => void;
type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

export interface PacificaWSConfig {
  network?: Network;
  wsUrl?: string;
  apiKey?: string;
  autoReconnect?: boolean;
  heartbeatInterval?: number;
}

export class PacificaWSClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private apiKey?: string;
  private autoReconnect: boolean;
  private heartbeatInterval: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private tradingCallbacks: Map<string, (res: WSTradingResponse) => void> = new Map();
  private isConnected = false;

  constructor(config: PacificaWSConfig = {}) {
    this.wsUrl = config.wsUrl || getNetworkConfig(config.network).wsUrl;
    this.apiKey = config.apiKey;
    this.autoReconnect = config.autoReconnect ?? true;
    this.heartbeatInterval = config.heartbeatInterval ?? 30000;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = this.apiKey ? `${this.wsUrl}?PF-API-KEY=${this.apiKey}` : this.wsUrl;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.isConnected = true;
          this.startHeartbeat();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this.stopHeartbeat();
          if (this.autoReconnect) {
            this.reconnectTimer = setTimeout(() => this.connect(), 3000);
          }
        };

        this.ws.onerror = (err) => {
          if (!this.isConnected) reject(err);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect() {
    this.autoReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.send({ method: "ping" });
    }, this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(data: unknown) {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(raw: string | ArrayBuffer | Blob) {
    try {
      const text = typeof raw === "string" ? raw : "";
      if (!text) return;

      const msg = JSON.parse(text);

      // Pong response
      if (msg.channel === "pong") return;

      // Trading response (has id field)
      if (msg.id && this.tradingCallbacks.has(msg.id)) {
        const cb = this.tradingCallbacks.get(msg.id)!;
        this.tradingCallbacks.delete(msg.id);
        cb(msg);
        return;
      }

      // Channel data
      const channel = msg.channel || msg.source;
      if (channel) {
        const cbs = this.handlers.get(channel);
        if (cbs) {
          cbs.forEach((cb) => cb(msg));
        }
      }

      // Global handler
      const allCbs = this.handlers.get("*");
      if (allCbs) {
        allCbs.forEach((cb) => cb(msg));
      }
    } catch {
      // Ignore parse errors
    }
  }

  // ==================== SUBSCRIPTIONS ====================

  subscribe(channel: PublicChannel, params?: Record<string, unknown>) {
    this.send({
      method: "subscribe",
      params: { source: channel, ...params },
    });
  }

  subscribePrivate(channel: PrivateChannel, account: string) {
    this.send({
      method: "subscribe",
      params: { source: channel, account },
    });
  }

  unsubscribe(channel: Channel, params?: Record<string, unknown>) {
    this.send({
      method: "unsubscribe",
      params: { source: channel, ...params },
    });
  }

  on(channel: string, handler: MessageHandler) {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler);
  }

  off(channel: string, handler: MessageHandler) {
    this.handlers.get(channel)?.delete(handler);
  }

  // ==================== WS TRADING ====================

  async createOrder(
    params: Record<string, unknown>,
    account: string,
    signMessage: SignMessageFn
  ): Promise<WSTradingResponse> {
    const id = crypto.randomUUID();
    const body = await buildSignedRequest("create_order", params, account, signMessage);
    return this.sendTradingCommand(id, { create_order: body });
  }

  async createMarketOrder(
    params: Record<string, unknown>,
    account: string,
    signMessage: SignMessageFn
  ): Promise<WSTradingResponse> {
    const id = crypto.randomUUID();
    const body = await buildSignedRequest("create_market_order", params, account, signMessage);
    return this.sendTradingCommand(id, { create_market_order: body });
  }

  async editOrder(
    params: Record<string, unknown>,
    account: string,
    signMessage: SignMessageFn
  ): Promise<WSTradingResponse> {
    const id = crypto.randomUUID();
    const body = await buildSignedRequest("edit_order", params, account, signMessage);
    return this.sendTradingCommand(id, { edit_order: body });
  }

  async cancelOrder(
    params: Record<string, unknown>,
    account: string,
    signMessage: SignMessageFn
  ): Promise<WSTradingResponse> {
    const id = crypto.randomUUID();
    const body = await buildSignedRequest("cancel_order", params, account, signMessage);
    return this.sendTradingCommand(id, { cancel_order: body });
  }

  async cancelAllOrders(
    params: Record<string, unknown>,
    account: string,
    signMessage: SignMessageFn
  ): Promise<WSTradingResponse> {
    const id = crypto.randomUUID();
    const body = await buildSignedRequest("cancel_all_orders", params, account, signMessage);
    return this.sendTradingCommand(id, { cancel_all_orders: body });
  }

  private sendTradingCommand(
    id: string,
    params: Record<string, unknown>
  ): Promise<WSTradingResponse> {
    return new Promise((resolve, reject) => {
      this.tradingCallbacks.set(id, resolve);
      this.send({ id, params });

      // Timeout after 10s
      setTimeout(() => {
        if (this.tradingCallbacks.has(id)) {
          this.tradingCallbacks.delete(id);
          reject(new Error(`Trading command ${id} timed out`));
        }
      }, 10000);
    });
  }
}
