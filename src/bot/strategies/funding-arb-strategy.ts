import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { FundingArbStrategyParams } from "../config.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import type { SpotAdapter } from "../../exchanges/spot-interface.js";
import { registerStrategy } from "../strategy-registry.js";
import { checkArbLiquidity, checkSpotPerpLiquidity } from "../../liquidity.js";
import { computeMatchedSize, computeSpotPerpMatchedSize, reconcileArbFills } from "../../arb-sizing.js";
import { computeSignedAnnualSpread, annualizeRate } from "../../funding.js";
import { logExecution, pruneExecutionLog } from "../../execution-log.js";

interface ArbOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longRate: number;
  shortRate: number;
  spread: number; // annualized %
  mode: "perp-perp" | "spot-perp";
}

interface ArbOpenPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  entrySpread: number;
  size: string;
  mode: "perp-perp" | "spot-perp";
}

export class FundingArbStrategy implements Strategy {
  readonly name = "funding-arb";

  describe() {
    return {
      description: "Cross-exchange funding rate arbitrage",
      params: [
        { name: "min_spread", type: "number" as const, required: true, description: "Minimum annualized spread %" },
        { name: "close_spread", type: "number" as const, required: false, default: 5, description: "Spread to close at" },
        { name: "spot_perp_min_spread", type: "number" as const, required: false, description: "Min spread for spot-perp (default: min_spread)" },
        { name: "size_usd", type: "number" as const, required: true, description: "Position size in USD" },
        { name: "max_positions", type: "number" as const, required: false, default: 3, description: "Max concurrent positions" },
        { name: "exchanges", type: "string" as const, required: true, description: "Comma-separated exchange names" },
        { name: "leverage", type: "number" as const, required: false, default: 3, description: "Max leverage to use" },
      ],
    };
  }

  private get params(): FundingArbStrategyParams {
    return this._config as unknown as FundingArbStrategyParams;
  }

  private _config: Record<string, unknown> = {};
  private _failCooldown = new Map<string, number>(); // "symbol:action" → timestamp of next retry

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    // Prune old execution logs (keep 30 days)
    try { pruneExecutionLog(30); } catch { /* non-critical */ }
    this._config = ctx.config;
    const params = this.params;
    ctx.state.set("arbRunning", true);
    ctx.state.set("arbOpenPositions", [] as ArbOpenPosition[]);
    ctx.state.set("arbPositions", 0);
    ctx.state.set("fundingIncome", 0);
    ctx.state.set("fundingLastCheck", Date.now());
    ctx.state.set("fundingHistory", [] as { time: number; amount: number; exchange: string; symbol: string }[]);
    ctx.log(`  [ARB] Funding arb ready | spread >= ${params.min_spread}% | close < ${params.close_spread}% | size $${params.size_usd}`);
    if (params.spot_perp_min_spread !== undefined) {
      ctx.log(`  [ARB] Spot-perp min spread: ${params.spot_perp_min_spread}%`);
    }
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
              recovered.push({ symbol: pA.symbol, longExchange: longEx, shortExchange: shortEx, entrySpread: 0, size, mode: "perp-perp" });
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
          let spotBalances: { token: string; total: string }[] = [];
          if (name === "hyperliquid") {
            const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
            const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
            if (a instanceof HyperliquidAdapter) {
              const hlSpot = new HyperliquidSpotAdapter(a);
              await hlSpot.init();
              spotBalances = await hlSpot.getSpotBalances();
            }
          } else if (name === "lighter") {
            const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
            const { LighterAdapter } = await import("../../exchanges/lighter.js");
            if (a instanceof LighterAdapter) {
              const ltSpot = new LighterSpotAdapter(a);
              await ltSpot.init();
              spotBalances = await ltSpot.getSpotBalances();
            }
          }

          const nonUsdc = spotBalances.filter(b => Number(b.total) > 0 && !b.token.toUpperCase().startsWith("USDC"));
          ctx.log(`  [ARB] ${name} spot balances: ${nonUsdc.map(b => `${b.token}=${b.total}`).join(", ") || "none"}`);
          if (nonUsdc.length === 0) continue;

