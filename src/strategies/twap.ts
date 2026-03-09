import type { ExchangeAdapter } from "../exchanges/interface.js";
import { updateJobState } from "../jobs.js";

export interface TWAPParams {
  symbol: string;
  side: "buy" | "sell";
  totalSize: number;
  durationSec: number;
  slices?: number;       // default: duration / 30 (one slice every 30s)
  maxSlippage?: number;  // % slippage tolerance per slice, default 1
}

export interface TWAPState {
  filled: number;
  remaining: number;
  slicesDone: number;
  totalSlices: number;
  avgPrice: number;
  errors: number;
  startedAt: number;
  lastSliceAt: number;
}

export async function runTWAP(
  adapter: ExchangeAdapter,
  params: TWAPParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<TWAPState> {
  const totalSlices = params.slices || Math.max(Math.floor(params.durationSec / 30), 2);
  const sliceSize = params.totalSize / totalSlices;
  const intervalMs = (params.durationSec * 1000) / totalSlices;

  const state: TWAPState = {
    filled: 0,
    remaining: params.totalSize,
    slicesDone: 0,
    totalSlices,
    avgPrice: 0,
    errors: 0,
    startedAt: Date.now(),
    lastSliceAt: 0,
  };

  log(`[TWAP] ${params.side.toUpperCase()} ${params.totalSize} ${params.symbol} over ${params.durationSec}s`);
  log(`[TWAP] ${totalSlices} slices, ${sliceSize.toFixed(6)} per slice, ${(intervalMs / 1000).toFixed(1)}s interval`);
  log(`[TWAP] Exchange: ${adapter.name}`);

  let totalCost = 0;

  for (let i = 0; i < totalSlices; i++) {
    if (i > 0) {
      await sleep(intervalMs);
    }

    const thisSlice = i === totalSlices - 1
      ? state.remaining  // Last slice: fill whatever remains (avoid rounding dust)
      : sliceSize;

    if (thisSlice <= 0) break;

    try {
      log(`[TWAP] Slice ${i + 1}/${totalSlices}: ${params.side} ${thisSlice.toFixed(6)} ${params.symbol}...`);

      const result = await adapter.marketOrder(
        params.symbol,
        params.side,
        String(thisSlice),
      ) as Record<string, unknown>;

      state.slicesDone++;
      state.filled += thisSlice;
      state.remaining = params.totalSize - state.filled;
      state.lastSliceAt = Date.now();

      // Try to extract fill price from result
      const fillPrice = Number(result?.price ?? result?.avg_price ?? result?.fill_price ?? 0);
      if (fillPrice > 0) {
        totalCost += thisSlice * fillPrice;
        state.avgPrice = totalCost / state.filled;
      }

      const pct = ((state.filled / params.totalSize) * 100).toFixed(1);
      log(`[TWAP] Filled ${state.filled.toFixed(6)}/${params.totalSize} (${pct}%)${state.avgPrice > 0 ? ` avg $${state.avgPrice.toFixed(4)}` : ""}`);

      // Update job state file if running as background job
      if (jobId) {
        updateJobState(jobId, {
          result: {
            filled: state.filled,
            remaining: state.remaining,
            slicesDone: state.slicesDone,
            totalSlices: state.totalSlices,
            avgPrice: state.avgPrice,
            pctComplete: parseFloat(pct),
          },
        });
      }
    } catch (err) {
      state.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`[TWAP] Slice ${i + 1} error: ${msg}`);

      // Continue — don't abort the whole TWAP for one failed slice
      if (state.errors > totalSlices * 0.5) {
        log(`[TWAP] Too many errors (${state.errors}/${totalSlices}), aborting.`);
        break;
      }
    }
  }

  const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1);
  log(`[TWAP] Complete. Filled ${state.filled.toFixed(6)} in ${elapsed}s, ${state.errors} errors.`);

  if (jobId) {
    updateJobState(jobId, { status: "done", result: { ...state } as unknown as Record<string, unknown> });
  }

  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
