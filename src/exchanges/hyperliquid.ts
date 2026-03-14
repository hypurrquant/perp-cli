import { Hyperliquid } from "hyperliquid";
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
import type { EvmSigner } from "../signer/interface.js";
import { LocalEvmSigner } from "../signer/evm-local.js";

export class HyperliquidAdapter implements ExchangeAdapter {
  readonly name = "hyperliquid";
  private sdk: Hyperliquid;
  private _address: string;
  private _privateKey: string;
  private _testnet: boolean;
  private _evmSigner?: EvmSigner;
  private _assetMap: Map<string, number> = new Map();
  private _assetMapReverse: Map<number, string> = new Map();
  private _szDecimalsMap: Map<string, number> = new Map(); // symbol → szDecimals
  /** HIP-3 deployed perp dex name. Empty string = native (validator) perps. */
  private _dex: string = "";
  // In-memory cache removed — using file-based cache (src/cache.ts) for cross-process dedup

  constructor(privateKey?: string, testnet = false) {
    // Disable WebSocket in SDK — we use REST for all info calls and raw
    // fetch for /exchange. This avoids the false "Please install ws" warning
    // caused by the SDK's require('ws') failing in ESM context.
    this.sdk = new Hyperliquid({
      privateKey,
      testnet,
      walletAddress: undefined,
      enableWs: false,
    });
    this._address = "";
    this._privateKey = privateKey ?? "";
    this._testnet = testnet;
  }

  /** Set the HIP-3 deployed perp dex to query/trade on. */
  setDex(dex: string): void {
    this._dex = dex;
    // Rebuild asset map for the new dex
    this._assetMap.clear();
    this._assetMapReverse.clear();
  }

  get dex(): string {
    return this._dex;
  }

  get client(): Hyperliquid {
    return this.sdk;
  }

  get address(): string {
    return this._address;
  }

  get isTestnet(): boolean {
    return this._testnet;
  }

  /** Inject an external EVM signer. Call before init() to skip LocalEvmSigner creation. */
  setSigner(signer: EvmSigner): void {
    this._evmSigner = signer;
  }

  async init(): Promise<void> {
    // Suppress "WebSocket connected" noise from hyperliquid SDK
    const origLog = console.log;
    console.log = () => {};
    try { await this.sdk.connect(); } finally { console.log = origLog; }

    // Initialize EVM signer if not externally injected (skip if no key — read-only mode)
    if (!this._evmSigner && this._privateKey) {
      this._evmSigner = await LocalEvmSigner.create(this._privateKey);
      this._address = this._evmSigner.getAddress();
    }

    // Build asset index map
    await this._loadAssetMap();
  }

  /** Load asset index map — supports native and HIP-3 dex. */
  private async _loadAssetMap(): Promise<void> {
    try {
      if (this._dex) {
        // HIP-3 deployed dex: use raw info POST with dex param
        const meta = await this._infoPost({ type: "meta", dex: this._dex }) as { universe?: { name: string }[] };
        if (meta?.universe) {
          meta.universe.forEach((asset, idx) => {
            // Store both with and without dex prefix for flexible lookup
            // API returns "km:GOOGL" but callers may use "GOOGL" or "KM:GOOGL"
            const fullName = asset.name; // e.g., "km:GOOGL"
            const baseName = fullName.includes(":") ? fullName.split(":").pop()! : fullName;
            this._assetMap.set(fullName, idx);
            this._assetMap.set(baseName, idx);
            this._assetMapReverse.set(idx, fullName);
          });
        }
      } else {
        const meta = await this.sdk.info.perpetuals.getMeta();
        if (meta && meta.universe) {
          meta.universe.forEach((asset: { name: string; szDecimals?: number }, idx: number) => {
            this._assetMap.set(asset.name, idx);
            this._assetMapReverse.set(idx, asset.name);
            if (asset.szDecimals !== undefined) {
              this._szDecimalsMap.set(asset.name, asset.szDecimals);
            }
          });
        }
      }
    } catch (e) {
      console.error("[hyperliquid] Failed to load asset map:", e instanceof Error ? e.message : e);
    }
  }

