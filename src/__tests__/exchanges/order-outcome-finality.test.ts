/**
 * Resting / edited / cancelled orders resolve to a VENUE-FINAL outcome after the ack
 * (live testnet E2E 2026-10-02: a Pacifica GTC limit and a Lighter edit stopped the runner
 * as "accepted / pending"). Fixtures are real testnet responses read on 2026-10-02.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../../exchanges/venues/index.js"; // registers the venue definitions (getVenue)
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { PacificaAdapter, pacificaOrderOutcomeOf } from "../../exchanges/pacifica.js";
import { LighterAdapter, lighterModifyOutcomeOf, lighterEventInfo } from "../../exchanges/lighter.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import type { HyperliquidTestAdapter, LighterTestAdapter, PacificaTestAdapter } from "../helpers/internals.js";

afterEach(() => vi.useRealTimers());

/** Resolve a promise that sleeps on fake timers. */
async function run<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

// GET https://test-api.pacifica.fi/api/v1/orders/history_by_id?order_id=404293262 (2026-10-02)
const PAC_MAKE = {
  history_id: 765955078, order_id: 404293262, client_order_id: "5ac1f131-30bb-4a13-9e2b-e3efac43c814", parent_id: null,
  symbol: "SOL", side: "bid", price: "116.33", initial_amount: "0.1", filled_amount: "0", cancelled_amount: "0",
  event_type: "make", order_type: "limit", order_status: "open", stop_price: null, stop_parent_order_id: null,
  reduce_only: false, trigger_price_type: null, instrument_type: "perpetual", created_at: 1790915468069,
};
const PAC_CANCEL = {
  ...PAC_MAKE, history_id: 765956516, cancelled_amount: "0.1", event_type: "cancel", order_status: "cancelled", created_at: 1790915526344,
};
const PAC_ACK = { success: true, data: { order_id: 404293262 }, error: null, code: null };

describe("pacificaOrderOutcomeOf (history_by_id rows)", () => {
  it("the live 'make' row → resting open, filled 0", () => {
    expect(pacificaOrderOutcomeOf([PAC_MAKE], "404293262")).toMatchObject({
      status: "open", final: true, venueStatus: "open", eventType: "make", filledSize: "0", price: "116.33", size: "0.1",
    });
  });

  it("make + cancel rows (newest first, as served) → cancelled", () => {
    expect(pacificaOrderOutcomeOf([PAC_CANCEL, PAC_MAKE], "404293262")).toMatchObject({ status: "cancelled", venueStatus: "cancelled" });
  });

  it("partial fill: open with filled → partiallyFilled; cancelled with filled → partiallyFilled; filled → filled", () => {
    expect(pacificaOrderOutcomeOf([{ ...PAC_MAKE, filled_amount: "0.04" }], "404293262")?.status).toBe("partiallyFilled");
    expect(pacificaOrderOutcomeOf([{ ...PAC_CANCEL, filled_amount: "0.04" }], "404293262")?.status).toBe("partiallyFilled");
    expect(pacificaOrderOutcomeOf([{ ...PAC_MAKE, order_status: "filled", filled_amount: "0.1" }], "404293262")?.status).toBe("filled");
    expect(pacificaOrderOutcomeOf([{ ...PAC_MAKE, order_status: "rejected" }], "404293262")?.status).toBe("rejected");
  });

  it("not proven → null: no rows, another order id, unknown status, no filled_amount, price / size mismatch, IOC open row", () => {
    expect(pacificaOrderOutcomeOf([], "404293262")).toBeNull();
    expect(pacificaOrderOutcomeOf([{ ...PAC_MAKE, order_id: 1 }], "404293262")).toBeNull();
    expect(pacificaOrderOutcomeOf([{ ...PAC_MAKE, order_status: "weird" }], "404293262")).toBeNull();
    expect(pacificaOrderOutcomeOf([{ ...PAC_MAKE, filled_amount: null }], "404293262")).toBeNull();
    expect(pacificaOrderOutcomeOf([PAC_MAKE], "404293262", { expect: { price: "116.34", size: "0.1" } })).toBeNull();
    expect(pacificaOrderOutcomeOf([PAC_MAKE], "404293262", { expect: { price: "116.330", size: "0.10" } })?.status).toBe("open");
    expect(pacificaOrderOutcomeOf([PAC_MAKE], "404293262", { terminalOnly: true })).toBeNull();
  });
});

