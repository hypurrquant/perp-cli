import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

export type Exchange = "pacifica" | "hyperliquid" | "lighter" | "aster";

/**
 * Try to load a private key without throwing if none is found.
 * Returns null if no key is configured.
 */
export async function tryLoadPrivateKey(exchange: Exchange, pkOverride?: string, walletName?: string): Promise<string | null> {
  try {
    return await loadPrivateKey(exchange, pkOverride, walletName);
  } catch {
    return null;
  }
}

/**
 * Resolve an OWS wallet name to a signer-ready marker.
 * Returns the OWS wallet name prefixed with "ows:" so callers can detect OWS mode.
 */
export function resolveOwsWallet(walletName: string): string | null {
  try {
    const { getWallet } = _require("@open-wallet-standard/core") as typeof import("@open-wallet-standard/core");
    getWallet(walletName); // throws if not found
    return `ows:${walletName}`;
  } catch {
    return null;
  }
}

/** Check if a key string represents an OWS wallet reference. */
export function isOwsKey(key: string): boolean {
  return key.startsWith("ows:");
}

/** Extract OWS wallet name from an ows: prefixed key string. */
export function getOwsWalletName(key: string): string {
  return key.slice(4);
}

export async function loadPrivateKey(exchange: Exchange, pkOverride?: string, walletName?: string): Promise<string> {
  // 0a. OWS wallet (--ows flag sets walletName with "ows:" prefix)
  if (walletName?.startsWith("ows:")) {
    return walletName; // pass through — adapters detect the ows: prefix
  }

  // 0b. Wallet name override (--wallet flag) — check OWS first, then local
  if (walletName) {
    // Try OWS vault
    const owsKey = resolveOwsWallet(walletName);
    if (owsKey) return owsKey;

    // Fall back to local wallets
    const { getWalletKeyByName } = await import("./commands/wallet.js");
    const key = getWalletKeyByName(walletName);
    if (!key) throw new Error(`Wallet "${walletName}" not found. Run: perp wallet list`);
    return key;
  }

  // 1. CLI flag
  if (pkOverride) return pkOverride;

  // 2. OWS active wallet (highest priority after explicit flags)
  try {
    const { loadSettings } = await import("./settings.js");
    const settings = loadSettings();
    if (settings.owsActiveWallet) {
      const owsKey = resolveOwsWallet(settings.owsActiveWallet);
      if (owsKey) return owsKey;
    }
  } catch {
    // settings module not available, skip
  }

  // 3. Exchange-specific env vars
  const envMap: Record<Exchange, string[]> = {
    pacifica: ["PACIFICA_PRIVATE_KEY", "pk"],
    hyperliquid: ["HYPERLIQUID_PRIVATE_KEY", "HL_PRIVATE_KEY"],
    lighter: ["LIGHTER_PRIVATE_KEY"],
    aster: ["ASTER_API_KEY"],
  };

  for (const envVar of envMap[exchange]) {
    if (process.env[envVar]) return process.env[envVar]!;
  }

  // 4. Generic fallback
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;

  // 5. Legacy: Active wallet from wallets.json
  try {
    const { getActiveWalletKey } = await import("./commands/wallet.js");
    const walletKey = getActiveWalletKey(exchange);
    if (walletKey) return walletKey;
  } catch {
    // wallet module not available, skip
  }

  // 6. Legacy key file (~/.perp/<exchange>.key)
  const keyFile = resolve(process.env.HOME || "~", ".perp", `${exchange}.key`);
  if (existsSync(keyFile)) {
    return readFileSync(keyFile, "utf-8").trim();
  }

  throw new Error(
    `No wallet configured for ${exchange}.\n\n` +
      `  Quick start:  ${chalk.cyan("perp wallet generate")}\n\n` +
      `  Or manually:\n` +
      `    perp wallet import <key>     Import key to OWS vault\n` +
      `    perp wallet set ${exchange} <key>  Legacy: set env var\n` +
      `    --private-key <key>          Per-command override`
  );
}

export function parseSolanaKeypair(input: string): Keypair {
  // Try base58 first
  try {
    const bytes = bs58.decode(input);
    return Keypair.fromSecretKey(bytes);
  } catch {
    // noop
  }

  // Try JSON array (Solana CLI format)
  try {
    const arr = JSON.parse(input);
    if (Array.isArray(arr)) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch {
    // noop
  }

  throw new Error("Invalid Solana private key. Expected base58 or JSON byte array.");
}

export function isEvmPrivateKey(input: string): boolean {
  return input.startsWith("0x") && input.length === 66;
}
