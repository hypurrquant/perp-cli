import { Command } from "commander";
import chalk from "chalk";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";
import {
  getDebridgeQuote,
  executeDebridgeBridge,
  executeBestBridge,
  getBestQuote,
  checkDebridgeStatus,
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
  const bridge = program.command("bridge").description("Cross-chain USDC bridge (deBridge DLN)");

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
    .description("Get a bridge quote for USDC transfer")
    .requiredOption("--from <chain>", "Source chain (solana, arbitrum, ethereum, base)")
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

      if (!isJson()) console.log(chalk.cyan(`\n  Getting bridge quote: $${amount} USDC ${srcChain} → ${dstChain}...\n`));

      const quote = await getBestQuote(
        srcChain, dstChain, amount,
        opts.sender ?? "0x0000000000000000000000000000000000000000",
        opts.recipient ?? "0x0000000000000000000000000000000000000000",
      );

      if (isJson()) return printJson(jsonOk(quote));

      console.log(chalk.cyan.bold(`  ${quote.provider === "cctp" ? "Circle CCTP" : "deBridge DLN"} Quote\n`));
      console.log(`  Send:     $${formatUsd(quote.amountIn)} USDC on ${srcChain}`);
      console.log(`  Receive:  $${formatUsd(quote.amountOut)} USDC on ${dstChain}`);
      console.log(`  Fee:      $${formatUsd(quote.fee)} (${((quote.fee / quote.amountIn) * 100).toFixed(2)}%)`);
      console.log(`  ETA:      ~${quote.estimatedTime}s`);
      console.log(chalk.gray(`\n  Use 'perp bridge send --from ${srcChain} --to ${dstChain} --amount ${opts.amount}' to execute.\n`));
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
    .option("--dry-run", "Show quote without executing")
    .action(async (opts: {
      from: string; to: string; amount: string;
      sender?: string; recipient?: string; dryRun?: boolean;
    }) => {
      const srcChain = opts.from.toLowerCase();
      const dstChain = opts.to.toLowerCase();
      const amount = parseFloat(opts.amount);
      if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

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
        // Determine which exchange key to use based on chain
        const exchange = srcChain === "arbitrum" ? "hyperliquid" : "lighter";
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
        dstSignerKey = pk; // For Solana receiveMessage relay
      } else {
        const exchange = dstChain === "arbitrum" ? "hyperliquid" : "lighter";
        const pk = await loadPrivateKey(exchange);
        const { ethers } = await import("ethers");
        recipientAddress = new ethers.Wallet(pk).address;
        dstSignerKey = pk; // For auto receiveMessage on destination EVM
      }

      // Get best quote (CCTP preferred, deBridge fallback)
      if (!isJson()) console.log(chalk.cyan(`\n  Bridge: $${amount} USDC ${srcChain} → ${dstChain}\n`));
      const quote = await getBestQuote(srcChain, dstChain, amount, senderAddress, recipientAddress);
      const providerName = quote.provider === "cctp" ? "Circle CCTP" : "deBridge DLN";

      if (!isJson()) {
        console.log(`  Provider: ${providerName}`);
        console.log(`  Send:     $${formatUsd(quote.amountIn)} USDC`);
        console.log(`  Receive:  ~$${formatUsd(quote.amountOut)} USDC`);
        console.log(`  Fee:      $${formatUsd(quote.fee)}`);
        console.log(`  From:     ${senderAddress}`);
        console.log(`  To:       ${recipientAddress}`);
        console.log(`  ETA:      ~${quote.estimatedTime}s\n`);
      }

      if (opts.dryRun) {
        if (!isJson()) console.log(chalk.yellow("  [DRY RUN] Transaction not executed.\n"));
        return;
      }

      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));
      const result = await executeBestBridge(srcChain, dstChain, amount, signerKey, senderAddress, recipientAddress, dstSignerKey);

      if (isJson()) return printJson(jsonOk(result));

      console.log(chalk.green("  Bridge transaction submitted!"));
      console.log(`  TX Hash:  ${result.txHash}`);
      console.log(`  Provider: ${result.provider}`);
      if (result.receiveTxHash) {
        console.log(`  Receive:  ${result.receiveTxHash} (${dstChain})`);
      }
      console.log(chalk.gray(`\n  Funds arrive in ~${quote.estimatedTime}s on ${dstChain}.\n`));
    });

  // ── bridge between exchanges (shortcut) ──

  bridge
    .command("exchange")
    .description("Bridge USDC between exchanges (shortcut)")
    .requiredOption("--from <exchange>", "Source exchange (pacifica, hyperliquid, lighter)")
    .requiredOption("--to <exchange>", "Destination exchange")
    .requiredOption("--amount <amount>", "USDC amount")
    .option("--dry-run", "Show quote without executing")
    .action(async (opts: { from: string; to: string; amount: string; dryRun?: boolean }) => {
      const srcExchange = opts.from.toLowerCase();
      const dstExchange = opts.to.toLowerCase();
      const srcChain = EXCHANGE_TO_CHAIN[srcExchange];
      const dstChain = EXCHANGE_TO_CHAIN[dstExchange];
      if (!srcChain) throw new Error(`Unknown exchange: ${srcExchange}`);
      if (!dstChain) throw new Error(`Unknown exchange: ${dstExchange}`);
      if (srcChain === dstChain) throw new Error("Same chain — no bridge needed");

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
        dstSignerKey = pk; // For Solana receiveMessage relay
      } else {
        const pk = await loadPrivateKey(dstExchange as Exchange);
        const { ethers } = await import("ethers");
        recipientAddress = new ethers.Wallet(pk).address;
        dstSignerKey = pk; // For auto receiveMessage
      }

      const quote = await getBestQuote(srcChain, dstChain, amount, senderAddress, recipientAddress);
      const providerName = quote.provider === "cctp" ? "Circle CCTP" : "deBridge DLN";

      if (!isJson()) {
        console.log(`  Provider: ${providerName}`);
        console.log(`  Send:     $${formatUsd(quote.amountIn)} USDC from ${srcExchange}`);
        console.log(`  Receive:  ~$${formatUsd(quote.amountOut)} USDC on ${dstExchange}`);
        console.log(`  Fee:      $${formatUsd(quote.fee)} (${((quote.fee / quote.amountIn) * 100).toFixed(2)}%)`);
        console.log(`  ETA:      ~${quote.estimatedTime}s\n`);
      }

      if (opts.dryRun) {
        if (!isJson()) console.log(chalk.yellow("  [DRY RUN] Not executed.\n"));
        return;
      }

      if (!isJson()) console.log(chalk.yellow(`  Executing via ${providerName}...\n`));

      const result = await executeBestBridge(srcChain, dstChain, amount, signerKey, senderAddress, recipientAddress, dstSignerKey);

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
