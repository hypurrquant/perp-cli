/**
 * QFEX Trade WebSocket transport against an in-process fake `ws` server:
 * auth shapes, correlation by generated client id, foreign frames ignored, the "sent"
 * boundary, unknown outcome → ORDER_PENDING + session destroyed, cancel_on_disconnect never
 * sent, idle handles unref'd.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import { PerpError } from "../../errors.js";
import {
  QFEX_SENDABLE_TYPES, QfexTradeSession, errFrameOf, fetchQfexMarketStats, parseMarketStats, qfexTradeSession,
  type QfexSessionOptions, type QfexTimeouts,
} from "../../exchanges/qfex/ws-transport.js";
import { fillResponse, orderResponse, startFakeQfexServer, type FakeQfexServer } from "../helpers/qfex-fake-server.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAST: QfexTimeouts = { connectMs: 1000, authMs: 300, subscribeMs: 300, ackMs: 150, immediateFinalMs: 300, postOnlyFinalMs: 200, fillsMs: 80, cancelMs: 150, readMs: 200 };

let server: FakeQfexServer;
const sessions: QfexTradeSession[] = [];

function options(over: Partial<QfexSessionOptions> = {}): QfexSessionOptions {
  return {
    url: server.url, network: "testnet", credentials: { publicKey: "qfex_pub_test", secret: "qfex_secret_test" },
    accountId: ACCOUNT, builderCode: null, rateLimit: { capacity: 100, refillPerSec: 50, weights: null },
    timeouts: FAST, idleCloseMs: 5_000, ...over,
  };
}

function session(over: Partial<QfexSessionOptions> = {}): QfexTradeSession {
  const s = new QfexTradeSession(options(over));
  sessions.push(s);
  return s;
}

function addParams(clientOrderId = CID, tif = "IOC") {
  return { symbol: "AAPL-USD", side: "BUY", order_type: "LIMIT", order_time_in_force: tif, quantity: 1, price: 333.4, client_order_id: clientOrderId };
}

async function rejection(p: Promise<unknown>): Promise<PerpError> {
  try { await p; } catch (e) { return e as PerpError; }
  throw new Error("expected a rejection");
}

beforeEach(async () => { server = await startFakeQfexServer(); });
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await server.close();
});

describe("auth + subscribe (not-sent phase)", () => {
  it.each([
    ["AsyncAPI shape", { authenticated: true }],
    ["docs page shape", { type: "auth", result: "success" }],
  ])("accepts the %s auth success", async (_n, frame) => {
    server.authReply = () => frame;
    await session().verifyAuth();
    expect(server.types).toEqual(["auth", "subscribe", "subscribe", "subscribe"]);
  });

  it("sends the public key in the URL, the hmac block, the explicit account and the builder code", async () => {
    await session({ builderCode: "33333333-3333-4333-8333-333333333333" }).verifyAuth();
    expect(server.connections[0].url).toContain("api_key=qfex_pub_test");
    const auth = server.messages[0].msg as { params: { hmac: Record<string, unknown>; account_id: string; builder_code: string } };
    expect(auth.params.account_id).toBe(ACCOUNT);
    expect(auth.params.builder_code).toBe("33333333-3333-4333-8333-333333333333");
    expect(auth.params.hmac.public_key).toBe("qfex_pub_test");
    expect(String(auth.params.hmac.signature)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(server.messages)).not.toContain("qfex_secret_test");
    // one subscribe per channel, each confirmed
    expect(server.messages.slice(1).map(m => (m.msg.params as { channels: string[] }).channels[0])).toEqual(["order_responses", "fills", "stop_orders"]);
  });

  it.each([
    ["{err:{…}}", { err: { error_code: "PermissionDenied", message: "no", incoming_message: { type: "auth", params: {} } } }, "POLICY_DENIED"],
    ['{type:"Err"}', { type: "Err", error_code: "InvalidParameter", message: "bad signature", incoming_message: {} }, "SIGNATURE_FAILED"],
    ['{type:"error"}', { type: "error", error_code: "ServerError", message: "x" }, "SIGNATURE_FAILED"],
    ["{authenticated:false}", { authenticated: false }, "SIGNATURE_FAILED"],
    ['{type:"auth",result:"failure"}', { type: "auth", result: "failure" }, "SIGNATURE_FAILED"],
  ])("auth refusal %s → an order is NOT SENT (definite)", async (_n, frame, code) => {
    server.authReply = () => frame;
    const s = session();
    expect((await rejection(s.verifyAuth())).structured.code).toBe(code);
    const e = await rejection(s.addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    // SIGNATURE_FAILED / POLICY_DENIED are definite codes; nothing but auth was ever sent.
    expect(e.structured.code).toBe(code);
    expect(server.types.filter(t => t !== "auth")).toEqual([]);
  });

  it("no auth answer within the timeout → the order is not sent (ORDER_REJECTED)", async () => {
    server.authReply = () => null;
    const e = await rejection(session().addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.message).toMatch(/not sent/);
    expect(server.types).toEqual(["auth"]);
  });

  it("an unconfirmed subscription → not sent", async () => {
    server.subscribeReply = ch => (ch === "fills" ? null : { subscribed: ch });
    const e = await rejection(session().addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(server.types).not.toContain("add_order");
  });

  it("connect failure → not sent", async () => {
    const dead = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => dead.once("listening", () => r()));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>(r => dead.close(() => r()));
    const e = await rejection(session({ url: `ws://127.0.0.1:${port}` }).addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.message).toMatch(/not sent/);
  });

  it("socket not OPEN before send() → not sent, nothing reaches the venue", async () => {
    const s = session();
    await s.getUserOrders(null).catch(() => undefined); // opens the connection (the read itself times out: no reply scripted)
    server.onCommand = (conn, msg) => { if (msg.type === "get_user_orders") conn.send({ all_orders_response: { orders: [] } }); };
    await s.getUserOrders(null);
    const conn = (s as unknown as { conn: { ws: object } }).conn;
    Object.defineProperty(conn.ws, "readyState", { value: 2, configurable: true }); // CLOSING
    const e = await rejection(s.addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.message).toMatch(/not sent/);
    expect(server.types).not.toContain("add_order");
  });
});

describe("message whitelist", () => {
  it("cancel_on_disconnect is not sendable", () => {
    expect(QFEX_SENDABLE_TYPES.has("cancel_on_disconnect")).toBe(false);
    expect([...QFEX_SENDABLE_TYPES].sort()).toEqual(
      ["add_order", "auth", "cancel_all_orders", "cancel_order", "cancel_stop_order", "get_user_orders", "modify_order", "subscribe"],
    );
  });

  it("no flow of the transport ever sends cancel_on_disconnect", async () => {
    server.onCommand = (conn, msg) => {
      const p = msg.params as Record<string, unknown>;
      if (msg.type === "add_order") conn.send(orderResponse({ order_id: "o1", client_order_id: String(p.client_order_id), status: "ACK", quantity: 1, quantity_remaining: 1 }));
      if (msg.type === "cancel_order") conn.send(orderResponse({ order_id: String(p.order_id), client_order_id: "", status: "CANCELLED", quantity: 1, quantity_remaining: 1 }));
      if (msg.type === "cancel_stop_order") conn.send(orderResponse({ order_id: String(p.stop_order_id), client_order_id: "", status: "CANCELLED", quantity: 1, quantity_remaining: 1 }));
      if (msg.type === "get_user_orders") conn.send({ all_orders_response: { orders: null, twaps: null } });
      if (msg.type === "cancel_all_orders") conn.send(orderResponse({ order_id: "o1", client_order_id: "", status: "CANCELLED", quantity: 1, quantity_remaining: 1 }));
    };
    const s = session();
    await s.verifyAuth();
    await s.addOrder({ params: addParams(CID, "GTC"), immediate: false, lotSize: "0.001", band: null });
    await s.cancelOrder("AAPL-USD", "o1");
    await s.cancelStopOrder("AAPL-USD", "s1");
    await s.getUserOrders("AAPL-USD");
    await s.cancelAll(null, new Set(["o1"]));
    await s.close();
    expect(server.types).not.toContain("cancel_on_disconnect");
    expect(new Set(server.types)).toEqual(new Set(["auth", "subscribe", "add_order", "cancel_order", "cancel_stop_order", "get_user_orders", "cancel_all_orders"]));
  });
});

describe("add_order correlation", () => {
  it("IOC: ignores foreign frames, pins to the order id of OUR client id, collects fills until they add up", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      // Another client's order on the same symbol / quantity, interleaved.
      conn.send(orderResponse({ order_id: "foreign", client_order_id: "someone-else", status: "ACK", quantity: 1, quantity_remaining: 1 }));
      conn.send(fillResponse({ trade_id: "tf", order_id: "foreign", client_order_id: "someone-else", price: 1, quantity: 1 }));
      conn.send(orderResponse({ order_id: "foreign", client_order_id: "someone-else", status: "FILLED", quantity: 1, quantity_remaining: 0 }));
      conn.send({ something: "unknown" });
      conn.send(orderResponse({ order_id: "mine", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      conn.send(fillResponse({ trade_id: "t1", order_id: "mine", client_order_id: CID, price: 333.4, quantity: 0.4 }));
      conn.send(fillResponse({ trade_id: "t1", order_id: "mine", client_order_id: CID, price: 333.4, quantity: 0.4 })); // duplicate
      conn.send(orderResponse({ order_id: "mine", client_order_id: CID, status: "FILLED", quantity: 1, quantity_remaining: 0.6 }));
      conn.send(orderResponse({ order_id: "mine", client_order_id: CID, status: "FILLED", quantity: 1, quantity_remaining: 0 }));
      conn.send(fillResponse({ trade_id: "t2", order_id: "mine", client_order_id: CID, price: 333.5, quantity: 0.6 }));
    };
    const r = await session().addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null });
    expect(r.orderId).toBe("mine");
    expect(r.ended).toBe("terminal");
    expect(r.terminal?.status).toBe("FILLED");
    expect(r.responses.map(x => x.status)).toEqual(["ACK", "FILLED", "FILLED"]);
    expect(r.fills.map(f => f.trade_id)).toEqual(["t1", "t2"]);
  });

  it("a frame for our order id that arrives before the ACK of our client id is not adopted", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      // An older order that happens to be FILLED right now — no relation to this request.
      conn.send(orderResponse({ order_id: "old", client_order_id: "old-id", status: "FILLED", quantity: 1, quantity_remaining: 0 }));
      conn.send(orderResponse({ order_id: "mine", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      conn.send(orderResponse({ order_id: "mine", client_order_id: CID, status: "IOC_CANCELLED", quantity: 1, quantity_remaining: 1 }));
    };
    const r = await session().addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null });
    expect(r.orderId).toBe("mine");
    expect(r.terminal?.status).toBe("IOC_CANCELLED");
    expect(r.fills).toEqual([]);
  });

  it("GTC: returns right after the ACK — no status is inferred from silence", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type === "add_order") conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1, time_in_force: "GTC" }));
    };
    const started = Date.now();
    const r = await session().addOrder({ params: addParams(CID, "GTC"), immediate: false, lotSize: "0.001", band: null });
    expect(r.ended).toBe("resting");
    expect(r.terminal).toBeNull();
    expect(Date.now() - started).toBeLessThan(FAST.ackMs);
  });

  it("ALO: the CANCELLED frame the venue sends after the ACK (it would cross) is the terminal frame", async () => {
    // Live production 2026-10-05: add_order ALO → ACK, then CANCELLED for the same order id.
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1, time_in_force: "GTC", type: "ALO" }));
      setTimeout(() => conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "CANCELLED", quantity: 1, quantity_remaining: 1, time_in_force: "GTC", type: "ALO" })), 40);
    };
    const r = await session().addOrder({ params: { ...addParams(CID, "GTC"), order_type: "ALO" }, immediate: false, postOnly: true, lotSize: "0.001", band: null });
    expect(r.ended).toBe("terminal");
    expect(r.terminal).toMatchObject({ status: "CANCELLED", order_id: "o1" });
    expect(r.responses.map(x => x.status)).toEqual(["ACK", "CANCELLED"]);
  });

  it("ALO: no terminal frame within postOnlyFinalMs → resting (it did not cross)", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type === "add_order") conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1, time_in_force: "GTC", type: "ALO" }));
    };
    const started = Date.now();
    const r = await session().addOrder({ params: { ...addParams(CID, "GTC"), order_type: "ALO" }, immediate: false, postOnly: true, lotSize: "0.001", band: null });
    expect(r.ended).toBe("resting");
    expect(r.terminal).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.postOnlyFinalMs - 20);
  });

  it("an engine rejection for our client id is a definite, mapped error and keeps the session", async () => {
    server.onCommand = (conn, msg) => {
      const p = msg.params as Record<string, unknown>;
      if (msg.type === "add_order") conn.send(orderResponse({ order_id: "o1", client_order_id: String(p.client_order_id), status: "INVALID_TICK_SIZE_PRECISION_PRICE", quantity: 1, quantity_remaining: 1 }));
    };
    const s = session();
    const e = await rejection(s.addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: { lower: "1", upper: "2" } }));
    expect(e.structured.code).toBe("INVALID_TICK");
    expect(e.structured.details?.venueStatus).toBe("INVALID_TICK_SIZE_PRECISION_PRICE");
    await rejection(s.addOrder({ params: addParams("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), immediate: true, lotSize: "0.001", band: null }));
    expect(s.connectCount).toBe(1);
  });

  it("IOC with no terminal frame in time → ended 'timeout' with what was seen (the adapter reports pending)", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "FILLED", quantity: 1, quantity_remaining: 0.7 }));
    };
    const s = session();
    const r = await s.addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null });
    expect(r.ended).toBe("timeout");
    expect(r.terminal).toBeNull();
    expect(r.responses.map(x => x.status)).toEqual(["ACK", "FILLED"]);
    // the session was destroyed: a late frame cannot meet the next command
    server.onCommand = (conn, msg) => { if (msg.type === "get_user_orders") conn.send({ all_orders_response: { orders: [] } }); };
    await s.getUserOrders(null);
    expect(s.connectCount).toBe(2);
  });
});

describe("unknown outcome after send → ORDER_PENDING, session destroyed, nothing re-sent", () => {
  it("no correlated frame within the ACK timeout", async () => {
    const s = session();
    const e = await rejection(s.addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.remediation).toContain(`perp trade status c:${CID} --symbol AAPL -e qfex`);
    expect(e.structured.remediation).toMatch(/Do NOT resubmit/);
    expect(e.structured.details?.clientOrderId).toBe(CID);
    expect(server.types.filter(t => t === "add_order")).toHaveLength(1);
    // destroyed: the server sees the socket go away, and the next command reconnects + re-auths
    await vi.waitFor(() => expect(server.connections[0].ws.readyState).toBe(3));
    server.onCommand = (conn, msg) => { if (msg.type === "get_user_orders") conn.send({ all_orders_response: { orders: [] } }); };
    await s.getUserOrders(null);
    expect(s.connectCount).toBe(2);
    expect(server.types.filter(t => t === "auth")).toHaveLength(2);
    expect(server.types.filter(t => t === "add_order")).toHaveLength(1);
  });

  it("socket closed by the venue after send", async () => {
    server.onCommand = (conn, msg) => { if (msg.type === "add_order") conn.ws.terminate(); };
    const e = await rejection(session().addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.message).toMatch(/connection lost/);
  });

  it.each([
    ["RateLimited with the documented EMPTY echo", { type: "Err", error_code: "RateLimited", message: "Rate limit exceeded, retry after 2 seconds", incoming_message: {} }],
    ['type:"error" without any echo', { type: "error", error_code: "InvalidParameter", message: "x" }],
    ["an echo of a different client id", { err: { error_code: "InvalidOrder", message: "x", incoming_message: { type: "add_order", params: { client_order_id: "other" } } } }],
    ["ServerError even with a matching echo", { err: { error_code: "ServerError", message: "x", incoming_message: { type: "add_order", params: { client_order_id: CID } } } }],
  ])("%s → unknown", async (_n, frame) => {
    server.onCommand = (conn, msg) => { if (msg.type === "add_order") conn.send(frame); };
    const e = await rejection(session().addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe("ORDER_PENDING");
  });

  it.each([
    ["InvalidParameter", "INVALID_PARAMS"],
    ["PermissionDenied", "POLICY_DENIED"],
    ["KycRequired", "POLICY_DENIED"],
    ["RateLimited", "RATE_LIMITED"],
  ])("an error frame echoing THIS request (%s) is a definite refusal", async (venueCode, code) => {
    server.onCommand = (conn, msg) => {
      if (msg.type === "add_order") conn.send({ err: { error_code: venueCode, message: "retry after 200ms", incoming_message: { type: "add_order", params: msg.params } } });
    };
    const s = session();
    const e = await rejection(s.addOrder({ params: addParams(), immediate: true, lotSize: "0.001", band: null }));
    expect(e.structured.code).toBe(code);
    if (venueCode === "RateLimited") expect(e.structured.details?.retryAfterMs).toBe(200);
    expect(server.types.filter(t => t === "add_order")).toHaveLength(1); // never re-sent
  });
});

describe("one command at a time (FIFO)", () => {
  it("the second add_order is sent only after the first has finished", async () => {
    const order: string[] = [];
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      const cid = String((msg.params as Record<string, unknown>).client_order_id);
      order.push(`recv:${cid}`);
      setTimeout(() => {
        order.push(`ack:${cid}`);
        conn.send(orderResponse({ order_id: `o-${cid}`, client_order_id: cid, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      }, 40);
    };
    const s = session();
    const [a, b] = await Promise.all([
      s.addOrder({ params: addParams("id-a", "GTC"), immediate: false, lotSize: "0.001", band: null }),
      s.addOrder({ params: addParams("id-b", "GTC"), immediate: false, lotSize: "0.001", band: null }),
    ]);
    expect(order).toEqual(["recv:id-a", "ack:id-a", "recv:id-b", "ack:id-b"]);
    expect([a.orderId, b.orderId]).toEqual(["o-id-a", "o-id-b"]);
    expect(s.connectCount).toBe(1);
  });
});

describe("cancel", () => {
  it("CANCELLED for the order id → cancelled; NO_SUCH_ORDER → refused; silence → unknown (never thrown)", async () => {
    server.onCommand = (conn, msg) => {
      const id = String((msg.params as Record<string, unknown>).order_id);
      if (msg.type !== "cancel_order") return;
      conn.send(orderResponse({ order_id: "other", client_order_id: "", status: "CANCELLED", quantity: 1, quantity_remaining: 1 }));
      if (id === "ok") conn.send(orderResponse({ order_id: id, client_order_id: "", status: "CANCELLED", quantity: 1, quantity_remaining: 1 }));
      if (id === "gone") conn.send(orderResponse({ order_id: id, client_order_id: "", status: "NO_SUCH_ORDER", quantity: 0, quantity_remaining: 0 }));
    };
    const s = session();
    expect((await s.cancelOrder("AAPL-USD", "ok")).kind).toBe("cancelled");
    const gone = await s.cancelOrder("AAPL-USD", "gone");
    expect(gone).toMatchObject({ kind: "refused", status: "NO_SUCH_ORDER" });
    const silent = await s.cancelOrder("AAPL-USD", "silent");
    expect(silent.kind).toBe("unknown");
    // the cancel is by ORDER id, never by client id
    expect(server.messages.filter(m => m.msg.type === "cancel_order").every(m => (m.msg.params as Record<string, unknown>).cancel_order_id_type === "order_id")).toBe(true);
  });

  it("cancel_all collects CANCELLED frames of the expected ids; an incomplete window is reported, not thrown", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type === "cancel_all_orders") conn.send(orderResponse({ order_id: "a", client_order_id: "", status: "CANCELLED", quantity: 1, quantity_remaining: 1 }));
    };
    const r = await session().cancelAll("AAPL-USD", new Set(["a", "b"]));
    expect(r.cancelled).toEqual(["a"]);
    expect(r.complete).toBe(false);
    expect(server.messages.find(m => m.msg.type === "cancel_all_orders")!.msg.params).toEqual({ symbol: "AAPL-USD" });
  });
});

describe("modify_order wire function (kept gated by the adapter)", () => {
  const params = { symbol: "AAPL-USD", order_id: "old", side: "BUY", order_type: "LIMIT", price: 330, quantity: 2, reduce_only: false, take_profit: 0, stop_loss: 0 };

  it("accepts only a MODIFIED frame with the same client id AND the requested symbol/side/type/price/quantity", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type !== "modify_order") return;
      // another process's modify on the same symbol
      conn.send(orderResponse({ order_id: "new-foreign", client_order_id: "other", status: "MODIFIED", quantity: 2, quantity_remaining: 2, price: 330, type: "LIMIT" }));
      // same client id but a different price → not ours
      conn.send(orderResponse({ order_id: "new-wrong", client_order_id: CID, status: "MODIFIED", quantity: 2, quantity_remaining: 2, price: 331, type: "LIMIT" }));
      conn.send(orderResponse({ order_id: "new-mine", client_order_id: CID, status: "MODIFIED", quantity: 2, quantity_remaining: 2, price: 330, type: "LIMIT" }));
    };
    const r = await session().modifyOrder({ params, clientOrderId: CID, lotSize: "0.001", tickSize: "0.01" });
    expect(r.order_id).toBe("new-mine");
  });

  it("a MODIFIED frame without the client id (docs example) is never adopted → ORDER_PENDING", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type === "modify_order") conn.send(orderResponse({ order_id: "new", client_order_id: "", status: "MODIFIED", quantity: 2, quantity_remaining: 2, price: 330, type: "LIMIT" }));
    };
    const e = await rejection(session().modifyOrder({ params, clientOrderId: CID, lotSize: "0.001", tickSize: "0.01" }));
    expect(e.structured.code).toBe("ORDER_PENDING");
  });

  it("CANNOT_MODIFY_PARTIAL_FILL on the old order id is a definite rejection", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type === "modify_order") conn.send(orderResponse({ order_id: "old", client_order_id: CID, status: "CANNOT_MODIFY_PARTIAL_FILL", quantity: 2, quantity_remaining: 1 }));
    };
    const e = await rejection(session().modifyOrder({ params, clientOrderId: CID, lotSize: "0.001", tickSize: "0.01" }));
    expect(e.structured.code).toBe("ORDER_REJECTED");
  });
});

describe("reads", () => {
  it("get_user_orders returns the rows; a JSON null list is no rows; pages until a short page", async () => {
    const row = (i: number) => orderResponse({ order_id: `o${i}`, client_order_id: `c${i}`, status: "ACK", quantity: 1, quantity_remaining: 1 }).order_response;
    server.onCommand = (conn, msg) => {
      if (msg.type !== "get_user_orders") return;
      const p = msg.params as { offset: number; symbol?: string };
      if (p.symbol === "NONE-USD") return conn.send({ all_orders_response: { orders: null, twaps: null } });
      conn.send({ all_orders_response: { orders: p.offset === 0 ? Array.from({ length: 100 }, (_, i) => row(i)) : [row(100)], twaps: [] } });
    };
    const s = session();
    expect(await s.getUserOrders("NONE-USD")).toEqual([]);
    const all = await s.getUserOrders(null);
    expect(all).toHaveLength(101);
    expect(server.messages.filter(m => m.msg.type === "get_user_orders").map(m => (m.msg.params as { offset: number }).offset)).toEqual([0, 0, 100]);
  });

  it("a read that gets no answer is TIMEOUT (not ORDER_PENDING) and destroys the session", async () => {
    const s = session();
    const e = await rejection(s.getUserOrders(null));
    expect(e.structured.code).toBe("TIMEOUT");
  });
});

describe("idle + process lifetime", () => {
  it("after a command nothing of the session keeps the event loop alive", async () => {
    server.onCommand = (conn, msg) => { if (msg.type === "get_user_orders") conn.send({ all_orders_response: { orders: [] } }); };
    const s = session();
    expect(s.isIdleUnref()).toBe(true); // never connected
    await s.getUserOrders(null);
    expect(s.isIdleUnref()).toBe(true); // socket + idle timer unref'd
  });

  it("the idle timer closes the connection", async () => {
    server.onCommand = (conn, msg) => { if (msg.type === "get_user_orders") conn.send({ all_orders_response: { orders: [] } }); };
    const s = session({ idleCloseMs: 30 });
    await s.getUserOrders(null);
    await vi.waitFor(() => expect(server.connections[0].ws.readyState).toBe(3), { timeout: 2000 });
    await s.getUserOrders(null); // reconnects: re-auth + re-subscribe, nothing replayed
    expect(s.connectCount).toBe(2);
    expect(server.types.filter(t => t === "get_user_orders")).toHaveLength(2);
  });

  it("qfexTradeSession keeps one session per network + key + account + builder code", () => {
    const a = qfexTradeSession(options());
    expect(qfexTradeSession(options())).toBe(a);
    expect(qfexTradeSession(options({ builderCode: "33333333-3333-4333-8333-333333333333" }))).not.toBe(a);
    expect(qfexTradeSession(options({ accountId: "22222222-2222-4222-8222-222222222222" }))).not.toBe(a);
  });
});

describe("SIGINT while a mutating command is in flight", () => {
  it("prints ORDER_PENDING and c:<id>; the handler is removed afterwards", async () => {
    const keepAlive = (): void => undefined; // a second listener → the handler must not exit the test runner
    process.on("SIGINT", keepAlive);
    const before = process.listenerCount("SIGINT");
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    try {
      server.onCommand = (conn, msg) => {
        if (msg.type !== "add_order") return;
        expect(process.listenerCount("SIGINT")).toBe(before + 1);
        process.emit("SIGINT");
        conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      };
      await session().addOrder({ params: addParams(CID, "GTC"), immediate: false, lotSize: "0.001", band: null });
    } finally {
      spy.mockRestore();
      process.removeListener("SIGINT", keepAlive);
    }
    const out = written.join("");
    expect(out).toContain("ORDER_PENDING");
    expect(out).toContain(`c:${CID}`);
    expect(process.listenerCount("SIGINT")).toBe(before - 1);
  });
});

describe("frame parsing", () => {
  it("errFrameOf accepts the three documented shapes; an empty echo is no echo", () => {
    expect(errFrameOf({ err: { error_code: "RateLimited", message: "m", incoming_message: { type: "add_order", params: { a: 1 } } } }))
      .toEqual({ errorCode: "RateLimited", message: "m", echo: { type: "add_order", params: { a: 1 } } });
    expect(errFrameOf({ type: "Err", error_code: "RateLimited", message: "m", incoming_message: {} })).toEqual({ errorCode: "RateLimited", message: "m", echo: null });
    expect(errFrameOf({ type: "error", error_code: "ServerError" })).toEqual({ errorCode: "ServerError", message: null, echo: null });
    expect(errFrameOf({ order_response: {} })).toBeNull();
  });
});

describe("MDS one-shot snapshot", () => {
  const frame = JSON.parse(readFileSync(new URL("../fixtures/qfex/mds-market-stats.json", import.meta.url), "utf8")) as Record<string, unknown>;

  it("parses the captured market_stats frame (mark with its own time, OI, notional volume)", () => {
    const snap = parseMarketStats(frame);
    const mark = snap.marks.get("AAPL-USD");
    expect(mark?.price).toMatch(/^\d+(\.\d+)?$/);
    expect(Number.isFinite(mark?.time)).toBe(true);
    expect(snap.marks.has("SKHYNIX-KRW")).toBe(true);
    expect(snap.openInterest.get("AAPL-USD")).toBeDefined();
    expect(snap.volumeNotional.get("AAPL-USD")).toBeDefined();
  });

  it("subscribes to the requested symbol and resolves on the first market_stats frame", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => wss.once("listening", () => r()));
    const subs: unknown[] = [];
    wss.on("connection", ws => ws.on("message", d => {
      subs.push(JSON.parse(d.toString()));
      ws.send(JSON.stringify({ type: "subscribed", channels: ["market_stats"], symbols: ["AAPL-USD"] }));
      ws.send(JSON.stringify(frame));
    }));
    try {
      const snap = await fetchQfexMarketStats(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, "AAPL-USD", 1000);
      expect(subs).toEqual([{ type: "subscribe", channels: ["market_stats"], symbols: ["AAPL-USD"] }]);
      expect(snap.marks.get("AAPL-USD")).toBeDefined();
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>(r => wss.close(() => r()));
    }
  });

  it("no snapshot in time → PRICE_STALE (nothing substituted)", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => wss.once("listening", () => r()));
    try {
      const e = await rejection(fetchQfexMarketStats(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, "AAPL-USD", 100));
      expect(e.structured.code).toBe("PRICE_STALE");
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>(r => wss.close(() => r()));
    }
  });
});
