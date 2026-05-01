import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { printJson, jsonOk, jsonError } from "../utils.js";
import chalk from "chalk";
import { hasPacificaSdk } from "../exchanges/capabilities.js";
import { PerpError } from "../errors.js";
import { loadSettings } from "../settings.js";
import { resolvePassphrase } from "../agent-wallet/passphrase.js";
import { runHlSetAbstractionFlow, type HlAbstractionMode } from "./agent.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";

export function registerWalletManageCommands(
  parent: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getPacificaAdapter: () => unknown
) {
  const manage = parent.command("manage").description("Exchange account settings (margin, subaccount, API keys, builder, account-mode) — Pacifica + Lighter + Hyperliquid");

  // Ensure adapter is initialized before accessing PacificaAdapter
  async function pac() {
    const adapter = await getAdapter();
    if (!hasPacificaSdk(adapter)) {
      throw new Error("This command requires --exchange pacifica");
    }
    // Cast sdk to any to allow calling Pacifica SDK methods without importing the concrete type
    return adapter as typeof adapter & { sdk: Record<string, (...args: any[]) => any> };
  }

  manage
    .command("margin <symbol> <mode>")
    .description("Set margin mode (cross/isolated)")
    .action(async (symbol: string, mode: string) => {
      const m = mode.toLowerCase();
      if (m !== "cross" && m !== "isolated") {
        if (isJson()) {
          console.error(JSON.stringify(jsonError("INVALID_PARAMS", "Mode must be cross or isolated")));
          process.exit(1);
        }
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

  const withdrawCmd = manage
    .command("withdraw <amount> <address>")
    .description("Use 'perp withdraw pacifica <amount>'")
    .action(async (_amount: string, _address: string) => {
      console.log(chalk.yellow("\n  Use 'perp withdraw pacifica <amount>' instead.\n"));
    });
  (withdrawCmd as any)._hidden = true;

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
      console.log(JSON.stringify(result, null, 2));
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

  // Legacy `manage agent` removed in v0.12 (Phase 2c) — superseded by the
  // unified `wallet agent {approve,revoke,rotate,list,verify} pacifica` flow.
  // The unified command tree provides 3-tier signer routing, expiry tracking,
  // and OWS at-rest encryption. See `wallet agent approve pacifica --help`.

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
      console.log(JSON.stringify(result, null, 2));
    });

  builder
    .command("trades <code>")
    .description("Show trade history for a builder code")
    .action(async (code: string) => {
      const a = await pac();
      const result = await a.sdk.getBuilderTrades(code);
      if (isJson()) return printJson(jsonOk(result));
      console.log(JSON.stringify(result, null, 2));
    });

  builder
    .command("leaderboard <code>")
    .description("Show user leaderboard for a builder code")
    .action(async (code: string) => {
      const a = await pac();
      const result = await a.sdk.getBuilderLeaderboard(code);
      if (isJson()) return printJson(jsonOk(result));
      console.log(JSON.stringify(result, null, 2));
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
      console.log(JSON.stringify(result, null, 2));
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

  // Legacy `manage setup-api-key` removed in v0.12 (Phase 2d) — superseded by
  // the unified `wallet agent approve lighter` flow. The agent flow provides
  // 3-tier signer routing, expiry tracking, free-slot picking, and AgentMeta
  // persistence. The auto-setup path in LighterAdapter.init() remains as the
  // env-key fallback for users who haven't run the unified command yet.

  // ── Hyperliquid account abstraction mode ────────────────────────────────
  // Read side: HyperliquidAdapter._getAbstractionMode() (added v0.12.7).
  // Write side: HL `userSetAbstraction` action — master EVM EIP-712 signature.
  // Reuses the same `OwsEvmSigner.signTypedData` path as `wallet agent approve
  // hyperliquid` (see runHlApproveFlow). No agent signer involved: this is a
  // master-only action that toggles the user's account-level mode.
  manage
    .command("account-mode [mode]")
    .description("Hyperliquid account abstraction mode. Modes: unified | standard | portfolio. No arg = show current.")
    .option("--master <name>", "Master OWS wallet name (defaults to settings.owsActiveWallet)")
    .option("--passphrase <pp>", "Master OWS passphrase (fallback: OWS_PASSPHRASE env / stdin)")
    .option("--json", "Machine-readable output")
    .action(async (mode: string | undefined, opts: {
      master?: string;
      passphrase?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      // C5 fix: parent --passphrase shadows subcommand flag in Commander v13.
      // Merge parent + subcommand opts so --passphrase works on either side.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string; network?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;
      const network = mergedOpts.network ?? "mainnet";
      const isTestnet = network === "testnet";

      // ── Show branch (no positional arg) ─────────────────────────────────
      if (!mode) {
        try {
          const adapter = new HyperliquidAdapter(undefined, isTestnet);
          // Resolve the address. _getAbstractionMode requires an address; if
          // the user hasn't configured one, surface a clear error instead of
          // an opaque "address not set" exception.
          const masterName = opts.master ?? loadSettings().owsActiveWallet;
          if (!masterName) {
            throw new PerpError("INVALID_PARAMS", "Master wallet name required to read account-mode. Use --master <name> or set owsActiveWallet.", {
              remediation: "Run: perp wallet generate <name> or perp wallet use <name>, then retry.",
            });
          }
          // Resolve the EVM address from the OWS wallet without unlocking it
          // (read-only path needs no signature).
          const { loadOws } = await import("../signer/ows-loader.js");
          const ows = loadOws();
          const wallet = ows.getWallet(masterName);
          const evmAccount = wallet.accounts.find(
            (a: { chainId: string }) => a.chainId.startsWith("eip155:"),
          );
          if (!evmAccount) {
            throw new PerpError("INVALID_PARAMS", `OWS wallet "${masterName}" has no EVM account.`, {
              remediation: "Generate an EVM-capable wallet: perp wallet generate <name>",
            });
          }
          adapter.setAddress(evmAccount.address);
          const current = await adapter._getAbstractionMode();
          if (useJson) {
            return printJson(jsonOk({ mode: current, master: masterName, address: evmAccount.address, network: isTestnet ? "testnet" : "mainnet" }));
          }
          console.log(chalk.cyan.bold("\n  Hyperliquid Account Mode\n"));
          console.log(`  Master:   ${chalk.white(masterName)}`);
          console.log(`  Address:  ${chalk.gray(evmAccount.address)}`);
          console.log(`  Network:  ${chalk.gray(isTestnet ? "testnet" : "mainnet")}`);
          console.log(`  Mode:     ${chalk.green(current)}\n`);
          return;
        } catch (err) {
          if (useJson) {
            const e = err instanceof PerpError
              ? err.structured
              : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
            console.error(JSON.stringify(jsonError(e.code as never, e.message)));
            process.exit(1);
          }
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }

      // ── Set branch ─────────────────────────────────────────────────────
      const modeLower = mode.toLowerCase();
      if (modeLower !== "unified" && modeLower !== "standard" && modeLower !== "portfolio") {
        const e = new PerpError("INVALID_PARAMS", `Mode must be one of: unified, standard, portfolio (got "${mode}")`, {
          remediation: "Example: perp wallet manage account-mode standard --master main",
        });
        if (useJson) {
          console.error(JSON.stringify(jsonError(e.structured.code as never, e.structured.message)));
          process.exit(1);
        }
        console.error(chalk.red(e.message));
        process.exit(1);
      }
      const newMode = modeLower as HlAbstractionMode;

      try {
        const masterName = opts.master ?? loadSettings().owsActiveWallet;
        if (!masterName) {
          throw new PerpError("INVALID_PARAMS", "Master wallet name is required. Use --master or set owsActiveWallet in settings.", {
            remediation: "Run: perp wallet generate <name> or perp wallet use <name>, then retry.",
          });
        }
        const passphrase = await resolvePassphrase({ flag: passphraseFlag });
        if (passphrase === null) {
          throw new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
            remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
          });
        }

        // Capture previous mode (best-effort — info-only, do NOT block on read).
        let prevMode: HlAbstractionMode | null = null;
        try {
          const readAdapter = new HyperliquidAdapter(undefined, isTestnet);
          const { loadOws } = await import("../signer/ows-loader.js");
          const ows = loadOws();
          const wallet = ows.getWallet(masterName);
          const evmAccount = wallet.accounts.find(
            (a: { chainId: string }) => a.chainId.startsWith("eip155:"),
          );
          if (evmAccount) {
            readAdapter.setAddress(evmAccount.address);
            prevMode = await readAdapter._getAbstractionMode();
          }
        } catch {
          // Best-effort previous-mode capture. SSOT Rule #2 forbids fallback
          // for the primary action, but reading the prior mode is purely
          // informational metadata — its absence does NOT mask the write.
          prevMode = null;
        }

        const result = await runHlSetAbstractionFlow({
          masterName,
          passphrase: passphrase ?? "",
          mode: newMode,
          isTestnet,
        });

        if (useJson) {
          return printJson(jsonOk({
            mode: result.mode,
            prevMode,
            abstraction: result.abstraction,
            hyperliquidChain: result.hyperliquidChain,
            nonce: result.nonce,
            user: result.userEvmAddress,
            response: result.response,
          }));
        }
        console.log(chalk.green.bold("\n  Hyperliquid account mode updated.\n"));
        console.log(`  User:      ${chalk.gray(result.userEvmAddress)}`);
        console.log(`  Network:   ${chalk.gray(result.hyperliquidChain)}`);
        if (prevMode) console.log(`  Previous:  ${chalk.gray(prevMode)}`);
        console.log(`  New mode:  ${chalk.cyan(result.mode)} ${chalk.gray(`(${result.abstraction})`)}\n`);
      } catch (err) {
        if (useJson) {
          const e = err instanceof PerpError
            ? err.structured
            : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
          console.error(JSON.stringify(jsonError(e.code as never, e.message)));
          process.exit(1);
        }
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
