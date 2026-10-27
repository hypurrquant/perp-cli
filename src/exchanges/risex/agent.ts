/**
 * RISEx session signer lifecycle.
 *
 * approve (`perp wallet agent approve risex --master <ows>`):
 *  1. Create OWS wallet `agent-risex-<master>[-testnet]` (EVM key, empty passphrase — the agent
 *     wallet pattern of HL / Arcus).
 *  2. Pre-check the master's RISE-chain gas BEFORE registering (the restriction below is an
 *     on-chain transaction from the master; a signer that could not be restricted is never left
 *     registered on purpose).
 *  3. Master signs RegisterSigner, the signer signs VerifySigner (same nonce pair), POST
 *     /v1/auth/register-signer; poll session-key-status until Active.
 *  4. Restrict ON-CHAIN to trading only (owner decision 2026-10-13): for every permission except
 *     RISEX_TRADING_PERMISSION the SIGNER signs DisablePermission (the contract only accepts the
 *     signer's own signature for giving up a permission — verified by eth_call on testnet
 *     2026-10-14: a master-signed DisablePermission reverts InvalidSignerSignature) and the MASTER
 *     wallet sends Authorization.disablePermission(...) as an on-chain transaction (its signature;
 *     needs RISE-chain ETH for gas). Re-enabling needs an EnablePermission signed by the ACCOUNT
 *     (a signer-signed one reverts), so a leaked signer key cannot undo the restriction.
 *  5. Prove it (assertTradingOnlyOnChain): the reviewed Authorization implementation, no permission
 *     id ≥5, and the raw sessionKeys bitmap's permission bits 0..4 equal exactly {2}. Bits 5–31 of a new
 *     signer's bitmap (0xffffffff) cannot be cleared (ids ≥5 are rejected at ABI decoding) and map to
 *     no permission; the pin + probe refuse trading the moment that changes.
 *  A signer that is not Active after polling, or that fails 4–5, is revoked (master-signed, gasless
 *  REST) and its key deleted (APPROVE_FAILED). Every exit that KEEPS a key (unknown register outcome,
 *  failed revoke) records its meta with permissions.tradingOnly false, so `wallet agent verify /
 *  revoke risex` can see it while the adapter refuses to trade with it (POLICY_DENIED).
 *
 * revoke: master signs RevokeSigner; POST /v1/auth/revoke-signer.
 */

import { getAddress, type Transaction } from "ethers";
import { PerpError, extractErrorMessage } from "../../errors.js";
import { assertRpcChainId, evmProvider, sendMasterTx } from "../../evm-master-tx.js";
import type { RisexAgentMeta } from "../../settings.js";
import type { EvmSigner } from "../../signer/interface.js";
import type { Network } from "../venue-types.js";
import { RisexSendUnknown, type RisexClient } from "./client.js";
import { risexClient } from "./public.js";
import { allocateAccountNonce, assertReviewedContracts, assertTradingOnlyOnChain, chainReader, loadSigningContext, type RisexChainReader, type RisexSigningContext } from "./session.js";
import {
  RISEX_AUTH_IFACE, RISEX_NON_TRADING_PERMISSIONS, RISEX_PERMISSION_IDS, RISEX_PINS, RISEX_TRADING_PERMISSION, signChecked,
  type NonceSlot,
} from "./typed-data.js";

export const RISEX_SIGNER_MESSAGE = "perp-cli signer";
export const RISEX_DEFAULT_EXPIRY_DAYS = 30;
const STATUS_ACTIVE = 1;
const CONFIRM_ATTEMPTS = 15;
const CONFIRM_INTERVAL_MS = 1_000;
/** Pre-check budget per DisablePermission transaction (gas units); the send re-checks exactly. */
const RESTRICT_GAS_BUDGET = 300_000n;

export function risexAgentWalletName(masterOwsWallet: string, network: Network): string {
  return network === "testnet" ? `agent-risex-${masterOwsWallet}-testnet` : `agent-risex-${masterOwsWallet}`;
}

export async function sessionKeyStatus(client: RisexClient, account: string, signer: string): Promise<number | null> {
  const d = await client.get<{ status?: unknown }>("/v1/auth/session-key-status", { account: account.toLowerCase(), signer: signer.toLowerCase() });
  return typeof d.status === "number" ? d.status : null;
}

