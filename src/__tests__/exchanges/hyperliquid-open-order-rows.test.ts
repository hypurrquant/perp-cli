import { describe, it, expect } from "vitest";
import { hlOpenOrderRows, hlIsOutcomeCoin } from "../../exchanges/hyperliquid.js";

// The ONE row mapper of `getOpenOrders` and the dashboard feed (`openOrders` WS rows).
const row = (coin: string, oid: number) => ({ coin, oid, side: "B", limitPx: "100", sz: "1" });
const rows = [row("BTC", 1), row("@107", 2), row("PURR/USDC", 3), row("#12345", 4)];

describe("hlOpenOrderRows", () => {
  it("leaves HIP-4 outcome rows out of the perp list by default (the dashboard feed's call)", () => {
    expect(hlOpenOrderRows(rows, (coin) => coin).map((o) => o.symbol)).toEqual(["BTC"]);
  });

  it("returns the rows a `keep` predicate selects (the outcome commands' list)", () => {
    expect(hlOpenOrderRows(rows, (coin) => coin, hlIsOutcomeCoin).map((o) => o.orderId)).toEqual(["4"]);
  });
});
