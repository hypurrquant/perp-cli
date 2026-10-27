import { Command } from "commander";
import { networkOf, supportsDryRun } from "../cli-flags.js";
import type { ExchangeAdapter, ExchangePosition } from "../exchanges/index.js";
import { printJson, errorAndExit, withJsonErrors, jsonOk, jsonError, symbolMatch, formatUsd, formatOrderResult, orderResultJson, normalizeSymbolArg } from "../utils.js";
import { ERROR_CODES, extractErrorMessage, isDefiniteOrderFailure, parsePositiveDecimal, PerpError, type ErrorCode } from "../errors.js";
import { logExecution } from "../execution-log.js";
import { validateTrade, enforceOrderRisk } from "../trade-validator.js";
import { generateClientId, logClientId, isOrderDuplicate } from "../client-id-tracker.js";
import { smartOrder } from "../smart-order.js";
import { invalidateCache } from "../cache.js";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified } from "../bot/perp-order.js";
import { iocLotTolerance, isIocOutcomeCapable } from "../exchanges/ioc-outcome.js";
import { quarantineEntryFor, quarantineSymbol } from "../bot/quarantine.js";
import { fillSizeString, sizeDecimalsOf } from "../exchanges/spot-result.js";
import chalk from "chalk";
import { hasPacificaSdk, isTwapCapable, isQueryOrderCapable } from "../exchanges/capabilities.js";
import { getVenue, listVenuesWithRole, requireCapabilities, roleUnsupported, tryResolveVenueId, type VenueCapabilities, type VenueDefinition } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";
import { isTradingV2, newVenueClientOrderId, placeAndConfirm, reduceOnlyGateOf, stopOrderGateOf, unsupported, validateLegacyTif, validateOrderRequest, type PlacedOrder, type TradingV2 } from "../exchanges/trading-v2.js";
import { placeTpSlLeg, tradingV2Of } from "../exchanges/legacy-trading-v2.js";
import type { AsterAdapter } from "../exchanges/aster.js";
import type { PacificaAdapter } from "../exchanges/pacifica.js";
import { PACIFICA_UUID_RE } from "../exchanges/venues/pacifica.js";
import { HL_CLOID_RE } from "../exchanges/venues/hyperliquid.js";
import { ASTER_CLIENT_ID_RE } from "../exchanges/venues/aster.js";
import { parseOrderRef, type CancelResult, type Network, type OrderExecution, type OrderRef, type OrderRequest, type OrderResult, type TimeInForce } from "../exchanges/venue-types.js";
import { resolveAdapterSlippage, resolveSlippage, type ResolvedSlippage } from "../exchanges/slippage.js";
import { exactUnits, floorSize, floorToStep, lotStepOf, unitsToString } from "../exchanges/precision.js";
import type { VenueSpotDefinition } from "../exchanges/venue.js";
import { isSpotOpenOrdersCapable, type SpotAdapter, type SpotOrderResult } from "../exchanges/spot-interface.js";
import { builderPlanFor } from "../exchanges/builder-fee.js";
import { registerPacificaOrderCommands } from "./pacifica-orders.js";
import { HL_MIN_ORDER_VALUE_USD } from "../constants.js";
import { defaultSpotQuote, readSpotQuoteAvailableFresh, requireSpotAdapter, requireSpotDefinition, transferQuoteToPerp, transferQuoteToSpot, transferShortfallError } from "../exchanges/spot-factory.js";

// ── Uniform order surface ──
//
// Every venue's trade market/buy/sell/limit/stop/edit/cancel goes through TradingV2:
// native on ondo/arcus, the legacy wrapper (exchanges/legacy-trading-v2.ts) on
// pacifica/hyperliquid/lighter/lighter-rh/aster. One default TIF (GTC), one result
// shape (OrderResult + execution), one printer.

/** Families with the legacy smart-order path (--smart: IOC at best book ± 1 tick). */
const LEGACY_ORDER_FAMILIES: ReadonlySet<VenueDefinition["family"]> = new Set(["pacifica", "hyperliquid", "lighter", "aster"]);

/** Common default time-in-force for every venue (venues map GTC internally, e.g. GTT). */
const DEFAULT_TIF = "GTC";

function tradingVenueOf(adapter: ExchangeAdapter): { def: VenueDefinition; caps: VenueCapabilities } {
  const def = getVenue(adapter.name);
  return { def, caps: requireCapabilities(def) };
}

function isLegacyOrderVenue(def: VenueDefinition): boolean {
  return LEGACY_ORDER_FAMILIES.has(def.family);
}

export function parseSlippageBpsFlag(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new PerpError("INVALID_PARAMS", `--slippage-bps must be a positive number (got "${raw}")`);
  return n;
}

/**
 * Client-order-id format accepted by each venue with client order ids. Arcus: 1–36 chars of
 * [A-Za-z0-9_-] minus 3 so the "-tp"/"-sl" TP/SL leg suffix always fits;
 * Ondo: 1–64 chars of [A-Za-z0-9_-]; Lighter(-RH): numeric clientOrderIndex (range
 * checked by the adapter); Pacifica: a full UUID (docs.pacifica.fi create-limit-order:
 * `client_order_id` "Full UUID string"); Hyperliquid: a 128-bit cloid, "0x" + 32 hex (HL_CLOID_RE);
 * Aster: `newClientOrderId` ^[.A-Z:/a-z0-9_-]{1,36}$ (ASTER_CLIENT_ID_RE). Venues without client ids refuse --client-id / --auto-id
 * (v2ClientOrderId) — an id is never accepted and then dropped.
 */
const V2_CLIENT_ID_RULES: Readonly<Partial<Record<VenueDefinition["id"], { re: RegExp; desc: string }>>> = {
  arcus: { re: /^[A-Za-z0-9_-]{1,33}$/, desc: "1-33 chars of A-Z a-z 0-9 _ -" },
  ondo: { re: /^[A-Za-z0-9_-]{1,64}$/, desc: "1-64 chars of A-Z a-z 0-9 _ -" },
  lighter: { re: /^[1-9][0-9]{0,14}$/, desc: "a decimal integer from 1 to 2^48 - 1" },
  "lighter-rh": { re: /^[1-9][0-9]{0,14}$/, desc: "a decimal integer from 1 to 2^48 - 1" },
  pacifica: { re: PACIFICA_UUID_RE, desc: "a full UUID, e.g. f47ac10b-58cc-4372-a567-0e02b2c3d479" },
  hyperliquid: { re: HL_CLOID_RE, desc: "a 128-bit hex cloid: 0x + 32 lowercase hex chars, e.g. 0x1234567890abcdef1234567890abcdef (or --auto-id)" },
  aster: { re: ASTER_CLIENT_ID_RE, desc: "1-36 chars of A-Z a-z 0-9 . : / _ -" },
  // uint64 decimal (range checked by the adapter).
  risex: { re: /^[1-9][0-9]{0,19}$/, desc: "a decimal integer from 1 to 2^64 - 1" },
  // docs (order `c`): any string up to 64 bytes; the "0x" prefix is reserved.
  txflow: { re: /^(?!0[xX])[A-Za-z0-9._:-]{1,64}$/, desc: "1-64 chars of A-Z a-z 0-9 . _ : - (not starting with 0x)" },
};

/**
 * Venues whose client order ids perp-cli GENERATES and never takes from the user: QFEX ids are
 * not unique on the venue, so a reused id would attribute another order's fills / cancels to
 * this one (c). --auto-id still works (the generated id is reported).
 */
const GENERATED_CLIENT_ID_ONLY: ReadonlySet<VenueDefinition["id"]> = new Set(["qfex"]);

function validateV2ClientId(def: VenueDefinition, id: string): void {
  if (GENERATED_CLIENT_ID_ONLY.has(def.id)) {
    throw unsupported(def.displayName, "clientOrderId",
      "client order ids are not unique on the venue, so perp-cli only correlates orders by ids it generates",
      `Omit --client-id on ${def.id} (use --auto-id, or nothing — the generated id is reported and works with: perp trade status c:<id> --symbol <S> -e ${def.id})`);
  }
  const rule = V2_CLIENT_ID_RULES[def.id];
  if (rule === undefined) {
    throw unsupported(def.displayName, "clientOrderId", "no client-order-id format rule for this venue", "Omit --client-id / --auto-id");
  }
  if (!rule.re.test(id)) {
    throw new PerpError("INVALID_PARAMS", `Client order id "${id}" is not valid on ${def.displayName} (${rule.desc})`);
  }
}

/**
 * Venue client order id: the caller's --client-id/--auto-id (validated); else a generated id
 * for async-ack venues; else null. A venue whose orders carry no client id through this CLI
 * refuses a caller id up front (CAPABILITY_UNSUPPORTED, nothing sent):
 * the order would be placed without it and `trade status c:<id>` / `trade cancel c:<id>` could
 * never find it.
 */
function v2ClientOrderId(def: VenueDefinition, caps: VenueCapabilities, userId: string | undefined): string | null {
  if (!caps.clientOrderId) {
    if (userId !== undefined) {
      throw unsupported(def.displayName, "clientOrderId", "orders on this venue carry no client order id through perp-cli, so the id would be dropped",
        `Omit --client-id / --auto-id on ${def.id} and use the venue order id the result reports (perp trade status <orderId> -e ${def.id})`);
    }
    return null;
  }
  if (userId !== undefined) {
    validateV2ClientId(def, userId);
    return userId;
  }
  return caps.orderAck === "async" ? newVenueClientOrderId(def) : null;
}

/**
 * --auto-id: venue-format id where the venue has client ids; a venue without them refuses it
 * (v2ClientOrderId — the locally generated id is never sent).
 * Ondo / Pacifica limit orders: undefined — the adapter generates its own id, which encodes
 * post-only (Ondo) / the TIF (Pacifica) for a later edit; the result
 * reports that id. A Pacifica market order has no generated id, so --auto-id sends a UUID.
 * Generated-only venues (qfex): undefined — v2ClientOrderId generates the venue id itself.
 */
function autoClientId(def: VenueDefinition, caps: VenueCapabilities, orderType: "market" | "limit"): string | undefined {
  if (def.id === "ondo" || GENERATED_CLIENT_ID_ONLY.has(def.id)) return undefined;
  if (def.id === "pacifica" && orderType === "limit") return undefined;
  return caps.clientOrderId ? newVenueClientOrderId(def) : generateClientId();
}

/** Validated market-order request (`slippage` = resolveSlippage() output). */
function v2MarketRequest(def: VenueDefinition, caps: VenueCapabilities, symbol: string, side: "buy" | "sell", size: string, reduceOnly: boolean, slippage: ResolvedSlippage, clientId: string | undefined): OrderRequest {
  const req: OrderRequest = {
    symbol, side, type: "market", size, price: null, triggerPrice: null, triggerSource: null, tif: null,
    reduceOnly,
    clientOrderId: v2ClientOrderId(def, caps, clientId),
    slippage,
    tpsl: null,
  };
  validateOrderRequest(def, caps, req);
  return req;
}

/**
 * placeAndConfirm() plus the CLI notice for adapter-side size flooring
 * (venueRaw.requestedSize/placedSize, Arcus) on stderr.
 */
async function placeV2(v2: TradingV2, caps: VenueCapabilities, req: OrderRequest): Promise<PlacedOrder> {
  const result = await placeAndConfirm(v2, caps, req);
  const raw = result.venueRaw as { requestedSize?: unknown; placedSize?: unknown } | null;
  if (raw !== null && typeof raw === "object" && typeof raw.requestedSize === "string" && typeof raw.placedSize === "string") {
    console.error(chalk.yellow(`  Notice: size ${raw.requestedSize} was floored to the venue step → ${raw.placedSize} placed`));
  }
  return result;
}

/** Unified human output for an order result (every venue). */
function printOrder(header: string, r: OrderResult & { remediation?: string | null }): void {
  console.log(chalk.green(`\n  ${header}`));
  for (const line of formatOrderResult(r)) console.log(line);
  console.log();
}

/** Unified human output for a CancelResult. */
function printCancel(r: CancelResult, symbol: string): void {
  const refText = (ref: OrderRef) => (ref.kind === "clientOrderId" ? `c:${ref.value}` : ref.value);
  const pending = r.pending ?? [];
  if (r.cancelled.length > 0) {
    console.log(chalk.green(`\n  Cancelled on ${r.venue} (${symbol}): ${r.cancelled.map(refText).join(", ")}`));
  } else if (r.failed.length === 0 && pending.length === 0) {
    console.log(chalk.yellow(`\n  No order cancelled on ${r.venue} (${symbol}).`));
  } else {
    console.log();
  }
  for (const f of r.failed) {
    console.log(chalk.red(`  ✗ ${f.ref !== null ? refText(f.ref) : symbol}: ${f.error}`));
  }
  for (const p of pending) {
    console.log(chalk.yellow(`  ? ${p.ref !== null ? refText(p.ref) : symbol}: cancel PENDING — ${p.reason}. ${p.remediation}`));
  }
  console.log();
}

/**
 * A cancel with anything not proven cancelled (failed, or pending / still listed open after the
 * verifying re-list) → ORDER_PARTIAL carrying the whole result (non-zero exit, also in --json);
 * all failed (none cancelled, none pending) → ORDER_REJECTED (definitely nothing cancelled).
 */
export function cancelIncompleteError(r: CancelResult, scope: string): PerpError | null {
  const pending = r.pending ?? [];
  if (r.failed.length === 0 && pending.length === 0) return null;
  if (r.cancelled.length === 0 && pending.length === 0) {
    // Every order definitely NOT cancelled (venue refusal confirmed by the order's own state, e.g.
    // already filled): a definite rejection — nothing changed on the venue.
    return new PerpError("ORDER_REJECTED", `${r.venue} cancel (${scope}) refused: ${r.failed.map(f => f.error).join("; ")}`, {
      exchange: r.venue, cancelled: r.cancelled, failed: r.failed, pending, legacy: r.venueRaw,
      remediation: `Nothing was cancelled — check open orders: perp account orders -e ${r.venue}`,
    });
  }
  return new PerpError("ORDER_PARTIAL",
    `${r.venue} cancel (${scope}): ${r.cancelled.length} confirmed cancelled, ${r.failed.length} failed, ${pending.length} pending / still open`, {
      exchange: r.venue, cancelled: r.cancelled, failed: r.failed, pending, legacy: r.venueRaw,
      remediation: `Check open orders before acting again: perp account orders -e ${r.venue}`,
    });
}

/** JSON extra: the locally tracked CLI client id when the venue order does not carry it. */
function trackedId(r: OrderResult, clientId: string | undefined): Record<string, unknown> | undefined {
  return clientId !== undefined && r.clientOrderId !== clientId ? { trackedClientId: clientId } : undefined;
}

/**
 * Close / flatten / reduce / stop and the `--tp/--sl` / `trade tpsl` legs are reduce-only orders.
 * A venue whose reduce-only orders are currently refused says so UP FRONT — before an entry is sent ("entry filled, protection failed" never
 * happens) and before flatten cancels anything.
 */
/**
 * QFEX (orphanedReduceOnlyOrders): resting reduce-only / stop orders left on a symbol whose
 * position is gone — the venue leaves them open (production 2026-10-12, Q2), and whether one the
 * market reaches while flat opens a position is unproven. `cancel` false → a WARNING listing them
 * with the cancel command; true (flatten) → each is cancelled (per-order proof) and the result
 * returned. Venues without the method → null. A failed read is a WARNING (the close itself stands).
 */
async function orphanedReduceOnly(adapter: ExchangeAdapter, symbol: string | null, cancel: boolean): Promise<CancelResult | null> {
  const fn = (adapter as { orphanedReduceOnlyOrders?: (s: string | null) => Promise<Array<{ symbol: string; orderId: string; type: string; side: string; price: string; quantity: string }>> }).orphanedReduceOnlyOrders;
  if (typeof fn !== "function") return null;
  let left: Awaited<ReturnType<typeof fn>>;
  try {
    left = await fn.call(adapter, symbol);
  } catch (e) {
    process.stderr.write(chalk.yellow(`  WARNING: could not check ${adapter.name} for reduce-only / stop orders left after the close (${extractErrorMessage(e)}) — check: perp account orders -e ${adapter.name}\n`));
    return null;
  }
  if (left.length === 0) return null;
  if (!cancel) {
    process.stderr.write(chalk.yellow(`  WARNING: ${left.length} reduce-only / stop order(s) remain on ${adapter.name} with no position (the venue does not cancel them): `
      + `${left.map(o => `${o.symbol} ${o.type} ${o.side} ${o.quantity} @ ${o.price} (${o.orderId})`).join("; ")}. Cancel: ${left.map(o => `perp trade cancel ${o.symbol} ${o.orderId} -e ${adapter.name}`).join(" ; ")}\n`));
    return null;
  }
  if (!isTradingV2(adapter)) throw new PerpError("NOT_IMPLEMENTED", `${adapter.name}: orphaned reduce-only orders can only be cancelled on a TradingV2 adapter`);
  const v2 = adapter;
  const out: CancelResult = { venue: adapter.name as CancelResult["venue"], cancelled: [], failed: [], pending: [], venueRaw: [] };
  for (const o of left) {
    const r = await v2.cancelByRef(o.symbol, { kind: "orderId", value: o.orderId });
    out.cancelled.push(...r.cancelled);
    out.failed.push(...r.failed);
    (out.pending as NonNullable<CancelResult["pending"]>).push(...(r.pending ?? []));
  }
  return out;
}

function refuseGatedReduceOnly(adapter: ExchangeAdapter): void {
  const gate = reduceOnlyGateOf(adapter);
  if (gate !== null) throw gate;
}

/** `--tp/--sl` and `trade tpsl` legs are stop orders: a venue that refuses stops (QFEX, Q21) says so before the entry is sent. */
function refuseGatedStops(adapter: ExchangeAdapter): void {
  const gate = stopOrderGateOf(adapter);
  if (gate !== null) throw gate;
}

/** Pre-validate an edit (amend) against the venue capabilities. */
function prevalidateAmend(adapter: ExchangeAdapter): void {
  const { def, caps } = tradingVenueOf(adapter);
  if (caps.amend === null) {
    throw unsupported(def.displayName, "amend", "the venue cannot edit orders", `Cancel and re-place the order: perp trade cancel -e ${def.id} ...`);
  }
}

// ── TP/SL ──

/** Validated --tp / --sl prices of an entry or a position (null = that leg not requested). */
interface TpSlPrices { tp: string | null; sl: string | null }

function positivePriceOpt(raw: string | undefined, flag: string): string | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new PerpError("INVALID_PARAMS", `${flag} must be a positive price (got "${raw}")`);
  return raw;
}

/** --tp/--sl of an entry command; null when neither is given. */
function entryTpSl(opts: { tp?: string; sl?: string }): TpSlPrices | null {
  const tp = positivePriceOpt(opts.tp, "--tp");
  const sl = positivePriceOpt(opts.sl, "--sl");
  return tp === null && sl === null ? null : { tp, sl };
}

/**
 * Direction check before anything is sent: a long needs tp > ref > sl, a short sl > ref > tp
 * (ref = the entry's reference: mark for market entries, the limit price for limit entries,
 * the live mark for an open position). Violations → INVALID_PARAMS.
 */
function checkTpSlDirection(positionSide: "long" | "short", ref: number, refLabel: string, p: TpSlPrices): void {
  const bad: string[] = [];
  if (p.tp !== null) {
    const tp = Number(p.tp);
    if (positionSide === "long" ? !(tp > ref) : !(tp < ref)) bad.push(`take-profit ${p.tp} must be ${positionSide === "long" ? "above" : "below"} the ${refLabel} ${ref}`);
  }
  if (p.sl !== null) {
    const sl = Number(p.sl);
    if (positionSide === "long" ? !(sl < ref) : !(sl > ref)) bad.push(`stop-loss ${p.sl} must be ${positionSide === "long" ? "below" : "above"} the ${refLabel} ${ref}`);
  }
  if (bad.length > 0) {
    throw new PerpError("INVALID_PARAMS", `TP/SL direction for a ${positionSide} position: ${bad.join("; ")}`, {
      remediation: positionSide === "long" ? "For a long: --tp above and --sl below the reference price" : "For a short: --tp below and --sl above the reference price",
    });
  }
}

/** The venue's current mark price for `symbol` (PRICE_STALE when it is not published / not positive). */
async function markPriceOf(adapter: ExchangeAdapter, symbol: string): Promise<number> {
  const m = (await adapter.getMarkets({ funding: false })).find(x => symbolMatch(x.symbol, symbol));
  const px = m === undefined ? NaN : Number(m.markPrice);
  if (!(px > 0) || !Number.isFinite(px)) {
    throw new PerpError("PRICE_STALE", `${adapter.name} ${symbol}: no mark price to check the TP/SL direction against`, { exchange: adapter.name });
  }
  return px;
}

