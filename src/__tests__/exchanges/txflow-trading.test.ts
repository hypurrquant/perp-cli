/**
 * TxFlow adapter: account reads (recorded testnet /info answers, anonymized —
 * fixtures/txflow/account-reads-testnet.json) and the trading paths against a mocked venue:
 * action building per order type, outcome classes (executed + resting / filled / partial /
 * rejected / unknown / executed-but-not-visible), cancel proof, amend, leverage, the hedge-mode
 * and whitelist refusals, and that nothing is sent when a refusal is local. The agent key is a
 * throwaway generated per run; no request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The client-side token bucket is not under test here (it only paces the mocked requests).
vi.mock("../../exchanges/rate-limiter.js", async orig => ({ ...await orig<typeof import("../../exchanges/rate-limiter.js")>(), acquireRate: async () => {} }));
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet, TypedDataEncoder, recoverAddress, Signature } from "ethers";
import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenue } from "../../exchanges/venue.js";
import { TxflowAdapter, txflowHistoryStatus } from "../../exchanges/txflow/adapter.js";
import { txflowConnectionId, txflowDomain, TXFLOW_AGENT_TYPES, type TxflowAgentAction } from "../../exchanges/txflow/signing.js";
import { LocalEvmSigner } from "../../signer/evm-local.js";
import type { OrderRequest } from "../../exchanges/venue-types.js";

const FIX = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/txflow/account-reads-testnet.json"), "utf8")) as {
  reads: Record<string, { httpStatus: number; body: Record<string, unknown> }>;
};
const ACCOUNT = "0x000000000000000000000000000000000000dEaD";
type Body = Record<string, unknown> & { type?: string };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const recorded = (k: string) => json(FIX.reads[k].httpStatus, FIX.reads[k].body);
const ok = (data: unknown) => json(200, { success: true, code: 0, data });
const executed = (type = "PlaceOrder") => json(200, { status: "ok", code: 0, data: { type, data: { statuses: ["success"] } } });

interface Venue {
  /** /info answers by request type (defaults: the recorded fixture). */
  info: Partial<Record<string, (b: Body) => Response>>;
  /** /exchange answer; default: executed. */
  exchange: (b: { action: TxflowAgentAction; nonce: number; signature: { r: string; s: string; v: number } }) => Response;
  sent: Array<{ action: TxflowAgentAction; nonce: number; signature: { r: string; s: string; v: number }; confirm: unknown }>;
  infos: Body[];
}

let venue: Venue;
let agent: LocalEvmSigner;
let agentAddress: string;

