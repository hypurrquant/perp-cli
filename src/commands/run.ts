import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { printJson, jsonOk } from "../utils.js";
import { updateJobState } from "../jobs.js";
import { runTWAP } from "../strategies/twap.js";
import { runFundingArb } from "../strategies/funding-arb.js";
import { runGrid } from "../strategies/grid.js";
import { runDCA } from "../strategies/dca.js";
import chalk from "chalk";

export function registerRunCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  getAdapterFor: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean
) {
  const run = program.command("run").description("Run a strategy (foreground or as background job target)");

  run
    .command("twap <symbol> <side> <size> <duration>")
    .description("Run client-side TWAP (splits market orders over time)")
    .option("-s, --slices <n>", "Number of slices (default: auto)")
    .option("--job-id <id>", "Job ID (set automatically for background jobs)")
    .action(async (symbol: string, side: string, size: string, duration: string, opts: { slices?: string; jobId?: string }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") {
        console.error(chalk.red("Side must be buy or sell"));
        process.exit(1);
      }

      const adapter = await getAdapter();
      const params = {
        symbol: symbol.toUpperCase(),
        side: s as "buy" | "sell",
        totalSize: parseFloat(size),
        durationSec: parseInt(duration),
        slices: opts.slices ? parseInt(opts.slices) : undefined,
      };

      const log = (msg: string) => {
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.gray(ts)} ${msg}`);
      };

      const result = await runTWAP(adapter, params, opts.jobId, log);

      if (isJson()) printJson(jsonOk(result));

      if (opts.jobId) {
        updateJobState(opts.jobId, { status: "done" });
      }
    });

  run
    .command("funding-arb")
    .description("Run funding rate arbitrage monitor/executor")
    .option("--min-spread <pct>", "Min annual spread % to enter", "10")
    .option("--close-spread <pct>", "Close when spread drops below (%)", "5")
    .option("--size <size>", "Position size per leg (base amount)", "0.01")
    .option("--size-usd <usd>", "Position size per leg in USD (alternative)")
    .option("--symbols <list>", "Comma-separated symbol filter")
    .option("--interval <sec>", "Check interval in seconds", "60")
    .option("--auto-execute", "Actually place trades (default: monitor only)")
    .option("--max-positions <n>", "Max simultaneous positions", "3")
    .option("--exchanges <list>", "Comma-separated exchanges to use", "pacifica,hyperliquid,lighter")
    .option("--auto-rebalance", "Trigger rebalance alerts when exchange balance is low")
    .option("--rebalance-threshold <usd>", "Rebalance when available < this ($)", "100")
    .option("--max-drawdown <usd>", "Close all positions if total uPnL exceeds this loss ($)")
    .option("--job-id <id>", "Job ID (set automatically for background jobs)")
    .action(async (opts: {
      minSpread: string;
      closeSpread: string;
      size: string;
      sizeUsd?: string;
      symbols?: string;
      interval: string;
      autoExecute?: boolean;
      maxPositions: string;
      exchanges: string;
      autoRebalance?: boolean;
      rebalanceThreshold: string;
      maxDrawdown?: string;
      jobId?: string;
    }) => {
      const exchangeNames = opts.exchanges.split(",").map((e) => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();

      for (const name of exchangeNames) {
        try {
          const a = await getAdapterFor(name);
          adapters.set(name, a);
        } catch {
          if (!isJson()) console.log(chalk.yellow(`  Skipping ${name} (no credentials)`));
        }
      }

      if (adapters.size < 2) {
        console.error(chalk.red("Need at least 2 exchanges for arbitrage. Set credentials for 2+ exchanges."));
        process.exit(1);
      }

      const params = {
        minSpread: parseFloat(opts.minSpread),
        closeSpread: parseFloat(opts.closeSpread),
        size: opts.size,
        sizeUsd: opts.sizeUsd ? parseFloat(opts.sizeUsd) : undefined,
        symbols: opts.symbols ? opts.symbols.split(",").map((s) => s.trim().toUpperCase()) : undefined,
        intervalSec: parseInt(opts.interval),
        autoExecute: opts.autoExecute ?? false,
        maxPositions: parseInt(opts.maxPositions),
        autoRebalance: opts.autoRebalance ?? false,
        rebalanceThreshold: parseFloat(opts.rebalanceThreshold),
        maxDrawdown: opts.maxDrawdown ? parseFloat(opts.maxDrawdown) : undefined,
      };

      const log = (msg: string) => {
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.gray(ts)} ${msg}`);
      };

      await runFundingArb(adapters, params, opts.jobId, log);
    });

  // ── Grid Bot ──

  run
    .command("grid <symbol>")
    .description("Run grid trading bot (places limit orders across a price range)")
    .requiredOption("--upper <price>", "Upper price bound")
    .requiredOption("--lower <price>", "Lower price bound")
    .option("--grids <n>", "Number of grid lines", "10")
    .option("--size <size>", "Total position size (base)", "0.1")
    .option("--side <side>", "Grid bias: long, short, neutral", "neutral")
    .option("--leverage <n>", "Leverage to set")
    .option("--interval <sec>", "Check interval in seconds", "10")
    .option("--max-runtime <sec>", "Max runtime in seconds (0 = forever)", "0")
    .option("--trailing-stop <pct>", "Stop if equity drops by this % from peak")
    .option("--job-id <id>", "Job ID (set automatically for background jobs)")
    .action(async (symbol: string, opts: {
      upper: string; lower: string; grids: string; size: string;
      side: string; leverage?: string; interval: string;
      maxRuntime: string; trailingStop?: string; jobId?: string;
    }) => {
      const side = opts.side.toLowerCase();
      if (side !== "long" && side !== "short" && side !== "neutral") {
        console.error(chalk.red("Side must be long, short, or neutral"));
        process.exit(1);
      }

      const adapter = await getAdapter();
      const params = {
        symbol: symbol.toUpperCase(),
        side: side as "long" | "short" | "neutral",
        upperPrice: parseFloat(opts.upper),
        lowerPrice: parseFloat(opts.lower),
        grids: parseInt(opts.grids),
        totalSize: parseFloat(opts.size),
        leverage: opts.leverage ? parseInt(opts.leverage) : undefined,
        intervalSec: parseInt(opts.interval),
        maxRuntime: parseInt(opts.maxRuntime),
        trailingStop: opts.trailingStop ? parseFloat(opts.trailingStop) : undefined,
      };

      const log = (msg: string) => {
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.gray(ts)} ${msg}`);
      };

      const result = await runGrid(adapter, params, opts.jobId, log);
      if (isJson()) printJson(jsonOk(result));

      if (opts.jobId) {
        updateJobState(opts.jobId, { status: "done" });
      }
    });

  // ── DCA (Dollar Cost Averaging) ──

  run
    .command("dca <symbol> <side> <amount> <interval>")
    .description("Run DCA strategy (periodic market orders at fixed intervals)")
    .option("--orders <n>", "Total number of orders (0 = unlimited)", "0")
    .option("--price-limit <price>", "Stop buying above / selling below this price")
    .option("--max-runtime <sec>", "Max runtime in seconds (0 = forever)", "0")
    .option("--job-id <id>", "Job ID (set automatically for background jobs)")
    .action(async (symbol: string, side: string, amount: string, interval: string, opts: {
      orders: string; priceLimit?: string; maxRuntime: string; jobId?: string;
    }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") {
        console.error(chalk.red("Side must be buy or sell"));
        process.exit(1);
      }

      const adapter = await getAdapter();
      const params = {
        symbol: symbol.toUpperCase(),
        side: s as "buy" | "sell",
        amountPerOrder: parseFloat(amount),
        intervalSec: parseInt(interval),
        totalOrders: parseInt(opts.orders),
        priceLimit: opts.priceLimit ? parseFloat(opts.priceLimit) : undefined,
        maxRuntime: parseInt(opts.maxRuntime),
      };

      const log = (msg: string) => {
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.gray(ts)} ${msg}`);
      };

      const result = await runDCA(adapter, params, opts.jobId, log);
      if (isJson()) printJson(jsonOk(result));

      if (opts.jobId) {
        updateJobState(opts.jobId, { status: "done" });
      }
    });
}
