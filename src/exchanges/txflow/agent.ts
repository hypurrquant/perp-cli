/**
 * TxFlow agent-key lifecycle (docs.txflow.com/api/exchange/approveAgent).
 *
 * approve (`perp wallet agent approve txflow --master <ows>`):
 *  1. Read-only pre-checks, before anything is created or signed: approveAgentEligibility (the
 *     account exists — first deposit done; else DEPOSIT_REQUIRED) and accountAccessStatus
 *     (`allowExchange: false` → POLICY_DENIED with the apply link). accountAccessStatus is not in
 *     the docs' reference list; it answers on testnet and HTTP 403 "This action is not allowed."
 *     on mainnet (live 2026-10-27), where it is reported as unknown and /exchange stays the
 *     authority.
 *  2. Create OWS wallet `agent-txflow-<master>[-testnet]` (EVM key, empty passphrase — the agent
 *     wallet pattern of HL / RISEx).
 *  3. The MASTER signs ApproveAgent (direct EIP-712) with `agentName` = the perp-cli agent name
 *     (the venue keys agents by this label); POST /exchange with confirm "executed".
 *  4. Prove it with agentOwner(agent) = the account. A definite refusal deletes the new key; an
 *     unknown outcome (or an unproven approval) keeps the key AND its record, so `wallet agent
 *     verify / revoke txflow` can see it (ORDER_PENDING).
 * rotate (`approve --rotate`): approving an EXISTING label rebinds it to the new address and drops
 *   the old one on the venue (docs: "Agents are keyed by label") — the new key is approved first,
 *   then the old local key is deleted.
 * revoke: ApproveAgent with the zero address under the same label (master-signed), proven by
 *   agentOwner(agent) = null.
 * import: a key created in the TxFlow web app; checked with agentOwner before it is stored.
 */

import { getAddress } from "ethers";
import { PerpError, extractErrorMessage } from "../../errors.js";
import type { TxflowAgentMeta } from "../../settings.js";
import type { EvmSigner } from "../../signer/interface.js";
import { networkConfig, getVenue } from "../venue.js";
import type { Network } from "../venue-types.js";
import { TxflowClient, TxflowSendUnknown, TXFLOW_APPLY_URL } from "./client.js";
import { nextTxflowNonce, signTxflowApproveAgent, txflowApproveAgentAction, ZERO_ADDRESS } from "./signing.js";

const CONFIRM_ATTEMPTS = 8;
const CONFIRM_INTERVAL_MS = 1_000;

export function txflowAgentWalletName(masterOwsWallet: string, network: Network): string {
  return network === "testnet" ? `agent-txflow-${masterOwsWallet}-testnet` : `agent-txflow-${masterOwsWallet}`;
}

export function txflowClient(network: Network): TxflowClient {
  const def = getVenue("txflow");
  return new TxflowClient(networkConfig(def, network).restUrl, def.rateLimit);
}

/** agentOwner: the account an agent trades for; null = not an authorized agent of any account. */
export async function txflowAgentOwner(client: TxflowClient, agent: string): Promise<string | null> {
  const d = await client.info<{ user?: unknown }>({ type: "agentOwner", agent });
  if (d === null || typeof d !== "object") throw new PerpError("EXCHANGE_ERROR", "TxFlow agentOwner: no data object", { exchange: "txflow" });
  if (d.user === null || d.user === undefined) return null;
  if (typeof d.user !== "string") throw new PerpError("EXCHANGE_ERROR", "TxFlow agentOwner: user is not an address", { exchange: "txflow" });
  return getAddress(d.user);
}

/** approvedAgents: label → agent address of an account. */
export async function txflowApprovedAgents(client: TxflowClient, account: string): Promise<Array<{ agentAddress: string; agentName: string }>> {
  const d = await client.info<{ agents?: unknown }>({ type: "approvedAgents", user: account });
  if (d === null || typeof d !== "object" || !Array.isArray(d.agents)) throw new PerpError("EXCHANGE_ERROR", "TxFlow approvedAgents: no agents array", { exchange: "txflow" });
  return d.agents.map(a => {
    const x = a as { agentAddress?: unknown; agentName?: unknown };
    if (typeof x.agentAddress !== "string" || typeof x.agentName !== "string") throw new PerpError("EXCHANGE_ERROR", "TxFlow approvedAgents: malformed row", { exchange: "txflow" });
    return { agentAddress: getAddress(x.agentAddress), agentName: x.agentName };
  });
}

