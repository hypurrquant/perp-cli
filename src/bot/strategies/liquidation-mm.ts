import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";

interface LiquidationMmConfig {
  normalSpread: number;       // basis points for normal mode
  cascadeSpread: number;      // basis points for cascade mode
  cascadeOiDropPct: number;   // OI drop threshold to trigger cascade (%)
  size: number;               // base order size
  cascadeMultiplier: number;  // size multiplier in cascade mode
}

export class LiquidationMmStrategy implements Strategy {
  readonly name = "liquidation-mm";

  describe() {
    return {
      description: "Cascade liquidity provider that widens spread and increases size on OI drops",
      params: [
        { name: "normalSpread", type: "number" as const, required: true, description: "Normal mode spread in basis points" },
        { name: "cascadeSpread", type: "number" as const, required: true, description: "Cascade mode spread in basis points" },
        { name: "cascadeOiDropPct", type: "number" as const, required: false, default: 5, description: "OI drop % to trigger cascade mode" },
        { name: "size", type: "number" as const, required: true, description: "Base order size" },
        { name: "cascadeMultiplier", type: "number" as const, required: false, default: 3, description: "Size multiplier in cascade mode" },
      ],
    };
  }

  private get params(): LiquidationMmConfig {
    return this._config as unknown as LiquidationMmConfig;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("prevOi", parseFloat(snapshot.openInterest) || 0);
    ctx.state.set("cascadeMode", false);
    ctx.state.set("cascadeTicks", 0);
    const p = this.params;
    ctx.log(`  [LIQUIDATION-MM] normalSpread=${p.normalSpread}bps, cascadeSpread=${p.cascadeSpread}bps, oiDrop=${p.cascadeOiDropPct || 5}%, mult=${p.cascadeMultiplier || 3}x`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const actions: StrategyAction[] = [];
    actions.push({ type: "cancel_all" });

    const currentOi = parseFloat(snapshot.openInterest) || 0;
    const prevOi = (ctx.state.get("prevOi") as number) ?? currentOi;
    let cascadeMode = (ctx.state.get("cascadeMode") as boolean) ?? false;
    let cascadeTicks = (ctx.state.get("cascadeTicks") as number) ?? 0;

    // Detect cascade: OI drop exceeds threshold
    const oiDropThreshold = (params.cascadeOiDropPct || 5) / 100;
    if (prevOi > 0 && currentOi > 0) {
      const oiChange = (currentOi - prevOi) / prevOi;
      if (oiChange < -oiDropThreshold) {
        if (!cascadeMode) {
          ctx.log(`  [LIQUIDATION-MM] CASCADE triggered: OI drop ${(oiChange * 100).toFixed(2)}% (threshold: -${(oiDropThreshold * 100).toFixed(1)}%)`);
        }
        cascadeMode = true;
        cascadeTicks = 0; // reset decay timer
      }
    }

    // Cascade mode decays after 10 ticks
    if (cascadeMode) {
      cascadeTicks++;
      if (cascadeTicks > 10) {
        ctx.log(`  [LIQUIDATION-MM] CASCADE ended after ${cascadeTicks} ticks`);
        cascadeMode = false;
        cascadeTicks = 0;
      }
    }

    ctx.state.set("prevOi", currentOi);
    ctx.state.set("cascadeMode", cascadeMode);
    ctx.state.set("cascadeTicks", cascadeTicks);

    // Select parameters based on mode
    const spreadBps = cascadeMode ? params.cascadeSpread : params.normalSpread;
    const spreadFrac = spreadBps / 10000;
    const size = cascadeMode ? params.size * (params.cascadeMultiplier || 3) : params.size;

    const mid = snapshot.price;
    const bidPrice = mid * (1 - spreadFrac / 2);
    const askPrice = mid * (1 + spreadFrac / 2);

    actions.push({
      type: "place_order",
      side: "buy",
      price: bidPrice.toFixed(6),
      size: String(size),
      orderType: "limit",
    });

    actions.push({
      type: "place_order",
      side: "sell",
      price: askPrice.toFixed(6),
      size: String(size),
      orderType: "limit",
    });

    // In cascade mode, add extra levels for deeper liquidity
    if (cascadeMode) {
      for (let i = 2; i <= 3; i++) {
        const deepBid = mid * (1 - spreadFrac * i / 2);
        const deepAsk = mid * (1 + spreadFrac * i / 2);

        actions.push({
          type: "place_order",
          side: "buy",
          price: deepBid.toFixed(6),
          size: String(size * 0.5),
          orderType: "limit",
        });

        actions.push({
          type: "place_order",
          side: "sell",
          price: deepAsk.toFixed(6),
          size: String(size * 0.5),
          orderType: "limit",
        });
      }
    }

    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

registerStrategy("liquidation-mm", (_config) => new LiquidationMmStrategy());
