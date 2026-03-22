import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import {
  scoreOpportunity,
  detectPulse,
  tierRank,
  evaluateGuard,
  createGuardState,
  GUARD_PRESETS,
} from "../apex/index.js";
import type { RadarScore } from "../apex/index.js";
import type { PulseTier, PulseSignal } from "../apex/index.js";
import type { GuardConfig, GuardState } from "../apex/index.js";

/**
 * APEX Strategy: orchestrates Radar + Pulse + Guard.
 * Multi-slot: manages up to maxSlots concurrent positions.
 * Each tick: scan opportunities (Radar), detect momentum (Pulse), manage stops (Guard).
 */

interface ApexSlot {
  symbol: string;
  side: "buy" | "sell";
  entryPrice: number;
  size: number;
  guard: GuardState;
}

interface ApexConfig {
  maxSlots: number;
  minRadarScore: number;
  minPulseTier: PulseTier;
  guardPreset: string;
  dailyLossLimit: number;
  size: number;
  leverage: number;
}

const DEFAULT_CONFIG: ApexConfig = {
  maxSlots: 3,
  minRadarScore: 200,
  minPulseTier: "IMMEDIATE_MOVER",
  guardPreset: "moderate",
  dailyLossLimit: 250,
  size: 0.1,
  leverage: 5,
};

function resolveConfig(raw: Record<string, unknown>): ApexConfig {
  return {
    maxSlots: Number(raw.maxSlots ?? DEFAULT_CONFIG.maxSlots),
    minRadarScore: Number(raw.minRadarScore ?? DEFAULT_CONFIG.minRadarScore),
    minPulseTier: (raw.minPulseTier as PulseTier) ?? DEFAULT_CONFIG.minPulseTier,
    guardPreset: String(raw.guardPreset ?? DEFAULT_CONFIG.guardPreset),
    dailyLossLimit: Number(raw.dailyLossLimit ?? DEFAULT_CONFIG.dailyLossLimit),
    size: Number(raw.size ?? DEFAULT_CONFIG.size),
    leverage: Number(raw.leverage ?? DEFAULT_CONFIG.leverage),
  };
}

export class ApexStrategy implements Strategy {
  readonly name = "apex";

  private cfg: ApexConfig = DEFAULT_CONFIG;
  private guardConfig: GuardConfig = GUARD_PRESETS.moderate;
  private slots: ApexSlot[] = [];
  private pulseHistory = new Map<string, { oi: number; volume: number }[]>();
  private dailyLoss = 0;

  describe() {
    return {
      description: "APEX orchestrator: Radar screening + Pulse momentum + Guard trailing stops. Multi-slot concurrent positions.",
      params: [
        { name: "maxSlots", type: "number" as const, required: false, default: 3, description: "Max concurrent positions" },
        { name: "minRadarScore", type: "number" as const, required: false, default: 200, description: "Minimum Radar score to consider (0-400)" },
        { name: "minPulseTier", type: "string" as const, required: false, default: "IMMEDIATE_MOVER", description: "Minimum Pulse tier for entry" },
        { name: "guardPreset", type: "string" as const, required: false, default: "moderate", description: "Guard stop preset: conservative, moderate, aggressive" },
        { name: "dailyLossLimit", type: "number" as const, required: false, default: 250, description: "Daily loss limit in USD" },
        { name: "size", type: "number" as const, required: true, description: "Position size per slot" },
        { name: "leverage", type: "number" as const, required: false, default: 5, description: "Leverage to set on entry" },
      ],
    };
  }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this.cfg = resolveConfig(ctx.config);
    this.guardConfig = GUARD_PRESETS[this.cfg.guardPreset] ?? GUARD_PRESETS.moderate;
    this.slots = [];
    this.pulseHistory.clear();
    this.dailyLoss = 0;

