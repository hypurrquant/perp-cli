import { Command } from "commander";
import { isDryRun, networkOf, supportsDryRun } from "../../cli-flags.js";
import chalk from "chalk";
import { makeTable, formatUsd, formatPnl, printJson, jsonOk, logSettledRejections } from "../../utils.js";
import { SPOT_PERP_TOKEN_MAP, type ExchangeAdapter, type ExchangePosition, type SpotBalance } from "../../exchanges/index.js";
import { readExecutionLog, logExecution, type ExecutionRecord } from "../../execution-log.js";
import { toHourlyRate } from "../../funding.js";
import { fetchVenuesRates } from "../../funding/rates.js";
import { sharedApiNetwork } from "../../api/public/urls.js";
import { computeBasisRisk } from "../../arb-utils.js";
import { removePosition as persistRemovePosition, getPositions as getArbStatePositions, loadArbState } from "../../arb-state.js";
import { fetchBalancesWithFailures, computeRebalancePlan } from "../../rebalance.js";
import { EXCHANGE_TO_CHAIN, getBestQuote } from "../../bridge-engine.js";
import { computeEnhancedStats, type ArbTradeForStats } from "../../arb-history-stats.js";
import { listBotSpotVenues, nonQuoteSpotBalances, requireSpotAdapter, spotNetworkOf } from "../../exchanges/spot-factory.js";
import { listConfiguredAccountVenues } from "../../config.js";
import { closePerpPairVerified, handleSpotClose } from "../arb-auto.js";
import { quarantineEntryFor } from "../../bot/quarantine.js";
import { PerpError, classifyError, parsePositiveDecimal } from "../../errors.js";
import { getVenue, listVenuesWithRole, resolveVenueId } from "../../exchanges/venue.js";

// ── Types ──

interface ArbPairPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  /**
   * Where the pairing comes from: the arb state file or an arb entry in the execution log for
   * exactly these legs (not closed since) — or "inferred" (a long and a short that merely share
   * the symbol, e.g. a strategy bot's own position). Inferred pairs are reported apart and never
   * closed without an explicit --pair.
   */
  provenance: ArbPairProvenance;
  longPosition: {
    side: "long";
    size: number;
    entryPrice: number;
    markPrice: number;
    unrealizedPnl: number;
    leverage: number;
    notionalUsd: number;
  };
  shortPosition: {
    side: "short";
    size: number;
    entryPrice: number;
    markPrice: number;
    unrealizedPnl: number;
    leverage: number;
    notionalUsd: number;
  };
  entrySpread: number | null;
  currentSpread: number | null;
  holdDuration: string | null;
  holdDurationMs: number | null;
  estimatedFundingIncome: number;
  estimatedFees: number;
  unrealizedPnl: number;
  netPnl: number;
  dailyFundingEstimate: number;
  breakeven: {
    daysToBreakeven: number | null;
    dailyIncome: number;
    totalCosts: number;
    remainingToBreakeven: number;
  };
}

interface SpotPerpPosition {
  symbol: string;           // perp symbol, e.g. "ETH"
  mode: "spot-perp";
  spotExchange: string;
  perpExchange: string;
  spotToken: string;        // actual spot token, e.g. "UETH" on HL
  /** The arb's own spot size (state entry, capped at the holding); the whole holding when there is no state entry (confirmed false). */
  spotAmount: number;
  /** The venue's spot balance of the token (arb + anything else held). */
  heldSpotAmount: number;
  /** heldSpotAmount − spotAmount: spot held outside this arb. */
  otherSpotAmount: number;
  /** true = the arb state file records this spot-perp position; false = inferred from balances. */
  confirmed: boolean;
  spotValueUsd: number;
  perpSide: "short" | "long";
  perpSize: number;
  perpEntryPrice: number;
  perpMarkPrice: number;
  perpUnrealizedPnl: number;
  perpLeverage: number;
  perpNotionalUsd: number;
  /** null = the perp venue's funding rate is unknown (not published / rates unreadable) */
  direction: "long-spot-short-perp" | "sell-spot-long-perp" | null;
  currentSpread: number | null;
  holdDuration: string | null;
  holdDurationMs: number | null;
  estimatedFundingIncome: number;
  /**
   * "actual" = settled payments read from the venue; "partial" = read, but the history may not
   * reach back to the entry (full page, or Aster's 7-day window — see fundingError); "estimate" =
   * rate × hold time (history unreadable, see fundingError); "recorded" = the bot's persisted
   * accumulatedFunding.
   */
  fundingSource: "actual" | "partial" | "estimate" | "recorded";
  fundingError: string | null;
  estimatedFees: number;
  netPnl: number;
  /** null = funding rate unknown (never 0) */
  dailyFundingEstimate: number | null;
}

interface ArbHistoryTrade {
  symbol: string;
  exchanges: string;
  entryDate: string;
  exitDate: string | null;
  holdDuration: string;
  holdDurationMs: number;
  entrySpread: number | null;
  exitSpread: number | null;
  size: string;
  grossReturn: number;
  fees: number;
  fundingIncome: number;
  netReturn: number;
  status: "completed" | "open" | "failed";
  exitReason: string | null;
}

// ── Helpers ──

import { DEFAULT_TAKER_FEE as TAKER_FEE } from "../../constants.js";

/**
 * Venues an arb leg can sit on: every registered trading venue with a configured
 * credential source (registry order). Never a hard-coded list — a venue added to the
 * registry is covered by `arb status` / `arb close` without touching this file.
 */
export async function listArbVenues(): Promise<string[]> {
  const configured = await listConfiguredAccountVenues(); // registers the venues
  const trading = new Set<string>(listVenuesWithRole("trading").map(v => v.id));
  return configured.filter(v => trading.has(v));
}

/**
 * Positions of every venue in `venues`. A venue whose adapter cannot be built or whose
 * positions read fails is an error (Rule #2): an unread venue is not "no positions" —
 * a hidden leg would make a live pair look closed.
 */
/**
 * Adapters for `arb rebalance`. A venue the user listed explicitly (--exchanges) that cannot
 * be opened is refused with a PerpError naming venue + cause; from the default list it is
 * skipped with a stderr warning naming venue + cause (never silently).
 */
