/**
 * QFEX request signing + wire-number conversion.
 *
 * Auth (docs /websocket/channels/trade/authenticate, OpenAPI securitySchemes):
 *   signature = hex(HMAC-SHA256(secret, `${nonce}:${unix_ts}`))
 *   nonce     = hex, ≤ 100 chars, unique within 15 minutes → 16 random bytes per request
 *   unix_ts   = seconds
 * The same string signs the Trade WebSocket `auth` message and every REST request
 * (method, path and body are NOT part of the signature).
 *
 * Wire numbers: QFEX sends and expects prices / quantities as JSON numbers. toWireNumber /
 * fromWireNumber are the only places a decimal string becomes a float or the reverse.
 *
 * Wire facts that needed a live check are single constants here; while one is unset every code
 * path that needs it refuses with the uniform CAPABILITY_UNSUPPORTED response.
 */

import { createHmac, randomBytes } from "node:crypto";
import { PerpError } from "../../errors.js";
import { unsupported } from "../trading-v2.js";

export interface QfexCredentials {
  publicKey: string;
  secret: string;
}

// ── Live-checked wire facts (QFEX UAT items; scripts/e2e/venues.ts DESIGN_ITEMS) ──

/** How `add_order.params.reduce_only` is encoded. */
export type QfexReduceOnlyWire = "boolean" | "integer";

/**
 * Wire format of `add_order.reduce_only`: a JSON boolean. Q2, verified on PRODUCTION
 * 2026-10-05 (primary account, GOLD-USD, minimum size, long 0.003):
 *   - PROVEN — the flag is read: SELL LIMIT GTC with `"reduce_only": true` was acknowledged with
 *     `"reduce_only": true` echoed on the order_response; every order_response (plain orders
 *     too) carries `reduce_only` as a JSON boolean.
 *   - PROVEN — enforced with no position: the same frame sent flat (quantity 0.003) was rejected,
 *     order_response status INVALID_QUANTITY.
 *   - PROVEN — NOT enforced against the position size at placement: quantity 0.006 against a
 *     position of 0.003 was ACKed and rested with the full 0.006 (quantity_remaining 0.006).
 *   - PROVEN (IMMEDIATE order only) — capped at match time: SELL LIMIT IOC 0.006 @ 4125 with
 *     `"reduce_only": true` against long 0.003 produced three order_response frames:
 *       1. ACK        quantity 0.006, quantity_remaining 0.006, reduce_only TRUE
 *       2. FILLED     quantity 0.003 @ 4145, quantity_remaining 0.003, trade_id set, reduce_only FALSE
 *       3. CANCELLED  quantity 0.006, quantity_remaining 0.003, reduce_only TRUE
 *     and the position was flat afterwards: the venue filled up to the position size and
 *     cancelled the rest (no flip). Note frame 2: a fill-carrying frame echoes
 *     `reduce_only: false` (and its `quantity` is the fill, not the order) — normal venue
 *     behaviour, so the echo check judges the ACK and the other non-fill frames only
 *     (adapter.ts reduceOnlyUnconfirmedFrame).
 *   - NOT PROVEN — what a RESTING reduce-only order does once the position later shrinks or
 *     closes (is it capped when it eventually matches? cancelled?). Capping was shown for an
 *     order that matched immediately, one observation.
 * Also observed the same day: a GTC order survived a forced `kill -9` of the CLI process (Q1 kill
 * variant, one observation); a short position reads back as side short (Q10).
 * Docs (docs.qfex.com, re-read 2026-10-05): the add_order parameter table does not list
 * `reduce_only`; the samples send `"reduce_only": true  // Optional` (Node, Go) and
 * `"resuce_only": True # Optional` (Python, misspelled); /qfex/order-types and /qfex/faq do not
 * mention reduce-only orders. So nothing about enforcement is documented.
 * Because the venue accepts an oversize order, the adapter enforces the size itself before
 * every reduce-only send and checks the echo after it (QfexAdapter.placeOrder). That check is
 * read-then-send: a position that shrinks between the read and the match (500 ms speed bump,
 * another process, a stop trigger) relies on the venue capping at match time — observed once for
 * an IOC order (above), not for a resting one.
 */
export const QFEX_REDUCE_ONLY_WIRE = "boolean" as QfexReduceOnlyWire | null;

