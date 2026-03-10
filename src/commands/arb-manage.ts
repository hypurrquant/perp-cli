import { Command } from "commander";
import chalk from "chalk";
import { makeTable, formatUsd, formatPnl, printJson, jsonOk } from "../utils.js";
import type { ExchangeAdapter, ExchangePosition } from "../exchanges/interface.js";
import { readExecutionLog, logExecution, type ExecutionRecord } from "../execution-log.js";
import { toHourlyRate, computeAnnualSpread } from "../funding.js";

// ── Types ──

interface ArbPairPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longPosition: {
    side: "long";
    size: number;
    entryPrice: number;
    markPrice: number;
    unrealizedPnl: number;
    leverage: number;
    notionalUsd: number;
  };
  shortPosition: {
    side: "short";
    size: number;
    entryPrice: number;
    markPrice: number;
    unrealizedPnl: number;
    leverage: number;
    notionalUsd: number;
  };
  entrySpread: number | null;
  currentSpread: number | null;
  holdDuration: string | null;
  holdDurationMs: number | null;
  estimatedFundingIncome: number;
  estimatedFees: number;
  unrealizedPnl: number;
  netPnl: number;
}

interface ArbHistoryTrade {
  symbol: string;
  exchanges: string;
  entryDate: string;
  exitDate: string | null;
  holdDuration: string;
  holdDurationMs: number;
  entrySpread: number | null;
  exitSpread: number | null;
  size: string;
  grossReturn: number;
  fees: number;
  fundingIncome: number;
  netReturn: number;
  status: "completed" | "open" | "failed";
}

// ── Helpers ──

const EXCHANGES = ["hyperliquid", "lighter", "pacifica"];
const TAKER_FEE = 0.00035; // ~0.035% typical taker fee

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return `${days}d ${remainingHours}h`;
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(ms / (1000 * 60));
  return `${minutes}m`;
}

async function fetchFundingRatesMap(): Promise<Map<string, { exchange: string; rate: number; markPrice: number }[]>> {
  const rateMap = new Map<string, { exchange: string; rate: number; markPrice: number }[]>();

  const [pacRes, hlRes, ltDetailsRes, ltFundingRes] = await Promise.all([
    fetch("https://api.pacifica.fi/api/v1/info/prices").then(r => r.json()).catch(() => null),
    fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    }).then(r => r.json()).catch(() => null),
    fetch("https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails").then(r => r.json()).catch(() => null),
    fetch("https://mainnet.zklighter.elliot.ai/api/v1/funding-rates").then(r => r.json()).catch(() => null),
  ]);

  // Pacifica
  if (Array.isArray(pacRes?.data ?? pacRes)) {
    for (const p of (pacRes.data ?? pacRes) as Record<string, unknown>[]) {
      const sym = String(p.symbol ?? "");
      if (!sym) continue;
      if (!rateMap.has(sym)) rateMap.set(sym, []);
      rateMap.get(sym)!.push({ exchange: "pacifica", rate: Number(p.funding ?? 0), markPrice: Number(p.mark ?? 0) });
    }
  }

  // Hyperliquid
  if (hlRes && Array.isArray(hlRes)) {
    const universe = hlRes[0]?.universe ?? [];
    const ctxs = hlRes[1] ?? [];
    universe.forEach((a: Record<string, unknown>, i: number) => {
      const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
      const sym = String(a.name ?? "");
      if (!sym) return;
      if (!rateMap.has(sym)) rateMap.set(sym, []);
      rateMap.get(sym)!.push({ exchange: "hyperliquid", rate: Number(ctx.funding ?? 0), markPrice: Number(ctx.markPx ?? 0) });
    });
  }

  // Lighter
  if (ltFundingRes) {
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
    const seen = new Set<string>();
    for (const fr of fundingList as Array<Record<string, unknown>>) {
      const sym = String(fr.symbol ?? "") || idToSym.get(Number(fr.market_id)) || "";
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      if (!rateMap.has(sym)) rateMap.set(sym, []);
      const mp = Number(fr.mark_price ?? 0) || idToPrice.get(Number(fr.market_id)) || 0;
      rateMap.get(sym)!.push({ exchange: "lighter", rate: Number(fr.rate ?? fr.funding_rate ?? 0), markPrice: mp });
    }
  }

  return rateMap;
}

