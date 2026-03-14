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
import { loadPrivateKey, tryLoadPrivateKey, parseSolanaKeypair, type Exchange } from "./config.js";
import { PacificaAdapter } from "./exchanges/pacifica.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";
// LighterAdapter is lazy-imported to avoid CJS/ESM issues at startup
import type { LighterAdapter } from "./exchanges/lighter.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerTradeCommands } from "./commands/trade.js";
import { registerManageCommands } from "./commands/manage.js";
import { registerStreamCommands } from "./commands/stream.js";
import { registerArbCommands } from "./commands/arb.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerBridgeCommands } from "./commands/bridge.js";
import { registerDepositCommands } from "./commands/deposit.js";
import { registerAlertCommands } from "./commands/alert.js";
import { registerArbAutoCommands } from "./commands/arb-auto.js";
import { registerArbManageCommands } from "./commands/arb-manage.js";
import { registerGapCommands } from "./commands/gap.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerWithdrawCommands } from "./commands/withdraw.js";
import { registerRebalanceCommands } from "./commands/rebalance.js";
import { registerBotCommands } from "./commands/bot.js";
import { registerHealthCommands } from "./commands/health.js";
import { registerPortfolioCommands } from "./commands/portfolio.js";
import { registerRiskCommands } from "./commands/risk.js";
import { registerHistoryCommands } from "./commands/history.js";
import { registerAnalyticsCommands } from "./commands/analytics.js";
import { registerPnlCommands } from "./commands/pnl.js";
import { registerMultilegCommands } from "./commands/multileg.js";
import { registerSettingsCommands } from "./commands/settings.js";
import { registerDexCommands } from "./commands/dex.js";
import { registerPlanCommands } from "./commands/plan.js";
import { registerFundingCommands } from "./commands/funding.js";
import { registerBacktestCommands } from "./commands/backtest.js";
import { registerDashboardCommands } from "./commands/dashboard.js";
import { registerInitCommand, EXCHANGE_ENV_MAP, validateKey } from "./commands/init.js";
import { registerEnvCommands } from "./commands/env.js";
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

function getExchange(): Exchange {
  return program.opts().exchange as Exchange;
}

