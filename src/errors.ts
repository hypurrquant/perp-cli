/** All structured error codes for the CLI */
export const ERROR_CODES = {
  // 4xx - Client / user errors
  INVALID_PARAMS: { code: "INVALID_PARAMS", status: 400, retryable: false },
  SYMBOL_NOT_FOUND: { code: "SYMBOL_NOT_FOUND", status: 404, retryable: false },
  ORDER_NOT_FOUND: { code: "ORDER_NOT_FOUND", status: 404, retryable: false },
  POSITION_NOT_FOUND: { code: "POSITION_NOT_FOUND", status: 404, retryable: false },
  INSUFFICIENT_BALANCE: { code: "INSUFFICIENT_BALANCE", status: 400, retryable: false },
  MARGIN_INSUFFICIENT: { code: "MARGIN_INSUFFICIENT", status: 400, retryable: false },
  SIZE_TOO_SMALL: { code: "SIZE_TOO_SMALL", status: 400, retryable: false },
  SIZE_TOO_LARGE: { code: "SIZE_TOO_LARGE", status: 400, retryable: false },
  RISK_VIOLATION: { code: "RISK_VIOLATION", status: 403, retryable: false },
  DUPLICATE_ORDER: { code: "DUPLICATE_ORDER", status: 409, retryable: false },
  DEPOSIT_REQUIRED: { code: "DEPOSIT_REQUIRED", status: 403, retryable: false },

  // Agent-wallet error codes (OWS / Phase 2a)
  NO_SIGNER_AVAILABLE:  { code: "NO_SIGNER_AVAILABLE",  status: 401, retryable: false },
  AGENT_NOT_REGISTERED: { code: "AGENT_NOT_REGISTERED", status: 401, retryable: false },
  AGENT_EXPIRED:        { code: "AGENT_EXPIRED",        status: 401, retryable: false },
  POLICY_DENIED:        { code: "POLICY_DENIED",        status: 403, retryable: false },
  KEY_NOT_FOUND:        { code: "KEY_NOT_FOUND",        status: 404, retryable: false },
  WALLET_LOCKED:        { code: "WALLET_LOCKED",        status: 423, retryable: false },
  APPROVE_PARTIAL:      { code: "APPROVE_PARTIAL",      status: 500, retryable: false },
  APPROVE_FAILED:       { code: "APPROVE_FAILED",       status: 500, retryable: false },
  LOCK_HELD:            { code: "LOCK_HELD",            status: 423, retryable: true, retryAfterMs: 5000 },
  PASSPHRASE_REQUIRED:  { code: "PASSPHRASE_REQUIRED",  status: 401, retryable: false },
  INVALID_PASSPHRASE:   { code: "INVALID_PASSPHRASE",   status: 401, retryable: false },
  NOT_IMPLEMENTED:      { code: "NOT_IMPLEMENTED",      status: 501, retryable: false },

  // Venue abstraction
  UNKNOWN_VENUE:        { code: "UNKNOWN_VENUE",        status: 400, retryable: false },
  TIF_REQUIRED:         { code: "TIF_REQUIRED",         status: 400, retryable: false },
  INVALID_TICK:         { code: "INVALID_TICK",         status: 400, retryable: false },
  NO_ENV_TIER:          { code: "NO_ENV_TIER",          status: 401, retryable: false },
  NO_BRIDGE_ROUTE:      { code: "NO_BRIDGE_ROUTE",      status: 400, retryable: false },
  CAPABILITY_UNSUPPORTED: { code: "CAPABILITY_UNSUPPORTED", status: 400, retryable: false },
  /** Part of a multi-leg placement was accepted and part failed; retrying would duplicate the accepted legs. */
  ORDER_PARTIAL:        { code: "ORDER_PARTIAL",        status: 500, retryable: false },
  /** The order was submitted but its outcome is not confirmed; retrying could double-trade. */
  ORDER_PENDING:        { code: "ORDER_PENDING",        status: 202, retryable: false },
  /** The order was definitely NOT placed: the venue rejected it, or it failed before it was sent. */
  ORDER_REJECTED:       { code: "ORDER_REJECTED",       status: 422, retryable: false },
  /**
   * The venue explicitly refused a non-order account action (withdraw / transfer / approval) and
   * executed nothing — distinct from a network / unknown outcome (EXCHANGE_ERROR, UNKNOWN).
   */
  ACTION_REJECTED:      { code: "ACTION_REJECTED",      status: 422, retryable: false },

  // WebSocket library (perp-cli/ws, src/ws/errors.ts keeps a parity-tested copy)
  /** A venue frame could not be parsed or classified (never silently dropped). */
  WS_PROTOCOL_ERROR:    { code: "WS_PROTOCOL_ERROR",    status: 502, retryable: false },
  WS_AUTH_FAILED:       { code: "WS_AUTH_FAILED",       status: 401, retryable: false },
  /** A subscription / connection budget (venue limit or caller budget) would be exceeded. */
  SUBSCRIPTION_LIMIT:   { code: "SUBSCRIPTION_LIMIT",   status: 400, retryable: false },
  /** An event stream's bounded buffer overflowed; the subscription was closed. */
  STREAM_OVERFLOW:      { code: "STREAM_OVERFLOW",      status: 507, retryable: false },

  // 5xx - System / transient errors
  EXCHANGE_UNREACHABLE: { code: "EXCHANGE_UNREACHABLE", status: 503, retryable: true },
  RATE_LIMITED: { code: "RATE_LIMITED", status: 429, retryable: true, retryAfterMs: 1000 },
  PRICE_STALE: { code: "PRICE_STALE", status: 503, retryable: true },
  SIGNATURE_FAILED: { code: "SIGNATURE_FAILED", status: 500, retryable: false },
  EXCHANGE_ERROR: { code: "EXCHANGE_ERROR", status: 502, retryable: true },
  TIMEOUT: { code: "TIMEOUT", status: 504, retryable: true },
  UNKNOWN: { code: "UNKNOWN", status: 500, retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface StructuredError {
  code: ErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  retryAfterMs?: number;
  exchange?: string;
  details?: Record<string, unknown>;
  /** Actionable hint for automated callers (AC-19) */
  remediation?: string;
}

/**
 * Extract a human-readable message from any thrown value.
 * Handles Error instances, plain objects with a `.message` field (string OR object),
 * and circular-safe stringification fallback.
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
    if (m !== undefined) {
      try { return JSON.stringify(m); } catch { /* circular */ }
    }
    try { return JSON.stringify(err); } catch { /* circular */ }
  }
  return String(err);
}

