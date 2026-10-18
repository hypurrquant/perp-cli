import type { ExchangeAdapter } from "./exchanges/index.js";
import { PerpError } from "./errors.js";
import { getVenue, tryResolveVenueId } from "./exchanges/venue.js";
import "./exchanges/venues/index.js";

/** Settlement chains with no withdraw → bridge → deposit route in this CLI. */
const NO_ROUTE_CHAINS = new Set(["robinhood", "offchain"]);

/** Throws NO_BRIDGE_ROUTE when the venue's funds live where no bridge route exists. */
export function assertBridgeRoute(exchange: string): void {
  const id = tryResolveVenueId(exchange);
  if (id === null) return; // not a venue name — the existing "unknown route" handling applies
  const def = getVenue(id);
  const chain = def.networks.mainnet.settlementChain;
  if (NO_ROUTE_CHAINS.has(chain)) {
    throw new PerpError("NO_BRIDGE_ROUTE", `${def.displayName} settles on "${chain}"; cross-venue rebalancing has no route there`, {
      remediation: `Exclude ${def.id} from --exchanges and move funds for it manually`,
    });
  }
}

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

/** A venue whose balance could not be read (left out of the snapshots). */
export interface BalanceReadFailure {
  exchange: string;
  error: string;
}

/**
 * Fetch balances from all exchanges in parallel. Venues whose read failed are warned on
 * stderr and left out; callers that must know which (plan / execute) use fetchBalancesWithFailures.
 */
export async function fetchAllBalances(
  adapters: Map<string, ExchangeAdapter>,
): Promise<ExchangeBalanceSnapshot[]> {
  const { snapshots, failed, notConfigured } = await fetchBalancesWithFailures(adapters);
  for (const f of failed) process.stderr.write(`[warn] ${f.exchange} balance unavailable (left out): ${f.error}\n`);
  for (const n of notConfigured) process.stderr.write(`[info] ${n} not configured (no credentials) — left out\n`);
  return snapshots;
}

/**
 * Fetch balances from all exchanges in parallel; a venue whose read failed (error, empty or
 * non-finite field) is returned in `failed` — never dropped silently, never counted as $0.
 * A read-only adapter (no credentials: `isReadOnly`) cannot hold funds the CLI trades, so it
 * is not read and is returned in `notConfigured` — not a failure.
 */
