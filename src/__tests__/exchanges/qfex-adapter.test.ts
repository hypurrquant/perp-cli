/**
 * QfexAdapter TradingV2 mapping: protected IOC, GTC / ALO
 * acknowledged-not-open, venue-final IOC outcomes, the reduce-only pre-send rule + echo check, the stop gate, non-USD refusal,
 * per-symbol order type / TIF validation, bands and precision from /refdata, funding null,
 * the withdraw gate enforced inside withdraw(), deposit address assertion.
 *
 * No network: fetch is mocked (real captured /refdata), the trade session and the MDS snapshot
 * are stubbed. HOME is isolated by the vitest setup file.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

const fakeSession = {
  addOrder: vi.fn(),
  cancelOrder: vi.fn(),
  cancelStopOrder: vi.fn(),
  cancelAll: vi.fn(),
  modifyOrder: vi.fn(),
  getUserOrders: vi.fn(),
};
const sessionOpts: Array<Record<string, unknown>> = [];
const marketStats = vi.fn();
// The withdraw implementation is kept behind QFEX_WITHDRAW_ENABLED (off in the product); these
// tests exercise it with the switch on. The disabled refusal is covered in qfex-gates.test.ts.
vi.mock("../../exchanges/venues/qfex.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/venues/qfex.js")>()),
  QFEX_WITHDRAW_ENABLED: true,
}));
vi.mock("../../exchanges/qfex/ws-transport.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/qfex/ws-transport.js")>()),
  qfexTradeSession: (opts: Record<string, unknown>) => { sessionOpts.push(opts); return fakeSession; },
  fetchQfexMarketStats: (...a: unknown[]) => marketStats(...a),
}));

import "../../exchanges/venues/index.js";
import { saveVenueSecret } from "../../agent-wallet/venue-keystore.js";
import { PerpError } from "../../errors.js";
import { READ_ONLY_CREDENTIALS, type VenueCreateContext } from "../../exchanges/venue.js";
import { qfexVenue } from "../../exchanges/venues/qfex.js";
import { QfexAdapter, buildAddOrderParams, plainNumber, reduceOnlyUnconfirmedFrame } from "../../exchanges/qfex/adapter.js";
import { resolveBuilderGate } from "../../exchanges/builder-fee.js";
import { confirmWithdrawGateChange } from "../../withdraw-gate.js";
import { isIocOutcomeCapable } from "../../exchanges/ioc-outcome.js";
import { automationGateOf, reduceOnlyGateOf, stopOrderGateOf } from "../../exchanges/trading-v2.js";
import type { OrderRequest } from "../../exchanges/venue-types.js";
import type { QfexAgentMeta, WithdrawGate } from "../../settings.js";
import type { QfexAddResult, QfexOrderResponse } from "../../exchanges/qfex/ws-transport.js";

const PUB = "qfex_pub_adapter_test";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEST = "0x89abcdef0123456789abcdef0123456789abcdef";
const refdata = JSON.parse(readFileSync(new URL("../fixtures/qfex/refdata.json", import.meta.url), "utf8")) as { data: Array<Record<string, unknown>> };
const SLIP = { bps: 50, source: "default" as const };

function meta(over: Partial<QfexAgentMeta> = {}): QfexAgentMeta {
  return {
    kind: "qfex", agentName: "web-qfex", publicKey: PUB, keystorePath: "", accountId: ACCOUNT, isPrimaryAccount: true,
    permissions: { viewPositions: true, viewBalance: true, viewOrders: true, executeOrders: null, depositWithdraw: null },
    network: "mainnet", approvedAt: "2026-10-04T00:00:00Z", source: "imported", ...over,
  };
}

function ctx(over: Partial<VenueCreateContext> = {}, m: QfexAgentMeta = meta()): VenueCreateContext {
  return { network: "mainnet", credentials: { ...READ_ONLY_CREDENTIALS, agent: m }, noAgent: false, hlDex: null, readOnly: false, noBuilder: false, ...over };
}

function adapter(over: Partial<VenueCreateContext> = {}, m: QfexAgentMeta = meta()): QfexAdapter {
  return new QfexAdapter(qfexVenue, ctx(over, m));
}

function reply(status: number, body: unknown) {
  const text = body === null ? "" : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => text };
}

let fetchMock: ReturnType<typeof vi.fn>;
let refdataBody: { data: Array<Record<string, unknown>> };
/** Extra REST routes per test: `${METHOD} ${pathname}` → response. */
let routes: Record<string, () => unknown>;
const requests: Array<{ method: string; url: URL; body: unknown; headers: Record<string, string> }> = [];

function mark(price: string, ageMs = 500) {
  marketStats.mockResolvedValue({
    marks: new Map([["AAPL-USD", { price, time: Date.now() - ageMs }], ["CL-USD", { price: "91.2", time: Date.now() - ageMs }]]),
    openInterest: new Map(), volumeNotional: new Map(), frame: {},
  });
}

function order(req: Partial<OrderRequest> = {}): OrderRequest {
  return {
    symbol: "AAPL", side: "buy", type: "limit", size: "1", price: "333.40", triggerPrice: null, triggerSource: null, tif: "GTC",
    reduceOnly: false, clientOrderId: CID, slippage: null, tpsl: null, ...req,
  };
}

function resp(o: Partial<QfexOrderResponse>): QfexOrderResponse {
  return {
    order_id: "o1", symbol: "AAPL-USD", status: "ACK", quantity: 1, price: 333.4, take_profit: 0, stop_loss: 0, side: "BUY", type: "LIMIT",
    time_in_force: "IOC", user_id: ACCOUNT, client_order_id: CID, quantity_remaining: 1, update_time: 1, trade_id: null, ...o,
  };
}

function added(o: Partial<QfexAddResult>): QfexAddResult {
  return { orderId: "o1", clientOrderId: CID, responses: [resp({})], fills: [], terminal: null, ended: "resting", frames: [], userIdMismatches: [], ...o };
}

async function rejection(p: Promise<unknown>): Promise<PerpError> {
  try { await p; } catch (e) { return e as PerpError; }
  throw new Error("expected a rejection");
}

beforeAll(() => {
  saveVenueSecret("qfex-agents", PUB, JSON.stringify({ publicKey: PUB, secret: "qfex_secret_adapter_test" }), "");
});

beforeEach(() => {
  const ledger = resolve(process.env.HOME as string, ".perp", "withdraw-ledger.json");
  if (existsSync(ledger)) rmSync(ledger);
  refdataBody = JSON.parse(JSON.stringify(refdata));
  routes = {};
  requests.length = 0;
  sessionOpts.length = 0;
  for (const f of Object.values(fakeSession)) f.mockReset();
  marketStats.mockReset();
  mark("333.41");
  fetchMock = vi.fn(async (input: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    requests.push({ method, url, body: init.body === undefined ? null : JSON.parse(init.body), headers: init.headers ?? {} });
    if (method === "GET" && url.pathname === "/refdata") return reply(200, refdataBody);
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) throw new Error(`unexpected request ${method} ${url.href}`);
    return route();
  });
  vi.stubGlobal("fetch", fetchMock);
});

// ── Construction ──

describe("construction", () => {
  it("refuses a key imported for another network (never used across networks)", () => {
    expect(() => adapter({ network: "testnet" })).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "AGENT_NOT_REGISTERED" }) }));
  });

  it("refuses --no-agent, a missing key and a record without a bound account id", () => {
    expect(() => adapter({ noAgent: true })).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "NO_SIGNER_AVAILABLE" }) }));
    expect(() => new QfexAdapter(qfexVenue, { ...ctx(), credentials: READ_ONLY_CREDENTIALS })).toThrow(/No QFEX API key imported/);
    expect(() => adapter({}, meta({ accountId: null as unknown as string }))).toThrow(/no bound account id/);
  });

  it("a read-only adapter needs no key and cannot place", async () => {
    const a = adapter({ readOnly: true, credentials: READ_ONLY_CREDENTIALS });
    const e = await rejection(a.placeOrder(order()));
    expect(e.structured.code).toBe("NO_SIGNER_AVAILABLE"); // definite: nothing was sent
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });

  it("the session is keyed by network + key + the bound account; the builder code rides on it", async () => {
    fakeSession.getUserOrders.mockResolvedValue([]);
    const a = adapter();
    a.builderFee = resolveBuilderGate("qfex", { network: "mainnet", noBuilder: false, readOnly: false }, { qfex: { code: "33333333-3333-4333-8333-333333333333" } }, null, () => "");
    await a.getOpenOrders();
    expect(sessionOpts[0]).toMatchObject({ url: "wss://trade.qfex.com", network: "mainnet", accountId: ACCOUNT, builderCode: "33333333-3333-4333-8333-333333333333" });
    expect((sessionOpts[0].credentials as { publicKey: string }).publicKey).toBe(PUB);
  });
});

// ── Reduce-only (Q2: the venue accepts an oversize reduce-only order, so the adapter sizes it) ──