function pacAdapter(history: () => Promise<unknown>) {
  const a = Object.create(PacificaAdapter.prototype) as PacificaTestAdapter;
  const client = {
    createLimitOrder: vi.fn().mockResolvedValue(PAC_ACK),
    createStopOrder: vi.fn().mockResolvedValue({ success: true, data: { order_id: 77 } }),
    getOrderHistoryById: vi.fn(history),
    getInfo: async () => ["BTC", "ETH", "SOL"].map((symbol) => ({ symbol, instrument_type: "perpetual" })),
  };
  a.client = client;
  a.account = "acct";
  a.signMessage = vi.fn();
  a.ensureSigner = vi.fn();
  a.builderCode = vi.fn().mockResolvedValue(null);
  return { a, client };
}

describe("Pacifica limit placement resolves the ack via history_by_id", () => {
  it("GTC ack → orderOutcome open attached; TradingV2 reports final open", async () => {
    vi.useFakeTimers();
    const { a, client } = pacAdapter(async () => ({ success: true, data: [PAC_MAKE] }));
    const raw = await run(a.limitOrder("SOL", "buy", "116.33", "0.10", { tif: "GTC" })) as Record<string, unknown>;
    expect(client.getOrderHistoryById).toHaveBeenCalledWith(404293262);
    expect(raw.orderOutcome).toMatchObject({ status: "open", orderId: "404293262" });

    const adapter = {
      name: "pacifica",
      limitOrder: vi.fn().mockResolvedValue(raw),
      getMarkets: vi.fn().mockResolvedValue([{ symbol: "SOL", stepSize: "0.01", sizeDecimals: 2 }]),
    } as unknown as ExchangeAdapter;
    const r = await toTradingV2(adapter, "testnet").placeOrder({
      symbol: "SOL", side: "buy", type: "limit", size: "0.10", price: "116.33", triggerPrice: null, triggerSource: null,
      tif: "GTC", reduceOnly: false, clientOrderId: null, slippage: null, tpsl: null,
    });
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "404293262", filledSize: "0" });
  });

  it("history never shows the order → no orderOutcome, TradingV2 stays accepted / pending", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { a, client } = pacAdapter(async () => ({ success: true, data: [] }));
    const raw = await run(a.limitOrder("SOL", "buy", "116.33", "0.10", { tif: "GTC" })) as Record<string, unknown>;
    expect(raw.orderOutcome).toBeUndefined();
    expect(client.getOrderHistoryById).toHaveBeenCalledTimes(6); // bounded
    err.mockRestore();
    const adapter = {
      name: "pacifica", limitOrder: vi.fn().mockResolvedValue(raw),
      getMarkets: vi.fn().mockResolvedValue([{ symbol: "SOL", stepSize: "0.01", sizeDecimals: 2 }]),
    } as unknown as ExchangeAdapter;
    const r = await toTradingV2(adapter, "testnet").placeOrder({
      symbol: "SOL", side: "buy", type: "limit", size: "0.10", price: "116.33", triggerPrice: null, triggerSource: null,
      tif: "GTC", reduceOnly: false, clientOrderId: null, slippage: null, tpsl: null,
    });
    expect(r).toMatchObject({ status: "accepted", finality: "pending", orderId: "404293262", filledSize: null });
  });

  it("an explicit body refusal is not polled", async () => {
    vi.useFakeTimers();
    const { a, client } = pacAdapter(async () => ({ data: [PAC_MAKE] }));
    client.createLimitOrder.mockResolvedValue({ success: false, error: "post only would cross" });
    const raw = await run(a.limitOrder("SOL", "buy", "116.33", "0.10", { tif: "ALO" })) as Record<string, unknown>;
    expect(raw.orderOutcome).toBeUndefined();
    expect(client.getOrderHistoryById).not.toHaveBeenCalled();
  });

  it("stop order ack → its untriggered stop row (open) is attached", async () => {
    vi.useFakeTimers();
    const stopRow = { ...PAC_MAKE, order_id: 77, price: null, initial_amount: "0.09", event_type: "stop_created", order_type: "stop_market", stop_price: "116.43" };
    const { a } = pacAdapter(async () => ({ data: [stopRow] }));
    const raw = await run(a.stopOrder("SOL", "sell", "0.09", "116.43", { reduceOnly: true })) as Record<string, unknown>;
    expect(raw.orderOutcome).toMatchObject({ status: "open", orderId: "77", eventType: "stop_created" });
  });
});

