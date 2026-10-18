import { getVenue, requireRole, tryResolveVenueId } from "../exchanges/venue.js";
import { assertCanClosePositions } from "../exchanges/trading-v2.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { resolveAdapterSlippage } from "../exchanges/slippage.js";
import { filledOf } from "./fill-size.js";
import type { BotConfig } from "./config.js";
import { PerpError } from "../errors.js";
import { getMarketSnapshot, evaluateAllConditions, evaluateCondition, type MarketSnapshot } from "./conditions.js";
import { updateJobState } from "../jobs.js";
import { getStrategy } from "./strategy-registry.js";
import type { StrategyAction, StrategyContext, EnrichedSnapshot } from "./strategy-types.js";
import type { BotTuiState, ExchangeBalance, StateListener, LogListener } from "./tui/index.js";
import chalk from "chalk";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prepareLimitQuote, prepareMarketSize, quoteRulesOf, type QuoteRules, alignComputedLimitPrice } from "./quote-rules.js";

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
import "./strategies/spot-perp-arb-strategy.js";

export type BotLog = (msg: string) => void;
export type BotOutputMode = "tui" | "json" | "headless";

interface BotState {
  phase: "monitoring" | "entering" | "running" | "exiting" | "paused" | "stopped";
  startTime: number;
  /** null = unknown this tick (a balance / spot read failed or a held token has no price) — never 0. */
  equity: number | null;
  /** null = no baseline yet (equity never known this run). */
  peakEquity: number | null;
  dailyPnl: number;
  dailyStartEquity: number;
  dailyStartDate: string; // YYYY-MM-DD for daily reset
  /** Orders the venue reported as (partly) filled — a resting order is never counted at placement. */
  fills: number;
  /** Orders sent (or, under --dry-run, simulated) — accepted placements, filled or not. */
  ordersPlaced: number;
  totalPnl: number;
  initialEquity: number;
  rebalanceCount: number;
  lastRebalance: number;
  strategyActive: boolean;
  riskBreached: boolean;
  /** A `time_after` exit condition was met: the bot stops after onStop (never re-enters). */
  runtimeEnded: boolean;
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

/**
 * Strategies that place/close orders themselves (multi-leg executors, spot legs) instead of
 * returning StrategyActions — the engine cannot simulate them, so --dry-run is refused.
 */
export const NON_SIMULATABLE_STRATEGIES: ReadonlySet<string> = new Set([
  "funding-arb", "funding-arb-v2", "funding-auto", "spot-perp-arb",
]);

/**
 * ExchangeAdapter methods a --dry-run bot may call: pure reads (plus resolveSymbol, a local
 * lookup). Allowlist, not blocklist (review L4): any other method — every venue write, and any
 * write added to an adapter later — throws, so a dry-run can never reach the venue's write path.
 */
export const ADAPTER_READ_METHODS: ReadonlySet<string> = new Set([
  "getMarkets", "getOrderbook", "getRecentTrades", "getFundingHistory", "getKlines",
  "getBalance", "getPositions", "getOpenOrders", "getOrderHistory", "getTradeHistory", "getFundingPayments",
  "getFundingHours", "resolveSymbol",
]);

/** Throw INVALID_PARAMS if `strategyType` cannot run under --dry-run (checked before any adapter call). */
export function assertStrategySimulatable(strategyType: string): void {
  if (!NON_SIMULATABLE_STRATEGIES.has(strategyType.toLowerCase())) return;
  throw new PerpError("INVALID_PARAMS", `Strategy "${strategyType}" executes orders directly and cannot simulate under --dry-run`, {
    remediation: "Run it without --dry-run on a small size, or backtest it: perp backtest --help",
  });
}

/** Wrap an adapter so only allowlisted reads run; every other method throws (defense in depth for --dry-run bots). */
export function dryRunAdapter(adapter: ExchangeAdapter): ExchangeAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      if (typeof prop === "string" && ADAPTER_READ_METHODS.has(prop)) {
        return (v as (...a: unknown[]) => unknown).bind(target);
      }
      return () => {
        throw new PerpError("INVALID_PARAMS", `--dry-run bot attempted ${String(prop)}() on ${target.name} — only read methods are allowed under --dry-run; blocked`, {
          remediation: "This strategy cannot simulate; run it without --dry-run",
        });
      };
    },
  });
}

