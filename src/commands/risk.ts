import { Command } from "commander";
import { listConfiguredAccountVenues } from "../config.js";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { printJson, jsonOk, makeTable, formatUsd, withJsonErrors } from "../utils.js";
import { loadRiskLimits, saveRiskLimits, assessRisk, getLiquidationDistances, type RiskLimits } from "../risk.js";
import { probeVenueHealth } from "../venue-health.js";
import { networkOf } from "../cli-flags.js";
import type { Network } from "../exchanges/venue-types.js";

interface HealthResult {
  exchange: string;
  status: "ok" | "down";
  latency_ms: number;
  /** null when ok */
  error: string | null;
  /** "ping" = REST ping; "markets" = the venue's public market-data read (read-only venues included) */
  probe: "ping" | "markets";
  /** "unofficial" = read through an undocumented venue API (none at present) */
  apiStatus: "official" | "unofficial";
}

/**
 * `perp health`: probe EVERY registered venue on the selected network — the same probe as
 * `perp portfolio --health` and the MCP health_check (src/venue-health.ts). A venue with no
 * environment on that network is listed under `skipped`, never silently dropped.
 *
 * JSON: `exchanges` = official-API venues, `unofficial` = venues read through an undocumented API
 * (TxFlow), each entry with `error` (null when ok). `healthy` = every OFFICIAL venue is up — an
 * unofficial API being down does not make the CLI unhealthy; `allHealthy` includes them.
 */
export async function runHealthCheck(isJson: () => boolean, network: Network): Promise<void> {
      const health = await probeVenueHealth(network);
      const checks: HealthResult[] = health.probes.map(p => ({
        exchange: p.venue,
        status: p.ok ? "ok" : "down",
        latency_ms: p.latencyMs,
        error: p.error,
        probe: p.probe,
        apiStatus: p.apiStatus,
      }));
      const official = checks.filter(c => c.apiStatus === "official");
      const unofficial = checks.filter(c => c.apiStatus === "unofficial");
      const allOk = official.every(c => c.status === "ok");

      if (isJson()) {
        return printJson(jsonOk({ healthy: allOk, allHealthy: health.allHealthy, network, exchanges: official, unofficial, skipped: health.skipped }));
      }

      console.log(chalk.cyan.bold(`\n  Exchange Health Check (${network})\n`));
      const rows = checks.map(c => {
        const statusIcon = c.status === "ok" ? chalk.green("OK") : chalk.red("DOWN");
        const latency = c.latency_ms < 500
          ? chalk.green(`${c.latency_ms}ms`)
          : c.latency_ms < 2000
          ? chalk.yellow(`${c.latency_ms}ms`)
          : chalk.red(`${c.latency_ms}ms`);
        return [
          chalk.white.bold(c.exchange) + (c.apiStatus === "unofficial" ? chalk.yellow(" *") : ""),
          statusIcon,
          latency,
          c.probe,
          c.error !== null ? chalk.red(c.error) : chalk.gray("-"),
        ];
      });

      console.log(makeTable(["Exchange", "Status", "Latency", "Probe", "Error"], rows));
      if (unofficial.length > 0) {
        console.log(chalk.yellow("  * unofficial (undocumented) venue API — may change without notice; not counted in Overall"));
      }
      for (const s of health.skipped) console.log(chalk.gray(`  ${s.venue}: not probed — ${s.reason}`));

      const overall = allOk ? chalk.green("ALL HEALTHY") : chalk.red("ISSUES DETECTED");
      console.log(`\n  Overall: ${overall}\n`);
}


/**
 * Exchange filter (comma-separated) of a risk subcommand: the ROOT `-e, --exchange`, only when given
 * on the command line. Commander hands `--exchange` to the root wherever it appears, so a subcommand
 * copy was never set (the filter was silently dropped); the root's default venue is never a filter.
 */
function cliExchangeFilter(root: Command): string | undefined {
  return root.getOptionValueSource("exchange") === "cli" ? String(root.opts().exchange) : undefined;
}

