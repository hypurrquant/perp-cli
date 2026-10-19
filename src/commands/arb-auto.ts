import { ARB_MARGIN_BUFFER, marketLeverageOf, requiredArbMargin } from "../rebalance.js";
import { ERROR_CODES, PerpError, type ErrorCode } from "../errors.js";
import { unsupported } from "../exchanges/trading-v2.js";
import { tradingV2Of } from "../exchanges/legacy-trading-v2.js";
import type { Network } from "../exchanges/venue-types.js";
import { invalidateCache } from "../cache.js";
import { Command } from "commander";
import { isDryRun, networkOf, supportsDryRun } from "../cli-flags.js";
import chalk from "chalk";
import { formatUsd, printJson, jsonOk, jsonError, makeTable, symbolMatch } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { computeExecutableSize } from "../liquidity.js";
import { computeMatchedSize, computeSpotPerpMatchedSize } from "../arb/index.js";
import { getFundingHours, toHourlyRate } from "../funding.js";
import { fetchVenuesRates } from "../funding/rates.js";
import type { FundingRateKind } from "../exchanges/interface.js";
import { toHourlyRateByBasis } from "../funding/normalize.js";
import { fetchAllDexAssetsDetailed, findDexArbPairs, scanDexArb, type DexArbPair } from "../dex-asset-map.js";
import { logExecution, readExecutionLog } from "../execution-log.js";
import { smartOrder } from "../smart-order.js";
import {
  type SettleStrategy,
  type ArbNotifyEvent,
  getMinutesSinceSettlement,
  aggressiveSettleBoost,
  estimateFundingUntilSettlement,
  computeBasisRisk,
  notifyIfEnabled,
} from "../arb-utils.js";
import {
  checkChainMargins, marginEntryBlocks, type ChainMarginCheck,
  computeAutoSize,
} from "../cross-chain-margin.js";
import {
  loadArbState,
  saveArbState,
  addPosition as persistAddPosition,
  removePosition as persistRemovePosition,
  updatePosition as persistUpdatePosition,
  createInitialState,
  createDaemonStateStore,
  type ArbPositionState,
} from "../arb-state.js";
import {
  handleRates, handleBasisScan, handleDexScan,
  handleCompare, handleFundingHistory, handleFundingPositions,
  fetchAllPrices, printGapTable, printTrackSummary, formatGapPrice,
  type PriceSnapshot,
} from "./arb.js";

interface ExchangeRate {
  exchange: string;
  rate: number;
}

interface FundingSnapshot {
  symbol: string;
  pacRate: number;
  hlRate: number;
  ltRate: number;
  astRate: number;
  spread: number; // annualized %, max spread across all exchanges
  longExch: string;
  shortExch: string;
  markPrice: number; // best available mark price across exchanges
  pacMarkPrice: number;
  hlMarkPrice: number;
  ltMarkPrice: number;
  astMarkPrice: number;
  /** Aster per-symbol funding interval (= basis and settlement interval) from /fapi/v3/fundingInfo; null when Aster has no rate. */
  astHours: number | null;
  /** Which rate each paired venue's value is (arb scan rateKind): "lastSettled" | "accruing" | "predicted" | null. */
  rateKinds?: Record<string, FundingRateKind | null>;
  /**
   * Each venue's OWN symbol for this canonical row (Hyperliquid kPEPE, Lighter 1000PEPE): orders,
   * position matching and closes use it, never the canonical key. Absent = the venue trades `symbol`.
   */
  venueSymbols?: Record<string, string>;
}

/** The venue symbol a snapshot / position leg trades on `exchange` (the canonical key when the venue uses it). */
export function legSymbol(row: { symbol: string; venueSymbols?: Record<string, string> }, exchange: string): string {
  return row.venueSymbols?.[exchange] ?? row.symbol;
}

/** longSymbol / shortSymbol of a new position — only when a leg's venue symbol differs from the key. */
function legSymbolsOf(snap: FundingSnapshot, longExchange: string, shortExchange: string): { longSymbol?: string; shortSymbol?: string } {
  const l = legSymbol(snap, longExchange), sh = legSymbol(snap, shortExchange);
  return l === snap.symbol && sh === snap.symbol ? {} : { longSymbol: l, shortSymbol: sh };
}

/** --symbols matches a row by its canonical key or any venue's own symbol (kPEPE or 1000PEPE). */
export function matchesSymbolFilter(row: { symbol: string; venueSymbols?: Record<string, string> }, filter: readonly string[]): boolean {
  const want = new Set(filter.map(s => s.toUpperCase()));
  return want.has(row.symbol.toUpperCase()) || Object.values(row.venueSymbols ?? {}).some(v => want.has(v.toUpperCase()));
}

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  size: number;
  entrySpread: number;
  entryTime: string;
  entryMarkPrice: number | null;
  accumulatedFundingUsd: number;  // estimated funding collected so far
  lastCheckTime: number;          // unix ms of last spread check
  /** Venue symbols of the legs when they differ from `symbol` (the canonical key). */
  longSymbol?: string;
  shortSymbol?: string;
}

// ── Fee-Adjusted Net Spread Calculation ──

import { getTakerFee } from "../constants.js";
import { assertFundingArbVenue, getVenue, listVenuesWithRole, resolveVenueId, roleUnsupported, tryResolveVenueId } from "../exchanges/venue.js";
import { sharedApiNetwork } from "../api/public/urls.js";
import { findSpotQuoteBalance, readSpotQuoteAvailableFresh, requireBotSpotVenue, requireSpotAdapter, spotNetworkOf, spotPairSymbol, spotSharesPerpMargin, sweepSpotQuoteToPerp, transferQuoteToPerp, transferQuoteToSpot } from "../exchanges/spot-factory.js";
import { fillSizeString, readSpotBalancesFresh, sizeDecimalsOf, spotLotStepOf, spotMarketFill, type SpotFill } from "../exchanges/spot-result.js";
import { floorSize, floorToStep, lotStepOf } from "../exchanges/precision.js";
import { MAX_PRICE_DEVIATION_PCT } from "../exchanges/spot-interface.js";
import { isQuarantined, quarantineEntryFor, quarantineKey, quarantineSymbol, setQuarantineNetwork } from "../bot/quarantine.js";
import { clearPendingEntry, orphanedPendingEntries, writePendingEntry } from "../arb/pending-entry.js";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified, rejectedLotSize, trimFirstLegToHedge, type PerpCloseResult, type PerpFill } from "../bot/perp-order.js";

// ── Venue order minimums ──

export interface LegOrderMinimums { exchange: string; minSize: string | null; minNotional: string | null }

/**
 * The venue's published order minimums for `sym` (VenueMarket.minSize / minNotional — the same
 * source `trade scale-in` checks its levels against); null = the venue publishes none.
 * A market missing from the venue's list throws (Rule #2: no assumed minimum).
 */
export async function venueOrderMinimums(adapter: ExchangeAdapter, sym: string, network: Network): Promise<{ minSize: string | null; minNotional: string | null }> {
  const vm = (await tradingV2Of(adapter, network).getVenueMarkets()).find(m => symbolMatch(m.symbol, sym));
  if (vm === undefined) {
    throw new PerpError("SYMBOL_NOT_FOUND", `${adapter.name}: market ${sym} not found — its minimum order size is unknown`, {
      exchange: adapter.name, remediation: `Check the symbol: perp market list -e ${adapter.name}`,
    });
  }
  return { minSize: vm.minSize, minNotional: vm.minNotional };
}

/** The pair's minimums: the larger of the two legs' (both legs trade the same size); 0 = none published. */
export function pairOrderMinimums(legs: readonly LegOrderMinimums[]): { minNotional: number; minSize: number; describe: string; legs: readonly LegOrderMinimums[] } {
  const parts = legs.map(l => {
    const bits = [l.minNotional !== null ? `$${l.minNotional}` : null, l.minSize !== null ? `size ${l.minSize}` : null].filter(b => b !== null);
    return `${l.exchange}: ${bits.length > 0 ? bits.join(", ") : "none published"}`;
  });
  return {
    minNotional: Math.max(0, ...legs.map(l => l.minNotional !== null ? Number(l.minNotional) : 0)),
    minSize: Math.max(0, ...legs.map(l => l.minSize !== null ? Number(l.minSize) : 0)),
    describe: parts.join("; "),
    legs,
  };
}

// ── Verified perp-perp pair orders ──
// Shared by the `arb auto` daemon, `arb exec` perp-perp and `arb dex-auto`: legs are
// sequential and verified (placePerpVerified); the short is sized to the long's
// VERIFIED fill; rollbacks, trims and closes are reduce-only and verified (plain market,
// never retried); an unknown outcome or a leg left unhedged quarantines the symbol.

export type PerpPairOpenResult =
  /** Both legs open and hedged at `hedged` (base units, both legs). */
  | { status: "opened"; hedged: string; longFilled: number; shortFilled: number; trimmed: string }
  /** Nothing left open: the long failed definitively, or the short failed and the long was rolled back in full. */
  /** lotSize: the long was definitely rejected for lot size (nothing placed) — the caller may re-size once. */
  | { status: "not_opened"; reason: string; rolledBack: string | null; lotSize: number | null }
  /** Exposure is unknown or unhedged: the symbol was quarantined; `exposure` says what may be open. */
  | { status: "quarantined"; reason: string; exposure: string };

export type PerpPairCloseResult =
  | { status: "closed" }
  /** The long close failed definitively: nothing changed, both legs still open (hedged). */
  | { status: "failed"; reason: string }
  /** Outcome unknown or a leg left unhedged: the symbol was quarantined. */
  | { status: "quarantined"; reason: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function quarantinePair(source: string, sym: string, longExch: string, shortExch: string, reason: string, log: (m: string) => void): void {
  quarantineSymbol(source, sym, reason,
    `Check ${sym} on ${longExch} and ${shortExch} (perp -e ${longExch} account positions; perp -e ${shortExch} account positions); close or re-hedge by hand, then: perp strategy quarantine-clear ${sym}`,
    log);
}

/**
 * Open long `size` on longExch, then short the long's verified fill on shortExch.
 * `smart` sends the opening legs as IOC limits (smartOrder); rollback / trim are
 * always reduce-only market orders.
 */
export async function openPerpPairVerified(p: {
  /** Quarantine source; `sym` is the quarantine (canonical) symbol, longSym / shortSym the venue order symbols. */
  source: string; sym: string;
  longAdapter: ExchangeAdapter; longExch: string; longSym: string;
  shortAdapter: ExchangeAdapter; shortExch: string; shortSym: string;
  size: string; smart: boolean; log: (m: string) => void;
  /**
   * When the short is DEFINITELY rejected for lot size (rejectedLotSize), place ONE short of
   * the long's verified fill floored to that lot (never resubmitting the long), then trim the
   * long's excess as usual. Off → the long is rolled back.
   */
  shortLotRetry?: boolean;
}): Promise<PerpPairOpenResult> {
  const { source, sym, longAdapter, longExch, longSym, shortAdapter, shortExch, shortSym, size, smart, log } = p;
  let dec = sizeDecimalsOf(size);
  const q = (reason: string, exposure: string): PerpPairOpenResult => {
    quarantinePair(source, sym, longExch, shortExch, reason, log);
    return { status: "quarantined", reason, exposure };
  };
  const smartPlace = (a: ExchangeAdapter, legSym: string, side: "buy" | "sell", sz: string) =>
    smart ? { place: () => smartOrder(a, legSym, side, sz).then(r => r.result) } : {};

  let longFilled: number;
  try {
    longFilled = (await placePerpVerified(longAdapter, longExch, longSym, "buy", size, smartPlace(longAdapter, longSym, "buy", size))).filledSize;
  } catch (e) {
    if (isOutcomeUnknown(e)) return q(`long ${size} on ${longExch} outcome unknown (${errText(e)}) — no short placed`, `long up to ${size} on ${longExch} (unconfirmed)`);
    return { status: "not_opened", reason: `long leg on ${longExch}: ${errText(e)}`, rolledBack: null, lotSize: rejectedLotSize(e) };
  }
  const longOpen = fillSizeString(longFilled, dec);
  let shortFilled: number;
  let shortSize = longOpen;
  try {
    try {
      shortFilled = (await placePerpVerified(shortAdapter, shortExch, shortSym, "sell", longOpen, smartPlace(shortAdapter, shortSym, "sell", longOpen))).filledSize;
    } catch (e) {
      const lot = p.shortLotRetry === true ? rejectedLotSize(e) : null;
      if (lot === null) throw e;
      const lotDec = Math.max(0, Math.ceil(-Math.log10(lot) - 1e-9));
      dec = Math.max(dec, lotDec);
      shortSize = (Math.floor(longFilled / lot + 1e-9) * lot).toFixed(lotDec);
      if (!(Number(shortSize) > 0)) throw e;
      log(`  short leg on ${shortExch} rejected for lot size ${lot} — placing the short once at ${shortSize} (long ${longOpen} verified, not resubmitted)`);
      shortFilled = (await placePerpVerified(shortAdapter, shortExch, shortSym, "sell", shortSize, smartPlace(shortAdapter, shortSym, "sell", shortSize))).filledSize;
    }
  } catch (e) {
    const msg = errText(e);
    if (isOutcomeUnknown(e)) {
      // The short may exist: rolling the long back could leave a naked short.
      return q(`short ${shortSize} on ${shortExch} outcome unknown (${msg}); long ${longOpen} open on ${longExch} — not rolled back`,
        `long ${longOpen} on ${longExch}; short up to ${shortSize} on ${shortExch} (unconfirmed)`);
    }
    log(`  short leg on ${shortExch} failed: ${msg} — rolling back long ${longOpen} on ${longExch} (reduce-only)`);
    let rb: PerpCloseResult;
    try {
      rb = await closePerpVerified(longAdapter, longExch, longSym, "sell", longOpen, { decimals: dec });
    } catch (rbErr) {
      return q(`short failed (${msg}) and the long rollback ${isOutcomeUnknown(rbErr) ? "is unconfirmed" : "failed"} (${errText(rbErr)})`,
        `long ${longOpen} on ${longExch} (unhedged${isOutcomeUnknown(rbErr) ? ", rollback unconfirmed" : ""})`);
    }
    if (rb.residual > 0) {
      const residual = fillSizeString(rb.residual, dec);
      return q(`short failed (${msg}); the long rollback closed ${fillSizeString(rb.closed, dec)} of ${longOpen}${rb.note !== null ? ` (${rb.note})` : ""}`, `long ${residual} on ${longExch} (unhedged)`);
    }
    return { status: "not_opened", reason: `short leg on ${shortExch}: ${msg}`, rolledBack: longOpen, lotSize: null };
  }
  const hedged = fillSizeString(shortFilled, dec);
  let trimmed: string;
  try {
    trimmed = await trimFirstLegToHedge(longAdapter, longExch, longSym, "buy", longFilled, shortFilled, dec);
  } catch (e) {
    return q(`short filled ${hedged} of ${longOpen}; trimming the long's excess on ${longExch} ${isOutcomeUnknown(e) ? "is unconfirmed" : "failed"} (${errText(e)})`,
      `long ${longOpen} on ${longExch} vs short ${hedged} on ${shortExch}`);
  }
  return { status: "opened", hedged, longFilled, shortFilled, trimmed };
}

/**
 * Close a perp-perp pair: long first, then short — reduce-only, verified, no retry.
 * A definite failure of the long close changes nothing ("failed": the caller may retry
 * later and should quarantine after repeated failures). Once the long is closed, any
 * short failure, an unknown outcome, or a residual that survives one reduce-only residual
 * close (closePerpVerified) quarantines.
 */
export async function closePerpPairVerified(p: {
  source: string; sym: string;
  longAdapter: ExchangeAdapter; longExch: string; longSym: string; longSize: string;
  shortAdapter: ExchangeAdapter; shortExch: string; shortSym: string; shortSize: string;
  /** Send each close as a reduce-only IOC limit (smartOrder) instead of a reduce-only market order. */
  smart: boolean;
  log: (m: string) => void;
}): Promise<PerpPairCloseResult> {
  const { source, sym, longAdapter, longExch, longSym, longSize, shortAdapter, shortExch, shortSym, shortSize, smart, log } = p;
  const closeOpts = (a: ExchangeAdapter, legSym: string, side: "buy" | "sell", sz: string) =>
    (smart ? { place: () => smartOrder(a, legSym, side, sz, { reduceOnly: true }).then(r => r.result) } : {});
  const q = (reason: string): PerpPairCloseResult => {
    quarantinePair(source, sym, longExch, shortExch, reason, log);
    return { status: "quarantined", reason };
  };
  // Each leg: reduce-only verified close; a partial fill gets ONE reduce-only close of the
  // measured residual (closePerpVerified); still not closed → quarantine.
  let lc: PerpCloseResult;
  try {
    lc = await closePerpVerified(longAdapter, longExch, longSym, "sell", longSize, closeOpts(longAdapter, longSym, "sell", longSize));
  } catch (e) {
    if (isOutcomeUnknown(e)) return q(`close of long ${longSize} on ${longExch} outcome unknown (${errText(e)}); short ${shortSize} on ${shortExch} left open`);
    return { status: "failed", reason: `long close on ${longExch}: ${errText(e)}` };
  }
  if (lc.residual > 0) {
    return q(`close of long on ${longExch} closed ${lc.closed} of ${longSize}, ${lc.residual} still open${lc.note !== null ? ` (${lc.note})` : ""}; short ${shortSize} on ${shortExch} not closed (legs unbalanced)`);
  }
  let sc: PerpCloseResult;
  try {
    sc = await closePerpVerified(shortAdapter, shortExch, shortSym, "buy", shortSize, closeOpts(shortAdapter, shortSym, "buy", shortSize));
  } catch (e) {
    return q(`long closed on ${longExch}; close of short ${shortSize} on ${shortExch} ${isOutcomeUnknown(e) ? "has an unknown outcome" : "failed"} (${errText(e)}) — short unhedged`);
  }
  if (sc.residual > 0) {
    return q(`long closed; close of short on ${shortExch} closed ${sc.closed} of ${shortSize}, ${sc.residual} still open${sc.note !== null ? ` (${sc.note})` : ""} — residual short unhedged`);
  }
  return { status: "closed" };
}

/**
 * Graceful stop of a daemon loop: SIGINT / SIGTERM (`perp background stop`, Ctrl+C) only REQUEST
 * the stop — the leg sequence (or rollback) in flight finishes, nothing new starts, then the loop
 * ends. A repeated signal never exits between two legs (it is logged).
 */
export function gracefulStop(name: string): { requested: () => boolean; dispose: () => void } {
  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) {
      console.error(chalk.yellow(`\n  ${name}: already stopping (${sig}) — finishing the current leg sequence first`));
      return;
    }
    stopping = true;
    console.error(chalk.yellow(`\n  ${name}: stop requested (${sig}) — finishing the current cycle, no new entries`));
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return {
    requested: () => stopping,
    dispose: () => { process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); },
  };
}

/** Sleep `ms`, waking within 250 ms once `stop()` is true. */
export async function interruptibleSleep(ms: number, stop: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (!stop() && Date.now() < until) await new Promise(r => setTimeout(r, Math.min(250, until - Date.now())));
}

/**
 * Startup: pending-entry records `source` left behind by a process that died mid-entry → the
 * symbol is quarantined (legs may be open), then the record is cleared. An unreadable pending
 * file throws (the daemon does not start on unknown exposure).
 */
export function quarantineOrphanedEntries(network: Network, source: string, log: (m: string) => void): void {
  for (const e of orphanedPendingEntries(network, source)) {
    quarantinePair(source, e.symbol, e.longExchange, e.shortExchange,
      `an entry (${e.size} per leg, started ${e.startedAt} by pid ${e.pid}) was in flight when that daemon stopped — legs may be open`, log);
    clearPendingEntry(network, source, e.symbol);
  }
}

/** The entry's outcome is recorded: drop its pending record (a failed drop is logged — the next start quarantines it). */
export function finishPendingEntry(network: Network, source: string, symbol: string, log: (m: string) => void): void {
  try {
    clearPendingEntry(network, source, symbol);
  } catch (e) {
    log(`  CRITICAL: could not clear the pending-entry record of ${symbol} (${e instanceof Error ? e.message : String(e)}) — the next daemon start will quarantine ${symbol}`);
  }
}

/** Consecutive definite close failures before the daemons quarantine a pair. */
const MAX_PAIR_CLOSE_FAILURES = 3;

/**
 * Compute the estimated round-trip cost as a percentage of notional.
 * Round-trip = 4 × taker fee + 2 × slippage (entry + exit for both legs).
 */
export function computeRoundTripCostPct(
  longExchange: string,
  shortExchange: string,
  slippagePct: number = 0.05,
): number {
  const longFee = getTakerFee(longExchange) * 100; // convert to pct
  const shortFee = getTakerFee(shortExchange) * 100;
  // Entry: long taker + short taker + slippage on each
  // Exit:  long taker + short taker + slippage on each
  return 2 * (longFee + shortFee) + 2 * slippagePct;
}

/**
 * Compute net annualized spread after deducting round-trip costs amortized over hold period.
 *
 * Net = grossAnnualPct - (roundTripCostPct / holdDays * 365) - (bridgeCostPct annualized)
 *
 * @param grossAnnualPct - Gross annual spread in %
 * @param holdDays - Expected holding period in days for cost amortization
 * @param roundTripCostPct - Total round-trip cost as % of notional
 * @param bridgeCostUsd - One-way bridge cost in USD (doubled for round-trip)
 * @param positionSizeUsd - Position size per leg in USD (for bridge cost %)
 */
export function computeNetSpread(
  grossAnnualPct: number,
  holdDays: number,
  roundTripCostPct: number,
  bridgeCostUsd: number = 0,
  positionSizeUsd: number = 0,
): number {
  const annualizedCostPct = (roundTripCostPct / holdDays) * 365;
  let bridgeCostAnnualPct = 0;
  if (bridgeCostUsd > 0 && positionSizeUsd > 0) {
    const bridgeRoundTripPct = (bridgeCostUsd * 2 / positionSizeUsd) * 100;
    bridgeCostAnnualPct = (bridgeRoundTripPct / holdDays) * 365;
  }
  return grossAnnualPct - annualizedCostPct - bridgeCostAnnualPct;
}

// ── Funding Settlement Timing ──

import { getLastSettlement, settlementIntervalHours } from "../arb-utils.js";

/** The perp-perp snapshot only carries mark prices for the four legacy venues. */
function unknownArbVenue(ex: string): never {
  throw new PerpError("UNKNOWN_VENUE", `No mark price column for venue "${ex}" in the arb snapshot`, {
    remediation: "Restrict the scan to pacifica, hyperliquid, lighter, aster",
  });
}

/** Per-venue mark-price column of a snapshot + short display label (data-driven; one entry per scanned venue). */
const SNAPSHOT_MARK_COLUMNS: Readonly<Record<string, { key: "pacMarkPrice" | "hlMarkPrice" | "ltMarkPrice" | "astMarkPrice"; label: string }>> = {
  pacifica: { key: "pacMarkPrice", label: "PAC" },
  hyperliquid: { key: "hlMarkPrice", label: "HL" },
  lighter: { key: "ltMarkPrice", label: "LT" },
  aster: { key: "astMarkPrice", label: "AST" },
};

/** Hourly funding rate of one venue column of a snapshot (Aster uses the symbol's own interval). */
function snapshotHourly(s: FundingSnapshot, ex: string): number {
  switch (ex) {
    case "pacifica": return toHourlyRate(s.pacRate, ex);
    case "hyperliquid": return toHourlyRate(s.hlRate, ex);
    case "lighter": return toHourlyRate(s.ltRate, ex);
    case "aster":
      if (s.astHours === null) {
        throw new PerpError("INVALID_PARAMS", `Aster funding interval for ${s.symbol} is unknown`, {
          remediation: "Aster funding basis is per symbol (/fapi/v3/fundingInfo); the symbol was not listed there",
        });
      }
      return toHourlyRateByBasis(s.astRate, { kind: "perHours", hours: s.astHours });
    default: return unknownArbVenue(ex);
  }
}

/**
 * Get the next settlement time for an exchange (schedule anchored at 00:00 UTC).
 * `marketIntervalHours` is the market's settlement interval; required for
 * per-market venues (Aster). Unknown venues throw UNKNOWN_VENUE.
 * A settlement exactly at `now` counts as the next one.
 */
export function getNextSettlement(exchange: string, now: Date = new Date(), marketIntervalHours: number | null = null): Date {
  const last = getLastSettlement(exchange, now, marketIntervalHours);
  if (last.getTime() === now.getTime()) return last;
  return new Date(last.getTime() + settlementIntervalHours(exchange, marketIntervalHours) * 3_600_000);
}

/**
 * Check if we are within N minutes before a settlement event on either exchange.
 * If so, we should avoid entering positions (rates may change).
 */
export function isNearSettlement(
  longExchange: string,
  shortExchange: string,
  bufferMinutes: number = 5,
  now: Date = new Date(),
  marketIntervalFor: (exchange: string) => number | null = () => null,
): { blocked: boolean; exchange?: string; minutesUntil?: number } {
  for (const exch of [longExchange, shortExchange]) {
    const nextSettle = getNextSettlement(exch, now, marketIntervalFor(exch));
    const minutesUntil = (nextSettle.getTime() - now.getTime()) / (1000 * 60);
    if (minutesUntil <= bufferMinutes && minutesUntil >= 0) {
      return { blocked: true, exchange: exch, minutesUntil };
    }
  }
  return { blocked: false };
}

/**
 * Detect if the funding spread has reversed direction for an open position.
 * A reversal means the long exchange now has a HIGHER hourly rate than the short exchange,
 * meaning we're now paying on both sides instead of collecting.
 */
