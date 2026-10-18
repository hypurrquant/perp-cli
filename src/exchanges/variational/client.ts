/**
 * Variational transport — the OFFICIAL read-only API (docs.variational.io/technical-documentation/api).
 *
 * One endpoint, `GET <rest>/metadata/v2/stats`, serves every market. Limits (documented): 10
 * requests / 10 s per IP, 1000 / min globally, shared with the legacy v1 endpoint; over the limit
 * the venue answers HTTP 429 with a JSON body whose `retry_after_seconds` says when to retry.
 * Every request first takes a token from the per-process limiter (venue rateLimit policy).
 */

import { PerpError, extractErrorMessage } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";

export const VARIATIONAL_HTTP_TIMEOUT_MS = 15_000;
export const VARIATIONAL_STATS_PATH = "/metadata/v2/stats";

/** Payload drift in the documented API: an explicit EXCHANGE_ERROR, never a guessed value. */
export function variationalShapeError(what: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `Variational ${VARIATIONAL_STATS_PATH} shape changed: ${what}`, {
    exchange: "variational",
    remediation: "Variational's stats payload no longer matches its documentation (docs.variational.io/technical-documentation/api); perp-cli needs an update to read it",
  });
}

/** `retry_after_seconds` from a 429 body (documented), else the Retry-After header. */
function retryAfterOf(res: Response, parsed: unknown): string | null {
  const v = (parsed as { retry_after_seconds?: unknown } | null)?.retry_after_seconds;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return res.headers.get("retry-after");
}

export class VariationalClient {
  constructor(
    private readonly restUrl: string,
    private readonly rateLimit: RateLimitPolicy,
  ) {}

  /** GET /metadata/v2/stats. Returns the parsed body; every error path is a PerpError. */
  async stats(): Promise<unknown> {
    await acquireRate("variational", this.rateLimit, VARIATIONAL_STATS_PATH);
    let res: Response;
    try {
      res = await fetch(`${this.restUrl}${VARIATIONAL_STATS_PATH}`, { signal: AbortSignal.timeout(VARIATIONAL_HTTP_TIMEOUT_MS) });
    } catch (e) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `Variational stats: ${extractErrorMessage(e)}`, { exchange: "variational" });
    }
    const text = await res.text().catch((e: unknown) => {
      throw new PerpError("EXCHANGE_UNREACHABLE", `Variational stats: response body unreadable (${extractErrorMessage(e)})`, { exchange: "variational" });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (res.status === 429) throw rateLimitedError("variational", retryAfterOf(res, parsed), text);
    if (!res.ok) {
      throw new PerpError("EXCHANGE_ERROR", `Variational stats: HTTP ${res.status} ${text.slice(0, 200)}`, {
        exchange: "variational", status: res.status,
        remediation: "Variational's public stats API answered with an error; retry later",
      });
    }
    if (parsed === undefined) throw variationalShapeError("response is not JSON");
    return parsed;
  }
}
