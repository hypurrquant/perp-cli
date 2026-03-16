import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import { printJson, errorAndExit, withJsonErrors, jsonOk, jsonError, symbolMatch, formatUsd } from "../utils.js";
import { logExecution } from "../execution-log.js";
import { validateTrade } from "../trade-validator.js";
import { generateClientId, logClientId, isOrderDuplicate } from "../client-id-tracker.js";
import { smartOrder } from "../smart-order.js";
import chalk from "chalk";

function pac(adapter: ExchangeAdapter): PacificaAdapter {
  if (!(adapter instanceof PacificaAdapter)) throw new Error("This command requires --exchange pacifica");
  return adapter;
}

export function registerTradeCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  isDryRun: () => boolean = () => false,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
) {
  /** Guard: if --dry-run is active, log the intended action and return without executing. */
  function dryRunGuard(action: string, details: Record<string, unknown>): boolean {
    if (!isDryRun()) return false;
    const info = { dryRun: true, action, ...details, timestamp: new Date().toISOString() };
    if (isJson()) {
      printJson(jsonOk(info));
    } else {
      console.log(chalk.yellow(`\n  [DRY RUN] Would ${action}:`));
      for (const [k, v] of Object.entries(details)) {
        console.log(chalk.gray(`    ${k}: ${v}`));
      }
      console.log();
    }
    logExecution({
      type: action.includes("split") ? "split_order" : action.includes("limit") ? "limit_order" : action.includes("stop") ? "stop_order" : action.includes("cancel") ? "cancel" : "market_order",
      exchange: details.exchange as string ?? "unknown",
      symbol: (details.symbol as string ?? "").toUpperCase(),
      side: details.side as string ?? "",
      size: String(details.size ?? details.totalUsd ?? "0"),
      price: details.price as string,
      status: "simulated",
      dryRun: true,
    });
    return true;
  }

  const trade = program.command("trade").description("Trading commands");

  // === Generic commands (all exchanges) ===

  trade
    .command("market <symbol> <side> <size>")
    .description("Place a market order (side: buy/sell)")
    .option("-s, --slippage <pct>", "Slippage percent", "1")
    .option("--reduce-only", "Reduce only order")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick (reduces slippage)")
    .option("--split", "Use orderbook-aware split execution for large orders")
    .option("--max-slippage <pct>", "Max slippage per split slice (%)", "0.3")
    .option("--client-id <id>", "Client order ID for idempotent tracking")
    .option("--auto-id", "Auto-generate a client order ID")
    .action(async (symbol: string, side: string, size: string, opts: { slippage: string; reduceOnly?: boolean; smart?: boolean; split?: boolean; maxSlippage?: string; clientId?: string; autoId?: boolean }) => {
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      const sym = symbol.toUpperCase();

      // ── Split execution branch ──
      if (opts.split) {
        const adapter = await getAdapter();
        if (dryRunGuard("split-order", { exchange: adapter.name, symbol: sym, side: s, size })) return;

        const { runSplitOrder } = await import("../strategies/split-order.js");
        const markets = await adapter.getMarkets();
        const market = markets.find(m => symbolMatch(m.symbol, sym));
        const markPrice = market ? parseFloat(market.markPrice) : 0;
        const notionalUsd = markPrice > 0 ? parseFloat(size) * markPrice : parseFloat(size);

        const result = await runSplitOrder(adapter, {
          symbol: sym,
          side: s as "buy" | "sell",
          totalSizeUsd: notionalUsd,
          maxSlippagePct: parseFloat(opts.maxSlippage ?? "0.3"),
        }, isJson() ? () => {} : (msg) => console.log(chalk.gray(`  ${msg}`)));

        if (isJson()) return printJson(jsonOk(result));
        const statusColor = result.status === "complete" ? chalk.green : result.status === "partial" ? chalk.yellow : chalk.red;
        console.log(`\n  ${statusColor(result.status.toUpperCase())} | ${result.slices.length} slices | $${formatUsd(result.filledUsd)} filled | slippage: ${result.totalSlippagePct.toFixed(3)}%\n`);
        return;
      }

      const clientId = opts.autoId ? generateClientId() : opts.clientId;

      if (clientId && isOrderDuplicate(clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${clientId}). Skipping.\n`));
        return;
      }

      const adapter = await getAdapter();

      if (dryRunGuard("market_order", { exchange: adapter.name, symbol: sym, side: s, size, smart: !!opts.smart })) return;

      if (clientId) {
        logClientId({
          clientOrderId: clientId, exchange: adapter.name,
          symbol: symbol.toUpperCase(), side: s, size, type: "market",
          status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }

      let result: unknown;
      try {
        if (opts.smart) {
          const sr = await smartOrder(adapter, symbol.toUpperCase(), s as "buy" | "sell", size);
          result = { ...sr.result as object, smartOrder: { method: sr.method, price: sr.price, bestBookPrice: sr.bestBookPrice, tickSize: sr.tickSize } };
        } else {
          result = await adapter.marketOrder(symbol.toUpperCase(), s as "buy" | "sell", size);
        }
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(),
          side: s, size, status: "success", dryRun: false,
          meta: { ...(clientId ? { clientOrderId: clientId } : {}), ...(opts.smart ? { smart: true } : {}) },
        });
      } catch (err) {
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(),
          side: s, size, status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { ...(clientId ? { clientOrderId: clientId } : {}), ...(opts.smart ? { smart: true } : {}) },
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
      console.log(chalk.green(`\n  Market ${s.toUpperCase()} ${size} ${symbol.toUpperCase()} placed on ${adapter.name}.${opts.smart ? " (smart)" : ""}${clientId ? ` (id: ${clientId})` : ""}\n`));
      printJson(jsonOk(result));
    });

  // Shortcuts: trade buy / trade sell
  trade
    .command("buy <symbol> <size>")
    .description("Market buy (shortcut for: trade market <symbol> buy <size>)")
    .option("-s, --slippage <pct>", "Slippage percent", "1")
    .option("--reduce-only", "Reduce only order")
    .option("--smart", "Smart execution: IOC limit at best ask + 1 tick")
    .option("--client-id <id>", "Client order ID")
    .option("--auto-id", "Auto-generate client order ID")
    .action(async (symbol: string, size: string, opts: { slippage: string; reduceOnly?: boolean; smart?: boolean; clientId?: string; autoId?: boolean }) => {
      const clientId = opts.autoId ? generateClientId() : opts.clientId;
      if (clientId && isOrderDuplicate(clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${clientId}). Skipping.\n`));
        return;
      }
      const adapter = await getAdapter();
      if (dryRunGuard("market_order", { exchange: adapter.name, symbol: symbol.toUpperCase(), side: "buy", size, smart: !!opts.smart })) return;
      let result: unknown;
      try {
        if (opts.smart) {
          const sr = await smartOrder(adapter, symbol.toUpperCase(), "buy", size);
          result = { ...sr.result as object, smartOrder: { method: sr.method, price: sr.price, bestBookPrice: sr.bestBookPrice, tickSize: sr.tickSize } };
        } else {
          result = await adapter.marketOrder(symbol.toUpperCase(), "buy", size);
        }
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "buy", size, status: "success", dryRun: false, meta: opts.smart ? { smart: true } : undefined });
      } catch (err) {
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "buy", size, status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      if (isJson()) return printJson(jsonOk(clientId ? { ...result as object, clientOrderId: clientId } : result));
      console.log(chalk.green(`\n  Market BUY ${size} ${symbol.toUpperCase()} placed on ${adapter.name}.${opts.smart ? " (smart)" : ""}\n`));
      printJson(jsonOk(result));
    });

  trade
    .command("sell <symbol> <size>")
    .description("Market sell (shortcut for: trade market <symbol> sell <size>)")
    .option("-s, --slippage <pct>", "Slippage percent", "1")
    .option("--reduce-only", "Reduce only order")
    .option("--smart", "Smart execution: IOC limit at best bid - 1 tick")
    .option("--client-id <id>", "Client order ID")
    .option("--auto-id", "Auto-generate client order ID")
    .action(async (symbol: string, size: string, opts: { slippage: string; reduceOnly?: boolean; smart?: boolean; clientId?: string; autoId?: boolean }) => {
      const clientId = opts.autoId ? generateClientId() : opts.clientId;
      if (clientId && isOrderDuplicate(clientId)) {
        if (isJson()) return printJson(jsonOk({ duplicate: true, clientOrderId: clientId, message: "Order already submitted" }));
        console.log(chalk.yellow(`\n  Duplicate order detected (clientId: ${clientId}). Skipping.\n`));
        return;
      }
      const adapter = await getAdapter();
      if (dryRunGuard("market_order", { exchange: adapter.name, symbol: symbol.toUpperCase(), side: "sell", size, smart: !!opts.smart })) return;
      let result: unknown;
      try {
        if (opts.smart) {
          const sr = await smartOrder(adapter, symbol.toUpperCase(), "sell", size);
          result = { ...sr.result as object, smartOrder: { method: sr.method, price: sr.price, bestBookPrice: sr.bestBookPrice, tickSize: sr.tickSize } };
        } else {
          result = await adapter.marketOrder(symbol.toUpperCase(), "sell", size);
        }
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "sell", size, status: "success", dryRun: false, meta: opts.smart ? { smart: true } : undefined });
      } catch (err) {
        logExecution({ type: "market_order", exchange: adapter.name, symbol: symbol.toUpperCase(), side: "sell", size, status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      if (isJson()) return printJson(jsonOk(clientId ? { ...result as object, clientOrderId: clientId } : result));
      console.log(chalk.green(`\n  Market SELL ${size} ${symbol.toUpperCase()} placed on ${adapter.name}.${opts.smart ? " (smart)" : ""}\n`));
      printJson(jsonOk(result));
    });

  // ── Split Order (orderbook-aware) ──
  trade
    .command("split <symbol> <side> <usd>")
    .description("Orderbook-aware split execution — breaks large orders into slices based on depth")
    .option("--max-slippage <pct>", "Max slippage per slice (%)", "0.3")
    .option("--max-slices <n>", "Max number of slices", "10")
    .option("--delay <ms>", "Delay between slices in ms", "1000")
    .option("--min-slice <usd>", "Minimum slice size in USD", "100")
    .action(async (symbol: string, side: string, usd: string, opts: {
      maxSlippage: string; maxSlices: string; delay: string; minSlice: string;
    }) => {
      const sym = symbol.toUpperCase();
      const orderSide = side.toLowerCase() as "buy" | "sell";
      const totalUsd = parseFloat(usd);

      if (!["buy", "sell"].includes(orderSide)) errorAndExit("Side must be 'buy' or 'sell'");
      if (isNaN(totalUsd) || totalUsd <= 0) errorAndExit("USD amount must be > 0");

      const exchange = program.opts().exchange ?? "unknown";
      if (dryRunGuard("split-order", { exchange, symbol: sym, side: orderSide, totalUsd, ...opts })) return;

      const adapter = await getAdapter();
      const { runSplitOrder } = await import("../strategies/split-order.js");

      const result = await runSplitOrder(adapter, {
        symbol: sym,
        side: orderSide,
        totalSizeUsd: totalUsd,
        maxSlippagePct: parseFloat(opts.maxSlippage),
        maxSlices: parseInt(opts.maxSlices),
        delayMs: parseInt(opts.delay),
        minSliceUsd: parseFloat(opts.minSlice),
      }, isJson() ? () => {} : (msg) => console.log(chalk.gray(`  ${msg}`)));

      if (isJson()) return printJson(jsonOk(result));

      const statusColor = result.status === "complete" ? chalk.green
        : result.status === "partial" ? chalk.yellow
        : chalk.red;

      console.log(`\n  ${statusColor(result.status.toUpperCase())} | ${result.slices.length} slices`);
      console.log(`  Filled: $${formatUsd(result.filledUsd)} / $${formatUsd(result.requestedUsd)}`);
      console.log(`  Avg Price: $${formatUsd(result.avgPrice)}`);
      console.log(`  Slippage: ${result.totalSlippagePct.toFixed(3)}%`);
      console.log(`  Runtime: ${result.runtime.toFixed(1)}s\n`);
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

      if (dryRunGuard("limit_order", { exchange: adapter.name, symbol: symbol.toUpperCase(), side: s, size, price })) return;

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
    .command("cancel <symbolOrOrderId> [orderId]")
    .description("Cancel order(s) — by orderId, by symbol + orderId, or by symbol name (cancels all orders for that symbol)")
    .action(async (symbolOrOrderId: string, orderId?: string) => {
      const adapter = await getAdapter();

      if (orderId) {
        // cancel <symbol> <orderId>
        const symbol = symbolOrOrderId.toUpperCase();
        const oid = orderId;
        if (dryRunGuard("cancel", { exchange: adapter.name, symbol, orderId: oid })) return;
        try {
          const result = await adapter.cancelOrder(symbol, oid);
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "success", dryRun: false, meta: { orderId: oid } });
          if (isJson()) return printJson(jsonOk(result));
          console.log(chalk.green(`\n  Order ${oid} cancelled on ${adapter.name}.\n`));
        } catch (err) {
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err), meta: { orderId: oid } });
          throw err;
        }
        return;
      }

      // Single argument — is it an orderId (numeric) or a symbol name?
      const isNumeric = /^\d+$/.test(symbolOrOrderId);

      if (isNumeric) {
        // cancel <orderId> — look up symbol from open orders
        const oid = symbolOrOrderId;
        const orders = await adapter.getOpenOrders();
        const match = orders.find((o) => String(o.orderId) === oid);
        if (!match) {
          const err = `Order ${oid} not found in open orders`;
          if (isJson()) return printJson(jsonOk({ cancelled: false, reason: err }));
          console.log(chalk.yellow(`\n  ${err}\n`));
          return;
        }
        const symbol = match.symbol;
        if (dryRunGuard("cancel", { exchange: adapter.name, symbol, orderId: oid })) return;
        try {
          const result = await adapter.cancelOrder(symbol, oid);
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "success", dryRun: false, meta: { orderId: oid } });
          if (isJson()) return printJson(jsonOk(result));
          console.log(chalk.green(`\n  Order ${oid} cancelled on ${adapter.name}.\n`));
        } catch (err) {
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err), meta: { orderId: oid } });
          throw err;
        }
      } else {
        // cancel <symbol> — cancel all open orders for this symbol
        const symbol = symbolOrOrderId.toUpperCase();
        const orders = await adapter.getOpenOrders();
        const matching = orders.filter((o) => symbolMatch(o.symbol, symbol));
        if (matching.length === 0) {
          const err = `No open orders found for ${symbol}`;
          if (isJson()) return printJson(jsonOk({ cancelled: false, symbol, reason: err }));
          console.log(chalk.yellow(`\n  ${err}\n`));
          return;
        }
        if (dryRunGuard("cancel_by_symbol", { exchange: adapter.name, symbol, count: matching.length })) return;
        try {
          const result = await adapter.cancelAllOrders(symbol);
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "success", dryRun: false, meta: { bySymbol: true, count: matching.length } });
          if (isJson()) return printJson(jsonOk({ cancelled: true, symbol, count: matching.length, result }));
          console.log(chalk.green(`\n  ${matching.length} order(s) for ${symbol} cancelled on ${adapter.name}.\n`));
        } catch (err) {
          logExecution({ type: "cancel", exchange: adapter.name, symbol, side: "cancel", size: "0", status: "failed", dryRun: false, error: err instanceof Error ? err.message : String(err), meta: { bySymbol: true } });
          throw err;
        }
      }
    });

  trade
    .command("cancel-all")
    .description("Cancel all open orders")
    .action(async () => {
      const adapter = await getAdapter();
      if (dryRunGuard("cancel_all", { exchange: adapter.name })) return;
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
      if (dryRunGuard("stop_order", { exchange: adapter.name, symbol: symbol.toUpperCase(), side: s, size, price: stopPrice })) return;
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
      if (dryRunGuard("tpsl", { exchange: adapter.name, symbol: symbol.toUpperCase(), side: s, tp: opts.tp ?? "none", sl: opts.sl ?? "none" })) return;

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

  // === Scaled Take-Profit (분할익절) ===

  trade
    .command("scale-tp <symbol>")
    .description("Place multiple take-profit limit orders at different price levels (분할익절)")
    .requiredOption("--levels <levels>", "Comma-separated price:percent pairs (e.g., 72000:25,75000:25,80000:50)")
    .option("--size <size>", "Override total position size (default: uses current position)")
    .action(async (symbol: string, opts: { levels: string; size?: string }) => {
      const sym = symbol.toUpperCase();
      const adapter = await getAdapter();

      // Parse levels: "72000:25,75000:25,80000:50"
      const levels = opts.levels.split(",").map(l => {
        const [price, pct] = l.trim().split(":");
        if (!price || !pct) errorAndExit(`Invalid level format: ${l}. Use price:percent (e.g., 72000:25)`);
        return { price: price.trim(), pct: parseFloat(pct.trim()) };
      });

      // Validate percentages sum to 100
      const totalPct = levels.reduce((s, l) => s + l.pct, 0);
      if (Math.abs(totalPct - 100) > 0.01) {
        errorAndExit(`Percentages must sum to 100%. Got: ${totalPct}%`);
      }

      // Get current position to determine size and side
      let totalSize: number;
      let closeSide: "buy" | "sell";

      if (opts.size) {
        totalSize = parseFloat(opts.size);
        // Need to know position side — fetch it
        const positions = await adapter.getPositions();
        const pos = positions.find(p => p.symbol.toUpperCase() === sym);
        closeSide = pos?.side === "short" ? "buy" : "sell";
      } else {
        const positions = await adapter.getPositions();
        const pos = positions.find(p => p.symbol.toUpperCase() === sym);
        if (!pos) errorAndExit(`No open position for ${sym}. Use --size to specify manually.`);
        totalSize = parseFloat(pos.size);
        closeSide = pos.side === "long" ? "sell" : "buy";
      }

      if (dryRunGuard("scale_tp", {
        exchange: adapter.name, symbol: sym, side: closeSide,
        totalSize: totalSize.toString(),
        levels: levels.map(l => `${l.price}@${l.pct}%`).join(", "),
      })) return;

      // Place reduce-only limit orders at each level
      const results: Array<{ price: string; size: string; pct: number; result: unknown }> = [];
      for (const level of levels) {
        const levelSize = (totalSize * level.pct / 100).toString();
        try {
          const result = await adapter.limitOrder(sym, closeSide, level.price, levelSize, { reduceOnly: true });
          results.push({ price: level.price, size: levelSize, pct: level.pct, result });
          logExecution({
            type: "limit_order", exchange: adapter.name, symbol: sym,
            side: closeSide, size: levelSize, price: level.price,
            status: "success", dryRun: false,
            meta: { action: "scale-tp", pct: level.pct, reduceOnly: true },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logExecution({
            type: "limit_order", exchange: adapter.name, symbol: sym,
            side: closeSide, size: levelSize, price: level.price,
            status: "failed", dryRun: false, error: msg,
            meta: { action: "scale-tp", pct: level.pct },
          });
          if (isJson()) {
            results.push({ price: level.price, size: levelSize, pct: level.pct, result: { error: msg } });
          } else {
            console.log(chalk.red(`  Failed: ${level.price} x ${levelSize} — ${msg}`));
          }
        }
      }

      if (isJson()) return printJson(jsonOk({ symbol: sym, side: closeSide, totalSize, levels: results }));

      console.log(chalk.green(`\n  Scaled TP set for ${sym} on ${adapter.name}:\n`));
      for (const r of results) {
        const status = (r.result as Record<string, unknown>)?.error ? chalk.red("FAILED") : chalk.green("OK");
        console.log(`  ${status}  $${r.price} — ${r.pct}% (${r.size} ${sym})`);
      }
      console.log();
    });

  // === Pacifica-only commands ===

  trade
    .command("edit <symbol> <orderId> <price> <size>")
    .description("Edit an existing order")
    .action(async (symbol: string, orderId: string, price: string, size: string) => {
      const adapter = await getAdapter();
      if (dryRunGuard("edit_order", { exchange: adapter.name, symbol: symbol.toUpperCase(), orderId, price, size })) return;
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
      if (dryRunGuard("set_leverage", { exchange: adapter.name, symbol: symbol.toUpperCase(), leverage, mode })) return;
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

  // grid/dca moved to 'perp bot grid' / 'perp bot dca'

  // ── Position Management Shortcuts ──

  trade
    .command("close-all")
    .description("Close all open positions (market orders on opposite side)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .action(async (opts: { smart?: boolean }) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        if (dryRunGuard("close_all", { exchange: adapter.name, smart: !!opts.smart })) return;
        const positions = await adapter.getPositions();
        if (positions.length === 0) {
          if (isJson()) return printJson(jsonOk({ closed: 0, positions: [] }));
          console.log(chalk.yellow("\n  No open positions to close.\n"));
          return;
        }
        if (!isJson()) console.log(chalk.cyan(`\n  Closing ${positions.length} position(s) on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));
        const results: unknown[] = [];
        for (const pos of positions) {
          const closeSide = pos.side === "long" ? "sell" : "buy";
          if (!isJson()) console.log(chalk.gray(`  ${closeSide.toUpperCase()} ${pos.size} ${pos.symbol} (closing ${pos.side})...`));
          let result: unknown;
          if (opts.smart) {
            const sr = await smartOrder(adapter, pos.symbol, closeSide as "buy" | "sell", pos.size, { reduceOnly: true });
            result = { ...sr.result as object, smartOrder: { method: sr.method, price: sr.price, bestBookPrice: sr.bestBookPrice } };
          } else {
            result = await adapter.marketOrder(pos.symbol, closeSide as "buy" | "sell", pos.size);
          }
          results.push(result);
          logExecution({
            type: "market_order", exchange: adapter.name, symbol: pos.symbol,
            side: closeSide, size: pos.size, status: "success", dryRun: false,
            meta: { action: "close-all", originalSide: pos.side, smart: !!opts.smart },
          });
        }
        if (isJson()) return printJson(jsonOk({ closed: results.length, results }));
        console.log(chalk.green(`\n  Closed ${results.length} position(s) on ${adapter.name}.\n`));
      });
    });

  trade
    .command("close <symbol>")
    .description("Close a specific symbol's position")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .action(async (symbol: string, opts: { smart?: boolean }) => {
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
        if (dryRunGuard("close", { exchange: adapter.name, symbol: sym, side: closeSide, size: pos.size, originalSide: pos.side, smart: !!opts.smart })) return;
        if (!isJson()) console.log(chalk.cyan(`\n  Closing ${pos.side} ${pos.size} ${sym} on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));
        let result: unknown;
        if (opts.smart) {
          const sr = await smartOrder(adapter, sym, closeSide as "buy" | "sell", pos.size, { reduceOnly: true });
          result = { ...sr.result as object, smartOrder: { method: sr.method, price: sr.price, bestBookPrice: sr.bestBookPrice } };
        } else {
          result = await adapter.marketOrder(sym, closeSide as "buy" | "sell", pos.size);
        }
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: sym,
          side: closeSide, size: pos.size, status: "success", dryRun: false,
          meta: { action: "close", originalSide: pos.side, smart: !!opts.smart },
        });
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Closed ${pos.side} ${pos.size} ${sym} on ${adapter.name}.${opts.smart ? " (smart)" : ""}\n`));
      });
    });

  trade
    .command("flatten")
    .description("Cancel all orders AND close all positions (full cleanup)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .action(async (opts: { smart?: boolean }) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        if (dryRunGuard("flatten", { exchange: adapter.name, smart: !!opts.smart })) return;
        if (!isJson()) console.log(chalk.cyan(`\n  Flattening account on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));

        // Step 1: Cancel all orders
        if (!isJson()) console.log(chalk.gray("  Cancelling all open orders..."));
        const cancelResult = await adapter.cancelAllOrders();

        // Step 2: Close all positions
        const positions = await adapter.getPositions();
        const closeResults: unknown[] = [];
        for (const pos of positions) {
          const closeSide = pos.side === "long" ? "sell" : "buy";
          if (!isJson()) console.log(chalk.gray(`  ${closeSide.toUpperCase()} ${pos.size} ${pos.symbol} (closing ${pos.side})...`));
          let result: unknown;
          if (opts.smart) {
            const sr = await smartOrder(adapter, pos.symbol, closeSide as "buy" | "sell", pos.size, { reduceOnly: true });
            result = sr.result;
          } else {
            result = await adapter.marketOrder(pos.symbol, closeSide as "buy" | "sell", pos.size);
          }
          closeResults.push(result);
          logExecution({
            type: "market_order", exchange: adapter.name, symbol: pos.symbol,
            side: closeSide, size: pos.size, status: "success", dryRun: false,
            meta: { action: "flatten", originalSide: pos.side, smart: !!opts.smart },
          });
        }
        if (isJson()) return printJson(jsonOk({ ordersCancelled: cancelResult, positionsClosed: closeResults.length, closeResults }));
        console.log(chalk.green(`\n  Flattened: cancelled orders + closed ${closeResults.length} position(s) on ${adapter.name}.\n`));
      });
    });

  trade
    .command("reduce <symbol> <percent>")
    .description("Reduce a position by a percentage (e.g., perp trade reduce BTC 50)")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick")
    .action(async (symbol: string, percent: string, opts: { smart?: boolean }) => {
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
        if (dryRunGuard("reduce", { exchange: adapter.name, symbol: sym, side: closeSide, size: reduceSize, percent: pct, originalSize: pos.size, smart: !!opts.smart })) return;
        if (!isJson()) console.log(chalk.cyan(`\n  Reducing ${sym} ${pos.side} by ${pct}% (${reduceSize} of ${pos.size}) on ${adapter.name}...${opts.smart ? " (smart)" : ""}\n`));
        let result: unknown;
        if (opts.smart) {
          const sr = await smartOrder(adapter, sym, closeSide as "buy" | "sell", reduceSize, { reduceOnly: true });
          result = sr.result;
        } else {
          result = await adapter.marketOrder(sym, closeSide as "buy" | "sell", reduceSize);
        }
        logExecution({
          type: "market_order", exchange: adapter.name, symbol: sym,
          side: closeSide, size: reduceSize, status: "success", dryRun: false,
          meta: { action: "reduce", percent: pct, originalSize: pos.size, originalSide: pos.side, smart: !!opts.smart },
        });
        if (isJson()) return printJson(jsonOk({ reduced: true, percent: pct, sizeReduced: reduceSize, originalSize: pos.size, result }));
        console.log(chalk.green(`\n  Reduced ${sym} by ${pct}% (${closeSide} ${reduceSize}) on ${adapter.name}.${opts.smart ? " (smart)" : ""}\n`));
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

  // ── Scale-In (분할매수) ──

  trade
    .command("scale-in <symbol> <side>")
    .description("Place multiple limit orders at different price levels to build a position gradually (분할매수)")
    .requiredOption("--levels <levels>", "Comma-separated price:percent pairs (e.g., 65000:30,63000:30,60000:40)")
    .option("--size-usd <usd>", "Total USD amount to deploy across all levels")
    .option("--size <base>", "Total base amount (e.g., 0.01 BTC)")
    .action(async (symbol: string, side: string, opts: { levels: string; sizeUsd?: string; size?: string }) => {
      const sym = symbol.toUpperCase();
      const s = side.toLowerCase();
      if (s !== "buy" && s !== "sell") errorAndExit("Side must be buy or sell");
      if (!opts.sizeUsd && !opts.size) errorAndExit("Must specify --size-usd or --size");

      // Parse levels: "65000:30,63000:30,60000:40"
      const levels = opts.levels.split(",").map(l => {
        const [price, pct] = l.trim().split(":");
        if (!price || !pct) errorAndExit(`Invalid level format: ${l}. Use price:percent (e.g., 65000:30)`);
        return { price: price.trim(), pct: parseFloat(pct.trim()) };
      });

      // Validate percentages sum to 100
      const totalPct = levels.reduce((sum, l) => sum + l.pct, 0);
      if (Math.abs(totalPct - 100) > 0.01) {
        errorAndExit(`Percentages must sum to 100%. Got: ${totalPct}%`);
      }

      const adapter = await getAdapter();

      // Compute sizes for each level
      let levelSizes: { price: string; size: string; pct: number }[];
      if (opts.sizeUsd) {
        const totalUsd = parseFloat(opts.sizeUsd);
        levelSizes = levels.map(l => ({
          price: l.price,
          pct: l.pct,
          size: (totalUsd * l.pct / 100 / parseFloat(l.price)).toString(),
        }));
      } else {
        const totalBase = parseFloat(opts.size!);
        levelSizes = levels.map(l => ({
          price: l.price,
          pct: l.pct,
          size: (totalBase * l.pct / 100).toString(),
        }));
      }

      if (dryRunGuard("scale_in", {
        exchange: adapter.name, symbol: sym, side: s,
        totalSizeUsd: opts.sizeUsd ?? "N/A",
        totalSizeBase: opts.size ?? "N/A",
        levels: levelSizes.map(l => `${l.price}@${l.pct}% (${l.size})`).join(", "),
      })) return;

      // Place limit orders at each level (NOT reduce-only — opening positions)
      const results: Array<{ price: string; size: string; pct: number; result: unknown }> = [];
      for (const level of levelSizes) {
        try {
          const result = await adapter.limitOrder(sym, s as "buy" | "sell", level.price, level.size);
          results.push({ price: level.price, size: level.size, pct: level.pct, result });
          logExecution({
            type: "limit_order", exchange: adapter.name, symbol: sym,
            side: s, size: level.size, price: level.price,
            status: "success", dryRun: false,
            meta: { action: "scale-in", pct: level.pct },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logExecution({
            type: "limit_order", exchange: adapter.name, symbol: sym,
            side: s, size: level.size, price: level.price,
            status: "failed", dryRun: false, error: msg,
            meta: { action: "scale-in", pct: level.pct },
          });
          if (isJson()) {
            results.push({ price: level.price, size: level.size, pct: level.pct, result: { error: msg } });
          } else {
            console.log(chalk.red(`  Failed: ${level.price} x ${level.size} — ${msg}`));
          }
        }
      }

      if (isJson()) return printJson(jsonOk({ symbol: sym, side: s, levels: results }));

      console.log(chalk.green(`\n  Scale-in orders placed for ${sym} on ${adapter.name}:\n`));
      for (const r of results) {
        const status = (r.result as Record<string, unknown>)?.error ? chalk.red("FAILED") : chalk.green("OK");
        console.log(`  ${status}  $${r.price} — ${r.pct}% (${r.size} ${sym})`);
      }
      console.log();
    });

  // grid/dca/trailing-stop moved to 'perp bot'

  // ── PnL Tracker ──

  trade
    .command("pnl-track")
    .description("Live-monitor positions with real-time PnL updates")
    .option("--interval <sec>", "Refresh interval in seconds", "3")
    .option("--symbol <sym>", "Filter to a specific symbol")
    .action(async (opts: { interval: string; symbol?: string }) => {
      const intervalSec = parseInt(opts.interval);
      const filterSym = opts.symbol?.toUpperCase();

      const adapter = await getAdapter();

      console.log(chalk.cyan(`\n  PnL Tracker | ${adapter.name} | Interval: ${intervalSec}s`));
      if (filterSym) console.log(chalk.cyan(`  Filtering: ${filterSym}`));
      console.log(chalk.gray(`  Press Ctrl+C to stop.\n`));

      let running = true;
      const cleanup = () => { running = false; };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      try {
        while (running) {
          const [positions, balance] = await Promise.all([
            adapter.getPositions(),
            adapter.getBalance(),
          ]);

          let filtered = positions;
          if (filterSym) {
            filtered = positions.filter(p => symbolMatch(p.symbol, filterSym));
          }

          // Fetch funding payments (recent) for display
          let fundingBySymbol: Record<string, number> = {};
          try {
            const payments = await adapter.getFundingPayments(50);
            for (const fp of payments) {
              const sym = fp.symbol.toUpperCase();
              fundingBySymbol[sym] = (fundingBySymbol[sym] || 0) + parseFloat(fp.payment);
            }
          } catch {
            // funding payments may not be supported on all exchanges
          }

          console.clear();
          console.log(chalk.cyan.bold(`\n  PnL Tracker — ${adapter.name} | ${new Date().toLocaleTimeString()}\n`));
          console.log(`  Equity: $${formatUsd(balance.equity)} | Available: $${formatUsd(balance.available)} | Margin: $${formatUsd(balance.marginUsed)} | uPnL: $${formatUsd(balance.unrealizedPnl)}\n`);

          if (filtered.length === 0) {
            console.log(chalk.gray(`  No open positions${filterSym ? ` for ${filterSym}` : ""}.`));
          } else {
            const { makeTable } = await import("../utils.js");
            const rows = filtered.map(p => {
              const entry = parseFloat(p.entryPrice);
              const mark = parseFloat(p.markPrice);
              const pnl = parseFloat(p.unrealizedPnl);
              const notional = parseFloat(p.size) * entry;
              const pnlPct = notional > 0 ? (pnl / notional) * 100 : 0;
              const funding = fundingBySymbol[p.symbol.toUpperCase()] || 0;
              const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
              const pctColor = pnlPct >= 0 ? chalk.green : chalk.red;
              return [
                chalk.white.bold(p.symbol),
                p.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
                p.size,
                `$${formatUsd(p.entryPrice)}`,
                `$${formatUsd(p.markPrice)}`,
                pnlColor(`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`),
                pctColor(`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`),
                funding !== 0 ? `$${funding.toFixed(4)}` : "-",
              ];
            });
            console.log(makeTable(
              ["Symbol", "Side", "Size", "Entry", "Mark", "PnL", "PnL%", "Funding"],
              rows,
            ));
          }

          console.log(chalk.gray(`\n  Refreshing every ${intervalSec}s... Press Ctrl+C to stop.`));
          await new Promise(r => setTimeout(r, intervalSec * 1000));
        }
      } finally {
        process.removeListener("SIGINT", cleanup);
        process.removeListener("SIGTERM", cleanup);
      }

      console.log(chalk.yellow(`\n  PnL tracker stopped.\n`));
    });

  // ── Multi-leg orders ──────────────────────────────────────────────────
  if (getAdapterForExchange) {
    const tradeCmd = program.commands.find(c => c.name() === "trade");
    if (tradeCmd) {
      registerMultiAction(tradeCmd, getAdapterForExchange, isJson);
    }
    // Keep deprecated top-level 'multi' alias (hidden from help)
    registerMultiAction(program, getAdapterForExchange, isJson, true);
  }
}

// ── Multi-leg helpers ──────────────────────────────────────────────────

interface MultiLeg {
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  size: string;
}

interface MultiLegResult {
  leg: MultiLeg;
  status: "filled" | "failed" | "rolled_back";
  result?: unknown;
  error?: string;
}

function parseMultiLeg(spec: string): MultiLeg {
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

function registerMultiAction(
  parent: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  deprecated = false,
) {
  const cmd = parent
    .command("multi <legs...>")
    .description(deprecated ? "Use 'perp trade multi'" : "Execute multi-leg orders (exchange:symbol:side:size)");
  if (deprecated) (cmd as any)._hidden = true;
  cmd
    .option("--smart", "Use smart order (IOC limit + fallback) for each leg")
    .option("--rollback", "Auto-rollback filled legs if any leg fails", true)
    .option("--no-rollback", "Disable auto-rollback")
    .option("--timeout <ms>", "Per-leg timeout in milliseconds", "30000")
    .action(async (legSpecs: string[], opts: { smart?: boolean; rollback: boolean; timeout: string }) => {
      await withJsonErrors(isJson(), async () => {
        // Parse legs
        const legs = legSpecs.map(parseMultiLeg);

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
          legs.map(async (leg): Promise<MultiLegResult> => {
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
        const legResults: MultiLegResult[] = results.map((r, i) => {
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