export async function runBot(
  adapter: ExchangeAdapter,
  config: BotConfig,
  jobId: string | undefined,
  log: BotLog,
  extraAdapters: Map<string, ExchangeAdapter> | undefined, // for funding-arb (multi-exchange)
  mode: BotOutputMode,
  /** Global --dry-run: strategy actions are logged, never sent; non-simulatable strategies are refused. */
  isDryRun: boolean,
): Promise<{ fills: number; ordersPlaced: number; totalPnl: number; runtime: number }> {
  // A venue without the trading role (TxFlow, release-gated RISEx) runs no bot — dry-run included.
  for (const a of [adapter, ...(extraAdapters?.values() ?? [])]) {
    const venueId = tryResolveVenueId(a.name);
    if (venueId !== null) requireRole(getVenue(venueId), "trading", "automation");
  }
  if (isDryRun) {
    assertStrategySimulatable(config.strategy.type);
    adapter = dryRunAdapter(adapter);
    if (extraAdapters) extraAdapters = new Map([...extraAdapters].map(([k, a]) => [k, dryRunAdapter(a)]));
  } else {
    // A bot must be able to close what it opens: refuse before the first order.
    assertCanClosePositions(adapter, `Bot "${config.strategy.type}" on ${adapter.name}`);
    for (const a of extraAdapters?.values() ?? []) assertCanClosePositions(a, `Bot "${config.strategy.type}" on ${a.name}`);
  }
  const state: BotState = {
    phase: "monitoring",
    startTime: Date.now(),
    equity: null,
    peakEquity: null,
    dailyPnl: 0,
    dailyStartEquity: 0,
    dailyStartDate: new Date().toISOString().slice(0, 10),
    fills: 0,
    ordersPlaced: 0,
    totalPnl: 0,
    initialEquity: 0,
    rebalanceCount: 0,
    lastRebalance: 0,
    strategyActive: false,
    riskBreached: false,
    runtimeEnded: false,
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

  // Pass extra adapters and risk config to strategy context
  if (extraAdapters) {
    strategyCtx.state.set("extraAdapters", extraAdapters);
  }
  strategyCtx.state.set("riskConfig", config.risk);

  // The market's tick / lot / minimums, read once per run (a failed read is retried on the next order).
  let rules: QuoteRules | null = null;
  const rulesOf = async (): Promise<QuoteRules> => {
    if (rules === null) rules = await quoteRulesOf(adapter, config.symbol);
    return rules;
  };
  // Failure surfacing: a run whose strategy never started / never completed a tick fails with its last error.
  let lastError: unknown = null;
  let strategyTicksOk = 0;
  /** Consecutive failed strategy attempts (start / tick / loop), reset by a successful one. */
  let failureStreak = 0;

  let running = true;

  // ── TUI / JSON mode setup ──
  const tuiEmitter = new TuiEmitter();
  let tuiUnmount: (() => void) | undefined;
  let paused = false;

  // Log file: always write to ~/.perp/logs/<bot-name>.log
  const logDir = join(homedir(), ".perp", "logs");
  try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  const logFile = join(logDir, `${config.name}.log`);
  const writeLog = (msg: string) => {
    const ts = new Date().toISOString();
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colors
    try { appendFileSync(logFile, `${ts} ${clean}\n`); } catch { /* ignore */ }
  };

  // Wrap log for TUI/JSON modes + always write to file
  let effectiveLog: BotLog = mode === "json"
    ? (msg: string) => { writeLog(msg); } // JSON mode suppresses console; still log to file
    : mode === "tui"
      ? (msg: string) => { tuiEmitter.emitLog(msg); writeLog(msg); }
      : (msg: string) => { log(msg); writeLog(msg); };

  // Update strategy context to use effective log
  strategyCtx.log = effectiveLog;
  effectiveLog(`  Log file: ${logFile}`);

  if (mode === "tui") {
    try {
      const { startDashboard } = await import("./tui/index.js");
      const initialTuiState = buildTuiState(state, config, { price: 0, volatility24h: 0, fundingRate: 0, volume24h: 0, openInterest: null }, [], [], strategyCtx);
      const result = startDashboard({
        initialState: initialTuiState,
        onQuit: () => { running = false; state.phase = "stopped"; },
        onPause: () => { paused = !paused; },
        subscribe: (onState, onLog) => tuiEmitter.subscribe(onState, onLog),
      });
      tuiUnmount = result.unmount;
    } catch {
      // Fallback to headless if TUI fails (e.g., non-TTY)
      effectiveLog = log;
    }
  }

  const shutdown = () => { running = false; state.phase = "stopped"; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Direct stdin 'q' handler as fallback (ink's useInput may not work in all terminals)
  let stdinHandler: ((data: Buffer) => void) | undefined;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    stdinHandler = (data: Buffer) => {
      const ch = data.toString();
      if (ch === "q" || ch === "Q" || ch === "\x03") { // q, Q, or Ctrl+C
        shutdown();
        if (tuiUnmount) tuiUnmount();
      }
    };
    process.stdin.on("data", stdinHandler);
  }

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

  // Unknown equity is logged once per reason (and once when it is known again), not every tick;
  // JSON mode also writes it to stderr (stdout carries only the JSON lines).
  let equityError: string | null = null;
  const equityUnknown = (e: unknown, what: string) => {
    const reason = e instanceof Error ? e.message : String(e);
    state.equity = null;
    if (reason === equityError) return;
    equityError = reason;
    const msg = chalk.yellow(`  WARNING: ${what} (${reason}) — equity reported as unknown (null); drawdown / daily-loss limits are not evaluated until it is known`);
    effectiveLog(msg);
    if (mode === "json") process.stderr.write(`${msg}\n`);
  };

  // Consecutive ticks whose end-of-tick equity read failed; at UNKNOWN_EQUITY_STOP_TICKS the bot stops.
  let unknownEquityTicks = 0;
  /** A condition that ends the run as a failure regardless of earlier successful ticks. */
  let fatalError: PerpError | null = null;
  // Entries are blocked while equity is unknown (logged once per blocked stretch).
  let entryBlockLogged = false;
  const blockEntryLog = (what: string) => {
    if (entryBlockLogged) return;
    entryBlockLogged = true;
    effectiveLog(chalk.yellow(`  Entries blocked: equity unknown (${equityError ?? "not read yet"}) — ${what}; reduce-only orders and cancels still go out`));
  };
  // Market data (orderbook / klines) a strategy needs but could not be read: the tick is skipped (logged once per cause).
  let marketDataError: string | null = null;
  const needsMarketData = MARKET_DATA_STRATEGIES.has(config.strategy.type.toLowerCase());
  /** Last snapshot price (reference price for the stop actions' market orders). */
  let lastPrice = 0;
  // onStop runs once per started strategy, on every stop path (exit / risk / time_after / SIGINT / error).
  let onStopPending = false;
  /** `retry`: a failure is rethrown and onStop stays pending (the exit phase retries next tick); else logged. */
  const runOnStop = async (why: string, retry: boolean): Promise<void> => {
    if (!onStopPending) return;
    onStopPending = false;
    try {
      const stopActions = await strategy.onStop(strategyCtx);
      await executeActions(adapter, config.symbol, stopActions, effectiveLog, isDryRun, rulesOf, lastPrice);
    } catch (e) {
      if (retry) { onStopPending = true; throw e; }
      effectiveLog(chalk.red(`  WARNING: strategy stop (${why}) FAILED: ${e instanceof Error ? e.message : String(e)} — check positions / orders by hand: perp -e ${adapter.name} account positions; perp -e ${adapter.name} account orders`));
    }
  };
  /**
   * Cancel the orders this bot placed. Single-symbol bot: that symbol's orders on its venue.
   * Multi-symbol ("ALL") bot: the engine never sends a symbol-less cancel (it would cancel the
   * user's manual orders on every market) — the strategy's onStop cancels its own symbols.
   * Returns true when nothing of the bot's is left to cancel.
   */
  const cancelBotOrders = async (): Promise<boolean> => {
    if (isDryRun) return true;
    if (config.symbol.toUpperCase() === "ALL") {
      effectiveLog(`  Multi-symbol bot: no account-wide cancel sent — the strategy cancels the orders of the symbols it traded`);
      return true;
    }
    effectiveLog(`  Cleaning up orders...`);
    try {
      await adapter.cancelAllOrders(config.symbol);
      effectiveLog(`  Remaining ${config.symbol} orders cancelled.`);
      return true;
    } catch (e) {
      effectiveLog(`  WARNING: cancelling the remaining ${config.symbol} orders FAILED (${e instanceof Error ? e.message : String(e)}) — check: perp -e ${adapter.name} account orders`);
      return false;
    }
  };

  // Get initial equity (every venue + spot holdings for a multi-venue bot — botEquity)
  try {
    const eq = await botEquity(adapter, extraAdapters);
    state.equity = eq;
    state.peakEquity = eq;
    state.dailyStartEquity = eq;
    state.initialEquity = eq;
    effectiveLog(`  Starting equity: $${eq.toFixed(2)}`);
  } catch (e) {
    equityUnknown(e, "could not read the starting equity — the baseline is set at the first successful read");
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
        const { snapshot, unknown: dataUnknown } = await getEnrichedSnapshot(adapter, config.symbol, (m) => effectiveLog(m));
        if (snapshot.price > 0) lastPrice = snapshot.price;
        // A strategy that reads the orderbook / klines never runs on fake (empty) data.
        const skipForData = needsMarketData && dataUnknown !== null;
        if (skipForData && dataUnknown !== marketDataError) {
          marketDataError = dataUnknown;
          effectiveLog(chalk.yellow(`  WARNING: market data unknown (${dataUnknown}) — ${config.strategy.type} ticks are skipped until it is read`));
        } else if (!skipForData && needsMarketData && marketDataError !== null) {
          effectiveLog(`  Market data known again — ${config.strategy.type} resumes`);
          marketDataError = null;
        }
        strategyCtx.state.set("equityUnknown", state.equity === null);

        const context = {
          equity: state.equity,
          startTime: state.startTime,
          peakEquity: state.peakEquity,
          dailyPnl: state.dailyPnl,
        };

        // Runtime limit while not running (never entered, or a failed start retrying): stop too —
        // the `time_after` check in the running phase alone would never see it.
        if (state.phase === "monitoring" && config.exit_conditions.some(c => c.type === "time_after" && evaluateCondition(c, snapshot, context))) {
          effectiveLog(`  Bot stopped (runtime limit reached before the strategy ran).`);
          break;
        }

        // ── Phase: Monitoring (waiting for entry conditions) ──
        if (state.phase === "monitoring") {
          const shouldEnter = evaluateAllConditions(config.entry_conditions, snapshot, context, "all");

          if (shouldEnter && state.equity === null) {
            // Unknown equity: no new entry (the start places opening orders); retried next tick.
            blockEntryLog("the strategy is not started");
            logStatus(effectiveLog, state, snapshot, "waiting");
          } else if (shouldEnter && skipForData) {
            logStatus(effectiveLog, state, snapshot, "waiting");
          } else if (shouldEnter) {
            effectiveLog(`  Entry conditions met @ $${snapshot.price.toFixed(2)}`);
            state.phase = "entering";
          } else {
            logStatus(effectiveLog, state, snapshot, "waiting");
          }
        }

        // ── Phase: Entering (start strategy) ──
        if (state.phase === "entering") {
          // Leftover orders of a failed start: cancel them before a retry (never stack a second batch).
          if (state.strategyActive && !(await cancelBotOrders())) {
            effectiveLog(`  Strategy start postponed: the previous failed start's orders could not be cancelled`);
            state.phase = "monitoring";
          }
        }
        if (state.phase === "entering") {
          // Active BEFORE the first order: a failed start's leftover orders are cancelled at stop.
          state.strategyActive = true;
          try {
            await strategy.init(strategyCtx, snapshot);
            // Execute any initial actions (e.g., grid placement on first tick)
            strategyCtx.tick = 0;
            const initActions = await strategy.onTick(strategyCtx, snapshot);
            onStopPending = true;
            // Orders sent (an undersized side skipped for the tick is not counted) / venue-reported fills.
            const sent = await executeActions(adapter, config.symbol, initActions, effectiveLog, isDryRun, rulesOf, snapshot.price);
            state.ordersPlaced += sent.placed;
            state.fills += sent.filled;
            strategyCtx.tick++;
            strategyTicksOk++;
            failureStreak = 0;

            state.phase = "running";
            effectiveLog(`  Strategy started`);
          } catch (err) {
            lastError = err;
            failureStreak++;
            onStopPending = false; // a failed start is not stopped (its leftovers are cancelled), it is retried
            const msg = err instanceof Error ? err.message : String(err);
            effectiveLog(`  Strategy start failed: ${msg}`);
            if (await cancelBotOrders()) state.strategyActive = false;
            state.phase = "monitoring"; // retry
          }
        }

        // ── Phase: Running (manage strategy + check exit) ──
        if (state.phase === "running") {
          // Check exit conditions (any = stop)
          const shouldExit = config.exit_conditions.length > 0
            && evaluateAllConditions(config.exit_conditions, snapshot, context, "any");
          // A met `time_after` (runtime limit, e.g. quick-grid --max-runtime) ends the bot: returning
          // to monitoring would re-enter at once (entry "always") and the runtime would never end.
          const runtimeEnded = config.exit_conditions.some(c => c.type === "time_after" && evaluateCondition(c, snapshot, context));

          // Check risk limits
          // Equity not known this tick (a balance / spot read failed): the drawdown / daily-loss
          // limits are not judged on stale or partial numbers — logged once (equityUnknown), never a fake breach.
          const drawdown = state.equity !== null && state.peakEquity !== null ? state.peakEquity - state.equity : null;
          const dailyLossBreached = drawdown !== null && state.dailyPnl < -config.risk.max_daily_loss;
          const riskBreached = drawdown !== null && (drawdown > config.risk.max_drawdown || dailyLossBreached);

          const finished = strategy.isDone?.(strategyCtx) === true;
          if (shouldExit || riskBreached || finished) {
            const reason = finished ? "strategy finished (its order total is placed)" : dailyLossBreached
              ? `daily loss $${Math.abs(state.dailyPnl).toFixed(2)} > limit $${config.risk.max_daily_loss}`
              : drawdown !== null && drawdown > config.risk.max_drawdown
                ? `drawdown $${drawdown.toFixed(2)} > limit $${config.risk.max_drawdown}`
                : runtimeEnded ? "runtime limit (time_after) reached" : "exit condition met";
            effectiveLog(`  Exiting: ${reason}`);
            state.riskBreached = riskBreached;
            state.runtimeEnded = runtimeEnded || finished;
            state.phase = "exiting";
          } else if (skipForData) {
            logStatus(effectiveLog, state, snapshot, "running");
          } else {
            // Manage running strategy
            let actions = await strategy.onTick(strategyCtx, snapshot);
            if (state.equity === null) {
              // Unknown equity: opening orders are dropped; reduce-only orders / cancels still go out.
              const kept = actions.filter(a => a.type !== "place_order" || a.reduceOnly === true);
              if (kept.length < actions.length) blockEntryLog(`${actions.length - kept.length} opening order(s) dropped this tick`);
              actions = kept;
            } else {
              entryBlockLogged = false;
            }
            // Orders sent (an undersized side skipped for the tick is not counted) / venue-reported fills.
            const sent = await executeActions(adapter, config.symbol, actions, effectiveLog, isDryRun, rulesOf, snapshot.price);
            state.ordersPlaced += sent.placed;
            state.fills += sent.filled;
            strategyCtx.tick++;
            strategyTicksOk++;
            failureStreak = 0;
            logStatus(effectiveLog, state, snapshot, "running");
          }
        }

        // ── Phase: Exiting (close everything) ──
        if (state.phase === "exiting") {
          await runOnStop("exit", true);
          state.strategyActive = false;

          if (state.runtimeEnded) {
            effectiveLog(`  Bot stopped (runtime limit reached or strategy finished).`);
            break;
          } else if (config.risk.pause_after_loss_sec > 0 && state.dailyPnl < 0) {
            effectiveLog(`  Pausing ${config.risk.pause_after_loss_sec}s after loss`);
            state.phase = "paused";
            // Interruptible: a SIGINT during the pause ends the bot within 250 ms.
            const pauseUntil = Date.now() + config.risk.pause_after_loss_sec * 1000;
            while (running && Date.now() < pauseUntil) await sleep(Math.min(250, pauseUntil - Date.now()));
            if (!running) break;
            // Data will be refreshed on the next loop iteration (re-fetches snapshot + equity)
            state.phase = "monitoring";
            effectiveLog(`  Resuming monitoring...`);
          } else if (state.riskBreached) {
            // Risk breach (drawdown or daily loss exceeded) — stop completely
            effectiveLog(`  Bot stopped.`);
            break;
          } else {
            // Normal exit condition (not risk breach) — return to monitoring
            state.phase = "monitoring";
            state.riskBreached = false;
            effectiveLog(`  Exit condition met, returning to monitoring...`);
          }
        }

        // ── Fetch balances + emit state update for TUI / JSON ──
        // Display data: a failed venue read is carried as an error (rendered "unavailable"), never as empty.
        const [{ positions, errors: positionErrors }, { orders: openOrders, error: openOrdersError }, exchangeBalances] = await Promise.all([
          extraAdapters ? fetchAllPositions(adapter, config.symbol, extraAdapters) : fetchPositions(adapter, config.symbol, adapter.name).then(r => ({ positions: r.positions, errors: r.error === null ? [] : [{ exchange: adapter.name, error: r.error }] })),
          fetchOpenOrders(adapter, config.symbol),
          fetchExchangeBalances(adapter, extraAdapters),
        ]);

        // Equity: the primary venue's (single-venue bot) or every venue + spot holdings (multi-venue:
        // a spot-perp bot moves USDC into spot tokens — counting the perp account alone read that
        // as a loss; live 2026-10-12 "daily loss $10.12" right after a $10 spot buy).
        try {
          const eq = await botEquity(adapter, extraAdapters);
          state.equity = eq;
          if (state.peakEquity === null) {
            // First successful read after a failed start read: this is the baseline.
            state.peakEquity = eq;
            state.dailyStartEquity = eq;
            state.initialEquity = eq;
          }
          if (equityError !== null) {
            effectiveLog(`  Equity known again: $${eq.toFixed(2)} — risk limits evaluated`);
            equityError = null;
          }
          if (eq > state.peakEquity) state.peakEquity = eq;
          // Reset daily baseline at day boundary
          const today = new Date().toISOString().slice(0, 10);
          if (today !== state.dailyStartDate) {
            state.dailyStartEquity = eq;
            state.dailyStartDate = today;
          }
          state.dailyPnl = eq - state.dailyStartEquity;
          state.totalPnl = eq - state.initialEquity;
          unknownEquityTicks = 0;
        } catch (e) {
          equityUnknown(e, "equity read failed");
          unknownEquityTicks++;
          if (unknownEquityTicks >= UNKNOWN_EQUITY_STOP_TICKS) {
            fatalError = new PerpError(e instanceof PerpError ? e.structured.code : "EXCHANGE_ERROR",
              `Bot "${config.name}": equity unknown for ${unknownEquityTicks} consecutive ticks (last: ${equityError}) — stopped (risk limits cannot be evaluated)`, {
                exchange: adapter.name,
                remediation: `Check the balances / spot holdings the bot reads (perp -e ${adapter.name} account balance${extraAdapters ? "; every venue of the bot" : ""}), fix the read or the unpriced holding, then restart the bot`,
              });
            effectiveLog(chalk.red(`  ${fatalError.message}`));
            running = false;
          }
        }

        if (mode === "tui" || mode === "json") {
          const tuiState = buildTuiState(state, config, snapshot, positions, openOrders, strategyCtx, exchangeBalances, { positionErrors, openOrdersError });

          if (mode === "tui") {
            tuiEmitter.emitState(tuiState);
          } else {
            console.log(JSON.stringify(tuiState));
          }
        } else {
          effectiveLog(`  tick: phase=${state.phase} equity=${usdOrUnknown(state.equity)}`);
        }

        // Update job state
        if (jobId) {
          updateJobState(jobId, {
            result: {
              phase: state.phase,
              equity: state.equity,
              peakEquity: state.peakEquity,
              fills: state.fills,
              ordersPlaced: state.ordersPlaced,
              totalPnl: state.totalPnl,
              rebalances: state.rebalanceCount,
              runtime: Math.floor((Date.now() - state.startTime) / 1000),
            },
          });
        }
      } catch (err) {
        lastError = err;
        failureStreak++;
        const msg = err instanceof Error ? err.message : String(err);
        effectiveLog(`  Loop error: ${msg}`);
      }

      // Wait for next interval
      const elapsed = Date.now() - loopStart;
      const waitMs = Math.max(0, config.monitor_interval_sec * 1000 - elapsed);
      // Interruptible wait: a SIGINT (background stop) ends it within 250 ms, not after a full interval.
      const until = Date.now() + waitMs;
      while (running && Date.now() < until) await sleep(Math.min(250, until - Date.now()));
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    if (stdinHandler) {
      process.stdin.removeListener("data", stdinHandler);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    }

    // Every stop path (SIGINT / time_after / error / unknown equity): the strategy's onStop runs
    // once (guarded), then the bot's remaining orders are cancelled.
    await runOnStop("shutdown", false);
    if (state.strategyActive) await cancelBotOrders();

    // Unmount TUI if active
    if (tuiUnmount) {
      tuiUnmount();
    }
  }

  const runtime = Math.floor((Date.now() - state.startTime) / 1000);

  // What the bot leaves open: positions on its venue(s) (its symbol, or every symbol for a
  // multi-symbol bot — those may include positions this bot did not open), with close commands.
  // The stop summary must reach the user in every mode: JSON mode keeps stdout for JSON lines
  // (→ stderr), and the TUI is unmounted by now (→ the console log).
  const stopLog: BotLog = mode === "json"
    ? (msg: string) => { writeLog(msg); process.stderr.write(`${msg}\n`); }
    : mode === "tui" ? (msg: string) => { log(msg); writeLog(msg); } : effectiveLog;
  const spotLegs = extraAdapters !== undefined && extraAdapters.size > 0 && SPOT_LEG_STRATEGIES.has(config.strategy.type);
  const leftOpen = isDryRun ? [] : await openPositionsAtStop(adapter, config.symbol, extraAdapters, stopLog, spotLegs);

  if (mode === "json") {
    console.log(JSON.stringify({ event: "done", fills: state.fills, ordersPlaced: state.ordersPlaced, totalPnl: state.totalPnl, runtime, equity: state.equity, peakEquity: state.peakEquity, openPositions: leftOpen }));
  } else if (mode !== "tui") {
    log(chalk.cyan.bold(`\n  Bot "${config.name}" finished`));
    log(`  Runtime: ${formatDuration(runtime)} | Orders: ${state.ordersPlaced} | Fills: ${state.fills} | PnL: $${state.totalPnl.toFixed(2)}`);
    log(`  Equity: ${usdOrUnknown(state.equity)} (peak: ${usdOrUnknown(state.peakEquity)})\n`);
  }

  if (fatalError !== null) {
    if (jobId) updateJobState(jobId, { status: "error", result: { error: fatalError.message, fills: state.fills, ordersPlaced: state.ordersPlaced, runtime } });
    throw fatalError;
  }

  // A run whose strategy never completed a start / tick — or whose last FAILED_RUN_STREAK attempts
  // all failed — is a failed run (non-zero exit / ok:false), never a clean "done".
  if (lastError !== null && (strategyTicksOk === 0 || failureStreak >= FAILED_RUN_STREAK)) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    const why = strategyTicksOk === 0 ? "the strategy never started / completed a tick" : `the last ${failureStreak} attempts failed`;
    if (jobId) updateJobState(jobId, { status: "error", result: { error: msg, fills: state.fills, ordersPlaced: state.ordersPlaced, runtime } });
    throw new PerpError(lastError instanceof PerpError ? lastError.structured.code : "EXCHANGE_ERROR",
      `Bot "${config.name}" (${config.strategy.type} on ${adapter.name}) failed: ${why}. Last error: ${msg}`, {
        exchange: adapter.name, fills: state.fills, ordersPlaced: state.ordersPlaced, runtime,
        remediation: `See the log: ${logFile}`,
      });
  }

  if (jobId) {
    updateJobState(jobId, { status: "done" });
  }

  return { fills: state.fills, ordersPlaced: state.ordersPlaced, totalPnl: state.totalPnl, runtime };
}

