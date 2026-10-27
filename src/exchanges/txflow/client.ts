/**
 * TxFlow transport — official API (Beta), docs https://docs.txflow.com/api.
 *
 *  - REST: `POST <rest>/info` with a `{type, ...}` body and the `x-api-version` header. Every
 *    answer is an envelope `{success, code, data}`; an error is `{success: false, code, message}`
 *    (HTTP 200 for a missing book, 403 for a read the venue does not allow, e.g. fundingHistory).
 *    A non-envelope body or a non-2xx HTML / text page is an error too. There is no fallback for a
 *    refused read (no HL-endpoint substitution, no guessing).
 *  - REST writes: `POST <rest>/exchange` with a signed envelope (signing.ts) and
 *    `"confirm": "executed"`, so the answer is the EXECUTION result, not just consensus
 *    acceptance (docs: Exchange API § Response). Writes are NEVER retried. Outcome classes:
 *      no connection at all                         → not sent (EXCHANGE_UNREACHABLE, sent:false)
 *      HTTP 429                                     → RATE_LIMITED, sent:false (docs: a rate-limited
 *                                                     action did not execute)
 *      `{status:"err"}` (HTTP < 500) / HTTP 4xx     → definite refusal (POLICY_DENIED for the mainnet
 *                                                     whitelist / access gate, DEPOSIT_REQUIRED,
 *                                                     AGENT_NOT_REGISTERED, else the caller's code)
 *      `statuses: [{error}]`                        → executed and failed: definite refusal
 *      `statuses: ["success"]` + `confirm: executed` → executed (the response never carries an
 *                                                     order id or a fill — callers read those back)
 *      any HTTP ≥ 500 (even with an err body),
 *      "success" without the confirm echo,
 *      timeout / reset / HTTP 202 `pending` /
 *      async `traceId` ack / unreadable body        → outcome UNKNOWN (TxflowSendUnknown)
 *  - WS one-shot: open → subscribe `allAssetCtxs` → first data frame → close (bulk mark / funding
 *    snapshot of every perp). The socket factory is injectable for tests.
 */

import WebSocket from "ws";
import { PerpError, extractErrorMessage, isConnectFailure, type ErrorCode } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";
import { TXFLOW_API_VERSION } from "../venues/txflow.js";

export const TXFLOW_HTTP_TIMEOUT_MS = 15_000;
export const TXFLOW_WS_SNAPSHOT_TIMEOUT_MS = 10_000;

/** Shape drift in the documented API: an explicit EXCHANGE_ERROR, never a guessed value. */
export function txflowShapeError(what: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `TxFlow API shape changed: ${what}`, {
    exchange: "txflow",
    remediation: `TxFlow's API (x-api-version ${TXFLOW_API_VERSION}) answered in a shape perp-cli does not read; perp-cli needs an update. TxFlow data is unavailable until then`,
  });
}

interface Envelope { success: boolean; code: number; data?: unknown; message?: string }

function asEnvelope(body: unknown): Envelope | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.success !== "boolean" || typeof b.code !== "number") return null;
  return b as unknown as Envelope;
}

export class TxflowClient {
  constructor(
    private readonly restUrl: string,
    private readonly rateLimit: RateLimitPolicy,
  ) {}

