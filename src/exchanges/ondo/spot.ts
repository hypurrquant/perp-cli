/**
 * Ondo Perps spot adapter.
 *
 * Same host and HMAC API key as perps (shares OndoAdapter's OndoClient).
 * Account model "separate": the Spot wallet ("spot") next to the Perps margin
 * wallet ("margin"); POST /v1/spot/transfers moves funds between them. Docs
 * (docs.ondoperps.xyz/api-reference/spot-api-guide, read 2026-10-05):
 *   "The wallet identifiers are `spot` for Spot trading, `margin` for Perps
 *    collateral, and `main` for the main wallet. Funds in another wallet do not
 *    automatically fund a Spot order."
 *   "`POST /v1/spot/transfers` requires `transfer`. It accepts `main` ↔ `spot`
 *    and `margin` ↔ `spot` transfers on the same account."
 *
 * Paths and shapes were first taken from the production web app (route table
 * module 10215, spot trade chunk 7609, balances parser 82886) and live public
 * GETs (2026-10-01); the Spot API guide now documents them:
 *   public  GET    /v1/markets            result.spot.tradingPairs
 *   public  GET    /v1/spot/ticker        [{market,disabled,lastPrice,bid,ask,baseVolume,quoteVolume,...}]
 *   public  GET    /v1/spot/depth         ?market=TSLA-USDC&depth= → {market,time,asks,bids}
 *   auth    GET    /v1/spot/balances      [{coin,total,free,usdValue}]
 *   auth    POST   /v1/spot/orders        {market,type,side,size,postOnly,price?,timeInForce?}
 *   auth    GET    /v1/spot/orders        ?activeOnly=true&market=&limit=&cursor=
 *   auth    DELETE /v1/spot/orders/{id}
 *   auth    DELETE /v1/spot/orders        ?market=
 *   auth    POST   /v1/spot/transfers     {symbol,amount,from:{wallet},to:{wallet}}
 *
 * Delayed placement (POST /v1/spot/orders/delayed) is NOT implemented. The guide
 * says "If the server rejects placement with a message directing you to a delayed
 * path, sign a new request using that exact path and a fresh timestamp", but it
 * documents neither an error_code nor the message for that rejection ("treat
 * `error` as descriptive text whose wording can change"), so there is no
 * documented signal to switch paths on. A rejection that names the delayed path
 * is reported as CAPABILITY_UNSUPPORTED (definitely not placed) — see submitFailure.
 *
 * Market orders: IOC LIMIT at
 *   alignProtectionPrice(slippagePrice(mid, side, bps), quoteIncrement, side)
 * which is the web app's own pattern. bps = the caller's resolveSlippage()
 * value. The mid comes from the spot
 * ticker's bid/ask; a one-sided book is PRICE_STALE (no lastPrice fallback).
 *
 * Unverified (needs a funded key):
 *   - whether API-key HMAC auth is accepted on /v1/spot/* (the web app uses a
 *     JWT). Auth rejections there map to NOT_IMPLEMENTED with remediation;
 *   - balance `coin` naming/units. The app indexes balances by the
 *     tokenConfig id / pair base ("TSLA", not the custodied "TSLAon"), and
 *     tokenConfig marks equities as ledgerUnit "shares" (displayed units, not
 *     raw GM-token units). Values are passed through as reported;
 *   - whether DELETE /v1/spot/orders returns a `result` (ignored either way);
 *   - minimum order size (not published).
 */

import { PerpError, isDefiniteOrderFailure, orderNotSent, orderOutcomeUnknown } from "../../errors.js";
import type { ResolvedSlippage } from "../slippage.js";
import { alignProtectionPrice, floorSize, formatComputedPrice, requireOnTick, slippagePrice, subDecimal } from "../precision.js";
import type {
  SpotAdapter, SpotBalance, SpotCancelAllCapable, SpotMarketInfo, SpotOpenOrdersCapable, SpotOrderResult,
  SpotTransferCapable,
} from "../spot-interface.js";
import { unsupported } from "../trading-v2.js";
import type { OndoAdapter } from "./adapter.js";
import type { OndoClient } from "./client.js";
import { fetchOndoSpotTradingPairs, type OndoSpotTradingPair } from "./public.js";

const QUOTE = "USDC";
const DEPTH_LEVELS = 50;
const ORDERS_PAGE_LIMIT = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SPOT_AUTH_REMEDIATION =
  "Ondo spot endpoints (/v1/spot/*) are undocumented and did not accept the API key (HMAC). " +
  "Trade spot in the Ondo Perps web app, or verify the key works on spot (perp wallet agent approve ondo) and report the error_code";

