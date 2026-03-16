#!/usr/bin/env node
import { config } from "dotenv";
import { resolve } from "path";
import { createRequire } from "node:module";

// Load ~/.perp/.env first (global), then CWD .env (overrides)
config({ path: resolve(process.env.HOME || "~", ".perp", ".env") });
config();
import { Command } from "commander";
import chalk from "chalk";
import type { Network } from "./pacifica/index.js";
import { Keypair } from "@solana/web3.js";
import { tryLoadPrivateKey, parseSolanaKeypair, type Exchange } from "./config.js";
import { PacificaAdapter } from "./exchanges/pacifica.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";
// LighterAdapter is lazy-imported to avoid CJS/ESM issues at startup
import type { LighterAdapter } from "./exchanges/lighter.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerTradeCommands } from "./commands/trade.js";
import { registerManageCommands } from "./commands/manage.js";
// stream commands removed — WS feeds still used by dashboard/event-stream internally
import { registerArbCommands } from "./commands/arb.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerBridgeCommands } from "./commands/bridge.js";
// deposit + withdraw merged into funds
import { registerFundsCommands } from "./commands/funds.js";
// alert commands removed
import { registerArbAutoCommands } from "./commands/arb-auto.js";
import { registerArbManageCommands } from "./commands/arb/index.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerRebalanceCommands } from "./commands/rebalance.js";
import { registerBotCommands } from "./commands/bot.js";
import { registerRiskCommands } from "./commands/risk.js";
import { registerHistoryCommands } from "./commands/history.js";
import { registerSettingsCommands } from "./commands/settings.js";
// dex commands merged into market (hip3) — use --dex flag for markets/balance
import { registerPlanCommands } from "./commands/plan.js";
// funding merged into arb.ts
import { registerBacktestCommands } from "./commands/backtest.js";
import { registerDashboardCommands } from "./commands/dashboard.js";
import { registerInitCommand, EXCHANGE_ENV_MAP, validateKey } from "./commands/init.js";
import { loadSettings, saveSettings } from "./settings.js";
import { setSharedApiNetwork } from "./shared-api.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

const program = new Command();

// Resolve default exchange from settings (fallback: "pacifica")
const _settings = loadSettings();
const _defaultExchange = _settings.defaultExchange || "pacifica";

program
  .name("perp")
  .description("Multi-DEX Perpetual Futures CLI (Pacifica, Hyperliquid, Lighter)")
  .version(_pkg.version)
  .option("-e, --exchange <exchange>", `Exchange: pacifica, hyperliquid, lighter (default: ${_defaultExchange})`, _defaultExchange)
  .option("-n, --network <network>", "Network: mainnet or testnet", "mainnet")
  .option("-k, --private-key <key>", "Private key")
  .option("--json", "Output raw JSON (for piping)")
  .option("--fields <fields>", "Comma-separated fields to include in JSON output (e.g. totalEquity,positions)")
  .option("--ndjson", "Output newline-delimited JSON (one object per line for streaming)")
  .option("--dry-run", "Simulate trades without executing (log as simulated)")
  .option("-w, --wallet <name>", "Use a specific wallet by name (from 'perp wallet list')")
  .option("--dex <name>", "HIP-3 deployed perp dex name (Hyperliquid only)")
  .configureOutput({
    writeErr: (str) => {
      if (process.argv.includes("--json")) {
        const msg = str.replace(/^error:\s*/i, "").trim();
        // Use inline envelope (jsonError import not available in sync context)
        console.log(JSON.stringify({
          ok: false,
          error: { code: "CLI_ERROR", message: msg },
          meta: { timestamp: new Date().toISOString() },
        }));
      } else {
        process.stderr.write(str);
      }
    },
  });

let _adapter: ExchangeAdapter | null = null;
let _pacificaAdapter: PacificaAdapter | null = null;
let _hlAdapter: HyperliquidAdapter | null = null;
let _lighterAdapter: LighterAdapter | null = null;

/** Map short aliases to canonical exchange names. Full names pass through. */
function resolveExchangeAlias(name: string): string {
  const aliases: Record<string, string> = {
    hl: "hyperliquid",
    lt: "lighter",
    pac: "pacifica",
  };
  return aliases[name.toLowerCase()] ?? name.toLowerCase();
}

