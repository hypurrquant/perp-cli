/**
 * Arcus agent (API key) lifecycle.
 *
 * approve:
 *  1. Resolve the master EVM signer from OWS (`masterOwsWallet`).
 *  2. Create or reuse OWS wallet `agent-arcus-<master>` (empty passphrase, same
 *     pattern as Pacifica's `agent-pac-<master>`); its Solana account is the
 *     Ed25519 key. API key = hex(32-byte pubkey decoded from the base58 address).
 *     OWS `signMessage(…, "solana", …)` produces a raw Ed25519 signature over
 *     the given bytes (no prefix) — verified locally against tweetnacl.
 *  3. Sign the `CreateApiKey` EIP-712 typed data with the master wallet.
 *  4. POST /v1/createApiKey (no X-API-Key).
 *  5. Confirm via GET /v1/apiKeys?address= (poll until the key is ACTIVE).
 *  6. Return ArcusAgentMeta — persisting it is the caller's job.
 *
 * revoke: POST /v1/revokeApiKey signed by the same master wallet (EIP-712
 * `RevokeApiKey`). The OWS agent wallet is left in place for the caller.
 */

import bs58 from "bs58";
import { PerpError } from "../../errors.js";
import type { ArcusAgentMeta } from "../../settings.js";
import { loadOws } from "../../signer/ows-loader.js";
import { OwsEvmSigner } from "../../signer/ows-evm.js";
import type { Network } from "../venue-types.js";
import { networkConfig } from "../venue.js";
import { arcusVenue } from "../venues/arcus.js";
import { ArcusClient } from "./client.js";
import { createApiKeyTypedData, nowNs, revokeApiKeyTypedData, splitEvmSignature, type ArcusTypedData } from "./signing.js";

/** Arcus accepts validUntil between 1 and 180 days from server time. */
export const ARCUS_MAX_KEY_DAYS = 180;
const DAY_MS = 86_400_000;
const CONFIRM_ATTEMPTS = 10;
const CONFIRM_INTERVAL_MS = 1_000;

export function arcusAgentWalletName(masterOwsWallet: string): string {
  return `agent-arcus-${masterOwsWallet}`;
}

function signingChainId(network: Network): number {
  const id = networkConfig(arcusVenue, network).signingChainId;
  if (id === null) throw new Error("arcus venue definition is missing signingChainId");
  return id;
}

async function signTyped(signer: OwsEvmSigner, td: ArcusTypedData): Promise<{ r: string; s: string; v: string }> {
  return splitEvmSignature(await signer.signTypedData(td.domain, td.types, td.message));
}

/** Base58 Solana address → 64-hex Ed25519 public key. */
export function ed25519PubHexFromBase58(address: string): string {
  const bytes = bs58.decode(address);
  if (bytes.length !== 32) {
    throw new PerpError("INVALID_PARAMS", `Expected a 32-byte Ed25519 public key, got ${bytes.length} bytes`);
  }
  return Buffer.from(bytes).toString("hex");
}

interface ApiKeyEntry {
  apiKey: string;
  address: string;
  status: string;
  accountIndex?: number;
  allSubaccounts?: boolean;
  validUntil: number;
}

export async function listArcusApiKeys(network: Network, address: string): Promise<ApiKeyEntry[]> {
  const res = await new ArcusClient(network, null).get<{ apiKeys?: unknown }>("/v1/apiKeys", "apiKeys", { address });
  if (!res || !Array.isArray(res.apiKeys)) {
    throw new PerpError("EXCHANGE_ERROR", "Arcus /v1/apiKeys: missing apiKeys array");
  }
  return res.apiKeys as ApiKeyEntry[];
}