// GET https://testnet.zklighter.elliot.ai/api/v1/tx?by=hash&value=9afd384a… (ModifyOrder, type 17), 2026-10-02
const LT_MODIFY_EVENT = lighterEventInfo(
  '{"ms":2,"m":4097,"oo":{"i":1125899905395892,"u":179091542135562,"a":537,"is":95,"p":116163,"rs":95,"ia":0,"ot":0,"f":1,"ro":0,"tp":0,"e":1793334621472,"st":2,"ts":0,"t0":0,"t1":0,"c0":0,"ifci":0,"itf":0,"imf":0,"of":0,"mn":0},"no":{"i":1125899905395892,"u":179091542135562,"a":537,"is":97,"p":114940,"rs":97,"ia":0,"ot":0,"f":1,"ro":0,"tp":0,"e":1793334621472,"st":2,"ts":0,"t0":0,"t1":0,"c0":0,"ifci":0,"itf":0,"imf":0,"of":0,"mn":0},"ae":""}',
);
// GET /api/v1/accountOrders?client_order_indexes=179091542135562 after the lead's cancel, 2026-10-02
const LT_CANCELED_ROW = {
  order_index: 1125899905395892, client_order_index: 179091542135562, order_id: "1125899905395892", client_order_id: "179091542135562",
  market_index: 4097, initial_base_amount: "0.097", price: "114.940", remaining_base_amount: "0.000", is_ask: false,
  base_price: 114940, filled_base_amount: "0.000", type: "limit", time_in_force: "good-till-time", reduce_only: false,
  trigger_price: "0.000", status: "canceled",
};

describe("Lighter modify outcome (event_info `no`)", () => {
  const sent = { baseAmount: 97, priceTicks: 114940 };
  it("the live modify event (st 2 open) does not settle the fill — event_info has no filled field → null (accountOrders)", () => {
    expect(lighterModifyOutcomeOf(LT_MODIFY_EVENT, "1125899905395892", 179091542135562, sent, 3)).toBeNull();
  });
  it("a modify event whose new order is filled (st 3) → final filled, the whole size", () => {
    const filled = { ...LT_MODIFY_EVENT, no: { ...(LT_MODIFY_EVENT!.no as Record<string, unknown>), rs: 0, st: 3 } };
    expect(lighterModifyOutcomeOf(filled, "1125899905395892", 179091542135562, sent, 3)).toEqual({
      status: "filled", final: true, venueStatus: "filled", filledSize: "0.097", orderId: "1125899905395892", source: "event_info",
    });
  });
  it("price or size not the ones sent / another order → null", () => {
    expect(lighterModifyOutcomeOf(LT_MODIFY_EVENT, "1125899905395892", null, { ...sent, priceTicks: 116163 }, 3)).toBeNull();
    expect(lighterModifyOutcomeOf(LT_MODIFY_EVENT, "1125899905395892", null, { ...sent, baseAmount: 95 }, 3)).toBeNull();
    expect(lighterModifyOutcomeOf(LT_MODIFY_EVENT, "1", null, sent, 3)).toBeNull();
    expect(lighterModifyOutcomeOf({ ae: "" }, "1125899905395892", null, sent, 3)).toBeNull();
  });
});

function ltAdapter() {
  const a = Object.create(LighterAdapter.prototype) as LighterTestAdapter;
  a.name = "lighter";
  a._testnet = false;
  a._apiKeyIndex = 6;
  a._accountIndex = 537;
  a._marketDecimals = new Map([["SOL", { size: 3, price: 3 }]]);
  a.ensureSigner = vi.fn();
  a.ensureMarketMap = vi.fn();
  a.getMarketIndex = vi.fn().mockReturnValue(4097);
  a.getNextNonce = vi.fn().mockResolvedValue(4);
  a.restGetAuth = vi.fn().mockResolvedValue({ code: 200, orders: [{ ...LT_CANCELED_ROW, status: "open", price: "116.163", initial_base_amount: "0.095", remaining_base_amount: "0.095" }] });
  a.sendTx = vi.fn().mockResolvedValue({ code: 200, message: "{\"ratelimit\": \"Ratelimit is off\"}", tx_hash: "9afd", predicted_execution_time_ms: 1790915438655 });
  a._signer = {
    signModifyOrder: vi.fn().mockReturnValue({ txType: 17, txInfo: "{}", txHash: "9afd" }),
    signCancelOrder: vi.fn().mockReturnValue({ txType: 15, txInfo: "{}", txHash: "c" }),
  };
  return a;
}

