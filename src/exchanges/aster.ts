/**
 * Aster DEX adapter — Binance Futures API compatible REST wrapper.
 * Docs: https://docs.asterdex.com/product/aster-perpetuals/api/api-documentation
 * Base: https://fapi.asterdex.com
 */

import { createHmac } from "node:crypto";
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

export class AsterAdapter implements ExchangeAdapter {
  readonly name = "aster";
  readonly chain = "bnb";
  readonly aliases = ["ast"] as const;

  private _apiKey: string;
  private _apiSecret: string;
  private _baseUrl: string;
  private _testnet: boolean;
  private _marketsCache: ExchangeMarketInfo[] | null = null;
  private _marketsCacheTime = 0;
  private _accountCache: { data: unknown; time: number } | null = null;
  private _positionsCache: { data: unknown; time: number } | null = null;
  private _ordersCache: { data: unknown; time: number } | null = null;
  private static readonly CACHE_TTL = 30_000; // 30 seconds (markets)
  private static readonly ACCOUNT_CACHE_TTL = 5_000; // 5 seconds (account/positions/orders)

  constructor(apiKey?: string, apiSecret?: string, testnet = false) {
    this._apiKey = apiKey || process.env.ASTER_API_KEY || "";
    this._apiSecret = apiSecret || process.env.ASTER_API_SECRET || "";
    this._testnet = testnet;
    this._baseUrl = testnet
      ? (process.env.ASTER_TESTNET_URL || "https://testnet.asterdex.com")
      : "https://fapi.asterdex.com";
  }

  get isReadOnly(): boolean {
    return !this._apiKey || !this._apiSecret;
  }

  /** CLI symbol → Aster API symbol (ETH → ETHUSDT) */
  private _toApi(symbol: string): string {
    const s = symbol.toUpperCase().replace(/-PERP$/, "");
    if (s.endsWith("USDT") || s.endsWith("BUSD")) return s;
    return `${s}USDT`;
  }

  /** Aster API symbol → CLI symbol (ETHUSDT → ETH) */
  private _fromApi(symbol: string): string {
    return symbol.replace(/USDT$/, "").replace(/BUSD$/, "");
  }

  async init(): Promise<void> {
    // Verify connectivity by fetching server time
    await this._publicGet("/fapi/v1/time");
  }

  // ── Market Data ──

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    // Return cached result if fresh
    if (this._marketsCache && Date.now() - this._marketsCacheTime < AsterAdapter.CACHE_TTL) {
      return this._marketsCache;
    }

    const [info, tickers] = await Promise.all([
      this._publicGet("/fapi/v1/exchangeInfo") as Promise<{ symbols?: Array<Record<string, unknown>> }>,
      this._publicGet("/fapi/v1/ticker/24hr") as Promise<Array<Record<string, unknown>>>,
    ]);

    const tickerMap = new Map<string, Record<string, unknown>>();
    for (const t of tickers ?? []) {
      tickerMap.set(String(t.symbol), t);
    }

    // Also fetch premium index for mark/index/funding
    let premiumMap = new Map<string, Record<string, unknown>>();
    try {
      const premiums = await this._publicGet("/fapi/v1/premiumIndex") as Array<Record<string, unknown>>;
      premiumMap = new Map(premiums.map(p => [String(p.symbol), p]));
    } catch { /* non-critical */ }

    const tradingSymbols = (info?.symbols ?? [])
      .filter((s) => String(s.contractType) === "PERPETUAL" && String(s.status) === "TRADING");

    // OI is fetched lazily per symbol (see getMarketInfo) to avoid 300+ API calls
    const result = tradingSymbols
      .map((s) => {
        const sym = String(s.symbol);
        const ticker = tickerMap.get(sym);
        const premium = premiumMap.get(sym);
        const maxLev = Number(s.maxLeverage ?? 50);

        const lotFilter = (s.filters as Array<Record<string, unknown>> | undefined)
          ?.find(f => f.filterType === "LOT_SIZE");

        return {
          symbol: this._fromApi(sym),
          markPrice: String(premium?.markPrice ?? ticker?.lastPrice ?? "0"),
          indexPrice: String(premium?.indexPrice ?? "0"),
          fundingRate: premium?.lastFundingRate != null ? String(premium.lastFundingRate) : null,
          volume24h: String(ticker?.quoteVolume ?? ticker?.volume ?? "0"),
          openInterest: "0",
          maxLeverage: maxLev,
          sizeDecimals: s.quantityPrecision != null ? Number(s.quantityPrecision) : undefined,
          stepSize: lotFilter?.stepSize != null ? String(lotFilter.stepSize) : undefined,
        };
      });

