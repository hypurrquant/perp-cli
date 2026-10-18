/**
 * TradingV2 — normalized order entry for venues added under the venue
 * abstraction.
 *
 * Method names deliberately do not overlap the legacy ExchangeAdapter trading
 * methods, so an adapter can implement both without overloads.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { PerpError } from "../errors.js";
import type { VenueCapabilities, VenueDefinition } from "./venue.js";
import { orderRefOf } from "./venue-types.js";
import { requirePositive } from "./precision.js";
import type {
  AmendRequest, CancelResult, LeverageResult, Network, OrderRef, OrderRequest, OrderResult, TimeInForce,
  VenueId, VenueMarket,
} from "./venue-types.js";

export interface VenueBase {
  readonly name: VenueId;
  readonly venue: VenueDefinition;
  readonly network: Network;
}

export interface VenueMarketsSource extends VenueBase {
  getVenueMarkets(): Promise<VenueMarket[]>;
}

export interface TradingV2 extends VenueMarketsSource {
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  amendOrder(req: AmendRequest): Promise<OrderResult>;
  cancelByRef(symbol: string, ref: OrderRef): Promise<CancelResult>;
  cancelAllV2(symbol: string | null): Promise<CancelResult>;
  applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult>;
  getOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult>;
}

export function isTradingV2(a: unknown): a is TradingV2 {
  const r = a as Record<string, unknown> | null;
  return !!r
    && typeof r.placeOrder === "function"
    && typeof r.cancelByRef === "function"
    && typeof r.getOrderStatus === "function"
    && typeof r.getVenueMarkets === "function";
}

/**
 * Uniform "not supported" response: CAPABILITY_UNSUPPORTED
 * with details { venue, feature, reason } and an alternative in `remediation`.
 * `venue` is a venue id or display name; `feature` a short capability name
 * ("limitOrder", "fok", "postOnly", "amend", "trading", "orderbook", ...).
 */
export function unsupported(venue: string, feature: string, reason: string, remediation: string): PerpError {
  return new PerpError("CAPABILITY_UNSUPPORTED", `${venue} does not support ${feature} — ${reason}`, {
    venue, feature, reason, remediation,
  });
}

/**
 * An adapter whose reduce-only orders are currently refused (a venue whose reduce-only wire
 * format is not set; none today) reports why. Callers that will need a reduce-only order
 * LATER in a flow ask first — an entry carrying --tp/--sl is refused BEFORE the entry is sent
 * (never "entry filled, protection failed"), and a close is refused before any read. Adapters
 * without the method have no such gate.
 */
export function reduceOnlyGateOf(adapter: unknown): PerpError | null {
  const fn = (adapter as { reduceOnlyGate?: unknown } | null)?.reduceOnlyGate;
  if (typeof fn !== "function") return null;
  const gate = (fn as () => unknown).call(adapter);
  return gate instanceof PerpError ? gate : null;
}

/**
 * An adapter whose STOP orders are currently refused (QFEX until stop acknowledgements can be
 * correlated) reports why. `--tp/--sl` entries and `trade tpsl` ask first, so an entry is never
 * sent when its protective legs would be refused. Adapters without the method have no such gate.
 */
export function stopOrderGateOf(adapter: unknown): PerpError | null {
  const fn = (adapter as { stopOrderGate?: unknown } | null)?.stopOrderGate;
  if (typeof fn !== "function") return null;
  const gate = (fn as () => unknown).call(adapter);
  return gate instanceof PerpError ? gate : null;
}

/**
 * An adapter on which UNATTENDED automation is currently refused (QFEX while its stop orders are
 * refused) reports why. Bots, plans, TWAP, DCA, grid, funding-arb, trailing stop and background
 * jobs ask before they start; manual commands never ask. Adapters without the method have no
 * such gate.
 */
export function automationGateOf(adapter: unknown): PerpError | null {
  const fn = (adapter as { automationGate?: unknown } | null)?.automationGate;
  if (typeof fn !== "function") return null;
  const gate = (fn as () => unknown).call(adapter);
  return gate instanceof PerpError ? gate : null;
}

/**
 * Refuse to START anything that trades unattended on a venue that cannot close or protect its
 * positions. Bots, plans, TWAP, DCA, grid, funding-arb, trailing stop and background jobs all
 * need a reduce-only order later (close / stop / drawdown exit): on a venue whose reduce-only
 * orders are gated (reduceOnlyGateOf) they would open a position they cannot close, and on a
 * venue that refuses automation (automationGateOf) they would run without a protective exit.
 * Throws the gate before the first order.
 */
