import { Command } from "commander";
import { isDryRun, supportsDryRun } from "../cli-flags.js";
import chalk from "chalk";
import { formatUsd, makeTable, printJson, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { PerpError } from "../errors.js";
import {
  fetchBalancesWithFailures,
  computeRebalancePlan,
  describeBridgeRoute,
  estimateMoveTime,
  type RebalanceMove,
} from "../rebalance.js";
import { EXCHANGE_TO_CHAIN, assertBridgeNetwork, executeBestBridge } from "../bridge-engine.js";
import type { Network } from "../exchanges/venue-types.js";
import { cliCredentialOptsFrom, type CliCredentialOpts, type Exchange } from "../config.js";
import type { BridgeEvmSigner } from "../bridge-signers.js";
import type { SolanaSigner } from "../signer/interface.js";
import { getVenue, roleUnsupported, tryResolveVenueId } from "../exchanges/venue.js";
import { unsupported } from "../exchanges/trading-v2.js";
import { RISEX_FUNDS_APP_ONLY } from "../exchanges/venues/risex.js";
import { TXFLOW_FUNDS_APP_ONLY } from "../exchanges/venues/txflow.js";
import "../exchanges/venues/index.js";

export function registerFundsRebalanceCommands(
  parent: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getNetwork: () => Network,
) {
  const rebalance = parent.command("rebalance").description("Cross-exchange balance management");

  // ── rebalance check ──

  rebalance
    .command("check")
    .description("Show balances across all exchanges")
    .option("--exchanges <list>", "Comma-separated exchanges", "pacifica,hyperliquid,lighter,aster")
    .action(async (opts: { exchanges: string }) => {
      const exchangeNames = opts.exchanges.split(",").map((e) => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();
      const unavailable: Array<{ exchange: string; error: string }> = [];

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterForExchange(name));
        } catch (e) {
          unavailable.push({ exchange: name, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (adapters.size === 0) {
        if (isJson()) return printJson(jsonOk({ snapshots: [], unavailable }));
        console.error(chalk.red("\n  No exchanges available. Check credentials.\n"));
        return;
      }

      if (!isJson()) console.log(chalk.cyan("\n  Fetching balances across exchanges...\n"));
      const { snapshots, failed, notConfigured } = await fetchBalancesWithFailures(adapters);
      // A venue whose balance read failed is unavailable — listed, never shown as $0 or dropped.
      unavailable.push(...failed);
      const partial = unavailable.length > 0;

      if (isJson()) return printJson(jsonOk({ snapshots, unavailable, partial, notConfigured }));
      for (const n of notConfigured) console.log(chalk.gray(`  ${n}: not configured (no credentials) — left out`));

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
      console.log(`  Exchanges:       ${snapshots.length}${partial ? ` of ${exchangeNames.length} (partial)` : ""}\n`);
      printUnavailable(unavailable);
    });

  // ── rebalance plan ──

  rebalance
    .command("plan")
    .description("Calculate optimal rebalancing moves")
    .option("--exchanges <list>", "Comma-separated exchanges", "pacifica,hyperliquid,lighter,aster")
    .option("--min-move <usd>", "Minimum move amount ($)", "50")
    .option("--reserve <usd>", "Keep at least this much per exchange ($)", "20")
    .action(async (opts: { exchanges: string; minMove: string; reserve: string }) => {
      const exchangeNames = opts.exchanges.split(",").map((e) => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();
      const unavailable: Array<{ exchange: string; error: string }> = [];

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterForExchange(name));
        } catch (e) {
          unavailable.push({ exchange: name, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (adapters.size < 2) {
        if (isJson()) return printJson(jsonOk({ moves: [], unavailable, error: "Need at least 2 exchanges for rebalancing" }));
        console.error(chalk.red("\n  Need at least 2 exchanges for rebalancing.\n"));
        return;
      }

      if (!isJson()) console.log(chalk.cyan("\n  Computing rebalance plan...\n"));
      const { snapshots, failed, notConfigured } = await fetchBalancesWithFailures(adapters);
      unavailable.push(...failed);
      // partial: the plan covers only the venues that were read — `execute` refuses to run it.
      const partial = unavailable.length > 0;
      const plan = computeRebalancePlan(snapshots, {
        minMove: parseFloat(opts.minMove),
        reserve: parseFloat(opts.reserve),
      });

      if (isJson()) return printJson(jsonOk({ ...plan, unavailable, partial, notConfigured }));
      for (const n of notConfigured) console.log(chalk.gray(`  ${n}: not configured (no credentials) — left out of the plan`));

      if (partial) {
        console.log(chalk.yellow(`  ⚠ Partial plan: computed over ${snapshots.length} of ${exchangeNames.length} exchanges.`));
        printUnavailable(unavailable);
      }

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

      console.log(chalk.yellow(`  To execute: perp funds rebalance execute --exchanges ${opts.exchanges}\n`));
    });

  // ── rebalance execute ──

  supportsDryRun(rebalance.command("execute"))
    .description("Execute rebalancing (withdraw → bridge → deposit; supports --dry-run)")
    .option("--exchanges <list>", "Comma-separated exchanges", "pacifica,hyperliquid,lighter,aster")
    .option("--min-move <usd>", "Minimum move amount ($)", "50")
    .option("--reserve <usd>", "Keep at least this much per exchange ($)", "20")
    .option("--withdraw-only", "Only execute withdrawals (manual bridge + deposit)")
    .option("--auto-bridge", "Auto-bridge via deBridge DLN (withdraw → bridge in one step)")
    .action(async (opts: {
      exchanges: string; minMove: string; reserve: string;
      withdrawOnly?: boolean; autoBridge?: boolean;
    }, cmd: Command) => {
      const dryRun = isDryRun(cmd);
      // --auto-bridge signs mainnet-only bridge routes: refuse -n testnet up front,
      // before any withdrawal is sent (not after, as a per-move bridge_failed).
      if (opts.autoBridge && !dryRun) assertBridgeNetwork(getNetwork());
      const exchangeNames = opts.exchanges.split(",").map((e) => e.trim());
      // Venues whose funds perp-cli cannot move are refused before any read (no partial plan).
      for (const name of exchangeNames) {
        const id = tryResolveVenueId(name);
        if (id === null) continue;
        const def = getVenue(id);
        if (!def.roles.includes("account")) throw roleUnsupported(def, "rebalance");
        if (id === "risex") throw unsupported("risex", "rebalance", RISEX_FUNDS_APP_ONLY.reason, RISEX_FUNDS_APP_ONLY.remediation);
        if (id === "txflow") throw unsupported("txflow", "rebalance", TXFLOW_FUNDS_APP_ONLY.reason, TXFLOW_FUNDS_APP_ONLY.remediation);
      }
      const adapters = new Map<string, ExchangeAdapter>();
      const unavailable: Array<{ exchange: string; error: string }> = [];

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterForExchange(name));
        } catch (e) {
          unavailable.push({ exchange: name, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (adapters.size < 2 && unavailable.length === 0) {
        console.error(chalk.red("\n  Need at least 2 exchanges.\n"));
        return;
      }

      const { snapshots, failed, notConfigured } = await fetchBalancesWithFailures(adapters);
      unavailable.push(...failed);
      // A venue without credentials holds nothing the CLI can move: left out (noted), not a failure.
      if (!isJson()) for (const n of notConfigured) console.log(chalk.gray(`  ${n}: not configured (no credentials) — left out`));
      // Moving funds on a plan computed over fewer venues than requested would mis-size every
      // move: abort unless every requested venue was read.
      if (unavailable.length > 0) {
        throw new PerpError(
          "EXCHANGE_ERROR",
          `Rebalance aborted: balances of ${unavailable.map(u => u.exchange).join(", ")} could not be read (${unavailable.map(u => `${u.exchange}: ${u.error}`).join("; ")})`,
          {
            unavailable,
            remediation: `Retry when every venue answers, or exclude the unavailable venue(s) explicitly with --exchanges ${exchangeNames.filter(n => !unavailable.some(u => u.exchange === n)).join(",") || "<list>"}`,
          },
        );
      }
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

        if (dryRun) {
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
            let root: Command = cmd;
            while (root.parent) root = root.parent;
            const { senderAddress, recipientAddress, signer, dstSigner } = await loadBridgeKeys(
              move.from as Exchange, move.to as Exchange, srcChain, dstChain, cliCredentialOptsFrom(root.opts()),
            );

            const result = await executeBestBridge(
              getNetwork(), srcChain, dstChain, move.amount, signer, senderAddress, recipientAddress, dstSigner,
            );

            if (!isJson()) {
              console.log(chalk.green(`    Bridge submitted! TX: ${result.txHash}`));
              console.log(chalk.gray(`    Provider: ${result.provider} | ~$${result.amountOut} arriving on ${dstChain}\n`));
            }
            moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "bridged", txHash: result.txHash });
          } catch (err) {
            console.error(chalk.red(`    Bridge failed: ${err instanceof Error ? err.message : err}`));
            if (!isJson()) console.log(chalk.yellow(`    Manual fallback: perp funds bridge exchange --from ${move.from} --to ${move.to} --amount ${move.amount}\n`));
            moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "bridge_failed", error: err instanceof Error ? err.message : String(err) });
          }
        } else {
          if (!isJson()) {
            console.log(chalk.gray(`    Step 2: Bridge needed.`));
            console.log(chalk.gray(`    Run: perp funds bridge exchange --from ${move.from} --to ${move.to} --amount ${move.amount}`));
            console.log();
          }
          moveResults.push({ from: move.from, to: move.to, amount: move.amount, status: "needs_bridge" });
        }
      }

      if (isJson()) return printJson(jsonOk({ status: dryRun ? "simulated" : "executed", dryRun, sent: !dryRun, moves: moveResults }));
      console.log(chalk.cyan("  Rebalance initiated. Monitor progress with 'perp funds rebalance check'.\n"));
    });
}