function getExchange(): Exchange {
  return resolveExchangeAlias(program.opts().exchange) as Exchange;
}

async function getAdapter(): Promise<ExchangeAdapter> {
  const opts = program.opts();
  const walletName = opts.wallet as string | undefined;

  // Skip cache when --wallet is specified (different wallet = different account)
  if (!walletName && _adapter) return _adapter;

  const exchange = resolveExchangeAlias(opts.exchange) as Exchange;
  const network = opts.network as string;
  const isTestnet = network === "testnet";

  // Try to load key — null means no key configured (read-only mode)
  const pk = await tryLoadPrivateKey(exchange, opts.privateKey, walletName);

  switch (exchange) {
    case "pacifica": {
      const keypair = pk ? parseSolanaKeypair(pk) : Keypair.generate();
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const settings = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || settings.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode, !!pk);
      _adapter = _pacificaAdapter;
      break;
    }
    case "hyperliquid": {
      _hlAdapter = new HyperliquidAdapter(pk ?? undefined, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
      if (pk) {
        const hlSettings = loadSettings();
        if (hlSettings.referrals && !hlSettings.referralApplied.hyperliquid) {
          const hlRef = process.env.HL_REFERRAL_CODE || hlSettings.referralCodes.hyperliquid;
          if (hlRef) {
            _hlAdapter.autoSetReferrer(hlRef).then(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            });
          }
        }
      }
      _adapter = _hlAdapter;
      break;
    }
    case "lighter": {
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      _lighterAdapter = new LighterAdapter(pk ?? "", isTestnet);
      await _lighterAdapter.init();
      if (pk) {
        const ltSettings = loadSettings();
        if (ltSettings.referrals && !ltSettings.referralApplied.lighter) {
          const ltRef = process.env.LIGHTER_REFERRAL_CODE || ltSettings.referralCodes.lighter;
          if (ltRef) {
            _lighterAdapter.useReferralCode(ltRef).then(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            });
          }
        }
      }
      _adapter = _lighterAdapter;
      break;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }

  return _adapter;
}

// Sync wrapper for commands that need adapter (lazy init)
function getAdapterSync(): ExchangeAdapter {
  if (!_adapter) throw new Error("Adapter not initialized");
  return _adapter;
}

function isJson(): boolean {
  return !!program.opts().json || process.argv.includes("--ndjson");
}

function isDryRun(): boolean {
  return !!program.opts().dryRun;
}

// Helper to get PacificaAdapter specifically (for Pacifica-only commands)
function getPacificaAdapter(): PacificaAdapter {
  if (!_pacificaAdapter) throw new Error("This command requires --exchange pacifica");
  return _pacificaAdapter;
}

function getHLAdapter(): HyperliquidAdapter {
  if (!_hlAdapter) throw new Error("This command requires --exchange hyperliquid");
  return _hlAdapter;
}

// Register command groups with async adapter getter
registerMarketCommands(program, getAdapter, isJson, getAdapterForExchange);
registerAccountCommands(program, getAdapter, isJson, getAdapterForExchange);
registerTradeCommands(program, getAdapter, isJson, isDryRun, getAdapterForExchange);
registerManageCommands(program, getAdapter, isJson, getPacificaAdapter);
// stream commands removed
registerArbCommands(program, isJson, getAdapterForExchange);
registerWalletCommands(program, isJson);
registerBridgeCommands(program, isJson);
registerFundsCommands(
  program,
  getAdapter,
  isJson,
  () => program.opts().network as Network
);
// alert commands removed

