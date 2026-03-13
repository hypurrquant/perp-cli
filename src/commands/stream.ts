import { Command } from "commander";
import { PacificaWSClient, type Network } from "../pacifica/index.js";
import chalk from "chalk";
import { formatUsd, formatPercent } from "../utils.js";

import type { Exchange } from "../config.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type {
  PriceUpdate,
  BookUpdate,
  TradeUpdate,
  CandleUpdate,
  HyperliquidMarketFeed,
  LighterMarketFeed,
} from "../ws/market-feed.js";

/** Create an HL or Lighter market feed, connected and ready. */
async function getMarketFeed(exchange: Exchange): Promise<HyperliquidMarketFeed | LighterMarketFeed> {
  const { createMarketFeed } = await import("../ws/market-feed.js");
  const feed = createMarketFeed(exchange);
  await feed.connect();
  process.on("SIGINT", () => { feed.close(); process.exit(0); });
  return feed;
}

export function registerStreamCommands(
  program: Command,
  getNetwork: () => Network,
  getExchange: () => Exchange,
  getAdapter?: () => Promise<ExchangeAdapter>,
) {
  const stream = program.command("stream").description("Live WebSocket streams (Ctrl+C to stop)");

  // ── stream prices ──
  stream
    .command("prices")
    .description("Stream live prices")
    .action(async () => {
      const exchange = getExchange();

      if (exchange === "pacifica") {
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
        console.log(chalk.cyan("Streaming pacifica prices... (Ctrl+C to stop)\n"));
      } else {
        const feed = await getMarketFeed(exchange);
        feed.subscribePrices();
        feed.on("prices", (updates: PriceUpdate[]) => {
          for (const p of updates) {
            const sym = p.symbol.padEnd(10);
            console.log(`${chalk.white.bold(sym)} $${formatUsd(p.mid)}`);
          }
        });
        console.log(chalk.cyan(`Streaming ${exchange} prices... (Ctrl+C to stop)\n`));
      }
      await new Promise(() => {}); // keep alive
    });

  // ── stream book ──
  stream
    .command("book <symbol>")
    .description("Stream orderbook updates")
    .action(async (symbol: string) => {
      const exchange = getExchange();
      const sym = symbol.toUpperCase();

      if (exchange === "pacifica") {
        const ws = new PacificaWSClient({ network: getNetwork() });
        await ws.connect();
        ws.subscribe("book", { symbol: sym });
        ws.on("book", (msg: unknown) => {
          const data = msg as Record<string, unknown>;
          console.log(
            `${chalk.cyan(new Date().toLocaleTimeString())} ${JSON.stringify(data.data ?? data)}`
          );
        });
      } else {
        const feed = await getMarketFeed(exchange);
        feed.subscribeBook(sym);
        feed.on("book", (data: BookUpdate) => {
          const topBids = data.bids.slice(0, 5).map(([p, s]) => `${p}x${s}`).join(" ");
          const topAsks = data.asks.slice(0, 5).map(([p, s]) => `${p}x${s}`).join(" ");
          console.log(
            `${chalk.cyan(new Date().toLocaleTimeString())} ${chalk.green("BID")} ${topBids}  ${chalk.red("ASK")} ${topAsks}`
          );
        });
      }
      console.log(chalk.cyan(`Streaming ${sym} orderbook on ${exchange}... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  // ── stream trades ──
  stream
    .command("trades <symbol>")
    .description("Stream live trades")
    .action(async (symbol: string) => {
      const exchange = getExchange();
      const sym = symbol.toUpperCase();

      if (exchange === "pacifica") {
        const ws = new PacificaWSClient({ network: getNetwork() });
        await ws.connect();
        ws.subscribe("trades", { symbol: sym });
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
      } else {
        const feed = await getMarketFeed(exchange);
        feed.subscribeTrades(sym);
        feed.on("trade", (t: TradeUpdate) => {
          const color = t.side === "buy" ? chalk.green : chalk.red;
          console.log(
            `${chalk.gray(new Date().toLocaleTimeString())} ${color(t.side === "buy" ? "BUY " : "SELL")} $${formatUsd(t.price)} x ${t.size}`
          );
        });
      }
      console.log(chalk.cyan(`Streaming ${sym} trades on ${exchange}... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  // ── stream bbo ──
  stream
    .command("bbo <symbol>")
    .description("Stream best bid/offer")
    .action(async (symbol: string) => {
      const exchange = getExchange();
      const sym = symbol.toUpperCase();

      if (exchange === "pacifica") {
        const ws = new PacificaWSClient({ network: getNetwork() });
        await ws.connect();
        ws.subscribe("bbo", { symbol: sym });
        ws.on("bbo", (msg: unknown) => {
          const data = (msg as Record<string, unknown>).data ?? msg;
          console.log(
            `${chalk.gray(new Date().toLocaleTimeString())} ${JSON.stringify(data)}`
          );
        });
      } else {
        // BBO derived from orderbook (HL/Lighter don't have dedicated BBO channel)
        const feed = await getMarketFeed(exchange);
        feed.subscribeBook(sym);
        feed.on("book", (data: BookUpdate) => {
          const bid = data.bids[0] ?? ["—", "—"];
          const ask = data.asks[0] ?? ["—", "—"];
          console.log(
            `${chalk.gray(new Date().toLocaleTimeString())} ${chalk.green("bid")} ${bid[0]} (${bid[1]})  ${chalk.red("ask")} ${ask[0]} (${ask[1]})`
          );
        });
      }
      console.log(chalk.cyan(`Streaming ${sym} BBO on ${exchange}... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  // ── stream candle ──
  stream
    .command("candle <symbol> <interval>")
    .description("Stream candlestick data")
    .action(async (symbol: string, interval: string) => {
      const exchange = getExchange();
      const sym = symbol.toUpperCase();

      if (exchange === "pacifica") {
        const ws = new PacificaWSClient({ network: getNetwork() });
        await ws.connect();
        ws.subscribe("candle", { symbol: sym, interval });
        ws.on("candle", (msg: unknown) => {
          const data = (msg as Record<string, unknown>).data ?? msg;
          const d = data as Record<string, unknown>;
          console.log(
            `${chalk.gray(new Date().toLocaleTimeString())} O:$${formatUsd(String(d.o ?? ""))} H:$${formatUsd(String(d.h ?? ""))} L:$${formatUsd(String(d.l ?? ""))} C:$${formatUsd(String(d.c ?? ""))} V:${d.v ?? ""}`
          );
        });
      } else {
        const feed = await getMarketFeed(exchange);
        feed.subscribeCandle(sym, interval);
        feed.on("candle", (d: CandleUpdate) => {
          console.log(
            `${chalk.gray(new Date().toLocaleTimeString())} O:$${formatUsd(d.o)} H:$${formatUsd(d.h)} L:$${formatUsd(d.l)} C:$${formatUsd(d.c)} V:${d.v}`
          );
        });
      }
      console.log(chalk.cyan(`Streaming ${sym} ${interval} candles on ${exchange}... (Ctrl+C to stop)\n`));
      await new Promise(() => {});
    });

  // ── stream events ── (unified account events as NDJSON, already exchange-agnostic)
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