export function assertCanClosePositions(adapter: unknown, what: string): void {
  const reduceOnly = reduceOnlyGateOf(adapter);
  if (reduceOnly !== null) throw startRefusal(what, "it could open a position it cannot close", reduceOnly);
  const automation = automationGateOf(adapter);
  if (automation !== null) throw startRefusal(what, "it would trade unattended", automation);
}

/** The gate's own code / details / remediation, with what was refused and why in front. */
export function startRefusal(what: string, why: string, gate: PerpError): PerpError {
  const remediation = gate.structured.remediation;
  return new PerpError(gate.structured.code, `${what} refused: ${why} — ${gate.message}`, {
    ...(gate.structured.details === undefined ? {} : gate.structured.details),
    ...(remediation === undefined ? {} : { remediation }),
  });
}

/**
 * Validate an order request against the venue's declared capabilities BEFORE
 * anything is sent. Throws; never adjusts the request.
 */
export function validateOrderRequest(venue: VenueDefinition, caps: VenueCapabilities, req: OrderRequest): void {
  const isStop = req.type === "stopMarket" || req.type === "stopLimit";
  const needsPrice = req.type === "limit" || req.type === "stopLimit";
  const isMarketLike = req.type === "market" || req.type === "stopMarket";

  if (needsPrice && req.price === null) {
    throw new PerpError("INVALID_PARAMS", `${req.type} order requires a price`);
  }
  if (isStop && req.triggerPrice === null) {
    throw new PerpError("INVALID_PARAMS", `${req.type} order requires a trigger price`);
  }
  if (!isStop && req.triggerPrice !== null) {
    throw new PerpError("INVALID_PARAMS", `triggerPrice is only valid for stop orders`);
  }
  // A zero / negative / non-decimal price is never sent to the venue.
  if (req.price !== null) requirePositive(req.price, "price");
  if (req.triggerPrice !== null) requirePositive(req.triggerPrice, "triggerPrice");

  // Callers resolve the common default (GTC) before building the request;
  // a missing TIF here is a programming error, never a user-facing TIF_REQUIRED.
  if (needsPrice && req.tif === null) {
    throw new PerpError("INVALID_PARAMS", `${venue.displayName} ${req.type} order is missing its resolved time-in-force`);
  }
  if (req.tif !== null) {
    if (isMarketLike) {
      throw new PerpError("INVALID_PARAMS", `time-in-force is not valid for ${req.type} orders`);
    }
    if (!caps.timeInForce.includes(req.tif)) {
      throw unsupported(venue.displayName, "timeInForce", `time-in-force ${req.tif} is not offered`, `Use one of: ${caps.timeInForce.join(", ")}`);
    }
  }

  // A reduce-only limit order may only carry the TIFs the venue allows for it (Ondo: IOC only —
  // a resting reduce-only order is refused there); refused before anything is sent.
  if (req.reduceOnly && req.type === "limit" && req.tif !== null && caps.reduceOnlyTif !== null && !caps.reduceOnlyTif.includes(req.tif)) {
    const alternative = `set a take-profit / stop-loss on the position instead: perp trade tpsl ${req.symbol} <long|short> --tp <price>${caps.tpsl !== null && caps.tpsl !== "positionLevel" ? " [--size <qty>]" : ""} -e ${venue.id}`;
    throw unsupported(venue.displayName, "restingReduceOnly",
      `a reduce-only limit order can only be ${caps.reduceOnlyTif.join(" / ")} (got ${req.tif})`,
      `Use --tif ${caps.reduceOnlyTif.join(" | ")}, or ${alternative}`);
  }

  // Callers always pass resolveSlippage() output for market orders; a
  // missing bound here is a programming error, never "send unbounded".
  if (req.type === "market" && req.slippage === null) {
    throw new PerpError("INVALID_PARAMS", `${venue.displayName} market order is missing its resolved slippage bound`);
  }
  if (req.slippage !== null && (!Number.isFinite(req.slippage.bps) || req.slippage.bps < 1 || req.slippage.bps > venue.maxSlippageBps)) {
    throw new PerpError("INVALID_PARAMS", `slippage ${req.slippage.bps} bps is outside 1..${venue.maxSlippageBps} for ${venue.displayName}`);
  }

  if (caps.orderAck === "async" && req.clientOrderId === null) {
    throw new PerpError("INVALID_PARAMS", `${venue.displayName} acknowledges orders asynchronously; a clientOrderId is required`);
  }
  if (req.clientOrderId !== null && !caps.clientOrderId) {
    throw unsupported(venue.displayName, "clientOrderId", "the venue has no client order ids", "Omit the client order id");
  }

  if (req.tpsl !== null) {
    if (req.tpsl.tp === null && req.tpsl.sl === null) {
      throw new PerpError("INVALID_PARAMS", "tpsl given but neither tp nor sl is set");
    }
    if (caps.tpsl !== "attached" && caps.tpsl !== "batchGroup") {
      throw unsupported(venue.displayName, "tpslAttached", "TP/SL cannot be attached to an entry order", `Place the entry, then run: perp trade tpsl -e ${venue.id}`);
    }
  }

  if (isStop && caps.tpsl === "batchGroup" && !req.reduceOnly) {
    throw unsupported(venue.displayName, "openingStop", "stop orders cannot open a position", "Stop orders on this venue must be reduce-only");
  }
}

