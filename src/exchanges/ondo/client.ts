/**
 * Ondo Perps raw REST client (raw fetch + node:crypto HMAC, no SDK).
 *
 * Auth (live-verified, scratchpad/sdk-findings.md §2 — the OpenAPI spec's
 * `X-API-KEY-ID` header name is wrong):
 *   ONDO-KEY-ID    key id including the "ondoKeyId_" prefix
 *   ONDO-TIMESTAMP ms since epoch. Docs (api-reference/api_key_authentication): "this may be
 *                  at most 10 seconds behind or 1 second ahead of server time."
 *   ONDO-SIGN      hex(HMAC-SHA256(secret incl. "ondoApiSecret_" prefix,
 *                      timestamp + METHOD + path?query + body))
 *   The signed `path?query` is byte-identical to the request target sent on
 *   the wire (URLSearchParams-encoded), matching the docs' "requestPath: full
 *   path and query parameters of the URL" / Go `req.URL.RequestURI()`.
 *
 * Envelope: `{ success, result, error?, error_code?, pageInfo? }`. `pageInfo`
 * is a sibling of `result` on paginated endpoints.
 *
 * Every request first acquires the venue rate-limit bucket (1 req/s default).
 * No retries, no fallbacks (SSOT Rule #2): HTTP 429 → RATE_LIMITED, any other
 * failure → PerpError carrying the venue error code.
 */

import { createHmac } from "node:crypto";
import { PerpError, orderOutcomeUnknown, type ErrorCode } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";
import type { Network } from "../venue-types.js";

export interface OndoCredentials {
  keyId: string;
  secret: string;
}

export interface OndoClientOptions {
  restUrl: string;
  network: Network;
  rateLimit: RateLimitPolicy;
  /** null → public endpoints only. */
  credentials: OndoCredentials | null;
}

export type OndoQuery = Record<string, string | number | boolean | null>;

export interface OndoPage<T> {
  result: T;
  nextCursor: string | null;
}

interface OndoEnvelope {
  success?: boolean;
  result?: unknown;
  error?: string;
  error_code?: string;
  pageInfo?: { prevCursor?: string; nextCursor?: string };
}

