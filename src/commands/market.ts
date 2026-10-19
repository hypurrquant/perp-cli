import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { sortByTime, tapeSkippedOf, type CurrentFundingTerms, type ExchangeMarketInfo, type RfqQuotes } from "../exchanges/interface.js";
import { makeTable, formatUsd, formatPercent, printJson, jsonOk, jsonError, withJsonErrors, normalizeSymbolArg } from "../utils.js";
import chalk from "chalk";
import { PerpError } from "../errors.js";
import { midDecimal } from "../exchanges/precision.js";
import { isDexCapable, klinesNeedAuth } from "../exchanges/capabilities.js";
import { getVenue, listVenuesWithRole, tryResolveVenueId, unofficialApiNote } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";

/**
 * Venues of the multi-venue `market list|prices` (no -e): every venue with the marketData role
 * and a (public) adapter — market-data-only venues (TxFlow, Variational, GRVT, Extended) included.
 * They were left out in 0.15.0 because the list was the account-role venues.
 */
export const MARKET_DATA_VENUES = listVenuesWithRole("marketData").filter(v => v.create !== null).map(v => v.id);

/**
 * `--limit` / `-l` / `--depth`: a positive integer, the same rule on every venue (parseInt took
 * "abc" as NaN and "-5" as a negative slice). Anything else → INVALID_PARAMS before any request.
 */
export function parsePositiveIntArg(raw: string, flag: string): number {
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1 || !Number.isSafeInteger(Number(t))) {
    throw new PerpError("INVALID_PARAMS", `${flag} must be a positive integer (got "${raw}")`, { remediation: `Pass e.g. ${flag} 10` });
  }
  return Number(t);
}

/**
 * Most order-book levels per side each venue serves (measured live 2026-10-19; the request size
 * where the venue takes one): one rule for every venue — `--depth` above it is INVALID_PARAMS
 * naming the max, never clamped or silently short. Absent = the full book (Extended).
 */
export const BOOK_DEPTH_MAX: Readonly<Record<string, number>> = {
  hyperliquid: 20, pacifica: 10, lighter: 50, "lighter-rh": 50, aster: 50, arcus: 50, ondo: 50,
  qfex: 20, txflow: 20, risex: 250, grvt: 500,
};

export function assertBookDepth(venue: string, depth: number): void {
  const id = tryResolveVenueId(venue);
  const max = id === null ? undefined : BOOK_DEPTH_MAX[id];
  if (max !== undefined && depth > max) {
    throw new PerpError("INVALID_PARAMS", `--depth ${depth} exceeds ${venue}'s order book (max ${max} levels per side)`, {
      exchange: venue, remediation: `Pass --depth 1..${max}`,
    });
  }
}

/**
 * `--start` / `--end`: unix ms (digits) or an ISO-8601 date / time (`Date.parse`; "2026-10-18" is
 * UTC midnight). parseInt("2026-10-18") read 2026 ms. Non-finite → INVALID_PARAMS.
 */
export function parseTimeArg(raw: string, flag: string): number {
  const t = raw.trim();
  const ms = /^\d+$/.test(t) ? Number(t) : /^\d{4}-\d{2}-\d{2}/.test(t) ? Date.parse(t) : NaN;
  // A unix-seconds value (10 digits today) read as ms lands in 1970: refused with a hint.
  if (/^\d+$/.test(t) && ms < 1e11) {
    throw new PerpError("INVALID_PARAMS", `${flag} ${raw} looks like unix seconds; pass milliseconds or an ISO date`, {
      remediation: `Pass e.g. ${flag} ${t}000 or ${flag} 2026-10-18T00:00:00Z`,
    });
  }
  if (!Number.isFinite(ms)) {
    throw new PerpError("INVALID_PARAMS", `${flag} must be unix milliseconds or an ISO date (got "${raw}")`, {
      remediation: `Pass e.g. ${flag} 1792368000000 or ${flag} 2026-10-18T00:00:00Z`,
    });
  }
  return ms;
}

