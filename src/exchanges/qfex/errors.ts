/**
 * QFEX venue status / error → PerpError.
 *
 * Three sources:
 *  - order_response.status   engine verdict on one order (definite once correlated);
 *  - error frames            `{err:{…}}`, `{type:"Err",…}`, `{type:"error",…}` (all documented);
 *  - REST problem+json       api.qfex.* and banker.qfex.*.
 * Nothing here retries. A RATE_LIMITED on a cancel is surfaced, never re-sent.
 */

import { PerpError, type ErrorCode } from "../../errors.js";

/** order_response.status values (AsyncAPI OrderResponse.status enum). */
export const QFEX_ORDER_STATUSES = [
  "ACK", "EXPIRED", "IOC_CANCELLED", "INVALID_PRICE", "INVALID_QUANTITY", "NOT_FOUND", "IOC_PARTIALLY_FILLED",
  "USER_NOT_FOUND", "PERMISSION_DENIED", "FILLED", "MODIFIED", "CANCELLED", "CANCELLED_STP", "REJECTED",
  "NO_SUCH_ORDER", "INVALID_ORDER_TYPE", "BAD_SYMBOL", "PRICE_LESS_THAN_MIN_PRICE", "PRICE_GREATER_THAN_MAX_PRICE",
  "CANNOT_MODIFY_PARTIAL_FILL", "CANNOT_MODIFY_ALO_WOULD_CROSS", "FAILED_MARGIN_CHECK",
  "REJECTED_MUST_CHANGE_VALUE_MODIFY", "NO_CHANGE_NO_UPDATE", "INVALID_TICK_SIZE_PRECISION_PRICE",
  "INVALID_TICK_SIZE_PRECISION_QUANTITY", "QUANTITY_LESS_THAN_MIN_QUANTITY", "QUANTITY_GREATER_THAN_MAX_QUANTITY",
  "REJECTED_GREATER_THAN_MAX_PRICE_BAND", "REJECTED_LESS_THAN_MIN_PRICE_BAND", "INVALID_TIME_IN_FORCE",
  "REJECTED_WOULD_BREACH_MAX_POSITION", "REJECTED_WOULD_BREACH_MAX_NOTIONAL", "CANNOT_MODIFY_NO_SUCH_ORDER",
  "REJECTED_MARKET_CLOSED", "USER_IN_LIQUIDATION", "REJECTED_FAILED_TO_PROCESS", "INVALID_TAKE_PROFIT_PRICE",
  "INVALID_STOP_LOSS_PRICE", "INVALID_CLIENT_ORDER_ID", "RATE_LIMITED", "REJECTED_TOO_MANY_OPEN_ORDERS",
  "REJECTED_OPEN_INTEREST_LIMIT", "REJECTED_TOTAL_OPEN_INTEREST_LIMIT", "REJECTED_LESS_THAN_MIN_NOTIONAL",
] as const;

export type QfexStatusClass =
  /** Received by the gateway; not yet proven resting or filled. */
  | "ack"
  /** FILLED — full when quantity_remaining is 0, otherwise a partial fill. */
  | "fill"
  /** MODIFIED — the order now lives under a new order_id. */
  | "modified"
  /** The order is gone from the book: IOC_PARTIALLY_FILLED, IOC_CANCELLED, CANCELLED, CANCELLED_STP, EXPIRED. */
  | "terminal"
  /** The engine refused the request. */
  | "reject"
  /** A status this build does not know — never interpreted. */
  | "unknown";

const TERMINAL = new Set(["IOC_PARTIALLY_FILLED", "IOC_CANCELLED", "CANCELLED", "CANCELLED_STP", "EXPIRED"]);
const KNOWN = new Set<string>(QFEX_ORDER_STATUSES);

export function qfexStatusClass(status: string): QfexStatusClass {
  if (status === "ACK") return "ack";
  if (status === "FILLED") return "fill";
  if (status === "MODIFIED") return "modified";
  if (TERMINAL.has(status)) return "terminal";
  return KNOWN.has(status) ? "reject" : "unknown";
}

