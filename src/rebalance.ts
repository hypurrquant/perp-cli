import type { ExchangeAdapter } from "./exchanges/interface.js";

/**
 * Cross-exchange rebalancing engine.
 *
 * Checks balances across exchanges, computes a rebalancing plan,
 * and optionally executes withdraw → bridge → deposit pipeline.
 */

export interface ExchangeBalanceSnapshot {
  exchange: string;
  equity: number;
  available: number;
  marginUsed: number;
  unrealizedPnl: number;
}

export interface RebalancePlan {
  snapshots: ExchangeBalanceSnapshot[];
  totalEquity: number;
  targetPerExchange: number;
  moves: RebalanceMove[];
  summary: string;
}

export interface RebalanceMove {
  from: string;
  to: string;
  amount: number;
  reason: string;
}

import { EXCHANGE_TO_CHAIN } from "./bridge-engine.js";

// Re-export for backward compat
const EXCHANGE_CHAINS: Record<string, { chain: string }> = Object.fromEntries(
  Object.entries(EXCHANGE_TO_CHAIN).map(([ex, chain]) => [ex, { chain }]),
);

/**
 * Fetch balances from all exchanges in parallel.
 */
export async function fetchAllBalances(
  adapters: Map<string, ExchangeAdapter>,
): Promise<ExchangeBalanceSnapshot[]> {
  const entries = [...adapters.entries()];
  const results = await Promise.allSettled(
    entries.map(async ([name, adapter]) => {
      const bal = await adapter.getBalance();
      return {
        exchange: name,
        equity: Number(bal.equity),
        available: Number(bal.available),
        marginUsed: Number(bal.marginUsed),
        unrealizedPnl: Number(bal.unrealizedPnl),
      };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<ExchangeBalanceSnapshot> => r.status === "fulfilled")
    .map((r) => r.value);
}

/**
 * Compute a rebalancing plan to equalize available balance across exchanges.
 *
 * Strategy: equal-weight — target = totalAvailable / numExchanges
 * Only moves from exchanges with surplus to those with deficit.
 * Respects a minimum move threshold to avoid tiny transfers.
 */
export function computeRebalancePlan(
  snapshots: ExchangeBalanceSnapshot[],
  opts: {
    /** Minimum move amount to bother with ($) */
    minMove?: number;
    /** Target allocation weights (default: equal). Keys = exchange names, values = 0-1 weights summing to 1 */
    weights?: Record<string, number>;
    /** Reserve: keep at least this much available on each exchange */
    reserve?: number;
  } = {},
): RebalancePlan {
  const minMove = opts.minMove ?? 50;
  const reserve = opts.reserve ?? 20;
  const totalEquity = snapshots.reduce((s, e) => s + e.equity, 0);
  const totalAvailable = snapshots.reduce((s, e) => s + e.available, 0);

  // Calculate targets
  const weights = opts.weights ?? Object.fromEntries(snapshots.map((s) => [s.exchange, 1 / snapshots.length]));
  const targets = new Map<string, number>();
  for (const snap of snapshots) {
    const w = weights[snap.exchange] ?? 1 / snapshots.length;
    targets.set(snap.exchange, totalAvailable * w);
  }

  // Calculate deltas (positive = surplus, negative = deficit)
  const deltas = new Map<string, number>();
  for (const snap of snapshots) {
    const target = targets.get(snap.exchange) ?? 0;
    const movable = Math.max(0, snap.available - reserve);
    const delta = movable - Math.max(0, target - reserve);
    deltas.set(snap.exchange, delta);
  }

  // Match surplus → deficit
  const moves: RebalanceMove[] = [];
  const surpluses = [...deltas.entries()].filter(([, d]) => d > minMove).sort((a, b) => b[1] - a[1]);
  const deficits = [...deltas.entries()].filter(([, d]) => d < -minMove).sort((a, b) => a[1] - b[1]);

  for (const [fromEx, surplus] of surpluses) {
    let remaining = surplus;
    for (const deficit of deficits) {
      if (remaining < minMove) break;
      const [toEx, deficitAmt] = deficit;
      if (deficitAmt >= -minMove) continue;

      const moveAmt = Math.min(remaining, Math.abs(deficitAmt));
      if (moveAmt < minMove) continue;

      moves.push({
        from: fromEx,
        to: toEx,
        amount: Math.floor(moveAmt),
        reason: `Rebalance: ${fromEx} has $${Math.floor(surplus)} surplus, ${toEx} needs $${Math.floor(Math.abs(deficitAmt))}`,
      });

      remaining -= moveAmt;
      deficit[1] += moveAmt; // reduce deficit
    }
  }

  const summary = moves.length === 0
    ? "Balanced — no moves needed"
    : `${moves.length} move(s): ${moves.map((m) => `$${m.amount} ${m.from}→${m.to}`).join(", ")}`;

  return {
    snapshots,
    totalEquity,
    targetPerExchange: totalAvailable / snapshots.length,
    moves,
    summary,
  };
}

/**
 * Check if an exchange has enough available balance for a given trade size.
 */
export function hasEnoughBalance(
  snapshots: ExchangeBalanceSnapshot[],
  exchange: string,
  requiredUsd: number,
  marginBuffer = 1.5,
): boolean {
  const snap = snapshots.find((s) => s.exchange === exchange);
  if (!snap) return false;
  return snap.available >= requiredUsd * marginBuffer;
}

/**
 * Get the chain/bridge info for an exchange.
 */
export function getExchangeChain(exchange: string) {
  return EXCHANGE_CHAINS[exchange];
}

/**
 * Describe the bridge route for a rebalance move.
 */
export function describeBridgeRoute(move: RebalanceMove): string {
  const from = EXCHANGE_CHAINS[move.from];
  const to = EXCHANGE_CHAINS[move.to];
  if (!from || !to) return `${move.from} → ${move.to} (unknown route)`;

  if (from.chain === to.chain) return `Internal transfer on ${from.chain}`;

  // All cross-chain moves go through USDC bridging
  const steps: string[] = [];
  steps.push(`1. Withdraw $${move.amount} USDC from ${move.from} (${from.chain})`);

  // Determine bridge method
  if (from.chain === "solana" || to.chain === "solana") {
    steps.push(`2. Bridge via CCTP/Wormhole (${from.chain} → ${to.chain})`);
  } else {
    steps.push(`2. Bridge via CCTP (${from.chain} → ${to.chain})`);
  }

  steps.push(`3. Deposit into ${move.to} (${to.chain})`);

  return steps.join("\n    ");
}

/**
 * Estimate total time for a rebalance move.
 */
export function estimateMoveTime(move: RebalanceMove): string {
  const from = EXCHANGE_CHAINS[move.from]?.chain;
  const to = EXCHANGE_CHAINS[move.to]?.chain;

  // Withdrawal times
  const withdrawTime: Record<string, string> = {
    pacifica: "~10s",
    hyperliquid: "~5min",
    lighter: "~12h (standard)",
  };

  // Bridge times
  let bridgeTime = "~1-3min (CCTP)";
  if (from === "solana" || to === "solana") {
    bridgeTime = "~15min (Wormhole/CCTP)";
  }

  return `Withdraw: ${withdrawTime[move.from] ?? "?"} → Bridge: ${bridgeTime} → Deposit: ~1min`;
}
