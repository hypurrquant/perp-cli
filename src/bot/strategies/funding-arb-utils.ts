/**
 * Shared utilities for funding arbitrage strategies (v1 + v2).
 * Extracted to keep individual strategy files under size limits.
 */

import type { StrategyContext } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import type { SpotAdapter, SpotMarketInfo } from "../../exchanges/spot-interface.js";
import type { VenueMarket } from "../../exchanges/venue-types.js";
import { getFundingHours } from "../../funding.js";
import { sharedApiNetwork } from "../../api/public/urls.js";
import { annualizeHourlyRate } from "../../funding/normalize.js";
import { fetchPerpMarketsForMatching, matchSpotPerp, transferQuoteToPerp, transferQuoteToSpot } from "../../exchanges/spot-factory.js";
import { PerpError, extractErrorMessage } from "../../errors.js";
import { assertFundingArbVenue, tryResolveVenueId } from "../../exchanges/venue.js";
import "../../exchanges/venues/index.js";

/**
 * Funding strategies refuse a venue whose funding rate is unverified as a leg (
 * #6): every adapter of the run (primary + extraAdapters) is checked when the strategy starts.
 * Adapter names that are not registered venues (test doubles) are not venues and are skipped.
 */
export function assertFundingArbLegs(ctx: StrategyContext): void {
  const names = new Set<string>([ctx.adapter.name]);
  const extra = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
  if (extra !== undefined) for (const a of extra.values()) names.add(a.name);
  for (const name of names) {
    if (tryResolveVenueId(name.split(":")[0]) === null) continue;
    assertFundingArbVenue(name);
  }
}

// ── Type aliases ──

export type RateEntry = {
  rate: number;
  price: number;
  sizeDecimals?: number;
  maxLeverage?: number;
  fundingHours?: number;
};

export type RateMap = Map<string, Map<string, RateEntry>>;

// ── Adapter helpers ──

/** Build adapter map from primary adapter + extraAdapters in context state. */
export function buildAdapterMap(ctx: StrategyContext): Map<string, ExchangeAdapter> {
  const extraAdapters = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
  const adapters = new Map<string, ExchangeAdapter>();
  adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
  if (extraAdapters) {
    for (const [name, a] of extraAdapters) adapters.set(name, a);
  }
  return adapters;
}

// ── Transfer helpers ──
// Spot adapters come from the factory (src/exchanges/spot-factory.ts, getBotSpotAdapter).

/**
 * Move the spot venue's quote asset (quoteAssets[0]) perp → spot. Returns false when
 * spot shares perp margin (no-op — callers must not log "Transferred"); throws when
 * the venue has no transfer.
 */
export async function transferUsdcToSpot(spotAdapter: SpotAdapter, amount: number): Promise<boolean> {
  return transferQuoteToSpot(spotAdapter, amount);
}

/** Spot → perp counterpart of transferUsdcToSpot. */
export async function transferUsdcToPerp(spotAdapter: SpotAdapter, amount: number): Promise<boolean> {
  return transferQuoteToPerp(spotAdapter, amount);
}

// ── Spot ↔ perp matching ──

/**
 * Bot spot↔perp candidates: spot bases on `spotVenue` matched to each perp venue by
 * canonical symbol + price-deviation guard (`matchSpotPerp`). Bare-ticker equality is
 * not enough. Bot positions store one symbol and derive the perp leg with
 * `getPerpSymbol(base)`, so a canonical pair whose perp symbol differs from the spot
 * base (e.g. UBTC ↔ BTC) is reported and skipped rather than traded under the wrong
 * perp symbol. Returns perp venue → matched spot bases (upper-case).
 *
 * `perpMarketsCache` lets one scan reuse each perp venue's public market fetch.
 * A perp venue whose markets cannot be fetched is logged and gets no candidates.
 */
