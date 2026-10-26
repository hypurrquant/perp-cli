/**
 * Hyperliquid Spot Adapter.
 *
 * Uses the same exchange.placeOrder() endpoint as perps — the only difference
 * is the asset index: spot assets use `10000 + spotIndex`.
 *
 * Composes with HyperliquidAdapter for signing and API access.
 */

import type { SpotAdapter, SpotMarketInfo, SpotBalance, SpotHoldingPrice, SpotHoldingPricesCapable } from "./spot-interface.js";
import { HyperliquidOutcomeAdapter } from "./hyperliquid-outcome.js";
import type { ResolvedSlippage } from "./slippage.js";
import { PERP_TO_SPOT_MAP, SPOT_PERP_TOKEN_MAP } from "./spot-interface.js";
import type { HyperliquidAdapter } from "./hyperliquid.js";
import { assertHlAppliedBps, hlIocOutcome, hlProtectionPrice, hlRequirePriceOnGrid, hlSizeStep, hlTif } from "./hyperliquid.js";
import { floorSize } from "./precision.js";
import { PerpError, isDefiniteOrderFailure, isTransportFailure, orderNotSent, orderOutcomeUnknown } from "../errors.js";
import { invalidateCache } from "../cache.js";

/** HL size: floored to the szDecimals lot (never rounded up past the request); 0 → SIZE_TOO_SMALL. */
function hlRoundSize(size: string, szDecimals: number): string {
  return floorSize(size, hlSizeStep(szDecimals));
}

/**
 * Spot balances from info `spotClearinghouseState` — the one mapper behind the keyed spot adapter
 * and the keyless `account balance --address`. `unified` = the account's spot USDC is its perp
 * margin (unified / portfolio mode): that row is marked `shared`.
 */
export function hlSpotBalanceRows(state: Record<string, unknown>, unified: boolean): SpotBalance[] {
  const balances = (state?.balances ?? []) as Record<string, unknown>[];
  return balances.map((b) => ({
    token: String(b.coin ?? ""),
    total: String(b.total ?? "0"),
    available: String(Number(b.total ?? 0) - Number(b.hold ?? 0)),
    held: String(b.hold ?? "0"),
    entryNtl: b.entryNtl !== undefined ? String(b.entryNtl) : undefined,
    // Shared with perp margin: USDC on a unified / portfolio account, and every portfolio-margin
    // collateral row (the venue marks those with `ltv`; they are counted in the perp equity).
    shared: unified && (String(b.coin ?? "") === "USDC" || Object.prototype.hasOwnProperty.call(b, "ltv")),
  }));
}

