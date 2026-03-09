import { Command } from "commander";
import chalk from "chalk";
import { makeTable, formatPercent, formatUsd, printJson, jsonOk } from "../utils.js";
import {
  fetchAllFundingRates,
  fetchSymbolFundingRates,
  TOP_SYMBOLS,
  type FundingRateSnapshot,
  type SymbolFundingComparison,
} from "../funding-rates.js";
import { estimateHourlyFunding } from "../funding.js";

export function registerFundingCommands(
  program: Command,
  isJson: () => boolean,
) {
  const funding = program.command("funding").description("Funding rate comparison across exchanges");

  // ── perp funding rates ── (default: show top symbols)
  funding
    .command("rates")
    .description("Show funding rates across all 3 DEXs for top symbols")
    .option("-s, --symbol <symbol>", "Filter to a specific symbol")
    .option("--symbols <list>", "Comma-separated list of symbols")
    .option("--all", "Show all available symbols (not just top ones)")
    .option("--min-spread <pct>", "Minimum annual spread % to show", "0")
    .action(async (opts: { symbol?: string; symbols?: string; all?: boolean; minSpread: string }) => {
      const minSpread = parseFloat(opts.minSpread);
      let filterSymbols: string[] | undefined;

      if (opts.symbol) {
        filterSymbols = [opts.symbol.toUpperCase()];
      } else if (opts.symbols) {
        filterSymbols = opts.symbols.split(",").map(s => s.trim().toUpperCase());
      } else if (!opts.all) {
        filterSymbols = TOP_SYMBOLS;
      }

      if (!isJson()) console.log(chalk.cyan("  Fetching funding rates from all exchanges...\n"));

      const snapshot = await fetchAllFundingRates({
        symbols: filterSymbols,
        minSpread,
      });

      if (isJson()) return printJson(jsonOk(snapshot));

      printSnapshotTable(snapshot);
      printExchangeStatus(snapshot);
    });

  // ── perp funding compare <symbol> ── (detailed single-symbol view)
  funding
    .command("compare <symbol>")
    .description("Detailed funding rate comparison for a single symbol")
    .action(async (symbol: string) => {
      if (!isJson()) console.log(chalk.cyan(`  Fetching funding rates for ${symbol.toUpperCase()}...\n`));

      const comparison = await fetchSymbolFundingRates(symbol);

      if (!comparison) {
        if (isJson()) return printJson(jsonOk({ symbol: symbol.toUpperCase(), available: false }));
        console.log(chalk.gray(`  ${symbol.toUpperCase()} not found on at least 2 exchanges.\n`));
        return;
      }

      if (isJson()) return printJson(jsonOk(comparison));

      printDetailedComparison(comparison);
    });

  // ── perp funding spread ── (sorted by spread opportunities)
  funding
    .command("spread")
    .description("Show best funding rate arb opportunities sorted by spread")
    .option("--min <pct>", "Min annual spread to show", "10")
    .option("--top <n>", "Show top N opportunities", "20")
    .action(async (opts: { min: string; top: string }) => {
      const minSpread = parseFloat(opts.min);
      const topN = parseInt(opts.top);

      if (!isJson()) console.log(chalk.cyan("  Scanning funding rate spreads across all exchanges...\n"));

      const snapshot = await fetchAllFundingRates({ minSpread });
      const shown = snapshot.symbols.slice(0, topN);

      if (isJson()) return printJson(jsonOk(shown));

      if (shown.length === 0) {
        console.log(chalk.gray(`  No opportunities above ${minSpread}% annual spread.\n`));
        return;
      }

      console.log(chalk.cyan.bold("  Funding Rate Arb Opportunities\n"));
      console.log(chalk.gray("  Strategy: Long on low-funding exchange, Short on high-funding exchange\n"));

      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";

      const rows = shown.map(s => {
        const pacRate = s.rates.find(r => r.exchange === "pacifica");
        const hlRate = s.rates.find(r => r.exchange === "hyperliquid");
        const ltRate = s.rates.find(r => r.exchange === "lighter");
        const spreadColor = s.maxSpreadAnnual >= 50 ? chalk.green.bold
          : s.maxSpreadAnnual >= 20 ? chalk.green
          : chalk.yellow;

        return [
          chalk.white.bold(s.symbol),
          `$${formatUsd(s.bestMarkPrice)}`,
          pacRate ? formatPercent(pacRate.fundingRate) : chalk.gray("-"),
          hlRate ? formatPercent(hlRate.fundingRate) : chalk.gray("-"),
          ltRate ? formatPercent(ltRate.fundingRate) : chalk.gray("-"),
          spreadColor(`${s.maxSpreadAnnual.toFixed(1)}%`),
          `${exAbbr(s.shortExchange)}>${exAbbr(s.longExchange)}`,
          `$${s.estHourlyIncomeUsd.toFixed(4)}/hr`,
        ];
      });

      console.log(makeTable(
        ["Symbol", "Price", "Pacifica", "Hyperliquid", "Lighter", "Ann.Spread", "Direction", "Est.Income/$1K"],
        rows,
      ));

      console.log(chalk.gray(`\n  ${shown.length} opportunities above ${minSpread}% annual spread`));
      console.log(chalk.gray(`  Income estimated for $1,000 notional per leg`));
      console.log(chalk.gray(`  Use 'perp arb auto --min-spread ${minSpread}' to auto-trade\n`));
    });

  // ── perp funding monitor ── (live refreshing)
  funding
    .command("monitor")
    .description("Live-monitor funding rates with auto-refresh")
    .option("--min <pct>", "Min annual spread to show", "10")
    .option("--interval <sec>", "Refresh interval in seconds", "30")
    .option("--top <n>", "Show top N", "15")
    .option("--symbols <list>", "Comma-separated symbols to watch")
    .action(async (opts: { min: string; interval: string; top: string; symbols?: string }) => {
      const minSpread = parseFloat(opts.min);
      const intervalSec = parseInt(opts.interval);
      const topN = parseInt(opts.top);
      const filterSymbols = opts.symbols?.split(",").map(s => s.trim().toUpperCase());
      let cycle = 0;

      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Funding Rate Monitor"));
        console.log(chalk.gray(`  Min spread: ${minSpread}% | Refresh: ${intervalSec}s | Top: ${topN}`));
        if (filterSymbols) console.log(chalk.gray(`  Symbols: ${filterSymbols.join(", ")}`));
        console.log(chalk.gray(`  Press Ctrl+C to stop\n`));
      }

      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";

      while (true) {
        cycle++;
        const ts = new Date().toLocaleTimeString();

        try {
          const snapshot = await fetchAllFundingRates({
            symbols: filterSymbols,
            minSpread,
          });
          const shown = snapshot.symbols.slice(0, topN);

          if (isJson()) {
            printJson(jsonOk({ cycle, timestamp: ts, opportunities: shown }));
          } else {
            // Clear previous output
            if (cycle > 1) {
              const linesToClear = shown.length + 4;
              process.stdout.write(`\x1b[${linesToClear}A\x1b[J`);
            }

            console.log(chalk.gray(`  ${ts} -- Cycle ${cycle} | ${shown.length} opportunities >= ${minSpread}%\n`));

            if (shown.length === 0) {
              console.log(chalk.gray(`  No opportunities found.\n`));
            } else {
              for (const s of shown) {
                const direction = `${exAbbr(s.shortExchange)}>${exAbbr(s.longExchange)}`;
                const spreadColor = s.maxSpreadAnnual >= 50 ? chalk.green.bold
                  : s.maxSpreadAnnual >= 30 ? chalk.green
                  : chalk.yellow;

                const rateStrs: string[] = [];
                for (const r of s.rates) {
                  rateStrs.push(`${exAbbr(r.exchange)}:${(r.fundingRate * 100).toFixed(4)}%`);
                }

                console.log(
                  `  ${chalk.white.bold(s.symbol.padEnd(8))} ` +
                  `${spreadColor(`${s.maxSpreadAnnual.toFixed(1)}%`.padEnd(8))} ` +
                  `${direction.padEnd(7)} ` +
                  rateStrs.join(" ")
                );
              }
              console.log();
            }
          }
        } catch (err) {
          if (!isJson()) {
            console.log(chalk.red(`  ${ts} Error: ${err instanceof Error ? err.message : err}\n`));
          }
        }

        await new Promise(r => setTimeout(r, intervalSec * 1000));
      }
    });
}