// Helper to get adapter for a specific exchange (used by arb-auto)
async function getAdapterForExchange(rawExchange: string): Promise<ExchangeAdapter> {
  const exchange = resolveExchangeAlias(rawExchange);
  const opts = program.opts();
  const network = opts.network as string;
  const isTestnet = network === "testnet";
  const walletName = opts.wallet as string | undefined;
  const pk = await tryLoadPrivateKey(exchange as Exchange, opts.privateKey, walletName);

  switch (exchange) {
    case "pacifica": {
      if (_pacificaAdapter) return _pacificaAdapter;
      const keypair = pk ? parseSolanaKeypair(pk) : Keypair.generate();
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const s1 = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || s1.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode, !!pk);
      if (!_adapter) _adapter = _pacificaAdapter;
      return _pacificaAdapter;
    }
    case "hyperliquid": {
      if (_hlAdapter) return _hlAdapter;
      _hlAdapter = new HyperliquidAdapter(pk ?? undefined, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
      if (pk) {
        const s2 = loadSettings();
        if (s2.referrals && !s2.referralApplied.hyperliquid) {
          const hlRef = process.env.HL_REFERRAL_CODE || s2.referralCodes.hyperliquid;
          if (hlRef) {
            _hlAdapter.autoSetReferrer(hlRef).then(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            });
          }
        }
      }
      if (!_adapter) _adapter = _hlAdapter;
      return _hlAdapter;
    }
    case "lighter": {
      if (_lighterAdapter) return _lighterAdapter;
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      _lighterAdapter = new LighterAdapter(pk ?? "", isTestnet);
      await _lighterAdapter.init();
      if (pk) {
        const s3 = loadSettings();
        if (s3.referrals && !s3.referralApplied.lighter) {
          const ltRef = process.env.LIGHTER_REFERRAL_CODE || s3.referralCodes.lighter;
          if (ltRef) {
            _lighterAdapter.useReferralCode(ltRef).then(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            });
          }
        }
      }
      if (!_adapter) _adapter = _lighterAdapter;
      return _lighterAdapter;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }
}

// Helper to get an HL adapter configured for a specific HIP-3 dex
const _dexAdapters = new Map<string, HyperliquidAdapter>();
async function getHLAdapterForDex(dex: string): Promise<HyperliquidAdapter> {
  if (_dexAdapters.has(dex)) return _dexAdapters.get(dex)!;
  const opts = program.opts();
  const walletName = opts.wallet as string | undefined;
  const pk = await tryLoadPrivateKey("hyperliquid", opts.privateKey, walletName);
  const adapter = new HyperliquidAdapter(pk ?? undefined, opts.network === "testnet");
  if (dex !== "hl") adapter.setDex(dex);
  await adapter.init();
  _dexAdapters.set(dex, adapter);
  return adapter;
}

registerArbAutoCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
registerArbManageCommands(program, getAdapterForExchange, isJson);
registerAgentCommands(program, getAdapter, isJson);
// withdraw merged into funds
registerRebalanceCommands(program, getAdapterForExchange, isJson);

// Jobs & strategies
import { registerJobsCommands } from "./commands/jobs.js";
registerJobsCommands(program, isJson);
registerBotCommands(program, getAdapter, getAdapterForExchange, isJson);

// Agent-friendly commands
registerRiskCommands(program, getAdapterForExchange, isJson);
registerHistoryCommands(program, isJson, getAdapterForExchange);
registerSettingsCommands(program, isJson, getAdapterForExchange);
// dex commands removed — use 'market hip3' + --dex flag
registerPlanCommands(program, getAdapter, isJson);
// funding merged into arb — registerFundingCommands removed
registerBacktestCommands(program, isJson);
registerDashboardCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
registerInitCommand(program);

// Agent discovery: perp api-spec — deprecated, use 'perp agent schema'
const apiSpecCmd = program
  .command("api-spec")
  .description("Use 'perp agent schema'")
  .action(async () => {
    const { jsonOk, printJson } = await import("./utils.js");
    const { getCliSpec } = await import("./cli-spec.js");
    printJson(jsonOk(getCliSpec(program)));
  });
(apiSpecCmd as any)._hidden = true;

// Deprecated: perp status → use 'perp portfolio' or 'perp account'
const statusCmd = program.command("status").description("Use 'perp portfolio'")
  .option("--health", "Check connectivity").action(async (opts: { health?: boolean }) => {
    if (opts.health) { const { runHealthCheck } = await import("./commands/risk.js"); return runHealthCheck(isJson); }
    console.log("Use 'perp portfolio' or 'perp account' instead.");
  });
(statusCmd as any)._hidden = true;

// Switch shared API URLs if --network testnet is used
program.hook("preAction", () => {
  const network = program.opts().network as string;
  if (network === "testnet") setSharedApiNetwork("testnet");
});

