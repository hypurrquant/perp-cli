/**
 * Aster Spot Adapter.
 *
 * Host `sapi.asterdex.com` (testnet `sapi.asterdex-testnet.com`), paths
 * `/api/v3/*`. Signing is the perp EIP-712 Domain B scheme, reused through
 * `AsterAdapter.signedRequest()` (same agent signer + nonce counter).
 *
 * Account model is separate: spot balances live in `/api/v3/account`; funds
 * move with `POST /api/v3/asset/wallet/transfer` (FUTURE_SPOT / SPOT_FUTURE).
 *
 * Venue rules enforced locally (official spot V3 docs):
 *  - TIF GTC | IOC | GTX (post-only). FOK is rejected by the venue (-1115).
 *  - LIMIT price must be on PRICE_FILTER.tickSize (never rounded).
 *  - Market orders are IOC LIMIT at a protection price: bookTicker
 *    mid ± slippage, aligned toward crossing on tickSize, inside PRICE_FILTER
 *    min/max and PERCENT_PRICE (venue native MARKET is never sent).
 *  - quantity on LOT_SIZE step, min, max (MARKET_LOT_SIZE only for native MARKET).
 *  - MIN_NOTIONAL / NOTIONAL minimum when a price is known.
 *
 * Permission gate: when the active signer is an agent whose stored meta lacks
 * `permissions.canSpotTrade === true`, trading calls throw POLICY_DENIED. Venue
 * permission rejections (-1002 / -2015) are mapped to the same error.
 */

import type {
  SpotAdapter,
  SpotMarketInfo,
  SpotBalance,
  SpotOrderResult,
  SpotTransferCapable,
  SpotOpenOrdersCapable,
  SpotCancelAllCapable,
} from "./spot-interface.js";
import type { ResolvedSlippage } from "./slippage.js";
import { unsupported } from "./trading-v2.js";
import { asterIocOutcome, type AsterAdapter } from "./aster.js";
import { PerpError, isTransportFailure, orderNotSent, orderOutcomeUnknown, sendFailure, unknownActionRemediation } from "../errors.js";
import { addDecimal, alignProtectionPrice, exactUnits, floorSize, requireOnTick, requirePositive, slippagePrice, subDecimal } from "./precision.js";

/** Default quote for a bare base symbol (= venue spot quoteAssets[0]). */
const DEFAULT_QUOTE = "USDT";
const SPOT_REMEDIATION = "perp wallet agent rotate aster --can-spot";
/** Venue codes that mean "this signer may not do this" (spot V3 error table). */
const PERMISSION_CODES = new Set(["-1002", "-2015"]);

type AsterTif = "GTC" | "IOC" | "GTX";
type Params = Record<string, string | number | boolean>;

interface LotFilter { step: string; min: string; max: string }

interface AsterSpotMarket {
  wire: string;           // "BTCUSDT"
  base: string;
  quote: string;
  status: string;
  tickSize: string;
  /** PRICE_FILTER.minPrice / maxPrice ("0" = no bound) */
  minPrice: string;
  maxPrice: string;
  /** PERCENT_PRICE multipliers; null = filter absent */
  percent: { up: number; down: number } | null;
  lot: LotFilter;
  /** null = symbol has no MARKET_LOT_SIZE filter */
  marketLot: LotFilter | null;
  /** MIN_NOTIONAL.minNotional; null = filter absent */
  minNotional: string | null;
  /** NOTIONAL filter; null = filter absent */
  notional: { min: string; applyMinToMarket: boolean } | null;
}

interface AsterOrderRow {
  orderId: number | string;
  symbol: string;
  status: string;
  side: string;
  price: string;
  origQty: string;
  executedQty: string;
  avgPrice?: string;
}

function decimalsOf(step: string): number {
  const frac = step.split(".")[1];
  return frac ? frac.replace(/0+$/, "").length : 0;
}

/** Exact decimal comparison: -1 | 0 | 1. */
function cmp(a: string, b: string): number {
  const d = subDecimal(a, b);
  if (d.startsWith("-")) return -1;
  return d === "0" ? 0 : 1;
}

function isZero(v: string): boolean {
  return cmp(v, "0") === 0;
}

function venueCodeOf(e: unknown): string | null {
  if (!(e instanceof PerpError)) return null;
  const c = e.structured.details?.venueCode;
  return c === undefined || c === null ? null : String(c);
}