/** Pacifica's position-level TP/SL methods (PacificaAdapter). */
type PositionTpSlAdapter = ExchangeAdapter & Pick<PacificaAdapter, "positionTpSlOrders" | "setPositionTpSl">;

function positionTpSlAdapter(adapter: ExchangeAdapter): PositionTpSlAdapter {
  const a = adapter as Partial<PositionTpSlAdapter>;
  if (typeof a.positionTpSlOrders !== "function" || typeof a.setPositionTpSl !== "function") {
    throw new PerpError("NOT_IMPLEMENTED", `${adapter.name} adapter has no position-level TP/SL methods`);
  }
  return adapter as PositionTpSlAdapter;
}

/** Refuse when position-level TP/SL orders already exist (never overwrite). */
async function refuseExistingPositionTpSl(adapter: PositionTpSlAdapter, def: VenueDefinition, symbol: string): Promise<void> {
  const existing = await adapter.positionTpSlOrders(symbol);
  if (existing.length > 0) {
    throw new PerpError("INVALID_PARAMS", `${def.displayName} ${symbol} already has position TP/SL (${existing.map(o => `${o.type} #${o.orderId}${o.stopPrice !== null ? ` @ ${o.stopPrice}` : ""}`).join(", ")}); refusing to overwrite it`, {
      exchange: def.id,
      remediation: `Cancel the existing TP/SL first (perp trade cancel-stop ${symbol} <orderId> -e ${def.id}), then set the new one`,
    });
  }
}

/** A protective leg that was placed (OrderResult) or set position-level (raw venue ack). */
type TpSlLegOutcome = { kind: "tp" | "sl" | "tpsl"; trigger: string; result: OrderResult | null; venueRaw: unknown };

function legLabel(l: { kind: "tp" | "sl" | "tpsl"; trigger: string }): string {
  return l.kind === "tp" ? `TP @ ${l.trigger}` : l.kind === "sl" ? `SL @ ${l.trigger}` : `position TP/SL ${l.trigger}`;
}

// ── Scaled orders (scale-tp / scale-in) ──

/**
 * Sizes of scaled levels on the venue lot grid: the total is floored to `step`, each level is
 * floor(total × pct / 100) lots and the LAST level takes the remainder — so every level is a
 * multiple of the lot and the levels sum to the floored total. An off-lot level is refused by the
 * venue (Pacifica 422 "Limit order amount 0.00205 is not a multiple of lot size"; Lighter 21706
 * "invalid order base or quote amount" for 0.01475 TSLA at 4 size decimals). A level of zero lots
 * → SIZE_TOO_SMALL.
 */
export function scaleLevelSizes(total: string, pcts: readonly number[], step: string): string[] {
  const units = exactUnits(floorSize(total, step), step);
  if (units === null) throw new PerpError("INVALID_PARAMS", `size ${total} cannot be placed on the lot ${step}`);
  const out: bigint[] = [];
  let used = 0n;
  pcts.forEach((pct, i) => {
    const u = i === pcts.length - 1 ? units - used : BigInt(Math.floor(Number(units) * pct / 100 + 1e-9));
    used += u;
    out.push(u);
  });
  const zero = out.findIndex(u => u <= 0n);
  if (zero !== -1) {
    throw new PerpError("SIZE_TOO_SMALL", `Level ${zero + 1} (${pcts[zero]}% of ${total}) is below the lot ${step}; nothing was sent`, {
      remediation: `Use fewer levels or a larger total: every level must be at least one lot (${step})`,
    });
  }
  return out.map(u => unitsToString(u, step));
}

/**
 * Refuse (SIZE_TOO_SMALL, nothing sent) a scaled order with a level under the venue's published
 * minimum order size / notional (VenueMarket.minSize / minNotional; null = none published on this
 * data path → not checked). Reduce-only levels are held to it too: no venue's docs state an
 * exemption (Pacifica market-info: `min_order_size` "Minimum order size (denominated in USD)",
 * no exception listed).
 */
export function requireScaleLevelMinimums(venue: string, symbol: string, levels: ReadonlyArray<{ price: string; size: string }>, min: { minSize: string | null; minNotional: string | null }): void {
  levels.forEach((l, i) => {
    const notional = Number(l.size) * Number(l.price);
    const underSize = min.minSize !== null && Number(l.size) < Number(min.minSize);
    const underNotional = min.minNotional !== null && notional < Number(min.minNotional);
    if (!underSize && !underNotional) return;
    throw new PerpError("SIZE_TOO_SMALL",
      `${venue} ${symbol}: level ${i + 1} (${l.size} @ ${l.price} = $${notional.toFixed(2)}) is below the venue minimum ${underSize ? `size ${min.minSize}` : `order value $${min.minNotional}`}; nothing was sent`, {
        exchange: venue, level: i + 1, size: l.size, price: l.price, minSize: min.minSize, minNotional: min.minNotional,
        remediation: "Use fewer levels (or a larger total) so that every level meets the venue minimum",
      });
  });
}

/** Outcome of one scaled level: placed, definitely refused, unknown (may exist), or never sent. */
export interface ScaleLevelOutcome {
  price: string;
  size: string;
  pct: number;
  outcome: "placed" | "rejected" | "unknown" | "notSent";
  result: Record<string, unknown> | { error: string };
}

/**
 * The failure a scaled order reports unless every level was placed: any unknown outcome →
 * ORDER_PENDING; every level definitely refused → ORDER_REJECTED; otherwise ORDER_PARTIAL.
 * details list the placed / failed / unknown / not-sent levels.
 */
export function scaleIncompleteError(venue: string, what: string, levels: readonly ScaleLevelOutcome[]): PerpError | null {
  const by = (o: ScaleLevelOutcome["outcome"]) => levels.filter(l => l.outcome === o);
  const placed = by("placed"), rejected = by("rejected"), unknown = by("unknown"), notSent = by("notSent");
  if (rejected.length === 0 && unknown.length === 0) return null;
  const details = { exchange: venue, placed, failed: rejected, unknown, notSent };
  const hint = `perp account orders -e ${venue}`;
  if (unknown.length > 0) {
    return new PerpError("ORDER_PENDING", `${venue} ${what}: the outcome of level ${levels.indexOf(unknown[0]) + 1} is unknown; ${placed.length} placed, ${rejected.length} refused, ${notSent.length} not sent`, {
      ...details, remediation: `Do NOT resubmit — a level may have been placed. Check open orders: ${hint}`,
    });
  }
  if (placed.length === 0) {
    return new PerpError("ORDER_REJECTED", `${venue} ${what}: every level was refused, nothing was placed — ${rejected.map(l => (l.result as { error: string }).error).join("; ")}`, details);
  }
  return new PerpError("ORDER_PARTIAL", `${venue} ${what}: ${placed.length} level(s) placed, ${rejected.length} refused`, {
    ...details, remediation: `Some levels are resting. Inspect with: ${hint}, then place the missing levels or cancel the placed ones.`,
  });
}

interface MarketOpts { reduceOnly?: boolean; smart?: boolean; clientId?: string; autoId?: boolean; force?: boolean; slippageBps?: string; tp?: string; sl?: string }

/**
 * Pacifica native TWAP (create / cancel) is refused when signed by an agent wallet: live mainnet
 * 2026-10-05, POST /orders/twap/create with `agent_wallet` → 400 signature_verification_failed
 * ("signature does not match signer and canonical payload"), while the same request signed by
 * the master was accepted (TWAP 121433, then cancelled). The REST docs have no TWAP page and the
 * official python-sdk example signs with the account key only.
 */
function requirePacificaTwapSigner(adapter: ExchangeAdapter, what: string): void {
  const tier = (adapter as ExchangeAdapter & { activeSignerTier?: "agent" | "master" | "pk" | null }).activeSignerTier;
  if (tier === "agent") {
    throw unsupported("Pacifica", "agentSignedTwap", `the venue rejects an agent-signed ${what} (signature_verification_failed); only the account's own key is accepted`,
      "Sign this command with the master wallet: add --no-agent (the master wallet must be on this computer)");
  }
}

/** Venues whose cancel-by-reference needs no symbol (Ondo: DELETE /orders/<id> or client id). */
const SYMBOLLESS_CANCEL_VENUES: ReadonlySet<VenueDefinition["id"]> = new Set(["ondo"]);

/** UUID (Pacifica / QFEX / Ondo order ids) — 8-4-4-4-12 hex. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One-arg `trade cancel <x>`: true when x is an order id (numeric, UUID or 0x-hex), never a symbol. */
export function looksLikeOrderId(x: string): boolean {
  return /^\d+$/.test(x) || UUID_RE.test(x) || /^0x[0-9a-f]+$/i.test(x);
}

