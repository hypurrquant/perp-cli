import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { DCAStrategyParams } from "../config.js";
import { registerStrategy } from "../strategy-registry.js";

export class DCAStrategy implements Strategy {
  readonly name = "dca";

  describe() {
    return {
      description: "Dollar-cost averaging with timed intervals",
      params: [
        { name: "amount", type: "number" as const, required: true, description: "Base size per order" },
        { name: "interval_sec", type: "number" as const, required: true, description: "Seconds between orders" },
        { name: "total_orders", type: "number" as const, required: false, default: 0, description: "Max orders (0 = unlimited)" },
        { name: "price_limit", type: "number" as const, required: false, description: "Max price to buy at" },
      ],
    };
  }

  private get params(): DCAStrategyParams {
    return this._config as unknown as DCAStrategyParams;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    const params = this.params;
    ctx.state.set("dcaOrdersPlaced", 0);
    ctx.state.set("dcaLastOrder", 0);
    ctx.log(`  [DCA] Ready: ${params.amount} ${ctx.symbol} every ${params.interval_sec}s`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const dcaOrdersPlaced = ctx.state.get("dcaOrdersPlaced") as number;
    const dcaLastOrder = ctx.state.get("dcaLastOrder") as number;

    // Check if it's time for next order
    const timeSinceLast = (Date.now() - dcaLastOrder) / 1000;
    if (dcaLastOrder > 0 && timeSinceLast < params.interval_sec) return [];

    // Check order limit
    if (params.total_orders > 0 && dcaOrdersPlaced >= params.total_orders) return [];

    // Check price limit (buy: skip if price too high, sell: skip if price too low)
    if (params.price_limit) {
      const side = params.side ?? "buy";
      if (side === "buy" && snapshot.price > params.price_limit) return [];
      if (side === "sell" && snapshot.price < params.price_limit) return [];
    }

    // Place market buy order
    ctx.state.set("dcaOrdersPlaced", dcaOrdersPlaced + 1);
    ctx.state.set("dcaLastOrder", Date.now());

    const side = params.side ?? "buy";
    const progress = params.total_orders > 0 ? ` (${dcaOrdersPlaced + 1}/${params.total_orders})` : "";
    ctx.log(`  [DCA] Order #${dcaOrdersPlaced + 1}${progress}: ${side} ${params.amount} ${ctx.symbol} @ $${snapshot.price.toFixed(2)}`);

    return [{
      type: "place_order",
      side,
      price: "0",
      size: String(params.amount),
      orderType: "market",
    }];
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

registerStrategy("dca", (_config) => new DCAStrategy());
