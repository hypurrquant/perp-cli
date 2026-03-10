import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

export type Exchange = "pacifica" | "hyperliquid" | "lighter";

export async function loadPrivateKey(exchange: Exchange, pkOverride?: string): Promise<string> {
  // 1. CLI flag
  if (pkOverride) return pkOverride;

  // 2. Exchange-specific env vars
  const envMap: Record<Exchange, string[]> = {
    pacifica: ["PACIFICA_PRIVATE_KEY", "pk"],
    hyperliquid: ["HYPERLIQUID_PRIVATE_KEY", "HL_PRIVATE_KEY"],
    lighter: ["LIGHTER_PRIVATE_KEY"],
  };

  for (const envVar of envMap[exchange]) {
    if (process.env[envVar]) return process.env[envVar]!;
  }

  // 3. Generic fallback
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;

  // 4. Active wallet from wallets.json
  try {
    const { getActiveWalletKey } = await import("./commands/wallet.js");
    const walletKey = getActiveWalletKey(exchange);
    if (walletKey) return walletKey;
  } catch {
    // wallet module not available, skip
  }

  // 5. Legacy key file (~/.perp/<exchange>.key)
  const keyFile = resolve(process.env.HOME || "~", ".perp", `${exchange}.key`);
  if (existsSync(keyFile)) {
    return readFileSync(keyFile, "utf-8").trim();
  }

  throw new Error(
    `No private key configured for ${exchange}.\n\n` +
      `  Quick start:  ${chalk.cyan("perp init")}\n\n` +
      `  Or manually:\n` +
      `    perp wallet import ${exchange === "pacifica" ? "solana" : "evm"} <key>\n` +
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
