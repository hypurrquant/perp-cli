/**
 * QFEX Trade WebSocket transport.
 *
 * The venue has no request id. Correlation therefore rests on four rules:
 *  1. ONE command at a time per connection (FIFO) — reads share the queue.
 *  2. An order is recognized by its GENERATED client order id only; every frame is ignored
 *     until an order_response for that id arrives (ACK or rejection), then the order is pinned
 *     to the `order_id` of that frame. A user-supplied id is never used (ids are not unique on
 *     the venue).
 *  3. The "sent" boundary is the call to `ws.send()`: a socket that is not OPEN before it =
 *     NOT SENT (definite). Anything that goes wrong after it — send callback error, close,
 *     timeout, ServerError, an error frame without a matching echo — is an UNKNOWN outcome
 *     (ORDER_PENDING). Nothing is ever re-sent or replayed.
 *  4. After any timeout / unknown outcome the connection is destroyed, so a late frame can
 *     never meet the next command. The next command opens a fresh, re-authenticated,
 *     re-subscribed connection.
 *
 * Status is never inferred from silence: a GTC / ALO order is returned as acknowledged
 * (pending) right after its ACK; "open" comes only from a get_user_orders row.
 *
 * cancel_on_disconnect is NOT in the message whitelist: this transport cannot send it.
 * (A different connection of the same user that enabled it — e.g. the official CLI — still
 * cancels all of the account's orders when THAT connection drops.)
 *
 * Idle: between commands the socket is unref()'d so it never keeps the process alive, and it
 * is closed after `idleCloseMs`. The server keeps an authenticated connection alive with
 * WebSocket ping frames (docs authenticate page); `ws` answers them automatically.
 */

import { WebSocket } from "ws";
import { PerpError, extractErrorMessage, orderNotSent, orderOutcomeUnknown } from "../../errors.js";
import { acquireRate } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";
import {
  qfexErrFrameError, qfexErrIsDefiniteRefusal, qfexOrderStatusError, qfexStatusClass, type QfexErrFrame,
} from "./errors.js";
import {
  QFEX_USER_ID_IS_ACCOUNT, decimalsEqual, fromWireNumber, isZeroDecimal, qfexNonce, qfexWsAuthMessage, subDecimals,
  sumDecimals, type QfexCredentials,
} from "./signing.js";

// ── Timeouts ──

export interface QfexTimeouts {
  connectMs: number;
  authMs: number;
  subscribeMs: number;
  /** First correlated order_response after an add / modify. */
  ackMs: number;
  /** IOC / FOK: terminal frame, measured from the send (includes the 500 ms speed bump). */
  immediateFinalMs: number;
  /**
   * ALO (post-only): how long after the send a terminal frame is awaited once the order was
   * ACKed. Docs (docs.qfex.com "Order Entry"): "If an ALO order would immediately match with an
   * existing order, it is **cancelled** instead." — the venue ACKs first and sends the CANCELLED
   * order_response afterwards (live production 2026-10-05). The docs give no timing for that
   * frame; the window covers the venue's 500 ms speed bump with margin. No frame in the window
   * = the order rests (as before).
   */
  postOnlyFinalMs: number;
  /** After a terminal frame: wait for fill frames until they add up. */
  fillsMs: number;
  cancelMs: number;
  readMs: number;
}

export const QFEX_TIMEOUTS: QfexTimeouts = {
  connectMs: 10_000, authMs: 10_000, subscribeMs: 10_000, ackMs: 5_000, immediateFinalMs: 10_000, postOnlyFinalMs: 3_000,
  fillsMs: 1_000, cancelMs: 5_000, readMs: 10_000,
};

/** Idle connection lifetime for long-lived processes (MCP server, bots). */
export const QFEX_IDLE_CLOSE_MS = 30_000;

const CHANNELS = ["order_responses", "fills", "stop_orders"] as const;

/**
 * Every message type this transport may send. `cancel_on_disconnect` is deliberately absent
 * (unit-test pinned): enabling it would cancel ALL of the account's orders when a one-shot
 * CLI connection closes.
 */
export const QFEX_SENDABLE_TYPES: ReadonlySet<string> = new Set([
  "auth", "subscribe", "add_order", "cancel_order", "modify_order", "cancel_all_orders", "cancel_stop_order", "get_user_orders",
]);

const MUTATING_TYPES: ReadonlySet<string> = new Set(["add_order", "cancel_order", "modify_order", "cancel_all_orders", "cancel_stop_order"]);
/** UNVERIFIED which messages draw on the venue's cancel bucket (Q14); cancels are kept on their own local bucket. */
const CANCEL_TYPES: ReadonlySet<string> = new Set(["cancel_order", "cancel_all_orders", "cancel_stop_order"]);

// ── Frames ──

export type QfexFrame = Record<string, unknown>;

export interface QfexOrderResponse {
  order_id: string;
  symbol: string;
  status: string;
  quantity: number;
  price: number;
  take_profit: number | null;
  stop_loss: number | null;
  side: "BUY" | "SELL";
  type: string;
  time_in_force: string;
  user_id: string;
  client_order_id: string;
  quantity_remaining: number;
  update_time: number;
  trade_id: string | null;
  /** Echo of the order's reduce-only flag (a JSON boolean on production frames; absent from the documented example). */
  reduce_only?: boolean;
}

