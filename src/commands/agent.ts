import { Command } from "commander";
import { createRequire } from "node:module";
import { printJson, jsonOk } from "../utils.js";
import { ERROR_CODES } from "../errors.js";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

interface ParameterSchema {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  default?: string;
  enum?: string[];
}

interface CommandSchema {
  name: string;
  fullCommand: string;
  description: string;
  args: ParameterSchema[];
  options: ParameterSchema[];
  subcommands?: CommandSchema[];
}

interface SchemaEnvelope {
  schemaVersion: string;
  cliVersion: string;
  generatedAt: string;
  exchanges: string[];
  errorCodes: Record<string, { status: number; retryable: boolean; description: string }>;
  commands: CommandSchema[];
}

/** Infer parameter type from commander flags/description */
function inferType(flags: string, desc: string): "string" | "number" | "boolean" {
  if (flags.includes("[boolean]") || !flags.includes("<") && !flags.includes("[")) return "boolean";
  const lower = (flags + " " + desc).toLowerCase();
  if (lower.includes("pct") || lower.includes("percent") || lower.includes("leverage") ||
      lower.includes("amount") || lower.includes("size") || lower.includes("price") ||
      lower.includes("<n>") || lower.includes("<sec>") || lower.includes("<ms>")) return "number";
  return "string";
}

/** Infer enum values from description */
function inferEnum(desc: string): string[] | undefined {
  // Match patterns like "buy|sell", "market, limit, stop", "on | off"
  const pipeMatch = desc.match(/:\s*(\w+(?:\s*[|,]\s*\w+)+)/);
  if (pipeMatch) {
    const values = pipeMatch[1].split(/\s*[|,]\s*/).map(v => v.trim()).filter(Boolean);
    if (values.length >= 2 && values.every(v => v.length < 20)) return values;
  }
  return undefined;
}

function extractSchema(cmd: Command, parentPath = "perp"): CommandSchema {
  const fullCommand = `${parentPath} ${cmd.name()}`.trim();

  const args: ParameterSchema[] = (cmd.registeredArguments ?? []).map((a) => {
    const desc = a.description || "";
    return {
      name: a.name(),
      type: inferType(a.name(), desc),
      required: a.required,
      description: desc,
      enum: inferEnum(desc),
    };
  });

  const options: ParameterSchema[] = cmd.options
    .filter((o) => !["--help", "-h"].includes(o.short ?? o.long ?? ""))
    .map((o) => ({
      name: o.long?.replace(/^--/, "") ?? o.short?.replace(/^-/, "") ?? "",
      type: inferType(o.flags, o.description),
      required: o.required ?? false,
      description: o.description,
      ...(o.defaultValue !== undefined ? { default: String(o.defaultValue) } : {}),
      enum: inferEnum(o.description),
    }));

  const subcommands = cmd.commands
    .filter((c) => c.name() !== "help")
    .map((c) => extractSchema(c, fullCommand));

  return {
    name: cmd.name(),
    fullCommand,
    description: cmd.description(),
    args,
    options,
    ...(subcommands.length > 0 ? { subcommands } : {}),
  };
}

