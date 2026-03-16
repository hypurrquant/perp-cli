import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk, makeTable } from "../utils.js";
import { pingPacifica, pingHyperliquid, pingLighter } from "../shared-api.js";

interface HealthResult {
  exchange: string;
  status: "ok" | "degraded" | "down";
  latency_ms: number;
  error?: string;
}

async function checkExchangeHealth(name: string, fn: () => Promise<unknown>): Promise<HealthResult> {
  const start = Date.now();
  try {
    await fn();
    return { exchange: name, status: "ok", latency_ms: Date.now() - start };
  } catch (err) {
    return {
      exchange: name,
      status: "down",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run health check and return results + render. Exported for use by status --health. */
export async function runHealthCheck(isJson: () => boolean): Promise<void> {
      const [pacPing, hlPing, ltPing] = await Promise.all([
        pingPacifica(),
        pingHyperliquid(),
        pingLighter(),
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

export function registerHealthCommands(program: Command, isJson: () => boolean) {
  const cmd = program
    .command("health")
    .description("Use 'perp status --health'")
    .action(async () => {
      if (!isJson()) console.log(chalk.yellow("  Use 'perp status --health' instead.\n"));
      await runHealthCheck(isJson);
    });
  (cmd as any)._hidden = true;
}
