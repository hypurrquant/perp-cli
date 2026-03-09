/**
 * Auto-retry middleware for exchange operations.
 * Retries operations that fail with retryable error codes.
 */

import { classifyError, type StructuredError } from "./errors.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";

export interface RetryOptions {
  maxRetries?: number;         // default: 3
  baseDelayMs?: number;        // default: 1000
  maxDelayMs?: number;         // default: 30000
  backoffMultiplier?: number;  // default: 2 (exponential backoff)
  onRetry?: (attempt: number, error: StructuredError, delayMs: number) => void;
}

export interface RetryResult<T> {
  data: T;
  attempts: number;
  totalDelayMs: number;
  retries: { attempt: number; error: StructuredError; delayMs: number }[];
}

/** Error thrown when all retries are exhausted */
export class RetriesExhaustedError extends Error {
  public readonly lastError: StructuredError;
  public readonly attempts: number;
  public readonly retries: { attempt: number; error: StructuredError; delayMs: number }[];

  constructor(
    lastError: StructuredError,
    attempts: number,
    retries: { attempt: number; error: StructuredError; delayMs: number }[],
  ) {
    super(`All ${attempts} attempts failed. Last error: [${lastError.code}] ${lastError.message}`);
    this.name = "RetriesExhaustedError";
    this.lastError = lastError;
    this.attempts = attempts;
    this.retries = retries;
  }
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Apply jitter of +/-20% to a delay value.
 * Returns a value in [delay * 0.8, delay * 1.2].
 */
export function applyJitter(delayMs: number): number {
  const jitterFactor = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.round(delayMs * jitterFactor);
}

/**
 * Compute the delay for a given retry attempt.
 * Uses exponential backoff, respects retryAfterMs from the error code,
 * applies jitter, and caps at maxDelayMs.
 */
export function computeDelay(
  attempt: number,
  error: StructuredError,
  opts: Required<Omit<RetryOptions, "onRetry">>,
): number {
  // Start with exponential backoff: baseDelay * multiplier^(attempt-1)
  let delay = opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1);

  // If the error specifies a retryAfterMs, use the larger of the two
  if (error.retryAfterMs !== undefined) {
    delay = Math.max(delay, error.retryAfterMs);
  }

  // Cap at maxDelayMs
  delay = Math.min(delay, opts.maxDelayMs);

  // Apply jitter
  return applyJitter(delay);
}

/** Internal sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with automatic retry on retryable errors.
 *
 * - On failure, classifies the error via `classifyError`.
 * - If `retryable: true`, waits with exponential backoff and retries.
 * - If `retryable: false`, throws immediately.
 * - Uses `retryAfterMs` from the error code if available (e.g., rate limit = 1000ms).
 * - Caps delay at `maxDelayMs`.
 * - Adds jitter (+/-20%) to prevent thundering herd.
 * - Returns the result with retry metadata.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<RetryResult<T>> {
  const { maxRetries, baseDelayMs, maxDelayMs, backoffMultiplier } = {
    ...DEFAULT_OPTIONS,
    ...opts,
  };
  const resolvedOpts = { maxRetries, baseDelayMs, maxDelayMs, backoffMultiplier };

  const retries: { attempt: number; error: StructuredError; delayMs: number }[] = [];
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const data = await fn();
      return { data, attempts: attempt, totalDelayMs, retries };
    } catch (err) {
      const classified = classifyError(err);

      // Non-retryable error: throw immediately
      if (!classified.retryable) {
        throw err;
      }

      // Out of retries: throw with exhaustion info
      if (attempt > maxRetries) {
        throw new RetriesExhaustedError(classified, attempt, retries);
      }

      const delayMs = computeDelay(attempt, classified, resolvedOpts);

      // Call onRetry callback if provided
      opts?.onRetry?.(attempt, classified, delayMs);

      retries.push({ attempt, error: classified, delayMs });
      totalDelayMs += delayMs;

      await sleep(delayMs);
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error("withRetry: unexpected exit from retry loop");
}

/**
 * Simpler version of withRetry that just returns T (no metadata).
 * For use in places where you just want automatic retry without caring about details.
 */
export async function withRetrySimple<T>(
  fn: () => Promise<T>,
  maxRetries?: number,
): Promise<T> {
  const result = await withRetry(fn, maxRetries !== undefined ? { maxRetries } : undefined);
  return result.data;
}

/**
 * Wrap an ExchangeAdapter so every async method is automatically retried.
 *
 * Returns a Proxy that intercepts property access:
 * - For non-function properties (like `name`), returns the value directly.
 * - For function properties, returns a wrapper that calls `withRetry` around the original method.
 */
export function wrapAdapterWithRetry(
  adapter: ExchangeAdapter,
  opts?: RetryOptions,
): ExchangeAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Pass through non-function properties (e.g., `name` getter)
      if (typeof value !== "function") {
        return value;
      }

      // Wrap function in retry logic
      return async function (...args: unknown[]) {
        const result = await withRetry(
          () => (value as Function).apply(target, args),
          opts,
        );
        return result.data;
      };
    },
  });
}
