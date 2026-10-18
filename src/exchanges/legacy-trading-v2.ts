/**
 * TradingV2 for the four pre-existing venues (pacifica, hyperliquid, lighter /
 * lighter-rh, aster).
 *
 * Composition, not modification: the legacy ExchangeAdapter methods keep returning
 * their raw venue responses (in-process contract for smart-order, perp-order,
 * plan-executor, grid). This wrapper calls the same adapter methods (same send
 * path) and normalizes the raw response into an OrderResult + execution record.
 * The raw response is kept verbatim in `venueRaw`.
 *
 * Status rules (SSOT Rule #2): a status / fill is reported only when the venue
 * response proves it; otherwise "accepted" with finality "pending".
 */

import { PerpError, orderOutcomeUnknown } from "../errors.js";
import type { ExchangeAdapter } from "./interface.js";
import { isPacificaStopType, pacificaRefused, type PacificaAdapter, type PacificaCancelRefusal } from "./pacifica.js";
import { isPacificaRateLimited } from "../pacifica/rate-limit.js";
import { iocLotTolerance, isIocOutcomeCapable } from "./ioc-outcome.js";
import { isQueryOrderCapable } from "./capabilities.js";
import type { ResolvedSlippage } from "./slippage.js";
import { floorSize, lotStepOf } from "./precision.js";
import { getVenue, requireCapabilities, type VenueCapabilities, type VenueDefinition } from "./venue.js";
import { isTradingV2, unsupported, validateOrderRequest, type TradingV2 } from "./trading-v2.js";
import { LIGHTER_GTT_EXPIRY_MS } from "./venues/lighter-family.js";
import { builderDecisionOf, builderGateOf, builderRejectionOf, NO_BUILDER, type BuilderDecision } from "./builder-fee.js";
import {
  withExecution,
  type AmendRequest, type CancelResult, type LeverageResult, type Network, type OrderExecution, type OrderRef,
  type OrderRequest, type OrderResult, type OrderStatus, type TimeInForce, type VenueId, type VenueMarket,
} from "./venue-types.js";

type LegacyFamily = "pacifica" | "hyperliquid" | "lighter" | "aster";

function isLegacyFamily(f: VenueDefinition["family"]): f is LegacyFamily {
  return f === "pacifica" || f === "hyperliquid" || f === "lighter" || f === "aster";
}

/** The adapter itself when it implements TradingV2 (ondo, arcus, qfex); else the legacy wrapper. */
/** cancelAllV2 verification: extra open-order re-lists (and the wait between them) for acked cancels still listed. */
const CANCEL_ALL_RELIST_RETRIES = 4;
const CANCEL_ALL_RELIST_DELAY_MS = 1_000;

export function tradingV2Of(adapter: ExchangeAdapter, network: Network): TradingV2 {
  if (isTradingV2(adapter)) return adapter;
  return toTradingV2(adapter, network);
}

export function toTradingV2(adapter: ExchangeAdapter, network: Network): TradingV2 {
  const venue = getVenue(adapter.name);
  if (!isLegacyFamily(venue.family)) {
    throw new PerpError("NOT_IMPLEMENTED", `${venue.displayName} adapter does not implement TradingV2`);
  }
  return new LegacyTradingV2(adapter, venue, venue.family, requireCapabilities(venue), network);
}

/** One reduce-only protective trigger (TP or SL) of a separateOrders venue. */
export interface TpSlLeg {
  symbol: string;
  /** Side that closes the protected position (sell closes a long). */
  closeSide: "buy" | "sell";
  /** Positive size (the verified fill or the live position) — never "0". */
  size: string;
  trigger: string;
  kind: "tp" | "sl";
  /** Limit price once triggered; null = market trigger. */
  limitPrice: string | null;
  /** Resolved bound for protection-priced market triggers (Lighter); native triggers ignore it. */
  slippage: ResolvedSlippage;
}

/**
 * Place one reduce-only TP/SL trigger on a separateOrders venue (hyperliquid, lighter /
 * lighter-rh, aster) and normalize the result. HL tags the trigger "tp"/"sl" natively;
 * Lighter / Aster receive the leg kind explicitly and send take-profit / stop-loss as given.
 */
export async function placeTpSlLeg(adapter: ExchangeAdapter, network: Network, leg: TpSlLeg): Promise<OrderResult> {
  const venue = getVenue(adapter.name);
  // A TradingV2 venue with separate TP/SL orders (QFEX) places its own legs.
  const own = (adapter as { placeTpSlLeg?: (l: TpSlLeg) => Promise<OrderResult> }).placeTpSlLeg;
  if (isTradingV2(adapter) && typeof own === "function" && requireCapabilities(venue).tpsl === "separateOrders") {
    return own.call(adapter, leg);
  }
  if (!isLegacyFamily(venue.family) || requireCapabilities(venue).tpsl !== "separateOrders") {
    throw new PerpError("INVALID_PARAMS", `${venue.displayName} does not place TP/SL as separate trigger orders`);
  }
  const w = new LegacyTradingV2(adapter, venue, venue.family, requireCapabilities(venue), network);
  try {
    return await w.placeTpSlLeg(leg);
  } catch (e) {
    throw builderRejectionOf(adapter, e); // never retried
  }
}

// ── Raw-response readers (never throw; null = not proven by the response) ──

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
}

function plainDecimal(v: unknown): string | null {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s) ? s : null;
}

function positiveDecimal(v: unknown): string | null {
  const s = plainDecimal(v);
  return s !== null && Number(s) > 0 ? s : null;
}

function idString(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string" && v !== "") return v;
  return null;
}

/**
 * "filled" when `filled` covers the size SENT (half a lot when the market lot `step` is known,
 * else float-noise tolerance), "cancelled" for 0, else "partiallyFilled".
 */
function fillStatus(size: string, filled: string, step: string | null): OrderStatus {
  if (Number(filled) === 0) return "cancelled";
  return Number(size) - Number(filled) <= iocLotTolerance(size, filled, step) ? "filled" : "partiallyFilled";
}

interface Parsed {
  status: OrderStatus;
  finality: "final" | "pending";
  orderId: string | null;
  /** null = not proven by the response (pending) — never "0" as a stand-in. */
  filledSize: string | null;
  avgPrice: string | null;
}

const PENDING: Parsed = { status: "accepted", finality: "pending", orderId: null, filledSize: null, avgPrice: null };

/** HL `order` / `batchModify` response: response.data.statuses[0] = resting | filled | error. */
function parseHl(raw: unknown, size: string, step: string | null): Parsed {
  const statuses = rec(rec(rec(raw)?.response)?.data)?.statuses;
  // Trigger orders are acknowledged with the bare status string "waitingForTrigger" (no oid).
  if (Array.isArray(statuses) && statuses[0] === "waitingForTrigger") {
    // The oid the adapter identified in frontendOpenOrders after the ack (HyperliquidAdapter.triggerOrder).
    return { status: "open", finality: "final", orderId: idString(rec(raw)?.triggerOid), filledSize: "0", avgPrice: null };
  }
  const st = Array.isArray(statuses) ? rec(statuses[0]) : null;
  if (st === null) return PENDING;
  const resting = rec(st.resting);
  if (resting !== null) {
    return { status: "open", finality: "final", orderId: idString(resting.oid), filledSize: "0", avgPrice: null };
  }
  const filled = rec(st.filled);
  const total = filled !== null ? plainDecimal(filled.totalSz) : null;
  if (filled !== null && total !== null) {
    return { status: fillStatus(size, total, step), finality: "final", orderId: idString(filled.oid), filledSize: total, avgPrice: positiveDecimal(filled.avgPx) };
  }
  return PENDING;
}