/** Venue error code → CLI error code. Codes not listed map to EXCHANGE_ERROR. */
const ERROR_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  // margin / balance
  insufficient_margin: "MARGIN_INSUFFICIENT",
  account_in_liquidation: "MARGIN_INSUFFICIENT",
  insufficient_funds: "INSUFFICIENT_BALANCE",
  withdrawal_error_insufficient_balance: "INSUFFICIENT_BALANCE",
  // not found
  order_not_found: "ORDER_NOT_FOUND",
  twap_order_not_found: "ORDER_NOT_FOUND",
  invalid_symbol: "SYMBOL_NOT_FOUND",
  invalid_market: "SYMBOL_NOT_FOUND",
  // auth
  api_key_not_found: "KEY_NOT_FOUND",
  auth_missing: "NO_SIGNER_AVAILABLE",
  auth_invalid: "SIGNATURE_FAILED",
  auth_expired: "SIGNATURE_FAILED",
  signature_mismatch: "SIGNATURE_FAILED",
  failed_to_decode_hex_signature: "SIGNATURE_FAILED",
  failed_to_parse_timestamp: "SIGNATURE_FAILED",
  timestamp_too_far: "SIGNATURE_FAILED",
  key_doesnt_have_scope: "POLICY_DENIED",
  ip_not_permitted: "POLICY_DENIED",
  // rate limit
  too_many_requests: "RATE_LIMITED",
  // price / size precision
  order_invalid_price: "INVALID_TICK",
  stop_order_trigger_price_invalid_increment: "INVALID_TICK",
  order_invalid_size: "INVALID_PARAMS",
  // invalid parameters
  bad_query_param: "INVALID_PARAMS",
  invalid_cursor: "INVALID_PARAMS",
  invalid_leverage: "INVALID_PARAMS",
  invalid_market_order_fields: "INVALID_PARAMS",
  invalid_order_type: "INVALID_PARAMS",
  invalid_stop_order: "INVALID_PARAMS",
  invalid_time_in_force: "INVALID_PARAMS",
  invalid_network: "INVALID_PARAMS",
  invalid_withdrawal_network: "INVALID_PARAMS",
  withdrawal_invalid_amount: "INVALID_PARAMS",
  withdrawal_amount_too_small: "SIZE_TOO_SMALL",
  withdrawal_missing_customer_withdrawal_id: "INVALID_PARAMS",
  withdrawal_address_not_found: "INVALID_PARAMS",
  internal_withdrawal_address: "INVALID_PARAMS",
  withdrawal_not_found: "INVALID_PARAMS",
  // OpenAPI name; `transfer_amount_too_precise` kept as the earlier observed alias.
  transfer_amount_precision_overflow: "INVALID_PARAMS",
  transfer_amount_too_precise: "INVALID_PARAMS",
  bad_withdrawal_address: "INVALID_PARAMS",
  clientOrderID_chars_invalid: "INVALID_PARAMS",
  clientOrderID_length_invalid: "INVALID_PARAMS",
  order_negative_price: "INVALID_PARAMS",
  order_negative_size: "INVALID_PARAMS",
  order_price_outside_min_max_bounds: "INVALID_PARAMS",
  order_price_outside_safe_bounds: "INVALID_PARAMS",
  post_only_has_match: "INVALID_PARAMS",
  reduce_only_flipping_position: "INVALID_PARAMS",
  reduce_only_increasing_position: "INVALID_PARAMS",
  reduce_only_invalid_tif: "INVALID_PARAMS",
  reduce_only_no_open_position: "POSITION_NOT_FOUND",
  stop_order_crosses_mark_price: "INVALID_PARAMS",
  stop_order_crosses_order_price: "INVALID_PARAMS",
  stop_order_trigger_price_exceeds_max: "INVALID_PARAMS",
  stop_order_trigger_price_negative: "INVALID_PARAMS",
  order_already_canceled: "INVALID_PARAMS",
  order_already_fully_filled: "INVALID_PARAMS",
  order_not_in_cancelable_state: "INVALID_PARAMS",
  batch_order_empty: "INVALID_PARAMS",
  batch_order_too_many_orders: "INVALID_PARAMS",
  batch_cancel_empty: "INVALID_PARAMS",
  batch_cancel_too_many_orders: "INVALID_PARAMS",
  withdrawal_duplicate_customer_withdrawal_id: "DUPLICATE_ORDER",
  clientOrderID_collision: "DUPLICATE_ORDER",
  // market state
  mark_price_not_available: "PRICE_STALE",
  insufficient_liquidity: "ORDER_REJECTED",
  market_orders_disabled: "CAPABILITY_UNSUPPORTED",
  trading_disabled: "CAPABILITY_UNSUPPORTED",
  feature_disabled: "CAPABILITY_UNSUPPORTED",
  // transient venue-side withdrawal failures
  withdrawal_try_later: "EXCHANGE_ERROR",
  withdrawal_system_error: "EXCHANGE_ERROR",
  withdrawal_failed: "EXCHANGE_ERROR",
  // risk / limits
  too_many_open_orders: "RISK_VIOLATION",
  withdrawal_limit_exceeded: "RISK_VIOLATION",
  order_matches_against_self: "RISK_VIOLATION",
  net_position_too_large: "SIZE_TOO_LARGE",
};

/** Venue-code-specific remediation; wins over the per-ErrorCode REMEDIATION. */
const VENUE_REMEDIATION: Readonly<Record<string, string>> = {
  bad_withdrawal_address: "Withdrawals go only to addresses in your Ondo Perps address book — add it in the Ondo Perps UI (Withdraw → address book) and wait out any cooldown",
  withdrawal_address_not_found: "Withdrawals go only to addresses in your Ondo Perps address book — add it in the Ondo Perps UI (Withdraw → address book) and wait out any cooldown",
  internal_withdrawal_address: "That address belongs to an Ondo Perps account — use an external address from your address book",
  invalid_withdrawal_network: "Use a network the address book entry supports (avalanche | ethereum | solana)",
  withdrawal_amount_too_small: "Increase the amount above the venue minimum (the withdrawal fee is shown by: perp account -e ondo)",
  withdrawal_try_later: "The venue asked to retry later; check withdrawal history before resubmitting",
  transfer_amount_precision_overflow: "Round the amount to the asset's precision (USDC: 6 decimals)",
  transfer_amount_too_precise: "Round the amount to the asset's precision (USDC: 6 decimals)",
  clientOrderID_collision: "Use a new client order id (it must be unique per account)",
  clientOrderID_chars_invalid: "Client order ids may use letters, digits, '-' and '_' only",
  clientOrderID_length_invalid: "Shorten the client order id",
  net_position_too_large: "Reduce the size: the resulting net position exceeds the market's limit",
  insufficient_liquidity: "Not enough resting liquidity — use a smaller size or a limit order",
  market_orders_disabled: "Market orders are disabled on this market — place a limit order",
  trading_disabled: "Trading is disabled on this market right now — check the market status (perp market list -e ondo)",
  feature_disabled: "This feature is disabled for the account — check the Ondo Perps UI",
  mark_price_not_available: "Mark price is unavailable — retry shortly",
};

