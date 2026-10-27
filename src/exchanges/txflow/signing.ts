/**
 * TxFlow signing — docs https://docs.txflow.com/api/signing (test vectors reproduced byte for
 * byte in src/__tests__/exchanges/txflow-signing.test.ts).
 *
 * Two flows, one EIP-712 domain per network:
 *   EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
 *   mainnet "TxFlow-Mainnet" / chainId 869, testnet "TxFlow-Testnet" / chainId 2511, version "1",
 *   verifyingContract = zero address.
 *
 *  - Agent signing (every trading action, signed by the AGENT key):
 *      connectionId = keccak256(msgpack(action without `type`) ‖ nonce u64 BE ‖ 0x00)
 *      Agent(string txflowNetwork,uint32 chainId,uint32 apiVersion,bytes32 connectionId)
 *    The msgpack map keeps the node's key order (each action's request example) and omits
 *    null optional fields; prices / sizes are strings hashed exactly as written; integers use the
 *    most compact encoding (@msgpack/msgpack does). perp-cli never trades for a vault, so the
 *    vault flag is always 0x00.
 *  - Direct EIP-712 (signed by the MASTER key): only approveAgent here —
 *      ApproveAgent(string txflowNetwork,uint32 chainId,uint32 apiVersion,address agentAddress,string agentName,uint64 nonce)
 *    The nonce is inside the action and repeated in the envelope.
 *
 * Every signature is checked before it leaves this module: canonical low-S (the node rejects
 * high-S) and recovering to the signer's own address. Signatures are never logged.
 */

import { PerpError } from "../../errors.js";
import type { EvmSigner } from "../../signer/interface.js";
import type { Network } from "../venue-types.js";

/** Signing `apiVersion` (EIP-712 domain `version` as a decimal string). Docs: Networks table. */
export const TXFLOW_SIGNING_API_VERSION = 1;

