import { Command } from "commander";
import { makeTable, formatUsd, formatPercent, formatPnl, printJson, jsonOk, jsonError, withJsonErrors, logSettledRejections } from "../utils.js";
import chalk from "chalk";
import { annualizeRate, computeAnnualSpread, toHourlyRate, estimateHourlyFunding, annualizeHourlyRate, estimateHourlyFundingFromHourly } from "../funding.js";
import {
  fetchAllFundingRates,
  fetchCanonicalPriceGroups,
  dropPriceOutliers,
  fetchSymbolFundingRates,
  isRankedComparison,
  TOP_SYMBOLS,
  type FundingRateSnapshot,
  type SymbolFundingComparison,
} from "../funding-rates.js";
import {
  saveFundingSnapshot,
  getHistoricalRates,
  getCompoundedAnnualReturn,
  getExchangeCompoundingHours,
} from "../funding-history.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { getVenue, listVenuesWithRole, tryResolveVenueId } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";
import { MAX_PRICE_DEVIATION_PCT } from "../exchanges/index.js";
import {
  fetchPacificaPricesRaw, parsePacificaRaw,
  fetchHyperliquidAllMidsRaw,
  fetchLighterOrderBookDetailsRaw,
} from "../shared-api.js";
import { scanDexArb } from "../dex-asset-map.js";

// annualize moved to ../funding.ts — use annualizeRate() / computeAnnualSpread()

export function registerArbCommands(
  program: Command,
  isJson: () => boolean,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
) {
  const arb = program.command("arb").description("Funding rate arbitrage & basis trading");

  // basis, dex, rates, compare, funding-history, funding-positions, gaps, live monitor
  // → consolidated into 'arb scan' (in arb-auto.ts) with routing options
}

// ────────────────────────────────────────────────────────
// Gap monitoring (merged from gap.ts)
// ────────────────────────────────────────────────────────

export interface PriceSnapshot {
  symbol: string;
  pacPrice: number | null;
  hlPrice: number | null;
  ltPrice: number | null;
  maxGap: number; // absolute $ max difference across exchanges
  maxGapPct: number; // percentage max difference
  cheapest: string;
  expensive: string;
}

export async function fetchAllPrices(): Promise<PriceSnapshot[]> {
  // SSOT rule #2: each DEX is independent. allSettled keeps the comparison
  // alive when one DEX errors out, while rejection reasons get logged to
  // stderr (explicit failure, never silent).
  const settled = await Promise.allSettled([
    fetchPacificaPricesRaw(),
    fetchHyperliquidAllMidsRaw(),
    fetchLighterOrderBookDetailsRaw(),
  ]);
  logSettledRejections(settled, ["pacifica", "hyperliquid", "lighter:orderbook"], "arb");
  const pacRes = settled[0].status === "fulfilled" ? settled[0].value : null;
  const hlRes = settled[1].status === "fulfilled" ? settled[1].value : null;
  const ltRes = settled[2].status === "fulfilled" ? settled[2].value : null;

  const { prices: pacPrices } = parsePacificaRaw(pacRes);

  const hlPrices = new Map<string, number>();
  if (hlRes && typeof hlRes === "object" && !Array.isArray(hlRes)) {
    for (const [symbol, price] of Object.entries(hlRes as Record<string, string>)) {
      const p = Number(price);
      if (p > 0) hlPrices.set(symbol, p);
    }
  }

  const ltPrices = new Map<string, number>();
  if (ltRes) {
    const details = ((ltRes as Record<string, unknown>).order_book_details ?? []) as Array<Record<string, unknown>>;
    for (const m of details) {
      const sym = String(m.symbol ?? "").replace(/_USDC$/, "");
      const price = Number(m.last_trade_price ?? m.mark_price ?? 0);
      if (sym && price > 0) ltPrices.set(sym, price);
    }
  }

  return buildGapSnapshots(pacPrices, hlPrices, ltPrices);
}

/**
 * Cross-venue price gaps by venue symbol. The same ticker on two venues is not proof of the same
 * instrument (Pacifica SAMSUNG 165.8 USD vs Lighter SAMSUNG 220,597 — a KRW-quoted listing): each
 * symbol's prices go through the funding scan's median price-outlier guard (dropPriceOutliers,
 * MAX_PRICE_DEVIATION_PCT, one warning per symbol / venue) before a gap is computed, so a gap is
 * only reported between prices that agree within the guard.
 */
