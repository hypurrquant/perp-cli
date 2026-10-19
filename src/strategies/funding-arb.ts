import { assertCanClosePositions } from "../exchanges/trading-v2.js";
import { MAX_PRICE_DEVIATION_PCT, type ExchangeAdapter } from "../exchanges/index.js";
import { symbolMatch } from "../utils.js";
import { logExecution } from "../execution-log.js";
import { updateJobState } from "../jobs.js";
import { invalidateCache } from "../cache.js";
import { fetchBalancesWithFailures, computeRebalancePlan, hasEnoughBalance, marketLeverageOf, requiredArbMargin, type ExchangeBalanceSnapshot } from "../rebalance.js";
import { checkArbLiquidity } from "../liquidity.js";
import { computeAnnualSpread, getFundingHours, toHourlyRate } from "../funding.js";
import { fetchVenuesRates } from "../funding/rates.js";
import { getVenue } from "../exchanges/venue.js";
import { sharedApiNetwork } from "../api/public/urls.js";
import { computeMatchedSize } from "../arb-sizing.js";
import { closePerpPairVerified, openPerpPairVerified } from "../commands/arb-auto.js";
import { closePerpVerified, isOutcomeUnknown, rejectedLotSize } from "../bot/perp-order.js";
import { isQuarantined, quarantineSymbol } from "../bot/quarantine.js";
import { isPositionGone, matchSymbol } from "../bot/strategies/funding-arb-utils.js";

/** Quarantine source for `perp strategy funding-arb` (src/bot/quarantine.ts). */
const SOURCE = "funding-arb-cli";


/** The market's published size decimals on `adapter` (null = not published / market not listed). */
async function sizeDecimalsOf(adapter: ExchangeAdapter, symbol: string): Promise<number | null> {
  const m = (await adapter.getMarkets()).find((x) => symbolMatch(x.symbol, symbol));
  return m === undefined ? null : m.sizeDecimals;
}

export interface FundingArbParams {
  minSpread: number;       // minimum annual spread % to trigger entry
  closeSpread: number;     // close when annual spread drops below this %
  size: string;            // position size per leg (base amount)
  sizeUsd?: number;        // position size in USD (alternative to base amount)
  symbols?: string[];      // filter symbols (empty = all)
  intervalSec: number;     // check interval in seconds
  autoExecute: boolean;    // actually place trades or just monitor
  maxPositions?: number;   // max simultaneous arb positions, default 3
  autoRebalance?: boolean; // auto-rebalance when one exchange runs low
  rebalanceThreshold?: number; // trigger rebalance when available < this USD
  maxDrawdown?: number;    // close all if total uPnL exceeds this negative USD
}

interface FundingRate {
  exchange: string;
  /** Canonical key (rows of one asset group under it). */
  symbol: string;
  /** The venue's own symbol (orders / positions use it: Hyperliquid kPEPE, Lighter 1000PEPE). */
  venueSymbol: string;
  fundingRate: number;
  markPrice: number;
}

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  size: string;
  entrySpread: number;
  openedAt: number;
  entryPrices: { long: number; short: number };
  /** Venue symbols of the legs (= `symbol` when the venues use the canonical key). */
  longSymbol: string;
  shortSymbol: string;
}

async function fetchAllRates(): Promise<FundingRate[]> {
  // The SAME rate rows as `arb scan --rates` (fetchVenuesRates): one per venue and canonical
  // symbol (unclassified / ambiguous tickers have no canonical and never pair). Each venue is
  // independent; a failed one is reported on stderr (explicit, never silent).
  const venues = ["pacifica", "hyperliquid", "lighter"].map(id => getVenue(id));
  const { rates, exchangeErrors } = await fetchVenuesRates(venues, sharedApiNetwork(), false);
  for (const [ex, msg] of Object.entries(exchangeErrors)) process.stderr.write(`[funding-arb] ${ex}: funding rates unavailable — ${msg}\n`);
  // computeAnnualSpread / toHourlyRate normalize with the venue's basis: keep each rate in it.
  return rates.map(r => ({ exchange: r.exchange, symbol: r.canonical, venueSymbol: r.symbol, fundingRate: r.hourlyRate * getFundingHours(r.exchange), markPrice: r.markPrice }));
}

// annualize: use computeAnnualSpread from funding.ts for cross-exchange comparison