const STATUS_CODE: Readonly<Record<string, ErrorCode>> = {
  INVALID_PRICE: "INVALID_PARAMS",
  INVALID_QUANTITY: "INVALID_PARAMS",
  INVALID_ORDER_TYPE: "INVALID_PARAMS",
  INVALID_TIME_IN_FORCE: "INVALID_PARAMS",
  INVALID_TAKE_PROFIT_PRICE: "INVALID_PARAMS",
  INVALID_STOP_LOSS_PRICE: "INVALID_PARAMS",
  INVALID_CLIENT_ORDER_ID: "INVALID_PARAMS",
  INVALID_TICK_SIZE_PRECISION_QUANTITY: "INVALID_PARAMS",
  REJECTED_MUST_CHANGE_VALUE_MODIFY: "INVALID_PARAMS",
  NO_CHANGE_NO_UPDATE: "INVALID_PARAMS",
  INVALID_TICK_SIZE_PRECISION_PRICE: "INVALID_TICK",
  PRICE_LESS_THAN_MIN_PRICE: "INVALID_PARAMS",
  PRICE_GREATER_THAN_MAX_PRICE: "INVALID_PARAMS",
  REJECTED_GREATER_THAN_MAX_PRICE_BAND: "INVALID_PARAMS",
  REJECTED_LESS_THAN_MIN_PRICE_BAND: "INVALID_PARAMS",
  QUANTITY_LESS_THAN_MIN_QUANTITY: "SIZE_TOO_SMALL",
  REJECTED_LESS_THAN_MIN_NOTIONAL: "SIZE_TOO_SMALL",
  QUANTITY_GREATER_THAN_MAX_QUANTITY: "SIZE_TOO_LARGE",
  BAD_SYMBOL: "SYMBOL_NOT_FOUND",
  NOT_FOUND: "ORDER_NOT_FOUND",
  NO_SUCH_ORDER: "ORDER_NOT_FOUND",
  CANNOT_MODIFY_NO_SUCH_ORDER: "ORDER_NOT_FOUND",
  CANNOT_MODIFY_PARTIAL_FILL: "ORDER_REJECTED",
  CANNOT_MODIFY_ALO_WOULD_CROSS: "ORDER_REJECTED",
  REJECTED: "ORDER_REJECTED",
  REJECTED_FAILED_TO_PROCESS: "ORDER_REJECTED",
  REJECTED_MARKET_CLOSED: "ORDER_REJECTED",
  FAILED_MARGIN_CHECK: "MARGIN_INSUFFICIENT",
  REJECTED_WOULD_BREACH_MAX_POSITION: "RISK_VIOLATION",
  REJECTED_WOULD_BREACH_MAX_NOTIONAL: "RISK_VIOLATION",
  REJECTED_OPEN_INTEREST_LIMIT: "RISK_VIOLATION",
  REJECTED_TOTAL_OPEN_INTEREST_LIMIT: "RISK_VIOLATION",
  REJECTED_TOO_MANY_OPEN_ORDERS: "RISK_VIOLATION",
  USER_IN_LIQUIDATION: "RISK_VIOLATION",
  PERMISSION_DENIED: "POLICY_DENIED",
  USER_NOT_FOUND: "AGENT_NOT_REGISTERED",
  RATE_LIMITED: "RATE_LIMITED",
};

const KEY_PERMISSION_REMEDIATION =
  "Check the API key's permissions and account scope in QFEX Developer Settings (website, 2FA). The denial can also be KYC, terms or region — perp-cli does not cache it";

const CODE_REMEDIATION: Readonly<Partial<Record<ErrorCode, string>>> = {
  INVALID_TICK: "Align the price with the market tick: perp market info <symbol> -e qfex",
  SIZE_TOO_SMALL: "Increase the size above the market minimum: perp market info <symbol> -e qfex",
  SIZE_TOO_LARGE: "Reduce the size below the market maximum: perp market info <symbol> -e qfex",
  SYMBOL_NOT_FOUND: "List markets with: perp market list -e qfex",
  MARGIN_INSUFFICIENT: "Reduce size / leverage or deposit more USDC (perp funds deposit qfex)",
  RISK_VIOLATION: "The venue's position / notional / open-interest / open-order limit was hit — reduce the size or close positions",
  POLICY_DENIED: KEY_PERMISSION_REMEDIATION,
  AGENT_NOT_REGISTERED: "The venue does not know this user / account — re-import the key: perp wallet agent import qfex",
  RATE_LIMITED: "Wait for the retry-after hint, then run the command again yourself (perp-cli never re-sends an order or a cancel)",
};

const STATUS_REMEDIATION: Readonly<Record<string, string>> = {
  CANNOT_MODIFY_PARTIAL_FILL: "A partially filled order cannot be modified — cancel it and place a new order",
  CANNOT_MODIFY_ALO_WOULD_CROSS: "The new price would cross the book — choose a passive price, or cancel and place a LIMIT order",
  REJECTED_MARKET_CLOSED: "The market is closed for this order right now — check the session: perp market info <symbol> -e qfex",
  INVALID_CLIENT_ORDER_ID: "The venue refused the generated client order id — report it (QFEX item Q18)",
};

