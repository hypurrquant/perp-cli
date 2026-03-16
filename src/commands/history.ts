import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { printJson, jsonOk, jsonError, makeTable, formatUsd, formatPnl, withJsonErrors } from "../utils.js";
import { readExecutionLog, getExecutionStats, pruneExecutionLog } from "../execution-log.js";
import { readPositionHistory, getPositionStats } from "../position-history.js";
import {
  saveEquitySnapshot,
  readEquityHistory,
  computePnlMetrics,
  computeDailyPnl,
  aggregateWeekly,
  type EquitySnapshot,
} from "../equity-tracker.js";

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

export function registerHistoryCommands(
  program: Command,
  isJson: () => boolean,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
) {
  const history = program.command("history").description("Execution log & audit trail");

  // ── history list ──
  history
    .command("list")
    .description("Show recent executions")
    .option("-n, --limit <n>", "Number of records to show", "20")
    .option("-e, --exchange <exchange>", "Filter by exchange")
    .option("-s, --symbol <symbol>", "Filter by symbol")
    .option("-t, --type <type>", "Filter by type (market_order, limit_order, arb_entry, etc.)")
    .option("--since <date>", "Show records since date (ISO format or relative like '24h', '7d')")
    .option("--dry-run-only", "Show only dry-run simulations")
    .action(async (opts: {
      limit: string; exchange?: string; symbol?: string;
      type?: string; since?: string; dryRunOnly?: boolean;
    }) => {
      await withJsonErrors(isJson(), async () => {
        // Parse relative dates
        let since = opts.since;
        if (since) {
          const match = since.match(/^(\d+)(h|d|w)$/);
          if (match) {
            const [, num, unit] = match;
            const ms = { h: 3600000, d: 86400000, w: 604800000 }[unit] ?? 86400000;
            since = new Date(Date.now() - parseInt(num) * ms).toISOString();
          }
        }

        const records = readExecutionLog({
          limit: parseInt(opts.limit),
          exchange: opts.exchange,
          symbol: opts.symbol,
          type: opts.type,
          since,
          dryRunOnly: opts.dryRunOnly,
        });

        if (isJson()) {
          return printJson(jsonOk(records));
        }

        if (records.length === 0) {
          console.log(chalk.gray("\n  No execution records found.\n"));
          return;
        }

        console.log(chalk.cyan.bold(`\n  Execution History (${records.length} records)\n`));

        const rows = records.map(r => {
          const statusColor = r.status === "success"
            ? chalk.green
            : r.status === "simulated"
            ? chalk.blue
            : chalk.red;
          const sideColor = r.side === "buy" || r.side === "long" ? chalk.green : chalk.red;
          const time = new Date(r.timestamp).toLocaleString();
          const notional = r.notional ? `$${formatUsd(r.notional)}` : r.price ? `$${formatUsd(Number(r.price) * Number(r.size))}` : "-";
          return [
            chalk.gray(time),
            chalk.white(r.exchange),
            r.type.replace(/_/g, " "),
            chalk.white.bold(r.symbol),
            sideColor(r.side),
            r.size,
            notional,
            statusColor(r.status),
            r.dryRun ? chalk.blue("DRY") : "",
          ];
        });

        console.log(makeTable(
          ["Time", "Exchange", "Type", "Symbol", "Side", "Size", "Notional", "Status", ""],
          rows,
        ));
      });
    });

  // ── history stats (hidden alias for 'history summary') ──
  const statsCmd = history
    .command("stats")
    .description("Use 'history summary'")
    .option("--since <date>", "Stats since date (ISO or relative: 24h, 7d, 30d)")
    .action(async (opts: { since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        let since = opts.since;
        if (since) {
          const match = since.match(/^(\d+)(h|d|w)$/);
          if (match) {
            const [, num, unit] = match;
            const ms = { h: 3600000, d: 86400000, w: 604800000 }[unit] ?? 86400000;
            since = new Date(Date.now() - parseInt(num) * ms).toISOString();
          }
        }

        const stats = getExecutionStats(since);

        if (isJson()) {
          return printJson(jsonOk(stats));
        }

        console.log(chalk.cyan.bold("\n  Execution Stats\n"));
        console.log(`  Total Trades:    ${stats.totalTrades}`);
        console.log(`  Success Rate:    ${stats.successRate.toFixed(1)}%`);

        if (Object.keys(stats.byExchange).length > 0) {
          console.log(chalk.white.bold("\n  By Exchange:"));
          for (const [ex, count] of Object.entries(stats.byExchange)) {
            console.log(`    ${ex.padEnd(14)} ${count}`);
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
  (statsCmd as any)._hidden = true;

  // ── history positions ──
  history
    .command("positions")
    .description("Show position history (from event stream logging)")
    .option("-n, --limit <n>", "Number of records to show", "20")
    .option("-e, --exchange <exchange>", "Filter by exchange")
    .option("-s, --symbol <symbol>", "Filter by symbol")
    .option("--status <status>", "Filter by status (open, closed, updated)")
    .option("--since <date>", "Show records since date (ISO format or relative like '24h', '7d')")
    .option("--stats", "Show aggregate position stats instead of list")
    .action(async (opts: {
      limit: string; exchange?: string; symbol?: string;
      status?: string; since?: string; stats?: boolean;
    }) => {
      await withJsonErrors(isJson(), async () => {
        // Parse relative dates
        let since = opts.since;
        if (since) {
          const match = since.match(/^(\d+)(h|d|w)$/);
          if (match) {
            const [, num, unit] = match;
            const ms = { h: 3600000, d: 86400000, w: 604800000 }[unit] ?? 86400000;
            since = new Date(Date.now() - parseInt(num) * ms).toISOString();
          }
        }

        // Stats mode
        if (opts.stats) {
          const stats = getPositionStats({ exchange: opts.exchange, since });

          if (isJson()) {
            return printJson(jsonOk(stats));
          }

          console.log(chalk.cyan.bold("\n  Position Stats\n"));
          console.log(`  Total Trades:    ${stats.totalTrades}`);
          console.log(`  Wins / Losses:   ${chalk.green(String(stats.wins))} / ${chalk.red(String(stats.losses))}`);
          console.log(`  Win Rate:        ${stats.winRate.toFixed(1)}%`);
          console.log(`  Total P&L:       ${formatPnl(stats.totalPnl)}`);
          console.log(`  Avg P&L:         ${formatPnl(stats.avgPnl)}`);
          console.log(`  Best Trade:      ${formatPnl(stats.bestTrade)}`);
          console.log(`  Worst Trade:     ${formatPnl(stats.worstTrade)}`);

          if (stats.avgDuration > 0) {
            const fmtDur = (ms: number) => {
              if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
              if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
              return `${(ms / 3600000).toFixed(1)}h`;
            };
            console.log(`  Avg Duration:    ${fmtDur(stats.avgDuration)}`);
            console.log(`  Longest Trade:   ${fmtDur(stats.longestTrade)}`);
            console.log(`  Shortest Trade:  ${fmtDur(stats.shortestTrade)}`);
          }

          if (Object.keys(stats.bySymbol).length > 0) {
            console.log(chalk.white.bold("\n  By Symbol:"));
            for (const [sym, s] of Object.entries(stats.bySymbol)) {
              console.log(`    ${sym.padEnd(10)} ${s.trades} trades  ${formatPnl(s.pnl)}  ${s.winRate.toFixed(0)}% win`);
            }
          }

          if (Object.keys(stats.byExchange).length > 0) {
            console.log(chalk.white.bold("\n  By Exchange:"));
            for (const [ex, s] of Object.entries(stats.byExchange)) {
              console.log(`    ${ex.padEnd(14)} ${s.trades} trades  ${formatPnl(s.pnl)}`);
            }
          }
          console.log();
          return;
        }

        // List mode
        const records = readPositionHistory({
          limit: parseInt(opts.limit),
          exchange: opts.exchange,
          symbol: opts.symbol,
          status: opts.status,
          since,
        });

        if (isJson()) {
          return printJson(jsonOk(records));
        }

        if (records.length === 0) {
          console.log(chalk.gray("\n  No position records found. Use `perp stream events --log-positions` to start logging.\n"));
          return;
        }

        console.log(chalk.cyan.bold(`\n  Position History (${records.length} records)\n`));

        const rows = records.map(r => {
          const statusColor = r.status === "open"
            ? chalk.yellow
            : r.status === "closed"
            ? chalk.green
            : chalk.blue;
          const sideColor = r.side === "long" ? chalk.green : chalk.red;
          const time = new Date(r.updatedAt).toLocaleString();
          const pnl = r.realizedPnl ? formatPnl(Number(r.realizedPnl)) : r.unrealizedPnl ? chalk.gray(formatPnl(Number(r.unrealizedPnl))) : "-";
          const dur = r.duration
            ? r.duration < 60000
              ? `${(r.duration / 1000).toFixed(0)}s`
              : r.duration < 3600000
              ? `${(r.duration / 60000).toFixed(1)}m`
              : `${(r.duration / 3600000).toFixed(1)}h`
            : "-";
          return [
            chalk.gray(time),
            chalk.white(r.exchange),
            chalk.white.bold(r.symbol),
            sideColor(r.side),
            r.size,
            `$${formatUsd(r.entryPrice)}`,
            pnl,
            dur,
            statusColor(r.status),
          ];
        });

        console.log(makeTable(
          ["Time", "Exchange", "Symbol", "Side", "Size", "Entry", "P&L", "Duration", "Status"],
          rows,
        ));
      });
    });

  // ── history prune ──
  history
    .command("prune")
    .description("Remove old execution records")
    .option("--keep-days <days>", "Keep records from last N days", "30")
    .action(async (opts: { keepDays: string }) => {
      const pruned = pruneExecutionLog(parseInt(opts.keepDays));
      if (isJson()) {
        return printJson(jsonOk({ pruned }));
      }
      console.log(chalk.green(`\n  Pruned ${pruned} old records (keeping last ${opts.keepDays} days).\n`));
    });

  // ── Analytics subcommands (merged from analytics.ts) ──
  if (getAdapterForExchange) {
    registerAnalyticsSubcommands(history, getAdapterForExchange, isJson);

    // Keep deprecated top-level 'analytics' alias (hidden from help)
    const analytics = program.command("analytics").description("Use 'perp history'");
    (analytics as any)._hidden = true;
    registerAnalyticsSubcommands(analytics, getAdapterForExchange, isJson);
  }

  // ── PnL subcommands (merged from pnl.ts) ──
  if (getAdapterForExchange) {
    registerPnlSubcommands(history, getAdapterForExchange, isJson);

    // Deprecated top-level pnl alias
    const pnlAlias = program.command("pnl").description("Use 'perp history snapshot/daily/weekly/summary-perf'");
    (pnlAlias as any)._hidden = true;
    if (getAdapterForExchange) registerPnlSubcommands(pnlAlias, getAdapterForExchange, isJson);
  }

}

function registerAnalyticsSubcommands(
  parent: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  // ── analytics summary ──
  parent
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
  parent
    .command("pnl")
    .description("Realized P&L from exchange trade history (volume & fees by symbol/exchange)")
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
  parent
    .command("funding")
    .description("Funding payment aggregation across exchanges (net by symbol/exchange)")
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
  parent
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

function parseSinceDate(since?: string): Date | undefined {
  if (!since) return undefined;
  const match = since.match(/^(\d+)(h|d|w)$/);
  if (match) {
    const [, num, unit] = match;
    const ms = { h: 3600000, d: 86400000, w: 604800000 }[unit] ?? 86400000;
    return new Date(Date.now() - parseInt(num) * ms);
  }
  return new Date(since);
}

/** Take equity snapshot for given adapters. */
async function takeSnapshot(
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  exchanges: readonly string[],
): Promise<EquitySnapshot[]> {
  const ts = new Date().toISOString();
  const snaps: EquitySnapshot[] = [];

  const results = await Promise.allSettled(
    exchanges.map(async (ex) => {
      const adapter = await getAdapterForExchange(ex);
      const [balance, positions] = await Promise.all([
        adapter.getBalance(),
        adapter.getPositions(),
      ]);
      const snap: EquitySnapshot = {
        ts,
        exchange: ex,
        equity: Number(balance.equity),
        available: Number(balance.available),
        marginUsed: Number(balance.marginUsed),
        unrealizedPnl: Number(balance.unrealizedPnl),
        positionCount: positions.filter(p => Number(p.size) > 0).length,
      };
      saveEquitySnapshot(snap);
      return snap;
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") snaps.push(r.value);
  }
  return snaps;
}

function registerPnlSubcommands(
  parent: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  // ── snapshot ──
  parent
    .command("snapshot")
    .description("Take equity snapshot across all exchanges")
    .option("--exchanges <list>", "Comma-separated exchange list", EXCHANGES.join(","))
    .action(async (opts: { exchanges: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchanges.split(",").map(e => e.trim());
        const snaps = await takeSnapshot(getAdapterForExchange, exchanges);

        if (isJson()) {
          printJson(jsonOk({ snapshots: snaps }));
        } else {
          const total = snaps.reduce((s, sn) => s + sn.equity, 0);
          console.log(chalk.cyan.bold("Equity Snapshot\n"));
          for (const s of snaps) {
            console.log(
              `  ${s.exchange.padEnd(14)} $${formatUsd(s.equity)}  ` +
              `avail $${formatUsd(s.available)}  ` +
              `uPnL ${formatPnl(s.unrealizedPnl)}  ` +
              `pos: ${s.positionCount}`,
            );
          }
          console.log(`\n  ${"Total".padEnd(14)} $${formatUsd(total)}`);
          console.log(chalk.gray(`\n  Saved at ${snaps[0]?.ts ?? "—"}`));
        }
      });
    });

  // ── track ──
  parent
    .command("track")
    .description("Continuously track equity (foreground)")
    .option("--interval <sec>", "Snapshot interval in seconds", "300")
    .option("--exchanges <list>", "Comma-separated exchange list", EXCHANGES.join(","))
    .action(async (opts: { interval: string; exchanges: string }) => {
      const intervalMs = parseInt(opts.interval) * 1000;
      const exchanges = opts.exchanges.split(",").map(e => e.trim());

      console.log(chalk.cyan(`PnL tracker started — snapshot every ${opts.interval}s for [${exchanges.join(", ")}]`));
      console.log(chalk.gray("Press Ctrl+C to stop\n"));

      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort());

      // Initial snapshot
      const snaps = await takeSnapshot(getAdapterForExchange, exchanges);
      const total = snaps.reduce((s, sn) => s + sn.equity, 0);
      console.log(`${chalk.gray(new Date().toLocaleTimeString())} Total equity: $${formatUsd(total)}`);

      while (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (controller.signal.aborted) break;

        try {
          const s = await takeSnapshot(getAdapterForExchange, exchanges);
          const t = s.reduce((sum, sn) => sum + sn.equity, 0);
          const delta = t - total;
          console.log(
            `${chalk.gray(new Date().toLocaleTimeString())} ` +
            `Total: $${formatUsd(t)}  ${formatPnl(delta)}`,
          );
        } catch (err) {
          console.error(chalk.red(`Snapshot error: ${err instanceof Error ? err.message : err}`));
        }
      }
    });

  // ── daily-pnl ──
  parent
    .command("daily-pnl")
    .description("Daily PnL breakdown")
    .option("--exchange <name>", "Single exchange filter")
    .option("--days <n>", "Number of days to show", "14")
    .option("--since <period>", "Time range (e.g. 7d, 2w, 30d)")
    .action(async (opts: { exchange?: string; days: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSinceDate(opts.since) ?? new Date(Date.now() - parseInt(opts.days) * 86400000);
        const snapshots = readEquityHistory({ exchange: opts.exchange, since });

        if (snapshots.length === 0) {
          if (isJson()) {
            printJson(jsonError("NO_DATA", "No equity snapshots found. Run 'perp history snapshot' or 'perp history track' first."));
          } else {
            console.log(chalk.yellow("No equity snapshots found. Run 'perp history snapshot' or 'perp history track' first."));
          }
          return;
        }

        const daily = computeDailyPnl(snapshots, opts.exchange);

        if (isJson()) {
          printJson(jsonOk({ daily }));
        } else {
          console.log(chalk.cyan.bold(`Daily PnL${opts.exchange ? ` (${opts.exchange})` : ""}\n`));
          const head = ["Date", "Start", "End", "PnL", "PnL %"];
          const rows = daily.map(d => [
            d.date,
            `$${formatUsd(d.startEquity)}`,
            `$${formatUsd(d.endEquity)}`,
            formatPnl(d.pnl),
            `${d.pnlPct >= 0 ? "+" : ""}${d.pnlPct.toFixed(2)}%`,
          ]);
          console.log(makeTable(head, rows));
        }
      });
    });

  // ── weekly-pnl ──
  parent
    .command("weekly-pnl")
    .description("Weekly PnL breakdown")
    .option("--exchange <name>", "Single exchange filter")
    .option("--weeks <n>", "Number of weeks to show", "8")
    .option("--since <period>", "Time range (e.g. 4w, 8w)")
    .action(async (opts: { exchange?: string; weeks: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSinceDate(opts.since) ?? new Date(Date.now() - parseInt(opts.weeks) * 7 * 86400000);
        const snapshots = readEquityHistory({ exchange: opts.exchange, since });

        if (snapshots.length === 0) {
          if (isJson()) {
            printJson(jsonError("NO_DATA", "No equity snapshots found."));
          } else {
            console.log(chalk.yellow("No equity snapshots found. Run 'perp history snapshot' or 'perp history track' first."));
          }
          return;
        }

        const daily = computeDailyPnl(snapshots, opts.exchange);
        const weekly = aggregateWeekly(daily);

        if (isJson()) {
          printJson(jsonOk({ weekly }));
        } else {
          console.log(chalk.cyan.bold(`Weekly PnL${opts.exchange ? ` (${opts.exchange})` : ""}\n`));
          const head = ["Week", "Start", "End", "PnL", "PnL %"];
          const rows = weekly.map(w => [
            w.date,
            `$${formatUsd(w.startEquity)}`,
            `$${formatUsd(w.endEquity)}`,
            formatPnl(w.pnl),
            `${w.pnlPct >= 0 ? "+" : ""}${w.pnlPct.toFixed(2)}%`,
          ]);
          console.log(makeTable(head, rows));
        }
      });
    });

  // ── summary-perf ──
  parent
    .command("summary-perf")
    .description("Performance summary — Sharpe, drawdown, win rate")
    .option("--exchange <name>", "Single exchange filter")
    .option("--since <period>", "Time range (e.g. 7d, 30d, 12w)")
    .action(async (opts: { exchange?: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSinceDate(opts.since);
        const snapshots = readEquityHistory({ exchange: opts.exchange, since });

        if (snapshots.length === 0) {
          if (isJson()) {
            printJson(jsonError("NO_DATA", "No equity snapshots found."));
          } else {
            console.log(chalk.yellow("No equity snapshots found. Run 'perp history snapshot' or 'perp history track' first."));
          }
          return;
        }

        const metrics = computePnlMetrics(snapshots, opts.exchange);

        if (isJson()) {
          printJson(jsonOk({
            ...metrics,
            dailyReturns: undefined, // omit large array from JSON
            dailyCount: metrics.dailyReturns.length,
          }));
        } else {
          console.log(chalk.cyan.bold(`Performance Summary${opts.exchange ? ` (${opts.exchange})` : ""}\n`));
          console.log(`  Period:          ${metrics.period.from} → ${metrics.period.to} (${metrics.period.days} days)`);
          console.log(`  Total Return:    ${formatPnl(metrics.totalReturn)} (${metrics.totalReturnPct >= 0 ? "+" : ""}${metrics.totalReturnPct.toFixed(2)}%)`);
          console.log(`  Peak Equity:     $${formatUsd(metrics.peakEquity)}`);
          console.log(`  Avg Daily PnL:   ${formatPnl(metrics.avgDailyPnl)}`);
          console.log();
          console.log(`  Sharpe Ratio:    ${metrics.sharpeRatio >= 0 ? chalk.green(metrics.sharpeRatio.toFixed(2)) : chalk.red(metrics.sharpeRatio.toFixed(2))}`);
          console.log(`  Max Drawdown:    ${chalk.red(`$${formatUsd(metrics.maxDrawdown)}`)} (${chalk.red(`-${metrics.maxDrawdownPct.toFixed(2)}%`)})`);
          console.log(`  Current DD:      $${formatUsd(metrics.currentDrawdown)} (-${metrics.currentDrawdownPct.toFixed(2)}%)`);
          console.log();
          console.log(`  Win Days:        ${chalk.green(String(metrics.winDays))} / ${metrics.winDays + metrics.lossDays}`);
          console.log(`  Win Rate:        ${metrics.winRate.toFixed(1)}%`);
          if (metrics.bestDay) {
            console.log(`  Best Day:        ${metrics.bestDay.date}  ${formatPnl(metrics.bestDay.pnl)}`);
          }
          if (metrics.worstDay) {
            console.log(`  Worst Day:       ${metrics.worstDay.date}  ${formatPnl(metrics.worstDay.pnl)}`);
          }
        }
      });
    });
}