/**
 * Q21 — stop orders can be correlated by client id. PRODUCTION 2026-10-12 ~16:03 UTC, GOLD-USD
 * (scratchpad qfex-probe.mts): `add_order {order_type:"STOP_LOSS", side:"SELL", quantity:0.003,
 * price:3900 (trigger), order_time_in_force:"GTC", client_order_id, reduce_only:true}` →
 * order_response ACK echoing the client_order_id and reduce_only true (order_origin
 * "STOP_ORDER"); then a `stop_order_response` frame about every second (stop_order_id = the same
 * id, client_order_id echoed, stop_order_type "STOPLOSS") — a heartbeat, NOT new state;
 * get_user_orders lists the row with type STOP_LOSS (status untriggered). `cancel_stop_order
 * {stop_order_id}` → an `ack` frame, then order_response CANCELLED with the client id.
 * Docs stop_add_order: "TAKE_PROFIT and STOP_LOSS orders cannot exceed your current position".
 * true → reduce-only stop-market orders (trade stop, trade tpsl, --tp/--sl legs) are placed.
 */
export const QFEX_STOP_CLIENT_ID_ECHO = true as true | null;

/**
 * Whether UNATTENDED automation may trade on QFEX (bots, plans, TWAP, DCA, grid, funding-arb,
 * trailing stop, background jobs). UNSET. Q21 passed (stops can be placed and correlated,
 * QFEX_STOP_CLIENT_ID_ECHO), but funding is unverified (Q4) and whether a RESTING reduce-only
 * order that the market reaches while flat opens a position is unproven (Q2: production
 * 2026-10-12 — a resting reduce-only SELL stayed OPEN after the position was closed by a plain
 * sell; the venue does not cancel it), and no automated flow places its own protective stop yet.
 * Every automated entry point refuses to start (QfexAdapter.automationGate →
 * assertCanClosePositions, startJob). Manual commands are not affected.
 * To open: set to `true` once Q2 (resting reduce-only while flat) is settled.
 */
export const QFEX_AUTOMATION_VERIFIED = null as true | null;

/**
 * Whether a RESTING (GTC / ALO) reduce-only order is safe on QFEX. UNSET: Q2 proved the venue
 * ACCEPTS a resting reduce-only order larger than the position. Match-time capping is proven
 * for an IMMEDIATE (IOC) order only (2026-10-05, see QFEX_REDUCE_ONLY_WIRE); it is NOT proven
 * that an order that RESTS is capped when it matches later, nor what it does once the position
 * shrinks or closes. The adapter's
 * size rule runs only when the order is placed, so a resting reduce-only order could later open
 * or flip a position. Until proven, reduce-only orders on QFEX are immediate only — capability
 * `reduceOnlyTif: ["IOC"]` (venues/qfex.ts) — which refuses `trade limit --reduce-only` with
 * GTC / ALO / FOK and `trade scale-tp` before anything is sent.
 * To open (one bounded experiment, or for good once match-time capping is proven): set to
 * `true`; `reduceOnlyTif` then becomes null (every TIF) and nothing else changes.
 */
export const QFEX_RESTING_REDUCE_ONLY_VERIFIED = null as true | null;

/**
 * Whether a MODIFIED order_response keeps the original client_order_id (Q5). TRUE — PRODUCTION
 * 2026-10-12 ~16:03 UTC, GOLD-USD: a resting BUY LIMIT 4050 modified with `modify_order
 * {order_id, symbol, side, order_type, quantity, price:4060, reduce_only:false}` → order_response
 * MODIFIED with a NEW order_id (8e4a…, old c563…) and the SAME client_order_id. amend correlates
 * by that client id and reports the new order id. A modify of a resting reduce-only order to a
 * crossing price while flat → INVALID_QUANTITY (rejected, order unchanged) — reduce-only orders
 * are still not amended (QfexAdapter.amendOrder).
 */
export const QFEX_MODIFY_KEEPS_CLIENT_ID = true as boolean | null;

/**
 * Whether order_response.user_id is the ACCOUNT id the session authenticated as (Q22).
 * UNSET: a mismatch is recorded on the result and warned once, not treated as a failure
 * (it may be the user id). true → a mismatch is ORDER_PENDING.
 */
export const QFEX_USER_ID_IS_ACCOUNT = null as boolean | null;

const Q2_REMEDIATION =
  "Reduce / close the position on the QFEX web app. perp-cli sends reduce-only orders on QFEX only with the wire format of item Q2 set";

