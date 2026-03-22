import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";

/**
 * Hedge Agent strategy.
 * Monitors total portfolio exposure across all positions.
 * When net notional exceeds threshold, places hedging orders on the opposite side.
 */

interface HedgeAgentConfig {
  maxNotionalUsd: number;  // USD notional threshold before hedging
  hedgeRatio: number;      // fraction of excess exposure to hedge (0–1)
  checkIntervalTicks: number; // ticks between exposure checks
}

export class HedgeAgentStrategy implements Strategy {
  readonly name = "hedge-agent";

  private _config: Record<string, unknown> = {};

  private get params(): HedgeAgentConfig {
    return {
      maxNotionalUsd: Number(this._config.maxNotionalUsd ?? 1000),
      hedgeRatio: Number(this._config.hedgeRatio ?? 0.5),
      checkIntervalTicks: Number(this._config.checkIntervalTicks ?? 5),
    };
  }

  describe() {
    return {
      description: "Monitors portfolio net notional and hedges when exposure exceeds threshold",
      params: [
        { name: "maxNotionalUsd", type: "number" as const, required: true, description: "Max net notional USD before hedging" },
        { name: "hedgeRatio", type: "number" as const, required: false, default: 0.5, description: "Fraction of excess exposure to hedge (0–1)" },
        { name: "checkIntervalTicks", type: "number" as const, required: false, default: 5, description: "Ticks between exposure checks" },
      ],
    };
  }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("lastNetNotional", 0);
    ctx.log(
      `  [HEDGE-AGENT] maxNotional=$${this.params.maxNotionalUsd} ` +
      `hedgeRatio=${this.params.hedgeRatio} checkInterval=${this.params.checkIntervalTicks}ticks`,
    );
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const { maxNotionalUsd, hedgeRatio, checkIntervalTicks } = this.params;

    // Only check every N ticks
    if (ctx.tick % checkIntervalTicks !== 0) {
      return [{ type: "noop" }];
    }

    let positions;
    try {
      positions = await ctx.adapter.getPositions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [HEDGE-AGENT] Failed to fetch positions: ${msg}`);
      return [{ type: "noop" }];
    }

    // Calculate net notional: long = positive, short = negative
    let netNotional = 0;
    for (const pos of positions) {
      const size = parseFloat(pos.size);
      const mark = parseFloat(pos.markPrice) || snapshot.price;
      const notional = size * mark;
      netNotional += pos.side === "long" ? notional : -notional;
    }

    ctx.state.set("lastNetNotional", netNotional);
    ctx.log(`  [HEDGE-AGENT] net notional: $${netNotional.toFixed(2)} (limit: $${maxNotionalUsd})`);

    const absNet = Math.abs(netNotional);
    if (absNet <= maxNotionalUsd) {
      return [{ type: "noop" }];
    }

    const excess = absNet - maxNotionalUsd;
    const hedgeNotional = excess * hedgeRatio;
    const hedgeSize = hedgeNotional / snapshot.price;

    // Hedge on the opposite side to reduce net exposure
    const hedgeSide: "buy" | "sell" = netNotional > 0 ? "sell" : "buy";

    ctx.log(
      `  [HEDGE-AGENT] Excess $${excess.toFixed(2)} — placing ${hedgeSide} hedge ` +
      `size=${hedgeSize.toFixed(6)} at market`,
    );

    return [
      {
        type: "place_order",
        side: hedgeSide,
        price: snapshot.price.toFixed(6),
        size: hedgeSize.toFixed(6),
        orderType: "market",
        reduceOnly: false,
      },
    ];
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

registerStrategy("hedge-agent", (_config) => new HedgeAgentStrategy());
