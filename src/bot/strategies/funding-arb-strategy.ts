import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { FundingArbStrategyParams } from "../config.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { registerStrategy } from "../strategy-registry.js";
import { checkArbLiquidity } from "../../liquidity.js";
import { computeMatchedSize, reconcileArbFills } from "../../arb-sizing.js";
import { computeAnnualSpread } from "../../funding.js";

interface ArbOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longRate: number;
  shortRate: number;
  spread: number; // annualized %
}

interface ArbOpenPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  entrySpread: number;
  size: string;
}

export class FundingArbStrategy implements Strategy {
  readonly name = "funding-arb";

  describe() {
    return {
      description: "Cross-exchange funding rate arbitrage",
      params: [
        { name: "min_spread", type: "number" as const, required: true, description: "Minimum annualized spread %" },
        { name: "close_spread", type: "number" as const, required: false, default: 5, description: "Spread to close at" },
        { name: "size_usd", type: "number" as const, required: true, description: "Position size in USD" },
        { name: "max_positions", type: "number" as const, required: false, default: 3, description: "Max concurrent positions" },
        { name: "exchanges", type: "string" as const, required: true, description: "Comma-separated exchange names" },
      ],
    };
  }

  private get params(): FundingArbStrategyParams {
    return this._config as unknown as FundingArbStrategyParams;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    const params = this.params;
    ctx.state.set("arbRunning", true);
    ctx.state.set("arbOpenPositions", [] as ArbOpenPosition[]);
    ctx.state.set("arbPositions", 0);
    ctx.state.set("fundingIncome", 0);
    ctx.state.set("fundingLastCheck", Date.now());
    ctx.state.set("fundingHistory", [] as { time: number; amount: number; exchange: string; symbol: string }[]);
    ctx.log(`  [ARB] Funding arb ready | spread >= ${params.min_spread}% | close < ${params.close_spread}% | size $${params.size_usd}`);
    ctx.log(`  [ARB] Exchanges: ${params.exchanges.join(", ")}`);

    // ── Recover existing positions from exchanges ──
    try {
      const extraAdapters = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
      const adapters = new Map<string, ExchangeAdapter>();
      adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
      if (extraAdapters) {
        for (const [name, a] of extraAdapters) adapters.set(name, a);
      }

      // Fetch all positions across exchanges
      const positionsByExchange = new Map<string, { symbol: string; side: string; size: string }[]>();
      for (const [name, a] of adapters) {
        try {
          const positions = await a.getPositions();
          positionsByExchange.set(name, positions.map(p => ({
            symbol: p.symbol.toUpperCase(),
            side: p.side,
            size: p.size,
          })));
        } catch { /* skip unavailable exchange */ }
      }

      // Match long/short pairs across exchanges → reconstruct arbOpenPositions
      const recovered: ArbOpenPosition[] = [];
      const used = new Set<string>(); // "exchange:symbol" to avoid double-matching

      for (const [exA, posA] of positionsByExchange) {
        for (const pA of posA) {
          const keyA = `${exA}:${pA.symbol}`;
          if (used.has(keyA)) continue;

          for (const [exB, posB] of positionsByExchange) {
            if (exA === exB) continue;
            for (const pB of posB) {
              const keyB = `${exB}:${pB.symbol}`;
              if (used.has(keyB)) continue;
              if (pA.symbol !== pB.symbol) continue;
              if (pA.side === pB.side) continue;

              // Found a matching pair
              const longEx = pA.side === "long" ? exA : exB;
              const shortEx = pA.side === "short" ? exA : exB;
              const size = pA.side === "long" ? pA.size : pB.size;
              recovered.push({ symbol: pA.symbol, longExchange: longEx, shortExchange: shortEx, entrySpread: 0, size });
              used.add(keyA);
              used.add(keyB);
              break;
            }
            if (used.has(keyA)) break;
          }
        }
      }

      // ── Same-exchange spot-perp hedges (e.g. PURR spot + PURR-PERP short on HL) ──
      for (const [name, a] of adapters) {
        try {
          const spotState = await (a as unknown as { _getSpotClearinghouseState?(): Promise<Record<string, unknown>> })._getSpotClearinghouseState?.();
          if (!spotState?.balances) continue;
          const spotBalances = (spotState.balances as { coin: string; total: string }[])
            .filter(b => Number(b.total) > 0 && b.coin.toUpperCase() !== "USDC");

          const perpPositions = positionsByExchange.get(name) ?? [];
          for (const perp of perpPositions) {
            const perpKey = `${name}:${perp.symbol}`;
            if (used.has(perpKey)) continue;
            const base = perp.symbol.replace(/-PERP$/, "").toUpperCase();
            const spotBal = spotBalances.find(b => b.coin.toUpperCase() === base);
            if (spotBal && perp.side === "short") {
              recovered.push({ symbol: base, longExchange: `${name}-spot`, shortExchange: name, entrySpread: 0, size: perp.size });
              used.add(perpKey);
              ctx.log(`  [ARB] Detected spot-perp hedge: ${base} ${name}-spot↔${name}`);
            }
          }
        } catch { /* adapter doesn't support spot */ }
      }

      if (recovered.length > 0) {
        ctx.state.set("arbOpenPositions", recovered);
        ctx.state.set("arbPositions", recovered.length);
        ctx.log(`  [ARB] Recovered ${recovered.length} position(s): ${recovered.map(p => `${p.symbol} ${p.longExchange}↔${p.shortExchange}`).join(", ")}`);
      }

      // ── Load historical funding income ──
      let historicalFunding = 0;
      for (const [name, a] of adapters) {
        try {
          const payments = await a.getFundingPayments(200);
          const sum = payments.reduce((s, p) => s + parseFloat(p.payment), 0);
          if (Math.abs(sum) > 0.001) {
            historicalFunding += sum;
            ctx.log(`  [FUND] ${name}: $${sum.toFixed(4)} historical funding`);
          }
        } catch { /* not all adapters support this */ }
      }
      if (Math.abs(historicalFunding) > 0.001) {
        ctx.state.set("fundingIncome", historicalFunding);
        ctx.log(`  [FUND] Total historical funding: $${historicalFunding.toFixed(4)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [ARB] Position recovery failed: ${msg}`);
    }
  }

  async onTick(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const openPositions = ctx.state.get("arbOpenPositions") as ArbOpenPosition[];

    // Get extra adapters from context state (set by engine)
    const extraAdapters = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;

    // Build adapter map from primary + extras
    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
    if (extraAdapters) {
      for (const [name, a] of extraAdapters) adapters.set(name, a);
    }

    if (adapters.size < 2) {
      ctx.log(`  [ARB] Need 2+ exchanges, have ${adapters.size}. Skipping.`);
      return [];
    }

    // Fetch rates from all exchanges
    const ratesByExchange = new Map<string, Map<string, { rate: number; price: number }>>();
    for (const [name, a] of adapters) {
      const rates = await this.fetchRates(a, name);
      const map = new Map<string, { rate: number; price: number }>();
      for (const r of rates) map.set(r.symbol.toUpperCase(), { rate: r.rate, price: r.price });
      ratesByExchange.set(name, map);
    }

    // ── Fetch funding income periodically (every 5 minutes) ──
    const lastCheck = ctx.state.get("fundingLastCheck") as number;
    if (Date.now() - lastCheck > 5 * 60 * 1000) {
      try {
        let totalFunding = 0;
        for (const [name, a] of adapters) {
          try {
            const payments = await a.getFundingPayments(50);
            const startTime = ctx.state.get("fundingLastCheck") as number;
            const recent = payments.filter(p => p.time > startTime - 5 * 60 * 1000);
            const sum = recent.reduce((s, p) => s + parseFloat(p.payment), 0);
            totalFunding += sum;
            if (Math.abs(sum) > 0.001) {
              ctx.log(`  [FUND] ${name}: $${sum.toFixed(4)} funding received`);
            }
          } catch { /* not all adapters support this */ }
        }
        const prev = ctx.state.get("fundingIncome") as number;
        ctx.state.set("fundingIncome", prev + totalFunding);
        ctx.state.set("fundingLastCheck", Date.now());
      } catch { /* non-critical */ }
    }

    // ── Update strategy state for TUI display ──
    const arbPosForDisplay = openPositions.map(p => {
      const longRate = ratesByExchange.get(p.longExchange)?.get(p.symbol)?.rate;
      const shortRate = ratesByExchange.get(p.shortExchange)?.get(p.symbol)?.rate;
      const spread = (longRate !== undefined && shortRate !== undefined)
        ? computeAnnualSpread(shortRate, p.shortExchange, longRate, p.longExchange)
        : 0;
      return `${p.symbol} ${p.longExchange}↔${p.shortExchange} ${spread.toFixed(1)}%`;
    });
    ctx.state.set("arbPositionDetails", arbPosForDisplay);
    ctx.state.set("fundingTotal", `$${(ctx.state.get("fundingIncome") as number).toFixed(4)}`);

    // ── Check existing positions for close_spread ──
    const toClose: ArbOpenPosition[] = [];
    for (const pos of openPositions) {
      const longRate = ratesByExchange.get(pos.longExchange)?.get(pos.symbol)?.rate;
      const shortRate = ratesByExchange.get(pos.shortExchange)?.get(pos.symbol)?.rate;
      if (longRate === undefined || shortRate === undefined) continue;

      const currentSpread = computeAnnualSpread(shortRate, pos.shortExchange, longRate, pos.longExchange);
      if (currentSpread < params.close_spread) {
        ctx.log(`  [ARB] Closing ${pos.symbol}: spread ${currentSpread.toFixed(1)}% < close_spread ${params.close_spread}% (entry: ${pos.entrySpread.toFixed(1)}%)`);
        const longAdapter = adapters.get(pos.longExchange);
        const shortAdapter = adapters.get(pos.shortExchange);
        if (longAdapter && shortAdapter) {
          try {
            await Promise.all([
              longAdapter.marketOrder(pos.symbol, "sell", pos.size),
              shortAdapter.marketOrder(pos.symbol, "buy", pos.size),
            ]);
            toClose.push(pos);
            ctx.log(`  [ARB] Closed ${pos.symbol} position`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`  [ARB] Close failed for ${pos.symbol}: ${msg}`);
          }
        }
      }
    }

    // Remove closed positions
    if (toClose.length > 0) {
      const remaining = openPositions.filter(p => !toClose.includes(p));
      ctx.state.set("arbOpenPositions", remaining);
      ctx.state.set("arbPositions", remaining.length);
    }

    // ── Find new opportunities ──
    const arbPositions = (ctx.state.get("arbOpenPositions") as ArbOpenPosition[]).length;
    const exchangeNames = [...ratesByExchange.keys()];
    const opportunities: ArbOpportunity[] = [];

    const allSymbols = new Set<string>();
    for (const [, map] of ratesByExchange) {
      for (const sym of map.keys()) allSymbols.add(sym);
    }

    for (const sym of allSymbols) {
      let minRate = Infinity, maxRate = -Infinity;
      let minExchange = "", maxExchange = "";

      for (const exName of exchangeNames) {
        const rate = ratesByExchange.get(exName)?.get(sym)?.rate;
        if (rate === undefined) continue;
        if (rate < minRate) { minRate = rate; minExchange = exName; }
        if (rate > maxRate) { maxRate = rate; maxExchange = exName; }
      }

      if (minExchange && maxExchange && minExchange !== maxExchange) {
        const spread = computeAnnualSpread(maxRate, maxExchange, minRate, minExchange);
        if (spread >= params.min_spread) {
          opportunities.push({
            symbol: sym,
            longExchange: minExchange,
            shortExchange: maxExchange,
            longRate: minRate,
            shortRate: maxRate,
            spread,
          });
        }
      }
    }

    opportunities.sort((a, b) => b.spread - a.spread);

    if (opportunities.length > 0) {
      const top = opportunities.slice(0, 3);
      for (const opp of top) {
        ctx.log(`  [ARB] ${opp.symbol}: ${opp.spread.toFixed(1)}% spread (long ${opp.longExchange} ${(opp.longRate * 100).toFixed(4)}% / short ${opp.shortExchange} ${(opp.shortRate * 100).toFixed(4)}%)`);
      }

      // Auto-execute if under position limit
      if (arbPositions < params.max_positions && opportunities.length > 0) {
        const best = opportunities[0];
        const longAdapter = adapters.get(best.longExchange);
        const shortAdapter = adapters.get(best.shortExchange);

        if (longAdapter && shortAdapter) {
          const price = ratesByExchange.get(best.longExchange)?.get(best.symbol)?.price ?? 0;
          if (price > 0) {
            // Balance check — reduce size to fit available balance
            let targetSizeUsd = params.size_usd;
            try {
              const [longBal, shortBal] = await Promise.all([
                longAdapter.getBalance(),
                shortAdapter.getBalance(),
              ]);
              const longAvail = parseFloat(longBal.available);
              const shortAvail = parseFloat(shortBal.available);
              const minAvail = Math.min(longAvail, shortAvail);
              // Use at most 80% of available balance per leg
              const maxAffordable = minAvail * 0.8;
              if (maxAffordable < 10) {
                ctx.log(`  [ARB] Skip ${best.symbol}: insufficient balance ($${minAvail.toFixed(2)} available, need $10+ per leg)`);
                return [];
              }
              if (targetSizeUsd > maxAffordable) {
                ctx.log(`  [ARB] Size reduced $${targetSizeUsd} → $${maxAffordable.toFixed(0)} (limited by balance $${minAvail.toFixed(2)})`);
                targetSizeUsd = Math.floor(maxAffordable);
              }
            } catch { /* non-critical, proceed with original size */ }

            // Liquidity check
            const liq = await checkArbLiquidity(
              longAdapter, shortAdapter, best.symbol, targetSizeUsd, 0.5,
              (msg) => ctx.log(`  ${msg}`),
            );
            if (!liq.viable) return [];

            // Compute matched size
            let matched = computeMatchedSize(liq.adjustedSizeUsd, price, best.longExchange, best.shortExchange);
            if (!matched) {
              ctx.log(`  [ARB] Skip ${best.symbol}: can't compute matched size (min notional or precision issue)`);
              return [];
            }

            try {
              ctx.log(`  [ARB] Opening: ${matched.size} ${best.symbol} on both legs ($${matched.notional.toFixed(0)}/leg, slippage ~${liq.longSlippage.toFixed(2)}%/${liq.shortSlippage.toFixed(2)}%)`);
              try {
                await Promise.all([
                  longAdapter.marketOrder(best.symbol, "buy", matched.size),
                  shortAdapter.marketOrder(best.symbol, "sell", matched.size),
                ]);
              } catch (orderErr) {
                // Parse lot size from error and retry with corrected size
                const errMsg = orderErr instanceof Error ? orderErr.message : String(orderErr);
                const lotMatch = errMsg.match(/not a multiple of lot size (\d+(?:\.\d+)?)/);
                if (lotMatch) {
                  const lotSize = parseFloat(lotMatch[1]);
                  ctx.log(`  [ARB] Lot size ${lotSize} detected, recalculating...`);
                  matched = computeMatchedSize(liq.adjustedSizeUsd, price, best.longExchange, best.shortExchange, { lotSize });
                  if (!matched) { ctx.log(`  [ARB] Skip ${best.symbol}: can't meet lot size ${lotSize}`); return []; }
                  ctx.log(`  [ARB] Retry: ${matched.size} ${best.symbol} ($${matched.notional.toFixed(0)}/leg)`);
                  await Promise.all([
                    longAdapter.marketOrder(best.symbol, "buy", matched.size),
                    shortAdapter.marketOrder(best.symbol, "sell", matched.size),
                  ]);
                } else {
                  throw orderErr;
                }
              }

              // Verify fills match, correct if needed
              try {
                const recon = await reconcileArbFills(longAdapter, shortAdapter, best.symbol,
                  (msg) => ctx.log(`  ${msg}`),
                );
                if (!recon.matched) {
                  ctx.log(`  [ARB] WARNING: fills not matched after correction attempt`);
                }
              } catch (reconErr) {
                const reconMsg = reconErr instanceof Error ? reconErr.message : String(reconErr);
                ctx.log(`  [ARB] WARNING: Fill reconciliation failed: ${reconMsg}`);
              }

              // Track position in array
              const currentPositions = ctx.state.get("arbOpenPositions") as ArbOpenPosition[];
              currentPositions.push({
                symbol: best.symbol,
                longExchange: best.longExchange,
                shortExchange: best.shortExchange,
                entrySpread: best.spread,
                size: matched.size,
              });
              ctx.state.set("arbOpenPositions", currentPositions);
              ctx.state.set("arbPositions", currentPositions.length);
              ctx.log(`  [ARB] Position opened! (${currentPositions.length}/${params.max_positions})`);

              // Return noop -- we already executed directly via adapters
              // (arb requires multi-adapter coordination, can't be expressed as single-adapter actions)
              return [{ type: "noop" }];
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log(`  [ARB] Execution failed: ${msg}`);
            }
          }
        }
      }
    } else {
      ctx.log(`  [ARB] No opportunities >= ${params.min_spread}% spread`);
    }

    return [];
  }

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const openPositions = ctx.state.get("arbOpenPositions") as ArbOpenPosition[] | undefined;
    const extraAdapters = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;

    // Close all open arb positions
    if (openPositions && openPositions.length > 0) {
      const adapters = new Map<string, ExchangeAdapter>();
      adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
      if (extraAdapters) {
        for (const [name, a] of extraAdapters) adapters.set(name, a);
      }

      for (const pos of openPositions) {
        const longAdapter = adapters.get(pos.longExchange);
        const shortAdapter = adapters.get(pos.shortExchange);
        if (longAdapter && shortAdapter) {
          try {
            ctx.log(`  [ARB] Closing ${pos.symbol} on stop (${pos.size})`);
            await Promise.all([
              longAdapter.marketOrder(pos.symbol, "sell", pos.size),
              shortAdapter.marketOrder(pos.symbol, "buy", pos.size),
            ]);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`  [ARB] Close on stop failed for ${pos.symbol}: ${msg}`);
          }
        }
      }
      ctx.state.set("arbOpenPositions", []);
      ctx.state.set("arbPositions", 0);
    }

    // Cancel on extra adapters directly (M2: was only cancelling on primary adapter)
    if (extraAdapters) {
      for (const [, a] of extraAdapters) {
        try { await a.cancelAllOrders(); } catch { /* best effort */ }
      }
    }
    return [{ type: "cancel_all" }];
  }

  private async fetchRates(
    adapter: ExchangeAdapter,
    _exchangeName: string,
  ): Promise<{ symbol: string; rate: number; price: number }[]> {
    try {
      const markets = await adapter.getMarkets();
      return markets.map(m => ({
        symbol: m.symbol,
        rate: parseFloat(m.fundingRate),
        price: parseFloat(m.markPrice),
      }));
    } catch {
      return [];
    }
  }
}

registerStrategy("funding-arb", (_config) => new FundingArbStrategy());