export function registerTradeCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  isDryRun: () => boolean = () => false,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
) {
  /** Guard: if --dry-run is active, log the intended action and return without executing. */
  function dryRunGuard(action: string, details: Record<string, unknown>): boolean {
    if (!isDryRun()) return false;
    const info = { dryRun: true, sent: false, action, ...details, timestamp: new Date().toISOString() };
    if (isJson()) {
      printJson(jsonOk(info));
    } else {
      console.log(chalk.yellow(`\n  [DRY RUN] Would ${action}:`));
      for (const [k, v] of Object.entries(details)) {
        console.log(chalk.gray(`    ${k}: ${v !== null && typeof v === "object" ? JSON.stringify(v) : v}`));
      }
      console.log();
    }
    logExecution({
      type: action.includes("split") ? "split_order" : action.includes("limit") ? "limit_order" : action.includes("stop") ? "stop_order" : action.includes("cancel") ? "cancel" : "market_order",
      exchange: details.exchange as string ?? "unknown",
      symbol: normalizeSymbolArg(details.symbol as string ?? ""),
      side: details.side as string ?? "",
      size: String(details.size ?? details.totalUsd ?? "0"),
      price: details.price as string,
      status: "simulated",
      dryRun: true,
    });
    return true;
  }

  /**
   * dryRunGuard for a perp order: adds the builder fee the live order would carry
   * (`builderFee`: { venue, identity, feeBps, feeKind } | null, plus `builderNote` when a
   * configured fee would not be attached).
   */
  async function orderDryRunGuard(action: string, adapter: ExchangeAdapter, symbol: string | null, details: Record<string, unknown>): Promise<boolean> {
    if (!isDryRun()) return false;
    const d = await builderPlanFor(adapter, symbol);
    return dryRunGuard(action, { ...details, builderFee: d.applied, ...(d.note !== null ? { builderNote: d.note } : {}) });
  }

  /**
   * Pre-send gate of every order path that can open or flip a position, run BEFORE the dry-run
   * return (a dry-run reports the refusal the live order would hit):
   *  - quarantine (non-reduce-only): an earlier unknown outcome on the symbol blocks new orders
   *    until a human clears it — the same gate as MCP (mcpPreTradeGate) and `arb exec`; --force
   *    does NOT bypass it (--force is the local risk-limit override only);
   *  - local risk limits (enforceOrderRisk; --force bypasses, reduce-only exempt).
   */
  /** Opening orders on a quarantined symbol are refused (reduce-only passes); --force never bypasses it. */
  function assertNotQuarantined(venue: string, symbol: string, reduceOnly: boolean | undefined): void {
    if (reduceOnly === true) return;
    const q = quarantineEntryFor(symbol, (m) => { if (!isJson()) console.error(m); });
    if (q !== null) {
      throw new PerpError("RISK_VIOLATION", `${symbol} is quarantined by ${q.strategy}: ${q.reason}`, {
        exchange: venue,
        remediation: `${q.remediation} — only reduce-only orders are accepted until a human clears it (perp strategy quarantine-clear ${symbol})`,
      });
    }
  }

  async function openingOrderGate(adapter: ExchangeAdapter, p: { symbol: string; size: number; price?: number; reduceOnly?: boolean; force?: boolean }): Promise<void> {
    assertNotQuarantined(adapter.name, p.symbol, p.reduceOnly);
    await enforceOrderRisk(adapter, p);
  }

  /** Mark price of `sym` (split sizing / risk); no usable mark → PRICE_STALE, nothing sent. */
  async function splitMarkPrice(adapter: ExchangeAdapter, sym: string): Promise<number> {
    const market = (await adapter.getMarkets({ funding: false })).find(m => symbolMatch(m.symbol, sym));
    const markPrice = market !== undefined ? Number(market.markPrice) : NaN;
    if (!(markPrice > 0)) {
      throw new PerpError("PRICE_STALE", `${adapter.name}: no usable mark price for ${sym} — cannot size the split; nothing was sent`, { exchange: adapter.name });
    }
    return markPrice;
  }

  const network = (): Network => networkOf(program);
  const v2Of = (adapter: ExchangeAdapter): TradingV2 => tradingV2Of(adapter, network());

  /**
   * Validate every level of a scaled order BEFORE anything is sent (venue TIF / reduce-only rules,
   * e.g. Ondo refuses a resting reduce-only order; venue minimum per level) and return the requests.
   */
  async function scaleRequests(adapter: ExchangeAdapter, sym: string, side: "buy" | "sell", reduceOnly: boolean, levels: ReadonlyArray<{ price: string; size: string }>): Promise<OrderRequest[]> {
    const { def, caps } = tradingVenueOf(adapter);
    const tif = validateLegacyTif(def, caps, DEFAULT_TIF);
    const reqs = levels.map((l): OrderRequest => ({
      symbol: sym, side, type: "limit", size: l.size, price: l.price, triggerPrice: null, triggerSource: null, tif,
      reduceOnly, clientOrderId: v2ClientOrderId(def, caps, undefined), slippage: null, tpsl: null,
    }));
    for (const req of reqs) validateOrderRequest(def, caps, req);
    const { min } = await venueOrderRules(adapter, sym);
    if (min !== null) requireScaleLevelMinimums(def.id, sym, levels, min);
    return reqs;
  }

  /**
   * The venue's published tick and order minimums for `sym` (VenueMarket). A HIP-3 dex market
   * ("xyz:NVDA") is not in the venue's public market list (native dex only): no tick there, but
   * Hyperliquid's minimum order value is venue-wide, so it still applies. `min` null = the
   * market has no VenueMarket row and the venue no venue-wide minimum → not checked.
   */
  async function venueOrderRules(adapter: ExchangeAdapter, sym: string): Promise<{ tickSize: string | null; min: { minSize: string | null; minNotional: string | null } | null }> {
    const { def } = tradingVenueOf(adapter);
    const vm = (await v2Of(adapter).getVenueMarkets()).find(m => symbolMatch(m.symbol, sym));
    if (vm !== undefined) return { tickSize: vm.tickSize, min: { minSize: vm.minSize, minNotional: vm.minNotional } };
    return { tickSize: null, min: def.id === "hyperliquid" ? { minSize: null, minNotional: HL_MIN_ORDER_VALUE_USD } : null };
  }

  /**
   * Run a split order with the venue's lot / tick / minimums and report it. A run that did not
   * fill completely is an error envelope (ORDER_REJECTED / ORDER_PENDING / ORDER_PARTIAL), never ok:true.
   */
  async function runSplit(adapter: ExchangeAdapter, sym: string, side: "buy" | "sell", totalSizeUsd: number, o: { maxSlippagePct: number; maxSlices?: number; delayMs?: number; minSliceUsd?: number }): Promise<void> {
    const { runSplitOrder, splitIncompleteError } = await import("../strategies/split-order.js");
    const rules = await venueOrderRules(adapter, sym);
    const result = await runSplitOrder(adapter, {
      symbol: sym, side, totalSizeUsd, ...o,
      stepSize: await lotStepOf(adapter, sym), tickSize: rules.tickSize,
      minSize: rules.min !== null ? rules.min.minSize : null, minNotional: rules.min !== null ? rules.min.minNotional : null,
    }, isJson() ? () => {} : (msg) => console.log(chalk.gray(`  ${msg}`)));
    const incomplete = splitIncompleteError(adapter.name, result);
    if (incomplete !== null) throw incomplete;
    if (isJson()) return printJson(jsonOk(result));
    console.log(`\n  ${chalk.green(result.status.toUpperCase())} | ${result.slices.length} slices`);
    console.log(`  Filled: ${result.filledSize} / ${result.requestedSize} ${sym}${result.filledUsd !== null ? ` ($${formatUsd(result.filledUsd)} of $${formatUsd(result.requestedUsd)})` : ""}`);
    console.log(`  Avg Price: ${result.avgPrice !== null ? `$${result.avgPrice}` : "not reported by the venue"}`);
    if (result.totalSlippagePct !== null) console.log(`  Slippage: ${result.totalSlippagePct.toFixed(3)}%`);
    console.log(`  Runtime: ${result.runtime.toFixed(1)}s\n`);
  }

  /**
   * Send the levels of a scaled order one by one through the uniform order path. A level whose
   * outcome is unknown (transport failure after sending, or a non-final ack) stops the run — the
   * remaining levels are not sent. Throws scaleIncompleteError unless every level was placed.
   */
  async function placeScaleLevels(adapter: ExchangeAdapter, action: "scale-tp" | "scale-in", sym: string, side: "buy" | "sell", plan: ReadonlyArray<{ price: string; size: string; pct: number }>, reqs: readonly OrderRequest[]): Promise<ScaleLevelOutcome[]> {
    const { caps } = tradingVenueOf(adapter);
    const out: ScaleLevelOutcome[] = [];
    let stopped = false;
    for (const [i, level] of plan.entries()) {
      if (stopped) {
        out.push({ ...level, outcome: "notSent", result: { error: "not sent: an earlier level's outcome is unknown" } });
        continue;
      }
      const meta = { action, pct: level.pct, reduceOnly: reqs[i].reduceOnly };
      const log = (status: "success" | "failed" | "unverified", error?: string) => logExecution({
        type: "limit_order", exchange: adapter.name, symbol: sym, side, size: level.size, price: level.price,
        status, dryRun: false, ...(error !== undefined ? { error } : {}), meta,
      });
      try {
        const r = await placeV2(v2Of(adapter), caps, reqs[i]);
        if (r.finality !== "final") {
          stopped = true;
          log("unverified", "the venue acknowledged the order without a final status");
          out.push({ ...level, outcome: "unknown", result: orderResultJson(r) });
        } else if (r.status === "rejected" || r.status === "cancelled") {
          log("failed", `the venue ${r.status} the order`);
          out.push({ ...level, outcome: "rejected", result: { error: `the venue ${r.status} the order${r.orderId !== null ? ` ${r.orderId}` : ""}` } });
        } else {
          log("success");
          out.push({ ...level, outcome: "placed", result: orderResultJson(r) });
        }
      } catch (err) {
        const msg = extractErrorMessage(err);
        const definite = isDefiniteOrderFailure(err);
        if (!definite) stopped = true;
        log(definite ? "failed" : "unverified", msg);
        out.push({ ...level, outcome: definite ? "rejected" : "unknown", result: { error: msg } });
      }
    }
    return out;
  }

  /** Print the per-level table of a scaled order (human mode). */
  function printScaleLevels(title: string, sym: string, levels: readonly ScaleLevelOutcome[]): void {
    console.log(chalk.green(`\n  ${title}\n`));
    for (const l of levels) {
      const status = l.outcome === "placed" ? chalk.green("OK") : l.outcome === "rejected" ? chalk.red("FAILED") : l.outcome === "unknown" ? chalk.yellow("UNKNOWN") : chalk.gray("NOT SENT");
      console.log(`  ${status}  $${l.price} — ${l.pct}% (${l.size} ${sym})${"error" in l.result ? chalk.gray(` — ${String(l.result.error)}`) : ""}`);
    }
    console.log();
  }

  /**
   * Validate an entry's --tp/--sl before anything is sent: the venue has
   * TP/SL, the entry opens (not reduce-only), separateOrders / positionLevel venues need an
   * immediate entry (market or IOC — a resting entry has no verified fill to size the legs to),
   * and the prices sit on the right sides of `ref`.
   */
  function prevalidateEntryTpSl(def: VenueDefinition, caps: VenueCapabilities, side: "buy" | "sell", reduceOnly: boolean, immediate: boolean, ref: number, refLabel: string, prices: TpSlPrices): void {
    if (caps.tpsl === null) {
      throw unsupported(def.displayName, "tpsl", "the venue has no TP/SL orders", `Use stop orders: perp trade stop -e ${def.id} ...`);
    }
    if (reduceOnly) {
      throw new PerpError("INVALID_PARAMS", "--tp/--sl protect the position an entry opens; they cannot be combined with --reduce-only");
    }
    if (!immediate && (caps.tpsl === "separateOrders" || caps.tpsl === "positionLevel")) {
      throw unsupported(def.displayName, "tpslRestingEntry", "TP/SL legs are sized to the entry's verified fill, and a resting entry has no fill yet",
        `Use a market (or --tif IOC) entry with --tp/--sl, or place the entry and later run: perp trade tpsl <symbol> <long|short> --tp <p> --sl <p> -e ${def.id}`);
    }
    checkTpSlDirection(side === "buy" ? "long" : "short", ref, refLabel, prices);
  }

  /**
   * Place an entry carrying --tp/--sl — one meaning on every venue: protect THIS entry's
   * verified fill.
   *  - attached (ondo) / batchGroup (arcus): the venue attaches the legs to the entry.
   *  - separateOrders (hl, lighter, aster): entry fill VERIFIED (placePerpVerified: venue-final
   *    report cross-checked with the position delta), then reduce-only TP/SL triggers sized to it.
   *  - positionLevel (pacifica): entry fill verified, then position TP/SL (refused when TP/SL
   *    or a position already exists — the position-level TP/SL would cover more than this fill).
   * Entry outcome unknown → ORDER_PENDING, no legs ("position may be unprotected"); entry ok and
   * a leg fails → ORDER_PARTIAL (not retryable) with the entry result and the legs placed.
   */
  async function placeProtectedEntry(
    adapter: ExchangeAdapter, def: VenueDefinition, caps: VenueCapabilities, req: OrderRequest, prices: TpSlPrices, slippage: ResolvedSlippage,
  ): Promise<{ entry: PlacedOrder | null; filledSize: string; method: string; legs: TpSlLegOutcome[] }> {
    const v2 = v2Of(adapter);
    const sym = req.symbol;
    const positionSide = req.side === "buy" ? "long" : "short";
    // An entry against an existing opposite position reduces (or flips) it instead of opening:
    // TP/SL sized to its fill would protect a position that does not exist. Refused on every venue.
    invalidateCache("acct");
    const existing = (await adapter.getPositions()).filter(p => symbolMatch(p.symbol, sym) && Number(p.size) !== 0);
    const opposite = existing.find(p => p.side !== positionSide);
    if (opposite !== undefined) {
      throw new PerpError("INVALID_PARAMS", `--tp/--sl protect the position an entry opens, but this ${req.side} would reduce the existing ${opposite.side} ${opposite.size.replace(/^-/, "")} ${sym} position`, {
        remediation: `Close or reduce the ${opposite.side} first (perp trade close ${sym} -e ${def.id}), or place the entry without --tp/--sl`,
      });
    }
    if (caps.tpsl === "attached" || caps.tpsl === "batchGroup") {
      const entry = await placeV2(v2, caps, { ...req, tpsl: prices });
      return { entry, filledSize: entry.filledSize ?? "unknown", method: caps.tpsl, legs: [] };
    }
    const closeSide = req.side === "buy" ? "sell" : "buy";
    const tpslHint = `perp trade tpsl ${sym} ${positionSide}${prices.tp !== null ? ` --tp ${prices.tp}` : ""}${prices.sl !== null ? ` --sl ${prices.sl}` : ""} -e ${def.id}`;

    let pacifica: PositionTpSlAdapter | null = null;
    if (caps.tpsl === "positionLevel") {
      pacifica = positionTpSlAdapter(adapter);
      if (existing.length > 0) {
        throw unsupported(def.displayName, "tpslPositionLevel", `TP/SL is position-level and would also cover the existing ${sym} position, not just this entry's fill`,
          `Place the entry without --tp/--sl, then run: perp trade tpsl ${sym} <long|short> --tp <p> --sl <p> -e ${def.id}`);
      }
      await refuseExistingPositionTpSl(pacifica, def, sym);
    }

    // Lot step from the venue market info: the entry is sent floored to it, its fill is judged
    // against that sent size (half-lot tolerance) and the TP/SL legs are sized on the lot grid.
    const step = await lotStepOf(adapter, sym);
    const sent: OrderRequest = { ...req, size: floorSize(req.size, step) };
    const holder: { entry: PlacedOrder | null } = { entry: null };
    let fill: { filledSize: number };
    try {
      fill = await placePerpVerified(adapter, def.id, sym, sent.side, sent.size, {
        reduceOnly: false,
        stepSize: step,
        place: async () => {
          holder.entry = await placeV2(v2, caps, sent);
          return holder.entry.venueRaw;
        },
      });
    } catch (e) {
      if (isOutcomeUnknown(e)) {
        throw new PerpError("ORDER_PENDING", `${extractErrorMessage(e)} — no TP/SL was placed: the position may be unprotected`, {
          exchange: def.id,
          entry: holder.entry !== null ? orderResultJson(holder.entry) : null,
          remediation: `Do NOT resubmit. Check the position (perp account positions -e ${def.id}); once confirmed, protect it with: ${tpslHint}`,
        });
      }
      throw e;
    }
    const entry = holder.entry;
    const filled = floorToStep(fill.filledSize, step);
    const legs: TpSlLegOutcome[] = [];
    const partial = (failed: string, e: unknown): PerpError => new PerpError("ORDER_PARTIAL",
      `Entry filled ${filled} ${sym} on ${def.displayName}, but ${failed} failed: ${extractErrorMessage(e)} — ${legs.length > 0 ? `placed: ${legs.map(legLabel).join(", ")}` : "no TP/SL placed"}`, {
        exchange: def.id,
        entry: entry !== null ? orderResultJson(entry) : null,
        filledSize: filled,
        legsPlaced: legs.map(l => ({ kind: l.kind, trigger: l.trigger, orderId: l.result !== null ? l.result.orderId : null })),
        failedLeg: failed,
        remediation: `Do NOT re-enter — the position is ${legs.length > 0 ? "only partly" : "NOT"} protected. Set the missing protection with: ${tpslHint}`,
      });
    if (!(Number(filled) > 0)) throw partial("TP/SL sizing", new Error(`verified fill ${fill.filledSize} is below one lot (${step})`));

    if (pacifica !== null) {
      const label = `tp ${prices.tp ?? "-"} / sl ${prices.sl ?? "-"}`;
      try {
        const raw = await pacifica.setPositionTpSl(sym, positionSide, { tp: prices.tp, tpLimit: null, sl: prices.sl });
        legs.push({ kind: "tpsl", trigger: label, result: null, venueRaw: raw });
      } catch (e) {
        throw partial(`position TP/SL (${label})`, e);
      }
      return { entry, filledSize: filled, method: "positionLevel", legs };
    }
    for (const [kind, trigger] of [["tp", prices.tp], ["sl", prices.sl]] as const) {
      if (trigger === null) continue;
      try {
        const r = await placeTpSlLeg(adapter, network(), { symbol: sym, closeSide, size: filled, trigger, kind, limitPrice: null, slippage });
        legs.push({ kind, trigger, result: r, venueRaw: r.venueRaw });
      } catch (e) {
        throw partial(legLabel({ kind, trigger }), e);
      }
    }
    return { entry, filledSize: filled, method: "separateOrders", legs };
  }

  /** Human / JSON output of a protected entry. */
  function printProtectedEntry(header: string, out: { entry: PlacedOrder | null; filledSize: string; method: string; legs: TpSlLegOutcome[] }, extra: Record<string, unknown> | undefined): void {
    const legsJson = out.legs.map(l => ({ kind: l.kind, trigger: l.trigger, ...(l.result !== null ? orderResultJson(l.result) : { venueRaw: l.venueRaw }) }));
    if (isJson()) {
      printJson(jsonOk({
        ...(out.entry !== null ? orderResultJson(out.entry, extra) : { entry: null, ...extra }),
        verifiedFilledSize: out.filledSize,
        tpsl: { method: out.method, legs: legsJson },
      }));
      return;
    }
    if (out.entry !== null) printOrder(header, out.entry);
    else console.log(chalk.green(`\n  ${header}\n`));
    console.log(chalk.green(`  Verified fill: ${out.filledSize}  ·  TP/SL (${out.method})`));
    if (out.legs.length === 0) console.log(chalk.gray("  Legs attached to the entry by the venue (see execution notes)"));
    for (const l of out.legs) {
      console.log(chalk.green(`  ${legLabel(l)}`));
      if (l.result !== null) for (const line of formatOrderResult(l.result)) console.log(line);
    }
    console.log();
  }

  /** One market-order path for trade market / buy / sell (every venue via TradingV2; --smart = legacy smart-order). */
  async function runMarketOrder(sym: string, side: "buy" | "sell", rawSize: string, opts: MarketOpts): Promise<void> {
    // One parsed size for the risk check and the order ("1,000" / "abc" refused before anything else).
    const size = parsePositiveDecimal(rawSize, "size");
    const slippageFlag = parseSlippageBpsFlag(opts.slippageBps);
    if (opts.clientId && isOrderDuplicate(opts.clientId)) {
      if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: opts.clientId, message: "Order already submitted" }));
      console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${opts.clientId}). Skipping.\n`));
      return;
    }
    const adapter = await getAdapter();
    const { def: venueDef, caps: venueCaps } = tradingVenueOf(adapter);
    const clientId = opts.autoId ? autoClientId(venueDef, venueCaps, "market") : opts.clientId;
    if (opts.smart && clientId !== undefined) {
      throw unsupported(venueDef.displayName, "smartClientOrderId", "--smart orders are sent without a client order id, so the id would be dropped", "Omit --client-id / --auto-id, or omit --smart");
    }
    const reduceOnly = opts.reduceOnly === true;
    const slippage = resolveSlippage(venueDef.id, slippageFlag);
    if (opts.smart && !isLegacyOrderVenue(venueDef)) {
      throw unsupported(venueDef.displayName, "smartOrder", "--smart needs the legacy limit-order path", "Omit --smart");
    }
    const prices = entryTpSl(opts);
    if (prices !== null) {
      if (opts.smart) throw unsupported(venueDef.displayName, "tpslSmart", "--smart entries do not carry --tp/--sl", "Omit --smart");
      refuseGatedReduceOnly(adapter);
      refuseGatedStops(adapter);
      prevalidateEntryTpSl(venueDef, venueCaps, side, reduceOnly, true, await markPriceOf(adapter, sym), "mark price", prices);
    }
    const req = opts.smart ? null : v2MarketRequest(venueDef, venueCaps, sym, side, size, reduceOnly, slippage, clientId);

    // Read-only quarantine + local risk check BEFORE the dry-run return (review L5): a dry-run reports
    // the same RISK_VIOLATION the live order would hit. --force skips the risk limits in both modes.
    await openingOrderGate(adapter, { symbol: sym, size: Number(size), reduceOnly: opts.reduceOnly, force: opts.force });

    if (await orderDryRunGuard("market_order", adapter, sym, { exchange: adapter.name, symbol: sym, side, size, smart: !!opts.smart, ...(prices !== null ? { tp: prices.tp ?? "none", sl: prices.sl ?? "none" } : {}) })) return;

    if (clientId) {
      logClientId({
        clientOrderId: clientId, exchange: adapter.name,
        symbol: sym, side, size, type: "market",
        status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    const meta = { ...(clientId ? { clientOrderId: clientId } : {}), ...(opts.smart ? { smart: true } : {}) };
    let placed: PlacedOrder | null = null;
    let smartResult: unknown = null;
    let protectedOut: Awaited<ReturnType<typeof placeProtectedEntry>> | null = null;
    try {
      if (req === null) {
        const sr = await smartOrder(adapter, sym, side, size, { reduceOnly, slippage });
        smartResult = { ...sr.result as object, smartOrder: { method: sr.method, price: sr.price, bestBookPrice: sr.bestBookPrice, tickSize: sr.tickSize } };
      } else if (prices !== null) {
        protectedOut = await placeProtectedEntry(adapter, venueDef, venueCaps, req, prices, slippage);
        placed = protectedOut.entry;
      } else {
        placed = await placeV2(v2Of(adapter), venueCaps, req);
      }
      logExecution({ type: "market_order", exchange: adapter.name, symbol: sym, side, size, status: "success", dryRun: false, meta });
    } catch (err) {
      logExecution({ type: "market_order", exchange: adapter.name, symbol: sym, side, size, status: isOutcomeUnknown(err) ? "unverified" : "failed", dryRun: false, error: extractErrorMessage(err), meta });
      throw err;
    }

    if (clientId) {
      logClientId({
        clientOrderId: clientId, exchange: adapter.name,
        symbol: sym, side, size, type: "market",
        status: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    const header = `Market ${side.toUpperCase()} ${size} ${sym} on ${adapter.name}${opts.smart ? " (smart)" : ""}${clientId ? ` (id: ${clientId})` : ""}`;
    if (protectedOut !== null) return printProtectedEntry(header, protectedOut, placed !== null ? trackedId(placed, clientId) : undefined);
    if (placed === null) {
      // --smart keeps the raw smart-order result shape.
      if (isJson()) return printJson(jsonOk(clientId ? { ...smartResult as object, clientOrderId: clientId } : smartResult));
      console.log(chalk.green(`\n  ${header} placed.\n`));
      return;
    }
    if (isJson()) return printJson(jsonOk(orderResultJson(placed, trackedId(placed, clientId))));
    printOrder(header, placed);
  }

  const trade = program.command("trade").description("Trading commands");

  // === Generic commands (all exchanges) ===

  supportsDryRun(trade.command("market <symbol> <side> <size>"))
    .description("Place a market order (side: buy/sell)")
    .option("--reduce-only", "Reduce only order")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick (reduces slippage)")
    .option("--split", "Use orderbook-aware split execution for large orders")
    .option("--max-slippage <pct>", "--split only: max price impact per split slice (%) — not the market-order slippage bound", "0.3")
    .option("--client-id <id>", "Client order ID for idempotent tracking")
    .option("--auto-id", "Auto-generate a client order ID")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure)")
    .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
    .option("--tp <price>", "Take-profit trigger protecting this entry's verified fill (every venue; separate-order venues need a market / IOC entry)")
    .option("--sl <price>", "Stop-loss trigger protecting this entry's verified fill (every venue; separate-order venues need a market / IOC entry)")
    .action(async (symbol: string, side: string, size: string, opts: MarketOpts & { split?: boolean; maxSlippage?: string }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      const sym = normalizeSymbolArg(symbol);

      // ── Split execution branch ──
      if (opts.split) {
        // runSplitOrder has no reduce-only path — refuse rather than silently place opening orders.
        if (opts.reduceOnly) errorAndExit("--reduce-only is not supported with --split");
        if (opts.tp !== undefined || opts.sl !== undefined) throw new PerpError("INVALID_PARAMS", "--tp/--sl are not supported with --split (no single verified entry fill to protect)");
        const baseSize = Number(parsePositiveDecimal(size, "size"));
        const adapter = await getAdapter();
        // No mark price → the base size cannot be valued in USD; never treated as a USD amount.
        const markPrice = await splitMarkPrice(adapter, sym);
        // Split slices are opening orders: quarantine + risk limits before the dry-run return (--force: limits only).
        await openingOrderGate(adapter, { symbol: sym, size: baseSize, price: markPrice, force: opts.force });
        if (await orderDryRunGuard("split-order", adapter, sym, { exchange: adapter.name, symbol: sym, side: s, size })) return;
        await runSplit(adapter, sym, s as "buy" | "sell", baseSize * markPrice, { maxSlippagePct: parseFloat(opts.maxSlippage ?? "0.3") });
        return;
      }

      await runMarketOrder(sym, s as "buy" | "sell", size, opts);
    });

  // Shortcuts: trade buy / trade sell
  supportsDryRun(trade.command("buy <symbol> <size>"))
    .description("Market buy (shortcut for: trade market <symbol> buy <size>)")
    .option("--reduce-only", "Reduce only order")
    .option("--smart", "Smart execution: IOC limit at best ask + 1 tick")
    .option("--client-id <id>", "Client order ID")
    .option("--auto-id", "Auto-generate client order ID")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure)")
    .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
    .option("--tp <price>", "Take-profit trigger protecting this entry's verified fill (every venue; separate-order venues need a market / IOC entry)")
    .option("--sl <price>", "Stop-loss trigger protecting this entry's verified fill (every venue; separate-order venues need a market / IOC entry)")
    .action(async (symbol: string, size: string, opts: MarketOpts) => {
      await runMarketOrder(normalizeSymbolArg(symbol), "buy", size, opts);
    });

  supportsDryRun(trade.command("sell <symbol> <size>"))
    .description("Market sell (shortcut for: trade market <symbol> sell <size>)")
    .option("--reduce-only", "Reduce only order")
    .option("--smart", "Smart execution: IOC limit at best bid - 1 tick")
    .option("--client-id <id>", "Client order ID")
    .option("--auto-id", "Auto-generate client order ID")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure)")
    .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
    .option("--tp <price>", "Take-profit trigger protecting this entry's verified fill (every venue; separate-order venues need a market / IOC entry)")
    .option("--sl <price>", "Stop-loss trigger protecting this entry's verified fill (every venue; separate-order venues need a market / IOC entry)")
    .action(async (symbol: string, size: string, opts: MarketOpts) => {
      await runMarketOrder(normalizeSymbolArg(symbol), "sell", size, opts);
    });

  // ── Split Order (orderbook-aware) ──
  supportsDryRun(trade.command("split <symbol> <side> <usd>"))
    .description("Orderbook-aware split execution — breaks large orders into slices based on depth")
    .option("--max-slippage <pct>", "Max slippage per slice (%)", "0.3")
    .option("--max-slices <n>", "Max number of slices", "10")
    .option("--delay <ms>", "Delay between slices in ms", "1000")
    .option("--min-slice <usd>", "Minimum slice size in USD", "100")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure)")
    .action(async (symbol: string, side: string, usd: string, opts: {
      maxSlippage: string; maxSlices: string; delay: string; minSlice: string; force?: boolean;
    }) => {
      const sym = normalizeSymbolArg(symbol);
      const orderSide = side.toLowerCase() as "buy" | "sell";
      const totalUsd = parseFloat(usd);

      if (!["buy", "sell"].includes(orderSide)) errorAndExit("Side must be 'buy' or 'sell'");
      if (isNaN(totalUsd) || totalUsd <= 0) errorAndExit("USD amount must be > 0");

      const adapter = await getAdapter();
      // Opening orders: quarantine + risk limits on size = usd / mark before the dry-run return (--force: limits only).
      const markPrice = await splitMarkPrice(adapter, sym);
      await openingOrderGate(adapter, { symbol: sym, size: totalUsd / markPrice, price: markPrice, force: opts.force });
      if (await orderDryRunGuard("split-order", adapter, sym, { exchange: adapter.name, symbol: sym, side: orderSide, totalUsd, ...opts })) return;
      await runSplit(adapter, sym, orderSide, totalUsd, {
        maxSlippagePct: parseFloat(opts.maxSlippage),
        maxSlices: parseInt(opts.maxSlices),
        delayMs: parseInt(opts.delay),
        minSliceUsd: parseFloat(opts.minSlice),
      });
    });

  supportsDryRun(trade.command("limit <symbol> <side> <price> <size>"))
    .description("Place a limit order")
    .option("--tif <tif>", "Time in force: GTC (default, every venue) | IOC | FOK | ALO (post-only); venue aliases GTT / GTX / TOB accepted")
    .option("--reduce-only", "Reduce only order")
    .option("--client-id <id>", "Client order ID for idempotent tracking")
    .option("--auto-id", "Auto-generate a client order ID")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure)")
    .option("--tp <price>", "Take-profit protecting this entry's fill (ondo / arcus: attached to any entry; other venues: --tif IOC entries only)")
    .option("--sl <price>", "Stop-loss protecting this entry's fill (ondo / arcus: attached to any entry; other venues: --tif IOC entries only)")
    .option("--slippage-bps <n>", "Slippage bound in bps for protection-priced TP/SL legs (default: settings slippageBps[venue] → defaultSlippageBps)")
    .action(async (symbol: string, side: string, price: string, rawSize: string, opts: { tif?: string; reduceOnly?: boolean; clientId?: string; autoId?: boolean; force?: boolean; tp?: string; sl?: string; slippageBps?: string }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      const sym = normalizeSymbolArg(symbol);
      // One parsed size for the risk check and the order ("1,000" / "abc" refused up front).
      const size = parsePositiveDecimal(rawSize, "size");

      if (opts.clientId && isOrderDuplicate(opts.clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: opts.clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${opts.clientId}). Skipping.\n`));
        return;
      }

      const adapter = await getAdapter();
      const { def: venueDef, caps: venueCaps } = tradingVenueOf(adapter);
      const clientId = opts.autoId ? autoClientId(venueDef, venueCaps, "limit") : opts.clientId;
      const tif = validateLegacyTif(venueDef, venueCaps, opts.tif ?? DEFAULT_TIF);
      const req: OrderRequest = {
        symbol: sym, side: s as "buy" | "sell", type: "limit", size, price,
        triggerPrice: null, triggerSource: null, tif, reduceOnly: opts.reduceOnly === true,
        clientOrderId: v2ClientOrderId(venueDef, venueCaps, clientId), slippage: null, tpsl: null,
      };
      validateOrderRequest(venueDef, venueCaps, req);
      const prices = entryTpSl(opts);
      if (prices !== null) {
        if (!(Number(price) > 0)) throw new PerpError("INVALID_PARAMS", `limit price must be positive (got "${price}")`);
        refuseGatedReduceOnly(adapter);
        refuseGatedStops(adapter);
        prevalidateEntryTpSl(venueDef, venueCaps, s as "buy" | "sell", req.reduceOnly, tif === "IOC", Number(price), "limit price", prices);
      }
      // TP/SL legs of protection-priced venues (arcus, lighter) use the single resolved bound.
      const slippageFlag = parseSlippageBpsFlag(opts.slippageBps);
      if (slippageFlag !== null && prices === null) {
        throw new PerpError("INVALID_PARAMS", "--slippage-bps applies to --tp/--sl legs of a limit order; a plain limit order has no slippage bound");
      }
      const tpslSlippage = prices !== null ? resolveSlippage(venueDef.id, slippageFlag) : null;

      // Read-only quarantine + risk check before the dry-run return (L5) — same gate as the live order.
      await openingOrderGate(adapter, { symbol: sym, size: Number(size), price: parseFloat(price), reduceOnly: opts.reduceOnly, force: opts.force });

      if (await orderDryRunGuard("limit_order", adapter, sym, { exchange: adapter.name, symbol: sym, side: s, size, price, tif, ...(prices !== null ? { tp: prices.tp ?? "none", sl: prices.sl ?? "none" } : {}) })) return;

      if (clientId) {
        logClientId({
          clientOrderId: clientId, exchange: adapter.name,
          symbol: sym, side: s, size, type: "limit",
          status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }

      let result: PlacedOrder | null;
      let protectedOut: Awaited<ReturnType<typeof placeProtectedEntry>> | null = null;
      try {
        if (prices !== null && tpslSlippage !== null) {
          protectedOut = await placeProtectedEntry(adapter, venueDef, venueCaps, { ...req, slippage: venueCaps.tpsl === "batchGroup" ? tpslSlippage : null }, prices, tpslSlippage);
          result = protectedOut.entry;
        } else {
          result = await placeV2(v2Of(adapter), venueCaps, req);
        }
        logExecution({
          type: "limit_order", exchange: adapter.name, symbol: sym,
          side: s, size, price, status: "success", dryRun: false,
          meta: clientId ? { clientOrderId: clientId } : undefined,
        });
      } catch (err) {
        logExecution({
          type: "limit_order", exchange: adapter.name, symbol: sym,
          side: s, size, price, status: isOutcomeUnknown(err) ? "unverified" : "failed", dryRun: false,
          error: extractErrorMessage(err),
          meta: clientId ? { clientOrderId: clientId } : undefined,
        });
        throw err;
      }

      if (clientId) {
        logClientId({
          clientOrderId: clientId, exchange: adapter.name,
          symbol: sym, side: s, size, type: "limit",
          status: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }

      const header = `Limit ${s.toUpperCase()} ${size} ${sym} @ $${price} on ${adapter.name}${clientId ? ` (id: ${clientId})` : ""}`;
      if (protectedOut !== null) return printProtectedEntry(header, protectedOut, result !== null ? trackedId(result, clientId) : undefined);
      if (result === null) throw new PerpError("EXCHANGE_ERROR", "unreachable: limit order produced no result");
      if (isJson()) return printJson(jsonOk(orderResultJson(result, trackedId(result, clientId))));
      printOrder(header, result);
    });

  supportsDryRun(trade.command("cancel <symbolOrOrderId> [orderId]"))
    .description("Cancel order(s) — by orderId (or c:<clientOrderId> on ondo/arcus/qfex/pacifica), by symbol + orderId / c:<clientOrderId> (every venue with client ids: also hyperliquid, aster, lighter, lighter-rh), or by symbol name (cancels all orders for that symbol)")
    .action(async (symbolOrOrderId: string, orderId?: string) => {
      const adapter = await getAdapter();
      const v2 = v2Of(adapter);

      /** Cancel one order by reference through TradingV2 and print the uniform result. */
      const cancelOne = async (symbol: string, refText: string): Promise<void> => {
        const ref: OrderRef = parseOrderRef(refText);
        if (dryRunGuard("cancel", { exchange: adapter.name, symbol, orderId: refText })) return;
        let result: CancelResult;
        try {
          result = await v2.cancelByRef(symbol, ref);
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: result.failed.length > 0 ? "failed" : (result.pending ?? []).length > 0 ? "unverified" : "success", dryRun: false, meta: { orderId: refText } });
        } catch (err) {
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "failed", dryRun: false, error: extractErrorMessage(err), meta: { orderId: refText } });
          throw err;
        }
        const incomplete = cancelIncompleteError(result, symbol);
        if (incomplete !== null) {
          if (!isJson()) printCancel(result, symbol);
          throw incomplete;
        }
        if (isJson()) return printJson(jsonOk({ ...result, legacy: result.venueRaw }));
        printCancel(result, symbol);
      };

      if (orderId) {
        // cancel <symbol> <orderId>
        await cancelOne(normalizeSymbolArg(symbolOrOrderId), orderId);
        return;
      }

      // Single argument — an order reference (c:<clientOrderId>, numeric / UUID / 0x-hex order id)
      // or a symbol name. An explicit order reference is never treated as a symbol.
      const ref = parseOrderRef(symbolOrOrderId);
      const { def: venueDef } = tradingVenueOf(adapter);
      const twoArgHint = `perp trade cancel <symbol> ${symbolOrOrderId} -e ${venueDef.id}`;
      if (ref.kind === "clientOrderId") {
        // Open-order listings carry no client id, so the symbol cannot be looked up from it.
        if (!SYMBOLLESS_CANCEL_VENUES.has(venueDef.id)) {
          throw new PerpError("INVALID_PARAMS", `${venueDef.displayName} cancels a client order id within a market — the symbol is required`, {
            remediation: `Pass the symbol: ${twoArgHint}`,
          });
        }
        await cancelOne("", symbolOrOrderId);
        return;
      }
      if (looksLikeOrderId(symbolOrOrderId)) {
        // cancel <orderId> — look up symbol from open orders
        const oid = symbolOrOrderId;
        const orders = await adapter.getOpenOrders();
        const match = orders.find((o) => String(o.orderId) === oid);
        if (!match) {
          throw new PerpError("ORDER_NOT_FOUND", `Order ${oid} not found in the open orders on ${venueDef.displayName}; nothing was cancelled`, {
            exchange: adapter.name,
            remediation: `Check open orders (perp account orders -e ${venueDef.id}); if it is a stop / trigger not listed there, pass the symbol: ${twoArgHint}`,
          });
        }
        await cancelOne(match.symbol, oid);
        return;
      }

      // cancel <symbol> — cancel all open orders for this symbol
      const symbol = normalizeSymbolArg(symbolOrOrderId);
      const orders = await adapter.getOpenOrders();
      const matching = orders.filter((o) => symbolMatch(o.symbol, symbol));
      if (matching.length === 0) {
        const err = `No open orders found for ${symbol}`;
        if (isJson()) return printJson(jsonOk({ cancelled: false, symbol, reason: err }));
        console.log(chalk.yellow(`\n  ${err}\n`));
        return;
      }
      if (dryRunGuard("cancel_by_symbol", { exchange: adapter.name, symbol, count: matching.length })) return;
      let result: CancelResult;
      try {
        result = await v2.cancelAllV2(symbol);
        logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: result.failed.length > 0 ? "failed" : (result.pending ?? []).length > 0 ? "unverified" : "success", dryRun: false, meta: { bySymbol: true, count: matching.length } });
      } catch (err) {
        logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "failed", dryRun: false, error: extractErrorMessage(err), meta: { bySymbol: true } });
        throw err;
      }
      const incomplete = cancelIncompleteError(result, symbol);
      if (incomplete !== null) {
        if (!isJson()) printCancel(result, symbol);
        throw incomplete;
      }
      if (isJson()) return printJson(jsonOk({ ...result, symbol, legacy: result.venueRaw }));
      printCancel(result, symbol);
    });

  supportsDryRun(trade.command("cancel-all"))
    .description("Cancel all open orders")
    .action(async () => {
      const adapter = await getAdapter();
      if (dryRunGuard("cancel_all", { exchange: adapter.name })) return;
      // Per-order proof (cancelAllV2): only orders the venue result proves are reported cancelled.
      const result = await v2Of(adapter).cancelAllV2(null);
      logExecution({ type: "cancel", exchange: adapter.name, symbol: "", side: "cancel", size: "0", dryRun: false,
        status: result.failed.length > 0 ? "failed" : (result.pending ?? []).length > 0 ? "unverified" : "success", meta: { all: true, cancelled: result.cancelled.length } });
      const incomplete = cancelIncompleteError(result, "all");
      if (incomplete !== null) {
        if (!isJson()) printCancel(result, "all");
        throw incomplete;
      }
      if (isJson()) return printJson(jsonOk({ ...result, legacy: result.venueRaw }));
      printCancel(result, "all");
    });

  // === TWAP — Pacifica (seconds) + Hyperliquid (minutes) ===

  trade
    .command("twap <symbol> <side> <size> <duration>")
    .description("Place a TWAP order (Pacifica: seconds, HL: minutes, Lighter/any: client-side via --background)")
    .option("--slippage-bps <n>", "Slippage bound in bps for Pacifica native TWAP (default: settings slippageBps[venue] → defaultSlippageBps)")
    .option("--reduce-only", "Reduce only order")
    .option("--background", "Run client-side TWAP in background (tmux) — works on all exchanges")
    .option("--slices <n>", "Number of slices for client-side TWAP")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure)")
    .action(async (symbol: string, side: string, rawSize: string, duration: string, opts: { slippageBps?: string; reduceOnly?: boolean; background?: boolean; slices?: string; force?: boolean }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      // One parsed size for the risk check and the order ("1,000" / "abc" refused up front).
      const size = parsePositiveDecimal(rawSize, "size");

      // --background → client-side TWAP via tmux job
      if (opts.background) {
        const { startJob, jobSelectorsOf } = await import("../jobs.js");
        const bgAdapter = await getAdapter();
        const exchange = bgAdapter.name;
        // Risk check (and its --force bypass) runs here: the child `strategy twap` has none.
        await openingOrderGate(bgAdapter, { symbol: normalizeSymbolArg(symbol), size: Number(size), reduceOnly: opts.reduceOnly, force: opts.force });
        const cliArgs = [
          "strategy", "twap", normalizeSymbolArg(symbol), s, size, duration,
          ...(opts.slices ? ["--slices", opts.slices] : []),
          ...(opts.reduceOnly ? ["--reduce-only"] : []),
        ];
        const job = startJob({
          strategy: "twap",
          exchange,
          params: { symbol: normalizeSymbolArg(symbol), side: s, size, duration, slices: opts.slices, reduceOnly: opts.reduceOnly === true },
          venue: exchange, network: networkOf(program), dryRun: isDryRun(), selectors: jobSelectorsOf(program),
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        console.log(chalk.green(`\n  TWAP job started in background.`));
        console.log(`  ID: ${chalk.white.bold(job.id)}`);
        console.log(`  Session: ${job.tmuxSession}`);
        console.log(`  Logs: ${chalk.gray(`perp background logs ${job.id}`)}`);
        console.log(`  Stop: ${chalk.gray(`perp background stop ${job.id}`)}\n`);
        return;
      }

      const adapter = await getAdapter();

      await openingOrderGate(adapter, { symbol: normalizeSymbolArg(symbol), size: Number(size), reduceOnly: opts.reduceOnly, force: opts.force });

      // Native TWAP: Pacifica (SDK) or Hyperliquid (twapOrder)
      // Fallback: client-side TWAP for any exchange without native support
      let result: unknown;
      if (hasPacificaSdk(adapter)) {
        // One slippage resolver: bps → Pacifica's slippage_percent.
        const slippage = resolveAdapterSlippage(adapter, parseSlippageBpsFlag(opts.slippageBps));
        requirePacificaTwapSigner(adapter, "TWAP order");
        const sdk = adapter.sdk as Record<string, (...args: any[]) => any>;
        result = await sdk.createTWAP(
          {
            symbol: normalizeSymbolArg(symbol),
            amount: size,
            side: s === "buy" ? "bid" : "ask",
            slippage_percent: String(slippage.bps / 100),
            reduce_only: opts.reduceOnly ?? false,
            duration_in_seconds: parseInt(duration),
          },
          adapter.publicKey,
          adapter.signer,
          // No builder_code: Pacifica documents none for create_twap_order (builder-fee.ts).
        );
      } else if (isTwapCapable(adapter)) {
        // Bounds (5 minutes – 7 days, $100 minimum total size) are pre-checked in twapOrder (hlAssertTwapBounds).
        if (!/^\d+$/.test(duration.trim())) errorAndExit("HL TWAP duration must be a whole number of minutes");
        const minutes = Number(duration.trim());
        result = await adapter.twapOrder(
          normalizeSymbolArg(symbol),
          s as "buy" | "sell",
          size,
          minutes,
          { reduceOnly: opts.reduceOnly }
        );
      } else {
        // Client-side TWAP (foreground) for exchanges without native TWAP
        const { runTWAP } = await import("../strategies/twap.js");
        const twapResult = await runTWAP(adapter, {
          symbol: normalizeSymbolArg(symbol),
          side: s as "buy" | "sell",
          totalSize: parseFloat(size),
          durationSec: parseInt(duration),
          slices: opts.slices ? parseInt(opts.slices) : undefined,
          reduceOnly: opts.reduceOnly === true,
        }, undefined, isJson() ? (m: string) => console.error(m) : undefined);
        // JSON mode: progress goes to stderr so stdout stays one JSON document.
        if (isJson()) return printJson(jsonOk(twapResult));
        return;
      }

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  TWAP ${s.toUpperCase()} ${size} ${normalizeSymbolArg(symbol)} over ${duration} placed on ${adapter.name}.\n`));
    });

  // === Stop / Trigger orders (every trading venue) ===

  supportsDryRun(trade.command("stop <symbol> <side> <size> <stopPrice>"))
    .description("Place a stop order (market trigger; --limit-price makes it stop-limit). Reduce-only by default on every venue (BEHAVIOR CHANGE: pass --no-reduce-only to let it open / flip a position). Limit-priced market triggers (lighter, arcus) fill only within trigger ± the slippage bound — a fast move can leave them unfilled")
    .option("--limit-price <price>", "Limit price (makes it stop-limit)")
    .option("--no-reduce-only", "Allow the triggered order to open or flip a position (default: reduce-only)")
    .option("--trigger-type <type>", "Trigger price source: mark | last | mid (pacifica; aster mark | last; other venues: unsupported)")
    .option("--slippage-bps <n>", "Bound for protection-priced market triggers (lighter, arcus, txflow) in bps, around the trigger price (default: settings)")
    .option("--force", "With --no-reduce-only: bypass local risk-limit checks (maxPosition / total exposure)")
    .action(async (symbol: string, side: string, rawSize: string, stopPrice: string, opts: { limitPrice?: string; reduceOnly: boolean; triggerType?: string; slippageBps?: string; force?: boolean }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      const size = parsePositiveDecimal(rawSize, "size");
      if (opts.triggerType && !["mark", "last", "mid"].includes(opts.triggerType)) {
        errorAndExit("--trigger-type must be one of: mark, last, mid");
      }
      const sym = normalizeSymbolArg(symbol);

      const adapter = await getAdapter();
      const { def: venueDef, caps: venueCaps } = tradingVenueOf(adapter);
      const isLimit = opts.limitPrice !== undefined;
      const slippageFlag = parseSlippageBpsFlag(opts.slippageBps);
      if (slippageFlag !== null) {
        if (isLimit) throw new PerpError("INVALID_PARAMS", "--slippage-bps applies to market triggers only; a stop-limit executes at --limit-price");
        if (venueDef.family !== "lighter" && venueDef.id !== "arcus" && venueDef.id !== "txflow") {
          throw unsupported(venueDef.displayName, "stopSlippage", "market triggers on this venue are venue-native market orders (no slippage bound)", "Omit --slippage-bps, or use --limit-price");
        }
      }
      const req: OrderRequest = {
        symbol: sym, side: s as "buy" | "sell", type: isLimit ? "stopLimit" : "stopMarket", size,
        price: isLimit ? opts.limitPrice as string : null,
        triggerPrice: stopPrice,
        triggerSource: opts.triggerType !== undefined ? opts.triggerType as "mark" | "last" | "mid" : null,
        tif: isLimit ? validateLegacyTif(venueDef, venueCaps, DEFAULT_TIF) : null,
        reduceOnly: opts.reduceOnly !== false,
        clientOrderId: v2ClientOrderId(venueDef, venueCaps, undefined),
        // Market triggers carry the resolved bound (used by protection-priced venues; native triggers ignore it).
        slippage: isLimit ? null : resolveSlippage(venueDef.id, slippageFlag),
        tpsl: null,
      };
      validateOrderRequest(venueDef, venueCaps, req);

      // --no-reduce-only can open / flip: quarantine + risk limits at the price it would execute at
      // (limit price, else the trigger), before the dry-run return. Reduce-only stops are exempt.
      if (!req.reduceOnly) {
        await openingOrderGate(adapter, { symbol: sym, size: Number(size), price: parseFloat(opts.limitPrice ?? stopPrice), force: opts.force });
      }

      if (await orderDryRunGuard("stop_order", adapter, sym, { exchange: adapter.name, symbol: sym, side: s, size, price: stopPrice, reduceOnly: req.reduceOnly })) return;
      let result: PlacedOrder;
      try {
        result = await placeV2(v2Of(adapter), venueCaps, req);
        logExecution({ type: "stop_order", exchange: adapter.name, symbol: sym, side: s, size, price: stopPrice, status: "success", dryRun: false, meta: { reduceOnly: req.reduceOnly } });
      } catch (err) {
        logExecution({ type: "stop_order", exchange: adapter.name, symbol: sym, side: s, size, price: stopPrice, status: isOutcomeUnknown(err) ? "unverified" : "failed", dryRun: false, error: extractErrorMessage(err), meta: { reduceOnly: req.reduceOnly } });
        throw err;
      }

      if (isJson()) return printJson(jsonOk(orderResultJson(result, { reduceOnly: req.reduceOnly })));
      printOrder(`Stop ${s.toUpperCase()} ${size} ${sym} @ trigger $${stopPrice}${isLimit ? ` (limit $${opts.limitPrice})` : ""}${req.reduceOnly ? " (reduce-only)" : " (may open / flip)"} on ${adapter.name}`, result);
    });

  // === TP/SL on an open position (every venue with TP/SL) ===

  supportsDryRun(trade.command("tpsl <symbol> <positionSide>"))
    .description("Set take-profit / stop-loss on an OPEN position. positionSide = the position's side: long | short (BEHAVIOR CHANGE: buy/sell no longer accepted). Checked against the live position; legs are reduce-only and sized to the live position (or --size)")
    .option("--tp <price>", "Take-profit trigger price (long: above mark; short: below)")
    .option("--tp-limit <price>", "Take-profit limit price once triggered (default: market trigger)")
    .option("--sl <price>", "Stop-loss trigger price (long: below mark; short: above)")
    .option("--size <size>", "Protect only this much of the position (≤ position size; pacifica: whole position only)")
    .option("--slippage-bps <n>", "Bound for protection-priced market triggers (lighter, arcus, txflow) in bps (default: settings)")
    .action(async (symbol: string, positionSide: string, opts: { tp?: string; tpLimit?: string; sl?: string; size?: string; slippageBps?: string }) => {
      const ps = positionSide.toLowerCase();
      if (ps !== "long" && ps !== "short") {
        throw new PerpError("INVALID_PARAMS", `positionSide must be long or short (got "${positionSide}")`, {
          remediation: "Pass the side of the position to protect: long or short (buy/sell were ambiguous and are no longer accepted)",
        });
      }
      const prices: TpSlPrices = { tp: positivePriceOpt(opts.tp, "--tp"), sl: positivePriceOpt(opts.sl, "--sl") };
      if (prices.tp === null && prices.sl === null) throw new PerpError("INVALID_PARAMS", "Must specify --tp and/or --sl");
      const tpLimit = positivePriceOpt(opts.tpLimit, "--tp-limit");
      if (tpLimit !== null && prices.tp === null) throw new PerpError("INVALID_PARAMS", "--tp-limit needs --tp");
      const sym = normalizeSymbolArg(symbol);

      const adapter = await getAdapter();
      const { def, caps } = tradingVenueOf(adapter);
      if (caps.tpsl === null) {
        throw unsupported(def.displayName, "tpsl", "the venue has no TP/SL orders", `Use stop orders: perp trade stop -e ${def.id} ...`);
      }
      if (opts.size !== undefined && caps.tpsl === "positionLevel") {
        throw unsupported(def.displayName, "tpslSize", "TP/SL is position-level and always covers the whole position", "Omit --size");
      }
      refuseGatedReduceOnly(adapter);
      refuseGatedStops(adapter);
      const slippage = resolveSlippage(def.id, parseSlippageBpsFlag(opts.slippageBps));

      // Validate against the live position (side, size, mark).
      invalidateCache("acct");
      const pos = (await adapter.getPositions()).find(p => symbolMatch(p.symbol, sym));
      if (pos === undefined) {
        throw new PerpError("INVALID_PARAMS", `No open ${sym} position on ${def.displayName} to protect`, { exchange: def.id, remediation: `Check: perp account positions -e ${def.id}` });
      }
      if (pos.side !== ps) {
        throw new PerpError("INVALID_PARAMS", `The ${sym} position on ${def.displayName} is ${pos.side}, not ${ps}`, { exchange: def.id, remediation: `Run: perp trade tpsl ${sym} ${pos.side} ... -e ${def.id}` });
      }
      const posSize = pos.size.replace(/^-/, "");
      if (!(Number(posSize) > 0)) throw new PerpError("EXCHANGE_ERROR", `${def.displayName} reports ${sym} position size "${pos.size}"`, { exchange: def.id });
      let size = posSize;
      if (opts.size !== undefined) {
        if (!(Number(opts.size) > 0)) throw new PerpError("INVALID_PARAMS", `--size must be positive (got "${opts.size}")`);
        if (Number(opts.size) > Number(posSize)) throw new PerpError("INVALID_PARAMS", `--size ${opts.size} exceeds the ${sym} position size ${posSize}`);
        size = opts.size;
      }
      const mark = Number(pos.markPrice) > 0 ? Number(pos.markPrice) : await markPriceOf(adapter, sym);
      checkTpSlDirection(ps, mark, "mark price", prices);
      const closeSide = ps === "long" ? "sell" : "buy";

      if (await orderDryRunGuard("tpsl", adapter, sym, { exchange: adapter.name, symbol: sym, positionSide: ps, size, tp: prices.tp ?? "none", sl: prices.sl ?? "none" })) return;

      const legs: TpSlLegOutcome[] = [];
      const hint = `perp account orders -e ${def.id}`;
      const failAfter = (failed: string, e: unknown): unknown => legs.length === 0 ? e : new PerpError("ORDER_PARTIAL",
        `TP/SL only partially set on ${sym}: ${legs.map(legLabel).join(", ")} placed, then ${failed} failed — ${extractErrorMessage(e)}`, {
          exchange: def.id,
          legsPlaced: legs.map(l => ({ kind: l.kind, trigger: l.trigger, orderId: l.result !== null ? l.result.orderId : null })),
          failedLeg: failed,
          remediation: `The position is protected on one side only. Inspect with: ${hint}, then place the missing leg or cancel the placed one.`,
        });

      if (caps.tpsl === "positionLevel") {
        const pac = positionTpSlAdapter(adapter);
        await refuseExistingPositionTpSl(pac, def, sym);
        const raw = await pac.setPositionTpSl(sym, ps, { tp: prices.tp, tpLimit, sl: prices.sl });
        legs.push({ kind: "tpsl", trigger: `tp ${prices.tp ?? "-"} / sl ${prices.sl ?? "-"}`, result: null, venueRaw: raw });
      } else {
        for (const [kind, trigger] of [["tp", prices.tp], ["sl", prices.sl]] as const) {
          if (trigger === null) continue;
          const limitPrice = kind === "tp" ? tpLimit : null;
          try {
            let r: OrderResult;
            if (caps.tpsl === "separateOrders") {
              r = await placeTpSlLeg(adapter, network(), { symbol: sym, closeSide, size, trigger, kind, limitPrice, slippage });
            } else {
              // attached (ondo) / batchGroup (arcus): a reduce-only position stop / TPSL leg (type chosen by the venue adapter).
              const req: OrderRequest = {
                symbol: sym, side: closeSide, type: limitPrice !== null ? "stopLimit" : "stopMarket", size,
                price: limitPrice, triggerPrice: trigger, triggerSource: null,
                tif: limitPrice !== null ? validateLegacyTif(def, caps, DEFAULT_TIF) : null,
                reduceOnly: true, clientOrderId: v2ClientOrderId(def, caps, undefined),
                slippage: limitPrice !== null ? null : slippage, tpsl: null,
              };
              validateOrderRequest(def, caps, req);
              r = await placeV2(v2Of(adapter), caps, req);
            }
            legs.push({ kind, trigger, result: r, venueRaw: r.venueRaw });
          } catch (e) {
            throw failAfter(legLabel({ kind, trigger }), e);
          }
        }
      }
      logExecution({ type: "stop_order", exchange: adapter.name, symbol: sym, side: closeSide, size, price: prices.sl ?? prices.tp ?? "", status: "success", dryRun: false, meta: { action: "tpsl", positionSide: ps, tp: prices.tp, sl: prices.sl } });

      if (isJson()) {
        return printJson(jsonOk({
          symbol: sym, positionSide: ps, size, method: caps.tpsl,
          legs: legs.map(l => ({ kind: l.kind, trigger: l.trigger, ...(l.result !== null ? orderResultJson(l.result) : { venueRaw: l.venueRaw }) })),
        }));
      }
      console.log(chalk.green(`\n  TP/SL set for ${ps} ${size} ${sym} on ${def.displayName} (${caps.tpsl}, reduce-only):`));
      for (const l of legs) {
        console.log(chalk.green(`  ${legLabel(l)}`));
        if (l.result !== null) for (const line of formatOrderResult(l.result)) console.log(line);
      }
      console.log();
    });

  // === Scaled Take-Profit (분할익절) ===

  supportsDryRun(trade.command("scale-tp <symbol>"))
    .description("Place multiple take-profit limit orders at different price levels (분할익절)")
    .requiredOption("--levels <levels>", "[required] Comma-separated price:percent pairs (e.g., 72000:25,75000:25,80000:50)")
    .option("--size <size>", "Override total position size (default: uses current position)")
    .action(async (symbol: string, opts: { levels: string; size?: string }) => {
      const sym = normalizeSymbolArg(symbol);
      const adapter = await getAdapter();
      if (adapter.name === "ondo") {
        // docs.ondoperps.xyz take-profit-and-stop-loss: position TP/SL "Via Risk Management Module
        // [POST /v1/perps/stop_order] ... applies to the full position, with a limit of one TP and one
        // SL per market"; partial legs only "At Order Placement" (attached to each entry order). A
        // resting reduce-only limit is refused too (reduce_only_invalid_tif) — no multi-level TP on a held position.
        throw unsupported("Ondo", "scaleTp",
          "position-level stops allow one TP and one SL per market (docs: take-profit-and-stop-loss), and resting reduce-only limits are refused",
          `Set one (partial) take-profit: perp trade tpsl ${sym} <long|short> --tp <price> [--size <qty>] -e ondo, or attach --tp to each entry order`);
      }

      // Parse levels: "72000:25,75000:25,80000:50"
      const levels = opts.levels.split(",").map(l => {
        const [price, pct] = l.trim().split(":");
        if (!price || !pct) errorAndExit(`Invalid level format: ${l}. Use price:percent (e.g., 72000:25)`);
        return { price: price.trim(), pct: parseFloat(pct.trim()) };
      });

      // Validate percentages sum to 100
      const totalPct = levels.reduce((s, l) => s + l.pct, 0);
      if (Math.abs(totalPct - 100) > 0.01) {
        errorAndExit(`Percentages must sum to 100%. Got: ${totalPct}%`);
      }

      // Get current position to determine size and side
      let total: string;
      let closeSide: "buy" | "sell";

      // The position decides the close side (and, without --size, the total). symbolMatch: venues
      // report "ETH-PERP" (Hyperliquid) or "xyz:NVDA" (HIP-3) for the user's "ETH" / "NVDA".
      const pos = (await adapter.getPositions()).find(p => symbolMatch(p.symbol, sym));
      if (pos === undefined) {
        // Never a guessed side: a take-profit on the wrong side would not reduce the position.
        throw new PerpError("INVALID_PARAMS", `No open ${sym} position on ${adapter.name} — scale-tp places reduce-only take-profits on an open position`, {
          exchange: adapter.name, remediation: `Check: perp account positions -e ${adapter.name}`,
        });
      }
      const held = pos.size.replace(/^-/, "");
      // Reduce-only take-profits can never add up to more than the position.
      if (opts.size !== undefined && Number(opts.size) > Number(held)) {
        throw new PerpError("SIZE_TOO_LARGE", `scale-tp --size ${opts.size} exceeds the open ${sym} ${pos.side} position (${held}) on ${adapter.name} — nothing was sent`, {
          exchange: adapter.name, position: held, positionSide: pos.side,
          remediation: `Use --size of at most ${held}, or omit --size to scale the whole position`,
        });
      }
      total = opts.size ? opts.size : held;
      closeSide = pos.side === "long" ? "sell" : "buy";

      // Level sizes on the venue lot (remainder to the last level), validated before anything is sent.
      const sizes = scaleLevelSizes(total, levels.map(l => l.pct), await lotStepOf(adapter, sym));
      const plan = levels.map((l, i) => ({ price: l.price, size: sizes[i], pct: l.pct }));
      const reqs = await scaleRequests(adapter, sym, closeSide, true, plan);

      if (dryRunGuard("scale_tp", {
        exchange: adapter.name, symbol: sym, side: closeSide,
        totalSize: total,
        levels: plan.map(l => `${l.price}@${l.pct}% (${l.size})`).join(", "),
      })) return;

      // Place reduce-only limit orders at each level
      const results = await placeScaleLevels(adapter, "scale-tp", sym, closeSide, plan, reqs);
      const incomplete = scaleIncompleteError(adapter.name, `scale-tp ${sym}`, results);
      if (incomplete !== null) {
        if (!isJson()) printScaleLevels(`Scaled TP for ${sym} on ${adapter.name} is INCOMPLETE:`, sym, results);
        throw incomplete;
      }

      if (isJson()) return printJson(jsonOk({ symbol: sym, side: closeSide, totalSize: Number(total), levels: results }));
      printScaleLevels(`Scaled TP set for ${sym} on ${adapter.name}:`, sym, results);
    });

  // === Pacifica-only commands ===

  supportsDryRun(trade.command("edit <symbol> <orderId> <price> <size>"))
    .description("Edit an existing order: new price and new open (unfilled) size; the order keeps its TIF / post-only (pacifica: TIF read from the order's client id — ALO via native edit, GTC / TOB via cancel+replace; a new order id either way) — use the orderId the edit returns; orderId, or c:<clientOrderId> on ondo/arcus/qfex (qfex: plain LIMIT / ALO only; the venue assigns a new order id, the client id is kept)")
    .option("--tif <tif>", "Time-in-force of the replacement (ondo / pacifica only; ALO keeps post-only)")
    .option("--force-tif", "Allow --tif to flip the order's post-only flag (ondo / pacifica); otherwise such a conflict is refused")
    .action(async (symbol: string, orderId: string, price: string, size: string, opts: { tif?: string; forceTif?: boolean }) => {
      const adapter = await getAdapter();
      prevalidateAmend(adapter);
      const { def: venueDef, caps: venueCaps } = tradingVenueOf(adapter);
      const amendTif: TimeInForce | null = opts.tif !== undefined ? validateLegacyTif(venueDef, venueCaps, opts.tif) : null;
      if (opts.forceTif === true && amendTif === null) throw new PerpError("INVALID_PARAMS", "--force-tif needs --tif");
      if (dryRunGuard("edit_order", { exchange: adapter.name, symbol: normalizeSymbolArg(symbol), orderId, price, size })) return;
      const result = await v2Of(adapter).amendOrder({ symbol: normalizeSymbolArg(symbol), ref: parseOrderRef(orderId), price, size, tif: amendTif, forceTif: opts.forceTif === true });
      if (isJson()) return printJson(jsonOk(orderResultJson(result)));
      printOrder(`Edit of ${orderId} → $${price} x ${size} on ${adapter.name}`, result);
    });

  trade
    .command("cancel-stop <symbol> <stopOrderId>")
    .description("Cancel a stop / TP / SL order (pacifica; qfex: stop order id or c:<clientOrderId>; other venues: perp trade cancel)")
    .action(async (symbol: string, stopOrderId: string) => {
      const adapter = await getAdapter();
      if (adapter.name === "qfex" && isTradingV2(adapter)) {
        // QFEX: cancelByRef reads the row first and routes a TAKE_PROFIT / STOP_LOSS row to cancel_stop_order.
        const sym = normalizeSymbolArg(symbol);
        if (dryRunGuard("cancel_stop", { exchange: adapter.name, symbol: sym, stopOrderId })) return;
        const r = await adapter.cancelByRef(sym, parseOrderRef(stopOrderId));
        const incomplete = cancelIncompleteError(r, sym);
        if (incomplete !== null) { if (!isJson()) printCancel(r, sym); throw incomplete; }
        if (isJson()) return printJson(jsonOk({ ...r, legacy: r.venueRaw }));
        printCancel(r, sym);
        return;
      }
      const pac = adapter as ExchangeAdapter & Partial<Pick<PacificaAdapter, "cancelStopOrder">>;
      if (typeof pac.cancelStopOrder !== "function") {
        const { def } = tradingVenueOf(adapter);
        throw unsupported(def.displayName, "cancelStop", "stop orders are cancelled like any other order on this venue", `Use: perp trade cancel ${normalizeSymbolArg(symbol)} <orderId> -e ${def.id}`);
      }
      const result = await pac.cancelStopOrder(symbol, stopOrderId);
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Stop order ${stopOrderId} cancelled.\n`));
    });

  trade
    .command("cancel-twap <symbol> <twapOrderId>")
    .description("Cancel a TWAP order")
    .action(async (symbol: string, twapOrderId: string) => {
      if (!/^\d+$/.test(twapOrderId)) {
        throw new PerpError("INVALID_PARAMS", `TWAP order id must be a whole number (got "${twapOrderId}")`, {
          remediation: "Pass the numeric TWAP id the venue reported when the TWAP was placed",
        });
      }
      const adapter = await getAdapter();

      let result: unknown;
      if (hasPacificaSdk(adapter)) {
        requirePacificaTwapSigner(adapter, "TWAP cancel");
        const sdk = adapter.sdk as Record<string, (...args: any[]) => any>;
        result = await sdk.cancelTWAP(
          { symbol: normalizeSymbolArg(symbol), order_id: Number(twapOrderId) },
          adapter.publicKey,
          adapter.signer
        );
      } else if (isTwapCapable(adapter)) {
        result = await adapter.twapCancel(normalizeSymbolArg(symbol), Number(twapOrderId));
      } else {
        errorAndExit("Cancel TWAP requires --exchange pacifica or hyperliquid");
      }

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  TWAP order ${twapOrderId} cancelled on ${adapter.name}.\n`));
    });

  // === Pacifica-only order types (trade atomic) ===
  registerPacificaOrderCommands(trade, getAdapter, isJson, isDryRun);

  // === Hyperliquid-only commands ===

  supportsDryRun(trade.command("leverage <symbol> <leverage>"))
    .description("Set leverage for a symbol")
    .option("--isolated", "Use isolated margin mode (default: cross)")
    .action(async (symbol: string, leverage: string, opts: { isolated?: boolean }) => {
      if (!/^[1-9]\d*$/.test(leverage.trim())) {
        throw new PerpError("INVALID_PARAMS", `leverage must be a positive whole number (got "${leverage}")`, {
          remediation: "Pass an integer leverage, e.g. perp trade leverage BTC 5",
        });
      }
      const lev = Number(leverage.trim());
      const adapter = await getAdapter();
      const mode = opts.isolated ? "isolated" : "cross";
      if (dryRunGuard("set_leverage", { exchange: adapter.name, symbol: normalizeSymbolArg(symbol), leverage: lev, mode })) return;
      try {
        const result = await adapter.setLeverage(normalizeSymbolArg(symbol), lev, mode);

        logExecution({
          type: "rebalance", exchange: adapter.name, symbol: normalizeSymbolArg(symbol), side: mode,
          size: leverage, status: "success", dryRun: false,
          meta: { action: "set_leverage", leverage: lev, mode },
        });

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Leverage set to ${leverage}x (${mode}) for ${normalizeSymbolArg(symbol)} on ${adapter.name}.\n`));
      } catch (err) {
        logExecution({
          type: "rebalance", exchange: adapter.name, symbol: normalizeSymbolArg(symbol), side: mode,
          size: leverage, status: "failed", dryRun: false,
          error: extractErrorMessage(err),
          meta: { action: "set_leverage", leverage: lev, mode },
        });
        throw err;
      }
    });

  // grid/dca moved to 'perp strategy grid' / 'perp strategy dca'

  // ── Position Management Shortcuts ──

  interface VerifiedCloseOutcome {
    symbol: string;
    side: "buy" | "sell";
    originalSide: "long" | "short";
    requested: string;
    /** Verified closed size (position delta / venue-final fill), floored to the requested precision. */
    closed: string;
    /** Requested size still open after the close (and one residual retry); "0" = fully closed. */
    residual: string;
    note: string | null;
    smart: { method: string; price: string; bestBookPrice: string } | null;
  }

  /**
   * One verified reduce-only close: closePerpVerified (placePerpVerified
   * + one residual market close), so the reported `closed` is a measured / venue-final fill, never
   * the requested size. Logged "success" only when fully verified. A residual or an unknown outcome
   * quarantines the symbol (CLI path "trade-close"); a definite rejection propagates unchanged.
   */
  async function closeVerified(
    adapter: ExchangeAdapter, symbol: string, originalSide: "long" | "short", size: string,
    opts: { smart: boolean; slippage: ResolvedSlippage; action: string },
  ): Promise<VerifiedCloseOutcome> {
    const side: "buy" | "sell" = originalSide === "long" ? "sell" : "buy";
    const dec = sizeDecimalsOf(size);
    let smart: VerifiedCloseOutcome["smart"] = null;
    const place = opts.smart
      ? async () => {
        const sr = await smartOrder(adapter, symbol, side, size, { reduceOnly: true, slippage: opts.slippage });
        smart = { method: sr.method, price: sr.price, bestBookPrice: sr.bestBookPrice };
        return sr.result;
      }
      : undefined;
    const log = (m: string) => { if (!isJson()) console.log(chalk.red(m)); };
    const meta = { action: opts.action, originalSide, smart: opts.smart };
    let c: Awaited<ReturnType<typeof closePerpVerified>>;
    try {
      c = await closePerpVerified(adapter, adapter.name, symbol, side, size, { decimals: dec, slippage: opts.slippage, ...(place !== undefined ? { place } : {}) });
    } catch (e) {
      logExecution({ type: "market_order", exchange: adapter.name, symbol, side, size, status: isOutcomeUnknown(e) ? "unverified" : "failed", dryRun: false, error: extractErrorMessage(e), meta });
      if (isOutcomeUnknown(e)) {
        quarantineSymbol("trade-close", symbol, `${opts.action} ${side} ${size} ${symbol} on ${adapter.name}: outcome unknown (${extractErrorMessage(e)})`,
          `Check ${symbol} on ${adapter.name} (perp -e ${adapter.name} account positions); fix by hand, then: perp strategy quarantine-clear ${symbol}`, log);
      }
      throw e;
    }
    const closed = fillSizeString(c.closed, dec);
    const residual = fillSizeString(c.residual, dec);
    if (c.residual > 0) {
      logExecution({ type: "market_order", exchange: adapter.name, symbol, side, size: closed, status: "failed", dryRun: false,
        error: `residual ${residual} of ${size} still open${c.note !== null ? ` (${c.note})` : ""}`, meta: { ...meta, requested: size, residual } });
      quarantineSymbol("trade-close", symbol, `${opts.action} ${symbol} on ${adapter.name}: closed ${closed} of ${size}, ${residual} still open${c.note !== null ? ` (${c.note})` : ""}`,
        `Check ${symbol} on ${adapter.name} (perp -e ${adapter.name} account positions); close the residual by hand, then: perp strategy quarantine-clear ${symbol}`, log);
    } else {
      logExecution({ type: "market_order", exchange: adapter.name, symbol, side, size: closed, status: "success", dryRun: false, meta: { ...meta, requested: size } });
    }
    return { symbol, side, originalSide, requested: size, closed, residual, note: c.note, smart };
  }

  /** Human line for one verified close. */
  function printCloseOutcome(o: VerifiedCloseOutcome): void {
    if (Number(o.residual) > 0) {
      console.log(chalk.red(`  ✗ ${o.symbol}: closed ${o.closed} of ${o.requested} (${o.originalSide}) — ${o.residual} STILL OPEN${o.note !== null ? ` (${o.note})` : ""}; quarantined`));
    } else {
      console.log(chalk.green(`  ✓ ${o.symbol}: closed ${o.closed} (${o.originalSide}, verified)${o.smart !== null ? ` [${o.smart.method}]` : ""}`));
    }
  }

  /** One close that threw (close-all / flatten keep going with the remaining positions). */
  interface CloseFailure { symbol: string; side: "long" | "short"; size: string; error: string; code: string | null }

  /** Residuals or failed closes → ORDER_PARTIAL (non-zero exit) carrying every close outcome and failure. */
  function residualError(venue: string, outcomes: VerifiedCloseOutcome[], failures: CloseFailure[] = []): PerpError | null {
    const open = outcomes.filter(o => Number(o.residual) > 0);
    if (open.length === 0 && failures.length === 0) return null;
    const parts = [
      ...open.map(o => `${o.symbol} ${o.residual} still open after a verified close`),
      ...failures.map(f => `${f.symbol} close failed: ${f.error}`),
    ];
    return new PerpError("ORDER_PARTIAL", `${venue}: ${parts.join("; ")}`, {
      exchange: venue, closes: outcomes, failures,
      remediation: `Check positions (perp -e ${venue} account positions), close the residual by hand, then clear the quarantine: perp strategy quarantine-clear <symbol>`,
    });
  }

  /** Close every position, continuing past a close that throws; returns all outcomes and failures. */
  async function closeEach(adapter: ExchangeAdapter, positions: ExchangePosition[], opts: { smart: boolean; slippage: ResolvedSlippage; action: string }): Promise<{ outcomes: VerifiedCloseOutcome[]; failures: CloseFailure[] }> {
    const outcomes: VerifiedCloseOutcome[] = [];
    const failures: CloseFailure[] = [];
    for (const pos of positions) {
      const size = pos.size.replace(/^-/, "");
      if (!isJson()) console.log(chalk.gray(`  ${pos.side === "long" ? "SELL" : "BUY"} ${size} ${pos.symbol} (closing ${pos.side})...`));
      try {
        const o = await closeVerified(adapter, pos.symbol, pos.side, size, opts);
        outcomes.push(o);
        if (!isJson()) printCloseOutcome(o);
      } catch (e) {
        const f: CloseFailure = { symbol: pos.symbol, side: pos.side, size, error: extractErrorMessage(e), code: e instanceof PerpError ? e.structured.code : null };
        failures.push(f);
        if (!isJson()) console.log(chalk.red(`  ✗ ${pos.symbol}: close FAILED — ${f.error}`));
      }
    }
    return { outcomes, failures };
  }

  supportsDryRun(trade.command("close-all"))
    .description("Close all open positions (verified reduce-only closes on the opposite side)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
    .action(async (opts: { smart?: boolean; slippageBps?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        refuseGatedReduceOnly(adapter);
        const slippage = resolveAdapterSlippage(adapter, parseSlippageBpsFlag(opts.slippageBps));
        if (dryRunGuard("close_all", { exchange: adapter.name, smart: !!opts.smart })) return;
        invalidateCache("acct");
        const positions = await adapter.getPositions();
        if (positions.length === 0) {
          if (isJson()) return printJson(jsonOk({ closed: 0, positions: [] }));
          console.log(chalk.yellow("\n  No open positions to close.\n"));
          return;
        }
        if (!isJson()) console.log(chalk.cyan(`\n  Closing ${positions.length} position(s) on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));
        const { outcomes, failures } = await closeEach(adapter, positions, { smart: !!opts.smart, slippage, action: "close-all" });
        const partial = residualError(adapter.name, outcomes, failures);
        if (partial !== null) throw partial;
        await orphanedReduceOnly(adapter, null, false);
        if (isJson()) return printJson(jsonOk({ closed: outcomes.length, results: outcomes }));
        console.log(chalk.green(`\n  Closed ${outcomes.length} position(s) on ${adapter.name} (verified).\n`));
      });
    });

  supportsDryRun(trade.command("close <symbol>"))
    .description("Close a specific symbol's position (verified reduce-only close)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
    .action(async (symbol: string, opts: { smart?: boolean; slippageBps?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const sym = normalizeSymbolArg(symbol);
        const adapter = await getAdapter();
        refuseGatedReduceOnly(adapter);
        const slippage = resolveAdapterSlippage(adapter, parseSlippageBpsFlag(opts.slippageBps));
        invalidateCache("acct");
        const positions = await adapter.getPositions();
        const pos = positions.find(p => symbolMatch(p.symbol, sym));
        if (!pos) {
          throw new PerpError("POSITION_NOT_FOUND", `No open position for ${sym} on ${adapter.name}; nothing was closed`, {
            exchange: adapter.name, remediation: `Check positions: perp account positions -e ${adapter.name}`,
          });
        }
        const size = pos.size.replace(/^-/, "");
        const closeSide = pos.side === "long" ? "sell" : "buy";
        if (await orderDryRunGuard("close", adapter, sym, { exchange: adapter.name, symbol: sym, side: closeSide, size, originalSide: pos.side, smart: !!opts.smart })) return;
        if (!isJson()) console.log(chalk.cyan(`\n  Closing ${pos.side} ${size} ${sym} on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));
        const o = await closeVerified(adapter, pos.symbol, pos.side, size, { smart: !!opts.smart, slippage, action: "close" });
        const partial = residualError(adapter.name, [o]);
        if (!isJson()) printCloseOutcome(o);
        if (partial !== null) throw partial;
        await orphanedReduceOnly(adapter, sym, false);
        if (isJson()) return printJson(jsonOk({ ...o, verified: true }));
        console.log();
      });
    });

  supportsDryRun(trade.command("flatten"))
    .description("Cancel all orders AND close all positions (full cleanup, verified)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
    .action(async (opts: { smart?: boolean; slippageBps?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        refuseGatedReduceOnly(adapter);
        const slippage = resolveAdapterSlippage(adapter, parseSlippageBpsFlag(opts.slippageBps));
        if (dryRunGuard("flatten", { exchange: adapter.name, smart: !!opts.smart })) return;
        if (!isJson()) console.log(chalk.cyan(`\n  Flattening account on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));

        // Step 1: Cancel all orders (per-order proof)
        if (!isJson()) console.log(chalk.gray("  Cancelling all open orders..."));
        const cancelResult = await v2Of(adapter).cancelAllV2(null);
        if (!isJson()) printCancel(cancelResult, "all");

        // Step 2: Close all positions (verified)
        invalidateCache("acct");
        const positions = await adapter.getPositions();
        const { outcomes, failures } = await closeEach(adapter, positions, { smart: !!opts.smart, slippage, action: "flatten" });
        // QFEX: reduce-only / stop orders still listed on a now-flat symbol (placed meanwhile, or not
        // covered by cancel-all) are cancelled one by one — the venue leaves them open (Q2).
        const orphanCancels = await orphanedReduceOnly(adapter, null, true);
        if (orphanCancels !== null) {
          cancelResult.cancelled.push(...orphanCancels.cancelled);
          cancelResult.failed.push(...orphanCancels.failed);
          (cancelResult.pending ??= []).push(...(orphanCancels.pending ?? []));
        }
        const partial = residualError(adapter.name, outcomes, failures);
        const cancelIncomplete = cancelIncompleteError(cancelResult, "all");
        if (partial !== null || cancelIncomplete !== null) {
          // Not fully flat: every cancel and close outcome so far rides on one ORDER_PARTIAL (non-zero exit).
          const messages = [cancelIncomplete?.message, partial?.message].filter((m): m is string => typeof m === "string");
          throw new PerpError("ORDER_PARTIAL", `${adapter.name} flatten incomplete: ${messages.join(" | ")}`, {
            exchange: adapter.name, ordersCancelled: cancelResult, closes: outcomes, failures,
            remediation: `Check open orders and positions: perp -e ${adapter.name} account orders / account positions; clear a quarantine with perp strategy quarantine-clear <symbol>`,
          });
        }
        if (isJson()) return printJson(jsonOk({ ordersCancelled: cancelResult, positionsClosed: outcomes.length, closeResults: outcomes }));
        console.log(chalk.green(`\n  Flattened: ${cancelResult.cancelled.length} order(s) cancelled + ${outcomes.length} position(s) closed (verified) on ${adapter.name}.\n`));
      });
    });

  supportsDryRun(trade.command("reduce <symbol> <percent>"))
    .description("Reduce a position by a percentage (e.g., perp trade reduce BTC 50)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
    .action(async (symbol: string, percent: string, opts: { smart?: boolean; slippageBps?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const sym = normalizeSymbolArg(symbol);
        const pct = parseFloat(percent);
        if (isNaN(pct) || pct <= 0 || pct > 100) errorAndExit("Percent must be between 0 and 100");

        const adapter = await getAdapter();
        refuseGatedReduceOnly(adapter);
        const slippage = resolveAdapterSlippage(adapter, parseSlippageBpsFlag(opts.slippageBps));
        invalidateCache("acct");
        const positions = await adapter.getPositions();
        const pos = positions.find(p => symbolMatch(p.symbol, sym));
        if (!pos) {
          throw new PerpError("POSITION_NOT_FOUND", `No open position for ${sym} on ${adapter.name}; nothing was reduced`, {
            exchange: adapter.name, remediation: `Check positions: perp account positions -e ${adapter.name}`,
          });
        }
        // Reduce-only close size: position size × percent floored to the market's LOT step from the
        // venue market info (lotStepOf) — never to the decimals the position size happens to print
        // (QFEX GOLD-USD /refdata lot_size "0.0001": 50% of 0.003 is 0.0015, not 0.001). 100% →
        // the exact position size. Floored, so it can never exceed the position.
        const posSize = pos.size.replace(/^-/, "");
        let reduceSize = posSize;
        if (pct !== 100) {
          const sizeStep = await lotStepOf(adapter, pos.symbol);
          reduceSize = floorSize((parseFloat(posSize) * pct / 100).toFixed((sizeStep.split(".")[1] ?? "").length + 6), sizeStep);
        }
        if (parseFloat(reduceSize) > parseFloat(posSize)) {
          throw new PerpError("INVALID_PARAMS", `Computed reduce size ${reduceSize} exceeds position size ${posSize}`);
        }
        const closeSide = pos.side === "long" ? "sell" : "buy";
        if (await orderDryRunGuard("reduce", adapter, sym, { exchange: adapter.name, symbol: sym, side: closeSide, size: reduceSize, percent: pct, originalSize: pos.size, smart: !!opts.smart })) return;
        if (!isJson()) console.log(chalk.cyan(`\n  Reducing ${sym} ${pos.side} by ${pct}% (${reduceSize} of ${pos.size}) on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));
        const o = await closeVerified(adapter, pos.symbol, pos.side, reduceSize, { smart: !!opts.smart, slippage, action: "reduce" });
        const partial = residualError(adapter.name, [o]);
        if (!isJson()) printCloseOutcome(o);
        if (partial !== null) throw partial;
        await orphanedReduceOnly(adapter, sym, false);
        if (isJson()) return printJson(jsonOk({ reduced: true, percent: pct, sizeReduced: o.closed, requested: reduceSize, originalSize: pos.size, residual: o.residual, result: o }));
        console.log(chalk.green(`\n  Reduced ${sym} by ${o.closed} (${closeSide}, verified) on ${adapter.name}.\n`));
      });
    });

  // ── Order Status Query ──

  trade
    .command("status <orderId>")
    .description("Query order status by ID (ondo/arcus/qfex/lighter/lighter-rh/aster: orderId or c:<clientOrderId>, with --symbol; pacifica/hyperliquid: orderId or c:<clientOrderId>)")
    .option("--symbol <symbol>", "Market of the order (required on ondo/arcus/qfex, and for c:<clientOrderId> on lighter / lighter-rh / aster)")
    .action(async (orderId: string, opts: { symbol?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();

        if (isTradingV2(adapter)) {
          if (opts.symbol === undefined) {
            throw new PerpError("INVALID_PARAMS", `${adapter.venue.displayName} order status needs the market`, {
              remediation: `Pass --symbol <SYM>: perp trade status ${orderId} --symbol <SYM> -e ${adapter.venue.id}`,
            });
          }
          const r = await adapter.getOrderStatus(normalizeSymbolArg(opts.symbol), parseOrderRef(orderId));
          if (isJson()) return printJson(jsonOk(orderResultJson(r)));
          printOrder(`Order ${orderId} (${r.symbol}) on ${adapter.name}`, r);
          return;
        }

        // c:<clientOrderId> on a legacy venue: the venue's own status query (pacifica, hyperliquid
        // orderStatus by cloid, aster GET /fapi/v3/order origClientOrderId, lighter / lighter-rh) —
        // never a local search that cannot match and answers ORDER_NOT_FOUND.
        const ref = parseOrderRef(orderId);
        if (ref.kind === "clientOrderId") {
          const def = getVenue(adapter.name);
          if (!requireCapabilities(def).clientOrderId) {
            throw unsupported(def.displayName, "statusByClientOrderId", "orders on this venue carry no client order id through perp-cli", `Query by venue order id: perp trade status <orderId> -e ${def.id}`);
          }
          // Pacifica / Hyperliquid query per account (the row names the market); the others per market.
          if (opts.symbol === undefined && def.family !== "pacifica" && def.family !== "hyperliquid") {
            throw new PerpError("INVALID_PARAMS", `${def.displayName} order status by client order id needs the market`, {
              remediation: `Pass --symbol <SYM>: perp trade status ${orderId} --symbol <SYM> -e ${def.id}`,
            });
          }
          const r = await v2Of(adapter).getOrderStatus(opts.symbol !== undefined ? normalizeSymbolArg(opts.symbol) : "", ref);
          if (isJson()) return printJson(jsonOk(orderResultJson(r)));
          printOrder(`Order ${orderId} (${r.symbol}) on ${adapter.name}`, r);
          return;
        }

        if (isQueryOrderCapable(adapter)) {
          const result = await adapter.queryOrder(Number(orderId));
          if (isJson()) return printJson(jsonOk(result));
          const order = (result as Record<string, unknown>)?.order as Record<string, unknown> | undefined;
          if (!order) {
            console.log(chalk.gray(`\n  Order ${orderId} not found.\n`));
            return;
          }
          const o = (order.order ?? order) as Record<string, unknown>;
          console.log(chalk.cyan.bold(`\n  Order ${orderId}\n`));
          console.log(`  Symbol:  ${o.coin ?? o.symbol ?? ""}`);
          console.log(`  Side:    ${o.side === "B" ? chalk.green("BUY") : chalk.red("SELL")}`);
          console.log(`  Price:   $${formatUsd(String(o.limitPx ?? o.price ?? "0"))}`);
          console.log(`  Size:    ${o.sz ?? o.size ?? ""}`);
          console.log(`  Status:  ${(order as Record<string, unknown>).status ?? o.status ?? "unknown"}`);
          console.log();
          return;
        }

        // Generic: search order history
        const [openOrders, history] = await Promise.all([
          adapter.getOpenOrders(),
          adapter.getOrderHistory(100),
        ]);
        const found = [...openOrders, ...history].find(o => o.orderId === orderId);
        if (!found) {
          if (isJson()) return printJson(jsonError("ORDER_NOT_FOUND", `Order ${orderId} not found`));
          console.log(chalk.gray(`\n  Order ${orderId} not found.\n`));
          return;
        }
        if (isJson()) return printJson(jsonOk(found));
        console.log(chalk.cyan.bold(`\n  Order ${orderId}\n`));
        console.log(`  Symbol:  ${found.symbol}`);
        console.log(`  Side:    ${found.side === "buy" ? chalk.green("BUY") : chalk.red("SELL")}`);
        console.log(`  Type:    ${found.type}`);
        console.log(`  Price:   $${formatUsd(found.price)}`);
        console.log(`  Size:    ${found.size}`);
        console.log(`  Filled:  ${found.filled}`);
        console.log(`  Status:  ${found.status}`);
        console.log();
      });
    });

  // ── Recent Fills ──

  trade
    .command("fills [symbol]")
    .description("Recent trade fills, optionally filtered by symbol (Aster: last 7 days, symbols with a position, open order or fill in that window)")
    .option("-l, --limit <n>", "Number of fills", "30")
    .action(async (symbol: string | undefined, opts: { limit: string }) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        const limit = parseInt(opts.limit);
        const trades = await adapter.getTradeHistory(limit);

        let filtered = trades;
        if (symbol) {
          const sym = normalizeSymbolArg(symbol);
          filtered = trades.filter(t => symbolMatch(t.symbol, sym));
        }

        if (isJson()) return printJson(jsonOk(filtered));

        if (filtered.length === 0) {
          console.log(chalk.gray(`\n  No fills${symbol ? ` for ${normalizeSymbolArg(symbol)}` : ""}.\n`));
          return;
        }

        const rows = filtered.map((t) => [
          new Date(t.time).toLocaleString(),
          chalk.white.bold(t.symbol),
          t.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
          `$${formatUsd(t.price)}`,
          t.size,
          `$${formatUsd(t.fee)}`,
        ]);
        console.log(
          (await import("../utils.js")).makeTable(
            ["Time", "Symbol", "Side", "Price", "Size", "Fee"],
            rows
          )
        );
      });
    });

  // ── Pre-Trade Validation ──

  trade
    .command("check <symbol> <side> <size>")
    .description("Validate a trade before execution (pre-flight check)")
    .option("--price <price>", "Price for limit orders")
    .option("--type <type>", "Order type: market, limit, stop", "market")
    .option("--leverage <n>", "Leverage to use")
    .option("--reduce-only", "Check as reduce-only order")
    .action(async (symbol: string, side: string, size: string, opts: { price?: string; type?: string; leverage?: string; reduceOnly?: boolean }) => {
      await withJsonErrors(isJson(), async () => {
        const s = side.toLowerCase();
        if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");

        const adapter = await getAdapter();
        const validation = await validateTrade(adapter, {
          symbol: normalizeSymbolArg(symbol),
          side: s as "buy" | "sell",
          size: parseFloat(size),
          price: opts.price ? parseFloat(opts.price) : undefined,
          type: (opts.type ?? "market") as "market" | "limit" | "stop",
          leverage: opts.leverage ? parseInt(opts.leverage) : undefined,
          reduceOnly: opts.reduceOnly,
        });

        if (isJson()) return printJson(jsonOk(validation));

        console.log(chalk.cyan.bold(`\n  Pre-Trade Check: ${normalizeSymbolArg(symbol)} ${s.toUpperCase()} ${size}\n`));

        for (const check of validation.checks) {
          const icon = check.passed ? chalk.green("✓") : chalk.red("✗");
          console.log(`  ${icon} ${check.check}: ${check.message}`);
        }

        if (validation.warnings.length > 0) {
          console.log(chalk.yellow("\n  Warnings:"));
          for (const w of validation.warnings) {
            console.log(`    ⚠ ${w}`);
          }
        }

        if (validation.estimatedCost) {
          const c = validation.estimatedCost;
          console.log(chalk.white.bold("\n  Estimated Cost:"));
          console.log(`    Margin:   $${c.margin.toFixed(2)}`);
          console.log(`    Fee:      $${c.fee.toFixed(2)}`);
          console.log(`    Slippage: $${c.slippage.toFixed(2)}`);
          console.log(`    Total:    $${c.total.toFixed(2)}`);
        }

        const resultColor = validation.valid ? chalk.green : chalk.red;
        console.log(`\n  Result: ${resultColor(validation.valid ? "VALID — safe to execute" : "INVALID — do not execute")}\n`);
      });
    });

  // ── Scale-In (분할매수) ──

  supportsDryRun(trade.command("scale-in <symbol> <side>"))
    .description("Place multiple limit orders at different price levels to build a position gradually (분할매수)")
    .requiredOption("--levels <levels>", "Comma-separated price:percent pairs (e.g., 65000:30,63000:30,60000:40)")
    .option("--size-usd <usd>", "Total USD amount to deploy across all levels")
    .option("--size <base>", "Total base amount (e.g., 0.01 BTC)")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure)")
    .action(async (symbol: string, side: string, opts: { levels: string; sizeUsd?: string; size?: string; force?: boolean }) => {
      const sym = normalizeSymbolArg(symbol);
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      if (!opts.sizeUsd && !opts.size) errorAndExit("Must specify --size-usd or --size");

      // Parse levels: "65000:30,63000:30,60000:40"
      const levels = opts.levels.split(",").map(l => {
        const [price, pct] = l.trim().split(":");
        if (!price || !pct) errorAndExit(`Invalid level format: ${l}. Use price:percent (e.g., 65000:30)`);
        return { price: price.trim(), pct: parseFloat(pct.trim()) };
      });

      // Validate percentages sum to 100
      const totalPct = levels.reduce((sum, l) => sum + l.pct, 0);
      if (Math.abs(totalPct - 100) > 0.01) {
        errorAndExit(`Percentages must sum to 100%. Got: ${totalPct}%`);
      }

      const adapter = await getAdapter();
      // Quarantine first: it refuses the whole ladder before any market / lot read.
      assertNotQuarantined(adapter.name, sym, false);

      // Compute sizes for each level on the venue lot (validated before anything is sent)
      const step = await lotStepOf(adapter, sym);
      let levelSizes: { price: string; size: string; pct: number }[];
      if (opts.sizeUsd) {
        const totalUsd = parseFloat(opts.sizeUsd);
        levelSizes = levels.map((l, i) => {
          const size = floorToStep(totalUsd * l.pct / 100 / parseFloat(l.price), step);
          if (!(Number(size) > 0)) {
            throw new PerpError("SIZE_TOO_SMALL", `Level ${i + 1} ($${(totalUsd * l.pct / 100).toFixed(2)} @ ${l.price}) is below the lot ${step}; nothing was sent`, {
              remediation: `Use fewer levels or a larger --size-usd: every level must be at least one lot (${step})`,
            });
          }
          return { price: l.price, pct: l.pct, size };
        });
      } else {
        const sizes = scaleLevelSizes(opts.size!, levels.map(l => l.pct), step);
        levelSizes = levels.map((l, i) => ({ price: l.price, pct: l.pct, size: sizes[i] }));
      }
      const reqs = await scaleRequests(adapter, sym, s as "buy" | "sell", false, levelSizes);

      // Risk gate on the aggregate position being built (before the dry-run return — L5). scale-in is always an
      // opening flow (no reduce-only exemption); only --force bypasses. Notional
      // is the sum across levels, expressed as total base * volume-weighted price.
      const totalBase = levelSizes.reduce((acc, l) => acc + parseFloat(l.size), 0);
      const totalNotional = levelSizes.reduce((acc, l) => acc + parseFloat(l.size) * parseFloat(l.price), 0);
      await openingOrderGate(adapter, { symbol: sym, size: totalBase, price: totalBase > 0 ? totalNotional / totalBase : NaN, force: opts.force });

      if (dryRunGuard("scale_in", {
        exchange: adapter.name, symbol: sym, side: s,
        totalSizeUsd: opts.sizeUsd ?? "N/A",
        totalSizeBase: opts.size ?? "N/A",
        levels: levelSizes.map(l => `${l.price}@${l.pct}% (${l.size})`).join(", "),
      })) return;

      // Place limit orders at each level (NOT reduce-only — opening positions)
      const results = await placeScaleLevels(adapter, "scale-in", sym, s as "buy" | "sell", levelSizes, reqs);
      const incomplete = scaleIncompleteError(adapter.name, `scale-in ${sym}`, results);
      if (incomplete !== null) {
        if (!isJson()) printScaleLevels(`Scale-in for ${sym} on ${adapter.name} is INCOMPLETE:`, sym, results);
        throw incomplete;
      }

      if (isJson()) return printJson(jsonOk({ symbol: sym, side: s, levels: results }));
      printScaleLevels(`Scale-in orders placed for ${sym} on ${adapter.name}:`, sym, results);
    });

  // grid/dca/trailing-stop moved to 'perp strategy'

  // ── PnL Tracker ──

  trade
    .command("pnl-track")
    .description("Live-monitor positions with real-time PnL updates")
    .option("--interval <sec>", "Refresh interval in seconds", "3")
    .option("--symbol <sym>", "Filter to a specific symbol")
    .action(async (opts: { interval: string; symbol?: string }) => {
      const intervalSec = parseInt(opts.interval);
      const filterSym = opts.symbol?.toUpperCase();

      const adapter = await getAdapter();

      console.log(chalk.cyan(`\n  PnL Tracker | ${adapter.name} | Interval: ${intervalSec}s`));
      if (filterSym) console.log(chalk.cyan(`  Filtering: ${filterSym}`));
      console.log(chalk.gray(`  Press Ctrl+C to stop.\n`));

      let running = true;
      const cleanup = () => { running = false; };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      try {
        while (running) {
          const [positions, balance] = await Promise.all([
            adapter.getPositions(),
            adapter.getBalance(),
          ]);

          let filtered = positions;
          if (filterSym) {
            filtered = positions.filter(p => symbolMatch(p.symbol, filterSym));
          }

          // Fetch funding payments (recent) for display
          let fundingBySymbol: Record<string, number> = {};
          let fundingError: string | null = null;
          try {
            const payments = await adapter.getFundingPayments(50);
            for (const fp of payments) {
              const sym = fp.symbol.toUpperCase();
              fundingBySymbol[sym] = (fundingBySymbol[sym] || 0) + parseFloat(fp.payment);
            }
          } catch (e) {
            // Shown under the table: funding columns are then unknown, not 0.
            fundingError = e instanceof Error ? e.message : String(e);
          }

          console.clear();
          console.log(chalk.cyan.bold(`\n  PnL Tracker — ${adapter.name} | ${new Date().toLocaleTimeString()}\n`));
          console.log(`  Equity: $${formatUsd(balance.equity)} | Available: $${formatUsd(balance.available)} | Margin: $${formatUsd(balance.marginUsed)} | uPnL: $${formatUsd(balance.unrealizedPnl)}\n`);

          if (filtered.length === 0) {
            console.log(chalk.gray(`  No open positions${filterSym ? ` for ${filterSym}` : ""}.`));
          } else {
            const { makeTable } = await import("../utils.js");
            const rows = filtered.map(p => {
              const entry = parseFloat(p.entryPrice);
              const mark = parseFloat(p.markPrice);
              const pnl = parseFloat(p.unrealizedPnl);
              const notional = parseFloat(p.size) * entry;
              const pnlPct = notional > 0 ? (pnl / notional) * 100 : 0;
              const funding = fundingBySymbol[p.symbol.toUpperCase()] || 0;
              const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
              const pctColor = pnlPct >= 0 ? chalk.green : chalk.red;
              return [
                chalk.white.bold(p.symbol),
                p.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
                p.size,
                `$${formatUsd(p.entryPrice)}`,
                `$${formatUsd(p.markPrice)}`,
                pnlColor(`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`),
                pctColor(`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`),
                fundingError !== null ? chalk.yellow("n/a") : funding !== 0 ? `$${funding.toFixed(4)}` : "-",
              ];
            });
            console.log(makeTable(
              ["Symbol", "Side", "Size", "Entry", "Mark", "PnL", "PnL%", "Funding"],
              rows,
            ));
          }

          if (fundingError !== null) console.log(chalk.yellow(`\n  Funding history unavailable (Funding column n/a): ${fundingError}`));
          console.log(chalk.gray(`\n  Refreshing every ${intervalSec}s... Press Ctrl+C to stop.`));
          await new Promise(r => setTimeout(r, intervalSec * 1000));
        }
      } finally {
        process.removeListener("SIGINT", cleanup);
        process.removeListener("SIGTERM", cleanup);
      }

      console.log(chalk.yellow(`\n  PnL tracker stopped.\n`));
    });

  // === Spot Trading (venue definitions) ===

  /** Spot adapter for the current venue via the factory; CAPABILITY_UNSUPPORTED when def.spot is null. */
  async function spotContext(confirmOnchainApprove: boolean): Promise<{ def: VenueDefinition; spotDef: VenueSpotDefinition; spot: SpotAdapter }> {
    const adapter = await getAdapter();
    const def = getVenue(adapter.name);
    const spotDef = requireSpotDefinition(def);
    if (confirmOnchainApprove && spotDef.accountModel !== "wallet") {
      throw unsupported(def.displayName, "onchainApprove", "--yes (on-chain approve) does not apply to this venue's spot", "Omit --yes (only on-chain wallet spot venues such as arcus send approve txs)");
    }
    const spot = await requireSpotAdapter(def.id, adapter, { confirmOnchainApprove });
    return { def, spotDef, spot };
  }

  /** Uniform feature name per spot capability. */
  const SPOT_FEATURE: Readonly<Record<keyof VenueSpotDefinition["capabilities"], string>> = {
    limitOrder: "spotLimitOrder", orderbook: "spotOrderbook", cancel: "spotCancel", transfer: "spotTransfer",
  };

  function requireSpotCapability(def: VenueDefinition, spotDef: VenueSpotDefinition, cap: keyof VenueSpotDefinition["capabilities"], what: string): void {
    if (!spotDef.capabilities[cap]) {
      throw unsupported(def.displayName, SPOT_FEATURE[cap], `spot account model "${spotDef.accountModel}" has no ${what}`,
        spotDef.accountModel === "wallet"
          ? `${def.displayName} spot is a market swap: use perp -e ${def.id} trade spot-buy|spot-sell`
          : spotDef.accountModel === "unified"
            ? `${def.displayName} spot shares the perp account (one balance) — no transfer is needed`
            : `Use a venue whose spot supports ${what}`);
    }
  }

  function isSpotOrderResult(r: unknown): r is SpotOrderResult {
    if (r === null || typeof r !== "object") return false;
    const o = r as Record<string, unknown>;
    return typeof o.status === "string" && (o.finality === "final" || o.finality === "pending") && "receivedToken" in o;
  }

  /**
   * Uniform SpotOrderResult for a legacy raw spot result (HL statuses / Lighter sendTx ack).
   * A status / fill is reported only with proof: a venue-final IOC outcome (iocOutcomeOf),
   * HL `resting` (open) / `filled`; anything else is "pending" with a remediation — never "✓".
   */
  function spotOrderResultOf(def: VenueDefinition, spot: SpotAdapter, symbol: string, size: string, raw: unknown, kind: "market" | "limit"): SpotOrderResult {
    if (isSpotOrderResult(raw)) return raw;
    const r = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const sentSize = typeof r?.sentSize === "string" ? r.sentSize : size;
    const statuses = (r?.response as { data?: { statuses?: unknown } } | undefined)?.data?.statuses;
    const st0 = Array.isArray(statuses) && statuses[0] !== null && typeof statuses[0] === "object" ? statuses[0] as Record<string, unknown> : null;
    const filled = st0?.filled as { totalSz?: unknown; avgPx?: unknown; oid?: unknown } | undefined;
    const resting = st0?.resting as { oid?: unknown } | undefined;
    const idOf = (v: unknown): string | null => (typeof v === "number" || (typeof v === "string" && v !== "") ? String(v) : null);
    const orderId = idOf(filled?.oid) ?? idOf(resting?.oid) ?? idOf(r?.clientOrderIndex) ?? idOf(r?.tx_hash);
    const avgPrice = typeof filled?.avgPx === "string" && Number(filled.avgPx) > 0 ? filled.avgPx : null;
    const base = { venue: def.id, symbol, orderId, avgPrice, receivedToken: null, venueRaw: raw };
    const outcome = isIocOutcomeCapable(spot) ? spot.iocOutcomeOf(raw) : null;
    if (outcome !== null) {
      const full = Number(sentSize) - Number(outcome.filledSize) <= iocLotTolerance(sentSize, outcome.filledSize);
      return { ...base, status: Number(outcome.filledSize) === 0 ? "cancelled" : full ? "filled" : "partial", filledSize: outcome.filledSize, finality: "final", remediation: null };
    }
    if (kind === "limit" && resting !== undefined) {
      return { ...base, status: "open", filledSize: "0", finality: "final", remediation: null };
    }
    const check = kind === "limit" ? `perp trade spot-orders ${symbol} -e ${def.id}` : `perp -e ${def.id} account spot-balance`;
    return {
      ...base, status: "pending", filledSize: null, finality: "pending",
      remediation: `Sent; the venue response does not prove the outcome — do NOT resubmit. Check: ${check}`,
    };
  }

  /** Human output: SpotOrderResult status / finality / remediation (legacy raw results are wrapped first). */
  function printSpotOrder(verb: string, def: VenueDefinition, symbol: string, size: string, result: SpotOrderResult): void {
    const ok = result.status === "filled" || result.status === "partial" || result.status === "open";
    const color = result.status === "rejected" ? chalk.red : ok && result.finality === "final" ? chalk.green : chalk.yellow;
    console.log(color(`\n  Spot ${verb} ${size} ${result.symbol} on ${def.id}: ${result.status} (${result.finality})`));
    const parts = [
      result.orderId !== null ? `order ${result.orderId}` : null,
      result.filledSize !== null ? `filled ${result.filledSize}` : null,
      result.avgPrice !== null ? `avg ${result.avgPrice}` : null,
      result.receivedToken !== null ? `received ${result.receivedToken}` : null,
    ].filter((x): x is string => x !== null);
    if (parts.length > 0) console.log(chalk.gray(`  ${parts.join(", ")}`));
    if (result.remediation !== null) console.log(chalk.yellow(`  ${result.remediation}`));
    console.log();
  }

  /**
   * Execution record of a spot market order, same fields for every venue:
   * the resolved bound (bps + source) and, where the adapter reports it, the protection
   * price actually sent and its reference (`protection` on the raw result / venueRaw).
   */
  function spotExecutionOf(spotDef: VenueSpotDefinition, def: VenueDefinition, result: unknown, slippage: ResolvedSlippage): OrderExecution {
    const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
    const r = rec(result);
    const pr = rec(r?.protection) ?? rec(rec(r?.venueRaw)?.protection);
    const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    const method = spotDef.accountModel === "wallet" ? "routerSwap" : def.family === "pacifica" ? "venueSlippage" : "protectedIoc";
    const notes: string[] = [];
    if (method === "routerSwap") notes.push(`swap with minimum received = quote × (1 − ${slippage.bps} bps); no protection price`);
    else if (method === "venueSlippage") notes.push(`sent slippage_percent ${slippage.bps / 100}; ${def.displayName} derives the protection price`);
    else if (pr === null) notes.push("protection price not reported by the adapter");
    else notes.push(`requested ${slippage.bps} bps; applied after price-grid alignment`);
    return {
      method,
      slippageBps: pr !== null && typeof pr.appliedBps === "number" ? pr.appliedBps : slippage.bps,
      slippageSource: slippage.source,
      protectionPrice: pr !== null ? str(pr.protectionPrice) : null,
      referencePrice: pr !== null ? str(pr.referencePrice) : null,
      tifRequested: null,
      tifSent: method === "protectedIoc" ? "IOC" : null,
      expiresAt: null,
      builderFee: null, // spot orders never carry a builder fee
      notes,
    };
  }

  function printSpotExecution(e: OrderExecution): void {
    const parts = [e.method, `slippage ${e.slippageBps} bps (${e.slippageSource})`];
    if (e.protectionPrice !== null) parts.push(`protection ${e.protectionPrice}${e.referencePrice !== null ? ` (ref ${e.referencePrice})` : ""}`);
    console.log(chalk.gray(`  Execution:  ${parts.join(" · ")}`));
    for (const n of e.notes) console.log(chalk.gray(`  Note:       ${n}`));
    console.log();
  }

  /**
   * One cancel result shape for every spot venue (SpotOrderResult). Legacy raw acks are
   * wrapped: HL statuses[0] "success" → cancelled (final), an `error` → ORDER_REJECTED;
   * any other ack (Lighter tx) → pending until the open orders confirm it.
   */
  function spotCancelResult(def: VenueDefinition, symbol: string, orderId: string, raw: unknown): SpotOrderResult {
    if (isSpotOrderResult(raw)) return raw;
    const statuses = (raw as { response?: { data?: { statuses?: unknown } } } | null)?.response?.data?.statuses;
    const st0 = Array.isArray(statuses) ? statuses[0] : undefined;
    if (st0 !== null && typeof st0 === "object" && typeof (st0 as { error?: unknown }).error === "string") {
      throw new PerpError("ORDER_REJECTED", `${def.displayName} spot cancel of ${orderId} refused: ${(st0 as { error: string }).error}`, { exchange: def.id });
    }
    const confirmed = st0 === "success";
    return {
      venue: def.id, symbol, orderId, status: confirmed ? "cancelled" : "pending", filledSize: null, avgPrice: null,
      finality: confirmed ? "final" : "pending", receivedToken: null,
      remediation: confirmed ? null : `Cancel sent; confirm with: perp trade spot-orders ${symbol} -e ${def.id}`,
      venueRaw: raw,
    };
  }

  function spotExecStatus(result: SpotOrderResult): "success" | "failed" | "unverified" {
    if (result.status === "rejected") return "failed";
    return result.finality === "pending" ? "unverified" : "success";
  }

  for (const [verb, side] of [["buy", "buy"], ["sell", "sell"]] as const) {
    supportsDryRun(trade.command(`spot-${verb} <symbol> <size>`))
      .description(`${verb === "buy" ? "Buy" : "Sell"} a spot token at market on any venue with spot (bare base uses the venue's default quote)`)
      .option("--slippage-bps <n>", "Slippage bound in bps (default: settings defaultSlippageBps)")
      .option("--yes", "Allow the one-time on-chain approve(Permit2) tx (arcus; costs Robinhood Chain ETH gas)")
      .action(async (symbol: string, size: string, opts: { slippageBps?: string; yes?: boolean }) => {
        await withJsonErrors(isJson(), async () => {
          const slippageFlag = parseSlippageBpsFlag(opts.slippageBps);
          const { def, spotDef, spot } = await spotContext(opts.yes === true);
          const slippage = resolveSlippage(def.id, slippageFlag);
          const sym = normalizeSymbolArg(symbol);

          if (dryRunGuard(`spot ${verb}`, { exchange: def.id, symbol: sym, side, size })) return;

          const raw = await spot.spotMarketOrder(sym, side, size, { slippage });
          const result = spotOrderResultOf(def, spot, sym, size, raw, "market");
          logExecution({ type: "market_order", exchange: def.id + "-spot", symbol: sym, side, size, status: spotExecStatus(result), dryRun: false, meta: { spot: true, result } });

          const execution = spotExecutionOf(spotDef, def, result, slippage);
          if (isJson()) {
            printJson(jsonOk({ order: result, symbol: sym, side, size, execution }));
          } else {
            printSpotOrder(verb === "buy" ? "bought" : "sold", def, sym, size, result);
            printSpotExecution(execution);
          }
        });
      });
  }

  supportsDryRun(trade.command("spot-limit <symbol> <side> <price> <size>"))
    .description("Place a spot limit order (venues with spot limitOrder capability)")
    .option("--tif <tif>", "Time in force (venue-specific, e.g. GTC/IOC/ALO); omitted = the adapter's default")
    .action(async (symbol: string, side: string, price: string, size: string, opts: { tif?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const s = side.toLowerCase();
        if (s !== "buy" && s !== "sell") throw new PerpError("INVALID_PARAMS", `Side must be buy or sell (got "${side}")`);
        const { def, spotDef, spot } = await spotContext(false);
        requireSpotCapability(def, spotDef, "limitOrder", "limit orders");
        const sym = normalizeSymbolArg(symbol);

        if (dryRunGuard("spot limit", { exchange: def.id, symbol: sym, side: s, price, size, tif: opts.tif ?? null })) return;

        const raw = await spot.spotLimitOrder(sym, s, price, size, opts.tif !== undefined ? { tif: opts.tif } : undefined);
        const result = spotOrderResultOf(def, spot, sym, size, raw, "limit");
        logExecution({ type: "limit_order", exchange: def.id + "-spot", symbol: sym, side: s, size, price, status: spotExecStatus(result), dryRun: false, meta: { spot: true, tif: opts.tif ?? null, result } });

        if (isJson()) {
          printJson(jsonOk({ order: result, symbol: sym, side: s, price, size }));
        } else {
          printSpotOrder(`limit ${s} @ ${price}`, def, sym, size, result);
        }
      });
    });

  supportsDryRun(trade.command("spot-cancel <symbol> <orderId>"))
    .description("Cancel a spot order (venues with spot cancel capability)")
    .action(async (symbol: string, orderId: string) => {
      await withJsonErrors(isJson(), async () => {
        const { def, spotDef, spot } = await spotContext(false);
        requireSpotCapability(def, spotDef, "cancel", "order cancel");
        const sym = normalizeSymbolArg(symbol);

        if (dryRunGuard("spot cancel", { exchange: def.id, symbol: sym, orderId })) return;

        const result = spotCancelResult(def, sym, orderId, await spot.spotCancelOrder(sym, orderId));
        logExecution({ type: "cancel", exchange: def.id + "-spot", symbol: sym, side: "cancel", size: "0", status: spotExecStatus(result), dryRun: false, meta: { spot: true, orderId, result } });

        if (isJson()) {
          printJson(jsonOk({ cancelled: result, symbol: sym, orderId }));
        } else {
          printSpotOrder("cancel", def, sym, orderId, result);
        }
      });
    });

  trade
    .command("spot-orders [symbol]")
    .description("List open spot orders (optionally for one symbol)")
    .action(async (symbol: string | undefined) => {
      await withJsonErrors(isJson(), async () => {
        const { def, spotDef, spot } = await spotContext(false);
        if (spotDef.accountModel === "wallet" || !isSpotOpenOrdersCapable(spot)) {
          throw unsupported(def.displayName, "spotOpenOrders", spotDef.accountModel === "wallet" ? "spot is an on-chain swap that settles immediately — there are no resting orders" : "the spot adapter cannot list open orders",
            spotDef.accountModel === "wallet" ? `Check the wallet balance: perp -e ${def.id} trade spot-balance` : "Use the venue UI to inspect open spot orders");
        }
        const orders = await spot.getSpotOpenOrders(symbol === undefined ? null : normalizeSymbolArg(symbol));
        if (isJson()) return printJson(jsonOk({ exchange: def.id, orders }));
        console.log(chalk.cyan(`\n  Open spot orders (${def.id}):\n`));
        if (orders.length === 0) {
          console.log(chalk.gray("  No open spot orders\n"));
          return;
        }
        const { makeTable } = await import("../utils.js");
        console.log(makeTable(["Order", "Symbol", "Side", "Price", "Size", "Filled"], orders.map(o => [o.orderId, o.symbol, o.side, o.price, o.size, o.filled])));
        console.log();
      });
    });

  supportsDryRun(trade.command("spot-transfer <direction> <amount>"))
    .description("Move the venue's spot quote asset between perp and spot (to-spot | to-perp). Shared-balance accounts (pacifica, HL unified, Lighter unified trading account): success no-op (execution.method sharedAccount); wallet spot (arcus): unsupported")
    .action(async (direction: string, amount: string) => {
      await withJsonErrors(isJson(), async () => {
        const dir = direction.toLowerCase();
        if (dir !== "to-spot" && dir !== "to-perp") throw new PerpError("INVALID_PARAMS", `Direction must be to-spot or to-perp (got "${direction}")`);
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0) throw new PerpError("INVALID_PARAMS", `Amount must be a positive number (got "${amount}")`);
        const { def, spotDef, spot } = await spotContext(false);
        // Wallet model (arcus): spot is the on-chain wallet, not an exchange account → uniform unsupported.
        // Unified accounts (pacifica, HL unified, Lighter account_trading_mode 1) → success no-op below (execution.method "sharedAccount").
        if (spotDef.accountModel === "wallet") {
          throw unsupported(def.displayName, "spotTransfer", "spot is the on-chain wallet (no exchange spot account to transfer into)",
            `Fund the wallet directly; check it with: perp -e ${def.id} trade spot-balance`);
        }
        const asset = defaultSpotQuote(def, network());

        if (dryRunGuard("spot transfer", { exchange: def.id, direction: dir, amount, asset })) return;

        let moved: boolean;
        try {
          moved = dir === "to-spot" ? await transferQuoteToSpot(spot, n) : await transferQuoteToPerp(spot, n);
        } catch (e) {
          // Refused for lack of funds → say how much the source side can move (read live).
          throw await transferShortfallError(e, {
            venue: def.id, direction: dir, amount, asset,
            readAvailable: async () => {
              if (dir !== "to-spot") return readSpotQuoteAvailableFresh(spot);
              const perp = await getAdapter() as ExchangeAdapter & Partial<Pick<AsterAdapter, "getPerpAssetTransferable">>;
              // Aster margin is multi-asset: the account-wide available balance is not an amount of `asset`.
              return typeof perp.getPerpAssetTransferable === "function" ? perp.getPerpAssetTransferable(asset) : Number((await perp.getBalance()).available);
            },
          });
        }
        const execution = moved
          ? { method: "transfer", notes: [`${asset} ${dir === "to-spot" ? "perp → spot" : "spot → perp"}`] }
          : { method: "sharedAccount", notes: [`${def.displayName} spot and perp share one balance for this account — no transfer needed`] };
        if (isJson()) return printJson(jsonOk({ exchange: def.id, direction: dir, amount, asset, transferred: moved, execution }));
        if (moved) {
          console.log(chalk.green(`\n  ✓ Transferred ${amount} ${asset} ${dir === "to-spot" ? "perp → spot" : "spot → perp"} on ${def.id}`));
        } else {
          console.log(chalk.green(`\n  ✓ Nothing to move on ${def.id}: spot and perp share one balance`));
        }
        console.log(chalk.gray(`  Execution:  ${execution.method}\n`));
      });
    });

  trade
    .command("spot-balance")
    .description("Show spot token balances (any venue with spot)")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        const { def, spot } = await spotContext(false);
        const balances = await spot.getSpotBalances();
        const nonZero = balances.filter(b => Number(b.total) > 0);

        if (isJson()) {
          printJson(jsonOk({ exchange: def.id, balances: nonZero }));
        } else {
          console.log(chalk.cyan(`\n  Spot Balances (${def.id}):\n`));
          if (nonZero.length === 0) {
            console.log(chalk.gray("  No spot tokens\n"));
          } else {
            for (const b of nonZero) {
              const sharedNote = b.shared ? chalk.gray("  (shared with perp margin)") : "";
              console.log(`  ${b.token.padEnd(10)} ${b.total.padEnd(15)} available: ${b.available}${sharedNote}`);
            }
            console.log();
          }
        }
      });
    });

  // ── Multi-leg orders ──────────────────────────────────────────────────
  if (getAdapterForExchange) {
    const tradeCmd = program.commands.find(c => c.name() === "trade");
    if (tradeCmd) {
      registerMultiAction(tradeCmd, getAdapterForExchange, isJson);
    }
    // Keep deprecated top-level 'multi' alias (hidden from help)
    registerMultiAction(program, getAdapterForExchange, isJson, true);
  }
}

