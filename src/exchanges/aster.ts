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

  async init(): Promise<void> {
    // Verify connectivity by fetching server time
    await this._publicGet("/fapi/v1/time");
  }

  // ── Market Data ──

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
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

    // Fetch open interest per symbol in parallel (batched to avoid overwhelming the API).
    // The /fapi/v1/ticker/24hr response does NOT include openInterest — need a separate endpoint.
    const oiMap = new Map<string, string>();
    const OI_BATCH = 20;
    for (let i = 0; i < tradingSymbols.length; i += OI_BATCH) {
      const batch = tradingSymbols.slice(i, i + OI_BATCH);
      const results = await Promise.allSettled(
        batch.map(async (s) => {
          const sym = String(s.symbol);
          const res = await this._publicGet("/fapi/v1/openInterest", { symbol: sym }) as Record<string, unknown>;
          return { sym, oi: String(res?.openInterest ?? "0") };
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled") oiMap.set(r.value.sym, r.value.oi);
      }
    }

    return tradingSymbols
      .map((s) => {
        const sym = String(s.symbol);
        const ticker = tickerMap.get(sym);
        const premium = premiumMap.get(sym);
        // Extract max leverage from leverage brackets if available
        const maxLev = Number(s.maxLeverage ?? 50);

        return {
          symbol: sym,
          markPrice: String(premium?.markPrice ?? ticker?.lastPrice ?? "0"),
          indexPrice: String(premium?.indexPrice ?? "0"),
          fundingRate: String(premium?.lastFundingRate ?? "0"),
          volume24h: String(ticker?.quoteVolume ?? ticker?.volume ?? "0"),
          openInterest: oiMap.get(sym) ?? "0",
          maxLeverage: maxLev,
        };
      });
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const res = await this._publicGet("/fapi/v1/depth", { symbol: symbol.toUpperCase(), limit: "50" }) as {
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
      symbol: symbol.toUpperCase(),
      limit: String(limit),
    }) as Array<Record<string, unknown>>;

    return (trades ?? []).map((t) => ({
      time: Number(t.time ?? 0),
      symbol: symbol.toUpperCase(),
      side: t.isBuyerMaker ? "sell" as const : "buy" as const,
      price: String(t.price ?? "0"),
      size: String(t.qty ?? "0"),
      fee: "0",
    }));
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string | null }[]> {
    const data = await this._publicGet("/fapi/v1/fundingRate", {
      symbol: symbol.toUpperCase(),
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
      symbol: symbol.toUpperCase(),
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
    const account = await this._signedGet("/fapi/v2/account") as Record<string, unknown>;

    const totalWallet = Number(account.totalWalletBalance ?? 0);
    const unrealizedPnl = Number(account.totalUnrealizedProfit ?? 0);
    const available = Number(account.availableBalance ?? 0);
    const marginUsed = Number(account.totalInitialMargin ?? 0);

    return {
      equity: String(totalWallet + unrealizedPnl),
      available: String(available),
      marginUsed: String(marginUsed),
      unrealizedPnl: String(unrealizedPnl),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const data = await this._signedGet("/fapi/v2/positionRisk") as Array<Record<string, unknown>>;

    return (data ?? [])
      .filter((p) => Number(p.positionAmt ?? 0) !== 0)
      .map((p) => {
        const amt = Number(p.positionAmt ?? 0);
        return {
          symbol: String(p.symbol ?? ""),
          side: amt > 0 ? "long" as const : "short" as const,
          size: String(Math.abs(amt)),
          entryPrice: String(p.entryPrice ?? "0"),
          markPrice: String(p.markPrice ?? "0"),
          liquidationPrice: String(p.liquidationPrice ?? "0"),
          unrealizedPnl: String(p.unRealizedProfit ?? "0"),
          leverage: Number(p.leverage ?? 1),
        };
      });
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    const orders = await this._signedGet("/fapi/v1/openOrders") as Array<Record<string, unknown>>;

    return (orders ?? []).map((o) => ({
      orderId: String(o.orderId ?? ""),
      symbol: String(o.symbol ?? ""),
      side: String(o.side).toLowerCase() as "buy" | "sell",
      price: String(o.price ?? "0"),
      size: String(o.origQty ?? "0"),
      filled: String(o.executedQty ?? "0"),
      status: String(o.status ?? ""),
      type: String(o.type ?? ""),
    }));
  }

  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    // allOrders requires symbol — get from positions or recent trades
    const positions = await this.getPositions();
    const symbols = new Set(positions.map(p => p.symbol));
    if (symbols.size === 0) {
      // Fallback: query the most common perp symbols when no open positions exist
      for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]) {
        symbols.add(s);
      }
    }

    const allOrders: ExchangeOrder[] = [];
    for (const sym of symbols) {
      try {
        const orders = await this._signedGet("/fapi/v1/allOrders", {
          symbol: sym,
          limit: String(limit),
        }) as Array<Record<string, unknown>>;

        for (const o of orders ?? []) {
          allOrders.push({
            orderId: String(o.orderId ?? ""),
            symbol: String(o.symbol ?? ""),
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
    const symbols = new Set(positions.map(p => p.symbol));
    if (symbols.size === 0) symbols.add("BTCUSDT");

    const allTrades: ExchangeTrade[] = [];
    for (const sym of symbols) {
      try {
        const trades = await this._signedGet("/fapi/v1/userTrades", {
          symbol: sym,
          limit: String(limit),
        }) as Array<Record<string, unknown>>;

        for (const t of trades ?? []) {
          allTrades.push({
            time: Number(t.time ?? 0),
            symbol: String(t.symbol ?? ""),
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
      symbol: String(f.symbol ?? ""),
      payment: String(f.income ?? "0"),
    }));
  }

  // ── Trading ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string): Promise<unknown> {
    return this._signedPost("/fapi/v1/order", {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: "MARKET",
      quantity: size,
    });
  }

  async limitOrder(
    symbol: string,
    side: "buy" | "sell",
    price: string,
    size: string,
    opts?: { reduceOnly?: boolean; tif?: string },
  ): Promise<unknown> {
    const params: Record<string, string> = {
      symbol: symbol.toUpperCase(),
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
      symbol: symbol.toUpperCase(),
      orderId,
    });
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    if (!symbol) {
      // Cancel all for all symbols with open orders
      const orders = await this.getOpenOrders();
      const symbols = new Set(orders.map(o => o.symbol));
      const results = [];
      for (const sym of symbols) {
        results.push(await this._signedDelete("/fapi/v1/allOpenOrders", { symbol: sym }));
      }
      return results;
    }
    return this._signedDelete("/fapi/v1/allOpenOrders", { symbol: symbol.toUpperCase() });
  }

  // ── Risk ──

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<unknown> {
    // Set margin type first if specified
    if (marginMode) {
      try {
        await this._signedPost("/fapi/v1/marginType", {
          symbol: symbol.toUpperCase(),
          marginType: marginMode === "cross" ? "CROSSED" : "ISOLATED",
        });
      } catch {
        // May fail if already set — non-critical
      }
    }
    return this._signedPost("/fapi/v1/leverage", {
      symbol: symbol.toUpperCase(),
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
      symbol: symbol.toUpperCase(),
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

  private async _publicGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${this._baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  private async _signedGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No API key configured for Aster. Set ASTER_API_KEY and ASTER_API_SECRET in ~/.perp/.env");
    const signed = this._sign({ ...params });
    const url = `${this._baseUrl}${path}?${signed}`;
    const res = await fetch(url, {
      headers: { "X-MBX-APIKEY": this._apiKey },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  private async _signedPost(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No API key configured for Aster. Set ASTER_API_KEY and ASTER_API_SECRET in ~/.perp/.env");
    const signed = this._sign({ ...params });
    const res = await fetch(`${this._baseUrl}${path}`, {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": this._apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: signed,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  private async _signedDelete(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No API key configured for Aster. Set ASTER_API_KEY and ASTER_API_SECRET in ~/.perp/.env");
    const signed = this._sign({ ...params });
    const res = await fetch(`${this._baseUrl}${path}?${signed}`, {
      method: "DELETE",
      headers: { "X-MBX-APIKEY": this._apiKey },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DELETE ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}
