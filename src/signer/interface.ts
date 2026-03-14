/**
 * Signer interfaces for exchange adapters.
 *
 * Separates signing logic from adapters so it can be injected
 * (e.g., HSM, hardware wallet, delegated signing).
 */

/** EVM signer (Hyperliquid + Lighter L1) */
export interface EvmSigner {
  getAddress(): string;

  /** EIP-712 typed data signing — returns flat hex signature (0x...) */
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;

  /** EIP-191 personal message signing — returns hex signature */
  signMessage(message: string | Uint8Array): Promise<string>;
}

/** Solana signer (Pacifica) */
export interface SolanaSigner {
  getPublicKeyBase58(): string;

  /** Ed25519 detached signature */
  signMessage(message: Uint8Array): Promise<Uint8Array>;

  /** Sign a Solana transaction (full sign) */
  signTransaction(tx: { sign(keypair: unknown): void }): void;

  /** Partially sign a Solana transaction */
  partialSignTransaction(tx: { partialSign(keypair: unknown): void }): void;
}