/**
 * Common TIF aliases: a common name the venue lists under its own
 * spelling, and venue spellings accepted for the common name. Only same-meaning
 * pairs: GTC ↔ GTT (resting until cancelled / venue expiry), ALO ↔ GTX (post-only).
 */
const TIF_ALIASES: Readonly<Partial<Record<TimeInForce, readonly TimeInForce[]>>> = {
  GTC: ["GTT"],
  GTT: ["GTC"],
  ALO: ["GTX"],
  GTX: ["ALO"],
};

/**
 * Resolve a CLI TIF input (common GTC/IOC/FOK/ALO or a venue alias GTT/GTX/TOB,
 * case-insensitive) to a value the venue declares in its capabilities. Never
 * substitutes a different meaning: FOK is never emulated and an
 * unknown / unoffered value is the uniform CAPABILITY_UNSUPPORTED response.
 */
export function validateLegacyTif(venue: VenueDefinition, caps: VenueCapabilities, tif: string): TimeInForce {
  const upper = tif.trim().toUpperCase() as TimeInForce;
  if (caps.timeInForce.includes(upper)) return upper;
  for (const alias of TIF_ALIASES[upper] ?? []) {
    if (caps.timeInForce.includes(alias)) return alias;
  }
  if (upper === "FOK") {
    throw unsupported(venue.displayName, "fok", "fill-or-kill is not offered and is never emulated (a partial IOC fill cannot be undone)",
      `Use --tif IOC (partial fills possible) or one of: ${caps.timeInForce.join(", ")}`);
  }
  const feature = upper === "ALO" || upper === "GTX" ? "postOnly" : "timeInForce";
  throw unsupported(venue.displayName, feature, `time-in-force ${tif} is not offered`, `Use one of: ${caps.timeInForce.join(", ")}`);
}

const FINAL_STATUSES = new Set<OrderResult["status"]>(["filled", "rejected", "cancelled"]);

/**
 * Poll getOrderStatus until the order reaches a final state, is resting ("open"),
 * or the timeout elapses. On timeout returns the last observation with
 * finality "pending" — never guesses a fill.
 *
 * `untilResting`: treat "open"/"partiallyFilled" as a stopping point (limit orders).
 * `ack`: the placement acknowledgement of an async venue. When set, an
 * ORDER_NOT_FOUND from getOrderStatus inside this loop means "acknowledged but
 * not yet visible on the read path" (Arcus forwards to the engine before the
 * order store has it) and the ack itself (status "accepted") stands as the
 * observation. Outside this loop ORDER_NOT_FOUND is never reinterpreted.
 */
export async function awaitOrderFinal(
  adapter: TradingV2,
  symbol: string,
  ref: OrderRef,
  opts: { timeoutMs: number; pollMs: number; untilResting: boolean; ack: OrderResult | null },
): Promise<OrderResult> {
  if (!(opts.timeoutMs > 0) || !(opts.pollMs > 0)) {
    throw new PerpError("INVALID_PARAMS", "awaitOrderFinal: timeoutMs and pollMs must be positive");
  }
  if (opts.ack !== null && opts.ack.status !== "accepted") {
    throw new PerpError("INVALID_PARAMS", `awaitOrderFinal: ack must have status "accepted" (got ${opts.ack.status})`);
  }
  const deadline = Date.now() + opts.timeoutMs;
  let last: OrderResult | null = null;
  for (;;) {
    try {
      last = await adapter.getOrderStatus(symbol, ref);
    } catch (e) {
      if (opts.ack === null || !(e instanceof PerpError) || e.structured.code !== "ORDER_NOT_FOUND") throw e;
      last = opts.ack;
    }
    if (FINAL_STATUSES.has(last.status)) return { ...last, finality: "final" };
    if (opts.untilResting && (last.status === "open" || last.status === "partiallyFilled")) {
      return { ...last, finality: "final" };
    }
    if (Date.now() + opts.pollMs > deadline) return { ...last, finality: "pending" };
    await new Promise(r => setTimeout(r, opts.pollMs));
  }
}

