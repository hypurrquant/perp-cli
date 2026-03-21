import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";

/**
 * RFQ Agent strategy — iceberg-style large order execution.
 * Splits a large order into smaller slices placed at wider spreads
 * to minimize market impact.
 */

interface RfqAgentConfig {
  totalSize: number;   // total order size to execute
  sliceSize: number;   // size of each individual slice
  spreadBps: number;   // spread offset in basis points for each slice
  delayMs: number;     // minimum ms between slices (enforced via tick timing)
}

export class RfqAgentStrategy implements Strategy {
  readonly name = "rfq-agent";

  private _config: Record<string, unknown> = {};

  private get params(): RfqAgentConfig {
    return {
      totalSize: Number(this._config.totalSize ?? 1),
      sliceSize: Number(this._config.sliceSize ?? 0.1),
      spreadBps: Number(this._config.spreadBps ?? 10),
      delayMs: Number(this._config.delayMs ?? 1000),
    };
  }

  describe() {
    return {
      description: "Iceberg-style large order execution: splits into slices at wider spreads to reduce market impact",
      params: [
        { name: "totalSize", type: "number" as const, required: true, description: "Total order size to execute" },
        { name: "sliceSize", type: "number" as const, required: true, description: "Size of each individual slice" },
        { name: "spreadBps", type: "number" as const, required: false, default: 10, description: "Spread offset per slice in basis points" },
        { name: "delayMs", type: "number" as const, required: false, default: 1000, description: "Minimum ms between slices" },
      ],
    };
  }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    const { totalSize, sliceSize, spreadBps, delayMs } = this.params;
    ctx.state.set("remainingSize", totalSize);
    ctx.state.set("lastSliceTime", 0);
    const slices = Math.ceil(totalSize / sliceSize);
    ctx.log(
      `  [RFQ-AGENT] totalSize=${totalSize} sliceSize=${sliceSize} ` +
      `spread=${spreadBps}bps delayMs=${delayMs} (~${slices} slices)`,
    );
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const { sliceSize, spreadBps, delayMs } = this.params;

    const remainingSize = ctx.state.get("remainingSize") as number;
    const lastSliceTime = ctx.state.get("lastSliceTime") as number;

    if (remainingSize <= 0) {
      ctx.log("  [RFQ-AGENT] All slices placed — execution complete");
      return [{ type: "noop" }];
    }

    const now = Date.now();
    if (now - lastSliceTime < delayMs) {
      return [{ type: "noop" }];
    }

    const thisSlice = Math.min(sliceSize, remainingSize);
    const spreadFraction = spreadBps / 10000;

    // Determine side from config, default buy; offer at wider spread to reduce impact
    const side = (ctx.config.side as "buy" | "sell" | undefined) ?? "buy";
    const price =
      side === "buy"
        ? snapshot.price * (1 - spreadFraction)  // bid below mid
        : snapshot.price * (1 + spreadFraction); // ask above mid

    const newRemaining = remainingSize - thisSlice;
    ctx.state.set("remainingSize", newRemaining);
    ctx.state.set("lastSliceTime", now);

    ctx.log(
      `  [RFQ-AGENT] Placing slice ${thisSlice.toFixed(6)} @ ${price.toFixed(6)} ` +
      `(remaining: ${newRemaining.toFixed(6)})`,
    );

    return [
      {
        type: "place_order",
        side,
        price: price.toFixed(6),
        size: thisSlice.toFixed(6),
        orderType: "limit",
      },
    ];
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

registerStrategy("rfq-agent", (_config) => new RfqAgentStrategy());