export async function botSpotPerpMatches(
  spotVenue: string,
  spotMarkets: readonly SpotMarketInfo[],
  perpVenues: readonly string[],
  perpMarketsCache: Map<string, Promise<VenueMarket[]>>,
  log: (msg: string) => void,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const perpVenue of perpVenues) {
    let pending = perpMarketsCache.get(perpVenue);
    if (pending === undefined) {
      pending = fetchPerpMarketsForMatching(perpVenue);
      perpMarketsCache.set(perpVenue, pending);
    }
    let perpMarkets: VenueMarket[];
    try {
      perpMarkets = await pending;
    } catch (e) {
      log(`spot↔perp matching: ${perpVenue} perp markets unavailable (${e instanceof Error ? e.message : String(e)}) — no ${perpVenue} candidates this scan`);
      out.set(perpVenue, new Set());
      continue;
    }
    const matches = matchSpotPerp(spotVenue, spotMarkets, perpVenue, perpMarkets, log, sharedApiNetwork());
    const bases = new Set<string>();
    const aliased: string[] = [];
    for (const m of matches.values()) {
      if (getPerpSymbol(m.spotBase, perpVenue) === m.perpSymbol.toUpperCase()) bases.add(m.spotBase);
      else aliased.push(`${m.spotBase}↔${m.perpSymbol}`);
    }
    if (aliased.length > 0) {
      log(`spot↔perp matching ${spotVenue}→${perpVenue}: ${aliased.length} canonical pair(s) with a different perp symbol skipped (bot positions use one symbol): ${aliased.join(", ")}`);
    }
    out.set(perpVenue, bases);
  }
  return out;
}

// ── Rate / symbol helpers ──

/** Resolve perp symbol for a given base symbol on an exchange. */
export function getPerpSymbol(baseSymbol: string, _exchangeName: string): string {
  return baseSymbol.replace(/-PERP$/, "").toUpperCase();
}

/** Look up rate from ratesByExchange, trying symbol, symbol-PERP, and symbol without -PERP. */
export function findRate(ratesByExchange: RateMap, exchange: string, symbol: string): RateEntry | undefined {
  const map = ratesByExchange.get(exchange);
  if (!map) return undefined;
  const upper = symbol.toUpperCase();
  return map.get(upper) ?? map.get(upper + "-PERP") ?? map.get(upper.replace(/-PERP$/, ""));
}

/**
 * Leverage for an entry: the configured value, capped by every leg's published max.
 * A leg whose max is unpublished (undefined) is not a cap — the venue enforces its own
 * limit on setLeverage / the order — and `logUnknown` names it, so it is never read as 1x.
 */
export function cappedLeverage(
  configured: number,
  legs: { exchange: string; maxLeverage: number | undefined }[],
  logUnknown: (msg: string) => void,
): number {
  let leverage = configured;
  for (const leg of legs) {
    if (leg.maxLeverage === undefined) {
      logUnknown(`  [LEV] ${leg.exchange} does not publish a max leverage — using ${configured}x; the venue enforces its cap`);
    } else {
      leverage = Math.min(leverage, leg.maxLeverage);
    }
  }
  return leverage;
}

/** Match a symbol against a target, accounting for -PERP suffix variations. */
export function matchSymbol(s: string, target: string): boolean {
  const u = s.toUpperCase();
  const t = target.toUpperCase();
  return u === t || u === t + "-PERP" || u.replace(/-PERP$/, "") === t;
}

/** Get a price estimate for a symbol from the perp adapter. */
export async function getPriceEstimate(perpAdapter: ExchangeAdapter, perpSymbol: string, fallbackSymbol: string): Promise<number> {
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

// ── Shared scoring types & helpers ──

export interface FundingScore {
  symbol: string;
  exchange: string;
  avgRate: number;
  consistency: number;
  annualized: number;
  payments: number;
}

/**
 * true when a reduce-only close was rejected because there is no position left to reduce.
 * Prefers the typed signal: placePerpVerified's ORDER_REJECTED with details.reduceOnlyFlat
 * (flat before and after the order — "(no X position to reduce)"). Venue texts that carry the
 * same meaning are matched too: HL "Reduce only order would increase position", Aster -2022
 * / "ReduceOnly Order is rejected". Only ever applied to a DEFINITE rejection (an
 * ORDER_PENDING outcome is never "gone").
 */
export function isPositionGone(e: unknown): boolean {
  if (e instanceof PerpError) {
    if (e.structured.code === "ORDER_PENDING") return false;
    if (e.structured.code === "ORDER_REJECTED" && e.structured.details?.reduceOnlyFlat === true) return true;
  }
  const msg = typeof e === "string" ? e : extractErrorMessage(e);
  return /position to reduce\)/.test(msg)
    || /reduce only order would increase position/i.test(msg)
    || msg.includes("ReduceOnly") || msg.includes("reduceOnly") || msg.includes("-2022");
}