describe("reduce-only: pre-send rule on live reads, echo check after the ACK", () => {
  const positions = (rows: unknown) => { routes["GET /user/positions"] = () => reply(200, { balance: {}, positions: rows }); };
  const long = (position: number) => positions([{ symbol: "AAPL-USD", position, average_price: 330, leverage: 5, unrealised_pnl: 0 }]);
  // Reduce-only limits are IOC only (capability reduceOnlyTif) until QFEX_RESTING_REDUCE_ONLY_VERIFIED.
  const roLimit = (over: Partial<OrderRequest> = {}) => order({ side: "sell", reduceOnly: true, tif: "IOC", ...over });
  const roMarket = (over: Partial<OrderRequest> = {}) => order({ side: "sell", type: "market", price: null, tif: null, slippage: SLIP, reduceOnly: true, ...over });
  const ack = (o: Partial<QfexOrderResponse> = {}) => resp({ side: "SELL", time_in_force: "IOC", reduce_only: true, ...o });
  const notSent = () => expect(fakeSession.addOrder).not.toHaveBeenCalled();

  beforeEach(() => { fakeSession.getUserOrders.mockResolvedValue([]); });

  it("the wire-format and stop gates are open (Q2 wire, Q21 passed); automation stays gated", () => {
    expect(reduceOnlyGateOf(adapter())).toBeNull();
    expect(stopOrderGateOf(adapter())).toBeNull();
    const automation = automationGateOf(adapter()) as PerpError;
    expect(automation.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(automation.structured.details).toMatchObject({ venue: "qfex", feature: "automation" });
  });

  it("reduce-only IOC limit: position and open orders are read, reduce_only: true (boolean) is sent, the ACK echo is accepted", async () => {
    long(2);
    fakeSession.addOrder.mockResolvedValue(added({ ended: "timeout", responses: [ack()] }));
    const r = await adapter().placeOrder(roLimit({ size: "2" }));
    expect(requests.some(q => q.url.pathname === "/user/positions")).toBe(true);
    expect(fakeSession.getUserOrders).toHaveBeenCalledWith("AAPL-USD");
    expect(fakeSession.addOrder.mock.calls[0][0].params).toEqual({
      symbol: "AAPL-USD", side: "SELL", order_type: "LIMIT", order_time_in_force: "IOC", quantity: 2, price: 333.4, client_order_id: CID, reduce_only: true,
    });
    expect(r).toMatchObject({ status: "accepted", finality: "pending", orderId: "o1" });
  });

  it.each(["GTC", "ALO", "FOK"] as const)("a %s reduce-only limit is refused before any read or send (resting reduce-only is unverified)", async tif => {
    expect(qfexVenue.capabilities!.reduceOnlyTif).toEqual(["IOC"]);
    long(2);
    const e = await rejection(adapter().placeOrder(roLimit({ tif })));
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.structured.details).toMatchObject({ feature: "restingReduceOnly" });
    expect(e.structured.remediation).toMatch(/Use --tif IOC, or set a take-profit \/ stop-loss on the position instead: perp trade tpsl AAPL <long\|short> --tp <price> \[--size <qty>\] -e qfex/);
    expect(e.structured.remediation).toMatch(/trade tpsl/); // stops are placed on qfex (Q21 passed)
    expect(requests.some(q => q.url.pathname === "/user/positions")).toBe(false);
    expect(fakeSession.getUserOrders).not.toHaveBeenCalled();
    notSent();
  });

  it("market close = protected IOC LIMIT with reduce_only (trade close / reduce / close-all / flatten, legacy shim)", async () => {
    long(1);
    const filled = ack({ status: "FILLED", quantity_remaining: 0, time_in_force: "IOC" });
    fakeSession.addOrder.mockResolvedValue(added({ ended: "terminal", responses: [ack({ time_in_force: "IOC" }), filled], terminal: filled }));
    const r = await adapter().marketOrder("AAPL", "sell", "1", { reduceOnly: true, slippage: SLIP });
    const sent = fakeSession.addOrder.mock.calls[0][0];
    expect(sent.params).toMatchObject({ side: "SELL", order_type: "LIMIT", order_time_in_force: "IOC", quantity: 1, price: 331.74, reduce_only: true });
    expect(sent.immediate).toBe(true);
    expect(r).toMatchObject({ status: "filled", finality: "final", filledSize: "1" });
    expect(r.execution.method).toBe("protectedIoc");
  });

  it("a short position is reduced by a buy (legacy limitOrder shim, IOC)", async () => {
    long(-1);
    fakeSession.addOrder.mockResolvedValue(added({ ended: "timeout", responses: [ack({ side: "BUY", time_in_force: "IOC" })] }));
    await adapter().limitOrder("AAPL", "buy", "333.4", "1", { reduceOnly: true, tif: "IOC" });
    expect(fakeSession.addOrder.mock.calls[0][0].params).toMatchObject({ side: "BUY", reduce_only: true, quantity: 1 });
  });

  it.each([
    ["no row for the symbol", [{ symbol: "CL-USD", position: 3, average_price: 90, leverage: 5, unrealised_pnl: 0 }]],
    ["a zero position", [{ symbol: "AAPL-USD", position: 0, average_price: 0, leverage: 5, unrealised_pnl: 0 }]],
    ["an empty list (JSON null)", null],
  ])("no position (%s) → POSITION_NOT_FOUND locally, nothing sent", async (_n, rows) => {
    positions(rows);
    const e = await rejection(adapter().placeOrder(roLimit()));
    expect(e.structured.code).toBe("POSITION_NOT_FOUND");
    expect(e.structured.details).toMatchObject({ sent: false });
    expect(e.message).toMatch(/not sent/);
    expect(e.structured.remediation).toMatch(/account positions/);
    notSent();
  });

  it("same side as the position → INVALID_PARAMS, nothing sent", async () => {
    long(1);
    const e = await rejection(adapter().placeOrder(roLimit({ side: "buy" })));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(e.message).toMatch(/reduce-only buy cannot reduce a long position/);
    expect(e.structured.remediation).toMatch(/sell/);
    long(-1);
    expect((await rejection(adapter().placeOrder(roLimit({ side: "sell" })))).message).toMatch(/reduce-only sell cannot reduce a short position/);
    notSent();
  });

  it("size above the position → SIZE_TOO_LARGE, nothing sent (the venue would accept it)", async () => {
    long(1);
    const e = await rejection(adapter().placeOrder(roLimit({ size: "2" })));
    expect(e.structured.code).toBe("SIZE_TOO_LARGE");
    expect(e.structured.details).toMatchObject({ position: "1", positionSide: "long", reservedByOpenOrders: "0", available: "1", reservingOrderIds: [] });
    expect(e.structured.remediation).toBe("Use a size of at most 1");
    notSent();
  });

  it("ALL other open orders on that symbol and side reserve their remaining quantity — a plain SELL consumes the long too; stops are noted, not counted", async () => {
    long(3);
    fakeSession.getUserOrders.mockResolvedValue([
      resp({ order_id: "r1", side: "SELL", quantity: 2, quantity_remaining: 1, reduce_only: true }),
      resp({ order_id: "n1", side: "SELL", quantity: 5, quantity_remaining: 0.5, reduce_only: false }), // a normal sell reserves too
      resp({ order_id: "b1", side: "BUY", quantity: 5, quantity_remaining: 5, reduce_only: true }), // other side
      resp({ order_id: "x1", symbol: "CL-USD", side: "SELL", quantity: 9, quantity_remaining: 9, reduce_only: true }), // other symbol
      resp({ order_id: "s1", side: "SELL", type: "STOP_LOSS", quantity: 3, quantity_remaining: 3 }), // stops are not counted
    ]);
    const e = await rejection(adapter().placeOrder(roLimit({ size: "2" })));
    expect(e.structured.code).toBe("SIZE_TOO_LARGE");
    expect(e.message).toMatch(/3 held − 1\.5 in other open SELL orders = 1\.5/);
    expect(e.structured.details).toMatchObject({ position: "3", reservedByOpenOrders: "1.5", available: "1.5", reservingOrderIds: ["r1", "n1"] });
    expect(e.structured.remediation).toMatch(/at most 1\.5, or cancel the open SELL order\(s\) first: perp trade cancel AAPL <orderId> -e qfex \(r1, n1\)/);
    notSent();
    fakeSession.addOrder.mockResolvedValue(added({ ended: "timeout", responses: [ack()] }));
    const r = await adapter().placeOrder(roLimit({ size: "1.5" })); // exactly what is left
    expect(fakeSession.addOrder.mock.calls[0][0].params.quantity).toBe(1.5);
    expect(r.execution.notes.join(" | ")).toMatch(/1 open stop order\(s\) on AAPL-USD \(s1\) were not counted against the reducible size/);
  });

  it("no stop rows → no stop note", async () => {
    long(1);
    fakeSession.addOrder.mockResolvedValue(added({ ended: "timeout", responses: [ack()] }));
    const r = await adapter().placeOrder(roLimit());
    expect(r.execution.notes.join(" | ")).not.toMatch(/stop order/);
  });

  it("reserved ≥ position → available 0, refused", async () => {
    long(1);
    fakeSession.getUserOrders.mockResolvedValue([resp({ order_id: "r1", side: "SELL", quantity: 2, quantity_remaining: 2, reduce_only: true })]);
    const e = await rejection(adapter().placeOrder(roMarket()));
    expect(e.structured.details).toMatchObject({ available: "0", reservedByOpenOrders: "2" });
    notSent();
  });

  it("a same-side open order that does not report reduce_only → refused as not sent, with the cancel command and the order ids", async () => {
    long(3);
    fakeSession.getUserOrders.mockResolvedValue([resp({ order_id: "u1", side: "SELL" }), resp({ order_id: "u2", side: "SELL" })]);
    const e = await rejection(adapter().placeOrder(roLimit()));
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.message).toMatch(/not sent: .*u1, u2 do not report reduce_only/);
    expect(e.structured.details).toMatchObject({ sent: false, unreadableOrderIds: ["u1", "u2"] });
    expect(e.structured.remediation).toMatch(/perp trade cancel AAPL <orderId> -e qfex \(u1, u2\)/);
    notSent();
  });

  it("a sub-minimum residual can be closed whole (min_quantity is left to the venue); a sub-minimum PART of a position is refused", async () => {
    // AAPL-USD: lot 0.001, min_quantity above 0.005 (see "limit orders": 0.005 → SIZE_TOO_SMALL).
    long(0.005);
    fakeSession.addOrder.mockResolvedValue(added({ ended: "timeout", responses: [ack({ quantity: 0.005, quantity_remaining: 0.005 })] }));
    const r = await adapter().placeOrder(roMarket({ size: "0.005" }));
    expect(fakeSession.addOrder.mock.calls[0][0].params).toMatchObject({ quantity: 0.005, reduce_only: true });
    expect(r.execution.notes.join(" | ")).toMatch(/size 0\.005 is below the venue minimum .* closes the whole position \(venue behaviour for a sub-minimum reduce-only order is unverified\)/);

    fakeSession.addOrder.mockClear();
    long(1);
    const e = await rejection(adapter().placeOrder(roMarket({ size: "0.005" })));
    expect(e.structured.code).toBe("SIZE_TOO_SMALL");
    expect(e.message).toMatch(/is not the whole position \(1\) — not sent/);
    notSent();

    long(0.006); // a residual larger than the order: still a part, still refused — with the whole-position hint
    const part = await rejection(adapter().placeOrder(roMarket({ size: "0.005" })));
    expect(part.structured.code).toBe("SIZE_TOO_SMALL");
    expect(part.structured.remediation).toMatch(/or close the whole position: 0\.006/);
    notSent();
  });

  it.each([
    ["the position read fails", () => { routes["GET /user/positions"] = () => reply(503, { error: "down" }); }],
    ["the open-order read fails", () => { long(1); fakeSession.getUserOrders.mockRejectedValue(new PerpError("TIMEOUT", "no reply to get_user_orders")); }],
    ["the position is not a number", () => positions([{ symbol: "AAPL-USD", position: "1" }])],
    ["two rows for the symbol", () => positions([{ symbol: "AAPL-USD", position: 1 }, { symbol: "AAPL-USD", position: 2 }])],
  ])("%s → definite 'not sent' (ORDER_REJECTED), never sent blind", async (_n, arrange) => {
    arrange();
    const e = await rejection(adapter().placeOrder(roLimit()));
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.message).toMatch(/reduce-only add_order AAPL-USD not sent/);
    notSent();
  });

  it("a position that is not a lot multiple is floored, never rounded up", async () => {
    long(0.9996); // lot 0.001
    const e = await rejection(adapter().placeOrder(roLimit({ size: "1" })));
    expect(e.structured.details).toMatchObject({ position: "0.999", available: "0.999" });
    notSent();
  });

  it.each([
    ["false", false, /echoed as false/],
    ["missing", undefined, /reduce_only not reported/],
  ])("ACK echo %s → ORDER_PENDING with a loud remediation; no cancel is sent", async (_n, echo, re) => {
    long(1);
    fakeSession.addOrder.mockResolvedValue(added({ ended: "timeout", responses: [resp({ side: "SELL", ...(echo === undefined ? {} : { reduce_only: echo }) })] }));
    const e = await rejection(adapter().placeOrder(roLimit()));
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.message).toMatch(re);
    expect(e.message).toMatch(/NORMAL order that can open or flip a position\. It was NOT cancelled automatically/);
    expect(e.structured.details).toMatchObject({ alarm: "reduceOnlyNotEchoed", orderId: "o1", clientOrderId: CID, reduceOnlyEcho: echo === undefined ? null : echo });
    expect(e.structured.remediation).toMatch(new RegExp(`Do NOT resubmit.*trade status c:${CID} --symbol AAPL -e qfex.*trade cancel AAPL o1 -e qfex.*account positions`));
    expect(fakeSession.cancelOrder).not.toHaveBeenCalled();
    expect(fakeSession.addOrder).toHaveBeenCalledTimes(1);
  });

  it("a later frame of the order without the echo is the same alarm — even on a zero-fill IOC (not reported as iocNoFill)", async () => {
    long(1);
    const cancelled = resp({ side: "SELL", status: "IOC_CANCELLED" });
    fakeSession.addOrder.mockResolvedValue(added({ ended: "terminal", responses: [ack({ time_in_force: "IOC" }), cancelled], terminal: cancelled }));
    const e = await rejection(adapter().placeOrder(roMarket()));
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.details).toMatchObject({ alarm: "reduceOnlyNotEchoed" });
  });

  it("production frames 2026-10-05 (ACK true → FILLED reduce_only FALSE → CANCELLED true): filled 0.003, final, no alarm, capping noted", async () => {
    // Raw add_order SELL LIMIT IOC 0.006 @ 4125, reduce_only true, venue position 0.003 at match time.
    long(0.006); // what the pre-send read saw; the position shrank to 0.003 before the match
    const o = { quantity: 0.006, price: 4125 };
    const ackF = ack({ ...o, quantity_remaining: 0.006 });
    const filledF = resp({ side: "SELL", time_in_force: "IOC", status: "FILLED", quantity: 0.003, price: 4145, quantity_remaining: 0.003, trade_id: "t1", reduce_only: false });
    const cancelledF = ack({ ...o, status: "CANCELLED", quantity_remaining: 0.003 });
    fakeSession.addOrder.mockResolvedValue(added({
      ended: "terminal", responses: [ackF, filledF, cancelledF], terminal: cancelledF,
      fills: [{ trade_id: "t1", symbol: "AAPL-USD", price: 4145, quantity: 0.003, side: "SELL", order_id: "o1", client_order_id: CID, fee: 0 }],
    }));
    const r = await adapter().placeOrder(roLimit({ size: "0.006", price: "4125" }));
    expect(r).toMatchObject({ status: "partiallyFilled", finality: "final", filledSize: "0.003", avgPrice: "4145", orderId: "o1" });
    expect(r.execution.notes.join(" | ")).toMatch(/reduce-only: the venue filled 0\.003 and cancelled the remainder — it caps a reduce-only order at the position size at match time/);
    expect(fakeSession.cancelOrder).not.toHaveBeenCalled();
  });

  it("the echo rule is explicit: order frames (ACK / non-fill status) must echo true; fill frames are not judged", () => {
    const fill = (reduce_only: boolean | undefined) => resp({ status: "FILLED", ...(reduce_only === undefined ? {} : { reduce_only }) });
    expect(reduceOnlyUnconfirmedFrame([ack(), fill(false)])).toBeNull();
    expect(reduceOnlyUnconfirmedFrame([ack(), fill(undefined), ack({ status: "CANCELLED" })])).toBeNull();
    // An order frame without the echo is the alarm even when a fill frame says true.
    expect(reduceOnlyUnconfirmedFrame([ack({ reduce_only: false }), fill(true)])?.status).toBe("ACK");
    expect(reduceOnlyUnconfirmedFrame([ack(), fill(true), resp({ status: "CANCELLED", reduce_only: false })])?.status).toBe("CANCELLED");
    // No order frame at all: nothing confirms the flag, so the fill frames are judged as they are.
    expect(reduceOnlyUnconfirmedFrame([fill(false)])?.status).toBe("FILLED");
    expect(reduceOnlyUnconfirmedFrame([fill(true)])).toBeNull();
  });

  it("unknown outcome read back by client id: an OPEN row must confirm reduce_only (false or missing → alarm)", async () => {
    long(1);
    fakeSession.addOrder.mockRejectedValue(new PerpError("ORDER_PENDING", "unknown", {}));
    const row = resp({ order_id: "o7", side: "SELL", time_in_force: "IOC", reduce_only: true });
    fakeSession.getUserOrders.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    expect(await adapter().placeOrder(roLimit())).toMatchObject({ status: "open", orderId: "o7" });
    for (const echo of [false, undefined]) {
      fakeSession.getUserOrders.mockReset();
      const { reduce_only: _dropped, ...bare } = row;
      fakeSession.getUserOrders.mockResolvedValueOnce([]).mockResolvedValueOnce([echo === undefined ? bare : { ...row, reduce_only: echo }]);
      const e = await rejection(adapter().placeOrder(roLimit()));
      expect(e.structured.code).toBe("ORDER_PENDING");
      expect(e.structured.details).toMatchObject({ alarm: "reduceOnlyNotEchoed", orderId: "o7", reduceOnlyEcho: echo === undefined ? null : echo });
    }
  });

  describe("unknown outcome read back from the historic store (rows carry no reduce_only)", () => {
    const historic = (over: Record<string, unknown>) => {
      routes["GET /user/historic-orders"] = () => reply(200, { count: 1, data: [{
        order_id: "o9", client_order_id: CID, symbol: "AAPL-USD", side: "SELL", type: "LIMIT", time_in_force: "IOC", price: 331.74, quantity: 1,
        filled_qty: 1, avg_price: 333.45, terminal_status: "FILLED", execution_state: "DONE", status_ts: "2026-10-05T00:00:00Z", ...over,
      }] });
    };
    beforeEach(() => {
      long(1);
      fakeSession.addOrder.mockRejectedValue(new PerpError("ORDER_PENDING", "unknown", {}));
    });

    it("a TERMINAL row without reduce_only is returned with a note — no false alarm", async () => {
      historic({});
      const r = await adapter().placeOrder(roMarket());
      expect(r).toMatchObject({ status: "filled", finality: "final", orderId: "o9", filledSize: "1" });
      expect(r.execution.notes.join(" | ")).toMatch(/reduce_only not reported on historic rows/);
    });

    it("an explicit reduce_only: false on the row is the alarm, terminal or not", async () => {
      historic({ reduce_only: false });
      const e = await rejection(adapter().placeOrder(roMarket()));
      expect(e.structured.code).toBe("ORDER_PENDING");
      expect(e.structured.details).toMatchObject({ alarm: "reduceOnlyNotEchoed", orderId: "o9", reduceOnlyEcho: false });
    });

    it("a row that reports reduce_only: true needs no note", async () => {
      historic({ reduce_only: true });
      const r = await adapter().placeOrder(roMarket());
      expect(r.execution.notes.join(" | ")).not.toMatch(/reduce_only not reported/);
    });

    it("a NON-terminal historic row without reduce_only may still be live → alarm", async () => {
      historic({ terminal_status: "", filled_qty: 0, avg_price: null });
      const e = await rejection(adapter().placeOrder(roMarket()));
      expect(e.structured.code).toBe("ORDER_PENDING");
      expect(e.structured.details).toMatchObject({ alarm: "reduceOnlyNotEchoed", reduceOnlyEcho: null });
    });
  });

  it("a plain order reads neither the position nor the open orders, and needs no echo", async () => {
    fakeSession.addOrder.mockResolvedValue(added({}));
    await adapter().placeOrder(order());
    expect(requests.some(q => q.url.pathname === "/user/positions")).toBe(false);
    expect(fakeSession.getUserOrders).not.toHaveBeenCalled();
  });

  it("buildAddOrderParams never emits reduce_only / take_profit / stop_loss for a normal order, and refuses reduce-only when the format is unset", () => {
    const base = { venueSymbol: "AAPL-USD", side: "buy" as const, orderType: "LIMIT" as const, tif: "GTC" as const, quantity: "1", price: "333.4", clientOrderId: CID };
    expect(buildAddOrderParams({ ...base, reduceOnly: false }, null)).toEqual({
      symbol: "AAPL-USD", side: "BUY", order_type: "LIMIT", order_time_in_force: "GTC", quantity: 1, price: 333.4, client_order_id: CID,
    });
    expect(() => buildAddOrderParams({ ...base, reduceOnly: true }, null)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }) }));
    expect(buildAddOrderParams({ ...base, reduceOnly: true }, "boolean").reduce_only).toBe(true);
    expect(buildAddOrderParams({ ...base, reduceOnly: true }, "integer").reduce_only).toBe(1);
  });
});

