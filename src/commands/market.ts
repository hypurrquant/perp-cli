import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { tapeSkippedOf, type CurrentFundingTerms, type ExchangeMarketInfo, type RfqQuotes } from "../exchanges/interface.js";
import { makeTable, formatUsd, formatPercent, printJson, jsonOk, jsonError, withJsonErrors, normalizeSymbolArg } from "../utils.js";
import chalk from "chalk";
import { PerpError } from "../errors.js";
import { midDecimal } from "../exchanges/precision.js";
import { isDexCapable, klinesNeedAuth } from "../exchanges/capabilities.js";
import { getVenue, listVenuesWithRole, tryResolveVenueId, unofficialApiNote } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";

/** Venues with an adapter (market-data-only venues have none — see `perp arb scan`). */
const EXCHANGES = listVenuesWithRole("account").map(v => v.id);

/** null = venue does not publish the value → "-" (never rendered as $0). */
const usdOrDash = (v: string | null): string => (v === null ? chalk.gray("-") : `$${formatUsd(v)}`);

/**
 * Funding cell. On a venue whose funding interval is per market (VenueDefinition.fundingRateBasis
 * "perMarket": Variational, Aster, GRVT) the raw rate is labelled with its interval ("+0.0079%/8h"), since
 * the rows of one table cover different periods.
 */
function fundingCell(m: { fundingRate: string | null; fundingHours?: number | null }, perMarket: boolean): string {
  if (m.fundingRate == null) return chalk.gray("N/A");
  const hours = perMarket ? m.fundingHours ?? null : null;
  return hours === null ? formatPercent(m.fundingRate) : `${formatPercent(m.fundingRate)}${chalk.gray(`/${hours}h`)}`;
}

/** True when `venueName` is a registered venue whose funding interval is per market. */
function perMarketFunding(venueName: string): boolean {
  const id = tryResolveVenueId(venueName);
  return id !== null && getVenue(id).fundingRateBasis === "perMarket";
}

/** Base asset of a market symbol: "BTC-PERP" → "BTC", "xyz:XYZ100" → "XYZ100". */
const baseAssetOf = (symbol: string): string => (symbol.split(":").pop() as string).replace(/-PERP$/i, "");

/**
 * Open interest is published in BASE-asset units by every venue (ExchangeMarketInfo.openInterest),
 * so it is shown as "<n> <BASE>" — never with a "$". `withUsd` adds the notional at the mark
 * price, labelled as such; null (not published) → "-".
 */
function formatOpenInterest(m: { symbol: string; markPrice: string; openInterest: string | null }, withUsd: boolean): string {
  if (m.openInterest === null) return chalk.gray("-");
  const oi = Number(m.openInterest);
  const base = `${Number.isFinite(oi) ? oi.toLocaleString("en-US", { maximumFractionDigits: 4 }) : m.openInterest} ${baseAssetOf(m.symbol)}`;
  const mark = Number(m.markPrice);
  if (!withUsd || !Number.isFinite(oi) || !(mark > 0)) return base;
  return `${base} ${chalk.gray(`(≈ $${formatUsd(oi * mark)} at mark)`)}`;
}

function printRfqQuotes(q: RfqQuotes, json: boolean): void {
  if (json) return printJson(jsonOk(q));
  console.log(chalk.cyan.bold(`\n  RFQ quotes: ${q.ticker} (${q.venue}) — not an order book\n`));
  console.log(`  Mark: $${formatUsd(q.markPrice)}   Base spread: ${q.baseSpreadBps === null ? chalk.gray("-") : `${Number(q.baseSpreadBps).toFixed(2)} bps`}   Quoted at: ${q.updatedAt ?? chalk.gray("-")}`);
  if (q.quotes.length === 0) {
    console.log(chalk.gray("\n  No quotes published right now (the market may be closed).\n"));
  } else {
    console.log(makeTable(["Size", "Bid", "Ask", "Spread"], q.quotes.map(t => {
      const bid = Number(t.bid);
      const ask = Number(t.ask);
      const mid = (bid + ask) / 2;
      return [
        t.notionalUsd === null ? "min order" : `$${formatUsd(t.notionalUsd)}`,
        chalk.green(`$${formatUsd(t.bid)}`),
        chalk.red(`$${formatUsd(t.ask)}`),
        mid > 0 ? `${((ask - bid) / mid * 10_000).toFixed(2)} bps` : chalk.gray("-"),
      ];
    })));
  }
  console.log(chalk.gray(`  ${q.note}\n`));
}

