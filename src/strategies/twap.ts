import { assertCanClosePositions } from "../exchanges/trading-v2.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { resolveAdapterSlippage } from "../exchanges/slippage.js";
import { updateJobState } from "../jobs.js";
import { reportedAvgFillPrice } from "../exchanges/ioc-outcome.js";
import { filledOf } from "../bot/fill-size.js";
import { isOutcomeUnknown } from "../bot/perp-order.js";
import { pendingStop } from "./pending-stop.js";
import { PerpError } from "../errors.js";
import { floorToStep, formatComputedPrice, lotStepOf } from "../exchanges/precision.js";

export interface TWAPParams {
  symbol: string;
  side: "buy" | "sell";
  totalSize: number;
  durationSec: number;
  slices?: number;       // default: duration / 30 (one slice every 30s)
  maxSlippage?: number;  // % slippage tolerance per slice, default 1
  reduceOnly?: boolean;
}

export interface TWAPState {
  filled: number;
  remaining: number;
  slicesDone: number;
  totalSlices: number;
  /**
   * Size-weighted average of the venue-reported FILL prices of the slices; null while any
   * filled slice has no reported fill price (never the limit / slippage-protection price).
   */
  avgPrice: number | null;
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
  let step: string;
  try {
    assertCanClosePositions(adapter, `TWAP on ${adapter.name}`);
    // Every slice is on the market's lot grid: an off-step quantity is a definite venue refusal
    // (Aster sends the quantity as is). Unknown lot, or a slice below one lot → refused up front.
    try {
      step = await lotStepOf(adapter, params.symbol);
    } catch (e) {
      // A reduce-only run on a market left out of the market list (e.g. a delisted one): the
      // position can still be closed directly.
      if (params.reduceOnly === true && e instanceof PerpError && e.structured.code === "SYMBOL_NOT_FOUND") {
        throw new PerpError("SYMBOL_NOT_FOUND", `${e.message}; nothing was sent`, {
          exchange: adapter.name, remediation: `Close the position directly: perp -e ${adapter.name} trade close ${params.symbol}`,
        });
      }
      throw e;
    }
    if (!(Number(floorToStep(sliceSize, step)) > 0)) {
      throw new PerpError("SIZE_TOO_SMALL", `TWAP ${params.totalSize} ${params.symbol} in ${totalSlices} slices is below the lot ${step} per slice; nothing was sent`, {
        exchange: adapter.name, remediation: `Use fewer slices or a larger size: every slice must be at least one lot (${step})`,
      });
    }
  } catch (e) {
    // Refused before any order: the job is an error (never left to read as "done").
    if (jobId) updateJobState(jobId, { status: "error", result: { error: e instanceof Error ? e.message : String(e) } });
    throw e;
  }

  const state: TWAPState = {
    filled: 0,
    remaining: params.totalSize,
    slicesDone: 0,
    totalSlices,
    avgPrice: null,
    errors: 0,
    startedAt: Date.now(),
    lastSliceAt: 0,
  };

  log(`[TWAP] ${params.side.toUpperCase()} ${params.totalSize} ${params.symbol} over ${params.durationSec}s`);
  log(`[TWAP] ${totalSlices} slices, ${sliceSize.toFixed(6)} per slice, ${(intervalMs / 1000).toFixed(1)}s interval`);
  log(`[TWAP] Exchange: ${adapter.name}`);

  let totalCost = 0;
  let everySlicePriced = true;
  /** Set when a slice's outcome / fill is unknown: the run stops and surfaces ORDER_PENDING. */
  let pending: PerpError | null = null;

  for (let i = 0; i < totalSlices; i++) {
    if (i > 0) {
      await sleep(intervalMs);
    }

    // An equal share of what is left, floored to the lot: the flooring remainder (and a refused
    // slice) is carried to the later slices; the last one sends all that is left on the grid.
    const sliceStr = floorToStep(state.remaining / (totalSlices - i), step);
    const thisSlice = Number(sliceStr);

    if (!(thisSlice > 0)) break;

    try {
      log(`[TWAP] Slice ${i + 1}/${totalSlices}: ${params.side} ${thisSlice.toFixed(6)} ${params.symbol}...`);

      const result = await adapter.marketOrder(
        params.symbol,
        params.side,
        sliceStr,
        { reduceOnly: params.reduceOnly === true, slippage: resolveAdapterSlippage(adapter, null) },
      );

      // The venue-reported fill (IOC outcome / OrderResult.filledSize) — never the slice requested.
      const sliceFilled = filledOf(adapter, result);
      if (sliceFilled === null) {
        pending = pendingStop("twap", adapter, params.symbol, `TWAP slice ${i + 1}/${totalSlices} ${params.side} ${thisSlice.toFixed(6)} ${params.symbol} on ${adapter.name}: accepted but the venue reported no fill size`, log);
        break;
      }
      state.slicesDone++;
      state.filled += sliceFilled;
      state.remaining = params.totalSize - state.filled;
      state.lastSliceAt = Date.now();

      // The venue-reported fill price only: the result's `price` is the protection price that was sent.
      const fillPrice = reportedAvgFillPrice(result);
      if (fillPrice === null) everySlicePriced = false;
      else totalCost += sliceFilled * Number(fillPrice);
      state.avgPrice = everySlicePriced && state.filled > 0 ? Number(formatComputedPrice(totalCost / state.filled)) : null;

      const pct = ((state.filled / params.totalSize) * 100).toFixed(1);
      log(`[TWAP] Filled ${state.filled.toFixed(6)}/${params.totalSize} (${pct}%)${state.avgPrice !== null ? ` avg $${state.avgPrice}` : ""}`);

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
      const msg = err instanceof Error ? err.message : String(err);
      if (isOutcomeUnknown(err)) {
        // Unknown outcome: never resubmitted — the run stops and the symbol is quarantined.
        pending = pendingStop("twap", adapter, params.symbol, `TWAP slice ${i + 1}/${totalSlices} ${params.side} ${thisSlice.toFixed(6)} ${params.symbol} on ${adapter.name}: outcome unknown (${msg})`, log);
        break;
      }
      state.errors++;
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

  // Refused slices that left at least one lot untraded: a failed run (an error carrying the run), never a success.
  const unfilled = floorToStep(state.remaining, step);
  const failure = pending ?? (state.errors > 0 && Number(unfilled) > 0
    ? new PerpError(state.filled > 0 ? "ORDER_PARTIAL" : "ORDER_REJECTED", `TWAP ${params.side} ${params.totalSize} ${params.symbol} on ${adapter.name}: ${state.errors} slice(s) refused, ${unfilled} not traded`, {
      exchange: adapter.name, twap: { ...state }, remediation: `Check the ${params.symbol} position (perp -e ${adapter.name} account positions) before trading the rest`,
    })
    : null);
  if (failure !== null) {
    if (jobId) updateJobState(jobId, { status: "error", result: { ...state, error: failure.message } as unknown as Record<string, unknown> });
    throw failure;
  }

  if (jobId) {
    updateJobState(jobId, { status: "done", result: { ...state } as unknown as Record<string, unknown> });
  }

  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