// ── Raw shapes (web app + live) ──

interface OndoSpotTicker {
  market: string;
  disabled: boolean;
  lastPrice: string;
  bid: string;
  ask: string;
  baseVolume: string;
  quoteVolume: string;
}

interface OndoSpotOrder {
  orderId: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  market: string;
  filledSize: string;
  filledCost: string;
  fee: string;
  status: "open" | "fullyfilled" | "canceled" | "pending" | "untriggered";
  type: "limit" | "market";
  timeInForce?: "GTC" | "IOC";
}

interface OndoSpotBalanceRow {
  coin: string;
  total: string;
  free?: string;
  usdValue?: string;
}

interface OndoSpotBook {
  market: string;
  time: string;
  bids: [string, string][] | null;
  asks: [string, string][] | null;
}

/** OpenAPI SpotWalletKey.wallet (rest-spec.json: main | margin | spot); spot ↔ perp uses these two. */
type Wallet = "spot" | "margin";

/** Ondo (Go) encodes an empty list as JSON null; that is "no rows". */
function listOf<T>(v: T[] | null): T[] {
  return v === null ? [] : v;
}

function decimalsOf(step: string): number {
  const frac = step.split(".")[1];
  return frac ? frac.replace(/0+$/, "").length : 0;
}

function isPositive(s: string): boolean {
  return Number(s) > 0;
}

export class OndoSpotAdapter implements SpotAdapter, SpotTransferCapable, SpotOpenOrdersCapable, SpotCancelAllCapable {
  readonly name = "ondo";
  private readonly perp: OndoAdapter;
  /** BASE (upper-cased) → enabled pair */
  private enabled = new Map<string, OndoSpotTradingPair>();
  /** wire market ("TSLA-USDC") → pair, incl. disabled (for mapping order rows) */
  private byMarket = new Map<string, OndoSpotTradingPair>();
  private initialized = false;

  constructor(perp: OndoAdapter) {
    this.perp = perp;
  }

  private get client(): OndoClient {
    return this.perp.restClient;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadPairs();
    this.initialized = true;
  }

  private async loadPairs(): Promise<OndoSpotTradingPair[]> {
    const pairs = await fetchOndoSpotTradingPairs(this.client);
    this.enabled.clear();
    this.byMarket.clear();
    for (const p of pairs) {
      this.byMarket.set(p.market, p);
      if (p.disabled !== true && p.pair.quote === QUOTE) this.enabled.set(p.pair.base.toUpperCase(), p);
    }
    return pairs.filter(p => p.disabled !== true && p.pair.quote === QUOTE);
  }

