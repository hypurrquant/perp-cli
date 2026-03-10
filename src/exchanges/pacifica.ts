import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
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

function makeSignMessage(keypair: Keypair) {
  return async (message: Uint8Array): Promise<Uint8Array> => {
    return nacl.sign.detached(message, keypair.secretKey);
  };
}

export class PacificaAdapter implements ExchangeAdapter {
  readonly name = "pacifica";
  private client: PacificaClient;
  readonly keypair: Keypair;
  private account: string;
  private signMessage: (msg: Uint8Array) => Promise<Uint8Array>;

  constructor(keypair: Keypair, network: Network = "mainnet", builderCode?: string) {
    this.keypair = keypair;
    this.account = keypair.publicKey.toBase58();
    this.client = new PacificaClient({ network, builderCode });
    this.signMessage = makeSignMessage(keypair);
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
    const [markets, prices] = await Promise.all([
      this.client.getInfo(),
      this.client.getPrices(),
    ]);
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));
    return markets.map((m) => {
      const p = priceMap.get(m.symbol);
      return {
        symbol: m.symbol,
        markPrice: p?.mark ?? "-",
        indexPrice: p?.oracle ?? "-",
        fundingRate: m.funding_rate,
        volume24h: p?.volume_24h ?? "-",
        openInterest: p?.open_interest ?? "-",
        maxLeverage: m.max_leverage,
      };
    });
  }

  async getOrderbook(symbol: string) {
    const book = await this.client.getBook(symbol);
    return {
      bids: book.l[0].map((e) => [e.p, e.a] as [string, string]),
      asks: book.l[1].map((e) => [e.p, e.a] as [string, string]),
    };
  }

  async getBalance(): Promise<ExchangeBalance> {
    const info = await this.client.getAccount(this.account);
    const raw = info as unknown as Record<string, unknown>;
    return {
      equity: info.account_equity,
      available: info.available_to_spend,
      marginUsed: String(raw.total_margin_used ?? raw.margin_used ?? "0"),
      unrealizedPnl: String(
        Number(info.account_equity) - Number(info.balance)
      ),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const [positions, prices] = await Promise.all([
      this.client.getPositions(this.account),
      this.client.getPrices(),
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
      const mark = priceMap.get(p.symbol)?.mark ?? "0";
      const entryPrice = Number(p.entry_price);
      const amount = Number(p.amount);
      const markNum = Number(mark);
      const side = p.side === "bid" ? "long" : "short";
      const pnl =
        side === "long"
          ? (markNum - entryPrice) * amount
          : (entryPrice - markNum) * amount;

      return {
        symbol: p.symbol,
        side: side as "long" | "short",
        size: String(p.amount),
        entryPrice: String(p.entry_price),
        markPrice: mark,
        liquidationPrice: String(p.liquidation_price ?? "N/A"),
        unrealizedPnl: pnl.toFixed(4),
        leverage: levMap.get(String(p.symbol)) ?? 1,
      };
    });
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
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

  async marketOrder(symbol: string, side: "buy" | "sell", size: string) {
    return this.client.createMarketOrder(
      { symbol, amount: size, side: side === "buy" ? "bid" : "ask", reduce_only: false, slippage_percent: "1" },
      this.account,
      this.signMessage
    );
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string }) {
    return this.client.createLimitOrder(
      { symbol, price, amount: size, side: side === "buy" ? "bid" : "ask", reduce_only: opts?.reduceOnly ?? false, tif: (opts?.tif ?? "GTC") as import("../pacifica/types/order.js").TimeInForce },
      this.account,
      this.signMessage
    );
  }

  async cancelOrder(symbol: string, orderId: string) {
    return this.client.cancelOrder(
      { symbol, order_id: Number(orderId) },
      this.account,
      this.signMessage
    );
  }

  async cancelAllOrders(_symbol?: string) {
    return this.client.cancelAllOrders(
      { all_symbols: true, exclude_reduce_only: false },
      this.account,
      this.signMessage
    );
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    return this.client.editOrder(
      { symbol, order_id: Number(orderId), price, amount: size },
      this.account,
      this.signMessage
    );
  }

  async setLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross") {
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

  async getRecentTrades(symbol: string, _limit = 20): Promise<ExchangeTrade[]> {
    const trades = await this.client.getTrades(symbol);
    return trades.slice(0, _limit).map((t) => ({
      time: new Date(t.created_at).getTime(),
      symbol,
      side: t.side === "bid" ? "buy" as const : "sell" as const,
      price: t.price,
      size: t.amount,
      fee: "0",
    }));
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string }[]> {
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

  async getFundingPayments(limit = 30): Promise<ExchangeFundingPayment[]> {
    const raw = await this.client.getFundingAccountHistory(this.account);
    const history = ((raw as Record<string, unknown>).data ?? raw) as Record<string, unknown>[];
    if (!Array.isArray(history)) return [];
    return history.slice(0, limit).map((h) => ({
      time: Number(h.created_at ?? 0),
      symbol: String(h.symbol ?? ""),
      payment: String(h.amount ?? "0"),
    }));
  }
}
