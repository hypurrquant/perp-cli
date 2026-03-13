/**
 * Hyperliquid Spot Adapter.
 *
 * Uses the same exchange.placeOrder() endpoint as perps — the only difference
 * is the asset index: spot assets use `10000 + spotIndex`.
 *
 * Composes with HyperliquidAdapter for signing and API access.
 */

import type { SpotAdapter, SpotMarketInfo, SpotBalance } from "./spot-interface.js";
import { PERP_TO_SPOT_MAP, SPOT_PERP_TOKEN_MAP } from "./spot-interface.js";
import type { HyperliquidAdapter } from "./hyperliquid.js";

export class HyperliquidSpotAdapter implements SpotAdapter {
  readonly name = "hyperliquid";
  private _hl: HyperliquidAdapter;
  private _spotAssetMap = new Map<string, number>(); // "ETH" → spotIndex (not +10000)
  private _spotAssetReverse = new Map<number, string>(); // spotIndex → "ETH"
  private _spotDecimals = new Map<string, { size: number; price: number }>();
  private _initialized = false;

  constructor(hlAdapter: HyperliquidAdapter) {
    this._hl = hlAdapter;
  }

  /** Load spot metadata from the Hyperliquid spot API */
  async init(): Promise<void> {
    if (this._initialized) return;
    await this._loadSpotMeta();
    this._initialized = true;
  }

