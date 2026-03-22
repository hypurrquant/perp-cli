import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";

/**
 * Basis arbitrage strategy.
 * Trades implied basis from funding rates.
 * - When annualized funding rate exceeds threshold, take opposite position
 *   to collect funding payments.
 * - E.g., if funding is very positive (longs pay shorts) -> go short to collect.
 * - Exit when funding normalizes below threshold or holding period expires.
 */

interface BasisPosition {
  side: "buy" | "sell";
  entry: number;
  entryFunding: number;   // funding rate at entry
  entryTime: number;
  size: number;
}

export class BasisArbStrategy implements Strategy {
  readonly name = "basis-arb";

  private _config: Record<string, unknown> = {};

  describe() {
    return {
      description: "Basis arbitrage — collect funding by positioning against extreme rates",
      params: [
        { name: "annualizedBasisThreshold", type: "number" as const, required: false, default: 30, description: "Annualized funding % to trigger entry" },
        { name: "size", type: "number" as const, required: true, description: "Position size" },
        { name: "holdingPeriodHours", type: "number" as const, required: false, default: 24, description: "Max hours to hold position" },
      ],
    };
  }

  private get annualizedBasisThreshold(): number { return Number(this._config.annualizedBasisThreshold ?? 30); }
  private get size(): number { return Number(this._config.size ?? 0.1); }
  private get holdingPeriodHours(): number { return Number(this._config.holdingPeriodHours ?? 24); }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("position", null as BasisPosition | null);
    ctx.log(`  [BASIS] Ready | threshold=${this.annualizedBasisThreshold}% holdingPeriod=${this.holdingPeriodHours}h size=${this.size}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const actions: StrategyAction[] = [];
    const price = snapshot.price;
    const fundingRate = snapshot.fundingRate;

    // Annualize: funding is per 8h period -> 3x daily -> 1095x annual
    const annualized = fundingRate * 3 * 365 * 100; // in %

    const position = ctx.state.get("position") as BasisPosition | null;

    if (!position) {
      // Check for entry signal
      if (Math.abs(annualized) >= this.annualizedBasisThreshold) {
        // Positive funding = longs pay shorts -> go short to collect
        // Negative funding = shorts pay longs -> go long to collect
        const side: "buy" | "sell" = annualized > 0 ? "sell" : "buy";
        const newPosition: BasisPosition = {
          side,
          entry: price,
          entryFunding: fundingRate,
          entryTime: Date.now(),
          size: this.size,
        };
        ctx.state.set("position", newPosition);
        ctx.log(`  [BASIS] ${side.toUpperCase()} @ $${price.toFixed(2)} | funding=${annualized.toFixed(1)}% annualized (collecting ${side === "sell" ? "positive" : "negative"} funding)`);
        actions.push({
          type: "place_order",
          side,
          price: price.toFixed(2),
          size: String(this.size),
          orderType: "market",
        });
      }
      return actions;
    }

    // Manage existing position — check exit conditions
    const hoursHeld = (Date.now() - position.entryTime) / (1000 * 60 * 60);
    const currentAnnualized = Math.abs(annualized);
    const holdingExpired = hoursHeld >= this.holdingPeriodHours;

    // Exit when funding normalizes (< threshold/2 for hysteresis) or holding period expires
    const fundingNormalized = currentAnnualized < this.annualizedBasisThreshold / 2;

    // Also exit if funding flipped against us
    const fundingFlipped = (position.side === "sell" && annualized < 0) ||
                           (position.side === "buy" && annualized > 0);

    if (holdingExpired || fundingNormalized || fundingFlipped) {
      const reason = holdingExpired
        ? `holding period ${this.holdingPeriodHours}h expired`
        : fundingFlipped
          ? "funding flipped against position"
          : `funding normalized (${currentAnnualized.toFixed(1)}%)`;

      ctx.log(`  [BASIS] Close ${position.side} @ $${price.toFixed(2)} — ${reason} (held ${hoursHeld.toFixed(1)}h)`);
      ctx.state.set("position", null);
      actions.push({
        type: "place_order",
        side: position.side === "buy" ? "sell" : "buy",
        price: price.toFixed(2),
        size: String(position.size),
        orderType: "market",
        reduceOnly: true,
      });
    }

    return actions;
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const position = ctx.state.get("position") as BasisPosition | null;
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

registerStrategy("basis-arb", (_config) => new BasisArbStrategy());
