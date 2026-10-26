/**
 * perp-cli/ws/node transport: inbound messages are capped (default 16 MiB instead of ws's 100 MiB,
 * configurable via createNodeTransport({ maxPayload })); an oversized message is never delivered: the
 * transport reports WS_ERR_UNSUPPORTED_MESSAGE_LENGTH, the server sees close 1009, the local close is 1006.
 */
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { DEFAULT_MAX_PAYLOAD, createNodeTransport, createVenueStream, nodeTransport, pacifica } from "../../ws/node.js";
import type { ConnectionState, StreamControl, WsFactory } from "../../ws/types.js";
import { PACIFICA_ROUTES, fakeFetch, fixtureFrames } from "./helpers.js";

let server: WebSocketServer | null = null;
let serverCloseCode: Promise<number> = Promise.resolve(-1);

afterEach(async () => {
  const s = server;
  server = null;
  if (s !== null) {
    for (const c of s.clients) c.terminate();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** Start a server that sends `size` bytes of text to each client on connect; returns its URL. */
async function serveFrame(size: number): Promise<string> {
  const s = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server = s;
  serverCloseCode = new Promise((r) => {
    s.on("connection", (sock) => {
      sock.on("close", (code) => r(code));
      sock.send("x".repeat(size));
    });
  });
  await new Promise<void>((r) => s.once("listening", () => r()));
  return `ws://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

interface Received { messages: number[]; errors: unknown[]; close: { code: number } }

function receive(factory: WsFactory, url: string): Promise<Received> {
  return new Promise((resolve) => {
    const ws = factory(url);
    const messages: number[] = [];
    const errors: unknown[] = [];
    ws.onerror = (err) => errors.push((err as { code?: unknown }).code);
    ws.onmessage = (ev) => {
      messages.push(typeof ev.data === "string" ? ev.data.length : -1);
      ws.close(1000, "done");
    };
    ws.onclose = (ev) => resolve({ messages, errors, close: { code: ev.code } });
  });
}

describe("nodeTransport maxPayload", () => {
  it("defaults to 16 MiB (bounded below ws's 100 MiB)", () => {
    expect(DEFAULT_MAX_PAYLOAD).toBe(16 * 1024 * 1024);
  });

  it("delivers a frame within the cap", async () => {
    const url = await serveFrame(200_000); // > largest measured real frame (~147 KB)
    const r = await receive(nodeTransport, url);
    expect(r.messages).toEqual([200_000]);
    expect(r.errors).toEqual([]);
  });

  it("drops a frame over a configured cap and closes (1009 to the server)", async () => {
    const url = await serveFrame(2048);
    const r = await receive(createNodeTransport({ maxPayload: 1024 }), url);
    expect(r.messages).toEqual([]);
    expect(r.errors).toEqual(["WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"]);
    expect(r.close.code).toBe(1006);
    expect(await serverCloseCode).toBe(1009);
  });

  it("the default transport rejects a frame just over 16 MiB", async () => {
    const url = await serveFrame(DEFAULT_MAX_PAYLOAD + 1);
    const r = await receive(nodeTransport, url);
    expect(r.messages).toEqual([]);
    expect(r.errors).toEqual(["WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"]);
    expect(r.close.code).toBe(1006);
    expect(await serverCloseCode).toBe(1009);
  }, 30_000);

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects maxPayload %s", (v) => {
    expect(() => createNodeTransport({ maxPayload: v })).toThrow(RangeError);
  });
});

describe("stream over a capped node transport", () => {
  /** Server sending `frames(n)` to the n-th connection (1-based); returns its URL and connection count. */
  async function serve(frames: (n: number) => string[]): Promise<{ url: string; connections: () => number }> {
    const s = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server = s;
    let n = 0;
    s.on("connection", (sock) => { n++; for (const f of frames(n)) sock.send(f); });
    await new Promise<void>((r) => s.once("listening", () => r()));
    return { url: `ws://127.0.0.1:${(s.address() as AddressInfo).port}`, connections: () => n };
  }

  function open(url: string) {
    const states: ConnectionState[] = [];
    const stream = createVenueStream({ ...pacifica, url: () => url }, {
      transport: createNodeTransport({ maxPayload: 1024 }),
      fetch: fakeFetch(PACIFICA_ROUTES),
      visibility: null,
      reconnect: { maxAttempts: null, baseMs: 5, maxMs: 10 },
    });
    stream.onState((st) => states.push(st));
    return { stream, states };
  }

  const PRICES = JSON.stringify(fixtureFrames("pacifica", "prices")[0]);
  const HUGE = "x".repeat(2048);

  it("an oversized frame names the cause in the close reason; a one-off reconnects and recovers", async () => {
    const srv = await serve((n) => (n === 1 ? [HUGE] : [PRICES]));
    const { stream, states } = open(srv.url);
    const sub = stream.subscribe({ kind: "allMarkets" });
    const errors: StreamControl[] = [];
    sub.on((e) => { if (e.type === "error") errors.push(e); });
    await sub.ready;
    const reconnecting = states.find((st) => st.status === "reconnecting");
    expect(reconnecting).toMatchObject({
      status: "reconnecting",
      reason: { code: "WS_PROTOCOL_ERROR", wsCode: 1009, message: expect.stringContaining("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") },
    });
    expect(reconnecting?.status === "reconnecting" ? reconnecting.reason.remediation : null).toContain("createNodeTransport");
    expect(srv.connections()).toBe(2);
    expect(errors).toEqual([]);
    await stream.close();
  });

  it("the same oversized frame 3 times → the subscription fails WS_PROTOCOL_ERROR (no endless reconnect)", async () => {
    const srv = await serve(() => [HUGE]);
    const { stream } = open(srv.url);
    const sub = stream.subscribe({ kind: "allMarkets" });
    const errors: StreamControl[] = [];
    sub.on((e) => { if (e.type === "error") errors.push(e); });
    const err = await sub.ready.then(() => null, (e: unknown) => e as { structured: { code: string; message: string; remediation?: string } });
    expect(err?.structured.code).toBe("WS_PROTOCOL_ERROR");
    expect(err?.structured.message).toContain("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
    expect(err?.structured.remediation).toContain("createNodeTransport({ maxPayload");
    expect(errors).toEqual([expect.objectContaining({ code: "WS_PROTOCOL_ERROR", fatal: true })]);
    expect(srv.connections()).toBe(3);
    await new Promise((r) => setTimeout(r, 100)); // well past the 5–10 ms backoff
    expect(srv.connections()).toBe(3);
    expect(stream.state.status).toBe("idle");
    await stream.close();
  });
});

describe("stream.close() leaves the process idle (conformance ws:all:close-timers)", () => {
  it("no Timeout / TCP handle of the socket remains once close() resolves", async () => {
    // A server that never answers the close frame: `ws` would keep its 30 s close-handshake timer.
    const s = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server = s;
    s.on("connection", (sock) => { (sock as unknown as { _socket: { pause(): void } })._socket.pause(); });
    await new Promise<void>((r) => s.once("listening", () => r()));
    const url = `ws://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const before = process.getActiveResourcesInfo().filter(h => h === "Timeout").length;
    const stream = createVenueStream({ ...pacifica, url: () => url }, { transport: createNodeTransport(), fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets" });
    sub.on(() => {});
    await new Promise<void>((r) => { const off = stream.onState(st => { if (st.status === "live" || st.status === "connecting") { off(); r(); } }); });
    await new Promise((r) => setTimeout(r, 50));
    await stream.close();
    const timers = process.getActiveResourcesInfo().filter(h => h === "Timeout").length;
    expect(timers).toBeLessThanOrEqual(before);
  });
});

describe("close() sends a clean close frame (review)", () => {
  it("the server sees close 1000, not 1006, and no timer is left", async () => {
    const s = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server = s;
    const code = new Promise<number>((r) => s.on("connection", (sock) => sock.on("close", (c) => r(c))));
    await new Promise<void>((r) => s.once("listening", () => r()));
    const url = `ws://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const before = process.getActiveResourcesInfo().filter(h => h === "Timeout").length;
    const stream = createVenueStream({ ...pacifica, url: () => url }, { transport: createNodeTransport(), fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    stream.subscribe({ kind: "allMarkets" }).on(() => {});
    await new Promise<void>((r) => { const off = stream.onState(st => { if (st.status === "live" || st.status === "connecting") { off(); r(); } }); });
    await new Promise((r) => setTimeout(r, 50));
    await stream.close();
    expect(await code).toBe(1000);
    expect(process.getActiveResourcesInfo().filter(h => h === "Timeout").length).toBeLessThanOrEqual(before);
  });
});