/** Consecutive failed strategy starts / ticks at the end of a run that make the run a failure. */
const FAILED_RUN_STREAK = 3;

/** Consecutive ticks with unknown equity after which the bot stops (an error, never a silent run). */
export const UNKNOWN_EQUITY_STOP_TICKS = 10;

/** Strategies that read the snapshot's orderbook / klines: a tick whose read failed is skipped. */
export const MARKET_DATA_STRATEGIES: ReadonlySet<string> = new Set([
  "engine-mm", "avellaneda-mm", "regime-mm", "claude-agent", "momentum-breakout", "aggressive-taker", "mean-reversion",
]);

/** Strategies that hold spot legs (spot-perp): their stop summary lists the spot holdings too. */
export const SPOT_LEG_STRATEGIES: ReadonlySet<string> = new Set(["spot-perp-arb", "funding-arb"]);

/** A position left open at stop, with the command that closes it (a pair's legs share one command). */
export interface OpenPositionAtStop { exchange: string; symbol: string; side: string; size: string; close: string }

/**
 * Open positions at stop (logged with the close command); a failed read is logged, never "none".
 * `spotLegs` (a multi-venue spot-perp bot): the bot spot venues' holdings of the traded symbol(s)
 * are listed too — a spot holding + a perp short of one symbol is closed as a pair
 * (`arb close --spot-exch --perp-exch`), never the short alone (that leaves the spot unhedged).
 */
