import type { ExchangeAdapter } from "../exchanges/index.js";
import type { BotConfig, GridStrategyParams, DCAStrategyParams, FundingArbStrategyParams } from "./config.js";
import { getMarketSnapshot, evaluateAllConditions, type MarketSnapshot } from "./conditions.js";
import { updateJobState } from "../jobs.js";
import { checkArbLiquidity } from "../liquidity.js";
import { computeMatchedSize, reconcileArbFills } from "../arb-sizing.js";
import chalk from "chalk";

export type BotLog = (msg: string) => void;

interface BotState {
  phase: "monitoring" | "entering" | "running" | "exiting" | "paused" | "stopped";
  startTime: number;
  equity: number;
  peakEquity: number;
  dailyPnl: number;
  fills: number;
  totalPnl: number;
  rebalanceCount: number;
  lastRebalance: number;
  strategyActive: boolean;
  // Grid specific
  gridOrders: Map<number, string>;  // gridIndex → orderId
  gridUpper: number;
  gridLower: number;
  // DCA specific
  dcaOrdersPlaced: number;
  dcaLastOrder: number;
  // Funding arb specific
  arbRunning: boolean;
  arbPositions: number;
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
    fills: 0,
    totalPnl: 0,
    rebalanceCount: 0,
    lastRebalance: 0,
    strategyActive: false,
    gridOrders: new Map(),
    gridUpper: 0,
    gridLower: 0,
    dcaOrdersPlaced: 0,
    dcaLastOrder: 0,
    arbRunning: false,
    arbPositions: 0,
  };

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
    log(`  Starting equity: $${state.equity.toFixed(2)}`);
  } catch {
    log(chalk.yellow(`  Could not fetch initial balance`));
  }

  log(chalk.gray(`\n  Monitoring conditions... (Ctrl+C to stop)\n`));

  try {
    while (running) {
      const loopStart = Date.now();

      try {
        // Get market data
        const snapshot = await getMarketSnapshot(adapter, config.symbol);

        // Update equity
        try {
          const bal = await adapter.getBalance();
          state.equity = parseFloat(bal.equity);
          if (state.equity > state.peakEquity) state.peakEquity = state.equity;
          state.dailyPnl = state.equity - state.peakEquity; // simplified
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
            await startStrategy(adapter, config, state, snapshot, log, extraAdapters);
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
          const riskBreached = drawdown > config.risk.max_drawdown;

          if (shouldExit || riskBreached) {
            const reason = riskBreached
              ? `drawdown $${drawdown.toFixed(2)} > limit $${config.risk.max_drawdown}`
              : "exit condition met";
            log(chalk.yellow(`  ⚠ Exiting: ${reason}`));
            state.phase = "exiting";
          } else {
            // Manage running strategy
            await manageStrategy(adapter, config, state, snapshot, log, extraAdapters);
            logStatus(log, state, snapshot, "running");
          }
        }

        // ── Phase: Exiting (close everything) ──
        if (state.phase === "exiting") {
          await stopStrategy(adapter, config, state, log);
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

// ── Strategy lifecycle ──

async function startStrategy(
  adapter: ExchangeAdapter,
  config: BotConfig,
  state: BotState,
  snapshot: MarketSnapshot,
  log: BotLog,
  extraAdapters?: Map<string, ExchangeAdapter>,
) {
  const strat = config.strategy;

  if (strat.type === "grid") {
    await startGrid(adapter, config.symbol, strat, state, snapshot, log);
  } else if (strat.type === "dca") {
    state.dcaOrdersPlaced = 0;
    state.dcaLastOrder = 0;
    log(`  [DCA] Ready: ${strat.amount} ${config.symbol} every ${strat.interval_sec}s`);
  } else if (strat.type === "funding-arb") {
    state.arbRunning = true;
    state.arbPositions = 0;
    log(`  [ARB] Funding arb ready | spread >= ${strat.min_spread}% | size $${strat.size_usd}`);
    log(`  [ARB] Exchanges: ${strat.exchanges.join(", ")}`);
  }
}

async function manageStrategy(
  adapter: ExchangeAdapter,
  config: BotConfig,
  state: BotState,
  snapshot: MarketSnapshot,
  log: BotLog,
  extraAdapters?: Map<string, ExchangeAdapter>,
) {
  const strat = config.strategy;

  if (strat.type === "grid") {
    await manageGrid(adapter, config.symbol, strat, state, snapshot, log);
  } else if (strat.type === "dca") {
    await manageDCA(adapter, config.symbol, strat, state, snapshot, log);
  } else if (strat.type === "funding-arb") {
    await manageFundingArb(adapter, config.symbol, strat, state, snapshot, log, extraAdapters);
  }
}

async function stopStrategy(
  adapter: ExchangeAdapter,
  config: BotConfig,
  state: BotState,
  log: BotLog,
) {
  log(`  Cancelling all orders...`);
  try {
    await adapter.cancelAllOrders(config.symbol);
  } catch { /* best effort */ }
  state.gridOrders.clear();
}

// ── Grid strategy ──

async function startGrid(
  adapter: ExchangeAdapter,
  symbol: string,
  params: GridStrategyParams,
  state: BotState,
  snapshot: MarketSnapshot,
  log: BotLog,
) {
  // Determine price range
  if (params.range_mode === "auto") {
    const pct = params.range_pct ?? 3;
    state.gridUpper = snapshot.price * (1 + pct / 100);
    state.gridLower = snapshot.price * (1 - pct / 100);
    log(`  [GRID] Auto range: $${state.gridLower.toFixed(2)} - $${state.gridUpper.toFixed(2)} (±${pct}%)`);
  } else {
    if (!params.upper || !params.lower) throw new Error("Fixed grid requires upper and lower");
    state.gridUpper = params.upper;
    state.gridLower = params.lower;
  }

  // Set leverage
  if (params.leverage) {
    try {
      await adapter.setLeverage(symbol, params.leverage);
      log(`  [GRID] Leverage: ${params.leverage}x`);
    } catch { /* non-critical */ }
  }

  // Place grid orders
  await placeGridOrders(adapter, symbol, params, state, snapshot.price, log);
}

async function placeGridOrders(
  adapter: ExchangeAdapter,
  symbol: string,
  params: GridStrategyParams,
  state: BotState,
  currentPrice: number,
  log: BotLog,
) {
  const step = (state.gridUpper - state.gridLower) / (params.grids - 1);
  const sizePerGrid = params.size / params.grids;
  let placed = 0;

  // Cancel existing orders first
  if (state.gridOrders.size > 0) {
    try { await adapter.cancelAllOrders(symbol); } catch { /* */ }
    state.gridOrders.clear();
  }

  for (let i = 0; i < params.grids; i++) {
    const price = state.gridLower + step * i;

    // Determine side based on current price
    let side: "buy" | "sell";
    if (params.side === "long") side = "buy";
    else if (params.side === "short") side = "sell";
    else side = price < currentPrice ? "buy" : "sell";

    try {
      const result = await adapter.limitOrder(symbol, side, price.toFixed(2), String(sizePerGrid)) as Record<string, unknown>;
      const orderId = String(result?.orderId ?? result?.oid ?? result?.id ?? "");
      state.gridOrders.set(i, orderId);
      placed++;
    } catch {
      // skip failed grid line
    }
  }

  log(`  [GRID] Placed ${placed}/${params.grids} orders (step: $${step.toFixed(2)}, size: ${sizePerGrid.toFixed(6)})`);
}

async function manageGrid(
  adapter: ExchangeAdapter,
  symbol: string,
  params: GridStrategyParams,
  state: BotState,
  snapshot: MarketSnapshot,
  log: BotLog,
) {
  const step = (state.gridUpper - state.gridLower) / (params.grids - 1);
  const sizePerGrid = params.size / params.grids;

  // Check for fills
  try {
    const openOrders = await adapter.getOpenOrders();
    const openIds = new Set(
      openOrders.filter(o => o.symbol.toUpperCase() === symbol.toUpperCase()).map(o => o.orderId)
    );

    let newFills = 0;
    for (const [idx, orderId] of state.gridOrders.entries()) {
      if (!openIds.has(orderId)) {
        // Order filled — place opposite order
        newFills++;
        state.fills++;
        state.totalPnl += step * sizePerGrid;

        // Determine new side and price
        const oldPrice = state.gridLower + step * idx;
        const wasBuy = oldPrice < snapshot.price;
        const newSide: "buy" | "sell" = wasBuy ? "sell" : "buy";
        const newPrice = wasBuy ? oldPrice + step : oldPrice - step;

        if (newPrice >= state.gridLower && newPrice <= state.gridUpper) {
          try {
            const result = await adapter.limitOrder(symbol, newSide, newPrice.toFixed(2), String(sizePerGrid)) as Record<string, unknown>;
            const newOrderId = String(result?.orderId ?? result?.oid ?? result?.id ?? "");
            state.gridOrders.set(idx, newOrderId);
          } catch { /* skip */ }
        } else {
          state.gridOrders.delete(idx);
        }
      }
    }

    if (newFills > 0) {
      log(chalk.green(`  [GRID] ${newFills} fill(s) | Total: ${state.fills} | Est. PnL: $${state.totalPnl.toFixed(2)}`));
    }
  } catch { /* retry next loop */ }

  // Auto-rebalance if price exits range
  if (params.rebalance) {
    const outOfRange = snapshot.price > state.gridUpper || snapshot.price < state.gridLower;
    const cooldownOk = Date.now() - state.lastRebalance > params.rebalance_cooldown * 1000;

    if (outOfRange && cooldownOk) {
      const pct = params.range_pct ?? 3;
      state.gridUpper = snapshot.price * (1 + pct / 100);
      state.gridLower = snapshot.price * (1 - pct / 100);
      state.rebalanceCount++;
      state.lastRebalance = Date.now();

      log(chalk.yellow(`  [GRID] Rebalance #${state.rebalanceCount}: price $${snapshot.price.toFixed(2)} outside range → new $${state.gridLower.toFixed(2)} - $${state.gridUpper.toFixed(2)}`));
      await placeGridOrders(adapter, symbol, params, state, snapshot.price, log);
    }
  }
}

// ── DCA strategy ──

async function manageDCA(
  adapter: ExchangeAdapter,
  symbol: string,
  params: DCAStrategyParams,
  state: BotState,
  snapshot: MarketSnapshot,
  log: BotLog,
) {
  // Check if it's time for next order
  const timeSinceLast = (Date.now() - state.dcaLastOrder) / 1000;
  if (state.dcaLastOrder > 0 && timeSinceLast < params.interval_sec) return;

  // Check order limit
  if (params.total_orders > 0 && state.dcaOrdersPlaced >= params.total_orders) return;

  // Check price limit
  if (params.price_limit) {
    // For DCA, we assume buying — skip if price above limit
    if (snapshot.price > params.price_limit) {
      return;
    }
  }

  // Place market order
  try {
    const side: "buy" | "sell" = "buy"; // DCA is typically buying
    await adapter.marketOrder(symbol, side, String(params.amount));
    state.dcaOrdersPlaced++;
    state.dcaLastOrder = Date.now();
    state.fills++;

    const progress = params.total_orders > 0 ? ` (${state.dcaOrdersPlaced}/${params.total_orders})` : "";
    log(chalk.green(`  [DCA] Order #${state.dcaOrdersPlaced}${progress}: buy ${params.amount} ${symbol} @ $${snapshot.price.toFixed(2)}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(chalk.red(`  [DCA] Order failed: ${msg}`));
  }
}

// ── Funding Arb strategy ──

interface ArbOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longRate: number;
  shortRate: number;
  spread: number; // annualized %
}

async function fetchRatesFromAdapter(
  adapter: ExchangeAdapter,
  exchangeName: string,
): Promise<{ symbol: string; rate: number; price: number }[]> {
  try {
    const markets = await adapter.getMarkets();
    return markets.map(m => ({
      symbol: m.symbol,
      rate: parseFloat(m.fundingRate),
      price: parseFloat(m.markPrice),
    }));
  } catch {
    return [];
  }
}

async function manageFundingArb(
  adapter: ExchangeAdapter,
  symbol: string,
  params: FundingArbStrategyParams,
  state: BotState,
  _snapshot: MarketSnapshot,
  log: BotLog,
  extraAdapters?: Map<string, ExchangeAdapter>,
) {
  // Build adapter map from primary + extras
  const adapters = new Map<string, ExchangeAdapter>();
  adapters.set(adapter.name.toLowerCase(), adapter);
  if (extraAdapters) {
    for (const [name, a] of extraAdapters) adapters.set(name, a);
  }

  if (adapters.size < 2) {
    log(chalk.yellow(`  [ARB] Need 2+ exchanges, have ${adapters.size}. Skipping.`));
    return;
  }

  // Fetch rates from all exchanges
  const ratesByExchange = new Map<string, Map<string, { rate: number; price: number }>>();
  for (const [name, a] of adapters) {
    const rates = await fetchRatesFromAdapter(a, name);
    const map = new Map<string, { rate: number; price: number }>();
    for (const r of rates) map.set(r.symbol.toUpperCase(), { rate: r.rate, price: r.price });
    ratesByExchange.set(name, map);
  }

  // Find opportunities: largest spread between any two exchanges
  const exchangeNames = [...ratesByExchange.keys()];
  const opportunities: ArbOpportunity[] = [];

  // Collect all symbols
  const allSymbols = new Set<string>();
  for (const [, map] of ratesByExchange) {
    for (const sym of map.keys()) allSymbols.add(sym);
  }

  for (const sym of allSymbols) {
    let minRate = Infinity, maxRate = -Infinity;
    let minExchange = "", maxExchange = "";

    for (const exName of exchangeNames) {
      const rate = ratesByExchange.get(exName)?.get(sym)?.rate;
      if (rate === undefined) continue;
      if (rate < minRate) { minRate = rate; minExchange = exName; }
      if (rate > maxRate) { maxRate = rate; maxExchange = exName; }
    }

    if (minExchange && maxExchange && minExchange !== maxExchange) {
      const { computeAnnualSpread: cas } = await import("../funding.js");
      const spread = cas(maxRate, maxExchange, minRate, minExchange);
      if (spread >= params.min_spread) {
        opportunities.push({
          symbol: sym,
          longExchange: minExchange, // long where rate is low (we receive funding)
          shortExchange: maxExchange, // short where rate is high (we pay less or receive)
          longRate: minRate,
          shortRate: maxRate,
          spread,
        });
      }
    }
  }

  // Sort by spread descending
  opportunities.sort((a, b) => b.spread - a.spread);

  if (opportunities.length > 0) {
    const top = opportunities.slice(0, 3);
    for (const opp of top) {
      log(`  [ARB] ${opp.symbol}: ${opp.spread.toFixed(1)}% spread (long ${opp.longExchange} ${(opp.longRate * 100).toFixed(4)}% / short ${opp.shortExchange} ${(opp.shortRate * 100).toFixed(4)}%)`);
    }

    // Auto-execute if under position limit
    if (state.arbPositions < params.max_positions && opportunities.length > 0) {
      const best = opportunities[0];
      const longAdapter = adapters.get(best.longExchange);
      const shortAdapter = adapters.get(best.shortExchange);

      if (longAdapter && shortAdapter) {
        // Calculate size from USD
        const price = ratesByExchange.get(best.longExchange)?.get(best.symbol)?.price ?? 0;
        if (price > 0) {
          // Liquidity check & size adjustment
          const liq = await checkArbLiquidity(
            longAdapter, shortAdapter, best.symbol, params.size_usd, 0.5,
            (msg) => log(chalk.yellow(`  ${msg}`)),
          );
          if (!liq.viable) return;

          // Compute matched size for both legs
          const matched = computeMatchedSize(liq.adjustedSizeUsd, price, best.longExchange, best.shortExchange);
          if (!matched) {
            log(chalk.yellow(`  [ARB] Skip ${best.symbol}: can't compute matched size (min notional or precision issue)`));
            return;
          }

          try {
            log(chalk.cyan(`  [ARB] Opening: ${matched.size} ${best.symbol} on both legs ($${matched.notional.toFixed(0)}/leg, slippage ~${liq.longSlippage.toFixed(2)}%/${liq.shortSlippage.toFixed(2)}%)`));
            await Promise.all([
              longAdapter.marketOrder(best.symbol, "buy", matched.size),
              shortAdapter.marketOrder(best.symbol, "sell", matched.size),
            ]);

            // Verify fills match, correct if needed
            try {
              const recon = await reconcileArbFills(longAdapter, shortAdapter, best.symbol,
                (msg) => log(chalk.yellow(`  ${msg}`)),
              );
              if (!recon.matched) {
                log(chalk.red(`  [ARB] WARNING: fills not matched after correction attempt`));
              }
            } catch { /* non-critical */ }

            state.arbPositions++;
            state.fills += 2;
            log(chalk.green(`  [ARB] Position opened! (${state.arbPositions}/${params.max_positions})`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(chalk.red(`  [ARB] Execution failed: ${msg}`));
          }
        }
      }
    }
  } else {
    log(chalk.gray(`  [ARB] No opportunities >= ${params.min_spread}% spread`));
  }
}

// ── Utils ──

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