/**
 * accountAccessStatus `allowExchange` (testnet answers it; mainnet refuses the read with HTTP 403
 * for every caller → null = unknown, and POST /exchange decides). Any other failure throws.
 */
export async function txflowAccessAllowed(client: TxflowClient, account: string): Promise<boolean | null> {
  let d: { allowExchange?: unknown };
  try {
    d = await client.info<{ allowExchange?: unknown }>({ type: "accountAccessStatus", user: account });
  } catch (e) {
    if (e instanceof PerpError && e.structured.details?.status === 403) return null;
    throw e;
  }
  if (typeof d?.allowExchange !== "boolean") throw new PerpError("EXCHANGE_ERROR", "TxFlow accountAccessStatus: no allowExchange flag", { exchange: "txflow" });
  return d.allowExchange;
}

/** Refuse before anything is created or signed: unfunded account, or access explicitly refused. */
export async function txflowApprovePreflight(client: TxflowClient, network: Network, account: string): Promise<void> {
  const elig = await client.info<{ eligible?: unknown; reason?: unknown }>({ type: "approveAgentEligibility", user: account });
  if (typeof elig?.eligible !== "boolean") throw new PerpError("EXCHANGE_ERROR", "TxFlow approveAgentEligibility: no eligible flag", { exchange: "txflow" });
  if (!elig.eligible) {
    throw new PerpError("DEPOSIT_REQUIRED", `TxFlow account ${account} cannot approve an agent yet${typeof elig.reason === "string" && elig.reason !== "" ? ` (${elig.reason})` : ""} — it is activated by its first deposit`, {
      exchange: "txflow",
      remediation: network === "testnet" ? "Fund the account with test USDC in the TxFlow testnet web app, then retry" : "Deposit USDC in the TxFlow web app, then retry",
    });
  }
  if (await txflowAccessAllowed(client, account) === false) {
    throw new PerpError("POLICY_DENIED", `TxFlow does not allow trading for ${account} (accountAccessStatus allowExchange: false)`, {
      exchange: "txflow", remediation: `Apply for access at ${TXFLOW_APPLY_URL}`,
    });
  }
}

/** Master-signed approveAgent (`agentAddress` zero = revoke the label). Unknown outcome → TxflowSendUnknown. */
export async function sendApproveAgent(client: TxflowClient, network: Network, master: EvmSigner, agentAddress: string, label: string): Promise<void> {
  const nonce = nextTxflowNonce();
  const action = txflowApproveAgentAction(network, agentAddress, label, nonce);
  const signature = await signTxflowApproveAgent(master, network, action);
  await client.exchange({ action: action as unknown as Record<string, unknown>, signature, nonce }, agentAddress === ZERO_ADDRESS ? "agent revoke" : "agent approval", "ACTION_REJECTED", network);
}

/** Run an OWS delete; null on success, else the failure text (callers surface it — never swallowed). */
export function deleteFailure(del: () => void): string | null {
  try {
    del();
    return null;
  } catch (e) {
    return extractErrorMessage(e);
  }
}

/** Poll agentOwner until it shows `expected` (an address, or null for "no account"). */
async function confirmOwner(client: TxflowClient, agent: string, expected: string | null, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    const owner = await txflowAgentOwner(client, agent);
    if ((owner === null && expected === null) || (owner !== null && expected !== null && owner.toLowerCase() === expected.toLowerCase())) return true;
    if (i < CONFIRM_ATTEMPTS - 1) await sleep(CONFIRM_INTERVAL_MS);
  }
  return false;
}

export interface TxflowOwsOps {
  walletExists(name: string): boolean;
  /** Creates an EVM-capable wallet with the empty passphrase; returns its signer. */
  createSigner(name: string): EvmSigner;
  deleteWallet(name: string): void;
}

export interface TxflowApproveDeps {
  master: EvmSigner;
  ows: TxflowOwsOps;
  client: TxflowClient;
  /** Persists the record of a key that is KEPT after an unknown / unproven approval. */
  saveMeta(meta: TxflowAgentMeta): void;
  sleep(ms: number): Promise<void>;
}

export interface ApproveTxflowAgentOpts {
  agentName: string;
  masterOwsWallet: string;
  network: Network;
  /** The record being replaced (--rotate): its label is rebound to the new key, then its key is deleted. */
  replacing: TxflowAgentMeta | null;
}

