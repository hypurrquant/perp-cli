/**
 * Spot-Perp Arbitrage Strategy
 *
 * Focused strategy: buy spot (HL or Lighter) + short perp on the BEST of 4 exchanges.
 * No perp-perp logic. History-based entry/exit with short rotation.
 *
 * Strategy layer handles ONLY decisions (opportunity scanning, scoring, close/rotation decisions).
 * Execution layer (SpotPerpExecutor) handles ALL exchange interactions.
 */

import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { requiredArbMargin } from "../../rebalance.js";
import { registerStrategy } from "../strategy-registry.js";
import { getFundingHours } from "../../funding.js";
import { annualizeHourlyRate } from "../../funding/normalize.js";
import { pruneExecutionLog } from "../../execution-log.js";
import {
  type RateEntry, type RateMap, type FundingScore,
  buildAdapterMap,
  getPerpSymbol, findRate, cappedLeverage, matchSymbol, fetchRates,
  scoreFunding, assertFundingHistoryPeriods, isPositionGone, botSpotPerpMatches, assertFundingArbLegs, cancelBotSymbols, collectFundingSince } from "./funding-arb-utils.js";
import type { SpotMarketInfo } from "../../exchanges/spot-interface.js";
import type { VenueMarket } from "../../exchanges/venue-types.js";
import { SpotPerpExecutor } from "./spot-perp-executor.js";
import { findSpotQuoteBalance, getBotSpotAdapter, nonQuoteSpotBalances, spotNetworkOf, spotSharesPerpMargin, spotTokenBase } from "../../exchanges/spot-factory.js";
import type { SpotAdapter } from "../../exchanges/spot-interface.js";
import { getVenue } from "../../exchanges/venue.js";
import { updatePositionEntry } from "../../arb/state.js";
import { recordSpotPerpClose, recordSpotPerpEntry, stateEntryOf, stateWriteFailed } from "./spot-perp-state.js";
import { isQuarantined, quarantineSymbol } from "../quarantine.js";

/** Consecutive failed closes before a position is quarantined (no sell→fail→re-hedge loop). */
const MAX_CLOSE_FAILURES = 3;
/** Spot leg buying power: notional plus 1% for the taker fee and the spot buy's slippage bound. */
const SPOT_FEE_BUFFER = 1.01;

// ── Types ──

interface SpotPerpPosition {
  id: string; symbol: string; spotExchange: string; perpExchange: string;
  size: string; entryTime: number; entryRate: number;
  fundingHistory: { time: number; amount: number }[]; lastFundingCheck: number;
}

interface SpotPerpArbParams {
  type: "spot-perp-arb"; min_rate: number; close_rate: number; size_usd: number;
  max_positions: number; exchanges: string[]; leverage: number; min_hold_hours: number;
  min_consistency: number; history_periods: number; rotation_threshold: number;
}

let _posIdCounter = 0;
function genPosId(): string { return `spa-${Date.now()}-${++_posIdCounter}`; }

// ── Strategy ──

export class SpotPerpArbStrategy implements Strategy {
  readonly name = "spot-perp-arb";
  private readonly executor = new SpotPerpExecutor();

  describe() {
    return {
      description: "Spot-perp arbitrage — buy spot + short perp on best exchange, history-based",
      params: [
        { name: "min_rate", type: "number" as const, required: false, default: 10, description: "Min annualized % to enter" },
        { name: "close_rate", type: "number" as const, required: false, default: 2, description: "Close if avg rate falls below this %" },
        { name: "size_usd", type: "number" as const, required: false, default: 50, description: "Per position USD size" },
        { name: "max_positions", type: "number" as const, required: false, default: 5, description: "Max concurrent positions" },
        { name: "exchanges", type: "string" as const, required: true, description: "Comma-separated perp exchange names" },
        { name: "leverage", type: "number" as const, required: false, default: 3, description: "Perp side leverage" },
        { name: "min_hold_hours", type: "number" as const, required: false, default: 4, description: "Min hold before close (hours)" },
        { name: "min_consistency", type: "number" as const, required: false, default: 0.7, description: "Min positive payment ratio (0-1)" },
        { name: "history_periods", type: "number" as const, required: false, default: 6, description: "Funding periods to check" },
        { name: "rotation_threshold", type: "number" as const, required: false, default: 10, description: "% improvement needed to rotate short" },
      ],
    };
  }

  private _config: Record<string, unknown> = {};
  private _failCooldown = new Map<string, number>();
  /** Consecutive failed close attempts per symbol (quarantined at MAX_CLOSE_FAILURES). */
  private _closeFailures = new Map<string, number>();
  /** Venues whose positions could not be read during recovery: no entries there until re-read. */
  private _unrecovered = new Set<string>();
  /** Perp symbols this bot entered or tracked this run — the only symbols its stop cancels orders on. */
  private _traded = new Set<string>();
  private _fundingScoreCache = new Map<string, { score: FundingScore; ts: number }>();