/** Adapters that publish a per-symbol funding basis (Aster: GET /fapi/v3/fundingInfo). */
interface PerSymbolFundingHours {
  getFundingHours(symbol: string): Promise<number | undefined>;
}

function hasPerSymbolFundingHours(adapter: ExchangeAdapter): adapter is ExchangeAdapter & PerSymbolFundingHours {
  return typeof (adapter as Partial<PerSymbolFundingHours>).getFundingHours === "function";
}

/**
 * Funding basis (hours one quoted rate covers) for a market: the market's own
 * value when the venue publishes one per symbol, else the venue definition.
 * History timestamp spacing is settlement timing, never the basis.
 * @returns null when the venue publishes per-symbol values and this symbol has none
 */
async function marketFundingHours(adapter: ExchangeAdapter, exchangeName: string, symbol: string): Promise<number | null> {
  if (hasPerSymbolFundingHours(adapter)) {
    const hours = await adapter.getFundingHours(symbol);
    return hours === undefined ? null : hours;
  }
  return getFundingHours(exchangeName);
}

/**
 * Score a symbol's funding rate using history. null = not enough data (fewer than 2 history
 * points, or the per-symbol funding basis is unknown). A failed read THROWS — callers must not
 * mistake a 429 / timeout for "history too thin".
 */
export async function scoreFunding(
  adapter: ExchangeAdapter,
  symbol: string,
  exchangeName: string,
  periods: number,
  cache?: Map<string, { score: FundingScore; ts: number }>,
): Promise<FundingScore | null> {
  const key = `${exchangeName}:${symbol}`;
  const cached = cache?.get(key);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.score;
  const venueHours = hasPerSymbolFundingHours(adapter) ? null : getFundingHours(exchangeName);
  const fH = venueHours !== null ? venueHours : await marketFundingHours(adapter, exchangeName, symbol);
  if (fH === null) return null; // per-symbol basis unknown — the hourly rate would be a guess
  // Closed-market windows (QFEX outside market_hours: rate null, marketClosed) carry no funding;
  // averaging them in as 0 would dilute the rate and the APR.
  const history = (await adapter.getFundingHistory(symbol, periods)).filter((h): h is typeof h & { rate: string } => h.rate !== null && h.marketClosed !== true);
  if (history.length < 2) return null;
  const rates = history.map(h => parseFloat(h.rate));
  if (rates.some(r => !Number.isFinite(r))) {
    throw new PerpError("EXCHANGE_ERROR", `${exchangeName} ${symbol}: funding history has a non-numeric rate`, { exchange: exchangeName });
  }
  const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
  const consistency = rates.filter(r => r > 0).length / rates.length;
  // A row that states its own interval (Lighter /fundings prints are per 1 h while the venue's
  // quoted rate is per 8 h) is normalized with it; intervalHours null → the market basis fH.
  const avgHourly = history.reduce((s, h, i) => s + rates[i] / (typeof h.intervalHours === "number" ? h.intervalHours : fH), 0) / rates.length;
  const annualized = annualizeHourlyRate(avgHourly);
  const score: FundingScore = { symbol, exchange: exchangeName, avgRate, consistency, annualized, payments: rates.length };
  cache?.set(key, { score, ts: Date.now() });
  return score;
}

/**
 * Fetch funding rates from an exchange adapter. Failures propagate — callers
 * record them per venue (an empty list would read as "venue has no markets").
 */
export async function fetchRates(
  adapter: ExchangeAdapter,
  exchangeName: string,
): Promise<{ symbol: string; rate: number; price: number; sizeDecimals?: number; maxLeverage?: number; fundingHours?: number }[]> {
  const markets = await adapter.getMarkets();
  const withRates = markets.filter(m => m.fundingRate != null);

  // fundingHours = basis: market value first, then the venue definition.
  // Per-symbol venues (Aster) load their whole table in one call; symbols it
  // does not list stay null and are skipped below.
  for (const m of withRates) {
    if (m.fundingHours !== null) continue;
    m.fundingHours = await marketFundingHours(adapter, exchangeName, m.symbol);
  }

  // maxLeverage undefined = not published by the venue (callers cap by published maxes only — see cappedLeverage).
  const result: { symbol: string; rate: number; price: number; sizeDecimals: number; maxLeverage?: number; fundingHours: number }[] = [];
  for (const m of withRates) {
    // Skip aster symbols with unknown funding period — the hourly rate would be a guess.
    if (m.fundingHours === null) continue;
    // Skip markets whose size precision the venue does not publish — a leg could
    // not be sized to the venue's lot, and substituting a static guess mis-sizes it.
    if (m.sizeDecimals === null) continue;
    result.push({
      symbol: m.symbol,
      rate: parseFloat(m.fundingRate!),
      price: parseFloat(m.markPrice),
      sizeDecimals: m.sizeDecimals,
      maxLeverage: m.maxLeverage ?? undefined,
      fundingHours: m.fundingHours,
    });
  }
  return result;
}

