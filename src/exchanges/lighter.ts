import type {
  ExchangeAdapter,
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
  ExchangePublicTrade,
  ExchangeFundingPayment,
  ExchangeKline,
  FundingHistoryRow,
} from "./interface.js";
import type { ResolvedSlippage } from "./slippage.js";
import { alignProtectionPrice, floorSize, formatComputedPrice, mulDecimal, slippagePrice, toUnitsExact, unitsToString } from "./precision.js";
import { unsupported } from "./trading-v2.js";
import type { EvmSigner } from "../signer/index.js";
import { LocalEvmSigner } from "../signer/index.js";
import type { AgentMeta } from "../settings.js";
import { isExpired } from "../agent-wallet/expiry.js";
import { PerpError, classifyError, extractErrorMessage, orderNotSent, orderOutcomeUnknown, sendFailure, unknownActionRemediation, parsePositiveDecimal, DEFINITE_ORDER_FAILURE_CODES, type ErrorCode } from "../errors.js";
import { parseFiniteVenueNumber, venueRateField } from "../utils/numeric.js";
import type { Network, VenueNetworkConfig } from "./venue.js";
import {
  lighterFamilyNetworks, LIGHTER_RH_RATE_LIMIT, LIGHTER_RH_RESERVED_KEY_INDEXES,
  LIGHTER_GTT_EXPIRY_MS, LIGHTER_CLIENT_ORDER_INDEX_MAX, LIGHTER_REFERENCE_PRICE_SOURCE,
} from "./venues/lighter-family.js";
import { acquireRate, rateLimitedError } from "./rate-limiter.js";
import { lighterWafChallenge } from "./lighter-public.js";
import { fetchAndCache, invalidateCache, setCached, withCache, TTL_ACCOUNT } from "../cache.js";
import type { LighterVenueId } from "./venues/lighter-family.js";

import { LighterWasmSigner, type LighterSignResult } from "./lighter-signer.js";

type WasmTxResponse = LighterSignResult;

/** Lighter trigger orderType enum (matches WASM signer). */
export const LIGHTER_ORDER_TYPE = {
  STOP_LOSS: 2,
  STOP_LOSS_LIMIT: 3,
  TAKE_PROFIT: 4,
  TAKE_PROFIT_LIMIT: 5,
} as const;

export type LighterTriggerOrderType =
  | typeof LIGHTER_ORDER_TYPE.STOP_LOSS
  | typeof LIGHTER_ORDER_TYPE.STOP_LOSS_LIMIT
  | typeof LIGHTER_ORDER_TYPE.TAKE_PROFIT
  | typeof LIGHTER_ORDER_TYPE.TAKE_PROFIT_LIMIT;

/**
 * Pick Lighter trigger orderType from side, trigger price, and current mark.
 *
 * STOP_LOSS protects against adverse moves; TAKE_PROFIT locks in favorable moves.
 *   buy + trigger >= mark  → STOP_LOSS  (close short on rise / breakout entry)
 *   buy + trigger <  mark  → TAKE_PROFIT (close short on fall)
 *   sell + trigger <= mark → STOP_LOSS  (close long on fall)
 *   sell + trigger >  mark → TAKE_PROFIT (close long on rise)
 *
 * Tied trigger==mark is classified as STOP_LOSS — the protective default.
 */
export function classifyTriggerOrderType(
  side: "buy" | "sell",
  triggerPrice: number,
  markPrice: number,
  isMarket: boolean,
): LighterTriggerOrderType {
  const isStopLoss = side === "buy" ? triggerPrice >= markPrice : triggerPrice <= markPrice;
  if (isStopLoss) return isMarket ? LIGHTER_ORDER_TYPE.STOP_LOSS : LIGHTER_ORDER_TYPE.STOP_LOSS_LIMIT;
  return isMarket ? LIGHTER_ORDER_TYPE.TAKE_PROFIT : LIGHTER_ORDER_TYPE.TAKE_PROFIT_LIMIT;
}

/** Lighter order time-in-force enum (lighter-go / SDK `TimeInForce`): 0 IOC, 1 GTT, 2 post-only. */
export const LIGHTER_TIF = { IOC: 0, GTT: 1, POST_ONLY: 2 } as const;

/**
 * One GET /api/v1/fundings row → a funding history row (fraction per 1 h, signed).
 * `rate` is percent per hour, unsigned; `direction` "long" = longs pay (positive), "short" = shorts pay.
 */
export function lighterFundingRow(venue: string, f: unknown): FundingHistoryRow {
  const x = f as { timestamp?: unknown; rate?: unknown; direction?: unknown };
  if (typeof x.timestamp !== "number" || !Number.isFinite(x.timestamp) || x.timestamp <= 0) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} /fundings: row without a numeric timestamp: ${JSON.stringify(f).slice(0, 160)}`, { exchange: venue });
  }
  if (typeof x.rate !== "string" || !/^\d+(\.\d+)?$/.test(x.rate)) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} /fundings: row without an unsigned decimal rate: ${JSON.stringify(f).slice(0, 160)}`, { exchange: venue });
  }
  if (x.direction !== "long" && x.direction !== "short") {
    throw new PerpError("EXCHANGE_ERROR", `${venue} /fundings: unknown direction ${JSON.stringify(x.direction)}`, { exchange: venue });
  }
  return {
    time: x.timestamp * 1000,
    rate: mulDecimal(x.rate, x.direction === "long" ? "0.01" : "-0.01"),
    price: null,
    intervalHours: 1,
    rateKind: "lastSettled",
  };
}

/** Decimal step for `decimals` digits ("1" for 0, "0.01" for 2). */
function lighterStep(decimals: number): string {
  return decimals <= 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
}

/**
 * CLI format rule for a Lighter client order id: the venue's
 * `clientOrderIndex` is numeric, so the id must be a plain decimal integer string
 * (digits only, no sign / leading zero / exponent) in 1 ≤ n ≤ 2^48 − 1.
 * Anything else → INVALID_PARAMS before anything is sent.
 */
export function lighterClientOrderIndex(id: string): number {
  const n = /^[1-9][0-9]*$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n) || n > LIGHTER_CLIENT_ORDER_INDEX_MAX) {
    throw new PerpError("INVALID_PARAMS", `Lighter client order id "${id}" must be a decimal integer from 1 to ${LIGHTER_CLIENT_ORDER_INDEX_MAX} (2^48 − 1)`, {
      remediation: `Use a numeric client order id, e.g. ${Date.now()}`,
    });
  }
  return n;
}

/**
 * Generated Lighter client order index (uint48, 1 ≤ n ≤ 2^48 − 1). Layout: the low 38 bits
 * of the millisecond timestamp (wraps every ~8.7 years) shifted left 10 bits, plus 10 random
 * bits. Two orders collide only when sent in the same millisecond AND drawing the same
 * random value (1/1024) — the former second-granularity timestamp + per-process counter
 * collided across processes within the same second. Caller-given ids are validated
 * separately (lighterClientOrderIndex).
 */
export function lighterGeneratedClientOrderIndex(): number {
  const ms = Date.now() % 2 ** 38;
  const rnd = Math.floor(Math.random() * 1024);
  const idx = ms * 1024 + rnd;
  return idx >= 1 ? idx : 1;
}

/**
 * /tx status codes (apidocs "Data Structures, Constants and Errors" → Transaction Status
 * Mapping): 0 Failed · 1 Pending · 2 Executed · 3 Pending - Final State.
 */
export const LIGHTER_TX_STATUS = { FAILED: 0, PENDING: 1, EXECUTED: 2, PENDING_FINAL: 3 } as const;

/**
 * Parsed `event_info` of a /tx row (JSON string on the wire), or null when absent / unparseable.
 * Integers of 16+ digits (order ids such as Lighter RH's 32088147345014782 > 2^53) are kept as
 * exact decimal strings — JSON.parse would round them to another order's id.
 */
export function lighterEventInfo(eventInfo: unknown): Record<string, unknown> | null {
  let parsed: unknown = eventInfo;
  if (typeof eventInfo === "string") {
    if (eventInfo === "") return null;
    try { parsed = JSON.parse(eventInfo.replace(/([:,[]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"')); } catch { return null; }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/** Exact venue order id of an event_info order object's `i` (decimal string or safe integer), else null. */
export function lighterEventOrderId(i: unknown): string | null {
  if (typeof i === "string") return /^\d+$/.test(i) && i !== "0" ? i : null;
  return typeof i === "number" && Number.isSafeInteger(i) && i > 0 ? String(i) : null;
}

/** One /tx poll, classified. */
export type LighterTxState =
  | { kind: "executed"; status: number; eventInfo: Record<string, unknown> | null }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "pending"; status: number | null };

/**
 * Classify a /tx response: 0 → rejected; 2 / 3 with executed_at > 0 → executed, unless the
 * event_info carries a non-empty `ae` (app error) → rejected; 1, 2 / 3 not yet executed, a
 * missing status or an unknown code → pending (keep polling; never guessed final).
 */
export function lighterTxState(tx: unknown): LighterTxState {
  const t = (typeof tx === "object" && tx !== null ? tx : {}) as Record<string, unknown>;
  if (typeof t.status !== "number" || typeof t.hash !== "string") return { kind: "pending", status: null };
  const status = t.status;
  if (status === LIGHTER_TX_STATUS.FAILED) return { kind: "rejected", status, reason: "tx failed (status 0)" };
  if (status === LIGHTER_TX_STATUS.EXECUTED || status === LIGHTER_TX_STATUS.PENDING_FINAL) {
    if (!(Number(t.executed_at ?? 0) > 0)) return { kind: "pending", status };
    const eventInfo = lighterEventInfo(t.event_info);
    const ae = eventInfo?.ae;
    if (typeof ae === "string" && ae !== "") return { kind: "rejected", status, reason: ae };
    return { kind: "executed", status, eventInfo };
  }
  return { kind: "pending", status };
}

/** Order status names by code (event_info `st`; accountOrders `status` strings). */
export const LIGHTER_ORDER_STATUS_NAMES = [
  "in-progress", "pending", "open", "filled", "canceled", "canceled-post-only", "canceled-reduce-only",
  "canceled-position-not-allowed", "canceled-margin-not-allowed", "canceled-too-much-slippage",
  "canceled-not-enough-liquidity", "canceled-self-trade", "canceled-expired", "canceled-oco",
  "canceled-child", "canceled-liquidation", "canceled-invalid-balance",
] as const;

/** Final outcome of a placed (non-IOC) order, attached to the raw result as `orderOutcome`. */
export interface LighterOrderOutcome {
  /** open = resting (or an untriggered trigger order); cancelled with a fill → partiallyFilled. */
  status: "open" | "partiallyFilled" | "filled" | "cancelled";
  final: true;
  /** Venue status name, e.g. "open", "canceled-post-only". */
  venueStatus: string;
  /** Filled base size (decimal string). */
  filledSize: string;
  /** Venue order id (string; exact), when reported. */
  orderId: string | null;
  source: "event_info" | "accountOrders";
}

/**
 * Normalized outcome from a venue order status (code or name) and its filled size, or null
 * when not final (0 in-progress) / unknown. 1 pending = an untriggered trigger order (it
 * exists on the venue) → open.
 */
export function lighterOrderOutcomeOf(
  st: number | string, filledSize: string, orderId: string | null, source: LighterOrderOutcome["source"],
): LighterOrderOutcome | null {
  const name = typeof st === "number" ? LIGHTER_ORDER_STATUS_NAMES[st] : st;
  if (name === undefined || !(LIGHTER_ORDER_STATUS_NAMES as readonly string[]).includes(name)) return null;
  const filled = Number(filledSize) > 0;
  let status: LighterOrderOutcome["status"];
  if (name === "in-progress") return null;
  if (name === "pending" || name === "open") status = "open";
  else if (name === "filled") status = "filled";
  else status = filled ? "partiallyFilled" : "cancelled";
  return { status, final: true, venueStatus: name, filledSize, orderId, source };
}

/** event_info order status code 3 = "filled" (LIGHTER_ORDER_STATUS_NAMES[3]). */
const LIGHTER_ST_FILLED = 3;

/**
 * Filled base units of an event_info order object (`to` taker / `no` modified order), proven
 * ONLY when the venue status is 3 "filled" — the whole order (`is`) filled. Any other status →
 * null: event_info carries no filled field, and the venue zeroes `rs` when it cancels the
 * remainder (live testnet 2026-10-02: a crossing post-only came back canceled-post-only with
 * is 89 / rs 0 while accountOrders reported filled_base_amount "0.000"), so is − rs is never a
 * fill. Callers read accountOrders `filled_base_amount` instead (lighterRowOutcomeOf).
 */
export function lighterEventFilledBase(o: Record<string, unknown>): number | null {
  const is = Number(o.is);
  if (o.st !== LIGHTER_ST_FILLED || !Number.isSafeInteger(is) || is <= 0) return null;
  return is;
}

/**
 * Outcome of an accountOrders row from the venue's own fields: `status` and `filled_base_amount`
 * (a plain decimal string). A missing / malformed filled amount → null (never "0", never
 * size − remaining).
 */
export function lighterRowOutcomeOf(row: Record<string, unknown>, orderId: string | null): LighterOrderOutcome | null {
  const filled = row.filled_base_amount;
  if (typeof row.status !== "string" || typeof filled !== "string" || !/^\d+(\.\d+)?$/.test(filled)) return null;
  return lighterOrderOutcomeOf(row.status, filled, orderId, "accountOrders");
}

/**
 * Outcome of a modify (ModifyOrder, tx type 17) from its executed tx event_info: the new order
 * `no` ({ i order id, u client index, is size, rs remaining, p price ticks, st status }). Final
 * only when `no` is this order (i = orderId, or u = clientOrderIndex when i is not exact),
 * carries the price ticks / base amount sent AND its status is "filled" (filled = is,
 * lighterEventFilledBase). Any other status → null: the filled amount is read from accountOrders.
 */
export function lighterModifyOutcomeOf(
  eventInfo: Record<string, unknown> | null, orderId: string, clientOrderIndex: number | null,
  sent: { baseAmount: number; priceTicks: number }, sizeDecimals: number,
): LighterOrderOutcome | null {
  const no = eventInfo?.no;
  if (typeof no !== "object" || no === null) return null;
  const o = no as Record<string, unknown>;
  const is = Number(o.is);
  const id = lighterEventOrderId(o.i);
  const same = id !== null ? id === orderId
    : clientOrderIndex !== null && clientOrderIndex > 0 && Number(o.u) === clientOrderIndex;
  if (!same || Number(o.p) !== sent.priceTicks || is !== sent.baseAmount) return null;
  const filledBase = lighterEventFilledBase(o);
  if (filledBase === null) return null;
  return lighterOrderOutcomeOf(LIGHTER_ST_FILLED, unitsToString(BigInt(filledBase), lighterStep(sizeDecimals)), orderId, "event_info");
}

/**
 * The integer to sign a cancel / modify with, from the order's active-orders row: its client
 * order index when set (non-zero, ≤ 2^48 − 1); else (client index 0, e.g. a front-end order)
 * its order id — only when that decimal string is exactly representable as a JS number (the
 * signer takes a number). Otherwise throws INVALID_PARAMS: never a different order, never cancel-all.
 */
export function lighterOrderSignIndex(row: Record<string, unknown>, venue: string): number {
  const exact = (v: unknown): number | null => {
    const s = typeof v === "string" ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null;
    if (s === null || !/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && String(n) === s ? n : null;
  };
  const coi = exact(row.client_order_id) ?? exact(row.client_order_index);
  if (coi !== null && coi > 0) return coi;
  const id = typeof row.order_id === "string" ? row.order_id : row.order_index;
  const oid = exact(id);
  if (oid !== null && oid > 0) return oid;
  throw new PerpError("INVALID_PARAMS", `${venue} order ${String(id)} has no client order index and its order id is not exactly representable (max 2^53 − 1); nothing was sent`, {
    exchange: venue,
    remediation: "Cancel it from the venue UI, or cancel every order of the market: perp trade cancel <symbol>",
  });
}

/** Venue order id of an orders row as an exact string (order_id is a string on the wire; order_index a number). */
export function lighterOrderIdOf(row: Record<string, unknown>): string {
  if (typeof row.order_id === "string" && row.order_id !== "") return row.order_id;
  return row.order_index === undefined || row.order_index === null ? "" : String(row.order_index);
}

/**
 * Filled base amount (integer base units) from an executed tx's `event_info` taker order `to`,
 * proven only when the venue status is "filled" and its initial size equals what was sent
 * (lighterEventFilledBase) → the whole sent amount. Otherwise null (a cancelled remainder
 * zeroes `rs` — is − rs is never a fill): the caller reads the venue's filled amount
 * (accountOrders `filled_base_amount`) or measures it. Shared by the perp and spot IOC paths.
 */
export function lighterTakerFilledBase(eventInfo: unknown, sentBaseAmount: number): number | null {
  const parsed = lighterEventInfo(eventInfo);
  const to = parsed?.to;
  if (typeof to !== "object" || to === null) return null;
  const filled = lighterEventFilledBase(to as Record<string, unknown>);
  return filled !== null && filled === sentBaseAmount ? filled : null;
}

/**
 * A required open-order row field as a string (Rule #2): missing / empty / non-finite numeric →
 * EXCHANGE_ERROR, never listed as price / size "0" or status "open".
 */
export function lighterRowField(o: Record<string, unknown>, key: string, venue: string, what: "open order" | "order history" = "open order"): string {
  const v = o[key];
  if ((typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v))) return String(v);
  throw new PerpError("EXCHANGE_ERROR", `${venue} ${what} ${lighterOrderIdOf(o) || "(no id)"}: row has no ${key} (got ${JSON.stringify(v ?? null)})`, {
    exchange: venue, remediation: `Retry: perp -e ${venue} ${what === "open order" ? "account orders" : "account history"}`,
  });
}

/** What identifies OUR accountOrders row besides the client order index: the market sent to and the send time. */
export interface LighterRowMatch { marketIndex: number; sentAtMs: number }

/** Definite IOC outcome attached to a Lighter raw order result (`raw.iocOutcome`). */
export interface LighterIocOutcome {
  /** Filled base size (decimal string, venue size decimals). */
  filledSize: string;
  /** The IOC remainder is cancelled by the venue — this fill is final. */
  final: true;
  /** Filled / sent base amount in integer base units. */
  filledBase: number;
  sentBase: number;
  txHash: string;
  /**
   * /tx status of the executed tx: 2 (Executed) or 3 (Pending - Final State), with executed_at > 0;
   * null when /tx did not settle within the poll window and the accountOrders terminal row did.
   */
  txStatus: number | null;
  /** Where the fill was read: event_info (status "filled" → the whole order) or the accountOrders row's filled_base_amount. */
  source: "event_info" | "accountOrders";
}

/** Slippage protection actually sent with a Lighter order (`raw.protection`). */
export interface LighterProtection {
  /** Declared reference source (LIGHTER_REFERENCE_PRICE_SOURCE) or "triggerPrice" for trigger orders. */
  referenceSource: typeof LIGHTER_REFERENCE_PRICE_SOURCE | "triggerPrice";
  referencePrice: string;
  /** Tick-aligned toward crossing (buy → up, sell → down). */
  protectionPrice: string;
  slippageBps: number;
  slippageSource: ResolvedSlippage["source"];
  /** |protectionPrice / referencePrice − 1| in bps after tick alignment. */
  appliedBps: number;
}

/** `iocOutcomeOf` parser shared by LighterAdapter and LighterSpotAdapter. */
export function lighterIocOutcomeOf(raw: unknown): { filledSize: string; final: true } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = (raw as { iocOutcome?: unknown }).iocOutcome;
  if (typeof o !== "object" || o === null) return null;
  const { filledSize, final } = o as { filledSize?: unknown; final?: unknown };
  if (typeof filledSize !== "string" || final !== true) return null;
  return { filledSize, final: true };
}

/**
 * An explicit non-200 `code` in a /sendTx response: the venue validated the tx and refused it
 * before execution (e.g. "invalid ToAccount", "invalid nonce") — a definite rejection, nothing
 * executed. Orders (place / cancel / modify / trigger) → ORDER_REJECTED; account actions
 * (transfer / withdraw / leverage) → ACTION_REJECTED; a balance / margin refusal keeps its
 * specific (also definite) code so shortfall handling still applies. Transport failures /
 * unreadable bodies are NOT routed here (their outcome is unknown).
 */
export function lighterSendTxRejection(venue: string, json: { code?: unknown; message?: string }, kind: "order" | "action"): PerpError {
  const message = `${venue} sendTx rejected (code ${String(json.code)}): ${json.message ?? JSON.stringify(json)}`;
  const specific = classifyError(new Error(json.message ?? "")).code;
  const code = specific === "INSUFFICIENT_BALANCE" || specific === "MARGIN_INSUFFICIENT" ? specific
    : kind === "order" ? "ORDER_REJECTED" : "ACTION_REJECTED";
  return new PerpError(code, message, { exchange: venue, venueCode: json.code });
}

/**
 * A /sendTx `code` that says the venue VALIDATED the tx and refused it (nothing executed): the
 * documented validation / rate-limit ranges 20000–28999 (apidocs "Data Structures, Constants and
 * Errors": 21xxx account / collateral / tx / order-book / order / asset errors, 23xxx rate limits).
 * NOT definite: a missing / non-numeric code, 29xxx (29500 internal server error, 29501 process
 * timeout — the tx may still execute) and anything outside the documented ranges.
 */
export function lighterSendTxCodeIsDefinite(code: unknown): boolean {
  return typeof code === "number" && Number.isInteger(code) && code >= 20_000 && code <= 28_999;
}

/**
 * Verdict of a parsed /sendTx body: code 200 → returns; a documented validation code → definite
 * rejection (lighterSendTxRejection); any other / missing code → ORDER_PENDING (outcome unknown).
 */
export function lighterSendTxVerdict(venue: string, json: { code?: unknown; message?: string }, kind: "order" | "action", what: string): void {
  if (json.code === 200) return;
  if (lighterSendTxCodeIsDefinite(json.code)) throw lighterSendTxRejection(venue, json, kind);
  throw orderOutcomeUnknown(venue, what, new Error(`sendTx answered code ${JSON.stringify(json.code ?? null)}: ${json.message ?? JSON.stringify(json)}`),
    kind === "order" ? undefined : unknownActionRemediation(venue, "action"));
}

/** Per-request timeout of POST /sendTx (fetch + body read). */
export const LIGHTER_SEND_TIMEOUT_MS = 15_000;

/**
 * POST /sendTx (shared by the perp and spot adapters). Once the signed tx is on the wire only
 * the venue's own answer settles it: no connection → not sent; a connection reset / timeout /
 * HTTP 5xx / unreadable body → ORDER_PENDING; then lighterSendTxVerdict on the body.
 */
export async function lighterPostSendTx(
  baseUrl: string, signed: { txType: number; txInfo: string }, venue: string, kind: "order" | "action", what: string,
): Promise<{ code: number; message?: string; tx_hash?: string }> {
  const remediation = kind === "order" ? undefined : unknownActionRemediation(venue, "action");
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}/api/v1/sendTx`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx_type: String(signed.txType), tx_info: signed.txInfo }),
      // A timeout after the send is a TimeoutError → sendFailure → ORDER_PENDING (never resubmit).
      signal: AbortSignal.timeout(LIGHTER_SEND_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    throw sendFailure(venue, what, e, remediation);
  }
  // A WAF challenge is the firewall's own response: the tx never reached the API. AWS WAF docs
  // ("CAPTCHA and Challenge action behavior"): for a missing / invalid token it "blocks it from
  // going to its intended destination" and answers "The HTTP status code `405 Method Not
  // Allowed`". So this is a definite "not sent" — unlike an unreadable 2xx / 5xx body below.
  const waf = lighterWafChallenge(venue, res.status, text);
  if (waf !== null) throw orderNotSent(venue, what, waf);
  if (res.status >= 500) {
    throw orderOutcomeUnknown(venue, what, new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), remediation);
  }
  let json: { code?: unknown; message?: string; tx_hash?: string };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw orderOutcomeUnknown(venue, what, new Error(`unreadable response (HTTP ${res.status}): ${text.slice(0, 200)}`), remediation);
  }
  if (json === null || typeof json !== "object") {
    throw orderOutcomeUnknown(venue, what, new Error(`unreadable response (HTTP ${res.status}): ${text.slice(0, 200)}`), remediation);
  }
  lighterSendTxVerdict(venue, json, kind, what);
  return json as { code: number; message?: string; tx_hash?: string };
}

/** created_at / timestamp of an orders row in ms (the venue reports seconds; ms / µs are normalized), or null. */
export function lighterRowCreatedMs(row: Record<string, unknown>): number | null {
  const v = Number(row.created_at ?? row.timestamp);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v < 1e11 ? v * 1000 : v < 1e14 ? v : Math.floor(v / 1000);
}

/**
 * Configured leverage and margin mode of an account `positions[]` entry (GET /api/v1/account).
 * Docs (apidocs.lighter.xyz/reference/account-1, PositionDetails): `initial_margin_fraction`
 * "type": "string", example "20.00"; `margin_mode` "type": "integer", example 1. The fraction
 * is a PERCENT on this read (live 2026-10-05: "5.00" on a 20x market, "6.66" after a 15x
 * update) — the same value updateLeverage signs in basis points (`int(10_000 / leverage)`), so
 * leverage = floor(10000 / bps), which returns the integer leverage that was set. margin_mode:
 * 0 cross, 1 isolated (the values updateLeverage signs). Anything else throws — never a guess.
 */
export function lighterPositionSettings(p: Record<string, unknown>, venue: string): { leverage: number; marginMode: "cross" | "isolated" } {
  const pct = typeof p.initial_margin_fraction === "string" && /^\d+(\.\d+)?$/.test(p.initial_margin_fraction) ? Number(p.initial_margin_fraction) : NaN;
  const bps = Math.round(pct * 100);
  if (!(bps > 0) || bps > 10_000) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} position ${String(p.symbol)}: unreadable initial_margin_fraction ${JSON.stringify(p.initial_margin_fraction)} — configured leverage unknown`, { exchange: venue });
  }
  if (p.margin_mode !== 0 && p.margin_mode !== 1) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} position ${String(p.symbol)}: margin_mode is ${JSON.stringify(p.margin_mode)} (expected 0 cross | 1 isolated)`, { exchange: venue });
  }
  return { leverage: Math.floor(10_000 / bps), marginMode: p.margin_mode === 1 ? "isolated" : "cross" };
}

