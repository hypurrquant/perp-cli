import type { ExchangeAdapter, ExchangePosition } from "../exchanges/interface.js";
import { getPositions, removePosition, updatePosition } from "./state.js";

export interface ReconciliationIssue {
  type: "orphan" | "phantom" | "size_mismatch";
  symbol: string;
  exchange: string;
  side: "long" | "short";
  localSize: number | null;
  exchangeSize: number | null;
  severity: "warning" | "critical";
  suggestion: string;
}

export interface ReconciliationResult {
  issues: ReconciliationIssue[];
  healthy: number;
  fixesApplied?: string[];
}

/** Normalize symbol for comparison (strip -PERP suffix, uppercase) */
function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/-PERP$/, "");
}

/** Find a matching exchange position by symbol */
function findExchangePosition(
  positions: ExchangePosition[],
  symbol: string,
  side: "long" | "short",
): ExchangePosition | undefined {
  const norm = normalizeSymbol(symbol);
  return positions.find(p => normalizeSymbol(p.symbol) === norm && p.side === side);
}

/**
 * Reconcile local arb state with actual exchange positions.
 *
 * Detects three types of issues:
 * - **Orphan**: Position exists on exchange but not in local arb state (manual entry?)
 * - **Phantom**: Position exists in local state but not on exchange (liquidated? manually closed?)
 * - **Size mismatch**: Both exist but sizes differ beyond tolerance
 */
export async function reconcileArbPositions(
  adapters: Map<string, ExchangeAdapter>,
  opts?: { fix?: boolean; tolerancePct?: number },
): Promise<ReconciliationResult> {
  const tolerancePct = opts?.tolerancePct ?? 1;
  const shouldFix = opts?.fix ?? false;
  const issues: ReconciliationIssue[] = [];
  const fixesApplied: string[] = [];
  let healthy = 0;

  const localPositions = getPositions();

  // Fetch all exchange positions
  const exchangePositions = new Map<string, ExchangePosition[]>();
  for (const [name, adapter] of adapters) {
    try {
      const pos = await adapter.getPositions();
      exchangePositions.set(name, pos);
    } catch {
      exchangePositions.set(name, []);
    }
  }

  // Track which exchange positions are accounted for
  const accountedFor = new Set<string>(); // "exchange:symbol:side"

  // Check each local arb position against exchange
  for (const arb of localPositions) {
    // Check long leg
    const longPositions = exchangePositions.get(arb.longExchange) ?? [];
    const longMatch = findExchangePosition(longPositions, arb.symbol, "long");

    if (!longMatch) {
      issues.push({
        type: "phantom",
        symbol: arb.symbol,
        exchange: arb.longExchange,
        side: "long",
        localSize: arb.longSize,
        exchangeSize: null,
        severity: "critical",
        suggestion: `Local state has long ${arb.symbol} on ${arb.longExchange} but exchange has no position. May have been liquidated or manually closed.`,
      });

      if (shouldFix) {
        removePosition(arb.symbol);
        fixesApplied.push(`Removed phantom position ${arb.symbol} (long leg missing on ${arb.longExchange})`);
        continue; // Skip short leg check since we removed the position
      }
    } else {
      accountedFor.add(`${arb.longExchange}:${normalizeSymbol(arb.symbol)}:long`);
      const exchangeSize = Math.abs(Number(longMatch.size));
      const localSize = Math.abs(arb.longSize);
      const diffPct = localSize > 0 ? (Math.abs(exchangeSize - localSize) / localSize) * 100 : 0;

      if (diffPct > tolerancePct) {
        issues.push({
          type: "size_mismatch",
          symbol: arb.symbol,
          exchange: arb.longExchange,
          side: "long",
          localSize,
          exchangeSize,
          severity: "warning",
          suggestion: `Long size mismatch: local ${localSize} vs exchange ${exchangeSize} (${diffPct.toFixed(1)}% diff). Partial fill or manual adjustment?`,
        });

        if (shouldFix) {
          updatePosition(arb.symbol, { longSize: exchangeSize });
          fixesApplied.push(`Updated ${arb.symbol} long size: ${localSize} → ${exchangeSize}`);
        }
      } else {
        healthy++;
      }
    }

    // Check short leg
    const shortPositions = exchangePositions.get(arb.shortExchange) ?? [];
    const shortMatch = findExchangePosition(shortPositions, arb.symbol, "short");

    if (!shortMatch) {
      // Don't double-report if we already removed via fix
      if (shouldFix && !getPositions().find(p => p.symbol === arb.symbol)) continue;

      issues.push({
        type: "phantom",
        symbol: arb.symbol,
        exchange: arb.shortExchange,
        side: "short",
        localSize: arb.shortSize,
        exchangeSize: null,
        severity: "critical",
        suggestion: `Local state has short ${arb.symbol} on ${arb.shortExchange} but exchange has no position. May have been liquidated or manually closed.`,
      });

      if (shouldFix) {
        removePosition(arb.symbol);
        fixesApplied.push(`Removed phantom position ${arb.symbol} (short leg missing on ${arb.shortExchange})`);
      }
    } else {
      accountedFor.add(`${arb.shortExchange}:${normalizeSymbol(arb.symbol)}:short`);
      const exchangeSize = Math.abs(Number(shortMatch.size));
      const localSize = Math.abs(arb.shortSize);
      const diffPct = localSize > 0 ? (Math.abs(exchangeSize - localSize) / localSize) * 100 : 0;

      if (diffPct > tolerancePct) {
        issues.push({
          type: "size_mismatch",
          symbol: arb.symbol,
          exchange: arb.shortExchange,
          side: "short",
          localSize,
          exchangeSize,
          severity: "warning",
          suggestion: `Short size mismatch: local ${localSize} vs exchange ${exchangeSize} (${diffPct.toFixed(1)}% diff). Partial fill or manual adjustment?`,
        });

        if (shouldFix) {
          updatePosition(arb.symbol, { shortSize: exchangeSize });
          fixesApplied.push(`Updated ${arb.symbol} short size: ${localSize} → ${exchangeSize}`);
        }
      } else {
        healthy++;
      }
    }
  }

  // Check for orphan positions (on exchange but not in local state)
  for (const [exchangeName, positions] of exchangePositions) {
    for (const pos of positions) {
      const key = `${exchangeName}:${normalizeSymbol(pos.symbol)}:${pos.side}`;
      if (!accountedFor.has(key)) {
        // Check if this exchange is used in any arb position
        const isArbExchange = localPositions.some(
          p => p.longExchange === exchangeName || p.shortExchange === exchangeName,
        );
        // Only report orphans on exchanges that are part of arb state
        if (isArbExchange || localPositions.length > 0) {
          issues.push({
            type: "orphan",
            symbol: pos.symbol,
            exchange: exchangeName,
            side: pos.side,
            localSize: null,
            exchangeSize: Math.abs(Number(pos.size)),
            severity: "warning",
            suggestion: `Position on ${exchangeName} not tracked in arb state. Manual entry or untracked strategy?`,
          });
        }
      }
    }
  }

  return {
    issues,
    healthy,
    ...(fixesApplied.length > 0 ? { fixesApplied } : {}),
  };
}
