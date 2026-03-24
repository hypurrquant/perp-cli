import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { printJson, jsonOk, makeTable, formatUsd, withJsonErrors } from "../utils.js";
import { loadRiskLimits, saveRiskLimits, assessRisk, getLiquidationDistances, type RiskLimits } from "../risk.js";
import { pingPacifica, pingHyperliquid, pingLighter } from "../shared-api.js";

interface HealthResult {
  exchange: string;
  status: "ok" | "degraded" | "down";
  latency_ms: number;
  error?: string;
}

/** Run health check and return results + render. Exported for use by status --health. */
export async function runHealthCheck(isJson: () => boolean): Promise<void> {
      const pingAster = async (): Promise<{ ok: boolean; latencyMs: number; status: number }> => {
        const start = Date.now();
        try {
          const res = await fetch("https://fapi.asterdex.com/fapi/v1/time");
          return { ok: res.ok, latencyMs: Date.now() - start, status: res.status };
        } catch {
          return { ok: false, latencyMs: Date.now() - start, status: 0 };
        }
      };
      const [pacPing, hlPing, ltPing, astPing] = await Promise.all([
        pingPacifica(),
        pingHyperliquid(),
        pingLighter(),
        pingAster(),
      ]);
      const toPingResult = (name: string, p: { ok: boolean; latencyMs: number; status: number }): HealthResult => ({
        exchange: name,
        status: p.ok ? "ok" : "down",
        latency_ms: p.latencyMs,
        error: p.ok ? undefined : `HTTP ${p.status}`,
      });
      const checks: HealthResult[] = [
        toPingResult("pacifica", pacPing),
        toPingResult("hyperliquid", hlPing),
        toPingResult("lighter", ltPing),
        toPingResult("aster", astPing),
      ];

      const allOk = checks.every(c => c.status === "ok");

      if (isJson()) {
        return printJson(jsonOk({ healthy: allOk, exchanges: checks }));
      }

      console.log(chalk.cyan.bold("\n  Exchange Health Check\n"));
      const rows = checks.map(c => {
        const statusIcon = c.status === "ok"
          ? chalk.green("OK")
          : c.status === "degraded"
          ? chalk.yellow("DEGRADED")
          : chalk.red("DOWN");
        const latency = c.latency_ms < 500
          ? chalk.green(`${c.latency_ms}ms`)
          : c.latency_ms < 2000
          ? chalk.yellow(`${c.latency_ms}ms`)
          : chalk.red(`${c.latency_ms}ms`);
        return [
          chalk.white.bold(c.exchange),
          statusIcon,
          latency,
          c.error ? chalk.red(c.error) : chalk.gray("-"),
        ];
      });

      console.log(makeTable(["Exchange", "Status", "Latency", "Error"], rows));

      const overall = allOk ? chalk.green("ALL HEALTHY") : chalk.red("ISSUES DETECTED");
      console.log(`\n  Overall: ${overall}\n`);
}

const EXCHANGES = ["pacifica", "hyperliquid", "lighter", "aster"] as const;

export function registerRiskCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const risk = program.command("risk").description("Risk management and guardrails");

  // ── risk status ──
  risk
    .command("status")
    .description("Assess current risk across all exchanges")
    .option("--exchange <exchanges>", "Comma-separated exchanges (default: all)")
    .action(async (opts: { exchange?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

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
        if (assessment.metrics.minLiquidationDistancePct >= 0) {
          const ldColor = assessment.metrics.minLiquidationDistancePct < assessment.limits.minLiquidationDistance
            ? chalk.red
            : chalk.green;
          console.log(`  Min Liq Distance:     ${ldColor(`${assessment.metrics.minLiquidationDistancePct.toFixed(1)}%`)}`);
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
    .description("Pre-trade risk check (for agents)")
    .requiredOption("--notional <usd>", "Order notional value in USD")
    .requiredOption("--leverage <n>", "Order leverage")
    .option("--exchange <exchanges>", "Comma-separated exchanges (default: all)")
    .action(async (opts: { notional: string; leverage: string; exchange?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

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
    .description("Show % distance from liquidation price for all positions")
    .alias("liq-dist")
    .option("--exchange <exchanges>", "Comma-separated exchanges (default: all)")
    .action(async (opts: { exchange?: string }) => {
      await withJsonErrors(isJson(), async () => {
        const exchanges = opts.exchange
          ? opts.exchange.split(",").map(e => e.trim())
          : [...EXCHANGES];

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

        if (isJson()) {
          return printJson(jsonOk({
            positions: distances,
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

  // ── deprecated: health (merged into risk) ──
  const healthCmd = program
    .command("health")
    .description("Use 'perp status --health'")
    .action(async () => {
      if (!isJson()) console.log(chalk.yellow("  Use 'perp status --health' instead.\n"));
      await runHealthCheck(isJson);
    });
  (healthCmd as any)._hidden = true;

}
