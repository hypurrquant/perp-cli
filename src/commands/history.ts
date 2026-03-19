import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { printJson, jsonOk, jsonError, makeTable, formatUsd, formatPnl, withJsonErrors } from "../utils.js";
import { readExecutionLog, getExecutionStats, pruneExecutionLog } from "../execution-log.js";
import { loadArbState } from "../arb/index.js";
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

/** Parse period string (7d, 30d, 90d) to milliseconds. Returns undefined for "all" or missing. */
function parsePeriodMs(period?: string): number | undefined {
  if (!period || period === "all") return undefined;
  const match = period.match(/^(\d+)(h|d|w|m)$/);
  if (!match) return undefined;
  const [, num, unit] = match;
  const ms = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 }[unit] ?? 86400000;
  return parseInt(num) * ms;
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
    const pnlAlias = program.command("pnl").description("Use 'perp history perf --period daily|weekly|summary'");
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
    .description("P&L analysis — trades, fees, funding income with daily breakdown")
    .option("-e, --exchange <exchanges>", "Comma-separated exchanges")
    .option("--period <duration>", "Time period: 7d, 30d, 90d, all (default: all)")
    .option("--since <period>", "Alias for --period")
    .option("-n, --limit <n>", "History limit per exchange", "200")
    .action(async (opts: { exchange?: string; period?: string; since?: string; limit: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

        const period = opts.period ?? opts.since;
        const periodMs = parsePeriodMs(period);
        const sinceMs = periodMs ? Date.now() - periodMs : 0;
        const limit = parseInt(opts.limit);

        interface TradeEntry { exchange: string; symbol: string; side: string; price: number; size: number; fee: number; time: number }
        interface FundingEntry { exchange: string; symbol: string; payment: number; time: number }

        const allTrades: TradeEntry[] = [];
        const allFunding: FundingEntry[] = [];

        // Fetch trades + funding in parallel from all exchanges
        await Promise.allSettled(
          exchanges.map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              const [trades, funding] = await Promise.all([
                adapter.getTradeHistory(limit),
                adapter.getFundingPayments(limit),
              ]);
              for (const t of trades) {
                if (sinceMs && t.time < sinceMs) continue;
                allTrades.push({ exchange: ex, symbol: t.symbol, side: t.side, price: Number(t.price), size: Number(t.size), fee: Number(t.fee), time: t.time });
              }
              for (const f of funding) {
                if (sinceMs && f.time < sinceMs) continue;
                allFunding.push({ exchange: ex, symbol: f.symbol, payment: Number(f.payment), time: f.time });
              }
            } catch { /* skip unavailable exchanges */ }
          }),
        );

        // Aggregate by exchange
        const byExchange = new Map<string, { trades: number; volume: number; fees: number; funding: number }>();
        let totalVolume = 0;
        let totalFees = 0;
        let totalFunding = 0;

        for (const t of allTrades) {
          const notional = t.price * t.size;
          totalVolume += notional;
          totalFees += t.fee;
          const ex = byExchange.get(t.exchange) ?? { trades: 0, volume: 0, fees: 0, funding: 0 };
          ex.trades++;
          ex.volume += notional;
          ex.fees += t.fee;
          byExchange.set(t.exchange, ex);
        }

        for (const f of allFunding) {
          totalFunding += f.payment;
          const ex = byExchange.get(f.exchange) ?? { trades: 0, volume: 0, fees: 0, funding: 0 };
          ex.funding += f.payment;
          byExchange.set(f.exchange, ex);
        }

        const netPnl = totalFunding - totalFees;

        // Daily PnL breakdown (fees + funding combined)
        const dailyMap = new Map<string, { fees: number; funding: number }>();
        for (const t of allTrades) {
          const day = new Date(t.time).toISOString().slice(0, 10);
          const d = dailyMap.get(day) ?? { fees: 0, funding: 0 };
          d.fees += t.fee;
          dailyMap.set(day, d);
        }
        for (const f of allFunding) {
          const day = new Date(f.time).toISOString().slice(0, 10);
          const d = dailyMap.get(day) ?? { fees: 0, funding: 0 };
          d.funding += f.payment;
          dailyMap.set(day, d);
        }

        const daily = [...dailyMap.entries()]
          .sort()
          .map(([date, d]) => ({ date, fees: d.fees, funding: d.funding, net: d.funding - d.fees }));

        const result = {
          period: period ?? "all",
          totalTrades: allTrades.length,
          totalVolume,
          totalFees,
          totalFunding,
          netPnl,
          byExchange: Object.fromEntries(
            [...byExchange.entries()].map(([ex, d]) => [ex, { ...d, netPnl: d.funding - d.fees }]),
          ),
          daily,
        };

        if (isJson()) return printJson(jsonOk(result));

        // ── Terminal output ──
        console.log(chalk.cyan.bold(`\n  P&L Report${period ? ` (${period})` : ""}\n`));
        console.log(`  Total Trades:    ${allTrades.length}`);
        console.log(`  Total Volume:    $${formatUsd(totalVolume)}`);
        console.log(`  Trading Fees:    ${chalk.red(`-$${formatUsd(totalFees)}`)}`);
        console.log(`  Funding Income:  ${formatPnl(totalFunding)}`);
        console.log(`  Net P&L:         ${formatPnl(netPnl)}`);

        if (byExchange.size > 0) {
          console.log(chalk.white.bold("\n  By Exchange:"));
          const rows = [...byExchange.entries()].map(([ex, d]) => [
            chalk.white.bold(ex),
            String(d.trades),
            `$${formatUsd(d.volume)}`,
            chalk.red(`-$${formatUsd(d.fees)}`),
            formatPnl(d.funding),
            formatPnl(d.funding - d.fees),
          ]);
          console.log(makeTable(["Exchange", "Trades", "Volume", "Fees", "Funding", "Net P&L"], rows));
        }

        if (daily.length > 0) {
          console.log(chalk.white.bold("  Daily P&L:"));
          let cumulative = 0;
          const rows = daily.map(d => {
            cumulative += d.net;
            return [d.date, chalk.red(`-$${formatUsd(d.fees)}`), formatPnl(d.funding), formatPnl(d.net), formatPnl(cumulative)];
          });
          console.log(makeTable(["Date", "Fees", "Funding", "Net", "Cumulative"], rows));
        }
      });
    });

  // ── analytics funding ──
  parent
    .command("funding")
    .description("Funding income analysis — cumulative, daily, per-arb-position breakdown")
    .option("-e, --exchange <exchanges>", "Comma-separated exchanges")
    .option("-s, --symbol <symbol>", "Filter by symbol")
    .option("--period <duration>", "Time period: 7d, 30d, 90d, all (default: all)")
    .option("--daily", "Show daily funding breakdown")
    .option("-n, --limit <n>", "Funding history limit per exchange", "200")
    .action(async (opts: { exchange?: string; symbol?: string; period?: string; daily?: boolean; limit: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

        const periodMs = parsePeriodMs(opts.period);
        const sinceMs = periodMs ? Date.now() - periodMs : 0;

        interface FundingEntry { exchange: string; symbol: string; payment: number; time: number }
        const allFunding: FundingEntry[] = [];

        // Fetch funding payments and current positions in parallel
        const positionNotionals = new Map<string, number>();

        await Promise.allSettled(
          exchanges.map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              const [payments, positions] = await Promise.all([
                adapter.getFundingPayments(parseInt(opts.limit)),
                adapter.getPositions(),
              ]);
              for (const p of payments) {
                if (sinceMs && p.time < sinceMs) continue;
                if (opts.symbol && !p.symbol.toUpperCase().includes(opts.symbol.toUpperCase())) continue;
                allFunding.push({ exchange: ex, symbol: p.symbol, payment: Number(p.payment), time: p.time });
              }
              for (const p of positions) {
                if (Number(p.size) > 0) {
                  positionNotionals.set(`${ex}:${p.symbol}`, Math.abs(Number(p.size) * Number(p.markPrice)));
                }
              }
            } catch { /* skip unavailable exchanges */ }
          }),
        );

        allFunding.sort((a, b) => a.time - b.time);

        // Aggregate by exchange×symbol
        const byExSym = new Map<string, { exchange: string; symbol: string; total: number; count: number }>();
        const byExchange = new Map<string, number>();
        let totalFunding = 0;

        for (const f of allFunding) {
          totalFunding += f.payment;
          const key = `${f.exchange}:${f.symbol}`;
          const entry = byExSym.get(key) ?? { exchange: f.exchange, symbol: f.symbol, total: 0, count: 0 };
          entry.total += f.payment;
          entry.count++;
          byExSym.set(key, entry);
          byExchange.set(f.exchange, (byExchange.get(f.exchange) ?? 0) + f.payment);
        }

        // Period days for annualized rate
        const periodDays = periodMs
          ? periodMs / 86400000
          : allFunding.length > 1
            ? (allFunding[allFunding.length - 1].time - allFunding[0].time) / 86400000
            : 1;

        // Match funding to arb positions
        const arbState = loadArbState();
        const arbPositions = arbState?.positions ?? [];
        const arbFunding = new Map<string, { longFunding: number; shortFunding: number }>();
        for (const pos of arbPositions) {
          arbFunding.set(pos.symbol, { longFunding: 0, shortFunding: 0 });
        }
        for (const f of allFunding) {
          const arbEntry = arbFunding.get(f.symbol);
          if (!arbEntry) continue;
          const pos = arbPositions.find(p => p.symbol === f.symbol)!;
          if (f.exchange === pos.longExchange) arbEntry.longFunding += f.payment;
          else if (f.exchange === pos.shortExchange) arbEntry.shortFunding += f.payment;
        }

        // Daily breakdown
        const dailyMap = new Map<string, number>();
        for (const f of allFunding) {
          const day = new Date(f.time).toISOString().slice(0, 10);
          dailyMap.set(day, (dailyMap.get(day) ?? 0) + f.payment);
        }

        // Build result
        const exSymRows = [...byExSym.values()].sort((a, b) => b.total - a.total).map(e => {
          const notional = positionNotionals.get(`${e.exchange}:${e.symbol}`);
          const annRate = notional && notional > 0 && periodDays > 0
            ? (e.total / Math.max(1, periodDays)) * 365 / notional * 100
            : null;
          return { exchange: e.exchange, symbol: e.symbol, total: e.total, count: e.count, annualizedRate: annRate };
        });

        const arbRows = arbPositions
          .map(pos => {
            const af = arbFunding.get(pos.symbol);
            if (!af || (af.longFunding === 0 && af.shortFunding === 0)) return null;
            return {
              symbol: pos.symbol,
              mode: pos.mode ?? "perp-perp",
              longExchange: pos.longExchange,
              shortExchange: pos.shortExchange,
              netFunding: af.longFunding + af.shortFunding,
              longFunding: af.longFunding,
              shortFunding: af.shortFunding,
              daysSinceEntry: Math.max(1, Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 86400000)),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        const daily = [...dailyMap.entries()].sort().map(([date, amount]) => ({ date, amount }));

        const result = {
          period: opts.period ?? "all",
          periodDays: Math.max(1, Math.round(periodDays)),
          totalFunding,
          totalPayments: allFunding.length,
          byExchangeSymbol: exSymRows,
          byExchange: Object.fromEntries(byExchange),
          arbPositions: arbRows,
          ...(opts.daily ? { daily } : {}),
        };

        if (isJson()) return printJson(jsonOk(result));

        // ── Terminal output ──
        console.log(chalk.cyan.bold(`\n  Funding Income Report${opts.period ? ` (${opts.period})` : ""}\n`));
        console.log(`  Total Payments:  ${allFunding.length}`);
        console.log(`  Net Funding:     ${formatPnl(totalFunding)}`);
        console.log(`  Period:          ~${Math.round(periodDays)} days`);

        if (exSymRows.length > 0) {
          console.log(chalk.white.bold("\n  By Exchange × Symbol:"));
          const rows = exSymRows.map(e => [
            chalk.white.bold(e.exchange),
            e.symbol,
            formatPnl(e.total),
            String(e.count),
            e.annualizedRate !== null ? `${e.annualizedRate >= 0 ? "+" : ""}${e.annualizedRate.toFixed(1)}%` : chalk.gray("—"),
          ]);
          console.log(makeTable(["Exchange", "Symbol", "Total", "Payments", "Ann.Rate"], rows));
        }

        if (arbRows.length > 0) {
          console.log(chalk.white.bold("  By Arb Position:"));
          const rows = arbRows.map(a => [
            chalk.white.bold(a.symbol),
            `${a.longExchange} → ${a.shortExchange}`,
            a.mode,
            formatPnl(a.netFunding),
            `${a.daysSinceEntry}d`,
          ]);
          console.log(makeTable(["Symbol", "Long → Short", "Mode", "Net Funding", "Held"], rows));
        }

        if (opts.daily && daily.length > 0) {
          console.log(chalk.white.bold("  Daily Breakdown:"));
          let cumulative = 0;
          const rows = daily.map(d => {
            cumulative += d.amount;
            return [d.date, formatPnl(d.amount), formatPnl(cumulative)];
          });
          console.log(makeTable(["Date", "Funding", "Cumulative"], rows));
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

  // ── analytics compare ──
  parent
    .command("compare")
    .description("Compare active arb positions — ROI, realized PnL, funding income side by side")
    .option("--period <duration>", "Funding lookup period: 7d, 30d, 90d, all (default: all)")
    .option("-n, --limit <n>", "Funding history limit per exchange", "200")
    .action(async (opts: { period?: string; limit: string }) => {
      await withJsonErrors(isJson(), async () => {
        const arbState = loadArbState();
        const positions = arbState?.positions ?? [];

        if (positions.length === 0) {
          if (isJson()) return printJson(jsonOk({ positions: [], message: "No active arb positions" }));
          console.log(chalk.yellow("\n  No active arb positions. Use 'perp arb exec' to open one.\n"));
          return;
        }

        const periodMs = parsePeriodMs(opts.period);
        const sinceMs = periodMs ? Date.now() - periodMs : 0;
        const limit = parseInt(opts.limit);

        // Collect all unique exchanges from arb positions
        const exchangeSet = new Set<string>();
        for (const pos of positions) {
          exchangeSet.add(pos.longExchange);
          exchangeSet.add(pos.shortExchange);
        }

        // Fetch funding + current positions from all relevant exchanges
        const fundingByExSym = new Map<string, number>();
        const currentPrices = new Map<string, number>();

        await Promise.allSettled(
          [...exchangeSet].map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              const [funding, livePositions] = await Promise.all([
                adapter.getFundingPayments(limit),
                adapter.getPositions(),
              ]);
              for (const f of funding) {
                if (sinceMs && f.time < sinceMs) continue;
                const key = `${ex}:${f.symbol}`;
                fundingByExSym.set(key, (fundingByExSym.get(key) ?? 0) + Number(f.payment));
              }
              for (const p of livePositions) {
                currentPrices.set(`${ex}:${p.symbol}`, Number(p.markPrice));
              }
            } catch { /* skip */ }
          }),
        );

        // Build comparison data
        const rows = positions.map(pos => {
          const daysHeld = Math.max(1, Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 86400000));
          const longFunding = fundingByExSym.get(`${pos.longExchange}:${pos.symbol}`) ?? 0;
          const shortFunding = fundingByExSym.get(`${pos.shortExchange}:${pos.symbol}`) ?? 0;
          const netFunding = longFunding + shortFunding;

          // Estimate unrealized PnL from price movement
          const longPrice = currentPrices.get(`${pos.longExchange}:${pos.symbol}`) ?? pos.entryLongPrice;
          const shortPrice = currentPrices.get(`${pos.shortExchange}:${pos.symbol}`) ?? pos.entryShortPrice;
          const longPnl = (longPrice - pos.entryLongPrice) * pos.longSize;
          const shortPnl = (pos.entryShortPrice - shortPrice) * pos.shortSize;
          const pricePnl = longPnl + shortPnl;
          const totalPnl = pricePnl + netFunding;

          // Notional for ROI calculation
          const notional = pos.entryLongPrice * pos.longSize + pos.entryShortPrice * pos.shortSize;
          const roi = notional > 0 ? (totalPnl / notional) * 100 : 0;
          const fundingRoi = notional > 0 ? (netFunding / notional) * 100 : 0;
          const annualizedRoi = daysHeld > 0 ? (fundingRoi / daysHeld) * 365 : 0;

          return {
            symbol: pos.symbol,
            mode: pos.mode ?? "perp-perp",
            longExchange: pos.longExchange,
            shortExchange: pos.shortExchange,
            daysHeld,
            entrySpread: pos.entrySpread,
            funding: netFunding,
            pricePnl,
            totalPnl,
            notional,
            roi,
            fundingRoi,
            annualizedRoi,
          };
        });

        // Sort by total PnL descending
        rows.sort((a, b) => b.totalPnl - a.totalPnl);

        const totals = {
          funding: rows.reduce((s, r) => s + r.funding, 0),
          pricePnl: rows.reduce((s, r) => s + r.pricePnl, 0),
          totalPnl: rows.reduce((s, r) => s + r.totalPnl, 0),
          notional: rows.reduce((s, r) => s + r.notional, 0),
        };

        const result = {
          period: opts.period ?? "all",
          positionCount: rows.length,
          positions: rows,
          totals: {
            ...totals,
            roi: totals.notional > 0 ? (totals.totalPnl / totals.notional) * 100 : 0,
          },
        };

        if (isJson()) return printJson(jsonOk(result));

        // ── Terminal output ──
        console.log(chalk.cyan.bold(`\n  Arb Position Comparison${opts.period ? ` (${opts.period})` : ""}\n`));

        const tableRows = rows.map(r => [
          chalk.white.bold(r.symbol),
          `${r.longExchange} → ${r.shortExchange}`,
          r.mode,
          `${r.daysHeld}d`,
          formatPnl(r.funding),
          formatPnl(r.pricePnl),
          formatPnl(r.totalPnl),
          `${r.roi >= 0 ? "+" : ""}${r.roi.toFixed(2)}%`,
          `${r.annualizedRoi >= 0 ? "+" : ""}${r.annualizedRoi.toFixed(1)}%`,
        ]);
        console.log(makeTable(
          ["Symbol", "Long → Short", "Mode", "Held", "Funding", "Price PnL", "Total PnL", "ROI", "Ann.ROI"],
          tableRows,
        ));

        console.log(chalk.white.bold("  Totals:"));
        console.log(`    Funding Income:   ${formatPnl(totals.funding)}`);
        console.log(`    Price PnL:        ${formatPnl(totals.pricePnl)}`);
        console.log(`    Total PnL:        ${formatPnl(totals.totalPnl)}`);
        if (totals.notional > 0) {
          console.log(`    Total ROI:        ${result.totals.roi >= 0 ? "+" : ""}${result.totals.roi.toFixed(2)}%`);
        }
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
      let prevTotal = snaps.reduce((s, sn) => s + sn.equity, 0);
      console.log(`${chalk.gray(new Date().toLocaleTimeString())} Total equity: $${formatUsd(prevTotal)}`);

      while (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (controller.signal.aborted) break;

        try {
          const s = await takeSnapshot(getAdapterForExchange, exchanges);
          const t = s.reduce((sum, sn) => sum + sn.equity, 0);
          const delta = t - prevTotal;
          console.log(
            `${chalk.gray(new Date().toLocaleTimeString())} ` +
            `Total: $${formatUsd(t)}  ${formatPnl(delta)}`,
          );
          prevTotal = t;
        } catch (err) {
          console.error(chalk.red(`Snapshot error: ${err instanceof Error ? err.message : err}`));
        }
      }
    });

  // ── perf (unified: daily/weekly/summary) ──
  parent
    .command("perf")
    .description("Performance breakdown — daily, weekly, or summary stats")
    .option("--period <period>", "daily, weekly, or summary", "daily")
    .option("--exchange <name>", "Single exchange filter")
    .option("--days <n>", "Number of days (daily mode)", "14")
    .option("--weeks <n>", "Number of weeks (weekly mode)", "8")
    .option("--since <period>", "Time range (e.g. 7d, 2w, 30d)")
    .action(async (opts: { period: string; exchange?: string; days: string; weeks: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const mode = opts.period.toLowerCase();
        const defaultSince = mode === "weekly"
          ? new Date(Date.now() - parseInt(opts.weeks) * 7 * 86400000)
          : new Date(Date.now() - parseInt(opts.days) * 86400000);
        const since = parseSinceDate(opts.since) ?? defaultSince;
        const snapshots = readEquityHistory({ exchange: opts.exchange, since });

        if (snapshots.length === 0) {
          if (isJson()) {
            printJson(jsonError("NO_DATA", "No equity snapshots found. Run 'perp history snapshot' or 'perp history track' first."));
          } else {
            console.log(chalk.yellow("No equity snapshots found. Run 'perp history snapshot' or 'perp history track' first."));
          }
          return;
        }

        if (mode === "summary") {
          const metrics = computePnlMetrics(snapshots, opts.exchange);
          if (isJson()) {
            printJson(jsonOk({ ...metrics, dailyReturns: undefined, dailyCount: metrics.dailyReturns.length }));
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
            if (metrics.bestDay) console.log(`  Best Day:        ${metrics.bestDay.date}  ${formatPnl(metrics.bestDay.pnl)}`);
            if (metrics.worstDay) console.log(`  Worst Day:       ${metrics.worstDay.date}  ${formatPnl(metrics.worstDay.pnl)}`);
          }
          return;
        }

        const daily = computeDailyPnl(snapshots, opts.exchange);

        if (mode === "weekly") {
          const weekly = aggregateWeekly(daily);
          if (isJson()) { printJson(jsonOk({ weekly })); return; }
          console.log(chalk.cyan.bold(`Weekly PnL${opts.exchange ? ` (${opts.exchange})` : ""}\n`));
          const rows = weekly.map(w => [w.date, `$${formatUsd(w.startEquity)}`, `$${formatUsd(w.endEquity)}`, formatPnl(w.pnl), `${w.pnlPct >= 0 ? "+" : ""}${w.pnlPct.toFixed(2)}%`]);
          console.log(makeTable(["Week", "Start", "End", "PnL", "PnL %"], rows));
        } else {
          // daily (default)
          if (isJson()) { printJson(jsonOk({ daily })); return; }
          console.log(chalk.cyan.bold(`Daily PnL${opts.exchange ? ` (${opts.exchange})` : ""}\n`));
          const rows = daily.map(d => [d.date, `$${formatUsd(d.startEquity)}`, `$${formatUsd(d.endEquity)}`, formatPnl(d.pnl), `${d.pnlPct >= 0 ? "+" : ""}${d.pnlPct.toFixed(2)}%`]);
          console.log(makeTable(["Date", "Start", "End", "PnL", "PnL %"], rows));
        }
      });
    });
}