export function registerAgentCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean
) {
  const agent = program
    .command("agent")
    .description("Agent-friendly commands");

  // ── agent schema ── dump full command tree as JSON
  agent
    .command("schema")
    .description("Output full CLI command schema as JSON (for agent discovery)")
    .action(() => {
      const errorCodeDocs: Record<string, { status: number; retryable: boolean; description: string }> = {};
      for (const [key, val] of Object.entries(ERROR_CODES)) {
        errorCodeDocs[key] = { status: val.status, retryable: val.retryable, description: key.toLowerCase().replace(/_/g, " ") };
      }
      const envelope: SchemaEnvelope = {
        schemaVersion: "2.0",
        cliVersion: _pkg.version,
        generatedAt: new Date().toISOString(),
        exchanges: ["pacifica", "hyperliquid", "lighter"],
        errorCodes: errorCodeDocs,
        commands: program.commands
          .filter(c => c.name() !== "help")
          .map(c => extractSchema(c)),
      };
      printJson(jsonOk(envelope));
    });

  // ── Top-level schema alias (hidden) ──
  const schemaAlias = program
    .command("schema")
    .description("Output CLI schema as JSON (alias for agent schema)");
  (schemaAlias as any)._hidden = true;
  schemaAlias
    .action(() => {
      const errorCodeDocs: Record<string, { status: number; retryable: boolean; description: string }> = {};
      for (const [key, val] of Object.entries(ERROR_CODES)) {
        errorCodeDocs[key] = { status: val.status, retryable: val.retryable, description: key.toLowerCase().replace(/_/g, " ") };
      }
      const envelope: SchemaEnvelope = {
        schemaVersion: "2.0",
        cliVersion: _pkg.version,
        generatedAt: new Date().toISOString(),
        exchanges: ["pacifica", "hyperliquid", "lighter"],
        errorCodes: errorCodeDocs,
        commands: program.commands
          .filter(c => c.name() !== "help" && c.name() !== "schema")
          .map(c => extractSchema(c)),
      };
      printJson(jsonOk(envelope));
    });

  // ── agent capabilities ── what this CLI can do
  agent
    .command("capabilities")
    .description("List high-level capabilities for agent planning")
    .action(() => {
      printJson(jsonOk({
        name: "perp-cli",
        version: _pkg.version,
        description: "Multi-DEX Perpetual Futures CLI (Pacifica, Hyperliquid, Lighter) with HIP-3 deployed dex support",
        exchanges: ["pacifica", "hyperliquid", "lighter"],
        capabilities: [
          {
            category: "market_data",
            commands: [
              "perp market list --json",
              "perp market prices --json",
              "perp market book <symbol> --json",
              "perp market trades <symbol> --json",
              "perp market funding <symbol> --json",
              "perp market kline <symbol> <interval> --json",
            ],
            description: "Read market data: prices, orderbooks, trades, funding rates, candles",
          },
          {
            category: "account",
            commands: [
              "perp account info --json",
              "perp account positions --json",
              "perp account orders --json",
              "perp account history --json",
              "perp account trades --json",
              "perp portfolio --json",
            ],
            description: "Read account state: balances, positions, open orders, trade history",
          },
          {
            category: "trading",
            commands: [
              "perp trade check <symbol> <side> <size> --json",
              "perp trade market <symbol> <buy|sell> <size> --json [--smart] --client-id <id>",
              "perp trade limit <symbol> <buy|sell> <price> <size> --json --client-id <id>",
              "perp trade cancel <symbol> <orderId> --json",
              "perp trade cancel-all --json",
              "perp trade close <symbol> --json [--smart]",
              "perp trade close-all --json [--smart]",
              "perp trade flatten --json [--smart]",
              "perp trade reduce <symbol> <percent> --json [--smart]",
              "perp trade stop <symbol> <side> <stopPrice> <size> --json",
              "perp trade tpsl <symbol> <side> --tp <price> --sl <price> --json",
              "perp trade twap <symbol> <side> <size> <duration> --json",
            ],
            description: "Execute trades with pre-flight validation, client IDs for idempotency, and position management",
          },
          {
            category: "plan_execution",
            commands: [
              "perp plan validate <file> --json",
              "perp plan execute <file> --json",
              "perp plan execute <file> --dry-run --json",
              "perp plan example",
            ],
            description: "Composite multi-step execution plans with abort/skip/rollback semantics",
          },
          {
            category: "arbitrage",
            commands: [
              "perp arb funding --json",
              "perp arb scan --min 5 --json",
              "perp arb scan --json",
              "perp arb exec <SYM> <longEx> <shortEx> <$> --leverage 2 --isolated --json",
              "perp arb status --json",
              "perp arb close <SYM> --json",
              "perp arb close <SYM> --dry-run --json",
              "perp arb close <SYM> --pair <longEx>:<shortEx> --json",
              "perp arb funding-earned --json",
              "perp arb funding-earned --period 30 --json",
              "perp arb history --json",
              "perp arb dex --json",
              "perp arb dex-monitor --min 10",
              "perp gap show --json",
            ],
            description: "Cross-exchange funding arb: scan → exec → status → funding-earned → close. Plus cross-dex arb and price gaps.",
          },
          {
            category: "risk_management",
            commands: [
              "perp risk status --json",
              "perp risk limits --json",
              "perp risk check --notional <usd> --leverage <n> --json",
            ],
            description: "Portfolio risk assessment, exposure limits, pre-trade risk checks",
          },
          {
            category: "streaming",
            commands: [
              "perp stream events --interval 5000",
              "perp stream prices",
              "perp stream book <symbol>",
              "perp stream trades <symbol>",
            ],
            description: "Real-time NDJSON event stream: position changes, order fills, liquidation warnings, balance updates",
          },
          {
            category: "analytics",
            commands: [
              "perp analytics summary --json",
              "perp analytics pnl --json",
              "perp analytics funding --json",
              "perp portfolio --json",
              "perp health --json",
              "perp history list --json",
            ],
            description: "Cross-exchange portfolio, PnL analytics, execution history, health checks",
          },
          {
            category: "discovery",
            commands: [
              "perp schema",
              "perp agent schema",
              "perp agent capabilities",
              "perp agent ping",
              "perp dex list --json",
              "perp dex markets <name> --json",
            ],
            description: "CLI schema discovery, connectivity checks, HIP-3 dex discovery",
          },
        ],
        agentFeatures: [
          "Structured JSON output (--json) on all commands",
          "Structured error codes with retryable flag (INSUFFICIENT_BALANCE, RATE_LIMITED, etc.)",
          "Client order IDs for idempotent retries (--client-id / --auto-id)",
          "Pre-trade validation (perp trade check) before execution",
          "Multi-step execution plans with rollback (perp plan execute)",
          "NDJSON event streaming for real-time monitoring",
          "HIP-3 cross-dex arbitrage scanning",
        ],
        notes: [
          "Always use --json flag for machine-readable output",
          "Use -e <exchange> to switch between pacifica, hyperliquid, lighter",
          "Use --dex <name> for HIP-3 deployed perp dexes on Hyperliquid",
          "Use -n testnet for testnet mode",
          "Use --client-id or --auto-id on trade commands for retry safety",
          "Use perp trade check before execution for pre-flight validation",
          "Errors include { code, retryable, status } for automated handling",
          "Exit code 0 = success, 1 = error",
        ],
      }));
    });

  // ── agent exec ── execute a sequence of commands
  agent
    .command("exec")
    .description("Execute a command and return structured JSON result")
    .argument("<command...>", "Command to execute (e.g., 'market list')")
    .action(async (args: string[]) => {
      // Re-parse the command through the program
      // This is a convenience wrapper that forces --json
      const fullArgs = ["node", "perp", "--json", ...args];
      try {
        await program.parseAsync(fullArgs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ error: msg }));
        process.exit(1);
      }
    });

  // ── agent ping ── health check
  agent
    .command("ping")
    .description("Health check — returns exchange connectivity status")
    .action(async () => {
      const results: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        cli_version: _pkg.version,
      };

      // Check exchange APIs
      const { pingPacifica, pingHyperliquid } = await import("../shared-api.js");
      const [pacPing, hlPing] = await Promise.all([pingPacifica(), pingHyperliquid()]);
      results.pacifica = {
        status: pacPing.ok ? "ok" : "error",
        latency_ms: pacPing.latencyMs,
        http_status: pacPing.status,
      };
      results.hyperliquid = {
        status: hlPing.ok ? "ok" : "error",
        latency_ms: hlPing.latencyMs,
        http_status: hlPing.status,
      };

      // Check relayer
      try {
        const start = Date.now();
        const res = await fetch("http://localhost:3100/health", {
          signal: AbortSignal.timeout(2000),
        });
        results.relayer = {
          status: res.ok ? "ok" : "error",
          latency_ms: Date.now() - start,
        };
      } catch {
        results.relayer = { status: "offline" };
      }

      if (isJson()) return printJson(jsonOk(results));

      console.log(chalk.cyan.bold("\n  Connectivity Check\n"));
      for (const [name, data] of Object.entries(results)) {
        if (typeof data !== "object" || !data) {
          console.log(`  ${name}: ${data}`);
          continue;
        }
        const d = data as Record<string, unknown>;
        const icon = d.status === "ok" ? chalk.green("OK") : chalk.red(String(d.status).toUpperCase());
        const latency = d.latency_ms ? chalk.gray(` (${d.latency_ms}ms)`) : "";
        console.log(`  ${name.padEnd(14)} ${icon}${latency}`);
      }
      console.log();
    });

  // ── agent plan ── given a goal, suggest a command sequence
  agent
    .command("plan")
    .description("Suggest a command sequence for a given trading goal")
    .argument("<goal>", "Natural language goal (e.g., 'buy 0.1 BTC on pacifica')")
    .action(async (goal: string) => {
      const g = goal.toLowerCase();
      const steps: { step: number; command: string; description: string }[] = [];

      if (g.includes("buy") || g.includes("long")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "0.01";
        steps.push(
          { step: 1, command: `perp market book ${symbol} --json`, description: `Check ${symbol} orderbook` },
          { step: 2, command: `perp account info --json`, description: "Check available balance" },
          { step: 3, command: `perp trade market ${symbol} buy ${size} --json`, description: `Buy ${size} ${symbol}` },
          { step: 4, command: `perp account positions --json`, description: "Verify position opened" },
        );
      } else if (g.includes("sell") || g.includes("short")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "0.01";
        steps.push(
          { step: 1, command: `perp market book ${symbol} --json`, description: `Check ${symbol} orderbook` },
          { step: 2, command: `perp account info --json`, description: "Check available balance" },
          { step: 3, command: `perp trade market ${symbol} sell ${size} --json`, description: `Sell ${size} ${symbol}` },
          { step: 4, command: `perp account positions --json`, description: "Verify position opened" },
        );
      } else if (g.includes("close") || g.includes("exit")) {
        const symbol = extractSymbol(g) || "ALL";
        steps.push(
          { step: 1, command: "perp account positions --json", description: "Get current positions" },
          { step: 2, command: `perp trade cancel-all --json`, description: "Cancel any open orders" },
        );
        if (symbol !== "ALL") {
          steps.push(
            { step: 3, command: `perp trade market ${symbol} sell <position_size> --json`, description: `Close ${symbol} position (adjust side/size from step 1)` },
          );
        }
      } else if (g.includes("arb") || g.includes("arbitrage") || g.includes("funding")) {
        steps.push(
          { step: 1, command: "perp arb scan --min 5 --json", description: "Scan funding rate arbitrage opportunities" },
          { step: 2, command: "perp arb exec <SYM> <longEx> <shortEx> <$> --leverage 2 --isolated --dry-run --json", description: "Dry-run arb execution" },
        );
      } else if (g.includes("status") || g.includes("check") || g.includes("overview")) {
        steps.push(
          { step: 1, command: "perp portfolio --json", description: "Balances + positions + risk" },
          { step: 2, command: "perp account positions --json", description: "Detailed positions" },
          { step: 3, command: "perp account orders --json", description: "Open orders" },
        );
      } else if (g.includes("deposit")) {
        const amount = extractNumber(g) || "100";
        steps.push(
          { step: 1, command: "perp wallet balance --json", description: "Check wallet balance" },
          { step: 2, command: `perp deposit pacifica ${amount} --json`, description: `Deposit $${amount} to Pacifica` },
          { step: 3, command: "perp account info --json", description: "Verify deposit arrived" },
        );
      } else if (g.includes("price") || g.includes("market")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp market book ${symbol} --json`, description: `${symbol} orderbook` },
            { step: 2, command: `perp market funding ${symbol} --json`, description: `${symbol} funding history` },
            { step: 3, command: `perp market kline ${symbol} 1h --json`, description: `${symbol} hourly candles` },
          );
        } else {
          steps.push(
            { step: 1, command: "perp market prices --json", description: "All market prices" },
            { step: 2, command: "perp gap show --json", description: "Cross-exchange price gaps" },
          );
        }
      } else {
        steps.push(
          { step: 1, command: "perp agent capabilities", description: "List all available capabilities" },
          { step: 2, command: "perp portfolio --json", description: "Check account status" },
        );
      }

      printJson(jsonOk({
        goal,
        exchange: "pacifica",
        steps,
        notes: [
          "All commands should include --json for structured output",
          "Adjust exchange with -e hyperliquid if needed",
          "Check return values before proceeding to next step",
        ],
      }));
    });
}

function extractSymbol(text: string): string | null {
  const symbols = ["BTC", "ETH", "SOL", "ARB", "DOGE", "WIF", "JTO", "PYTH", "JUP", "ONDO", "SUI", "APT", "AVAX", "LINK", "OP", "MATIC", "NEAR", "AAVE", "UNI", "TIA"];
  const upper = text.toUpperCase();
  for (const s of symbols) {
    if (upper.includes(s)) return s;
  }
  return null;
}

function extractNumber(text: string): string | null {
  const match = text.match(/(\d+\.?\d*)/);
  return match ? match[1] : null;
}