/** "… retry after 200ms" / "… retry after 2 seconds" → ms; null when the message carries no hint. */
export function parseRetryAfterMs(message: string | null): number | null {
  if (message === null) return null;
  const m = /retry after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)\b/i.exec(message);
  if (m === null) return null;
  const n = Number(m[1]);
  return /^ms|^milli/i.test(m[2]) ? n : n * 1000;
}

export interface QfexOrderContext {
  /** What was being done, for the message ("add_order AAPL-USD"). */
  what: string;
  /** Price band of the market at validation time (attached to band rejections). */
  band: { lower: string; upper: string } | null;
}

/** Error for a correlated order_response whose status is an engine rejection. */
export function qfexOrderStatusError(status: string, ctx: QfexOrderContext, frame: unknown): PerpError {
  const code: ErrorCode = STATUS_CODE[status] ?? "ORDER_REJECTED";
  const remediation = STATUS_REMEDIATION[status] ?? CODE_REMEDIATION[code];
  const details: Record<string, unknown> = { exchange: "qfex", venueStatus: status, venueRaw: frame };
  if (status === "REJECTED_MARKET_CLOSED") details.reason = "marketClosed";
  if (ctx.band !== null && /PRICE|BAND/.test(status)) details.band = ctx.band;
  if (remediation !== undefined) details.remediation = remediation;
  return new PerpError(code, `QFEX rejected ${ctx.what}: ${status}`, details);
}

// ── Error frames ──

export const QFEX_ERR_CODES = [
  "RateLimited", "InvalidJSONFormat", "AlreadyAuthenticated", "InvalidParameter", "PermissionDenied",
  "ServerError", "InvalidOrder", "InvalidOrderId", "KycRequired", "TncRequired",
] as const;

export interface QfexErrFrame {
  errorCode: string;
  message: string | null;
  /** Echo of the request (`{type, params}`); null when absent or empty (`{}`), which carries no evidence. */
  echo: { type: string; params: Record<string, unknown> } | null;
}

const ERR_CODE: Readonly<Record<string, ErrorCode>> = {
  RateLimited: "RATE_LIMITED",
  InvalidJSONFormat: "INVALID_PARAMS",
  InvalidParameter: "INVALID_PARAMS",
  InvalidOrder: "INVALID_PARAMS",
  InvalidOrderId: "INVALID_PARAMS",
  PermissionDenied: "POLICY_DENIED",
  KycRequired: "POLICY_DENIED",
  TncRequired: "POLICY_DENIED",
  AlreadyAuthenticated: "EXCHANGE_ERROR",
  ServerError: "EXCHANGE_ERROR",
};

const ERR_REMEDIATION: Readonly<Record<string, string>> = {
  KycRequired: "Complete KYC on the QFEX website, then retry",
  TncRequired: "Accept the latest QFEX Terms and Conditions on the website, then retry",
  PermissionDenied: KEY_PERMISSION_REMEDIATION,
  RateLimited: CODE_REMEDIATION.RATE_LIMITED as string,
};

/**
 * Is an error frame, received after a MUTATING request was sent, proof that the request was
 * NOT applied? Only when the venue echoed that very request AND the code is a refusal.
 * `ServerError` ("safe to retry" in the docs) says nothing about whether the engine saw the
 * order, and an error without an echo — including the documented `RateLimited` with
 * `incoming_message: {}` — cannot be attributed to this request: both are unknown outcomes.
 */
export function qfexErrIsDefiniteRefusal(err: QfexErrFrame, echoMatches: boolean): boolean {
  if (!echoMatches) return false;
  return err.errorCode !== "ServerError" && err.errorCode in ERR_CODE;
}

/** PerpError for an error frame that is a definite answer (reads, or a refusal per qfexErrIsDefiniteRefusal). */
export function qfexErrFrameError(err: QfexErrFrame, what: string): PerpError {
  const code: ErrorCode = ERR_CODE[err.errorCode] ?? "EXCHANGE_ERROR";
  const details: Record<string, unknown> = { exchange: "qfex", venueCode: err.errorCode };
  const retryAfterMs = err.errorCode === "RateLimited" ? parseRetryAfterMs(err.message) : null;
  if (retryAfterMs !== null) details.retryAfterMs = retryAfterMs;
  const remediation = ERR_REMEDIATION[err.errorCode] ?? CODE_REMEDIATION[code];
  if (remediation !== undefined) details.remediation = remediation;
  return new PerpError(code, `QFEX ${what}: ${err.errorCode}${err.message !== null ? ` — ${err.message}` : ""}`, details);
}

// ── REST ──

