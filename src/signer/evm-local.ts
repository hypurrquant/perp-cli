import type { EvmSigner } from "./interface.js";

export class LocalEvmSigner implements EvmSigner {
  private _wallet!: import("ethers").Wallet;

  private constructor() {}

  static async create(privateKey: string): Promise<LocalEvmSigner> {
    const { ethers } = await import("ethers");
    const signer = new LocalEvmSigner();
    signer._wallet = new ethers.Wallet(privateKey);
    return signer;
  }

  getAddress(): string {
    return this._wallet.address;
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this._wallet.signTypedData(domain, types, value);
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return this._wallet.signMessage(message);
  }
}
