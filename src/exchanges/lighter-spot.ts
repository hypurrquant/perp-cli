/**
 * Lighter Spot Adapter.
 *
 * Uses the same `/api/v1/sendTx` endpoint as perps — the only difference
 * is the market_id (spot markets have different IDs from perp markets).
 *
 * Composes with LighterAdapter for signing and API access.
 */

import type { SpotAdapter, SpotMarketInfo, SpotBalance } from "./spot-interface.js";
import type { LighterAdapter } from "./lighter.js";

export class LighterSpotAdapter implements SpotAdapter {
  readonly name = "lighter";
  private _lt: LighterAdapter;
  private _spotMarketMap = new Map<string, number>(); // "ETH/USDC" → market_id
  private _spotBaseMap = new Map<string, string>(); // "ETH" → "ETH/USDC"
  private _spotDecimals = new Map<string, { size: number; price: number }>();
  private _spotMinSize = new Map<string, { base: number; quote: number }>(); // min order sizes
  private _initialized = false;

  constructor(ltAdapter: LighterAdapter) {
    this._lt = ltAdapter;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._loadSpotMarkets();
    this._initialized = true;
  }

  private async _loadSpotMarkets(): Promise<void> {
    try {
      // Use orderBooks API with filter=spot for accurate market config
      const res = await this._restGet("/orderBooks", { filter: "spot" }) as {
        order_books?: Array<{
          symbol: string;
          market_id: number;
          market_type: string;
          status: string;
          supported_size_decimals: number;
          supported_price_decimals: number;
          min_base_amount: string;
          min_quote_amount: string;
        }>;
      };

      for (const ob of res.order_books ?? []) {
        if (ob.status !== "active") continue;
        const symbol = ob.symbol.toUpperCase(); // e.g., "ETH/USDC"
        this._spotMarketMap.set(symbol, ob.market_id);
        this._spotDecimals.set(symbol, {
          size: ob.supported_size_decimals,
          price: ob.supported_price_decimals,
        });
        this._spotMinSize.set(symbol, {
          base: parseFloat(ob.min_base_amount || "0"),
          quote: parseFloat(ob.min_quote_amount || "0"),
        });
        const base = symbol.split("/")[0];
        if (base) this._spotBaseMap.set(base, symbol);
      }
    } catch (e) {
      // Fallback: use explorer API if orderBooks fails
      try {
        const res = await fetch("https://explorer.elliot.ai/api/markets");
        const markets = (await res.json()) as Array<{ symbol: string; market_index: number }>;
        for (const m of markets) {
          if (!m.symbol.includes("/")) continue;
          const symbol = m.symbol.toUpperCase();
          this._spotMarketMap.set(symbol, m.market_index);
          this._spotDecimals.set(symbol, { size: 2, price: 4 });
          const base = symbol.split("/")[0];
          if (base) this._spotBaseMap.set(base, symbol);
        }
      } catch {
        console.error("[lt-spot] Failed to load spot markets:", e instanceof Error ? e.message : e);
      }
    }
  }

  /** Resolve a symbol (e.g., "ETH" or "ETH/USDC") to the full spot symbol */
  private resolveSymbol(symbol: string): string {
    const upper = symbol.toUpperCase();
    if (this._spotMarketMap.has(upper)) return upper;
    // Try base token → full symbol
    const full = this._spotBaseMap.get(upper);
    if (full) return full;
    // Try adding /USDC
    const withUsdc = `${upper}/USDC`;
    if (this._spotMarketMap.has(withUsdc)) return withUsdc;
    return upper;
  }

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    await this.init();
    const entries = Array.from(this._spotMarketMap.entries());

    // Fetch all orderbooks in parallel (instead of sequential per-market)
    const obResults = await Promise.allSettled(
      entries.map(([symbol]) =>
        this.getSpotOrderbook(symbol).then(ob => {
          if (ob.bids.length > 0 && ob.asks.length > 0) {
            return String((Number(ob.bids[0][0]) + Number(ob.asks[0][0])) / 2);
          }
          return "0";
        })
      )
    );