/**
 * Bare market symbol of a CLI argument as `market info` matches it against getMarkets() rows:
 * "btc-perp" → "BTC", Extended "BTC-USD" / "TSLA_24_5-USD" → "BTC" / "TSLA", TxFlow "BTC-USDC" → "BTC"
 * (book / funding resolve these through the venue; info read the raw argument and missed them).
 * HIP-3 "xyz:XYZ100" keeps its prefix.
 */
export function bareSymbolOf(arg: string): string {
  return normalizeSymbolArg(arg.trim()).replace(/-PERP$/, "").replace(/-(USD|USDC|USDT)$/, "").replace(/_24_5$/, "");
}

/**
 * History order, one rule for every venue: trades and funding history newest first, candles
 * oldest first (Aster / QFEX answered funding oldest first, GRVT trades oldest first). A stable
 * copy — the adapter's array (and its non-enumerable tape metadata) is left as is.
 */
export function newestFirst<T extends { time: number }>(rows: readonly T[]): T[] {
  return sortByTime(rows, "desc");
}

/** Human reason of a listed-but-untradable market, keyed on `status` (null when none is known). */
const NOT_TRADABLE_REASON: Readonly<Record<string, string>> = {
  nonUsdQuote: "non-USD quote — readable, not tradable through perp-cli",
  offHours: "outside the underlying's trading hours",
  reduceOnly: "reduce-only",
  halted: "trading halted",
};
export function notTradableReason(m: { tradable?: boolean; status?: string | null }): string | null {
  if (m.tradable !== false) return null;
  if (typeof m.status === "string" && m.status !== "") return NOT_TRADABLE_REASON[m.status] ?? m.status;
  return "not tradable right now";
}

/** Symbol cell; a listed market that is not tradable is marked with its reason. */
function symbolCell(m: { symbol: string; tradable?: boolean; status?: string | null }): string {
  const why = notTradableReason(m);
  return why === null ? chalk.white.bold(m.symbol) : `${chalk.white.bold(m.symbol)} ${chalk.yellow(`(${why})`)}`;
}

/** Multi-venue human output: the footnote of every listed venue read through an unofficial API. */
function printUnofficialNotes(venues: string[]): void {
  for (const ex of venues) {
    const id = tryResolveVenueId(ex);
    const note = id === null ? null : unofficialApiNote(getVenue(id));
    if (note !== null) console.log(chalk.yellow(`  * ${note}`));
  }
}

/**
 * meta.warnings for market rows whose fundingRate is null for a known reason (Lighter: the
 * settled-rate snapshot could not be read) — the reason reaches --json, not only stderr.
 */
function fundingWarnings(adapters: ExchangeAdapter[], rows: ReadonlyArray<{ fundingRate?: unknown }> | null = null): { warnings: string[] } | undefined {
  // Tied to the rows served: no warning next to rows that all carry a rate (a cached listing).
  if (rows !== null && !rows.some(r => r.fundingRate === null)) return undefined;
  const w = adapters.map(a => (a as { fundingWarning?: () => string | null }).fundingWarning?.() ?? null).filter((x): x is string => x !== null);
  return w.length > 0 ? { warnings: w } : undefined;
}

/** null = venue does not publish the value → "-" (never rendered as $0). */
const usdOrDash = (v: string | null): string => (v === null ? chalk.gray("-") : `$${formatUsd(v)}`);

/** Non-USD quote currency of a row (QFEX "SAMSUNG-KRW": quoteAsset "KRW"); null = USD or not stated. */
const nonUsdQuoteOf = (m: object): string | null => {
  const q = (m as { quoteAsset?: unknown }).quoteAsset;
  return typeof q === "string" && q !== "USD" ? q : null;
};