describe("stop orders (Q21 passed on production 2026-10-12)", () => {
  const positions = (rows: unknown) => { routes["GET /user/positions"] = () => reply(200, { balance: {}, positions: rows }); };
  const long = (position: number) => positions([{ symbol: "AAPL-USD", position, average_price: 330, leverage: 5, unrealised_pnl: 0 }]);
  const stopAck = (o: Partial<QfexOrderResponse> = {}) => resp({ order_id: "s1", side: "SELL", type: "STOP_LOSS", time_in_force: "GTC", reduce_only: true, quantity: 1, quantity_remaining: 1, price: 300, ...o });
  const stop = (over: Partial<OrderRequest> = {}) => order({ side: "sell", type: "stopMarket", price: null, tif: null, triggerPrice: "300", reduceOnly: true, ...over });

  it("trade stop below the mark on a long → STOP_LOSS add_order (trigger in price, client id, reduce_only true); listed row → open / final", async () => {
    long(2);
    fakeSession.getUserOrders.mockResolvedValueOnce([]).mockResolvedValueOnce([stopAck()]);
    fakeSession.addOrder.mockResolvedValue(added({ orderId: "s1", responses: [stopAck()] }));
    const r = await adapter().placeOrder(stop());
    expect(fakeSession.addOrder.mock.calls[0][0].params).toEqual({ symbol: "AAPL-USD", side: "SELL", order_type: "STOP_LOSS", order_time_in_force: "GTC", quantity: 1, price: 300, client_order_id: CID, reduce_only: true });
    expect(fakeSession.addOrder.mock.calls[0][0].immediate).toBe(false);
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "s1", clientOrderId: CID });
  });

  it("above the mark on a long → TAKE_PROFIT; an explicit TP/SL leg keeps its kind", async () => {
    long(2);
    fakeSession.getUserOrders.mockResolvedValue([]);
    fakeSession.addOrder.mockResolvedValue(added({ orderId: "s1", responses: [stopAck({ type: "TAKE_PROFIT" })] }));
    await adapter().placeOrder(stop({ triggerPrice: "350" }));
    expect(fakeSession.addOrder.mock.calls[0][0].params.order_type).toBe("TAKE_PROFIT");
    await adapter().placeTpSlLeg({ symbol: "AAPL", closeSide: "sell", size: "1", trigger: "350", kind: "sl", limitPrice: null });
    expect(fakeSession.addOrder.mock.calls[1][0].params.order_type).toBe("STOP_LOSS");
  });

  it("not listed yet after the ACK → accepted / pending with the status command", async () => {
    long(2);
    fakeSession.getUserOrders.mockResolvedValue([]);
    fakeSession.addOrder.mockResolvedValue(added({ orderId: "s1", responses: [stopAck()] }));
    const r = await adapter().placeOrder(stop());
    expect(r).toMatchObject({ status: "accepted", finality: "pending" });
    expect(r.execution.notes.join(" ")).toMatch(/perp trade status c:/);
  });

  it("no position / wrong side / size + other same-type stops > position → refused, nothing sent", async () => {
    positions([]);
    fakeSession.getUserOrders.mockResolvedValue([]);
    expect((await rejection(adapter().placeOrder(stop()))).structured.code).toBe("POSITION_NOT_FOUND");
    long(2);
    expect((await rejection(adapter().placeOrder(stop({ side: "buy", triggerPrice: "350" })))).structured.code).toBe("INVALID_PARAMS");
    fakeSession.getUserOrders.mockResolvedValue([stopAck({ order_id: "old", quantity: 1.5 })]);
    expect((await rejection(adapter().placeOrder(stop()))).structured.code).toBe("SIZE_TOO_LARGE");
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });

  it("an ACK without reduce_only true → ORDER_PENDING alarm (never assumed reduce-only)", async () => {
    long(2);
    fakeSession.getUserOrders.mockResolvedValue([]);
    fakeSession.addOrder.mockResolvedValue(added({ orderId: "s1", responses: [stopAck({ reduce_only: false })] }));
    const e = await rejection(adapter().placeOrder(stop()));
    expect(e.structured).toMatchObject({ code: "ORDER_PENDING", details: { alarm: "reduceOnlyNotEchoed" } });
  });

  it("--tp/--sl and trade tpsl legs reach the QFEX adapter through placeTpSlLeg (separateOrders)", async () => {
    long(2);
    fakeSession.getUserOrders.mockResolvedValue([]);
    fakeSession.addOrder.mockResolvedValue(added({ orderId: "s1", responses: [stopAck({ type: "TAKE_PROFIT" })] }));
    const { placeTpSlLeg } = await import("../../exchanges/legacy-trading-v2.js");
    await placeTpSlLeg(adapter() as never, "mainnet", { symbol: "AAPL", closeSide: "sell", size: "1", trigger: "350", kind: "tp", limitPrice: null, slippage: SLIP });
    expect(fakeSession.addOrder.mock.calls[0][0].params).toMatchObject({ order_type: "TAKE_PROFIT", side: "SELL", price: 350, reduce_only: true });
    await expect(placeTpSlLeg(adapter() as never, "mainnet", { symbol: "AAPL", closeSide: "sell", size: "1", trigger: "350", kind: "tp", limitPrice: "349", slippage: SLIP }))
      .rejects.toMatchObject({ structured: { details: { feature: "stopLimit" } } });
  });

  it("the legacy stopOrder shim places the same reduce-only stop", async () => {
    long(2);
    fakeSession.getUserOrders.mockResolvedValue([]);
    fakeSession.addOrder.mockResolvedValue(added({ orderId: "s1", responses: [stopAck()] }));
    await adapter().stopOrder("AAPL", "sell", "1", "300", { reduceOnly: true });
    expect(fakeSession.addOrder.mock.calls[0][0].params).toMatchObject({ order_type: "STOP_LOSS", reduce_only: true });
  });

  it("stops that open and stop-limit are unsupported too", async () => {
    const opening = await rejection(adapter().placeOrder(order({ type: "stopMarket", price: null, tif: null, triggerPrice: "300" })));
    expect(opening.structured.details).toMatchObject({ feature: "openingStop" });
    const stopLimit = await rejection(adapter().placeOrder(order({ type: "stopLimit", triggerPrice: "300" })));
    expect(stopLimit.structured.details).toMatchObject({ feature: "stopLimit" });
  });

});