/** Master + signer typed-data signatures and the register request. Unknown outcome → ORDER_PENDING. */
export async function registerSigner(p: {
  client: RisexClient; network: Network; ctx: RisexSigningContext; master: EvmSigner; signer: EvmSigner; expiration: number; nonceDir?: string;
}): Promise<{ txHash: string | null }> {
  const account = getAddress(p.master.getAddress());
  const signer = getAddress(p.signer.getAddress());
  const slot = await allocateAccountNonce(p.client, p.network, account, p.nonceDir);
  const accountSignature = await signChecked(p.master, p.ctx.domain, "RegisterSigner", {
    account, signer, message: RISEX_SIGNER_MESSAGE, expiration: p.expiration, nonceAnchor: slot.anchor, nonceBitmap: slot.bit,
  });
  const signerSignature = await signChecked(p.signer, p.ctx.domain, "VerifySigner", { account, nonceAnchor: slot.anchor, nonceBitmap: slot.bit });
  try {
    const res = await p.client.post<{ transaction_hash?: unknown; success?: unknown }>("/v1/auth/register-signer", {
      account, signer, message: RISEX_SIGNER_MESSAGE, expiration: String(p.expiration),
      nonce_anchor: slot.anchor.toString(), nonce_bitmap_index: slot.bit,
      account_signature: accountSignature, signer_signature: signerSignature,
    }, "register-signer");
    if (res.success !== true) {
      throw new PerpError("APPROVE_FAILED", `RISEx register-signer answered success=${String(res.success)}`, { exchange: "risex" });
    }
    return { txHash: typeof res.transaction_hash === "string" && res.transaction_hash !== "" ? res.transaction_hash : null };
  } catch (e) {
    if (e instanceof RisexSendUnknown) {
      throw new PerpError("ORDER_PENDING", `RISEx register-signer outcome unknown: ${extractErrorMessage(e.cause)}`, {
        exchange: "risex", signer,
        remediation: `Do NOT re-run approve yet. Check perp${p.network === "testnet" ? " -n testnet" : ""} wallet agent verify risex, or the signer list in the RISEx app; revoke ${signer} there if it shows up unrestricted`,
      });
    }
    throw e;
  }
}

/** Master-signed RevokeSigner over REST (gasless). */
export async function revokeSigner(p: { client: RisexClient; network: Network; ctx: RisexSigningContext; master: EvmSigner; signer: string; nonceDir?: string }): Promise<{ txHash: string | null }> {
  const account = getAddress(p.master.getAddress());
  const signer = getAddress(p.signer);
  const slot = await allocateAccountNonce(p.client, p.network, account, p.nonceDir);
  const accountSignature = await signChecked(p.master, p.ctx.domain, "RevokeSigner", { account, signer, nonceAnchor: slot.anchor, nonceBitmap: slot.bit });
  try {
    const res = await p.client.post<{ transaction_hash?: unknown; success?: unknown }>("/v1/auth/revoke-signer", {
      account, signer, nonce_anchor: slot.anchor.toString(), nonce_bitmap_index: slot.bit, account_signature: accountSignature,
    }, "revoke-signer");
    if (res.success !== true) throw new PerpError("ACTION_REJECTED", `RISEx revoke-signer answered success=${String(res.success)}`, { exchange: "risex" });
    return { txHash: typeof res.transaction_hash === "string" && res.transaction_hash !== "" ? res.transaction_hash : null };
  } catch (e) {
    if (e instanceof RisexSendUnknown) {
      throw new PerpError("ORDER_PENDING", `RISEx revoke-signer outcome unknown: ${extractErrorMessage(e.cause)}`, {
        exchange: "risex", signer, remediation: "Check the signer status (perp wallet agent verify risex) before retrying",
      });
    }
    throw e;
  }
}

/** Sends one signed disablePermission transaction from the master; resolves with the tx hash once mined successfully. */
export type DisablePermissionSender = (permission: number, slot: NonceSlot, signature: string) => Promise<string>;

/**
 * Restrict an ACTIVE signer to the trading permission and prove the final on-chain state.
 * Returns the permissions disabled by this call (ids whose bitmap bit is already clear are skipped).
 */