async function getAdapter(): Promise<ExchangeAdapter> {
  if (_adapter) return _adapter;

  const opts = program.opts();
  const exchange = opts.exchange as Exchange;
  const network = opts.network as string;
  const isTestnet = network === "testnet";

  switch (exchange) {
    case "pacifica": {
      const pk = await loadPrivateKey("pacifica", opts.privateKey);
      const keypair = parseSolanaKeypair(pk);
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const settings = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || settings.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode);
      _adapter = _pacificaAdapter;
      break;
    }
    case "hyperliquid": {
      const pk = await loadPrivateKey("hyperliquid", opts.privateKey);
      _hlAdapter = new HyperliquidAdapter(pk, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
      const hlSettings = loadSettings();
      if (hlSettings.referrals && !hlSettings.referralApplied.hyperliquid) {
        const hlRef = process.env.HL_REFERRAL_CODE || hlSettings.referralCodes.hyperliquid;
        if (hlRef) {
          _hlAdapter.autoSetReferrer(hlRef).then(() => {
            const s = loadSettings();
            s.referralApplied.hyperliquid = true;
            saveSettings(s);
          }).catch(() => {
            // Already referred or API error — mark as done either way
            const s = loadSettings();
            s.referralApplied.hyperliquid = true;
            saveSettings(s);
          });
        }
      }
      _adapter = _hlAdapter;
      break;
    }
    case "lighter": {
      const pk = await loadPrivateKey("lighter", opts.privateKey);
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      _lighterAdapter = new LighterAdapter(pk, isTestnet);
      await _lighterAdapter.init();
      const ltSettings = loadSettings();
      if (ltSettings.referrals && !ltSettings.referralApplied.lighter) {
        const ltRef = process.env.LIGHTER_REFERRAL_CODE || ltSettings.referralCodes.lighter;
        if (ltRef) {
          _lighterAdapter.useReferralCode(ltRef).then(() => {
            const s = loadSettings();
            s.referralApplied.lighter = true;
            saveSettings(s);
          }).catch(() => {
            // Already referred or API error — mark as done either way
            const s = loadSettings();
            s.referralApplied.lighter = true;
            saveSettings(s);
          });
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

/**
 * Get an adapter for read-only operations (market data).
 * Falls back to a keyless adapter if no private key is configured.
 */
async function getReadOnlyAdapter(): Promise<ExchangeAdapter> {
  // If full adapter already initialized, reuse it
  if (_adapter) return _adapter;

  const opts = program.opts();
  const exchange = opts.exchange as Exchange;
  const network = opts.network as string;
  const isTestnet = network === "testnet";

  // Try loading key — if available, use full adapter
  const pk = await tryLoadPrivateKey(exchange, opts.privateKey);
  if (pk) return getAdapter();

  // No key — create minimal read-only adapter
  switch (exchange) {
    case "pacifica": {
      const { Keypair } = await import("@solana/web3.js");
      const dummyKeypair = Keypair.generate();
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      return new PacificaAdapter(dummyKeypair, pacNetwork);
    }
    case "hyperliquid": {
      // SDK can be created with enableWs: false and no key for info-only calls
      const { Hyperliquid } = await import("hyperliquid");
      const sdk = new Hyperliquid({ testnet: isTestnet, enableWs: false });
      // Create adapter with dummy key but don't call init() (no signing needed)
      // Instead, create a minimal wrapper that delegates to sdk.info
      const adapter = Object.create(HyperliquidAdapter.prototype) as HyperliquidAdapter;
      // Use the raw SDK for read-only info calls
      const infoAdapter = {
        name: "hyperliquid",
        sdk,
        getMarkets: async () => {
          const [meta, allMids] = await Promise.all([
            sdk.info.perpetuals.getMetaAndAssetCtxs(),
            sdk.info.getAllMids(),
          ]);
          const universe = meta[0]?.universe ?? [];
          const ctxs = meta[1] ?? [];
          const mids = allMids as Record<string, string>;
          return universe.map((asset: Record<string, unknown>, i: number) => {
            const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
            const sym = String(asset.name);
            return {
              symbol: sym,
              markPrice: String(ctx.markPx ?? mids[sym] ?? "0"),
              indexPrice: String(ctx.oraclePx ?? "0"),
              fundingRate: String(ctx.funding ?? "0"),
              volume24h: String(ctx.dayNtlVlm ?? "0"),
              openInterest: String(ctx.openInterest ?? "0"),
              maxLeverage: Number(asset.maxLeverage ?? 50),
            };
          });
        },
        getOrderbook: async (symbol: string) => {
          const book = await sdk.info.getL2Book(symbol.toUpperCase());
          const levels = book?.levels ?? [[], []];
          return {
            bids: (levels[0] ?? []).map((l: Record<string, unknown>) => [String(l.px ?? "0"), String(l.sz ?? "0")] as [string, string]),
            asks: (levels[1] ?? []).map((l: Record<string, unknown>) => [String(l.px ?? "0"), String(l.sz ?? "0")] as [string, string]),
          };
        },
        getRecentTrades: async (symbol: string, limit = 20) => {
          const baseUrl = isTestnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
          const res = await fetch(`${baseUrl}/info`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "recentTrades", coin: symbol.toUpperCase() }) });
          const trades = await res.json() as Record<string, unknown>[];
          return (trades ?? []).slice(0, limit).map((t) => ({ time: Number(t.time ?? 0), symbol: String(t.coin ?? symbol.toUpperCase()), side: String(t.side) === "B" ? "buy" as const : "sell" as const, price: String(t.px ?? "0"), size: String(t.sz ?? ""), fee: "0" }));
        },
        getFundingHistory: async (symbol: string, limit = 10) => {
          const now = Date.now();
          const history = await sdk.info.perpetuals.getFundingHistory(symbol.toUpperCase(), now - 24 * 60 * 60 * 1000);
          return (history ?? []).slice(-limit).map((h) => ({ time: Number(h.time ?? 0), rate: String(h.fundingRate ?? "0"), price: "-" }));
        },
        getKlines: async (symbol: string, interval: string, startTime: number, endTime: number) => {
          const candles = await sdk.info.getCandleSnapshot(symbol.toUpperCase(), interval, startTime, endTime);
          return (candles ?? []).map((c) => ({ time: Number(c.t ?? 0), open: String(c.o ?? "0"), high: String(c.h ?? "0"), low: String(c.l ?? "0"), close: String(c.c ?? "0"), volume: String(c.v ?? ""), trades: Number(c.n ?? 0) }));
        },
        // Stubs for methods that require auth — market commands don't call these
        getBalance: () => { throw new Error("No private key configured. Run: perp init"); },
        getPositions: () => { throw new Error("No private key configured. Run: perp init"); },
        getOpenOrders: () => { throw new Error("No private key configured. Run: perp init"); },
        getOrderHistory: () => { throw new Error("No private key configured. Run: perp init"); },
        getTradeHistory: () => { throw new Error("No private key configured. Run: perp init"); },
        getFundingPayments: () => { throw new Error("No private key configured. Run: perp init"); },
        marketOrder: () => { throw new Error("No private key configured. Run: perp init"); },
        limitOrder: () => { throw new Error("No private key configured. Run: perp init"); },
        editOrder: () => { throw new Error("No private key configured. Run: perp init"); },
        cancelOrder: () => { throw new Error("No private key configured. Run: perp init"); },
        cancelAllOrders: () => { throw new Error("No private key configured. Run: perp init"); },
        setLeverage: () => { throw new Error("No private key configured. Run: perp init"); },
        stopOrder: () => { throw new Error("No private key configured. Run: perp init"); },
      } as unknown as ExchangeAdapter;
      return infoAdapter;
    }
    case "lighter": {
      // Lighter's market data is REST-based, no auth needed
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      // Use a dummy key — LighterAdapter in read-only mode works without a real key for market data
      const dummyKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
      const adapter = new LighterAdapter(dummyKey, isTestnet);
      await adapter.init();
      return adapter;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }
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
registerMarketCommands(program, getReadOnlyAdapter, isJson);
registerAccountCommands(program, getAdapter, isJson);
registerTradeCommands(program, getAdapter, isJson, isDryRun);
registerManageCommands(program, getAdapter, isJson, getPacificaAdapter);
registerStreamCommands(program, () => program.opts().network as Network, getExchange, getAdapter);
registerArbCommands(program, isJson);
registerWalletCommands(program, isJson);
registerBridgeCommands(program, isJson);
registerDepositCommands(
  program,
  getAdapter,
  isJson,
  () => program.opts().network as Network
);
registerAlertCommands(program, isJson, getAdapterForExchange);

// Helper to get adapter for a specific exchange (used by arb-auto)
async function getAdapterForExchange(exchange: string): Promise<ExchangeAdapter> {
  const opts = program.opts();
  const network = opts.network as string;
  const isTestnet = network === "testnet";

  switch (exchange) {
    case "pacifica": {
      if (_pacificaAdapter) return _pacificaAdapter;
      const pk = await loadPrivateKey("pacifica", opts.privateKey);
      const keypair = parseSolanaKeypair(pk);
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const s1 = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || s1.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode);
      if (!_adapter) _adapter = _pacificaAdapter;
      return _pacificaAdapter;
    }
    case "hyperliquid": {
      if (_hlAdapter) return _hlAdapter;
      const pk = await loadPrivateKey("hyperliquid", opts.privateKey);
      _hlAdapter = new HyperliquidAdapter(pk, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
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
      if (!_adapter) _adapter = _hlAdapter;
      return _hlAdapter;
    }
    case "lighter": {
      if (_lighterAdapter) return _lighterAdapter;
      const pk = await loadPrivateKey("lighter", opts.privateKey);
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      _lighterAdapter = new LighterAdapter(pk, isTestnet);
      await _lighterAdapter.init();
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
  const pk = await loadPrivateKey("hyperliquid", opts.privateKey);
  const adapter = new HyperliquidAdapter(pk, opts.network === "testnet");
  if (dex !== "hl") adapter.setDex(dex);
  await adapter.init();
  _dexAdapters.set(dex, adapter);
  return adapter;
}

registerArbAutoCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
registerArbManageCommands(program, getAdapterForExchange, isJson);
registerGapCommands(program, isJson);
registerAgentCommands(program, getAdapter, isJson);
registerWithdrawCommands(program, getAdapter, isJson);
registerRebalanceCommands(program, getAdapterForExchange, isJson);

// Jobs & strategies
import { registerJobsCommands } from "./commands/jobs.js";
import { registerRunCommands } from "./commands/run.js";
registerJobsCommands(program, isJson);
registerRunCommands(program, getAdapter, getAdapterForExchange, isJson);
registerBotCommands(program, getAdapter, getAdapterForExchange, isJson);

// Agent-friendly commands
registerHealthCommands(program, isJson);
registerPortfolioCommands(program, getAdapterForExchange, isJson);
registerRiskCommands(program, getAdapterForExchange, isJson);
registerHistoryCommands(program, isJson);
registerAnalyticsCommands(program, getAdapterForExchange, isJson);
registerPnlCommands(program, getAdapterForExchange, isJson);
registerMultilegCommands(program, getAdapterForExchange, isJson);
registerSettingsCommands(program, isJson, getAdapterForExchange);
registerDexCommands(program, getAdapter, isJson);
registerPlanCommands(program, getAdapter, isJson);
registerFundingCommands(program, isJson, getAdapterForExchange);
registerBacktestCommands(program, isJson);
registerDashboardCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
registerInitCommand(program);
registerEnvCommands(program, isJson);

// Agent discovery: perp api-spec — returns full CLI spec as JSON
program
  .command("api-spec")
  .description("Return full CLI command spec as JSON (for agent discovery)")
  .action(async () => {
    const { jsonOk, printJson } = await import("./utils.js");
    const { getCliSpec } = await import("./cli-spec.js");
    printJson(jsonOk(getCliSpec(program)));
  });

// Status command
program
  .command("status")
  .description("Quick overview: account + positions + open orders")
  .action(async () => {
    const adapter = await getAdapter();
    const json = isJson();

    try {
      // Use allSettled to handle unfunded/404 accounts gracefully
      const [balanceResult, positionsResult, ordersResult] = await Promise.allSettled([
        adapter.getBalance(),
        adapter.getPositions(),
        adapter.getOpenOrders(),
      ]);

      const balance = balanceResult.status === "fulfilled" ? balanceResult.value : { equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0" };
      const positions = positionsResult.status === "fulfilled" ? positionsResult.value : [];
      const orders = ordersResult.status === "fulfilled" ? ordersResult.value : [];

      // Collect errors for reporting
      const errors: string[] = [];
      if (balanceResult.status === "rejected") errors.push(`balance: ${balanceResult.reason instanceof Error ? balanceResult.reason.message : String(balanceResult.reason)}`);
      if (positionsResult.status === "rejected") errors.push(`positions: ${positionsResult.reason instanceof Error ? positionsResult.reason.message : String(positionsResult.reason)}`);
      if (ordersResult.status === "rejected") errors.push(`orders: ${ordersResult.reason instanceof Error ? ordersResult.reason.message : String(ordersResult.reason)}`);

      // Detect unfunded account (all calls failed, likely 404)
      const allFailed = errors.length === 3;
      const isUnfunded = allFailed && errors.some(e => e.includes("404") || e.includes("not found") || e.includes("does not exist"));

      if (json) {
        const { jsonOk, printJson } = await import("./utils.js");
        return printJson(jsonOk({
          exchange: adapter.name,
          balance,
          positions,
          orders,
          ...(isUnfunded ? { warning: "Account not yet initialized on this exchange. Deposit funds to get started." } : {}),
          ...(errors.length > 0 && !isUnfunded ? { errors } : {}),
        }));
      }

      console.log(chalk.cyan.bold(`\n  ${adapter.name.toUpperCase()} Account Status\n`));

      if (isUnfunded) {
        console.log(chalk.yellow("  Account not yet initialized on this exchange."));
        console.log(chalk.gray("  Deposit funds to get started: perp deposit <exchange> <amount>\n"));
      } else {
        console.log(`  Equity:      $${Number(balance.equity).toFixed(2)}`);
        console.log(`  Available:   $${Number(balance.available).toFixed(2)}`);
        console.log(`  Margin Used: $${Number(balance.marginUsed).toFixed(2)}`);
        console.log(`  Positions:   ${positions.length}`);
        console.log(`  Open Orders: ${orders.length}`);

        if (positions.length > 0) {
          console.log(chalk.cyan.bold("\n  Positions:"));
          positions.forEach((p) => {
            const color = p.side === "long" ? chalk.green : chalk.red;
            const pnlNum = Number(p.unrealizedPnl);
            const pnlColor = pnlNum >= 0 ? chalk.green : chalk.red;
            console.log(
              `    ${color(p.side.toUpperCase().padEnd(5))} ${chalk.white(p.symbol.padEnd(12))} ${p.size.padEnd(10)} entry: $${Number(p.entryPrice).toFixed(2)}  pnl: ${pnlColor(pnlNum >= 0 ? "+" : "")}$${pnlNum.toFixed(2)}`
            );
          });
        }

        if (orders.length > 0) {
          console.log(chalk.cyan.bold("\n  Open Orders:"));
          orders.forEach((o) => {
            const color = o.side === "buy" ? chalk.green : chalk.red;
            console.log(
              `    ${color(o.side.toUpperCase().padEnd(4))} ${chalk.white(o.symbol.padEnd(12))} ${o.type.padEnd(8)} $${Number(o.price).toFixed(2)} x ${o.size}`
            );
          });
        }

        if (errors.length > 0) {
          console.log(chalk.yellow(`\n  Warnings: ${errors.join(", ")}`));
        }
      }
      console.log();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isJson()) {
        const { jsonError } = await import("./utils.js");
        console.log(JSON.stringify(jsonError("COMMAND_ERROR", msg)));
      } else {
        console.error(chalk.red(`Error: ${msg}`));
      }
      process.exit(1);
    }
  });

// Switch shared API URLs if --network testnet is used
program.hook("preAction", () => {
  const network = program.opts().network as string;
  if (network === "testnet") setSharedApiNetwork("testnet");
});

// Smart landing page: `perp` with no subcommand
const rawArgs = process.argv.slice(2);
const hasSubcommand = rawArgs.some((a) => !a.startsWith("-") && !["pacifica", "hyperliquid", "lighter", "mainnet", "testnet"].includes(a));

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
