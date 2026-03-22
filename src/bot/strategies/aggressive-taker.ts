import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import { calculateEMA } from "../indicators.js";

/**
 * Aggressive taker strategy.
 * Crosses spread with directional bias from EMA crossover signals.
 * - Short EMA cross above long EMA = buy (bullish).
 * - Short EMA cross below long EMA = sell (bearish).
 * Size modulation: larger in strong trend, smaller in weak.
 */
export class AggressiveTakerStrategy implements Strategy {
  readonly name = "aggressive-taker";

  private _config: Record<string, unknown> = {};

  describe() {
    return {
      description: "Aggressive market taker with EMA crossover signals and size modulation",
      params: [
        { name: "shortEmaPeriod", type: "number" as const, required: false, default: 9, description: "Short EMA period" },
        { name: "longEmaPeriod", type: "number" as const, required: false, default: 21, description: "Long EMA period" },
        { name: "baseSize", type: "number" as const, required: true, description: "Base position size" },
        { name: "maxSize", type: "number" as const, required: false, default: 0, description: "Max position size (0 = 3x base)" },
        { name: "minSignalStrength", type: "number" as const, required: false, default: 0.001, description: "Min EMA divergence ratio to act" },
      ],
    };
  }

  private get shortEmaPeriod(): number { return Number(this._config.shortEmaPeriod ?? 9); }
  private get longEmaPeriod(): number { return Number(this._config.longEmaPeriod ?? 21); }
  private get baseSize(): number { return Number(this._config.baseSize ?? 0.1); }
  private get maxSize(): number { return Number(this._config.maxSize ?? 0) || this.baseSize * 3; }
  private get minSignalStrength(): number { return Number(this._config.minSignalStrength ?? 0.001); }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("position", null); // null | { side, entry, size }
    ctx.state.set("prevSignal", 0);  // -1 sell, 0 neutral, 1 buy
    ctx.log(`  [TAKER] Ready | shortEMA=${this.shortEmaPeriod} longEMA=${this.longEmaPeriod} base=${this.baseSize} max=${this.maxSize}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const actions: StrategyAction[] = [];
    const klines = snapshot.klines;

    if (klines.length < this.longEmaPeriod + 1) {
      ctx.log(`  [TAKER] Insufficient klines (${klines.length}/${this.longEmaPeriod + 1})`);
      return [];
    }

    const closes = klines.map(k => parseFloat(k.close));
    const price = snapshot.price;

    // Compute EMAs
    const shortEma = calculateEMA(closes, this.shortEmaPeriod);
    const longEma = calculateEMA(closes, this.longEmaPeriod);

    if (shortEma.length === 0 || longEma.length === 0) return [];

    const currentShort = shortEma[shortEma.length - 1];
    const currentLong = longEma[longEma.length - 1];

    // Signal strength = normalized divergence
    const divergence = (currentShort - currentLong) / currentLong;
    const signalStrength = Math.abs(divergence);

    // Determine signal: +1 bullish, -1 bearish, 0 neutral
    let signal = 0;
    if (divergence > this.minSignalStrength) signal = 1;
    else if (divergence < -this.minSignalStrength) signal = -1;

    const prevSignal = ctx.state.get("prevSignal") as number;
    const position = ctx.state.get("position") as {
      side: "buy" | "sell"; entry: number; size: number;
    } | null;

    // Size modulation: scale between baseSize and maxSize based on signal strength
    const sizeRange = this.maxSize - this.baseSize;
    // Cap strength at 5x minSignalStrength for scaling
    const strengthCapped = Math.min(signalStrength / (this.minSignalStrength * 5), 1);
    const orderSize = this.baseSize + sizeRange * strengthCapped;

    // Signal changed — trade
    if (signal !== 0 && signal !== prevSignal) {
      // Close existing position if flipping
      if (position) {
        ctx.log(`  [TAKER] Close ${position.side} @ $${price.toFixed(2)}`);
        actions.push({
          type: "place_order",
          side: position.side === "buy" ? "sell" : "buy",
          price: price.toFixed(2),
          size: String(position.size),
          orderType: "market",
          reduceOnly: true,
        });
      }

      // Open new position
      const side: "buy" | "sell" = signal > 0 ? "buy" : "sell";
      const roundedSize = parseFloat(orderSize.toFixed(6));
      ctx.state.set("position", { side, entry: price, size: roundedSize });
      ctx.log(`  [TAKER] ${side.toUpperCase()} @ $${price.toFixed(2)} size=${roundedSize} strength=${signalStrength.toFixed(4)}`);
      actions.push({
        type: "place_order",
        side,
        price: price.toFixed(2),
        size: String(roundedSize),
        orderType: "market",
      });
    }

    // Neutral signal — close if we have a position
    if (signal === 0 && position) {
      ctx.log(`  [TAKER] Signal neutral, closing ${position.side} @ $${price.toFixed(2)}`);
      actions.push({
        type: "place_order",
        side: position.side === "buy" ? "sell" : "buy",
        price: price.toFixed(2),
        size: String(position.size),
        orderType: "market",
        reduceOnly: true,
      });
      ctx.state.set("position", null);
    }

    ctx.state.set("prevSignal", signal);
    return actions;
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const position = ctx.state.get("position") as { side: "buy" | "sell"; size: number } | null;
    if (!position) return [];
    return [{
      type: "place_order",
      side: position.side === "buy" ? "sell" : "buy",
      price: "0",
      size: String(position.size),
      orderType: "market",
      reduceOnly: true,
    }];
  }
}

registerStrategy("aggressive-taker", (_config) => new AggressiveTakerStrategy());
