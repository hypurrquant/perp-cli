import { Command } from "commander";
import { makeTable, formatUsd, formatPercent, formatPnl, printJson, jsonOk } from "../utils.js";
import chalk from "chalk";
import { annualizeRate, computeAnnualSpread, toHourlyRate } from "../funding.js";
import {
  fetchPacificaPrices, fetchHyperliquidMeta,
  fetchLighterOrderBookDetails, fetchLighterFundingRates,
  fetchPacificaPricesRaw, parsePacificaRaw,
  fetchHyperliquidAllMidsRaw,
  fetchLighterOrderBookDetailsRaw,
} from "../shared-api.js";
import { scanDexArb, type DexArbPair } from "../dex-asset-map.js";

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
) {
  const arb = program.command("arb").description("Funding rate arbitrage & basis trading");

  const fundingCmd = arb
    .command("funding")
    .description("Use 'perp funding rates --min-spread 5'");
  (fundingCmd as any)._hidden = true;
  fundingCmd
    .option("-s, --symbol <symbol>", "Filter by symbol")
    .option("--min-spread <pct>", "Minimum annual spread % to show", "5")
    .action(async (opts: { symbol?: string; minSpread: string }) => {
      if (!isJson()) console.log(chalk.yellow("  [Deprecated] Use 'perp funding rates --min-spread 5' instead.\n"));
      if (!isJson()) console.log(chalk.cyan("  Fetching funding rates from all exchanges...\n"));

      const [pacRates, hlRates, ltRates] = await Promise.all([
        fetchPacificaRates(),
        fetchHyperliquidRates(),
        fetchLighterRates(),
      ]);

      // Build rate map by symbol
      const rateMap = new Map<string, FundingRate[]>();
      for (const r of [...pacRates, ...hlRates, ...ltRates]) {
        if (opts.symbol && r.symbol.toUpperCase() !== opts.symbol.toUpperCase()) continue;
        if (!rateMap.has(r.symbol)) rateMap.set(r.symbol, []);
        rateMap.get(r.symbol)!.push(r);
      }

      // Find arb opportunities
      type Opp = {
        symbol: string;
        longExchange: string;
        shortExchange: string;
        longRate: number;
        shortRate: number;
        spread: number;
        annualSpread: number;
        markPrice: number;
      };
      const opportunities: Opp[] = [];

      for (const [symbol, rates] of rateMap.entries()) {
        if (rates.length < 2) continue;

        // Find min and max funding rate exchange (normalize to hourly for comparison)
        rates.sort((a, b) => toHourlyRate(a.fundingRate, a.exchange) - toHourlyRate(b.fundingRate, b.exchange));
        const lowest = rates[0];
        const highest = rates[rates.length - 1];

        if (lowest.exchange === highest.exchange) continue;

        const annualSpread = computeAnnualSpread(
          highest.fundingRate, highest.exchange,
          lowest.fundingRate, lowest.exchange,
        );

        if (annualSpread >= parseFloat(opts.minSpread)) {
          opportunities.push({
            symbol,
            longExchange: lowest.exchange,    // long where funding is lowest (you pay less / receive more)
            shortExchange: highest.exchange,  // short where funding is highest (you receive more / pay less)
            longRate: lowest.fundingRate,
            shortRate: highest.fundingRate,
            spread: toHourlyRate(highest.fundingRate, highest.exchange) - toHourlyRate(lowest.fundingRate, lowest.exchange),
            annualSpread,
            markPrice: highest.markPrice || lowest.markPrice,
          });
        }
      }

      opportunities.sort((a, b) => b.annualSpread - a.annualSpread);

      if (isJson()) return printJson(jsonOk(opportunities));

      if (opportunities.length === 0) {
        console.log(chalk.gray(`  No funding arb opportunities above ${opts.minSpread}% annual spread.\n`));
        return;
      }

      console.log(chalk.cyan.bold("  Funding Rate Arbitrage Opportunities\n"));
      console.log(chalk.gray(`  Strategy: Long on low-funding exchange, Short on high-funding exchange\n`));

      const rows = opportunities.map((o) => [
        chalk.white.bold(o.symbol),
        `$${formatUsd(o.markPrice)}`,
        `${o.longExchange}`,
        formatPercent(o.longRate),
        `${o.shortExchange}`,
        formatPercent(o.shortRate),
        chalk.yellow(`${o.annualSpread.toFixed(1)}%`),
      ]);

      console.log(
        makeTable(
          ["Symbol", "Price", "Long On", "L.Fund", "Short On", "S.Fund", "Ann. Spread"],
          rows
        )
      );

      console.log(chalk.gray("\n  Note: All rates are hourly. Normalized before annualizing.\n"));
    });

  const ratesCmd = arb
    .command("rates")
    .description("Use 'perp funding rates'");
  (ratesCmd as any)._hidden = true;
  ratesCmd
    .option("-s, --symbol <symbol>", "Filter by symbol")
    .action(async (opts: { symbol?: string }) => {
      if (!isJson()) {
        console.log(chalk.yellow("\n  Use 'perp funding rates' instead.\n"));
      }

      // Delegate to the same data source as funding rates
      const [pacRates, hlRates, ltRates] = await Promise.all([
        fetchPacificaRates(),
        fetchHyperliquidRates(),
        fetchLighterRates(),
      ]);

      const pacMap = new Map(pacRates.map((r) => [r.symbol, r]));
      const hlMap = new Map(hlRates.map((r) => [r.symbol, r]));
      const ltMap = new Map(ltRates.map((r) => [r.symbol, r]));

      const allSymbols = new Set([...pacMap.keys(), ...hlMap.keys(), ...ltMap.keys()]);
      const symbols = opts.symbol
        ? [opts.symbol.toUpperCase()]
        : [...allSymbols].sort();

      if (isJson()) {
        const data = symbols.map((s) => ({
          symbol: s,
          pacifica: pacMap.get(s)?.fundingRate ?? null,
          hyperliquid: hlMap.get(s)?.fundingRate ?? null,
          lighter: ltMap.get(s)?.fundingRate ?? null,
          _deprecated: "Use 'perp funding rates' instead",
        }));
        return printJson(jsonOk(data));
      }

      const rows = symbols
        .filter((s) => pacMap.has(s) || hlMap.has(s) || ltMap.has(s))
        .map((s) => {
          const pac = pacMap.get(s);
          const hl = hlMap.get(s);
          const lt = ltMap.get(s);
          const pacRate = pac ? formatPercent(pac.fundingRate) : chalk.gray("-");
          const hlRate = hl ? formatPercent(hl.fundingRate) : chalk.gray("-");
          const ltRate = lt ? formatPercent(lt.fundingRate) : chalk.gray("-");
          const withEx = [
            pac ? { rate: pac.fundingRate, ex: "pacifica" } : null,
            hl ? { rate: hl.fundingRate, ex: "hyperliquid" } : null,
            lt ? { rate: lt.fundingRate, ex: "lighter" } : null,
          ].filter(Boolean) as { rate: number; ex: string }[];
          let annDiff = 0;
          if (withEx.length >= 2) {
            withEx.sort((a, b) => a.rate - b.rate);
            annDiff = computeAnnualSpread(withEx[0].rate, withEx[0].ex, withEx[withEx.length - 1].rate, withEx[withEx.length - 1].ex);
          }
          return [
            chalk.white.bold(s),
            pacRate,
            hlRate,
            ltRate,
            annDiff > 5 ? chalk.yellow(`${annDiff.toFixed(1)}%`) : `${annDiff.toFixed(1)}%`,
          ];
        });

      console.log(makeTable(["Symbol", "Pacifica", "Hyperliquid", "Lighter", "Ann. Spread"], rows));
    });

  arb
    .command("basis")
    .description("Show basis (spot vs perp price) opportunities across exchanges")
    .option("--min-basis <pct>", "Minimum annual basis % to show", "3")
    .action(async (opts: { minBasis: string }) => {
      if (!isJson()) console.log(chalk.cyan("  Fetching prices for basis calculation...\n"));

      const [pacRates, hlRates, ltRates] = await Promise.all([
        fetchPacificaRates(),
        fetchHyperliquidRates(),
        fetchLighterRates(),
      ]);

      // Compare mark prices across all exchanges for cross-exchange basis
      const exchangePrices = new Map<string, Map<string, number>>();
      for (const r of [...pacRates, ...hlRates, ...ltRates]) {
        if (r.markPrice <= 0) continue;
        if (!exchangePrices.has(r.symbol)) exchangePrices.set(r.symbol, new Map());
        exchangePrices.get(r.symbol)!.set(r.exchange, r.markPrice);
      }

      type BasisOpp = {
        symbol: string;
        prices: Record<string, number>;
        priceDiff: number;
        pctDiff: number;
        buyOn: string;
        sellOn: string;
      };
      const opps: BasisOpp[] = [];

      for (const [symbol, prices] of exchangePrices.entries()) {
        if (prices.size < 2) continue;

        // Find cheapest and most expensive exchange
        let minEx = "", maxEx = "", minPrice = Infinity, maxPrice = 0;
        for (const [ex, price] of prices) {
          if (price < minPrice) { minPrice = price; minEx = ex; }
          if (price > maxPrice) { maxPrice = price; maxEx = ex; }
        }
        if (minEx === maxEx) continue;

        const diff = maxPrice - minPrice;
        const avgPrice = (maxPrice + minPrice) / 2;
        const pctDiff = (diff / avgPrice) * 100;

        if (pctDiff * 365 >= parseFloat(opts.minBasis)) {
          const priceObj: Record<string, number> = {};
          for (const [ex, p] of prices) priceObj[ex] = p;
          opps.push({
            symbol,
            prices: priceObj,
            priceDiff: diff,
            pctDiff,
            buyOn: minEx,
            sellOn: maxEx,
          });
        }
      }

      opps.sort((a, b) => b.pctDiff - a.pctDiff);

      if (isJson()) return printJson(jsonOk(opps));

      if (opps.length === 0) {
        console.log(chalk.gray(`  No basis opportunities above ${opts.minBasis}% threshold.\n`));
        return;
      }

      console.log(chalk.cyan.bold("  Cross-Exchange Basis Opportunities\n"));
      console.log(chalk.gray("  Strategy: Buy cheap, sell expensive, profit from convergence.\n"));

      const rows = opps.map((o) => [
        chalk.white.bold(o.symbol),
        o.prices.pacifica ? `$${formatUsd(o.prices.pacifica)}` : chalk.gray("-"),
        o.prices.hyperliquid ? `$${formatUsd(o.prices.hyperliquid)}` : chalk.gray("-"),
        o.prices.lighter ? `$${formatUsd(o.prices.lighter)}` : chalk.gray("-"),
        `$${formatUsd(o.priceDiff)}`,
        `${o.pctDiff.toFixed(4)}%`,
        chalk.green(o.buyOn),
        chalk.red(o.sellOn),
      ]);

      console.log(
        makeTable(
          ["Symbol", "Pacifica", "Hyperliquid", "Lighter", "Diff", "Basis %", "Buy On", "Sell On"],
          rows
        )
      );
    });

  // ── arb dex ── (HIP-3 cross-dex funding arb scan)
  arb
    .command("dex")
    .description("Scan HIP-3 cross-dex funding arb opportunities on Hyperliquid")
    .option("--min-spread <pct>", "Min annual spread % to show", "5")
    .option("--max-gap <pct>", "Max price gap % to treat as same asset", "5")
    .option("--include-native", "Include native HL perps in comparison", true)
    .option("--no-include-native", "Exclude native HL perps")
    .option("--top <n>", "Show top N opportunities", "30")
    .action(async (opts: { minSpread: string; maxGap: string; includeNative: boolean; top: string }) => {
      if (!isJson()) console.log(chalk.cyan("  Scanning HIP-3 deployed dex funding spreads...\n"));

      const pairs = await scanDexArb({
        minAnnualSpread: parseFloat(opts.minSpread),
        maxPriceGapPct: parseFloat(opts.maxGap),
        includeNative: opts.includeNative,
      });

      const topN = parseInt(opts.top);
      const shown = pairs.slice(0, topN);

      if (isJson()) return printJson(jsonOk(shown.map(p => ({
        underlying: p.underlying,
        longDex: p.long.dex,
        longSymbol: p.long.raw,
        longFunding: p.long.fundingRate,
        longPrice: p.long.markPrice,
        longOiUsd: p.long.openInterest * p.long.markPrice,
        longVolume24h: p.long.volume24h,
        shortDex: p.short.dex,
        shortSymbol: p.short.raw,
        shortFunding: p.short.fundingRate,
        shortPrice: p.short.markPrice,
        shortOiUsd: p.short.openInterest * p.short.markPrice,
        shortVolume24h: p.short.volume24h,
        annualSpread: p.annualSpread,
        priceGapPct: p.priceGapPct,
        minOiUsd: p.minOiUsd,
        minVolume24hUsd: p.minVolume24hUsd,
        viability: p.viability,
      }))));

      if (shown.length === 0) {
        console.log(chalk.gray(`  No cross-dex opportunities above ${opts.minSpread}% annual spread.\n`));
        return;
      }

      console.log(chalk.cyan.bold("  HIP-3 Cross-Dex Funding Arb Opportunities\n"));
      console.log(chalk.gray("  Strategy: Long on low-funding dex, Short on high-funding dex (same underlying)\n"));

      const rows = shown.map((p) => {
        const spreadColor = p.annualSpread >= 50 ? chalk.green.bold
          : p.annualSpread >= 20 ? chalk.green
          : chalk.yellow;
        const viabilityColor = p.viability === "A" ? chalk.green.bold
          : p.viability === "B" ? chalk.green
          : p.viability === "C" ? chalk.yellow
          : chalk.red;
        const fmtOi = p.minOiUsd >= 1_000_000 ? `$${(p.minOiUsd / 1_000_000).toFixed(1)}M`
          : p.minOiUsd >= 1_000 ? `$${(p.minOiUsd / 1_000).toFixed(0)}K`
          : `$${p.minOiUsd.toFixed(0)}`;
        const fmtVol = p.minVolume24hUsd >= 1_000_000 ? `$${(p.minVolume24hUsd / 1_000_000).toFixed(1)}M`
          : p.minVolume24hUsd >= 1_000 ? `$${(p.minVolume24hUsd / 1_000).toFixed(0)}K`
          : `$${p.minVolume24hUsd.toFixed(0)}`;
        return [
          chalk.white.bold(p.underlying),
          `${p.long.dex}:${p.long.base}`,
          formatPercent(p.long.fundingRate),
          `${p.short.dex}:${p.short.base}`,
          formatPercent(p.short.fundingRate),
          `$${formatUsd(p.long.markPrice)}`,
          spreadColor(`${p.annualSpread.toFixed(1)}%`),
          p.priceGapPct < 0.1 ? chalk.green(`${p.priceGapPct.toFixed(3)}%`) : chalk.yellow(`${p.priceGapPct.toFixed(3)}%`),
          viabilityColor(p.viability),
          viabilityColor(fmtOi),
          chalk.gray(fmtVol),
        ];
      });

      console.log(makeTable(
        ["Asset", "Long On", "L.Fund", "Short On", "S.Fund", "Price", "Ann.Spread", "Gap", "Grade", "MinOI", "MinVol"],
        rows,
      ));

      // Summary
      const dexes = new Set<string>();
      for (const p of shown) { dexes.add(p.long.dex); dexes.add(p.short.dex); }
      const gradeCount = { A: 0, B: 0, C: 0, D: 0 };
      for (const p of shown) gradeCount[p.viability]++;
      console.log(chalk.gray(`\n  ${shown.length}/${pairs.length} opportunities | Dexes: ${[...dexes].sort().join(", ")}`));
      console.log(chalk.gray(`  Grade: ${chalk.green.bold(`A(${gradeCount.A})`)} ${chalk.green(`B(${gradeCount.B})`)} ${chalk.yellow(`C(${gradeCount.C})`)} ${chalk.red(`D(${gradeCount.D})`)}`));
      console.log(chalk.gray(`  A: OI>$1M  B: OI>$100K  C: OI>$10K  D: OI<$10K (thin — high risk)`));
      console.log(chalk.gray(`  Note: HIP-3 dexes charge 2x fees. Factor into net profitability.\n`));
    });

  // ── arb watch/track/alert ── (promoted from arb gap)
  registerGapDirectCommands(arb, isJson);

  // Keep deprecated 'arb gap' subgroup (hidden from help)
  const gapSub = arb.command("gap").description("[deprecated] Use 'perp arb watch/track/alert'");
  (gapSub as any)._hidden = true;
  registerGapSubcommands(gapSub, isJson);

  // Keep deprecated top-level 'gap' alias (hidden from help)
  const gapAlias = program
    .command("gap")
    .description("Use 'perp arb watch/track/alert'");
  (gapAlias as any)._hidden = true;
  registerGapSubcommands(gapAlias, isJson);
}

