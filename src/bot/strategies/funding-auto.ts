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

/** Normalize exchange symbol to base asset: "ETH-PERP" → "ETH", "ETHUSDT" → "ETH" */
function normalizeSymbol(raw: string): string {
  return raw.toUpperCase().replace(/-PERP$/, "").replace(/USDT$/, "").replace(/USD$/, "").replace(/-USD$/, "");
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
 *
 * Position tracking: discovered from live exchange data every tick (survives restarts).
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
  longSize: number;       // actual size from exchange
  shortSize: number;      // actual size from exchange
  longSymbol: string;     // raw exchange symbol for order execution
  shortSymbol: string;    // raw exchange symbol for order execution
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
    ctx.state.set("lastScan", 0);
    ctx.state.set("priceCache", new Map<string, number>());
    ctx.log(`[funding-auto] Starting with ${this.spotPerpRatio}/${this.perpPerpRatio} spot-perp/perp-perp split`);
  }

  async onTick(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    // Cache total equity across ALL exchanges for capital-based sizing
    try {
      const adapters = this.getAdapters(ctx);
      let totalEquity = 0;
      for (const [, adapter] of adapters) {
        try {
          const bal = await adapter.getBalance();
          totalEquity += Number(bal.equity) || 0;
        } catch { /* skip */ }
      }
      this._cachedEquity = totalEquity > 0 ? totalEquity : this._cachedEquity;
    } catch { /* keep previous cached value */ }

    // Get all adapters
    const adapters = this.getAdapters(ctx);
    if (adapters.size < 2) {
      ctx.log(`[funding-auto] Need 2+ exchanges, have ${adapters.size}. Skipping.`);
      return [];
    }

    // ── Discover existing arb pairs from live exchange positions ──
    const positions = await this.discoverArbPairs(adapters);

    // Fetch funding rates from all exchanges (price data cached for position sizing)
    const ratesByExchange = new Map<string, Map<string, { rate: number; price: number; exchange: string }>>();
    const priceCache = new Map<string, number>(); // "exchange:symbol" -> price
    for (const [name, adapter] of adapters) {
      try {
        const markets = await adapter.getMarkets();
        const map = new Map<string, { rate: number; price: number; exchange: string }>();
        for (const m of markets) {
          const raw = m.symbol.toUpperCase();
          const sym = normalizeSymbol(raw);
          const price = parseFloat(m.markPrice);
          map.set(sym, {
            rate: parseFloat(m.fundingRate),
            price,
            exchange: name,
          });
          if (price > 0) {
            priceCache.set(`${name}:${sym}`, price);
            priceCache.set(`${name}:${raw}`, price); // keep raw for order execution
          }
        }
        ratesByExchange.set(name, map);
      } catch {
        // Skip unavailable exchange
      }
    }
    // Store priceCache for use by openPosition/closePosition
    ctx.state.set("priceCache", priceCache);

    // Calculate notional for discovered positions (using current price)
    for (const pos of positions) {
      const price = priceCache.get(`${pos.longExchange}:${pos.symbol}`)
        || priceCache.get(`${pos.shortExchange}:${pos.symbol}`) || 0;
      if (price > 0) {
        pos.notional = Math.max(pos.longSize, pos.shortSize) * price;
      }
    }

    // ── Phase 1: Monitor existing positions for exit ──
    const surviving: ActivePosition[] = [];
    for (const pos of positions) {
      if (pos.mode === "perp-perp") {
        // Check if spread has converged below close threshold
        const longRates = ratesByExchange.get(pos.longExchange);
        const shortRates = ratesByExchange.get(pos.shortExchange);
        if (!longRates || !shortRates) { surviving.push(pos); continue; }

        const longInfo = longRates.get(pos.symbol);
        const shortInfo = shortRates.get(pos.symbol);
        if (!longInfo || !shortInfo) { surviving.push(pos); continue; }

        const currentSpread = computeAnnualSpread(
          shortInfo.rate, pos.shortExchange,
          longInfo.rate, pos.longExchange,
        );

        // Calculate real P&L from exchange history
        const [longPnl, shortPnl] = await Promise.all([
          this.calculateRealPnl(adapters.get(pos.longExchange)!, pos.symbol),
          this.calculateRealPnl(adapters.get(pos.shortExchange)!, pos.symbol),
        ]);
        const totalFees = longPnl.fees + shortPnl.fees;
        const totalFunding = longPnl.funding + shortPnl.funding;
        pos.accumulatedFunding = totalFunding;
        pos.totalCost = totalFees;

        ctx.log(
          `[funding-auto] ${pos.symbol} spread ${currentSpread.toFixed(1)}% | ` +
          `fees $${totalFees.toFixed(4)} | funding $${totalFunding.toFixed(4)} | ` +
          `net $${(totalFunding - totalFees).toFixed(4)} (${pos.longExchange}↔${pos.shortExchange})`,
        );

        // Only close when spread REVERSES (≤ 0%) — never close a profitable position
        // A spread of 5% or even 2% still earns funding. Closing costs more than keeping.
        if (currentSpread <= 0) {
          ctx.log(`[funding-auto] Closing perp-perp ${pos.symbol}: spread REVERSED to ${currentSpread.toFixed(1)}%`);
          await this.closePosition(ctx, pos, adapters);
        } else {
          surviving.push(pos);
        }
      } else if (pos.mode === "spot-perp") {
        // Spot-perp: exit if perp funding flips negative (we are short perp)
        const shortRates = ratesByExchange.get(pos.shortExchange);
        if (!shortRates) { surviving.push(pos); continue; }

        const shortInfo = shortRates.get(pos.symbol);
        if (!shortInfo) { surviving.push(pos); continue; }

        const hourlyRate = toHourlyRate(shortInfo.rate, pos.shortExchange);
        const annualized = Math.abs(hourlyRate) * 8760 * 100;

        const pnl = await this.calculateRealPnl(adapters.get(pos.shortExchange)!, pos.symbol);
        pos.accumulatedFunding = pnl.funding;
        pos.totalCost = pnl.fees;

        ctx.log(
          `[funding-auto] ${pos.symbol} rate ${annualized.toFixed(1)}% | ` +
          `fees $${pnl.fees.toFixed(4)} | funding $${pnl.funding.toFixed(4)} | ` +
          `net $${(pnl.funding - pnl.fees).toFixed(4)} (${pos.shortExchange})`,
        );

        // Exit if funding flipped (rate went negative — shorts would pay instead of receive)
        if (shortInfo.rate < 0) {
          ctx.log(`[funding-auto] Closing spot-perp ${pos.symbol}: funding flipped negative (${(shortInfo.rate * 100).toFixed(4)}%)`);
          await this.closePosition(ctx, pos, adapters);
        } else {
          if (annualized < this.spotPerpMinSpread) {
            ctx.log(`[funding-auto] Spot-perp ${pos.symbol} annualized rate dropped to ${annualized.toFixed(1)}% — monitoring`);
          }
          surviving.push(pos);
        }
      }
    }

    // ── Phase 2: Scan for new opportunities ──
    if (ctx.tick % this.scanIntervalTicks !== 0) return surviving.length > 0 ? [{ type: "noop" }] : [];
    if (surviving.length >= this.maxPositions) return [{ type: "noop" }];

    ctx.state.set("lastScan", Date.now());

    ctx.log(`[funding-auto] Scanning ${ratesByExchange.size} exchanges, equity: $${this._cachedEquity.toFixed(2)}, size: $${this.getSizeUsd().toFixed(2)}/pos, active: ${surviving.length}`);

    const activeSymbols = new Set(surviving.map(p => `${p.symbol}:${p.mode}`));
    // Also block symbols we already tried to enter (prevents re-entry on failed/tiny orders)
    const attempted = (ctx.state.get("attemptedSymbols") as Set<string>) ?? new Set<string>();
    for (const sym of attempted) activeSymbols.add(sym);
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

    if (opportunities.length > 0) {
      const top = opportunities.slice(0, 3);
      for (const o of top) {
        ctx.log(`[funding-auto] ${o.mode} ${o.symbol}: spread ${o.annualSpread.toFixed(1)}%, BE ${o.breakEvenHours.toFixed(0)}h, income $${(o.hourlyIncome * 24).toFixed(4)}/day (${o.longExchange}↔${o.shortExchange})`);
      }
    } else {
      ctx.log(`[funding-auto] No opportunities found (perp-perp min ${this.perpPerpMinSpread}%, spot-perp min ${this.spotPerpMinSpread}%, BE max ${this.maxBreakEvenHours}h)`);
    }

    // ── Phase 3: Enter new positions ──
    const slotsAvailable = this.maxPositions - surviving.length;

    // Allocate slots by ratio
    const perpPerpSlots = Math.max(1, Math.floor(slotsAvailable * this.perpPerpRatio));
    const spotPerpSlots = Math.max(1, slotsAvailable - perpPerpSlots);

    let perpPerpOpened = 0;
    let spotPerpOpened = 0;
    let currentCount = surviving.length;

    for (const opp of opportunities) {
      if (currentCount >= this.maxPositions) break;

      if (opp.mode === "perp-perp" && perpPerpOpened >= perpPerpSlots) continue;
      if (opp.mode === "spot-perp" && spotPerpOpened >= spotPerpSlots) continue;

      // Track attempted symbols to prevent re-entry on same tick cycle
      attempted.add(`${opp.symbol}:${opp.mode}`);
      ctx.state.set("attemptedSymbols", attempted);

      const success = await this.openPosition(ctx, opp, adapters);
      if (success) {
        currentCount++;

        if (opp.mode === "perp-perp") perpPerpOpened++;
        else spotPerpOpened++;

        ctx.log(
          `[funding-auto] Opened ${opp.mode} ${opp.symbol}: spread ${opp.annualSpread.toFixed(1)}% | ` +
          `BE ${opp.breakEvenHours.toFixed(1)}h | income $${opp.hourlyIncome.toFixed(4)}/h | ` +
          `long ${opp.longExchange}, short ${opp.shortExchange} (${currentCount}/${this.maxPositions})`,
        );
      }
    }

    return [{ type: "noop" }];
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const adapters = this.getAdapters(ctx);
    const positions = await this.discoverArbPairs(adapters);

    if (positions.length === 0) {
      ctx.log("[funding-auto] No positions to close.");
      return [];
    }

    ctx.log(`[funding-auto] Stopping - closing ${positions.length} positions`);

    for (const pos of positions) {
      try {
        await this.closePosition(ctx, pos, adapters);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`[funding-auto] Failed to close ${pos.symbol}: ${msg}`);
      }
    }

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
  private formatSize(rawSize: number, _symbol: string): string {
    // Use price to determine precision
    const price = rawSize > 0 ? this.getSizeUsd() / rawSize : 0;
    return formatSizeForPrice(rawSize, price);
  }

  /** Discover existing arb pairs from live exchange positions */
  private async discoverArbPairs(adapters: Map<string, ExchangeAdapter>): Promise<ActivePosition[]> {
    const allPositions = new Map<string, { exchange: string; side: string; size: number; symbol: string }[]>();

    for (const [name, adapter] of adapters) {
      try {
        const exchangePositions = await adapter.getPositions();
        for (const p of exchangePositions) {
          const sym = normalizeSymbol(p.symbol);
          if (!allPositions.has(sym)) allPositions.set(sym, []);
          allPositions.get(sym)!.push({
            exchange: name,
            side: p.side,
            size: Math.abs(Number(p.size)),
            symbol: p.symbol, // raw for order execution
          });
        }
      } catch { /* skip unavailable exchange */ }
    }

    // Find arb pairs: same symbol, opposite sides, different exchanges = perp-perp
    const pairs: ActivePosition[] = [];
    const matchedShorts = new Set<string>(); // track shorts already matched to perp-perp

    for (const [sym, positionList] of allPositions) {
      const longs = positionList.filter(p => p.side === "long");
      const shorts = positionList.filter(p => p.side === "short");

      for (const long of longs) {
        for (const short of shorts) {
          if (long.exchange !== short.exchange) {
            pairs.push({
              id: `${sym}-${long.exchange}-${short.exchange}`,
              symbol: sym,
              mode: "perp-perp",
              longExchange: long.exchange,
              shortExchange: short.exchange,
              longSize: long.size,
              shortSize: short.size,
              longSymbol: long.symbol,
              shortSymbol: short.symbol,
              entrySpread: 0,
              entryTime: 0,
              notional: 0,
              totalCost: 0,
              accumulatedFunding: 0,
            });
            matchedShorts.add(`${sym}:${short.exchange}`);
          }
        }
      }

      // Unmatched shorts (no cross-exchange long counterpart) = spot-perp positions
      for (const short of shorts) {
        if (!matchedShorts.has(`${sym}:${short.exchange}`)) {
          pairs.push({
            id: `${sym}-spot-${short.exchange}`,
            symbol: sym,
            mode: "spot-perp",
            longExchange: short.exchange, // spot leg on same exchange
            shortExchange: short.exchange,
            longSize: 0,
            shortSize: short.size,
            longSymbol: "",
            shortSymbol: short.symbol,
            entrySpread: 0,
            entryTime: 0,
            notional: 0,
            totalCost: 0,
            accumulatedFunding: 0,
          });
        }
      }
    }
    return pairs;
  }

  /** Calculate actual P&L from exchange trade/funding history */
  private async calculateRealPnl(
    adapter: ExchangeAdapter,
    symbol: string,
  ): Promise<{ fees: number; funding: number }> {
    try {
      const [trades, funding] = await Promise.all([
        adapter.getTradeHistory(50),
        adapter.getFundingPayments(50),
      ]);

      const symTrades = trades.filter(t => normalizeSymbol(t.symbol) === symbol);
      const symFunding = funding.filter(f => normalizeSymbol(f.symbol) === symbol);

      const totalFees = symTrades.reduce((s, t) => s + Math.abs(Number(t.fee)), 0);
      const totalFunding = symFunding.reduce((s, f) => s + Number(f.payment), 0);

      return { fees: totalFees, funding: totalFunding };
    } catch {
      return { fees: 0, funding: 0 };
    }
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

      if (longAdapter && shortAdapter) {
        // Use actual sizes from exchange positions, with raw exchange symbols
        const longSize = formatSizeForPrice(pos.longSize, pos.longSize > 0 && pos.notional > 0 ? pos.notional / pos.longSize : 0);
        const shortSize = formatSizeForPrice(pos.shortSize, pos.shortSize > 0 && pos.notional > 0 ? pos.notional / pos.shortSize : 0);

        try {
          await Promise.all([
            longAdapter.marketOrder(pos.longSymbol, "sell", longSize),
            shortAdapter.marketOrder(pos.shortSymbol, "buy", shortSize),
          ]);
          const netPnl = pos.accumulatedFunding - pos.totalCost;
          ctx.log(`[funding-auto] Closed perp-perp ${pos.symbol} | funding $${pos.accumulatedFunding.toFixed(4)} - fees $${pos.totalCost.toFixed(4)} = net $${netPnl.toFixed(4)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`[funding-auto] Close failed ${pos.symbol}: ${msg}`);
        }
      }
    } else {
      // spot-perp: close perp short
      const shortAdapter = adapters.get(pos.shortExchange);
      if (!shortAdapter) return;

      const shortSize = formatSizeForPrice(pos.shortSize, pos.shortSize > 0 && pos.notional > 0 ? pos.notional / pos.shortSize : 0);

      try {
        await shortAdapter.marketOrder(pos.shortSymbol, "buy", shortSize);
        const netPnl = pos.accumulatedFunding - pos.totalCost;
        ctx.log(`[funding-auto] Closed spot-perp ${pos.symbol} | funding $${pos.accumulatedFunding.toFixed(4)} - fees $${pos.totalCost.toFixed(4)} = net $${netPnl.toFixed(4)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`[funding-auto] Close failed ${pos.symbol}: ${msg}`);
      }
    }
  }
}

registerStrategy("funding-auto", (_config) => new FundingAutoStrategy());