/** A price of row `m` in its quote currency: "$1.23" for USD, "213,500 KRW" otherwise; null → "-". */
const priceOrDash = (v: string | null, m: object): string => {
  const q = nonUsdQuoteOf(m);
  return v === null ? chalk.gray("-") : q === null ? `$${formatUsd(v)}` : `${formatUsd(v)} ${q}`;
};

/** 24h volume: USD, or (no USD figure) the venue's quote-currency notional labelled with its currency. */
const volumeCell = (m: { volume24h: string | null }): string => {
  const local = (m as { volume24hQuote?: unknown }).volume24hQuote;
  return m.volume24h === null && typeof local === "string" ? priceOrDash(local, m) : usdOrDash(m.volume24h);
};

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
  return `${base} ${chalk.gray(`(≈ ${priceOrDash(String(oi * mark), m)} at mark)`)}`;
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
      const marketRow = (m: { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null; fundingHours?: number | null; volume24h: string | null; openInterest: string | null; maxLeverage: number | null; tradable?: boolean; status?: string | null }, perMarket = false) => [
        symbolCell(m),
        priceOrDash(m.markPrice, m),
        priceOrDash(m.indexPrice, m),
        fundingCell(m, perMarket),
        volumeCell(m),
        formatOpenInterest(m, false),
        m.maxLeverage === null ? chalk.gray("-") : String(m.maxLeverage) + "x",
      ];

      // Multi-exchange mode
      if (!explicitExchange && getAdapterForExchange) {
        const grouped: Record<string, { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null; volume24h: string | null; openInterest: string | null; maxLeverage: number | null }[]> = {};
        const errors: Record<string, string> = {};
        const listed: ExchangeAdapter[] = [];

        await Promise.all(MARKET_DATA_VENUES.map(async (ex) => {
          try {
            const adapter = await getAdapterForExchange(ex);
            grouped[ex] = await adapter.getMarkets();
            listed.push(adapter);
            // --hip3: fetch HIP-3 dex markets
            if (opts.hip3 && ex === "hyperliquid" && isDexCapable(adapter)) {
              const dexes = await adapter.listDeployedDexes();
              await Promise.allSettled(dexes.map(async (d) => {
                const markets = await adapter.forDex(d.name).getMarkets();
                if (markets.length > 0) grouped[`hip3:${d.name}`] = markets;
              }));
            }
          } catch (err) {
            errors[ex] = err instanceof Error ? err.message : String(err);
          }
        }));

        if (isJson()) {
          return printJson(jsonOk({ exchanges: grouped, errors: Object.keys(errors).length > 0 ? errors : undefined }, fundingWarnings(listed, Object.values(grouped).flat())));
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
        printUnofficialNotes(Object.keys(grouped));
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
          const m = await adapter.forDex(d.name).getMarkets();
          if (m.length > 0) hip3[d.name] = m;
        }));
      }

      if (isJson()) {
        if (Object.keys(hip3).length > 0) {
          return printJson(jsonOk({ main: markets, hip3 }));
        }
        return printJson(jsonOk(markets, fundingWarnings([adapter], markets)));
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
      const priceRow = (m: { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null; fundingHours?: number | null; tradable?: boolean; status?: string | null }, perMarket = false) => [
        symbolCell(m),
        priceOrDash(m.markPrice, m),
        priceOrDash(m.indexPrice, m),
        fundingCell(m, perMarket),
      ];

      if (!explicitExchange && getAdapterForExchange) {
        const grouped: Record<string, { symbol: string; markPrice: string; indexPrice: string | null; fundingRate: string | null }[]> = {};
        const errors: Record<string, string> = {};
        const listed: ExchangeAdapter[] = [];

        await Promise.all(MARKET_DATA_VENUES.map(async (ex) => {
          try {
            const adapter = await getAdapterForExchange(ex);
            grouped[ex] = await adapter.getMarkets();
            listed.push(adapter);
          } catch (err) {
            errors[ex] = err instanceof Error ? err.message : String(err);
          }
        }));

        if (isJson()) {
          return printJson(jsonOk({ exchanges: grouped, errors: Object.keys(errors).length > 0 ? errors : undefined }, fundingWarnings(listed, Object.values(grouped).flat())));
        }

        for (const [ex, markets] of Object.entries(grouped)) {
          if (markets.length === 0) continue;
          console.log(chalk.cyan.bold(`\n  ${ex.toUpperCase()}`) + chalk.gray(` (${markets.length} markets)`));
          console.log(makeTable(PRICE_HEADERS, markets.map(m => priceRow(m))));
        }
        for (const [ex, msg] of Object.entries(errors)) console.log(chalk.gray(`  ${ex}: ${msg}`));
        printUnofficialNotes(Object.keys(grouped));
        return;
      }

      const adapter = await getAdapter();
      // One normalized shape on every venue (Pacifica included — it printed the raw /info/prices rows).
      const markets = await adapter.getMarkets();
      if (isJson()) return printJson(jsonOk(markets, fundingWarnings([adapter], markets)));
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
      const bare = bareSymbolOf(symbol).toUpperCase();
      const m = markets.find(
        (mk) => {
          const s = mk.symbol.toUpperCase();
          const sBare = s.replace(/-PERP$/, "");
          return s === sym || sBare === sym || sBare === bare
            || s.split(":").pop() === sym || s.split(":").pop() === bare; // HIP-3: "km:US500" matches "US500"
        }
      );
      if (!m) {
        // Printed (envelope / Error + Remediation) and exit 1 via withJsonErrors.
        return void await withJsonErrors(isJson(), async () => {
          const delistedErr = (adapter as { delistedError?: (s: string) => PerpError | null }).delistedError?.(symbol) ?? null;
          if (delistedErr !== null) throw delistedErr;
          const delisted = typeof (adapter as { delistedMessage?: unknown }).delistedMessage === "function"
            ? (adapter as unknown as { delistedMessage(s: string): string | null }).delistedMessage(symbol)
            : null;
          throw new PerpError("SYMBOL_NOT_FOUND", delisted ?? `Market ${normalizeSymbolArg(symbol)} not found on ${adapter.name}`, {
            exchange: adapter.name,
            remediation: `List markets: perp -e ${adapter.name} market list`,
          });
        });
      }
      if (isJson()) return printJson(jsonOk(m, fundingWarnings([adapter], [m])));
      printMarketInfo(adapter.name, m);
    });

  market
    .command("book <symbol>")
    .description("Show orderbook for a symbol")
    .option("-d, --depth <n>", "Number of levels", "10")
    .action(async (symbol: string, opts: { depth: string }) => {
      const depth = parsePositiveIntArg(opts.depth, "--depth");
      const adapter = await getAdapter();
      const sym = normalizeSymbolArg(symbol);
      // RFQ venue (Variational): no order book — the maker's indicative quotes, labelled as such.
      if (adapter.getRfqQuotes !== undefined) return printRfqQuotes(await adapter.getRfqQuotes(sym), isJson());
      // `depth` reaches venues that size the request by it (GRVT, RISEx); every answer is cut to
      // `depth` levels per side — JSON included (it printed the venue's full book).
      assertBookDepth(adapter.name, depth);
      const full = await adapter.getOrderbook(sym, depth);
      const book = { ...full, bids: full.bids.slice(0, depth), asks: full.asks.slice(0, depth) };
      if (isJson()) return printJson(jsonOk(book));

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
      // A book with a non-USD quoteAsset (QFEX SAMSUNG-KRW) shows its currency, never a $.
      const quote = nonUsdQuoteOf(book);
      const money = (v: number): string => priceOrDash(String(v), book);
      console.log(chalk.gray(`  Price          Size          ${quote === null ? "Cum$          " : `Cum (${quote})`.padEnd(14)}    Depth`));
      console.log(chalk.gray("  " + "─".repeat(60)));
      asks.forEach(([p, a], i) => {
        const cumUsd = askCums[i] * (Number(p));
        console.log(
          chalk.red(`  ${formatUsd(p).padStart(12)}  ${String(a).padEnd(12)}  ${money(cumUsd).padEnd(quote === null ? 15 : 18)}`) +
          chalk.red.dim(bar(askCums[i]))
        );
      });
      // Spread line
      const spreadStr = spreadAbs > 0
        ? `${money(spreadAbs)} (${spreadPct.toFixed(3)}%)`
        : "─";
      console.log(chalk.gray(`  ${"─".repeat(16)} spread: ${spreadStr} ${"─".repeat(10)}`));
      bids.forEach(([p, a], i) => {
        const cumUsd = bidCums[i] * (Number(p));
        console.log(
          chalk.green(`  ${formatUsd(p).padStart(12)}  ${String(a).padEnd(12)}  ${money(cumUsd).padEnd(quote === null ? 15 : 18)}`) +
          chalk.green.dim(bar(bidCums[i]))
        );
      });
      console.log();
    });

  market
    .command("trades <symbol>")
    .description("Recent trades for a symbol")
    .option("--limit <n>", "Number of recent trades to show (default: the venue's own default, within its cap)")
    .action(async (symbol: string, opts: { limit?: string }) => {
      // No --limit → undefined: each adapter applies its own default within its venue cap, so a
      // plain `market trades` never trips a cap (HL serves 10).
      const limit = opts.limit === undefined ? undefined : parsePositiveIntArg(opts.limit, "--limit");
      const adapter = await getAdapter();
      const raw = await adapter.getRecentTrades(normalizeSymbolArg(symbol), limit);
      const trades = newestFirst(raw);
      const skipped = tapeSkippedOf(trades); // metadata survives the sort (sortByTime)
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
      const limit = parsePositiveIntArg(opts.limit, "--limit");
      const adapter = await getAdapter();
      // A venue without a funding-history API (Variational): its current funding terms, labelled as such.
      if (adapter.getFundingTerms !== undefined) return printFundingTerms(await adapter.getFundingTerms(normalizeSymbolArg(symbol)), isJson());
      const history = newestFirst(await adapter.getFundingHistory(normalizeSymbolArg(symbol), limit));
      if (isJson()) return printJson(jsonOk(history));
      if (history.length === 0) {
        console.log(chalk.gray("\n  No funding history.\n"));
        return;
      }
      // `price` is the venue's reference price of the print — oracle (Pacifica), mark (GRVT, Aster)
      // or index (RISEx) — so the column is "Price", not "Oracle"; each rate shows its interval.
      const hasPrice = history.some((h) => h.price != null && h.price !== "0" && h.price !== "");
      const rows = history.map((h) => {
        const base = [
          new Date(h.time).toLocaleString(),
          h.rate === null ? chalk.gray(h.marketClosed === true ? "market closed" : "N/A") : formatPercent(h.rate),
          h.intervalHours === null ? chalk.gray("-") : `${h.intervalHours}h`,
        ];
        if (hasPrice) base.push(h.price != null ? `$${formatUsd(h.price)}` : chalk.gray("n/a"));
        return base;
      });
      const headers = hasPrice ? ["Time", "Funding Rate", "Interval", "Price"] : ["Time", "Funding Rate", "Interval"];
      console.log(makeTable(headers, rows));
      if (!hasPrice) console.log(chalk.gray("  Note: no reference price published with this venue's funding prints.\n"));
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
    .option("--start <ts>", "Start time (unix ms or ISO date, e.g. 2026-10-18T00:00:00Z)")
    .option("--end <ts>", "End time (unix ms or ISO date)")
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
        const startTime = opts.start !== undefined ? parseTimeArg(opts.start, "--start") : now - 24 * 60 * 60 * 1000;
        const endTime = opts.end !== undefined ? parseTimeArg(opts.end, "--end") : now;
        if (startTime > endTime) {
          throw new PerpError("INVALID_PARAMS", `--start (${new Date(startTime).toISOString()}) is after --end (${new Date(endTime).toISOString()})`, {
            remediation: "Pass --start before --end",
          });
        }

        // Candles oldest first (ascending open time) on every venue.
        const klines = sortByTime(await adapter.getKlines(normalizeSymbolArg(symbol), interval, startTime, endTime), "asc");
        if (isJson()) return printJson(jsonOk(klines));
        if (klines.length === 0) {
          console.log(chalk.gray("\n  No kline data.\n"));
          return;
        }
        // ISO (UTC) candle open times — one format for every venue, independent of the host locale.
        const rows = klines.slice(-20).map((k) => [
          new Date(k.time).toISOString(),
          // A row with a non-USD quoteAsset (QFEX SAMSUNG-KRW) prints its currency, never a $.
          priceOrDash(k.open, k),
          priceOrDash(k.high, k),
          priceOrDash(k.low, k),
          priceOrDash(k.close, k),
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
          // Live (non-delisted) assets; a dex whose every asset is delisted is marked as such.
          (d as { delisted?: boolean }).delisted === true ? chalk.gray("delisted") : String(d.assets.length),
          d.assets.slice(0, 5).join(", ") + (d.assets.length > 5 ? ` +${d.assets.length - 5}` : ""),
        ]);
        console.log(makeTable(["DEX", "Deployer", "Assets", "Markets"], rows));
        console.log(chalk.gray(`\n  Use --dex <name> to trade on a deployed dex.`));
        console.log(chalk.gray(`  Example: perp -e hl --dex xyz market list\n`));
      });
    });
}