export async function restrictSignerToTrading(p: {
  client: RisexClient; network: Network; ctx: RisexSigningContext; account: string; signer: EvmSigner;
  chain: RisexChainReader; send: DisablePermissionSender; nonceDir?: string;
}): Promise<{ disabled: Array<{ permission: number; txHash: string }>; verifiedAt: string }> {
  const account = getAddress(p.account);
  const signer = getAddress(p.signer.getAddress());
  const disabled: Array<{ permission: number; txHash: string }> = [];
  // Skip / order from the raw bitmap (the source of the final proof), id 0 last: on the reviewed
  // implementation hasPermission(1) also needs bit 0 — testnet 2026-10-28, after disabling 0,
  // hasPermission(1) read false with bit 1 still set, so a hasPermission skip left id 1 enabled.
  for (const permission of [...RISEX_NON_TRADING_PERMISSIONS].sort((a, b) => b - a)) {
    const { bitmap } = await p.chain.sessionKey(account, signer);
    if (((bitmap >> BigInt(permission)) & 1n) === 0n) continue;
    const slot = await allocateAccountNonce(p.client, p.network, account, p.nonceDir);
    const signature = await signChecked(p.signer, p.ctx.domain, "DisablePermission", {
      account, signer, permission, nonceAnchor: slot.anchor, nonceBitmap: slot.bit,
    });
    disabled.push({ permission, txHash: await p.send(permission, slot, signature) });
  }
  // The final state is proven from the raw bitmap (plus the implementation pin and the "no id ≥5"
  // probe), not just per-id reads; anything else fails the approve (→ auto-revoke by the caller).
  try {
    await assertTradingOnlyOnChain(p.chain, p.network, account, signer);
  } catch (e) {
    if (e instanceof PerpError && e.structured.code === "POLICY_DENIED") {
      throw new PerpError("APPROVE_FAILED", e.message, { ...(e.structured.details ?? {}), exchange: "risex" });
    }
    throw e;
  }
  return { disabled, verifiedAt: new Date().toISOString() };
}

/** Master-wallet transaction sender for disablePermission on the pinned Authorization contract. */
export function masterDisablePermissionSender(network: Network, master: EvmSigner & { signTransaction(tx: Transaction): Promise<string> }, signer: string): DisablePermissionSender {
  const pin = RISEX_PINS[network];
  if (pin.rpcUrl === null) throw new PerpError("NOT_IMPLEMENTED", `RISEx ${network} has no known RPC endpoint`, { exchange: "risex" });
  const rpc = evmProvider(pin.rpcUrl, pin.chainId);
  const account = getAddress(master.getAddress());
  return async (permission, slot, signature) => {
    await assertRpcChainId(rpc, pin.rpcUrl as string, pin.chainId, "risex");
    const { txHash } = await sendMasterTx(rpc, {
      venue: "risex", chainLabel: `RISE chain (${pin.chainId})`, chainId: pin.chainId, from: account, to: pin.auth,
      data: RISEX_AUTH_IFACE.encodeFunctionData("disablePermission", [account, getAddress(signer), slot.anchor, slot.bit, permission, signature]),
      value: 0n, label: `disable signer permission ${permission}`,
    }, tx => master.signTransaction(tx));
    return txHash;
  };
}

