import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import { detectRegime } from "../indicators.js";

interface RegimeMmConfig {
  baseSpread: number;  // basis points
  size: number;
  regimeWindow: number; // lookback period for regime detection
}

type Regime = ReturnType<typeof detectRegime>;

/** Per-regime parameter multipliers */
const REGIME_PARAMS: Record<Regime, { spreadMult: number; sizeMult: number; bias: "trend" | "symmetric" | "aggressive-revert" }> = {
  "low-vol-trending":  { spreadMult: 0.8, sizeMult: 1.0, bias: "trend" },
  "low-vol-ranging":   { spreadMult: 0.8, sizeMult: 1.0, bias: "symmetric" },
  "high-vol-trending": { spreadMult: 2.0, sizeMult: 0.5, bias: "trend" },
  "high-vol-ranging":  { spreadMult: 2.0, sizeMult: 0.7, bias: "aggressive-revert" },
};

export class RegimeMmStrategy implements Strategy {
  readonly name = "regime-mm";

  describe() {
    return {
      description: "Volatility-adaptive market making using regime detection",
      params: [
        { name: "baseSpread", type: "number" as const, required: true, description: "Base spread in basis points" },
        { name: "size", type: "number" as const, required: true, description: "Base order size" },
        { name: "regimeWindow", type: "number" as const, required: false, default: 20, description: "Lookback period for regime detection" },
      ],
    };
  }

  private get params(): RegimeMmConfig {
    return this._config as unknown as RegimeMmConfig;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("inventory", 0);
    ctx.state.set("currentRegime", "low-vol-ranging");
    const p = this.params;
    ctx.log(`  [REGIME-MM] baseSpread=${p.baseSpread}bps, size=${p.size}, window=${p.regimeWindow || 20}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const actions: StrategyAction[] = [];
    actions.push({ type: "cancel_all" });

    // Detect current regime from kline close prices
    const window = params.regimeWindow || 20;
    let regime: Regime = "low-vol-ranging";
    if (snapshot.klines.length >= window) {
      const closes = snapshot.klines.map(k => parseFloat(k.close));
      regime = detectRegime(closes, window);
    }

    const prevRegime = ctx.state.get("currentRegime") as Regime;
    if (regime !== prevRegime) {
      ctx.log(`  [REGIME-MM] Regime shift: ${prevRegime} -> ${regime}`);
      ctx.state.set("currentRegime", regime);
    }

    const rp = REGIME_PARAMS[regime];
    const mid = snapshot.price;
    const spreadFrac = (params.baseSpread / 10000) * rp.spreadMult;
    const size = params.size * rp.sizeMult;
    const inventory = (ctx.state.get("inventory") as number) ?? 0;

    // Trend bias: compute slope direction from recent prices
    let trendBias = 0;
    if (rp.bias === "trend" && snapshot.klines.length >= 5) {
      const recent = snapshot.klines.slice(-5).map(k => parseFloat(k.close));
      const slope = (recent[recent.length - 1] - recent[0]) / recent[0];
      trendBias = slope * mid * 0.5; // shift quotes in trend direction
    }

    // Aggressive inventory reversion for high-vol-ranging
    let inventoryShift = 0;
    if (rp.bias === "aggressive-revert" && inventory !== 0) {
      inventoryShift = -inventory * spreadFrac * mid * 2;
    } else if (inventory !== 0) {
      // Standard inventory management
      inventoryShift = -inventory * spreadFrac * mid * 0.5;
    }

    const bidPrice = mid * (1 - spreadFrac / 2) + trendBias + inventoryShift;
    const askPrice = mid * (1 + spreadFrac / 2) + trendBias + inventoryShift;

    // Adjust sizes: reduce on heavy side
    const maxInv = params.size * 10;
    const invRatio = maxInv > 0 ? Math.abs(inventory) / maxInv : 0;
    const sizePenalty = Math.min(invRatio, 0.8);
    const bidSize = inventory > 0 ? size * (1 - sizePenalty) : size;
    const askSize = inventory < 0 ? size * (1 - sizePenalty) : size;

    if (bidSize > 0 && bidPrice > 0) {
      actions.push({
        type: "place_order",
        side: "buy",
        price: bidPrice.toFixed(6),
        size: String(bidSize),
        orderType: "limit",
      });
    }

    if (askSize > 0 && askPrice > 0) {
      actions.push({
        type: "place_order",
        side: "sell",
        price: askPrice.toFixed(6),
        size: String(askSize),
        orderType: "limit",
      });
    }

    // Update inventory estimate
    const prevMid = (ctx.state.get("prevMid") as number) ?? mid;
    if (mid > prevMid) {
      ctx.state.set("inventory", inventory + size * 0.3);
    } else if (mid < prevMid) {
      ctx.state.set("inventory", inventory - size * 0.3);
    }
    ctx.state.set("prevMid", mid);

    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

registerStrategy("regime-mm", (_config) => new RegimeMmStrategy());
