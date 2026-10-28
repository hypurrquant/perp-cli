/**
 * TxFlow agent lifecycle: approve (pre-checks, master-signed ApproveAgent, agentOwner proof, the
 * key kept on an unknown outcome and deleted on a refusal, label rotation), verify, revoke, and
 * import of a web-app key. Keys are throwaway (generated per run); OWS is an in-memory fake; every
 * venue request goes to a mocked fetch — nothing is sent anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ethers, TypedDataEncoder, recoverAddress, Signature } from "ethers";

// ── Fake OWS vault (import path) ──
type FakeWallet = { id: string; name: string; accounts: Array<{ chainId: string; address: string; derivationPath: string }>; createdAt: string };
const vault = new Map<string, FakeWallet>();
const mockOws = {
  listWallets: vi.fn(() => [...vault.values()]),
  deleteWallet: vi.fn((name: string) => { vault.delete(name); }),
  importWalletPrivateKey: vi.fn((name: string, key: string) => {
    const w = { id: `w-${name}`, name, accounts: [{ chainId: "eip155:1", address: new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`).address, derivationPath: "" }], createdAt: "2026-10-27T00:00:00.000Z" };
    vault.set(name, w);
    return w;
  }),
};
vi.mock("../../signer/ows-loader.js", () => ({ loadOws: () => mockOws }));
// The agent flow is part of TxFlow trading (txflow-release.ts); mocked on, whatever the shipped value.
vi.mock("../../exchanges/venues/txflow-release.js", () => ({ TXFLOW_TRADING_ENABLED: true }));
vi.mock("../../exchanges/rate-limiter.js", async orig => ({ ...await orig<typeof import("../../exchanges/rate-limiter.js")>(), acquireRate: async () => {} }));

const { approveTxflowAgentWith, verifyTxflowAgent, txflowAgentWalletName, txflowClient } = await import("../../exchanges/txflow/agent.js");
const { txflowDomain, TXFLOW_APPROVE_AGENT_TYPES } = await import("../../exchanges/txflow/signing.js");
const { importVenueAgent } = await import("../../commands/agent-import.js");
const { getVenueAgent } = await import("../../agent-wallet/store.js");
import type { EvmSigner } from "../../signer/interface.js";
import type { TxflowAgentMeta } from "../../settings.js";

function signerOf(w: ethers.Wallet | ethers.HDNodeWallet): EvmSigner {
  return { getAddress: () => w.address, signTypedData: (d, t, v) => w.signTypedData(d, t, v), signMessage: m => w.signMessage(m) };
}

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, code: 0, data }), { status: 200 });
const executed = () => new Response(JSON.stringify({ status: "ok", code: 0, confirm: "executed", data: { type: "ApproveAgent", data: { statuses: ["success"] } } }), { status: 200 });

interface VenueState {
  eligible: boolean;
  accessReads: number;
  labels: Array<{ agentAddress: string; agentName: string }>;
  owners: Map<string, string>;
  exchange: (body: { action: Record<string, unknown> }) => Response;
  sent: Array<{ action: Record<string, unknown>; nonce: number; signature: { r: string; s: string; v: number } }>;
}
let st: VenueState;
let master: ethers.HDNodeWallet;

beforeEach(() => {
  vault.clear();
  master = ethers.Wallet.createRandom();
  st = {
    eligible: true, accessReads: 0, labels: [], owners: new Map(),
    exchange: b => {
      const a = b.action as { agentAddress: string };
      if (a.agentAddress === ethers.ZeroAddress) for (const [k] of st.owners) st.owners.delete(k);
      else st.owners.set(a.agentAddress.toLowerCase(), master.address);
      return executed();
    },
    sent: [],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith("/exchange")) {
      st.sent.push(b as never);
      return st.exchange(b as never);
    }
    switch (b.type) {
      case "approveAgentEligibility": return ok({ eligible: st.eligible });
      // Undocumented; testnet answers {success:false, code:10000, "invalid request"} for any body
      // (2026-10-27), mainnet HTTP 403. perp-cli must never depend on it.
      case "accountAccessStatus": st.accessReads++; return new Response(JSON.stringify({ success: false, code: 10000, message: "invalid request" }), { status: 200 });
      case "approvedAgents": return ok({ user: b.user, agents: st.labels });
      case "agentOwner": return ok({ agent: String(b.agent).toLowerCase(), user: st.owners.get(String(b.agent).toLowerCase()) ?? null });
      default: throw new Error(`unexpected /info ${String(b.type)}`);
    }
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Approve deps over an in-memory OWS; returns the created agent wallets. */
function deps(saved: TxflowAgentMeta[] = []) {
  const wallets = new Map<string, ethers.HDNodeWallet>();
  return {
    wallets,
    saved,
    d: {
      master: signerOf(master),
      ows: {
        walletExists: (n: string) => wallets.has(n),
        createSigner: (n: string) => { const w = ethers.Wallet.createRandom(); wallets.set(n, w); return signerOf(w); },
        deleteWallet: (n: string) => { wallets.delete(n); },
      },
      client: txflowClient("testnet"),
      saveMeta: (m: TxflowAgentMeta) => { saved.push(m); },
      sleep: async () => {},
    },
  };
}

