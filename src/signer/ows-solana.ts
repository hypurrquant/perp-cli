import type { SolanaSigner } from "./interface.js";
import { loadOws } from "./ows-loader.js";

/**
 * Solana signer backed by Open Wallet Standard.
 * Keys never leave the OWS encrypted vault.
 */
export class OwsSolanaSigner implements SolanaSigner {
  private _address: string;
  private _walletName: string;
  private _passphrase: string;

  private constructor(walletName: string, address: string, passphrase: string) {
    this._walletName = walletName;
    this._address = address;
    this._passphrase = passphrase;
  }

  static create(walletName: string, passphrase = ""): OwsSolanaSigner {
    const ows = loadOws();
    const wallet = ows.getWallet(walletName);
    const solAccount = wallet.accounts.find(
      (a: { chainId: string }) => a.chainId.startsWith("solana:"),
    );
    if (!solAccount) {
      throw new Error(`OWS wallet "${walletName}" has no Solana account`);
    }
    return new OwsSolanaSigner(walletName, solAccount.address, passphrase);
  }

  getPublicKeyBase58(): string {
    return this._address;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const ows = loadOws();

    const msgHex = Buffer.from(message).toString("hex");
    const result = ows.signMessage(this._walletName, "solana", msgHex, this._passphrase, "hex");

    // Convert hex signature to Uint8Array
    const sigHex = result.signature.startsWith("0x") ? result.signature.slice(2) : result.signature;
    return Uint8Array.from(Buffer.from(sigHex, "hex"));
  }

  signTransaction(tx: { sign(keypair: unknown): void }): void {
    // OWS doesn't expose raw keypairs. For Solana transactions that require
    // a keypair, we serialize -> sign via OWS -> inject signature back.
    throw new Error(
      "OWS signer does not support in-place tx.sign(). " +
      "Use signTransactionBytes() or the deposit relayer instead.",
    );
  }

  partialSignTransaction(tx: { partialSign(keypair: unknown): void }): void {
    throw new Error(
      "OWS signer does not support in-place tx.partialSign(). " +
      "Use signTransactionBytes() or the deposit relayer instead.",
    );
  }

  /**
   * Sign raw Solana transaction bytes via OWS.
   * The caller is responsible for serializing/deserializing the transaction.
   */
  signTransactionBytes(txBytes: Uint8Array): Uint8Array {
    const ows = loadOws();

    const txHex = Buffer.from(txBytes).toString("hex");
    const result = ows.signTransaction(this._walletName, "solana", txHex, this._passphrase);

    const sigHex = result.signature.startsWith("0x") ? result.signature.slice(2) : result.signature;
    return Uint8Array.from(Buffer.from(sigHex, "hex"));
  }
}