export function registerRiskCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const risk = program.command("risk").description("Risk management and guardrails");

  // ── risk status ──
  risk
    .command("status")
    .description("Assess current risk across all exchanges — -e <ex1,ex2> limits the exchanges (default: all with configured credentials)")
    .action(async () => {
      const exchangeFilter = cliExchangeFilter(program);
      await withJsonErrors(isJson(), async () => {
        const exchanges = exchangeFilter
          ? exchangeFilter.split(",").map(e => e.trim())
          : await listConfiguredAccountVenues();

        const balances: { exchange: string; balance: Awaited<ReturnType<ExchangeAdapter['getBalance']>> }[] = [];
        const positions: { exchange: string; position: Awaited<ReturnType<ExchangeAdapter['getPositions']>>[number] }[] = [];

        const results = await Promise.allSettled(
          exchanges.map(async (ex) => {
            const adapter = await getAdapterForExchange(ex);
            const [bal, pos] = await Promise.all([
              adapter.getBalance(),
              adapter.getPositions(),
            ]);
            balances.push({ exchange: ex, balance: bal });
            for (const p of pos) positions.push({ exchange: ex, position: p });
          }),
        );

        // Log failed exchanges
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            const err = (results[i] as PromiseRejectedResult).reason;
            if (!isJson()) {
              console.log(chalk.yellow(`  ${exchanges[i]}: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        }

        const assessment = assessRisk(balances, positions);

        if (isJson()) {
          return printJson(jsonOk(assessment));
        }

        // Display
        const levelColor = {
          low: chalk.green,
          medium: chalk.yellow,
          high: chalk.red,
          critical: chalk.bgRed.white,
        }[assessment.level];

        console.log(chalk.cyan.bold("\n  Risk Assessment\n"));
        console.log(`  Overall Risk:         ${levelColor(assessment.level.toUpperCase())}`);
        console.log(`  Can Trade:            ${assessment.canTrade ? chalk.green("YES") : chalk.red("NO")}`);
        console.log(`  Total Equity:         $${formatUsd(assessment.metrics.totalEquity)}`);
        console.log(`  Unrealized PnL:       ${(assessment.metrics.totalUnrealizedPnl >= 0 ? chalk.green : chalk.red)(`$${formatUsd(Math.abs(assessment.metrics.totalUnrealizedPnl))}`)}`);

        console.log(`  Total Exposure:       $${formatUsd(assessment.metrics.totalExposure)}`);
        console.log(`  Margin Utilization:   ${assessment.metrics.marginUtilization.toFixed(1)}%`);
        console.log(`  Positions:            ${assessment.metrics.positionCount}`);
        console.log(`  Largest Position:     $${formatUsd(assessment.metrics.largestPositionUsd)}`);
        console.log(`  Max Leverage Used:    ${assessment.metrics.maxLeverageUsed}x`);
        const minLiq = assessment.metrics.minLiquidationDistancePct;
        if (minLiq !== null) {
          const ldColor = minLiq < assessment.limits.minLiquidationDistance
            ? chalk.red
            : chalk.green;
          console.log(`  Min Liq Distance:     ${ldColor(`${minLiq.toFixed(1)}%`)}`);
        }
        for (const { exchange, position: p } of positions.filter(x => x.position.liquidationPrice === null)) {
          console.log(`  Liq Price ${exchange}:${p.symbol}: ${chalk.yellow("unknown (venue does not report)")} — not in Min Liq Distance`);
        }

        if (assessment.violations.length > 0) {
          console.log(chalk.red.bold("\n  Violations"));
          const vRows = assessment.violations.map(v => {
            const sevColor = {
              low: chalk.green,
              medium: chalk.yellow,
              high: chalk.red,
              critical: chalk.bgRed.white,
            }[v.severity];
            return [
              sevColor(v.severity.toUpperCase()),
              v.rule,
              v.message,
            ];
          });
          console.log(makeTable(["Severity", "Rule", "Details"], vRows));
        } else {
          console.log(chalk.green("\n  No risk violations. All clear.\n"));
        }

      });
    });

  // ── risk limits ──
  risk
    .command("limits")
    .description("View or set risk limits")
    .option("--max-drawdown <usd>", "Max unrealized loss (USD)")
    .option("--max-drawdown-pct <pct>", "Max unrealized loss (% of equity)")
    .option("--max-position <usd>", "Max single position notional (USD)")
    .option("--max-position-pct <pct>", "Max single position (% of equity)")
    .option("--max-exposure <usd>", "Max total exposure (USD)")
    .option("--max-exposure-pct <pct>", "Max total exposure (% of equity)")
    .option("--daily-loss <usd>", "Daily realized loss limit (USD)")
    .option("--daily-loss-pct <pct>", "Daily loss limit (% of equity)")
    .option("--max-positions <n>", "Max number of simultaneous positions")
    .option("--max-leverage <n>", "Max leverage per position")
    .option("--max-margin <pct>", "Max margin utilization %")
    .option("--min-liq-distance <pct>", "Min liquidation distance %")
    .option("--reset", "Reset all limits to defaults")
    .action(async (opts: {
      maxDrawdown?: string; maxDrawdownPct?: string;
      maxPosition?: string; maxPositionPct?: string;
      maxExposure?: string; maxExposurePct?: string;
      dailyLoss?: string; dailyLossPct?: string;
      maxPositions?: string; maxLeverage?: string;
      maxMargin?: string; minLiqDistance?: string; reset?: boolean;
    }) => {
      let limits = loadRiskLimits();

      const hasUpdate = opts.maxDrawdown || opts.maxDrawdownPct || opts.maxPosition || opts.maxPositionPct ||
        opts.maxExposure || opts.maxExposurePct || opts.dailyLoss || opts.dailyLossPct ||
        opts.maxPositions || opts.maxLeverage || opts.maxMargin ||
        opts.minLiqDistance || opts.reset;

      if (opts.reset) {
        limits = {
          maxDrawdownUsd: 100000, maxPositionUsd: 100000, maxTotalExposureUsd: 500000,
          dailyLossLimitUsd: 50000, maxPositions: 50, maxLeverage: 50, maxMarginUtilization: 95,
          minLiquidationDistance: 5,
        };
      }
      if (opts.maxDrawdown) limits.maxDrawdownUsd = parseFloat(opts.maxDrawdown);
      if (opts.maxDrawdownPct) limits.maxDrawdownPct = parseFloat(opts.maxDrawdownPct);
      if (opts.maxPosition) limits.maxPositionUsd = parseFloat(opts.maxPosition);
      if (opts.maxPositionPct) limits.maxPositionPct = parseFloat(opts.maxPositionPct);
      if (opts.maxExposure) limits.maxTotalExposureUsd = parseFloat(opts.maxExposure);
      if (opts.maxExposurePct) limits.maxExposurePct = parseFloat(opts.maxExposurePct);
      if (opts.dailyLoss) limits.dailyLossLimitUsd = parseFloat(opts.dailyLoss);
      if (opts.dailyLossPct) limits.dailyLossPct = parseFloat(opts.dailyLossPct);
      if (opts.maxPositions) limits.maxPositions = parseInt(opts.maxPositions);
      if (opts.maxLeverage) limits.maxLeverage = parseInt(opts.maxLeverage);
      if (opts.maxMargin) limits.maxMarginUtilization = parseFloat(opts.maxMargin);
      if (opts.minLiqDistance) {
        limits.minLiquidationDistance = parseFloat(opts.minLiqDistance);
      }

      if (hasUpdate) saveRiskLimits(limits);

      if (isJson()) return printJson(jsonOk(limits));

      const fmtLimit = (usd: number, pct?: number) => {
        const parts = [`$${formatUsd(usd)}`];
        if (pct != null) parts.push(chalk.cyan(`${pct}% of equity`));
        return parts.join(" / ");
      };

      console.log(chalk.cyan.bold(`\n  Risk Limits ${hasUpdate ? "(updated)" : ""}\n`));
      console.log(`  Max Drawdown:          ${fmtLimit(limits.maxDrawdownUsd, limits.maxDrawdownPct)}`);
      console.log(`  Max Position Size:     ${fmtLimit(limits.maxPositionUsd, limits.maxPositionPct)}`);
      console.log(`  Max Total Exposure:    ${fmtLimit(limits.maxTotalExposureUsd, limits.maxExposurePct)}`);
      console.log(`  Daily Loss Limit:      ${fmtLimit(limits.dailyLossLimitUsd, limits.dailyLossPct)}`);
      console.log(`  Max Positions:         ${limits.maxPositions}`);
      console.log(`  Max Leverage:          ${limits.maxLeverage}x`);
      console.log(`  Max Margin Util:       ${limits.maxMarginUtilization}%`);
      console.log(`  Min Liq Distance:      ${limits.minLiquidationDistance}%`);
      console.log(chalk.gray(`\n  When both USD and % are set, the stricter limit applies.\n`));
      console.log(chalk.gray(`  Config file: ~/.perp/risk.json\n`));
    });

  // ── risk check ── (pre-trade check, for agent use)
  risk
    .command("check")
    .description("Pre-trade risk check (for agents) — -e <ex1,ex2> limits the exchanges (default: all with configured credentials)")
    .requiredOption("--notional <usd>", "Order notional value in USD")
    .requiredOption("--leverage <n>", "Order leverage")
    .action(async (opts: { notional: string; leverage: string }) => {
      const exchangeFilter = cliExchangeFilter(program);
      await withJsonErrors(isJson(), async () => {
        const exchanges = exchangeFilter
          ? exchangeFilter.split(",").map(e => e.trim())
          : await listConfiguredAccountVenues();

        const balances: { exchange: string; balance: Awaited<ReturnType<ExchangeAdapter['getBalance']>> }[] = [];
        const positions: { exchange: string; position: Awaited<ReturnType<ExchangeAdapter['getPositions']>>[number] }[] = [];

        await Promise.allSettled(
          exchanges.map(async (ex) => {
            const adapter = await getAdapterForExchange(ex);
            const [bal, pos] = await Promise.all([
              adapter.getBalance(),
              adapter.getPositions(),
            ]);
            balances.push({ exchange: ex, balance: bal });
            for (const p of pos) positions.push({ exchange: ex, position: p });
          }),
        );

        const { preTradeCheck, assessRisk: ar } = await import("../risk.js");
        const assessment = ar(balances, positions);
        const result = preTradeCheck(assessment, parseFloat(opts.notional), parseFloat(opts.leverage));

        if (isJson()) {
          return printJson(jsonOk({ ...result, riskLevel: assessment.level }));
        }

        if (result.allowed) {
          console.log(chalk.green(`\n  Trade ALLOWED (risk: ${assessment.level})\n`));
        } else {
          console.log(chalk.red(`\n  Trade BLOCKED: ${result.reason}\n`));
        }
      });
    });

  // ── risk liquidation-distance ──
  risk
    .command("liquidation-distance")
    .description("Show % distance from liquidation price for all positions — -e <ex1,ex2> limits the exchanges (default: all with configured credentials)")
    .alias("liq-dist")
    .action(async () => {
      const exchangeFilter = cliExchangeFilter(program);
      await withJsonErrors(isJson(), async () => {
        const exchanges = exchangeFilter
          ? exchangeFilter.split(",").map(e => e.trim())
          : await listConfiguredAccountVenues();

        const positions: { exchange: string; position: Awaited<ReturnType<ExchangeAdapter['getPositions']>>[number] }[] = [];

        const results = await Promise.allSettled(
          exchanges.map(async (ex) => {
            const adapter = await getAdapterForExchange(ex);
            const pos = await adapter.getPositions();
            for (const p of pos) positions.push({ exchange: ex, position: p });
          }),
        );

        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            const err = (results[i] as PromiseRejectedResult).reason;
            if (!isJson()) {
              console.log(chalk.yellow(`  ${exchanges[i]}: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        }

        if (positions.length === 0) {
          if (isJson()) return printJson(jsonOk({ positions: [], message: "No open positions" }));
          console.log(chalk.gray("\n  No open positions.\n"));
          return;
        }

        const limits = loadRiskLimits();
        const distances = getLiquidationDistances(positions, limits);
        // Positions whose venue reports no liquidation price are listed explicitly, never dropped.
        const unknownLiq = positions
          .filter(({ position: p }) => p.liquidationPrice === null)
          .map(({ exchange, position: p }) => ({ exchange, symbol: p.symbol, side: p.side, markPrice: Number(p.markPrice), liquidationPrice: null }));

        if (isJson()) {
          return printJson(jsonOk({
            positions: distances,
            unknownLiquidation: unknownLiq,
            limits: {
              minLiquidationDistance: limits.minLiquidationDistance,
            },
          }));
        }

        console.log(chalk.cyan.bold("\n  Liquidation Distance Report\n"));
        console.log(chalk.gray(`  Your limit: ${limits.minLiquidationDistance}%\n`));

        const rows = distances.map(d => {
          const statusColor = {
            safe: chalk.green,
            warning: chalk.yellow,
            danger: chalk.red,
            critical: chalk.bgRed.white,
          }[d.status];
          return [
            chalk.white(d.exchange),
            chalk.white.bold(d.symbol),
            d.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
            `$${formatUsd(d.markPrice)}`,
            `$${formatUsd(d.liquidationPrice)}`,
            statusColor(`${d.distancePct.toFixed(1)}%`),
            statusColor(d.status.toUpperCase()),
          ];
        });

        for (const u of unknownLiq) {
          rows.push([
            chalk.white(u.exchange),
            chalk.white.bold(u.symbol),
            u.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
            `$${formatUsd(u.markPrice)}`,
            chalk.yellow("unknown (venue does not report)"),
            chalk.gray("n/a"),
            chalk.yellow("UNKNOWN"),
          ]);
        }

        console.log(makeTable(
          ["Exchange", "Symbol", "Side", "Mark Price", "Liq Price", "Distance", "Status"],
          rows,
        ));

        // Summary warnings
        const critical = distances.filter(d => d.status === "critical");
        const danger = distances.filter(d => d.status === "danger");
        if (critical.length > 0) {
          console.log(chalk.bgRed.white.bold(`  ⚠ ${critical.length} position(s) critically close to liquidation — REDUCE IMMEDIATELY`));
        }
        if (danger.length > 0) {
          console.log(chalk.red.bold(`  ⚠ ${danger.length} position(s) below your limit (${limits.minLiquidationDistance}%) — action recommended`));
        }
        if (critical.length === 0 && danger.length === 0) {
          console.log(chalk.green("  All positions within safe liquidation distance.\n"));
        } else {
          console.log();
        }
      });
    });

  program
    .command("health")
    .description("Adapter health check: ping venue REST endpoints (connectivity + latency)")
    .action(async () => {
      await runHealthCheck(isJson, networkOf(program));
    });

}
