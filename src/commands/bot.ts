import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { loadBotConfig, quickGridConfig, quickDCAConfig } from "../bot/config.js";
import { runBot } from "../bot/engine.js";
import { PRESETS, getPreset, getPresetsByStrategy } from "../bot/presets.js";

export function registerBotCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  getAdapterFor: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const bot = program.command("bot").description("Automated trading bots with condition monitoring & risk management");

  // ── bot start <config> ──

  bot
    .command("start <config>")
    .description("Start a bot from a YAML/JSON config file")
    .option("--background", "Run in background (tmux)")
    .option("--job-id <id>", "Job ID (set by background runner)")
    .action(async (configPath: string, opts: { background?: boolean; jobId?: string }) => {
      const config = loadBotConfig(configPath);

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const job = startJob({
          strategy: `bot:${config.strategy.type}`,
          exchange: config.exchange,
          params: { config: configPath, name: config.name },
          cliArgs: [`-e`, config.exchange, `start`, configPath, `--job-id`, "PLACEHOLDER"],
        });
        if (isJson()) return printJson(jsonOk(job));
        printBotJobStarted(config.name, job.id);
        return;
      }

      const adapter = config.strategy.type === "funding-arb"
        ? await getAdapterFor(config.exchange)
        : await getAdapter();

      const log = makeLog();
      await runBot(adapter, config, opts.jobId, log);
    });

  // ── bot quick grid ──

  bot
    .command("quick-grid <symbol>")
    .description("Quick-start a grid bot with smart defaults")
    .option("--range <pct>", "Price range ±% from current", "3")
    .option("--grids <n>", "Number of grid lines", "10")
    .option("--size <size>", "Total position size (base)", "0.1")
    .option("--side <side>", "Bias: long, short, neutral", "neutral")
    .option("--leverage <n>", "Leverage")
    .option("--max-drawdown <usd>", "Stop if drawdown exceeds ($)", "100")
    .option("--max-runtime <sec>", "Max runtime in seconds", "0")
    .option("--background", "Run in background (tmux)")
    .option("--job-id <id>", "Job ID")
    .action(async (symbol: string, opts: {
      range: string; grids: string; size: string; side: string;
      leverage?: string; maxDrawdown: string; maxRuntime: string;
      background?: boolean; jobId?: string;
    }) => {
      const adapter = await getAdapter();
      const config = quickGridConfig({
        exchange: adapter.name,
        symbol: symbol.toUpperCase(),
        rangePct: parseFloat(opts.range),
        grids: parseInt(opts.grids),
        size: parseFloat(opts.size),
        side: opts.side,
        maxDrawdown: parseFloat(opts.maxDrawdown),
        maxRuntime: opts.maxRuntime !== "0" ? parseInt(opts.maxRuntime) : undefined,
        leverage: opts.leverage ? parseInt(opts.leverage) : undefined,
      });

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const cliArgs = [
          `-e`, adapter.name, `quick-grid`, symbol.toUpperCase(),
          `--range`, opts.range, `--grids`, opts.grids, `--size`, opts.size,
          `--side`, opts.side, `--max-drawdown`, opts.maxDrawdown,
          `--max-runtime`, opts.maxRuntime,
          ...(opts.leverage ? [`--leverage`, opts.leverage] : []),
        ];
        const job = startJob({
          strategy: `bot:grid`,
          exchange: adapter.name,
          params: { symbol: symbol.toUpperCase(), ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        printBotJobStarted(config.name, job.id);
        return;
      }

      const log = makeLog();
      await runBot(adapter, config, opts.jobId, log);
    });

  // ── bot quick dca ──

  bot
    .command("quick-dca <symbol> <side> <amount> <interval>")
    .description("Quick-start a DCA bot")
    .option("--orders <n>", "Total orders (0 = unlimited)", "0")
    .option("--price-limit <price>", "Don't buy above / sell below this price")
    .option("--trigger-drop <pct>", "Only buy when price drops X% from recent high")
    .option("--max-drawdown <usd>", "Stop if drawdown exceeds ($)", "100")
    .option("--background", "Run in background (tmux)")
    .option("--job-id <id>", "Job ID")
    .action(async (symbol: string, side: string, amount: string, interval: string, opts: {
      orders: string; priceLimit?: string; triggerDrop?: string;
      maxDrawdown: string; background?: boolean; jobId?: string;
    }) => {
      const adapter = await getAdapter();
      const config = quickDCAConfig({
        exchange: adapter.name,
        symbol: symbol.toUpperCase(),
        side: side.toLowerCase(),
        amount: parseFloat(amount),
        intervalSec: parseInt(interval),
        orders: parseInt(opts.orders),
        triggerDrop: opts.triggerDrop ? parseFloat(opts.triggerDrop) : undefined,
        priceLimit: opts.priceLimit ? parseFloat(opts.priceLimit) : undefined,
        maxDrawdown: parseFloat(opts.maxDrawdown),
      });

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const cliArgs = [
          `-e`, adapter.name, `quick-dca`, symbol.toUpperCase(), side.toLowerCase(),
          amount, interval, `--orders`, opts.orders, `--max-drawdown`, opts.maxDrawdown,
          ...(opts.priceLimit ? [`--price-limit`, opts.priceLimit] : []),
          ...(opts.triggerDrop ? [`--trigger-drop`, opts.triggerDrop] : []),
        ];
        const job = startJob({
          strategy: `bot:dca`,
          exchange: adapter.name,
          params: { symbol: symbol.toUpperCase(), ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        printBotJobStarted(config.name, job.id);
        return;
      }

      const log = makeLog();
      await runBot(adapter, config, opts.jobId, log);
    });

  // ── bot quick arb ──

  bot
    .command("quick-arb")
    .description("Quick-start a funding rate arbitrage bot")
    .option("--min-spread <pct>", "Min annual spread to enter (%)", "20")
    .option("--close-spread <pct>", "Close when spread drops below (%)", "5")
    .option("--size <usd>", "Position size per leg ($)", "50")
    .option("--max-positions <n>", "Max simultaneous positions", "3")
    .option("--exchanges <list>", "Comma-separated exchanges", "pacifica,hyperliquid,lighter")
    .option("--interval <sec>", "Check interval in seconds", "60")
    .option("--max-drawdown <usd>", "Stop if drawdown exceeds ($)", "200")
    .option("--background", "Run in background (tmux)")
    .option("--job-id <id>", "Job ID")
    .action(async (opts: {
      minSpread: string; closeSpread: string; size: string;
      maxPositions: string; exchanges: string; interval: string;
      maxDrawdown: string; background?: boolean; jobId?: string;
    }) => {
      const exchangeNames = opts.exchanges.split(",").map(e => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterFor(name));
        } catch {
          // skip unavailable
        }
      }

      if (adapters.size < 2) {
        console.error(chalk.red("\n  Need at least 2 exchanges for arbitrage.\n"));
        return;
      }

      const primaryAdapter = adapters.values().next().value!;

      const config: import("../bot/config.js").BotConfig = {
        name: `arb-funding-${Date.now().toString(36)}`,
        exchange: primaryAdapter.name,
        symbol: "ETH", // multi-symbol scanning
        strategy: {
          type: "funding-arb",
          min_spread: parseFloat(opts.minSpread),
          close_spread: parseFloat(opts.closeSpread),
          size_usd: parseFloat(opts.size),
          max_positions: parseInt(opts.maxPositions),
          exchanges: exchangeNames,
        },
        entry_conditions: [{ type: "always", value: 0 }],
        exit_conditions: [],
        risk: {
          max_position_usd: parseFloat(opts.size) * parseInt(opts.maxPositions) * 2,
          max_daily_loss: parseFloat(opts.maxDrawdown) / 2,
          max_drawdown: parseFloat(opts.maxDrawdown),
          pause_after_loss_sec: 300,
          max_open_bots: 1,
        },
        monitor_interval_sec: parseInt(opts.interval),
      };

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const cliArgs = [
          `quick-arb`,
          `--min-spread`, opts.minSpread, `--close-spread`, opts.closeSpread,
          `--size`, opts.size, `--max-positions`, opts.maxPositions,
          `--exchanges`, opts.exchanges, `--interval`, opts.interval,
          `--max-drawdown`, opts.maxDrawdown,
        ];
        const job = startJob({
          strategy: `bot:funding-arb`,
          exchange: "multi",
          params: { ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        printBotJobStarted(config.name, job.id);
        return;
      }

      const log = makeLog();
      await runBot(primaryAdapter, config, opts.jobId, log, adapters);
    });

  // ── bot preset list ──

  bot
    .command("preset-list")
    .description("List all available strategy presets")
    .option("--strategy <type>", "Filter by strategy: grid, dca, funding-arb")
    .action((opts: { strategy?: string }) => {
      const presets = opts.strategy ? getPresetsByStrategy(opts.strategy) : PRESETS;

      if (isJson()) return printJson(jsonOk(presets.map(p => ({ name: p.name, strategy: p.strategy, risk: p.risk, description: p.description }))));

      console.log(chalk.cyan.bold("\n  Strategy Presets\n"));

      const groups = new Map<string, typeof presets>();
      for (const p of presets) {
        const list = groups.get(p.strategy) ?? [];
        list.push(p);
        groups.set(p.strategy, list);
      }

      for (const [strat, list] of groups) {
        console.log(chalk.white.bold(`  ${strat.toUpperCase()}`));
        for (const p of list) {
          const riskColor = p.risk === "low" ? chalk.green : p.risk === "medium" ? chalk.yellow : chalk.red;
          console.log(`    ${chalk.cyan(p.name.padEnd(22))} ${riskColor(`[${p.risk}]`.padEnd(10))} ${chalk.gray(p.description)}`);
        }
        console.log();
      }

      console.log(chalk.gray(`  Usage: perp bot preset <name> <symbol>`));
      console.log(chalk.gray(`         perp bot preset grid-standard ETH`));
      console.log(chalk.gray(`         perp bot preset arb-conservative --background\n`));
    });

  // ── bot preset <name> <symbol> ──

  bot
    .command("preset <name> [symbol]")
    .description("Start a bot from a preset (use 'preset-list' to see options)")
    .option("--background", "Run in background (tmux)")
    .option("--job-id <id>", "Job ID")
    .action(async (name: string, symbol: string | undefined, opts: { background?: boolean; jobId?: string }) => {
      const preset = getPreset(name);
      if (!preset) {
        console.error(chalk.red(`\n  Unknown preset: "${name}"`));
        console.error(chalk.gray(`  Run 'perp bot preset-list' to see available presets.\n`));
        return;
      }

      const sym = symbol?.toUpperCase() ?? "ETH";

      // For arb presets, need multiple adapters
      if (preset.strategy === "funding-arb") {
        const config = preset.buildConfig("multi", sym);
        const arbStrategy = config.strategy as import("../bot/config.js").FundingArbStrategyParams;
        const adapters = new Map<string, ExchangeAdapter>();

        for (const exName of arbStrategy.exchanges) {
          try {
            adapters.set(exName, await getAdapterFor(exName));
          } catch {
            // skip unavailable
          }
        }

        if (adapters.size < 2) {
          console.error(chalk.red("\n  Need at least 2 exchanges for arbitrage.\n"));
          return;
        }

        const primaryAdapter = adapters.values().next().value!;
        config.exchange = primaryAdapter.name;

        if (opts.background) {
          const { startJob } = await import("../jobs.js");
          const cliArgs = [`preset`, name, sym];
          const job = startJob({
            strategy: `bot:${preset.strategy}`,
            exchange: "multi",
            params: { preset: name, symbol: sym },
            cliArgs,
          });
          if (isJson()) return printJson(jsonOk(job));
          printBotJobStarted(config.name, job.id);
          return;
        }

        const log = makeLog();
        if (!isJson()) {
          console.log(chalk.cyan.bold(`\n  Starting preset: ${chalk.white(preset.name)}`));
          console.log(chalk.gray(`  ${preset.description}\n`));
        }
        await runBot(primaryAdapter, config, opts.jobId, log, adapters);
        return;
      }

      // Grid / DCA presets
      const adapter = await getAdapter();
      const config = preset.buildConfig(adapter.name, sym);

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const cliArgs = [`preset`, name, sym];
        const job = startJob({
          strategy: `bot:${preset.strategy}`,
          exchange: adapter.name,
          params: { preset: name, symbol: sym },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        printBotJobStarted(config.name, job.id);
        return;
      }

      const log = makeLog();
      if (!isJson()) {
        console.log(chalk.cyan.bold(`\n  Starting preset: ${chalk.white(preset.name)}`));
        console.log(chalk.gray(`  ${preset.description}\n`));
      }
      await runBot(adapter, config, opts.jobId, log);
    });

  // ── bot example ──

  bot
    .command("example")
    .description("Print example YAML bot configs")
    .action(() => {
      console.log(chalk.cyan.bold("\n  Example Bot Configs\n"));

      console.log(chalk.white.bold("  1. Grid Bot (auto range)"));
      console.log(chalk.gray(`  Save to ~/.perp/bots/eth-grid.yaml:\n`));
      console.log(`${GRID_EXAMPLE}\n`);

      console.log(chalk.white.bold("  2. DCA Bot (buy the dip)"));
      console.log(chalk.gray(`  Save to ~/.perp/bots/eth-dca.yaml:\n`));
      console.log(`${DCA_EXAMPLE}\n`);

      console.log(chalk.white.bold("  3. Funding Arb Bot"));
      console.log(chalk.gray(`  Save to ~/.perp/bots/funding-arb.yaml:\n`));
      console.log(`${ARB_EXAMPLE}\n`);

      console.log(chalk.gray(`  Usage: perp bot start ~/.perp/bots/eth-grid.yaml`));
      console.log(chalk.gray(`         perp bot start ~/.perp/bots/eth-grid.yaml --background\n`));
    });
}

function makeLog(): (msg: string) => void {
  return (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    console.log(`${chalk.gray(ts)} ${msg}`);
  };
}

function printBotJobStarted(name: string, jobId: string) {
  console.log(chalk.green(`\n  Bot "${name}" started in background.`));
  console.log(`  Job ID: ${chalk.white.bold(jobId)}`);
  console.log(`  Logs:   ${chalk.gray(`perp jobs logs ${jobId} -f`)}`);
  console.log(`  Stop:   ${chalk.gray(`perp jobs stop ${jobId}`)}\n`);
}

// ── Example YAML configs ──

const GRID_EXAMPLE = chalk.gray(`  name: eth-grid-bot
  exchange: hyperliquid
  symbol: ETH

  strategy:
    type: grid
    grids: 15
    size: 0.1
    side: neutral
    range_mode: auto
    range_pct: 3
    rebalance: true
    leverage: 5

  entry_conditions:
    - type: volatility_below
      value: 5

  exit_conditions:
    - type: volatility_above
      value: 10
    - type: time_after
      value: 86400

  risk:
    max_drawdown: 50
    max_daily_loss: 30
    pause_after_loss_sec: 300`);

const DCA_EXAMPLE = chalk.gray(`  name: eth-dca-dip
  exchange: hyperliquid
  symbol: ETH

  strategy:
    type: dca
    amount: 0.01
    interval_sec: 3600
    total_orders: 24

  entry_conditions:
    - type: price_below
      value: 2500

  exit_conditions:
    - type: price_above
      value: 2800

  risk:
    max_drawdown: 100
    max_daily_loss: 50`);

const ARB_EXAMPLE = chalk.gray(`  name: funding-arb
  exchange: hyperliquid
  symbol: ETH

  strategy:
    type: funding-arb
    min_spread: 20
    close_spread: 5
    size_usd: 100
    max_positions: 3
    exchanges:
      - pacifica
      - hyperliquid

  entry_conditions:
    - type: always
      value: 0

  risk:
    max_drawdown: 200
    max_daily_loss: 50`);
