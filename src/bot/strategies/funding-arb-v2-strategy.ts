import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { registerStrategy } from "../strategy-registry.js";
import { checkArbLiquidity, checkSpotPerpLiquidity } from "../../liquidity.js";
import { computeMatchedSize, computeSpotPerpMatchedSize, reconcileArbFills } from "../../arb-sizing.js";
import { getFundingHours } from "../../funding.js";
import { annualizeHourlyRate } from "../../funding/normalize.js";
import { logExecution, pruneExecutionLog } from "../../execution-log.js";
import { invalidateCache } from "../../cache.js";
import {
  type RateEntry, type RateMap, type FundingScore,
  buildAdapterMap, getSpotAdapter, transferUsdcToSpot, transferUsdcToPerp,
  getPerpSymbol, findRate, matchSymbol, getPriceEstimate, fetchRates,
  recoverArbPositions, scoreFunding, isPositionGone,
} from "./funding-arb-utils.js";

// ── V2 Types ──

interface V2Position {
  id: string;
  symbol: string;
  mode: "spot-perp" | "perp-perp";
  longExchange: string;
  shortExchange: string;
  size: string;
  entryTime: number;
  entrySpread: number;
  fundingHistory: { time: number; amount: number }[];
  lastFundingCheck: number;
}

interface V2Params {
  type: "funding-arb-v2";
  min_spread: number;
  close_spread: number;
  size_usd: number;
  max_positions: number;
  exchanges: string[];
  leverage: number;
  min_hold_hours: number;
  min_consistency: number;
  history_periods: number;
  spot_perp_priority: boolean;
  rotation_threshold: number;
}

interface ScoredOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  spread: number;
  score: FundingScore;
  mode: "spot-perp" | "perp-perp";
  shortRate: number;
  longRate: number;
}

let _posIdCounter = 0;
function genPosId(): string { return `v2-${Date.now()}-${++_posIdCounter}`; }

// ── Strategy ──

export class FundingArbV2Strategy implements Strategy {
  readonly name = "funding-arb-v2";

  describe() {
    return {
      description: "Funding arbitrage v2 — history-based, spot-perp primary, short rotation",
      params: [
        { name: "min_spread", type: "number" as const, required: false, default: 15, description: "Min annualized spread % to enter" },
        { name: "close_spread", type: "number" as const, required: false, default: 3, description: "Close if spread below this %" },
        { name: "size_usd", type: "number" as const, required: false, default: 50, description: "Position size in USD" },
        { name: "max_positions", type: "number" as const, required: false, default: 5, description: "Max concurrent positions" },
        { name: "exchanges", type: "string" as const, required: true, description: "Comma-separated exchange names" },
        { name: "leverage", type: "number" as const, required: false, default: 3, description: "Max leverage" },
        { name: "min_hold_hours", type: "number" as const, required: false, default: 4, description: "Min hold before close (hours)" },
        { name: "min_consistency", type: "number" as const, required: false, default: 0.7, description: "Min positive payment ratio (0-1)" },
        { name: "history_periods", type: "number" as const, required: false, default: 6, description: "Funding periods to check" },
        { name: "spot_perp_priority", type: "boolean" as const, required: false, default: true, description: "Prefer spot-perp over perp-perp" },
        { name: "rotation_threshold", type: "number" as const, required: false, default: 10, description: "% improvement needed to rotate short" },
      ],
    };
  }

  private _config: Record<string, unknown> = {};
  private _failCooldown = new Map<string, number>();
  private _fundingScoreCache = new Map<string, { score: FundingScore; ts: number }>();