// ────────────────────────────────────────────────────────
// Gap monitoring (merged from gap.ts)
// ────────────────────────────────────────────────────────

interface PriceSnapshot {
  symbol: string;
  pacPrice: number | null;
  hlPrice: number | null;
  ltPrice: number | null;
  maxGap: number; // absolute $ max difference across exchanges
  maxGapPct: number; // percentage max difference
  cheapest: string;
  expensive: string;
}

async function fetchAllPrices(): Promise<PriceSnapshot[]> {
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

function formatGapPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function printGapTable(snapshots: PriceSnapshot[], minGap: number) {
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

function printTrackSummary(
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

/**
 * Register gap-related commands directly on the arb parent (promoted from arb gap).
 * - arb prices: snapshot of cross-exchange prices (was arb gap show)
 * - arb watch: live monitoring (was arb gap watch)
 * - arb track: track gap over time (was arb gap track)
 * - arb alert: threshold alert (was arb gap alert)
 */
function registerGapDirectCommands(
  arb: Command,
  isJson: () => boolean
) {
  // ── arb prices (was arb gap show) ──
  arb
    .command("prices")
    .description("Show current prices across all exchanges with gap analysis")
    .option("--min <pct>", "Minimum gap % to display", "0.01")
    .option("--symbol <sym>", "Filter by symbol (e.g. BTC, ETH)")
    .option("--top <n>", "Show top N gaps only")
    .action(async (opts: { min: string; symbol?: string; top?: string }) => {
      const minGap = parseFloat(opts.min);
      if (!isJson()) console.log(chalk.cyan("\n  Fetching prices from Pacifica, Hyperliquid & Lighter...\n"));

      let snapshots = await fetchAllPrices();

      if (opts.symbol) {
        const sym = opts.symbol.toUpperCase();
        snapshots = snapshots.filter((s) => s.symbol.includes(sym));
      }

      if (opts.top) {
        snapshots = snapshots.slice(0, parseInt(opts.top));
      }

      if (isJson()) return printJson(jsonOk(snapshots.filter((s) => s.maxGapPct >= minGap)));

      printGapTable(snapshots, minGap);
    });

  // ── arb watch (was arb gap watch) ──
  arb
    .command("watch")
    .description("Live-monitor price gaps across exchanges (auto-refresh)")
    .option("--min <pct>", "Minimum gap % to display", "0.05")
    .option("--interval <seconds>", "Refresh interval", "5")
    .option("--symbol <sym>", "Filter by symbol")
    .option("--beep", "Beep on gaps above 0.5%")
    .action(
      async (opts: {
        min: string;
        interval: string;
        symbol?: string;
        beep?: boolean;
      }) => {
        const minGap = parseFloat(opts.min);
        const intervalMs = parseInt(opts.interval) * 1000;
        const beep = !!opts.beep;

        if (!isJson()) {
          console.log(chalk.cyan.bold("\n  Price Gap Monitor"));
          console.log(`  Min gap:   ${minGap}%`);
          console.log(`  Interval:  ${opts.interval}s`);
          if (opts.symbol) console.log(`  Symbol:    ${opts.symbol.toUpperCase()}`);
          console.log(chalk.gray("  Ctrl+C to stop\n"));
        }

        const cycle = async () => {
          try {
            let snapshots = await fetchAllPrices();

            if (opts.symbol) {
              const sym = opts.symbol.toUpperCase();
              snapshots = snapshots.filter((s) => s.symbol.includes(sym));
            }

            process.stdout.write("\x1B[2J\x1B[0f");

            const now = new Date().toLocaleTimeString();
            console.log(
              chalk.cyan.bold(`  Price Gap Monitor`) +
                chalk.gray(`  ${now}  (refresh: ${opts.interval}s)\n`)
            );

            printGapTable(snapshots, minGap);

            const bigGaps = snapshots.filter((s) => s.maxGapPct >= 0.5);
            if (bigGaps.length > 0) {
              console.log(
                chalk.red.bold(
                  `  !! ${bigGaps.length} large gap(s): ` +
                    bigGaps
                      .map((s) => `${s.symbol}(${s.maxGapPct.toFixed(3)}%)`)
                      .join(", ")
                )
              );
              if (beep) process.stdout.write("\x07");
            }
          } catch (err) {
            console.error(
              chalk.gray(
                `  Error: ${err instanceof Error ? err.message : String(err)}`
              )
            );
          }
        };

        await cycle();
        setInterval(cycle, intervalMs);
        await new Promise(() => {}); // keep alive
      }
    );

  // ── arb track (was arb gap track) ──
  arb
    .command("track")
    .description("Track a symbol's price gap over time and print stats")
    .requiredOption("-s, --symbol <sym>", "Symbol to track (e.g. BTC)")
    .option("--duration <minutes>", "How long to track (minutes)", "10")
    .option("--interval <seconds>", "Sample interval", "10")
    .action(
      async (opts: { symbol: string; duration: string; interval: string }) => {
        const symbol = opts.symbol.toUpperCase();
        const durationMs = parseInt(opts.duration) * 60 * 1000;
        const intervalMs = parseInt(opts.interval) * 1000;
        const endTime = Date.now() + durationMs;

        const samples: { time: string; gap: number; gapPct: number; direction: string }[] = [];

        if (!isJson()) {
          console.log(chalk.cyan.bold(`\n  Tracking ${symbol} price gap\n`));
          console.log(`  Duration:  ${opts.duration} min`);
          console.log(`  Interval:  ${opts.interval}s`);
          console.log(chalk.gray("  Collecting samples...\n"));
        }

        const sample = async () => {
          const snapshots = await fetchAllPrices();
          const s = snapshots.find((x) => x.symbol === symbol);
          if (!s) {
            console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} — ${symbol} not found on both exchanges`));
            return;
          }

          samples.push({
            time: new Date().toLocaleTimeString(),
            gap: s.maxGap,
            gapPct: s.maxGapPct,
            direction: `${s.cheapest}→${s.expensive}`,
          });

          const gapColor = s.maxGapPct >= 0.1 ? chalk.yellow : chalk.gray;
          const parts = [`PAC: ${s.pacPrice !== null ? "$" + formatGapPrice(s.pacPrice) : "-"}`];
          parts.push(`HL: ${s.hlPrice !== null ? "$" + formatGapPrice(s.hlPrice) : "-"}`);
          parts.push(`LT: ${s.ltPrice !== null ? "$" + formatGapPrice(s.ltPrice) : "-"}`);
          console.log(
            `  ${chalk.white(s.symbol.padEnd(6))} ` +
              `${parts.join("  ")}  ` +
              `${gapColor(`${s.maxGapPct.toFixed(4)}%`)}  ${s.cheapest}→${s.expensive}`
          );
        };

        await sample();
        const timer = setInterval(async () => {
          if (Date.now() >= endTime) {
            clearInterval(timer);
            printTrackSummary(symbol, samples);
            return;
          }
          await sample();
        }, intervalMs);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, durationMs + 1000);
        });
      }
    );

  // ── arb alert (was arb gap alert) ──
  arb
    .command("alert")
    .description("Wait until a symbol's price gap exceeds a threshold, then exit")
    .requiredOption("-s, --symbol <sym>", "Symbol to watch")
    .requiredOption("--above <pct>", "Gap % threshold to trigger")
    .option("--interval <seconds>", "Check interval", "5")
    .action(
      async (opts: { symbol: string; above: string; interval: string }) => {
        const symbol = opts.symbol.toUpperCase();
        const threshold = parseFloat(opts.above);
        const intervalMs = parseInt(opts.interval) * 1000;

        if (!isJson()) console.log(chalk.cyan(`\n  Waiting for ${symbol} gap > ${threshold}%...\n`));

        const check = async (): Promise<boolean> => {
          const snapshots = await fetchAllPrices();
          const s = snapshots.find((x) => x.symbol === symbol);
          if (!s) return false;

          const now = new Date().toLocaleTimeString();
          if (!isJson()) console.log(chalk.gray(`  ${now} ${symbol} gap: ${s.maxGapPct.toFixed(4)}%`));

          if (s.maxGapPct >= threshold) {
            if (isJson()) {
              printJson(jsonOk(s));
            } else {
              console.log(
                chalk.green.bold(
                  `\n  TRIGGERED! ${symbol} gap: ${s.maxGapPct.toFixed(4)}% (> ${threshold}%)`
                )
              );
              const lines = [];
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
          const timer = setInterval(async () => {
            if (await check()) {
              clearInterval(timer);
              resolve();
            }
          }, intervalMs);
        });
      }
    );
}

function registerGapSubcommands(
  parent: Command,
  isJson: () => boolean
) {
  const gap = parent.name() === "gap"
    ? parent
    : parent.command("gap").description("Cross-exchange price gap monitoring");

  // ── gap show (default) ──

  gap
    .command("show", { isDefault: true })
    .description("Show current price gaps between exchanges")
    .option("--min <pct>", "Minimum gap % to display", "0.01")
    .option("--symbol <sym>", "Filter by symbol (e.g. BTC, ETH)")
    .option("--top <n>", "Show top N gaps only")
    .action(async (opts: { min: string; symbol?: string; top?: string }) => {
      const minGap = parseFloat(opts.min);
      if (!isJson()) console.log(chalk.cyan("\n  Fetching prices from Pacifica, Hyperliquid & Lighter...\n"));

      let snapshots = await fetchAllPrices();

      if (opts.symbol) {
        const sym = opts.symbol.toUpperCase();
        snapshots = snapshots.filter((s) => s.symbol.includes(sym));
      }

      if (opts.top) {
        snapshots = snapshots.slice(0, parseInt(opts.top));
      }

      if (isJson()) return printJson(jsonOk(snapshots.filter((s) => s.maxGapPct >= minGap)));

      printGapTable(snapshots, minGap);
    });

  // ── gap watch ── (live monitoring)

  gap
    .command("watch")
    .description("Live-monitor price gaps (auto-refresh)")
    .option("--min <pct>", "Minimum gap % to display", "0.05")
    .option("--interval <seconds>", "Refresh interval", "5")
    .option("--symbol <sym>", "Filter by symbol")
    .option("--beep", "Beep on gaps above 0.5%")
    .action(
      async (opts: {
        min: string;
        interval: string;
        symbol?: string;
        beep?: boolean;
      }) => {
        const minGap = parseFloat(opts.min);
        const intervalMs = parseInt(opts.interval) * 1000;
        const beep = !!opts.beep;

        if (!isJson()) {
          console.log(chalk.cyan.bold("\n  Price Gap Monitor"));
          console.log(`  Min gap:   ${minGap}%`);
          console.log(`  Interval:  ${opts.interval}s`);
          if (opts.symbol) console.log(`  Symbol:    ${opts.symbol.toUpperCase()}`);
          console.log(chalk.gray("  Ctrl+C to stop\n"));
        }

        const cycle = async () => {
          try {
            let snapshots = await fetchAllPrices();

            if (opts.symbol) {
              const sym = opts.symbol.toUpperCase();
              snapshots = snapshots.filter((s) => s.symbol.includes(sym));
            }

            // Clear screen for live view
            process.stdout.write("\x1B[2J\x1B[0f");

            const now = new Date().toLocaleTimeString();
            console.log(
              chalk.cyan.bold(`  Price Gap Monitor`) +
                chalk.gray(`  ${now}  (refresh: ${opts.interval}s)\n`)
            );

            printGapTable(snapshots, minGap);

            // Alert on large gaps
            const bigGaps = snapshots.filter((s) => s.maxGapPct >= 0.5);
            if (bigGaps.length > 0) {
              console.log(
                chalk.red.bold(
                  `  !! ${bigGaps.length} large gap(s): ` +
                    bigGaps
                      .map((s) => `${s.symbol}(${s.maxGapPct.toFixed(3)}%)`)
                      .join(", ")
                )
              );
              if (beep) process.stdout.write("\x07");
            }
          } catch (err) {
            console.error(
              chalk.gray(
                `  Error: ${err instanceof Error ? err.message : String(err)}`
              )
            );
          }
        };

        await cycle();
        setInterval(cycle, intervalMs);
        await new Promise(() => {}); // keep alive
      }
    );

  // ── gap track ── (track gap over time for a symbol)

  gap
    .command("track")
    .description("Track a symbol's gap over time and print stats")
    .requiredOption("-s, --symbol <sym>", "Symbol to track (e.g. BTC)")
    .option("--duration <minutes>", "How long to track (minutes)", "10")
    .option("--interval <seconds>", "Sample interval", "10")
    .action(
      async (opts: { symbol: string; duration: string; interval: string }) => {
        const symbol = opts.symbol.toUpperCase();
        const durationMs = parseInt(opts.duration) * 60 * 1000;
        const intervalMs = parseInt(opts.interval) * 1000;
        const endTime = Date.now() + durationMs;

        const samples: { time: string; gap: number; gapPct: number; direction: string }[] = [];

        if (!isJson()) {
          console.log(chalk.cyan.bold(`\n  Tracking ${symbol} price gap\n`));
          console.log(`  Duration:  ${opts.duration} min`);
          console.log(`  Interval:  ${opts.interval}s`);
          console.log(chalk.gray("  Collecting samples...\n"));
        }

        const sample = async () => {
          const snapshots = await fetchAllPrices();
          const s = snapshots.find((x) => x.symbol === symbol);
          if (!s) {
            console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} — ${symbol} not found on both exchanges`));
            return;
          }

          samples.push({
            time: new Date().toLocaleTimeString(),
            gap: s.maxGap,
            gapPct: s.maxGapPct,
            direction: `${s.cheapest}→${s.expensive}`,
          });

          const gapColor = s.maxGapPct >= 0.1 ? chalk.yellow : chalk.gray;
          const parts = [`PAC: ${s.pacPrice !== null ? "$" + formatGapPrice(s.pacPrice) : "-"}`];
          parts.push(`HL: ${s.hlPrice !== null ? "$" + formatGapPrice(s.hlPrice) : "-"}`);
          parts.push(`LT: ${s.ltPrice !== null ? "$" + formatGapPrice(s.ltPrice) : "-"}`);
          console.log(
            `  ${chalk.white(s.symbol.padEnd(6))} ` +
              `${parts.join("  ")}  ` +
              `${gapColor(`${s.maxGapPct.toFixed(4)}%`)}  ${s.cheapest}→${s.expensive}`
          );
        };

        await sample();
        const timer = setInterval(async () => {
          if (Date.now() >= endTime) {
            clearInterval(timer);
            printTrackSummary(symbol, samples);
            return;
          }
          await sample();
        }, intervalMs);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, durationMs + 1000);
        });
      }
    );

  // ── gap alert ── (one-shot: notify when gap exceeds threshold)

  gap
    .command("alert")
    .description("Wait until a symbol's gap exceeds a threshold, then exit")
    .requiredOption("-s, --symbol <sym>", "Symbol to watch")
    .requiredOption("--above <pct>", "Gap % threshold to trigger")
    .option("--interval <seconds>", "Check interval", "5")
    .action(
      async (opts: { symbol: string; above: string; interval: string }) => {
        const symbol = opts.symbol.toUpperCase();
        const threshold = parseFloat(opts.above);
        const intervalMs = parseInt(opts.interval) * 1000;

        if (!isJson()) console.log(chalk.cyan(`\n  Waiting for ${symbol} gap > ${threshold}%...\n`));

        const check = async (): Promise<boolean> => {
          const snapshots = await fetchAllPrices();
          const s = snapshots.find((x) => x.symbol === symbol);
          if (!s) return false;

          const now = new Date().toLocaleTimeString();
          if (!isJson()) console.log(chalk.gray(`  ${now} ${symbol} gap: ${s.maxGapPct.toFixed(4)}%`));

          if (s.maxGapPct >= threshold) {
            if (isJson()) {
              printJson(jsonOk(s));
            } else {
              console.log(
                chalk.green.bold(
                  `\n  TRIGGERED! ${symbol} gap: ${s.maxGapPct.toFixed(4)}% (> ${threshold}%)`
                )
              );
              const lines = [];
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
          const timer = setInterval(async () => {
            if (await check()) {
              clearInterval(timer);
              resolve();
            }
          }, intervalMs);
        });
      }
    );
}
