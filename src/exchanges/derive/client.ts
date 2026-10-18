/**
 * Derive (derive.xyz, formerly Lyra) v3 public JSON-RPC over HTTP — official API, no auth.
 *
 *  - `POST <base>/public/<method>` with the params object as the body → `{id, result}` or
 *    `{id, error: {code, message, data}}` (docs.derive.xyz/error-codes.md; live 2026-10-18).
 *  - Errors are all PerpErrors, each with a remediation: transport failure → EXCHANGE_UNREACHABLE;
 *    HTTP 429 or RPC -32000..-32099 → RATE_LIMITED (retry hint from the RPC `data` "Retry after {ms} ms",
 *    else the `retry-after` header); any other RPC error → EXCHANGE_ERROR. A JSON-RPC -32602 is a
 *    Derive-side rejection too: user input is validated before any request, so it is never reported as
 *    the user's INVALID_PARAMS. Every RPC error carries `details.rpcCode` / `rpcData` so callers can
 *    classify the venue code (12001 instrument_not_found → SYMBOL_NOT_FOUND is done by the caller,
 *    which knows what was asked).
 *  - Public budget (docs rate-limits.md, mainnet reference): 5 TPS per IP, FIXED 5 s window of 25
 *    points, 1 point per request. The local bucket (burst 5, 4/s) allows at most 5 + 4·5 = 25 in any 5 s.
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
export const DERIVE_RATE_LIMIT: RateLimitPolicy = { capacity: 5, refillPerSec: 4, weights: null };

/** Derive application code for an unknown instrument / currency (`instrument_not_found`). */
export const DERIVE_INSTRUMENT_NOT_FOUND = 12001;
/** JSON-RPC invalid params — Derive also uses it for "Ticker not found for instrument" (live 2026-10-18). */
export const DERIVE_INVALID_PARAMS = -32602;

const UNREACHABLE_REMEDIATION = "Check the network / api.derive.xyz status and retry";
const RATE_LIMIT_REMEDIATION = "Derive's public budget is 5 requests/s per IP (25 per 5 s window); wait and retry";

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
      throw new PerpError("EXCHANGE_UNREACHABLE", `${what}: ${extractErrorMessage(e)}`, { exchange: "derive", remediation: UNREACHABLE_REMEDIATION });
    }
    const text = await res.text().catch((e: unknown) => {
      throw new PerpError("EXCHANGE_UNREACHABLE", `${what}: response body unreadable (${extractErrorMessage(e)})`, {
        exchange: "derive", remediation: UNREACHABLE_REMEDIATION,
      });
    });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const rpcError = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    const hasRpcError = rpcError !== undefined && rpcError !== null;
    if (res.status === 429) {
      // The RPC body's "Retry after N ms" is preferred; the retry-after header only when the body has none.
      const fromRpc = hasRpcError ? retryAfterMsOf(rpcError) : null;
      if (fromRpc !== null) throw rateLimited(`${what}: HTTP 429`, fromRpc, rpcCodeOf(rpcError));
      throw rateLimitedError("derive", res.headers.get("retry-after"), text);
    }
    if (hasRpcError) throw rpcErrorOf(what, rpcError);
    if (!res.ok) {
      throw new PerpError("EXCHANGE_ERROR", `${what}: HTTP ${res.status} ${text.slice(0, 200)}`, {
        exchange: "derive", status: res.status, remediation: "Derive answered with an HTTP error; check api.derive.xyz status and retry",
      });
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
  if (code <= -32000 && code >= -32099) return rateLimited(`${what}: ${detail}`, retryAfterMsOf(err), code);
  return new PerpError("EXCHANGE_ERROR", `${what}: request rejected by Derive: ${detail} [code ${code}]`, {
    exchange: "derive", rpcCode: code, rpcData: typeof data === "string" ? data : null,
    remediation: "Retry later; if it persists, Derive's API changed and perp-cli needs an update",
  });
}

function rateLimited(message: string, retryAfterMs: number | null, rpcCode: number | null): PerpError {
  return new PerpError("RATE_LIMITED", message, {
    exchange: "derive",
    ...(rpcCode !== null ? { rpcCode } : {}),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    remediation: RATE_LIMIT_REMEDIATION,
  });
}

function rpcCodeOf(err: unknown): number | null {
  const code = err !== null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "number" ? code : null;
}

/** "Retry after {ms} ms" from an RPC error's `data`, or null. */
function retryAfterMsOf(err: unknown): number | null {
  const data = err !== null && typeof err === "object" ? (err as { data?: unknown }).data : undefined;
  const m = typeof data === "string" ? /Retry after (\d+) ?ms/i.exec(data) : null;
  return m !== null ? Number(m[1]) : null;
}
