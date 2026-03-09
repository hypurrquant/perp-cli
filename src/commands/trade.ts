import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import { printJson, errorAndExit, withJsonErrors, jsonOk, jsonError, symbolMatch, formatUsd } from "../utils.js";
import { logExecution } from "../execution-log.js";
import { validateTrade } from "../trade-validator.js";
import { generateClientId, logClientId, isOrderDuplicate } from "../client-id-tracker.js";
import chalk from "chalk";

function pac(adapter: ExchangeAdapter): PacificaAdapter {
  if (!(adapter instanceof PacificaAdapter)) throw new Error("This command requires --exchange pacifica");
  return adapter;
}

export function registerTradeCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean
) {
  const trade = program.command("trade").description("Trading commands");

  // === Generic commands (all exchanges) ===

  trade
    .command("market <symbol> <side> <size>")
    .description("Place a market order (side: buy/sell)")
    .option("-s, --slippage <pct>", "Slippage percent", "1")
    .option("--reduce-only", "Reduce only order")
    .option("--client-id <id>", "Client order ID for idempotent tracking")
    .option("--auto-id", "Auto-generate a client order ID")
    .action(async (symbol: string, side: string, size: string, opts: { slippage: string; reduceOnly?: boolean; clientId?: string; autoId?: boolean }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");

      const clientId = opts.autoId ? generateClientId() : opts.clientId;

      if (clientId && isOrderDuplicate(clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${clientId}). Skipping.\n`));
        return;
      }

      const adapter = await getAdapter();

      if (clientId) {
        logClientId({
          clientOrderId: clientId, exchange: adapter.name,
          symbol: symbol.toUpperCase(), side: s, size, type: "market",
          status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }

      let result: unknown;
      try {
        result = await adapter.marketOrder(symbol.toUpperCase(), s as "buy" | "sell", size);
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(),
          side: s, size, status: "success", dryRun: false,
          meta: clientId ? { clientOrderId: clientId } : undefined,
        });
      } catch (err) {
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(),
          side: s, size, status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: clientId ? { clientOrderId: clientId } : undefined,
        });
        throw err;
      }

      if (clientId) {
        logClientId({
          clientOrderId: clientId, exchange: adapter.name,
          symbol: symbol.toUpperCase(), side: s, size, type: "market",
          status: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }

      if (isJson()) return printJson(jsonOk(clientId ? { ...result as object, clientOrderId: clientId } : result));
      console.log(chalk.green(`\n  Market ${s.toUpperCase()} ${size} ${symbol.toUpperCase()} placed on ${adapter.name}.${clientId ? ` (id: ${clientId})` : ""}\n`));
      printJson(jsonOk(result));
    });

  // Shortcuts: trade buy / trade sell
  trade
    .command("buy <symbol> <size>")
    .description("Market buy (shortcut for: trade market <symbol> buy <size>)")
    .option("-s, --slippage <pct>", "Slippage percent", "1")
    .option("--reduce-only", "Reduce only order")
    .option("--client-id <id>", "Client order ID")
    .option("--auto-id", "Auto-generate client order ID")
    .action(async (symbol: string, size: string, opts: { slippage: string; reduceOnly?: boolean; clientId?: string; autoId?: boolean }) => {
      const clientId = opts.autoId ? generateClientId() : opts.clientId;
      if (clientId && isOrderDuplicate(clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${clientId}). Skipping.\n`));
        return;
      }
      const adapter = await getAdapter();
      let result: unknown;
      try {
        result = await adapter.marketOrder(symbol.toUpperCase(), "buy", size);
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "buy", size, status: "success", dryRun: false });
      } catch (err) {
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "buy", size, status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      if (isJson()) return printJson(jsonOk(clientId ? { ...result as object, clientOrderId: clientId } : result));
      console.log(chalk.green(`\n  Market BUY ${size} ${symbol.toUpperCase()} placed on ${adapter.name}.\n`));
      printJson(jsonOk(result));
    });

  trade
    .command("sell <symbol> <size>")
    .description("Market sell (shortcut for: trade market <symbol> sell <size>)")
    .option("-s, --slippage <pct>", "Slippage percent", "1")
    .option("--reduce-only", "Reduce only order")
    .option("--client-id <id>", "Client order ID")
    .option("--auto-id", "Auto-generate client order ID")
    .action(async (symbol: string, size: string, opts: { slippage: string; reduceOnly?: boolean; clientId?: string; autoId?: boolean }) => {
      const clientId = opts.autoId ? generateClientId() : opts.clientId;
      if (clientId && isOrderDuplicate(clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${clientId}). Skipping.\n`));
        return;
      }
      const adapter = await getAdapter();
      let result: unknown;
      try {
        result = await adapter.marketOrder(symbol.toUpperCase(), "sell", size);
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "sell", size, status: "success", dryRun: false });
      } catch (err) {
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "sell", size, status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      if (isJson()) return printJson(jsonOk(clientId ? { ...result as object, clientOrderId: clientId } : result));
      console.log(chalk.green(`\n  Market SELL ${size} ${symbol.toUpperCase()} placed on ${adapter.name}.\n`));
      printJson(jsonOk(result));
    });

  trade
    .command("limit <symbol> <side> <price> <size>")
    .description("Place a limit order")
    .option("--tif <tif>", "Time in force: GTC, IOC, ALO, TOB", "GTC")
    .option("--reduce-only", "Reduce only order")
    .option("--client-id <id>", "Client order ID for idempotent tracking")
    .option("--auto-id", "Auto-generate a client order ID")
    .action(async (symbol: string, side: string, price: string, size: string, opts: { tif: string; reduceOnly?: boolean; clientId?: string; autoId?: boolean }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");

      const clientId = opts.autoId ? generateClientId() : opts.clientId;

      if (clientId && isOrderDuplicate(clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${clientId}). Skipping.\n`));
        return;
      }

      const adapter = await getAdapter();

      if (clientId) {
        logClientId({
          clientOrderId: clientId, exchange: adapter.name,
          symbol: symbol.toUpperCase(), side: s, size, type: "limit",
          status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }

      let result: unknown;
      try {
        result = await adapter.limitOrder(symbol.toUpperCase(), s as "buy" | "sell", price, size);
        logExecution({
          type: "limit_order", exchange: adapter.name, symbol: symbol.toUpperCase(),
          side: s, size, price, status: "success", dryRun: false,
          meta: clientId ? { clientOrderId: clientId } : undefined,
        });
      } catch (err) {
        logExecution({
          type: "limit_order", exchange: adapter.name, symbol: symbol.toUpperCase(),
          side: s, size, price, status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: clientId ? { clientOrderId: clientId } : undefined,
        });
        throw err;
      }

      if (clientId) {
        logClientId({
          clientOrderId: clientId, exchange: adapter.name,
          symbol: symbol.toUpperCase(), side: s, size, type: "limit",
          status: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }

      if (isJson()) return printJson(jsonOk(clientId ? { ...result as object, clientOrderId: clientId } : result));
      console.log(chalk.green(`\n  Limit ${s.toUpperCase()} ${size} ${symbol.toUpperCase()} @ $${price} placed on ${adapter.name}.${clientId ? ` (id: ${clientId})` : ""}\n`));
      printJson(jsonOk(result));
    });

  trade
    .command("cancel <symbol> <orderId>")
    .description("Cancel a specific order")
    .action(async (symbol: string, orderId: string) => {
      const adapter = await getAdapter();
      try {
        const result = await adapter.cancelOrder(symbol.toUpperCase(), orderId);
        logExecution({ type: "cancel", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "cancel", size: "0", status: "success", dryRun: false, meta: { orderId } });
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Order ${orderId} cancelled on ${adapter.name}.\n`));
      } catch (err) {
        logExecution({ type: "cancel", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "cancel", size: "0", status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err), meta: { orderId } });
        throw err;
      }
    });

  trade
    .command("cancel-all")
    .description("Cancel all open orders")
    .action(async () => {
      const adapter = await getAdapter();
      const result = await adapter.cancelAllOrders();
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  All orders cancelled on ${adapter.name}.\n`));
    });

  // === TWAP — Pacifica (seconds) + Hyperliquid (minutes) ===

  trade
    .command("twap <symbol> <side> <size> <duration>")
    .description("Place a TWAP order (Pacifica: seconds, HL: minutes, Lighter/any: client-side via --background)")
    .option("-s, --slippage <pct>", "Slippage percent", "1")
    .option("--reduce-only", "Reduce only order")
    .option("--background", "Run client-side TWAP in background (tmux) — works on all exchanges")
    .option("--slices <n>", "Number of slices for client-side TWAP")
    .action(async (symbol: string, side: string, size: string, duration: string, opts: { slippage: string; reduceOnly?: boolean; background?: boolean; slices?: string }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");

      // --background → client-side TWAP via tmux job
      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const exchange = (await getAdapter()).name;
        const cliArgs = [
          symbol.toUpperCase(), s, size, duration,
          ...(opts.slices ? ["--slices", opts.slices] : []),
        ];
        // Pass exchange flag through
        const job = startJob({
          strategy: "twap",
          exchange,
          params: { symbol: symbol.toUpperCase(), side: s, size, duration, slices: opts.slices },
          cliArgs: [`-e`, exchange, ...cliArgs],
        });
        if (isJson()) return printJson(jsonOk(job));
        console.log(chalk.green(`\n  TWAP job started in background.`));
        console.log(`  ID: ${chalk.white.bold(job.id)}`);
        console.log(`  Session: ${job.tmuxSession}`);
        console.log(`  Logs: ${chalk.gray(`perp jobs logs ${job.id}`)}`);
        console.log(`  Stop: ${chalk.gray(`perp jobs stop ${job.id}`)}\n`);
        return;
      }

      const adapter = await getAdapter();

      // Lighter or any exchange without native TWAP → client-side TWAP (foreground)
      if (adapter instanceof LighterAdapter) {
        const { runTWAP } = await import("../strategies/twap.js");
        const result = await runTWAP(adapter, {
          symbol: symbol.toUpperCase(),
          side: s as "buy" | "sell",
          totalSize: parseFloat(size),
          durationSec: parseInt(duration),
          slices: opts.slices ? parseInt(opts.slices) : undefined,
        });
        if (isJson()) return printJson(jsonOk(result));
        return;
      }

      let result: unknown;
      if (adapter instanceof PacificaAdapter) {
        result = await adapter.sdk.createTWAP(
          {
            symbol: symbol.toUpperCase(),
            amount: size,
            side: s === "buy" ? "bid" : "ask",
            slippage_percent: opts.slippage,
            reduce_only: opts.reduceOnly ?? false,
            duration_in_seconds: parseInt(duration),
          },
          adapter.publicKey,
          adapter.signer
        );
      } else if (adapter instanceof HyperliquidAdapter) {
        const minutes = parseInt(duration);
        if (minutes < 5 || minutes > 1440) errorAndExit("HL TWAP duration must be 5-1440 minutes");
        result = await adapter.twapOrder(
          symbol.toUpperCase(),
          s as "buy" | "sell",
          size,
          minutes,
          { reduceOnly: opts.reduceOnly }
        );
      } else {
        errorAndExit("TWAP orders require --exchange pacifica, hyperliquid, or lighter");
      }

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  TWAP ${s.toUpperCase()} ${size} ${symbol.toUpperCase()} over ${duration} placed on ${adapter.name}.\n`));
      printJson(jsonOk(result));
    });

  // === Stop / Trigger orders — Pacifica + Hyperliquid ===

  trade
    .command("stop <symbol> <side> <stopPrice> <size>")
    .description("Place a stop order")
    .option("--limit-price <price>", "Limit price (makes it stop-limit)")
    .option("--reduce-only", "Reduce only order")
    .action(async (symbol: string, side: string, stopPrice: string, size: string, opts: { limitPrice?: string; reduceOnly?: boolean }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");

      const adapter = await getAdapter();
      let result: unknown;
      try {
        result = await adapter.stopOrder(
          symbol.toUpperCase(),
          s as "buy" | "sell",
          size,
          stopPrice,
          { limitPrice: opts.limitPrice, reduceOnly: opts.reduceOnly }
        );
        logExecution({ type: "stop_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: s, size, price: stopPrice, status: "success", dryRun: false });
      } catch (err) {
        logExecution({ type: "stop_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: s, size, price: stopPrice, status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Stop order placed on ${adapter.name}.\n`));
      printJson(jsonOk(result));
    });

  // === TP/SL — Pacifica + Hyperliquid ===

  trade
    .command("tpsl <symbol> <side>")
    .description("Set take-profit / stop-loss on a position")
    .option("--tp <price>", "Take profit trigger price")
    .option("--tp-limit <price>", "Take profit limit price")
    .option("--sl <price>", "Stop loss trigger price")
    .option("--size <size>", "Size (HL only, omit for full position)")
    .action(async (symbol: string, side: string, opts: { tp?: string; tpLimit?: string; sl?: string; size?: string }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      if (!opts.tp && !opts.sl) errorAndExit("Must specify --tp and/or --sl");

      const adapter = await getAdapter();

      if (adapter instanceof PacificaAdapter) {
        // TP/SL side is opposite of position: LONG position → "ask" to close
        const params: Record<string, unknown> = {
          symbol: symbol.toUpperCase(),
          side: s === "buy" ? "ask" : "bid",
        };
        if (opts.tp) params.take_profit = { stop_price: opts.tp, limit_price: opts.tpLimit };
        if (opts.sl) params.stop_loss = { stop_price: opts.sl };

        const result = await adapter.sdk.setTPSL(
          params as unknown as Parameters<typeof adapter.sdk.setTPSL>[0],
          adapter.publicKey,
          adapter.signer
        );
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  TP/SL set for ${symbol.toUpperCase()} on Pacifica.\n`));
      } else if (adapter instanceof HyperliquidAdapter) {
        // HL uses trigger orders for TP/SL
        const results: unknown[] = [];
        const posSize = opts.size || "0"; // 0 = full position via positionTpsl grouping

        if (opts.tp) {
          results.push(
            await adapter.triggerOrder(
              symbol.toUpperCase(),
              s === "buy" ? "sell" : "buy", // Close opposite side
              posSize,
              opts.tp,
              "tp",
              { isMarket: !opts.tpLimit, reduceOnly: true, grouping: "positionTpsl" }
            )
          );
        }
        if (opts.sl) {
          results.push(
            await adapter.triggerOrder(
              symbol.toUpperCase(),
              s === "buy" ? "sell" : "buy",
              posSize,
              opts.sl,
              "sl",
              { isMarket: true, reduceOnly: true, grouping: "positionTpsl" }
            )
          );
        }
        if (isJson()) return printJson(jsonOk(results));
        console.log(chalk.green(`\n  TP/SL set for ${symbol.toUpperCase()} on Hyperliquid.\n`));
      } else if (adapter instanceof LighterAdapter) {
        // Lighter uses triggerPrice in signCreateOrder for TP/SL
        const closeSide = s === "buy" ? "sell" : "buy"; // Close opposite side
        const results: unknown[] = [];
        if (opts.tp) {
          results.push(
            await adapter.stopOrder(
              symbol.toUpperCase(),
              closeSide as "buy" | "sell",
              opts.size || "0",
              opts.tp,
              { limitPrice: opts.tpLimit, reduceOnly: true }
            )
          );
        }
        if (opts.sl) {
          results.push(
            await adapter.stopOrder(
              symbol.toUpperCase(),
              closeSide as "buy" | "sell",
              opts.size || "0",
              opts.sl,
              { reduceOnly: true }
            )
          );
        }
        if (isJson()) return printJson(jsonOk(results));
        console.log(chalk.green(`\n  TP/SL set for ${symbol.toUpperCase()} on Lighter.\n`));
      } else {
        errorAndExit("TP/SL requires --exchange pacifica, hyperliquid, or lighter");
      }
    });

  // === Pacifica-only commands ===

  trade
    .command("edit <symbol> <orderId> <price> <size>")
    .description("Edit an existing order")
    .action(async (symbol: string, orderId: string, price: string, size: string) => {
      const adapter = await getAdapter();
      const result = await adapter.editOrder(symbol.toUpperCase(), orderId, price, size);
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Order ${orderId} updated to $${price} x ${size} on ${adapter.name}.\n`));
    });

  trade
    .command("cancel-stop <symbol> <stopOrderId>")
    .description("Cancel a stop order (Pacifica)")
    .action(async (symbol: string, stopOrderId: string) => {
      const adapter = await getAdapter();
      const p = pac(adapter);
      const result = await p.sdk.cancelStopOrder(
        { symbol: symbol.toUpperCase(), order_id: Number(stopOrderId) },
        p.publicKey,
        p.signer
      );
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Stop order ${stopOrderId} cancelled.\n`));
    });

  trade
    .command("cancel-twap <symbol> <twapOrderId>")
    .description("Cancel a TWAP order")
    .action(async (symbol: string, twapOrderId: string) => {
      const adapter = await getAdapter();

      let result: unknown;
      if (adapter instanceof PacificaAdapter) {
        result = await adapter.sdk.cancelTWAP(
          { symbol: symbol.toUpperCase(), twap_order_id: Number(twapOrderId) },
          adapter.publicKey,
          adapter.signer
        );
      } else if (adapter instanceof HyperliquidAdapter) {
        result = await adapter.twapCancel(symbol.toUpperCase(), Number(twapOrderId));
      } else {
        errorAndExit("Cancel TWAP requires --exchange pacifica or hyperliquid");
      }

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  TWAP order ${twapOrderId} cancelled on ${adapter.name}.\n`));
    });

  // === Hyperliquid-only commands ===

  trade
    .command("leverage <symbol> <leverage>")
    .description("Set leverage for a symbol")
    .option("--isolated", "Use isolated margin mode (default: cross)")
    .action(async (symbol: string, leverage: string, opts: { isolated?: boolean }) => {
      const adapter = await getAdapter();
      const mode = opts.isolated ? "isolated" : "cross";
      try {
        const result = await adapter.setLeverage(symbol.toUpperCase(), parseInt(leverage), mode);

        logExecution({
          type: "rebalance", exchange: adapter.name, symbol: symbol.toUpperCase(), side: mode,
          size: leverage, status: "success", dryRun: false,
          meta: { action: "set_leverage", leverage: parseInt(leverage), mode },
        });

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Leverage set to ${leverage}x (${mode}) for ${symbol.toUpperCase()} on ${adapter.name}.\n`));
      } catch (err) {
        logExecution({
          type: "rebalance", exchange: adapter.name, symbol: symbol.toUpperCase(), side: mode,
          size: leverage, status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "set_leverage", leverage: parseInt(leverage), mode },
        });
        throw err;
      }
    });

  // ── Grid Bot (shortcut with --background) ──

  trade
    .command("grid <symbol>")
    .description("Run grid trading bot (foreground or --background)")
    .requiredOption("--upper <price>", "Upper price bound")
    .requiredOption("--lower <price>", "Lower price bound")
    .option("--grids <n>", "Number of grid lines", "10")
    .option("--size <size>", "Total position size (base)", "0.1")
    .option("--side <side>", "Grid bias: long, short, neutral", "neutral")
    .option("--leverage <n>", "Leverage to set")
    .option("--interval <sec>", "Check interval in seconds", "10")
    .option("--max-runtime <sec>", "Max runtime in seconds (0 = forever)", "0")
    .option("--trailing-stop <pct>", "Stop if equity drops by this % from peak")
    .option("--background", "Run in background (tmux)")
    .action(async (symbol: string, opts: {
      upper: string; lower: string; grids: string; size: string;
      side: string; leverage?: string; interval: string;
      maxRuntime: string; trailingStop?: string; background?: boolean;
    }) => {
      const exchange = (await getAdapter()).name;
      const cliArgs = [
        `-e`, exchange, symbol.toUpperCase(),
        `--upper`, opts.upper, `--lower`, opts.lower,
        `--grids`, opts.grids, `--size`, opts.size,
        `--side`, opts.side, `--interval`, opts.interval,
        `--max-runtime`, opts.maxRuntime,
        ...(opts.leverage ? [`--leverage`, opts.leverage] : []),
        ...(opts.trailingStop ? [`--trailing-stop`, opts.trailingStop] : []),
      ];

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const job = startJob({
          strategy: "grid",
          exchange,
          params: { symbol: symbol.toUpperCase(), ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        console.log(chalk.green(`\n  Grid bot started in background.`));
        console.log(`  ID: ${chalk.white.bold(job.id)}`);
        console.log(`  Range: $${opts.lower} - $${opts.upper} | ${opts.grids} grids`);
        console.log(`  Logs: ${chalk.gray(`perp jobs logs ${job.id}`)}`);
        console.log(`  Stop: ${chalk.gray(`perp jobs stop ${job.id}`)}\n`);
        return;
      }

      // Foreground: delegate to `run grid`
      const { runGrid } = await import("../strategies/grid.js");
      const adapter = await getAdapter();
      const log = (msg: string) => {
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.gray(ts)} ${msg}`);
      };
      await runGrid(adapter, {
        symbol: symbol.toUpperCase(),
        side: opts.side as "long" | "short" | "neutral",
        upperPrice: parseFloat(opts.upper),
        lowerPrice: parseFloat(opts.lower),
        grids: parseInt(opts.grids),
        totalSize: parseFloat(opts.size),
        leverage: opts.leverage ? parseInt(opts.leverage) : undefined,
        intervalSec: parseInt(opts.interval),
        maxRuntime: parseInt(opts.maxRuntime),
        trailingStop: opts.trailingStop ? parseFloat(opts.trailingStop) : undefined,
      }, undefined, log);
    });

  // ── DCA (shortcut with --background) ──

  trade
    .command("dca <symbol> <side> <amount> <interval>")
    .description("Run DCA strategy (foreground or --background)")
    .option("--orders <n>", "Total number of orders (0 = unlimited)", "0")
    .option("--price-limit <price>", "Stop buying above / selling below this price")
    .option("--max-runtime <sec>", "Max runtime in seconds (0 = forever)", "0")
    .option("--background", "Run in background (tmux)")
    .action(async (symbol: string, side: string, amount: string, interval: string, opts: {
      orders: string; priceLimit?: string; maxRuntime: string; background?: boolean;
    }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      const exchange = (await getAdapter()).name;
      const cliArgs = [
        `-e`, exchange, symbol.toUpperCase(), s, amount, interval,
        `--orders`, opts.orders, `--max-runtime`, opts.maxRuntime,
        ...(opts.priceLimit ? [`--price-limit`, opts.priceLimit] : []),
      ];

      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const job = startJob({
          strategy: "dca",
          exchange,
          params: { symbol: symbol.toUpperCase(), side: s, amount, interval, ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        console.log(chalk.green(`\n  DCA started in background.`));
        console.log(`  ID: ${chalk.white.bold(job.id)}`);
        console.log(`  ${s.toUpperCase()} ${amount} ${symbol.toUpperCase()} every ${interval}s`);
        console.log(`  Logs: ${chalk.gray(`perp jobs logs ${job.id}`)}`);
        console.log(`  Stop: ${chalk.gray(`perp jobs stop ${job.id}`)}\n`);
        return;
      }

      // Foreground
      const { runDCA } = await import("../strategies/dca.js");
      const adapter = await getAdapter();
      const log = (msg: string) => {
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.gray(ts)} ${msg}`);
      };
      await runDCA(adapter, {
        symbol: symbol.toUpperCase(),
        side: s as "buy" | "sell",
        amountPerOrder: parseFloat(amount),
        intervalSec: parseInt(interval),
        totalOrders: parseInt(opts.orders),
        priceLimit: opts.priceLimit ? parseFloat(opts.priceLimit) : undefined,
        maxRuntime: parseInt(opts.maxRuntime),
      }, undefined, log);
    });

  // ── Position Management Shortcuts ──

  trade
    .command("close-all")
    .description("Close all open positions (market orders on opposite side)")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        const positions = await adapter.getPositions();
        if (positions.length === 0) {
          if (isJson()) return printJson(jsonOk({ closed: 0, positions: [] }));
          console.log(chalk.yellow("\n  No open positions to close.\n"));
          return;
        }
        if (!isJson()) console.log(chalk.cyan(`\n  Closing ${positions.length} position(s) on ${adapter.name}...\n`));
        const results: unknown[] = [];
        for (const pos of positions) {
          const closeSide = pos.side === "long" ? "sell" : "buy";
          if (!isJson()) console.log(chalk.gray(`  ${closeSide.toUpperCase()} ${pos.size} ${pos.symbol} (closing ${pos.side})...`));
          const result = await adapter.marketOrder(pos.symbol, closeSide as "buy" | "sell", pos.size);
          results.push(result);
          logExecution({
            type: "market_order", exchange: adapter.name, symbol: pos.symbol,
            side: closeSide, size: pos.size, status: "success", dryRun: false,
            meta: { action: "close-all", originalSide: pos.side },
          });
        }
        if (isJson()) return printJson(jsonOk({ closed: results.length, results }));
        console.log(chalk.green(`\n  Closed ${results.length} position(s) on ${adapter.name}.\n`));
      });
    });

  trade
    .command("close <symbol>")
    .description("Close a specific symbol's position")
    .action(async (symbol: string) => {
      await withJsonErrors(isJson(), async () => {
        const sym = symbol.toUpperCase();
        const adapter = await getAdapter();
        const positions = await adapter.getPositions();
        const pos = positions.find(p => symbolMatch(p.symbol, sym));
        if (!pos) {
          if (isJson()) return printJson(jsonOk({ closed: false, reason: "no_position" }));
          errorAndExit(`No open position for ${sym}`);
        }
        const closeSide = pos.side === "long" ? "sell" : "buy";
        if (!isJson()) console.log(chalk.cyan(`\n  Closing ${pos.side} ${pos.size} ${sym} on ${adapter.name}...\n`));
        const result = await adapter.marketOrder(sym, closeSide as "buy" | "sell", pos.size);
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: sym,
          side: closeSide, size: pos.size, status: "success", dryRun: false,
          meta: { action: "close", originalSide: pos.side },
        });
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Closed ${pos.side} ${pos.size} ${sym} on ${adapter.name}.\n`));
      });
    });

  trade
    .command("flatten")
    .description("Cancel all orders AND close all positions (full cleanup)")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        if (!isJson()) console.log(chalk.cyan(`\n  Flattening account on ${adapter.name}...\n`));

        // Step 1: Cancel all orders
        if (!isJson()) console.log(chalk.gray("  Cancelling all open orders..."));
        const cancelResult = await adapter.cancelAllOrders();

        // Step 2: Close all positions
        const positions = await adapter.getPositions();
        const closeResults: unknown[] = [];
        for (const pos of positions) {
          const closeSide = pos.side === "long" ? "sell" : "buy";
          if (!isJson()) console.log(chalk.gray(`  ${closeSide.toUpperCase()} ${pos.size} ${pos.symbol} (closing ${pos.side})...`));
          const result = await adapter.marketOrder(pos.symbol, closeSide as "buy" | "sell", pos.size);
          closeResults.push(result);
          logExecution({
            type: "market_order", exchange: adapter.name, symbol: pos.symbol,
            side: closeSide, size: pos.size, status: "success", dryRun: false,
            meta: { action: "flatten", originalSide: pos.side },
          });
        }
        if (isJson()) return printJson(jsonOk({ ordersCancelled: cancelResult, positionsClosed: closeResults.length, closeResults }));
        console.log(chalk.green(`\n  Flattened: cancelled orders + closed ${closeResults.length} position(s) on ${adapter.name}.\n`));
      });
    });

  trade
    .command("reduce <symbol> <percent>")
    .description("Reduce a position by a percentage (e.g., perp trade reduce BTC 50)")
    .action(async (symbol: string, percent: string) => {
      await withJsonErrors(isJson(), async () => {
        const sym = symbol.toUpperCase();
        const pct = parseFloat(percent);
        if (isNaN(pct) || pct <= 0 || pct > 100) errorAndExit("Percent must be between 0 and 100");

        const adapter = await getAdapter();
        const positions = await adapter.getPositions();
        const pos = positions.find(p => symbolMatch(p.symbol, sym));
        if (!pos) {
          if (isJson()) return printJson(jsonOk({ reduced: false, reason: "no_position" }));
          errorAndExit(`No open position for ${sym}`);
        }
        const fullSize = parseFloat(pos.size);
        const reduceSize = (fullSize * pct / 100).toString();
        const closeSide = pos.side === "long" ? "sell" : "buy";
        if (!isJson()) console.log(chalk.cyan(`\n  Reducing ${sym} ${pos.side} by ${pct}% (${reduceSize} of ${pos.size}) on ${adapter.name}...\n`));
        const result = await adapter.marketOrder(sym, closeSide as "buy" | "sell", reduceSize);
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: sym,
          side: closeSide, size: reduceSize, status: "success", dryRun: false,
          meta: { action: "reduce", percent: pct, originalSize: pos.size, originalSide: pos.side },
        });
        if (isJson()) return printJson(jsonOk({ reduced: true, percent: pct, sizeReduced: reduceSize, originalSize: pos.size, result }));
        console.log(chalk.green(`\n  Reduced ${sym} by ${pct}% (${closeSide} ${reduceSize}) on ${adapter.name}.\n`));
      });
    });

  // ── Order Status Query ──

  trade
    .command("status <orderId>")
    .description("Query order status by ID")
    .action(async (orderId: string) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();

        if (adapter instanceof HyperliquidAdapter) {
          const result = await adapter.queryOrder(Number(orderId));
          if (isJson()) return printJson(jsonOk(result));
          const order = (result as Record<string, unknown>)?.order as Record<string, unknown> | undefined;
          if (!order) {
            console.log(chalk.gray(`\n  Order ${orderId} not found.\n`));
            return;
          }
          const o = (order.order ?? order) as Record<string, unknown>;
          console.log(chalk.cyan.bold(`\n  Order ${orderId}\n`));
          console.log(`  Symbol:  ${o.coin ?? o.symbol ?? ""}`);
          console.log(`  Side:    ${o.side === "B" ? chalk.green("BUY") : chalk.red("SELL")}`);
          console.log(`  Price:   $${formatUsd(String(o.limitPx ?? o.price ?? "0"))}`);
          console.log(`  Size:    ${o.sz ?? o.size ?? ""}`);
          console.log(`  Status:  ${(order as Record<string, unknown>).status ?? o.status ?? "unknown"}`);
          console.log();
          return;
        }

        // Generic: search order history
        const [openOrders, history] = await Promise.all([
          adapter.getOpenOrders(),
          adapter.getOrderHistory(100),
        ]);
        const found = [...openOrders, ...history].find(o => o.orderId === orderId);
        if (!found) {
          if (isJson()) return printJson(jsonError("ORDER_NOT_FOUND", `Order ${orderId} not found`));
          console.log(chalk.gray(`\n  Order ${orderId} not found.\n`));
          return;
        }
        if (isJson()) return printJson(jsonOk(found));
        console.log(chalk.cyan.bold(`\n  Order ${orderId}\n`));
        console.log(`  Symbol:  ${found.symbol}`);
        console.log(`  Side:    ${found.side === "buy" ? chalk.green("BUY") : chalk.red("SELL")}`);
        console.log(`  Type:    ${found.type}`);
        console.log(`  Price:   $${formatUsd(found.price)}`);
        console.log(`  Size:    ${found.size}`);
        console.log(`  Filled:  ${found.filled}`);
        console.log(`  Status:  ${found.status}`);
        console.log();
      });
    });

  // ── Recent Fills ──

  trade
    .command("fills [symbol]")
    .description("Recent trade fills, optionally filtered by symbol")
    .option("-l, --limit <n>", "Number of fills", "30")
    .action(async (symbol: string | undefined, opts: { limit: string }) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        const limit = parseInt(opts.limit);
        const trades = await adapter.getTradeHistory(limit);

        let filtered = trades;
        if (symbol) {
          const sym = symbol.toUpperCase();
          filtered = trades.filter(t => symbolMatch(t.symbol, sym));
        }

        if (isJson()) return printJson(jsonOk(filtered));

        if (filtered.length === 0) {
          console.log(chalk.gray(`\n  No fills${symbol ? ` for ${symbol.toUpperCase()}` : ""}.\n`));
          return;
        }

        const rows = filtered.map((t) => [
          new Date(t.time).toLocaleString(),
          chalk.white.bold(t.symbol),
          t.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
          `$${formatUsd(t.price)}`,
          t.size,
          `$${formatUsd(t.fee)}`,
        ]);
        console.log(
          (await import("../utils.js")).makeTable(
            ["Time", "Symbol", "Side", "Price", "Size", "Fee"],
            rows
          )
        );
      });
    });

  // ── Pre-Trade Validation ──

  trade
    .command("check <symbol> <side> <size>")
    .description("Validate a trade before execution (pre-flight check)")
    .option("--price <price>", "Price for limit orders")
    .option("--type <type>", "Order type: market, limit, stop", "market")
    .option("--leverage <n>", "Leverage to use")
    .option("--reduce-only", "Check as reduce-only order")
    .action(async (symbol: string, side: string, size: string, opts: { price?: string; type?: string; leverage?: string; reduceOnly?: boolean }) => {
      await withJsonErrors(isJson(), async () => {
        const s = side.toLowerCase();
        if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");

        const adapter = await getAdapter();
        const validation = await validateTrade(adapter, {
          symbol: symbol.toUpperCase(),
          side: s as "buy" | "sell",
          size: parseFloat(size),
          price: opts.price ? parseFloat(opts.price) : undefined,
          type: (opts.type ?? "market") as "market" | "limit" | "stop",
          leverage: opts.leverage ? parseInt(opts.leverage) : undefined,
          reduceOnly: opts.reduceOnly,
        });

        if (isJson()) return printJson(jsonOk(validation));

        console.log(chalk.cyan.bold(`\n  Pre-Trade Check: ${symbol.toUpperCase()} ${s.toUpperCase()} ${size}\n`));

        for (const check of validation.checks) {
          const icon = check.passed ? chalk.green("✓") : chalk.red("✗");
          console.log(`  ${icon} ${check.check}: ${check.message}`);
        }

        if (validation.warnings.length > 0) {
          console.log(chalk.yellow("\n  Warnings:"));
          for (const w of validation.warnings) {
            console.log(`    ⚠ ${w}`);
          }
        }

        if (validation.estimatedCost) {
          const c = validation.estimatedCost;
          console.log(chalk.white.bold("\n  Estimated Cost:"));
          console.log(`    Margin:   $${c.margin.toFixed(2)}`);
          console.log(`    Fee:      $${c.fee.toFixed(2)}`);
          console.log(`    Slippage: $${c.slippage.toFixed(2)}`);
          console.log(`    Total:    $${c.total.toFixed(2)}`);
        }

        const resultColor = validation.valid ? chalk.green : chalk.red;
        console.log(`\n  Result: ${resultColor(validation.valid ? "VALID — safe to execute" : "INVALID — do not execute")}\n`);
      });
    });

}
