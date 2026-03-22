import { Command } from "commander";
import chalk from "chalk";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import {
  fetchAllBalances,
  computeRebalancePlan,
  describeBridgeRoute,
  estimateMoveTime,
  type RebalanceMove,
} from "../rebalance.js";
import { EXCHANGE_TO_CHAIN, executeBestBridge } from "../bridge-engine.js";
import { loadPrivateKey, parseSolanaKeypair, type Exchange } from "../config.js";

export function registerRebalanceCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean
) {
  const rebalance = program.command("rebalance").description("Cross-exchange balance management");

  // ── rebalance check ──

  rebalance
    .command("check")
    .description("Show balances across all exchanges")
    .option("--exchanges <list>", "Comma-separated exchanges", "pacifica,hyperliquid,lighter,aster,edgex")
    .action(async (opts: { exchanges: string }) => {
      const exchangeNames = opts.exchanges.split(",").map((e) => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterForExchange(name));
        } catch {
          // skip unavailable
        }
      }

      if (adapters.size === 0) {
        console.error(chalk.red("\n  No exchanges available. Check credentials.\n"));
        return;
      }

      if (!isJson()) console.log(chalk.cyan("\n  Fetching balances across exchanges...\n"));
      const snapshots = await fetchAllBalances(adapters);

      if (isJson()) return printJson(jsonOk(snapshots));

      const totalEquity = snapshots.reduce((s, e) => s + e.equity, 0);
      const totalAvailable = snapshots.reduce((s, e) => s + e.available, 0);

      const rows = snapshots.map((s) => {
        const pct = totalEquity > 0 ? ((s.equity / totalEquity) * 100).toFixed(1) + "%" : "-";
        return [
          chalk.white.bold(s.exchange.padEnd(12)),
          `$${formatUsd(s.equity)}`,
          `$${formatUsd(s.available)}`,
          `$${formatUsd(s.marginUsed)}`,
          s.unrealizedPnl >= 0
            ? chalk.green(`+$${formatUsd(s.unrealizedPnl)}`)
            : chalk.red(`-$${formatUsd(Math.abs(s.unrealizedPnl))}`),
          pct,
        ];
      });

      console.log(makeTable(["Exchange", "Equity", "Available", "Margin", "uPnL", "Alloc%"], rows));

      console.log(chalk.cyan.bold("  Totals"));
      console.log(`  Total Equity:    $${formatUsd(totalEquity)}`);
      console.log(`  Total Available: $${formatUsd(totalAvailable)}`);
      console.log(`  Exchanges:       ${snapshots.length}\n`);
    });

  // ── rebalance plan ──

  rebalance
    .command("plan")
    .description("Calculate optimal rebalancing moves")
    .option("--exchanges <list>", "Comma-separated exchanges", "pacifica,hyperliquid,lighter,aster,edgex")
    .option("--min-move <usd>", "Minimum move amount ($)", "50")
    .option("--reserve <usd>", "Keep at least this much per exchange ($)", "20")
    .action(async (opts: { exchanges: string; minMove: string; reserve: string }) => {
      const exchangeNames = opts.exchanges.split(",").map((e) => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterForExchange(name));
        } catch {
          // skip unavailable
        }
      }

      if (adapters.size < 2) {
        console.error(chalk.red("\n  Need at least 2 exchanges for rebalancing.\n"));
        return;
      }

      if (!isJson()) console.log(chalk.cyan("\n  Computing rebalance plan...\n"));
      const snapshots = await fetchAllBalances(adapters);
      const plan = computeRebalancePlan(snapshots, {
        minMove: parseFloat(opts.minMove),
        reserve: parseFloat(opts.reserve),
      });

      if (isJson()) return printJson(jsonOk(plan));

      // Show current state
      const rows = plan.snapshots.map((s) => {
        const target = plan.targetPerExchange;
        const diff = s.available - target;
        const diffStr = diff >= 0
          ? chalk.green(`+$${formatUsd(diff)}`)
          : chalk.red(`-$${formatUsd(Math.abs(diff))}`);
        return [
          chalk.white.bold(s.exchange),
          `$${formatUsd(s.available)}`,
          `$${formatUsd(target)}`,
          diffStr,
        ];
      });

      console.log(makeTable(["Exchange", "Available", "Target", "Diff"], rows));

      if (plan.moves.length === 0) {
        console.log(chalk.green("  Balanced — no moves needed.\n"));
        return;
      }

      console.log(chalk.cyan.bold("  Proposed Moves\n"));
      for (let i = 0; i < plan.moves.length; i++) {
        const m = plan.moves[i];
        console.log(chalk.white.bold(`  Move ${i + 1}: $${m.amount} ${m.from} → ${m.to}`));
        console.log(chalk.gray(`    Route: ${describeBridgeRoute(m)}`));
        console.log(chalk.gray(`    Time:  ${estimateMoveTime(m)}`));
        console.log();
      }

      console.log(chalk.yellow(`  To execute: perp rebalance execute --exchanges ${opts.exchanges}\n`));
    });

  // ── rebalance execute ──

  rebalance
    .command("execute")
    .description("Execute rebalancing (withdraw → bridge → deposit)")
    .option("--exchanges <list>", "Comma-separated exchanges", "pacifica,hyperliquid,lighter,aster,edgex")
    .option("--min-move <usd>", "Minimum move amount ($)", "50")
    .option("--reserve <usd>", "Keep at least this much per exchange ($)", "20")
    .option("--dry-run", "Show what would happen without executing")
    .option("--withdraw-only", "Only execute withdrawals (manual bridge + deposit)")
    .option("--auto-bridge", "Auto-bridge via deBridge DLN (withdraw → bridge in one step)")
    .action(async (opts: {
      exchanges: string; minMove: string; reserve: string;
      dryRun?: boolean; withdrawOnly?: boolean; autoBridge?: boolean;
    }) => {
      const exchangeNames = opts.exchanges.split(",").map((e) => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterForExchange(name));
        } catch {
          // skip
        }
      }

      if (adapters.size < 2) {
        console.error(chalk.red("\n  Need at least 2 exchanges.\n"));
        return;
      }

      const snapshots = await fetchAllBalances(adapters);
      const plan = computeRebalancePlan(snapshots, {
        minMove: parseFloat(opts.minMove),
        reserve: parseFloat(opts.reserve),
      });

      if (plan.moves.length === 0) {
        if (isJson()) return printJson(jsonOk({ status: "balanced", moves: [] }));
        console.log(chalk.green("\n  Already balanced — nothing to do.\n"));
        return;
      }

      if (!isJson()) console.log(chalk.cyan.bold("\n  Executing Rebalance\n"));

      const moveResults: { from: string; to: string; amount: number; status: string; txHash?: string; error?: string }[] = [];

      for (const move of plan.moves) {
        if (!isJson()) console.log(chalk.white.bold(`  $${move.amount} ${move.from} → ${move.to}`));

        if (opts.dryRun) {
          if (!isJson()) console.log(chalk.yellow("    [DRY RUN] Skipped.\n"));
          moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "dry_run" });
          continue;
        }

        // Step 1: Withdraw from source exchange
        try {
          if (!isJson()) console.log(chalk.gray(`    Step 1: Withdrawing $${move.amount} from ${move.from}...`));
          await executeWithdraw(move, adapters);
          if (!isJson()) console.log(chalk.green(`    Withdrawal submitted.`));
        } catch (err) {
          console.error(chalk.red(`    Withdraw failed: ${err instanceof Error ? err.message : err}`));
          if (!isJson()) console.log(chalk.yellow(`    Skipping this move.\n`));
          moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "withdraw_failed", error: err instanceof Error ? err.message : String(err) });
          continue;
        }

        if (opts.withdrawOnly) {
          if (!isJson()) {
            console.log(chalk.yellow(`    [WITHDRAW-ONLY] Bridge and deposit manually.`));
            console.log(chalk.gray(`    Route: ${describeBridgeRoute(move)}\n`));
          }
          moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "withdrawn" });
          continue;
        }

        // Step 2: Bridge
        const srcChain = EXCHANGE_TO_CHAIN[move.from];
        const dstChain = EXCHANGE_TO_CHAIN[move.to];

        if (!srcChain || !dstChain || srcChain === dstChain) {
          if (!isJson()) console.log(chalk.green(`    Same chain — no bridge needed.\n`));
          moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "same_chain" });
          continue;
        }

        if (opts.autoBridge) {
          try {
            if (!isJson()) console.log(chalk.gray(`    Step 2: Bridging $${move.amount} (${srcChain} → ${dstChain})...`));

            // Load keys for bridge
            const { senderAddress, recipientAddress, signerKey, dstSignerKey } = await loadBridgeKeys(
              move.from as Exchange, move.to as Exchange, srcChain, dstChain,
            );

            const result = await executeBestBridge(
              srcChain, dstChain, move.amount, signerKey, senderAddress, recipientAddress, dstSignerKey,
            );

            if (!isJson()) {
              console.log(chalk.green(`    Bridge submitted! TX: ${result.txHash}`));
              console.log(chalk.gray(`    Provider: ${result.provider} | ~$${result.amountOut} arriving on ${dstChain}\n`));
            }
            moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "bridged", txHash: result.txHash });
          } catch (err) {
            console.error(chalk.red(`    Bridge failed: ${err instanceof Error ? err.message : err}`));
            if (!isJson()) console.log(chalk.yellow(`    Manual fallback: perp bridge exchange --from ${move.from} --to ${move.to} --amount ${move.amount}\n`));
            moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "bridge_failed", error: err instanceof Error ? err.message : String(err) });
          }
        } else {
          if (!isJson()) {
            console.log(chalk.gray(`    Step 2: Bridge needed.`));
            console.log(chalk.gray(`    Run: perp bridge exchange --from ${move.from} --to ${move.to} --amount ${move.amount}`));
            console.log();
          }
          moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "needs_bridge" });
        }
      }

      if (isJson()) return printJson(jsonOk({ status: "executed", moves: moveResults }));
      console.log(chalk.cyan("  Rebalance initiated. Monitor progress with 'perp rebalance check'.\n"));
    });
}