  /** POST /info. Returns the envelope's `data`; every error path is a PerpError. */
  async info<T = unknown>(body: { type: string } & Record<string, unknown>): Promise<T> {
    await acquireRate("txflow", this.rateLimit, body.type);
    let res: Response;
    try {
      res = await fetch(`${this.restUrl}/info`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-version": TXFLOW_API_VERSION },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TXFLOW_HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `TxFlow ${body.type}: ${extractErrorMessage(e)}`, { exchange: "txflow" });
    }
    const text = await res.text().catch((e: unknown) => {
      throw new PerpError("EXCHANGE_UNREACHABLE", `TxFlow ${body.type}: response body unreadable (${extractErrorMessage(e)})`, { exchange: "txflow" });
    });
    if (res.status === 429) throw rateLimitedError("txflow", res.headers.get("retry-after"), text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const env = asEnvelope(parsed);
    if (env !== null && !env.success) {
      const message = typeof env.message === "string" && env.message !== "" ? env.message : "request failed";
      throw new PerpError("EXCHANGE_ERROR", `TxFlow ${body.type}: ${message} (code ${env.code}${res.ok ? "" : `, HTTP ${res.status}`})`, {
        exchange: "txflow",
        venueCode: env.code,
        ...(res.ok ? {} : { status: res.status }),
        remediation: res.status === 403
          ? `TxFlow does not allow the "${body.type}" read; perp-cli has no other source for it`
          : res.status >= 500
          ? "TxFlow had a server error; try again later"
          : "coin" in body || "req" in body
          ? `TxFlow refused "${body.type}"; check the symbol (perp -e txflow market list) and try again`
          : `TxFlow refused "${body.type}"; the venue's message is above`,
      });
    }
    if (!res.ok) {
      // A 5xx can be a raw Cloudflare HTML page (live: candleSnapshot 1w / 3d → HTTP 500): tags stripped.
      const clean = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      throw new PerpError("EXCHANGE_ERROR", `TxFlow ${body.type}: HTTP ${res.status} ${clean}`, { exchange: "txflow", status: res.status });
    }
    if (parsed === undefined) throw txflowShapeError(`${body.type} returned a non-JSON body`);
    if (env === null) throw txflowShapeError(`${body.type} answered without a {success, code, data} envelope`);
    if (env.code !== 0) throw txflowShapeError(`${body.type} answered success:true with code ${env.code}`);
    if (!("data" in env)) throw txflowShapeError(`${body.type} answered success:true without data`);
    return env.data as T;
  }

  /**
   * POST /exchange with `confirm: "executed"`. Resolves with the response `data.type` when the
   * action EXECUTED ("success"); every refusal is a PerpError with `sent: false`; anything that
   * may have executed throws TxflowSendUnknown. Never retried.
   */
  async exchange(req: TxflowSignedRequest, what: string, rejectCode: ErrorCode, network: "mainnet" | "testnet"): Promise<{ type: string | null }> {
    await acquireRate("txflow", this.rateLimit, "exchange");
    let res: Response;
    try {
      res = await fetch(`${this.restUrl}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-version": TXFLOW_API_VERSION },
        body: JSON.stringify({ action: req.action, signature: req.signature, nonce: req.nonce, vaultAddress: null, signatureChainId: null, confirm: "executed" }),
        signal: AbortSignal.timeout(TXFLOW_HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      if (isConnectFailure(e)) {
        throw new PerpError("EXCHANGE_UNREACHABLE", `TxFlow ${what}: could not connect — nothing was sent`, { exchange: "txflow", sent: false });
      }
      throw new TxflowSendUnknown(`TxFlow ${what}`, e, null);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new TxflowSendUnknown(`TxFlow ${what}`, e, res.status);
    }
    if (res.status === 429) {
      const r = rateLimitedError("txflow", res.headers.get("retry-after"), text);
      throw new PerpError("RATE_LIMITED", `TxFlow ${what} refused: rate limited (HTTP 429)`, {
        ...(r.structured.details ?? {}), exchange: "txflow", sent: false,
        remediation: "Nothing was executed (a rate-limited TxFlow action does not run). Wait, then retry — a retry is signed with a fresh nonce",
      });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    const venueCode = typeof body?.code === "number" ? body.code : null;
    // A 5xx can come after consensus (the action may have executed): unknown, even with an err body.
    if (res.status >= 500) {
      const msg = textOf(body?.message) ?? textOf(body?.response) ?? text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      throw new TxflowSendUnknown(`TxFlow ${what}`, new Error(`HTTP ${res.status} ${msg}`), res.status);
    }
    if (body !== null && body.status === "err") {
      const message = textOf(body.message) ?? textOf(body.response) ?? "rejected";
      throw txflowRefusal(what, message, res.status, venueCode, rejectCode, network);
    }
    if (res.status === 202 || body?.status === "pending") {
      throw new TxflowSendUnknown(`TxFlow ${what}`, new Error("the venue did not report the execution result in time (HTTP 202 pending)"), res.status, textOf(body?.txHash));
    }
    if (res.status >= 400 && res.status < 500) {
      // A gateway refusal without the err envelope: never reached execution.
      const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      throw txflowRefusal(what, textOf(body?.message) ?? textOf(body?.response) ?? `HTTP ${res.status} ${clean}`, res.status, venueCode, rejectCode, network);
    }
    if (!res.ok || body === null) {
      throw new TxflowSendUnknown(`TxFlow ${what}`, new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), res.status);
    }
    if (body.status !== "ok") throw new TxflowSendUnknown(`TxFlow ${what}`, new Error(`unexpected status ${JSON.stringify(body.status)}`), res.status);
    const data = body.data as { type?: unknown; data?: { statuses?: unknown } } | undefined;
    if (data === undefined) {
      // { status: "ok", traceId } = queued asynchronously (Outcome orders), not executed.
      throw new TxflowSendUnknown(`TxFlow ${what}`, new Error(`acknowledged without an execution result${textOf(body.traceId) !== null ? ` (traceId ${String(body.traceId)})` : ""}`), res.status);
    }
    const statuses = data?.data?.statuses;
    if (!Array.isArray(statuses) || statuses.length !== 1) {
      throw new TxflowSendUnknown(`TxFlow ${what}`, new Error("response has no single execution status"), res.status);
    }
    const st = statuses[0] as unknown;
    if (st !== null && typeof st === "object" && typeof (st as { error?: unknown }).error === "string") {
      throw txflowRefusal(what, (st as { error: string }).error, res.status, venueCode, rejectCode, network);
    }
    if (st !== "success") throw new TxflowSendUnknown(`TxFlow ${what}`, new Error(`unexpected execution status ${JSON.stringify(st)}`), res.status);
    // Docs (Exchange API § Response): with confirm "executed" the reply "carries confirm: executed".
    // Without that echo "success" only proves consensus acceptance, not execution → unknown.
    const echo = body.confirm ?? (data as { confirm?: unknown }).confirm;
    if (echo !== "executed") {
      throw new TxflowSendUnknown(`TxFlow ${what}`, new Error("the reply does not echo confirm: executed — accepted by consensus, execution not proven"), res.status);
    }
    return { type: typeof data.type === "string" ? data.type : null };
  }
}

// ── Writes (POST /exchange) ──

/** Where to apply for mainnet trading access (docs: Exchange API — "Mainnet access is whitelisted"). */
export const TXFLOW_APPLY_URL = "https://txflow.com/apply";

/** The send of a write could not be classified: it may have executed. Carries the cause. */
export class TxflowSendUnknown extends Error {
  constructor(readonly what: string, readonly cause: unknown, readonly status: number | null, readonly txHash: string | null = null) {
    super(`${what}: outcome unknown — ${extractErrorMessage(cause)}`);
    this.name = "TxflowSendUnknown";
  }
}

/** Signed envelope fields (signing.ts) — never logged. */
export interface TxflowSignedRequest {
  action: Record<string, unknown>;
  signature: { r: string; s: string; v: number };
  nonce: number;
}

/**
 * Venue refusal text → the typed refusal. The mainnet whitelist / access-code gate (accountStatus
 * reasons "User not in whitelist", "Exchange is not allowed", "User not authorized for this
 * channel", "User is blacklisted"; the gateway's "This action is not allowed.") and HTTP 403 are
 * POLICY_DENIED with the apply link; a missing account is DEPOSIT_REQUIRED; an unapproved agent
 * is AGENT_NOT_REGISTERED. Anything else keeps `fallback` (ORDER_REJECTED / ACTION_REJECTED).
 */
export function txflowRefusal(what: string, message: string, httpStatus: number, venueCode: number | null, fallback: ErrorCode, network: "mainnet" | "testnet"): PerpError {
  const base = { exchange: "txflow", sent: false, httpStatus, ...(venueCode !== null ? { venueCode } : {}) };
  const msg = `TxFlow ${what} refused: ${message}`;
  if (httpStatus === 403 || /whitelist|not allowed|not authorized for this channel|blacklist|access code/i.test(message)) {
    return new PerpError("POLICY_DENIED", msg, {
      ...base,
      remediation: network === "mainnet"
        ? `TxFlow mainnet trading is open to whitelisted accounts only — apply at ${TXFLOW_APPLY_URL}. Testnet is open: perp -n testnet -e txflow …`
        : `TxFlow refused this account (${message}). Check the account on the TxFlow testnet web app`,
    });
  }
  if (/deposit first|no trading account/i.test(message)) {
    return new PerpError("DEPOSIT_REQUIRED", msg, {
      ...base, remediation: network === "testnet"
        ? "Fund the account first (TxFlow testnet faucet in the TxFlow web app), then retry"
        : "Deposit USDC in the TxFlow web app first, then retry",
    });
  }
  if (/is not authorized by any account|agent .*not (approved|authorized)/i.test(message)) {
    return new PerpError("AGENT_NOT_REGISTERED", msg, {
      ...base, remediation: `Approve an agent: perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve txflow (or check it: perp wallet agent verify txflow)`,
    });
  }
  return new PerpError(fallback, msg, base);
}

function textOf(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// ── WS one-shot snapshot ──

/** The subset of a `ws` WebSocket the one-shot reader uses (a fake in tests). */
export interface WsLike {
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (data: unknown) => void): unknown;
  on(event: "error", cb: (err: unknown) => void): unknown;
  on(event: "close", cb: (code: number) => void): unknown;
  send(data: string): void;
  close(): void;
}

export type WsFactory = (url: string) => WsLike;

export const defaultWsFactory: WsFactory = url => new WebSocket(url, { handshakeTimeout: TXFLOW_WS_SNAPSHOT_TIMEOUT_MS }) as unknown as WsLike;

/** One raw `allAssetCtxs` entry: `coin` is the perpMeta `index` as a decimal string. */
export interface TxflowRawAssetCtx {
  coin: string;
  ctx: Record<string, unknown>;
}

/**
 * Open the socket, subscribe to `allAssetCtxs`, resolve with the first data frame's `ctxs`, close.
 * No frame within the timeout (or a socket error / close first) → EXCHANGE_UNREACHABLE; a frame
 * of an unexpected shape → EXCHANGE_ERROR (shape drift).
 */
export function fetchAllAssetCtxsOnce(
  wsUrl: string,
  factory: WsFactory = defaultWsFactory,
  timeoutMs: number = TXFLOW_WS_SNAPSHOT_TIMEOUT_MS,
): Promise<TxflowRawAssetCtx[]> {
  return new Promise((resolve, reject) => {
    let done = false;
    let ws: WsLike;
    const finish = (err: PerpError | null, value?: TxflowRawAssetCtx[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err !== null) reject(err);
      else resolve(value as TxflowRawAssetCtx[]);
    };
    const timer = setTimeout(() => finish(new PerpError("EXCHANGE_UNREACHABLE",
      `TxFlow allAssetCtxs snapshot: no data within ${timeoutMs / 1000}s`, { exchange: "txflow" })), timeoutMs);
    try {
      ws = factory(wsUrl);
    } catch (e) {
      clearTimeout(timer);
      reject(new PerpError("EXCHANGE_UNREACHABLE", `TxFlow WebSocket: ${extractErrorMessage(e)}`, { exchange: "txflow" }));
      return;
    }
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({ method: "subscribe", type: "allAssetCtxs", subscription: { type: "allAssetCtxs" } }));
      } catch (e) {
        finish(new PerpError("EXCHANGE_UNREACHABLE", `TxFlow WebSocket subscribe failed: ${extractErrorMessage(e)}`, { exchange: "txflow" }));
      }
    });
    ws.on("error", e => finish(new PerpError("EXCHANGE_UNREACHABLE", `TxFlow WebSocket: ${extractErrorMessage(e)}`, { exchange: "txflow" })));
    ws.on("close", code => finish(new PerpError("EXCHANGE_UNREACHABLE", `TxFlow WebSocket closed (code ${code}) before a snapshot arrived`, { exchange: "txflow" })));
    ws.on("message", raw => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return finish(txflowShapeError("WebSocket frame is not JSON"));
      }
      if (msg === null || typeof msg !== "object") return finish(txflowShapeError("WebSocket frame is not an object"));
      const m = msg as { channel?: unknown; data?: unknown };
      if (m.channel !== "allAssetCtxs") return; // pong / subscription acks / other channels
      const ctxs = (m.data as { ctxs?: unknown } | null | undefined)?.ctxs;
      if (!Array.isArray(ctxs)) return finish(txflowShapeError("allAssetCtxs frame has no ctxs array"));
      for (const c of ctxs) {
        if (c === null || typeof c !== "object" || typeof (c as { coin?: unknown }).coin !== "string"
          || (c as { ctx?: unknown }).ctx === null || typeof (c as { ctx?: unknown }).ctx !== "object") {
          return finish(txflowShapeError("allAssetCtxs entry without coin / ctx"));
        }
      }
      finish(null, ctxs as TxflowRawAssetCtx[]);
    });
  });
}
