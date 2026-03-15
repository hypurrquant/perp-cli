/**
 * Multi-leg order command.
 *
 * Executes multiple orders across exchanges simultaneously using Promise.allSettled.
 * Supports automatic rollback if one leg fails.
 *
 * Usage:
 *   perp multi "hl:ETH:buy:0.01" "pac:ETH:sell:0.01"
 *   perp multi "hl:BTC:buy:0.001" "lighter:BTC:sell:0.001" --smart
 *   perp multi "hl:ETH:buy:0.01" "pac:SOL:buy:1" "lighter:BTC:sell:0.0001"
 *
 * Leg format: exchange:symbol:side:size
 */

import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { printJson, jsonOk, jsonError, withJsonErrors, formatUsd } from "../utils.js";
import { logExecution } from "../execution-log.js";
import { smartOrder } from "../smart-order.js";

interface Leg {
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  size: string;
}

interface LegResult {
  leg: Leg;
  status: "filled" | "failed" | "rolled_back";
  result?: unknown;
  error?: string;
}

function parseLeg(spec: string): Leg {
  const parts = spec.split(":");
  if (parts.length !== 4) {
    throw new Error(`Invalid leg format "${spec}" — expected exchange:symbol:side:size`);
  }
  const [exchange, symbol, side, size] = parts;

  // Normalize exchange aliases
  const exMap: Record<string, string> = {
    hl: "hyperliquid", pac: "pacifica", lit: "lighter",
    hyperliquid: "hyperliquid", pacifica: "pacifica", lighter: "lighter",
  };
  const normalizedExchange = exMap[exchange.toLowerCase()];
  if (!normalizedExchange) {
    throw new Error(`Unknown exchange "${exchange}" in leg spec`);
  }
  if (side !== "buy" && side !== "sell") {
    throw new Error(`Invalid side "${side}" — must be "buy" or "sell"`);
  }
  if (isNaN(Number(size)) || Number(size) <= 0) {
    throw new Error(`Invalid size "${size}" — must be a positive number`);
  }

  return { exchange: normalizedExchange, symbol: symbol.toUpperCase(), side, size };
}

export function registerMultilegCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  program
    .command("multi <legs...>")
    .description("[Deprecated] Use 'perp plan'. Execute multi-leg orders (exchange:symbol:side:size)")
    .option("--smart", "Use smart order (IOC limit + fallback) for each leg")
    .option("--rollback", "Auto-rollback filled legs if any leg fails", true)
    .option("--no-rollback", "Disable auto-rollback")
    .option("--timeout <ms>", "Per-leg timeout in milliseconds", "30000")
    .action(async (legSpecs: string[], opts: { smart?: boolean; rollback: boolean; timeout: string }) => {
      await withJsonErrors(isJson(), async () => {
        // Parse legs
        const legs = legSpecs.map(parseLeg);

        if (legs.length < 2) {
          const err = "Multi-leg requires at least 2 legs";
          if (isJson()) { printJson(jsonError("INVALID_ARGS", err)); return; }
          throw new Error(err);
        }

        if (!isJson()) {
          console.log(chalk.cyan.bold("Multi-Leg Order\n"));
          for (const l of legs) {
            const color = l.side === "buy" ? chalk.green : chalk.red;
            console.log(`  ${l.exchange.padEnd(14)} ${color(l.side.toUpperCase())} ${l.symbol} x ${l.size}`);
          }
          console.log();
        }

        // Get adapters (deduplicated)
        const adapters = new Map<string, ExchangeAdapter>();
        for (const l of legs) {
          if (!adapters.has(l.exchange)) {
            adapters.set(l.exchange, await getAdapterForExchange(l.exchange));
          }
        }

        // Execute all legs simultaneously
        const timeoutMs = parseInt(opts.timeout);
        const results = await Promise.allSettled(
          legs.map(async (leg): Promise<LegResult> => {
            const adapter = adapters.get(leg.exchange)!;

            const orderPromise = opts.smart
              ? smartOrder(adapter, leg.symbol, leg.side, leg.size).then(r => r.result)
              : adapter.marketOrder(leg.symbol, leg.side, leg.size);

            // Apply timeout
            const result = await Promise.race([
              orderPromise,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Leg timeout")), timeoutMs),
              ),
            ]);

            // Log execution
            logExecution({
              type: "multi_leg",
              exchange: leg.exchange,
              symbol: leg.symbol,
              side: leg.side,
              size: leg.size,
              status: "success",
              dryRun: false,
              meta: { result, smart: opts.smart },
            });

            return { leg, status: "filled", result };
          }),
        );

        // Process results
        const legResults: LegResult[] = results.map((r, i) => {
          if (r.status === "fulfilled") return r.value;
          return {
            leg: legs[i],
            status: "failed" as const,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          };
        });

        const filled = legResults.filter(r => r.status === "filled");
        const failed = legResults.filter(r => r.status === "failed");

        // Rollback if partial fill and rollback enabled
        if (failed.length > 0 && filled.length > 0 && opts.rollback) {
          if (!isJson()) {
            console.log(chalk.yellow(`\n  ${failed.length} leg(s) failed — rolling back ${filled.length} filled leg(s)...\n`));
          }

          for (const fr of filled) {
            const adapter = adapters.get(fr.leg.exchange)!;
            const reverseSide = fr.leg.side === "buy" ? "sell" : "buy";
            try {
              await adapter.marketOrder(fr.leg.symbol, reverseSide as "buy" | "sell", fr.leg.size);
              fr.status = "rolled_back";

              logExecution({
                type: "multi_leg_rollback",
                exchange: fr.leg.exchange,
                symbol: fr.leg.symbol,
                side: reverseSide,
                size: fr.leg.size,
                status: "success",
                dryRun: false,
              });

              if (!isJson()) {
                console.log(chalk.gray(`  Rolled back: ${fr.leg.exchange} ${reverseSide} ${fr.leg.symbol} x ${fr.leg.size}`));
              }
            } catch (err) {
              if (!isJson()) {
                console.log(chalk.red(`  Rollback failed: ${fr.leg.exchange} ${fr.leg.symbol} — ${err instanceof Error ? err.message : err}`));
              }
            }
          }
        }

        if (isJson()) {
          printJson(jsonOk({
            legs: legResults.map(r => ({
              exchange: r.leg.exchange,
              symbol: r.leg.symbol,
              side: r.leg.side,
              size: r.leg.size,
              status: r.status,
              error: r.error,
            })),
            summary: {
              total: legs.length,
              filled: legResults.filter(r => r.status === "filled").length,
              failed: failed.length,
              rolledBack: legResults.filter(r => r.status === "rolled_back").length,
            },
          }));
        } else {
          console.log(chalk.cyan.bold("\nResults:\n"));
          for (const r of legResults) {
            const icon = r.status === "filled" ? chalk.green("OK") :
              r.status === "rolled_back" ? chalk.yellow("ROLLBACK") :
              chalk.red("FAIL");
            console.log(`  ${icon} ${r.leg.exchange.padEnd(14)} ${r.leg.side} ${r.leg.symbol} x ${r.leg.size}${r.error ? ` — ${r.error}` : ""}`);
          }
          console.log(`\n  Total: ${legs.length}  Filled: ${filled.length}  Failed: ${failed.length}  Rolled back: ${legResults.filter(r => r.status === "rolled_back").length}`);
        }
      });
    });
}
