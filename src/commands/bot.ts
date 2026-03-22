import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { loadBotConfig, parseStrategy, quickGridConfig, quickDCAConfig, runBot, PRESETS, getPreset, getPresetsByStrategy } from "../bot/index.js";
import type { BotOutputMode } from "../bot/index.js";
import { updateJobState } from "../jobs.js";
import { runTWAP, runFundingArb, runGrid, runDCA, runTrailingStop } from "../strategies/index.js";

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
    .option("--headless", "Run without TUI dashboard")
    .option("--job-id <id>", "Job ID (set by background runner)")
    .action(async (configPath: string, opts: { background?: boolean; headless?: boolean; jobId?: string }) => {
      const config = loadBotConfig(configPath);

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const job = startJob({
          strategy: `bot:${config.strategy.type}`,
          exchange: config.exchange,
          params: { config: configPath, name: config.name },
          cliArgs: [`-e`, config.exchange, `start`, configPath],
        });
        if (isJson()) return printJson(jsonOk(job));
        printBotJobStarted(config.name, job.id);
        return;
      }

      const adapter = config.strategy.type === "funding-arb"
        ? await getAdapterFor(config.exchange)
        : await getAdapter();

      const mode = resolveOutputMode(isJson, opts.headless);
      const log = makeLog();
      await runBot(adapter, config, opts.jobId, log, undefined, mode);
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
    .option("--headless", "Run without TUI dashboard")
    .option("--job-id <id>", "Job ID")
    .action(async (symbol: string, opts: {
      range: string; grids: string; size: string; side: string;
      leverage?: string; maxDrawdown: string; maxRuntime: string;
      background?: boolean; headless?: boolean; jobId?: string;
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

      const mode = resolveOutputMode(isJson, opts.headless);
      const log = makeLog();
      await runBot(adapter, config, opts.jobId, log, undefined, mode);
    });

  // ── bot quick dca ──

  bot
    .command("quick-dca <symbol> <side> <amount> <interval>")
    .description("Quick-start a DCA bot (interval: seconds between orders)")
    .option("--orders <n>", "Total orders (0 = unlimited)", "0")
    .option("--price-limit <price>", "Don't buy above / sell below this price")
    .option("--trigger-drop <pct>", "Only buy when price drops X% from recent high")
    .option("--max-drawdown <usd>", "Stop if drawdown exceeds ($)", "100")
    .option("--background", "Run in background (tmux)")
    .option("--headless", "Run without TUI dashboard")
    .option("--job-id <id>", "Job ID")
    .action(async (symbol: string, side: string, amount: string, interval: string, opts: {
      orders: string; priceLimit?: string; triggerDrop?: string;
      maxDrawdown: string; background?: boolean; headless?: boolean; jobId?: string;
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

      const mode = resolveOutputMode(isJson, opts.headless);
      const log = makeLog();
      await runBot(adapter, config, opts.jobId, log, undefined, mode);
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
    .option("--headless", "Run without TUI dashboard")
    .option("--job-id <id>", "Job ID")
    .action(async (opts: {
      minSpread: string; closeSpread: string; size: string;
      maxPositions: string; exchanges: string; interval: string;
      maxDrawdown: string; background?: boolean; headless?: boolean; jobId?: string;
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

      const mode = resolveOutputMode(isJson, opts.headless);
      const log = makeLog();
      await runBot(primaryAdapter, config, opts.jobId, log, adapters, mode);
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
    .option("--headless", "Run without TUI dashboard")
    .option("--job-id <id>", "Job ID")
    .action(async (name: string, symbol: string | undefined, opts: { background?: boolean; headless?: boolean; jobId?: string }) => {
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
        const mode = resolveOutputMode(isJson, opts.headless);
        await runBot(primaryAdapter, config, opts.jobId, log, adapters, mode);
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
      const mode = resolveOutputMode(isJson, opts.headless);
      await runBot(adapter, config, opts.jobId, log, undefined, mode);
    });

  // ── bot list-strategies ──

  bot
    .command("list-strategies")
    .description("List all available trading strategies")
    .action(async () => {
      await import("../bot/engine.js");
      const { listStrategies } = await import("../bot/strategy-registry.js");
      const strategies = listStrategies();
      if (isJson()) return printJson(jsonOk({ strategies }));
      console.log(chalk.cyan.bold("\n  Available Strategies:\n"));
      for (const s of strategies) {
        console.log(`    ${chalk.white(s)}`);
      }
      console.log();
    });

  // ── bot apex ──

  bot
    .command("apex [symbol]")
    .description("Start APEX autonomous orchestrator")
    .option("--preset <preset>", "Preset: default, conservative, aggressive", "default")
    .option("--max-slots <n>", "Max concurrent positions", "3")
    .option("--daily-limit <usd>", "Daily loss limit in USD", "250")
    .option("--headless", "Run without TUI dashboard")
    .option("--background", "Run in background (tmux)")
    .option("--job-id <id>", "Job ID")
    .action(async (symbol: string | undefined, opts: {
      preset: string; maxSlots: string; dailyLimit: string; headless?: boolean; background?: boolean; jobId?: string;
    }) => {
      const adapter = await getAdapter();
      const sym = (symbol ?? "ETH").toUpperCase();
      const config: import("../bot/config.js").BotConfig = {
        name: `apex-${sym.toLowerCase()}-${Date.now().toString(36)}`,
        exchange: adapter.name,
        symbol: sym,
        strategy: {
          type: "apex",
          preset: opts.preset,
          max_slots: parseInt(opts.maxSlots),
        },
        entry_conditions: [{ type: "always", value: 0 }],
        exit_conditions: [],
        risk: {
          max_position_usd: 1000,
          max_daily_loss: parseFloat(opts.dailyLimit),
          max_drawdown: parseFloat(opts.dailyLimit) * 2,
          pause_after_loss_sec: 300,
          max_open_bots: 1,
        },
        monitor_interval_sec: 10,
      };

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const cliArgs = [
          `-e`, adapter.name, `apex`, sym,
          `--preset`, opts.preset, `--max-slots`, opts.maxSlots,
          `--daily-limit`, opts.dailyLimit,
        ];
        const job = startJob({
          strategy: `bot:apex`,
          exchange: adapter.name,
          params: { symbol: sym, ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        printBotJobStarted(config.name, job.id);
        return;
      }

      const mode = resolveOutputMode(isJson, opts.headless);
      const log = makeLog();
      await runBot(adapter, config, opts.jobId, log, undefined, mode);
    });

  // ── bot reflect ──

  bot
    .command("reflect")
    .description("Analyze trading performance")
    .option("--period <days>", "Analysis period in days", "7")
    .action(async (opts: { period: string }) => {
      const { readJournal } = await import("../bot/trade-journal.js");
      const { analyzePerformance } = await import("../bot/reflect.js");
      const periodDays = Number(opts.period);
      const entries = readJournal({ from: Date.now() - periodDays * 86400000 });
      const report = analyzePerformance(entries, periodDays);
      if (isJson()) return printJson(jsonOk(report));

      console.log(chalk.cyan.bold("\n  Performance Report\n"));
      console.log(`  Period:        ${chalk.white(`${report.period.days}d`)} (${new Date(report.period.from).toLocaleDateString()} – ${new Date(report.period.to).toLocaleDateString()})`);
      console.log(`  Total trades:  ${chalk.white(report.totalTrades)}`);
      if (report.totalTrades === 0) {
        console.log(chalk.gray("\n  No trades in the selected period.\n"));
        return;
      }
      const wrColor = report.winRate >= 0.5 ? chalk.green : chalk.red;
      console.log(`  Win rate:      ${wrColor((report.winRate * 100).toFixed(1) + "%")}`);
      console.log(`  Avg win:       ${chalk.green(`$${report.avgWin.toFixed(2)}`)}`);
      console.log(`  Avg loss:      ${chalk.red(`$${report.avgLoss.toFixed(2)}`)}`);
      const pfColor = report.profitFactor >= 1.0 ? chalk.green : chalk.red;
      console.log(`  Profit factor: ${pfColor(report.profitFactor === Infinity ? "∞" : report.profitFactor.toFixed(2))}`);
      console.log(`  Fee drag:      ${chalk.yellow((report.feeDragRatio * 100).toFixed(1) + "%")}`);
      console.log(`  Direction:     ${chalk.gray(`long ${(report.directionSplit.long * 100).toFixed(0)}% / short ${(report.directionSplit.short * 100).toFixed(0)}%`)}`);
      if (report.bestStrategy) console.log(`  Best strategy: ${chalk.green(report.bestStrategy)}`);
      if (report.worstStrategy && report.worstStrategy !== report.bestStrategy) console.log(`  Worst strategy:${chalk.red(report.worstStrategy)}`);
      console.log(chalk.cyan.bold("\n  Suggestions:\n"));
      for (const s of report.suggestions) {
        console.log(`    ${chalk.white("•")} ${chalk.gray(s)}`);
      }
      console.log();
    });

  // ── bot run <strategy> <symbol> ──

  bot
    .command("run <strategy> [symbol]")
    .description("Run a strategy (use 'perp bot list-strategies' to see all). Symbol optional for multi-symbol strategies.")
    .option("--config <path>", "YAML/JSON config file")
    .option("--headless", "Run without TUI dashboard")
    .option("--param <key=value>", "Strategy parameter (repeatable)", (val: string, acc: string[]) => [...acc, val], [] as string[])
    .action(async (strategyName: string, symbol: string | undefined, opts: {
      config?: string; headless?: boolean; param: string[];
    }) => {
      const sym = symbol?.toUpperCase() || "ALL";

      // Strategies that require an explicit symbol
      const symbolRequiredStrategies = [
        "grid", "dca", "simple-mm", "engine-mm", "avellaneda-mm",
        "momentum-breakout", "mean-reversion", "aggressive-taker",
        "grid-mm", "liquidation-mm", "regime-mm",
      ];
      if (sym === "ALL" && symbolRequiredStrategies.includes(strategyName)) {
        console.error(chalk.red(`\n  Error: The '${strategyName}' strategy requires a <symbol> argument.`));
        console.error(chalk.gray(`  Usage: perp bot run ${strategyName} <symbol>\n`));
        process.exitCode = 1;
        return;
      }

      // Load or build config
      let config: import("../bot/config.js").BotConfig;
      if (opts.config) {
        config = loadBotConfig(opts.config);
        // Override strategy type and symbol from CLI args
        config.strategy = { ...(config.strategy as Record<string, unknown>), type: strategyName } as import("../bot/config.js").StrategyParams;
        config.symbol = sym;
      } else {
        // Parse --param key=value pairs
        const params: Record<string, unknown> = { type: strategyName };
        for (const kv of opts.param) {
          const eq = kv.indexOf("=");
          if (eq === -1) continue;
          const key = kv.slice(0, eq);
          const raw = kv.slice(eq + 1);
          // Try to coerce numbers and booleans
          if (raw === "true") params[key] = true;
          else if (raw === "false") params[key] = false;
          else if (!isNaN(Number(raw)) && raw !== "") params[key] = Number(raw);
          else params[key] = raw;
        }

        const adapter = await getAdapter();
        const strategy = parseStrategy(strategyName, params);
        config = {
          name: `${strategyName}-${sym.toLowerCase()}-${Date.now().toString(36)}`,
          exchange: adapter.name,
          symbol: sym,
          strategy,
          entry_conditions: [{ type: "always", value: 0 }],
          exit_conditions: [],
          risk: {
            max_position_usd: 1000,
            max_daily_loss: 100,
            max_drawdown: 200,
            pause_after_loss_sec: 300,
            max_open_bots: 5,
          },
          monitor_interval_sec: 10,
        };
      }

      // Verify strategy is registered
      await import("../bot/engine.js");
      const { getStrategy, listStrategies: listStrats } = await import("../bot/strategy-registry.js");
      if (!getStrategy(strategyName)) {
        const available = listStrats();
        console.error(chalk.red(`\n  Unknown strategy: "${strategyName}"`));
        console.error(chalk.gray(`\n  Available strategies:`));
        for (const s of available) console.error(chalk.gray(`    - ${s}`));
        console.error();
        return;
      }

      const adapter = await getAdapter();
      config.exchange = adapter.name;
      const mode = resolveOutputMode(isJson, opts.headless);
      const log = makeLog();

      // Multi-exchange strategies need all adapters
      let extraAdapters: Map<string, import("../exchanges/index.js").ExchangeAdapter> | undefined;
      const multiExchangeStrategies = ["funding-auto", "funding-arb", "funding-arb-v2", "basis-arb", "hedge-agent"];
      if (multiExchangeStrategies.includes(strategyName) && getAdapterFor) {
        extraAdapters = new Map();
        for (const ex of ["pacifica", "hyperliquid", "lighter"]) {
          if (ex === adapter.name) continue;
          try {
            const a = await getAdapterFor(ex);
            extraAdapters.set(ex, a);
          } catch { /* skip unavailable exchanges */ }
        }
      }

      await runBot(adapter, config, undefined, log, extraAdapters, mode);
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

  // Strategy subcommands: twap, funding-arb, grid, dca, trailing-stop
  registerRunSubcommands(bot, getAdapter, getAdapterFor, isJson);
}

function makeLog(): (msg: string) => void {
  return (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    console.log(`${chalk.gray(ts)} ${msg}`);
  };
}

function resolveOutputMode(isJson: () => boolean, headless?: boolean): BotOutputMode {
  if (isJson()) return "json";
  if (headless) return "headless";
  return process.stdout.isTTY ? "tui" : "headless";
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

// ── Run subcommands (twap, funding-arb, grid, dca, trailing-stop) ──

function registerRunSubcommands(
  parent: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  getAdapterFor: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const run = parent;

  const twapCmd = run
    .command("twap <symbol> <side> <size> <duration>")
    .description("Run client-side TWAP (splits market orders over time)");
  twapCmd
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

  const gridCmd = run
    .command("grid <symbol>")
    .description("Run grid trading bot (places limit orders across a price range)");
  gridCmd
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

  const dcaCmd = run
    .command("dca <symbol> <side> <amount> <interval>")
    .description("Run DCA strategy (periodic market orders at fixed intervals)");
  dcaCmd
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

  // ── Trailing Stop ──

  const tsCmd = run
    .command("trailing-stop <symbol>")
    .description("Run client-side trailing stop (monitors price, closes position when trail % hit)");
  tsCmd
    .requiredOption("--trail <pct>", "Trail percentage")
    .option("--interval <sec>", "Check interval in seconds", "5")
    .option("--activation <price>", "Only start trailing after price reaches this level")
    .option("--job-id <id>", "Job ID (set automatically for background jobs)")
    .action(async (symbol: string, opts: {
      trail: string; interval: string; activation?: string; jobId?: string;
    }) => {
      const sym = symbol.toUpperCase();
      const trailPct = parseFloat(opts.trail);
      const intervalSec = parseInt(opts.interval);
      const activationPrice = opts.activation ? parseFloat(opts.activation) : undefined;

      const adapter = await getAdapter();
      const log = (msg: string) => {
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.gray(ts)} ${msg}`);
      };

      const result = await runTrailingStop(adapter, {
        symbol: sym,
        trailPct,
        intervalSec,
        activationPrice,
      }, opts.jobId, log);

      if (isJson()) printJson(jsonOk(result));

      if (opts.jobId) {
        updateJobState(opts.jobId, { status: "done" });
      }
    });
}
