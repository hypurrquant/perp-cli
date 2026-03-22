import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import { calculateEMA, calculateVWAP, calculateATR } from "../indicators.js";

interface EngineMmConfig {
  baseSpread: number;   // basis points
  levels: number;       // 3-5 typical
  maxInventory: number;
  skewFactor: number;
  refreshSec: number;
}

export class EngineMmStrategy implements Strategy {
  readonly name = "engine-mm";

  describe() {
    return {
      description: "Production quoting engine with composite fair value and dynamic spread",
      params: [
        { name: "baseSpread", type: "number" as const, required: true, description: "Base spread in basis points" },
        { name: "levels", type: "number" as const, required: false, default: 3, description: "Number of levels each side (3-5)" },
        { name: "maxInventory", type: "number" as const, required: true, description: "Maximum inventory position" },
        { name: "skewFactor", type: "number" as const, required: false, default: 0.5, description: "Inventory skew factor (0-1)" },
        { name: "refreshSec", type: "number" as const, required: false, default: 5, description: "Minimum seconds between requotes" },
      ],
    };
  }

  private get params(): EngineMmConfig {
    return this._config as unknown as EngineMmConfig;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("inventory", 0);
    ctx.state.set("lastRefresh", 0);
    const p = this.params;
    ctx.log(`  [ENGINE-MM] baseSpread=${p.baseSpread}bps, levels=${p.levels}, maxInv=${p.maxInventory}, skew=${p.skewFactor}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const now = Date.now();
    const lastRefresh = (ctx.state.get("lastRefresh") as number) ?? 0;

    // Rate-limit requotes
    if (now - lastRefresh < (params.refreshSec ?? 5) * 1000) {
      return [{ type: "noop" }];
    }
    ctx.state.set("lastRefresh", now);

    const actions: StrategyAction[] = [];
    actions.push({ type: "cancel_all" });

    // Compute fair value: composite of VWAP + EMA(20) + mid-price + oracle (equal weight)
    const fairValue = this.computeFairValue(snapshot);

    // Compute dynamic spread: base_spread * (1 + volatility_factor * ATR/price)
    const dynamicSpread = this.computeDynamicSpread(snapshot);

    // Inventory skew: shift quotes away from heavy side
    const inventory = (ctx.state.get("inventory") as number) ?? 0;
    const inventoryRatio = params.maxInventory > 0 ? inventory / params.maxInventory : 0;
    const skew = inventoryRatio * (params.skewFactor ?? 0.5) * dynamicSpread;

    const levels = params.levels || 3;

    for (let i = 1; i <= levels; i++) {
      const levelSpread = dynamicSpread * (1 + (i - 1) * 0.5); // increasing spread per level
      const bidPrice = fairValue - levelSpread / 2 - skew;
      const askPrice = fairValue + levelSpread / 2 - skew;

      // Reduce size on heavy inventory side
      const baseSize = params.maxInventory / (levels * 2);
      const inventoryPenalty = Math.min(Math.abs(inventoryRatio), 0.8);
      const bidSize = inventory > 0 ? baseSize * (1 - inventoryPenalty) : baseSize;
      const askSize = inventory < 0 ? baseSize * (1 - inventoryPenalty) : baseSize;

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
    }

    // Update inventory estimate from price movement
    const prevMid = (ctx.state.get("prevMid") as number) ?? snapshot.price;
    if (snapshot.price > prevMid) {
      ctx.state.set("inventory", Math.min(inventory + (params.maxInventory / (levels * 4)), params.maxInventory));
    } else if (snapshot.price < prevMid) {
      ctx.state.set("inventory", Math.max(inventory - (params.maxInventory / (levels * 4)), -params.maxInventory));
    }
    ctx.state.set("prevMid", snapshot.price);

    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }

  /** Composite fair value: equal-weight VWAP + EMA(20) + mid-price + orderbook mid */
  private computeFairValue(snapshot: EnrichedSnapshot): number {
    const components: number[] = [];

    // Mid-price (always available)
    components.push(snapshot.price);

    // VWAP from klines
    if (snapshot.klines.length > 0) {
      const candles = snapshot.klines.map(k => ({
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
      }));
      const vwap = calculateVWAP(candles);
      if (vwap > 0) components.push(vwap);
    }

    // EMA(20) from klines
    if (snapshot.klines.length >= 20) {
      const closes = snapshot.klines.map(k => parseFloat(k.close));
      const ema = calculateEMA(closes, 20);
      if (ema.length > 0) components.push(ema[ema.length - 1]);
    }

    // Orderbook mid
    if (snapshot.orderbook.bids.length > 0 && snapshot.orderbook.asks.length > 0) {
      const bestBid = parseFloat(snapshot.orderbook.bids[0][0]);
      const bestAsk = parseFloat(snapshot.orderbook.asks[0][0]);
      if (bestBid > 0 && bestAsk > 0) {
        components.push((bestBid + bestAsk) / 2);
      }
    }

    return components.reduce((s, v) => s + v, 0) / components.length;
  }

  /** Dynamic spread: base_spread * (1 + volatility_factor * ATR/price) */
  private computeDynamicSpread(snapshot: EnrichedSnapshot): number {
    const baseSpreadFrac = this.params.baseSpread / 10000;
    let volatilityFactor = 1;

    if (snapshot.klines.length >= 15) {
      const candles = snapshot.klines.map(k => ({
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
      }));
      const atr = calculateATR(candles, 14);
      if (atr.length > 0) {
        const latestATR = atr[atr.length - 1];
        volatilityFactor = 1 + (latestATR / snapshot.price);
      }
    }

    return snapshot.price * baseSpreadFrac * volatilityFactor;
  }
}

registerStrategy("engine-mm", (_config) => new EngineMmStrategy());
