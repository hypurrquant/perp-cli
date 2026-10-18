/**
 * Arcus REST client — raw fetch, Ed25519 header auth, venue rate limiting,
 * HTTP/venue errors → PerpError.
 *
 * Auth headers (protected writes): X-API-Key (64-hex pubkey), X-Timestamp
 * (Unix ns, ±30 s), X-Signature (128-hex Ed25519). All reads are public and
 * take `?address=` (account state on Arcus is readable by anyone).
 */

import { PerpError, orderOutcomeUnknown, type ErrorCode } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { Network } from "../venue-types.js";
import { arcusVenue } from "../venues/arcus.js";
import { canonicalJson, nowNs, scheme2Message, signUtf8Hex, type Ed25519SignFn } from "./signing.js";

export interface ArcusAuth {
  apiKeyHex: string;
  sign: Ed25519SignFn;
  /** Master EVM address that owns the key (sent as `?address=`). */
  ownerAddress: string;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface ArcusResponse<T> { status: number; data: T }

const TIMEOUT_MS = 15_000;

function restUrl(net: Network): string {
  const cfg = arcusVenue.networks[net];
  if (!cfg) throw new PerpError("NOT_IMPLEMENTED", `Arcus has no ${net} environment`);
  return cfg.restUrl;
}

function qs(q: Query): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === null || v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

interface ArcusErrorBody {
  error?: string;
  code?: string;
  errorType?: string;
  /** Order engine rejection (OrderRejectionReason). */
  rejectionReason?: string;
  /** setLeverage 422 (SetLeverageRejectReason). */
  rejectReason?: string;
  /** 429: which limiter rejected (ip | account_empty | account_partial). */
  reason?: string;
  /** 429 on order writes: precise wait in ms. */
  retryAfterMs?: number;
}

/** OrderRejectionReason (openapi, docs.arcus.xyz; MISSING_MARK_PRICE: testnet changelog v1.8.12). */
const REJECTION_CODES: Readonly<Record<string, ErrorCode>> = {
  UNDERCOLLATERALIZED: "MARGIN_INSUFFICIENT",
  DUPLICATE_CLIENT_ID: "DUPLICATE_ORDER",
  POSITION_TPSL_ALREADY_EXISTS: "DUPLICATE_ORDER",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_NOT_FOUND_FOR_MODIFY: "ORDER_NOT_FOUND",
  POSITION_SIZE_CAP_EXCEEDED: "SIZE_TOO_LARGE",
  OPEN_INTEREST_CAP_EXCEEDED: "SIZE_TOO_LARGE",
  POST_ONLY_WOULD_CROSS: "ORDER_REJECTED",
  IOC_CANCELED: "ORDER_REJECTED",
  FOK_FAILED: "ORDER_REJECTED",
  COULD_NOT_FILL: "ORDER_REJECTED",
  FILL_WILL_EXCEED_TRADING_BOUND: "ORDER_REJECTED",
  ORDER_WILL_TAKE_LIQUIDITY_DURING_MARKET_HALT: "ORDER_REJECTED",
  REDUCE_ONLY_WOULD_INCREASE: "INVALID_PARAMS",
  ENTRY_TPSL_CANNOT_BE_POSITION_TPSL: "INVALID_PARAMS",
  SELF_TRADE: "RISK_VIOLATION",
  OPEN_ORDER_CAP_EXCEEDED: "RISK_VIOLATION",
  TOO_MANY_CLIENT_IDS: "RISK_VIOLATION",
  MISSING_MARK_PRICE: "PRICE_STALE",
  MODIFY_CHANGED_IMMUTABLE_FIELD: "INVALID_PARAMS",
  MODIFY_ZERO_SIZE: "INVALID_PARAMS",
  MODIFY_TPSL_NOT_SUPPORTED: "CAPABILITY_UNSUPPORTED",
  MODIFY_SUPERSEDED_BY_CANCEL: "ORDER_REJECTED",
  MODIFY_SIZE_ALREADY_FILLED: "ORDER_REJECTED",
  MODIFY_WOULD_CROSS_OUTSIDE_RTH_TRADING_BOUNDARY: "ORDER_REJECTED",
};

const REJECTION_REMEDIATION: Readonly<Record<string, string>> = {
  POST_ONLY_WOULD_CROSS: "The post-only (ALO) price would cross the book — move the price away from the touch or drop post-only",
  REDUCE_ONLY_WOULD_INCREASE: "Reduce-only order would open or grow the position — check the side and position size",
  POSITION_TPSL_ALREADY_EXISTS: "A position TP/SL of this kind already exists for the market — cancel it first (one TP and one SL per market)",
  OPEN_ORDER_CAP_EXCEEDED: "Open-order cap reached — cancel resting orders first: perp trade cancel-all -e arcus",
  TOO_MANY_CLIENT_IDS: "10,000 live client ids reached — cancel resting orders first",
  SELF_TRADE: "The order would match your own resting order — cancel it or change the price",
  MISSING_MARK_PRICE: "No live mark price for this market (oracle gap) — retry once pricing resumes",
  MODIFY_TPSL_NOT_SUPPORTED: "TP/SL orders cannot be modified — cancel and place a new one",
  MODIFY_SUPERSEDED_BY_CANCEL: "A pending cancel for this order won — the order is cancelled",
  MODIFY_SIZE_ALREADY_FILLED: "The order was already filled up to the new size and has been cancelled",
};

/** setLeverage 422 rejectReason (SetLeverageRejectReason). */
const LEVERAGE_REJECT_CODES: Readonly<Record<string, { code: ErrorCode; remediation: string }>> = {
  UNDERCOLLATERALIZED: { code: "MARGIN_INSUFFICIENT", remediation: "Lowering leverage would under-margin open positions — add collateral or reduce positions first" },
  HAS_OPEN_POSITION: { code: "INVALID_PARAMS", remediation: "Isolated mode needs a flat market — close the position, then switch to isolated" },
  INVALID_LEVERAGE: { code: "INVALID_PARAMS", remediation: "Leverage must be within [1, market max] (perp market list -e arcus)" },
  UNKNOWN_MARKET: { code: "SYMBOL_NOT_FOUND", remediation: "List markets with: perp market list -e arcus" },
};

/** Map an Arcus rejectionReason (engine) to an error code. Unknown → EXCHANGE_ERROR. */
export function arcusRejectionCode(reason: string | null | undefined): ErrorCode {
  return (reason && REJECTION_CODES[reason]) || "EXCHANGE_ERROR";
}

/** PerpError for an engine rejectionReason; details carry `rejectionReason` for callers that branch on it. */
export function arcusRejectionError(reason: string | null | undefined, message: string, details: Record<string, unknown>): PerpError {
  const remediation = reason ? REJECTION_REMEDIATION[reason] : undefined;
  return new PerpError(arcusRejectionCode(reason), message, {
    ...details,
    rejectionReason: reason ?? null,
    ...(remediation !== undefined ? { remediation } : {}),
  });
}

/** setLeverage rejection (HTTP 422 or a 200/REJECTED body) → PerpError. Unknown reason → EXCHANGE_ERROR. */
export function arcusLeverageRejectError(reason: string | null | undefined, message: string, details: Record<string, unknown>): PerpError {
  const hit = reason ? LEVERAGE_REJECT_CODES[reason] : undefined;
  return new PerpError(hit ? hit.code : "EXCHANGE_ERROR", message, {
    ...details,
    rejectReason: reason ?? null,
    ...(hit ? { remediation: hit.remediation } : {}),
  });
}

/**
 * HTTP 429 → RATE_LIMITED. Order writes carry `retryAfterMs` (exact) and
 * `reason`; otherwise Retry-After (whole seconds). Docs: api-reference/rate-limits.
 */
export function arcusRateLimitedError(retryAfterHeader: string | null, text: string): PerpError {
  let body: ArcusErrorBody = {};
  try { body = JSON.parse(text) as ArcusErrorBody; } catch { /* non-JSON 429: header only */ }
  const base = rateLimitedError("arcus", retryAfterHeader, text);
  if (typeof body.retryAfterMs !== "number" && body.reason === undefined) return base;
  const reason = body.reason ?? null;
  const hint = reason === "account_empty" ? "The subaccount trading pool is exhausted (drip: 1 action / 10 s) — slow the order loop"
    : reason === "account_partial" ? "The subaccount trading pool cannot cover this charge — send a smaller batch"
    : reason === "ip" ? "Per-IP read weight is exhausted — reduce non-order traffic from this IP"
    : base.structured.remediation;
  return new PerpError("RATE_LIMITED", `arcus: rate limited (HTTP 429${reason ? `, ${reason}` : ""})`, {
    ...(typeof body.retryAfterMs === "number" ? { retryAfterMs: body.retryAfterMs } : base.structured.details?.retryAfterMs !== undefined ? { retryAfterMs: base.structured.details.retryAfterMs } : {}),
    reason,
    body: text.slice(0, 500),
    remediation: hint,
  });
}

function toPerpError(status: number, text: string, endpoint: string): PerpError {
  let body: ArcusErrorBody = {};
  try { body = JSON.parse(text) as ArcusErrorBody; } catch { /* non-JSON error page: message carries raw text */ }
  const msg = body.error ?? text.slice(0, 200);
  const details: Record<string, unknown> = { status, endpoint, body: text.slice(0, 500) };
  const m = `Arcus ${endpoint}: ${msg}`;
  const lower = msg.toLowerCase();

  if (body.rejectionReason) return arcusRejectionError(body.rejectionReason, m, details);
  if (body.rejectReason) return arcusLeverageRejectError(body.rejectReason, m, details);
  if (body.errorType === "Tick") return new PerpError("INVALID_TICK", m, details);
  if (body.errorType === "ReduceOnly") return new PerpError("INVALID_PARAMS", m, details);
  if (status === 401 || body.errorType === "Unauthorized") {
    return new PerpError("SIGNATURE_FAILED", m, {
      ...details,
      remediation: "Check the system clock (±30 s) and that the Arcus API key is registered and not expired: perp wallet agent approve arcus",
    });
  }
  if (status === 403 || body.code === "GEO_RESTRICTED") {
    return new PerpError("POLICY_DENIED", m, {
      ...details,
      remediation: lower.includes("whitelist")
        ? "This address is not on the Arcus access whitelist — request access at https://arcus.xyz"
        : "Arcus rejected the request for this address/region",
    });
  }
  if (status === 404) {
    if (lower.includes("no activity")) {
      return new PerpError("DEPOSIT_REQUIRED", m, { ...details, remediation: "Deposit USDG into the Arcus account first" });
    }
    // "order" first: an order-lookup 404 message may also mention the market.
    if (lower.includes("order")) return new PerpError("ORDER_NOT_FOUND", m, details);
    if (lower.includes("market")) return new PerpError("SYMBOL_NOT_FOUND", m, details);
    return new PerpError("EXCHANGE_ERROR", m, details);
  }
  if (status === 501) return new PerpError("NOT_IMPLEMENTED", m, details);
  if (status === 409) return new PerpError("DUPLICATE_ORDER", m, details);
  if (status >= 400 && status < 500) return new PerpError("INVALID_PARAMS", m, details);
  return new PerpError("EXCHANGE_ERROR", m, details);
}

export class ArcusClient {
  readonly baseUrl: string;
  private readonly rateKey: string;