// ── Market orders ──

describe("market order = protected IOC LIMIT on the single-symbol mark", () => {
  const market = (over: Partial<OrderRequest> = {}) => order({ type: "market", price: null, tif: null, slippage: SLIP, ...over });

  it("sends LIMIT IOC at the tick-aligned protection price with a generated id; fills come from venue frames", async () => {
    fakeSession.addOrder.mockResolvedValue(added({
      ended: "terminal",
      responses: [resp({}), resp({ status: "FILLED", quantity_remaining: 0 })],
      terminal: resp({ status: "FILLED", quantity_remaining: 0 }),
      fills: [
        { trade_id: "t1", symbol: "AAPL-USD", price: 333.4, quantity: 0.4, side: "BUY", order_id: "o1", client_order_id: CID, fee: 0 },
        { trade_id: "t2", symbol: "AAPL-USD", price: 333.5, quantity: 0.6, side: "BUY", order_id: "o1", client_order_id: CID, fee: 0 },
      ],
    }));
    const a = adapter();
    const r = await a.placeOrder(market());
    expect(marketStats).toHaveBeenCalledWith("wss://mds.qfex.com", "AAPL-USD", expect.any(Number)); // one symbol, not "*"
    const sent = fakeSession.addOrder.mock.calls[0][0];
    // 333.41 × 1.005 = 335.07705 → buy aligns UP to the 0.01 tick
    expect(sent.params).toEqual({ symbol: "AAPL-USD", side: "BUY", order_type: "LIMIT", order_time_in_force: "IOC", quantity: 1, price: 335.08, client_order_id: CID });
    expect(sent.immediate).toBe(true);
    expect(r).toMatchObject({ venue: "qfex", symbol: "AAPL", status: "filled", finality: "final", orderId: "o1", clientOrderId: CID, filledSize: "1", avgPrice: "333.46" });
    expect(r.execution).toMatchObject({ method: "protectedIoc", protectionPrice: "335.08", referencePrice: "333.41", tifSent: "IOC", slippageSource: "default" });
    expect(isIocOutcomeCapable(a) && a.iocOutcomeOf(r)).toEqual({ filledSize: "1", final: true });
  });

  it("a sell protection price aligns DOWN", async () => {
    fakeSession.addOrder.mockResolvedValue(added({ ended: "terminal", terminal: resp({ status: "FILLED", quantity_remaining: 0, side: "SELL" }), responses: [resp({ status: "FILLED", quantity_remaining: 0 })] }));
    await adapter().placeOrder(market({ side: "sell" }));
    expect(fakeSession.addOrder.mock.calls[0][0].params.price).toBe(331.74); // 333.41 × 0.995 = 331.74295
  });

  it.each(["IOC_CANCELLED", "CANCELLED"])("a zero-fill terminal %s → ORDER_REJECTED { reason: iocNoFill }", async status => {
    fakeSession.addOrder.mockResolvedValue(added({ ended: "terminal", terminal: resp({ status }), responses: [resp({}), resp({ status })] }));
    const e = await rejection(adapter().placeOrder(market()));
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.structured.details).toMatchObject({ reason: "iocNoFill", venueStatus: status, clientOrderId: CID });
  });

  it("a partial terminal (IOC_PARTIALLY_FILLED) is final partiallyFilled", async () => {
    fakeSession.addOrder.mockResolvedValue(added({
      ended: "terminal", terminal: resp({ status: "IOC_PARTIALLY_FILLED", quantity_remaining: 0.7 }),
      responses: [resp({}), resp({ status: "IOC_PARTIALLY_FILLED", quantity_remaining: 0.7 })],
      fills: [{ trade_id: "t1", symbol: "AAPL-USD", price: 333.4, quantity: 0.3, side: "BUY", order_id: "o1", client_order_id: CID, fee: 0 }],
    }));
    const r = await adapter().placeOrder(market());
    expect(r).toMatchObject({ status: "partiallyFilled", finality: "final", filledSize: "0.3", avgPrice: "333.4" });
  });

  it("fill frames that do not add up → filledSize from the order_response, avgPrice null, note", async () => {
    fakeSession.addOrder.mockResolvedValue(added({
      ended: "terminal", terminal: resp({ status: "FILLED", quantity_remaining: 0 }), responses: [resp({ status: "FILLED", quantity_remaining: 0 })],
      fills: [{ trade_id: "t1", symbol: "AAPL-USD", price: 333.4, quantity: 0.4, side: "BUY", order_id: "o1", client_order_id: CID, fee: 0 }],
    }));
    const r = await adapter().placeOrder(market());
    expect(r).toMatchObject({ status: "filled", filledSize: "1", avgPrice: null });
    expect(r.execution.notes.join(" ")).toMatch(/fill frames add up to 0.4/);
  });

  it("no terminal frame in time → pending (accepted, or partiallyFilled with the seen fill) and NOT an IOC outcome", async () => {
    const a = adapter();
    fakeSession.addOrder.mockResolvedValueOnce(added({ ended: "timeout" }));
    const acc = await a.placeOrder(market());
    expect(acc).toMatchObject({ status: "accepted", finality: "pending", filledSize: null });
    expect(a.iocOutcomeOf(acc)).toBeNull();
    fakeSession.addOrder.mockResolvedValueOnce(added({ ended: "timeout", responses: [resp({}), resp({ status: "FILLED", quantity_remaining: 0.7 })] }));
    const part = await a.placeOrder(market());
    expect(part).toMatchObject({ status: "partiallyFilled", finality: "pending", filledSize: "0.3" });
    expect(a.iocOutcomeOf(part)).toBeNull();
  });

  it("a stale mark (its own venue time) → PRICE_STALE, nothing sent", async () => {
    mark("333.41", 60_000);
    const e = await rejection(adapter().placeOrder(market()));
    expect(e.structured.code).toBe("PRICE_STALE");
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });

  it("no mark for the symbol → PRICE_STALE (index / last / mid are never substituted)", async () => {
    marketStats.mockResolvedValue({ marks: new Map(), openInterest: new Map(), volumeNotional: new Map(), frame: {} });
    expect((await rejection(adapter().placeOrder(market()))).structured.code).toBe("PRICE_STALE");
  });

  it("a protection price outside the price band is refused, never clamped", async () => {
    mark("349.9"); // × 1.005 = 351.65 > max_price 350.07
    const e = await rejection(adapter().placeOrder(market()));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(e.structured.details?.band).toEqual({ lower: "316.73283923", upper: "350.07313809" });
    expect(e.structured.remediation).toMatch(/--slippage-bps/);
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });

  it("an unknown outcome is looked up ONCE by the generated id; absent → ORDER_PENDING stands", async () => {
    const pending = new PerpError("ORDER_PENDING", "qfex add_order AAPL-USD: outcome unknown", { remediation: "Do NOT resubmit" });
    fakeSession.addOrder.mockRejectedValue(pending);
    fakeSession.getUserOrders.mockResolvedValue([]);
    routes["GET /user/historic-orders"] = () => reply(200, { count: 0, data: null });
    const e = await rejection(adapter().placeOrder(market()));
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(fakeSession.addOrder).toHaveBeenCalledTimes(1); // never re-sent
    expect(fakeSession.getUserOrders).toHaveBeenCalledTimes(1);
    expect(requests.find(r => r.url.pathname === "/user/historic-orders")!.url.searchParams.get("client_order_id")).toBe(CID);
  });

  it("an unknown outcome whose order is found in the history is reported from that row", async () => {
    fakeSession.addOrder.mockRejectedValue(new PerpError("ORDER_PENDING", "unknown", {}));
    fakeSession.getUserOrders.mockResolvedValue([]);
    routes["GET /user/historic-orders"] = () => reply(200, { count: 1, data: [{
      order_id: "o9", client_order_id: CID, symbol: "AAPL-USD", side: "BUY", type: "LIMIT", time_in_force: "IOC", price: 335.08, quantity: 1,
      filled_qty: 1, avg_price: 333.45, terminal_status: "FILLED", execution_state: "DONE", status_ts: "2026-10-04T00:00:00Z",
    }] });
    const r = await adapter().placeOrder(market());
    expect(r).toMatchObject({ status: "filled", finality: "final", orderId: "o9", filledSize: "1", avgPrice: "333.45" });
    expect(r.execution.notes.join(" ")).toMatch(/read back by the generated client order id/);
  });
});