    ctx.log(`  [APEX] Initialized | slots=${this.cfg.maxSlots} radar>=${this.cfg.minRadarScore} pulse>=${this.cfg.minPulseTier} guard=${this.cfg.guardPreset}`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const actions: StrategyAction[] = [];

    // Daily loss circuit breaker
    if (this.dailyLoss >= this.cfg.dailyLossLimit) {
      ctx.log(`  [APEX] Daily loss limit reached ($${this.dailyLoss.toFixed(2)}/$${this.cfg.dailyLossLimit})`);
      return [];
    }

    // ── Phase 1: Manage existing slots (Guard) ──
    const closedSlots: number[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const roe = this.calculateRoe(slot, snapshot.price);

      const { action, newState } = evaluateGuard(roe, slot.guard, this.guardConfig);
      slot.guard = newState;

      if (action === "close") {
        ctx.log(`  [APEX] Guard close slot ${slot.symbol} ${slot.side} | ROE=${roe.toFixed(2)}% floor=${newState.currentFloor.toFixed(2)}%`);
        actions.push({
          type: "place_order",
          side: slot.side === "buy" ? "sell" : "buy",
          price: snapshot.price.toFixed(2),
          size: String(slot.size),
          orderType: "market",
          reduceOnly: true,
        });

        // Track daily loss
        if (roe < 0) {
          this.dailyLoss += Math.abs(roe / 100) * slot.size * slot.entryPrice;
        }

        closedSlots.push(i);
      }
    }

    // Remove closed slots (reverse order to preserve indices)
    for (const idx of closedSlots.reverse()) {
      this.slots.splice(idx, 1);
    }

    // ── Phase 2: Record pulse history ──
    const currentOi = parseFloat(snapshot.openInterest);
    const currentVolume = snapshot.volume24h;
    const historyKey = ctx.symbol;

    const existing = this.pulseHistory.get(historyKey) ?? [];
    existing.push({ oi: currentOi, volume: currentVolume });
    // Keep last 10 entries
    if (existing.length > 10) existing.shift();
    this.pulseHistory.set(historyKey, existing);

    // ── Phase 3: Look for new entries if slots available ──
    if (this.slots.length < this.cfg.maxSlots) {
      // Already tracking this symbol in a slot?
      const symbolInSlot = this.slots.some(s => s.symbol === ctx.symbol);
      if (!symbolInSlot) {
        // Score with Radar
        const radarScore = scoreOpportunity(snapshot, null);
        radarScore.symbol = ctx.symbol;

        // Detect Pulse
        const pulse = detectPulse(snapshot, this.pulseHistory);
        pulse.symbol = ctx.symbol;

        const meetsRadar = radarScore.total >= this.cfg.minRadarScore;
        const meetsPulse = tierRank(pulse.tier) >= tierRank(this.cfg.minPulseTier);

        if (meetsRadar && meetsPulse) {
          // Determine direction from funding + technicals
          const side = this.determineSide(snapshot, radarScore, pulse);

          ctx.log(
            `  [APEX] Entry signal | ${ctx.symbol} ${side} | radar=${radarScore.total} pulse=${pulse.tier}(${pulse.confidence.toFixed(2)}) ` +
            `OI%=${(pulse.oiChange * 100).toFixed(1)} vol=${pulse.volumeRatio.toFixed(1)}x`
          );

          // Set leverage first
          actions.push({
            type: "set_leverage",
            leverage: this.cfg.leverage,
          });

          // Enter position
          actions.push({
            type: "place_order",
            side,
            price: snapshot.price.toFixed(2),
            size: String(this.cfg.size),
            orderType: "market",
          });

          this.slots.push({
            symbol: ctx.symbol,
            side,
            entryPrice: snapshot.price,
            size: this.cfg.size,
            guard: createGuardState(),
          });
        } else {
          ctx.log(
            `  [APEX] No entry | radar=${radarScore.total}/${this.cfg.minRadarScore} ` +
            `pulse=${pulse.tier} | slots=${this.slots.length}/${this.cfg.maxSlots}`
          );
        }
      }
    }

    return actions;
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const actions: StrategyAction[] = [];

    // Close all active slots
    for (const slot of this.slots) {
      ctx.log(`  [APEX] Closing slot ${slot.symbol} ${slot.side} on stop`);
      actions.push({
        type: "place_order",
        side: slot.side === "buy" ? "sell" : "buy",
        price: "0",
        size: String(slot.size),
        orderType: "market",
        reduceOnly: true,
      });
    }
    this.slots = [];

    return actions;
  }

  // ── Private helpers ──

  private calculateRoe(slot: ApexSlot, currentPrice: number): number {
    if (slot.entryPrice === 0) return 0;
    const priceDelta = currentPrice - slot.entryPrice;
    const direction = slot.side === "buy" ? 1 : -1;
    return (direction * priceDelta / slot.entryPrice) * 100;
  }

  private determineSide(
    snapshot: EnrichedSnapshot,
    _radarScore: RadarScore,
    _pulse: PulseSignal,
  ): "buy" | "sell" {
    // Funding-based bias: negative funding → longs are cheap → buy
    // Positive funding → shorts are cheap → sell
    const fr = snapshot.fundingRate;

    // RSI confirmation
    const rsi = snapshot.rsi;
    const rsiOversold = !isNaN(rsi) && rsi < 35;
    const rsiOverbought = !isNaN(rsi) && rsi > 65;

    if (fr < -0.0001 || rsiOversold) return "buy";
    if (fr > 0.0001 || rsiOverbought) return "sell";

    // Default to buy in ambiguous conditions
    return "buy";
  }
}

registerStrategy("apex", (_config) => new ApexStrategy());