  /**
   * Resolve a symbol to the canonical name in the asset map.
   * Handles: "ICP" → "ICP-PERP", "BTC-PERP" → "BTC-PERP", "km:GOOGL" → "km:GOOGL"
   */
  resolveSymbol(symbol: string): string {
    const sym = symbol.toUpperCase();
    if (this._assetMap.has(sym)) return sym;
    if (this._assetMap.has(`${sym}-PERP`)) return `${sym}-PERP`;
    if (sym.endsWith("-PERP") && this._assetMap.has(sym.replace(/-PERP$/, ""))) return sym.replace(/-PERP$/, "");
    if (sym.includes(":")) {
      const [prefix, base] = sym.split(":");
      const lower = `${prefix.toLowerCase()}:${base}`;
      if (this._assetMap.has(lower)) return lower;
      if (this._assetMap.has(base)) return base;
    }
    return sym; // return as-is, let downstream error
  }

  /** Get szDecimals for a symbol (cached from init/getMeta) */
  getSzDecimals(symbol: string): number {
    const resolved = this.resolveSymbol(symbol.toUpperCase());
    return this._szDecimalsMap.get(resolved) ?? 2; // 2 is safe middle ground
  }

  /** HL official price rounding: 5 significant figures */
  private _hlRoundPrice(px: number, szDecimals: number, maxDecimals = 6): string {
    if (px > 100_000) return String(Math.round(px));
    const sig5 = Number(px.toPrecision(5));
    const priceDec = Math.max(0, maxDecimals - szDecimals);
    return Number(sig5.toFixed(priceDec)).toString();
  }

  async getAssetIndex(symbol: string): Promise<number> {
    // Retry once if asset map is empty (e.g. init failed silently)
    if (this._assetMap.size === 0) {
      await this._loadAssetMap();
    }
    const resolved = this.resolveSymbol(symbol);
    const idx = this._assetMap.get(resolved);
    if (idx !== undefined) return idx;
    throw new Error(`Unknown asset: ${symbol}`);
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    let universe: Record<string, unknown>[];
    let ctxs: Record<string, unknown>[];
    let mids: Record<string, string> = {};

    if (this._dex) {
      // HIP-3: use raw info POST with dex param
      const meta = await this._infoPost({ type: "metaAndAssetCtxs", dex: this._dex }) as [{ universe: Record<string, unknown>[] }, Record<string, unknown>[]];
      universe = meta[0]?.universe ?? [];
      ctxs = meta[1] ?? [];
    } else {
      const [meta, allMids] = await Promise.all([
        this.sdk.info.perpetuals.getMetaAndAssetCtxs(),
        this.sdk.info.getAllMids(),
      ]);
      universe = meta[0]?.universe ?? [];
      ctxs = meta[1] ?? [];
      mids = allMids as Record<string, string>;
    }

    // Rebuild asset map if empty
    if (this._assetMap.size === 0) {
      universe.forEach((asset, i) => {
        const sym = String(asset.name);
        this._assetMap.set(sym, i);
        this._assetMapReverse.set(i, sym);
      });
    }

    return universe.map((asset: Record<string, unknown>, i: number) => {
      const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
      const sym = String(asset.name);
      return {
        symbol: sym,
        markPrice: String(ctx.markPx ?? mids[sym] ?? "0"),
        indexPrice: String(ctx.oraclePx ?? "0"),
        fundingRate: String(ctx.funding ?? "0"),
        volume24h: String(ctx.dayNtlVlm ?? "0"),
        openInterest: String(ctx.openInterest ?? "0"),
        maxLeverage: Number(asset.maxLeverage ?? 50),
      };
    });
  }

  async getOrderbook(symbol: string) {
    const book = await this.sdk.info.getL2Book(symbol.toUpperCase());
    const levels = book?.levels ?? [[], []];
    return {
      bids: (levels[0] ?? []).map((l: Record<string, unknown>) => [
        String(l.px ?? "0"),
        String(l.sz ?? "0"),
      ] as [string, string]),
      asks: (levels[1] ?? []).map((l: Record<string, unknown>) => [
        String(l.px ?? "0"),
        String(l.sz ?? "0"),
      ] as [string, string]),
    };
  }

  /** Always fetches live clearinghouseState, writes result to shared cache for dashboard */
  private async _getClearinghouseState(): Promise<Record<string, unknown>> {
    const { fetchAndCache, TTL_ACCOUNT } = await import("../cache.js");
    const key = this._dex ? `acct:hl:chs:${this._address}:${this._dex}` : `acct:hl:chs:${this._address}`;
    return fetchAndCache(key, TTL_ACCOUNT, async () => {
      const state = this._dex
        ? await this._infoPost({ type: "clearinghouseState", user: this._address, dex: this._dex }) as Record<string, unknown>
        : await this.sdk.info.perpetuals.getClearinghouseState(this._address);
      return state as Record<string, unknown>;
    });
  }

