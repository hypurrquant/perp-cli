import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { printJson, jsonOk, makeTable, formatUsd, withJsonErrors } from "../utils.js";
import { loadRiskLimits, saveRiskLimits, assessRisk, type RiskLimits } from "../risk.js";

const EXCHANGES = ["pacifica", "hyperliquid", "lighter"] as const;

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
        console.log(`  Unrealized PnL:       ${assessment.metrics.totalUnrealizedPnl >= 0 ? chalk.green : chalk.red}($${formatUsd(Math.abs(assessment.metrics.totalUnrealizedPnl))})`);
        console.log(`  Total Exposure:       $${formatUsd(assessment.metrics.totalExposure)}`);
        console.log(`  Margin Utilization:   ${assessment.metrics.marginUtilization.toFixed(1)}%`);
        console.log(`  Positions:            ${assessment.metrics.positionCount}`);
        console.log(`  Largest Position:     $${formatUsd(assessment.metrics.largestPositionUsd)}`);
        console.log(`  Max Leverage Used:    ${assessment.metrics.maxLeverageUsed}x`);

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
    .option("--max-drawdown <usd>", "Max unrealized loss before closing all")
    .option("--max-position <usd>", "Max single position notional")
    .option("--max-exposure <usd>", "Max total exposure across all positions")
    .option("--daily-loss <usd>", "Daily realized loss limit")
    .option("--max-positions <n>", "Max number of simultaneous positions")
    .option("--max-leverage <n>", "Max leverage per position")
    .option("--max-margin <pct>", "Max margin utilization %")
    .option("--reset", "Reset all limits to defaults")
    .action(async (opts: {
      maxDrawdown?: string; maxPosition?: string; maxExposure?: string;
      dailyLoss?: string; maxPositions?: string; maxLeverage?: string;
      maxMargin?: string; reset?: boolean;
    }) => {
      let limits = loadRiskLimits();

      const hasUpdate = opts.maxDrawdown || opts.maxPosition || opts.maxExposure ||
        opts.dailyLoss || opts.maxPositions || opts.maxLeverage || opts.maxMargin || opts.reset;

      if (opts.reset) {
        limits = {
          maxDrawdownUsd: 500, maxPositionUsd: 5000, maxTotalExposureUsd: 20000,
          dailyLossLimitUsd: 200, maxPositions: 10, maxLeverage: 20, maxMarginUtilization: 80,
        };
      }
      if (opts.maxDrawdown) limits.maxDrawdownUsd = parseFloat(opts.maxDrawdown);
      if (opts.maxPosition) limits.maxPositionUsd = parseFloat(opts.maxPosition);
      if (opts.maxExposure) limits.maxTotalExposureUsd = parseFloat(opts.maxExposure);
      if (opts.dailyLoss) limits.dailyLossLimitUsd = parseFloat(opts.dailyLoss);
      if (opts.maxPositions) limits.maxPositions = parseInt(opts.maxPositions);
      if (opts.maxLeverage) limits.maxLeverage = parseInt(opts.maxLeverage);
      if (opts.maxMargin) limits.maxMarginUtilization = parseFloat(opts.maxMargin);

      if (hasUpdate) saveRiskLimits(limits);

      if (isJson()) return printJson(jsonOk(limits));

      console.log(chalk.cyan.bold(`\n  Risk Limits ${hasUpdate ? "(updated)" : ""}\n`));
      console.log(`  Max Drawdown:          $${formatUsd(limits.maxDrawdownUsd)}`);
      console.log(`  Max Position Size:     $${formatUsd(limits.maxPositionUsd)}`);
      console.log(`  Max Total Exposure:    $${formatUsd(limits.maxTotalExposureUsd)}`);
      console.log(`  Daily Loss Limit:      $${formatUsd(limits.dailyLossLimitUsd)}`);
      console.log(`  Max Positions:         ${limits.maxPositions}`);
      console.log(`  Max Leverage:          ${limits.maxLeverage}x`);
      console.log(`  Max Margin Util:       ${limits.maxMarginUtilization}%\n`);

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
}