const opts = (over: Record<string, unknown> = {}) => ({ agentName: "perp-cli-txflow-tn", masterOwsWallet: "main", network: "testnet" as const, replacing: null, ...over });

describe("approve", () => {
  it("master signs ApproveAgent (label = agent name, nonce in action and envelope); agentOwner proves it", async () => {
    const { d, wallets } = deps();
    const meta = await approveTxflowAgentWith(opts(), d);
    const agent = wallets.get(txflowAgentWalletName("main", "testnet"))!;
    expect(meta).toMatchObject({ kind: "txflow", agentName: "perp-cli-txflow-tn", agentAddress: agent.address, accountAddress: master.address, network: "testnet", source: "approved" });
    expect(st.sent).toHaveLength(1);
    const { action, nonce, signature } = st.sent[0];
    expect(action).toEqual({ type: "approveAgent", txflowNetwork: "TxFlow-Testnet", chainId: 2511, apiVersion: 1, agentAddress: agent.address, agentName: "perp-cli-txflow-tn", nonce });
    const digest = TypedDataEncoder.hash(txflowDomain("testnet"), TXFLOW_APPROVE_AGENT_TYPES, {
      txflowNetwork: "TxFlow-Testnet", chainId: 2511, apiVersion: 1, agentAddress: agent.address, agentName: "perp-cli-txflow-tn", nonce,
    });
    expect(recoverAddress(digest, Signature.from(signature))).toBe(master.address);
  });

  it("an unfunded account → DEPOSIT_REQUIRED before any key or signature; access is never pre-read", async () => {
    st.eligible = false;
    const a = deps();
    await expect(approveTxflowAgentWith(opts(), a.d)).rejects.toMatchObject({ structured: { code: "DEPOSIT_REQUIRED" } });
    expect([a.wallets.size, st.sent.length, st.accessReads]).toEqual([0, 0, 0]);
  });

  it("mainnet whitelist: no access pre-read; /exchange decides (whitelist → POLICY_DENIED, key deleted)", async () => {
    st.exchange = () => new Response(JSON.stringify({ status: "err", code: 10000, message: "User not in whitelist" }), { status: 200 });
    const { d, wallets } = deps();
    d.client = txflowClient("mainnet");
    const e = await approveTxflowAgentWith(opts({ network: "mainnet", agentName: "perp-cli-txflow" }), d).catch(x => x);
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.structured.remediation).toMatch(/txflow\.com\/apply/);
    expect(wallets.size).toBe(0);
  });

  it("an existing label is never silently replaced", async () => {
    st.labels = [{ agentAddress: "0x0000000000000000000000000000000000000abc", agentName: "perp-cli-txflow-tn" }];
    const { d, wallets } = deps();
    await expect(approveTxflowAgentWith(opts(), d)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect([wallets.size, st.sent.length]).toEqual([0, 0]);
  });

  it("unknown outcome → the key is kept AND recorded, ORDER_PENDING", async () => {
    st.exchange = () => new Response("<html>bad gateway</html>", { status: 502 });
    const { d, wallets, saved } = deps();
    const e = await approveTxflowAgentWith(opts(), d).catch(x => x);
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(wallets.size).toBe(1);
    expect(saved).toHaveLength(1);
  });

  it("executed but agentOwner never shows it → ORDER_PENDING, kept and recorded", async () => {
    st.exchange = () => executed();
    const { d, saved } = deps();
    await expect(approveTxflowAgentWith(opts(), d)).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(saved).toHaveLength(1);
  });

  it("rotate: the label is rebound to a NEW key (staged wallet name), then the old key is deleted", async () => {
    const { d, wallets } = deps();
    const old = await approveTxflowAgentWith(opts(), d);
    st.labels = [{ agentAddress: old.agentAddress, agentName: old.agentName }];
    const next = await approveTxflowAgentWith(opts({ replacing: old }), d);
    expect(next.agentWalletName).not.toBe(old.agentWalletName);
    expect(next.agentAddress).not.toBe(old.agentAddress);
    expect(wallets.has(old.agentWalletName)).toBe(false);
    expect(wallets.has(next.agentWalletName)).toBe(true);
    expect((st.sent[1].action as { agentName: string }).agentName).toBe(old.agentName);
  });
});

