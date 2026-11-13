import { assertCanClosePositions } from "../exchanges/trading-v2.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { updateJobState } from "../jobs.js";
import { closePerpVerified } from "../bot/perp-order.js";
import { formatComputedPrice } from "../exchanges/precision.js";
import { alignComputedLimitPrice } from "../bot/quote-rules.js";
import { symbolMatch } from "../utils.js";
import { venueRateString } from "../utils/numeric.js";

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
  /**
   * At stop (max runtime, trailing stop, SIGINT): close the grid's own inventory — the position
   * change since the grid started — reduce-only, verified (closePerpVerified). Default false: the
   * inventory is left open and reported (warning + result.inventory).
   */
  closeOnStop?: boolean;
}

/** The grid's position change on `symbol` between start and stop (signed base: + long, − short). */
export interface GridInventory {
  /** Signed position when the grid started. */
  startSize: string;
  /** Signed position after the remaining grid orders were cancelled; null = could not be read. */
  endSize: string | null;
  /** endSize − startSize (the grid's own net fills); null when endSize is unknown. */
  gridDelta: string | null;
  /** Base closed by --close-on-stop (0 when not requested / nothing to close). */
  closed: string;
  /** Inventory still open after stop (|gridDelta| − closed); null when unknown. */
  leftOpen: string | null;
  note: string | null;
}

export interface GridState {
  gridLines: GridLine[];
  activeOrders: Map<string, string>; // gridIndex → orderId
  fills: number;
  /** Estimated PnL of COMPLETED round trips only (grid step × size per take-profit fill). */
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
  /** The line's resting order is the take-profit leg of an earlier fill (its fill completes a round trip). */
  flipped: boolean;
}

/** Signed position of `symbol` (+ long, − short, 0 none) as a decimal string. */
async function signedPosition(adapter: ExchangeAdapter, symbol: string): Promise<string> {
  const p = (await adapter.getPositions()).find(x => symbolMatch(x.symbol, symbol));
  if (p === undefined) return "0";
  const abs = p.size.replace(/^-/, "");
  return p.side === "short" ? `-${abs}` : abs;
}