export async function openPositionsAtStop(
  primary: ExchangeAdapter, symbol: string, extra: Map<string, ExchangeAdapter> | undefined, log: BotLog, spotLegs: boolean,
): Promise<OpenPositionAtStop[]> {
  const all = new Map<string, ExchangeAdapter>([[primary.name, primary], ...[...(extra ?? new Map<string, ExchangeAdapter>())].filter(([n]) => n !== primary.name)]);
  const multi = symbol.toUpperCase() === "ALL";
  const out: Array<Omit<OpenPositionAtStop, "close"> & { close: string | null }> = [];
  for (const [name, a] of all) {
    try {
      for (const p of await a.getPositions()) {
        if (Number(p.size) === 0) continue;
        const sym = p.symbol.toUpperCase().replace(/-PERP$/, "");
        if (!multi && sym !== symbol.toUpperCase()) continue;
        out.push({ exchange: name, symbol: sym, side: p.side, size: p.size.replace(/^-/, ""), close: null });
      }
    } catch (e) {
      log(`  WARNING: could not read ${name} positions at stop (${e instanceof Error ? e.message : String(e)}) — check: perp -e ${name} account positions`);
    }
  }
  if (spotLegs) {
    const { getBotSpotAdapter, nonQuoteSpotBalances, spotNetworkOf, spotTokenBase } = await import("../exchanges/spot-factory.js");
    const { SPOT_PERP_TOKEN_MAP } = await import("../exchanges/spot-interface.js");
    const { getVenue } = await import("../exchanges/venue.js");
    for (const [name, a] of all) {
      try {
        const spot = await getBotSpotAdapter(name, a);
        if (spot === null) continue;
        const [balances, markets] = await Promise.all([spot.getSpotBalances(), spot.getSpotMarkets()]);
        // Only tokens with a spot market can be a spot leg (e.g. HIP-4 outcome tokens are not).
        const traded = new Set(markets.map(m => m.baseToken.toUpperCase()));
        for (const b of nonQuoteSpotBalances(getVenue(name), spotNetworkOf(spot), balances)) {
          const base = spotTokenBase(b.token);
          if (!traded.has(base)) continue;
          // Listed under the perp name (UBTC → BTC) so it pairs with its hedge.
          const sym = SPOT_PERP_TOKEN_MAP[base] ?? base;
          if (!multi && sym !== symbol.toUpperCase() && base !== symbol.toUpperCase()) continue;
          out.push({ exchange: name, symbol: sym, side: "spot", size: b.total, close: `perp -e ${name} trade spot-sell ${base} ${b.total}` });
        }
      } catch (e) {
        log(`  WARNING: could not read ${name} spot holdings at stop (${e instanceof Error ? e.message : String(e)}) — check: perp -e ${name} trade spot-balance`);
      }
    }
  }
  if (out.length === 0) return [];
  log(`  Open positions at stop${multi ? ` on ${[...all.keys()].join(", ")} (may include positions this bot did not open)` : ""}:`);
  const paired = new Set<(typeof out)[number]>();
  const shortFor = (sym: string, notOn: string | null) => out.find(p => p.side === "short" && p.symbol === sym && p.exchange !== notOn && !paired.has(p));
  for (const sp of out.filter(p => p.side === "spot")) {
    const s = shortFor(sp.symbol, null);
    if (s === undefined) continue;
    paired.add(sp); paired.add(s);
    sp.close = s.close = `perp arb close ${sp.symbol} --spot-exch ${sp.exchange} --perp-exch ${s.exchange}`;
    log(`    ${sp.symbol}: spot ${sp.size} on ${sp.exchange} / short ${s.size} on ${s.exchange} — close the pair: ${sp.close}`);
  }
  for (const l of out.filter(p => p.side === "long")) {
    const s = shortFor(l.symbol, l.exchange);
    if (s === undefined) continue;
    paired.add(l); paired.add(s);
    l.close = s.close = `perp arb close ${l.symbol} --pair ${l.exchange}:${s.exchange}`;
    log(`    ${l.symbol}: long ${l.size} on ${l.exchange} / short ${s.size} on ${s.exchange} — close the pair: ${l.close}`);
  }
  for (const p of out) {
    if (paired.has(p)) continue;
    if (p.close === null) p.close = `perp -e ${p.exchange} trade close ${p.symbol}`;
    log(`    ${p.symbol}: ${p.side} ${p.size} on ${p.exchange} — close: ${p.close}`);
  }
  return out.map(p => ({ ...p, close: p.close as string }));
}

