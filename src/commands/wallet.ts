import { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";

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

/** Exported so config.ts can resolve the active wallet key */
export function getActiveWalletKey(exchange: string): string | null {
  const store = loadStore();
  const name = store.active[exchange];
  if (!name) return null;
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

// ── Commands ──────────────────────────────────────────────────

export function registerWalletCommands(program: Command, isJson: () => boolean) {
  const wallet = program.command("wallet").description("Wallet management & on-chain balances");

  // ── generate ──

  const generate = wallet.command("generate").description("Generate a new wallet keypair");

  generate
    .command("solana")
    .description("Generate a new Solana keypair")
    .option("-n, --name <name>", "Wallet alias name", "default-sol")
    .action(async (opts: { name: string }) => {
      const { Keypair } = await import("@solana/web3.js");
      const bs58 = (await import("bs58")).default;

      const keypair = Keypair.generate();
      const address = keypair.publicKey.toBase58();
      const privkey = bs58.encode(keypair.secretKey);

      const store = loadStore();
      if (store.wallets[opts.name]) {
        console.error(chalk.red(`\n  Wallet "${opts.name}" already exists. Use a different name or 'wallet remove' first.\n`));
        process.exit(1);
      }

      store.wallets[opts.name] = {
        name: opts.name,
        type: "solana",
        address,
        privateKey: privkey,
        createdAt: new Date().toISOString(),
      };
      // Auto-activate if no active pacifica wallet
      if (!store.active.pacifica) store.active.pacifica = opts.name;
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ name: opts.name, type: "solana", address }));

      console.log(chalk.cyan.bold("\n  New Solana Wallet\n"));
      console.log(`  Name:    ${chalk.white.bold(opts.name)}`);
      console.log(`  Address: ${chalk.green(address)}`);
      console.log(`  Key:     ${chalk.yellow(privkey.slice(0, 12))}...${chalk.gray("(stored in ~/.perp/wallets.json)")}`);
      if (store.active.pacifica === opts.name) {
        console.log(chalk.cyan(`\n  Active for: pacifica`));
      }
      console.log(chalk.red.bold("\n  Back up ~/.perp/wallets.json — keys cannot be recovered!\n"));
    });

  generate
    .command("evm")
    .description("Generate a new EVM wallet")
    .option("-n, --name <name>", "Wallet alias name", "default-evm")
    .action(async (opts: { name: string }) => {
      const { ethers } = await import("ethers");

      const w = ethers.Wallet.createRandom();

      const store = loadStore();
      if (store.wallets[opts.name]) {
        console.error(chalk.red(`\n  Wallet "${opts.name}" already exists. Use a different name or 'wallet remove' first.\n`));
        process.exit(1);
      }

      store.wallets[opts.name] = {
        name: opts.name,
        type: "evm",
        address: w.address,
        privateKey: w.privateKey,
        createdAt: new Date().toISOString(),
      };
      if (!store.active.hyperliquid) store.active.hyperliquid = opts.name;
      if (!store.active.lighter) store.active.lighter = opts.name;
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ name: opts.name, type: "evm", address: w.address }));

      console.log(chalk.cyan.bold("\n  New EVM Wallet\n"));
      console.log(`  Name:    ${chalk.white.bold(opts.name)}`);
      console.log(`  Address: ${chalk.green(w.address)}`);
      console.log(`  Key:     ${chalk.yellow(w.privateKey.slice(0, 12))}...${chalk.gray("(stored in ~/.perp/wallets.json)")}`);
      const activeFor = Object.entries(store.active)
        .filter(([, v]) => v === opts.name)
        .map(([k]) => k);
      if (activeFor.length) console.log(chalk.cyan(`\n  Active for: ${activeFor.join(", ")}`));
      console.log(chalk.red.bold("\n  Back up ~/.perp/wallets.json — keys cannot be recovered!\n"));
    });

  // ── import ──

  const importCmd = wallet.command("import").description("Import an existing private key");

  importCmd
    .command("solana <privateKey>")
    .description("Import a Solana private key (base58 or JSON array)")
    .option("-n, --name <name>", "Wallet alias name", "imported-sol")
    .action(async (privateKey: string, opts: { name: string }) => {
      let address: string;
      let normalizedKey = privateKey;
      try {
        const { Keypair } = await import("@solana/web3.js");
        const bs58 = (await import("bs58")).default;
        try {
          const bytes = bs58.decode(privateKey);
          const kp = Keypair.fromSecretKey(bytes);
          address = kp.publicKey.toBase58();
          normalizedKey = bs58.encode(kp.secretKey);
        } catch {
          const arr = JSON.parse(privateKey);
          const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
          address = kp.publicKey.toBase58();
          normalizedKey = bs58.encode(kp.secretKey);
        }
      } catch {
        console.error(chalk.red("\n  Invalid Solana private key.\n"));
        process.exit(1);
      }

      const store = loadStore();
      if (store.wallets[opts.name]) {
        console.error(chalk.red(`\n  Wallet "${opts.name}" already exists.\n`));
        process.exit(1);
      }

      store.wallets[opts.name] = {
        name: opts.name, type: "solana", address, privateKey: normalizedKey,
        createdAt: new Date().toISOString(),
      };
      if (!store.active.pacifica) store.active.pacifica = opts.name;
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ name: opts.name, type: "solana", address }));

      console.log(chalk.cyan.bold("\n  Solana Wallet Imported\n"));
      console.log(`  Name:    ${chalk.white.bold(opts.name)}`);
      console.log(`  Address: ${chalk.green(address)}\n`);
    });

  importCmd
    .command("evm <privateKey>")
    .description("Import an EVM private key (0x hex)")
    .option("-n, --name <name>", "Wallet alias name", "imported-evm")
    .action(async (privateKey: string, opts: { name: string }) => {
      const { ethers } = await import("ethers");
      const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
      let address: string;
      try {
        address = new ethers.Wallet(pk).address;
      } catch {
        console.error(chalk.red("\n  Invalid EVM private key.\n"));
        process.exit(1);
      }

      const store = loadStore();
      if (store.wallets[opts.name]) {
        console.error(chalk.red(`\n  Wallet "${opts.name}" already exists.\n`));
        process.exit(1);
      }

      store.wallets[opts.name] = {
        name: opts.name, type: "evm", address, privateKey: pk,
        createdAt: new Date().toISOString(),
      };
      if (!store.active.hyperliquid) store.active.hyperliquid = opts.name;
      if (!store.active.lighter) store.active.lighter = opts.name;
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ name: opts.name, type: "evm", address }));

      console.log(chalk.cyan.bold("\n  EVM Wallet Imported\n"));
      console.log(`  Name:    ${chalk.white.bold(opts.name)}`);
      console.log(`  Address: ${chalk.green(address)}\n`);
    });

  // ── use (set active wallet for exchange) ──

  wallet
    .command("use <name>")
    .description("Set active wallet for an exchange")
    .requiredOption("--for <exchange>", "Exchange to bind (pacifica, hyperliquid, lighter)")
    .action(async (name: string, opts: { for: string }) => {
      const store = loadStore();
      const entry = store.wallets[name];
      if (!entry) {
        console.error(chalk.red(`\n  Wallet "${name}" not found. Run 'perp wallet list' to see available wallets.\n`));
        process.exit(1);
      }

      const exchange = opts.for.toLowerCase();
      const needsSolana = exchange === "pacifica";
      if (needsSolana && entry.type !== "solana") {
        console.error(chalk.red(`\n  Pacifica requires a Solana wallet. "${name}" is EVM.\n`));
        process.exit(1);
      }
      if (!needsSolana && entry.type !== "evm") {
        console.error(chalk.red(`\n  ${exchange} requires an EVM wallet. "${name}" is Solana.\n`));
        process.exit(1);
      }

      store.active[exchange] = name;
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ exchange, wallet: name, address: entry.address }));

      console.log(chalk.green(`\n  ${chalk.white.bold(name)} is now active for ${chalk.cyan(exchange)}`));
      console.log(chalk.gray(`  Address: ${entry.address}\n`));
    });

  // ── list ──

  wallet
    .command("list")
    .description("List all saved wallets")
    .action(async () => {
      const store = loadStore();
      const entries = Object.values(store.wallets);

      if (isJson()) return printJson(jsonOk({ wallets: store.wallets, active: store.active }));

      if (entries.length === 0) {
        console.log(chalk.gray("\n  No wallets found."));
        console.log(chalk.gray("  Use 'perp wallet generate' or 'perp wallet import' to add one.\n"));
        return;
      }

      // Build reverse map: wallet name -> which exchanges it's active for
      const activeMap = new Map<string, string[]>();
      for (const [exchange, walletName] of Object.entries(store.active)) {
        if (!activeMap.has(walletName)) activeMap.set(walletName, []);
        activeMap.get(walletName)!.push(exchange);
      }

      console.log(chalk.cyan.bold("\n  Saved Wallets\n"));
      const rows = entries.map((w) => {
        const activeFor = activeMap.get(w.name) ?? [];
        const activeStr = activeFor.length
          ? chalk.cyan(activeFor.join(", "))
          : chalk.gray("-");
        return [
          chalk.white.bold(w.name),
          w.type,
          chalk.green(w.address.slice(0, 10) + "..." + w.address.slice(-6)),
          activeStr,
          chalk.gray(w.createdAt.split("T")[0]),
        ];
      });
      console.log(makeTable(["Name", "Type", "Address", "Active For", "Created"], rows));
      console.log();
    });

  // ── remove ──

  wallet
    .command("remove <name>")
    .description("Remove a saved wallet")
    .action(async (name: string) => {
      const store = loadStore();
      if (!store.wallets[name]) {
        console.error(chalk.red(`\n  Wallet "${name}" not found.\n`));
        process.exit(1);
      }

      const address = store.wallets[name].address;
      delete store.wallets[name];

      // Clear active references
      for (const [exchange, walletName] of Object.entries(store.active)) {
        if (walletName === name) delete store.active[exchange];
      }
      saveStore(store);

      if (isJson()) return printJson(jsonOk({ removed: name, address }));

      console.log(chalk.yellow(`\n  Wallet "${name}" removed.`));
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
          console.error(chalk.red(`\n  Wallet "${name}" not found.\n`));
          process.exit(1);
        }
      } else {
        // Show all active wallets
        const activeEntries = Object.entries(store.active)
          .map(([ex, wn]) => ({ exchange: ex, ...store.wallets[wn] }))
          .filter((e) => e.address);

        if (activeEntries.length === 0) {
          console.error(chalk.gray("\n  No active wallets. Use 'perp wallet use <name> -e <exchange>' to set one.\n"));
          process.exit(1);
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
}