describe("Lighter edit → final through TradingV2", () => {
  it("modify tx executed with the new order in event_info → final open, the order's own id", async () => {
    vi.useFakeTimers();
    const a = ltAdapter();
    a.restGet = vi.fn().mockResolvedValue({ hash: "9afd", status: 2, executed_at: 1790915437579, event_info: JSON.stringify(LT_MODIFY_EVENT) });
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([{ ...LT_CANCELED_ROW, status: "open", remaining_base_amount: "0.097" }]);
    const v2 = toTradingV2(a as unknown as ExchangeAdapter, "testnet");
    const r = await run(v2.amendOrder({ symbol: "SOL", ref: { kind: "orderId", value: "1125899905395892" }, price: "114.940", size: "0.097", tif: null }));
    expect(a._signer.signModifyOrder).toHaveBeenCalledWith(expect.objectContaining({ index: 179091542135562, baseAmount: 97, price: 114940 }));
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "1125899905395892", filledSize: "0.000" });
  });

  it("modify tx rejected → ORDER_REJECTED (order unchanged)", async () => {
    vi.useFakeTimers();
    const a = ltAdapter();
    a.restGet = vi.fn().mockResolvedValue({ hash: "9afd", status: 0, executed_at: 0, event_info: "" });
    await expect(run(a.modifyOrder("SOL", "1125899905395892", "114.940", "0.097"))).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("tx never seen and accountOrders still shows the old price → no outcome (pending)", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ltAdapter();
    a.restGet = vi.fn().mockRejectedValue(new Error("transaction not found"));
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([{ ...LT_CANCELED_ROW, status: "open", price: "116.163", initial_base_amount: "0.095" }]);
    const raw = await run(a.modifyOrder("SOL", "1125899905395892", "114.940", "0.097")) as Record<string, unknown>;
    expect(raw.orderOutcome).toBeUndefined();
    err.mockRestore();
  });

  it("tx not settled by event_info, accountOrders shows the new price / size → final", async () => {
    vi.useFakeTimers();
    const a = ltAdapter();
    a.restGet = vi.fn().mockResolvedValue({ hash: "9afd", status: 2, executed_at: 1, event_info: "{\"ae\":\"\"}" });
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([{ ...LT_CANCELED_ROW, status: "open", remaining_base_amount: "0.097" }]);
    const raw = await run(a.modifyOrder("SOL", "1125899905395892", "114.940", "0.097")) as Record<string, unknown>;
    expect(raw.orderOutcome).toMatchObject({ status: "open", source: "accountOrders" });
  });
});

describe("Lighter cancel → confirmed canceled, not just tx executed", () => {
  const cancelWith = async (rows: unknown[]) => {
    vi.useFakeTimers();
    const a = ltAdapter();
    a.restGetAuth = vi.fn().mockResolvedValue({ code: 200, orders: [{ ...LT_CANCELED_ROW, status: "open" }] }); // accountActiveOrders before the cancel
    a.restGet = vi.fn().mockResolvedValue({ hash: "c", status: 2, executed_at: 1, event_info: "{\"ae\":\"\"}" });
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue(rows);
    const v2 = toTradingV2(a as unknown as ExchangeAdapter, "testnet");
    return run(v2.cancelByRef("SOL", { kind: "orderId", value: "1125899905395892" }));
  };

  it("the live canceled accountOrders row → cancelled", async () => {
    const r = await cancelWith([LT_CANCELED_ROW]);
    expect(r.cancelled).toEqual([{ kind: "orderId", value: "1125899905395892" }]);
  });

  it("filled before the cancel → failed", async () => {
    const r = await cancelWith([{ ...LT_CANCELED_ROW, status: "filled", filled_base_amount: "0.097" }]);
    expect(r.cancelled).toEqual([]);
    expect(r.failed[0].error).toMatch(/filled before the cancel/);
  });

  it("still open after the executed tx → pending, never cancelled", async () => {
    const r = await cancelWith([{ ...LT_CANCELED_ROW, status: "open" }]);
    expect(r.cancelled).toEqual([]);
    expect(r.pending?.[0].reason).toMatch(/still listed open/);
  });
});

