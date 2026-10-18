/**
 * Robinhood Chain reads/txs for Arcus spot, over
 * `VenueNetworkConfig.rpcUrl` with ethers.
 *
 * Permit2 allowance logic ported from @arcus-xyz/arcus-spot-sdk@1.0.2
 * (src/permits.ts) — Copyright Arcus, Apache License 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Changes: viem → ethers; the
 * SDK's last-resort EIP-2612 domain guess (`version() ?? "1"` without a
 * DOMAIN_SEPARATOR match) is replaced by an error (SSOT Rule #2).
 */

import { AbiCoder, Interface, JsonRpcProvider, Network, Signature, Transaction, keccak256, toUtf8Bytes } from "ethers";
import { PerpError, orderOutcomeUnknown, sendFailure } from "../../errors.js";
import { MULTICALL3_ADDRESS, PERMIT2_ADDRESS } from "./spot-router.js";

/** Approve receipt wait. */
export const ARCUS_APPROVE_RECEIPT_TIMEOUT_MS = 120_000;
/** Gas-limit headroom over eth_estimateGas for the approve tx (also used for the ETH balance check). */
const APPROVE_GAS_HEADROOM_PCT = 20n;
/** Multicall3 aggregate3 batch size. */
const MULTICALL_BATCH = 150;
export const MAX_UINT256 = (1n << 256n) - 1n;

const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const multicall3 = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const TRANSFER_TOPIC = erc20.getEvent("Transfer")!.topicHash;
const EIP712_DOMAIN_TYPEHASH = keccak256(toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));

export interface TokenTransfer { token: string; from: string; to: string; amount: bigint }

/** ethers error shapes that mean "the contract reverted / returned nothing" (vs. transport failure). */
function isContractRevert(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "CALL_EXCEPTION" || code === "BAD_DATA";
}

export class ArcusSpotChain {
  readonly provider: JsonRpcProvider;
  private chainChecked = false;

  constructor(readonly rpcUrl: string, readonly chainId: number) {
    const net = Network.from(chainId);
    this.provider = new JsonRpcProvider(rpcUrl, net, { staticNetwork: net });
  }

  /** Fails if the RPC serves a different chain than the venue's signing chain. */
  async ready(): Promise<void> {
    if (this.chainChecked) return;
    const id = BigInt(await this.provider.send("eth_chainId", []));
    if (id !== BigInt(this.chainId)) {
      throw new PerpError("EXCHANGE_ERROR", `RPC ${this.rpcUrl} serves chainId ${id}, expected ${this.chainId}`, { exchange: "arcus" });
    }
    this.chainChecked = true;
  }

  private async call(to: string, data: string): Promise<string> {
    await this.ready();
    return this.provider.call({ to, data });
  }

  async nativeBalance(owner: string): Promise<bigint> {
    await this.ready();
    return this.provider.getBalance(owner);
  }

  /**
   * balanceOf(owner) for each token via Multicall3. Returns null for a target
   * that answered with no data (no contract deployed — e.g. a wrapped token the
   * factory has not created yet); a reverted call throws.
   */
  async erc20Balances(owner: string, tokens: string[]): Promise<Array<bigint | null>> {
    await this.ready();
    const out: Array<bigint | null> = [];
    const data = erc20.encodeFunctionData("balanceOf", [owner]);
    for (let i = 0; i < tokens.length; i += MULTICALL_BATCH) {
      const batch = tokens.slice(i, i + MULTICALL_BATCH);
      const raw = await this.provider.call({
        to: MULTICALL3_ADDRESS,
        data: multicall3.encodeFunctionData("aggregate3", [batch.map(t => ({ target: t, allowFailure: true, callData: data }))]),
      });
      const [results] = multicall3.decodeFunctionResult("aggregate3", raw) as unknown as [Array<{ success: boolean; returnData: string }>];
      results.forEach((r, j) => {
        if (!r.success) {
          throw new PerpError("EXCHANGE_ERROR", `balanceOf reverted on token ${batch[j]}`, { exchange: "arcus" });
        }
        out.push(r.returnData === "0x" ? null : (erc20.decodeFunctionResult("balanceOf", r.returnData)[0] as bigint));
      });
    }
    return out;
  }