function str(v: unknown, field: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new PerpError("EXCHANGE_ERROR", `Aster spot: missing or invalid field "${field}"`, { exchange: "aster" });
}

function lotFilter(f: Record<string, unknown>, name: string): LotFilter {
  return { step: str(f.stepSize, `${name}.stepSize`), min: str(f.minQty, `${name}.minQty`), max: str(f.maxQty, `${name}.maxQty`) };
}

export class AsterSpotAdapter implements SpotAdapter, SpotTransferCapable, SpotOpenOrdersCapable, SpotCancelAllCapable {
  readonly name = "aster";
  private _perp: AsterAdapter;
  /** "BASE/QUOTE" → market */
  private _markets = new Map<string, AsterSpotMarket>();
  /** wire "BTCUSDT" → market */
  private _byWire = new Map<string, AsterSpotMarket>();
  private _initialized = false;
  private _tranCounter = 0;

  constructor(perp: AsterAdapter) {
    this._perp = perp;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._loadExchangeInfo();
    this._initialized = true;
  }

  // ── Market data ──

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    const [tickers, prices] = await Promise.all([
      this._publicGet("/api/v3/ticker/24hr", {}) as Promise<Array<Record<string, unknown>>>,
      this._publicGet("/api/v3/ticker/price", {}) as Promise<Array<Record<string, unknown>>>,
    ]);
    if (!Array.isArray(tickers) || !Array.isArray(prices)) {
      throw new PerpError("EXCHANGE_ERROR", "Aster /api/v3/ticker/24hr or /ticker/price did not return an array", { exchange: "aster" });
    }
    const dayByWire = new Map(tickers.map((t) => [String(t.symbol), t]));
    const priceByWire = new Map(prices.map((t) => [String(t.symbol), t]));
    const out: SpotMarketInfo[] = [];
    for (const m of this._markets.values()) {
      if (m.status !== "TRADING") continue;
      // Price source is /ticker/price: it covers every listed symbol (never-traded
      // ones report type "listing_price"), unlike /ticker/24hr.
      const p = priceByWire.get(m.wire);
      if (!p) {
        throw new PerpError("EXCHANGE_ERROR", `Aster spot: no /ticker/price row for TRADING symbol ${m.wire}`, { exchange: "aster" });
      }
      // /ticker/24hr omits symbols with no trade in the window (live: the
      // per-symbol query returns {}); an absent row is reported as null (not published).
      const day = dayByWire.get(m.wire);
      const volume24h = day === undefined ? null : str(day.quoteVolume, `${m.wire}.quoteVolume`);
      out.push({
        symbol: `${m.base}/${m.quote}`,
        baseToken: m.base,
        quoteToken: m.quote,
        markPrice: str(p.price, `${m.wire}.price`),
        volume24h,
        sizeDecimals: decimalsOf(m.lot.step),
        priceDecimals: decimalsOf(m.tickSize),
      });
    }
    return out;
  }

  async getSpotOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const m = this._resolve(symbol);
    const res = await this._publicGet("/api/v3/depth", { symbol: m.wire, limit: "50" }) as {
      bids?: [string, string][];
      asks?: [string, string][];
    };
    if (!Array.isArray(res.bids) || !Array.isArray(res.asks)) {
      throw new PerpError("EXCHANGE_ERROR", `Aster /api/v3/depth returned no bids/asks for ${m.wire}`, { exchange: "aster" });
    }
    return {
      bids: res.bids.map(([p, q]) => [String(p), String(q)]),
      asks: res.asks.map(([p, q]) => [String(p), String(q)]),
    };
  }

  // ── Account ──

  async getSpotBalances(): Promise<SpotBalance[]> {
    const acct = await this._signed("GET", "/api/v3/account", {}) as { balances?: Array<Record<string, unknown>> };
    if (!Array.isArray(acct.balances)) {
      throw new PerpError("EXCHANGE_ERROR", "Aster /api/v3/account returned no balances array", { exchange: "aster" });
    }
    const out: SpotBalance[] = [];
    for (const b of acct.balances) {
      const asset = str(b.asset, "balance.asset");
      const free = str(b.free, `${asset}.free`);
      const locked = str(b.locked, `${asset}.locked`);
      const total = addDecimal(free, locked);
      if (isZero(total)) continue;
      // Separate spot wallet — never the same money as perp equity.
      out.push({ token: asset, total, available: free, held: locked, shared: false });
    }
    return out;
  }

  // ── Trading ──

  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { slippage: ResolvedSlippage }): Promise<SpotOrderResult> {
    // IOC LIMIT at the protection price, never native MARKET (no price cap).
    // Pre-send (market, size, price, min notional, permission): a failure is a definite "not placed".
    let m: AsterSpotMarket;
    let qty: string;
    let px: string;
    let protection: { referencePrice: string; protectionPrice: string; appliedBps: number };
    try {
      m = this._resolveTrading(symbol);
      // A LIMIT order: LOT_SIZE applies (MARKET_LOT_SIZE is for type MARKET only).
      qty = this._sizeFor(m, size, false);
      protection = await this.computeProtectionPrice(symbol, side, opts.slippage);
      px = protection.protectionPrice;
      const minNotional = this._minNotional(m, false);
      if (minNotional !== null) this._checkNotional(m, px, qty, minNotional);
      this._requireSpotPermission();
    } catch (e) {
      throw orderNotSent("aster", `spot ${side} ${size} ${symbol}`, e);
    }
    // market=true: a NEW / PARTIALLY_FILLED IOC response is not final yet → "pending".
    const r = await this._submitOrder(m, {
      symbol: m.wire,
      side: side.toUpperCase(),
      type: "LIMIT",
      timeInForce: "IOC",
      quantity: qty,
      price: px,
    }, true);
    return { ...r, venueRaw: { response: r.venueRaw, protection } };
  }

  /**
   * Declared protection-price reference for spot: the bookTicker mid
   * ((bidPrice + askPrice) / 2, GET /api/v3/ticker/bookTicker). Spot has no mark price;
   * no runtime substitute — a missing / one-sided book → PRICE_STALE.
   */
  async referencePrice(symbol: string): Promise<string> {
    const m = this._resolve(symbol);
    let bid: number;
    let ask: number;
    try {
      const t = await this._publicGet("/api/v3/ticker/bookTicker", { symbol: m.wire }) as { bidPrice?: unknown; askPrice?: unknown };
      bid = Number(t.bidPrice);
      ask = Number(t.askPrice);
    } catch (e) {
      throw new PerpError("PRICE_STALE", `Aster spot ${m.wire} bookTicker unavailable: ${e instanceof Error ? e.message : String(e)}`, { exchange: "aster" });
    }
    if (!(bid > 0) || !(ask > 0) || !Number.isFinite(bid) || !Number.isFinite(ask)) {
      throw new PerpError("PRICE_STALE", `Aster spot ${m.wire} has no two-sided book (bid ${bid}, ask ${ask})`, { exchange: "aster" });
    }
    return String((bid + ask) / 2);
  }

  /**
   * Protection price a spot market order would be sent with now: mid ± slippage.bps,
   * aligned toward crossing on PRICE_FILTER.tickSize; outside PRICE_FILTER min/max or
   * PERCENT_PRICE (checked against the mid) → INVALID_PARAMS, never clamped.
   */
  async computeProtectionPrice(symbol: string, side: "buy" | "sell", slippage: ResolvedSlippage): Promise<{ referencePrice: string; protectionPrice: string; appliedBps: number }> {
    const m = this._resolve(symbol);
    const ref = await this.referencePrice(symbol);
    const protectionPrice = alignProtectionPrice(slippagePrice(ref, side, slippage.bps), m.tickSize, side);
    const p = Number(protectionPrice);
    if (Number(m.minPrice) > 0 && p < Number(m.minPrice)) {
      throw new PerpError("INVALID_PARAMS", `Aster spot ${m.wire}: price ${protectionPrice} below PRICE_FILTER minPrice ${m.minPrice}`, { exchange: "aster" });
    }
    if (Number(m.maxPrice) > 0 && p > Number(m.maxPrice)) {
      throw new PerpError("INVALID_PARAMS", `Aster spot ${m.wire}: price ${protectionPrice} above PRICE_FILTER maxPrice ${m.maxPrice}`, { exchange: "aster" });
    }
    if (m.percent !== null) {
      const r = Number(ref);
      if (p > r * m.percent.up || p < r * m.percent.down) {
        throw new PerpError("INVALID_PARAMS", `Aster spot ${m.wire}: protection price ${protectionPrice} is outside PERCENT_PRICE (${m.percent.down}..${m.percent.up} × ${ref})`, {
          exchange: "aster",
          remediation: "Use a smaller --slippage-bps",
        });
      }
    }
    const appliedBps = Math.abs(p - Number(ref)) / Number(ref) * 10_000;
    return { referencePrice: ref, protectionPrice, appliedBps };
  }

  /**
   * Definite IOC outcome (./ioc-outcome.ts contract) of what spotMarketOrder /
   * spotLimitOrder returned — a SpotOrderResult (its venueRaw is read) or a raw venue row.
   */
  iocOutcomeOf(raw: unknown): { filledSize: string; final: true } | null {
    if (raw !== null && typeof raw === "object" && (raw as { venue?: unknown }).venue === "aster" && "venueRaw" in raw) {
      // spotMarketOrder wraps the venue response as { response, protection }.
      const vr = (raw as { venueRaw: unknown }).venueRaw;
      const inner = vr !== null && typeof vr === "object" && "protection" in vr && "response" in vr ? (vr as { response: unknown }).response : vr;
      return asterIocOutcome(inner);
    }
    return asterIocOutcome(raw);
  }

  async spotLimitOrder(
    symbol: string,
    side: "buy" | "sell",
    price: string,
    size: string,
    opts?: { tif?: string },
  ): Promise<SpotOrderResult> {
    const m = this._resolveTrading(symbol);
    // Aster is a legacy family: limit orders keep the GTC default.
    const tif = this._mapTif(opts?.tif === undefined ? "GTC" : opts.tif);
    const px = requireOnTick(price, m.tickSize);
    const qty = this._sizeFor(m, size, false);
    const minNotional = this._minNotional(m, false);
    if (minNotional !== null) this._checkNotional(m, px, qty, minNotional);
    this._requireSpotPermission();
    return this._submitOrder(m, {
      symbol: m.wire,
      side: side.toUpperCase(),
      type: "LIMIT",
      timeInForce: tif,
      quantity: qty,
      price: px,
    }, false);
  }

  async spotCancelOrder(symbol: string, orderId: string): Promise<SpotOrderResult> {
    const m = this._resolve(symbol);
    if (!/^\d+$/.test(orderId)) {
      throw new PerpError("INVALID_PARAMS", `Aster orderId must be numeric (got "${orderId}")`, { exchange: "aster" });
    }
    this._requireSpotPermission();
    let raw: unknown;
    try {
      raw = await this._signed("DELETE", "/api/v3/order", { symbol: m.wire, orderId });
    } catch (e) {
      // Spot V3 docs ("Error Codes", 20xx): "-2011 CANCEL_REJECTED — Order cancellation rejected."
      // Same as the perp cancel: the order is not open, nothing was cancelled (definite).
      if (venueCodeOf(e) === "-2011") {
        throw new PerpError("ORDER_REJECTED", `Aster refused to cancel spot order ${orderId} on ${m.base}/${m.quote} (-2011 CANCEL_REJECTED): it is not an open order`, {
          exchange: "aster", orderId, venueCode: -2011,
          remediation: "List the open spot orders: perp -e aster trade spot-orders",
        });
      }
      throw e;
    }
    return this._toResult(m, raw, false);
  }

  async getSpotOpenOrders(symbol: string | null): Promise<Array<{ orderId: string; symbol: string; side: "buy" | "sell"; price: string; size: string; filled: string }>> {
    const params: Params = symbol === null ? {} : { symbol: this._resolve(symbol).wire };
    const rows = await this._signed("GET", "/api/v3/openOrders", params) as AsterOrderRow[];
    if (!Array.isArray(rows)) {
      throw new PerpError("EXCHANGE_ERROR", "Aster /api/v3/openOrders did not return an array", { exchange: "aster" });
    }
    return rows.map((o) => {
      const m = this._byWire.get(String(o.symbol));
      if (!m) {
        throw new PerpError("EXCHANGE_ERROR", `Aster spot open order on unknown symbol ${String(o.symbol)}`, { exchange: "aster" });
      }
      return {
        orderId: String(o.orderId),
        symbol: `${m.base}/${m.quote}`,
        side: o.side === "BUY" ? "buy" as const : "sell" as const,
        price: str(o.price, "order.price"),
        size: str(o.origQty, "order.origQty"),
        filled: str(o.executedQty, "order.executedQty"),
      };
    });
  }

  /** Venue requires a symbol; null cancels per symbol that has open orders. */
  async spotCancelAllOrders(symbol: string | null): Promise<unknown> {
    this._requireSpotPermission();
    if (symbol !== null) {
      return this._signed("DELETE", "/api/v3/allOpenOrders", { symbol: this._resolve(symbol).wire });
    }
    const open = await this.getSpotOpenOrders(null);
    const symbols = [...new Set(open.map((o) => o.symbol))];
    const results: unknown[] = [];
    for (const s of symbols) {
      results.push(await this._signed("DELETE", "/api/v3/allOpenOrders", { symbol: this._resolve(s).wire }));
    }
    return results;
  }

  // ── Transfer (separate account) ──

  async transferToSpot(amount: string, asset: string): Promise<unknown> {
    return this._transfer(amount, asset, "FUTURE_SPOT");
  }

  async transferToPerp(amount: string, asset: string): Promise<unknown> {
    return this._transfer(amount, asset, "SPOT_FUTURE");
  }

  private async _transfer(amount: string, asset: string, kindType: "FUTURE_SPOT" | "SPOT_FUTURE"): Promise<unknown> {
    requirePositive(amount, "amount");
    // Docs: the signer must be an agent approved with canSpotTrade or canPerpTrade.
    const meta = this._perp.activeAgentMeta();
    if (meta !== null && meta.permissions?.canSpotTrade !== true && meta.permissions?.canPerpTrade !== true) {
      throw new PerpError("POLICY_DENIED", "Aster agent has neither spot nor perp trading permission (required for wallet transfer)", {
        exchange: "aster",
        remediation: SPOT_REMEDIATION,
      });
    }
    const clientTranId = `perpcli${Date.now()}${++this._tranCounter}`;
    const what = `wallet transfer ${kindType} ${amount} ${asset.toUpperCase()}`;
    const remediation = `${unknownActionRemediation("aster", "transfer")} (perp -e aster spot balance / portfolio); clientTranId ${clientTranId}`;
    let res: { tranId?: unknown; status?: unknown };
    try {
      res = await this._signed("POST", "/api/v3/asset/wallet/transfer", {
        amount,
        asset: asset.toUpperCase(),
        clientTranId,
        kindType,
      }) as { tranId?: unknown; status?: unknown };
    } catch (e) {
      // Same contract as _submitOrder: once signed and sent, a 5xx, an unreadable 2xx body or a
      // transport failure (socket reset, timeout) leaves the transfer's outcome unknown →
      // ORDER_PENDING (never resubmit). No connection at all → not sent; 4xx / venue error
      // envelopes are definite refusals.
      const d = e instanceof PerpError ? e.structured.details : undefined;
      const http = typeof d?.httpStatus === "number" ? d.httpStatus : null;
      if (d?.responseUnreadable === true || (http !== null && http >= 500)) throw orderOutcomeUnknown("aster", what, e, remediation);
      if (isTransportFailure(e)) throw sendFailure("aster", what, e, remediation);
      if (e instanceof PerpError && e.structured.code === "EXCHANGE_ERROR" && http !== null && http >= 400 && http < 500) {
        throw new PerpError("ACTION_REJECTED", `Aster ${what} refused (nothing was transferred): ${e.message}`, { exchange: "aster", httpStatus: http, venueCode: d?.venueCode });
      }
      throw e;
    }
    // A completed transfer answers {"tranId": …, "status": "SUCCESS"}. No other status value is
    // known to be a definite failure, so anything else after an accepted request is unknown.
    if (res.status !== "SUCCESS") {
      throw orderOutcomeUnknown("aster", what, new Error(`venue status ${JSON.stringify(res.status ?? null)} (not "SUCCESS"): ${JSON.stringify(res).slice(0, 200)}`), remediation);
    }
    return res;
  }

  // ── Internals ──

  private async _loadExchangeInfo(): Promise<void> {
    const info = await this._publicGet("/api/v3/exchangeInfo", {}) as { symbols?: Array<Record<string, unknown>> };
    if (!Array.isArray(info.symbols)) {
      throw new PerpError("EXCHANGE_ERROR", "Aster /api/v3/exchangeInfo returned no symbols", { exchange: "aster" });
    }
    this._markets.clear();
    this._byWire.clear();
    for (const s of info.symbols) {
      const wire = str(s.symbol, "symbol");
      // Docs: symbols starting with TEST are Aster-internal and must not be traded.
      if (wire.startsWith("TEST")) continue;
      const filters = (Array.isArray(s.filters) ? s.filters : []) as Array<Record<string, unknown>>;
      const f = (type: string) => filters.find((x) => x.filterType === type) ?? null;
      const priceF = f("PRICE_FILTER");
      const lotF = f("LOT_SIZE");
      if (!priceF || !lotF) {
        throw new PerpError("EXCHANGE_ERROR", `Aster spot ${wire}: missing PRICE_FILTER or LOT_SIZE`, { exchange: "aster" });
      }
      const ppF = f("PERCENT_PRICE");
      let percent: AsterSpotMarket["percent"] = null;
      if (ppF) {
        const up = Number(str(ppF.multiplierUp, `${wire}.PERCENT_PRICE.multiplierUp`));
        const down = Number(str(ppF.multiplierDown, `${wire}.PERCENT_PRICE.multiplierDown`));
        if (!(up > 0) || !(down > 0)) {
          throw new PerpError("EXCHANGE_ERROR", `Aster spot ${wire}: unreadable PERCENT_PRICE multipliers`, { exchange: "aster" });
        }
        percent = { up, down };
      }
      const mlF = f("MARKET_LOT_SIZE");
      const mnF = f("MIN_NOTIONAL");
      const nF = f("NOTIONAL");
      const m: AsterSpotMarket = {
        wire,
        base: str(s.baseAsset, `${wire}.baseAsset`).toUpperCase(),
        quote: str(s.quoteAsset, `${wire}.quoteAsset`).toUpperCase(),
        status: str(s.status, `${wire}.status`),
        tickSize: str(priceF.tickSize, `${wire}.tickSize`),
        minPrice: str(priceF.minPrice, `${wire}.minPrice`),
        maxPrice: str(priceF.maxPrice, `${wire}.maxPrice`),
        percent,
        lot: lotFilter(lotF, `${wire}.LOT_SIZE`),
        marketLot: mlF ? lotFilter(mlF, `${wire}.MARKET_LOT_SIZE`) : null,
        minNotional: mnF ? str(mnF.minNotional, `${wire}.MIN_NOTIONAL`) : null,
        notional: nF ? { min: str(nF.minNotional, `${wire}.NOTIONAL.minNotional`), applyMinToMarket: nF.applyMinToMarket === true } : null,
      };
      this._markets.set(`${m.base}/${m.quote}`, m);
      this._byWire.set(wire, m);
    }
  }

  /** bare base → BASE/USDT; "BASE/QUOTE" as given. */
  private _resolve(symbol: string): AsterSpotMarket {
    const parts = symbol.toUpperCase().split("/");
    if (parts.length > 2 || !parts[0]) {
      throw new PerpError("INVALID_PARAMS", `Aster spot symbol must be BASE or BASE/QUOTE (got "${symbol}")`, { exchange: "aster" });
    }
    const key = parts.length === 2 ? `${parts[0]}/${parts[1]}` : `${parts[0]}/${DEFAULT_QUOTE}`;
    const m = this._markets.get(key);
    if (!m) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Aster spot market ${key} not found`, {
        exchange: "aster",
        remediation: "List markets with the spot markets command for aster",
      });
    }
    return m;
  }

  private _resolveTrading(symbol: string): AsterSpotMarket {
    const m = this._resolve(symbol);
    if (m.status !== "TRADING") {
      throw unsupported("Aster", "spotMarket", `spot ${m.base}/${m.quote} is not trading (status ${m.status})`, "Pick a spot market whose status is TRADING");
    }
    return m;
  }

  private _mapTif(raw: string): AsterTif {
    const t = raw.toUpperCase();
    if (t === "GTC" || t === "IOC" || t === "GTX") return t;
    if (t === "ALO") return "GTX";
    if (t === "FOK") {
      throw unsupported("Aster", "fok", "spot rejects FOK (venue returns -1115 INVALID_TIF)", "Use --tif IOC, GTC or ALO (post-only)");
    }
    throw new PerpError("INVALID_PARAMS", `Unsupported time-in-force "${raw}" for Aster spot`, {
      exchange: "aster",
      remediation: "Use --tif GTC, IOC or ALO (post-only)",
    });
  }

  /** Floor to LOT_SIZE (+ MARKET_LOT_SIZE) step and check min/max of each applicable filter. */
  private _sizeFor(m: AsterSpotMarket, size: string, market: boolean): string {
    requirePositive(size, "size");
    const lots = [m.lot];
    // A zero MARKET_LOT_SIZE step means no step constraint; min/max still apply.
    if (market && m.marketLot) lots.push(m.marketLot);
    // Floor only on a non-zero step (a zero step means no step constraint).
    let qty = size;
    for (const l of lots) {
      if (!isZero(l.step)) qty = floorSize(qty, l.step);
    }
    for (const l of lots) {
      const name = l === m.lot ? "LOT_SIZE" : "MARKET_LOT_SIZE";
      if (cmp(qty, l.min) < 0) {
        throw new PerpError("SIZE_TOO_SMALL", `Aster spot ${m.wire}: quantity ${qty} below ${name} minQty ${l.min}`, {
          exchange: "aster",
          remediation: `Use a size of at least ${l.min}`,
        });
      }
      if (!isZero(l.max) && cmp(qty, l.max) > 0) {
        throw new PerpError("SIZE_TOO_LARGE", `Aster spot ${m.wire}: quantity ${qty} above ${name} maxQty ${l.max}`, {
          exchange: "aster",
          remediation: `Split the order into sizes of at most ${l.max}`,
        });
      }
      // Venue rule: (quantity - minQty) % stepSize == 0
      if (!isZero(l.step) && exactUnits(subDecimal(qty, l.min), l.step) === null) {
        throw new PerpError("INVALID_PARAMS", `Aster spot ${m.wire}: quantity ${qty} is off the ${name} grid (minQty ${l.min}, step ${l.step})`, {
          exchange: "aster",
        });
      }
    }
    return qty;
  }

  /** Effective minimum notional, or null when no filter applies. */
  private _minNotional(m: AsterSpotMarket, market: boolean): string | null {
    const mins: string[] = [];
    if (m.minNotional !== null) mins.push(m.minNotional);
    if (m.notional !== null && (!market || m.notional.applyMinToMarket)) mins.push(m.notional.min);
    if (mins.length === 0) return null;
    return mins.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  }

  private _checkNotional(m: AsterSpotMarket, price: string, qty: string, minNotional: string): void {
    const notional = Number(price) * Number(qty);
    if (!Number.isFinite(notional) || notional < Number(minNotional)) {
      throw new PerpError("SIZE_TOO_SMALL", `Aster spot ${m.wire}: notional ${notional} below minimum ${minNotional} ${m.quote}`, {
        exchange: "aster",
        remediation: `Increase size so price × size ≥ ${minNotional} ${m.quote}`,
      });
    }
  }

  /** gate only when the active signer is an agent lacking canSpotTrade. */
  private _requireSpotPermission(): void {
    const meta = this._perp.activeAgentMeta();
    if (meta !== null && meta.permissions?.canSpotTrade !== true) {
      throw new PerpError("POLICY_DENIED", "Aster agent is not approved for spot trading (canSpotTrade=false)", {
        exchange: "aster",
        remediation: SPOT_REMEDIATION,
      });
    }
  }

  private async _signed(method: "GET" | "POST" | "DELETE", path: string, params: Params): Promise<unknown> {
    try {
      return await this._perp.signedRequest(this._perp.spotBaseUrl, method, path, params);
    } catch (e) {
      const code = venueCodeOf(e);
      if (code !== null && PERMISSION_CODES.has(code)) {
        throw new PerpError("POLICY_DENIED", `Aster spot rejected the signer's permissions [${code}]: ${(e as Error).message}`, {
          exchange: "aster",
          venueCode: code,
          remediation: SPOT_REMEDIATION,
        });
      }
      throw e;
    }
  }

  private async _publicGet(path: string, params: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this._perp.spotBaseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      throw new PerpError(res.status === 429 ? "RATE_LIMITED" : "EXCHANGE_ERROR", `GET ${path} failed (${res.status}): ${text.slice(0, 200)}`, {
        exchange: "aster",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PerpError("EXCHANGE_ERROR", `GET ${path}: malformed JSON: ${text.slice(0, 200)}`, { exchange: "aster" });
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const j = parsed as { code?: unknown; msg?: unknown };
      if (typeof j.code === "number" && j.code < 0) {
        throw new PerpError(j.code === -1121 ? "SYMBOL_NOT_FOUND" : "EXCHANGE_ERROR", `GET ${path}: [${j.code}] ${String(j.msg)}`, {
          exchange: "aster",
          venueCode: j.code,
        });
      }
    }
    return parsed;
  }

  /**
   * POST /api/v3/order. Outcome-unknown failures — HTTP 5xx (the gateway may have
   * forwarded the order), a network / timeout error, or a 2xx with an unreadable
   * body — become a "pending" result,
   * never a thrown (retryable) EXCHANGE_ERROR: a resubmit could place a second order.
   * 4xx / venue error envelopes are definite rejections and still throw.
   */
  private async _submitOrder(m: AsterSpotMarket, params: Params, market: boolean): Promise<SpotOrderResult> {
    let raw: unknown;
    try {
      raw = await this._signed("POST", "/api/v3/order", params);
    } catch (e) {
      const d = e instanceof PerpError ? e.structured.details : undefined;
      const http = typeof d?.httpStatus === "number" ? d.httpStatus : null;
      // A transport failure (fetch / socket / timeout) after signing may have delivered the order too.
      const unknownOutcome = d?.responseUnreadable === true || (http !== null && http >= 500) || isTransportFailure(e);
      if (!unknownOutcome) {
        // Explicit 4xx / venue error envelope: definitely not placed.
        if (e instanceof PerpError && e.structured.code === "EXCHANGE_ERROR" && http !== null && http >= 400 && http < 500) {
          throw new PerpError("ORDER_REJECTED", e.message, { exchange: "aster", httpStatus: http, venueCode: d?.venueCode });
        }
        throw e;
      }
      return {
        venue: "aster",
        symbol: `${m.base}/${m.quote}`,
        orderId: null,
        status: "pending",
        filledSize: null,
        avgPrice: null,
        finality: "pending",
        receivedToken: null,
        remediation: `Aster order submit outcome unknown (${e instanceof Error ? e.message : String(e)}) — do NOT resubmit; check spot open orders and balances: perp -e aster trade spot-orders / spot-balance`,
        venueRaw: null,
      };
    }
    return this._acceptedResult(m, raw, market);
  }

  /**
   * Result of an order the venue already accepted (HTTP success). A response that
   * cannot be interpreted must not become a thrown error — a retry would place a
   * second order — so it is reported as finality "pending" with the order id.
   */
  private _acceptedResult(m: AsterSpotMarket, raw: unknown, market: boolean): SpotOrderResult {
    try {
      return this._toResult(m, raw, market);
    } catch (e) {
      const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const orderId = typeof r.orderId === "string" || typeof r.orderId === "number" ? String(r.orderId) : null;
      return {
        venue: "aster",
        symbol: `${m.base}/${m.quote}`,
        orderId,
        status: "pending",
        filledSize: null,
        avgPrice: null,
        finality: "pending",
        receivedToken: null,
        remediation: `Order was accepted by Aster but its response could not be read (${e instanceof Error ? e.message : String(e)}) — do NOT resubmit; check spot open orders and balances for aster${orderId !== null ? ` (orderId ${orderId})` : ""}`,
        venueRaw: raw,
      };
    }
  }

  private _toResult(m: AsterSpotMarket, raw: unknown, market: boolean): SpotOrderResult {
    const r = raw as Record<string, unknown>;
    const venueStatus = str(r.status, "order.status");
    const executed = r.executedQty !== undefined ? str(r.executedQty, "order.executedQty") : null;
    const hasFill = executed !== null && !isZero(executed);
    let status: SpotOrderResult["status"];
    switch (venueStatus) {
      case "NEW": status = "open"; break;
      case "PARTIALLY_FILLED": status = "partial"; break;
      case "FILLED": status = "filled"; break;
      case "CANCELED": status = "cancelled"; break;
      case "REJECTED": status = "rejected"; break;
      // EXPIRED = engine-cancelled remainder (e.g. market not fully filled).
      case "EXPIRED": status = hasFill ? "partial" : "cancelled"; break;
      default:
        throw new PerpError("EXCHANGE_ERROR", `Aster spot: unknown order status "${venueStatus}"`, { exchange: "aster" });
    }
    // A MARKET order still NEW/PARTIALLY_FILLED has not reached a terminal state.
    const pending = market && (venueStatus === "NEW" || venueStatus === "PARTIALLY_FILLED");
    const avg = r.avgPrice !== undefined ? str(r.avgPrice, "order.avgPrice") : null;
    return {
      venue: "aster",
      symbol: `${m.base}/${m.quote}`,
      orderId: r.orderId !== undefined ? String(r.orderId) : null,
      status,
      filledSize: executed,
      avgPrice: hasFill && avg !== null && !isZero(avg) ? avg : null,
      finality: pending ? "pending" : "final",
      receivedToken: null,
      remediation: pending
        ? "Market order submitted but not final yet — do NOT resubmit; check spot open orders and balances for aster"
        : null,
      venueRaw: raw,
    };
  }
}
