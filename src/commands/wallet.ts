import { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";
import { EXCHANGE_ENV_MAP, validateKey, loadEnvFile, setEnvVar, ENV_FILE } from "./init.js";
import { loadSettings, saveSettings } from "../settings.js";
import { registerWalletAgentCommands } from "./agent.js";
import { registerWalletManageCommands } from "./manage.js";
import { loadOws } from "../signer/ows-loader.js";
import type { ExchangeAdapter } from "../exchanges/index.js";

// ── OWS CLI subprocess helper (used by backup/restore/rotate) ──
//
// The wallet command tree exposes three different "agent" sub-namespaces;
// they are intentionally separate because they answer three different
// questions:
//
//   * `wallet agent approve <ex> ...`  — DEX-side agent registration. Sends
//     EIP-712 approveAgent (or equivalent) to the exchange so the agent
//     wallet can post orders on behalf of the master. State lives partly on
//     the DEX (their auth list) and partly in `~/.perp/settings.json` under
//     `agents.<exchange>.<name>`.
//
//   * `wallet key create / list / revoke`  — OWS-side API key. A vault
//     access token (`ows_key_…`) that lets an off-host agent process invoke
//     OWS signing primitives without holding the master passphrase. Pure
//     OWS construct, no DEX traffic.
//
//   * `wallet policy create / list / show / delete`  — OWS-side guardrail.
//     A policy attached to an OWS API key that bounds what the agent can
//     sign (chain allowlist, per-tx USD cap, daily withdraw cap, etc.).
//     Also pure OWS, evaluated locally before any signature is produced.
//
// Future maintainers: do NOT collapse these. They protect different layers.
async function runOwsCli(args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  const { resolve: pathResolve } = await import("path");
  const { existsSync: fsExists } = await import("fs");
  const { spawnSync } = await import("child_process");

  const owsBin = [
    pathResolve(process.env.HOME || "~", ".ows", "bin", "ows"),
    "/usr/local/bin/ows",
  ].find(p => fsExists(p));

  if (!owsBin) {
    throw new Error("OWS CLI not found. Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash");
  }

  const owsEnv = { ...process.env, PATH: `${pathResolve(process.env.HOME || "~", ".ows", "bin")}:${process.env.PATH}` };
  const proc = spawnSync(owsBin, args, { encoding: "utf-8", timeout, env: owsEnv });

  if (proc.error) throw new Error(`OWS CLI failed: ${proc.error.message}`);
  return { stdout: (proc.stdout || "").trim(), stderr: (proc.stderr || "").trim() };
}

// ── Wallet store ──────────────────────────────────────────────

interface WalletEntry {
  name: string;
  type: "solana" | "evm";
  address: string;
  privateKey: string;
  createdAt: string;
}

interface WalletStore {
  wallets: Record<string, WalletEntry>;
  active: Record<string, string>; // exchange -> wallet name
}

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const WALLETS_FILE = resolve(PERP_DIR, "wallets.json");

function ensurePerpDir() {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
}

function loadStore(): WalletStore {
  ensurePerpDir();
  if (!existsSync(WALLETS_FILE)) return { wallets: {}, active: {} };
  try {
    return JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));
  } catch {
    return { wallets: {}, active: {} };
  }
}

function saveStore(store: WalletStore) {
  ensurePerpDir();
  writeFileSync(WALLETS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Exported for smart landing page in index.ts */
export function getWalletSetupStatus(): {
  hasWallets: boolean;
  active: Record<string, string>;
  wallets: Record<string, { name: string; type: string; address: string }>;
} {
  const store = loadStore();
  const wallets: Record<string, { name: string; type: string; address: string }> = {};
  for (const [k, v] of Object.entries(store.wallets)) {
    wallets[k] = { name: v.name, type: v.type, address: v.address };
  }
  return { hasWallets: Object.keys(store.wallets).length > 0, active: store.active, wallets };
}

/** Exported so config.ts can resolve the active wallet key */
export function getActiveWalletKey(exchange: string): string | null {
  const store = loadStore();
  const name = store.active[exchange];
  if (!name) return null;
  return store.wallets[name]?.privateKey ?? null;
}

/** Get wallet key by name. Returns null if wallet doesn't exist. */
export function getWalletKeyByName(name: string): string | null {
  const store = loadStore();
  return store.wallets[name]?.privateKey ?? null;
}

// ── Balance helpers ───────────────────────────────────────────

interface TokenBalance {
  token: string;
  balance: string;
  usdValue: string;
}

async function getSolanaBalances(address: string, isTestnet: boolean): Promise<TokenBalance[]> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const rpcUrl = isTestnet
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl);
  const pubkey = new PublicKey(address);

  const balances: TokenBalance[] = [];

  const solLamports = await connection.getBalance(pubkey);
  const solBalance = solLamports / 1e9;
  balances.push({ token: "SOL", balance: solBalance.toFixed(6), usdValue: "" });

  const usdcMint = isTestnet
    ? "USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM"
    : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      mint: new PublicKey(usdcMint),
    });
    let usdcBalance = 0;
    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (parsed) usdcBalance += Number(parsed.tokenAmount?.uiAmount ?? 0);
    }
    balances.push({
      token: isTestnet ? "USDP" : "USDC",
      balance: usdcBalance.toFixed(2),
      usdValue: `$${formatUsd(usdcBalance)}`,
    });
  } catch {
    balances.push({ token: isTestnet ? "USDP" : "USDC", balance: "0.00", usdValue: "$0.00" });
  }

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const json = (await res.json()) as Record<string, Record<string, number>>;
    balances[0].usdValue = `$${formatUsd(solBalance * (json.solana?.usd ?? 0))}`;
  } catch {
    balances[0].usdValue = "-";
  }
  return balances;
}

async function getEvmBalances(address: string, isTestnet: boolean): Promise<TokenBalance[]> {
  const { ethers } = await import("ethers");
  const rpcUrl = isTestnet
    ? "https://sepolia-rollup.arbitrum.io/rpc"
    : "https://arb1.arbitrum.io/rpc";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const balances: TokenBalance[] = [];

  const ethBal = await provider.getBalance(address);
  const ethBalance = Number(ethers.formatEther(ethBal));
  balances.push({ token: "ETH", balance: ethBalance.toFixed(6), usdValue: "" });

  const usdcAddr = isTestnet
    ? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"
    : "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  try {
    const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
    const rawBal = await usdc.balanceOf(address);
    const usdcBalance = Number(ethers.formatUnits(rawBal, 6));
    balances.push({ token: "USDC", balance: usdcBalance.toFixed(2), usdValue: `$${formatUsd(usdcBalance)}` });
  } catch {
    balances.push({ token: "USDC", balance: "0.00", usdValue: "$0.00" });
  }

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const json = (await res.json()) as Record<string, Record<string, number>>;
    balances[0].usdValue = `$${formatUsd(ethBalance * (json.ethereum?.usd ?? 0))}`;
  } catch {
    balances[0].usdValue = "-";
  }
  return balances;
}

// ── Derive address from private key ──────────────────────────

async function deriveSolanaAddress(key: string): Promise<string> {
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  try {
    return Keypair.fromSecretKey(bs58.decode(key)).publicKey.toBase58();
  } catch {
    const arr = JSON.parse(key);
    return Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey.toBase58();
  }
}

async function deriveEvmAddress(key: string): Promise<string> {
  const { ethers } = await import("ethers");
  const pk = key.startsWith("0x") ? key : `0x${key}`;
  return new ethers.Wallet(pk).address;
}

// ── Legacy helpers ───────────────────────────────────────────