export async function resolveRebalanceAdapters(
  names: readonly string[],
  explicit: boolean,
  getAdapter: (exchange: string) => Promise<ExchangeAdapter>,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Promise<Map<string, ExchangeAdapter>> {
  const out = new Map<string, ExchangeAdapter>();
  for (const name of names) {
    try {
      out.set(name, await getAdapter(name));
    } catch (e) {
      const c = classifyError(e, name);
      if (explicit) {
        throw new PerpError(c.code as ConstructorParameters<typeof PerpError>[0], `Cannot open ${name}: ${c.message}`, {
          exchange: name,
          remediation: `Check ${name} credentials / connectivity (perp account balance -e ${name}), or drop it from --exchanges`,
        });
      }
      warn(`[arb rebalance] ${name} unavailable — skipped: ${c.message}`);
    }
  }
  return out;
}

export async function readArbVenuePositions(
  venues: readonly string[],
  getAdapter: (exchange: string) => Promise<ExchangeAdapter>,
): Promise<{ exchange: string; position: ExchangePosition }[]> {
  const out: { exchange: string; position: ExchangePosition }[] = [];
  for (const exchange of venues) {
    let positions: ExchangePosition[];
    try {
      positions = await (await getAdapter(exchange)).getPositions();
    } catch (e) {
      const c = classifyError(e, exchange);
      throw new PerpError(c.code as ConstructorParameters<typeof PerpError>[0], `Cannot read positions on ${exchange}: ${c.message}`, {
        exchange,
        venuesChecked: [...venues],
        remediation: `Arb pairs are detected from every configured venue's positions, so none may be skipped. Check the venue: perp account positions -e ${exchange}`,
      });
    }
    for (const position of positions) out.push({ exchange, position });
  }
  return out;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return `${days}d ${remainingHours}h`;
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(ms / (1000 * 60));
  return `${minutes}m`;
}

/**
 * Spot-perp funding view from the perp venue's current rate entry. A missing entry → every
 * field null ("unknown"): never a 0 rate / 0 daily income / a guessed direction.
 */
export function spotPerpFundingView(
  perpRate: { exchange: string; rate: number; fundingHours: number | null } | undefined,
  perpNotional: number,
): { hourlyRate: number | null; annualPct: number | null; direction: "long-spot-short-perp" | "sell-spot-long-perp" | null; dailyFundingEstimate: number | null } {
  if (perpRate === undefined) return { hourlyRate: null, annualPct: null, direction: null, dailyFundingEstimate: null };
  const hourlyRate = entryHourly(perpRate);
  return {
    hourlyRate,
    annualPct: hourlyRate * 8760 * 100,
    direction: hourlyRate >= 0 ? "long-spot-short-perp" : "sell-spot-long-perp",
    dailyFundingEstimate: Math.abs(hourlyRate) * perpNotional * 24,
  };
}

/** hourly rate of a rate entry: the entry's own interval (Aster, per symbol) or the venue basis. */
function entryHourly(e: { exchange: string; rate: number; fundingHours: number | null }): number {
  return e.fundingHours !== null ? e.rate / e.fundingHours : toHourlyRate(e.rate, e.exchange);
}

async function fetchFundingRatesMap(): Promise<Map<string, { exchange: string; rate: number; markPrice: number; fundingHours: number | null }[]>> {
  // The SAME rate rows as `arb scan --rates` (fetchVenuesRates): canonical-keyed (unclassified /
  // ambiguous tickers have no row), each with its own basis (fundingHours) and rateKind. A failed
  // venue is reported on stderr (explicit, never silent).
  const venues = ["pacifica", "hyperliquid", "lighter", "aster"].map(id => getVenue(id));
  const { rates, exchangeErrors } = await fetchVenuesRates(venues, sharedApiNetwork(), false);
  for (const [ex, msg] of Object.entries(exchangeErrors)) process.stderr.write(`[arb] ${ex}: funding rates unavailable — ${msg}\n`);
  const rateMap = new Map<string, { exchange: string; rate: number; markPrice: number; fundingHours: number | null }[]>();
  for (const r of rates) {
    if (r.basis.kind !== "perHours") continue; // these four venues quote per hours
    if (!rateMap.has(r.canonical)) rateMap.set(r.canonical, []);
    rateMap.get(r.canonical)!.push({ exchange: r.exchange, rate: r.fundingRate, markPrice: r.markPrice, fundingHours: r.basis.hours });
  }
  return rateMap;
}

/**
 * State-file entries the venues do not confirm: no live pair with the same symbol and
 * legs. `arb status` reports them apart from the live pairs (the venue is the source of truth).
 */
export function staleArbStateEntries(
  persisted: ReadonlyArray<{ id: string; symbol: string; longExchange: string; shortExchange: string; entryTime: string; mode?: "perp-perp" | "spot-perp"; spotExchange?: string }>,
  livePerpPerp: ReadonlyArray<{ symbol: string; longExchange: string; shortExchange: string }>,
  liveSpotPerp: ReadonlyArray<{ symbol: string; spotExchange: string; perpExchange: string }>,
): { id: string; symbol: string; mode: "perp-perp" | "spot-perp"; longExchange: string; shortExchange: string; entryTime: string; reason: string }[] {
  const out: ReturnType<typeof staleArbStateEntries> = [];
  for (const st of persisted) {
    const sym = st.symbol.toUpperCase();
    const live = st.mode === "spot-perp"
      ? liveSpotPerp.some(p => p.symbol === sym && p.perpExchange === st.shortExchange)
      : livePerpPerp.some(p => p.symbol === sym && p.longExchange === st.longExchange && p.shortExchange === st.shortExchange);
    if (live) continue;
    out.push({
      id: st.id, symbol: sym, mode: st.mode === "spot-perp" ? "spot-perp" : "perp-perp",
      longExchange: st.longExchange, shortExchange: st.shortExchange, entryTime: st.entryTime,
      reason: st.mode === "spot-perp"
        ? `no ${sym} perp short on ${st.shortExchange}`
        : `no ${sym} long on ${st.longExchange} with a short on ${st.shortExchange}`,
    });
  }
  return out;
}

export type ArbPairProvenance = "state" | "executionLog" | "inferred";

/** Per-leg engine entries (funding-arb-strategy: one record per leg) within this window form one pair entry. */
const LEG_PAIRING_WINDOW_MS = 10 * 60_000;

/**
 * Whether a live long/short pair was opened by arb: an arb state entry for exactly these legs
 * ("state"), else the latest successful arb_entry for exactly these legs in the execution log —
 * combined (meta.arbPairId / meta.longExchange + shortExchange) or per-leg (meta.leg long on the
 * long venue + leg short on the short venue within 10 min) — with no successful arb_close of the
 * pair after it ("executionLog"). Anything else is "inferred". Never a symbol-only match.
 */
export function arbPairProvenance(
  symbol: string, longExchange: string, shortExchange: string,
  persisted: ReadonlyArray<{ symbol: string; longExchange: string; shortExchange: string; mode?: "perp-perp" | "spot-perp" }>,
  records: ReadonlyArray<ExecutionRecord>,
): ArbPairProvenance {
  const sym = symbol.toUpperCase();
  if (persisted.some(p => p.mode !== "spot-perp" && p.symbol.toUpperCase() === sym && p.longExchange === longExchange && p.shortExchange === shortExchange)) return "state";
  const pairId = `${sym}:${longExchange}:${shortExchange}`;
  const mine = records.filter(r => r.status === "success" && r.symbol.toUpperCase() === sym);
  const combined = (r: ExecutionRecord) => r.meta?.arbPairId === pairId || (r.meta?.longExchange === longExchange && r.meta?.shortExchange === shortExchange);
  const t = (r: ExecutionRecord) => new Date(r.timestamp).getTime();
  let entryAt = -Infinity;
  for (const r of mine.filter(x => x.type === "arb_entry")) {
    if (combined(r)) { entryAt = Math.max(entryAt, t(r)); continue; }
    if (r.meta?.leg === "long" && r.exchange === longExchange) {
      const short = mine.find(x => x.type === "arb_entry" && x.meta?.leg === "short" && x.exchange === shortExchange && Math.abs(t(x) - t(r)) <= LEG_PAIRING_WINDOW_MS);
      if (short !== undefined) entryAt = Math.max(entryAt, t(r), t(short));
    }
  }
  if (entryAt === -Infinity) return "inferred";
  const closedAfter = mine.some(r => r.type === "arb_close" && t(r) > entryAt
    && (combined(r) || (r.meta?.leg === "long" && r.exchange === longExchange) || (r.meta?.leg === "short" && r.exchange === shortExchange)));
  return closedAfter ? "inferred" : "executionLog";
}

function findArbEntryForPair(symbol: string, longExchange?: string, shortExchange?: string): ExecutionRecord | null {
  const entries = readExecutionLog({ type: "arb_entry", symbol });
  const successful = entries.filter(e => e.status === "success");
  if (!successful.length) return null;

  // Try matching by arbPairId first (new format)
  if (longExchange && shortExchange) {
    const pairId = `${symbol.toUpperCase()}:${longExchange}:${shortExchange}`;
    const byPairId = successful.find(e => e.meta?.arbPairId === pairId);
    if (byPairId) return byPairId;

    // Also try matching by exchange field (e.g. "pacifica+hyperliquid")
    const byExchange = successful.find(e =>
      e.meta?.longExchange === longExchange && e.meta?.shortExchange === shortExchange
    );
    if (byExchange) return byExchange;
  }

  // Fallback: return most recent entry for this symbol (legacy records without arbPairId)
  return successful[0];
}

function getCurrentSpreadForSymbol(
  symbol: string,
  longExchange: string,
  shortExchange: string,
  rateMap: Map<string, { exchange: string; rate: number; markPrice: number; fundingHours: number | null }[]>,
): number | null {
  const rates = rateMap.get(symbol.toUpperCase());
  if (!rates) return null;

  const longRate = rates.find(r => r.exchange === longExchange);
  const shortRate = rates.find(r => r.exchange === shortExchange);
  if (!longRate || !shortRate) return null;

  return Math.abs(entryHourly(shortRate) - entryHourly(longRate)) * 24 * 365 * 100;
}

// ── Registration ──

export function registerArbManageCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const arb = program.commands.find(c => c.name() === "arb");
  if (!arb) return;

  // ── arb status ──

  arb
    .command("status")
    .description("Show open arb positions with PnL breakdown + actual funding earned")
    .option("--period <days>", "Funding lookback period in days", "7")
    .option("--symbol <symbol>", "Filter funding data by symbol")
    .action(async (opts: { period: string; symbol?: string }) => {
      if (!isJson()) console.log(chalk.cyan("\n  Checking arb positions across exchanges...\n"));

      // Fetch positions from all exchanges
      const allPositions: { exchange: string; symbol: string; side: "long" | "short"; size: number; entryPrice: number; markPrice: number; unrealizedPnl: number; leverage: number }[] = [];

      const venuesChecked = await listArbVenues();
      for (const { exchange, position: p } of await readArbVenuePositions(venuesChecked, getAdapterForExchange)) {
        allPositions.push({
          exchange,
          symbol: p.symbol.replace("-PERP", "").toUpperCase(),
          side: p.side,
          size: Math.abs(Number(p.size)),
          entryPrice: Number(p.entryPrice),
          markPrice: Number(p.markPrice),
          unrealizedPnl: Number(p.unrealizedPnl),
          leverage: p.leverage,
        });
      }

      // Group by symbol to detect arb pairs
      const bySymbol = new Map<string, typeof allPositions>();
      for (const p of allPositions) {
        if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
        bySymbol.get(p.symbol)!.push(p);
      }

      // Find arb pairs: same symbol, different exchanges, one long + one short
      const arbPairs: ArbPairPosition[] = [];
      const persistedForPairs = getArbStatePositions(networkOf(program));
      const arbRecords = [...readExecutionLog({ type: "arb_entry" }), ...readExecutionLog({ type: "arb_close" })];

      // Fetch current funding rates for spread calculation
      let rateMap: Map<string, { exchange: string; rate: number; markPrice: number; fundingHours: number | null }[]>;
      try {
        rateMap = await fetchFundingRatesMap();
      } catch (e) {
        // Reported, not silent: every spread / funding rate below shows as unknown (null), never 0.
        process.stderr.write(`[warn] funding rates unavailable — spreads and daily funding shown as unknown: ${e instanceof Error ? e.message : String(e)}\n`);
        rateMap = new Map();
      }

      for (const [symbol, positions] of bySymbol) {
        const longs = positions.filter(p => p.side === "long");
        const shorts = positions.filter(p => p.side === "short");

        // Match longs and shorts on different exchanges
        for (const longPos of longs) {
          for (const shortPos of shorts) {
            if (longPos.exchange === shortPos.exchange) continue;

            // Look up entry info from execution log (match by pair)
            const entryLog = findArbEntryForPair(symbol, longPos.exchange, shortPos.exchange);
            const entrySpread = entryLog?.meta?.spread as number | null ?? null;
            const entryTime = entryLog?.timestamp ?? null;
            const holdDurationMs = entryTime ? Date.now() - new Date(entryTime).getTime() : null;
            const holdDuration = holdDurationMs ? formatDuration(holdDurationMs) : null;

            // Current spread
            const currentSpread = getCurrentSpreadForSymbol(symbol, longPos.exchange, shortPos.exchange, rateMap);

            // Position notional values
            const longNotional = longPos.size * longPos.markPrice;
            const shortNotional = shortPos.size * shortPos.markPrice;
            const avgNotional = (longNotional + shortNotional) / 2;

            // Estimated funding income (from hold time and current spread)
            let estimatedFundingIncome = 0;
            if (holdDurationMs && currentSpread) {
              const holdHours = holdDurationMs / (1000 * 60 * 60);
              // Annual spread % → hourly income on notional
              estimatedFundingIncome = (currentSpread / 100) / (24 * 365) * avgNotional * holdHours;
            }

            // Estimated fees (entry + exit)
            const entryFees = (longPos.size * longPos.entryPrice + shortPos.size * shortPos.entryPrice) * TAKER_FEE;
            const exitFees = (longNotional + shortNotional) * TAKER_FEE;
            const totalFees = entryFees + exitFees;

            // Net PnL
            const totalUpnl = longPos.unrealizedPnl + shortPos.unrealizedPnl;
            const netPnl = totalUpnl + estimatedFundingIncome - totalFees;

            // Daily funding estimate from current spread
            const dailyFundingEstimate = currentSpread
              ? (currentSpread / 100) / 365 * avgNotional
              : 0;

            // Breakeven analysis
            const totalCosts = totalFees; // entry+exit fees
            const remainingToBreakeven = totalCosts - estimatedFundingIncome - totalUpnl;
            const daysToBreakeven = dailyFundingEstimate > 0 && remainingToBreakeven > 0
              ? remainingToBreakeven / dailyFundingEstimate
              : remainingToBreakeven <= 0 ? 0 : null;

            arbPairs.push({
              symbol,
              longExchange: longPos.exchange,
              shortExchange: shortPos.exchange,
              provenance: arbPairProvenance(symbol, longPos.exchange, shortPos.exchange, persistedForPairs, arbRecords),
              longPosition: {
                side: "long",
                size: longPos.size,
                entryPrice: longPos.entryPrice,
                markPrice: longPos.markPrice,
                unrealizedPnl: longPos.unrealizedPnl,
                leverage: longPos.leverage,
                notionalUsd: longNotional,
              },
              shortPosition: {
                side: "short",
                size: shortPos.size,
                entryPrice: shortPos.entryPrice,
                markPrice: shortPos.markPrice,
                unrealizedPnl: shortPos.unrealizedPnl,
                leverage: shortPos.leverage,
                notionalUsd: shortNotional,
              },
              entrySpread: entrySpread !== null ? Number(entrySpread) : null,
              currentSpread,
              holdDuration,
              holdDurationMs,
              estimatedFundingIncome,
              estimatedFees: totalFees,
              unrealizedPnl: totalUpnl,
              netPnl,
              dailyFundingEstimate,
              breakeven: {
                daysToBreakeven,
                dailyIncome: dailyFundingEstimate,
                totalCosts,
                remainingToBreakeven: Math.max(0, remainingToBreakeven),
              },
            });
          }
        }
      }

      // ── Spot-Perp position detection ──
      // Fetch spot balances from HL and LT, match with perp shorts
      const spotPerpPositions: SpotPerpPosition[] = [];

      // Build reverse map: spot token → perp symbol (UETH→ETH, UBTC→BTC, PURR-SPOT→PURR, etc.)
      const spotToPerpSymbol = (token: string): string => {
        // Strip "-SPOT" suffix that HL SDK appends to spot token names
        const upper = token.replace(/-SPOT$/i, "").toUpperCase();
        return SPOT_PERP_TOKEN_MAP[upper] ?? upper;
      };

      // Collect spot balances per exchange
      const spotBalancesByExchange = new Map<string, SpotBalance[]>();
      // Bot/arb spot scope: configured venues with a separate spot balance + transfer.
      const configuredVenues = new Set<string>(await listConfiguredAccountVenues());
      for (const def of listBotSpotVenues()) {
        if (!configuredVenues.has(def.id)) continue;
        try {
          const adapter = await getAdapterForExchange(def.id);
          const spot = await requireSpotAdapter(def.id, adapter);
          spotBalancesByExchange.set(def.id, nonQuoteSpotBalances(def, spotNetworkOf(spot), await spot.getSpotBalances()));
        } catch (e) {
          process.stderr.write(`[warn] ${def.displayName} spot balances unavailable: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }

      // Load persisted arb state for spot-perp entries
      const persistedAll = getArbStatePositions(networkOf(program));
      const persistedSpotPerp = persistedAll.filter(p => p.mode === "spot-perp");
      const persistedSymbols = new Set(persistedSpotPerp.map(p => p.symbol.toUpperCase()));

      // Match: spot balance + perp short on same symbol (different or same exchange)
      for (const [spotEx, balances] of spotBalancesByExchange) {
        for (const bal of balances) {
          const perpSymbol = spotToPerpSymbol(bal.token);
          const spotAmount = Number(bal.total);
          if (spotAmount <= 0) continue;

          // Find matching perp short position (on any exchange)
          const matchingShorts = allPositions.filter(
            p => p.symbol === perpSymbol && p.side === "short"
          );

          // Skip dust balances (< $1 at perp mark price)
          const refPrice = matchingShorts[0]?.markPrice ?? 0;
          if (refPrice > 0 && spotAmount * refPrice < 1) continue;

          for (const shortPos of matchingShorts) {
            // Check if this short is already used by a CONFIRMED perp-perp pair
            const usedByPerpPerp = arbPairs.some(
              ap => ap.symbol === perpSymbol && ap.shortExchange === shortPos.exchange && ap.provenance !== "inferred"
            );
            if (usedByPerpPerp) continue;

            // Look up persisted state for hold time and entry info
            const persisted = persistedSpotPerp.find(
              p => p.symbol.toUpperCase() === perpSymbol
                && p.spotExchange === spotEx
                && p.shortExchange === shortPos.exchange
            );

            // The arb's own spot size (the state entry), never the whole holding (pre-existing spot is reported apart).
            const heldSpotAmount = spotAmount;
            const arbSpotAmount = persisted !== undefined ? Math.min(persisted.longSize, heldSpotAmount) : heldSpotAmount;
            const otherSpotAmount = Math.max(0, heldSpotAmount - arbSpotAmount);
            const entryTime = persisted?.entryTime ?? null;
            const holdDurationMs = entryTime ? Date.now() - new Date(entryTime).getTime() : null;
            const holdDuration = holdDurationMs ? formatDuration(holdDurationMs) : null;

            // Get current perp funding rate for this symbol on this exchange
            const rates = rateMap.get(perpSymbol);
            const perpRate = rates?.find(r => r.exchange === shortPos.exchange);
            const perpNotional = shortPos.size * shortPos.markPrice;
            // Unknown rate → hourlyRate / annualPct / direction / dailyFundingEstimate are null (never 0).
            const { hourlyRate, annualPct, direction, dailyFundingEstimate } = spotPerpFundingView(perpRate, perpNotional);

            const spotValueUsd = arbSpotAmount * shortPos.markPrice; // approx using perp mark price

            // Funding income: fetch actual payments from exchange API
            let actualFundingIncome = 0;
            let fundingSource: "actual" | "partial" | "estimate" = "actual";
            let fundingError: string | null = null;
            try {
              const perpAdapter = await getAdapterForExchange(shortPos.exchange);
              const FUNDING_PAGE = 200;
              const payments = await perpAdapter.getFundingPayments(FUNDING_PAGE);
              // Filter from entry time minus 1h buffer (multi-leg entry takes time)
              const entryTime = persisted ? new Date(persisted.entryTime).getTime() - 3600000 : 0;
              for (const p of payments) {
                if (p.symbol.toUpperCase().includes(perpSymbol) && (!entryTime || p.time >= entryTime)) {
                  actualFundingIncome += Number(p.payment);
                }
              }
              // The read may not reach back to the entry: a full page, or Aster's 7-day income window.
              const sevenDaysAgo = Date.now() - 7 * 86_400_000;
              if (payments.length >= FUNDING_PAGE) {
                fundingSource = "partial";
                fundingError = `${FUNDING_PAGE} payments returned (page full) — older funding since entry may be missing`;
              } else if (shortPos.exchange === "aster" && (!entryTime || entryTime < sevenDaysAgo)) {
                fundingSource = "partial";
                fundingError = "Aster funding history covers the last 7 days only — funding before that is not included";
              }
            } catch (e) {
              // History unreadable: an explicit, labelled estimate (fundingSource / fundingError), never a silent one.
              fundingSource = "estimate";
              fundingError = e instanceof Error ? e.message : String(e);
              if (holdDurationMs && hourlyRate !== null && hourlyRate !== 0) {
                const holdHours = holdDurationMs / (1000 * 60 * 60);
                actualFundingIncome = Math.abs(hourlyRate) * perpNotional * holdHours;
                if (hourlyRate < 0) actualFundingIncome = -actualFundingIncome;
              }
            }
            const estimatedFundingIncome = actualFundingIncome;

            // Fees: entry only (exit not yet paid)
            const { getTakerFee } = await import("../../constants.js");
            const spotFee = getTakerFee(spotEx);
            const perpFee = getTakerFee(shortPos.exchange);
            const entryFees = (spotValueUsd * spotFee) + (perpNotional * perpFee);

            spotPerpPositions.push({
              symbol: perpSymbol,
              mode: "spot-perp",
              spotExchange: spotEx,
              perpExchange: shortPos.exchange,
              spotToken: bal.token.replace(/-SPOT$/i, ""),
              spotAmount: arbSpotAmount,
              heldSpotAmount,
              otherSpotAmount,
              confirmed: persisted !== undefined,
              spotValueUsd,
              perpSide: "short",
              perpSize: shortPos.size,
              perpEntryPrice: shortPos.entryPrice,
              perpMarkPrice: shortPos.markPrice,
              perpUnrealizedPnl: shortPos.unrealizedPnl,
              perpLeverage: shortPos.leverage,
              perpNotionalUsd: perpNotional,
              direction,
              currentSpread: annualPct,
              holdDuration,
              holdDurationMs,
              estimatedFundingIncome,
              fundingSource,
              fundingError,
              estimatedFees: entryFees,
              netPnl: (spotValueUsd - shortPos.entryPrice * arbSpotAmount) + shortPos.unrealizedPnl + estimatedFundingIncome - entryFees,
              dailyFundingEstimate,
            });
          }
        }
      }

      // Also detect persisted spot-perp entries without matching spot balance (already exited spot)
      for (const persisted of persistedSpotPerp) {
        const sym = persisted.symbol.toUpperCase();
        const alreadyMatched = spotPerpPositions.some(
          sp => sp.symbol === sym && sp.spotExchange === persisted.spotExchange
        );
        if (alreadyMatched) continue;

        // Check if there's still a perp short for this
        const shortPos = allPositions.find(
          p => p.symbol === sym && p.side === "short" && p.exchange === persisted.shortExchange
        );
        if (!shortPos) continue; // both legs closed, skip

        const holdDurationMs = Date.now() - new Date(persisted.entryTime).getTime();
        const rates = rateMap.get(sym);
        const perpRate = rates?.find(r => r.exchange === persisted.shortExchange);
        const perpNotional = shortPos.size * shortPos.markPrice;
        const fv = spotPerpFundingView(perpRate, perpNotional);

        spotPerpPositions.push({
          symbol: sym,
          mode: "spot-perp",
          spotExchange: persisted.spotExchange ?? "unknown",
          perpExchange: persisted.shortExchange,
          spotToken: "?",
          spotAmount: 0,
          heldSpotAmount: 0,
          otherSpotAmount: 0,
          confirmed: true,
          spotValueUsd: 0,
          perpSide: "short",
          perpSize: shortPos.size,
          perpEntryPrice: shortPos.entryPrice,
          perpMarkPrice: shortPos.markPrice,
          perpUnrealizedPnl: shortPos.unrealizedPnl,
          perpLeverage: shortPos.leverage,
          perpNotionalUsd: perpNotional,
          direction: fv.direction,
          currentSpread: fv.annualPct === null ? null : Math.abs(fv.annualPct),
          holdDuration: formatDuration(holdDurationMs),
          holdDurationMs,
          estimatedFundingIncome: persisted.accumulatedFunding ?? 0,
          fundingSource: "recorded",
          fundingError: null,
          estimatedFees: 0,
          netPnl: shortPos.unrealizedPnl + (persisted.accumulatedFunding ?? 0),
          dailyFundingEstimate: fv.dailyFundingEstimate,
        });
      }

      // State vs venue: the venue is the source of truth. A pair is reported only when the
      // venues show its legs; the state file contributes entry time / funding to a pair that
      // is live. State entries with no live counterpart are listed apart, never as positions.
      const staleStateEntries = staleArbStateEntries(persistedAll, arbPairs, spotPerpPositions);
      // Pairs only inferred from a long and a short sharing the symbol are reported apart (never as arb positions).
      const unconfirmedPairs = arbPairs.filter(p => p.provenance === "inferred");
      arbPairs.splice(0, arbPairs.length, ...arbPairs.filter(p => p.provenance !== "inferred"));

      const fundingUnknownSP = spotPerpPositions.filter(p => p.dailyFundingEstimate === null).map(p => `${p.perpExchange}:${p.symbol}`);

      // ── JSON output ──
      if (isJson()) {
        const totalNotionalPP = arbPairs.reduce((s, p) => s + (p.longPosition.notionalUsd + p.shortPosition.notionalUsd) / 2, 0);
        const totalDailyPP = arbPairs.reduce((s, p) => s + p.dailyFundingEstimate, 0);
        const totalNotionalSP = spotPerpPositions.reduce((s, p) => s + p.perpNotionalUsd, 0);
        const totalDailySP = spotPerpPositions.reduce((s, p) => s + (p.dailyFundingEstimate ?? 0), 0);
        const totalNotionalJ = totalNotionalPP + totalNotionalSP;
        const totalDailyJ = totalDailyPP + totalDailySP;
        return printJson(jsonOk({
          perpPerpPairs: arbPairs,
          spotPerpPairs: spotPerpPositions,
          venuesChecked,
          staleStateEntries,
          unconfirmedPairs,
          aggregate: {
            perpPerpCount: arbPairs.length,
            spotPerpCount: spotPerpPositions.length,
            totalPositions: arbPairs.length + spotPerpPositions.length,
            totalNotionalUsd: totalNotionalJ,
            unrealizedPnl: arbPairs.reduce((s, p) => s + p.unrealizedPnl, 0) + spotPerpPositions.reduce((s, p) => s + p.perpUnrealizedPnl, 0),
            estimatedFunding: arbPairs.reduce((s, p) => s + p.estimatedFundingIncome, 0) + spotPerpPositions.reduce((s, p) => s + p.estimatedFundingIncome, 0),
            estimatedFees: arbPairs.reduce((s, p) => s + p.estimatedFees, 0) + spotPerpPositions.reduce((s, p) => s + p.estimatedFees, 0),
            netPnl: arbPairs.reduce((s, p) => s + p.netPnl, 0) + spotPerpPositions.reduce((s, p) => s + p.netPnl, 0),
            dailyFundingEstimate: totalDailyJ,
            annualizedApr: totalNotionalJ > 0 ? (totalDailyJ * 365 / totalNotionalJ) * 100 : 0,
            // Spot-perp positions whose funding rate is unknown are excluded from the daily / APR sums.
            dailyFundingIncomplete: fundingUnknownSP.length > 0,
            fundingUnknown: fundingUnknownSP,
          },
        }));
      }

      for (const st of staleStateEntries) {
        console.log(chalk.yellow(`  Stale state entry (not on the venue, not counted): ${st.symbol} ${st.mode} ${st.longExchange}/${st.shortExchange} since ${st.entryTime} — drop it: perp arb close ${st.symbol} --state-only`));
      }
      for (const u of unconfirmedPairs) {
        console.log(chalk.gray(`  Unconfirmed (inferred, not counted): ${u.symbol} long ${u.longExchange} ${u.longPosition.size} / short ${u.shortExchange} ${u.shortPosition.size} — no arb state / entry record for these legs; close only knowingly: perp arb close ${u.symbol} --pair ${u.longExchange}:${u.shortExchange}`));
      }
      if (arbPairs.length === 0 && spotPerpPositions.length === 0) {
        console.log(chalk.gray(`  No open arb positions found on ${venuesChecked.join(", ")}.\n`));
        return;
      }

      // ── Perp-Perp table ──
      if (arbPairs.length > 0) {
        console.log(chalk.cyan.bold("  Perp-Perp Arb Positions\n"));

        const rows = arbPairs.map(p => {
          const spreadStr = p.currentSpread !== null ? `${p.currentSpread.toFixed(1)}%` : "-";
          const entrySpreadStr = p.entrySpread !== null ? `${p.entrySpread.toFixed(1)}%` : "-";
          const holdStr = p.holdDuration ?? "-";
          const avgNotional = (p.longPosition.notionalUsd + p.shortPosition.notionalUsd) / 2;

          const basis = computeBasisRisk(p.longPosition.markPrice, p.shortPosition.markPrice);
          const basisStr = basis.divergencePct > 0
            ? (basis.warning
              ? chalk.red(`${basis.divergencePct.toFixed(1)}%`)
              : chalk.gray(`${basis.divergencePct.toFixed(1)}%`))
            : chalk.gray("-");

          return [
            chalk.white.bold(p.symbol),
            chalk.green(p.longExchange),
            chalk.red(p.shortExchange),
            `$${formatUsd(avgNotional)}`,
            `$${p.longPosition.entryPrice.toFixed(2)} / $${p.shortPosition.entryPrice.toFixed(2)}`,
            `$${p.longPosition.markPrice.toFixed(2)}`,
            formatPnl(p.unrealizedPnl),
            chalk.yellow(`$${p.estimatedFundingIncome.toFixed(4)}`),
            `${entrySpreadStr} -> ${spreadStr}`,
            basisStr,
            holdStr,
            formatPnl(p.netPnl),
          ];
        });

        console.log(makeTable(
          ["Symbol", "Long", "Short", "Size", "Entry", "Mark", "uPnL", "Funding", "Spread", "Basis", "Hold", "Net PnL"],
          rows,
        ));
      }

      // ── Spot-Perp detailed view ──
      if (spotPerpPositions.length > 0) {
        for (const sp of spotPerpPositions) {
          const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e === "aster" ? "AST" : e.toUpperCase();
          const spreadStr = sp.currentSpread !== null ? `${sp.currentSpread.toFixed(1)}%` : "-";
          const spotPriceEach = sp.spotAmount > 0 ? sp.spotValueUsd / sp.spotAmount : 0;
          const spotPnl = sp.spotValueUsd - (sp.perpEntryPrice * sp.spotAmount); // spot value vs entry
          const roi = sp.perpNotionalUsd > 0 ? (sp.netPnl / sp.perpNotionalUsd) * 100 : 0;
          const dailyRoi = sp.holdDurationMs && sp.holdDurationMs > 0 ? roi / (sp.holdDurationMs / 86400000) : 0;
          const annRoi = dailyRoi * 365;

          console.log(chalk.cyan.bold(`\n  ${sp.symbol} spot-perp`) + chalk.gray(` (${exAbbr(sp.spotExchange)} ↔ ${exAbbr(sp.perpExchange)})`) + chalk.gray(`  ${sp.holdDuration ?? "-"}`));
          console.log("");

          // Leg details
          const legRows = [
            [
              chalk.green("Spot"),
              `${sp.spotAmount.toFixed(4)} ${sp.spotToken}${sp.otherSpotAmount > 0 ? chalk.gray(` (+${sp.otherSpotAmount.toFixed(4)} other)`) : ""}${sp.confirmed ? "" : chalk.yellow(" (unconfirmed)")}`,
              `$${sp.perpEntryPrice.toFixed(4)}`,
              `$${spotPriceEach.toFixed(4)}`,
              formatPnl(spotPnl),
            ],
            [
              chalk.red("Perp"),
              `${sp.perpSize.toFixed(4)} ${sp.symbol}`,
              `$${sp.perpEntryPrice.toFixed(4)}`,
              `$${sp.perpMarkPrice.toFixed(4)}`,
              formatPnl(sp.perpUnrealizedPnl),
            ],
          ];
          console.log(makeTable(["Leg", "Qty", "Entry", "Current", "PnL"], legRows));

          // Summary
          console.log(chalk.white.bold("  PnL Breakdown:"));
          console.log(`    Spot PnL:        ${formatPnl(spotPnl)}`);
          console.log(`    Perp PnL:        ${formatPnl(sp.perpUnrealizedPnl)}`);
          console.log(`    Funding Earned:  ${chalk.yellow(`$${sp.estimatedFundingIncome.toFixed(4)}`)}${sp.fundingSource === "estimate" ? chalk.yellow(` (estimate — funding history unavailable: ${sp.fundingError})`) : sp.fundingSource === "partial" ? chalk.yellow(` (partial: ${sp.fundingError})`) : ""}`);
          console.log(`    Trading Fees:    ${chalk.red(`-$${sp.estimatedFees.toFixed(4)}`)}`);
          console.log(`    ${chalk.white.bold("Total PnL:")}       ${formatPnl(sp.netPnl)}${roi !== 0 ? chalk.gray(` (ROI: ${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%)`) : ""}`);
          console.log("");
          console.log(`    Current Spread:  ${spreadStr}`);
          console.log(`    Daily Income:    ${sp.dailyFundingEstimate === null ? chalk.yellow(`unknown (no current ${sp.perpExchange} funding rate)`) : chalk.cyan(`$${sp.dailyFundingEstimate.toFixed(4)}/day`)}`);
          if (annRoi !== 0) console.log(`    Annualized ROI:  ${chalk.cyan(`${annRoi >= 0 ? "+" : ""}${annRoi.toFixed(1)}%`)}`);
        }
        console.log("");
      }

      // ── Combined Summary ──
      const totalUpnl = arbPairs.reduce((s, p) => s + p.unrealizedPnl, 0)
        + spotPerpPositions.reduce((s, p) => s + p.perpUnrealizedPnl, 0);
      const totalFunding = arbPairs.reduce((s, p) => s + p.estimatedFundingIncome, 0)
        + spotPerpPositions.reduce((s, p) => s + p.estimatedFundingIncome, 0);
      const totalFees = arbPairs.reduce((s, p) => s + p.estimatedFees, 0)
        + spotPerpPositions.reduce((s, p) => s + p.estimatedFees, 0);
      const totalNet = arbPairs.reduce((s, p) => s + p.netPnl, 0)
        + spotPerpPositions.reduce((s, p) => s + p.netPnl, 0);
      const totalDailyFunding = arbPairs.reduce((s, p) => s + p.dailyFundingEstimate, 0)
        + spotPerpPositions.reduce((s, p) => s + (p.dailyFundingEstimate ?? 0), 0);
      const totalNotional = arbPairs.reduce((s, p) => s + (p.longPosition.notionalUsd + p.shortPosition.notionalUsd) / 2, 0)
        + spotPerpPositions.reduce((s, p) => s + p.perpNotionalUsd, 0);
      const portfolioApr = totalNotional > 0 ? (totalDailyFunding * 365 / totalNotional) * 100 : 0;

      console.log(chalk.white.bold("\n  Summary"));
      console.log(`    Perp-Perp:       ${arbPairs.length} positions`);
      console.log(`    Spot-Perp:       ${spotPerpPositions.length} positions`);
      console.log(`    Total Notional:  $${formatUsd(totalNotional)}`);
      console.log(`    Unrealized PnL:  ${formatPnl(totalUpnl)}`);
      console.log(`    Est. Funding:    ${chalk.yellow(`$${totalFunding.toFixed(4)}`)}`);
      console.log(`    Est. Fees:       ${chalk.red(`-$${totalFees.toFixed(4)}`)}`);
      console.log(`    Net PnL:         ${formatPnl(totalNet)}`);
      console.log(`    Daily Income:    ${chalk.cyan(`$${totalDailyFunding.toFixed(4)}/day`)}${fundingUnknownSP.length > 0 ? chalk.yellow(` (incomplete — funding rate unknown: ${fundingUnknownSP.join(", ")})`) : ""}`);
      if (portfolioApr > 0) {
        console.log(`    Portfolio APR:   ${chalk.cyan(`${portfolioApr.toFixed(1)}%`)}`);
      }
      console.log(chalk.gray(`    (Fees assume ${(TAKER_FEE * 100).toFixed(3)}% taker for entry + exit.)\n`));

      // Always show actual funding payments earned
      await printFundingEarned(getAdapterForExchange, isJson, { period: opts.period, symbol: opts.symbol });
    });

  /**
   * `arb close <sym> --state-only`: delete the arb state entry of `sym` ONLY when the venues show
   * no live position for it (the same reconciliation as `arb status` staleStateEntries). Without
   * --yes (or with --dry-run) the entry is only shown. Nothing is sent to any venue.
   */
  async function dropStaleStateEntry(sym: string, yes: boolean, dryRun: boolean): Promise<void> {
    const net = networkOf(program);
    const entries = getArbStatePositions(net).filter(p => p.symbol.toUpperCase() === sym);
    if (entries.length === 0) {
      throw new PerpError("POSITION_NOT_FOUND", `No arb state entry for ${sym} on ${net}`, { remediation: "See the state entries: perp arb status" });
    }
    const venuesChecked = await listArbVenues();
    const live = (await readArbVenuePositions(venuesChecked, getAdapterForExchange))
      .filter(x => x.position.symbol.replace("-PERP", "").toUpperCase() === sym)
      .map(x => ({ exchange: x.exchange, side: x.position.side }));
    const livePerp = live.filter(l => l.side === "long").flatMap(l => live.filter(s => s.side === "short" && s.exchange !== l.exchange).map(s => ({ symbol: sym, longExchange: l.exchange, shortExchange: s.exchange })));
    const liveSpot = live.filter(l => l.side === "short").map(s => ({ symbol: sym, spotExchange: "", perpExchange: s.exchange }));
    const stale = staleArbStateEntries(entries, livePerp, liveSpot);
    if (stale.length !== entries.length) {
      throw new PerpError("INVALID_PARAMS", `The ${sym} arb state entry is not stale: the venues still show its legs — close it instead: perp arb close ${sym}`, {
        live, remediation: `Close the position: perp arb close ${sym}`,
      });
    }
    if (!yes || dryRun) {
      if (isJson()) return printJson(jsonOk({ symbol: sym, staleStateEntries: stale, deleted: false, remediation: `Confirm: perp arb close ${sym} --state-only --yes` }));
      for (const st of stale) console.log(chalk.yellow(`  Stale ${st.mode} ${st.symbol} ${st.longExchange}/${st.shortExchange} since ${st.entryTime} (${st.reason})`));
      console.log(chalk.gray(`  Nothing deleted. Confirm: perp arb close ${sym} --state-only --yes\n`));
      return;
    }
    persistRemovePosition(net, sym);
    if (isJson()) return printJson(jsonOk({ symbol: sym, staleStateEntries: stale, deleted: true }));
    console.log(chalk.green(`  Dropped the stale ${sym} arb state entry (${net}). No order was sent.\n`));
  }

  // ── arb close ──

  supportsDryRun(arb.command("close <symbol>"))
    .description("Manually close an arb position on both exchanges (supports --dry-run)")
    .option("--pair <pair>", "Specify arb pair as longExchange:shortExchange (e.g. pacifica:hyperliquid)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick (reduces slippage)")
    .option("--spot-exch <exchange>", "Override spot exchange for spot-perp close (a bot spot venue: hl, lt, lrh, aster, ondo)")
    .option("--perp-exch <exchange>", "Override perp exchange for spot-perp close. With both --spot-exch and --perp-exch the close needs no arb-state entry: it sells the spot and buys back the live perp short of <symbol> on those venues")
    .option("--force", "Act on a quarantined symbol (after checking its positions by hand)")
    .option("--state-only", "Drop a STALE arb state entry of <symbol> (one `arb status` lists under staleStateEntries: no live position on the venues) — sends no order; refused while the venues still show it")
    .option("--yes", "With --state-only: confirm the deletion (without it, the entry is only shown)")
    .action(async (symbol: string, opts: { pair?: string; smart?: boolean; spotExch?: string; perpExch?: string; force?: boolean; stateOnly?: boolean; yes?: boolean }, cmd: Command) => {
      const sym = symbol.toUpperCase();
      const dryRun = isDryRun(cmd);

      if (opts.stateOnly) {
        await dropStaleStateEntry(sym, opts.yes === true, dryRun);
        return;
      }

      // Global quarantine: an unknown / unhedged outcome was recorded for
      // this symbol. A human may still close it, but only knowingly (--force).
      const quarantined = quarantineEntryFor(sym, (m) => console.error(chalk.red(m)));
      if (quarantined !== null) {
        if (!opts.force && !dryRun) {
          throw new PerpError("RISK_VIOLATION", `${sym} is quarantined (${quarantined.strategy}: ${quarantined.reason})`, {
            remediation: `${quarantined.remediation}. To close it anyway after checking the positions: perp arb close ${sym} --force`,
          });
        }
        if (!isJson()) console.error(chalk.yellow(`  WARNING: ${sym} is quarantined (${quarantined.strategy}: ${quarantined.reason})${opts.force ? " — proceeding (--force)" : ""}. The quarantine is NOT cleared by this close: perp strategy quarantine-clear ${sym}`));
      }

      // Check if this is a spot-perp position (auto-detect from arb state)
      const arbState = loadArbState(networkOf(program));
      const statePos = arbState?.positions?.find(p => p.symbol.toUpperCase() === sym && p.mode === "spot-perp");
      // Explicit --spot-exch + --perp-exch select the spot-perp close without a state entry
      // (e.g. a pair opened by a strategy bot); the handler sizes it from live positions.
      if ((opts.spotExch === undefined) !== (opts.perpExch === undefined)) {
        throw new PerpError("INVALID_PARAMS", "--spot-exch and --perp-exch must be given together", {
          remediation: `perp arb close ${sym} --spot-exch <spot venue> --perp-exch <perp venue>`,
        });
      }
      const explicitSpotPerp = opts.spotExch !== undefined && opts.perpExch !== undefined;
      if (statePos || explicitSpotPerp) {
        // ── Inline spot-perp close logic ──
        // Venue ids through the registry (every alias, e.g. lrh / ast); a stored spot venue may carry "-spot".
        const venueIdOf = (v: string): string => resolveVenueId(v.replace(/-spot$/i, ""));
        const spotRaw = opts.spotExch ?? statePos?.spotExchange ?? statePos?.longExchange;
        const perpRaw = opts.perpExch ?? statePos?.shortExchange;
        const spotExch = spotRaw === undefined ? undefined : venueIdOf(spotRaw);
        const perpExch = perpRaw === undefined ? undefined : venueIdOf(perpRaw);

        if (!spotExch || !perpExch) {
          throw new PerpError("INVALID_PARAMS", "Cannot determine the spot and perp exchanges of this spot-perp position", {
            remediation: `Pass both: perp arb close ${sym} --spot-exch <spot venue> --perp-exch <perp venue>`,
          });
        }

        if (dryRun) {
          // Dry-run: nothing is sold, bought or transferred.
          const plan = { status: "simulated", dryRun: true, sent: false, mode: "spot-perp", symbol: sym, spotExchange: spotExch, perpExchange: perpExch, longSize: statePos ? statePos.longSize : null, shortSize: statePos ? statePos.shortSize : null };
          if (isJson()) return printJson(jsonOk(plan));
          console.log(chalk.cyan(`  [DRY-RUN] Would close spot-perp ${sym}: sell spot on ${spotExch} + buy back the perp short on ${perpExch}`));
          return;
        }
        // One implementation for spot-perp close (fill-checked legs): arb-auto's handler.
        if (handleSpotClose === undefined) throw new Error("spot-perp close handler is not registered (registerArbAutoCommands not called)");
        await handleSpotClose(sym, { spotExch, perpExch }, getAdapterForExchange, isJson);
        return;
      }

      // ── Perp-perp close logic (original) ──

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Closing arb position for ${sym}...\n`));
        if (dryRun) console.log(chalk.yellow("  Mode: DRY RUN (no trades will be executed)\n"));
      }

      // Find positions for this symbol across all exchanges
      const allPositions: { exchange: string; symbol: string; rawSymbol: string; side: "long" | "short"; size: number; sizeRaw: string; entryPrice: number; markPrice: number; unrealizedPnl: number }[] = [];

      const venuesChecked = await listArbVenues();
      for (const { exchange, position: p } of await readArbVenuePositions(venuesChecked, getAdapterForExchange)) {
        const normalized = p.symbol.replace("-PERP", "").toUpperCase();
        if (normalized !== sym) continue;
        allPositions.push({
          exchange,
          symbol: normalized,
          rawSymbol: p.symbol,
          side: p.side,
          size: Math.abs(Number(p.size)),
          sizeRaw: String(p.size).trim().replace(/^[-+]/, ""), // venue's own size string, used verbatim for the close
          entryPrice: Number(p.entryPrice),
          markPrice: Number(p.markPrice),
          unrealizedPnl: Number(p.unrealizedPnl),
        });
      }

      // Find all possible arb pairs (long on one exchange, short on another), each with its provenance:
      // only pairs opened by arb (state / entry record) are closed without --pair.
      const possiblePairs: { long: typeof allPositions[0]; short: typeof allPositions[0]; provenance: ArbPairProvenance }[] = [];
      const longs = allPositions.filter(p => p.side === "long");
      const shorts = allPositions.filter(p => p.side === "short");
      const persistedForClose = getArbStatePositions(networkOf(program));
      const closeRecords = [...readExecutionLog({ type: "arb_entry", symbol: sym }), ...readExecutionLog({ type: "arb_close", symbol: sym })];
      for (const l of longs) {
        for (const s of shorts) {
          if (l.exchange !== s.exchange) possiblePairs.push({ long: l, short: s, provenance: arbPairProvenance(sym, l.exchange, s.exchange, persistedForClose, closeRecords) });
        }
      }
      const confirmedPairs = possiblePairs.filter(p => p.provenance !== "inferred");

      // If --pair specified, filter to that specific pair
      let longPos: typeof allPositions[0] | undefined;
      let shortPos: typeof allPositions[0] | undefined;

      if (opts.pair) {
        const parts = opts.pair.split(":");
        if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
          throw new PerpError("INVALID_PARAMS", `--pair must be longExchange:shortExchange, got "${opts.pair}"`, { remediation: `Example: perp arb close ${sym} --pair aster:arcus` });
        }
        const longEx: string = resolveVenueId(parts[0]);
        const shortEx: string = resolveVenueId(parts[1]);
        const match = possiblePairs.find(p => p.long.exchange === longEx && p.short.exchange === shortEx);
        if (match) {
          longPos = match.long;
          shortPos = match.short;
        }
      } else if (confirmedPairs.length === 1) {
        longPos = confirmedPairs[0].long;
        shortPos = confirmedPairs[0].short;
      } else if (confirmedPairs.length > 1 || possiblePairs.length > 0) {
        // Several arb pairs, or only pairs inferred from unrelated positions: never guessed — --pair required.
        const onlyInferred = confirmedPairs.length === 0;
        throw new PerpError("INVALID_PARAMS", onlyInferred
          ? `No ${sym} pair opened by arb (no arb state / entry record for these legs); ${possiblePairs.length} unconfirmed long/short combination(s) found. Use --pair to close one knowingly.`
          : `Multiple arb pairs found for ${sym}. Use --pair to specify which one to close.`, {
          pairs: possiblePairs.map(p => ({
            arbPairId: `${sym}:${p.long.exchange}:${p.short.exchange}`,
            longExchange: p.long.exchange,
            shortExchange: p.short.exchange,
            longSize: p.long.size,
            shortSize: p.short.size,
            provenance: p.provenance,
          })),
          remediation: `Pick one: ${(onlyInferred ? possiblePairs : confirmedPairs).map(p => `--pair ${p.long.exchange}:${p.short.exchange}`).join(" | ")}`,
        });
      }

      if (!longPos || !shortPos) {
        const found = allPositions.map(p => `${p.side} ${p.sizeRaw} on ${p.exchange}`).join(", ");
        throw new PerpError("POSITION_NOT_FOUND", `No arb pair found for ${sym}${opts.pair ? ` on ${opts.pair}` : ""}. Need long and short on different exchanges.`, {
          symbol: sym,
          venuesChecked,
          positions: allPositions.map(p => ({ exchange: p.exchange, side: p.side, size: p.sizeRaw })),
          remediation: allPositions.length > 0
            ? `${sym} positions found: ${found}. Close a single leg with: perp trade close ${sym} -e <exchange>`
            : `No ${sym} position on ${venuesChecked.join(", ")}. See the live pairs: perp arb status`,
        });
      }

      // Calculate estimated PnL
      const totalUpnl = longPos.unrealizedPnl + shortPos.unrealizedPnl;
      const entryFees = (longPos.size * longPos.entryPrice + shortPos.size * shortPos.entryPrice) * TAKER_FEE;
      const exitFees = (longPos.size * longPos.markPrice + shortPos.size * shortPos.markPrice) * TAKER_FEE;
      const totalFees = entryFees + exitFees;
      const netPnl = totalUpnl - totalFees;

      if (!isJson()) {
        console.log(chalk.white.bold(`  ${sym} Arb Position`));
        console.log(`    Long:  ${longPos.exchange} | size: ${longPos.size} | entry: $${longPos.entryPrice.toFixed(4)} | mark: $${longPos.markPrice.toFixed(4)} | uPnL: ${formatPnl(longPos.unrealizedPnl)}`);
        console.log(`    Short: ${shortPos.exchange} | size: ${shortPos.size} | entry: $${shortPos.entryPrice.toFixed(4)} | mark: $${shortPos.markPrice.toFixed(4)} | uPnL: ${formatPnl(shortPos.unrealizedPnl)}`);
        console.log();
        console.log(`    Total uPnL:  ${formatPnl(totalUpnl)}`);
        console.log(`    Est. Fees:   ${chalk.red(`-$${totalFees.toFixed(4)}`)}`);
        console.log(`    Net PnL:     ${formatPnl(netPnl)}`);
        console.log();
      }

      if (dryRun) {
        const result = {
          dryRun: true,
          sent: false,
          symbol: sym,
          longExchange: longPos.exchange,
          shortExchange: shortPos.exchange,
          longSize: longPos.size,
          shortSize: shortPos.size,
          unrealizedPnl: totalUpnl,
          estimatedFees: totalFees,
          netPnl,
          actions: [
            { exchange: longPos.exchange, action: "sell", symbol: longPos.rawSymbol, size: String(longPos.size) },
            { exchange: shortPos.exchange, action: "buy", symbol: shortPos.rawSymbol, size: String(shortPos.size) },
          ],
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.yellow("  Would execute:"));
        console.log(chalk.yellow(`    SELL ${longPos.size} ${longPos.rawSymbol} on ${longPos.exchange} (close long)`));
        console.log(chalk.yellow(`    BUY ${shortPos.size} ${shortPos.rawSymbol} on ${shortPos.exchange} (close short)\n`));
        return;
      }

      // Close the legs sequentially (long, then short), reduce-only and verified, each
      // sized from the venue's own position size. No retries: a definite failure of the
      // long close changes nothing; an unknown outcome or a leg left open after the
      // other closed quarantines the symbol.
      const results: { exchange: string; action: string; status: string; error?: string }[] = [];
      const closeRes = await closePerpPairVerified({
        source: "arb-close", sym,
        longAdapter: await getAdapterForExchange(longPos.exchange), longExch: longPos.exchange, longSym: longPos.rawSymbol, longSize: longPos.sizeRaw,
        shortAdapter: await getAdapterForExchange(shortPos.exchange), shortExch: shortPos.exchange, shortSym: shortPos.rawSymbol, shortSize: shortPos.sizeRaw,
        smart: !!opts.smart,
        log: (m) => console.error(chalk.red(m)),
      });
      if (closeRes.status === "closed") {
        results.push({ exchange: longPos.exchange, action: "sell (close long)", status: "success" });
        results.push({ exchange: shortPos.exchange, action: "buy (close short)", status: "success" });
        if (!isJson()) {
          console.log(chalk.green(`  Closed long on ${longPos.exchange}: SELL ${longPos.sizeRaw} ${sym} (reduce-only, verified${opts.smart ? ", smart" : ""})`));
          console.log(chalk.green(`  Closed short on ${shortPos.exchange}: BUY ${shortPos.sizeRaw} ${sym} (reduce-only, verified${opts.smart ? ", smart" : ""})`));
        }
      } else {
        results.push({ exchange: `${longPos.exchange}+${shortPos.exchange}`, action: "close", status: closeRes.status, error: closeRes.reason });
        if (!isJson()) console.error(chalk.red(`  ${closeRes.status === "quarantined" ? "QUARANTINED" : "Close failed (nothing changed, both legs open)"}: ${closeRes.reason}`));
      }
      const allSuccess = closeRes.status === "closed";

      // Remove from persisted daemon state (so daemon doesn't try to re-close)
      if (allSuccess) {
        // No catch (Rule #2): an absent state file is a no-op; a wrong-network/unreadable one must surface.
        persistRemovePosition(networkOf(program), sym);
      }

      // Log to execution log
      const arbPairId = `${sym}:${longPos.exchange}:${shortPos.exchange}`;
      logExecution({
        type: "arb_close",
        exchange: `${longPos.exchange}+${shortPos.exchange}`,
        symbol: sym,
        side: "close",
        size: String(Math.max(longPos.size, shortPos.size)),
        status: allSuccess ? "success" : "failed",
        dryRun: false,
        error: allSuccess ? undefined : results.filter(r => r.error).map(r => `${r.exchange}: ${r.error}`).join("; "),
        meta: {
          arbPairId,
          longExchange: longPos.exchange,
          shortExchange: shortPos.exchange,
          unrealizedPnl: totalUpnl,
          estimatedFees: totalFees,
          netPnl,
          results,
          exitReason: "manual",
        },
      });

      if (isJson()) {
        return printJson(jsonOk({
          symbol: sym,
          longExchange: longPos.exchange,
          shortExchange: shortPos.exchange,
          status: allSuccess ? "success" : closeRes.status,
          unrealizedPnl: totalUpnl,
          estimatedFees: totalFees,
          netPnl,
          results,
        }));
      }

      if (closeRes.status === "quarantined") {
        console.log(chalk.red.bold(`\n  ${sym} quarantined — a leg may still be open. Check both venues by hand.\n`));
      } else if (allSuccess) {
        console.log(chalk.green(`\n  Arb position ${sym} closed successfully.\n`));
      } else {
        console.log(chalk.red(`\n  Failed to close arb position ${sym}. Both legs are still open (hedged).\n`));
      }
    });

  // ── arb history ──

  arb
    .command("history")
    .alias("log")
    .description("Past arb trade performance and statistics")
    .option("--period <days>", "Number of days to look back", "30")
    .action(async (opts: { period: string }) => {
      const periodDays = parseInt(opts.period);
      const sinceDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

      if (!isJson()) console.log(chalk.cyan(`\n  Arb trade history (last ${periodDays} days)\n`));

      // Read arb-related execution log entries
      const arbEntries = readExecutionLog({ since: sinceDate })
        .filter(r => r.type === "arb_entry" || r.type === "arb_close");

      if (arbEntries.length === 0) {
        const result = {
          trades: [],
          summary: {
            totalTrades: 0,
            completedTrades: 0,
            winRate: 0,
            avgHoldTime: null,
            totalNetPnl: 0,
            bestTrade: null,
            worstTrade: null,
            avgEntrySpread: 0,
            avgExitSpread: 0,
            avgSpreadDecay: 0,
            byExchangePair: [],
            byTimeOfDay: [],
            optimalHoldTime: null,
          },
          period: periodDays,
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.gray("  No arb trades found in this period.\n"));
        return;
      }

      // Group entries by arbPairId (or symbol fallback for legacy) to match entry/exit pairs
      const entryMap = new Map<string, ExecutionRecord[]>();
      const closeMap = new Map<string, ExecutionRecord[]>();

      function getPairKey(record: ExecutionRecord): string {
        // Use arbPairId if available (new format), fallback to symbol (legacy)
        const arbPairId = record.meta?.arbPairId as string | undefined;
        if (arbPairId) return arbPairId;
        return record.symbol.toUpperCase();
      }

      for (const entry of arbEntries) {
        const key = getPairKey(entry);
        if (entry.type === "arb_entry") {
          if (!entryMap.has(key)) entryMap.set(key, []);
          entryMap.get(key)!.push(entry);
        } else {
          if (!closeMap.has(key)) closeMap.set(key, []);
          closeMap.get(key)!.push(entry);
        }
      }

      // Build trade history by pairing entries with closes
      const trades: ArbHistoryTrade[] = [];

      for (const [symbol, entries] of entryMap) {
        const closes = closeMap.get(symbol) ?? [];
        // Sort entries oldest first for matching
        entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        closes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          // Find matching close (first close after this entry)
          const entryTime = new Date(entry.timestamp).getTime();
          const matchingClose = closes.find(c => new Date(c.timestamp).getTime() > entryTime);

          const exchanges = entry.exchange;
          const entrySpread = entry.meta?.spread as number | null ?? null;

          if (matchingClose) {
            // Remove matched close to avoid double-matching
            const closeIdx = closes.indexOf(matchingClose);
            closes.splice(closeIdx, 1);

            const closeTime = new Date(matchingClose.timestamp).getTime();
            const holdMs = closeTime - entryTime;
            const holdHours = holdMs / (1000 * 60 * 60);

            // Estimate PnL from metadata
            const exitSpread = matchingClose.meta?.currentSpread as number | null ?? null;
            const netPnl = matchingClose.meta?.netPnl as number | null ?? null;
            const upnl = matchingClose.meta?.unrealizedPnl as number | null ?? null;
            const exitReason = matchingClose.meta?.exitReason as string | null ?? null;

            // Estimate funding income based on hold time and entry spread
            const avgSpread = entrySpread ? entrySpread : 0;
            const sizeUsd = entry.meta?.markPrice
              ? Number(entry.size) * Number(entry.meta.markPrice)
              : 0;
            const estimatedFunding = sizeUsd > 0
              ? (avgSpread / 100) / (24 * 365) * sizeUsd * holdHours
              : 0;

            // Fees estimate
            const fees = sizeUsd * TAKER_FEE * 2 * 2; // entry + exit, both legs

            trades.push({
              symbol,
              exchanges,
              entryDate: entry.timestamp,
              exitDate: matchingClose.timestamp,
              holdDuration: formatDuration(holdMs),
              holdDurationMs: holdMs,
              entrySpread,
              exitSpread,
              size: entry.size,
              grossReturn: upnl !== null ? Number(upnl) : 0,
              fees,
              fundingIncome: estimatedFunding,
              netReturn: netPnl !== null ? Number(netPnl) : (upnl !== null ? Number(upnl) + estimatedFunding - fees : 0),
              status: matchingClose.status === "success" ? "completed" : "failed",
              exitReason,
            });
          } else {
            // Open trade (no matching close)
            const holdMs = Date.now() - entryTime;
            trades.push({
              symbol,
              exchanges,
              entryDate: entry.timestamp,
              exitDate: null,
              holdDuration: formatDuration(holdMs),
              holdDurationMs: holdMs,
              entrySpread,
              exitSpread: null,
              size: entry.size,
              grossReturn: 0,
              fees: 0,
              fundingIncome: 0,
              netReturn: 0,
              status: "open",
              exitReason: null,
            });
          }
        }
      }

      // Sort by entry date, newest first
      trades.sort((a, b) => new Date(b.entryDate).getTime() - new Date(a.entryDate).getTime());

      // Compute summary statistics
      const completedTrades = trades.filter(t => t.status === "completed");
      const winners = completedTrades.filter(t => t.netReturn > 0);
      const totalNetPnl = completedTrades.reduce((s, t) => s + t.netReturn, 0);
      const totalFunding = completedTrades.reduce((s, t) => s + t.fundingIncome, 0);
      const totalFees = completedTrades.reduce((s, t) => s + t.fees, 0);
      const avgHoldMs = completedTrades.length > 0
        ? completedTrades.reduce((s, t) => s + t.holdDurationMs, 0) / completedTrades.length
        : 0;
      const bestTrade = completedTrades.length > 0
        ? completedTrades.reduce((best, t) => t.netReturn > best.netReturn ? t : best)
        : null;
      const worstTrade = completedTrades.length > 0
        ? completedTrades.reduce((worst, t) => t.netReturn < worst.netReturn ? t : worst)
        : null;

      // Compute enhanced analytics
      const statsInput: ArbTradeForStats[] = trades.map(t => ({
        symbol: t.symbol,
        exchanges: t.exchanges,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        holdDurationMs: t.holdDurationMs,
        entrySpread: t.entrySpread,
        exitSpread: t.exitSpread,
        netReturn: t.netReturn,
        status: t.status,
      }));
      const enhanced = computeEnhancedStats(statsInput);

      const summary = {
        totalTrades: trades.length,
        completedTrades: completedTrades.length,
        openTrades: trades.filter(t => t.status === "open").length,
        failedTrades: trades.filter(t => t.status === "failed").length,
        winRate: completedTrades.length > 0 ? (winners.length / completedTrades.length) * 100 : 0,
        avgHoldTime: avgHoldMs > 0 ? formatDuration(avgHoldMs) : null,
        avgHoldTimeMs: avgHoldMs,
        totalNetPnl,
        totalFundingIncome: totalFunding,
        totalFees,
        bestTrade: bestTrade ? { symbol: bestTrade.symbol, netReturn: bestTrade.netReturn } : null,
        worstTrade: worstTrade ? { symbol: worstTrade.symbol, netReturn: worstTrade.netReturn } : null,
        avgEntrySpread: enhanced.avgEntrySpread,
        avgExitSpread: enhanced.avgExitSpread,
        avgSpreadDecay: enhanced.avgSpreadDecay,
        byExchangePair: enhanced.byExchangePair,
        byTimeOfDay: enhanced.byTimeOfDay,
        optimalHoldTime: enhanced.optimalHoldTime,
      };

      if (isJson()) {
        return printJson(jsonOk({ trades, summary, period: periodDays }));
      }

      // Display trade history table
      if (trades.length > 0) {
        console.log(chalk.cyan.bold("  Trade History\n"));

        const rows = trades.map(t => {
          const statusIcon = t.status === "completed" ? chalk.green("DONE")
            : t.status === "open" ? chalk.yellow("OPEN")
            : chalk.red("FAIL");
          const entryDate = new Date(t.entryDate).toLocaleDateString();
          const exitDate = t.exitDate ? new Date(t.exitDate).toLocaleDateString() : "-";

          return [
            chalk.white.bold(t.symbol),
            t.exchanges,
            entryDate,
            exitDate,
            t.holdDuration,
            t.entrySpread !== null ? `${t.entrySpread.toFixed(1)}%` : "-",
            t.size,
            formatPnl(t.grossReturn),
            chalk.yellow(`$${t.fundingIncome.toFixed(4)}`),
            chalk.red(`-$${t.fees.toFixed(4)}`),
            formatPnl(t.netReturn),
            statusIcon,
            t.exitReason ?? "-",
          ];
        });

        console.log(makeTable(
          ["Symbol", "Exchanges", "Entry", "Exit", "Hold", "Spread", "Size", "Gross", "Funding", "Fees", "Net", "Status", "Reason"],
          rows,
        ));
      }

      // Summary
      console.log(chalk.cyan.bold("\n  Summary Statistics\n"));
      console.log(`    Period:          Last ${periodDays} days`);
      console.log(`    Total trades:    ${summary.totalTrades} (${summary.completedTrades} completed, ${summary.openTrades} open, ${summary.failedTrades} failed)`);
      console.log(`    Win rate:        ${summary.winRate.toFixed(1)}%`);
      console.log(`    Avg hold time:   ${summary.avgHoldTime ?? "-"}`);
      console.log(`    Total net PnL:   ${formatPnl(summary.totalNetPnl)}`);
      console.log(`    Total funding:   ${chalk.yellow(`$${summary.totalFundingIncome.toFixed(4)}`)}`);
      console.log(`    Total fees:      ${chalk.red(`-$${summary.totalFees.toFixed(4)}`)}`);
      if (summary.bestTrade) {
        console.log(`    Best trade:      ${summary.bestTrade.symbol} ${formatPnl(summary.bestTrade.netReturn)}`);
      }
      if (summary.worstTrade) {
        console.log(`    Worst trade:     ${summary.worstTrade.symbol} ${formatPnl(summary.worstTrade.netReturn)}`);
      }

      // ── Exchange Pair Performance ──
      if (enhanced.byExchangePair.length > 0) {
        console.log(chalk.cyan.bold("\n  Exchange Pair Performance\n"));
        const pairRows = enhanced.byExchangePair.map(p => [
          chalk.white.bold(p.pair),
          String(p.trades),
          `${p.winRate.toFixed(0)}%`,
          formatPnl(p.avgNetPnl),
          p.avgHoldTime,
        ]);
        console.log(makeTable(
          ["Pair", "Trades", "Win%", "Avg PnL", "Avg Hold"],
          pairRows,
        ));
      }

      // ── Time of Day Performance ──
      if (enhanced.byTimeOfDay.length > 0) {
        console.log(chalk.cyan.bold("\n  Time of Day Performance\n"));
        const todRows = enhanced.byTimeOfDay.map(b => [
          chalk.white(b.bucket),
          String(b.trades),
          `${b.winRate.toFixed(0)}%`,
          formatPnl(b.avgNetPnl),
        ]);
        console.log(makeTable(
          ["UTC", "Trades", "Win%", "Avg PnL"],
          todRows,
        ));
      }

      // ── Spread Decay & Optimal Hold ──
      if (enhanced.optimalHoldTime) {
        console.log(`    Optimal hold time: ~${enhanced.optimalHoldTime} (median of winning trades)`);
      }
      if (enhanced.avgEntrySpread > 0 && enhanced.avgExitSpread >= 0) {
        console.log(`    Avg spread decay: ${enhanced.avgEntrySpread.toFixed(1)}% -> ${enhanced.avgExitSpread.toFixed(1)}% over avg ${summary.avgHoldTime ?? "-"}`);
      }
      console.log();
    });

  // ── arb rebalance ──

  arb
    .command("config")
    .description("Show arb configuration defaults (use 'arb auto --help' for all options)")
    .action(async () => {
      if (isJson()) {
        return printJson(jsonOk({
          minSpread: 30, closeSpread: 5, size: 100, holdDays: 7,
          bridgeCost: 0, interval: 60, cooldown: 30, minMargin: 30,
          settleStrategy: "block", maxLegs: 5,
        }));
      }
      console.log(chalk.cyan.bold("\n  Arb Auto Defaults\n"));
      console.log(`  Min Spread:       30% annual`);
      console.log(`  Close Spread:     5% annual`);
      console.log(`  Size:             $100 per leg`);
      console.log(`  Hold Days:        7d (for cost amortization)`);
      console.log(`  Bridge Cost:      $0`);
      console.log(`  Check Interval:   60s`);
      console.log(`  Cooldown:         30min (after closing a symbol)`);
      console.log(`  Min Margin:       30%`);
      console.log(`  Settle Strategy:  block`);
      console.log(`  Max Legs:         5`);
      console.log(chalk.gray(`\n  Override with 'perp arb auto --min-spread 20 --size 50 ...'\n`));
      console.log(chalk.gray(`  Run 'perp arb auto --help' for all options.\n`));
    });

  // Plan-only (never moves funds) — --dry-run only labels the plan.
  supportsDryRun(arb.command("rebalance"))
    .description("Cross-exchange balance rebalancing plan for arb (read-only; execute with perp funds rebalance execute)")
    .option("--check", "Show current balance distribution")
    .option("--target <ratio>", "Target distribution ratio (e.g., '50:50' for 2 exchanges, '33:33:33' for 3)")
    .option("--amount <usd>", "Total amount to rebalance")
    .option("--exchanges <list>", "Comma-separated exchanges", "lighter,pacifica,hyperliquid")
    .action(async (opts: {
      check?: boolean; target?: string; amount?: string;
      exchanges: string;
    }, cmd: Command) => {
      const dryRun = isDryRun(cmd);
      const exchangeNames = opts.exchanges.split(",").map(e => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();

      // Explicit --exchanges → an unavailable venue refuses (PerpError); the default list → skipped with a stderr warning.
      const explicitExchanges = cmd.getOptionValueSource("exchanges") === "cli";
      for (const [name, adapter] of await resolveRebalanceAdapters(exchangeNames, explicitExchanges, getAdapterForExchange)) adapters.set(name, adapter);

      if (adapters.size === 0) {
        if (isJson()) return printJson(jsonOk({ error: "No exchanges available" }));
        console.error(chalk.red("\n  No exchanges available. Check credentials.\n"));
        return;
      }

      // Default to --check if no action specified
      if (!opts.target && !opts.check) {
        opts.check = true;
      }

      // A venue whose balance read failed is reported (never dropped from the totals silently).
      const { snapshots, failed: unavailable, notConfigured } = await fetchBalancesWithFailures(adapters);
      const totalEquity = snapshots.reduce((s, e) => s + e.equity, 0);
      const totalAvailable = snapshots.reduce((s, e) => s + e.available, 0);

      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e === "aster" ? "AST" : e.toUpperCase();
      const exChain = (e: string) => e === "pacifica" ? "Solana" : e === "hyperliquid" ? "Hyperliquid" : e === "lighter" ? "Arbitrum" : e === "aster" ? "BNB" : "unknown";

      if (opts.check) {
        // Show current balance distribution
        if (isJson()) {
          return printJson(jsonOk({
            balances: snapshots.map(s => ({
              exchange: s.exchange,
              abbr: exAbbr(s.exchange),
              chain: exChain(s.exchange),
              equity: s.equity,
              available: s.available,
              marginUsed: s.marginUsed,
              unrealizedPnl: s.unrealizedPnl,
              allocationPct: totalEquity > 0 ? (s.equity / totalEquity) * 100 : 0,
            })),
            totalEquity,
            totalAvailable,
            unavailable,
            notConfigured,
            partial: unavailable.length > 0,
          }));
        }

        console.log(chalk.cyan("\n  Cross-Exchange Balance Distribution\n"));

        const rows = snapshots.map(s => {
          const pct = totalEquity > 0 ? ((s.equity / totalEquity) * 100).toFixed(1) : "0.0";
          return [
            chalk.white.bold(exAbbr(s.exchange).padEnd(4)),
            chalk.gray(exChain(s.exchange).padEnd(12)),
            `$${formatUsd(s.equity)}`,
            `$${formatUsd(s.available)}`,
            `$${formatUsd(s.marginUsed)}`,
            s.unrealizedPnl >= 0
              ? chalk.green(`+$${formatUsd(s.unrealizedPnl)}`)
              : chalk.red(`-$${formatUsd(Math.abs(s.unrealizedPnl))}`),
            `${pct}%`,
          ];
        });

        console.log(makeTable(["Exch", "Chain", "Equity", "Available", "Margin", "uPnL", "Alloc%"], rows));
        console.log(chalk.cyan.bold("  Totals"));
        console.log(`  Total Equity:    $${formatUsd(totalEquity)}`);
        console.log(`  Total Available: $${formatUsd(totalAvailable)}`);
        console.log(`  Exchanges:       ${snapshots.length}\n`);
        for (const f of unavailable) console.log(chalk.yellow(`  ⚠ ${f.exchange} balance unavailable (not in the totals): ${f.error}`));
        for (const n of notConfigured) console.log(chalk.gray(`  ${n}: not configured (no credentials) — left out`));
        if (unavailable.length > 0) console.log();
        return;
      }

      // A plan over fewer venues than requested would move funds on a wrong picture — refuse.
      if (unavailable.length > 0) {
        throw new PerpError("EXCHANGE_ERROR", `Rebalance plan refused: balance unavailable on ${unavailable.map(f => f.exchange).join(", ")}`, {
          remediation: `Retry when every venue answers, or limit the plan to readable venues with --exchanges (errors: ${unavailable.map(f => `${f.exchange}: ${f.error}`).join("; ")})`,
        });
      }

      // Parse target ratios
      if (!opts.target) {
        console.error(chalk.red("  --target required (e.g., '50:50' or '33:33:33')"));
        return;
      }

      const ratios = opts.target.split(":").map(Number);
      if (ratios.length !== snapshots.length || ratios.some(isNaN)) {
        console.error(chalk.red(`  Target ratio must have ${snapshots.length} parts (one per exchange), got '${opts.target}'`));
        return;
      }

      const ratioSum = ratios.reduce((a, b) => a + b, 0);
      const weights: Record<string, number> = {};
      snapshots.forEach((s, i) => {
        weights[s.exchange] = ratios[i] / ratioSum;
      });

      // Compute plan
      const plan = computeRebalancePlan(snapshots, { weights, minMove: 10, reserve: 10 });

      if (plan.moves.length === 0) {
        if (isJson()) return printJson(jsonOk({ status: "balanced", moves: [], snapshots }));
        console.log(chalk.green("\n  Already balanced -- no moves needed.\n"));
        return;
      }

      // If --amount specified, scale moves proportionally
      let moves = plan.moves;
      if (opts.amount) {
        const requestedAmount = Number(parsePositiveDecimal(opts.amount, "--amount"));
        const totalMoveAmount = moves.reduce((s, m) => s + m.amount, 0);
        if (totalMoveAmount > 0) {
          const scale = Math.min(1, requestedAmount / totalMoveAmount);
          moves = moves.map(m => ({ ...m, amount: Math.floor(m.amount * scale) })).filter(m => m.amount >= 10);
        }
      }

      // Get bridge route info for each move
      const moveDetails = await Promise.all(moves.map(async (m) => {
        const srcChain = EXCHANGE_TO_CHAIN[m.from] ?? "unknown";
        const dstChain = EXCHANGE_TO_CHAIN[m.to] ?? "unknown";
        // null = no quote could be read (quoteError says why) — never a made-up fee / provider.
        let bridgeFee: number | null = 0;
        let bridgeProvider: string | null = "same-chain";
        let bridgeTime: string | null = "instant";
        let quoteError: string | null = null;

        if (srcChain !== dstChain && srcChain !== "unknown" && dstChain !== "unknown") {
          try {
            const quote = await getBestQuote(srcChain, dstChain, m.amount, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000");
            bridgeFee = quote.fee;
            bridgeProvider = quote.provider;
            bridgeTime = `~${Math.ceil(quote.estimatedTime / 60)}min`;
          } catch (e) {
            bridgeFee = null;
            bridgeProvider = null;
            bridgeTime = null;
            quoteError = e instanceof Error ? e.message : String(e);
          }
        }

        return {
          ...m,
          srcChain,
          dstChain,
          bridgeFee,
          bridgeProvider,
          bridgeTime,
          quoteError,
        };
      }));

      if (isJson()) {
        return printJson(jsonOk({
          status: dryRun ? "dry_run" : "planned",
          target: weights,
          moves: moveDetails,
          snapshots,
          totalEquity,
        }));
      }

      console.log(chalk.cyan("\n  Rebalance Plan\n"));

      // Show current vs target
      const stateRows = snapshots.map(s => {
        const targetPct = (weights[s.exchange] * 100).toFixed(1);
        const currentPct = totalEquity > 0 ? ((s.equity / totalEquity) * 100).toFixed(1) : "0.0";
        const targetUsd = totalAvailable * weights[s.exchange];
        const diff = s.available - targetUsd;
        const diffStr = diff >= 0
          ? chalk.green(`+$${formatUsd(diff)}`)
          : chalk.red(`-$${formatUsd(Math.abs(diff))}`);
        return [
          chalk.white.bold(exAbbr(s.exchange)),
          `$${formatUsd(s.available)}`,
          `${currentPct}%`,
          `$${formatUsd(targetUsd)}`,
          `${targetPct}%`,
          diffStr,
        ];
      });

      console.log(makeTable(["Exch", "Available", "Current%", "Target$", "Target%", "Diff"], stateRows));

      // Show moves
      console.log(chalk.cyan.bold("\n  Transfers\n"));
      for (let i = 0; i < moveDetails.length; i++) {
        const m = moveDetails[i];
        console.log(chalk.white.bold(`  Move ${i + 1}: $${m.amount} ${exAbbr(m.from)} -> ${exAbbr(m.to)}`));
        if (m.bridgeFee === null) {
          console.log(chalk.yellow(`    Route: ${m.srcChain} -> ${m.dstChain} — no bridge quote (${m.quoteError})`));
        } else {
          console.log(chalk.gray(`    Route: ${m.srcChain} -> ${m.dstChain} via ${m.bridgeProvider}`));
          console.log(chalk.gray(`    Fee: ~$${m.bridgeFee.toFixed(2)} | Time: ${m.bridgeTime}`));
        }
        console.log();
      }

      const totalFees = moveDetails.reduce((s, m) => s + (m.bridgeFee ?? 0), 0);
      const unquoted = moveDetails.filter(m => m.bridgeFee === null).length;
      console.log(chalk.gray(`  Total bridge fees: ~$${totalFees.toFixed(2)}`) + (unquoted > 0 ? chalk.yellow(` (excludes ${unquoted} move(s) without a quote)`) : ""));

      if (dryRun) {
        console.log(chalk.yellow("\n  [DRY RUN] No transfers executed.\n"));
      } else {
        console.log(chalk.yellow("\n  To execute, use: perp funds rebalance execute --auto-bridge\n"));
      }
    });

  // ── printFundingEarned helper (used by arb status --funding) ──

  async function printFundingEarned(
    getAdapter: (exchange: string) => Promise<ExchangeAdapter>,
    isJsonFn: () => boolean,
    opts: { period: string; symbol?: string },
  ): Promise<void> {
    const periodDays = parseInt(opts.period);
    const filterSym = opts.symbol?.toUpperCase();

    if (!isJsonFn()) console.log(chalk.cyan(`\n  Fetching funding payments (last ${periodDays} days)...\n`));

    // Fetch positions to identify arb pairs
    const fundingPositions: { exchange: string; symbol: string; side: "long" | "short"; size: number; markPrice: number }[] = [];

    const fundingVenues = await listArbVenues();
    for (const { exchange, position: p } of await readArbVenuePositions(fundingVenues, getAdapter)) {
      fundingPositions.push({
        exchange,
        symbol: p.symbol.replace("-PERP", "").toUpperCase(),
        side: p.side,
        size: Math.abs(Number(p.size)),
        markPrice: Number(p.markPrice),
      });
    }

    // Identify arb pairs (long on one exchange, short on another)
    const arbPairKeys = new Set<string>();
    const arbPairInfo = new Map<string, { longExchange: string; shortExchange: string; notionalUsd: number }>();
    const fLongs = fundingPositions.filter(p => p.side === "long");
    const fShorts = fundingPositions.filter(p => p.side === "short");
    for (const l of fLongs) {
      for (const s of fShorts) {
        if (l.exchange !== s.exchange && l.symbol === s.symbol) {
          const key = l.symbol;
          arbPairKeys.add(key);
          arbPairInfo.set(key, {
            longExchange: l.exchange,
            shortExchange: s.exchange,
            notionalUsd: (l.size * l.markPrice + s.size * s.markPrice) / 2,
          });
        }
      }
    }

    // Fetch funding payments from all configured exchanges
    interface FundingPaymentRow {
      time: number;
      exchange: string;
      symbol: string;
      payment: number;
    }

    const allPayments: FundingPaymentRow[] = [];
    const cutoff = Date.now() - periodDays * 24 * 60 * 60 * 1000;

    for (const exName of fundingVenues) {
      try {
        const adapter = await getAdapter(exName);
        const payments = await adapter.getFundingPayments(200);
        for (const p of payments) {
          if (p.time < cutoff) continue;
          const sym = p.symbol.replace("-PERP", "").toUpperCase();
          if (filterSym && sym !== filterSym) continue;
          allPayments.push({
            time: p.time,
            exchange: exName,
            symbol: sym,
            payment: typeof p.payment === "string" ? parseFloat(p.payment) : Number(p.payment),
          });
        }
      } catch (e) {
        // Reported, not hidden: this venue's payments are missing from the totals below.
        process.stderr.write(`[warn] ${exName} funding payments unavailable (left out of the totals): ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    // Group by symbol, then by exchange
    const bySymbol = new Map<string, FundingPaymentRow[]>();
    for (const p of allPayments) {
      if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
      bySymbol.get(p.symbol)!.push(p);
    }

    // Build per-pair summary
    interface FundingPairSummary {
      symbol: string;
      isArbPair: boolean;
      longExchange: string | null;
      shortExchange: string | null;
      notionalUsd: number;
      byExchange: { exchange: string; totalReceived: number; totalPaid: number; net: number; payments: number }[];
      totalReceived: number;
      totalPaid: number;
      netEarned: number;
      dailyAvg: number;
      annualizedApr: number;
      payments: number;
    }

    const pairs: FundingPairSummary[] = [];

    for (const [symbol, payments] of bySymbol) {
      const isArb = arbPairKeys.has(symbol);
      const pairInfo = arbPairInfo.get(symbol);

      // Group by exchange
      const byEx = new Map<string, FundingPaymentRow[]>();
      for (const p of payments) {
        if (!byEx.has(p.exchange)) byEx.set(p.exchange, []);
        byEx.get(p.exchange)!.push(p);
      }

      const exchangeSummaries: FundingPairSummary["byExchange"] = [];
      let totalReceived = 0;
      let totalPaid = 0;

      for (const [exchange, exPayments] of byEx) {
        const received = exPayments.filter(p => p.payment > 0).reduce((s, p) => s + p.payment, 0);
        const paid = exPayments.filter(p => p.payment < 0).reduce((s, p) => s + Math.abs(p.payment), 0);
        const net = received - paid;
        totalReceived += received;
        totalPaid += paid;
        exchangeSummaries.push({ exchange, totalReceived: received, totalPaid: paid, net, payments: exPayments.length });
      }

      const netEarned = totalReceived - totalPaid;
      const dailyAvg = periodDays > 0 ? netEarned / periodDays : 0;
      const notionalUsd = pairInfo?.notionalUsd || 0;
      const annualizedApr = notionalUsd > 0 ? (dailyAvg * 365 / notionalUsd) * 100 : 0;

      pairs.push({
        symbol,
        isArbPair: isArb,
        longExchange: pairInfo?.longExchange ?? null,
        shortExchange: pairInfo?.shortExchange ?? null,
        notionalUsd,
        byExchange: exchangeSummaries,
        totalReceived,
        totalPaid,
        netEarned,
        dailyAvg,
        annualizedApr,
        payments: payments.length,
      });
    }

    // Sort: arb pairs first, then by netEarned
    pairs.sort((a, b) => {
      if (a.isArbPair !== b.isArbPair) return a.isArbPair ? -1 : 1;
      return b.netEarned - a.netEarned;
    });

    // Totals
    const totals = {
      totalReceived: pairs.reduce((s, p) => s + p.totalReceived, 0),
      totalPaid: pairs.reduce((s, p) => s + p.totalPaid, 0),
      netEarned: pairs.reduce((s, p) => s + p.netEarned, 0),
      dailyAvg: pairs.reduce((s, p) => s + p.dailyAvg, 0),
      totalNotional: pairs.filter(p => p.isArbPair).reduce((s, p) => s + p.notionalUsd, 0),
      arbPairs: pairs.filter(p => p.isArbPair).length,
      period: periodDays,
    };

    const totalArbNotional = totals.totalNotional;
    const portfolioApr = totalArbNotional > 0
      ? (totals.dailyAvg * 365 / totalArbNotional) * 100
      : 0;

    if (isJsonFn()) {
      printJson(jsonOk({
        fundingEarned: {
          pairs,
          totals: { ...totals, annualizedApr: portfolioApr },
        },
      }));
      return;
    }

    if (pairs.length === 0) {
      console.log(chalk.gray("  No funding payments found.\n"));
      return;
    }

    console.log(chalk.cyan.bold("  Funding Payments Earned\n"));

    const rows = pairs.map(p => {
      const arbTag = p.isArbPair ? chalk.green("ARB") : chalk.gray("---");
      const exchanges = p.byExchange.map(e => e.exchange.slice(0, 3).toUpperCase()).join("+");
      return [
        chalk.white.bold(p.symbol),
        arbTag,
        exchanges,
        chalk.green(`$${p.totalReceived.toFixed(4)}`),
        chalk.red(`-$${p.totalPaid.toFixed(4)}`),
        formatPnl(p.netEarned),
        `$${p.dailyAvg.toFixed(4)}/d`,
        p.annualizedApr > 0 ? `${p.annualizedApr.toFixed(1)}%` : "-",
        String(p.payments),
      ];
    });

    console.log(makeTable(
      ["Symbol", "Type", "Exchanges", "Received", "Paid", "Net", "Daily Avg", "APR", "#"],
      rows,
    ));

    console.log(chalk.white.bold("\n  Totals"));
    console.log(`    Period:       ${periodDays} days`);
    console.log(`    Received:     ${chalk.green(`$${totals.totalReceived.toFixed(4)}`)}`);
    console.log(`    Paid:         ${chalk.red(`-$${totals.totalPaid.toFixed(4)}`)}`);
    console.log(`    Net Earned:   ${formatPnl(totals.netEarned)}`);
    console.log(`    Daily Avg:    $${totals.dailyAvg.toFixed(4)}/day`);
    if (portfolioApr > 0) {
      console.log(`    Portfolio APR: ${chalk.cyan(`${portfolioApr.toFixed(1)}%`)} (on $${formatUsd(totalArbNotional)} arb notional)`);
    }
    console.log();
  }
}
