/**
 * Extended public REST transport (official API, https://api.docs.extended.exchange/).
 *
 * Every response is `{status:"OK", data, pagination?}` or `{status:"ERROR", error:{code, message}}`
 * (live 2026-10-19: an unknown market on /info/markets?market= or /info/<m>/funding is HTTP 400
 * `{"code":1001,"message":"Market not found"}`). A User-Agent header is mandatory (docs
 * "Mandatory headers"; without one the API answers 403). GET only — there is no write path.
 */

import { PerpError, extractErrorMessage } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";

export const EXTENDED_HTTP_TIMEOUT_MS = 15_000;
export const EXTENDED_USER_AGENT = "perp-cli";
/** Extended's error code for an unknown market (live 2026-10-19). */
export const EXTENDED_MARKET_NOT_FOUND = 1001;

/** A body that does not match the documented shape: an explicit EXCHANGE_ERROR, never a guess. */
export function extendedShapeError(what: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `Extended API response did not match the documented shape: ${what}`, {
    exchange: "extended",
    remediation: "Extended changed its public API; perp-cli needs an update to read it",
  });
}

export interface ExtendedErrorBody { code: number | string | null; message: string }

function errorBodyOf(parsed: unknown): ExtendedErrorBody | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as { status?: unknown; error?: unknown };
  if (p.status !== "ERROR") return null;
  const e = p.error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === "number" || typeof e?.code === "string" ? e.code : null;
  return { code, message: typeof e?.message === "string" ? e.message : JSON.stringify(p.error === undefined ? null : p.error) };
}

export class ExtendedClient {
  constructor(
    private readonly restUrl: string,
    private readonly rateLimit: RateLimitPolicy,
    /** Limiter bucket: one per network (the documented limit is per IP, per host). */
    private readonly bucket: string,
  ) {}

  /**
   * GET <rest><path>; returns the parsed body (`status: "OK"`). Every failure is a PerpError:
   * transport → EXCHANGE_UNREACHABLE, 429 → RATE_LIMITED, `{status:"ERROR"}` / non-2xx /
   * non-JSON → EXCHANGE_ERROR (an unknown market keeps the venue's 1001 code in details).
   */
  async get<T = unknown>(path: string, query: ReadonlyArray<[string, string]> = []): Promise<{ status: "OK"; data?: T } & Record<string, unknown>> {
    await acquireRate(this.bucket, this.rateLimit, path);
    const qs = query.length > 0 ? `?${query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : "";
    let res: Response;
    try {
      res = await fetch(`${this.restUrl}${path}${qs}`, {
        headers: { accept: "application/json", "user-agent": EXTENDED_USER_AGENT },
        signal: AbortSignal.timeout(EXTENDED_HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `Extended ${path}: ${extractErrorMessage(e)}`, { exchange: "extended" });
    }
    const text = await res.text().catch((e: unknown) => {
      throw new PerpError("EXCHANGE_UNREACHABLE", `Extended ${path}: response body unreadable (${extractErrorMessage(e)})`, { exchange: "extended" });
    });
    if (res.status === 429) throw rateLimitedError("extended", res.headers.get("retry-after"), text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const err = errorBodyOf(parsed);
    if (err !== null || !res.ok) {
      const msg = err !== null ? `${err.code === null ? "" : `${err.code} `}${err.message}` : `HTTP ${res.status} ${text.slice(0, 200)}`;
      throw new PerpError("EXCHANGE_ERROR", `Extended ${path}: ${msg}`, {
        exchange: "extended", status: res.status,
        ...(err !== null && err.code !== null ? { venueCode: err.code } : {}),
      });
    }
    if (parsed === undefined) throw extendedShapeError(`${path} returned a non-JSON body`);
    if (parsed === null || typeof parsed !== "object" || (parsed as { status?: unknown }).status !== "OK") {
      throw extendedShapeError(`${path} has no status "OK"`);
    }
    return parsed as { status: "OK"; data?: T } & Record<string, unknown>;
  }
}