    return entries.map(([symbol], i) => {
      const parts = symbol.split("/");
      const base = parts[0] ?? "";
      const quote = parts[1] ?? "USDC";
      const dec = this._spotDecimals.get(symbol) ?? { size: 4, price: 2 };
      const markPrice = obResults[i].status === "fulfilled" ? obResults[i].value : "0";
      return {
        symbol, baseToken: base, quoteToken: quote,
        markPrice, volume24h: "0",
        sizeDecimals: dec.size, priceDecimals: dec.price,
      };
    });
  }

  async getSpotOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new Error(`Unknown Lighter spot market: ${symbol}`);
    }
    try {
      const res = await this._restGet("/orderBookOrders", {
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

  async getSpotBalances(): Promise<SpotBalance[]> {
    try {
      await this.init();
      const balances: SpotBalance[] = [];
      const address = this._lt.address;
      if (!address) return [];

      const res = await this._restGet("/account", {
        by: "l1_address",
        value: address,
      }) as {
        accounts?: Array<{
          account_index: number;
          collateral?: number | string;
          available_balance?: number | string;
          assets?: Array<{
            symbol: string;
            asset_id: number;
            balance: string;
            locked_balance: string;
          }>;
        }>;
      };
      const acct = res.accounts?.find(a => a.account_index === this._lt.accountIndex)
        ?? res.accounts?.[0];
      if (!acct) return [];

      // Spot token balances from the assets array only.
      // Perp USDC (collateral) is already reported by getBalance() — don't duplicate here.
      if (acct.assets && acct.assets.length > 0) {
        for (const asset of acct.assets) {
          const bal = parseFloat(asset.balance || "0");
          const locked = parseFloat(asset.locked_balance || "0");
          if (bal > 0) {
            balances.push({
              token: asset.symbol === "USDC" ? "USDC_SPOT" : asset.symbol,
              total: asset.balance,
              available: String(bal - locked),
              held: asset.locked_balance,
            });
          }
        }
      }

      return balances;
    } catch {
      return [];
    }
  }

  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string): Promise<unknown> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new Error(`Unknown Lighter spot market: ${symbol}`);
    }

    // Validate min order size
    const minSize = this._spotMinSize.get(resolved);
    const sizeNum = parseFloat(size);
    if (minSize && sizeNum < minSize.base) {
      throw new Error(`Size ${size} below min_base_amount ${minSize.base} for ${resolved}`);
    }

    // Use orderbook-based price with 5% slippage (like Hyperliquid spot adapter)
    const ob = await this.getSpotOrderbook(resolved);
    let refPrice: number;
    if (side === "buy") {
      if (ob.asks.length === 0) throw new Error(`No asks in ${resolved} spot orderbook`);
      refPrice = Number(ob.asks[0][0]);
    } else {
      if (ob.bids.length === 0) throw new Error(`No bids in ${resolved} spot orderbook`);
      refPrice = Number(ob.bids[0][0]);
    }

    // Validate min quote amount (size × price ≥ min_quote)
    if (minSize && sizeNum * refPrice < minSize.quote) {
      throw new Error(`Order value $${(sizeNum * refPrice).toFixed(2)} below min_quote_amount $${minSize.quote} for ${resolved}`);
    }

    const slippagePrice = side === "buy" ? refPrice * 1.05 : refPrice * 0.95;
    const dec = this._spotDecimals.get(resolved) ?? { size: 2, price: 4 };

    const baseAmount = Math.round(sizeNum * Math.pow(10, dec.size));
    const priceTicks = Math.round(slippagePrice * Math.pow(10, dec.price));

    return this._placeOrder({
      marketIndex: marketId,
      baseAmount,
      price: Math.max(priceTicks, 1),
      isAsk: side === "sell" ? 1 : 0,
      orderType: 1, // MARKET
      timeInForce: 0, // IOC
    });
  }

  async spotLimitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { tif?: string }): Promise<unknown> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new Error(`Unknown Lighter spot market: ${symbol}`);
    }

    // Validate min order size
    const sizeNum = parseFloat(size);
    const priceNum = parseFloat(price);
    const minSize = this._spotMinSize.get(resolved);
    if (minSize) {
      if (sizeNum < minSize.base) {
        throw new Error(`Size ${size} below min_base_amount ${minSize.base} for ${resolved}`);
      }
      if (sizeNum * priceNum < minSize.quote) {
        throw new Error(`Order value $${(sizeNum * priceNum).toFixed(2)} below min_quote_amount $${minSize.quote} for ${resolved}`);
      }
    }

    const dec = this._spotDecimals.get(resolved) ?? { size: 2, price: 4 };
    const baseAmount = Math.round(sizeNum * Math.pow(10, dec.size));
    const priceTicks = Math.round(priceNum * Math.pow(10, dec.price));
    const isIoc = opts?.tif?.toUpperCase() === "IOC";

    return this._placeOrder({
      marketIndex: marketId,
      baseAmount,
      price: priceTicks,
      isAsk: side === "sell" ? 1 : 0,
      orderType: 0, // LIMIT
      timeInForce: isIoc ? 0 : 1,
    });
  }

  async spotCancelOrder(symbol: string, orderId: string): Promise<unknown> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new Error(`Unknown Lighter spot market: ${symbol}`);
    }

    // Access signer through the adapter
    const signer = this._lt.signer;
    const nonce = await this._getNextNonce();
    const signed = await signer.signCancelOrder({
      marketIndex: marketId,
      orderIndex: parseInt(orderId),
      nonce,
      apiKeyIndex: (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex,
      accountIndex: this._lt.accountIndex,
    });
    return this._sendTx(signed);
  }

  /** Transfer USDC from perp account to spot account (required before spot buys) */
  async transferUsdcToSpot(amount: number): Promise<unknown> {
    return this._selfTransfer(amount, 0, 1); // route: Perp(0) → Spot(1)
  }

  /** Transfer USDC from spot account back to perp account */
  async transferUsdcToPerp(amount: number): Promise<unknown> {
    return this._selfTransfer(amount, 1, 0); // route: Spot(1) → Perp(0)
  }

  /**
   * Internal self-transfer using raw WASM signTransfer.
   * TS SDK's is_spot_account mapping is buggy (sets both fromRoute and toRoute
   * to the same value), so we call the WASM module directly with explicit routes.
   * Route types: 0 = Perp, 1 = Spot
   */
  private async _selfTransfer(amount: number, fromRoute: number, toRoute: number): Promise<unknown> {
    if (this._lt.isReadOnly) throw new Error("Transfer requires API key");
    const nonce = await this._getNextNonce();
    const apiKeyIndex = (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex;
    const USDC_SCALE = 1_000_000; // 6 decimals
    const scaledAmount = Math.floor(amount * USDC_SCALE);
    const memo = "0x" + "00".repeat(32);

    // Access the raw WASM module to bypass SDK's buggy route mapping
    // Path: signer → WasmSignerClient → wallet (WasmSigner) → wasmModule
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signerAny = this._lt.signer as any;
    const wasmModule = (signerAny.wallet?.wasmModule ?? signerAny.wasmModule) as {
      signTransfer?(
        toAccountIndex: number, assetIndex: number,
        fromRouteType: number, toRouteType: number,
        amount: number, fee: number, memo: string,
        nonce: number, apiKeyIndex: number, accountIndex: number,
      ): { txType?: number; txInfo?: string; error?: string };
    } | undefined;

    if (wasmModule?.signTransfer) {
      const result = wasmModule.signTransfer(
        this._lt.accountIndex, 3, // toAccountIndex (self), assetIndex = USDC
        fromRoute, toRoute,
        scaledAmount, 0, memo,
        nonce, apiKeyIndex, this._lt.accountIndex,
      );
      if (result.error) throw new Error(`Transfer sign error: ${result.error}`);
      return this._sendTx({ txType: result.txType ?? 12, txInfo: result.txInfo });
    }

    // Fallback: use SDK signTransfer with explicit route_from/route_to
    // The SDK's signTransfer internally calls wasmModule.signTransfer with 10 args
    const signer = this._lt.signer;
    // Try SDK's higher-level transferSameMasterAccount first (if available)
    const client = signer as unknown as {
      transferSameMasterAccount?(p: Record<string, unknown>): Promise<[unknown, string, string | null]>;
      signTransfer?(p: Record<string, unknown>): Promise<{ txType?: number; txInfo?: string; error?: string }>;
    };
    if (client.transferSameMasterAccount) {
      const [txInfo, txHash, err] = await client.transferSameMasterAccount({
        toAccountIndex: this._lt.accountIndex,
        usdcAmount: amount, // SDK scales internally
        asset_id: 3,
        fee: 0, memo,
      });
      if (err) throw new Error(`Transfer error: ${err}`);
      return { code: 200, tx_hash: txHash };
    }

    // Last resort: SDK signTransfer
    const signed = await (signer as unknown as {
      signTransfer(p: Record<string, unknown>): Promise<{ txType?: number; txInfo?: string; error?: string }>;
    }).signTransfer({
      toAccountIndex: this._lt.accountIndex,
      usdcAmount: scaledAmount, asset_id: 3,
      is_spot_account: toRoute === 1,
      fee: 0, memo, nonce, apiKeyIndex,
      accountIndex: this._lt.accountIndex,
    });
    return this._sendTx(signed);
  }

  /** Get the spot market ID for a symbol */
  getSpotMarketId(symbol: string): number | undefined {
    return this._spotMarketMap.get(this.resolveSymbol(symbol));
  }

  /** Check if a base token has a spot market */
  hasSpotMarket(base: string): boolean {
    return this._spotBaseMap.has(base.toUpperCase()) ||
      this._spotMarketMap.has(`${base.toUpperCase()}/USDC`);
  }

  // ── Private helpers ──

  private async _placeOrder(opts: {
    marketIndex: number;
    baseAmount: number;
    price: number;
    isAsk: number;
    orderType: number;
    timeInForce: number;
  }): Promise<unknown> {
    if (this._lt.isReadOnly) {
      throw new Error("Spot trading requires a Lighter API key. Run `perp -e lighter manage setup-api-key` first.");
    }
    const nonce = await this._getNextNonce();
    const signer = this._lt.signer;
    const apiKeyIndex = (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex;
    const signed = await signer.signCreateOrder({
      marketIndex: opts.marketIndex,
      clientOrderIndex: 0,
      baseAmount: opts.baseAmount,
      price: opts.price,
      isAsk: opts.isAsk,
      orderType: opts.orderType,
      timeInForce: opts.timeInForce,
      reduceOnly: 0,
      triggerPrice: 0,
      orderExpiry: opts.timeInForce === 0 ? 0 : -1,
      nonce,
      apiKeyIndex,
      accountIndex: this._lt.accountIndex,
    });
    if ((signed as { error?: string }).error) {
      throw new Error(`Signer: ${(signed as { error: string }).error}`);
    }
    return this._sendTx(signed);
  }

  private async _getNextNonce(): Promise<number> {
    const apiKeyIndex = (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex;
    const res = await this._restGet("/nextNonce", {
      account_index: String(this._lt.accountIndex),
      api_key_index: String(apiKeyIndex),
    }) as { nonce?: number; next_nonce?: number };
    return res.nonce ?? res.next_nonce ?? 0;
  }

  private async _sendTx(signed: { txType?: number; txInfo?: string; error?: string }): Promise<unknown> {
    if (signed.error) throw new Error(`Signer error: ${signed.error}`);
    if (!signed.txInfo) throw new Error("Signer returned empty txInfo");
    const baseUrl = (this._lt as unknown as { _baseUrl: string })._baseUrl;
    const res = await fetch(`${baseUrl}/api/v1/sendTx`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tx_type: String(signed.txType ?? 0),
        tx_info: signed.txInfo,
      }),
    });
    const json = await res.json() as { code: number; message?: string };
    if (json.code !== 200) throw new Error(`sendTx failed: ${json.message ?? JSON.stringify(json)}`);
    return json;
  }

  private async _restGet(path: string, params: Record<string, string>): Promise<unknown> {
    const baseUrl = (this._lt as unknown as { _baseUrl: string })._baseUrl;
    const url = new URL(`${baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  private async _restGetAuth(path: string, params: Record<string, string>): Promise<unknown> {
    if (this._lt.isReadOnly) throw new Error("Auth requires API key");
    const auth = await (this._lt as unknown as { getAuthToken(): Promise<string> }).getAuthToken();
    params.auth = auth;
    return this._restGet(path, params);
  }
}