/** Full approve with the OWS master + a new OWS agent wallet. */
export async function approveTxflowAgent(opts: ApproveTxflowAgentOpts & { passphrase: string | null }): Promise<TxflowAgentMeta> {
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const { loadOws } = await import("../../signer/ows-loader.js");
  const { setVenueAgent } = await import("../../agent-wallet/store.js");
  const ows = loadOws();
  return approveTxflowAgentWith(opts, {
    master: OwsEvmSigner.create(opts.masterOwsWallet, opts.passphrase ?? ""),
    ows: {
      walletExists: name => ows.listWallets().some((w: { name: string }) => w.name === name),
      createSigner: name => {
        const wallet = ows.createWallet(name, "");
        if (!wallet.accounts.some((a: { chainId: string }) => a.chainId.startsWith("eip155:"))) {
          const left = deleteFailure(() => ows.deleteWallet(name));
          throw new PerpError("INVALID_PARAMS", `Agent wallet "${name}" has no EVM account${left === null ? "" : `; deleting it failed (${left}) — it stayed in the OWS vault`}`, {
            remediation: left === null ? "Check OWS vault configuration" : `Check OWS vault configuration, and delete the wallet: ows wallet delete ${name}`,
          });
        }
        return OwsEvmSigner.create(name, "");
      },
      deleteWallet: name => ows.deleteWallet(name),
    },
    client: txflowClient(opts.network),
    saveMeta: meta => setVenueAgent("txflow", meta),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  });
}

/** The approve orchestration (see the module doc). */
export async function approveTxflowAgentWith(opts: ApproveTxflowAgentOpts, deps: TxflowApproveDeps): Promise<TxflowAgentMeta> {
  const { network, agentName, replacing } = opts;
  const net = network === "testnet" ? " -n testnet" : "";
  const { master, ows, client } = deps;
  const account = getAddress(master.getAddress());
  if (replacing !== null && replacing.accountAddress.toLowerCase() !== account.toLowerCase()) {
    throw new PerpError("INVALID_PARAMS", `TxFlow agent "${agentName}" belongs to ${replacing.accountAddress}, not the master ${account}`, {
      remediation: "Use the master wallet of that account (--master), or choose another --agent-name",
    });
  }
  await txflowApprovePreflight(client, network, account);
  const labels = await txflowApprovedAgents(client, account);
  const sameLabel = labels.find(a => a.agentName === agentName);
  if (sameLabel !== undefined && replacing === null) {
    throw new PerpError("INVALID_PARAMS", `TxFlow account ${account} already has an agent labelled "${agentName}" (${sameLabel.agentAddress}); approving it again would replace that key`, {
      remediation: `Choose another --agent-name, or replace it on purpose: perp${net} wallet agent approve txflow --rotate`,
    });
  }

  const base = txflowAgentWalletName(opts.masterOwsWallet, network);
  // A rotation stages the new key under a fresh name while the old key still holds the standard one.
  const agentWalletName = replacing !== null && replacing.agentWalletName === base ? `${base}-${Date.now().toString(36)}` : base;
  if (ows.walletExists(agentWalletName)) {
    throw new PerpError("INVALID_PARAMS", `OWS wallet "${agentWalletName}" already exists but no TxFlow agent record uses it`, {
      remediation: `If no TxFlow agent uses its key, delete it (ows wallet delete ${agentWalletName}) and re-run the approve`,
    });
  }
  const signer = ows.createSigner(agentWalletName);
  const agentAddress = getAddress(signer.getAddress()) as `0x${string}`;
  const meta: TxflowAgentMeta = {
    kind: "txflow", agentName, agentWalletName, agentAddress, accountAddress: account as `0x${string}`,
    network, approvedAt: new Date().toISOString(), source: "approved",
  };
  const verifyHint = `perp${net} wallet agent verify txflow ${agentName}`;
  try {
    await sendApproveAgent(client, network, master, agentAddress, agentName);
  } catch (e) {
    if (e instanceof TxflowSendUnknown) {
      deps.saveMeta(meta);
      throw new PerpError("ORDER_PENDING", `TxFlow agent approval: outcome unknown — ${extractErrorMessage(e.cause)}`, {
        exchange: "txflow", agent: agentAddress,
        remediation: `Do NOT re-run approve yet. Its key is kept in OWS wallet "${agentWalletName}" and recorded; check: ${verifyHint}`,
      });
    }
    const left = deleteFailure(() => ows.deleteWallet(agentWalletName));
    if (left === null) throw e;
    // The refusal stands; the unused key could not be deleted and is reported, never hidden.
    const base = e instanceof PerpError ? e : new PerpError("APPROVE_FAILED", extractErrorMessage(e), { exchange: "txflow" });
    throw new PerpError(base.structured.code, `${base.message} — and deleting the unused new key failed (${left}): it stayed in OWS wallet "${agentWalletName}"`, {
      ...(base.structured.details ?? {}), keyLeftInVault: agentWalletName,
      remediation: `${base.structured.remediation !== undefined ? `${base.structured.remediation}. ` : ""}The key was never approved; delete it: ows wallet delete ${agentWalletName}`,
    });
  }
  if (!(await confirmOwner(client, agentAddress, account, deps.sleep))) {
    deps.saveMeta(meta);
    throw new PerpError("ORDER_PENDING", `TxFlow executed the approval, but agentOwner does not show ${agentAddress} as an agent of ${account} yet`, {
      exchange: "txflow", agent: agentAddress, remediation: `The key is kept and recorded; check again: ${verifyHint}`,
    });
  }
  if (replacing !== null && replacing.agentWalletName !== agentWalletName && ows.walletExists(replacing.agentWalletName)) {
    // The label now points to the new key; the old key is dead on the venue.
    const left = deleteFailure(() => ows.deleteWallet(replacing.agentWalletName));
    if (left !== null) {
      deps.saveMeta(meta); // the new agent is approved and works: keep its record
      throw new PerpError("APPROVE_PARTIAL", `TxFlow agent "${agentName}" was rotated to ${agentAddress} (recorded), but deleting the old key failed (${left}): it stayed in OWS wallet "${replacing.agentWalletName}"`, {
        exchange: "txflow", keyLeftInVault: replacing.agentWalletName,
        remediation: `The old key no longer trades on TxFlow (its label was rebound). Delete it: ows wallet delete ${replacing.agentWalletName}`,
      });
    }
  }
  return meta;
}

