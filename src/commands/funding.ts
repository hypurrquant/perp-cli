import { Command } from "commander";
import chalk from "chalk";
import { makeTable, formatPercent, formatUsd, formatPnl, printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import {
  fetchAllFundingRates,
  fetchSymbolFundingRates,
  TOP_SYMBOLS,
  type FundingRateSnapshot,
  type SymbolFundingComparison,
} from "../funding-rates.js";
import { estimateHourlyFunding, annualizeHourlyRate, annualizeRate, toHourlyRate } from "../funding.js";
import {
  saveFundingSnapshot,
  getHistoricalRates,
  getCompoundedAnnualReturn,
  getExchangeCompoundingHours,
} from "../funding-history.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

const ALL_EXCHANGES = ["hyperliquid", "pacifica", "lighter"] as const;

export function registerFundingCommands(
  program: Command,
  isJson: () => boolean,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
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

      // Persist snapshot for historical tracking (moved from fetchAllFundingRates to avoid side effect)
      try {
        const allRates = snapshot.symbols.flatMap(s => s.rates);
        if (allRates.length > 0) saveFundingSnapshot(allRates);
      } catch { /* non-critical */ }

      if (isJson()) return printJson(jsonOk(snapshot));

      printSnapshotTable(snapshot);
      printExchangeStatus(snapshot);
      console.log(chalk.gray("  * Rates shown are current predictions. Actual settled rates may differ.\n"));
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
          getAvgSpread(s, "avg24h"),
          `${exAbbr(s.shortExchange)}>${exAbbr(s.longExchange)}`,
          `$${s.estHourlyIncomeUsd.toFixed(4)}/hr`,
        ];
      });

      console.log(makeTable(
        ["Symbol", "Price", "Pacifica", "Hyperliquid", "Lighter", "Ann.Spread", "Avg Spread(24h)", "Direction", "Est.Income/$1K"],
        rows,
      ));

      console.log(chalk.gray(`\n  ${shown.length} opportunities above ${minSpread}% annual spread`));
      console.log(chalk.gray(`  Income estimated for $1,000 notional per leg`));
      console.log(chalk.gray(`  Use 'perp arb auto --min-spread ${minSpread}' to auto-trade`));
      console.log(chalk.gray("\n  * Rates shown are current predictions. Actual settled rates may differ.\n"));
    });

  // ── perp funding history ── (rate trend over time)
  funding
    .command("history")
    .description("Show funding rate trend over time for a symbol")
    .requiredOption("-s, --symbol <symbol>", "Symbol to show history for")
    .option("--hours <n>", "Number of hours to look back", "24")
    .option("--exchange <ex>", "Filter to a specific exchange")
    .action(async (opts: { symbol: string; hours: string; exchange?: string }) => {
      const symbol = opts.symbol.toUpperCase();
      const hours = parseInt(opts.hours);
      const exchanges = opts.exchange
        ? [opts.exchange.toLowerCase()]
        : ["hyperliquid", "pacifica", "lighter"];

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

      if (isJson()) {
        const data: Record<string, { ts: string; rate: number; hourlyRate: number }[]> = {};
        for (const ex of exchanges) {
          const rates = getHistoricalRates(symbol, ex, startTime, endTime);
          if (rates.length > 0) data[ex] = rates;
        }
        return printJson(jsonOk({ symbol, hours, startTime: startTime.toISOString(), endTime: endTime.toISOString(), rates: data }));
      }

      console.log(chalk.cyan.bold(`  ${symbol} Funding Rate History (last ${hours}h)\n`));

      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
      let hasData = false;

      for (const ex of exchanges) {
        const rates = getHistoricalRates(symbol, ex, startTime, endTime);
        if (rates.length === 0) continue;
        hasData = true;

        console.log(chalk.white.bold(`  ${exAbbr(ex)} (${rates.length} snapshots):`));

        const rows = rates.map(r => {
          const date = new Date(r.ts);
          const timeStr = date.toLocaleString();
          const hourlyPct = (r.hourlyRate * 100).toFixed(6);
          const annualPct = annualizeHourlyRate(r.hourlyRate).toFixed(2);
          const color = r.rate > 0 ? chalk.red : r.rate < 0 ? chalk.green : chalk.white;
          return [
            chalk.gray(timeStr),
            color(formatPercent(r.rate)),
            `${hourlyPct}%/h`,
            `${annualPct}%/yr`,
          ];
        });

        console.log(makeTable(["Time", "Raw Rate", "Hourly", "Annualized"], rows));
        console.log();
      }

      if (!hasData) {
        console.log(chalk.gray(`  No historical data found for ${symbol} in the last ${hours}h.`));
        console.log(chalk.gray(`  Run 'perp funding rates' to start collecting data.\n`));
      }
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

  // ── perp funding positions ── (funding impact on open positions)
  funding
    .command("positions")
    .description("Show funding rate impact on your current positions")
    .option("--exchanges <list>", "Comma-separated exchanges to check (default: all with keys)")
    .action(async (opts: { exchanges?: string }) => {
      if (!getAdapterForExchange) {
        const msg = "funding positions requires adapter access";
        if (isJson()) return printJson(jsonError("INTERNAL", msg));
        console.log(chalk.red(`  ${msg}\n`));
        return;
      }

      await withJsonErrors(isJson(), async () => {
        const targetExchanges = opts.exchanges
          ? opts.exchanges.split(",").map(s => s.trim().toLowerCase())
          : [...ALL_EXCHANGES];

        if (!isJson()) console.log(chalk.cyan("  Fetching positions and funding rates...\n"));

        // Fetch positions + markets + actual funding payments from each exchange
        interface ExPositionWithFunding {
          exchange: string;
          symbol: string;
          side: "long" | "short";
          size: string;
          entryPrice: string;
          markPrice: string;
          unrealizedPnl: string;
          leverage: number;
          notionalUsd: number;
          fundingRate: number;
          hourlyRate: number;
          annualPct: number;
          hourlyPayment: number;  // predicted from current rate
          dailyPayment: number;   // predicted from current rate
          actualReceived24h: number;  // actual funding received in last 24h
          actualPaid24h: number;      // actual funding paid in last 24h
          actualNet24h: number;       // net actual funding last 24h
        }

        const results: ExPositionWithFunding[] = [];
        const exchangeErrors: Record<string, string> = {};

        await Promise.all(targetExchanges.map(async (exchange) => {
          try {
            const adapter = await getAdapterForExchange(exchange);
            const [positions, markets, fundingPayments] = await Promise.all([
              adapter.getPositions(),
              adapter.getMarkets(),
              adapter.getFundingPayments(100).catch(() => [] as { time: number; symbol: string; payment: string }[]),
            ]);

            if (positions.length === 0) return;

            // Build symbol → funding rate map
            const fundingMap = new Map<string, { rate: number; markPrice: number }>();
            for (const m of markets) {
              const sym = m.symbol.toUpperCase().replace(/-PERP$/, "");
              fundingMap.set(sym, {
                rate: Number(m.fundingRate) || 0,
                markPrice: Number(m.markPrice) || 0,
              });
            }

            // Aggregate actual funding payments per symbol (last 24h)
            const now = Date.now();
            const dayAgo = now - 24 * 60 * 60 * 1000;
            const actualFunding = new Map<string, { received: number; paid: number }>();
            for (const fp of fundingPayments) {
              if (fp.time < dayAgo) continue;
              const sym = fp.symbol.toUpperCase().replace(/-PERP$/, "");
              const amt = Number(fp.payment) || 0;
              if (!actualFunding.has(sym)) actualFunding.set(sym, { received: 0, paid: 0 });
              const entry = actualFunding.get(sym)!;
              if (amt > 0) entry.received += amt;
              else entry.paid += Math.abs(amt);
            }

            for (const pos of positions) {
              const sym = pos.symbol.toUpperCase().replace(/-PERP$/, "");
              const fdata = fundingMap.get(sym);
              const fundingRate = fdata?.rate ?? 0;
              const mark = Number(pos.markPrice) || fdata?.markPrice || 0;
              const size = Math.abs(Number(pos.size));
              const notionalUsd = size * mark;
              const hourlyRate = toHourlyRate(fundingRate, exchange);
              const annualPct = annualizeRate(fundingRate, exchange);
              const hourlyPayment = estimateHourlyFunding(fundingRate, exchange, notionalUsd, pos.side);
              const dailyPayment = hourlyPayment * 24;

              const actual = actualFunding.get(sym);
              const actualReceived24h = actual?.received ?? 0;
              const actualPaid24h = actual?.paid ?? 0;
              const actualNet24h = actualReceived24h - actualPaid24h;

              results.push({
                exchange,
                symbol: sym,
                side: pos.side,
                size: pos.size,
                entryPrice: pos.entryPrice,
                markPrice: pos.markPrice,
                unrealizedPnl: pos.unrealizedPnl,
                leverage: pos.leverage,
                notionalUsd,
                fundingRate,
                hourlyRate,
                annualPct,
                hourlyPayment,
                dailyPayment,
                actualReceived24h,
                actualPaid24h,
                actualNet24h,
              });
            }
          } catch (err) {
            exchangeErrors[exchange] = err instanceof Error ? err.message : String(err);
          }
        }));

        if (results.length === 0) {
          if (isJson()) {
            return printJson(jsonOk({
              positions: [],
              totals: {
                predicted: { hourly: 0, daily: 0 },
                actual24h: { net: 0 },
                notionalUsd: 0,
              },
              errors: exchangeErrors,
            }));
          }
          console.log(chalk.gray("  No open positions found on any exchange.\n"));
          if (Object.keys(exchangeErrors).length > 0) {
            for (const [ex, err] of Object.entries(exchangeErrors)) {
              console.log(chalk.yellow(`  ${ex}: ${err}`));
            }
            console.log();
          }
          return;
        }

        // Sort: biggest daily payment impact first
        results.sort((a, b) => Math.abs(b.dailyPayment) - Math.abs(a.dailyPayment));

        const totalHourly = results.reduce((s, r) => s + r.hourlyPayment, 0);
        const totalDaily = results.reduce((s, r) => s + r.dailyPayment, 0);
        const totalNotional = results.reduce((s, r) => s + r.notionalUsd, 0);
        const totalActualNet = results.reduce((s, r) => s + r.actualNet24h, 0);

        if (isJson()) {
          return printJson(jsonOk({
            positions: results.map(r => ({
              exchange: r.exchange,
              symbol: r.symbol,
              side: r.side,
              size: r.size,
              notionalUsd: Number(r.notionalUsd.toFixed(2)),
              fundingRate: r.fundingRate,
              annualPct: Number(r.annualPct.toFixed(2)),
              predicted: {
                hourly: Number(r.hourlyPayment.toFixed(6)),
                daily: Number(r.dailyPayment.toFixed(4)),
              },
              actual24h: {
                received: Number(r.actualReceived24h.toFixed(6)),
                paid: Number(r.actualPaid24h.toFixed(6)),
                net: Number(r.actualNet24h.toFixed(6)),
              },
              unrealizedPnl: r.unrealizedPnl,
            })),
            totals: {
              predicted: {
                hourly: Number(totalHourly.toFixed(6)),
                daily: Number(totalDaily.toFixed(4)),
              },
              actual24h: {
                net: Number(totalActualNet.toFixed(6)),
              },
              notionalUsd: Number(totalNotional.toFixed(2)),
            },
            errors: Object.keys(exchangeErrors).length > 0 ? exchangeErrors : undefined,
          }));
        }

        const exAbbr = (e: string) =>
          e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e.toUpperCase();

        console.log(chalk.cyan.bold("  Position Funding Impact\n"));

        const rows = results.map(r => {
          const sideColor = r.side === "long" ? chalk.green : chalk.red;
          const rateColor = r.fundingRate > 0 ? chalk.red : r.fundingRate < 0 ? chalk.green : chalk.white;
          // actual net: positive = received, negative = paid
          const actualColor = r.actualNet24h > 0 ? chalk.green : r.actualNet24h < 0 ? chalk.red : chalk.gray;
          const actualStr = r.actualNet24h !== 0
            ? actualColor(`${r.actualNet24h > 0 ? "+" : ""}$${r.actualNet24h.toFixed(4)}`)
            : chalk.gray("-");

          return [
            chalk.white.bold(exAbbr(r.exchange)),
            chalk.white.bold(r.symbol),
            sideColor(r.side.toUpperCase()),
            `$${formatUsd(r.notionalUsd)}`,
            rateColor(formatPercent(r.fundingRate)),
            rateColor(`${r.annualPct.toFixed(1)}%`),
            actualStr,
            formatPnl(r.unrealizedPnl),
          ];
        });

        console.log(makeTable(
          ["Ex", "Symbol", "Side", "Notional", "Rate(now)", "Annual(now)", "Actual 24h", "uPnL"],
          rows,
        ));

        // Summary
        const actualNetColor = totalActualNet >= 0 ? chalk.green : chalk.red;
        const predictColor = totalDaily >= 0 ? chalk.red : chalk.green;
        const predictSign = totalDaily >= 0 ? "-" : "+";
        console.log();
        console.log(`  Total Notional:      $${formatUsd(totalNotional)}`);
        console.log(`  Actual Net (24h):    ${actualNetColor(`${totalActualNet >= 0 ? "+" : ""}$${totalActualNet.toFixed(4)}`)}`);
        console.log(`  Predicted (now rate): ${predictColor(`${predictSign}$${Math.abs(totalDaily).toFixed(4)}/d`)}`);

        if (Object.keys(exchangeErrors).length > 0) {
          console.log();
          for (const [ex, err] of Object.entries(exchangeErrors)) {
            console.log(chalk.yellow(`  ${exAbbr(ex)}: ${err}`));
          }
        }

        console.log(chalk.gray("\n  Actual 24h: real funding received/paid in the last 24 hours."));
        console.log(chalk.gray("  Predicted: based on current rate only (changes every hour)."));
        console.log(chalk.gray("  + = received, - = paid\n"));
      });
    });
}

// ── Display helpers ──

function formatAvgRate(rate: number | null | undefined): string {
  if (rate == null) return chalk.gray("-");
  const annualPct = annualizeHourlyRate(rate);
  const color = annualPct > 0 ? chalk.red : annualPct < 0 ? chalk.green : chalk.white;
  return color(`${annualPct.toFixed(1)}%`);
}

/** Compute an "average spread" across rates that have avg24h data. */
function getAvgSpread(s: SymbolFundingComparison, windowKey: "avg8h" | "avg24h" | "avg7d"): string {
  const avgs = s.rates
    .filter(r => r.historicalAvg?.[windowKey] != null)
    .map(r => r.historicalAvg![windowKey]!);
  if (avgs.length < 2) return chalk.gray("-");
  const maxH = Math.max(...avgs);
  const minH = Math.min(...avgs);
  const spreadPct = annualizeHourlyRate(maxH - minH);
  return `${spreadPct.toFixed(1)}%`;
}

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

    // Use the highest-spread pair's historical averages for the avg columns
    // Show the best exchange's avg for quick reference
    const bestRate = hlRate ?? pacRate ?? ltRate;
    const avg8h = bestRate?.historicalAvg?.avg8h;
    const avg24h = bestRate?.historicalAvg?.avg24h;
    const avg7d = bestRate?.historicalAvg?.avg7d;

    return [
      chalk.white.bold(s.symbol),
      pacRate ? formatPercent(pacRate.fundingRate) : chalk.gray("-"),
      hlRate ? formatPercent(hlRate.fundingRate) : chalk.gray("-"),
      ltRate ? formatPercent(ltRate.fundingRate) : chalk.gray("-"),
      spreadColor(`${s.maxSpreadAnnual.toFixed(1)}%`),
      s.maxSpreadAnnual >= 5 ? `${exAbbr(s.shortExchange)}>${exAbbr(s.longExchange)}` : chalk.gray("-"),
      formatAvgRate(avg8h),
      formatAvgRate(avg24h),
      formatAvgRate(avg7d),
    ];
  });

  console.log(makeTable(
    ["Symbol", "Pacifica", "Hyperliquid", "Lighter", "Ann. Spread", "Direction", "Avg 8h", "Avg 24h", "Avg 7d"],
    rows,
  ));

  console.log(chalk.gray(`\n  ${snapshot.symbols.length} symbols compared across exchanges.`));
  console.log(chalk.gray(`  Rates: All exchanges per 1h. Spread is normalized.`));
  console.log(chalk.gray(`  Avg columns show best exchange's historical hourly rate annualized.\n`));
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
    const compHours = getExchangeCompoundingHours(r.exchange);
    const compoundedReturn = getCompoundedAnnualReturn(r.hourlyRate, compHours);
    const compoundedPct = (compoundedReturn * 100).toFixed(2);
    const color = r.fundingRate > 0 ? chalk.red : r.fundingRate < 0 ? chalk.green : chalk.white;

    console.log(`  ${chalk.white.bold(exAbbr(r.exchange).padEnd(4))} ` +
      `Raw: ${color(formatPercent(r.fundingRate).padEnd(14))} ` +
      `Hourly: ${hourlyPct}%  ` +
      `Annual: ${annualPct}%  ` +
      `APY(compounded): ${compoundedPct}%`
    );
  }

  // Show historical averages if available
  const hasHistorical = comparison.rates.some(r => r.historicalAvg != null);
  if (hasHistorical) {
    console.log(chalk.cyan("\n  Historical Averages (annualized):"));
    for (const r of comparison.rates) {
      if (!r.historicalAvg) continue;
      const avg8h = r.historicalAvg.avg8h != null ? `${annualizeHourlyRate(r.historicalAvg.avg8h).toFixed(1)}%` : "-";
      const avg24h = r.historicalAvg.avg24h != null ? `${annualizeHourlyRate(r.historicalAvg.avg24h).toFixed(1)}%` : "-";
      const avg7d = r.historicalAvg.avg7d != null ? `${annualizeHourlyRate(r.historicalAvg.avg7d).toFixed(1)}%` : "-";
      console.log(`  ${chalk.white.bold(exAbbr(r.exchange).padEnd(4))} ` +
        `8h: ${avg8h.padEnd(10)} 24h: ${avg24h.padEnd(10)} 7d: ${avg7d}`);
    }
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

  console.log(chalk.gray("\n  * Rates shown are current predictions. Actual settled rates may differ.\n"));
}
