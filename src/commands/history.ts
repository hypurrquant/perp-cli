import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk, makeTable, formatUsd, formatPnl, withJsonErrors } from "../utils.js";
import { readExecutionLog, getExecutionStats, pruneExecutionLog } from "../execution-log.js";
import { readPositionHistory, getPositionStats } from "../position-history.js";

export function registerHistoryCommands(program: Command, isJson: () => boolean) {
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

  // ── history stats ──
  history
    .command("stats")
    .description("Execution statistics summary")
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
}
