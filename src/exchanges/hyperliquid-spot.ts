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

/** HL official price rounding: 5 significant figures, max 8 decimals for spot */
function hlRoundPrice(px: number, szDecimals: number): string {
  const MAX_DECIMALS = 8; // spot uses 8 (perp uses 6)
  if (px > 100_000) return String(Math.round(px));
  const sig5 = Number(px.toPrecision(5));
  const priceDec = Math.max(0, MAX_DECIMALS - szDecimals);
  return Number(sig5.toFixed(priceDec)).toString();
}

/** HL official size rounding */
function hlRoundSize(sz: number, szDecimals: number): string {
  return sz.toFixed(szDecimals);
}

export class HyperliquidSpotAdapter implements SpotAdapter {
  readonly name = "hyperliquid";
  private _hl: HyperliquidAdapter;
  private _spotAssetMap = new Map<string, number>(); // "ETH" → spotIndex (not +10000)
  private _spotAssetReverse = new Map<number, string>(); // spotIndex → "ETH"
  private _spotDecimals = new Map<string, { size: number; price: number }>();
  private _spotCanonical = new Map<string, boolean>(); // "PURR" → true, "UBTC" → false
  private _initialized = false;
  private _cachedMetaCtx: [
    { tokens: Array<{ name: string; index: number; szDecimals?: number }>; universe: Array<{ name: string; tokens: [number, number]; index: number; isCanonical?: boolean }> },
    Array<Record<string, unknown>>,
  ] | null = null;

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
      // Single API call — spotMetaAndAssetCtxs includes all data from spotMeta
      const metaCtx = await this._infoPost({ type: "spotMetaAndAssetCtxs" }) as [
        {
          tokens: Array<{ name: string; index: number; szDecimals?: number; tokenId?: string }>;
          universe: Array<{ name: string; tokens: [number, number]; index: number; isCanonical?: boolean }>;
        },
        Array<Record<string, unknown>>,
      ];

      if (!metaCtx?.[0]?.universe) return;
      this._cachedMetaCtx = metaCtx;

      const meta = metaCtx[0];

      // Token index → name + szDecimals map (szDecimals lives on tokens, not universe)
      const tokenNames = new Map<number, string>();
      const tokenSzDecimals = new Map<number, number>();
      for (const t of meta.tokens ?? []) {
        tokenNames.set(t.index, t.name);
        if (t.szDecimals !== undefined) tokenSzDecimals.set(t.index, t.szDecimals);
      }

      // Find USDC token index for filtering
      const usdcTokenIndex = meta.tokens?.find(t => t.name === "USDC")?.index ?? 0;

      // HIP-1 meme tokens with low liquidity / unreliable orderbooks — skip for spot trading
      const SPOT_EXCLUDE = new Set(["TRUMP", "PEPE", "HFUN"]);

      for (const u of meta.universe) {
        const baseTokenIndex = u.tokens[0];
        const baseToken = tokenNames.get(baseTokenIndex) ?? "";
        if (!baseToken) continue;
        const key = baseToken.toUpperCase();
        if (SPOT_EXCLUDE.has(key)) continue;
        const isUsdcPair = u.tokens[1] === usdcTokenIndex;
        if (this._spotAssetMap.has(key) && !isUsdcPair) continue;
        this._spotAssetMap.set(key, u.index);
        this._spotAssetReverse.set(u.index, key);
        this._spotDecimals.set(key, {
          size: tokenSzDecimals.get(baseTokenIndex) ?? 2,
          price: 6,
        });
        this._spotCanonical.set(key, u.isCanonical === true);
      }
    } catch (e) {
      console.error("[hl-spot] Failed to load spot meta:", e instanceof Error ? e.message : e);
    }
  }

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    await this.init();
    try {
      // Reuse cached metaCtx from init, or fetch fresh if cache expired
      const metaCtx = this._cachedMetaCtx
        ?? await this._infoPost({ type: "spotMetaAndAssetCtxs" }) as typeof this._cachedMetaCtx;

      if (!metaCtx?.[0]?.universe) return [];

      const tokenNames = new Map<number, string>();
      const tokenSzDec = new Map<number, number>();
      for (const t of metaCtx[0].tokens ?? []) {
        tokenNames.set(t.index, t.name);
        if (t.szDecimals !== undefined) tokenSzDec.set(t.index, t.szDecimals);
      }

      // Fetch accurate mid prices from allMids (markPx in metaCtx is unreliable for spot)
      const allMids = await this._infoPost({ type: "allMids" }) as Record<string, string>;

      const usdcTokenIndex = metaCtx[0].tokens?.find(t => t.name === "USDC")?.index ?? 0;
      const markets: SpotMarketInfo[] = [];

      for (const u of metaCtx[0].universe) {
        // Only USDC-quoted pairs
        if (u.tokens[1] !== usdcTokenIndex) continue;
        const baseToken = tokenNames.get(u.tokens[0]) ?? "";
        if (!baseToken) continue;

        // Price from allMids using universe.name (e.g., "PURR/USDC" or "@107")
        const midPrice = allMids[u.name] ?? "0";

        const spotDec = this._spotDecimals.get(baseToken.toUpperCase());
        markets.push({
          symbol: `${baseToken}/USDC`,
          baseToken,
          quoteToken: "USDC",
          markPrice: midPrice,
          volume24h: "0",
          sizeDecimals: spotDec?.size ?? tokenSzDec.get(u.tokens[0]) ?? 2,
          priceDecimals: spotDec?.price ?? 6,
        });
      }

      return markets;
    } catch {
      return [];
    }
  }

  async getSpotOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    await this.init();
    const { base, spotIndex } = this._resolveBase(symbol);
    // Canonical tokens (e.g. PURR) use "BASE/USDC", non-canonical (e.g. UBTC) use "@index"
    const isCanonical = this._spotCanonical.get(base) ?? false;
    const coin = isCanonical ? `${base}/USDC` : `@${spotIndex}`;
    const book = await this._infoPost({
      type: "l2Book",
      coin,
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
      // Reuse cached spot clearinghouse state (shared with getBalance() — saves 1 API call)
      const state = await this._hl._getSpotClearinghouseState();
      const balances = (state?.balances ?? []) as Record<string, unknown>[];
      return balances.map((b) => ({
        token: String(b.coin ?? ""),
        total: String(b.total ?? "0"),
        available: String(Number(b.total ?? 0) - Number(b.hold ?? 0)),
        held: String(b.hold ?? "0"),
        entryNtl: b.entryNtl !== undefined ? String(b.entryNtl) : undefined,
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
    const szDec = dec?.size ?? 2;

    const result = await this._rawPlaceSpotOrder({
      assetIndex,
      isBuy,
      price: hlRoundPrice(slippagePrice, szDec),
      size: hlRoundSize(Number(size), szDec),
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

    const dec = this._spotDecimals.get(base);
    const szDec = dec?.size ?? 2;

    return this._rawPlaceSpotOrder({
      assetIndex,
      isBuy: side === "buy",
      price: hlRoundPrice(Number(price), szDec),
      size: hlRoundSize(Number(size), szDec),
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

  /** Get spot size decimals for a base token — from API data, not hardcoded */
  getSpotDecimals(base: string): { size: number; price: number } {
    const dec = this._spotDecimals.get(base.toUpperCase());
    if (dec) return dec;
    throw new Error(`No decimal info for spot token ${base}. Ensure init() completed successfully.`);
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
    return this._hl.exchangeAction(action);
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