export interface QfexFillResponse {
  trade_id: string;
  symbol: string;
  price: number;
  quantity: number;
  side: "BUY" | "SELL";
  order_id: string;
  client_order_id: string;
  fee: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `order_response` payload of a frame, or null. Only frames with the fields correlation needs qualify. */
export function orderResponseOf(frame: QfexFrame): QfexOrderResponse | null {
  const r = frame.order_response;
  if (!isRecord(r) || typeof r.order_id !== "string" || typeof r.status !== "string") return null;
  return r as unknown as QfexOrderResponse;
}

export function fillResponseOf(frame: QfexFrame): QfexFillResponse | null {
  const r = frame.fill_response;
  if (!isRecord(r) || typeof r.order_id !== "string" || typeof r.trade_id !== "string") return null;
  return r as unknown as QfexFillResponse;
}

/**
 * Error frame in any documented shape:
 *   { "err": { error_code, message, incoming_message } }            /websocket/errors + AsyncAPI
 *   { "type": "Err", error_code, message, incoming_message }         /websocket/rate
 *   { "type": "error", error_code, message }                         the docs' own client samples
 * An absent or empty (`{}`) incoming_message is "no echo".
 */
export function errFrameOf(frame: QfexFrame): QfexErrFrame | null {
  let body: Record<string, unknown> | null = null;
  if (isRecord(frame.err)) body = frame.err;
  else if ((frame.type === "Err" || frame.type === "error") && typeof frame.error_code === "string") body = frame;
  if (body === null || typeof body.error_code !== "string") return null;
  const inc = body.incoming_message;
  const echo = isRecord(inc) && typeof inc.type === "string"
    ? { type: inc.type, params: isRecord(inc.params) ? inc.params : {} }
    : null;
  return { errorCode: body.error_code, message: typeof body.message === "string" ? body.message : null, echo };
}

/** Auth outcome frame: both documented success shapes are accepted. */
function authVerdictOf(frame: QfexFrame): boolean | null {
  if (typeof frame.authenticated === "boolean") return frame.authenticated;
  if (frame.type === "auth" && typeof frame.result === "string") return frame.result === "success";
  return null;
}

function subscribedTo(frame: QfexFrame, channel: string): boolean {
  const s = frame.subscribed;
  if (s === channel) return true;
  if (Array.isArray(s) && s.includes(channel)) return true;
  // MDS-style confirmation: { type: "subscribed", channels: [...] }
  return frame.type === "subscribed" && Array.isArray(frame.channels) && frame.channels.includes(channel);
}

// ── Session ──

export interface QfexSessionOptions {
  /** wss://trade.qfex.com (no query). */
  url: string;
  network: "mainnet" | "testnet";
  credentials: QfexCredentials;
  /** Concrete account UUID the session authenticates as. */
  accountId: string;
  /** Builder code attached to the connection's auth; null = none. */
  builderCode: string | null;
  rateLimit: RateLimitPolicy;
  timeouts: QfexTimeouts;
  idleCloseMs: number;
}

type Waited = { kind: "frame"; frame: QfexFrame } | { kind: "timeout" } | { kind: "closed"; reason: string };

/** Frame source handed to a command body. */
export interface QfexCommandIo {
  /** Next frame, or timeout / close. A timeout or close marks the session for destruction unless `soft`. */
  next(deadlineAt: number, soft?: boolean): Promise<Waited>;
}

interface CommandSpec {
  type: string;
  params: Record<string, unknown>;
  /** For messages ("add_order AAPL-USD"). */
  what: string;
  /** Generated client order id of an order command (remediation + SIGINT notice); null otherwise. */
  clientOrderId: string | null;
  symbol: string | null;
}

interface Connection {
  ws: WebSocket;
  buffer: QfexFrame[];
  waiter: ((w: Waited) => void) | null;
  closed: string | null;
}

/** Remediation of an order whose outcome is unknown: the status lookup by generated client id. */
export function qfexPendingRemediation(spec: { clientOrderId: string | null; symbol: string | null }): string {
  const sym = spec.symbol === null ? "<symbol>" : spec.symbol.replace(/-USD$/, "");
  const check = spec.clientOrderId !== null
    ? `perp trade status c:${spec.clientOrderId} --symbol ${sym} -e qfex`
    : "perp account orders -e qfex / perp account positions -e qfex";
  return `Do NOT resubmit — the request may have been applied. Check: ${check}`;
}

export class QfexTradeSession {
  private conn: Connection | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlight: CommandSpec | null = null;
  /** Number of connections opened by this session (diagnostics / tests). */
  connectCount = 0;

  constructor(private readonly opts: QfexSessionOptions) {}

  // ── Connection ──

  private fail(conn: Connection, w: Waited): void {
    const waiter = conn.waiter;
    conn.waiter = null;
    if (waiter !== null) waiter(w);
  }

