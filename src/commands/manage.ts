import { Command } from "commander";
import { isDryRun, networkOf, supportsDryRun } from "../cli-flags.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import chalk from "chalk";
import { hasPacificaSdk } from "../exchanges/capabilities.js";
import { PerpError, classifyError, parsePositiveDecimal } from "../errors.js";
import { unsupported } from "../exchanges/trading-v2.js";
import { loadSettings, saveSettings } from "../settings.js";
import { resolvePassphrase } from "../agent-wallet/passphrase.js";
import { runHlSetAbstractionFlow, type HlAbstractionMode } from "./agent.js";
import { HyperliquidAdapter, hlAbstractionCachePrefix } from "../exchanges/hyperliquid.js";
import { invalidateCache } from "../cache.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import { resolveVenueId } from "../exchanges/venue.js";

export function registerWalletManageCommands(
  parent: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getPacificaAdapter: () => unknown
) {
  const manage = parent.command("manage").description("Exchange account settings (margin, subaccount, API keys, builder-owner tools, account-mode) — Pacifica + Lighter + Hyperliquid");

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

  // Gated. Docs (rest-api/subaccounts/create-subaccount): "Both the main account and subaccount
  // must sign to establish the relationship." perp-cli has no keypair source for the subaccount
  // signature, so the request cannot be built.
  sub
    .command("create <name>")
    .description("Create a subaccount (not supported: the subaccount wallet must co-sign — use the Pacifica web app)")
    .action(async (_name: string) => {
      await pac();
      throw unsupported("Pacifica", "subaccountCreate",
        "creating a subaccount needs a signature from the subaccount wallet as well as the main account, and perp-cli only holds the main account signer",
        "Create the subaccount in the Pacifica web app, then use: perp wallet manage sub list / sub transfer");
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
    .description("Transfer USDC between a main account and its subaccounts (<from> must be the signing account)")
    .action(async (from: string, to: string, amount: string) => {
      const a = await pac();
      // Docs (subaccount-fund-transfer): the sender is the signing "account"; there is no from field.
      if (from !== a.publicKey) {
        throw new PerpError("INVALID_PARAMS", `Pacifica transfers are sent by the signing account (${a.publicKey}); <from> was ${from}`, {
          exchange: "pacifica",
          remediation: "Pass the active account as <from>, or run the command with the sender's wallet",
        });
      }
      const result = await a.sdk.transferFunds(
        { to_account: to, amount: parsePositiveDecimal(amount, "transfer amount") },
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

  // Field names per docs.pacifica.fi rest-api/vaults (create-vault / deposit-to-vault / withdraw-from-vault).
  lake
    .command("create")
    .description("Create a new vault (lake)")
    .option("--manager <address>", "Manager address (omit to create a fresh vault with no manager)")
    .option("--nickname <name>", "Display name for the vault")
    .option("--initial-deposit <amount>", "Seed deposit in USDC from the creator (master-signed only: refused with an agent key)")
    .action(async (opts: { manager?: string; nickname?: string; initialDeposit?: string }) => {
      const a = await pac();
      // A seed deposit moves funds into a vault like `vault deposit`: master-signed only (an agent
      // key must not be able to fund a vault it names the manager of).
      if (opts.initialDeposit !== undefined && (a as { activeSignerTier?: unknown }).activeSignerTier !== "master" && (a as { activeSignerTier?: unknown }).activeSignerTier !== "pk") {
        throw new PerpError("NO_SIGNER_AVAILABLE", "A vault seed deposit (--initial-deposit) must be signed by the master wallet, not the agent key", {
          exchange: "pacifica",
          remediation: "Re-run with --no-agent (master wallet), or create the vault without --initial-deposit and deposit with: perp -e pacifica vault deposit <vault> <amount>",
        });
      }
      const result = await a.sdk.createLake(
        {
          manager: opts.manager === undefined ? null : opts.manager,
          nickname: opts.nickname === undefined ? null : opts.nickname,
          initial_deposit: opts.initialDeposit === undefined ? null : parsePositiveDecimal(opts.initialDeposit, "--initial-deposit"),
        },
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Vault created.\n`));
      console.log(JSON.stringify(result, null, 2));
    });

  // deposit / withdraw moved to the validated path (`perp -e pacifica vault deposit|withdraw`):
  // nickname / address resolution, documented limits, --dry-run, unknown-outcome handling, and a
  // master-only vault deposit. These stubs refuse before any key is loaded or anything is signed.
  for (const [sub, args, target] of [["deposit", "<lake> <amount>", "vault deposit <vault> <amount>"], ["withdraw", "<lake> <shares>", "vault withdraw <vault> <shares>|--all"]] as const) {
    lake
      .command(`${sub} ${args}`)
      .description(`Moved: use perp -e pacifica ${target} (validated, supports --dry-run)`)
      .action(() => {
        throw new PerpError("INVALID_PARAMS", `wallet manage lake ${sub} was replaced by: perp -e pacifica ${target}`, {
          exchange: "pacifica",
          remediation: `Run: perp -e pacifica --dry-run ${target} — then without --dry-run (nothing was signed or sent)`,
        });
      });
  }

  // Pacifica builder-OWNER tools. A user's builder approval / revoke / status is
  // `perp wallet builder approve|revoke|status <venue>` (settings builder.<venue>).
  const builder = manage.command("builder").description("Pacifica builder-owner tools (overview, trades, leaderboard, update-fee). Approve / revoke / status: perp wallet builder");

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
  const referral = manage.command("referral").description("Referral codes (Pacifica claim; Hyperliquid/Lighter explicit set)");

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

  // Explicit referral apply (HL / Lighter). Never done on adapter creation: this
  // signs and sends one referral action with the active signer. Supports --dry-run.
  supportsDryRun(
    referral
      .command("set [code]")
      .description("Hyperliquid / Lighter: sign + send a one-time referral action (default code: settings referralCodes.<venue>; supports --dry-run)")
      .action(async (codeArg: string | undefined, _opts: unknown, cmd: Command) => {
        await withJsonErrors(isJson(), async () => {
          const venue = resolveVenueId(String(cmd.optsWithGlobals().exchange));
          if (venue !== "hyperliquid" && venue !== "lighter") {
            throw new PerpError("CAPABILITY_UNSUPPORTED", `referral set supports hyperliquid and lighter (got ${venue})`, {
              remediation: "Run with -e hyperliquid or -e lighter (Pacifica: perp -e pacifica wallet manage referral claim <code>)",
            });
          }
          const code = codeArg ?? loadSettings().referralCodes[venue];
          if (!code) {
            throw new PerpError("INVALID_PARAMS", `No ${venue} referral code given and settings referralCodes.${venue} is empty`, {
              remediation: `Pass a code: perp -e ${venue} wallet manage referral set <code>`,
            });
          }
          const network = networkOf(cmd);
          const plan = { venue, network, code, action: venue === "hyperliquid" ? "setReferrer" : "referral/use" };
          if (isDryRun(cmd)) {
            if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, ...plan }));
            console.log(chalk.yellow(`\n  [dry-run] Would sign + send ${plan.action} with code "${code}" on ${venue} (${network}). Nothing sent.\n`));
            return;
          }
          // The referral is the account owner's action — never signed with an imported agent / API key.
          const { cliCredentialOptsFrom, requireMasterWallet } = await import("../config.js");
          await requireMasterWallet(venue, cliCredentialOptsFrom(cmd.optsWithGlobals()), `${venue} referral set`);
          const adapter = await getAdapter();
          let result: unknown;
          if (venue === "hyperliquid") {
            if (!(adapter instanceof HyperliquidAdapter)) throw new Error("hyperliquid venue did not produce a HyperliquidAdapter");
            result = await adapter.setReferrer(code);
          } else {
            if (!(adapter instanceof LighterAdapter)) throw new Error("lighter venue did not produce a LighterAdapter");
            if (adapter.isReadOnly) {
              throw new PerpError("NO_SIGNER_AVAILABLE", "Lighter referral needs a signer (agent API key)", {
                remediation: "Register one first: perp wallet agent approve lighter",
              });
            }
            result = await adapter.useReferralCode(code);
          }
          const s = loadSettings();
          s.referralApplied[venue] = true;
          saveSettings(s);
          if (isJson()) return printJson(jsonOk({ sent: true, ...plan, result }));
          console.log(chalk.green(`\n  ${venue} referral code "${code}" applied.\n`));
        });
      }),
  );

  // API Keys
  const apikey = manage.command("apikey").description("API key management");

  apikey
    .command("create")
    .description("Create an API Config Key (rate-limit key; up to 5 per account)")
    .action(async () => {
      const a = await pac();
      // Docs (api/rate-limits/api-config-keys): no name / fee-rate field — the signed payload is empty.
      const result = await a.sdk.createApiKey(
        a.publicKey,
        a.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  API Config Key created.\n`));
      console.log(JSON.stringify(result, null, 2));
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
  // persistence.

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
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;
      const network = networkOf(command);
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
          // The command that reports the mode never answers from the disk cache.
          const current = await adapter._getAbstractionMode({ fresh: true });
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
            const e = classifyError(err);
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
        let prevMode: HlAbstractionMode | "default" | "dexAbstraction" | null = null;
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
            prevMode = await readAdapter._getAbstractionMode({ fresh: true });
          }
        } catch {
          // Best-effort previous-mode capture. SSOT Rule #2 forbids fallback
          // for the primary action, but reading the prior mode is purely
          // informational metadata — its absence does NOT mask the write.
          prevMode = null;
        }

        // The cached mode (HL_ABSTRACTION_TTL_MS) is dropped whatever the outcome: a sent action
        // whose answer was lost may have changed the mode.
        let result: Awaited<ReturnType<typeof runHlSetAbstractionFlow>>;
        try {
          result = await runHlSetAbstractionFlow({
            masterName,
            passphrase: passphrase ?? "",
            mode: newMode,
            isTestnet,
          });
        } finally {
          invalidateCache(hlAbstractionCachePrefix(network));
        }

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
          const e = classifyError(err);
          console.error(JSON.stringify(jsonError(e.code as never, e.message)));
          process.exit(1);
        }
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