const REMEDIATION: Readonly<Partial<Record<ErrorCode, string>>> = {
  KEY_NOT_FOUND: "Re-register the Ondo API key: perp wallet agent approve ondo",
  NO_SIGNER_AVAILABLE: "Register an Ondo API key: perp wallet agent approve ondo",
  SIGNATURE_FAILED: "Check the system clock (the timestamp may be at most 10 s behind or 1 s ahead of server time) and re-register the key: perp wallet agent approve ondo",
  POLICY_DENIED: "Grant the key the required scope (trade / transfer) or whitelist this IP in the Ondo Perps UI, then re-approve",
  MARGIN_INSUFFICIENT: "Reduce size/leverage or deposit more collateral",
  INSUFFICIENT_BALANCE: "Deposit more USDC or reduce the amount",
  SYMBOL_NOT_FOUND: "List markets with: perp market list -e ondo",
  INVALID_TICK: "Align price/size with the market tick and step (perp market list -e ondo)",
};

/** Per-request timeout (fetch + body read). */
export const ONDO_REQUEST_TIMEOUT_MS = 15_000;

export class OndoClient {
  private readonly restUrl: string;
  private readonly rateKey: string;

  constructor(private readonly opts: OndoClientOptions) {
    this.restUrl = opts.restUrl.replace(/\/+$/, "");
    this.rateKey = `ondo:${opts.network}`;
  }

  get hasCredentials(): boolean {
    return this.opts.credentials !== null;
  }

  // ── Public ──

  async publicGet<T>(path: string, query: OndoQuery | null): Promise<T> {
    return (await this.request<T>("GET", path, query, null, false, true)).result;
  }

  async publicGetPage<T>(path: string, query: OndoQuery | null): Promise<OndoPage<T>> {
    return this.request<T>("GET", path, query, null, false, true);
  }

  // ── Authenticated ──

  async get<T>(path: string, query: OndoQuery | null): Promise<T> {
    return (await this.request<T>("GET", path, query, null, true, true)).result;
  }

