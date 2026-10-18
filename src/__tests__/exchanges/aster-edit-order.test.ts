/**
 * Regression guard for AsterAdapter.editOrder.
 *
 * History: the first implementation was cancel + replace that defaulted the side to "buy"
 * when the order was missing (Rule #2 — a phantom replace on the wrong side can open/flip
 * a position) and dropped reduceOnly. It was then fixed to read the raw order, and is now
 * ("Aster 정정의 기존 버그(체결분 무시 → 이중 수량) 수정, Aster v3 native
 * modify(PUT /fapi/v3/order) 존재 시 native로"; venues/aster.ts capabilities.amend "native")
 * a NATIVE modify: one signed PUT /fapi/v3/order on the SAME order — no cancel, no new order,
 * so side and reduceOnly are kept by the venue. `size` = the new OPEN (unfilled) size; the
 * venue's `quantity` is the total order quantity, so quantity = size + executedQty.
 * Still fail-closed: order not open / non-LIMIT / unreadable executedQty / off-tick price →
 * throw before anything is sent.
 */
import { describe, it, expect, vi } from "vitest";
import { AsterAdapter } from "../../exchanges/aster.js";

function build(rawOrders: Array<Record<string, unknown>>, tickSize = "0.1") {
  const a = new AsterAdapter(undefined, false);
  const h = a as unknown as Record<string, unknown>;
  h._resolveSigner = vi.fn().mockReturnValue({ kind: "agent", signer: {}, agent: {} });
  h._signedGetEip712 = vi.fn().mockResolvedValue(rawOrders);
  h._symbolPriceFilters = vi.fn().mockResolvedValue({ tickSize });
  const put = vi.fn().mockResolvedValue({ orderId: 55, status: "NEW", executedQty: "0" });
  h._signedPostTo = put;
  const cancelOrder = vi.fn().mockResolvedValue({});
  const limitOrder = vi.fn().mockResolvedValue({ orderId: "new" });
  h.cancelOrder = cancelOrder;
  h.limitOrder = limitOrder;
  return { a, put, cancelOrder, limitOrder };
}

const putParams = (put: ReturnType<typeof vi.fn>) => put.mock.calls[0][2] as Record<string, string>;

describe("AsterAdapter.editOrder — native PUT modify, fail closed (Rule #2)", () => {
  it("modifies the order in place with PUT /fapi/v3/order, keeping the original SELL side (no cancel, no new order)", async () => {
    const { a, put, cancelOrder, limitOrder } = build([
      { orderId: "55", side: "SELL", type: "LIMIT", reduceOnly: "true", executedQty: "0" },
    ]);
    await a.editOrder("BTC", "55", "60000", "0.1");
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toBe("/fapi/v3/order");
    expect(put.mock.calls[0][4]).toBe("PUT");
    expect(putParams(put)).toMatchObject({ orderId: "55", side: "SELL", quantity: "0.1", price: "60000" });
    // reduceOnly is a property of the existing order — a modify cannot drop it, and no
    // replacement order (which could lose it) is ever placed.
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(limitOrder).not.toHaveBeenCalled();
  });

  it("quantity = new open size + already executed (a partial fill is never double-counted or dropped)", async () => {
    const { a, put } = build([
      { orderId: "56", side: "BUY", type: "LIMIT", executedQty: "0.03" },
    ]);
    await a.editOrder("BTC", "56", "60000", "0.1");
    expect(putParams(put).quantity).toBe("0.13");
  });

  it("throws (never defaults to buy) when the order is not open", async () => {
    const { a, put, cancelOrder, limitOrder } = build([]);
    await expect(a.editOrder("BTC", "999", "60000", "0.1")).rejects.toThrow(/not among the open orders/);
    expect(put).not.toHaveBeenCalled();
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(limitOrder).not.toHaveBeenCalled();
  });

  it("refuses to edit a non-LIMIT (stop) order rather than dropping its trigger", async () => {
    const { a, put, cancelOrder } = build([
      { orderId: "7", side: "BUY", type: "STOP_MARKET", reduceOnly: "true", executedQty: "0" },
    ]);
    await expect(a.editOrder("BTC", "7", "60000", "0.1")).rejects.toThrow(/only supports plain LIMIT/);
    expect(put).not.toHaveBeenCalled();
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it("refuses when the open-orders row has no readable executedQty (cannot compute the total quantity)", async () => {
    const { a, put } = build([{ orderId: "55", side: "SELL", type: "LIMIT" }]);
    await expect(a.editOrder("BTC", "55", "60000", "0.1")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses an off-tick price instead of rounding it", async () => {
    const { a, put } = build([{ orderId: "55", side: "SELL", type: "LIMIT", executedQty: "0" }], "0.5");
    await expect(a.editOrder("BTC", "55", "60000.3", "0.1")).rejects.toMatchObject({ structured: { code: "INVALID_TICK" } });
    expect(put).not.toHaveBeenCalled();
  });
});