function printFundingTerms(t: CurrentFundingTerms, json: boolean): void {
  if (json) return printJson(jsonOk(t));
  console.log(chalk.cyan.bold(`\n  Funding: ${t.ticker} (${t.venue}) — current terms, no history published\n`));
  if (t.swap !== null) {
    const row = (label: string, r: NonNullable<typeof t.swap>["last"]) => r === null
      ? [label, chalk.gray("-"), chalk.gray("-"), chalk.gray("-"), chalk.gray("-")]
      : [label, formatPercent(r.intervalLong), formatPercent(r.intervalShort), formatPercent(r.annualizedLong), formatPercent(r.annualizedShort)];
    console.log(makeTable(["Payment", "Long / day", "Short / day", "Long APR", "Short APR"], [row("last applied", t.swap.last), row("next", t.swap.next)]));
  } else {
    console.log(`  Rate kind:      ${t.rateKind ?? chalk.gray("-")}`);
    console.log(`  Interval:       ${t.intervalHours === null ? chalk.gray("-") : `${t.intervalHours}h`}`);
    console.log(`  Per interval:   ${t.intervalRate === null ? chalk.gray("N/A") : formatPercent(t.intervalRate)}`);
    console.log(`  Hourly:         ${t.hourlyRate === null ? chalk.gray("N/A") : formatPercent(t.hourlyRate)}`);
    console.log(`  APR:            ${t.annualizedPct === null ? chalk.gray("N/A") : `${t.annualizedPct.toFixed(2)}%`}`);
  }
  console.log(`  Next funding:   ${t.nextFundingTime === null ? chalk.gray("-") : new Date(t.nextFundingTime).toLocaleString()}`);
  console.log(chalk.gray(`  ${t.note}\n`));
}