export class HyperliquidSpotAdapter implements SpotAdapter, SpotHoldingPricesCapable {
  readonly name = "hyperliquid";
  private _hl: HyperliquidAdapter;
  private _spotAssetMap = new Map<string, number>(); // "ETH" → spotIndex (not +10000)
  private _spotAssetReverse = new Map<number, string>(); // spotIndex → "ETH"
  private _spotDecimals = new Map<string, { size: number; price: number }>();
  private _spotCanonical = new Map<string, boolean>(); // "PURR" → true, "UBTC" → false
  private _initialized = false;
  private _outcome: HyperliquidOutcomeAdapter | null = null;
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
        // Rule #2: no assumed szDecimals — a token without one has no decimals entry and
        // its orders are refused (SYMBOL_NOT_FOUND) instead of being sized on a guess.
        const szDecimals = tokenSzDecimals.get(baseTokenIndex);
        if (szDecimals !== undefined) this._spotDecimals.set(key, { size: szDecimals, price: Math.max(0, 8 - szDecimals) }); // HL spot price grid: max 8 − szDecimals decimals
        this._spotCanonical.set(key, u.isCanonical === true);
      }
    } catch (e) {
      console.error("[hl-spot] Failed to load spot meta:", e instanceof Error ? e.message : e);
    }
  }

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    await this.init();
    // Rule #2: no catch→[]. A failed spotMetaAndAssetCtxs/allMids fetch must throw,
    // not be coerced to an empty markets list (which reads as "this venue has no spot
    // markets" and silently disables spot-perp arb discovery/sizing).
    // Reuse cached metaCtx from init, or fetch fresh if cache expired.
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

    for (const [ui, u] of metaCtx[0].universe.entries()) {
      // Only USDC-quoted pairs
      if (u.tokens[1] !== usdcTokenIndex) continue;
      const baseToken = tokenNames.get(u.tokens[0]) ?? "";
      if (!baseToken) continue;

      // Price from allMids using universe.name (e.g., "PURR/USDC" or "@107")
      const midPrice = allMids[u.name] ?? "0";

      const spotDec = this._spotDecimals.get(baseToken.toUpperCase());
      const sizeDecimals = spotDec?.size ?? tokenSzDec.get(u.tokens[0]);
      // Rule #2: a market without a published szDecimals is not listed (never sized on a guess).
      if (sizeDecimals === undefined) continue;
      markets.push({
        symbol: `${baseToken}/USDC`,
        baseToken,
        quoteToken: "USDC",
        markPrice: midPrice,
        // asset ctxs are index-aligned with universe; dayNtlVlm = 24h quote volume
        volume24h: metaCtx[1]?.[ui]?.dayNtlVlm !== undefined ? String(metaCtx[1][ui].dayNtlVlm) : null,
        sizeDecimals,
        // HL spot price grid: at most 8 − szDecimals decimals (venue rule) — derived, never a fixed guess.
        priceDecimals: spotDec !== undefined ? spotDec.price : Math.max(0, 8 - sizeDecimals),
      });
    }

    return markets;
  }

  /**
   * Prices of held HIP-4 outcome tokens (`+<encoding>` balance rows — not spot markets) for valuation:
   * the outcome side's mid in the outcome's quote token (HyperliquidOutcomeAdapter.getBalanceCoinPrices).
   * Other tokens are not returned (they stay unpriced).
   */
  async getHoldingPrices(tokens: readonly string[]): Promise<SpotHoldingPrice[]> {
    const coins = tokens.filter(t => /^\+\d+$/.test(t));
    if (coins.length === 0) return [];
    if (this._outcome === null) this._outcome = new HyperliquidOutcomeAdapter(this._hl);
    return (await this._outcome.getBalanceCoinPrices(coins)).map(p => ({
      token: p.coin, quoteToken: p.quoteToken, markPrice: p.quoteToken === null ? null : p.mid,
    }));
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
    return this._spotBalances(false);
  }

  /** Uncached read (bypasses the shared acct: TTL cache) — fill measurement / verification. */
  async getSpotBalancesFresh(): Promise<SpotBalance[]> {
    return this._spotBalances(true);
  }

  private async _spotBalances(fresh: boolean): Promise<SpotBalance[]> {
    // Rule #2: no catch→[]. A failed spotClearinghouseState fetch must surface
    // honestly — an empty list is indistinguishable from a genuinely empty wallet
    // and silently drives wrong USDC-transfer sizing / false post-fill verification
    // in the funding-arb bot (and a misleading empty holdings table).
    // Reuse cached spot clearinghouse state (shared with getBalance() — saves 1 API call).
    const state = await this._hl._getSpotClearinghouseState({ fresh });
    // Unified HL accounts: spot USDC IS the perp margin — mark it shared.
    // HIP-3 dex-scoped adapters report dex equity, which never contains spot USDC.
    return hlSpotBalanceRows(state, this._hl.isUnifiedAccount === true && this._hl.dex === "");
  }

  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { slippage: ResolvedSlippage }): Promise<unknown> {
    const what = `spot ${side} ${size} ${symbol}`;
    // Pre-send (resolution, reference price): a failure is a definite "not placed".
    let base: string;
    let order: { assetIndex: number; isBuy: boolean; price: string; size: string };
    let protection: { referencePrice: string; protectionPrice: string; appliedBps: number };
    try {
      await this.init();
      const resolved = this._resolveBase(symbol);
      base = resolved.base;

      // Reference = l2Book mid (the same single declared source as HL perps).
      // Either side missing → PRICE_STALE (no one-sided "mid").
      const book = await this.getSpotOrderbook(symbol);
      const bestAsk = Number(book.asks[0]?.[0]);
      const bestBid = Number(book.bids[0]?.[0]);
      if (!(bestAsk > 0) || !(bestBid > 0) || !Number.isFinite(bestAsk) || !Number.isFinite(bestBid)) {
        throw new PerpError("PRICE_STALE", `Hyperliquid spot ${base}: no two-sided l2Book to derive the mid reference price`, { exchange: "hyperliquid" });
      }
      const midPrice = (bestAsk + bestBid) / 2;

      // Protection = mid ± the resolved slippage bound, aligned toward
      // crossing on HL's spot grid (5 sig figs, max 8 − szDecimals decimals).
      const isBuy = side === "buy";
      const szDec = this.getSpotDecimals(base).size;
      const { protectionPrice, appliedBps } = hlProtectionPrice(midPrice, side, opts.slippage.bps, szDec, 8);
      await assertHlAppliedBps(appliedBps, `spot ${base} protection ${protectionPrice} vs reference ${midPrice}`);
      protection = { referencePrice: String(midPrice), protectionPrice, appliedBps };
      order = { assetIndex: 10000 + resolved.spotIndex, isBuy, price: protectionPrice, size: hlRoundSize(size, szDec) };
    } catch (e) {
      throw orderNotSent("hyperliquid", what, e);
    }

    // Send. A transport failure / unreadable body after the request may have placed
    // the order → ORDER_PENDING. Any other error is the venue's explicit
    // {"status":"err"} rejection or a signing failure before the request → definite.
    let result: unknown;
    try {
      result = await this._rawPlaceSpotOrder({ ...order, orderType: { limit: { tif: "Ioc" } } });
    } catch (e) {
      if (isTransportFailure(e) || (e instanceof Error && e.message.startsWith("HL exchange API error ("))) {
        throw orderOutcomeUnknown("hyperliquid", what, e);
      }
      if (e instanceof PerpError) throw isDefiniteOrderFailure(e) ? e : orderOutcomeUnknown("hyperliquid", what, e);
      throw new PerpError("ORDER_REJECTED", `hyperliquid ${what} rejected: ${e instanceof Error ? e.message : String(e)}`, { exchange: "hyperliquid" });
    }

    // Validate fill — HL returns status "ok" even for 0-fill IoC orders
    this._validateOrderFill(result, base, side, order.size);
    // The protection sent rides along (`protection`, read by the CLI's uniform spot output);
    // `sentSize` = the size actually sent (floored to szDecimals).
    return { ...(result as Record<string, unknown>), protection, sentSize: order.size };
  }

  /** Definite IOC outcome of a raw spot order response (same contract as HyperliquidAdapter.iocOutcomeOf). */
  iocOutcomeOf(raw: unknown): { filledSize: string; final: true } | null {
    return hlIocOutcome(raw);
  }

  async spotLimitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { tif?: string }): Promise<unknown> {
    await this.init();
    const { base, spotIndex } = this._resolveBase(symbol);
    const assetIndex = 10000 + spotIndex;

    // TIF aliases: GTC/IOC/ALO or native spellings; FOK → CAPABILITY_UNSUPPORTED.
    const tif = hlTif(opts?.tif ?? "GTC");

    const szDec = this.getSpotDecimals(base).size;
    const what = `spot limit ${side} ${size} ${base} @ ${price}`;
    // Pre-send: off-grid price → INVALID_TICK (refused, never rounded); size floored to the lot.
    const sentPrice = hlRequirePriceOnGrid(price, szDec, 8, "spot limit price");
    const sentSize = hlRoundSize(size, szDec);

    // Same send contract as spotMarketOrder: a transport failure after the request may
    // have placed the order → ORDER_PENDING; a {"status":"err"} body → definite rejection.
    let result: unknown;
    try {
      result = await this._rawPlaceSpotOrder({
        assetIndex,
        isBuy: side === "buy",
        price: sentPrice,
        size: sentSize,
        orderType: { limit: { tif } },
      });
    } catch (e) {
      if (isTransportFailure(e) || (e instanceof Error && e.message.startsWith("HL exchange API error ("))) {
        throw orderOutcomeUnknown("hyperliquid", what, e);
      }
      if (e instanceof PerpError) throw isDefiniteOrderFailure(e) ? e : orderOutcomeUnknown("hyperliquid", what, e);
      throw new PerpError("ORDER_REJECTED", `hyperliquid ${what} rejected: ${e instanceof Error ? e.message : String(e)}`, { exchange: "hyperliquid" });
    }
    // Venue-final like perps: statuses[0] = resting {oid} (open) | filled {totalSz, avgPx, oid}
    // | error (e.g. "Insufficient spot balance asset=10000") → ORDER_REJECTED, nothing placed.
    // A missing status after an accepted request → EXCHANGE_ERROR (HyperliquidAdapter._validateVenueAck).
    this._hl._validateVenueAck(result, what);
    return result;
  }

  /**
   * Open spot orders (info `openOrders`, spot coins only: "@<spotIndex>" or "PURR/USDC").
   * Symbols are "BASE/QUOTE" from spot meta; a coin missing from meta → EXCHANGE_ERROR (never guessed).
   */
  async getSpotOpenOrders(symbol: string | null): Promise<Array<{ orderId: string; symbol: string; side: "buy" | "sell"; price: string; size: string; filled: string }>> {
    await this.init();
    const meta = this._cachedMetaCtx?.[0];
    if (meta === undefined) throw new PerpError("EXCHANGE_ERROR", "Hyperliquid spot meta not loaded", { exchange: "hyperliquid" });
    const tokenName = new Map(meta.tokens.map(t => [t.index, t.name] as const));
    const pairName = (spotIndex: number): string => {
      const u = meta.universe.find(x => x.index === spotIndex);
      const b = u === undefined ? undefined : tokenName.get(u.tokens[0]);
      const q = u === undefined ? undefined : tokenName.get(u.tokens[1]);
      if (b === undefined || q === undefined) throw new PerpError("EXCHANGE_ERROR", `Hyperliquid spot open order on unknown spot index ${spotIndex}`, { exchange: "hyperliquid" });
      return `${b.toUpperCase()}/${q.toUpperCase()}`;
    };
    const rows = await this._infoPost({ type: "openOrders", user: this._hl.address });
    if (!Array.isArray(rows)) throw new PerpError("EXCHANGE_ERROR", "Hyperliquid openOrders did not return an array", { exchange: "hyperliquid" });
    const wantBase = symbol === null ? null : symbol.toUpperCase().split("/")[0];
    const out: Array<{ orderId: string; symbol: string; side: "buy" | "sell"; price: string; size: string; filled: string }> = [];
    for (const r of rows as Array<Record<string, unknown>>) {
      const coin = String(r.coin ?? "");
      let pair: string;
      if (/^@\d+$/.test(coin)) pair = pairName(Number(coin.slice(1)));
      else if (coin.includes("/")) pair = coin.toUpperCase();
      else continue; // perp order
      if (wantBase !== null && pair.split("/")[0] !== wantBase) continue;
      const orig = String(r.origSz ?? "");
      const left = String(r.sz ?? "");
      if (!/^\d+(\.\d+)?$/.test(orig) || !/^\d+(\.\d+)?$/.test(left)) {
        throw new PerpError("EXCHANGE_ERROR", `Hyperliquid open order ${String(r.oid)}: unexpected size fields`, { exchange: "hyperliquid" });
      }
      const dec = Math.max((orig.split(".")[1] ?? "").length, (left.split(".")[1] ?? "").length);
      out.push({
        orderId: String(r.oid),
        symbol: pair,
        side: r.side === "B" ? "buy" : "sell",
        price: String(r.limitPx),
        size: orig,
        filled: (Number(orig) - Number(left)).toFixed(dec),
      });
    }
    return out;
  }

  async spotCancelOrder(symbol: string, orderId: string): Promise<unknown> {
    await this.init();
    const { spotIndex } = this._resolveBase(symbol);
    const assetIndex = 10000 + spotIndex;
    const oid = Number(orderId);
    if (!/^\d+$/.test(orderId) || !Number.isSafeInteger(oid)) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid order id must be a decimal integer (got "${orderId}"); nothing was cancelled`, {
        exchange: "hyperliquid", remediation: `Look up the order id: perp -e hyperliquid trade spot-orders ${symbol}`,
      });
    }

    // statuses[0] "success" → cancelled; {error} → ORDER_REJECTED (trade.ts spotCancelResult).
    return this._signAndSendAction({
      type: "cancel",
      cancels: [{ a: assetIndex, o: oid }],
    });
  }

  /**
   * Transfer USDC between perp and spot accounts.
   * HL uses separate balances (standard mode) — spot buys require USDC in the spot account.
   */
  async transferUsdcToSpot(amount: number): Promise<unknown> {
    return this._moveUsdc(String(amount), false);
  }

  async transferUsdcToPerp(amount: number): Promise<unknown> {
    return this._moveUsdc(String(amount), true);
  }

  /**
   * Spot↔perp USDC move by the active signer tier: an agent signs the L1
   * `agentSendAsset` (agents cannot sign user-signed actions); the master signs
   * `usdClassTransfer`. No signer → NO_SIGNER_AVAILABLE from the adapter.
   */
  private async _moveUsdc(amount: string, toPerp: boolean): Promise<unknown> {
    // The master's usdClassTransfer moves USDC between spot and the NATIVE perp dex only. On a
    // HIP-3 dex adapter it would fund the wrong dex, so it is refused (the agent's
    // agentSendAsset names the dex explicitly).
    if (this._hl.dex !== "" && this._hl.activeSignerTier !== "agent") {
      throw new PerpError("NOT_IMPLEMENTED", `Hyperliquid spot↔perp transfer for HIP-3 dex "${this._hl.dex}" is not implemented for the master wallet (usdClassTransfer only funds the native perp dex)`, {
        exchange: "hyperliquid",
        remediation: `Use an agent wallet (perp wallet agent approve hyperliquid), or move the collateral to dex "${this._hl.dex}" in the Hyperliquid app`,
      });
    }
    try {
      return await (this._hl.activeSignerTier === "agent"
        ? this._hl.agentSendAsset(amount, toPerp)
        : this._hl.usdClassTransfer(amount, toPerp));
    } finally {
      invalidateCache("acct"); // perp and spot balances both moved
    }
  }

  /** SpotTransferCapable: USDC only; an `err` response is thrown, not returned. */
  async transferToSpot(amount: string, asset: string): Promise<unknown> {
    return this._checkedTransfer(amount, asset, false);
  }

  async transferToPerp(amount: string, asset: string): Promise<unknown> {
    return this._checkedTransfer(amount, asset, true);
  }

  private async _checkedTransfer(amount: string, asset: string, toPerp: boolean): Promise<unknown> {
    if (asset !== "USDC") {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid spot↔perp transfer only moves USDC (got ${asset})`, { exchange: "hyperliquid" });
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw new PerpError("INVALID_PARAMS", `Transfer amount must be positive (got ${amount})`);
    const res = await this._moveUsdc(amount, toPerp) as { status?: string; response?: unknown };
    if (res?.status === "err") {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid ${toPerp ? "spot→perp" : "perp→spot"} transfer rejected: ${String(res.response)}`, { exchange: "hyperliquid" });
    }
    return res;
  }

  /** Get the spot asset index (without the 10000 offset) */
  getSpotIndex(base: string): number | undefined {
    return this._spotAssetMap.get(base.toUpperCase());
  }

  /** Get spot size decimals for a base token — from API data, not hardcoded */
  getSpotDecimals(base: string): { size: number; price: number } {
    const dec = this._spotDecimals.get(base.toUpperCase());
    if (dec) return dec;
    throw new PerpError("SYMBOL_NOT_FOUND", `Hyperliquid spot ${base.toUpperCase()}: no szDecimals in spot meta — refusing to size the order on a guess`, {
      exchange: "hyperliquid",
      remediation: "Retry (spot meta may not have loaded); if it persists the token is not tradeable via this CLI",
    });
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
      // Accepted request without a per-order status: the outcome is unknown.
      throw orderOutcomeUnknown("hyperliquid", `spot ${side} ${base}`, new Error("no order status in response"));
    }
    const st = statuses[0];
    if (st.error) {
      throw new PerpError("ORDER_REJECTED", `Spot ${side} ${base}: ${st.error}`, { exchange: "hyperliquid" });
    }
    const filled = st.filled as { totalSz?: string; avgPx?: string } | undefined;
    if (st.resting !== undefined) {
      // An IoC never rests; a resting status means the order is live — do not resubmit.
      throw orderOutcomeUnknown("hyperliquid", `spot ${side} ${base}`, new Error("IoC order reported resting"));
    }
    if (!filled || Number(filled.totalSz ?? 0) === 0) {
      // 0-fill IoC: cancelled by the venue, nothing filled (definite).
      throw new PerpError("ORDER_REJECTED", `Spot ${side} ${base}: order not filled (0 of ${requestedSize} ${base}). Check price/liquidity.`, { exchange: "hyperliquid" });
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
    try {
      return await this._hl.exchangeAction(action);
    } finally {
      // Spot balances / open orders changed (or may have): later reads in this or another
      // process (the acct: disk cache is shared) must not serve the pre-order snapshot.
      invalidateCache("acct");
    }
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