// ── Multi-leg helpers ──────────────────────────────────────────────────

interface MultiLeg {
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  size: string;
}

interface MultiLegResult {
  leg: MultiLeg;
  /**
   * filled = verified by the position delta (filledSize); failed = definitely not placed;
   * unknown = outcome unconfirmed (quarantined, never rolled back / resubmitted);
   * skipped = not sent (an earlier leg failed); rolled_back = reduce-only rollback verified;
   * rollback_failed = rollback rejected / unconfirmed / partial (quarantined).
   */
  status: "filled" | "failed" | "unknown" | "skipped" | "rolled_back" | "rollback_failed";
  /** Measured base units (filled legs), null otherwise. */
  filledSize: string | null;
  result?: unknown;
  error?: string;
}

function parseMultiLeg(spec: string): MultiLeg {
  const parts = spec.split(":");
  if (parts.length !== 4) {
    throw new Error(`Invalid leg format "${spec}" — expected exchange:symbol:side:size`);
  }
  const [exchange, symbol, side, size] = parts;

  // Normalize exchange aliases via the venue registry ("lit" kept as a legacy alias of lighter)
  const exRef = exchange.toLowerCase() === "lit" ? "lighter" : exchange;
  const trading = listVenuesWithRole("trading");
  const def = trading.find(v => v.id === exRef.toLowerCase() || v.aliases.includes(exRef.toLowerCase()));
  // A registered venue without the trading role (switched-off TxFlow / RISEx, read-only GRVT,
  // Extended, Variational) refuses the WHOLE multi here, while legs are parsed — before any adapter
  // is created or any leg is sent — naming the leg.
  const registered = tryResolveVenueId(exRef);
  if (!def && registered !== null) {
    const venueDef = getVenue(registered);
    const r = roleUnsupported(venueDef, "trading");
    throw new PerpError("CAPABILITY_UNSUPPORTED", `trade multi refused before any leg was sent: leg "${spec}" — ${r.message}`, {
      ...(r.structured.details ?? {}), leg: spec,
      ...(r.structured.remediation !== undefined ? { remediation: r.structured.remediation } : {}),
    });
  }
  if (!def) {
    throw new Error(`Unknown exchange "${exchange}" in leg spec — valid: ${trading.map(v => v.id).join(", ")}`);
  }
  const normalizedExchange: string = def.id;
  if (side !== "buy" && side !== "sell") {
    throw new Error(`Invalid side "${side}" — must be "buy" or "sell"`);
  }
  if (isNaN(Number(size)) || Number(size) <= 0) {
    throw new Error(`Invalid size "${size}" — must be a positive number`);
  }

  return { exchange: normalizedExchange, symbol: normalizeSymbolArg(symbol), side, size };
}