  constructor(readonly network: Network, private readonly auth: ArcusAuth | null) {
    this.baseUrl = restUrl(network);
    this.rateKey = `arcus:${network}`;
  }

  get hasAuth(): boolean { return this.auth !== null; }

  requireAuth(): ArcusAuth {
    if (!this.auth) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "Arcus: no API key configured for signed requests", {
        remediation: "Register an agent key: perp wallet agent approve arcus",
      });
    }
    return this.auth;
  }

  private async acquire(endpoint: string): Promise<void> {
    await acquireRate(this.rateKey, arcusVenue.rateLimit, endpoint);
  }

  /** Callers acquire the rate-limit slot first (signed requests do so BEFORE taking their timestamp). */
  private async send<T>(method: "GET" | "POST", url: string, endpoint: string, headers: Record<string, string>, body: string | null): Promise<ArcusResponse<T>> {
    // Timeout covers fetch + body read. A GET failure is definite (TIMEOUT /
    // EXCHANGE_UNREACHABLE); a POST failure may have reached the venue → outcome
    // unknown (ORDER_PENDING, never resubmit).
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers: body !== null ? { "Content-Type": "application/json", ...headers } : headers,
        body,
        signal,
      });
      text = await res.text();
    } catch (err) {
      const reason = signal.aborted ? `timed out after ${TIMEOUT_MS}ms` : (err instanceof Error ? err.message : String(err));
      if (method === "POST") {
        throw orderOutcomeUnknown("arcus", endpoint, new Error(reason),
          "Do NOT resubmit — the request may have been applied. Check open orders, positions and balances on arcus");
      }
      throw new PerpError(signal.aborted ? "TIMEOUT" : "EXCHANGE_UNREACHABLE", `Arcus ${endpoint}: ${reason}`, { exchange: "arcus" });
    }
    if (res.status === 429) throw arcusRateLimitedError(res.headers.get("retry-after"), text);
    const pendingRemediation = "Do NOT resubmit — the request may have been applied. Check open orders, positions and balances on arcus";
    // A POST answered 5xx (other than 501 Not Implemented) may have been applied before the error.
    if (method === "POST" && res.status >= 500 && res.status !== 501) {
      throw orderOutcomeUnknown("arcus", endpoint, new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), pendingRemediation);
    }
    if (!res.ok) throw toPerpError(res.status, text, endpoint);
    let data: unknown;
    try { data = text.length ? JSON.parse(text) : null; } catch {
      // A 2xx POST with an unreadable body WAS accepted — what it did is unknown.
      if (method === "POST") throw orderOutcomeUnknown("arcus", endpoint, new Error(`unreadable response (HTTP ${res.status})`), pendingRemediation);
      throw new PerpError("EXCHANGE_ERROR", `Arcus ${endpoint}: invalid JSON`, { body: text.slice(0, 500) });
    }
    return { status: res.status, data: data as T };
  }

  /** Public GET. `endpoint` is the rate-limit weight key. */
  async get<T>(path: string, endpoint: string, query: Query = {}): Promise<T> {
    await this.acquire(endpoint);
    return (await this.send<T>("GET", `${this.baseUrl}${path}${qs(query)}`, endpoint, {}, null)).data;
  }

  /** Unsigned POST (EIP-712 wallet-signed bodies: createApiKey / revokeApiKey / withdraw). */
  async postUnsigned<T>(path: string, endpoint: string, body: Record<string, unknown>): Promise<ArcusResponse<T>> {
    await this.acquire(endpoint);
    return this.send<T>("POST", `${this.baseUrl}${path}`, endpoint, {}, JSON.stringify(body));
  }

  /**
   * Scheme-1 POST. The rate-limit slot is acquired first; only then is the
   * timestamp `ctNs` taken and handed to `build`, which returns the typed-payload
   * signature and the pre-serialized body (canonicalJson — the body's int64 ns
   * `timestamp` exceeds Number precision and must be emitted from a bigint).
   * `ctNs` becomes X-Timestamp; `?address=` carries the master address.
   */
  async postScheme1<T>(
    path: string, endpoint: string,
    build: (ctNs: bigint) => Promise<{ bodyJson: string; signatureHex: string }>,
  ): Promise<ArcusResponse<T>> {
    const auth = this.requireAuth();
    await this.acquire(endpoint);
    const ctNs = nowNs();
    const { bodyJson, signatureHex } = await build(ctNs);
    const url = `${this.baseUrl}${path}${qs({ address: auth.ownerAddress })}`;
    return this.send<T>("POST", url, endpoint, {
      "X-API-Key": auth.apiKeyHex,
      "X-Timestamp": ctNs.toString(),
      "X-Signature": signatureHex,
    }, bodyJson);
  }

  /** Scheme-2 POST: signs `ts + action + canonicalJson(body)` and sends that exact canonical body. */
  async postScheme2<T>(action: string, body: Record<string, unknown>): Promise<ArcusResponse<T>> {
    const auth = this.requireAuth();
    await this.acquire(action);
    const ts = nowNs();
    const canonical = canonicalJson(body);
    const sig = await signUtf8Hex(auth.sign, scheme2Message(ts, action, canonical));
    const url = `${this.baseUrl}/v1/${action}${qs({ address: auth.ownerAddress })}`;
    return this.send<T>("POST", url, action, {
      "X-API-Key": auth.apiKeyHex,
      "X-Timestamp": ts.toString(),
      "X-Signature": sig,
    }, canonical);
  }
}
