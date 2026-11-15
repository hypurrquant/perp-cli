/**
 * Shared HTTP transport: a `fetch` that cannot hang.
 *
 * Transport only — signing, headers, body encoding and response / error classification stay
 * with each caller. It calls the global `fetch` with the caller's url and init unchanged
 * (plus a `signal`), so stubbed / recorded fetches match exactly as before.
 *
 * When the deadline passes the request (or the body read that follows) rejects with a
 * `DOMException` named "TimeoutError" — the same error `AbortSignal.timeout` produces, so the
 * existing classification applies unchanged: a read surfaces it as TIMEOUT (classifyError), and
 * a write request that is already on the wire maps to the unknown outcome
 * (isTransportFailure → sendFailure → ORDER_PENDING, "do NOT resubmit"). Nothing is retried.
 */

/** Default deadline for a venue HTTP request without its own: the value the GRVT / TxFlow / Lighter sendTx clients use. */
export const HTTP_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  input: string | URL,
  init: Omit<RequestInit, "signal"> = {},
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Promise<Response> {
  const ctl = new AbortController();
  // A global setTimeout (not AbortSignal.timeout) so tests can drive it with fake timers. It is
  // not cleared on success: the deadline also covers reading the body; unref() keeps it from
  // holding the process open.
  const timer = setTimeout(() => ctl.abort(new DOMException(`HTTP request timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    return await fetch(input, { ...init, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
