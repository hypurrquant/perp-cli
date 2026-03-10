import type { ExchangeAdapter } from "../exchanges/interface.js";
import { updateJobState } from "../jobs.js";
import { logExecution } from "../execution-log.js";

export interface TrailingStopParams {
  symbol: string;
  trailPct: number;         // e.g. 3 = close when price moves 3% from peak/trough
  intervalSec?: number;     // check interval (default: 5)
  activationPrice?: number; // only start trailing after reaching this price
}

export interface TrailingStopResult {
  triggered: boolean;
  reason: "triggered" | "cancelled" | "no_position";
  peakPrice?: number;
  triggerPrice?: number;
  changePct?: number;
  positionSide?: string;
  runtime: number; // seconds
}

export async function runTrailingStop(
  adapter: ExchangeAdapter,
  params: TrailingStopParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<TrailingStopResult> {
  const { symbol, trailPct } = params;
  const intervalMs = (params.intervalSec ?? 5) * 1000;
  const activationPrice = params.activationPrice;
  const startedAt = Date.now();

  // Auto-detect position side
  const positions = await adapter.getPositions();
  const pos = positions.find(p => {
    const c = p.symbol.toUpperCase();
    const t = symbol.toUpperCase();
    return c === t || c === `${t}-PERP` || c.replace(/-PERP$/, "") === t;
  });

  if (!pos) {
    log(`[TRAIL] No open position for ${symbol}. Exiting.`);
    return { triggered: false, reason: "no_position", runtime: 0 };
  }

  const positionSide = pos.side;
  const closeSide: "buy" | "sell" = positionSide === "long" ? "sell" : "buy";
  const posSize = pos.size;

  log(`[TRAIL] ${symbol} ${positionSide} ${posSize} | Trail: ${trailPct}%${activationPrice ? ` | Activation: $${activationPrice}` : ""}`);

  let peakPrice = 0;
  let activated = !activationPrice;
  let running = true;

  const cleanup = () => { running = false; };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (jobId) {
    updateJobState(jobId, {
      status: "running",
      result: { symbol, positionSide, trailPct, activationPrice },
    });
  }

  try {
    while (running) {
      const markets = await adapter.getMarkets();
      const market = markets.find(m => {
        const c = m.symbol.toUpperCase();
        const t = symbol.toUpperCase();
        return c === t || c === `${t}-PERP` || c.replace(/-PERP$/, "") === t;
      });

      if (!market) {
        log(`[TRAIL] Market data for ${symbol} not found, retrying...`);
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }

      const currentPrice = parseFloat(market.markPrice);

      // Check activation
      if (!activated && activationPrice) {
        if (positionSide === "long" && currentPrice >= activationPrice) {
          activated = true;
          log(`[TRAIL] Activated at $${currentPrice.toFixed(2)} (>= $${activationPrice})`);
        } else if (positionSide === "short" && currentPrice <= activationPrice) {
          activated = true;
          log(`[TRAIL] Activated at $${currentPrice.toFixed(2)} (<= $${activationPrice})`);
        } else {
          log(`[TRAIL] $${currentPrice.toFixed(2)} | Waiting for activation ($${activationPrice})...`);
          await new Promise(r => setTimeout(r, intervalMs));
          continue;
        }
      }

      if (positionSide === "long") {
        if (currentPrice > peakPrice) peakPrice = currentPrice;
        const dropPct = peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice) * 100 : 0;
        log(`[TRAIL] $${currentPrice.toFixed(2)} | Peak: $${peakPrice.toFixed(2)} | Drop: ${dropPct.toFixed(2)}%`);

        if (dropPct >= trailPct) {
          log(`[TRAIL] TRIGGERED! Price dropped ${dropPct.toFixed(2)}% from peak $${peakPrice.toFixed(2)}`);
          log(`[TRAIL] Closing ${positionSide} ${posSize} ${symbol}...`);
          await adapter.marketOrder(symbol, closeSide, posSize);
          logExecution({
            type: "market_order", exchange: adapter.name, symbol,
            side: closeSide, size: posSize, status: "success", dryRun: false,
            meta: { action: "trailing-stop", trailPct, peakPrice, triggerPrice: currentPrice },
          });
          return {
            triggered: true, reason: "triggered",
            peakPrice, triggerPrice: currentPrice, changePct: dropPct,
            positionSide, runtime: (Date.now() - startedAt) / 1000,
          };
        }
      } else {
        // Short: track trough, trigger on rise
        if (peakPrice === 0 || currentPrice < peakPrice) peakPrice = currentPrice;
        const risePct = peakPrice > 0 ? ((currentPrice - peakPrice) / peakPrice) * 100 : 0;
        log(`[TRAIL] $${currentPrice.toFixed(2)} | Trough: $${peakPrice.toFixed(2)} | Rise: ${risePct.toFixed(2)}%`);

        if (risePct >= trailPct) {
          log(`[TRAIL] TRIGGERED! Price rose ${risePct.toFixed(2)}% from trough $${peakPrice.toFixed(2)}`);
          log(`[TRAIL] Closing ${positionSide} ${posSize} ${symbol}...`);
          await adapter.marketOrder(symbol, closeSide, posSize);
          logExecution({
            type: "market_order", exchange: adapter.name, symbol,
            side: closeSide, size: posSize, status: "success", dryRun: false,
            meta: { action: "trailing-stop", trailPct, troughPrice: peakPrice, triggerPrice: currentPrice },
          });
          return {
            triggered: true, reason: "triggered",
            peakPrice, triggerPrice: currentPrice, changePct: risePct,
            positionSide, runtime: (Date.now() - startedAt) / 1000,
          };
        }
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }
  } finally {
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
  }

  return {
    triggered: false, reason: "cancelled",
    peakPrice: peakPrice || undefined,
    positionSide,
    runtime: (Date.now() - startedAt) / 1000,
  };
}