// POST /info {type:"frontendOpenOrders"} / orderStatus shape on testnet, 2026-10-02 (oid 61622575499)
const HL_STOP_ROW = {
  coin: "SOL", side: "A", limitPx: "116.43", sz: "0.09", oid: 61622575499, timestamp: 1790915633366,
  triggerCondition: "Price below 116.43", isTrigger: true, triggerPx: "116.43", children: [], isPositionTpsl: false,
  reduceOnly: true, orderType: "Stop Market", origSz: "0.09", tif: null, cloid: null,
};

function hlAdapter(info: (body: Record<string, unknown>) => unknown) {
  const a = Object.create(HyperliquidAdapter.prototype) as HyperliquidTestAdapter;
  a._address = "0xabc";
  a._dex = "";
  a._assetMap = new Map([["SOL-PERP", 5]]);
  a.ensureSigner = vi.fn();
  a.ensureAddress = vi.fn();
  a._invalidateAccountCache = vi.fn();
  a._infoPost = vi.fn(async (b: Record<string, unknown>) => info(b));
  a._signAndSendAction = vi.fn();
  return a;
}

describe("Hyperliquid trigger orders", () => {
  it("account orders list a stop as such (frontendOpenOrders orderType)", async () => {
    const a = hlAdapter(() => [HL_STOP_ROW, { ...HL_STOP_ROW, oid: 9, isTrigger: false, orderType: "Limit", triggerPx: "0.0" }]);
    const orders = await a.getOpenOrders();
    expect(a._infoPost).toHaveBeenCalledWith({ type: "frontendOpenOrders", user: "0xabc" });
    expect(orders.map(o => [o.orderId, o.symbol, o.side, o.type])).toEqual([
      ["61622575499", "SOL-PERP", "sell", "Stop Market"], ["9", "SOL-PERP", "sell", "limit"],
    ]);
  });

  it("cancel of a stop oid sends exactly {type:cancel, cancels:[{a, o:<int>}]}", async () => {
    const a = hlAdapter(() => null);
    (a._signAndSendAction as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } });
    await a.cancelOrder("SOL", "61622575499");
    expect(a._signAndSendAction).toHaveBeenCalledWith({ type: "cancel", cancels: [{ a: 5, o: 61622575499 }] });
  });

  it("a non-numeric order id (e.g. an unresolved '<stopOrderId>') is refused before sending", async () => {
    const a = hlAdapter(() => null);
    await expect(a.cancelOrder("SOL", "<stopOrderId>")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(a._signAndSendAction).not.toHaveBeenCalled();
  });

  it("'waitingForTrigger' ack → the new trigger's oid from frontendOpenOrders; TradingV2 reports it", async () => {
    vi.useFakeTimers();
    let n = 0;
    const a = hlAdapter(() => (n++ === 0 ? [] : [HL_STOP_ROW]));
    a.getSzDecimals = vi.fn().mockReturnValue(2);
    a.builderDecision = vi.fn().mockResolvedValue({ applied: null, note: null });
    a.markPrice = vi.fn().mockResolvedValue(120); // sell stop 116.43 below the mark → "sl"
    const ack = { status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } };
    (a._signAndSendAction as ReturnType<typeof vi.fn>).mockResolvedValue(ack);
    const raw = await run(a.stopOrder("SOL", "sell", "0.09", "116.43", { reduceOnly: true })) as Record<string, unknown>;
    expect(raw.triggerOid).toBe("61622575499");

    const adapter = { name: "hyperliquid", stopOrder: vi.fn().mockResolvedValue(raw) } as unknown as ExchangeAdapter;
    const r = await toTradingV2(adapter, "testnet").placeOrder({
      symbol: "SOL", side: "sell", type: "stopMarket", size: "0.09", price: null, triggerPrice: "116.43", triggerSource: null,
      tif: null, reduceOnly: true, clientOrderId: null, slippage: null, tpsl: null,
    });
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "61622575499" });
  });

  it("an identical trigger already resting before the order → that one is not taken", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = hlAdapter(() => [HL_STOP_ROW]);
    a.getSzDecimals = vi.fn().mockReturnValue(2);
    a.builderDecision = vi.fn().mockResolvedValue({ applied: null, note: null });
    a.markPrice = vi.fn().mockResolvedValue(120); // sell stop 116.43 below the mark → "sl"
    (a._signAndSendAction as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } });
    const raw = await run(a.stopOrder("SOL", "sell", "0.09", "116.43", { reduceOnly: true })) as Record<string, unknown>;
    expect(raw.triggerOid).toBeUndefined();
    err.mockRestore();
  });
});