export function isSpreadReversed(
  longExchange: string,
  shortExchange: string,
  snapshot: FundingSnapshot,
): boolean {
  const longHourly = snapshotHourly(snapshot, longExchange);
  const shortHourly = snapshotHourly(snapshot, shortExchange);
  // Reversed if the long side rate exceeds the short side rate
  return longHourly > shortHourly;
}

export interface ArbPnlPosition { exchange: string; symbol: string; side: string; size: number; entry: number; mark: number; upnl: number; lev: number }

/**
 * Read open positions on each venue for `arb pnl`. A venue whose adapter/positions read
 * fails lands in `positionErrors` (never silently dropped); a venue with no credentials
 * (read-only adapter) lands in `notConfigured`.
 */
export async function collectArbPnlPositions(
  exchangeNames: string[],
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
): Promise<{ positions: ArbPnlPosition[]; positionErrors: Record<string, string>; notConfigured: string[] }> {
  const positions: ArbPnlPosition[] = [];
  const positionErrors: Record<string, string> = {};
  const notConfigured: string[] = [];
  for (const exName of exchangeNames) {
    try {
      const adapter = await getAdapterForExchange(exName);
      if ((adapter as { isReadOnly?: boolean }).isReadOnly === true) { notConfigured.push(exName); continue; }
      for (const p of await adapter.getPositions()) {
        positions.push({
          exchange: exName,
          symbol: p.symbol.replace("-PERP", ""),
          side: p.side,
          size: Math.abs(Number(p.size)),
          entry: Number(p.entryPrice),
          mark: Number(p.markPrice),
          upnl: Number(p.unrealizedPnl),
          lev: p.leverage,
        });
      }
    } catch (e) {
      positionErrors[exName] = e instanceof Error ? e.message : String(e);
    }
  }
  return { positions, positionErrors, notConfigured };
}

/**
 * "arb" when the symbol has both a long and a short leg; otherwise "unknown" if any venue's
 * positions were unread (its missing leg may be there — never call it naked), else "single".
 */
export function arbPnlPairStatus(positions: Array<{ side: string }>, failedVenues: string[]): "arb" | "single" | "unknown" {
  if (positions.length >= 2 && positions.some(p => p.side === "long") && positions.some(p => p.side === "short")) return "arb";
  return failedVenues.length > 0 ? "unknown" : "single";
}

/**
 * HIP-3 auto-arb: the dex (either leg) whose market read failed this cycle, or null.
 * A non-null result means the pair's spread is UNKNOWN — the position is kept (never
 * closed as "pair disappeared"); only a pair missing from a successfully read dex is gone.
 */
export function dexCloseBlockedBy(
  pos: { longDex: string; shortDex: string },
  failedDexes: Record<string, string>,
): string | null {
  if (Object.hasOwn(failedDexes, pos.longDex)) return pos.longDex;
  if (Object.hasOwn(failedDexes, pos.shortDex)) return pos.shortDex;
  return null;
}

const _warnedArbPriceMismatch = new Set<string>();

/** " (lastSettled)"-style tag of a snapshot leg's rate kind; "" when the venue is not a leg. */
const kindTag = (s: FundingSnapshot, ex: string) => { const k = s.rateKinds?.[ex]; return k === undefined ? "" : `(${k ?? "?"})`; };

export async function fetchFundingSpreads(): Promise<FundingSnapshot[]> {
  // The SAME rate rows as `arb scan --rates` (fetchVenuesRates over each venue's public directory):
  // one rate per venue and canonical symbol (unclassified / ambiguous tickers and non-matchable
  // listings have no canonical and never pair), each with its basis and rateKind. A venue that
  // fails is reported, never silently treated as "no spread".
  const venues = ["pacifica", "hyperliquid", "lighter", "aster"].map(id => getVenue(id));
  const { rates, exchangeErrors } = await fetchVenuesRates(venues, sharedApiNetwork(), false);
  for (const [ex, msg] of Object.entries(exchangeErrors)) process.stderr.write(`[arb-auto] ${ex}: funding rates unavailable — ${msg}\n`);

  const pacRates = new Map<string, number>(), pacPrices = new Map<string, number>();
  const hlRates = new Map<string, number>(), hlPrices = new Map<string, number>();
  const ltRates = new Map<string, number>(), ltPrices = new Map<string, number>();
  const astRates = new Map<string, number>(), astPrices = new Map<string, number>();
  const astHoursBySym = new Map<string, number>();
  const kindsBySym = new Map<string, Record<string, FundingRateKind | null>>();
  const venueSymbolsBySym = new Map<string, Record<string, string>>();
  const astNoInterval: string[] = [];
  for (const r of rates) {
    const sym = r.canonical;
    const kinds = kindsBySym.get(sym) ?? {};
    kinds[r.exchange] = r.rateKind;
    kindsBySym.set(sym, kinds);
    const vs = venueSymbolsBySym.get(sym) ?? {};
    vs[r.exchange] = r.symbol; // the venue's own symbol (orders use it)
    venueSymbolsBySym.set(sym, vs);
    if (r.exchange === "aster") {
      if (r.basis.kind !== "perHours") { astNoInterval.push(r.symbol); continue; }
      astRates.set(sym, r.fundingRate); astPrices.set(sym, r.markPrice); astHoursBySym.set(sym, r.basis.hours);
      continue;
    }
    // The snapshot keeps each venue's rate in the venue's own basis (snapshotHourly /
    // computeAnnualSpread normalize with it): convert from the row's hourly rate.
    const inVenueBasis = r.hourlyRate * getFundingHours(r.exchange);
    if (r.exchange === "pacifica") { pacRates.set(sym, inVenueBasis); pacPrices.set(sym, r.markPrice); }
    else if (r.exchange === "hyperliquid") { hlRates.set(sym, inVenueBasis); hlPrices.set(sym, r.markPrice); }
    else if (r.exchange === "lighter") { ltRates.set(sym, inVenueBasis); ltPrices.set(sym, r.markPrice); }
  }
  if (astNoInterval.length > 0) {
    process.stderr.write(`[arb-auto] aster: ${astNoInterval.length} symbol(s) excluded — no fundingIntervalHours in /fapi/v3/fundingInfo: ${astNoInterval.slice(0, 10).join(", ")}${astNoInterval.length > 10 ? ", …" : ""}\n`);
  }

  const snapshots: FundingSnapshot[] = [];
  const allSymbols = new Set([...pacRates.keys(), ...hlRates.keys(), ...ltRates.keys(), ...astRates.keys()]);

  for (const sym of allSymbols) {
    const pac = pacRates.get(sym);
    const hl = hlRates.get(sym);
    const lt = ltRates.get(sym);
    const ast = astRates.get(sym);

    // Need at least 2 exchanges
    const available: ExchangeRate[] = [];
    if (pac !== undefined) available.push({ exchange: "pacifica", rate: pac });
    if (hl !== undefined) available.push({ exchange: "hyperliquid", rate: hl });
    if (lt !== undefined) available.push({ exchange: "lighter", rate: lt });
    if (ast !== undefined) available.push({ exchange: "aster", rate: ast });
    if (available.length < 2) continue;

    // Same bare ticker on two venues is not proof of the same asset (e.g. PRL at
    // a 167% price gap). Keep only venues whose mark is within
    // MAX_PRICE_DEVIATION_PCT of the cross-venue median; a venue without a mark
    // price cannot be checked and is dropped from the pairing.
    const priceOf = (ex: string): number | undefined =>
      ex === "pacifica" ? pacPrices.get(sym) : ex === "hyperliquid" ? hlPrices.get(sym) : ex === "lighter" ? ltPrices.get(sym) : astPrices.get(sym);
    const priced = available.filter(r => { const px = priceOf(r.exchange); return px !== undefined && px > 0; });
    if (priced.length < 2) continue;
    const pxs = priced.map(r => priceOf(r.exchange) as number).sort((x, y) => x - y);
    const medianPx = pxs.length % 2 === 1 ? pxs[(pxs.length - 1) / 2] : (pxs[pxs.length / 2 - 1] + pxs[pxs.length / 2]) / 2;
    const consistent = priced.filter(r => {
      const devPct = Math.abs((priceOf(r.exchange) as number) - medianPx) / medianPx * 100;
      if (devPct <= MAX_PRICE_DEVIATION_PCT) return true;
      const key = `${sym}:${r.exchange}`;
      if (!_warnedArbPriceMismatch.has(key)) {
        _warnedArbPriceMismatch.add(key);
        process.stderr.write(`[arb-auto] excluded ${r.exchange} ${sym}: mark deviates ${devPct.toFixed(1)}% from cross-venue median (likely a different asset with the same ticker)\n`);
      }
      return false;
    });
    if (consistent.length < 2) continue;
    available.length = 0;
    available.push(...consistent);

    const astHours = astHoursBySym.get(sym) ?? null;
    const norm = (r: ExchangeRate) => r.exchange === "aster"
      ? toHourlyRateByBasis(r.rate, { kind: "perHours", hours: astHours as number }) // present whenever ast is (filtered above)
      : toHourlyRate(r.rate, r.exchange);
    available.sort((a, b) => norm(a) - norm(b));
    const lowest = available[0];
    const highest = available[available.length - 1];
    // Median filtering keeps venues near the centre, but the chosen pair itself
    // must also agree on price (100 / 104.5 / 109 all pass the median test while
    // the 100↔109 pair is 8.6% apart).
    const pairLo = priceOf(lowest.exchange) as number;
    const pairHi = priceOf(highest.exchange) as number;
    const pairGapPct = Math.abs(pairLo - pairHi) / ((pairLo + pairHi) / 2) * 100;
    if (pairGapPct > MAX_PRICE_DEVIATION_PCT) {
      const key = `${sym}:${lowest.exchange}:${highest.exchange}`;
      if (!_warnedArbPriceMismatch.has(key)) {
        _warnedArbPriceMismatch.add(key);
        process.stderr.write(`[arb-auto] excluded ${sym} ${lowest.exchange}↔${highest.exchange}: pair mark gap ${pairGapPct.toFixed(1)}% > ${MAX_PRICE_DEVIATION_PCT}%\n`);
      }
      continue;
    }
    const spread = Math.abs(norm(highest) - norm(lowest)) * 24 * 365 * 100;

    // Use best available mark price (prefer HL as most liquid, then PAC, then LT, then AST)
    const markPrice = hlPrices.get(sym) ?? pacPrices.get(sym) ?? ltPrices.get(sym) ?? astPrices.get(sym) ?? 0;

    snapshots.push({
      symbol: sym,
      pacRate: pac ?? 0,
      hlRate: hl ?? 0,
      ltRate: lt ?? 0,
      astRate: ast ?? 0,
      spread,
      longExch: lowest.exchange,  // long where funding is lowest
      shortExch: highest.exchange, // short where funding is highest
      markPrice,
      pacMarkPrice: pacPrices.get(sym) ?? 0,
      hlMarkPrice: hlPrices.get(sym) ?? 0,
      ltMarkPrice: ltPrices.get(sym) ?? 0,
      astMarkPrice: astPrices.get(sym) ?? 0,
      astHours: ast !== undefined ? astHours : null,
      rateKinds: Object.fromEntries(available.map(r => [r.exchange, kindsBySym.get(sym)?.[r.exchange] ?? null])),
      venueSymbols: venueSymbolsBySym.get(sym) ?? {},
    });
  }

  return snapshots.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
}


