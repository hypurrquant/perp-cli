/**
 * Legacy `cancelAllOrders` on the TradingV2 adapters: the bot engine, grid and plan `cancel_all`
 * read only a throw as a failure, so any failed or unproven cancel is one error carrying the
 * per-order outcome — as on the Hyperliquid / Lighter / Pacifica adapters.
 */
import { describe, it, expect } from "vitest";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { ArcusAdapter } from "../../exchanges/arcus/adapter.js";
import { QfexAdapter } from "../../exchanges/qfex/adapter.js";
import { TxflowAdapter } from "../../exchanges/txflow/adapter.js";
import { RisexAdapter } from "../../exchanges/risex/adapter.js";
import type { CancelResult } from "../../exchanges/venue-types.js";

const ref = (value: string) => ({ kind: "orderId" as const, value });
type Legacy = { cancelAllV2: () => Promise<CancelResult>; cancelAllOrders(s?: string): Promise<unknown> };

/** An adapter whose cancelAllV2 (the per-order-proven cancel) answers `over`. */
function withV2Result(Adapter: { prototype: object }, over: Partial<CancelResult>): Legacy {
  const a = Object.create(Adapter.prototype) as Legacy;
  a.cancelAllV2 = async () => ({ venue: "ondo", cancelled: [], failed: [], pending: [], venueRaw: null, ...over });
  return a;
}

describe("legacy cancelAllOrders (TradingV2 adapters)", () => {
  it.each([["ondo", OndoAdapter], ["arcus", ArcusAdapter], ["qfex", QfexAdapter], ["txflow", TxflowAdapter], ["risex", RisexAdapter]] as const)(
    "%s: a venue-refused cancel rejects with the per-order outcome (never resolves)", async (_venue, Adapter) => {
      const a = withV2Result(Adapter, { cancelled: [ref("o1")], failed: [{ ref: ref("o2"), error: "order is not open" }] });
      await expect(a.cancelAllOrders("AAPL")).rejects.toMatchObject({
        structured: { code: "ORDER_PARTIAL", details: { cancelled: [ref("o1")], failed: [{ ref: ref("o2"), error: "order is not open" }] } },
      });
    });

  it("nothing cancelled: ORDER_REJECTED when every failure is a venue refusal, ORDER_PENDING when a cancel is unproven", async () => {
    await expect(withV2Result(OndoAdapter, { failed: [{ ref: ref("o2"), error: "refused" }] }).cancelAllOrders())
      .rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
    await expect(withV2Result(OndoAdapter, { pending: [{ ref: ref("o3"), reason: "still listed open", remediation: "check" }] }).cancelAllOrders())
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });

  it("every order proven cancelled → resolves with the cancelAllV2 result", async () => {
    await expect(withV2Result(OndoAdapter, { cancelled: [ref("o1")] }).cancelAllOrders()).resolves.toMatchObject({ cancelled: [ref("o1")] });
  });
});
