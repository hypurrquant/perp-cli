import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";

interface SimpleMmConfig {
  spread: number;   // basis points
  size: number;
  levels: number;
}

export class SimpleMmStrategy implements Strategy {
  readonly name = "simple-mm";

  describe() {
    return {
      description: "Symmetric bid/ask market making at fixed spread",
      params: [
        { name: "spread", type: "number" as const, required: true, description: "Spread in basis points" },
        { name: "size", type: "number" as const, required: true, description: "Order size per level" },
        { name: "levels", type: "number" as const, required: false, default: 1, description: "Number of levels each side" },
      ],
    };
  }

  private get params(): SimpleMmConfig {
    return this._config as unknown as SimpleMmConfig;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("inventory", 0);
    ctx.log(`  [SIMPLE-MM] spread=${this.params.spread}bps, size=${this.params.size}, levels=${this.params.levels}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const { spread, size, levels } = this.params;
    const actions: StrategyAction[] = [];
    const inventory = (ctx.state.get("inventory") as number) ?? 0;

    // Cancel all existing orders, then re-quote
    actions.push({ type: "cancel_all" });

    const mid = snapshot.price;
    const spreadFraction = spread / 10000; // bps to fraction

    for (let i = 1; i <= (levels || 1); i++) {
      const offset = (spreadFraction / 2) * i;
      const bidPrice = mid * (1 - offset);
      const askPrice = mid * (1 + offset);

      // Simple inventory skew: reduce size on heavy side
      const inventorySkew = Math.min(Math.abs(inventory) / (size * levels * 2), 0.8);
      const bidSize = inventory > 0 ? size * (1 - inventorySkew) : size;
      const askSize = inventory < 0 ? size * (1 - inventorySkew) : size;

      if (bidSize > 0) {
        actions.push({
          type: "place_order",
          side: "buy",
          price: bidPrice.toFixed(6),
          size: String(bidSize),
          orderType: "limit",
        });
      }

      if (askSize > 0) {
        actions.push({
          type: "place_order",
          side: "sell",
          price: askPrice.toFixed(6),
          size: String(askSize),
          orderType: "limit",
        });
      }
    }

    // Track approximate inventory from fills (simplified: assume fills at each tick)
    // Real inventory tracking would use adapter.getPositions()
    const prevMid = (ctx.state.get("prevMid") as number) ?? mid;
    if (mid > prevMid) {
      // Price moved up: likely bid was filled
      ctx.state.set("inventory", inventory + size);
    } else if (mid < prevMid) {
      // Price moved down: likely ask was filled
      ctx.state.set("inventory", inventory - size);
    }
    ctx.state.set("prevMid", mid);

    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

registerStrategy("simple-mm", (_config) => new SimpleMmStrategy());
