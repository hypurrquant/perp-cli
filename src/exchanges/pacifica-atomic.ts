/**
 * Pacifica Atomic order: a weighted basket of market orders across several markets, sent in ONE
 * POST /api/v1/orders/batch request.
 *
 * Docs (read 2026-10-19):
 *  - trading-on-pacifica/order-types/strategies/atomic: "Each leg is signed as a market order with
 *    your Max Slippage, and all legs are sent to the exchange in a single batch request. Each leg
 *    can fill or fail independently." Up to 5 legs per side, a market appears once in the basket,
 *    weights are relative, the total size is USD converted to a token amount at each leg's mark
 *    price, Reduce Only applies to every leg. "Atomic does not guarantee an all-or-nothing fill."
 *  - api-documentation/api/rest-api/orders/batch-order: action `type` "CreateMarket"; `data` = the
 *    signed request payload of create-market-order (signing type "create_market_order"); max 10
 *    actions; "If one action fails, subsequent actions are still attempted"; response
 *    `{ success, data: { results: [{ success, order_id, error }] } }`; Status 400 = bad request.
 *  - There is no Atomic endpoint, signing type or order type code: legs are ordinary market
 *    orders (`/orders` and `account_order_updates` show them as `order_type` / `ot` "market").
 *
 * Money safety: every leg is validated (lot, venue minimum, slippage bound, unique market) before
 * anything is signed; the whole basket is signed before the single POST; an unreadable or
 * ambiguous answer is ORDER_PENDING (never resubmitted); a per-leg fill is read back from
 * history_by_id and never assumed.
 */

import { randomUUID } from "crypto";
import { PerpError, extractErrorMessage, orderOutcomeUnknown } from "../errors.js";
import { prepareMessage } from "../pacifica/signing.js";
import { DEFAULT_EXPIRY_WINDOW } from "../pacifica/constants.js";
import type { MarketInfo, PriceInfo } from "../pacifica/types/market.js";
import type { BatchAction } from "../pacifica/types/order.js";
import { isPacificaPerpetual } from "../ws/pacifica-instrument.js";
import { floorSize } from "./precision.js";
import { effectiveLimit, type RiskAssessment } from "../risk.js";
import { symbolNotFound } from "./unknown-symbol.js";
import type { PacificaAdapter, PacificaOrderOutcome } from "./pacifica.js";

/** "Up to 5 markets per side" (atomic docs). */
export const ATOMIC_MAX_LEGS_PER_SIDE = 5;
/** "Maximum 10 actions per batch request" (batch-order docs). */
export const PACIFICA_BATCH_MAX_ACTIONS = 10;
/** Signing operation type of each leg (create-market-order docs). */
export const ATOMIC_LEG_SIGNING_TYPE = "create_market_order";
/** Batch action type of each leg (batch-order docs, case sensitive). */
export const ATOMIC_LEG_ACTION_TYPE = "CreateMarket";
/** Placeholder for the signature in a dry-run plan (nothing is signed in a dry run). */
export const DRY_RUN_SIGNATURE = "<not signed: dry-run>";

export interface AtomicLegSpec {
  /** As given by the user (resolved against /info, case-insensitively). */
  symbol: string;
  side: "buy" | "sell";
  /** Relative weight (> 0). */
  weight: number;
}

export interface AtomicMarket {
  symbol: string;
  lotSize: string;
  /** /info `min_order_size` — "Minimum order size (denominated in USD)". */
  minOrderUsd: string;
  /** /info/prices `mark`. */
  mark: string;
}

export interface AtomicLeg {
  symbol: string;
  side: "buy" | "sell";
  weight: number;
  /** weight / sum of weights. */
  share: number;
  /** total × share, before lot flooring. */
  targetUsd: number;
  mark: string;
  lotSize: string;
  /** Token amount sent: floor(targetUsd / mark) to the lot. */
  size: string;
  /** size × mark. */
  notionalUsd: number;
}

const WEIGHT_RE = /^(\d+(\.\d+)?|\.\d+)$/;