/** The uniform refusal of every reduce-only path when the wire format is unset; null when it is set. */
export function qfexReduceOnlyGate(wire: QfexReduceOnlyWire | null): PerpError | null {
  if (wire !== null) return null;
  return unsupported("qfex", "reduceOnly",
    "the wire format of add_order.reduce_only is unverified and the venue may ignore the flag, which would open or flip a position",
    Q2_REMEDIATION);
}

/** The uniform refusal of every unattended flow while QFEX automation is unverified; null once it is. */
export function qfexAutomationGate(verified: true | null): PerpError | null {
  if (verified === true) return null;
  return unsupported("qfex", "automation",
    "funding is unverified (Q4) and a resting reduce-only order the market reaches while flat is not proven harmless (Q2), and no automated flow places its own protective stop yet",
    "Trade QFEX with the manual commands (perp trade market / limit / stop / tpsl / close / reduce / close-all / flatten -e qfex) and watch the position yourself; "
    + "automation opens once QFEX items Q2 / Q4 are settled");
}

/** `reduce_only` value for the wire in the verified format. */
export function reduceOnlyWireValue(wire: QfexReduceOnlyWire, reduceOnly: boolean): boolean | number {
  return wire === "boolean" ? reduceOnly : reduceOnly ? 1 : 0;
}

// ── HMAC ──

export function qfexNonce(): string {
  return randomBytes(16).toString("hex");
}

export function qfexSignature(secret: string, nonce: string, unixTs: number): string {
  if (!/^[0-9a-f]{1,100}$/.test(nonce)) throw new PerpError("INVALID_PARAMS", "QFEX nonce must be 1-100 lowercase hex characters");
  if (!Number.isInteger(unixTs) || unixTs <= 0) throw new PerpError("INVALID_PARAMS", `QFEX unix_ts must be a positive integer of seconds (got ${unixTs})`);
  return createHmac("sha256", secret).update(`${nonce}:${unixTs}`).digest("hex");
}

/** REST auth headers; `accountId` selects a subaccount (x-qfex-requested-account-id), null = the key's primary account. */
export function qfexRestHeaders(creds: QfexCredentials, accountId: string | null, nowMs: number, nonce: string): Record<string, string> {
  const unixTs = Math.floor(nowMs / 1000);
  const headers: Record<string, string> = {
    "x-qfex-public-key": creds.publicKey,
    "x-qfex-hmac-signature": qfexSignature(creds.secret, nonce, unixTs),
    "x-qfex-nonce": nonce,
    "x-qfex-timestamp": String(unixTs),
  };
  if (accountId !== null) headers["x-qfex-requested-account-id"] = accountId;
  return headers;
}

export interface QfexAuthMessage {
  type: "auth";
  params: {
    hmac: { public_key: string; nonce: string; unix_ts: number; signature: string };
    account_id: string;
    builder_code?: string;
  };
}

/** Trade WebSocket `auth` message. The account is always named explicitly (never the venue's default). */
export function qfexWsAuthMessage(creds: QfexCredentials, accountId: string, builderCode: string | null, nowMs: number, nonce: string): QfexAuthMessage {
  const unixTs = Math.floor(nowMs / 1000);
  const msg: QfexAuthMessage = {
    type: "auth",
    params: {
      hmac: { public_key: creds.publicKey, nonce, unix_ts: unixTs, signature: qfexSignature(creds.secret, nonce, unixTs) },
      account_id: accountId,
    },
  };
  if (builderCode !== null) msg.params.builder_code = builderCode;
  return msg;
}

// ── Wire numbers ──

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;
/** A JSON double carries 15 significant decimal digits exactly. */
const MAX_SIGNIFICANT_DIGITS = 15;

function decimalsOfStep(step: string): number {
  if (!PLAIN_DECIMAL.test(step)) throw new PerpError("EXCHANGE_ERROR", `QFEX: step "${step}" is not a plain decimal`);
  const dot = step.indexOf(".");
  return dot === -1 ? 0 : step.length - dot - 1;
}

/**
 * Decimal string → JSON number for the wire. Refuses anything a double cannot carry exactly
 * (more than 15 significant digits) and anything that does not survive the round trip.
 */
