import { Command } from "commander";
import chalk from "chalk";
import { createRequire } from "node:module";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";

const _require = createRequire(import.meta.url);
function loadOws(): typeof import("@open-wallet-standard/core") {
  return _require("@open-wallet-standard/core");
}

// ── Balance helpers (reused from wallet module) ──

async function getSolanaBalances(address: string, isTestnet: boolean) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const rpcUrl = isTestnet ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl);
  const pubkey = new PublicKey(address);
  const balances: Array<{ token: string; balance: string; usdValue: string }> = [];
  const solLamports = await connection.getBalance(pubkey);
  const solBalance = solLamports / 1e9;
  balances.push({ token: "SOL", balance: solBalance.toFixed(6), usdValue: "" });
  const usdcMint = isTestnet ? "USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(usdcMint) });
    let usdcBalance = 0;
    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (parsed) usdcBalance += Number(parsed.tokenAmount?.uiAmount ?? 0);
    }
    balances.push({ token: isTestnet ? "USDP" : "USDC", balance: usdcBalance.toFixed(2), usdValue: `$${formatUsd(usdcBalance)}` });
  } catch {
    balances.push({ token: isTestnet ? "USDP" : "USDC", balance: "0.00", usdValue: "$0.00" });
  }
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const json = (await res.json()) as Record<string, Record<string, number>>;
    balances[0].usdValue = `$${formatUsd(solBalance * (json.solana?.usd ?? 0))}`;
  } catch { balances[0].usdValue = "-"; }
  return balances;
}

async function getEvmBalances(address: string, isTestnet: boolean) {
  const { ethers } = await import("ethers");
  const rpcUrl = isTestnet ? "https://sepolia-rollup.arbitrum.io/rpc" : "https://arb1.arbitrum.io/rpc";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const balances: Array<{ token: string; balance: string; usdValue: string }> = [];
  const ethBal = await provider.getBalance(address);
  const ethBalance = Number(ethers.formatEther(ethBal));
  balances.push({ token: "ETH", balance: ethBalance.toFixed(6), usdValue: "" });
  const usdcAddr = isTestnet ? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" : "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
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
  } catch { balances[0].usdValue = "-"; }
  return balances;
}

// ── OWS CLI subprocess helper ──

async function runOwsCli(args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  const { resolve: pathResolve } = await import("path");
  const { existsSync } = await import("fs");
  const { spawnSync } = await import("child_process");

  const owsBin = [
    pathResolve(process.env.HOME || "~", ".ows", "bin", "ows"),
    "/usr/local/bin/ows",
  ].find(p => existsSync(p));

  if (!owsBin) {
    throw new Error("OWS CLI not found. Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash");
  }

  const owsEnv = { ...process.env, PATH: `${pathResolve(process.env.HOME || "~", ".ows", "bin")}:${process.env.PATH}` };
  const proc = spawnSync(owsBin, args, { encoding: "utf-8", timeout, env: owsEnv });

  if (proc.error) throw new Error(`OWS CLI failed: ${proc.error.message}`);
  return { stdout: (proc.stdout || "").trim(), stderr: (proc.stderr || "").trim() };
}

// ── Register OWS commands ──

