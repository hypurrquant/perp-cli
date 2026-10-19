/**
 * Lighter Spot Adapter.
 *
 * Uses the same `/api/v1/sendTx` endpoint as perps — the only difference
 * is the market_id (spot markets have different IDs from perp markets).
 *
 * Composes with LighterAdapter for signing and API access.
 */

import { TX_EVENT_FILL_SOURCE, type SpotAdapter, type SpotMarketInfo, type SpotBalance, type SpotOrderResult } from "./spot-interface.js";
import type { ResolvedSlippage } from "./slippage.js";
import type { LighterAdapter, LighterRowMatch } from "./lighter.js";
import { LIGHTER_BOOK_ORDERS_LIMIT, lighterBookLevels, lighterWafChallenge } from "./lighter-public.js";
import {
  LIGHTER_TIF, lighterEventFilledBase, lighterEventOrderId, lighterGeneratedClientOrderIndex, lighterOrderIdOf, lighterOrderSignIndex,
  lighterPostSendTx, lighterRowOutcomeOf, lighterSelectAccount, lighterTakerFilledBase, lighterTxState,
  type LighterOrderOutcome, type LighterTxState,
} from "./lighter.js";
import { alignProtectionPrice, floorSize, formatComputedPrice, requireOnTick, slippagePrice, subDecimal, toUnitsExact } from "./precision.js";
import { unsupported } from "./trading-v2.js";
import { rateLimitedError } from "./rate-limiter.js";
import { PerpError, orderNotSent, parsePositiveDecimal } from "../errors.js";

/** The row match (market + send time) _placeOrder attached to its result; absent → null (no extra match). */
function lighterRowMatchOf(result: Record<string, unknown>): LighterRowMatch | null {
  const m = result.rowMatch as Partial<LighterRowMatch> | undefined;
  return m !== undefined && typeof m.marketIndex === "number" && typeof m.sentAtMs === "number" ? { marketIndex: m.marketIndex, sentAtMs: m.sentAtMs } : null;
}

/**
 * `venueRaw.fillSource` of a spot IOC fill read from the order's accountOrders row
 * (`filled_base_amount`, the venue's own field — never size − remaining).
 */
export const ACCOUNT_ORDERS_FILL_SOURCE = "account-orders";

/** SpotOrderResult status of a final Lighter order outcome (cancelled with a fill → partial). */
function spotStatusOf(o: LighterOrderOutcome): SpotOrderResult["status"] {
  if (o.status === "partiallyFilled") return "partial";
  return o.status;
}

/** Pre-send state of a spot market order. */
interface PreparedSpotOrder {
  resolved: string;
  marketId: number;
  baseAmount: number;
  priceTicks: number;
  dec: { size: number; price: number };
  /** Protection actually sent (reference = best opposite quote). */
  protection: { referencePrice: string; protectionPrice: string; appliedBps: number };
}

export class LighterSpotAdapter implements SpotAdapter {
  /** Venue id of the wrapped LighterAdapter ("lighter" | "lighter-rh"). */
  readonly name: string;
  private _lt: LighterAdapter;
  private _spotMarketMap = new Map<string, number>(); // "ETH/USDC" → market_id
  private _spotBaseMap = new Map<string, string>(); // "ETH" → "ETH/USDC"
  private _spotDecimals = new Map<string, { size: number; price: number }>();
  private _spotMinSize = new Map<string, { base: number; quote: number }>(); // min order sizes
  private _spotPrices = new Map<string, string>(); // "ETH/USDC" → markPrice (from init)
  private _initialized = false;

  constructor(ltAdapter: LighterAdapter) {
    this._lt = ltAdapter;
    this.name = ltAdapter.name;
  }

