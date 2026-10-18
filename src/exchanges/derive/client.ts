/**
 * Derive (derive.xyz, formerly Lyra) v3 public JSON-RPC over HTTP — official API, no auth.
 *
 *  - `POST <base>/public/<method>` with the params object as the body → `{id, result}` or
 *    `{id, error: {code, message, data}}` (docs.derive.xyz/error-codes.md; live 2026-10-18).
 *  - Errors are all PerpErrors: transport failure → EXCHANGE_UNREACHABLE; HTTP 429 or RPC
 *    -32000..-32099 (rate limit, `data` "Retry after {ms} ms") → RATE_LIMITED; JSON-RPC request
 *    errors (-32700 / -32600 / -32601 / -32602) → INVALID_PARAMS; any other RPC error → EXCHANGE_ERROR.
 *    Every RPC error carries `details.rpcCode` / `rpcData` so callers can classify the venue code
 *    (12001 instrument_not_found → SYMBOL_NOT_FOUND is done by the caller, which knows what was asked).
 *  - Public budget (docs rate-limits.md, mainnet reference): 5 TPS per IP, fixed 5 s window of 25
 *    points, 1 point per request. The local bucket stays under it (4/s, burst 10).
 */

import { PerpError, extractErrorMessage } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";
import type { Network } from "../venue-types.js";

export const DERIVE_REST_URLS: Readonly<Record<Network, string>> = {
  mainnet: "https://api.derive.xyz/v3",
  testnet: "https://testnet.api.derive.xyz/v3",
};

export const DERIVE_HTTP_TIMEOUT_MS = 15_000;
export const DERIVE_RATE_LIMIT: RateLimitPolicy = { capacity: 10, refillPerSec: 4, weights: null };

/** Derive application code for an unknown instrument / currency (`instrument_not_found`). */
export const DERIVE_INSTRUMENT_NOT_FOUND = 12001;

/** Shape drift: an explicit EXCHANGE_ERROR, never a guessed value. */
export function deriveShapeError(what: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `Derive API returned an unexpected shape: ${what}`, {
    exchange: "derive",
    remediation: "Derive's v3 API response changed; perp-cli needs an update to read it",
  });
}

/** The RPC error code a Derive call failed with, or null (not an RPC error). */
export function deriveRpcCode(e: unknown): number | null {
  if (!(e instanceof PerpError)) return null;
  const code = e.structured.details?.rpcCode;
  return typeof code === "number" ? code : null;
}

export class DeriveClient {
  constructor(
    readonly network: Network,
    private readonly baseUrl: string = DERIVE_REST_URLS[network],
    private readonly rateLimit: RateLimitPolicy = DERIVE_RATE_LIMIT,
  ) {}

  /** `public/<method>`; resolves with `result`, every failure is a PerpError. */
  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    await acquireRate(`derive:${this.baseUrl}`, this.rateLimit, method);
    const what = `Derive public/${method}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/public/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(DERIVE_HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `${what}: ${extractErrorMessage(e)}`, { exchange: "derive" });
    }
    const text = await res.text().catch((e: unknown) => {
      throw new PerpError("EXCHANGE_UNREACHABLE", `${what}: response body unreadable (${extractErrorMessage(e)})`, { exchange: "derive" });
    });
    if (res.status === 429) throw rateLimitedError("derive", res.headers.get("retry-after"), text);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const rpcError = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    if (rpcError !== undefined && rpcError !== null) throw rpcErrorOf(what, rpcError);
    if (!res.ok) {
      throw new PerpError("EXCHANGE_ERROR", `${what}: HTTP ${res.status} ${text.slice(0, 200)}`, { exchange: "derive", status: res.status });
    }
    if (body === undefined) throw deriveShapeError(`${method} returned a non-JSON body`);
    if (body === null || typeof body !== "object" || !("result" in body)) throw deriveShapeError(`${method} returned no result`);
    return (body as { result: T }).result;
  }
}

function rpcErrorOf(what: string, err: unknown): PerpError {
  if (err === null || typeof err !== "object") return deriveShapeError(`${what}: error is not an object`);
  const { code, message, data } = err as { code?: unknown; message?: unknown; data?: unknown };
  if (typeof code !== "number" || typeof message !== "string") return deriveShapeError(`${what}: error without code / message`);
  const detail = typeof data === "string" && data !== "" && data !== message ? `${message} (${data})` : message;
  if (code <= -32000 && code >= -32099) {
    const m = typeof data === "string" ? /Retry after (\d+) ?ms/i.exec(data) : null;
    return new PerpError("RATE_LIMITED", `${what}: ${detail}`, {
      exchange: "derive", rpcCode: code,
      ...(m !== null ? { retryAfterMs: Number(m[1]) } : {}),
      remediation: "Derive's public budget is 5 requests/s per IP; wait and retry",
    });
  }
  const rpc = { exchange: "derive", rpcCode: code, rpcData: typeof data === "string" ? data : null };
  // JSON-RPC request errors (parse / invalid request / method / params): retrying the same call cannot help.
  if (code === -32700 || code === -32600 || code === -32601 || code === -32602) {
    return new PerpError("INVALID_PARAMS", `${what}: ${detail} [code ${code}]`, rpc);
  }
  return new PerpError("EXCHANGE_ERROR", `${what}: ${detail} [code ${code}]`, rpc);
}
