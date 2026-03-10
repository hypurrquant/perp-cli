import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { loadSettings, saveSettings } from "../settings.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const WALLETS_FILE = resolve(PERP_DIR, "wallets.json");

interface WalletEntry {
  name: string;
  type: "solana" | "evm";
  address: string;
  privateKey: string;
  createdAt: string;
}

interface WalletStore {
  wallets: Record<string, WalletEntry>;
  active: Record<string, string>;
}

function loadStore(): WalletStore {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(WALLETS_FILE)) return { wallets: {}, active: {} };
  try {
    return JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));
  } catch {
    return { wallets: {}, active: {} };
  }
}

function saveStore(store: WalletStore) {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(WALLETS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function askChoice(rl: ReturnType<typeof createInterface>, question: string, choices: string[]): Promise<string> {
  return new Promise((resolve) => {
    const choiceStr = choices.map((c, i) => `${i + 1}) ${c}`).join("  ");
    rl.question(`${question} [${choiceStr}]: `, (answer) => {
      const trimmed = answer.trim();
      const idx = parseInt(trimmed) - 1;
      if (idx >= 0 && idx < choices.length) return resolve(choices[idx]);
      // Try matching by name
      const match = choices.find((c) => c.toLowerCase().startsWith(trimmed.toLowerCase()));
      resolve(match || choices[0]);
    });
  });
}

export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Interactive setup wizard — configure wallets & exchanges")
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      try {
        console.log(chalk.cyan.bold("\n  perp-cli Setup Wizard\n"));
        console.log(chalk.gray("  This will help you configure wallets for trading.\n"));

        const store = loadStore();

        // Check existing setup
        const existingWallets = Object.keys(store.wallets);
        if (existingWallets.length > 0) {
          console.log(chalk.white(`  Found ${existingWallets.length} existing wallet(s):`));
          for (const name of existingWallets) {
            const w = store.wallets[name];
            const activeFor = Object.entries(store.active)
              .filter(([, v]) => v === name)
              .map(([k]) => k);
            const activeStr = activeFor.length ? chalk.cyan(` (active: ${activeFor.join(", ")})`) : "";
            console.log(`    ${chalk.white.bold(w.name)} ${chalk.gray(w.type)} ${w.address.slice(0, 8)}...${activeStr}`);
          }
          console.log();

          const action = await askChoice(rl, "  Add another wallet or reconfigure?", ["add", "reconfigure", "exit"]);
          if (action === "exit") {
            console.log(chalk.gray("\n  Setup complete. Run 'perp status' to get started.\n"));
            rl.close();
            return;
          }
          if (action === "reconfigure") {
            await reconfigure(rl, store);
            rl.close();
            return;
          }
        }

        // Which exchange(s)?
        console.log(chalk.white("  Supported exchanges:"));
        console.log(`    1) ${chalk.cyan("Pacifica")}    ${chalk.gray("— Solana-based perps")}`);
        console.log(`    2) ${chalk.cyan("Hyperliquid")} ${chalk.gray("— EVM (Arbitrum) perps")}`);
        console.log(`    3) ${chalk.cyan("Lighter")}     ${chalk.gray("— EVM (Ethereum/Arb) perps")}`);
        console.log();

        const exchangeChoice = await ask(rl, "  Which exchange(s)? (1,2,3 or 'all'): ");
        const selected = parseExchangeChoice(exchangeChoice);

        if (selected.length === 0) {
          console.log(chalk.red("\n  No exchanges selected.\n"));
          rl.close();
          return;
        }

        const needsSolana = selected.includes("pacifica");
        const needsEvm = selected.includes("hyperliquid") || selected.includes("lighter");

        // Solana wallet setup
        if (needsSolana) {
          console.log(chalk.cyan.bold("\n  Solana Wallet Setup") + chalk.gray(" (for Pacifica)\n"));
          await setupWallet(rl, store, "solana", ["pacifica"]);
        }

        // EVM wallet setup
        if (needsEvm) {
          const evmExchanges = selected.filter((e) => e !== "pacifica");
          console.log(chalk.cyan.bold("\n  EVM Wallet Setup") + chalk.gray(` (for ${evmExchanges.join(", ")})\n`));
          await setupWallet(rl, store, "evm", evmExchanges);
        }

        saveStore(store);

        // Set default exchange if only one selected
        const settings = loadSettings();
        if (selected.length === 1) {
          settings.defaultExchange = selected[0];
          saveSettings(settings);
        } else if (!settings.defaultExchange) {
          const defaultEx = await askChoice(rl, "\n  Default exchange for CLI?", selected);
          settings.defaultExchange = defaultEx;
          saveSettings(settings);
        }

        // Summary
        console.log(chalk.cyan.bold("\n  Setup Complete!\n"));

        const activeExchanges = Object.entries(store.active);
        if (activeExchanges.length > 0) {
          console.log(chalk.white("  Active wallets:"));
          for (const [exchange, walletName] of activeExchanges) {
            const w = store.wallets[walletName];
            if (w) {
              console.log(`    ${chalk.cyan(exchange.padEnd(14))} ${chalk.white.bold(walletName)} ${chalk.gray(w.address.slice(0, 10) + "...")}`);
            }
          }
        }

        const finalSettings = loadSettings();
        if (finalSettings.defaultExchange) {
          console.log(`  Default:  ${chalk.cyan(finalSettings.defaultExchange)} ${chalk.gray("(change: perp settings set default-exchange <name>)")}`);
        }

        // Next steps
        console.log(chalk.white.bold("\n  Next steps:"));
        if (selected.includes("pacifica")) {
          console.log(`    ${chalk.green("perp deposit pacifica <amount>")}  ${chalk.gray("— deposit USDC")}`);
        }
        if (selected.includes("hyperliquid")) {
          console.log(`    ${chalk.green("perp deposit hyperliquid <amount>")}  ${chalk.gray("— deposit USDC")}`);
        }
        if (selected.includes("lighter")) {
          console.log(`    ${chalk.green("perp deposit lighter info")}  ${chalk.gray("— see deposit routes")}`);
        }
        console.log(`    ${chalk.green("perp status")}  ${chalk.gray("— check account status")}`);
        console.log(`    ${chalk.green("perp wallet list")}  ${chalk.gray("— view all wallets")}`);
        console.log(`    ${chalk.green("perp wallet balance")}  ${chalk.gray("— check on-chain balances")}`);
        console.log();

        rl.close();
      } catch (err) {
        rl.close();
        throw err;
      }
    });
}