export function buildGapSnapshots(pacPrices: Map<string, number>, hlPrices: Map<string, number>, ltPrices: Map<string, number>): PriceSnapshot[] {
  const allSymbols = new Set([...pacPrices.keys(), ...hlPrices.keys(), ...ltPrices.keys()]);
  const snapshots: PriceSnapshot[] = [];
  const LABEL: Record<"pacifica" | "hyperliquid" | "lighter", string> = { pacifica: "PAC", hyperliquid: "HL", lighter: "LT" };

  for (const sym of allSymbols) {
    const listed: { exchange: "pacifica" | "hyperliquid" | "lighter"; markPrice: number }[] = [];
    for (const [exchange, map] of [["pacifica", pacPrices], ["hyperliquid", hlPrices], ["lighter", ltPrices]] as const) {
      const p = map.get(sym);
      if (p !== undefined) listed.push({ exchange, markPrice: p });
    }
    if (listed.length < 2) continue;
    const kept = dropPriceOutliers(sym, listed, "gaps");
    // Need at least 2 exchanges whose prices agree
    if (kept.length < 2) continue;
    const priceOf = (ex: "pacifica" | "hyperliquid" | "lighter") => kept.find(k => k.exchange === ex)?.markPrice ?? null;
    const available = kept.map(k => ({ ex: LABEL[k.exchange], price: k.markPrice })).sort((a, b) => a.price - b.price);
    const cheapest = available[0];
    const expensive = available[available.length - 1];
    const maxGap = expensive.price - cheapest.price;
    const mid = (cheapest.price + expensive.price) / 2;
    const maxGapPct = mid > 0 ? (maxGap / mid) * 100 : 0;

    snapshots.push({
      symbol: sym,
      pacPrice: priceOf("pacifica"),
      hlPrice: priceOf("hyperliquid"),
      ltPrice: priceOf("lighter"),
      maxGap,
      maxGapPct,
      cheapest: cheapest.ex,
      expensive: expensive.ex,
    });
  }

  return snapshots.sort((a, b) => b.maxGapPct - a.maxGapPct);
}

export function formatGapPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

export function printGapTable(snapshots: PriceSnapshot[], minGap: number) {
  const filtered = snapshots.filter((s) => s.maxGapPct >= minGap);

  if (filtered.length === 0) {
    console.log(chalk.gray(`\n  No gaps above ${minGap}%\n`));
    return;
  }

  console.log(
    chalk.cyan.bold("\n  Symbol      Pacifica          Hyperliquid       Lighter           Gap($)      Gap(%)    Buy/Sell\n")
  );

  for (const s of filtered) {
    const gapColor =
      s.maxGapPct >= 0.5
        ? chalk.red.bold
        : s.maxGapPct >= 0.1
          ? chalk.yellow
          : chalk.gray;
    const fmtP = (p: number | null) => p !== null ? `$${formatGapPrice(p).padEnd(16)}` : chalk.gray("-".padEnd(17));

    console.log(
      `  ${chalk.white.bold(s.symbol.padEnd(10))} ` +
        `${fmtP(s.pacPrice)} ` +
        `${fmtP(s.hlPrice)} ` +
        `${fmtP(s.ltPrice)} ` +
        `${gapColor("$" + s.maxGap.toFixed(4).padEnd(10))} ` +
        `${gapColor(s.maxGapPct.toFixed(4).padEnd(8) + "%")} ` +
        `${chalk.green(s.cheapest)}→${chalk.red(s.expensive)}`
    );
  }

  const avgGap =
    filtered.reduce((sum, s) => sum + s.maxGapPct, 0) / filtered.length;
  const top = filtered[0];

  console.log(
    chalk.gray(
      `\n  ${filtered.length} pairs | Avg gap: ${avgGap.toFixed(4)}% | Max: ${top.symbol} ${top.maxGapPct.toFixed(4)}%\n`
    )
  );
}

