/**
 * Ondo Perps adapter — native TradingV2 + legacy ExchangeAdapter shim
 *
 * Signer: HMAC API key only (OndoAgentMeta → ~/.perp/ondo-agents/<keyId>.json).
 * There is no master-key signing path for trading; read-only adapters serve
 * public endpoints only.
 *
 * Order entry:
 *   - market orders: IOC LIMIT at the protection price
 *     alignProtectionPrice(slippagePrice(mark, side, bps), quoteIncrement, side),
 *     bps = the caller's resolveSlippage() value;
 *   - TIF: GTC | IOC | ALO, where ALO = GTC + postOnly; FOK is
 *     not offered (uniform CAPABILITY_UNSUPPORTED, never emulated); a limit order
 *     without a TIF is GTC;
 *   - limit orders without a caller clientOrderId get a generated one that
 *     encodes post-only (`pcli-p-<hex>` / `pcli-n-<hex>`, see ondoClientOrderId)
 *     because the API never reports postOnly back;
 *   - TP/SL attached to the entry via takeProfit/stopLoss;
 *   - stopMarket = position-level stop (POST /v1/perps/stop_order), reduce-only,
 *     mark-triggered; stopLimit is not offered by the venue;
 *   - amend = cancel, then place. `size` is the NEW OPEN
 *     size. The replacement keeps side / reduceOnly / TIF; post-only comes from
 *     the original's generated clientOrderId, or the caller's explicit TIF — an
 *     order whose post-only flag is not decodable (placed elsewhere / caller id)
 *     and no TIF given is refused before anything is cancelled. Fills that race
 *     the cancel reduce the replacement: replace = size − (filledAtCancel −
 *     filledAtRead); ≤ 0 (or below the step) → no replacement (reported). Cancel
 *     outcome unknown → ORDER_PENDING (nothing placed); cancel ok + replacement
 *     refused → ORDER_PARTIAL { cancelled, placed: null }.
 *   - cancel-all cancels resting ("open") orders and untriggered stops (position-level
 *     and entry-attached TP/SL) — see listWorkingOrders.
 *   - a reduce-only limit order must be IOC (capabilities.reduceOnlyTif); a resting one is
 *     refused before sending.
 * Limit prices and TP/SL triggers must be on tick (INVALID_TICK); sizes are
 * floored to the step (SIZE_TOO_SMALL when that reaches zero).
 */

import { nonEmptyOrListed } from "../unknown-symbol.js";
import { randomUUID } from "node:crypto";
import { PerpError, orderNotSent, orderOutcomeUnknown } from "../../errors.js";
import type { OndoAgentMeta } from "../../settings.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
  FundingHistoryRow
} from "../interface.js";
import type { ResolvedSlippage } from "../slippage.js";
import { alignProtectionPrice, floorSize, formatComputedPrice, requireOnTick, slippagePrice, subDecimal } from "../precision.js";
import type { TradingV2 } from "../trading-v2.js";
import { unsupported, validateLegacyTif, validateOrderRequest } from "../trading-v2.js";
import type { VenueCapabilities, VenueCreateContext, VenueDefinition } from "../venue.js";
import { networkConfig, requireCapabilities } from "../venue.js";
import type {
  AmendRequest, CancelResult, LeverageResult, Network, OrderExecution, OrderRef, OrderRequest, OrderResult, OrderStatus,
  TimeInForce, VenueMarket,
} from "../venue-types.js";
import { parseOrderRef, toLegacyMarketInfo } from "../venue-types.js";
import { builderGateOf, builderRejectionOf, NO_BUILDER, requireFeeBps, type BuilderDecision, type BuilderFeeGate } from "../builder-fee.js";
import { loadOndoCredentials, ONDO_APPROVE_REMEDIATION } from "./agent.js";
import { OndoClient, type OndoCredentials } from "./client.js";
import {
  fetchOndoMarketsWithStatus, fetchOndoTradingPairs, ondoMarketStatus, ondoPlainSymbol, ondoPublicData, ondoVenueSymbol, parseOndoTime, strOrNull,
  type OndoListedStatus, type OndoMarkPrice, type OndoTradingPair,
} from "./public.js";

// ── Raw shapes (OpenAPI rest-spec.json) ──

interface OndoOrder {
  orderId: string;
  clientOrderId?: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  market: string;
  filledSize: string;
  filledCost: string;
  fee: string;
  status: "open" | "fullyfilled" | "canceled" | "pending" | "untriggered";
  createdAt: string;
  type: "limit" | "market" | "stopMarket" | "takeProfitMarket";
  timeInForce?: "GTC" | "IOC";
  reduceOnly?: boolean;
  closePosition?: boolean;
  stopOrderType?: "stopLoss" | "takeProfit";
  triggerPrice?: string;
}

interface OndoPosition {
  market: string;
  direction: "long" | "short" | "neutral";
  netQuantity: string;
  averageEntryPrice: string;
  markPrice: string;
  liquidationPrice?: string;
  unrealizedPnl: string;
  leverage: string;
}

interface OndoBalance {
  marginBalance: string;
  availableMargin: string;
  usedMargin: string;
  unrealizedPnl: string;
}

interface OndoFill {
  market: string;
  price: string;
  size: string;
  side: "buy" | "sell";
  fee: string;
  time: string;
}

interface OndoPublicTrade {
  market: string;
  price: string;
  size: string;
  aggressor_side: "buy" | "sell";
  time: string;
}

interface OndoFundingRateValue { market: string; time: string; fundingRate: string }
interface OndoFundingFee { market: string; time: string; amount: string }
interface OndoCandle { startTime: string; open: string; high: string; low: string; close: string; volume: string }
interface OndoBook { bids: string[][]; asks: string[][] }
interface OndoStopOrders { market: string; positionDirection: string; stopLoss?: string; takeProfit?: string }
interface OndoBatchCancel {
  successfulCancels: OndoOrder[] | null;
  failedCancels: Array<{ orderId: string; error?: string; errorCode?: string }> | null;
}

const ORDERS_PAGE_LIMIT = 100;
const DEPTH_LEVELS = 50;
const PAIRS_TTL_MS = 5 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Ondo (Go) encodes an empty list as JSON null; that is "no rows", not an unknown value. */
function listOf<T>(v: T[] | null): T[] {
  return v === null ? [] : v;
}