/**
 * Why a listed market is not tradable, from the row's `status` when the venue states it (QFEX
 * "nonUsdQuote", Ondo "closed" / "reduceOnly"); the generic off-hours text only when it does not.
 * null = tradable or no tradability flag.
 */
export function notTradableNote(m: object): string | null {
  const r = m as { tradable?: unknown; status?: unknown; quoteAsset?: unknown };
  if (r.tradable !== false) return null;
  if (r.status === "nonUsdQuote") return `Read-only in perp-cli: quoted in ${typeof r.quoteAsset === "string" ? r.quoteAsset : "a non-USD currency"} (orders, sizing and risk limits are USD-only).`;
  if (r.status === "closed") return "Not tradable: the venue has closed this market to new trading.";
  if (r.status === "reduceOnly") return "Reduce-only on the venue: positions can be closed, not opened.";
  return "Not tradable right now (off-hours, reduce-only or halted on the venue).";
}

function printMarketInfo(venue: string, m: ExchangeMarketInfo): void {
  console.log(chalk.cyan.bold(`\n  ${m.symbol} on ${venue}\n`));
  const note = notTradableNote(m);
  if (note !== null) console.log(chalk.yellow(`  ${note}`));
  console.log(`  Mark Price:     ${priceOrDash(m.markPrice, m)}`);
  console.log(`  Index Price:    ${priceOrDash(m.indexPrice, m)}`);
  // Per-market funding interval (GRVT 4h / 8h, Variational, Aster): the rate carries its interval.
  console.log(`  Funding Rate:   ${fundingCell(m, perMarketFunding(venue))}`);
  // A venue whose rate is unverified (QFEX) labels it on the row.
  const fundingNote = (m as { fundingNote?: unknown }).fundingNote;
  if (typeof fundingNote === "string") console.log(chalk.yellow(`                  ${fundingNote}`));
  console.log(`  24h Volume:     ${volumeCell(m)}`);
  console.log(`  Open Interest:  ${formatOpenInterest(m, true)}`);
  console.log(`  Max Leverage:   ${m.maxLeverage === null ? chalk.gray("-") : `${m.maxLeverage}x`}`);
  console.log();
}
