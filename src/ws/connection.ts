/**
 * Connection core (§3, §5.2): one socket (a venue stream holds one or more) with an explicit state machine
 * (idle → connecting → live ⇄ stale → reconnecting → … → closed), an app heartbeat, staleness from
 * MESSAGE timestamps (not timer ticks), visibility re-evaluation, bounded backoff with jitter, a
 * per-venue new-connection budget (delays, never skips) and an outbound rate limiter.
 */

import { WS_ERROR_CODES, WsError, isPerpError, type WsErrorCode } from "./errors.js";
import type { Redactor } from "./redact.js";
import { frameText } from "./transport.js";
import type { CloseReason, ConnectionState, StreamLog, VenueId, WsFactory, WsLike } from "./types.js";

export const HANDSHAKE_REMEDIATION =
  "connection refused before open — network, venue outage, or Origin/CORS block (see capability matrix: browser)";

export const MAX_PAYLOAD_REMEDIATION =
  "Raise the cap: createVenueStream(codec, { transport: createNodeTransport({ maxPayload: bytes }) }) from the /node entry";

/** The `ws` error raised when an inbound message exceeds the transport's maxPayload (perp-cli/ws/node). */
function isMaxPayloadError(e: unknown): boolean {
  return e !== null && typeof e === "object" && (e as { code?: unknown }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
}

const STALE_TICK_MS = 1000;

export interface WireLiveness {
  key: string;
  staleAfterMs: number | null;
  /** max(last message on this wire, time the subscribe was sent) */
  lastAt: number;
}

export interface ConnectionHooks {
  onOpen(): void;
  onText(text: string, recvTs: number): void;
  onUnreadableFrame(recvTs: number): void;
  /** The socket is gone (closed, dropped, torn down). Per-socket timers must stop. */
  onSocketDown(): void;
  onState(state: ConnectionState): void;
  /** The socket closed unexpectedly; return true when the stream handled it and no reconnect is wanted. */
  onUnexpectedClose(reason: CloseReason, opened: boolean, maxPayloadExceeded: boolean): boolean;
  liveness(): WireLiveness[];
  log(level: StreamLog["level"], event: string, message: string, details?: Record<string, unknown>): void;
}

export interface ConnectionOptions {
  venue: VenueId;
  url: string;
  transport: WsFactory;
  clock: () => number;
  redact: Redactor;
  ping: { message: string; everyMs: number } | null;
  reconnect: { maxAttempts: number | null; baseMs: number; maxMs: number };
  newConnectionsPerMin: number;
  /** Open times of recent connects, shared by every socket of one venue stream (the budget is per stream). */
  connectLog: number[];
  outboundPerMin: number;
  visibility: { hidden(): boolean; onChange(cb: () => void): () => void } | null;
  random: () => number;
}

export class Connection {
  state: ConnectionState = { status: "idle" };
  private ws: WsLike | null = null;
  private opened = false;
  /** Consecutive failed attempts. Reset by the first data frame (markHealthy), not by open: a venue
   * that accepts and then drops the socket must still exhaust reconnect.maxAttempts. */
  private attempt = 0;
  private sendTimes: number[] = [];
  private sendQueue: string[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPongSince: number | null = null;
  private visibilityOff: (() => void) | null = null;
  private terminal = false;

  constructor(private o: ConnectionOptions, private h: ConnectionHooks) {
    if (o.visibility !== null) {
      const vis = o.visibility;
      this.visibilityOff = vis.onChange(() => {
        if (!vis.hidden()) this.onVisible();
      });
    }
  }

  get isOpen(): boolean {
    return this.ws !== null && this.opened;
  }

  /** Open the socket when idle (lazily, on the first wire subscription). */
  ensureOpen(): void {
    if (this.terminal) return;
    if (this.state.status === "idle") this.connectWithBudget();
  }

  send(msg: string): void {
    if (!this.isOpen) return; // resubscribe happens on open
    this.sendQueue.push(msg);
    this.flush();
  }

  /** A data frame arrived on this socket: the connection works, reset the failure count. */
  markHealthy(): void {
    if (this.isOpen) this.attempt = 0;
  }

  notePong(): void {
    this.awaitingPongSince = null;
  }

  /** Re-check staleness now (also called when a stale channel receives a frame). */
  evaluate(): void {
    if (!this.isOpen) return;
    const now = this.o.clock();
    let worst: { key: string; silent: number; ratio: number; stale: number } | null = null;
    for (const w of this.h.liveness()) {
      if (w.staleAfterMs === null) continue;
      const silent = now - w.lastAt;
      const ratio = silent / w.staleAfterMs;
      if (worst === null || ratio > worst.ratio) worst = { key: w.key, silent, ratio, stale: w.staleAfterMs };
    }
    if (worst !== null && worst.ratio > 2) {
      this.forceReconnect({
        code: "EXCHANGE_UNREACHABLE",
        message: `No message on ${worst.key} for ${worst.silent} ms (> 2 × staleAfterMs ${worst.stale})`,
        wsCode: null,
        remediation: "Reconnecting automatically; check the network or venue status if it persists",
      });
      return;
    }
    if (worst !== null && worst.ratio > 1) {
      if (this.state.status !== "stale" || this.state.channel !== worst.key) {
        this.setState({ status: "stale", since: now - worst.silent + worst.stale, silentMs: worst.silent, channel: worst.key });
      }
      return;
    }
    if (this.state.status === "stale") this.setState({ status: "live", since: now, sockets: 1 });
  }

  /** Idle, with a connect deferred by the new-connection budget (ensureOpen while the budget was spent). */
  get waiting(): boolean {
    return !this.terminal && this.state.status === "idle" && this.reconnectTimer !== null;
  }

  /** Close the socket because no wire subscription is left; state → idle. Idle with a deferred
   * connect (waiting): the connect is cancelled, so no socket opens without channels. */
  closeIdle(): void {
    if (this.terminal) return;
    if (this.state.status === "idle") {
      if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      return;
    }
    this.teardown(1000, "idle");
    this.attempt = 0;
    this.setState({ status: "idle" });
  }

  close(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.teardown(1000, "client close");
    if (this.visibilityOff !== null) { this.visibilityOff(); this.visibilityOff = null; }
    this.setState({ status: "closed", reason: { code: "CLIENT_CLOSE", message: "closed by the client", wsCode: null, remediation: null } });
  }

  /** A fatal stop that is not a client close (e.g. reconnect attempts exhausted). */
  fail(reason: CloseReason): void {
    if (this.terminal) return;
    this.terminal = true;
    this.teardown(1000, "fatal");
    if (this.visibilityOff !== null) { this.visibilityOff(); this.visibilityOff = null; }
    this.setState({ status: "closed", reason });
  }

  // ── internals ──

  private setState(s: ConnectionState): void {
    this.state = s;
    this.h.log(s.status === "closed" && s.reason.code !== "CLIENT_CLOSE" ? "error" : s.status === "reconnecting" || s.status === "stale" ? "warn" : "info",
      "state", `state → ${s.status}`, stateDetails(s));
    this.h.onState(s);
  }

  private budgetDelay(now: number): number {
    const log = this.o.connectLog;
    while (log.length > 0 && now - log[0] >= 60_000) log.shift();
    if (log.length < this.o.newConnectionsPerMin) return 0;
    return log[0] + 60_000 - now;
  }

  private connectWithBudget(): void {
    const now = this.o.clock();
    const wait = this.budgetDelay(now);
    if (wait > 0) {
      this.h.log("warn", "connection-budget", `new-connection budget (${this.o.newConnectionsPerMin}/min) reached; delaying ${wait} ms`);
      this.scheduleConnect(wait);
      return;
    }
    this.connect();
  }

  private scheduleConnect(ms: number): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.terminal) return;
      this.connectWithBudget();
    }, ms);
  }

  private connect(): void {
    this.o.connectLog.push(this.o.clock());
    this.setState({ status: "connecting", attempt: this.attempt + 1 });
    this.opened = false;
    let ws: WsLike;
    try {
      ws = this.o.transport(this.o.url);
    } catch (e) {
      // A definite, non-retryable structured error from the transport factory (e.g. the /node entry's
      // INVALID_PARAMS "`ws` is not installed") will not fix itself: close the stream with that code and
      // remediation instead of reconnecting forever. Structural check: the browser and /node bundles
      // each carry their own WsError class.
      if (isPerpError(e) && (e.structured as { retryable?: unknown }).retryable === false) {
        const st = e.structured as { code: string; message: string; remediation?: unknown };
        const code = (st.code in WS_ERROR_CODES ? st.code : "INVALID_PARAMS") as WsErrorCode;
        this.fail({
          code,
          message: this.o.redact(`WebSocket transport failed: ${st.message}`),
          wsCode: null,
          remediation: typeof st.remediation === "string" ? this.o.redact(st.remediation) : null,
        });
        return;
      }
      this.handleClose({
        code: "EXCHANGE_UNREACHABLE",
        message: this.o.redact(`WebSocket constructor failed: ${e instanceof Error ? e.message : String(e)}`),
        wsCode: null,
        remediation: HANDSHAKE_REMEDIATION,
      });
      return;
    }
    this.ws = ws;
    let socketError: unknown = null;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opened = true;
      this.awaitingPongSince = null;
      this.setState({ status: "live", since: this.o.clock(), sockets: 1 });
      this.startTimers();
      this.h.onOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const recvTs = this.o.clock();
      const text = frameText(ev.data);
      if (text === null) this.h.onUnreadableFrame(recvTs);
      else this.h.onText(text, recvTs);
    };
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      socketError = ev;
      this.h.log("warn", "socket-error", isMaxPayloadError(ev)
        ? "inbound message exceeded the transport's maxPayload (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH); a close follows"
        : "socket error event (a close follows)");
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      const wasOpen = this.opened;
      this.detach();
      const tooLarge = isMaxPayloadError(socketError);
      // The transport dropped an oversized message and closed with 1009 (the local close reads 1006).
      const reason: CloseReason = tooLarge
        ? {
          code: "WS_PROTOCOL_ERROR",
          message: `Socket closed: an inbound message exceeded the transport's maxPayload (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH, sent close 1009)`,
          wsCode: 1009,
          remediation: MAX_PAYLOAD_REMEDIATION,
        }
        : wasOpen
        ? {
          code: "EXCHANGE_UNREACHABLE",
          message: this.o.redact(`Socket closed by the venue (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`),
          wsCode: ev.code,
          remediation: "Reconnecting automatically",
        }
        : {
          code: "EXCHANGE_UNREACHABLE",
          message: this.o.redact(`Handshake failed before open (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`),
          wsCode: ev.code,
          remediation: HANDSHAKE_REMEDIATION,
        };
      if (this.h.onUnexpectedClose(reason, wasOpen, tooLarge)) return;
      this.handleClose(reason);
    };
  }

  private handleClose(reason: CloseReason): void {
    if (this.terminal) return;
    if (this.state.status === "idle") return; // the stream released every channel while closing
    this.attempt++;
    const max = this.o.reconnect.maxAttempts;
    if (max !== null && this.attempt > max) {
      this.fail({ ...reason, message: `${reason.message}; reconnect attempts exhausted (${max})` });
      return;
    }
    const exp = Math.min(this.o.reconnect.maxMs, this.o.reconnect.baseMs * Math.pow(2, this.attempt - 1));
    const backoff = Math.round(exp / 2 + this.o.random() * (exp / 2));
    const inMs = Math.max(backoff, this.budgetDelay(this.o.clock()));
    this.setState({ status: "reconnecting", attempt: this.attempt, inMs, reason });
    this.scheduleConnect(inMs);
  }

  /** Stale / missed pong: drop the socket ourselves (HL never answers a client close) and reconnect. */
  forceReconnect(reason: CloseReason): void {
    if (this.terminal || this.ws === null) return;
    this.h.log("warn", "force-reconnect", reason.message);
    this.teardown(4000, "stale");
    this.handleClose(reason);
  }

  private startTimers(): void {
    this.staleTimer = setInterval(() => this.evaluate(), STALE_TICK_MS);
    const ping = this.o.ping;
    if (ping !== null) {
      this.pingTimer = setInterval(() => this.pingTick(), ping.everyMs);
    }
  }

  private pingTick(): void {
    if (!this.isOpen || this.o.ping === null) return;
    if (this.awaitingPongSince !== null) {
      this.forceReconnect({
        code: "EXCHANGE_UNREACHABLE",
        message: `No pong within ${this.o.ping.everyMs} ms`,
        wsCode: null,
        remediation: "Reconnecting automatically",
      });
      return;
    }
    this.awaitingPongSince = this.o.clock();
    this.send(this.o.ping.message);
  }

  private onVisible(): void {
    if (!this.isOpen) return;
    this.h.log("info", "visible", "tab visible: re-evaluating staleness");
    this.evaluate();
    if (this.isOpen && this.o.ping !== null && this.awaitingPongSince === null) {
      this.awaitingPongSince = this.o.clock();
      this.send(this.o.ping.message);
    }
  }

  private flush(): void {
    if (this.sendTimer !== null) return;
    const ws = this.ws;
    while (this.sendQueue.length > 0 && ws !== null && this.opened) {
      const now = this.o.clock();
      this.sendTimes = this.sendTimes.filter(t => now - t < 60_000);
      if (this.sendTimes.length >= this.o.outboundPerMin) {
        const wait = this.sendTimes[0] + 60_000 - now;
        this.h.log("warn", "outbound-limit", `outbound limit (${this.o.outboundPerMin}/min) reached; ${this.sendQueue.length} queued for ${wait} ms`);
        this.sendTimer = setTimeout(() => { this.sendTimer = null; this.flush(); }, wait);
        return;
      }
      const msg = this.sendQueue.shift() as string;
      this.sendTimes.push(now);
      try {
        ws.send(msg);
      } catch (e) {
        this.h.log("warn", "send-failed", this.o.redact(`send failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  private detach(): void {
    const ws = this.ws;
    if (ws !== null) {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
    }
    const wasSocket = ws !== null;
    this.ws = null;
    this.opened = false;
    this.awaitingPongSince = null;
    this.sendQueue = [];
    if (this.sendTimer !== null) { clearTimeout(this.sendTimer); this.sendTimer = null; }
    if (this.staleTimer !== null) { clearInterval(this.staleTimer); this.staleTimer = null; }
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (wasSocket) this.h.onSocketDown();
  }

  private teardown(code: number, reason: string): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = this.ws;
    this.detach();
    if (ws !== null) {
      try { ws.close(code, reason); } catch { /* already closing; handlers are detached */ }
    }
  }
}

function stateDetails(s: ConnectionState): Record<string, unknown> {
  const { status: _status, ...rest } = s;
  return rest;
}

/** Thrown into ready when the stream is closed. */
export function closedError(venue: VenueId): WsError {
  return new WsError("INVALID_PARAMS", `${venue} stream is closed`, { exchange: venue, remediation: "Create a new stream" });
}