/** Clock-skew allowance when requiring an order row to be created after the send (client vs venue clock). */
export const LIGHTER_ROW_SKEW_MS = 120_000;

/**
 * The account to use from a `/account?by=l1_address` listing. A known account index → that
 * account or null (never another one). Unknown index: the only account; with several, the single
 * main account (account_type 0); otherwise INVALID_PARAMS — never "the first one".
 */
export function lighterSelectAccount(accounts: Array<Record<string, unknown>> | undefined, accountIndex: number, venue: string): Record<string, unknown> | null {
  const list = Array.isArray(accounts) ? accounts : [];
  if (accountIndex >= 0) return list.find(a => a.account_index === accountIndex || a.index === accountIndex) ?? null;
  if (list.length <= 1) return list[0] ?? null;
  const mains = list.filter(a => a.account_type === 0);
  if (mains.length === 1) return mains[0];
  throw new PerpError("INVALID_PARAMS", `${venue}: the wallet has ${list.length} accounts (${list.map(a => String(a.account_index)).join(", ")}) and none is uniquely the main account; refusing to pick one`, {
    exchange: venue, remediation: `Register an agent for the account you want: perp wallet agent approve ${venue}`,
  });
}

/**
 * On-disk lifetime of the perp market list (symbol → market id, size / price decimals) read from
 * `GET /api/v1/orderBooks`, shared by every CLI process of the same venue + network (cache.ts).
 * Public static metadata only — account state, orders, positions, balances and nonces are never
 * cached here. It keeps the list off the per-invocation request budget (apidocs.lighter.xyz
 * rate-limits: "Standard Accounts: 60 requests per rolling minute"). A market listed inside this
 * window is unknown (SYMBOL_NOT_FOUND) until the entry expires.
 */
export const LIGHTER_MARKET_LIST_TTL_MS = 5 * 60_000;

export interface LighterAdapterOpts {
  apiKey?: string;
  accountIndex?: number;
  apiKeyIndex?: number;
}

/** A candle volume field: a finite number / numeric string → its string form; absent or non-numeric → null (never "" / "undefined"). */
function candleNumber(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return v;
  return null;
}

export class LighterAdapter implements ExchangeAdapter {
  /** GTC→GTT resting-order lifetime (28 days) for the execution record. */
  static readonly gttExpiryMs = LIGHTER_GTT_EXPIRY_MS;
  /** Venue id ("lighter" | "lighter-rh"). */
  readonly name: LighterVenueId;
  readonly venueId: LighterVenueId;
  readonly family = "lighter" as const;
  /** Settlement chain of the venue network ("ethereum" for Lighter, "robinhood" for Lighter RH). */
  readonly chain: string;
  readonly aliases: readonly string[];
  readonly networkName: Network;
  private readonly _network: VenueNetworkConfig;
  private _signer!: LighterWasmSigner;
  private _accountIndex = -1;
  /**
   * Account trading mode (`account_trading_mode`: Classic=0, Unified=1 — lighter-python
   * models/account.py; docs.lighter.xyz "Unified Trading Accounts"). Unified: spot and perp
   * share the USDC margin, so there is no spot↔perp transfer. Read by
   * resolveAccountTradingMode() (LighterSpotAdapter.init); null = not read yet.
   */
  private _tradingMode: { unified: boolean } | { error: string } | null = null;
  private _apiKeyIndex: number;
  private _address: string;
  private _marketMap = new Map<string, number>(); // symbol → marketIndex
  private _marketDecimals = new Map<string, { size: number; price: number }>(); // symbol → decimals
  private _evmKey: string;
  private _apiKey: string;
  private _accountIndexInit: number;
  private _baseUrl: string;
  private _chainId: number;
  private _testnet: boolean;
  private _readOnly: boolean;
  private _evmSigner?: EvmSigner;
  private _marketsCache: ExchangeMarketInfo[] | null = null;
  private _marketsCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;

  // ── 3-tier signer state (Phase 2d) ──
  /** Tier 1 metadata (Phase 2d). When set + not expired + !_useNoAgent, agent
   *  apiKeyIndex/publicKey/accountIndex take priority over master/PK env. */
  private _agentMeta?: AgentMeta;
  /** Tier 1 secp256k1 hex private key (40 bytes) for the agent slot. Lighter
   *  has no OWS curve binding for raw L2 keys; this is held in-memory only when
   *  passed by the caller (e.g. immediately after `setupApiKey()` or via env). */
  private _agentApiKey?: string;
  /** --no-agent bypass flag. */
  private _useNoAgent = false;

  /**
   * Legacy constructor: this signature DEFINES the Lighter (main) venue — it is
   * not a default for other venues. Lighter RH (and any explicit venue) is
   * built with `LighterAdapter.forVenue()`, which passes `venue`.
   *
   * @param evmKey    EVM private key (0x-prefixed, 32 bytes) — for deposits & key registration
   * @param testnet   Use the venue testnet instead of mainnet
   * @param opts      Optional: apiKey (40-byte Lighter signing key), accountIndex, apiKeyIndex
   * @param venue     @internal — set only by `forVenue()`; absent means the Lighter venue by definition
   */
  constructor(evmKey: string, testnet = false, opts?: LighterAdapterOpts, venue?: LighterVenueId) {
    const venueId: LighterVenueId = venue === undefined ? "lighter" : venue;
    this.name = venueId;
    this.venueId = venueId;
    this.networkName = testnet ? "testnet" : "mainnet";
    this._network = lighterFamilyNetworks(venueId)[this.networkName];
    this.chain = this._network.settlementChain;
    // Adapter-level short aliases (legacy surface). Venue aliases live in the venue definition.
    this.aliases = venueId === "lighter" ? ["lt"] : [];
    if (opts?.apiKeyIndex !== undefined) LighterAdapter._assertKeyIndexAllowed(venueId, opts.apiKeyIndex);
    this._evmKey = evmKey;
    // SSOT Rule #3: L2 API key is never read from env. Caller injects it via
    // opts.apiKey or setAgentSigner (Tier 1 agent path). init() never registers a
    // key implicitly — without one the adapter stays read-only; slot keys are
    // registered only by `perp wallet agent approve <venue>`.
    this._apiKey = opts?.apiKey ?? "";
    this._accountIndexInit = opts?.accountIndex ?? -1;
    this._apiKeyIndex = opts?.apiKeyIndex ?? 4;
    this._address = "";
    this._testnet = testnet;
    this._readOnly = !this._apiKey;
    // LIGHTER_TESTNET_URL is a pre-existing operator override for the Lighter
    // (main) testnet host only; it is kept to preserve that behavior and does
    // not apply to Lighter RH.
    const envTestnetUrl = process.env.LIGHTER_TESTNET_URL;
    this._baseUrl = venueId === "lighter" && testnet && envTestnetUrl
      ? envTestnetUrl
      : this._network.restUrl;
    if (this._network.signingChainId === null) {
      throw new PerpError("INVALID_PARAMS", `${venueId} ${this.networkName} has no signing chain id`);
    }
    this._chainId = this._network.signingChainId;
  }

  /** Construct an adapter for an explicit Lighter-family venue. */
  static forVenue(venue: LighterVenueId, evmKey: string, testnet: boolean, opts?: LighterAdapterOpts): LighterAdapter {
    return new LighterAdapter(evmKey, testnet, opts, venue);
  }

  /** Network config of this adapter's venue + network (SSOT: venues/lighter-family.ts). */
  get network(): VenueNetworkConfig {
    return this._network;
  }

  /** Collateral symbol of this venue on its network ("USDC" on Lighter, "USDG" on Lighter RH mainnet, "USDC" on RH testnet). */
  get collateralSymbol(): string {
    const sym = this._network.collateral[0];
    if (!sym) throw new PerpError("INVALID_PARAMS", `${this.venueId} network config has no collateral`);
    return sym;
  }

  /** Lighter asset index of the collateral (3 on both venues). */
  get collateralAssetIndex(): number {
    const idx = this._network.collateralAssetIndex;
    if (idx === null) throw new PerpError("INVALID_PARAMS", `${this.venueId} network config has no collateral asset index`);
    return idx;
  }

  /**
   * Cache key prefix for account reads shared with LighterSpotAdapter.
   * "lt" is the historical Lighter prefix (kept so existing cache keys are unchanged);
   * other venues use their venue id so accounts never collide across venues.
   */
  get accountCachePrefix(): string {
    // Network is part of the key: the same L1 address has a mainnet and a testnet account.
    return `${this.venueId === "lighter" ? "lt" : this.venueId}:${this.networkName}`;
  }

  /** Lighter RH reserves API key indexes {0,1,2,3,157} for its own interfaces. */
  private static _assertKeyIndexAllowed(venue: LighterVenueId, apiKeyIndex: number): void {
    if (venue === "lighter-rh" && LIGHTER_RH_RESERVED_KEY_INDEXES.includes(apiKeyIndex)) {
      throw new PerpError("INVALID_PARAMS", `Lighter RH API key index ${apiKeyIndex} is reserved (reserved: ${LIGHTER_RH_RESERVED_KEY_INDEXES.join(", ")})`, {
        remediation: "Use an API key index in 4–254 other than 157 (e.g. 4).",
      });
    }
  }

