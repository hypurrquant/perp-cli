/**
 * account_order_updates for Pacifica's strategy order types (docs.pacifica.fi, read 2026-10-19).
 * The docs add no `ot` codes for them: an Atomic leg is an ordinary market order (`ot: "market"`),
 * and the documented set stays limit / market / stop_limit / stop_market / take_profit_* /
 * stop_loss_*. The codec passes `ot` / `os` verbatim, so an undocumented future value decodes
 * as-is (no failure, no remap) and a missing one is null.
 */
import { describe, expect, it } from "vitest";
import { pacifica } from "../../ws/index.js";
import type { CodecDirectory } from "../../ws/types.js";

const DIR = { data: { nonPerp: new Set<string>() } } as unknown as CodecDirectory;

type OrdersDelta = { rows: Array<Record<string, unknown>>; remove: string[] };
/** Decode one frame; the orders delta of its single user event. */
function decodeOrders(text: string): { events: number; delta: OrdersDelta } {
  const evs = pacifica.decode(text, DIR, 0);
  const ev = evs[0] as unknown as { t: string; wire: string; deltas: OrdersDelta[] };
  expect(ev).toMatchObject({ t: "user", wire: "account_order_updates" });
  return { events: evs.length, delta: ev.deltas[0] };
}

// Docs account-order-updates stream example, with the fields an Atomic leg carries.
const row = (o: Record<string, unknown>) => ({
  i: 1559665358, I: "a5c88124-708b-4a06-bef0-fa4da2d98c06", u: "BrZp5bidJ3WUvceSq7X78bhjTfZXeezzGvGEV4hAYKTa", s: "BTC", d: "bid",
  p: "89501", ip: "89501", lp: "89501", a: "0.00061", f: "0", oe: "make", os: "open", ot: "market",
  sp: null, si: null, tp: null, r: false, ct: 1765017049008, ut: 1765017219639, li: 1559696133, ...o,
});
const frame = (...rows: Array<Record<string, unknown>>) => JSON.stringify({ channel: "account_order_updates", data: rows });

describe("pacifica account_order_updates — strategy / Atomic legs", () => {
  it("an Atomic leg (market) filled is a removal; a partially filled one is an order row with type market", () => {
    const { delta } = decodeOrders(frame(
      row({ i: 1, oe: "fulfill_market", os: "filled", f: "0.00061" }),
      row({ i: 2, s: "ETH", d: "ask", a: "0.021", f: "0.01", oe: "fulfill_market", os: "partially_filled" }),
    ));
    expect(delta.remove).toEqual(["1"]);
    expect(delta.rows).toHaveLength(1);
    expect(delta.rows[0]).toMatchObject({ orderId: "2", symbol: "ETH", side: "sell", type: "market", status: "partially_filled", clientId: "a5c88124-708b-4a06-bef0-fa4da2d98c06", reduceOnly: false });
  });

  it("an undocumented ot value passes through verbatim; a missing ot is null — no error event", () => {
    const { events, delta } = decodeOrders(frame(row({ i: 3, ot: "trailing_stop_market" }), row({ i: 4, ot: undefined })));
    expect(events).toBe(1);
    expect(delta.rows.map(r => r.type)).toEqual(["trailing_stop_market", null]);
  });

  it("a stop leg (stop_market with tp mark_price) still decodes as before", () => {
    const { delta } = decodeOrders(frame(row({ i: 5, ot: "stop_market", oe: "stop_created", sp: "95000", tp: "mark_price", r: true })));
    expect(delta.rows[0]).toMatchObject({ orderId: "5", type: "stop_market", reduceOnly: true });
  });
});
