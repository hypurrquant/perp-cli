import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { registerStrategy } from "../strategy-registry.js";

/**
 * Enhanced funding rate arbitrage (multi-exchange) v2.
 * Auto-scans all available exchanges for funding rate divergence.
 * Position management: tracks entry spread, auto-closes when spread converges.
 * Wraps existing funding-arb logic but adds auto-close and multi-exchange scanning.
 */

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  entrySpread: number; // annualized spread at entry
  entryTime: number;
  sizeUsd: number;
}

export class FundingArbV2Strategy implements Strategy {
  readonly name = "funding-arb-v2";

  private _config: Record<string, unknown> = {};

  describe() {
    return {
      description: "Enhanced multi-exchange funding rate arbitrage with auto-close",
      params: [
        { name: "minSpread", type: "number" as const, required: false, default: 20, description: "Min annualized spread % to open" },
        { name: "closeSpread", type: "number" as const, required: false, default: 5, description: "Spread % to close position" },
        { name: "maxPositions", type: "number" as const, required: false, default: 3, description: "Max concurrent arb positions" },
        { name: "sizeUsd", type: "number" as const, required: true, description: "Position size in USD per leg" },
        { name: "scanIntervalSec", type: "number" as const, required: false, default: 60, description: "Seconds between full exchange scans" },
      ],
    };
  }