/**
 * Bot equity in USD. Single-venue bot: the venue's account equity. Multi-venue bot (extra
 * adapters): Σ every venue's account equity + its bot spot holdings — tokens at the shared
 * valuation price (spotMarketsForValuation: spot market price, HIP-4 outcome tokens at their
 * outcome mid), and the spot quote balance when the spot account is separate from the perp
 * margin (spotSharesPerpMargin false). Any failed read or unpriced token → throws (equity unknown;
 * never a partial sum that would read as a loss).
 */
async function botEquity(primary: ExchangeAdapter, extra: Map<string, ExchangeAdapter> | undefined): Promise<number> {
  const eq = (v: string, who: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new PerpError("EXCHANGE_ERROR", `${who} equity is not a number (${v})`);
    return n;
  };
  if (extra === undefined || extra.size === 0) return eq((await primary.getBalance()).equity, primary.name);
  const { getBotSpotAdapter, isSpotQuoteAsset, spotMarketsForValuation, spotNetworkOf, spotTokenBase, spotSharesPerpMargin } = await import("../exchanges/spot-factory.js");
  const { getVenue } = await import("../exchanges/venue.js");
  const all = new Map<string, ExchangeAdapter>([[primary.name, primary], ...[...extra].filter(([n]) => n !== primary.name)]);
  let total = 0;
  for (const [name, a] of all) {
    total += eq((await a.getBalance()).equity, name);
    const spot = await getBotSpotAdapter(name, a);
    if (spot === null) continue;
    const def = getVenue(name);
    const net = spotNetworkOf(spot);
    const shared = spotSharesPerpMargin(def, a);
    // Shared valuation prices (spot markets + held HIP-4 outcome tokens at their outcome mid).
    const balances = await spot.getSpotBalances();
    const markets = await spotMarketsForValuation(def, spot, balances, net);
    const price = new Map(markets.map(m => [m.baseToken.toUpperCase(), m.markPrice]));
    for (const b of balances) {
      const qty = Number(b.total);
      if (!(qty > 0)) continue;
      if (isSpotQuoteAsset(def, net, b.token)) { if (!shared) total += qty; continue; }
      const px = Number(price.get(spotTokenBase(b.token)));
      if (!(px > 0)) throw new PerpError("PRICE_STALE", `${name} spot ${b.token}: no market price — bot equity unknown`);
      total += qty * px;
    }
  }
  return total;
}