export function toWireNumber(value: string, what: string): number {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new PerpError("INVALID_PARAMS", `${what} "${value}" is not a plain non-negative decimal`);
  }
  const digits = value.replace(".", "").replace(/^0+/, "");
  if (digits.length > MAX_SIGNIFICANT_DIGITS) {
    throw new PerpError("INVALID_PARAMS", `${what} ${value} has more than ${MAX_SIGNIFICANT_DIGITS} significant digits; QFEX takes prices and quantities as JSON numbers`, {
      remediation: `Use a ${what} with at most ${MAX_SIGNIFICANT_DIGITS} significant digits`,
    });
  }
  const n = Number(value);
  const dot = value.indexOf(".");
  const back = fromWireDecimals(n, dot === -1 ? 0 : value.length - dot - 1);
  if (back !== normalize(value)) {
    throw new PerpError("INVALID_PARAMS", `${what} ${value} cannot be represented exactly as a JSON number`);
  }
  return n;
}

function normalize(s: string): string {
  if (!s.includes(".")) return s.replace(/^0+(?=\d)/, "");
  return s.replace(/^0+(?=\d)/, "").replace(/0+$/, "").replace(/\.$/, "");
}

function fromWireDecimals(n: number, decimals: number): string {
  return normalize(n.toFixed(decimals));
}

/**
 * JSON number from the venue → decimal string quantized to the decimals of `step`
 * (lot_size for quantities, tick_size for prices). Non-finite / negative → EXCHANGE_ERROR.
 */
export function fromWireNumber(n: unknown, step: string, what: string): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new PerpError("EXCHANGE_ERROR", `QFEX: ${what} is not a non-negative number (${JSON.stringify(n)})`);
  }
  return fromWireDecimals(n, decimalsOfStep(step));
}

// ── Exact decimal sums (fills) ──

function scaled(s: string): { int: bigint; scale: number } {
  if (!PLAIN_DECIMAL.test(s)) throw new PerpError("EXCHANGE_ERROR", `QFEX: "${s}" is not a plain decimal`);
  const [ip, fp = ""] = s.split(".");
  return { int: BigInt(ip + fp), scale: fp.length };
}

function unscale(int: bigint, scale: number): string {
  const s = int.toString().padStart(scale + 1, "0");
  return scale === 0 ? s : normalize(`${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`);
}

/** Exact sum of plain decimal strings. */
export function sumDecimals(values: readonly string[]): string {
  let scale = 0;
  const parts = values.map(scaled);
  for (const p of parts) scale = Math.max(scale, p.scale);
  let total = 0n;
  for (const p of parts) total += p.int * 10n ** BigInt(scale - p.scale);
  return unscale(total, scale);
}

/** a − b exactly; throws when the result would be negative. */
export function subDecimals(a: string, b: string, what: string): string {
  const x = scaled(a);
  const y = scaled(b);
  const scale = Math.max(x.scale, y.scale);
  const d = x.int * 10n ** BigInt(scale - x.scale) - y.int * 10n ** BigInt(scale - y.scale);
  if (d < 0n) throw new PerpError("EXCHANGE_ERROR", `QFEX: ${what}: ${a} − ${b} is negative`);
  return unscale(d, scale);
}

export function decimalsEqual(a: string, b: string): boolean {
  const x = scaled(a);
  const y = scaled(b);
  const scale = Math.max(x.scale, y.scale);
  return x.int * 10n ** BigInt(scale - x.scale) === y.int * 10n ** BigInt(scale - y.scale);
}

export function isZeroDecimal(a: string): boolean {
  return scaled(a).int === 0n;
}

/** Extra decimals kept on an average price beyond the price grid. */
const AVG_PRICE_EXTRA_DECIMALS = 8;

/** Quantity-weighted average price Σ(price×qty)/Σqty, computed on BigInt; null when Σqty is zero. */
export function weightedAveragePrice(fills: ReadonlyArray<{ price: string; quantity: string }>): string | null {
  let pScale = 0;
  let qScale = 0;
  const rows = fills.map(f => ({ p: scaled(f.price), q: scaled(f.quantity) }));
  for (const r of rows) { pScale = Math.max(pScale, r.p.scale); qScale = Math.max(qScale, r.q.scale); }
  let notional = 0n;
  let qty = 0n;
  for (const r of rows) {
    const p = r.p.int * 10n ** BigInt(pScale - r.p.scale);
    const q = r.q.int * 10n ** BigInt(qScale - r.q.scale);
    notional += p * q;
    qty += q;
  }
  if (qty === 0n) return null;
  // notional has scale pScale + qScale, qty has qScale → the quotient has scale pScale (+ extra).
  const outScale = pScale + AVG_PRICE_EXTRA_DECIMALS;
  return unscale(notional * 10n ** BigInt(AVG_PRICE_EXTRA_DECIMALS) / qty, outScale);
}