  private get minSpread(): number { return Number(this._config.minSpread ?? 20); }
  private get closeSpread(): number { return Number(this._config.closeSpread ?? 5); }
  private get maxPositions(): number { return Number(this._config.maxPositions ?? 3); }
  private get sizeUsd(): number { return Number(this._config.sizeUsd ?? 50); }
  private get scanIntervalSec(): number { return Number(this._config.scanIntervalSec ?? 60); }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("positions", [] as ArbPosition[]);
    ctx.state.set("lastScan", 0);
    ctx.log(`  [ARB-V2] Ready | minSpread=${this.minSpread}% closeSpread=${this.closeSpread}% maxPos=${this.maxPositions} size=$${this.sizeUsd}`);
  }

  async onTick(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const positions = ctx.state.get("positions") as ArbPosition[];
    const lastScan = ctx.state.get("lastScan") as number;
    const now = Date.now();

    // Throttle scanning
    if (now - lastScan < this.scanIntervalSec * 1000) {
      return [];
    }
    ctx.state.set("lastScan", now);

    // Get all adapters
    const adapters = this.getAdapters(ctx);
    if (adapters.size < 2) {
      ctx.log(`  [ARB-V2] Need 2+ exchanges, have ${adapters.size}. Skipping.`);
      return [];
    }

    // Fetch funding rates from all exchanges
    const ratesByExchange = new Map<string, Map<string, { rate: number; price: number }>>();
    for (const [name, adapter] of adapters) {
      try {
        const markets = await adapter.getMarkets();
        const map = new Map<string, { rate: number; price: number }>();
        for (const m of markets) {
          map.set(m.symbol.toUpperCase(), {
            rate: m.fundingRate != null ? parseFloat(m.fundingRate) : NaN,
            price: parseFloat(m.markPrice),
          });
        }
        ratesByExchange.set(name, map);
      } catch {
        // Skip unavailable exchange
      }
    }

    // Phase 1: Check existing positions for auto-close
    const toClose: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const longRates = ratesByExchange.get(pos.longExchange);
      const shortRates = ratesByExchange.get(pos.shortExchange);
      if (!longRates || !shortRates) continue;

      const longInfo = longRates.get(pos.symbol);
      const shortInfo = shortRates.get(pos.symbol);
      if (!longInfo || !shortInfo) continue;

      const currentSpread = this.annualizeSpread(shortInfo.rate, longInfo.rate);

      if (currentSpread <= this.closeSpread) {
        ctx.log(`  [ARB-V2] Auto-close ${pos.symbol}: spread ${currentSpread.toFixed(1)}% <= ${this.closeSpread}% (entry was ${pos.entrySpread.toFixed(1)}%)`);
        // Close both legs
        const longAdapter = adapters.get(pos.longExchange);
        const shortAdapter = adapters.get(pos.shortExchange);
        if (longAdapter && shortAdapter) {
          const price = longInfo.price;
          const size = price > 0 ? (pos.sizeUsd / price).toFixed(6) : "0";
          try {
            await Promise.all([
              longAdapter.marketOrder(pos.symbol, "sell", size),
              shortAdapter.marketOrder(pos.symbol, "buy", size),
            ]);
            ctx.log(`  [ARB-V2] Closed ${pos.symbol} (long ${pos.longExchange}, short ${pos.shortExchange})`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`  [ARB-V2] Close failed for ${pos.symbol}: ${msg}`);
            continue; // Don't mark as closed
          }
        }
        toClose.push(i);
      }
    }

    // Remove closed positions (reverse order to preserve indices)
    for (let i = toClose.length - 1; i >= 0; i--) {
      positions.splice(toClose[i], 1);
    }
    ctx.state.set("positions", positions);

    // Phase 2: Scan for new opportunities
    if (positions.length >= this.maxPositions) return [];

    const exchangeNames = [...ratesByExchange.keys()];
    const allSymbols = new Set<string>();
    for (const [, map] of ratesByExchange) {
      for (const sym of map.keys()) allSymbols.add(sym);
    }

    // Skip symbols we already have positions for
    const activeSymbols = new Set(positions.map(p => p.symbol));

    interface Opportunity {
      symbol: string;
      longExchange: string;
      shortExchange: string;
      spread: number;
      price: number;
    }
    const opportunities: Opportunity[] = [];

    for (const sym of allSymbols) {
      if (activeSymbols.has(sym)) continue;

      let minRate = Infinity, maxRate = -Infinity;
      let minExchange = "", maxExchange = "";
      let bestPrice = 0;

      for (const exName of exchangeNames) {
        const info = ratesByExchange.get(exName)?.get(sym);
        if (!info) continue;
        if (info.rate < minRate) { minRate = info.rate; minExchange = exName; }
        if (info.rate > maxRate) { maxRate = info.rate; maxExchange = exName; bestPrice = info.price; }
      }

      if (minExchange && maxExchange && minExchange !== maxExchange) {
        const spread = this.annualizeSpread(maxRate, minRate);
        if (spread >= this.minSpread) {
          opportunities.push({
            symbol: sym,
            longExchange: minExchange,  // long where rate is lowest
            shortExchange: maxExchange, // short where rate is highest
            spread,
            price: bestPrice,
          });
        }
      }
    }

    opportunities.sort((a, b) => b.spread - a.spread);

    // Open new positions
    const slotsAvailable = this.maxPositions - positions.length;
    const toOpen = opportunities.slice(0, slotsAvailable);

    for (const opp of toOpen) {
      const longAdapter = adapters.get(opp.longExchange);
      const shortAdapter = adapters.get(opp.shortExchange);
      if (!longAdapter || !shortAdapter || opp.price <= 0) continue;

      const size = (this.sizeUsd / opp.price).toFixed(6);
      try {
        ctx.log(`  [ARB-V2] Opening ${opp.symbol}: spread ${opp.spread.toFixed(1)}% (long ${opp.longExchange}, short ${opp.shortExchange})`);
        await Promise.all([
          longAdapter.marketOrder(opp.symbol, "buy", size),
          shortAdapter.marketOrder(opp.symbol, "sell", size),
        ]);
        positions.push({
          symbol: opp.symbol,
          longExchange: opp.longExchange,
          shortExchange: opp.shortExchange,
          entrySpread: opp.spread,
          entryTime: now,
          sizeUsd: this.sizeUsd,
        });
        ctx.log(`  [ARB-V2] Position opened! (${positions.length}/${this.maxPositions})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARB-V2] Execution failed: ${msg}`);
      }
    }

    ctx.state.set("positions", positions);

    // Return noop — arb executes directly via multi-adapter coordination
    return positions.length > 0 || toOpen.length > 0 ? [{ type: "noop" }] : [];
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const positions = ctx.state.get("positions") as ArbPosition[];
    if (positions.length === 0) return [];

    const adapters = this.getAdapters(ctx);
    for (const pos of positions) {
      const longAdapter = adapters.get(pos.longExchange);
      const shortAdapter = adapters.get(pos.shortExchange);
      if (longAdapter && shortAdapter) {
        try {
          // Best-effort close all legs
          await Promise.all([
            longAdapter.cancelAllOrders(pos.symbol),
            shortAdapter.cancelAllOrders(pos.symbol),
          ]);
        } catch { /* best effort */ }
      }
    }
    ctx.state.set("positions", []);
    return [{ type: "cancel_all" }];
  }

  private getAdapters(ctx: StrategyContext): Map<string, ExchangeAdapter> {
    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
    const extra = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
    if (extra) {
      for (const [name, a] of extra) adapters.set(name, a);
    }
    return adapters;
  }

  /** Convert 8h funding rate difference to annualized spread % */
  private annualizeSpread(highRate: number, lowRate: number): number {
    // Funding is typically per 8h period = 3x daily = 1095x annual
    const spreadPer8h = highRate - lowRate;
    return spreadPer8h * 3 * 365 * 100; // annualized %
  }
}

registerStrategy("funding-arb-v2", (_config) => new FundingArbV2Strategy());
