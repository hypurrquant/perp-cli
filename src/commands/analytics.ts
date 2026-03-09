import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { printJson, jsonOk, makeTable, formatUsd, formatPnl, withJsonErrors } from "../utils.js";
import { readExecutionLog, getExecutionStats } from "../execution-log.js";

const EXCHANGES = ["pacifica", "hyperliquid", "lighter"] as const;

function parseSince(since?: string): string | undefined {
  if (!since) return undefined;
  const match = since.match(/^(\d+)(h|d|w)$/);
  if (match) {
    const [, num, unit] = match;
    const ms = { h: 3600000, d: 86400000, w: 604800000 }[unit] ?? 86400000;
    return new Date(Date.now() - parseInt(num) * ms).toISOString();
  }
  return since;
}

export function registerAnalyticsCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const analytics = program.command("analytics").description("Trading performance analytics");

  // ── analytics summary ──
  analytics
    .command("summary")
    .description("Execution log summary statistics")
    .option("--since <period>", "Period: 24h, 7d, 30d, or ISO date")
    .action(async (opts: { since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSince(opts.since);
        const stats = getExecutionStats(since);
        const records = readExecutionLog({ since });

        // Calculate volume
        let totalVolume = 0;
        for (const r of records) {
          if (r.notional) totalVolume += r.notional;
          else if (r.price && r.size) totalVolume += Number(r.price) * Number(r.size);
        }

        const result = { ...stats, totalVolume, period: opts.since ?? "all time" };

        if (isJson()) return printJson(jsonOk(result));

        console.log(chalk.cyan.bold(`\n  Trading Summary ${opts.since ? `(${opts.since})` : "(all time)"}\n`));
        console.log(`  Total Trades:     ${stats.totalTrades}`);
        console.log(`  Success Rate:     ${stats.successRate.toFixed(1)}%`);
        console.log(`  Total Volume:     $${formatUsd(totalVolume)}`);

        if (Object.keys(stats.byExchange).length > 0) {
          console.log(chalk.white.bold("\n  By Exchange:"));
          for (const [ex, count] of Object.entries(stats.byExchange)) {
            console.log(`    ${ex.padEnd(14)} ${count} trades`);
          }
        }

        if (Object.keys(stats.byType).length > 0) {
          console.log(chalk.white.bold("\n  By Type:"));
          for (const [type, count] of Object.entries(stats.byType)) {
            console.log(`    ${type.replace(/_/g, " ").padEnd(14)} ${count}`);
          }
        }

        if (stats.recentErrors.length > 0) {
          console.log(chalk.red.bold("\n  Recent Errors:"));
          for (const err of stats.recentErrors) {
            console.log(`    ${chalk.red(err)}`);
          }
        }
        console.log();
      });
    });

  // ── analytics pnl ──
  analytics
    .command("pnl")
    .description("Realized P&L from exchange trade history")
    .option("-e, --exchange <exchanges>", "Comma-separated exchanges")
    .option("--since <period>", "Period: 24h, 7d, 30d")
    .option("-n, --limit <n>", "Trade history limit per exchange", "100")
    .action(async (opts: { exchange?: string; since?: string; limit: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

        const limit = parseInt(opts.limit);
        const sinceMs = opts.since ? new Date(parseSince(opts.since)!).getTime() : 0;

        interface TradeWithExchange {
          exchange: string;
          symbol: string;
          side: string;
          price: number;
          size: number;
          fee: number;
          time: number;
        }

        const allTrades: TradeWithExchange[] = [];

        await Promise.allSettled(
          exchanges.map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              const trades = await adapter.getTradeHistory(limit);
              for (const t of trades) {
                if (sinceMs && t.time < sinceMs) continue;
                allTrades.push({
                  exchange: ex,
                  symbol: t.symbol,
                  side: t.side,
                  price: Number(t.price),
                  size: Number(t.size),
                  fee: Number(t.fee),
                  time: t.time,
                });
              }
            } catch { /* skip unavailable exchanges */ }
          }),
        );

        // Aggregate by symbol
        const bySymbol = new Map<string, { volume: number; fees: number; trades: number }>();
        const byExchange = new Map<string, { volume: number; fees: number; trades: number }>();
        let totalVolume = 0;
        let totalFees = 0;

        for (const t of allTrades) {
          const notional = t.price * t.size;
          totalVolume += notional;
          totalFees += t.fee;

          const sym = bySymbol.get(t.symbol) ?? { volume: 0, fees: 0, trades: 0 };
          sym.volume += notional;
          sym.fees += t.fee;
          sym.trades++;
          bySymbol.set(t.symbol, sym);

          const ex = byExchange.get(t.exchange) ?? { volume: 0, fees: 0, trades: 0 };
          ex.volume += notional;
          ex.fees += t.fee;
          ex.trades++;
          byExchange.set(t.exchange, ex);
        }

        const result = {
          totalTrades: allTrades.length,
          totalVolume,
          totalFees,
          netAfterFees: -totalFees, // realized PnL would need entry/exit matching; fees are definite cost
          bySymbol: Object.fromEntries(bySymbol),
          byExchange: Object.fromEntries(byExchange),
        };

        if (isJson()) return printJson(jsonOk(result));

        console.log(chalk.cyan.bold(`\n  Realized Trading P&L ${opts.since ? `(${opts.since})` : ""}\n`));
        console.log(`  Total Trades:    ${allTrades.length}`);
        console.log(`  Total Volume:    $${formatUsd(totalVolume)}`);
        console.log(`  Total Fees:      ${chalk.red(`-$${formatUsd(totalFees)}`)}`);

        if (bySymbol.size > 0) {
          console.log(chalk.white.bold("\n  By Symbol:"));
          const symRows = [...bySymbol.entries()]
            .sort((a, b) => b[1].volume - a[1].volume)
            .map(([sym, d]) => [
              chalk.white.bold(sym),
              String(d.trades),
              `$${formatUsd(d.volume)}`,
              chalk.red(`-$${formatUsd(d.fees)}`),
            ]);
          console.log(makeTable(["Symbol", "Trades", "Volume", "Fees"], symRows));
        }

        if (byExchange.size > 0) {
          console.log(chalk.white.bold("  By Exchange:"));
          const exRows = [...byExchange.entries()].map(([ex, d]) => [
            chalk.white.bold(ex),
            String(d.trades),
            `$${formatUsd(d.volume)}`,
            chalk.red(`-$${formatUsd(d.fees)}`),
          ]);
          console.log(makeTable(["Exchange", "Trades", "Volume", "Fees"], exRows));
        }
      });
    });

  // ── analytics funding ──
  analytics
    .command("funding")
    .description("Funding payment history across exchanges")
    .option("-e, --exchange <exchanges>", "Comma-separated exchanges")
    .option("-s, --symbol <symbol>", "Filter by symbol")
    .option("-n, --limit <n>", "Funding history limit per exchange", "50")
    .action(async (opts: { exchange?: string; symbol?: string; limit: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

        interface FundingEntry {
          exchange: string;
          symbol: string;
          payment: number;
          time: number;
        }

        const allFunding: FundingEntry[] = [];

        await Promise.allSettled(
          exchanges.map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              const payments = await adapter.getFundingPayments(parseInt(opts.limit));
              for (const p of payments) {
                if (opts.symbol && !p.symbol.toUpperCase().includes(opts.symbol.toUpperCase())) continue;
                allFunding.push({
                  exchange: ex,
                  symbol: p.symbol,
                  payment: Number(p.payment),
                  time: p.time,
                });
              }
            } catch { /* skip */ }
          }),
        );

        // Aggregate
        const bySymbol = new Map<string, number>();
        const byExchange = new Map<string, number>();
        let totalFunding = 0;

        for (const f of allFunding) {
          totalFunding += f.payment;
          bySymbol.set(f.symbol, (bySymbol.get(f.symbol) ?? 0) + f.payment);
          byExchange.set(f.exchange, (byExchange.get(f.exchange) ?? 0) + f.payment);
        }

        const result = {
          totalPayments: allFunding.length,
          totalFunding,
          bySymbol: Object.fromEntries(bySymbol),
          byExchange: Object.fromEntries(byExchange),
        };

        if (isJson()) return printJson(jsonOk(result));

        console.log(chalk.cyan.bold("\n  Funding Payment Summary\n"));
        console.log(`  Total Payments:  ${allFunding.length}`);
        console.log(`  Net Funding:     ${formatPnl(totalFunding)}`);

        if (bySymbol.size > 0) {
          console.log(chalk.white.bold("\n  By Symbol:"));
          const rows = [...bySymbol.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([sym, amt]) => [chalk.white.bold(sym), formatPnl(amt)]);
          console.log(makeTable(["Symbol", "Net Funding"], rows));
        }

        if (byExchange.size > 0) {
          console.log(chalk.white.bold("  By Exchange:"));
          const rows = [...byExchange.entries()]
            .map(([ex, amt]) => [chalk.white.bold(ex), formatPnl(amt)]);
          console.log(makeTable(["Exchange", "Net Funding"], rows));
        }
      });
    });

  // ── analytics report ──
  analytics
    .command("report")
    .description("Full performance report (summary + pnl + funding)")
    .option("-e, --exchange <exchanges>", "Comma-separated exchanges")
    .option("--since <period>", "Period: 24h, 7d, 30d")
    .action(async (opts: { exchange?: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSince(opts.since);
        const stats = getExecutionStats(since);
        const records = readExecutionLog({ since });

        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

        // Volume from log
        let logVolume = 0;
        for (const r of records) {
          if (r.notional) logVolume += r.notional;
        }

        // Fetch live data from exchanges
        let totalFunding = 0;
        let totalFees = 0;
        let totalEquity = 0;
        let totalUPnl = 0;
        const symbolSet = new Set<string>();

        await Promise.allSettled(
          exchanges.map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              const [balance, trades, funding] = await Promise.all([
                adapter.getBalance(),
                adapter.getTradeHistory(50).catch(() => []),
                adapter.getFundingPayments(50).catch(() => []),
              ]);
              totalEquity += Number(balance.equity);
              totalUPnl += Number(balance.unrealizedPnl);
              for (const t of trades) {
                totalFees += Number(t.fee);
                symbolSet.add(t.symbol);
              }
              for (const f of funding) totalFunding += Number(f.payment);
            } catch { /* skip */ }
          }),
        );

        const report = {
          period: opts.since ?? "all time",
          execution: {
            totalTrades: stats.totalTrades,
            successRate: stats.successRate,
            volume: logVolume,
            byExchange: stats.byExchange,
            byType: stats.byType,
          },
          portfolio: {
            totalEquity,
            unrealizedPnl: totalUPnl,
          },
          costs: {
            totalFees,
            totalFunding,
            netFunding: totalFunding,
          },
          insights: {
            uniqueSymbols: symbolSet.size,
            mostActiveExchange: Object.entries(stats.byExchange).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
            avgTradesPerDay: stats.totalTrades > 0
              ? (stats.totalTrades / Math.max(1, (Date.now() - new Date(records[records.length - 1]?.timestamp ?? Date.now()).getTime()) / 86400000)).toFixed(1)
              : "0",
          },
        };

        if (isJson()) return printJson(jsonOk(report));

        console.log(chalk.cyan.bold(`\n  Performance Report ${opts.since ? `(${opts.since})` : ""}\n`));
        console.log(chalk.white.bold("  Execution"));
        console.log(`    Trades:          ${stats.totalTrades} (${stats.successRate.toFixed(0)}% success)`);
        console.log(`    Volume:          $${formatUsd(logVolume)}`);
        console.log(`    Symbols Traded:  ${symbolSet.size}`);
        console.log(`    Avg/Day:         ${report.insights.avgTradesPerDay}`);

        console.log(chalk.white.bold("\n  Portfolio"));
        console.log(`    Total Equity:    $${formatUsd(totalEquity)}`);
        console.log(`    Unrealized PnL:  ${formatPnl(totalUPnl)}`);

        console.log(chalk.white.bold("\n  Costs & Income"));
        console.log(`    Trading Fees:    ${chalk.red(`-$${formatUsd(totalFees)}`)}`);
        console.log(`    Funding Income:  ${formatPnl(totalFunding)}`);
        console.log(`    Net:             ${formatPnl(totalFunding - totalFees)}`);
        console.log();
      });
    });
}