  async permit2Allowance(token: string, owner: string): Promise<bigint> {
    const raw = await this.call(token, erc20.encodeFunctionData("allowance", [owner, PERMIT2_ADDRESS]));
    return erc20.decodeFunctionResult("allowance", raw)[0] as bigint;
  }

  /** EIP-2612 nonce, or null when the token has no `nonces()` (not EIP-2612 → approve tx needed). */
  async eip2612Nonce(token: string, owner: string): Promise<bigint | null> {
    try {
      const raw = await this.call(token, erc20.encodeFunctionData("nonces", [owner]));
      if (raw === "0x") return null;
      return erc20.decodeFunctionResult("nonces", raw)[0] as bigint;
    } catch (e) {
      if (isContractRevert(e)) return null;
      throw e;
    }
  }

  /**
   * EIP-712 domain the token verifies permits with: EIP-5267 `eip712Domain()`,
   * else a `version()` / "1" / "2" candidate that reproduces DOMAIN_SEPARATOR().
   * Nothing verifiable → throws (no guessing).
   */
  async eip2612Domain(token: string): Promise<{ name: string; version: string }> {
    try {
      const raw = await this.call(token, erc20.encodeFunctionData("eip712Domain", []));
      if (raw !== "0x") {
        const d = erc20.decodeFunctionResult("eip712Domain", raw);
        const name = d[1] as string;
        const version = d[2] as string;
        if (name && version) return { name, version };
      }
    } catch (e) {
      if (!isContractRevert(e)) throw e;
    }
    const name = erc20.decodeFunctionResult("name", await this.call(token, erc20.encodeFunctionData("name", [])))[0] as string;
    let versionFn: string | null = null;
    try {
      const raw = await this.call(token, erc20.encodeFunctionData("version", []));
      if (raw !== "0x") versionFn = erc20.decodeFunctionResult("version", raw)[0] as string;
    } catch (e) {
      if (!isContractRevert(e)) throw e;
    }
    const sepRaw = await this.call(token, erc20.encodeFunctionData("DOMAIN_SEPARATOR", []));
    const onchain = (erc20.decodeFunctionResult("DOMAIN_SEPARATOR", sepRaw)[0] as string).toLowerCase();
    const candidates = [...new Set([versionFn, "1", "2"].filter((v): v is string => typeof v === "string" && v.length > 0))];
    const coder = AbiCoder.defaultAbiCoder();
    for (const version of candidates) {
      const sep = keccak256(coder.encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [EIP712_DOMAIN_TYPEHASH, keccak256(toUtf8Bytes(name)), keccak256(toUtf8Bytes(version)), BigInt(this.chainId), token],
      ));
      if (sep.toLowerCase() === onchain) return { name, version };
    }
    throw new PerpError("NOT_IMPLEMENTED", `Cannot determine the EIP-2612 domain of token ${token} (no eip712Domain(), no DOMAIN_SEPARATOR match)`, {
      exchange: "arcus",
      remediation: `Approve Permit2 (${PERMIT2_ADDRESS}) for this token from your wallet, then retry`,
    });
  }

  /**
   * Send `approve(Permit2, MAX_UINT256)` from `owner`, signed via `signTx`
   * (master key), after checking the native ETH balance covers
   * gasLimit × maxFeePerGas. Waits for a successful receipt.
   */
  async approvePermit2(token: string, owner: string, signTx: (tx: Transaction) => Promise<string>): Promise<string> {
    await this.ready();
    const data = erc20.encodeFunctionData("approve", [PERMIT2_ADDRESS, MAX_UINT256]);
    const estimate = await this.provider.estimateGas({ from: owner, to: token, data });
    const gasLimit = estimate + (estimate * APPROVE_GAS_HEADROOM_PCT) / 100n;
    const fee = await this.provider.getFeeData();
    if (fee.maxFeePerGas === null || fee.maxPriorityFeePerGas === null) {
      throw new PerpError("EXCHANGE_ERROR", `RPC ${this.rpcUrl} returned no EIP-1559 fee data`, { exchange: "arcus" });
    }
    const cost = gasLimit * fee.maxFeePerGas;
    const eth = await this.provider.getBalance(owner);
    if (eth <= cost) {
      throw new PerpError("INSUFFICIENT_BALANCE", `Permit2 approve needs up to ${cost} wei of Robinhood Chain ETH for gas; wallet ${owner} has ${eth}`, {
        exchange: "arcus",
        remediation: `Fund ${owner} with ETH on Robinhood Chain (chainId ${this.chainId}), then retry`,
      });
    }
    const nonce = await this.provider.getTransactionCount(owner, "pending");
    const tx = Transaction.from({
      type: 2, chainId: BigInt(this.chainId), nonce, to: token, data, value: 0n, gasLimit,
      maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    });
    tx.signature = Signature.from(await signTx(tx));
    if (tx.from?.toLowerCase() !== owner.toLowerCase()) {
      throw new PerpError("SIGNATURE_FAILED", `Approve tx recovered signer ${tx.from}, expected ${owner}`, { exchange: "arcus" });
    }
    // Once broadcast, the approve's outcome is unknown until mined: a broadcast transport failure,
    // a receipt read failure or a receipt timeout → ORDER_PENDING (never the retryable TIMEOUT,
    // which callers re-type as "not sent"). No connection at all → definitely not sent.
    const signedHash = tx.hash;
    const pendingRemediation = (hash: string | null) =>
      `Do NOT send another approve; wait for ${hash ?? "the approve tx"} to confirm (check the wallet's Robinhood Chain transactions), then retry the swap`;
    let sent: { hash: string };
    try {
      sent = await this.provider.broadcastTransaction(tx.serialized);
    } catch (e) {
      throw sendFailure("arcus", `Permit2 approve tx ${signedHash ?? ""}`.trim(), e, pendingRemediation(signedHash));
    }
    let receipt;
    try {
      receipt = await this.provider.waitForTransaction(sent.hash, 1, ARCUS_APPROVE_RECEIPT_TIMEOUT_MS);
    } catch (e) {
      if ((e as { code?: unknown }).code !== "TIMEOUT") {
        throw orderOutcomeUnknown("arcus", `Permit2 approve tx ${sent.hash}`, e, pendingRemediation(sent.hash));
      }
      receipt = null;
    }
    if (receipt === null) {
      throw new PerpError("ORDER_PENDING", `Permit2 approve tx ${sent.hash} not mined within ${ARCUS_APPROVE_RECEIPT_TIMEOUT_MS / 1000}s`, {
        exchange: "arcus",
        txHash: sent.hash,
        remediation: pendingRemediation(sent.hash),
      });
    }
    if (receipt.status !== 1) {
      throw new PerpError("EXCHANGE_ERROR", `Permit2 approve tx ${sent.hash} reverted`, { exchange: "arcus" });
    }
    return sent.hash;
  }

  /** ERC-20 Transfer logs in a mined tx (null when the RPC has no receipt for it). */
  async transfersIn(txHash: string): Promise<{ status: number | null; transfers: TokenTransfer[] } | null> {
    await this.ready();
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (receipt === null) return null;
    const transfers: TokenTransfer[] = [];
    for (const log of receipt.logs) {
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      const ev = erc20.parseLog({ topics: [...log.topics], data: log.data });
      if (ev === null) continue;
      transfers.push({ token: log.address, from: ev.args[0] as string, to: ev.args[1] as string, amount: ev.args[2] as bigint });
    }
    return { status: receipt.status, transfers };
  }
}