  /** bare base ("tsla") or "TSLA/USDC" → enabled pair (wire "TSLA-USDC"). */
  private async resolve(symbol: string): Promise<OndoSpotTradingPair> {
    await this.init();
    const [rawBase, rawQuote, extra] = symbol.trim().split("/");
    const base = (rawBase ?? "").toUpperCase();
    if (base === "" || extra !== undefined) throw new PerpError("INVALID_PARAMS", `Invalid spot symbol "${symbol}" (use TSLA or TSLA/USDC)`);
    if (rawQuote !== undefined && rawQuote.toUpperCase() !== QUOTE) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Ondo spot only quotes ${QUOTE} (got ${symbol})`, { exchange: "ondo" });
    }
    const pair = this.enabled.get(base);
    if (pair === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `No enabled Ondo spot market for ${symbol}`, {
        exchange: "ondo",
        remediation: `Available: ${[...this.enabled.values()].map(p => `${p.pair.base}/${QUOTE}`).join(", ") || "none"}`,
      });
    }
    return pair;
  }

  /** wire "TSLA-USDC" → "TSLA/USDC". */
  private displaySymbol(market: string): string {
    const p = this.byMarket.get(market);
    if (p !== undefined) return `${p.pair.base}/${p.pair.quote}`;
    const i = market.lastIndexOf("-");
    if (i <= 0) throw new PerpError("EXCHANGE_ERROR", `Ondo spot: unexpected market "${market}"`);
    return `${market.slice(0, i)}/${market.slice(i + 1)}`;
  }

  /**
   * Authenticated spot calls. HMAC acceptance on /v1/spot/* is unverified: a
   * 401/403 that is not a scope/IP/clock problem is reported as NOT_IMPLEMENTED
   * (the key works on perps but the spot route refuses it).
   */
  private async authed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PerpError) {
        const d = (e.structured.details ?? {}) as { httpStatus?: unknown; venueCode?: unknown };
        const http = d.httpStatus;
        const venueCode = typeof d.venueCode === "string" ? d.venueCode : null;
        const authHttp = http === 401 || http === 403;
        const keyRejected = venueCode === "auth_missing" || venueCode === "auth_invalid" || e.structured.code === "EXCHANGE_ERROR";
        if (authHttp && keyRejected) {
          throw new PerpError("NOT_IMPLEMENTED", `Ondo spot rejected API-key auth: ${e.message}`, {
            exchange: "ondo",
            venueCode,
            httpStatus: http,
            remediation: SPOT_AUTH_REMEDIATION,
          });
        }
      }
      throw e;
    }
  }

  private async ticker(): Promise<Map<string, OndoSpotTicker>> {
    const rows = await this.client.publicGet<OndoSpotTicker[] | null>("/v1/spot/ticker", null);
    return new Map(listOf(rows).map(r => [r.market, r]));
  }

  /** Book mid from the ticker. One-sided / empty book → PRICE_STALE (no lastPrice fallback). */
  private async mid(market: string): Promise<string> {
    const t = (await this.ticker()).get(market);
    if (t === undefined) throw new PerpError("PRICE_STALE", `Ondo spot: ${market} missing from /v1/spot/ticker`, { exchange: "ondo" });
    const bid = Number(t.bid);
    const ask = Number(t.ask);
    if (!(bid > 0) || !(ask > 0) || ask < bid) {
      throw new PerpError("PRICE_STALE", `Ondo spot: no two-sided quote for ${market} (bid ${t.bid}, ask ${t.ask})`, {
        exchange: "ondo",
        remediation: "Use a limit order (perp spot limit) instead of a market order",
      });
    }
    return String((bid + ask) / 2);
  }

  private toResult(o: OndoSpotOrder, venueRaw: unknown, remediation: string | null): SpotOrderResult {
    const filled = isPositive(o.filledSize);
    let status: SpotOrderResult["status"];
    switch (o.status) {
      case "fullyfilled": status = "filled"; break;
      case "canceled": status = filled ? "partial" : "cancelled"; break;
      case "open":
      case "untriggered": status = filled ? "partial" : "open"; break;
      case "pending": status = "pending"; break;
      default:
        throw new PerpError("EXCHANGE_ERROR", `Ondo spot: unknown order status "${String((o as { status: unknown }).status)}"`);
    }
    return {
      venue: "ondo",
      symbol: this.displaySymbol(o.market),
      orderId: o.orderId,
      status,
      filledSize: o.filledSize,
      avgPrice: filled ? formatComputedPrice(Number(o.filledCost) / Number(o.filledSize)) : null,
      finality: status === "pending" ? "pending" : "final",
      receivedToken: null,
      remediation,
      venueRaw,
    };
  }

  private async place(body: Record<string, unknown>, requested: string, size: string): Promise<{ order: OndoSpotOrder; raw: unknown }> {
    let order: OndoSpotOrder;
    try {
      order = await this.authed(() => this.client.post<OndoSpotOrder>("/v1/spot/orders", body));
    } catch (e) {
      throw submitFailure(e, `spot ${String(body.side)} ${size} ${String(body.market)}`);
    }
    // Size flooring is surfaced, never silent (L2).
    const raw = subDecimal(requested, size) === "0" ? order : { requestedSize: requested, placedSize: size, response: order };
    return { order, raw };
  }

  // ── Market data ──

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    const [pairs, tick] = await Promise.all([this.loadPairs(), this.ticker()]);
    this.initialized = true;
    return pairs.map((p): SpotMarketInfo => {
      const t = tick.get(p.market);
      if (t === undefined) throw new PerpError("EXCHANGE_ERROR", `Ondo spot: ${p.market} missing from /v1/spot/ticker`, { exchange: "ondo" });
      const bid = Number(t.bid);
      const ask = Number(t.ask);
      return {
        symbol: `${p.pair.base}/${QUOTE}`,
        baseToken: p.pair.base,
        quoteToken: QUOTE,
        // Mid of a two-sided book; one-sided / empty book → null (no last-trade substitute, Rule #2).
        markPrice: bid > 0 && ask > 0 ? formatComputedPrice((bid + ask) / 2) : null,
        volume24h: t.quoteVolume,
        sizeDecimals: decimalsOf(p.baseIncrement),
        priceDecimals: decimalsOf(p.quoteIncrement),
      };
    });
  }

  async getSpotOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const pair = await this.resolve(symbol);
    const book = await this.client.publicGet<OndoSpotBook>("/v1/spot/depth", { market: pair.market, depth: DEPTH_LEVELS });
    return { bids: listOf(book.bids), asks: listOf(book.asks) };
  }

  // ── Account ──

  async getSpotBalances(): Promise<SpotBalance[]> {
    const rows = await this.authed(() => this.client.get<OndoSpotBalanceRow[] | null>("/v1/spot/balances", null));
    return listOf(rows).map((r): SpotBalance => {
      if (r.free === undefined || r.free === "") {
        throw new PerpError("EXCHANGE_ERROR", `Ondo spot: balance row for ${r.coin} has no "free" amount`, { exchange: "ondo" });
      }
      // `coin` / units passed through as reported (see header: unverified).
      return { token: r.coin, total: r.total, available: r.free, held: subDecimal(r.total, r.free), shared: false };
    });
  }

  // ── Trading ──

  /** IOC limit at the protection price for the caller's resolved slippage bound. */
  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { slippage: ResolvedSlippage }): Promise<SpotOrderResult> {
    const bps = opts.slippage.bps;
    // Pre-send (market, size, protection price): a failure is a definite "not placed".
    let pair: OndoSpotTradingPair;
    let qty: string;
    let mid: string;
    let price: string;
    try {
      pair = await this.resolve(symbol);
      qty = floorSize(String(size), pair.baseIncrement);
      mid = await this.mid(pair.market);
      price = alignProtectionPrice(slippagePrice(mid, side, bps), pair.quoteIncrement, side);
    } catch (e) {
      throw orderNotSent("ondo", `spot ${side} ${size} ${symbol}`, e);
    }
    const { order, raw } = await this.place({
      market: pair.market, type: "limit", side, size: qty, price, timeInForce: "IOC", postOnly: false,
    }, String(size), qty);
    const appliedBps = Math.round(Math.abs(Number(price) / Number(mid) - 1) * 10_000 * 100) / 100;
    const r = this.toResult(order, { response: raw, protection: { referencePrice: mid, protectionPrice: price, appliedBps } }, null);
    if (r.status === "cancelled") {
      return { ...r, remediation: `No fill within ${bps} bps of mid ${mid} (limit ${price}); widen --slippage-bps or use a limit order` };
    }
    return r;
  }

  /** tif: GTC (default) | IOC | ALO (= GTC + postOnly). */
  async spotLimitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { tif?: string }): Promise<SpotOrderResult> {
    const tif = (opts?.tif ?? "GTC").trim().toUpperCase();
    if (tif !== "GTC" && tif !== "IOC" && tif !== "ALO") {
      throw unsupported("Ondo Perps spot", tif === "FOK" ? "fok" : "timeInForce",
        tif === "FOK" ? "fill-or-kill is not offered and is never emulated" : `time-in-force ${opts?.tif} is not offered`,
        "Use --tif GTC, IOC or ALO");
    }
    const pair = await this.resolve(symbol);
    const px = requireOnTick(String(price), pair.quoteIncrement);
    const qty = floorSize(String(size), pair.baseIncrement);
    const body: Record<string, unknown> = {
      market: pair.market, type: "limit", side, size: qty, price: px,
      timeInForce: tif === "IOC" ? "IOC" : "GTC",
      postOnly: tif === "ALO",
    };
    const { order, raw } = await this.place(body, String(size), qty);
    return this.toResult(order, raw, null);
  }

  async spotCancelOrder(symbol: string, orderId: string): Promise<SpotOrderResult> {
    await this.resolve(symbol);
    if (!ID_RE.test(orderId)) {
      throw new PerpError("INVALID_PARAMS", `invalid order id "${orderId}" (allowed: A-Z a-z 0-9 _ -, max 64)`);
    }
    const order = await this.authed(() => this.client.delete<OndoSpotOrder>(`/v1/spot/orders/${orderId}`, null));
    return this.toResult(order, order, null);
  }

  async getSpotOpenOrders(symbol: string | null): Promise<Array<{ orderId: string; symbol: string; side: "buy" | "sell"; price: string; size: string; filled: string }>> {
    const market = symbol === null ? null : (await this.resolve(symbol)).market;
    await this.init();
    const out: OndoSpotOrder[] = [];
    let cursor: string | null = null;
    do {
      const page: { result: OndoSpotOrder[] | null; nextCursor: string | null } = await this.authed(() =>
        this.client.getPage<OndoSpotOrder[] | null>("/v1/spot/orders", { activeOnly: true, market, limit: ORDERS_PAGE_LIMIT, cursor }));
      out.push(...listOf(page.result));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out.map(o => ({
      orderId: o.orderId,
      symbol: this.displaySymbol(o.market),
      side: o.side,
      price: o.price,
      size: o.size,
      filled: o.filledSize,
    }));
  }

  async spotCancelAllOrders(symbol: string | null): Promise<{ venue: "ondo"; market: string | null; cancelled: "all" }> {
    const market = symbol === null ? null : (await this.resolve(symbol)).market;
    await this.authed(() => this.client.deleteNoResult("/v1/spot/orders", { market }));
    return { venue: "ondo", market, cancelled: "all" };
  }

  // ── Spot ↔ perp transfer (POST /v1/spot/transfers, wallet "spot" ↔ "margin") ──
  // Docs (spot-api-guide): "The optional `id` inside `from` and `to` defaults to the
  // authenticated account ID." — not sent.

  async transferToSpot(amount: string, asset: string): Promise<{ venue: "ondo"; asset: string; amount: string; from: Wallet; to: Wallet }> {
    return this.transfer(amount, asset, "margin", "spot");
  }

  async transferToPerp(amount: string, asset: string): Promise<{ venue: "ondo"; asset: string; amount: string; from: Wallet; to: Wallet }> {
    return this.transfer(amount, asset, "spot", "margin");
  }

  private async transfer(amount: string, asset: string, from: Wallet, to: Wallet): Promise<{ venue: "ondo"; asset: string; amount: string; from: Wallet; to: Wallet }> {
    if (!/^\d+(\.\d+)?$/.test(amount) || !isPositive(amount)) {
      throw new PerpError("INVALID_PARAMS", `Transfer amount must be a positive decimal (got "${amount}")`);
    }
    const symbol = asset.trim();
    if (!/^[A-Za-z0-9]{1,20}$/.test(symbol)) throw new PerpError("INVALID_PARAMS", `Invalid transfer asset "${asset}"`);
    // A POST answered 5xx / unreadable / not answered is already ORDER_PENDING from OndoClient
    // (never resubmit); a 4xx venue error is a definite refusal.
    await this.authed(() => this.client.postNoResult("/v1/spot/transfers", {
      symbol, amount, from: { wallet: from }, to: { wallet: to },
    }));
    return { venue: "ondo", asset: symbol, amount, from, to };
  }
}

/**
 * Classify a POST /v1/spot/orders failure. Definite: a definite-code
 * PerpError (auth, signer, validation) or a venue error envelope on HTTP 4xx (generic
 * EXCHANGE_ERROR → ORDER_REJECTED). RATE_LIMITED is kept (rejected before processing).
 * Unknown → ORDER_PENDING: network failure, HTTP 5xx, a non-JSON / result-less body,
 * or any non-PerpError (e.g. the body read failing after the request went out).
 */
function submitFailure(e: unknown, what: string): PerpError {
  if (isDefiniteOrderFailure(e)) return e as PerpError;
  if (e instanceof PerpError) {
    if (e.structured.code === "RATE_LIMITED") return e;
    const d = (e.structured.details ?? {}) as { httpStatus?: unknown; venueCode?: unknown };
    const http = typeof d.httpStatus === "number" ? d.httpStatus : null;
    const envelope = "venueCode" in d; // ondoError(): the venue answered with a JSON error envelope
    if (envelope && http !== null && http >= 400 && http < 500) {
      // The venue directs this account to POST /v1/spot/orders/delayed. Not implemented:
      // the docs give no error_code / wording for that rejection (see the file header).
      if (/delayed/i.test(`${e.message} ${String(d.venueCode)}`)) {
        return new PerpError("CAPABILITY_UNSUPPORTED", `Ondo spot ${what} was rejected: the venue requires the delayed placement path (${e.message})`, {
          exchange: "ondo", httpStatus: http, venueCode: d.venueCode,
          remediation: "Delayed spot placement (POST /v1/spot/orders/delayed) is not implemented — nothing was placed. Place this order in the Ondo Perps web app",
        });
      }
      return new PerpError("ORDER_REJECTED", e.message, { exchange: "ondo", httpStatus: http, venueCode: d.venueCode });
    }
  }
  return orderOutcomeUnknown("ondo", what, e, "Do NOT resubmit — the order may have been placed. Check: perp -e ondo trade spot-orders / spot-balance");
}