beforeEach(async () => {
  const w = Wallet.createRandom();
  agent = await LocalEvmSigner.create(w.privateKey);
  agentAddress = w.address;
  venue = {
    info: {},
    exchange: () => executed(),
    sent: [],
    infos: [],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    if (url.endsWith("/exchange")) {
      venue.sent.push(body as unknown as Venue["sent"][number]);
      return venue.exchange(body as unknown as Parameters<Venue["exchange"]>[0]);
    }
    venue.infos.push(body);
    const t = String(body.type);
    const custom = venue.info[t];
    if (custom) return custom(body);
    switch (t) {
      case "perpMeta": return recorded("perpMeta");
      case "clearinghouseState": return recorded("clearinghouseState.position");
      case "frontendOpenOrders": return recorded("frontendOpenOrders");
      case "triggerOrders": return recorded("triggerOrders.empty");
      case "historicalOrders": return recorded("historicalOrders");
      case "userFills": return recorded("userFills");
      case "userFundings": return recorded("userFundings");
      case "orderDetails": return recorded("orderDetails.notFound");
      case "activeAssetCtx": return recorded("activeAssetCtx");
      case "activeAssetData": return recorded("activeAssetData");
      case "historicalTriggerOrders": return ok({ data: [], hasMore: false, total: 0 });
      default: throw new Error(`unexpected /info ${t}`);
    }
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function adapter(net: "mainnet" | "testnet" = "testnet", signer: LocalEvmSigner | null = agent): TxflowAdapter {
  return new TxflowAdapter(getVenue("txflow"), net, {
    account: ACCOUNT, signer, meta: null,
    noSignerReason: signer === null ? new PerpError("AGENT_NOT_REGISTERED", "No TxFlow agent is registered on this computer", { exchange: "txflow" }) : null,
    sleep: async () => {},
  });
}

const slip = { bps: 50, source: "flag" as const };
function req(over: Partial<OrderRequest>): OrderRequest {
  return {
    symbol: "BTC", side: "buy", type: "limit", size: "0.01", price: "70000", triggerPrice: null, triggerSource: null, tif: "GTC",
    reduceOnly: false, clientOrderId: "cli-test-1", slippage: null, tpsl: null, ...over,
  };
}

/** A recorded open-order row re-keyed to the order that was just sent. */
function openRowFor(cloid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = (FIX.reads.frontendOpenOrders.body.data as Array<Record<string, unknown>>)[0];
  return { ...base, asset: 1, coin: "BTC-USDC", cloid, oid: 4242, origSz: "0.01", sz: "0.01", state: "Open", ...over };
}
function historyRowFor(cloid: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = ((FIX.reads.historicalOrders.body.data as { data: Array<Record<string, unknown>> }).data)[0];
  return { ...base, status, order: { ...(base.order as object), instrumentId: 1, coin: "BTC", cloid, oid: 4243, origSz: "0.01", sz: "0.0000", avgFillPrice: "79600.1", ...over } };
}

describe("account reads (recorded testnet answers)", () => {
  it("balance: equity / withdrawable / margin used; unrealized PnL = Σ positions (exact)", async () => {
    const b = await adapter().getBalance();
    const d = FIX.reads["clearinghouseState.position"].body.data as { marginSummary: Record<string, string>; withdrawable: string };
    expect(Number(b.equity)).toBe(Number(d.marginSummary.accountValue));
    expect(Number(b.available)).toBe(Number(d.withdrawable));
    expect(Number(b.marginUsed)).toBe(Number(d.marginSummary.totalMarginUsed));
    expect(b.unrealizedPnl).toBe("0.166883"); // 0.070512 + 0.103297 − 0.006926
    expect(venue.infos[0]).toMatchObject({ type: "clearinghouseState", user: ACCOUNT, accountType: "perp" });
  });

  it("positions: side from szi, symbol from the asset id, null liquidation kept null, margin mode from leverage.type", async () => {
    const ps = await adapter().getPositions();
    expect(ps.map(p => [p.symbol, p.side, p.size, p.liquidationPrice, p.marginMode, p.leverage])).toEqual([
      ["BZ", "long", "1", null, "cross", 10],
      ["BTC", "short", "0.0052", "10120233.5", "cross", 10],
      ["ETH", "short", "0.031", "1684860.34", "cross", 10],
    ]);
  });

  it("open orders: spot rows dropped; filled = origSz − sz (filledAmount is QUOTE notional)", async () => {
    const os = await adapter().getOpenOrders();
    expect(os.map(o => [o.symbol, o.status, o.size, o.filled])).toEqual([
      ["BZ", "open", "734.71", "0"],
      ["BTC", "partiallyFilled", "3.3933", "0.0277"],
    ]);
  });

  it("order history (accountType perp): venue status verbatim, filled from sizes", async () => {
    const hs = await adapter().getOrderHistory(10);
    expect(venue.infos.find(b => b.type === "historicalOrders")).toMatchObject({ accountType: ["perp"], limit: 10 });
    expect(hs.slice(0, 3).map(o => [o.symbol, o.status, o.filled])).toEqual([
      ["ETH", "filled", "0.008"], ["ETH", "partialFilled", "37.589"], ["SOL", "partialCanceled", "0.19"],
    ]);
    await expect(adapter().getOrderHistory(2001)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("fills and funding payments (amount > 0 = received)", async () => {
    const fills = await adapter().getTradeHistory(2);
    expect(fills.map(f => [f.symbol, f.side, f.price, f.size])).toEqual([["XAUT", "buy", "3998.8", "0.009"], ["SUI", "sell", "0.9064", "60"]]);
    const pays = await adapter().getFundingPayments(2);
    expect(pays.map(p => [p.symbol, p.payment.startsWith("-")])).toEqual([["BZ", true], ["AERO", false]]);
  });

  it("history status vocabulary (live): filled / partialFilled / partialCanceled / canceled; unknown → EXCHANGE_ERROR", () => {
    expect(txflowHistoryStatus("filled", "1")).toBe("filled");
    expect(txflowHistoryStatus("partialFilled", "1")).toBe("partiallyFilled");
    expect(txflowHistoryStatus("partialCanceled", "1")).toBe("partiallyFilled");
    expect(txflowHistoryStatus("canceled", "0")).toBe("cancelled");
    expect(() => txflowHistoryStatus("weird", "0")).toThrow(/order status/);
  });

  it("no account → NO_SIGNER_AVAILABLE before any request", async () => {
    const a = new TxflowAdapter(getVenue("txflow"), "testnet");
    await expect(a.getPositions()).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    expect(venue.infos).toEqual([]);
  });
});

/** The signed action of the n-th /exchange call, with its signature checked to recover the agent. */
async function sentAction(n = 0, net: "mainnet" | "testnet" = "testnet"): Promise<TxflowAgentAction> {
  const s = venue.sent[n];
  expect(s.confirm).toBe("executed");
  const action = { ...s.action } as TxflowAgentAction;
  const connectionId = await txflowConnectionId(action, s.nonce);
  const sigNet = net === "testnet" ? { txflowNetwork: "TxFlow-Testnet", chainId: 2511 } : { txflowNetwork: "TxFlow-Mainnet", chainId: 869 };
  const digest = TypedDataEncoder.hash(txflowDomain(net), TXFLOW_AGENT_TYPES, { ...sigNet, apiVersion: 1, connectionId });
  expect(recoverAddress(digest, Signature.from(s.signature))).toBe(agentAddress);
  return action;
}

describe("placeOrder — action building per order type", () => {
  it("market buy: IOC at mark × (1 + bps) ceiled to the tick, grouping na, client id attached", async () => {
    venue.info.historicalOrders = b => ok({ data: [historyRowFor("cli-test-1", "filled")], hasMore: false, total: 1 });
    venue.info.frontendOpenOrders = () => ok([]);
    const r = await adapter().placeOrder(req({ type: "market", price: null, tif: null, slippage: slip }));
    const a = await sentAction();
    expect(a).toEqual({
      type: "order", grouping: "na",
      orders: [{ a: 1, b: true, p: "80022.4", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: "cli-test-1" }],
    });
    // mark 79624.2 (recorded activeAssetCtx) × 1.005 = 80022.321 → ceil to the 0.1 tick
    expect(r).toMatchObject({ status: "filled", finality: "final", orderId: "4243", clientOrderId: "cli-test-1", filledSize: "0.01", avgPrice: "79600.1" });
    expect(r.execution).toMatchObject({ method: "protectedIoc", slippageBps: 50, protectionPrice: "80022.4", tifSent: "Ioc" });
  });

  it("limit ALO resting: read back from open orders → open, final, venue order id", async () => {
    venue.info.frontendOpenOrders = () => ok([openRowFor("cli-test-1", { tif: "ALO" })]);
    const r = await adapter().placeOrder(req({ tif: "ALO", side: "sell", reduceOnly: true }));
    const a = await sentAction();
    expect((a as { orders: unknown[] }).orders[0]).toEqual({ a: 1, b: false, p: "70000", s: "0.01", r: true, t: { limit: { tif: "Alo" } }, c: "cli-test-1" });
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "4242", filledSize: "0" });
  });

  it("IOC partial fill (partialCanceled): partiallyFilled with the filled size, final", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.historicalOrders = () => ok({ data: [historyRowFor("cli-test-1", "partialCanceled", { sz: "0.0040" })], hasMore: false });
    const r = await adapter().placeOrder(req({ tif: "IOC" }));
    expect(r).toMatchObject({ status: "partiallyFilled", finality: "final", filledSize: "0.006" });
  });

  it("canceled with no fill → cancelled, filledSize 0", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.historicalOrders = () => ok({ data: [historyRowFor("cli-test-1", "canceled", { sz: "0.01" })], hasMore: false });
    expect(await adapter().placeOrder(req({ tif: "IOC" }))).toMatchObject({ status: "cancelled", filledSize: "0" });
  });

  it("executed but not visible on any read yet → accepted / pending (never a guessed fill)", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.historicalOrders = () => ok({ data: [], hasMore: false });
    const r = await adapter().placeOrder(req({}));
    expect(r).toMatchObject({ status: "accepted", finality: "pending", orderId: null, clientOrderId: "cli-test-1", filledSize: null });
  });

  it("stop-market sell below the mark: normalTrigger, tpsl sl, isMarket, p = trigger, reduce-only", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.triggerOrders = () => ok([{ asset: "1", coin: "1", oid: 77, cloid: "cli-test-1", side: "A", sz: "0.01", limitPx: "60000", triggerPx: "60000", triggerState: "", orderType: "Stop", reduceOnly: true, createTime: 1 }]);
    const r = await adapter().placeOrder(req({ type: "stopMarket", side: "sell", price: null, tif: null, triggerPrice: "60000", reduceOnly: true, slippage: slip }));
    const a = await sentAction();
    expect(a).toEqual({
      type: "order", grouping: "normalTrigger",
      orders: [{ a: 1, b: false, p: "60000", s: "0.01", r: true, t: { trigger: { isMarket: true, triggerPx: "60000", tpsl: "sl" } }, c: "cli-test-1" }],
    });
    expect(r).toMatchObject({ status: "open", orderId: "77" });
    expect(r.execution.notes.join(" ")).toMatch(/sent as sl: trigger 60000 is below the mark/);
  });

  it("TP leg (placeTpSlLeg): the given kind is sent; stop-limit carries its limit price", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.historicalOrders = () => ok({ data: [], hasMore: false });
    await adapter().placeTpSlLeg({ symbol: "BTC", closeSide: "sell", size: "0.01", trigger: "90000", kind: "tp", limitPrice: "89990", slippage: slip });
    const o = ((await sentAction()) as unknown as { orders: Array<Record<string, unknown>> }).orders[0];
    expect(o).toMatchObject({ b: false, p: "89990", r: true, t: { trigger: { isMarket: false, triggerPx: "90000", tpsl: "tp" } } });
  });
});