const ASTER_STATUS: Readonly<Record<string, OrderStatus>> = {
  NEW: "open", PARTIALLY_FILLED: "partiallyFilled", FILLED: "filled",
  CANCELED: "cancelled", EXPIRED: "cancelled", REJECTED: "rejected",
};

/** Aster order object (POST/PUT /fapi/v3/order): orderId, status, executedQty, avgPrice. */
function parseAster(raw: unknown): Parsed {
  const r = rec(raw);
  if (r === null) return PENDING;
  const orderId = idString(r.orderId);
  const status = typeof r.status === "string" ? ASTER_STATUS[r.status] : undefined;
  const executed = plainDecimal(r.executedQty);
  if (status === undefined || executed === null) return { ...PENDING, orderId };
  return { status, finality: "final", orderId, filledSize: executed, avgPrice: positiveDecimal(r.avgPrice) };
}

/**
 * Lighter resting / post-only placement: the adapter's resolved `orderOutcome` (tx event_info or
 * accountOrders — LighterAdapter.resolveOrderOutcome) is final; without one the sendTx ack is pending.
 */
function parseLighter(raw: unknown): Parsed {
  const o = rec(rec(raw)?.orderOutcome);
  if (o === null || o.final !== true) return PENDING;
  const status = o.status === "open" || o.status === "partiallyFilled" || o.status === "filled" || o.status === "cancelled" ? o.status : null;
  const filled = plainDecimal(o.filledSize);
  if (status === null || filled === null) return PENDING;
  return { status, finality: "final", orderId: idString(o.orderId), filledSize: filled, avgPrice: null };
}

/**
 * Pacifica create response: { success, data: { order_id } } is an ack, never a status. Final
 * only with the adapter's resolved `orderOutcome` (history_by_id — PacificaAdapter.resolveOrderOutcome).
 */
function parsePacifica(raw: unknown): Parsed {
  const r = rec(raw);
  const data = rec(r?.data) ?? r;
  const orderId = idString(data?.order_id);
  const o = rec(r?.orderOutcome);
  if (o === null || o.final !== true || idString(o.orderId) !== orderId) return { ...PENDING, orderId };
  const status = o.status === "open" || o.status === "partiallyFilled" || o.status === "filled" || o.status === "cancelled" || o.status === "rejected" ? o.status : null;
  const filled = plainDecimal(o.filledSize);
  if (status === null || filled === null) return { ...PENDING, orderId };
  return { status, finality: "final", orderId, filledSize: filled, avgPrice: null };
}

// ── Wrapper ──

class LegacyTradingV2 implements TradingV2 {
  readonly name: VenueId;

  constructor(
    private readonly adapter: ExchangeAdapter,
    readonly venue: VenueDefinition,
    private readonly family: LegacyFamily,
    private readonly caps: VenueCapabilities,
    readonly network: Network,
  ) {
    this.name = venue.id;
  }

  getVenueMarkets(): Promise<VenueMarket[]> {
    return this.venue.publicData.fetchMarkets(this.network);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    validateOrderRequest(this.venue, this.caps, req);
    let r: OrderResult;
    try {
      if (req.type === "market") r = await this.placeMarket(req);
      else if (req.type === "limit") r = await this.placeLimit(req);
      else r = await this.placeStop(req);
    } catch (e) {
      // A builder-related rejection drops the cached approval and says how to proceed; never retried.
      throw builderRejectionOf(this.adapter, e);
    }
    return this.withBuilderFee(r, req.symbol);
  }

  /**
   * The builder decision the adapter applied to an order on `symbol` — the same cached
   * gate decision (builder-fee.ts), so the record matches what was sent. HL needs the
   * asset index (HIP-3 assets never carry it).
   */
  private async builderDecision(symbol: string): Promise<BuilderDecision> {
    if (builderGateOf(this.adapter) === null) return NO_BUILDER; // not configured (default): nothing to record
    if (this.family === "hyperliquid") {
      const hl = this.adapter as ExchangeAdapter & {
        builderDecision(assetIndex: number | null): Promise<BuilderDecision>;
        getAssetIndex(symbol: string): Promise<number>;
      };
      return hl.builderDecision(await hl.getAssetIndex(symbol.toUpperCase()));
    }
    return builderDecisionOf(this.adapter, { hip3: false });
  }

  /** Record execution.builderFee (+ the reason a configured fee was not attached). */
  private async withBuilderFee(r: OrderResult, symbol: string): Promise<OrderResult> {
    const d = await this.builderDecision(symbol);
    r.execution.builderFee = d.applied;
    if (d.note !== null) r.execution.notes.push(d.note);
    return r;
  }

  /** Lighter's numeric clientOrderIndex for the request (lighterClientOrderIndex rule). */
  private async lighterIndex(clientOrderId: string | null): Promise<number | undefined> {
    if (this.family !== "lighter" || clientOrderId === null) return undefined;
    const { lighterClientOrderIndex } = await import("./lighter.js");
    return lighterClientOrderIndex(clientOrderId);
  }

  /**
   * The string client order id the adapter sends, validated there before sending: Pacifica
   * `client_order_id` (full UUID), Hyperliquid `c` (128-bit hex cloid), Aster `newClientOrderId`.
   */
  private stringClientId(clientOrderId: string | null): string | undefined {
    return this.family !== "lighter" && clientOrderId !== null ? clientOrderId : undefined;
  }

  private parse(raw: unknown, size: string, step: string | null = null): Parsed {
    switch (this.family) {
      case "hyperliquid": return parseHl(raw, size, step);
      case "aster": return parseAster(raw);
      case "pacifica": return parsePacifica(raw);
      case "lighter": return parseLighter(raw);
    }
  }