  get signer(): Omit<LighterWasmSigner, "createAuthToken"> & { createAuthToken(deadline: number): Promise<{ authToken: string }> } {
    const self = this;
    // Compatibility wrapper: ws-feeds.ts expects createAuthToken(deadline) → { authToken }
    return Object.create(this._signer, {
      createAuthToken: {
        value: async (deadline: number) => {
          const token = self._signer.createAuthToken(deadline, self._apiKeyIndex, self._accountIndex);
          return { authToken: token };
        },
      },
    });
  }

  get accountIndex(): number {
    return this._accountIndex;
  }

  get address(): string {
    return this._address;
  }

  /** @internal — evmKey is intentionally not exposed publicly for security */

  get isReadOnly(): boolean {
    return this._readOnly;
  }

  /**
   * Sign an unsigned L1 transaction with the master wallet (on-chain deposit txs); the
   * digest is derived from the tx inside the signer. Only an OWS master signer can sign
   * L1 txs; anything else → NO_SIGNER_AVAILABLE.
   */
  async signL1Transaction(tx: import("ethers").Transaction): Promise<string> {
    const { OwsEvmSigner } = await import("../signer/ows-evm.js");
    if (!(this._evmSigner instanceof OwsEvmSigner)) {
      throw new PerpError("NO_SIGNER_AVAILABLE", `${this.venueId} on-chain deposit needs the OWS master wallet (no master signer loaded)`, {
        remediation: `Run with the master wallet: perp -e ${this.venueId} --ows <wallet> ...`,
      });
    }
    return this._evmSigner.signTransaction(tx);
  }

  /** Inject an external EVM signer. Call before init() to skip LocalEvmSigner creation. */
  setSigner(signer: EvmSigner): void {
    this._evmSigner = signer;
    this._address = signer.getAddress();
    // Reset any caller-supplied accountIndex hint: when the agent flow injects
    // an OWS signer that differs from the constructor-time master, force a
    // fresh /api/v1/account lookup keyed on the injected signer. Without this
    // reset, a stale account index would route ChangePubKey to the wrong
    // account (Lighter rejects the L1 sig with code=21504 "fail to l1 signature").
    this._accountIndexInit = -1;
    this._accountIndex = -1;
  }

  /**
   * Set the account owner's L1 address without attaching a signer — for an agent whose master
   * wallet is not on this machine (API key imported from the website). Account reads are keyed
   * by this address; nothing L1 can be signed (signL1Transaction / setupApiKey still refuse).
   */
  setAddress(address: string): void {
    this._address = address;
  }

  /**
   * Prove the loaded agent API key is the one registered at its slot: sign an auth token with it
   * and make one authenticated read (`GET /api/v1/accountActiveOrders`). Lighter validates the
   * token against the public key registered at (account_index, api_key_index), so a key that does
   * not match the slot is refused. Read-only — nothing is sent. Throws on any refusal.
   */
  async assertAgentKeyAccepted(): Promise<void> {
    this.ensureSigner();
    const marketId = this._marketMap.values().next().value;
    if (marketId === undefined) throw new Error(`${this.name}: no markets loaded — cannot run the authenticated check`);
    const res = await this.restGetAuth("/accountActiveOrders", {
      account_index: String(this._accountIndex),
      market_id: String(marketId),
    }) as { code?: unknown; message?: unknown };
    if (res && typeof res.code === "number" && res.code !== 200) {
      throw new Error(`${this.name} refused the API key's auth token (code ${res.code}: ${String(res.message ?? "")})`);
    }
  }

  /**
   * Tier 1: inject a Lighter agent's slot+L2 key (Phase 2d).
   *
   * Caller supplies the AgentMeta (settings.agents.lighter[name]) plus the
   * 40-byte L2 private key (hex). Adapter swaps `_apiKey`/`_apiKeyIndex` to
   * the agent's slot/key so all subsequent `signCreateOrder`/`signCancelOrder`
   * etc. flow through the agent identity.
   *
   * NOTE: when the agent path is active, `_address` (master EVM) is left
   * unchanged because Lighter REST queries (account, balance, positions) use
   * `account_index` not address. The L1 EVM identity is irrelevant for the
   * hot-path; only the L2 secp256k1 key is consulted.
   */
  setAgentSigner(meta: AgentMeta, agentApiKey: string): void {
    if (typeof meta.apiKeyIndex === "number") LighterAdapter._assertKeyIndexAllowed(this.venueId, meta.apiKeyIndex);
    this._agentMeta = meta;
    this._agentApiKey = agentApiKey;
    // Reset any prior accountIndex hint: the agent may belong to a different
    // Lighter account than the master signer, so any stale value must not
    // override the AgentMeta-derived accountIndex applied in init().
    this._accountIndexInit = -1;
    this._accountIndex = -1;
    // Active slot+key swap happens lazily in `_resolveSigner()`/init flows.
  }

  /** Bypass Tier 1 (agent) — used for `--no-agent` flag. */
  setNoAgent(noAgent: boolean): void {
    this._useNoAgent = noAgent;
  }

