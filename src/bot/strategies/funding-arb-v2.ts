import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import { registerStrategy } from "../strategy-registry.js";
import { isQuarantined, quarantineKey, quarantineSymbol } from "../quarantine.js";
import { PerpError } from "../../errors.js";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified, trimFirstLegToHedge } from "../perp-order.js";
import { fillSizeString, sizeDecimalsOf } from "../../exchanges/spot-result.js";
import { isPositionGone, assertFundingArbLegs, cancelBotSymbols } from "./funding-arb-utils.js";

/**
 * Enhanced funding rate arbitrage (multi-exchange) v2 — the LIVE "funding-arb-v2"
 * strategy (registered by src/bot/engine.ts).
 * Auto-scans all available exchanges for funding rate divergence.
 * Position management: tracks entry spread, auto-closes when spread converges.
 *
 * Execution safety:
 *  - legs are placed one at a time and verified by the position delta
 *    (placePerpVerified); the short is sized to the long's VERIFIED fill, and a short
 *    that fills less trims the long by this trade's excess (reduce-only, verified);
 *    a definite short failure rolls the long back reduce-only;
 *  - every close is reduce-only with the size actually opened (never re-derived from
 *    the current price), so a retry can never open or flip a position;
 *  - an unknown leg outcome, a failed rollback, repeated close failures, or a position
 *    still open when the bot stops → the symbol is quarantined (persisted, global);
 *  - quarantined symbols are skipped for entry and close.
 */

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  entrySpread: number; // annualized spread at entry
  entryTime: number;
  sizeUsd: number;
  /** Base size opened on each leg (decimal string) — closes use exactly this, reduce-only. */
  size: string;
  /** Long leg already closed by an earlier attempt (only the short remains). */
  longClosed: boolean;
  /** Consecutive failed close attempts. */
  closeFailures: number;
}

/** Consecutive failed closes before the symbol is quarantined. */
const MAX_CLOSE_FAILURES = 3;

export class FundingArbV2Strategy implements Strategy {
  readonly name = "funding-arb-v2";

