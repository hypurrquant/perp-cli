import { Command } from "commander";
import chalk from "chalk";
import { printJson, formatUsd, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";

export function registerWithdrawCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean
) {
  const withdraw = program.command("withdraw").description("Withdraw funds from exchange accounts");

  // ── Pacifica ──

  withdraw
    .command("pacifica <amount>")
    .description("Withdraw USDC from Pacifica to your Solana wallet")
    .option("--to <address>", "Destination Solana address (default: your wallet)")
    .action(async (amount: string, opts: { to?: string }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      if (!(adapter instanceof PacificaAdapter)) throw new Error("Requires --exchange pacifica");

      const dest = opts.to || adapter.publicKey;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Pacifica...\n`));
        console.log(`  Destination: ${dest}`);
      }

      const result = await adapter.sdk.withdraw(
        { amount: String(amountNum), dest_address: dest },
        adapter.publicKey,
        adapter.signer
      );

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Withdrawal submitted!`));
      console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
      console.log(chalk.gray(`\n  Funds arrive in your Solana wallet shortly.\n`));
    });

  // ── Hyperliquid ──

  withdraw
    .command("hyperliquid <amount>")
    .description("Withdraw USDC from Hyperliquid to your Arbitrum wallet")
    .option("--to <address>", "Destination EVM address (default: your wallet)")
    .action(async (amount: string, opts: { to?: string }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      if (!(adapter instanceof HyperliquidAdapter)) throw new Error("Requires --exchange hyperliquid");

      const dest = opts.to || adapter.address;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Hyperliquid...\n`));
        console.log(`  Destination: ${dest}`);
      }

      // Check withdrawable balance
      const balance = await adapter.getBalance();
      const available = Number(balance.available);
      if (amountNum > available) {
        console.error(chalk.red(`  Insufficient withdrawable balance. Available: $${formatUsd(available)}`));
        process.exit(1);
      }

      const result = await adapter.withdraw(String(amountNum), dest);

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Withdrawal submitted!`));
      console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
      console.log(chalk.gray(`\n  Processing may take a few minutes.\n`));
    });

  // ── Lighter ──

  withdraw
    .command("lighter <amount>")
    .description("Withdraw USDC from Lighter to your Ethereum L1 wallet")
    .option("--asset-id <id>", "Asset ID (default: 2 = USDC)", "2")
    .option("--route <type>", "Route type: 0=perp, 1=spot (default: 0)", "0")
    .action(async (amount: string, opts: { assetId: string; route: string }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      // Lazy-import to check instance
      const { LighterAdapter } = await import("../exchanges/lighter.js");
      if (!(adapter instanceof LighterAdapter)) throw new Error("Requires --exchange lighter");

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Lighter...\n`));
        console.log(`  Account Index: ${adapter.accountIndex}`);
        console.log(`  Address: ${adapter.address}`);
      }

      const result = await adapter.withdraw(amountNum, parseInt(opts.assetId), parseInt(opts.route));

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Withdrawal submitted!`));
      console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
      console.log(chalk.gray(`\n  Standard withdrawal takes ~12 hours. Use Lighter web for fast withdrawal.\n`));
    });

  // ── Transfer (HL internal) ──

  withdraw
    .command("transfer <amount> <destination>")
    .description("Transfer USDC between Hyperliquid accounts (internal, instant)")
    .action(async (amount: string, destination: string) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      if (!(adapter instanceof HyperliquidAdapter)) throw new Error("Requires --exchange hyperliquid");

      if (!isJson()) console.log(chalk.cyan(`\n  Transferring $${formatUsd(amountNum)} USDC to ${destination}...\n`));

      const result = await adapter.usdTransfer(amountNum, destination);

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`  Transfer complete!`));
      console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
      console.log(`  To:     ${destination}\n`);
    });

  // ── Info ──

  withdraw
    .command("info")
    .description("Show withdrawal info & limits")
    .action(async () => {
      if (isJson()) {
        return printJson(jsonOk({
          exchanges: {
            pacifica: { chain: "Solana", token: "USDC", speed: "~10s", fee: "none" },
            hyperliquid: { chain: "Arbitrum", token: "USDC", speed: "minutes", fee: "$1" },
            lighter: { chain: "Ethereum L1", token: "USDC", speed: "~12 hours (standard), minutes (fast)", fee: "varies" },
          },
        }));
      }

      console.log(chalk.cyan.bold("\n  Withdrawal Info\n"));

      console.log(chalk.white.bold("  Pacifica") + chalk.gray(" → Solana"));
      console.log(`  Speed: ~10s  |  Fee: none`);
      console.log(`  Command: ${chalk.green("perp withdraw pacifica <amount>")}`);

      console.log(chalk.white.bold("\n  Hyperliquid") + chalk.gray(" → Arbitrum"));
      console.log(`  Speed: minutes  |  Fee: ~$1`);
      console.log(`  Command: ${chalk.green("perp -e hyperliquid withdraw hyperliquid <amount>")}`);

      console.log(chalk.white.bold("\n  Lighter") + chalk.gray(" → Ethereum L1"));
      console.log(`  Speed: ~12h (standard)  |  Fee: varies`);
      console.log(`  Command: ${chalk.green("perp -e lighter withdraw lighter <amount>")}`);

      console.log(chalk.white.bold("\n  Internal Transfer") + chalk.gray(" (Hyperliquid → Hyperliquid)"));
      console.log(`  Speed: instant  |  Fee: none`);
      console.log(`  Command: ${chalk.green("perp -e hyperliquid withdraw transfer <amount> <address>")}`);
      console.log();
    });
}
