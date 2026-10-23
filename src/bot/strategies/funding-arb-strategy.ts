import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { FundingArbStrategyParams } from "../config.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { registerStrategy } from "../strategy-registry.js";
import { PerpError } from "../../errors.js";
import { checkArbLiquidity, checkSpotPerpLiquidity } from "../../liquidity.js";
import { computeMatchedSize, computeSpotPerpMatchedSize } from "../../arb-sizing.js";
import { getFundingHours } from "../../funding.js";
import { logExecution, pruneExecutionLog } from "../../execution-log.js";
import { annualizeHourlyRate } from "../../funding/normalize.js";
import { getBotSpotAdapter, nonQuoteSpotBalances, readSpotQuoteAvailableFresh, spotNetworkOf, spotTokenBase, sweepSpotQuoteToPerp } from "../../exchanges/spot-factory.js";
import { getVenue } from "../../exchanges/venue.js";
import {
  isPositionGone,
  transferUsdcToSpot,
  transferUsdcToPerp,
  getPerpSymbol,
  findRate,
  cappedLeverage,
  getPriceEstimate,
  fetchRates,
  botSpotPerpMatches, assertFundingArbLegs, cancelBotSymbols, collectFundingSince } from "./funding-arb-utils.js";
import type { VenueMarket } from "../../exchanges/venue-types.js";
import { fillSizeString, sizeDecimalsOf, spotLotStepOf, spotMarketFill } from "../../exchanges/spot-result.js";
import { floorToStep, lotStepOf } from "../../exchanges/precision.js";
import { isQuarantined, quarantineKey, quarantineSymbol } from "../quarantine.js";
import { SpotPerpExecutor } from "./spot-perp-executor.js";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified, trimFirstLegToHedge } from "../perp-order.js";
import { reportedAvgFillPrice } from "../../exchanges/ioc-outcome.js";
import { recordSpotPerpClose, recordSpotPerpEntry } from "./spot-perp-state.js";

let _posIdCounter = 0;
function genPosId(): string { return `fa-${Date.now()}-${++_posIdCounter}`; }

