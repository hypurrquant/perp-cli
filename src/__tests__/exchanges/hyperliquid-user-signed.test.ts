/**
 * Regression guard: Hyperliquid USER-signed actions (withdraw3, approveBuilderFee,
 * tokenDelegate) must route through the SDK, which signs them with the
 * HyperliquidSignTransaction EIP-712 scheme — NOT through _sendExchangeAction,
 * which signs with the L1 phantom-agent scheme and would be rejected.
 */
import { describe, it, expect, vi } from "vitest";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";

function build() {
  const hl = new HyperliquidAdapter(undefined, false);
  const initiateWithdrawal = vi.fn().mockResolvedValue({ status: "ok" });
  const approveBuilderFee = vi.fn().mockResolvedValue({ status: "ok" });
  const tokenDelegate = vi.fn().mockResolvedValue({ status: "ok" });
  const _sendExchangeAction = vi.fn().mockResolvedValue({ status: "ok" });
  (hl as unknown as { ensureSigner: () => void }).ensureSigner = () => {};
  (hl as unknown as { sdk: unknown }).sdk = { exchange: { initiateWithdrawal, approveBuilderFee, tokenDelegate } };
  (hl as unknown as { _sendExchangeAction: typeof _sendExchangeAction })._sendExchangeAction = _sendExchangeAction;
  return { hl, initiateWithdrawal, approveBuilderFee, tokenDelegate, _sendExchangeAction };
}

describe("HyperliquidAdapter — user-signed actions route through the SDK (not the L1 scheme)", () => {
  it("withdraw uses sdk.exchange.initiateWithdrawal with no raw-action fallback", async () => {
    const { hl, initiateWithdrawal, _sendExchangeAction } = build();
    await hl.withdraw("100", "0xDest");
    expect(initiateWithdrawal).toHaveBeenCalledWith("0xDest", 100);
    expect(_sendExchangeAction).not.toHaveBeenCalled();
  });

  it("approveBuilderFee uses the SDK (user-signed), not _sendExchangeAction", async () => {
    const { hl, approveBuilderFee, _sendExchangeAction } = build();
    await hl.approveBuilderFee("0xBuilder", "0.001%");
    expect(approveBuilderFee).toHaveBeenCalledWith({ builder: "0xBuilder", maxFeeRate: "0.001%" });
    expect(_sendExchangeAction).not.toHaveBeenCalled();
  });

  it("tokenDelegate uses the SDK with (validator, isUndelegate, wei:bigint)", async () => {
    const { hl, tokenDelegate, _sendExchangeAction } = build();
    await hl.tokenDelegate("0xValidator", "1000", true);
    expect(tokenDelegate).toHaveBeenCalledWith("0xValidator", true, 1000n);
    expect(_sendExchangeAction).not.toHaveBeenCalled();
  });
});