describe("placeOrder — refusals and outcomes", () => {
  it("venue rejection → ORDER_REJECTED (sent:false), nothing read back", async () => {
    venue.exchange = () => json(200, { status: "err", code: 10000, message: "Price precision does not match the tick size: 0.1" });
    await expect(adapter().placeOrder(req({}))).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED", details: { sent: false } } });
    expect(venue.infos.some(b => b.type === "frontendOpenOrders")).toBe(false);
  });

  it("mainnet whitelist refusal → POLICY_DENIED with the apply link", async () => {
    venue.exchange = () => json(403, { status: "err", code: 10000, response: "This action is not allowed." });
    const e = await adapter("mainnet").placeOrder(req({})).catch(x => x) as PerpError;
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.structured.remediation).toMatch(/txflow\.com\/apply/);
  });

  it("unknown outcome, found by client id on reconciliation → the read result, noted reconciled", async () => {
    venue.exchange = () => json(502, "<html>bad gateway</html>");
    venue.info.frontendOpenOrders = () => ok([openRowFor("cli-test-1")]);
    const r = await adapter().placeOrder(req({}));
    expect(r.status).toBe("open");
    expect(r.execution.notes).toContain("reconciled");
  });

  it("unknown outcome, not found → ORDER_PENDING (do NOT resubmit)", async () => {
    venue.exchange = () => json(202, { status: "pending", txHash: "0xabc" });
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.historicalOrders = () => ok({ data: [], hasMore: false });
    const e = await adapter().placeOrder(req({})).catch(x => x) as PerpError;
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.remediation).toMatch(/Do NOT resubmit/);
    expect(venue.sent).toHaveLength(1);
  });

  it("local refusals send nothing: off-tick price, off-lot size, hedge mode, no agent, halted, 0x client id", async () => {
    await expect(adapter().placeOrder(req({ price: "70000.05" }))).rejects.toMatchObject({ structured: { code: "INVALID_TICK" } });
    await expect(adapter().placeOrder(req({ size: "0.00001" }))).rejects.toMatchObject({ structured: { code: "INVALID_TICK" } });
    venue.info.activeAssetData = () => ok({ user: ACCOUNT, coin: "1", leverage: { mode: "hedge", type: "Cross", long_value: 5, short_value: 5 }, maxTradeSzs: [], availableToTrade: [], markPx: "0", onlyIsolated: false });
    await expect(adapter().placeOrder(req({}))).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { feature: "hedgeMode" } } });
    await expect(adapter("testnet", null).placeOrder(req({}))).rejects.toMatchObject({ structured: { code: "AGENT_NOT_REGISTERED" } });
    await expect(adapter().placeOrder(req({ clientOrderId: "0xdeadbeef" }))).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    await expect(adapter().placeOrder(req({ tif: "FOK" }))).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(venue.sent).toEqual([]);
  });
});

