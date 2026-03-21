import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import { calculateATR } from "../indicators.js";

interface AvellanedaMmConfig {
  gamma: number;        // risk aversion parameter
  kappa: number;        // order arrival rate estimate
  sigma: number;        // volatility override (0 = auto from ATR)
  maxPosition: number;  // maximum inventory
  timeHorizon: number;  // trading session length in seconds
  size: number;         // order size per level
}

export class AvellanedaMmStrategy implements Strategy {
  readonly name = "avellaneda-mm";

  describe() {
    return {
      description: "Avellaneda-Stoikov optimal market making with inventory-adjusted reservation price",
      params: [
        { name: "gamma", type: "number" as const, required: false, default: 0.1, description: "Risk aversion parameter" },
        { name: "kappa", type: "number" as const, required: false, default: 1.5, description: "Order arrival rate" },
        { name: "sigma", type: "number" as const, required: false, default: 0, description: "Volatility override (0 = auto)" },
        { name: "maxPosition", type: "number" as const, required: true, description: "Maximum position size" },
        { name: "timeHorizon", type: "number" as const, required: false, default: 86400, description: "Session length in seconds" },
        { name: "size", type: "number" as const, required: true, description: "Order size per level" },
      ],
    };
  }

  private get params(): AvellanedaMmConfig {
    return this._config as unknown as AvellanedaMmConfig;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("inventory", 0);
    ctx.state.set("sessionStart", Date.now());
    const p = this.params;
    ctx.log(`  [AVELLANEDA-MM] gamma=${p.gamma}, kappa=${p.kappa}, sigma=${p.sigma || "auto"}, maxPos=${p.maxPosition}, T=${p.timeHorizon}s`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const actions: StrategyAction[] = [];
    actions.push({ type: "cancel_all" });

    const gamma = params.gamma || 0.1;
    const kappa = params.kappa || 1.5;
    const mid = snapshot.price;

    // Estimate sigma (volatility) from ATR or use override
    const sigma = this.estimateSigma(snapshot, params.sigma);

    // Time remaining: fraction of session left
    const sessionStart = (ctx.state.get("sessionStart") as number) ?? Date.now();
    const elapsed = (Date.now() - sessionStart) / 1000;
    const timeHorizon = params.timeHorizon || 86400;
    const timeRemaining = Math.max(timeHorizon - elapsed, 1) / timeHorizon; // (T-t)/T normalized

    // Current inventory
    const q = (ctx.state.get("inventory") as number) ?? 0;

    // Avellaneda-Stoikov reservation price:
    // r = mid - q * gamma * sigma^2 * (T-t)
    const reservationPrice = mid - q * gamma * (sigma ** 2) * timeRemaining;

    // Optimal spread:
    // delta = gamma * sigma^2 * (T-t) + (2/gamma) * ln(1 + gamma/kappa)
    const optimalSpread = gamma * (sigma ** 2) * timeRemaining + (2 / gamma) * Math.log(1 + gamma / kappa);
    const spreadInPrice = optimalSpread * mid; // convert to price terms

    const bidPrice = reservationPrice - spreadInPrice / 2;
    const askPrice = reservationPrice + spreadInPrice / 2;

    // Clamp to max position: skip orders that would exceed
    const size = params.size;
    if (q < params.maxPosition && bidPrice > 0) {
      actions.push({
        type: "place_order",
        side: "buy",
        price: bidPrice.toFixed(6),
        size: String(size),
        orderType: "limit",
      });
    }

    if (q > -params.maxPosition && askPrice > 0) {
      actions.push({
        type: "place_order",
        side: "sell",
        price: askPrice.toFixed(6),
        size: String(size),
        orderType: "limit",
      });
    }

    // Update inventory estimate
    const prevMid = (ctx.state.get("prevMid") as number) ?? mid;
    if (mid > prevMid && q < params.maxPosition) {
      ctx.state.set("inventory", q + size * 0.5);
    } else if (mid < prevMid && q > -params.maxPosition) {
      ctx.state.set("inventory", q - size * 0.5);
    }
    ctx.state.set("prevMid", mid);

    if (ctx.tick % 10 === 0) {
      ctx.log(`  [AVELLANEDA-MM] r=$${reservationPrice.toFixed(2)}, spread=$${spreadInPrice.toFixed(4)}, q=${q.toFixed(4)}, sigma=${sigma.toFixed(6)}, T-t=${timeRemaining.toFixed(3)}`);
    }

    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }

  /** Estimate sigma from ATR or use override */
  private estimateSigma(snapshot: EnrichedSnapshot, sigmaOverride: number): number {
    if (sigmaOverride > 0) return sigmaOverride;

    if (snapshot.klines.length >= 15) {
      const candles = snapshot.klines.map(k => ({
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
      }));
      const atr = calculateATR(candles, 14);
      if (atr.length > 0) {
        // Normalize ATR to fractional volatility
        return atr[atr.length - 1] / snapshot.price;
      }
    }

    // Fallback: use 24h volatility from snapshot
    return snapshot.volatility24h / 100 || 0.02;
  }
}

registerStrategy("avellaneda-mm", (_config) => new AvellanedaMmStrategy());