// ── Action executor ──

/**
 * Send strategy actions. Orders go out on the venue grid (quote-rules.ts): limit prices aligned
 * passively to the tick (bid ↓, ask ↑), sizes floored to the lot, venue minimums refused before
 * sending. `refPrice` = the tick's snapshot price (minimum order value of market orders).
 * One order under the venue minimum (e.g. the inventory-skewed side of a market maker) is
 * skipped for this tick with a log line — the other orders still go out; when EVERY order of
 * the batch is under the minimum the last SIZE_TOO_SMALL is thrown (the tick fails: the
 * strategy's base size itself is too small).
 * Returns the orders sent (`placed`) and those the venue reported as (partly) filled (`filled`,
 * filledOf) — an accepted resting limit order is a placement, not a fill. Under --dry-run every
 * place_order is a simulated placement and nothing fills.
 */
export async function executeActions(
  adapter: ExchangeAdapter,
  symbol: string,
  actions: StrategyAction[],
  log: BotLog,
  dryRun: boolean,
  rulesOf: () => Promise<QuoteRules>,
  refPrice: number,
): Promise<{ placed: number; filled: number }> {
  let orders = 0;
  let filled = 0;
  let undersized: PerpError | null = null;
  let skipped = 0;
  for (const action of actions) {
    if (dryRun) {
      log(`  [DRY-RUN] ${action.type}: ${JSON.stringify(action)}`);
      if (action.type === "place_order") orders++;
      continue;
    }
    switch (action.type) {
      case "place_order": {
        orders++;
        const rules = await rulesOf();
        let prepared: { price: string | null; size: string };
        try {
          prepared = action.orderType === "market"
            ? { price: null, size: prepareMarketSize(rules, adapter.name, symbol, action.size, refPrice) }
            : prepareLimitQuote(rules, adapter.name, symbol, action.side, action.price, action.size);
        } catch (e) {
          if (!(e instanceof PerpError) || e.structured.code !== "SIZE_TOO_SMALL") throw e;
          undersized = e;
          skipped++;
          log(`  SKIP ${action.side} ${action.size}${action.orderType === "limit" ? ` @ ${action.price}` : ""} this tick: ${e.message}`);
          break;
        }
        const raw = prepared.price === null
          ? await adapter.marketOrder(symbol, action.side, prepared.size, { reduceOnly: action.reduceOnly === true, slippage: resolveAdapterSlippage(adapter, null) })
          : await adapter.limitOrder(symbol, action.side, rules.tickSize === null ? await alignComputedLimitPrice(adapter, symbol, action.side, prepared.price) : prepared.price, prepared.size, {
            reduceOnly: action.reduceOnly,
            tif: action.tif,
          });
        const f = filledOf(adapter, raw);
        if (f !== null && f > 0) filled++;
        break;
      }
      case "cancel_order":
        await adapter.cancelOrder(symbol, action.orderId);
        break;
      case "cancel_all":
        // A multi-symbol bot never sends an account-wide cancel (it would cancel the user's
        // manual orders on every market): its strategy cancels the symbols it traded.
        if (symbol.toUpperCase() === "ALL") log(`  cancel_all not sent for a multi-symbol bot (account-wide) — the strategy cancels its own symbols`);
        else await adapter.cancelAllOrders(symbol);
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
  if (undersized !== null && skipped === orders) throw undersized;
  return { placed: orders - skipped, filled };
}


export { filledOf };

// ── Enriched snapshot ──

/**
 * The tick's market snapshot. `unknown` names a failed orderbook / klines read (null = both
 * read): the empty arrays in `snapshot` then are NOT data — the engine skips the tick of a
 * strategy that reads them (MARKET_DATA_STRATEGIES).
 */
export async function getEnrichedSnapshot(
  adapter: ExchangeAdapter,
  symbol: string,
  log: BotLog,
): Promise<{ snapshot: EnrichedSnapshot; unknown: string | null }> {
  // Multi-symbol strategies use "ALL" — skip market-specific data
  if (symbol.toUpperCase() === "ALL") {
    return {
      snapshot: {
        price: 0, high24h: 0, low24h: 0, volume24h: 0,
        fundingRate: 0, volatility24h: 0, rsi: NaN, spreadPct: 0,
        klines: [], orderbook: { bids: [], asks: [] }, openInterest: null,
      },
      unknown: null,
    };
  }
  const base = await getMarketSnapshot(adapter, symbol, log);
  const failed: string[] = [];
  const why = (what: string) => (e: unknown) => { failed.push(`${what} read failed: ${e instanceof Error ? e.message : String(e)}`); return null; };
  const [orderbook, klines] = await Promise.all([
    adapter.getOrderbook(symbol).catch(why("orderbook")),
    adapter.getKlines(symbol, "1h", Date.now() - 24 * 60 * 60 * 1000, Date.now()).catch(why("klines")),
  ]);
  return {
    // Open interest is not read for the bot snapshot: null (unknown), never a "0" stand-in.
    snapshot: { ...base, klines: klines ?? [], orderbook: orderbook ?? { bids: [], asks: [] }, openInterest: null },
    unknown: failed.length > 0 ? failed.join("; ") : null,
  };
}

// ── Utils ──

function logStatus(log: BotLog, state: BotState, snapshot: MarketSnapshot, phase: string) {
  const runtime = formatDuration(Math.floor((Date.now() - state.startTime) / 1000));
  const vol = Number.isFinite(snapshot.volatility24h) ? `${snapshot.volatility24h.toFixed(1)}%` : "unknown";
  const fr = (snapshot.fundingRate * 100).toFixed(4);
  const eq = usdOrUnknown(state.equity);
  const dd = state.equity !== null && state.peakEquity !== null ? `$${(state.peakEquity - state.equity).toFixed(2)}` : "unknown";

  log(chalk.gray(
    `  [${phase}] $${snapshot.price.toFixed(2)} | vol: ${vol} | fr: ${fr}% | ` +
    `eq: ${eq} | dd: ${dd} | fills: ${state.fills} | ${runtime}`
  ));
}

/** "$12.34", or "unknown" for a null (unknown) amount. */
function usdOrUnknown(v: number | null): string {
  return v === null ? "unknown" : `$${v.toFixed(2)}`;
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

/** TUI positions of one venue; a failed read → `error` set (shown "unavailable"), never an empty list. */
export async function fetchPositions(adapter: ExchangeAdapter, symbol: string, exchangeName?: string): Promise<{ positions: import("./tui/index.js").Position[]; error: string | null }> {
  try {
    const positions = await adapter.getPositions();
    const isAll = symbol.toUpperCase() === "ALL";
    return { positions: positions
      .filter(p => (isAll || p.symbol.toUpperCase() === symbol.toUpperCase() || p.symbol.toUpperCase() === symbol.toUpperCase() + "-PERP") && parseFloat(p.size) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
        exchange: exchangeName ?? adapter.name,
      })), error: null };
  } catch (e) {
    return { positions: [], error: `positions read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A venue whose balance read failed is listed with `error` set and null amounts, never left out. */
export async function fetchExchangeBalances(
  primaryAdapter: ExchangeAdapter,
  extraAdapters?: Map<string, ExchangeAdapter>,
): Promise<import("./tui/index.js").ExchangeBalance[]> {
  const adapters: [string, ExchangeAdapter][] = [[primaryAdapter.name, primaryAdapter]];
  if (extraAdapters) {
    for (const [name, a] of extraAdapters) {
      if (name !== primaryAdapter.name) adapters.push([name, a]);
    }
  }
  const results: import("./tui/index.js").ExchangeBalance[] = [];
  await Promise.all(adapters.map(async ([name, a]) => {
    try {
      const bal = await a.getBalance();
      results.push({ exchange: name, equity: bal.equity, available: bal.available });
    } catch (e) {
      results.push({ exchange: name, equity: null, available: null, error: e instanceof Error ? e.message : String(e) });
    }
  }));
  return results;
}

const _spotPriceWarned = new Set<string>();

async function fetchSpotPositions(
  adapter: ExchangeAdapter,
): Promise<{ positions: import("./tui/index.js").Position[]; error: string | null }> {
  // Bot scope: only separate/runtime spot venues with transfer.
  const { getBotSpotAdapter, isSpotQuoteAsset, spotMarketsForValuation, spotNetworkOf, spotTokenBase } = await import("../exchanges/spot-factory.js");
  const { getVenue } = await import("../exchanges/venue.js");
  let raw: import("../exchanges/spot-interface.js").SpotBalance[];
  let markets: import("../exchanges/spot-factory.js").SpotValuationPrice[];
  let net: import("../exchanges/venue-types.js").Network;
  try {
    const spot = await getBotSpotAdapter(adapter.name, adapter);
    if (spot === null) return { positions: [], error: null };
    net = spotNetworkOf(spot);
    raw = await spot.getSpotBalances();
    markets = await spotMarketsForValuation(getVenue(adapter.name), spot, raw, net);
  } catch (e) {
    // Display-only path: surfaced as "unavailable" in the TUI / JSON state, the TUI stays alive.
    return { positions: [], error: `spot positions read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const def = getVenue(adapter.name);
  const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), m.markPrice]));
  const out: import("./tui/index.js").Position[] = [];
  for (const b of raw) {
    if (Number(b.total) <= 0 || isSpotQuoteAsset(def, net, b.token)) continue;
    const base = spotTokenBase(b.token);
    const markPrice = priceMap.get(base);
    if (markPrice === undefined || markPrice === null || !(Number(markPrice) > 0)) {
      // Unknown price: excluded (never valued at 0) — surfaced once per token.
      const k = `${def.id}:${base}`;
      if (!_spotPriceWarned.has(k)) {
        _spotPriceWarned.add(k);
        process.stderr.write(`[warn] ${def.displayName} spot ${base}: no market price — excluded from spot positions\n`);
      }
      continue;
    }
    const total = Number(b.total);
    const entryNtl = b.entryNtl ? Number(b.entryNtl) : 0;
    const avgEntry = (entryNtl > 0 && total > 0) ? (entryNtl / total) : 0;
    const uPnL = avgEntry > 0 ? (Number(markPrice) - avgEntry) * total : 0;
    out.push({
      symbol: base, side: "spot", size: b.total,
      entryPrice: avgEntry > 0 ? avgEntry.toPrecision(5) : "—",
      markPrice,
      unrealizedPnl: avgEntry > 0 ? uPnL.toFixed(2) : "—",
      exchange: adapter.name,
    });
  }
  return { positions: out, error: null };
}

