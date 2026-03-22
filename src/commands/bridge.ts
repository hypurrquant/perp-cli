import { Command } from "commander";
import chalk from "chalk";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";
import { logExecution } from "../execution-log.js";
import {
  getDebridgeQuote,
  executeDebridgeBridge,
  executeBestBridge,
  getBestQuote,
  getAllQuotes,
  checkDebridgeStatus,
  checkBridgeGasBalance,
  CHAIN_IDS,
  USDC_ADDRESSES,
  EXCHANGE_TO_CHAIN,
  type BridgeQuote,
} from "../bridge-engine.js";
import type { Exchange } from "../config.js";

export function registerBridgeCommands(
  program: Command,
  isJson: () => boolean
) {
  const bridge = program.command("bridge").description("Cross-chain USDC bridge (deBridge DLN). See also: perp funds bridge (CCTP V2)");

  // ── bridge chains ──

  bridge
    .command("chains")
    .description("List supported chains and USDC addresses")
    .action(async () => {
      if (isJson()) {
        return printJson(jsonOk({ chains: CHAIN_IDS, usdc: USDC_ADDRESSES, exchanges: EXCHANGE_TO_CHAIN }));
      }

      console.log(chalk.cyan.bold("\n  Supported Bridge Chains\n"));
      const rows = Object.entries(CHAIN_IDS).map(([chain, id]) => [
        chalk.white.bold(chain),
        String(id),
        USDC_ADDRESSES[chain] ? chalk.green("USDC") : chalk.gray("-"),
        USDC_ADDRESSES[chain] ? chalk.gray(USDC_ADDRESSES[chain].slice(0, 10) + "...") : "",
      ]);
      console.log(makeTable(["Chain", "Chain ID", "Token", "Address"], rows));

      console.log(chalk.cyan.bold("  Exchange → Chain Mapping\n"));
      for (const [ex, chain] of Object.entries(EXCHANGE_TO_CHAIN)) {
        console.log(`  ${chalk.white.bold(ex.padEnd(14))} → ${chain}`);
      }
      console.log(chalk.gray("\n  Bridge powered by deBridge DLN (~2s settlement)\n"));
    });

  // ── bridge quote ──

  bridge
    .command("quote")
    .description("Get bridge quotes from all providers")
    .requiredOption("--from <chain>", "Source chain (solana, arbitrum, base)")
    .requiredOption("--to <chain>", "Destination chain")
    .requiredOption("--amount <amount>", "USDC amount")
    .option("--sender <address>", "Source address")
    .option("--recipient <address>", "Destination address")
    .action(async (opts: {
      from: string; to: string; amount: string;
      sender?: string; recipient?: string;
    }) => {
      const srcChain = opts.from.toLowerCase();
      const dstChain = opts.to.toLowerCase();
      const amount = parseFloat(opts.amount);

      if (!isJson()) console.log(chalk.cyan(`\n  Fetching quotes: $${amount} USDC ${srcChain} → ${dstChain}...\n`));

      const quotes = await getAllQuotes(
        srcChain, dstChain, amount,
        opts.sender ?? "0x0000000000000000000000000000000000000000",
        opts.recipient ?? "0x0000000000000000000000000000000000000000",
      );

      if (isJson()) return printJson(jsonOk({ quotes }));

      if (quotes.length === 0) {
        console.log(chalk.red("  No providers available for this route.\n"));
        return;
      }

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      const rows = quotes.map((q, i) => {
        const tag = i === 0 ? chalk.green(" ★ BEST") : "";
        const name = PROVIDER_NAMES[q.provider] ?? q.provider;
        const feeStr = q.fee <= 0 ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
        const pct = ((q.fee / q.amountIn) * 100).toFixed(2);
        const gasTag = q.gasIncluded
          ? chalk.green("included")
          : chalk.yellow("dst gas needed");
        return [
          (i === 0 ? chalk.green.bold(name) : chalk.white(name)) + tag,
          `$${formatUsd(q.amountOut)}`,
          `${feeStr} (${pct}%)`,
          `~${q.estimatedTime}s`,
          gasTag,
        ];
      });

      console.log(chalk.cyan.bold(`  Bridge Quotes: $${formatUsd(amount)} USDC ${srcChain} → ${dstChain}\n`));
      console.log(makeTable(["Provider", "Receive", "Fee", "ETA", "Dst Gas"], rows));

      // Show gas notes per provider
      for (const q of quotes) {
        if (q.gasNote) {
          const name = PROVIDER_NAMES[q.provider] ?? q.provider;
          console.log(chalk.gray(`  ${name}: ${q.gasNote}`));
        }
      }
      console.log();
      console.log(chalk.gray(`  Execute with: perp bridge send --from ${srcChain} --to ${dstChain} --amount ${opts.amount}`));
      console.log(chalk.gray(`  Pick provider: --provider cctp|relay|debridge\n`));
    });

  // ── bridge send ──

  bridge
    .command("send")
    .description("Execute a USDC bridge transaction")
    .requiredOption("--from <chain>", "Source chain")
    .requiredOption("--to <chain>", "Destination chain")
    .requiredOption("--amount <amount>", "USDC amount")
    .option("--sender <address>", "Source address (auto-detected from key)")
    .option("--recipient <address>", "Destination address")
    .option("--provider <name>", "Force provider: cctp, relay, debridge (default: cheapest)")
    .option("--fast", "Use fast finality (~1-2 min, $1-1.3 fee, auto-relay). Default: standard (~13-20 min, $0.01, manual relay)")
    .option("--dry-run", "Show quotes without executing")
    .action(async (opts: {
      from: string; to: string; amount: string;
      sender?: string; recipient?: string; provider?: string; fast?: boolean; dryRun?: boolean;
    }) => {
      const srcChain = opts.from.toLowerCase();
      const dstChain = opts.to.toLowerCase();
      const amount = parseFloat(opts.amount);
      if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

      const chosenProvider = opts.provider?.toLowerCase() as "cctp" | "relay" | "debridge" | undefined;
      if (chosenProvider && !["cctp", "relay", "debridge"].includes(chosenProvider)) {
        throw new Error(`Invalid provider: ${opts.provider}. Use cctp, relay, or debridge.`);
      }

      // Load the appropriate private key
      const { loadPrivateKey, parseSolanaKeypair } = await import("../config.js");

      let senderAddress: string;
      let recipientAddress: string;
      let signerKey: string;

      if (srcChain === "solana") {
        const pk = await loadPrivateKey("pacifica");
        const keypair = parseSolanaKeypair(pk);
        senderAddress = opts.sender ?? keypair.publicKey.toBase58();
        signerKey = pk;
      } else {
        const exchange = "hyperliquid" as const;
        const pk = await loadPrivateKey(exchange);
        const { ethers } = await import("ethers");
        const wallet = new ethers.Wallet(pk);
        senderAddress = opts.sender ?? wallet.address;
        signerKey = pk;
      }

      // Determine recipient address and destination signer key
      let dstSignerKey: string | undefined;
      if (opts.recipient) {
        recipientAddress = opts.recipient;
      } else if (dstChain === "solana") {
        const pk = await loadPrivateKey("pacifica");
        const keypair = parseSolanaKeypair(pk);
        recipientAddress = keypair.publicKey.toBase58();
        dstSignerKey = pk;
      } else {
        const exchange = "hyperliquid" as const;
        const pk = await loadPrivateKey(exchange);
        const { ethers } = await import("ethers");
        recipientAddress = new ethers.Wallet(pk).address;
        dstSignerKey = pk;
      }

      // Fetch all quotes
      if (!isJson()) console.log(chalk.cyan(`\n  Bridge: $${amount} USDC ${srcChain} → ${dstChain}\n`));
      const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);

      if (quotes.length === 0) throw new Error(`No bridge available for ${srcChain} → ${dstChain}`);

      // Pick the quote to use
      let selectedQuote: BridgeQuote;
      if (chosenProvider) {
        const match = quotes.find(q => q.provider === chosenProvider);
        if (!match) throw new Error(`Provider "${chosenProvider}" not available for this route`);
        selectedQuote = match;
      } else {
        selectedQuote = quotes[0]; // best (sorted by amountOut)
      }

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      if (!isJson()) {
        // Show comparison table
        const rows = quotes.map((q) => {
          const name = PROVIDER_NAMES[q.provider] ?? q.provider;
          const selected = q.provider === selectedQuote.provider;
          const feeStr = q.fee <= 0 ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
          const pct = ((q.fee / q.amountIn) * 100).toFixed(2);
          const tag = selected ? chalk.green(" ← selected") : "";
          const gasTag = q.gasIncluded
            ? chalk.green("included")
            : chalk.yellow("dst gas needed");
          return [
            (selected ? chalk.green.bold(name) : chalk.white(name)) + tag,
            `$${formatUsd(q.amountOut)}`,
            `${feeStr} (${pct}%)`,
            `~${q.estimatedTime}s`,
            gasTag,
          ];
        });
        console.log(makeTable(["Provider", "Receive", "Fee", "ETA", "Dst Gas"], rows));

        if (!selectedQuote.gasIncluded) {
          console.log(chalk.yellow(`  ⚠ ${selectedQuote.gasNote}`));
        }
        console.log(`  From:     ${senderAddress}`);
        console.log(`  To:       ${recipientAddress}\n`);
      }

      if (opts.dryRun) {
        if (isJson()) return printJson(jsonOk({ quotes, selected: selectedQuote.provider }));
        console.log(chalk.yellow("  [DRY RUN] Transaction not executed.\n"));
        return;
      }

      // Gas balance preflight check
      const needsDstGas = !selectedQuote.gasIncluded;
      const gasCheck = await checkBridgeGasBalance(srcChain, senderAddress, dstChain, recipientAddress, needsDstGas);
      if (!gasCheck.ok) {
        const msg = gasCheck.errors.map(e => `  ✗ ${e}`).join("\n");
        if (isJson()) return printJson({ ok: false, error: "Insufficient gas", details: gasCheck.errors });
        console.log(chalk.red("\n  Insufficient gas for bridge:\n"));
        console.log(chalk.red(msg));
        if (needsDstGas) {
          console.log(chalk.yellow("\n  Tip: use --fast to skip destination gas (Circle auto-relays)\n"));
        }
        process.exitCode = 1;
        return;
      }

      const providerName = PROVIDER_NAMES[selectedQuote.provider] ?? selectedQuote.provider;
      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));

      let result: Awaited<ReturnType<typeof executeBestBridge>>;
      try {
        result = await executeBestBridge(srcChain, dstChain, amount, signerKey, senderAddress, recipientAddress, dstSignerKey, chosenProvider, !!opts.fast);
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcChain}->${dstChain}`, size: String(amount), status: "success", dryRun: false, meta: { provider: result.provider, txHash: result.txHash, fast: !!opts.fast } });
      } catch (err) {
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcChain}->${dstChain}`, size: String(amount), status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }

      if (isJson()) return printJson(jsonOk(result));

      console.log(chalk.green("  Bridge transaction submitted!"));
      console.log(`  TX Hash:  ${result.txHash}`);
      console.log(`  Provider: ${result.provider}`);
      if (result.receiveTxHash) {
        console.log(`  Receive:  ${result.receiveTxHash} (${dstChain})`);
      }
      console.log(chalk.gray(`\n  Funds arrive in ~${selectedQuote.estimatedTime}s on ${dstChain}.\n`));
    });

  // ── bridge between exchanges (shortcut) ──

  bridge
    .command("exchange")
    .description("Bridge USDC between exchanges (shortcut)")
    .requiredOption("--from <exchange>", "Source exchange (pacifica, hyperliquid, lighter)")
    .requiredOption("--to <exchange>", "Destination exchange")
    .requiredOption("--amount <amount>", "USDC amount")
    .option("--provider <name>", "Force provider: cctp, relay, debridge (default: cheapest)")
    .option("--fast", "Use fast finality (~1-2 min, $1-1.3 fee, auto-relay)")
    .option("--dry-run", "Show quotes without executing")
    .action(async (opts: { from: string; to: string; amount: string; provider?: string; fast?: boolean; dryRun?: boolean }) => {
      const srcExchange = opts.from.toLowerCase();
      const dstExchange = opts.to.toLowerCase();
      const srcChain = EXCHANGE_TO_CHAIN[srcExchange];
      const dstChain = EXCHANGE_TO_CHAIN[dstExchange];
      if (!srcChain) throw new Error(`Unknown exchange: ${srcExchange}`);
      if (!dstChain) throw new Error(`Unknown exchange: ${dstExchange}`);
      if (srcChain === dstChain) throw new Error("Same chain — no bridge needed");

      const chosenProvider = opts.provider?.toLowerCase() as "cctp" | "relay" | "debridge" | undefined;
      if (chosenProvider && !["cctp", "relay", "debridge"].includes(chosenProvider)) {
        throw new Error(`Invalid provider: ${opts.provider}. Use cctp, relay, or debridge.`);
      }

      const amount = parseFloat(opts.amount);
      if (!isJson()) console.log(chalk.cyan(`\n  Bridge: $${amount} USDC ${srcExchange} (${srcChain}) → ${dstExchange} (${dstChain})\n`));

      // Load keys
      const { loadPrivateKey, parseSolanaKeypair } = await import("../config.js");
      let senderAddress: string;
      let recipientAddress: string;
      let signerKey: string;

      // Source
      if (srcChain === "solana") {
        const pk = await loadPrivateKey("pacifica");
        senderAddress = parseSolanaKeypair(pk).publicKey.toBase58();
        signerKey = pk;
      } else {
        const pk = await loadPrivateKey(srcExchange as Exchange);
        const { ethers } = await import("ethers");
        senderAddress = new ethers.Wallet(pk).address;
        signerKey = pk;
      }

      // Destination
      let dstSignerKey: string | undefined;
      if (dstChain === "solana") {
        const pk = await loadPrivateKey("pacifica");
        recipientAddress = parseSolanaKeypair(pk).publicKey.toBase58();
        dstSignerKey = pk;
      } else {
        const pk = await loadPrivateKey(dstExchange as Exchange);
        const { ethers } = await import("ethers");
        recipientAddress = new ethers.Wallet(pk).address;
        dstSignerKey = pk;
      }

      const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);
      if (quotes.length === 0) throw new Error(`No bridge available for ${srcChain} → ${dstChain}`);

      let selectedQuote: BridgeQuote;
      if (chosenProvider) {
        const match = quotes.find(q => q.provider === chosenProvider);
        if (!match) throw new Error(`Provider "${chosenProvider}" not available for this route`);
        selectedQuote = match;
      } else {
        selectedQuote = quotes[0];
      }

      const PROVIDER_NAMES: Record<string, string> = {
        cctp: "Circle CCTP",
        relay: "Relay",
        debridge: "deBridge DLN",
      };

      if (!isJson()) {
        const rows = quotes.map((q) => {
          const name = PROVIDER_NAMES[q.provider] ?? q.provider;
          const selected = q.provider === selectedQuote.provider;
          const feeStr = q.fee <= 0 ? chalk.green("FREE") : `$${formatUsd(q.fee)}`;
          const pct = ((q.fee / q.amountIn) * 100).toFixed(2);
          const tag = selected ? chalk.green(" ← selected") : "";
          const gasTag = q.gasIncluded
            ? chalk.green("included")
            : chalk.yellow("dst gas needed");
          return [
            (selected ? chalk.green.bold(name) : chalk.white(name)) + tag,
            `$${formatUsd(q.amountOut)}`,
            `${feeStr} (${pct}%)`,
            `~${q.estimatedTime}s`,
            gasTag,
          ];
        });
        console.log(makeTable(["Provider", "Receive", "Fee", "ETA", "Dst Gas"], rows));
        if (!selectedQuote.gasIncluded) {
          console.log(chalk.yellow(`  ⚠ ${selectedQuote.gasNote}`));
        }
      }

      if (opts.dryRun) {
        if (isJson()) return printJson(jsonOk({ quotes, selected: selectedQuote.provider }));
        console.log(chalk.yellow("  [DRY RUN] Not executed.\n"));
        return;
      }

      // Gas balance preflight check
      const needsDstGas = !selectedQuote.gasIncluded;
      const gasCheck = await checkBridgeGasBalance(srcChain, senderAddress, dstChain, recipientAddress, needsDstGas);
      if (!gasCheck.ok) {
        const msg = gasCheck.errors.map(e => `  ✗ ${e}`).join("\n");
        if (isJson()) return printJson({ ok: false, error: "Insufficient gas", details: gasCheck.errors });
        console.log(chalk.red("\n  Insufficient gas for bridge:\n"));
        console.log(chalk.red(msg));
        if (needsDstGas) {
          console.log(chalk.yellow("\n  Tip: use --fast to skip destination gas (Circle auto-relays)\n"));
        }
        process.exitCode = 1;
        return;
      }

      const providerName = PROVIDER_NAMES[selectedQuote.provider] ?? selectedQuote.provider;
      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));

      let result: Awaited<ReturnType<typeof executeBestBridge>>;
      try {
        result = await executeBestBridge(srcChain, dstChain, amount, signerKey, senderAddress, recipientAddress, dstSignerKey, chosenProvider, !!opts.fast);
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcExchange}->${dstExchange}`, size: String(amount), status: "success", dryRun: false, meta: { provider: result.provider, txHash: result.txHash, fast: !!opts.fast } });
      } catch (err) {
        logExecution({ type: "bridge", exchange: "bridge", symbol: "USDC", side: `${srcExchange}->${dstExchange}`, size: String(amount), status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }

      if (isJson()) return printJson(jsonOk(result));

      console.log(chalk.green("  Bridge submitted!"));
      console.log(`  TX:       ${result.txHash}`);
      console.log(`  Provider: ${result.provider}`);
      if (result.receiveTxHash) {
        console.log(`  Receive:  ${result.receiveTxHash} (${dstChain})`);
        console.log(chalk.green(`  USDC arrived on ${dstExchange}!`));
      }
      console.log(chalk.gray(`\n  After arrival, deposit into ${dstExchange}:`));
      console.log(chalk.gray(`  perp deposit ${dstExchange} ${opts.amount}\n`));
    });

  // ── bridge status ──

  bridge
    .command("status <orderId>")
    .description("Check bridge order status")
    .action(async (orderId: string) => {
      const status = await checkDebridgeStatus(orderId);
      if (isJson()) return printJson(jsonOk(status));

      const state = String(status.status ?? status.orderStatus ?? "unknown");
      const stateColor = state.includes("Fulfilled") || state.includes("completed")
        ? chalk.green
        : state.includes("pending") ? chalk.yellow : chalk.white;

      console.log(chalk.cyan.bold("\n  Bridge Order Status\n"));
      console.log(`  Order ID: ${orderId}`);
      console.log(`  Status:   ${stateColor(state)}`);
      console.log();
    });
}