// ── Display helpers ──

function printSnapshotTable(snapshot: FundingRateSnapshot): void {
  const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";

  if (snapshot.symbols.length === 0) {
    console.log(chalk.gray("  No funding rate data available.\n"));
    return;
  }

  const rows = snapshot.symbols.map(s => {
    const pacRate = s.rates.find(r => r.exchange === "pacifica");
    const hlRate = s.rates.find(r => r.exchange === "hyperliquid");
    const ltRate = s.rates.find(r => r.exchange === "lighter");
    const spreadColor = s.maxSpreadAnnual >= 30 ? chalk.green
      : s.maxSpreadAnnual >= 10 ? chalk.yellow
      : chalk.white;

    return [
      chalk.white.bold(s.symbol),
      pacRate ? formatPercent(pacRate.fundingRate) : chalk.gray("-"),
      hlRate ? formatPercent(hlRate.fundingRate) : chalk.gray("-"),
      ltRate ? formatPercent(ltRate.fundingRate) : chalk.gray("-"),
      spreadColor(`${s.maxSpreadAnnual.toFixed(1)}%`),
      s.maxSpreadAnnual >= 5 ? `${exAbbr(s.shortExchange)}>${exAbbr(s.longExchange)}` : chalk.gray("-"),
    ];
  });

  console.log(makeTable(
    ["Symbol", "Pacifica", "Hyperliquid", "Lighter", "Ann. Spread", "Direction"],
    rows,
  ));

  console.log(chalk.gray(`\n  ${snapshot.symbols.length} symbols compared across exchanges.`));
  console.log(chalk.gray(`  Rates: PAC/LT = per 8h | HL = per 1h. Spread is normalized.\n`));
}