function findArbEntryForSymbol(symbol: string): ExecutionRecord | null {
  const entries = readExecutionLog({ type: "arb_entry", symbol });
  // Return the most recent successful entry
  const successful = entries.filter(e => e.status === "success");
  return successful.length > 0 ? successful[0] : null;
}

function getCurrentSpreadForSymbol(
  symbol: string,
  longExchange: string,
  shortExchange: string,
  rateMap: Map<string, { exchange: string; rate: number; markPrice: number }[]>,
): number | null {
  const rates = rateMap.get(symbol.toUpperCase());
  if (!rates) return null;

  const longRate = rates.find(r => r.exchange === longExchange);
  const shortRate = rates.find(r => r.exchange === shortExchange);
  if (!longRate || !shortRate) return null;

  return computeAnnualSpread(shortRate.rate, shortRate.exchange, longRate.rate, longRate.exchange);
}

// ── Registration ──

export function registerArbManageCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const arb = program.commands.find(c => c.name() === "arb");
  if (!arb) return;

  // ── arb status ──

  arb
    .command("status")
    .description("Show open arb positions with PnL breakdown")
    .action(async () => {
      if (!isJson()) console.log(chalk.cyan("\n  Checking arb positions across exchanges...\n"));

      // Fetch positions from all exchanges
      const allPositions: { exchange: string; symbol: string; side: "long" | "short"; size: number; entryPrice: number; markPrice: number; unrealizedPnl: number; leverage: number }[] = [];

      for (const exName of EXCHANGES) {
        try {
          const adapter = await getAdapterForExchange(exName);
          const positions = await adapter.getPositions();
          for (const p of positions) {
            allPositions.push({
              exchange: exName,
              symbol: p.symbol.replace("-PERP", "").toUpperCase(),
              side: p.side,
              size: Math.abs(Number(p.size)),
              entryPrice: Number(p.entryPrice),
              markPrice: Number(p.markPrice),
              unrealizedPnl: Number(p.unrealizedPnl),
              leverage: p.leverage,
            });
          }
        } catch {
          // exchange not configured, skip
        }
      }

      // Group by symbol to detect arb pairs
      const bySymbol = new Map<string, typeof allPositions>();
      for (const p of allPositions) {
        if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
        bySymbol.get(p.symbol)!.push(p);
      }

      // Find arb pairs: same symbol, different exchanges, one long + one short
      const arbPairs: ArbPairPosition[] = [];

      // Fetch current funding rates for spread calculation
      let rateMap: Map<string, { exchange: string; rate: number; markPrice: number }[]>;
      try {
        rateMap = await fetchFundingRatesMap();
      } catch {
        rateMap = new Map();
      }

      for (const [symbol, positions] of bySymbol) {
        const longs = positions.filter(p => p.side === "long");
        const shorts = positions.filter(p => p.side === "short");

        // Match longs and shorts on different exchanges
        for (const longPos of longs) {
          for (const shortPos of shorts) {
            if (longPos.exchange === shortPos.exchange) continue;

            // Look up entry info from execution log
            const entryLog = findArbEntryForSymbol(symbol);
            const entrySpread = entryLog?.meta?.spread as number | null ?? null;
            const entryTime = entryLog?.timestamp ?? null;
            const holdDurationMs = entryTime ? Date.now() - new Date(entryTime).getTime() : null;
            const holdDuration = holdDurationMs ? formatDuration(holdDurationMs) : null;

            // Current spread
            const currentSpread = getCurrentSpreadForSymbol(symbol, longPos.exchange, shortPos.exchange, rateMap);

            // Position notional values
            const longNotional = longPos.size * longPos.markPrice;
            const shortNotional = shortPos.size * shortPos.markPrice;
            const avgNotional = (longNotional + shortNotional) / 2;

            // Estimated funding income (from hold time and current spread)
            let estimatedFundingIncome = 0;
            if (holdDurationMs && currentSpread) {
              const holdHours = holdDurationMs / (1000 * 60 * 60);
              // Annual spread % → hourly income on notional
              estimatedFundingIncome = (currentSpread / 100) / (24 * 365) * avgNotional * holdHours;
            }

            // Estimated fees (entry + exit)
            const entryFees = (longPos.size * longPos.entryPrice + shortPos.size * shortPos.entryPrice) * TAKER_FEE;
            const exitFees = (longNotional + shortNotional) * TAKER_FEE;
            const totalFees = entryFees + exitFees;

            // Net PnL
            const totalUpnl = longPos.unrealizedPnl + shortPos.unrealizedPnl;
            const netPnl = totalUpnl + estimatedFundingIncome - totalFees;

            arbPairs.push({
              symbol,
              longExchange: longPos.exchange,
              shortExchange: shortPos.exchange,
              longPosition: {
                side: "long",
                size: longPos.size,
                entryPrice: longPos.entryPrice,
                markPrice: longPos.markPrice,
                unrealizedPnl: longPos.unrealizedPnl,
                leverage: longPos.leverage,
                notionalUsd: longNotional,
              },
              shortPosition: {
                side: "short",
                size: shortPos.size,
                entryPrice: shortPos.entryPrice,
                markPrice: shortPos.markPrice,
                unrealizedPnl: shortPos.unrealizedPnl,
                leverage: shortPos.leverage,
                notionalUsd: shortNotional,
              },
              entrySpread: entrySpread !== null ? Number(entrySpread) : null,
              currentSpread,
              holdDuration,
              holdDurationMs,
              estimatedFundingIncome,
              estimatedFees: totalFees,
              unrealizedPnl: totalUpnl,
              netPnl,
            });
          }
        }
      }

      if (isJson()) {
        return printJson(jsonOk(arbPairs));
      }

      if (arbPairs.length === 0) {
        console.log(chalk.gray("  No open arb positions found.\n"));
        return;
      }

      console.log(chalk.cyan.bold("  Open Arb Positions\n"));

      const rows = arbPairs.map(p => {
        const spreadStr = p.currentSpread !== null ? `${p.currentSpread.toFixed(1)}%` : "-";
        const entrySpreadStr = p.entrySpread !== null ? `${p.entrySpread.toFixed(1)}%` : "-";
        const holdStr = p.holdDuration ?? "-";
        const avgNotional = (p.longPosition.notionalUsd + p.shortPosition.notionalUsd) / 2;

        return [
          chalk.white.bold(p.symbol),
          chalk.green(p.longExchange),
          chalk.red(p.shortExchange),
          `$${formatUsd(avgNotional)}`,
          `$${p.longPosition.entryPrice.toFixed(2)} / $${p.shortPosition.entryPrice.toFixed(2)}`,
          `$${p.longPosition.markPrice.toFixed(2)}`,
          formatPnl(p.unrealizedPnl),
          chalk.yellow(`$${p.estimatedFundingIncome.toFixed(4)}`),
          `${entrySpreadStr} -> ${spreadStr}`,
          holdStr,
          formatPnl(p.netPnl),
        ];
      });

      console.log(makeTable(
        ["Symbol", "Long", "Short", "Size", "Entry", "Mark", "uPnL", "Funding", "Spread", "Hold", "Net PnL"],
        rows,
      ));

      // Summary
      const totalUpnl = arbPairs.reduce((s, p) => s + p.unrealizedPnl, 0);
      const totalFunding = arbPairs.reduce((s, p) => s + p.estimatedFundingIncome, 0);
      const totalFees = arbPairs.reduce((s, p) => s + p.estimatedFees, 0);
      const totalNet = arbPairs.reduce((s, p) => s + p.netPnl, 0);

      console.log(chalk.white.bold("\n  Summary"));
      console.log(`    Positions:       ${arbPairs.length}`);
      console.log(`    Unrealized PnL:  ${formatPnl(totalUpnl)}`);
      console.log(`    Est. Funding:    ${chalk.yellow(`$${totalFunding.toFixed(4)}`)}`);
      console.log(`    Est. Fees:       ${chalk.red(`-$${totalFees.toFixed(4)}`)}`);
      console.log(`    Net PnL:         ${formatPnl(totalNet)}`);
      console.log(chalk.gray(`    (Fees assume ${(TAKER_FEE * 100).toFixed(3)}% taker for entry + exit.)\n`));
    });

  // ── arb close ──

  arb
    .command("close <symbol>")
    .description("Manually close an arb position on both exchanges")
    .option("--dry-run", "Show what would happen without executing")
    .action(async (symbol: string, opts: { dryRun?: boolean }) => {
      const sym = symbol.toUpperCase();
      const dryRun = !!opts.dryRun || process.argv.includes("--dry-run");

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Closing arb position for ${sym}...\n`));
        if (dryRun) console.log(chalk.yellow("  Mode: DRY RUN (no trades will be executed)\n"));
      }

      // Find positions for this symbol across all exchanges
      const allPositions: { exchange: string; symbol: string; rawSymbol: string; side: "long" | "short"; size: number; entryPrice: number; markPrice: number; unrealizedPnl: number }[] = [];

      for (const exName of EXCHANGES) {
        try {
          const adapter = await getAdapterForExchange(exName);
          const positions = await adapter.getPositions();
          for (const p of positions) {
            const normalized = p.symbol.replace("-PERP", "").toUpperCase();
            if (normalized === sym) {
              allPositions.push({
                exchange: exName,
                symbol: normalized,
                rawSymbol: p.symbol,
                side: p.side,
                size: Math.abs(Number(p.size)),
                entryPrice: Number(p.entryPrice),
                markPrice: Number(p.markPrice),
                unrealizedPnl: Number(p.unrealizedPnl),
              });
            }
          }
        } catch {
          // exchange not configured, skip
        }
      }

      // Find the arb pair (long on one exchange, short on another)
      const longPos = allPositions.find(p => p.side === "long");
      const shortPos = allPositions.find(p => p.side === "short" && p.exchange !== longPos?.exchange);

      if (!longPos || !shortPos) {
        const msg = `No arb pair found for ${sym}. Need long and short on different exchanges.`;
        if (isJson()) return printJson(jsonOk({ error: msg, positions: allPositions }));
        console.log(chalk.red(`  ${msg}`));
        if (allPositions.length > 0) {
          console.log(chalk.gray(`  Found ${allPositions.length} position(s) but no matching arb pair:`));
          for (const p of allPositions) {
            console.log(chalk.gray(`    ${p.side.toUpperCase()} ${p.exchange} size=${p.size}`));
          }
        }
        console.log();
        return;
      }

      // Calculate estimated PnL
      const totalUpnl = longPos.unrealizedPnl + shortPos.unrealizedPnl;
      const entryFees = (longPos.size * longPos.entryPrice + shortPos.size * shortPos.entryPrice) * TAKER_FEE;
      const exitFees = (longPos.size * longPos.markPrice + shortPos.size * shortPos.markPrice) * TAKER_FEE;
      const totalFees = entryFees + exitFees;
      const netPnl = totalUpnl - totalFees;

      if (!isJson()) {
        console.log(chalk.white.bold(`  ${sym} Arb Position`));
        console.log(`    Long:  ${longPos.exchange} | size: ${longPos.size} | entry: $${longPos.entryPrice.toFixed(4)} | mark: $${longPos.markPrice.toFixed(4)} | uPnL: ${formatPnl(longPos.unrealizedPnl)}`);
        console.log(`    Short: ${shortPos.exchange} | size: ${shortPos.size} | entry: $${shortPos.entryPrice.toFixed(4)} | mark: $${shortPos.markPrice.toFixed(4)} | uPnL: ${formatPnl(shortPos.unrealizedPnl)}`);
        console.log();
        console.log(`    Total uPnL:  ${formatPnl(totalUpnl)}`);
        console.log(`    Est. Fees:   ${chalk.red(`-$${totalFees.toFixed(4)}`)}`);
        console.log(`    Net PnL:     ${formatPnl(netPnl)}`);
        console.log();
      }

      if (dryRun) {
        const result = {
          dryRun: true,
          symbol: sym,
          longExchange: longPos.exchange,
          shortExchange: shortPos.exchange,
          longSize: longPos.size,
          shortSize: shortPos.size,
          unrealizedPnl: totalUpnl,
          estimatedFees: totalFees,
          netPnl,
          actions: [
            { exchange: longPos.exchange, action: "sell", symbol: longPos.rawSymbol, size: String(longPos.size) },
            { exchange: shortPos.exchange, action: "buy", symbol: shortPos.rawSymbol, size: String(shortPos.size) },
          ],
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.yellow("  Would execute:"));
        console.log(chalk.yellow(`    SELL ${longPos.size} ${longPos.rawSymbol} on ${longPos.exchange} (close long)`));
        console.log(chalk.yellow(`    BUY ${shortPos.size} ${shortPos.rawSymbol} on ${shortPos.exchange} (close short)\n`));
        return;
      }

      // Execute close on both exchanges
      const results: { exchange: string; action: string; status: string; error?: string }[] = [];

      // Close both legs concurrently
      const closePromises = [
        (async () => {
          try {
            const adapter = await getAdapterForExchange(longPos.exchange);
            await adapter.marketOrder(longPos.rawSymbol, "sell", String(longPos.size));
            results.push({ exchange: longPos.exchange, action: "sell (close long)", status: "success" });
            if (!isJson()) console.log(chalk.green(`  Closed long on ${longPos.exchange}: SELL ${longPos.size} ${sym}`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ exchange: longPos.exchange, action: "sell (close long)", status: "failed", error: msg });
            if (!isJson()) console.error(chalk.red(`  Failed to close long on ${longPos.exchange}: ${msg}`));
          }
        })(),
        (async () => {
          try {
            const adapter = await getAdapterForExchange(shortPos.exchange);
            await adapter.marketOrder(shortPos.rawSymbol, "buy", String(shortPos.size));
            results.push({ exchange: shortPos.exchange, action: "buy (close short)", status: "success" });
            if (!isJson()) console.log(chalk.green(`  Closed short on ${shortPos.exchange}: BUY ${shortPos.size} ${sym}`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ exchange: shortPos.exchange, action: "buy (close short)", status: "failed", error: msg });
            if (!isJson()) console.error(chalk.red(`  Failed to close short on ${shortPos.exchange}: ${msg}`));
          }
        })(),
      ];

      await Promise.all(closePromises);

      const allSuccess = results.every(r => r.status === "success");
      const anySuccess = results.some(r => r.status === "success");

      // Log to execution log
      logExecution({
        type: "arb_close",
        exchange: `${longPos.exchange}+${shortPos.exchange}`,
        symbol: sym,
        side: "close",
        size: String(Math.max(longPos.size, shortPos.size)),
        status: allSuccess ? "success" : "failed",
        dryRun: false,
        error: allSuccess ? undefined : results.filter(r => r.error).map(r => `${r.exchange}: ${r.error}`).join("; "),
        meta: {
          longExchange: longPos.exchange,
          shortExchange: shortPos.exchange,
          unrealizedPnl: totalUpnl,
          estimatedFees: totalFees,
          netPnl,
          results,
        },
      });

      if (isJson()) {
        return printJson(jsonOk({
          symbol: sym,
          longExchange: longPos.exchange,
          shortExchange: shortPos.exchange,
          status: allSuccess ? "success" : anySuccess ? "partial" : "failed",
          unrealizedPnl: totalUpnl,
          estimatedFees: totalFees,
          netPnl,
          results,
        }));
      }

      if (!allSuccess && anySuccess) {
        console.log(chalk.yellow(`\n  Warning: Partial close — one leg failed. Manual intervention may be needed.\n`));
      } else if (allSuccess) {
        console.log(chalk.green(`\n  Arb position ${sym} closed successfully.\n`));
      } else {
        console.log(chalk.red(`\n  Failed to close arb position ${sym}. Both legs failed.\n`));
      }
    });

  // ── arb history ──

  arb
    .command("history")
    .description("Past arb trade performance and statistics")
    .option("--period <days>", "Number of days to look back", "30")
    .action(async (opts: { period: string }) => {
      const periodDays = parseInt(opts.period);
      const sinceDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

      if (!isJson()) console.log(chalk.cyan(`\n  Arb trade history (last ${periodDays} days)\n`));

      // Read arb-related execution log entries
      const arbEntries = readExecutionLog({ since: sinceDate })
        .filter(r => r.type === "arb_entry" || r.type === "arb_close");

      if (arbEntries.length === 0) {
        const result = {
          trades: [],
          summary: {
            totalTrades: 0,
            completedTrades: 0,
            winRate: 0,
            avgHoldTime: null,
            totalNetPnl: 0,
            bestTrade: null,
            worstTrade: null,
          },
          period: periodDays,
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.gray("  No arb trades found in this period.\n"));
        return;
      }

      // Group entries by symbol to match entry/exit pairs
      const entryMap = new Map<string, ExecutionRecord[]>();
      const closeMap = new Map<string, ExecutionRecord[]>();

      for (const entry of arbEntries) {
        const key = entry.symbol.toUpperCase();
        if (entry.type === "arb_entry") {
          if (!entryMap.has(key)) entryMap.set(key, []);
          entryMap.get(key)!.push(entry);
        } else {
          if (!closeMap.has(key)) closeMap.set(key, []);
          closeMap.get(key)!.push(entry);
        }
      }

      // Build trade history by pairing entries with closes
      const trades: ArbHistoryTrade[] = [];

      for (const [symbol, entries] of entryMap) {
        const closes = closeMap.get(symbol) ?? [];
        // Sort entries oldest first for matching
        entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        closes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          // Find matching close (first close after this entry)
          const entryTime = new Date(entry.timestamp).getTime();
          const matchingClose = closes.find(c => new Date(c.timestamp).getTime() > entryTime);

          const exchanges = entry.exchange;
          const entrySpread = entry.meta?.spread as number | null ?? null;

          if (matchingClose) {
            // Remove matched close to avoid double-matching
            const closeIdx = closes.indexOf(matchingClose);
            closes.splice(closeIdx, 1);

            const closeTime = new Date(matchingClose.timestamp).getTime();
            const holdMs = closeTime - entryTime;
            const holdHours = holdMs / (1000 * 60 * 60);

            // Estimate PnL from metadata
            const exitSpread = matchingClose.meta?.currentSpread as number | null ?? null;
            const netPnl = matchingClose.meta?.netPnl as number | null ?? null;
            const upnl = matchingClose.meta?.unrealizedPnl as number | null ?? null;

            // Estimate funding income based on hold time and entry spread
            const avgSpread = entrySpread ? entrySpread : 0;
            const sizeUsd = entry.meta?.markPrice
              ? Number(entry.size) * Number(entry.meta.markPrice)
              : 0;
            const estimatedFunding = sizeUsd > 0
              ? (avgSpread / 100) / (24 * 365) * sizeUsd * holdHours
              : 0;

            // Fees estimate
            const fees = sizeUsd * TAKER_FEE * 2 * 2; // entry + exit, both legs

            trades.push({
              symbol,
              exchanges,
              entryDate: entry.timestamp,
              exitDate: matchingClose.timestamp,
              holdDuration: formatDuration(holdMs),
              holdDurationMs: holdMs,
              entrySpread,
              exitSpread,
              size: entry.size,
              grossReturn: upnl !== null ? Number(upnl) : 0,
              fees,
              fundingIncome: estimatedFunding,
              netReturn: netPnl !== null ? Number(netPnl) : (upnl !== null ? Number(upnl) + estimatedFunding - fees : 0),
              status: matchingClose.status === "success" ? "completed" : "failed",
            });
          } else {
            // Open trade (no matching close)
            const holdMs = Date.now() - entryTime;
            trades.push({
              symbol,
              exchanges,
              entryDate: entry.timestamp,
              exitDate: null,
              holdDuration: formatDuration(holdMs),
              holdDurationMs: holdMs,
              entrySpread,
              exitSpread: null,
              size: entry.size,
              grossReturn: 0,
              fees: 0,
              fundingIncome: 0,
              netReturn: 0,
              status: "open",
            });
          }
        }
      }

      // Sort by entry date, newest first
      trades.sort((a, b) => new Date(b.entryDate).getTime() - new Date(a.entryDate).getTime());

      // Compute summary statistics
      const completedTrades = trades.filter(t => t.status === "completed");
      const winners = completedTrades.filter(t => t.netReturn > 0);
      const totalNetPnl = completedTrades.reduce((s, t) => s + t.netReturn, 0);
      const totalFunding = completedTrades.reduce((s, t) => s + t.fundingIncome, 0);
      const totalFees = completedTrades.reduce((s, t) => s + t.fees, 0);
      const avgHoldMs = completedTrades.length > 0
        ? completedTrades.reduce((s, t) => s + t.holdDurationMs, 0) / completedTrades.length
        : 0;
      const bestTrade = completedTrades.length > 0
        ? completedTrades.reduce((best, t) => t.netReturn > best.netReturn ? t : best)
        : null;
      const worstTrade = completedTrades.length > 0
        ? completedTrades.reduce((worst, t) => t.netReturn < worst.netReturn ? t : worst)
        : null;

      const summary = {
        totalTrades: trades.length,
        completedTrades: completedTrades.length,
        openTrades: trades.filter(t => t.status === "open").length,
        failedTrades: trades.filter(t => t.status === "failed").length,
        winRate: completedTrades.length > 0 ? (winners.length / completedTrades.length) * 100 : 0,
        avgHoldTime: avgHoldMs > 0 ? formatDuration(avgHoldMs) : null,
        avgHoldTimeMs: avgHoldMs,
        totalNetPnl,
        totalFundingIncome: totalFunding,
        totalFees,
        bestTrade: bestTrade ? { symbol: bestTrade.symbol, netReturn: bestTrade.netReturn } : null,
        worstTrade: worstTrade ? { symbol: worstTrade.symbol, netReturn: worstTrade.netReturn } : null,
      };

      if (isJson()) {
        return printJson(jsonOk({ trades, summary, period: periodDays }));
      }

      // Display trade history table
      if (trades.length > 0) {
        console.log(chalk.cyan.bold("  Trade History\n"));

        const rows = trades.map(t => {
          const statusIcon = t.status === "completed" ? chalk.green("DONE")
            : t.status === "open" ? chalk.yellow("OPEN")
            : chalk.red("FAIL");
          const entryDate = new Date(t.entryDate).toLocaleDateString();
          const exitDate = t.exitDate ? new Date(t.exitDate).toLocaleDateString() : "-";

          return [
            chalk.white.bold(t.symbol),
            t.exchanges,
            entryDate,
            exitDate,
            t.holdDuration,
            t.entrySpread !== null ? `${t.entrySpread.toFixed(1)}%` : "-",
            t.size,
            formatPnl(t.grossReturn),
            chalk.yellow(`$${t.fundingIncome.toFixed(4)}`),
            chalk.red(`-$${t.fees.toFixed(4)}`),
            formatPnl(t.netReturn),
            statusIcon,
          ];
        });

        console.log(makeTable(
          ["Symbol", "Exchanges", "Entry", "Exit", "Hold", "Spread", "Size", "Gross", "Funding", "Fees", "Net", "Status"],
          rows,
        ));
      }

      // Summary
      console.log(chalk.cyan.bold("\n  Summary Statistics\n"));
      console.log(`    Period:          Last ${periodDays} days`);
      console.log(`    Total trades:    ${summary.totalTrades} (${summary.completedTrades} completed, ${summary.openTrades} open, ${summary.failedTrades} failed)`);
      console.log(`    Win rate:        ${summary.winRate.toFixed(1)}%`);
      console.log(`    Avg hold time:   ${summary.avgHoldTime ?? "-"}`);
      console.log(`    Total net PnL:   ${formatPnl(summary.totalNetPnl)}`);
      console.log(`    Total funding:   ${chalk.yellow(`$${summary.totalFundingIncome.toFixed(4)}`)}`);
      console.log(`    Total fees:      ${chalk.red(`-$${summary.totalFees.toFixed(4)}`)}`);
      if (summary.bestTrade) {
        console.log(`    Best trade:      ${summary.bestTrade.symbol} ${formatPnl(summary.bestTrade.netReturn)}`);
      }
      if (summary.worstTrade) {
        console.log(`    Worst trade:     ${summary.worstTrade.symbol} ${formatPnl(summary.worstTrade.netReturn)}`);
      }
      console.log();
    });
}
