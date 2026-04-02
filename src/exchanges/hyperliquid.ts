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
import type { EvmSigner } from "../signer/index.js";
import { LocalEvmSigner } from "../signer/index.js";

export class HyperliquidAdapter implements ExchangeAdapter {
  readonly name = "hyperliquid";
  readonly chain = "evm";
  readonly aliases = ["hl"] as const;
  readonly isUnifiedAccount = true;
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
  private static _lastNonce = 0;
  private _marketsCache: ExchangeMarketInfo[] | null = null;
  private _marketsCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;

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
    this._address = signer.getAddress();
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
    } else if (this._evmSigner && !this._address) {
      this._address = this._evmSigner.getAddress();
    }

    // Build asset index map
    await this._loadAssetMap();
  }

  /** Load asset index map — supports native and HIP-3 dex. */
  private async _loadAssetMap(): Promise<void> {
    try {
      if (this._dex) {
        // HIP-3 deployed dex: asset indices use global offset scheme
        // offset = 110000 + dexListIndex * 10000 (per Python SDK convention)
        const [meta, dexList] = await Promise.all([
          this._infoPost({ type: "meta", dex: this._dex }) as Promise<{ universe?: { name: string; szDecimals?: number }[] }>,
          this._infoPost({ type: "perpDexs" }) as Promise<({ name: string } | null)[]>,
        ]);

        // Find this dex's position in the list (index 0 is native/null)
        let dexOffset = 0;
        for (let i = 1; i < dexList.length; i++) {
          if (dexList[i]?.name === this._dex) {
            dexOffset = 110000 + (i - 1) * 10000;
            break;
          }
        }
        if (dexOffset === 0) {
          console.error(`[hyperliquid] Dex "${this._dex}" not found in perpDexs list`);
        }

        if (meta?.universe) {
          meta.universe.forEach((asset, idx) => {
            const globalIdx = dexOffset + idx;
            // Store both with and without dex prefix for flexible lookup
            // API returns "km:GOOGL" but callers may use "GOOGL" or "KM:GOOGL"
            const fullName = asset.name; // e.g., "km:GOOGL"
            const baseName = fullName.includes(":") ? fullName.split(":").pop()! : fullName;
            this._assetMap.set(fullName, globalIdx);
            this._assetMap.set(baseName, globalIdx);
            this._assetMapReverse.set(globalIdx, fullName);
            // Cache szDecimals for dex assets (critical for order sizing)
            if (asset.szDecimals !== undefined) {
              this._szDecimalsMap.set(fullName, asset.szDecimals);
              this._szDecimalsMap.set(baseName, asset.szDecimals);
            }
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
    const dec = this._szDecimalsMap.get(resolved);
    if (dec !== undefined) return dec;
    // Retry asset map load if empty
    if (this._szDecimalsMap.size === 0) {
      console.error(`[hyperliquid] szDecimals not loaded for ${symbol}, using fallback 2`);
    }
    return 2;
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
    if (this._marketsCache && Date.now() - this._marketsCacheTime < HyperliquidAdapter.CACHE_TTL) return this._marketsCache;
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

    // Rebuild asset map if empty (fallback — normally populated by init/_loadAssetMap)
    if (this._assetMap.size === 0 && !this._dex) {
      universe.forEach((asset, i) => {
        const sym = String(asset.name);
        this._assetMap.set(sym, i);
        this._assetMapReverse.set(i, sym);
      });
    }

    const result = universe.map((asset: Record<string, unknown>, i: number) => {
      const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
      const sym = String(asset.name);
      const szDec = this._szDecimalsMap.get(sym) ?? (asset.szDecimals !== undefined ? Number(asset.szDecimals) : undefined);
      return {
        symbol: sym,
        markPrice: String(ctx.markPx ?? mids[sym] ?? "0"),
        indexPrice: String(ctx.oraclePx ?? "0"),
        fundingRate: ctx.funding != null ? String(ctx.funding) : null,
        volume24h: String(ctx.dayNtlVlm ?? "0"),
        openInterest: String(ctx.openInterest ?? "0"),
        maxLeverage: Number(asset.maxLeverage ?? 50),
        sizeDecimals: szDec,
      };
    });
    this._marketsCache = result; this._marketsCacheTime = Date.now(); return result;
  }

  async getOrderbook(symbol: string) {
    let levels: Record<string, unknown>[][];

    if (this._dex) {
      // HIP-3 dex: SDK's getL2Book() doesn't support dex parameter
      // Resolve symbol to full dex-prefixed name (e.g. "US500" → "km:US500")
      const resolved = this.resolveSymbol(symbol.toUpperCase());
      // Ensure dex prefix is present (API requires it)
      const coin = resolved.includes(":") ? resolved : `${this._dex}:${resolved}`;
      const book = await this._infoPost({
        type: "l2Book",
        coin,
        dex: this._dex,
      }) as { levels?: Record<string, unknown>[][] };
      levels = book?.levels ?? [[], []];
    } else {
      const book = await this.sdk.info.getL2Book(symbol.toUpperCase());
      levels = book?.levels ?? [[], []];
    }

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

  private ensureAddress(): void {
    if (!this._address) {
      throw new Error("No private key configured — account data unavailable. Run: perp setup");
    }
  }

  /** Read-through cached clearinghouseState — returns cached data if fresh */
  private async _getClearinghouseState(): Promise<Record<string, unknown>> {
    this.ensureAddress();
    const { withCache, TTL_ACCOUNT } = await import("../cache.js");
    const key = this._dex ? `acct:hl:chs:${this._address}:${this._dex}` : `acct:hl:chs:${this._address}`;
    return withCache(key, TTL_ACCOUNT, async () => {
      const state = this._dex
        ? await this._infoPost({ type: "clearinghouseState", user: this._address, dex: this._dex }) as Record<string, unknown>
        : await this.sdk.info.perpetuals.getClearinghouseState(this._address);
      return state as Record<string, unknown>;
    });
  }

  /** Cached spot clearinghouse state — shared between getBalance() and HyperliquidSpotAdapter */
  async _getSpotClearinghouseState(): Promise<Record<string, unknown>> {
    this.ensureAddress();
    const { withCache, TTL_ACCOUNT } = await import("../cache.js");
    return withCache(`acct:hl:spot_chs:${this._address}`, TTL_ACCOUNT, async () => {
      return await this.sdk.info.spot.getSpotClearinghouseState(this._address) as unknown as Record<string, unknown>;
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
        const spotState = await this._getSpotClearinghouseState();
        const balances = (spotState?.balances ?? []) as Record<string, unknown>[];
        const usdc = balances.find((b) => String(b.coin).startsWith("USDC"));
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
          markPrice: String(szi !== 0 && pos.positionValue && Number(pos.positionValue) !== 0
            ? Number(pos.positionValue) / Math.abs(szi)
            : pos.markPx ?? "0"),
          liquidationPrice: String(pos.liquidationPx ?? "N/A"),
          unrealizedPnl: String(pos.unrealizedPnl ?? "0"),
          leverage: Number((pos.leverage as { value?: number })?.value ?? 1),
        };
      });
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    this.ensureAddress();

    if (this._dex) {
      // HIP-3 dex: use frontendOpenOrders with dex parameter
      const orders = await this._infoPost({
        type: "frontendOpenOrders", user: this._address, dex: this._dex,
      }) as Record<string, unknown>[];
      return (orders ?? []).map((o) => ({
        orderId: String(o.oid ?? ""),
        symbol: String(o.coin ?? ""),
        side: String(o.side) === "B" ? ("buy" as const) : String(o.side) === "A" ? ("sell" as const) : (String(o.side).toLowerCase() as "buy" | "sell"),
        price: String(o.limitPx ?? "0"),
        size: String(o.sz ?? "0"),
        filled: "0",
        status: "open",
        type: "limit",
      }));
    }

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

  /**
   * Validate that an HL order actually filled.
   * HL API returns status "ok" even for 0-fill IoC orders.
   * Response shape: { status: "ok", response: { type: "order", data: { statuses: [...] } } }
   * Each status is one of: { filled: { totalSz, avgPx, oid } }, { resting: { oid } }, { error: "msg" }
   */
  private _validateOrderFill(result: unknown, symbol: string, side: string, requestedSize: string): void {
    const r = result as { status?: string; response?: { type?: string; data?: { statuses?: Array<Record<string, unknown>> } } };
    const statuses = r?.response?.data?.statuses;
    if (!statuses || statuses.length === 0) {
      throw new Error(`Market ${side} ${symbol}: no order status in response`);
    }
    const st = statuses[0];
    if (st.error) {
      throw new Error(`Market ${side} ${symbol}: ${st.error}`);
    }
    const filled = st.filled as { totalSz?: string; avgPx?: string } | undefined;
    if (!filled || Number(filled.totalSz ?? 0) === 0) {
      throw new Error(`Market ${side} ${symbol}: order not filled (0 of ${requestedSize}). Check price/liquidity.`);
    }
  }

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts?: { reduceOnly?: boolean }) {
    this.ensureSigner();
    if (this._dex) {
      const r = await this._dexMarketOrder(symbol, side, size);
      this._validateOrderFill(r, symbol, side, size);
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
      this._validateOrderFill(result, symbol, side, size);
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
    const szDec = this.getSzDecimals(symbol);

    // Get current mark price from dex meta (lookup by coin name, not array index)
    const resolved = this.resolveSymbol(symbol.toUpperCase());
    const coin = resolved.includes(":") ? resolved : `${this._dex}:${resolved}`;
    const meta = await this._infoPost({
      type: "metaAndAssetCtxs",
      dex: this._dex,
    }) as [{ universe: Array<{ name: string }> }, Record<string, unknown>[]];
    // Find local index by matching coin name in universe
    const localIdx = meta[0]?.universe?.findIndex(a => a.name === coin) ?? -1;
    const ctx = localIdx >= 0 ? (meta[1] ?? [])[localIdx] : undefined;
    const midPrice = Number(ctx?.markPx ?? 0);
    if (midPrice <= 0) throw new Error(`Cannot get price for ${symbol} on dex ${this._dex}`);

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
      throw new Error("No private key configured. Run: perp setup");
    }
  }

  /**
   * Normalize trailing zeros from price ('p') and size ('s') string fields
   * in an action object, recursively. Matches the SDK's normalizeTrailingZeros.
   *
   * The HL validator normalizes these fields before hashing; if we hash without
   * normalizing, the recovered signer address won't match → "User or API Wallet
   * does not exist" error.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _normalizeAction(obj: any): any {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => HyperliquidAdapter._normalizeAction(item));
    }
    const result = { ...obj };
    for (const key in result) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
      const value = result[key];
      if (value && typeof value === "object") {
        result[key] = HyperliquidAdapter._normalizeAction(value);
      } else if ((key === "p" || key === "s") && typeof value === "string") {
        let v = value;
        if (v.includes(".")) v = v.replace(/\.?0+$/, "");
        if (v === "-0") v = "0";
        result[key] = v;
      }
    }
    return result;
  }

  private async _signAndSendAction(action: Record<string, unknown>): Promise<unknown> {
    this.ensureSigner();
    const { encode } = await import("@msgpack/msgpack");
    const { ethers, keccak256 } = await import("ethers");

    const isMainnet = !this._testnet;
    const baseUrl = isMainnet
      ? "https://api.hyperliquid.xyz"
      : "https://api.hyperliquid-testnet.xyz";

    // Normalize trailing zeros from 'p' and 's' fields before hashing.
    // The HL validator does the same; without this, the hash differs and the
    // recovered signer address is wrong → "User or API Wallet does not exist".
    const normalizedAction = HyperliquidAdapter._normalizeAction(action);

    // Sign L1 action (replicates SDK's signL1Action)
    // Monotonic nonce: ensures uniqueness even for rapid-fire requests in same millisecond
    const now = Date.now();
    HyperliquidAdapter._lastNonce = now > HyperliquidAdapter._lastNonce ? now : HyperliquidAdapter._lastNonce + 1;
    const nonce = HyperliquidAdapter._lastNonce;
    const msgPackBytes = encode(normalizedAction);
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

    const text = await res.text();
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`HL exchange API error (${res.status}): ${text.slice(0, 200)}`);
    }
    if (result?.status === "err") {
      throw new Error(typeof result.response === "string" ? result.response : JSON.stringify(result));
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
    // No "dex" field needed — the global asset index (110000+) encodes the dex

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
    if (this._dex) {
      // HIP-3 dex: use raw cancel action with global asset index
      const assetIndex = await this.getAssetIndex(symbol.toUpperCase());
      const result = await this._signAndSendAction({
        type: "cancel",
        cancels: [{ a: assetIndex, o: parseInt(orderId) }],
      });
      await this._invalidateAccountCache();
      return result;
    }
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
          const norm = (s: string) => s.toUpperCase().replace(/-PERP$/, "").replace(/^[^:]+:/, "");
          return norm(o.symbol) === norm(symbol);
        })
      : orders;

    const results = [];
    for (const o of toCancel) {
      if (this._dex) {
        const assetIndex = await this.getAssetIndex(o.symbol);
        results.push(
          await this._signAndSendAction({
            type: "cancel",
            cancels: [{ a: assetIndex, o: parseInt(o.orderId) }],
          })
        );
      } else {
        results.push(
          await this.sdk.exchange.cancelOrder({
            coin: o.symbol,
            o: parseInt(o.orderId),
          })
        );
      }
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
    this.ensureAddress();
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
    this.ensureAddress();
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

  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    this.ensureAddress();
    // Direct API call — SDK's getUserFunding silently truncates results
    const apiUrl = this._testnet ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info";
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "userFunding", user: this._address, startTime: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
    });
    const data = await res.json() as { time: number; delta: { coin: string; usdc: string } }[];
    return (data ?? []).slice(0, limit).map((h) => ({
      time: h.time,
      symbol: h.delta.coin + "-PERP",
      payment: h.delta.usdc,
    }));
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string | null }[]> {
    const now = Date.now();
    const history = await this.client.info.perpetuals.getFundingHistory(symbol.toUpperCase(), now - 24 * 60 * 60 * 1000);
    return (history ?? []).slice(-limit).map((h) => ({
      time: Number(h.time ?? 0),
      rate: String(h.fundingRate ?? "0"),
      price: null,
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
    this.ensureSigner();
    const assetIndex = await this.getAssetIndex(symbol.toUpperCase());
    const szDec = this.getSzDecimals(symbol);
    const roundedSize = Number(size).toFixed(szDec);
    const roundedTrigger = this._hlRoundPrice(Number(triggerPrice), szDec);

    // Remove trailing zeros (HL API requirement)
    const trimZeros = (s: string) => {
      if (!s.includes(".")) return s;
      const n = s.replace(/\.?0+$/, "");
      return n === "-0" ? "0" : n;
    };

    const orderWire = {
      a: assetIndex,
      b: side === "buy",
      p: trimZeros(roundedTrigger),
      s: trimZeros(roundedSize),
      r: opts?.reduceOnly ?? true,
      t: {
        trigger: {
          isMarket: opts?.isMarket ?? true,
          triggerPx: trimZeros(roundedTrigger),
          tpsl,
        },
      },
    };

    const action: Record<string, unknown> = {
      type: "order",
      orders: [orderWire],
      grouping: opts?.grouping ?? "positionTpsl",
    };

    return this._signAndSendAction(action);
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
  async withdraw(amount: string, destination: string, _opts?: { assetId?: number; routeType?: number }) {
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
    this.ensureAddress();
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
    this.ensureAddress();
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
    this.ensureAddress();
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
    this.ensureAddress();
    return this._infoPost({ type: "referral", user: this._address });
  }

  /**
   * Get fee info.
   */
  async getUserFees() {
    this.ensureAddress();
    return this._infoPost({ type: "userFees", user: this._address });
  }

  /**
   * Get sub-accounts.
   */
  async getSubAccounts() {
    this.ensureAddress();
    return this._infoPost({ type: "subAccounts", user: this._address });
  }

  /**
   * Get historical orders (up to 2000).
   */
  async getHistoricalOrders() {
    this.ensureAddress();
    return this._infoPost({ type: "historicalOrders", user: this._address });
  }

  /**
   * Get approved builders.
   */
  async getApprovedBuilders() {
    this.ensureAddress();
    return this._infoPost({ type: "approvedBuilders", user: this._address });
  }

  /**
   * Get vault details.
   */
  async getVaultDetails(vaultAddress: string) {
    this.ensureAddress();
    return this._infoPost({ type: "vaultDetails", vaultAddress, user: this._address });
  }

  /**
   * Get delegations (staking).
   */
  async getDelegations() {
    this.ensureAddress();
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