          const perpPositions = positionsByExchange.get(name) ?? [];
          for (const perp of perpPositions) {
            const perpKey = `${name}:${perp.symbol}`;
            if (used.has(perpKey)) { ctx.log(`  [ARB] ${perpKey} already matched cross-exchange, skip spot-perp`); continue; }
            const base = perp.symbol.replace(/-PERP$/, "").toUpperCase();
            const spotBal = nonUsdc.find(b => b.token.toUpperCase().replace(/-SPOT$/, "") === base);
            ctx.log(`  [ARB] ${name} perp ${perp.symbol}(${perp.side}) → base=${base}, spotMatch=${spotBal ? spotBal.token : "none"}`);
            if (spotBal && perp.side === "short") {
              recovered.push({ symbol: base, longExchange: `${name}-spot`, shortExchange: name, entrySpread: 0, size: perp.size, mode: "spot-perp" });
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
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const recent = payments.filter(p => p.time > oneDayAgo);
          const sum = recent.reduce((s, p) => s + parseFloat(p.payment), 0);
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
    const ratesByExchange = new Map<string, Map<string, { rate: number; price: number; sizeDecimals?: number; maxLeverage?: number }>>();
    for (const [name, a] of adapters) {
      const rates = await this.fetchRates(a, name);
      const map = new Map<string, { rate: number; price: number; sizeDecimals?: number; maxLeverage?: number }>();
      for (const r of rates) map.set(r.symbol.toUpperCase(), { rate: r.rate, price: r.price, sizeDecimals: r.sizeDecimals, maxLeverage: r.maxLeverage });
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
      let signedSpread: number;
      if (p.mode === "spot-perp") {
        // For spot-perp: long side is spot (rate=0), short side is perp
        const perpExchange = p.shortExchange;
        const perpSymbol = this.getPerpSymbol(p.symbol, perpExchange);
        const shortRate = this.findRate(ratesByExchange, perpExchange, perpSymbol)?.rate
          ?? this.findRate(ratesByExchange, perpExchange, p.symbol)?.rate;
        signedSpread = shortRate !== undefined ? annualizeRate(shortRate, perpExchange) : 0;
      } else {
        const longRate = this.findRate(ratesByExchange, p.longExchange, p.symbol)?.rate;
        const shortRate = this.findRate(ratesByExchange, p.shortExchange, p.symbol)?.rate;
        signedSpread = (longRate !== undefined && shortRate !== undefined)
          ? computeSignedAnnualSpread(shortRate, p.shortExchange, longRate, p.longExchange)
          : 0;
      }
      const sign = signedSpread >= 0 ? "+" : "";
      return `${p.symbol} ${p.longExchange}↔${p.shortExchange} ${sign}${signedSpread.toFixed(1)}%`;
    });
    ctx.state.set("arbPositionDetails", arbPosForDisplay);
    ctx.state.set("fundingTotal", `$${(ctx.state.get("fundingIncome") as number).toFixed(4)}`);

    // ── Check existing positions for close conditions ──
    const toClose: ArbOpenPosition[] = [];
    for (const pos of openPositions) {
      let signedSpread: number | undefined;

      if (pos.mode === "spot-perp") {
        const perpExchange = pos.shortExchange;
        const perpSymbol = this.getPerpSymbol(pos.symbol, perpExchange);
        const shortRate = this.findRate(ratesByExchange, perpExchange, perpSymbol)?.rate
          ?? this.findRate(ratesByExchange, perpExchange, pos.symbol)?.rate;
        if (shortRate === undefined) continue;
        signedSpread = annualizeRate(shortRate, perpExchange);
      } else {
        const longRate = this.findRate(ratesByExchange, pos.longExchange, pos.symbol)?.rate;
        const shortRate = this.findRate(ratesByExchange, pos.shortExchange, pos.symbol)?.rate;
        if (longRate === undefined || shortRate === undefined) continue;
        signedSpread = computeSignedAnnualSpread(shortRate, pos.shortExchange, longRate, pos.longExchange);
      }

      // Close if funding flipped (losing money) or spread below close threshold
      const shouldClose = signedSpread < 0 || signedSpread < params.close_spread;
      if (shouldClose) {
        // Cooldown: skip if close recently failed for this symbol
        const closeKey = `${pos.symbol}:close`;
        const cooldownUntil = this._failCooldown.get(closeKey) ?? 0;
        if (Date.now() < cooldownUntil) continue;

        const sign = signedSpread >= 0 ? "+" : "";
        ctx.log(`  [ARB] Closing ${pos.symbol}: signed spread ${sign}${signedSpread.toFixed(1)}% (close_spread=${params.close_spread}%, entry=${pos.entrySpread.toFixed(1)}%)`);

        if (pos.mode === "spot-perp") {
          await this.closeSpotPerp(pos, adapters, ctx);
          toClose.push(pos);
        } else {
          const longAdapter = adapters.get(pos.longExchange);
          const shortAdapter = adapters.get(pos.shortExchange);
          if (longAdapter && shortAdapter) {
            let closeLongOk = false;
            try {
              const closeLongResult = await longAdapter.marketOrder(pos.symbol, "sell", pos.size);
              closeLongOk = true;
              logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "long", signedSpread: signedSpread, response: closeLongResult } });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log(`  [ARB] Close long leg failed for ${pos.symbol}: ${msg} (cooldown 5m)`);
              logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "failed", error: msg, dryRun: false, meta: { mode: pos.mode, leg: "long" } });
              this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000);
            }
            if (!closeLongOk) continue; // don't close short if long failed — keep hedge intact
            try {
              const closeShortResult = await shortAdapter.marketOrder(pos.symbol, "buy", pos.size);
              logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "short", signedSpread: signedSpread, response: closeShortResult } });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log(`  [ARB] Close short leg failed for ${pos.symbol}: ${msg} — re-opening long to restore hedge`);
              logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "failed", error: msg, dryRun: false, meta: { mode: pos.mode, leg: "short" } });
              // Rollback: re-open long to restore hedge
              try {
                await longAdapter.marketOrder(pos.symbol, "buy", pos.size);
                ctx.log(`  [ARB] Rollback: re-opened long ${pos.size} ${pos.symbol} on ${pos.longExchange}`);
                logExecution({ type: "multi_leg_rollback", exchange: pos.longExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false });
              } catch (rbErr) {
                const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
                ctx.log(`  [ARB] CRITICAL: Close rollback failed for ${pos.symbol}: ${rbMsg}`);
                logExecution({ type: "multi_leg_rollback", exchange: pos.longExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "failed", error: rbMsg, dryRun: false });
              }
              this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000);
              continue;
            }
            toClose.push(pos);
            ctx.log(`  [ARB] Closed ${pos.symbol} position`);
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

    // Perp-perp opportunities
    for (const sym of allSymbols) {
      let minRate = Infinity, maxRate = -Infinity;
      let minExchange = "", maxExchange = "";

      for (const exName of exchangeNames) {
        const rate = this.findRate(ratesByExchange, exName, sym)?.rate;
        if (rate === undefined) continue;
        if (rate < minRate) { minRate = rate; minExchange = exName; }
        if (rate > maxRate) { maxRate = rate; maxExchange = exName; }
      }

      if (minExchange && maxExchange && minExchange !== maxExchange) {
        const spread = computeSignedAnnualSpread(maxRate, maxExchange, minRate, minExchange);
        if (spread >= params.min_spread) {
          opportunities.push({
            symbol: sym,
            longExchange: minExchange,
            shortExchange: maxExchange,
            longRate: minRate,
            shortRate: maxRate,
            spread,
            mode: "perp-perp",
          });
        }
      }
    }

    // Spot-perp opportunities: for each exchange with positive perp rate, check if spot is available
    const spotPerpMinSpread = params.spot_perp_min_spread ?? params.min_spread;
    for (const [name, a] of adapters) {
      try {
        const spotAdapter = await this.getSpotAdapter(name, a);
        if (!spotAdapter) continue;

        const spotMarkets = await spotAdapter.getSpotMarkets();
        const spotSymbols = new Set(spotMarkets.map(m => m.baseToken.toUpperCase()));

        const perpRates = ratesByExchange.get(name);
        if (!perpRates) continue;

        for (const [sym, { rate }] of perpRates) {
          // Only consider positive funding (shorts receive, longs pay)
          if (rate <= 0) continue;
          const base = sym.replace(/-PERP$/, "").toUpperCase();
          if (!spotSymbols.has(base)) continue;

          const annualSpread = annualizeRate(rate, name);
          if (annualSpread >= spotPerpMinSpread) {
            opportunities.push({
              symbol: base,
              longExchange: `${name}-spot`,
              shortExchange: name,
              longRate: 0,
              shortRate: rate,
              spread: annualSpread,
              mode: "spot-perp",
            });
          }
        }
      } catch { /* exchange doesn't support spot */ }
    }

    opportunities.sort((a, b) => b.spread - a.spread);

    if (opportunities.length > 0) {
      // Only log opportunities when there's room for new positions
      if (arbPositions < params.max_positions) {
        const top = opportunities.slice(0, 3);
        for (const opp of top) {
          if (opp.mode === "spot-perp") {
            ctx.log(`  [ARB] ${opp.symbol}: ${opp.spread.toFixed(1)}% spread [spot-perp] (short ${opp.shortExchange} ${(opp.shortRate * 100).toFixed(4)}%)`);
          } else {
            ctx.log(`  [ARB] ${opp.symbol}: ${opp.spread.toFixed(1)}% spread (long ${opp.longExchange} ${(opp.longRate * 100).toFixed(4)}% / short ${opp.shortExchange} ${(opp.shortRate * 100).toFixed(4)}%)`);
          }
        }
      }

      // Auto-execute: try each opportunity until one succeeds
      if (arbPositions < params.max_positions) {
        // Skip symbols already in open positions
        const openSymbols = new Set((ctx.state.get("arbOpenPositions") as ArbOpenPosition[]).map(p => p.symbol.toUpperCase()));
        let skipMargin = 0;
        let skipCooldown = 0;
        for (const best of opportunities) {
          if (openSymbols.has(best.symbol.toUpperCase())) continue;
          // Cooldown: skip if entry recently failed for this symbol
          const entryKey = `${best.symbol}:entry`;
          const entryCooldown = this._failCooldown.get(entryKey) ?? 0;
          if (Date.now() < entryCooldown) { skipCooldown++; continue; }
          if (best.mode === "spot-perp") {
            const opened = await this.openSpotPerp(best, adapters, ctx, ratesByExchange);
            if (opened) return [{ type: "noop" }];
            continue;
          }

          const longAdapter = adapters.get(best.longExchange);
          const shortAdapter = adapters.get(best.shortExchange);
          if (!longAdapter || !shortAdapter) continue;

          const price = this.findRate(ratesByExchange, best.longExchange, best.symbol)?.price ?? 0;
          if (price <= 0) continue;

          // Determine leverage for this symbol
          const configLeverage = params.leverage ?? 3;
          const longMaxLev = this.findRate(ratesByExchange, best.longExchange, best.symbol)?.maxLeverage ?? 1;
          const shortMaxLev = this.findRate(ratesByExchange, best.shortExchange, best.symbol)?.maxLeverage ?? 1;
          const leverage = Math.min(configLeverage, longMaxLev, shortMaxLev);

          // Set leverage on both exchanges before ordering
          try {
            await Promise.all([
              longAdapter.setLeverage(best.symbol, leverage, "cross"),
              shortAdapter.setLeverage(best.symbol, leverage, "cross"),
            ]);
          } catch { /* non-critical, some exchanges set leverage on order */ }

          // Balance + margin check
          let targetSizeUsd = params.size_usd;
          try {
            const [longBal, shortBal] = await Promise.all([
              longAdapter.getBalance(),
              shortAdapter.getBalance(),
            ]);

            // Check margin usage (skip if > 70%)
            const longEquity = parseFloat(longBal.equity);
            const shortEquity = parseFloat(shortBal.equity);
            const longMarginPct = longEquity > 0 ? parseFloat(longBal.marginUsed) / longEquity * 100 : 0;
            const shortMarginPct = shortEquity > 0 ? parseFloat(shortBal.marginUsed) / shortEquity * 100 : 0;
            if (longMarginPct > 70 || shortMarginPct > 70) {
              skipMargin++;
              continue;
            }

            // Required margin per leg = sizeUsd / leverage
            const longAvail = parseFloat(longBal.available);
            const shortAvail = parseFloat(shortBal.available);
            const minAvail = Math.min(longAvail, shortAvail);
            const requiredMarginPerLeg = targetSizeUsd / leverage;
            if (minAvail < requiredMarginPerLeg) {
              // Try reducing size to what's affordable
              const maxAffordableNotional = minAvail * leverage * 0.8;
              if (maxAffordableNotional < 10) {
                ctx.log(`  [ARB] Skip ${best.symbol}: insufficient margin ($${minAvail.toFixed(2)} < $${requiredMarginPerLeg.toFixed(2)} needed at ${leverage}x)`);
                continue;
              }
              ctx.log(`  [ARB] Size reduced $${targetSizeUsd} → $${maxAffordableNotional.toFixed(0)} (limited by margin $${minAvail.toFixed(2)} at ${leverage}x)`);
              targetSizeUsd = Math.floor(maxAffordableNotional);
            }
          } catch { /* non-critical, proceed with original size */ }

          // Liquidity check
          const liq = await checkArbLiquidity(
            longAdapter, shortAdapter, best.symbol, targetSizeUsd, 0.5,
            (msg) => ctx.log(`  ${msg}`),
          );
          if (!liq.viable) continue;

          // Compute matched size (use actual precision from exchange market data)
          const longDec = this.findRate(ratesByExchange, best.longExchange, best.symbol)?.sizeDecimals;
          const shortDec = this.findRate(ratesByExchange, best.shortExchange, best.symbol)?.sizeDecimals;
          let matched = computeMatchedSize(liq.adjustedSizeUsd, price, best.longExchange, best.shortExchange, { longSizeDecimals: longDec, shortSizeDecimals: shortDec });
          if (!matched) {
            ctx.log(`  [ARB] Skip ${best.symbol}: can't compute matched size (min notional or precision issue)`);
            continue;
          }

          ctx.log(`  [ARB] Opening: ${matched.size} ${best.symbol} on both legs ($${matched.notional.toFixed(0)}/leg, slippage ~${liq.longSlippage.toFixed(2)}%/${liq.shortSlippage.toFixed(2)}%)`);

          // Step 1: Execute long leg first
          let longResult: unknown;
          try {
            longResult = await longAdapter.marketOrder(best.symbol, "buy", matched.size);
            logExecution({ type: "arb_entry", exchange: best.longExchange, symbol: best.symbol, side: "buy", size: matched.size, notional: matched.notional / 2, status: "success", dryRun: false, meta: { mode: "perp-perp", leg: "long", response: longResult } });
          } catch (longErr) {
            const msg = longErr instanceof Error ? longErr.message : String(longErr);
            ctx.log(`  [ARB] Long leg failed for ${best.symbol}: ${msg} (cooldown 5m)`);
            logExecution({ type: "arb_entry", exchange: best.longExchange, symbol: best.symbol, side: "buy", size: matched.size, status: "failed", error: msg, dryRun: false, meta: { mode: "perp-perp", leg: "long" } });
            this._failCooldown.set(`${best.symbol}:entry`, Date.now() + 5 * 60 * 1000);
            continue;
          }

          // Step 2: Execute short leg
          try {
            const shortResult = await shortAdapter.marketOrder(best.symbol, "sell", matched.size);
            logExecution({ type: "arb_entry", exchange: best.shortExchange, symbol: best.symbol, side: "sell", size: matched.size, notional: matched.notional / 2, status: "success", dryRun: false, meta: { mode: "perp-perp", leg: "short", response: shortResult } });
          } catch (shortErr) {
            const msg = shortErr instanceof Error ? shortErr.message : String(shortErr);
            ctx.log(`  [ARB] Short leg failed for ${best.symbol}: ${msg} — ROLLING BACK long leg (cooldown 5m)`);
            logExecution({ type: "arb_entry", exchange: best.shortExchange, symbol: best.symbol, side: "sell", size: matched.size, status: "failed", error: msg, dryRun: false, meta: { mode: "perp-perp", leg: "short" } });
            // Rollback: close the long position
            try {
              await longAdapter.marketOrder(best.symbol, "sell", matched.size);
              ctx.log(`  [ARB] Rollback success: closed long ${matched.size} ${best.symbol} on ${best.longExchange}`);
              logExecution({ type: "multi_leg_rollback", exchange: best.longExchange, symbol: best.symbol, side: "sell", size: matched.size, status: "success", dryRun: false });
            } catch (rbErr) {
              const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
              ctx.log(`  [ARB] CRITICAL: Rollback failed for ${best.symbol}: ${rbMsg}`);
              logExecution({ type: "multi_leg_rollback", exchange: best.longExchange, symbol: best.symbol, side: "sell", size: matched.size, status: "failed", error: rbMsg, dryRun: false });
            }
            this._failCooldown.set(`${best.symbol}:entry`, Date.now() + 5 * 60 * 1000);
            continue;
          }

          // Verify fills match
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

          // Verify both positions actually exist (catches instant liquidation)
          try {
            const [longPositions, shortPositions] = await Promise.all([
              longAdapter.getPositions(),
              shortAdapter.getPositions(),
            ]);
            const longExists = longPositions.some(p => p.symbol.toUpperCase() === best.symbol.toUpperCase() && parseFloat(p.size) > 0);
            const shortExists = shortPositions.some(p => p.symbol.toUpperCase() === best.symbol.toUpperCase() && parseFloat(p.size) > 0);
            if (!longExists || !shortExists) {
              ctx.log(`  [ARB] Position verification failed for ${best.symbol}: long=${longExists}, short=${shortExists}`);
              logExecution({ type: "arb_entry", exchange: `${best.longExchange}↔${best.shortExchange}`, symbol: best.symbol, side: "verify", size: matched.size, status: "failed", error: `Position missing after fill: long=${longExists} short=${shortExists}`, dryRun: false });
              // Rollback whichever side exists
              if (longExists && !shortExists) {
                try { await longAdapter.marketOrder(best.symbol, "sell", matched.size); ctx.log(`  [ARB] Rollback: closed phantom long ${best.symbol}`); } catch { /* best effort */ }
              }
              if (shortExists && !longExists) {
                try { await shortAdapter.marketOrder(best.symbol, "buy", matched.size); ctx.log(`  [ARB] Rollback: closed phantom short ${best.symbol}`); } catch { /* best effort */ }
              }
              this._failCooldown.set(`${best.symbol}:entry`, Date.now() + 10 * 60 * 1000);
              continue;
            }
          } catch (verifyErr) {
            ctx.log(`  [ARB] Position verification error for ${best.symbol}: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`);
          }

          // Track position
          const currentPositions = ctx.state.get("arbOpenPositions") as ArbOpenPosition[];
          currentPositions.push({
            symbol: best.symbol,
            longExchange: best.longExchange,
            shortExchange: best.shortExchange,
            entrySpread: best.spread,
            size: matched.size,
            mode: "perp-perp",
          });
          ctx.state.set("arbOpenPositions", currentPositions);
          ctx.state.set("arbPositions", currentPositions.length);
          ctx.log(`  [ARB] Position opened! (${currentPositions.length}/${params.max_positions})`);
          return [{ type: "noop" }];
        }
        // Log skip summary only when there were skips (avoids noise when nothing happened)
        if (skipMargin > 0 || skipCooldown > 0) {
          const parts: string[] = [];
          if (skipMargin > 0) parts.push(`${skipMargin} margin`);
          if (skipCooldown > 0) parts.push(`${skipCooldown} cooldown`);
          ctx.log(`  [ARB] Skipped ${skipMargin + skipCooldown} opportunities (${parts.join(", ")})`);
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

    if (openPositions && openPositions.length > 0) {
      const adapters = new Map<string, ExchangeAdapter>();
      adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
      if (extraAdapters) {
        for (const [name, a] of extraAdapters) adapters.set(name, a);
      }

      for (const pos of openPositions) {
        if (pos.mode === "spot-perp") {
          await this.closeSpotPerp(pos, adapters, ctx);
        } else {
          const longAdapter = adapters.get(pos.longExchange);
          const shortAdapter = adapters.get(pos.shortExchange);
          if (longAdapter && shortAdapter) {
            ctx.log(`  [ARB] Closing ${pos.symbol} on stop (${pos.size})`);
            try {
              const closeLongResult = await longAdapter.marketOrder(pos.symbol, "sell", pos.size);
              logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "long", stop: true, response: closeLongResult } });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log(`  [ARB] Close on stop failed (long) for ${pos.symbol}: ${msg}`);
              logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "failed", error: msg, dryRun: false, meta: { mode: pos.mode, leg: "long", stop: true } });
            }
            try {
              const closeShortResult = await shortAdapter.marketOrder(pos.symbol, "buy", pos.size);
              logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "short", stop: true, response: closeShortResult } });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log(`  [ARB] Close on stop failed (short) for ${pos.symbol}: ${msg}`);
              logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "failed", error: msg, dryRun: false, meta: { mode: pos.mode, leg: "short", stop: true } });
            }
          }
        }
      }
      ctx.state.set("arbOpenPositions", []);
      ctx.state.set("arbPositions", 0);
    }

    // Cancel on extra adapters directly
    if (extraAdapters) {
      for (const [, a] of extraAdapters) {
        try { await a.cancelAllOrders(); } catch { /* best effort */ }
      }
    }
    return [{ type: "cancel_all" }];
  }

  /** Close a spot-perp position: sell spot, transfer USDC back, close perp short */
  private async closeSpotPerp(
    pos: ArbOpenPosition,
    adapters: Map<string, ExchangeAdapter>,
    ctx: StrategyContext,
  ): Promise<void> {
    const exchangeName = pos.longExchange.replace("-spot", "");
    const perpAdapter = adapters.get(pos.shortExchange) ?? adapters.get(exchangeName);
    if (!perpAdapter) {
      ctx.log(`  [ARB] Close spot-perp failed: no adapter for ${pos.shortExchange}`);
      return;
    }

    try {
      const spotAdapter = await this.getSpotAdapter(exchangeName, perpAdapter);
      if (!spotAdapter) {
        ctx.log(`  [ARB] Close spot-perp failed: spot adapter not available for ${exchangeName}`);
        return;
      }

      ctx.log(`  [ARB] Closing spot-perp ${pos.symbol} on stop (spot sell + perp buy)`);

      // Step 1: Sell spot
      try {
        await spotAdapter.spotMarketOrder(pos.symbol, "sell", pos.size);
        ctx.log(`  [ARB] Sold spot ${pos.size} ${pos.symbol}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARB] Spot sell failed for ${pos.symbol}: ${msg}`);
      }

      // Step 2: Transfer USDC back to perp (use 95% of notional as estimate)
      try {
        const perpSymbol = this.getPerpSymbol(pos.symbol, pos.shortExchange);
        const priceEstimate = await this.getPriceEstimate(perpAdapter, perpSymbol, pos.symbol);
        const proceeds = priceEstimate * parseFloat(pos.size) * 0.95;
        if (proceeds > 1) {
          await this.transferUsdcToPerp(spotAdapter, exchangeName, Math.floor(proceeds));
          ctx.log(`  [ARB] Transferred ~$${Math.floor(proceeds)} USDC back to perp`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARB] USDC transfer back failed: ${msg}`);
      }

      // Step 3: Close perp short
      try {
        const perpSymbol = this.getPerpSymbol(pos.symbol, pos.shortExchange);
        await perpAdapter.marketOrder(perpSymbol, "buy", pos.size);
        ctx.log(`  [ARB] Closed perp short ${pos.size} ${perpSymbol}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARB] Perp close failed for ${pos.symbol}: ${msg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [ARB] Close spot-perp failed for ${pos.symbol}: ${msg}`);
    }
  }

  /** Open a spot-perp position: transfer USDC to spot, buy spot, short perp */
  private async openSpotPerp(
    opp: ArbOpportunity,
    adapters: Map<string, ExchangeAdapter>,
    ctx: StrategyContext,
    ratesByExchange: Map<string, Map<string, { rate: number; price: number; sizeDecimals?: number; maxLeverage?: number }>>,
  ): Promise<boolean> {
    const params = this.params;
    const exchangeName = opp.longExchange.replace("-spot", "");
    const perpAdapter = adapters.get(opp.shortExchange) ?? adapters.get(exchangeName);
    if (!perpAdapter) {
      ctx.log(`  [ARB] Open spot-perp failed: no adapter for ${opp.shortExchange}`);
      return false;
    }

    try {
      const spotAdapter = await this.getSpotAdapter(exchangeName, perpAdapter);
      if (!spotAdapter) {
        ctx.log(`  [ARB] Open spot-perp failed: spot adapter not available for ${exchangeName}`);
        return false;
      }

      // Determine leverage for perp leg
      const configLeverage = params.leverage ?? 3;
      const perpSymbolUpper = this.getPerpSymbol(opp.symbol, opp.shortExchange).toUpperCase();
      const perpMaxLev = this.findRate(ratesByExchange, opp.shortExchange, perpSymbolUpper)?.maxLeverage
        ?? this.findRate(ratesByExchange, opp.shortExchange, opp.symbol.toUpperCase())?.maxLeverage
        ?? 1;
      const leverage = Math.min(configLeverage, perpMaxLev);

      // Set leverage on perp before ordering
      try {
        await perpAdapter.setLeverage(this.getPerpSymbol(opp.symbol, opp.shortExchange), leverage, "cross");
      } catch { /* non-critical */ }

      // Balance check: spot needs full notional, perp needs sizeUsd / leverage margin
      let targetSizeUsd = params.size_usd;
      try {
        const perpBal = await perpAdapter.getBalance();

        // Check margin usage
        const perpEquity = parseFloat(perpBal.equity);
        const perpMarginPct = perpEquity > 0 ? parseFloat(perpBal.marginUsed) / perpEquity * 100 : 0;
        if (perpMarginPct > 70) {
          ctx.log(`  [ARB] Skip spot-perp ${opp.symbol}: perp margin usage too high (${perpMarginPct.toFixed(0)}%)`);
          return false;
        }

        const perpAvail = parseFloat(perpBal.available);
        // Total needed from perp account: spot notional (to transfer) + perp margin
        const perpMarginRequired = targetSizeUsd / leverage;
        const totalNeeded = targetSizeUsd + perpMarginRequired;
        if (perpAvail < totalNeeded) {
          // Solve for max affordable: perpAvail >= notional + notional/lev = notional*(1 + 1/lev)
          const maxNotional = perpAvail * 0.8 / (1 + 1 / leverage);
          if (maxNotional < 10) {
            ctx.log(`  [ARB] Skip spot-perp ${opp.symbol}: insufficient balance ($${perpAvail.toFixed(2)} available, need $${totalNeeded.toFixed(2)})`);
            return false;
          }
          ctx.log(`  [ARB] Spot-perp size reduced $${targetSizeUsd} → $${maxNotional.toFixed(0)} (limited by balance at ${leverage}x)`);
          targetSizeUsd = Math.floor(maxNotional);
        }
      } catch { /* non-critical */ }

      const perpSymbol = this.getPerpSymbol(opp.symbol, opp.shortExchange);
      const priceEstimate = await this.getPriceEstimate(perpAdapter, perpSymbol, opp.symbol);
      if (priceEstimate <= 0) {
        ctx.log(`  [ARB] Skip spot-perp ${opp.symbol}: can't determine price`);
        return false;
      }

      // Liquidity check
      const liq = await checkSpotPerpLiquidity(
        spotAdapter, perpAdapter, opp.symbol, perpSymbol, targetSizeUsd, 0.5,
        (msg) => ctx.log(`  ${msg}`),
      );
      if (!liq.viable) return false;

      // Compute matched size
      const spotMarkets = await spotAdapter.getSpotMarkets();
      const spotMarket = spotMarkets.find(m => m.baseToken.toUpperCase() === opp.symbol.toUpperCase());
      const spotDecimals = spotMarket?.sizeDecimals;
      const matched = computeSpotPerpMatchedSize(liq.adjustedSizeUsd, priceEstimate, exchangeName, opp.shortExchange, spotDecimals);
      if (!matched) {
        ctx.log(`  [ARB] Skip spot-perp ${opp.symbol}: can't compute matched size`);
        return false;
      }

      ctx.log(`  [ARB] Opening spot-perp: ${matched.size} ${opp.symbol} ($${matched.notional.toFixed(0)}, slippage ~${liq.spotSlippage.toFixed(2)}%/${liq.perpSlippage.toFixed(2)}%)`);

      // Step 1: Transfer USDC to spot
      const transferAmt = Math.ceil(matched.notional * 1.02); // slight buffer for price movement
      await this.transferUsdcToSpot(spotAdapter, exchangeName, transferAmt);
      ctx.log(`  [ARB] Transferred $${transferAmt} USDC to spot`);

      // Step 2: Buy spot
      let spotResult: unknown;
      try {
        spotResult = await spotAdapter.spotMarketOrder(opp.symbol, "buy", matched.size);
        ctx.log(`  [ARB] Bought spot ${matched.size} ${opp.symbol}`);
        logExecution({ type: "arb_entry", exchange: opp.longExchange, symbol: opp.symbol, side: "buy", size: matched.size, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "spot", response: spotResult } });
      } catch (spotErr) {
        const msg = spotErr instanceof Error ? spotErr.message : String(spotErr);
        ctx.log(`  [ARB] Open spot-perp failed (spot buy) for ${opp.symbol}: ${msg}`);
        logExecution({ type: "arb_entry", exchange: opp.longExchange, symbol: opp.symbol, side: "buy", size: matched.size, status: "failed", error: msg, dryRun: false, meta: { mode: "spot-perp", leg: "spot" } });
        return false;
      }

      // Step 3: Short perp
      try {
        const perpResult = await perpAdapter.marketOrder(perpSymbol, "sell", matched.size);
        ctx.log(`  [ARB] Shorted perp ${matched.size} ${perpSymbol}`);
        logExecution({ type: "arb_entry", exchange: opp.shortExchange, symbol: opp.symbol, side: "sell", size: matched.size, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "perp", response: perpResult } });
      } catch (perpErr) {
        const msg = perpErr instanceof Error ? perpErr.message : String(perpErr);
        ctx.log(`  [ARB] Open spot-perp failed (perp short) for ${opp.symbol}: ${msg} — ROLLING BACK spot buy`);
        logExecution({ type: "arb_entry", exchange: opp.shortExchange, symbol: opp.symbol, side: "sell", size: matched.size, status: "failed", error: msg, dryRun: false, meta: { mode: "spot-perp", leg: "perp" } });
        // Rollback: sell spot back and transfer USDC back to perp
        try {
          await spotAdapter.spotMarketOrder(opp.symbol, "sell", matched.size);
          ctx.log(`  [ARB] Rollback success: sold spot ${matched.size} ${opp.symbol}`);
          logExecution({ type: "multi_leg_rollback", exchange: opp.longExchange, symbol: opp.symbol, side: "sell", size: matched.size, status: "success", dryRun: false });
          // Transfer USDC back to perp account
          try {
            await this.transferUsdcToPerp(spotAdapter, opp.longExchange.replace("-spot", ""), Math.ceil(matched.notional * 1.02));
          } catch { /* best effort */ }
        } catch (rbErr) {
          const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
          ctx.log(`  [ARB] CRITICAL: Spot rollback failed for ${opp.symbol}: ${rbMsg}`);
          logExecution({ type: "multi_leg_rollback", exchange: opp.longExchange, symbol: opp.symbol, side: "sell", size: matched.size, status: "failed", error: rbMsg, dryRun: false });
        }
        return false;
      }

      // Track position
      const currentPositions = ctx.state.get("arbOpenPositions") as ArbOpenPosition[];
      currentPositions.push({
        symbol: opp.symbol,
        longExchange: opp.longExchange,
        shortExchange: opp.shortExchange,
        entrySpread: opp.spread,
        size: matched.size,
        mode: "spot-perp",
      });
      ctx.state.set("arbOpenPositions", currentPositions);
      ctx.state.set("arbPositions", currentPositions.length);
      ctx.log(`  [ARB] Spot-perp position opened! (${currentPositions.length}/${params.max_positions})`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [ARB] Open spot-perp failed for ${opp.symbol}: ${msg}`);
      logExecution({ type: "arb_entry", exchange: opp.shortExchange, symbol: opp.symbol, side: "spot-long/perp-short", size: "0", status: "failed", error: msg, dryRun: false, meta: { mode: "spot-perp" } });
      return false;
    }
  }

  /** Transfer USDC from perp to spot account (exchange-specific) */
  private async transferUsdcToSpot(spotAdapter: SpotAdapter, exchangeName: string, amount: number): Promise<void> {
    if (exchangeName === "hyperliquid") {
      const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
      if (spotAdapter instanceof HyperliquidSpotAdapter) {
        await spotAdapter.transferUsdcToSpot(amount);
        return;
      }
    } else if (exchangeName === "lighter") {
      const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
      if (spotAdapter instanceof LighterSpotAdapter) {
        await spotAdapter.transferUsdcToSpot(amount);
        return;
      }
    }
  }

  /** Transfer USDC from spot to perp account (exchange-specific) */
  private async transferUsdcToPerp(spotAdapter: SpotAdapter, exchangeName: string, amount: number): Promise<void> {
    if (exchangeName === "hyperliquid") {
      const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
      if (spotAdapter instanceof HyperliquidSpotAdapter) {
        await spotAdapter.transferUsdcToPerp(amount);
        return;
      }
    } else if (exchangeName === "lighter") {
      const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
      if (spotAdapter instanceof LighterSpotAdapter) {
        await spotAdapter.transferUsdcToPerp(amount);
        return;
      }
    }
  }

  /**
   * Get spot adapter for a given exchange name + perp adapter instance.
   * Returns null if the exchange doesn't support spot or instantiation fails.
   */
  private async getSpotAdapter(name: string, adapter: ExchangeAdapter): Promise<SpotAdapter | null> {
    try {
      if (name === "hyperliquid") {
        const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
        const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
        if (adapter instanceof HyperliquidAdapter) {
          const spot = new HyperliquidSpotAdapter(adapter);
          await spot.init();
          return spot;
        }
      } else if (name === "lighter") {
        const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
        const { LighterAdapter } = await import("../../exchanges/lighter.js");
        if (adapter instanceof LighterAdapter) {
          const spot = new LighterSpotAdapter(adapter);
          await spot.init();
          return spot;
        }
      }
    } catch { /* not supported */ }
    return null;
  }

  /**
   * Resolve the perp symbol for a given base symbol on an exchange.
   * HL getPositions() returns symbols like "PURR" or "PURR-PERP" — we normalize here.
   */
  private getPerpSymbol(baseSymbol: string, exchangeName: string): string {
    const base = baseSymbol.replace(/-PERP$/, "").toUpperCase();
    void exchangeName;
    return base;
  }

  /** Look up rate from ratesByExchange, trying symbol, symbol-PERP, and symbol without -PERP */
  private findRate(ratesByExchange: Map<string, Map<string, { rate: number; price: number; sizeDecimals?: number; maxLeverage?: number }>>, exchange: string, symbol: string): { rate: number; price: number; sizeDecimals?: number; maxLeverage?: number } | undefined {
    const map = ratesByExchange.get(exchange);
    if (!map) return undefined;
    const upper = symbol.toUpperCase();
    return map.get(upper)
      ?? map.get(upper + "-PERP")
      ?? map.get(upper.replace(/-PERP$/, ""));
  }

  /**
   * Get a price estimate for a symbol from the perp adapter.
   * Tries the base symbol first, then with -PERP suffix.
   */
  private async getPriceEstimate(perpAdapter: ExchangeAdapter, perpSymbol: string, fallbackSymbol: string): Promise<number> {
    try {
      const markets = await perpAdapter.getMarkets();
      const market = markets.find(m =>
        m.symbol.toUpperCase() === perpSymbol.toUpperCase() ||
        m.symbol.toUpperCase() === fallbackSymbol.toUpperCase() ||
        m.symbol.toUpperCase() === `${fallbackSymbol.toUpperCase()}-PERP`,
      );
      return market ? parseFloat(market.markPrice) : 0;
    } catch {
      return 0;
    }
  }

  private async fetchRates(
    adapter: ExchangeAdapter,
    _exchangeName: string,
  ): Promise<{ symbol: string; rate: number; price: number; sizeDecimals?: number; maxLeverage?: number }[]> {
    try {
      const markets = await adapter.getMarkets();
      return markets
        .filter(m => m.fundingRate != null)
        .map(m => ({
          symbol: m.symbol,
          rate: parseFloat(m.fundingRate!),
          price: parseFloat(m.markPrice),
          sizeDecimals: m.sizeDecimals,
          maxLeverage: m.maxLeverage,
        }));
    } catch {
      return [];
    }
  }
}

registerStrategy("funding-arb", (_config) => new FundingArbStrategy());