/** Consecutive failed closes (spot-perp and perp-perp) before the symbol is quarantined — no retry loop (same bound as funding-arb-v2 / funding-auto). */
const MAX_CLOSE_FAILURES = 3;

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
  entryTime: number;  // timestamp ms
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
        { name: "min_hold_hours", type: "number" as const, required: false, default: 2, description: "Min hold time before close (hours)" },
      ],
    };
  }

  private get params(): FundingArbStrategyParams {
    return this._config as unknown as FundingArbStrategyParams;
  }

  private _config: Record<string, unknown> = {};
  private _failCooldown = new Map<string, number>(); // "symbol:action" → timestamp of next retry
  /** Consecutive failed closes per symbol, spot-perp and perp-perp (quarantined at MAX_CLOSE_FAILURES). */
  private _closeFailures = new Map<string, number>();
  /** Venues whose positions could not be read during recovery: no entries there until re-read. */
  private _unrecovered = new Set<string>();
  private executor = new SpotPerpExecutor();
  /** Symbols this bot entered or tracked this run — the only symbols its stop cancels orders on. */
  private _traded = new Set<string>();

  private quarantined(symbol: string, ctx: StrategyContext): boolean {
    return isQuarantined(symbol, ctx.log);
  }

  /** Unknown / unhedged outcome: stop touching this symbol until a human clears it. */
  private quarantine(symbol: string, reason: string, venues: string, ctx: StrategyContext): void {
    const list = venues.split("/");
    const checks = list.map(v => `perp -e ${v} positions, perp -e ${v} trade spot-balance, perp -e ${v} trade spot-orders`).join("; ");
    quarantineSymbol(this.name, symbol, reason,
      `Check ${symbol.toUpperCase()} on ${list.join(" and ")} (${checks}); resolve by hand, then: perp strategy quarantine-clear ${symbol.toUpperCase()}`,
      ctx.log);
  }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    assertFundingArbLegs(ctx);
    // Prune old execution logs (keep 30 days)
    try { pruneExecutionLog(30); } catch { /* non-critical */ }
    this._config = ctx.config;
    const params = this.params;
    ctx.state.set("arbRunning", true);
    ctx.state.set("arbOpenPositions", [] as ArbOpenPosition[]);
    ctx.state.set("arbPositions", 0);
    ctx.state.set("fundingIncome", 0);
    // Payments up to this instant are covered by the startup recovery (last 24 h); the periodic
    // check books only payments newer than it (collectFundingSince high-water mark).
    ctx.state.set("fundingStartTime", Date.now());
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

      const { recovered, unreadable } = await this.recoverPositions(adapters, ctx);
      this._unrecovered = unreadable;
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
          const startedAt = ctx.state.get("fundingStartTime") as number;
          const recent = payments.filter(p => p.time > oneDayAgo && p.time <= startedAt);
          const sum = recent.reduce((s, p) => s + parseFloat(p.payment), 0);
          if (Math.abs(sum) > 0.001) {
            historicalFunding += sum;
            ctx.log(`  [FUND] ${name}: $${sum.toFixed(4)} historical funding`);
          }
        } catch (e) {
          ctx.log(`  [FUND] ${name}: funding history unavailable — historical funding excludes it: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (Math.abs(historicalFunding) > 0.001) {
        ctx.state.set("fundingIncome", historicalFunding);
        ctx.log(`  [FUND] Total historical funding: $${historicalFunding.toFixed(4)}`);
      }

      // Note: aster funding intervals are bootstrapped lazily via getFundingHours()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [ARB] Position recovery failed: ${msg}`);
    }
  }

  /**
   * Rebuild tracked positions from the venues (perp-perp pairs + same-venue spot-perp
   * hedges). A venue whose positions or spot balances cannot be read is returned in
   * `unreadable` — never treated as holding nothing.
   */
  private async recoverPositions(
    adapters: Map<string, ExchangeAdapter>,
    ctx: StrategyContext,
  ): Promise<{ recovered: ArbOpenPosition[]; unreadable: Set<string> }> {
    const unreadable = new Set<string>();
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
      } catch (e) {
        // Never "no positions": no entries on this venue until its positions are read.
        unreadable.add(name);
        ctx.log(`  [ARB] ${name} positions unreadable during recovery (${e instanceof Error ? e.message : String(e)}) — no entries on ${name} until recovered`);
      }
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
            // Only an exactly size-matched long/short is a pair; anything else is quarantined below.
            if (Math.abs(Number(pA.size)) !== Math.abs(Number(pB.size))) continue;

            // Found a matching pair
            const longEx = pA.side === "long" ? exA : exB;
            const shortEx = pA.side === "short" ? exA : exB;
            const size = pA.side === "long" ? pA.size : pB.size;
            recovered.push({ symbol: pA.symbol, longExchange: longEx, shortExchange: shortEx, entrySpread: 0, size, mode: "perp-perp", entryTime: 0 });
            used.add(keyA);
            used.add(keyB);
            break;
          }
          if (used.has(keyA)) break;
        }
      }
    }

    // ── Spot-perp hedges: a perp short on venue P + spot holdings of the same canonical
    //    base on a bot spot venue S — same venue (e.g. PURR spot + PURR-PERP short on HL)
    //    or cross-venue (spot on A, perp short on B, as `arb exec spot:A B` /
    //    spot-perp-arb open them). Matched by quarantineKey (canonical: HIP-3 prefix /
    //    "-PERP" stripped, denomination aliases). A same-venue holding wins; otherwise
    //    exactly one candidate venue is required — an ambiguous match (several venues
    //    hold the base, or the only holding is already matched to another short) is
    //    quarantined instead of being left as untracked exposure.
    const holdings = new Map<string, Map<string, string>>(); // venue → canonical key → spot token
    for (const [name, a] of adapters) {
      try {
        const spotAdapter = await getBotSpotAdapter(name, a);
        if (!spotAdapter) continue;
        const nonUsdc = nonQuoteSpotBalances(getVenue(name), spotNetworkOf(spotAdapter), await spotAdapter.getSpotBalances());
        ctx.log(`  [ARB] ${name} spot balances: ${nonUsdc.map(b => `${b.token}=${b.total}`).join(", ") || "none"}`);
        const byKey = new Map<string, string>();
        for (const b of nonUsdc) byKey.set(quarantineKey(spotTokenBase(b.token)), b.token);
        holdings.set(name, byKey);
      } catch (e) {
        unreadable.add(name);
        ctx.log(`  [ARB] ${name} spot recovery failed: ${e instanceof Error ? e.message : String(e)} — no entries on ${name} until recovered`);
      }
    }

    const usedSpot = new Set<string>(); // "venue:KEY"
    for (const [perpVenue, perpPositions] of positionsByExchange) {
      for (const perp of perpPositions) {
        if (perp.side !== "short") continue;
        const perpKey = `${perpVenue}:${perp.symbol}`;
        if (used.has(perpKey)) { ctx.log(`  [ARB] ${perpKey} already matched cross-exchange, skip spot-perp`); continue; }
        const key = quarantineKey(perp.symbol);
        const holders = [...holdings].filter(([, byKey]) => byKey.has(key)).map(([v]) => v);
        if (holders.length === 0) continue;
        const free = holders.filter(v => !usedSpot.has(`${v}:${key}`));
        const spotVenue = free.includes(perpVenue) ? perpVenue : free.length === 1 ? free[0] : null;
        if (spotVenue === null) {
          this.quarantine(key,
            `recovery: perp short ${perp.size} ${perp.symbol} on ${perpVenue} has an ambiguous spot hedge (spot ${key} held on ${holders.join(", ")}${free.length < holders.length ? "; some already matched to another short" : ""}) — not tracked`,
            [perpVenue, ...holders.filter(v => v !== perpVenue)].join("/"), ctx);
          continue;
        }
        const base = perp.symbol.replace(/-PERP$/, "").toUpperCase(); // perp venue's own symbol (orders use it)
        recovered.push({ symbol: base, longExchange: `${spotVenue}-spot`, shortExchange: perpVenue, entrySpread: 0, size: perp.size, mode: "spot-perp", entryTime: 0 });
        used.add(perpKey);
        usedSpot.add(`${spotVenue}:${key}`);
        const q = this.quarantined(base, ctx) ? " — QUARANTINED: tracked but not touched until cleared" : "";
        ctx.log(`  [ARB] Detected spot-perp hedge: ${base} ${spotVenue}-spot (${holdings.get(spotVenue)!.get(key)})↔${perpVenue} perp short ${perp.size}${q}`);
      }
    }

    // ── Unpaired legs: a single perp leg, or a long/short whose sizes differ, is exposure the
    //    bot cannot manage as a hedge — quarantined (both sizes recorded), never left untracked
    //    for a later entry to stack on.
    const leftover = new Map<string, { venue: string; symbol: string; side: string; size: string }[]>();
    for (const [venue, list] of positionsByExchange) {
      for (const p of list) {
        if (Number(p.size) === 0 || used.has(`${venue}:${p.symbol}`)) continue;
        const key = quarantineKey(p.symbol);
        leftover.set(key, [...(leftover.get(key) ?? []), { venue, ...p }]);
      }
    }
    for (const [key, legs] of leftover) {
      if (this.quarantined(key, ctx)) continue;
      const desc = legs.map(l => `${l.side} ${l.size.replace(/^-/, "")} on ${l.venue}`).join(", ");
      const mismatched = legs.some(l => l.side === "long") && legs.some(l => l.side === "short");
      this.quarantine(key,
        mismatched
          ? `recovery: ${key} long/short sizes do not match (${desc}) — not tracked as a pair`
          : `recovery: unpaired ${key} perp leg (${desc}) — no hedge found, not tracked`,
        [...new Set(legs.map(l => l.venue))].join("/"), ctx);
    }

    return { recovered, unreadable };
  }

  /**
   * true when `symbol` has a live perp position on any of `venues` that the bot does not track
   * (a manual / foreign position): no entry is stacked on it. A failed read counts as held
   * (unknown is never "flat").
   */
  private async heldUntracked(symbol: string, venues: string[], adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext, cache: Map<string, Promise<{ symbol: string; size: string }[]>>): Promise<boolean> {
    const key = quarantineKey(symbol);
    const tracked = (ctx.state.get("arbOpenPositions") as ArbOpenPosition[]).some(p => quarantineKey(p.symbol) === key);
    for (const v of venues) {
      const a = adapters.get(v);
      if (a === undefined) continue;
      if (!cache.has(v)) cache.set(v, a.getPositions());
      let list: { symbol: string; size: string }[];
      try {
        list = await cache.get(v)!;
      } catch (e) {
        ctx.log(`  [ARB] Skip ${symbol}: ${v} positions unreadable (${e instanceof Error ? e.message : String(e)}) — no entry on unknown exposure`);
        return true;
      }
      if (!tracked && list.some(p => quarantineKey(p.symbol) === key && Number(p.size) !== 0)) {
        ctx.log(`  [ARB] Skip ${symbol}: a ${symbol} position on ${v} is not one of the bot's pairs — no entry on top of it`);
        return true;
      }
    }
    return false;
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

    // ── Retry recovery on venues whose positions could not be read at init ──
    if (this._unrecovered.size > 0) {
      const { recovered, unreadable } = await this.recoverPositions(adapters, ctx);
      const tracked = new Set(openPositions.map(p => p.symbol.toUpperCase()));
      for (const r of recovered) {
        if (tracked.has(r.symbol.toUpperCase())) continue;
        openPositions.push(r);
        tracked.add(r.symbol.toUpperCase());
        ctx.log(`  [ARB] Recovered ${r.symbol} ${r.longExchange}↔${r.shortExchange} (retry)`);
      }
      ctx.state.set("arbPositions", openPositions.length);
      this._unrecovered = unreadable;
    }

    // ── Pre-filter exchanges by margin availability ──
    const exchangeBalances = new Map<string, { equity: number; available: number; marginPct: number }>();
    const availableAdapters = new Map<string, ExchangeAdapter>();

    for (const [name, a] of adapters) {
      try {
        const bal = await a.getBalance();
        const equity = parseFloat(bal.equity);
        const marginUsed = parseFloat(bal.marginUsed);
        const marginPct = equity > 0 ? (marginUsed / equity) * 100 : 100;
        const available = parseFloat(bal.available);
        exchangeBalances.set(name, { equity, available, marginPct });
        // Skip if: margin > 90%, available < $5, or exchange on liquidation cooldown
        const exchCooldown = this._failCooldown.get(`${name}:exchange`) ?? 0;
        if (this._unrecovered.has(name)) {
          ctx.log(`  [ARB] ${name} positions not recovered — no entries this tick`);
        } else if (Date.now() < exchCooldown) {
          ctx.log(`  [ARB] ${name} on liquidation cooldown — skipping`);
        } else if (available < 5) {
          ctx.log(`  [ARB] ${name} available $${available.toFixed(2)} too low — skipping`);
        } else if (marginPct >= 90) {
          ctx.log(`  [ARB] ${name} margin ${marginPct.toFixed(0)}% — skipping`);
        } else {
          availableAdapters.set(name, a);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARB] getBalance failed for ${name}: ${msg} — skipping`);
        // Don't include in availableAdapters
      }
    }

    // Determine which exchanges need rate fetching.
    // When at max_positions we only need rates for exchanges that hold open positions
    // (to evaluate close conditions). Exchanges with no positions can be skipped.
    const atMaxPositions = openPositions.length >= (params.max_positions ?? 3);
    const positionExchanges = new Set<string>();
    if (atMaxPositions) {
      for (const p of openPositions) {
        positionExchanges.add(p.longExchange.replace(/-spot$/i, ""));
        positionExchanges.add(p.shortExchange);
      }
    }
    const exchangesToScan = atMaxPositions
      ? [...adapters].filter(([name]) => positionExchanges.has(name))
      : [...adapters];

    // Fetch rates — all exchanges if room for new positions, only position exchanges if full
    const ratesByExchange = new Map<string, Map<string, { rate: number; price: number; sizeDecimals?: number; maxLeverage?: number; fundingHours?: number }>>();
    for (const [name, a] of exchangesToScan) {
      let rates: Awaited<ReturnType<typeof fetchRates>>;
      try {
        rates = await fetchRates(a, name);
      } catch (err) {
        // Recorded per venue; this venue is left out of this cycle's rate map.
        ctx.log(`  [FARB] fetchRates failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const map = new Map<string, { rate: number; price: number; sizeDecimals?: number; maxLeverage?: number; fundingHours?: number }>();
      for (const r of rates) map.set(r.symbol.toUpperCase(), { rate: r.rate, price: r.price, sizeDecimals: r.sizeDecimals, maxLeverage: r.maxLeverage, fundingHours: r.fundingHours });
      ratesByExchange.set(name, map);
    }

    // ── Fetch funding income periodically (every 5 minutes) ──
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

    // ── Update strategy state for TUI display ──
    const arbPosForDisplay = openPositions.map(p => {
      let signedSpread: number;
      if (p.mode === "spot-perp") {
        // For spot-perp: long side is spot (rate=0), short side is perp
        const perpExchange = p.shortExchange;
        const perpSymbol = getPerpSymbol(p.symbol, perpExchange);
        const rateInfo = findRate(ratesByExchange, perpExchange, perpSymbol)
          ?? findRate(ratesByExchange, perpExchange, p.symbol);
        const shortRate = rateInfo?.rate;
        const fundingH = rateInfo?.fundingHours ?? getFundingHours(perpExchange);
        signedSpread = shortRate !== undefined ? annualizeHourlyRate(shortRate / fundingH) : 0;
      } else {
        const longInfo = findRate(ratesByExchange, p.longExchange, p.symbol);
        const shortInfo = findRate(ratesByExchange, p.shortExchange, p.symbol);
        const longHourly = longInfo ? longInfo.rate / (longInfo.fundingHours ?? getFundingHours(p.longExchange)) : undefined;
        const shortHourly = shortInfo ? shortInfo.rate / (shortInfo.fundingHours ?? getFundingHours(p.shortExchange)) : undefined;
        signedSpread = (longHourly !== undefined && shortHourly !== undefined)
          ? annualizeHourlyRate(shortHourly - longHourly)
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
        const perpSymbol = getPerpSymbol(pos.symbol, perpExchange);
        const rateInfo = findRate(ratesByExchange, perpExchange, perpSymbol)
          ?? findRate(ratesByExchange, perpExchange, pos.symbol);
        if (rateInfo === undefined) continue;
        const fundingH = rateInfo.fundingHours ?? getFundingHours(perpExchange);
        signedSpread = annualizeHourlyRate(rateInfo.rate / fundingH);
      } else {
        const longInfo = findRate(ratesByExchange, pos.longExchange, pos.symbol);
        const shortInfo = findRate(ratesByExchange, pos.shortExchange, pos.symbol);
        if (longInfo === undefined || shortInfo === undefined) continue;
        const longHourly = longInfo.rate / (longInfo.fundingHours ?? getFundingHours(pos.longExchange));
        const shortHourly = shortInfo.rate / (shortInfo.fundingHours ?? getFundingHours(pos.shortExchange));
        signedSpread = annualizeHourlyRate(shortHourly - longHourly);
      }

      // Close if funding flipped (losing money) or spread below close threshold
      const minHoldMs = (params.min_hold_hours ?? 2) * 60 * 60 * 1000;
      const holdTime = pos.entryTime > 0 ? Date.now() - pos.entryTime : Infinity;
      const deeplyNegative = signedSpread < -20; // urgent: losing significant funding
      const shouldClose = deeplyNegative || (holdTime >= minHoldMs && signedSpread < params.close_spread);
      if (shouldClose) {
        if (this.quarantined(pos.symbol, ctx)) {
          ctx.log(`  [ARB] ${pos.symbol} is quarantined — not closing (perp strategy quarantine)`);
          continue;
        }
        // Cooldown: skip if close recently failed for this symbol
        const closeKey = `${pos.symbol}:close`;
        const cooldownUntil = this._failCooldown.get(closeKey) ?? 0;
        if (Date.now() < cooldownUntil) continue;

        const sign = signedSpread >= 0 ? "+" : "";
        ctx.log(`  [ARB] Closing ${pos.symbol}: signed spread ${sign}${signedSpread.toFixed(1)}% (close_spread=${params.close_spread}%, entry=${pos.entrySpread.toFixed(1)}%)`);

        if (pos.mode === "spot-perp") {
          const spotPerpClosed = await this.closeSpotPerp(pos, adapters, ctx);
          if (spotPerpClosed) toClose.push(pos);
        } else {
          const longAdapter = adapters.get(pos.longExchange);
          const shortAdapter = adapters.get(pos.shortExchange);
          if (longAdapter && shortAdapter) {
            const closed = await this.closePerpPerp(pos, longAdapter, shortAdapter, ctx, { signedSpread, stop: false });
            if (closed) toClose.push(pos);
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
    const scanExchangeNames = exchangeNames.filter(n => availableAdapters.has(n));
    const opportunities: ArbOpportunity[] = [];

    const allSymbols = new Set<string>();
    for (const [, map] of ratesByExchange) {
      for (const sym of map.keys()) allSymbols.add(sym);
    }

    // Perp-perp opportunities
    for (const sym of allSymbols) {
      let minHourly = Infinity, maxHourly = -Infinity;
      let minExchange = "", maxExchange = "";
      let minRate = 0, maxRate = 0;

      for (const exName of scanExchangeNames) {
        const rateInfo = findRate(ratesByExchange, exName, sym);
        if (!rateInfo) continue;
        const hourlyRate = rateInfo.rate / (rateInfo.fundingHours ?? getFundingHours(exName));
        if (hourlyRate < minHourly) { minHourly = hourlyRate; minExchange = exName; minRate = rateInfo.rate; }
        if (hourlyRate > maxHourly) { maxHourly = hourlyRate; maxExchange = exName; maxRate = rateInfo.rate; }
      }

      if (minExchange && maxExchange && minExchange !== maxExchange) {
        const spread = annualizeHourlyRate(maxHourly - minHourly);
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
    const perpMarketsCache = new Map<string, Promise<VenueMarket[]>>();
    for (const [name, a] of adapters) {
      if (this._unrecovered.has(name)) continue; // positions not recovered: no entries on this venue
      try {
        const spotAdapter = await getBotSpotAdapter(name, a);
        if (!spotAdapter) continue;

        const perpRates = ratesByExchange.get(name);
        if (!perpRates) continue;

        // Same-venue spot↔perp: canonical symbol + price-deviation guard.
        const spotMarkets = await spotAdapter.getSpotMarkets();
        const matched = await botSpotPerpMatches(name, spotMarkets, [name], perpMarketsCache, (msg) => ctx.log(`  [ARB] ${msg}`));
        const spotSymbols = matched.get(name);
        if (spotSymbols === undefined) throw new Error(`spot↔perp matching returned no entry for ${name}`);

        for (const [sym, rateEntry] of perpRates) {
          const { rate } = rateEntry;
          // Only consider positive funding (shorts receive, longs pay)
          if (rate <= 0) continue;
          const base = sym.replace(/-PERP$/, "").toUpperCase();
          if (!spotSymbols.has(base)) continue;

          const hourlyRate = rate / (rateEntry.fundingHours ?? getFundingHours(name));
          const annualSpread = annualizeHourlyRate(hourlyRate);
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
      } catch (e) {
        // Logged, not swallowed; this venue is skipped for spot-perp this scan.
        ctx.log(`  [ARB] ${name} spot scan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
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
        let skipCooldown = 0;
        const livePositions = new Map<string, Promise<{ symbol: string; size: string }[]>>();
        // Engine: equity unknown → no new entries (closes above still run).
        const entriesBlocked = ctx.state.get("equityUnknown") === true;
        if (entriesBlocked) ctx.log(`  [ARB] Equity unknown — no new entries this tick`);
        for (const best of entriesBlocked ? [] : opportunities) {
          if (openSymbols.has(best.symbol.toUpperCase())) continue;
          if (this.quarantined(best.symbol, ctx)) continue;
          if (await this.heldUntracked(best.symbol, best.mode === "spot-perp" ? [best.shortExchange] : [best.longExchange, best.shortExchange], adapters, ctx, livePositions)) continue;
          this._traded.add(best.symbol.toUpperCase());
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

          const price = findRate(ratesByExchange, best.longExchange, best.symbol)?.price ?? 0;
          if (price <= 0) continue;

          // Determine leverage for this symbol
          const configLeverage = params.leverage ?? 3;
          const leverage = cappedLeverage(configLeverage, [
            { exchange: best.longExchange, maxLeverage: findRate(ratesByExchange, best.longExchange, best.symbol)?.maxLeverage },
            { exchange: best.shortExchange, maxLeverage: findRate(ratesByExchange, best.shortExchange, best.symbol)?.maxLeverage },
          ], ctx.log);

          // Set leverage on both exchanges before ordering
          try {
            await longAdapter.setLeverage(best.symbol, leverage, "cross");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`  [ARB] setLeverage failed on ${best.longExchange} for ${best.symbol}: ${msg}`);
            this._failCooldown.set(`${best.symbol}:entry`, Date.now() + 5 * 60 * 1000);
            continue;
          }
          try {
            await shortAdapter.setLeverage(best.symbol, leverage, "cross");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`  [ARB] setLeverage failed on ${best.shortExchange} for ${best.symbol}: ${msg}`);
            this._failCooldown.set(`${best.symbol}:entry`, Date.now() + 5 * 60 * 1000);
            continue;
          }

          // Balance + margin check (use pre-fetched balances from tick start)
          let targetSizeUsd = params.size_usd;
          const longBal = exchangeBalances.get(best.longExchange);
          const shortBal = exchangeBalances.get(best.shortExchange);
          if (!longBal || !shortBal) continue;
          const minAvail = Math.min(longBal.available, shortBal.available);
          const requiredMarginPerLeg = targetSizeUsd / leverage;
          if (minAvail < requiredMarginPerLeg) {
            // Try reducing size to what's affordable
            const maxAffordableNotional = minAvail * leverage * 0.8;
            if (maxAffordableNotional < 10) {
              ctx.log(`  [ARB] Skip ${best.symbol}: insufficient margin ($${minAvail.toFixed(2)} < $${requiredMarginPerLeg.toFixed(2)} at ${leverage}x)`);
              continue;
            }
            ctx.log(`  [ARB] Size reduced $${targetSizeUsd} → $${maxAffordableNotional.toFixed(0)} (limited by margin $${minAvail.toFixed(2)} at ${leverage}x)`);
            targetSizeUsd = Math.floor(maxAffordableNotional);
          }

          // Liquidity check
          const liq = await checkArbLiquidity(
            longAdapter, shortAdapter, best.symbol, targetSizeUsd, 0.5,
            (msg) => ctx.log(`  ${msg}`),
          );
          if (!liq.viable) continue;

          // Compute matched size (use actual precision from exchange market data)
          const longDec = findRate(ratesByExchange, best.longExchange, best.symbol)?.sizeDecimals;
          const shortDec = findRate(ratesByExchange, best.shortExchange, best.symbol)?.sizeDecimals;
          let matched = computeMatchedSize(liq.adjustedSizeUsd, price, best.longExchange, best.shortExchange, { longSizeDecimals: longDec, shortSizeDecimals: shortDec });
          if (!matched) {
            ctx.log(`  [ARB] Skip ${best.symbol}: can't compute matched size (min notional or precision issue)`);
            continue;
          }

          ctx.log(`  [ARB] Opening: ${matched.size} ${best.symbol} on both legs ($${matched.notional.toFixed(0)}/leg, slippage ~${liq.longSlippage.toFixed(2)}%/${liq.shortSlippage.toFixed(2)}%)`);

          // Step 1: Execute long leg first (verified by the position delta)
          const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
          const sizeDec = sizeDecimalsOf(matched.size);
          let longFilled: number;
          try {
            const lf = await placePerpVerified(longAdapter, best.longExchange, best.symbol, "buy", matched.size);
            longFilled = lf.filledSize;
            logExecution({ type: "arb_entry", exchange: best.longExchange, symbol: best.symbol, side: "buy", size: matched.size, notional: matched.notional / 2, status: "success", dryRun: false, meta: { mode: "perp-perp", leg: "long", response: lf.raw, measuredFill: lf.filledSize } });
          } catch (longErr) {
            const msg = errText(longErr);
            logExecution({ type: "arb_entry", exchange: best.longExchange, symbol: best.symbol, side: "buy", size: matched.size, status: "failed", error: msg, dryRun: false, meta: { mode: "perp-perp", leg: "long", pending: isOutcomeUnknown(longErr) } });
            if (isOutcomeUnknown(longErr)) {
              this.quarantine(best.symbol, `long leg ${matched.size} on ${best.longExchange} outcome unknown (${msg}) — no short placed`, best.longExchange, ctx);
              continue;
            }
            ctx.log(`  [ARB] Long leg failed for ${best.symbol}: ${msg} (cooldown 5m)`);
            this._failCooldown.set(`${best.symbol}:entry`, Date.now() + 5 * 60 * 1000);
            continue;
          }

          // Step 2: Execute short leg sized to the VERIFIED long fill (not the requested size)
          const longOpen = fillSizeString(longFilled, sizeDec);
          let shortFilled: number;
          try {
            const sf = await placePerpVerified(shortAdapter, best.shortExchange, best.symbol, "sell", longOpen);
            shortFilled = sf.filledSize;
            logExecution({ type: "arb_entry", exchange: best.shortExchange, symbol: best.symbol, side: "sell", size: longOpen, notional: matched.notional / 2, status: "success", dryRun: false, meta: { mode: "perp-perp", leg: "short", response: sf.raw, measuredFill: sf.filledSize } });
          } catch (shortErr) {
            const msg = errText(shortErr);
            logExecution({ type: "arb_entry", exchange: best.shortExchange, symbol: best.symbol, side: "sell", size: longOpen, status: "failed", error: msg, dryRun: false, meta: { mode: "perp-perp", leg: "short", pending: isOutcomeUnknown(shortErr) } });
            if (isOutcomeUnknown(shortErr)) {
              // The short may exist: closing the long now could leave a naked short.
              this.quarantine(best.symbol, `short leg ${longOpen} on ${best.shortExchange} outcome unknown (${msg}); long ${longOpen} open on ${best.longExchange} — not rolled back`, `${best.longExchange}/${best.shortExchange}`, ctx);
              continue;
            }
            ctx.log(`  [ARB] Short leg failed for ${best.symbol}: ${msg} — ROLLING BACK long leg (cooldown 5m)`);
            // Rollback: close what the long leg actually filled (reduce-only, verified)
            try {
              const rb = await closePerpVerified(longAdapter, best.longExchange, best.symbol, "sell", longOpen, { decimals: sizeDec });
              if (rb.residual > 0) {
                const rbMsg = `rollback closed ${fillSizeString(rb.closed, sizeDec)} of ${longOpen}; ${fillSizeString(rb.residual, sizeDec)} still open${rb.note !== null ? ` (${rb.note})` : ""}`;
                logExecution({ type: "multi_leg_rollback", exchange: best.longExchange, symbol: best.symbol, side: "sell", size: longOpen, status: "failed", error: rbMsg, dryRun: false });
                this.quarantine(best.symbol, `short leg failed (${msg}); ${rbMsg} — orphaned long on ${best.longExchange}`, best.longExchange, ctx);
                continue;
              }
              ctx.log(`  [ARB] Rollback success: closed long ${longOpen} ${best.symbol} on ${best.longExchange}`);
              logExecution({ type: "multi_leg_rollback", exchange: best.longExchange, symbol: best.symbol, side: "sell", size: longOpen, status: "success", dryRun: false });
            } catch (rbErr) {
              const rbMsg = errText(rbErr);
              logExecution({ type: "multi_leg_rollback", exchange: best.longExchange, symbol: best.symbol, side: "sell", size: longOpen, status: "failed", error: rbMsg, dryRun: false });
              this.quarantine(best.symbol, `short leg failed (${msg}) and the long rollback failed or is unconfirmed (${rbMsg}) — orphaned long ${longOpen} on ${best.longExchange}`, best.longExchange, ctx);
              continue;
            }
            this._failCooldown.set(`${best.symbol}:entry`, Date.now() + 5 * 60 * 1000);
            continue;
          }

          // Step 3: residual — the short filled less than the long: trim the long by exactly
          // this trade's excess (reduce-only, verified). Not trimmed → unhedged → quarantine.
          const hedgedSize = fillSizeString(shortFilled, sizeDec);
          try {
            const trimmed = await trimFirstLegToHedge(longAdapter, best.longExchange, best.symbol, "buy", longFilled, shortFilled, sizeDec);
            if (trimmed !== "0") ctx.log(`  [ARB] Short filled ${hedgedSize} of ${longOpen} — trimmed long by ${trimmed} (reduce-only)`);
          } catch (trimErr) {
            const trimMsg = errText(trimErr);
            logExecution({ type: "multi_leg_rollback", exchange: best.longExchange, symbol: best.symbol, side: "sell", size: fillSizeString(longFilled - shortFilled, sizeDec), status: "failed", error: trimMsg, dryRun: false, meta: { mode: "perp-perp", reason: "residual trim" } });
            this.quarantine(best.symbol, `short filled ${hedgedSize} of ${longOpen}; trimming the long's excess on ${best.longExchange} failed or is unconfirmed (${trimMsg}) — long ${longOpen} vs short ${hedgedSize}`, `${best.longExchange}/${best.shortExchange}`, ctx);
            continue;
          }

          // Track position
          const currentPositions = ctx.state.get("arbOpenPositions") as ArbOpenPosition[];
          currentPositions.push({
            symbol: best.symbol,
            longExchange: best.longExchange,
            shortExchange: best.shortExchange,
            entrySpread: best.spread,
            size: hedgedSize,
            mode: "perp-perp",
            entryTime: Date.now(),
          });
          ctx.state.set("arbOpenPositions", currentPositions);
          ctx.state.set("arbPositions", currentPositions.length);
          ctx.log(`  [ARB] Position opened! (${currentPositions.length}/${params.max_positions})`);
          return [{ type: "noop" }];
        }
        // Log skip summary only when there were skips (avoids noise when nothing happened)
        if (skipCooldown > 0) {
          ctx.log(`  [ARB] Skipped ${skipCooldown} opportunities (${skipCooldown} cooldown)`);
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

    const adapters = new Map<string, ExchangeAdapter>();
    adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
    if (extraAdapters) {
      for (const [name, a] of extraAdapters) adapters.set(name, a);
    }
    for (const p of openPositions ?? []) this._traded.add(p.symbol.toUpperCase());

    if (openPositions && openPositions.length > 0) {
      const remainingPositions: ArbOpenPosition[] = [];
      for (const pos of openPositions) {
        if (this.quarantined(pos.symbol, ctx)) {
          ctx.log(`  [ARB] CRITICAL: ${pos.symbol} is quarantined — left open on stop; resolve manually (perp strategy quarantine)`);
          remainingPositions.push(pos);
          continue;
        }
        if (pos.mode === "spot-perp") {
          const closed = await this.closeSpotPerp(pos, adapters, ctx);
          if (!closed) {
            ctx.log(`  [ARB] CRITICAL: spot-perp ${pos.symbol} could not be fully closed on stop — requires manual cleanup`);
            remainingPositions.push(pos);
          }
        } else {
          const longAdapter = adapters.get(pos.longExchange);
          const shortAdapter = adapters.get(pos.shortExchange);
          if (longAdapter && shortAdapter) {
            ctx.log(`  [ARB] Closing ${pos.symbol} on stop (${pos.size})`);
            const closed = await this.closePerpPerp(pos, longAdapter, shortAdapter, ctx, { signedSpread: null, stop: true });
            if (!closed) {
              ctx.log(`  [ARB] CRITICAL: ${pos.symbol} could not be fully closed on stop — requires manual cleanup`);
              remainingPositions.push(pos);
            }
          } else {
            ctx.log(`  [ARB] CRITICAL: ${pos.symbol} adapters not found on stop — requires manual cleanup`);
            remainingPositions.push(pos);
          }
        }
      }
      ctx.state.set("arbOpenPositions", remainingPositions);
      ctx.state.set("arbPositions", remainingPositions.length);
    }

    // Cancel only the bot's own symbols on each venue it used — never an account-wide cancel
    // (it would cancel the user's manual orders on every market).
    await cancelBotSymbols(adapters, this._traded, "[ARB]", ctx.log);
    return [];
  }

  /**
   * Close a perp-perp position: long then short, both reduce-only and verified by the
   * position delta. Returns true when both legs are closed (or already gone).
   *  - an unknown leg outcome → quarantine (never retried / rolled back blindly);
   *  - long close definitely failed → hedge intact, cooldown; MAX_CLOSE_FAILURES in a row →
   *    quarantine (no endless retry);
   *  - short close definitely failed after THIS call closed the long → quarantine at once
   *    (naked short). The long is never re-opened (a non-reduce-only order that could loop
   *    close → fail → re-open every tick), same as closePerpPairVerified;
   *  - short close failed with the long already gone → one more reduce-only close of the
   *    orphaned short; if that fails → quarantine.
   */
  private async closePerpPerp(
    pos: ArbOpenPosition,
    longAdapter: ExchangeAdapter,
    shortAdapter: ExchangeAdapter,
    ctx: StrategyContext,
    meta: { signedSpread: number | null; stop: boolean },
  ): Promise<boolean> {
    const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
    const venues = `${pos.longExchange}/${pos.shortExchange}`;
    const cooldown = (ms: number) => { if (!meta.stop) this._failCooldown.set(`${pos.symbol}:close`, Date.now() + ms); };

    let closeLongOk = false;
    let longPositionGone = false;
    try {
      const lc = await closePerpVerified(longAdapter, pos.longExchange, pos.symbol, "sell", pos.size);
      if (lc.residual > 0) {
        // Partial close survived one residual close: legs unbalanced → quarantine (short left open).
        logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "failed", error: `closed ${lc.closed}, residual ${lc.residual}`, dryRun: false, meta: { mode: pos.mode, leg: "long", stop: meta.stop } });
        this.quarantine(pos.symbol, `close of long on ${pos.longExchange} closed ${lc.closed} of ${pos.size}, ${lc.residual} still open${lc.note !== null ? ` (${lc.note})` : ""}; short ${pos.size} on ${pos.shortExchange} left open`, venues, ctx);
        return false;
      }
      closeLongOk = true;
      logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "long", stop: meta.stop, signedSpread: meta.signedSpread, measuredClose: lc.closed } });
    } catch (err) {
      const msg = errText(err);
      if (isOutcomeUnknown(err)) {
        this.quarantine(pos.symbol, `close of long ${pos.size} on ${pos.longExchange} outcome unknown (${msg}) — short left open`, venues, ctx);
        return false;
      }
      if (isPositionGone(err)) {
        longPositionGone = true;
        ctx.log(`  [ARB] Long position gone for ${pos.symbol} on ${pos.longExchange} (liquidated?) — closing short`);
        // Cooldown the exchange for 30 minutes to prevent liquidation-entry cycle
        this._failCooldown.set(`${pos.longExchange}:exchange`, Date.now() + 30 * 60 * 1000);
      } else {
        logExecution({ type: "arb_close", exchange: pos.longExchange, symbol: pos.symbol, side: "sell", size: pos.size, status: "failed", error: msg, dryRun: false, meta: { mode: pos.mode, leg: "long", stop: meta.stop } });
        const n = (this._closeFailures.get(pos.symbol) ?? 0) + 1;
        this._closeFailures.set(pos.symbol, n);
        if (n >= MAX_CLOSE_FAILURES) {
          this.quarantine(pos.symbol, `close of long on ${pos.longExchange} failed ${n} times in a row (last: ${msg}) — hedge intact, stopping automatic close attempts`, venues, ctx);
          return false;
        }
        ctx.log(`  [ARB] Close long leg failed for ${pos.symbol}: ${msg} — hedge intact (${n}/${MAX_CLOSE_FAILURES})${meta.stop ? "" : " (cooldown 5m)"}`);
        cooldown(5 * 60 * 1000);
        return false;
      }
    }

    try {
      const sc = await closePerpVerified(shortAdapter, pos.shortExchange, pos.symbol, "buy", pos.size);
      if (sc.residual > 0) {
        logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "failed", error: `closed ${sc.closed}, residual ${sc.residual}`, dryRun: false, meta: { mode: pos.mode, leg: "short", stop: meta.stop } });
        this.quarantine(pos.symbol, `close of short on ${pos.shortExchange} closed ${sc.closed} of ${pos.size}, ${sc.residual} still open${sc.note !== null ? ` (${sc.note})` : ""}${closeLongOk ? "; the long is closed — residual short unhedged" : ""}`, venues, ctx);
        return false;
      }
      logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "success", dryRun: false, meta: { mode: pos.mode, leg: "short", stop: meta.stop, signedSpread: meta.signedSpread, measuredClose: sc.closed } });
    } catch (err) {
      const msg = errText(err);
      if (isOutcomeUnknown(err)) {
        this.quarantine(pos.symbol, `close of short ${pos.size} on ${pos.shortExchange} outcome unknown (${msg})${closeLongOk ? "; the long is closed" : ""}`, venues, ctx);
        return false;
      }
      if (isPositionGone(err)) {
        ctx.log(`  [ARB] Short position also gone for ${pos.symbol} on ${pos.shortExchange} — removing from tracking`);
        this._failCooldown.set(`${pos.shortExchange}:exchange`, Date.now() + 30 * 60 * 1000);
      } else if (closeLongOk) {
        // This call closed the long but the short close definitely failed: the short is naked.
        // Quarantine now — never re-open the long (a non-reduce-only order; close → fail →
        // re-open could repeat every tick). Same as closePerpPairVerified.
        logExecution({ type: "arb_close", exchange: pos.shortExchange, symbol: pos.symbol, side: "buy", size: pos.size, status: "failed", error: msg, dryRun: false, meta: { mode: pos.mode, leg: "short", stop: meta.stop } });
        this.quarantine(pos.symbol, `long closed on ${pos.longExchange}; close of short ${pos.size} on ${pos.shortExchange} failed (${msg}) — naked short`, venues, ctx);
        return false;
      } else {
        // Long already gone and the short close failed: one more reduce-only close of the
        // orphaned short (never a plain order — it must not flip into a long).
        ctx.log(`  [ARB] Closing orphaned short for ${pos.symbol} (reduce-only): ${msg}`);
        try {
          const oc = await closePerpVerified(shortAdapter, pos.shortExchange, pos.symbol, "buy", pos.size);
          if (oc.residual > 0) {
            this.quarantine(pos.symbol, `long gone on ${pos.longExchange}; closing the orphaned short closed ${oc.closed} of ${pos.size}, ${oc.residual} still open${oc.note !== null ? ` (${oc.note})` : ""}`, venues, ctx);
            return false;
          }
          ctx.log(`  [ARB] Closed orphaned short ${pos.size} ${pos.symbol} on ${pos.shortExchange}`);
        } catch (forceErr) {
          const forceMsg = errText(forceErr);
          if (!isPositionGone(forceErr)) {
            this.quarantine(pos.symbol, `long gone on ${pos.longExchange} and closing the orphaned short failed (${forceMsg}) — naked short ${pos.size} on ${pos.shortExchange}`, venues, ctx);
            return false;
          }
        }
      }
    }
    this._closeFailures.delete(pos.symbol);
    ctx.log(`  [ARB] Closed ${pos.symbol} position${longPositionGone ? " (long was liquidated)" : ""}`);
    return true;
  }

  /**
   * Close a spot-perp position via SpotPerpExecutor.closePosition (perp short FIRST,
   * reduce-only and verified; spot sold only after; a perp already gone is detected by
   * the reduce-only rejection, never by selling spot again). Returns true only when
   * fully closed. Unknown / unhedged outcomes quarantine the symbol; a plain failure
   * cools down, and MAX_CLOSE_FAILURES consecutive failures quarantine it — each attempt
   * can trade (perp close → spot sell fail → re-hedge), so it never loops.
   */
  private async closeSpotPerp(
    pos: ArbOpenPosition,
    adapters: Map<string, ExchangeAdapter>,
    ctx: StrategyContext,
  ): Promise<boolean> {
    const exchangeName = pos.longExchange.replace("-spot", "");
    const perpAdapter = adapters.get(pos.shortExchange) ?? adapters.get(exchangeName);
    if (!perpAdapter) {
      ctx.log(`  [ARB] Close spot-perp failed: no adapter for ${pos.shortExchange}`);
      return false;
    }
    const spotAdapter = await getBotSpotAdapter(exchangeName, adapters.get(exchangeName) ?? perpAdapter);
    if (!spotAdapter) {
      ctx.log(`  [ARB] Close spot-perp failed: ${exchangeName} is not a bot spot venue`);
      return false;
    }

    ctx.log(`  [ARB] Closing spot-perp ${pos.symbol} (perp buy reduce-only, then spot sell)`);
    const closed = await this.executor.closePosition({
      symbol: pos.symbol, spotExchange: exchangeName, perpExchange: pos.shortExchange,
      spotAdapter, perpAdapter, size: pos.size, log: ctx.log,
    });
    // The pair in the arb state (`arb status` / `arb close`): removed on a full close, legs set to the remainder on a partial one.
    const pair = { symbol: pos.symbol, spotExchange: exchangeName, perpExchange: pos.shortExchange };
    if (closed.closed) {
      recordSpotPerpClose(spotAdapter, pair, null, "[ARB]", ctx.log);
      this._closeFailures.delete(pos.symbol);
      return true;
    }
    if (closed.manual) {
      this.quarantine(pos.symbol, closed.reason, exchangeName, ctx);
      return false;
    }
    if (closed.remainingSize !== null) {
      // Partial spot sell: the remainder stays a hedged position (state updated in place).
      ctx.log(`  [ARB] Partial close of ${pos.symbol}: ${closed.remainingSize} remains open (spot + perp)`);
      pos.size = closed.remainingSize;
      recordSpotPerpClose(spotAdapter, pair, closed.remainingSize, "[ARB]", ctx.log);
      this._closeFailures.delete(pos.symbol);
      return false;
    }
    const n = (this._closeFailures.get(pos.symbol) ?? 0) + 1;
    this._closeFailures.set(pos.symbol, n);
    if (n >= MAX_CLOSE_FAILURES) {
      this.quarantine(pos.symbol, `spot-perp close failed ${n} times in a row — stopping automatic close attempts`, exchangeName, ctx);
    } else {
      this._failCooldown.set(`${pos.symbol}:close`, Date.now() + 5 * 60 * 1000);
    }
    return false;
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
      const spotAdapter = await getBotSpotAdapter(exchangeName, perpAdapter);
      if (!spotAdapter) {
        ctx.log(`  [ARB] Open spot-perp failed: ${exchangeName} is not a bot spot venue`);
        return false;
      }

      // Determine leverage for perp leg
      const configLeverage = params.leverage ?? 3;
      const perpSymbolUpper = getPerpSymbol(opp.symbol, opp.shortExchange).toUpperCase();
      const perpMaxLev = findRate(ratesByExchange, opp.shortExchange, perpSymbolUpper)?.maxLeverage
        ?? findRate(ratesByExchange, opp.shortExchange, opp.symbol.toUpperCase())?.maxLeverage;
      const leverage = cappedLeverage(configLeverage, [{ exchange: opp.shortExchange, maxLeverage: perpMaxLev }], ctx.log);

      // Set leverage on perp before ordering
      try {
        await perpAdapter.setLeverage(getPerpSymbol(opp.symbol, opp.shortExchange), leverage, "cross");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARB] setLeverage failed on ${opp.shortExchange} for ${opp.symbol}: ${msg}`);
        return false;
      }

      // Balance check: spot needs full notional, perp needs sizeUsd / leverage margin
      let targetSizeUsd = params.size_usd;
      try {
        const perpBal = await perpAdapter.getBalance();

        // Check margin usage
        const perpEquity = parseFloat(perpBal.equity);
        const perpMarginPct = perpEquity > 0 ? parseFloat(perpBal.marginUsed) / perpEquity * 100 : 0;
        if (perpMarginPct > 90) {
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`  [ARB] Balance check failed for spot-perp ${opp.symbol}: ${msg}`);
        return false;
      }

      const perpSymbol = getPerpSymbol(opp.symbol, opp.shortExchange);
      let priceEstimate: number | null;
      try {
        priceEstimate = await getPriceEstimate(perpAdapter, perpSymbol, opp.symbol);
      } catch (err) {
        ctx.log(`  [ARB] Skip spot-perp ${opp.symbol}: market read failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      if (priceEstimate === null) {
        ctx.log(`  [ARB] Skip spot-perp ${opp.symbol}: no positive mark price on ${opp.shortExchange}`);
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

      // Lot steps from the venue market info: the hedge is floored to the perp lot and fills are
      // judged with a half-lot tolerance. Unknown → skip before any transfer / order (Rule #2).
      let perpStep: string;
      let spotStep: string;
      try {
        perpStep = await lotStepOf(perpAdapter, perpSymbol);
        spotStep = await spotLotStepOf(spotAdapter, opp.symbol);
      } catch (err) {
        ctx.log(`  [ARB] Skip spot-perp ${opp.symbol}: lot step unknown (${err instanceof Error ? err.message : String(err)})`);
        return false;
      }

      ctx.log(`  [ARB] Opening spot-perp: ${matched.size} ${opp.symbol} ($${matched.notional.toFixed(0)}, slippage ~${liq.spotSlippage.toFixed(2)}%/${liq.perpSlippage.toFixed(2)}%)`);

      // Step 1: Transfer USDC to spot
      const transferAmt = Math.ceil(matched.notional * 1.02); // slight buffer for price movement
      if (await transferUsdcToSpot(spotAdapter, transferAmt)) ctx.log(`  [ARB] Transferred $${transferAmt} to spot`);

      // Step 2: Buy spot — the hedge is sized to what actually filled.
      let hedgeSize: string;
      let spotFill: { filledSize: number; avgPrice: number | null };
      try {
        const fill = await spotMarketFill(spotAdapter, opp.symbol, "buy", matched.size, spotStep);
        spotFill = fill;
        hedgeSize = floorToStep(fill.filledSize, perpStep);
        ctx.log(`  [ARB] Bought spot ${fill.filledSize}${fill.status === "partial" ? ` of ${matched.size} (partial)` : ""} ${opp.symbol}`);
        logExecution({ type: "arb_entry", exchange: opp.longExchange, symbol: opp.symbol, side: "buy", size: String(fill.filledSize), notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "spot", fillStatus: fill.status, requestedSize: matched.size, response: fill.raw } });
      } catch (spotErr) {
        const msg = spotErr instanceof Error ? spotErr.message : String(spotErr);
        const pending = spotErr instanceof PerpError && spotErr.structured.code === "ORDER_PENDING";
        ctx.log(`  [ARB] Open spot-perp failed (spot buy) for ${opp.symbol}: ${msg}`);
        logExecution({ type: "arb_entry", exchange: opp.longExchange, symbol: opp.symbol, side: "buy", size: matched.size, status: "failed", error: msg, dryRun: false, meta: { mode: "spot-perp", leg: "spot", pending } });
        if (pending) {
          // Outcome unknown: the quote may already be spent — do not move funds or retry.
          this.quarantine(opp.symbol, `spot buy ${matched.size} on ${exchangeName} is PENDING (not confirmed) — no perp hedge placed, $${transferAmt} left in spot (${msg})`, exchangeName, ctx);
          return false;
        }
        try {
          if (await transferUsdcToPerp(spotAdapter, transferAmt)) ctx.log(`  [ARB] Transferred $${transferAmt} back to perp after spot buy failure`);
        } catch (xferErr) {
          ctx.log(`  [ARB] WARNING: $${transferAmt} left in ${exchangeName} spot — transfer back to perp failed: ${xferErr instanceof Error ? xferErr.message : String(xferErr)}`);
        }
        return false;
      }
      if (!(Number(hedgeSize) > 0)) {
        this.quarantine(opp.symbol, `spot buy filled only dust (below one perp lot ${perpStep}) — unhedged spot remains on ${exchangeName}; no perp short placed`, exchangeName, ctx);
        return false;
      }

      // Step 3: Short perp (filled spot size only), verified by the position delta
      let shortHedged = hedgeSize;
      let perpEntryPrice: number | null;
      try {
        const pf = await placePerpVerified(perpAdapter, opp.shortExchange, perpSymbol, "sell", hedgeSize, { stepSize: perpStep });
        shortHedged = floorToStep(pf.filledSize, perpStep);
        // The venue-reported average fill of the short (null = not reported, never the protection price).
        const avg = reportedAvgFillPrice(pf.raw);
        perpEntryPrice = avg === null ? null : Number(avg);
        if (Number(shortHedged) < Number(hedgeSize)) {
          // Accepted partial fill (≥ 80% measured, or a venue-final partial IOC fill): spot exceeds the short — never resubmit, quarantine the residual.
          this.quarantine(opp.symbol, `perp short filled ${shortHedged} of ${hedgeSize} on ${opp.shortExchange}; spot ${hedgeSize} held on ${exchangeName} — ${floorToStep(Number(hedgeSize) - Number(shortHedged), perpStep)} spot unhedged`, exchangeName, ctx);
        }
        ctx.log(`  [ARB] Shorted perp ${shortHedged} ${perpSymbol}`);
        logExecution({ type: "arb_entry", exchange: opp.shortExchange, symbol: opp.symbol, side: "sell", size: hedgeSize, notional: matched.notional, status: "success", dryRun: false, meta: { mode: "spot-perp", leg: "perp", response: pf.raw, measuredFill: pf.filledSize } });
      } catch (perpErr) {
        const msg = perpErr instanceof Error ? perpErr.message : String(perpErr);
        logExecution({ type: "arb_entry", exchange: opp.shortExchange, symbol: opp.symbol, side: "sell", size: hedgeSize, status: "failed", error: msg, dryRun: false, meta: { mode: "spot-perp", leg: "perp", pending: isOutcomeUnknown(perpErr) } });
        if (isOutcomeUnknown(perpErr)) {
          // The short may exist: selling the spot back could leave a naked short.
          this.quarantine(opp.symbol, `perp short ${hedgeSize} on ${opp.shortExchange} outcome unknown (${msg}); ${hedgeSize} spot held on ${exchangeName} — not rolled back`, exchangeName, ctx);
          return false;
        }
        ctx.log(`  [ARB] Open spot-perp failed (perp short) for ${opp.symbol}: ${msg} — ROLLING BACK spot buy`);
        // Rollback: sell spot back, then sweep ONLY this sale's proceeds back to perp
        // (quote above the pre-sale balance, capped at what this entry transferred in).
        let preSaleQuote: number | null;
        try {
          preSaleQuote = await readSpotQuoteAvailableFresh(spotAdapter);
        } catch (qErr) {
          preSaleQuote = null;
          ctx.log(`  [ARB] WARNING: ${exchangeName} spot quote unreadable before the rollback sale (${qErr instanceof Error ? qErr.message : String(qErr)}) — proceeds will stay in spot`);
        }
        try {
          const rb = await spotMarketFill(spotAdapter, opp.symbol, "sell", hedgeSize, spotStep);
          ctx.log(`  [ARB] Rollback ${rb.status === "partial" ? "PARTIAL" : "success"}: sold spot ${rb.filledSize} of ${hedgeSize} ${opp.symbol}`);
          if (rb.status === "partial") this.quarantine(opp.symbol, `entry rollback sold only ${rb.filledSize} of ${hedgeSize} — unhedged spot remains on ${exchangeName}`, exchangeName, ctx);
          logExecution({ type: "multi_leg_rollback", exchange: opp.longExchange, symbol: opp.symbol, side: "sell", size: String(rb.filledSize), status: rb.status === "partial" ? "failed" : "success", dryRun: false });
          if (preSaleQuote !== null) {
            try {
              const moved = await sweepSpotQuoteToPerp(spotAdapter, 1, { keep: preSaleQuote, max: transferAmt });
              if (moved > 0) ctx.log(`  [ARB] Transferred rollback proceeds $${moved} back to perp (unspent transfer buffer stays in ${exchangeName} spot)`);
            } catch (xferErr) {
              ctx.log(`  [ARB] WARNING: rollback proceeds left in ${exchangeName} spot — transfer back to perp failed: ${xferErr instanceof Error ? xferErr.message : String(xferErr)}`);
            }
          }
        } catch (rbErr) {
          const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
          ctx.log(`  [ARB] CRITICAL: Spot rollback failed for ${opp.symbol}: ${rbMsg}`);
          this.quarantine(opp.symbol, `perp short failed and the spot rollback sell failed (${rbMsg}) — unhedged spot ${hedgeSize} remains on ${exchangeName}`, exchangeName, ctx);
          logExecution({ type: "multi_leg_rollback", exchange: opp.longExchange, symbol: opp.symbol, side: "sell", size: matched.size, status: "failed", error: rbMsg, dryRun: false });
        }
        return false;
      }

      // Track position
      const currentPositions = ctx.state.get("arbOpenPositions") as ArbOpenPosition[];
      const entryTime = Date.now();
      currentPositions.push({
        symbol: opp.symbol,
        longExchange: opp.longExchange,
        shortExchange: opp.shortExchange,
        entrySpread: opp.spread,
        size: shortHedged,
        mode: "spot-perp",
        entryTime,
      });
      // Recorded in the arb state with the actual legs, so `arb status` confirms it and `arb close` finds it.
      recordSpotPerpEntry(spotAdapter, {
        id: genPosId(), symbol: opp.symbol, spotExchange: exchangeName, perpExchange: opp.shortExchange,
        entryTime, entrySpread: opp.spread,
        spotSize: spotFill.filledSize, perpSize: Number(shortHedged),
        spotAvgPrice: spotFill.avgPrice, perpEntryPrice,
      }, "[ARB]", ctx.log);
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

}

registerStrategy("funding-arb", (_config) => new FundingArbStrategy());
