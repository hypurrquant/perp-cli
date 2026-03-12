import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter, ExchangeBalance, ExchangePosition } from "../exchanges/interface.js";
import { printJson, jsonOk, jsonError, makeTable, formatUsd, formatPnl, withJsonErrors } from "../utils.js";
import { assessRisk, type RiskLevel, type RiskViolation } from "../risk.js";

interface ExchangeSnapshot {
  exchange: string;
  connected: boolean;
  balance: ExchangeBalance | null;
  positions: ExchangePosition[];
  openOrders: number;
  error?: string;
}

interface PortfolioSummary {
  totalEquity: number;
  totalAvailable: number;
  totalMarginUsed: number;
  totalUnrealizedPnl: number;
  totalPositions: number;
  totalOpenOrders: number;
  exchanges: ExchangeSnapshot[];
  positions: (ExchangePosition & { exchange: string })[];
  riskMetrics: {
    marginUtilization: number;  // marginUsed / equity %
    largestPosition: { symbol: string; exchange: string; notional: number } | null;
    exchangeConcentration: { exchange: string; pct: number }[];
  };
  risk: {
    level: RiskLevel;
    canTrade: boolean;
    violations: RiskViolation[];
  };
}

const EXCHANGES = ["pacifica", "hyperliquid", "lighter"] as const;

