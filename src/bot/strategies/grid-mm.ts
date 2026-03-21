import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";

interface GridMmConfig {
  gridSpacing: number;   // basis points between levels
  levels: number;        // number of levels each side
  size: number;          // order size per level
  rebalancePct: number;  // rebalance when price moves this % outside grid
}

interface LevelProfit {
  fills: number;
  pnl: number;
}

export class GridMmStrategy implements Strategy {
  readonly name = "grid-mm";

  describe() {
    return {
      description: "Enhanced grid market making with per-level profit tracking",
      params: [
        { name: "gridSpacing", type: "number" as const, required: true, description: "Spacing between levels in basis points" },
        { name: "levels", type: "number" as const, required: false, default: 5, description: "Number of levels each side" },
        { name: "size", type: "number" as const, required: true, description: "Order size per level" },
        { name: "rebalancePct", type: "number" as const, required: false, default: 3, description: "Rebalance threshold percentage" },
      ],
    };
  }

  private get params(): GridMmConfig {
    return this._config as unknown as GridMmConfig;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("gridCenter", snapshot.price);
    ctx.state.set("levelProfits", new Map<number, LevelProfit>());
    ctx.state.set("totalPnl", 0);
    ctx.state.set("rebalanceCount", 0);

    const p = this.params;
    ctx.log(`  [GRID-MM] spacing=${p.gridSpacing}bps, levels=${p.levels}, size=${p.size}, rebalance=${p.rebalancePct}%`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const actions: StrategyAction[] = [];

    const gridCenter = (ctx.state.get("gridCenter") as number) ?? snapshot.price;
    const levels = params.levels || 5;
    const spacingFrac = params.gridSpacing / 10000;

    // Check if rebalance needed
    const deviation = Math.abs(snapshot.price - gridCenter) / gridCenter;
    if (deviation > (params.rebalancePct || 3) / 100) {
      const rebalanceCount = ((ctx.state.get("rebalanceCount") as number) ?? 0) + 1;
      ctx.state.set("rebalanceCount", rebalanceCount);
      ctx.state.set("gridCenter", snapshot.price);
      ctx.log(`  [GRID-MM] Rebalance #${rebalanceCount}: center moved to $${snapshot.price.toFixed(2)} (deviation: ${(deviation * 100).toFixed(2)}%)`);
    }

    const center = (ctx.state.get("gridCenter") as number) ?? snapshot.price;

    // Cancel all existing orders then place fresh grid
    actions.push({ type: "cancel_all" });

    // Place bids below center and asks above center (both sides always)
    for (let i = 1; i <= levels; i++) {
      const bidPrice = center * (1 - spacingFrac * i);
      const askPrice = center * (1 + spacingFrac * i);

      actions.push({
        type: "place_order",
        side: "buy",
        price: bidPrice.toFixed(6),
        size: String(params.size),
        orderType: "limit",
      });

      actions.push({
        type: "place_order",
        side: "sell",
        price: askPrice.toFixed(6),
        size: String(params.size),
        orderType: "limit",
      });
    }

    // Track per-level profit (simplified: estimate from price crossing levels)
    const prevPrice = (ctx.state.get("prevPrice") as number) ?? snapshot.price;
    const levelProfits = (ctx.state.get("levelProfits") as Map<number, LevelProfit>) ?? new Map();

    for (let i = 1; i <= levels; i++) {
      const bidLevel = center * (1 - spacingFrac * i);
      const askLevel = center * (1 + spacingFrac * i);

      if (!levelProfits.has(i)) {
        levelProfits.set(i, { fills: 0, pnl: 0 });
      }
      const lp = levelProfits.get(i)!;

      // Price crossed bid level downward: bid filled
      if (prevPrice > bidLevel && snapshot.price <= bidLevel) {
        lp.fills++;
        lp.pnl -= bidLevel * params.size; // cost basis
      }
      // Price crossed ask level upward: ask filled
      if (prevPrice < askLevel && snapshot.price >= askLevel) {
        lp.fills++;
        lp.pnl += askLevel * params.size; // revenue
      }
    }

    ctx.state.set("prevPrice", snapshot.price);

    // Log per-level stats periodically
    if (ctx.tick > 0 && ctx.tick % 20 === 0) {
      let totalFills = 0;
      for (const [, lp] of levelProfits) totalFills += lp.fills;
      ctx.log(`  [GRID-MM] tick=${ctx.tick}, center=$${center.toFixed(2)}, totalFills=${totalFills}`);
    }

    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

registerStrategy("grid-mm", (_config) => new GridMmStrategy());
