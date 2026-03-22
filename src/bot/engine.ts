import type { ExchangeAdapter } from "../exchanges/index.js";
import type { BotConfig } from "./config.js";
import { getMarketSnapshot, evaluateAllConditions, type MarketSnapshot } from "./conditions.js";
import { updateJobState } from "../jobs.js";
import { getStrategy } from "./strategy-registry.js";
import type { StrategyAction, StrategyContext, EnrichedSnapshot } from "./strategy-types.js";
import type { BotTuiState, StateListener, LogListener } from "./tui/index.js";
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
import "./strategies/funding-auto.js";

export type BotLog = (msg: string) => void;
export type BotOutputMode = "tui" | "json" | "headless";

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

// ── TUI state emitter ──

class TuiEmitter {
  private stateListeners: StateListener[] = [];
  private logListeners: LogListener[] = [];

  subscribe(onState: StateListener, onLog: LogListener): () => void {
    this.stateListeners.push(onState);
    this.logListeners.push(onLog);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== onState);
      this.logListeners = this.logListeners.filter((l) => l !== onLog);
    };
  }

  emitState(s: BotTuiState) {
    for (const l of this.stateListeners) l(s);
  }

  emitLog(msg: string) {
    const entry = { time: new Date().toLocaleTimeString(), message: msg };
    for (const l of this.logListeners) l(entry);
  }
}

export async function runBot(
  adapter: ExchangeAdapter,
  config: BotConfig,
  jobId?: string,
  log: BotLog = defaultLog,
  extraAdapters?: Map<string, ExchangeAdapter>, // for funding-arb (multi-exchange)
  mode: BotOutputMode = "headless",
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

  // ── TUI / JSON mode setup ──
  const tuiEmitter = new TuiEmitter();
  let tuiUnmount: (() => void) | undefined;
  let paused = false;

  // Wrap log for TUI/JSON modes
  const effectiveLog: BotLog = mode === "json"
    ? () => {} // JSON mode suppresses console log; NDJSON emitted per tick
    : mode === "tui"
      ? (msg: string) => tuiEmitter.emitLog(msg)
      : log;

  // Update strategy context to use effective log
  strategyCtx.log = effectiveLog;

  if (mode === "tui") {
    try {
      const { startDashboard } = await import("./tui/index.js");
      const initialTuiState = buildTuiState(state, config, { price: 0, volatility24h: 0, fundingRate: 0, volume24h: 0 }, [], [], strategyCtx);
      const result = startDashboard({
        initialState: initialTuiState,
        onQuit: () => { running = false; state.phase = "stopped"; },
        onPause: () => { paused = !paused; },
        subscribe: (onState, onLog) => tuiEmitter.subscribe(onState, onLog),
      });
      tuiUnmount = result.unmount;
    } catch {
      // Fallback to headless if TUI fails (e.g., non-TTY)
      // mode stays as-is but we just use the original log
    }
  }

  const shutdown = () => { running = false; state.phase = "stopped"; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (mode !== "tui") {
    // Header (headless / json modes print header to console)
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
  }

  // Get initial equity
  try {
    const bal = await adapter.getBalance();
    state.equity = parseFloat(bal.equity);
    state.peakEquity = state.equity;
    state.dailyStartEquity = state.equity;
    effectiveLog(`  Starting equity: $${state.equity.toFixed(2)}`);
  } catch {
    effectiveLog(chalk.yellow(`  Could not fetch initial balance`));
  }

  if (mode !== "tui") {
    log(chalk.gray(`\n  Monitoring conditions... (Ctrl+C to stop)\n`));
  }

  try {
    while (running) {
      // Honor pause toggle from TUI
      if (paused) {
        await sleep(500);
        continue;
      }

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
            effectiveLog(`  Entry conditions met @ $${snapshot.price.toFixed(2)}`);
            state.phase = "entering";
          } else {
            logStatus(effectiveLog, state, snapshot, "waiting");
          }
        }

        // ── Phase: Entering (start strategy) ──
        if (state.phase === "entering") {
          try {
            await strategy.init(strategyCtx, snapshot);
            // Execute any initial actions (e.g., grid placement on first tick)
            strategyCtx.tick = 0;
            const initActions = await strategy.onTick(strategyCtx, snapshot);
            await executeActions(adapter, config.symbol, initActions, effectiveLog, isDryRun);
            state.fills += countFills(initActions);
            strategyCtx.tick++;

            state.phase = "running";
            state.strategyActive = true;
            effectiveLog(`  Strategy started`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            effectiveLog(`  Strategy start failed: ${msg}`);
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
            effectiveLog(`  Exiting: ${reason}`);
            state.phase = "exiting";
          } else {
            // Manage running strategy
            const actions = await strategy.onTick(strategyCtx, snapshot);
            await executeActions(adapter, config.symbol, actions, effectiveLog, isDryRun);
            state.fills += countFills(actions);
            strategyCtx.tick++;
            logStatus(effectiveLog, state, snapshot, "running");
          }
        }

        // ── Phase: Exiting (close everything) ──
        if (state.phase === "exiting") {
          const stopActions = await strategy.onStop(strategyCtx);
          await executeActions(adapter, config.symbol, stopActions, effectiveLog, isDryRun);
          state.strategyActive = false;

          if (config.risk.pause_after_loss_sec > 0 && state.dailyPnl < 0) {
            effectiveLog(`  Pausing ${config.risk.pause_after_loss_sec}s after loss`);
            state.phase = "paused";
            await sleep(config.risk.pause_after_loss_sec * 1000);
            state.phase = "monitoring";
            effectiveLog(`  Resuming monitoring...`);
          } else {
            // If exit due to risk breach, stop completely
            effectiveLog(`  Bot stopped.`);
            break;
          }
        }

        // ── Emit state update for TUI / JSON ──
        const positions = await fetchPositions(adapter, config.symbol);
        const openOrders = await fetchOpenOrders(adapter, config.symbol);
        const tuiState = buildTuiState(state, config, snapshot, positions, openOrders, strategyCtx);

        if (mode === "tui") {
          tuiEmitter.emitState(tuiState);
        } else if (mode === "json") {
          console.log(JSON.stringify(tuiState));
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
        effectiveLog(`  Loop error: ${msg}`);
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
      effectiveLog(`  Cleaning up orders...`);
      try { await adapter.cancelAllOrders(config.symbol); } catch { /* best effort */ }
    }

    // Unmount TUI if active
    if (tuiUnmount) {
      tuiUnmount();
    }
  }

  const runtime = Math.floor((Date.now() - state.startTime) / 1000);

  if (mode === "json") {
    console.log(JSON.stringify({ event: "done", fills: state.fills, totalPnl: state.totalPnl, runtime, equity: state.equity, peakEquity: state.peakEquity }));
  } else if (mode !== "tui") {
    log(chalk.cyan.bold(`\n  Bot "${config.name}" finished`));
    log(`  Runtime: ${formatDuration(runtime)} | Fills: ${state.fills} | PnL: $${state.totalPnl.toFixed(2)}`);
    log(`  Equity: $${state.equity.toFixed(2)} (peak: $${state.peakEquity.toFixed(2)})\n`);
  }

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

// ── TUI helpers ──

async function fetchPositions(adapter: ExchangeAdapter, symbol: string): Promise<import("./tui/index.js").Position[]> {
  try {
    const positions = await adapter.getPositions();
    return positions
      .filter(p => p.symbol.toUpperCase().includes(symbol.toUpperCase()) && parseFloat(p.size) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
      }));
  } catch {
    return [];
  }
}