export async function runGrid(
  adapter: ExchangeAdapter,
  params: GridParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<{ fills: number; totalPnl: number; runtime: number; inventory: GridInventory }> {
  assertCanClosePositions(adapter, `Grid on ${adapter.name}`);
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
      flipped: false,
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

  // Baseline position: the grid's inventory at stop is measured against it (a failed read stops here, nothing placed).
  const startSize = await signedPosition(adapter, symbol);

  // Graceful shutdown
  const shutdown = () => { state.running = false; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let roundTrips = 0;
  try {
    // Get current price to determine buy/sell sides
    const markets = await adapter.getMarkets();
    const market = markets.find(m => symbolMatch(m.symbol, symbol));
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
            if (line.flipped) roundTrips++;
            line.filled = true;

            // Flip side: buy → sell, sell → buy (take profit at next grid)
            const newSide = line.side === "buy" ? "sell" : "buy";
            const newPrice = line.side === "buy"
              ? line.price + step  // sell one grid above
              : line.price - step; // buy one grid below

            if (newPrice >= lowerPrice && newPrice <= upperPrice) {
              try {
                const result = await adapter.limitOrder(symbol, newSide, await alignComputedLimitPrice(adapter, symbol, newSide, formatComputedPrice(newPrice)), String(line.size)) as Record<string, unknown>;
                const newOrderId = String(result?.orderId ?? result?.oid ?? result?.id ?? "");
                state.activeOrders.set(String(i), newOrderId);
                line.side = newSide;
                line.price = newPrice;
                line.filled = false;
                line.flipped = !line.flipped;
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
          // Estimate PnL from grid spacing — completed round trips only (an opening fill earns nothing yet).
          state.totalPnl = roundTrips > 0 ? Number(formatComputedPrice(roundTrips * step * sizePerGrid)) : 0;
          log(`[GRID] ${newFills} fill(s) | Total fills: ${state.fills} | Round trips: ${roundTrips} | Est. PnL: $${state.totalPnl}`);
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
    } catch (e) {
      log(`[GRID] WARNING: cancelling the remaining ${symbol} orders failed (${e instanceof Error ? e.message : String(e)}) — check: perp account orders -e ${adapter.name}`);
    }
  }

  const inventory = await settleGridInventory(adapter, symbol, startSize, params.closeOnStop === true, log);

  const runtime = Math.floor((Date.now() - state.startedAt) / 1000);
  log(`[GRID] Done. ${state.fills} fills (${roundTrips} round trips), est. PnL $${state.totalPnl}, runtime ${runtime}s`);

  if (jobId) {
    updateJobState(jobId, { status: "done", result: { fills: state.fills, totalPnl: state.totalPnl, runtime, inventory } });
  }

  return { fills: state.fills, totalPnl: state.totalPnl, runtime, inventory };
}

/**
 * The grid's inventory at stop: position now − position at start. Without closeOnStop it is
 * left open and reported (WARNING). With closeOnStop the part still held in the same direction is
 * closed reduce-only (closePerpVerified); a delta the current position no longer holds (the
 * position was reduced / flipped by something else) is not closed — closing it would open a position.
 */
export async function settleGridInventory(
  adapter: ExchangeAdapter, symbol: string, startSize: string, closeOnStop: boolean, log: (msg: string) => void,
): Promise<GridInventory> {
  let endSize: string;
  try {
    endSize = await signedPosition(adapter, symbol);
  } catch (e) {
    const note = `position could not be read after stop (${e instanceof Error ? e.message : String(e)})`;
    log(`[GRID] WARNING: ${note} — the grid may have left a ${symbol} position open. Check: perp account positions -e ${adapter.name}`);
    return { startSize, endSize: null, gridDelta: null, closed: "0", leftOpen: null, note };
  }
  const dec = Math.max((startSize.split(".")[1] ?? "").length, (endSize.split(".")[1] ?? "").length);
  const delta = Number(venueRateString(Number(endSize) - Number(startSize), "grid inventory"));
  const gridDelta = delta.toFixed(dec);
  const base = { startSize, endSize, gridDelta };
  if (delta === 0) return { ...base, closed: "0", leftOpen: "0", note: null };
  const deltaAbs = Math.abs(delta).toFixed(dec);
  const dir = delta > 0 ? "long" : "short";
  if (!closeOnStop) {
    log(`[GRID] WARNING: the grid left ${deltaAbs} ${symbol} ${dir} open (position ${startSize} → ${endSize}). Close it: perp trade close ${symbol} -e ${adapter.name} (or rerun with --close-on-stop)`);
    return { ...base, closed: "0", leftOpen: deltaAbs, note: "left open (no --close-on-stop)" };
  }
  const end = Number(endSize);
  const held = Math.sign(end) === Math.sign(delta) ? Math.min(Math.abs(delta), Math.abs(end)) : 0;
  if (held === 0) {
    const note = `the position (${endSize}) no longer holds the grid's ${dir} inventory — not closed (it would open a position)`;
    log(`[GRID] WARNING: ${note}. Check: perp account positions -e ${adapter.name}`);
    return { ...base, closed: "0", leftOpen: deltaAbs, note };
  }
  const size = held.toFixed(dec);
  log(`[GRID] --close-on-stop: closing ${size} ${symbol} ${dir} (reduce-only, verified)...`);
  try {
    const c = await closePerpVerified(adapter, adapter.name, symbol, delta > 0 ? "sell" : "buy", size);
    const closed = c.closed.toFixed(dec);
    const leftOpen = Math.max(0, Math.abs(delta) - c.closed).toFixed(dec);
    if (c.residual > 0 || Number(leftOpen) > 0) {
      log(`[GRID] WARNING: closed ${closed}; ${leftOpen} ${symbol} still open${c.note !== null ? ` (${c.note})` : ""}. Check: perp account positions -e ${adapter.name}`);
    } else {
      log(`[GRID] Closed the grid inventory (${closed} ${symbol}).`);
    }
    return { ...base, closed, leftOpen, note: c.note };
  } catch (e) {
    const note = `close failed: ${e instanceof Error ? e.message : String(e)}`;
    log(`[GRID] WARNING: ${note} — ${deltaAbs} ${symbol} ${dir} may still be open. Check: perp account positions -e ${adapter.name}`);
    return { ...base, closed: "0", leftOpen: null, note };
  }
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
        await alignComputedLimitPrice(adapter, symbol, line.side, formatComputedPrice(line.price)),
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
