import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import { calculateATR, calculateSMA } from "../indicators.js";

/**
 * Momentum breakout strategy.
 * Entry: price breaks above N-period high (buy) or below N-period low (sell)
 *        with volume confirmation (volume > avgVolume * multiplier).
 * Stop: ATR-based trailing stop.
 * Take profit: risk/reward ratio based.
 */
export class MomentumBreakoutStrategy implements Strategy {
  readonly name = "momentum-breakout";

  private _config: Record<string, unknown> = {};

  describe() {
    return {
      description: "Momentum breakout with volume confirmation and ATR trailing stop",
      params: [
        { name: "lookbackPeriod", type: "number" as const, required: false, default: 20, description: "Periods for high/low channel" },
        { name: "volumeMultiplier", type: "number" as const, required: false, default: 1.5, description: "Volume must exceed avg * this" },
        { name: "atrMultiplier", type: "number" as const, required: false, default: 2, description: "ATR multiplier for stop distance" },
        { name: "riskReward", type: "number" as const, required: false, default: 2, description: "Take profit = stop distance * this" },
        { name: "size", type: "number" as const, required: true, description: "Position size" },
      ],
    };
  }

  private get lookbackPeriod(): number { return Number(this._config.lookbackPeriod ?? 20); }
  private get volumeMultiplier(): number { return Number(this._config.volumeMultiplier ?? 1.5); }
  private get atrMultiplier(): number { return Number(this._config.atrMultiplier ?? 2); }
  private get riskReward(): number { return Number(this._config.riskReward ?? 2); }
  private get size(): number { return Number(this._config.size ?? 0.1); }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("position", null); // null | { side, entry, stop, tp }
    ctx.log(`  [BREAKOUT] Ready | lookback=${this.lookbackPeriod} volMult=${this.volumeMultiplier} atrMult=${this.atrMultiplier} rr=${this.riskReward}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const actions: StrategyAction[] = [];
    const klines = snapshot.klines;

    if (klines.length < this.lookbackPeriod + 1) {
      ctx.log(`  [BREAKOUT] Insufficient klines (${klines.length}/${this.lookbackPeriod + 1})`);
      return [];
    }

    const closes = klines.map(k => parseFloat(k.close));
    const highs = klines.map(k => parseFloat(k.high));
    const lows = klines.map(k => parseFloat(k.low));
    const volumes = klines.map(k => parseFloat(k.volume));
    const price = snapshot.price;

    // Compute indicators
    const candles = klines.map(k => ({
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
    }));
    const atrValues = calculateATR(candles, this.lookbackPeriod);
    const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;

    // N-period high/low (excluding current bar)
    const lookbackHighs = highs.slice(-this.lookbackPeriod - 1, -1);
    const lookbackLows = lows.slice(-this.lookbackPeriod - 1, -1);
    const channelHigh = Math.max(...lookbackHighs);
    const channelLow = Math.min(...lookbackLows);

    // Volume confirmation
    const avgVolSma = calculateSMA(volumes, this.lookbackPeriod);
    const avgVolume = avgVolSma.length > 0 ? avgVolSma[avgVolSma.length - 1] : 0;
    const currentVolume = volumes[volumes.length - 1];
    const volumeConfirmed = avgVolume > 0 && currentVolume > avgVolume * this.volumeMultiplier;

    const position = ctx.state.get("position") as {
      side: "buy" | "sell"; entry: number; stop: number; tp: number;
    } | null;

    // If no position, look for breakout entry
    if (!position) {
      if (price > channelHigh && volumeConfirmed && currentATR > 0) {
        const stopDistance = currentATR * this.atrMultiplier;
        const stop = price - stopDistance;
        const tp = price + stopDistance * this.riskReward;
        ctx.state.set("position", { side: "buy", entry: price, stop, tp });
        ctx.log(`  [BREAKOUT] Long breakout @ $${price.toFixed(2)} | stop $${stop.toFixed(2)} | tp $${tp.toFixed(2)}`);
        actions.push({
          type: "place_order",
          side: "buy",
          price: price.toFixed(2),
          size: String(this.size),
          orderType: "market",
        });
      } else if (price < channelLow && volumeConfirmed && currentATR > 0) {
        const stopDistance = currentATR * this.atrMultiplier;
        const stop = price + stopDistance;
        const tp = price - stopDistance * this.riskReward;
        ctx.state.set("position", { side: "sell", entry: price, stop, tp });
        ctx.log(`  [BREAKOUT] Short breakout @ $${price.toFixed(2)} | stop $${stop.toFixed(2)} | tp $${tp.toFixed(2)}`);
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

    // Manage existing position — trailing stop + take profit
    if (position.side === "buy") {
      // Trail stop up
      const newStop = price - currentATR * this.atrMultiplier;
      if (newStop > position.stop) {
        position.stop = newStop;
        ctx.state.set("position", position);
      }
      // Check exit
      if (price <= position.stop || price >= position.tp) {
        const reason = price <= position.stop ? "stop" : "take-profit";
        ctx.log(`  [BREAKOUT] Close long (${reason}) @ $${price.toFixed(2)}`);
        ctx.state.set("position", null);
        actions.push({
          type: "place_order",
          side: "sell",
          price: price.toFixed(2),
          size: String(this.size),
          orderType: "market",
          reduceOnly: true,
        });
      }
    } else {
      // Trail stop down for short
      const newStop = price + currentATR * this.atrMultiplier;
      if (newStop < position.stop) {
        position.stop = newStop;
        ctx.state.set("position", position);
      }
      if (price >= position.stop || price <= position.tp) {
        const reason = price >= position.stop ? "stop" : "take-profit";
        ctx.log(`  [BREAKOUT] Close short (${reason}) @ $${price.toFixed(2)}`);
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
    }

    return actions;
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const position = ctx.state.get("position") as { side: "buy" | "sell" } | null;
    if (!position) return [];
    // Close position on stop
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

registerStrategy("momentum-breakout", (_config) => new MomentumBreakoutStrategy());