export const TXFLOW_SIGNING_NETWORK: Readonly<Record<Network, { txflowNetwork: string; chainId: number }>> = {
  mainnet: { txflowNetwork: "TxFlow-Mainnet", chainId: 869 },
  testnet: { txflowNetwork: "TxFlow-Testnet", chainId: 2511 },
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** secp256k1 n / 2 — a signature with s above it is non-canonical (rejected by the node). */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface TxflowSignature { r: string; s: string; v: number }

export function txflowDomain(net: Network): { name: string; version: string; chainId: number; verifyingContract: string } {
  const n = TXFLOW_SIGNING_NETWORK[net];
  return { name: n.txflowNetwork, version: String(TXFLOW_SIGNING_API_VERSION), chainId: n.chainId, verifyingContract: ZERO_ADDRESS };
}

export const TXFLOW_AGENT_TYPES = {
  Agent: [
    { name: "txflowNetwork", type: "string" },
    { name: "chainId", type: "uint32" },
    { name: "apiVersion", type: "uint32" },
    { name: "connectionId", type: "bytes32" },
  ],
};

export const TXFLOW_APPROVE_AGENT_TYPES = {
  ApproveAgent: [
    { name: "txflowNetwork", type: "string" },
    { name: "chainId", type: "uint32" },
    { name: "apiVersion", type: "uint32" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
};

// ── Actions (key order = the node's order; null optional fields are omitted) ──

export type TxflowTif = "Gtc" | "Ioc" | "Alo";

/**
 * `tpsl` is "" on a standalone trigger (grouping normalTrigger: the node refuses "tp" / "sl" there —
 * live 2026-10-28 "normalTrigger main order must not have tpsl=tp/sl"; the TxFlow web app sends "")
 * and "tp" / "sl" on a positionTpsl leg. `triggerPx` is "" on an unset positionTpsl leg.
 */
export interface TxflowTrigger { isMarket: boolean; triggerPx: string; tpsl: "" | "tp" | "sl" }

/** One order body: keys a, b, p, s, r, t, c, m (the docs' order; `expiresAt` — GTD only — is never sent). */
export interface TxflowOrderBody {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: TxflowTif } } | { trigger: TxflowTrigger };
  /** Client order id; omitted on the second leg of a positionTpsl pair (live: one id per action — "Duplicate client order ID"). */
  c?: string;
  /** Margin mode — always sent: it is part of the position key (docs: order `m`). */
  m: "cross" | "isolated";
}

/** na = plain orders; normalTrigger = standalone triggers; positionTpsl = one position TP/SL pair (legs [sl, tp]). */
export type TxflowGrouping = "na" | "normalTrigger" | "positionTpsl";

export type TxflowCancelGrouping = "trigger" | "tpsl";
/**
 * One cancel body. With a grouping the key order is {grouping, a, o} — grouping FIRST: the node
 * hashes it so (live testnet 2026-10-28: {a, o, grouping} — the docs' order — and {a, grouping, o}
 * both failed signature recovery; {grouping, a, o} executed; the web app builds the same).
 */
export type TxflowCancelBody = { a: number; o: number } | { grouping: TxflowCancelGrouping; a: number; o: number };

export interface TxflowOrderAction { type: "order"; grouping: TxflowGrouping; orders: TxflowOrderBody[] }
export interface TxflowCancelAction { type: "cancel"; cancels: TxflowCancelBody[] }
export interface TxflowModifyAction { type: "modify2"; order: { o: number; p: string; s: string } }
export interface TxflowLeverageAction { type: "updateLeverage"; asset: number; leverage: number; marginMode?: "cross" | "isolated" }
export interface TxflowMarginModeAction { type: "updateMarginMode"; asset: number; isCross: boolean }

export type TxflowAgentAction = TxflowOrderAction | TxflowCancelAction | TxflowModifyAction | TxflowLeverageAction | TxflowMarginModeAction;

export interface TxflowApproveAgentAction {
  type: "approveAgent";
  txflowNetwork: string;
  chainId: number;
  apiVersion: number;
  agentAddress: string;
  agentName: string;
  nonce: number;
}

/** Order body in the node's key order. A trigger body keeps isMarket, triggerPx, tpsl. */
export function txflowOrderBody(o: { asset: number; isBuy: boolean; price: string; size: string; reduceOnly: boolean; type: TxflowOrderBody["t"]; cloid: string | null; marginMode: "cross" | "isolated" }): TxflowOrderBody {
  let t: TxflowOrderBody["t"];
  if ("limit" in o.type) {
    t = { limit: { tif: o.type.limit.tif } };
  } else {
    const tr = o.type.trigger;
    t = { trigger: { isMarket: tr.isMarket, triggerPx: tr.triggerPx, tpsl: tr.tpsl } };
  }
  return o.cloid === null
    ? { a: o.asset, b: o.isBuy, p: o.price, s: o.size, r: o.reduceOnly, t, m: o.marginMode }
    : { a: o.asset, b: o.isBuy, p: o.price, s: o.size, r: o.reduceOnly, t, c: o.cloid, m: o.marginMode };
}

/** A cancel body in the node's key order: {a, o}, or {grouping, a, o} for a trigger / TP/SL. */
export function txflowCancelBody(asset: number, oid: number, grouping: TxflowCancelGrouping | undefined): TxflowCancelBody {
  return grouping === undefined ? { a: asset, o: oid } : { grouping, a: asset, o: oid };
}

// ── Agent flow ──

/** msgpack(action without `type`) — the bytes the connectionId hashes. */
export async function txflowActionPack(action: TxflowAgentAction): Promise<Uint8Array> {
  const { encode } = await import("@msgpack/msgpack");
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) if (k !== "type") body[k] = v;
  return encode(body);
}

