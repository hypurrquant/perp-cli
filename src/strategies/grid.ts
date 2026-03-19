import type { ExchangeAdapter } from "../exchanges/index.js";
import { updateJobState } from "../jobs.js";

export interface GridParams {
  symbol: string;
  side: "long" | "short" | "neutral"; // neutral = buy below mid, sell above mid
  upperPrice: number;
  lowerPrice: number;
  grids: number;         // number of grid lines
  totalSize: number;     // total position size (base)
  leverage?: number;
  intervalSec?: number;  // how often to check & rebalance (default: 10)
  maxRuntime?: number;   // max runtime in seconds (0 = forever)
  trailingStop?: number; // % from peak equity to stop
}

export interface GridState {
  gridLines: GridLine[];
  activeOrders: Map<string, string>; // gridIndex → orderId
  fills: number;
  totalPnl: number;
  peakEquity: number;
  startedAt: number;
  running: boolean;
}

interface GridLine {
  price: number;
  side: "buy" | "sell";
  size: number;
  filled: boolean;
}

export async function runGrid(
  adapter: ExchangeAdapter,
  params: GridParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<{ fills: number; totalPnl: number; runtime: number }> {
  const { symbol, upperPrice, lowerPrice, grids, totalSize } = params;
  const intervalMs = (params.intervalSec ?? 10) * 1000;
  const maxRuntime = (params.maxRuntime ?? 0) * 1000;
  const sizePerGrid = totalSize / grids;

  if (upperPrice <= lowerPrice) throw new Error("upperPrice must be > lowerPrice");
  if (grids < 2) throw new Error("Need at least 2 grid lines");

  // Set leverage if specified
  if (params.leverage) {
    try {
      await adapter.setLeverage(symbol, params.leverage);
      log(`[GRID] Leverage set to ${params.leverage}x`);
    } catch {
      log(`[GRID] Could not set leverage (may not be supported)`);
    }
  }

  // Build grid lines
  const step = (upperPrice - lowerPrice) / (grids - 1);
  const gridLines: GridLine[] = [];
  for (let i = 0; i < grids; i++) {
    gridLines.push({
      price: lowerPrice + step * i,
      side: "buy", // will be set based on current price
      size: sizePerGrid,
      filled: false,
    });
  }

  log(`[GRID] ${symbol} ${params.side} | ${grids} grids | $${lowerPrice} - $${upperPrice} | step $${step.toFixed(2)}`);
  log(`[GRID] Size per grid: ${sizePerGrid.toFixed(6)} | Total: ${totalSize}`);

  const state: GridState = {
    gridLines,
    activeOrders: new Map(),
    fills: 0,
    totalPnl: 0,
    peakEquity: 0,
    startedAt: Date.now(),
    running: true,
  };

  // Graceful shutdown
  const shutdown = () => { state.running = false; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    // Get current price to determine buy/sell sides
    const markets = await adapter.getMarkets();
    const market = markets.find(m => m.symbol.toUpperCase() === symbol.toUpperCase());
    const currentPrice = market ? parseFloat(market.markPrice) : (upperPrice + lowerPrice) / 2;

    // Assign sides: buy below current, sell above current
    for (const line of gridLines) {
      if (params.side === "long") {
        line.side = "buy";
      } else if (params.side === "short") {
        line.side = "sell";
      } else {
        line.side = line.price < currentPrice ? "buy" : "sell";
      }
    }

    log(`[GRID] Current price: $${currentPrice.toFixed(2)} | Placing ${grids} limit orders...`);

    // Place initial grid orders
    await placeGridOrders(adapter, symbol, gridLines, state, log);

    // Main loop: monitor fills and replace orders
    while (state.running) {
      await sleep(intervalMs);

      if (maxRuntime > 0 && Date.now() - state.startedAt > maxRuntime) {
        log(`[GRID] Max runtime reached. Stopping.`);
        break;
      }

      try {
        // Check open orders
        const openOrders = await adapter.getOpenOrders();
        const openIds = new Set(openOrders.filter(o => o.symbol.toUpperCase() === symbol.toUpperCase()).map(o => o.orderId));

        // Find filled grid orders
        let newFills = 0;
        for (let i = 0; i < gridLines.length; i++) {
          const orderId = state.activeOrders.get(String(i));
          if (orderId && !openIds.has(orderId)) {
            // Order filled — flip and replace
            const line = gridLines[i];
            state.fills++;
            newFills++;
            line.filled = true;

            // Flip side: buy → sell, sell → buy (take profit at next grid)
            const newSide = line.side === "buy" ? "sell" : "buy";
            const newPrice = line.side === "buy"
              ? line.price + step  // sell one grid above
              : line.price - step; // buy one grid below

            if (newPrice >= lowerPrice && newPrice <= upperPrice) {
              try {
                const result = await adapter.limitOrder(symbol, newSide, String(newPrice.toFixed(2)), String(line.size)) as Record<string, unknown>;
                const newOrderId = String(result?.orderId ?? result?.oid ?? result?.id ?? "");
                state.activeOrders.set(String(i), newOrderId);
                line.side = newSide;
                line.price = newPrice;
                line.filled = false;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`[GRID] Replace order error: ${msg}`);
              }
            } else {
              state.activeOrders.delete(String(i));
            }
          }
        }

        if (newFills > 0) {
          // Estimate PnL from grid spacing
          state.totalPnl += newFills * step * sizePerGrid;
          log(`[GRID] ${newFills} fill(s) | Total fills: ${state.fills} | Est. PnL: $${state.totalPnl.toFixed(2)}`);
        }

        // Update job state
        if (jobId) {
          updateJobState(jobId, {
            result: {
              fills: state.fills,
              totalPnl: state.totalPnl,
              activeOrders: state.activeOrders.size,
              runtime: Math.floor((Date.now() - state.startedAt) / 1000),
            },
          });
        }

        // Trailing stop check
        if (params.trailingStop) {
          const bal = await adapter.getBalance();
          const equity = parseFloat(bal.equity);
          if (equity > state.peakEquity) state.peakEquity = equity;
          const drawdown = state.peakEquity > 0 ? ((state.peakEquity - equity) / state.peakEquity) * 100 : 0;
          if (drawdown > params.trailingStop) {
            log(`[GRID] Trailing stop triggered (${drawdown.toFixed(1)}% drawdown). Stopping.`);
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[GRID] Monitor error: ${msg}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);

    // Cancel remaining grid orders
    log(`[GRID] Cancelling remaining orders...`);
    try {
      await adapter.cancelAllOrders(symbol);
    } catch {
      // best-effort
    }
  }

  const runtime = Math.floor((Date.now() - state.startedAt) / 1000);
  log(`[GRID] Done. ${state.fills} fills, est. PnL $${state.totalPnl.toFixed(2)}, runtime ${runtime}s`);

  if (jobId) {
    updateJobState(jobId, { status: "done", result: { fills: state.fills, totalPnl: state.totalPnl, runtime } });
  }

  return { fills: state.fills, totalPnl: state.totalPnl, runtime };
}

async function placeGridOrders(
  adapter: ExchangeAdapter,
  symbol: string,
  gridLines: GridLine[],
  state: GridState,
  log: (msg: string) => void,
) {
  let placed = 0;
  for (let i = 0; i < gridLines.length; i++) {
    const line = gridLines[i];
    try {
      const result = await adapter.limitOrder(
        symbol,
        line.side,
        String(line.price.toFixed(2)),
        String(line.size),
      ) as Record<string, unknown>;

      const orderId = String(result?.orderId ?? result?.oid ?? result?.id ?? "");
      state.activeOrders.set(String(i), orderId);
      placed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[GRID] Order at $${line.price.toFixed(2)} failed: ${msg}`);
    }
  }
  log(`[GRID] Placed ${placed}/${gridLines.length} orders`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
