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

import type { WasmSignerClient as WasmSignerClientType } from "lighter-ts-sdk";

interface WasmTxResponse {
  txType: number;
  txInfo: string;
  txHash: string;
  messageToSign?: string;
  error?: string;
}

export class LighterAdapter implements ExchangeAdapter {
  readonly name = "lighter";
  readonly chain = "ethereum";
  readonly aliases = ["lt"] as const;
  private _signer!: WasmSignerClientType;
  private _accountIndex = -1;
  private _apiKeyIndex: number;
  private _address: string;
  private _marketMap = new Map<string, number>(); // symbol → marketIndex
  private _marketDecimals = new Map<string, { size: number; price: number }>(); // symbol → decimals
  private _clientOrderCounter = 0;
  private _evmKey: string;
  private _apiKey: string;
  private _accountIndexInit: number;
  private _baseUrl: string;
  private _chainId: number;
  private _testnet: boolean;
  private _readOnly: boolean;
  private _evmSigner?: EvmSigner;
  // In-memory cache removed — using file-based cache (src/cache.ts) for cross-process dedup

  /**
   * @param evmKey    EVM private key (0x-prefixed, 32 bytes) — for deposits & key registration
   * @param testnet   Use testnet (chain ID 300) instead of mainnet (chain ID 304)
   * @param opts      Optional: apiKey (40-byte Lighter signing key), accountIndex
   */
  constructor(evmKey: string, testnet = false, opts?: { apiKey?: string; accountIndex?: number }) {
    this._evmKey = evmKey;
    this._apiKey = opts?.apiKey || process.env.LIGHTER_API_KEY || "";
    this._accountIndexInit = opts?.accountIndex ?? parseInt(process.env.LIGHTER_ACCOUNT_INDEX || "-1");
    this._apiKeyIndex = parseInt(process.env.LIGHTER_API_KEY_INDEX || "4");
    this._address = "";
    this._testnet = testnet;
    this._readOnly = !this._apiKey;
    this._baseUrl = testnet
      ? (process.env.LIGHTER_TESTNET_URL || "https://testnet.zklighter.elliot.ai")
      : "https://mainnet.zklighter.elliot.ai";
    this._chainId = testnet ? 300 : 304;
  }

  get signer(): { createAuthToken(deadline: number): Promise<{ authToken: string }> } & WasmSignerClientType {
    const self = this;
    // Compatibility wrapper: ws-feeds.ts expects createAuthToken(deadline) → { authToken }
    return Object.create(this._signer, {
      createAuthToken: {
        value: async (deadline: number) => {
          const token = await self._signer.createAuthToken(deadline, self._apiKeyIndex, self._accountIndex);
          return { authToken: token };
        },
      },
    });
  }

  get accountIndex(): number {
    return this._accountIndex;
  }

  get address(): string {
    return this._address;
  }

  /** @internal — evmKey is intentionally not exposed publicly for security */

  get isReadOnly(): boolean {
    return this._readOnly;
  }

  /** Inject an external EVM signer. Call before init() to skip LocalEvmSigner creation. */
  setSigner(signer: EvmSigner): void {
    this._evmSigner = signer;
  }

