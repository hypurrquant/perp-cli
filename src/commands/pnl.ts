/**
 * PnL Tracker CLI commands.
 *
 * perp pnl snapshot  — take one-time equity snapshots across exchanges
 * perp pnl track     — continuous equity tracking (foreground)
 * perp pnl daily     — daily PnL breakdown table
 * perp pnl weekly    — weekly PnL breakdown table
 * perp pnl summary   — performance summary (Sharpe, drawdown, win rate)
 */

import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { printJson, jsonOk, jsonError, makeTable, formatUsd, formatPnl, withJsonErrors } from "../utils.js";
import {
  saveEquitySnapshot,
  readEquityHistory,
  computePnlMetrics,
  computeDailyPnl,
  aggregateWeekly,
  type EquitySnapshot,
} from "../equity-tracker.js";

const EXCHANGES = ["pacifica", "hyperliquid", "lighter"] as const;

function parseSince(since?: string): Date | undefined {
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

export function registerPnlCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const pnl = program.command("pnl").description("[Deprecated] Use 'perp account pnl'. Equity tracking & performance metrics");

  // ── pnl snapshot ──
  pnl
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

  // ── pnl track ──
  pnl
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

  // ── pnl daily ──
  pnl
    .command("daily")
    .description("Daily PnL breakdown")
    .option("--exchange <name>", "Single exchange filter")
    .option("--days <n>", "Number of days to show", "14")
    .option("--since <period>", "Time range (e.g. 7d, 2w, 30d)")
    .action(async (opts: { exchange?: string; days: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSince(opts.since) ?? new Date(Date.now() - parseInt(opts.days) * 86400000);
        const snapshots = readEquityHistory({ exchange: opts.exchange, since });

        if (snapshots.length === 0) {
          if (isJson()) {
            printJson(jsonError("NO_DATA", "No equity snapshots found. Run 'perp pnl snapshot' or 'perp pnl track' first."));
          } else {
            console.log(chalk.yellow("No equity snapshots found. Run 'perp pnl snapshot' or 'perp pnl track' first."));
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

  // ── pnl weekly ──
  pnl
    .command("weekly")
    .description("Weekly PnL breakdown")
    .option("--exchange <name>", "Single exchange filter")
    .option("--weeks <n>", "Number of weeks to show", "8")
    .option("--since <period>", "Time range (e.g. 4w, 8w)")
    .action(async (opts: { exchange?: string; weeks: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSince(opts.since) ?? new Date(Date.now() - parseInt(opts.weeks) * 7 * 86400000);
        const snapshots = readEquityHistory({ exchange: opts.exchange, since });

        if (snapshots.length === 0) {
          if (isJson()) {
            printJson(jsonError("NO_DATA", "No equity snapshots found."));
          } else {
            console.log(chalk.yellow("No equity snapshots found. Run 'perp pnl snapshot' or 'perp pnl track' first."));
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

  // ── pnl summary ──
  pnl
    .command("summary")
    .description("Performance summary — Sharpe, drawdown, win rate")
    .option("--exchange <name>", "Single exchange filter")
    .option("--since <period>", "Time range (e.g. 7d, 30d, 12w)")
    .action(async (opts: { exchange?: string; since?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const since = parseSince(opts.since);
        const snapshots = readEquityHistory({ exchange: opts.exchange, since });

        if (snapshots.length === 0) {
          if (isJson()) {
            printJson(jsonError("NO_DATA", "No equity snapshots found."));
          } else {
            console.log(chalk.yellow("No equity snapshots found. Run 'perp pnl snapshot' or 'perp pnl track' first."));
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