// ── Limit orders ──

describe("limit orders", () => {
  it("GTC after the ACK is accepted / pending — never 'open' without a get_user_orders row", async () => {
    fakeSession.addOrder.mockResolvedValue(added({ ended: "resting", responses: [resp({ time_in_force: "GTC" })] }));
    const r = await adapter().placeOrder(order());
    expect(fakeSession.addOrder.mock.calls[0][0]).toMatchObject({ immediate: false, lotSize: "0.001" });
    expect(fakeSession.addOrder.mock.calls[0][0].params).toMatchObject({ order_type: "LIMIT", order_time_in_force: "GTC", price: 333.4 });
    expect(r).toMatchObject({ status: "accepted", finality: "pending", orderId: "o1", clientOrderId: CID });
    expect(marketStats).not.toHaveBeenCalled(); // a limit order needs no mark
  });

  it("getOrderStatus: 'open' comes from the get_user_orders row", async () => {
    fakeSession.getUserOrders.mockResolvedValue([resp({ time_in_force: "GTC" })]);
    const r = await adapter().getOrderStatus("AAPL", { kind: "clientOrderId", value: CID });
    expect(fakeSession.getUserOrders).toHaveBeenCalledWith("AAPL-USD");
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "o1", filledSize: "0" });
  });

  it("getOrderStatus: not open → the historic row decides; an unknown terminal_status stays pending; neither → ORDER_NOT_FOUND", async () => {
    fakeSession.getUserOrders.mockResolvedValue([]);
    const row = (terminal_status: string, filled_qty: number) => ({
      order_id: "o1", client_order_id: CID, symbol: "AAPL-USD", side: "BUY", type: "LIMIT", time_in_force: "GTC", price: 333.4, quantity: 1,
      filled_qty, avg_price: filled_qty > 0 ? 333.4 : null, terminal_status, execution_state: "x", status_ts: "2026-10-04T00:00:00Z",
    });
    const a = adapter();
    routes["GET /user/historic-orders"] = () => reply(200, { data: [row("CANCELLED", 0)] });
    expect(await a.getOrderStatus("AAPL", { kind: "orderId", value: "o1" })).toMatchObject({ status: "cancelled", finality: "final" });
    routes["GET /user/historic-orders"] = () => reply(200, { data: [row("FAILED_MARGIN_CHECK", 0)] });
    expect(await a.getOrderStatus("AAPL", { kind: "orderId", value: "o1" })).toMatchObject({ status: "rejected", finality: "final" });
    routes["GET /user/historic-orders"] = () => reply(200, { data: [row("CANCELLED", 0.25)] });
    expect(await a.getOrderStatus("AAPL", { kind: "orderId", value: "o1" })).toMatchObject({ status: "partiallyFilled", finality: "final", filledSize: "0.25" });
    routes["GET /user/historic-orders"] = () => reply(200, { data: [row("", 0)] });
    expect(await a.getOrderStatus("AAPL", { kind: "orderId", value: "o1" })).toMatchObject({ status: "accepted", finality: "pending" });
    routes["GET /user/historic-orders"] = () => reply(200, { data: [] });
    expect((await rejection(a.getOrderStatus("AAPL", { kind: "orderId", value: "o1" }))).structured.code).toBe("ORDER_NOT_FOUND");
  });

  it("ALO = order_type ALO + GTC; an ALO the venue cancels after the ACK is ORDER_REJECTED 'post-only order would cross'", async () => {
    // Live production 2026-10-05 (GOLD buy 4172.0 0.003 --tif ALO): ACK, then CANCELLED.
    fakeSession.addOrder.mockResolvedValue(added({
      ended: "terminal", terminal: resp({ status: "CANCELLED", type: "ALO", time_in_force: "GTC" }),
      responses: [resp({ type: "ALO", time_in_force: "GTC" }), resp({ status: "CANCELLED", type: "ALO", time_in_force: "GTC" })],
    }));
    const e = await rejection(adapter().placeOrder(order({ tif: "ALO" })));
    expect(fakeSession.addOrder.mock.calls[0][0].params).toMatchObject({ order_type: "ALO", order_time_in_force: "GTC" });
    expect(fakeSession.addOrder.mock.calls[0][0]).toMatchObject({ immediate: false, postOnly: true });
    expect(e.structured).toMatchObject({ code: "ORDER_REJECTED", retryable: false, details: { reason: "postOnlyWouldCross", venueStatus: "CANCELLED", orderId: "o1" } });
    expect(e.message).toMatch(/post-only order would cross/);
  });

  it("ALO that rests (no terminal frame) stays acknowledged; a GTC limit does not wait for a post-only verdict", async () => {
    fakeSession.addOrder.mockResolvedValue(added({ ended: "resting", responses: [resp({ type: "ALO", time_in_force: "GTC" })] }));
    expect(await adapter().placeOrder(order({ tif: "ALO" }))).toMatchObject({ status: "accepted", finality: "pending" });
    await adapter().placeOrder(order({ tif: "GTC" }));
    expect(fakeSession.addOrder.mock.calls.at(-1)?.[0]).toMatchObject({ immediate: false, postOnly: false });
  });

  it("a GTC limit the venue cancels (not post-only) is 'cancelled', not a rejection or a fill", async () => {
    fakeSession.addOrder.mockResolvedValue(added({ ended: "terminal", terminal: resp({ status: "CANCELLED", time_in_force: "GTC" }), responses: [resp({ status: "CANCELLED" })] }));
    expect(await adapter().placeOrder(order({ tif: "GTC" }))).toMatchObject({ status: "cancelled", finality: "final", filledSize: "0" });
  });

  it("FOK is sent as LIMIT FOK and treated as immediate", async () => {
    fakeSession.addOrder.mockResolvedValue(added({ ended: "terminal", terminal: resp({ status: "FILLED", quantity_remaining: 0 }), responses: [resp({ status: "FILLED", quantity_remaining: 0 })] }));
    await adapter().placeOrder(order({ tif: "FOK" }));
    expect(fakeSession.addOrder.mock.calls[0][0]).toMatchObject({ immediate: true });
    expect(fakeSession.addOrder.mock.calls[0][0].params.order_time_in_force).toBe("FOK");
  });

  it("an off-tick price is INVALID_TICK (never rounded); an out-of-band price INVALID_PARAMS with the band (never clamped)", async () => {
    const a = adapter();
    expect((await rejection(a.placeOrder(order({ price: "333.405" })))).structured.code).toBe("INVALID_TICK");
    const high = await rejection(a.placeOrder(order({ price: "360.00" })));
    expect(high.structured.code).toBe("INVALID_PARAMS");
    expect(high.structured.details).toMatchObject({ band: { lower: "316.73283923", upper: "350.07313809" }, price: "360" });
    const low = await rejection(a.placeOrder(order({ side: "sell", price: "300.00" })));
    expect(low.structured.code).toBe("INVALID_PARAMS");
    // a passive buy BELOW the band floor is not what the venue refuses
    fakeSession.addOrder.mockResolvedValue(added({}));
    await a.placeOrder(order({ price: "300.00" }));
    expect(fakeSession.addOrder).toHaveBeenCalledTimes(1);
  });

  it("size is floored to the lot (noted); below min_quantity → SIZE_TOO_SMALL; above max → SIZE_TOO_LARGE", async () => {
    const a = adapter();
    fakeSession.addOrder.mockResolvedValue(added({}));
    const r = await a.placeOrder(order({ size: "1.2349" }));
    expect(fakeSession.addOrder.mock.calls[0][0].params.quantity).toBe(1.234);
    expect(r.execution.notes.join(" ")).toMatch(/floored to the lot 0.001 → 1.234/);
    expect((await rejection(a.placeOrder(order({ size: "0.005" })))).structured.code).toBe("SIZE_TOO_SMALL");
    expect((await rejection(a.placeOrder(order({ size: "20000000" })))).structured.code).toBe("SIZE_TOO_LARGE");
  });

  it("a user-supplied (non-generated) client order id is refused; null is refused by the async-ack rule", async () => {
    const e = await rejection(adapter().placeOrder(order({ clientOrderId: "my-order-1" })));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(e.message).toMatch(/generated client order id/);
    expect((await rejection(adapter().placeOrder(order({ clientOrderId: null })))).structured.code).toBe("INVALID_PARAMS");
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });

  it("the legacy shims generate the client order id (UUID)", async () => {
    fakeSession.addOrder.mockResolvedValue(added({}));
    await adapter().limitOrder("AAPL", "buy", "333.4", "1", { tif: "GTC" });
    expect(fakeSession.addOrder.mock.calls[0][0].params.client_order_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("attached TP/SL is refused before anything is sent (capabilities.tpsl = separateOrders)", async () => {
    const e = await rejection(adapter().placeOrder(order({ tpsl: { tp: "350", sl: "320" } })));
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.structured.details).toMatchObject({ feature: "tpslAttached" });
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });
});