/** `SYMBOL` or `SYMBOL:WEIGHT` (no weight = 1, i.e. equal weights). */
function parseLeg(raw: string, side: "buy" | "sell", flag: string): AtomicLegSpec {
  const s = raw.trim();
  const i = s.lastIndexOf(":");
  const symbol = (i === -1 ? s : s.slice(0, i)).trim();
  const w = i === -1 ? "1" : s.slice(i + 1).trim();
  if (!/^[A-Za-z0-9]+$/.test(symbol)) {
    throw new PerpError("INVALID_PARAMS", `${flag} leg "${raw}": the symbol must be letters and digits (e.g. BTC or BTC:50)`, {
      remediation: `Write each leg as SYMBOL or SYMBOL:WEIGHT, e.g. ${flag} BTC:50 ETH:50`,
    });
  }
  if (!WEIGHT_RE.test(w) || !(Number(w) > 0)) {
    throw new PerpError("INVALID_PARAMS", `${flag} leg "${raw}": the weight must be a positive number (got "${w}")`, {
      remediation: `Write each leg as SYMBOL or SYMBOL:WEIGHT, e.g. ${flag} BTC:50`,
    });
  }
  return { symbol, side, weight: Number(w) };
}

/** --long / --short leg lists → leg specs (≤ 5 per side, ≥ 1 leg, each market once). */
export function parseAtomicLegs(longs: readonly string[], shorts: readonly string[]): AtomicLegSpec[] {
  for (const [list, flag] of [[longs, "--long"], [shorts, "--short"]] as const) {
    if (list.length > ATOMIC_MAX_LEGS_PER_SIDE) {
      throw new PerpError("INVALID_PARAMS", `${flag}: ${list.length} legs; Pacifica Atomic takes up to ${ATOMIC_MAX_LEGS_PER_SIDE} markets per side`, {
        remediation: `Use at most ${ATOMIC_MAX_LEGS_PER_SIDE} ${flag} legs`,
      });
    }
  }
  const legs = [...longs.map(l => parseLeg(l, "buy", "--long")), ...shorts.map(l => parseLeg(l, "sell", "--short"))];
  if (legs.length === 0) {
    throw new PerpError("INVALID_PARAMS", "An Atomic order needs at least one leg", { remediation: "Pass --long SYMBOL[:WEIGHT]... and/or --short SYMBOL[:WEIGHT]..." });
  }
  const seen = new Set<string>();
  for (const l of legs) {
    const k = l.symbol.toUpperCase();
    if (seen.has(k)) {
      throw new PerpError("INVALID_PARAMS", `${l.symbol} appears more than once; a market can appear only once in an Atomic basket`, {
        remediation: "List each market once (combine its weights)",
      });
    }
    seen.add(k);
  }
  return legs;
}

function requirePositiveField(row: Record<string, unknown>, key: string, endpoint: string): string {
  const v = row[key];
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0) return v.trim();
  throw new PerpError("EXCHANGE_ERROR", `Pacifica ${endpoint} ${String(row.symbol)}: no usable ${key} (got ${JSON.stringify(v)})`, {
    exchange: "pacifica", remediation: "Retry; if it persists the venue's market data is incomplete for this market",
  });
}

/**
 * The basket's markets from GET /info + GET /info/prices (public reads). Perp rows only; every
 * requested symbol must be listed, with a positive lot_size / min_order_size and a positive mark
 * (PRICE_STALE otherwise — nothing sent). Resolved to the venue's own spelling (e.g. kBONK).
 */
export function atomicMarketsOf(specs: readonly AtomicLegSpec[], info: readonly MarketInfo[], prices: readonly PriceInfo[]): Map<string, AtomicMarket> {
  const perps = info.filter(isPacificaPerpetual);
  const out = new Map<string, AtomicMarket>();
  for (const s of specs) {
    const row = perps.find(m => m.symbol.toUpperCase() === s.symbol.toUpperCase());
    if (row === undefined) throw symbolNotFound("pacifica", s.symbol);
    const r = row as unknown as Record<string, unknown>;
    const lotSize = requirePositiveField(r, "lot_size", "/info");
    const minOrderUsd = requirePositiveField(r, "min_order_size", "/info");
    const p = prices.find(x => x.symbol === row.symbol);
    const mark = p === undefined ? NaN : Number(p.mark);
    if (p === undefined || !Number.isFinite(mark) || !(mark > 0)) {
      throw new PerpError("PRICE_STALE", `Pacifica ${row.symbol}: no usable mark price to size the Atomic leg; nothing was sent`, {
        exchange: "pacifica", remediation: "Retry in a moment",
      });
    }
    out.set(s.symbol.toUpperCase(), { symbol: row.symbol, lotSize, minOrderUsd, mark: String(p.mark) });
  }
  return out;
}

