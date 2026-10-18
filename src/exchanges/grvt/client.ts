/**
 * GRVT Market Data REST transport (official API, api-docs.grvt.io/market_data_api/).
 *
 *  - `POST <rest>/full/v1/<endpoint>` with a JSON body; success is `{result: …}` (`margin_rules`
 *    answers its object unwrapped), an error is `{code, message, status}` with the HTTP status
 *    (1003/400 malformed — also what an unknown instrument gets —, 1004/404 not found, 1006/429
 *    rate limit, 1002/500 internal).
 *  - Rate limits (help.grvt.io): Ticker / MiniTicker / GetInstrument 1500 per minute, everything
 *    else 500 per minute — two token buckets per network (venues/grvt.ts).
 *  - No retries, no fallback: every failure is a PerpError.
 */

import { PerpError, extractErrorMessage } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { Network } from "../venue-types.js";
import { GRVT_OTHER_RATE_LIMIT, GRVT_TICKER_RATE_LIMIT } from "../venues/grvt.js";

export const GRVT_HTTP_TIMEOUT_MS = 15_000;

/** Endpoints in the 1500 / min bucket. */
const TICKER_BUCKET: ReadonlySet<string> = new Set(["ticker", "mini", "instrument"]);

/** Response of an unexpected shape: an explicit EXCHANGE_ERROR, never a guessed value. */
export function grvtShapeError(what: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `GRVT market data: unexpected response — ${what}`, {
    exchange: "grvt",
    remediation: "GRVT's market-data response did not match its documented schema (api-docs.grvt.io); perp-cli needs an update to read it",
  });
}

function errorBodyOf(parsed: unknown): { code: number | null; message: string } | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as { code?: unknown; message?: unknown };
  if (typeof p.message !== "string") return null;
  return { code: typeof p.code === "number" ? p.code : null, message: p.message };
}

export class GrvtClient {
  constructor(
    private readonly restUrl: string,
    private readonly network: Network,
  ) {}

  /** POST /full/v1/<endpoint>. Returns the parsed body; every error path is a PerpError. */
  async post<T = unknown>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const ticker = TICKER_BUCKET.has(endpoint);
    await acquireRate(`grvt:${ticker ? "ticker" : "other"}:${this.network}`, ticker ? GRVT_TICKER_RATE_LIMIT : GRVT_OTHER_RATE_LIMIT, endpoint);
    let res: Response;
    try {
      res = await fetch(`${this.restUrl}/full/v1/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GRVT_HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `GRVT ${endpoint}: ${extractErrorMessage(e)}`, { exchange: "grvt" });
    }
    const text = await res.text().catch((e: unknown) => {
      throw new PerpError("EXCHANGE_UNREACHABLE", `GRVT ${endpoint}: response body unreadable (${extractErrorMessage(e)})`, { exchange: "grvt" });
    });
    if (res.status === 429) throw rateLimitedError("grvt", res.headers.get("retry-after"), text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const err = errorBodyOf(parsed);
      const msg = err !== null ? `${err.code ?? "?"} ${err.message}` : text.slice(0, 200);
      throw new PerpError(res.status >= 500 ? "EXCHANGE_UNREACHABLE" : "EXCHANGE_ERROR", `GRVT ${endpoint}: HTTP ${res.status} ${msg}`, {
        exchange: "grvt", status: res.status,
      });
    }
    if (parsed === undefined) throw grvtShapeError(`${endpoint} returned a non-JSON body`);
    return parsed as T;
  }

  /** POST and unwrap `{result}` (every market-data endpoint except margin_rules). */
  async result<T = unknown>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.post<{ result?: unknown }>(endpoint, body);
    if (res === null || typeof res !== "object" || !("result" in res)) throw grvtShapeError(`${endpoint} has no result`);
    return res.result as T;
  }
}
