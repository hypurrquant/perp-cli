import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

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

export async function loadPrivateKey(exchange: Exchange, pkOverride?: string, walletName?: string): Promise<string> {
  // 0. Wallet name override (--wallet flag)
  if (walletName) {
    const { getWalletKeyByName } = await import("./commands/wallet.js");
    const key = getWalletKeyByName(walletName);
    if (!key) throw new Error(`Wallet "${walletName}" not found. Run: perp wallet list`);
    return key;
  }

  // 1. CLI flag
  if (pkOverride) return pkOverride;

  // 2. Exchange-specific env vars
  const envMap: Record<Exchange, string[]> = {
    pacifica: ["PACIFICA_PRIVATE_KEY", "pk"],
    hyperliquid: ["HYPERLIQUID_PRIVATE_KEY", "HL_PRIVATE_KEY"],
    lighter: ["LIGHTER_PRIVATE_KEY"],
    aster: ["ASTER_API_KEY"],
  };

  for (const envVar of envMap[exchange]) {
    if (process.env[envVar]) return process.env[envVar]!;
  }

  // 3. ~/.perp/.env file (written by `perp wallet set` / `perp setup`)
  try {
    const { loadEnvFile } = await import("./commands/init.js");
    const envFile = loadEnvFile();
    for (const envVar of envMap[exchange]) {
      if (envFile[envVar]) return envFile[envVar];
    }
  } catch {
    // init module not available, skip
  }

  // 4. Generic fallback
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;

  // 5. Active wallet from wallets.json
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
    `No private key configured for ${exchange}.\n\n` +
      `  Quick start:  ${chalk.cyan("perp setup")}\n\n` +
      `  Or manually:\n` +
      `    perp wallet set ${exchange} <key>\n` +
      `    ${envMap[exchange][0]}=<key> (env var)\n` +
      `    --private-key <key> (per-command)`
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