/**
 * Execute a withdrawal from a source exchange.
 */
async function executeWithdraw(
  move: RebalanceMove,
  adapters: Map<string, ExchangeAdapter>,
): Promise<void> {
  const { hasPacificaSdk, isWithdrawCapable, hasEvmAddress } = await import("../exchanges/capabilities.js");
  const adapter = adapters.get(move.from);
  if (!adapter) throw new Error(`No adapter for ${move.from}`);

  switch (adapter.name) {
    case "pacifica": {
      if (!hasPacificaSdk(adapter)) throw new Error("Invalid adapter");
      const sdk = adapter.sdk as Record<string, (...args: any[]) => any>;
      await sdk.withdraw(
        { amount: String(move.amount), dest_address: adapter.publicKey },
        adapter.publicKey,
        adapter.signer,
      );
      break;
    }
    case "hyperliquid": {
      if (!isWithdrawCapable(adapter) || !hasEvmAddress(adapter)) throw new Error("Invalid adapter");
      await adapter.withdraw(String(move.amount), adapter.address);
      break;
    }
    case "lighter": {
      if (!isWithdrawCapable(adapter)) throw new Error("Invalid adapter");
      await adapter.withdraw(String(move.amount), "");
      break;
    }
    default:
      throw new Error(`Withdraw not supported for ${move.from}`);
  }
}

