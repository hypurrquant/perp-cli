/**
 * Regression guard: Hyperliquid market orders must honour reduceOnly.
 *
 * The SDK's custom.marketOpen hardcodes reduce_only:false, so the adapter
 * previously sent every market order — including close/rollback orders that pass
 * { reduceOnly: true } — with reduce_only:false. If the size exceeded the live
 * position, HL would open or flip the opposite side instead of just reducing.
 * The fix routes reduce-only market orders through custom.marketClose (which is
 * reduce-only by construction and can never flip).
 */
import { describe, it, expect, vi } from "vitest";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";

function build() {
  const hl = new HyperliquidAdapter(undefined, false);
  const marketOpen = vi.fn().mockResolvedValue({ status: "ok" });
  const marketClose = vi.fn().mockResolvedValue({ status: "ok" });
  (hl as unknown as { ensureSigner: () => void }).ensureSigner = () => {};
  (hl as unknown as { _dex?: string })._dex = undefined;
  (hl as unknown as { sdk: unknown }).sdk = { custom: { marketOpen, marketClose } };
  (hl as unknown as { _validateOrderFill: () => void })._validateOrderFill = () => {};
  (hl as unknown as { _invalidateAccountCache: () => Promise<void> })._invalidateAccountCache = async () => {};
  return { hl, marketOpen, marketClose };
}

describe("HyperliquidAdapter.marketOrder — reduceOnly routing (flip-prevention)", () => {
  it("routes a reduce-only market order through marketClose, never marketOpen", async () => {
    const { hl, marketOpen, marketClose } = build();
    await hl.marketOrder("BTC", "sell", "0.1", { reduceOnly: true });
    expect(marketClose).toHaveBeenCalledWith("BTC", 0.1);
    expect(marketOpen).not.toHaveBeenCalled();
  });

  it("routes a normal opening market order through marketOpen", async () => {
    const { hl, marketOpen, marketClose } = build();
    await hl.marketOrder("BTC", "buy", "0.1");
    expect(marketOpen).toHaveBeenCalledWith("BTC", true, 0.1);
    expect(marketClose).not.toHaveBeenCalled();
  });
});
