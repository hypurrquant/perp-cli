import { Command } from "commander";
import { readFileSync } from "fs";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import { validatePlan, executePlan, type ExecutionPlan } from "../plan-executor.js";
import chalk from "chalk";

export function registerPlanCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const plan = program.command("plan").description("Composite execution plans (multi-step atomic operations)");

  // ── plan validate ──
  plan
    .command("validate <file>")
    .description("Validate a JSON execution plan without executing")
    .action(async (file: string) => {
      await withJsonErrors(isJson(), async () => {
        const raw = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
        const planData = JSON.parse(raw);
        const result = validatePlan(planData);

        if (isJson()) return printJson(jsonOk(result));

        if (result.valid) {
          console.log(chalk.green(`\n  Plan is valid (${planData.steps?.length ?? 0} steps).\n`));
        } else {
          console.log(chalk.red(`\n  Plan validation failed:\n`));
          for (const err of result.errors) {
            console.log(chalk.red(`    • ${err}`));
          }
          console.log();
        }
      });
    });

  // ── plan execute ──
  plan
    .command("execute <file>")
    .description("Execute a JSON plan (use - for stdin)")
    .option("--dry-run", "Simulate without executing trades")
    .action(async (file: string, opts: { dryRun?: boolean }) => {
      await withJsonErrors(isJson(), async () => {
        const raw = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
        const planData = JSON.parse(raw) as ExecutionPlan;

        // Validate first
        const validation = validatePlan(planData);
        if (!validation.valid) {
          if (isJson()) return printJson(jsonError("INVALID_PARAMS", `Plan validation failed: ${validation.errors.join("; ")}`));
          console.error(chalk.red(`\n  Plan validation failed:`));
          for (const err of validation.errors) console.error(chalk.red(`    • ${err}`));
          return;
        }

        const adapter = await getAdapter();
        const log = isJson() ? () => {} : (msg: string) => console.log(chalk.gray(`  ${msg}`));

        if (!isJson()) {
          console.log(chalk.cyan.bold(`\n  Executing plan (${planData.steps.length} steps)${opts.dryRun ? " [DRY RUN]" : ""}...\n`));
        }

        const result = await executePlan(adapter, planData, {
          dryRun: opts.dryRun,
          log,
        });

        if (isJson()) return printJson(jsonOk(result));

        // Pretty print results
        for (const step of result.steps) {
          const icon = step.status === "success" ? chalk.green("✓")
            : step.status === "dry_run" ? chalk.blue("○")
            : step.status === "skipped" ? chalk.yellow("–")
            : chalk.red("✗");
          const duration = chalk.gray(`(${step.durationMs}ms)`);
          const err = step.error ? chalk.red(` — ${step.error.message}`) : "";
          console.log(`  ${icon} ${step.stepId} (${step.action}) ${duration}${err}`);
        }

        const statusColor = result.status === "completed" ? chalk.green
          : result.status === "dry_run" ? chalk.blue
          : result.status === "partial" ? chalk.yellow
          : chalk.red;
        console.log(`\n  Status: ${statusColor(result.status)} | ${result.totalDurationMs}ms\n`);
      });
    });

  // ── plan example ──
  plan
    .command("example")
    .description("Print an example execution plan")
    .action(() => {
      const example: ExecutionPlan = {
        version: "1.0",
        description: "Open hedged position with stop loss",
        steps: [
          { id: "check", action: "check_balance", params: { minAvailable: 100 }, onFailure: "abort" },
          { id: "leverage", action: "set_leverage", params: { symbol: "ETH", leverage: 5 }, onFailure: "abort" },
          { id: "entry", action: "market_order", params: { symbol: "ETH", side: "buy", size: "0.5" }, onFailure: "rollback" },
          { id: "verify", action: "check_position", params: { symbol: "ETH", mustExist: true }, dependsOn: "entry", onFailure: "rollback" },
          { id: "stop", action: "stop_order", params: { symbol: "ETH", side: "sell", size: "0.5", triggerPrice: "1800", reduceOnly: true }, dependsOn: "verify", onFailure: "skip" },
        ],
      };
      printJson(jsonOk(example));
    });
}