/**
 * `perp strategy funding-arb` loop. With autoExecute:
 *  - entry = openPerpPairVerified (long, then the short sized to the long's VERIFIED fill;
 *    definite short failure → reduce-only rollback; unknown outcome → quarantine). A lot-size
 *    rejection is never resubmitted blindly: the long is re-sized only when it was definitely
 *    not placed; a rejected short is placed once at the lot-floored verified long fill;
 *  - close / max-drawdown close = closePerpPairVerified with the venue position size strings
 *    (reduce-only, verified, one residual close, quarantine on unknown / unhedged);
 *  - quarantined symbols (src/bot/quarantine.ts) are never entered or closed.
 */

export async function runFundingArb(
  adapters: Map<string, ExchangeAdapter>,
  params: FundingArbParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<void> {
  for (const a of adapters.values()) assertCanClosePositions(a, `Funding arb on ${a.name}`);
  const maxPos = params.maxPositions ?? 3;
  const closeSpread = params.closeSpread ?? 5;
  const positions: ArbPosition[] = [];
  let cycleCount = 0;
  let lastRebalanceCheck = 0;

  let running = true;
  const shutdown = () => { running = false; log(`[ARB] Shutdown signal received, finishing current cycle...`); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`[ARB] Funding rate arbitrage started`);
  log(`[ARB] Entry spread: >= ${params.minSpread}% | Close spread: <= ${closeSpread}%`);
  log(`[ARB] Size: ${params.size} | Interval: ${params.intervalSec}s`);
  log(`[ARB] Auto-execute: ${params.autoExecute} | Max positions: ${maxPos}`);
  log(`[ARB] Exchanges: ${[...adapters.keys()].join(", ")}`);
  if (params.autoRebalance) log(`[ARB] Auto-rebalance: ON (threshold: $${params.rebalanceThreshold ?? 100})`);
  if (params.maxDrawdown) log(`[ARB] Max drawdown: $${params.maxDrawdown}`);
  if (params.symbols?.length) log(`[ARB] Symbols: ${params.symbols.join(", ")}`);

  try {
  while (running) {
    cycleCount++;
    try {
      const rates = await fetchAllRates();

      // Group by symbol
      const rateMap = new Map<string, FundingRate[]>();
      // --symbols selects an asset by its canonical key or any venue's own symbol (kPEPE selects
      // the whole 1000PEPE group, Lighter's leg included).
      const want = new Set((params.symbols ?? []).map(s => s.toUpperCase()));
      const wanted = new Set(rates.filter(r => want.has(r.symbol.toUpperCase()) || want.has(r.venueSymbol.toUpperCase())).map(r => r.symbol));
      for (const r of rates) {
        if (want.size > 0 && !wanted.has(r.symbol)) continue;
        if (!rateMap.has(r.symbol)) rateMap.set(r.symbol, []);
        rateMap.get(r.symbol)!.push(r);
      }

      // ── Phase 1: Check positions for close conditions ──
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        const symbolRates = rateMap.get(pos.symbol);
        if (!symbolRates) continue;

        const longRate = symbolRates.find((r) => r.exchange === pos.longExchange);
        const shortRate = symbolRates.find((r) => r.exchange === pos.shortExchange);
        if (!longRate || !shortRate) continue;

        const currentSpread = computeAnnualSpread(shortRate.fundingRate, shortRate.exchange, longRate.fundingRate, longRate.exchange);

        if (currentSpread <= closeSpread) {
          log(`[ARB] CLOSE signal: ${pos.symbol} spread ${currentSpread.toFixed(1)}% <= ${closeSpread}%`);

          if (params.autoExecute) {
            if (isQuarantined(pos.symbol, log)) {
              log(`[ARB] ${pos.symbol} is quarantined — not closing (perp strategy quarantine)`);
              continue;
            }
            const closed = await closeArbPosition(pos, adapters, log);
            if (!closed) continue; // still open (failed) or quarantined — keep tracking
            // Estimate P&L from funding collected
            const hoursOpen = (Date.now() - pos.openedAt) / (1000 * 60 * 60);
            // entrySpread is annualized %; convert to per-hour rate
            const hourlySpreadRate = pos.entrySpread / 100 / (24 * 365);
            const estimatedFunding = hourlySpreadRate * hoursOpen * Number(pos.size) * pos.entryPrices.long;
            log(`[ARB] Est. funding P&L: ~$${estimatedFunding.toFixed(2)} (${hoursOpen.toFixed(1)}h open)`);
          }

          positions.splice(i, 1);
        }
      }

      // ── Phase 2: Max drawdown check ──
      if (params.maxDrawdown && params.autoExecute && positions.length > 0) {
        try {
          const { snapshots, failed } = await fetchBalancesWithFailures(adapters);
          const totalPnl = snapshots.reduce((s, e) => s + e.unrealizedPnl, 0);
          // Only a failed venue that holds one of the bot's legs makes the uPnL sum unknown; a venue
          // without credentials (notConfigured) cannot hold one.
          const legVenues = new Set(positions.flatMap(p => [p.longExchange, p.shortExchange]));
          const failedLegs = failed.filter(f => legVenues.has(f.exchange));
          if (failedLegs.length > 0) {
            // A partial uPnL sum is not the bot's drawdown: never close everything on it.
            log(`[ARB] Drawdown check skipped — balance unavailable on ${failedLegs.map(f => `${f.exchange} (${f.error})`).join(", ")}`);
          } else if (totalPnl < -params.maxDrawdown) {
            log(`[ARB] MAX DRAWDOWN hit: uPnL $${totalPnl.toFixed(2)} < -$${params.maxDrawdown}`);
            log(`[ARB] Closing all ${positions.length} positions...`);
            const stillOpen = await closeAllPositions(positions, adapters, log);
            positions.length = 0;
            positions.push(...stillOpen);
          }
        } catch (err) {
          log(`[ARB] Drawdown check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Phase 3: Balance check + rebalance trigger ──
      let balanceSnapshots: ExchangeBalanceSnapshot[] | null = null;
      const shouldCheckBalance = params.autoRebalance && (Date.now() - lastRebalanceCheck > 300_000); // every 5 min

      if (shouldCheckBalance || (params.autoExecute && positions.length < maxPos)) {
        try {
          const read = await fetchBalancesWithFailures(adapters);
          balanceSnapshots = read.snapshots;
          // A venue missing from the snapshots has no balance for entry checks (no entry there).
          for (const f of read.failed) log(`[ARB] ${f.exchange} balance unavailable — no entries / rebalance on it this cycle: ${f.error}`);
          lastRebalanceCheck = Date.now();

          if (params.autoRebalance) {
            const threshold = params.rebalanceThreshold ?? 100;
            const lowExchanges = balanceSnapshots.filter((s) => s.available < threshold);
            if (lowExchanges.length > 0) {
              const plan = computeRebalancePlan(balanceSnapshots, { minMove: 50, reserve: 20 });
              if (plan.moves.length > 0) {
                log(`[ARB] Rebalance needed: ${plan.summary}`);
                for (const move of plan.moves) {
                  log(`[ARB]   $${move.amount} ${move.from} → ${move.to}`);
                }
                log(`[ARB] Run 'perp funds rebalance execute' to rebalance.`);
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // ── Phase 4: Find new entry opportunities ──
      if (positions.length < maxPos) {
        for (const [symbol, symbolRates] of rateMap) {
          if (symbolRates.length < 2) continue;
          if (positions.find((p) => symbolMatch(p.symbol, symbol))) continue;
          if (positions.length >= maxPos) break;
          if (params.autoExecute && isQuarantined(symbol, log)) continue;

          // Only consider exchanges we have adapters for
          const available = symbolRates.filter((r) => adapters.has(r.exchange));
          if (available.length < 2) continue;

          available.sort((a, b) => a.fundingRate - b.fundingRate);
          const lowest = available[0];
          const highest = available[available.length - 1];
          if (lowest.exchange === highest.exchange) continue;
          // Same ticker on two venues is not proof of the same asset: the chosen pair must agree on price.
          const pairGapPct = Math.abs(lowest.markPrice - highest.markPrice) / ((lowest.markPrice + highest.markPrice) / 2) * 100;
          if (!(pairGapPct <= MAX_PRICE_DEVIATION_PCT)) {
            if (cycleCount === 1) log(`[ARB] Skip ${symbol} ${lowest.exchange}↔${highest.exchange}: mark gap ${pairGapPct.toFixed(1)}% > ${MAX_PRICE_DEVIATION_PCT}% (likely a different asset)`);
            continue;
          }

          const annualSpread = computeAnnualSpread(highest.fundingRate, highest.exchange, lowest.fundingRate, lowest.exchange);

          if (annualSpread >= params.minSpread) {
            const longEx = lowest.exchange;
            const shortEx = highest.exchange;
            const longSym = lowest.venueSymbol;
            const shortSym = highest.venueSymbol;

            log(`[ARB] ENTRY signal: ${symbol} spread ${annualSpread.toFixed(1)}% — long ${longEx} (${(lowest.fundingRate * 100).toFixed(4)}%) / short ${shortEx} (${(highest.fundingRate * 100).toFixed(4)}%)`);

            if (params.autoExecute) {
              const longAdapter = adapters.get(longEx);
              const shortAdapter = adapters.get(shortEx);

              if (!longAdapter || !shortAdapter) {
                log(`[ARB] Skip: adapter not available for ${longEx} or ${shortEx}`);
                continue;
              }

              // Check orderbook liquidity & adjust size
              const requestedUsd = params.sizeUsd ?? Number(params.size) * highest.markPrice;
              const liq = await checkArbLiquidity(longAdapter, shortAdapter, longSym, requestedUsd, 0.5, log, shortSym);
              if (!liq.viable) continue;

              // Compute matched size (same for both legs) at each venue's published size precision —
              // the per-venue defaults (HL 2 decimals) would reject small BTC legs or over-round.
              let longDec: number | null;
              let shortDec: number | null;
              try {
                [longDec, shortDec] = await Promise.all([sizeDecimalsOf(longAdapter, longSym), sizeDecimalsOf(shortAdapter, shortSym)]);
              } catch (e) {
                log(`[ARB] Skip ${symbol}: could not read the market size precision (${e instanceof Error ? e.message : String(e)})`);
                continue;
              }
              if (longDec === null || shortDec === null) {
                log(`[ARB] Skip ${symbol}: size precision not published on ${longDec === null ? longEx : shortEx}`);
                continue;
              }
              let matched = computeMatchedSize(liq.adjustedSizeUsd, highest.markPrice, longEx, shortEx, { longSizeDecimals: longDec, shortSizeDecimals: shortDec });
              if (!matched) {
                log(`[ARB] Skip ${symbol}: can't compute matched size (min notional or precision issue)`);
                continue;
              }

              // Check balances before trading
              if (balanceSnapshots) {
                // Margin at the leverage each venue applies to the market (unknown → 1x, see requiredArbMargin).
                let longLev: number | null;
                let shortLev: number | null;
                try {
                  [longLev, shortLev] = await Promise.all([marketLeverageOf(longAdapter, longSym), marketLeverageOf(shortAdapter, shortSym)]);
                } catch (e) {
                  log(`[ARB] Skip ${symbol}: could not read the market leverage (${e instanceof Error ? e.message : String(e)})`);
                  continue;
                }
                if (!hasEnoughBalance(balanceSnapshots, longEx, matched.notional, longLev) ||
                    !hasEnoughBalance(balanceSnapshots, shortEx, matched.notional, shortLev)) {
                  const need = (ex: string, lev: number | null) => `${ex} ~$${requiredArbMargin(matched!.notional, lev).toFixed(2)} (${lev !== null ? `${lev}x` : "leverage unknown → 1x"})`;
                  log(`[ARB] Skip ${symbol}: insufficient available balance for $${matched.notional.toFixed(2)}/leg — need ${need(longEx, longLev)}, ${need(shortEx, shortLev)}`);
                  continue;
                }
              }

              log(`[ARB] Opening: ${matched.size} ${symbol} — long ${longEx} then short ${shortEx}, each verified ($${matched.notional.toFixed(0)}/leg, slippage ~${liq.longSlippage.toFixed(2)}%/${liq.shortSlippage.toFixed(2)}%)...`);
              const openPair = (size: string) => openPerpPairVerified({
                source: SOURCE, sym: symbol,
                longAdapter, longExch: longEx, longSym,
                shortAdapter, shortExch: shortEx, shortSym,
                size, smart: false, log, shortLotRetry: true,
              });
              let res = await openPair(matched.size);
              if (res.status === "not_opened" && res.rolledBack === null && res.lotSize !== null) {
                // The LONG was definitely rejected for lot size (nothing placed): recompute once.
                const lotSize = res.lotSize;
                log(`[ARB] Lot size ${lotSize} on ${longEx} — recalculating (nothing was placed)`);
                matched = computeMatchedSize(liq.adjustedSizeUsd, highest.markPrice, longEx, shortEx, { lotSize, longSizeDecimals: longDec, shortSizeDecimals: shortDec });
                if (!matched) { log(`[ARB] Skip ${symbol}: can't meet lot size ${lotSize}`); continue; }
                log(`[ARB] Retry: ${matched.size} ${symbol} ($${matched.notional.toFixed(0)}/leg)`);
                res = await openPair(matched.size);
              }
              if (res.status === "quarantined") {
                log(`[ARB] Entry ${symbol} QUARANTINED: ${res.reason} — exposure: ${res.exposure}`);
                continue;
              }
              if (res.status === "not_opened") {
                log(`[ARB] Entry error ${symbol}: ${res.reason}${res.rolledBack !== null ? ` (long ${res.rolledBack} rolled back)` : ""}`);
                continue;
              }
              if (res.trimmed !== "0") log(`[ARB] Short filled ${res.hedged} — trimmed the long by ${res.trimmed} (reduce-only)`);

              positions.push({
                symbol,
                longExchange: longEx,
                shortExchange: shortEx,
                size: res.hedged,
                entrySpread: annualSpread,
                openedAt: Date.now(),
                entryPrices: { long: lowest.markPrice, short: highest.markPrice },
                longSymbol: longSym,
                shortSymbol: shortSym,
              });

              // Entry record: `arb status` / `arb close` confirm this pair from it (arbPairProvenance).
              logExecution({
                type: "arb_entry", exchange: `${longEx}+${shortEx}`, symbol, side: "entry", size: res.hedged,
                status: "success", dryRun: false,
                meta: { arbPairId: `${symbol.toUpperCase()}:${longEx}:${shortEx}`, longExchange: longEx, shortExchange: shortEx, spread: annualSpread, source: SOURCE },
              });
              log(`[ARB] OPENED ${symbol} delta-neutral ${res.hedged}/leg (${positions.length}/${maxPos})`);
            }
          }
        }
      }

      // ── Update job state ──
      if (jobId) {
        updateJobState(jobId, {
          result: {
            cycle: cycleCount,
            activePositions: positions.length,
            positions: positions.map((p) => ({
              symbol: p.symbol,
              long: p.longExchange,
              short: p.shortExchange,
              size: p.size,
              entrySpread: p.entrySpread,
              hoursOpen: ((Date.now() - p.openedAt) / 3_600_000).toFixed(1),
            })),
            lastCheck: new Date().toISOString(),
          },
        });
      }

      // Periodic status log
      if (cycleCount % 10 === 0) {
        const posInfo = positions.length > 0
          ? positions.map((p) => `${p.symbol}(${p.entrySpread.toFixed(0)}%)`).join(", ")
          : "none";
        log(`[ARB] Cycle ${cycleCount} | ${positions.length} positions: ${posInfo} | ${rateMap.size} symbols`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[ARB] Cycle error: ${msg}`);
    }

    if (running) await sleep(params.intervalSec * 1000);
  }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
  log(`[ARB] Funding rate arbitrage stopped. Positions: ${positions.length}`);
}

/** Venue position size string for one leg (abs, as the venue reports it), or null when flat. Read errors propagate. */
async function venueLegSize(adapter: ExchangeAdapter, symbol: string, side: "long" | "short"): Promise<string | null> {
  invalidateCache("acct"); // the reduce-only close is sized from this read: never a cached position
  const p = (await adapter.getPositions()).find(x => matchSymbol(x.symbol, symbol) && x.side === side);
  if (p === undefined) return null;
  const abs = p.size.replace(/^-/, "");
  return Number(abs) > 0 ? abs : null;
}

/**
 * Close one tracked pair: reduce-only, verified, legs sequential (closePerpPairVerified), each
 * sized from the venue's own position size string, capped at the tracked size (never rounded
 * up, never another position's size). A leg already gone → the other leg alone (reduce-only,
 * verified, one residual close). Unknown outcome / unhedged residual → quarantined. Returns
 * true only when this pair is flat.
 */
async function closeArbPosition(pos: ArbPosition, adapters: Map<string, ExchangeAdapter>, log: (msg: string) => void): Promise<boolean> {
  const longAdapter = adapters.get(pos.longExchange);
  const shortAdapter = adapters.get(pos.shortExchange);
  if (!longAdapter || !shortAdapter) {
    log(`[ARB] Close ${pos.symbol}: adapter missing (${pos.longExchange}/${pos.shortExchange}) — left open`);
    return false;
  }
  const cap = (venue: string | null): string | null => (venue === null ? null : Number(venue) > Number(pos.size) ? pos.size : venue);
  let longSize: string | null;
  let shortSize: string | null;
  try {
    [longSize, shortSize] = await Promise.all([
      venueLegSize(longAdapter, pos.longSymbol, "long").then(cap),
      venueLegSize(shortAdapter, pos.shortSymbol, "short").then(cap),
    ]);
  } catch (err) {
    log(`[ARB] Close ${pos.symbol}: position read failed (${err instanceof Error ? err.message : String(err)}) — nothing sent, retry next cycle`);
    return false;
  }
  if (longSize === null && shortSize === null) {
    log(`[ARB] ${pos.symbol}: both legs already flat — removing from tracking`);
    return true;
  }
  if (longSize !== null && shortSize !== null) {
    const res = await closePerpPairVerified({
      source: SOURCE, sym: pos.symbol,
      longAdapter, longExch: pos.longExchange, longSym: pos.longSymbol, longSize,
      shortAdapter, shortExch: pos.shortExchange, shortSym: pos.shortSymbol, shortSize,
      smart: false, log,
    });
    if (res.status === "closed") {
      logExecution({
        type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`, symbol: pos.symbol, side: "close", size: pos.size,
        status: "success", dryRun: false,
        meta: { arbPairId: `${pos.symbol.toUpperCase()}:${pos.longExchange}:${pos.shortExchange}`, longExchange: pos.longExchange, shortExchange: pos.shortExchange, source: SOURCE },
      });
      log(`[ARB] CLOSED ${pos.symbol} — both legs unwound (long ${longSize}, short ${shortSize})`);
      return true;
    }
    if (res.status === "failed") { log(`[ARB] Close error ${pos.symbol}: ${res.reason} — hedge intact`); return false; }
    log(`[ARB] Close ${pos.symbol} QUARANTINED: ${res.reason}`);
    return false;
  }
  // One leg is gone (liquidated / closed elsewhere): close the orphan leg alone.
  const [adapter, venue, side, size, leg] = longSize !== null
    ? [longAdapter, pos.longExchange, "sell" as const, longSize, "long"]
    : [shortAdapter, pos.shortExchange, "buy" as const, shortSize as string, "short"];
  log(`[ARB] ${pos.symbol}: the other leg is gone — closing the orphaned ${leg} ${size} on ${venue} (reduce-only)`);
  const q = (reason: string): false => {
    quarantineSymbol(SOURCE, pos.symbol, reason,
      `Check ${pos.symbol} on ${pos.longExchange} and ${pos.shortExchange}; close by hand, then: perp strategy quarantine-clear ${pos.symbol}`, log);
    return false;
  };
  try {
    const c = await closePerpVerified(adapter, venue, leg === "long" ? pos.longSymbol : pos.shortSymbol, side, size);
    if (c.residual > 0) return q(`orphaned ${leg} close on ${venue} closed ${c.closed} of ${size}, ${c.residual} still open${c.note !== null ? ` (${c.note})` : ""}`);
  } catch (err) {
    if (!isOutcomeUnknown(err) && isPositionGone(err)) return true;
    return q(`orphaned ${leg} ${size} on ${venue}: close ${isOutcomeUnknown(err) ? "outcome unknown" : "failed"} (${err instanceof Error ? err.message : String(err)}) — unhedged`);
  }
  log(`[ARB] Closed orphaned ${leg} ${size} ${pos.symbol} on ${venue}`);
  return true;
}

/** Emergency close of every tracked pair (verified, reduce-only). Returns the pairs still open. */
async function closeAllPositions(
  positions: ArbPosition[],
  adapters: Map<string, ExchangeAdapter>,
  log: (msg: string) => void,
): Promise<ArbPosition[]> {
  const stillOpen: ArbPosition[] = [];
  for (const pos of positions) {
    if (isQuarantined(pos.symbol, log)) {
      log(`[ARB] ${pos.symbol} is quarantined — left open (perp strategy quarantine)`);
      stillOpen.push(pos);
      continue;
    }
    if (await closeArbPosition(pos, adapters, log)) log(`[ARB] Emergency closed ${pos.symbol}`);
    else stillOpen.push(pos);
  }
  return stillOpen;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