export function registerOwsCommands(program: Command, isJson: () => boolean) {
  const ows = program.command("ows").description("Open Wallet Standard — encrypted vault, policy engine, agent access");

  // ── Wallet CRUD ──

  ows
    .command("create <name>")
    .description("Create a new OWS wallet (multi-chain: EVM + Solana)")
    .option("--words <count>", "Mnemonic word count (12 or 24)", "12")
    .action(async (name: string, opts: { words: string }) => {
      try {
        const o = loadOws();
        const w = o.createWallet(name, "", parseInt(opts.words));
        if (isJson()) return printJson(jsonOk({ id: w.id, name: w.name, accounts: w.accounts, createdAt: w.createdAt }));
        console.log(chalk.cyan.bold("\n  OWS Wallet Created\n"));
        console.log(`  Name: ${chalk.white.bold(w.name)}`);
        console.log(`  ID:   ${chalk.gray(w.id)}`);
        console.log();
        for (const acct of w.accounts) {
          const chain = acct.chainId.split(":")[0];
          console.log(`  ${chalk.cyan(chain.padEnd(10))} ${chalk.green(acct.address)}`);
        }
        console.log(chalk.gray(`\n  Vault: ~/.ows/`));
        console.log(chalk.cyan(`\n  Usage: perp --ows ${name} -e hl account balance\n`));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  ows
    .command("list")
    .description("List all OWS wallets in the vault")
    .action(async () => {
      try {
        const o = loadOws();
        const wallets = o.listWallets();
        if (isJson()) return printJson(jsonOk({ wallets }));
        if (wallets.length === 0) {
          console.log(chalk.gray("\n  No OWS wallets found."));
          console.log(chalk.gray(`  Create one: ${chalk.cyan("perp ows create <name>")}\n`));
          return;
        }
        console.log(chalk.cyan.bold("\n  OWS Vault Wallets\n"));
        const rows = wallets.map((w: { name: string; id: string; accounts: Array<{ chainId: string; address: string }>; createdAt: string }) => {
          const evmAddr = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"))?.address ?? "-";
          const solAddr = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"))?.address ?? "-";
          return [
            chalk.white.bold(w.name),
            chalk.green(evmAddr.slice(0, 10) + "..." + evmAddr.slice(-4)),
            chalk.green(solAddr.slice(0, 6) + "..." + solAddr.slice(-4)),
            chalk.gray(w.createdAt.split("T")[0]),
          ];
        });
        console.log(makeTable(["Name", "EVM Address", "Solana Address", "Created"], rows));
        console.log(chalk.gray(`\n  Usage: perp --ows <name> -e <exchange> <command>\n`));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  ows
    .command("info <name>")
    .description("Show detailed OWS wallet info")
    .action(async (name: string) => {
      try {
        const o = loadOws();
        const w = o.getWallet(name);
        if (isJson()) return printJson(jsonOk(w));
        console.log(chalk.cyan.bold(`\n  OWS Wallet: ${w.name}\n`));
        console.log(`  ID:      ${chalk.gray(w.id)}`);
        console.log(`  Created: ${chalk.gray(w.createdAt)}`);
        console.log();
        for (const acct of w.accounts) {
          console.log(`  ${chalk.cyan(acct.chainId.padEnd(40))} ${chalk.green(acct.address)}`);
          console.log(`  ${chalk.gray(" ".repeat(40) + acct.derivationPath)}`);
        }
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  ows
    .command("delete <name>")
    .description("Delete an OWS wallet from the vault")
    .action(async (name: string) => {
      try {
        const o = loadOws();
        const w = o.getWallet(name);
        o.deleteWallet(name);
        if (isJson()) return printJson(jsonOk({ deleted: name, id: w.id }));
        console.log(chalk.yellow(`\n  OWS wallet "${name}" deleted from vault.\n`));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── Policy Engine ──

  const policyCmd = ows.command("policy").description("Policy engine — guardrails for agent signing");

  policyCmd
    .command("create")
    .description("Create a signing policy")
    .requiredOption("--id <id>", "Unique policy ID")
    .requiredOption("--name <name>", "Human-readable policy name")
    .option("--chains <chains>", "Comma-separated allowed CAIP-2 chain IDs")
    .option("--expires <iso>", "Policy expiry (ISO-8601 timestamp)")
    .option("--executable <path>", "Path to custom policy executable")
    .option("--perp-defaults", "Auto-configure with perp-cli guardrail (DEX contracts + spending limits)")
    .option("--max-tx-usd <amount>", "Max per-transaction USD (with --perp-defaults)", "1000")
    .option("--max-daily-usd <amount>", "Max daily spending USD (with --perp-defaults)", "5000")
    .action(async (opts: { id: string; name: string; chains?: string; expires?: string; executable?: string; perpDefaults?: boolean; maxTxUsd?: string; maxDailyUsd?: string }) => {
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
          config = { max_tx_usd: parseInt(opts.maxTxUsd || "1000"), max_daily_usd: parseInt(opts.maxDailyUsd || "5000") };
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

  // ── API Keys ──

  const keyCmd = ows.command("key").description("API key management — scoped agent access tokens");

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

  // ── Fund (MoonPay + balance) ──

  const fundCmd = ows.command("fund").description("Funding — on-ramp & balance via OWS");

  fundCmd
    .command("balance <walletName>")
    .description("Check on-chain token balance for an OWS wallet")
    .requiredOption("-c, --chain <chain>", "Chain: evm, base, arbitrum, solana, etc.")
    .action(async (walletName: string, opts: { chain: string }) => {
      try {
        const o = loadOws();
        const w = o.getWallet(walletName);
        const chainMap: Record<string, string> = {
          evm: "eip155:", ethereum: "eip155:", base: "eip155:", arbitrum: "eip155:",
          solana: "solana:", bitcoin: "bip122:", cosmos: "cosmos:",
          tron: "tron:", ton: "ton:", sui: "sui:", filecoin: "fil:",
        };
        const prefix = chainMap[opts.chain.toLowerCase()] ?? opts.chain;
        const account = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith(prefix));
        if (!account) throw new Error(`No account found for chain "${opts.chain}" in wallet "${walletName}"`);

        const isSolana = account.chainId.startsWith("solana:");
        const balances = isSolana ? await getSolanaBalances(account.address, false) : await getEvmBalances(account.address, false);

        if (isJson()) return printJson(jsonOk({ wallet: walletName, chain: account.chainId, address: account.address, balances }));
        console.log(chalk.cyan.bold(`\n  ${walletName} — ${account.chainId}\n`));
        console.log(`  Address: ${chalk.green(account.address)}\n`);
        if (balances.length === 0) { console.log(chalk.gray("  No balances found.\n")); return; }
        const rows = balances.map((b) => [chalk.white.bold(b.token), b.balance, b.usdValue || chalk.gray("-")]);
        console.log(makeTable(["Token", "Balance", "USD Value"], rows));
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  fundCmd
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
        const { existsSync } = await import("fs");

        const owsBin = [
          pathResolve(process.env.HOME || "~", ".ows", "bin", "ows"),
          "/usr/local/bin/ows",
        ].find(p => existsSync(p));

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

  // ── x402 Payment (via OWS CLI subprocess) ──

  ows
    .command("pay <url>")
    .description("HTTP request with automatic x402 USDC payment via OWS")
    .requiredOption("--ows-wallet <name>", "OWS wallet name for payment")
    .option("-m, --method <method>", "HTTP method", "GET")
    .option("-b, --body <json>", "Request body (JSON string)")
    .action(async (url: string, opts: { owsWallet: string; method: string; body?: string }) => {
      try {
        // Verify wallet exists
        const o = loadOws();
        o.getWallet(opts.owsWallet);

        // Find OWS CLI binary
        const { resolve: pathResolve } = await import("path");
        const { existsSync } = await import("fs");
        const owsBin = [
          pathResolve(process.env.HOME || "~", ".ows", "bin", "ows"),
          "/usr/local/bin/ows",
        ].find(p => existsSync(p));

        if (!owsBin) {
          throw new Error("OWS CLI not found. Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash");
        }

        // Build OWS CLI args
        const args = ["pay", "request", url, "--wallet", opts.owsWallet];
        if (opts.method && opts.method.toUpperCase() !== "GET") {
          args.push("--method", opts.method.toUpperCase());
        }
        if (opts.body) {
          args.push("--body", opts.body);
        }
        // Use --no-passphrase for non-interactive (passphrase-less wallets)
        args.push("--no-passphrase");

        const { spawnSync } = await import("child_process");
        const owsEnv = { ...process.env, PATH: `${pathResolve(process.env.HOME || "~", ".ows", "bin")}:${process.env.PATH}` };
        const proc = spawnSync(owsBin, args, {
          encoding: "utf-8", timeout: 120000, env: owsEnv,
        });

        const stdout = (proc.stdout || "").trim();
        const stderr = (proc.stderr || "").trim();
        const combined = stderr + (stdout ? "\n" + stdout : "");

        if (proc.status !== 0 && !stdout && !stderr) {
          throw new Error("OWS pay request failed with no output");
        }

        if (isJson()) {
          // Try to parse JSON from stdout
          try {
            const parsed = JSON.parse(stdout);
            return printJson(jsonOk({ paid: true, response: parsed }));
          } catch {
            return printJson(jsonOk({ paid: !!stdout, response: stdout || stderr }));
          }
        }

        // Pass through output
        if (combined) {
          console.log();
          console.log(combined);
          console.log();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── Setup Wizard ──

  ows
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
          const { loadSettings, saveSettings } = await import("../settings.js");
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
          config: { max_tx_usd: parseInt(opts.maxTxUsd), max_daily_usd: parseInt(opts.maxDailyUsd) },
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
        console.log(`  ${chalk.cyan(`perp ows fund deposit ${opts.name} --for hl`)}   ${chalk.gray("(Hyperliquid → Arbitrum USDC)")}`);
        console.log(`  ${chalk.cyan(`perp ows fund deposit ${opts.name} --for pac`)}  ${chalk.gray("(Pacifica → Solana USDC)")}`);
        console.log(`  ${chalk.cyan(`perp ows fund deposit ${opts.name} --for lt`)}   ${chalk.gray("(Lighter → Ethereum USDC)")}\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS setup error: ${msg}\n`));
        process.exit(1);
      }
    });

  // ── Backup / Restore ──

  ows
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

  ows
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

  // ── Key Rotation ──

  ows
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

  // ── Pay Discover (x402 service directory) ──

  ows
    .command("discover")
    .description("Discover x402-enabled services (Bazaar directory)")
    .option("-q, --query <search>", "Filter services by keyword")
    .option("--limit <n>", "Max results", "20")
    .action(async (opts: { query?: string; limit: string }) => {
      try {
        const args = ["pay", "discover", "--limit", opts.limit];
        if (opts.query) args.push("--query", opts.query);
        const { stdout, stderr } = await runOwsCli(args);
        if (isJson()) return printJson(jsonOk({ services: stdout || stderr }));
        if (stderr) console.log("\n" + stderr);
        if (stdout) console.log("\n" + stdout);
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isJson()) { const { jsonError } = await import("../utils.js"); return printJson(jsonError("OWS_ERROR", msg)); }
        console.error(chalk.red(`\n  OWS error: ${msg}\n`));
        process.exit(1);
      }
    });
}