  /** Which signer tier is currently active (for debug/diagnostics). */
  get activeSignerTier(): "agent" | "master" | "pk" | null {
    try {
      return this._resolveSigner().tier;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the active signer tier across three tiers (Phase 2d).
   *
   * Tier 1 (agent): active when AgentMeta + agent L2 key set, not expired,
   *   and `--no-agent` NOT set. The actual swap of `_apiKeyIndex`/`_apiKey`
   *   happens in `init()` (or via `_activateAgentTier()` post-init).
   * Tier 2 (master): active when an OWS master EVM signer was injected via
   *   `setSigner()`. Used for the L1 ChangePubKey path (auto-setup at slot 4).
   * Tier 3 (pk): active when constructor was supplied an evmKey. Same role
   *   as Tier 2 — signs L1 ChangePubKey for auto-setup.
   *
   * Lighter is unique among the venues in that the actual order-signing is
   * always done by the L2 secp256k1 key (`_apiKey`), regardless of tier. The
   * tiers differ in WHICH L2 key is loaded: Tier 1 uses the agent's slot/key
   * from AgentMeta; Tier 2/3 use whatever the env/auto-setup produced.
   */
  private _resolveSigner(): { tier: "agent" | "master" | "pk" } {
    if (!this._useNoAgent && this._agentMeta && this._agentApiKey) {
      // An expired agent record is an explicit error — never a silent switch to the master
      // signer (as on Hyperliquid / Pacifica); --no-agent is the opt-in.
      if (isExpired(this._agentMeta)) throw this.agentExpired(this._agentMeta);
      return { tier: "agent" };
    }
    if (this._evmSigner) return { tier: "master" };
    if (this._evmKey) return { tier: "pk" };
    // Lighter RH master key is OWS-only: no env-key remediation for it.
    const remediation = this.venueId === "lighter"
      ? "Run one of: (a) perp wallet agent approve lighter --master <wallet>; (b) perp wallet generate && perp -e lighter --ows <wallet>; (c) export LIGHTER_PRIVATE_KEY=0x..."
      : `Run one of: (a) perp wallet agent approve ${this.name} --master <wallet>; (b) perp wallet generate && perp -e ${this.name} --ows <wallet>`;
    throw new PerpError("NO_SIGNER_AVAILABLE", `No signing path configured for ${this.venueId === "lighter" ? "Lighter" : "Lighter RH"}`, { remediation });
  }

  private agentExpired(meta: AgentMeta): PerpError {
    return new PerpError("AGENT_EXPIRED", `${this.name} agent API key (slot ${String(meta.apiKeyIndex)}) expired at ${meta.expiresAt}`, {
      exchange: this.name,
      remediation: `Re-approve the agent: perp wallet agent approve ${this.name} --rotate — or run this command without the agent: --no-agent`,
    });
  }

  /**
   * true = Unified Trading Account (spot shares perp margin), false = Classic. Throws when the
   * mode was not read or the read failed — never assumes either mode (SSOT Rule #2).
   */
  get isUnifiedAccount(): boolean {
    const m = this._tradingMode;
    if (m !== null && "unified" in m) return m.unified;
    throw new PerpError("EXCHANGE_ERROR", `${this.name} account trading mode unknown: ${m === null ? "not read" : m.error}`, {
      exchange: this.name,
      remediation: `Retry; check the account with: perp -e ${this.name} account info`,
    });
  }

  /**
   * Read `account_trading_mode` from the account (shared `acct:` cache). A failed or invalid
   * read is kept and re-thrown by isUnifiedAccount, so callers that depend on the mode fail
   * while public spot reads (markets, books) keep working.
   */
  async resolveAccountTradingMode(): Promise<void> {
    if (!this._address) {
      this._tradingMode = { error: "no account address configured" };
      return;
    }
    try {
      const acct = await this.fetchAccount();
      if (acct === null) throw new Error(`no account found for ${this._address}`);
      const mode = acct.account_trading_mode;
      if (mode !== 0 && mode !== 1) throw new Error(`account_trading_mode is ${JSON.stringify(mode)} (expected 0 classic | 1 unified)`);
      this._tradingMode = { unified: mode === 1 };
    } catch (e) {
      this._tradingMode = { error: extractErrorMessage(e) };
    }
  }

  async init(): Promise<void> {
    // Phase 2d: when an agent is registered (Tier 1), swap _apiKey/_apiKeyIndex
    // to the agent's slot/key BEFORE any of the existing init logic runs. This
    // ensures the WASM client below is created with the agent's credentials.
    // The agent L2 key is loaded from the encrypted keystore by the caller and
    // injected via setAgentSigner() — never read from env (SSOT Rule #3).
    if (!this._useNoAgent && this._agentMeta && this._agentApiKey && !isExpired(this._agentMeta)) {
      this._apiKey = this._agentApiKey;
      if (typeof this._agentMeta.apiKeyIndex === "number") {
        this._apiKeyIndex = this._agentMeta.apiKeyIndex;
      }
      if (typeof this._agentMeta.accountIndex === "number") {
        this._accountIndex = this._agentMeta.accountIndex;
        this._accountIndexInit = this._agentMeta.accountIndex;
      }
    }

    // Initialize EVM signer if not externally injected (skip if no key — read-only mode)
    if (!this._evmSigner && this._evmKey) {
      this._evmSigner = await LocalEvmSigner.create(this._evmKey);
      this._address = this._evmSigner.getAddress();
    } else if (this._evmSigner && !this._address) {
      this._address = this._evmSigner.getAddress();
    }

    // Fetch account index from REST API (skip if no address — read-only mode)
    if (!this._address) {
      await this._refreshMarketMap();
      return;
    }
    // If accountIndex is already known (from env/opts/agent meta), skip API lookup entirely
    if (this._accountIndexInit >= 0) {
      this._accountIndex = this._accountIndexInit;
    } else {
      // One live read. A wallet without an account answers HTTP 400 {"code":21100,"message":"account
      // not found"} (no `accounts`) → the adapter stays read-only; a rate limit or transport
      // failure propagates (it is never read as "no account").
      await this.rhRate("/account");
      const res = await fetch(`${this._baseUrl}/api/v1/account?by=l1_address&value=${this._address}`);
      const body = await res.text();
      if (res.status === 429) throw rateLimitedError(this.name, res.headers.get("retry-after"), body);
      const waf = lighterWafChallenge(this.name, res.status, body);
      if (waf !== null) throw waf;
      const json = JSON.parse(body) as { accounts?: Array<Record<string, unknown>> };
      let picked: Record<string, unknown> | null = null;
      try {
        picked = lighterSelectAccount(json.accounts, -1, this.name);
      } catch (e) {
        // Several accounts and no unique main one: stay read-only (never the first one).
        console.error(`[lighter] ${e instanceof Error ? e.message : String(e)}`);
      }
      if (picked !== null && typeof picked.account_index === "number") {
        this._accountIndex = picked.account_index;
        // The command's own account read (balance / positions) reuses this response.
        setCached(this.accountCacheKey, picked, TTL_ACCOUNT);
      }
    }

    // No implicit key registration (both Lighter-family venues): adapter creation also
    // backs read-only paths (portfolio, risk, balances), which must never sign. A
    // master-key init without an API key stays read-only; trading needs an explicit
    // `perp wallet agent approve <venue>` (which registers + persists the slot key).
    // Initialize signer for trading if we have an API key (reuse singleton WASM client)
    if (this._apiKey) {
      // Clean & validate API key before passing to WASM (Go hex decoder gives cryptic errors on non-hex)
      let cleanKey = this._apiKey.trim().replace(/['"` \t\n\r.]/g, "");
      if (cleanKey.startsWith("0x")) cleanKey = cleanKey.slice(2);
      if (cleanKey.length > 0 && !/^[0-9a-fA-F]+$/.test(cleanKey)) {
        console.error(`[lighter] API key contains invalid chars (expected hex). Run 'perp wallet agent approve ${this.name}' to register an agent.`);
        this._apiKey = "";
      } else if (cleanKey.length === 0) {
        this._apiKey = "";
      } else if (this._accountIndex < 0) {
        // Account lookup failed or returned no accounts — cannot initialize WASM signer
        console.error(`[lighter] Account index not available (got ${this._accountIndex}). Trading will be read-only. Ensure the wallet has a Lighter account, or run 'perp wallet agent approve ${this.name}' to register an agent.`);
        this._apiKey = "";
      } else {
        this._apiKey = cleanKey;
        const client = await this._getWasmClient();
        client.createClient({
          privateKey: this._apiKey,
          chainId: this._chainId,
          apiKeyIndex: this._apiKeyIndex,
          accountIndex: this._accountIndex,
        });
        this._signer = client;
      }
    }
    this._readOnly = !this._apiKey;

    // Build symbol → marketIndex map + decimals from orderBookDetails
    await this._refreshMarketMap();
  }

  /**
   * Populate the perp market map + decimals: ONE `GET /api/v1/orderBooks` (it carries
   * supported_size_decimals / supported_price_decimals for every market), served from the on-disk
   * market-list cache while fresh (LIGHTER_MARKET_LIST_TTL_MS). A failed read (429, transport,
   * no / empty list) throws the real error — never an empty map, which every later symbol lookup
   * would report as SYMBOL_NOT_FOUND. No second endpoint and no retry: each costs a request of
   * the 60 / minute budget.
   */
  private async _refreshMarketMap(): Promise<void> {
    const perps = await withCache(`mkt:${this.venueId}:${this.networkName}:orderBooks`, LIGHTER_MARKET_LIST_TTL_MS, async () => {
      const res = await this.restGet("/orderBooks", {}) as { order_books?: unknown };
      if (!Array.isArray(res.order_books) || res.order_books.length === 0) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} orderBooks returned no order_books list — the market list is unknown`, {
          exchange: this.name, remediation: `Retry; check the venue status: perp -e ${this.name} market list`,
        });
      }
      const rows: Array<{ symbol: string; marketId: number; size: number; price: number }> = [];
      for (const d of res.order_books as Array<Record<string, unknown>>) {
        // Perps only, by the venue's own market_type (spot markets are handled by
        // lighter-spot.ts). Market ids are not a type: testnet perps are 4095–4097 and
        // Lighter RH testnet perps 2048/2049.
        if (d.market_type !== "perp") continue;
        if (typeof d.symbol !== "string" || !Number.isInteger(d.market_id) || !Number.isInteger(d.supported_size_decimals) || !Number.isInteger(d.supported_price_decimals)) {
          throw new PerpError("EXCHANGE_ERROR", `${this.name} orderBooks: perp market row without symbol / market_id / decimals: ${JSON.stringify(d).slice(0, 160)}`, { exchange: this.name });
        }
        rows.push({ symbol: d.symbol.toUpperCase(), marketId: d.market_id as number, size: d.supported_size_decimals as number, price: d.supported_price_decimals as number });
      }
      return rows;
    });
    for (const m of perps) {
      this._marketMap.set(m.symbol, m.marketId);
      this._marketDecimals.set(m.symbol, { size: m.size, price: m.price });
    }
  }

  getMarketIndex(symbol: string): number {
    const idx = this._marketMap.get(symbol.toUpperCase());
    if (idx === undefined) throw new PerpError("SYMBOL_NOT_FOUND", `Unknown Lighter market: ${symbol}`, { exchange: this.name, remediation: `List markets: perp -e ${this.name} market list` });
    return idx;
  }

  /**
   * Lot step of a perp market from the loaded market list (size decimals of /orderBooks) —
   * precision.lotStepOf uses it instead of a full getMarkets() read (/orderBookDetails +
   * /funding-rates, two requests an order placement does not need).
   */
  lotStepOf(symbol: string): string {
    this.getMarketIndex(symbol);
    const dec = this._marketDecimals.get(symbol.toUpperCase());
    if (!dec) throw new PerpError("EXCHANGE_ERROR", `${this.name} ${symbol}: no size decimals loaded — lot step unknown`, { exchange: this.name });
    return lighterStep(dec.size);
  }

  /** Ensure market map is populated; lazy-refresh if empty */
  private async ensureMarketMap(): Promise<void> {
    if (this._marketMap.size === 0) {
      await this._refreshMarketMap();
    }
  }

  /**
   * Reference price for slippage-bounded orders — the ONE declared source
   * (LIGHTER_REFERENCE_PRICE_SOURCE): mid of best bid / best ask from
   * `/orderBookOrders`. A missing side or unreadable book → PRICE_STALE (no substitute).
   */
  private async getReferencePrice(symbol: string): Promise<number> {
    const marketId = this.getMarketIndex(symbol);
    let res: { asks?: Array<{ price?: unknown }>; bids?: Array<{ price?: unknown }> };
    try {
      res = await this.restGet("/orderBookOrders", { market_id: String(marketId), limit: "20" }) as typeof res;
    } catch (e) {
      throw new PerpError("PRICE_STALE", `Cannot read ${this.name} orderbook for ${symbol} reference price: ${e instanceof Error ? e.message : String(e)}`, { exchange: this.name });
    }
    const prices = (rows: Array<{ price?: unknown }> | undefined) =>
      (rows ?? []).map(r => Number(r.price)).filter(p => Number.isFinite(p) && p > 0);
    const bids = prices(res.bids);
    const asks = prices(res.asks);
    if (bids.length === 0 || asks.length === 0) {
      throw new PerpError("PRICE_STALE", `${this.name} ${symbol} orderbook has no ${bids.length === 0 ? "bids" : "asks"} — no reference price (orderbook mid)`, { exchange: this.name });
    }
    return (Math.max(...bids) + Math.min(...asks)) / 2;
  }

  /**
   * Protection price = reference ± slippage bps, aligned to the price tick toward
   * crossing (buy → up, sell → down; precision.alignProtectionPrice), as signer ticks.
   */
  private protectionFor(
    symbol: string, side: "buy" | "sell", reference: number, slippage: ResolvedSlippage,
    referenceSource: LighterProtection["referenceSource"],
  ): { priceTicks: number; protection: LighterProtection } {
    const dec = this._marketDecimals.get(symbol.toUpperCase());
    if (!dec) {
      throw new PerpError("ORDER_REJECTED", `No market decimals loaded for ${symbol}. Market data may not be initialized.`, { exchange: this.name });
    }
    const tick = lighterStep(dec.price);
    const protectionPrice = alignProtectionPrice(slippagePrice(String(reference), side, slippage.bps), tick, side);
    const priceTicks = Number(toUnitsExact(protectionPrice, tick, "protection price"));
    const appliedBps = Math.round(Math.abs(Number(protectionPrice) / reference - 1) * 10_000 * 100) / 100;
    return {
      priceTicks,
      protection: {
        referenceSource, referencePrice: String(reference), protectionPrice,
        slippageBps: slippage.bps, slippageSource: slippage.source, appliedBps,
      },
    };
  }

  /** Validated caller client order index, or a generated one. */
  private clientOrderIndexFor(given: number | undefined): number {
    if (given === undefined) return this.nextClientOrderIndex();
    return lighterClientOrderIndex(String(given));
  }

  /**
   * /tx poll attempts (500 ms apart). Testnet sequencing is slower, so its window is 3× longer.
   * Public: LighterSpotAdapter polls with the same window.
   */
  txPollAttempts(base: number): number {
    return this._testnet ? base * 3 : base;
  }

  /**
   * Poll /tx by hash until the tx is executed or rejected (lighterTxState), or the poll
   * window ends → `{ kind: "pending" }`. A tx not indexed yet (HTTP 400 "transaction not
   * found") or a transient read failure polls again.
   */
  private async pollTx(txHash: string, attempts: number): Promise<LighterTxState> {
    let last: LighterTxState = { kind: "pending", status: null };
    for (let attempt = 0; attempt < attempts; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      let tx: unknown;
      try {
        tx = await this.restGet("/tx", { by: "hash", value: txHash });
      } catch (e) {
        if (e instanceof PerpError && e.structured.code === "RATE_LIMITED") {
          // HTTP 429: polling on every 500 ms would only extend the breach. Honour Retry-After
          // when it fits in the remaining window, else stop — the caller reports the tx pending.
          const retryAfterMs = e.structured.details?.retryAfterMs;
          const remainingMs = (attempts - attempt - 1) * 500;
          if (typeof retryAfterMs === "number" && retryAfterMs > 0 && retryAfterMs <= remainingMs) {
            await new Promise(r => setTimeout(r, retryAfterMs));
            attempt += Math.ceil(retryAfterMs / 500);
            continue;
          }
          console.error(`[${this.name}] Warning: /tx poll of ${txHash} rate limited (HTTP 429${typeof retryAfterMs === "number" ? `, Retry-After ${retryAfterMs} ms` : ""}) — polling stopped, outcome not confirmed`);
          return last;
        }
        continue;
      }
      last = lighterTxState(tx);
      if (last.kind !== "pending") return last;
    }
    return last;
  }

  /**
   * Definite IOC outcome from the executed tx: poll /tx by hash. A taker order the
   * venue reports "filled" (event_info `to.st` 3, `is` = sent) filled the whole order. Any other
   * status (the remainder was cancelled — the venue zeroes `rs`, so is − rs is NOT a fill) →
   * the venue's own `filled_base_amount` from accountOrders by client order index. Zero fill →
   * ORDER_REJECTED; positive fill → the raw result carrying `iocOutcome` (final). Executed =
   * status 2 / 3 with executed_at > 0 (lighterTxState); 1 Pending keeps polling. Status 0 or a
   * non-empty event_info `ae` → ORDER_REJECTED. /tx not settled within the poll window → the
   * accountOrders terminal row still settles it. No terminal row either → raw result without
   * `iocOutcome` (outcome unknown; iocOutcomeOf() returns null).
   */
  private async awaitIocOutcome(sendResult: unknown, symbol: string, sentBase: number, what: string, extra: Record<string, unknown> & { clientOrderIndex: number }, match: LighterRowMatch): Promise<unknown> {
    const base: Record<string, unknown> = { ...(sendResult as Record<string, unknown>), ...extra };
    const txHash = (sendResult as { tx_hash?: unknown }).tx_hash;
    if (typeof txHash !== "string" || txHash === "") return base;
    const dec = this._marketDecimals.get(symbol.toUpperCase());
    const state = await this.pollTx(txHash, this.txPollAttempts(10));
    if (state.kind === "rejected") {
      throw new PerpError("ORDER_REJECTED", `${this.name} ${what}: tx rejected (status=${state.status}, ${state.reason}, hash=${txHash})`, { exchange: this.name, txHash, ...extra });
    }
    if (dec) {
      const step = lighterStep(dec.size);
      let filledBase = state.kind === "executed" ? lighterTakerFilledBase(state.eventInfo, sentBase) : null;
      let source: LighterIocOutcome["source"] = "event_info";
      if (filledBase === null) {
        // IOC: only a terminal row settles it. The venue's own terminal row (filled / canceled-*,
        // filled_base_amount) is final whether or not /tx reported the tx executed within the
        // poll window (live testnet 2026-10-02: /tx unsettled, accountOrders already
        // canceled-not-enough-liquidity, filled 0.000).
        const row = await this.orderRowOutcome(extra.clientOrderIndex, null, what, out => out.status !== "open", match);
        if (row !== null) {
          filledBase = Number(toUnitsExact(row.filledSize, step, "filled size"));
          source = "accountOrders";
        }
      }
      if (filledBase !== null) {
        if (filledBase === 0) {
          throw new PerpError("ORDER_REJECTED", `${this.name} ${what}: IOC filled nothing (hash=${txHash}) — the order was cancelled by the venue`, {
            exchange: this.name, txHash, ...extra,
          });
        }
        const outcome: LighterIocOutcome = {
          filledSize: unitsToString(BigInt(filledBase), step),
          final: true, filledBase, sentBase, txHash, txStatus: state.status, source,
        };
        return { ...base, iocOutcome: outcome };
      }
    }
    console.error(`[${this.name}] Warning: ${what}: no fill report from /tx or accountOrders (hash=${txHash}) — outcome unknown, verify the position`);
    return base;
  }

  /**
   * Poll /tx until the tx is executed (status 2 / 3 with executed_at > 0) — used for cancels
   * and trigger orders (TP/SL legs), which carry no fill to read. Status 0 or an event_info
   * `ae` → ORDER_REJECTED (definite); not executed within the poll window → ORDER_PENDING.
   */
  async awaitTxExecuted(sendResult: unknown, what: string, kind: "order" | "action" = "order"): Promise<void> {
    const remediation = kind === "order"
      ? `Do NOT resubmit — check open orders: perp account orders -e ${this.name}`
      : unknownActionRemediation(this.name, what);
    const txHash = (sendResult as { tx_hash?: unknown } | null)?.tx_hash;
    if (typeof txHash !== "string" || txHash === "") {
      throw orderOutcomeUnknown(this.name, what, new Error("the sendTx response carries no tx hash"), remediation);
    }
    const state = await this.pollTx(txHash, this.txPollAttempts(20));
    if (state.kind === "rejected") {
      throw new PerpError(kind === "order" ? "ORDER_REJECTED" : "ACTION_REJECTED", `${this.name} ${what}: tx rejected (status=${state.status}, ${state.reason}, hash=${txHash})`, { exchange: this.name, txHash });
    }
    if (state.kind === "executed") return;
    throw orderOutcomeUnknown(this.name, what, new Error(`tx ${txHash} not executed within the poll window`), remediation);
  }

  /**
   * Orders of this account by client order index (`GET /api/v1/accountOrders`, auth token in
   * the Authorization header; up to 20 indexes; last 10K active / 1K inactive within 24 h).
   * Throws on a failed read or a response without an `orders` array (never "no orders").
   */
  async getOrdersByClientIndex(clientOrderIndexes: number[]): Promise<Array<Record<string, unknown>>> {
    const auth = await this.getAuthToken();
    const url = new URL(`${this._baseUrl}/api/v1/accountOrders`);
    url.searchParams.set("account_index", String(this._accountIndex));
    url.searchParams.set("client_order_indexes", clientOrderIndexes.join(","));
    await this.rhRate("/accountOrders");
    const res = await fetch(url.toString(), { headers: { Authorization: auth } });
    const text = await res.text();
    if (res.status === 429) throw rateLimitedError(this.name, res.headers.get("retry-after"), text);
    const waf = lighterWafChallenge(this.name, res.status, text);
    if (waf !== null) throw waf;
    let json: { code?: unknown; message?: unknown; orders?: unknown };
    try { json = JSON.parse(text) as typeof json; } catch {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} accountOrders: unreadable response (HTTP ${res.status})`, { exchange: this.name });
    }
    if (!res.ok || (typeof json.code === "number" && json.code !== 200) || !Array.isArray(json.orders)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} accountOrders failed (HTTP ${res.status}): ${String(json.message ?? text.slice(0, 120))}`, { exchange: this.name });
    }
    return json.orders as Array<Record<string, unknown>>;
  }

  /**
   * Our order's accountOrders row (by client order index; and order id when given) → outcome
   * from the venue's own `status` / `filled_base_amount` (lighterRowOutcomeOf — never
   * size − remaining). `settled` decides whether the row settles the question (e.g. a modify's
   * open row must carry the new price / size). Up to 4 reads 500 ms apart (indexing lag); a
   * failed read is warned. Unsettled → null. Public: LighterSpotAdapter resolves spot orders
   * with the same read (accountOrders lists spot and perp orders alike).
   */
  async orderRowOutcome(
    clientOrderIndex: number, orderId: string | null, what: string,
    settled: (out: LighterOrderOutcome, row: Record<string, unknown>) => boolean = () => true,
    match: LighterRowMatch | null = null,
  ): Promise<LighterOrderOutcome | null> {
    // A client order index is not unique (it repeats across markets and over time): a row is ours
    // only on the market we sent to and created no earlier than the send (minus clock skew).
    const ours = (r: Record<string, unknown>): boolean => {
      if (match === null) return true;
      if (Number(r.market_index) !== match.marketIndex) return false;
      const created = lighterRowCreatedMs(r);
      return created !== null && created >= match.sentAtMs - LIGHTER_ROW_SKEW_MS;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500));
      try {
        const rows = await this.getOrdersByClientIndex([clientOrderIndex]);
        const row = rows.find(r => Number(r.client_order_index ?? r.client_order_id) === clientOrderIndex && (orderId === null || lighterOrderIdOf(r) === orderId) && ours(r));
        if (row === undefined) continue;
        const id = lighterOrderIdOf(row);
        const out = lighterRowOutcomeOf(row, id === "" ? orderId : id);
        if (out !== null && settled(out, row)) return out;
      } catch (e) {
        console.error(`[${this.name}] Warning: ${what}: accountOrders read failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return null;
  }

  /**
   * Final outcome of a placed resting / post-only order (analogue for non-IOC): poll
   * /tx (rejected → ORDER_REJECTED). Our order (`to`, matched by client order index) reported
   * "filled" in event_info → filled = is (the whole order). Any other status — open, or a
   * canceled-* whose remainder the venue zeroed (`rs` 0, so is − rs is NOT a fill) — or an
   * unsettled event → `accountOrders?client_order_indexes=<coi>` with the venue's
   * `filled_base_amount`. Still unknown → null.
   */
  private async resolveOrderOutcome(sendResult: unknown, symbol: string, clientOrderIndex: number, what: string, match: LighterRowMatch): Promise<LighterOrderOutcome | null> {
    const txHash = (sendResult as { tx_hash?: unknown } | null)?.tx_hash;
    const dec = this._marketDecimals.get(symbol.toUpperCase());
    if (typeof txHash === "string" && txHash !== "") {
      const state = await this.pollTx(txHash, this.txPollAttempts(10));
      if (state.kind === "rejected") {
        throw new PerpError("ORDER_REJECTED", `${this.name} ${what}: tx rejected (status=${state.status}, ${state.reason}, hash=${txHash})`, { exchange: this.name, txHash, clientOrderIndex });
      }
      const to = state.kind === "executed" ? state.eventInfo?.to : undefined;
      if (typeof to === "object" && to !== null && dec) {
        const o = to as Record<string, unknown>;
        const filledBase = Number(o.u) === clientOrderIndex ? lighterEventFilledBase(o) : null;
        if (filledBase !== null) {
          return lighterOrderOutcomeOf(LIGHTER_ST_FILLED, unitsToString(BigInt(filledBase), lighterStep(dec.size)), lighterEventOrderId(o.i), "event_info");
        }
      }
    }
    return this.orderRowOutcome(clientOrderIndex, null, what, () => true, match);
  }

  /**
   * Final IOC fill reported by marketOrder (`raw.iocOutcome`), or null
   * when the outcome is unknown (no usable /tx report). Zero fills never reach here —
   * they throw ORDER_REJECTED.
   */
  iocOutcomeOf(raw: unknown): { filledSize: string; final: true } | null {
    return lighterIocOutcomeOf(raw);
  }

  /**
   * Integer base amount / price ticks. `size` (decimal string, "0" = none) is FLOORED to the
   * size step with exact decimal arithmetic (floorSize) — never rounded up past the request;
   * a size that floors to 0 → SIZE_TOO_SMALL.
   */
  private toTicks(symbol: string, size: string, price: string): { baseAmount: number; priceTicks: number } {
    const dec = this._marketDecimals.get(symbol.toUpperCase());
    if (!dec) {
      throw new PerpError("ORDER_REJECTED", `No market decimals loaded for ${symbol}. Market data may not be initialized.`, { exchange: this.name });
    }
    let baseAmount = 0;
    if (Number(size) > 0) {
      const step = lighterStep(dec.size);
      try {
        baseAmount = Number(toUnitsExact(floorSize(size, step), step, "size"));
      } catch (e) {
        if (e instanceof PerpError && e.structured.code === "SIZE_TOO_SMALL") {
          throw new PerpError("SIZE_TOO_SMALL",
            `Order size ${size} too small for ${symbol} (sizeDecimals=${dec.size}, min=${step}). Increase size or use a different market.`,
            { exchange: this.name },
          );
        }
        throw e;
      }
    }
    // A caller's limit / trigger price is never rounded onto the grid: off-tick → INVALID_TICK
    // (rounding to the nearest tick could cross the book or move a trigger). "0" = no price.
    let priceTicks = 0;
    if (price !== "0") {
      if (!/^\d+(\.\d+)?$/.test(price) || !(Number(price) > 0)) {
        throw new PerpError("INVALID_PARAMS", `Order price "${price}" for ${symbol} must be a positive decimal`, { exchange: this.name });
      }
      const tick = lighterStep(dec.price);
      try {
        priceTicks = Number(toUnitsExact(price, tick, "price"));
      } catch (e) {
        if (e instanceof PerpError && e.structured.code === "INVALID_TICK") {
          throw new PerpError("INVALID_TICK", `${this.name} ${symbol}: price ${price} is not on the price tick ${tick} (priceDecimals=${dec.price}); nothing was sent`, {
            exchange: this.name, remediation: `Use a price that is a multiple of ${tick}`,
          });
        }
        throw e;
      }
    }

    return { baseAmount, priceTicks };
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    if (this._marketsCache && Date.now() - this._marketsCacheTime < LighterAdapter.CACHE_TTL) return this._marketsCache;
    const markets: ExchangeMarketInfo[] = [];

    // Ensure _marketDecimals is populated (has supported_size_decimals per symbol)
    await this.ensureMarketMap();

    // Fetch order book details and funding rates in parallel
    const [obRes, fundingRates] = await Promise.all([
      this.restGet("/orderBookDetails", {}) as Promise<{
        order_book_details?: Array<{
          symbol: string;
          market_id: number;
          mark_price?: string;
          index_price?: string;
          open_interest?: number | string;
          daily_base_token_volume?: number | string;
          daily_quote_token_volume?: number | string;
          default_initial_margin_fraction?: number;
          min_initial_margin_fraction?: number;
          market_type?: string;
        }>;
      }>,
      this.getFundingRates(),
    ]);

    // An absent list is a failed fetch, never "no markets" (SSOT Rule #2).
    if (!Array.isArray(obRes.order_book_details)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} orderBookDetails: missing order_book_details array`, { exchange: this.name });
    }
    const isPriceStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && Number(v) > 0;
    const perps = obRes.order_book_details.filter(d => d.market_type === "perp");
    const unpriced: string[] = [];
    for (const d of perps) {
      const imf = d.min_initial_margin_fraction ?? d.default_initial_margin_fraction ?? 500;
      const maxLev = imf > 0 ? Math.floor(10000 / imf) : 50;
      const fr = fundingRates.get(d.symbol);
      const dec = this._marketDecimals.get(d.symbol.toUpperCase());
      // markPrice = the venue's MARK price: orderBookDetails `mark_price` (the source the public
      // data path lighter-public.ts uses; /funding-rates carries no mark price). last_trade_price
      // is a different quantity and is never substituted. A market without a mark is left out.
      if (!isPriceStr(d.mark_price)) { unpriced.push(d.symbol); continue; }
      markets.push({
        symbol: d.symbol,
        markPrice: d.mark_price,
        indexPrice: isPriceStr(d.index_price) ? d.index_price : null,
        fundingRate: fr?.rate ?? null,
        // /funding-rates `rate` (per 8 h) is not the last settled print (/fundings), not verified → null.
        fundingRateKind: null,
        volume24h: d.daily_quote_token_volume != null ? String(d.daily_quote_token_volume) : null,
        openInterest: d.open_interest != null ? String(d.open_interest) : null,
        maxLeverage: maxLev,
        sizeDecimals: dec ? dec.size : null,
        stepSize: null,
        // `fundingRate` is the /funding-rates value: a fraction per 8 h (venue fundingRateBasis).
        fundingHours: 8,
        marginTiers: null,
      });
    }
    if (unpriced.length > 0) {
      console.error(`[${this.name}] ${unpriced.length} market(s) without a mark price — not listed: ${unpriced.join(", ")}`);
    }
    if (perps.length > 0 && markets.length === 0) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} orderBookDetails returned ${perps.length} perp market(s) but none with a mark price`, {
        exchange: this.name, remediation: "Retry later; the venue market data is incomplete",
      });
    }

    this._marketsCache = markets; this._marketsCacheTime = Date.now(); return markets;
  }

  private get accountCacheKey(): string {
    return `acct:${this.accountCachePrefix}:account:${this._address}`;
  }

  /** The in-flight cached account read: parallel callers (getBalance + getPositions) share one request. */
  private _accountInFlight: Promise<Record<string, unknown> | null> | null = null;

  /** `fresh`: always read live (write-through) — open-order listings must not see a pre-cancel / pre-place snapshot. */
  private async fetchAccount(fresh = false): Promise<Record<string, unknown> | null> {
    if (!this._address) return null;
    const read = async () => {
      const res = await this.restGet("/account", {
        by: "l1_address",
        value: this._address,
      }) as { accounts?: Record<string, unknown>[] };
      return lighterSelectAccount(res.accounts, this._accountIndex, this.name);
    };
    if (fresh) return fetchAndCache(this.accountCacheKey, TTL_ACCOUNT, read);
    if (this._accountInFlight === null) {
      const p = withCache(this.accountCacheKey, TTL_ACCOUNT, read);
      this._accountInFlight = p;
      const clear = () => { if (this._accountInFlight === p) this._accountInFlight = null; };
      p.then(clear, clear);
    }
    return this._accountInFlight;
  }

  /**
   * Book from GET /orderBookOrders?market_id=<id> on this venue's host (Lighter RH: its own host
   * and market ids, e.g. RH testnet TSLA = 112). Rule #2: an unknown symbol (SYMBOL_NOT_FOUND) or
   * a failed read throws — it is never reported as an empty book. An empty `bids`/`asks` is the
   * venue's real answer (no liquidity).
   */
  async getOrderbook(symbol: string) {
    await this.ensureMarketMap();
    const marketId = this.getMarketIndex(symbol);
    const res = await this.restGet("/orderBookOrders", {
      market_id: String(marketId),
      limit: "50",
    }) as { asks?: Record<string, string>[]; bids?: Record<string, string>[] };
    const level = (l: Record<string, string>): [string, string] => {
      const size = l.remaining_base_amount ?? l.size;
      if (typeof l.price !== "string" || typeof size !== "string") {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} orderBookOrders ${symbol}: level without price / size`, { exchange: this.name });
      }
      return [l.price, size];
    };
    return { bids: (res.bids ?? []).map(level), asks: (res.asks ?? []).map(level) };
  }

  async getBalance(): Promise<ExchangeBalance> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const acct = await this.fetchAccount();
    // Rule #2: no account is not a zero balance — say so (like getMarketSettings).
    if (!acct) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name}: no account found for ${this._address}${this._accountIndex >= 0 ? ` (account index ${this._accountIndex})` : ""} — balance unknown`, {
        exchange: this.name,
        remediation: `A ${this.name} account is created by the first deposit; check the address / account index (perp -e ${this.name} wallet show) or deposit first`,
      });
    }

    const totalAsset = parseFiniteVenueNumber(acct.total_asset_value, "total_asset_value", "lighter");
    const available = parseFiniteVenueNumber(acct.available_balance, "available_balance", "lighter");
    const collateral = parseFiniteVenueNumber(acct.collateral, "collateral", "lighter");
    const unrealizedPnl = (acct.positions as unknown as Record<string, unknown>[])?.reduce(
      (sum: number, p: Record<string, unknown>) =>
        sum + parseFiniteVenueNumber(p.unrealized_pnl, "position.unrealized_pnl", "lighter"),
      0,
    ) ?? 0;

    // Include spot collateral balance (USDC on Lighter, USDG on Lighter RH; separate from perp collateral)
    // An account without that asset holds none of it (0); an unreadable assets list / balance throws.
    let spotUsdc = 0;
    const collateralSymbol = this.collateralSymbol;
    if (!Array.isArray(acct.assets)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} account has no assets list — spot ${collateralSymbol} balance unknown`, { exchange: this.name });
    }
    const usdcAsset = (acct.assets as Array<Record<string, unknown>>).find(a => a?.symbol === collateralSymbol);
    if (usdcAsset !== undefined) spotUsdc = parseFiniteVenueNumber(usdcAsset.balance, `assets.${collateralSymbol}.balance`, "lighter");

    return {
      equity: String(totalAsset + spotUsdc),
      available: String(available),
      marginUsed: String(Math.max(0, collateral - available)),
      unrealizedPnl: String(unrealizedPnl),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const acct = await this.fetchAccount();
    if (!acct) return [];

    return ((acct.positions as unknown as Record<string, unknown>[]) ?? [])
      .filter((p: Record<string, unknown>) => parseFiniteVenueNumber(p.position, "position", "lighter") !== 0)
      .map((p: Record<string, unknown>) => {
        const posSize = parseFiniteVenueNumber(p.position, "position", "lighter");
        const positionValue = parseFiniteVenueNumber(p.position_value, "position_value", "lighter");
        return {
          symbol: String(p.symbol || `Market-${p.market_id}`),
          side: (Number(p.sign) > 0 ? "long" : "short") as "long" | "short",
          size: String(Math.abs(posSize)),
          entryPrice: String(p.avg_entry_price || "0"),
          markPrice: (() => {
            if (posSize === 0) return "0";
            const rawMark = positionValue / Math.abs(posSize);
            const priceDec = this._marketDecimals.get(String(p.symbol || "").toUpperCase())?.price;
            return priceDec !== undefined ? rawMark.toFixed(priceDec) : formatComputedPrice(rawMark);
          })(),
          // The venue reports "0" when the position has no liquidation price (e.g. cross margin
          // well covered): that is "none", not a price.
          liquidationPrice: Number(p.liquidation_price) > 0 ? String(p.liquidation_price) : null,
          unrealizedPnl: String(p.unrealized_pnl || "0"),
          // The leverage CONFIGURED for the market (what `trade leverage` set) — not notional / equity.
          ...lighterPositionSettings(p, this.name),
        };
      });
  }

  /**
   * Per-market leverage / margin mode the venue exposes: every `positions[]` entry of the
   * account (the venue keeps an entry for a market once it was traded or configured, open
   * position or not).
   */
  async getMarketSettings(): Promise<Array<{ symbol: string; leverage: number; marginMode: "cross" | "isolated" }>> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const acct = await this.fetchAccount();
    if (acct === null) throw new PerpError("EXCHANGE_ERROR", `${this.name}: no account found for ${this._address}`, { exchange: this.name });
    if (!Array.isArray(acct.positions)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} account has no positions list — per-market settings unknown`, { exchange: this.name });
    }
    return (acct.positions as Array<Record<string, unknown>>).map(p => ({ symbol: String(p.symbol), ...lighterPositionSettings(p, this.name) }));
  }

  private async getAuthToken(): Promise<string> {
    if (this._readOnly) throw new Error("Auth requires API key");
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    return this._signer.createAuthToken(deadline, this._apiKeyIndex, this._accountIndex);
  }

  private async restGetAuth(path: string, params: Record<string, string>): Promise<unknown> {
    const auth = await this.getAuthToken();
    params.auth = auth;
    return this.restGet(path, params);
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    if (this._accountIndex < 0 || this._readOnly) return [];
    // ONE request for every perp market. Docs (apidocs.lighter.xyz/reference/accountactiveorders):
    // market_id — "If not specified, returns active orders for all markets."; market_type —
    // "all" | "spot" | "perp". (The former per-market fan-out read every perp market — 235 on
    // Lighter mainnet — whenever an order rested on a market without a positions[] entry, far past
    // rate-limits "Standard Accounts: 60 requests per rolling minute".)
    // A failed read throws — a partial list would let cancel-all report success while orders
    // stay live (SSOT Rule #2).
    await this.ensureMarketMap();
    const res = await this.restGetAuth("/accountActiveOrders", {
      account_index: String(this._accountIndex),
      market_type: "perp",
    }) as { orders?: unknown; next_cursor?: unknown };
    if (!Array.isArray(res.orders)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} accountActiveOrders returned no orders array`, { exchange: this.name });
    }
    // The docs list `next_cursor` in the response but no cursor request parameter: a further
    // page cannot be read, and a first page is never reported as the whole list.
    if (typeof res.next_cursor === "string" && res.next_cursor !== "") {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} accountActiveOrders returned a next_cursor (more open orders than one page); the remaining orders cannot be listed`, {
        exchange: this.name, remediation: `List one market's orders with: perp trade status / cancel per symbol, or use the venue UI`,
      });
    }
    const symbolOf = new Map<number, string>();
    for (const [sym, id] of this._marketMap) symbolOf.set(id, sym);
    return (res.orders as Array<Record<string, unknown>>).map((o): ExchangeOrder => {
      const sym = symbolOf.get(Number(o.market_index));
      if (sym === undefined) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} open order ${lighterOrderIdOf(o)} is on market_index ${JSON.stringify(o.market_index)}, which is not in the loaded perp market list`, { exchange: this.name, raw: o });
      }
      return {
        // The venue order id as an exact string (`order_id` is a string on the wire; the
        // numeric `order_index` is the same value). cancelOrder / modifyOrder look the row
        // up by this id and sign with its client order index (lighterOrderSignIndex).
        orderId: lighterOrderIdOf(o),
        symbol: sym,
        side: this.sideOfIsAsk(o.is_ask, "open order", o),
        price: lighterRowField(o, "price", this.name),
        size: lighterRowField(o, "initial_base_amount", this.name),
        filled: lighterRowField(o, "filled_base_amount", this.name),
        status: lighterRowField(o, "status", this.name),
        type: lighterRowField(o, "type", this.name),
        triggerPrice: Number(o.trigger_price) > 0 ? String(o.trigger_price) : null,
      };
    });
  }

  /** Order / trade side from Lighter's `is_ask`; a missing / non-boolean value throws (never defaults to "buy"). */
  private sideOfIsAsk(isAsk: unknown, what: string, raw: unknown): "buy" | "sell" {
    if (typeof isAsk !== "boolean") {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} ${what} row has no boolean is_ask (got ${JSON.stringify(isAsk)})`, { exchange: this.name, raw });
    }
    return isAsk ? "sell" : "buy";
  }

  /**
   * Slippage-bounded IOC: protection price = orderbook mid ± opts.slippage.bps,
   * tick-aligned toward crossing. The returned raw sendTx result carries `protection`
   * and, when the venue reported the fill, `iocOutcome` (see iocOutcomeOf).
   * `opts.clientOrderIndex` (optional) = caller's numeric client order id (lighterClientOrderIndex rule).
   */
  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderIndex?: number }) {
    // Everything before sendTx (signer, market map, nonce, ticks, reference price, signing) is
    // pre-send: a failure there is a definite "not placed" (orderNotSent), never ORDER_PENDING.
    let signed: WasmTxResponse;
    let baseAmount: number;
    let protection: LighterProtection;
    let clientOrderIndex: number;
    try {
      this.ensureSigner();
      await this.ensureMarketMap();

      const nonce = await this.getNextNonce();
      const marketIndex = this.getMarketIndex(symbol);
      ({ baseAmount } = this.toTicks(symbol, size, "0"));
      const reference = await this.getReferencePrice(symbol);
      const p = this.protectionFor(symbol, side, reference, opts.slippage, LIGHTER_REFERENCE_PRICE_SOURCE);
      protection = p.protection;
      clientOrderIndex = this.clientOrderIndexFor(opts.clientOrderIndex);
      signed = await this.signOrder({
        marketIndex,
        clientOrderIndex,
        baseAmount,
        price: p.priceTicks,
        isAsk: side === "sell" ? 1 : 0,
        orderType: 1, // ORDER_TYPE_MARKET
        timeInForce: LIGHTER_TIF.IOC,
        // reduceOnly is a first-class order field (`ReduceOnly uint8 json:"ro"`),
        // not a limit-order-only one — the previous `void opts` dropped it and
        // every close/rollback that asked for reduce-only was sent as a plain
        // market order, so one sized above the live position could FLIP it. The
        // venue enforces the constraint itself (21732 "reduce only increases
        // position"), so passing it through converts a silent flip into an honest
        // rejection. Same defect 6812c86 fixed on Hyperliquid.
        reduceOnly: opts?.reduceOnly ? 1 : 0,
        triggerPrice: 0,
        orderExpiry: 0, // DEFAULT_IOC_EXPIRY
        nonce,
      });
    } catch (e) {
      throw orderNotSent(this.name, `market ${side} ${size} ${symbol}`, e);
    }
    const match: LighterRowMatch = { marketIndex: this.getMarketIndex(symbol), sentAtMs: Date.now() };
    const result = await this.sendTx(signed, "order", `market ${side} ${size} ${symbol}`);
    return this.awaitIocOutcome(result, symbol, baseAmount, `market ${side} ${size} ${symbol}`, { protection, clientOrderIndex }, match);
  }

  /**
   * TIF mapping: GTC/GTT → GTT (28-day expiry, gttExpiryMs), IOC → IOC,
   * ALO / POST_ONLY → time-in-force 2 (POST_ONLY per apidocs trading.md and the official
   * lighter-go signer; 28-day expiry like GTT — testnet confirmation pending).
   * FOK and any other value → CAPABILITY_UNSUPPORTED (never silently GTT).
   * `opts.clientOrderIndex` as in marketOrder.
   * IOC: the same definite outcome as marketOrder (awaitIocOutcome — zero fill →
   * ORDER_REJECTED, positive fill → `iocOutcome`, no report → unknown).
   * GTT / post-only: the placement outcome is resolved (resolveOrderOutcome) and attached as
   * `orderOutcome` (open / filled / cancelled, final); unresolved → no `orderOutcome` (pending).
   */
  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string; clientOrderIndex?: number }) {
    let signed: WasmTxResponse;
    let clientOrderIndex: number;
    let sentBase: number;
    let isIoc = false;
    const tif = (opts?.tif ?? "GTC").toUpperCase();
    try { // pre-send (see marketOrder)
      let timeInForce: number;
      if (tif === "GTC" || tif === "GTT") timeInForce = LIGHTER_TIF.GTT;
      else if (tif === "IOC") timeInForce = LIGHTER_TIF.IOC;
      else if (tif === "ALO" || tif === "POST_ONLY") timeInForce = LIGHTER_TIF.POST_ONLY;
      else throw unsupported(this.name, tif === "FOK" ? "fok" : "timeInForce", `time-in-force ${opts?.tif} is not offered`, "Use --tif GTC or IOC");
      this.ensureSigner();
      await this.ensureMarketMap();
      const nonce = await this.getNextNonce();
      const marketIndex = this.getMarketIndex(symbol);
      const ticks = this.toTicks(symbol, size, price);
      sentBase = ticks.baseAmount;
      isIoc = timeInForce === LIGHTER_TIF.IOC;
      clientOrderIndex = this.clientOrderIndexFor(opts?.clientOrderIndex);
      signed = await this.signOrder({
        marketIndex,
        clientOrderIndex,
        baseAmount: ticks.baseAmount,
        price: ticks.priceTicks,
        isAsk: side === "sell" ? 1 : 0,
        orderType: 0, // ORDER_TYPE_LIMIT
        timeInForce,
        reduceOnly: opts?.reduceOnly ? 1 : 0,
        triggerPrice: 0,
        // IOC: no expiry; GTT / post-only rest on the book: -1 = now + 28 days (LighterWasmSigner)
        orderExpiry: timeInForce === LIGHTER_TIF.IOC ? 0 : -1,
        nonce,
      });
    } catch (e) {
      throw orderNotSent(this.name, `limit ${side} ${size} ${symbol} @ ${price}`, e);
    }
    const match: LighterRowMatch = { marketIndex: this.getMarketIndex(symbol), sentAtMs: Date.now() };
    const result = await this.sendTx(signed, "order", `limit ${tif} ${side} ${size} ${symbol} @ ${price}`);
    if (isIoc) {
      return this.awaitIocOutcome(result, symbol, sentBase, `limit IOC ${side} ${size} ${symbol} @ ${price}`, { clientOrderIndex }, match);
    }
    const what = `limit ${tif} ${side} ${size} ${symbol} @ ${price}`;
    const orderOutcome = await this.resolveOrderOutcome(result, symbol, clientOrderIndex, what, match);
    if (orderOutcome === null) {
      console.error(`[${this.name}] Warning: ${what}: placement not confirmed yet — verify with: perp account orders -e ${this.name}`);
      return { ...(result as Record<string, unknown>), clientOrderIndex };
    }
    return { ...(result as Record<string, unknown>), clientOrderIndex, orderOutcome };
  }

  /** Final placement outcome attached by limitOrder (`raw.orderOutcome`), or null when unresolved. */
  orderOutcomeOf(raw: unknown): LighterOrderOutcome | null {
    if (typeof raw !== "object" || raw === null) return null;
    const o = (raw as { orderOutcome?: unknown }).orderOutcome;
    if (typeof o !== "object" || o === null || (o as { final?: unknown }).final !== true) return null;
    return o as LighterOrderOutcome;
  }

  /**
   * The open order `orderId` (exact venue id string) of `symbol`, from a live authenticated
   * `/accountActiveOrders` read. Not listed open → ORDER_NOT_FOUND (nothing is sent).
   */
  private async activeOrderRow(symbol: string, marketIndex: number, orderId: string, what: string): Promise<Record<string, unknown>> {
    const active = await this.restGetAuth("/accountActiveOrders", {
      account_index: String(this._accountIndex),
      market_id: String(marketIndex),
    }) as { orders?: unknown };
    if (!Array.isArray(active.orders)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} accountActiveOrders returned no orders array for ${symbol.toUpperCase()}; nothing was ${what}`, { exchange: this.name });
    }
    const row = (active.orders as Array<Record<string, unknown>>).find(o => lighterOrderIdOf(o) === orderId);
    if (row === undefined) {
      throw new PerpError("ORDER_NOT_FOUND", `${this.name} order ${orderId} is not among the open ${symbol.toUpperCase()} orders; nothing was ${what}`, { exchange: this.name });
    }
    return row;
  }

  /**
   * A failure before a cancel / modify / leverage tx was sent: orderNotSent (definite — a 429 or
   * transport failure on the nonce / active-orders read is never an unknown write outcome). The
   * lookup's own verdict ORDER_NOT_FOUND keeps its code (nothing was sent either).
   */
  private notSent(what: string, e: unknown): PerpError {
    if (e instanceof PerpError && e.structured.code === "ORDER_NOT_FOUND") return e;
    return orderNotSent(this.name, what, e);
  }

  /**
   * Cancel one open order. The order is looked up among the market's open orders and the
   * cancel is signed with its client order index (or its order id when that is 0 and exactly
   * representable — lighterOrderSignIndex); otherwise refused. Never falls back to cancel-all.
   */
  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    let signed: WasmTxResponse;
    let row: Record<string, unknown>;
    try { // pre-send (see marketOrder): market list, the order's active row, nonce, signing
      this.ensureSigner();
      await this.ensureMarketMap();
      if (!/^\d+$/.test(orderId)) {
        throw new PerpError("INVALID_PARAMS", `${this.name} order id "${orderId}" must be a decimal integer; nothing was cancelled`, { exchange: this.name });
      }
      const marketIndex = this.getMarketIndex(symbol);
      row = await this.activeOrderRow(symbol, marketIndex, orderId, "cancelled");
      const index = lighterOrderSignIndex(row, this.name);
      const nonce = await this.getNextNonce();
      signed = this._signer.signCancelOrder({
        marketIndex, orderIndex: index, nonce,
        apiKeyIndex: this._apiKeyIndex, accountIndex: this._accountIndex,
      });
      if (signed.error) throw new PerpError("SIGNATURE_FAILED", `${this.name} cancel ${orderId}: signer error: ${signed.error}`, { exchange: this.name });
    } catch (e) {
      throw this.notSent(`cancel ${orderId} ${symbol}`, e);
    }
    const result = await this.sendTx(signed, "order", `cancel ${orderId} ${symbol}`);
    // The cancelled order's client index rides along so cancelOutcome can read its final row.
    const coi = Number(row.client_order_index ?? row.client_order_id);
    return { ...(result as Record<string, unknown>), cancelTarget: { orderId, clientOrderIndex: Number.isSafeInteger(coi) && coi > 0 ? coi : null } };
  }

  /**
   * Cancel the PERP open orders (of `symbol`, or of every perp market) one by one, each cancel
   * polled to executed (awaitTxExecuted: rejected → ORDER_REJECTED, not executed in the poll
   * window → ORDER_PENDING). Never the account-wide CancelAllOrders tx (market 255): that also
   * cancels the account's SPOT orders, which a perp cancel-all / bot / plan must not touch.
   */
  async cancelAllOrders(symbol?: string): Promise<unknown> {
    let orders: ExchangeOrder[];
    try { // pre-send: the open-orders listing — nothing is cancelled when it fails
      this.ensureSigner();
      orders = await this.getOpenOrders(); // perp markets only
    } catch (e) {
      throw this.notSent(`cancel-all${symbol ? ` ${symbol}` : ""}`, e);
    }
    const targets = symbol ? orders.filter(o => o.symbol.toUpperCase() === symbol.toUpperCase()) : orders;
    // Every target is attempted; one failed cancel must not leave the orders after it untouched
    // and unreported. All cancelled → the raw results (as before); any failure → one error
    // carrying the per-order outcome.
    const results: unknown[] = [];
    const perOrder: Array<{ orderId: string; symbol: string; cancelled: boolean; code: string | null; error: string | null }> = [];
    for (const o of targets) {
      try {
        const r = await this.cancelOrder(o.symbol, o.orderId);
        await this.awaitTxExecuted(r, `cancel ${o.orderId} ${o.symbol}`);
        results.push(r);
        perOrder.push({ orderId: o.orderId, symbol: o.symbol, cancelled: true, code: null, error: null });
      } catch (e) {
        perOrder.push({ orderId: o.orderId, symbol: o.symbol, cancelled: false, code: classifyError(e, this.name).code, error: extractErrorMessage(e) });
      }
    }
    const failed = perOrder.filter(r => !r.cancelled);
    if (failed.length === 0) return results;
    const cancelled = perOrder.length - failed.length;
    // Some cancelled → ORDER_PARTIAL; none cancelled → ORDER_REJECTED only when every failure is a
    // definite refusal, otherwise the outcome of at least one cancel is unknown (ORDER_PENDING).
    const code = cancelled > 0 ? "ORDER_PARTIAL"
      : failed.every(r => r.code !== null && DEFINITE_ORDER_FAILURE_CODES.has(r.code as ErrorCode)) ? "ORDER_REJECTED" : "ORDER_PENDING";
    throw new PerpError(code, `${this.name} cancel-all: ${cancelled} of ${perOrder.length} order(s) cancelled; failed: ${failed.map(r => `${r.orderId} ${r.symbol} (${r.error})`).join("; ")}`, {
      exchange: this.name,
      results: perOrder,
      remediation: `Check which orders are still open (perp account orders -e ${this.name}) and cancel the remaining ones individually`,
    });
  }

  async modifyOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    let signed: WasmTxResponse;
    let existing: Record<string, unknown>;
    let baseAmount: number;
    let priceTicks: number;
    try { // pre-send (see marketOrder)
      this.ensureSigner();
      await this.ensureMarketMap();
      const marketIndex = this.getMarketIndex(symbol);
      // The order must be an open order of this market, and not a trigger order: a modify is
      // signed with triggerPrice 0, which would turn a stop / take-profit into a plain limit.
      existing = await this.activeOrderRow(symbol, marketIndex, orderId, "modified");
      const type = String(existing.type ?? "").toLowerCase();
      if (/stop|take|trigger/.test(type) || Number(existing.trigger_price ?? 0) > 0) {
        throw unsupported(this.name, "amend", "trigger orders cannot be modified", "cancel and re-place");
      }
      const index = lighterOrderSignIndex(existing, this.name);
      const nonce = await this.getNextNonce();
      ({ baseAmount, priceTicks } = this.toTicks(symbol, size, price));
      signed = this._signer.signModifyOrder({
        marketIndex,
        index,
        baseAmount,
        price: priceTicks,
        triggerPrice: 0,
        nonce,
        orderVersion: 0, // unversioned (lighter-go #83: optional; if set must exceed the current version)
        apiKeyIndex: this._apiKeyIndex,
        accountIndex: this._accountIndex,
      });
      if (signed.error) {
        throw new Error(`Signer: ${signed.error}`);
      }
    } catch (e) {
      throw this.notSent(`modify ${orderId} ${symbol}`, e);
    }
    const result = await this.sendTx(signed, "order", `modify ${orderId} ${symbol}`);
    const coi = Number(existing.client_order_index ?? existing.client_order_id);
    const what = `modify ${orderId} ${symbol.toUpperCase()} → ${price} x ${size}`;
    const orderOutcome = await this.resolveModifyOutcome(result, symbol, orderId, Number.isSafeInteger(coi) && coi > 0 ? coi : null, { baseAmount, priceTicks }, what);
    if (orderOutcome === null) {
      console.error(`[${this.name}] Warning: ${what}: the edit is not confirmed yet — verify with: perp account orders -e ${this.name}`);
      return result;
    }
    return { ...(result as Record<string, unknown>), orderOutcome };
  }

  /**
   * Final outcome of a modify: poll /tx (rejected → ORDER_REJECTED, the order is unchanged);
   * once executed, the new order `no` from event_info — final there only when it is "filled"
   * with the sent price / size (lighterModifyOutcomeOf). Otherwise `accountOrders?client_order_indexes=<coi>`: a terminal
   * row (filled / canceled-*) is final as is; an open row only with the new price and size.
   * Still unknown → null (pending).
   */
  private async resolveModifyOutcome(
    sendResult: unknown, symbol: string, orderId: string, clientOrderIndex: number | null,
    sent: { baseAmount: number; priceTicks: number }, what: string,
  ): Promise<LighterOrderOutcome | null> {
    const dec = this._marketDecimals.get(symbol.toUpperCase());
    if (!dec) return null;
    const txHash = (sendResult as { tx_hash?: unknown } | null)?.tx_hash;
    if (typeof txHash === "string" && txHash !== "") {
      const state = await this.pollTx(txHash, this.txPollAttempts(10));
      if (state.kind === "rejected") {
        throw new PerpError("ORDER_REJECTED", `${this.name} ${what}: tx rejected (status=${state.status}, ${state.reason}, hash=${txHash}) — the order is unchanged`, { exchange: this.name, txHash, orderId });
      }
      if (state.kind === "executed") {
        const out = lighterModifyOutcomeOf(state.eventInfo, orderId, clientOrderIndex, sent, dec.size);
        if (out !== null) return out;
      }
    }
    if (clientOrderIndex === null) return null;
    // A terminal row (filled / canceled-*) is final as is; an open row only with the new price and size.
    const ticks = (v: unknown, d: number) => Math.round(Number(v) * 10 ** d);
    return this.orderRowOutcome(clientOrderIndex, orderId, what, (out, row) =>
      out.status !== "open" || (ticks(row.price, dec.price) === sent.priceTicks && ticks(row.initial_base_amount, dec.size) === sent.baseAmount));
  }

  /**
   * After a cancel tx EXECUTED (awaitTxExecuted): confirm the order is gone. With a client
   * order index (attached by cancelOrder as `cancelTarget`), its accountOrders row: canceled-*
   * → "cancelled", filled → "filled", still open → "open". Without one, the market's open
   * orders: absent → "cancelled" (gone), listed → "open". Unreadable / not indexed after a
   * few reads → null (unknown).
   */
  async cancelOutcome(sendResult: unknown, symbol: string, orderId: string): Promise<"cancelled" | "filled" | "open" | null> {
    const t = (sendResult as { cancelTarget?: { clientOrderIndex?: unknown } } | null)?.cancelTarget;
    const coi = typeof t?.clientOrderIndex === "number" && t.clientOrderIndex > 0 ? t.clientOrderIndex : null;
    let last: "open" | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500));
      try {
        if (coi !== null) {
          const row = (await this.getOrdersByClientIndex([coi])).find(r => lighterOrderIdOf(r) === orderId);
          const out = row !== undefined && typeof row.status === "string" ? lighterOrderOutcomeOf(row.status, "0", orderId, "accountOrders") : null;
          if (out?.status === "cancelled") return "cancelled";
          if (out?.status === "filled") return "filled";
          if (out?.status === "open") last = "open";
        } else {
          await this.ensureMarketMap();
          await this.activeOrderRow(symbol, this.getMarketIndex(symbol), orderId, "cancelled");
          last = "open";
        }
      } catch (e) {
        if (coi === null && e instanceof PerpError && e.structured.code === "ORDER_NOT_FOUND") return "cancelled";
      }
    }
    return last;
  }

  /**
   * One order's venue row, for a per-order status query. Client order index →
   * `accountOrders?client_order_indexes=<coi>` (active and inactive within 24 h). Order id →
   * the market's `/accountActiveOrders`, then its `/accountInactiveOrders` (latest 100).
   * A failed read throws; not listed → ORDER_NOT_FOUND (never "cancelled").
   */
  async orderStatusRow(symbol: string, ref: { kind: "orderId" | "clientOrderId"; value: string }): Promise<Record<string, unknown>> {
    if (ref.kind === "clientOrderId") {
      const coi = lighterClientOrderIndex(ref.value);
      // A client order index is not unique (it repeats across markets and over time — see
      // orderRowOutcome's LighterRowMatch): only rows on `symbol`'s market count, and several
      // such rows are ambiguous (never guessed).
      await this.ensureMarketMap();
      const marketIndex = this.getMarketIndex(symbol);
      const rows = (await this.getOrdersByClientIndex([coi])).filter(r =>
        Number(r.client_order_index ?? r.client_order_id) === coi && Number(r.market_index) === marketIndex);
      if (rows.length === 0) {
        throw new PerpError("ORDER_NOT_FOUND", `${this.name} order c:${ref.value} is not listed by accountOrders on ${symbol.toUpperCase()}`, { exchange: this.name });
      }
      if (rows.length > 1) {
        throw new PerpError("INVALID_PARAMS", `${this.name} client order id c:${ref.value} matches ${rows.length} ${symbol.toUpperCase()} orders (${rows.map(r => lighterOrderIdOf(r) || "?").join(", ")}); refusing to pick one`, {
          exchange: this.name, remediation: `Query by the venue order id instead: perp -e ${this.name} trade status ${symbol.toUpperCase()} <orderId>`,
        });
      }
      return rows[0];
    }
    await this.ensureMarketMap();
    const marketId = String(this.getMarketIndex(symbol));
    for (const path of ["/accountActiveOrders", "/accountInactiveOrders"] as const) {
      const params: Record<string, string> = { account_index: String(this._accountIndex), market_id: marketId };
      if (path === "/accountInactiveOrders") params.limit = "100";
      const res = await this.restGetAuth(path, params) as { orders?: unknown };
      if (!Array.isArray(res.orders)) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} ${path.slice(1)} returned no orders array for ${symbol.toUpperCase()}`, { exchange: this.name });
      }
      const row = (res.orders as Array<Record<string, unknown>>).find(o => lighterOrderIdOf(o) === ref.value);
      if (row !== undefined) return row;
    }
    throw new PerpError("ORDER_NOT_FOUND", `${this.name} order ${ref.value} is not among the ${symbol.toUpperCase()} open or latest 100 inactive orders`, { exchange: this.name });
  }

  /**
   * Trigger order. Market trigger (no limitPrice): execution price bound = trigger price ±
   * `opts.slippage` bps (the caller's resolveSlippage() output — required; the adapter never
   * reads settings), tick-aligned toward crossing, recorded in the
   * result as `protection`. Accepted risk: a fast move through the bound leaves the
   * triggered order unfilled.
   * TP vs SL: `opts.kind` given (TP/SL legs) → that type as given (a trigger already crossed
   * is left for the venue to reject); omitted (plain `trade stop`) → classified from the
   * trigger vs the declared reference price (orderbook mid).
   * `size` must be a positive size (never "0" = "whole position", which Lighter does not have).
   * `opts.clientOrderIndex` as in marketOrder; the result carries the `clientOrderIndex` sent
   * and, once resolved (resolveOrderOutcome), the final `orderOutcome` (untriggered → open).
   */
  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean; slippage?: ResolvedSlippage; clientOrderIndex?: number; kind?: "tp" | "sl" }): Promise<unknown> {
    let signed: WasmTxResponse;
    let protection: LighterProtection | null = null;
    let clientOrderIndex: number;
    try { // pre-send (see marketOrder)
      if (!(Number(size) > 0) || !Number.isFinite(Number(size))) {
        throw new PerpError("INVALID_PARAMS", `${this.name} stop order size must be a positive number (got "${size}") — Lighter has no whole-position trigger`, { exchange: this.name });
      }
      if (opts?.limitPrice === undefined && opts?.slippage === undefined) {
        throw new PerpError("INVALID_PARAMS", `${this.name} market trigger orders execute as a protection-priced limit; the order is missing its resolved slippage bound`, { exchange: this.name });
      }
      this.ensureSigner();
      await this.ensureMarketMap();
      const nonce = await this.getNextNonce();
      const marketIndex = this.getMarketIndex(symbol);
      const { baseAmount } = this.toTicks(symbol, size, "0");
      const { priceTicks: triggerTicks } = this.toTicks(symbol, "0", triggerPrice);

      const triggerNum = parseFloat(triggerPrice);
      const isMarket = !opts?.limitPrice;
      let priceTicks: number;
      if (isMarket) {
        const p = this.protectionFor(symbol, side, triggerNum, opts?.slippage as ResolvedSlippage, "triggerPrice");
        priceTicks = p.priceTicks;
        protection = p.protection;
      } else {
        priceTicks = this.toTicks(symbol, "0", opts!.limitPrice!).priceTicks;
      }

      const orderType = opts?.kind !== undefined
        ? (opts.kind === "sl"
          ? (isMarket ? LIGHTER_ORDER_TYPE.STOP_LOSS : LIGHTER_ORDER_TYPE.STOP_LOSS_LIMIT)
          : (isMarket ? LIGHTER_ORDER_TYPE.TAKE_PROFIT : LIGHTER_ORDER_TYPE.TAKE_PROFIT_LIMIT))
        : classifyTriggerOrderType(side, triggerNum, await this.getReferencePrice(symbol), isMarket);

      clientOrderIndex = this.clientOrderIndexFor(opts?.clientOrderIndex);
      signed = await this.signOrder({
        marketIndex,
        clientOrderIndex,
        baseAmount,
        price: Math.max(priceTicks, 1),
        isAsk: side === "sell" ? 1 : 0,
        orderType,
        timeInForce: isMarket ? LIGHTER_TIF.IOC : LIGHTER_TIF.GTT,
        reduceOnly: opts?.reduceOnly ? 1 : 0,
        triggerPrice: triggerTicks,
        orderExpiry: -1,  // matches Lighter SDK DEFAULT_28_DAY_ORDER_EXPIRY for trigger orders
        nonce,
      });
    } catch (e) {
      throw orderNotSent(this.name, `stop ${side} ${size} ${symbol} @ ${triggerPrice}`, e);
    }
    const match: LighterRowMatch = { marketIndex: this.getMarketIndex(symbol), sentAtMs: Date.now() };
    const result = await this.sendTx(signed, "order", `stop ${side} ${size} ${symbol} @ ${triggerPrice}`);
    const base: Record<string, unknown> = protection === null
      ? { ...(result as Record<string, unknown>), clientOrderIndex }
      : { ...(result as Record<string, unknown>), protection, clientOrderIndex };
    // Placement outcome as for a resting limit (resolveOrderOutcome: /tx rejected → ORDER_REJECTED,
    // else the accountOrders row by client order index). An untriggered trigger order is listed
    // "pending" / "open" (trigger_status "mark-price") → final "open"; unresolved → no orderOutcome (pending).
    const what = `stop ${side} ${size} ${symbol} @ ${triggerPrice}`;
    const orderOutcome = await this.resolveOrderOutcome(result, symbol, clientOrderIndex, what, match);
    if (orderOutcome === null) {
      console.error(`[${this.name}] Warning: ${what}: placement not confirmed yet — verify with: perp account orders -e ${this.name}`);
      return base;
    }
    return { ...base, orderOutcome };
  }

  async updateLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross"): Promise<unknown> {
    const what = `leverage ${leverage}x ${marginMode} ${symbol.toUpperCase()}`;
    let signed: WasmTxResponse;
    try { // pre-send (see marketOrder): the leverage change was not sent
      this.ensureSigner();
      await this.ensureMarketMap();
      const nonce = await this.getNextNonce();
      const marketIndex = this.getMarketIndex(symbol);
      // fraction = initial margin fraction in basis points of 10,000 ("10x leverage -> 1000",
      // apidocs.lighter.xyz/docs/trading). Truncated like the official SDK
      // (lighter-python signer_client.update_leverage: `imf = int(10_000 / leverage)`).
      const fraction = Math.trunc(10000 / leverage);
      const mode = marginMode === "isolated" ? 1 : 0;
      signed = await this._signer.signUpdateLeverage({
        marketIndex, fraction, marginMode: mode, nonce,
        apiKeyIndex: this._apiKeyIndex, accountIndex: this._accountIndex,
      });
      if (signed.error) {
        throw new Error(`Signer: ${signed.error}`);
      }
    } catch (e) {
      throw this.notSent(what, e);
    }
    const result = await this.sendTx(signed, "action", what);
    // The sendTx ack only says the tx was queued: executed / rejected comes from /tx.
    await this.awaitTxExecuted(result, what, "action");
    return result;
  }

  async withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number }): Promise<unknown> {
    // Omitted --asset-id means "the venue collateral" (asset 3 on both Lighter venues).
    return this._withdrawRaw(Number(parsePositiveDecimal(amount, `${this.name} withdraw amount`)), opts?.assetId ?? this.collateralAssetIndex, opts?.routeType ?? 0);
  }

  private async _withdrawRaw(amount: number, assetId: number, routeType: number): Promise<unknown> {
    this.ensureSigner();
    const nonce = await this.getNextNonce();
    // USDC has 6 decimals. The low-level WasmSignerClient.signWithdraw passes
    // usdcAmount straight to the WASM module with NO scaling — only the SDK's
    // high-level SignerClient wrapper multiplies by 1e6. Since this adapter calls
    // the low-level signer, it must convert human USDC → smallest units itself,
    // or it would sign a withdrawal 1,000,000x too small.
    // Rule #2: the 1e6 factor is USDC's scale specifically (assetDetails id 3:
    // decimals 6, l1_decimals 6). Other assets do not share it — ETH (id 1) and
    // LIT (id 2) report decimals 8 with l1_decimals 18 — so applying 1e6 to them
    // signs a withdrawal ~100x too small, the same class of defect 966ffc0 fixed
    // for USDC. The docs say the amount follows "the ERC20's decimals" while the
    // L2 registry carries a different `decimals`, so the correct factor for a
    // non-USDC asset is not determinable from here. Refuse instead of guessing
    // at a funds path.
    // Lighter RH: the collateral (USDG on mainnet, USDC on testnet) is at the
    // same asset id 3 with the same 6/6 decimals (live /assetDetails), so the
    // 1e6 factor holds for it too.
    const collateralSymbol = this.collateralSymbol;
    const collateralAssetIndex = this.collateralAssetIndex;
    if (assetId !== collateralAssetIndex) {
      throw new PerpError(
        "NOT_IMPLEMENTED",
        `Lighter withdraw only supports ${collateralSymbol} (asset id ${collateralAssetIndex}); asset id ${assetId} has a different decimal scale and is not implemented.`,
        {
          exchange: this.name,
          remediation: `Withdraw ${collateralSymbol} (omit --asset-id), or withdraw this asset from the Lighter UI.`,
        },
      );
    }
    const scaledAmount = Math.floor(amount * 1_000_000);
    if (amount > 0 && scaledAmount <= 0) {
      throw new Error(`Lighter withdraw amount ${amount} ${collateralSymbol} rounds below the minimum unit (1e-6 ${collateralSymbol}).`);
    }
    const signed = await this._signer.signWithdraw({
      usdcAmount: scaledAmount, assetIndex: assetId, routeType, nonce,
      apiKeyIndex: this._apiKeyIndex, accountIndex: this._accountIndex,
    });
    const what = `withdraw ${amount} ${collateralSymbol}`;
    const result = await this.sendTx(signed, "action", what);
    // The sendTx ack only says the tx was queued: executed / rejected comes from /tx.
    await this.awaitTxExecuted(result, what, "action");
    return result;
  }

  // ── Interface aliases ──

  async editOrder(symbol: string, orderId: string, price: string, size: string) {
    return this.modifyOrder(symbol, orderId, price, size);
  }

  async setLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" = "cross") {
    return this.updateLeverage(symbol, leverage, marginMode);
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangePublicTrade[]> {
    await this.ensureMarketMap();
    const marketId = this.getMarketIndex(symbol);
    const res = await this.restGet("/recentTrades", { market_id: String(marketId), limit: String(limit) }) as Record<string, unknown>;
    const trades = (res.trades ?? []) as Record<string, unknown>[];
    return trades.map((t) => ({
      // /recentTrades `timestamp` is already in milliseconds (13 digits) — do NOT
      // multiply by 1000 (that pushed trade times to year ~58000).
      time: Number(t.timestamp ?? 0),
      symbol,
      // /recentTrades returns is_maker_ask: maker was asking → taker bought
      side: t.is_maker_ask ? "buy" as const : "sell" as const,
      price: String(t.price ?? "0"),
      size: String(t.size ?? t.base_amount ?? t.amount ?? ""),
      // The tape's taker_fee / maker_fee are the parties' fee RATES, not a fee the viewer paid.
      fee: null,
    }));
  }

  /**
   * Settled funding prints: GET /api/v1/fundings (apidocs.lighter.xyz/reference/fundings;
   * `count_back` rows from `start_timestamp`, max 750). Each row is one hourly settlement:
   * `rate` is PERCENT per 1 h, unsigned, with `direction` "long" (longs pay → positive) or
   * "short" (shorts pay → negative). Live 2026-10-19 BTC: rate "0.0012", value "0.99315" =
   * mark 82,763 × 0.000012, i.e. value / mark = rate / 100. NOT the /funding-rates unit (8 h).
   */
  async getFundingHistory(symbol: string, limit = 10): Promise<FundingHistoryRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 750) {
      throw new PerpError("INVALID_PARAMS", `${this.name} funding history limit must be 1..750 (got ${limit})`, { exchange: this.name });
    }
    await this.ensureMarketMap();
    const marketId = this.getMarketIndex(symbol); // unlisted market: SYMBOL_NOT_FOUND, not an empty history
    const end = Math.floor(Date.now() / 1000);
    const res = await this.restGet("/fundings", {
      market_id: String(marketId),
      resolution: "1h",
      // One spare hour covers the settlement in progress.
      start_timestamp: String(end - (limit + 1) * 3600),
      end_timestamp: String(end),
      count_back: String(limit),
    }) as { fundings?: unknown };
    if (!Array.isArray(res.fundings)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} /fundings: missing fundings array (${JSON.stringify(res).slice(0, 120)})`, { exchange: this.name });
    }
    return res.fundings.map((f) => lighterFundingRow(this.name, f)).sort((a, b) => a.time - b.time).slice(-limit);
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const res = await this.getCandles(symbol, interval, startTime, endTime) as Record<string, unknown>;
    // /candles returns the array under key `c` (top keys: code, r, c) — `res.candles`
    // is always undefined, which silently rendered every Lighter kline set empty.
    const candles = (res.c ?? res.candles ?? []) as Record<string, unknown>[];
    return candles.map((c) => ({
      time: Number(c.start_timestamp ?? c.t ?? 0),
      open: String(c.open ?? c.o ?? "0"),
      high: String(c.high ?? c.h ?? "0"),
      low: String(c.low ?? c.l ?? "0"),
      close: String(c.close ?? c.c ?? "0"),
      volume: candleNumber(c.base_token_volume ?? c.v),
      // /candles: v = base volume, V = quote (USD) volume; no per-candle trade count (live
      // 2026-10-14 keys: t o h l c v V i — `i` is the last trade id, not a count).
      quoteVolume: candleNumber(c.V),
      trades: typeof c.trades_count === "number" ? c.trades_count : typeof c.n === "number" ? c.n : null,
    }));
  }

  /**
   * Account-wide history: ONE request per 100 rows, whatever the number of markets (the former
   * per-market fan-out sent one request per perp market — 235 on Lighter mainnet — against
   * rate-limits "Standard Accounts: 60 requests per rolling minute", and dropped every failed
   * market). Docs (apidocs.lighter.xyz/reference): `limit` "minimum": 1, "maximum": 100 and a
   * `cursor` request parameter / `next_cursor` response field on accountInactiveOrders, trades
   * and positionFunding. Reads ⌈want / 100⌉ pages at most; a failed page throws — a partial
   * history is never returned (SSOT Rule #2).
   */
  private async historyRows(path: string, listKey: string, params: Record<string, string>, want: number, auth: boolean): Promise<Record<string, unknown>[]> {
    if (!Number.isInteger(want) || want < 1) {
      throw new PerpError("INVALID_PARAMS", `${this.name} ${path}: limit must be a positive integer (got ${want})`, { exchange: this.name });
    }
    if (this._accountIndex < 0) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name}: no account index is known for ${this._address} — account history cannot be read`, {
        exchange: this.name, remediation: `Check the account: perp -e ${this.name} account info`,
      });
    }
    if (auth) this.ensureSigner();
    await this.ensureMarketMap();
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    while (rows.length < want) {
      const query: Record<string, string> = { ...params, account_index: String(this._accountIndex), limit: String(Math.min(want - rows.length, 100)) };
      if (cursor !== null) query.cursor = cursor;
      const res = await (auth ? this.restGetAuth(path, query) : this.restGet(path, query)) as Record<string, unknown>;
      const page = res[listKey];
      if (!Array.isArray(page)) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} ${path} returned no ${listKey} array (code ${JSON.stringify(res.code ?? null)}: ${JSON.stringify(res.message ?? null)})`, { exchange: this.name });
      }
      rows.push(...page as Record<string, unknown>[]);
      if (page.length === 0 || typeof res.next_cursor !== "string" || res.next_cursor === "") break;
      cursor = res.next_cursor;
    }
    return rows.slice(0, want);
  }

  /** Symbol of a history row's market id; a market no longer in the loaded perp list is named by its id. */
  private historySymbol(marketId: unknown, what: string, raw: unknown): string {
    if (typeof marketId !== "number" || !Number.isInteger(marketId)) {
      throw new PerpError("EXCHANGE_ERROR", `${this.name} ${what} row has no integer market id (got ${JSON.stringify(marketId ?? null)})`, { exchange: this.name, raw });
    }
    for (const [sym, id] of this._marketMap) if (id === marketId) return sym;
    return `Market-${marketId}`;
  }

  /**
   * Order history: `GET /accountInactiveOrders` for the whole account. Docs (reference/
   * accountinactiveorders): account_index and limit are the only required parameters; market_id
   * is optional ("default": "255"), market_type is "all" | "spot" | "perp".
   */
  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const orders = await this.historyRows("/accountInactiveOrders", "orders", { market_type: "perp" }, limit, true);
    // Every field is required: a missing price / size / status / type is an unreadable row, never "0" / "done" / "limit".
    const req = (o: Record<string, unknown>, k: string): string => lighterRowField(o, k, this.name, "order history");
    return orders.map((o) => ({
      orderId: lighterOrderIdOf(o),
      symbol: this.historySymbol(o.market_index, "order history", o),
      side: this.sideOfIsAsk(o.is_ask, "order history", o),
      price: req(o, "price"),
      size: req(o, "initial_base_amount"),
      filled: req(o, "filled_base_amount"),
      status: req(o, "status"),
      type: req(o, "type"),
      triggerPrice: Number(o.trigger_price) > 0 ? String(o.trigger_price) : null,
    }));
  }

  /**
   * Trade history: `GET /trades` for the whole account, newest first. Docs (reference/trades):
   * "Get trades for lighter accounts, including sub-accounts and public pools."; sort_by and
   * limit are the only required parameters, account_index / market_id are optional filters and
   * the endpoint lists no authorization parameter.
   * Row (Trade schema + live rows 2026-10-05): no `is_ask` / `symbol` / fee amount — the account
   * is `ask_account_id` (sold) or `bid_account_id` (bought); `timestamp` is unix milliseconds
   * (live 1791168722794); `taker_fee` / `maker_fee` are integers "omitted if zero" (websocket
   * reference, Trade JSON). The docs do not state their unit; live rows read as a RATE in 1e-6
   * of `usd_amount` (a liquidation row carries 10000 = 1%, maker 28–32 on unrelated notionals),
   * so the fee is usd_amount × fee / 1e6 for the side this account took.
   */
  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const trades = await this.historyRows("/trades", "trades", { sort_by: "timestamp", market_type: "perp" }, limit, false);
    return trades.map((t) => {
      const sold = t.ask_account_id === this._accountIndex;
      const bought = t.bid_account_id === this._accountIndex;
      if (!sold && !bought || typeof t.is_maker_ask !== "boolean") {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} trade ${JSON.stringify(t.trade_id ?? null)}: account ${this._accountIndex} is neither ask (${JSON.stringify(t.ask_account_id ?? null)}) nor bid (${JSON.stringify(t.bid_account_id ?? null)}), or is_maker_ask is not a boolean`, { exchange: this.name, raw: t });
      }
      // Both sides (self-trade) → reported as the taker side.
      const side: "buy" | "sell" = sold && bought ? (t.is_maker_ask ? "buy" : "sell") : sold ? "sell" : "buy";
      const feeRate = (side === "sell") === t.is_maker_ask && !(sold && bought) ? t.maker_fee : t.taker_fee;
      if (typeof t.timestamp !== "number" || typeof t.price !== "string" || typeof t.size !== "string" || typeof t.usd_amount !== "string"
        || (feeRate !== undefined && (typeof feeRate !== "number" || !Number.isInteger(feeRate)))) {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} trade ${JSON.stringify(t.trade_id ?? null)} has an unreadable timestamp / price / size / usd_amount / fee`, { exchange: this.name, raw: t });
      }
      return {
        time: t.timestamp,
        symbol: this.historySymbol(t.market_id, "trade history", t),
        side,
        price: t.price,
        size: t.size,
        fee: feeRate === undefined ? "0" : mulDecimal(mulDecimal(t.usd_amount, String(feeRate)), "0.000001"),
      };
    });
  }

  /**
   * Funding payments: `GET /positionFunding` for the whole account, newest first. Docs
   * (reference/positionfunding): account_index and limit are the only required parameters;
   * `market_ids` ("comma-separated int64s") is an optional filter. `authorization` "is required
   * when fetching an account_index linked to a main account or a sub-account". Row (live public
   * pool read 2026-10-05): `timestamp` unix SECONDS (1791169200), `market_id`, `change` (signed
   * quote amount: a short at a positive rate has a positive change).
   */
  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    if (!this._address) throw new Error("No private key configured — account data unavailable. Run: perp setup");
    const items = await this.historyRows("/positionFunding", "position_fundings", { side: "all" }, limit, true);
    return items.map((f) => {
      if (typeof f.timestamp !== "number" || typeof f.change !== "string") {
        throw new PerpError("EXCHANGE_ERROR", `${this.name} funding row has an unreadable timestamp / change`, { exchange: this.name, raw: f });
      }
      return { time: f.timestamp * 1000, symbol: this.historySymbol(f.market_id, "funding history", f), payment: f.change };
    });
  }

  /**
   * Get funding rates for all markets.
   * API: GET /api/v1/funding-rates
   */
  async getFundingRates(): Promise<Map<string, { rate: string; markPrice: string | null }>> {
    const map = new Map<string, { rate: string; markPrice: string | null }>();
    const res = await this.restGet("/funding-rates", {}) as {
      funding_rates?: Array<{ exchange?: string; market_id: number; rate: number; symbol: string; funding_rate?: string; mark_price?: string }>;
    };

    const reverseMap = new Map<number, string>();
    for (const [sym, idx] of this._marketMap) {
      reverseMap.set(idx, sym);
    }

    for (const fr of res.funding_rates ?? []) {
      // /funding-rates is a MULTI-EXCHANGE aggregate (Binance/Bybit/HL/Lighter…).
      // The venue's own rows are labeled "lighter" on both the Lighter and the
      // Lighter RH hosts (live check 2026-09-30: RH returns 57 "lighter" rows = its 57 perps).
      // Only keep Lighter's own rate, or another venue's rate overwrites it for the
      // same symbol (last-write-wins). Mirrors src/api/public/lighter.ts.
      if (String(fr.exchange ?? "").toLowerCase() !== "lighter") continue;
      const symbol = fr.symbol || reverseMap.get(fr.market_id);
      if (!symbol) continue;
      const rate = fr.rate ?? fr.funding_rate;
      // No rate for this market → leave it out so callers see "unavailable", never a fake 0.
      if (rate == null) continue;
      map.set(symbol, {
        rate: venueRateField(rate, "funding-rates rate", this.name),
        markPrice: fr.mark_price ?? null,
      });
    }
    return map;
  }

  /**
   * Get candle data for a market.
   */
  async getCandles(symbol: string, resolution: string, startTime: number, endTime: number, countBack = 100): Promise<unknown> {
    await this.ensureMarketMap();
    const marketId = this.getMarketIndex(symbol);
    return this.restGet("/candles", {
      market_id: String(marketId),
      resolution,
      start_timestamp: String(startTime),
      end_timestamp: String(endTime),
      count_back: String(countBack),
    });
  }

  /**
   * Get PnL chart data.
   */
  async getPnl(period = "1d"): Promise<unknown> {
    return this.restGet("/pnl", {
      account_index: String(this._accountIndex),
      period,
    });
  }

  /**
   * Get deposit history.
   */
  async getDepositHistory(): Promise<unknown> {
    return this.restGet("/deposit_history", {
      l1_address: this._address,
    });
  }

  /**
   * Get withdrawal history.
   */
  async getWithdrawHistory(): Promise<unknown> {
    return this.restGet("/withdraw_history", {
      account_index: String(this._accountIndex),
    });
  }

  /**
   * Get transfer history.
   */
  async getTransferHistory(): Promise<unknown> {
    return this.restGet("/transfer_history", {
      account_index: String(this._accountIndex),
    });
  }

  /**
   * Get asset details.
   */
  async getAssetDetails(assetId?: number): Promise<unknown> {
    const params: Record<string, string> = {};
    if (assetId !== undefined) params.asset_id = String(assetId);
    return this.restGet("/assetDetails", params);
  }

  /**
   * Get exchange metrics.
   */
  async getExchangeMetrics(symbol?: string): Promise<unknown> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.restGet("/exchangeMetrics", params);
  }

  /**
   * Get account limits.
   */
  async getAccountLimits(): Promise<unknown> {
    return this.restGet("/accountLimits", {
      account_index: String(this._accountIndex),
    });
  }

  /**
   * Create CCTP intent address for cross-chain deposit.
   */
  async createIntentAddress(chainId: number): Promise<unknown> {
    await this.rhRate("createIntentAddress");
    const res = await fetch(`${this._baseUrl}/api/v1/createIntentAddress`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chain_id: String(chainId),
        from_addr: this._address,
        amount: "0",
        is_external_deposit: "true",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(`createIntentAddress failed: ${clean}`);
    }
    return res.json();
  }

  /**
   * Use a referral code (signed auth + POST). Called only from the explicit
   * `wallet manage referral set` command — never on adapter creation.
   */
  async useReferralCode(code: string): Promise<unknown> {
    // Referral endpoint requires POST with l1_address, referral_code, and auth (form-urlencoded)
    const auth = await this.getAuthToken();
    await this.rhRate("referral/use");
    const res = await fetch(`${this._baseUrl}/api/v1/referral/use`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ l1_address: this._address, referral_code: code, auth }),
    });
    const json = await res.json() as { code?: number; message?: string };
    if (json.code && json.code !== 200) {
      throw new PerpError("EXCHANGE_ERROR", `Lighter referral rejected: ${json.message ?? JSON.stringify(json)}`, {
        exchange: "lighter",
        remediation: "A Lighter account can use a referral code only once; the venue message above says why it was rejected",
      });
    }
    return json;
  }

  /**
   * Direct REST GET helper.
   */
  private async getNextNonce(): Promise<number> {
    const res = await this.restGet("/nextNonce", {
      account_index: String(this._accountIndex),
      api_key_index: String(this._apiKeyIndex),
    }) as { nonce?: number; next_nonce?: number };
    const nonce = res.nonce ?? res.next_nonce;
    // SSOT rule #2: refuse to silently default to nonce 0. A stale or
    // missing nonce will cause Lighter to reject the tx with cryptic errors
    // and the user has no way to diagnose the upstream failure.
    if (nonce === undefined || !Number.isFinite(nonce) || nonce < 0) {
      throw new Error(
        `Lighter /nextNonce returned no valid nonce for account_index=${this._accountIndex} ` +
        `api_key_index=${this._apiKeyIndex}; raw response=${JSON.stringify(res)}`,
      );
    }
    return nonce;
  }

  private async signOrder(params: {
    marketIndex: number; clientOrderIndex: number; baseAmount: number;
    price: number; isAsk: number; orderType: number; timeInForce: number;
    reduceOnly: number; triggerPrice: number; orderExpiry: number; nonce: number;
  }): Promise<WasmTxResponse> {
    try {
      const result = await this._signer.signCreateOrder({
        ...params,
        apiKeyIndex: this._apiKeyIndex,
        accountIndex: this._accountIndex,
      });
      if (result.error) {
        throw new Error(`Signer: ${result.error}`);
      }
      return result;
    } catch (e: unknown) {
      if (e instanceof Error) throw e;
      if (typeof e === "object" && e !== null && "error" in e) {
        throw new Error(`Signer: ${(e as Record<string, string>).error}`);
      }
      throw new Error(`Signer: ${JSON.stringify(e)}`);
    }
  }

  /**
   * Lighter RH REST budget (standard account: 60 req/min, rate-limits.md):
   * every RH trading/account REST call and sendTx takes a token from the
   * `${venueId}:${network}` bucket first. Venue "lighter" is not metered here.
   */
  /** Take a token from the Lighter RH rate-limit bucket (no-op for venue "lighter"). Also used by LighterSpotAdapter. */
  async rhRate(endpoint: string): Promise<void> {
    if (this.venueId === "lighter-rh") {
      await acquireRate(`${this.venueId}:${this.networkName}`, LIGHTER_RH_RATE_LIMIT, endpoint);
    }
  }

  private async sendTx(signed: WasmTxResponse, kind: "order" | "action", what: string = kind): Promise<unknown> {
    // Pre-send failures (nothing reached the venue): typed definite so order paths never report ORDER_PENDING.
    if (signed.error) throw new PerpError("SIGNATURE_FAILED", `Signer error: ${signed.error}`, { exchange: this.name });
    if (!signed.txInfo) throw new PerpError("SIGNATURE_FAILED", "Signer returned empty txInfo", { exchange: this.name });
    // SSOT rule #2: refuse to silently default txType to 0 — different tx
    // types (createOrder=14, cancelOrder=15, updateLeverage=20, etc.) need
    // different routing on Lighter's side, and a 0 either rejects with a
    // generic error or silently misroutes.
    if (signed.txType === undefined || !Number.isFinite(signed.txType)) {
      throw new PerpError("SIGNATURE_FAILED", `Lighter signer returned no txType (received ${signed.txType}); refusing to send with default 0.`, { exchange: this.name });
    }
    await this.rhRate("sendTx");
    try {
      // Transport failure / 5xx / unreadable body / internal or missing code → ORDER_PENDING;
      // only a documented validation code is a definite rejection (lighterPostSendTx).
      return await lighterPostSendTx(this._baseUrl, { txType: signed.txType, txInfo: signed.txInfo }, this.name, kind, `${what} sendTx`);
    } finally {
      // The account (positions / orders / balance) changed or may have: drop the shared acct:
      // disk cache so no later read — this process or the next CLI call — serves the pre-tx
      // snapshot (e.g. the risk check's position read before a market order).
      invalidateCache("acct");
    }
  }

  private async restGet(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this._baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    await this.rhRate(path);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      // apidocs.lighter.xyz/docs/rate-limits: a breached limit answers "HTTP 429".
      if (res.status === 429) throw rateLimitedError(this.name, res.headers.get("retry-after"), text);
      const waf = lighterWafChallenge(this.name, res.status, text);
      if (waf !== null) throw waf;
      const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(`GET ${path} failed (${res.status}): ${clean}`);
    }
    return res.json();
  }

  /** Generate a unique client order index (uint48). */
  private nextClientOrderIndex(): number {
    return lighterGeneratedClientOrderIndex();
  }

  private ensureSigner(): void {
    // init() never loads an expired agent's key, so without this the adapter would look like
    // one that simply has no API key.
    if (!this._useNoAgent && this._agentMeta && this._agentApiKey && isExpired(this._agentMeta)) throw this.agentExpired(this._agentMeta);
    if (this._readOnly || this._accountIndex < 0 || !this._signer) {
      throw new PerpError("NO_SIGNER_AVAILABLE",
        `This command requires a Lighter API key. Run \`perp wallet agent approve ${this.name}\` to register an agent.`,
        { exchange: this.name },
      );
    }
  }

  /**
   * One WASM signer (one Go runtime) per `${venueId}:${network}`.
   * lighter-go keys its clients by (accountIndex, apiKeyIndex) only and keeps a
   * package-global chainId for L1 messages, so two venues must never share a
   * runtime. Keyed by venue+network rather than chainId because Lighter testnet
   * and Lighter RH testnet both use chainId 300.
   */
  private static _wasmClients = new Map<string, Promise<LighterWasmSigner>>();

  private get _wasmKey(): string {
    return `${this.venueId}:${this.networkName}`;
  }

  private _getWasmClient(): Promise<LighterWasmSigner> {
    const key = this._wasmKey;
    let p = LighterAdapter._wasmClients.get(key);
    if (!p) {
      p = LighterAdapter._createWasmClient();
      // A failed init must not be cached; the next call retries from scratch.
      p.catch(() => { if (LighterAdapter._wasmClients.get(key) === p) LighterAdapter._wasmClients.delete(key); });
      LighterAdapter._wasmClients.set(key, p);
    }
    return p;
  }

  /**
   * Load one official signer runtime (vendored lighter-go v1.0.9 WASM, sha256-verified;
   * see lighter-signer.ts). The Go exports are captured synchronously right after go.run(),
   * so concurrent creations cannot overwrite each other's functions.
   */
  private static _createWasmClient(): Promise<LighterWasmSigner> {
    return LighterWasmSigner.load();
  }

  /**
   * Generate a new Lighter API key pair using this venue's WASM signer
   * (key generation is chain-independent). Returns { privateKey, publicKey }.
   */
  async generateApiKey(): Promise<{ privateKey: string; publicKey: string }> {
    const client = await this._getWasmClient();
    return client.generateAPIKey();
  }

  /**
   * Read every API-key slot registered on this account (`GET /api/v1/apikeys`).
   * Used before a ChangePubKey (approve must not overwrite an in-use slot) and after
   * one (revoke must confirm the slot's public key actually changed). Throws on a
   * malformed response — callers must never treat an unreadable list as "all free".
   */
  async listApiKeys(): Promise<Array<{ apiKeyIndex: number; publicKey: string }>> {
    if (this._accountIndex < 0) {
      throw new Error("Account index not available. Call init() first.");
    }
    // api_key_index 255 = every slot (explicit, never rely on the server default).
    const res = await this.restGet("/apikeys", { account_index: String(this._accountIndex), api_key_index: "255" }) as { api_keys?: unknown };
    if (!res || !Array.isArray(res.api_keys)) {
      throw new Error(`Lighter /apikeys returned no api_keys array (account_index=${this._accountIndex}); raw=${JSON.stringify(res).slice(0, 200)}`);
    }
    return res.api_keys.map((raw: unknown) => {
      const k = raw as { api_key_index?: unknown; public_key?: unknown };
      const idx = Number(k.api_key_index);
      if (!Number.isInteger(idx) || typeof k.public_key !== "string") {
        throw new Error(`Lighter /apikeys returned a malformed entry: ${JSON.stringify(raw).slice(0, 200)}`);
      }
      return { apiKeyIndex: idx, publicKey: k.public_key };
    });
  }

  /**
   * Generate an API key and register it on-chain via ChangePubKey.
   * Uses WASM signer to sign + ETH key for L1 signature.
   * Returns the generated key pair.
   */
  async setupApiKey(apiKeyIndex = 4): Promise<{ privateKey: string; publicKey: string }> {
    LighterAdapter._assertKeyIndexAllowed(this.venueId, apiKeyIndex);
    if (!this._evmSigner) {
      throw new Error("No EVM private key configured. Run: perp setup");
    }
    if (this._accountIndex < 0) {
      throw new Error("Account index not available. Call init() first.");
    }

    // 1. Generate key pair
    const { privateKey, publicKey } = await this.generateApiKey();

    // 2. Get nonce from API
    // SSOT rule #2: refuse to silently default to nonce 0 — see getNextNonce.
    const nonceRes = await this.restGet("/nextNonce", {
      account_index: String(this._accountIndex),
      api_key_index: String(apiKeyIndex),
    }) as { nonce?: number; next_nonce?: number };
    const nonce = nonceRes.nonce ?? nonceRes.next_nonce;
    if (nonce === undefined || !Number.isFinite(nonce) || nonce < 0) {
      throw new Error(
        `Lighter /nextNonce returned no valid nonce for ChangePubKey ` +
        `(account_index=${this._accountIndex} api_key_index=${apiKeyIndex}); ` +
        `raw response=${JSON.stringify(nonceRes)}`,
      );
    }

    // 3. Create signer client with new key and sign ChangePubKey
    const client = await this._getWasmClient();
    client.createClient({
      privateKey,
      chainId: this._chainId,
      apiKeyIndex,
      accountIndex: this._accountIndex,
    });

    // Sign ChangePubKey
    const signed = client.signChangePubKey({
      pubkey: publicKey,
      nonce,
      apiKeyIndex,
      accountIndex: this._accountIndex,
    });

    if (signed.error) throw new Error(`SignChangePubKey failed: ${signed.error}`);
    if (!signed.txInfo || !signed.messageToSign) {
      throw new Error("SignChangePubKey returned incomplete response");
    }

    // 4. Sign messageToSign with EVM signer (EIP-191 personal_sign)
    const l1Sig = await this._evmSigner!.signMessage(signed.messageToSign);

    // 5. Add L1Sig to txInfo
    const txInfo = JSON.parse(signed.txInfo);
    txInfo.L1Sig = l1Sig;

    // 6. Submit to Lighter API
    // SSOT rule #2: refuse to silently default txType to 0 — see sendTx.
    if (signed.txType === undefined || !Number.isFinite(signed.txType)) {
      throw new Error(`Lighter signChangePubKey returned no txType (received ${signed.txType}); refusing to send with default 0.`);
    }
    await this.rhRate("sendTx");
    const sendRes = await fetch(`${this._baseUrl}/api/v1/sendTx`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tx_type: String(signed.txType),
        tx_info: JSON.stringify(txInfo),
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      throw new Error(`ChangePubKey sendTx failed (${sendRes.status}): ${errText}`);
    }

    const result = await sendRes.json() as { code: number; message?: string; tx_hash?: string };
    if (result.code !== 200) {
      // Retry with fresh nonce if invalid nonce (pending tx or stale nonce)
      if (result.message && /invalid nonce/i.test(result.message)) {
        const MAX_NONCE_RETRIES = 3;
        let lastError = result.message;

        for (let attempt = 1; attempt <= MAX_NONCE_RETRIES; attempt++) {
          await new Promise(r => setTimeout(r, 500 * attempt));

          // Re-fetch nonce from API (may have updated since first call)
          const freshNonceRes = await this.restGet("/nextNonce", {
            account_index: String(this._accountIndex),
            api_key_index: String(apiKeyIndex),
          }) as { nonce?: number; next_nonce?: number };
          const freshNonceCandidate = freshNonceRes.nonce ?? freshNonceRes.next_nonce;
          if (freshNonceCandidate === undefined || !Number.isFinite(freshNonceCandidate) || freshNonceCandidate < 0) {
            // SSOT rule #2: refuse to silently fall back to the original nonce.
            // Skip the retry attempt and surface the upstream nonce-fetch failure.
            lastError = `fresh /nextNonce returned no valid nonce (raw=${JSON.stringify(freshNonceRes)})`;
            continue;
          }
          const freshNonce = freshNonceCandidate + attempt;

          const retrySigned = client.signChangePubKey({
            pubkey: publicKey, nonce: freshNonce, apiKeyIndex, accountIndex: this._accountIndex,
          });
          if (retrySigned.error || !retrySigned.txInfo || !retrySigned.messageToSign) {
            lastError = retrySigned.error ?? "incomplete response";
            continue;
          }
          if (retrySigned.txType === undefined || !Number.isFinite(retrySigned.txType)) {
            lastError = `signChangePubKey retry returned no txType (received ${retrySigned.txType})`;
            continue;
          }
          const retryTxInfo = JSON.parse(retrySigned.txInfo);
          retryTxInfo.L1Sig = await this._evmSigner!.signMessage(retrySigned.messageToSign);
          await this.rhRate("sendTx");
          const retryRes = await fetch(`${this._baseUrl}/api/v1/sendTx`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              tx_type: String(retrySigned.txType),
              tx_info: JSON.stringify(retryTxInfo),
            }),
          });
          if (!retryRes.ok) {
            lastError = `sendTx ${retryRes.status}: ${await retryRes.text()}`;
            continue;
          }
          const retryResult = await retryRes.json() as { code: number; message?: string };
          if (retryResult.code === 200) {
            return { privateKey, publicKey }; // Success on retry
          }
          lastError = retryResult.message ?? JSON.stringify(retryResult);
          if (!/invalid nonce/i.test(lastError)) break; // Different error, stop retrying
        }
        throw new Error(`ChangePubKey failed after ${MAX_NONCE_RETRIES} nonce retries: ${lastError}`);
      } else {
        throw new Error(`ChangePubKey failed: ${result.message ?? JSON.stringify(result)}`);
      }
    }

    return { privateKey, publicKey };
  }

  // No longer need getApi() — all reads go through REST, all writes through signer + sendTx
}
