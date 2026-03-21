import type { ExchangeAdapter } from "../exchanges/index.js";
import type { BotConfig } from "./config.js";
import { getMarketSnapshot, evaluateAllConditions, type MarketSnapshot } from "./conditions.js";
import { updateJobState } from "../jobs.js";
import { getStrategy } from "./strategy-registry.js";
import type { StrategyAction, StrategyContext, EnrichedSnapshot } from "./strategy-types.js";
import chalk from "chalk";

// Auto-register built-in strategies
import "./strategies/grid-strategy.js";
import "./strategies/dca-strategy.js";
import "./strategies/funding-arb-strategy.js";
import "./strategies/simple-mm.js";
import "./strategies/engine-mm.js";
import "./strategies/avellaneda-mm.js";
import "./strategies/momentum-breakout.js";
import "./strategies/mean-reversion.js";
import "./strategies/aggressive-taker.js";
import "./strategies/funding-arb-v2.js";
import "./strategies/basis-arb.js";
import "./strategies/regime-mm.js";
import "./strategies/grid-mm.js";
import "./strategies/liquidation-mm.js";
import "./strategies/hedge-agent.js";
import "./strategies/rfq-agent.js";
import "./strategies/claude-agent.js";
import "./strategies/apex-strategy.js";

export type BotLog = (msg: string) => void;

interface BotState {
  phase: "monitoring" | "entering" | "running" | "exiting" | "paused" | "stopped";
  startTime: number;
  equity: number;
  peakEquity: number;
  dailyPnl: number;
  dailyStartEquity: number;
  dailyStartDate: string; // YYYY-MM-DD for daily reset
  fills: number;
  totalPnl: number;
  rebalanceCount: number;
  lastRebalance: number;
  strategyActive: boolean;
}

