import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk, makeTable } from "../utils.js";

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

export function registerHealthCommands(program: Command, isJson: () => boolean) {
  program
    .command("health")
    .description("Check exchange API connectivity and latency")
    .action(async () => {
      const checks = await Promise.all([
        checkExchangeHealth("pacifica", async () => {
          const res = await fetch("https://api.pacifica.fi/api/v1/info/prices");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await res.json();
        }),
        checkExchangeHealth("hyperliquid", async () => {
          const res = await fetch("https://api.hyperliquid.xyz/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "allMids" }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await res.json();
        }),
        checkExchangeHealth("lighter", async () => {
          const res = await fetch("https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await res.json();
        }),
      ]);

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
    });
}
