import type { SolanaSigner } from "./interface.js";

export class LocalSolanaSigner implements SolanaSigner {
  private _keypair: import("@solana/web3.js").Keypair;

  constructor(keypair: import("@solana/web3.js").Keypair) {
    this._keypair = keypair;
  }

  getPublicKeyBase58(): string {
    return this._keypair.publicKey.toBase58();
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const nacl = await import("tweetnacl");
    return nacl.default.sign.detached(message, this._keypair.secretKey);
  }

  signTransaction(tx: { sign(keypair: unknown): void }): void {
    tx.sign(this._keypair);
  }

  partialSignTransaction(tx: { partialSign(keypair: unknown): void }): void {
    tx.partialSign(this._keypair);
  }
}
