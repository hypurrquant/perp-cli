import { Keypair } from "@solana/web3.js";
import { PacificaClient, type Network } from "../pacifica/index.js";
import type {
  ExchangeAdapter,
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
  ExchangeFundingPayment,
  ExchangeKline,
} from "./interface.js";
import type { SolanaSigner } from "../signer/index.js";
import { LocalSolanaSigner } from "../signer/index.js";

export class PacificaAdapter implements ExchangeAdapter {
  readonly name = "pacifica";
  readonly chain = "solana";
  readonly aliases = ["pac"] as const;
  private client: PacificaClient;
  private _solanaSigner: SolanaSigner;
  private _hasRealKey: boolean;
  private account: string;
  private signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
  private _marketsCache: ExchangeMarketInfo[] | null = null;
  private _marketsCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;

  constructor(keypair: Keypair, network: Network = "mainnet", builderCode?: string, hasRealKey = true) {
    this._solanaSigner = new LocalSolanaSigner(keypair);
    this._hasRealKey = hasRealKey;
    this.account = this._solanaSigner.getPublicKeyBase58();
    this.client = new PacificaClient({ network, builderCode });
    this.signMessage = (msg) => this._solanaSigner.signMessage(msg);
  }

  private ensureSigner(): void {
    if (!this._hasRealKey) {
      throw new Error("No private key configured. Run: perp setup");
    }
  }

  /** Inject an external Solana signer. */
  setSigner(signer: SolanaSigner): void {
    this._solanaSigner = signer;
    this.account = signer.getPublicKeyBase58();
    this.signMessage = (msg) => this._solanaSigner.signMessage(msg);
  }

  /** Access the underlying Keypair (only available with LocalSolanaSigner). */
  get keypair(): Keypair {
    if (this._solanaSigner instanceof LocalSolanaSigner) {
      return (this._solanaSigner as unknown as { _keypair: Keypair })._keypair;
    }
    throw new Error("keypair not available with external signer");
  }

  private async _getPrices() {
    const { withCache, TTL_ACCOUNT } = await import("../cache.js");
    return withCache(`acct:pac:prices:${this.account.slice(0, 8)}`, TTL_ACCOUNT, () =>
      this.client.getPrices(),
    );
  }

  private async _getPositions() {
    const { withCache, TTL_ACCOUNT } = await import("../cache.js");
    return withCache(`acct:pac:positions:${this.account.slice(0, 8)}`, TTL_ACCOUNT, () =>
      this.client.getPositions(this.account),
    );
  }

  get publicKey(): string {
    return this.account;
  }

  get sdk(): PacificaClient {
    return this.client;
  }