function tryDeleteWallet(walletName: string): boolean {
  try {
    loadOws().deleteWallet(walletName);
    return true;
  } catch (err) {
    process.stderr.write(`[warn] failed to clean up orphan wallet "${walletName}": ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

export interface ApproveArcusAgentOpts {
  /** User-facing agent name; also sent as the Arcus `apiWalletName` (1–64 chars). */
  agentName: string;
  masterOwsWallet: string;
  passphrase: string | null;
  /** 0–9 for one subaccount, 255 for all subaccounts. */
  accountIndex: number;
  network: Network;
  /** Key lifetime in days, 1..180. */
  validDays: number;
}

export async function approveArcusAgent(opts: ApproveArcusAgentOpts): Promise<ArcusAgentMeta> {
  const { agentName, masterOwsWallet, passphrase, accountIndex, network, validDays } = opts;
  if (agentName.length === 0 || agentName.length > 64) {
    throw new PerpError("INVALID_PARAMS", "Arcus agent name must be 1–64 characters");
  }
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > ARCUS_MAX_KEY_DAYS) {
    throw new PerpError("INVALID_PARAMS", `Arcus key lifetime must be 1–${ARCUS_MAX_KEY_DAYS} days (got ${validDays})`);
  }
  if (!(Number.isInteger(accountIndex) && ((accountIndex >= 0 && accountIndex <= 9) || accountIndex === 255))) {
    throw new PerpError("INVALID_PARAMS", `Arcus accountIndex must be 0–9 or 255 (got ${accountIndex})`);
  }

  // 1. master
  const master = OwsEvmSigner.create(masterOwsWallet, passphrase ?? undefined);
  const ownerAddress = master.getAddress().toLowerCase() as `0x${string}`;

  // 2. agent wallet (create or reuse)
  const ows = loadOws();
  const agentWalletName = arcusAgentWalletName(masterOwsWallet);
  const existing = ows.listWallets().find((w: { name: string }) => w.name === agentWalletName);
  const created = existing === undefined;
  const wallet = existing ?? ows.createWallet(agentWalletName, "");
  const sol = wallet.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"));
  if (!sol) {
    if (created) tryDeleteWallet(agentWalletName);
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no Solana (Ed25519) account`, {
      remediation: "Check OWS vault configuration",
    });
  }
  const apiKeyHex = ed25519PubHexFromBase58(sol.address);

  // 3. EIP-712 CreateApiKey
  const validUntilMs = Date.now() + validDays * DAY_MS;
  const nonce = nowNs().toString(); // Unix-ns string, single-use per (address, accountIndex)
  const chainId = signingChainId(network);
  const signature = await signTyped(master, createApiKeyTypedData({
    chainId, apiWalletName: agentName, publicKeyHex: apiKeyHex, validUntilMs, accountIndex, nonce,
  }));

  // 4. register
  const client = new ArcusClient(network, null);
  try {
    await client.postUnsigned("/v1/createApiKey", "createApiKey", {
      address: ownerAddress,
      publicKey: apiKeyHex,
      apiWalletName: agentName,
      accountIndex,
      validUntil: validUntilMs,
      nonce,
      signature,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof PerpError && err.structured.code === "ORDER_PENDING") {
      // The request may have registered the key: deleting the wallet would orphan an active
      // venue API key whose private key no longer exists anywhere. Keep it and say so.
      throw new PerpError("ORDER_PENDING", `Arcus createApiKey outcome unknown: ${msg}`, {
        exchange: "arcus",
        cause: err.structured,
        agentWalletName,
        apiKeyHex,
        remediation: `Do NOT re-run approve yet — the key ${apiKeyHex} may already be registered. The agent wallet "${agentWalletName}" was KEPT (it holds that key). ` +
          `Check the account's API keys on Arcus (perp wallet agent list arcus, or the Arcus UI), then re-run: perp wallet agent approve arcus --master ${masterOwsWallet}`,
      });
    }
    const cleanupOk = created ? tryDeleteWallet(agentWalletName) : true;
    throw new PerpError("APPROVE_FAILED", `Arcus createApiKey failed: ${msg}`, {
      cause: err instanceof PerpError ? err.structured : undefined,
      remediation: cleanupOk
        ? `Fix the cause above and retry: perp wallet agent approve arcus --master ${masterOwsWallet}`
        : `Delete the orphan OWS wallet "${agentWalletName}" manually, then retry`,
    });
  }

  // 5. confirm
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    const keys = await listArcusApiKeys(network, ownerAddress);
    const hit = keys.find(k => k.apiKey.toLowerCase() === apiKeyHex && k.status === "ACTIVE");
    if (hit) {
      return {
        kind: "arcus",
        agentName,
        agentWalletName,
        apiKeyHex,
        accountIndex,
        ownerAddress,
        validUntil: new Date(validUntilMs).toISOString(),
        network,
        approvedAt: new Date().toISOString(),
      };
    }
    await new Promise(r => setTimeout(r, CONFIRM_INTERVAL_MS));
  }
  throw new PerpError("APPROVE_PARTIAL", "Arcus accepted createApiKey but the key is not listed as ACTIVE yet", {
    remediation: `Check GET /v1/apiKeys?address=${ownerAddress} for key ${apiKeyHex}, then re-run the approve command (re-registering an owned key is allowed)`,
  });
}

export interface RevokeArcusAgentOpts {
  meta: ArcusAgentMeta;
  masterOwsWallet: string;
  passphrase: string | null;
  network: Network;
}

/** Revoke the key on Arcus. Throws on rejection (a 404 means the key is not registered to this owner). */
export async function revokeArcusAgent(opts: RevokeArcusAgentOpts): Promise<void> {
  const { meta, masterOwsWallet, passphrase, network } = opts;
  const master = OwsEvmSigner.create(masterOwsWallet, passphrase ?? undefined);
  if (master.getAddress().toLowerCase() !== meta.ownerAddress.toLowerCase()) {
    throw new PerpError("INVALID_PARAMS", `Master wallet ${master.getAddress()} does not own Arcus key ${meta.apiKeyHex}`, {
      remediation: `Use the OWS wallet for ${meta.ownerAddress}`,
    });
  }
  const nonce = nowNs().toString(); // Unix-ns string, single-use per (address, accountIndex)
  const signature = await signTyped(master, revokeApiKeyTypedData({
    chainId: signingChainId(network),
    apiWalletName: meta.agentName,
    publicKeyHex: meta.apiKeyHex,
    accountIndex: meta.accountIndex,
    nonce,
  }));
  await new ArcusClient(network, null).postUnsigned("/v1/revokeApiKey", "revokeApiKey", {
    address: meta.ownerAddress,
    publicKey: meta.apiKeyHex,
    apiWalletName: meta.agentName,
    accountIndex: meta.accountIndex,
    nonce,
    signature,
  });
}
