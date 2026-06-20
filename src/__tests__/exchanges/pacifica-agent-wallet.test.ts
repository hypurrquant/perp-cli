/**
 * Regression guard: Pacifica agent-wallet trades must carry the agent_wallet field.
 *
 * In agent mode the adapter signs with the AGENT key but sets account = master,
 * so the request body MUST include agent_wallet or Pacifica verifies the signature
 * against the master key and rejects every order. buildAgentSignedRequest existed
 * but was never wired into the order path; the fix routes all signed bodies through
 * PacificaClient.signedBody, which attaches agent_wallet when one is set.
 */
import { describe, it, expect, vi } from "vitest";
import { PacificaClient } from "../../pacifica/client.js";

function build() {
  const client = new PacificaClient({ network: "mainnet" });
  const post = vi.fn().mockResolvedValue({ ok: true });
  (client as unknown as { post: typeof post }).post = post;
  const signMessage = async () => new Uint8Array(64).fill(7);
  return { client, post, signMessage };
}

const params = { symbol: "BTC", amount: "0.1", side: "bid" as const, slippage_percent: "1", reduce_only: false };

describe("PacificaClient — agent_wallet attachment (agent-mode signing)", () => {
  it("omits agent_wallet for a master/PK signer (account self-signs)", async () => {
    const { client, post, signMessage } = build();
    await client.createMarketOrder(params, "MasterPubkey", signMessage);
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.account).toBe("MasterPubkey");
    expect(body.agent_wallet).toBeUndefined();
  });

  it("attaches agent_wallet (account stays master) once an agent wallet is set", async () => {
    const { client, post, signMessage } = build();
    client.setRequestAgentWallet("AgentPubkey");
    await client.createMarketOrder(params, "MasterPubkey", signMessage);
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.account).toBe("MasterPubkey");
    expect(body.agent_wallet).toBe("AgentPubkey");
  });

  it("clears agent_wallet when reset to undefined (tier fell back to master)", async () => {
    const { client, post, signMessage } = build();
    client.setRequestAgentWallet("AgentPubkey");
    client.setRequestAgentWallet(undefined);
    await client.createMarketOrder(params, "MasterPubkey", signMessage);
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.agent_wallet).toBeUndefined();
  });
});
