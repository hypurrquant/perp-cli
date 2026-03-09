import "dotenv/config";
import { Command } from "commander";
import chalk from "chalk";
import type { Network } from "./pacifica/index.js";
import { loadPrivateKey, parseSolanaKeypair, type Exchange } from "./config.js";
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
import { registerSettingsCommands } from "./commands/settings.js";
import { registerDexCommands } from "./commands/dex.js";
import { registerPlanCommands } from "./commands/plan.js";
import { loadSettings } from "./settings.js";

const program = new Command();

program
  .name("perp")
  .description("Multi-DEX Perpetual Futures CLI (Pacifica, Hyperliquid, Lighter)")
  .version("0.1.0")
  .option("-e, --exchange <exchange>", "Exchange: pacifica, hyperliquid, lighter", "pacifica")
  .option("-n, --network <network>", "Network: mainnet or testnet", "mainnet")
  .option("-k, --private-key <key>", "Private key")
  .option("--json", "Output raw JSON (for piping)")
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
      const builderCode = settings.referrals
        ? (process.env.PACIFICA_BUILDER_CODE || process.env.NEXT_PUBLIC_BUILDER_CODE || settings.referralCodes.pacifica)
        : "";
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
      if (hlSettings.referrals) {
        const hlRef = process.env.HL_REFERRAL_CODE || hlSettings.referralCodes.hyperliquid;
        if (hlRef) _hlAdapter.autoSetReferrer(hlRef).catch(() => {});
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
      if (ltSettings.referrals) {
        const ltRef = process.env.LIGHTER_REFERRAL_CODE || ltSettings.referralCodes.lighter;
        if (ltRef) _lighterAdapter.useReferralCode(ltRef).catch(() => {});
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
  return !!program.opts().json;
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
registerMarketCommands(program, getAdapter, isJson);
registerAccountCommands(program, getAdapter, isJson);
registerTradeCommands(program, getAdapter, isJson);
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
registerAlertCommands(program, isJson);

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
      const builderCode = s1.referrals
        ? (process.env.PACIFICA_BUILDER_CODE || process.env.NEXT_PUBLIC_BUILDER_CODE || s1.referralCodes.pacifica)
        : "";
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
      if (s2.referrals) {
        const hlRef = process.env.HL_REFERRAL_CODE || s2.referralCodes.hyperliquid;
        if (hlRef) _hlAdapter.autoSetReferrer(hlRef).catch(() => {});
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
      if (s3.referrals) {
        const ltRef = process.env.LIGHTER_REFERRAL_CODE || s3.referralCodes.lighter;
        if (ltRef) _lighterAdapter.useReferralCode(ltRef).catch(() => {});
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
registerSettingsCommands(program, isJson);
registerDexCommands(program, getAdapter, isJson);
registerPlanCommands(program, getAdapter, isJson);

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
      const [balance, positions, orders] = await Promise.all([
        adapter.getBalance(),
        adapter.getPositions(),
        adapter.getOpenOrders(),
      ]);

      if (json) {
        const { jsonOk, printJson } = await import("./utils.js");
        return printJson(jsonOk({ exchange: adapter.name, balance, positions, orders }));
      }

      console.log(chalk.cyan.bold(`\n  ${adapter.name.toUpperCase()} Account Status\n`));
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