export async function fetchBalancesWithFailures(
  adapters: Map<string, ExchangeAdapter>,
): Promise<{ snapshots: ExchangeBalanceSnapshot[]; failed: BalanceReadFailure[]; notConfigured: string[] }> {
  const notConfigured = [...adapters.entries()].filter(([, a]) => isReadOnlyAdapter(a)).map(([n]) => n);
  const entries = [...adapters.entries()].filter(([, a]) => !isReadOnlyAdapter(a));
  const results = await Promise.allSettled(
    entries.map(async ([name, adapter]) => {
      const bal = await adapter.getBalance();
      // Strict policy (qa/2026-05-16): empty string is corruption, not
      // "venue stringified zero". A truly absent field must surface as
      // undefined/null at the adapter layer, not "". An empty string here
      // would coerce to 0 via Number("") and silently propagate a $0
      // balance into the plan — exactly the Rule #2 silent-substitution
      // hole this audit cycle is closing.
      if (bal.equity === "" || bal.available === "" || bal.marginUsed === "" || bal.unrealizedPnl === "") {
        throw new PerpError(
          "EXCHANGE_ERROR",
          `${name} returned empty-string balance field: equity="${bal.equity}" available="${bal.available}" marginUsed="${bal.marginUsed}" unrealizedPnl="${bal.unrealizedPnl}"`,
          { exchange: name },
        );
      }
      const equity = Number(bal.equity);
      const available = Number(bal.available);
      const marginUsed = Number(bal.marginUsed);
      const unrealizedPnl = Number(bal.unrealizedPnl);
      // Rule #2: rebalance plan computes sums and per-exchange targets.
      // A NaN value would silently propagate into the plan output and the
      // execute step would attempt nonsense moves. Reject upfront so the
      // affected exchange falls out of `Promise.allSettled` (filtered to
      // fulfilled below) and the user sees a partial result instead of a
      // corrupt plan.
      if (!Number.isFinite(equity) || !Number.isFinite(available) ||
          !Number.isFinite(marginUsed) || !Number.isFinite(unrealizedPnl)) {
        throw new PerpError(
          "EXCHANGE_ERROR",
          `${name} returned non-finite balance: equity=${bal.equity} available=${bal.available} marginUsed=${bal.marginUsed} unrealizedPnl=${bal.unrealizedPnl}`,
          { exchange: name },
        );
      }
      return {
        exchange: name,
        equity,
        available,
        marginUsed,
        unrealizedPnl,
      };
    }),
  );

  const snapshots: ExchangeBalanceSnapshot[] = [];
  const failed: BalanceReadFailure[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") snapshots.push(r.value);
    else failed.push({ exchange: entries[i][0], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { snapshots, failed, notConfigured };
}

/** An adapter built without credentials (read-only market data) — `isReadOnly` on the venue adapters. */
export function isReadOnlyAdapter(a: ExchangeAdapter): boolean {
  return (a as { isReadOnly?: unknown }).isReadOnly === true;
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

      assertBridgeRoute(fromEx);
      assertBridgeRoute(toEx);
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
 * Headroom over the initial margin an arb leg needs before it is entered: covers taker fees,
 * the slippage bound on the market entry, venue margin rounding and a mark move before the
 * second leg fills (the leg must not be at maintenance margin right after entry).
 */
export const ARB_MARGIN_BUFFER = 1.5;

/**
 * Margin a leg of `notionalUsd` needs at `leverage` (the leverage the venue applies to the market
 * — the arb does not change it), × ARB_MARGIN_BUFFER. Leverage unknown (null: the venue exposes no
 * per-market setting) → the 1x requirement (the full notional): the most margin any leverage can
 * need, so the check never under-states it.
 */
export function requiredArbMargin(notionalUsd: number, leverage: number | null, buffer = ARB_MARGIN_BUFFER): number {
  const lev = leverage !== null && Number.isFinite(leverage) && leverage >= 1 ? leverage : 1;
  return (notionalUsd / lev) * buffer;
}

/**
 * Check if an exchange has enough available balance to open a leg of `notionalUsd` at
 * `leverage` (requiredArbMargin). No balance snapshot for the exchange → false.
 */
export function hasEnoughBalance(
  snapshots: ExchangeBalanceSnapshot[],
  exchange: string,
  notionalUsd: number,
  leverage: number | null,
  marginBuffer = ARB_MARGIN_BUFFER,
): boolean {
  const snap = snapshots.find((s) => s.exchange === exchange);
  if (!snap) return false;
  return snap.available >= requiredArbMargin(notionalUsd, leverage, marginBuffer);
}

/**
 * The leverage `adapter` applies to `symbol`: adapter.marketLeverage(symbol) where the venue has a
 * per-symbol read (Hyperliquid activeAssetData, Pacifica /account/settings), else the
 * adapter.getMarketSettings() row (Aster, Lighter, Arcus). null when neither lists the symbol;
 * a failed read throws.
 */
export async function marketLeverageOf(adapter: object, symbol: string): Promise<number | null> {
  const one = (adapter as { marketLeverage?: (s: string) => Promise<number> }).marketLeverage;
  if (typeof one === "function") return one.call(adapter, symbol);
  const read = (adapter as { getMarketSettings?: () => Promise<Array<{ symbol: string; leverage: number }>> }).getMarketSettings;
  if (typeof read !== "function") return null;
  const norm = (x: string) => x.toUpperCase().replace(/-PERP$/, "").replace(/^[^:]+:/, "");
  const row = (await read.call(adapter)).find(r => norm(r.symbol) === norm(symbol));
  return row !== undefined && row.leverage >= 1 ? row.leverage : null;
}

/**
 * Describe the bridge route for a rebalance move.
 */
export function describeBridgeRoute(move: RebalanceMove): string {
  assertBridgeRoute(move.from);
  assertBridgeRoute(move.to);
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