// ── Market eligibility (refdata) ──

describe("market eligibility from /refdata", () => {
  it("a non-USD quote market is refused with nonUsdQuote", async () => {
    const e = await rejection(adapter().placeOrder(order({ symbol: "SKHYNIX-KRW", price: "1841400", size: "0.001" })));
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.structured.details).toMatchObject({ venue: "qfex", feature: "nonUsdQuote" });
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });

  it("an INACTIVE / unknown market is SYMBOL_NOT_FOUND", async () => {
    const inactive = refdata.data.find(r => r.status !== "ACTIVE" && String(r.symbol).endsWith("-USD")) as { symbol: string; tick_size: string; min_price: string };
    const e = await rejection(adapter().placeOrder(order({ symbol: inactive.symbol, price: inactive.tick_size })));
    expect(e.structured.code).toBe("SYMBOL_NOT_FOUND");
    expect((await rejection(adapter().placeOrder(order({ symbol: "NOPE" })))).structured.code).toBe("SYMBOL_NOT_FOUND");
  });

  it("order types and TIFs are validated per symbol", async () => {
    const aapl = refdataBody.data.find(r => r.symbol === "AAPL-USD") as Record<string, unknown>;
    aapl.order_types = ["LIMIT", "MARKET"];
    aapl.order_time_in_force = ["GTC", "IOC"];
    const alo = await rejection(adapter().placeOrder(order({ tif: "ALO" })));
    expect(alo.structured.details).toMatchObject({ feature: "orderType" });
    const fok = await rejection(adapter().placeOrder(order({ tif: "FOK" })));
    expect(fok.structured.details).toMatchObject({ feature: "timeInForce" });
    expect(fakeSession.addOrder).not.toHaveBeenCalled();
  });

  it("order entry needs /refdata only — /md/contracts is never requested", async () => {
    fakeSession.addOrder.mockResolvedValue(added({}));
    await adapter().placeOrder(order());
    expect(requests.map(r => r.url.pathname)).toEqual(["/refdata"]);
  });
});

// ── Amend / cancel / leverage ──

