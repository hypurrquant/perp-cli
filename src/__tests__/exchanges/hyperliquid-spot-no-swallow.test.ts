/**
 * Regression guard: HyperliquidSpotAdapter must NOT swallow fetch errors into [].
 * A transient clearinghouse/meta failure has to surface (Rule #2) — an empty list is
 * indistinguishable from a genuinely empty wallet/market set and silently drives
 * wrong arb sizing / false post-fill verification.
 */
import { describe, it, expect, vi } from "vitest";
import { HyperliquidSpotAdapter } from "../../exchanges/hyperliquid-spot.js";

function build(opts: { chReject?: boolean; infoReject?: boolean }) {
  const hl = {
    _getSpotClearinghouseState: opts.chReject
      ? vi.fn().mockRejectedValue(new Error("ch down"))
      : vi.fn().mockResolvedValue({ balances: [] }),
  };
  const spot = new HyperliquidSpotAdapter(hl as never);
  (spot as unknown as { init: () => Promise<void> }).init = async () => {};
  (spot as unknown as { _infoPost: () => Promise<unknown> })._infoPost = opts.infoReject
    ? vi.fn().mockRejectedValue(new Error("info down"))
    : vi.fn().mockResolvedValue({});
  return spot;
}

describe("HyperliquidSpotAdapter — fetch errors surface (no swallow-to-[], Rule #2)", () => {
  it("getSpotBalances rejects on clearinghouse fetch failure (does not return [])", async () => {
    await expect(build({ chReject: true }).getSpotBalances()).rejects.toThrow(/ch down/);
  });

  it("getSpotMarkets rejects on meta fetch failure (does not return [])", async () => {
    await expect(build({ infoReject: true }).getSpotMarkets()).rejects.toThrow(/info down/);
  });
});