/**
 * Size every leg: total × weight / Σweights in USD → token amount at the mark, floored to the
 * lot. A leg under one lot → SIZE_TOO_SMALL (nothing sent). Its notional at the mark must be at
 * least the market's USD minimum × (1 + slippage bound), so a sell leg still meets the minimum when
 * it fills at the worst price the bound allows. Reduce-only legs are held to it too (no exemption is
 * documented).
 */
export function sizeAtomicLegs(specs: readonly AtomicLegSpec[], totalUsd: string, markets: ReadonlyMap<string, AtomicMarket>, slippageBps: number): AtomicLeg[] {
  const total = Number(totalUsd);
  if (!Number.isFinite(total) || !(total > 0)) throw new PerpError("INVALID_PARAMS", `--usd must be a positive amount (got "${totalUsd}")`);
  const sum = specs.reduce((a, s) => a + s.weight, 0);
  return specs.map((s): AtomicLeg => {
    const m = markets.get(s.symbol.toUpperCase());
    if (m === undefined) throw symbolNotFound("pacifica", s.symbol);
    const share = s.weight / sum;
    const targetUsd = total * share;
    const raw = (targetUsd / Number(m.mark)).toFixed(12);
    let size: string;
    try {
      size = floorSize(raw, m.lotSize);
    } catch {
      throw new PerpError("SIZE_TOO_SMALL", `Atomic leg ${m.symbol}: $${targetUsd.toFixed(2)} at mark ${m.mark} is ${raw} — below one lot (${m.lotSize}); nothing was sent`, {
        exchange: "pacifica", symbol: m.symbol, lotSize: m.lotSize,
        remediation: "Raise --usd or this leg's weight",
      });
    }
    const notionalUsd = Number(size) * Number(m.mark);
    const requiredUsd = Number(m.minOrderUsd) * (1 + slippageBps / 10_000);
    if (notionalUsd < requiredUsd) {
      throw new PerpError("SIZE_TOO_SMALL", `Atomic leg ${m.symbol}: ${size} (≈ $${notionalUsd.toFixed(2)}) is below the venue minimum order of $${m.minOrderUsd} plus the ${slippageBps} bps slippage bound (≈ $${requiredUsd.toFixed(2)}); nothing was sent`, {
        exchange: "pacifica", symbol: m.symbol, size, minOrderUsd: m.minOrderUsd, requiredUsd,
        remediation: "Raise --usd or this leg's weight",
      });
    }
    return { symbol: m.symbol, side: s.side, weight: s.weight, share, targetUsd, mark: m.mark, lotSize: m.lotSize, size, notionalUsd };
  });
}

/**
 * Reduce-only basket check (read only): every leg must reduce an existing position — a buy needs
 * a short, a sell a long — by no more than its size. Otherwise INVALID_PARAMS, nothing sent.
 */
export function requireAtomicReduceOnly(legs: readonly AtomicLeg[], positions: ReadonlyArray<{ symbol: string; side: "long" | "short"; size: string }>): void {
  for (const l of legs) {
    const need = l.side === "buy" ? "short" : "long";
    const pos = positions.find(p => p.symbol.toUpperCase() === l.symbol.toUpperCase() && Number(p.size) !== 0);
    if (pos === undefined || pos.side !== need) {
      throw new PerpError("INVALID_PARAMS", `--reduce-only: the ${l.side} leg on ${l.symbol} needs an open ${need} position (${pos === undefined ? "none open" : `the position is ${pos.side}`}); nothing was sent`, {
        exchange: "pacifica", remediation: "With --reduce-only, put the markets you are short under --long and those you are long under --short",
      });
    }
    if (Number(l.size) > Math.abs(Number(pos.size))) {
      throw new PerpError("INVALID_PARAMS", `--reduce-only: the ${l.side} leg on ${l.symbol} is ${l.size}, more than the ${pos.size.replace(/^-/, "")} ${need} position; nothing was sent`, {
        exchange: "pacifica", remediation: "Lower --usd (or this leg's weight) so that no leg exceeds its position",
      });
    }
  }
}

