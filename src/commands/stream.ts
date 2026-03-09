import { Command } from "commander";
import { PacificaWSClient, type Network } from "../pacifica/index.js";
import chalk from "chalk";
import { formatUsd, formatPercent } from "../utils.js";

import type { Exchange } from "../config.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

export function registerStreamCommands(
  program: Command,
  getNetwork: () => Network,
  getExchange: () => Exchange,
  getAdapter?: () => Promise<ExchangeAdapter>,
) {
  const stream = program.command("stream").description("Live WebSocket streams (Ctrl+C to stop)");

  stream
    .command("prices")
    .description("Stream live prices")
    .action(async () => {
      const ws = new PacificaWSClient({ network: getNetwork() });
      await ws.connect();
      ws.subscribe("prices");
      ws.on("prices", (msg: unknown) => {
        const data = msg as Record<string, unknown>;
        const d = data.data ?? data;
        if (Array.isArray(d)) {
          d.forEach((p: Record<string, unknown>) => {
            const mark = Number(p.mark ?? p.m ?? 0);
            const funding = Number(p.funding ?? p.f ?? 0);
            const sym = String(p.symbol ?? p.s ?? "").padEnd(10);
            console.log(
              `${chalk.white.bold(sym)} $${formatUsd(mark)}  ${formatPercent(funding)}`
            );
          });
        }
      });
      console.log(chalk.cyan("Streaming prices... (Ctrl+C to stop)\n"));
      await new Promise(() => {}); // keep alive
    });

  stream
    .command("book <symbol>")
    .description("Stream orderbook updates")
    .action(async (symbol: string) => {
      const ws = new PacificaWSClient({ network: getNetwork() });
      await ws.connect();
      ws.subscribe("book", { symbol: symbol.toUpperCase() });
      ws.on("book", (msg: unknown) => {
        const data = msg as Record<string, unknown>;
        console.log(
          `${chalk.cyan(new Date().toLocaleTimeString())} ${JSON.stringify(data.data ?? data)}`
        );
      });
      console.log(chalk.cyan(`Streaming ${symbol.toUpperCase()} orderbook... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  stream
    .command("trades <symbol>")
    .description("Stream live trades")
    .action(async (symbol: string) => {
      const ws = new PacificaWSClient({ network: getNetwork() });
      await ws.connect();
      ws.subscribe("trades", { symbol: symbol.toUpperCase() });
      ws.on("trades", (msg: unknown) => {
        const data = msg as Record<string, unknown>;
        const d = (data.data ?? data) as Record<string, unknown>;
        const side = String(d.side ?? d.d ?? "");
        const price = String(d.price ?? d.p ?? "");
        const amount = String(d.amount ?? d.a ?? "");
        const color = side === "bid" || side === "buy" ? chalk.green : chalk.red;
        console.log(
          `${chalk.gray(new Date().toLocaleTimeString())} ${color(side === "bid" ? "BUY " : "SELL")} $${formatUsd(price)} x ${amount}`
        );
      });
      console.log(chalk.cyan(`Streaming ${symbol.toUpperCase()} trades... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  stream
    .command("bbo <symbol>")
    .description("Stream best bid/offer")
    .action(async (symbol: string) => {
      const ws = new PacificaWSClient({ network: getNetwork() });
      await ws.connect();
      ws.subscribe("bbo", { symbol: symbol.toUpperCase() });
      ws.on("bbo", (msg: unknown) => {
        const data = (msg as Record<string, unknown>).data ?? msg;
        console.log(
          `${chalk.gray(new Date().toLocaleTimeString())} ${JSON.stringify(data)}`
        );
      });
      console.log(chalk.cyan(`Streaming ${symbol.toUpperCase()} BBO... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  stream
    .command("candle <symbol> <interval>")
    .description("Stream candlestick data")
    .action(async (symbol: string, interval: string) => {
      const ws = new PacificaWSClient({ network: getNetwork() });
      await ws.connect();
      ws.subscribe("candle", { symbol: symbol.toUpperCase(), interval });
      ws.on("candle", (msg: unknown) => {
        const data = (msg as Record<string, unknown>).data ?? msg;
        const d = data as Record<string, unknown>;
        console.log(
          `${chalk.gray(new Date().toLocaleTimeString())} O:$${formatUsd(String(d.o ?? ""))} H:$${formatUsd(String(d.h ?? ""))} L:$${formatUsd(String(d.l ?? ""))} C:$${formatUsd(String(d.c ?? ""))} V:${d.v ?? ""}`
        );
      });
      console.log(chalk.cyan(`Streaming ${symbol.toUpperCase()} ${interval} candles... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  // ── stream events ── (unified account events as NDJSON)
  if (getAdapter) {
    stream
      .command("events")
      .description("Stream account events as NDJSON (positions, orders, balance, liquidation warnings)")
      .option("--interval <ms>", "Polling interval in milliseconds", "5000")
      .option("--liq-warn <pct>", "Liquidation warning distance %", "10")
      .option("--log-positions", "Log position lifecycle events to ~/.perp/positions.jsonl")
      .action(async (opts: { interval: string; liqWarn: string; logPositions?: boolean }) => {
        const adapter = await getAdapter();
        const { startEventStream } = await import("../event-stream.js");

        console.error(chalk.cyan(`Streaming ${adapter.name} events... (Ctrl+C to stop)\n`));
        if (opts.logPositions) {
          console.error(chalk.gray("  Position logging enabled → ~/.perp/positions.jsonl\n"));
        }

        const controller = new AbortController();
        process.on("SIGINT", () => controller.abort());

        let onEvent = (event: import("../event-stream.js").StreamEvent) => {
          // NDJSON: one JSON per line to stdout
          process.stdout.write(JSON.stringify(event) + "\n");
        };

        if (opts.logPositions) {
          const { attachPositionLogger } = await import("../position-history.js");
          onEvent = attachPositionLogger(onEvent);
        }

        await startEventStream(adapter, {
          intervalMs: parseInt(opts.interval),
          liquidationWarningPct: parseFloat(opts.liqWarn),
          onEvent,
          signal: controller.signal,
        });
      });
  }
}
