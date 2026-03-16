import { Command } from "commander";
import { makeTable, formatUsd, formatPercent, formatPnl, printJson, jsonOk } from "../utils.js";
import chalk from "chalk";
import { annualizeRate, computeAnnualSpread, toHourlyRate } from "../funding.js";
import {
  fetchPacificaPrices, fetchHyperliquidMeta,
  fetchLighterOrderBookDetails, fetchLighterFundingRates,
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

}
