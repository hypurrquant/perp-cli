/**
 * TxFlow transport — UNOFFICIAL API (see venues/txflow.ts).
 *
 *  - REST: `POST <rest>/info` with an HL-style `{type, ...}` body. Errors come back three ways and
 *    are all checked: a non-2xx status (403 "This action is not allowed." = the read is not on the
 *    venue's allowlist), HTTP 200 with a `{message}` body, or a body of an unexpected shape.
 *    There is no fallback for a refused read (no HL-endpoint substitution, no guessing).
 *  - WS one-shot: open → subscribe `allAssetCtxs` → first data frame → close (bulk mark / funding
 *    snapshot). The socket factory is injectable for tests.
 */

import WebSocket from "ws";
import { PerpError, extractErrorMessage } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";

export const TXFLOW_HTTP_TIMEOUT_MS = 15_000;
export const TXFLOW_WS_SNAPSHOT_TIMEOUT_MS = 10_000;

const UNOFFICIAL_REMEDIATION = (type: string) =>
  `TxFlow's unofficial API refused "${type}"; perp-cli cannot read this until it is updated (TxFlow has no official API yet)`;

/** Shape drift in the unofficial API: an explicit EXCHANGE_ERROR, never a guessed value. */
export function txflowShapeError(what: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `TxFlow unofficial API shape changed: ${what}`, {
    exchange: "txflow",
    remediation: "TxFlow's undocumented API changed; perp-cli needs an update to read it. TxFlow data is unavailable until then",
  });
}

function isMessageOnly(body: unknown): body is { message: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "message" && typeof (body as { message: unknown }).message === "string";
}

export class TxflowClient {
  constructor(
    private readonly restUrl: string,
    private readonly rateLimit: RateLimitPolicy,
  ) {}

  /** POST /info. Returns the parsed body; every error path is a PerpError. */
  async info<T = unknown>(body: { type: string } & Record<string, unknown>): Promise<T> {
    await acquireRate("txflow", this.rateLimit, body.type);
    let res: Response;
    try {
      res = await fetch(`${this.restUrl}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    if (res.status === 403) {
      throw new PerpError("EXCHANGE_ERROR", `TxFlow ${body.type}: HTTP 403 ${isMessageOnly(parsed) ? parsed.message : text.slice(0, 200)}`, {
        exchange: "txflow", status: 403, remediation: UNOFFICIAL_REMEDIATION(body.type),
      });
    }
    if (!res.ok) {
      // A 5xx can be a raw Cloudflare HTML page (live: candleSnapshot 1w / 3d → HTTP 500): tags stripped.
      const clean = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      throw new PerpError("EXCHANGE_ERROR", `TxFlow ${body.type}: HTTP ${res.status} ${clean}`, {
        exchange: "txflow", status: res.status, remediation: UNOFFICIAL_REMEDIATION(body.type),
      });
    }
    if (parsed === undefined) throw txflowShapeError(`${body.type} returned a non-JSON body`);
    // HTTP 200 with {message} is an error on this API ("Orderbook for coin '…' not found").
    if (isMessageOnly(parsed)) {
      throw new PerpError("EXCHANGE_ERROR", `TxFlow ${body.type}: ${parsed.message}`, {
        exchange: "txflow", remediation: UNOFFICIAL_REMEDIATION(body.type),
      });
    }
    return parsed as T;
  }
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