async function fetchExchangeSnapshot(
  name: string,
  getAdapter: (ex: string) => Promise<ExchangeAdapter>,
): Promise<ExchangeSnapshot> {
  try {
    const adapter = await getAdapter(name);
    const [balance, positions, orders] = await Promise.all([
      adapter.getBalance(),
      adapter.getPositions(),
      adapter.getOpenOrders(),
    ]);
    return {
      exchange: name,
      connected: true,
      balance,
      positions,
      openOrders: orders.length,
    };
  } catch (err) {
    return {
      exchange: name,
      connected: false,
      balance: null,
      positions: [],
      openOrders: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildSummary(snapshots: ExchangeSnapshot[]): PortfolioSummary {
  let totalEquity = 0;
  let totalAvailable = 0;
  let totalMarginUsed = 0;
  let totalUnrealizedPnl = 0;
  let totalPositions = 0;
  let totalOpenOrders = 0;
  const allPositions: (ExchangePosition & { exchange: string })[] = [];

  for (const snap of snapshots) {
    if (snap.balance) {
      totalEquity += Number(snap.balance.equity);
      totalAvailable += Number(snap.balance.available);
      totalMarginUsed += Number(snap.balance.marginUsed);
      totalUnrealizedPnl += Number(snap.balance.unrealizedPnl);
    }
    totalPositions += snap.positions.length;
    totalOpenOrders += snap.openOrders;
    for (const pos of snap.positions) {
      allPositions.push({ ...pos, exchange: snap.exchange });
    }
  }

  // Risk metrics
  const marginUtilization = totalEquity > 0 ? (totalMarginUsed / totalEquity) * 100 : 0;

  let largestPosition: PortfolioSummary['riskMetrics']['largestPosition'] = null;
  for (const pos of allPositions) {
    const notional = Math.abs(Number(pos.size) * Number(pos.markPrice));
    if (!largestPosition || notional > largestPosition.notional) {
      largestPosition = { symbol: pos.symbol, exchange: pos.exchange, notional };
    }
  }

  const exchangeConcentration = snapshots
    .filter(s => s.balance && Number(s.balance.equity) > 0)
    .map(s => ({
      exchange: s.exchange,
      pct: totalEquity > 0 ? (Number(s.balance!.equity) / totalEquity) * 100 : 0,
    }))
    .sort((a, b) => b.pct - a.pct);

  // Full risk assessment (reuses same data, no extra API calls)
  const riskBalances = snapshots
    .filter(s => s.balance)
    .map(s => ({ exchange: s.exchange, balance: s.balance! }));
  const riskPositions = allPositions.map(p => ({ exchange: p.exchange, position: p }));
  const assessment = assessRisk(riskBalances, riskPositions);

  return {
    totalEquity,
    totalAvailable,
    totalMarginUsed,
    totalUnrealizedPnl,
    totalPositions,
    totalOpenOrders,
    exchanges: snapshots,
    positions: allPositions,
    riskMetrics: {
      marginUtilization,
      largestPosition,
      exchangeConcentration,
    },
    risk: {
      level: assessment.level,
      canTrade: assessment.canTrade,
      violations: assessment.violations,
    },
  };
}

export function registerPortfolioCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  program
    .command("portfolio")
    .description("Unified cross-exchange portfolio: balances, positions, risk")
    .option("--exchange <exchanges>", "Comma-separated exchanges to include (default: all)")
    .action(async (opts: { exchange?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

        const snapshots = await Promise.all(
          exchanges.map(ex => fetchExchangeSnapshot(ex, getAdapterForExchange)),
        );

        const summary = buildSummary(snapshots);

        if (isJson()) {
          return printJson(jsonOk(summary));
        }

        // ── Header ──
        console.log(chalk.cyan.bold("\n  Cross-Exchange Portfolio\n"));

        // ── Balance Summary ──
        console.log(chalk.white.bold("  Balances"));
        const balRows = snapshots.map(s => {
          if (!s.connected) {
            return [chalk.white(s.exchange), chalk.red("disconnected"), "-", "-", "-", chalk.gray(s.error ?? "")];
          }
          const b = s.balance!;
          return [
            chalk.white.bold(s.exchange),
            `$${formatUsd(b.equity)}`,
            `$${formatUsd(b.available)}`,
            `$${formatUsd(b.marginUsed)}`,
            formatPnl(b.unrealizedPnl),
            chalk.green("connected"),
          ];
        });
        // Totals row
        balRows.push([
          chalk.cyan.bold("TOTAL"),
          chalk.cyan.bold(`$${formatUsd(summary.totalEquity)}`),
          chalk.cyan.bold(`$${formatUsd(summary.totalAvailable)}`),
          chalk.cyan.bold(`$${formatUsd(summary.totalMarginUsed)}`),
          formatPnl(summary.totalUnrealizedPnl),
          "",
        ]);
        console.log(makeTable(["Exchange", "Equity", "Available", "Margin Used", "uPnL", "Status"], balRows));

        // ── Positions ──
        if (summary.positions.length > 0) {
          console.log(chalk.white.bold("\n  Open Positions"));
          const posRows = summary.positions.map(p => {
            const sideColor = p.side === "long" ? chalk.green : chalk.red;
            const notional = Math.abs(Number(p.size) * Number(p.markPrice));
            return [
              chalk.white.bold(p.symbol),
              chalk.gray(p.exchange),
              sideColor(p.side.toUpperCase()),
              p.size,
              `$${formatUsd(p.entryPrice)}`,
              `$${formatUsd(p.markPrice)}`,
              formatPnl(p.unrealizedPnl),
              `$${formatUsd(notional)}`,
              `${p.leverage}x`,
            ];
          });
          console.log(makeTable(
            ["Symbol", "Exchange", "Side", "Size", "Entry", "Mark", "uPnL", "Notional", "Lev"],
            posRows,
          ));
        } else {
          console.log(chalk.gray("\n  No open positions.\n"));
        }

        // ── Risk Metrics ──
        console.log(chalk.white.bold("\n  Risk Metrics"));
        const levelColor = {
          low: chalk.green,
          medium: chalk.yellow,
          high: chalk.red,
          critical: chalk.bgRed.white,
        }[summary.risk.level];
        console.log(`  Risk Level:         ${levelColor(summary.risk.level.toUpperCase())}`);
        console.log(`  Can Trade:          ${summary.risk.canTrade ? chalk.green("YES") : chalk.red("NO")}`);
        const mu = summary.riskMetrics.marginUtilization;
        const muColor = mu < 30 ? chalk.green : mu < 60 ? chalk.yellow : chalk.red;
        console.log(`  Margin Utilization: ${muColor(`${mu.toFixed(1)}%`)}`);

        if (summary.riskMetrics.largestPosition) {
          const lp = summary.riskMetrics.largestPosition;
          console.log(`  Largest Position:   ${lp.symbol} on ${lp.exchange} ($${formatUsd(lp.notional)})`);
        }

        if (summary.riskMetrics.exchangeConcentration.length > 0) {
          console.log(`  Exchange Allocation:`);
          for (const ec of summary.riskMetrics.exchangeConcentration) {
            const bar = "\u2588".repeat(Math.round(ec.pct / 5)) + "\u2591".repeat(20 - Math.round(ec.pct / 5));
            console.log(`    ${ec.exchange.padEnd(12)} ${bar} ${ec.pct.toFixed(1)}%`);
          }
        }
        if (summary.risk.violations.length > 0) {
          console.log(chalk.red.bold("\n  Risk Violations"));
          for (const v of summary.risk.violations) {
            const sevColor = { low: chalk.green, medium: chalk.yellow, high: chalk.red, critical: chalk.bgRed.white }[v.severity];
            console.log(`    ${sevColor(v.severity.toUpperCase().padEnd(8))} ${v.message}`);
          }
        }
        console.log();
      });
    });
}