/**
 * Classify an error from any exchange into a structured error code.
 *
 * If the input is already a PerpError, return its structured payload verbatim
 * — the typed code and remediation are the source of truth and must not be
 * re-derived from message text. Pattern-matching only kicks in for plain
 * Error instances or unknown thrown values. Codex v0.12.12 final QA #2.
 */
export function classifyError(err: unknown, exchange?: string): StructuredError {
  if (err instanceof PerpError) {
    // Preserve the PerpError's typed shape; only fill in `exchange` if the
    // caller provided one and the error didn't already attach it.
    const ex = (err.structured.exchange ?? exchange);
    return ex !== undefined ? { ...err.structured, exchange: ex } : { ...err.structured };
  }
  // Structural PerpError (perp-cli/ws WsError is a separate leaf class): keep its registered code.
  if (err instanceof Error && isStructuredLike(err)) {
    const s = err.structured;
    const ex = s.exchange ?? exchange;
    return ex !== undefined ? { ...s, exchange: ex } : { ...s };
  }
  const message = extractErrorMessage(err);
  const lower = message.toLowerCase();

  // Margin-specific checks first (before generic "insufficient" catch)
  if (lower.includes("margin") && (lower.includes("insufficient") || lower.includes("not enough"))) {
    return { ...ERROR_CODES.MARGIN_INSUFFICIENT, message, exchange };
  }
  if (lower.includes("insufficient") || lower.includes("not enough") || lower.includes("balance")) {
    return { ...ERROR_CODES.INSUFFICIENT_BALANCE, message, exchange };
  }
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many request")) {
    return { ...ERROR_CODES.RATE_LIMITED, message, exchange };
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch failed") || lower.includes("network")) {
    return { ...ERROR_CODES.EXCHANGE_UNREACHABLE, message, exchange };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return { ...ERROR_CODES.TIMEOUT, message, exchange };
  }
  // OWS / agent-wallet specific matchers — MUST precede generic "sign" / "not found" blocks
  // so "wallet is locked, cannot sign" → WALLET_LOCKED (not SIGNATURE_FAILED)
  // and "key not found" → KEY_NOT_FOUND (not SYMBOL_NOT_FOUND / default)
  if (lower.includes("policy denied") || (lower.includes("policy") && lower.includes("denied"))) {
    return { ...ERROR_CODES.POLICY_DENIED, message, exchange };
  }
  if (lower.includes("wallet is locked") || lower.includes("wallet locked")) {
    return { ...ERROR_CODES.WALLET_LOCKED, message, exchange };
  }
  if (lower.includes("key not found") || lower.includes("api key not found")) {
    return { ...ERROR_CODES.KEY_NOT_FOUND, message, exchange };
  }
  if (lower.includes("no signer") || lower.includes("signer unavailable") || lower.includes("no auth")) {
    return { ...ERROR_CODES.NO_SIGNER_AVAILABLE, message, exchange };
  }
  if (lower.includes("agent not registered")) {
    return { ...ERROR_CODES.AGENT_NOT_REGISTERED, message, exchange };
  }
  if (lower.includes("agent expired") || lower.includes("agent has expired")) {
    return { ...ERROR_CODES.AGENT_EXPIRED, message, exchange };
  }
  if (lower.includes("lock held") || lower.includes("lockfile held")) {
    return { ...ERROR_CODES.LOCK_HELD, message, exchange };
  }
  if (lower.includes("passphrase required") || lower.includes("passphrase missing")) {
    return { ...ERROR_CODES.PASSPHRASE_REQUIRED, message, exchange };
  }
  // OWS vault decrypt failure (NAPI binding throws "decryption failed: aead::Error"
  // when the AEAD tag check fails — wrong passphrase or tampered ciphertext).
  // Distinct from PASSPHRASE_REQUIRED (which means no passphrase was supplied):
  // here a passphrase WAS supplied but did not unlock the vault.
  if (lower.includes("aead::error") || lower.includes("decryption failed") || lower.includes("decryption error")) {
    return {
      ...ERROR_CODES.INVALID_PASSPHRASE,
      message,
      exchange,
      remediation: "Re-check OWS passphrase. Confirm with: perp --json wallet show --passphrase $PP. If wallet was rekeyed, restore from backup or re-import.",
    };
  }
  if (lower.includes("partial") && (lower.includes("approve") || lower.includes("approval"))) {
    return { ...ERROR_CODES.APPROVE_PARTIAL, message, exchange };
  }
  if (lower.includes("approve_failed") || (lower.includes("approve failed") && lower.includes("clean"))) {
    return { ...ERROR_CODES.APPROVE_FAILED, message, exchange };
  }

  // Aster V3 gates every authenticated endpoint behind a first main-wallet
  // deposit as of 2026-09-01 (venue code -5050 DEPOSIT_REQUIRED, message
  // "This function can only be used after deposit."). Without this branch the
  // message falls through to a bare EXCHANGE_ERROR and the user never learns
  // that a deposit — not a key/permission problem — is what blocks them. The
  // agent-wallet and builder endpoints are exempt, so onboarding succeeds and
  // the first read is what fails.
  if (lower.includes("after deposit") || lower.includes("deposit_required") || lower.includes("-5050")) {
    return {
      ...ERROR_CODES.DEPOSIT_REQUIRED,
      message,
      exchange,
      remediation:
        "This venue requires a completed deposit to the main wallet before any authenticated endpoint works. " +
        "Deposit with: perp funds deposit aster <amount> (USDT on BNB Chain; --chain arbitrum / --asset USDC also work), " +
        "or from the exchange UI, then retry. Public market data and agent-wallet setup are unaffected.",
    };
  }

  // Aster -4061: the account is in Hedge Mode, where `positionSide` is
  // mandatory and `reduceOnly` is forbidden. This adapter always sends one-way
  // shape, so every order is rejected until the account switches back. Without
  // this branch the user sees a bare "position side does not match" with no
  // indication that the ACCOUNT MODE is the thing to change.
  if (lower.includes("-4061") || lower.includes("position side does not match") || lower.includes("position_side_not_match")) {
    return {
      ...ERROR_CODES.INVALID_PARAMS,
      message,
      exchange,
      remediation:
        "The account appears to be in Hedge Mode, which this adapter does not support (it sends one-way orders). " +
        "Switch to One-way Mode in the exchange UI, or via POST /fapi/v3/positionSide/dual with dualSidePosition=false, then retry.",
    };
  }

  if (lower.includes("not found") && (lower.includes("symbol") || lower.includes("market") || lower.includes("asset"))) {
    return { ...ERROR_CODES.SYMBOL_NOT_FOUND, message, exchange };
  }
  if (lower.includes("order") && lower.includes("not found")) {
    return { ...ERROR_CODES.ORDER_NOT_FOUND, message, exchange };
  }
  if (lower.includes("position") && lower.includes("not found")) {
    return { ...ERROR_CODES.POSITION_NOT_FOUND, message, exchange };
  }
  if (lower.includes("too small") || lower.includes("minimum") || lower.includes("below min")) {
    return { ...ERROR_CODES.SIZE_TOO_SMALL, message, exchange };
  }
  if (lower.includes("too large") || lower.includes("maximum") || lower.includes("exceeds max")) {
    return { ...ERROR_CODES.SIZE_TOO_LARGE, message, exchange };
  }
  if (lower.includes("signature") || lower.includes("signing") || lower.includes("sign")) {
    return { ...ERROR_CODES.SIGNATURE_FAILED, message, exchange };
  }
  if (lower.includes("duplicate") || lower.includes("already exists")) {
    return { ...ERROR_CODES.DUPLICATE_ORDER, message, exchange };
  }
  if (lower.includes("risk") || lower.includes("violation")) {
    return { ...ERROR_CODES.RISK_VIOLATION, message, exchange };
  }

  // Default: exchange error if we know the exchange, unknown otherwise
  if (exchange) {
    return { ...ERROR_CODES.EXCHANGE_ERROR, message, exchange };
  }
  return { ...ERROR_CODES.UNKNOWN, message };
}

