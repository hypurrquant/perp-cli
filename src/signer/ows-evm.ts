import type { EvmSigner } from "./interface.js";
import { loadOws } from "./ows-loader.js";
import type { Transaction } from "ethers";

/**
 * EVM signer backed by Open Wallet Standard.
 * Keys never leave the OWS encrypted vault.
 */
export class OwsEvmSigner implements EvmSigner {
  private _address: string;
  private _walletName: string;
  private _passphrase: string;

  private constructor(walletName: string, address: string, passphrase: string) {
    this._walletName = walletName;
    this._address = address;
    this._passphrase = passphrase;
  }

  static create(walletName: string, passphrase = ""): OwsEvmSigner {
    const ows = loadOws();
    const wallet = ows.getWallet(walletName);
    const evmAccount = wallet.accounts.find(
      (a: { chainId: string }) => a.chainId.startsWith("eip155:"),
    );
    if (!evmAccount) {
      throw new Error(`OWS wallet "${walletName}" has no EVM account`);
    }
    return new OwsEvmSigner(walletName, evmAccount.address, passphrase);
  }

  getAddress(): string {
    return this._address;
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const ows = loadOws();

    // Build EIP-712 structure expected by OWS
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: Object.keys(domain).map((key) => ({
          name: key,
          type: inferEip712DomainType(key),
        })),
        ...types,
      },
      primaryType: Object.keys(types)[0],
      domain,
      message: value,
    // uint values held as bigint (e.g. RISEx nonce anchors) go as decimal strings, the EIP-712 JSON form.
    }, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

    const result = ows.signTypedData(this._walletName, "ethereum", typedData, this._passphrase);
    return canonicalizeOwsSignature(result);
  }

  /**
   * Sign an unsigned EVM transaction (on-chain txs sent by the master wallet — Lighter RH
   * deposit). The digest is computed HERE from the transaction (`unsignedHash`),
   * so callers can never feed an arbitrary 32-byte hash to the master key. Returns the
   * 65-byte 0x signature; the caller attaches it and checks the recovered sender.
   */
  async signTransaction(tx: Transaction): Promise<string> {
    const digest = unsignedTxDigest(tx);
    const ows = loadOws();
    return canonicalizeOwsSignature(ows.signHash(this._walletName, "ethereum", digest, this._passphrase));
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const ows = loadOws();

    const msgStr = typeof message === "string"
      ? message
      : Buffer.from(message).toString("hex");
    const encoding = typeof message === "string" ? "utf8" : "hex";

    const result = ows.signMessage(this._walletName, "ethereum", msgStr, this._passphrase, encoding);
    return canonicalizeOwsSignature(result);
  }
}

/**
 * Normalize OWS signature output to canonical 65-byte hex (0x-prefixed).
 *
 * OWS may return the signature in two shapes depending on version:
 *   (A) 65-byte hex with v already embedded — use as-is
 *   (B) 64-byte hex (r+s only) + separate recoveryId — append v
 *
 * For shape B, recoveryId may be either canonical (27/28) or raw (0/1).
 * If raw, add 27 to canonicalize.
 */
export function canonicalizeOwsSignature(result: { signature: string; recoveryId?: number }): string {
  const sigHex = result.signature.startsWith("0x") ? result.signature.slice(2) : result.signature;
  if (sigHex.length === 130) {
    // Already 65-byte sig with embedded v — trust OWS
    return `0x${sigHex}`;
  }
  if (sigHex.length !== 128) {
    throw new Error(`Unexpected OWS signature length: ${sigHex.length} hex chars (expected 128 or 130)`);
  }
  // 64-byte r+s — append v from recoveryId
  const rid = result.recoveryId ?? 0;
  const v = rid >= 27 ? rid : rid + 27;  // accept canonical or raw recoveryId
  return `0x${sigHex}${v.toString(16).padStart(2, "0")}`;
}

function inferEip712DomainType(key: string): string {
  switch (key) {
    case "chainId": return "uint256";
    case "verifyingContract": return "address";
    case "salt": return "bytes32";
    default: return "string";
  }
}

/**
 * The signing digest of an unsigned, chain-bound EVM transaction. Refuses an already-signed
 * tx or one without a chainId (replayable across chains).
 */
export function unsignedTxDigest(tx: Transaction): string {
  if (tx.signature !== null) throw new Error("unsignedTxDigest: transaction is already signed");
  if (tx.chainId === 0n) throw new Error("unsignedTxDigest: transaction has no chainId (replay-unsafe)");
  return tx.unsignedHash;
}