/** Revoke a stored agent with the master wallet that owns it (zero address under its label). */
export async function revokeTxflowAgent(opts: { meta: TxflowAgentMeta; masterOwsWallet: string; passphrase: string | null; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const master = OwsEvmSigner.create(opts.masterOwsWallet, opts.passphrase ?? "");
  if (master.getAddress().toLowerCase() !== opts.meta.accountAddress.toLowerCase()) {
    throw new PerpError("INVALID_PARAMS", `Master wallet ${master.getAddress()} does not own TxFlow agent ${opts.meta.agentAddress}`, {
      remediation: `Use the OWS wallet for ${opts.meta.accountAddress}`,
    });
  }
  const client = txflowClient(opts.meta.network);
  const net = opts.meta.network === "testnet" ? " -n testnet" : "";
  try {
    await sendApproveAgent(client, opts.meta.network, master, ZERO_ADDRESS, opts.meta.agentName);
  } catch (e) {
    if (e instanceof TxflowSendUnknown) {
      throw new PerpError("ORDER_PENDING", `TxFlow agent revoke: outcome unknown — ${extractErrorMessage(e.cause)}`, {
        exchange: "txflow", remediation: `The local key is kept. Check: perp${net} wallet agent verify txflow ${opts.meta.agentName}, then revoke again if it is still active`,
      });
    }
    throw new PerpError("APPROVE_FAILED", `TxFlow agent revoke failed: ${extractErrorMessage(e)}`, {
      exchange: "txflow", ...(e instanceof PerpError ? { cause: e.structured } : {}),
      remediation: "The agent key may still be authorized to trade. Retry, or revoke it in the TxFlow web app",
    });
  }
  if (!(await confirmOwner(client, opts.meta.agentAddress, null, opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))))) {
    throw new PerpError("ORDER_PENDING", `TxFlow executed the revoke, but agentOwner still lists ${opts.meta.agentAddress}`, {
      exchange: "txflow", remediation: `The local key is kept. Check: perp${net} wallet agent verify txflow ${opts.meta.agentName}`,
    });
  }
}

/** Verify a stored agent: authorized for its account, listed under its label, and the account's access flag. */
export async function verifyTxflowAgent(meta: TxflowAgentMeta, client: TxflowClient = txflowClient(meta.network)): Promise<{
  owner: string | null; authorized: boolean; label: string | null; accessAllowed: boolean | null;
}> {
  const owner = await txflowAgentOwner(client, meta.agentAddress);
  const authorized = owner !== null && owner.toLowerCase() === meta.accountAddress.toLowerCase();
  const listed = authorized ? (await txflowApprovedAgents(client, meta.accountAddress)).find(a => a.agentAddress.toLowerCase() === meta.agentAddress.toLowerCase()) : undefined;
  return { owner, authorized, label: listed === undefined ? null : listed.agentName, accessAllowed: await txflowAccessAllowed(client, meta.accountAddress) };
}