async function _legacyGenerate(chain: string, name: string | undefined, isJson: () => boolean) {
  if (chain === "solana") {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    const privkey = bs58.encode(keypair.secretKey);
    const walletName = name || "default-sol";
    const store = loadStore();
    if (store.wallets[walletName]) { console.error(chalk.red(`\n  Wallet "${walletName}" already exists.\n`)); process.exit(1); }
    store.wallets[walletName] = { name: walletName, type: "solana", address, privateKey: privkey, createdAt: new Date().toISOString() };
    if (!store.active.pacifica) store.active.pacifica = walletName;
    saveStore(store);
    setEnvVar("PACIFICA_PRIVATE_KEY", privkey);
    if (isJson()) return printJson(jsonOk({ name: walletName, type: "solana", address, legacy: true }));
    console.log(chalk.yellow.bold("\n  [Legacy] Solana Wallet Generated\n"));
    console.log(`  Name:    ${chalk.white.bold(walletName)}`);
    console.log(`  Address: ${chalk.green(address)}`);
    console.log(chalk.gray(`  Saved:   ~/.perp/.env + wallets.json (unencrypted)`));
    console.log(chalk.yellow(`\n  Consider: ${chalk.cyan("perp wallet migrate")} to move to OWS vault\n`));
  } else if (chain === "evm") {
    const { ethers } = await import("ethers");
    const w = ethers.Wallet.createRandom();
    const walletName = name || "default-evm";
    const store = loadStore();
    if (store.wallets[walletName]) { console.error(chalk.red(`\n  Wallet "${walletName}" already exists.\n`)); process.exit(1); }
    store.wallets[walletName] = { name: walletName, type: "evm", address: w.address, privateKey: w.privateKey, createdAt: new Date().toISOString() };
    if (!store.active.hyperliquid) store.active.hyperliquid = walletName;
    if (!store.active.lighter) store.active.lighter = walletName;
    saveStore(store);
    setEnvVar("HL_PRIVATE_KEY", w.privateKey);
    setEnvVar("LIGHTER_PRIVATE_KEY", w.privateKey);
    if (isJson()) return printJson(jsonOk({ name: walletName, type: "evm", address: w.address, legacy: true }));
    console.log(chalk.yellow.bold("\n  [Legacy] EVM Wallet Generated\n"));
    console.log(`  Name:    ${chalk.white.bold(walletName)}`);
    console.log(`  Address: ${chalk.green(w.address)}`);
    console.log(chalk.gray(`  Saved:   ~/.perp/.env + wallets.json (unencrypted)`));
    console.log(chalk.yellow(`\n  Consider: ${chalk.cyan("perp wallet migrate")} to move to OWS vault\n`));
  } else {
    console.error(chalk.red(`\n  Unknown chain: ${chain}. Use: solana or evm\n`));
    process.exit(1);
  }
}

async function _legacyImport(chain: string, privateKey: string, name: string, isJson: () => boolean) {
  if (chain === "solana") {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    let address: string, normalizedKey: string;
    try {
      try { const bytes = bs58.decode(privateKey); const kp = Keypair.fromSecretKey(bytes); address = kp.publicKey.toBase58(); normalizedKey = bs58.encode(kp.secretKey); }
      catch { const arr = JSON.parse(privateKey); const kp = Keypair.fromSecretKey(Uint8Array.from(arr)); address = kp.publicKey.toBase58(); normalizedKey = bs58.encode(kp.secretKey); }
    } catch { console.error(chalk.red("\n  Invalid Solana private key.\n")); process.exit(1); return; }
    const store = loadStore();
    if (store.wallets[name]) { console.error(chalk.red(`\n  Wallet "${name}" already exists.\n`)); process.exit(1); }
    store.wallets[name] = { name, type: "solana", address, privateKey: normalizedKey, createdAt: new Date().toISOString() };
    if (!store.active.pacifica) store.active.pacifica = name;
    saveStore(store);
    setEnvVar("PACIFICA_PRIVATE_KEY", normalizedKey);
    if (isJson()) return printJson(jsonOk({ name, type: "solana", address, legacy: true }));
    console.log(chalk.yellow.bold("\n  [Legacy] Solana Key Imported\n"));
    console.log(`  Name:    ${chalk.white.bold(name)}`);
    console.log(`  Address: ${chalk.green(address)}\n`);
  } else if (chain === "evm") {
    const { ethers } = await import("ethers");
    const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    let address: string;
    try { address = new ethers.Wallet(pk).address; } catch { console.error(chalk.red("\n  Invalid EVM private key.\n")); process.exit(1); return; }
    const store = loadStore();
    if (store.wallets[name]) { console.error(chalk.red(`\n  Wallet "${name}" already exists.\n`)); process.exit(1); }
    store.wallets[name] = { name, type: "evm", address, privateKey: pk, createdAt: new Date().toISOString() };
    if (!store.active.hyperliquid) store.active.hyperliquid = name;
    if (!store.active.lighter) store.active.lighter = name;
    saveStore(store);
    setEnvVar("HL_PRIVATE_KEY", pk);
    setEnvVar("LIGHTER_PRIVATE_KEY", pk);
    if (isJson()) return printJson(jsonOk({ name, type: "evm", address, legacy: true }));
    console.log(chalk.yellow.bold("\n  [Legacy] EVM Key Imported\n"));
    console.log(`  Name:    ${chalk.white.bold(name)}`);
    console.log(`  Address: ${chalk.green(address)}\n`);
  } else {
    console.error(chalk.red(`\n  Unknown chain: ${chain}. Use: solana or evm\n`));
    process.exit(1);
  }
}

// ── Commands ──────────────────────────────────────────────────

