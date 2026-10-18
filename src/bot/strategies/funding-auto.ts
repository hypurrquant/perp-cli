import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { registerStrategy } from "../strategy-registry.js";
import { toHourlyRate, annualizeHourlyRate } from "../../funding/normalize.js";
import { isQuarantined, quarantineSymbol } from "../quarantine.js";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified, trimFirstLegToHedge, type PerpCloseResult } from "../perp-order.js";
import { fillSizeString, sizeDecimalsOf } from "../../exchanges/spot-result.js";
import { PerpError } from "../../errors.js";
import { assertFundingArbLegs } from "./funding-arb-utils.js";

/** Market basis first (ExchangeMarketInfo.fundingHours), else the venue definition's basis. */
function hourlyOf(info: { rate: number; fundingHours: number | null }, exchange: string): number {
  return info.fundingHours !== null ? info.rate / info.fundingHours : toHourlyRate(info.rate, exchange);
}

/**
 * Minimum notional per exchange (USD):
 * - HL: ~$2 (0.001 ETH)
 * - PAC: $10
 * - LT: ~$21 (0.01 ETH)
 * Use $12 as safe minimum across all exchanges.
 */
const MIN_NOTIONAL_USD = 12;

/** Entry size precision per asset price range, FLOORED (never rounds up past the notional). */
function formatSizeForPrice(rawSize: number, price: number): string {
  // Higher price → fewer decimals (BTC: 4, ETH: 3, SOL: 2, DOGE: 1, sub-$1: 0)
  const decimals = price > 10000 ? 4 : price > 1000 ? 3 : price > 10 ? 2 : price > 1 ? 1 : 0;
  return fillSizeString(rawSize, decimals);
}

/** Consecutive definite close failures before a pair is quarantined. */
const MAX_CLOSE_FAILURES = 3;

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
 * Mode 2: Spot-Perp — NOT SUPPORTED (CAPABILITY_UNSUPPORTED). This strategy discovers
 *   its pairs from live perp positions every tick and has no spot adapter or persisted
 *   spot state, so it cannot hold a spot leg it can later find and unwind. A non-zero
 *   `spotPerpRatio` is refused at init; use the `spot-perp-arb` strategy instead.
 *
 * Core formula:
 *   Total Cost  = 2 * [(feeA + feeB + slippageA + slippageB) * notional]
 *   Hourly Income = |hourlyRateA - hourlyRateB| * notional
 *   Break-Even Hours = Total Cost / Hourly Income
 *   Entry if: breakEvenHours < maxHoldHours AND hourlyIncome > 0 AND spread > minSpread
 *
 * Position tracking: discovered from live exchange data every tick (survives restarts).
 *
 * Order safety: entry legs are sequential and verified (placePerpVerified),
 * the short sized to the long's verified fill; rollbacks, trims and closes are
 * reduce-only and verified, closes sized from the venue's own position size. An unknown
 * outcome, an unhedged leg, or MAX_CLOSE_FAILURES consecutive close failures
 * quarantines the symbol — never retried automatically.
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
  mode: "perp-perp";
}

interface ActivePosition {
  id: string;
  symbol: string;
  mode: "perp-perp";
  longExchange: string;
  shortExchange: string;
  longSize: number;       // actual size from exchange
  shortSize: number;      // actual size from exchange
  longSymbol: string;     // raw exchange symbol for order execution
  shortSymbol: string;    // raw exchange symbol for order execution
  longSizeRaw: string;    // venue-reported position size (unsigned), used verbatim for closes
  shortSizeRaw: string;
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
  private get perpPerpRatio(): number { return Number(this._config.perpPerpRatio ?? 0.3); }
  private get perpPerpMinSpread(): number { return Number(this._config.perpPerpMinSpread ?? 20); }
  private get perpPerpCloseSpread(): number { return Number(this._config.perpPerpCloseSpread ?? 0); }
  private get maxBreakEvenHours(): number { return Number(this._config.maxBreakEvenHours ?? 48); }
  private get maxPositions(): number { return Number(this._config.maxPositions ?? 5); }
  private get maxCapitalPct(): number { return Number(this._config.maxCapitalPct ?? 20); }
  private get defaultFeeRate(): number { return Number(this._config.defaultFeeRate ?? 0.0005); }
  private get defaultSlippage(): number { return Number(this._config.defaultSlippage ?? 0.001); }
  private get scanIntervalTicks(): number { return Number(this._config.scanIntervalTicks ?? 1); }
  /** Total equity across all venues, read this tick; null = some venue's balance is unknown. */
  private _cachedEquity: number | null = null;
  /**
   * Position size: min of sizeUsd (if set) and maxCapitalPct% of total equity. null = cannot be
   * sized (equity unknown, or no capital and no sizeUsd) — no entry, never a substituted size.
   */
  private getSizeUsd(): number | null {
    if (this._cachedEquity === null) return null;
    const fixedSize = Number(this._config.sizeUsd ?? 0);
    const capitalLimit = this._cachedEquity * (this.maxCapitalPct / 100);
    if (fixedSize > 0 && capitalLimit > 0) return Math.min(fixedSize, capitalLimit);
    if (capitalLimit > 0) return capitalLimit;
    return null;
  }

