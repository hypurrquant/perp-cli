import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { GridStrategyParams } from "../config.js";
import { registerStrategy } from "../strategy-registry.js";

export class GridStrategy implements Strategy {
  readonly name = "grid";

  describe() {
    return {
      description: "Grid trading with fixed intervals",
      params: [
        { name: "grids", type: "number" as const, required: true, description: "Number of grid lines" },
        { name: "size", type: "number" as const, required: true, description: "Total position size" },
        { name: "side", type: "string" as const, required: false, default: "neutral", description: "long | short | neutral" },
        { name: "range_mode", type: "string" as const, required: false, default: "auto", description: "auto | fixed" },
        { name: "range_pct", type: "number" as const, required: false, default: 3, description: "Auto range +/- percentage" },
        { name: "upper", type: "number" as const, required: false, description: "Fixed mode upper bound" },
        { name: "lower", type: "number" as const, required: false, description: "Fixed mode lower bound" },
        { name: "rebalance", type: "boolean" as const, required: false, default: true, description: "Auto-rebalance on range exit" },
        { name: "rebalance_cooldown", type: "number" as const, required: false, default: 60, description: "Seconds between rebalances" },
        { name: "leverage", type: "number" as const, required: false, description: "Leverage multiplier" },
      ],
    };
  }

  private get params(): GridStrategyParams {
    return this._config as unknown as GridStrategyParams;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    const params = this.params;

    // Determine price range
    if (params.range_mode === "auto") {
      const pct = params.range_pct ?? 3;
      const upper = snapshot.price * (1 + pct / 100);
      const lower = snapshot.price * (1 - pct / 100);
      ctx.state.set("gridUpper", upper);
      ctx.state.set("gridLower", lower);
      ctx.log(`  [GRID] Auto range: $${lower.toFixed(2)} - $${upper.toFixed(2)} (+/-${pct}%)`);
    } else {
      if (!params.upper || !params.lower) throw new Error("Fixed grid requires upper and lower");
      ctx.state.set("gridUpper", params.upper);
      ctx.state.set("gridLower", params.lower);
    }

    ctx.state.set("gridOrders", new Map<number, string>());
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const actions: StrategyAction[] = [];
    const gridOrders = ctx.state.get("gridOrders") as Map<number, string>;
    const gridUpper = ctx.state.get("gridUpper") as number;
    const gridLower = ctx.state.get("gridLower") as number;

    // First tick: set leverage + place initial grid
    if (ctx.tick === 0) {
      if (params.leverage) {
        actions.push({ type: "set_leverage", leverage: params.leverage });
      }
      return [...actions, ...this.buildGridOrders(ctx, snapshot.price)];
    }

    if (params.grids < 2) throw new Error("Grid requires at least 2 grid lines");
    const step = (gridUpper - gridLower) / (params.grids - 1);
    const sizePerGrid = params.size / params.grids;

    // Check for fills
    try {
      const openOrders = await ctx.adapter.getOpenOrders();
      const openIds = new Set(
        openOrders.filter(o => o.symbol.toUpperCase() === ctx.symbol.toUpperCase()).map(o => o.orderId),
      );

      // Build filled order IDs from order history for accurate fill detection
      let filledIds: Set<string> | null = null;
      try {
        const history = await ctx.adapter.getOrderHistory(100);
        filledIds = new Set(history.filter(o => o.status === "filled").map(o => o.orderId));
      } catch { /* non-critical -- fall back to assuming fills */ }

      let newFills = 0;
      for (const [idx, orderId] of gridOrders.entries()) {
        if (!openIds.has(orderId)) {
          // Verify the order was actually filled (not just cancelled)
          if (filledIds && !filledIds.has(orderId)) {
            ctx.log(`  [GRID] Order ${orderId} missing -- likely cancelled, skipping`);
            gridOrders.delete(idx);
            continue;
          }
          // Order filled -- place opposite order
          newFills++;

          // Determine new side and price
          const oldPrice = gridLower + step * idx;
          const wasBuy = oldPrice < snapshot.price;
          const newSide: "buy" | "sell" = wasBuy ? "sell" : "buy";
          const newPrice = wasBuy ? oldPrice + step : oldPrice - step;

          if (newPrice >= gridLower && newPrice <= gridUpper) {
            actions.push({
              type: "place_order",
              side: newSide,
              price: newPrice.toFixed(2),
              size: String(sizePerGrid),
              orderType: "limit",
            });
            // We'll update gridOrders when the action is executed
            // For now mark this index as pending -- use a sentinel
            gridOrders.set(idx, `pending-${idx}`);
          } else {
            gridOrders.delete(idx);
          }
        }
      }

      if (newFills > 0) {
        ctx.log(`  [GRID] ${newFills} fill(s) detected`);
      }
    } catch { /* retry next loop */ }

    // Auto-rebalance if price exits range
    if (params.rebalance) {
      const lastRebalance = (ctx.state.get("lastRebalance") as number) ?? 0;
      const outOfRange = snapshot.price > gridUpper || snapshot.price < gridLower;
      const cooldownOk = Date.now() - lastRebalance > params.rebalance_cooldown * 1000;

      if (outOfRange && cooldownOk) {
        const pct = params.range_pct ?? 3;
        const newUpper = snapshot.price * (1 + pct / 100);
        const newLower = snapshot.price * (1 - pct / 100);
        ctx.state.set("gridUpper", newUpper);
        ctx.state.set("gridLower", newLower);
        ctx.state.set("lastRebalance", Date.now());

        const rebalanceCount = ((ctx.state.get("rebalanceCount") as number) ?? 0) + 1;
        ctx.state.set("rebalanceCount", rebalanceCount);

        ctx.log(`  [GRID] Rebalance #${rebalanceCount}: price $${snapshot.price.toFixed(2)} outside range -> new $${newLower.toFixed(2)} - $${newUpper.toFixed(2)}`);

        // Cancel all and rebuild
        actions.push({ type: "cancel_all" });
        gridOrders.clear();
        return [...actions, ...this.buildGridOrders(ctx, snapshot.price)];
      }
    }

    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }

  /** Build initial grid order actions */
  private buildGridOrders(ctx: StrategyContext, currentPrice: number): StrategyAction[] {
    const params = this.params;
    const gridUpper = ctx.state.get("gridUpper") as number;
    const gridLower = ctx.state.get("gridLower") as number;

    if (params.grids < 2) throw new Error("Grid requires at least 2 grid lines");
    const step = (gridUpper - gridLower) / (params.grids - 1);
    const sizePerGrid = params.size / params.grids;
    const actions: StrategyAction[] = [];

    // Cancel existing orders first
    const gridOrders = ctx.state.get("gridOrders") as Map<number, string>;
    if (gridOrders.size > 0) {
      actions.push({ type: "cancel_all" });
      gridOrders.clear();
    }

    for (let i = 0; i < params.grids; i++) {
      const price = gridLower + step * i;

      let side: "buy" | "sell";
      if (params.side === "long") side = "buy";
      else if (params.side === "short") side = "sell";
      else side = price < currentPrice ? "buy" : "sell";

      actions.push({
        type: "place_order",
        side,
        price: price.toFixed(2),
        size: String(sizePerGrid),
        orderType: "limit",
      });
      // Mark grid index with pending sentinel -- engine updates after execution
      gridOrders.set(i, `pending-${i}`);
    }

    ctx.log(`  [GRID] Placing ${params.grids} orders (step: $${step.toFixed(2)}, size: ${sizePerGrid.toFixed(6)})`);
    return actions;
  }
}

registerStrategy("grid", (_config) => new GridStrategy());