export async function runBot(
  adapter: ExchangeAdapter,
  config: BotConfig,
  jobId?: string,
  log: BotLog = defaultLog,
  extraAdapters?: Map<string, ExchangeAdapter>, // for funding-arb (multi-exchange)
): Promise<{ fills: number; totalPnl: number; runtime: number }> {
  const state: BotState = {
    phase: "monitoring",
    startTime: Date.now(),
    equity: 0,
    peakEquity: 0,
    dailyPnl: 0,
    dailyStartEquity: 0,
    dailyStartDate: new Date().toISOString().slice(0, 10),
    fills: 0,
    totalPnl: 0,
    rebalanceCount: 0,
    lastRebalance: 0,
    strategyActive: false,
  };

  // Resolve strategy from registry
  const strategyFactory = getStrategy(config.strategy.type);
  if (!strategyFactory) throw new Error(`Unknown strategy: ${config.strategy.type}`);
  const strategy = strategyFactory(config.strategy as unknown as Record<string, unknown>);
  const strategyCtx: StrategyContext = {
    adapter,
    symbol: config.symbol,
    config: config.strategy as unknown as Record<string, unknown>,
    state: new Map(),
    tick: 0,
    log,
  };

  // Pass extra adapters to strategy context for funding-arb
  if (extraAdapters) {
    strategyCtx.state.set("extraAdapters", extraAdapters);
  }

  const isDryRun = false; // TODO: wire up from config when dry-run mode is added

  let running = true;
  const shutdown = () => { running = false; state.phase = "stopped"; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Header
  log(chalk.cyan.bold(`\n  ╔═══════════════════════════════════════╗`));
  log(chalk.cyan.bold(`  ║  ${config.name.padEnd(37)}║`));
  log(chalk.cyan.bold(`  ╚═══════════════════════════════════════╝\n`));
  log(`  Exchange:  ${chalk.white(config.exchange)}`);
  log(`  Symbol:    ${chalk.white(config.symbol)}`);
  log(`  Strategy:  ${chalk.white(config.strategy.type)}`);
  log(`  Risk:      max drawdown $${config.risk.max_drawdown} | max daily loss $${config.risk.max_daily_loss}`);
  log(`  Entry:     ${config.entry_conditions.map(c => c.type).join(" + ")}`);
  log(`  Exit:      ${config.exit_conditions.map(c => c.type).join(" | ") || "manual"}`);
  log("");

  // Get initial equity
  try {
    const bal = await adapter.getBalance();
    state.equity = parseFloat(bal.equity);
    state.peakEquity = state.equity;
    state.dailyStartEquity = state.equity;
    log(`  Starting equity: $${state.equity.toFixed(2)}`);
  } catch {
    log(chalk.yellow(`  Could not fetch initial balance`));
  }

  log(chalk.gray(`\n  Monitoring conditions... (Ctrl+C to stop)\n`));

  try {
    while (running) {
      const loopStart = Date.now();

      try {
        // Get market data (enriched for strategy use)
        const snapshot = await getEnrichedSnapshot(adapter, config.symbol);

        // Update equity
        try {
          const bal = await adapter.getBalance();
          state.equity = parseFloat(bal.equity);
          if (state.equity > state.peakEquity) state.peakEquity = state.equity;
          // Reset daily baseline at day boundary
          const today = new Date().toISOString().slice(0, 10);
          if (today !== state.dailyStartDate) {
            state.dailyStartEquity = state.equity;
            state.dailyStartDate = today;
          }
          state.dailyPnl = state.equity - state.dailyStartEquity;
        } catch { /* non-critical */ }

        const context = {
          equity: state.equity,
          startTime: state.startTime,
          peakEquity: state.peakEquity,
          dailyPnl: state.dailyPnl,
        };

        // ── Phase: Monitoring (waiting for entry conditions) ──
        if (state.phase === "monitoring") {
          const shouldEnter = evaluateAllConditions(config.entry_conditions, snapshot, context, "all");

          if (shouldEnter) {
            log(chalk.green(`  ✓ Entry conditions met @ $${snapshot.price.toFixed(2)}`));
            state.phase = "entering";
          } else {
            logStatus(log, state, snapshot, "waiting");
          }
        }

        // ── Phase: Entering (start strategy) ──
        if (state.phase === "entering") {
          try {
            await strategy.init(strategyCtx, snapshot);
            // Execute any initial actions (e.g., grid placement on first tick)
            strategyCtx.tick = 0;
            const initActions = await strategy.onTick(strategyCtx, snapshot);
            await executeActions(adapter, config.symbol, initActions, log, isDryRun);
            state.fills += countFills(initActions);
            strategyCtx.tick++;

            state.phase = "running";
            state.strategyActive = true;
            log(chalk.green(`  ▶ Strategy started`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(chalk.red(`  ✗ Strategy start failed: ${msg}`));
            state.phase = "monitoring"; // retry
          }
        }

        // ── Phase: Running (manage strategy + check exit) ──
        if (state.phase === "running") {
          // Check exit conditions (any = stop)
          const shouldExit = config.exit_conditions.length > 0
            && evaluateAllConditions(config.exit_conditions, snapshot, context, "any");

          // Check risk limits
          const drawdown = state.peakEquity - state.equity;
          const dailyLossBreached = state.dailyPnl < -config.risk.max_daily_loss;
          const riskBreached = drawdown > config.risk.max_drawdown || dailyLossBreached;

          if (shouldExit || riskBreached) {
            const reason = dailyLossBreached
              ? `daily loss $${Math.abs(state.dailyPnl).toFixed(2)} > limit $${config.risk.max_daily_loss}`
              : drawdown > config.risk.max_drawdown
                ? `drawdown $${drawdown.toFixed(2)} > limit $${config.risk.max_drawdown}`
                : "exit condition met";
            log(chalk.yellow(`  ⚠ Exiting: ${reason}`));
            state.phase = "exiting";
          } else {
            // Manage running strategy
            const actions = await strategy.onTick(strategyCtx, snapshot);
            await executeActions(adapter, config.symbol, actions, log, isDryRun);
            state.fills += countFills(actions);
            strategyCtx.tick++;
            logStatus(log, state, snapshot, "running");
          }
        }

        // ── Phase: Exiting (close everything) ──
        if (state.phase === "exiting") {
          const stopActions = await strategy.onStop(strategyCtx);
          await executeActions(adapter, config.symbol, stopActions, log, isDryRun);
          state.strategyActive = false;

          if (config.risk.pause_after_loss_sec > 0 && state.dailyPnl < 0) {
            log(chalk.yellow(`  ⏸ Pausing ${config.risk.pause_after_loss_sec}s after loss`));
            state.phase = "paused";
            await sleep(config.risk.pause_after_loss_sec * 1000);
            state.phase = "monitoring";
            log(chalk.gray(`  Resuming monitoring...`));
          } else {
            // If exit due to risk breach, stop completely
            log(chalk.red(`  ■ Bot stopped.`));
            break;
          }
        }

        // Update job state
        if (jobId) {
          updateJobState(jobId, {
            result: {
              phase: state.phase,
              equity: state.equity,
              peakEquity: state.peakEquity,
              fills: state.fills,
              totalPnl: state.totalPnl,
              rebalances: state.rebalanceCount,
              runtime: Math.floor((Date.now() - state.startTime) / 1000),
            },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(chalk.red(`  ✗ Loop error: ${msg}`));
      }

      // Wait for next interval
      const elapsed = Date.now() - loopStart;
      const waitMs = Math.max(0, config.monitor_interval_sec * 1000 - elapsed);
      if (running && waitMs > 0) await sleep(waitMs);
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);

    // Cleanup: cancel any remaining orders
    if (state.strategyActive) {
      log(chalk.gray(`  Cleaning up orders...`));
      try { await adapter.cancelAllOrders(config.symbol); } catch { /* best effort */ }
    }
  }

  const runtime = Math.floor((Date.now() - state.startTime) / 1000);
  log(chalk.cyan.bold(`\n  Bot "${config.name}" finished`));
  log(`  Runtime: ${formatDuration(runtime)} | Fills: ${state.fills} | PnL: $${state.totalPnl.toFixed(2)}`);
  log(`  Equity: $${state.equity.toFixed(2)} (peak: $${state.peakEquity.toFixed(2)})\n`);

  if (jobId) {
    updateJobState(jobId, { status: "done" });
  }

  return { fills: state.fills, totalPnl: state.totalPnl, runtime };
}

// ── Action executor ──

async function executeActions(
  adapter: ExchangeAdapter,
  symbol: string,
  actions: StrategyAction[],
  log: BotLog,
  dryRun = false,
) {
  for (const action of actions) {
    if (dryRun) {
      log(`  [DRY-RUN] ${action.type}: ${JSON.stringify(action)}`);
      continue;
    }
    switch (action.type) {
      case "place_order":
        if (action.orderType === "market") {
          await adapter.marketOrder(symbol, action.side, action.size);
        } else {
          await adapter.limitOrder(symbol, action.side, action.price, action.size, {
            reduceOnly: action.reduceOnly,
            tif: action.tif,
          });
        }
        break;
      case "cancel_order":
        await adapter.cancelOrder(symbol, action.orderId);
        break;
      case "cancel_all":
        await adapter.cancelAllOrders(symbol);
        break;
      case "edit_order":
        await adapter.editOrder(symbol, action.orderId, action.price, action.size);
        break;
      case "set_leverage":
        await adapter.setLeverage(symbol, action.leverage, action.marginMode);
        break;
      case "noop":
        break;
    }
  }
}

// ── Enriched snapshot ──

async function getEnrichedSnapshot(
  adapter: ExchangeAdapter,
  symbol: string,
): Promise<EnrichedSnapshot> {
  const base = await getMarketSnapshot(adapter, symbol);
  const [orderbook, klines, markets] = await Promise.all([
    adapter.getOrderbook(symbol).catch(() => ({ bids: [] as [string, string][], asks: [] as [string, string][] })),
    adapter.getKlines(symbol, "1h", Date.now() - 24 * 60 * 60 * 1000, Date.now()).catch(() => []),
    adapter.getMarkets().catch(() => []),
  ]);
  const market = markets.find(m => m.symbol.toUpperCase().includes(symbol.toUpperCase()));
  return { ...base, klines, orderbook, openInterest: market?.openInterest ?? "0" };
}

// ── Utils ──

/** Count fill-producing actions (market orders and limit orders) */
function countFills(actions: StrategyAction[]): number {
  return actions.filter(a => a.type === "place_order" && a.orderType === "market").length;
}

function logStatus(log: BotLog, state: BotState, snapshot: MarketSnapshot, phase: string) {
  const runtime = formatDuration(Math.floor((Date.now() - state.startTime) / 1000));
  const vol = snapshot.volatility24h.toFixed(1);
  const fr = (snapshot.fundingRate * 100).toFixed(4);
  const eq = state.equity.toFixed(2);
  const dd = (state.peakEquity - state.equity).toFixed(2);

  log(chalk.gray(
    `  [${phase}] $${snapshot.price.toFixed(2)} | vol: ${vol}% | fr: ${fr}% | ` +
    `eq: $${eq} | dd: $${dd} | fills: ${state.fills} | ${runtime}`
  ));
}

function defaultLog(msg: string) {
  const ts = new Date().toLocaleTimeString();
  console.log(`${chalk.gray(ts)} ${msg}`);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