  private nextFrame(conn: Connection, deadlineAt: number): Promise<Waited> {
    const buffered = conn.buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ kind: "frame", frame: buffered });
    if (conn.closed !== null) return Promise.resolve({ kind: "closed", reason: conn.closed });
    const ms = deadlineAt - Date.now();
    if (ms <= 0) return Promise.resolve({ kind: "timeout" });
    return new Promise<Waited>(resolve => {
      const timer = setTimeout(() => { conn.waiter = null; resolve({ kind: "timeout" }); }, ms);
      conn.waiter = w => { clearTimeout(timer); resolve(w); };
    });
  }

  /** Drop the connection without a closing handshake; its late frames go nowhere. */
  private destroy(): void {
    const conn = this.conn;
    this.conn = null;
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (conn === null) return;
    conn.ws.removeAllListeners();
    conn.ws.on("error", () => { /* a socket being torn down may still emit; nothing depends on it */ });
    conn.ws.terminate();
    if (conn.closed === null) conn.closed = "destroyed";
    this.fail(conn, { kind: "closed", reason: "destroyed" });
  }

  /** Close the connection (normal closure). Safe to call at any time; queued after the running command. */
  async close(): Promise<void> {
    // Through the FIFO queue: a command queued while an earlier one runs must never have its
    // socket closed under it — the close runs strictly between commands.
    await this.enqueue(async () => {
      const conn = this.conn;
      this.conn = null;
      if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      if (conn !== null && conn.closed === null) conn.ws.close(1000);
    });
  }

  private setRef(conn: Connection, ref: boolean): void {
    // `ws` exposes the underlying net.Socket as `_socket`; (un)ref decides whether an idle
    // connection keeps the process alive.
    const sock = (conn.ws as unknown as { _socket?: { ref(): void; unref(): void } | null })._socket;
    if (sock === undefined || sock === null) return;
    if (ref) sock.ref(); else sock.unref();
  }

  /** true when nothing owned by this session keeps the event loop alive. */
  isIdleUnref(): boolean {
    const conn = this.conn;
    if (conn === null) return true;
    const sock = (conn.ws as unknown as { _socket?: { _handle?: { hasRef?(): boolean } | null } | null })._socket;
    const socketRef = sock?._handle?.hasRef?.() === true;
    const timerRef = this.idleTimer !== null && this.idleTimer.hasRef();
    return this.inFlight === null && !socketRef && !timerRef;
  }

  private sendRaw(conn: Connection, msg: { type: string }): Promise<void> {
    if (!QFEX_SENDABLE_TYPES.has(msg.type)) {
      throw new PerpError("INVALID_PARAMS", `QFEX transport refuses to send message type "${msg.type}"`);
    }
    return new Promise<void>((resolve, reject) => {
      conn.ws.send(JSON.stringify(msg), err => (err ? reject(err) : resolve()));
    });
  }

  private notReady(code: "EXCHANGE_UNREACHABLE" | "TIMEOUT" | "SIGNATURE_FAILED" | "POLICY_DENIED" | "EXCHANGE_ERROR", message: string, remediation: string): PerpError {
    return new PerpError(code, `QFEX trade connection: ${message}`, { exchange: "qfex", sent: false, remediation });
  }

  /** connect → auth → subscribe. Every failure here is BEFORE any command was sent. */
  private async open(): Promise<Connection> {
    const t = this.opts.timeouts;
    const url = `${this.opts.url.replace(/\/+$/, "")}/?api_key=${encodeURIComponent(this.opts.credentials.publicKey)}`;
    const ws = new WebSocket(url, { handshakeTimeout: t.connectMs });
    const conn: Connection = { ws, buffer: [], waiter: null, closed: null };
    this.connectCount += 1;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(this.notReady("TIMEOUT", `connect timed out after ${t.connectMs}ms`, `Check network connectivity to ${this.opts.url}`)); }, t.connectMs);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", e => { clearTimeout(timer); reject(this.notReady("EXCHANGE_UNREACHABLE", `connect failed: ${extractErrorMessage(e)}`, `Check network connectivity to ${this.opts.url}`)); });
    });
    ws.removeAllListeners("error");
    ws.on("error", e => {
      if (conn.closed === null) conn.closed = `socket error: ${extractErrorMessage(e)}`;
      this.fail(conn, { kind: "closed", reason: conn.closed });
    });
    ws.on("close", (code, reason) => {
      if (conn.closed === null) conn.closed = `closed by the venue (code ${code}${reason.length > 0 ? `: ${reason.toString()}` : ""})`;
      if (this.conn === conn) this.conn = null;
      this.fail(conn, { kind: "closed", reason: conn.closed });
    });
    ws.on("message", data => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        frame = { unparsed: data.toString().slice(0, 500) };
      }
      const f: QfexFrame = isRecord(frame) ? frame : { nonObject: frame };
      if (conn.waiter !== null) {
        const w = conn.waiter;
        conn.waiter = null;
        w({ kind: "frame", frame: f });
      } else {
        conn.buffer.push(f);
      }
    });

    try {
      // auth
      await this.sendRaw(conn, qfexWsAuthMessage(this.opts.credentials, this.opts.accountId, this.opts.builderCode, Date.now(), qfexNonce()));
      const authDeadline = Date.now() + t.authMs;
      for (;;) {
        const w = await this.nextFrame(conn, authDeadline);
        if (w.kind === "timeout") throw this.notReady("TIMEOUT", `no authentication result within ${t.authMs}ms`, "Retry; if it persists check the system clock and the key (perp wallet agent verify qfex)");
        if (w.kind === "closed") throw this.notReady("SIGNATURE_FAILED", `closed during authentication (${w.reason})`, "Check the system clock, the key and the account id: perp wallet agent verify qfex");
        const err = errFrameOf(w.frame);
        if (err !== null) {
          const e = qfexErrFrameError(err, "authentication");
          const code = e.structured.code === "POLICY_DENIED" ? "POLICY_DENIED" : "SIGNATURE_FAILED";
          throw this.notReady(code, `authentication refused: ${err.errorCode}${err.message !== null ? ` — ${err.message}` : ""}`,
            e.structured.remediation ?? "Check the system clock, the key and the account id: perp wallet agent verify qfex");
        }
        const verdict = authVerdictOf(w.frame);
        if (verdict === true) break;
        if (verdict === false) throw this.notReady("SIGNATURE_FAILED", "authentication refused", "Check the system clock, the key and the account id: perp wallet agent verify qfex");
      }
      // subscribe — one message per channel, each confirmed.
      for (const channel of CHANNELS) {
        await this.sendRaw(conn, { type: "subscribe", params: { channels: [channel] } } as { type: string });
        const deadline = Date.now() + t.subscribeMs;
        for (;;) {
          const w = await this.nextFrame(conn, deadline);
          if (w.kind === "timeout") throw this.notReady("TIMEOUT", `no confirmation of the ${channel} subscription within ${t.subscribeMs}ms`, "Retry");
          if (w.kind === "closed") throw this.notReady("EXCHANGE_UNREACHABLE", `closed while subscribing to ${channel} (${w.reason})`, "Retry");
          const err = errFrameOf(w.frame);
          if (err !== null) throw this.notReady("EXCHANGE_ERROR", `subscription to ${channel} refused: ${err.errorCode}${err.message !== null ? ` — ${err.message}` : ""}`, "Check the key's View orders permission in QFEX Developer Settings");
          if (subscribedTo(w.frame, channel)) break;
        }
      }
    } catch (e) {
      ws.removeAllListeners();
      ws.on("error", () => { /* torn down */ });
      ws.terminate();
      if (e instanceof PerpError) throw e;
      throw this.notReady("EXCHANGE_UNREACHABLE", `setup failed: ${extractErrorMessage(e)}`, "Retry");
    }
    return conn;
  }

  /** Authenticate only (key import): connect + auth + subscribe, then close. Sends no command. */
  async verifyAuth(): Promise<void> {
    await this.enqueue(async () => {
      const conn = await this.open();
      this.conn = conn;
      await this.closeNow(conn);
    });
  }

  private closeNow(conn: Connection): Promise<void> {
    if (this.conn === conn) this.conn = null;
    if (conn.closed !== null) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { conn.ws.terminate(); resolve(); }, 2_000);
      conn.ws.once("close", () => { clearTimeout(timer); resolve(); });
      conn.ws.close(1000);
    });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  // ── Command execution ──

  private onSigint = (): void => {
    const spec = this.inFlight;
    if (spec !== null) {
      process.stderr.write(
        `\n[qfex] ORDER_PENDING: interrupted while ${spec.what} was in flight — its outcome is unknown. `
        + `${qfexPendingRemediation(spec)}${spec.clientOrderId !== null ? ` (c:${spec.clientOrderId})` : ""}\n`,
      );
    }
    // No other SIGINT handler → keep the default behaviour (exit 130).
    if (process.listenerCount("SIGINT") <= 1) process.exit(130);
  };

  /**
   * Run one command: wait for the queue, connect if needed, send, then let `body` read frames.
   * Throws PerpError. Mutating commands: not-sent failures are definite (ORDER_REJECTED "not
   * sent"), post-send failures are ORDER_PENDING. The session is destroyed after any timeout,
   * close or thrown non-definite error inside `body`.
   */
  private transact<T>(spec: CommandSpec, body: (io: QfexCommandIo, sentAt: number) => Promise<T>): Promise<T> {
    const mutating = MUTATING_TYPES.has(spec.type);
    return this.enqueue(async () => {
      if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      // ── before send: every failure is "not sent" ──
      let conn: Connection;
      try {
        if (this.conn === null || this.conn.closed !== null) this.conn = await this.open();
        conn = this.conn;
        this.setRef(conn, true);
        const bucket = `qfex:${this.opts.network}:${CANCEL_TYPES.has(spec.type) ? "cancel" : "ws"}`;
        await acquireRate(bucket, this.opts.rateLimit, spec.type);
        conn.buffer.length = 0; // frames that arrived between commands belong to no command
        if (conn.closed !== null || conn.ws.readyState !== WebSocket.OPEN) {
          throw this.notReady("EXCHANGE_UNREACHABLE", `not open before sending ${spec.what} (${conn.closed ?? `readyState ${conn.ws.readyState}`})`, "Retry — nothing was sent");
        }
      } catch (e) {
        this.destroy();
        throw mutating ? orderNotSent("qfex", spec.what, e) : e;
      }

      // ── send: from here on a mutating command's outcome is unknown unless the venue answers ──
      let unknown = false;
      this.inFlight = spec;
      if (mutating) process.on("SIGINT", this.onSigint);
      const sentAt = Date.now();
      try {
        try {
          await this.sendRaw(conn, { type: spec.type, params: spec.params } as { type: string });
        } catch (e) {
          unknown = true;
          if (mutating) throw orderOutcomeUnknown("qfex", spec.what, new Error(`socket error while sending: ${extractErrorMessage(e)}`), qfexPendingRemediation(spec));
          throw new PerpError("EXCHANGE_UNREACHABLE", `QFEX ${spec.what}: send failed: ${extractErrorMessage(e)}`, { exchange: "qfex" });
        }
        const io: QfexCommandIo = {
          next: async (deadlineAt, soft) => {
            const w = await this.nextFrame(conn, deadlineAt);
            if (w.kind === "closed" || (w.kind === "timeout" && soft !== true)) unknown = true;
            return w;
          },
        };
        return await body(io, sentAt);
      } catch (e) {
        if (!(e instanceof PerpError) || e.structured.code === "ORDER_PENDING" || e.structured.code === "TIMEOUT" || e.structured.code === "EXCHANGE_UNREACHABLE") unknown = true;
        throw e;
      } finally {
        this.inFlight = null;
        if (mutating) process.removeListener("SIGINT", this.onSigint);
        if (unknown) {
          this.destroy();
        } else if (this.conn === conn && conn.closed === null) {
          this.setRef(conn, false);
          this.idleTimer = setTimeout(() => { void this.close(); }, this.opts.idleCloseMs);
          this.idleTimer.unref();
        }
      }
    });
  }

  /** Unknown-outcome error of a mutating command (ORDER_PENDING, with the c:<id> lookup). */
  private pending(spec: CommandSpec, reason: string, extra: Record<string, unknown>): PerpError {
    const e = orderOutcomeUnknown("qfex", spec.what, new Error(reason), qfexPendingRemediation(spec));
    return new PerpError("ORDER_PENDING", e.message, {
      ...(e.structured.details ?? {}), ...extra, exchange: "qfex",
      ...(spec.clientOrderId !== null ? { clientOrderId: spec.clientOrderId } : {}),
      remediation: e.structured.remediation,
    });
  }

  /**
   * An error frame during a command. Read: the mapped error. Mutating: a definite refusal only
   * when the venue echoed THIS request and the code is a refusal; otherwise unknown.
   */
  private errOutcome(spec: CommandSpec, err: QfexErrFrame, echoKey: string | null): PerpError {
    if (!MUTATING_TYPES.has(spec.type)) return qfexErrFrameError(err, spec.what);
    const echoMatches = err.echo !== null && err.echo.type === spec.type
      && (echoKey === null || err.echo.params[echoKey] === spec.params[echoKey]);
    if (qfexErrIsDefiniteRefusal(err, echoMatches)) return qfexErrFrameError(err, spec.what);
    const why = err.echo === null
      ? `error frame ${err.errorCode} without a request echo — it cannot be attributed to this request`
      : !echoMatches ? `error frame ${err.errorCode} echoing a different request` : `${err.errorCode}${err.message !== null ? `: ${err.message}` : ""}`;
    return this.pending(spec, why, { venueCode: err.errorCode });
  }

  private assertUser(spec: CommandSpec, r: QfexOrderResponse, mismatches: string[]): void {
    if (typeof r.user_id !== "string" || r.user_id === this.opts.accountId) return;
    if (QFEX_USER_ID_IS_ACCOUNT === true) {
      throw this.pending(spec, `order_response.user_id ${r.user_id} is not the session account ${this.opts.accountId}`, { alarm: "userIdMismatch", venueRaw: r });
    }
    if (!mismatches.includes(r.user_id)) mismatches.push(r.user_id);
  }

  // ── Orders ──

  /**
   * add_order. Resolves once the venue has answered for THIS order as far as the order type
   * allows: `immediate` (IOC / FOK) waits for a terminal frame; a resting order returns right
   * after its first correlated frame — except `postOnly` (ALO), which waits postOnlyFinalMs for
   * the venue's CANCELLED frame (it would have crossed) before it is reported resting. Throws the mapped rejection (definite), or ORDER_PENDING
   * when nothing correlated arrived (session destroyed).
   */
  addOrder(req: {
    params: Record<string, unknown> & { symbol: string; client_order_id: string };
    immediate: boolean;
    /** ALO: see QfexTimeouts.postOnlyFinalMs. */
    postOnly?: boolean;
    lotSize: string;
    band: { lower: string; upper: string } | null;
  }): Promise<QfexAddResult> {
    const clientOrderId = req.params.client_order_id;
    const spec: CommandSpec = { type: "add_order", params: req.params, what: `add_order ${req.params.symbol}`, clientOrderId, symbol: req.params.symbol };
    const t = this.opts.timeouts;
    return this.transact(spec, async (io, sentAt) => {
      const frames: QfexFrame[] = [];
      const responses: QfexOrderResponse[] = [];
      const fillFrames: QfexFillResponse[] = [];
      const userIdMismatches: string[] = [];
      let orderId: string | null = null;
      const qty = (n: unknown, what: string): string => fromWireNumber(n, req.lotSize, what);
      const result = (ended: QfexAddResult["ended"], terminal: QfexOrderResponse | null): QfexAddResult => {
        const byTrade = new Map<string, QfexFillResponse>();
        for (const f of fillFrames) if (f.order_id === orderId && !byTrade.has(f.trade_id)) byTrade.set(f.trade_id, f);
        const fills = [...byTrade.values()];
        return { orderId: orderId as string, clientOrderId, responses, fills, terminal, ended, frames, userIdMismatches };
      };

      // 1. First correlated frame: an order_response carrying OUR generated client id.
      const ackDeadline = sentAt + t.ackMs;
      let first: QfexOrderResponse | null = null;
      while (first === null) {
        const w = await io.next(ackDeadline);
        if (w.kind !== "frame") {
          throw this.pending(spec, w.kind === "timeout" ? `no order_response for client id ${clientOrderId} within ${t.ackMs}ms` : `connection lost before any order_response (${w.reason})`, { frames });
        }
        frames.push(w.frame);
        const err = errFrameOf(w.frame);
        if (err !== null) throw this.errOutcome(spec, err, "client_order_id");
        const fill = fillResponseOf(w.frame);
        if (fill !== null) { fillFrames.push(fill); continue; }
        const r = orderResponseOf(w.frame);
        if (r !== null && r.client_order_id === clientOrderId) first = r;
      }
      this.assertUser(spec, first, userIdMismatches);
      orderId = first.order_id;
      responses.push(first);
      const firstClass = qfexStatusClass(first.status);
      if (firstClass === "reject") throw qfexOrderStatusError(first.status, { what: spec.what, band: req.band }, first);

      // 2. Terminal?
      const isTerminal = (r: QfexOrderResponse): boolean => {
        const c = qfexStatusClass(r.status);
        return c === "terminal" || (c === "fill" && isZeroDecimal(qty(r.quantity_remaining, "quantity_remaining")));
      };
      let terminal: QfexOrderResponse | null = isTerminal(first) ? first : null;
      const postOnly = !req.immediate && req.postOnly === true;
      if (terminal === null && !req.immediate && !postOnly) return result("resting", null);

      const finalDeadline = sentAt + (postOnly ? t.postOnlyFinalMs : t.immediateFinalMs);
      while (terminal === null) {
        const w = await io.next(finalDeadline);
        // ALO: no terminal frame in its window = it was not cancelled for crossing — it rests.
        if (w.kind !== "frame") return result(w.kind !== "timeout" ? "closed" : postOnly ? "resting" : "timeout", null);
        frames.push(w.frame);
        const fill = fillResponseOf(w.frame);
        if (fill !== null) { fillFrames.push(fill); continue; }
        const r = orderResponseOf(w.frame);
        if (r === null || r.order_id !== orderId) continue; // another order's event, an error for nothing we sent, or an unknown frame
        this.assertUser(spec, r, userIdMismatches);
        responses.push(r);
        if (qfexStatusClass(r.status) === "reject") {
          // A rejection after the ACK is "never traded" only when NOTHING says it filled: no fill
          // frame, no earlier order_response with a fill status (e.g. PARTIALLY FILLED seen before
          // its fill frame arrived) and no response — this one included — with less remaining
          // than ordered. Otherwise it is the terminal frame of a partly filled order.
          const responded = responses.some(x => qfexStatusClass(x.status) === "fill"
            || !isZeroDecimal(subDecimals(qty(x.quantity, "quantity"), qty(x.quantity_remaining, "quantity_remaining"), "filled quantity")));
          if (!responded && !fillFrames.some(f => f.order_id === orderId)) throw qfexOrderStatusError(r.status, { what: spec.what, band: req.band }, r);
          terminal = r;
        } else if (isTerminal(r)) {
          terminal = r;
        }
      }

      // 3. Fill frames until they add up to quantity − quantity_remaining (soft wait).
      const expected = subDecimals(qty(terminal.quantity, "quantity"), qty(terminal.quantity_remaining, "quantity_remaining"), "filled quantity");
      const fillsDeadline = Date.now() + t.fillsMs;
      for (;;) {
        const got = sumDecimals(result("terminal", terminal).fills.map(f => qty(f.quantity, "fill quantity")));
        if (decimalsEqual(got, expected)) break;
        const w = await io.next(fillsDeadline, true);
        if (w.kind !== "frame") break;
        frames.push(w.frame);
        const fill = fillResponseOf(w.frame);
        if (fill !== null) fillFrames.push(fill);
      }
      return result("terminal", terminal);
    });
  }

  /**
   * cancel_order by ORDER ID (the adapter resolves client ids first: a client-id cancel would
   * cancel every order sharing that id). Never throws for an unproven cancel — "unknown".
   */
  cancelOrder(symbol: string, orderId: string): Promise<QfexCancelOutcome> {
    return this.cancelById({ type: "cancel_order", params: { symbol, order_id: orderId, cancel_order_id_type: "order_id" }, what: `cancel_order ${orderId}`, clientOrderId: null, symbol }, "order_id", orderId);
  }

  /** cancel_stop_order (TAKE_PROFIT / STOP_LOSS rows of get_user_orders). */
  cancelStopOrder(symbol: string, stopOrderId: string): Promise<QfexCancelOutcome> {
    return this.cancelById({ type: "cancel_stop_order", params: { stop_order_id: stopOrderId }, what: `cancel_stop_order ${stopOrderId}`, clientOrderId: null, symbol }, "stop_order_id", stopOrderId);
  }

  private async cancelById(spec: CommandSpec, echoKey: string, id: string): Promise<QfexCancelOutcome> {
    const t = this.opts.timeouts;
    try {
      return await this.transact(spec, async (io, sentAt): Promise<QfexCancelOutcome> => {
        const deadline = sentAt + t.cancelMs;
        for (;;) {
          const w = await io.next(deadline);
          if (w.kind !== "frame") {
            return { kind: "unknown", reason: w.kind === "timeout" ? `no cancel confirmation within ${t.cancelMs}ms` : `connection lost (${w.reason})` };
          }
          const err = errFrameOf(w.frame);
          if (err !== null) throw this.errOutcome(spec, err, echoKey);
          const r = orderResponseOf(w.frame);
          if (r === null || r.order_id !== id) continue;
          const c = qfexStatusClass(r.status);
          if (r.status === "CANCELLED" || r.status === "CANCELLED_STP" || r.status === "IOC_CANCELLED" || r.status === "EXPIRED") return { kind: "cancelled", frame: r };
          if (c === "reject") return { kind: "refused", status: r.status, frame: r };
          if (c === "fill" && isZeroDecimal(fromWireNumber(r.quantity_remaining, "0.000000000001", "quantity_remaining"))) {
            return { kind: "refused", status: "FILLED", frame: r };
          }
        }
      });
    } catch (e) {
      // ORDER_PENDING (unknown outcome after send) is reported per order, not thrown.
      if (e instanceof PerpError && e.structured.code === "ORDER_PENDING") return { kind: "unknown", reason: e.message };
      throw e;
    }
  }

  /**
   * cancel_all_orders. The venue documents no completion signal: CANCELLED frames for the
   * `expected` order ids are collected until all arrived or the window ends. What is not
   * proven here is settled by the caller's verifying get_user_orders.
   */
  async cancelAll(symbol: string | null, expected: ReadonlySet<string>, watch: ReadonlySet<string> = expected): Promise<{ cancelled: string[]; frames: QfexFrame[]; complete: boolean; note: string | null }> {
    const params: Record<string, unknown> = symbol === null ? {} : { symbol };
    const spec: CommandSpec = { type: "cancel_all_orders", params, what: `cancel_all_orders ${symbol ?? "(all symbols)"}`, clientOrderId: null, symbol };
    const t = this.opts.timeouts;
    try {
      return await this.transact(spec, async (io, sentAt) => {
        const cancelled = new Set<string>();
        const frames: QfexFrame[] = [];
        const deadline = sentAt + t.cancelMs;
        const done = () => [...expected].every(id => cancelled.has(id));
        while (!done()) {
          const w = await io.next(deadline);
          if (w.kind !== "frame") {
            return { cancelled: [...cancelled], frames, complete: false, note: w.kind === "timeout" ? `window of ${t.cancelMs}ms ended` : `connection lost (${w.reason})` };
          }
          frames.push(w.frame);
          const err = errFrameOf(w.frame);
          if (err !== null) throw this.errOutcome(spec, err, null);
          const r = orderResponseOf(w.frame);
          // `watch` ⊇ expected: CANCELLED frames of other listed orders (stops — whether cancel_all
          // also cancels them is unverified, Q8) are recorded as proof too, without being waited for.
          if (r !== null && (expected.has(r.order_id) || watch.has(r.order_id)) && (r.status === "CANCELLED" || r.status === "CANCELLED_STP")) cancelled.add(r.order_id);
        }
        return { cancelled: [...cancelled], frames, complete: true, note: null };
      });
    } catch (e) {
      if (e instanceof PerpError && e.structured.code === "ORDER_PENDING") return { cancelled: [], frames: [], complete: false, note: e.message };
      throw e;
    }
  }

  /**
   * modify_order (wire function; the adapter keeps amend gated until Q5 is verified).
   * The reply carries a NEW order_id. It is accepted only when it is MODIFIED, carries the
   * client id of the order being modified AND its symbol / side / type / price / quantity equal
   * the request. A CANNOT_MODIFY_* / rejection frame is matched on the OLD order id.
   */
  modifyOrder(req: {
    params: Record<string, unknown> & { symbol: string; order_id: string; side: string; order_type: string; price: number; quantity: number };
    clientOrderId: string;
    lotSize: string;
    tickSize: string;
  }): Promise<QfexOrderResponse> {
    const spec: CommandSpec = { type: "modify_order", params: req.params, what: `modify_order ${req.params.order_id}`, clientOrderId: req.clientOrderId, symbol: req.params.symbol };
    const t = this.opts.timeouts;
    const sameNumber = (a: unknown, b: number, step: string, what: string): boolean =>
      decimalsEqual(fromWireNumber(a, step, what), fromWireNumber(b, step, what));
    return this.transact(spec, async (io, sentAt) => {
      const deadline = sentAt + t.ackMs;
      for (;;) {
        const w = await io.next(deadline);
        if (w.kind !== "frame") throw this.pending(spec, w.kind === "timeout" ? `no MODIFIED order_response within ${t.ackMs}ms` : `connection lost (${w.reason})`, {});
        const err = errFrameOf(w.frame);
        if (err !== null) throw this.errOutcome(spec, err, "order_id");
        const r = orderResponseOf(w.frame);
        if (r === null) continue;
        if (r.order_id === req.params.order_id && qfexStatusClass(r.status) === "reject") {
          throw qfexOrderStatusError(r.status, { what: spec.what, band: null }, r);
        }
        if (r.status === "MODIFIED" && r.client_order_id === req.clientOrderId && r.symbol === req.params.symbol
          && r.side === req.params.side && r.type === req.params.order_type
          && sameNumber(r.price, req.params.price, req.tickSize, "price") && sameNumber(r.quantity, req.params.quantity, req.lotSize, "quantity")) {
          return r;
        }
      }
    });
  }

  // ── Reads ──

  /** get_user_orders: every open order (stops included as TAKE_PROFIT / STOP_LOSS rows), all pages. */
  async getUserOrders(symbol: string | null): Promise<QfexOrderResponse[]> {
    const limit = 100;
    const out: QfexOrderResponse[] = [];
    for (let offset = 0; ; offset += limit) {
      const params: Record<string, unknown> = { limit, offset };
      if (symbol !== null) params.symbol = symbol;
      const spec: CommandSpec = { type: "get_user_orders", params, what: `get_user_orders${symbol !== null ? ` ${symbol}` : ""}`, clientOrderId: null, symbol };
      const t = this.opts.timeouts;
      const page = await this.transact(spec, async (io, sentAt): Promise<QfexOrderResponse[]> => {
        const deadline = sentAt + t.readMs;
        for (;;) {
          const w = await io.next(deadline);
          if (w.kind === "timeout") throw new PerpError("TIMEOUT", `QFEX ${spec.what}: no all_orders_response within ${t.readMs}ms`, { exchange: "qfex" });
          if (w.kind === "closed") throw new PerpError("EXCHANGE_UNREACHABLE", `QFEX ${spec.what}: connection lost (${w.reason})`, { exchange: "qfex" });
          const err = errFrameOf(w.frame);
          if (err !== null) throw this.errOutcome(spec, err, null);
          const body = w.frame.all_orders_response;
          if (!isRecord(body)) continue;
          if (body.orders !== null && body.orders !== undefined && !Array.isArray(body.orders)) {
            throw new PerpError("EXCHANGE_ERROR", `QFEX ${spec.what}: all_orders_response.orders is not a list`, { exchange: "qfex" });
          }
          // A JSON null list is the venue's encoding of "no rows".
          return (Array.isArray(body.orders) ? body.orders : []) as QfexOrderResponse[];
        }
      });
      out.push(...page);
      if (page.length < limit) return out;
    }
  }
}