  async getBalance(): Promise<ExchangeBalance> {
    const state = await this._getClearinghouseState();
    const s = state as Record<string, unknown>;
    const margin = (s?.marginSummary ?? {}) as Record<string, unknown>;
    const cross = (s?.crossMarginSummary ?? {}) as Record<string, unknown>;

    const marginUsed = Number(margin.totalMarginUsed ?? cross.totalMarginUsed ?? 0);
    // Sum unrealized PnL directly from positions (reliable for both main + dex accounts)
    const positions = (s?.assetPositions ?? []) as Record<string, unknown>[];
    let unrealizedPnl = 0;
    for (const entry of positions) {
      const pos = (entry.position ?? entry) as Record<string, unknown>;
      unrealizedPnl += Number(pos.unrealizedPnl ?? 0);
    }

    let equity: number;
    let available: number;

    if (!this._dex) {
      // Unified account: spot USDC total IS the true equity (includes perp margin as "hold").
      // perp accountValue is a subset — adding both double-counts.
      try {
        const spotState = await this.sdk.info.spot.getSpotClearinghouseState(this._address);
        const balances = spotState?.balances ?? [];
        const usdc = balances.find((b: Record<string, unknown>) => String(b.coin).startsWith("USDC"));
        const spotTotal = usdc?.total !== undefined ? Number(usdc.total) : NaN;
        const spotHold = Number(usdc?.hold ?? 0);
        equity = !isNaN(spotTotal) ? spotTotal : Number(margin.accountValue ?? cross.accountValue ?? 0);
        available = !isNaN(spotTotal) ? spotTotal - spotHold : Number(s?.withdrawable ?? 0);
      } catch {
        // Spot API failed — fall back to perp-only values
        equity = Number(margin.accountValue ?? cross.accountValue ?? 0);
        available = Number(s?.withdrawable ?? 0);
      }
    } else {
      // Dex account: perp clearinghouse is the only source
      equity = Number(margin.accountValue ?? cross.accountValue ?? 0);
      available = Number(s?.withdrawable ?? 0);
    }

    return {
      equity: String(equity),
      available: String(available),
      marginUsed: String(marginUsed),
      unrealizedPnl: String(unrealizedPnl),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const state = await this._getClearinghouseState();
    const positions = ((state as Record<string, unknown>)?.assetPositions ?? []) as Record<string, unknown>[];

    return positions
      .filter((p: Record<string, unknown>) => {
        const pos = (p.position ?? p) as Record<string, unknown>;
        return Number(pos.szi ?? 0) !== 0;
      })
      .map((p: Record<string, unknown>) => {
        const pos = (p.position ?? p) as Record<string, unknown>;
        const szi = Number(pos.szi ?? 0);
        return {
          symbol: String(pos.coin ?? ""),
          side: szi > 0 ? ("long" as const) : ("short" as const),
          size: String(Math.abs(szi)),
          entryPrice: String(pos.entryPx ?? "0"),
          markPrice: String(pos.positionValue ? Number(pos.positionValue) / Math.abs(szi) : "0"),
          liquidationPrice: String(pos.liquidationPx ?? "N/A"),
          unrealizedPnl: String(pos.unrealizedPnl ?? "0"),
          leverage: Number((pos.leverage as { value?: number })?.value ?? 1),
        };
      });
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    const orders = await this.sdk.info.getUserOpenOrders(this._address);
    return (orders ?? []).map((o) => ({
      orderId: String(o.oid ?? ""),
      symbol: String(o.coin ?? ""),
      // SDK convertSymbolsInObject already converts "B"→"buy", "A"→"sell"
      side: String(o.side) === "B" ? ("buy" as const) : String(o.side) === "A" ? ("sell" as const) : (o.side as "buy" | "sell"),
      price: String(o.limitPx ?? "0"),
      size: String(o.sz ?? "0"),
      filled: "0",
      status: "open",
      type: "limit",
    }));
  }

  private async _invalidateAccountCache() {
    try { const { invalidateCache } = await import("../cache.js"); invalidateCache("acct"); } catch { /* ignore */ }
  }

  async marketOrder(symbol: string, side: "buy" | "sell", size: string) {
    this.ensureSigner();
    if (this._dex) {
      const r = await this._dexMarketOrder(symbol, side, size);
      await this._invalidateAccountCache();
      return r;
    }
    // Suppress SDK console.log noise (slippage price, decimals, order details)
    const origLog = console.log;
    console.log = () => {};
    try {
      const result = await this.sdk.custom.marketOpen(
        symbol.toUpperCase(),
        side === "buy",
        parseFloat(size),
      );
      await this._invalidateAccountCache();
      return result;
    } finally {
      console.log = origLog;
    }
  }

  /**
   * Place a market order on a HIP-3 deployed dex.
   * Bypasses SDK's symbolConversion (which only knows native perps)
   * and constructs + signs the order action directly.
   */
  private async _dexMarketOrder(symbol: string, side: "buy" | "sell", size: string) {
    const assetIndex = await this.getAssetIndex(symbol.toUpperCase());

    // Get current mark price + szDecimals from dex meta
    const meta = await this._infoPost({
      type: "metaAndAssetCtxs",
      dex: this._dex,
    }) as [{ universe: Array<{ szDecimals?: number }> }, Record<string, unknown>[]];
    const ctx = (meta[1] ?? [])[assetIndex];
    const midPrice = Number(ctx?.markPx ?? 0);
    if (midPrice <= 0) throw new Error(`Cannot get price for ${symbol} on dex ${this._dex}`);

    const szDec = meta[0]?.universe?.[assetIndex]?.szDecimals ?? 2;

    // HL official rounding: 5 significant figures, max 6 decimals for perps
    const MAX_DECIMALS_PERP = 6;
    const slippage = 0.05;
    const isBuy = side === "buy";
    const slippagePrice = isBuy ? midPrice * (1 + slippage) : midPrice * (1 - slippage);
    const limitPrice = slippagePrice > 100_000
      ? String(Math.round(slippagePrice))
      : Number(Number(slippagePrice.toPrecision(5)).toFixed(Math.max(0, MAX_DECIMALS_PERP - szDec))).toString();

    return this._rawPlaceOrder({
      assetIndex,
      isBuy,
      price: limitPrice,
      size: Number(size).toFixed(szDec),
      orderType: { limit: { tif: "Ioc" } },
      reduceOnly: false,
    });
  }

  /**
   * Sign and send any exchange action via raw EIP-712 signing.
   * Bypasses the SDK entirely — works for order, batchModify, twapOrder, etc.
   */
  private ensureSigner(): void {
    if (!this._evmSigner) {
      throw new Error("No private key configured. Run: perp init");
    }
  }

  private async _signAndSendAction(action: Record<string, unknown>): Promise<unknown> {
    this.ensureSigner();
    const { encode } = await import("@msgpack/msgpack");
    const { ethers, keccak256 } = await import("ethers");

    const isMainnet = !this._testnet;
    const baseUrl = isMainnet
      ? "https://api.hyperliquid.xyz"
      : "https://api.hyperliquid-testnet.xyz";

    // Sign L1 action (replicates SDK's signL1Action)
    const nonce = Date.now();
    const msgPackBytes = encode(action);
    const data = new Uint8Array(msgPackBytes.length + 9); // +8 nonce +1 vault flag
    data.set(msgPackBytes);
    const view = new DataView(data.buffer);
    view.setBigUint64(msgPackBytes.length, BigInt(nonce), false);
    view.setUint8(msgPackBytes.length + 8, 0); // no vault

    const hash = keccak256(data);

    const phantomDomain = {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const agentTypes = {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    };
    const phantomAgent = {
      source: isMainnet ? "a" : "b",
      connectionId: hash,
    };

    const sig = await this._evmSigner!.signTypedData(phantomDomain, agentTypes, phantomAgent);
    const parsed = ethers.Signature.from(sig);

    const payload = {
      action,
      nonce,
      signature: { r: parsed.r, s: parsed.s, v: parsed.v },
      vaultAddress: null,
    };

    const res = await fetch(`${baseUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    if (result?.status === "err") {
      throw new Error(result.response ?? JSON.stringify(result));
    }
    return result;
  }

  /**
   * Place an order via raw exchange API with EIP-712 signing.
   * This bypasses the SDK's symbolConversion and supports dex-specific orders.
   */
  private async _rawPlaceOrder(opts: {
    assetIndex: number;
    isBuy: boolean;
    price: string;
    size: string;
    orderType: unknown;
    reduceOnly: boolean;
  }) {
    // Remove trailing zeros (HL API requirement)
    const trimZeros = (s: string) => {
      if (!s.includes(".")) return s;
      const n = s.replace(/\.?0+$/, "");
      return n === "-0" ? "0" : n;
    };

    const orderWire = {
      a: opts.assetIndex,
      b: opts.isBuy,
      p: trimZeros(opts.price),
      s: trimZeros(opts.size),
      r: opts.reduceOnly,
      t: opts.orderType,
    };

    const action: Record<string, unknown> = {
      type: "order",
      orders: [orderWire],
      grouping: "na",
    };

    // Add dex field for HIP-3 deployed perps
    if (this._dex) {
      action.dex = this._dex;
    }

    return this._signAndSendAction(action);
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string }) {
    // Normalize TIF: accept "IOC"/"GTC"/"ALO" (uppercase) or native "Ioc"/"Gtc"/"Alo"
    const rawTif = opts?.tif ?? "Gtc";
    const tifMap: Record<string, string> = { IOC: "Ioc", GTC: "Gtc", ALO: "Alo" };
    const tif = (tifMap[rawTif.toUpperCase()] ?? rawTif) as import("hyperliquid").Tif;
    const reduceOnly = opts?.reduceOnly ?? false;
    // Round price/size to HL-supported decimals
    const szDec = this.getSzDecimals(symbol);
    const roundedPrice = this._hlRoundPrice(Number(price), szDec);
    const roundedSize = Number(size).toFixed(szDec);
    // Use _rawPlaceOrder for both DEX and non-DEX (SDK exchange.placeOrder is unavailable)
    const result = await this._rawPlaceOrder({
      assetIndex: await this.getAssetIndex(symbol.toUpperCase()),
      isBuy: side === "buy",
      price: roundedPrice,
      size: roundedSize,
      orderType: { limit: { tif } },
      reduceOnly,
    });
    await this._invalidateAccountCache();
    return result;
  }

  async cancelOrder(symbol: string, orderId: string) {
    this.ensureSigner();
    // HL SDK expects coin in "ETH-PERP" format (internal symbol convention)
    const resolved = this.resolveSymbol(symbol);
    const result = await this.sdk.exchange.cancelOrder({
      coin: resolved,
      o: parseInt(orderId),
    });
    await this._invalidateAccountCache();
    return result;
  }

  async cancelAllOrders(symbol?: string) {
    this.ensureSigner();
    const orders = await this.getOpenOrders();
    const toCancel = symbol
      ? orders.filter((o) => {
          const norm = (s: string) => s.toUpperCase().replace(/-PERP$/, "");
          return norm(o.symbol) === norm(symbol);
        })
      : orders;

    const results = [];
    for (const o of toCancel) {
      results.push(
        await this.sdk.exchange.cancelOrder({
          coin: o.symbol,
          o: parseInt(o.orderId),
        })
      );
    }
    return results;
  }

  // ── Interface methods ──

  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    // Look up the existing order's side to preserve it (avoid flipping buy↔sell)
    const openOrders = await this.getOpenOrders();
    const existing = openOrders.find(o => o.orderId === orderId);
    const side = existing?.side ?? "buy";
    return this.modifyOrder(symbol, parseInt(orderId), side, price, size);
  }

  async setLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross") {
    return this.updateLeverage(symbol, leverage, marginMode === "cross");
  }

  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean }) {
    return this.triggerOrder(symbol, side, size, triggerPrice, "sl", {
      isMarket: !opts?.limitPrice,
      reduceOnly: opts?.reduceOnly ?? true,
    });
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangeTrade[]> {
    const trades = await this._infoPost({ type: "recentTrades", coin: symbol.toUpperCase() }) as Record<string, unknown>[];
    return (trades ?? [])
      .slice(0, limit)
      .map((t) => ({
        time: Number(t.time ?? 0),
        symbol: String(t.coin ?? symbol.toUpperCase()),
        side: String(t.side) === "B" ? "buy" as const : "sell" as const,
        price: String(t.px ?? "0"),
        size: String(t.sz ?? ""),
        fee: "0",
      }));
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const candles = await this.client.info.getCandleSnapshot(symbol.toUpperCase(), interval, startTime, endTime);
    return (candles ?? []).map((c) => ({
      time: Number(c.t ?? 0),
      open: String(c.o ?? "0"),
      high: String(c.h ?? "0"),
      low: String(c.l ?? "0"),
      close: String(c.c ?? "0"),
      volume: String(c.v ?? ""),
      trades: Number(c.n ?? 0),
    }));
  }

  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    const fills = await this.client.info.getUserFills(this._address);
    return (fills ?? []).slice(0, limit).map((f: Record<string, unknown>) => ({
      orderId: String(f.oid ?? ""),
      symbol: String(f.coin ?? ""),
      // SDK convertSymbolsInObject already converts "B"→"buy", "A"→"sell"
      side: String(f.side) === "B" ? "buy" as const : String(f.side) === "A" ? "sell" as const : (f.side as "buy" | "sell"),
      price: String(f.px ?? "0"),
      size: String(f.sz ?? ""),
      filled: String(f.sz ?? ""),
      status: "filled",
      type: String(f.dir ?? ""),
    }));
  }

  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    const fills = await this.client.info.getUserFills(this._address);
    return (fills ?? []).slice(0, limit).map((f: Record<string, unknown>) => ({
      time: Number(f.time ?? 0),
      symbol: String(f.coin ?? ""),
      // SDK convertSymbolsInObject already converts "B"→"buy", "A"→"sell"
      side: String(f.side) === "B" ? "buy" as const : String(f.side) === "A" ? "sell" as const : (f.side as "buy" | "sell"),
      price: String(f.px ?? "0"),
      size: String(f.sz ?? ""),
      fee: String(f.fee ?? "0"),
    }));
  }

  async getFundingPayments(limit = 30): Promise<ExchangeFundingPayment[]> {
    const now = Date.now();
    const history = await this.client.info.perpetuals.getUserFunding(this._address, now - 7 * 24 * 60 * 60 * 1000);
    return (history as unknown as Record<string, unknown>[] ?? []).slice(0, limit).map((h) => {
      const delta = (h.delta ?? {}) as Record<string, unknown>;
      return {
        time: Number(h.time ?? 0),
        symbol: String(delta.coin ?? ""),
        payment: String(delta.usdc ?? "0"),
      };
    });
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string }[]> {
    const now = Date.now();
    const history = await this.client.info.perpetuals.getFundingHistory(symbol.toUpperCase(), now - 24 * 60 * 60 * 1000);
    return (history ?? []).slice(-limit).map((h) => ({
      time: Number(h.time ?? 0),
      rate: String(h.fundingRate ?? "0"),
      price: "-",
    }));
  }

  // ────────────────────────────────────────────────────────────
  //  Extended methods (from Python SDK / nktkas TS SDK analysis)
  // ────────────────────────────────────────────────────────────

  /**
   * Place a trigger order (stop loss / take profit).
   * Python SDK: order() with trigger type {"trigger": {triggerPx, isMarket, tpsl: "tp"|"sl"}}
   */
  async triggerOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    triggerPrice: string,
    tpsl: "tp" | "sl",
    opts?: { isMarket?: boolean; reduceOnly?: boolean; grouping?: string }
  ) {
    const orderParams = {
      coin: symbol.toUpperCase(),
      is_buy: side === "buy",
      sz: parseFloat(size),
      limit_px: parseFloat(triggerPrice),
      order_type: {
        trigger: {
          triggerPx: triggerPrice,
          isMarket: opts?.isMarket ?? true,
          tpsl,
        },
      },
      reduce_only: opts?.reduceOnly ?? true,
      grouping: opts?.grouping ?? "positionTpsl",
    };
    return (this.sdk.exchange as unknown as { placeOrder: (p: unknown) => Promise<unknown> }).placeOrder(orderParams);
  }

  /**
   * Place a TWAP order.
   * Python SDK: not available in old SDK, available via raw exchange action.
   * nktkas TS SDK: twapOrder({twap: {a, b, s, r, m, t}})
   */
  async twapOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    durationMinutes: number,
    opts?: { reduceOnly?: boolean; randomize?: boolean }
  ) {
    const assetIndex = await this.getAssetIndex(symbol);
    const action = {
      type: "twapOrder",
      twap: {
        a: assetIndex,
        b: side === "buy",
        s: size,
        r: opts?.reduceOnly ?? false,
        m: durationMinutes,
        t: opts?.randomize ?? true,
      },
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Cancel a TWAP order.
   */
  async twapCancel(symbol: string, twapId: number) {
    const assetIndex = await this.getAssetIndex(symbol);
    const action = {
      type: "twapCancel",
      a: assetIndex,
      t: twapId,
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Update leverage for a symbol.
   * Uses SDK's built-in updateLeverage method.
   */
  async updateLeverage(symbol: string, leverage: number, isCross = true) {
    this.ensureSigner();
    return this.sdk.exchange.updateLeverage(this.resolveSymbol(symbol), isCross ? "cross" : "isolated", leverage);
  }

  /**
   * Update isolated margin for a position.
   * amount > 0 to add margin, amount < 0 to remove
   */
  async updateIsolatedMargin(symbol: string, amount: number) {
    this.ensureSigner();
    return this.sdk.exchange.updateIsolatedMargin(this.resolveSymbol(symbol), amount > 0, Math.round(Math.abs(amount) * 1e6));
  }

  /**
   * Withdraw from Hyperliquid L1 bridge.
   * Python SDK: withdraw_from_bridge(amount, destination) → action type "withdraw3"
   */
  async withdraw(amount: string, destination: string) {
    this.ensureSigner();
    try {
      return await this.sdk.exchange.initiateWithdrawal(destination, parseFloat(amount));
    } catch {
      // Fallback: try raw action if SDK method signature changed
      const action = {
        type: "withdraw3",
        hyperliquidChain: this._testnet ? "Testnet" : "Mainnet",
        signatureChainId: this._testnet ? "0x66eee" : "0xa4b1",
        destination,
        amount,
        time: Date.now(),
      };
      return this._sendExchangeAction(action);
    }
  }

  /**
   * Transfer USD between accounts on Hyperliquid L1.
   * Python SDK: usd_transfer(amount, destination)
   */
  async usdTransfer(amount: number, destination: string) {
    this.ensureSigner();
    return this.sdk.exchange.usdTransfer(destination, amount);
  }

  /**
   * Create a sub-account.
   */
  async createSubAccount(name: string) {
    const action = {
      type: "createSubAccount",
      name,
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Transfer USD between main and sub-account.
   */
  async subAccountTransfer(subAccountUser: string, isDeposit: boolean, amount: number) {
    const action = {
      type: "subAccountTransfer",
      subAccountUser,
      isDeposit,
      usd: Math.round(amount * 1e6), // 6 decimals
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Modify an existing order.
   */
  async modifyOrder(
    symbol: string,
    orderId: number,
    newSide: "buy" | "sell",
    newPrice: string,
    newSize: string,
    opts?: { reduceOnly?: boolean }
  ) {
    const assetIndex = await this.getAssetIndex(symbol);
    const szDec = this.getSzDecimals(symbol);
    // Remove trailing zeros (HL API requirement)
    const trimZeros = (s: string) => {
      if (!s.includes(".")) return s;
      const n = s.replace(/\.?0+$/, "");
      return n === "-0" ? "0" : n;
    };
    const action = {
      type: "batchModify",
      modifies: [{
        oid: orderId,
        order: {
          a: assetIndex,
          b: newSide === "buy",
          p: trimZeros(this._hlRoundPrice(Number(newPrice), szDec)),
          s: trimZeros(Number(newSize).toFixed(szDec)),
          r: opts?.reduceOnly ?? false,
          t: { limit: { tif: "Gtc" } },
        },
      }],
    };
    return this._signAndSendAction(action);
  }

  /**
   * Schedule cancel: cancel all orders at a future time.
   * Max 10 triggers per day.
   */
  async scheduleCancel(timeMs?: number) {
    const action = {
      type: "scheduleCancel",
      time: timeMs,
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Set referral code. Silent — does not throw.
   */
  async autoSetReferrer(code?: string): Promise<void> {
    const referralCode = code || process.env.HL_REFERRAL_CODE || "HYPERCASH";
    try {
      const exchange = this.sdk.exchange as unknown as Record<string, unknown>;
      if (typeof exchange.setReferrer === "function") {
        await (exchange.setReferrer as (code: string) => Promise<unknown>)(referralCode);
        return;
      }
    } catch {
      // Already referred or method not available — both OK
    }
  }

  /**
   * Get funding history for a symbol.
   */
  async getFundingHistoryRaw(symbol: string, startTime: number, endTime?: number) {
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const body: Record<string, unknown> = {
      type: "fundingHistory",
      coin: symbol.toUpperCase(),
      startTime,
    };
    if (endTime) body.endTime = endTime;
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /**
   * Get user trade fills.
   */
  async getUserFills(startTime?: number, endTime?: number) {
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const body: Record<string, unknown> = {
      type: "userFillsByTime",
      user: this._address,
    };
    if (startTime) body.startTime = startTime;
    if (endTime) body.endTime = endTime;
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /**
   * Get user portfolio analytics.
   */
  async getPortfolio() {
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "portfolio", user: this._address }),
    });
    return res.json();
  }

  /**
   * Query a specific order by OID.
   */
  async queryOrder(orderId: number) {
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "orderStatus", user: this._address, oid: orderId }),
    });
    return res.json();
  }

  /**
   * Approve a builder fee.
   * Action type: approveBuilderFee
   */
  async approveBuilderFee(builder: string, maxFeeRate: string) {
    const action = {
      type: "approveBuilderFee",
      hyperliquidChain: this._testnet ? "Testnet" : "Mainnet",
      signatureChainId: this._testnet ? "0x66eee" : "0xa4b1",
      maxFeeRate,
      builder,
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Vault deposit/withdraw.
   */
  async vaultTransfer(vaultAddress: string, isDeposit: boolean, usd: number) {
    const action = {
      type: "vaultTransfer",
      vaultAddress,
      isDeposit,
      usd: Math.round(usd * 1e6),
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Delegate/undelegate tokens for staking.
   */
  async tokenDelegate(validator: string, wei: string, isUndelegate = false) {
    const action = {
      type: "tokenDelegate",
      hyperliquidChain: this._testnet ? "Testnet" : "Mainnet",
      signatureChainId: this._testnet ? "0x66eee" : "0xa4b1",
      validator,
      isUndelegate,
      wei,
    };
    return this._sendExchangeAction(action);
  }

  /**
   * Claim staking rewards.
   */
  async claimRewards() {
    return this._sendExchangeAction({ type: "claimRewards" });
  }

  /**
   * List all available HIP-3 deployed perp dexes.
   */
  async listDeployedDexes(): Promise<{ name: string; deployer: string; assets: string[] }[]> {
    const allMetas = await this._infoPost({ type: "allPerpMetas" }) as Record<string, unknown>[];
    if (!Array.isArray(allMetas)) return [];

    const dexes: { name: string; deployer: string; assets: string[] }[] = [];
    // allPerpMetas returns an array: [nativePerps, dex1, dex2, ...]
    // Each entry has { universe, marginTables, collateralToken }
    // Dex name is derived from the asset prefix (e.g., "xyz:TSLA" → "xyz")
    // Skip index 0 (native/validator perps — no prefix)
    for (let i = 1; i < allMetas.length; i++) {
      const meta = allMetas[i];
      const universe = (meta.universe ?? []) as { name: string }[];
      if (universe.length === 0) continue;
      // Extract dex name from the first asset's prefix
      const firstAsset = universe[0].name;
      const colonIdx = firstAsset.indexOf(":");
      const dexName = colonIdx > 0 ? firstAsset.slice(0, colonIdx) : `dex-${i}`;
      dexes.push({
        name: dexName,
        deployer: "", // not exposed by API
        assets: universe.map(a => a.name),
      });
    }
    return dexes;
  }

  /**
   * Get referral info.
   */
  async getReferralInfo() {
    return this._infoPost({ type: "referral", user: this._address });
  }

  /**
   * Get fee info.
   */
  async getUserFees() {
    return this._infoPost({ type: "userFees", user: this._address });
  }

  /**
   * Get sub-accounts.
   */
  async getSubAccounts() {
    return this._infoPost({ type: "subAccounts", user: this._address });
  }

  /**
   * Get historical orders (up to 2000).
   */
  async getHistoricalOrders() {
    return this._infoPost({ type: "historicalOrders", user: this._address });
  }

  /**
   * Get approved builders.
   */
  async getApprovedBuilders() {
    return this._infoPost({ type: "approvedBuilders", user: this._address });
  }

  /**
   * Get vault details.
   */
  async getVaultDetails(vaultAddress: string) {
    return this._infoPost({ type: "vaultDetails", vaultAddress, user: this._address });
  }

  /**
   * Get delegations (staking).
   */
  async getDelegations() {
    return this._infoPost({ type: "delegations", user: this._address });
  }

  /**
   * POST to /info endpoint.
   */
  private async _infoPost(body: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this._testnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /**
   * Public entry point for sending signed exchange actions.
   * Used by HyperliquidSpotAdapter to delegate signing.
   */
  async exchangeAction(action: Record<string, unknown>): Promise<unknown> {
    return this._signAndSendAction(action);
  }

  /**
   * Send a raw exchange action through the SDK.
   * Used for methods not directly exposed by the SDK.
   */
  private async _sendExchangeAction(action: Record<string, unknown>): Promise<unknown> {
    const exchange = this.sdk.exchange as unknown as Record<string, unknown>;

    // Try using the SDK's internal postAction if available
    if (typeof exchange.postAction === "function") {
      return (exchange.postAction as (action: unknown) => Promise<unknown>)(action);
    }

    // Fallback: sign and send directly (bypasses SDK)
    return this._signAndSendAction(action);
  }
}