  async init(): Promise<void> {
    // Initialize EVM signer if not externally injected (skip if no key — read-only mode)
    if (!this._evmSigner && this._evmKey) {
      this._evmSigner = await LocalEvmSigner.create(this._evmKey);
      this._address = this._evmSigner.getAddress();
    }

    // Fetch account index from REST API (skip if no address — read-only mode)
    if (!this._address) {
      await this._refreshMarketMap();
      return;
    }
    // If accountIndex is already known (from env/opts), skip API lookup entirely
    if (this._accountIndexInit >= 0) {
      this._accountIndex = this._accountIndexInit;
    } else {
      // Retry account lookup on 429 (rate limit) — critical for _accountIndex
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${this._baseUrl}/api/v1/account?by=l1_address&value=${this._address}`);
          if (res.status === 429 && attempt < 2) {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          const json = await res.json() as { accounts?: { account_index: number; l1_address: string }[] };
          if (json.accounts && json.accounts.length > 0) {
            this._accountIndex = json.accounts[0].account_index;
          }
          break;
        } catch {
          if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
        }
      }
    }

    // Auto-generate API key if we have PK but no API key and account exists
    let signerReady = false;
    if (!this._apiKey && this._accountIndex >= 0) {
      try {
        const autoKeyIndex = 4; // default for auto-setup (0-3 reserved by Lighter frontend)
        const { privateKey: apiKey } = await this.setupApiKey(autoKeyIndex);
        this._apiKey = apiKey;
        this._apiKeyIndex = autoKeyIndex;
        // setupApiKey already configured the static WASM client — reuse it
        this._signer = LighterAdapter._wasmClient!;
        signerReady = true;
        // Save to .env for future use
        try {
          const { setEnvVar } = await import("../commands/init.js");
          setEnvVar("LIGHTER_API_KEY", apiKey);
          setEnvVar("LIGHTER_ACCOUNT_INDEX", String(this._accountIndex));
          setEnvVar("LIGHTER_API_KEY_INDEX", String(autoKeyIndex));
        } catch { /* non-critical — env save may fail in some contexts */ }
      } catch (e) {
        // Auto-setup failed — log the error and continue in read-only mode
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[lighter] API key auto-setup failed: ${msg}. Trading will be read-only. Run 'perp -e lighter manage setup-api-key' to retry.`);
      }
    }

    // Initialize signer for trading if we have an API key (reuse singleton WASM client)
    if (this._apiKey && !signerReady) {
      // Clean & validate API key before passing to WASM (Go hex decoder gives cryptic errors on non-hex)
      let cleanKey = this._apiKey.trim().replace(/['"` \t\n\r.]/g, "");
      if (cleanKey.startsWith("0x")) cleanKey = cleanKey.slice(2);
      if (cleanKey.length > 0 && !/^[0-9a-fA-F]+$/.test(cleanKey)) {
        console.error(`[lighter] API key contains invalid chars (expected hex). Check LIGHTER_API_KEY in ~/.perp/.env or run 'perp -e lighter manage setup-api-key' to regenerate.`);
        this._apiKey = "";
      } else if (cleanKey.length === 0) {
        this._apiKey = "";
      } else if (this._accountIndex < 0) {
        // Account lookup failed or returned no accounts — cannot initialize WASM signer
        console.error(`[lighter] Account index not available (got ${this._accountIndex}). Trading will be read-only. Ensure the wallet has a Lighter account or set LIGHTER_ACCOUNT_INDEX.`);
        this._apiKey = "";
      } else {
        this._apiKey = cleanKey;
        const client = await LighterAdapter.getWasmClient();
        await client.createClient({
          url: this._baseUrl,
          privateKey: this._apiKey,
          chainId: this._chainId,
          apiKeyIndex: this._apiKeyIndex,
          accountIndex: this._accountIndex,
        });
        this._signer = client;
      }
    }
    this._readOnly = !this._apiKey;

    // Build symbol → marketIndex map + decimals from orderBookDetails
    await this._refreshMarketMap();
  }

  /** Populate marketMap + decimals from /orderBooks API (safe to call multiple times) */
  private async _refreshMarketMap(): Promise<void> {
    // Retry up to 2 times with 1s delay on failure
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Prefer /orderBooks which has supported_size_decimals / supported_price_decimals
        const res = await this.restGet("/orderBooks", {}) as {
          order_books?: Array<{
            symbol: string; market_id: number;
            supported_size_decimals: number;
            supported_price_decimals: number;
            market_type?: string;
            status?: string;
          }>;
        };
        const books = res.order_books ?? [];
        if (books.length === 0 && attempt === 0) {
          // Empty response (possible rate limit) — retry after delay
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        for (const d of books) {
          const sym = d.symbol.toUpperCase();
          // Skip spot markets (id ≥ 2048) — those are handled by lighter-spot.ts
          if (d.market_id >= 2048) continue;
          this._marketMap.set(sym, d.market_id);
          this._marketDecimals.set(sym, {
            size: d.supported_size_decimals,
            price: d.supported_price_decimals,
          });
        }
        if (this._marketMap.size > 0) return; // success
      } catch {
        // /orderBooks failed — try fallback below
      }

      // Fallback to /orderBookDetails
      try {
        const res = await this.restGet("/orderBookDetails", {}) as {
          order_book_details?: Array<{
            symbol: string; market_id: number;
            size_decimals?: number; price_decimals?: number;
          }>;
        };
        for (const d of res.order_book_details ?? []) {
          this._marketMap.set(d.symbol.toUpperCase(), d.market_id);
          this._marketDecimals.set(d.symbol.toUpperCase(), {
            size: d.size_decimals ?? 0,
            price: d.price_decimals ?? 0,
          });
        }
        if (this._marketMap.size > 0) return; // success
      } catch {
        // Both APIs failed this attempt
      }

      // Delay before retry
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }

  getMarketIndex(symbol: string): number {
    const idx = this._marketMap.get(symbol.toUpperCase());
    if (idx === undefined) throw new Error(`Unknown Lighter market: ${symbol}`);
    return idx;
  }

  /** Ensure market map is populated; lazy-refresh if empty */
  private async ensureMarketMap(): Promise<void> {
    if (this._marketMap.size === 0) {
      await this._refreshMarketMap();
    }
  }

  private async getMarkPrice(symbol: string): Promise<number> {
    try {
      const res = await this.restGet("/orderBookDetails", {}) as {
        order_book_details?: Array<{ symbol: string; last_trade_price?: number }>;
      };
      const m = res.order_book_details?.find(d => d.symbol.toUpperCase() === symbol.toUpperCase());
      const price = m?.last_trade_price ?? 0;
      if (price <= 0) throw new Error(`Cannot determine mark price for ${symbol}`);
      return price;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Cannot determine")) throw e;
      throw new Error(`Cannot determine mark price for ${symbol}`);
    }
  }

  private toTicks(symbol: string, size: number, price: number): { baseAmount: number; priceTicks: number } {
    const dec = this._marketDecimals.get(symbol.toUpperCase());
    if (!dec) {
      throw new Error(`No market decimals loaded for ${symbol}. Market data may not be initialized.`);
    }
    const baseAmount = Math.round(size * Math.pow(10, dec.size));
    const priceTicks = Math.round(price * Math.pow(10, dec.price));

    // Validate: size too small for this market's precision → baseAmount rounds to 0
    if (size > 0 && baseAmount <= 0) {
      const minSize = 1 / Math.pow(10, dec.size);
      throw new Error(
        `Order size ${size} too small for ${symbol} (sizeDecimals=${dec.size}, min=${minSize}). ` +
        `Increase size or use a different market.`
      );
    }
    if (price > 0 && priceTicks <= 0) {
      const minPrice = 1 / Math.pow(10, dec.price);
      throw new Error(
        `Order price ${price} too small for ${symbol} (priceDecimals=${dec.price}, min=${minPrice}).`
      );
    }

    return { baseAmount, priceTicks };
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    const markets: ExchangeMarketInfo[] = [];

    try {
      const res = await this.restGet("/orderBookDetails", {}) as {
        order_book_details?: Array<{
          symbol: string;
          market_id: number;
          last_trade_price?: number;
          open_interest?: number | string;
          daily_base_token_volume?: number | string;
          daily_quote_token_volume?: number | string;
          default_initial_margin_fraction?: number;
          min_initial_margin_fraction?: number;
          market_type?: string;
        }>;
      };

      for (const d of res.order_book_details ?? []) {
        if (d.market_type !== "perp") continue;
        // max_leverage from min_initial_margin_fraction (e.g. 400 = 4% margin = 25x)
        const imf = d.min_initial_margin_fraction ?? d.default_initial_margin_fraction ?? 500;
        const maxLev = imf > 0 ? Math.floor(10000 / imf) : 50;
        markets.push({
          symbol: d.symbol,
          markPrice: String(d.last_trade_price ?? 0),
          indexPrice: String(d.last_trade_price ?? 0),
          fundingRate: "0", // funding rates require auth
          volume24h: String(d.daily_quote_token_volume ?? 0),
          openInterest: String(d.open_interest ?? 0),
          maxLeverage: maxLev,
        });
      }
    } catch { /* non-critical */ }

    return markets;
  }

  private async fetchAccount(): Promise<Record<string, unknown> | null> {
    if (!this._address) return null;
    const { fetchAndCache, TTL_ACCOUNT } = await import("../cache.js");
    return fetchAndCache(`acct:lt:account:${this._address}`, TTL_ACCOUNT, async () => {
      const res = await this.restGet("/account", {
        by: "l1_address",
        value: this._address,
      }) as { accounts?: Record<string, unknown>[] };
      const acct = this._accountIndex >= 0
        ? res.accounts?.find(a => (a as Record<string, unknown>).account_index === this._accountIndex || (a as Record<string, unknown>).index === this._accountIndex)
        : res.accounts?.[0];
      return acct ?? res.accounts?.[0] ?? null;
    });
  }

  async getOrderbook(symbol: string) {
    try {
      await this.ensureMarketMap();
      const marketId = this.getMarketIndex(symbol);
      const res = await this.restGet("/orderBookOrders", {
        market_id: String(marketId),
        limit: "50",
      }) as { asks?: Record<string, string>[]; bids?: Record<string, string>[] };
      return {
        bids: (res.bids ?? []).map((l) => [l.price, l.remaining_base_amount ?? l.size ?? "0"] as [string, string]),
        asks: (res.asks ?? []).map((l) => [l.price, l.remaining_base_amount ?? l.size ?? "0"] as [string, string]),
      };
    } catch {
      return { bids: [], asks: [] };
    }
  }

  async getBalance(): Promise<ExchangeBalance> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp init");
    const acct = await this.fetchAccount();
    if (!acct) return { equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0" };

    const totalAsset = Number(acct.total_asset_value || 0);
    const available = Number(acct.available_balance || 0);
    const collateral = Number(acct.collateral || 0);
    const unrealizedPnl = (acct.positions as unknown as Record<string, unknown>[])?.reduce(
      (sum: number, p: Record<string, unknown>) => sum + Number(p.unrealized_pnl || 0), 0
    ) ?? 0;

    return {
      equity: String(totalAsset),
      available: String(available),
      marginUsed: String(Math.max(0, collateral - available)),
      unrealizedPnl: String(unrealizedPnl),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp init");
    const acct = await this.fetchAccount();
    if (!acct) return [];

    return ((acct.positions as unknown as Record<string, unknown>[]) ?? [])
      .filter((p: Record<string, unknown>) => Number(p.position || 0) !== 0)
      .map((p: Record<string, unknown>) => {
        const posSize = Number(p.position || 0);
        return {
          symbol: String(p.symbol || `Market-${p.market_id}`),
          side: (Number(p.sign) > 0 ? "long" : "short") as "long" | "short",
          size: String(Math.abs(posSize)),
          entryPrice: String(p.avg_entry_price || "0"),
          markPrice: (() => {
            if (posSize === 0) return "0";
            const rawMark = Number(p.position_value || 0) / Math.abs(posSize);
            const priceDec = this._marketDecimals.get(String(p.symbol || "").toUpperCase())?.price;
            return String(priceDec !== undefined ? rawMark.toFixed(priceDec) : rawMark);
          })(),
          liquidationPrice: String(p.liquidation_price || "N/A"),
          unrealizedPnl: String(p.unrealized_pnl || "0"),
          // Compute actual leverage = notional / account equity (not max leverage from IMF)
          leverage: (() => {
            const notional = Math.abs(Number(p.position_value || 0));
            const equity = Number(acct.total_asset_value || 0);
            if (equity > 0 && notional > 0) return Math.round(notional / equity * 10) / 10;
            return 1;
          })(),
        };
      });
  }

  private async getAuthToken(): Promise<string> {
    if (this._readOnly) throw new Error("Auth requires API key");
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    return this._signer.createAuthToken(deadline, this._apiKeyIndex, this._accountIndex);
  }

  private async restGetAuth(path: string, params: Record<string, string>): Promise<unknown> {
    const auth = await this.getAuthToken();
    params.auth = auth;
    return this.restGet(path, params);
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp init");
    if (this._accountIndex < 0 || this._readOnly) return [];
    try {
      // Check if account has any orders first
      const acct = await this.fetchAccount();
      const totalOrders = Number((acct as Record<string, unknown>)?.total_order_count ?? 0);
      if (totalOrders === 0) return [];

      // Only query markets that have open orders (avoids 156-market fan-out)
      const activeMarketIds = new Set<number>();
      for (const p of (acct?.positions as unknown as Record<string, unknown>[]) ?? []) {
        if (Number(p.open_order_count ?? 0) > 0 || Number(p.pending_order_count ?? 0) > 0) {
          activeMarketIds.add(Number(p.market_id));
        }
      }
      if (activeMarketIds.size === 0) return [];

      const reverseMap = new Map<number, string>();
      for (const [sym, id] of this._marketMap) reverseMap.set(id, sym);

      const allOrders: ExchangeOrder[] = [];
      const results = await Promise.allSettled(
        Array.from(activeMarketIds).map((marketId) => {
          const sym = reverseMap.get(marketId) ?? `Market-${marketId}`;
          return this.restGetAuth("/accountActiveOrders", {
            account_index: String(this._accountIndex),
            market_id: String(marketId),
          }).then(res => ({ sym, orders: ((res as Record<string, unknown>).orders ?? []) as Array<Record<string, unknown>> }));
        })
      );

      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value.orders.length) continue;
        for (const o of r.value.orders) {
          allOrders.push({
            orderId: String(o.order_id ?? o.order_index ?? ""),
            symbol: String(o.symbol ?? r.value.sym),
            side: o.is_ask ? ("sell" as const) : ("buy" as const),
            price: String(o.price ?? "0"),
            size: String(o.initial_base_amount ?? o.remaining_base_amount ?? "0"),
            filled: String(o.filled_base_amount ?? "0"),
            status: String(o.status ?? "open"),
            type: String(o.type ?? "limit"),
          });
        }
      }
      return allOrders;
    } catch {
      return [];
    }
  }

  async marketOrder(symbol: string, side: "buy" | "sell", size: string) {
    this.ensureSigner();
    await this.ensureMarketMap();
    const nonce = await this.getNextNonce();
    const marketIndex = this.getMarketIndex(symbol);
    const { baseAmount } = this.toTicks(symbol, parseFloat(size), 0);
    // Market orders need a max slippage price (buy=high, sell=low)
    const markPrice = await this.getMarkPrice(symbol);
    const slippagePrice = side === "buy" ? markPrice * 2 : markPrice * 0.5;
    const { priceTicks: slippageTicks } = this.toTicks(symbol, 0, slippagePrice);
    const signed = await this.signOrder({
      marketIndex,
      clientOrderIndex: this.nextClientOrderIndex(),
      baseAmount,
      price: Math.max(slippageTicks, 1),
      isAsk: side === "sell" ? 1 : 0,
      orderType: 1, // ORDER_TYPE_MARKET
      timeInForce: 0, // IOC (Immediate or Cancel)
      reduceOnly: 0,
      triggerPrice: 0,
      orderExpiry: 0, // DEFAULT_IOC_EXPIRY
      nonce,
    });
    return this.sendTx(signed);
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string }) {
    this.ensureSigner();
    await this.ensureMarketMap();
    const nonce = await this.getNextNonce();
    const marketIndex = this.getMarketIndex(symbol);
    const { baseAmount, priceTicks } = this.toTicks(symbol, parseFloat(size), parseFloat(price));

    // Map TIF string → Lighter numeric: IOC=0, GTT/GTC=1
    const isIoc = opts?.tif?.toUpperCase() === "IOC";
    const signed = await this.signOrder({
      marketIndex,
      clientOrderIndex: this.nextClientOrderIndex(),
      baseAmount,
      price: priceTicks,
      isAsk: side === "sell" ? 1 : 0,
      orderType: 0, // ORDER_TYPE_LIMIT
      timeInForce: isIoc ? 0 : 1, // 0=IOC (immediate fill or cancel), 1=GTT (rests on book)
      reduceOnly: opts?.reduceOnly ? 1 : 0,
      triggerPrice: 0,
      orderExpiry: isIoc ? 0 : -1, // IOC: no expiry; GTT: 28-day default
      nonce,
    });
    return this.sendTx(signed);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    this.ensureSigner();
    await this.ensureMarketMap();

    // Lighter order IDs can exceed Number.MAX_SAFE_INTEGER (2^53-1).
    // The WASM signer only accepts JS number, so large IDs lose precision.
    // Fall back to cancelAllOrders when the ID is unsafe.
    const idNum = Number(orderId);
    if (!Number.isSafeInteger(idNum)) {
      return this.cancelAllOrders(symbol);
    }

    const nonce = await this.getNextNonce();
    const marketIndex = this.getMarketIndex(symbol);
    const signed = await this._signer.signCancelOrder({
      marketIndex, orderIndex: idNum, nonce,
      apiKeyIndex: this._apiKeyIndex, accountIndex: this._accountIndex,
    });
    return this.sendTx(signed);
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
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
    const nonce = await this.getNextNonce();
    const signed = await this._signer.signCancelAllOrders({
      timeInForce: 1, time: Date.now() + 3600_000, nonce,
      apiKeyIndex: this._apiKeyIndex, accountIndex: this._accountIndex,
    });
    return this.sendTx(signed);
  }

  async modifyOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    this.ensureSigner();
    await this.ensureMarketMap();
    const nonce = await this.getNextNonce();
    const marketIndex = this.getMarketIndex(symbol);
    const { baseAmount, priceTicks } = this.toTicks(symbol, parseFloat(size), parseFloat(price));
    const idNum = Number(orderId);
    if (!Number.isSafeInteger(idNum)) {
      throw new Error(`Order ID ${orderId} exceeds MAX_SAFE_INTEGER — cancel and re-place instead`);
    }
    const signed = await this._signer.signModifyOrder({
      marketIndex,
      index: idNum,
      baseAmount,
      price: priceTicks,
      triggerPrice: 0,
      nonce,
      apiKeyIndex: this._apiKeyIndex,
      accountIndex: this._accountIndex,
    });
    if (signed.error) {
      throw new Error(`Signer: ${signed.error}`);
    }
    return this.sendTx(signed);
  }

  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean }): Promise<unknown> {
    this.ensureSigner();
    await this.ensureMarketMap();
    const nonce = await this.getNextNonce();
    const marketIndex = this.getMarketIndex(symbol);
    const { baseAmount } = this.toTicks(symbol, parseFloat(size), 0);
    const { priceTicks: triggerTicks } = this.toTicks(symbol, 0, parseFloat(triggerPrice));

    // If limitPrice given → stop-limit (type 0, GTT), else stop-market (type 1, IOC)
    const isMarket = !opts?.limitPrice;
    let priceTicks: number;
    if (isMarket) {
      const markPrice = await this.getMarkPrice(symbol);
      const slippagePrice = side === "buy" ? markPrice * 2 : markPrice * 0.5;
      priceTicks = this.toTicks(symbol, 0, slippagePrice).priceTicks;
    } else {
      priceTicks = this.toTicks(symbol, 0, parseFloat(opts!.limitPrice!)).priceTicks;
    }

    const signed = await this.signOrder({
      marketIndex,
      clientOrderIndex: this.nextClientOrderIndex(),
      baseAmount,
      price: Math.max(priceTicks, 1),
      isAsk: side === "sell" ? 1 : 0,
      orderType: isMarket ? 1 : 0,
      timeInForce: isMarket ? 0 : 1, // IOC for market, GTT for limit
      reduceOnly: opts?.reduceOnly ? 1 : 0,
      triggerPrice: triggerTicks,
      orderExpiry: isMarket ? 0 : -1,
      nonce,
    });
    return this.sendTx(signed);
  }

  async updateLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross"): Promise<unknown> {
    this.ensureSigner();
    await this.ensureMarketMap();
    const nonce = await this.getNextNonce();
    const marketIndex = this.getMarketIndex(symbol);
    // fraction = initial margin fraction in basis points: 10000/leverage
    const fraction = Math.round(10000 / leverage);
    const mode = marginMode === "isolated" ? 1 : 0;
    const signed = await this._signer.signUpdateLeverage({
      marketIndex, fraction, marginMode: mode, nonce,
      apiKeyIndex: this._apiKeyIndex, accountIndex: this._accountIndex,
    });
    if (signed.error) {
      throw new Error(`Signer: ${signed.error}`);
    }
    return this.sendTx(signed);
  }

  async withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number }): Promise<unknown> {
    return this._withdrawRaw(parseFloat(amount), opts?.assetId ?? 3, opts?.routeType ?? 0);
  }

  private async _withdrawRaw(amount: number, assetId = 3, routeType = 0): Promise<unknown> {
    this.ensureSigner();
    const nonce = await this.getNextNonce();
    const signed = await this._signer.signWithdraw({
      usdcAmount: amount, assetIndex: assetId, routeType, nonce,
      apiKeyIndex: this._apiKeyIndex, accountIndex: this._accountIndex,
    });
    return this.sendTx(signed);
  }

  // ── Interface aliases ──

  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    return this.modifyOrder(symbol, orderId, price, size);
  }

  async setLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross") {
    return this.updateLeverage(symbol, leverage, marginMode);
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangeTrade[]> {
    await this.ensureMarketMap();
    const marketId = this.getMarketIndex(symbol);
    const res = await this.restGet("/recentTrades", { market_id: String(marketId), limit: String(limit) }) as Record<string, unknown>;
    const trades = (res.trades ?? []) as Record<string, unknown>[];
    return trades.map((t) => ({
      time: Number(t.timestamp ?? 0) * 1000,
      symbol,
      // /recentTrades returns is_maker_ask: maker was asking → taker bought
      side: t.is_maker_ask ? "buy" as const : "sell" as const,
      price: String(t.price ?? "0"),
      size: String(t.size ?? t.base_amount ?? t.amount ?? ""),
      fee: String(t.fee ?? "0"),
    }));
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string | null }[]> {
    const rates = await this.getFundingRates();
    const r = rates.get(symbol.toUpperCase());
    if (!r) return [];
    // Lighter funding-rates is current only, not historical
    return [{ time: Date.now(), rate: r.rate, price: r.markPrice }];
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const res = await this.getCandles(symbol, interval, startTime, endTime) as Record<string, unknown>;
    const candles = (res.candles ?? []) as Record<string, unknown>[];
    return candles.map((c) => ({
      time: Number(c.start_timestamp ?? c.t ?? 0),
      open: String(c.open ?? c.o ?? "0"),
      high: String(c.high ?? c.h ?? "0"),
      low: String(c.low ?? c.l ?? "0"),
      close: String(c.close ?? c.c ?? "0"),
      volume: String(c.base_token_volume ?? c.v ?? ""),
      trades: Number(c.trades_count ?? c.n ?? 0),
    }));
  }

  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp init");
    const raw = await this._getOrderHistoryRaw() as Record<string, unknown>;
    const orders = (raw.orders ?? []) as Record<string, unknown>[];
    return orders.slice(0, limit).map((o) => ({
      orderId: String(o.order_index ?? o.order_id ?? ""),
      symbol: String(o.symbol ?? ""),
      side: o.is_ask ? "sell" as const : "buy" as const,
      price: String(o.price ?? "0"),
      size: String(o.initial_base_amount ?? o.base_amount ?? ""),
      filled: String(o.filled_base_amount ?? "0"),
      status: String(o.status ?? "done"),
      type: String(o.type ?? "limit"),
    }));
  }

  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp init");
    const raw = await this._getTradeHistoryRaw(limit) as Record<string, unknown>;
    const trades = (raw.trades ?? []) as Record<string, unknown>[];
    return trades.slice(0, limit).map((t) => ({
      time: Number(t.timestamp ?? 0) * 1000,
      symbol: String(t.symbol ?? ""),
      side: t.is_ask ? "sell" as const : "buy" as const,
      price: String(t.price ?? "0"),
      size: String(t.base_amount ?? t.amount ?? ""),
      fee: String(t.fee ?? "0"),
    }));
  }

  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp init");
    const raw = await this._getPositionFundingRaw() as Record<string, unknown>;
    const items = (raw.funding ?? []) as Record<string, unknown>[];
    return items.slice(0, limit).map((f) => ({
      time: Number(f.timestamp ?? 0) * 1000,
      symbol: String(f.symbol ?? ""),
      payment: String(f.change ?? f.amount ?? f.payment ?? "0"),
    }));
  }

  /**
   * Get funding rates for all markets.
   * API: GET /api/v1/funding-rates
   */
  async getFundingRates(): Promise<Map<string, { rate: string; markPrice: string }>> {
    const map = new Map<string, { rate: string; markPrice: string }>();
    try {
      const res = await this.restGet("/funding-rates", {}) as {
        funding_rates?: Array<{ market_id: number; rate: number; symbol: string; funding_rate?: string; mark_price?: string }>;
      };

      const reverseMap = new Map<number, string>();
      for (const [sym, idx] of this._marketMap) {
        reverseMap.set(idx, sym);
      }

      for (const fr of res.funding_rates ?? []) {
        const symbol = fr.symbol || reverseMap.get(fr.market_id);
        if (symbol) {
          map.set(symbol, {
            rate: String(fr.rate ?? fr.funding_rate ?? "0"),
            markPrice: fr.mark_price ?? "0",
          });
        }
      }
    } catch { /* non-critical */ }
    return map;
  }

  /**
   * Get candle data for a market.
   */
  async getCandles(symbol: string, resolution: string, startTime: number, endTime: number, countBack = 100): Promise<unknown> {
    await this.ensureMarketMap();
    const marketId = this.getMarketIndex(symbol);
    return this.restGet("/candles", {
      market_id: String(marketId),
      resolution,
      start_timestamp: String(startTime),
      end_timestamp: String(endTime),
      count_back: String(countBack),
    });
  }

  /**
   * Get order history (inactive orders) — raw response.
   */
  private async _getOrderHistoryRaw(): Promise<unknown> {
    if (this._accountIndex < 0 || this._readOnly) return { orders: [] };
    const allOrders: Record<string, unknown>[] = [];
    const entries = Array.from(this._marketMap.entries());
    const results = await Promise.allSettled(
      entries.map(([sym, marketId]) =>
        this.restGetAuth("/accountInactiveOrders", {
          account_index: String(this._accountIndex),
          market_id: String(marketId),
        }).then((res) => {
          const orders = ((res as Record<string, unknown>).orders ?? []) as Record<string, unknown>[];
          return orders.map((o) => ({ ...o, symbol: o.symbol ?? sym }));
        })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled") allOrders.push(...r.value);
    }
    return { orders: allOrders };
  }

  /**
   * Get trade history — raw response.
   */
  private async _getTradeHistoryRaw(limit = 100): Promise<unknown> {
    if (this._accountIndex < 0) return { trades: [] };
    // Ensure market map is populated (init may have been rate-limited)
    if (this._marketMap.size === 0) await this._refreshMarketMap();
    const allTrades: Record<string, unknown>[] = [];
    const entries = Array.from(this._marketMap.entries());
    const results = await Promise.allSettled(
      entries.map(([sym, marketId]) =>
        this.restGetAuth("/trades", {
          account_index: String(this._accountIndex),
          market_id: String(marketId),
          limit: String(Math.min(limit, 20)),
        }).then((res) => {
          const trades = ((res as Record<string, unknown>).trades ?? []) as Record<string, unknown>[];
          return trades.map((t) => ({ ...t, symbol: t.symbol ?? sym }));
        })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled") allTrades.push(...r.value);
    }
    // Sort by timestamp descending
    allTrades.sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
    return { trades: allTrades.slice(0, limit) };
  }

  /**
   * Get position funding history — raw response.
   */
  private async _getPositionFundingRaw(): Promise<unknown> {
    if (this._accountIndex < 0) return { funding: [] };
    if (this._marketMap.size === 0) await this._refreshMarketMap();

    // Only query markets where the account has/had positions (avoids 156-market fan-out)
    const acct = await this.fetchAccount();
    const activeMarketIds = new Set<number>();
    if (acct) {
      for (const p of (acct.positions as unknown as Record<string, unknown>[]) ?? []) {
        const pos = Number(p.position || 0);
        const rpnl = Number(p.realized_pnl || 0);
        if (pos !== 0 || rpnl !== 0) {
          activeMarketIds.add(Number(p.market_id));
        }
      }
    }
    if (activeMarketIds.size === 0) return { funding: [] };

    // Resolve market_id → symbol from marketMap
    const reverseMap = new Map<number, string>();
    for (const [sym, id] of this._marketMap) reverseMap.set(id, sym);

    const allFunding: Record<string, unknown>[] = [];
    const results = await Promise.allSettled(
      Array.from(activeMarketIds).map((marketId) => {
        const sym = reverseMap.get(marketId) ?? `Market-${marketId}`;
        return this.restGetAuth("/positionFunding", {
          account_index: String(this._accountIndex),
          market_id: String(marketId),
          limit: "100",
          side: "all",
        }).then((res) => {
          const items = ((res as Record<string, unknown>).position_fundings ?? (res as Record<string, unknown>).funding ?? (res as Record<string, unknown>).data ?? []) as Record<string, unknown>[];
          return items.map((f) => ({ ...f, symbol: f.symbol ?? sym }));
        });
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") allFunding.push(...r.value);
    }
    allFunding.sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
    return { funding: allFunding };
  }

  /**
   * Get PnL chart data.
   */
  async getPnl(period = "1d"): Promise<unknown> {
    return this.restGet("/pnl", {
      account_index: String(this._accountIndex),
      period,
    });
  }

  /**
   * Get deposit history.
   */
  async getDepositHistory(): Promise<unknown> {
    return this.restGet("/deposit_history", {
      l1_address: this._address,
    });
  }

  /**
   * Get withdrawal history.
   */
  async getWithdrawHistory(): Promise<unknown> {
    return this.restGet("/withdraw_history", {
      account_index: String(this._accountIndex),
    });
  }

  /**
   * Get transfer history.
   */
  async getTransferHistory(): Promise<unknown> {
    return this.restGet("/transfer_history", {
      account_index: String(this._accountIndex),
    });
  }

  /**
   * Get asset details.
   */
  async getAssetDetails(assetId?: number): Promise<unknown> {
    const params: Record<string, string> = {};
    if (assetId !== undefined) params.asset_id = String(assetId);
    return this.restGet("/assetDetails", params);
  }

  /**
   * Get exchange metrics.
   */
  async getExchangeMetrics(symbol?: string): Promise<unknown> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.restGet("/exchangeMetrics", params);
  }

  /**
   * Get account limits.
   */
  async getAccountLimits(): Promise<unknown> {
    return this.restGet("/accountLimits", {
      account_index: String(this._accountIndex),
    });
  }

  /**
   * Create CCTP intent address for cross-chain deposit.
   */
  async createIntentAddress(chainId: number): Promise<unknown> {
    const res = await fetch(`${this._baseUrl}/api/v1/createIntentAddress`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chain_id: String(chainId),
        from_addr: this._address,
        amount: "0",
        is_external_deposit: "true",
      }),
    });
    if (!res.ok) throw new Error(`createIntentAddress failed: ${await res.text()}`);
    return res.json();
  }

  /**
   * Use a referral code.
   */
  async useReferralCode(code: string): Promise<unknown> {
    // Referral endpoint requires POST with l1_address, referral_code, and auth (form-urlencoded)
    const auth = await this.getAuthToken();
    const res = await fetch(`${this._baseUrl}/api/v1/referral/use`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ l1_address: this._address, referral_code: code, auth }),
    });
    const json = await res.json() as { code?: number; message?: string };
    if (json.code && json.code !== 200) throw new Error(`Referral failed: ${json.message ?? JSON.stringify(json)}`);
    return json;
  }

  /**
   * Direct REST GET helper.
   */
  private async getNextNonce(): Promise<number> {
    const res = await this.restGet("/nextNonce", {
      account_index: String(this._accountIndex),
      api_key_index: String(this._apiKeyIndex),
    }) as { nonce?: number; next_nonce?: number };
    return res.nonce ?? res.next_nonce ?? 0;
  }

  private async signOrder(params: {
    marketIndex: number; clientOrderIndex: number; baseAmount: number;
    price: number; isAsk: number; orderType: number; timeInForce: number;
    reduceOnly: number; triggerPrice: number; orderExpiry: number; nonce: number;
  }): Promise<WasmTxResponse> {
    try {
      const result = await this._signer.signCreateOrder({
        ...params,
        apiKeyIndex: this._apiKeyIndex,
        accountIndex: this._accountIndex,
      });
      if (result.error) {
        throw new Error(`Signer: ${result.error}`);
      }
      return result;
    } catch (e: unknown) {
      if (e instanceof Error) throw e;
      if (typeof e === "object" && e !== null && "error" in e) {
        throw new Error(`Signer: ${(e as Record<string, string>).error}`);
      }
      throw new Error(`Signer: ${JSON.stringify(e)}`);
    }
  }

  private async sendTx(signed: WasmTxResponse): Promise<unknown> {
    if (signed.error) throw new Error(`Signer error: ${signed.error}`);
    if (!signed.txInfo) throw new Error("Signer returned empty txInfo");
    const res = await fetch(`${this._baseUrl}/api/v1/sendTx`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tx_type: String(signed.txType ?? 0),
        tx_info: signed.txInfo,
      }),
    });
    const json = await res.json() as { code: number; message?: string; tx_hash?: string };
    if (json.code !== 200) throw new Error(`sendTx failed: ${json.message ?? JSON.stringify(json)}`);
    return json;
  }

  private async restGet(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this._baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  /** Generate a unique client order index (uint48). */
  private nextClientOrderIndex(): number {
    const base = Math.floor(Date.now() / 1000) % 281_474_976_710_000;
    return base + (this._clientOrderCounter++ % 655);
  }

  private ensureSigner(): void {
    if (this._readOnly || this._accountIndex < 0 || !this._signer) {
      throw new Error(
        "This command requires a Lighter API key. Run `perp -e lighter manage setup-api-key` first, " +
        "then set LIGHTER_API_KEY in your .env"
      );
    }
  }

  private static _wasmClient: WasmSignerClientType | null = null;

  private static async getWasmClient(): Promise<WasmSignerClientType> {
    if (LighterAdapter._wasmClient) return LighterAdapter._wasmClient;
    // Resolve WASM path from SDK package location (fixes --prefix / global installs)
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const sdkEntry = import.meta.resolve("lighter-ts-sdk");
    // sdkEntry → file:///…/node_modules/lighter-ts-sdk/dist/esm/index.js
    // Walk up to package root: dist/esm/index.js → 3 levels
    const sdkRoot = dirname(dirname(dirname(fileURLToPath(sdkEntry))));
    const wasmPath = join(sdkRoot, "wasm", "lighter-signer.wasm");
    const wasmExecPath = join(sdkRoot, "wasm", "wasm_exec.js");
    // Prevent Go WASM runtime from killing the process on panic
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      process.exit = origExit; // restore immediately
      throw new Error(`Lighter WASM runtime exited with code ${code}`);
    }) as typeof process.exit;
    try {
      const { WasmSignerClient } = await import("lighter-ts-sdk");
      const client = new WasmSignerClient({ wasmPath, wasmExecPath });
      await client.initialize();
      LighterAdapter._wasmClient = client;
      return client;
    } finally {
      process.exit = origExit;
    }
  }

  /**
   * Generate a new Lighter API key pair using the WASM signer.
   * Returns { privateKey, publicKey } (both 0x-prefixed, 40 bytes).
   */
  static async generateApiKey(): Promise<{ privateKey: string; publicKey: string }> {
    const client = await LighterAdapter.getWasmClient();
    return client.generateAPIKey();
  }

  /**
   * Generate an API key and register it on-chain via ChangePubKey.
   * Uses WASM signer to sign + ETH key for L1 signature.
   * Returns the generated key pair.
   */
  async setupApiKey(apiKeyIndex = 4): Promise<{ privateKey: string; publicKey: string }> {
    if (!this._evmSigner) {
      throw new Error("No EVM private key configured. Run: perp init");
    }
    if (this._accountIndex < 0) {
      throw new Error("Account index not available. Call init() first or set LIGHTER_ACCOUNT_INDEX.");
    }

    // 1. Generate key pair
    const { privateKey, publicKey } = await LighterAdapter.generateApiKey();

    // 2. Get nonce from API
    const nonceRes = await this.restGet("/nextNonce", {
      account_index: String(this._accountIndex),
      api_key_index: String(apiKeyIndex),
    }) as { nonce?: number; next_nonce?: number };
    const nonce = nonceRes.nonce ?? nonceRes.next_nonce ?? 0;

    // 3. Create signer client with new key and sign ChangePubKey
    const client = await LighterAdapter.getWasmClient();
    await client.createClient({
      url: this._baseUrl,
      privateKey,
      chainId: this._chainId,
      apiKeyIndex,
      accountIndex: this._accountIndex,
    });

    // Sign ChangePubKey
    const signed = await client.signChangePubKey({
      pubkey: publicKey,
      nonce,
      apiKeyIndex,
      accountIndex: this._accountIndex,
    });

    if (signed.error) throw new Error(`SignChangePubKey failed: ${signed.error}`);
    if (!signed.txInfo || !signed.messageToSign) {
      throw new Error("SignChangePubKey returned incomplete response");
    }

    // 4. Sign messageToSign with EVM signer (EIP-191 personal_sign)
    const l1Sig = await this._evmSigner!.signMessage(signed.messageToSign);

    // 5. Add L1Sig to txInfo
    const txInfo = JSON.parse(signed.txInfo);
    txInfo.L1Sig = l1Sig;

    // 6. Submit to Lighter API
    const sendRes = await fetch(`${this._baseUrl}/api/v1/sendTx`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tx_type: String(signed.txType ?? 0),
        tx_info: JSON.stringify(txInfo),
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      throw new Error(`ChangePubKey sendTx failed (${sendRes.status}): ${errText}`);
    }

    const result = await sendRes.json() as { code: number; message?: string; tx_hash?: string };
    if (result.code !== 200) {
      // Retry with fresh nonce if invalid nonce (pending tx or stale nonce)
      if (result.message && /invalid nonce/i.test(result.message)) {
        const MAX_NONCE_RETRIES = 3;
        let lastError = result.message;

        for (let attempt = 1; attempt <= MAX_NONCE_RETRIES; attempt++) {
          await new Promise(r => setTimeout(r, 500 * attempt));

          // Re-fetch nonce from API (may have updated since first call)
          const freshNonceRes = await this.restGet("/nextNonce", {
            account_index: String(this._accountIndex),
            api_key_index: String(apiKeyIndex),
          }) as { nonce?: number; next_nonce?: number };
          const freshNonce = (freshNonceRes.nonce ?? freshNonceRes.next_nonce ?? nonce) + attempt;

          const retrySigned = await client.signChangePubKey({
            pubkey: publicKey, nonce: freshNonce, apiKeyIndex, accountIndex: this._accountIndex,
          });
          if (retrySigned.error || !retrySigned.txInfo || !retrySigned.messageToSign) {
            lastError = retrySigned.error ?? "incomplete response";
            continue;
          }
          const retryTxInfo = JSON.parse(retrySigned.txInfo);
          retryTxInfo.L1Sig = await this._evmSigner!.signMessage(retrySigned.messageToSign);
          const retryRes = await fetch(`${this._baseUrl}/api/v1/sendTx`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              tx_type: String(retrySigned.txType ?? 0),
              tx_info: JSON.stringify(retryTxInfo),
            }),
          });
          if (!retryRes.ok) {
            lastError = `sendTx ${retryRes.status}: ${await retryRes.text()}`;
            continue;
          }
          const retryResult = await retryRes.json() as { code: number; message?: string };
          if (retryResult.code === 200) {
            return { privateKey, publicKey }; // Success on retry
          }
          lastError = retryResult.message ?? JSON.stringify(retryResult);
          if (!/invalid nonce/i.test(lastError)) break; // Different error, stop retrying
        }
        throw new Error(`ChangePubKey failed after ${MAX_NONCE_RETRIES} nonce retries: ${lastError}`);
      } else {
        throw new Error(`ChangePubKey failed: ${result.message ?? JSON.stringify(result)}`);
      }
    }

    return { privateKey, publicKey };
  }

  // No longer need getApi() — all reads go through REST, all writes through signer + sendTx
}