    this._marketsCache = result;
    this._marketsCacheTime = Date.now();
    return result;
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const res = await this._publicGet("/fapi/v1/depth", { symbol: this._toApi(symbol), limit: "50" }) as {
      bids?: [string, string][];
      asks?: [string, string][];
    };
    return {
      bids: res?.bids ?? [],
      asks: res?.asks ?? [],
    };
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangeTrade[]> {
    const trades = await this._publicGet("/fapi/v1/trades", {
      symbol: this._toApi(symbol),
      limit: String(limit),
    }) as Array<Record<string, unknown>>;

    return (trades ?? []).map((t) => ({
      time: Number(t.time ?? 0),
      symbol: this._fromApi(String(t.symbol ?? symbol)),
      side: t.isBuyerMaker ? "sell" as const : "buy" as const,
      price: String(t.price ?? "0"),
      size: String(t.qty ?? "0"),
      fee: "0",
    }));
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string | null }[]> {
    const data = await this._publicGet("/fapi/v1/fundingRate", {
      symbol: this._toApi(symbol),
      limit: String(limit),
    }) as Array<Record<string, unknown>>;

    return (data ?? []).map((d) => ({
      time: Number(d.fundingTime ?? 0),
      rate: String(d.fundingRate ?? "0"),
      price: d.markPrice ? String(d.markPrice) : null,
    }));
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const data = await this._publicGet("/fapi/v1/klines", {
      symbol: this._toApi(symbol),
      interval,
      startTime: String(startTime),
      endTime: String(endTime),
      limit: "500",
    }) as Array<unknown[]>;

    return (data ?? []).map((k) => ({
      time: Number(k[0]),
      open: String(k[1]),
      high: String(k[2]),
      low: String(k[3]),
      close: String(k[4]),
      volume: String(k[5]),
      trades: Number(k[8] ?? 0),
    }));
  }

  // ── Account ──

