import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { registerStrategy } from "../strategy-registry.js";
import { toHourlyRate, computeAnnualSpread } from "../../funding/normalize.js";

/**
 * Minimum notional per exchange (USD):
 * - HL: ~$2 (0.001 ETH)
 * - PAC: $10
 * - LT: ~$21 (0.01 ETH)
 * Use $12 as safe minimum across all exchanges.
 */
const MIN_NOTIONAL_USD = 12;

/** Size precision per asset price range */
function formatSizeForPrice(rawSize: number, price: number): string {
  // Higher price → fewer decimals (BTC: 4, ETH: 3, SOL: 1, small coins: 0)
  if (price > 10000) return rawSize.toFixed(4);   // BTC
  if (price > 1000) return rawSize.toFixed(3);     // ETH
  if (price > 10) return rawSize.toFixed(2);       // SOL, AVAX
  if (price > 1) return rawSize.toFixed(1);        // DOGE, etc
  return rawSize.toFixed(0);                       // sub-$1 tokens
}

/**
 * Automated funding rate trading strategy — dual mode.
 *
 * Mode 1: Perp-Perp (opportunity mode)
 *   Scan funding rates across all exchanges, find largest spread,
 *   long on low-rate exchange, short on high-rate exchange.
 *
 * Mode 2: Spot-Perp (stable mode)
 *   Find symbols where perp funding is significantly positive,
 *   buy spot + short perp = delta neutral, collect funding.
 *
 * Core formula:
 *   Total Cost  = 2 * [(feeA + feeB + slippageA + slippageB) * notional]
 *   Hourly Income = |hourlyRateA - hourlyRateB| * notional
 *   Break-Even Hours = Total Cost / Hourly Income
 *   Entry if: breakEvenHours < maxHoldHours AND hourlyIncome > 0 AND spread > minSpread
 */

// ── Types ──

interface FundingOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longRate: number;
  shortRate: number;
  annualSpread: number;
  hourlyIncome: number; // for sizeUsd notional
  breakEvenHours: number;
  mode: "perp-perp" | "spot-perp";
}

interface ActivePosition {
  id: string;
  symbol: string;
  mode: "perp-perp" | "spot-perp";
  longExchange: string;
  shortExchange: string;
  entrySpread: number;
  entryTime: number;
  notional: number;
  totalCost: number; // entry + exit fees
  accumulatedFunding: number;
}

// ── Cost helpers ──

function calculateCosts(
  notional: number,
  feeA: number,
  feeB: number,
  slippageA: number,
  slippageB: number,
): { entryCost: number; totalCost: number } {
  const entryCost = (feeA + feeB + slippageA + slippageB) * notional;
  const totalCost = entryCost * 2; // entry + exit
  return { entryCost, totalCost };
}

function calculateBreakEven(totalCost: number, hourlyIncome: number): number {
  if (hourlyIncome <= 0) return Infinity;
  return totalCost / hourlyIncome;
}

// ── Strategy ──

class FundingAutoStrategy implements Strategy {
  readonly name = "funding-auto";

  private _config: Record<string, unknown> = {};

  // Config accessors
  private get spotPerpRatio(): number { return Number(this._config.spotPerpRatio ?? 0.7); }
  private get perpPerpRatio(): number { return Number(this._config.perpPerpRatio ?? 0.3); }
  private get perpPerpMinSpread(): number { return Number(this._config.perpPerpMinSpread ?? 20); }
  private get spotPerpMinSpread(): number { return Number(this._config.spotPerpMinSpread ?? 5); }
  private get perpPerpCloseSpread(): number { return Number(this._config.perpPerpCloseSpread ?? 5); }
  private get maxBreakEvenHours(): number { return Number(this._config.maxBreakEvenHours ?? 48); }
  private get maxPositions(): number { return Number(this._config.maxPositions ?? 5); }
  private get maxCapitalPct(): number { return Number(this._config.maxCapitalPct ?? 20); }
  private get defaultFeeRate(): number { return Number(this._config.defaultFeeRate ?? 0.0005); }
  private get defaultSlippage(): number { return Number(this._config.defaultSlippage ?? 0.001); }
  private get scanIntervalTicks(): number { return Number(this._config.scanIntervalTicks ?? 1); }
  /** Position size: min of sizeUsd (if set) and maxCapitalPct% of total equity */
  private _cachedEquity = 0;
  private getSizeUsd(): number {
    const fixedSize = Number(this._config.sizeUsd ?? 0);
    const capitalLimit = this._cachedEquity * (this.maxCapitalPct / 100);
    if (fixedSize > 0 && capitalLimit > 0) return Math.min(fixedSize, capitalLimit);
    if (capitalLimit > 0) return capitalLimit;
    return fixedSize > 0 ? fixedSize : 100; // fallback
  }

