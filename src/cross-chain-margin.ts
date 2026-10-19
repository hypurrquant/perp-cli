/**
 * Cross-chain margin monitoring and dynamic auto-sizing.
 *
 * Provides:
 * - Per-exchange margin status checking
 * - Auto-size computation based on orderbook depth and margin limits
 */

import type { ExchangeAdapter } from "./exchanges/index.js";
import { computeExecutableSize } from "./liquidity.js";
import { loadRiskLimits } from "./risk.js";

// ── Cross-Chain Margin Monitoring ──

export interface ChainMarginStatus {
  exchange: string;
  chain: string; // "arbitrum" | "solana" | "hyperliquid"
  equity: number;
  usedMargin: number;
  freeMargin: number;
  marginRatio: number; // percent (equity / usedMargin * 100, or 100 if no margin used)
  belowThreshold: boolean;
}

const EXCHANGE_CHAIN_MAP: Record<string, string> = {
  lighter: "arbitrum",
  pacifica: "solana",
  hyperliquid: "hyperliquid",
};

/** A venue whose margin could not be read: UNKNOWN (never healthy) — callers block new entries on it. */
export interface ChainMarginUnknown {
  exchange: string;
  error: string;
}

export interface ChainMarginCheck {
  statuses: ChainMarginStatus[];
  /** Venues whose balance read failed / returned non-numeric values (margin unknown). */
  unknown: ChainMarginUnknown[];
}

/**
 * Check margin status across all configured exchanges.
 *
 * @param adapters - Map of exchange name to adapter
 * @param minMarginPct - Warn when free margin / equity falls below this (default: 30%)
 * @returns Per-exchange margin status, plus every venue whose margin is unknown (a failed
 *          read is reported there — never dropped, so it can still block entries)
 */
export async function checkChainMargins(
  adapters: Map<string, ExchangeAdapter>,
  minMarginPct: number = 30,
): Promise<ChainMarginCheck> {
  const entries = [...adapters.entries()];
  const results = await Promise.allSettled(
    entries.map(async ([name, adapter]): Promise<ChainMarginStatus> => {
      const bal = await adapter.getBalance();
      const equity = Number(bal.equity);
      const usedMargin = Number(bal.marginUsed);
      if (!Number.isFinite(equity) || !Number.isFinite(usedMargin)) {
        throw new Error(`balance returned non-numeric equity/marginUsed (${String(bal.equity)}/${String(bal.marginUsed)})`);
      }
      const freeMargin = equity - usedMargin;

      // marginRatio = (freeMargin / equity) * 100
      // If equity is 0, ratio is 0 (critical). If no margin used, ratio is 100.
      const marginRatio = equity > 0 ? (freeMargin / equity) * 100 : 0;

      return {
        exchange: name,
        chain: EXCHANGE_CHAIN_MAP[name.toLowerCase()] ?? "unknown",
        equity,
        usedMargin,
        freeMargin,
        marginRatio,
        belowThreshold: marginRatio < minMarginPct,
      };
    }),
  );

  const statuses: ChainMarginStatus[] = [];
  const unknown: ChainMarginUnknown[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") statuses.push(r.value);
    else unknown.push({ exchange: entries[i][0], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { statuses, unknown };
}

/**
 * Check if a specific exchange has critically low margin (below 15%).
 */
export function isCriticalMargin(status: ChainMarginStatus): boolean {
  return status.marginRatio < 15;
}

/**
 * Check if a specific exchange should block new entries (below threshold).
 */
export function shouldBlockEntries(status: ChainMarginStatus, minMarginPct: number = 30): boolean {
  return status.marginRatio < minMarginPct;
}

/** Why new entries on a venue are blocked this cycle (closing / reducing stays allowed). */
export interface MarginEntryBlock {
  exchange: string;
  level: "critical" | "low" | "unknown";
  /** null when the margin is unknown */
  marginPct: number | null;
  /** Threshold breached; null when unknown */
  threshold: number | null;
  /** Read error when unknown */
  error?: string;
}

/**
 * Entry blocks from a margin check: critical (<15%), low (< minMarginPct), and UNKNOWN
 * (failed read — never treated as healthy, so new entries are blocked on it too).
 */
export function marginEntryBlocks(check: ChainMarginCheck, minMarginPct: number = 30): MarginEntryBlock[] {
  const out: MarginEntryBlock[] = [];
  for (const ms of check.statuses) {
    if (isCriticalMargin(ms)) out.push({ exchange: ms.exchange, level: "critical", marginPct: ms.marginRatio, threshold: 15 });
    else if (shouldBlockEntries(ms, minMarginPct)) out.push({ exchange: ms.exchange, level: "low", marginPct: ms.marginRatio, threshold: minMarginPct });
  }
  for (const u of check.unknown) out.push({ exchange: u.exchange, level: "unknown", marginPct: null, threshold: null, error: u.error });
  return out;
}

// ── Dynamic Auto-Sizing ──

/**
 * Compute the optimal position size automatically based on:
 * 1. Orderbook depth on both sides
 * 2. Free margin constraints (max 50% per trade)
 * 3. Risk config maxPositionUsd
 *
 * @param longAdapter - Adapter for the long side exchange
 * @param shortAdapter - Adapter for the short side exchange
 * @param symbol - Trading symbol
 * @param maxSlippagePct - Max acceptable slippage (default: 0.3%)
 * @returns USD size per leg, or 0 if not viable
 */
export async function computeAutoSize(
  longAdapter: ExchangeAdapter,
  shortAdapter: ExchangeAdapter,
  symbol: string,
  maxSlippagePct: number = 0.3,
  /** The short venue's own symbol when it differs (kPEPE ↔ 1000PEPE); default `symbol`. */
  shortSymbol: string = symbol,
): Promise<number> {
  // Step 1: Get orderbooks from both sides
  const [longOB, shortOB, longBal, shortBal] = await Promise.all([
    longAdapter.getOrderbook(symbol),
    shortAdapter.getOrderbook(shortSymbol),
    longAdapter.getBalance(),
    shortAdapter.getBalance(),
  ]);

  // Step 2: Compute executable size on each side
  // For long entry we consume asks, for short entry we consume bids
  // Use a large requested size to discover the full depth available
  const probeSize = 1_000_000; // $1M probe to find max depth
  const longCheck = computeExecutableSize(longOB.asks, probeSize, maxSlippagePct);
  const shortCheck = computeExecutableSize(shortOB.bids, probeSize, maxSlippagePct);

  // Step 3: Take the minimum of both sides (in USD)
  const longMaxUsd = longCheck.maxSize * longCheck.avgFillPrice;
  const shortMaxUsd = shortCheck.maxSize * shortCheck.avgFillPrice;
  let sizeUsd = Math.min(longMaxUsd, shortMaxUsd);

  if (sizeUsd <= 0) return 0;

  // Step 4: Cap at 50% of free margin on either exchange
  const longEquity = Number(longBal.equity);
  const longUsed = Number(longBal.marginUsed);
  const longFree = longEquity - longUsed;

  const shortEquity = Number(shortBal.equity);
  const shortUsed = Number(shortBal.marginUsed);
  const shortFree = shortEquity - shortUsed;

  const maxByMargin = Math.min(longFree, shortFree) * 0.5;
  if (maxByMargin > 0) {
    sizeUsd = Math.min(sizeUsd, maxByMargin);
  }

  // Step 5: Cap at maxPositionUsd from risk config
  const riskLimits = loadRiskLimits();
  sizeUsd = Math.min(sizeUsd, riskLimits.maxPositionUsd);

  // Round to nearest dollar
  return Math.floor(sizeUsd);
}