  async getPage<T>(path: string, query: OndoQuery | null): Promise<OndoPage<T>> {
    return this.request<T>("GET", path, query, null, true, true);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>("POST", path, null, body, true, true)).result;
  }

  async delete<T>(path: string, query: OndoQuery | null): Promise<T> {
    return (await this.request<T>("DELETE", path, query, null, true, true)).result;
  }

  /** Endpoints that answer with a bare GenericResponse (no `result`), e.g. POST /v1/perps/leverage. */
  async postNoResult(path: string, body: unknown): Promise<void> {
    await this.request<undefined>("POST", path, null, body, true, false);
  }

  /** Endpoints that answer with a bare GenericResponse (no `result`), e.g. DELETE /v1/perps/orders. */
  async deleteNoResult(path: string, query: OndoQuery | null): Promise<void> {
    await this.request<undefined>("DELETE", path, query, null, true, false);
  }

  // ── Core ──

  private sign(creds: OndoCredentials, timestamp: string, method: string, pathWithQuery: string, body: string): string {
    return createHmac("sha256", creds.secret).update(timestamp + method + pathWithQuery + body).digest("hex");
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: OndoQuery | null,
    body: unknown,
    auth: boolean,
    expectResult: boolean,
  ): Promise<OndoPage<T>> {
    let pathWithQuery = path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== null) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) pathWithQuery = `${path}?${s}`;
    }
    const bodyStr = body === null ? "" : JSON.stringify(body);

    // Rate-limit wait happens BEFORE the timestamp is taken so a queued request
    // never goes out with a stale ONDO-TIMESTAMP (at most 10 s behind / 1 s ahead).
    await acquireRate(this.rateKey, this.opts.rateLimit, path);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (bodyStr) headers["Content-Type"] = "application/json";
    if (auth) {
      const creds = this.opts.credentials;
      if (!creds) {
        throw new PerpError("NO_SIGNER_AVAILABLE", `Ondo Perps: ${method} ${path} requires an API key`, {
          remediation: "Register an Ondo API key: perp wallet agent approve ondo",
        });
      }
      const ts = Date.now().toString();
      headers["ONDO-KEY-ID"] = creds.keyId;
      headers["ONDO-TIMESTAMP"] = ts;
      headers["ONDO-SIGN"] = this.sign(creds, ts, method, pathWithQuery, bodyStr);
    }

    // Timeout covers the whole exchange (headers + body). A GET failure is definite
    // (nothing changed); a POST failure may have reached the venue → outcome unknown
    // (ORDER_PENDING, never resubmit).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ONDO_REQUEST_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.restUrl}${pathWithQuery}`, {
        method,
        headers,
        ...(bodyStr ? { body: bodyStr } : {}),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      const aborted = controller.signal.aborted;
      const reason = aborted ? `timed out after ${ONDO_REQUEST_TIMEOUT_MS}ms` : `failed: ${e instanceof Error ? e.message : String(e)}`;
      if (method !== "GET") {
        throw orderOutcomeUnknown("ondo", `${method} ${path}`, new Error(`request ${reason}`),
          `Do NOT resubmit — the request may have been applied. Check open orders, positions and balances on ondo`);
      }
      throw new PerpError(aborted ? "TIMEOUT" : "EXCHANGE_UNREACHABLE", `Ondo Perps: ${method} ${path} ${reason}`, {
        exchange: "ondo",
        remediation: `Check network connectivity to ${this.restUrl}`,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw rateLimitedError("ondo", res.headers.get("retry-after"), text);
    }

    // A write (POST / DELETE) answered 5xx, or 2xx with an unreadable body, may have been applied.
    const pending = (why: string) => orderOutcomeUnknown("ondo", `${method} ${path}`, new Error(why),
      "Do NOT resubmit — the request may have been applied. Check open orders, positions and balances on ondo");
    if (method !== "GET" && res.status >= 500) throw pending(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let parsed: OndoEnvelope;
    try {
      parsed = JSON.parse(text) as OndoEnvelope;
    } catch {
      if (method !== "GET" && res.ok) throw pending(`unreadable response (HTTP ${res.status})`);
      throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: ${method} ${path} returned non-JSON (HTTP ${res.status})`, {
        httpStatus: res.status,
        body: text.slice(0, 500),
      });
    }

    if (!res.ok || parsed.success !== true) {
      throw ondoError(method, path, res.status, parsed);
    }
    if (!expectResult) return { result: undefined as T, nextCursor: null };
    if (!("result" in parsed)) {
      throw new PerpError("EXCHANGE_ERROR", `Ondo Perps: ${method} ${path} response has no result`, {
        httpStatus: res.status,
        body: text.slice(0, 500),
      });
    }
    const next = parsed.pageInfo?.nextCursor;
    return { result: parsed.result as T, nextCursor: typeof next === "string" && next !== "" ? next : null };
  }
}

function ondoError(method: string, path: string, httpStatus: number, env: OndoEnvelope): PerpError {
  const venueCode = typeof env.error_code === "string" ? env.error_code : null;
  const venueMsg = typeof env.error === "string" ? env.error : "unknown error";
  let code: ErrorCode = venueCode !== null && venueCode in ERROR_CODE_MAP ? ERROR_CODE_MAP[venueCode] : "EXCHANGE_ERROR";
  if (code === "EXCHANGE_ERROR" && venueCode === "not_found" && (path.startsWith("/v1/perps/orders") || path.startsWith("/v1/spot/orders"))) code = "ORDER_NOT_FOUND";
  const remediation = (venueCode !== null ? VENUE_REMEDIATION[venueCode] : undefined) ?? REMEDIATION[code];
  return new PerpError(code, `Ondo Perps: ${venueMsg}${venueCode ? ` (${venueCode})` : ""} [${method} ${path}, HTTP ${httpStatus}]`, {
    venueCode,
    httpStatus,
    ...(remediation !== undefined ? { remediation } : {}),
  });
}