/** A client_order_id for one leg: a UUID v4 outside the reserved TIF-encoding prefix (5ac1f). */
export function atomicLegClientOrderId(): string {
  for (;;) {
    const id = randomUUID();
    if (!id.startsWith("5ac1f")) return id;
  }
}

/**
 * Basis points → Pacifica `slippage_percent` as an exact decimal string (1.1 bps → "0.011", not
 * the float "0.011000000000000001"; 50 → "0.5").
 */
export function bpsToPercent(bps: number): string {
  const s = String(bps);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new PerpError("INVALID_PARAMS", `slippage ${s} bps is not a plain decimal`);
  const [int, frac = ""] = s.split(".");
  const digits = (int + frac).replace(/^0+(?=\d)/, "");
  const scale = frac.length + 2;
  const padded = digits.padStart(scale + 1, "0");
  const out = `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

/**
 * Basket-level risk gate (on top of the per-leg enforceOrderRisk, which checks each leg against
 * the max position size): the WHOLE basket's notional against the total-exposure limit and the
 * number of legs that open a new market against max positions — preTradeCheck's rules applied
 * to the basket as one order. Violations → RISK_VIOLATION (nothing sent). --force skips it.
 */
export function atomicBasketRiskCheck(assessment: RiskAssessment, legs: readonly AtomicLeg[], positions: ReadonlyArray<{ symbol: string; size: string }>): void {
  const refuse = (reason: string) => new PerpError("RISK_VIOLATION", `Atomic basket: ${reason}`, {
    exchange: "pacifica", remediation: "Lower --usd / fewer legs, or adjust the limits (perp risk limits …); --force skips the local risk check",
  });
  if (!assessment.canTrade) throw refuse("trading suspended: critical risk violation active");
  const lim = assessment.limits;
  const m = assessment.metrics;
  const basket = legs.reduce((a, l) => a + l.notionalUsd, 0);
  const effExposure = effectiveLimit(lim.maxTotalExposureUsd, lim.maxExposurePct, m.totalEquity);
  if (m.totalExposure + basket > effExposure) {
    throw refuse(`would exceed the total exposure limit ($${(m.totalExposure + basket).toFixed(0)} > $${effExposure.toFixed(0)})`);
  }
  const opening = legs.filter(l => !positions.some(p => p.symbol.toUpperCase() === l.symbol.toUpperCase() && Number(p.size) !== 0)).length;
  if (m.positionCount + opening > lim.maxPositions) {
    throw refuse(`would exceed max positions (${m.positionCount} + ${opening} new > ${lim.maxPositions})`);
  }
}

/**
 * The create_market_order payload of one leg (create-market-order docs: symbol, amount, side,
 * slippage_percent, reduce_only, client_order_id, optional builder_code). Signed as-is.
 */
export function atomicLegPayload(leg: AtomicLeg, o: { reduceOnly: boolean; slippageBps: number; clientOrderId: string; builderCode: string | null }): Record<string, unknown> {
  return {
    symbol: leg.symbol,
    amount: leg.size,
    side: leg.side === "buy" ? "bid" : "ask",
    slippage_percent: bpsToPercent(o.slippageBps),
    reduce_only: o.reduceOnly,
    client_order_id: o.clientOrderId,
    ...(o.builderCode !== null ? { builder_code: o.builderCode } : {}),
  };
}

/**
 * Dry-run plan: the exact POST /orders/batch body the live run would send, with the signature
 * replaced by a placeholder, plus each leg's canonical message (recursively key-sorted compact JSON,
 * `{data, expiry_window, timestamp, type}`) that the live run signs. Nothing is signed.
 */
export function atomicDryRunPlan(payloads: ReadonlyArray<Record<string, unknown>>, o: { account: string | null; agentWallet: string | null; timestamp: number; expiryWindow?: number }): {
  endpoint: string; body: { actions: BatchAction[] }; signedMessages: string[];
} {
  const expiry = o.expiryWindow ?? DEFAULT_EXPIRY_WINDOW;
  const header = { type: ATOMIC_LEG_SIGNING_TYPE, timestamp: o.timestamp, expiry_window: expiry };
  return {
    endpoint: "POST /api/v1/orders/batch",
    body: {
      actions: payloads.map((p) => ({
        type: ATOMIC_LEG_ACTION_TYPE,
        data: {
          account: o.account,
          ...(o.agentWallet !== null ? { agent_wallet: o.agentWallet } : {}),
          signature: DRY_RUN_SIGNATURE,
          timestamp: o.timestamp,
          expiry_window: expiry,
          ...p,
        },
      })),
    },
    signedMessages: payloads.map(p => prepareMessage(header, p)),
  };
}

const BATCH_REMEDIATION = "Do NOT resubmit — some legs may have been executed. Check positions and fills first: perp -e pacifica account positions / trade fills";

/**
 * Error thrown by POST /orders/batch → typed. Already-typed errors (ORDER_PENDING after a send,
 * ORDER_REJECTED when nothing could be sent) are kept. HTTP 400 is the documented whole-request
 * refusal (batch-order: "Status 400: Bad request"; "All signatures must be valid for the batch to
 * process") → ORDER_REJECTED. HTTP 429 → RATE_LIMITED, nothing processed. Any other answer →
 * ORDER_PENDING (undocumented for this endpoint: legs may have executed).
 */
export function atomicBatchError(e: unknown): PerpError {
  if (e instanceof PerpError) return e;
  const msg = extractErrorMessage(e);
  const m = /^POST \/orders\/batch failed \((\d{3})\): ([\s\S]*)$/.exec(msg);
  if (m !== null && m[1] === "400") {
    return new PerpError("ORDER_REJECTED", `Pacifica refused the Atomic batch (HTTP 400, no leg was processed): ${m[2].slice(0, 300)}`, {
      exchange: "pacifica", httpStatus: 400, remediation: "Fix the parameters named in the message and retry",
    });
  }
  if (m !== null && m[1] === "429") {
    return new PerpError("RATE_LIMITED", `Pacifica rate-limited the Atomic batch (HTTP 429, no leg was processed): ${m[2].slice(0, 300)}`, {
      exchange: "pacifica", httpStatus: 429, sent: false, remediation: "Wait for the rate-limit window to reset, then retry",
    });
  }
  return orderOutcomeUnknown("pacifica", "Atomic batch", e, BATCH_REMEDIATION);
}

export type AtomicAck = { kind: "accepted"; orderId: string | null } | { kind: "rejected"; error: string } | { kind: "unknown"; reason: string };

/**
 * Per-leg acks of a 200 batch response, in leg order. The body must carry `data.results` with one
 * row per action; otherwise the batch's effect is unknown → ORDER_PENDING. A row with
 * `success: true` was accepted (its `order_id` may be null — the docs' own example has one); a row
 * with `success: false` and an error string was refused; anything else is unknown.
 */
export function parseAtomicBatchResponse(raw: unknown, legCount: number): AtomicAck[] {
  const pending = (why: string) => orderOutcomeUnknown("pacifica", "Atomic batch", new Error(why), BATCH_REMEDIATION);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw pending(`unreadable batch response ${JSON.stringify(raw)?.slice(0, 200)}`);
  const r = raw as Record<string, unknown>;
  const data = r.data;
  const results = data !== null && typeof data === "object" ? (data as Record<string, unknown>).results : undefined;
  if (!Array.isArray(results)) {
    throw pending(`batch response without data.results (success ${JSON.stringify(r.success)}, error ${JSON.stringify(r.error)})`);
  }
  if (results.length !== legCount) {
    throw pending(`batch response has ${results.length} results for ${legCount} legs`);
  }
  return results.map((row): AtomicAck => {
    if (row === null || typeof row !== "object") return { kind: "unknown", reason: `unreadable result ${JSON.stringify(row)}` };
    const x = row as Record<string, unknown>;
    if (x.success === true) {
      const id = typeof x.order_id === "number" || (typeof x.order_id === "string" && /^\d+$/.test(x.order_id)) ? String(x.order_id) : null;
      return { kind: "accepted", orderId: id };
    }
    if (x.success === false && typeof x.error === "string" && x.error !== "") return { kind: "rejected", error: x.error };
    return { kind: "unknown", reason: `result without a definite success/error: ${JSON.stringify(x).slice(0, 160)}` };
  });
}

export interface AtomicLegOutcome {
  symbol: string;
  side: "buy" | "sell";
  size: string;
  clientOrderId: string;
  orderId: string | null;
  /** filled / partiallyFilled = venue-final; notFilled = cancelled with nothing filled; unknown = not proven. */
  status: "filled" | "partiallyFilled" | "notFilled" | "rejected" | "unknown";
  filledSize: string | null;
  detail: string | null;
}

/**
 * Leg outcome from its ack, the order id it was traced to (the ack's, or one resolved from the
 * leg's client_order_id; null = never traced) and that order's history_by_id outcome (null = not
 * resolved).
 */
export function atomicLegOutcome(leg: AtomicLeg, clientOrderId: string, ack: AtomicAck, orderId: string | null, history: PacificaOrderOutcome | null): AtomicLegOutcome {
  const base = { symbol: leg.symbol, side: leg.side, size: leg.size, clientOrderId };
  if (ack.kind === "rejected") return { ...base, orderId: null, status: "rejected", filledSize: "0", detail: ack.error };
  if (ack.kind === "unknown") return { ...base, orderId: null, status: "unknown", filledSize: null, detail: ack.reason };
  if (orderId === null) {
    return { ...base, orderId: null, status: "unknown", filledSize: null, detail: `accepted without an order_id, and client_order_id ${clientOrderId} was not found in open orders / order history` };
  }
  if (history === null) return { ...base, orderId, status: "unknown", filledSize: null, detail: "accepted; fill not confirmed (history_by_id)" };
  const map: Record<PacificaOrderOutcome["status"], AtomicLegOutcome["status"]> = {
    filled: "filled", partiallyFilled: "partiallyFilled", cancelled: "notFilled", rejected: "rejected", open: "unknown",
  };
  return { ...base, orderId, status: map[history.status], filledSize: history.filledSize, detail: `history_by_id ${history.venueStatus}` };
}

/**
 * The failure an Atomic basket reports unless every leg filled completely: any unknown leg →
 * ORDER_PENDING (do not resubmit); nothing filled at all → ORDER_REJECTED; otherwise
 * ORDER_PARTIAL. details carry every leg.
 */
export function atomicIncompleteError(legs: readonly AtomicLegOutcome[]): PerpError | null {
  const count = (s: AtomicLegOutcome["status"]) => legs.filter(l => l.status === s).length;
  if (count("filled") === legs.length) return null;
  const summary = `${count("filled")} filled, ${count("partiallyFilled")} partly filled, ${count("notFilled") + count("rejected")} not filled, ${count("unknown")} unknown`;
  const details = { exchange: "pacifica", legs };
  if (count("unknown") > 0) {
    return new PerpError("ORDER_PENDING", `Pacifica Atomic basket: the outcome of ${count("unknown")} leg(s) is unknown (${summary})`, { ...details, remediation: BATCH_REMEDIATION });
  }
  if (count("filled") === 0 && count("partiallyFilled") === 0) {
    return new PerpError("ORDER_REJECTED", `Pacifica Atomic basket: no leg filled — ${legs.map(l => `${l.symbol}: ${l.detail ?? l.status}`).join("; ")}`, details);
  }
  return new PerpError("ORDER_PARTIAL", `Pacifica Atomic basket: ${summary}`, {
    ...details, remediation: "The basket is unbalanced. Inspect: perp -e pacifica account positions — then adjust or close the filled legs",
  });
}

/** Safety margin under the signature expiry: the batch is not sent when less than this is left. */
export const ATOMIC_EXPIRY_MARGIN_MS = 1_500;
/** client_order_id → order_id lookups for a leg accepted without an order_id. */
export const ATOMIC_CLOID_POLLS = 6;
export const ATOMIC_CLOID_POLL_MS = 500;

export interface AtomicDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const REAL_DEPS: AtomicDeps = { now: () => Date.now(), sleep: (ms) => new Promise(r => setTimeout(r, ms)) };

/**
 * order_id of a leg accepted without one (the batch docs' CreateMarket result carries
 * `order_id: null`), found by its client_order_id in open orders / order history
 * (PacificaAdapter.orderByClientId). Bounded: ATOMIC_CLOID_POLLS reads ATOMIC_CLOID_POLL_MS apart;
 * read errors poll again. null = never found (the leg stays unknown).
 */
export async function resolveAtomicLegOrderId(adapter: Pick<PacificaAdapter, "orderByClientId">, clientOrderId: string, deps: AtomicDeps = REAL_DEPS): Promise<string | null> {
  for (let attempt = 0; attempt < ATOMIC_CLOID_POLLS; attempt++) {
    await deps.sleep(ATOMIC_CLOID_POLL_MS);
    try {
      const hit = await adapter.orderByClientId(clientOrderId);
      if (hit !== null) return hit.orderId;
    } catch {
      // A failed read proves nothing either way: poll again; never found → the leg stays unknown.
    }
  }
  return null;
}

/**
 * Sign every leg (create_market_order) with ONE shared timestamp, send them in ONE batch, then
 * read each accepted leg's fill back (in parallel — reads only). Signing failures and a signature
 * that would expire within ATOMIC_EXPIRY_MARGIN_MS (a slow signer) stop before anything is sent
 * (ORDER_REJECTED). Returns the per-leg outcomes; the caller decides with atomicIncompleteError.
 */
export async function executeAtomic(
  adapter: PacificaAdapter,
  legs: readonly AtomicLeg[],
  payloads: ReadonlyArray<Record<string, unknown>>,
  deps: AtomicDeps = REAL_DEPS,
): Promise<{ outcomes: AtomicLegOutcome[]; venueRaw: unknown }> {
  if (legs.length !== payloads.length || legs.length === 0 || legs.length > PACIFICA_BATCH_MAX_ACTIONS) {
    throw new PerpError("INVALID_PARAMS", `Atomic basket must have 1..${PACIFICA_BATCH_MAX_ACTIONS} legs (got ${legs.length})`);
  }
  adapter.prepareSigning();
  const header = { timestamp: deps.now(), expiry_window: DEFAULT_EXPIRY_WINDOW };
  const actions: BatchAction[] = [];
  for (const p of payloads) {
    actions.push({ type: ATOMIC_LEG_ACTION_TYPE, data: await adapter.sdk.signBatchAction(ATOMIC_LEG_SIGNING_TYPE, p, adapter.publicKey, adapter.signer, header) });
  }
  const elapsed = deps.now() - header.timestamp;
  if (elapsed >= header.expiry_window - ATOMIC_EXPIRY_MARGIN_MS) {
    throw new PerpError("ORDER_REJECTED", `Pacifica Atomic batch not sent: signing ${legs.length} legs took ${elapsed} ms, leaving less than ${ATOMIC_EXPIRY_MARGIN_MS} ms of the ${header.expiry_window} ms signature window`, {
      exchange: "pacifica", sent: false, remediation: "Nothing was sent. Retry; if the signer is slow (hardware / remote wallet), use fewer legs",
    });
  }
  let raw: unknown;
  try {
    raw = await adapter.sdk.batchOrders(actions);
  } catch (e) {
    throw atomicBatchError(e);
  }
  const acks = parseAtomicBatchResponse(raw, legs.length);
  const outcomes = await Promise.all(legs.map(async (leg, i): Promise<AtomicLegOutcome> => {
    const ack = acks[i];
    const cloid = String(payloads[i].client_order_id);
    if (ack.kind !== "accepted") return atomicLegOutcome(leg, cloid, ack, null, null);
    const orderId = ack.orderId !== null ? ack.orderId : await resolveAtomicLegOrderId(adapter, cloid, deps);
    const history = orderId === null ? null
      : await adapter.resolveOrderOutcome(orderId, `atomic ${leg.side} ${leg.size} ${leg.symbol}`, { terminalOnly: true });
    return atomicLegOutcome(leg, cloid, ack, orderId, history);
  }));
  return { outcomes, venueRaw: raw };
}