function isPositive(s: string): boolean {
  return Number(s) > 0;
}

/**
 * Generated clientOrderId carrying the post-only flag: the
 * Ondo API never returns postOnly, so amend recovers it from the id instead of
 * a local file. `pcli-p-` = post-only, `pcli-n-` = not post-only; 39 chars of
 * [A-Za-z0-9_-] (venue rule: 1–64).
 */
const GENERATED_CLOID_RE = /^pcli-([pn])-[0-9a-f]{32}$/;

function ondoClientOrderId(postOnly: boolean): string {
  return `pcli-${postOnly ? "p" : "n"}-${randomUUID().replace(/-/g, "")}`;
}

/** Post-only flag of a generated clientOrderId; null = not generated here (attributes unknown). */
function postOnlyOf(clientOrderId: string | undefined): boolean | null {
  if (clientOrderId === undefined) return null;
  const m = GENERATED_CLOID_RE.exec(clientOrderId);
  return m === null ? null : m[1] === "p";
}

/** Ondo wire TIF for a resolved common TIF: ALO = GTC + postOnly. FOK is never sent. */
function wireTif(tif: TimeInForce): { timeInForce: "GTC" | "IOC"; postOnly: boolean; label: string } {
  if (tif === "ALO") return { timeInForce: "GTC", postOnly: true, label: "GTC+postOnly" };
  if (tif === "GTC" || tif === "IOC") return { timeInForce: tif, postOnly: false, label: tif };
  throw new PerpError("INVALID_PARAMS", `unreachable: Ondo TIF ${tif} passed validation`);
}

/** All-null execution record with the given method (fields set by the caller). */
function execution(method: string, partial: Partial<Omit<OrderExecution, "method">>): OrderExecution {
  return {
    method,
    slippageBps: partial.slippageBps ?? null,
    slippageSource: partial.slippageSource ?? null,
    protectionPrice: partial.protectionPrice ?? null,
    referencePrice: partial.referencePrice ?? null,
    tifRequested: partial.tifRequested ?? null,
    tifSent: partial.tifSent ?? null,
    expiresAt: partial.expiresAt ?? null,
    builderFee: partial.builderFee ?? null,
    notes: partial.notes ?? [],
  };
}

/** Execution record for an order read back from the venue (status / amend paths). */
function readExecution(o: OndoOrder): OrderExecution {
  const postOnly = postOnlyOf(o.clientOrderId);
  const method = o.type === "limit" ? "limit" : o.type === "market" ? "market" : "trigger";
  const tifSent = o.timeInForce === undefined ? null : postOnly === true ? "GTC+postOnly" : o.timeInForce;
  return execution(method, {
    tifSent,
    notes: postOnly === null && o.type === "limit" ? ["post-only flag not reported by the venue (order not placed with a perp-cli generated client id)"] : [],
  });
}

/** Thrown by an amend's DELETE: a venue answer (HTTP < 500 / rate limit) means the cancel was refused, anything else is unknown. */
function cancelDefinitelyRefused(e: unknown): boolean {
  if (!(e instanceof PerpError)) return false;
  if (e.structured.code === "RATE_LIMITED") return true;
  const http = e.structured.details?.httpStatus;
  return typeof http === "number" && http < 500;
}

/** Thrown by a POST: definitely not placed (venue refusal with HTTP < 500 or a pre-send failure). */
function placementDefinitelyRefused(e: unknown): boolean {
  if (!(e instanceof PerpError) || e.structured.code === "ORDER_PENDING") return false;
  const http = e.structured.details?.httpStatus;
  return typeof http === "number" ? http < 500 : e.structured.code !== "EXCHANGE_ERROR";
}