export function registerWalletCommands(
  program: Command,
  isJson: () => boolean,
  getAdapter?: () => Promise<ExchangeAdapter>,
  getPacificaAdapter?: () => unknown,
) {
  const wallet = program.command("wallet").description("Wallet management & on-chain balances");

  // ── generate (OWS — creates multi-chain wallet in encrypted vault) ──

  wallet
    .command("generate [name]")
    .description("Generate a new wallet (OWS encrypted vault, multi-chain)")
    .option("--words <count>", "Mnemonic word count (12 or 24)", "12")
    .option("--show-mnemonic", "Display the mnemonic phrase (CAUTION)")
    .option("--legacy <chain>", "Legacy mode: generate solana or evm key (unencrypted)")
    .action(async (name: string | undefined, opts: { words: string; showMnemonic?: boolean; legacy?: string }) => {
      // Legacy mode for backward compat
      if (opts.legacy) {
        return _legacyGenerate(opts.legacy, name, isJson);
      }

      const walletName = name || "default";
      try {
        const ows = loadOws();
        const w = ows.createWallet(walletName, "", parseInt(opts.words));

        // Set as active wallet
        const { loadSettings: ls, saveSettings: ss } = await import("../settings.js");
        const settings = ls();
        if (!settings.owsActiveWallet) {
          settings.owsActiveWallet = walletName;
          ss(settings);
        }

        if (isJson()) {
          const data: Record<string, unknown> = {
            id: w.id, name: w.name, accounts: w.accounts, createdAt: w.createdAt,
          };
          if (opts.showMnemonic) data.mnemonic = ows.exportWallet(walletName);
          return printJson(jsonOk(data));
        }

        console.log(chalk.cyan.bold("\n  Wallet Created (OWS Encrypted Vault)\n"));
        console.log(`  Name: ${chalk.white.bold(w.name)}`);
        console.log(`  ID:   ${chalk.gray(w.id)}`);
        console.log();
        const evmAcct = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"));
        const solAcct = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"));
        if (evmAcct) console.log(`  EVM:    ${chalk.green(evmAcct.address)}`);
        if (solAcct) console.log(`  Solana: ${chalk.green(solAcct.address)}`);
        console.log(chalk.gray(`\n  Vault: ~/.ows/ (AES-256-GCM encrypted)`));
        if (settings.owsActiveWallet === walletName) {
          console.log(chalk.cyan(`  Active: yes (used by all exchanges)`));
        }
        if (opts.showMnemonic) {
          const mnemonic = ows.exportWallet(walletName);
          console.log(chalk.red.bold(`\n  Mnemonic: ${mnemonic}`));
          console.log(chalk.red("  Write this down and store it safely!"));
        }
        console.log(chalk.red.bold("\n  Fund this wallet before trading!\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) {
          const { jsonError } = await import("../utils.js");
          return printJson(jsonError("OWS_ERROR", msg));
        }
        console.error(chalk.red(`\n  Error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── import (OWS by default — imports key into encrypted vault) ──
  //
  // Solana key normalization: OWS SDK expects 32-byte hex secret. Phantom
  // exports base58 (88 chars, 64-byte keypair = secret + public). Auto-detect
  // base58/JSON-array/hex and normalize to 32-byte hex secret.

  wallet
    .command("import [privateKey]")
    .description("Import a private key into OWS encrypted vault (use --evm/--solana to import both curves at once)")
    .option("--name <name>", "Wallet alias name", "imported")
    .option("--chain <chain>", "Key type for positional <privateKey>: evm (default) or solana", "evm")
    .option("--evm <hex>", "EVM (secp256k1) private key — use with --solana to import both curves")
    .option("--solana <key>", "Solana (ed25519) private key — accepts hex (64), base58 (Phantom export), or JSON byte array. Use with --evm to import both curves")
    .option("--mnemonic", "Import as mnemonic phrase instead of private key")
    .option("--passphrase <pp>", "OWS vault encryption passphrase (default: empty / OWS_PASSPHRASE env)")
    .option("--legacy <chain>", "Legacy mode: import to wallets.json (solana or evm)")
    .action(async (privateKey: string | undefined, opts: { name: string; chain: string; evm?: string; solana?: string; mnemonic?: boolean; passphrase?: string; legacy?: string }) => {
      // Legacy mode (positional only)
      if (opts.legacy) {
        if (!privateKey) {
          const msg = "--legacy mode requires a positional <privateKey>";
          if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
          console.error(chalk.red(`\n  Error: ${msg}\n`));
          process.exit(1);
        }
        return _legacyImport(opts.legacy, privateKey, opts.name, isJson);
      }

      // Validation: input mode is exactly one of (positional | --evm/--solana flags | mnemonic)
      const hasPositional = !!privateKey;
      const hasFlagKeys = !!(opts.evm || opts.solana);
      if (!hasPositional && !hasFlagKeys) {
        const msg = "Provide a <privateKey> argument OR --evm/--solana flag(s)";
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  Error: ${msg}\n`));
        process.exit(1);
      }
      if (hasPositional && hasFlagKeys) {
        const msg = "Cannot mix positional <privateKey> with --evm/--solana flags. Use one input style.";
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  Error: ${msg}\n`));
        process.exit(1);
      }
      if (opts.mnemonic && hasFlagKeys) {
        const msg = "--mnemonic cannot be combined with --evm/--solana";
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  Error: ${msg}\n`));
        process.exit(1);
      }

      try {
        const ows = loadOws();

        // Auto-normalize Solana keys: accept hex / base58 (Phantom) / JSON byte array
        const bs58 = (await import("bs58")).default;
        const normalizeSolana = (input: string): string => {
          const s = input.trim();
          // Already hex (with optional 0x prefix)
          const hexNoPrefix = s.startsWith("0x") ? s.slice(2) : s;
          if (/^[0-9a-fA-F]{64}$/.test(hexNoPrefix)) return hexNoPrefix;
          if (/^[0-9a-fA-F]{128}$/.test(hexNoPrefix)) {
            return hexNoPrefix.slice(0, 64);  // 64-byte keypair → first 32 bytes secret
          }
          // JSON byte array
          if (s.startsWith("[")) {
            const arr = JSON.parse(s) as number[];
            if (arr.length === 64) return Buffer.from(arr.slice(0, 32)).toString("hex");
            if (arr.length === 32) return Buffer.from(arr).toString("hex");
            throw new Error(`Invalid Solana JSON byte array length: ${arr.length} (expected 32 or 64)`);
          }
          // base58 (Phantom export — typically 87-88 chars for 64-byte keypair)
          try {
            const decoded = bs58.decode(s);
            if (decoded.length === 64) return Buffer.from(decoded.slice(0, 32)).toString("hex");
            if (decoded.length === 32) return Buffer.from(decoded).toString("hex");
            throw new Error(`Invalid Solana base58 byte length: ${decoded.length} (expected 32 or 64)`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Invalid Solana key — expected hex (64 chars), base58 (Phantom export), or JSON byte array. Inner: ${msg}`);
          }
        };

        // Resolve vault passphrase (precedence: --passphrase > OWS_PASSPHRASE env > "")
        const pp = opts.passphrase
          ?? (("OWS_PASSPHRASE" in process.env) ? (process.env["OWS_PASSPHRASE"] ?? "") : "");

        let w;
        if (opts.mnemonic) {
          w = ows.importWalletMnemonic(opts.name, privateKey!, pp);
        } else if (opts.evm && opts.solana) {
          // Dual-curve: both explicit keys (OWS 1.3+ API — both must be present)
          w = ows.importWalletPrivateKey(
            opts.name,
            "",        // ignored when both secp256k1Key and ed25519Key are provided
            pp,
            undefined,
            undefined,
            opts.evm,
            normalizeSolana(opts.solana),
          );
        } else if (opts.evm) {
          // Single EVM via flag — same as positional + --chain evm
          w = ows.importWalletPrivateKey(opts.name, opts.evm, pp, undefined, "evm");
        } else if (opts.solana) {
          // Single Solana via flag — same as positional + --chain solana
          w = ows.importWalletPrivateKey(opts.name, normalizeSolana(opts.solana), pp, undefined, "solana");
        } else {
          const keyArg = opts.chain === "solana" ? normalizeSolana(privateKey!) : privateKey!;
          w = ows.importWalletPrivateKey(opts.name, keyArg, pp, undefined, opts.chain);
        }

        // Set as active wallet if none set
        const { loadSettings: ls, saveSettings: ss } = await import("../settings.js");
        const settings = ls();
        if (!settings.owsActiveWallet) {
          settings.owsActiveWallet = opts.name;
          ss(settings);
        }

        if (isJson()) return printJson(jsonOk({
          id: w.id, name: w.name, accounts: w.accounts,
        }));

        console.log(chalk.cyan.bold("\n  Key Imported to OWS Vault\n"));
        console.log(`  Name: ${chalk.white.bold(w.name)}`);
        const evmAcct = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"));
        const solAcct = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"));
        if (evmAcct) console.log(`  EVM:    ${chalk.green(evmAcct.address)}`);
        if (solAcct) console.log(`  Solana: ${chalk.green(solAcct.address)}`);
        console.log(chalk.gray(`\n  Encrypted in ~/.ows/ vault`));
        if (settings.owsActiveWallet === opts.name) {
          console.log(chalk.cyan(`  Active: yes (used by all exchanges)`));
        }
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) {
          const { jsonError } = await import("../utils.js");
          return printJson(jsonError("OWS_ERROR", msg));
        }
        console.error(chalk.red(`\n  Error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── use (set active wallet — OWS first, legacy fallback) ──

  wallet
    .command("use <name>")
    .description("Set active wallet (OWS or legacy)")
    .action(async (name: string) => {
      // Try OWS first
      try {
        const ows = loadOws();
        const w = ows.getWallet(name);

        const { loadSettings: ls, saveSettings: ss } = await import("../settings.js");
        const settings = ls();
        settings.owsActiveWallet = name;
        ss(settings);

        const evmAddr = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"))?.address ?? "-";
        const solAddr = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"))?.address ?? "-";

        if (isJson()) return printJson(jsonOk({
          wallet: name, type: "ows",
          evm: evmAddr, solana: solAddr,
          activeFor: "all exchanges",
        }));

        console.log(chalk.green(`\n  ${chalk.white.bold(name)} is now the active wallet (all exchanges)`));
        console.log(`  EVM:    ${chalk.green(evmAddr)}`);
        console.log(`  Solana: ${chalk.green(solAddr)}\n`);
        return;
      } catch {
        // Not an OWS wallet — try legacy
      }

      const store = loadStore();
      const entry = store.wallets[name];
      if (!entry) {
        console.error(chalk.red(`\n  Wallet "${name}" not found in OWS vault or legacy store.\n`));
        console.error(chalk.gray(`  Create: perp wallet generate ${name}`));
        console.error(chalk.gray(`  Import: perp wallet import <key> -n ${name}\n`));
        process.exit(1);
      }

      const exchanges = entry.type === "solana" ? ["pacifica"] : ["hyperliquid", "lighter"];
      for (const exchange of exchanges) {
        store.active[exchange] = name;
      }
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ wallet: name, type: "legacy", exchanges, address: entry.address }));

      console.log(chalk.green(`\n  ${chalk.white.bold(name)} is now active for ${chalk.cyan(exchanges.join(", "))}`));
      console.log(chalk.gray(`  Address: ${entry.address}`));
      console.log(chalk.yellow(`  Note: consider migrating to OWS: perp wallet migrate\n`));
    });

  // ── set (configure exchange key → ~/.perp/.env) ──

  wallet
    .command("set <exchange> <key>")
    .description("Set private key for an exchange")
    .option("--default", "Also set as default exchange")
    .action(async (exchange: string, key: string, opts: { default?: boolean }) => {
      // Resolve alias (hl → hyperliquid, pac → pacifica, lt → lighter)
      const aliases: Record<string, string> = { hl: "hyperliquid", pac: "pacifica", lt: "lighter" };
      const resolved = aliases[exchange.toLowerCase()] || exchange.toLowerCase();
      const info = EXCHANGE_ENV_MAP[resolved];

      if (!info) {
        if (isJson()) {
          const { jsonError } = await import("../utils.js");
          return printJson(jsonError("INVALID_PARAMS", `Unknown exchange: ${exchange}. Use: pacifica, hyperliquid, lighter, aster (or hl, pac, lt, ast)`));
        }
        console.error(chalk.red(`\n  Unknown exchange: ${exchange}`));
        console.error(chalk.gray(`  Use: pacifica, hyperliquid, lighter, aster (or hl, pac, lt, ast)\n`));
        process.exit(1);
      }

      const { valid, address } = await validateKey(info.chain, key);
      if (!valid) {
        if (isJson()) {
          const { jsonError } = await import("../utils.js");
          return printJson(jsonError("INVALID_PARAMS", `Invalid ${info.chain} private key`));
        }
        console.error(chalk.red(`\n  Invalid ${info.chain} private key.\n`));
        process.exit(1);
      }

      const normalized = info.chain === "evm"
        ? (key.startsWith("0x") ? key : `0x${key}`)
        : key;

      setEnvVar(info.envKey, normalized);

      if (opts.default) {
        const settings = loadSettings();
        settings.defaultExchange = resolved;
        saveSettings(settings);
      }

      // Auto-setup Lighter API key if setting lighter PK
      let lighterApiSetup: { apiKey?: string; accountIndex?: number; error?: string } = {};
      if (resolved === "lighter") {
        try {
          const { LighterAdapter } = await import("../exchanges/lighter.js");
          const adapter = new LighterAdapter(normalized);
          await adapter.init();
          const apiKeyIndex = 4;
          const { privateKey: apiKey } = await adapter.setupApiKey(apiKeyIndex);
          setEnvVar("LIGHTER_API_KEY", apiKey);
          setEnvVar("LIGHTER_ACCOUNT_INDEX", String(adapter.accountIndex));
          setEnvVar("LIGHTER_API_KEY_INDEX", String(apiKeyIndex));
          lighterApiSetup = { apiKey, accountIndex: adapter.accountIndex };
        } catch (e) {
          lighterApiSetup = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      const settings = loadSettings();
      const referralHint = !settings.referrals
        ? { referrals: false, hint: "Optional: 'perp settings referrals on' to support perp-cli development (no extra fees — exchange rebates only)" }
        : undefined;

      if (isJson()) return printJson(jsonOk({
        exchange: resolved, address, envFile: ENV_FILE, default: !!opts.default,
        ...(resolved === "lighter" && { lighterApiKey: lighterApiSetup }),
        ...(referralHint && { referralHint }),
      }));

      console.log(chalk.green(`\n  ${resolved} configured.`));
      console.log(`  Address:  ${chalk.green(address)}`);
      console.log(`  Saved to: ${chalk.gray("~/.perp/.env")}`);
      if (opts.default) console.log(`  Default:  ${chalk.cyan(resolved)}`);
      if (resolved === "lighter") {
        if (lighterApiSetup.apiKey) {
          console.log(chalk.green(`  API Key:  auto-registered (index: ${lighterApiSetup.accountIndex})`));
        } else {
          console.log(chalk.yellow(`  API Key:  setup failed — ${lighterApiSetup.error}`));
          console.log(chalk.gray(`  You can retry: perp wallet agent approve lighter`));
        }
      }
      if (!settings.referrals) {
        console.log(chalk.gray(`  Optional: ${chalk.cyan("perp settings referrals on")} to support perp-cli development`));
        console.log(chalk.gray(`  (no extra fees — exchange rebates only)`));
      }
      console.log();
    });

  // ── show (show configured exchanges with public addresses) ──

  wallet
    .command("show")
    .description("Show configured wallets with public addresses")
    .action(async () => {
      const stored = loadEnvFile();
      const entries: { name: string; chain: "solana" | "evm" | "apikey"; key: string; source: string }[] = [];

      for (const [exchange, info] of Object.entries(EXCHANGE_ENV_MAP)) {
        const fromFile = stored[info.envKey];
        const fromEnv = process.env[info.envKey];
        if (fromFile) {
          entries.push({ name: exchange, chain: info.chain, key: fromFile, source: "~/.perp/.env" });
        } else if (fromEnv) {
          entries.push({ name: exchange, chain: info.chain, key: fromEnv, source: "environment" });
        }
      }

      const results: { name: string; address: string; source: string }[] = [];
      for (const entry of entries) {
        const { valid, address } = await validateKey(entry.chain, entry.key);
        results.push({ name: entry.name, address: valid ? address : "(invalid key)", source: entry.source });
      }

      if (isJson()) {
        const data = results.map((r) => ({ exchange: r.name, address: r.address, source: r.source }));
        return printJson(jsonOk({ envFile: ENV_FILE, exchanges: data }));
      }

      console.log(chalk.cyan.bold("\n  Configured Wallets\n"));

      if (results.length === 0) {
        console.log(chalk.gray("  No keys configured."));
        console.log(chalk.gray(`  Run ${chalk.cyan("perp setup")} or ${chalk.cyan("perp wallet set <exchange> <key>")}\n`));
        return;
      }

      for (const { name, address, source } of results) {
        console.log(`  ${chalk.cyan(name.padEnd(14))} ${chalk.green(address)}  ${chalk.gray(source)}`);
      }
      console.log();
    });

  // ── list (OWS + legacy) ──

  wallet
    .command("list")
    .description("List all wallets (OWS vault + legacy)")
    .action(async () => {
      const { loadSettings: ls } = await import("../settings.js");
      const settings = ls();
      const activeOwsWallet = settings.owsActiveWallet;

      // OWS wallets
      let owsWallets: Array<{ name: string; id: string; accounts: Array<{ chainId: string; address: string }>; createdAt: string }> = [];
      try {
        owsWallets = loadOws().listWallets();
      } catch { /* OWS not available */ }

      // Legacy wallets
      const store = loadStore();
      const legacyEntries = Object.values(store.wallets);

      if (isJson()) {
        return printJson(jsonOk({
          ows: { wallets: owsWallets, active: activeOwsWallet },
          legacy: { wallets: store.wallets, active: store.active },
        }));
      }

      if (owsWallets.length === 0 && legacyEntries.length === 0) {
        console.log(chalk.gray("\n  No wallets found."));
        console.log(chalk.gray(`  Create: ${chalk.cyan("perp wallet generate [name]")}`));
        console.log(chalk.gray(`  Import: ${chalk.cyan("perp wallet import <key>")}\n`));
        return;
      }

      if (owsWallets.length > 0) {
        console.log(chalk.cyan.bold("\n  OWS Vault Wallets") + chalk.gray("  (encrypted, multi-chain)\n"));
        const rows = owsWallets.map(w => {
          const evmAddr = w.accounts.find(a => a.chainId.startsWith("eip155:"))?.address ?? "-";
          const solAddr = w.accounts.find(a => a.chainId.startsWith("solana:"))?.address ?? "-";
          const isActive = w.name === activeOwsWallet;
          return [
            (isActive ? chalk.cyan("*") + " " : "  ") + chalk.white.bold(w.name),
            chalk.green(evmAddr.slice(0, 10) + "..." + evmAddr.slice(-4)),
            chalk.green(solAddr.slice(0, 6) + "..." + solAddr.slice(-4)),
            chalk.gray(w.createdAt.split("T")[0]),
          ];
        });
        console.log(makeTable(["Name", "EVM Address", "Solana Address", "Created"], rows));
        if (activeOwsWallet) {
          console.log(chalk.gray(`  * = active wallet`));
        }
      }

      if (legacyEntries.length > 0) {
        const activeMap = new Map<string, string[]>();
        for (const [exchange, walletName] of Object.entries(store.active)) {
          if (!activeMap.has(walletName)) activeMap.set(walletName, []);
          activeMap.get(walletName)!.push(exchange);
        }

        console.log(chalk.yellow.bold("\n  Legacy Wallets") + chalk.gray("  (unencrypted, ~/.perp/wallets.json)\n"));
        const rows = legacyEntries.map(w => {
          const activeFor = activeMap.get(w.name) ?? [];
          const activeStr = activeFor.length ? chalk.cyan(activeFor.join(", ")) : chalk.gray("-");
          return [
            chalk.white.bold(w.name),
            w.type,
            chalk.green(w.address.slice(0, 10) + "..." + w.address.slice(-6)),
            activeStr,
            chalk.gray(w.createdAt.split("T")[0]),
          ];
        });
        console.log(makeTable(["Name", "Type", "Address", "Active For", "Created"], rows));
        console.log(chalk.yellow(`  Tip: migrate to OWS with ${chalk.cyan("perp wallet migrate")}`));
      }
      console.log();
    });

  // ── remove (OWS + legacy) ──

  wallet
    .command("remove <name>")
    .description("Remove a wallet (OWS or legacy)")
    .action(async (name: string) => {
      // Try OWS first
      try {
        const ows = loadOws();
        const w = ows.getWallet(name);
        ows.deleteWallet(name);

        // Clear active if this was the active wallet
        const { loadSettings: ls, saveSettings: ss } = await import("../settings.js");
        const settings = ls();
        if (settings.owsActiveWallet === name) {
          settings.owsActiveWallet = "";
          ss(settings);
        }

        if (isJson()) return printJson(jsonOk({ removed: name, id: w.id, type: "ows" }));
        console.log(chalk.yellow(`\n  OWS wallet "${name}" removed from vault.\n`));
        return;
      } catch { /* not in OWS — try legacy */ }

      const store = loadStore();
      if (!store.wallets[name]) {
        console.error(chalk.red(`\n  Wallet "${name}" not found.\n`));
        process.exit(1);
      }

      const address = store.wallets[name].address;
      delete store.wallets[name];
      for (const [exchange, walletName] of Object.entries(store.active)) {
        if (walletName === name) delete store.active[exchange];
      }
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ removed: name, address, type: "legacy" }));
      console.log(chalk.yellow(`\n  Legacy wallet "${name}" removed.`));
      console.log(chalk.gray(`  Address was: ${address}\n`));
    });

  // ── rename ──

  wallet
    .command("rename <oldName> <newName>")
    .description("Rename a wallet")
    .action(async (oldName: string, newName: string) => {
      const store = loadStore();
      if (!store.wallets[oldName]) {
        console.error(chalk.red(`\n  Wallet "${oldName}" not found.\n`));
        process.exit(1);
      }
      if (store.wallets[newName]) {
        console.error(chalk.red(`\n  Wallet "${newName}" already exists.\n`));
        process.exit(1);
      }

      store.wallets[newName] = { ...store.wallets[oldName], name: newName };
      delete store.wallets[oldName];

      // Update active references
      for (const [exchange, walletName] of Object.entries(store.active)) {
        if (walletName === oldName) store.active[exchange] = newName;
      }
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ renamed: { from: oldName, to: newName } }));
      console.log(chalk.green(`\n  Renamed "${oldName}" -> "${newName}"\n`));
    });

  // ── balance (by wallet name) ──

  wallet
    .command("balance [name]")
    .description("Check on-chain balance for a saved wallet (or active wallet)")
    .option("--testnet", "Use testnet", false)
    .action(async (name: string | undefined, opts: { testnet: boolean }) => {
      const store = loadStore();

      let entry: WalletEntry | undefined;

      if (name) {
        entry = store.wallets[name];
        if (!entry) {
          // Try OWS vault before failing — balance only needs address + chain type
          try {
            const { loadOws } = await import("../signer/ows-loader.js");
            const ows = loadOws();
            const owsWallet = ows.getWallet(name);
            const evmAccount = owsWallet.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"));
            const solAccount = owsWallet.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"));
            const account = evmAccount ?? solAccount;
            if (account) {
              entry = {
                name,
                type: evmAccount ? "evm" : "solana",
                address: account.address,
                privateKey: "",  // OWS wallet — PK stays encrypted in vault
                createdAt: new Date().toISOString(),
              };
            }
          } catch { /* not in OWS either */ }
        }
        if (!entry) {
          if (isJson()) {
            printJson({ ok: false, error: { code: "KEY_NOT_FOUND", message: `Wallet "${name}" not found in OWS vault or legacy store.` }, meta: { timestamp: new Date().toISOString() } });
          } else {
            console.error(chalk.red(`\n  Wallet "${name}" not found.\n`));
          }
          process.exit(1);
        }
      } else {
        // Show all active wallets
        const activeEntries = Object.entries(store.active)
          .map(([ex, wn]) => ({ exchange: ex, ...store.wallets[wn] }))
          .filter((e) => e.address);

        // Fallback to .env-based wallets when no named wallets are active
        if (activeEntries.length === 0) {
          const stored = loadEnvFile();
          const envEntries: { exchange: string; chain: "solana" | "evm"; address: string }[] = [];
          for (const [exchange, info] of Object.entries(EXCHANGE_ENV_MAP)) {
            if (info.chain === "apikey") continue; // API key exchanges don't have on-chain addresses
            const key = stored[info.envKey] || process.env[info.envKey];
            if (key) {
              const { valid, address } = await validateKey(info.chain, key);
              if (valid) envEntries.push({ exchange, chain: info.chain, address });
            }
          }

          if (envEntries.length === 0) {
            if (isJson()) {
              printJson({ ok: false, error: { code: "INVALID_PARAMS", message: "No wallets configured. Run 'perp setup' or 'perp wallet set <exchange> <key>'." }, meta: { timestamp: new Date().toISOString() } });
            } else {
              console.error(chalk.gray("\n  No wallets configured. Run 'perp setup' or 'perp wallet set <exchange> <key>'.\n"));
            }
            process.exit(1);
          }

          for (const we of envEntries) {
            if (!isJson()) console.log(chalk.cyan.bold(`\n  ${we.exchange} (${we.address.slice(0, 8)}...)`));
            const balances = we.chain === "solana"
              ? await getSolanaBalances(we.address, opts.testnet)
              : await getEvmBalances(we.address, opts.testnet);

            if (isJson()) { printJson(jsonOk({ exchange: we.exchange, address: we.address, balances })); continue; }

            const rows = balances.map((b) => [
              chalk.white.bold(b.token), b.balance, b.usdValue || chalk.gray("-"),
            ]);
            console.log(makeTable(["Token", "Balance", "USD Value"], rows));
          }
          console.log();
          return;
        }

        for (const ae of activeEntries) {
          if (!isJson()) console.log(chalk.cyan.bold(`\n  ${ae.name} (${ae.exchange})`));
          const balances = ae.type === "solana"
            ? await getSolanaBalances(ae.address, opts.testnet)
            : await getEvmBalances(ae.address, opts.testnet);

          if (isJson()) { printJson(jsonOk({ wallet: ae.name, exchange: ae.exchange, balances })); continue; }

          const rows = balances.map((b) => [
            chalk.white.bold(b.token), b.balance, b.usdValue || chalk.gray("-"),
          ]);
          console.log(makeTable(["Token", "Balance", "USD Value"], rows));
        }
        console.log();
        return;
      }

      if (!isJson()) console.log(chalk.cyan(`\n  Fetching balance for "${entry.name}" (${entry.address.slice(0, 8)}...)\n`));
      const balances = entry.type === "solana"
        ? await getSolanaBalances(entry.address, opts.testnet)
        : await getEvmBalances(entry.address, opts.testnet);

      if (isJson()) return printJson(jsonOk({ wallet: entry.name, balances }));

      const rows = balances.map((b) => [
        chalk.white.bold(b.token), b.balance, b.usdValue || chalk.gray("-"),
      ]);
      console.log(makeTable(["Token", "Balance", "USD Value"], rows));
      console.log();
    });

  // ── direct address balance (kept for convenience) ──

  wallet
    .command("solana <address>")
    .description("Check Solana wallet balances by address")
    .option("--testnet", "Use devnet", false)
    .action(async (address: string, opts: { testnet: boolean }) => {
      if (!isJson()) console.log(chalk.cyan(`\n  Fetching Solana balances for ${address.slice(0, 8)}...${address.slice(-4)}\n`));
      const balances = await getSolanaBalances(address, opts.testnet);
      if (isJson()) return printJson(jsonOk(balances));
      const rows = balances.map((b) => [chalk.white.bold(b.token), b.balance, b.usdValue || chalk.gray("-")]);
      console.log(makeTable(["Token", "Balance", "USD Value"], rows));
      console.log(chalk.gray(`\n  Network: ${opts.testnet ? "Devnet" : "Mainnet"}\n`));
    });

  wallet
    .command("arbitrum <address>")
    .description("Check Arbitrum wallet balances by address")
    .option("--testnet", "Use Sepolia testnet", false)
    .action(async (address: string, opts: { testnet: boolean }) => {
      if (!isJson()) console.log(chalk.cyan(`\n  Fetching Arbitrum balances for ${address.slice(0, 8)}...${address.slice(-4)}\n`));
      const balances = await getEvmBalances(address, opts.testnet);
      if (isJson()) return printJson(jsonOk(balances));
      const rows = balances.map((b) => [chalk.white.bold(b.token), b.balance, b.usdValue || chalk.gray("-")]);
      console.log(makeTable(["Token", "Balance", "USD Value"], rows));
      console.log(chalk.gray(`\n  Network: Arbitrum ${opts.testnet ? "Sepolia" : "One"}\n`));
    });

  // ── migrate (legacy → OWS) ──

  wallet
    .command("migrate")
    .description("Migrate legacy wallets (wallets.json) to OWS encrypted vault")
    .action(async () => {
      const store = loadStore();
      const entries = Object.values(store.wallets);

      if (entries.length === 0) {
        if (isJson()) return printJson(jsonOk({ migrated: 0 }));
        console.log(chalk.gray("\n  No legacy wallets to migrate.\n"));
        return;
      }

      const ows = loadOws();
      const results: Array<{ name: string; status: string; error?: string }> = [];

      for (const entry of entries) {
        try {
          try { ows.getWallet(entry.name); results.push({ name: entry.name, status: "skipped (already in OWS)" }); continue; } catch { /* good — doesn't exist */ }

          const chain = entry.type === "solana" ? "solana" : "evm";
          let pk = entry.privateKey;

          // OWS expects hex private keys — convert bs58 Solana keys
          if (chain === "solana" && !pk.startsWith("0x")) {
            try {
              const bs58 = (await import("bs58")).default;
              const bytes = bs58.decode(pk);
              const keyBytes = bytes.length === 64 ? bytes.slice(0, 32) : bytes;
              pk = "0x" + Buffer.from(keyBytes).toString("hex");
            } catch {
              // If it's already hex or a JSON array, try as-is
            }
          }

          ows.importWalletPrivateKey(entry.name, pk, "", undefined, chain);
          results.push({ name: entry.name, status: "migrated" });
        } catch (e) {
          results.push({ name: entry.name, status: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Set first migrated wallet as active if none set
      const { loadSettings: ls, saveSettings: ss } = await import("../settings.js");
      const settings = ls();
      if (!settings.owsActiveWallet) {
        const firstMigrated = results.find(r => r.status === "migrated");
        if (firstMigrated) {
          settings.owsActiveWallet = firstMigrated.name;
          ss(settings);
        }
      }

      if (isJson()) return printJson(jsonOk({ results }));

      console.log(chalk.cyan.bold("\n  Migration Results\n"));
      for (const r of results) {
        const icon = r.status === "migrated" ? chalk.green("OK") : r.status.startsWith("skipped") ? chalk.yellow("SKIP") : chalk.red("FAIL");
        console.log(`  ${icon}  ${chalk.white.bold(r.name)} — ${r.status}${r.error ? ` (${r.error})` : ""}`);
      }
      const migrated = results.filter(r => r.status === "migrated").length;
      if (migrated > 0) {
        console.log(chalk.green(`\n  ${migrated} wallet(s) migrated to OWS vault.`));
        console.log(chalk.gray("  Keys are now encrypted at ~/.ows/"));
        console.log(chalk.yellow("  You can remove legacy wallets.json after verifying.\n"));
      } else {
        console.log();
      }
    });

  // ── Policy Engine (OWS) ──────────────────────────────────────────────
  // OWS-side guardrail: rules an agent API key must satisfy at sign time.

  const policyCmd = wallet.command("policy").description("Policy engine — guardrails for agent signing");

  policyCmd
    .command("create")
    .description("Create a signing policy")
    .requiredOption("--id <id>", "Unique policy ID")
    .requiredOption("--name <name>", "Human-readable policy name")
    .option("--chains <chains>", "Comma-separated allowed CAIP-2 chain IDs")
    .option("--expires <iso>", "Policy expiry (ISO-8601 timestamp)")
    .option("--executable <path>", "Path to custom policy executable")
    .option("--perp-defaults", "Auto-configure with perp-cli guardrail (DEX contracts + spending limits)")
    .option("--max-tx-usd <amount>", "Max per-transaction USD", "1000")
    .option("--max-daily-usd <amount>", "Max daily spending USD", "5000")
    .option("--max-withdraw-usd <amount>", "Max per-withdrawal USD", "500")
    .option("--max-daily-withdraw-usd <amount>", "Max daily withdrawal USD", "2000")
    .option("--block-approve", "Block approve() and transferFrom() calls")
    .action(async (opts: { id: string; name: string; chains?: string; expires?: string; executable?: string; perpDefaults?: boolean; maxTxUsd?: string; maxDailyUsd?: string; maxWithdrawUsd?: string; maxDailyWithdrawUsd?: string; blockApprove?: boolean }) => {
      try {
        const o = loadOws();
        const rules: Array<Record<string, unknown>> = [];
        if (opts.perpDefaults) {
          const { ALLOWED_CHAINS } = await import("../guardrail/contracts.js");
          rules.push({ type: "allowed_chains", chain_ids: ALLOWED_CHAINS });
        } else if (opts.chains) {
          rules.push({ type: "allowed_chains", chain_ids: opts.chains.split(",").map(s => s.trim()) });
        }
        if (opts.expires) {
          rules.push({ type: "expires_at", timestamp: opts.expires });
        }

        let executablePath = opts.executable;
        let config: Record<string, unknown> | undefined;
        if (opts.perpDefaults) {
          const { resolve: pathResolve } = await import("path");
          try {
            const { createRequire: cr } = await import("node:module");
            const req = cr(import.meta.url);
            executablePath = pathResolve(req.resolve("perp-cli/dist/guardrail/perp-guardrail.js"));
          } catch {
            executablePath = pathResolve(process.cwd(), "node_modules/.bin/perp-guardrail");
          }
          config = {
            max_tx_usd: parseInt(opts.maxTxUsd || "1000"),
            max_daily_usd: parseInt(opts.maxDailyUsd || "5000"),
            max_withdraw_usd: parseInt(opts.maxWithdrawUsd || "500"),
            max_daily_withdraw_usd: parseInt(opts.maxDailyWithdrawUsd || "2000"),
            ...(opts.blockApprove ? { block_selectors: ["0x095ea7b3", "0x23b872dd"] } : {}),
          };
        }

        const policyDef: Record<string, unknown> = {
          id: opts.id, name: opts.name, version: 1, created_at: new Date().toISOString(),
          rules, executable: executablePath || null, config: config || null, action: "deny",
        };
        o.createPolicy(JSON.stringify(policyDef));

        if (isJson()) return printJson(jsonOk(policyDef));
        console.log(chalk.green(`\n  Policy "${opts.name}" created (${opts.id})`));
        if (opts.chains || opts.perpDefaults) {
          const chainRule = rules.find(r => r.type === "allowed_chains");
          if (chainRule) console.log(`  Chains:     ${chalk.cyan((chainRule.chain_ids as string[]).length + " chains")}`);
        }
        if (opts.expires) console.log(`  Expires:    ${chalk.yellow(opts.expires)}`);
        if (executablePath) console.log(`  Executable: ${chalk.gray(executablePath)}`);
        if (config) console.log(`  Limits:     ${chalk.cyan(`$${config.max_tx_usd}/tx, $${config.max_daily_usd}/day`)}`);
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  policyCmd
    .command("list")
    .description("List all policies")
    .action(async () => {
      try {
        const o = loadOws();
        const policies = o.listPolicies();
        if (isJson()) return printJson(jsonOk({ policies }));
        if ((policies as unknown[]).length === 0) { console.log(chalk.gray("\n  No policies defined.\n")); return; }
        console.log(chalk.cyan.bold("\n  OWS Policies\n"));
        const rows = (policies as Array<{ id: string; name: string; rules: Array<{ type: string }>; created_at?: string }>).map(p => {
          const ruleTypes = p.rules.map(r => r.type).join(", ");
          return [chalk.white.bold(p.id), p.name, chalk.cyan(ruleTypes), chalk.gray(p.created_at?.split("T")[0] ?? "-")];
        });
        console.log(makeTable(["ID", "Name", "Rules", "Created"], rows));
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  policyCmd
    .command("show <id>")
    .description("Show policy details")
    .action(async (id: string) => {
      try {
        const o = loadOws();
        const p = o.getPolicy(id);
        if (isJson()) return printJson(jsonOk(p));
        console.log(chalk.cyan.bold(`\n  Policy: ${id}\n`));
        console.log(JSON.stringify(p, null, 2));
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  policyCmd
    .command("delete <id>")
    .description("Delete a policy")
    .action(async (id: string) => {
      try {
        const o = loadOws();
        o.deletePolicy(id);
        if (isJson()) return printJson(jsonOk({ deleted: id }));
        console.log(chalk.yellow(`\n  Policy "${id}" deleted.\n`));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── API Keys (OWS) ──────────────────────────────────────────────────
  // OWS-side scoped agent access tokens. NOT to be confused with
  // `wallet agent` (DEX-side delegation) — see comment near runOwsCli.

  const keyCmd = wallet.command("key").description("API key management — scoped agent access tokens");

  keyCmd
    .command("create")
    .description("Create an API key for policy-gated agent signing")
    .requiredOption("--name <name>", "Key name (e.g. trading-bot)")
    .requiredOption("--wallets <names>", "Comma-separated OWS wallet names")
    .option("--policy <ids>", "Comma-separated policy IDs to enforce")
    .option("--expires <iso>", "Key expiry (ISO-8601)")
    .option("-p, --passphrase <pass>", "Vault passphrase", "")
    .action(async (opts: { name: string; wallets: string; policy?: string; expires?: string; passphrase: string }) => {
      try {
        const o = loadOws();
        const walletIds = opts.wallets.split(",").map(s => s.trim());
        const policyIds = opts.policy ? opts.policy.split(",").map(s => s.trim()) : [];
        const result = o.createApiKey(opts.name, walletIds, policyIds, opts.passphrase, opts.expires);

        if (isJson()) return printJson(jsonOk({ id: result.id, name: result.name, token: result.token, wallets: walletIds, policies: policyIds, expires: opts.expires ?? null }));
        console.log(chalk.green.bold("\n  OWS API Key Created\n"));
        console.log(`  Name:     ${chalk.white.bold(result.name)}`);
        console.log(`  ID:       ${chalk.gray(result.id)}`);
        console.log(`  Wallets:  ${chalk.cyan(walletIds.join(", "))}`);
        if (policyIds.length) console.log(`  Policies: ${chalk.cyan(policyIds.join(", "))}`);
        if (opts.expires) console.log(`  Expires:  ${chalk.yellow(opts.expires)}`);
        console.log();
        console.log(`  Token: ${chalk.yellow.bold(result.token)}`);
        console.log(chalk.red("\n  Save this token — it will not be shown again!\n"));
        console.log(chalk.gray("  Usage: perp --ows <wallet> --ows-key <token> -e hl trade ..."));
        console.log(chalk.gray("     or: OWS_API_KEY=<token> perp --ows <wallet> -e hl trade ...\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  keyCmd
    .command("list")
    .description("List all API keys (tokens are never displayed)")
    .action(async () => {
      try {
        const o = loadOws();
        const keys = o.listApiKeys();
        if (isJson()) return printJson(jsonOk({ keys }));
        if ((keys as unknown[]).length === 0) { console.log(chalk.gray("\n  No API keys found.\n")); return; }
        console.log(chalk.cyan.bold("\n  OWS API Keys\n"));
        const rows = (keys as Array<{ id: string; name: string; created_at?: string }>).map(k => [
          chalk.white.bold(k.name), chalk.gray(k.id), chalk.gray(k.created_at?.split("T")[0] ?? "-"),
        ]);
        console.log(makeTable(["Name", "ID", "Created"], rows));
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  keyCmd
    .command("revoke <id>")
    .description("Revoke an API key (token becomes permanently invalid)")
    .action(async (id: string) => {
      try {
        const o = loadOws();
        o.revokeApiKey(id);
        if (isJson()) return printJson(jsonOk({ revoked: id }));
        console.log(chalk.yellow(`\n  API key "${id}" revoked.\n`));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── deposit (OWS-backed MoonPay on-ramp) ─────────────────────────────

  wallet
    .command("deposit <walletName>")
    .description("Create multi-chain deposit via MoonPay (auto-converts to USDC)")
    .option("-c, --chain <chain>", "Target chain for USDC delivery")
    .option("--for <exchange>", "Target exchange (auto-selects chain: hl→arbitrum, pac→solana, lt→ethereum)")
    .action(async (walletName: string, opts: { chain?: string; for?: string }) => {
      try {
        // Resolve chain from exchange if specified
        const exchangeChainMap: Record<string, string> = {
          hyperliquid: "arbitrum", hl: "arbitrum",
          pacifica: "solana", pac: "solana",
          lighter: "ethereum", lt: "ethereum",
        };
        const forExchange = opts.for;
        const chain = opts.chain || (forExchange ? exchangeChainMap[forExchange.toLowerCase()] : undefined) || "base";

        // Verify wallet exists first
        const o = loadOws();
        o.getWallet(walletName);

        // Find OWS CLI binary
        const { resolve: pathResolve } = await import("path");
        const { existsSync: fsExists } = await import("fs");

        const owsBin = [
          pathResolve(process.env.HOME || "~", ".ows", "bin", "ows"),
          "/usr/local/bin/ows",
        ].find(p => fsExists(p));

        if (!owsBin) {
          throw new Error("OWS CLI not found. Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash");
        }

        // Call OWS CLI subprocess for native MoonPay deposit
        // OWS CLI writes addresses to stderr, URL to stdout
        const owsEnv = { ...process.env, PATH: `${pathResolve(process.env.HOME || "~", ".ows", "bin")}:${process.env.PATH}` };
        try {
          const { spawnSync } = await import("child_process");
          const proc = spawnSync(owsBin, ["fund", "deposit", "--wallet", walletName, "--chain", chain], {
            encoding: "utf-8", timeout: 30000, env: owsEnv,
          });
          const stderrOutput = proc.stderr || "";
          const combined = stderrOutput + "\n" + (proc.stdout || "");

          // Parse deposit addresses
          const addresses: Record<string, string> = {};
          for (const line of combined.split("\n")) {
            const match = line.match(/^\s+(bitcoin|ethereum|solana|tron)\s+(\S+)/);
            if (match) addresses[match[1]] = match[2];
          }
          const urlMatch = combined.match(/(https:\/\/moonpay\S+)/);
          const depositUrl = urlMatch?.[1] ?? null;

          // Find our wallet's target address
          const w = o.getWallet(walletName);
          const evmAddr = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"))?.address ?? "";

          if (isJson()) {
            return printJson(jsonOk({
              wallet: walletName,
              chain,
              exchange: forExchange || null,
              targetAddress: evmAddr,
              depositAddresses: addresses,
              depositUrl,
              note: `Send any crypto to the deposit addresses. Funds auto-convert to USDC and deliver to ${evmAddr} on ${chain}.`,
            }));
          }

          // Pass through the human-readable output
          if (stderrOutput.trim()) {
            console.log();
            console.log(stderrOutput.trim());
          }
          if (depositUrl) console.log(`\n${depositUrl}`);
          console.log();
          return;
        } catch (spawnErr) {
          throw new Error(`OWS CLI deposit failed: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── Setup Wizard (one-click vault + policy + agent key) ──────────────

  wallet
    .command("setup")
    .description("One-click setup: create wallet + guardrail policy + agent API key")
    .option("-n, --name <name>", "Wallet name", "perp-trading")
    .option("--max-tx-usd <amount>", "Max per-transaction USD", "1000")
    .option("--max-daily-usd <amount>", "Max daily spending USD", "5000")
    .option("--skip-key", "Skip API key creation")
    .action(async (opts: { name: string; maxTxUsd: string; maxDailyUsd: string; skipKey?: boolean }) => {
      try {
        const o = loadOws();

        // Step 1: Create or reuse wallet
        let w;
        let walletCreated = false;
        try {
          w = o.getWallet(opts.name);
          if (!isJson()) console.log(chalk.gray(`\n  Wallet "${opts.name}" already exists. Using it.`));
        } catch {
          w = o.createWallet(opts.name, "", 12);
          walletCreated = true;
          const settings = loadSettings();
          if (!settings.owsActiveWallet) { settings.owsActiveWallet = opts.name; saveSettings(settings); }
        }

        const evmAddr = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"))?.address ?? "-";
        const solAddr = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"))?.address ?? "-";

        if (!isJson() && walletCreated) {
          console.log(chalk.green.bold(`\n  1. Wallet Created: ${opts.name}`));
          console.log(`     EVM:    ${chalk.green(evmAddr)}`);
          console.log(`     Solana: ${chalk.green(solAddr)}`);
        }

        // Step 2: Create guardrail policy
        const policyId = `perp-guardrail-${opts.name}`;
        const { ALLOWED_CHAINS } = await import("../guardrail/contracts.js");
        const { resolve: pathResolve } = await import("path");
        let executablePath: string;
        try {
          const { createRequire: cr } = await import("node:module");
          const req = cr(import.meta.url);
          executablePath = pathResolve(req.resolve("perp-cli/dist/guardrail/perp-guardrail.js"));
        } catch {
          executablePath = pathResolve(process.cwd(), "node_modules/.bin/perp-guardrail");
        }

        const policyDef = {
          id: policyId, name: `perp-cli guardrail (${opts.name})`, version: 1,
          created_at: new Date().toISOString(),
          rules: [{ type: "allowed_chains", chain_ids: ALLOWED_CHAINS }],
          executable: executablePath,
          config: {
            max_tx_usd: parseInt(opts.maxTxUsd),
            max_daily_usd: parseInt(opts.maxDailyUsd),
            max_withdraw_usd: Math.round(parseInt(opts.maxTxUsd) / 2),
            max_daily_withdraw_usd: Math.round(parseInt(opts.maxDailyUsd) / 2.5),
            block_selectors: ["0x095ea7b3", "0x23b872dd"],
          },
          action: "deny",
        };
        try { o.deletePolicy(policyId); } catch { /* doesn't exist yet */ }
        o.createPolicy(JSON.stringify(policyDef));

        if (!isJson()) {
          console.log(chalk.green.bold(`\n  2. Guardrail Policy Created: ${policyId}`));
          console.log(`     Limits: ${chalk.cyan(`$${opts.maxTxUsd}/tx, $${opts.maxDailyUsd}/day`)}`);
          console.log(`     Chains: ${chalk.cyan(`${ALLOWED_CHAINS.length} chains (all perp-cli exchanges)`)}`);
        }

        // Step 3: Create API key
        let token: string | undefined;
        let keyId: string | undefined;
        if (!opts.skipKey) {
          const keyName = `${opts.name}-agent`;
          const result = o.createApiKey(keyName, [opts.name], [policyId], "", undefined);
          token = result.token;
          keyId = result.id;
          if (!isJson()) {
            console.log(chalk.green.bold(`\n  3. Agent API Key Created: ${keyName}`));
            console.log(`     ID: ${chalk.gray(keyId)}`);
          }
        }

        if (isJson()) {
          return printJson(jsonOk({
            wallet: { name: opts.name, evm: evmAddr, solana: solAddr, created: walletCreated },
            policy: { id: policyId, maxTxUsd: parseInt(opts.maxTxUsd), maxDailyUsd: parseInt(opts.maxDailyUsd) },
            apiKey: token ? { id: keyId, token } : null,
          }));
        }

        console.log(chalk.cyan.bold("\n  ─── Setup Complete ───\n"));
        if (token) {
          console.log(`  ${chalk.yellow.bold("Agent Token:")} ${chalk.yellow(token)}`);
          console.log(chalk.red("  Save this token — it will not be shown again!\n"));
          console.log(chalk.white.bold("  Usage:\n"));
          console.log(chalk.gray("  # Owner mode (no policy limits):"));
          console.log(`  ${chalk.cyan(`perp --ows ${opts.name} -e hl trade buy ETH 0.1`)}\n`);
          console.log(chalk.gray("  # Agent mode (policy enforced):"));
          console.log(`  ${chalk.cyan(`perp --ows ${opts.name} --ows-key ${token.slice(0, 16)}... -e hl trade buy ETH 0.1`)}\n`);
        }
        console.log(chalk.gray("  Fund your wallet before trading:"));
        console.log(`  ${chalk.cyan(`perp wallet deposit ${opts.name} --for hl`)}   ${chalk.gray("(Hyperliquid → Arbitrum USDC)")}`);
        console.log(`  ${chalk.cyan(`perp wallet deposit ${opts.name} --for pac`)}  ${chalk.gray("(Pacifica → Solana USDC)")}`);
        console.log(`  ${chalk.cyan(`perp wallet deposit ${opts.name} --for lt`)}   ${chalk.gray("(Lighter → Ethereum USDC)")}\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS setup error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── Backup / Restore (encrypted vault archive) ────────────────────────

  wallet
    .command("backup")
    .description("Backup entire OWS vault (encrypted archive)")
    .option("-o, --output <path>", "Output file path", `ows-backup-${new Date().toISOString().split("T")[0]}.tar.gz.enc`)
    .action(async (opts: { output: string }) => {
      try {
        const { stdout, stderr } = await runOwsCli(["backup", "--output", opts.output]);
        if (isJson()) return printJson(jsonOk({ backup: opts.output, output: stderr || stdout }));
        if (stderr) console.log("\n" + stderr);
        if (stdout) console.log(stdout);
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  wallet
    .command("restore <file>")
    .description("Restore OWS vault from encrypted backup")
    .action(async (file: string) => {
      try {
        const { stdout, stderr } = await runOwsCli(["restore", "--input", file]);
        if (isJson()) return printJson(jsonOk({ restored: file, output: stderr || stdout }));
        if (stderr) console.log("\n" + stderr);
        if (stdout) console.log(stdout);
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── Key rotation (create new wallet + transfer assets) ───────────────

  wallet
    .command("rotate")
    .description("Rotate wallet keys (create new wallet + transfer assets)")
    .requiredOption("--from <name>", "Source wallet name")
    .requiredOption("--to <name>", "Target wallet name (created if not exists)")
    .option("--chain <chain>", "Chain to rotate on", "evm")
    .action(async (opts: { from: string; to: string; chain: string }) => {
      try {
        const chainMap: Record<string, string> = { evm: "eip155:1", arbitrum: "eip155:42161", base: "eip155:8453", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" };
        const chainArg = chainMap[opts.chain] || opts.chain;
        const { stdout, stderr } = await runOwsCli(["wallet", "rotate", "--from", opts.from, "--to", opts.to, "--chain", chainArg], 120000);
        if (isJson()) return printJson(jsonOk({ from: opts.from, to: opts.to, chain: chainArg, output: stderr || stdout }));
        if (stderr) console.log("\n" + stderr);
        if (stdout) console.log(stdout);
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── Agent (DEX-side delegation) ──────────────────────────────────────
  // NOTE: Distinct from `wallet key` (OWS API token) and `wallet policy`
  // (OWS guardrail). See runOwsCli comment above for the three-way split.
  registerWalletAgentCommands(wallet, isJson);

  // ── Manage (per-DEX exchange settings — Pacifica + Lighter) ──────────
  // Absorbed from former top-level `perp manage`. Holds exchange-specific
  // settings: margin mode, subaccount, lake, builder/referral, API keys.
  // Skipped when adapter wiring isn't supplied (test programs may register
  // wallet without adapters).
  if (getAdapter && getPacificaAdapter) {
    registerWalletManageCommands(wallet, getAdapter, isJson, getPacificaAdapter);
  }
}