export function registerMarketCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
  /** Credentialed adapter of the selected venue — for market data the venue serves only to an authenticated account. */
  getAccountAdapter?: () => Promise<ExchangeAdapter>,
) {
  const market = program.command("market").description("Market data commands");
  // Human output for a venue read through an UNOFFICIAL API carries a footnote (JSON rows carry venueApi).
  market.hook("postAction", () => {
    if (isJson()) return;
    const raw = program.opts().exchange as string | undefined;
    const id = raw === undefined ? null : tryResolveVenueId(raw);
    if (id === null) return;
    const note = unofficialApiNote(getVenue(id));
    if (note !== null) console.log(chalk.yellow(`  * ${note}\n`));
  });

  market
    .command("list")
    .description("List all available markets")
    .option("--hip3", "Include HIP-3 dex markets (Hyperliquid)")
    .action(async (opts: { hip3?: boolean }) => {
      const explicitExchange = program.getOptionValueSource?.("exchange") === "cli";

      const HEADERS = ["Symbol", "Mark", "Index", "Funding", "24h Vol", "OI (base)", "Max Lev"];
      const marketRow = (m: { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null; fundingHours?: number | null; volume24h: string | null; openInterest: string | null; maxLeverage: number | null }, perMarket = false) => [
        chalk.white.bold(m.symbol),
        `$${formatUsd(m.markPrice)}`,
        usdOrDash(m.indexPrice),
        fundingCell(m, perMarket),
        usdOrDash(m.volume24h),
        formatOpenInterest(m, false),
        m.maxLeverage === null ? chalk.gray("-") : String(m.maxLeverage) + "x",
      ];

      // Multi-exchange mode
      if (!explicitExchange && getAdapterForExchange) {
        const grouped: Record<string, { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null; volume24h: string | null; openInterest: string | null; maxLeverage: number | null }[]> = {};
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
          console.log(makeTable(HEADERS, markets.map(m => marketRow(m))));
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

      const perMarket = perMarketFunding(adapter.name);
      // Rows that carry an asset class (Extended: crypto / equity / etf / index / commodity / fx / preIpo) show it.
      const classOf = (m: object): string | null => {
        const c = (m as { assetClass?: unknown }).assetClass;
        return typeof c === "string" ? c : null;
      };
      if (markets.length > 0 && markets.every(m => classOf(m) !== null)) {
        console.log(makeTable([...HEADERS, "Class"], markets.map(m => [...marketRow(m, perMarket), classOf(m) as string])));
      } else {
        console.log(makeTable(HEADERS, markets.map(m => marketRow(m, perMarket))));
      }

      for (const [dex, m] of Object.entries(hip3)) {
        console.log(chalk.magenta.bold(`\n  HIP-3: ${dex}`) + chalk.gray(` (${m.length} markets)`));
        console.log(makeTable(HEADERS, m.map(x => marketRow(x))));
      }
    });

  market
    .command("prices")
    .description("Get current prices for all markets")
    .action(async () => {
      const explicitExchange = program.getOptionValueSource?.("exchange") === "cli";
      const PRICE_HEADERS = ["Symbol", "Mark", "Index", "Funding"];
      const priceRow = (m: { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null; fundingHours?: number | null }, perMarket = false) => [
        chalk.white.bold(m.symbol),
        `$${formatUsd(m.markPrice)}`,
        usdOrDash(m.indexPrice),
        fundingCell(m, perMarket),
      ];

      if (!explicitExchange && getAdapterForExchange) {
        const grouped: Record<string, { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null }[]> = {};
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
          console.log(makeTable(PRICE_HEADERS, markets.map(m => priceRow(m))));
        }
        for (const [ex, msg] of Object.entries(errors)) console.log(chalk.gray(`  ${ex}: ${msg}`));
        return;
      }

      const adapter = await getAdapter();
      // One normalized shape on every venue (Pacifica included — it printed the raw /info/prices rows).
      const markets = await adapter.getMarkets();
      if (isJson()) return printJson(jsonOk(markets));
      console.log(makeTable(PRICE_HEADERS, markets.map(m => priceRow(m, perMarketFunding(adapter.name)))));
    });

  market
    .command("info <symbol>")
    .description("Detailed info for a single market")
    .action(async (symbol: string) => {
      const adapter = await getAdapter();
      // A venue that serves one market directly (GRVT: one ticker + one margin-rules read instead
      // of the whole fan-out) answers here; SYMBOL_NOT_FOUND comes from its own directory.
      const single = (adapter as { getMarketInfo?: (s: string) => Promise<ExchangeMarketInfo> }).getMarketInfo;
      if (typeof single === "function") {
        return void await withJsonErrors(isJson(), async () => {
          const one = await single.call(adapter, symbol);
          if (isJson()) return printJson(jsonOk(one));
          printMarketInfo(adapter.name, one);
        });
      }
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
        // Printed (envelope / Error + Remediation) and exit 1 via withJsonErrors.
        return void await withJsonErrors(isJson(), async () => {
          const delisted = typeof (adapter as { delistedMessage?: unknown }).delistedMessage === "function"
            ? (adapter as unknown as { delistedMessage(s: string): string | null }).delistedMessage(symbol)
            : null;
          throw new PerpError("SYMBOL_NOT_FOUND", delisted ?? `Market ${normalizeSymbolArg(symbol)} not found on ${adapter.name}`, {
            exchange: adapter.name,
            remediation: `List markets: perp -e ${adapter.name} market list`,
          });
        });
      }
      if (isJson()) return printJson(jsonOk(m));
      printMarketInfo(adapter.name, m);
    });

  market
    .command("book <symbol>")
    .description("Show orderbook for a symbol")
    .option("-d, --depth <n>", "Number of levels", "10")
    .action(async (symbol: string, opts: { depth: string }) => {
      const adapter = await getAdapter();
      const sym = normalizeSymbolArg(symbol);
      // RFQ venue (Variational): no order book — the maker's indicative quotes, labelled as such.
      if (adapter.getRfqQuotes !== undefined) return printRfqQuotes(await adapter.getRfqQuotes(sym), isJson());
      const book = await adapter.getOrderbook(sym);
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

      console.log(chalk.cyan.bold(`\n  Orderbook: ${sym} (${adapter.name})\n`));
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
    .option("--limit <n>", "Number of recent trades to show", "20")
    .action(async (symbol: string, opts: { limit: string }) => {
      const adapter = await getAdapter();
      const trades = await adapter.getRecentTrades(normalizeSymbolArg(symbol), parseInt(opts.limit));
      const skipped = tapeSkippedOf(trades);
      if (isJson()) return printJson(jsonOk(trades, skipped !== null ? { skippedRows: skipped } : undefined));
      if (skipped !== null) console.log(chalk.yellow(`  ${skipped.count} tape row(s) skipped: ${skipped.reason}`));
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
      // A venue without a funding-history API (Variational): its current funding terms, labelled as such.
      if (adapter.getFundingTerms !== undefined) return printFundingTerms(await adapter.getFundingTerms(normalizeSymbolArg(symbol)), isJson());
      const history = await adapter.getFundingHistory(normalizeSymbolArg(symbol), parseInt(opts.limit));
      if (isJson()) return printJson(jsonOk(history));
      if (history.length === 0) {
        console.log(chalk.gray("\n  No funding history.\n"));
        return;
      }
      const hasOracle = history.some((h) => h.price != null && h.price !== "0" && h.price !== "");
      const rows = history.map((h) => {
        const base = [
          new Date(h.time).toLocaleString(),
          formatPercent(h.rate),
        ];
        if (hasOracle) base.push(h.price != null ? `$${formatUsd(h.price)}` : chalk.gray("n/a"));
        return base;
      });
      const headers = hasOracle ? ["Time", "Funding Rate", "Oracle"] : ["Time", "Funding Rate"];
      console.log(makeTable(headers, rows));
      if (!hasOracle) console.log(chalk.gray("  Note: Oracle price not available for this exchange.\n"));
    });

  market
    .command("mid <symbol>")
    .description("Get mid price for a single symbol (fast)")
    .action(async (symbol: string) => {
      const sym = normalizeSymbolArg(symbol);
      // withJsonErrors: every failure (incl. an empty book) is an error envelope AND exit code 1.
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();

        // Orderbook mid (best bid + best ask) / 2
        const book = await adapter.getOrderbook(sym);
        const bestBid = book.bids[0]?.[0];
        const bestAsk = book.asks[0]?.[0];

        if (!bestBid && !bestAsk) {
          // The market exists (getOrderbook resolved it) but nobody quotes it: no price, not "unknown symbol".
          throw new PerpError("PRICE_STALE", `${sym} orderbook on ${adapter.name} is empty (no bids and no asks) — no mid price`, {
            exchange: adapter.name,
            remediation: `The market has no liquidity right now; check: perp -e ${adapter.name} market book ${sym}, or pick a market with a two-sided book`,
          });
        }

        const bid = Number(bestBid ?? 0);
        const ask = Number(bestAsk ?? 0);
        const mid = bid && ask ? (bid + ask) / 2 : bid || ask;
        const spread = bid && ask ? ((ask - bid) / mid * 100) : 0;

        if (isJson()) return printJson(jsonOk({
          symbol: sym,
          // Exact decimal mid of the two quoted strings (float (bid + ask) / 2 prints artifacts).
          mid: bestBid && bestAsk ? midDecimal(bestBid, bestAsk) : mid.toString(),
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
      });
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
        const publicAdapter = await getAdapter();
        // A venue whose candles endpoint is authenticated (Ondo) is read with the registered key.
        const adapter = getAccountAdapter !== undefined && klinesNeedAuth(publicAdapter) ? await getAccountAdapter() : publicAdapter;
        const now = Date.now();
        const startTime = opts.start ? parseInt(opts.start) : now - 24 * 60 * 60 * 1000;
        const endTime = opts.end ? parseInt(opts.end) : now;

        const klines = await adapter.getKlines(normalizeSymbolArg(symbol), interval, startTime, endTime);
        if (isJson()) return printJson(jsonOk(klines));
        if (klines.length === 0) {
          console.log(chalk.gray("\n  No kline data.\n"));
          return;
        }
        // ISO (UTC) candle open times — one format for every venue, independent of the host locale.
        const rows = klines.slice(-20).map((k) => [
          new Date(k.time).toISOString(),
          `$${formatUsd(k.open)}`,
          `$${formatUsd(k.high)}`,
          `$${formatUsd(k.low)}`,
          `$${formatUsd(k.close)}`,
          k.volume === null ? chalk.gray("-") : k.volume,
          k.trades === null ? chalk.gray("-") : String(k.trades),
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
          if (isJson()) return printJson(jsonError("INVALID_PARAMS", "HIP-3 dexes are only available on Hyperliquid.", { remediation: "Re-run with -e hyperliquid." }));
          console.error(chalk.red("\n  HIP-3 dexes are only available on Hyperliquid. Use -e hyperliquid.\n"));
          process.exitCode = 1;
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
          chalk.gray(d.deployer ? d.deployer.slice(0, 6) + "..." + d.deployer.slice(-4) : "-"),
          String(d.assets.length),
          d.assets.slice(0, 5).join(", ") + (d.assets.length > 5 ? ` +${d.assets.length - 5}` : ""),
        ]);
        console.log(makeTable(["DEX", "Deployer", "Assets", "Markets"], rows));
        console.log(chalk.gray(`\n  Use --dex <name> to trade on a deployed dex.`));
        console.log(chalk.gray(`  Example: perp -e hl --dex xyz market list\n`));
      });
    });
}

function printMarketInfo(venue: string, m: ExchangeMarketInfo): void {
  console.log(chalk.cyan.bold(`\n  ${m.symbol} on ${venue}\n`));
  console.log(`  Mark Price:     $${formatUsd(m.markPrice)}`);
  console.log(`  Index Price:    ${usdOrDash(m.indexPrice)}`);
  // Per-market funding interval (GRVT 4h / 8h, Variational, Aster): the rate carries its interval.
  console.log(`  Funding Rate:   ${fundingCell(m, perMarketFunding(venue))}`);
  console.log(`  24h Volume:     ${usdOrDash(m.volume24h)}`);
  console.log(`  Open Interest:  ${formatOpenInterest(m, true)}`);
  console.log(`  Max Leverage:   ${m.maxLeverage === null ? chalk.gray("-") : `${m.maxLeverage}x`}`);
  console.log();
}
