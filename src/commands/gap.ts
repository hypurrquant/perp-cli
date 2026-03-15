import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk } from "../utils.js";
import {
  fetchPacificaPricesRaw, parsePacificaRaw,
  fetchHyperliquidAllMidsRaw,
  fetchLighterOrderBookDetailsRaw,
} from "../shared-api.js";

interface PriceSnapshot {
  symbol: string;
  pacPrice: number | null;
  hlPrice: number | null;
  ltPrice: number | null;
  maxGap: number; // absolute $ max difference across exchanges
  maxGapPct: number; // percentage max difference
  cheapest: string;
  expensive: string;
}

async function fetchAllPrices(): Promise<PriceSnapshot[]> {
  const [pacRes, hlRes, ltRes] = await Promise.all([
    fetchPacificaPricesRaw(),
    fetchHyperliquidAllMidsRaw(),
    fetchLighterOrderBookDetailsRaw(),
  ]);

  const { prices: pacPrices } = parsePacificaRaw(pacRes);

  const hlPrices = new Map<string, number>();
  if (hlRes && typeof hlRes === "object" && !Array.isArray(hlRes)) {
    for (const [symbol, price] of Object.entries(hlRes as Record<string, string>)) {
      const p = Number(price);
      if (p > 0) hlPrices.set(symbol, p);
    }
  }

  const ltPrices = new Map<string, number>();
  if (ltRes) {
    const details = ((ltRes as Record<string, unknown>).order_book_details ?? []) as Array<Record<string, unknown>>;
    for (const m of details) {
      const sym = String(m.symbol ?? "").replace(/_USDC$/, "");
      const price = Number(m.last_trade_price ?? m.mark_price ?? 0);
      if (sym && price > 0) ltPrices.set(sym, price);
    }
  }

  const allSymbols = new Set([...pacPrices.keys(), ...hlPrices.keys(), ...ltPrices.keys()]);
  const snapshots: PriceSnapshot[] = [];

  for (const sym of allSymbols) {
    const pac = pacPrices.get(sym) ?? null;
    const hl = hlPrices.get(sym) ?? null;
    const lt = ltPrices.get(sym) ?? null;

    // Need at least 2 exchanges
    const available: { ex: string; price: number }[] = [];
    if (pac !== null) available.push({ ex: "PAC", price: pac });
    if (hl !== null) available.push({ ex: "HL", price: hl });
    if (lt !== null) available.push({ ex: "LT", price: lt });
    if (available.length < 2) continue;

    available.sort((a, b) => a.price - b.price);
    const cheapest = available[0];
    const expensive = available[available.length - 1];
    const maxGap = expensive.price - cheapest.price;
    const mid = (cheapest.price + expensive.price) / 2;
    const maxGapPct = mid > 0 ? (maxGap / mid) * 100 : 0;

    snapshots.push({
      symbol: sym,
      pacPrice: pac,
      hlPrice: hl,
      ltPrice: lt,
      maxGap,
      maxGapPct,
      cheapest: cheapest.ex,
      expensive: expensive.ex,
    });
  }

  return snapshots.sort((a, b) => b.maxGapPct - a.maxGapPct);
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function printGapTable(snapshots: PriceSnapshot[], minGap: number) {
  const filtered = snapshots.filter((s) => s.maxGapPct >= minGap);

  if (filtered.length === 0) {
    console.log(chalk.gray(`\n  No gaps above ${minGap}%\n`));
    return;
  }

  console.log(
    chalk.cyan.bold("\n  Symbol      Pacifica          Hyperliquid       Lighter           Gap($)      Gap(%)    Buy/Sell\n")
  );

  for (const s of filtered) {
    const gapColor =
      s.maxGapPct >= 0.5
        ? chalk.red.bold
        : s.maxGapPct >= 0.1
          ? chalk.yellow
          : chalk.gray;
    const fmtP = (p: number | null) => p !== null ? `$${formatPrice(p).padEnd(16)}` : chalk.gray("-".padEnd(17));

    console.log(
      `  ${chalk.white.bold(s.symbol.padEnd(10))} ` +
        `${fmtP(s.pacPrice)} ` +
        `${fmtP(s.hlPrice)} ` +
        `${fmtP(s.ltPrice)} ` +
        `${gapColor("$" + s.maxGap.toFixed(4).padEnd(10))} ` +
        `${gapColor(s.maxGapPct.toFixed(4).padEnd(8) + "%")} ` +
        `${chalk.green(s.cheapest)}→${chalk.red(s.expensive)}`
    );
  }

  const avgGap =
    filtered.reduce((sum, s) => sum + s.maxGapPct, 0) / filtered.length;
  const top = filtered[0];

  console.log(
    chalk.gray(
      `\n  ${filtered.length} pairs | Avg gap: ${avgGap.toFixed(4)}% | Max: ${top.symbol} ${top.maxGapPct.toFixed(4)}%\n`
    )
  );
}

export function registerGapCommands(
  program: Command,
  isJson: () => boolean
) {
  const gap = program
    .command("gap")
    .description("[Deprecated] Use 'perp arb gap'. Cross-exchange price gap monitoring");

  // ── gap show (default) ──

  gap
    .command("show", { isDefault: true })
    .description("Show current price gaps between exchanges")
    .option("--min <pct>", "Minimum gap % to display", "0.01")
    .option("--symbol <sym>", "Filter by symbol (e.g. BTC, ETH)")
    .option("--top <n>", "Show top N gaps only")
    .action(async (opts: { min: string; symbol?: string; top?: string }) => {
      const minGap = parseFloat(opts.min);
      if (!isJson()) console.log(chalk.cyan("\n  Fetching prices from Pacifica, Hyperliquid & Lighter...\n"));

      let snapshots = await fetchAllPrices();

      if (opts.symbol) {
        const sym = opts.symbol.toUpperCase();
        snapshots = snapshots.filter((s) => s.symbol.includes(sym));
      }

      if (opts.top) {
        snapshots = snapshots.slice(0, parseInt(opts.top));
      }

      if (isJson()) return printJson(jsonOk(snapshots.filter((s) => s.maxGapPct >= minGap)));

      printGapTable(snapshots, minGap);
    });

  // ── gap watch ── (live monitoring)

  gap
    .command("watch")
    .description("Live-monitor price gaps (auto-refresh)")
    .option("--min <pct>", "Minimum gap % to display", "0.05")
    .option("--interval <seconds>", "Refresh interval", "5")
    .option("--symbol <sym>", "Filter by symbol")
    .option("--beep", "Beep on gaps above 0.5%")
    .action(
      async (opts: {
        min: string;
        interval: string;
        symbol?: string;
        beep?: boolean;
      }) => {
        const minGap = parseFloat(opts.min);
        const intervalMs = parseInt(opts.interval) * 1000;
        const beep = !!opts.beep;

        if (!isJson()) {
          console.log(chalk.cyan.bold("\n  Price Gap Monitor"));
          console.log(`  Min gap:   ${minGap}%`);
          console.log(`  Interval:  ${opts.interval}s`);
          if (opts.symbol) console.log(`  Symbol:    ${opts.symbol.toUpperCase()}`);
          console.log(chalk.gray("  Ctrl+C to stop\n"));
        }

        const cycle = async () => {
          try {
            let snapshots = await fetchAllPrices();

            if (opts.symbol) {
              const sym = opts.symbol.toUpperCase();
              snapshots = snapshots.filter((s) => s.symbol.includes(sym));
            }

            // Clear screen for live view
            process.stdout.write("\x1B[2J\x1B[0f");

            const now = new Date().toLocaleTimeString();
            console.log(
              chalk.cyan.bold(`  Price Gap Monitor`) +
                chalk.gray(`  ${now}  (refresh: ${opts.interval}s)\n`)
            );

            printGapTable(snapshots, minGap);

            // Alert on large gaps
            const bigGaps = snapshots.filter((s) => s.maxGapPct >= 0.5);
            if (bigGaps.length > 0) {
              console.log(
                chalk.red.bold(
                  `  !! ${bigGaps.length} large gap(s): ` +
                    bigGaps
                      .map((s) => `${s.symbol}(${s.maxGapPct.toFixed(3)}%)`)
                      .join(", ")
                )
              );
              if (beep) process.stdout.write("\x07");
            }
          } catch (err) {
            console.error(
              chalk.gray(
                `  Error: ${err instanceof Error ? err.message : String(err)}`
              )
            );
          }
        };

        await cycle();
        setInterval(cycle, intervalMs);
        await new Promise(() => {}); // keep alive
      }
    );

  // ── gap history ── (track gap over time for a symbol)

  gap
    .command("track")
    .description("Track a symbol's gap over time and print stats")
    .requiredOption("-s, --symbol <sym>", "Symbol to track (e.g. BTC)")
    .option("--duration <minutes>", "How long to track (minutes)", "10")
    .option("--interval <seconds>", "Sample interval", "10")
    .action(
      async (opts: { symbol: string; duration: string; interval: string }) => {
        const symbol = opts.symbol.toUpperCase();
        const durationMs = parseInt(opts.duration) * 60 * 1000;
        const intervalMs = parseInt(opts.interval) * 1000;
        const endTime = Date.now() + durationMs;

        const samples: { time: string; gap: number; gapPct: number; direction: string }[] = [];

        if (!isJson()) {
          console.log(chalk.cyan.bold(`\n  Tracking ${symbol} price gap\n`));
          console.log(`  Duration:  ${opts.duration} min`);
          console.log(`  Interval:  ${opts.interval}s`);
          console.log(chalk.gray("  Collecting samples...\n"));
        }

        const sample = async () => {
          const snapshots = await fetchAllPrices();
          const s = snapshots.find((x) => x.symbol === symbol);
          if (!s) {
            console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} — ${symbol} not found on both exchanges`));
            return;
          }

          samples.push({
            time: new Date().toLocaleTimeString(),
            gap: s.maxGap,
            gapPct: s.maxGapPct,
            direction: `${s.cheapest}→${s.expensive}`,
          });

          const gapColor = s.maxGapPct >= 0.1 ? chalk.yellow : chalk.gray;
          const parts = [`PAC: ${s.pacPrice !== null ? "$" + formatPrice(s.pacPrice) : "-"}`];
          parts.push(`HL: ${s.hlPrice !== null ? "$" + formatPrice(s.hlPrice) : "-"}`);
          parts.push(`LT: ${s.ltPrice !== null ? "$" + formatPrice(s.ltPrice) : "-"}`);
          console.log(
            `  ${chalk.white(s.symbol.padEnd(6))} ` +
              `${parts.join("  ")}  ` +
              `${gapColor(`${s.maxGapPct.toFixed(4)}%`)}  ${s.cheapest}→${s.expensive}`
          );
        };

        await sample();
        const timer = setInterval(async () => {
          if (Date.now() >= endTime) {
            clearInterval(timer);
            printTrackSummary(symbol, samples);
            return;
          }
          await sample();
        }, intervalMs);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, durationMs + 1000);
        });
      }
    );

  // ── gap alert ── (one-shot: notify when gap exceeds threshold)

  gap
    .command("alert")
    .description("Wait until a symbol's gap exceeds a threshold, then exit")
    .requiredOption("-s, --symbol <sym>", "Symbol to watch")
    .requiredOption("--above <pct>", "Gap % threshold to trigger")
    .option("--interval <seconds>", "Check interval", "5")
    .action(
      async (opts: { symbol: string; above: string; interval: string }) => {
        const symbol = opts.symbol.toUpperCase();
        const threshold = parseFloat(opts.above);
        const intervalMs = parseInt(opts.interval) * 1000;

        if (!isJson()) console.log(chalk.cyan(`\n  Waiting for ${symbol} gap > ${threshold}%...\n`));

        const check = async (): Promise<boolean> => {
          const snapshots = await fetchAllPrices();
          const s = snapshots.find((x) => x.symbol === symbol);
          if (!s) return false;

          const now = new Date().toLocaleTimeString();
          if (!isJson()) console.log(chalk.gray(`  ${now} ${symbol} gap: ${s.maxGapPct.toFixed(4)}%`));

          if (s.maxGapPct >= threshold) {
            if (isJson()) {
              printJson(jsonOk(s));
            } else {
              console.log(
                chalk.green.bold(
                  `\n  TRIGGERED! ${symbol} gap: ${s.maxGapPct.toFixed(4)}% (> ${threshold}%)`
                )
              );
              const lines = [];
              if (s.pacPrice !== null) lines.push(`  Pacifica:    $${formatPrice(s.pacPrice)}`);
              if (s.hlPrice !== null) lines.push(`  Hyperliquid: $${formatPrice(s.hlPrice)}`);
              if (s.ltPrice !== null) lines.push(`  Lighter:     $${formatPrice(s.ltPrice)}`);
              lines.push(`  Gap:         $${s.maxGap.toFixed(4)} (${s.cheapest}→${s.expensive})`);
              console.log(lines.join("\n") + "\n");
            }
            return true;
          }
          return false;
        };

        if (await check()) return;

        await new Promise<void>((resolve) => {
          const timer = setInterval(async () => {
            if (await check()) {
              clearInterval(timer);
              resolve();
            }
          }, intervalMs);
        });
      }
    );
}

function printTrackSummary(
  symbol: string,
  samples: { time: string; gap: number; gapPct: number; direction: string }[]
) {
  if (samples.length === 0) {
    console.log(chalk.gray("\n  No samples collected.\n"));
    return;
  }

  const gaps = samples.map((s) => s.gapPct);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const max = Math.max(...gaps);
  const min = Math.min(...gaps);
  const maxSample = samples[gaps.indexOf(max)];

  // Count direction frequencies
  const dirCounts = new Map<string, number>();
  for (const s of samples) {
    dirCounts.set(s.direction, (dirCounts.get(s.direction) ?? 0) + 1);
  }

  console.log(chalk.cyan.bold(`\n  ${symbol} Gap Summary (${samples.length} samples)\n`));
  console.log(`  Avg gap:    ${avg.toFixed(4)}%`);
  console.log(`  Max gap:    ${max.toFixed(4)}% at ${maxSample.time}`);
  console.log(`  Min gap:    ${min.toFixed(4)}%`);
  for (const [dir, count] of [...dirCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dir.padEnd(10)} ${count} times (${((count / samples.length) * 100).toFixed(0)}%)`);
  }
  console.log();
}
