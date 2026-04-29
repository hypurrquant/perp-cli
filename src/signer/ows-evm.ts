import type { EvmSigner } from "./interface.js";
import { loadOws } from "./ows-loader.js";

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
    });

    const result = ows.signTypedData(this._walletName, "evm", typedData, this._passphrase);
    return canonicalizeOwsSignature(result);
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const ows = loadOws();

    const msgStr = typeof message === "string"
      ? message
      : Buffer.from(message).toString("hex");
    const encoding = typeof message === "string" ? "utf8" : "hex";

    const result = ows.signMessage(this._walletName, "evm", msgStr, this._passphrase, encoding);
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
function canonicalizeOwsSignature(result: { signature: string; recoveryId?: number }): string {
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
