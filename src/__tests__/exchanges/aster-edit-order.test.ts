/**
 * Regression guard for AsterAdapter.editOrder (cancel + replace).
 *
 * The previous implementation defaulted the side to "buy" when the order was not
 * found in the open-orders snapshot (Rule #2 violation — a phantom replace on the
 * wrong side can open/flip a position) and dropped reduceOnly, so editing a
 * reduce-only TP/SL could silently grow position size. The fix reads the raw order
 * to preserve side + reduceOnly, throws when the order is absent, and refuses to
 * cancel+replace a non-LIMIT order.
 */
import { describe, it, expect, vi } from "vitest";
import { AsterAdapter } from "../../exchanges/aster.js";

function build(rawOrders: Array<Record<string, unknown>>) {
  const a = new AsterAdapter(undefined, false);
  (a as unknown as { _resolveSigner: () => unknown })._resolveSigner =
    vi.fn().mockReturnValue({ kind: "agent", signer: {}, agent: {} });
  (a as unknown as { _signedGetEip712: (...args: unknown[]) => Promise<unknown> })._signedGetEip712 =
    vi.fn().mockResolvedValue(rawOrders);
  const cancelOrder = vi.fn().mockResolvedValue({});
  const limitOrder = vi.fn().mockResolvedValue({ orderId: "new" });
  (a as unknown as { cancelOrder: typeof cancelOrder }).cancelOrder = cancelOrder;
  (a as unknown as { limitOrder: typeof limitOrder }).limitOrder = limitOrder;
  return { a, cancelOrder, limitOrder };
}

describe("AsterAdapter.editOrder — preserve side/reduceOnly, fail closed (Rule #2)", () => {
  it("preserves the original SELL side + reduceOnly on the replacement", async () => {
    const { a, cancelOrder, limitOrder } = build([
      { orderId: "55", side: "SELL", type: "LIMIT", reduceOnly: "true" },
    ]);
    await a.editOrder("BTC", "55", "60000", "0.1");
    expect(cancelOrder).toHaveBeenCalledWith("BTC", "55");
    expect(limitOrder).toHaveBeenCalledWith("BTC", "sell", "60000", "0.1", { reduceOnly: true });
  });

  it("throws (never defaults to buy) when the order is not open", async () => {
    const { a, cancelOrder, limitOrder } = build([]);
    await expect(a.editOrder("BTC", "999", "60000", "0.1")).rejects.toThrow(/not among the open orders/);
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(limitOrder).not.toHaveBeenCalled();
  });

  it("refuses to edit a non-LIMIT (stop) order rather than dropping its trigger", async () => {
    const { a, cancelOrder } = build([
      { orderId: "7", side: "BUY", type: "STOP_MARKET", reduceOnly: "true" },
    ]);
    await expect(a.editOrder("BTC", "7", "60000", "0.1")).rejects.toThrow(/only supports plain LIMIT/);
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});