export function printTrackSummary(
  symbol: string,
  samples: { time: string; gap: number; gapPct: number; direction: string }[]
) {
  if (samples.length === 0) {
    console.log(chalk.gray("\n  No samples collected.\n"));
    return;
  }

  const gaps = samples.map((s) => s.gapPct);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const max = Math.max(...gaps);
  const min = Math.min(...gaps);
  const maxSample = samples[gaps.indexOf(max)];

  // Count direction frequencies
  const dirCounts = new Map<string, number>();
  for (const s of samples) {
    dirCounts.set(s.direction, (dirCounts.get(s.direction) ?? 0) + 1);
  }

  console.log(chalk.cyan.bold(`\n  ${symbol} Gap Summary (${samples.length} samples)\n`));
  console.log(`  Avg gap:    ${avg.toFixed(4)}%`);
  console.log(`  Max gap:    ${max.toFixed(4)}% at ${maxSample.time}`);
  console.log(`  Min gap:    ${min.toFixed(4)}%`);
  for (const [dir, count] of [...dirCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dir.padEnd(10)} ${count} times (${((count / samples.length) * 100).toFixed(0)}%)`);
  }
  console.log();
}

// ────────────────────────────────────────────────────────
// Funding subcommands (merged from funding.ts)
// ────────────────────────────────────────────────────────

const ALL_EXCHANGES = ["hyperliquid", "pacifica", "lighter"] as const;

function formatAvgRate(rate: number | null | undefined): string {
  if (rate == null) return chalk.gray("-");
  const annualPct = annualizeHourlyRate(rate);
  const color = annualPct > 0 ? chalk.red : annualPct < 0 ? chalk.green : chalk.white;
  return color(`${annualPct.toFixed(1)}%`);
}

/** Short venue label: first alias (or id), upper-cased — e.g. PAC, HL, LT, AST, LRH, ONDO-PERPS. */
function venueAbbr(e: string): string {
  const id = tryResolveVenueId(e);
  if (id === null) return e.toUpperCase();
  const def = getVenue(id);
  return (def.aliases[0] ?? def.id).toUpperCase();
}

function printSnapshotTable(snapshot: FundingRateSnapshot): void {
  const exAbbr = venueAbbr;
  const columns = listVenuesWithRole("marketData");
  if (snapshot.symbols.length === 0) { console.log(chalk.gray("  No funding rate data available.\n")); return; }

  // Build 24h trend: arrow + change in annualized spread
  const now = new Date();
  const h24ago = new Date(now.getTime() - 24 * 3600_000);
  const trendMap = new Map<string, string>(); // symbol → "▲+12.3%" or "▼-5.1%"
  for (const s of snapshot.symbols) {
    const bestEx = s.rates.find(r => r.exchange === "hyperliquid")?.exchange
      ?? s.rates.find(r => r.exchange === "pacifica")?.exchange
      ?? s.rates[0]?.exchange ?? "hyperliquid";
    const history = getHistoricalRates(s.symbol, bestEx, h24ago, now);
    if (history.length >= 2) {
      const oldRate = history[0].hourlyRate;
      const newRate = history[history.length - 1].hourlyRate;
      // Change in annualized rate (hourly × 8760)
      const oldAnn = Math.abs(oldRate) * 8760 * 100;
      const newAnn = Math.abs(newRate) * 8760 * 100;
      const delta = newAnn - oldAnn;
      const absDelta = Math.abs(delta);
      if (absDelta < 1) {
        trendMap.set(s.symbol, chalk.gray(`\u2500 ${absDelta.toFixed(1)}%`));  // ─ stable
      } else if (delta > 0) {
        trendMap.set(s.symbol, chalk.red(`\u25B2+${absDelta.toFixed(1)}%`));   // ▲ rising
      } else {
        trendMap.set(s.symbol, chalk.green(`\u25BC-${absDelta.toFixed(1)}%`)); // ▼ falling
      }
    }
  }

  const rows = snapshot.symbols.map(s => {
    const rateOf = (id: string) => s.rates.find(r => r.exchange === id);
    const spread = s.maxSpreadAnnual;
    const spreadColor = spread === null ? chalk.gray : spread >= 30 ? chalk.green : spread >= 10 ? chalk.yellow : chalk.white;
    // Historical-average source preference: HL, PAC, LT, AST, then whichever venue quoted.
    const bestRate = rateOf("hyperliquid") ?? rateOf("pacifica") ?? rateOf("lighter") ?? rateOf("aster") ?? s.rates[0];
    const trend = trendMap.get(s.symbol) ?? chalk.gray("-");
    return [
      chalk.white.bold(s.symbol),
      ...columns.map(v => {
        const r = rateOf(v.id);
        return r ? formatPercent(r.fundingRate) : chalk.gray("-");
      }),
      // No ranked pair (< 2 verified rows): unverified rates are shown, never ranked.
      spread === null ? chalk.gray("n/a") : spreadColor(`${spread.toFixed(1)}%`), trend,
      spread === null || s.longExchange === null || s.shortExchange === null ? chalk.gray("unranked (unverified)")
        : spread >= 5 ? `${exAbbr(s.shortExchange)}>${exAbbr(s.longExchange)}${s.executable ? "" : chalk.gray(s.readOnlyLegs.length > 0 ? " (read-only)" : " (unverified)")}` : chalk.gray("-"),
      formatAvgRate(bestRate?.historicalAvg?.avg8h), formatAvgRate(bestRate?.historicalAvg?.avg24h), formatAvgRate(bestRate?.historicalAvg?.avg7d),
    ];
  });
  console.log(makeTable(["Symbol", ...columns.map(v => v.apiStatus.kind === "unofficial" ? `${v.displayName}*` : v.displayName), "Spread", "24h", "Direction", "Avg 8h", "Avg 24h", "Avg 7d"], rows));
  console.log(chalk.gray(`\n  ${snapshot.symbols.length} symbols compared across exchanges.\n`));
  const unofficial = columns.filter(v => v.apiStatus.kind === "unofficial");
  if (unofficial.length > 0) console.log(chalk.yellow(`  * ${unofficial.map(v => v.displayName).join(", ")}: UNOFFICIAL API (undocumented, read-only; may change or break). Unverified funding — shown only with --include-unverified.\n`));
}

function printFundingExchangeStatus(snapshot: FundingRateSnapshot): void {
  const statuses = Object.entries(snapshot.exchangeStatus).map(([ex, status]) => {
    const indicator = status === "ok" ? chalk.green("OK") : chalk.red("ERR");
    return `${ex}: ${indicator}`;
  });
  console.log(chalk.gray(`  Exchange status: ${statuses.join("  ")}\n`));
}

function printDetailedComparison(comparison: SymbolFundingComparison): void {
  const exAbbr = venueAbbr;
  console.log(chalk.cyan.bold(`  ${comparison.symbol} Funding Rate Comparison\n`));
  console.log(`  Mark Price: $${formatUsd(comparison.bestMarkPrice)}\n`);
  for (const r of comparison.rates) {
    const compHours = getExchangeCompoundingHours(r.exchange);
    const compoundedReturn = getCompoundedAnnualReturn(r.hourlyRate, compHours);
    const color = r.fundingRate > 0 ? chalk.red : r.fundingRate < 0 ? chalk.green : chalk.white;
    console.log(`  ${chalk.white.bold(exAbbr(r.exchange).padEnd(4))} Raw: ${color(formatPercent(r.fundingRate).padEnd(14))} Hourly: ${(r.hourlyRate * 100).toFixed(6)}%  Annual: ${r.annualizedPct.toFixed(2)}%  APY: ${(compoundedReturn * 100).toFixed(2)}%`);
  }
  if (!isRankedComparison(comparison)) {
    console.log(chalk.yellow(`\n  No ranked pair: fewer than two venues with verified funding (${comparison.unverifiedLegs.join(", ")} unverified — display only, never a long / short leg).\n`));
    return;
  }
  const spreadColor = comparison.maxSpreadAnnual >= 30 ? chalk.green.bold : comparison.maxSpreadAnnual >= 10 ? chalk.yellow : chalk.white;
  console.log(`\n  Max Spread:     ${spreadColor(`${comparison.maxSpreadAnnual.toFixed(1)}%`)} annual`);
  console.log(`  Direction:      Long ${exAbbr(comparison.longExchange)} / Short ${exAbbr(comparison.shortExchange)}${comparison.executable ? "" : chalk.yellow(`  — not executable: ${[
    ...comparison.readOnlyLegs.map(v => `${v} is read-only in perp-cli`),
    ...comparison.unverifiedLegs.map(v => `${v} funding is unverified (display only)`),
  ].join("; ")}`)}`);
  console.log(`  Est. Income:    $${comparison.estHourlyIncomeUsd.toFixed(4)}/hr per $1K notional\n`);
}

// registerFundingSubcommands removed — use 'arb scan --rates/--compare/--history/--positions' instead


// ── Exported handler functions for use by arb-auto.ts scan routing ──

/** One-line stderr notice when rows of unverified-funding venues are shown (--include-unverified). */
function warnUnverifiedFunding(rates: ReadonlyArray<{ exchange: string; fundingVerified: boolean; apiStatus: "official" | "unofficial" }>): void {
  const venues = [...new Set(rates.filter(r => !r.fundingVerified).map(r => r.exchange))];
  if (venues.length > 0) {
    process.stderr.write(`[warn] ${venues.join(", ")}: funding rates are UNVERIFIED (unit not confirmed against funding payments; annualized values overstate venues whose funding accrues only during market hours). Shown on request — not for trading decisions.\n`);
  }
  const unofficial = [...new Set(rates.filter(r => r.apiStatus === "unofficial").map(r => r.exchange))];
  if (unofficial.length > 0) {
    process.stderr.write(`[warn] ${unofficial.join(", ")}: read through an UNOFFICIAL API (undocumented; may change or be blocked without notice). Rows carry apiStatus "unofficial".\n`);
  }
}

export async function handleRates(isJson: () => boolean, opts: { symbol?: string; symbols?: string; all?: boolean; minSpread: string; top?: string; includeUnverified?: boolean }): Promise<void> {
  const minSpread = parseFloat(opts.minSpread);
  let filterSymbols: string[] | undefined;
  if (opts.symbol) filterSymbols = [opts.symbol.toUpperCase()];
  else if (opts.symbols) filterSymbols = opts.symbols.split(",").map(s => s.trim().toUpperCase());
  else if (!opts.all) filterSymbols = TOP_SYMBOLS;
  if (!isJson()) console.log(chalk.cyan("  Fetching funding rates from all exchanges...\n"));
  // With --include-unverified and no symbol filter, show every matched symbol: the default
  // TOP_SYMBOLS list is crypto-only and would hide every market of an equity venue.
  if (opts.includeUnverified === true && !opts.symbol && !opts.symbols) filterSymbols = undefined;
  const snapshot = await fetchAllFundingRates({ symbols: filterSymbols, minSpread, includeUnverified: opts.includeUnverified === true });
  warnUnverifiedFunding(snapshot.symbols.flatMap(s => s.rates));
  // Unverified rates are never written to the funding history (it feeds averages and bots).
  try { const allRates = snapshot.symbols.flatMap(s => s.rates).filter(r => r.fundingVerified); if (allRates.length > 0) saveFundingSnapshot(allRates); } catch { /* non-critical */ }
  if (opts.top) snapshot.symbols = snapshot.symbols.slice(0, parseInt(opts.top));
  if (isJson()) {
    // Enrich with 24h rate history for each symbol
    const now = new Date();
    const h24ago = new Date(now.getTime() - 24 * 3600_000);
    const enriched = snapshot.symbols.map(s => {
      const bestEx = s.rates.find(r => r.exchange === "hyperliquid")?.exchange
        ?? s.rates.find(r => r.exchange === "pacifica")?.exchange
        ?? s.rates[0]?.exchange ?? "hyperliquid";
      const history = getHistoricalRates(s.symbol, bestEx, h24ago, now);
      return { ...s, rateHistory: history.map(h => ({ ts: h.ts, hourlyRate: h.hourlyRate })) };
    });
    // --min never hides rows silently: the threshold and the hidden count are in meta (and data).
    const minMeta = { minSpread: snapshot.minSpread, belowMinSpread: snapshot.belowMinSpread };
    if (process.argv.includes("--ndjson") || process.argv.includes("--fields")) return printJson(jsonOk(enriched, minMeta));
    return printJson(jsonOk({ ...snapshot, symbols: enriched }, minMeta));
  }
  printSnapshotTable(snapshot); printFundingExchangeStatus(snapshot);
  if (snapshot.belowMinSpread > 0) {
    console.log(chalk.gray(`  ${snapshot.belowMinSpread} pair${snapshot.belowMinSpread === 1 ? "" : "s"} below --min ${snapshot.minSpread}% hidden (show them: --min 0)\n`));
  }
}

/**
 * Cross-venue price basis — a PRICE comparison, independent of funding.
 *
 * Venue scope: every venue with the "trading" role (both legs must be executable), whether or not
 * its funding rate is verified; market-data-only venues (e.g. TxFlow) are out. Prices
 * come from each venue's market directory and are grouped by `canonical` symbol with the funding
 * scan's guards (fetchCanonicalPriceGroups): unclassified / ambiguous tickers have no canonical and
 * never pair, and a venue whose mark deviates more than MAX_PRICE_DEVIATION_PCT from the group
 * median is dropped. The chosen cheap / rich pair must itself agree within MAX_PRICE_DEVIATION_PCT:
 * a wider gap is a different asset under the same ticker (BB on Lighter 8.50 vs Aster 0.0091).
 * A venue that fails is reported on stderr and is absent from the scan, never silently empty.
 */
export async function handleBasisScan(isJson: () => boolean, opts: { minBasis: string; symbol?: string }): Promise<void> {
  if (!isJson()) console.log(chalk.cyan("  Fetching prices for basis calculation...\n"));
  const filterSymbol = opts.symbol?.toUpperCase();
  const snapshot = await fetchCanonicalPriceGroups(listVenuesWithRole("trading"), {
    symbols: filterSymbol !== undefined ? [filterSymbol] : undefined, tag: "basis-scan",
  });
  for (const [venue, msg] of Object.entries(snapshot.exchangeErrors)) console.error(`[basis-scan] ${venue} fetch failed: ${msg}`);

  type BasisOpp = { symbol: string; prices: Record<string, number>; priceDiff: number; pctDiff: number; buyOn: string; sellOn: string };
  const opps: BasisOpp[] = [];
  for (const [symbol, priced] of snapshot.groups) {
    if (priced.length < 2) continue;
    let min = priced[0], max = priced[0];
    for (const r of priced) { if (r.markPrice < min.markPrice) min = r; if (r.markPrice > max.markPrice) max = r; }
    if (min.exchange === max.exchange) continue;
    const diff = max.markPrice - min.markPrice; const avgPrice = (max.markPrice + min.markPrice) / 2; const pctDiff = (diff / avgPrice) * 100;
    if (!(pctDiff <= MAX_PRICE_DEVIATION_PCT)) {
      console.error(`[basis-scan] excluded ${symbol} ${min.exchange}↔${max.exchange}: mark gap ${pctDiff.toFixed(1)}% > ${MAX_PRICE_DEVIATION_PCT}% (likely a different asset with the same ticker)`);
      continue;
    }
    if (pctDiff * 365 >= parseFloat(opts.minBasis)) {
      const priceObj: Record<string, number> = {}; for (const r of priced) priceObj[r.exchange] = r.markPrice;
      opps.push({ symbol, prices: priceObj, priceDiff: diff, pctDiff, buyOn: min.exchange, sellOn: max.exchange });
    }
  }
  opps.sort((a, b) => b.pctDiff - a.pctDiff);
  if (isJson()) return printJson(jsonOk(opps));
  if (opps.length === 0) { console.log(chalk.gray(`  No basis opportunities above ${opts.minBasis}% threshold.\n`)); return; }
  console.log(chalk.cyan.bold("  Cross-Exchange Basis Opportunities\n"));
  console.log(chalk.gray("  Strategy: Buy cheap, sell expensive, profit from convergence.\n"));
  const rows = opps.map((o) => [
    chalk.white.bold(o.symbol),
    `$${formatUsd(o.prices[o.buyOn])}`,
    `$${formatUsd(o.prices[o.sellOn])}`,
    `$${formatUsd(o.priceDiff)}`, `${o.pctDiff.toFixed(4)}%`, chalk.green(o.buyOn), chalk.red(o.sellOn),
    chalk.gray(String(Object.keys(o.prices).length)),
  ]);
  console.log(makeTable(["Symbol", "Buy Price", "Sell Price", "Diff", "Basis %", "Buy On", "Sell On", "Venues"], rows));
}

export async function handleDexScan(isJson: () => boolean, opts: { minSpread: string; maxGap: string; includeNative: boolean; top: string }): Promise<void> {
  if (!isJson()) console.log(chalk.cyan("  Scanning HIP-3 deployed dex funding spreads...\n"));
  const { pairs, failedDexes } = await scanDexArb({ minAnnualSpread: parseFloat(opts.minSpread), maxPriceGapPct: parseFloat(opts.maxGap), includeNative: opts.includeNative });
  // A dex whose read failed is reported (stderr, both modes — JSON stdout keeps its shape); its pairs are unknown, not absent.
  for (const [dex, msg] of Object.entries(failedDexes)) process.stderr.write(`[dex-scan] HIP-3 dex ${dex} unavailable: ${msg} — its pairs are missing from this scan\n`);
  const topN = parseInt(opts.top); const shown = pairs.slice(0, topN);
  if (isJson()) return printJson(jsonOk(shown.map(p => ({
    underlying: p.underlying, longDex: p.long.dex, longSymbol: p.long.raw, longFunding: p.long.fundingRate,
    longPrice: p.long.markPrice, longOiUsd: p.long.openInterest * p.long.markPrice, longVolume24h: p.long.volume24h,
    shortDex: p.short.dex, shortSymbol: p.short.raw, shortFunding: p.short.fundingRate, shortPrice: p.short.markPrice,
    shortOiUsd: p.short.openInterest * p.short.markPrice, shortVolume24h: p.short.volume24h,
    annualSpread: p.annualSpread, priceGapPct: p.priceGapPct, minOiUsd: p.minOiUsd, minVolume24hUsd: p.minVolume24hUsd, viability: p.viability,
  }))));
  if (shown.length === 0) { console.log(chalk.gray(`  No cross-dex opportunities above ${opts.minSpread}% annual spread.\n`)); return; }
  console.log(chalk.cyan.bold("  HIP-3 Cross-Dex Funding Arb Opportunities\n"));
  console.log(chalk.gray("  Strategy: Long on low-funding dex, Short on high-funding dex (same underlying)\n"));
  const rows = shown.map((p) => {
    const spreadColor = p.annualSpread >= 50 ? chalk.green.bold : p.annualSpread >= 20 ? chalk.green : chalk.yellow;
    const viabilityColor = p.viability === "A" ? chalk.green.bold : p.viability === "B" ? chalk.green : p.viability === "C" ? chalk.yellow : chalk.red;
    const fmtOi = p.minOiUsd >= 1_000_000 ? `$${(p.minOiUsd / 1_000_000).toFixed(1)}M` : p.minOiUsd >= 1_000 ? `$${(p.minOiUsd / 1_000).toFixed(0)}K` : `$${p.minOiUsd.toFixed(0)}`;
    const fmtVol = p.minVolume24hUsd >= 1_000_000 ? `$${(p.minVolume24hUsd / 1_000_000).toFixed(1)}M` : p.minVolume24hUsd >= 1_000 ? `$${(p.minVolume24hUsd / 1_000).toFixed(0)}K` : `$${p.minVolume24hUsd.toFixed(0)}`;
    return [chalk.white.bold(p.underlying), `${p.long.dex}:${p.long.base}`, formatPercent(p.long.fundingRate), `${p.short.dex}:${p.short.base}`, formatPercent(p.short.fundingRate), `$${formatUsd(p.long.markPrice)}`, spreadColor(`${p.annualSpread.toFixed(1)}%`), p.priceGapPct < 0.1 ? chalk.green(`${p.priceGapPct.toFixed(3)}%`) : chalk.yellow(`${p.priceGapPct.toFixed(3)}%`), viabilityColor(p.viability), viabilityColor(fmtOi), chalk.gray(fmtVol)];
  });
  console.log(makeTable(["Asset", "Long On", "L.Fund", "Short On", "S.Fund", "Price", "Ann.Spread", "Gap", "Grade", "MinOI", "MinVol"], rows));
  const dexes = new Set<string>(); for (const p of shown) { dexes.add(p.long.dex); dexes.add(p.short.dex); }
  const gradeCount = { A: 0, B: 0, C: 0, D: 0 }; for (const p of shown) gradeCount[p.viability]++;
  console.log(chalk.gray(`\n  ${shown.length}/${pairs.length} opportunities | Dexes: ${[...dexes].sort().join(", ")}`));
  console.log(chalk.gray(`  Grade: ${chalk.green.bold(`A(${gradeCount.A})`)} ${chalk.green(`B(${gradeCount.B})`)} ${chalk.yellow(`C(${gradeCount.C})`)} ${chalk.red(`D(${gradeCount.D})`)}`));
  console.log(chalk.gray(`  A: OI>$1M  B: OI>$100K  C: OI>$10K  D: OI<$10K (thin — high risk)`));
  console.log(chalk.gray(`  Note: HIP-3 dexes charge 2x fees. Factor into net profitability.\n`));
}

export async function handleCompare(isJson: () => boolean, symbol: string, includeUnverified = false): Promise<void> {
  if (!isJson()) console.log(chalk.cyan(`  Fetching funding rates for ${symbol.toUpperCase()}...\n`));
  const comparison = await fetchSymbolFundingRates(symbol, includeUnverified);
  if (comparison) warnUnverifiedFunding(comparison.rates);
  if (!comparison) {
    // A venue ticker whose canonical symbol differs (Variational US500-PERP = SPY): say where to look.
    const hint = (await import("../exchanges/variational/public.js")).canonicalHintFor(symbol);
    if (isJson()) return printJson(jsonOk({ symbol: symbol.toUpperCase(), available: false, ...(hint !== null ? { hint } : {}) }));
    console.log(chalk.gray(`  ${symbol.toUpperCase()} not found on at least 2 exchanges.\n`));
    if (hint !== null) console.log(chalk.yellow(`  Hint: ${hint}\n`));
    return;
  }
  if (isJson()) return printJson(jsonOk(comparison));
  printDetailedComparison(comparison);
}

export async function handleFundingHistory(isJson: () => boolean, opts: { symbol: string; hours: string; exchange?: string }): Promise<void> {
  const symbol = opts.symbol.toUpperCase(); const hours = parseInt(opts.hours);
  const exchanges = opts.exchange ? [opts.exchange.toLowerCase()] : ["hyperliquid", "pacifica", "lighter"];
  const endTime = new Date(); const startTime = new Date(endTime.getTime() - hours * 3600000);
  if (isJson()) {
    const data: Record<string, { ts: string; rate: number; hourlyRate: number }[]> = {};
    for (const ex of exchanges) { const rates = getHistoricalRates(symbol, ex, startTime, endTime); if (rates.length > 0) data[ex] = rates; }
    return printJson(jsonOk({ symbol, hours, startTime: startTime.toISOString(), endTime: endTime.toISOString(), rates: data }));
  }
  console.log(chalk.cyan.bold(`  ${symbol} Funding Rate History (last ${hours}h)\n`));
  const exAbbr = venueAbbr;
  let hasData = false;
  for (const ex of exchanges) {
    const rates = getHistoricalRates(symbol, ex, startTime, endTime); if (rates.length === 0) continue; hasData = true;
    console.log(chalk.white.bold(`  ${exAbbr(ex)} (${rates.length} snapshots):`));
    const rows = rates.map(r => { const color = r.rate > 0 ? chalk.red : r.rate < 0 ? chalk.green : chalk.white; return [chalk.gray(new Date(r.ts).toLocaleString()), color(formatPercent(r.rate)), `${(r.hourlyRate * 100).toFixed(6)}%/h`, `${annualizeHourlyRate(r.hourlyRate).toFixed(2)}%/yr`]; });
    console.log(makeTable(["Time", "Raw Rate", "Hourly", "Annualized"], rows)); console.log();
  }
  if (!hasData) console.log(chalk.gray(`  No historical data. Run 'perp arb rates' to start collecting.\n`));
}

export async function handleFundingPositions(
  isJson: () => boolean,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  opts: { exchanges?: string },
): Promise<void> {
  await withJsonErrors(isJson(), async () => {
    const targetExchanges = opts.exchanges ? opts.exchanges.split(",").map(s => s.trim().toLowerCase()) : [...ALL_EXCHANGES];
    if (!isJson()) console.log(chalk.cyan("  Fetching positions and funding rates...\n"));
    interface PF { exchange: string; symbol: string; side: "long"|"short"; size: string; entryPrice: string; markPrice: string; unrealizedPnl: string; leverage: number; notionalUsd: number; fundingRate: number; hourlyRate: number; annualPct: number; hourlyPayment: number; dailyPayment: number; actualReceived24h: number | null; actualPaid24h: number | null; actualNet24h: number | null; }
    const results: PF[] = []; const exchangeErrors: Record<string, string> = {}; const fundingUnknown: string[] = [];
    /* venue → why its funding history could not be read; its positions get actual* = null (never 0) */ const fundingHistoryErrors: Record<string, string> = {};
    await Promise.all(targetExchanges.map(async (exchange) => {
      try {
        const adapter = await getAdapterForExchange(exchange);
        const [positions, markets, fp] = await Promise.all([adapter.getPositions(), adapter.getMarkets(), adapter.getFundingPayments(100).then((rows) => rows, (e: unknown) => { fundingHistoryErrors[exchange] = e instanceof Error ? e.message : String(e); return null; })]);
        if (positions.length === 0) return;
        /* rate null = the venue reports no funding rate for the market (never read as 0) */ const fm = new Map<string, { rate: number | null; markPrice: number; fundingHours: number | null }>(); for (const m of markets) { const sym = m.symbol.toUpperCase().replace(/-PERP$/, ""); const rate = m.fundingRate === null || !Number.isFinite(Number(m.fundingRate)) ? null : Number(m.fundingRate); fm.set(sym, { rate, markPrice: Number(m.markPrice) || 0, fundingHours: m.fundingHours }); }
        const dayAgo = Date.now() - 86400000; const af = new Map<string, { received: number; paid: number }>(); for (const f of fp ?? []) { if (f.time < dayAgo) continue; const sym = f.symbol.toUpperCase().replace(/-PERP$/, ""); const amt = Number(f.payment); if (!Number.isFinite(amt)) { fundingHistoryErrors[exchange] = `non-numeric funding payment ${JSON.stringify(f.payment)}`; continue; } if (!af.has(sym)) af.set(sym, { received: 0, paid: 0 }); const e = af.get(sym)!; if (amt > 0) e.received += amt; else e.paid += Math.abs(amt); }
        /* a venue whose history was unreadable or had an unparsable row: actual* = null (never a partial sum shown as complete) */ const histBad = fp === null || fundingHistoryErrors[exchange] !== undefined; for (const pos of positions) { const sym = pos.symbol.toUpperCase().replace(/-PERP$/, ""); const fd = fm.get(sym); if (fd === undefined || fd.rate === null) { fundingUnknown.push(`${exchange}:${sym}`); continue; } const fr = fd.rate; const posMark = Number(pos.markPrice); const mk = Number.isFinite(posMark) && posMark > 0 ? posMark : fd.markPrice; if (!(mk > 0)) { fundingUnknown.push(`${exchange}:${sym} (no mark price)`); continue; } const sz = Math.abs(Number(pos.size)); const nu = sz * mk; const fh = fd ? fd.fundingHours : null; /* market basis first */ const hr = fh !== null ? fr / fh : toHourlyRate(fr, exchange); const ap = annualizeHourlyRate(hr); const hp = estimateHourlyFundingFromHourly(hr, nu, pos.side); const a = af.get(sym); results.push({ exchange, symbol: sym, side: pos.side, size: pos.size, entryPrice: pos.entryPrice, markPrice: pos.markPrice, unrealizedPnl: pos.unrealizedPnl, leverage: pos.leverage, notionalUsd: nu, fundingRate: fr, hourlyRate: hr, annualPct: ap, hourlyPayment: hp, dailyPayment: hp * 24, actualReceived24h: histBad ? null : a?.received ?? 0, actualPaid24h: histBad ? null : a?.paid ?? 0, actualNet24h: histBad ? null : (a?.received ?? 0) - (a?.paid ?? 0) }); }
      } catch (err) { exchangeErrors[exchange] = err instanceof Error ? err.message : String(err); }
    }));
    if (results.length === 0) { if (isJson()) return printJson(jsonOk({ positions: [], totals: { predicted: { hourly: 0, daily: 0 }, actual24h: { net: 0 }, notionalUsd: 0 }, fundingUnknown, errors: exchangeErrors })); console.log(chalk.gray(fundingUnknown.length > 0 ? `  No positions with a published funding rate (funding unknown: ${fundingUnknown.join(", ")}).\n` : "  No open positions.\n")); return; }
    results.sort((a, b) => Math.abs(b.dailyPayment) - Math.abs(a.dailyPayment));
    const tH = results.reduce((s, r) => s + r.hourlyPayment, 0); const tD = results.reduce((s, r) => s + r.dailyPayment, 0); const tN = results.reduce((s, r) => s + r.notionalUsd, 0); const tA = results.reduce((s, r) => s + (r.actualNet24h ?? 0), 0); const actualIncomplete = results.some(r => r.actualNet24h === null);
    if (isJson()) return printJson(jsonOk({ positions: results.map(r => ({ exchange: r.exchange, symbol: r.symbol, side: r.side, size: r.size, notionalUsd: +r.notionalUsd.toFixed(2), fundingRate: r.fundingRate, annualPct: +r.annualPct.toFixed(2), predicted: { hourly: +r.hourlyPayment.toFixed(6), daily: +r.dailyPayment.toFixed(4) }, actual24h: r.actualNet24h === null ? null : { received: +(r.actualReceived24h ?? 0).toFixed(6), paid: +(r.actualPaid24h ?? 0).toFixed(6), net: +r.actualNet24h.toFixed(6) }, unrealizedPnl: r.unrealizedPnl })), totals: { predicted: { hourly: +tH.toFixed(6), daily: +tD.toFixed(4) }, actual24h: { net: +tA.toFixed(6), incomplete: actualIncomplete }, notionalUsd: +tN.toFixed(2) }, fundingUnknown, fundingHistoryErrors, errors: Object.keys(exchangeErrors).length > 0 ? exchangeErrors : undefined }));
    const exAbbr = venueAbbr;
    console.log(chalk.cyan.bold("  Position Funding Impact\n"));
    const rows = results.map(r => { const sc = r.side === "long" ? chalk.green : chalk.red; const rc = r.fundingRate > 0 ? chalk.red : r.fundingRate < 0 ? chalk.green : chalk.white; const as = r.actualNet24h === null ? chalk.yellow("unavailable") : r.actualNet24h !== 0 ? (r.actualNet24h > 0 ? chalk.green : chalk.red)(`${r.actualNet24h > 0 ? "+" : ""}$${r.actualNet24h.toFixed(4)}`) : chalk.gray("-"); return [chalk.white.bold(exAbbr(r.exchange)), chalk.white.bold(r.symbol), sc(r.side.toUpperCase()), `$${formatUsd(r.notionalUsd)}`, rc(formatPercent(r.fundingRate)), rc(`${r.annualPct.toFixed(1)}%`), as, formatPnl(r.unrealizedPnl)]; });
    console.log(makeTable(["Ex", "Symbol", "Side", "Notional", "Rate(now)", "Annual(now)", "Actual 24h", "uPnL"], rows));
    console.log(`\n  Total: $${formatUsd(tN)} | Actual 24h: ${tA >= 0 ? "+" : ""}$${tA.toFixed(4)} | Predicted: ${tD >= 0 ? "-" : "+"}$${Math.abs(tD).toFixed(4)}/d\n`);
    if (fundingUnknown.length > 0) console.log(chalk.yellow(`  Funding rate not published (excluded, not counted as 0): ${fundingUnknown.join(", ")}\n`));
    for (const [ex, msg] of Object.entries(fundingHistoryErrors)) console.log(chalk.yellow(`  ${ex} funding history unavailable (Actual 24h excluded, not 0): ${msg}`));
  });
}