describe("amend, cancel, leverage", () => {
  it("amend (Q5 passed): modify_order on the resting LIMIT, the NEW order id is reported with the SAME client id", async () => {
    const resting = resp({ order_id: "c563", time_in_force: "GTC", price: 333.4, reduce_only: false });
    fakeSession.getUserOrders.mockResolvedValueOnce([resting]).mockResolvedValueOnce([resp({ order_id: "8e4a", time_in_force: "GTC", price: 330, reduce_only: false })]);
    fakeSession.modifyOrder.mockResolvedValue(resp({ order_id: "8e4a", status: "MODIFIED", price: 330, time_in_force: "GTC" }));
    const r = await adapter().amendOrder({ symbol: "AAPL", ref: { kind: "clientOrderId", value: CID }, price: "330", size: "1", tif: null });
    expect(fakeSession.modifyOrder.mock.calls[0][0]).toMatchObject({ clientOrderId: CID, params: { order_id: "c563", symbol: "AAPL-USD", side: "BUY", order_type: "LIMIT", price: 330, quantity: 1, reduce_only: false } });
    expect(r).toMatchObject({ orderId: "8e4a", clientOrderId: CID, status: "open", finality: "final" });
    expect(r.execution.notes.join(" ")).toMatch(/replacedOrderId c563/);
    expect(qfexVenue.capabilities?.amend).toBe("native");
  });

  it("amend of a reduce-only order stays refused (production: a crossing modify while flat → INVALID_QUANTITY)", async () => {
    fakeSession.getUserOrders.mockResolvedValue([resp({ order_id: "r1", time_in_force: "GTC", reduce_only: true })]);
    const e = await rejection(adapter().amendOrder({ symbol: "AAPL", ref: { kind: "orderId", value: "r1" }, price: "330", size: "1", tif: null }));
    expect(e.structured.details).toMatchObject({ feature: "amend" });
    expect(fakeSession.modifyOrder).not.toHaveBeenCalled();
  });

  it("orphanedReduceOnlyOrders lists resting reduce-only and stop rows on a flat symbol only", async () => {
    routes["GET /user/positions"] = () => reply(200, { balance: {}, positions: [{ symbol: "CL-USD", position: 1, average_price: 90, leverage: 5, unrealised_pnl: 0 }] });
    fakeSession.getUserOrders.mockResolvedValue([
      resp({ order_id: "ro", side: "SELL", reduce_only: true, time_in_force: "GTC", price: 4300 }),
      resp({ order_id: "plain", reduce_only: false }),
      resp({ order_id: "stp", type: "STOP_LOSS", side: "SELL" }),
      resp({ order_id: "held", symbol: "CL-USD", reduce_only: true }),
    ]);
    const left = await adapter().orphanedReduceOnlyOrders(null);
    expect(left.map(o => o.orderId)).toEqual(["ro", "stp"]);
  });

  it("cancel by client id resolves THE order id first and cancels by order id", async () => {
    fakeSession.getUserOrders.mockResolvedValue([resp({ order_id: "o7", time_in_force: "GTC" })]);
    fakeSession.cancelOrder.mockResolvedValue({ kind: "cancelled", frame: resp({ status: "CANCELLED" }) });
    const r = await adapter().cancelByRef("AAPL", { kind: "clientOrderId", value: CID });
    expect(fakeSession.cancelOrder).toHaveBeenCalledWith("AAPL-USD", "o7");
    expect(r.cancelled).toEqual([{ kind: "clientOrderId", value: CID }]);
  });

  it("a client id shared by two open orders is ambiguous → refused; a stop row goes to cancel_stop_order; unknown → pending", async () => {
    const a = adapter();
    fakeSession.getUserOrders.mockResolvedValueOnce([resp({ order_id: "a" }), resp({ order_id: "b" })]);
    expect((await rejection(a.cancelByRef("AAPL", { kind: "clientOrderId", value: CID }))).structured.code).toBe("EXCHANGE_ERROR");
    // Unknown stop cancel, still listed on the re-list → pending.
    const s1 = resp({ order_id: "s1", type: "STOP_LOSS" });
    fakeSession.getUserOrders.mockResolvedValueOnce([s1]).mockResolvedValueOnce([s1]);
    fakeSession.cancelStopOrder.mockResolvedValue({ kind: "unknown", reason: "no cancel confirmation" });
    const r = await a.cancelByRef("AAPL", { kind: "orderId", value: "s1" });
    expect(fakeSession.cancelStopOrder).toHaveBeenCalledWith("AAPL-USD", "s1");
    expect(r.cancelled).toEqual([]);
    expect(r.pending).toHaveLength(1);
    expect(r.pending![0].reason).toMatch(/still listed open/);
    // Gone from the re-list, but stop orders have no historic record → still pending (unprovable).
    fakeSession.getUserOrders.mockResolvedValueOnce([s1]).mockResolvedValueOnce([]);
    routes["GET /user/historic-orders"] = () => reply(200, { count: 0, data: null });
    const gone = await a.cancelByRef("AAPL", { kind: "orderId", value: "s1" });
    expect(gone.cancelled).toEqual([]);
    expect(gone.pending![0].reason).toMatch(/cannot be proven/);
    fakeSession.getUserOrders.mockResolvedValueOnce([]);
    expect((await rejection(a.cancelByRef("AAPL", { kind: "orderId", value: "zz" }))).structured.code).toBe("ORDER_NOT_FOUND");
  });

  it("cancel-all reports only proven cancels; unproven ones are pending; leftover stops are cancelled one by one", async () => {
    const before = [resp({ order_id: "a", time_in_force: "GTC" }), resp({ order_id: "b", time_in_force: "GTC" }), resp({ order_id: "s", type: "TAKE_PROFIT" })];
    fakeSession.getUserOrders.mockResolvedValueOnce(before).mockResolvedValueOnce([before[1], before[2]]);
    fakeSession.cancelAll.mockResolvedValue({ cancelled: ["a"], frames: [], complete: false, note: "window ended" });
    fakeSession.cancelStopOrder.mockResolvedValue({ kind: "cancelled", frame: resp({ status: "CANCELLED" }) });
    const r = await adapter().cancelAllV2("AAPL");
    expect(fakeSession.cancelAll).toHaveBeenCalledWith("AAPL-USD", new Set(["a", "b"]), new Set(["a", "b", "s"]));
    expect(r.cancelled.map(c => c.value).sort()).toEqual(["a", "s"]);
    expect(r.pending!.map(p => p.ref?.value)).toEqual(["b"]);
    expect(r.pending![0].reason).toMatch(/still listed open/);
  });

  it("live 2026-10-12: a stop that vanished after cancel_all with its CANCELLED frame watched is cancelled, not pending", async () => {
    const before = [resp({ order_id: "tp", type: "TAKE_PROFIT" }), resp({ order_id: "sl", type: "STOP_LOSS" })];
    fakeSession.getUserOrders.mockResolvedValueOnce(before).mockResolvedValueOnce([before[1]]);
    fakeSession.cancelAll.mockResolvedValue({ cancelled: ["tp"], frames: [], complete: true, note: null });
    fakeSession.cancelStopOrder.mockResolvedValue({ kind: "cancelled", frame: resp({ order_id: "sl", status: "CANCELLED" }) });
    const r = await adapter().cancelAllV2(null);
    expect(r.cancelled.map(c => c.value).sort()).toEqual(["sl", "tp"]);
    expect(r.pending).toEqual([]);
  });

  it("an order gone without a frame is settled from /user/historic-orders (cancelled → cancelled; filled → failed)", async () => {
    const before = [resp({ order_id: "x", time_in_force: "GTC" }), resp({ order_id: "y", time_in_force: "GTC" })];
    fakeSession.getUserOrders.mockResolvedValueOnce(before).mockResolvedValueOnce([]);
    fakeSession.cancelAll.mockResolvedValue({ cancelled: [], frames: [], complete: false, note: "window ended" });
    const row = (order_id: string, terminal_status: string, filled_qty: number) => ({ order_id, client_order_id: CID, symbol: "AAPL-USD", side: "BUY", type: "LIMIT", time_in_force: "GTC", price: 333.4, quantity: 1, filled_qty, avg_price: null, terminal_status, execution_state: "", status_ts: "" });
    routes["GET /user/historic-orders"] = () => reply(200, { data: [row("x", "CANCELLED", 0), row("y", "FILLED", 1)] });
    const r = await adapter().cancelAllV2("AAPL");
    expect(r.cancelled.map(c => c.value)).toEqual(["x"]);
    expect(r.failed.map(f => f.ref?.value)).toEqual(["y"]);
  });

  it("leverage: cross only, REST POST /user/leverage, bounded by the market maximum", async () => {
    routes["POST /user/leverage"] = () => reply(200, { leverage: 5 });
    const a = adapter();
    expect(await a.applyLeverage("AAPL", 5, null)).toMatchObject({ venue: "qfex", symbol: "AAPL", leverage: 5, marginMode: "cross" });
    const post = requests.find(r => r.method === "POST")!;
    expect(post.body).toEqual({ symbol: "AAPL-USD", leverage: 5 });
    expect(post.headers["x-qfex-requested-account-id"]).toBe(ACCOUNT);
    expect((await rejection(a.applyLeverage("AAPL", 5, "isolated"))).structured.details).toMatchObject({ feature: "isolatedMargin" });
    expect((await rejection(a.applyLeverage("AAPL", 50, null))).structured.code).toBe("INVALID_PARAMS");
  });
});

// ── Account reads + funding ──