/** Refuse before registering when the master cannot pay for the restriction transactions. */
export async function assertRestrictGas(network: Network, account: string): Promise<void> {
  const pin = RISEX_PINS[network];
  if (pin.rpcUrl === null) throw new PerpError("NOT_IMPLEMENTED", `RISEx ${network} has no known RPC endpoint`, { exchange: "risex" });
  const rpc = evmProvider(pin.rpcUrl, pin.chainId);
  await assertRpcChainId(rpc, pin.rpcUrl, pin.chainId, "risex");
  const fee = await rpc.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  if (price === null) throw new PerpError("EXCHANGE_ERROR", "RISE chain RPC returned no fee data — nothing was signed", { exchange: "risex" });
  const need = price * RESTRICT_GAS_BUDGET * BigInt(RISEX_NON_TRADING_PERMISSIONS.length);
  const have = await rpc.getBalance(account);
  if (have < need) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Restricting a RISEx signer to trading-only needs up to ${need} wei of RISE-chain ETH for gas (${RISEX_NON_TRADING_PERMISSIONS.length} on-chain transactions from ${account}); the wallet has ${have} — nothing was registered`, {
      exchange: "risex",
      remediation: `Send a little ETH on RISE chain (chainId ${pin.chainId}) to ${account}, then retry: perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve risex`,
    });
  }
}

export interface ApproveRisexAgentOpts {
  agentName: string;
  masterOwsWallet: string;
  passphrase: string | null;
  network: Network;
  expiresAt: Date;
}

/** OWS operations the approve flow needs (the vault in production, a fake in tests). */
export interface RisexOwsOps {
  walletExists(name: string): boolean;
  /** Creates an EVM-capable wallet with the empty passphrase; returns its signer. */
  createSigner(name: string): EvmSigner;
  deleteWallet(name: string): void;
}

/** Everything approve touches, injectable for tests. */
export interface RisexApproveDeps {
  master: EvmSigner;
  ows: RisexOwsOps;
  client: RisexClient;
  chain: RisexChainReader;
  /** Sender of the master's disablePermission transactions for `signer`. */
  sender(signer: string): DisablePermissionSender;
  /** Refuses before anything is registered when the master cannot pay the restriction gas. */
  assertGas(account: string): Promise<void>;
  /**
   * Persists the meta of a signer whose key is KEPT after a failure (permissions.tradingOnly false),
   * so `wallet agent verify / revoke risex` can see it. The adapter refuses such a signer.
   */
  saveMeta(meta: RisexAgentMeta): void;
  sleep(ms: number): Promise<void>;
  nonceDir?: string;
}

/**
 * Checks that refuse without side effects (signing context pins, maintenance, the master's gas):
 * run before registering — and, for --rotate, before the old signer is revoked.
 */
export async function risexApprovePreflight(network: Network, client: RisexClient, chain: RisexChainReader, account: string, assertGas: (a: string) => Promise<void>): Promise<RisexSigningContext> {
  const ctx = await loadSigningContext(client, network);
  // The reviewed contracts (implementation pins, no permission id ≥5) before anything is registered.
  await assertReviewedContracts(chain, network);
  await assertGas(account);
  return ctx;
}

/** --rotate: the side-effect-free checks for the NEW signer, run before the old one is revoked. */
export async function risexRotatePreflight(masterOwsWallet: string, passphrase: string | null, network: Network): Promise<void> {
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const account = getAddress(OwsEvmSigner.create(masterOwsWallet, passphrase ?? "").getAddress());
  await risexApprovePreflight(network, risexClient(network), chainReader(network), account, a => assertRestrictGas(network, a));
}

/** Full approve with OWS master + OWS agent wallet. Returns the meta of a trading-only signer (the caller persists it). */
export async function approveRisexAgent(opts: ApproveRisexAgentOpts): Promise<RisexAgentMeta> {
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const { loadOws } = await import("../../signer/ows-loader.js");
  const { setVenueAgent } = await import("../../agent-wallet/store.js");
  const master = OwsEvmSigner.create(opts.masterOwsWallet, opts.passphrase ?? "");
  const ows = loadOws();
  return approveRisexAgentWith(opts, {
    master,
    ows: {
      walletExists: name => ows.listWallets().some((w: { name: string }) => w.name === name),
      createSigner: name => {
        const wallet = ows.createWallet(name, "");
        if (!wallet.accounts.some((a: { chainId: string }) => a.chainId.startsWith("eip155:"))) {
          try { ows.deleteWallet(name); } catch { /* reported below */ }
          throw new PerpError("INVALID_PARAMS", `Agent wallet "${name}" has no EVM account`, { remediation: "Check OWS vault configuration" });
        }
        return OwsEvmSigner.create(name, "");
      },
      deleteWallet: name => ows.deleteWallet(name),
    },
    client: risexClient(opts.network),
    chain: chainReader(opts.network),
    sender: signer => masterDisablePermissionSender(opts.network, master, signer),
    assertGas: account => assertRestrictGas(opts.network, account),
    saveMeta: meta => setVenueAgent("risex", meta),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  });
}

/** The approve orchestration (see the module doc). */
export async function approveRisexAgentWith(opts: ApproveRisexAgentOpts, deps: RisexApproveDeps): Promise<RisexAgentMeta> {
  const { network, expiresAt } = opts;
  const net = network === "testnet" ? " -n testnet" : "";
  const expiration = Math.floor(expiresAt.getTime() / 1000);
  if (!(expiration > Math.floor(Date.now() / 1000) + 60) || expiration > 0xffffffff) {
    throw new PerpError("INVALID_PARAMS", `RISEx signer expiry ${expiresAt.toISOString()} must be in the future (uint32 seconds)`, { remediation: "Use e.g. --expires-in 30d" });
  }
  const { master, ows, client } = deps;
  const account = getAddress(master.getAddress());

  // Everything that can refuse without side effects runs first.
  const ctx = await risexApprovePreflight(network, client, deps.chain, account, deps.assertGas);

  const agentWalletName = risexAgentWalletName(opts.masterOwsWallet, network);
  if (ows.walletExists(agentWalletName)) {
    throw new PerpError("INVALID_PARAMS", `OWS wallet "${agentWalletName}" already exists`, {
      remediation: `Replace the existing signer: perp${net} wallet agent approve risex --rotate (or delete an orphan wallet: ows wallet delete ${agentWalletName})`,
    });
  }
  const signer = ows.createSigner(agentWalletName);
  const signerAddress = getAddress(signer.getAddress());
  const dropWallet = () => { try { ows.deleteWallet(agentWalletName); } catch { /* the remediation names the wallet */ } };
  const metaOf = (tradingOnly: boolean, disabled: number[], verifiedAt: string | null): RisexAgentMeta => ({
    kind: "risex", agentName: opts.agentName, agentWalletName,
    signerAddress: signerAddress as `0x${string}`, accountAddress: account as `0x${string}`,
    expiresAt: new Date(expiration * 1000).toISOString(),
    permissions: { tradingOnly, disabled, verifiedAt },
    network, approvedAt: new Date().toISOString(), source: "approved",
  });
  const verifyHint = `perp${net} wallet agent verify risex ${opts.agentName}`;
  const revokeHint = `perp${net} wallet agent revoke risex ${opts.agentName}`;
  /** A kept key is always recorded (not trading-only → the adapter refuses it). */
  const keep = (disabled: number[]) => deps.saveMeta(metaOf(false, disabled, null));
  /** Revoke after a failure; true = proven revoked (key dropped), false = could not (key + meta kept). */
  const revokeAfterFailure = async (disabled: number[]): Promise<{ revoked: true } | { revoked: false; why: string }> => {
    try {
      await revokeSigner({ client, network, ctx: await loadSigningContext(client, network), master, signer: signerAddress, nonceDir: deps.nonceDir });
      dropWallet();
      return { revoked: true };
    } catch (revokeErr) {
      keep(disabled);
      return { revoked: false, why: extractErrorMessage(revokeErr) };
    }
  };

  try {
    await registerSigner({ client, network, ctx, master, signer, expiration, nonceDir: deps.nonceDir });
  } catch (e) {
    if (e instanceof PerpError && e.structured.code === "ORDER_PENDING") {
      // Unknown outcome: the signer may be registered — keep its key AND record it.
      keep([]);
      throw new PerpError("ORDER_PENDING", e.message, {
        ...(e.structured.details ?? {}), exchange: "risex", signer: signerAddress,
        remediation: `Do NOT re-run approve yet. Check ${verifyHint}; if it is registered it is NOT restricted (full permissions): revoke it with ${revokeHint}`,
      });
    }
    dropWallet();
    throw e;
  }

  // A failed status read is treated like "not Active": the signer is registered (or may be) with
  // FULL permissions, so it is never left behind unrecorded and unrevoked.
  let status: number | null = null;
  let readError: string | null = null;
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    try {
      status = await sessionKeyStatus(client, account, signerAddress);
      readError = null;
    } catch (e) {
      status = null;
      readError = extractErrorMessage(e);
    }
    if (status === STATUS_ACTIVE) break;
    await deps.sleep(CONFIRM_INTERVAL_MS);
  }
  if (status !== STATUS_ACTIVE) {
    const what = readError !== null ? `its status could not be read (${readError})` : `it did not become Active (status ${String(status)})`;
    // It may still activate with FULL permissions: revoke it now (gasless, master-signed).
    const r = await revokeAfterFailure([]);
    if (r.revoked) {
      throw new PerpError("APPROVE_FAILED", `RISEx signer ${signerAddress}: ${what}; it was revoked and its key deleted`, {
        exchange: "risex", remediation: `Retry: perp${net} wallet agent approve risex`,
      });
    }
    throw new PerpError("APPROVE_PARTIAL", `RISEx signer ${signerAddress}: ${what}, and the automatic revoke failed (${r.why})`, {
      exchange: "risex",
      remediation: `It may activate with FULL permissions. Revoke it: ${revokeHint} (or in the RISEx app). Its key is kept in OWS wallet "${agentWalletName}" and recorded as NOT trading-only`,
    });
  }

  let restricted: { disabled: Array<{ permission: number; txHash: string }>; verifiedAt: string };
  const disabledSoFar: number[] = [];
  try {
    const send = deps.sender(signerAddress);
    restricted = await restrictSignerToTrading({
      client, network, ctx, account, signer, chain: deps.chain, nonceDir: deps.nonceDir,
      send: async (permission, slot, signature) => {
        const h = await send(permission, slot, signature);
        disabledSoFar.push(permission);
        return h;
      },
    });
  } catch (e) {
    const why = extractErrorMessage(e);
    const r = await revokeAfterFailure(disabledSoFar);
    if (!r.revoked) {
      throw new PerpError("APPROVE_PARTIAL", `RISEx signer ${signerAddress} was registered but could NOT be restricted to trading-only (${why}) and the automatic revoke failed (${r.why})`, {
        exchange: "risex",
        remediation: `The signer may hold FULL permissions (including fund movement). Revoke it now: ${revokeHint} (or in the RISEx app). Its key is kept in OWS wallet "${agentWalletName}" and recorded as NOT trading-only`,
      });
    }
    throw new PerpError("APPROVE_FAILED", `RISEx signer could not be restricted to trading-only (${why}); it was revoked and its key deleted`, {
      exchange: "risex", cause: e instanceof PerpError ? e.structured : undefined,
      remediation: `Fix the cause above (e.g. RISE-chain ETH for gas on the master wallet), then retry: perp${net} wallet agent approve risex`,
    });
  }

  return metaOf(true, RISEX_NON_TRADING_PERMISSIONS.slice(), restricted.verifiedAt);
}

/** Venue status of a stored signer (1 = Active, 3 = Revoked; anything else = not registered). */
export async function risexSignerStatus(meta: RisexAgentMeta): Promise<number | null> {
  return sessionKeyStatus(risexClient(meta.network), meta.accountAddress, meta.signerAddress);
}

/** Revoke a stored signer with the master wallet that owns it. */
export async function revokeRisexAgent(opts: { meta: RisexAgentMeta; masterOwsWallet: string; passphrase: string | null }): Promise<{ txHash: string | null }> {
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const master = OwsEvmSigner.create(opts.masterOwsWallet, opts.passphrase ?? "");
  if (master.getAddress().toLowerCase() !== opts.meta.accountAddress.toLowerCase()) {
    throw new PerpError("INVALID_PARAMS", `Master wallet ${master.getAddress()} does not own RISEx signer ${opts.meta.signerAddress}`, {
      remediation: `Use the OWS wallet for ${opts.meta.accountAddress}`,
    });
  }
  const client = risexClient(opts.meta.network);
  const ctx = await loadSigningContext(client, opts.meta.network);
  return revokeSigner({ client, network: opts.meta.network, ctx, master, signer: opts.meta.signerAddress });
}

/** Verify a stored signer: Active on the venue and trading-only on-chain. */
export async function verifyRisexAgent(meta: RisexAgentMeta, chain: RisexChainReader = chainReader(meta.network)): Promise<{
  status: number | null; active: boolean; permissions: Record<number, boolean>; bitmap: string | null;
  tradingOnly: boolean; reason: string | null; expired: boolean;
}> {
  const client = risexClient(meta.network);
  const status = await sessionKeyStatus(client, meta.accountAddress, meta.signerAddress);
  const permissions: Record<number, boolean> = {};
  for (const p of RISEX_PERMISSION_IDS) permissions[p] = await chain.hasPermission(meta.accountAddress, meta.signerAddress, p);
  let tradingOnly = true;
  let reason: string | null = null;
  let bitmap: string | null = null;
  try {
    bitmap = `0x${(await assertTradingOnlyOnChain(chain, meta.network, meta.accountAddress, meta.signerAddress)).bitmap.toString(16)}`;
  } catch (e) {
    if (!(e instanceof PerpError && e.structured.code === "POLICY_DENIED")) throw e;
    tradingOnly = false;
    reason = e.message;
    const b = e.structured.details?.bitmap;
    bitmap = typeof b === "string" ? b : null;
  }
  // Per-id reads must agree with the bitmap verdict (belt and braces).
  if (!RISEX_PERMISSION_IDS.every(p => permissions[p] === (p === RISEX_TRADING_PERMISSION))) tradingOnly = false;
  return { status, active: status === STATUS_ACTIVE, permissions, bitmap, tradingOnly, reason, expired: !(Date.parse(meta.expiresAt) > Date.now()) };
}
