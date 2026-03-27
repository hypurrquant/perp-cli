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
import { registerStrategy } from "../strategy-registry.js";
import { getFundingHours } from "../../funding.js";
import { pruneExecutionLog } from "../../execution-log.js";
import {
  type RateEntry, type RateMap,
  buildAdapterMap, getSpotAdapter,
  getPerpSymbol, findRate, matchSymbol, fetchRates,
} from "./funding-arb-utils.js";
import { SpotPerpExecutor } from "./spot-perp-executor.js";

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

interface FundingScore {
  symbol: string; exchange: string; avgRate: number;
  consistency: number; annualized: number; payments: number;
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
    try { pruneExecutionLog(30); } catch { /* non-critical */ }
    this._config = ctx.config;
    const p = this.params;
    ctx.state.set("arbRunning", true);
    ctx.state.set("spaPositions", [] as SpotPerpPosition[]);
    ctx.state.set("arbPositions", 0);
    ctx.state.set("fundingIncome", 0);
    ctx.state.set("fundingLastCheck", Date.now());
    ctx.log(`  [SPA] Ready | rate >= ${p.min_rate}% | close < ${p.close_rate}% | size $${p.size_usd}`);
    ctx.log(`  [SPA] Consistency >= ${(p.min_consistency * 100).toFixed(0)}% | history ${p.history_periods} periods | rotation ${p.rotation_threshold}%`);
    ctx.log(`  [SPA] Exchanges: ${p.exchanges.join(", ")}`);
    try {
      const adapters = buildAdapterMap(ctx);
      const recovered = await this.recoverPositions(adapters, ctx);
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
          const sum = payments.filter(fp => fp.time > oneDayAgo).reduce((s, fp) => s + parseFloat(fp.payment), 0);
          if (Math.abs(sum) > 0.001) { historicalFunding += sum; ctx.log(`  [FUND] ${name}: $${sum.toFixed(4)} historical`); }
        } catch { /* not supported */ }
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
        if (Date.now() < cd) ctx.log(`  [SPA] ${name} on cooldown`);
        else if (available < 5) ctx.log(`  [SPA] ${name} available $${available.toFixed(2)} too low`);
        else if (marginPct >= 90) ctx.log(`  [SPA] ${name} margin ${marginPct.toFixed(0)}%`);
        else availableAdapters.set(name, a);
      } catch (err) { ctx.log(`  [SPA] getBalance failed for ${name}: ${err instanceof Error ? err.message : String(err)}`); }
    }

    const ratesByExchange: RateMap = new Map();
    for (const [name, a] of adapters) {
      const rates = await fetchRates(a, name);
      const map = new Map<string, RateEntry>();
      for (const r of rates) map.set(r.symbol.toUpperCase(), { rate: r.rate, price: r.price, sizeDecimals: r.sizeDecimals, maxLeverage: r.maxLeverage, fundingHours: r.fundingHours });
      ratesByExchange.set(name, map);
    }
    const lastCheck = ctx.state.get("fundingLastCheck") as number;
    if (Date.now() - lastCheck > 5 * 60 * 1000) {
      try {
        let total = 0;
        for (const [name, a] of adapters) {
          try {
            const payments = await a.getFundingPayments(50);
            const start = ctx.state.get("fundingLastCheck") as number;
            const sum = payments.filter(fp => fp.time > start - 5 * 60 * 1000).reduce((s, fp) => s + parseFloat(fp.payment), 0);
            total += sum;
            if (Math.abs(sum) > 0.001) ctx.log(`  [FUND] ${name}: $${sum.toFixed(4)}`);
          } catch { /* skip */ }
        }
        ctx.state.set("fundingIncome", (ctx.state.get("fundingIncome") as number) + total);
        ctx.state.set("fundingLastCheck", Date.now());
      } catch { /* non-critical */ }
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
      } catch { /* non-critical */ }
    }

    const display = positions.map(pos => {
      const ann = this.calcAnnualized(pos, ratesByExchange);
      const sign = ann >= 0 ? "+" : "";
      const hist = pos.fundingHistory;
      const posCount = hist.filter(h => h.amount > 0).length;
      return `${pos.symbol} ${pos.spotExchange}-spot<>${pos.perpExchange} ${sign}${ann.toFixed(1)}% (${posCount}/${hist.length} positive)`;
    });
    ctx.state.set("arbPositionDetails", display);
    ctx.state.set("arbPositions", positions.length);
    ctx.state.set("fundingTotal", `$${(ctx.state.get("fundingIncome") as number).toFixed(4)}`);

    // ── Close check ──
    const toClose: SpotPerpPosition[] = [];
    for (const pos of positions) {
      if (!this.shouldClose(pos, ratesByExchange, p)) continue;
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
      if (closed) toClose.push(pos);
      else this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000);
    }
    if (toClose.length > 0) {
      const remaining = positions.filter(pos => !toClose.some(c => c.id === pos.id));
      ctx.state.set("spaPositions", remaining);
      ctx.state.set("arbPositions", remaining.length);
    }

    // ── Rotation check ──
    const currentPositions = ctx.state.get("spaPositions") as SpotPerpPosition[];
    for (const pos of currentPositions) {
      const rcd = this._failCooldown.get(`${pos.id}:rotate`) ?? 0;
      if (Date.now() < rcd) continue;
      const best = await this.findBestPerp(pos.symbol, adapters, ratesByExchange);
      if (!best || best.exchange === pos.perpExchange) continue;
      const currentInfo = findRate(ratesByExchange, pos.perpExchange, getPerpSymbol(pos.symbol, pos.perpExchange))
        ?? findRate(ratesByExchange, pos.perpExchange, pos.symbol);
      if (!currentInfo) continue;
      const curAnn = (currentInfo.rate / (currentInfo.fundingHours ?? getFundingHours(pos.perpExchange))) * 8760 * 100;
      if (best.score.annualized - curAnn < p.rotation_threshold) continue;
      ctx.log(`  [SPA] Rotating ${pos.symbol} short: ${pos.perpExchange} (${curAnn.toFixed(1)}%) -> ${best.exchange} (${best.score.annualized.toFixed(1)}%)`);
      const oldAdapter = adapters.get(pos.perpExchange);
      const newAdapter = adapters.get(best.exchange);
      if (!oldAdapter || !newAdapter) continue;
      const perpSym = getPerpSymbol(pos.symbol, pos.perpExchange);
      const newMaxLev = findRate(ratesByExchange, best.exchange, getPerpSymbol(pos.symbol, best.exchange))?.maxLeverage
        ?? findRate(ratesByExchange, best.exchange, pos.symbol)?.maxLeverage ?? 1;
      const ok = await this.executor.rotateShort({
        symbol: pos.symbol, perpSymbol: perpSym,
        currentExchange: pos.perpExchange, newExchange: best.exchange,
        currentAdapter: oldAdapter, newAdapter,
        size: pos.size, leverage: Math.min(p.leverage, newMaxLev), log: ctx.log,
      });
      if (ok) {
        pos.perpExchange = best.exchange;
        pos.fundingHistory = [];
        pos.lastFundingCheck = 0;
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
        const spotAdapter = await getSpotAdapter(spotExName, spotExAdapter);
        if (!spotAdapter) continue;
        const spotMarkets = await spotAdapter.getSpotMarkets();
        for (const m of spotMarkets) {
          const base = m.baseToken.toUpperCase();
          // HL spot: skip tokens not in whitelist
          if (spotExName === "hyperliquid" && !HL_SPOT_WHITELIST.has(base)) continue;
          if (openSymbols.has(base)) continue;
          if (Date.now() < (this._failCooldown.get(`${base}:entry`) ?? 0)) continue;
          const best = await this.findBestPerp(base, adapters, ratesByExchange);
          if (!best || best.score.annualized < p.min_rate || best.score.consistency < p.min_consistency) continue;
          scoredOpps.push({ symbol: base, spotExchange: spotExName, perpExchange: best.exchange, annualized: best.score.annualized, score: best.score });
        }
      } catch { /* no spot */ }
    }

    scoredOpps.sort((a, b) => b.annualized - a.annualized);

    if (scoredOpps.length > 0 && numPos < p.max_positions) {
      for (const opp of scoredOpps.slice(0, 3)) {
        ctx.log(`  [SPA] ${opp.symbol}: ${opp.annualized.toFixed(1)}% consistency=${(opp.score.consistency * 100).toFixed(0)}% ${opp.spotExchange}-spot<>${opp.perpExchange}`);
      }
    }

    for (const opp of scoredOpps) {
      if ((ctx.state.get("spaPositions") as SpotPerpPosition[]).length >= p.max_positions) break;
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
    if (positions && positions.length > 0) {
      const remaining: SpotPerpPosition[] = [];
      for (const pos of positions) {
        const spotExAdapter = adapters.get(pos.spotExchange) ?? adapters.get(pos.perpExchange);
        const perpAdapter = adapters.get(pos.perpExchange);
        if (!perpAdapter || !spotExAdapter) { ctx.log(`  [SPA] CRITICAL: ${pos.symbol} no adapter on stop`); remaining.push(pos); continue; }
        const spotAdapter = await this.executor.getSpotAdapter(pos.spotExchange, spotExAdapter);
        if (!spotAdapter) { ctx.log(`  [SPA] CRITICAL: ${pos.symbol} no spot adapter on stop`); remaining.push(pos); continue; }
        const closed = await this.executor.closePosition({
          symbol: pos.symbol, spotExchange: pos.spotExchange, perpExchange: pos.perpExchange,
          spotAdapter, perpAdapter, size: pos.size, log: ctx.log,
        });
        if (!closed) { ctx.log(`  [SPA] CRITICAL: ${pos.symbol} could not be closed on stop`); remaining.push(pos); }
      }
      ctx.state.set("spaPositions", remaining);
      ctx.state.set("arbPositions", remaining.length);
    }
    const extra = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
    if (extra) { for (const [, a] of extra) { try { await a.cancelAllOrders(); } catch { /* best effort */ } } }
    return [{ type: "cancel_all" }];
  }

  // ── Scoring (decision logic) ──

  private async scoreFunding(adapter: ExchangeAdapter, symbol: string, exchangeName: string): Promise<FundingScore | null> {
    const p = this.params;
    const key = `${exchangeName}:${symbol}`;
    const cached = this._fundingScoreCache.get(key);
    if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.score;
    try {
      const history = await adapter.getFundingHistory(symbol, p.history_periods);
      if (history.length === 0) return null;
      const rates = history.map(h => parseFloat(h.rate));
      const fH = getFundingHours(exchangeName);
      const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
      const consistency = rates.filter(r => r > 0).length / rates.length;
      const annualized = (avgRate / fH) * 8760 * 100;
      const score: FundingScore = { symbol, exchange: exchangeName, avgRate, consistency, annualized, payments: rates.length };
      this._fundingScoreCache.set(key, { score, ts: Date.now() });
      return score;
    } catch { return null; }
  }

  private async findBestPerp(symbol: string, adapters: Map<string, ExchangeAdapter>, ratesByExchange: RateMap): Promise<{ exchange: string; rate: number; score: FundingScore } | null> {
    let best: { exchange: string; rate: number; score: FundingScore } | null = null;
    for (const [exName, adapter] of adapters) {
      const perpSym = getPerpSymbol(symbol, exName);
      const ri = findRate(ratesByExchange, exName, perpSym) ?? findRate(ratesByExchange, exName, symbol);
      if (!ri || ri.rate <= 0) continue;
      const score = await this.scoreFunding(adapter, perpSym, exName)
        ?? await this.scoreFunding(adapter, symbol, exName);
      if (!score) continue;
      if (!best || score.annualized > best.score.annualized) best = { exchange: exName, rate: ri.rate, score };
    }
    return best;
  }

  private calcAnnualized(pos: SpotPerpPosition, ratesByExchange: RateMap): number {
    const ri = findRate(ratesByExchange, pos.perpExchange, getPerpSymbol(pos.symbol, pos.perpExchange))
      ?? findRate(ratesByExchange, pos.perpExchange, pos.symbol);
    const fH = ri?.fundingHours ?? getFundingHours(pos.perpExchange);
    return ri ? (ri.rate / fH) * 8760 * 100 : 0;
  }

  private shouldClose(pos: SpotPerpPosition, ratesByExchange: RateMap, p: SpotPerpArbParams): boolean {
    const minHoldMs = p.min_hold_hours * 60 * 60 * 1000;
    const holdTime = pos.entryTime > 0 ? Date.now() - pos.entryTime : Infinity;
    const ann = this.calcAnnualized(pos, ratesByExchange);

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
    const spotExAdapter = adapters.get(spotExchange);
    const perpAdapter = adapters.get(perpExchange);
    if (!spotExAdapter || !perpAdapter) { this._failCooldown.set(`${symbol}:entry`, Date.now() + 5 * 60 * 1000); return false; }

    try {
      const spotAdapter = await this.executor.getSpotAdapter(spotExchange, spotExAdapter);
      if (!spotAdapter) return false;

      const perpSymbol = getPerpSymbol(symbol, perpExchange);
      const rateInfo = findRate(ratesByExchange, perpExchange, perpSymbol)
        ?? findRate(ratesByExchange, perpExchange, symbol);
      const perpMaxLev = rateInfo?.maxLeverage ?? 1;
      const leverage = Math.min(p.leverage, perpMaxLev);

      // Pre-entry: verify fundingHours (aster lazy bootstrap may not have run yet)
      if (perpExchange === "aster" && rateInfo && "getFundingHours" in perpAdapter) {
        const actualFh = await (perpAdapter as unknown as { getFundingHours(s: string): Promise<number | undefined> }).getFundingHours(symbol);
        if (!actualFh) {
          ctx.log(`  [SPA] Skip ${symbol}: fundingHours unknown (aster not yet bootstrapped)`);
          this._failCooldown.set(`${symbol}:entry`, Date.now() + 5 * 60 * 1000);
          return false;
        }
        const actualAnn = (rateInfo.rate / actualFh) * 8760 * 100;
        if (actualAnn < p.min_rate) {
          ctx.log(`  [SPA] Skip ${symbol}: actual rate ${actualAnn.toFixed(1)}% (${actualFh}h funding) below min_rate ${p.min_rate}%`);
          this._failCooldown.set(`${symbol}:entry`, Date.now() + 10 * 60 * 1000);
          return false;
        }
      }

      // Size decision
      let targetSizeUsd = p.size_usd;
      const sameExchange = spotExchange === perpExchange;
      if (sameExchange) {
        const perpBal = await perpAdapter.getBalance();
        const perpAvail = parseFloat(perpBal.available);
        const totalNeeded = targetSizeUsd + targetSizeUsd / leverage;
        if (perpAvail < totalNeeded) {
          const max = perpAvail * 0.8 / (1 + 1 / leverage);
          if (max < 10) { ctx.log(`  [SPA] Skip ${symbol}: insufficient balance`); return false; }
          targetSizeUsd = Math.floor(max);
        }
      } else {
        // For cross-exchange: spot side needs USDC in spot OR perp account (can transfer)
        const sBal = exchangeBalances.get(spotExchange);
        const pBal = exchangeBalances.get(perpExchange);
        if (!sBal || !pBal) return false;
        // Check spot USDC balance too (already in spot account, no transfer needed)
        let spotAvailable = sBal.available;
        try {
          const spotBals = await spotAdapter.getSpotBalances();
          const spotUsdc = spotBals.find(b => b.token.toUpperCase().startsWith("USDC"));
          if (spotUsdc) spotAvailable += parseFloat(spotUsdc.available);
        } catch { /* non-critical */ }
        const maxNtl = Math.min(spotAvailable, pBal.available * leverage) * 0.8;
        if (maxNtl < targetSizeUsd) { if (maxNtl < 10) { ctx.log(`  [SPA] Skip ${symbol}: insufficient balance (spot=$${spotAvailable.toFixed(2)}, perp=$${pBal.available.toFixed(2)})`); return false; } targetSizeUsd = Math.floor(maxNtl); }
      }

      // Delegate to executor
      const result = await this.executor.openPosition({
        symbol, perpSymbol, spotExchange, perpExchange,
        spotAdapter, perpAdapter, sizeUsd: targetSizeUsd, leverage, log: ctx.log,
      });

      if (result.success) {
        const cur = ctx.state.get("spaPositions") as SpotPerpPosition[];
        cur.push({ id: genPosId(), symbol, spotExchange, perpExchange, size: result.size!, entryTime: Date.now(), entryRate, fundingHistory: [], lastFundingCheck: 0 });
        ctx.state.set("spaPositions", cur);
        ctx.state.set("arbPositions", cur.length);
        ctx.log(`  [SPA] Opened! (${cur.length}/${p.max_positions})`);
        return true;
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

  private async recoverPositions(adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext): Promise<SpotPerpPosition[]> {
    const recovered: SpotPerpPosition[] = [];
    const perpByEx = new Map<string, { symbol: string; side: string; size: string }[]>();
    for (const [name, a] of adapters) {
      try { const pos = await a.getPositions(); perpByEx.set(name, pos.map(p => ({ symbol: p.symbol.toUpperCase(), side: p.side, size: p.size }))); } catch { /* skip */ }
    }
    const used = new Set<string>();
    for (const [spotExName, spotExAdapter] of adapters) {
      try {
        const spotAdapter = await getSpotAdapter(spotExName, spotExAdapter);
        if (!spotAdapter) continue;
        const bals = await spotAdapter.getSpotBalances();
        for (const bal of bals.filter(b => Number(b.total) > 0 && !b.token.toUpperCase().startsWith("USDC"))) {
          const base = bal.token.toUpperCase().replace(/-SPOT$/, "");
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
      } catch { /* no spot */ }
    }
    return recovered;
  }
}

registerStrategy("spot-perp-arb", (_config) => new SpotPerpArbStrategy());