  /**
   * Build the result. clientOrderId is only what the venue order carries: Lighter's
   * clientOrderIndex, Pacifica's client_order_id and Hyperliquid's cloid as the adapter sent
   * them; Aster's `clientOrderId` echoed by the venue — only when one was sent (Aster generates
   * one for every order otherwise, which perp-cli did not choose and does not report).
   * The order was sent, so a response without any id is reported (note), never thrown.
   */
  private result(req: { symbol: string; clientOrderId?: string | null }, raw: unknown, p: Parsed, execution: OrderExecution): OrderResult {
    const sent = req.clientOrderId ?? null;
    let clientOrderId: string | null = null;
    if (this.family === "lighter") clientOrderId = idString(rec(raw)?.clientOrderIndex);
    else if (this.family === "pacifica" || this.family === "hyperliquid") clientOrderId = idString(rec(raw)?.clientOrderId);
    else if (sent !== null) {
      clientOrderId = idString(rec(raw)?.clientOrderId);
      if (clientOrderId === null) execution.notes.push(`the venue response does not echo the client order id ${sent} that was sent`);
      else if (clientOrderId !== sent) execution.notes.push(`the venue echoed client order id ${clientOrderId}, not the ${sent} that was sent`);
    }
    if (p.orderId === null && clientOrderId === null) {
      execution.notes.push(`the venue response carries no order id — find the order with: perp account orders -e ${this.venue.id}`);
    }
    const r = withExecution({
      venue: this.venue.id, symbol: req.symbol, status: p.status, finality: p.finality,
      orderId: p.orderId, clientOrderId, filledSize: p.filledSize, avgPrice: p.avgPrice, venueRaw: raw,
    }, execution.method, execution);
    if (this.family === "lighter") {
      const tx = rec(raw)?.tx_hash;
      if (typeof tx === "string" && tx !== "") r.execution.notes.push(`tx hash ${tx}`);
    }
    return r;
  }

  private async placeMarket(req: OrderRequest): Promise<OrderResult> {
    if (req.slippage === null) throw new PerpError("INVALID_PARAMS", `${this.venue.displayName} market order is missing its resolved slippage bound`);
    const slippage = req.slippage;
    const opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderIndex?: number; clientOrderId?: string } = { reduceOnly: req.reduceOnly, slippage };
    const idx = await this.lighterIndex(req.clientOrderId);
    if (idx !== undefined) opts.clientOrderIndex = idx;
    const cid = this.stringClientId(req.clientOrderId);
    if (cid !== undefined) opts.clientOrderId = cid;
    const lot = await this.lotSize(req.symbol, req.size);
    const raw = await this.adapter.marketOrder(req.symbol, req.side, lot.size, opts);

