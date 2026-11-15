/**
 * Live mainnet 2026-10-12: `strategy grid` stopped on max-runtime, cancelled its orders and left
 * a 0.05 SOL short open with no word about it; est. PnL printed 0.015500000000000114.
 * At stop the grid's inventory (position change since start) is now reported (WARNING) and,
 * with --close-on-stop, closed reduce-only (closePerpVerified). Est. PnL counts completed round
 * trips only, without float noise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const closePerpVerified = vi.fn();
vi.mock("../bot/perp-order.js", () => ({ closePerpVerified: (...a: unknown[]) => closePerpVerified(...a) }));

import { runGrid, settleGridInventory } from "../strategies/grid.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

function adapter(positions: Array<{ symbol: string; side: "long" | "short"; size: string }>): ExchangeAdapter {
  return { name: "aster", getPositions: vi.fn(async () => positions) } as unknown as ExchangeAdapter;
}

describe("settleGridInventory", () => {
  beforeEach(() => closePerpVerified.mockReset());

  it("default: the grid's inventory is left open with a WARNING naming the position", async () => {
    const log = vi.fn();
    const inv = await settleGridInventory(adapter([{ symbol: "SOL", side: "short", size: "0.05" }]), "SOL", "0", false, log);
    expect(inv).toMatchObject({ startSize: "0", endSize: "-0.05", gridDelta: "-0.05", closed: "0", leftOpen: "0.05" });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/WARNING: the grid left 0\.05 SOL short open .*--close-on-stop/));
    expect(closePerpVerified).not.toHaveBeenCalled();
  });

  it("--close-on-stop closes only the grid's delta, reduce-only verified (pre-existing position untouched)", async () => {
    closePerpVerified.mockResolvedValue({ closed: 0.05, residual: 0, note: null });
    const inv = await settleGridInventory(adapter([{ symbol: "SOL", side: "long", size: "0.15" }]), "SOL", "0.10", true, vi.fn());
    // No printed-size decimals: closePerpVerified floors a partial close's residual to the market lot.
    expect(closePerpVerified).toHaveBeenCalledWith(expect.anything(), "aster", "SOL", "sell", "0.05");
    expect(inv).toMatchObject({ gridDelta: "0.05", closed: "0.05", leftOpen: "0.00" });
  });

  it("--close-on-stop never closes a delta the position no longer holds (would open a position)", async () => {
    const log = vi.fn();
    const inv = await settleGridInventory(adapter([{ symbol: "SOL", side: "long", size: "0.02" }]), "SOL", "0.05", true, log);
    expect(closePerpVerified).not.toHaveBeenCalled();
    expect(inv.leftOpen).toBe("0.03");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no longer holds"));
  });

  it("no change → nothing to report or close", async () => {
    const inv = await settleGridInventory(adapter([]), "SOL", "0", true, vi.fn());
    expect(inv).toMatchObject({ gridDelta: "0", leftOpen: "0" });
    expect(closePerpVerified).not.toHaveBeenCalled();
  });

  it("a failed position read is reported (leftOpen null), never assumed flat", async () => {
    const a = { name: "aster", getPositions: vi.fn(async () => { throw new Error("429"); }) } as unknown as ExchangeAdapter;
    const inv = await settleGridInventory(a, "SOL", "0", true, vi.fn());
    expect(inv).toMatchObject({ endSize: null, leftOpen: null });
  });
});

describe("runGrid est. PnL", () => {
  it("counts completed round trips only, without float noise", async () => {
    // Two lines; first poll: line 0 filled (opening fill) → flipped TP placed; second poll: TP filled (round trip).
    let polls = 0;
    let next = 0;
    const a = {
      name: "hyperliquid",
      getMarkets: vi.fn(async () => [{ symbol: "SOL", markPrice: "100.5" }]),
      getPositions: vi.fn(async () => []),
      limitOrder: vi.fn(async () => ({ orderId: `o${next++}` })),
      cancelAllOrders: vi.fn(async () => ({})),
      getOpenOrders: vi.fn(async () => {
        polls++;
        if (polls <= 2) return [{ orderId: "o1", symbol: "SOL" }]; // poll 1: o0 (line 0) filled; poll 2: o2 (its TP) filled
        return Array.from({ length: 20 }, (_, i) => ({ orderId: `o${i}`, symbol: "SOL" })); // nothing else fills
      }),
    } as unknown as ExchangeAdapter;
    const r = await runGrid(a, { symbol: "SOL", side: "neutral", upperPrice: 100.31, lowerPrice: 100, grids: 2, totalSize: 0.1, intervalSec: 0.01, maxRuntime: 0.08 }, undefined, () => {});
    expect(r.fills).toBe(2);
    // one round trip = step 0.31 × 0.05 = 0.0155 (float: 0.015500000000000114)
    expect(r.totalPnl).toBe(0.0155);
  });
});