  /** Quote/collateral symbol of the wrapped venue ("USDC" on Lighter, "USDG" on Lighter RH). */
  private get _quote(): string {
    return this._lt.collateralSymbol;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._loadSpotMarkets();
    // Unified vs Classic account decides spot↔perp transfers (venue spot accountModel "runtime").
    await this._lt.resolveAccountTradingMode();
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
          best_ask_price?: string;
          best_bid_price?: string;
          mark_price?: string;
        }>;
      };

      for (const ob of res.order_books ?? []) {
        // Spot only, by the venue's market_type (never inferred from the market id).
        if (ob.status !== "active" || ob.market_type !== "spot") continue;
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
        // Cache price from orderBooks response (avoids N separate orderbook calls in getSpotMarkets)
        const price = ob.mark_price ?? (ob.best_ask_price && ob.best_bid_price
          ? formatComputedPrice((parseFloat(ob.best_ask_price) + parseFloat(ob.best_bid_price)) / 2) : "0");
        if (price !== "0") this._spotPrices.set(symbol, price);
        const base = symbol.split("/")[0];
        if (base) this._spotBaseMap.set(base, symbol);
      }
    } catch (e) {
      // No second source: the explorer market list carries no size / price decimals, and decimals
      // are never assumed (Rule #2). Init fails; nothing is traded or quoted without venue decimals.
      this._spotMarketMap.clear();
      this._spotDecimals.clear();
      this._spotBaseMap.clear();
      if (e instanceof PerpError) throw e;
      throw new PerpError("EXCHANGE_ERROR", `Failed to load ${this._lt.name} ${this._lt.networkName} spot markets (/orderBooks: ${e instanceof Error ? e.message : String(e)}); refusing to trade without the venue's size / price decimals`, {
        exchange: this._lt.name,
        remediation: "Retry shortly — the venue's spot market metadata could not be read",
      });
    }
  }

  /** Resolve a symbol (e.g., "ETH" or "ETH/USDC") to the full spot symbol */
  /** Get decimals for a symbol — always from API data, never hardcoded fallback */
  private _getDecimals(symbol: string): { size: number; price: number } {
    const resolved = symbol.includes("/") ? symbol : symbol.toUpperCase();
    const dec = this._spotDecimals.get(resolved);
    if (dec) return dec;
    // Try base token lookup (e.g., "ETH" → "ETH/USDC")
    for (const [key, val] of this._spotDecimals) {
      if (key.split("/")[0] === symbol.toUpperCase()) return val;
    }
    throw new PerpError("SYMBOL_NOT_FOUND", `${this.name}: no venue size / price decimals for spot market ${symbol}; refusing to trade or quote it`, {
      exchange: this.name,
      remediation: `Check the symbol: perp -e ${this.name} market spot-list`,
    });
  }

  private resolveSymbol(symbol: string): string {
    const upper = symbol.toUpperCase();
    if (this._spotMarketMap.has(upper)) return upper;
    // Try base token → full symbol
    const full = this._spotBaseMap.get(upper);
    if (full) return full;
    // Try adding the venue quote (/USDC on Lighter, /USDG on Lighter RH)
    const withUsdc = `${upper}/${this._quote}`;
    if (this._spotMarketMap.has(withUsdc)) return withUsdc;
    return upper;
  }

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    await this.init();
    const entries = Array.from(this._spotMarketMap.entries());

    // Use prices cached from init's /orderBooks response (0 extra API calls).
    // Only fetch individual orderbooks if no cached price available.
    const missingPrices = entries.filter(([sym]) => !this._spotPrices.has(sym));
    if (missingPrices.length > 0) {
      const results = await Promise.allSettled(
        missingPrices.map(([symbol]) =>
          this.getSpotOrderbook(symbol).then(ob => {
            if (ob.bids.length > 0 && ob.asks.length > 0) {
              this._spotPrices.set(symbol, formatComputedPrice((Number(ob.bids[0][0]) + Number(ob.asks[0][0])) / 2));
            }
          })
        )
      );
      void results; // consume
    }

    return entries.map(([symbol]) => {
      const parts = symbol.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new PerpError("EXCHANGE_ERROR", `Lighter spot market symbol "${symbol}" is not in BASE/QUOTE form`, {
          remediation: "The Lighter spot market list returned an unexpected symbol shape; report it or retry after the API is fixed.",
        });
      }
      const [base, quote] = parts;
      const dec = this._getDecimals(symbol);
      const px = this._spotPrices.get(symbol);
      return {
        symbol, baseToken: base, quoteToken: quote,
        // null = no mark and no two-sided book (never "0", Rule #2)
        markPrice: px === undefined ? null : px, volume24h: null,
        sizeDecimals: dec.size, priceDecimals: dec.price,
      };
    });
  }

  async getSpotOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Unknown Lighter spot market: ${symbol}`, {
        exchange: this.name, remediation: `Check the symbol: perp -e ${this.name} market spot-list`,
      });
    }
    // A failed read throws its typed error (429 / WAF / transport) — never an empty book, which
    // callers (arb-auto, liquidity) would read as "no liquidity". Orders → price levels as on perps.
    const res = await this._restGet("/orderBookOrders", {
      market_id: String(marketId),
      limit: String(LIGHTER_BOOK_ORDERS_LIMIT),
    }) as { asks?: unknown; bids?: unknown };
    return {
      bids: lighterBookLevels(this.name, res.bids, `${resolved} bids`),
      asks: lighterBookLevels(this.name, res.asks, `${resolved} asks`),
    };
  }

  /**
   * Spot token balances. Reads the account through the shared 15s `acct:` cache
   * (same entry as LighterAdapter.fetchAccount()). Throws on any failure — never []
   * (Rule #2: an empty list is indistinguishable from an empty wallet).
   * Fill measurement / post-trade verification must use getSpotBalancesFresh().
   */
  async getSpotBalances(): Promise<SpotBalance[]> {
    return this._spotBalances(false);
  }

  /** Uncached read (always hits /account, then refreshes the shared cache entry). */
  async getSpotBalancesFresh(): Promise<SpotBalance[]> {
    return this._spotBalances(true);
  }

  private async _spotBalances(fresh: boolean): Promise<SpotBalance[]> {
    await this.init();
    const address = this._lt.address;
    if (!address) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} spot balances: no account address configured`, {
        exchange: this.name,
        remediation: `Configure the ${this.name} account (perp setup) before reading spot balances`,
      });
    }

    const { withCache, fetchAndCache, TTL_ACCOUNT } = await import("../cache.js");
    const key = `acct:${this._lt.accountCachePrefix}:account:${address}`;
    const fetcher = async () => {
      const res = await this._restGet("/account", {
        by: "l1_address",
        value: address,
      }) as { accounts?: Array<Record<string, unknown>> };
      return lighterSelectAccount(res.accounts, this._lt.accountIndex, this.name);
    };
    const acct = (fresh ? await fetchAndCache(key, TTL_ACCOUNT, fetcher) : await withCache(key, TTL_ACCOUNT, fetcher)) as Record<string, unknown> | null;
    if (!acct) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} spot balances: no account found for ${address}`, {
        exchange: this.name,
        remediation: `Check the ${this.name} account index / address (perp -e ${this.name} account info)`,
      });
    }

    const balances: SpotBalance[] = [];
    const quote = this._quote;
    if (acct.assets !== undefined && !Array.isArray(acct.assets)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} spot balances: account.assets is not an array`, { exchange: this.name, raw: acct.assets });
    }
    const assets = (acct.assets ?? []) as Array<{ symbol: string; asset_id: number; balance: string; locked_balance: string; margin_balance?: unknown }>;
    // Docs (docs.lighter.xyz/trading/unified-trading-accounts): "Unified Trading Accounts (UTA)
    // enables unified margin on Spot and Perpetuals USDC balances." vs Simple: "perpetual and spot
    // balances are maintained separately." Mode = this same response's account_trading_mode
    // ("Classic=0 and Unified=1", apidocs reference/account-1); an unknown mode fails the quote row.
    const quoteShared = (): boolean => {
      const mode = acct.account_trading_mode;
      if (mode !== 0 && mode !== 1) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} spot balances: account_trading_mode is ${JSON.stringify(mode ?? null)} (expected 0 classic | 1 unified)`, {
          exchange: this.name,
          remediation: `Retry; check the account with: perp -e ${this.name} account info`,
        });
      }
      return mode === 1;
    };
    const plainDecimal = (v: unknown, field: string): string => {
      if (typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v)) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} spot balances: ${field} is ${JSON.stringify(v ?? null)} (expected a decimal string)`, {
          exchange: this.name,
          remediation: `Retry; check the account with: perp -e ${this.name} account info`,
        });
      }
      return v;
    };
    for (const asset of assets) {
      const bal = Number(asset.balance);
      const locked = Number(asset.locked_balance);
      if (!Number.isFinite(bal) || !Number.isFinite(locked)) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} spot balance for ${asset.symbol} is not a number (balance=${asset.balance}, locked=${asset.locked_balance})`, { exchange: this.name, raw: asset });
      }
      if (asset.symbol === quote && quoteShared()) {
        // Unified account: the quote is ONE balance for spot and perp, and the venue books it
        // under the asset row's `margin_balance` with `balance` "0.000000" (GET /account,
        // mainnet account 723334, 2026-10-05: assets[USDC] balance "0.000000", margin_balance
        // "15.952247503314"; account available_balance "15.952247"). apidocs reference/account-1
        // lists the asset fields `balance`, `locked_balance`, `margin_mode` ("enabled" |
        // "disabled"), `margin_balance` and the account field `available_balance` without
        // defining them further, so:
        //   total     = balance + margin_balance  (the quote the account holds, exact sum);
        //   available = account `available_balance` — the only "free" figure the venue reports
        //               for the unified margin, i.e. what is not committed as perp margin and
        //               therefore usable by a spot order. It is the venue's number, not
        //               total − held (it moves with perp margin use and unrealized PnL);
        //   held      = locked_balance (quote locked by resting spot orders).
        // Named by the bare quote symbol: it is not a separate spot balance (`_SPOT`).
        const total = subDecimal(plainDecimal(asset.balance, `${quote} balance`), subDecimal("0", plainDecimal(asset.margin_balance, `${quote} margin_balance`)));
        if (Number(total) > 0) {
          balances.push({ token: quote, total, available: plainDecimal(acct.available_balance, "available_balance"), held: asset.locked_balance, shared: true });
        }
        continue;
      }
      if (bal > 0) {
        balances.push({
          // The quote row carries the bare quote symbol ("USDC" / "USDG") on classic accounts too:
          // `shared: false` is what says it is a separate spot balance, not a `_SPOT` suffix.
          token: asset.symbol,
          total: asset.balance,
          available: String(bal - locked),
          held: asset.locked_balance,
          // Classic quote: a separate spot balance. Base assets are never perp margin here.
          shared: false,
        });
      }
    }

    return balances;
  }

  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { slippage: ResolvedSlippage }): Promise<unknown> {
    // Everything up to sendTx is pre-send: a failure there is a definite "not placed"
    // (ORDER_REJECTED); sendTx transport failures are ORDER_PENDING.
    let prep: PreparedSpotOrder;
    try {
      prep = await this._prepareMarketOrder(symbol, side, size, opts.slippage.bps);
    } catch (e) {
      throw orderNotSent(this.name, `spot ${side} ${size} ${symbol}`, e);
    }
    const { resolved, marketId, baseAmount, priceTicks, dec, protection } = prep;

    const result = await this._placeOrder({
      marketIndex: marketId,
      baseAmount,
      price: Math.max(priceTicks, 1),
      isAsk: side === "sell" ? 1 : 0,
      orderType: 1, // MARKET
      timeInForce: 0, // IOC
    });

    // Venue-final IOC outcome, as perps (LighterAdapter.awaitIocOutcome): the executed tx's
    // event_info taker order "filled" (the whole sent amount, lighterTakerFilledBase); any other
    // status → the order's accountOrders terminal row by client order index (filled_base_amount —
    // a cancelled remainder zeroes `rs`, so is − rs is never a fill). Zero fill → ORDER_REJECTED;
    // positive → a final SpotOrderResult. No report at all → the raw sendTx result is returned
    // and spotMarketFill() measures the fill as a FRESH base-balance delta (zero → ORDER_PENDING).
    const out = await this._iocOutcome(result, resolved, baseAmount, dec.size, `spot ${side} ${size} ${resolved}`, protection);
    if (out !== null) return out;
    return { ...(result as Record<string, unknown>), protection };
  }

  /** Poll /tx by hash (lighterTxState): rejected → ORDER_REJECTED; returns the last state + raw tx. */
  private async _awaitTx(txHash: string, what: string, attempts: number): Promise<{ state: LighterTxState; tx: Record<string, unknown> | null }> {
    let state: LighterTxState = { kind: "pending", status: null };
    let tx: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        tx = await this._restGet("/tx", { by: "hash", value: txHash }) as Record<string, unknown>;
      } catch {
        continue; // tx not indexed yet / transient read failure — poll again
      }
      // 0 Failed · 1 Pending · 2 Executed · 3 Pending-final; executed = 2/3 with executed_at > 0.
      state = lighterTxState(tx);
      if (state.kind === "rejected") {
        // The venue did not execute it (definite): status 0 or an event_info app error.
        throw new PerpError("ORDER_REJECTED", `${this.name} ${what}: tx rejected (status=${state.status}, ${state.reason}, hash=${txHash})`, { exchange: this.name, txHash });
      }
      if (state.kind === "executed") break;
    }
    return { state, tx };
  }

  /**
   * Final IOC outcome of a sent spot order (market or limit IOC) — see spotMarketOrder. Returns
   * a final SpotOrderResult, throws ORDER_REJECTED for a zero fill, or null when neither /tx nor
   * accountOrders settled it.
   */
  private async _iocOutcome(
    result: { clientOrderIndex: number; [key: string]: unknown }, resolved: string, sentBase: number, sizeDecimals: number, what: string,
    protection: PreparedSpotOrder["protection"] | null,
  ): Promise<SpotOrderResult | null> {
    const txHash = typeof result.tx_hash === "string" && result.tx_hash !== "" ? result.tx_hash : null;
    if (txHash === null) return null;
    const step = sizeDecimals <= 0 ? "1" : `0.${"0".repeat(sizeDecimals - 1)}1`;
    const { state, tx } = await this._awaitTx(txHash, what, this._lt.txPollAttempts(10));
    let filledBase = state.kind === "executed" ? lighterTakerFilledBase(state.eventInfo, sentBase) : null;
    let fillSource = TX_EVENT_FILL_SOURCE;
    let row: LighterOrderOutcome | null = null;
    if (filledBase === null) {
      // Only a terminal row settles an IOC (filled / canceled-*), whether or not /tx settled.
      row = await this._lt.orderRowOutcome(result.clientOrderIndex, null, what, o => o.status !== "open", lighterRowMatchOf(result));
      if (row !== null) {
        filledBase = Number(toUnitsExact(row.filledSize, step, "filled size"));
        fillSource = ACCOUNT_ORDERS_FILL_SOURCE;
      }
    }
    if (filledBase === null) {
      console.error(`[lighter-spot] ${what}: no fill report from /tx or accountOrders (hash=${txHash}) — fill will be measured from a fresh balance read`);
      return null;
    }
    if (filledBase === 0) {
      throw new PerpError("ORDER_REJECTED", `${this.name} ${what}: IOC filled nothing (hash=${txHash}${row !== null ? `, venue status ${row.venueStatus}` : ""}) — the order was cancelled by the venue`, {
        exchange: this.name, txHash,
      });
    }
    return {
      venue: this.name,
      symbol: resolved,
      orderId: txHash,
      status: filledBase >= sentBase ? "filled" : "partial",
      filledSize: (filledBase / 10 ** sizeDecimals).toFixed(sizeDecimals),
      avgPrice: null,
      finality: "final", // IOC: the remainder (if any) is cancelled by the venue
      receivedToken: null,
      remediation: null,
      venueRaw: { sendTx: result, tx, fillSource, row, ...(protection !== null ? { protection } : {}) },
    };
  }

  /** Pre-send part of spotMarketOrder: market, min size, reference price, ticks. */
  private async _prepareMarketOrder(symbol: string, side: "buy" | "sell", size: string, slippageBps: number): Promise<PreparedSpotOrder> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Unknown Lighter spot market: ${symbol}`, {
        exchange: this.name, remediation: `Check the symbol: perp -e ${this.name} market spot-list`,
      });
    }

    // Validate min order size
    const minSize = this._spotMinSize.get(resolved);
    const sizeNum = parseFloat(size);
    if (minSize && sizeNum < minSize.base) {
      throw new PerpError("SIZE_TOO_SMALL", `Size ${size} below min_base_amount ${minSize.base} for ${resolved}`, { exchange: this.name });
    }

    // Protection price = best opposite quote ± the resolved slippage bound
    const ob = await this.getSpotOrderbook(resolved);
    let refPrice: number;
    if (side === "buy") {
      if (ob.asks.length === 0) throw new PerpError("PRICE_STALE", `No asks in ${resolved} spot orderbook — no reference price`, { exchange: this.name });
      refPrice = Number(ob.asks[0][0]);
    } else {
      if (ob.bids.length === 0) throw new PerpError("PRICE_STALE", `No bids in ${resolved} spot orderbook — no reference price`, { exchange: this.name });
      refPrice = Number(ob.bids[0][0]);
    }

    // Validate min quote amount (size × price ≥ min_quote)
    if (minSize && sizeNum * refPrice < minSize.quote) {
      throw new PerpError("SIZE_TOO_SMALL", `Order value $${(sizeNum * refPrice).toFixed(2)} below min_quote_amount $${minSize.quote} for ${resolved}`, { exchange: this.name });
    }

    const dec = this._getDecimals(resolved);
    // Tick conversion rounds toward crossing (buy → up, sell → down), never to nearest.
    const tick = dec.price <= 0 ? "1" : `0.${"0".repeat(dec.price - 1)}1`;
    const protectionPrice = alignProtectionPrice(slippagePrice(String(refPrice), side, slippageBps), tick, side);

    // Size floored to the size step (exact decimals; never rounded up past the request); 0 → SIZE_TOO_SMALL.
    const sizeStep = dec.size <= 0 ? "1" : `0.${"0".repeat(dec.size - 1)}1`;
    const baseAmount = Number(toUnitsExact(floorSize(size, sizeStep), sizeStep, "size"));
    const priceTicks = Number(toUnitsExact(protectionPrice, tick, "protection price"));

    const appliedBps = Math.round(Math.abs(Number(protectionPrice) / refPrice - 1) * 10_000 * 100) / 100;
    return { resolved, marketId, baseAmount, priceTicks, dec, protection: { referencePrice: String(refPrice), protectionPrice, appliedBps } };
  }

  /**
   * Final IOC fill of a spotMarketOrder / IOC spotLimitOrder result (SpotOrderResult read from
   * the tx event_info or the accountOrders row), or null when the outcome is unknown (raw sendTx
   * result → balance delta).
   */
  iocOutcomeOf(raw: unknown): { filledSize: string; final: true } | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Partial<SpotOrderResult>;
    const src = (r.venueRaw as { fillSource?: unknown } | undefined)?.fillSource;
    if (r.finality !== "final" || typeof r.filledSize !== "string" || (src !== TX_EVENT_FILL_SOURCE && src !== ACCOUNT_ORDERS_FILL_SOURCE)) return null;
    return { filledSize: r.filledSize, final: true };
  }

  async spotLimitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { tif?: string }): Promise<unknown> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new Error(`Unknown Lighter spot market: ${symbol}`);
    }

    const dec = this._getDecimals(resolved);
    const sizeStep = dec.size <= 0 ? "1" : `0.${"0".repeat(dec.size - 1)}1`;
    const tick = dec.price <= 0 ? "1" : `0.${"0".repeat(dec.price - 1)}1`;

    // Size floored to the size step (never rounded up); price must already be on tick
    // (INVALID_TICK, never rounded).
    const sentSize = floorSize(size, sizeStep);
    const sentPrice = requireOnTick(price, tick);

    // Venue minimums: refused, never bumped up to the minimum (the order would exceed the request).
    const minSize = this._spotMinSize.get(resolved);
    if (minSize) {
      if (Number(sentSize) < minSize.base) {
        throw new PerpError("SIZE_TOO_SMALL", `Size ${sentSize} below min_base_amount ${minSize.base} for ${resolved}`, {
          exchange: "lighter", remediation: `Use a size of at least ${minSize.base}`,
        });
      }
      if (Number(sentSize) * Number(sentPrice) < minSize.quote) {
        throw new PerpError("SIZE_TOO_SMALL", `Order value $${(Number(sentSize) * Number(sentPrice)).toFixed(2)} below min_quote_amount $${minSize.quote} for ${resolved}`, {
          exchange: "lighter", remediation: `Increase the size so size × price is at least $${minSize.quote}`,
        });
      }
    }

    const baseAmount = Number(toUnitsExact(sentSize, sizeStep, "size"));
    const priceTicks = Number(toUnitsExact(sentPrice, tick, "price"));
    const timeInForce = this._limitTif(opts?.tif);

    const result = await this._placeOrder({
      marketIndex: marketId,
      baseAmount,
      price: priceTicks,
      isAsk: side === "sell" ? 1 : 0,
      orderType: 0, // LIMIT
      timeInForce,
    });
    const what = `spot limit ${(opts?.tif ?? "GTC").toUpperCase()} ${side} ${sentSize} ${resolved} @ ${sentPrice}`;
    if (timeInForce === LIGHTER_TIF.IOC) {
      // Same venue-final IOC outcome as spotMarketOrder; unresolved → raw (the CLI reports pending).
      return (await this._iocOutcome(result, resolved, baseAmount, dec.size, what, null)) ?? result;
    }
    const out = await this._placementOutcome(result, baseAmount, dec.size, what);
    if (out === null) {
      console.error(`[lighter-spot] ${what}: placement not confirmed yet — verify with: perp trade spot-orders ${resolved} -e ${this.name}`);
      return result;
    }
    return {
      venue: this.name,
      symbol: resolved,
      orderId: out.orderId,
      status: spotStatusOf(out),
      filledSize: out.filledSize,
      avgPrice: null,
      finality: "final",
      receivedToken: null,
      remediation: null,
      venueRaw: { sendTx: result, outcome: out },
    } satisfies SpotOrderResult;
  }

  /**
   * TIF mapping, as perps: GTC/GTT → GTT, IOC → IOC, ALO / POST_ONLY → post-only (2).
   * FOK and anything else → CAPABILITY_UNSUPPORTED (never silently GTT).
   */
  private _limitTif(tif: string | undefined): number {
    const t = (tif ?? "GTC").toUpperCase();
    if (t === "GTC" || t === "GTT") return LIGHTER_TIF.GTT;
    if (t === "IOC") return LIGHTER_TIF.IOC;
    if (t === "ALO" || t === "POST_ONLY") return LIGHTER_TIF.POST_ONLY;
    throw unsupported(this.name, t === "FOK" ? "fok" : "timeInForce", `spot time-in-force ${tif} is not offered`, "Use --tif GTC, IOC or ALO");
  }

  /**
   * Final placement outcome of a resting (GTT / post-only) spot limit, as perps
   * (LighterAdapter.resolveOrderOutcome): /tx rejected → ORDER_REJECTED; the executed tx's
   * event_info taker order (this client order index) "filled" → filled; otherwise the order's
   * accountOrders row by client order index (status + filled_base_amount: open, filled,
   * canceled-* — e.g. a crossing post-only). Unresolved → null (pending).
   */
  private async _placementOutcome(
    result: { clientOrderIndex: number; [key: string]: unknown }, sentBase: number, sizeDecimals: number, what: string,
  ): Promise<LighterOrderOutcome | null> {
    const txHash = typeof result.tx_hash === "string" && result.tx_hash !== "" ? result.tx_hash : null;
    if (txHash !== null) {
      const { state } = await this._awaitTx(txHash, what, this._lt.txPollAttempts(10));
      const to = state.kind === "executed" ? state.eventInfo?.to : undefined;
      if (typeof to === "object" && to !== null) {
        const o = to as Record<string, unknown>;
        const filledBase = Number(o.u) === result.clientOrderIndex ? lighterEventFilledBase(o) : null;
        if (filledBase !== null && filledBase === sentBase) {
          return { status: "filled", final: true, venueStatus: "filled", filledSize: (filledBase / 10 ** sizeDecimals).toFixed(sizeDecimals), orderId: lighterEventOrderId(o.i), source: "event_info" };
        }
      }
    }
    return this._lt.orderRowOutcome(result.clientOrderIndex, null, what, () => true, lighterRowMatchOf(result));
  }

  async spotCancelOrder(symbol: string, orderId: string): Promise<unknown> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) {
      throw new Error(`Unknown Lighter spot market: ${symbol}`);
    }

    if (!/^\d+$/.test(orderId)) {
      throw new PerpError("INVALID_PARAMS", `${this.name} spot order id "${orderId}" must be a decimal integer; nothing was cancelled`, { exchange: this.name });
    }
    // Look the order up among the market's open orders and sign with its client order index
    // (or its order id when that is 0 and exactly representable); otherwise refuse — never
    // cancel some other order of the market in its place.
    const data = await this._restGetAuth("/accountActiveOrders", {
      account_index: String(this._lt.accountIndex),
      market_id: String(marketId),
    }) as { orders?: unknown };
    if (!Array.isArray(data.orders)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} accountActiveOrders returned no orders array for ${resolved}; nothing was cancelled`, { exchange: this.name });
    }
    const row = (data.orders as Array<Record<string, unknown>>).find(o => lighterOrderIdOf(o) === orderId);
    if (row === undefined) {
      throw new PerpError("ORDER_NOT_FOUND", `${this.name} spot order ${orderId} is not among the open ${resolved} orders; nothing was cancelled`, { exchange: this.name });
    }
    const index = lighterOrderSignIndex(row, this.name);
    const signer = this._lt.signer;
    const nonce = await this._getNextNonce();
    const signed = signer.signCancelOrder({
      marketIndex: marketId,
      orderIndex: index,
      nonce,
      apiKeyIndex: (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex,
      accountIndex: this._lt.accountIndex,
    });
    if (signed.error) throw new PerpError("SIGNATURE_FAILED", `${this.name} spot cancel ${orderId}: signer error: ${signed.error}`, { exchange: this.name });
    const sent = await this._sendTx(signed, "order");
    const coi = Number(row.client_order_index ?? row.client_order_id);
    return this._cancelOutcome(sent, resolved, marketId, orderId, Number.isSafeInteger(coi) && coi > 0 ? coi : null);
  }

  /**
   * Venue-final outcome of a sent spot cancel, as perps (awaitTxExecuted + cancelOutcome): /tx
   * rejected → ORDER_REJECTED (the order is untouched). Then the order's own row — by client
   * order index (accountOrders), else by order id among the market's active, then latest 100
   * inactive orders: canceled-* → cancelled (a fill before the cancel → partial, filledSize from
   * filled_base_amount), filled → filled (it filled before the cancel landed). Still open / not
   * readable after a few reads → finality "pending" (do NOT resubmit).
   */
  private async _cancelOutcome(sent: unknown, resolved: string, marketId: number, orderId: string, coi: number | null): Promise<SpotOrderResult> {
    const what = `spot cancel ${orderId} ${resolved}`;
    const txHash = (sent as { tx_hash?: unknown } | null)?.tx_hash;
    if (typeof txHash === "string" && txHash !== "") await this._awaitTx(txHash, what, this._lt.txPollAttempts(20));
    let out: LighterOrderOutcome | null = null;
    for (let attempt = 0; attempt < 4 && (out === null || out.status === "open"); attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500));
      try {
        const row = await this._orderRow(marketId, orderId, coi);
        out = row === null ? null : lighterRowOutcomeOf(row, orderId);
      } catch (e) {
        console.error(`[lighter-spot] ${what}: order row read failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const base = { venue: this.name, symbol: resolved, orderId, avgPrice: null, receivedToken: null, venueRaw: { sendTx: sent, outcome: out } };
    if (out === null || out.status === "open") {
      return {
        ...base, status: "pending", filledSize: null, finality: "pending",
        remediation: `Cancel sent; the order is ${out === null ? "not readable yet" : "still listed open"} — do NOT resubmit. Check: perp trade spot-orders ${resolved} -e ${this.name}`,
      };
    }
    return {
      ...base, status: spotStatusOf(out), filledSize: out.filledSize, finality: "final",
      remediation: out.status === "filled" ? `Order ${orderId} filled before the cancel landed` : null,
    };
  }

  /** The order's venue row: accountOrders by client order index, else active → latest 100 inactive by order id; not listed → null. */
  private async _orderRow(marketId: number, orderId: string, coi: number | null): Promise<Record<string, unknown> | null> {
    if (coi !== null) {
      return (await this._lt.getOrdersByClientIndex([coi])).find(r => lighterOrderIdOf(r) === orderId) ?? null;
    }
    for (const path of ["/accountActiveOrders", "/accountInactiveOrders"] as const) {
      const params: Record<string, string> = { account_index: String(this._lt.accountIndex), market_id: String(marketId) };
      if (path === "/accountInactiveOrders") params.limit = "100";
      const res = await this._restGetAuth(path, params) as { orders?: unknown };
      if (!Array.isArray(res.orders)) throw new PerpError("EXCHANGE_ERROR", `${this.name} ${path.slice(1)} returned no orders array`, { exchange: this.name });
      const row = (res.orders as Array<Record<string, unknown>>).find(o => lighterOrderIdOf(o) === orderId);
      if (row !== undefined) return row;
    }
    return null;
  }

  /**
   * Cancel the SPOT open orders (of `symbol`, or of every spot market) one by one. Never the
   * account-wide CancelAllOrders tx (market 255): it would also cancel the account's perp orders.
   */
  async spotCancelAllOrders(symbol?: string | null): Promise<unknown> {
    if (this._lt.isReadOnly) throw new Error("Cancel requires API key");
    const results = [];
    for (const o of await this.getSpotOpenOrders(symbol ?? null)) {
      results.push(await this.spotCancelOrder(o.symbol, o.orderId));
    }
    return results;
  }

  /** Transfer USDC from perp account to spot account (required before spot buys) */
  async transferUsdcToSpot(amount: number): Promise<unknown> {
    return this._selfTransfer(String(amount), 0, 1); // route: Perp(0) → Spot(1)
  }

  /** Transfer USDC from spot account back to perp account */
  async transferUsdcToPerp(amount: number): Promise<unknown> {
    return this._selfTransfer(String(amount), 1, 0); // route: Spot(1) → Perp(0)
  }

  /** SpotTransferCapable: only the venue collateral (USDC on Lighter, USDG on Lighter RH). */
  async transferToSpot(amount: string, asset: string): Promise<unknown> {
    return this._selfTransfer(this._transferAmount(amount, asset), 0, 1);
  }

  async transferToPerp(amount: string, asset: string): Promise<unknown> {
    return this._selfTransfer(this._transferAmount(amount, asset), 1, 0);
  }

  private _transferAmount(amount: string, asset: string): string {
    if (asset !== this._quote) {
      throw new PerpError("INVALID_PARAMS", `${this.name} spot↔perp transfer only moves ${this._quote} (got ${asset})`, { exchange: this.name });
    }
    return parsePositiveDecimal(amount, "Transfer amount");
  }

  /**
   * Internal self-transfer (same account, perp ↔ spot route) signed with the official
   * WASM SignTransfer and explicit routes. Route types: 0 = Perp, 1 = Spot. Same-owner
   * transfer → no L1 signature needed (wasm-signer.md).
   */
  private async _selfTransfer(amount: string, fromRoute: number, toRoute: number): Promise<unknown> {
    if (this._lt.isReadOnly) throw new Error("Transfer requires API key");
    // Collateral scale: USDC (Lighter) and USDG (Lighter RH) both have 6 decimals at asset id 3.
    // Exact decimal → integer units from the string (no float multiply: 0.29 * 1e6 = 289999.99…);
    // more than 6 decimals → INVALID_TICK, never silently truncated. Checked before any request.
    const scaled = toUnitsExact(parsePositiveDecimal(amount, "Transfer amount"), "0.000001", "transfer amount");
    if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PerpError("INVALID_PARAMS", `${this.name} transfer amount ${amount} is too large`, { exchange: this.name });
    }
    const scaledAmount = Number(scaled);
    // Docs (apidocs.lighter.xyz/docs/deposits-transfers-and-withdrawals, "Transfer between Lighter
    // accounts"): "Get the fee: transferFeeInfo (GET /api/v1/transferFeeInfo?account_index=…&
    // to_account_index=…, authenticated). The fee is charged **on top** of the amount and must
    // match exactly." Read before the nonce so the nonce is taken immediately before signing.
    const feeInfo = await this._restGetAuth("/transferFeeInfo", {
      account_index: String(this._lt.accountIndex),
      to_account_index: String(this._lt.accountIndex), // self
    }) as { code?: unknown; transfer_fee_usdc?: unknown };
    const usdcFee = feeInfo.transfer_fee_usdc;
    if (feeInfo.code !== 200 || typeof usdcFee !== "number" || !Number.isSafeInteger(usdcFee) || usdcFee < 0) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} transferFeeInfo returned no usable transfer_fee_usdc (code ${JSON.stringify(feeInfo.code ?? null)}, fee ${JSON.stringify(usdcFee ?? null)}); transfer not sent`, {
        exchange: this.name,
        remediation: "Nothing was sent. Retry; the transfer fee must be read from the venue and signed exactly",
      });
    }
    const nonce = await this._getNextNonce();
    const apiKeyIndex = (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex;
    const collateralAssetIndex = this._lt.collateralAssetIndex;
    const memo = "0x" + "00".repeat(32);
    const signed = this._lt.signer.signTransfer({
      toAccountIndex: this._lt.accountIndex, // self
      assetIndex: collateralAssetIndex,
      fromRouteType: fromRoute,
      toRouteType: toRoute,
      amount: scaledAmount,
      usdcFee,
      memo,
      nonce,
      apiKeyIndex,
      accountIndex: this._lt.accountIndex,
    });
    if (signed.error) throw new Error(`Transfer sign error: ${signed.error}`);
    return this._sendTx(signed, "action");
  }

  /** Get the spot market ID for a symbol */
  getSpotMarketId(symbol: string): number | undefined {
    return this._spotMarketMap.get(this.resolveSymbol(symbol));
  }

  /** Check if a base token has a spot market */
  hasSpotMarket(base: string): boolean {
    return this._spotBaseMap.has(base.toUpperCase()) ||
      this._spotMarketMap.has(`${base.toUpperCase()}/${this._quote}`);
  }

  /** Query open orders across all spot markets (the market_type "spot" markets loaded at init). */
  async getSpotOpenOrders(symbol: string | null = null): Promise<Array<{
    orderId: string;
    symbol: string;
    side: "buy" | "sell";
    price: string;
    size: string;
    filled: string;
    clientOrderIndex?: number;
  }>> {
    await this.init();
    if (this._lt.isReadOnly) return [];

    const allOrders: Array<{
      orderId: string;
      symbol: string;
      side: "buy" | "sell";
      price: string;
      size: string;
      filled: string;
      clientOrderIndex?: number;
    }> = [];

    const only = symbol === null ? null : this.resolveSymbol(symbol);
    // A missing / non-boolean is_ask must not silently become "buy".
    const sideOf = (isAsk: unknown, market: string, raw: unknown): "buy" | "sell" => {
      if (typeof isAsk !== "boolean") {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} spot open order on ${market} has no boolean is_ask (got ${JSON.stringify(isAsk)})`, { exchange: this.name, raw });
      }
      return isAsk ? "sell" : "buy";
    };
    for (const [sym, marketId] of this._spotMarketMap) {
      if (only !== null && sym !== only) continue;
      const data = await this._restGetAuth("/accountActiveOrders", {
        account_index: String(this._lt.accountIndex),
        market_id: String(marketId),
      }) as { orders?: Array<Record<string, unknown>> };
      for (const o of data.orders ?? []) {
        const field = (name: string): string => {
          const v = o[name];
          if (v === undefined || v === null || v === "") {
            throw new PerpError("EXCHANGE_ERROR", `${this.name} spot open order on ${sym} has no ${name}`, { exchange: this.name, raw: o });
          }
          return String(v);
        };
        allOrders.push({
          orderId: lighterOrderIdOf(o) || field("order_id"),
          symbol: sym,
          side: sideOf(o.is_ask, sym, o),
          price: field("price"),
          size: field("remaining_base_amount"),
          filled: field("filled_base_amount"),
          clientOrderIndex: o.client_order_index != null ? Number(o.client_order_index) : undefined,
        });
      }
    }
    return allOrders;
  }

  /** Cancel a spot order by clientOrderIndex (safe integer, avoids order_id overflow). */
  async spotCancelByClientIndex(symbol: string, clientOrderIndex: number): Promise<unknown> {
    await this.init();
    const resolved = this.resolveSymbol(symbol);
    const marketId = this._spotMarketMap.get(resolved);
    if (marketId === undefined) throw new Error(`Unknown spot market: ${symbol}`);

    const signer = this._lt.signer;
    const nonce = await this._getNextNonce();
    const apiKeyIndex = (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex;

    const signed = signer.signCancelOrder({
      marketIndex: marketId,
      orderIndex: clientOrderIndex,
      nonce,
      apiKeyIndex,
      accountIndex: this._lt.accountIndex,
    });
    if (signed.error) throw new PerpError("SIGNATURE_FAILED", `${this.name} spot cancel (client index ${clientOrderIndex}): signer error: ${signed.error}`, { exchange: this.name });
    return this._sendTx(signed, "order");
  }

  // ── Private helpers ──

  private async _placeOrder(opts: {
    marketIndex: number;
    baseAmount: number;
    price: number;
    isAsk: number;
    orderType: number;
    timeInForce: number;
  }): Promise<{ clientOrderIndex: number; [key: string]: unknown }> {
    // Pre-send (key, nonce, signature): a failure is a definite "not placed".
    let signed: { txType?: number; txInfo?: string; error?: string };
    let clientOrderIndex: number;
    try {
      ({ signed, clientOrderIndex } = await this._signOrder(opts));
    } catch (e) {
      throw orderNotSent(this.name, "spot order", e);
    }
    const rowMatch: LighterRowMatch = { marketIndex: opts.marketIndex, sentAtMs: Date.now() };
    const txResult = await this._sendTx(signed, "place");
    return { ...(txResult as Record<string, unknown>), clientOrderIndex, rowMatch };
  }

  private async _signOrder(opts: {
    marketIndex: number;
    baseAmount: number;
    price: number;
    isAsk: number;
    orderType: number;
    timeInForce: number;
  }): Promise<{ signed: { txType?: number; txInfo?: string; error?: string }; clientOrderIndex: number }> {
    if (this._lt.isReadOnly) {
      throw new Error(`Spot trading requires a Lighter API key. Run \`perp wallet agent approve ${this._lt.name}\` to register an agent.`);
    }
    const nonce = await this._getNextNonce();
    const signer = this._lt.signer;
    const apiKeyIndex = (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex;
    // Use a unique clientOrderIndex (uint48, max 2^48-1 ≈ 281 trillion).
    // This value is used for cancel operations instead of the exchange-assigned
    // order_id which can exceed Number.MAX_SAFE_INTEGER.
    const clientOrderIndex = this._nextClientOrderIndex();
    const signed = signer.signCreateOrder({
      marketIndex: opts.marketIndex,
      clientOrderIndex,
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
    if (!signed.txInfo) throw new Error("Signer returned empty txInfo");
    if (signed.txType === undefined || !Number.isFinite(signed.txType)) {
      throw new Error(`Lighter signer returned no txType (received ${signed.txType}); refusing to send with default 0.`);
    }
    return { signed, clientOrderIndex };
  }

  /** Generated client order index (uint48): ms timestamp + random bits — see lighterGeneratedClientOrderIndex. */
  private _nextClientOrderIndex(): number {
    return lighterGeneratedClientOrderIndex();
  }

  private async _getNextNonce(): Promise<number> {
    const apiKeyIndex = (this._lt as unknown as { _apiKeyIndex: number })._apiKeyIndex;
    const res = await this._restGet("/nextNonce", {
      account_index: String(this._lt.accountIndex),
      api_key_index: String(apiKeyIndex),
    }) as { nonce?: number; next_nonce?: number };
    const nonce = res.nonce ?? res.next_nonce;
    // SSOT rule #2: refuse to silently default to nonce 0. A stale or missing
    // nonce will cause Lighter to reject the tx with cryptic errors and the
    // user has no way to diagnose the upstream failure.
    if (nonce === undefined || !Number.isFinite(nonce) || nonce < 0) {
      throw new Error(
        `Lighter /nextNonce returned no valid nonce for account_index=${this._lt.accountIndex} ` +
        `api_key_index=${apiKeyIndex}; raw response=${JSON.stringify(res)}`,
      );
    }
    return nonce;
  }

  /**
   * POST /sendTx. `kind` "place" (order placement): failures are typed: before the request → ORDER_REJECTED; transport error, HTTP 5xx or an
   * unreadable body after it → ORDER_PENDING (the tx may have been accepted — never
   * resubmit); an explicit non-200 code → ORDER_REJECTED. "order" (cancels) / "action"
   * (transfers): an explicit non-200 code → ORDER_REJECTED / ACTION_REJECTED
   * (lighterSendTxRejection — validated and refused before execution).
   */
  private async _sendTx(signed: { txType?: number; txInfo?: string; error?: string }, kind: "place" | "order" | "action"): Promise<unknown> {
    if (signed.error) throw new Error(`Signer error: ${signed.error}`);
    if (!signed.txInfo) throw new Error("Signer returned empty txInfo");
    if (signed.txType === undefined || !Number.isFinite(signed.txType)) {
      throw new Error(`Lighter signer returned no txType (received ${signed.txType}); refusing to send with default 0.`);
    }
    const baseUrl = (this._lt as unknown as { _baseUrl: string })._baseUrl;
    try {
      await this._lt.rhRate("sendTx");
    } catch (e) {
      throw orderNotSent(this.name, kind === "place" ? "spot order" : `spot ${kind}`, e);
    }
    // Same send contract for placements, cancels and transfers (lighterPostSendTx): transport
    // failure / 5xx / unreadable body / internal or missing code → ORDER_PENDING; only a
    // documented validation code is a definite rejection.
    return lighterPostSendTx(baseUrl, { txType: signed.txType, txInfo: signed.txInfo }, this.name,
      kind === "action" ? "action" : "order", kind === "place" ? "spot order sendTx" : `spot ${kind} sendTx`);
  }

  private async _restGet(path: string, params: Record<string, string>): Promise<unknown> {
    const baseUrl = (this._lt as unknown as { _baseUrl: string })._baseUrl;
    const url = new URL(`${baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    await this._lt.rhRate(path);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      // apidocs.lighter.xyz/docs/rate-limits: a breached limit answers "HTTP 429" (as LighterAdapter.restGet).
      if (res.status === 429) throw rateLimitedError(this._lt.name, res.headers.get("retry-after"), text);
      const waf = lighterWafChallenge(this._lt.name, res.status, text);
      if (waf !== null) throw waf;
      const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(`GET ${path} failed (${res.status}): ${clean}`);
    }
    return res.json();
  }

  private async _restGetAuth(path: string, params: Record<string, string>): Promise<unknown> {
    if (this._lt.isReadOnly) throw new Error("Auth requires API key");
    const auth = await (this._lt as unknown as { getAuthToken(): Promise<string> }).getAuthToken();
    params.auth = auth;
    return this._restGet(path, params);
  }
}