function printUnavailable(unavailable: Array<{ exchange: string; error: string }>): void {
  for (const u of unavailable) console.log(chalk.yellow(`  ⚠ ${u.exchange} unavailable (left out): ${u.error}`));
  if (unavailable.length > 0) console.log();
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
      // Pacifica withdraws to the account owner's own wallet (no destination field).
      await sdk.withdraw(
        { amount: String(move.amount) },
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
 * Sender / recipient (the master wallet's own public addresses) and master signers for a bridge
 * move: OWS vault signers for an OWS master, raw-key signers for a raw-key master.
 */
async function loadBridgeKeys(
  srcExchange: Exchange,
  dstExchange: Exchange,
  srcChain: string,
  dstChain: string,
  credOpts: CliCredentialOpts,
): Promise<{ senderAddress: string; recipientAddress: string; signer: BridgeEvmSigner | SolanaSigner; dstSigner: BridgeEvmSigner | SolanaSigner }> {
  const { bridgeAddress, bridgeVenueForChain, loadBridgeSigner } = await import("../bridge-signers.js");
  const srcVenue = bridgeVenueForChain(srcChain, srcExchange);
  const dstVenue = bridgeVenueForChain(dstChain, dstExchange);
  return {
    senderAddress: await bridgeAddress(srcChain, srcVenue, credOpts),
    recipientAddress: await bridgeAddress(dstChain, dstVenue, credOpts),
    signer: await loadBridgeSigner(srcChain, srcVenue, credOpts),
    dstSigner: await loadBridgeSigner(dstChain, dstVenue, credOpts),
  };
}