function isStructuredLike(err: Error): err is Error & { structured: StructuredError } {
  const s = (err as { structured?: unknown }).structured;
  if (s === null || typeof s !== "object") return false;
  const { code, message, status, retryable } = s as Record<string, unknown>;
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, code)
    && typeof message === "string" && typeof status === "number" && typeof retryable === "boolean";
}

/** Custom error class that carries a structured error code */
export class PerpError extends Error {
  public readonly structured: StructuredError;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PerpError";
    // Lift `remediation` from details to top-level StructuredError field (AC-19)
    const remediation = details?.remediation as string | undefined;
    const strippedDetails = details ? { ...details } : undefined;
    if (strippedDetails) delete strippedDetails.remediation;
    this.structured = {
      ...ERROR_CODES[code],
      message,
      ...(remediation !== undefined ? { remediation } : {}),
      ...(strippedDetails && Object.keys(strippedDetails).length > 0 ? { details: strippedDetails } : {}),
    };
  }
}

// ── Order outcome classification ──

/**
 * Codes that mean "the order was definitely not placed / filled nothing": a validation
 * or policy failure before sending (incl. PRICE_STALE: no price to build the order), or an
 * explicit venue rejection. Every other code
 * (EXCHANGE_UNREACHABLE, TIMEOUT, EXCHANGE_ERROR, RATE_LIMITED, UNKNOWN, …) raised by
 * an order call leaves the outcome unknown.
 */