function mapStatus(o: OndoOrder): OrderStatus {
  switch (o.status) {
    case "pending": return "accepted";
    case "untriggered": return "open";
    case "open": return isPositive(o.filledSize) ? "partiallyFilled" : "open";
    case "fullyfilled": return "filled";
    // A cancelled order that filled part of its size is a partial fill (its remainder cancelled).
    case "canceled": return isPositive(o.filledSize) ? "partiallyFilled" : "cancelled";
  }
  throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: unknown order status "${String((o as { status: unknown }).status)}"`);
}

function refPath(ref: OrderRef): string {
  if (!ID_RE.test(ref.value)) {
    throw new PerpError("INVALID_PARAMS", `invalid order reference "${ref.value}" (allowed: A-Z a-z 0-9 _ -, max 64)`);
  }
  return ref.kind === "orderId" ? `/v1/perps/orders/${ref.value}` : `/v1/perps/orders/client:${ref.value}`;
}

/** CLI kline interval → Ondo resolution ("15m" → "15", "4h" → "240", "1d" → "1D", "1w" → "1W", "1M" → "1M"). */
function toResolution(interval: string): string {
  const m = /^(\d+)([mhdwM])$/.exec(interval.trim());
  if (!m) {
    throw new PerpError("INVALID_PARAMS", `Unsupported kline interval "${interval}"`, {
      remediation: "Use e.g. 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M",
    });
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case "m": return String(n);
    case "h": return String(n * 60);
    case "d": return `${n}D`;
    case "w": return `${n}W`;
    default: return `${n}M`;
  }
}

export class OndoAdapter implements ExchangeAdapter, TradingV2 {
  readonly name = "ondo" as const;
  readonly aliases = ["ondo-perps"] as const;
  readonly venue: VenueDefinition;
  readonly network: Network;

  private readonly caps: VenueCapabilities;
  private readonly client: OndoClient;
  private pairsCache: { at: number; byMarket: Map<string, OndoTradingPair> } | null = null;
  /**
   * Builder-fee gate (settings builder.ondo; Ondo has no approval step); null = not
   * configured. Set by the venue definition's create — the adapter never reads settings.
   */
  builderFee: BuilderFeeGate | null = null;
  /**
   * GET /v1/perps/candles needs the account's API key (docs.ondoperps.xyz rest-spec.json:
   * `security: [{"BearerAuth": []}, {"ApiKeyAuth": []}]` — no anonymous `{}` entry, unlike
   * /v1/perps/depth). `market kline` therefore uses the credentialed adapter (klinesNeedAuth).
   */
  readonly klinesRequireAuth = true;

  constructor(def: VenueDefinition, ctx: VenueCreateContext) {
    this.venue = def;
    this.network = ctx.network;
    this.caps = requireCapabilities(def);

    let credentials: OndoCredentials | null = null;
    if (!ctx.readOnly) {
      if (ctx.noAgent) {
        throw new PerpError("NO_SIGNER_AVAILABLE", "Ondo Perps signs only with a registered API key; --no-agent leaves no signer", {
          remediation: `Drop --no-agent, or register a key: ${ONDO_APPROVE_REMEDIATION}`,
        });
      }
      const agent = ctx.credentials.agent;
      if (agent === null || !("kind" in agent) || agent.kind !== "ondo") {
        throw new PerpError("NO_SIGNER_AVAILABLE", "No Ondo Perps API key registered", {
          remediation: `Register one: ${ONDO_APPROVE_REMEDIATION}`,
        });
      }
      const meta = agent as OndoAgentMeta;
      if (meta.network !== ctx.network) {
        throw new PerpError("AGENT_NOT_REGISTERED", `Ondo Perps API key ${meta.keyId} was approved for ${String(meta.network)}, not ${ctx.network}`, {
          remediation: `Register a ${ctx.network} key: ${ONDO_APPROVE_REMEDIATION}${ctx.network === "testnet" ? " -n testnet" : ""}`,
        });
      }
      credentials = loadOndoCredentials(meta.keyId);
    }

    this.client = new OndoClient({
      restUrl: networkConfig(def, ctx.network).restUrl,
      network: ctx.network,
      rateLimit: def.rateLimit,
      credentials,
    });
  }

  /** Raw REST client (same host + HMAC key) — shared with OndoSpotAdapter. */
  get restClient(): OndoClient {
    return this.client;
  }

  /** Account id from GET /v1/account — the `from.id`/`to.id` of withdrawals and spot↔perp transfers. */
  async accountId(): Promise<string> {
    const account = await this.client.get<{ accountID: string }>("/v1/account", null);
    return account.accountID;
  }

  // ── Helpers ──

  private async pairsByMarket(): Promise<Map<string, OndoTradingPair>> {
    if (this.pairsCache === null || Date.now() - this.pairsCache.at > PAIRS_TTL_MS) {
      const pairs = await fetchOndoTradingPairs(this.client);
      this.pairsCache = { at: Date.now(), byMarket: new Map(pairs.map(p => [p.market, p])) };
    }
    return this.pairsCache.byMarket;
  }

  private async pairOf(symbol: string): Promise<OndoTradingPair> {
    const market = ondoVenueSymbol(symbol);
    const pair = (await this.pairsByMarket()).get(market);
    if (pair === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Ondo Perps has no market ${market}`, {
        remediation: "List markets with: perp market list -e ondo",
      });
    }
    return pair;
  }

  /**
   * An order the venue returned as "pending" (not yet open / filled) is read back by id
   * (GET /v1/perps/orders/{id}, bounded 5 × 500 ms) until the venue reports a final status;
   * still pending → the result stays pending (never assumed open).
   */
  private async settlePending(r: OrderResult): Promise<OrderResult> {
    if (r.finality === "final" || r.orderId === null) return r;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(res => setTimeout(res, 500));
      let order: OndoOrder;
      try {
        order = await this.client.get<OndoOrder>(refPath({ kind: "orderId", value: r.orderId }), null);
      } catch {
        continue; // read retried; still unknown after the loop → pending
      }
      const read = this.toOrderResult(order, order, r.execution);
      if (read.finality === "final") return { ...read, venueRaw: { ack: r.venueRaw, order } };
    }
    r.execution.notes.push(`order ${r.orderId} still "pending" at the venue after the read-back — verify: perp account orders -e ondo`);
    return r;
  }

  private toOrderResult(o: OndoOrder, venueRaw: unknown, exec: OrderExecution): OrderResult {
    const status = mapStatus(o);
    const filled = isPositive(o.filledSize);
    return {
      venue: "ondo",
      symbol: ondoPlainSymbol(o.market),
      status,
      finality: status === "accepted" ? "pending" : "final",
      orderId: o.orderId,
      clientOrderId: strOrNull(o.clientOrderId),
      filledSize: o.filledSize,
      avgPrice: filled ? formatComputedPrice(Number(o.filledCost) / Number(o.filledSize)) : null,
      execution: exec,
      venueRaw,
    };
  }

  private toExchangeOrder(o: OndoOrder): ExchangeOrder {
    return {
      orderId: o.orderId,
      symbol: ondoPlainSymbol(o.market),
      side: o.side,
      price: o.price,
      size: o.size,
      filled: o.filledSize,
      status: o.status,
      type: o.type,
      triggerPrice: o.triggerPrice !== undefined && Number(o.triggerPrice) > 0 ? o.triggerPrice : null,
    };
  }

  private async listOrders(query: Record<string, string | number | null>): Promise<OndoOrder[]> {
    const out: OndoOrder[] = [];
    let cursor: string | null = null;
    do {
      const page: { result: OndoOrder[] | null; nextCursor: string | null } =
        await this.client.getPage<OndoOrder[] | null>("/v1/perps/orders", { ...query, limit: ORDERS_PAGE_LIMIT, cursor });
      out.push(...listOf(page.result));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out;
  }

  /**
   * Resting orders plus untriggered stop orders. The documented `status` filter enum is open /
   * canceled / fullyfilled; `untriggered` is a documented order status and the filter accepts it
   * (live mainnet 2026-10-05) — every returned row's own status is still checked.
   */
  private async listWorkingOrders(market: string | null): Promise<OndoOrder[]> {
    const open = await this.listOrders({ status: "open", market });
    const untriggered = (await this.listOrders({ status: "untriggered", market })).filter(o => o.status === "untriggered");
    return [...open, ...untriggered];
  }

  private async markPriceOf(market: string): Promise<string> {
    const marks = await this.client.publicGet<Record<string, OndoMarkPrice>>("/v1/perps/mark_prices", null);
    const m = marks[market];
    if (m === undefined) throw new PerpError("PRICE_STALE", `Ondo Perps: no mark price for ${market}`);
    return m.markPrice;
  }

  /**
   * `builderCode: { code, feeRateBpsFractional }` for the next order, recorded on `exec`
   * (builderFee + the reason a configured fee was not attached). Every order body carries it
   * explicitly — position stops do not inherit it (Ondo integration guide).
   */
  private async attachBuilderCode(body: Record<string, unknown>, exec: OrderExecution): Promise<void> {
    const gate = builderGateOf(this);
    const d: BuilderDecision = gate === null ? NO_BUILDER : await gate.decide({ hip3: false });
    exec.builderFee = d.applied;
    if (d.note !== null) exec.notes.push(d.note);
    if (d.applied !== null) body.builderCode = { code: d.applied.identity, feeRateBpsFractional: requireFeeBps(d.applied) };
  }

  /** stopMarket → position-level stop (POST /v1/perps/stop_order). */
  private async placePositionStop(req: OrderRequest, triggerPrice: string): Promise<OrderResult> {
    if (!req.reduceOnly) {
      throw unsupported(this.venue.displayName, "openingStop", "stop orders are position-level and always reduce-only", "Pass --reduce-only for stop orders on ondo");
    }
    if (req.clientOrderId !== null) {
      throw unsupported(this.venue.displayName, "stopClientOrderId", "position stops do not take a client order id", "Omit the client order id for stop orders");
    }
    if (req.tpsl !== null) throw new PerpError("INVALID_PARAMS", "tpsl cannot be attached to a stop order");
    if (req.triggerSource !== null && req.triggerSource !== "mark") {
      throw unsupported(this.venue.displayName, "triggerSource", `stops trigger on the mark price only (got ${req.triggerSource})`, "Use --trigger-type mark or omit it");
    }

    const pair = await this.pairOf(req.symbol);
    const trigger = requireOnTick(triggerPrice, pair.quoteIncrement);
    const quantity = floorSize(req.size, pair.baseIncrement);
    // A sell stop closes a long; a buy stop closes a short.
    const positionDirection = req.side === "sell" ? "long" : "short";
    const mark = Number(await this.markPriceOf(pair.market));
    const t = Number(trigger);
    if (t === mark) {
      throw new PerpError("INVALID_PARAMS", `Trigger ${trigger} equals the current mark price; cannot tell stop-loss from take-profit`);
    }
    const lossSide = positionDirection === "long" ? t < mark : t > mark;
    const type = lossSide ? "stopLoss" : "takeProfit";

    const exec = execution("trigger", {
      referencePrice: trigger,
      notes: [`position-level ${type} on the mark price; executes as a venue market order (no protection price)`],
    });
    const stopBody: Record<string, unknown> = { market: pair.market, positionDirection, type, triggerPrice: trigger, quantity };
    await this.attachBuilderCode(stopBody, exec);
    // Order type per kind, live mainnet 2026-10-05: stopLoss → "stopMarket", takeProfit → "takeProfitMarket".
    const orderType = type === "stopLoss" ? "stopMarket" : "takeProfitMarket";
    const sameStop = (o: OndoOrder) => o.status === "untriggered" && o.type === orderType && o.stopOrderType === type
      && o.triggerPrice !== undefined && Number(o.triggerPrice) === t && subDecimal(o.size, quantity) === "0";
    // The stop endpoint returns no order id ({market, positionDirection, stopLoss?, takeProfit?}),
    // so the order ids already listed BEFORE the POST are excluded afterwards — an older identical
    // stop is never reported as the new one. Pre-send: a failed read sends nothing.
    let before: Set<string>;
    try {
      const prior = await this.client.getPage<OndoOrder[] | null>("/v1/perps/orders", { market: pair.market, limit: ORDERS_PAGE_LIMIT });
      before = new Set(listOf(prior.result).map(o => o.orderId));
    } catch (e) {
      throw orderNotSent("ondo", `${type} ${req.side} ${quantity} ${pair.market} @ ${trigger}`, e);
    }
    const stopRaw = await this.client.post<OndoStopOrders>("/v1/perps/stop_order", stopBody);

    // Locate the resulting untriggered order. A stop set with `quantity` is a PARTIAL stop
    // (set-stop-order: "Sets a partial stop order for this quantity of the position instead of the
    // full position"), so it carries `size`, not closePosition (live mainnet 2026-10-05:
    // {type:"stopMarket", status:"untriggered", size:"0.005"}). The POST succeeded: a failed read
    // or no / several new candidates leave the stop's state unknown — ORDER_PENDING, never resubmit.
    const pendingRemediation = "Do NOT resubmit — the stop may be set. Check with: perp account orders -e ondo";
    let recent: Awaited<ReturnType<OndoClient["getPage"]>>;
    try {
      recent = await this.client.getPage<OndoOrder[] | null>("/v1/perps/orders", { market: pair.market, limit: ORDERS_PAGE_LIMIT });
    } catch (e) {
      throw orderOutcomeUnknown("ondo", `${type} at ${trigger}: accepted, but the order list could not be read`, e, pendingRemediation);
    }
    const fresh = listOf(recent.result as OndoOrder[] | null).filter(o => !before.has(o.orderId) && sameStop(o));
    if (fresh.length !== 1) {
      throw new PerpError("ORDER_PENDING", `Ondo Perps accepted the ${type} at ${trigger} but ${fresh.length === 0 ? "the new order is not visible in the order list" : `${fresh.length} new matching orders are listed (${fresh.map(o => o.orderId).join(", ")})`}`, {
        exchange: "ondo", stopOrders: stopRaw, remediation: pendingRemediation,
      });
    }
    const order = fresh[0];
    return this.toOrderResult(order, subDecimal(req.size, quantity) === "0"
      ? { stopOrder: stopRaw, order }
      : { stopOrder: stopRaw, order, requestedSize: req.size, placedSize: quantity }, exec);
  }

  // ── TradingV2 ──

  async getVenueMarkets(): Promise<VenueMarket[]> {
    return ondoPublicData.fetchMarkets(this.network);
  }

  async placeOrder(input: OrderRequest): Promise<OrderResult> {
    try {
      return await this.placeOrderOnVenue(input);
    } catch (e) {
      // A builder-related rejection drops the cached approval and says how to proceed; never retried.
      throw builderRejectionOf(this, e);
    }
  }

  private async placeOrderOnVenue(input: OrderRequest): Promise<OrderResult> {
    // GTC is the uniform default for a limit order without a TIF.
    const tifRequested = input.tif;
    const req: OrderRequest = input.type === "limit" && input.tif === null ? { ...input, tif: "GTC" } : input;
    if (req.tif === "FOK") {
      throw unsupported(this.venue.displayName, "fok", "fill-or-kill is not offered and is never emulated (a partial IOC fill cannot be undone)",
        "Use --tif IOC (partial fills possible) or GTC / ALO");
    }
    validateOrderRequest(this.venue, this.caps, req);
    if (req.type === "stopLimit") {
      throw unsupported(this.venue.displayName, "stopLimit", "the venue offers position stops (market) only", "Use a stop-market (position stop) instead");
    }
    if (req.type === "stopMarket") {
      if (req.triggerPrice === null) throw new PerpError("INVALID_PARAMS", "stopMarket order requires a trigger price");
      return this.placePositionStop(req, req.triggerPrice);
    }

    const pair = await this.pairOf(req.symbol);
    const size = floorSize(req.size, pair.baseIncrement);
    const body: Record<string, unknown> = {
      market: pair.market,
      side: req.side,
      size,
      reduceOnly: req.reduceOnly,
    };
    let exec: OrderExecution;
    if (req.type === "limit") {
      if (req.price === null || req.tif === null) throw new PerpError("INVALID_PARAMS", "limit order requires price and tif");
      const w = wireTif(req.tif);
      body.type = "limit";
      body.price = requireOnTick(req.price, pair.quoteIncrement);
      body.timeInForce = w.timeInForce;
      if (w.postOnly) body.postOnly = true;
      // The API never returns postOnly: encode it in a generated client id so amend can recover it.
      if (req.clientOrderId === null) body.clientOrderId = ondoClientOrderId(w.postOnly);
      exec = execution("limit", {
        tifRequested, tifSent: w.label,
        notes: tifRequested === null ? ["no time-in-force given; GTC (uniform default)"] : [],
      });
    } else {
      // validateOrderRequest guarantees the resolved bound for market orders.
      const slippage = req.slippage as ResolvedSlippage;
      // Slippage-bounded market: IOC limit at the protection price (see header).
      const mark = await this.markPriceOf(pair.market);
      const protectionPrice = alignProtectionPrice(slippagePrice(mark, req.side, slippage.bps), pair.quoteIncrement, req.side);
      body.type = "limit";
      body.price = protectionPrice;
      body.timeInForce = "IOC";
      const appliedBps = Math.abs(Number(protectionPrice) - Number(mark)) / Number(mark) * 10_000;
      exec = execution("protectedIoc", {
        slippageBps: Number(appliedBps.toFixed(4)), slippageSource: slippage.source,
        protectionPrice, referencePrice: mark, tifSent: "IOC",
        notes: [`resolved bound ${slippage.bps} bps (${slippage.source}); protection price aligned to tick ${pair.quoteIncrement} on the mark price`],
      });
    }
    if (req.clientOrderId !== null) {
      if (!ID_RE.test(req.clientOrderId)) {
        throw new PerpError("INVALID_PARAMS", `clientOrderId "${req.clientOrderId}" must be 1-64 chars of A-Z a-z 0-9 _ -`);
      }
      // A caller id in the generated format must not misstate post-only (amend trusts it).
      const flag = postOnlyOf(req.clientOrderId);
      if (flag !== null && flag !== (body.postOnly === true)) {
        throw new PerpError("INVALID_PARAMS", `clientOrderId "${req.clientOrderId}" uses the reserved pcli-${flag ? "p" : "n"}- prefix but the order is ${body.postOnly === true ? "" : "not "}post-only`);
      }
      body.clientOrderId = req.clientOrderId;
    }
    if (req.tpsl !== null) {
      if (req.tpsl.tp !== null) body.takeProfit = { triggerPrice: requireOnTick(req.tpsl.tp, pair.quoteIncrement) };
      if (req.tpsl.sl !== null) body.stopLoss = { triggerPrice: requireOnTick(req.tpsl.sl, pair.quoteIncrement) };
      exec.notes.push("TP/SL attached to the entry (venue takeProfit/stopLoss)");
    }

    await this.attachBuilderCode(body, exec);
    const order = await this.client.post<OndoOrder>("/v1/perps/orders", body);
    // Size flooring is surfaced, never silent (L2).
    return this.settlePending(this.toOrderResult(order, subDecimal(req.size, size) === "0" ? order : { requestedSize: req.size, placedSize: size, response: order }, exec));
  }

  async amendOrder(req: AmendRequest): Promise<OrderResult> {
    const pair = await this.pairOf(req.symbol);
    const original = await this.client.get<OndoOrder>(refPath(req.ref), null);
    if (original.market !== pair.market) {
      throw new PerpError("INVALID_PARAMS", `Order ${req.ref.value} is on ${original.market}, not ${pair.market}`);
    }
    if (original.type !== "limit" || original.status !== "open") {
      throw unsupported(this.venue.displayName, "amend", `only open limit orders can be amended (order is ${original.type}/${original.status})`,
        `Cancel it (perp trade cancel ${req.symbol} ${original.orderId} -e ondo) and place a new order`);
    }
    if (original.timeInForce === undefined) {
      throw new PerpError("EXCHANGE_ERROR", `Ondo Perps returned no timeInForce for limit order ${original.orderId}`);
    }

    // Replacement TIF: explicit caller TIF, else the original's (post-only from the generated client id).
    const postOnly = postOnlyOf(original.clientOrderId);
    let tif: TimeInForce;
    if (req.tif !== null) {
      if (req.tif === "FOK") {
        throw unsupported(this.venue.displayName, "fok", "fill-or-kill is not offered and is never emulated", "Use --tif GTC, IOC or ALO");
      }
      tif = validateLegacyTif(this.venue, this.caps, req.tif);
      if (postOnly !== null && (tif === "ALO") !== postOnly && req.forceTif !== true) {
        throw new PerpError("INVALID_PARAMS", `--tif ${tif} would make order ${original.orderId} ${postOnly ? "no longer post-only" : "post-only"} (its client id encodes ${postOnly ? "" : "not "}post-only)`, {
          remediation: `Omit --tif to keep the order's own TIF, or pass --force-tif to change it`,
        });
      }
    } else if (postOnly === null) {
      throw unsupported(this.venue.displayName, "amend", "original order attributes unknown",
        `pass --tif: perp trade edit ${req.symbol} ${original.orderId} <price> <size> --tif <GTC|IOC|ALO> -e ondo (ALO keeps post-only)`);
    } else {
      tif = postOnly ? "ALO" : original.timeInForce;
    }
    const w = wireTif(tif);
    // The replacement keeps reduceOnly: a reduce-only limit must be one of caps.reduceOnlyTif (IOC
    // — see header), so a reduce-only replacement at another TIF would be refused only AFTER the
    // original is cancelled. Refuse up front; nothing is cancelled.
    if (original.reduceOnly === true && this.caps.reduceOnlyTif !== null && !this.caps.reduceOnlyTif.includes(tif)) {
      throw unsupported(this.venue.displayName, "amend",
        `order ${original.orderId} is reduce-only and a reduce-only limit can only be ${this.caps.reduceOnlyTif.join(" / ")} (replacement TIF ${tif}); nothing was cancelled`,
        `Cancel it (perp trade cancel ${req.symbol} ${original.orderId} -e ondo) and place a new order`);
    }

    // Validate the replacement BEFORE cancelling so a bad price/size never loses the original.
    const price = requireOnTick(req.price, pair.quoteIncrement);
    floorSize(req.size, pair.baseIncrement);
    const filledAtRead = original.filledSize;

    let cancelled: OndoOrder;
    try {
      cancelled = await this.client.delete<OndoOrder>(`/v1/perps/orders/${original.orderId}`, null);
    } catch (e) {
      // A venue answer means the cancel was refused (original untouched); anything else is unknown.
      if (cancelDefinitelyRefused(e)) throw e;
      throw orderOutcomeUnknown("ondo", `amend: cancel of ${original.orderId}`, e,
        `No replacement was placed. Check the original: perp trade status ${original.orderId} --symbol ${req.symbol} -e ondo`);
    }
    const notes = [
      req.tif !== null ? `TIF ${tif} (from --tif)` : `TIF ${tif} kept (post-only flag from the order's generated client id)`,
      `cancel→replace: filledAtRead ${filledAtRead}, filledAtCancel ${cancelled.filledSize}`,
    ];
    const amendExec = (extra: string[], sent: string | null): OrderExecution =>
      execution("cancelReplace", { tifRequested: req.tif, tifSent: sent, notes: [...notes, ...extra] });

    if (cancelled.status === "fullyfilled") {
      return this.toOrderResult(cancelled, { cancelled, placed: null },
        amendExec([`order ${original.orderId} filled completely before the cancel — no replacement placed`], null));
    }
    if (cancelled.status !== "canceled") {
      throw new PerpError("ORDER_PENDING", `Ondo Perps amend: cancel of ${original.orderId} returned status "${cancelled.status}", not "canceled"; no replacement was placed`, {
        exchange: "ondo",
        cancelled,
        remediation: `Do NOT resubmit. Check the order: perp trade status ${original.orderId} --symbol ${req.symbol} -e ondo`,
      });
    }

    // req.size = new OPEN size; fills that raced the cancel reduce the replacement.
    const racedFill = subDecimal(cancelled.filledSize, filledAtRead);
    const replace = subDecimal(req.size, racedFill.startsWith("-") ? "0" : racedFill);
    let size: string | null = null;
    if (!replace.startsWith("-") && isPositive(replace)) {
      try {
        size = floorSize(replace, pair.baseIncrement);
      } catch (e) {
        if (!(e instanceof PerpError) || e.structured.code !== "SIZE_TOO_SMALL") throw e;
      }
    }
    if (size === null) {
      return this.toOrderResult(cancelled, { cancelled, placed: null },
        amendExec([`${racedFill} filled between read and cancel; replacement ${replace} is not above the step ${pair.baseIncrement} — no replacement placed`], null));
    }

    const body: Record<string, unknown> = {
      market: pair.market,
      side: original.side,
      type: "limit",
      price,
      size,
      reduceOnly: original.reduceOnly === true,
      timeInForce: w.timeInForce,
      clientOrderId: ondoClientOrderId(w.postOnly),
    };
    if (w.postOnly) body.postOnly = true;
    const replaceExec = amendExec([], w.label);
    await this.attachBuilderCode(body, replaceExec);
    let placed: OndoOrder;
    try {
      placed = await this.client.post<OndoOrder>("/v1/perps/orders", body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (placementDefinitelyRefused(e)) {
        throw new PerpError("ORDER_PARTIAL", `Ondo Perps amend: original order ${original.orderId} was CANCELLED but the replacement was refused: ${msg}`, {
          exchange: "ondo",
          cancelled,
          placed: null,
          remediation: "The original order is gone; place a new order manually",
        });
      }
      throw new PerpError("ORDER_PENDING", `Ondo Perps amend: original order ${original.orderId} was CANCELLED; the replacement outcome is unknown: ${msg}`, {
        exchange: "ondo",
        cancelled,
        replacementClientOrderId: body.clientOrderId,
        remediation: `Do NOT resubmit. Check: perp trade status c:${String(body.clientOrderId)} --symbol ${req.symbol} -e ondo`,
      });
    }
    const extra = [
      `filledBeforeCancel ${cancelled.filledSize}, replacedSize ${size}`,
      ...(subDecimal(req.size, size) === "0" ? [] : [`replacement size ${size} (requested open size ${req.size})`]),
    ];
    replaceExec.notes.push(...extra);
    return this.settlePending(this.toOrderResult(placed, { cancelled, placed, requestedSize: req.size, placedSize: size }, replaceExec));
  }

  async cancelByRef(_symbol: string, ref: OrderRef): Promise<CancelResult> {
    const order = await this.client.delete<OndoOrder>(refPath(ref), null);
    return { venue: "ondo", cancelled: [ref], failed: [], venueRaw: order };
  }

  /** Lists resting orders and untriggered stops (listWorkingOrders), then cancels them via the batch endpoint so every result is exact. */
  async cancelAllV2(symbol: string | null): Promise<CancelResult> {
    const open = await this.listWorkingOrders(symbol === null ? null : ondoVenueSymbol(symbol));
    const result: CancelResult = { venue: "ondo", cancelled: [], failed: [], venueRaw: [] };
    if (this.caps.batchPlaceMax === null) throw new Error("ondo capabilities.batchPlaceMax must be set");
    const chunk = this.caps.batchPlaceMax;
    const raws: OndoBatchCancel[] = [];
    for (let i = 0; i < open.length; i += chunk) {
      const ids = open.slice(i, i + chunk).map(o => o.orderId);
      const r = await this.client.delete<OndoBatchCancel>("/v1/perps/orders/batch", { orderIDs: ids.join(",") });
      raws.push(r);
      for (const o of listOf(r.successfulCancels)) result.cancelled.push({ kind: "orderId", value: o.orderId });
      for (const f of listOf(r.failedCancels)) {
        result.failed.push({ ref: { kind: "orderId", value: f.orderId }, error: JSON.stringify(f) });
      }
    }
    result.venueRaw = { batches: raws };
    return result;
  }

  async applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult> {
    if (marginMode === "isolated") {
      throw unsupported(this.venue.displayName, "isolatedMargin", "accounts are cross-margin only", "Omit --isolated (ondo accounts are cross-margin)");
    }
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new PerpError("INVALID_PARAMS", `Ondo Perps leverage must be a positive integer (got ${leverage})`);
    }
    const market = ondoVenueSymbol(symbol);
    await this.client.postNoResult("/v1/perps/leverage", { market, leverage: String(leverage) });
    return { venue: "ondo", symbol: ondoPlainSymbol(market), leverage, marginMode: "cross", venueRaw: null };
  }

  async getOrderStatus(_symbol: string, ref: OrderRef): Promise<OrderResult> {
    const order = await this.client.get<OndoOrder>(refPath(ref), null);
    return this.toOrderResult(order, order, readExecution(order));
  }

  // ── Legacy ExchangeAdapter: market data ──

  /** Legacy rows of LISTED markets plus `tradable` (status "active") and `status` (active / closed / reduceOnly). */
  async getMarkets(): Promise<Array<ExchangeMarketInfo & { tradable: boolean; status: OndoListedStatus }>> {
    return (await fetchOndoMarketsWithStatus(this.network)).map(r => ({ ...toLegacyMarketInfo(r.market), tradable: r.market.tradable, status: r.status }));
  }

  /**
   * `market info` for one market, resolved with the Ondo normalizer (ondoVenueSymbol: "AAPL",
   * "AAPL-USD", "AAPL-USD.P", "AAPL-PERP"). A disabled market is refused like every per-symbol read.
   */
  async getMarketInfo(symbol: string): Promise<ExchangeMarketInfo & { tradable: boolean; status: OndoListedStatus }> {
    const market = (await this.pairOf(symbol)).market; // unlisted → SYMBOL_NOT_FOUND
    await this.readableMarket(market);
    const row = (await this.getMarkets()).find(m => m.symbol === ondoPlainSymbol(market));
    if (row === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Ondo Perps ${market} has no mark price (no price feed)`, { exchange: "ondo", remediation: "List markets with: perp market list -e ondo" });
    }
    return row;
  }

  /**
   * Venue symbol of a per-symbol read (book / trades / funding / kline), via the one normalizer
   * (ondoVenueSymbol). A disabled (delisted / paused) listing → SYMBOL_NOT_FOUND with status
   * "disabled": its prices are zeroed or frozen and its funding rate is stale, so nothing it returns
   * is live market data. An unlisted symbol is left to each read's own SYMBOL_NOT_FOUND
   * (nonEmptyOrListed / the venue's answer).
   */
  private async readableMarket(symbol: string): Promise<string> {
    const market = ondoVenueSymbol(symbol);
    const pair = (await this.pairsByMarket()).get(market);
    if (pair !== undefined && ondoMarketStatus(pair, null) === "disabled") {
      throw new PerpError("SYMBOL_NOT_FOUND", `Ondo Perps ${market} is disabled (delisted / paused) — no live market data`, {
        exchange: "ondo", status: "disabled", remediation: "List tradable markets with: perp market list -e ondo",
      });
    }
    return market;
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const book = await this.client.publicGet<OndoBook>("/v1/perps/depth", { market: await this.readableMarket(symbol), depth: DEPTH_LEVELS });
    const lvl = (l: string[]): [string, string] => [l[0], l[1]];
    return { bids: book.bids.map(lvl), asks: book.asks.map(lvl) };
  }

  async getRecentTrades(symbol: string, limit?: number): Promise<ExchangePublicTrade[]> {
    const market = await this.readableMarket(symbol);
    const trades = await this.client.publicGet<OndoPublicTrade[] | null>("/v1/perps/trades", {
      market, limit: limit === undefined ? null : limit,
    });
    // `200 []` for an unlisted market (live 2026-10-14): checked against the market directory.
    return nonEmptyOrListed(this, symbol, listOf(trades).map(t => ({
      time: parseOndoTime(t.time, "trade"),
      symbol: ondoPlainSymbol(t.market),
      side: t.aggressor_side,
      price: t.price,
      size: t.size,
      fee: null, // public tape: no fee applies to the viewer
    })), ondoPlainSymbol(market));
  }

  async getFundingHistory(symbol: string, limit?: number): Promise<FundingHistoryRow[]> {
    const rows = await this.client.publicGet<OndoFundingRateValue[] | null>("/v1/perps/funding_rate_history", {
      market: await this.readableMarket(symbol), limit: limit === undefined ? null : limit,
    });
    return listOf(rows).map(r => ({ time: parseOndoTime(r.time, "funding"), rate: r.fundingRate, price: null, intervalHours: 1, rateKind: "lastSettled" as const }));
  }

  /**
   * GET /v1/perps/candles — authenticated (see klinesRequireAuth).
   * Minute-based resolutions are bucketed from `from` (live 2026-10-19: from=10:01:07 → candles at
   * :01), so `from` is floored to the interval boundary first; D / W / M are venue-aligned already.
   * The venue also returns a zero-volume bucket that opens after `to`; candles opening after the
   * requested end are not part of the range and are left out.
   */
  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const resolution = toResolution(interval);
    const minuteMs = /^\d+$/.test(resolution) ? Number(resolution) * 60_000 : null;
    const from = minuteMs === null ? startTime : Math.floor(startTime / minuteMs) * minuteMs;
    const market = await this.readableMarket(symbol);
    const candles = await this.client.get<OndoCandle[] | null>("/v1/perps/candles", {
      market,
      resolution,
      from: Math.floor(from / 1000),
      to: Math.floor(endTime / 1000),
    });
    const inRange = listOf(candles).filter(c => parseOndoTime(c.startTime, "candle") <= endTime);
    return nonEmptyOrListed(this, symbol, inRange.map(c => ({
      time: parseOndoTime(c.startTime, "candle"),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      quoteVolume: null,
      trades: null, // Ondo publishes no per-candle trade count
    })), ondoPlainSymbol(market));
  }

  // ── Legacy ExchangeAdapter: account ──

  async getBalance(): Promise<ExchangeBalance> {
    const b = await this.client.get<OndoBalance>("/v1/perps/balance", null);
    return { equity: b.marginBalance, available: b.availableMargin, marginUsed: b.usedMargin, unrealizedPnl: b.unrealizedPnl };
  }

  /**
   * netQuantity is documented as the unsigned position size ("Size of the
   * position in base currency", example "1.5489" on a short) with the side in
   * `direction`. A signed value is still accepted: the magnitude is used and
   * the sign must agree with `direction` (never dropped, never guessed).
   */
  async getPositions(): Promise<ExchangePosition[]> {
    const rows = await this.client.get<OndoPosition[] | null>("/v1/perps/positions", null);
    const out: ExchangePosition[] = [];
    for (const p of listOf(rows)) {
      const negative = p.netQuantity.startsWith("-");
      const size = negative ? p.netQuantity.slice(1) : p.netQuantity;
      if (p.direction === "neutral" || !isPositive(size)) continue;
      if (negative && p.direction !== "short") {
        throw new PerpError("EXCHANGE_ERROR", `Ondo Perps position ${p.market}: netQuantity ${p.netQuantity} contradicts direction ${p.direction}`);
      }
      out.push({
        symbol: ondoPlainSymbol(p.market),
        side: p.direction === "long" ? "long" : "short",
        size,
        entryPrice: p.averageEntryPrice,
        markPrice: p.markPrice,
        liquidationPrice: strOrNull(p.liquidationPrice),
        unrealizedPnl: p.unrealizedPnl,
        leverage: Number(p.leverage),
      });
    }
    return out;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    return (await this.listWorkingOrders(null)).map(o => this.toExchangeOrder(o));
  }

  async getOrderHistory(limit?: number): Promise<ExchangeOrder[]> {
    const rows = await this.client.get<OndoOrder[] | null>("/v1/perps/orders", { limit: limit === undefined ? null : limit });
    return listOf(rows).map(o => this.toExchangeOrder(o));
  }

  async getTradeHistory(limit?: number): Promise<ExchangeTrade[]> {
    const fills = await this.client.get<OndoFill[] | null>("/v1/perps/fills", { limit: limit === undefined ? null : limit });
    return listOf(fills).map(f => ({
      time: parseOndoTime(f.time, "fill"),
      symbol: ondoPlainSymbol(f.market),
      side: f.side,
      price: f.price,
      size: f.size,
      fee: f.fee,
    }));
  }

  /** `amount` is positive when the account received funding. */
  async getFundingPayments(limit?: number): Promise<ExchangeFundingPayment[]> {
    const rows = await this.client.get<OndoFundingFee[] | null>("/v1/perps/funding_fees", { limit: limit === undefined ? null : limit });
    return listOf(rows).map(r => ({ time: parseOndoTime(r.time, "funding fee"), symbol: ondoPlainSymbol(r.market), payment: r.amount }));
  }

  // ── Legacy ExchangeAdapter: trading (shim → TradingV2) ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage }): Promise<OrderResult> {
    return this.placeOrder({
      symbol, side, type: "market", size, price: null, triggerPrice: null, triggerSource: null, tif: null,
      reduceOnly: opts.reduceOnly, clientOrderId: null, slippage: opts.slippage, tpsl: null,
    });
  }

  async limitOrder(
    symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string },
  ): Promise<OrderResult> {
    // no TIF → GTC (uniform default); FOK → uniform CAPABILITY_UNSUPPORTED.
    const tifInput = opts?.tif;
    const tif = tifInput === undefined || tifInput === "" ? null : validateLegacyTif(this.venue, this.caps, tifInput);
    return this.placeOrder({
      symbol, side, type: "limit", size, price, triggerPrice: null, triggerSource: null, tif,
      reduceOnly: opts?.reduceOnly === true, clientOrderId: null, slippage: null, tpsl: null,
    });
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<OrderResult> {
    // tif null → keep the original's TIF (post-only decoded from the generated client id; refused when unknown).
    return this.amendOrder({ symbol, ref: parseOrderRef(orderId), price, size, tif: null });
  }

  async cancelOrder(symbol: string, orderId: string): Promise<CancelResult> {
    return this.cancelByRef(symbol, parseOrderRef(orderId));
  }

  async cancelAllOrders(symbol?: string): Promise<CancelResult> {
    return this.cancelAllV2(symbol === undefined ? null : symbol);
  }

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<LeverageResult> {
    return this.applyLeverage(symbol, leverage, marginMode === undefined ? null : marginMode);
  }

  async stopOrder(
    symbol: string, side: "buy" | "sell", size: string, triggerPrice: string,
    opts?: { limitPrice?: string; reduceOnly?: boolean; triggerType?: "mark" | "last" | "mid" },
  ): Promise<OrderResult> {
    if (opts?.limitPrice !== undefined) {
      throw unsupported(this.venue.displayName, "stopLimit", "the venue offers position stops (market) only", "Omit --limit-price; ondo stops execute as market orders");
    }
    return this.placeOrder({
      symbol, side, type: "stopMarket", size, price: null, triggerPrice,
      triggerSource: opts?.triggerType === undefined ? null : opts.triggerType,
      tif: null, reduceOnly: opts?.reduceOnly === true, clientOrderId: null, slippage: null, tpsl: null,
    });
  }

  // ── Withdraw (capabilities.WithdrawCapable) ──

  /**
   * Withdrawals are not available over the API (account owner, 2026-10-13): Ondo pays only
   * address-book destinations and refuses API-key auth for adding one
   * (`key_not_allowed_for_action`). Refused before any request — withdraw in the web app.
   */
  async withdraw(_amount: string, _destination: string): Promise<never> {
    throw unsupported("Ondo Perps", "withdraw", "the Ondo Perps API does not allow withdrawals", "Withdraw from the Ondo Perps web app");
  }
}