async function fetchOpenOrders(adapter: ExchangeAdapter, symbol: string): Promise<import("./tui/index.js").OpenOrder[]> {
  try {
    const orders = await adapter.getOpenOrders();
    return orders
      .filter(o => o.symbol.toUpperCase().includes(symbol.toUpperCase()))
      .map(o => ({
        orderId: o.orderId,
        side: o.side,
        price: o.price,
        size: o.size,
        type: o.type,
      }));
  } catch {
    return [];
  }
}

function buildTuiState(
  state: BotState,
  config: BotConfig,
  snapshot: { price: number; volatility24h: number; fundingRate: number; volume24h: number },
  positions: import("./tui/index.js").Position[],
  openOrders: import("./tui/index.js").OpenOrder[],
  strategyCtx: StrategyContext,
): BotTuiState {
  // Extract serializable strategy state from the Map
  const strategyState: Record<string, unknown> = {};
  for (const [k, v] of strategyCtx.state) {
    // Skip non-serializable values (adapters, functions)
    if (typeof v === "function" || (typeof v === "object" && v !== null && !(Array.isArray(v)) && v instanceof Map)) continue;
    try {
      JSON.stringify(v);
      strategyState[k] = v;
    } catch {
      // skip non-serializable
    }
  }

  return {
    phase: state.phase,
    equity: state.equity,
    peakEquity: state.peakEquity,
    dailyPnl: state.dailyPnl,
    fills: state.fills,
    totalPnl: state.totalPnl,
    runtime: Math.floor((Date.now() - state.startTime) / 1000),
    strategy: config.strategy.type,
    symbol: config.symbol,
    exchange: config.exchange,
    price: snapshot.price,
    volume24h: snapshot.volume24h ?? 0,
    openInterest: "0",
    fundingRate: snapshot.fundingRate,
    volatility24h: snapshot.volatility24h,
    positions,
    openOrders,
    strategyState,
    tick: strategyCtx.tick,
  };
}