function registerMultiAction(
  parent: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  deprecated = false,
) {
  const cmd = parent
    .command("multi <legs...>")
    .description(deprecated ? "Use 'perp trade multi'" : "Execute multi-leg orders (exchange:symbol:side:size)");
  if (deprecated) (cmd as any)._hidden = true;
  cmd
    .option("--smart", "Send each opening leg as an IOC limit at best bid/ask + 1 tick (no market fallback: a leg that does not match fails)")
    .option("--rollback", "Auto-rollback filled legs if any leg fails", true)
    .option("--no-rollback", "Disable auto-rollback")
    .option("--timeout <ms>", "Removed: legs are verified by their position, never timed out (passing it is an error)")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure) for every leg")
    .action(async (legSpecs: string[], opts: { smart?: boolean; rollback: boolean; timeout?: string; force?: boolean }) => {
      await withJsonErrors(isJson(), async () => {
        if (opts.timeout !== undefined) {
          throw new PerpError("INVALID_PARAMS", "--timeout was removed from 'trade multi': each leg is verified by its position delta; an unconfirmed leg is reported (and quarantined), never treated as failed after a timeout", {
            remediation: "Drop --timeout",
          });
        }
        // Parse legs
        const legs = legSpecs.map(parseMultiLeg);

        if (legs.length < 2) {
          const err = "Multi-leg requires at least 2 legs";
          if (isJson()) { printJson(jsonError("INVALID_ARGS", err)); return; }
          throw new Error(err);
        }

        if (!isJson()) {
          console.log(chalk.cyan.bold("Multi-Leg Order\n"));
          for (const l of legs) {
            const color = l.side === "buy" ? chalk.green : chalk.red;
            console.log(`  ${l.exchange.padEnd(14)} ${color(l.side.toUpperCase())} ${l.symbol} x ${l.size}`);
          }
          console.log();
        }

        // Get adapters (deduplicated)
        const adapters = new Map<string, ExchangeAdapter>();
        for (const l of legs) {
          if (!adapters.has(l.exchange)) {
            adapters.set(l.exchange, await getAdapterForExchange(l.exchange));
          }
        }

        // Quarantined symbols (an earlier unknown outcome) are never traded automatically.
        for (const l of legs) {
          const q = quarantineEntryFor(l.symbol, (m) => { if (!isJson()) console.error(m); });
          if (q !== null) {
            throw new PerpError("RISK_VIOLATION", `${l.symbol} is quarantined by ${q.strategy}: ${q.reason}`, { remediation: q.remediation });
          }
        }

        // Risk gate every leg before any order goes out, so a breach aborts the
        // whole multi-leg up front. --force bypasses; the rollback orders below
        // are exempt (they reduce the just-opened legs).
        await Promise.all(
          legs.map((leg) =>
            enforceOrderRisk(adapters.get(leg.exchange)!, {
              symbol: leg.symbol,
              size: parseFloat(leg.size),
              force: opts.force,
            }),
          ),
        );

        // Lot step per leg from the venue market info (unknown → throws before any order goes out):
        // each leg is sent floored to it and its fill judged against that sent size.
        const legSteps = new Map<MultiLeg, string>();
        for (const l of legs) legSteps.set(l, await lotStepOf(adapters.get(l.exchange)!, l.symbol));

        // Execute legs ONE AT A TIME, each verified by its position delta (placePerpVerified):
        // parallel legs on one venue/symbol would corrupt each other's measurement. With
        // rollback on, the first failure stops further legs. An unknown outcome stops
        // everything: that leg is quarantined and NOTHING is rolled back (the unknown leg may
        // have executed — undoing the others could leave it naked).
        const log = (m: string) => { if (!isJson()) console.log(chalk.red(m)); };
        const quarantineLeg = (leg: MultiLeg, reason: string) => quarantineSymbol("trade-multi", leg.symbol, reason,
          `Check ${leg.symbol} on ${leg.exchange} (perp -e ${leg.exchange} account positions) and the other legs; fix by hand, then: perp strategy quarantine-clear ${leg.symbol}`, log);
        const legResults: MultiLegResult[] = legs.map(leg => ({ leg, status: "skipped" as const, filledSize: null }));
        let stop = false;
        for (const r of legResults) {
          if (stop) break;
          const leg = r.leg;
          const adapter = adapters.get(leg.exchange)!;
          const step = legSteps.get(leg)!;
          try {
            const sentSize = floorSize(leg.size, step);
            const f = await placePerpVerified(adapter, leg.exchange, leg.symbol, leg.side, sentSize, {
              stepSize: step,
              ...(opts.smart ? { place: () => smartOrder(adapter, leg.symbol, leg.side, sentSize).then(x => x.result) } : {}),
            });
            r.status = "filled";
            r.filledSize = floorToStep(f.filledSize, step);
            r.result = f.raw;
            // Accepted partial fill (venue-final IOC partial, or ≥ 80% measured): the legs no longer
            // match — reported as ORDER_PARTIAL; with rollback on it stops and is rolled back.
            if (Number(r.filledSize) < Number(sentSize)) {
              r.error = `partial fill: ${r.filledSize} of ${sentSize}${sentSize !== leg.size ? ` (requested ${leg.size}, floored to lot ${step})` : ""}`;
              if (opts.rollback) stop = true;
            }
            logExecution({ type: "multi_leg", exchange: leg.exchange, symbol: leg.symbol, side: leg.side, size: leg.size, status: "success", dryRun: false, meta: { result: f.raw, smart: opts.smart, measuredFill: f.filledSize } });
          } catch (e) {
            r.error = extractErrorMessage(e);
            logExecution({ type: "multi_leg", exchange: leg.exchange, symbol: leg.symbol, side: leg.side, size: leg.size, status: isOutcomeUnknown(e) ? "unverified" : "failed", error: r.error, dryRun: false, meta: { smart: opts.smart, pending: isOutcomeUnknown(e) } });
            if (isOutcomeUnknown(e)) {
              r.status = "unknown";
              quarantineLeg(leg, `trade multi: ${leg.side} ${leg.size} ${leg.symbol} on ${leg.exchange} outcome unknown (${r.error})`);
              stop = true;
            } else {
              r.status = "failed";
              if (opts.rollback) stop = true;
            }
          }
        }

        const filled = legResults.filter(r => r.status === "filled");
        const failed = legResults.filter(r => r.status === "failed");
        const unknown = legResults.filter(r => r.status === "unknown");

        // Rollback (definite failures or partial fills only): each verified-filled leg, reduce-only, sized to its
        // MEASURED fill, verified with one residual close. Rejected / unconfirmed / residual → quarantine.
        const partial = filled.filter(r => r.error !== undefined);
        if ((failed.length > 0 || partial.length > 0) && unknown.length === 0 && filled.length > 0 && opts.rollback) {
          if (!isJson()) {
            console.log(chalk.yellow(`\n  ${failed.length} leg(s) failed${partial.length > 0 ? `, ${partial.length} partially filled` : ""} — rolling back ${filled.length} filled leg(s) (reduce-only)...\n`));
          }

          for (const fr of [...filled].reverse()) {
            const adapter = adapters.get(fr.leg.exchange)!;
            const reverseSide = fr.leg.side === "buy" ? "sell" : "buy";
            const rbSize = fr.filledSize as string;
            let why: string | null = null;
            try {
              const c = await closePerpVerified(adapter, fr.leg.exchange, fr.leg.symbol, reverseSide, rbSize, { stepSize: legSteps.get(fr.leg)! });
              if (c.residual > 0) why = `rollback closed ${c.closed} of ${rbSize}, ${c.residual} still open${c.note !== null ? ` (${c.note})` : ""}`;
            } catch (err) {
              why = `rollback ${isOutcomeUnknown(err) ? "outcome unknown" : "failed"}: ${extractErrorMessage(err)}`;
            }
            logExecution({ type: "multi_leg_rollback", exchange: fr.leg.exchange, symbol: fr.leg.symbol, side: reverseSide, size: rbSize, status: why === null ? "success" : "failed", ...(why !== null ? { error: why } : {}), dryRun: false });
            if (why === null) {
              fr.status = "rolled_back";
              if (!isJson()) console.log(chalk.gray(`  Rolled back: ${fr.leg.exchange} ${reverseSide} ${fr.leg.symbol} x ${rbSize} (reduce-only)`));
            } else {
              fr.status = "rollback_failed";
              fr.error = why;
              quarantineLeg(fr.leg, `trade multi: ${fr.leg.side} ${rbSize} ${fr.leg.symbol} on ${fr.leg.exchange} filled; ${why}`);
            }
          }
        }

        // Not a success unless every leg filled: unknown → ORDER_PENDING; a failed rollback or legs
        // left filled next to a failed one → ORDER_PARTIAL; failed with nothing left open →
        // ORDER_REJECTED. Scripts get ok:false + exit code 1 with the full per-leg details.
        const rollbackFailed = legResults.filter(r => r.status === "rollback_failed");
        const stillFilled = legResults.filter(r => r.status === "filled");
        const outcome: ErrorCode | null = unknown.length > 0 ? "ORDER_PENDING"
          : rollbackFailed.length > 0 ? "ORDER_PARTIAL"
          : failed.length > 0 || partial.length > 0 ? (stillFilled.length > 0 ? "ORDER_PARTIAL" : "ORDER_REJECTED")
          : null;
        if (outcome !== null) process.exitCode = 1;
        if (isJson()) {
          const payload = {
            legs: legResults.map(r => ({
              exchange: r.leg.exchange,
              symbol: r.leg.symbol,
              side: r.leg.side,
              size: r.leg.size,
              filledSize: r.filledSize,
              status: r.status,
              error: r.error,
            })),
            summary: {
              total: legs.length,
              filled: stillFilled.length,
              failed: failed.length,
              unknown: unknown.length,
              skipped: legResults.filter(r => r.status === "skipped").length,
              rolledBack: legResults.filter(r => r.status === "rolled_back").length,
              rollbackFailed: rollbackFailed.length,
              quarantined: [...new Set(legResults.filter(r => r.status === "unknown" || r.status === "rollback_failed").map(r => r.leg.symbol))],
            },
          };
          if (outcome === null) {
            printJson(jsonOk(payload));
          } else {
            const message = outcome === "ORDER_PENDING" ? `trade multi: ${unknown.length} leg(s) have an unknown outcome (quarantined)`
              : outcome === "ORDER_PARTIAL" ? `trade multi: ${failed.length} leg(s) failed${partial.length > 0 ? `, ${partial.length} partially filled` : ""}; ${rollbackFailed.length > 0 ? `${rollbackFailed.length} rollback(s) failed (quarantined)` : `${stillFilled.length} leg(s) remain filled`}`
              : `trade multi: ${failed.length} leg(s) failed${partial.length > 0 ? `, ${partial.length} partially filled` : ""}; nothing left open`;
            printJson(jsonError(outcome, message, {
              status: ERROR_CODES[outcome].status,
              retryable: false,
              details: payload,
              ...(outcome !== "ORDER_REJECTED" ? { remediation: "Do NOT resubmit — check every leg's position (perp strategy quarantine; account positions per venue)" } : {}),
            }));
          }
        } else {
          console.log(chalk.cyan.bold("\nResults:\n"));
          for (const r of legResults) {
            const icon = r.status === "filled" ? chalk.green("OK") :
              r.status === "rolled_back" ? chalk.yellow("ROLLBACK") :
              r.status === "skipped" ? chalk.gray("SKIP") :
              r.status === "unknown" ? chalk.red.bold("UNKNOWN (quarantined)") :
              r.status === "rollback_failed" ? chalk.red.bold("ROLLBACK FAILED (quarantined)") :
              chalk.red("FAIL");
            const fill = r.filledSize !== null && r.filledSize !== r.leg.size ? ` (filled ${r.filledSize})` : "";
            console.log(`  ${icon} ${r.leg.exchange.padEnd(14)} ${r.leg.side} ${r.leg.symbol} x ${r.leg.size}${fill}${r.error ? ` — ${r.error}` : ""}`);
          }
          console.log(`\n  Total: ${legs.length}  Filled: ${legResults.filter(r => r.status === "filled").length}  Failed: ${failed.length}  Unknown: ${unknown.length}  Rolled back: ${legResults.filter(r => r.status === "rolled_back").length}`);
          if (unknown.length > 0) console.log(chalk.red("  An unconfirmed leg was quarantined — do NOT resubmit; check the positions (perp strategy quarantine)."));
        }
      });
    });
}