  describe() {
    return {
      description: "Automated funding rate trading - perp-perp + spot-perp dual mode",
      params: [
        { name: "spotPerpRatio", type: "number" as const, required: false, default: 0.7, description: "Capital ratio for spot-perp mode" },
        { name: "perpPerpRatio", type: "number" as const, required: false, default: 0.3, description: "Capital ratio for perp-perp mode" },
        { name: "perpPerpMinSpread", type: "number" as const, required: false, default: 20, description: "Min annualized spread % for perp-perp entry" },
        { name: "spotPerpMinSpread", type: "number" as const, required: false, default: 5, description: "Min annualized spread % for spot-perp entry" },
        { name: "perpPerpCloseSpread", type: "number" as const, required: false, default: 0, description: "Close perp-perp when spread reverses below this % (0 = only on reversal)" },
        { name: "maxBreakEvenHours", type: "number" as const, required: false, default: 48, description: "Max break-even hours to enter" },
        { name: "maxPositions", type: "number" as const, required: false, default: 5, description: "Max concurrent positions" },
        { name: "maxCapitalPct", type: "number" as const, required: false, default: 20, description: "Max % of total capital per position (e.g., 20 = 20%)" },
        { name: "defaultFeeRate", type: "number" as const, required: false, default: 0.0005, description: "Default taker fee rate (0.05%)" },
        { name: "defaultSlippage", type: "number" as const, required: false, default: 0.001, description: "Default slippage estimate (0.1%)" },
        { name: "scanIntervalTicks", type: "number" as const, required: false, default: 1, description: "Scan every N ticks" },
        { name: "sizeUsd", type: "number" as const, required: false, default: 0, description: "Fixed position size in USD (0 = use maxCapitalPct instead)" },
      ],
    };
  }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("positions", [] as ActivePosition[]);
    ctx.state.set("lastScan", 0);
    ctx.state.set("priceCache", new Map<string, number>());
    ctx.log(`[funding-auto] Starting with ${this.spotPerpRatio}/${this.perpPerpRatio} spot-perp/perp-perp split`);
  }

  async onTick(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const positions = (ctx.state.get("positions") as ActivePosition[]) ?? [];
    const now = Date.now();

    // Cache total equity for capital-based sizing
    try {
      const bal = await ctx.adapter.getBalance();
      this._cachedEquity = Number(bal.equity) || 0;
    } catch { /* keep previous cached value */ }

    // Get all adapters
    const adapters = this.getAdapters(ctx);
    if (adapters.size < 2) {
      ctx.log(`[funding-auto] Need 2+ exchanges, have ${adapters.size}. Skipping.`);
      return [];
    }

    // Fetch funding rates from all exchanges (price data cached for position sizing)
    const ratesByExchange = new Map<string, Map<string, { rate: number; price: number; exchange: string }>>();
    const priceCache = new Map<string, number>(); // "exchange:symbol" -> price
    for (const [name, adapter] of adapters) {
      try {
        const markets = await adapter.getMarkets();
        const map = new Map<string, { rate: number; price: number; exchange: string }>();
        for (const m of markets) {
          const sym = m.symbol.toUpperCase();
          const price = parseFloat(m.markPrice);
          map.set(sym, {
            rate: parseFloat(m.fundingRate),
            price,
            exchange: name,
          });
          if (price > 0) priceCache.set(`${name}:${sym}`, price);
        }
        ratesByExchange.set(name, map);
      } catch {
        // Skip unavailable exchange
      }
    }
    // Store priceCache for use by openPosition/closePosition
    ctx.state.set("priceCache", priceCache);

    // ── Phase 1: Monitor existing positions for exit ──
    const toClose: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];

      if (pos.mode === "perp-perp") {
        // Check if spread has converged below close threshold
        const longRates = ratesByExchange.get(pos.longExchange);
        const shortRates = ratesByExchange.get(pos.shortExchange);
        if (!longRates || !shortRates) continue;

        const longInfo = longRates.get(pos.symbol);
        const shortInfo = shortRates.get(pos.symbol);
        if (!longInfo || !shortInfo) continue;

        const currentSpread = computeAnnualSpread(
          shortInfo.rate, pos.shortExchange,
          longInfo.rate, pos.longExchange,
        );

        // Only close when spread REVERSES (≤ 0%) — never close a profitable position
        // A spread of 5% or even 2% still earns funding. Closing costs more than keeping.
        if (currentSpread <= 0) {
          ctx.log(`[funding-auto] Closing perp-perp ${pos.symbol}: spread REVERSED to ${currentSpread.toFixed(1)}% (entry was ${pos.entrySpread.toFixed(1)}%)`);
          await this.closePosition(ctx, pos, adapters);
          toClose.push(i);
        } else {
          // Track accumulated funding estimate
          const hourlyIncome = Math.abs(
            toHourlyRate(shortInfo.rate, pos.shortExchange) - toHourlyRate(longInfo.rate, pos.longExchange),
          ) * pos.notional;
          const hoursHeld = (now - pos.entryTime) / (1000 * 60 * 60);
          pos.accumulatedFunding = hourlyIncome * hoursHeld;
        }
      } else if (pos.mode === "spot-perp") {
        // Spot-perp: exit if perp funding flips negative (we are short perp)
        const shortRates = ratesByExchange.get(pos.shortExchange);
        if (!shortRates) continue;

        const shortInfo = shortRates.get(pos.symbol);
        if (!shortInfo) continue;

        const hourlyRate = toHourlyRate(shortInfo.rate, pos.shortExchange);
        const annualized = Math.abs(hourlyRate) * 8760 * 100;

        // Exit if funding flipped (rate went negative — shorts would pay instead of receive)
        if (shortInfo.rate < 0) {
          ctx.log(`[funding-auto] Closing spot-perp ${pos.symbol}: funding flipped negative (${(shortInfo.rate * 100).toFixed(4)}%)`);
          await this.closePosition(ctx, pos, adapters);
          toClose.push(i);
        } else {
          // Track accumulated funding
          const hoursHeld = (now - pos.entryTime) / (1000 * 60 * 60);
          pos.accumulatedFunding = Math.abs(hourlyRate) * pos.notional * hoursHeld;

          if (annualized < this.spotPerpMinSpread) {
            ctx.log(`[funding-auto] Spot-perp ${pos.symbol} annualized rate dropped to ${annualized.toFixed(1)}% — monitoring`);
          }
        }
      }
    }

    // Remove closed positions (reverse order to preserve indices)
    for (let i = toClose.length - 1; i >= 0; i--) {
      positions.splice(toClose[i], 1);
    }
    ctx.state.set("positions", positions);

    // ── Phase 2: Scan for new opportunities ──
    if (ctx.tick % this.scanIntervalTicks !== 0) return positions.length > 0 ? [{ type: "noop" }] : [];
    if (positions.length >= this.maxPositions) return [{ type: "noop" }];

    ctx.state.set("lastScan", now);

    const activeSymbols = new Set(positions.map(p => `${p.symbol}:${p.mode}`));
    const opportunities: FundingOpportunity[] = [];

    // Collect all symbols across exchanges
    const allSymbols = new Set<string>();
    for (const [, map] of ratesByExchange) {
      for (const sym of map.keys()) allSymbols.add(sym);
    }
    const exchangeNames = [...ratesByExchange.keys()];

    // ── Perp-Perp opportunities ──
    for (const sym of allSymbols) {
      if (activeSymbols.has(`${sym}:perp-perp`)) continue;

      let minRate = Infinity, maxRate = -Infinity;
      let minExchange = "", maxExchange = "";

      for (const exName of exchangeNames) {
        const info = ratesByExchange.get(exName)?.get(sym);
        if (!info) continue;
        const hourly = toHourlyRate(info.rate, exName);
        if (hourly < minRate) { minRate = hourly; minExchange = exName; }
        if (hourly > maxRate) { maxRate = hourly; maxExchange = exName; }
      }

      if (!minExchange || !maxExchange || minExchange === maxExchange) continue;

      // Need raw rates for computeAnnualSpread
      const longInfo = ratesByExchange.get(minExchange)!.get(sym)!;
      const shortInfo = ratesByExchange.get(maxExchange)!.get(sym)!;

      const annualSpread = computeAnnualSpread(
        shortInfo.rate, maxExchange,
        longInfo.rate, minExchange,
      );

      if (annualSpread < this.perpPerpMinSpread) continue;

      // Calculate cost and break-even
      const notional = this.getSizeUsd();
      const hourlyIncome = Math.abs(maxRate - minRate) * notional;
      const { totalCost } = calculateCosts(
        notional,
        this.defaultFeeRate, this.defaultFeeRate,
        this.defaultSlippage, this.defaultSlippage,
      );
      const breakEvenHours = calculateBreakEven(totalCost, hourlyIncome);

      if (breakEvenHours >= this.maxBreakEvenHours) continue;
      if (hourlyIncome <= 0) continue;

      opportunities.push({
        symbol: sym,
        longExchange: minExchange,
        shortExchange: maxExchange,
        longRate: longInfo.rate,
        shortRate: shortInfo.rate,
        annualSpread,
        hourlyIncome,
        breakEvenHours,
        mode: "perp-perp",
      });
    }

    // ── Spot-Perp opportunities ──
    for (const sym of allSymbols) {
      if (activeSymbols.has(`${sym}:spot-perp`)) continue;

      // Find exchange with highest positive funding rate
      let bestRate = 0;
      let bestExchange = "";

      for (const exName of exchangeNames) {
        const info = ratesByExchange.get(exName)?.get(sym);
        if (!info) continue;
        const hourly = toHourlyRate(info.rate, exName);
        if (hourly > bestRate) {
          bestRate = hourly;
          bestExchange = exName;
        }
      }

      if (!bestExchange || bestRate <= 0) continue;

      // Annualized rate (spot funding = 0, so spread = perp rate)
      const annualSpread = bestRate * 8760 * 100;
      if (annualSpread < this.spotPerpMinSpread) continue;

      // Calculate cost and break-even (spot side: typically lower fees, no funding)
      const notional = this.getSizeUsd();
      const hourlyIncome = bestRate * notional;
      const { totalCost } = calculateCosts(
        notional,
        this.defaultFeeRate, this.defaultFeeRate,
        this.defaultSlippage, this.defaultSlippage,
      );
      const breakEvenHours = calculateBreakEven(totalCost, hourlyIncome);

      if (breakEvenHours >= this.maxBreakEvenHours) continue;

      opportunities.push({
        symbol: sym,
        longExchange: bestExchange, // buy spot on same exchange (or primary)
        shortExchange: bestExchange,
        longRate: 0,
        shortRate: ratesByExchange.get(bestExchange)!.get(sym)!.rate,
        annualSpread,
        hourlyIncome,
        breakEvenHours,
        mode: "spot-perp",
      });
    }

    // Sort by break-even hours ascending (best opportunities first)
    opportunities.sort((a, b) => a.breakEvenHours - b.breakEvenHours);

    // ── Phase 3: Enter new positions ──
    const slotsAvailable = this.maxPositions - positions.length;

    // Allocate slots by ratio
    const perpPerpSlots = Math.max(1, Math.floor(slotsAvailable * this.perpPerpRatio));
    const spotPerpSlots = Math.max(1, slotsAvailable - perpPerpSlots);

    let perpPerpOpened = 0;
    let spotPerpOpened = 0;

    for (const opp of opportunities) {
      if (positions.length >= this.maxPositions) break;

      if (opp.mode === "perp-perp" && perpPerpOpened >= perpPerpSlots) continue;
      if (opp.mode === "spot-perp" && spotPerpOpened >= spotPerpSlots) continue;

      const success = await this.openPosition(ctx, opp, adapters);
      if (success) {
        const notional = this.getSizeUsd();
        const { totalCost } = calculateCosts(
          notional,
          this.defaultFeeRate, this.defaultFeeRate,
          this.defaultSlippage, this.defaultSlippage,
        );

        const pos: ActivePosition = {
          id: `${opp.mode}-${opp.symbol}-${Date.now()}`,
          symbol: opp.symbol,
          mode: opp.mode,
          longExchange: opp.longExchange,
          shortExchange: opp.shortExchange,
          entrySpread: opp.annualSpread,
          entryTime: now,
          notional,
          totalCost,
          accumulatedFunding: 0,
        };
        positions.push(pos);
        ctx.state.set("positions", positions);

        if (opp.mode === "perp-perp") perpPerpOpened++;
        else spotPerpOpened++;

        ctx.log(
          `[funding-auto] Opened ${opp.mode} ${opp.symbol}: spread ${opp.annualSpread.toFixed(1)}% | ` +
          `BE ${opp.breakEvenHours.toFixed(1)}h | income $${opp.hourlyIncome.toFixed(4)}/h | ` +
          `long ${opp.longExchange}, short ${opp.shortExchange} (${positions.length}/${this.maxPositions})`,
        );
      }
    }

    return [{ type: "noop" }];
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const positions = (ctx.state.get("positions") as ActivePosition[]) ?? [];
    if (positions.length === 0) {
      ctx.log("[funding-auto] No positions to close.");
      return [];
    }

    ctx.log(`[funding-auto] Stopping - closing ${positions.length} positions`);
    const adapters = this.getAdapters(ctx);

    for (const pos of positions) {
      try {
        await this.closePosition(ctx, pos, adapters);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`[funding-auto] Failed to close ${pos.symbol}: ${msg}`);
      }
    }

    ctx.state.set("positions", []);
    return [{ type: "cancel_all" }];
  }

  // ── Helpers ──

  private getAdapters(ctx: StrategyContext): Map<string, ExchangeAdapter> {
    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
    const extra = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
    if (extra) {
      for (const [name, a] of extra) adapters.set(name, a);
    }
    return adapters;
  }

  /** Resolve cached price for a symbol on a given exchange */
  private getCachedPrice(ctx: StrategyContext, exchange: string, symbol: string): number {
    const cache = ctx.state.get("priceCache") as Map<string, number> | undefined;
    return cache?.get(`${exchange}:${symbol}`) ?? 0;
  }

  /** Format size with exchange-appropriate precision based on asset price */
  private formatSize(rawSize: number, symbol: string): string {
    // Use price to determine precision
    const price = rawSize > 0 ? this.getSizeUsd() / rawSize : 0;
    return formatSizeForPrice(rawSize, price);
  }

  private async openPosition(
    ctx: StrategyContext,
    opp: FundingOpportunity,
    adapters: Map<string, ExchangeAdapter>,
  ): Promise<boolean> {
    if (opp.mode === "perp-perp") {
      const longAdapter = adapters.get(opp.longExchange);
      const shortAdapter = adapters.get(opp.shortExchange);
      if (!longAdapter || !shortAdapter) return false;

      const price = this.getCachedPrice(ctx, opp.longExchange, opp.symbol)
        || this.getCachedPrice(ctx, opp.shortExchange, opp.symbol);
      if (price <= 0) return false;

      const notionalUsd = this.getSizeUsd();
      const size = this.formatSize(notionalUsd / price, opp.symbol);

      // Minimum notional check — skip if below exchange minimums
      if (notionalUsd < MIN_NOTIONAL_USD) {
        ctx.log(`[funding-auto] Skip ${opp.symbol}: notional $${notionalUsd.toFixed(0)} < min $${MIN_NOTIONAL_USD}`);
        return false;
      }

      try {
        await Promise.all([
          longAdapter.marketOrder(opp.symbol, "buy", size),
          shortAdapter.marketOrder(opp.symbol, "sell", size),
        ]);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`[funding-auto] Perp-perp entry failed ${opp.symbol}: ${msg}`);
        return false;
      }
    } else {
      // spot-perp: short perp (spot buy would need spot adapter — use perp adapter for now)
      const shortAdapter = adapters.get(opp.shortExchange);
      if (!shortAdapter) return false;

      const price = this.getCachedPrice(ctx, opp.shortExchange, opp.symbol);
      if (price <= 0) return false;

      const notionalUsd = this.getSizeUsd();
      const size = this.formatSize(notionalUsd / price, opp.symbol);

      if (notionalUsd < MIN_NOTIONAL_USD) {
        ctx.log(`[funding-auto] Skip ${opp.symbol}: notional $${notionalUsd.toFixed(0)} < min $${MIN_NOTIONAL_USD}`);
        return false;
      }

      try {
        // Short perp leg — spot buy is out-of-scope for perp-only adapters
        await shortAdapter.marketOrder(opp.symbol, "sell", size);
        ctx.log(`[funding-auto] Spot-perp ${opp.symbol}: perp short opened (spot leg requires manual hedge or spot adapter)`);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`[funding-auto] Spot-perp entry failed ${opp.symbol}: ${msg}`);
        return false;
      }
    }
  }

  private async closePosition(
    ctx: StrategyContext,
    pos: ActivePosition,
    adapters: Map<string, ExchangeAdapter>,
  ): Promise<void> {
    if (pos.mode === "perp-perp") {
      const longAdapter = adapters.get(pos.longExchange);
      const shortAdapter = adapters.get(pos.shortExchange);

      const price = this.getCachedPrice(ctx, pos.longExchange, pos.symbol)
        || this.getCachedPrice(ctx, pos.shortExchange, pos.symbol);
      const size = price > 0 ? (pos.notional / price).toFixed(6) : "0";

      if (longAdapter && shortAdapter) {
        try {
          await Promise.all([
            longAdapter.marketOrder(pos.symbol, "sell", size),
            shortAdapter.marketOrder(pos.symbol, "buy", size),
          ]);
          ctx.log(`[funding-auto] Closed perp-perp ${pos.symbol} | accumulated ~$${pos.accumulatedFunding.toFixed(2)} funding`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`[funding-auto] Close failed ${pos.symbol}: ${msg}`);
        }
      }
    } else {
      // spot-perp: close perp short
      const shortAdapter = adapters.get(pos.shortExchange);
      if (!shortAdapter) return;

      const price = this.getCachedPrice(ctx, pos.shortExchange, pos.symbol);
      const size = price > 0 ? (pos.notional / price).toFixed(6) : "0";

      try {
        await shortAdapter.marketOrder(pos.symbol, "buy", size);
        ctx.log(`[funding-auto] Closed spot-perp ${pos.symbol} | accumulated ~$${pos.accumulatedFunding.toFixed(2)} funding`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`[funding-auto] Close failed ${pos.symbol}: ${msg}`);
      }
    }
  }
}

registerStrategy("funding-auto", (_config) => new FundingAutoStrategy());