describe("account reads and funding", () => {
  it("getMarkets reports fundingRate null (unverified, Q4) so funding bots see no rate", async () => {
    const { fetchQfexMarketStats } = await import("../../exchanges/qfex/ws-transport.js");
    expect(fetchQfexMarketStats).toBeDefined();
    const markets = await adapter({ readOnly: true, credentials: READ_ONLY_CREDENTIALS }).getMarkets();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.every(m => m.fundingRate === null)).toBe(true);
    expect(markets.find(m => m.symbol === "AAPL")).toMatchObject({ markPrice: "333.41", maxLeverage: 10, stepSize: "0.001" });
  });

  // Live 2026-10-05: `account positions` printed "entryPrice": "4142.099999999999" (the venue's
  // JSON number carried float noise for a 4142.1 entry).
  it("venue float noise is not re-serialized: 15 significant digits, real decimals untouched", async () => {
    expect(plainNumber(4142.099999999999, "p")).toBe("4142.1");
    expect(plainNumber(0.30000000000000004, "p")).toBe("0.3");
    expect(plainNumber(4142.1, "p")).toBe("4142.1");
    expect(plainNumber(4142.123456789, "p")).toBe("4142.123456789");
    expect(plainNumber(-1.25, "p")).toBe("-1.25");
    expect(plainNumber(330, "p")).toBe("330");
    routes["GET /user/positions"] = () => reply(200, {
      balance: { available_balance: 80.5, deposit: 100, net_funding: 0, order_margin: 2.5, position_margin: 17, realised_pnl: 0, unrealised_pnl: 0, builder_rewards: 0 },
      positions: [{ symbol: "AAPL-USD", position: 0.003, average_price: 4142.099999999999, leverage: 10, unrealised_pnl: 0.0030000000000000005 }],
    });
    expect(await adapter().getPositions()).toMatchObject([{ symbol: "AAPL", size: "0.003", entryPrice: "4142.1", unrealizedPnl: "0.003" }]);
  });

  it("balance: equity is the venue's own figure for the bound account; positions are signed", async () => {
    routes["GET /user/positions"] = () => reply(200, {
      balance: { available_balance: 80.5, deposit: 100, net_funding: 0, order_margin: 2.5, position_margin: 17, realised_pnl: 0, unrealised_pnl: -1.25, builder_rewards: 0 },
      positions: [
        { symbol: "AAPL-USD", position: -0.5, average_price: 330, leverage: 10, unrealised_pnl: -1.25 },
        { symbol: "CL-USD", position: 0, average_price: 0, leverage: 10, unrealised_pnl: 0 },
      ],
    });
    routes["GET /user/subaccounts/equity"] = () => reply(200, { accounts: [{ account_id: "22222222-2222-4222-8222-222222222222", equity: 5, is_master: false }, { account_id: ACCOUNT, equity: 98.75, is_master: true }] });
    const a = adapter();
    expect(await a.getBalance()).toEqual({ equity: "98.75", available: "80.5", marginUsed: "19.5", unrealizedPnl: "-1.25" });
    const pos = await a.getPositions();
    expect(pos).toEqual([{ symbol: "AAPL", side: "short", size: "0.5", entryPrice: "330", markPrice: "333.41", liquidationPrice: null, unrealizedPnl: "-1.25", leverage: 10 }]);
  });

  it("orderbook drops the venue's empty (quantity 0) levels; recent trades / funding payments are uniform unsupported", async () => {
    routes["GET /md/orderbook/AAPL-USD"] = () => reply(200, { ticker_id: "AAPL-USD", bids: [["333.37", "304.348"], ["333.36", "0"]], asks: [["333.47", "312.5"], ["333.48", "0"]] });
    const a = adapter({ readOnly: true, credentials: READ_ONLY_CREDENTIALS });
    expect(await a.getOrderbook("AAPL")).toEqual({ bids: [["333.37", "304.348"]], asks: [["333.47", "312.5"]] });
    expect((await rejection(a.getRecentTrades())).structured.details).toMatchObject({ feature: "recentTrades" });
    expect((await rejection(a.getFundingPayments())).structured.details).toMatchObject({ feature: "fundingPayments" });
  });

  it("funding history never uses exponent notation and skips windows without a rate", async () => {
    routes["GET /funding/AAPL-USD"] = () => reply(200, { data: [
      { symbol: "AAPL-USD", intervalMinutes: 60, windowStart: "2026-10-02T01:00:00Z", rate: 1e-7 },
      { symbol: "AAPL-USD", intervalMinutes: 60, windowStart: "2026-10-02T00:00:00Z", rate: 0.00000149 },
      { symbol: "AAPL-USD", intervalMinutes: 60, windowStart: "2026-10-02T02:00:00Z", rate: null },
    ] });
    const h = await adapter({ readOnly: true, credentials: READ_ONLY_CREDENTIALS }).getFundingHistory("AAPL", 3);
    expect(h).toEqual([
      { time: Date.parse("2026-10-02T00:00:00Z"), rate: "0.00000149", price: null, intervalHours: 1, rateKind: "lastSettled", marketClosed: false },
      { time: Date.parse("2026-10-02T01:00:00Z"), rate: "0.0000001", price: null, intervalHours: 1, rateKind: "lastSettled", marketClosed: false },
    ]);
  });
});

// ── Funds: withdraw gate inside withdraw() ──

describe("withdraw gate (enforced inside QfexAdapter.withdraw)", () => {
  const GATE: WithdrawGate = { allowlist: [DEST], maxPerTx: 100, maxPerDay: 150 };
  const gated = (gate: WithdrawGate | null, m: QfexAgentMeta = meta()): QfexAdapter => {
    const a = adapter({}, m);
    a.withdrawGate = gate;
    return a;
  };
  const posted = () => requests.filter(r => r.method === "POST");

  it("absent gate → POLICY_DENIED before anything is sent", async () => {
    const e = await rejection(gated(null).withdraw("10", DEST));
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.message).toMatch(/settings.withdraw.qfex is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("destination not on the allowlist / above maxPerTx → POLICY_DENIED, nothing sent", async () => {
    const other = "0x0123456789abcdef0123456789abcdef01234567";
    expect((await rejection(gated(GATE).withdraw("10", other))).message).toMatch(/not on the allowlist/);
    expect((await rejection(gated(GATE).withdraw("100.01", DEST))).message).toMatch(/exceeds maxPerTx 100/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allowed → POST banker /withdraw { amount, address, network ARBITRUM_ONE } with no account header; counted against the day", async () => {
    routes["POST /withdraw"] = () => reply(200, null); // 200 with an empty body
    const a = gated(GATE);
    const r = await a.withdraw("100", DEST.toUpperCase().replace("0X", "0x"));
    expect(r).toMatchObject({ accepted: true, amount: "100", network: "ARBITRUM_ONE", asset: "USDC", fee: null });
    const post = posted()[0];
    expect(post.url.origin).toBe("https://banker.qfex.com");
    expect(post.body).toMatchObject({ amount: 100, network: "ARBITRUM_ONE" });
    expect(post.headers["x-qfex-requested-account-id"]).toBeUndefined();
    // maxPerDay: 100 already attempted today + 60 > 150
    const e = await rejection(a.withdraw("60", DEST));
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.message).toMatch(/exceeds maxPerDay 150/);
    expect(posted()).toHaveLength(1);
    await a.withdraw("50", DEST); // exactly up to the limit
    expect(posted()).toHaveLength(2);
  });

  it("a definite venue refusal (400 / 401 / 403) does not count against the day; an unknown outcome does", async () => {
    const a = gated(GATE);
    routes["POST /withdraw"] = () => reply(400, { title: "Bad Request", detail: "insufficient withdrawable balance" });
    expect((await rejection(a.withdraw("100", DEST))).structured.code).toBe("INSUFFICIENT_BALANCE");
    routes["POST /withdraw"] = () => reply(401, { title: "Unauthorized", detail: "terms not accepted" });
    expect((await rejection(a.withdraw("100", DEST))).structured.code).toBe("POLICY_DENIED");
    routes["POST /withdraw"] = () => reply(403, { title: "Forbidden", detail: "2FA required" });
    expect((await rejection(a.withdraw("100", DEST))).structured.code).toBe("POLICY_DENIED");
    // unknown outcome: the request may have been applied → ORDER_PENDING, kept in the ledger
    routes["POST /withdraw"] = () => { throw new TypeError("fetch failed"); };
    const unknown = await rejection(a.withdraw("100", DEST));
    expect(unknown.structured.code).toBe("ORDER_PENDING");
    expect(unknown.structured.remediation).toMatch(/not idempotent/);
    routes["POST /withdraw"] = () => reply(200, null);
    expect((await rejection(a.withdraw("100", DEST))).message).toMatch(/exceeds maxPerDay/);
  });

  it("a 5xx is an unknown outcome too", async () => {
    routes["POST /withdraw"] = () => reply(502, { title: "Bad Gateway" });
    expect((await rejection(gated(GATE).withdraw("10", DEST))).structured.code).toBe("ORDER_PENDING");
  });

  it("bad address / amount and a subaccount-bound key are refused before the gate", async () => {
    expect((await rejection(gated(GATE).withdraw("10", "TXYZ"))).structured.code).toBe("INVALID_PARAMS");
    expect((await rejection(gated(GATE).withdraw("-1", DEST))).structured.code).toBe("INVALID_PARAMS");
    expect((await rejection(gated(GATE).withdraw("1.1234567", DEST))).structured.code).toBe("INVALID_PARAMS");
    const sub = await rejection(gated(GATE, meta({ isPrimaryAccount: false })).withdraw("10", DEST));
    expect(sub.message).toMatch(/primary account/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("changing the gate needs an interactive terminal: --json and non-TTY (MCP, jobs, pipes) are refused", async () => {
    const tty = process.stdin.isTTY;
    try {
      (process.stdin as { isTTY?: boolean }).isTTY = false;
      expect((await rejection(confirmWithdrawGateChange("qfex", GATE, false))).structured.code).toBe("POLICY_DENIED");
      (process.stdin as { isTTY?: boolean }).isTTY = true;
      expect((await rejection(confirmWithdrawGateChange("qfex", GATE, true))).structured.code).toBe("POLICY_DENIED");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = tty;
    }
  });
});

describe("deposit address", () => {
  it("is shown only when the venue confirms ARBITRUM_ONE + USDC", async () => {
    const a = adapter();
    routes["GET /address"] = () => reply(200, { address: DEST, network: "ARBITRUM_ONE", asset: "USDC" });
    expect(await a.depositAddress()).toEqual({ address: DEST, network: "ARBITRUM_ONE", asset: "USDC" });
    expect(requests.find(r => r.url.pathname === "/address")!.url.searchParams.get("network")).toBe("ARBITRUM_ONE");
    routes["GET /address"] = () => reply(200, { address: "TXYZ", network: "TRON", asset: "USDT" });
    const e = await rejection(a.depositAddress());
    expect(e.structured.code).toBe("EXCHANGE_ERROR");
    expect(e.message).not.toContain("TXYZ");
  });
});

describe("subaccount transfer", () => {
  it("POST /user/transfer with src/dst in the query and the amount as a number; same account refused", async () => {
    routes["POST /user/transfer"] = () => reply(204, null);
    const sub = "22222222-2222-4222-8222-222222222222";
    await adapter().transferBetweenAccounts("12.5", sub, ACCOUNT);
    const post = requests.find(r => r.method === "POST")!;
    expect(post.url.searchParams.get("src_account_id")).toBe(sub);
    expect(post.url.searchParams.get("dst_account_id")).toBe(ACCOUNT);
    expect(post.body).toEqual({ amount: 12.5 });
    expect((await rejection(adapter().transferBetweenAccounts("1", ACCOUNT, ACCOUNT))).structured.code).toBe("INVALID_PARAMS");
  });
});
