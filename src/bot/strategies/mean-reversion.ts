import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import { calculateSMA, calculateBollingerBands } from "../indicators.js";

/**
 * Mean reversion strategy.
 * Entry: price deviates > threshold from SMA, confirmed by Bollinger Band touch.
 *   - Buy when price touches lower band (oversold).
 *   - Sell when price touches upper band (overbought).
 * Exit: price returns to SMA (the mean).
 */
export class MeanReversionStrategy implements Strategy {
  readonly name = "mean-reversion";

  private _config: Record<string, unknown> = {};

  describe() {
    return {
      description: "Mean reversion using Bollinger Bands — buy at lower band, sell at upper band, exit at mean",
      params: [
        { name: "smaPeriod", type: "number" as const, required: false, default: 20, description: "SMA lookback period" },
        { name: "bollingerStdDev", type: "number" as const, required: false, default: 2, description: "Bollinger Bands std dev multiplier" },
        { name: "entryThreshold", type: "number" as const, required: false, default: 0, description: "Extra threshold beyond band (0 = band touch)" },
        { name: "size", type: "number" as const, required: true, description: "Position size" },
      ],
    };
  }

  private get smaPeriod(): number { return Number(this._config.smaPeriod ?? 20); }
  private get bollingerStdDev(): number { return Number(this._config.bollingerStdDev ?? 2); }
  private get entryThreshold(): number { return Number(this._config.entryThreshold ?? 0); }
  private get size(): number { return Number(this._config.size ?? 0.1); }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("position", null); // null | { side, entry }
    ctx.log(`  [MEAN-REV] Ready | sma=${this.smaPeriod} stdDev=${this.bollingerStdDev} threshold=${this.entryThreshold}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const actions: StrategyAction[] = [];
    const klines = snapshot.klines;

    if (klines.length < this.smaPeriod) {
      ctx.log(`  [MEAN-REV] Insufficient klines (${klines.length}/${this.smaPeriod})`);
      return [];
    }

    const closes = klines.map(k => parseFloat(k.close));
    const price = snapshot.price;

    // Compute indicators
    const smaValues = calculateSMA(closes, this.smaPeriod);
    const currentSMA = smaValues.length > 0 ? smaValues[smaValues.length - 1] : price;

    const bands = calculateBollingerBands(closes, this.smaPeriod, this.bollingerStdDev);
    const upperBand = bands.upper.length > 0 ? bands.upper[bands.upper.length - 1] : price;
    const lowerBand = bands.lower.length > 0 ? bands.lower[bands.lower.length - 1] : price;

    const position = ctx.state.get("position") as {
      side: "buy" | "sell"; entry: number;
    } | null;

    // If no position, check for entry signals
    if (!position) {
      // Buy signal: price at or below lower band (- threshold)
      if (price <= lowerBand - this.entryThreshold) {
        ctx.state.set("position", { side: "buy", entry: price });
        ctx.log(`  [MEAN-REV] Long entry @ $${price.toFixed(2)} (lower band $${lowerBand.toFixed(2)}, mean $${currentSMA.toFixed(2)})`);
        actions.push({
          type: "place_order",
          side: "buy",
          price: price.toFixed(2),
          size: String(this.size),
          orderType: "market",
        });
      }
      // Sell signal: price at or above upper band (+ threshold)
      else if (price >= upperBand + this.entryThreshold) {
        ctx.state.set("position", { side: "sell", entry: price });
        ctx.log(`  [MEAN-REV] Short entry @ $${price.toFixed(2)} (upper band $${upperBand.toFixed(2)}, mean $${currentSMA.toFixed(2)})`);
        actions.push({
          type: "place_order",
          side: "sell",
          price: price.toFixed(2),
          size: String(this.size),
          orderType: "market",
        });
      }
      return actions;
    }

    // Manage existing position — exit when price returns to mean
    if (position.side === "buy" && price >= currentSMA) {
      ctx.log(`  [MEAN-REV] Close long @ $${price.toFixed(2)} (mean $${currentSMA.toFixed(2)})`);
      ctx.state.set("position", null);
      actions.push({
        type: "place_order",
        side: "sell",
        price: price.toFixed(2),
        size: String(this.size),
        orderType: "market",
        reduceOnly: true,
      });
    } else if (position.side === "sell" && price <= currentSMA) {
      ctx.log(`  [MEAN-REV] Close short @ $${price.toFixed(2)} (mean $${currentSMA.toFixed(2)})`);
      ctx.state.set("position", null);
      actions.push({
        type: "place_order",
        side: "buy",
        price: price.toFixed(2),
        size: String(this.size),
        orderType: "market",
        reduceOnly: true,
      });
    }

    return actions;
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const position = ctx.state.get("position") as { side: "buy" | "sell" } | null;
    if (!position) return [];
    return [{
      type: "place_order",
      side: position.side === "buy" ? "sell" : "buy",
      price: "0",
      size: String(this.size),
      orderType: "market",
      reduceOnly: true,
    }];
  }
}

registerStrategy("mean-reversion", (_config) => new MeanReversionStrategy());
