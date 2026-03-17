import { Command } from "commander";
import { makeTable, formatUsd, formatPercent, formatPnl, printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import chalk from "chalk";
import { annualizeRate, computeAnnualSpread, toHourlyRate, estimateHourlyFunding, annualizeHourlyRate } from "../funding.js";
import {
  fetchAllFundingRates,
  fetchSymbolFundingRates,
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
import type { ExchangeAdapter } from "../exchanges/interface.js";
import {
  fetchPacificaPrices, fetchHyperliquidMeta,
  fetchLighterOrderBookDetails, fetchLighterFundingRates,
  fetchPacificaPricesRaw, parsePacificaRaw,
  fetchHyperliquidAllMidsRaw,
  fetchLighterOrderBookDetailsRaw,
} from "../shared-api.js";
import { scanDexArb } from "../dex-asset-map.js";

interface FundingRate {
  exchange: string;
  symbol: string;
  fundingRate: number;
  markPrice: number;
  nextFunding?: number;
}

async function fetchPacificaRates(): Promise<FundingRate[]> {
  const assets = await fetchPacificaPrices();
  return assets.map(p => ({
    exchange: "pacifica",
    symbol: p.symbol,
    fundingRate: p.funding,
    markPrice: p.mark,
    nextFunding: p.nextFunding ?? 0,
  }));
}

async function fetchHyperliquidRates(): Promise<FundingRate[]> {
  const assets = await fetchHyperliquidMeta();
  return assets.map(a => ({
    exchange: "hyperliquid",
    symbol: a.symbol,
    fundingRate: a.funding,
    markPrice: a.markPx,
  }));
}

async function fetchLighterRates(): Promise<FundingRate[]> {
  try {
    const [details, funding] = await Promise.all([
      fetchLighterOrderBookDetails(),
      fetchLighterFundingRates(),
    ]);

    const priceMap = new Map(details.map(d => [d.marketId, d.lastTradePrice]));
    const symMap = new Map(details.map(d => [d.marketId, d.symbol]));

    const rates: FundingRate[] = [];
    for (const fr of funding) {
      const symbol = fr.symbol || symMap.get(fr.marketId);
      if (!symbol) continue;
      rates.push({
        exchange: "lighter",
        symbol,
        fundingRate: fr.rate,
        markPrice: fr.markPrice || priceMap.get(fr.marketId) || 0,
      });
    }
    return rates;
  } catch {
    return [];
  }
}

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
  const [pacRes, hlRes, ltRes] = await Promise.all([
    fetchPacificaPricesRaw(),
    fetchHyperliquidAllMidsRaw(),
    fetchLighterOrderBookDetailsRaw(),
  ]);

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

  const allSymbols = new Set([...pacPrices.keys(), ...hlPrices.keys(), ...ltPrices.keys()]);
  const snapshots: PriceSnapshot[] = [];

  for (const sym of allSymbols) {
    const pac = pacPrices.get(sym) ?? null;
    const hl = hlPrices.get(sym) ?? null;
    const lt = ltPrices.get(sym) ?? null;

    // Need at least 2 exchanges
    const available: { ex: string; price: number }[] = [];
    if (pac !== null) available.push({ ex: "PAC", price: pac });
    if (hl !== null) available.push({ ex: "HL", price: hl });
    if (lt !== null) available.push({ ex: "LT", price: lt });
    if (available.length < 2) continue;

    available.sort((a, b) => a.price - b.price);
    const cheapest = available[0];
    const expensive = available[available.length - 1];
    const maxGap = expensive.price - cheapest.price;
    const mid = (cheapest.price + expensive.price) / 2;
    const maxGapPct = mid > 0 ? (maxGap / mid) * 100 : 0;

    snapshots.push({
      symbol: sym,
      pacPrice: pac,
      hlPrice: hl,
      ltPrice: lt,
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

function printSnapshotTable(snapshot: FundingRateSnapshot): void {
  const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
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
    const pacRate = s.rates.find(r => r.exchange === "pacifica");
    const hlRate = s.rates.find(r => r.exchange === "hyperliquid");
    const ltRate = s.rates.find(r => r.exchange === "lighter");
    const spreadColor = s.maxSpreadAnnual >= 30 ? chalk.green : s.maxSpreadAnnual >= 10 ? chalk.yellow : chalk.white;
    const bestRate = hlRate ?? pacRate ?? ltRate;
    const trend = trendMap.get(s.symbol) ?? chalk.gray("-");
    return [
      chalk.white.bold(s.symbol), pacRate ? formatPercent(pacRate.fundingRate) : chalk.gray("-"),
      hlRate ? formatPercent(hlRate.fundingRate) : chalk.gray("-"), ltRate ? formatPercent(ltRate.fundingRate) : chalk.gray("-"),
      spreadColor(`${s.maxSpreadAnnual.toFixed(1)}%`), trend,
      s.maxSpreadAnnual >= 5 ? `${exAbbr(s.shortExchange)}>${exAbbr(s.longExchange)}` : chalk.gray("-"),
      formatAvgRate(bestRate?.historicalAvg?.avg8h), formatAvgRate(bestRate?.historicalAvg?.avg24h), formatAvgRate(bestRate?.historicalAvg?.avg7d),
    ];
  });
  console.log(makeTable(["Symbol", "Pacifica", "Hyperliquid", "Lighter", "Spread", "24h", "Direction", "Avg 8h", "Avg 24h", "Avg 7d"], rows));
  console.log(chalk.gray(`\n  ${snapshot.symbols.length} symbols compared across exchanges.\n`));
}

function printFundingExchangeStatus(snapshot: FundingRateSnapshot): void {
  const statuses = Object.entries(snapshot.exchangeStatus).map(([ex, status]) => {
    const indicator = status === "ok" ? chalk.green("OK") : chalk.red("ERR");
    return `${ex}: ${indicator}`;
  });
  console.log(chalk.gray(`  Exchange status: ${statuses.join("  ")}\n`));
}

function printDetailedComparison(comparison: SymbolFundingComparison): void {
  const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
  console.log(chalk.cyan.bold(`  ${comparison.symbol} Funding Rate Comparison\n`));
  console.log(`  Mark Price: $${formatUsd(comparison.bestMarkPrice)}\n`);
  for (const r of comparison.rates) {
    const compHours = getExchangeCompoundingHours(r.exchange);
    const compoundedReturn = getCompoundedAnnualReturn(r.hourlyRate, compHours);
    const color = r.fundingRate > 0 ? chalk.red : r.fundingRate < 0 ? chalk.green : chalk.white;
    console.log(`  ${chalk.white.bold(exAbbr(r.exchange).padEnd(4))} Raw: ${color(formatPercent(r.fundingRate).padEnd(14))} Hourly: ${(r.hourlyRate * 100).toFixed(6)}%  Annual: ${r.annualizedPct.toFixed(2)}%  APY: ${(compoundedReturn * 100).toFixed(2)}%`);
  }
  const spreadColor = comparison.maxSpreadAnnual >= 30 ? chalk.green.bold : comparison.maxSpreadAnnual >= 10 ? chalk.yellow : chalk.white;
  console.log(`\n  Max Spread:     ${spreadColor(`${comparison.maxSpreadAnnual.toFixed(1)}%`)} annual`);
  console.log(`  Direction:      Long ${exAbbr(comparison.longExchange)} / Short ${exAbbr(comparison.shortExchange)}`);
  console.log(`  Est. Income:    $${comparison.estHourlyIncomeUsd.toFixed(4)}/hr per $1K notional\n`);
}

// registerFundingSubcommands removed — use 'arb scan --rates/--compare/--history/--positions' instead


// ── Exported handler functions for use by arb-auto.ts scan routing ──

export async function handleRates(isJson: () => boolean, opts: { symbol?: string; symbols?: string; all?: boolean; minSpread: string }): Promise<void> {
  const minSpread = parseFloat(opts.minSpread);
  let filterSymbols: string[] | undefined;
  if (opts.symbol) filterSymbols = [opts.symbol.toUpperCase()];
  else if (opts.symbols) filterSymbols = opts.symbols.split(",").map(s => s.trim().toUpperCase());
  else if (!opts.all) filterSymbols = TOP_SYMBOLS;
  if (!isJson()) console.log(chalk.cyan("  Fetching funding rates from all exchanges...\n"));
  const snapshot = await fetchAllFundingRates({ symbols: filterSymbols, minSpread });
  try { const allRates = snapshot.symbols.flatMap(s => s.rates); if (allRates.length > 0) saveFundingSnapshot(allRates); } catch { /* non-critical */ }
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
    if (process.argv.includes("--ndjson") || process.argv.includes("--fields")) return printJson(jsonOk(enriched));
    return printJson(jsonOk({ ...snapshot, symbols: enriched }));
  }
  printSnapshotTable(snapshot); printFundingExchangeStatus(snapshot);
}

export async function handleBasisScan(isJson: () => boolean, opts: { minBasis: string; symbol?: string }): Promise<void> {
  if (!isJson()) console.log(chalk.cyan("  Fetching prices for basis calculation...\n"));
  const [pacRates, hlRates, ltRates] = await Promise.all([fetchPacificaRates(), fetchHyperliquidRates(), fetchLighterRates()]);
  const exchangePrices = new Map<string, Map<string, number>>();
  const filterSymbol = opts.symbol?.toUpperCase();
  for (const r of [...pacRates, ...hlRates, ...ltRates]) {
    if (r.markPrice <= 0) continue;
    if (filterSymbol && r.symbol.toUpperCase() !== filterSymbol) continue;
    if (!exchangePrices.has(r.symbol)) exchangePrices.set(r.symbol, new Map());
    exchangePrices.get(r.symbol)!.set(r.exchange, r.markPrice);
  }
  type BasisOpp = { symbol: string; prices: Record<string, number>; priceDiff: number; pctDiff: number; buyOn: string; sellOn: string };
  const opps: BasisOpp[] = [];
  for (const [symbol, prices] of exchangePrices.entries()) {
    if (prices.size < 2) continue;
    let minEx = "", maxEx = "", minPrice = Infinity, maxPrice = 0;
    for (const [ex, price] of prices) { if (price < minPrice) { minPrice = price; minEx = ex; } if (price > maxPrice) { maxPrice = price; maxEx = ex; } }
    if (minEx === maxEx) continue;
    const diff = maxPrice - minPrice; const avgPrice = (maxPrice + minPrice) / 2; const pctDiff = (diff / avgPrice) * 100;
    if (pctDiff * 365 >= parseFloat(opts.minBasis)) {
      const priceObj: Record<string, number> = {}; for (const [ex, p] of prices) priceObj[ex] = p;
      opps.push({ symbol, prices: priceObj, priceDiff: diff, pctDiff, buyOn: minEx, sellOn: maxEx });
    }
  }
  opps.sort((a, b) => b.pctDiff - a.pctDiff);
  if (isJson()) return printJson(jsonOk(opps));
  if (opps.length === 0) { console.log(chalk.gray(`  No basis opportunities above ${opts.minBasis}% threshold.\n`)); return; }
  console.log(chalk.cyan.bold("  Cross-Exchange Basis Opportunities\n"));
  console.log(chalk.gray("  Strategy: Buy cheap, sell expensive, profit from convergence.\n"));
  const rows = opps.map((o) => [
    chalk.white.bold(o.symbol),
    o.prices.pacifica ? `$${formatUsd(o.prices.pacifica)}` : chalk.gray("-"),
    o.prices.hyperliquid ? `$${formatUsd(o.prices.hyperliquid)}` : chalk.gray("-"),
    o.prices.lighter ? `$${formatUsd(o.prices.lighter)}` : chalk.gray("-"),
    `$${formatUsd(o.priceDiff)}`, `${o.pctDiff.toFixed(4)}%`, chalk.green(o.buyOn), chalk.red(o.sellOn),
  ]);
  console.log(makeTable(["Symbol", "Pacifica", "Hyperliquid", "Lighter", "Diff", "Basis %", "Buy On", "Sell On"], rows));
}

export async function handleDexScan(isJson: () => boolean, opts: { minSpread: string; maxGap: string; includeNative: boolean; top: string }): Promise<void> {
  if (!isJson()) console.log(chalk.cyan("  Scanning HIP-3 deployed dex funding spreads...\n"));
  const pairs = await scanDexArb({ minAnnualSpread: parseFloat(opts.minSpread), maxPriceGapPct: parseFloat(opts.maxGap), includeNative: opts.includeNative });
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

export async function handleCompare(isJson: () => boolean, symbol: string): Promise<void> {
  if (!isJson()) console.log(chalk.cyan(`  Fetching funding rates for ${symbol.toUpperCase()}...\n`));
  const comparison = await fetchSymbolFundingRates(symbol);
  if (!comparison) { if (isJson()) return printJson(jsonOk({ symbol: symbol.toUpperCase(), available: false })); console.log(chalk.gray(`  ${symbol.toUpperCase()} not found on at least 2 exchanges.\n`)); return; }
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
  const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
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
    interface PF { exchange: string; symbol: string; side: "long"|"short"; size: string; entryPrice: string; markPrice: string; unrealizedPnl: string; leverage: number; notionalUsd: number; fundingRate: number; hourlyRate: number; annualPct: number; hourlyPayment: number; dailyPayment: number; actualReceived24h: number; actualPaid24h: number; actualNet24h: number; }
    const results: PF[] = []; const exchangeErrors: Record<string, string> = {};
    await Promise.all(targetExchanges.map(async (exchange) => {
      try {
        const adapter = await getAdapterForExchange(exchange);
        const [positions, markets, fp] = await Promise.all([adapter.getPositions(), adapter.getMarkets(), adapter.getFundingPayments(100).catch(() => [] as { time: number; symbol: string; payment: string }[])]);
        if (positions.length === 0) return;
        const fm = new Map<string, { rate: number; markPrice: number }>(); for (const m of markets) { const sym = m.symbol.toUpperCase().replace(/-PERP$/, ""); fm.set(sym, { rate: Number(m.fundingRate) || 0, markPrice: Number(m.markPrice) || 0 }); }
        const dayAgo = Date.now() - 86400000; const af = new Map<string, { received: number; paid: number }>(); for (const f of fp) { if (f.time < dayAgo) continue; const sym = f.symbol.toUpperCase().replace(/-PERP$/, ""); const amt = Number(f.payment) || 0; if (!af.has(sym)) af.set(sym, { received: 0, paid: 0 }); const e = af.get(sym)!; if (amt > 0) e.received += amt; else e.paid += Math.abs(amt); }
        for (const pos of positions) { const sym = pos.symbol.toUpperCase().replace(/-PERP$/, ""); const fd = fm.get(sym); const fr = fd?.rate ?? 0; const mk = Number(pos.markPrice) || fd?.markPrice || 0; const sz = Math.abs(Number(pos.size)); const nu = sz * mk; const hr = toHourlyRate(fr, exchange); const ap = annualizeRate(fr, exchange); const hp = estimateHourlyFunding(fr, exchange, nu, pos.side); const a = af.get(sym); results.push({ exchange, symbol: sym, side: pos.side, size: pos.size, entryPrice: pos.entryPrice, markPrice: pos.markPrice, unrealizedPnl: pos.unrealizedPnl, leverage: pos.leverage, notionalUsd: nu, fundingRate: fr, hourlyRate: hr, annualPct: ap, hourlyPayment: hp, dailyPayment: hp * 24, actualReceived24h: a?.received ?? 0, actualPaid24h: a?.paid ?? 0, actualNet24h: (a?.received ?? 0) - (a?.paid ?? 0) }); }
      } catch (err) { exchangeErrors[exchange] = err instanceof Error ? err.message : String(err); }
    }));
    if (results.length === 0) { if (isJson()) return printJson(jsonOk({ positions: [], totals: { predicted: { hourly: 0, daily: 0 }, actual24h: { net: 0 }, notionalUsd: 0 }, errors: exchangeErrors })); console.log(chalk.gray("  No open positions.\n")); return; }
    results.sort((a, b) => Math.abs(b.dailyPayment) - Math.abs(a.dailyPayment));
    const tH = results.reduce((s, r) => s + r.hourlyPayment, 0); const tD = results.reduce((s, r) => s + r.dailyPayment, 0); const tN = results.reduce((s, r) => s + r.notionalUsd, 0); const tA = results.reduce((s, r) => s + r.actualNet24h, 0);
    if (isJson()) return printJson(jsonOk({ positions: results.map(r => ({ exchange: r.exchange, symbol: r.symbol, side: r.side, size: r.size, notionalUsd: +r.notionalUsd.toFixed(2), fundingRate: r.fundingRate, annualPct: +r.annualPct.toFixed(2), predicted: { hourly: +r.hourlyPayment.toFixed(6), daily: +r.dailyPayment.toFixed(4) }, actual24h: { received: +r.actualReceived24h.toFixed(6), paid: +r.actualPaid24h.toFixed(6), net: +r.actualNet24h.toFixed(6) }, unrealizedPnl: r.unrealizedPnl })), totals: { predicted: { hourly: +tH.toFixed(6), daily: +tD.toFixed(4) }, actual24h: { net: +tA.toFixed(6) }, notionalUsd: +tN.toFixed(2) }, errors: Object.keys(exchangeErrors).length > 0 ? exchangeErrors : undefined }));
    const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e.toUpperCase();
    console.log(chalk.cyan.bold("  Position Funding Impact\n"));
    const rows = results.map(r => { const sc = r.side === "long" ? chalk.green : chalk.red; const rc = r.fundingRate > 0 ? chalk.red : r.fundingRate < 0 ? chalk.green : chalk.white; const as = r.actualNet24h !== 0 ? (r.actualNet24h > 0 ? chalk.green : chalk.red)(`${r.actualNet24h > 0 ? "+" : ""}$${r.actualNet24h.toFixed(4)}`) : chalk.gray("-"); return [chalk.white.bold(exAbbr(r.exchange)), chalk.white.bold(r.symbol), sc(r.side.toUpperCase()), `$${formatUsd(r.notionalUsd)}`, rc(formatPercent(r.fundingRate)), rc(`${r.annualPct.toFixed(1)}%`), as, formatPnl(r.unrealizedPnl)]; });
    console.log(makeTable(["Ex", "Symbol", "Side", "Notional", "Rate(now)", "Annual(now)", "Actual 24h", "uPnL"], rows));
    console.log(`\n  Total: $${formatUsd(tN)} | Actual 24h: ${tA >= 0 ? "+" : ""}$${tA.toFixed(4)} | Predicted: ${tD >= 0 ? "-" : "+"}$${Math.abs(tD).toFixed(4)}/d\n`);
  });
}
