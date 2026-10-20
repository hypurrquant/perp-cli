/**
 * Public account address formats (keyless reads by address): EVM `0x` + 40 hex (Hyperliquid,
 * Lighter) and base58 Solana public keys (Pacifica). A wrong format is refused with
 * INVALID_PARAMS before any request — the venues answer a foreign address with an empty success
 * (Pacifica `success: true, []`), which would read as "no positions".
 */
import bs58 from "bs58";
import { PerpError } from "../errors.js";

export type AddressKind = "evm" | "solana";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: string): boolean {
  return EVM_RE.test(value.trim());
}

/** A base58 string that decodes to a 32-byte public key. */
export function isSolanaAddress(value: string): boolean {
  try { return bs58.decode(value.trim()).length === 32; } catch { return false; }
}

/** Pacifica account / Print order / vault address: base58 32 bytes, else INVALID_PARAMS. */
export function requireSolanaAddress(value: string, field = "address"): string {
  const a = value.trim();
  if (!isSolanaAddress(a)) {
    throw new PerpError("INVALID_PARAMS", `Not a Solana (base58) ${field}: "${value}"${isEvmAddress(a) ? " — that is an EVM address; Pacifica accounts are Solana addresses" : ""}`, {
      exchange: "pacifica", remediation: "Pass the base58 Solana address you use on Pacifica",
    });
  }
  return a;
}

/** `address` in the form `kind` expects (trimmed), else INVALID_PARAMS naming the expected form. */
export function requireAddressOfKind(venue: string, kind: AddressKind, address: string): string {
  const a = address.trim();
  if (kind === "evm") {
    if (isEvmAddress(a)) return a;
    throw new PerpError("INVALID_PARAMS", `${venue} expects an EVM 0x address (0x + 40 hex)${isSolanaAddress(a) ? " — that is a Solana address" : ""}: "${address}"`, {
      exchange: venue, remediation: `Pass the 0x address of the ${venue} account`,
    });
  }
  if (isSolanaAddress(a)) return a;
  throw new PerpError("INVALID_PARAMS", `${venue} expects a base58 Solana address${isEvmAddress(a) ? " — that is an EVM address" : ""}: "${address}"`, {
    exchange: venue, remediation: `Pass the base58 Solana address of the ${venue} account`,
  });
}
