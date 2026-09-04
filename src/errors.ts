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
        "Deposit funds from the exchange UI, then retry. Public market data and agent-wallet setup are unaffected.",
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