export const DEFINITE_ORDER_FAILURE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "INVALID_PARAMS", "SYMBOL_NOT_FOUND", "INSUFFICIENT_BALANCE", "MARGIN_INSUFFICIENT",
  "SIZE_TOO_SMALL", "SIZE_TOO_LARGE", "RISK_VIOLATION", "DEPOSIT_REQUIRED",
  "NO_SIGNER_AVAILABLE", "AGENT_NOT_REGISTERED", "AGENT_EXPIRED", "POLICY_DENIED",
  "KEY_NOT_FOUND", "WALLET_LOCKED", "PASSPHRASE_REQUIRED", "INVALID_PASSPHRASE",
  "NOT_IMPLEMENTED", "UNKNOWN_VENUE", "TIF_REQUIRED", "INVALID_TICK",
  "NO_ENV_TIER", "CAPABILITY_UNSUPPORTED", "SIGNATURE_FAILED", "ORDER_REJECTED", "ACTION_REJECTED",
  // No usable price to build/check the order — raised only before an order is sent.
  "PRICE_STALE",
]);

/**
 * true when `e` is a PerpError that says the order was definitely not placed: by its code, or —
 * whatever the code — by `details.sent === false`, the thrower's explicit statement that it
 * refused locally and sent nothing (QFEX: POSITION_NOT_FOUND from the pre-send position read).
 * POSITION_NOT_FOUND is deliberately NOT in DEFINITE_ORDER_FAILURE_CODES: classifyError() also
 * derives it from free message text ("position" + "not found"), and Aster / Lighter test such
 * derived codes against the set — a text match is not proof that nothing was placed.
 */
