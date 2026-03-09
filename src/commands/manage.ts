import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { printJson, jsonOk } from "../utils.js";
import chalk from "chalk";

export function registerManageCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getPacificaAdapter: () => PacificaAdapter
) {
  const manage = program.command("manage").description("Account management");

  // Ensure adapter is initialized before accessing PacificaAdapter
  async function pac(): Promise<PacificaAdapter> {
    const adapter = await getAdapter();
    if (!(adapter instanceof PacificaAdapter)) {
      throw new Error("This command requires --exchange pacifica");
    }
    return adapter as PacificaAdapter;
  }

  manage
    .command("margin <symbol> <mode>")
    .description("Set margin mode (cross/isolated)")
    .action(async (symbol: string, mode: string) => {
      const m = mode.toLowerCase();
      if (m !== "cross" && m !== "isolated") {
        console.error(chalk.red("Mode must be cross or isolated"));
        process.exit(1);
      }
      const a = await pac();
      const result = await a.sdk.updateMarginMode(
        { symbol: symbol.toUpperCase(), is_isolated: m === "isolated" },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(
        chalk.green(
          `\n  Margin mode for ${symbol.toUpperCase()} set to ${m}.\n`
        )
      );
    });

  manage
    .command("withdraw <amount> <address>")
    .description("Withdraw funds to a Solana address")
    .action(async (amount: string, address: string) => {
      const a = await pac();
      const result = await a.sdk.withdraw(
        { amount, dest_address: address },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(
        chalk.green(`\n  Withdrawal of $${amount} to ${address} submitted.\n`)
      );
    });

  // Subaccounts
  const sub = manage.command("sub").description("Subaccount management");

  sub
    .command("create <name>")
    .description("Create a subaccount")
    .action(async (name: string) => {
      const a = await pac();
      const result = await a.sdk.createSubaccount(
        name,
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Subaccount "${name}" created.\n`));
    });

  sub
    .command("list")
    .description("List subaccounts")
    .action(async () => {
      const a = await pac();
      const result = await a.sdk.listSubaccounts(
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      printJson(jsonOk(result));
    });

  sub
    .command("transfer <from> <to> <amount>")
    .description("Transfer funds between accounts")
    .action(async (from: string, to: string, amount: string) => {
      const a = await pac();
      const result = await a.sdk.transferFunds(
        { from_account: from, to_account: to, amount },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Transferred $${amount}.\n`));
    });

  // Agent wallets
  const agent = manage.command("agent").description("Agent wallet management");

  agent
    .command("bind <wallet>")
    .description("Bind an agent wallet")
    .action(async (wallet: string) => {
      const a = await pac();
      const result = await a.sdk.bindAgentWallet(
        wallet,
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Agent wallet ${wallet} bound.\n`));
    });

  agent
    .command("list")
    .description("List agent wallets")
    .action(async () => {
      const a = await pac();
      const result = await a.sdk.listAgentWallets(
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      printJson(jsonOk(result));
    });

  agent
    .command("revoke <wallet>")
    .description("Revoke an agent wallet")
    .action(async (wallet: string) => {
      const a = await pac();
      const result = await a.sdk.revokeAgentWallet(
        wallet,
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Agent wallet ${wallet} revoked.\n`));
    });

  agent
    .command("revoke-all")
    .description("Revoke all agent wallets")
    .action(async () => {
      const a = await pac();
      const result = await a.sdk.revokeAllAgentWallets(
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green("\n  All agent wallets revoked.\n"));
    });

  // Lake (liquidity vaults)
  const lake = manage.command("lake").description("Lake (liquidity vault) management");

  lake
    .command("create <symbol> <amount>")
    .description("Create a new lake")
    .action(async (symbol: string, amount: string) => {
      const a = await pac();
      const result = await a.sdk.createLake(
        { symbol: symbol.toUpperCase(), amount },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Lake created for ${symbol.toUpperCase()} with $${amount}.\n`));
      printJson(jsonOk(result));
    });

  lake
    .command("deposit <lakeId> <amount>")
    .description("Deposit to a lake")
    .action(async (lakeId: string, amount: string) => {
      const a = await pac();
      const result = await a.sdk.depositToLake(
        { lake_id: lakeId, amount },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Deposited $${amount} to lake ${lakeId}.\n`));
    });

  lake
    .command("withdraw <lakeId> <amount>")
    .description("Withdraw from a lake")
    .action(async (lakeId: string, amount: string) => {
      const a = await pac();
      const result = await a.sdk.withdrawFromLake(
        { lake_id: lakeId, amount },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Withdrew $${amount} from lake ${lakeId}.\n`));
    });

  // Builder Codes
  const builder = manage.command("builder").description("Builder code management (Pacifica)");

  builder
    .command("approve <code> <maxFeeRate>")
    .description("Approve a builder code (e.g. approve MYCODE 0.001)")
    .action(async (code: string, maxFeeRate: string) => {
      const a = await pac();
      const result = await a.sdk.approveBuilderCode(
        { builder_code: code, max_fee_rate: maxFeeRate },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Builder code "${code}" approved (max fee: ${maxFeeRate}).\n`));
    });

  builder
    .command("revoke <code>")
    .description("Revoke a builder code")
    .action(async (code: string) => {
      const a = await pac();
      const result = await a.sdk.revokeBuilderCode(
        { builder_code: code },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Builder code "${code}" revoked.\n`));
    });

  builder
    .command("list")
    .description("List approved builder codes")
    .action(async () => {
      const a = await pac();
      const result = await a.sdk.getBuilderApprovals(a.publicKey);
      if (isJson()) return printJson(jsonOk(result));
      const approvals = result as { builder_code: string; max_fee_rate: string; description?: string }[];
      if (!Array.isArray(approvals) || approvals.length === 0) {
        console.log(chalk.gray("\n  No builder codes approved.\n"));
        return;
      }
      console.log(chalk.cyan.bold("\n  Approved Builder Codes\n"));
      for (const b of approvals) {
        console.log(`  ${chalk.white(b.builder_code.padEnd(16))} max_fee: ${b.max_fee_rate}  ${chalk.gray(b.description || "")}`);
      }
      console.log();
    });

  builder
    .command("overview")
    .description("Show your builder code overview (if you are a builder)")
    .action(async () => {
      const a = await pac();
      const result = await a.sdk.getBuilderOverview(a.publicKey);
      if (isJson()) return printJson(jsonOk(result));
      printJson(jsonOk(result));
    });

  builder
    .command("trades <code>")
    .description("Show trade history for a builder code")
    .action(async (code: string) => {
      const a = await pac();
      const result = await a.sdk.getBuilderTrades(code);
      if (isJson()) return printJson(jsonOk(result));
      printJson(jsonOk(result));
    });

  builder
    .command("leaderboard <code>")
    .description("Show user leaderboard for a builder code")
    .action(async (code: string) => {
      const a = await pac();
      const result = await a.sdk.getBuilderLeaderboard(code);
      if (isJson()) return printJson(jsonOk(result));
      printJson(jsonOk(result));
    });

  builder
    .command("update-fee <code> <feeRate>")
    .description("Update fee rate for your builder code (builder owners only)")
    .action(async (code: string, feeRate: string) => {
      const a = await pac();
      const result = await a.sdk.updateBuilderFeeRate(
        { builder_code: code, fee_rate: feeRate },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Builder code "${code}" fee rate updated to ${feeRate}.\n`));
    });

  // Referral
  const referral = manage.command("referral").description("Referral code management (Pacifica)");

  referral
    .command("claim <code>")
    .description("Claim a referral code")
    .action(async (code: string) => {
      const a = await pac();
      const result = await a.sdk.claimReferralCode(
        { code },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Referral code "${code}" claimed!\n`));
    });

  // API Keys
  const apikey = manage.command("apikey").description("API key management");

  apikey
    .command("create <name> <maxFeeRate>")
    .description("Create an API key")
    .action(async (name: string, maxFeeRate: string) => {
      const a = await pac();
      const result = await a.sdk.createApiKey(
        name,
        maxFeeRate,
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  API key "${name}" created.\n`));
      printJson(jsonOk(result));
    });

  apikey
    .command("list")
    .description("List API keys")
    .action(async () => {
      const a = await pac();
      const result = await a.sdk.listApiKeys(
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      printJson(jsonOk(result));
    });

  apikey
    .command("revoke <key>")
    .description("Revoke an API key")
    .action(async (key: string) => {
      const a = await pac();
      const result = await a.sdk.revokeApiKey(
        key,
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  API key revoked.\n`));
    });

  // === Lighter API Key Setup ===
  manage
    .command("setup-api-key")
    .description("Generate & register a Lighter API key (required for trading)")
    .option("--key-index <n>", "API key index (2-254, default: 2)", "2")
    .action(async (opts: { keyIndex: string }) => {
      const adapter = await getAdapter();
      const { LighterAdapter } = await import("../exchanges/lighter.js");
      if (!(adapter instanceof LighterAdapter)) {
        throw new Error("This command requires --exchange lighter");
      }

      const keyIndex = parseInt(opts.keyIndex);
      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Lighter API Key Setup\n"));
        console.log(chalk.gray(`  Account: ${adapter.address} (index: ${adapter.accountIndex})`));
        console.log(chalk.gray(`  API Key Index: ${keyIndex}\n`));
        console.log(chalk.gray("  Generating key pair + registering on-chain...\n"));
      }

      const { privateKey, publicKey } = await adapter.setupApiKey(keyIndex);

      if (isJson()) {
        return printJson(jsonOk({
          privateKey,
          publicKey,
          address: adapter.address,
          accountIndex: adapter.accountIndex,
          apiKeyIndex: keyIndex,
        }));
      }

      console.log(chalk.green("  API Key Registered!\n"));
      console.log(`  ${chalk.bold("Private Key:")} ${privateKey}`);
      console.log(`  ${chalk.bold("Public Key:")}  ${publicKey}`);
      console.log();
      console.log(chalk.yellow("  Add to your .env file:"));
      console.log(chalk.white(`  LIGHTER_API_KEY=${privateKey}`));
      console.log(chalk.white(`  LIGHTER_ACCOUNT_INDEX=${adapter.accountIndex}`));
      console.log();
    });
}