// Smart landing page: `perp` with no subcommand
const rawArgs = process.argv.slice(2);
const hasSubcommand = rawArgs.some((a) => !a.startsWith("-") && !["pacifica", "hyperliquid", "lighter", "hl", "lt", "pac", "mainnet", "testnet"].includes(a));

if (rawArgs.length === 0 || (!hasSubcommand && !rawArgs.includes("-h") && !rawArgs.includes("--help") && !rawArgs.includes("-V") && !rawArgs.includes("--version"))) {
  // No subcommand — show smart landing instead of help dump
  (async () => {
    try {
      const { getWalletSetupStatus } = await import("./commands/wallet.js");
      const status = getWalletSetupStatus();
      const settings = loadSettings();
      const hasEnvKey = !!(process.env.PRIVATE_KEY || process.env.PACIFICA_PRIVATE_KEY ||
        process.env.HL_PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY ||
        process.env.LIGHTER_PRIVATE_KEY);

      if (!status.hasWallets && !hasEnvKey && !settings.defaultExchange) {
        // Fresh install — onboarding
        console.log(chalk.cyan.bold("\n  Welcome to perp-cli!") + chalk.gray(`  v${_pkg.version}\n`));
        console.log("  Multi-DEX perpetual futures CLI for Pacifica, Hyperliquid, and Lighter.\n");
        console.log(`  Get started:  ${chalk.cyan("perp wallet set <exchange> <key>")}`);
        console.log(chalk.gray(`\n  Or explore without a wallet:`));
        console.log(`    ${chalk.green("perp market list")}              available markets`);
        console.log(`    ${chalk.green("perp -e hyperliquid market list")}  Hyperliquid markets`);
        console.log(`    ${chalk.green("perp arb scan")}                 funding rate arbitrage`);
        console.log(`    ${chalk.green("perp --help")}                   all commands\n`);
      } else {
        // Configured — show status overview
        const defaultEx = settings.defaultExchange || "pacifica";
        const activeEntries = Object.entries(status.active);
        console.log(chalk.cyan.bold("\n  perp-cli") + chalk.gray(`  v${_pkg.version}\n`));
        console.log(`  Default exchange: ${chalk.cyan(defaultEx)}`);

        if (activeEntries.length > 0) {
          console.log(chalk.white.bold("\n  Wallets:"));
          for (const [exchange, walletName] of activeEntries) {
            const w = status.wallets[walletName];
            if (w) {
              const addr = w.address.length > 20
                ? w.address.slice(0, 6) + "..." + w.address.slice(-4)
                : w.address;
              console.log(`    ${chalk.cyan(exchange.padEnd(14))} ${chalk.white(walletName)} ${chalk.gray(addr)}`);
            }
          }
        } else if (hasEnvKey) {
          console.log(chalk.white.bold("\n  Configured:"));
          for (const [exchange, info] of Object.entries(EXCHANGE_ENV_MAP)) {
            const key = process.env[info.envKey];
            if (key) {
              try {
                const { valid, address } = await validateKey(info.chain, key);
                const addr = valid ? address : "(invalid key)";
                console.log(`    ${chalk.cyan(exchange.padEnd(14))} ${chalk.green(addr)}`);
              } catch {
                console.log(`    ${chalk.cyan(exchange.padEnd(14))} ${chalk.gray("(error reading key)")}`);
              }
            }
          }
        }

        console.log(chalk.white.bold("\n  Quick commands:"));
        console.log(`    ${chalk.green("perp portfolio")}     balances + positions + risk`);
        console.log(`    ${chalk.green("perp market list")}   available markets`);
        console.log(`    ${chalk.green("perp arb scan")}      funding rate arbitrage`);
        console.log(`    ${chalk.green("perp dashboard")}     live monitoring`);
        console.log(`    ${chalk.green("perp --help")}        all commands\n`);
      }
    } catch {
      program.help();
    }
  })();
} else {
program.parseAsync().then(() => {
  // Allow a short delay for any pending output, then exit cleanly.
  // Without this, HL SDK's WebSocket keeps the process alive indefinitely.
  setTimeout(() => process.exit(0), 500);
}).catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (isJson()) {
    const { jsonError } = await import("./utils.js");
    console.log(JSON.stringify(jsonError("FATAL", msg)));
  } else {
    console.error(chalk.red(msg));
  }
  process.exit(1);
});
}
