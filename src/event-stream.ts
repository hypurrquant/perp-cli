/**
 * Unified event streaming for agent consumption.
 *
 * Streams normalized account events as NDJSON (one JSON per line).
 * Uses poll-based diffing for cross-exchange compatibility.
 */

import type {
  ExchangeAdapter,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
} from "./exchanges/index.js";

export type EventType =
  | "position_opened" | "position_closed" | "position_updated"
  | "order_placed" | "order_filled" | "order_cancelled"
  | "balance_update"
  | "liquidation_warning" | "margin_call"
  | "heartbeat" | "error";

export interface StreamEvent {
  type: EventType;
  exchange: string;
  timestamp: string;
  data: Record<string, unknown>;
  riskLevel?: "normal" | "warning" | "critical";
}

interface PositionSnapshot {
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  liquidationPrice: string;
}

interface OrderSnapshot {
  orderId: string;
  symbol: string;
  side: string;
  price: string;
  size: string;
  status: string;
}

/**
 * Start polling-based event stream.
 * Emits NDJSON events to the provided callback.
 */
export async function startEventStream(
  adapter: ExchangeAdapter,
  opts: {
    intervalMs?: number;
    liquidationWarningPct?: number;
    onEvent: (event: StreamEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 5000;
  const liqWarnPct = opts.liquidationWarningPct ?? 10; // warn when < 10% from liq price
  const emit = opts.onEvent;

  let prevPositions = new Map<string, PositionSnapshot>();
  let prevOrders = new Map<string, OrderSnapshot>();
  let prevBalance: ExchangeBalance | null = null;
  let cycle = 0;

  const poll = async () => {
    cycle++;
    const ts = new Date().toISOString();

    try {
      const [positions, orders, balance] = await Promise.all([
        adapter.getPositions(),
        adapter.getOpenOrders(),
        adapter.getBalance(),
      ]);

      // ── Position diffs ──
      const currentPositions = new Map<string, PositionSnapshot>();
      for (const p of positions) {
        currentPositions.set(p.symbol, {
          symbol: p.symbol,
          side: p.side,
          size: p.size,
          entryPrice: p.entryPrice,
          unrealizedPnl: p.unrealizedPnl,
          liquidationPrice: p.liquidationPrice,
        });
      }

      // New positions
      for (const [sym, pos] of currentPositions) {
        const prev = prevPositions.get(sym);
        if (!prev) {
          emit({ type: "position_opened", exchange: adapter.name, timestamp: ts, data: { ...pos } });
        } else if (prev.size !== pos.size || prev.side !== pos.side) {
          emit({ type: "position_updated", exchange: adapter.name, timestamp: ts, data: { ...pos, prevSize: prev.size, prevSide: prev.side } });
        }
      }

      // Closed positions
      for (const [sym, prev] of prevPositions) {
        if (!currentPositions.has(sym)) {
          emit({ type: "position_closed", exchange: adapter.name, timestamp: ts, data: { ...prev } });
        }
      }

      // ── Liquidation warnings ──
      for (const p of positions) {
        const mark = Number(p.markPrice);
        const liq = Number(p.liquidationPrice);
        if (mark > 0 && liq > 0 && p.liquidationPrice !== "N/A") {
          const distancePct = Math.abs(mark - liq) / mark * 100;
          if (distancePct < 3) {
            emit({
              type: "margin_call",
              exchange: adapter.name,
              timestamp: ts,
              riskLevel: "critical",
              data: { symbol: p.symbol, side: p.side, markPrice: mark, liquidationPrice: liq, distancePct: +distancePct.toFixed(2) },
            });
          } else if (distancePct < liqWarnPct) {
            emit({
              type: "liquidation_warning",
              exchange: adapter.name,
              timestamp: ts,
              riskLevel: "warning",
              data: { symbol: p.symbol, side: p.side, markPrice: mark, liquidationPrice: liq, distancePct: +distancePct.toFixed(2) },
            });
          }
        }
      }

      prevPositions = currentPositions;

      // ── Order diffs ──
      const currentOrders = new Map<string, OrderSnapshot>();
      for (const o of orders) {
        currentOrders.set(o.orderId, {
          orderId: o.orderId,
          symbol: o.symbol,
          side: o.side,
          price: o.price,
          size: o.size,
          status: o.status,
        });
      }

      // New orders
      for (const [id, order] of currentOrders) {
        if (!prevOrders.has(id)) {
          emit({ type: "order_placed", exchange: adapter.name, timestamp: ts, data: { ...order } });
        }
      }

      // Removed orders (filled or cancelled)
      for (const [id, prev] of prevOrders) {
        if (!currentOrders.has(id)) {
          // Can't distinguish filled vs cancelled from diff alone; mark as filled if position changed
          const posChanged = currentPositions.get(prev.symbol)?.size !== prevPositions.get(prev.symbol)?.size;
          const type = posChanged ? "order_filled" : "order_cancelled";
          emit({ type, exchange: adapter.name, timestamp: ts, data: { ...prev } });
        }
      }

      prevOrders = currentOrders;

      // ── Balance updates ──
      if (prevBalance) {
        const equityDelta = Math.abs(Number(balance.equity) - Number(prevBalance.equity));
        const availDelta = Math.abs(Number(balance.available) - Number(prevBalance.available));
        if (equityDelta > 0.01 || availDelta > 0.01) {
          emit({
            type: "balance_update",
            exchange: adapter.name,
            timestamp: ts,
            data: {
              equity: balance.equity,
              available: balance.available,
              marginUsed: balance.marginUsed,
              unrealizedPnl: balance.unrealizedPnl,
              prevEquity: prevBalance.equity,
              prevAvailable: prevBalance.available,
            },
          });
        }
      }
      prevBalance = balance;

      // Heartbeat every 12 cycles (~60s at 5s interval)
      if (cycle % 12 === 0) {
        emit({
          type: "heartbeat",
          exchange: adapter.name,
          timestamp: ts,
          data: {
            cycle,
            positions: positions.length,
            openOrders: orders.length,
            equity: balance.equity,
          },
        });
      }
    } catch (err) {
      emit({
        type: "error",
        exchange: adapter.name,
        timestamp: ts,
        data: { message: err instanceof Error ? err.message : String(err), cycle },
      });
    }
  };

  // Initial poll
  await poll();

  // Polling loop
  while (!opts.signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      opts.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (opts.signal?.aborted) break;
    await poll();
  }
}
