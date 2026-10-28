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
// These tests exercise the trading code with the release switch mocked on, whatever the shipped value.
vi.mock("../../exchanges/venues/txflow-release.js", () => ({ TXFLOW_TRADING_ENABLED: true }));
vi.mock("../../exchanges/rate-limiter.js", async orig => ({ ...await orig<typeof import("../../exchanges/rate-limiter.js")>(), acquireRate: async () => {} }));
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet, TypedDataEncoder, recoverAddress, Signature } from "ethers";
import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenue } from "../../exchanges/venue.js";
import { TxflowAdapter, txflowHistoryStatus, TXFLOW_CLOID_MATCH_SKEW_MS, TXFLOW_OPEN_ORDERS_MAX_PAGES, TXFLOW_OPEN_ORDERS_PAGE } from "../../exchanges/txflow/adapter.js";
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
const executed = (type = "PlaceOrder") => json(200, { status: "ok", code: 0, confirm: "executed", data: { type, data: { statuses: ["success"] } } });

interface Venue {
  /** /info answers by request type (defaults: the recorded fixture). */
  info: Partial<Record<string, (b: Body) => Response>>;
  /** /exchange answer; default: executed. */
  exchange: (b: { action: TxflowAgentAction; nonce: number; signature: { r: string; s: string; v: number } }) => Response;
  sent: Array<{ action: TxflowAgentAction; nonce: number; signature: { r: string; s: string; v: number }; confirm: unknown }>;
  infos: Body[];
  /** false (default): a frontendOpenOrders handler returns the WHOLE list and the mock serves it page by page. */
  rawPaging: boolean;
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
    rawPaging: false,
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
    if (t === "frontendOpenOrders" && !venue.rawPaging) {
      // Serve the handler's (or the fixture's) full list in pages, like the venue (limit / offset).
      const full = await (custom ? custom(body) : recorded("frontendOpenOrders")).json() as { data: unknown[] };
      const off = Number(body.offset ?? 0);
      const lim = Number(body.limit ?? full.data.length);
      return ok(full.data.slice(off, off + lim));
    }
    if (custom) return custom(body);
    switch (t) {
      case "perpMeta": return recorded("perpMeta");
      case "clearinghouseState": return recorded("clearinghouseState.position");
      case "frontendOpenOrders": return recorded("frontendOpenOrders");
      case "triggerOrders": return recorded("triggerOrders.empty");
      case "tpslOrders": return ok([]);
      case "historicalTpslOrders": return ok({ data: [], hasMore: false });
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
  return { ...base, asset: 1, coin: "BTC-USDC", cloid, oid: 4242, origSz: "0.01", sz: "0.01", state: "Open", timestamp: Date.now(), ...over };
}
function historyRowFor(cloid: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = ((FIX.reads.historicalOrders.body.data as { data: Array<Record<string, unknown>> }).data)[0];
  return { ...base, status, order: { ...(base.order as object), instrumentId: 1, coin: "BTC", cloid, oid: 4243, origSz: "0.01", sz: "0.0000", avgFillPrice: "79600.1", timestamp: Date.now(), ...over } };
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

/** A tpslOrders row (shape seen live 2026-10-28) for BTC: sl leg 501, tp leg 502. */
function tpslRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coin: "BTC-USDC", asset: "1", side: "A", slOrderPrice: "", tpOrderPrice: "89990", quantity: "0.010", slOid: "501", tpOid: "502",
    slTriggerPrice: "60000", tpTriggerPrice: "90000", slOrderType: "Market", tpOrderType: "Limit", positionMode: "OneWay", marginMode: "cross",
    leverage: 10, reduceOnly: true, createTime: Date.now(), cloid: "pair-1", ...over,
  };
}