/** Generate a client order id: time-ordered, 20 chars max, [0-9a-z]. */
export function newClientOrderId(prefix = "p"): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
  return `${prefix}${t}${r}`.slice(0, 20);
}

/**
 * Client order id in the venue's format: Lighter-family `clientOrderIndex` is a
 * decimal integer ≤ 2^48 − 1 (ms timestamp × 100 + 2 random digits); QFEX and Pacifica take a
 * UUID (QFEX: the format the venue itself generates; Pacifica: "Full UUID string"); Hyperliquid a
 * 128-bit cloid ("0x" + 32 hex); every other venue (Aster: [.A-Z:/a-z0-9_-]{1,36}) takes
 * newClientOrderId().
 */
export function newVenueClientOrderId(venue: VenueDefinition): string {
  if (venue.family === "lighter") return String(Date.now() * 100 + Math.floor(Math.random() * 100));
  if (venue.family === "qfex" || venue.family === "pacifica") return randomUUID();
  if (venue.family === "hyperliquid") return `0x${randomBytes(16).toString("hex")}`;
  // RISEx: uint64 decimal — ms timestamp × 1e6 + 6 random digits (< 2^64).
  if (venue.family === "risex") return (BigInt(Date.now()) * 1_000_000n + BigInt(randomBytes(4).readUInt32BE(0) % 1_000_000)).toString();
  return newClientOrderId();
}

/** OrderResult plus the caller-facing next step when the outcome is not final (null when final). */
export type PlacedOrder = OrderResult & { remediation: string | null };

/** Finality wait after an async (orderAck "async") placement ack. */
const ASYNC_ACK_TIMEOUT_MS = 15_000;
const ASYNC_ACK_POLL_MS = 1_000;

/**
 * Place through TradingV2 and settle the outcome as far as the venue can prove it:
 * async-ack venues are polled with awaitOrderFinal until final / resting (non-market)
 * or ASYNC_ACK_TIMEOUT_MS. A non-final result carries a "do NOT resubmit" remediation;
 * a failed status poll after the ack is never reported as a failed order.
 */
export async function placeAndConfirm(adapter: TradingV2, caps: VenueCapabilities, req: OrderRequest): Promise<PlacedOrder> {
  const placed = await adapter.placeOrder(req);
  const def = adapter.venue;
  const listHint = `perp account orders -e ${def.id} / perp account positions -e ${def.id}`;
  if (placed.finality === "final") return { ...placed, remediation: null };
  // The venue's own acknowledgement already reports a resting order (Arcus answers OPEN with the
  // full remaining size; its order read can 404 for a moment after that): for a resting TIF that
  // is the order's settled state — the same stopping point awaitOrderFinal uses (untilResting).
  if (req.type !== "market" && req.tif !== "IOC" && req.tif !== "FOK" && (placed.status === "open" || placed.status === "partiallyFilled")) {
    return { ...placed, finality: "final", remediation: null };
  }
  if (caps.orderAck !== "async" || (placed.orderId === null && placed.clientOrderId === null)) {
    return { ...placed, remediation: `${def.displayName} acknowledged the order without a final status — do NOT resubmit; verify with: ${listHint}` };
  }
  const ref = placed.clientOrderId !== null ? `c:${placed.clientOrderId}` : (placed.orderId as string);
  const statusHint = `perp trade status ${ref} --symbol ${req.symbol} -e ${def.id}`;
  let result: OrderResult;
  try {
    result = await awaitOrderFinal(adapter, req.symbol, orderRefOf(placed), {
      timeoutMs: ASYNC_ACK_TIMEOUT_MS,
      pollMs: ASYNC_ACK_POLL_MS,
      untilResting: req.type !== "market",
      ack: placed.status === "accepted" ? placed : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...placed,
      remediation: `Order was accepted by ${def.displayName} but its status could not be confirmed (${msg}). Do NOT resubmit — check: ${statusHint}`,
    };
  }
  if (result.finality === "pending") {
    return { ...result, remediation: `Order not final after ${ASYNC_ACK_TIMEOUT_MS / 1000}s — do NOT resubmit; check: ${statusHint}` };
  }
  return { ...result, remediation: null };
}
