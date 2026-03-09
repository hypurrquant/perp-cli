import { Command } from "commander";
import chalk from "chalk";
import { formatUsd, printJson, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { computeExecutableSize } from "../liquidity.js";
import { computeAnnualSpread } from "../funding.js";
import { scanDexArb, type DexArbPair } from "../dex-asset-map.js";
import { logExecution } from "../execution-log.js";

interface ExchangeRate {
  exchange: string;
  rate: number;
}

interface FundingSnapshot {
  symbol: string;
  pacRate: number;
  hlRate: number;
  ltRate: number;
  spread: number; // annualized %, max spread across all exchanges
  longExch: string;
  shortExch: string;
  markPrice: number; // best available mark price across exchanges
}

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  size: string;
  entrySpread: number;
  entryTime: string;
}

const LIGHTER_URL = "https://mainnet.zklighter.elliot.ai";

async function fetchFundingSpreads(): Promise<FundingSnapshot[]> {
  const [pacRes, hlRes, ltDetailsRes, ltFundingRes] = await Promise.all([
    fetch("https://api.pacifica.fi/api/v1/info/prices").then(r => r.json()).catch(() => null),
    fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    }).then(r => r.json()).catch(() => null),
    fetch(`${LIGHTER_URL}/api/v1/orderBookDetails`).then(r => r.json()).catch(() => null),
    fetch(`${LIGHTER_URL}/api/v1/funding-rates`).then(r => r.json()).catch(() => null),
  ]);

  const pacRates = new Map<string, number>();
  const pacPrices = new Map<string, number>();
  if (Array.isArray(pacRes?.data ?? pacRes)) {
    for (const p of (pacRes.data ?? pacRes) as Record<string, unknown>[]) {
      pacRates.set(String(p.symbol), Number(p.funding ?? 0));
      if (p.mark) pacPrices.set(String(p.symbol), Number(p.mark));
    }
  }

  const hlRates = new Map<string, number>();
  const hlPrices = new Map<string, number>();
  if (hlRes && Array.isArray(hlRes)) {
    const universe = hlRes[0]?.universe ?? [];
    const ctxs = hlRes[1] ?? [];
    universe.forEach((a: Record<string, unknown>, i: number) => {
      const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
      hlRates.set(String(a.name), Number(ctx.funding ?? 0));
      if (ctx.markPx) hlPrices.set(String(a.name), Number(ctx.markPx));
    });
  }

  const ltRates = new Map<string, number>();
  const ltPrices = new Map<string, number>();
  if (ltFundingRes) {
    // Build market_id → symbol from orderBookDetails
    const idToSym = new Map<number, string>();
    const idToPrice = new Map<number, number>();
    if (ltDetailsRes) {
      const details = (ltDetailsRes as Record<string, unknown>).order_book_details ?? [];
      for (const m of details as Array<Record<string, unknown>>) {
        idToSym.set(Number(m.market_id), String(m.symbol ?? ""));
        if (m.last_trade_price) idToPrice.set(Number(m.market_id), Number(m.last_trade_price));
      }
    }
    const fundingList = (ltFundingRes as Record<string, unknown>).funding_rates ?? [];
    for (const fr of fundingList as Array<Record<string, unknown>>) {
      const sym = String(fr.symbol ?? "") || idToSym.get(Number(fr.market_id)) || "";
      if (sym) {
        ltRates.set(sym, Number(fr.rate ?? fr.funding_rate ?? 0));
        const mp = Number(fr.mark_price ?? 0) || idToPrice.get(Number(fr.market_id)) || 0;
        if (mp > 0) ltPrices.set(sym, mp);
      }
    }
  }

  const snapshots: FundingSnapshot[] = [];
  const allSymbols = new Set([...pacRates.keys(), ...hlRates.keys(), ...ltRates.keys()]);

  for (const sym of allSymbols) {
    const pac = pacRates.get(sym);
    const hl = hlRates.get(sym);
    const lt = ltRates.get(sym);

    // Need at least 2 exchanges
    const available: ExchangeRate[] = [];
    if (pac !== undefined) available.push({ exchange: "pacifica", rate: pac });
    if (hl !== undefined) available.push({ exchange: "hyperliquid", rate: hl });
    if (lt !== undefined) available.push({ exchange: "lighter", rate: lt });
    if (available.length < 2) continue;

    available.sort((a, b) => a.rate - b.rate);
    const lowest = available[0];
    const highest = available[available.length - 1];
    const spread = computeAnnualSpread(highest.rate, highest.exchange, lowest.rate, lowest.exchange);

    // Use best available mark price (prefer HL as most liquid, then PAC, then LT)
    const markPrice = hlPrices.get(sym) ?? pacPrices.get(sym) ?? ltPrices.get(sym) ?? 0;

    snapshots.push({
      symbol: sym,
      pacRate: pac ?? 0,
      hlRate: hl ?? 0,
      ltRate: lt ?? 0,
      spread,
      longExch: lowest.exchange,  // long where funding is lowest
      shortExch: highest.exchange, // short where funding is highest
      markPrice,
    });
  }

  return snapshots.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
}