function parseExchangeChoice(input: string): string[] {
  const lower = input.toLowerCase().trim();
  if (lower === "all" || lower === "1,2,3") return ["pacifica", "hyperliquid", "lighter"];

  const exchanges: string[] = [];
  const parts = lower.split(/[,\s]+/);
  for (const p of parts) {
    if (p === "1" || p.startsWith("pac")) exchanges.push("pacifica");
    else if (p === "2" || p.startsWith("hyp") || p === "hl") exchanges.push("hyperliquid");
    else if (p === "3" || p.startsWith("lig") || p === "lt") exchanges.push("lighter");
  }
  return [...new Set(exchanges)];
}

async function setupWallet(
  rl: ReturnType<typeof createInterface>,
  store: WalletStore,
  type: "solana" | "evm",
  exchanges: string[],
) {
  // Check if there's already a wallet of this type
  const existing = Object.values(store.wallets).filter((w) => w.type === type);
  if (existing.length > 0) {
    console.log(chalk.gray(`  Existing ${type} wallet(s): ${existing.map((w) => w.name).join(", ")}`));
    const reuse = await askChoice(rl, "  Use existing or create new?", ["existing", "new"]);
    if (reuse === "existing") {
      const walletName = existing.length === 1
        ? existing[0].name
        : await ask(rl, `  Which wallet? (${existing.map((w) => w.name).join(", ")}): `) || existing[0].name;
      const wallet = store.wallets[walletName];
      if (wallet) {
        for (const ex of exchanges) store.active[ex] = walletName;
        console.log(chalk.green(`  Using "${walletName}" for ${exchanges.join(", ")}`));
        return;
      }
    }
  }

  const action = await askChoice(rl, "  Generate new wallet or import existing key?", ["generate", "import"]);

  if (action === "generate") {
    const defaultName = type === "solana" ? "default-sol" : "default-evm";
    const nameInput = await ask(rl, `  Wallet name (${defaultName}): `);
    const name = nameInput || defaultName;

    if (store.wallets[name]) {
      console.log(chalk.yellow(`  "${name}" already exists, using it.`));
      for (const ex of exchanges) store.active[ex] = name;
      return;
    }

    if (type === "solana") {
      const { Keypair } = await import("@solana/web3.js");
      const bs58 = (await import("bs58")).default;
      const keypair = Keypair.generate();
      store.wallets[name] = {
        name, type: "solana",
        address: keypair.publicKey.toBase58(),
        privateKey: bs58.encode(keypair.secretKey),
        createdAt: new Date().toISOString(),
      };
    } else {
      const { ethers } = await import("ethers");
      const w = ethers.Wallet.createRandom();
      store.wallets[name] = {
        name, type: "evm",
        address: w.address,
        privateKey: w.privateKey,
        createdAt: new Date().toISOString(),
      };
    }

    for (const ex of exchanges) store.active[ex] = name;
    const entry = store.wallets[name];
    console.log(chalk.green(`\n  Created: ${chalk.white.bold(name)}`));
    console.log(`  Address: ${chalk.green(entry.address)}`);
    console.log(chalk.red.bold("  Back up ~/.perp/wallets.json — keys cannot be recovered!"));
  } else {
    // Import
    const defaultName = type === "solana" ? "imported-sol" : "imported-evm";
    const nameInput = await ask(rl, `  Wallet name (${defaultName}): `);
    const name = nameInput || defaultName;

    if (store.wallets[name]) {
      console.log(chalk.yellow(`  "${name}" already exists, using it.`));
      for (const ex of exchanges) store.active[ex] = name;
      return;
    }

    const key = await ask(rl, `  Private key: `);
    if (!key) {
      console.log(chalk.red("  No key provided, skipping."));
      return;
    }

    let address: string;
    let normalizedKey = key;

    if (type === "solana") {
      try {
        const { Keypair } = await import("@solana/web3.js");
        const bs58 = (await import("bs58")).default;
        try {
          const bytes = bs58.decode(key);
          const kp = Keypair.fromSecretKey(bytes);
          address = kp.publicKey.toBase58();
          normalizedKey = bs58.encode(kp.secretKey);
        } catch {
          const arr = JSON.parse(key);
          const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
          address = kp.publicKey.toBase58();
          normalizedKey = bs58.encode(kp.secretKey);
        }
      } catch {
        console.log(chalk.red("  Invalid Solana key, skipping."));
        return;
      }
    } else {
      try {
        const { ethers } = await import("ethers");
        const pk = key.startsWith("0x") ? key : `0x${key}`;
        address = new ethers.Wallet(pk).address;
        normalizedKey = pk;
      } catch {
        console.log(chalk.red("  Invalid EVM key, skipping."));
        return;
      }
    }

    store.wallets[name] = {
      name, type, address, privateKey: normalizedKey,
      createdAt: new Date().toISOString(),
    };
    for (const ex of exchanges) store.active[ex] = name;

    console.log(chalk.green(`\n  Imported: ${chalk.white.bold(name)}`));
    console.log(`  Address:  ${chalk.green(address)}`);
  }
}