describe("verify", () => {
  it("authorized for its account under its label (no access pre-read)", async () => {
    const agent = "0x00000000000000000000000000000000000a6e47";
    st.owners.set(agent, master.address);
    st.labels = [{ agentAddress: agent, agentName: "bot" }];
    const meta: TxflowAgentMeta = { kind: "txflow", agentName: "bot", agentWalletName: "w", agentAddress: agent, accountAddress: master.address as `0x${string}`, network: "testnet", approvedAt: "", source: "approved" };
    expect(await verifyTxflowAgent(meta)).toEqual({ owner: master.address, authorized: true, label: "bot" });
    st.owners.clear();
    expect(await verifyTxflowAgent(meta)).toEqual({ owner: null, authorized: false, label: null });
    expect(st.accessReads).toBe(0);
  });
});

describe("import (web-app key)", () => {
  const KEY = ethers.Wallet.createRandom().privateKey;
  const AGENT = new ethers.Wallet(KEY).address;
  const base = (extra: Record<string, unknown> = {}) => ({
    venue: "txflow" as const, network: "testnet" as const, agentName: null, masterAddress: null, accountIndex: null, apiKeyIndex: null,
    expiresIn: null, replace: false, secret: { kind: "key" as const, key: KEY }, accountId: null, confirmAccount: null, ...extra,
  });

  it("verified by agentOwner, stored in OWS, recorded as imported for the owner account", async () => {
    st.owners.set(AGENT.toLowerCase(), master.address);
    st.labels = [{ agentAddress: AGENT, agentName: "web" }];
    const o = await importVenueAgent(base());
    expect(o).toMatchObject({ venue: "txflow", source: "imported", agentName: "web-txflow-tn", masterAddress: master.address, agentAddress: AGENT });
    expect(o.verification.method).toMatch(/agentOwner/);
    expect(getVenueAgent("txflow", "web-txflow-tn")).toMatchObject({ kind: "txflow", agentAddress: AGENT, accountAddress: master.address, source: "imported", network: "testnet" });
    expect(vault.has("agent-txflow-import-web-txflow-tn")).toBe(true);
  });

  it("an unauthorized key (or one approved for another account) is refused and nothing is stored; the key never appears in the error", async () => {
    const e = await importVenueAgent(base({ agentName: "x1" })).catch(x => x);
    expect(e.structured.code).toBe("AGENT_NOT_REGISTERED");
    expect(JSON.stringify(e.structured)).not.toContain(KEY.slice(2));
    st.owners.set(AGENT.toLowerCase(), master.address);
    const e2 = await importVenueAgent(base({ agentName: "x2", masterAddress: "0x000000000000000000000000000000000000dEaD" })).catch(x => x);
    expect(e2.structured.code).toBe("AGENT_NOT_REGISTERED");
    expect(getVenueAgent("txflow", "x1")).toBeNull();
    expect(getVenueAgent("txflow", "x2")).toBeNull();
    expect(st.sent).toEqual([]);
  });
});