/** connectionId = keccak256(msgpack ‖ nonce u64 BE ‖ 0x00 (no vault)). */
export async function txflowConnectionId(action: TxflowAgentAction, nonce: number): Promise<string> {
  if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new PerpError("INVALID_PARAMS", `TxFlow nonce must be a positive integer (got ${nonce})`);
  const { keccak256 } = await import("ethers");
  const packed = await txflowActionPack(action);
  const data = new Uint8Array(packed.length + 9);
  data.set(packed);
  new DataView(data.buffer).setBigUint64(packed.length, BigInt(nonce), false);
  data[packed.length + 8] = 0;
  return keccak256(data);
}

/** Split, then require canonical low-S and the expected signer (never sends a bad signature). */
async function checkedSignature(
  signer: EvmSigner,
  domain: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
  value: Record<string, unknown>,
): Promise<TxflowSignature> {
  const { Signature, TypedDataEncoder, recoverAddress } = await import("ethers");
  const raw = await signer.signTypedData(domain, types, value);
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new PerpError("SIGNATURE_FAILED", "TxFlow: the signer returned a malformed signature — nothing was sent");
  if (BigInt(`0x${hex.slice(64, 128)}`) > SECP256K1_HALF_N) {
    throw new PerpError("SIGNATURE_FAILED", "TxFlow: the signer produced a non-canonical (high-S) signature — nothing was sent");
  }
  const sig = Signature.from(`0x${hex}`);
  const digest = TypedDataEncoder.hash(domain, types, value);
  if (recoverAddress(digest, sig).toLowerCase() !== signer.getAddress().toLowerCase()) {
    throw new PerpError("SIGNATURE_FAILED", "TxFlow: the signature does not recover to the signing key — nothing was sent");
  }
  return { r: sig.r, s: sig.s, v: sig.v };
}

/** Sign a trading action with the agent key (Agent type over the connectionId). */
export async function signTxflowAgentAction(signer: EvmSigner, net: Network, action: TxflowAgentAction, nonce: number): Promise<TxflowSignature> {
  const n = TXFLOW_SIGNING_NETWORK[net];
  const connectionId = await txflowConnectionId(action, nonce);
  return checkedSignature(signer, txflowDomain(net), TXFLOW_AGENT_TYPES, {
    txflowNetwork: n.txflowNetwork, chainId: n.chainId, apiVersion: TXFLOW_SIGNING_API_VERSION, connectionId,
  });
}

/**
 * The approveAgent action (direct EIP-712, signed by the MASTER key). `agentAddress` zero = revoke
 * the label. The returned action is sent as is; its `nonce` must be repeated in the envelope.
 */
export function txflowApproveAgentAction(net: Network, agentAddress: string, agentName: string, nonce: number): TxflowApproveAgentAction {
  if (agentName.length > 64) throw new PerpError("INVALID_PARAMS", `TxFlow agent name is at most 64 characters (got ${agentName.length})`);
  if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new PerpError("INVALID_PARAMS", `TxFlow nonce must be a positive integer (got ${nonce})`);
  const n = TXFLOW_SIGNING_NETWORK[net];
  return { type: "approveAgent", txflowNetwork: n.txflowNetwork, chainId: n.chainId, apiVersion: TXFLOW_SIGNING_API_VERSION, agentAddress, agentName, nonce };
}

export async function signTxflowApproveAgent(master: EvmSigner, net: Network, action: TxflowApproveAgentAction): Promise<TxflowSignature> {
  return checkedSignature(master, txflowDomain(net), TXFLOW_APPROVE_AGENT_TYPES, {
    txflowNetwork: action.txflowNetwork, chainId: action.chainId, apiVersion: action.apiVersion,
    agentAddress: action.agentAddress, agentName: action.agentName, nonce: action.nonce,
  });
}

/**
 * Millisecond nonces, strictly increasing within this process (docs § Nonces: unique per signer,
 * within 2 days before / 1 day after the block time; Date.now() per request).
 */
let lastNonce = 0;
export function nextTxflowNonce(now: number = Date.now()): number {
  lastNonce = Math.max(now, lastNonce + 1);
  return lastNonce;
}
