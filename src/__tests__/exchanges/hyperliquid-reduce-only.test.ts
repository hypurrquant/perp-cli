/**
 * Regression guard: Hyperliquid market orders must honour reduceOnly.
 *
 * The SDK's custom.marketOpen hardcoded reduce_only:false, so the adapter once sent
 * every market order — including close/rollback orders that pass { reduceOnly: true } —
 * with reduce_only:false. If the size exceeded the live position, HL would open or flip
 * the opposite side instead of just reducing.
 *
 * Current contract (CHANGELOG "marketOrder/spotMarketOrder now require opts
 * { reduceOnly, slippage }"): marketOrder is ONE signed IOC limit order at the slippage-
 * bounded protection price; the order wire's `r` flag carries opts.reduceOnly verbatim.
 * The SDK marketOpen/marketClose helpers are no longer used.
 */
import { describe, it, expect, vi } from "vitest";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";

const slippage = { bps: 50, source: "default" as const };

function build() {
  const hl = new HyperliquidAdapter(undefined, false);
  const sent: Array<Record<string, unknown>> = [];
  const h = hl as unknown as Record<string, unknown>;
  h.ensureSigner = () => {};
  h.getAssetIndex = async () => 0;
  h.getSzDecimals = () => 5;
  h.computeProtectionPrice = async () => ({ referencePrice: "100000", protectionPrice: "100500", appliedBps: 50 });
  h._signAndSendAction = vi.fn(async (action: Record<string, unknown>) => {
    sent.push(action);
    return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.1", avgPx: "100000", oid: 1 } }] } } };
  });
  h._validateOrderFill = () => {};
  h._invalidateAccountCache = async () => {};
  const wire = () => (sent[0].orders as Array<Record<string, unknown>>)[0];
  return { hl, sent, wire };
}

describe("HyperliquidAdapter.marketOrder — reduceOnly routing (flip-prevention)", () => {
  it("sends a reduce-only market order with the order wire's r=true", async () => {
    const { hl, sent, wire } = build();
    await hl.marketOrder("BTC", "sell", "0.1", { reduceOnly: true, slippage });
    expect(sent).toHaveLength(1);
    expect(wire().r).toBe(true);
    expect(wire().b).toBe(false);
  });

  it("sends a normal opening market order with r=false", async () => {
    const { hl, wire } = build();
    await hl.marketOrder("BTC", "buy", "0.1", { reduceOnly: false, slippage });
    expect(wire().r).toBe(false);
    expect(wire().b).toBe(true);
  });

  it("is an IOC limit at the slippage-bounded protection price (never an unbounded market)", async () => {
    const { hl, wire } = build();
    await hl.marketOrder("BTC", "buy", "0.1", { reduceOnly: false, slippage });
    expect(wire().t).toEqual({ limit: { tif: "Ioc" } });
    expect(wire().p).toBe("100500");
  });
});