export interface QfexAddResult {
  orderId: string;
  clientOrderId: string;
  /** Correlated order_response frames in arrival order ([0] = the ACK or first status). */
  responses: QfexOrderResponse[];
  /** fill_response frames of this order, de-duplicated by trade_id. */
  fills: QfexFillResponse[];
  /** The venue frame after which nothing of the order can execute; null when none arrived. */
  terminal: QfexOrderResponse | null;
  /** Why waiting stopped: a terminal frame, a resting order's ACK, or a timeout / close after the ACK. */
  ended: "terminal" | "resting" | "timeout" | "closed";
  frames: QfexFrame[];
  /** user_id values that differ from the session account (Q22 unverified — reported, not failed). */
  userIdMismatches: string[];
}

export type QfexCancelOutcome =
  | { kind: "cancelled"; frame: QfexOrderResponse }
  /** The venue answered for this order and did NOT cancel it (NO_SUCH_ORDER, REJECTED, already FILLED). */
  | { kind: "refused"; status: string; frame: QfexOrderResponse }
  /** Sent, not proven either way. */
  | { kind: "unknown"; reason: string };

// ── Session registry (one per network + key + account + builder code) ──

const sessions = new Map<string, QfexTradeSession>();

/** The process-wide session for this identity. A different builder code (or --no-builder) is a different session. */
export function qfexTradeSession(opts: QfexSessionOptions): QfexTradeSession {
  const key = `${opts.network}|${opts.credentials.publicKey}|${opts.accountId}|${opts.builderCode ?? ""}`;
  let s = sessions.get(key);
  if (s === undefined) {
    s = new QfexTradeSession(opts);
    sessions.set(key, s);
  }
  return s;
}