/**
 * Load sender/recipient addresses and signer key for a bridge move.
 */
async function loadBridgeKeys(
  srcExchange: Exchange,
  dstExchange: Exchange,
  srcChain: string,
  dstChain: string,
): Promise<{ senderAddress: string; recipientAddress: string; signerKey: string; dstSignerKey?: string }> {
  let senderAddress: string;
  let recipientAddress: string;
  let signerKey: string;
  let dstSignerKey: string | undefined;

  // Source
  if (srcChain === "solana") {
    const pk = await loadPrivateKey("pacifica");
    senderAddress = parseSolanaKeypair(pk).publicKey.toBase58();
    signerKey = pk;
  } else {
    const pk = await loadPrivateKey(srcExchange);
    const { ethers } = await import("ethers");
    senderAddress = new ethers.Wallet(pk).address;
    signerKey = pk;
  }

  // Destination
  if (dstChain === "solana") {
    const pk = await loadPrivateKey("pacifica");
    recipientAddress = parseSolanaKeypair(pk).publicKey.toBase58();
  } else {
    const pk = await loadPrivateKey(dstExchange);
    const { ethers } = await import("ethers");
    recipientAddress = new ethers.Wallet(pk).address;
    dstSignerKey = pk; // For auto receiveMessage
  }

  return { senderAddress, recipientAddress, signerKey, dstSignerKey };
}