// Module-level holder for spot-close handler -- assigned inside registerArbAutoCommands.
export let handleSpotClose: ((
  sym: string,
  opts: { spotExch?: string; perpExch?: string },
  getAdapterForExchange: (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
  isJson: () => boolean,
) => Promise<void>) | undefined;

export function registerArbAutoCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getHLAdapterForDex?: (dex: string) => Promise<import("../exchanges/hyperliquid.js").HyperliquidAdapter>,
) {
  const arb = program.commands.find(c => c.name() === "arb");
  if (!arb) return;
  // Quarantine checks / entries of every arb command are scoped to its -n network.
  arb.hook("preAction", (_cmd, action) => setQuarantineNetwork(networkOf(action)));

  // ── arb auto ── (daemon mode)

  supportsDryRun(arb.command("auto"))
    .description("Auto-execute funding rate arbitrage (daemon). Use --hip3 for HIP-3 cross-dex mode. Supports --dry-run (also inherited by --background).")
    .option("--min-spread <pct>", "Min annual spread to enter (%)", "30")
    .option("--close-spread <pct>", "Close when spread drops below (%)", "5")
    .option("--size <usd>", "Position size per leg ($)", "100")
    .option("--min-size <usd>", "Min position size floor for auto-sizing ($ notional)", "30")
    .option("--max-positions <n>", "Max simultaneous arb positions", "5")
    .option("--symbols <list>", "Comma-separated symbols to monitor (default: all)")
    .option("--interval <seconds>", "Check interval", "60")
    .option("--hold-days <days>", "Expected hold period for cost amortization", "7")
    .option("--bridge-cost <usd>", "One-way bridge cost in USD", "0")
    .option("--no-reversal-exit", "Disable emergency exit on spread reversal")
    .option("--settle-aware", "Avoid entries near funding settlement (default: true)")
    .option("--no-settle-aware", "Disable settlement timing awareness")
    .option("--min-margin <pct>", "Warn/block when margin ratio drops below this %", "30")
    .option("--settle-strategy <mode>", "Settlement timing: block (default), aggressive, off", "block")
    .option("--max-basis <pct>", "Max basis risk (mark price divergence %)", "3")
    .option("--notify <url>", "Webhook URL for notifications (Discord/Telegram/generic)")
    .option("--notify-events <events>", "Comma-separated events: entry,exit,reversal,margin,basis", "entry,exit,reversal,margin,basis")
    .option("--cooldown <minutes>", "Minutes to wait before re-entering a closed symbol", "30")
    .option("--background", "Run in background (tmux)")
    .option("--job-id <id>", "Job ID (set by the background runner)")
    .option("--hip3", "Run HIP-3 cross-dex auto arb instead of perp-perp")
    .option("--min-oi <usd>", "Min OI (USD) to enter (hip3 mode)", "50000")
    .option("--min-grade <grade>", "Min viability grade: A, B, C, D (hip3 mode)", "C")
    .action(async (opts: {
      minSpread: string; closeSpread: string; size: string; minSize: string;
      maxPositions: string; symbols?: string; interval: string;
      holdDays: string; bridgeCost: string;
      reversalExit?: boolean; settleAware?: boolean;
      minMargin: string;
      settleStrategy: string; maxBasis: string;
      cooldown: string;
      notify?: string; notifyEvents: string;
      background?: boolean;
      hip3?: boolean; minOi: string; minGrade: string;
    }) => {
      // Route to HIP-3 dex-auto logic if --hip3 flag is set
      if (opts.hip3) {
        return handleDexAuto({
          minSpread: opts.minSpread,
          closeSpread: opts.closeSpread,
          size: opts.size,
          maxPositions: opts.maxPositions,
          minOi: opts.minOi,
          minGrade: opts.minGrade,
          interval: opts.interval,
          dryRun: isDryRun(program),
        });
      }
      if (opts.background) {
        const { startJob, jobSelectorsOf } = await import("../jobs.js");
        const cliArgs = [
          `arb`, `auto`,
          `--min-spread`, opts.minSpread,
          `--close-spread`, opts.closeSpread,
          `--size`, opts.size,
          `--max-positions`, opts.maxPositions,
          `--interval`, opts.interval,
          `--hold-days`, opts.holdDays,
          `--bridge-cost`, opts.bridgeCost,
          `--min-margin`, opts.minMargin,
          `--cooldown`, opts.cooldown,
          ...(opts.symbols ? [`--symbols`, opts.symbols] : []),
          ...(opts.reversalExit === false ? [`--no-reversal-exit`] : []),
          ...(opts.settleAware === false ? [`--no-settle-aware`] : []),
          `--min-size`, opts.minSize,
          `--settle-strategy`, opts.settleStrategy,
          `--max-basis`, opts.maxBasis,
          `--notify-events`, opts.notifyEvents,
          ...(opts.notify ? [`--notify`, opts.notify] : []),
        ];
        const job = startJob({
          strategy: "funding-arb",
          exchange: "multi",
          // The background child inherits the root -n and --dry-run.
          network: networkOf(program), dryRun: isDryRun(program), selectors: jobSelectorsOf(program),
          params: { ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        console.log(chalk.green(`\n  Funding arb bot started in background.`));
        console.log(`  ID: ${chalk.white.bold(job.id)}`);
        console.log(`  Min spread: ${opts.minSpread}% | Size: $${opts.size}`);
        console.log(`  Logs: ${chalk.gray(`perp background logs ${job.id}`)}`);
        console.log(`  Stop: ${chalk.gray(`perp background stop ${job.id}`)}\n`);
        return;
      }

      const minSpread = parseFloat(opts.minSpread);
      const closeSpread = parseFloat(opts.closeSpread);
      const sizeIsAuto = opts.size.toLowerCase() === "auto";
      const sizeUsd = sizeIsAuto ? 0 : parseFloat(opts.size);
      const maxPositions = parseInt(opts.maxPositions);
      const intervalMs = parseInt(opts.interval) * 1000;
      const holdDays = parseFloat(opts.holdDays);
      const bridgeCostUsd = parseFloat(opts.bridgeCost);
      const reversalExitEnabled = opts.reversalExit !== false;
      const settleAwareEnabled = opts.settleAware !== false;
      // --no-settle-aware overrides --settle-strategy to "off"
      const settleStrategy = !settleAwareEnabled ? "off" as SettleStrategy : (opts.settleStrategy || "block") as SettleStrategy;
      const maxBasisPct = parseFloat(opts.maxBasis);
      const webhookUrl = opts.notify;
      const notifyEvents: ArbNotifyEvent[] = opts.notifyEvents
        .split(",").map(e => e.trim()).filter(Boolean) as ArbNotifyEvent[];
      const minMarginPct = parseFloat(opts.minMargin);
      const minSizeUsd = parseFloat(opts.minSize);
      const filterSymbols = opts.symbols?.split(",").map(s => s.trim().toUpperCase());
      const dryRun = isDryRun(program);

      const cooldownMinutes = parseFloat(opts.cooldown);
      const openPositions: ArbPosition[] = [];
      // Track which exchanges have low margin (block entries)
      const blockedExchanges = new Set<string>();
      // Venues whose margin was unknown last cycle (webhook sent once per transition)
      const marginUnknownNotified = new Set<string>();
      // Track close times per symbol to prevent close→re-entry loops
      const closeCooldowns = new Map<string, number>(); // symbol → close timestamp ms
      // Consecutive definite close failures per symbol (quarantined at MAX_PAIR_CLOSE_FAILURES)
      const closeFailures = new Map<string, number>();

      // -- State Persistence: Initialize or recover --
      const daemonConfig = {
        minSpread,
        closeSpread,
        size: (typeof sizeIsAuto !== "undefined" && sizeIsAuto ? "auto" : sizeUsd) as number | "auto",
        holdDays,
        bridgeCost: bridgeCostUsd,
        maxPositions,
        settleStrategy: settleAwareEnabled ? "aware" : "disabled",
      };
      // The daemon manages perp-perp positions only. Spot-perp positions (persisted by
      // `arb exec spot:<venue> ...`) are closed with `perp arb close <symbol>` (spot-perp
      // path) — never as perp-perp. Warn once per symbol.
      const warnedSpotPerp = new Set<string>();
      const isDaemonManaged = (p: ArbPositionState): boolean => {
        if (p.mode !== "spot-perp") return true;
        if (!warnedSpotPerp.has(p.symbol)) {
          warnedSpotPerp.add(p.symbol);
          console.log(chalk.yellow(`  ${new Date().toLocaleTimeString()} SKIP: ${p.symbol} is a spot-perp position (spot ${p.spotExchange ?? p.longExchange} / perp ${p.shortExchange}) — not managed by this daemon; close it with: perp arb close ${p.symbol}`));
        }
        return false;
      };
      // State access for this daemon. Dry-run NEVER writes the real per-network arb state
      // (review N3): it works on an in-memory copy seeded read-only from the real state, so a
      // simulated entry is never picked up by a live run and a simulated close never drops a
      // real position from tracking.
      const st = createDaemonStateStore(networkOf(program), dryRun, daemonConfig);
      // State entries the venues do not confirm (no long on longExchange + short on shortExchange):
      // never counted toward --max-positions, never managed; they still block a new entry on the
      // same symbol (the state is keyed by symbol). Drop one with: perp arb close <sym> --state-only.
      const staleSymbols = new Set<string>();
      const confirmedOnVenues = async (p: ArbPositionState): Promise<boolean> => {
        try {
          const [longs, shorts] = await Promise.all([
            (await getAdapterForExchange(p.longExchange)).getPositions(),
            (await getAdapterForExchange(p.shortExchange)).getPositions(),
          ]);
          const has = (list: { symbol: string; side: string; size: string }[], side: "long" | "short") =>
            list.some(x => symbolMatch(x.symbol, (side === "long" ? p.longSymbol : p.shortSymbol) ?? p.symbol) && x.side === side && Math.abs(Number(x.size)) > 0);
          if (has(longs, "long") && has(shorts, "short")) { staleSymbols.delete(p.symbol); return true; }
          if (!staleSymbols.has(p.symbol)) {
            console.log(chalk.yellow(`  ${new Date().toLocaleTimeString()} STALE STATE: ${p.symbol} (long ${p.longExchange} / short ${p.shortExchange}, since ${p.entryTime}) is not on the venues — not counted, not managed; drop it: perp arb close ${p.symbol} --state-only`));
          }
          staleSymbols.add(p.symbol);
          return false;
        } catch (e) {
          // Unknown (read failed): counted, so a possibly-live pair is never doubled.
          console.log(chalk.yellow(`  ${new Date().toLocaleTimeString()} ${p.symbol}: could not confirm the state entry on the venues (${e instanceof Error ? e.message : String(e)}) — counted as open`));
          return true;
        }
      };
      let daemonState = st.load();
      if (daemonState && daemonState.positions.length > 0) {
        // Crash recovery: restore positions from persisted state — only those the venues confirm.
        for (const persisted of daemonState.positions) {
          if (!isDaemonManaged(persisted)) continue;
          if (!dryRun && !(await confirmedOnVenues(persisted))) continue;
          openPositions.push({
            symbol: persisted.symbol,
            longExchange: persisted.longExchange,
            shortExchange: persisted.shortExchange,
            size: persisted.longSize,
            entrySpread: persisted.entrySpread,
            entryTime: persisted.entryTime,
            entryMarkPrice: persisted.entryLongPrice,
            accumulatedFundingUsd: persisted.accumulatedFunding,
            lastCheckTime: new Date(persisted.lastCheckTime).getTime(),
            longSymbol: persisted.longSymbol, shortSymbol: persisted.shortSymbol,
          });
        }
        daemonState.lastStartTime = new Date().toISOString();
        st.save(daemonState);
        if (!isJson()) {
          console.log(chalk.yellow(`  Recovered ${openPositions.length} perp-perp position(s) from previous session.`));
        }
      } else {
        daemonState = createInitialState(daemonConfig);
        st.save(daemonState);
      }

      // A previous daemon that died between two legs (crash / kill) left its pending-entry
      // record: what is open is unknown → quarantine the symbol (never re-entered blind).
      if (!dryRun) quarantineOrphanedEntries(networkOf(program), "arb-auto", (m) => console.log(chalk.red(m)));

      // Graceful stop (SIGINT / SIGTERM — `perp background stop`): the current cycle finishes the
      // leg sequence (or rollback) it is in, starts nothing new, then the state is saved and the
      // daemon exits. Never an exit between two legs.
      const stop = gracefulStop("arb auto");


      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Funding Rate Arb Bot\n"));
        console.log(`  Mode:          ${dryRun ? chalk.yellow("DRY RUN") : chalk.green("LIVE")}`);
        console.log(`  Enter spread:  >= ${minSpread}% annual (net, after fees)`);
        console.log(`  Close spread:  <= ${closeSpread}% annual`);
        console.log(`  Size per leg:  ${sizeIsAuto ? chalk.cyan("auto (dynamic)") : `$${sizeUsd}`}`);
        if (sizeIsAuto) console.log(`  Min size:      $${minSizeUsd} (floor for auto)`);
        console.log(`  Max positions: ${maxPositions}`);
        console.log(`  Hold period:   ${holdDays} days (cost amortization)`);
        console.log(`  Bridge cost:   $${bridgeCostUsd} per transfer`);
        console.log(`  Min margin:    ${minMarginPct}% (block entries below this)`);
        console.log(`  Max basis:     ${maxBasisPct}% (warn on price divergence)`);
        console.log(`  Reversal exit: ${reversalExitEnabled ? chalk.green("ON") : chalk.yellow("OFF")}`);
        console.log(`  Settle strat:  ${settleStrategy === "aggressive" ? chalk.cyan("AGGRESSIVE") : settleStrategy === "off" ? chalk.yellow("OFF") : chalk.green("BLOCK")}`);
        console.log(`  Cooldown:      ${cooldownMinutes}m (re-entry delay after close)`);
        console.log(`  Notifications: ${webhookUrl ? chalk.green("ON") : chalk.gray("OFF")}${webhookUrl ? ` (${notifyEvents.join(",")})` : ""}`);
        console.log(`  Symbols:       ${filterSymbols?.join(", ") || "all"}`);
        console.log(`  Interval:      ${opts.interval}s`);
        console.log(chalk.gray("\n  Monitoring... (Ctrl+C to stop)\n"));
      }

      const cycle = async () => {
        // Sync in-memory positions with persisted state (handles CLI manual closes)
        const syncState = st.load();
        if (syncState) {
          const persistedSymbols = new Set(syncState.positions.map(p => p.symbol));
          // Remove positions that were closed externally (e.g. via `perp arb close`)
          for (let i = openPositions.length - 1; i >= 0; i--) {
            if (!persistedSymbols.has(openPositions[i].symbol)) {
              console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} SYNC: ${openPositions[i].symbol} removed (closed externally)`));
              openPositions.splice(i, 1);
            }
          }
          // Recover positions that exist in state but not in memory (e.g. added by another process)
          for (const persisted of syncState.positions) {
            if (!isDaemonManaged(persisted)) continue;
            if (!openPositions.some(p => p.symbol === persisted.symbol)) {
              if (!dryRun && !(await confirmedOnVenues(persisted))) continue;
              console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} SYNC: recovering ${persisted.symbol} from state`));
              openPositions.push({
                symbol: persisted.symbol,
                longExchange: persisted.longExchange,
                shortExchange: persisted.shortExchange,
                size: persisted.longSize,
                entrySpread: persisted.entrySpread,
                entryTime: persisted.entryTime,
                entryMarkPrice: persisted.entryLongPrice,
                accumulatedFundingUsd: persisted.accumulatedFunding,
                lastCheckTime: new Date(persisted.lastCheckTime).getTime(),
                longSymbol: persisted.longSymbol, shortSymbol: persisted.shortSymbol,
              });
            }
          }
        }

        // Heartbeat check
        const heartbeatState = st.load();
        if (heartbeatState?.lastSuccessfulScanTime) {
          const lastSuccessMs = new Date(heartbeatState.lastSuccessfulScanTime).getTime();
          const minutesSinceSuccess = (Date.now() - lastSuccessMs) / (1000 * 60);
          if (minutesSinceSuccess > 5) {
            console.log(chalk.yellow(`  ${new Date().toLocaleTimeString()} HEARTBEAT WARNING: no successful scan for ${minutesSinceSuccess.toFixed(0)} minutes`));
            await notifyIfEnabled(webhookUrl, notifyEvents, "heartbeat", {
              lastScanTime: heartbeatState.lastSuccessfulScanTime,
              minutesAgo: minutesSinceSuccess,
            });
          }
        }

        try {
          const spreads = await fetchFundingSpreads();
          const filtered = filterSymbols
            ? spreads.filter(s => matchesSymbolFilter(s, filterSymbols))
            : spreads;

          const now = new Date().toLocaleTimeString();

          // Check for close conditions on open positions
          for (let i = openPositions.length - 1; i >= 0; i--) {
            if (stop.requested()) break; // stopping: no new close sequence
            const pos = openPositions[i];
            // Quarantined: hands off until a human clears it.
            if (isQuarantined(pos.symbol, (m) => console.log(chalk.red(m)))) continue;
            // Per-position isolation: one position's failing exit check (e.g. an
            // unknown funding basis in snapshotHourly) must not skip the others.
            try {
              // By canonical key; a position opened before 0.15.1 is keyed by its (shared) venue symbol.
              const current = filtered.find(s => s.symbol === pos.symbol
                || (legSymbol(s, pos.longExchange) === pos.symbol && legSymbol(s, pos.shortExchange) === pos.symbol));
              if (!current) continue;

              const currentSpread = Math.abs(current.spread);
              let shouldClose = false;
              let closeReason = "";

              // Check spread-based close
              if (currentSpread <= closeSpread) {
                shouldClose = true;
                closeReason = `spread ${currentSpread.toFixed(1)}% <= ${closeSpread}%`;
              }

              // Check reversal-based close
              if (!shouldClose && reversalExitEnabled && isSpreadReversed(pos.longExchange, pos.shortExchange, current)) {
                shouldClose = true;
                closeReason = "REVERSAL DETECTED — long exchange now has higher rate than short";
                await notifyIfEnabled(webhookUrl, notifyEvents, "reversal", {
                  symbol: pos.symbol, longExchange: pos.longExchange, shortExchange: pos.shortExchange,
                });
              }

              // Check basis risk (mark price divergence) — use prices from fetchFundingSpreads, no extra API calls
              {
                const longCol = SNAPSHOT_MARK_COLUMNS[pos.longExchange];
                const shortCol = SNAPSHOT_MARK_COLUMNS[pos.shortExchange];
                const bLP = longCol ? current[longCol.key] : 0;
                const bSP = shortCol ? current[shortCol.key] : 0;
                if (!longCol || !shortCol) {
                  const missing = [!longCol ? pos.longExchange : null, !shortCol ? pos.shortExchange : null].filter(Boolean).join(", ");
                  console.log(chalk.yellow(`  ${now} BASIS CHECK SKIPPED ${pos.symbol}: no mark price column for venue ${missing}`));
                } else if (bLP > 0 && bSP > 0) {
                  const basis = computeBasisRisk(bLP, bSP, maxBasisPct);
                  if (basis.warning) {
                    console.log(chalk.yellow(
                      `  ${now} BASIS RISK ${pos.symbol}: Long ${longCol.label} $${bLP.toFixed(4)} / ` +
                      `Short ${shortCol.label} $${bSP.toFixed(4)} | Divergence: ${basis.divergencePct.toFixed(1)}%`
                    ));
                    await notifyIfEnabled(webhookUrl, notifyEvents, "basis", {
                      symbol: pos.symbol, longExchange: pos.longExchange, shortExchange: pos.shortExchange,
                      divergencePct: basis.divergencePct,
                    });
                  }
                }
              }

              if (shouldClose) {
                console.log(chalk.yellow(`  ${now} CLOSE ${pos.symbol} — ${closeReason}`));
                const exitReason = closeReason.includes("REVERSAL") ? "reversal"
                  : closeReason.includes("spread") ? "spread"
                  : "manual";

                if (!dryRun) {
                  try {
                    const longAdapter = await getAdapterForExchange(pos.longExchange);
                    const shortAdapter = await getAdapterForExchange(pos.shortExchange);

                    // Sequential, reduce-only, verified: long first, then
                    // short. A definite long-close failure changes nothing → retried next
                    // cycle, quarantined after MAX_PAIR_CLOSE_FAILURES in a row. An unknown
                    // outcome, a partial close or an unhedged leg quarantines (no retry).
                    const sizeStr = String(pos.size);
                    const closeRes = await closePerpPairVerified({
                      source: "arb-auto", sym: pos.symbol,
                      longAdapter, longExch: pos.longExchange, longSym: pos.longSymbol ?? pos.symbol, longSize: sizeStr,
                      shortAdapter, shortExch: pos.shortExchange, shortSym: pos.shortSymbol ?? pos.symbol, shortSize: sizeStr, smart: false,
                      log: (m) => console.log(chalk.red(m)),
                    });

                    if (closeRes.status === "closed") {
                      closeFailures.delete(pos.symbol);
                      logExecution({
                        type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                        symbol: pos.symbol, side: "close", size: sizeStr,
                        status: "success", dryRun: false,
                        meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, currentSpread, reason: closeReason, exitReason },
                      });
                      console.log(chalk.green(`  ${now} CLOSED ${pos.symbol} — both legs (reduce-only, verified)`));
                      st.remove(pos.symbol);
                      closeCooldowns.set(pos.symbol, Date.now());
                      openPositions.splice(i, 1);
                      await notifyIfEnabled(webhookUrl, notifyEvents, "exit", {
                        symbol: pos.symbol, longExchange: pos.longExchange, shortExchange: pos.shortExchange,
                        pnl: pos.accumulatedFundingUsd,
                        duration: `${Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 3600000)}h`,
                      });
                    } else if (closeRes.status === "failed") {
                      const n = (closeFailures.get(pos.symbol) ?? 0) + 1;
                      closeFailures.set(pos.symbol, n);
                      logExecution({
                        type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                        symbol: pos.symbol, side: "close", size: sizeStr,
                        status: "failed", dryRun: false,
                        error: `${closeRes.reason} (attempt ${n}/${MAX_PAIR_CLOSE_FAILURES}, nothing changed)`,
                        meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, reason: closeReason, exitReason },
                      });
                      console.error(chalk.red(`  ${now} CLOSE FAILED ${pos.symbol}: ${closeRes.reason} — both legs still open (${n}/${MAX_PAIR_CLOSE_FAILURES})`));
                      if (n >= MAX_PAIR_CLOSE_FAILURES) {
                        quarantinePair("arb-auto", pos.symbol, pos.longExchange, pos.shortExchange,
                          `close failed ${n} times in a row (last: ${closeRes.reason})`, (m) => console.log(chalk.red(m)));
                      }
                      // Do NOT splice — kept tracked; reduce-only makes the next attempt safe
                    } else {
                      // Quarantined: kept in state (accurate: exposure may remain); hands off until cleared.
                      logExecution({
                        type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                        symbol: pos.symbol, side: "close", size: sizeStr,
                        status: "failed", dryRun: false,
                        error: `QUARANTINED: ${closeRes.reason}`,
                        meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, reason: closeReason, exitReason, quarantined: true },
                      });
                      console.log(chalk.red.bold(`  ${now} CLOSE ${pos.symbol} QUARANTINED — ${closeRes.reason}. MANUAL CHECK REQUIRED`));
                      await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                        exchange: `${pos.longExchange}+${pos.shortExchange}`,
                        marginPct: 0, threshold: 0, symbol: pos.symbol,
                        message: `CLOSE QUARANTINED: ${closeRes.reason}. Manual check required.`,
                      });
                    }
                  } catch (err) {
                    logExecution({
                      type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                      symbol: pos.symbol, side: "close", size: String(pos.size),
                      status: "failed", dryRun: false,
                      error: err instanceof Error ? err.message : String(err),
                      meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, reason: closeReason, exitReason },
                    });
                    console.error(chalk.red(`  ${now} CLOSE FAILED ${pos.symbol}: ${err instanceof Error ? err.message : err}`));
                    // Do NOT splice — nothing was sent (adapter creation failed); retry next cycle
                  }
                } else {
                  // Dry run — remove from the in-memory (simulated) tracking only
                  st.remove(pos.symbol);
                  closeCooldowns.set(pos.symbol, Date.now());
                  openPositions.splice(i, 1);
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(chalk.red(`  ${new Date().toLocaleTimeString()} EXIT CHECK FAILED ${pos.symbol} (${pos.longExchange}/${pos.shortExchange}): ${msg}`));
            }
          }

          // Log next settlement times and funding estimation
          if (!isJson() && settleStrategy !== "off") {
            const nowDate = new Date();
            const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e === "aster" ? "AST" : e.toUpperCase();
            const nextHL = getNextSettlement("hyperliquid", nowDate);
            const nextPAC = getNextSettlement("pacifica", nowDate);
            const nextLT = getNextSettlement("lighter", nowDate);
            const fmtMin = (d: Date) => Math.max(0, Math.round((d.getTime() - nowDate.getTime()) / 60000));
            const hoursUntilPAC = (nextPAC.getTime() - nowDate.getTime()) / 3600000;
            const hUTC = nextPAC.getUTCHours().toString().padStart(2, "0");
            console.log(chalk.gray(
              `  ${now} Next settlements: HL ${fmtMin(nextHL)}m | PAC ${fmtMin(nextPAC)}m | LT ${fmtMin(nextLT)}m`
            ));
            for (const fPos of openPositions) {
              const fSnap = filtered.find(s => s.symbol === fPos.symbol);
              if (!fSnap) continue;
              const fRateFor = (e: string) => e === "pacifica" ? fSnap.pacRate : e === "hyperliquid" ? fSnap.hlRate : e === "aster" ? fSnap.astRate : fSnap.ltRate;
              const fHlHourly = toHourlyRate(fRateFor("hyperliquid"), "hyperliquid");
              const fPacHourly = toHourlyRate(fRateFor("pacifica"), "pacifica");
              const fNotional = fPos.size * fSnap.markPrice;
              const fEst = estimateFundingUntilSettlement(fHlHourly, fPacHourly, fNotional, hoursUntilPAC);
              console.log(chalk.gray(
                `  ${now} ${fPos.symbol} Next PAC: ${hUTC}:00 UTC (${hoursUntilPAC.toFixed(1)}h) | ` +
                `HL cum: ~$${fEst.hlCumulative.toFixed(4)} | PAC pmt: ~$${fEst.pacPayment.toFixed(4)} | ` +
                `Net: ~$${fEst.netFunding.toFixed(4)}`
              ));
            }
          }

          // ── Cross-chain margin monitoring ──
          blockedExchanges.clear();

          // Exchange status check — infer from fetchFundingSpreads results
          // If an exchange returned rates in the scan, it's up. No extra API calls needed.
          const downExchanges = new Set<string>();
          const hasHL = filtered.some(s => s.hlRate !== 0) || spreads.some(s => s.hlRate !== 0);
          const hasLT = filtered.some(s => s.ltRate !== 0) || spreads.some(s => s.ltRate !== 0);
          const hasPAC = filtered.some(s => s.pacRate !== 0) || spreads.some(s => s.pacRate !== 0);
          if (!hasHL) { downExchanges.add("hyperliquid"); blockedExchanges.add("hyperliquid"); }
          if (!hasLT) { downExchanges.add("lighter"); blockedExchanges.add("lighter"); }
          if (!hasPAC) { downExchanges.add("pacifica"); blockedExchanges.add("pacifica"); }
          for (const name of downExchanges) {
            console.log(chalk.red(`  ${now} EXCHANGE DOWN: ${name} — blocking new entries`));
          }

          // Mark existing positions on down exchanges as degraded
          for (const pos of openPositions) {
            if (downExchanges.has(pos.longExchange) || downExchanges.has(pos.shortExchange)) {
              console.log(chalk.yellow(
                `  ${now} DEGRADED ${pos.symbol}: ${downExchanges.has(pos.longExchange) ? pos.longExchange : pos.shortExchange} is down`
              ));
            }
          }

          // Only check margins when we have open positions (avoid slow adapter init).
          // An unreadable margin is UNKNOWN, never healthy: logged every cycle (stderr) and new
          // entries on that venue are blocked (closing / reducing stays allowed).
          if (openPositions.length > 0) {
            const marginCheck: ChainMarginCheck = { statuses: [], unknown: [] };
            try {
              const adaptersMap = new Map<string, ExchangeAdapter>();
              for (const name of ["hyperliquid", "lighter", "pacifica"]) {
                try {
                  const a = await getAdapterForExchange(name);
                  // No credentials (read-only adapter): no positions / margin there to monitor, and
                  // the bot cannot enter on it either — not "unknown".
                  if ((a as { isReadOnly?: unknown }).isReadOnly === true) { blockedExchanges.add(name); continue; }
                  adaptersMap.set(name, a);
                } catch (e) { marginCheck.unknown.push({ exchange: name, error: `adapter init failed: ${e instanceof Error ? e.message : String(e)}` }); }
              }
              if (adaptersMap.size > 0) {
                const res = await checkChainMargins(adaptersMap, minMarginPct);
                marginCheck.statuses.push(...res.statuses);
                marginCheck.unknown.push(...res.unknown);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              for (const name of ["hyperliquid", "lighter", "pacifica"]) {
                if (blockedExchanges.has(name)) continue;
                if (!marginCheck.statuses.some(s => s.exchange === name) && !marginCheck.unknown.some(u => u.exchange === name)) marginCheck.unknown.push({ exchange: name, error: msg });
              }
            }
            const nowUnknown = new Set<string>();
            for (const b of marginEntryBlocks(marginCheck, minMarginPct)) {
              blockedExchanges.add(b.exchange);
              if (b.level === "critical") {
                console.log(chalk.red.bold(
                  `  ${now} EMERGENCY: ${b.exchange} margin ratio ${b.marginPct!.toFixed(1)}% — CRITICAL (below 15%)`
                ));
                await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                  exchange: b.exchange, marginPct: b.marginPct, threshold: 15,
                });
              } else if (b.level === "low") {
                console.log(chalk.yellow(
                  `  ${now} WARNING: ${b.exchange} margin ${b.marginPct!.toFixed(1)}% below ${minMarginPct}% — blocking new entries`
                ));
                await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                  exchange: b.exchange, marginPct: b.marginPct, threshold: minMarginPct,
                });
              } else {
                nowUnknown.add(b.exchange);
                console.error(chalk.yellow(`  ${now} MARGIN UNKNOWN: ${b.exchange} (${b.error}) — blocking new entries until margin is readable`));
                // Webhook once per transition into unknown (stderr carries the per-cycle signal).
                if (!marginUnknownNotified.has(b.exchange)) {
                  await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                    exchange: b.exchange, marginPct: null, threshold: minMarginPct,
                    message: `MARGIN UNKNOWN: ${b.exchange} (${b.error}) — new entries blocked`,
                  });
                }
              }
            }
            marginUnknownNotified.clear();
            for (const ex of nowUnknown) marginUnknownNotified.add(ex);
          }

          // Entry decisions: every monitored symbol that is not entered gets its reason — logged per
          // symbol for --symbols, summarized per cycle for a full scan (a silent run is impossible).
          const skipCounts = new Map<string, number>();
          const skip = (sym: string, reason: string): void => {
            if (filterSymbols) console.log(chalk.gray(`  ${now} SKIP ${sym}: ${reason}`));
            else { const k = reason.replace(/[-\d.]+/g, "#"); skipCounts.set(k, (skipCounts.get(k) ?? 0) + 1); }
          };
          for (const sym of filterSymbols ?? []) {
            if (!filtered.some(x => x.symbol === sym)) console.log(chalk.gray(`  ${now} SKIP ${sym}: not in this cycle's funding scan (no rate on two compared venues)`));
          }
          if (openPositions.length >= maxPositions) {
            console.log(chalk.gray(`  ${now} NO ENTRY: max positions reached (${openPositions.length}/${maxPositions}: ${openPositions.map(p => `${p.symbol} ${p.longExchange}/${p.shortExchange}`).join(", ")})`));
          }
          if (openPositions.length < maxPositions) {
            for (const snap of filtered) {
              if (stop.requested()) { console.log(chalk.yellow(`  ${now} STOP requested — no new entries`)); break; }
              if (openPositions.some(p => p.symbol === snap.symbol)) { skip(snap.symbol, "already open"); continue; }
              // Global quarantine: unknown / unhedged outcome on this symbol somewhere.
              if (isQuarantined(snap.symbol, (m) => console.log(chalk.red(m)))) { skip(snap.symbol, "quarantined"); continue; }
              // A persisted spot-perp position on this symbol (not daemon-managed) blocks entry:
              // the state is keyed by symbol, so a new perp-perp entry would overwrite it.
              if (syncState?.positions.some(p => p.mode === "spot-perp" && p.symbol === snap.symbol)) { skip(snap.symbol, "a spot-perp arb state entry exists for this symbol"); continue; }
              if (staleSymbols.has(snap.symbol)) { skip(snap.symbol, `a stale arb state entry exists (drop it: perp arb close ${snap.symbol} --state-only)`); continue; }
              if (openPositions.length >= maxPositions) { skip(snap.symbol, `max positions reached (${maxPositions})`); break; }

              // Cooldown: skip if recently closed to prevent close→re-entry loops
              const lastCloseMs = closeCooldowns.get(snap.symbol);
              if (lastCloseMs && cooldownMinutes > 0) {
                const elapsedMin = (Date.now() - lastCloseMs) / 60000;
                if (elapsedMin < cooldownMinutes) {
                  console.log(chalk.gray(
                    `  ${now} SKIP ${snap.symbol}: cooldown ${(cooldownMinutes - elapsedMin).toFixed(0)}m remaining`
                  ));
                  continue;
                }
                // Cooldown expired, clean up
                closeCooldowns.delete(snap.symbol);
              }

              const grossSpread = Math.abs(snap.spread);

              // Determine direction using all 3 exchanges: short the high-funding, long the low-funding
              const longExchange = snap.longExch;
              const shortExchange = snap.shortExch;

              // Block entries if either exchange has low margin
              if (blockedExchanges.has(longExchange) || blockedExchanges.has(shortExchange)) {
                skip(snap.symbol, `entries blocked on ${blockedExchanges.has(longExchange) ? longExchange : shortExchange} (margin low / margin unknown / venue down)`);
                continue;
              }

              // Compute net spread after fees and bridge costs
              const roundTripCost = computeRoundTripCostPct(longExchange, shortExchange);
              const effectiveSizeUsd = sizeIsAuto ? 100 : sizeUsd; // Use $100 for net spread calc when auto
              const netSpread = computeNetSpread(grossSpread, holdDays, roundTripCost, bridgeCostUsd, effectiveSizeUsd);

              // Settlement timing check with strategy (Aster interval is per symbol)
              const snapMarketInterval = (ex: string): number | null => ex === "aster" ? snap.astHours : null;
              if (settleStrategy === "block") {
                const settlCheck = isNearSettlement(longExchange, shortExchange, 5, new Date(), snapMarketInterval);
                if (settlCheck.blocked) {
                  console.log(chalk.gray(
                    `  ${now} SKIP ${snap.symbol}: ${settlCheck.minutesUntil?.toFixed(1)}m before ${settlCheck.exchange} settlement`
                  ));
                  continue;
                }
              }

              // In aggressive mode, boost score for post-settlement entries
              let settleBoostMultiplier = 1.0;
              if (settleStrategy === "aggressive") {
                settleBoostMultiplier = aggressiveSettleBoost(longExchange, shortExchange, 10, new Date(), snapMarketInterval);
                if (settleBoostMultiplier > 1.0) {
                  console.log(chalk.cyan(
                    `  ${now} BOOST ${snap.symbol}: post-settlement ${((settleBoostMultiplier - 1) * 100).toFixed(0)}% score boost`
                  ));
                }
              }

              // --min-spread compares against NET spread (with settle boost applied)
              const effectiveNetSpread = netSpread * settleBoostMultiplier;
              if (effectiveNetSpread < minSpread) {
                skip(snap.symbol, `net spread ${effectiveNetSpread.toFixed(2)}% < --min-spread ${minSpread}% (gross ${grossSpread.toFixed(2)}%, round-trip cost ${roundTripCost.toFixed(3)}% over ${holdDays}d; long ${longExchange} / short ${shortExchange})`);
                continue;
              }

              const rateForExch = (e: string) => e === "pacifica" ? snap.pacRate : e === "hyperliquid" ? snap.hlRate : e === "aster" ? snap.astRate : snap.ltRate;

              console.log(chalk.green(
                `  ${now} ENTER ${snap.symbol} — gross ${grossSpread.toFixed(1)}% net ${netSpread.toFixed(1)}%` +
                ` | Long ${longExchange} (${(rateForExch(longExchange) * 100).toFixed(4)}%)` +
                ` | Short ${shortExchange} (${(rateForExch(shortExchange) * 100).toFixed(4)}%)`
              ));

              // Calculate size in asset units from USD and mark price
              if (snap.markPrice <= 0) {
                console.error(chalk.red(`  ${now} SKIP ${snap.symbol}: no mark price available`));
                continue;
              }

              // Dynamic sizing: compute auto size if --size auto
              let actualSizeUsd = sizeUsd;
              if (sizeIsAuto) {
                try {
                  const longAdapter = await getAdapterForExchange(longExchange);
                  const shortAdapter = await getAdapterForExchange(shortExchange);
                  actualSizeUsd = await computeAutoSize(longAdapter, shortAdapter, legSymbol(snap, longExchange), 0.3, legSymbol(snap, shortExchange));
                  if (actualSizeUsd <= 0) {
                    console.log(chalk.gray(`  ${now} SKIP ${snap.symbol}: auto-size returned $0 (insufficient depth/margin)`));
                    continue;
                  }
                  console.log(chalk.gray(`  ${now} Auto-size ${snap.symbol}: $${actualSizeUsd}`));
                } catch (err) {
                  console.log(chalk.gray(`  ${now} SKIP ${snap.symbol}: auto-size failed — ${err instanceof Error ? err.message : err}`));
                  continue;
                }
              }

              if (sizeIsAuto && actualSizeUsd < minSizeUsd) {
                console.log(chalk.gray(`  ${now} SKIP ${snap.symbol}: auto-size $${actualSizeUsd} below min $${minSizeUsd}`));
                continue;
              }
              // Floored (never rounds up past the requested notional).
              const sizeInAsset = fillSizeString(actualSizeUsd / snap.markPrice, 4);
              if (!(Number(sizeInAsset) > 0)) {
                console.log(chalk.gray(`  ${now} SKIP ${snap.symbol}: size rounds to 0 ($${actualSizeUsd} / $${snap.markPrice})`));
                continue;
              }
              /** Size actually hedged on both legs (verified); the requested size in dry-run. */
              let openedSize = sizeInAsset;

              if (!dryRun) {
                // Pending-entry record BEFORE the first leg (crash between legs → quarantine at the next start).
                const net = networkOf(program);
                try {
                  writePendingEntry(net, { source: "arb-auto", symbol: snap.symbol, longExchange, shortExchange, size: sizeInAsset });
                } catch (e) {
                  console.error(chalk.red(`  ${now} SKIP ${snap.symbol}: could not record the pending entry (${e instanceof Error ? e.message : String(e)}) — nothing sent`));
                  continue;
                }
                const donePending = () => finishPendingEntry(net, "arb-auto", snap.symbol, (m) => console.error(chalk.red(m)));
                let legsStarted = false;
                try {
                  const longAdapter = await getAdapterForExchange(longExchange);
                  const shortAdapter = await getAdapterForExchange(shortExchange);

                  // Sequential verified legs: long, then short sized to the
                  // long's verified fill; reduce-only rollback / trim; unknown → quarantine.
                  legsStarted = true;
                  const res = await openPerpPairVerified({
                    source: "arb-auto", sym: snap.symbol,
                    longAdapter, longExch: longExchange, longSym: legSymbol(snap, longExchange), shortAdapter, shortExch: shortExchange, shortSym: legSymbol(snap, shortExchange),
                    size: sizeInAsset, smart: false, log: (m) => console.log(chalk.red(m)),
                  });
                  legsStarted = false; // outcome known (opened / not opened / quarantined)

                  if (res.status === "opened") {
                    openedSize = res.hedged;
                    logExecution({
                      type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                      symbol: snap.symbol, side: "entry", size: res.hedged,
                      status: "success", dryRun: false,
                      meta: { longExchange, shortExchange, grossSpread, netSpread, roundTripCost, markPrice: snap.markPrice, requested: sizeInAsset, trimmed: res.trimmed },
                    });
                    console.log(chalk.green(`  ${now} FILLED ${snap.symbol} — both legs @ ${res.hedged} units (requested ${sizeInAsset}; $${actualSizeUsd} / $${snap.markPrice.toFixed(2)})`));

                    // Persist to state file immediately (crash-safe) — the verified hedged size.
                    const entryTime = new Date().toISOString();
                    try {
                      st.add({
                        id: `${snap.symbol}-${Date.now()}`,
                        symbol: snap.symbol,
                        longExchange,
                        shortExchange,
                        longSize: parseFloat(res.hedged),
                        shortSize: parseFloat(res.hedged),
                        entryTime,
                        entrySpread: grossSpread,
                        entryLongPrice: snap.markPrice,
                        entryShortPrice: snap.markPrice,
                        accumulatedFunding: 0,
                        lastCheckTime: entryTime,
                        ...legSymbolsOf(snap, longExchange, shortExchange),
                      });
                    } catch (e) {
                      // A hedged pair the state cannot record (write failed / conflicting entry): never
                      // left as silent exposure — quarantined with what is open.
                      quarantinePair("arb-auto", snap.symbol, longExchange, shortExchange,
                        `entry opened (long ${res.hedged} on ${longExchange} / short ${res.hedged} on ${shortExchange}) but the arb state could not record it: ${e instanceof Error ? e.message : String(e)}`,
                        (m) => console.log(chalk.red(m)));
                    }
                    donePending();

                    await notifyIfEnabled(webhookUrl, notifyEvents, "entry", {
                      symbol: snap.symbol, longExchange, shortExchange,
                      size: actualSizeUsd, netSpread,
                    });
                  } else if (res.status === "not_opened") {
                    logExecution({
                      type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                      symbol: snap.symbol, side: "entry", size: sizeInAsset,
                      status: "failed", dryRun: false,
                      error: `${res.reason}${res.rolledBack !== null ? ` — long ${res.rolledBack} rolled back (reduce-only, verified)` : ""}`,
                      meta: { longExchange, shortExchange, grossSpread, netSpread },
                    });
                    console.error(chalk.red(`  ${now} ENTRY FAILED ${snap.symbol}: ${res.reason}${res.rolledBack !== null ? ` — rolled back long ${res.rolledBack}; no open exposure` : " — nothing opened"}`));
                    donePending();
                    // Cool down like a close: a leg the venue rejects (unknown symbol, lot, margin)
                    // is not re-sent — with its fees and rollback — every cycle.
                    closeCooldowns.set(snap.symbol, Date.now());
                    continue;
                  } else {
                    donePending(); // quarantined (persisted) by openPerpPairVerified
                    logExecution({
                      type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                      symbol: snap.symbol, side: "entry", size: sizeInAsset,
                      status: "failed", dryRun: false,
                      error: `QUARANTINED: ${res.reason}`,
                      meta: { longExchange, shortExchange, grossSpread, netSpread, quarantined: true, exposure: res.exposure },
                    });
                    console.log(chalk.red.bold(`  ${now} IMBALANCE ${snap.symbol}: ${res.exposure} — quarantined, MANUAL CHECK REQUIRED`));
                    await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                      exchange: `${longExchange}+${shortExchange}`,
                      marginPct: 0,
                      threshold: 0,
                      symbol: snap.symbol,
                      message: `ENTRY QUARANTINED: ${res.reason}. Possible exposure: ${res.exposure}. Manual check required.`,
                    });
                    continue; // not tracked as a hedged pair; the quarantine blocks every path
                  }
                } catch (err) {
                  logExecution({
                    type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                    symbol: snap.symbol, side: "entry", size: sizeInAsset,
                    status: "failed", dryRun: false,
                    error: err instanceof Error ? err.message : String(err),
                    meta: { longExchange, shortExchange, grossSpread, netSpread },
                  });
                  if (legsStarted) {
                    // Threw inside the leg sequence: what is open is unknown → quarantine (never retried).
                    quarantinePair("arb-auto", snap.symbol, longExchange, shortExchange,
                      `entry threw mid-sequence (${err instanceof Error ? err.message : String(err)}) — legs may be open`, (m) => console.log(chalk.red(m)));
                  }
                  donePending();
                  console.error(chalk.red(`  ${now} ENTRY FAILED ${snap.symbol}: ${err instanceof Error ? err.message : err}`));
                  continue;
                }
              }

              const posEntryTime = new Date().toISOString();
              openPositions.push({
                symbol: snap.symbol,
                longExchange,
                shortExchange,
                size: parseFloat(openedSize),
                entrySpread: grossSpread,
                entryTime: posEntryTime,
                entryMarkPrice: snap.markPrice,
                accumulatedFundingUsd: 0,
                lastCheckTime: Date.now(),
                ...legSymbolsOf(snap, longExchange, shortExchange),
              });

              // Dry-run: record the simulated entry in the in-memory state only (never the real file).
              if (dryRun) {
                st.add({
                  id: `${snap.symbol}-${Date.now()}`,
                  symbol: snap.symbol,
                  longExchange,
                  shortExchange,
                  longSize: parseFloat(sizeInAsset),
                  shortSize: parseFloat(sizeInAsset),
                  entryTime: posEntryTime,
                  entrySpread: grossSpread,
                  entryLongPrice: snap.markPrice,
                  entryShortPrice: snap.markPrice,
                  accumulatedFunding: 0,
                  lastCheckTime: posEntryTime,
                });
              }
            }
          }

          if (skipCounts.size > 0) {
            console.log(chalk.gray(`  ${now} NO ENTRY (${[...skipCounts.values()].reduce((x, y) => x + y, 0)} symbols): ${[...skipCounts].map(([k, n]) => `${n}× ${k}`).join("; ")}`));
          }

          // Accumulate estimated funding income & show status
          if (openPositions.length > 0) {
            const nowMs = Date.now();
            for (const pos of openPositions) {
              const current = filtered.find(s => s.symbol === pos.symbol);
              if (!current) continue;
              const elapsedHours = (nowMs - pos.lastCheckTime) / (1000 * 60 * 60);
              const notional = pos.size * current.markPrice;
              // Estimate funding collected: normalize all rates to hourly before comparing
              const longHourly = snapshotHourly(current, pos.longExchange);
              const shortHourly = snapshotHourly(current, pos.shortExchange);
              // Income = short gets paid positive funding, long pays; net = (shortRate - longRate) * notional * hours
              const hourlyIncome = (shortHourly - longHourly) * notional;
              pos.accumulatedFundingUsd += hourlyIncome * elapsedHours;
              pos.lastCheckTime = nowMs;
            }

            const totalFunding = openPositions.reduce((s, p) => s + p.accumulatedFundingUsd, 0);
            const fundingColor = totalFunding >= 0 ? chalk.green : chalk.red;
            console.log(chalk.gray(
              `  ${now} Status: ${openPositions.length} positions | ` +
              `Est. funding: ${fundingColor(`$${totalFunding.toFixed(4)}`)} — ` +
              openPositions.map(p =>
                `${p.symbol}(${p.entrySpread.toFixed(0)}% $${p.accumulatedFundingUsd.toFixed(3)})`
              ).join(", ")
            ));
          }

          // Update heartbeat: mark successful scan
          const stateForHeartbeat = st.load();
          if (stateForHeartbeat) {
            stateForHeartbeat.lastSuccessfulScanTime = new Date().toISOString();
            stateForHeartbeat.lastScanTime = new Date().toISOString();
            st.save(stateForHeartbeat);
          }
        } catch (err) {
          console.error(chalk.gray(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        }
      };

      // Serialized cycles (never overlapping): the next starts only after this one finished.
      while (!stop.requested()) {
        await cycle();
        await interruptibleSleep(intervalMs, stop.requested);
      }
      const finalState = st.load();
      if (finalState) {
        finalState.lastScanTime = new Date().toISOString();
        st.save(finalState);
      }
      stop.dispose();
      if (!isJson()) console.log(chalk.yellow("\n  Daemon stopped (current cycle finished). State saved.\n"));
      process.exit(0);
    });

  // ── arb scan ── (one-shot spread scan)

  arb
    .command("scan")
    .description("Scan funding spreads, rates, basis, gaps, HIP-3, or positions (--live for continuous monitoring)")
    .option("--mode <mode>", "Scan mode: all, perp-perp, spot-perp", "all")
    .option("--min <pct>", "Min annual spread to show", "10")
    .option("--top <n>", "Return only top N results (for JSON output)")
    .option("--hold-days <days>", "Expected hold period for cost calc", "7")
    .option("--bridge-cost <usd>", "One-way bridge cost in USD", "0")
    .option("--size <usd>", "Position size per leg ($) for cost calc", "100")
    .option("--rates", "Show funding rates across all exchanges")
    .option("--basis [symbol]", "Scan cross-exchange basis opportunities (optionally for a specific symbol)")
    .option("--hip3", "Scan HIP-3 cross-dex funding spreads")
    .option("--compare <symbol>", "Compare funding rates for a specific symbol")
    .option("--history [symbol]", "Show funding rate history (optionally for a specific symbol)")
    .option("--positions", "Show position funding impact")
    .option("-s, --symbol <sym>", "Filter/track symbol")
    .option("--symbols <list>", "Comma-separated list of symbols")
    .option("--all", "Include all symbols (not just top)")
    .option("--hours <n>", "Hours of history to show", "24")
    .option("--max-gap <pct>", "Max price gap % (hip3 mode)")
    .option("--include-native", "Include native HL perps (hip3 mode)", true)
    .option("--no-include-native", "Exclude native HL perps (hip3 mode)")
    .option("--gaps", "Show cross-exchange price gaps")
    .option("--live", "Continuous live monitoring (auto-refresh)")
    .option("--track", "Track a symbol's price gap over time (requires -s)")
    .option("--alert <pct>", "Alert when price gap exceeds threshold % (requires -s)")
    .option("--interval <seconds>", "Refresh interval for --live mode", "60")
    .option("--duration <minutes>", "Track duration in minutes (with --track)", "10")
    .option("--beep", "Beep on large gaps (with --gaps)")
    .option("--check-liquidity", "Check orderbook depth in live mode (slower)")
    .option("--include-unverified", "With --rates / --compare: also show venues whose funding rate is unverified (qfex; txflow — unofficial API; variational; grvt — indicative rate; extended) — display only, never ranked for trading")
    .action(async (opts: {
      includeUnverified?: boolean;
      mode: string; min: string; top?: string; holdDays: string; bridgeCost: string; size: string;
      rates?: boolean; basis?: boolean | string; hip3?: boolean; compare?: string;
      history?: boolean | string; positions?: boolean;
      symbol?: string; symbols?: string; all?: boolean;
      hours: string; maxGap?: string; includeNative: boolean;
      gaps?: boolean; live?: boolean; track?: boolean; alert?: string;
      interval: string; duration: string; beep?: boolean; checkLiquidity?: boolean;
    }) => {
      // ── Price gap modes ──
      if (opts.gaps || opts.track || opts.alert) {
        const sym = opts.symbol?.toUpperCase();
        const minGap = parseFloat(opts.min);
        const intervalMs = parseInt(opts.interval) * 1000;

        // Alert mode
        if (opts.alert) {
          if (!sym) { console.log(chalk.red("  --alert requires --symbol or -s")); return; }
          const threshold = parseFloat(opts.alert);
          if (!isJson()) console.log(chalk.cyan(`\n  Waiting for ${sym} gap > ${threshold}%...\n`));
          const check = async (): Promise<boolean> => {
            const snapshots = await fetchAllPrices();
            const s = snapshots.find((x) => x.symbol === sym);
            if (!s) return false;
            const now = new Date().toLocaleTimeString();
            if (!isJson()) console.log(chalk.gray(`  ${now} ${sym} gap: ${s.maxGapPct.toFixed(4)}%`));
            if (s.maxGapPct >= threshold) {
              if (isJson()) { printJson(jsonOk(s)); }
              else {
                console.log(chalk.green.bold(`\n  TRIGGERED! ${sym} gap: ${s.maxGapPct.toFixed(4)}% (> ${threshold}%)`));
                const lines: string[] = [];
                if (s.pacPrice !== null) lines.push(`  Pacifica:    $${formatGapPrice(s.pacPrice)}`);
                if (s.hlPrice !== null) lines.push(`  Hyperliquid: $${formatGapPrice(s.hlPrice)}`);
                if (s.ltPrice !== null) lines.push(`  Lighter:     $${formatGapPrice(s.ltPrice)}`);
                lines.push(`  Gap:         $${s.maxGap.toFixed(4)} (${s.cheapest}→${s.expensive})`);
                console.log(lines.join("\n") + "\n");
              }
              return true;
            }
            return false;
          };
          if (await check()) return;
          await new Promise<void>((resolve) => {
            const timer = setInterval(async () => { if (await check()) { clearInterval(timer); resolve(); } }, intervalMs);
          });
          return;
        }

        // Track mode
        if (opts.track) {
          if (!sym) { console.log(chalk.red("  --track requires --symbol or -s")); return; }
          const durationMs = parseInt(opts.duration) * 60 * 1000;
          const endTime = Date.now() + durationMs;
          const samples: { time: string; gap: number; gapPct: number; direction: string }[] = [];
          if (!isJson()) {
            console.log(chalk.cyan.bold(`\n  Tracking ${sym} price gap\n`));
            console.log(`  Duration:  ${opts.duration} min`);
            console.log(`  Interval:  ${opts.interval}s`);
            console.log(chalk.gray("  Collecting samples...\n"));
          }
          const sample = async () => {
            const snapshots = await fetchAllPrices();
            const s = snapshots.find((x) => x.symbol === sym);
            if (!s) { console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} — ${sym} not found on both exchanges`)); return; }
            samples.push({ time: new Date().toLocaleTimeString(), gap: s.maxGap, gapPct: s.maxGapPct, direction: `${s.cheapest}→${s.expensive}` });
            const gapColor = s.maxGapPct >= 0.1 ? chalk.yellow : chalk.gray;
            const parts = [`PAC: ${s.pacPrice !== null ? "$" + formatGapPrice(s.pacPrice) : "-"}`];
            parts.push(`HL: ${s.hlPrice !== null ? "$" + formatGapPrice(s.hlPrice) : "-"}`);
            parts.push(`LT: ${s.ltPrice !== null ? "$" + formatGapPrice(s.ltPrice) : "-"}`);
            console.log(`  ${chalk.white(s.symbol.padEnd(6))} ${parts.join("  ")}  ${gapColor(`${s.maxGapPct.toFixed(4)}%`)}  ${s.cheapest}→${s.expensive}`);
          };
          await sample();
          const timer = setInterval(async () => { if (Date.now() >= endTime) { clearInterval(timer); printTrackSummary(sym, samples); return; } await sample(); }, intervalMs);
          await new Promise<void>((resolve) => { setTimeout(resolve, durationMs + 1000); });
          return;
        }

        // Gaps snapshot (default for --gaps without --live)
        if (!isJson()) console.log(chalk.cyan("\n  Fetching prices from Pacifica, Hyperliquid & Lighter...\n"));
        let snapshots = await fetchAllPrices();
        if (sym) snapshots = snapshots.filter((s) => s.symbol.includes(sym));
        if (opts.top) snapshots = snapshots.slice(0, parseInt(opts.top));
        if (isJson()) return printJson(jsonOk(snapshots.filter((s) => s.maxGapPct >= minGap)));
        printGapTable(snapshots, minGap);
        return;
      }

      // ── Live monitoring mode ──
      if (opts.live) {
        // If --hip3, route to dex monitor
        if (opts.hip3) {
          return handleDexMonitor({ ...opts, top: opts.top ?? "15" });
        }

        // Perp-perp live funding spread monitor
        const minSpread = parseFloat(opts.min);
        const intervalSec = parseInt(opts.interval);
        const topN = parseInt(opts.top ?? "15");
        const checkLiq = opts.checkLiquidity ?? false;
        const holdDays = parseFloat(opts.holdDays);
        const bridgeCostUsd = parseFloat(opts.bridgeCost);
        const sizeUsd = parseFloat(opts.size);
        let cycle = 0;

        if (!isJson()) {
          console.log(chalk.cyan.bold("\n  Funding Arb Monitor"));
          console.log(chalk.gray(`  Min spread: ${minSpread}% | Refresh: ${intervalSec}s | Top: ${topN}`));
          console.log(chalk.gray(`  Net spread: ${holdDays}d hold, $${bridgeCostUsd} bridge, $${sizeUsd} size`));
          if (checkLiq) console.log(chalk.gray(`  Liquidity check: ON`));
          console.log(chalk.gray(`  Press Ctrl+C to stop\n`));
        }

        const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e === "aster" ? "AST" : e.toUpperCase();

        while (true) {
          cycle++;
          const ts = new Date().toLocaleTimeString();
          try {
            const spreads = await fetchFundingSpreads();
            const filtered = spreads.filter(s => Math.abs(s.spread) >= minSpread).slice(0, topN);
            if (cycle > 1) {
              const linesToClear = filtered.length + 4;
              process.stdout.write(`\x1b[${linesToClear}A\x1b[J`);
            }
            console.log(chalk.gray(`  ${ts} — Cycle ${cycle} | ${filtered.length} opportunities >= ${minSpread}%\n`));
            if (filtered.length === 0) {
              console.log(chalk.gray(`  No opportunities found.\n`));
            } else {
              const liqData = new Map<string, { hlDepth: number; ltDepth: number; gap: string }>();
              if (checkLiq && filtered.length > 0) {
                const topCheck = filtered.slice(0, 5);
                await Promise.allSettled(topCheck.map(async (s) => {
                  try {
                    const [hlOB, ltOB] = await Promise.all([fetchHLOrderbook(legSymbol(s, "hyperliquid")), fetchLighterOrderbook(legSymbol(s, "lighter"))]);
                    const hlDepth = hlOB.reduce((sum, l) => sum + l[0] * l[1], 0);
                    const ltDepth = ltOB.reduce((sum, l) => sum + l[0] * l[1], 0);
                    const hlBest = hlOB[0]?.[0] ?? 0;
                    const ltBest = ltOB[0]?.[0] ?? 0;
                    const gap = hlBest && ltBest ? (Math.abs(hlBest - ltBest) / Math.min(hlBest, ltBest) * 100).toFixed(3) : "?";
                    liqData.set(s.symbol, { hlDepth: Math.round(hlDepth), ltDepth: Math.round(ltDepth), gap });
                  } catch { /* skip */ }
                }));
              }
              for (const s of filtered) {
                const direction = `${exAbbr(s.shortExch)}>${exAbbr(s.longExch)}`;
                const grossSpread = Math.abs(s.spread);
                const rtCost = computeRoundTripCostPct(s.longExch, s.shortExch);
                const netSpread = computeNetSpread(grossSpread, holdDays, rtCost, bridgeCostUsd, sizeUsd);
                const grossColor = grossSpread >= 50 ? chalk.green.bold : grossSpread >= 30 ? chalk.green : chalk.yellow;
                const netColor = netSpread >= 20 ? chalk.green : netSpread >= 0 ? chalk.yellow : chalk.red;
                const rates: string[] = [];
                // Each leg names which rate it is (lastSettled / accruing / predicted; ? = unverified).
                if (s.pacRate) rates.push(`PAC:${(s.pacRate * 100).toFixed(4)}%${kindTag(s, "pacifica")}`);
                if (s.hlRate) rates.push(`HL:${(s.hlRate * 100).toFixed(4)}%${kindTag(s, "hyperliquid")}`);
                if (s.ltRate) rates.push(`LT:${(s.ltRate * 100).toFixed(4)}%${kindTag(s, "lighter")}`);
                let liqInfo = "";
                const ld = liqData.get(s.symbol);
                if (ld) liqInfo = chalk.gray(` | depth: HL $${ld.hlDepth.toLocaleString()} LT $${ld.ltDepth.toLocaleString()} gap:${ld.gap}%`);
                console.log(
                  `  ${chalk.white.bold(s.symbol.padEnd(8))} ` +
                  `${grossColor(`${grossSpread.toFixed(1)}%`.padEnd(8))} ` +
                  `${netColor(`net:${netSpread.toFixed(1)}%`.padEnd(12))} ` +
                  `${direction.padEnd(7)} ` +
                  rates.join(" ") + liqInfo
                );
              }
              console.log(chalk.gray(`  * Net spreads are predicted estimates (${holdDays}d hold, $${bridgeCostUsd} bridge)`));
              console.log();
            }
          } catch (err) {
            console.log(chalk.red(`  ${ts} Error: ${err instanceof Error ? err.message : err}\n`));
          }
          await new Promise(r => setTimeout(r, intervalSec * 1000));
        }
      }

      // Route to specialized handlers
      if (opts.includeUnverified === true && !opts.compare && !opts.rates) {
        throw new PerpError("INVALID_PARAMS", "--include-unverified applies to --rates / --compare only: unverified funding rates are shown, never ranked as arb opportunities", {
          remediation: "perp arb scan --rates --include-unverified   (or: --compare <symbol> --include-unverified)",
        });
      }
      if (opts.compare) return handleCompare(isJson, opts.compare, opts.includeUnverified === true);
      if (opts.rates) return handleRates(isJson, { symbol: opts.symbol, symbols: opts.symbols, all: opts.all, minSpread: opts.min, top: opts.top, includeUnverified: opts.includeUnverified === true });
      if (opts.basis) return handleBasisScan(isJson, { minBasis: opts.min, symbol: typeof opts.basis === "string" ? opts.basis : opts.symbol });
      if (opts.hip3) return handleDexScan(isJson, { minSpread: opts.min, maxGap: opts.maxGap || "5", includeNative: opts.includeNative !== false, top: opts.top || "20" });
      // The exchange filter (--history / --positions) is the ROOT -e/--exchange (commander gives it
      // to the root program): used only when passed on the command line, never the root default venue.
      const exchangeFilter = program.getOptionValueSource("exchange") === "cli" ? String(program.opts().exchange) : undefined;
      if (opts.history) return handleFundingHistory(isJson, { symbol: (typeof opts.history === "string" ? opts.history : opts.symbol) || "ETH", hours: opts.hours || "24", exchange: exchangeFilter });
      if (opts.positions) return handleFundingPositions(isJson, getAdapterForExchange, { exchanges: exchangeFilter });
      // Default: existing scan logic continues below
      const minSpread = parseFloat(opts.min);
      const holdDays = parseFloat(opts.holdDays);
      const bridgeCostUsd = parseFloat(opts.bridgeCost);
      const sizeUsd = parseFloat(opts.size);
      let spotSpreads: Awaited<ReturnType<typeof import("../funding/rates.js").fetchSpotPerpSpreads>>["spreads"] = [];

      // ── spot-perp mode ──
      if (opts.mode === "spot-perp" || opts.mode === "all") {
        if (!isJson()) console.log(chalk.cyan("\n  Scanning spot+perp funding opportunities...\n"));
        const { fetchSpotPerpSpreads } = await import("../funding/rates.js");
        ({ spreads: spotSpreads } = await fetchSpotPerpSpreads({ minSpread }));

        if (isJson() && opts.mode === "spot-perp") {
          let result = spotSpreads.map(s => {
            // Use best spot exchange for fee calc; spot+perp same legs as perp-perp cost model
            const spotEx = s.spotExchanges[0] || "lighter";
            const rtCost = computeRoundTripCostPct(spotEx, s.perpExchange);
            // Same-exchange spot+perp → no bridge cost
            const effectiveBridgeCost = s.spotExchanges.includes(s.perpExchange) ? 0 : bridgeCostUsd;
            const netSpread = computeNetSpread(s.annualSpreadPct, holdDays, rtCost, effectiveBridgeCost, sizeUsd);
            return {
              mode: "spot-perp" as const, symbol: s.symbol, perpExchange: s.perpExchange,
              // grossSpread / netSpread: the names every other arb scan row uses (same % values);
              // the *Pct names stay for existing consumers.
              spotExchanges: s.spotExchanges, grossSpreadPct: s.annualSpreadPct, grossSpread: s.annualSpreadPct,
              netSpreadPct: netSpread, netSpread, estFeesPct: rtCost,
              perpFundingRate: s.perpFundingRate, direction: s.direction,
              markPrice: s.bestMarkPrice, estHourlyIncomeUsd: s.estHourlyIncomeUsd,
              breakEvenDays: rtCost > 0 ? Math.ceil(rtCost / (s.annualSpreadPct / 365)) : 0,
            };
          }).sort((a, b) => b.netSpreadPct - a.netSpreadPct);
          if (opts.top) result = result.slice(0, parseInt(opts.top));
          return printJson(jsonOk(result));
        }

        if (!isJson()) {
          if (spotSpreads.length === 0) {
            console.log(chalk.gray(`  No spot+perp opportunities above ${minSpread}%\n`));
          } else {
            const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e === "aster" ? "AST" : e.toUpperCase();
            const rows = spotSpreads.slice(0, parseInt(opts.top ?? "30")).map(s => {
              const spotEx = s.spotExchanges[0] || "lighter";
              const rtCost = computeRoundTripCostPct(spotEx, s.perpExchange);
              const effectiveBridgeCost = s.spotExchanges.includes(s.perpExchange) ? 0 : bridgeCostUsd;
              const netSpread = computeNetSpread(s.annualSpreadPct, holdDays, rtCost, effectiveBridgeCost, sizeUsd);
              const breakEvenDays = rtCost > 0 ? Math.ceil(rtCost / (s.annualSpreadPct / 365)) : 0;
              const grossColor = s.annualSpreadPct >= 50 ? chalk.green.bold : s.annualSpreadPct >= 30 ? chalk.green : chalk.yellow;
              const netColor = netSpread >= 20 ? chalk.green : netSpread >= 0 ? chalk.yellow : chalk.red;
              const dir = s.direction === "long-spot-short-perp" ? "Spot+Short" : "Sell+Long";
              return [
                chalk.white.bold(s.symbol),
                grossColor(`${s.annualSpreadPct.toFixed(1)}%`),
                netColor(`${netSpread.toFixed(1)}%`),
                chalk.gray(`${rtCost.toFixed(2)}%`),
                chalk.gray(`${breakEvenDays}d`),
                exAbbr(s.perpExchange),
                s.spotExchanges.map(exAbbr).join(","),
                dir,
              ];
            });
            console.log(makeTable(["Symbol", "Gross", "Net", "Fees", "BE", "Perp", "Spot", "Direction"], rows));
            console.log(chalk.gray(`  ${spotSpreads.length} spot+perp opportunities (spot funding = 0%)`));
            console.log(chalk.gray(`  Net spread assumes ${holdDays}d hold, $${bridgeCostUsd} bridge, $${sizeUsd} size. BE = break-even days`));
          }
        }

        if (opts.mode === "spot-perp") return;
        if (!isJson()) console.log(""); // separator
      }

      // ── perp-perp mode (default) ──
      if (!isJson()) console.log(chalk.cyan("  Scanning perp-perp funding rate spreads...\n"));

      const spreads = await fetchFundingSpreads();
      let filtered = spreads.filter(s => Math.abs(s.spread) >= minSpread);
      if (opts.top) filtered = filtered.slice(0, parseInt(opts.top));

      if (isJson()) {
        const perpPerp: Record<string, unknown>[] = filtered.map(s => {
          const grossSpread = Math.abs(s.spread);
          const rtCost = computeRoundTripCostPct(s.longExch, s.shortExch);
          const net = computeNetSpread(grossSpread, holdDays, rtCost, bridgeCostUsd, sizeUsd);
          // Compute price gap between long and short exchanges
          const pFor = (ex: string) => ex === "pacifica" ? s.pacMarkPrice : ex === "hyperliquid" ? s.hlMarkPrice : ex === "lighter" ? s.ltMarkPrice : ex === "aster" ? s.astMarkPrice : unknownArbVenue(ex);
          const longPrice = pFor(s.longExch);
          const shortPrice = pFor(s.shortExch);
          const mid = (longPrice + shortPrice) / 2;
          const priceGapPct = mid > 0 ? Math.abs(longPrice - shortPrice) / mid * 100 : 0;
          return { mode: "perp-perp" as const, symbol: s.symbol, longExch: s.longExch, shortExch: s.shortExch, markPrice: s.markPrice, grossSpread, grossSpreadPct: grossSpread, netSpread: net, netSpreadPct: net, estFeesPct: rtCost, priceGapPct: Math.round(priceGapPct * 10000) / 10000 };
        });
        // Merge spot-perp results if "all" mode
        const spotPerp: Record<string, unknown>[] = (opts.mode === "all" && spotSpreads) ? spotSpreads.map(s => {
          const spotEx = s.spotExchanges[0] || "lighter";
          const rtCost = computeRoundTripCostPct(spotEx, s.perpExchange);
          const effectiveBridgeCost = s.spotExchanges.includes(s.perpExchange) ? 0 : bridgeCostUsd;
          const net = computeNetSpread(s.annualSpreadPct, holdDays, rtCost, effectiveBridgeCost, sizeUsd);
          return {
            mode: "spot-perp" as const, symbol: s.symbol, perpExchange: s.perpExchange,
            spotExchanges: s.spotExchanges, grossSpread: s.annualSpreadPct, grossSpreadPct: s.annualSpreadPct,
            netSpread: net, netSpreadPct: net, estFeesPct: rtCost,
            perpFundingRate: s.perpFundingRate, direction: s.direction,
            markPrice: s.bestMarkPrice, breakEvenDays: rtCost > 0 ? Math.ceil(rtCost / (s.annualSpreadPct / 365)) : 0,
          };
        }) : [];
        let combined = [...perpPerp, ...spotPerp].sort((a, b) => (b.netSpread as number) - (a.netSpread as number));
        if (opts.top) combined = combined.slice(0, parseInt(opts.top));
        return printJson(jsonOk(combined));
      }

      if (filtered.length === 0) {
        console.log(chalk.gray(`  No perp-perp spreads above ${minSpread}%\n`));
        return;
      }

      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e === "aster" ? "AST" : e.toUpperCase();
      const rows = filtered.map(s => {
        const direction = `${exAbbr(s.shortExch)}>${exAbbr(s.longExch)}`;
        const grossSpread = Math.abs(s.spread);
        const rtCost = computeRoundTripCostPct(s.longExch, s.shortExch);
        const netSpread = computeNetSpread(grossSpread, holdDays, rtCost, bridgeCostUsd, sizeUsd);
        const grossColor = grossSpread >= 50 ? chalk.green.bold : grossSpread >= 30 ? chalk.green : chalk.yellow;
        const netColor = netSpread >= 20 ? chalk.green : netSpread >= 0 ? chalk.yellow : chalk.red;
        const priceFor = (ex: string) => ex === "pacifica" ? s.pacMarkPrice : ex === "hyperliquid" ? s.hlMarkPrice : ex === "lighter" ? s.ltMarkPrice : ex === "aster" ? s.astMarkPrice : unknownArbVenue(ex);
        const longPrice = priceFor(s.longExch);
        const shortPrice = priceFor(s.shortExch);
        const mid = (longPrice + shortPrice) / 2;
        const priceGapPct = mid > 0 ? Math.abs(longPrice - shortPrice) / mid * 100 : 0;
        const gapColor = priceGapPct >= 0.5 ? chalk.red : priceGapPct >= 0.1 ? chalk.yellow : chalk.gray;
        const rates: string[] = [];
        // Each leg names which rate it is (lastSettled / accruing / predicted; ? = unverified).
        if (s.pacRate) rates.push(`PAC:${(s.pacRate * 100).toFixed(4)}%${kindTag(s, "pacifica")}`);
        if (s.hlRate) rates.push(`HL:${(s.hlRate * 100).toFixed(4)}%${kindTag(s, "hyperliquid")}`);
        if (s.ltRate) rates.push(`LT:${(s.ltRate * 100).toFixed(4)}%${kindTag(s, "lighter")}`);
        if (s.astRate) rates.push(`AST:${(s.astRate * 100).toFixed(4)}%${kindTag(s, "aster")}`);
        return [
          chalk.white.bold(s.symbol),
          grossColor(`${grossSpread.toFixed(1)}%`),
          netColor(`${netSpread.toFixed(1)}%`),
          chalk.gray(`${rtCost.toFixed(2)}%`),
          gapColor(`${priceGapPct.toFixed(3)}%`),
          direction,
          rates.join(" "),
        ];
      });
      console.log(makeTable(["Symbol", "Gross", "Net", "Fees", "Gap", "Dir", "Rates"], rows));
      console.log(chalk.gray(`  ${filtered.length} opportunities above ${minSpread}% gross annual spread`));
      console.log(chalk.gray(`  Net spread assumes ${holdDays}d hold, $${bridgeCostUsd} bridge cost, $${sizeUsd} size`));
      console.log(chalk.gray(`  * Spreads are estimates based on current rates — actual may vary`));
      console.log(chalk.gray(`  Use 'perp arb auto --min-spread ${minSpread}' to auto-trade\n`));
    });

  // ── arb exec ── (validate orderbook + simultaneous dual-leg entry)

  /**
   * arb exec outcome that is NOT a success (not entered / rolled back / pending / quarantined):
   * exit code 1, and in JSON mode an ok:false envelope carrying the structured result as
   * `details` — so a script never reads a failed or unconfirmed entry as success.
   */
  const reportExecFailure = (code: ErrorCode, message: string, details: Record<string, unknown>): void => {
    process.exitCode = 1;
    if (!isJson()) return;
    const remediation = typeof details.remediation === "string" ? details.remediation : undefined;
    printJson(jsonError(code, message, {
      status: ERROR_CODES[code].status,
      retryable: ERROR_CODES[code].retryable,
      details,
      ...(remediation !== undefined ? { remediation } : {}),
    }));
  };

  supportsDryRun(arb.command("exec"))
    .description("Execute arb (supports --dry-run): validate orderbook depth, then enter the legs sequentially (long, then short sized to the verified long fill). Use spot:<exch> for spot+perp mode.")
    .argument("<symbol>", "Symbol (e.g. BTC, ETH, ICP)")
    .argument("<longExch>", "Exchange to go LONG on (hl, pac, lighter, or spot:<venue> for spot+perp — hl, lt, lrh, aster, ondo)")
    .argument("<shortExch>", "Exchange to go SHORT on (hl, pac, lighter)")
    .argument("<sizeUsd>", "Position size per leg in USD")
    .option("--max-slippage <pct>", "Max slippage % per leg", "0.5")
    .option("--leverage <n>", "Set leverage before entry (both exchanges)")
    .option("--isolated", "Use isolated margin mode")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick (reduces slippage)")
    .option("--reconcile", "(always on) the long is trimmed reduce-only to the short's verified fill")
    .action(async (symbol: string, longExch: string, shortExch: string, sizeUsdStr: string, opts: {
      maxSlippage: string; leverage?: string; isolated?: boolean; smart?: boolean; reconcile?: boolean;
    }) => {
      // Detect spot: prefix -> route to spot-exec logic
      if (longExch.startsWith("spot:")) {
        const spotExch = longExch.slice(5); // extract "hl" from "spot:hl"
        return handleSpotExec(symbol, spotExch, shortExch, sizeUsdStr, opts);
      }
      const sym = symbol.toUpperCase();
      const sizeUsd = parseFloat(sizeUsdStr);
      const maxSlippage = parseFloat(opts.maxSlippage);
      const dryRun = isDryRun(program);

      // Resolve exchange aliases
      longExch = resolveVenueId(longExch);
      shortExch = resolveVenueId(shortExch);

      // Only venues with a trading role can hold a leg.
      for (const ex of [longExch, shortExch]) {
        const venue = getVenue(ex);
        if (!venue.roles.includes("trading")) {
          if (venue.gatedRoles !== null) throw roleUnsupported(venue, "trading");
          throw unsupported(venue.displayName, "trading", "no trading API — it cannot be an arb leg", `Use a trading venue: ${listVenuesWithRole("trading").map(v => v.id).join(", ")}`);
        }
      }

      if (longExch === shortExch) {
        reportExecFailure("INVALID_PARAMS", "longExch and shortExch must be different", { error: "longExch and shortExch must be different" });
        if (isJson()) return;
        console.log(chalk.red("  Long and short exchange must be different."));
        return;
      }

      // Global quarantine: an unknown / unhedged outcome on this symbol
      // anywhere blocks new trades until a human clears it.
      const quarantined = quarantineEntryFor(sym, (m) => console.error(m));
      if (quarantined !== null) {
        throw new PerpError("RISK_VIOLATION", `${sym} is quarantined (${quarantined.strategy}: ${quarantined.reason})`, {
          remediation: `${quarantined.remediation} — then: perp strategy quarantine-clear ${sym}`,
        });
      }

      // A venue whose funding rate is unverified is never a funding-arb leg.
      assertFundingArbVenue(longExch);
      assertFundingArbVenue(shortExch);
      const longAdapter = await getAdapterForExchange(longExch);
      const shortAdapter = await getAdapterForExchange(shortExch);

      // 1. Set leverage if requested (a venue write — skipped under --dry-run, reported in the plan)
      if (opts.leverage && !dryRun) {
        const lev = parseInt(opts.leverage);
        const mode = opts.isolated ? "isolated" : "cross";
        if (!isJson()) console.log(chalk.gray(`  Setting leverage ${lev}x ${mode} on both exchanges...`));
        const [longLev, shortLev] = await Promise.allSettled([
          longAdapter.setLeverage(sym, lev, mode),
          shortAdapter.setLeverage(sym, lev, mode),
        ]);
        if (longLev.status === "rejected") {
          const msg = `Failed to set leverage on ${longExch}: ${longLev.reason instanceof Error ? longLev.reason.message : longLev.reason}`;
          reportExecFailure("EXCHANGE_ERROR", msg, { error: msg });
          if (isJson()) return;
          console.log(chalk.red(`  ${msg}`)); return;
        }
        if (shortLev.status === "rejected") {
          const msg = `Failed to set leverage on ${shortExch}: ${shortLev.reason instanceof Error ? shortLev.reason.message : shortLev.reason}`;
          reportExecFailure("EXCHANGE_ERROR", msg, { error: msg });
          if (isJson()) return;
          console.log(chalk.red(`  ${msg}`)); return;
        }
      }

      // 2. Fetch orderbooks simultaneously
      if (!isJson()) console.log(chalk.gray(`  Checking orderbook depth on both exchanges...`));
      const [longBook, shortBook] = await Promise.all([
        longAdapter.getOrderbook(sym),
        shortAdapter.getOrderbook(sym),
      ]);

      // 3. Validate: long side buys from asks, short side sells into bids
      const longCheck = computeExecutableSize(longBook.asks, sizeUsd, maxSlippage);
      const shortCheck = computeExecutableSize(shortBook.bids, sizeUsd, maxSlippage);

      const validation = {
        long: { exchange: longExch, side: "buy", depthUsd: longCheck.depthUsd, canFill: longCheck.canFillFull, slippagePct: longCheck.slippagePct, maxSizeBase: longCheck.maxSize },
        short: { exchange: shortExch, side: "sell", depthUsd: shortCheck.depthUsd, canFill: shortCheck.canFillFull, slippagePct: shortCheck.slippagePct, maxSizeBase: shortCheck.maxSize },
      };

      if (!longCheck.canFillFull || !shortCheck.canFillFull) {
        // Use the smaller fillable amount
        const fillableUsd = Math.min(
          longCheck.maxSize * longCheck.avgFillPrice,
          shortCheck.maxSize * shortCheck.avgFillPrice,
        );
        const result = {
          error: "Insufficient orderbook depth",
          requestedUsd: sizeUsd,
          fillableUsd: Math.round(fillableUsd * 100) / 100,
          validation,
        };
        reportExecFailure("SIZE_TOO_LARGE", `Insufficient orderbook depth for $${sizeUsd} (fillable ~$${result.fillableUsd})`, result);
        if (isJson()) return;
        console.log(chalk.red(`\n  Insufficient depth for $${sizeUsd}:`));
        console.log(chalk.gray(`    ${longExch} asks: $${longCheck.depthUsd.toFixed(0)} depth, ${longCheck.canFillFull ? "OK" : "NOT ENOUGH"}`));
        console.log(chalk.gray(`    ${shortExch} bids: $${shortCheck.depthUsd.toFixed(0)} depth, ${shortCheck.canFillFull ? "OK" : "NOT ENOUGH"}`));
        console.log(chalk.yellow(`  Max fillable: $${fillableUsd.toFixed(2)}\n`));
        return;
      }

      // 4. Compute matched size in base asset (use the smaller side)
      // Uses computeMatchedSize which enforces exchange min order values
      const inferDecimals = (levels: [string, string][]) => {
        for (const [, s] of levels) {
          const dot = s.indexOf(".");
          if (dot >= 0) return s.length - dot - 1;
        }
        return 0;
      };
      const longDecimals = inferDecimals(longBook.asks);
      const shortDecimals = inferDecimals(shortBook.bids);
      const matchedBase = Math.min(longCheck.recommendedSize, shortCheck.recommendedSize);
      const avgPrice = (longCheck.avgFillPrice + shortCheck.avgFillPrice) / 2;
      const matchedUsdRaw = matchedBase * avgPrice;

      // Each leg's minimum is the venue's own published one (market info), never a fixed table.
      const pairMin = pairOrderMinimums([
        { exchange: longExch, ...(await venueOrderMinimums(longAdapter, sym, networkOf(program))) },
        { exchange: shortExch, ...(await venueOrderMinimums(shortAdapter, sym, networkOf(program))) },
      ]);
      const sizing = computeMatchedSize(
        matchedUsdRaw,
        avgPrice,
        longExch,
        shortExch,
        { longSizeDecimals: longDecimals, shortSizeDecimals: shortDecimals, minNotional: pairMin.minNotional },
      );
      if (!sizing || Number(sizing.size) < pairMin.minSize) {
        const msg = `Order too small: $${matchedUsdRaw.toFixed(2)} is below the venue minimum (${pairMin.describe}). Request a larger size.`;
        reportExecFailure("SIZE_TOO_SMALL", msg, { error: msg, computedUsd: matchedUsdRaw, minimums: pairMin.legs });
        if (isJson()) return;
        console.log(chalk.red(`\n  ${msg}`));
        return;
      }
      const matchedSize = sizing.size;
      const matchedUsd = sizing.notional;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Arb Exec: ${sym}${opts.smart ? " (smart order)" : ""}${dryRun ? " [DRY RUN]" : ""}`));
        console.log(chalk.gray(`    LONG  ${longExch}: buy  ${matchedSize} (~$${(matchedBase * longCheck.avgFillPrice).toFixed(2)}, slippage ${longCheck.slippagePct.toFixed(3)}%)`));
        console.log(chalk.gray(`    SHORT ${shortExch}: sell ${matchedSize} (~$${(matchedBase * shortCheck.avgFillPrice).toFixed(2)}, slippage ${shortCheck.slippagePct.toFixed(3)}%)`));
      }

      // 4b. Dry-run: return simulated result without executing
      if (dryRun) {
        const result = {
          status: "filled", symbol: sym, dryRun: true, sent: false,
          leverage: opts.leverage ? { value: parseInt(opts.leverage), mode: opts.isolated ? "isolated" : "cross" } : null,
          size: matchedSize, notionalUsd: Math.round(matchedUsd * 100) / 100,
          long: { exchange: longExch, side: "buy", size: matchedSize, slippagePct: longCheck.slippagePct },
          short: { exchange: shortExch, side: "sell", size: matchedSize, slippagePct: shortCheck.slippagePct },
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.yellow(`\n    [DRY RUN] Would execute: long ${matchedSize} on ${longExch} + short ${matchedSize} on ${shortExch} (~$${matchedUsd.toFixed(2)})\n`));
        return;
      }

      if (!isJson()) console.log(chalk.gray(`    Executing legs sequentially (long, then short sized to the verified long fill)...\n`));

      // 5. Sequential verified legs. The second leg is sized to the
      //    first leg's VERIFIED fill, any shortfall is trimmed off the long
      //    (reduce-only, verified — always, --reconcile is implied), a definite short
      //    failure rolls the long back reduce-only, and an unknown outcome (incl. a
      //    venue that accepted the order but the position did not move) quarantines
      //    the symbol — nothing is retried.
      const res = await openPerpPairVerified({
        source: "arb-exec", sym, longAdapter, longExch, longSym: sym, shortAdapter, shortExch, shortSym: sym,
        size: matchedSize, smart: !!opts.smart, log: (m) => console.error(chalk.red(m)),
      });

      if (res.status === "opened") {
        const finalSize = res.hedged;
        const reconciled = res.trimmed !== "0";
        logExecution({
          type: "arb_entry", exchange: `${longExch}+${shortExch}`,
          symbol: sym, side: "entry", size: finalSize,
          status: "success", dryRun: false,
          // arbPairId / longExchange / shortExchange: the keys `arb status` provenance matches on.
          meta: { arbPairId: `${sym}:${longExch}:${shortExch}`, longExchange: longExch, shortExchange: shortExch, longExch, shortExch, matchedUsd, requested: matchedSize, longSlippage: longCheck.slippagePct, shortSlippage: shortCheck.slippagePct, reconciled, trimmed: res.trimmed },
        });
        const result = {
          status: "filled", symbol: sym, size: finalSize, requestedSize: matchedSize, notionalUsd: Math.round(matchedUsd * 100) / 100,
          long: { exchange: longExch, side: "buy", size: finalSize, slippagePct: longCheck.slippagePct },
          short: { exchange: shortExch, side: "sell", size: finalSize, slippagePct: shortCheck.slippagePct },
          ...(reconciled && { reconciled: true, trimmed: res.trimmed }),
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`  FILLED${reconciled ? ` (long trimmed by ${res.trimmed})` : ""}: ${sym} ${finalSize} units (requested ${matchedSize}, ~$${matchedUsd.toFixed(2)})`));
        console.log(chalk.green(`    LONG  ${longExch} ✓ (${finalSize}, verified)`));
        console.log(chalk.green(`    SHORT ${shortExch} ✓ (${finalSize}, verified)\n`));
      } else if (res.status === "not_opened") {
        logExecution({
          type: "arb_entry", exchange: `${longExch}+${shortExch}`,
          symbol: sym, side: "entry", size: matchedSize,
          status: "failed", dryRun: false,
          error: `${res.reason}${res.rolledBack !== null ? ` — long ${res.rolledBack} rolled back (reduce-only, verified)` : ""}`,
        });
        const result = {
          status: res.rolledBack !== null ? "rolled_back" : "not_filled", symbol: sym,
          error: res.reason, rolledBack: res.rolledBack, openExposure: null,
        };
        reportExecFailure("ORDER_REJECTED", `arb exec ${sym}: entry failed (${result.status}) — ${res.reason}`, result);
        if (isJson()) return;
        console.log(chalk.red(`  Entry failed: ${res.reason}`));
        console.log(res.rolledBack !== null
          ? chalk.yellow(`  Rolled back long ${res.rolledBack} on ${longExch} (reduce-only, verified flat) — no open exposure from this trade.\n`)
          : chalk.yellow(`  Nothing was opened.\n`));
      } else {
        logExecution({
          type: "arb_entry", exchange: `${longExch}+${shortExch}`,
          symbol: sym, side: "entry", size: matchedSize,
          status: "failed", dryRun: false,
          error: `QUARANTINED: ${res.reason}`,
          meta: { exposure: res.exposure },
        });
        const result = {
          status: "quarantined", symbol: sym, error: res.reason, openExposure: res.exposure,
          remediation: `Check ${sym} on ${longExch} and ${shortExch}; close or re-hedge by hand, then: perp strategy quarantine-clear ${sym}`,
        };
        reportExecFailure("ORDER_PARTIAL", `arb exec ${sym}: QUARANTINED — ${res.reason}`, result);
        if (isJson()) return;
        console.log(chalk.red.bold(`  QUARANTINED ${sym}: ${res.reason}`));
        console.log(chalk.red.bold(`  Possible open exposure: ${res.exposure} — check manually!\n`));
      }
    });

  // ── spot-exec logic (called from exec when longExch starts with "spot:") ──

  async function handleSpotExec(symbol: string, spotExch: string, perpExch: string, sizeUsdStr: string, opts: {
    maxSlippage: string; leverage?: string; isolated?: boolean;
  }) {
      const sym = symbol.toUpperCase();
      const sizeUsd = parseFloat(sizeUsdStr);
      const maxSlippage = parseFloat(opts.maxSlippage);
      const dryRun = isDryRun(program);

      // Resolve exchange aliases
      spotExch = resolveVenueId(spotExch);
      perpExch = resolveVenueId(perpExch);

      // Validate spot exchange: bot/arb spot scope — throws CAPABILITY_UNSUPPORTED
      // for venues without spot or outside the scope (pacifica shared margin, arcus swaps).
      const spotDef = requireBotSpotVenue(spotExch.replace(/-spot$/, ""));
      spotExch = spotDef.id;
      perpExch = tryResolveVenueId(perpExch) ?? perpExch;
      if (!getVenue(perpExch).roles.includes("trading")) {
        if (getVenue(perpExch).gatedRoles !== null) throw roleUnsupported(getVenue(perpExch), "trading");
        throw unsupported(perpExch, "trading", "no trading API — it cannot be the perp leg", `Use a trading venue: ${listVenuesWithRole("trading").map(v => v.id).join(", ")}`);
      }
      assertFundingArbVenue(perpExch);
      const spotAdapter = await requireSpotAdapter(spotDef.id, await getAdapterForExchange(spotDef.id));

      const perpAdapter = await getAdapterForExchange(perpExch);

      // Order of operations (C3 / M6): every validation (balances, orderbooks, price
      // identity, depth, sizing) runs BEFORE anything moves; dry-run returns before the
      // leverage change and any transfer; after a transfer, every abort transfers back.
      const lev = opts.leverage ? parseInt(opts.leverage) : null;
      const levMode = opts.isolated ? "isolated" : "cross";
      const sameVenue = spotDef.id === (tryResolveVenueId(perpExch) ?? perpExch);
      const fail = (msg: string, extra: Record<string, unknown> = {}) => {
        reportExecFailure("ORDER_REJECTED", msg, { error: msg, ...extra });
        if (isJson()) return;
        console.log(chalk.red(`  ${msg}`));
      };

      // Global quarantine: checked before anything is read or moved.
      const quarantined = quarantineEntryFor(sym, (m) => console.error(m));
      if (quarantined !== null) {
        throw new PerpError("RISK_VIOLATION", `${sym} is quarantined (${quarantined.strategy}: ${quarantined.reason})`, {
          remediation: `${quarantined.remediation} — then: perp strategy quarantine-clear ${sym}`,
        });
      }

      // 1. Balance validation (errors propagate — no "continue anyway").
      //    Shared spot/perp (HL unified): perp available is the spot purchasing power.
      //    Separate: spot quote available + what can be transferred from the spot venue's perp account.
      const spotVenuePerp = await getAdapterForExchange(spotDef.id);
      const isShared = spotSharesPerpMargin(spotDef, spotVenuePerp);
      const spotVenuePerpAvail = Number((await spotVenuePerp.getBalance()).available);
      const perpAvail = sameVenue ? spotVenuePerpAvail : Number((await perpAdapter.getBalance()).available);
      if (!Number.isFinite(spotVenuePerpAvail) || !Number.isFinite(perpAvail)) {
        return fail(`Balance read returned a non-numeric available balance (spot venue ${spotVenuePerpAvail}, perp ${perpAvail})`);
      }
      const quoteRow = isShared ? null : findSpotQuoteBalance(spotDef, spotNetworkOf(spotAdapter), await readSpotBalancesFresh(spotAdapter));
      const spotQuoteHave = isShared ? spotVenuePerpAvail : (quoteRow === null ? 0 : Number(quoteRow.available));
      const spotTarget = Math.ceil(sizeUsd * 1.1);
      // Separate model: only the shortfall is transferred from the spot venue's perp account.
      const transferWant = isShared ? 0 : Math.max(0, Math.ceil(spotTarget - spotQuoteHave));
      // Perp leg margin: notional / the leverage the venue applies to the market × ARB_MARGIN_BUFFER
      // (requiredArbMargin — the same rule as funding-arb; unknown leverage → 1x). Spot leg: 100%.
      let perpLeverage: number | null;
      try {
        perpLeverage = await marketLeverageOf(perpAdapter, sym);
      } catch (e) {
        return fail(`Could not read the ${sym} leverage on ${perpExch}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const perpMarginNeed = requiredArbMargin(sizeUsd, perpLeverage);
      const marginText = `~$${perpMarginNeed.toFixed(2)} perp margin (${perpLeverage !== null ? `${perpLeverage}x` : "leverage unknown → 1x"}, ×${ARB_MARGIN_BUFFER} buffer)`;
      if (isShared) {
        const need = sameVenue ? sizeUsd + perpMarginNeed : sizeUsd;
        if (spotQuoteHave < need) {
          return fail(`Insufficient balance: have $${spotQuoteHave.toFixed(2)} on ${spotDef.displayName}, need ~$${need.toFixed(2)} ($${sizeUsd} spot${sameVenue ? ` + ${marginText}` : ""})`, { available: spotQuoteHave, required: need, perpLeverage });
        }
      } else {
        const fromSpotVenuePerp = transferWant + (sameVenue ? perpMarginNeed : 0);
        if (spotVenuePerpAvail < fromSpotVenuePerp) {
          return fail(`Insufficient balance on ${spotDef.displayName}: spot ${quoteRow?.token ?? "quote"} $${spotQuoteHave.toFixed(2)} + transferable perp $${spotVenuePerpAvail.toFixed(2)}; need $${spotTarget} in spot${sameVenue ? ` + ${marginText}` : ""}`, { spotQuoteAvail: spotQuoteHave, perpAvail: spotVenuePerpAvail, required: fromSpotVenuePerp, perpLeverage });
        }
      }
      if (!sameVenue && perpAvail < perpMarginNeed) {
        return fail(`Insufficient perp balance: have $${perpAvail.toFixed(2)} available on ${perpExch}, need ${marginText} for $${sizeUsd}`, { perpAvail, required: perpMarginNeed, perpLeverage });
      }

      // 2. Fetch orderbooks simultaneously
      const spotSymbol = spotPairSymbol(spotDef, spotNetworkOf(spotAdapter), sym);
      if (!isJson()) console.log(chalk.gray(`  Checking orderbook depth (spot ${spotExch} + perp ${perpExch})...`));
      const [spotBook, perpBook] = await Promise.all([
        spotAdapter.getSpotOrderbook(spotSymbol),
        perpAdapter.getOrderbook(sym),
      ]);

      // 2a. Price cross-validation: spot and perp must be the same underlying
      const spotMid = spotBook.bids.length > 0 && spotBook.asks.length > 0
        ? (Number(spotBook.bids[0][0]) + Number(spotBook.asks[0][0])) / 2 : 0;
      const perpMid = perpBook.bids.length > 0 && perpBook.asks.length > 0
        ? (Number(perpBook.bids[0][0]) + Number(perpBook.asks[0][0])) / 2 : 0;
      if (spotMid === 0) return fail(`Empty spot orderbook for ${sym} — cannot verify token identity`);
      if (perpMid === 0) return fail(`Empty perp orderbook for ${sym} on ${perpExch} — cannot verify token identity`);
      const priceDeviation = Math.abs(spotMid - perpMid) / perpMid * 100;
      if (priceDeviation > MAX_PRICE_DEVIATION_PCT) {
        return fail(`Price mismatch: spot mid $${spotMid.toFixed(4)} vs perp mid $${perpMid.toFixed(4)} (${priceDeviation.toFixed(1)}% deviation). Possible wrong token index — aborting.`, { spotMid, perpMid, deviationPct: priceDeviation });
      }

      // 2b. Validate depth
      const spotCheck = computeExecutableSize(spotBook.asks, sizeUsd, maxSlippage);
      const perpCheck = computeExecutableSize(perpBook.bids, sizeUsd, maxSlippage);
      if (!spotCheck.canFillFull || !perpCheck.canFillFull) {
        const fillableUsd = Math.min(
          spotCheck.maxSize * spotCheck.avgFillPrice,
          perpCheck.maxSize * perpCheck.avgFillPrice,
        );
        reportExecFailure("SIZE_TOO_LARGE", `Insufficient orderbook depth for $${sizeUsd} (fillable ~$${(Math.round(fillableUsd * 100) / 100)})`, {
          error: "Insufficient orderbook depth",
          requestedUsd: sizeUsd, fillableUsd: Math.round(fillableUsd * 100) / 100,
          spot: { exchange: spotExch, depthUsd: spotCheck.depthUsd, canFill: spotCheck.canFillFull },
          perp: { exchange: perpExch, depthUsd: perpCheck.depthUsd, canFill: perpCheck.canFillFull },
        });
        if (isJson()) return;
        console.log(chalk.red(`\n  Insufficient depth for $${sizeUsd}:`));
        console.log(chalk.gray(`    ${spotExch} spot asks: $${spotCheck.depthUsd.toFixed(0)}`));
        console.log(chalk.gray(`    ${perpExch} perp bids: $${perpCheck.depthUsd.toFixed(0)}`));
        return;
      }

      // 3. Compute matched size (with min order value enforcement)
      const avgPrice = (spotCheck.avgFillPrice + perpCheck.avgFillPrice) / 2;
      const inferDecimals = (levels: [string, string][]) => {
        for (const [, s] of levels) {
          const dot = s.indexOf(".");
          if (dot >= 0) return s.length - dot - 1;
        }
        return 0;
      };
      const spotDecimals = inferDecimals(spotBook.asks);
      const matchedBase = Math.min(spotCheck.recommendedSize, perpCheck.recommendedSize);
      const matchedUsdRaw = matchedBase * avgPrice;
      // computeSpotPerpMatchedSize enforces exchange min order values (e.g. HL $10 min)
      const sizing = computeSpotPerpMatchedSize(matchedUsdRaw, avgPrice, spotExch, perpExch, spotDecimals);
      if (!sizing) return fail(`Order too small: $${matchedUsdRaw.toFixed(2)} below exchange minimum. Request a larger size.`, { computedUsd: matchedUsdRaw });
      // Lot steps from the venue market info (unknown → throws, Rule #2): both legs are sent on
      // the lot grid, the hedge is floored to the perp lot and fills are judged with half-lot tolerance.
      const perpStep = await lotStepOf(perpAdapter, sym);
      const spotStep = await spotLotStepOf(spotAdapter, spotSymbol);
      const matchedSize = floorSize(floorSize(sizing.size, perpStep), spotStep);
      const matchedUsd = sizing.notional;
      const sizeDec = sizeDecimalsOf(matchedSize);

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Spot+Perp Arb: ${sym}`));
        console.log(chalk.gray(`    SPOT  ${spotExch}: buy  ${matchedSize} (~$${(matchedBase * spotCheck.avgFillPrice).toFixed(2)})`));
        console.log(chalk.gray(`    PERP  ${perpExch}: sell ${matchedSize} (~$${(matchedBase * perpCheck.avgFillPrice).toFixed(2)})`));
      }

      // 4. Dry-run: report the plan; nothing is changed (no leverage, no transfer, no order).
      if (dryRun) {
        const result = {
          status: "simulated", mode: "spot-perp", symbol: sym, dryRun: true, sent: false,
          size: matchedSize, notionalUsd: Math.round(matchedUsd * 100) / 100,
          transfer: transferWant > 0 ? { from: "perp", to: "spot", venue: spotDef.id, amount: transferWant } : null,
          leverage: lev === null ? null : { exchange: perpExch, leverage: lev, mode: levMode },
          spot: { exchange: spotExch, side: "buy", size: matchedSize },
          perp: { exchange: perpExch, side: "sell", size: matchedSize },
        };
        if (isJson()) return printJson(jsonOk(result));
        if (transferWant > 0) console.log(chalk.cyan(`  [DRY-RUN] Would transfer $${transferWant} perp→spot on ${spotDef.displayName}`));
        if (lev !== null) console.log(chalk.cyan(`  [DRY-RUN] Would set perp leverage ${lev}x ${levMode} on ${perpExch}`));
        console.log(chalk.cyan(`  [DRY-RUN] Would execute: spot buy ${matchedSize} on ${spotExch} + perp sell ${matchedSize} on ${perpExch}`));
        return;
      }

      // 5. Set perp leverage if requested (before any funds move)
      if (lev !== null) {
        if (!isJson()) console.log(chalk.gray(`  Setting perp leverage ${lev}x ${levMode} on ${perpExch}...`));
        try {
          await perpAdapter.setLeverage(sym, lev, levMode);
        } catch (e) {
          return fail(`Failed to set leverage: ${e instanceof Error ? e.message : e}`);
        }
      }

      // 6. Transfer the spot quote shortfall perp → spot (separate model only). A failed transfer stops here.
      let transferred = 0;
      if (transferWant > 0) {
        if (await transferQuoteToSpot(spotAdapter, transferWant)) {
          transferred = transferWant;
          if (!isJson()) console.log(chalk.gray(`  Transferred $${transferWant} perp→spot on ${spotDef.displayName}`));
          await new Promise(r => setTimeout(r, 500));
        }
      } else if (!isJson()) {
        console.log(chalk.gray(isShared
          ? `  Shared spot/perp balance on ${spotDef.displayName} — no transfer needed`
          : `  Spot ${quoteRow?.token ?? "quote"} balance already covers the order — no transfer`));
      }
      /** Abort path after a transfer: move it back and report the outcome (never silent). */
      const returnTransfer = async (warnings: string[]): Promise<void> => {
        if (transferred <= 0) return;
        try {
          await transferQuoteToPerp(spotAdapter, transferred);
          if (!isJson()) console.log(chalk.gray(`  Returned $${transferred} spot→perp on ${spotDef.displayName}`));
        } catch (e) {
          const w = `Transfer back of $${transferred} failed (funds remain in ${spotDef.id} spot): ${e instanceof Error ? e.message : String(e)}`;
          warnings.push(w);
          if (!isJson()) console.log(chalk.yellow(`  ⚠ ${w}`));
        }
      };

      // 7. Execute both legs. Same exchange shares a nonce → sequential; else parallel.
      if (!isJson()) console.log(chalk.gray(`    Executing ${sameVenue ? "sequentially" : "both legs simultaneously"}...\n`));
      // The perp leg goes through placePerpVerified: a fill is the measured
      // position delta; an unknown outcome is ORDER_PENDING (quarantine, never roll back).
      let spotResult: PromiseSettledResult<SpotFill>;
      let perpResult: PromiseSettledResult<PerpFill>;
      if (sameVenue) {
        // Sequential: spot first; the perp leg is sized to what the spot leg filled.
        spotResult = await spotMarketFill(spotAdapter, spotSymbol, "buy", matchedSize, spotStep)
          .then(r => ({ status: "fulfilled" as const, value: r }))
          .catch(e => ({ status: "rejected" as const, reason: e }));
        if (spotResult.status === "fulfilled") {
          const perpSize = floorToStep(spotResult.value.filledSize, perpStep);
          perpResult = Number(perpSize) > 0
            ? await placePerpVerified(perpAdapter, perpExch, sym, "sell", perpSize, { stepSize: perpStep })
              .then(r => ({ status: "fulfilled" as const, value: r }))
              .catch(e => ({ status: "rejected" as const, reason: e }))
            : { status: "rejected" as const, reason: new PerpError("ORDER_REJECTED", `Skipped: spot filled only dust (${spotResult.value.filledSize})`) };
        } else {
          perpResult = { status: "rejected" as const, reason: new PerpError("ORDER_REJECTED", "Skipped: spot failed") };
        }
      } else {
        [spotResult, perpResult] = await Promise.allSettled([
          spotMarketFill(spotAdapter, spotSymbol, "buy", matchedSize, spotStep),
          placePerpVerified(perpAdapter, perpExch, sym, "sell", matchedSize, { stepSize: perpStep }),
        ]);
      }

      const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
      const spotPending = spotResult.status === "rejected" && spotResult.reason instanceof PerpError && spotResult.reason.structured.code === "ORDER_PENDING";
      const spotFilled = spotResult.status === "fulfilled" ? spotResult.value.filledSize : 0;
      const hedgeSize = floorToStep(spotFilled, perpStep);
      const perpOk = perpResult.status === "fulfilled";
      const warnings: string[] = [];
      /** Set when a perp outcome is unknown: quarantine and stop (no spot sell-back, no transfer back). */
      let perpUnknown: string | null = perpResult.status === "rejected" && isOutcomeUnknown(perpResult.reason)
        ? `perp sell on ${perpExch} outcome unknown: ${errMsg(perpResult.reason)}` : null;

      // 7a. Perp leg open (verified) while the spot leg filled less (failed / pending / partial):
      //     reduce the perp short to the spot fill (reduce-only, verified) — never a naked short.
      let shortOpen = perpResult.status === "fulfilled" ? floorToStep(perpResult.value.filledSize, perpStep) : "0";
      if (perpOk && Number(hedgeSize) < Number(shortOpen)) {
        const excess = floorToStep(Number(shortOpen) - Number(hedgeSize), perpStep);
        const why = spotResult.status === "rejected"
          ? `spot leg ${spotPending ? "PENDING" : "failed"}: ${errMsg(spotResult.reason)}`
          : `spot leg filled ${spotFilled} of ${matchedSize}`;
        if (!isJson()) console.log(chalk.yellow(`  ${why} — reducing perp short by ${excess} to match`));
        // One verified reduce-only close (+ one residual close inside closePerpVerified); never resubmitted.
        try {
          const c = await closePerpVerified(perpAdapter, perpExch, sym, "buy", excess, { decimals: sizeDecimalsOf(perpStep), stepSize: perpStep });
          shortOpen = floorToStep(Math.max(0, Number(shortOpen) - c.closed), perpStep);
          if (c.residual > 0) warnings.push(`Perp reduce of ${excess} ${sym} on ${perpExch} closed ${c.closed}, ${c.residual} still open${c.note !== null ? ` (${c.note})` : ""} — MANUAL CLOSE REQUIRED`);
        } catch (e) {
          if (isOutcomeUnknown(e)) perpUnknown = `perp reduce of ${excess} on ${perpExch} outcome unknown: ${errMsg(e)} (short ${shortOpen} was open)`;
          else warnings.push(`Perp reduce of ${excess} ${sym} on ${perpExch} FAILED: ${errMsg(e)} — MANUAL CLOSE REQUIRED`);
        }
      }

      // 7a'. Unknown perp outcome: stop here. Selling the spot back could leave a naked short
      //      and the short may or may not exist — quarantine for a human.
      if (perpUnknown !== null) {
        const pendingNote = spotPending ? `; spot buy ${matchedSize} also PENDING` : `; spot bought ${spotFilled}`;
        quarantineSymbol("arb-exec", sym, `arb exec spot:${spotExch}: ${perpUnknown}${pendingNote} — not rolled back`,
          `Check ${sym} on ${spotDef.id} spot (perp -e ${spotDef.id} trade spot-balance / spot-orders) and the ${perpExch} perp (perp -e ${perpExch} positions); hedge or close by hand`,
          (m) => console.error(m));
        logExecution({
          type: "arb_entry", exchange: `spot:${spotExch}+${perpExch}`,
          symbol: sym, side: "entry", size: matchedSize,
          status: "failed", dryRun: false,
          error: `${perpUnknown} — MANUAL CHECK REQUIRED`,
          meta: { mode: "spot-perp", spotPending, spotFilled, perpPending: true, ...(warnings.length > 0 && { warnings }) },
        });
        const result = {
          status: "perp_pending", mode: "spot-perp", symbol: sym,
          spotFilled, spotPending, perpError: perpUnknown,
          remediation: `Perp order outcome unknown — do NOT resubmit and do NOT sell the spot back blindly. Check: perp -e ${perpExch} positions; perp -e ${spotDef.id} trade spot-balance`,
          ...(warnings.length > 0 && { warnings }),
        };
        reportExecFailure("ORDER_PENDING", `arb exec spot:${spotExch} ${sym}: perp leg outcome unknown (quarantined) — ${perpUnknown}`, result);
        if (isJson()) return;
        for (const w of warnings) console.log(chalk.red.bold(`  ${w}`));
        console.log(chalk.red.bold(`  PERP ORDER PENDING — ${perpUnknown}. Spot ${spotPending ? "PENDING" : `bought ${spotFilled}`}. Nothing rolled back; ${sym} quarantined.\n`));
        return;
      }

      // 7b. Spot leg filled while the perp leg DEFINITELY failed: sell the spot fill back.
      let spotHeld = spotFilled;
      if (!perpOk && spotFilled > 0) {
        const perpErr = (perpResult as PromiseRejectedResult).reason;
        if (!isJson()) console.log(chalk.yellow(`  Perp leg failed (${errMsg(perpErr)}) — selling back ${hedgeSize} spot`));
        try {
          const rb = Number(hedgeSize) > 0 ? await spotMarketFill(spotAdapter, spotSymbol, "sell", hedgeSize, spotStep) : null;
          spotHeld = rb === null ? spotFilled : Math.max(0, spotFilled - rb.filledSize);
          if (spotHeld > 0) warnings.push(`Spot rollback left ${spotHeld} ${sym} on ${spotExch} — MANUAL CLOSE REQUIRED`);
        } catch (e) {
          warnings.push(`Spot rollback FAILED: ${errMsg(e)} — ${spotFilled} ${sym} still held on ${spotExch}, MANUAL CLOSE REQUIRED`);
        }
      }

      // Hedged only when the perp short is VERIFIED (placePerpVerified measured it) and spot is held.
      const hedged = perpOk && Number(shortOpen) > 0 && spotHeld > 0;
      if (hedged) {
        if (spotResult.status === "fulfilled" && spotResult.value.status === "partial") {
          warnings.push(`Spot leg partially filled: ${spotFilled} of ${matchedSize} ${sym}; perp short sized to match`);
        }
        // Legs must match: an excess short whose reduce failed, or a verified short below the
        // spot held, is real unhedged exposure → quarantine and report it, never "filled".
        // Spot held on the perp lot grid: sub-lot spot dust cannot be hedged and is not an imbalance.
        const heldStr = floorToStep(spotHeld, perpStep);
        let unbalanced: string | null = null;
        if (Number(heldStr) > Number(shortOpen)) {
          unbalanced = `verified perp short ${shortOpen} < spot held ${heldStr} ${sym} — ${fillSizeString(spotHeld - Number(shortOpen), sizeDec)} spot is unhedged`;
        } else if (Number(shortOpen) > Number(heldStr)) {
          unbalanced = `perp short ${shortOpen} on ${perpExch} > spot held ${heldStr} ${sym} — ${fillSizeString(Number(shortOpen) - spotHeld, sizeDec)} short is naked (reduce did not complete)`;
        }
        if (unbalanced !== null) {
          warnings.push(unbalanced);
          quarantineSymbol("arb-exec", sym, `arb exec spot:${spotExch}: ${unbalanced}`,
            `Check ${sym} on ${spotDef.id} spot (perp -e ${spotDef.id} trade spot-balance) and the ${perpExch} perp (perp -e ${perpExch} positions); re-hedge or close by hand, then: perp strategy quarantine-clear ${sym}`,
            (m) => console.error(m));
        }
        if (!isJson()) for (const w of warnings) console.log(chalk.yellow(`  ⚠ ${w}`));

        logExecution({
          type: "arb_entry", exchange: `spot:${spotExch}+${perpExch}`,
          symbol: sym, side: "entry", size: hedgeSize,
          status: "success", dryRun: false,
          meta: { mode: "spot-perp", spotExch, perpExch, matchedUsd, requestedSize: matchedSize, spotFilled, shortOpen, perpVerified: true, quarantined: unbalanced !== null, ...(warnings.length > 0 && { warnings }) },
        });

        // Persist the actual leg sizes
        persistAddPosition(networkOf(program), {
          id: `${sym}-spot-${Date.now()}`,
          symbol: sym,
          longExchange: spotExch,
          shortExchange: perpExch,
          longSize: spotHeld,
          shortSize: parseFloat(shortOpen),
          entryTime: new Date().toISOString(),
          entrySpread: 0, // Will be updated on next scan
          entryLongPrice: spotResult.status === "fulfilled" && spotResult.value.avgPrice !== null ? spotResult.value.avgPrice : spotCheck.avgFillPrice,
          entryShortPrice: perpCheck.avgFillPrice,
          accumulatedFunding: 0,
          lastCheckTime: new Date().toISOString(),
          mode: "spot-perp",
          spotExchange: spotExch,
          spotSymbol: spotSymbol,
        });

        // Return the leftover of what THIS trade transferred in (pre-existing spot quote is
        // never swept; no-op when shared with perp or nothing was transferred).
        try {
          const moved = transferred > 0 ? await sweepSpotQuoteToPerp(spotAdapter, 1, { keep: spotQuoteHave, max: transferred }) : 0;
          if (moved > 0 && !isJson()) console.log(chalk.gray(`  Returned ~$${moved.toFixed(2)} to perp account`));
        } catch (e) {
          const w = `Leftover spot→perp transfer failed (funds remain in ${spotDef.id} spot): ${errMsg(e)}`;
          warnings.push(w);
          if (!isJson()) console.log(chalk.yellow(`  ⚠ ${w}`));
        }

        if (unbalanced !== null) {
          const result = {
            status: "quarantined", mode: "spot-perp", symbol: sym,
            exposure: { spotHeld: heldStr, perpShort: shortOpen, spotExchange: spotExch, perpExchange: perpExch },
            reason: unbalanced,
            remediation: `Legs unbalanced — do NOT resubmit. Re-hedge or close by hand (perp -e ${perpExch} positions; perp -e ${spotDef.id} trade spot-balance), then: perp strategy quarantine-clear ${sym}`,
            ...(warnings.length > 0 && { warnings }),
          };
          reportExecFailure("ORDER_PARTIAL", `arb exec spot:${spotExch} ${sym}: QUARANTINED — ${unbalanced}`, result);
          if (isJson()) return;
          console.log(chalk.red.bold(`  QUARANTINED: ${sym} spot ${heldStr} / perp short ${shortOpen} — ${unbalanced}\n`));
          return;
        }
        const result = {
          status: spotFilled < Number(matchedSize) ? "partial_filled" : "filled",
          mode: "spot-perp", symbol: sym,
          size: hedgeSize, requestedSize: matchedSize, notionalUsd: Math.round(matchedUsd * 100) / 100,
          spot: { exchange: spotExch, side: "buy", size: String(spotHeld) },
          perp: { exchange: perpExch, side: "sell", size: shortOpen },
          ...(warnings.length > 0 && { warnings }),
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`  FILLED (perp verified): ${sym} spot ${spotHeld} / perp short ${shortOpen} (~$${matchedUsd.toFixed(2)} requested)`));
        console.log(chalk.green(`    SPOT  ${spotExch} ✓ (bought ${spotFilled})`));
        console.log(chalk.green(`    PERP  ${perpExch} ✓ (short ${shortOpen})\n`));
        return;
      }

      // Not hedged: nothing (or only an unrecoverable remainder) is open. Return the transfer
      // unless the spot leg is pending (the quote may already be spent).
      if (!spotPending) await returnTransfer(warnings);
      const spotErrMsg = spotResult.status === "rejected" ? errMsg(spotResult.reason) : null;
      const perpErrMsg = perpResult.status === "rejected" ? errMsg(perpResult.reason) : null;
      const manual = warnings.some(w => w.includes("MANUAL")) || spotPending;
      if (manual) {
        // Persisted globally so the `arb auto` daemon, the bots and later `arb exec` runs
        // leave this symbol alone until a human resolves it.
        quarantineSymbol("arb-exec", sym,
          spotPending ? `arb exec spot:${spotExch}: spot buy ${matchedSize} PENDING (outcome unknown)` : `arb exec spot:${spotExch}: rollback incomplete — ${warnings.join("; ")}`,
          `Check ${sym} on ${spotDef.id} spot (perp -e ${spotDef.id} trade spot-balance / spot-orders) and the ${perpExch} perp (perp -e ${perpExch} positions)`,
          (m) => console.error(m));
      }
      logExecution({
        type: "arb_entry", exchange: `spot:${spotExch}+${perpExch}`,
        symbol: sym, side: "entry", size: matchedSize,
        status: "failed", dryRun: false,
        error: `spot: ${spotErrMsg ?? `filled ${spotFilled}`}; perp: ${perpErrMsg ?? "ok"}${manual ? " — MANUAL CHECK REQUIRED" : ""}`,
        meta: { mode: "spot-perp", spotPending, spotHeld, shortOpen, ...(warnings.length > 0 && { warnings }) },
      });
      const result = {
        status: spotPending ? "spot_pending" : (spotErrMsg !== null && perpErrMsg !== null ? "both_failed" : "rolled_back"),
        mode: "spot-perp", symbol: sym,
        spotError: spotErrMsg, perpError: perpErrMsg,
        spotHeld, perpShortOpen: shortOpen,
        ...(spotPending && { remediation: `Spot order outcome unknown — do NOT resubmit. Check: perp -e ${spotDef.id} trade spot-balance; the perp leg was reduced to match.` }),
        ...(warnings.length > 0 && { warnings }),
      };
      // pending spot → ORDER_PENDING; an incomplete rollback (quarantined) → ORDER_PARTIAL; else nothing open → ORDER_REJECTED.
      reportExecFailure(spotPending ? "ORDER_PENDING" : manual ? "ORDER_PARTIAL" : "ORDER_REJECTED",
        `arb exec spot:${spotExch} ${sym}: not hedged (${result.status}${manual ? ", quarantined" : ""})`, result);
      if (isJson()) return;
      if (spotErrMsg !== null) console.log(chalk.red(`    SPOT:  ${spotErrMsg}`));
      if (perpErrMsg !== null) console.log(chalk.red(`    PERP:  ${perpErrMsg}`));
      for (const w of warnings) console.log(chalk.red.bold(`  ${w}`));
      if (spotPending) console.log(chalk.red.bold(`  SPOT ORDER PENDING — outcome unknown, do NOT resubmit. Verify ${spotDef.id} spot balance manually.\n`));
      else if (!manual) console.log(chalk.yellow(`  Not hedged — entry aborted: spot held ${spotHeld} ${sym}, perp short ${shortOpen}${spotErrMsg !== null && perpErrMsg !== null ? " (both legs rejected)" : " (the filled leg was rolled back)"}${warnings.length > 0 ? "; see warnings above" : ""}.\n`));
  }

  // ── Expose spot-close handler for consolidated "arb close" in arb/index.ts ──
  handleSpotClose = async (sym_arg, opts_arg, getAdapter, isJsonFn) => {
      const sym = sym_arg.toUpperCase();

      // Try to find the position from state
      const state = loadArbState(networkOf(program));
      const pos = state?.positions.find(p =>
        p.symbol.toUpperCase() === sym && p.mode === "spot-perp"
      );

      const venueIdOf = (v: string): string => resolveVenueId(v.replace(/-spot$/i, ""));
      const spotRaw = opts_arg.spotExch ?? pos?.spotExchange ?? pos?.longExchange;
      const perpRaw = opts_arg.perpExch ?? pos?.shortExchange;
      const spotExch = spotRaw === undefined ? undefined : venueIdOf(spotRaw);
      const perpExch = perpRaw === undefined ? undefined : venueIdOf(perpRaw);

      if (!spotExch || !perpExch) {
        throw new PerpError("INVALID_PARAMS", "Cannot determine the spot and perp exchanges of this spot-perp position", {
          remediation: `Pass both: perp arb close ${sym} --spot-exch <spot venue> --perp-exch <perp venue>`,
        });
      }

      // Load adapters (bot/arb spot scope)
      const spotDef = requireBotSpotVenue(spotExch.replace(/-spot$/, ""));
      const spotAdapter = await requireSpotAdapter(spotDef.id, await getAdapter(spotDef.id));

      const perpAdapter = await getAdapter(perpExch);
      const spotSymbol = spotPairSymbol(spotDef, spotNetworkOf(spotAdapter), sym);

      // Find how much to close — fresh read (the reduce-only close is sized from it, never a cached position)
      invalidateCache("acct");
      const perpPositions = await perpAdapter.getPositions();
      const perpPos = perpPositions.find(p =>
        p.symbol.replace("-PERP", "").toUpperCase() === sym && p.side === "short"
      );

      if (!perpPos) {
        const msg = `No short perp position found for ${sym} on ${perpExch}`;
        process.exitCode = 1;
        if (isJsonFn()) return printJson(jsonError("POSITION_NOT_FOUND", msg));
        console.log(chalk.red(`  ${msg}`)); return;
      }

      const closeSize = perpPos.size;
      if (!isJsonFn()) {
        console.log(chalk.cyan(`\n  Closing Spot+Perp Arb: ${sym}`));
        console.log(chalk.gray(`    SPOT  ${spotExch}: sell ${closeSize}`));
        console.log(chalk.gray(`    PERP  ${perpExch}: buy  ${closeSize} (close short)`));
        console.log(chalk.gray(`    Executing...\n`));
      }

      // Spot quote before the sale (uncached): only the proceeds above it are swept back.
      // Read before anything moves — a failure aborts the close.
      const preCloseQuote = await readSpotQuoteAvailableFresh(spotAdapter);

      // Same exchange → sequential (nonce collision), different → parallel.
      // The spot leg's REAL fill decides the outcome: only a confirmed spot sale
      // counts as closed; legs are re-matched so no naked short / unhedged spot is left.
      const sameVenue = spotDef.id === (tryResolveVenueId(perpExch) ?? perpExch);
      const closeDec = sizeDecimalsOf(closeSize);
      // The perp buy-back and every re-match order go through placePerpVerified:
      // only a measured position change counts; an unknown outcome stops the close.
      let spotResult: PromiseSettledResult<SpotFill>;
      let perpResult: PromiseSettledResult<PerpFill>;
      if (sameVenue) {
        spotResult = await spotMarketFill(spotAdapter, spotSymbol, "sell", closeSize)
          .then(r => ({ status: "fulfilled" as const, value: r }))
          .catch(e => ({ status: "rejected" as const, reason: e }));
        perpResult = await placePerpVerified(perpAdapter, perpExch, sym, "buy", closeSize, { reduceOnly: true })
          .then(r => ({ status: "fulfilled" as const, value: r }))
          .catch(e => ({ status: "rejected" as const, reason: e }));
      } else {
        [spotResult, perpResult] = await Promise.allSettled([
          spotMarketFill(spotAdapter, spotSymbol, "sell", closeSize),
          placePerpVerified(perpAdapter, perpExch, sym, "buy", closeSize, { reduceOnly: true }),
        ]);
      }

      const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
      const spotPending = spotResult.status === "rejected" && spotResult.reason instanceof PerpError && spotResult.reason.structured.code === "ORDER_PENDING";
      const sold = spotResult.status === "fulfilled" ? Math.min(spotResult.value.filledSize, Number(closeSize)) : 0;
      const soldStr = fillSizeString(sold, closeDec);
      const perpOk = perpResult.status === "fulfilled";
      const closeWarnings: string[] = [];
      /** Set when a perp outcome is unknown: quarantine and stop (no re-short, no further reduce). */
      let perpUnknown: string | null = perpResult.status === "rejected" && isOutcomeUnknown(perpResult.reason)
        ? `perp buy-back ${closeSize} on ${perpExch} outcome unknown: ${errMsg(perpResult.reason)}` : null;
      // Size still short on the perp (verified buy-back only), and spot still held (in closeSize units).
      const perpClosed = perpResult.status === "fulfilled" ? Number(fillSizeString(perpResult.value.filledSize, closeDec)) : 0;
      let shortLeft = Number(closeSize) - perpClosed;
      const spotLeft = Number(closeSize) - sold;

      if (perpUnknown === null && !spotPending) {
        const unhedgedSpot = Number(fillSizeString(Math.max(0, spotLeft - shortLeft), closeDec));
        const nakedShort = Number(fillSizeString(Math.max(0, shortLeft - spotLeft), closeDec));
        if (unhedgedSpot > 0) {
          // Only reachable after a VERIFIED buy-back: spot sold less — re-short the unsold spot to stay hedged.
          const reShort = fillSizeString(unhedgedSpot, closeDec);
          try {
            const rs = await placePerpVerified(perpAdapter, perpExch, sym, "sell", reShort);
            const reShorted = fillSizeString(rs.filledSize, closeDec);
            shortLeft += Number(reShorted);
            // A partial re-short (accepted partial fill) leaves part of the unsold spot unhedged.
            closeWarnings.push(Number(reShorted) < Number(reShort)
              ? `Spot sold ${soldStr} of ${closeSize} ${sym}; re-short on ${perpExch} filled ${reShorted} of ${reShort} — ${fillSizeString(Number(reShort) - Number(reShorted), closeDec)} spot unhedged, MANUAL ACTION REQUIRED`
              : `Spot sold ${soldStr} of ${closeSize} ${sym}; re-shorted ${reShort} on ${perpExch} (verified) — stays open (hedged)`);
          } catch (e) {
            if (isOutcomeUnknown(e)) perpUnknown = `re-short of the unsold ${reShort} ${sym} on ${perpExch} outcome unknown: ${errMsg(e)}`;
            else closeWarnings.push(`Re-short of the unsold ${reShort} ${sym} FAILED: ${errMsg(e)} — unhedged spot on ${spotExch}, MANUAL ACTION REQUIRED`);
          }
        } else if (nakedShort > 0) {
          // Spot sold more than the perp bought back: reduce the short to the spot left (no naked short).
          const reduce = fillSizeString(nakedShort, closeDec);
          try {
            const rd = await placePerpVerified(perpAdapter, perpExch, sym, "buy", reduce, { reduceOnly: true });
            const reduced = fillSizeString(rd.filledSize, closeDec);
            shortLeft -= Number(reduced);
            // A partial reduce (accepted partial fill) leaves part of the short naked.
            if (Number(reduced) < Number(reduce)) closeWarnings.push(`Perp reduce on ${perpExch} filled ${reduced} of ${reduce} ${sym} — ${fillSizeString(Number(reduce) - Number(reduced), closeDec)} short naked, MANUAL CLOSE REQUIRED`);
          } catch (e) {
            if (isOutcomeUnknown(e)) perpUnknown = `perp reduce of ${reduce} ${sym} on ${perpExch} outcome unknown: ${errMsg(e)}`;
            else closeWarnings.push(`Perp still short ${fillSizeString(shortLeft, closeDec)} ${sym} on ${perpExch} while ${soldStr} spot was sold (${errMsg(e)}) — MANUAL CLOSE REQUIRED`);
          }
        }
      }
      if (spotPending) {
        closeWarnings.push(`Spot sell PENDING (${errMsg((spotResult as PromiseRejectedResult).reason)}) — outcome unknown, do NOT resubmit; verify ${spotDef.id} spot balance and the ${perpExch} short manually`);
      }
      if (perpUnknown !== null) {
        closeWarnings.push(`${perpUnknown} — do NOT resubmit; verify the ${perpExch} short and ${spotDef.id} spot balance manually`);
      }
      if (spotPending || perpUnknown !== null || closeWarnings.some(w => w.includes("MANUAL"))) {
        // Persisted globally: bots, the daemon and later arb runs leave the symbol alone.
        quarantineSymbol("arb-close", sym, `arb close spot:${spotExch}: ${spotPending || perpUnknown !== null ? closeWarnings.filter(w => w.includes("PENDING") || w.includes("unknown")).join("; ") : closeWarnings.join("; ")}`,
          `Check ${sym} on ${spotDef.id} spot (perp -e ${spotDef.id} trade spot-balance / spot-orders) and the ${perpExch} perp (perp -e ${perpExch} positions)`,
          (m) => console.error(m));
      }
      if (perpUnknown !== null) {
        // Stop: the perp position is unknown, so neither the stored legs nor the proceeds are touched.
        logExecution({
          type: "arb_close", exchange: `spot:${spotExch}+${perpExch}`,
          symbol: sym, side: "exit", size: soldStr,
          status: "failed", dryRun: false,
          error: `${perpUnknown} — MANUAL CHECK REQUIRED`,
          meta: { mode: "spot-perp", requestedSize: closeSize, spotSold: sold, spotPending, perpPending: true, warnings: closeWarnings },
        });
        const result = {
          status: "perp_pending", mode: "spot-perp", symbol: sym,
          spotSold: soldStr, spotPending, perpError: perpUnknown, warnings: closeWarnings,
          remediation: `Perp order outcome unknown — do NOT resubmit. Check: perp -e ${perpExch} positions; perp -e ${spotDef.id} trade spot-balance`,
        };
        if (isJsonFn()) return printJson(jsonOk(result));
        for (const w of closeWarnings) console.log(chalk.red.bold(`  ${w}`));
        console.log(chalk.red.bold(`  PERP ORDER PENDING — close stopped; spot ${spotPending ? "PENDING" : `sold ${soldStr}`}. ${sym} quarantined.\n`));
        return;
      }

      shortLeft = Number(fillSizeString(Math.max(0, shortLeft), closeDec));
      const fullyClosed = perpOk && sold > 0 && Number(soldStr) >= Number(closeSize) && shortLeft === 0 && !spotPending;
      if (fullyClosed) {
        persistRemovePosition(networkOf(program), sym);
      } else if (!spotPending && (shortLeft > 0 || spotLeft > 0)) {
        // Persist the legs that remain (actual sizes).
        persistUpdatePosition(networkOf(program), sym, { longSize: spotLeft, shortSize: shortLeft });
      }

      // Return spot quote proceeds back to perp account (no-op when shared with perp)
      if (sold > 0) {
        try {
          const moved = await sweepSpotQuoteToPerp(spotAdapter, 0.01, { keep: preCloseQuote, max: null });
          if (moved > 0 && !isJsonFn()) console.log(chalk.gray(`  Returned ~$${moved.toFixed(2)} spot→perp on ${spotDef.displayName}`));
        } catch (e) {
          closeWarnings.push(`Spot→perp transfer of proceeds failed (funds remain in ${spotDef.id} spot): ${errMsg(e)}`);
        }
      }

      logExecution({
        type: "arb_close", exchange: `spot:${spotExch}+${perpExch}`,
        symbol: sym, side: "exit", size: soldStr,
        status: fullyClosed ? "success" : "failed", dryRun: false,
        meta: { mode: "spot-perp", requestedSize: closeSize, spotSold: sold, perpOk, spotPending, shortLeft, spotLeft, ...(closeWarnings.length > 0 && { warnings: closeWarnings }) },
      });

      const closeResult = {
        status: fullyClosed ? "closed" : spotPending ? "spot_pending" : "partial_close",
        mode: "spot-perp", symbol: sym, size: closeSize,
        spotSold: soldStr, perpClosed: perpOk,
        spotError: spotResult.status === "rejected" ? errMsg(spotResult.reason) : null,
        perpError: perpResult.status === "rejected" ? errMsg(perpResult.reason) : null,
        remaining: { spot: spotLeft, perpShort: shortLeft },
        ...(closeWarnings.length > 0 && { warnings: closeWarnings }),
      };
      if (isJsonFn()) return printJson(jsonOk(closeResult));
      for (const w of closeWarnings) console.log(chalk.yellow(`  ⚠ ${w}`));
      if (fullyClosed) {
        console.log(chalk.green(`  CLOSED: ${sym} ${closeSize} units`));
        console.log(chalk.green(`    SPOT  ${spotExch}: sold ${soldStr} ✓`));
        console.log(chalk.green(`    PERP  ${perpExch}: bought (closed short) ✓\n`));
      } else {
        console.log(chalk.red(`  Close incomplete: spot sold ${soldStr} of ${closeSize}, perp ${perpOk ? "closed" : "NOT closed"}`));
        if (closeResult.spotError) console.log(chalk.red(`    SPOT: ${closeResult.spotError}`));
        if (closeResult.perpError) console.log(chalk.red(`    PERP: ${closeResult.perpError}`));
        console.log(chalk.yellow(`  Remaining: spot ${spotLeft} / perp short ${shortLeft}\n`));
      }
    };

  // ── arb pnl logic (extracted as inner function, no command registration) ──

  async function _handleArbPnl() {
      if (!isJson()) console.log(chalk.cyan("\n  Checking arb positions...\n"));

      const exchangeNames = ["hyperliquid", "lighter", "pacifica"];
      // A venue whose positions could not be read is reported (never dropped): pairs that may
      // involve it are UNKNOWN, not naked. Only a venue with no credentials is skipped — and said so.
      const { positions: allPositions, positionErrors, notConfigured } = await collectArbPnlPositions(exchangeNames, getAdapterForExchange);
      const failedVenues = Object.keys(positionErrors);
      if (!isJson()) {
        for (const ex of notConfigured) console.log(chalk.gray(`  ${ex}: not configured (no credentials) — skipped`));
        for (const [ex, msg] of Object.entries(positionErrors)) console.error(chalk.red(`  ${ex}: positions unavailable — ${msg} (pairs involving ${ex} are UNKNOWN)`));
      }

      if (allPositions.length === 0) {
        if (isJson()) return printJson(jsonOk({ pairs: [], positionErrors, notConfigured }));
        console.log(failedVenues.length > 0
          ? chalk.yellow(`  No positions read — ${failedVenues.join(", ")} unavailable, holdings there are UNKNOWN.\n`)
          : chalk.gray("  No positions found on any configured exchange.\n"));
        return;
      }

      // Group by symbol to find arb pairs
      const bySymbol = new Map<string, typeof allPositions>();
      for (const p of allPositions) {
        const key = p.symbol.toUpperCase();
        if (!bySymbol.has(key)) bySymbol.set(key, []);
        bySymbol.get(key)!.push(p);
      }

      // Get current funding rates
      const spreads = await fetchFundingSpreads();
      const spreadMap = new Map(spreads.map(s => [s.symbol.toUpperCase(), s]));

      // Get fee rates (approximate)
      const TAKER_FEE = getTakerFee("default");

      // Fetch actual settled funding payments from each exchange
      const actualFundingByExSymbol = new Map<string, number>(); // "exchange:SYMBOL" → total settled USD
      // Venues whose funding history could not be read: their symbols' actualFunding is null, never 0.
      const fundingErrors: Record<string, string> = {};
      for (const exName of exchangeNames) {
        try {
          const adapter = await getAdapterForExchange(exName);
          const payments = await adapter.getFundingPayments(100);
          for (const fp of payments) {
            const sym = fp.symbol.replace("-PERP", "").toUpperCase();
            const key = `${exName}:${sym}`;
            actualFundingByExSymbol.set(key, (actualFundingByExSymbol.get(key) ?? 0) + Number(fp.payment));
          }
        } catch (e) {
          fundingErrors[exName] = e instanceof Error ? e.message : String(e);
        }
      }
      /** Settled funding of `symbol` across its legs; null when a leg's venue history was not read. */
      const actualFundingOf = (symbol: string, positions: Array<{ exchange: string }>): number | null => {
        let sum = 0;
        for (const p of positions) {
          if (fundingErrors[p.exchange] !== undefined) return null;
          sum += actualFundingByExSymbol.get(`${p.exchange}:${symbol}`) ?? 0; // read, no payment for this symbol = 0
        }
        return sum;
      };

      if (isJson()) {
        const result = [...bySymbol.entries()].map(([symbol, positions]) => {
          const spread = spreadMap.get(symbol);
          const failed = positions.map(p => fundingErrors[p.exchange] === undefined ? null : `${p.exchange}: ${fundingErrors[p.exchange]}`).filter((x): x is string => x !== null);
          return { symbol, positions, pairStatus: arbPnlPairStatus(positions, failedVenues), currentSpread: spread === undefined ? null : spread.spread, actualFunding: actualFundingOf(symbol, positions), fundingError: failed.length > 0 ? failed.join("; ") : null };
        });
        return printJson(jsonOk({ pairs: result, positionErrors, notConfigured }));
      }

      let totalUpnl = 0;
      let totalFees = 0;
      let totalEstFunding = 0;
      let totalActualFunding = 0;
      let actualFundingIncomplete = false;

      for (const [symbol, positions] of bySymbol) {
        const pairStatus = arbPnlPairStatus(positions, failedVenues);
        const spread = spreadMap.get(symbol);

        console.log(chalk.white.bold(`  ${symbol}`) + (pairStatus === "arb" ? chalk.green(" [ARB PAIR]")
          : pairStatus === "unknown" ? chalk.yellow(` [UNKNOWN — ${failedVenues.join(", ")} positions unread]`)
          : chalk.gray(" [single]")));

        for (const p of positions) {
          const sideColor = p.side === "long" ? chalk.green : chalk.red;
          const pnlColor = p.upnl >= 0 ? chalk.green : chalk.red;
          const notional = p.size * p.mark;
          const entryFee = p.size * p.entry * TAKER_FEE;
          totalFees += entryFee;
          totalUpnl += p.upnl;

          console.log(
            `    ${sideColor(p.side.toUpperCase().padEnd(6))} ${p.exchange.padEnd(13)} ` +
            `size: ${p.size.toFixed(2).padEnd(8)} entry: $${p.entry.toFixed(4).padEnd(10)} ` +
            `mark: $${p.mark.toFixed(4).padEnd(10)} uPnL: ${pnlColor(p.upnl >= 0 ? "+" : "")}$${p.upnl.toFixed(4)}`
          );
          console.log(chalk.gray(`           notional: $${notional.toFixed(2)}  est.entry fee: $${entryFee.toFixed(4)}  lev: ${p.lev}x`));
        }

        if (spread) {
          const grossSpread = Math.abs(spread.spread);
          const rtCost = computeRoundTripCostPct(spread.longExch, spread.shortExch);
          const netSpread = computeNetSpread(grossSpread, 7, rtCost, 0.5, 100);
          const grossColor = grossSpread >= 20 ? chalk.green : grossSpread >= 10 ? chalk.yellow : chalk.gray;
          const netColor = netSpread >= 15 ? chalk.green : netSpread >= 0 ? chalk.yellow : chalk.red;
          // Estimate hourly funding income for this pair
          const longPos = positions.find(p => p.side === "long");
          const shortPos = positions.find(p => p.side === "short");
          if (longPos && shortPos) {
            const avgNotional = (longPos.size * longPos.mark + shortPos.size * shortPos.mark) / 2;
            const hourlyIncome = (grossSpread / 100) / (24 * 365) * avgNotional;
            const dailyIncome = hourlyIncome * 24;
            console.log(chalk.cyan(
              `    Gross: ${grossColor(`${grossSpread.toFixed(1)}%`)} | ` +
              `Net: ${netColor(`${netSpread.toFixed(1)}%`)} | ` +
              `Fees: ${chalk.gray(`${rtCost.toFixed(2)}%`)} | ` +
              `Est. income: $${hourlyIncome.toFixed(4)}/hr, $${dailyIncome.toFixed(3)}/day`
            ));

            // Look up entry time from execution log for funding estimation
            const entryLog = readExecutionLog({ type: "arb_entry", symbol }).filter(e => e.status === "success")[0];
            const entryTime = entryLog?.timestamp ? new Date(entryLog.timestamp).getTime() : null;
            const holdHours = entryTime ? (Date.now() - entryTime) / (1000 * 60 * 60) : null;

            // Estimated funding based on current spread × hold time
            const estFunding = holdHours !== null ? hourlyIncome * holdHours : 0;

            // Actual settled funding from exchange APIs (null = a leg's venue history was not read)
            const actualFunding = actualFundingOf(symbol, positions);

            totalEstFunding += estFunding;
            const fmtVal = (v: number) => v >= 0 ? `$${v.toFixed(4)}` : `-$${Math.abs(v).toFixed(4)}`;
            if (actualFunding === null) {
              actualFundingIncomplete = true;
              console.log(chalk.white(`    Funding: Est. ${chalk.yellow(fmtVal(estFunding))} / Actual ${chalk.yellow("unavailable")}`));
            } else {
              totalActualFunding += actualFunding;
              const diff = actualFunding - estFunding;
              const diffColor = Math.abs(diff) < 0.01 ? chalk.gray : diff >= 0 ? chalk.green : chalk.red;
              console.log(chalk.white(
                `    Funding: Est. ${chalk.yellow(fmtVal(estFunding))} / ` +
                `Actual ${chalk.cyan(fmtVal(actualFunding))} / ` +
                `Diff: ${diffColor(fmtVal(diff))}`
              ));
            }
          }
        }
        console.log();
      }

      // Summary
      const exitFees = allPositions.reduce((s, p) => s + p.size * p.mark * TAKER_FEE, 0);
      totalFees += exitFees;
      const netPnl = totalUpnl - totalFees + totalActualFunding;

      console.log(chalk.white.bold("  Summary"));
      const upnlColor = totalUpnl >= 0 ? chalk.green : chalk.red;
      const netColor = netPnl >= 0 ? chalk.green : chalk.red;
      console.log(`    Unrealized PnL:  ${upnlColor(`$${totalUpnl.toFixed(4)}`)}`);
      console.log(`    Est. fees (in+out): ${chalk.red(`-$${totalFees.toFixed(4)}`)}`);
      if (totalActualFunding !== 0 || totalEstFunding !== 0) {
        const fundingDiff = totalActualFunding - totalEstFunding;
        const diffPct = totalEstFunding !== 0 ? ((fundingDiff / Math.abs(totalEstFunding)) * 100).toFixed(1) : "N/A";
        console.log(`    Est. funding:    ${chalk.yellow(`$${totalEstFunding.toFixed(4)}`)}`);
        console.log(`    Actual funding:  ${chalk.cyan(`$${totalActualFunding.toFixed(4)}`)}${actualFundingIncomplete ? chalk.yellow(" (incomplete: some venues' funding history unavailable)") : ""}`);
        console.log(`    Funding diff:    ${fundingDiff >= 0 ? chalk.green(`+$${fundingDiff.toFixed(4)}`) : chalk.red(`-$${Math.abs(fundingDiff).toFixed(4)}`)} (${diffPct}%)`);
      }
      console.log(`    Net (if closed now): ${netColor(`$${netPnl.toFixed(4)}`)}${actualFundingIncomplete ? chalk.yellow(" (excludes unread funding)") : ""}`);
      for (const [ex, msg] of Object.entries(fundingErrors)) console.log(chalk.yellow(`    ${ex} funding history unavailable: ${msg}`));
      console.log(chalk.gray(`    (Fees assume ${(TAKER_FEE * 100).toFixed(3)}% taker. Actual may vary.)`));
      console.log(chalk.gray(`    * Net includes actual settled funding where available.\n`));
  }

  // ── dex-monitor logic (accessed via 'arb scan --live --hip3') ──

  async function handleDexMonitor(opts: { min: string; interval: string; top: string; includeNative: boolean }) {
      const minSpread = parseFloat(opts.min);
      const intervalSec = parseInt(opts.interval);
      const topN = parseInt(opts.top);
      let cycle = 0;

      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  HIP-3 Cross-Dex Arb Monitor"));
        console.log(chalk.gray(`  Min spread: ${minSpread}% | Refresh: ${intervalSec}s | Top: ${topN}`));
        console.log(chalk.gray(`  Native HL: ${opts.includeNative ? "ON" : "OFF"}`));
        console.log(chalk.gray(`  Press Ctrl+C to stop\n`));
      }

      while (true) {
        cycle++;
        const ts = new Date().toLocaleTimeString();

        try {
          const { pairs, failedDexes } = await scanDexArb({
            minAnnualSpread: minSpread,
            includeNative: opts.includeNative,
          });
          // Failed dex reads are reported, never shown as "no opportunities" for that dex.
          for (const [dex, msg] of Object.entries(failedDexes)) console.error(chalk.yellow(`  ${ts} HIP-3 dex ${dex} unavailable: ${msg} — its pairs are missing this cycle`));
          const shown = pairs.slice(0, topN);

          // Clear previous output
          if (cycle > 1) {
            const linesToClear = shown.length + 4;
            process.stdout.write(`\x1b[${linesToClear}A\x1b[J`);
          }

          console.log(chalk.gray(`  ${ts} — Cycle ${cycle} | ${shown.length}/${pairs.length} opportunities >= ${minSpread}%\n`));

          if (shown.length === 0) {
            console.log(chalk.gray(`  No opportunities found.\n`));
          } else {
            for (const p of shown) {
              const spreadColor = p.annualSpread >= 50 ? chalk.green.bold
                : p.annualSpread >= 20 ? chalk.green : chalk.yellow;
              const viabilityColor = p.viability === "A" ? chalk.green.bold
                : p.viability === "B" ? chalk.green
                : p.viability === "C" ? chalk.yellow
                : chalk.red;
              const longFund = (p.long.fundingRate * 100).toFixed(4);
              const shortFund = (p.short.fundingRate * 100).toFixed(4);
              const fmtOi = p.minOiUsd >= 1_000_000 ? `$${(p.minOiUsd / 1_000_000).toFixed(1)}M`
                : p.minOiUsd >= 1_000 ? `$${(p.minOiUsd / 1_000).toFixed(0)}K`
                : `$${p.minOiUsd.toFixed(0)}`;
              console.log(
                `  ${chalk.white.bold(p.underlying.padEnd(10))} ` +
                `${spreadColor(`${p.annualSpread.toFixed(1)}%`.padEnd(8))} ` +
                `${viabilityColor(p.viability)} ` +
                `L:${p.long.dex}(${longFund}%) ` +
                `S:${p.short.dex}(${shortFund}%) ` +
                `$${formatUsd(p.long.markPrice)} ` +
                chalk.gray(`gap:${p.priceGapPct.toFixed(3)}%`) + ` ` +
                viabilityColor(`OI:${fmtOi}`)
              );
            }
            console.log();
          }
        } catch (err) {
          console.log(chalk.red(`  ${ts} Error: ${err instanceof Error ? err.message : err}\n`));
        }

        await new Promise(r => setTimeout(r, intervalSec * 1000));
      }
  }

  // ── dex-auto logic (accessed via 'arb auto --hip3') ── (HIP-3 cross-dex auto arb)

  async function handleDexAuto(opts: {
    minSpread: string; closeSpread: string; size: string;
    maxPositions: string; minOi: string; minGrade: string;
    interval: string; dryRun: boolean;
  }) {
    if (!getHLAdapterForDex) {
      console.log(chalk.red("  HIP-3 dex adapter not available."));
      return;
    }
        const minSpread = parseFloat(opts.minSpread);
        const closeSpread = parseFloat(opts.closeSpread);
        const sizeUsd = parseFloat(opts.size);
        const maxPositions = parseInt(opts.maxPositions);
        const minOi = parseFloat(opts.minOi);
        const gradeOrder = { A: 0, B: 1, C: 2, D: 3 } as Record<string, number>;
        const minGradeIdx = gradeOrder[opts.minGrade.toUpperCase()] ?? 2;
        const intervalMs = parseInt(opts.interval) * 1000;
        // Root --dry-run flag (never re-declared on the subcommand — the root would swallow it).
        const dryRun = isDryRun(program);

        interface DexArbPosition {
          underlying: string;
          longDex: string;
          longSymbol: string;
          shortDex: string;
          shortSymbol: string;
          size: string;
          entrySpread: number;
          entryTime: string;
          longPrice: number;
          shortPrice: number;
        }

        const openPositions: DexArbPosition[] = [];
        // Consecutive definite close failures per underlying (quarantined at MAX_PAIR_CLOSE_FAILURES)
        const dexCloseFailures = new Map<string, number>();
        const net = networkOf(program);
        const qlog = (m: string) => console.error(chalk.red(m));

        if (!dryRun) {
          // A previous daemon that died between two legs → quarantine (legs may be open).
          quarantineOrphanedEntries(net, "arb-dex-auto", qlog);
          // Positions live only in memory: a restart re-reads what is held on the dexes, so a
          // held underlying is managed (closed when the spread converges), never re-entered.
          // Unpaired / size-mismatched legs are quarantined. An unreadable dex → not started.
          // A transient 429 / timeout on one of the deployed dexes is retried (2 s, 5 s) before
          // refusing: a partial read is never cached, so each attempt re-reads every dex.
          let { assets, failedDexes: startFailed } = await fetchAllDexAssetsDetailed();
          for (const waitMs of [2_000, 5_000]) {
            if (Object.keys(startFailed).length === 0) break;
            console.error(chalk.yellow(`  HIP-3 dex read failed at start (${Object.keys(startFailed).join(", ")}) — retrying in ${waitMs / 1000}s`));
            await new Promise(r => setTimeout(r, waitMs));
            ({ assets, failedDexes: startFailed } = await fetchAllDexAssetsDetailed());
          }
          if (Object.keys(startFailed).length > 0) {
            // A dex not read → its held legs are unknown: not started (never re-enter a held pair).
            throw new PerpError("EXCHANGE_ERROR", `arb auto --hip3: dex market data unreadable at start (${Object.entries(startFailed).map(([d, m]) => `${d}: ${m}`).join("; ")}) — not started (held pairs unknown)`, {
              exchange: "hyperliquid", remediation: `Check connectivity (perp arb scan --hip3), then restart`,
            });
          }
          const pairsNow = findDexArbPairs(assets, { minAnnualSpread: 0, includeNative: true });
          const legs = new Map<string, { dex: string; raw: string; base: string; side: string; size: number; sizeStr: string; underlying: string }>();
          for (const dex of [...new Set(assets.map(a => a.dex))]) {
            let list: Awaited<ReturnType<ExchangeAdapter["getPositions"]>>;
            try {
              list = await (await getHLAdapterForDex(dex)).getPositions();
            } catch (e) {
              throw new PerpError("EXCHANGE_ERROR", `arb auto --hip3: ${dex} positions unreadable at start (${e instanceof Error ? e.message : String(e)}) — not started (held pairs unknown)`, {
                exchange: "hyperliquid", remediation: `Check connectivity (perp -e hyperliquid account positions), then restart`,
              });
            }
            for (const p of list) {
              const size = Math.abs(Number(p.size));
              if (!(size > 0)) continue;
              const raw = p.symbol.toUpperCase();
              const asset = assets.find(a => a.dex === dex && (a.raw.toUpperCase() === raw || (dex === "hl" && a.base.toUpperCase() === raw)))
                ?? assets.find(a => a.raw.toUpperCase() === raw);
              const assetRaw = asset?.raw ?? p.symbol;
              const pairOf = pairsNow.find(x => x.long.raw === assetRaw || x.short.raw === assetRaw);
              // One entry per venue symbol (a native read that also lists HIP-3 positions is not counted twice).
              legs.set(assetRaw.toUpperCase(), {
                dex: asset?.dex ?? dex, raw: assetRaw, base: asset?.base ?? raw, side: p.side, size, sizeStr: p.size.replace(/^-/, ""),
                underlying: pairOf?.underlying ?? quarantineKey(asset?.base ?? raw),
              });
            }
          }
          const all = [...legs.values()];
          const used = new Set<(typeof all)[number]>();
          for (const l of all) {
            if (l.side !== "long" || used.has(l)) continue;
            const sh = all.find(x => !used.has(x) && x.side === "short" && x.underlying === l.underlying && x.dex !== l.dex && x.size === l.size);
            if (sh === undefined) continue;
            used.add(l); used.add(sh);
            openPositions.push({ underlying: l.underlying, longDex: l.dex, longSymbol: l.raw, shortDex: sh.dex, shortSymbol: sh.raw, size: l.sizeStr, entrySpread: 0, entryTime: new Date().toISOString(), longPrice: 0, shortPrice: 0 });
          }
          const leftover = new Map<string, (typeof all)[number][]>();
          for (const l of all) if (!used.has(l)) leftover.set(l.underlying, [...(leftover.get(l.underlying) ?? []), l]);
          for (const [u, group] of leftover) {
            if (isQuarantined(u, qlog)) continue;
            const desc = group.map(l => `${l.side} ${l.sizeStr} ${l.raw}`).join(", ");
            const mismatched = group.some(l => l.side === "long") && group.some(l => l.side === "short");
            quarantineSymbol("arb-dex-auto", u,
              mismatched ? `recovery: ${u} long/short sizes do not match (${desc}) — not tracked as a pair` : `recovery: unpaired ${u} leg (${desc}) — no hedge found, not tracked`,
              `Check ${u} on Hyperliquid (perp -e hyperliquid account positions; every HIP-3 dex); close or re-hedge by hand, then: perp strategy quarantine-clear ${u}`, qlog);
          }
          if (openPositions.length > 0 && !isJson()) {
            console.log(chalk.yellow(`  Recovered ${openPositions.length} pair(s) from the dexes: ${openPositions.map(p => `${p.underlying} ${p.longDex}/${p.shortDex} ${p.size}`).join(", ")}`));
          }
        }

        // Graceful stop: the leg sequence in flight finishes, nothing new starts, then exit.
        const stop = gracefulStop("arb auto --hip3");

        if (!isJson()) {
          console.log(chalk.cyan.bold("\n  HIP-3 Cross-Dex Arb Bot\n"));
          console.log(`  Mode:          ${dryRun ? chalk.yellow("DRY RUN") : chalk.green("LIVE")}`);
          console.log(`  Enter spread:  >= ${minSpread}% annual`);
          console.log(`  Close spread:  <= ${closeSpread}% annual`);
          console.log(`  Size per leg:  $${sizeUsd}`);
          console.log(`  Max positions: ${maxPositions}`);
          console.log(`  Min OI:        $${formatUsd(minOi)}`);
          console.log(`  Min grade:     ${opts.minGrade.toUpperCase()}`);
          console.log(`  Interval:      ${opts.interval}s`);
          console.log(chalk.gray("\n  Monitoring... (Ctrl+C to stop)\n"));
        }

        const cycle = async () => {
          try {
            const { pairs, failedDexes } = await scanDexArb({
              minAnnualSpread: 0, // get all, filter ourselves
              includeNative: true,
            });

            const now = new Date().toLocaleTimeString();
            for (const [dex, msg] of Object.entries(failedDexes)) console.error(chalk.yellow(`  ${now} HIP-3 dex ${dex} unavailable: ${msg}`));

            // Check close conditions
            for (let i = openPositions.length - 1; i >= 0; i--) {
              if (stop.requested()) break; // stopping: no new close sequence
              const pos = openPositions[i];
              // A leg's dex not read this cycle → spread unknown: never close on missing data.
              const unreadDex = dexCloseBlockedBy(pos, failedDexes);
              if (unreadDex !== null) {
                console.error(chalk.yellow(`  ${now} dex ${unreadDex} unavailable — ${pos.underlying} position kept, re-checked next cycle`));
                continue;
              }
              // Find current pair for this position
              const current = pairs.find(p =>
                p.underlying === pos.underlying &&
                ((p.long.dex === pos.longDex && p.short.dex === pos.shortDex) ||
                 (p.long.dex === pos.shortDex && p.short.dex === pos.longDex))
              );

              const currentSpread = current?.annualSpread ?? 0;

              if (currentSpread <= closeSpread || !current) {
                // Quarantined: hands off until a human clears it.
                if (isQuarantined(pos.underlying, (m) => console.error(chalk.red(m)))) continue;
                const reason = !current ? "pair disappeared" : `spread ${currentSpread.toFixed(1)}% <= ${closeSpread}%`;
                if (!isJson()) console.log(chalk.yellow(`  ${now} CLOSE ${pos.underlying} — ${reason}`));

                if (!dryRun) {
                  try {
                    const longAdapter = await getHLAdapterForDex!(pos.longDex);
                    const shortAdapter = await getHLAdapterForDex!(pos.shortDex);
                    // Sequential, reduce-only, verified; unknown / unhedged → quarantine.
                    const res = await closePerpPairVerified({
                      source: "arb-dex-auto", sym: pos.underlying,
                      longAdapter, longExch: pos.longDex, longSym: pos.longSymbol, longSize: pos.size,
                      shortAdapter, shortExch: pos.shortDex, shortSym: pos.shortSymbol, shortSize: pos.size, smart: false,
                      log: (m) => console.error(chalk.red(m)),
                    });
                    if (res.status === "closed") {
                      dexCloseFailures.delete(pos.underlying);
                      logExecution({
                        type: "arb_close", exchange: `${pos.longDex}+${pos.shortDex}`,
                        symbol: pos.underlying, side: "close", size: String(pos.size),
                        status: "success", dryRun: false,
                        meta: { longDex: pos.longDex, shortDex: pos.shortDex, reason, longSymbol: pos.longSymbol, shortSymbol: pos.shortSymbol },
                      });
                      if (!isJson()) console.log(chalk.green(`  ${now} CLOSED ${pos.underlying} — both legs (reduce-only, verified)`));
                      openPositions.splice(i, 1);
                    } else {
                      let note = res.reason;
                      if (res.status === "failed") {
                        const n = (dexCloseFailures.get(pos.underlying) ?? 0) + 1;
                        dexCloseFailures.set(pos.underlying, n);
                        note = `${res.reason} — both legs still open (${n}/${MAX_PAIR_CLOSE_FAILURES})`;
                        if (n >= MAX_PAIR_CLOSE_FAILURES) {
                          quarantinePair("arb-dex-auto", pos.underlying, pos.longDex, pos.shortDex,
                            `close failed ${n} times in a row (last: ${res.reason})`, (m) => console.error(chalk.red(m)));
                        }
                      }
                      logExecution({
                        type: "arb_close", exchange: `${pos.longDex}+${pos.shortDex}`,
                        symbol: pos.underlying, side: "close", size: String(pos.size),
                        status: "failed", dryRun: false,
                        error: res.status === "quarantined" ? `QUARANTINED: ${note}` : note,
                        meta: { longDex: pos.longDex, shortDex: pos.shortDex },
                      });
                      if (!isJson()) console.error(chalk.red(`  ${now} CLOSE ${res.status === "quarantined" ? "QUARANTINED" : "FAILED"} ${pos.underlying}: ${note}`));
                      // Kept tracked: exposure remains (retried only after a definite, no-change failure).
                    }
                  } catch (err) {
                    logExecution({
                      type: "arb_close", exchange: `${pos.longDex}+${pos.shortDex}`,
                      symbol: pos.underlying, side: "close", size: String(pos.size),
                      status: "failed", dryRun: false,
                      error: err instanceof Error ? err.message : String(err),
                      meta: { longDex: pos.longDex, shortDex: pos.shortDex },
                    });
                    if (!isJson()) console.error(chalk.red(`  ${now} CLOSE FAILED ${pos.underlying}: ${err instanceof Error ? err.message : err} (nothing sent)`));
                  }
                } else {
                  openPositions.splice(i, 1);
                }
              }
            }

            // Check entry conditions
            if (openPositions.length < maxPositions) {
              for (const pair of pairs) {
                if (stop.requested()) break; // stopping: no new entries
                if (openPositions.some(p => p.underlying === pair.underlying)) continue;
                if (openPositions.length >= maxPositions) break;
                if (pair.annualSpread < minSpread) continue;
                if (pair.minOiUsd < minOi) continue;
                if (gradeOrder[pair.viability] > minGradeIdx) continue;
                if (isQuarantined(pair.underlying, (m) => console.error(chalk.red(m)))) continue;

                // Calculate size in asset units
                const avgPrice = (pair.long.markPrice + pair.short.markPrice) / 2;
                if (avgPrice <= 0) continue;
                const szDecimals = Math.min(pair.long.szDecimals, pair.short.szDecimals);
                const rawSize = sizeUsd / avgPrice;
                const size = fillSizeString(rawSize, szDecimals); // floored
                if (!(Number(size) > 0)) continue;

                if (!isJson()) {
                  console.log(chalk.green(
                    `  ${now} ENTER ${pair.underlying} — spread ${pair.annualSpread.toFixed(1)}% grade:${pair.viability} OI:$${formatUsd(pair.minOiUsd)}` +
                    `\n         Long ${pair.long.dex}:${pair.long.base} (${(pair.long.fundingRate * 100).toFixed(4)}%)` +
                    ` | Short ${pair.short.dex}:${pair.short.base} (${(pair.short.fundingRate * 100).toFixed(4)}%)` +
                    ` | ${size} units @ $${avgPrice.toFixed(2)}`
                  ));
                }

                let openedSize = size;
                if (!dryRun) {
                  // Pending-entry record BEFORE the first leg (crash between legs → quarantine at the next start).
                  try {
                    writePendingEntry(net, { source: "arb-dex-auto", symbol: pair.underlying, longExchange: pair.long.dex, shortExchange: pair.short.dex, size });
                  } catch (e) {
                    if (!isJson()) console.error(chalk.red(`  ${now} SKIP ${pair.underlying}: could not record the pending entry (${e instanceof Error ? e.message : String(e)}) — nothing sent`));
                    continue;
                  }
                  let legsStarted = false;
                  try {
                    const longAdapter = await getHLAdapterForDex!(pair.long.dex);
                    const shortAdapter = await getHLAdapterForDex!(pair.short.dex);
                    // Sequential verified legs; reduce-only rollback / trim; unknown → quarantine.
                    legsStarted = true;
                    const res = await openPerpPairVerified({
                      source: "arb-dex-auto", sym: pair.underlying,
                      longAdapter, longExch: pair.long.dex, longSym: pair.long.raw,
                      shortAdapter, shortExch: pair.short.dex, shortSym: pair.short.raw,
                      size, smart: false, log: (m) => console.error(chalk.red(m)),
                    });
                    legsStarted = false; // outcome known
                    if (res.status !== "opened") {
                      finishPendingEntry(net, "arb-dex-auto", pair.underlying, qlog);
                      const error = res.status === "quarantined"
                        ? `QUARANTINED: ${res.reason} (possible exposure: ${res.exposure})`
                        : `${res.reason}${res.rolledBack !== null ? ` — long ${res.rolledBack} rolled back` : ""}`;
                      logExecution({
                        type: "arb_entry", exchange: `${pair.long.dex}+${pair.short.dex}`,
                        symbol: pair.underlying, side: "entry", size,
                        status: "failed", dryRun: false, error,
                        meta: { longDex: pair.long.dex, shortDex: pair.short.dex, spread: pair.annualSpread },
                      });
                      if (!isJson()) console.error(chalk.red(`  ${now} ENTRY FAILED ${pair.underlying}: ${error}`));
                      continue;
                    }
                    openedSize = res.hedged;
                    // Tracked in memory below (synchronously, before anything else can throw); a restart recovers it from the dexes.
                    finishPendingEntry(net, "arb-dex-auto", pair.underlying, qlog);
                    logExecution({
                      type: "arb_entry", exchange: `${pair.long.dex}+${pair.short.dex}`,
                      symbol: pair.underlying, side: "entry", size: res.hedged,
                      status: "success", dryRun: false,
                      meta: { longDex: pair.long.dex, shortDex: pair.short.dex, spread: pair.annualSpread, viability: pair.viability, avgPrice, requested: size },
                    });
                    if (!isJson()) console.log(chalk.green(`  ${now} FILLED ${pair.underlying} — both legs @ ${res.hedged} (verified)`));
                  } catch (err) {
                    logExecution({
                      type: "arb_entry", exchange: `${pair.long.dex}+${pair.short.dex}`,
                      symbol: pair.underlying, side: "entry", size,
                      status: "failed", dryRun: false,
                      error: err instanceof Error ? err.message : String(err),
                      meta: { longDex: pair.long.dex, shortDex: pair.short.dex, spread: pair.annualSpread },
                    });
                    if (legsStarted) {
                      // Threw inside the leg sequence: what is open is unknown → quarantine (never retried).
                      quarantinePair("arb-dex-auto", pair.underlying, pair.long.dex, pair.short.dex,
                        `entry threw mid-sequence (${err instanceof Error ? err.message : String(err)}) — legs may be open`, qlog);
                    }
                    finishPendingEntry(net, "arb-dex-auto", pair.underlying, qlog);
                    if (!isJson()) console.error(chalk.red(`  ${now} ENTRY FAILED ${pair.underlying}: ${err instanceof Error ? err.message : err}${legsStarted ? " (quarantined)" : " (nothing sent)"}`));
                    continue;
                  }
                }

                openPositions.push({
                  underlying: pair.underlying,
                  longDex: pair.long.dex,
                  longSymbol: pair.long.raw,
                  shortDex: pair.short.dex,
                  shortSymbol: pair.short.raw,
                  size: openedSize,
                  entrySpread: pair.annualSpread,
                  entryTime: new Date().toISOString(),
                  longPrice: pair.long.markPrice,
                  shortPrice: pair.short.markPrice,
                });
              }
            }

            // Status
            if (isJson()) {
              printJson(jsonOk({
                timestamp: new Date().toISOString(),
                openPositions,
                availablePairs: pairs.filter(p => p.annualSpread >= minSpread && p.minOiUsd >= minOi).length,
              }));
            } else if (openPositions.length > 0) {
              console.log(chalk.gray(
                `  ${now} Positions: ${openPositions.length}/${maxPositions} — ` +
                openPositions.map(p => `${p.underlying}(${p.entrySpread.toFixed(0)}%)`).join(", ")
              ));
            } else {
              console.log(chalk.gray(`  ${now} No positions. ${pairs.filter(p => p.annualSpread >= minSpread).length} pairs above ${minSpread}%`));
            }
          } catch (err) {
            if (!isJson()) console.error(chalk.gray(`  Error: ${err instanceof Error ? err.message : String(err)}`));
          }
        };

        // Serialized cycles (never overlapping): the next starts only after this one finished.
        while (!stop.requested()) {
          await cycle();
          await interruptibleSleep(intervalMs, stop.requested);
        }
        stop.dispose();
        if (!isJson()) console.log(chalk.yellow(`\n  HIP-3 daemon stopped (current cycle finished). ${openPositions.length} pair(s) left open: ${openPositions.map(p => `${p.underlying} ${p.longDex}/${p.shortDex}`).join(", ") || "none"}\n`));
        process.exit(0);
  }

  // Expose inner handlers for external use
  handleArbPnlRef = _handleArbPnl;
}