  private get params(): SpotPerpArbParams {
    const c = this._config;
    return {
      type: "spot-perp-arb",
      min_rate: (c.min_rate as number) ?? 10,
      close_rate: (c.close_rate as number) ?? 2,
      size_usd: (c.size_usd as number) ?? 50,
      max_positions: (c.max_positions as number) ?? 5,
      exchanges: (typeof c.exchanges === "string" ? (c.exchanges as string).split(",").map(s => s.trim()) : c.exchanges as string[]) ?? [],
      leverage: (c.leverage as number) ?? 3,
      min_hold_hours: (c.min_hold_hours as number) ?? 4,
      min_consistency: (c.min_consistency as number) ?? 0.7,
      history_periods: (c.history_periods as number) ?? 6,
      rotation_threshold: (c.rotation_threshold as number) ?? 10,
    };
  }

  // ── init ──

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    assertFundingArbLegs(ctx);
    try { pruneExecutionLog(30); } catch { /* non-critical */ }
    this._config = ctx.config;
    const p = this.params;
    // Config-time check: a history_periods above a leg venue's cap would fail every tick.
    assertFundingHistoryPeriods(p.history_periods, p.exchanges);
    ctx.state.set("arbRunning", true);
    ctx.state.set("spaPositions", [] as SpotPerpPosition[]);
    ctx.state.set("arbPositions", 0);
    ctx.state.set("fundingIncome", 0);
    // Payments up to this instant are covered by the startup recovery (last 24 h); the periodic
    // check books only payments newer than it (collectFundingSince high-water mark).
    ctx.state.set("fundingStartTime", Date.now());
    ctx.state.set("fundingLastCheck", Date.now());
    ctx.log(`  [SPA] Ready | rate >= ${p.min_rate}% | close < ${p.close_rate}% | size $${p.size_usd}`);
    ctx.log(`  [SPA] Consistency >= ${(p.min_consistency * 100).toFixed(0)}% | history ${p.history_periods} periods | rotation ${p.rotation_threshold}%`);
    ctx.log(`  [SPA] Exchanges: ${p.exchanges.join(", ")}`);
    try {
      const adapters = buildAdapterMap(ctx);
      const { recovered, unreadable } = await this.recoverPositions(adapters, ctx);
      this._unrecovered = unreadable;
      if (recovered.length > 0) {
        ctx.state.set("spaPositions", recovered);
        ctx.state.set("arbPositions", recovered.length);
        ctx.log(`  [SPA] Recovered ${recovered.length} position(s)`);
      }
      // Load historical funding
      let historicalFunding = 0;
      for (const [name, a] of adapters) {
        try {
          const payments = await a.getFundingPayments(200);
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const startedAt = ctx.state.get("fundingStartTime") as number;
          const sum = payments.filter(fp => fp.time > oneDayAgo && fp.time <= startedAt).reduce((s, fp) => s + parseFloat(fp.payment), 0);
          if (Math.abs(sum) > 0.001) { historicalFunding += sum; ctx.log(`  [FUND] ${name}: $${sum.toFixed(4)} historical`); }
        } catch (e) {
          ctx.log(`  [FUND] ${name}: funding history unavailable — historical funding excludes it: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (Math.abs(historicalFunding) > 0.001) ctx.state.set("fundingIncome", historicalFunding);
    } catch (err) {
      ctx.log(`  [SPA] Position recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── onTick ──

  async onTick(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const p = this.params;
    const positions = ctx.state.get("spaPositions") as SpotPerpPosition[];
    const adapters = buildAdapterMap(ctx);

    // Retry recovery on venues whose positions could not be read at init.
    if (this._unrecovered.size > 0) {
      const { recovered, unreadable } = await this.recoverPositions(adapters, ctx);
      const tracked = new Set(positions.map(pos => pos.symbol.toUpperCase()));
      for (const r of recovered) {
        if (tracked.has(r.symbol.toUpperCase())) continue;
        positions.push(r);
        tracked.add(r.symbol.toUpperCase());
      }
      ctx.state.set("arbPositions", positions.length);
      this._unrecovered = unreadable;
    }

    const exchangeBalances = new Map<string, { equity: number; available: number; marginPct: number }>();
    const availableAdapters = new Map<string, ExchangeAdapter>();
    for (const [name, a] of adapters) {
      try {
        const bal = await a.getBalance();
        const equity = parseFloat(bal.equity);
        const marginPct = equity > 0 ? (parseFloat(bal.marginUsed) / equity) * 100 : 100;
        const available = parseFloat(bal.available);
        exchangeBalances.set(name, { equity, available, marginPct });
        const cd = this._failCooldown.get(`${name}:exchange`) ?? 0;
        if (this._unrecovered.has(name)) ctx.log(`  [SPA] ${name} positions not recovered — no entries this tick`);
        else if (Date.now() < cd) ctx.log(`  [SPA] ${name} on cooldown`);
        else if (available < 5) ctx.log(`  [SPA] ${name} available $${available.toFixed(2)} too low`);
        else if (marginPct >= 90) ctx.log(`  [SPA] ${name} margin ${marginPct.toFixed(0)}%`);
        else availableAdapters.set(name, a);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120);
        ctx.log(`  [SPA] getBalance failed for ${name}: ${msg}`);
      }
    }

    const ratesByExchange: RateMap = new Map();
    for (const [name, a] of adapters) {
      let rates: Awaited<ReturnType<typeof fetchRates>>;
      try {
        rates = await fetchRates(a, name);
      } catch (err) {
        // Recorded per venue; this venue is left out of this cycle's rate map.
        ctx.log(`  [SPA] fetchRates failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const map = new Map<string, RateEntry>();
      for (const r of rates) map.set(r.symbol.toUpperCase(), { rate: r.rate, price: r.price, sizeDecimals: r.sizeDecimals, maxLeverage: r.maxLeverage, fundingHours: r.fundingHours });
      ratesByExchange.set(name, map);
    }
    const lastCheck = ctx.state.get("fundingLastCheck") as number;
    if (Date.now() - lastCheck > 5 * 60 * 1000) {
      try {
        const since = (ctx.state.get("fundingLastCheckByVenue") as Record<string, number> | undefined) ?? {};
        const { total } = await collectFundingSince(adapters, since, ctx.state.get("fundingStartTime") as number, ctx.log);
        ctx.state.set("fundingLastCheckByVenue", since);
        ctx.state.set("fundingIncome", (ctx.state.get("fundingIncome") as number) + total);
        ctx.state.set("fundingLastCheck", Date.now());
      } catch (e) {
        ctx.log(`  [FUND] funding check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    for (const pos of positions) {
      if (Date.now() - pos.lastFundingCheck < 10 * 60 * 1000) continue;
      try {
        const perpAdapter = adapters.get(pos.perpExchange);
        if (!perpAdapter) continue;
        const payments = await perpAdapter.getFundingPayments(p.history_periods * 2);
        const perpSym = getPerpSymbol(pos.symbol, pos.perpExchange);
        const relevant = payments.filter(fp => matchSymbol(fp.symbol, perpSym) || matchSymbol(fp.symbol, pos.symbol));
        const recent = relevant.slice(0, p.history_periods);
        if (recent.length > 0) pos.fundingHistory = recent.map(fp => ({ time: fp.time, amount: parseFloat(fp.payment) }));
        pos.lastFundingCheck = Date.now();
      } catch (e) {
        // lastFundingCheck is not advanced: retried next tick.
        ctx.log(`  [FUND] ${pos.symbol} ${pos.perpExchange}: funding history unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const display = positions.map(pos => {
      const ann = this.calcAnnualized(pos, ratesByExchange);
      const annStr = ann !== null ? `${ann >= 0 ? "+" : ""}${ann.toFixed(1)}%` : "?%";
      const hist = pos.fundingHistory;
      const posCount = hist.filter(h => h.amount > 0).length;
      return `${pos.symbol} ${pos.spotExchange}-spot<>${pos.perpExchange} ${annStr} (${posCount}/${hist.length} positive)`;
    });
    ctx.state.set("arbPositionDetails", display);
    ctx.state.set("arbPositions", positions.length);
    ctx.state.set("fundingTotal", `$${(ctx.state.get("fundingIncome") as number).toFixed(4)}`);

    // ── Close check ──
    const toClose: SpotPerpPosition[] = [];
    for (const pos of positions) {
      if (!this.shouldClose(pos, ratesByExchange, p)) continue;
      if (this.quarantined(pos.symbol, ctx)) { ctx.log(`  [SPA] ${pos.symbol} is quarantined — not closing (perp strategy quarantine)`); continue; }
      const cd = this._failCooldown.get(`${pos.symbol}:close`) ?? 0;
      if (Date.now() < cd) continue;
      ctx.log(`  [SPA] Closing ${pos.symbol} ${pos.spotExchange}-spot<>${pos.perpExchange}`);
      const spotExAdapter = adapters.get(pos.spotExchange) ?? adapters.get(pos.perpExchange);
      const perpAdapter = adapters.get(pos.perpExchange);
      if (!perpAdapter || !spotExAdapter) { ctx.log(`  [SPA] Close: no adapter`); continue; }
      const spotAdapter = await this.executor.getSpotAdapter(pos.spotExchange, spotExAdapter);
      if (!spotAdapter) continue;
      const closed = await this.executor.closePosition({
        symbol: pos.symbol, spotExchange: pos.spotExchange, perpExchange: pos.perpExchange,
        spotAdapter, perpAdapter, size: pos.size, log: ctx.log,
      });
      if (closed.closed) { toClose.push(pos); this._closeFailures.delete(pos.symbol); this.recordClose(spotAdapter, pos, null, ctx); }
      else if (closed.manual) {
        this.quarantine(pos.symbol, closed.reason, pos.spotExchange, pos.perpExchange, ctx);
      } else if (closed.remainingSize !== null) {
        pos.size = closed.remainingSize; // partial close: remainder still hedged
        this.recordClose(spotAdapter, pos, closed.remainingSize, ctx);
        this._closeFailures.delete(pos.symbol);
        this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000);
      } else {
        // Each failed attempt may have traded (perp close → spot sell fail → re-hedge):
        // stop after MAX_CLOSE_FAILURES instead of looping.
        const n = (this._closeFailures.get(pos.symbol) ?? 0) + 1;
        this._closeFailures.set(pos.symbol, n);
        if (n >= MAX_CLOSE_FAILURES) {
          this.quarantine(pos.symbol, `close failed ${n} times in a row — stopping automatic close attempts`, pos.spotExchange, pos.perpExchange, ctx);
        } else {
          this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000);
        }
      }
    }
    if (toClose.length > 0) {
      const remaining = positions.filter(pos => !toClose.some(c => c.id === pos.id));
      ctx.state.set("spaPositions", remaining);
      ctx.state.set("arbPositions", remaining.length);
    }

    // ── Rotation check (only to perp venues that match the spot leg) ──
    const perpMarketsCache = new Map<string, Promise<VenueMarket[]>>();
    const allowedBySpotVenue = new Map<string, Map<string, Set<string>>>();
    const currentPositions = ctx.state.get("spaPositions") as SpotPerpPosition[];
    for (const pos of currentPositions) {
      if (this.quarantined(pos.symbol, ctx)) continue;
      const rcd = this._failCooldown.get(`${pos.id}:rotate`) ?? 0;
      if (Date.now() < rcd) continue;
      let allowedByBase = allowedBySpotVenue.get(pos.spotExchange);
      if (allowedByBase === undefined) {
        const spotExAdapter = adapters.get(pos.spotExchange);
        const rotSpot = spotExAdapter ? await getBotSpotAdapter(pos.spotExchange, spotExAdapter) : null;
        if (rotSpot === null) continue;
        try {
          allowedByBase = await this.spotPerpVenues(pos.spotExchange, await rotSpot.getSpotMarkets(), adapters, perpMarketsCache, ctx);
        } catch (e) {
          ctx.log(`  [SPA] ${pos.spotExchange} spot↔perp matching failed (rotation skipped): ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        allowedBySpotVenue.set(pos.spotExchange, allowedByBase);
      }
      const allowed = allowedByBase.get(pos.symbol.toUpperCase());
      if (allowed === undefined) continue;
      const candidates = await this.findPerpCandidates(pos.symbol, adapters, ratesByExchange, allowed, ctx.log);
      const best = candidates[0];
      if (!best || best.exchange === pos.perpExchange) continue;
      const currentInfo = findRate(ratesByExchange, pos.perpExchange, getPerpSymbol(pos.symbol, pos.perpExchange))
        ?? findRate(ratesByExchange, pos.perpExchange, pos.symbol);
      if (!currentInfo) continue;
      const curAnn = annualizeHourlyRate(currentInfo.rate / (currentInfo.fundingHours ?? getFundingHours(pos.perpExchange)));
      if (best.score.annualized - curAnn < p.rotation_threshold) continue;
      ctx.log(`  [SPA] Rotating ${pos.symbol} short: ${pos.perpExchange} (${curAnn.toFixed(1)}%) -> ${best.exchange} (${best.score.annualized.toFixed(1)}%)`);
      const oldAdapter = adapters.get(pos.perpExchange);
      const newAdapter = adapters.get(best.exchange);
      if (!oldAdapter || !newAdapter) continue;
      const perpSym = getPerpSymbol(pos.symbol, pos.perpExchange);
      const newMaxLev = findRate(ratesByExchange, best.exchange, getPerpSymbol(pos.symbol, best.exchange))?.maxLeverage
        ?? findRate(ratesByExchange, best.exchange, pos.symbol)?.maxLeverage;
      const ok = await this.executor.rotateShort({
        symbol: pos.symbol, perpSymbol: perpSym,
        currentExchange: pos.perpExchange, newExchange: best.exchange,
        currentAdapter: oldAdapter, newAdapter,
        size: pos.size, leverage: cappedLeverage(p.leverage, [{ exchange: best.exchange, maxLeverage: newMaxLev }], ctx.log), log: ctx.log,
      });
      if (ok.ok) {
        // The spot leg is unchanged: the state entry follows the short to its new venue.
        try {
          const spotExAdapter = adapters.get(pos.spotExchange);
          const rotSpot = spotExAdapter ? await this.executor.getSpotAdapter(pos.spotExchange, spotExAdapter) : null;
          const entry = rotSpot !== null ? stateEntryOf(rotSpot, pos) : undefined;
          if (rotSpot !== null && entry !== undefined) updatePositionEntry(spotNetworkOf(rotSpot), entry, { shortExchange: getVenue(best.exchange).id, entryShortPrice: ok.entryPrice });
        } catch (e) { stateWriteFailed("[SPA]", "update (rotation)", { ...pos, perpExchange: best.exchange }, e, ctx.log); }
        pos.perpExchange = best.exchange;
        pos.fundingHistory = [];
        pos.lastFundingCheck = 0;
      } else if (ok.manual) {
        // A leg is unknown / unhedged: a retry could double-short — quarantine, never cool down.
        this.quarantine(pos.symbol, ok.reason, pos.spotExchange, `${pos.perpExchange}/${best.exchange}`, ctx);
      } else {
        this._failCooldown.set(`${pos.id}:rotate`, Date.now() + 10 * 60 * 1000);
      }
    }

    // ── New entry ──
    const numPos = (ctx.state.get("spaPositions") as SpotPerpPosition[]).length;
    if (numPos >= p.max_positions) return [];
    const openSymbols = new Set((ctx.state.get("spaPositions") as SpotPerpPosition[]).map(pos => pos.symbol.toUpperCase()));

    interface ScoredOpp { symbol: string; spotExchange: string; perpExchange: string; annualized: number; score: FundingScore }
    const scoredOpps: ScoredOpp[] = [];

    // HL spot: only whitelisted tokens (U-tokens + PURR/HYPE). Lighter spot: all allowed.
    const HL_SPOT_WHITELIST = new Set(["UBTC", "UETH", "USOL", "UFART", "UPUMP", "LINK0", "AVAX0", "AAVE0", "PURR", "HYPE"]);

    for (const [spotExName, spotExAdapter] of adapters) {
      try {
        const spotAdapter = await getBotSpotAdapter(spotExName, spotExAdapter);
        if (!spotAdapter) continue;
        // Canonical symbol + price guard: base → perp venues it may hedge on.
        const allowedByBase = await this.spotPerpVenues(spotExName, await spotAdapter.getSpotMarkets(), adapters, perpMarketsCache, ctx);
        for (const [base, allowed] of allowedByBase) {
          // HL spot: skip tokens not in whitelist
          if (spotExName === "hyperliquid" && !HL_SPOT_WHITELIST.has(base)) continue;
          if (openSymbols.has(base)) continue;
          if (Date.now() < (this._failCooldown.get(`${base}:entry`) ?? 0)) continue;
          if (this.quarantined(base, ctx)) continue;
          const candidates = await this.findPerpCandidates(base, adapters, ratesByExchange, allowed, ctx.log);
          for (const cand of candidates) {
            if (cand.score.annualized < p.min_rate || cand.score.consistency < p.min_consistency) continue;
            scoredOpps.push({ symbol: base, spotExchange: spotExName, perpExchange: cand.exchange, annualized: cand.score.annualized, score: cand.score });
          }
        }
      } catch (e) {
        ctx.log(`  [SPA] ${spotExName} spot scan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    scoredOpps.sort((a, b) => b.annualized - a.annualized);

    if (scoredOpps.length > 0 && numPos < p.max_positions) {
      for (const opp of scoredOpps.slice(0, 3)) {
        ctx.log(`  [SPA] ${opp.symbol}: ${opp.annualized.toFixed(1)}% consistency=${(opp.score.consistency * 100).toFixed(0)}% ${opp.spotExchange}-spot<>${opp.perpExchange}`);
      }
    }

    for (const opp of scoredOpps) {
      if ((ctx.state.get("spaPositions") as SpotPerpPosition[]).length >= p.max_positions) break;
      if (this._unrecovered.has(opp.spotExchange) || this._unrecovered.has(opp.perpExchange)) continue;
      const opened = await this.tryOpenPosition(opp.spotExchange, opp.perpExchange, opp.symbol, opp.annualized, adapters, ctx, ratesByExchange, exchangeBalances);
      if (opened) return [{ type: "noop" }];
    }
    if (scoredOpps.length === 0 && numPos < p.max_positions) {
      ctx.log(`  [SPA] No opportunities >= ${p.min_rate}% with >= ${(p.min_consistency * 100).toFixed(0)}% consistency`);
    }
    return [];
  }

  // ── onStop ──

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const positions = ctx.state.get("spaPositions") as SpotPerpPosition[] | undefined;
    const adapters = buildAdapterMap(ctx);
    for (const p of positions ?? []) this._traded.add(getPerpSymbol(p.symbol, p.perpExchange).toUpperCase());
    if (positions && positions.length > 0) {
      const remaining: SpotPerpPosition[] = [];
      for (const pos of positions) {
        if (this.quarantined(pos.symbol, ctx)) {
          ctx.log(`  [SPA] CRITICAL: ${pos.symbol} is quarantined — left open on stop; resolve manually (perp strategy quarantine)`);
          remaining.push(pos);
          continue;
        }
        const spotExAdapter = adapters.get(pos.spotExchange) ?? adapters.get(pos.perpExchange);
        const perpAdapter = adapters.get(pos.perpExchange);
        if (!perpAdapter || !spotExAdapter) { ctx.log(`  [SPA] CRITICAL: ${pos.symbol} no adapter on stop`); remaining.push(pos); continue; }
        const spotAdapter = await this.executor.getSpotAdapter(pos.spotExchange, spotExAdapter);
        if (!spotAdapter) { ctx.log(`  [SPA] CRITICAL: ${pos.symbol} no spot adapter on stop`); remaining.push(pos); continue; }
        const closed = await this.executor.closePosition({
          symbol: pos.symbol, spotExchange: pos.spotExchange, perpExchange: pos.perpExchange,
          spotAdapter, perpAdapter, size: pos.size, log: ctx.log,
        });
        if (closed.closed) this.recordClose(spotAdapter, pos, null, ctx);
        else {
          if (closed.manual) this.quarantine(pos.symbol, closed.reason, pos.spotExchange, pos.perpExchange, ctx);
          else if (closed.remainingSize !== null) {
            pos.size = closed.remainingSize; // partial close: remainder still hedged
            this.recordClose(spotAdapter, pos, closed.remainingSize, ctx);
          }
          ctx.log(`  [SPA] CRITICAL: ${pos.symbol} could not be (fully) closed on stop`);
          remaining.push(pos);
        }
      }
      ctx.state.set("spaPositions", remaining);
      ctx.state.set("arbPositions", remaining.length);
    }
    // Only the bot's own symbols, on each venue it used — never an account-wide cancel.
    await cancelBotSymbols(adapters, this._traded, "[SPA]", ctx.log);
    return [];
  }

  /** Close recorded in the arb state: entry removed (remaining null) or its legs set to the still-hedged remainder. */
  private recordClose(spot: SpotAdapter, pos: SpotPerpPosition, remaining: string | null, ctx: StrategyContext): void {
    recordSpotPerpClose(spot, pos, remaining, "[SPA]", ctx.log);
  }

  private quarantined(symbol: string, ctx: StrategyContext): boolean {
    return isQuarantined(symbol, ctx.log);
  }

  /** Unknown / unhedged outcome (executor `manual`): stop touching this symbol until a human clears it. */
  private quarantine(symbol: string, reason: string, spotExchange: string, perpExchange: string, ctx: StrategyContext): void {
    quarantineSymbol(this.name, symbol, reason,
      `Check ${spotExchange} spot (perp -e ${spotExchange} trade spot-balance, perp -e ${spotExchange} trade spot-orders) and the ${perpExchange} perp (perp -e ${perpExchange} positions); resolve by hand, then: perp strategy quarantine-clear ${symbol.toUpperCase()}`,
      ctx.log);
  }

  // ── Scoring (decision logic) ──

  private scoreFundingLocal(adapter: ExchangeAdapter, symbol: string, exchangeName: string): Promise<FundingScore | null> {
    return scoreFunding(adapter, symbol, exchangeName, this.params.history_periods, this._fundingScoreCache);
  }

  /** base (upper-case) → perp venues it may hedge on (canonical symbol + price guard, `botSpotPerpMatches`). */
  private async spotPerpVenues(spotExName: string, spotMarkets: readonly SpotMarketInfo[], adapters: Map<string, ExchangeAdapter>, perpMarketsCache: Map<string, Promise<VenueMarket[]>>, ctx: StrategyContext): Promise<Map<string, Set<string>>> {
    const byPerp = await botSpotPerpMatches(spotExName, spotMarkets, [...adapters.keys()], perpMarketsCache, (msg) => ctx.log(`  [SPA] ${msg}`));
    const byBase = new Map<string, Set<string>>();
    for (const [perpVenue, bases] of byPerp) {
      for (const b of bases) {
        const set = byBase.get(b);
        if (set) set.add(perpVenue); else byBase.set(b, new Set([perpVenue]));
      }
    }
    return byBase;
  }

  /** Find all perp exchanges for a symbol, sorted by annualized rate (highest first). */
  private async findPerpCandidates(symbol: string, adapters: Map<string, ExchangeAdapter>, ratesByExchange: RateMap, allowedPerpVenues: ReadonlySet<string>, log: (msg: string) => void): Promise<{ exchange: string; rate: number; score: FundingScore }[]> {
    const candidates: { exchange: string; rate: number; score: FundingScore }[] = [];
    for (const [exName, adapter] of adapters) {
      if (!allowedPerpVenues.has(exName)) continue;
      const perpSym = getPerpSymbol(symbol, exName);
      const ri = findRate(ratesByExchange, exName, perpSym) ?? findRate(ratesByExchange, exName, symbol);
      if (!ri || ri.rate <= 0) continue;
      // A failed history read is not "too little history": say so, then try the next symbol form;
      // a venue with no readable form is left out this cycle.
      let score: FundingScore | null = null;
      for (const sym of perpSym === symbol ? [perpSym] : [perpSym, symbol]) {
        try {
          score = await this.scoreFundingLocal(adapter, sym, exName);
        } catch (e) {
          log(`  [SPA] ${sym} on ${exName}: funding history unreadable — not a candidate this cycle: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (score) break;
      }
      if (!score) continue;
      candidates.push({ exchange: exName, rate: ri.rate, score });
    }
    candidates.sort((a, b) => b.score.annualized - a.score.annualized);
    return candidates;
  }

  private calcAnnualized(pos: SpotPerpPosition, ratesByExchange: RateMap): number | null {
    const ri = findRate(ratesByExchange, pos.perpExchange, getPerpSymbol(pos.symbol, pos.perpExchange))
      ?? findRate(ratesByExchange, pos.perpExchange, pos.symbol);
    if (!ri) return null; // rate unknown — don't assume 0
    const fH = ri.fundingHours ?? getFundingHours(pos.perpExchange);
    return annualizeHourlyRate(ri.rate / fH);
  }

  private shouldClose(pos: SpotPerpPosition, ratesByExchange: RateMap, p: SpotPerpArbParams): boolean {
    const minHoldMs = p.min_hold_hours * 60 * 60 * 1000;
    const holdTime = pos.entryTime > 0 ? Date.now() - pos.entryTime : Infinity;
    const ann = this.calcAnnualized(pos, ratesByExchange);

    // Rate unknown — don't close (rate data not yet available)
    if (ann === null) return false;

    // Emergency close: instantaneous spread deeply negative
    if (ann < -50) return true;
    if (holdTime < minHoldMs) return false;

    // History-based: avg net funding over last N payments < 0
    if (pos.fundingHistory.length >= 3) {
      const avgFunding = pos.fundingHistory.reduce((s, h) => s + h.amount, 0) / pos.fundingHistory.length;
      if (avgFunding < 0) return true;
    }

    // Fallback to instantaneous rate
    return ann < p.close_rate;
  }

  // ── Open position (decision + sizing, delegates execution) ──

  private async tryOpenPosition(
    spotExchange: string, perpExchange: string, symbol: string, entryRate: number,
    adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext,
    ratesByExchange: RateMap, exchangeBalances: Map<string, { equity: number; available: number; marginPct: number }>,
  ): Promise<boolean> {
    const p = this.params;
    // Engine: equity unknown → no new entries (closes / rotations' closes still run).
    if (ctx.state.get("equityUnknown") === true) { ctx.log(`  [SPA] Skip ${symbol}: equity unknown — no new entries`); return false; }
    const spotExAdapter = adapters.get(spotExchange);
    const perpAdapter = adapters.get(perpExchange);
    if (!spotExAdapter || !perpAdapter) { this._failCooldown.set(`${symbol}:entry`, Date.now() + 5 * 60 * 1000); return false; }

    try {
      const spotAdapter = await this.executor.getSpotAdapter(spotExchange, spotExAdapter);
      if (!spotAdapter) return false;

      const perpSymbol = getPerpSymbol(symbol, perpExchange);
      const rateInfo = findRate(ratesByExchange, perpExchange, perpSymbol)
        ?? findRate(ratesByExchange, perpExchange, symbol);
      const leverage = cappedLeverage(p.leverage, [{ exchange: perpExchange, maxLeverage: rateInfo?.maxLeverage }], ctx.log);

      // Pre-entry: verify fundingHours (aster lazy bootstrap may not have run yet)
      if (perpExchange === "aster" && rateInfo && "getFundingHours" in perpAdapter) {
        const actualFh = await (perpAdapter as unknown as { getFundingHours(s: string): Promise<number | undefined> }).getFundingHours(symbol);
        if (!actualFh) {
          ctx.log(`  [SPA] Skip ${symbol}: fundingHours unknown (aster not yet bootstrapped)`);
          this._failCooldown.set(`${symbol}:entry`, Date.now() + 5 * 60 * 1000);
          return false;
        }
        const actualAnn = annualizeHourlyRate(rateInfo.rate / actualFh);
        if (actualAnn < p.min_rate) {
          ctx.log(`  [SPA] Skip ${symbol}: actual rate ${actualAnn.toFixed(1)}% (${actualFh}h funding) below min_rate ${p.min_rate}%`);
          this._failCooldown.set(`${symbol}:entry`, Date.now() + 10 * 60 * 1000);
          return false;
        }
      }

      // Risk policy: enforce max_position_usd from risk config
      const riskConfig = ctx.state.get("riskConfig") as { max_position_usd?: number } | undefined;
      const maxTotalPositionUsd = riskConfig?.max_position_usd ?? Infinity;
      const positions = ctx.state.get("spaPositions") as SpotPerpPosition[];
      let currentTotalUsd = 0;
      // No cap (Infinity): exposure does not gate the entry.
      for (const pos of Number.isFinite(maxTotalPositionUsd) ? positions : []) {
        const ri = findRate(ratesByExchange, pos.perpExchange, getPerpSymbol(pos.symbol, pos.perpExchange))
          ?? findRate(ratesByExchange, pos.perpExchange, pos.symbol);
        // Unknown price of a held position → exposure unknown: no new entry this cycle (a $0
        // valuation would understate exposure and let the max_position_usd cap be bypassed).
        if (ri === undefined || !(ri.price > 0)) {
          ctx.log(`  [SPA] Skip ${symbol}: ${pos.symbol} ${pos.perpExchange} price unknown this cycle — total exposure unknown, no new entries`);
          return false;
        }
        currentTotalUsd += ri.price * parseFloat(pos.size);
      }
      const remainingBudget = maxTotalPositionUsd - currentTotalUsd;
      if (remainingBudget < 10) {
        ctx.log(`  [SPA] Skip ${symbol}: risk limit — total positions $${currentTotalUsd.toFixed(0)}/$${maxTotalPositionUsd} (no budget)`);
        return false;
      }

      // Size decision (capped by risk budget)
      let targetSizeUsd = Math.min(p.size_usd, remainingBudget);
      const sameExchange = spotExchange === perpExchange;
      if (sameExchange) {
        const perpBal = await perpAdapter.getBalance();
        const perpAvail = parseFloat(perpBal.available);
        // Spot leg: notional × SPOT_FEE_BUFFER; perp leg: requiredArbMargin (notional / leverage × ARB_MARGIN_BUFFER).
        const need = (n: number) => n * SPOT_FEE_BUFFER + requiredArbMargin(n, leverage);
        if (perpAvail < need(targetSizeUsd)) {
          const max = perpAvail / need(1);
          if (max < 10) { ctx.log(`  [SPA] Skip ${symbol}: insufficient balance — $${perpAvail.toFixed(2)} available, $${need(10).toFixed(2)} needed for the $10 minimum (spot + perp margin at ${leverage}x)`); return false; }
          targetSizeUsd = Math.floor(max);
        }
      } else {
        // For cross-exchange: spot side needs USDC in spot OR perp account (can transfer)
        const sBal = exchangeBalances.get(spotExchange);
        const pBal = exchangeBalances.get(perpExchange);
        if (!sBal || !pBal) return false;
        // Check spot USDC balance (only add if separate from perp — skip for unified accounts like HL)
        let spotAvailable = sBal.available;
        const spotDef = getVenue(spotExchange);
        if (!spotSharesPerpMargin(spotDef, spotExAdapter)) {
          const spotQuote = findSpotQuoteBalance(spotDef, spotNetworkOf(spotAdapter), await spotAdapter.getSpotBalances());
          if (spotQuote) spotAvailable += parseFloat(spotQuote.available);
        }
        // Spot leg: notional × SPOT_FEE_BUFFER of spot buying power; perp leg: requiredArbMargin at the leverage.
        const maxNtl = Math.min(spotAvailable / SPOT_FEE_BUFFER, pBal.available / requiredArbMargin(1, leverage));
        if (maxNtl < targetSizeUsd) {
          if (maxNtl < 10) {
            ctx.log(`  [SPA] Skip ${symbol}: insufficient balance for the $10 minimum — spot $${spotAvailable.toFixed(2)} (needs $${(10 * SPOT_FEE_BUFFER).toFixed(2)}), perp $${pBal.available.toFixed(2)} (needs $${requiredArbMargin(10, leverage).toFixed(2)} margin at ${leverage}x)`);
            return false;
          }
          targetSizeUsd = Math.floor(maxNtl);
        }
      }

      // Delegate to executor
      this._traded.add(perpSymbol.toUpperCase());
      const result = await this.executor.openPosition({
        symbol, perpSymbol, spotExchange, perpExchange,
        spotAdapter, perpAdapter, sizeUsd: targetSizeUsd, leverage, log: ctx.log,
      });

      if (result.success) {
        const cur = ctx.state.get("spaPositions") as SpotPerpPosition[];
        const pos: SpotPerpPosition = { id: genPosId(), symbol, spotExchange, perpExchange, size: result.size, entryTime: Date.now(), entryRate, fundingHistory: [], lastFundingCheck: 0 };
        cur.push(pos);
        recordSpotPerpEntry(spotAdapter, {
          id: pos.id, symbol, spotExchange, perpExchange, entryTime: pos.entryTime, entrySpread: entryRate,
          spotSize: result.spotSize, perpSize: Number(result.size), spotAvgPrice: result.spotAvgPrice, perpEntryPrice: result.perpEntryPrice,
        }, "[SPA]", ctx.log);
        ctx.state.set("spaPositions", cur);
        ctx.state.set("arbPositions", cur.length);
        ctx.log(`  [SPA] Opened! (${cur.length}/${p.max_positions})`);
        return true;
      }

      if (result.manual === true) {
        this.quarantine(symbol, result.error ?? "entry outcome unknown", spotExchange, perpExchange, ctx);
        return false;
      }
      this._failCooldown.set(`${symbol}:entry`, Date.now() + 5 * 60 * 1000);
      return false;
    } catch (err) {
      ctx.log(`  [SPA] Open failed: ${err instanceof Error ? err.message : String(err)}`);
      this._failCooldown.set(`${symbol}:entry`, Date.now() + 5 * 60 * 1000);
      return false;
    }
  }

  // ── Position recovery ──

  /** Rebuild positions from the venues; `unreadable` = venues whose positions / spot balances failed to load (never "none"). */
  private async recoverPositions(adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext): Promise<{ recovered: SpotPerpPosition[]; unreadable: Set<string> }> {
    const recovered: SpotPerpPosition[] = [];
    const unreadable = new Set<string>();
    const perpByEx = new Map<string, { symbol: string; side: string; size: string }[]>();
    for (const [name, a] of adapters) {
      try {
        const pos = await a.getPositions();
        perpByEx.set(name, pos.map(p => ({ symbol: p.symbol.toUpperCase(), side: p.side, size: p.size })));
      } catch (e) {
        unreadable.add(name);
        ctx.log(`  [SPA] ${name} positions unreadable during recovery (${e instanceof Error ? e.message : String(e)}) — no entries on ${name} until recovered`);
      }
    }
    const used = new Set<string>();
    for (const [spotExName, spotExAdapter] of adapters) {
      try {
        const spotAdapter = await getBotSpotAdapter(spotExName, spotExAdapter);
        if (!spotAdapter) continue;
        const bals = await spotAdapter.getSpotBalances();
        for (const bal of nonQuoteSpotBalances(getVenue(spotExName), spotNetworkOf(spotAdapter), bals)) {
          const base = spotTokenBase(bal.token);
          for (const [perpExName, perps] of perpByEx) {
            for (const perp of perps) {
              const key = `${perpExName}:${perp.symbol}`;
              if (used.has(key)) continue;
              if (perp.symbol.replace(/-PERP$/, "").toUpperCase() === base && perp.side === "short") {
                recovered.push({ id: genPosId(), symbol: base, spotExchange: spotExName, perpExchange: perpExName, size: perp.size, entryTime: 0, entryRate: 0, fundingHistory: [], lastFundingCheck: 0 });
                used.add(key);
                ctx.log(`  [SPA] Recovered: ${base} ${spotExName}-spot<>${perpExName}`);
                break;
              }
            }
          }
        }
      } catch (e) {
        unreadable.add(spotExName);
        ctx.log(`  [SPA] ${spotExName} spot recovery failed: ${e instanceof Error ? e.message : String(e)} — no entries on ${spotExName} until recovered`);
      }
    }
    return { recovered, unreadable };
  }
}

registerStrategy("spot-perp-arb", (_config) => new SpotPerpArbStrategy());