export function isDefiniteOrderFailure(e: unknown): boolean {
  if (!(e instanceof PerpError)) return false;
  return DEFINITE_ORDER_FAILURE_CODES.has(e.structured.code) || e.structured.details?.sent === false;
}

/**
 * Failure BEFORE an order was sent (resolution, validation, pricing, nonce, signing):
 * definitely not placed. A PerpError that already carries a definite code is kept.
 */
export function orderNotSent(venue: string, what: string, e: unknown): PerpError {
  // By CODE only: a not-sent error with a retryable code (TIMEOUT / EXCHANGE_UNREACHABLE with
  // details.sent === false) is still re-typed, so an order call never surfaces a retryable code.
  if (e instanceof PerpError && DEFINITE_ORDER_FAILURE_CODES.has(e.structured.code)) return e;
  return new PerpError("ORDER_REJECTED", `${venue} ${what} not sent: ${extractErrorMessage(e)}`, { exchange: venue });
}

/**
 * Failure AFTER an order was sent (transport error, timeout, 5xx, unreadable body):
 * the outcome is unknown — ORDER_PENDING (non-retryable, never resubmit).
 */
export function orderOutcomeUnknown(venue: string, what: string, e: unknown, remediation?: string): PerpError {
  if (e instanceof PerpError && e.structured.code === "ORDER_PENDING") return e;
  return new PerpError("ORDER_PENDING", `${venue} ${what}: outcome unknown — ${extractErrorMessage(e)}`, {
    exchange: venue,
    remediation: remediation ?? `Do NOT resubmit — the order may have been placed. Check open orders, balances and positions on ${venue}`,
  });
}