describe("cancel / amend / leverage", () => {
  const openBtc = { ...openRowFor("c-9"), oid: 555 };

  it("cancel by id: {a, o}; reported cancelled only once the order is gone from the open list", async () => {
    let gone = false;
    venue.exchange = () => { gone = true; return executed("CancelOrder"); };
    venue.info.frontendOpenOrders = () => ok(gone ? [] : [openBtc]);
    const r = await adapter().cancelByRef("BTC", { kind: "orderId", value: "555" });
    expect(await sentAction()).toEqual({ type: "cancel", cancels: [{ a: 1, o: 555 }] });
    expect(r).toMatchObject({ cancelled: [{ kind: "orderId", value: "555" }], failed: [], pending: [] });
  });

  it("an executed cancel whose order is still listed → pending, never cancelled", async () => {
    venue.exchange = () => executed("CancelOrder");
    venue.info.frontendOpenOrders = () => ok([openBtc]);
    const r = await adapter().cancelByRef("BTC", { kind: "clientOrderId", value: "c-9" });
    expect(r.cancelled).toEqual([]);
    expect(r.pending?.[0]?.ref).toEqual({ kind: "orderId", value: "555" });
  });

  it("a trigger order is cancelled with grouping trigger; an unknown cancel outcome is pending", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.triggerOrders = () => ok([{ asset: "1", coin: "1", oid: 88, cloid: "", side: "A", sz: "0.01", limitPx: "60000", triggerPx: "60000", triggerState: "", orderType: "Stop", reduceOnly: true, createTime: 1 }]);
    venue.exchange = () => json(504, "timeout");
    const r = await adapter().cancelByRef("BTC", { kind: "orderId", value: "88" });
    expect(await sentAction()).toEqual({ type: "cancel", cancels: [{ a: 1, o: 88, grouping: "trigger" }] });
    expect(r.cancelled).toEqual([]);
    expect(r.pending).toHaveLength(1);
  });

  it("cancel-all batches per market; a missing order → ORDER_NOT_FOUND without sending", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    await expect(adapter().cancelByRef("BTC", { kind: "orderId", value: "1" })).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
    expect(venue.sent).toEqual([]);
    const r = await adapter().cancelAllV2(null);
    expect(r).toMatchObject({ cancelled: [], failed: [], pending: [] });
    expect(venue.sent).toEqual([]);
  });

  it("amend: modify2 {o, p, s} on a resting order", async () => {
    venue.info.frontendOpenOrders = () => ok([openBtc]);
    await adapter().amendOrder({ symbol: "BTC", ref: { kind: "orderId", value: "555" }, price: "71000", size: "0.02", tif: null });
    expect(await sentAction()).toEqual({ type: "modify2", order: { o: 555, p: "71000", s: "0.02" } });
    await expect(adapter().amendOrder({ symbol: "BTC", ref: { kind: "orderId", value: "555" }, price: "71000", size: "0.02", tif: "ALO" }))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
  });

  it("leverage + margin mode: updateMarginMode then updateLeverage, proven by the activeAssetData read-back", async () => {
    let lev = { mode: "oneWay", type: "Cross", value: 10, raw_usd: null };
    venue.exchange = b => {
      if (b.action.type === "updateMarginMode") lev = { ...lev, type: (b.action as { isCross: boolean }).isCross ? "Cross" : "Isolated" };
      if (b.action.type === "updateLeverage") lev = { ...lev, value: (b.action as { leverage: number }).leverage };
      return executed();
    };
    venue.info.activeAssetData = () => ok({ user: ACCOUNT, coin: "1", leverage: lev, maxTradeSzs: [], availableToTrade: [], markPx: "0", onlyIsolated: false });
    const r = await adapter().applyLeverage("BTC", 5, "isolated");
    expect(await sentAction(0)).toEqual({ type: "updateMarginMode", asset: 1, isCross: false });
    expect(await sentAction(1)).toEqual({ type: "updateLeverage", asset: 1, leverage: 5, marginMode: "isolated" });
    expect(r).toMatchObject({ leverage: 5, marginMode: "isolated" });
  });

  it("leverage read-back mismatch → ORDER_PENDING; above the market max → INVALID_PARAMS, nothing sent", async () => {
    venue.exchange = () => executed();
    await expect(adapter().applyLeverage("BTC", 5, null)).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    venue.sent = [];
    await expect(adapter().applyLeverage("BTC", 51, null)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(venue.sent).toEqual([]);
  });
});

describe("order status reads", () => {
  it("by venue id: orderDetails; code 21001 → ORDER_NOT_FOUND", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    await expect(adapter().getOrderStatus("BTC", { kind: "orderId", value: "123" })).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
    venue.info.orderDetails = () => recorded("orderDetails.found");
    // The recorded order is an XAUT buy of 0.009, fully filled (anonymized id).
    const found = FIX.reads["orderDetails.found"].body.data as { orderDetails: { order: { oid: number } } };
    const r = await adapter().getOrderStatus("XAUT", { kind: "orderId", value: String(found.orderDetails.order.oid) });
    expect(r).toMatchObject({ status: "filled", finality: "final", filledSize: "0.009" });
    // orderDetails takes no user: an id of another market is not reported as this market's order.
    await expect(adapter().getOrderStatus("BTC", { kind: "orderId", value: String(found.orderDetails.order.oid) }))
      .rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
  });
});