describe("placeOrder — action building per order type", () => {
  it("market buy: IOC at mark × (1 + bps) ceiled to the tick, grouping na, client id attached", async () => {
    venue.info.historicalOrders = b => ok({ data: [historyRowFor("cli-test-1", "filled")], hasMore: false, total: 1 });
    venue.info.frontendOpenOrders = () => ok([]);
    const r = await adapter().placeOrder(req({ type: "market", price: null, tif: null, slippage: slip }));
    const a = await sentAction();
    expect(a).toEqual({
      type: "order", grouping: "na",
      orders: [{ a: 1, b: true, p: "80022.4", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: "cli-test-1", m: "cross" }],
    });
    // mark 79624.2 (recorded activeAssetCtx) × 1.005 = 80022.321 → ceil to the 0.1 tick
    expect(r).toMatchObject({ status: "filled", finality: "final", orderId: "4243", clientOrderId: "cli-test-1", filledSize: "0.01", avgPrice: "79600.1" });
    expect(r.execution).toMatchObject({ method: "protectedIoc", slippageBps: 50, protectionPrice: "80022.4", tifSent: "Ioc" });
  });

  it("limit ALO resting: read back from open orders → open, final, venue order id", async () => {
    venue.info.frontendOpenOrders = () => ok([openRowFor("cli-test-1", { tif: "ALO" })]);
    const r = await adapter().placeOrder(req({ tif: "ALO", side: "sell", reduceOnly: true }));
    const a = await sentAction();
    // Reduce-only: m is the margin mode of the BTC position it reduces (recorded: Cross).
    expect((a as { orders: unknown[] }).orders[0]).toEqual({ a: 1, b: false, p: "70000", s: "0.01", r: true, t: { limit: { tif: "Alo" } }, c: "cli-test-1", m: "cross" });
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

  it("stop-market sell: normalTrigger, tpsl \"\" (live: normalTrigger refuses tp / sl), isMarket, p = trigger − slippage, reduce-only", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.triggerOrders = () => ok([{ asset: "1", coin: "1", oid: 77, cloid: "cli-test-1", side: "A", sz: "0.01", limitPx: "59700", triggerPx: "60000", triggerState: "", orderType: "Stop", reduceOnly: true, createTime: Date.now() }]);
    const r = await adapter().placeOrder(req({ type: "stopMarket", side: "sell", price: null, tif: null, triggerPrice: "60000", reduceOnly: true, slippage: slip }));
    const a = await sentAction();
    expect(a).toEqual({
      type: "order", grouping: "normalTrigger",
      // p = 60000 × (1 − 50 bps) = 59700, aligned down (sell) to the 0.1 tick.
      orders: [{ a: 1, b: false, p: "59700", s: "0.01", r: true, t: { trigger: { isMarket: true, triggerPx: "60000", tpsl: "" } }, c: "cli-test-1", m: "cross" }],
    });
    expect(r).toMatchObject({ status: "open", orderId: "77" });
    // No mark read to classify the trigger as tp / sl any more.
    expect(venue.infos.some(b => b.type === "activeAssetCtx")).toBe(false);
  });

  it("position TP/SL pair: ONE positionTpsl action [sl, tp], market leg p \"\", read back from tpslOrders by client id → both leg ids", async () => {
    venue.info.tpslOrders = () => {
      const c = ((venue.sent[0]?.action as { orders?: Array<{ c: string }> } | undefined)?.orders?.[0]?.c) ?? "none";
      return ok(venue.sent.length === 0 ? [] : [tpslRow({ cloid: c })]);
    };
    const legs = await adapter().placeTpSlPair({ symbol: "BTC", closeSide: "sell", size: "0.01", tp: "90000", tpLimit: "89990", sl: "60000" });
    const a = await sentAction() as unknown as { grouping: string; orders: Array<Record<string, unknown>> };
    expect(a.grouping).toBe("positionTpsl");
    expect(venue.sent).toHaveLength(1);
    const c = a.orders[0].c;
    expect(a.orders).toEqual([
      { a: 1, b: false, p: "", s: "0.01", r: true, t: { trigger: { isMarket: true, triggerPx: "60000", tpsl: "sl" } }, c, m: "cross" },
      // No client id on the TP leg: the node refuses one id on both legs ("Duplicate client order ID", testnet).
      { a: 1, b: false, p: "89990", s: "0.01", r: true, t: { trigger: { isMarket: false, triggerPx: "90000", tpsl: "tp" } }, m: "cross" },
    ]);
    expect(Object.keys(a.orders[0])).toEqual(["a", "b", "p", "s", "r", "t", "c", "m"]);
    expect(Object.keys(a.orders[1])).toEqual(["a", "b", "p", "s", "r", "t", "m"]);
    expect(legs.map(l => [l.kind, l.trigger, l.result.orderId, l.result.status, l.result.execution.method])).toEqual([
      ["sl", "60000", "501", "open", "positionTpsl"], ["tp", "90000", "502", "open", "positionTpsl"],
    ]);
  });

  it("position TP/SL with one leg: the unset leg is sent with p, s, triggerPx \"\" (placeTpSlLeg goes through the pair)", async () => {
    venue.info.tpslOrders = () => {
      const c = ((venue.sent[0]?.action as { orders?: Array<{ c: string }> } | undefined)?.orders?.[0]?.c) ?? "none";
      return ok(venue.sent.length === 0 ? [] : [tpslRow({ cloid: c, slOid: "", slTriggerPrice: "", slOrderPrice: "", slOrderType: "" })]);
    };
    const r = await adapter().placeTpSlLeg({ symbol: "BTC", closeSide: "sell", size: "0.01", trigger: "90000", kind: "tp", limitPrice: null });
    const a = await sentAction() as unknown as { grouping: string; orders: Array<Record<string, unknown>> };
    expect(a.grouping).toBe("positionTpsl");
    expect(a.orders[0]).toMatchObject({ p: "", s: "", r: true, t: { trigger: { isMarket: true, triggerPx: "", tpsl: "sl" } } });
    expect(a.orders[1]).toMatchObject({ p: "", s: "0.01", t: { trigger: { isMarket: true, triggerPx: "90000", tpsl: "tp" } } });
    expect(r).toMatchObject({ orderId: "502", status: "open" });
  });

  it("position TP/SL unknown outcome: reconciled once by client id from tpslOrders, else ORDER_PENDING (sent once)", async () => {
    venue.exchange = () => json(502, "<html>bad gateway</html>");
    venue.info.tpslOrders = () => ok(venue.sent.length === 0 ? [] : [tpslRow({ cloid: (venue.sent[0].action as unknown as { orders: Array<{ c: string }> }).orders[0].c })]);
    const legs = await adapter().placeTpSlPair({ symbol: "BTC", closeSide: "sell", size: "0.01", tp: "90000", tpLimit: null, sl: null });
    expect(legs).toHaveLength(1);
    expect(legs[0].result.execution.notes).toContain("reconciled");
    venue.sent = [];
    venue.info.tpslOrders = () => ok([]);
    const e = await adapter().placeTpSlPair({ symbol: "BTC", closeSide: "sell", size: "0.01", tp: "90000", tpLimit: null, sl: "60000" }).catch(x => x) as PerpError;
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.remediation).toMatch(/Do NOT resubmit/);
    expect(venue.sent).toHaveLength(1);
  });

  it("position TP/SL executed but not in tpslOrders yet → accepted / pending per leg, no order id", async () => {
    const legs = await adapter().placeTpSlPair({ symbol: "BTC", closeSide: "sell", size: "0.01", tp: null, tpLimit: null, sl: "60000" });
    expect(legs).toEqual([expect.objectContaining({ kind: "sl", trigger: "60000", result: expect.objectContaining({ status: "accepted", finality: "pending", orderId: null }) })]);
  });
});