// Module-level exported references (assigned inside registerArbAutoCommands)
export let handleArbPnlRef: (() => Promise<void>) | undefined;

/**
 * Exported wrapper for handleArbPnl.
 */
export async function handleArbPnl(
  getAdapterForExchange: (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
  isJson: () => boolean,
): Promise<void> {
  if (handleArbPnlRef) return handleArbPnlRef();
  throw new Error("handleArbPnl not initialized -- call registerArbAutoCommands first");
}

// ── Orderbook helpers for monitor ──

async function fetchHLOrderbook(symbol: string): Promise<[number, number][]> {
  const { HYPERLIQUID_API_URL } = await import("../shared-api.js");
  const res = await fetch(HYPERLIQUID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: symbol }),
  });
  const json = await res.json();
  const bids = json.levels?.[0] ?? [];
  return bids.slice(0, 10).map((l: Record<string, string>) => [Number(l.px), Number(l.sz)] as [number, number]);
}

async function fetchLighterOrderbook(symbol: string): Promise<[number, number][]> {
  const { LIGHTER_API_URL } = await import("../shared-api.js");
  const detailsRes = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookDetails`);
  const details = await detailsRes.json();
  const m = ((details as Record<string, unknown>).order_book_details as Array<Record<string, unknown>> ?? [])
    .find(d => d.symbol === symbol);
  if (!m) return [];
  const marketId = Number(m.market_id);
  const obRes = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookOrders?market_id=${marketId}&limit=10`);
  const ob = await obRes.json();
  const bids = (ob as Record<string, unknown>).bids as Array<Record<string, string>> ?? [];
  return bids.map(l => [Number(l.price), Number(l.remaining_base_amount)] as [number, number]);
}
