/**
 * Regression guard: Pacifica withdraw goes only to the account owner's own wallet.
 *
 * The REST API has no destination field, yet the adapter sent a non-existent
 * dest_address and the CLI advertised `--to <address>` — a false affordance that
 * silently routed funds to the own wallet regardless. The fix drops dest_address
 * and refuses a mismatched destination (Rule #2: no misdirection).
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";

function build() {
  const pac = new PacificaAdapter(Keypair.generate(), "mainnet");
  const withdraw = vi.fn().mockResolvedValue({ ok: true });
  (pac as unknown as { client: { withdraw: typeof withdraw; setRequestAgentWallet: () => void } }).client = {
    withdraw,
    setRequestAgentWallet: vi.fn(),
  };
  return { pac, withdraw, account: pac.publicKey };
}

describe("PacificaAdapter.withdraw — own-wallet only (no destination field)", () => {
  it("withdraws to own wallet and sends NO dest_address", async () => {
    const { pac, withdraw, account } = build();
    await pac.withdraw("100", account);
    const params = withdraw.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toEqual({ amount: "100" });
    expect(params.dest_address).toBeUndefined();
  });

  it("accepts an empty destination (defaults to own wallet)", async () => {
    const { pac, withdraw } = build();
    await pac.withdraw("50", "");
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it("throws on a different destination rather than silently sending to own wallet", async () => {
    const { pac, withdraw } = build();
    await expect(pac.withdraw("100", "SomeOtherSolanaAddress")).rejects.toThrow(
      /only go to the account owner's own wallet/,
    );
    expect(withdraw).not.toHaveBeenCalled();
  });
});
