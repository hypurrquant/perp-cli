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
}

/**
 * Classify an error from any exchange into a structured error code.
 * Pattern-matches on error messages to detect known error types.
 */
export function classifyError(err: unknown, exchange?: string): StructuredError {
  const message = err instanceof Error ? err.message : String(err);
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
    this.structured = { ...ERROR_CODES[code], message, details };
  }
}
