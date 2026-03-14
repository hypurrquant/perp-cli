import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { makeTable, formatUsd, formatPercent, printJson, jsonOk, jsonError } from "../utils.js";
import chalk from "chalk";

export function registerMarketCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean
) {
  const market = program.command("market").description("Market data commands");

  market
    .command("list")
    .description("List all available markets")
    .action(async () => {
      const adapter = await getAdapter();
      const markets = await adapter.getMarkets();
      if (isJson()) return printJson(jsonOk(markets));

      const rows = markets.map((m) => [
        chalk.white.bold(m.symbol),
        `$${formatUsd(m.markPrice)}`,
        `$${formatUsd(m.indexPrice)}`,
        formatPercent(m.fundingRate),
        `$${formatUsd(m.volume24h)}`,
        `$${formatUsd(m.openInterest)}`,
        String(m.maxLeverage) + "x",
      ]);
      console.log(
        makeTable(
          ["Symbol", "Mark", "Index", "Funding", "24h Vol", "OI", "Max Lev"],
          rows
        )
      );
    });

  market
    .command("prices")
    .description("Get current prices for all markets")
    .action(async () => {
      const adapter = await getAdapter();

      if (adapter instanceof PacificaAdapter) {
        const prices = await adapter.sdk.getPrices();
        if (isJson()) return printJson(jsonOk(prices));
        const rows = prices.map((p) => [
          chalk.white.bold(p.symbol),
          `$${formatUsd(p.mark)}`,
          `$${formatUsd(p.mid)}`,
          `$${formatUsd(p.oracle)}`,
          formatPercent(p.funding),
        ]);
        console.log(makeTable(["Symbol", "Mark", "Mid", "Oracle", "Funding"], rows));
      } else {
        // Generic: use getMarkets as price source
        const markets = await adapter.getMarkets();
        if (isJson()) return printJson(jsonOk(markets));
        const rows = markets.map((m) => [
          chalk.white.bold(m.symbol),
          `$${formatUsd(m.markPrice)}`,
          `$${formatUsd(m.indexPrice)}`,
          formatPercent(m.fundingRate),
        ]);
        console.log(makeTable(["Symbol", "Mark", "Index", "Funding"], rows));
      }
    });

  market
    .command("info <symbol>")
    .description("Detailed info for a single market")
    .action(async (symbol: string) => {
      const adapter = await getAdapter();
      const markets = await adapter.getMarkets();
      const sym = symbol.toUpperCase();
      const m = markets.find(
        (mk) => mk.symbol === sym || mk.symbol === `${sym}-PERP` || mk.symbol.replace(/-PERP$/, "") === sym
      );
      if (!m) {
        if (isJson()) return printJson(jsonError("SYMBOL_NOT_FOUND", `Market ${sym} not found`));
        console.log(chalk.red(`\n  Market "${sym}" not found.\n`));
        return;
      }
      if (isJson()) return printJson(jsonOk(m));

      console.log(chalk.cyan.bold(`\n  ${m.symbol} on ${adapter.name}\n`));
      console.log(`  Mark Price:     $${formatUsd(m.markPrice)}`);
      console.log(`  Index Price:    $${formatUsd(m.indexPrice)}`);
      console.log(`  Funding Rate:   ${formatPercent(m.fundingRate)}`);
      console.log(`  24h Volume:     $${formatUsd(m.volume24h)}`);
      console.log(`  Open Interest:  $${formatUsd(m.openInterest)}`);
      console.log(`  Max Leverage:   ${m.maxLeverage}x`);
      console.log();
    });

  market
    .command("book <symbol>")
    .description("Show orderbook for a symbol")
    .option("-d, --depth <n>", "Number of levels", "10")
    .action(async (symbol: string, opts: { depth: string }) => {
      const adapter = await getAdapter();
      const book = await adapter.getOrderbook(symbol.toUpperCase());
      if (isJson()) return printJson(jsonOk(book));

      const depth = parseInt(opts.depth);
      const asks = book.asks.slice(0, depth).reverse();
      const bids = book.bids.slice(0, depth);

      console.log(chalk.cyan.bold(`\n  Orderbook: ${symbol.toUpperCase()} (${adapter.name})\n`));
      console.log(chalk.gray("  Price          Size"));
      console.log(chalk.gray("  ─────────────────────"));
      asks.forEach(([p, a]) => {
        console.log(chalk.red(`  ${formatUsd(p).padStart(12)}  ${a}`));
      });
      console.log(chalk.gray("  ─── spread ───"));
      bids.forEach(([p, a]) => {
        console.log(chalk.green(`  ${formatUsd(p).padStart(12)}  ${a}`));
      });
      console.log();
    });

  market
    .command("trades <symbol>")
    .description("Recent trades for a symbol")
    .action(async (symbol: string) => {
      const adapter = await getAdapter();
      const trades = await adapter.getRecentTrades(symbol.toUpperCase(), 20);
      if (isJson()) return printJson(jsonOk(trades));
      if (trades.length === 0) {
        console.log(chalk.gray("\n  No recent trades.\n"));
        return;
      }
      const rows = trades.map((t) => [
        new Date(t.time).toLocaleTimeString(),
        t.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
        `$${formatUsd(t.price)}`,
        t.size,
      ]);
      console.log(makeTable(["Time", "Side", "Price", "Size"], rows));
    });

  market
    .command("funding <symbol>")
    .description("Funding rate history")
    .option("-l, --limit <n>", "Number of records", "10")
    .action(async (symbol: string, opts: { limit: string }) => {
      const adapter = await getAdapter();
      const history = await adapter.getFundingHistory(symbol.toUpperCase(), parseInt(opts.limit));
      if (isJson()) return printJson(jsonOk(history));
      if (history.length === 0) {
        console.log(chalk.gray("\n  No funding history.\n"));
        return;
      }
      const rows = history.map((h) => [
        new Date(h.time).toLocaleString(),
        formatPercent(h.rate),
        h.price != null ? `$${formatUsd(h.price)}` : chalk.gray("n/a"),
      ]);
      console.log(makeTable(["Time", "Funding Rate", "Oracle"], rows));
    });

  market
    .command("mid <symbol>")
    .description("Get mid price for a single symbol (fast)")
    .action(async (symbol: string) => {
      const sym = symbol.toUpperCase();
      try {
        const adapter = await getAdapter();

        // Try orderbook mid (best bid + best ask) / 2
        const book = await adapter.getOrderbook(sym);
        const bestBid = book.bids[0]?.[0];
        const bestAsk = book.asks[0]?.[0];

        if (!bestBid && !bestAsk) {
          if (isJson()) return printJson(jsonError("SYMBOL_NOT_FOUND", `No orderbook data for ${sym}`));
          console.log(chalk.red(`\n  No orderbook data for ${sym}.\n`));
          return;
        }

        const bid = Number(bestBid ?? 0);
        const ask = Number(bestAsk ?? 0);
        const mid = bid && ask ? (bid + ask) / 2 : bid || ask;
        const spread = bid && ask ? ((ask - bid) / mid * 100) : 0;

        if (isJson()) return printJson(jsonOk({
          symbol: sym,
          mid: mid.toString(),
          bid: bestBid ?? null,
          ask: bestAsk ?? null,
          spread: spread.toFixed(6),
        }));

        console.log(chalk.cyan.bold(`\n  ${sym} Mid Price\n`));
        console.log(`  Mid:    $${formatUsd(mid)}`);
        if (bestBid) console.log(`  Bid:    $${formatUsd(bestBid)}`);
        if (bestAsk) console.log(`  Ask:    $${formatUsd(bestAsk)}`);
        console.log(`  Spread: ${spread.toFixed(4)}%`);
        console.log();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJson()) {
          const { classifyError } = await import("../errors.js");
          const classified = classifyError(err);
          return printJson(jsonError(classified.code, classified.message, {
            status: classified.status,
            retryable: classified.retryable,
          }));
        }
        console.error(chalk.red(`Error: ${msg}`));
      }
    });

  market
    .command("kline <symbol> <interval>")
    .description("Kline/candlestick data (intervals: 1m,5m,15m,1h,4h,1d,...)")
    .option("--start <ts>", "Start time (unix ms)")
    .option("--end <ts>", "End time (unix ms)")
    .action(
      async (
        symbol: string,
        interval: string,
        opts: { start?: string; end?: string }
      ) => {
        const adapter = await getAdapter();
        const now = Date.now();
        const startTime = opts.start ? parseInt(opts.start) : now - 24 * 60 * 60 * 1000;
        const endTime = opts.end ? parseInt(opts.end) : now;

        const klines = await adapter.getKlines(symbol.toUpperCase(), interval, startTime, endTime);
        if (isJson()) return printJson(jsonOk(klines));
        if (klines.length === 0) {
          console.log(chalk.gray("\n  No kline data.\n"));
          return;
        }
        const rows = klines.slice(-20).map((k) => [
          new Date(k.time).toLocaleString(),
          `$${formatUsd(k.open)}`,
          `$${formatUsd(k.high)}`,
          `$${formatUsd(k.low)}`,
          `$${formatUsd(k.close)}`,
          k.volume,
          String(k.trades),
        ]);
        console.log(makeTable(["Time", "Open", "High", "Low", "Close", "Volume", "Trades"], rows));
      }
    );
}
