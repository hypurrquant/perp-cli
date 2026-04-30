/**
 * Internal HTTP helpers for the public DEX fetchers.
 *
 * SSOT rule #2 boilerplate consolidation: every public fetcher needed the
 * same 5-line "throw on non-2xx with body excerpt" guard. Centralized here
 * so each call site is one assertOk(...) line.
 */

/**
 * Throw if the Response is not OK, with HTTP status + (truncated) body
 * excerpt for diagnostics.
 *
 * Use BEFORE `res.json()` so a 5xx JSON error body cannot fulfill as if it
 * were valid data.
 */
export async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  let body = "";
  try { body = await res.text(); } catch { /* body read failed; surface status alone */ }
  throw new Error(`${label} returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
}