    // The size is floored to the market lot before sending (HL echoes it as `raw.sentSize`):
    // the fill is judged against what was sent, with half-lot tolerance.
    const sentRaw = rec(raw)?.sentSize;
    const sent = typeof sentRaw === "string" && sentRaw !== "" ? sentRaw : lot.size;
    const parsed = this.parse(raw, sent, lot.step);
    const outcome = isIocOutcomeCapable(this.adapter) ? this.adapter.iocOutcomeOf(raw) : null;
    const p: Parsed = outcome !== null
      ? { ...parsed, status: fillStatus(sent, outcome.filledSize, lot.step), finality: "final", filledSize: outcome.filledSize }
      : { ...parsed, status: "accepted", finality: "pending", filledSize: null };
    const execution = this.marketExecution(raw, slippage);
    if (sent !== req.size && Number(sent) !== Number(req.size)) execution.notes.push(`size floored to the venue lot: sent ${sent} (requested ${req.size})`);
    if (outcome === null) execution.notes.push("the venue response does not report a final fill — verify the position before acting again");
    return this.result(req, raw, p, execution);
  }

  /** The market lot step (venue market info; unknown → throws before sending) and the size floored to it. */
  private async lotSize(symbol: string, size: string): Promise<{ step: string; size: string }> {
    const step = await lotStepOf(this.adapter, symbol);
    return { step, size: floorSize(size, step) };
  }

  private marketExecution(raw: unknown, slippage: ResolvedSlippage): OrderExecution {
    const base: OrderExecution = {
      method: "protectedIoc", slippageBps: slippage.bps, slippageSource: slippage.source,
      protectionPrice: null, referencePrice: null, tifRequested: null, tifSent: "IOC", expiresAt: null, builderFee: null, notes: [],
    };
    switch (this.family) {
      case "hyperliquid": {
        // HL marketOrder attaches the protection it sent (`raw.protection`); the venue does not echo it.
        const pr = rec(rec(raw)?.protection);
        if (pr === null) return { ...base, tifSent: "Ioc", notes: ["protection record missing from the adapter response"] };
        return {
          ...base,
          tifSent: "Ioc",
          slippageBps: typeof pr.appliedBps === "number" ? Math.round(pr.appliedBps * 100) / 100 : null,
          protectionPrice: positiveDecimal(pr.protectionPrice),
          referencePrice: positiveDecimal(pr.referencePrice),
          notes: [`reference l2Book mid; requested ${slippage.bps} bps, applied after HL price-grid rounding`],
        };
      }
      case "aster": {
        // Aster marketOrder attaches the protection it sent (`raw.protection`).
        const pr = rec(rec(raw)?.protection);
        if (pr === null) {
          return { ...base, protectionPrice: positiveDecimal(rec(raw)?.price), notes: ["protection record missing from the adapter response; slippageBps = requested bound"] };
        }
        return {
          ...base,
          slippageBps: typeof pr.appliedBps === "number" ? Math.round(pr.appliedBps * 100) / 100 : null,
          protectionPrice: positiveDecimal(pr.protectionPrice),
          referencePrice: positiveDecimal(pr.referencePrice),
          notes: [`IOC LIMIT at mark ± bound, tick-aligned toward crossing; requested ${slippage.bps} bps, applied after tick alignment`],
        };
      }
      case "pacifica":
        return {
          ...base, method: "venueSlippage", tifSent: null,
          notes: [`sent slippage_percent ${slippage.bps / 100}; Pacifica derives the protection price`],
        };
      case "lighter": {
        const pr = rec(rec(raw)?.protection);
        if (pr === null) return { ...base, notes: ["protection record missing from the adapter response"] };
        const applied = typeof pr.appliedBps === "number" ? pr.appliedBps : null;
        return {
          ...base,
          slippageBps: applied,
          protectionPrice: positiveDecimal(pr.protectionPrice),
          referencePrice: positiveDecimal(pr.referencePrice),
          notes: [`reference ${String(pr.referenceSource)}; requested ${slippage.bps} bps, applied after tick alignment`],
        };
      }
    }
  }

  /** Venue-native TIF the adapter sends for a validated TIF, and the resting-order expiry it implies. */
  private nativeTif(tif: TimeInForce): { tifSent: string; expiresAt: number | null; notes: string[] } {
    switch (this.family) {
      case "hyperliquid":
        return { tifSent: tif === "GTC" ? "Gtc" : tif === "IOC" ? "Ioc" : tif === "ALO" ? "Alo" : tif, expiresAt: null, notes: [] };
      case "aster":
        return { tifSent: tif === "ALO" || tif === "GTX" ? "GTX" : tif, expiresAt: null, notes: [] };
      case "pacifica":
        return { tifSent: tif, expiresAt: null, notes: [] };
      case "lighter":
        if (tif === "GTC" || tif === "GTT") {
          return { tifSent: "GTT", expiresAt: Date.now() + LIGHTER_GTT_EXPIRY_MS, notes: ["GTC is sent as GTT with the venue's 28-day expiry"] };
        }
        if (tif === "ALO") {
          return { tifSent: "POST_ONLY", expiresAt: Date.now() + LIGHTER_GTT_EXPIRY_MS, notes: ["ALO is sent as time-in-force POST_ONLY (2) with a 28-day expiry"] };
        }
        return { tifSent: tif, expiresAt: null, notes: [] };
    }
  }

  private async placeLimit(req: OrderRequest): Promise<OrderResult> {
    if (req.price === null || req.tif === null) throw new PerpError("INVALID_PARAMS", "limit order requires a price and a time-in-force");
    const opts: { reduceOnly: boolean; tif: string; clientOrderIndex?: number; clientOrderId?: string } = { reduceOnly: req.reduceOnly, tif: req.tif };
    const idx = await this.lighterIndex(req.clientOrderId);
    if (idx !== undefined) opts.clientOrderIndex = idx;
    const cid = this.stringClientId(req.clientOrderId);
    if (cid !== undefined) opts.clientOrderId = cid;
    const lot = await this.lotSize(req.symbol, req.size);
    const raw = await this.adapter.limitOrder(req.symbol, req.side, req.price, lot.size, opts);
    const t = this.nativeTif(req.tif);
    let parsed = this.parse(raw, lot.size, lot.step);
    if (req.tif === "IOC") {
      // IOC: the venue-final outcome when the adapter reports one (HL statuses, Lighter tx event_info).
      const outcome = isIocOutcomeCapable(this.adapter) ? this.adapter.iocOutcomeOf(raw) : null;
      if (outcome !== null) parsed = { ...parsed, status: fillStatus(lot.size, outcome.filledSize, lot.step), finality: "final", filledSize: outcome.filledSize };
    }
    const notes = [...t.notes];
    if (lot.size !== req.size && Number(lot.size) !== Number(req.size)) notes.push(`size floored to the venue lot: sent ${lot.size} (requested ${req.size})`);
    return this.result(req, raw, parsed, {
      method: "limit", slippageBps: null, slippageSource: null, protectionPrice: null, referencePrice: null,
      tifRequested: req.tif, tifSent: t.tifSent, expiresAt: t.expiresAt, builderFee: null, notes,
    });
  }

  private async placeStop(req: OrderRequest): Promise<OrderResult> {
    if (req.triggerPrice === null) throw new PerpError("INVALID_PARAMS", `${req.type} order requires a trigger price`);
    if (req.triggerSource !== null && (this.family === "hyperliquid" || this.family === "lighter")) {
      throw unsupported(this.venue.displayName, "triggerSource", "trigger orders fire on the venue's fixed price source", "Omit --trigger-type");
    }
    if (this.family !== "lighter" && req.clientOrderId !== null) {
      throw unsupported(this.venue.displayName, "stopClientOrderId", "this CLI does not send a client order id with stop orders", "Omit the client order id for stop orders");
    }
    const isMarket = req.type === "stopMarket";
    const opts: { limitPrice?: string; reduceOnly: boolean; triggerType?: "mark" | "last" | "mid"; slippage?: ResolvedSlippage; clientOrderIndex?: number } = {
      reduceOnly: req.reduceOnly,
    };
    if (req.price !== null) opts.limitPrice = req.price;
    if (req.triggerSource !== null) opts.triggerType = req.triggerSource;
    // Protection-priced market triggers (Lighter) bound the fill at trigger ± this; native triggers ignore it.
    if (req.slippage !== null) opts.slippage = req.slippage;
    const idx = await this.lighterIndex(req.clientOrderId);
    if (idx !== undefined) opts.clientOrderIndex = idx;
    const raw = await this.adapter.stopOrder(req.symbol, req.side, req.size, req.triggerPrice, opts);
    const execution: OrderExecution = {
      method: isMarket ? "trigger" : "triggerLimit", slippageBps: null, slippageSource: null, protectionPrice: null,
      referencePrice: req.triggerPrice, tifRequested: req.tif, tifSent: null, expiresAt: null, builderFee: null,
      notes: req.tif !== null ? ["trigger orders use the venue's own time-in-force"] : [],
    };
    if (isMarket) {
      const pr = this.family === "lighter" ? rec(rec(raw)?.protection) : null;
      if (pr !== null) {
        execution.slippageBps = typeof pr.appliedBps === "number" ? pr.appliedBps : null;
        execution.slippageSource = pr.slippageSource === "flag" || pr.slippageSource === "venue" || pr.slippageSource === "default" ? pr.slippageSource : null;
        execution.protectionPrice = positiveDecimal(pr.protectionPrice);
        execution.notes.push("limit IOC at trigger ± bound once triggered — a fast move through the bound can leave it unfilled");
      } else {
        execution.notes.push("venue-native market trigger (no slippage bound)");
      }
    }
    if (this.family === "lighter") {
      execution.expiresAt = Date.now() + LIGHTER_GTT_EXPIRY_MS;
    }
    if (this.family === "aster") {
      // Plain stop: Aster classifies from the trigger vs the mark/last price (venue trigger rules).
      const t = rec(raw)?.type ?? rec(raw)?.origType;
      if (typeof t === "string" && t.startsWith("TAKE_PROFIT")) {
        execution.notes.push(`sent as ${t}: the trigger is on the take-profit side of the current price (Aster fires STOP only beyond the price in the order's direction)`);
      }
    }
    return this.result(req, raw, this.parse(raw, req.size), execution);
  }

  async placeTpSlLeg(leg: TpSlLeg): Promise<OrderResult> {
    if (!(Number(leg.size) > 0)) throw new PerpError("INVALID_PARAMS", `TP/SL size must be positive (got "${leg.size}")`);
    let raw: unknown;
    if (this.family === "hyperliquid") {
      const hl = this.adapter as ExchangeAdapter & { triggerOrder: (s: string, side: "buy" | "sell", size: string, px: string, tpsl: "tp" | "sl", o: Record<string, unknown>) => Promise<unknown> };
      raw = await hl.triggerOrder(leg.symbol, leg.closeSide, leg.size, leg.trigger, leg.kind, {
        isMarket: leg.limitPrice === null, ...(leg.limitPrice !== null ? { limitPrice: leg.limitPrice } : {}), reduceOnly: true, grouping: "na",
      });
    } else {
      // Explicit kind: Aster / Lighter send the take-profit or stop-loss type as given (no
      // price-based classification); a trigger already crossed is rejected by the venue.
      raw = await this.adapter.stopOrder(leg.symbol, leg.closeSide, leg.size, leg.trigger, {
        ...(leg.limitPrice !== null ? { limitPrice: leg.limitPrice } : {}), reduceOnly: true, slippage: leg.slippage, kind: leg.kind,
      });
    }
    const execution: OrderExecution = {
      method: leg.kind === "tp" ? "takeProfitTrigger" : "stopLossTrigger", slippageBps: null, slippageSource: null,
      protectionPrice: leg.limitPrice, referencePrice: leg.trigger, tifRequested: null, tifSent: null, expiresAt: null, builderFee: null,
      notes: ["reduce-only"],
    };
    const pr = this.family === "lighter" ? rec(rec(raw)?.protection) : null;
    if (pr !== null) {
      execution.slippageBps = typeof pr.appliedBps === "number" ? pr.appliedBps : null;
      execution.slippageSource = leg.slippage.source;
      execution.protectionPrice = positiveDecimal(pr.protectionPrice);
      execution.notes.push("limit IOC at trigger ± bound once triggered — a fast move through the bound can leave it unfilled");
    } else if (leg.limitPrice === null) {
      execution.notes.push("venue-native market trigger (no slippage bound)");
    }
    const parsed = this.parse(raw, leg.size);
    if (this.family === "lighter") {
      execution.expiresAt = Date.now() + LIGHTER_GTT_EXPIRY_MS;
      // The sendTx ack is not a placement: the leg counts only with the venue-final outcome the
      // adapter resolved (stopOrder → resolveOrderOutcome: tx rejected → ORDER_REJECTED already
      // thrown; else the accountOrders row). Not final → ORDER_PENDING; cancelled → ORDER_REJECTED
      // (no protection in place); the caller reports ORDER_PARTIAL.
      const what = `${leg.kind.toUpperCase()} trigger ${leg.closeSide} ${leg.size} ${leg.symbol} @ ${leg.trigger}`;
      if (parsed.finality !== "final") {
        throw orderOutcomeUnknown(this.venue.id, what, new Error("the trigger order is not listed in accountOrders yet"),
          `Do NOT resubmit — check open orders: perp account orders -e ${this.venue.id}`);
      }
      const venueStatus = rec(rec(raw)?.orderOutcome)?.venueStatus;
      if (parsed.status === "cancelled") {
        throw new PerpError("ORDER_REJECTED", `${this.venue.displayName} ${what}: the venue cancelled the trigger order (${String(venueStatus)})`, { exchange: this.venue.id });
      }
      execution.notes.push(`venue status ${String(venueStatus)} (accountOrders / tx event_info)`);
    }
    return this.withBuilderFee(this.result({ symbol: leg.symbol }, raw, parsed, execution), leg.symbol);
  }

  async amendOrder(req: AmendRequest): Promise<OrderResult> {
    if (req.ref.kind !== "orderId") {
      throw unsupported(this.venue.displayName, "amendByClientOrderId", "orders are edited by venue order id", `Look up the order id: perp account orders -e ${this.venue.id}`);
    }
    if (this.family === "pacifica") return this.amendPacifica(req, req.ref.value);
    if (req.tif !== null) {
      throw unsupported(this.venue.displayName, "amendTimeInForce", "an edit keeps the resting order's own time-in-force / post-only", "Omit --tif");
    }
    const raw = await this.adapter.editOrder(req.symbol, req.ref.value, req.price, req.size);
    const p = this.parse(raw, req.size);
    const notes = ["size = new open (unfilled) size", "the order's TIF / post-only / reduce-only are kept"];
    if (p.orderId === null) notes.push(`the venue did not echo an order id — showing the edited order's id ${req.ref.value}`);
    return this.result({ symbol: req.symbol }, raw, { ...p, orderId: p.orderId ?? req.ref.value }, {
      method: "nativeAmend", slippageBps: null, slippageSource: null, protectionPrice: null, referencePrice: null,
      tifRequested: null, tifSent: null, expiresAt: null, builderFee: null, notes,
    });
  }

  /**
   * Pacifica: the native edit re-creates the order as ALO whatever its TIF, so the TIF is
   * kept by PacificaAdapter.amendKeepingTif (native edit only for ALO, else cancel→replace).
   */
  private async amendPacifica(req: AmendRequest, orderId: string): Promise<OrderResult> {
    const a = this.adapter as ExchangeAdapter & { amendKeepingTif?: unknown };
    if (typeof a.amendKeepingTif !== "function") {
      throw new PerpError("NOT_IMPLEMENTED", "Pacifica adapter has no TIF-preserving amend");
    }
    const { pacificaTif } = await import("./pacifica.js");
    const tif = req.tif === null ? null : pacificaTif(req.tif);
    const r = await (a as unknown as PacificaAdapter).amendKeepingTif(req.symbol, orderId, req.price, req.size, tif, req.forceTif === true);
    const notes = ["size = new open (unfilled) size", ...r.notes];
    if (r.method === "cancelReplace") {
      notes.push(`filledBeforeCancel ${r.filledBeforeCancel ?? "unknown"}, replacedSize ${r.replacedSize ?? "none"}`);
    }
    const replaced = r.method === "nativeAmend" || r.replacedSize !== null;
    let orderIdOut = r.orderId;
    if (orderIdOut === null && r.clientOrderId === null) {
      // No replacement placed (filled / nothing left): the result refers to the cancelled original.
      orderIdOut = orderId;
    }
    if (r.method === "nativeAmend" && r.orderId === null) notes.push(`the venue did not echo the new order id — find it with: perp account orders -e ${this.venue.id}`);
    // Not replaced: the original filled completely (status filled, with its fill), or it was
    // cancelled with a partial fill (partiallyFilled) / nothing (cancelled).
    const filledOut = r.filledBeforeCancel ?? "0";
    // Replaced: final only with the edited / replacement order read back (history_by_id, price / size verified).
    const o = replaced ? r.outcome : null;
    if (replaced && o === null) notes.push(`the ${r.method === "nativeAmend" ? "edited" : "replacement"} order's state was not confirmed — verify: perp account orders -e ${this.venue.id}`);
    if (o !== null) notes.push(`venue order ${o.orderId}: ${o.venueStatus} @ ${o.price ?? "?"} x ${o.size ?? "?"} (history_by_id)`);
    const status: OrderStatus = replaced ? (o !== null ? o.status : "accepted")
      : r.filledCompletely ? "filled"
        : Number(filledOut) > 0 ? "partiallyFilled" : "cancelled";
    const out = withExecution({
      venue: this.venue.id, symbol: req.symbol, status, finality: replaced && o === null ? "pending" : "final",
      orderId: orderIdOut, clientOrderId: r.clientOrderId, filledSize: replaced ? (o !== null ? o.filledSize : null) : filledOut, avgPrice: null, venueRaw: r.venueRaw,
    }, r.method, { tifRequested: req.tif, tifSent: replaced ? r.tif : null, notes });
    // Only a cancel→replace places a new order (createLimitOrder carries builder_code); a native edit does not.
    return r.method === "cancelReplace" && r.replacedSize !== null ? this.withBuilderFee(out, req.symbol) : out;
  }

  /**
   * Cancel one order. `cancelled` only with per-order proof from the venue result:
   * HL statuses[0] "success"; Aster the order object with status CANCELED for that id;
   * Pacifica `success: true` for the single-order request; Lighter the cancel tx EXECUTED.
   * A definite refusal → `failed`; anything else → `pending` with a remediation.
   */
  async cancelByRef(symbol: string, ref: OrderRef, listedType: string | null = null): Promise<CancelResult> {
    if (this.family === "pacifica" && ref.kind === "clientOrderId") return this.cancelPacificaByClientId(symbol, ref);
    if (this.family === "lighter" && ref.kind === "clientOrderId") return this.cancelLighterByClientId(symbol, ref);
    // Pacifica stop / TP / SL orders (incl. the position-level TP/SL that `--tp/--sl` and `trade tpsl`
    // create: order_type take_profit_market / stop_loss_market, price 0, amount 0) are cancelled on
    // POST /orders/stop/cancel (cancel_stop_order); /orders/cancel refuses them with 422 "Failed to
    // cancel order" (live testnet 2026-10-02). `listedType` = the order_type from the open-orders listing.
    // No listed type given (`trade cancel <symbol> <id>`): read it from the open orders, so a
    // stop / TP / SL id is routed to the stop-cancel endpoint too. A failed read throws (nothing sent).
    if (this.family === "pacifica" && listedType === null) {
      const listed = (await this.freshOpenOrders()).find(o => o.orderId === ref.value);
      if (listed !== undefined) listedType = listed.type;
    }
    const pacStop = this.family === "pacifica" && listedType !== null && isPacificaStopType(listedType);
    // Lighter: an order index above 2^53 is refused by the adapter (INVALID_PARAMS), never cancel-all.
    let raw: unknown;
    let refusal: PacificaCancelRefusal | null = null;
    try {
      if (ref.kind === "clientOrderId") {
        // Native cancel by client order id: HL `cancelByCloid`, Aster DELETE /fapi/v3/order origClientOrderId.
        raw = this.family === "hyperliquid"
          ? await (this.adapter as ExchangeAdapter & { cancelByCloid(symbol: string, cloid: string): Promise<unknown> }).cancelByCloid(symbol, ref.value)
          : await (this.adapter as ExchangeAdapter & { cancelOrderByClientId(symbol: string, id: string): Promise<unknown> }).cancelOrderByClientId(symbol, ref.value);
      } else {
        raw = pacStop
          ? await (this.adapter as ExchangeAdapter & { cancelStopOrder(symbol: string, orderId: string): Promise<unknown> }).cancelStopOrder(symbol, ref.value)
          : await this.adapter.cancelOrder(symbol, ref.value);
      }
    } catch (e) {
      // Pacifica HTTP 4xx (e.g. 422 "Failed to cancel order" code 5 for an already-filled order):
      // a definite refusal of THIS request — settled from the order's history_by_id, never "cancelled".
      if (this.family !== "pacifica" || !pacificaRefused(e)) throw e;
      raw = { error: e instanceof Error ? e.message : String(e) };
      // RATE_LIMITED with sent:false (local throttle or HTTP 429): this cancel was not executed —
      // failed (nothing cancelled), no history read needed. Unknown-after-send never lands here.
      refusal = isPacificaRateLimited(e)
        ? { kind: "failed", error: `cancel of ${ref.value} not executed (rate limited, nothing sent / refused): ${e instanceof Error ? e.message : String(e)}` }
        : await (this.adapter as unknown as PacificaAdapter).cancelRefusalOutcome(ref.value, e);
    }
    const out = (v: "cancelled" | "pending" | { error: string }, reason = ""): CancelResult => {
      if (v === "cancelled") return { venue: this.venue.id, cancelled: [ref], failed: [], pending: [], venueRaw: raw };
      if (v === "pending") {
        return {
          venue: this.venue.id, cancelled: [], failed: [], venueRaw: raw,
          pending: [{ ref, reason, remediation: `Verify before acting again: perp account orders -e ${this.venue.id}` }],
        };
      }
      return { venue: this.venue.id, cancelled: [], failed: [{ ref, error: v.error }], pending: [], venueRaw: raw };
    };
    const r = rec(raw);
    switch (this.family) {
      case "hyperliquid": {
        // Per-entry {error} already threw ORDER_REJECTED in the adapter.
        const st = rec(rec(r?.response)?.data)?.statuses;
        return Array.isArray(st) && st[0] === "success" ? out("cancelled") : out("pending", "the venue response carries no per-order \"success\"");
      }
      case "aster":
        return r !== null && r.status === "CANCELED" && idString(ref.kind === "orderId" ? r.orderId : r.clientOrderId) === ref.value
          ? out("cancelled") : out("pending", "the venue response does not show this order CANCELED");
      case "pacifica":
        if (refusal !== null) return refusal.kind === "failed" ? out({ error: refusal.error }) : out("pending", refusal.reason);
        if (r !== null && (r.success === false || (typeof r.error === "string" && r.error !== ""))) return out({ error: String(r.error ?? "cancel rejected") });
        return r !== null && r.success === true ? out("cancelled") : out("pending", "the venue response carries no success flag");
      case "lighter": {
        const lt = this.adapter as ExchangeAdapter & {
          awaitTxExecuted: (r: unknown, what: string) => Promise<void>;
          cancelOutcome: (r: unknown, symbol: string, orderId: string) => Promise<"cancelled" | "filled" | "open" | null>;
        };
        if (ref.kind !== "orderId") throw new PerpError("INVALID_PARAMS", "unreachable: a Lighter client order id is resolved to its order id first");
        try {
          await lt.awaitTxExecuted(raw, `cancel ${ref.value} ${symbol}`);
        } catch (e) {
          if (e instanceof PerpError && e.structured.code === "ORDER_REJECTED") return out({ error: e.message });
          return out("pending", e instanceof Error ? e.message : String(e));
        }
        // Tx executed: confirm the order itself is canceled / gone (accountOrders / open orders).
        const st = await lt.cancelOutcome(raw, symbol, ref.value);
        if (st === "cancelled") return out("cancelled");
        if (st === "filled") return out({ error: `order ${ref.value} filled before the cancel` });
        return out("pending", st === "open" ? "cancel tx executed but the order is still listed open" : "cancel tx executed but the order's canceled state could not be read");
      }
    }
  }

  /**
   * Pacifica cancel by client order id (docs.pacifica.fi rest-api orders/cancel-order:
   * `order_id` "required (if no CLOID)", `client_order_id` "Full UUID string, required (if no OID)").
   * The id is resolved to the venue order id from GET /orders (rows carry `client_order_id`), then
   * cancelled through the per-order path above — same stop routing and per-order proof — and
   * reported under the client reference the caller gave. Not open → ORDER_NOT_FOUND (nothing sent).
   */
  private async cancelPacificaByClientId(symbol: string, ref: OrderRef): Promise<CancelResult> {
    const pac = this.adapter as unknown as PacificaAdapter;
    const found = await pac.orderByClientId(ref.value);
    if (found === null || !found.open) {
      throw new PerpError("ORDER_NOT_FOUND", `Pacifica has no open order with client order id ${ref.value}${found !== null ? ` (order ${found.orderId} is no longer open)` : ""}`, {
        exchange: "pacifica", remediation: "List open orders: perp account orders -e pacifica",
      });
    }
    const r = await this.cancelByRef(symbol, { kind: "orderId", value: found.orderId }, found.type);
    const mine = <T extends { ref: OrderRef | null }>(x: T): T => ({ ...x, ref });
    return { ...r, cancelled: r.cancelled.map(() => ref), failed: r.failed.map(mine), pending: (r.pending ?? []).map(mine) };
  }

  /**
   * Lighter / Lighter RH cancel by client order index. lighter-go L2CancelOrderTxInfo: `Index int64
   * // Client Order Index or Order Index of the order to cancel` (client indexes 1..2^48 − 1, order
   * indexes above). The index is resolved to the order's row (accountOrders?client_order_indexes —
   * LighterAdapter.orderStatusRow) and cancelled through the per-order path above (the cancel is
   * signed with that client index — lighterOrderSignIndex — and proven by the tx + the order's
   * final state), reported under the client reference the caller gave. Not listed / not open →
   * ORDER_NOT_FOUND (nothing sent).
   */
  private async cancelLighterByClientId(symbol: string, ref: OrderRef): Promise<CancelResult> {
    const { lighterOrderIdOf } = await import("./lighter.js");
    const lt = this.adapter as ExchangeAdapter & { orderStatusRow(symbol: string, ref: OrderRef): Promise<Record<string, unknown>> };
    const row = await lt.orderStatusRow(symbol, ref);
    const orderId = lighterOrderIdOf(row);
    if (orderId === "") {
      throw new PerpError("EXCHANGE_ERROR", `${this.venue.displayName} order row for client order index ${ref.value} carries no order id; nothing was cancelled`, {
        exchange: this.venue.id, remediation: `List open orders: perp account orders -e ${this.venue.id}`,
      });
    }
    // Open or not is decided by the per-order path: an order no longer among the market's active
    // orders → ORDER_NOT_FOUND there (LighterAdapter.activeOrderRow), nothing sent.
    const r = await this.cancelByRef(symbol, { kind: "orderId", value: orderId });
    const mine = <T extends { ref: OrderRef | null }>(x: T): T => ({ ...x, ref });
    return { ...r, cancelled: r.cancelled.map(() => ref), failed: r.failed.map(mine), pending: (r.pending ?? []).map(mine) };
  }

  /**
   * Pacifica per-order status: the order's `/orders/history_by_id` rows (PacificaAdapter.orderStatusById).
   * A client order id is first resolved to the venue order id (orderByClientId: open orders, then
   * the latest order-history page). Rows that prove no state yet → accepted / pending.
   */
  private async pacificaOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    const pac = this.adapter as unknown as PacificaAdapter;
    let orderId = ref.value;
    let listedSymbol: string | null = null;
    if (ref.kind === "clientOrderId") {
      const found = await pac.orderByClientId(ref.value);
      if (found === null) {
        throw new PerpError("ORDER_NOT_FOUND", `Pacifica has no order with client order id ${ref.value} among the open orders and the latest order-history page`, {
          exchange: "pacifica", remediation: "Query by venue order id instead: perp trade status <orderId> -e pacifica (ids: perp account orders / perp history orders -e pacifica)",
        });
      }
      orderId = found.orderId;
      listedSymbol = found.symbol;
    }
    const st = await pac.orderStatusById(orderId);
    const o = st.outcome;
    return withExecution({
      venue: this.venue.id, symbol: listedSymbol ?? symbol, status: o === null ? "accepted" : o.status, finality: o === null ? "pending" : "final",
      orderId, clientOrderId: ref.kind === "clientOrderId" ? ref.value : st.clientOrderId,
      filledSize: o === null ? null : o.filledSize, avgPrice: null, venueRaw: st.venueRaw,
    }, "statusQuery", { notes: [o === null ? "history_by_id shows no settled row for this order yet" : `venue status "${o.venueStatus}" (history_by_id)`] });
  }

  /** Open orders read live: drops the adapter's in-process snapshot first (Aster keeps a 5s one). */
  private async freshOpenOrders() {
    const a = this.adapter as ExchangeAdapter & { invalidateOpenOrdersCache?: () => void };
    if (typeof a.invalidateOpenOrdersCache === "function") a.invalidateOpenOrdersCache();
    return this.adapter.getOpenOrders();
  }

  /**
   * Cancel every open order (of `symbol`): one cancelByRef per order listed open now, so each
   * result carries per-order proof. Afterwards the open orders are re-listed live: any order
   * still open is reported `pending` (never `cancelled`), whatever the per-order result said.
   * Orders placed after the first listing and still open at the re-list are reported pending too.
   */
  async cancelAllV2(symbol: string | null): Promise<CancelResult> {
    const norm = (s: string) => s.toUpperCase().replace(/-PERP$/, "");
    const inScope = (o: { symbol: string }) => symbol === null || norm(o.symbol) === norm(symbol);
    const remediation = `Verify before acting again: perp account orders -e ${this.venue.id}`;
    const targets = (await this.freshOpenOrders()).filter(inScope);
    const res: Required<CancelResult> = { venue: this.venue.id, cancelled: [], failed: [], pending: [], venueRaw: [] as unknown[] };
    for (const o of targets) {
      const ref: OrderRef = { kind: "orderId", value: o.orderId };
      try {
        const r = await this.cancelByRef(o.symbol, ref, o.type);
        res.cancelled.push(...r.cancelled);
        res.failed.push(...r.failed);
        res.pending.push(...(r.pending ?? []));
        (res.venueRaw as unknown[]).push(r.venueRaw);
      } catch (e) {
        if (e instanceof PerpError && (e.structured.code === "ORDER_REJECTED" || e.structured.code === "INVALID_PARAMS")) {
          res.failed.push({ ref, error: e.message });
        } else {
          res.pending.push({ ref, reason: e instanceof Error ? e.message : String(e), remediation });
        }
      }
    }
    if (targets.length === 0) return res;

    // Verify: re-list live. A read failure leaves every "cancelled" unconfirmed (pending), not assumed.
    // A venue's open-orders list can lag its own cancel ack (Pacifica mainnet listed an order whose
    // cancel had returned success for ~1 s): re-list a few times before calling an acked cancel pending.
    let stillOpen: string[];
    try {
      const acked = new Set(res.cancelled.map(ref => ref.value));
      for (let attempt = 0; ; attempt++) {
        stillOpen = (await this.freshOpenOrders()).filter(inScope).map(o => o.orderId);
        if (attempt >= CANCEL_ALL_RELIST_RETRIES || !stillOpen.some(id => acked.has(id))) break;
        await new Promise(r => setTimeout(r, CANCEL_ALL_RELIST_DELAY_MS));
      }
    } catch (e) {
      const reason = `post-cancel open-orders re-list failed: ${e instanceof Error ? e.message : String(e)}`;
      res.pending.push(...res.cancelled.map(ref => ({ ref, reason, remediation })));
      res.cancelled = [];
      return res;
    }
    // Every order of the first listing already has an outcome (cancelled / failed / pending);
    // only orders NOT in it are "not covered". (Excluding the cancelled ones here reported an
    // order acked-cancelled-but-still-open twice, once with the wrong "not covered" reason.)
    const known = new Set(targets.map(o => o.orderId));
    const open = new Set(stillOpen);
    const confirmed = res.cancelled.filter(ref => !open.has(ref.value));
    for (const ref of res.cancelled) {
      if (open.has(ref.value)) res.pending.push({ ref, reason: "still listed open after the cancel", remediation });
    }
    res.cancelled = confirmed;
    for (const id of stillOpen) {
      if (!known.has(id)) {
        res.pending.push({ ref: { kind: "orderId", value: id }, reason: "still listed open after cancel-all (not covered by the first listing)", remediation });
      }
    }
    return res;
  }

  async applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult> {
    if (marginMode !== null && !this.caps.marginModes.includes(marginMode)) {
      throw unsupported(this.venue.displayName, `${marginMode}Margin`, `${marginMode} margin is not offered`, `Use one of: ${this.caps.marginModes.join(", ")}`);
    }
    // No mode given: the legacy setLeverage calls send a margin mode with every leverage update
    // (HL / Pacifica / Lighter would apply cross), which could silently switch an isolated
    // position. The current mode is not read back uniformly, so an explicit mode is required —
    // unless the venue offers a single mode (nothing to switch).
    let mode: "cross" | "isolated";
    if (marginMode !== null) mode = marginMode;
    else if (this.caps.marginModes.length === 1) mode = this.caps.marginModes[0];
    else {
      throw new PerpError("INVALID_PARAMS", `${this.venue.displayName}: a leverage update without a margin mode could switch the symbol's current mode; pass cross or isolated explicitly`, {
        remediation: `Pass the margin mode: one of ${this.caps.marginModes.join(", ")}`,
      });
    }
    const raw = await this.adapter.setLeverage(symbol, leverage, mode);
    return { venue: this.venue.id, symbol, leverage, marginMode: mode, venueRaw: raw };
  }

  /**
   * Lighter / Lighter RH per-order status from the venue's order row (LighterAdapter.orderStatusRow:
   * accountOrders by client order index, or the market's active / inactive orders by order id).
   * Status and fill come only from the row's `status` / `filled_base_amount` (lighterRowOutcomeOf);
   * a row that is not final yet (in-progress) or carries no readable fill → accepted / pending.
   */
  private async lighterOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    const { lighterRowOutcomeOf, lighterOrderIdOf } = await import("./lighter.js");
    const lt = this.adapter as ExchangeAdapter & { orderStatusRow(symbol: string, ref: OrderRef): Promise<Record<string, unknown>> };
    const row = await lt.orderStatusRow(symbol, ref);
    const id = lighterOrderIdOf(row);
    const orderId = id === "" ? null : id;
    const out = lighterRowOutcomeOf(row, orderId);
    const clientOrderId = idString(row.client_order_id) ?? idString(row.client_order_index);
    const venueStatus = typeof row.status === "string" ? row.status : String(row.status);
    return withExecution({
      venue: this.venue.id, symbol, status: out === null ? "accepted" : out.status, finality: out === null ? "pending" : "final",
      orderId, clientOrderId: clientOrderId === "0" ? null : clientOrderId,
      filledSize: out === null ? null : out.filledSize, avgPrice: null, venueRaw: row,
    }, "statusQuery", { notes: [`venue status "${venueStatus}"`] });
  }

  async getOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    if (this.family === "lighter") return this.lighterOrderStatus(symbol, ref);
    if (this.family === "pacifica") return this.pacificaOrderStatus(symbol, ref);
    if (this.family === "aster") return this.asterOrderStatus(symbol, ref);
    if (this.family !== "hyperliquid" || !isQueryOrderCapable(this.adapter)) {
      throw unsupported(this.venue.displayName, "orderStatus", "the adapter has no single-order status query",
        `List orders and positions: perp account orders -e ${this.venue.id} / perp account positions -e ${this.venue.id}`);
    }
    if (ref.kind === "orderId" && !/^\d+$/.test(ref.value)) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid order status needs a numeric order id or c:<cloid> (got ${ref.value})`);
    }
    // info orderStatus `oid`: "Either u64 representing the order id or 16-byte hex string representing the client order id".
    const label = ref.kind === "orderId" ? ref.value : `c:${ref.value}`;
    const raw = await this.adapter.queryOrder(ref.kind === "orderId" ? Number(ref.value) : ref.value);
    const r = rec(raw);
    if (r?.status === "unknownOid") {
      throw new PerpError("ORDER_NOT_FOUND", `Hyperliquid order ${label} not found`, { exchange: "hyperliquid" });
    }
    const wrap = rec(r?.order);
    const o = rec(wrap?.order);
    const st = wrap?.status;
    if (r?.status !== "order" || o === null || typeof st !== "string") {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid orderStatus ${label}: unexpected response shape`, { exchange: "hyperliquid" });
    }
    const orig = plainDecimal(o.origSz);
    const left = plainDecimal(o.sz);
    let filled: string | null = null;
    if (orig !== null && left !== null) {
      const dec = Math.max((orig.split(".")[1] ?? "").length, (left.split(".")[1] ?? "").length);
      filled = (Number(orig) - Number(left)).toFixed(dec);
    }
    let status: OrderStatus;
    let finality: "final" | "pending" = "final";
    if (st === "open") status = filled !== null && Number(filled) > 0 ? "partiallyFilled" : "open";
    else if (st === "filled") status = "filled";
    else if (st === "rejected" || st.endsWith("Rejected")) status = "rejected";
    else if (st === "canceled" || st.endsWith("Canceled")) status = "cancelled";
    else { status = "accepted"; finality = "pending"; }
    const orderId = idString(o.oid);
    if (orderId === null && ref.kind === "clientOrderId") {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid orderStatus ${label}: the order row carries no oid`, { exchange: "hyperliquid" });
    }
    const cloid = typeof o.cloid === "string" && o.cloid !== "" ? o.cloid : null;
    return withExecution({
      // No --symbol is needed for a cloid query (orderStatus is per user): the row's coin names the market.
      venue: this.venue.id, symbol: symbol !== "" ? symbol : String(o.coin ?? ""), status, finality,
      orderId: orderId ?? ref.value, clientOrderId: cloid,
      filledSize: filled, avgPrice: null, venueRaw: raw,
    }, "statusQuery", { notes: filled === null ? [`venue status "${st}"; filled size not reported`] : [`venue status "${st}"`] });
  }

  /**
   * Aster per-order status from GET /fapi/v3/order (AsterAdapter.queryOrderRow: by orderId or
   * origClientOrderId). Status / fill only from the row's `status` / `executedQty` (parseAster);
   * an unmapped status or unreadable executedQty → accepted / pending.
   */
  private async asterOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    const ast = this.adapter as ExchangeAdapter & { queryOrderRow(symbol: string, ref: OrderRef): Promise<Record<string, unknown>> };
    const row = await ast.queryOrderRow(symbol, ref);
    const p = parseAster(row);
    const clientOrderId = idString(row.clientOrderId);
    return withExecution({
      venue: this.venue.id, symbol, status: p.status, finality: p.finality,
      orderId: p.orderId ?? (ref.kind === "orderId" ? ref.value : null),
      clientOrderId: ref.kind === "clientOrderId" ? clientOrderId ?? ref.value : clientOrderId,
      filledSize: p.filledSize, avgPrice: p.avgPrice, venueRaw: row,
    }, "statusQuery", { notes: [`venue status "${String(row.status)}" (GET /fapi/v3/order)`] });
  }
}