async function fetchAllPositions(
  primaryAdapter: ExchangeAdapter,
  symbol: string,
  extraAdapters?: Map<string, ExchangeAdapter>,
): Promise<{ positions: import("./tui/index.js").Position[]; errors: import("./tui/BotDashboard.js").VenueReadError[] }> {
  const adapters: [string, ExchangeAdapter][] = [[primaryAdapter.name, primaryAdapter]];
  if (extraAdapters) {
    for (const [name, a] of extraAdapters) {
      if (name !== primaryAdapter.name) adapters.push([name, a]);
    }
  }
  const all: import("./tui/index.js").Position[][] = [];
  const errors: import("./tui/BotDashboard.js").VenueReadError[] = [];
  await Promise.all(adapters.map(async ([name, a]) => {
    const [perpPos, spotPos] = await Promise.all([
      fetchPositions(a, symbol, name),
      fetchSpotPositions(a),
    ]);
    all.push([...perpPos.positions, ...spotPos.positions]);
    for (const err of [perpPos.error, spotPos.error]) if (err !== null) errors.push({ exchange: name, error: err });
  }));
  return { positions: all.flat(), errors };
}

/** TUI open orders; a failed read → `error` set (shown "unavailable"), never an empty list. */
export async function fetchOpenOrders(adapter: ExchangeAdapter, symbol: string): Promise<{ orders: import("./tui/index.js").OpenOrder[]; error: string | null }> {
  try {
    const orders = await adapter.getOpenOrders();
    return { orders: orders
      .filter(o => o.symbol.toUpperCase() === symbol.toUpperCase() || o.symbol.toUpperCase() === symbol.toUpperCase() + "-PERP")
      .map(o => ({
        orderId: o.orderId,
        side: o.side,
        price: o.price,
        size: o.size,
        type: o.type,
      })), error: null };
  } catch (e) {
    return { orders: [], error: `open orders read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function buildTuiState(
  state: BotState,
  config: BotConfig,
  snapshot: { price: number; volatility24h: number; fundingRate: number; volume24h: number; openInterest: string | null },
  positions: import("./tui/index.js").Position[],
  openOrders: import("./tui/index.js").OpenOrder[],
  strategyCtx: StrategyContext,
  exchangeBalances?: import("./tui/index.js").ExchangeBalance[],
  readErrors?: { positionErrors: import("./tui/BotDashboard.js").VenueReadError[]; openOrdersError: string | null },
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
    ordersPlaced: state.ordersPlaced,
    totalPnl: state.totalPnl,
    runtime: Math.floor((Date.now() - state.startTime) / 1000),
    strategy: config.strategy.type,
    symbol: config.symbol,
    exchange: config.exchange,
    price: snapshot.price,
    volume24h: snapshot.volume24h ?? 0,
    openInterest: snapshot.openInterest,
    fundingRate: snapshot.fundingRate,
    volatility24h: snapshot.volatility24h,
    positions,
    openOrders,
    strategyState,
    tick: strategyCtx.tick,
    exchangeBalances,
    positionErrors: readErrors?.positionErrors ?? [],
    openOrdersError: readErrors?.openOrdersError ?? null,
  };
}