  get signer(): (msg: Uint8Array) => Promise<Uint8Array> {
    return this.signMessage;
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    if (this._marketsCache && Date.now() - this._marketsCacheTime < PacificaAdapter.CACHE_TTL) return this._marketsCache;
    const [markets, prices] = await Promise.all([
      this.client.getInfo(),
      this._getPrices(),
    ]);
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));
    const result = markets.map((m) => {
      const p = priceMap.get(m.symbol);
      // Derive sizeDecimals from lot_size (e.g. "0.001" → 3, "1" → 0)
      const lotSize = parseFloat(m.lot_size ?? "0");
      const sizeDecimals = lotSize > 0 ? Math.max(0, -Math.floor(Math.log10(lotSize))) : undefined;
      return {
        symbol: m.symbol,
        markPrice: p?.mark ?? "-",
        indexPrice: p?.oracle ?? "-",
        fundingRate: m.next_funding_rate ?? m.funding_rate,
        volume24h: p?.volume_24h ?? "-",
        openInterest: p?.open_interest ?? "-",
        maxLeverage: m.max_leverage,
        sizeDecimals,
        stepSize: lotSize > 0 ? m.lot_size : undefined,
      };
    });
    this._marketsCache = result; this._marketsCacheTime = Date.now(); return result;
  }

  async getOrderbook(symbol: string) {
    const book = await this.client.getBook(symbol);
    return {
      bids: book.l[0].map((e) => [e.p, e.a] as [string, string]),
      asks: book.l[1].map((e) => [e.p, e.a] as [string, string]),
    };
  }

  async getBalance(): Promise<ExchangeBalance> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const [info, positions, prices] = await Promise.all([
      this.client.getAccount(this.account),
      this._getPositions(),
      this._getPrices(),
    ]);
    const raw = info as unknown as Record<string, unknown>;
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));

    // API often returns unrealized_pnl=0 — compute from price delta when needed
    let totalPnl = 0;
    for (const p of positions) {
      let upnl = Number(p.unrealized_pnl ?? 0);
      if (upnl === 0 && Number(p.amount) > 0) {
        const mark = Number(priceMap.get(p.symbol)?.mark ?? p.mark_price ?? 0);
        const entry = Number(p.entry_price);
        const dir = p.side === "bid" ? 1 : -1;
        if (mark > 0 && entry > 0) upnl = (mark - entry) * Number(p.amount) * dir;
      }
      totalPnl += upnl;
    }

    return {
      equity: info.account_equity,
      available: info.available_to_spend,
      marginUsed: String(raw.total_margin_used ?? raw.margin_used ?? "0"),
      unrealizedPnl: totalPnl.toFixed(4),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const [positions, prices] = await Promise.all([
      this._getPositions(),
      this._getPrices(),
    ]);
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));
    let levMap = new Map<string, number>();
    try {
      const settings = await this.client.getAccountSettings(this.account);
      if (Array.isArray(settings)) {
        levMap = new Map(settings.map((s) => [s.symbol, s.leverage]));
      }
    } catch {
      // Settings API may not be available
    }

    return positions.map((p) => {
      const mark = priceMap.get(p.symbol)?.mark ?? p.mark_price ?? "0";
      const side = p.side === "bid" ? "long" : "short";
      const size = Number(p.amount);
      const entry = Number(p.entry_price);
      const markNum = Number(mark);

      // API often returns unrealized_pnl=0 — compute from price delta when needed
      let upnl = Number(p.unrealized_pnl ?? 0);
      if (upnl === 0 && size > 0 && entry > 0 && markNum > 0) {
        const dir = side === "long" ? 1 : -1;
        upnl = (markNum - entry) * size * dir;
      }

      return {
        symbol: p.symbol,
        side: side as "long" | "short",
        size: String(p.amount),
        entryPrice: String(p.entry_price),
        markPrice: mark,
        liquidationPrice: String(p.liquidation_price ?? "N/A"),
        unrealizedPnl: upnl.toFixed(4),
        leverage: p.leverage ?? levMap.get(String(p.symbol)) ?? 1,
      };
    });
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const orders = await this.client.getOrders(this.account);
    return orders.map((o) => {
      const raw = o as unknown as Record<string, unknown>;
      return {
        orderId: String(raw.order_id),
        symbol: String(raw.symbol),
        side: raw.side === "bid" ? ("buy" as const) : ("sell" as const),
        price: String(raw.price),
        size: String(raw.initial_amount ?? raw.amount ?? ""),
        filled: String(raw.filled_amount ?? raw.filled ?? "0"),
        status: String(raw.order_status ?? "open"),
        type: String(raw.order_type ?? ""),
      };
    });
  }

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts?: { reduceOnly?: boolean }) {
    this.ensureSigner();
    const result = await this.client.createMarketOrder(
      { symbol, amount: size, side: side === "buy" ? "bid" : "ask", reduce_only: opts?.reduceOnly ?? false, slippage_percent: "1" },
      this.account,
      this.signMessage
    );

    // Validate response - check if order was accepted
    const r = result as Record<string, unknown>;
    if (r.success === false || r.error) {
      throw new Error(`Market ${side} ${symbol}: ${r.error ?? 'order rejected'}`);
    }

    // Response-based validation: SDK didn't throw + no error in response = accepted
    // Trade history verification is best-effort (Pacifica's getTradeHistory can be empty/delayed)
    if (!(opts?.reduceOnly ?? false)) {
      try {
        const trades = await this.getTradeHistory(1);
        const recent = trades.find(t =>
          t.symbol.toUpperCase() === symbol.toUpperCase() &&
          t.time > Date.now() - 30000
        );
        if (!recent) {
          // Warning only — don't throw. Strategy's position verification is the final safety net.
          console.error(`[pacifica] Warning: market ${side} ${symbol} accepted but no recent trade in history`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Market ")) throw e;
        // trade history query failed, log but don't block (order accepted)
      }
    }

    return result;
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string }) {
    this.ensureSigner();
    return this.client.createLimitOrder(
      { symbol, price, amount: size, side: side === "buy" ? "bid" : "ask", reduce_only: opts?.reduceOnly ?? false, tif: (opts?.tif ?? "GTC") as import("../pacifica/types/order.js").TimeInForce },
      this.account,
      this.signMessage
    );
  }

  async cancelOrder(symbol: string, orderId: string) {
    this.ensureSigner();
    return this.client.cancelOrder(
      { symbol, order_id: Number(orderId) },
      this.account,
      this.signMessage
    );
  }

  async cancelAllOrders(symbol?: string) {
    this.ensureSigner();
    if (symbol) {
      // Cancel only orders for this symbol: fetch open orders, filter, cancel individually
      const orders = await this.getOpenOrders();
      const filtered = orders.filter(o => o.symbol.toUpperCase() === symbol.toUpperCase());
      const results = [];
      for (const o of filtered) {
        results.push(await this.cancelOrder(o.symbol, o.orderId));
      }
      return results;
    }
    return this.client.cancelAllOrders(
      { all_symbols: true, exclude_reduce_only: false },
      this.account,
      this.signMessage
    );
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    this.ensureSigner();
    return this.client.editOrder(
      { symbol, order_id: Number(orderId), price, amount: size },
      this.account,
      this.signMessage
    );
  }

  async setLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross") {
    this.ensureSigner();
    await this.client.updateLeverage(
      { symbol, leverage },
      this.account,
      this.signMessage
    );
    if (marginMode === "isolated") {
      await this.client.updateMarginMode(
        { symbol, is_isolated: true },
        this.account,
        this.signMessage
      );
    }
    return { symbol, leverage, marginMode };
  }

  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean }) {
    this.ensureSigner();
    return this.client.createStopOrder(
      {
        symbol,
        side: side === "buy" ? "bid" : "ask",
        reduce_only: opts?.reduceOnly ?? false,
        stop_order: { stop_price: triggerPrice, amount: size, limit_price: opts?.limitPrice },
      },
      this.account,
      this.signMessage
    );
  }

  async withdraw(amount: string, destination: string, _opts?: { assetId?: number; routeType?: number }): Promise<unknown> {
    this.ensureSigner();
    return this.client.withdraw(
      { amount, dest_address: destination },
      this.account,
      this.signMessage,
    );
  }

  async getRecentTrades(symbol: string, _limit = 20): Promise<ExchangeTrade[]> {
    const trades = await this.client.getTrades(symbol);
    // Deduplicate by time+price+size+side (API sometimes returns duplicate entries)
    const seen = new Set<string>();
    const unique = trades.filter((t) => {
      const key = `${t.created_at}:${t.price}:${t.amount}:${t.side}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.slice(0, _limit).map((t) => ({
      time: Number(t.created_at ?? 0),
      symbol,
      side: t.side === "bid" ? "buy" as const : "sell" as const,
      price: t.price,
      size: t.amount,
      fee: String((t as unknown as Record<string, unknown>).fee ?? "0"),
    }));
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string | null }[]> {
    const result = await this.client.getFundingHistory(symbol, { limit });
    const data = ((result as Record<string, unknown>).data ?? result) as Record<string, unknown>[];
    if (!Array.isArray(data)) return [];
    return data.map((h) => ({
      time: Number(h.created_at ?? 0),
      rate: String(h.funding_rate ?? "0"),
      price: String(h.oracle_price ?? "0"),
    }));
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const klines = await this.client.getKline(
      symbol,
      interval as Parameters<typeof this.client.getKline>[1],
      startTime,
      endTime
    );
    return klines.map((k) => ({
      time: k.t,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
      volume: k.v,
      trades: k.n,
    }));
  }

  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const result = await this.client.getOrderHistory(this.account) as Record<string, unknown>;
    const data = (result.data ?? result.orders ?? []) as Record<string, unknown>[];
    if (!Array.isArray(data)) return [];
    return data.slice(0, limit).map((o) => ({
      orderId: String(o.order_id ?? ""),
      symbol: String(o.symbol ?? ""),
      side: String(o.side) === "bid" ? "buy" as const : "sell" as const,
      price: String(o.initial_price ?? o.price ?? "0"),
      size: String(o.amount ?? o.initial_amount ?? ""),
      filled: String(o.filled_amount ?? "0"),
      status: String(o.order_status ?? "done"),
      type: String(o.order_type ?? ""),
    }));
  }

  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const raw = await this.client.getTradeHistory(this.account);
    const trades = ((raw as Record<string, unknown>).data ?? raw) as Record<string, unknown>[];
    if (!Array.isArray(trades)) return [];
    return trades.slice(0, limit).map((t) => ({
      time: Number(t.created_at ?? 0),
      symbol: String(t.symbol ?? ""),
      side: String(t.side) === "bid" ? "buy" as const : "sell" as const,
      price: String(t.price ?? "0"),
      size: String(t.amount ?? ""),
      fee: String(t.fee ?? "0"),
    }));
  }

  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    if (!this._hasRealKey) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const raw = await this.client.getFundingAccountHistory(this.account);
    const history = ((raw as Record<string, unknown>).data ?? raw) as Record<string, unknown>[];
    if (!Array.isArray(history)) return [];
    return history.slice(0, limit).map((h) => ({
      time: Number(h.created_at ?? 0),
      symbol: String(h.symbol ?? ""),
      payment: String(h.payout ?? "0"),
    }));
  }
}