  private get params(): V2Params {
    const c = this._config;
    return {
      type: "funding-arb-v2",
      min_spread: (c.min_spread as number) ?? 15,
      close_spread: (c.close_spread as number) ?? 3,
      size_usd: (c.size_usd as number) ?? 50,
      max_positions: (c.max_positions as number) ?? 5,
      exchanges: (typeof c.exchanges === "string" ? (c.exchanges as string).split(",").map(s => s.trim()) : c.exchanges as string[]) ?? [],
      leverage: (c.leverage as number) ?? 3,
      min_hold_hours: (c.min_hold_hours as number) ?? 4,
      min_consistency: (c.min_consistency as number) ?? 0.7,
      history_periods: (c.history_periods as number) ?? 6,
      spot_perp_priority: (c.spot_perp_priority as boolean) ?? true,
      rotation_threshold: (c.rotation_threshold as number) ?? 10,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // init
  // ═══════════════════════════════════════════════════════════════════

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    try { pruneExecutionLog(30); } catch { /* non-critical */ }
    this._config = ctx.config;
    const p = this.params;
    ctx.state.set("arbRunning", true);
    ctx.state.set("v2Positions", [] as V2Position[]);
    ctx.state.set("arbPositions", 0);
    ctx.state.set("fundingIncome", 0);
    ctx.state.set("fundingLastCheck", Date.now());
    ctx.log(`  [ARBv2] Ready | spread >= ${p.min_spread}% | close < ${p.close_spread}% | size $${p.size_usd}`);
    ctx.log(`  [ARBv2] Consistency >= ${(p.min_consistency * 100).toFixed(0)}% | history ${p.history_periods} periods | rotation ${p.rotation_threshold}%`);
    ctx.log(`  [ARBv2] Exchanges: ${p.exchanges.join(", ")} | spot-perp priority: ${p.spot_perp_priority}`);

    try {
      const adapters = buildAdapterMap(ctx);
      const rawRecovered = await recoverArbPositions(adapters, (msg) => ctx.log(`  [ARBv2] ${msg}`));
      if (rawRecovered.length > 0) {
        const recovered: V2Position[] = rawRecovered.map(r => ({
          id: genPosId(), symbol: r.symbol, mode: r.mode, longExchange: r.longExchange,
          shortExchange: r.shortExchange, size: r.size, entryTime: 0, entrySpread: 0,
          fundingHistory: [], lastFundingCheck: 0,
        }));
        ctx.state.set("v2Positions", recovered);
        ctx.state.set("arbPositions", recovered.length);
        ctx.log(`  [ARBv2] Recovered ${recovered.length} position(s)`);
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
      if (Math.abs(historicalFunding) > 0.001) {
        ctx.state.set("fundingIncome", historicalFunding);
      }
    } catch (err) {
      ctx.log(`  [ARBv2] Position recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // onTick
  // ═══════════════════════════════════════════════════════════════════

  async onTick(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const p = this.params;
    const openPositions = ctx.state.get("v2Positions") as V2Position[];
    const adapters = buildAdapterMap(ctx);

    if (adapters.size < 2) { ctx.log(`  [ARBv2] Need 2+ exchanges, have ${adapters.size}`); return []; }

    // 1. Pre-filter exchanges
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
        if (Date.now() < cd) ctx.log(`  [ARBv2] ${name} on cooldown`);
        else if (available < 5) ctx.log(`  [ARBv2] ${name} available $${available.toFixed(2)} too low`);
        else if (marginPct >= 90) ctx.log(`  [ARBv2] ${name} margin ${marginPct.toFixed(0)}%`);
        else availableAdapters.set(name, a);
      } catch (err) { ctx.log(`  [ARBv2] getBalance failed for ${name}: ${err instanceof Error ? err.message : String(err)}`); }
    }

    // 2. Fetch rates
    const atMax = openPositions.length >= p.max_positions;
    const posExchanges = new Set<string>();
    if (atMax) { for (const pos of openPositions) { posExchanges.add(pos.longExchange.replace(/-spot$/i, "")); posExchanges.add(pos.shortExchange); } }
    const toScan = atMax ? [...adapters].filter(([n]) => posExchanges.has(n)) : [...adapters];
    const ratesByExchange: RateMap = new Map();
    for (const [name, a] of toScan) {
      const rates = await fetchRates(a, name);
      const map = new Map<string, RateEntry>();
      for (const r of rates) map.set(r.symbol.toUpperCase(), { rate: r.rate, price: r.price, sizeDecimals: r.sizeDecimals, maxLeverage: r.maxLeverage, fundingHours: r.fundingHours });
      ratesByExchange.set(name, map);
    }

    // Periodic funding income
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

    // 3. Update funding history (every 10 min)
    for (const pos of openPositions) {
      if (Date.now() - pos.lastFundingCheck < 10 * 60 * 1000) continue;
      try {
        const shortAdapter = adapters.get(pos.shortExchange);
        if (!shortAdapter) continue;
        const payments = await shortAdapter.getFundingPayments(p.history_periods * 2);
        const perpSym = getPerpSymbol(pos.symbol, pos.shortExchange);
        const relevant = payments.filter(fp => matchSymbol(fp.symbol, perpSym) || matchSymbol(fp.symbol, pos.symbol));
        const recent = relevant.slice(0, p.history_periods);
        if (recent.length > 0) pos.fundingHistory = recent.map(fp => ({ time: fp.time, amount: parseFloat(fp.payment) }));
        pos.lastFundingCheck = Date.now();
      } catch { /* non-critical */ }
    }

    // TUI display
    const display = openPositions.map(pos => {
      const spread = this.calcSignedSpread(pos, ratesByExchange);
      const sign = spread >= 0 ? "+" : "";
      return `${pos.symbol} ${pos.longExchange}<>${pos.shortExchange} ${sign}${spread.toFixed(1)}%`;
    });
    ctx.state.set("arbPositionDetails", display);
    ctx.state.set("fundingTotal", `$${(ctx.state.get("fundingIncome") as number).toFixed(4)}`);

    // 4. CLOSE check
    const toClose: V2Position[] = [];
    for (const pos of openPositions) {
      if (!this.checkCloseByHistory(pos, ratesByExchange, p)) continue;
      const cd = this._failCooldown.get(`${pos.symbol}:close`) ?? 0;
      if (Date.now() < cd) continue;
      ctx.log(`  [ARBv2] Closing ${pos.symbol} (${pos.mode}) ${pos.longExchange}<>${pos.shortExchange}`);
      const closed = pos.mode === "spot-perp"
        ? await this.closeSpotPerp(pos, adapters, ctx)
        : await this.closePerpPerp(pos, adapters, ctx);
      if (closed) toClose.push(pos);
    }
    if (toClose.length > 0) {
      const remaining = openPositions.filter(pos => !toClose.some(c => c.id === pos.id));
      ctx.state.set("v2Positions", remaining);
      ctx.state.set("arbPositions", remaining.length);
    }

    // 5. ROTATION check (spot-perp only)
    for (const pos of ctx.state.get("v2Positions") as V2Position[]) {
      if (pos.mode !== "spot-perp") continue;
      const rcd = this._failCooldown.get(`${pos.id}:rotate`) ?? 0;
      if (Date.now() < rcd) continue;
      const best = await this.findBestPerpShort(pos.symbol, adapters, ratesByExchange, p);
      if (!best || best.exchange === pos.shortExchange) continue;
      const currentInfo = findRate(ratesByExchange, pos.shortExchange, getPerpSymbol(pos.symbol, pos.shortExchange))
        ?? findRate(ratesByExchange, pos.shortExchange, pos.symbol);
      if (!currentInfo) continue;
      const curAnn = annualizeHourlyRate(currentInfo.rate / (currentInfo.fundingHours ?? getFundingHours(pos.shortExchange)));
      if (best.score.annualized - curAnn < p.rotation_threshold) continue;
      ctx.log(`  [ARBv2] Rotating ${pos.symbol} short: ${pos.shortExchange} (${curAnn.toFixed(1)}%) -> ${best.exchange} (${best.score.annualized.toFixed(1)}%)`);
      const ok = await this.rotateShort(pos, best.exchange, adapters, ctx, ratesByExchange);
      if (!ok) this._failCooldown.set(`${pos.id}:rotate`, Date.now() + 10 * 60 * 1000);
    }

    // 6. SCAN for new opportunities
    const numPos = (ctx.state.get("v2Positions") as V2Position[]).length;
    if (numPos >= p.max_positions) return [];
    const openSymbols = new Set((ctx.state.get("v2Positions") as V2Position[]).map(pos => pos.symbol.toUpperCase()));
    const scanNames = [...ratesByExchange.keys()].filter(n => availableAdapters.has(n));
    const scoredOpps: ScoredOpportunity[] = [];

    // 6a. Spot-perp
    if (p.spot_perp_priority) {
      for (const [spotExName, spotExAdapter] of adapters) {
        try {
          const spotAdapter = await getSpotAdapter(spotExName, spotExAdapter);
          if (!spotAdapter) continue;
          const spotMarkets = await spotAdapter.getSpotMarkets();
          for (const m of spotMarkets) {
            const base = m.baseToken.toUpperCase();
            if (openSymbols.has(base)) continue;
            if (Date.now() < (this._failCooldown.get(`${base}:entry`) ?? 0)) continue;
            const best = await this.findBestPerpShort(base, adapters, ratesByExchange, p);
            if (!best || best.score.annualized < p.min_spread || best.score.consistency < p.min_consistency) continue;
            scoredOpps.push({ symbol: base, longExchange: `${spotExName}-spot`, shortExchange: best.exchange, spread: best.score.annualized, score: best.score, mode: "spot-perp", shortRate: best.rate, longRate: 0 });
          }
        } catch { /* no spot */ }
      }
    }

    // 6b. Perp-perp
    const allSyms = new Set<string>();
    for (const [, map] of ratesByExchange) for (const sym of map.keys()) allSyms.add(sym);
    for (const sym of allSyms) {
      if (openSymbols.has(sym.toUpperCase())) continue;
      if (Date.now() < (this._failCooldown.get(`${sym}:entry`) ?? 0)) continue;
      let minH = Infinity, maxH = -Infinity, minEx = "", maxEx = "", minR = 0, maxR = 0;
      for (const ex of scanNames) {
        const ri = findRate(ratesByExchange, ex, sym);
        if (!ri) continue;
        const h = ri.rate / (ri.fundingHours ?? getFundingHours(ex));
        if (h < minH) { minH = h; minEx = ex; minR = ri.rate; }
        if (h > maxH) { maxH = h; maxEx = ex; maxR = ri.rate; }
      }
      if (!minEx || !maxEx || minEx === maxEx) continue;
      const spread = annualizeHourlyRate(maxH - minH);
      if (spread < p.min_spread) continue;
      const shortScore = await this.scoreFundingLocal(adapters.get(maxEx)!, sym, maxEx, p.history_periods);
      if (shortScore && shortScore.consistency < p.min_consistency) continue;
      scoredOpps.push({ symbol: sym, longExchange: minEx, shortExchange: maxEx, spread, score: shortScore ?? { symbol: sym, exchange: maxEx, avgRate: maxR, consistency: 1, annualized: spread, payments: 0 }, mode: "perp-perp", shortRate: maxR, longRate: minR });
    }

    scoredOpps.sort((a, b) => {
      if (p.spot_perp_priority) {
        if (a.mode === "spot-perp" && b.mode !== "spot-perp") return -1;
        if (a.mode !== "spot-perp" && b.mode === "spot-perp") return 1;
      }
      return b.spread - a.spread;
    });

    if (scoredOpps.length > 0 && numPos < p.max_positions) {
      for (const opp of scoredOpps.slice(0, 3)) {
        ctx.log(`  [ARBv2] ${opp.symbol}: ${opp.spread.toFixed(1)}% [${opp.mode}] consistency=${(opp.score.consistency * 100).toFixed(0)}% ${opp.longExchange}<>${opp.shortExchange}`);
      }
    }

    // 7. EXECUTE
    for (const opp of scoredOpps) {
      if ((ctx.state.get("v2Positions") as V2Position[]).length >= p.max_positions) break;
      const opened = opp.mode === "spot-perp"
        ? await this.openSpotPerp(opp, adapters, ctx, ratesByExchange, exchangeBalances)
        : await this.openPerpPerp(opp, adapters, ctx, ratesByExchange, exchangeBalances);
      if (opened) return [{ type: "noop" }];
    }
    if (scoredOpps.length === 0 && numPos < p.max_positions) {
      ctx.log(`  [ARBv2] No opportunities >= ${p.min_spread}% with >= ${(p.min_consistency * 100).toFixed(0)}% consistency`);
    }
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════
  // onStop
  // ═══════════════════════════════════════════════════════════════════

  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const positions = ctx.state.get("v2Positions") as V2Position[] | undefined;
    const adapters = buildAdapterMap(ctx);
    if (positions && positions.length > 0) {
      const remaining: V2Position[] = [];
      for (const pos of positions) {
        const closed = pos.mode === "spot-perp"
          ? await this.closeSpotPerp(pos, adapters, ctx)
          : await this.closePerpPerp(pos, adapters, ctx);
        if (!closed) { ctx.log(`  [ARBv2] CRITICAL: ${pos.symbol} could not be closed on stop`); remaining.push(pos); }
      }
      ctx.state.set("v2Positions", remaining);
      ctx.state.set("arbPositions", remaining.length);
    }
    const extra = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
    if (extra) { for (const [, a] of extra) { try { await a.cancelAllOrders(); } catch { /* best effort */ } } }
    return [{ type: "cancel_all" }];
  }

  // ═══════════════════════════════════════════════════════════════════
  // Core scoring / decision methods
  // ═══════════════════════════════════════════════════════════════════

  private scoreFundingLocal(adapter: ExchangeAdapter, symbol: string, exchange: string, periods: number): Promise<FundingScore | null> {
    return scoreFunding(adapter, symbol, exchange, periods, this._fundingScoreCache);
  }

  private calcSignedSpread(pos: V2Position, ratesByExchange: RateMap): number {
    if (pos.mode === "spot-perp") {
      const ri = findRate(ratesByExchange, pos.shortExchange, getPerpSymbol(pos.symbol, pos.shortExchange))
        ?? findRate(ratesByExchange, pos.shortExchange, pos.symbol);
      const fH = ri?.fundingHours ?? getFundingHours(pos.shortExchange);
      return ri ? annualizeHourlyRate(ri.rate / fH) : 0;
    }
    const li = findRate(ratesByExchange, pos.longExchange, pos.symbol);
    const si = findRate(ratesByExchange, pos.shortExchange, pos.symbol);
    if (!li || !si) return 0;
    const lH = li.rate / (li.fundingHours ?? getFundingHours(pos.longExchange));
    const sH = si.rate / (si.fundingHours ?? getFundingHours(pos.shortExchange));
    return annualizeHourlyRate(sH - lH);
  }

  private checkCloseByHistory(pos: V2Position, ratesByExchange: RateMap, p: V2Params): boolean {
    const minHoldMs = p.min_hold_hours * 60 * 60 * 1000;
    const holdTime = pos.entryTime > 0 ? Date.now() - pos.entryTime : Infinity;
    const signedSpread = this.calcSignedSpread(pos, ratesByExchange);
    // Emergency close
    if (signedSpread < -50) return true;
    if (holdTime < minHoldMs) return false;
    // History-based
    if (pos.fundingHistory.length >= 3) {
      const avgFunding = pos.fundingHistory.reduce((s, h) => s + h.amount, 0) / pos.fundingHistory.length;
      if (avgFunding < 0) return true;
    }
    // Fallback to instantaneous
    if (pos.fundingHistory.length < 3) return signedSpread < p.close_spread;
    return signedSpread < p.close_spread;
  }

  private async findBestPerpShort(symbol: string, adapters: Map<string, ExchangeAdapter>, ratesByExchange: RateMap, p: V2Params): Promise<{ exchange: string; rate: number; score: FundingScore } | null> {
    let best: { exchange: string; rate: number; score: FundingScore } | null = null;
    for (const [exName, adapter] of adapters) {
      const perpSym = getPerpSymbol(symbol, exName);
      const ri = findRate(ratesByExchange, exName, perpSym) ?? findRate(ratesByExchange, exName, symbol);
      if (!ri || ri.rate <= 0) continue;
      const score = await this.scoreFundingLocal(adapter, perpSym, exName, p.history_periods)
        ?? await this.scoreFundingLocal(adapter, symbol, exName, p.history_periods);
      if (!score) continue;
      if (!best || score.annualized > best.score.annualized) best = { exchange: exName, rate: ri.rate, score };
    }
    return best;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Rotation
  // ═══════════════════════════════════════════════════════════════════

  private async rotateShort(pos: V2Position, newExchange: string, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext, ratesByExchange: RateMap): Promise<boolean> {
    const oldAdapter = adapters.get(pos.shortExchange);
    const newAdapter = adapters.get(newExchange);
    if (!oldAdapter || !newAdapter) { ctx.log(`  [ARBv2] Rotation: adapter not found`); return false; }
    const oldSym = getPerpSymbol(pos.symbol, pos.shortExchange);
    const newSym = getPerpSymbol(pos.symbol, newExchange);
    const p = this.params;
    const newMaxLev = findRate(ratesByExchange, newExchange, newSym)?.maxLeverage ?? findRate(ratesByExchange, newExchange, pos.symbol)?.maxLeverage ?? 1;
    try { await newAdapter.setLeverage(newSym, Math.min(p.leverage, newMaxLev), "cross"); } catch (err) {
      ctx.log(`  [ARBv2] Rotation setLeverage failed: ${err instanceof Error ? err.message : String(err)}`); return false;
    }
    // Close old short
    try {
      await oldAdapter.marketOrder(oldSym, "buy", pos.size, { reduceOnly: true });
      logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false, meta: { rotation: true } });
    } catch (err) {
      ctx.log(`  [ARBv2] Rotation close failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    // Open new short
    try {
      await newAdapter.marketOrder(newSym, "sell", pos.size);
      logExecution({ type: "arb_entry", exchange: newExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "success", dryRun: false, meta: { rotation: true } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [ARBv2] Rotation new short failed: ${msg} — rolling back`);
      try {
        await oldAdapter.marketOrder(oldSym, "sell", pos.size);
        ctx.log(`  [ARBv2] Rotation rollback OK`);
        logExecution({ type: "multi_leg_rollback", exchange: pos.shortExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "success", dryRun: false });
      } catch (rbErr) {
        ctx.log(`  [ARBv2] CRITICAL: Rotation rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        logExecution({ type: "multi_leg_rollback", exchange: pos.shortExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "failed", error: rbErr instanceof Error ? rbErr.message : String(rbErr), dryRun: false });
      }
      return false;
    }
    pos.shortExchange = newExchange;
    pos.fundingHistory = [];
    pos.lastFundingCheck = 0;
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Open / Close — spot-perp
  // ═══════════════════════════════════════════════════════════════════

  private async openSpotPerp(opp: ScoredOpportunity, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext, ratesByExchange: RateMap, exchangeBalances: Map<string, { equity: number; available: number; marginPct: number }>): Promise<boolean> {
    const p = this.params;
    const spotExName = opp.longExchange.replace("-spot", "");
    const spotExAdapter = adapters.get(spotExName);
    const perpAdapter = adapters.get(opp.shortExchange);
    if (!spotExAdapter || !perpAdapter) { this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false; }
    try {
      const spotAdapter = await getSpotAdapter(spotExName, spotExAdapter);
      if (!spotAdapter) return false;
      const perpSymbol = getPerpSymbol(opp.symbol, opp.shortExchange);
      const perpMaxLev = findRate(ratesByExchange, opp.shortExchange, perpSymbol)?.maxLeverage ?? findRate(ratesByExchange, opp.shortExchange, opp.symbol)?.maxLeverage ?? 1;
      const leverage = Math.min(p.leverage, perpMaxLev);
      try { await perpAdapter.setLeverage(perpSymbol, leverage, "cross"); } catch (err) {
        ctx.log(`  [ARBv2] setLeverage failed: ${err instanceof Error ? err.message : String(err)}`);
        this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
      }

      let targetSizeUsd = p.size_usd;
      const sameExchange = spotExName === opp.shortExchange;
      if (sameExchange) {
        const perpBal = await perpAdapter.getBalance();
        const perpAvail = parseFloat(perpBal.available);
        const totalNeeded = targetSizeUsd + targetSizeUsd / leverage;
        if (perpAvail < totalNeeded) {
          const max = perpAvail * 0.8 / (1 + 1 / leverage);
          if (max < 10) { ctx.log(`  [ARBv2] Skip spot-perp ${opp.symbol}: insufficient balance`); return false; }
          targetSizeUsd = Math.floor(max);
        }
      } else {
        const sBal = exchangeBalances.get(spotExName);
        const pBal = exchangeBalances.get(opp.shortExchange);
        if (!sBal || !pBal) return false;
        let spotAvail = sBal.available;
        const spotExAdapter = adapters.get(spotExName);
        if (spotExAdapter && !spotExAdapter.isUnifiedAccount) {
          try {
            const sb = await spotAdapter.getSpotBalances();
            const su = sb.find(b => b.token.toUpperCase().startsWith("USDC"));
            if (su) spotAvail += parseFloat(su.available);
          } catch { /* non-critical */ }
        }
        const maxNtl = Math.min(spotAvail, pBal.available * leverage) * 0.8;
        if (maxNtl < targetSizeUsd) { if (maxNtl < 10) return false; targetSizeUsd = Math.floor(maxNtl); }
      }

      const price = await getPriceEstimate(perpAdapter, perpSymbol, opp.symbol);
      if (price <= 0) return false;
      const liq = await checkSpotPerpLiquidity(spotAdapter, perpAdapter, opp.symbol, perpSymbol, targetSizeUsd, 0.5, (msg) => ctx.log(`  ${msg}`));
      if (!liq.viable) return false;
      const spotMarkets = await spotAdapter.getSpotMarkets();
      const spotDec = spotMarkets.find(m => m.baseToken.toUpperCase() === opp.symbol.toUpperCase())?.sizeDecimals;
      const matched = computeSpotPerpMatchedSize(liq.adjustedSizeUsd, price, spotExName, opp.shortExchange, spotDec);
      if (!matched) { ctx.log(`  [ARBv2] Skip spot-perp ${opp.symbol}: matched size fail`); return false; }

      ctx.log(`  [ARBv2] Opening spot-perp: ${matched.size} ${opp.symbol} ($${matched.notional.toFixed(0)})`);

      if (sameExchange) {
        const tAmt = Math.ceil(matched.notional * 1.02);
        await transferUsdcToSpot(spotAdapter, spotExName, tAmt);
      }

      // Buy spot
      try {
        await spotAdapter.spotMarketOrder(opp.symbol, "buy", matched.size);
        logExecution({ type: "arb_entry", exchange: opp.longExchange, symbol: opp.symbol, side: "buy", size: matched.size, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "spot" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARBv2] Spot buy failed: ${msg}`);
        if (sameExchange) { try { await transferUsdcToPerp(spotAdapter, spotExName, Math.ceil(matched.notional * 1.02)); } catch { /* best effort */ } }
        this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
      }

      // Short perp
      try {
        await perpAdapter.marketOrder(perpSymbol, "sell", matched.size);
        logExecution({ type: "arb_entry", exchange: opp.shortExchange, symbol: opp.symbol, side: "sell", size: matched.size, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "perp" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARBv2] Perp short failed: ${msg} — ROLLING BACK spot`);
        try {
          await spotAdapter.spotMarketOrder(opp.symbol, "sell", matched.size);
          logExecution({ type: "multi_leg_rollback", exchange: opp.longExchange, symbol: opp.symbol, side: "sell", size: matched.size, status: "success", dryRun: false });
          if (sameExchange) { try { await transferUsdcToPerp(spotAdapter, spotExName, Math.ceil(matched.notional * 1.02)); } catch { /* best effort */ } }
        } catch (rbErr) {
          ctx.log(`  [ARBv2] CRITICAL: Spot rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
        this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
      }

      const cur = ctx.state.get("v2Positions") as V2Position[];
      cur.push({ id: genPosId(), symbol: opp.symbol, mode: "spot-perp", longExchange: opp.longExchange, shortExchange: opp.shortExchange, size: matched.size, entryTime: Date.now(), entrySpread: opp.spread, fundingHistory: [], lastFundingCheck: 0 });
      ctx.state.set("v2Positions", cur);
      ctx.state.set("arbPositions", cur.length);
      ctx.log(`  [ARBv2] Spot-perp opened! (${cur.length}/${p.max_positions})`);
      return true;
    } catch (err) {
      ctx.log(`  [ARBv2] Open spot-perp failed: ${err instanceof Error ? err.message : String(err)}`);
      this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
    }
  }

  private async closeSpotPerp(pos: V2Position, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext): Promise<boolean> {
    const spotExName = pos.longExchange.replace("-spot", "");
    const adapterForSpot = adapters.get(spotExName) ?? adapters.get(pos.shortExchange);
    const perpAdapter = adapters.get(pos.shortExchange);
    if (!perpAdapter || !adapterForSpot) { ctx.log(`  [ARBv2] Close spot-perp: no adapter`); return false; }
    try {
      const spotAdapter = await getSpotAdapter(spotExName, adapterForSpot);
      if (!spotAdapter) return false;
      // Sell spot
      try { await spotAdapter.spotMarketOrder(pos.symbol, "sell", pos.size); } catch (err) {
        ctx.log(`  [ARBv2] Spot sell failed: ${err instanceof Error ? err.message : String(err)}`);
        this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000); return false;
      }
      // Transfer USDC back to perp (always — not just same-exchange)
      try {
        const spotBals = await spotAdapter.getSpotBalances();
        const usdcBal = spotBals.find(b => b.token.toUpperCase().startsWith("USDC"));
        const usdcAmt = usdcBal ? parseFloat(usdcBal.total) : 0;
        if (usdcAmt > 1) await transferUsdcToPerp(spotAdapter, spotExName, Math.floor(usdcAmt));
      } catch { /* non-fatal */ }
      // Close perp short
      const perpSym = getPerpSymbol(pos.symbol, pos.shortExchange);
      try {
        await perpAdapter.marketOrder(perpSym, "buy", pos.size, { reduceOnly: true });
        logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode } });
        return true;
      } catch (err) {
        ctx.log(`  [ARBv2] Perp close failed: ${err instanceof Error ? err.message : String(err)} — rollback spot`);
        try { await spotAdapter.spotMarketOrder(pos.symbol, "buy", pos.size); } catch (rbErr) {
          ctx.log(`  [ARBv2] CRITICAL: Spot rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
        this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000); return false;
      }
    } catch (err) { ctx.log(`  [ARBv2] Close spot-perp failed: ${err instanceof Error ? err.message : String(err)}`); return false; }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Open / Close — perp-perp
  // ═══════════════════════════════════════════════════════════════════

  private async openPerpPerp(opp: ScoredOpportunity, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext, ratesByExchange: RateMap, exchangeBalances: Map<string, { equity: number; available: number; marginPct: number }>): Promise<boolean> {
    const p = this.params;
    const longAdapter = adapters.get(opp.longExchange);
    const shortAdapter = adapters.get(opp.shortExchange);
    if (!longAdapter || !shortAdapter) return false;
    const price = findRate(ratesByExchange, opp.longExchange, opp.symbol)?.price ?? 0;
    if (price <= 0) return false;

    const longMaxLev = findRate(ratesByExchange, opp.longExchange, opp.symbol)?.maxLeverage ?? 1;
    const shortMaxLev = findRate(ratesByExchange, opp.shortExchange, opp.symbol)?.maxLeverage ?? 1;
    const leverage = Math.min(p.leverage, longMaxLev, shortMaxLev);
    try { await longAdapter.setLeverage(opp.symbol, leverage, "cross"); } catch (err) {
      this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
    }
    try { await shortAdapter.setLeverage(opp.symbol, leverage, "cross"); } catch (err) {
      this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
    }

    let targetSizeUsd = p.size_usd;
    const lBal = exchangeBalances.get(opp.longExchange);
    const sBal = exchangeBalances.get(opp.shortExchange);
    if (!lBal || !sBal) return false;
    const minAvail = Math.min(lBal.available, sBal.available);
    if (minAvail < targetSizeUsd / leverage) {
      const max = minAvail * leverage * 0.8;
      if (max < 10) return false;
      targetSizeUsd = Math.floor(max);
    }

    const liq = await checkArbLiquidity(longAdapter, shortAdapter, opp.symbol, targetSizeUsd, 0.5, (msg) => ctx.log(`  ${msg}`));
    if (!liq.viable) return false;
    const lDec = findRate(ratesByExchange, opp.longExchange, opp.symbol)?.sizeDecimals;
    const sDec = findRate(ratesByExchange, opp.shortExchange, opp.symbol)?.sizeDecimals;
    const matched = computeMatchedSize(liq.adjustedSizeUsd, price, opp.longExchange, opp.shortExchange, { longSizeDecimals: lDec, shortSizeDecimals: sDec });
    if (!matched) { ctx.log(`  [ARBv2] Skip ${opp.symbol}: matched size fail`); return false; }

    ctx.log(`  [ARBv2] Opening perp-perp: ${matched.size} ${opp.symbol} ($${matched.notional.toFixed(0)}/leg)`);

    // Long leg
    try {
      await longAdapter.marketOrder(opp.symbol, "buy", matched.size);
      logExecution({ type: "arb_entry", exchange: opp.longExchange, symbol: opp.symbol, side: "buy", size: matched.size, notional: matched.notional / 2, status: "success", dryRun: false, meta: { mode: "perp-perp", leg: "long" } });
    } catch (err) {
      ctx.log(`  [ARBv2] Long leg failed: ${err instanceof Error ? err.message : String(err)}`);
      this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
    }

    // Short leg
    try {
      await shortAdapter.marketOrder(opp.symbol, "sell", matched.size);
      logExecution({ type: "arb_entry", exchange: opp.shortExchange, symbol: opp.symbol, side: "sell", size: matched.size, notional: matched.notional / 2, status: "success", dryRun: false, meta: { mode: "perp-perp", leg: "short" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [ARBv2] Short leg failed: ${msg} — ROLLING BACK`);
      try {
        await longAdapter.marketOrder(opp.symbol, "sell", matched.size, { reduceOnly: true });
        logExecution({ type: "multi_leg_rollback", exchange: opp.longExchange, symbol: opp.symbol, side: "sell", size: matched.size, status: "success", dryRun: false });
      } catch (rbErr) {
        ctx.log(`  [ARBv2] CRITICAL: Rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
      }
      this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 5 * 60 * 1000); return false;
    }

    // Verify
    try { const r = await reconcileArbFills(longAdapter, shortAdapter, opp.symbol, (msg) => ctx.log(`  ${msg}`)); if (!r.matched) ctx.log(`  [ARBv2] WARNING: fills not matched`); } catch { /* non-critical */ }
    invalidateCache("acct");
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const [lp, sp] = await Promise.all([longAdapter.getPositions(), shortAdapter.getPositions()]);
      const lE = lp.some(x => matchSymbol(x.symbol, opp.symbol) && parseFloat(x.size) > 0);
      const sE = sp.some(x => matchSymbol(x.symbol, opp.symbol) && parseFloat(x.size) > 0);
      if (!lE && !sE) { ctx.log(`  [ARBv2] Positions not visible (cache delay?)`); }
      else if (!lE || !sE) {
        ctx.log(`  [ARBv2] Position verify failed: long=${lE}, short=${sE}`);
        if (lE && !sE) { try { await longAdapter.marketOrder(opp.symbol, "sell", matched.size, { reduceOnly: true }); } catch { /* best effort */ } }
        if (sE && !lE) { try { await shortAdapter.marketOrder(opp.symbol, "buy", matched.size, { reduceOnly: true }); } catch { /* best effort */ } }
        this._failCooldown.set(`${opp.symbol}:entry`, Date.now() + 10 * 60 * 1000); return false;
      }
    } catch (err) { ctx.log(`  [ARBv2] Verify error: ${err instanceof Error ? err.message : String(err)}`); }

    const cur = ctx.state.get("v2Positions") as V2Position[];
    cur.push({ id: genPosId(), symbol: opp.symbol, mode: "perp-perp", longExchange: opp.longExchange, shortExchange: opp.shortExchange, size: matched.size, entryTime: Date.now(), entrySpread: opp.spread, fundingHistory: [], lastFundingCheck: 0 });
    ctx.state.set("v2Positions", cur);
    ctx.state.set("arbPositions", cur.length);
    ctx.log(`  [ARBv2] Perp-perp opened! (${cur.length}/${p.max_positions})`);
    return true;
  }

  private async closePerpPerp(pos: V2Position, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext): Promise<boolean> {
    const longAdapter = adapters.get(pos.longExchange);
    const shortAdapter = adapters.get(pos.shortExchange);
    if (!longAdapter || !shortAdapter) { ctx.log(`  [ARBv2] Close perp-perp: adapters not found`); return false; }
    const isGone = isPositionGone;
    let closeLongOk = false;
    let longGone = false;

    try {
      await longAdapter.marketOrder(pos.symbol, "sell", pos.size, { reduceOnly: true });
      closeLongOk = true;
      logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "long" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isGone(msg)) { longGone = true; this._failCooldown.set(`${pos.longExchange}:exchange`, Date.now() + 30 * 60 * 1000); }
      else { ctx.log(`  [ARBv2] Close long failed: ${msg}`); this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000); return false; }
    }

    try {
      await shortAdapter.marketOrder(pos.symbol, "buy", pos.size, { reduceOnly: true });
      logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "short" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isGone(msg)) { this._failCooldown.set(`${pos.shortExchange}:exchange`, Date.now() + 30 * 60 * 1000); }
      else if (closeLongOk) {
        ctx.log(`  [ARBv2] Close short failed: ${msg} — re-opening long`);
        try { await longAdapter.marketOrder(pos.symbol, "buy", pos.size); logExecution({ type: "multi_leg_rollback", exchange: pos.longExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false }); }
        catch (rbErr) { ctx.log(`  [ARBv2] CRITICAL: Rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`); }
        this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000); return false;
      } else {
        ctx.log(`  [ARBv2] Force closing orphaned short: ${msg}`);
        try { await shortAdapter.marketOrder(pos.symbol, "buy", pos.size); } catch (fErr) {
          ctx.log(`  [ARBv2] CRITICAL: Force close failed: ${fErr instanceof Error ? fErr.message : String(fErr)}`);
          this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 10 * 60 * 1000); return false;
        }
      }
    }
    ctx.log(`  [ARBv2] Closed ${pos.symbol}${longGone ? " (long was liquidated)" : ""}`);
    return true;
  }
}

registerStrategy("funding-arb-v2", (_config) => new FundingArbV2Strategy());