  describe() {
    return {
      description: "Automated funding rate trading - perp-perp (spot-perp mode not supported; use spot-perp-arb)",
      params: [
        { name: "spotPerpRatio", type: "number" as const, required: false, default: 0, description: "Spot-perp mode is NOT supported here (a value > 0 fails with CAPABILITY_UNSUPPORTED) — use spot-perp-arb" },
        { name: "perpPerpRatio", type: "number" as const, required: false, default: 0.3, description: "Capital ratio for perp-perp mode" },
        { name: "perpPerpMinSpread", type: "number" as const, required: false, default: 20, description: "Min annualized spread % for perp-perp entry" },
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
    assertFundingArbLegs(ctx);
    this._config = ctx.config;
    if (ctx.config.spotPerpRatio !== undefined && Number(ctx.config.spotPerpRatio) > 0) {
      throw new PerpError("CAPABILITY_UNSUPPORTED", "funding-auto does not support spot-perp mode (no spot leg can be held or unwound by this strategy)", {
        remediation: "Remove spotPerpRatio (or set it to 0) to run perp-perp only, or use the spot-perp-arb strategy for spot + perp short",
      });
    }
    ctx.state.set("lastScan", 0);
    ctx.state.set("priceCache", new Map<string, number>());
    ctx.log(`[funding-auto] Starting (perp-perp only; spot-perp mode is not supported by this strategy)`);
  }

  async onTick(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    // Get all adapters
    const adapters = this.getAdapters(ctx);

    // Total equity across ALL exchanges for capital-based sizing, read fresh every tick.
    // Any unknown balance → equity unknown (null): no new entry is sized this tick (never a
    // stale value, a venue counted as $0, or a substituted size).
    let totalEquity: number | null = 0;
    for (const [name, adapter] of adapters) {
      try {
        const bal = await adapter.getBalance();
        const eq = Number(bal.equity);
        if (!Number.isFinite(eq)) throw new Error(`equity "${bal.equity}" is not a number`);
        if (totalEquity !== null) totalEquity += eq;
      } catch (e) {
        totalEquity = null;
        ctx.log(`[funding-auto] ${name} balance unreadable (${e instanceof Error ? e.message : String(e)}) — equity unknown, no new entries this tick`);
      }
    }
    this._cachedEquity = totalEquity;
    if (adapters.size < 2) {
      ctx.log(`[funding-auto] Need 2+ exchanges, have ${adapters.size}. Skipping.`);
      return [];
    }

    // ── Discover existing arb pairs from live exchange positions ──
    // A venue whose positions could not be read is never treated as "no positions":
    // no entries touch it this tick (its existing pairs are simply not visible).
    const { pairs: positions, unreadable } = await this.discoverArbPairs(adapters, ctx.log);

    // Fetch funding rates from all exchanges (price data cached for position sizing)
    const ratesByExchange = new Map<string, Map<string, { rate: number; price: number; exchange: string; fundingHours: number | null }>>();
    const priceCache = new Map<string, number>(); // "exchange:symbol" -> price
    // Venues whose markets could not be read this tick: no open / close decision touches them.
    const ratesUnavailable = new Set<string>();
    for (const [name, adapter] of adapters) {
      try {
        const markets = await adapter.getMarkets();
        const map = new Map<string, { rate: number; price: number; exchange: string; fundingHours: number | null }>();
        for (const m of markets) {
          const raw = m.symbol.toUpperCase();
          const sym = normalizeSymbol(raw);
          const price = parseFloat(m.markPrice);
          map.set(sym, {
            rate: m.fundingRate != null ? parseFloat(m.fundingRate) : NaN,
            price,
            exchange: name,
            fundingHours: m.fundingHours,
          });
          if (price > 0) {
            priceCache.set(`${name}:${sym}`, price);
            priceCache.set(`${name}:${raw}`, price); // keep raw for order execution
          }
        }
        ratesByExchange.set(name, map);
      } catch (e) {
        ratesUnavailable.add(name);
        ctx.log(`[funding-auto] ${name} markets unreadable (${e instanceof Error ? e.message : String(e)}) — no open / close decision on ${name} this tick`);
      }
    }
    // Store priceCache for use by openPosition/closePosition
    ctx.state.set("priceCache", priceCache);

    // Calculate notional for discovered positions (using current price)
    // (unknown price → notional left unset, never valued at $0)
    for (const pos of positions) {
      const price = priceCache.get(`${pos.longExchange}:${pos.symbol}`)
        ?? priceCache.get(`${pos.shortExchange}:${pos.symbol}`);
      if (price !== undefined) {
        pos.notional = Math.max(pos.longSize, pos.shortSize) * price;
      }
    }

    // ── Phase 1: Monitor existing positions for exit ──
    const surviving: ActivePosition[] = [];
    for (const pos of positions) {
      if (isQuarantined(pos.symbol, ctx.log)) {
        // Unknown / unhedged outcome recorded by some bot or arb path: hands off.
        surviving.push(pos);
        continue;
      }
      if (pos.mode === "perp-perp") {
        // Check if spread has converged below close threshold
        const longRates = ratesByExchange.get(pos.longExchange);
        const shortRates = ratesByExchange.get(pos.shortExchange);
        if (!longRates || !shortRates) {
          const down = [pos.longExchange, pos.shortExchange].filter(n => ratesUnavailable.has(n) || !ratesByExchange.has(n));
          ctx.log(`[funding-auto] ${pos.symbol}: rates unavailable on ${down.join(", ")} — skipping the exit decision this tick`);
          surviving.push(pos);
          continue;
        }

        const longInfo = longRates.get(pos.symbol);
        const shortInfo = shortRates.get(pos.symbol);
        if (!longInfo || !shortInfo) {
          ctx.log(`[funding-auto] ${pos.symbol}: market missing on ${!longInfo ? pos.longExchange : pos.shortExchange} — skipping the exit decision this tick`);
          surviving.push(pos);
          continue;
        }

        // SIGNED spread for the held direction: short-venue hourly − long-venue hourly
        // (each normalized by its own funding basis), annualized %. Positive = still
        // earning; ≤ 0 = the pair has reversed and now pays.
        const currentSpread = annualizeHourlyRate(hourlyOf(shortInfo, pos.shortExchange) - hourlyOf(longInfo, pos.longExchange));
        if (!Number.isFinite(currentSpread)) {
          ctx.log(`[funding-auto] ${pos.symbol}: funding rate unknown (${pos.longExchange}↔${pos.shortExchange}) — skipping the exit decision this tick`);
          surviving.push(pos);
          continue;
        }

        // Calculate real P&L from exchange history. An unreadable history is never "0":
        // no close decision for this pair this tick.
        const [longPnl, shortPnl] = await Promise.all([
          this.calculateRealPnl(adapters.get(pos.longExchange)!, pos.longExchange, pos.symbol, ctx.log),
          this.calculateRealPnl(adapters.get(pos.shortExchange)!, pos.shortExchange, pos.symbol, ctx.log),
        ]);
        if (longPnl === null || shortPnl === null) {
          ctx.log(`[funding-auto] ${pos.symbol}: P&L history unreadable — skipping the exit decision this tick`);
          surviving.push(pos);
          continue;
        }
        const totalFees = longPnl.fees + shortPnl.fees;
        const totalFunding = longPnl.funding + shortPnl.funding;
        pos.accumulatedFunding = totalFunding;
        pos.totalCost = totalFees;

        ctx.log(
          `[funding-auto] ${pos.symbol} spread ${currentSpread.toFixed(1)}% | ` +
          `fees $${totalFees.toFixed(4)} | funding $${totalFunding.toFixed(4)} | ` +
          `net $${(totalFunding - totalFees).toFixed(4)} (${pos.longExchange}↔${pos.shortExchange})`,
        );

        // Close when the signed spread falls to the configured threshold (default 0 =
        // only on reversal). A small positive spread still earns funding; closing costs more.
        if (currentSpread <= this.perpPerpCloseSpread) {
          ctx.log(`[funding-auto] Closing perp-perp ${pos.symbol}: spread ${currentSpread.toFixed(1)}% <= close threshold ${this.perpPerpCloseSpread}%${currentSpread <= 0 ? " (REVERSED)" : ""}`);
          if (!(await this.closePosition(ctx, pos, adapters))) surviving.push(pos);
        } else {
          surviving.push(pos);
        }
      }
    }

    // ── Phase 2: Scan for new opportunities ──
    if (ctx.tick % this.scanIntervalTicks !== 0) return surviving.length > 0 ? [{ type: "noop" }] : [];
    if (surviving.length >= this.maxPositions) return [{ type: "noop" }];

    // Unknown sizing (equity unknown, or no capital and no sizeUsd): no new entries this tick.
    const sizeUsd = this.getSizeUsd();
    if (sizeUsd === null) {
      ctx.log(`[funding-auto] No new entries: position size unknown (equity ${this._cachedEquity === null ? "unknown" : `$${this._cachedEquity.toFixed(2)}`}, sizeUsd ${Number(this._config.sizeUsd ?? 0)})`);
      return surviving.length > 0 ? [{ type: "noop" }] : [];
    }

    ctx.state.set("lastScan", Date.now());

    ctx.log(`[funding-auto] Scanning ${ratesByExchange.size} exchanges, equity: $${(this._cachedEquity as number).toFixed(2)}, size: $${sizeUsd.toFixed(2)}/pos, active: ${surviving.length}`);

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
        const hourly = hourlyOf(info, exName);
        if (hourly < minRate) { minRate = hourly; minExchange = exName; }
        if (hourly > maxRate) { maxRate = hourly; maxExchange = exName; }
      }

      if (!minExchange || !maxExchange || minExchange === maxExchange) continue;

      // Need raw rates for computeAnnualSpread
      const longInfo = ratesByExchange.get(minExchange)!.get(sym)!;
      const shortInfo = ratesByExchange.get(maxExchange)!.get(sym)!;

      const annualSpread = Math.abs(hourlyOf(shortInfo, maxExchange) - hourlyOf(longInfo, minExchange)) * 24 * 365 * 100;

      if (annualSpread < this.perpPerpMinSpread) continue;

      // Calculate cost and break-even
      const notional = sizeUsd;
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
    // Not supported in this strategy (CAPABILITY_UNSUPPORTED at init) — see the header.

    // Sort by break-even hours ascending (best opportunities first)
    opportunities.sort((a, b) => a.breakEvenHours - b.breakEvenHours);

    if (opportunities.length > 0) {
      const top = opportunities.slice(0, 3);
      for (const o of top) {
        ctx.log(`[funding-auto] ${o.mode} ${o.symbol}: spread ${o.annualSpread.toFixed(1)}%, BE ${o.breakEvenHours.toFixed(0)}h, income $${(o.hourlyIncome * 24).toFixed(4)}/day (${o.longExchange}↔${o.shortExchange})`);
      }
    } else {
      ctx.log(`[funding-auto] No opportunities found (perp-perp min ${this.perpPerpMinSpread}%, BE max ${this.maxBreakEvenHours}h)`);
    }

    // ── Phase 3: Enter new positions ──
    const slotsAvailable = this.maxPositions - surviving.length;

    // Allocate slots by ratio
    const perpPerpSlots = Math.max(1, Math.floor(slotsAvailable * this.perpPerpRatio));

    let perpPerpOpened = 0;
    let currentCount = surviving.length;

    for (const opp of opportunities) {
      if (currentCount >= this.maxPositions) break;

      if (perpPerpOpened >= perpPerpSlots) continue;
      if (unreadable.has(opp.longExchange) || unreadable.has(opp.shortExchange)) continue;
      if (isQuarantined(opp.symbol, ctx.log)) continue;

      // Track attempted symbols to prevent re-entry on same tick cycle
      attempted.add(`${opp.symbol}:${opp.mode}`);
      ctx.state.set("attemptedSymbols", attempted);

      const success = await this.openPosition(ctx, opp, adapters, sizeUsd);
      if (success) {
        currentCount++;
        perpPerpOpened++;

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
    const { pairs: positions, unreadable } = await this.discoverArbPairs(adapters, ctx.log);
    if (unreadable.size > 0) {
      ctx.log(`[funding-auto] CRITICAL: positions on ${[...unreadable].join(", ")} could not be read — any pair there is NOT closed on stop; check manually`);
    }

    if (positions.length === 0) {
      ctx.log("[funding-auto] No positions to close.");
      return [];
    }

    ctx.log(`[funding-auto] Stopping - closing ${positions.length} positions`);

    for (const pos of positions) {
      if (isQuarantined(pos.symbol, ctx.log)) {
        ctx.log(`[funding-auto] CRITICAL: ${pos.symbol} is quarantined — left open on stop; resolve manually (perp strategy quarantine)`);
        continue;
      }
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

  /** Cached (this tick's) price for a symbol on a given exchange; undefined = unknown. */
  private getCachedPrice(ctx: StrategyContext, exchange: string, symbol: string): number | undefined {
    const cache = ctx.state.get("priceCache") as Map<string, number> | undefined;
    return cache?.get(`${exchange}:${symbol}`);
  }

  /** Discover existing arb pairs from live exchange positions; `unreadable` = venues whose positions failed to load. */
  private async discoverArbPairs(adapters: Map<string, ExchangeAdapter>, log: (msg: string) => void): Promise<{ pairs: ActivePosition[]; unreadable: Set<string> }> {
    const allPositions = new Map<string, { exchange: string; side: string; size: number; sizeRaw: string; symbol: string }[]>();
    const unreadable = new Set<string>();

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
            sizeRaw: String(p.size).trim().replace(/^[-+]/, ""), // venue's own size string, for closes
            symbol: p.symbol, // raw for order execution
          });
        }
      } catch (e) {
        unreadable.add(name);
        log(`[funding-auto] ${name} positions unreadable (${e instanceof Error ? e.message : String(e)}) — no entries on ${name} this tick`);
      }
    }

    // Find arb pairs: same symbol, opposite sides, different exchanges = perp-perp.
    // An unmatched short is never adopted (spot-perp mode is not supported here).
    const pairs: ActivePosition[] = [];
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
              longSizeRaw: long.sizeRaw,
              shortSizeRaw: short.sizeRaw,
              entrySpread: 0,
              entryTime: 0,
              notional: 0,
              totalCost: 0,
              accumulatedFunding: 0,
            });
          }
        }
      }
    }
    return { pairs, unreadable };
  }

  /** Actual fees / funding from exchange trade/funding history; null when the history could not be read (never 0). */
  private async calculateRealPnl(
    adapter: ExchangeAdapter,
    exchange: string,
    symbol: string,
    log: (msg: string) => void,
  ): Promise<{ fees: number; funding: number } | null> {
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
    } catch (e) {
      log(`[funding-auto] ${exchange} ${symbol} trade/funding history unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private quarantine(ctx: StrategyContext, pos: { symbol: string; longExchange: string; shortExchange: string }, reason: string): void {
    quarantineSymbol(this.name, pos.symbol, reason,
      `Check ${pos.symbol} on ${pos.longExchange} and ${pos.shortExchange} (perp -e ${pos.longExchange} positions; perp -e ${pos.shortExchange} positions); close or re-hedge by hand, then: perp strategy quarantine-clear ${pos.symbol}`,
      ctx.log);
  }

  /**
   * Perp-perp entry, sequential and verified: long first, then the short sized to the
   * long's VERIFIED fill; any excess the short did not cover is trimmed off the long
   * (reduce-only, verified). A definite short failure rolls the long back reduce-only.
   * An unknown outcome or a failed rollback / trim quarantines the symbol.
   */
  private async openPosition(
    ctx: StrategyContext,
    opp: FundingOpportunity,
    adapters: Map<string, ExchangeAdapter>,
    notionalUsd: number,
  ): Promise<boolean> {
    // Engine: equity unknown → no new entries (closes still run).
    if (ctx.state.get("equityUnknown") === true) { ctx.log(`[funding-auto] Skip ${opp.symbol}: equity unknown — no new entries`); return false; }
    const longAdapter = adapters.get(opp.longExchange);
    const shortAdapter = adapters.get(opp.shortExchange);
    if (!longAdapter || !shortAdapter) return false;

    const price = this.getCachedPrice(ctx, opp.longExchange, opp.symbol)
      ?? this.getCachedPrice(ctx, opp.shortExchange, opp.symbol);
    if (price === undefined) {
      ctx.log(`[funding-auto] Skip ${opp.symbol}: price unknown on ${opp.longExchange} / ${opp.shortExchange}`);
      return false;
    }

    const size = formatSizeForPrice(notionalUsd / price, price);

    // Minimum notional check — skip if below exchange minimums
    if (notionalUsd < MIN_NOTIONAL_USD) {
      ctx.log(`[funding-auto] Skip ${opp.symbol}: notional $${notionalUsd.toFixed(0)} < min $${MIN_NOTIONAL_USD}`);
      return false;
    }
    if (!(Number(size) > 0)) {
      ctx.log(`[funding-auto] Skip ${opp.symbol}: size rounds to 0 at $${notionalUsd.toFixed(0)} / $${price}`);
      return false;
    }

    const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
    const dec = sizeDecimalsOf(size);
    let longFilled: number;
    try {
      longFilled = (await placePerpVerified(longAdapter, opp.longExchange, opp.symbol, "buy", size)).filledSize;
    } catch (err) {
      if (isOutcomeUnknown(err)) this.quarantine(ctx, opp, `entry long ${size} on ${opp.longExchange} outcome unknown (${errText(err)}) — no short placed`);
      else ctx.log(`[funding-auto] Perp-perp entry failed ${opp.symbol} (long leg): ${errText(err)}`);
      return false;
    }
    const longOpen = fillSizeString(longFilled, dec);
    let shortFilled: number;
    try {
      shortFilled = (await placePerpVerified(shortAdapter, opp.shortExchange, opp.symbol, "sell", longOpen)).filledSize;
    } catch (err) {
      const msg = errText(err);
      if (isOutcomeUnknown(err)) {
        // The short may exist: closing the long could leave a naked short.
        this.quarantine(ctx, opp, `entry short ${longOpen} on ${opp.shortExchange} outcome unknown (${msg}); long ${longOpen} open on ${opp.longExchange} — not rolled back`);
        return false;
      }
      ctx.log(`[funding-auto] Perp-perp entry failed ${opp.symbol} (short leg): ${msg} — rolling back the long (reduce-only)`);
      try {
        const rb = await closePerpVerified(longAdapter, opp.longExchange, opp.symbol, "sell", longOpen, { decimals: dec });
        if (rb.residual > 0) {
          this.quarantine(ctx, opp, `entry short failed (${msg}); the long rollback closed ${fillSizeString(rb.closed, dec)} of ${longOpen}, ${fillSizeString(rb.residual, dec)} still open${rb.note !== null ? ` (${rb.note})` : ""} — orphaned long on ${opp.longExchange}`);
          return false;
        }
        ctx.log(`[funding-auto] Rollback OK: closed long ${longOpen} ${opp.symbol} on ${opp.longExchange}`);
      } catch (rbErr) {
        this.quarantine(ctx, opp, `entry short failed (${msg}) and the long rollback failed or is unconfirmed (${errText(rbErr)}) — orphaned long ${longOpen} on ${opp.longExchange}`);
      }
      return false;
    }
    try {
      const trimmed = await trimFirstLegToHedge(longAdapter, opp.longExchange, opp.symbol, "buy", longFilled, shortFilled, dec);
      if (trimmed !== "0") ctx.log(`[funding-auto] Short filled ${fillSizeString(shortFilled, dec)} of ${longOpen} — trimmed long by ${trimmed} (reduce-only)`);
    } catch (trimErr) {
      this.quarantine(ctx, opp, `entry short filled ${fillSizeString(shortFilled, dec)} of ${longOpen}; trimming the long's excess on ${opp.longExchange} failed or is unconfirmed (${errText(trimErr)})`);
      return false;
    }
    return true;
  }

  /**
   * Close both legs sequentially, reduce-only and verified, each sized from the venue's
   * own position size (never rounded up). Long first: a definite failure there changes
   * nothing, so the pair is retried next tick and quarantined after MAX_CLOSE_FAILURES
   * in a row. Once the long is closed, ANY short failure leaves an unhedged short this
   * strategy can no longer discover as a pair → quarantine. An unknown outcome or a
   * residual that survives one reduce-only residual close quarantines. Returns true when both legs closed.
   */
  private async closePosition(
    ctx: StrategyContext,
    pos: ActivePosition,
    adapters: Map<string, ExchangeAdapter>,
  ): Promise<boolean> {
    const longAdapter = adapters.get(pos.longExchange);
    const shortAdapter = adapters.get(pos.shortExchange);
    if (!longAdapter || !shortAdapter) {
      ctx.log(`[funding-auto] Close ${pos.symbol}: adapter missing (${pos.longExchange}/${pos.shortExchange})`);
      return false;
    }
    const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
    const failures = (ctx.state.get("closeFailures") as Map<string, number> | undefined) ?? new Map<string, number>();
    ctx.state.set("closeFailures", failures);

    let lc: PerpCloseResult;
    try {
      lc = await closePerpVerified(longAdapter, pos.longExchange, pos.longSymbol, "sell", pos.longSizeRaw);
    } catch (err) {
      const msg = errText(err);
      if (isOutcomeUnknown(err)) {
        this.quarantine(ctx, pos, `close of long ${pos.longSizeRaw} on ${pos.longExchange} outcome unknown (${msg}) — short ${pos.shortSizeRaw} on ${pos.shortExchange} left open`);
        return false;
      }
      const n = (failures.get(pos.id) ?? 0) + 1;
      failures.set(pos.id, n);
      ctx.log(`[funding-auto] Close failed ${pos.symbol} (long leg, nothing changed): ${msg} (${n}/${MAX_CLOSE_FAILURES})`);
      if (n >= MAX_CLOSE_FAILURES) this.quarantine(ctx, pos, `close failed ${n} times in a row (last: ${msg})`);
      return false;
    }
    failures.delete(pos.id);
    if (lc.residual > 0) {
      this.quarantine(ctx, pos, `close of long on ${pos.longExchange} closed ${lc.closed} of ${pos.longSizeRaw}, ${lc.residual} still open${lc.note !== null ? ` (${lc.note})` : ""} — short ${pos.shortSizeRaw} on ${pos.shortExchange} not closed (legs unbalanced)`);
      return false;
    }

    let sc: PerpCloseResult;
    try {
      sc = await closePerpVerified(shortAdapter, pos.shortExchange, pos.shortSymbol, "buy", pos.shortSizeRaw);
    } catch (err) {
      this.quarantine(ctx, pos, `long closed on ${pos.longExchange} but the close of short ${pos.shortSizeRaw} on ${pos.shortExchange} ${isOutcomeUnknown(err) ? "has an unknown outcome" : "failed"} (${errText(err)}) — short unhedged`);
      return false;
    }
    if (sc.residual > 0) {
      this.quarantine(ctx, pos, `long closed; close of short on ${pos.shortExchange} closed ${sc.closed} of ${pos.shortSizeRaw}, ${sc.residual} still open${sc.note !== null ? ` (${sc.note})` : ""} — residual short unhedged`);
      return false;
    }
    const netPnl = pos.accumulatedFunding - pos.totalCost;
    ctx.log(`[funding-auto] Closed perp-perp ${pos.symbol} | funding $${pos.accumulatedFunding.toFixed(4)} - fees $${pos.totalCost.toFixed(4)} = net $${netPnl.toFixed(4)}`);
    return true;
  }
}

registerStrategy("funding-auto", (_config) => new FundingAutoStrategy());