  private async _loadSpotMeta(): Promise<void> {
    try {
      const meta = await this._infoPost({ type: "spotMeta" }) as {
        tokens?: Array<{ name: string; index: number; tokenId: string }>;
        universe?: Array<{
          name: string;
          tokens: [number, number]; // [base token index, quote token index]
          index: number;
        }>;
      };

      if (!meta?.universe) return;

      // Token index → name map
      const tokenNames = new Map<number, string>();
      for (const t of meta.tokens ?? []) {
        tokenNames.set(t.index, t.name);
      }

      // Find USDC token index for filtering
      const usdcTokenIndex = meta.tokens?.find(t => t.name === "USDC")?.index ?? 0;

      for (const u of meta.universe) {
        const baseToken = tokenNames.get(u.tokens[0]) ?? "";
        if (!baseToken) continue;
        const key = baseToken.toUpperCase();
        // Prefer /USDC pairs (quote token = USDC). Skip non-USDC pairs if we already have one.
        const isUsdcPair = u.tokens[1] === usdcTokenIndex;
        if (this._spotAssetMap.has(key) && !isUsdcPair) continue;
        this._spotAssetMap.set(key, u.index);
        this._spotAssetReverse.set(u.index, key);
      }

      // Get spot decimals from metaAndAssetCtxs
      const metaCtx = await this._infoPost({ type: "spotMetaAndAssetCtxs" }) as [
        { universe: Array<{ name: string; tokens: [number, number]; index: number; szDecimals?: number }> },
        Array<Record<string, unknown>>,
      ];

      if (metaCtx?.[0]?.universe) {
        for (const u of metaCtx[0].universe) {
          const baseToken = tokenNames.get(u.tokens[0]) ?? "";
          if (!baseToken) continue;
          const key = baseToken.toUpperCase();
          const isUsdcPair = u.tokens[1] === usdcTokenIndex;
          if (this._spotDecimals.has(key) && !isUsdcPair) continue;
          this._spotDecimals.set(key, {
            size: u.szDecimals ?? 2,
            price: 6, // HL spot prices use up to 6 significant digits
          });
        }
      }
    } catch (e) {
      console.error("[hl-spot] Failed to load spot meta:", e instanceof Error ? e.message : e);
    }
  }

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    await this.init();
    try {
      const metaCtx = await this._infoPost({ type: "spotMetaAndAssetCtxs" }) as [
        {
          tokens: Array<{ name: string; index: number }>;
          universe: Array<{
            name: string;
            tokens: [number, number];
            index: number;
            szDecimals?: number;
          }>;
        },
        Array<Record<string, unknown>>,
      ];

      if (!metaCtx?.[0]?.universe) return [];

      const tokenNames = new Map<number, string>();
      for (const t of metaCtx[0].tokens ?? []) {
        tokenNames.set(t.index, t.name);
      }

      const ctxs = metaCtx[1] ?? [];
      const markets: SpotMarketInfo[] = [];

      for (let i = 0; i < metaCtx[0].universe.length; i++) {
        const u = metaCtx[0].universe[i];
        const ctx = ctxs[i] ?? {};
        const baseToken = tokenNames.get(u.tokens[0]) ?? "";
        const quoteToken = tokenNames.get(u.tokens[1]) ?? "USDC";
        if (!baseToken) continue;

        markets.push({
          symbol: `${baseToken}/USDC`,
          baseToken,
          quoteToken,
          markPrice: String(ctx.markPx ?? ctx.midPx ?? "0"),
          volume24h: String(ctx.dayNtlVlm ?? "0"),
          sizeDecimals: u.szDecimals ?? 2,
          priceDecimals: 6,
        });
      }

      return markets;
    } catch {
      return [];
    }
  }

  async getSpotOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    await this.init();
    const { spotIndex } = this._resolveBase(symbol);
    // HL spot L2 book uses the universe name, which is like "ETH/USDC" internally
    // But the API takes coin=<name>, where name is from spotMeta universe
    const book = await this._infoPost({
      type: "l2Book",
      coin: `@${spotIndex}`,
    }) as { levels?: [[Record<string, string>], [Record<string, string>]] };

    const levels = book?.levels ?? [[], []];
    return {
      bids: (levels[0] ?? []).map((l: Record<string, string>) => [
        String(l.px ?? "0"),
        String(l.sz ?? "0"),
      ] as [string, string]),
      asks: (levels[1] ?? []).map((l: Record<string, string>) => [
        String(l.px ?? "0"),
        String(l.sz ?? "0"),
      ] as [string, string]),
    };
  }

  async getSpotBalances(): Promise<SpotBalance[]> {
    try {
      const state = await this._hl.client.info.spot.getSpotClearinghouseState(this._hl.address);
      const balances = state?.balances ?? [];
      return balances.map((b: Record<string, unknown>) => ({
        token: String(b.coin ?? ""),
        total: String(b.total ?? "0"),
        available: String(Number(b.total ?? 0) - Number(b.hold ?? 0)),
        held: String(b.hold ?? "0"),
      }));
    } catch {
      return [];
    }
  }

  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string): Promise<unknown> {
    await this.init();
    const { base, spotIndex } = this._resolveBase(symbol);
    const assetIndex = 10000 + spotIndex;

    // Get mid price for slippage calculation
    const book = await this.getSpotOrderbook(symbol);
    const bestAsk = book.asks.length > 0 ? Number(book.asks[0][0]) : 0;
    const bestBid = book.bids.length > 0 ? Number(book.bids[0][0]) : 0;
    const midPrice = (bestAsk + bestBid) / 2;
    if (midPrice <= 0) throw new Error(`Cannot get price for spot ${base}`);

    // 5% slippage for market orders
    const slippage = 0.05;
    const isBuy = side === "buy";
    const slippagePrice = isBuy ? midPrice * (1 + slippage) : midPrice * (1 - slippage);
    const dec = this._spotDecimals.get(base);
    const priceDec = dec?.price ?? 6;
    const szDec = dec?.size ?? 2;

    // Format price — use significant figures approach
    const limitPrice = Number(slippagePrice.toPrecision(5)).toFixed(priceDec);

    const result = await this._rawPlaceSpotOrder({
      assetIndex,
      isBuy,
      price: limitPrice,
      size: Number(size).toFixed(szDec),
      orderType: { limit: { tif: "Ioc" } },
    });

    // Validate fill — HL returns status "ok" even for 0-fill IoC orders
    this._validateOrderFill(result, base, side, size);
    return result;
  }

  async spotLimitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { tif?: string }): Promise<unknown> {
    await this.init();
    const { base, spotIndex } = this._resolveBase(symbol);
    const assetIndex = 10000 + spotIndex;

    const rawTif = opts?.tif ?? "Gtc";
    const tifMap: Record<string, string> = { IOC: "Ioc", GTC: "Gtc", ALO: "Alo" };
    const tif = tifMap[rawTif.toUpperCase()] ?? rawTif;

    return this._rawPlaceSpotOrder({
      assetIndex,
      isBuy: side === "buy",
      price,
      size,
      orderType: { limit: { tif } },
    });
  }

  async spotCancelOrder(symbol: string, orderId: string): Promise<unknown> {
    await this.init();
    const { spotIndex } = this._resolveBase(symbol);
    const assetIndex = 10000 + spotIndex;

    return this._signAndSendAction({
      type: "cancel",
      cancels: [{ a: assetIndex, o: parseInt(orderId) }],
    });
  }

  /**
   * Transfer USDC between perp and spot accounts.
   * HL uses separate balances — spot buys require USDC in the spot account.
   * Uses SDK's transferBetweenSpotAndPerp (userSignedAction, not L1 action).
   */
  async transferUsdcToSpot(amount: number): Promise<unknown> {
    return this._hl.client.exchange.transferBetweenSpotAndPerp(amount, false);
  }

  async transferUsdcToPerp(amount: number): Promise<unknown> {
    return this._hl.client.exchange.transferBetweenSpotAndPerp(amount, true);
  }

  /** Get the spot asset index (without the 10000 offset) */
  getSpotIndex(base: string): number | undefined {
    return this._spotAssetMap.get(base.toUpperCase());
  }

  /** Get spot size decimals for a base token */
  getSpotDecimals(base: string): { size: number; price: number } {
    return this._spotDecimals.get(base.toUpperCase()) ?? { size: 2, price: 6 };
  }

  /**
   * Resolve a symbol to its actual spot base token and index.
   * Handles U-token mapping: "BTC" → "UBTC" (Unit protocol bridged token).
   * Throws if no mapping found.
   */
  private _resolveBase(symbol: string): { base: string; spotIndex: number } {
    const raw = symbol.split("/")[0].toUpperCase();

    // 1. Direct match (e.g., "ETH" → ETH spot, or "UBTC" → UBTC spot)
    const directIndex = this._spotAssetMap.get(raw);
    if (directIndex !== undefined) return { base: raw, spotIndex: directIndex };

    // 2. U-token mapping: "BTC" → "UBTC" (perp name → spot token name)
    const uToken = PERP_TO_SPOT_MAP[raw];
    if (uToken) {
      const mappedIndex = this._spotAssetMap.get(uToken);
      if (mappedIndex !== undefined) return { base: uToken, spotIndex: mappedIndex };
    }

    throw new Error(`Unknown HL spot asset: ${raw} (no direct match or U-token mapping)`);
  }

  /**
   * Get the perp symbol for a spot token.
   * e.g., "UBTC" → "BTC", "ETH" → "ETH"
   */
  getUnderlying(spotBase: string): string {
    const upper = spotBase.toUpperCase();
    return SPOT_PERP_TOKEN_MAP[upper] ?? upper;
  }

  // ── Private helpers ──

  /**
   * Validate that an order actually filled.
   * HL API returns status "ok" even for 0-fill IoC orders.
   * Response shape: { status: "ok", response: { type: "order", data: { statuses: [...] } } }
   * Each status is one of: { filled: { totalSz, avgPx, oid } }, { resting: { oid } }, { error: "msg" }
   */
  private _validateOrderFill(result: unknown, base: string, side: string, requestedSize: string): void {
    const r = result as { status?: string; response?: { type?: string; data?: { statuses?: Array<Record<string, unknown>> } } };
    const statuses = r?.response?.data?.statuses;
    if (!statuses || statuses.length === 0) {
      throw new Error(`Spot ${side} ${base}: no order status in response`);
    }
    const st = statuses[0];
    if (st.error) {
      throw new Error(`Spot ${side} ${base}: ${st.error}`);
    }
    const filled = st.filled as { totalSz?: string; avgPx?: string } | undefined;
    if (!filled || Number(filled.totalSz ?? 0) === 0) {
      // Resting or 0-fill → for IoC market orders this means no fill
      throw new Error(`Spot ${side} ${base}: order not filled (0 of ${requestedSize} ${base}). Check price/liquidity.`);
    }
  }

  private async _rawPlaceSpotOrder(opts: {
    assetIndex: number;
    isBuy: boolean;
    price: string;
    size: string;
    orderType: unknown;
  }): Promise<unknown> {
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
      r: false,
      t: opts.orderType,
    };

    const action: Record<string, unknown> = {
      type: "order",
      orders: [orderWire],
      grouping: "na",
    };

    return this._signAndSendAction(action);
  }

  private async _signAndSendAction(action: Record<string, unknown>): Promise<unknown> {
    // Access the HyperliquidAdapter's private signing method via its public interface
    // We reconstruct the signing logic here to avoid exposing private methods
    const { encode } = await import("@msgpack/msgpack");
    const { ethers, keccak256 } = await import("ethers");

    const wallet = new ethers.Wallet((this._hl as unknown as { _privateKey: string })._privateKey);
    const isMainnet = !this._hl.isTestnet;
    const baseUrl = isMainnet
      ? "https://api.hyperliquid.xyz"
      : "https://api.hyperliquid-testnet.xyz";

    const nonce = Date.now();
    const msgPackBytes = encode(action);
    const data = new Uint8Array(msgPackBytes.length + 9);
    data.set(msgPackBytes);
    const view = new DataView(data.buffer);
    view.setBigUint64(msgPackBytes.length, BigInt(nonce), false);
    view.setUint8(msgPackBytes.length + 8, 0);

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

    const sig = await wallet.signTypedData(phantomDomain, agentTypes, phantomAgent);
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

  private async _infoPost(body: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this._hl.isTestnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }
}