  private _config: Record<string, unknown> = {};
  /** Symbols this bot entered or recovered this run — the only symbols its stop cancels orders on. */
  private _traded = new Set<string>();

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
    assertFundingArbLegs(ctx);
    this._config = ctx.config;
    // A restart must never re-enter (or ignore) what is already held: rebuild the pairs from the venues.
    const recovered = await this.recoverPositions(this.getAdapters(ctx), ctx);
    for (const p of recovered) this._traded.add(p.symbol);
    ctx.state.set("positions", recovered);
    ctx.state.set("lastScan", 0);
    if (recovered.length > 0) ctx.log(`  [ARB-V2] Recovered ${recovered.length} pair(s): ${recovered.map(p => `${p.symbol} ${p.longExchange}↔${p.shortExchange} ${p.size}`).join(", ")}`);
    ctx.log(`  [ARB-V2] Ready | minSpread=${this.minSpread}% closeSpread=${this.closeSpread}% maxPos=${this.maxPositions} size=$${this.sizeUsd}`);
  }

  /**
   * Pairs held on the venues: a long on one venue + a short of the same symbol and EXACTLY the
   * same size on another. A single leg or a size-mismatched long/short is quarantined (both
   * sizes recorded) — never tracked, never stacked on. A venue whose positions cannot be read
   * throws (the start fails and is retried): unknown exposure is never "flat".
   */
  private async recoverPositions(adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext): Promise<ArbPosition[]> {
    const legs: { venue: string; symbol: string; side: string; size: number; raw: string }[] = [];
    for (const [venue, a] of adapters) {
      let list: Awaited<ReturnType<ExchangeAdapter["getPositions"]>>;
      try {
        list = await a.getPositions();
      } catch (e) {
        throw new PerpError("EXCHANGE_ERROR", `[ARB-V2] ${venue} positions unreadable at start (${e instanceof Error ? e.message : String(e)}) — not started (held pairs unknown)`, {
          exchange: venue, remediation: `Check ${venue} connectivity (perp -e ${venue} account positions); the bot retries the start`,
        });
      }
      for (const p of list) {
        const size = Math.abs(Number(p.size));
        if (size > 0) legs.push({ venue, symbol: p.symbol.toUpperCase(), side: p.side, size, raw: p.size.replace(/^-/, "") });
      }
    }
    const used = new Set<(typeof legs)[number]>();
    const out: ArbPosition[] = [];
    for (const l of legs) {
      if (l.side !== "long" || used.has(l)) continue;
      const s = legs.find(x => !used.has(x) && x.side === "short" && x.symbol === l.symbol && x.venue !== l.venue && x.size === l.size);
      if (s === undefined) continue;
      used.add(l); used.add(s);
      out.push({ symbol: l.symbol, longExchange: l.venue, shortExchange: s.venue, entrySpread: 0, entryTime: 0, sizeUsd: 0, size: l.raw, longClosed: false, closeFailures: 0 });
    }
    const leftover = new Map<string, (typeof legs)[number][]>();
    for (const l of legs) if (!used.has(l)) leftover.set(quarantineKey(l.symbol), [...(leftover.get(quarantineKey(l.symbol)) ?? []), l]);
    for (const [key, group] of leftover) {
      if (isQuarantined(key, ctx.log)) continue;
      const desc = group.map(l => `${l.side} ${l.raw} on ${l.venue}`).join(", ");
      const venues = [...new Set(group.map(l => l.venue))];
      const mismatched = group.some(l => l.side === "long") && group.some(l => l.side === "short");
      quarantineSymbol(this.name, key,
        mismatched ? `recovery: ${key} long/short sizes do not match (${desc}) — not tracked as a pair` : `recovery: unpaired ${key} perp leg (${desc}) — no hedge found, not tracked`,
        `Check ${key} on ${venues.join(" and ")} (${venues.map(v => `perp -e ${v} positions`).join("; ")}); close or re-hedge by hand, then: perp strategy quarantine-clear ${key}`,
        ctx.log);
    }
    return out;
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
      } catch (err) {
        // Logged; this venue is left out of this scan (no close decision, no entry on it).
        ctx.log(`  [ARB-V2] ${name} markets unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Phase 1: Check existing positions for auto-close
    const toClose: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      if (isQuarantined(pos.symbol, ctx.log)) continue;
      const longRates = ratesByExchange.get(pos.longExchange);
      const shortRates = ratesByExchange.get(pos.shortExchange);
      if (!longRates || !shortRates) continue;

      const longInfo = longRates.get(pos.symbol);
      const shortInfo = shortRates.get(pos.symbol);
      if (!longInfo || !shortInfo) continue;

      const currentSpread = this.annualizeSpread(shortInfo.rate, longInfo.rate);

      if (currentSpread <= this.closeSpread) {
        ctx.log(`  [ARB-V2] Auto-close ${pos.symbol}: spread ${currentSpread.toFixed(1)}% <= ${this.closeSpread}% (entry was ${pos.entrySpread.toFixed(1)}%)`);
        if (await this.closePosition(ctx, pos, adapters)) toClose.push(i);
      }
    }

    // Remove closed positions (reverse order to preserve indices)
    for (let i = toClose.length - 1; i >= 0; i--) {
      positions.splice(toClose[i], 1);
    }
    ctx.state.set("positions", positions);

    // Phase 2: Scan for new opportunities
    if (positions.length >= this.maxPositions) return [];
    // Engine: equity unknown → no new entries (the closes above still ran).
    if (ctx.state.get("equityUnknown") === true) {
      ctx.log(`  [ARB-V2] Equity unknown — no new entries this scan`);
      return positions.length > 0 ? [{ type: "noop" }] : [];
    }

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
      if (isQuarantined(sym, ctx.log)) continue;

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

    const live = new Map<string, Promise<{ symbol: string; size: string }[]>>();
    for (const opp of toOpen) {
      const longAdapter = adapters.get(opp.longExchange);
      const shortAdapter = adapters.get(opp.shortExchange);
      if (!longAdapter || !shortAdapter || opp.price <= 0) continue;
      if (await this.heldUntracked(opp.symbol, [[opp.longExchange, longAdapter], [opp.shortExchange, shortAdapter]], live, ctx)) continue;
      this._traded.add(opp.symbol);

      const size = (this.sizeUsd / opp.price).toFixed(6);
      ctx.log(`  [ARB-V2] Opening ${opp.symbol}: spread ${opp.spread.toFixed(1)}% (long ${opp.longExchange}, short ${opp.shortExchange})`);
      const opened = await this.openPosition(ctx, opp, size, longAdapter, shortAdapter);
      if (opened !== null) {
        positions.push({
          symbol: opp.symbol,
          longExchange: opp.longExchange,
          shortExchange: opp.shortExchange,
          entrySpread: opp.spread,
          entryTime: now,
          sizeUsd: this.sizeUsd,
          size: opened,
          longClosed: false,
          closeFailures: 0,
        });
        ctx.log(`  [ARB-V2] Position opened! (${positions.length}/${this.maxPositions})`);
      }
    }

    ctx.state.set("positions", positions);

    // Return noop — arb executes directly via multi-adapter coordination
    return positions.length > 0 || toOpen.length > 0 ? [{ type: "noop" }] : [];
  }

  /**
   * Close every tracked position (reduce-only, verified). A position that cannot be
   * closed is never dropped silently: it is quarantined (persisted with what is open)
   * so no bot / arb path touches it until a human resolves it.
   */
  async onStop(ctx: StrategyContext): Promise<StrategyAction[]> {
    const positions = ctx.state.get("positions") as ArbPosition[];
    const adapters = this.getAdapters(ctx);
    const remaining: ArbPosition[] = [];
    for (const pos of positions) {
      if (isQuarantined(pos.symbol, ctx.log)) {
        ctx.log(`  [ARB-V2] CRITICAL: ${pos.symbol} is quarantined — left open on stop; resolve manually (perp strategy quarantine)`);
        remaining.push(pos);
        continue;
      }
      ctx.log(`  [ARB-V2] Closing ${pos.symbol} on stop (${pos.size})`);
      if (!(await this.closePosition(ctx, pos, adapters))) {
        remaining.push(pos);
        if (!isQuarantined(pos.symbol, ctx.log)) {
          this.quarantine(pos, `still open when the bot stopped (long ${pos.longClosed ? "closed" : `${pos.size} on ${pos.longExchange}`}, short ${pos.size} on ${pos.shortExchange})`, ctx);
        }
      }
    }
    ctx.state.set("positions", remaining);
    // Only the bot's own symbols, on each venue it used — never an account-wide cancel.
    await cancelBotSymbols(adapters, this._traded, "[ARB-V2]", ctx.log);
    return [];
  }

  /** A live position of `symbol` on one of the venues that the bot does not track (or an unreadable venue): no entry on top of it. */
  private async heldUntracked(symbol: string, venues: [string, ExchangeAdapter][], cache: Map<string, Promise<{ symbol: string; size: string }[]>>, ctx: StrategyContext): Promise<boolean> {
    const key = quarantineKey(symbol);
    for (const [v, a] of venues) {
      if (!cache.has(v)) cache.set(v, a.getPositions());
      let list: { symbol: string; size: string }[];
      try {
        list = await cache.get(v)!;
      } catch (e) {
        ctx.log(`  [ARB-V2] Skip ${symbol}: ${v} positions unreadable (${e instanceof Error ? e.message : String(e)}) — no entry on unknown exposure`);
        return true;
      }
      if (list.some(p => quarantineKey(p.symbol) === key && Number(p.size) !== 0)) {
        ctx.log(`  [ARB-V2] Skip ${symbol}: a ${symbol} position on ${v} is not one of the bot's pairs — no entry on top of it`);
        return true;
      }
    }
    return false;
  }

  private quarantine(pos: { symbol: string; longExchange: string; shortExchange: string }, reason: string, ctx: StrategyContext): void {
    quarantineSymbol(this.name, pos.symbol, reason,
      `Check ${pos.symbol} on ${pos.longExchange} and ${pos.shortExchange} (perp -e ${pos.longExchange} positions; perp -e ${pos.shortExchange} positions); close or re-hedge by hand, then: perp strategy quarantine-clear ${pos.symbol}`,
      ctx.log);
  }

  /**
   * Long then short, each verified; the short is sized to the long's verified fill and
   * any excess the short did not cover is trimmed off the long (reduce-only, verified).
   * A definite short failure rolls the long back reduce-only. Returns the hedged size
   * (both legs), or null when nothing is open / the symbol was quarantined.
   */
  private async openPosition(
    ctx: StrategyContext,
    opp: { symbol: string; longExchange: string; shortExchange: string },
    size: string,
    longAdapter: ExchangeAdapter,
    shortAdapter: ExchangeAdapter,
  ): Promise<string | null> {
    const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
    const dec = sizeDecimalsOf(size);
    let longFilled: number;
    try {
      longFilled = (await placePerpVerified(longAdapter, opp.longExchange, opp.symbol, "buy", size)).filledSize;
    } catch (err) {
      if (isOutcomeUnknown(err)) this.quarantine(opp, `long leg ${size} on ${opp.longExchange} outcome unknown (${errText(err)}) — no short placed`, ctx);
      else ctx.log(`  [ARB-V2] Execution failed (long leg): ${errText(err)}`);
      return null;
    }
    const longOpen = fillSizeString(longFilled, dec);
    let shortFilled: number;
    try {
      shortFilled = (await placePerpVerified(shortAdapter, opp.shortExchange, opp.symbol, "sell", longOpen)).filledSize;
    } catch (err) {
      const msg = errText(err);
      if (isOutcomeUnknown(err)) {
        // The short may exist: closing the long could leave a naked short.
        this.quarantine(opp, `short leg ${longOpen} on ${opp.shortExchange} outcome unknown (${msg}); long ${longOpen} open on ${opp.longExchange} — not rolled back`, ctx);
        return null;
      }
      ctx.log(`  [ARB-V2] Execution failed (short leg): ${msg} — rolling back the long (reduce-only)`);
      try {
        const rb = await closePerpVerified(longAdapter, opp.longExchange, opp.symbol, "sell", longOpen, { decimals: dec });
        if (rb.residual > 0) {
          this.quarantine(opp, `short leg failed (${msg}); the long rollback closed ${fillSizeString(rb.closed, dec)} of ${longOpen}, ${fillSizeString(rb.residual, dec)} still open${rb.note !== null ? ` (${rb.note})` : ""} — orphaned long on ${opp.longExchange}`, ctx);
          return null;
        }
        ctx.log(`  [ARB-V2] Rollback OK: closed long ${longOpen} ${opp.symbol} on ${opp.longExchange}`);
      } catch (rbErr) {
        this.quarantine(opp, `short leg failed (${msg}) and the long rollback failed or is unconfirmed (${errText(rbErr)}) — orphaned long ${longOpen} on ${opp.longExchange}`, ctx);
      }
      return null;
    }
    const hedged = fillSizeString(shortFilled, dec);
    try {
      const trimmed = await trimFirstLegToHedge(longAdapter, opp.longExchange, opp.symbol, "buy", longFilled, shortFilled, dec);
      if (trimmed !== "0") ctx.log(`  [ARB-V2] Short filled ${hedged} of ${longOpen} — trimmed long by ${trimmed} (reduce-only)`);
    } catch (trimErr) {
      this.quarantine(opp, `short filled ${hedged} of ${longOpen}; trimming the long's excess on ${opp.longExchange} failed or is unconfirmed (${errText(trimErr)}) — long ${longOpen} vs short ${hedged}`, ctx);
      return null;
    }
    return hedged;
  }

  /**
   * Close both legs reduce-only with the opened size, verified. Reduce-only makes a
   * retry safe (a leg already flat is rejected, never re-opened), so a definite failure
   * of the LONG close keeps the (still hedged) position for the next tick; MAX_CLOSE_FAILURES
   * in a row, an unknown outcome, or a short close that definitely failed once the long is
   * closed (naked short) quarantines it. Returns true when both legs are flat.
   */
  private async closePosition(ctx: StrategyContext, pos: ArbPosition, adapters: Map<string, ExchangeAdapter>): Promise<boolean> {
    const longAdapter = adapters.get(pos.longExchange);
    const shortAdapter = adapters.get(pos.shortExchange);
    if (!longAdapter || !shortAdapter) {
      ctx.log(`  [ARB-V2] Close ${pos.symbol}: adapter missing (${pos.longExchange}/${pos.shortExchange})`);
      return false;
    }
    const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
    const failed = (why: string): boolean => {
      pos.closeFailures++;
      ctx.log(`  [ARB-V2] Close failed for ${pos.symbol}: ${why} (${pos.closeFailures}/${MAX_CLOSE_FAILURES})`);
      if (pos.closeFailures >= MAX_CLOSE_FAILURES) this.quarantine(pos, `close failed ${pos.closeFailures} times in a row (last: ${why})`, ctx);
      return false;
    };

    if (!pos.longClosed) {
      try {
        const lc = await closePerpVerified(longAdapter, pos.longExchange, pos.symbol, "sell", pos.size);
        if (lc.residual > 0) {
          this.quarantine(pos, `close of long on ${pos.longExchange} closed ${lc.closed} of ${pos.size}, ${lc.residual} still open${lc.note !== null ? ` (${lc.note})` : ""}; short ${pos.size} on ${pos.shortExchange} not closed`, ctx);
          return false;
        }
        pos.longClosed = true;
      } catch (err) {
        const msg = errText(err);
        if (isOutcomeUnknown(err)) {
          this.quarantine(pos, `close of long ${pos.size} on ${pos.longExchange} outcome unknown (${msg})`, ctx);
          return false;
        }
        if (!isPositionGone(err)) return failed(`long leg: ${msg}`);
        pos.longClosed = true; // already flat
      }
    }
    try {
      const sc = await closePerpVerified(shortAdapter, pos.shortExchange, pos.symbol, "buy", pos.size);
      if (sc.residual > 0) {
        this.quarantine(pos, `the long is closed; close of short on ${pos.shortExchange} closed ${sc.closed} of ${pos.size}, ${sc.residual} still open${sc.note !== null ? ` (${sc.note})` : ""} — residual short unhedged`, ctx);
        return false;
      }
    } catch (err) {
      const msg = errText(err);
      if (isOutcomeUnknown(err)) {
        this.quarantine(pos, `close of short ${pos.size} on ${pos.shortExchange} outcome unknown (${msg}); the long is closed`, ctx);
        return false;
      }
      if (!isPositionGone(err)) {
        // The long is closed, so the short is naked: quarantine NOW — never carry a naked
        // short across ticks waiting for MAX_CLOSE_FAILURES.
        this.quarantine(pos, `long closed on ${pos.longExchange}; close of short ${pos.size} on ${pos.shortExchange} failed (${msg}) — naked short`, ctx);
        return false;
      }
    }
    ctx.log(`  [ARB-V2] Closed ${pos.symbol} (long ${pos.longExchange}, short ${pos.shortExchange})`);
    return true;
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