interface ProblemJson { title?: unknown; detail?: unknown; status?: unknown }

function problemText(body: string): string {
  try {
    const p = JSON.parse(body) as ProblemJson | null;
    if (p !== null && typeof p === "object") {
      const parts = [p.title, p.detail].filter((x): x is string => typeof x === "string" && x !== "");
      if (parts.length > 0) return parts.join(": ");
    }
  } catch { /* not JSON — the raw text is used */ }
  return body.slice(0, 300);
}

/** api.qfex.* (trading / account REST): 401 → SIGNATURE_FAILED, 403 → POLICY_DENIED, 429 → RATE_LIMITED, 5xx → EXCHANGE_ERROR. */
export function qfexRestError(method: string, path: string, httpStatus: number, body: string): PerpError {
  const text = problemText(body);
  const at = `[${method} ${path}, HTTP ${httpStatus}]`;
  const base = { exchange: "qfex", httpStatus };
  if (httpStatus === 401) {
    return new PerpError("SIGNATURE_FAILED", `QFEX: ${text} ${at}`, {
      ...base, remediation: "Check the system clock (QFEX accepts ±5 minutes) and that the key was not revoked; re-import: perp wallet agent import qfex --replace",
    });
  }
  if (httpStatus === 403) return new PerpError("POLICY_DENIED", `QFEX: ${text} ${at}`, { ...base, remediation: KEY_PERMISSION_REMEDIATION });
  if (httpStatus === 404) return new PerpError("EXCHANGE_ERROR", `QFEX: ${text} ${at}`, base);
  if (httpStatus === 429) return new PerpError("RATE_LIMITED", `QFEX: ${text} ${at}`, { ...base, remediation: CODE_REMEDIATION.RATE_LIMITED });
  if (httpStatus >= 400 && httpStatus < 500) return new PerpError("INVALID_PARAMS", `QFEX: ${text} ${at}`, base);
  return new PerpError("EXCHANGE_ERROR", `QFEX: ${text} ${at}`, base);
}

/**
 * banker.qfex.* (deposit address / withdraw), docs programmatic-funding "Errors":
 *   400 invalid amount / address / network, or insufficient withdrawable balance → definite refusal;
 *   401 missing / invalid authentication OR terms not accepted → by body;
 *   403 key lacks "Deposit and withdraw", or the account cannot use funding;
 * The official CLI README adds that withdrawals need 2FA and cannot be started from a CLI, so a
 * refusal here is expected for many accounts.
 */
export function qfexBankerError(method: string, path: string, httpStatus: number, body: string): PerpError {
  const text = problemText(body);
  const at = `[${method} ${path}, HTTP ${httpStatus}]`;
  const base = { exchange: "qfex", httpStatus };
  const website = "QFEX documents that withdrawals need two-factor authentication on the web app; if the API refuses, withdraw there";
  if (httpStatus === 400) {
    const insufficient = /insufficient|withdrawable|balance/i.test(text);
    return new PerpError(insufficient ? "INSUFFICIENT_BALANCE" : "ACTION_REJECTED", `QFEX funding refused: ${text} ${at}`, {
      ...base, remediation: insufficient
        ? "The amount exceeds the Withdrawable Balance (cash + realised PnL + min(unrealised PnL, 0) − 1.05 × margin) — lower it or free margin"
        : `Nothing was executed. Check the amount, address and network (ARBITRUM_ONE). ${website}`,
    });
  }
  if (httpStatus === 401) {
    const terms = /terms|t&c|tnc|agreement|conditions/i.test(text);
    return new PerpError(terms ? "POLICY_DENIED" : "SIGNATURE_FAILED", `QFEX funding: ${text} ${at}`, {
      ...base, remediation: terms
        ? "Accept the latest QFEX terms on the website, then retry"
        : "Authentication was refused: check the system clock and the key (perp wallet agent import qfex --replace). Nothing was executed",
    });
  }
  if (httpStatus === 403) {
    return new PerpError("POLICY_DENIED", `QFEX funding: ${text} ${at}`, {
      ...base, remediation: `The key needs the "Deposit and withdraw" permission (only "All accounts" keys can have it), or the account cannot use funding. ${website}`,
    });
  }
  if (httpStatus === 429) return new PerpError("RATE_LIMITED", `QFEX funding: ${text} ${at}`, { ...base, remediation: CODE_REMEDIATION.RATE_LIMITED });
  if (httpStatus >= 400 && httpStatus < 500) return new PerpError("ACTION_REJECTED", `QFEX funding refused: ${text} ${at}`, base);
  return new PerpError("EXCHANGE_ERROR", `QFEX funding: ${text} ${at}`, base);
}
