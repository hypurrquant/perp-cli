import { Command } from "commander";
import { printJson, jsonOk, jsonError, makeTable, formatUsd } from "../utils.js";
import { getHistoricalRates } from "../funding-history.js";
import chalk from "chalk";

export function registerBacktestCommands(
  program: Command,
  isJson: () => boolean,
) {
  const backtest = program.command("backtest").description("Backtest trading strategies on historical data");

  // ── Funding Arbitrage Backtest ──

  backtest
    .command("funding-arb")
    .description("Backtest funding rate arbitrage strategy")
    .requiredOption("--symbol <sym>", "Symbol to backtest (e.g., BTC)")
    .option("--days <n>", "Number of days to backtest", "30")
    .option("--spread-entry <pct>", "Annual spread % to enter (default: 10)", "10")
    .option("--spread-close <pct>", "Annual spread % to close (default: 5)", "5")
    .option("--exchanges <list>", "Comma-separated exchange pair (e.g., hyperliquid,pacifica)", "hyperliquid,pacifica")
    .option("--size-usd <usd>", "Position size in USD per leg", "1000")
    .action(async (opts: {
      symbol: string;
      days: string;
      spreadEntry: string;
      spreadClose: string;
      exchanges: string;
      sizeUsd: string;
    }) => {
      const sym = opts.symbol.toUpperCase();
      const days = parseInt(opts.days);
      const spreadEntry = parseFloat(opts.spreadEntry);
      const spreadClose = parseFloat(opts.spreadClose);
      const sizeUsd = parseFloat(opts.sizeUsd);
      const [exchA, exchB] = opts.exchanges.split(",").map(e => e.trim().toLowerCase());

      if (!exchA || !exchB) {
        if (isJson()) return printJson(jsonError("INVALID_PARAMS", "Need exactly 2 exchanges (e.g., --exchanges hyperliquid,pacifica)"));
        console.error(chalk.red("Error: Need exactly 2 exchanges (e.g., --exchanges hyperliquid,pacifica)"));
        process.exit(1);
      }

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);

      // Get historical funding data
      const ratesA = getHistoricalRates(sym, exchA, startTime, endTime);
      const ratesB = getHistoricalRates(sym, exchB, startTime, endTime);

      if (ratesA.length === 0 && ratesB.length === 0) {
        if (isJson()) return printJson(jsonError("NO_DATA", `No historical funding data for ${sym}. Run 'perp funding snapshot' first to collect data.`));
        console.log(chalk.yellow(`\n  No historical funding data for ${sym} on ${exchA}/${exchB}.`));
        console.log(chalk.yellow(`  Run 'perp funding snapshot' periodically to collect data first.\n`));
        return;
      }

      // Build time-aligned rate pairs
      const rateMap = new Map<string, { a?: number; b?: number }>();

      for (const r of ratesA) {
        // Round timestamp to nearest hour for alignment
        const hourKey = new Date(r.ts).toISOString().slice(0, 13);
        if (!rateMap.has(hourKey)) rateMap.set(hourKey, {});
        rateMap.get(hourKey)!.a = r.hourlyRate;
      }
      for (const r of ratesB) {
        const hourKey = new Date(r.ts).toISOString().slice(0, 13);
        if (!rateMap.has(hourKey)) rateMap.set(hourKey, {});
        rateMap.get(hourKey)!.b = r.hourlyRate;
      }

      // Sort by time
      const sortedKeys = [...rateMap.keys()].sort();

      // Simulate
      let inPosition = false;
      let entrySpread = 0;
      let entryTime = "";
      let totalTrades = 0;
      let totalFundingCollected = 0;
      let totalHoldingHours = 0;
      const trades: Array<{ entryTime: string; exitTime: string; holdingHours: number; fundingCollected: number; spread: number }> = [];

      for (const key of sortedKeys) {
        const pair = rateMap.get(key)!;
        if (pair.a === undefined || pair.b === undefined) continue;

        // Annual spread = |rateA - rateB| * 8760 * 100
        const hourlySpread = Math.abs(pair.a - pair.b);
        const annualSpreadPct = hourlySpread * 8760 * 100;

        if (!inPosition && annualSpreadPct >= spreadEntry) {
          inPosition = true;
          entrySpread = annualSpreadPct;
          entryTime = key;
        } else if (inPosition && annualSpreadPct < spreadClose) {
          // Close position
          const holdingHours = (new Date(key).getTime() - new Date(entryTime).getTime()) / (1000 * 60 * 60);
          // Funding collected = sum of hourly spreads during holding period
          let fundingCollected = 0;
          for (const hk of sortedKeys) {
            if (hk >= entryTime && hk <= key) {
              const p = rateMap.get(hk)!;
              if (p.a !== undefined && p.b !== undefined) {
                fundingCollected += Math.abs(p.a - p.b) * sizeUsd;
              }
            }
          }

          trades.push({
            entryTime,
            exitTime: key,
            holdingHours,
            fundingCollected,
            spread: entrySpread,
          });
          totalTrades++;
          totalFundingCollected += fundingCollected;
          totalHoldingHours += holdingHours;
          inPosition = false;
        }
      }

      // Summary
      const avgHoldingHours = totalTrades > 0 ? totalHoldingHours / totalTrades : 0;
      // Rough PnL estimate: funding collected minus estimated trading costs (0.1% per trade * 2 legs * 2 trades)
      const tradingCosts = totalTrades * 2 * 2 * sizeUsd * 0.001;
      const netPnl = totalFundingCollected - tradingCosts;

      const summary = {
        symbol: sym,
        exchanges: `${exchA} vs ${exchB}`,
        period: `${days} days`,
        dataPoints: sortedKeys.length,
        spreadEntryThreshold: `${spreadEntry}%`,
        spreadCloseThreshold: `${spreadClose}%`,
        sizeUsd,
        totalTrades,
        avgHoldingPeriod: `${avgHoldingHours.toFixed(1)}h`,
        totalFundingCollected: `$${totalFundingCollected.toFixed(2)}`,
        tradingCosts: `$${tradingCosts.toFixed(2)}`,
        netPnl: `$${netPnl.toFixed(2)}`,
        trades,
      };

      if (isJson()) return printJson(jsonOk(summary));

      console.log(chalk.cyan.bold(`\n  Funding Arb Backtest — ${sym}\n`));
      console.log(`  Exchanges:      ${exchA} vs ${exchB}`);
      console.log(`  Period:         ${days} days (${sortedKeys.length} data points)`);
      console.log(`  Entry spread:   >= ${spreadEntry}% annualized`);
      console.log(`  Close spread:   < ${spreadClose}% annualized`);
      console.log(`  Size per leg:   $${formatUsd(String(sizeUsd))}`);
      console.log();
      console.log(chalk.white.bold(`  Results:`));
      console.log(`  Total trades:          ${totalTrades}`);
      console.log(`  Avg holding period:    ${avgHoldingHours.toFixed(1)}h`);
      console.log(`  Funding collected:     ${chalk.green(`$${totalFundingCollected.toFixed(2)}`)}`);
      console.log(`  Trading costs:         ${chalk.red(`$${tradingCosts.toFixed(2)}`)}`);
      const pnlColor = netPnl >= 0 ? chalk.green : chalk.red;
      console.log(`  Net PnL:               ${pnlColor(`$${netPnl.toFixed(2)}`)}`);

      if (trades.length > 0) {
        console.log(chalk.white.bold(`\n  Trade History:`));
        const rows = trades.map((t, i) => [
          String(i + 1),
          t.entryTime.replace("T", " "),
          t.exitTime.replace("T", " "),
          `${t.holdingHours.toFixed(1)}h`,
          `${t.spread.toFixed(1)}%`,
          `$${t.fundingCollected.toFixed(2)}`,
        ]);
        console.log(makeTable(["#", "Entry", "Exit", "Duration", "Spread", "Funding"], rows));
      }
      console.log();
    });

  // ── Grid Backtest ──

  backtest
    .command("grid")
    .description("Backtest grid trading strategy on historical klines")
    .requiredOption("--symbol <sym>", "Symbol to backtest (e.g., ETH)")
    .requiredOption("--upper <price>", "Upper price bound")
    .requiredOption("--lower <price>", "Lower price bound")
    .option("--grids <n>", "Number of grid lines", "10")
    .option("--days <n>", "Number of days to backtest", "7")
    .option("--size <base>", "Size per grid in base currency", "0.1")
    .action(async (opts: {
      symbol: string;
      upper: string;
      lower: string;
      grids: string;
      days: string;
      size: string;
    }) => {
      const sym = opts.symbol.toUpperCase();
      const upperPrice = parseFloat(opts.upper);
      const lowerPrice = parseFloat(opts.lower);
      const grids = parseInt(opts.grids);
      const days = parseInt(opts.days);
      const sizePerGrid = parseFloat(opts.size);

      if (upperPrice <= lowerPrice) {
        if (isJson()) return printJson(jsonError("INVALID_PARAMS", "Upper price must be greater than lower price"));
        console.error(chalk.red("Error: Upper price must be greater than lower price"));
        process.exit(1);
      }

      if (grids < 2) {
        if (isJson()) return printJson(jsonError("INVALID_PARAMS", "Need at least 2 grid lines"));
        console.error(chalk.red("Error: Need at least 2 grid lines"));
        process.exit(1);
      }

      const endTime = Date.now();
      const startTime = endTime - days * 24 * 60 * 60 * 1000;

      // Fetch historical klines from Hyperliquid
      if (!isJson()) {
        console.log(chalk.gray(`\n  Fetching ${days}d of 1h klines for ${sym}...`));
      }

      let klines: Array<{ t: number; o: string; h: string; l: string; c: string }>;
      try {
        const resp = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: {
              coin: sym,
              interval: "1h",
              startTime,
              endTime,
            },
          }),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json() as Array<{ t: number; o: string; h: string; l: string; c: string; v: string; n: number }>;
        klines = data.map(k => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJson()) return printJson(jsonError("FETCH_ERROR", `Failed to fetch klines: ${msg}`));
        console.error(chalk.red(`Error fetching klines: ${msg}`));
        process.exit(1);
      }

      if (klines.length === 0) {
        if (isJson()) return printJson(jsonError("NO_DATA", `No kline data for ${sym}`));
        console.log(chalk.yellow(`\n  No kline data available for ${sym}.\n`));
        return;
      }

      // Build grid levels
      const step = (upperPrice - lowerPrice) / (grids - 1);
      const gridLevels: number[] = [];
      for (let i = 0; i < grids; i++) {
        gridLevels.push(lowerPrice + step * i);
      }

      // Simulate grid fills
      // Track which grid levels have pending orders (buy below current, sell above)
      let totalTrades = 0;
      let totalProfit = 0;
      let maxDrawdown = 0;
      let currentDrawdown = 0;
      let peakProfit = 0;
      const filledBuys = new Set<number>(); // grid indices that have been bought

      // Initialize: determine initial grid state based on first kline
      const firstPrice = parseFloat(klines[0].c);
      for (let i = 0; i < gridLevels.length; i++) {
        if (gridLevels[i] < firstPrice) {
          // Below current price: place buy orders (unfilled)
        } else {
          // Above current price: assume we've "bought" these to sell
          filledBuys.add(i);
        }
      }

      for (const kline of klines) {
        const low = parseFloat(kline.l);
        const high = parseFloat(kline.h);

        // Check buy fills (price dipped to grid level)
        for (let i = 0; i < gridLevels.length; i++) {
          if (!filledBuys.has(i) && low <= gridLevels[i]) {
            filledBuys.add(i);
            totalTrades++;
            // Bought at grid level
          }
        }

        // Check sell fills (price rose to grid level)
        for (let i = 0; i < gridLevels.length; i++) {
          if (filledBuys.has(i) && high >= gridLevels[i] && i > 0) {
            // Check if there's a higher grid to sell at
            const sellIdx = i;
            // Find next unfilled buy below to pair with
            for (let j = sellIdx - 1; j >= 0; j--) {
              if (filledBuys.has(j)) continue;
              // Grid profit = sell level - buy level
              break;
            }
            // Simple model: profit is one step worth
            if (filledBuys.has(i)) {
              filledBuys.delete(i);
              totalTrades++;
              totalProfit += step * sizePerGrid;
            }
          }
        }

        // Track drawdown
        if (totalProfit > peakProfit) peakProfit = totalProfit;
        currentDrawdown = peakProfit - totalProfit;
        if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
      }

      // Calculate some stats
      const lastPrice = parseFloat(klines[klines.length - 1].c);
      const priceRange = `$${formatUsd(String(Math.min(...klines.map(k => parseFloat(k.l)))))} - $${formatUsd(String(Math.max(...klines.map(k => parseFloat(k.h)))))}`;
      const tradingFees = totalTrades * sizePerGrid * lastPrice * 0.00035; // ~0.035% per trade
      const netProfit = totalProfit - tradingFees;

      const summary = {
        symbol: sym,
        period: `${days} days`,
        klines: klines.length,
        priceRange,
        gridRange: `$${formatUsd(String(lowerPrice))} - $${formatUsd(String(upperPrice))}`,
        grids,
        step: `$${step.toFixed(2)}`,
        sizePerGrid,
        totalTrades,
        grossProfit: `$${totalProfit.toFixed(2)}`,
        tradingFees: `$${tradingFees.toFixed(2)}`,
        netProfit: `$${netProfit.toFixed(2)}`,
        maxDrawdown: `$${maxDrawdown.toFixed(2)}`,
        profitPerTrade: totalTrades > 0 ? `$${(netProfit / totalTrades).toFixed(2)}` : "$0.00",
      };

      if (isJson()) return printJson(jsonOk(summary));

      console.log(chalk.cyan.bold(`\n  Grid Backtest — ${sym}\n`));
      console.log(`  Period:         ${days} days (${klines.length} candles)`);
      console.log(`  Price range:    ${priceRange}`);
      console.log(`  Grid range:     $${formatUsd(String(lowerPrice))} - $${formatUsd(String(upperPrice))}`);
      console.log(`  Grid lines:     ${grids} (step: $${step.toFixed(2)})`);
      console.log(`  Size per grid:  ${sizePerGrid}`);
      console.log();
      console.log(chalk.white.bold(`  Results:`));
      console.log(`  Total trades:          ${totalTrades}`);
      console.log(`  Gross profit:          ${chalk.green(`$${totalProfit.toFixed(2)}`)}`);
      console.log(`  Trading fees:          ${chalk.red(`$${tradingFees.toFixed(2)}`)}`);
      const pnlColor = netProfit >= 0 ? chalk.green : chalk.red;
      console.log(`  Net profit:            ${pnlColor(`$${netProfit.toFixed(2)}`)}`);
      console.log(`  Max drawdown:          ${chalk.red(`$${maxDrawdown.toFixed(2)}`)}`);
      if (totalTrades > 0) {
        console.log(`  Avg profit/trade:      $${(netProfit / totalTrades).toFixed(2)}`);
      }
      console.log();
    });
}
