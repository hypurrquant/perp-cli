/**
 * QFEX raw REST client: raw fetch + node:crypto HMAC, no SDK.
 *
 * Two hosts: the API (`api.qfex.*` — market data, account reads, leverage, subaccount
 * transfer) and the banker (`banker.qfex.*` — deposit address, withdraw). Both take the same
 * four auth headers (signing.ts). Errors are RFC 7807 problem+json.
 *
 * No retries, no fallbacks (SSOT Rule #2). A GET failure is definite (nothing changed). A POST
 * that may have reached the venue (transport failure, timeout, 5xx) is an UNKNOWN outcome:
 * ORDER_PENDING, never re-sent.
 *
 * Rate limit: QFEX documents only the WebSocket budget ("HTTP endpoints … may be subject to
 * separate controls"). UNVERIFIED — a conservative 5 requests/s per process is applied here.
 */

import { PerpError, orderOutcomeUnknown } from "../../errors.js";
import { acquireRate } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";
import type { Network } from "../venue-types.js";
import { qfexBankerError, qfexRestError } from "./errors.js";
import { qfexNonce, qfexRestHeaders, type QfexCredentials } from "./signing.js";

/** UNVERIFIED: no published REST limit — 5 req/s (see module header). */
export const QFEX_REST_RATE_LIMIT: RateLimitPolicy = { capacity: 5, refillPerSec: 5, weights: null };

/** Per-request timeout (fetch + body read). */
export const QFEX_REQUEST_TIMEOUT_MS = 15_000;

export type QfexQuery = Record<string, string | number | null>;

export interface QfexClientOptions {
  restUrl: string;
  bankerUrl: string;
  network: Network;
  /** null → public endpoints only. */
  credentials: QfexCredentials | null;
  /** Account the signed requests act as (x-qfex-requested-account-id); null only while a key is being imported. */
  accountId: string | null;
}

type Host = "api" | "banker";

export class QfexClient {
  private readonly restUrl: string;
  private readonly bankerUrl: string;
  private readonly rateKey: string;

  constructor(private readonly opts: QfexClientOptions) {
    this.restUrl = opts.restUrl.replace(/\/+$/, "");
    this.bankerUrl = opts.bankerUrl.replace(/\/+$/, "");
    this.rateKey = `qfex:${opts.network}:rest`;
  }

  get hasCredentials(): boolean {
    return this.opts.credentials !== null;
  }

  /** Public GET (no auth headers). */
  async publicGet<T>(path: string, query: QfexQuery | null): Promise<T> {
    return requireBody(await this.request<T>("api", "GET", path, query, null, false, this.opts.accountId), `GET ${path}`);
  }

  /** Signed GET as the configured account. */
  async get<T>(path: string, query: QfexQuery | null): Promise<T> {
    return requireBody(await this.request<T>("api", "GET", path, query, null, true, this.opts.accountId), `GET ${path}`);
  }

  /** Signed GET as an explicit account (`null` = no account header: the key's primary account). Import-time checks only. */
  async getAs<T>(path: string, query: QfexQuery | null, accountId: string | null): Promise<T> {
    return requireBody(await this.request<T>("api", "GET", path, query, null, true, accountId), `GET ${path}`);
  }

  /** Signed POST; returns the parsed body, or null for an empty one (204 / empty 200). */
  async post<T>(path: string, query: QfexQuery | null, body: unknown): Promise<T | null> {
    return this.request<T>("api", "POST", path, query, body, true, this.opts.accountId);
  }

  async bankerGet<T>(path: string, query: QfexQuery | null): Promise<T> {
    return requireBody(await this.request<T>("banker", "GET", path, query, null, true, null), `GET ${path}`);
  }

  /** Banker POST acts on the primary account (deposits / withdrawals are primary-only): no account header. */
  async bankerPost<T>(path: string, body: unknown): Promise<T | null> {
    return this.request<T>("banker", "POST", path, null, body, true, null);
  }

  private async request<T>(
    host: Host, method: "GET" | "POST", path: string, query: QfexQuery | null, body: unknown, auth: boolean, accountId: string | null,
  ): Promise<T | null> {
    let pathWithQuery = path;
    if (query !== null) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== null) qs.append(k, String(v));
      const s = qs.toString();
      if (s !== "") pathWithQuery = `${path}?${s}`;
    }
    const base = host === "api" ? this.restUrl : this.bankerUrl;
    const bodyStr = body === null ? "" : JSON.stringify(body);

    // The rate-limit wait happens BEFORE the timestamp is taken (±5 min window, and a queued
    // request must not go out with a stale one).
    await acquireRate(this.rateKey, QFEX_REST_RATE_LIMIT, path);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (bodyStr !== "") headers["Content-Type"] = "application/json";
    if (auth) {
      const creds = this.opts.credentials;
      if (creds === null) {
        throw new PerpError("NO_SIGNER_AVAILABLE", `QFEX: ${method} ${path} requires an API key`, {
          remediation: "Import a QFEX API key: perp wallet agent import qfex",
        });
      }
      Object.assign(headers, qfexRestHeaders(creds, accountId, Date.now(), qfexNonce()));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QFEX_REQUEST_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${base}${pathWithQuery}`, { method, headers, ...(bodyStr !== "" ? { body: bodyStr } : {}), signal: controller.signal });
      text = await res.text();
    } catch (e) {
      const aborted = controller.signal.aborted;
      const reason = aborted ? `timed out after ${QFEX_REQUEST_TIMEOUT_MS}ms` : `failed: ${e instanceof Error ? e.message : String(e)}`;
      if (method === "POST") throw this.unknownOutcome(host, path, `request ${reason}`);
      throw new PerpError(aborted ? "TIMEOUT" : "EXCHANGE_UNREACHABLE", `QFEX: ${method} ${path} ${reason}`, {
        exchange: "qfex", remediation: `Check network connectivity to ${base}`,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // A 5xx on a POST does not say whether the venue applied it.
      if (method === "POST" && res.status >= 500) throw this.unknownOutcome(host, path, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      throw host === "banker" ? qfexBankerError(method, path, res.status, text) : qfexRestError(method, path, res.status, text);
    }
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      if (method === "POST") throw this.unknownOutcome(host, path, `HTTP ${res.status} with a non-JSON body`);
      throw new PerpError("EXCHANGE_ERROR", `QFEX: ${method} ${path} returned non-JSON (HTTP ${res.status})`, {
        exchange: "qfex", httpStatus: res.status, body: text.slice(0, 300),
      });
    }
  }

  private unknownOutcome(host: Host, path: string, reason: string): PerpError {
    return orderOutcomeUnknown("qfex", `POST ${path}`, new Error(reason), host === "banker"
      ? "Do NOT resubmit — POST /withdraw is not idempotent and may have been applied. Check the QFEX funding history (web app) and: perp account balance -e qfex"
      : "Do NOT resubmit — the request may have been applied. Check: perp account balance -e qfex / perp account positions -e qfex");
  }
}

/** A required GET body: QFEX GET endpoints always answer with a JSON object. */
export function requireBody<T>(body: T | null, what: string): T {
  if (body === null) throw new PerpError("EXCHANGE_ERROR", `QFEX: ${what} returned an empty body`, { exchange: "qfex" });
  return body;
}