// ── MDS (public market data) one-shot snapshot ──

export interface QfexMdsSnapshot {
  /** Venue symbol → mark price entry (each carries its own venue timestamp). */
  marks: Map<string, { price: string; time: number }>;
  /** Venue symbol → open interest (base units). */
  openInterest: Map<string, string>;
  /** Venue symbol → 24h volume, quote notional. */
  volumeNotional: Map<string, string>;
  frame: QfexFrame;
}

function entries(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/** Parse one `market_stats` frame. */
export function parseMarketStats(frame: QfexFrame): QfexMdsSnapshot {
  const marks = new Map<string, { price: string; time: number }>();
  for (const m of entries(frame.mark_prices)) {
    if (typeof m.symbol !== "string" || typeof m.price !== "string" || typeof m.time !== "string") continue;
    const time = Date.parse(m.time);
    if (!Number.isFinite(time)) continue;
    marks.set(m.symbol, { price: m.price, time });
  }
  const openInterest = new Map<string, string>();
  for (const o of entries(frame.open_interests)) {
    if (typeof o.symbol === "string" && o.symbol !== "" && typeof o.open_interest === "string") openInterest.set(o.symbol, o.open_interest);
  }
  const volumeNotional = new Map<string, string>();
  for (const v of entries(frame.daily_volumes_notional)) {
    if (typeof v.symbol === "string" && typeof v.volume === "string") volumeNotional.set(v.symbol, v.volume);
  }
  return { marks, openInterest, volumeNotional, frame };
}

/** How long a one-shot MDS snapshot may take (connect + first market_stats frame). */
export const QFEX_MDS_TIMEOUT_MS = 3_000;

/**
 * One `market_stats` snapshot from the public MDS WebSocket, then close. `symbol` = one venue
 * symbol (order reference prices) or "*" (scans / listings). Throws PRICE_STALE when no
 * snapshot arrives in time — never substitutes index / last / mid.
 */
export function fetchQfexMarketStats(mdsUrl: string, symbol: string, timeoutMs: number): Promise<QfexMdsSnapshot> {
  return new Promise<QfexMdsSnapshot>((resolve, reject) => {
    const ws = new WebSocket(mdsUrl, { handshakeTimeout: timeoutMs });
    let done = false;
    const finish = (err: PerpError | null, snap: QfexMdsSnapshot | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on("error", () => { /* torn down */ });
      ws.terminate();
      if (snap !== null) resolve(snap); else reject(err);
    };
    const stale = (why: string): PerpError => new PerpError("PRICE_STALE", `QFEX market data (${symbol}): ${why}`, {
      exchange: "qfex", remediation: `Retry shortly; the mark price comes only from ${mdsUrl} (market_stats) — no other price is substituted`,
    });
    const timer = setTimeout(() => finish(stale(`no market_stats snapshot within ${timeoutMs}ms`), null), timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", channels: ["market_stats"], symbols: [symbol] })));
    ws.on("error", e => finish(stale(`connection failed: ${extractErrorMessage(e)}`), null));
    ws.on("close", () => finish(stale("connection closed before a snapshot arrived"), null));
    ws.on("message", data => {
      let frame: unknown;
      try { frame = JSON.parse(data.toString()); } catch { return; /* not a snapshot; keep waiting until the timeout */ }
      if (isRecord(frame) && frame.type === "market_stats") finish(null, parseMarketStats(frame));
    });
  });
}
