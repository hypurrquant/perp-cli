/**
 * perp-cli/ws error leaf module (no imports). `WsErrorCode` ⊂ the CLI's `ErrorCode`; status and
 * retryable match src/errors.ts ERROR_CODES (parity test). The CLI's classifyError accepts a
 * WsError structurally (isPerpError).
 */

export const WS_ERROR_CODES = {
  WS_PROTOCOL_ERROR: { status: 502, retryable: false },
  WS_AUTH_FAILED: { status: 401, retryable: false },
  SUBSCRIPTION_LIMIT: { status: 400, retryable: false },
  STREAM_OVERFLOW: { status: 507, retryable: false },
  CAPABILITY_UNSUPPORTED: { status: 400, retryable: false },
  EXCHANGE_UNREACHABLE: { status: 503, retryable: true },
  INVALID_PARAMS: { status: 400, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  EXCHANGE_ERROR: { status: 502, retryable: true },
  SYMBOL_NOT_FOUND: { status: 404, retryable: false },
} as const;

export type WsErrorCode = keyof typeof WS_ERROR_CODES;

export interface WsStructuredError {
  code: WsErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  exchange?: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export class WsError extends Error {
  readonly structured: WsStructuredError;

  constructor(code: WsErrorCode, message: string, opts?: { exchange?: string; remediation?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = "WsError";
    this.structured = {
      code,
      message,
      status: WS_ERROR_CODES[code].status,
      retryable: WS_ERROR_CODES[code].retryable,
      ...(opts?.exchange !== undefined ? { exchange: opts.exchange } : {}),
      ...(opts?.remediation !== undefined ? { remediation: opts.remediation } : {}),
      ...(opts?.details !== undefined ? { details: opts.details } : {}),
    };
  }

  /** `structured.code` — the same place as `code` on error events (`e.code`). */
  get code(): WsErrorCode {
    return this.structured.code;
  }

  /** `structured.remediation` — the same place as `remediation` on error events; null when none. */
  get remediation(): string | null {
    return this.structured.remediation === undefined ? null : this.structured.remediation;
  }
}

/** Structural check: a PerpError (CLI) or a WsError — anything carrying `structured.{code,message}`. */
export function isPerpError(e: unknown): e is { structured: { code: string; message: string } } {
  if (e === null || typeof e !== "object") return false;
  const s = (e as { structured?: unknown }).structured;
  if (s === null || typeof s !== "object") return false;
  return typeof (s as { code?: unknown }).code === "string" && typeof (s as { message?: unknown }).message === "string";
}