describe("placeOrder — refusals and outcomes", () => {
  it("venue rejection → ORDER_REJECTED (sent:false), nothing read back", async () => {
    venue.exchange = () => json(200, { status: "err", code: 10000, message: "Price precision does not match the tick size: 0.1" });
    await expect(adapter().placeOrder(req({}))).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED", details: { sent: false } } });
    expect(venue.infos.some(b => b.type === "frontendOpenOrders")).toBe(false);
  });

  it("price-band refusal of a market order → the band in details and the largest slippage bound that fits (never retried)", async () => {
    venue.exchange = () => json(200, { status: "err", code: 10000, message: "Order buy price is not within the price limit (Minimum price: 15924.84; Maximum price: 81216.68)" });
    const e = await adapter().placeOrder(req({ type: "market", price: null, tif: null, slippage: { ...slip, bps: 300 } })).catch((x: unknown) => x) as PerpError;
    expect(e.structured).toMatchObject({ code: "ORDER_REJECTED", details: { sent: false, priceBand: { min: "15924.84", max: "81216.68" } } });
    // mark 79624.2 → the band max leaves 199.99 bps
    expect(e.structured.remediation).toContain("retry with --slippage-bps 199 or less");
    expect(venue.sent.length).toBe(1);
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
    venue.info.orderDetails = () => ok({ type: "orderDetails", orderDetails: historyRowFor("c-9", "canceled", { oid: 555, sz: "0.01" }) });
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

describe("review fixes: client-id reuse, cancel races, paging, mixed groupings, margin mode", () => {
  it("venue definition with the switch ON: trading role, no gate", () => {
    expect(getVenue("txflow").roles).toEqual(["marketData", "account", "trading"]);
    expect(getVenue("txflow").gatedRoles).toBeNull();
  });

  it("client-id reuse: an OLDER filled order with the same client id is never read as this order", async () => {
    const old = historyRowFor("cli-test-1", "filled", { timestamp: Date.now() - TXFLOW_CLOID_MATCH_SKEW_MS - 60_000, oid: 1 });
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.historicalOrders = () => ok({ data: [old], hasMore: false });
    const r = await adapter().placeOrder(req({ tif: "IOC" }));
    expect(r).toMatchObject({ status: "accepted", finality: "pending", orderId: null, filledSize: null });
  });

  it("client-id reuse: two orders with the id since the send → never a guess (pending; reconciliation → ORDER_PENDING)", async () => {
    const two = () => ok({ data: [historyRowFor("cli-test-1", "filled", { oid: 11 }), historyRowFor("cli-test-1", "canceled", { oid: 12, sz: "0.01" })], hasMore: false });
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.historicalOrders = two;
    const r = await adapter().placeOrder(req({ tif: "IOC" }));
    expect(r).toMatchObject({ status: "accepted", finality: "pending" });
    expect(r.execution.notes.join(" ")).toMatch(/2 orders carry client id cli-test-1/);
    venue.exchange = () => json(502, "bad gateway");
    await expect(adapter().placeOrder(req({ tif: "IOC" }))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    // A lookup without a send (another process: trade status c:<id>) refuses to pick one.
    await expect(adapter().getOrderStatus("BTC", { kind: "clientOrderId", value: "cli-test-1" })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("a cancel racing a fill: the order left the open list FILLED → failed with the real state, never cancelled", async () => {
    let gone = false;
    venue.exchange = () => { gone = true; return executed("CancelOrder"); };
    venue.info.frontendOpenOrders = () => ok(gone ? [] : [{ ...openRowFor("c-1"), oid: 700 }]);
    venue.info.orderDetails = () => ok({ type: "orderDetails", orderDetails: historyRowFor("c-1", "filled", { oid: 700 }) });
    const r = await adapter().cancelByRef("BTC", { kind: "orderId", value: "700" });
    expect(r.cancelled).toEqual([]);
    expect(r.failed[0].error).toMatch(/not cancelled — the order is filled \(filled 0\.01\)/);
    // Partially filled, then cancelled → cancelled, and the fill is visible in venueRaw.
    gone = false;
    venue.info.orderDetails = () => ok({ type: "orderDetails", orderDetails: historyRowFor("c-1", "partialCanceled", { oid: 700, sz: "0.004" }) });
    const r2 = await adapter().cancelByRef("BTC", { kind: "orderId", value: "700" });
    expect(r2.cancelled).toEqual([{ kind: "orderId", value: "700" }]);
    expect(r2.venueRaw).toEqual([{ orderId: "700", venueStatus: "partialCanceled", filledSize: "0.006" }]);
    // Gone, but never in the order history within the settle window → pending.
    gone = false;
    venue.info.orderDetails = () => recorded("orderDetails.notFound");
    const r3 = await adapter().cancelByRef("BTC", { kind: "orderId", value: "700" });
    expect(r3.pending).toHaveLength(1);
    // The history lags (live testnet 2026-10-27: "not found", then "open", then canceled): it is
    // re-read until terminal — not found → open → canceled → cancelled.
    gone = false;
    const seq = [() => recorded("orderDetails.notFound"),
      () => ok({ type: "orderDetails", orderDetails: historyRowFor("c-1", "open", { oid: 700 }) }),
      () => ok({ type: "orderDetails", orderDetails: historyRowFor("c-1", "canceled", { oid: 700 }) })];
    let n = 0;
    venue.info.orderDetails = () => seq[Math.min(n++, seq.length - 1)]();
    const r4 = await adapter().cancelByRef("BTC", { kind: "orderId", value: "700" });
    expect(r4.cancelled).toEqual([{ kind: "orderId", value: "700" }]);
    expect(n).toBe(3);
  });

  it("a refused batch is re-verified per order: gone + cancelled → cancelled; still open → failed", async () => {
    const rows = [{ ...openRowFor("a"), oid: 801 }, { ...openRowFor("b"), oid: 802 }];
    let sent = false;
    venue.exchange = () => { sent = true; return json(200, { status: "err", code: 1, message: "Order not found" }); };
    // 801 was cancelled elsewhere between the listing and the batch; 802 stays open.
    venue.info.frontendOpenOrders = () => ok(sent ? [rows[1]] : rows);
    venue.info.orderDetails = () => ok({ type: "orderDetails", orderDetails: historyRowFor("a", "canceled", { oid: 801, sz: "0.01" }) });
    const r = await adapter().cancelAllV2("BTC");
    expect(r.cancelled).toEqual([{ kind: "orderId", value: "801" }]);
    expect(r.failed).toEqual([{ ref: { kind: "orderId", value: "802" }, error: expect.stringMatching(/Order not found/) }]);
  });

  it("mixed-grouping batch cancel: plain → {a, o}, trigger → {grouping, a, o}, a TP/SL pair → ONE {grouping: tpsl, a, o}; both legs proven", async () => {
    const plain = { ...openRowFor("p"), oid: 901 };
    const trig = { ...openRowFor("t"), oid: 902, isTrigger: true };
    let gone = false;
    venue.exchange = () => { gone = true; return executed("CancelOrder"); };
    venue.info.frontendOpenOrders = () => ok(gone ? [] : [plain, trig]);
    venue.info.tpslOrders = () => ok(gone ? [] : [tpslRow()]);
    venue.info.orderDetails = () => ok({ type: "orderDetails", orderDetails: historyRowFor("p", "canceled", { oid: 901, sz: "0.01" }) });
    venue.info.historicalTriggerOrders = () => ok({ data: [{ oid: 902, triggerState: "canceled", createTime: Date.now() }], hasMore: false });
    venue.info.historicalTpslOrders = () => ok({ data: [{ slOrderId: "501", tpOrderId: "502", state: "canceled", createTime: Date.now() }], hasMore: false });
    const r = await adapter().cancelAllV2(null);
    const a = await sentAction() as unknown as { cancels: Array<Record<string, unknown>> };
    expect(a.cancels).toEqual([{ grouping: "tpsl", a: 1, o: 501 }, { a: 1, o: 901 }, { grouping: "trigger", a: 1, o: 902 }]);
    expect(a.cancels.map(c => Object.keys(c))).toEqual([["grouping", "a", "o"], ["a", "o"], ["grouping", "a", "o"]]);
    expect(r.cancelled.map(c => c.value).sort()).toEqual(["501", "502", "901", "902"]);
  });

  it("open orders: an unset TP/SL leg keeps an allocated oid with trigger \"\" (live testnet row) → only the set leg is listed", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.tpslOrders = () => ok([tpslRow({ tpOid: "502", tpTriggerPrice: "", tpOrderPrice: "", tpOrderType: "Market" })]);
    const orders = await adapter().getOpenOrders();
    expect(orders).toEqual([
      { orderId: "501", symbol: "BTC", side: "sell", price: "0", size: "0.01", filled: "0", status: "untriggered", type: "sl market reduce-only", triggerPrice: "60000" },
    ]);
  });

  it("open orders list each live TP/SL leg (tpslOrders); cancelling one leg cancels the pair — both legs proven, a fired pair is not cancelled", async () => {
    venue.info.frontendOpenOrders = () => ok([]);
    venue.info.tpslOrders = () => ok([tpslRow()]);
    const orders = await adapter().getOpenOrders();
    expect(orders).toEqual([
      { orderId: "501", symbol: "BTC", side: "sell", price: "0", size: "0.01", filled: "0", status: "untriggered", type: "sl market reduce-only", triggerPrice: "60000" },
      { orderId: "502", symbol: "BTC", side: "sell", price: "89990", size: "0.01", filled: "0", status: "untriggered", type: "tp limit reduce-only", triggerPrice: "90000" },
    ]);
    let gone = false;
    venue.exchange = () => { gone = true; return executed("CancelOrder"); };
    venue.info.tpslOrders = () => ok(gone ? [] : [tpslRow()]);
    venue.info.historicalTpslOrders = () => ok({ data: [{ slOrderId: "501", tpOrderId: "502", state: "triggered", createTime: Date.now() }], hasMore: false });
    const r = await adapter().cancelByRef("BTC", { kind: "orderId", value: "502" });
    expect(await sentAction()).toEqual({ type: "cancel", cancels: [{ grouping: "tpsl", a: 1, o: 501 }] });
    expect(r.cancelled).toEqual([]);
    expect(r.failed.map(f => f.ref.value)).toEqual(["501", "502"]);
    expect(r.failed[0].error).toMatch(/triggered \(fired before the cancel\)/);
  });

  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ ...openRowFor(`x${from + i}`), oid: from + i }));

  it("frontendOpenOrders is paged (limit / offset) until an EMPTY page; the offset advances by the rows received", async () => {
    const offsets: unknown[] = [];
    venue.rawPaging = true;
    venue.info.frontendOpenOrders = b => {
      offsets.push(b.offset);
      expect(b.limit).toBe(TXFLOW_OPEN_ORDERS_PAGE);
      return ok(b.offset === 0 ? page(TXFLOW_OPEN_ORDERS_PAGE, 1) : b.offset === TXFLOW_OPEN_ORDERS_PAGE ? page(2, TXFLOW_OPEN_ORDERS_PAGE + 1) : []);
    };
    const os = await adapter().getOpenOrders();
    expect(os).toHaveLength(TXFLOW_OPEN_ORDERS_PAGE + 2);
    expect(offsets).toEqual([0, TXFLOW_OPEN_ORDERS_PAGE, TXFLOW_OPEN_ORDERS_PAGE + 2]);
  });

  it("a server that caps pages below the limit cannot truncate the list (cancel-all sees every order)", async () => {
    const all = page(250, 1); // served 100 rows at a time, whatever limit is asked
    let gone = false;
    venue.rawPaging = true;
    venue.exchange = () => { gone = true; return executed("CancelOrder"); };
    venue.info.frontendOpenOrders = b => ok(gone ? [] : all.slice(Number(b.offset), Number(b.offset) + 100));
    venue.info.orderDetails = b => ok({ type: "orderDetails", orderDetails: historyRowFor("x", "canceled", { oid: Number(b.orderId), sz: "0.01" }) });
    const r = await adapter().cancelAllV2(null);
    expect(((await sentAction()) as unknown as { cancels: unknown[] }).cancels).toHaveLength(200);
    expect(((await sentAction(1)) as unknown as { cancels: unknown[] }).cancels).toHaveLength(50);
    expect(r.cancelled).toHaveLength(250);
  });

  it("the page cap is a typed error, never a silent truncation", async () => {
    venue.rawPaging = true;
    venue.info.frontendOpenOrders = b => ok(page(1, Number(b.offset) + 1)); // never ends
    const e = await adapter().getOpenOrders().catch(x => x) as PerpError;
    expect(e.structured.code).toBe("EXCHANGE_ERROR");
    expect(e.message).toMatch(new RegExp(`still paging after ${TXFLOW_OPEN_ORDERS_MAX_PAGES} pages`));
    expect(venue.sent).toEqual([]);
  });

  it("margin mode: an opening order takes activeAssetData's mode; reduce-only without a position → POSITION_NOT_FOUND, nothing sent", async () => {
    venue.info.activeAssetData = () => ok({ user: ACCOUNT, coin: "1", leverage: { mode: "oneWay", type: "Isolated", value: 5, raw_usd: "1" }, maxTradeSzs: [], availableToTrade: [], markPx: "0", onlyIsolated: false });
    venue.info.frontendOpenOrders = () => ok([openRowFor("cli-test-1")]);
    await adapter().placeOrder(req({}));
    expect(((await sentAction()) as unknown as { orders: Array<{ m: string }> }).orders[0].m).toBe("isolated");
    venue.sent = [];
    venue.info.clearinghouseState = () => ok({ ...(FIX.reads["clearinghouseState.position"].body.data as object), assetPositions: [] });
    await expect(adapter().placeOrder(req({ reduceOnly: true, side: "sell" }))).rejects.toMatchObject({ structured: { code: "POSITION_NOT_FOUND", details: { sent: false } } });
    expect(venue.sent).toEqual([]);
  });

  it("shape drift is an error, never a null: malformed liquidationPx, unknown history status", async () => {
    const d = FIX.reads["clearinghouseState.position"].body.data as { assetPositions: Array<{ position: Record<string, unknown> }> };
    venue.info.clearinghouseState = () => ok({ ...d, assetPositions: [{ ...d.assetPositions[0], position: { ...d.assetPositions[0].position, liquidationPx: "n/a" } }] });
    await expect(adapter().getPositions()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    venue.info.historicalOrders = () => ok({ data: [historyRowFor("z", "weird")], hasMore: false });
    await expect(adapter().getOrderHistory(5)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("a market trigger without a slippage bound is refused before sending", async () => {
    await expect(adapter().placeOrder(req({ type: "stopMarket", side: "sell", price: null, tif: null, triggerPrice: "60000", reduceOnly: true, slippage: null })))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(venue.sent).toEqual([]);
  });
});