function printExchangeStatus(snapshot: FundingRateSnapshot): void {
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
    const hourlyPct = (r.hourlyRate * 100).toFixed(6);
    const annualPct = r.annualizedPct.toFixed(2);
    const color = r.fundingRate > 0 ? chalk.red : r.fundingRate < 0 ? chalk.green : chalk.white;

    console.log(`  ${chalk.white.bold(exAbbr(r.exchange).padEnd(4))} ` +
      `Raw: ${color(formatPercent(r.fundingRate).padEnd(14))} ` +
      `Hourly: ${hourlyPct}%  ` +
      `Annual: ${annualPct}%`
    );
  }

  console.log();
  const spreadColor = comparison.maxSpreadAnnual >= 30 ? chalk.green.bold
    : comparison.maxSpreadAnnual >= 10 ? chalk.yellow
    : chalk.white;

  console.log(`  Max Spread:     ${spreadColor(`${comparison.maxSpreadAnnual.toFixed(1)}%`)} annual`);
  console.log(`  Direction:      Long ${exAbbr(comparison.longExchange)} / Short ${exAbbr(comparison.shortExchange)}`);
  console.log(`  Est. Income:    $${comparison.estHourlyIncomeUsd.toFixed(4)}/hr per $1K notional`);

  // Show income at different position sizes
  const sizes = [1000, 5000, 10000, 50000];
  console.log(chalk.gray("\n  Estimated daily income by position size:"));
  for (const size of sizes) {
    const daily = (comparison.estHourlyIncomeUsd / 1000) * size * 24;
    console.log(chalk.gray(`    $${formatUsd(size)} notional -> $${daily.toFixed(2)}/day`));
  }
  console.log();
}