/**
 * A plain Error an adapter throws AFTER the order request reached the venue with an
 * HTTP 5xx: Hyperliquid `HL exchange API error (5xx): …` (exchange POST, unparseable
 * body) and Pacifica `POST <path> failed (5xx): …`. The outcome is unknown, never a
 * rejection.
 */
export function isUnknownOutcomeServerError(e: unknown): boolean {
  if (e instanceof PerpError) return false;
  return /^HL exchange API error \(5\d\d\)|^POST \S+ failed \(5\d\d\)/.test(extractErrorMessage(e));
}

/** A thrown value that looks like a transport failure (fetch/network/timeout/unparseable body). */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof PerpError) return false;
  if (e instanceof TypeError || e instanceof SyntaxError) return true;
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  // "network" alone is NOT a transport signal: definite refusals such as "wrong network" /
  // "unsupported network" mention it too. Only transport phrasings ("network error",
  // "NetworkError when attempting to fetch", "network request failed", …) count.
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|\bnetwork ?(error|request failed|failure|unreachable|is unreachable|connection lost)\b|timed? ?out/i.test(extractErrorMessage(e));
}

const CONNECT_FAILURE_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * A fetch failure where no connection was ever established (DNS failure, connection refused,
 * connect timeout — read from the error's `code` / `cause` chain): the request was not sent.
 */
export function isConnectFailure(e: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (x: unknown): boolean => {
    if (x === null || typeof x !== "object" || seen.has(x)) return false;
    seen.add(x);
    const o = x as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof o.code === "string" && CONNECT_FAILURE_CODES.has(o.code)) return true;
    if (Array.isArray(o.errors) && o.errors.length > 0 && o.errors.every(walk)) return true;
    return walk(o.cause);
  };
  return walk(e);
}

/**
 * Failure of the request that SENDS an order / cancel / withdraw / transfer / leverage change.
 * No connection was established (isConnectFailure) → not sent (definite). Anything else
 * (connection reset, timeout, unreadable body, 5xx) → outcome unknown: ORDER_PENDING, never the
 * retryable EXCHANGE_UNREACHABLE / TIMEOUT. A PerpError that is already definite is kept.
 */
export function sendFailure(venue: string, what: string, e: unknown, remediation?: string): PerpError {
  if (e instanceof PerpError && DEFINITE_ORDER_FAILURE_CODES.has(e.structured.code)) return e;
  if (isDefiniteOrderFailure(e)) return orderNotSent(venue, what, e);
  if (isConnectFailure(e)) return orderNotSent(venue, what, e);
  return orderOutcomeUnknown(venue, what, e, remediation);
}

/** Remediation for an unknown-outcome account action (not an order). */
export function unknownActionRemediation(venue: string, action: string): string {
  return `Do NOT resubmit — the ${action} may have been executed. Check balances, positions and open orders on ${venue} first`;
}

/**
 * Strict positive decimal amount ("10", "10.5"; no sign, exponent, or trailing text — "10abc"
 * and "1e3" are refused). Returns the trimmed string.
 */
export function parsePositiveDecimal(raw: string, what: string): string {
  const s = String(raw).trim();
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s) || !(Number(s) > 0)) {
    throw new PerpError("INVALID_PARAMS", `${what} must be a positive decimal number (got "${raw}")`, {
      remediation: "Pass a plain decimal amount, e.g. 10 or 10.5",
    });
  }
  return s;
}

/**
 * A keyless account read (positions, balance, orders, history): the one typed refusal every venue
 * returns — NO_SIGNER_AVAILABLE with the setup remediation (never an UNKNOWN 500).
 */
export function noAccountKeyError(venue: string): PerpError {
  return new PerpError("NO_SIGNER_AVAILABLE", `${venue}: no account key configured — account data unavailable`, {
    exchange: venue,
    remediation: `Set up an account for ${venue}: perp setup (or perp -e ${venue} wallet show to check)`,
  });
}
