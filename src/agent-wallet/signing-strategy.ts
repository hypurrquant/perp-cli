import type { AgentMeta } from "../settings.js";

/**
 * Interface for agent-key signing strategies.
 * The AsterAdapter consumes this interface, never a concrete class.
 *
 * Signature shape mirrors EvmSigner.signTypedData(domain, types, message) so
 * call sites can cast to `EvmSigner & AgentSigningStrategy` and dispatch
 * uniformly. The return type differs from EvmSigner (which returns string):
 * AgentSigningStrategy returns { signature, r, s, v } so callers can pull
 * raw r/s/v if needed.
 */
export interface AgentSigningStrategy {
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>,
  ): Promise<{ signature: string; r: string; s: string; v: number }>;
  getAddress(): string;
}

/**
 * Strategy: pass the OWS api-key token in the passphrase slot.
 * This is the default (Option A γ-path). Validity depends on Step 0a spike.
 * Wraps OwsEvmSigner.create(walletName, owsKeyToken).
 */
export class TokenAsPassphraseStrategy implements AgentSigningStrategy {
  private _walletName: string;
  private _owsKeyToken: string;
  private _address: string;

  constructor(walletName: string, owsKeyToken: string, address: string) {
    this._walletName = walletName;
    this._owsKeyToken = owsKeyToken;
    this._address = address;
  }

  getAddress(): string {
    return this._address;
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>,
  ): Promise<{ signature: string; r: string; s: string; v: number }> {
    // Lazy import to avoid loading OWS bindings unless this strategy is used
    const { OwsEvmSigner } = await import("../signer/ows-evm.js");
    const signer = OwsEvmSigner.create(this._walletName, this._owsKeyToken);

    const hexSig = await signer.signTypedData(domain, types, message);

    // Parse r, s, v from the 65-byte hex signature
    const sig = hexSig.startsWith("0x") ? hexSig.slice(2) : hexSig;
    const r = `0x${sig.slice(0, 64)}`;
    const s = `0x${sig.slice(64, 128)}`;
    const v = parseInt(sig.slice(128, 130), 16);

    return { signature: hexSig, r, s, v };
  }
}

/**
 * Strategy: read the token from the OWS keyfile by api-key id and pass it
 * explicitly. Stub until Step 0a determines whether this path is needed.
 */
export class ExplicitTokenStrategy implements AgentSigningStrategy {
  constructor(
    _walletName: string,
    _apiKeyId: string,
    _address: string,
  ) {}

  getAddress(): string {
    throw new Error(
      "ExplicitTokenStrategy.getAddress(): not implemented — pending Step 0a spike outcome",
    );
  }

  async signTypedData(
    _domain: Record<string, unknown>,
    _types: Record<string, Array<{ name: string; type: string }>>,
    _message: Record<string, unknown>,
  ): Promise<{ signature: string; r: string; s: string; v: number }> {
    throw new Error(
      "ExplicitTokenStrategy.signTypedData(): not implemented — pending Step 0a spike outcome",
    );
  }
}

/**
 * Factory: returns the appropriate signing strategy for the given agent meta +
 * OWS api-key token. Defaults to TokenAsPassphraseStrategy per Option A γ-path.
 * Will switch based on Step 0a spike outcome.
 */
export function agentSigningStrategyFor(
  meta: AgentMeta,
  owsKeyToken: string,
): AgentSigningStrategy {
  return new TokenAsPassphraseStrategy(
    meta.agentWalletName,
    owsKeyToken,
    meta.agentEvmAddress,
  );
}