  async getBalance(): Promise<ExchangeBalance> {
    if (this._accountCache && Date.now() - this._accountCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._accountCache.data as ExchangeBalance;
    }
    const account = await this._signedGet("/fapi/v2/account") as Record<string, unknown>;

    const totalWallet = Number(account.totalWalletBalance ?? 0);
    const unrealizedPnl = Number(account.totalUnrealizedProfit ?? 0);
    const available = Number(account.availableBalance ?? 0);
    const marginUsed = Number(account.totalInitialMargin ?? 0);

    const result = {
      equity: String(totalWallet + unrealizedPnl),
      available: String(available),
      marginUsed: String(marginUsed),
      unrealizedPnl: String(unrealizedPnl),
    };
    this._accountCache = { data: result, time: Date.now() };
    return result;
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (this._positionsCache && Date.now() - this._positionsCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._positionsCache.data as ExchangePosition[];
    }
    const data = await this._signedGet("/fapi/v2/positionRisk") as Array<Record<string, unknown>>;

    const result = (data ?? [])
      .filter((p) => Number(p.positionAmt ?? 0) !== 0)
      .map((p) => {
        const amt = Number(p.positionAmt ?? 0);
        return {
          symbol: this._fromApi(String(p.symbol ?? "")),
          side: amt > 0 ? "long" as const : "short" as const,
          size: String(Math.abs(amt)),
          entryPrice: String(p.entryPrice ?? "0"),
          markPrice: String(p.markPrice ?? "0"),
          liquidationPrice: String(p.liquidationPrice ?? "0"),
          unrealizedPnl: String(p.unRealizedProfit ?? "0"),
          leverage: Number(p.leverage ?? 1),
        };
      });
    this._positionsCache = { data: result, time: Date.now() };
    return result;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    if (this._ordersCache && Date.now() - this._ordersCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._ordersCache.data as ExchangeOrder[];
    }
    const orders = await this._signedGet("/fapi/v1/openOrders") as Array<Record<string, unknown>>;

    const result = (orders ?? []).map((o) => ({
      orderId: String(o.orderId ?? ""),
      symbol: this._fromApi(String(o.symbol ?? "")),
      side: String(o.side).toLowerCase() as "buy" | "sell",
      price: String(o.price ?? "0"),
      size: String(o.origQty ?? "0"),
      filled: String(o.executedQty ?? "0"),
      status: String(o.status ?? ""),
      type: String(o.type ?? ""),
    }));
    this._ordersCache = { data: result, time: Date.now() };
    return result;
  }

  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    // allOrders requires symbol — get from positions or recent trades
    const positions = await this.getPositions();
    const apiSymbols = new Set(positions.map(p => this._toApi(p.symbol)));
    if (apiSymbols.size === 0) {
      // Fallback: query the most common perp symbols when no open positions exist
      for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]) {
        apiSymbols.add(s);
      }
    }

    const allOrders: ExchangeOrder[] = [];
    for (const sym of apiSymbols) {
      try {
        const orders = await this._signedGet("/fapi/v1/allOrders", {
          symbol: sym,
          limit: String(limit),
        }) as Array<Record<string, unknown>>;

        for (const o of orders ?? []) {
          allOrders.push({
            orderId: String(o.orderId ?? ""),
            symbol: this._fromApi(String(o.symbol ?? "")),
            side: String(o.side).toLowerCase() as "buy" | "sell",
            price: String(o.price ?? "0"),
            size: String(o.origQty ?? "0"),
            filled: String(o.executedQty ?? "0"),
            status: String(o.status ?? ""),
            type: String(o.type ?? ""),
          });
        }
      } catch { /* skip */ }
    }
    return allOrders.slice(0, limit);
  }

  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    const positions = await this.getPositions();
    const apiSymbols = new Set(positions.map(p => this._toApi(p.symbol)));
    if (apiSymbols.size === 0) apiSymbols.add("BTCUSDT");

    const allTrades: ExchangeTrade[] = [];
    for (const sym of apiSymbols) {
      try {
        const trades = await this._signedGet("/fapi/v1/userTrades", {
          symbol: sym,
          limit: String(limit),
        }) as Array<Record<string, unknown>>;

        for (const t of trades ?? []) {
          allTrades.push({
            time: Number(t.time ?? 0),
            symbol: this._fromApi(String(t.symbol ?? "")),
            side: t.buyer ? "buy" as const : "sell" as const,
            price: String(t.price ?? "0"),
            size: String(t.qty ?? "0"),
            fee: String(t.commission ?? "0"),
          });
        }
      } catch { /* skip */ }
    }
    return allTrades.sort((a, b) => b.time - a.time).slice(0, limit);
  }

  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    const data = await this._signedGet("/fapi/v1/income", {
      incomeType: "FUNDING_FEE",
      limit: String(limit),
    }) as Array<Record<string, unknown>>;

    return (data ?? []).map((f) => ({
      time: Number(f.time ?? 0),
      symbol: this._fromApi(String(f.symbol ?? "")),
      payment: String(f.income ?? "0"),
    }));
  }

  // ── Trading ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string): Promise<unknown> {
    const result = await this._signedPost("/fapi/v1/order", {
      symbol: this._toApi(symbol),
      side: side.toUpperCase(),
      type: "MARKET",
      quantity: size,
    });
    // Validate fill — Binance-style API returns 200 even for 0-fill orders
    const r = result as Record<string, unknown>;
    const executedQty = Number(r.executedQty ?? 0);
    if (executedQty === 0) {
      throw new Error(`Market ${side} ${symbol}: order accepted but 0 filled (status: ${r.status}, orderId: ${r.orderId})`);
    }
    return result;
  }

  async limitOrder(
    symbol: string,
    side: "buy" | "sell",
    price: string,
    size: string,
    opts?: { reduceOnly?: boolean; tif?: string },
  ): Promise<unknown> {
    const params: Record<string, string> = {
      symbol: this._toApi(symbol),
      side: side.toUpperCase(),
      type: "LIMIT",
      price,
      quantity: size,
      timeInForce: opts?.tif?.toUpperCase() || "GTC",
    };
    if (opts?.reduceOnly) params.reduceOnly = "true";
    return this._signedPost("/fapi/v1/order", params);
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    // Aster has no atomic edit — cancel + replace
    const openOrders = await this.getOpenOrders();
    const existing = openOrders.find(o => o.orderId === orderId);
    const side = existing?.side ?? "buy";

    await this.cancelOrder(symbol, orderId);
    return this.limitOrder(symbol, side, price, size);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    return this._signedDelete("/fapi/v1/order", {
      symbol: this._toApi(symbol),
      orderId,
    });
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    if (!symbol) {
      // Cancel all for all symbols with open orders
      const orders = await this.getOpenOrders();
      const apiSymbols = new Set(orders.map(o => this._toApi(o.symbol)));
      const results = [];
      for (const sym of apiSymbols) {
        results.push(await this._signedDelete("/fapi/v1/allOpenOrders", { symbol: sym }));
      }
      return results;
    }
    return this._signedDelete("/fapi/v1/allOpenOrders", { symbol: this._toApi(symbol) });
  }

  // ── Risk ──

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<unknown> {
    // Set margin type first if specified
    if (marginMode) {
      try {
        await this._signedPost("/fapi/v1/marginType", {
          symbol: this._toApi(symbol),
          marginType: marginMode === "cross" ? "CROSSED" : "ISOLATED",
        });
      } catch {
        // May fail if already set — non-critical
      }
    }
    return this._signedPost("/fapi/v1/leverage", {
      symbol: this._toApi(symbol),
      leverage: String(leverage),
    });
  }

  async stopOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    triggerPrice: string,
    opts?: { limitPrice?: string; reduceOnly?: boolean },
  ): Promise<unknown> {
    const params: Record<string, string> = {
      symbol: this._toApi(symbol),
      side: side.toUpperCase(),
      quantity: size,
      stopPrice: triggerPrice,
      type: opts?.limitPrice ? "STOP" : "STOP_MARKET",
    };
    if (opts?.limitPrice) {
      params.price = opts.limitPrice;
      params.timeInForce = "GTC";
    }
    if (opts?.reduceOnly) params.reduceOnly = "true";
    return this._signedPost("/fapi/v1/order", params);
  }

  // ── Withdraw (unified interface) ──

  async withdraw(amount: string, _destination: string, _opts?: { assetId?: number; routeType?: number }): Promise<unknown> {
    // Aster withdrawal is via separate spot/wallet API, not futures API
    throw new Error("Aster withdrawal requires the spot API (not available in futures mode). Use the Aster web UI to withdraw.");
  }

  // ── Internal HTTP helpers ──

  private _sign(params: Record<string, string>): string {
    params.timestamp = String(Date.now());
    params.recvWindow = "5000";
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const signature = createHmac("sha256", this._apiSecret)
      .update(queryString)
      .digest("hex");
    return `${queryString}&signature=${signature}`;
  }

  /** Handle 429 rate limit with retry */
  private async _handleResponse(res: Response, method: string, path: string, attempt = 0): Promise<unknown> {
    if (res.status === 429) {
      if (attempt >= 2) throw new Error(`${method} ${path} rate limited after ${attempt + 1} attempts`);
      const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
      const waitMs = Math.min(retryAfter * 1000, 30000);
      await new Promise(r => setTimeout(r, waitMs));
      return null; // signal retry
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  private async _publicGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${this._baseUrl}${path}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url);
      const result = await this._handleResponse(res, "GET", path, attempt);
      if (result !== null) return result;
    }
    throw new Error(`GET ${path} failed: max retries exceeded`);
  }

  private async _signedGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No API key configured for Aster. Set ASTER_API_KEY and ASTER_API_SECRET in ~/.perp/.env");
    for (let attempt = 0; attempt < 3; attempt++) {
      const signed = this._sign({ ...params });
      const url = `${this._baseUrl}${path}?${signed}`;
      const res = await fetch(url, {
        headers: { "X-MBX-APIKEY": this._apiKey },
      });
      const result = await this._handleResponse(res, "GET", path, attempt);
      if (result !== null) return result;
    }
    throw new Error(`GET ${path} failed: max retries exceeded`);
  }

  private async _signedPost(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No API key configured for Aster. Set ASTER_API_KEY and ASTER_API_SECRET in ~/.perp/.env");
    for (let attempt = 0; attempt < 3; attempt++) {
      const signed = this._sign({ ...params });
      const res = await fetch(`${this._baseUrl}${path}`, {
        method: "POST",
        headers: {
          "X-MBX-APIKEY": this._apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: signed,
      });
      const result = await this._handleResponse(res, "POST", path, attempt);
      if (result !== null) return result;
    }
    throw new Error(`POST ${path} failed: max retries exceeded`);
  }

  private async _signedDelete(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No API key configured for Aster. Set ASTER_API_KEY and ASTER_API_SECRET in ~/.perp/.env");
    for (let attempt = 0; attempt < 3; attempt++) {
      const signed = this._sign({ ...params });
      const res = await fetch(`${this._baseUrl}${path}?${signed}`, {
        method: "DELETE",
        headers: { "X-MBX-APIKEY": this._apiKey },
      });
      const result = await this._handleResponse(res, "DELETE", path, attempt);
      if (result !== null) return result;
    }
    throw new Error(`DELETE ${path} failed: max retries exceeded`);
  }
}