export function registerArbAutoCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getHLAdapterForDex?: (dex: string) => Promise<import("../exchanges/hyperliquid.js").HyperliquidAdapter>,
) {
  const arb = program.commands.find(c => c.name() === "arb");
  if (!arb) return;

  // ── arb auto ── (daemon mode)

  arb
    .command("auto")
    .description("Auto-execute funding rate arbitrage (daemon)")
    .option("--min-spread <pct>", "Min annual spread to enter (%)", "30")
    .option("--close-spread <pct>", "Close when spread drops below (%)", "5")
    .option("--size <usd>", "Position size per leg ($)", "100")
    .option("--max-positions <n>", "Max simultaneous arb positions", "5")
    .option("--symbols <list>", "Comma-separated symbols to monitor (default: all)")
    .option("--interval <seconds>", "Check interval", "60")
    .option("--dry-run", "Simulate without executing trades")
    .option("--background", "Run in background (tmux)")
    .action(async (opts: {
      minSpread: string; closeSpread: string; size: string;
      maxPositions: string; symbols?: string; interval: string; dryRun?: boolean;
      background?: boolean;
    }) => {
      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const cliArgs = [
          `--min-spread`, opts.minSpread,
          `--close-spread`, opts.closeSpread,
          `--size`, opts.size,
          `--max-positions`, opts.maxPositions,
          `--interval`, opts.interval,
          ...(opts.symbols ? [`--symbols`, opts.symbols] : []),
          ...(opts.dryRun ? [`--dry-run`] : []),
          ...(opts.minSpread ? [`--auto-execute`] : []),
        ];
        const job = startJob({
          strategy: "funding-arb",
          exchange: "multi",
          params: { ...opts },
          cliArgs,
        });
        if (isJson()) return printJson(jsonOk(job));
        console.log(chalk.green(`\n  Funding arb bot started in background.`));
        console.log(`  ID: ${chalk.white.bold(job.id)}`);
        console.log(`  Min spread: ${opts.minSpread}% | Size: $${opts.size}`);
        console.log(`  Logs: ${chalk.gray(`perp jobs logs ${job.id}`)}`);
        console.log(`  Stop: ${chalk.gray(`perp jobs stop ${job.id}`)}\n`);
        return;
      }

      const minSpread = parseFloat(opts.minSpread);
      const closeSpread = parseFloat(opts.closeSpread);
      const sizeUsd = parseFloat(opts.size);
      const maxPositions = parseInt(opts.maxPositions);
      const intervalMs = parseInt(opts.interval) * 1000;
      const filterSymbols = opts.symbols?.split(",").map(s => s.trim().toUpperCase());
      const dryRun = !!opts.dryRun || process.argv.includes("--dry-run");

      const openPositions: ArbPosition[] = [];

      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Funding Rate Arb Bot\n"));
        console.log(`  Mode:          ${dryRun ? chalk.yellow("DRY RUN") : chalk.green("LIVE")}`);
        console.log(`  Enter spread:  >= ${minSpread}% annual`);
        console.log(`  Close spread:  <= ${closeSpread}% annual`);
        console.log(`  Size per leg:  $${sizeUsd}`);
        console.log(`  Max positions: ${maxPositions}`);
        console.log(`  Symbols:       ${filterSymbols?.join(", ") || "all"}`);
        console.log(`  Interval:      ${opts.interval}s`);
        console.log(chalk.gray("\n  Monitoring... (Ctrl+C to stop)\n"));
      }

      const cycle = async () => {
        try {
          const spreads = await fetchFundingSpreads();
          const filtered = filterSymbols
            ? spreads.filter(s => filterSymbols.includes(s.symbol))
            : spreads;

          const now = new Date().toLocaleTimeString();

          // Check for close conditions on open positions
          for (let i = openPositions.length - 1; i >= 0; i--) {
            const pos = openPositions[i];
            const current = filtered.find(s => s.symbol === pos.symbol);
            if (!current) continue;

            const currentSpread = Math.abs(current.spread);
            if (currentSpread <= closeSpread) {
              console.log(chalk.yellow(`  ${now} CLOSE ${pos.symbol} — spread ${currentSpread.toFixed(1)}% < ${closeSpread}%`));

              if (!dryRun) {
                try {
                  // Close both legs
                  const longAdapter = await getAdapterForExchange(pos.longExchange);
                  const shortAdapter = await getAdapterForExchange(pos.shortExchange);
                  await longAdapter.marketOrder(pos.symbol, "sell", pos.size);
                  await shortAdapter.marketOrder(pos.symbol, "buy", pos.size);
                  logExecution({
                    type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                    symbol: pos.symbol, side: "close", size: pos.size,
                    status: "success", dryRun: false,
                    meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, currentSpread: currentSpread },
                  });
                  console.log(chalk.green(`  ${now} CLOSED ${pos.symbol} — both legs`));
                } catch (err) {
                  logExecution({
                    type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                    symbol: pos.symbol, side: "close", size: pos.size,
                    status: "failed", dryRun: false,
                    error: err instanceof Error ? err.message : String(err),
                    meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange },
                  });
                  console.error(chalk.red(`  ${now} CLOSE FAILED ${pos.symbol}: ${err instanceof Error ? err.message : err}`));
                }
              }

              openPositions.splice(i, 1);
            }
          }

          // Check for entry conditions
          if (openPositions.length < maxPositions) {
            for (const snap of filtered) {
              if (openPositions.some(p => p.symbol === snap.symbol)) continue;
              if (openPositions.length >= maxPositions) break;

              const absSpread = Math.abs(snap.spread);
              if (absSpread < minSpread) continue;

              // Determine direction: short the high-funding exchange (get paid), long the low-funding one
              const shortExchange = snap.pacRate > snap.hlRate ? "pacifica" : "hyperliquid";
              const longExchange = snap.pacRate > snap.hlRate ? "hyperliquid" : "pacifica";

              console.log(chalk.green(
                `  ${now} ENTER ${snap.symbol} — spread ${absSpread.toFixed(1)}%` +
                ` | Long ${longExchange} (${(snap[longExchange === "pacifica" ? "pacRate" : "hlRate"] * 100).toFixed(4)}%)` +
                ` | Short ${shortExchange} (${(snap[shortExchange === "pacifica" ? "pacRate" : "hlRate"] * 100).toFixed(4)}%)`
              ));

              // Calculate size in asset units from USD and mark price
              if (snap.markPrice <= 0) {
                console.error(chalk.red(`  ${now} SKIP ${snap.symbol}: no mark price available`));
                continue;
              }
              const sizeInAsset = (sizeUsd / snap.markPrice).toFixed(4);

              if (!dryRun) {
                try {
                  const longAdapter = await getAdapterForExchange(longExchange);
                  const shortAdapter = await getAdapterForExchange(shortExchange);

                  // Use market orders for immediate fill
                  await Promise.all([
                    longAdapter.marketOrder(snap.symbol, "buy", sizeInAsset),
                    shortAdapter.marketOrder(snap.symbol, "sell", sizeInAsset),
                  ]);
                  logExecution({
                    type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                    symbol: snap.symbol, side: "entry", size: sizeInAsset,
                    status: "success", dryRun: false,
                    meta: { longExchange, shortExchange, spread: absSpread, markPrice: snap.markPrice },
                  });
                  console.log(chalk.green(`  ${now} FILLED ${snap.symbol} — both legs @ ${sizeInAsset} units ($${sizeUsd} / $${snap.markPrice.toFixed(2)})`));
                } catch (err) {
                  logExecution({
                    type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                    symbol: snap.symbol, side: "entry", size: sizeInAsset,
                    status: "failed", dryRun: false,
                    error: err instanceof Error ? err.message : String(err),
                    meta: { longExchange, shortExchange, spread: absSpread },
                  });
                  console.error(chalk.red(`  ${now} ENTRY FAILED ${snap.symbol}: ${err instanceof Error ? err.message : err}`));
                  continue;
                }
              }

              openPositions.push({
                symbol: snap.symbol,
                longExchange,
                shortExchange,
                size: sizeInAsset,
                entrySpread: absSpread,
                entryTime: new Date().toISOString(),
              });
            }
          }

          // Periodic status
          if (openPositions.length > 0) {
            console.log(chalk.gray(
              `  ${now} Status: ${openPositions.length} positions — ` +
              openPositions.map(p => `${p.symbol}(${p.entrySpread.toFixed(0)}%)`).join(", ")
            ));
          }
        } catch (err) {
          console.error(chalk.gray(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        }
      };

      await cycle();
      setInterval(cycle, intervalMs);
      await new Promise(() => {}); // keep alive
    });

  // ── arb scan ── (one-shot spread scan)

  arb
    .command("scan")
    .description("Scan current funding rate spreads")
    .option("--min <pct>", "Min annual spread to show", "10")
    .action(async (opts: { min: string }) => {
      const minSpread = parseFloat(opts.min);
      if (!isJson()) console.log(chalk.cyan("\n  Scanning funding rate spreads...\n"));

      const spreads = await fetchFundingSpreads();
      const filtered = spreads.filter(s => Math.abs(s.spread) >= minSpread);

      if (isJson()) return printJson(jsonOk(filtered));

      if (filtered.length === 0) {
        console.log(chalk.gray(`  No spreads above ${minSpread}%\n`));
        return;
      }

      for (const s of filtered) {
        const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
        const direction = `${exAbbr(s.shortExch)}>${exAbbr(s.longExch)}`;
        const color = Math.abs(s.spread) >= 30 ? chalk.green : chalk.yellow;
        const rates: string[] = [];
        if (s.pacRate) rates.push(`PAC: ${(s.pacRate * 100).toFixed(4)}%`);
        if (s.hlRate) rates.push(`HL: ${(s.hlRate * 100).toFixed(4)}%`);
        if (s.ltRate) rates.push(`LT: ${(s.ltRate * 100).toFixed(4)}%`);
        console.log(
          `  ${chalk.white.bold(s.symbol.padEnd(8))} ` +
          `${color(`${Math.abs(s.spread).toFixed(1)}%`.padEnd(8))} ` +
          `${direction.padEnd(7)} ` +
          rates.join("  ")
        );
      }

      console.log(chalk.gray(`\n  ${filtered.length} opportunities above ${minSpread}% annual spread`));
      console.log(chalk.gray(`  Use 'perp arb auto --min-spread ${minSpread}' to auto-trade\n`));
    });

  // ── arb pnl ── (check arb position PnL)

  arb
    .command("pnl")
    .description("Check PnL of current arb positions across exchanges")
    .action(async () => {
      if (!isJson()) console.log(chalk.cyan("\n  Checking arb positions...\n"));

      const exchangeNames = ["hyperliquid", "lighter", "pacifica"];
      const allPositions: { exchange: string; symbol: string; side: string; size: number; entry: number; mark: number; upnl: number; lev: number }[] = [];

      for (const exName of exchangeNames) {
        try {
          const adapter = await getAdapterForExchange(exName);
          const positions = await adapter.getPositions();
          for (const p of positions) {
            allPositions.push({
              exchange: exName,
              symbol: p.symbol.replace("-PERP", ""),
              side: p.side,
              size: Math.abs(Number(p.size)),
              entry: Number(p.entryPrice),
              mark: Number(p.markPrice),
              upnl: Number(p.unrealizedPnl),
              lev: p.leverage,
            });
          }
        } catch {
          // exchange not configured, skip
        }
      }

      if (allPositions.length === 0) {
        console.log(chalk.gray("  No positions found on any exchange.\n"));
        return;
      }

      // Group by symbol to find arb pairs
      const bySymbol = new Map<string, typeof allPositions>();
      for (const p of allPositions) {
        const key = p.symbol.toUpperCase();
        if (!bySymbol.has(key)) bySymbol.set(key, []);
        bySymbol.get(key)!.push(p);
      }

      // Get current funding rates
      const spreads = await fetchFundingSpreads();
      const spreadMap = new Map(spreads.map(s => [s.symbol.toUpperCase(), s]));

      // Get fee rates (approximate)
      const TAKER_FEE = 0.00035; // ~0.035% typical

      if (isJson()) {
        const result = [...bySymbol.entries()].map(([symbol, positions]) => {
          const spread = spreadMap.get(symbol);
          return { symbol, positions, currentSpread: spread?.spread ?? 0 };
        });
        return printJson(jsonOk(result));
      }

      let totalUpnl = 0;
      let totalFees = 0;

      for (const [symbol, positions] of bySymbol) {
        const isArb = positions.length >= 2 && positions.some(p => p.side === "long") && positions.some(p => p.side === "short");
        const spread = spreadMap.get(symbol);

        console.log(chalk.white.bold(`  ${symbol}`) + (isArb ? chalk.green(" [ARB PAIR]") : chalk.gray(" [single]")));

        for (const p of positions) {
          const sideColor = p.side === "long" ? chalk.green : chalk.red;
          const pnlColor = p.upnl >= 0 ? chalk.green : chalk.red;
          const notional = p.size * p.mark;
          const entryFee = p.size * p.entry * TAKER_FEE;
          totalFees += entryFee;
          totalUpnl += p.upnl;

          console.log(
            `    ${sideColor(p.side.toUpperCase().padEnd(6))} ${p.exchange.padEnd(13)} ` +
            `size: ${p.size.toFixed(2).padEnd(8)} entry: $${p.entry.toFixed(4).padEnd(10)} ` +
            `mark: $${p.mark.toFixed(4).padEnd(10)} uPnL: ${pnlColor(p.upnl >= 0 ? "+" : "")}$${p.upnl.toFixed(4)}`
          );
          console.log(chalk.gray(`           notional: $${notional.toFixed(2)}  est.entry fee: $${entryFee.toFixed(4)}  lev: ${p.lev}x`));
        }

        if (spread) {
          const annSpread = Math.abs(spread.spread);
          const spreadColor = annSpread >= 20 ? chalk.green : annSpread >= 10 ? chalk.yellow : chalk.gray;
          // Estimate hourly funding income for this pair
          const longPos = positions.find(p => p.side === "long");
          const shortPos = positions.find(p => p.side === "short");
          if (longPos && shortPos) {
            const avgNotional = (longPos.size * longPos.mark + shortPos.size * shortPos.mark) / 2;
            const hourlyIncome = (annSpread / 100) / (24 * 365) * avgNotional;
            const dailyIncome = hourlyIncome * 24;
            console.log(chalk.cyan(
              `    Spread: ${spreadColor(`${annSpread.toFixed(1)}%`)} annual | ` +
              `Est. income: $${hourlyIncome.toFixed(4)}/hr, $${dailyIncome.toFixed(3)}/day`
            ));
          }
        }
        console.log();
      }

      // Summary
      const exitFees = allPositions.reduce((s, p) => s + p.size * p.mark * TAKER_FEE, 0);
      totalFees += exitFees;
      const netPnl = totalUpnl - totalFees;

      console.log(chalk.white.bold("  Summary"));
      const upnlColor = totalUpnl >= 0 ? chalk.green : chalk.red;
      const netColor = netPnl >= 0 ? chalk.green : chalk.red;
      console.log(`    Unrealized PnL:  ${upnlColor(`$${totalUpnl.toFixed(4)}`)}`);
      console.log(`    Est. fees (in+out): ${chalk.red(`-$${totalFees.toFixed(4)}`)}`);
      console.log(`    Net (if closed now): ${netColor(`$${netPnl.toFixed(4)}`)}`);
      console.log(chalk.gray(`    (Fees assume ${(TAKER_FEE * 100).toFixed(3)}% taker. Actual may vary.)\n`));
    });

  // ── arb monitor ── (live monitoring with liquidity)

  arb
    .command("monitor")
    .description("Live-monitor funding spreads with liquidity data")
    .option("--min <pct>", "Min annual spread to show", "20")
    .option("--interval <sec>", "Refresh interval in seconds", "60")
    .option("--top <n>", "Show top N opportunities", "15")
    .option("--check-liquidity", "Check orderbook depth (slower)")
    .action(async (opts: { min: string; interval: string; top: string; checkLiquidity?: boolean }) => {
      const minSpread = parseFloat(opts.min);
      const intervalSec = parseInt(opts.interval);
      const topN = parseInt(opts.top);
      const checkLiq = opts.checkLiquidity ?? false;
      let cycle = 0;

      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Funding Arb Monitor"));
        console.log(chalk.gray(`  Min spread: ${minSpread}% | Refresh: ${intervalSec}s | Top: ${topN}`));
        if (checkLiq) console.log(chalk.gray(`  Liquidity check: ON`));
        console.log(chalk.gray(`  Press Ctrl+C to stop\n`));
      }

      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";

      while (true) {
        cycle++;
        const ts = new Date().toLocaleTimeString();

        try {
          const spreads = await fetchFundingSpreads();
          const filtered = spreads
            .filter(s => Math.abs(s.spread) >= minSpread)
            .slice(0, topN);

          // Clear previous output (move cursor up)
          if (cycle > 1) {
            const linesToClear = filtered.length + 4;
            process.stdout.write(`\x1b[${linesToClear}A\x1b[J`);
          }

          console.log(chalk.gray(`  ${ts} — Cycle ${cycle} | ${filtered.length} opportunities >= ${minSpread}%\n`));

          if (filtered.length === 0) {
            console.log(chalk.gray(`  No opportunities found.\n`));
          } else {
            // Optionally check liquidity for top entries
            const liqData = new Map<string, { hlDepth: number; ltDepth: number; gap: string }>();

            if (checkLiq && filtered.length > 0) {
              const topCheck = filtered.slice(0, 5); // check liquidity for top 5 only
              await Promise.allSettled(topCheck.map(async (s) => {
                try {
                  const [hlOB, ltOB] = await Promise.all([
                    fetchHLOrderbook(s.symbol),
                    fetchLighterOrderbook(s.symbol),
                  ]);
                  const hlDepth = hlOB.reduce((sum, l) => sum + l[0] * l[1], 0);
                  const ltDepth = ltOB.reduce((sum, l) => sum + l[0] * l[1], 0);
                  // Price gap between best ask (buy side) and best bid (sell side)
                  const hlBest = hlOB[0]?.[0] ?? 0;
                  const ltBest = ltOB[0]?.[0] ?? 0;
                  const gap = hlBest && ltBest
                    ? (Math.abs(hlBest - ltBest) / Math.min(hlBest, ltBest) * 100).toFixed(3)
                    : "?";
                  liqData.set(s.symbol, { hlDepth: Math.round(hlDepth), ltDepth: Math.round(ltDepth), gap });
                } catch { /* skip */ }
              }));
            }

            for (const s of filtered) {
              const direction = `${exAbbr(s.shortExch)}>${exAbbr(s.longExch)}`;
              const spreadColor = Math.abs(s.spread) >= 50 ? chalk.green.bold
                : Math.abs(s.spread) >= 30 ? chalk.green
                : chalk.yellow;

              const rates: string[] = [];
              if (s.pacRate) rates.push(`PAC:${(s.pacRate * 100).toFixed(4)}%`);
              if (s.hlRate) rates.push(`HL:${(s.hlRate * 100).toFixed(4)}%`);
              if (s.ltRate) rates.push(`LT:${(s.ltRate * 100).toFixed(4)}%`);

              let liqInfo = "";
              const ld = liqData.get(s.symbol);
              if (ld) {
                liqInfo = chalk.gray(` | depth: HL $${ld.hlDepth.toLocaleString()} LT $${ld.ltDepth.toLocaleString()} gap:${ld.gap}%`);
              }

              console.log(
                `  ${chalk.white.bold(s.symbol.padEnd(8))} ` +
                `${spreadColor(`${Math.abs(s.spread).toFixed(1)}%`.padEnd(8))} ` +
                `${direction.padEnd(7)} ` +
                rates.join(" ") +
                liqInfo
              );
            }
            console.log();
          }
        } catch (err) {
          console.log(chalk.red(`  ${ts} Error: ${err instanceof Error ? err.message : err}\n`));
        }

        await new Promise(r => setTimeout(r, intervalSec * 1000));
      }
    });

  // ── arb dex-monitor ── (live HIP-3 cross-dex monitoring)

  arb
    .command("dex-monitor")
    .description("Live-monitor HIP-3 cross-dex funding arb opportunities")
    .option("--min <pct>", "Min annual spread to show", "10")
    .option("--interval <sec>", "Refresh interval in seconds", "60")
    .option("--top <n>", "Show top N opportunities", "20")
    .option("--include-native", "Include native HL perps", true)
    .option("--no-include-native", "Exclude native HL perps")
    .action(async (opts: { min: string; interval: string; top: string; includeNative: boolean }) => {
      const minSpread = parseFloat(opts.min);
      const intervalSec = parseInt(opts.interval);
      const topN = parseInt(opts.top);
      let cycle = 0;

      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  HIP-3 Cross-Dex Arb Monitor"));
        console.log(chalk.gray(`  Min spread: ${minSpread}% | Refresh: ${intervalSec}s | Top: ${topN}`));
        console.log(chalk.gray(`  Native HL: ${opts.includeNative ? "ON" : "OFF"}`));
        console.log(chalk.gray(`  Press Ctrl+C to stop\n`));
      }

      while (true) {
        cycle++;
        const ts = new Date().toLocaleTimeString();

        try {
          const pairs = await scanDexArb({
            minAnnualSpread: minSpread,
            includeNative: opts.includeNative,
          });
          const shown = pairs.slice(0, topN);

          // Clear previous output
          if (cycle > 1) {
            const linesToClear = shown.length + 4;
            process.stdout.write(`\x1b[${linesToClear}A\x1b[J`);
          }

          console.log(chalk.gray(`  ${ts} — Cycle ${cycle} | ${shown.length}/${pairs.length} opportunities >= ${minSpread}%\n`));

          if (shown.length === 0) {
            console.log(chalk.gray(`  No opportunities found.\n`));
          } else {
            for (const p of shown) {
              const spreadColor = p.annualSpread >= 50 ? chalk.green.bold
                : p.annualSpread >= 20 ? chalk.green : chalk.yellow;
              const viabilityColor = p.viability === "A" ? chalk.green.bold
                : p.viability === "B" ? chalk.green
                : p.viability === "C" ? chalk.yellow
                : chalk.red;
              const longFund = (p.long.fundingRate * 100).toFixed(4);
              const shortFund = (p.short.fundingRate * 100).toFixed(4);
              const fmtOi = p.minOiUsd >= 1_000_000 ? `$${(p.minOiUsd / 1_000_000).toFixed(1)}M`
                : p.minOiUsd >= 1_000 ? `$${(p.minOiUsd / 1_000).toFixed(0)}K`
                : `$${p.minOiUsd.toFixed(0)}`;
              console.log(
                `  ${chalk.white.bold(p.underlying.padEnd(10))} ` +
                `${spreadColor(`${p.annualSpread.toFixed(1)}%`.padEnd(8))} ` +
                `${viabilityColor(p.viability)} ` +
                `L:${p.long.dex}(${longFund}%) ` +
                `S:${p.short.dex}(${shortFund}%) ` +
                `$${formatUsd(p.long.markPrice)} ` +
                chalk.gray(`gap:${p.priceGapPct.toFixed(3)}%`) + ` ` +
                viabilityColor(`OI:${fmtOi}`)
              );
            }
            console.log();
          }
        } catch (err) {
          console.log(chalk.red(`  ${ts} Error: ${err instanceof Error ? err.message : err}\n`));
        }

        await new Promise(r => setTimeout(r, intervalSec * 1000));
      }
    });
  // ── arb dex-auto ── (HIP-3 cross-dex auto arb)

  if (getHLAdapterForDex) {
    arb
      .command("dex-auto")
      .description("Auto-execute HIP-3 cross-dex funding arb (long low-funding, short high-funding)")
      .option("--min-spread <pct>", "Min annual spread to enter (%)", "30")
      .option("--close-spread <pct>", "Close when spread drops below (%)", "5")
      .option("--size <usd>", "Position size per leg ($)", "100")
      .option("--max-positions <n>", "Max simultaneous arb positions", "5")
      .option("--min-oi <usd>", "Min OI (USD) to enter", "50000")
      .option("--min-grade <grade>", "Min viability grade: A, B, C, D", "C")
      .option("--interval <seconds>", "Check interval", "120")
      .option("--dry-run", "Simulate without executing trades")
      .action(async (opts: {
        minSpread: string; closeSpread: string; size: string;
        maxPositions: string; minOi: string; minGrade: string;
        interval: string; dryRun?: boolean;
      }) => {
        const minSpread = parseFloat(opts.minSpread);
        const closeSpread = parseFloat(opts.closeSpread);
        const sizeUsd = parseFloat(opts.size);
        const maxPositions = parseInt(opts.maxPositions);
        const minOi = parseFloat(opts.minOi);
        const gradeOrder = { A: 0, B: 1, C: 2, D: 3 } as Record<string, number>;
        const minGradeIdx = gradeOrder[opts.minGrade.toUpperCase()] ?? 2;
        const intervalMs = parseInt(opts.interval) * 1000;
        // Check both subcommand option and global/argv (Commander may route --dry-run to parent)
        const dryRun = !!opts.dryRun || process.argv.includes("--dry-run");

        interface DexArbPosition {
          underlying: string;
          longDex: string;
          longSymbol: string;
          shortDex: string;
          shortSymbol: string;
          size: string;
          entrySpread: number;
          entryTime: string;
          longPrice: number;
          shortPrice: number;
        }

        const openPositions: DexArbPosition[] = [];

        if (!isJson()) {
          console.log(chalk.cyan.bold("\n  HIP-3 Cross-Dex Arb Bot\n"));
          console.log(`  Mode:          ${dryRun ? chalk.yellow("DRY RUN") : chalk.green("LIVE")}`);
          console.log(`  Enter spread:  >= ${minSpread}% annual`);
          console.log(`  Close spread:  <= ${closeSpread}% annual`);
          console.log(`  Size per leg:  $${sizeUsd}`);
          console.log(`  Max positions: ${maxPositions}`);
          console.log(`  Min OI:        $${formatUsd(minOi)}`);
          console.log(`  Min grade:     ${opts.minGrade.toUpperCase()}`);
          console.log(`  Interval:      ${opts.interval}s`);
          console.log(chalk.gray("\n  Monitoring... (Ctrl+C to stop)\n"));
        }

        const cycle = async () => {
          try {
            const pairs = await scanDexArb({
              minAnnualSpread: 0, // get all, filter ourselves
              includeNative: true,
            });

            const now = new Date().toLocaleTimeString();

            // Check close conditions
            for (let i = openPositions.length - 1; i >= 0; i--) {
              const pos = openPositions[i];
              // Find current pair for this position
              const current = pairs.find(p =>
                p.underlying === pos.underlying &&
                ((p.long.dex === pos.longDex && p.short.dex === pos.shortDex) ||
                 (p.long.dex === pos.shortDex && p.short.dex === pos.longDex))
              );

              const currentSpread = current?.annualSpread ?? 0;

              if (currentSpread <= closeSpread || !current) {
                const reason = !current ? "pair disappeared" : `spread ${currentSpread.toFixed(1)}% <= ${closeSpread}%`;
                if (!isJson()) console.log(chalk.yellow(`  ${now} CLOSE ${pos.underlying} — ${reason}`));

                if (!dryRun) {
                  try {
                    const longAdapter = await getHLAdapterForDex!(pos.longDex);
                    const shortAdapter = await getHLAdapterForDex!(pos.shortDex);
                    await Promise.all([
                      longAdapter.marketOrder(pos.longSymbol, "sell", pos.size),
                      shortAdapter.marketOrder(pos.shortSymbol, "buy", pos.size),
                    ]);
                    logExecution({
                      type: "arb_close", exchange: `${pos.longDex}+${pos.shortDex}`,
                      symbol: pos.underlying, side: "close", size: pos.size,
                      status: "success", dryRun: false,
                      meta: { longDex: pos.longDex, shortDex: pos.shortDex, reason, longSymbol: pos.longSymbol, shortSymbol: pos.shortSymbol },
                    });
                    if (!isJson()) console.log(chalk.green(`  ${now} CLOSED ${pos.underlying} — both legs`));
                  } catch (err) {
                    logExecution({
                      type: "arb_close", exchange: `${pos.longDex}+${pos.shortDex}`,
                      symbol: pos.underlying, side: "close", size: pos.size,
                      status: "failed", dryRun: false,
                      error: err instanceof Error ? err.message : String(err),
                      meta: { longDex: pos.longDex, shortDex: pos.shortDex },
                    });
                    if (!isJson()) console.error(chalk.red(`  ${now} CLOSE FAILED ${pos.underlying}: ${err instanceof Error ? err.message : err}`));
                  }
                }

                openPositions.splice(i, 1);
              }
            }

            // Check entry conditions
            if (openPositions.length < maxPositions) {
              for (const pair of pairs) {
                if (openPositions.some(p => p.underlying === pair.underlying)) continue;
                if (openPositions.length >= maxPositions) break;
                if (pair.annualSpread < minSpread) continue;
                if (pair.minOiUsd < minOi) continue;
                if (gradeOrder[pair.viability] > minGradeIdx) continue;

                // Calculate size in asset units
                const avgPrice = (pair.long.markPrice + pair.short.markPrice) / 2;
                if (avgPrice <= 0) continue;
                const szDecimals = Math.min(pair.long.szDecimals, pair.short.szDecimals);
                const rawSize = sizeUsd / avgPrice;
                const size = rawSize.toFixed(szDecimals);

                if (!isJson()) {
                  console.log(chalk.green(
                    `  ${now} ENTER ${pair.underlying} — spread ${pair.annualSpread.toFixed(1)}% grade:${pair.viability} OI:$${formatUsd(pair.minOiUsd)}` +
                    `\n         Long ${pair.long.dex}:${pair.long.base} (${(pair.long.fundingRate * 100).toFixed(4)}%)` +
                    ` | Short ${pair.short.dex}:${pair.short.base} (${(pair.short.fundingRate * 100).toFixed(4)}%)` +
                    ` | ${size} units @ $${avgPrice.toFixed(2)}`
                  ));
                }

                if (!dryRun) {
                  try {
                    const longAdapter = await getHLAdapterForDex!(pair.long.dex);
                    const shortAdapter = await getHLAdapterForDex!(pair.short.dex);
                    await Promise.all([
                      longAdapter.marketOrder(pair.long.raw, "buy", size),
                      shortAdapter.marketOrder(pair.short.raw, "sell", size),
                    ]);
                    logExecution({
                      type: "arb_entry", exchange: `${pair.long.dex}+${pair.short.dex}`,
                      symbol: pair.underlying, side: "entry", size,
                      status: "success", dryRun: false,
                      meta: { longDex: pair.long.dex, shortDex: pair.short.dex, spread: pair.annualSpread, viability: pair.viability, avgPrice },
                    });
                    if (!isJson()) console.log(chalk.green(`  ${now} FILLED ${pair.underlying} — both legs`));
                  } catch (err) {
                    logExecution({
                      type: "arb_entry", exchange: `${pair.long.dex}+${pair.short.dex}`,
                      symbol: pair.underlying, side: "entry", size,
                      status: "failed", dryRun: false,
                      error: err instanceof Error ? err.message : String(err),
                      meta: { longDex: pair.long.dex, shortDex: pair.short.dex, spread: pair.annualSpread },
                    });
                    if (!isJson()) console.error(chalk.red(`  ${now} ENTRY FAILED ${pair.underlying}: ${err instanceof Error ? err.message : err}`));
                    continue;
                  }
                }

                openPositions.push({
                  underlying: pair.underlying,
                  longDex: pair.long.dex,
                  longSymbol: pair.long.raw,
                  shortDex: pair.short.dex,
                  shortSymbol: pair.short.raw,
                  size,
                  entrySpread: pair.annualSpread,
                  entryTime: new Date().toISOString(),
                  longPrice: pair.long.markPrice,
                  shortPrice: pair.short.markPrice,
                });
              }
            }

            // Status
            if (isJson()) {
              printJson(jsonOk({
                timestamp: new Date().toISOString(),
                openPositions,
                availablePairs: pairs.filter(p => p.annualSpread >= minSpread && p.minOiUsd >= minOi).length,
              }));
            } else if (openPositions.length > 0) {
              console.log(chalk.gray(
                `  ${now} Positions: ${openPositions.length}/${maxPositions} — ` +
                openPositions.map(p => `${p.underlying}(${p.entrySpread.toFixed(0)}%)`).join(", ")
              ));
            } else {
              console.log(chalk.gray(`  ${now} No positions. ${pairs.filter(p => p.annualSpread >= minSpread).length} pairs above ${minSpread}%`));
            }
          } catch (err) {
            if (!isJson()) console.error(chalk.gray(`  Error: ${err instanceof Error ? err.message : String(err)}`));
          }
        };

        await cycle();
        setInterval(cycle, intervalMs);
        await new Promise(() => {}); // keep alive
      });
  }
}

// ── Orderbook helpers for monitor ──

async function fetchHLOrderbook(symbol: string): Promise<[number, number][]> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: symbol }),
  });
  const json = await res.json();
  const bids = json.levels?.[0] ?? [];
  return bids.slice(0, 10).map((l: Record<string, string>) => [Number(l.px), Number(l.sz)] as [number, number]);
}

async function fetchLighterOrderbook(symbol: string): Promise<[number, number][]> {
  const detailsRes = await fetch("https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails");
  const details = await detailsRes.json();
  const m = ((details as Record<string, unknown>).order_book_details as Array<Record<string, unknown>> ?? [])
    .find(d => d.symbol === symbol);
  if (!m) return [];
  const marketId = Number(m.market_id);
  const obRes = await fetch(`https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=${marketId}&limit=10`);
  const ob = await obRes.json();
  const bids = (ob as Record<string, unknown>).bids as Array<Record<string, string>> ?? [];
  return bids.map(l => [Number(l.price), Number(l.remaining_base_amount)] as [number, number]);
}