/**
 * Cancel the open orders of `symbols` (the bot's own) on every venue in `adapters` — never an
 * account-wide cancel. Each failure is logged (never "cancelled"); nothing is logged as
 * cancelled when the bot traded no symbol.
 */
export async function cancelBotSymbols(
  adapters: Map<string, ExchangeAdapter>, symbols: ReadonlySet<string>, tag: string, log: (msg: string) => void,
): Promise<void> {
  if (symbols.size === 0) { log(`  ${tag} No bot symbols traded — no orders to cancel`); return; }
  for (const [name, a] of adapters) {
    for (const sym of symbols) {
      try {
        await a.cancelAllOrders(sym);
      } catch (e) {
        log(`  ${tag} WARNING: cancelling ${sym} orders on ${name} FAILED (${e instanceof Error ? e.message : String(e)}) — check: perp -e ${name} account orders`);
      }
    }
  }
  log(`  ${tag} Cancel requested for ${[...symbols].join(", ")} on ${[...adapters.keys()].join(", ")}`);
}

/** Venues whose funding history is CAPABILITY_UNSUPPORTED, already reported once (collectFundingSince). */
const _fundingUnsupportedLogged = new Set<string>();

/**
 * Books settled funding not yet booked (shared by the funding-arb and spot-perp bots).
 * `since[venue]` is a per-venue HIGH-WATER MARK of the newest payment time already booked
 * (initially `defaultStart`, the bot's start — recovery booked the 24 h before it): only payments
 * strictly newer are summed, so consecutive reads never count a payment twice. A venue whose read
 * fails keeps its mark and is re-read next time; the others are booked — one failure never drops
 * or blocks the rest, and a failed read is never counted as 0. When a catching-up read returns a
 * full page whose oldest row is still newer than the mark, older payments may be beyond the page
 * and a warning is logged. `since` is mutated in place.
 */
export async function collectFundingSince(
  adapters: ReadonlyMap<string, { getFundingPayments(limit?: number): Promise<Array<{ time: number; payment: string }>> }>,
  since: Record<string, number>,
  defaultStart: number,
  log: (msg: string) => void,
): Promise<{ total: number; failed: string[] }> {
  const PAGE = 50;
  let total = 0;
  const failed: string[] = [];
  for (const [name, a] of adapters) {
    try {
      const payments = await a.getFundingPayments(PAGE);
      const mark = since[name] ?? defaultStart;
      const fresh = payments.filter(fp => fp.time > mark);
      const sum = fresh.reduce((s, fp) => s + parseFloat(fp.payment), 0);
      total += sum;
      since[name] = fresh.reduce((m, fp) => Math.max(m, fp.time), mark);
      if (payments.length >= PAGE && fresh.length === payments.length) {
        log(`  [FUND] ${name}: ${PAGE} unbooked payments in one read — older ones since the last booked payment may be missing from fundingIncome`);
      }
      if (Math.abs(sum) > 0.001) log(`  [FUND] ${name}: $${sum.toFixed(4)} funding`);
    } catch (e) {
      failed.push(name);
      // A venue that does not offer funding history at all (QFEX: CAPABILITY_UNSUPPORTED) is said
      // once per process; a read failure is logged every time.
      const unsupported = e instanceof PerpError && e.structured.code === "CAPABILITY_UNSUPPORTED";
      if (!unsupported || !_fundingUnsupportedLogged.has(name)) {
        log(`  [FUND] ${name}: ${unsupported ? "funding history not supported — its funding is not counted" : "funding history unavailable (re-read next check)"}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (unsupported) _fundingUnsupportedLogged.add(name);
    }
  }
  return { total, failed };
}