async function reconfigure(
  rl: ReturnType<typeof createInterface>,
  store: WalletStore,
) {
  console.log(chalk.cyan.bold("\n  Reconfigure Active Wallets\n"));

  const walletNames = Object.keys(store.wallets);
  if (walletNames.length === 0) {
    console.log(chalk.gray("  No wallets found. Run 'perp init' again to create one.\n"));
    return;
  }

  const solWallets = Object.values(store.wallets).filter((w) => w.type === "solana");
  const evmWallets = Object.values(store.wallets).filter((w) => w.type === "evm");

  // Pacifica
  if (solWallets.length > 0) {
    const current = store.active.pacifica;
    const currentStr = current ? chalk.gray(` (current: ${current})`) : "";
    const choice = await ask(rl, `  Pacifica wallet${currentStr} (${solWallets.map((w) => w.name).join(", ")} or 'skip'): `);
    if (choice && choice !== "skip") {
      const wallet = solWallets.find((w) => w.name === choice);
      if (wallet) {
        store.active.pacifica = wallet.name;
        console.log(chalk.green(`  Set "${wallet.name}" for pacifica`));
      }
    }
  }

  // HL + Lighter
  if (evmWallets.length > 0) {
    for (const exchange of ["hyperliquid", "lighter"]) {
      const current = store.active[exchange];
      const currentStr = current ? chalk.gray(` (current: ${current})`) : "";
      const choice = await ask(rl, `  ${exchange} wallet${currentStr} (${evmWallets.map((w) => w.name).join(", ")} or 'skip'): `);
      if (choice && choice !== "skip") {
        const wallet = evmWallets.find((w) => w.name === choice);
        if (wallet) {
          store.active[exchange] = wallet.name;
          console.log(chalk.green(`  Set "${wallet.name}" for ${exchange}`));
        }
      }
    }
  }

  saveStore(store);
  console.log(chalk.green("\n  Configuration saved.\n"));
}
