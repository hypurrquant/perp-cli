import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { makeTable, formatUsd, formatPercent, printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import chalk from "chalk";
import { hasPacificaSdk, isDexCapable } from "../exchanges/capabilities.js";

const EXCHANGES = ["pacifica", "hyperliquid", "lighter"] as const;

export function registerMarketCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
) {
  const market = program.command("market").description("Market data commands");

  market
    .command("list")
    .description("List all available markets")
    .option("--hip3", "Include HIP-3 dex markets (Hyperliquid)")
    .action(async (opts: { hip3?: boolean }) => {
      const explicitExchange = program.getOptionValueSource?.("exchange") === "cli";

      const HEADERS = ["Symbol", "Mark", "Index", "Funding", "24h Vol", "OI", "Max Lev"];
      const marketRow = (m: { symbol: string; markPrice: string; indexPrice: string; fundingRate: string; volume24h: string; openInterest: string; maxLeverage: number }) => [
        chalk.white.bold(m.symbol),
        `$${formatUsd(m.markPrice)}`,
        `$${formatUsd(m.indexPrice)}`,
        formatPercent(m.fundingRate),
        `$${formatUsd(m.volume24h)}`,
        `$${formatUsd(m.openInterest)}`,
        String(m.maxLeverage) + "x",
      ];

      // Multi-exchange mode
      if (!explicitExchange && getAdapterForExchange) {
        const grouped: Record<string, { symbol: string; markPrice: string; indexPrice: string; fundingRate: string; volume24h: string; openInterest: string; maxLeverage: number }[]> = {};
        const errors: Record<string, string> = {};

        await Promise.all(EXCHANGES.map(async (ex) => {
          try {
            const adapter = await getAdapterForExchange(ex);
            grouped[ex] = await adapter.getMarkets();
            // --hip3: fetch HIP-3 dex markets
            if (opts.hip3 && ex === "hyperliquid" && isDexCapable(adapter)) {
              const dexes = await adapter.listDeployedDexes();
              await Promise.allSettled(dexes.map(async (d) => {
                const dexAdapter = Object.create(adapter) as ExchangeAdapter & import("../exchanges/capabilities.js").DexCapable;
                dexAdapter.setDex(d.name);
                const markets = await dexAdapter.getMarkets();
                if (markets.length > 0) grouped[`hip3:${d.name}`] = markets;
              }));
            }
          } catch (err) {
            errors[ex] = err instanceof Error ? err.message : String(err);
          }
        }));

        if (isJson()) {
          return printJson(jsonOk({ exchanges: grouped, errors: Object.keys(errors).length > 0 ? errors : undefined }));
        }

        // Per-exchange tables
        for (const [ex, markets] of Object.entries(grouped)) {
          if (markets.length === 0) continue;
          const isHip3 = ex.startsWith("hip3:");
          const label = isHip3 ? chalk.magenta.bold(`  HIP-3: ${ex.slice(5)}`) : chalk.cyan.bold(`  ${ex.toUpperCase()}`);
          console.log(`\n${label} ${chalk.gray(`(${markets.length} markets)`)}`);
          console.log(makeTable(HEADERS, markets.map(marketRow)));
        }
        for (const [ex, msg] of Object.entries(errors)) {
          console.log(chalk.gray(`  ${ex}: ${msg}`));
        }
        return;
      }

      // Single exchange mode
      const adapter = await getAdapter();
      const markets = await adapter.getMarkets();

      // --hip3: fetch HIP-3 dex markets
      const hip3: Record<string, typeof markets> = {};
      if (opts.hip3 && isDexCapable(adapter)) {
        const dexes = await adapter.listDeployedDexes();
        await Promise.allSettled(dexes.map(async (d) => {
          const dexAdapter = Object.create(adapter) as ExchangeAdapter & import("../exchanges/capabilities.js").DexCapable;
          dexAdapter.setDex(d.name);
          const m = await dexAdapter.getMarkets();
          if (m.length > 0) hip3[d.name] = m;
        }));
      }

      if (isJson()) {
        if (Object.keys(hip3).length > 0) {
          return printJson(jsonOk({ main: markets, hip3 }));
        }
        return printJson(jsonOk(markets));
      }

      console.log(makeTable(HEADERS, markets.map(marketRow)));

      for (const [dex, m] of Object.entries(hip3)) {
        console.log(chalk.magenta.bold(`\n  HIP-3: ${dex}`) + chalk.gray(` (${m.length} markets)`));
        console.log(makeTable(HEADERS, m.map(marketRow)));
      }
    });

  market
    .command("prices")
    .description("Get current prices for all markets")
    .action(async () => {
      const explicitExchange = program.getOptionValueSource?.("exchange") === "cli";
      const PRICE_HEADERS = ["Symbol", "Mark", "Index", "Funding"];
      const priceRow = (m: { symbol: string; markPrice: string; indexPrice: string; fundingRate: string }) => [
        chalk.white.bold(m.symbol),
        `$${formatUsd(m.markPrice)}`,
        `$${formatUsd(m.indexPrice)}`,
        formatPercent(m.fundingRate),
      ];

      if (!explicitExchange && getAdapterForExchange) {
        const grouped: Record<string, { symbol: string; markPrice: string; indexPrice: string; fundingRate: string }[]> = {};
        const errors: Record<string, string> = {};

        await Promise.all(EXCHANGES.map(async (ex) => {
          try {
            const adapter = await getAdapterForExchange(ex);
            grouped[ex] = await adapter.getMarkets();
          } catch (err) {
            errors[ex] = err instanceof Error ? err.message : String(err);
          }
        }));

        if (isJson()) {
          return printJson(jsonOk({ exchanges: grouped, errors: Object.keys(errors).length > 0 ? errors : undefined }));
        }

        for (const [ex, markets] of Object.entries(grouped)) {
          if (markets.length === 0) continue;
          console.log(chalk.cyan.bold(`\n  ${ex.toUpperCase()}`) + chalk.gray(` (${markets.length} markets)`));
          console.log(makeTable(PRICE_HEADERS, markets.map(priceRow)));
        }
        for (const [ex, msg] of Object.entries(errors)) console.log(chalk.gray(`  ${ex}: ${msg}`));
        return;
      }

      const adapter = await getAdapter();

      if (hasPacificaSdk(adapter)) {
        const sdk = adapter.sdk as Record<string, (...args: any[]) => any>;
        const prices = await sdk.getPrices();
        if (isJson()) return printJson(jsonOk(prices));
        const rows = (prices as { symbol: string; mark: string; mid: string; oracle: string; funding: string }[]).map((p) => [
          chalk.white.bold(p.symbol),
          `$${formatUsd(p.mark)}`,
          `$${formatUsd(p.mid)}`,
          `$${formatUsd(p.oracle)}`,
          formatPercent(p.funding),
        ]);
        console.log(makeTable(["Symbol", "Mark", "Mid", "Oracle", "Funding"], rows));
      } else {
        const markets = await adapter.getMarkets();
        if (isJson()) return printJson(jsonOk(markets));
        console.log(makeTable(PRICE_HEADERS, markets.map(priceRow)));
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
        (mk) => {
          const s = mk.symbol.toUpperCase();
          return s === sym || s === `${sym}-PERP` || s.replace(/-PERP$/, "") === sym
            || s.split(":").pop() === sym; // HIP-3: "km:US500" matches "US500"
        }
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

      // Compute spread
      const bestBid = bids[0] ? Number(bids[0][0]) : 0;
      const bestAsk = asks[asks.length - 1] ? Number(asks[asks.length - 1][0]) : 0;
      const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
      const spreadAbs = bestBid && bestAsk ? bestAsk - bestBid : 0;
      const spreadPct = midPrice > 0 ? (spreadAbs / midPrice) * 100 : 0;

      // Compute cumulative sizes + max for bar scaling
      let askCum = 0;
      const askCums = asks.map(([, a]) => { askCum += Number(a); return askCum; });
      let bidCum = 0;
      const bidCums = bids.map(([, a]) => { bidCum += Number(a); return bidCum; });
      const maxCum = Math.max(askCums[askCums.length - 1] || 0, bidCums[bidCums.length - 1] || 0);
      const BAR_WIDTH = 20;
      const bar = (cum: number) => {
        const len = maxCum > 0 ? Math.round((cum / maxCum) * BAR_WIDTH) : 0;
        return "█".repeat(len);
      };

      console.log(chalk.cyan.bold(`\n  Orderbook: ${symbol.toUpperCase()} (${adapter.name})\n`));
      console.log(chalk.gray("  Price          Size          Cum$              Depth"));
      console.log(chalk.gray("  " + "─".repeat(60)));
      asks.forEach(([p, a], i) => {
        const cumUsd = askCums[i] * (Number(p));
        console.log(
          chalk.red(`  ${formatUsd(p).padStart(12)}  ${String(a).padEnd(12)}  $${formatUsd(cumUsd).padEnd(14)}`) +
          chalk.red.dim(bar(askCums[i]))
        );
      });
      // Spread line
      const spreadStr = spreadAbs > 0
        ? `$${formatUsd(spreadAbs)} (${spreadPct.toFixed(3)}%)`
        : "─";
      console.log(chalk.gray(`  ${"─".repeat(16)} spread: ${spreadStr} ${"─".repeat(10)}`));
      bids.forEach(([p, a], i) => {
        const cumUsd = bidCums[i] * (Number(p));
        console.log(
          chalk.green(`  ${formatUsd(p).padStart(12)}  ${String(a).padEnd(12)}  $${formatUsd(cumUsd).padEnd(14)}`) +
          chalk.green.dim(bar(bidCums[i]))
        );
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

  // ── market hip3 ── (HIP-3 deployed perp dexes on Hyperliquid)
  market
    .command("hip3")
    .description("List HIP-3 deployed perp dexes (Hyperliquid only)")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        if (!(isDexCapable(adapter))) {
          if (isJson()) return printJson(jsonError("INVALID_EXCHANGE", "HIP-3 dexes are only available on Hyperliquid. Use -e hyperliquid."));
          console.error(chalk.red("\n  HIP-3 dexes are only available on Hyperliquid. Use -e hyperliquid.\n"));
          return;
        }

        const dexes = await adapter.listDeployedDexes();
        if (isJson()) return printJson(jsonOk(dexes));

        if (dexes.length === 0) {
          console.log(chalk.gray("\n  No deployed dexes found.\n"));
          return;
        }

        console.log(chalk.cyan.bold("\n  HIP-3 Deployed Perp DEXes\n"));
        const rows = dexes.map(d => [
          chalk.white.bold(d.name),
          chalk.gray(d.deployer.slice(0, 10) + "..."),
          String(d.assets.length),
          d.assets.slice(0, 5).join(", ") + (d.assets.length > 5 ? ` +${d.assets.length - 5}` : ""),
        ]);
        console.log(makeTable(["DEX", "Deployer", "Assets", "Markets"], rows));
        console.log(chalk.gray(`\n  Use --dex <name> to trade on a deployed dex.`));
        console.log(chalk.gray(`  Example: perp -e hl --dex xyz market list\n`));
      });
    });
}
