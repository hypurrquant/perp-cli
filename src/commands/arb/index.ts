import { Command } from "commander";
import chalk from "chalk";
import { makeTable, formatUsd, formatPnl, printJson, jsonOk } from "../../utils.js";
import type { ExchangeAdapter, ExchangePosition } from "../../exchanges/interface.js";
import { readExecutionLog, logExecution, type ExecutionRecord } from "../../execution-log.js";
import { toHourlyRate, computeAnnualSpread } from "../../funding.js";
import {
  fetchPacificaPrices, fetchHyperliquidMeta,
  fetchLighterOrderBookDetails, fetchLighterFundingRates,
} from "../../shared-api.js";
import { computeBasisRisk } from "../../arb-utils.js";
import { fetchAllBalances, computeRebalancePlan } from "../../rebalance.js";
import { EXCHANGE_TO_CHAIN, getBestQuote } from "../../bridge-engine.js";
import { computeEnhancedStats, type ArbTradeForStats } from "../../arb-history-stats.js";

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
  exitReason: string | null;
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

  const [pacAssets, hlAssets, ltDetails, ltFunding] = await Promise.all([
    fetchPacificaPrices(),
    fetchHyperliquidMeta(),
    fetchLighterOrderBookDetails(),
    fetchLighterFundingRates(),
  ]);

  const addRate = (sym: string, exchange: string, rate: number, markPrice: number) => {
    if (!sym) return;
    if (!rateMap.has(sym)) rateMap.set(sym, []);
    rateMap.get(sym)!.push({ exchange, rate, markPrice });
  };

  for (const p of pacAssets) addRate(p.symbol, "pacifica", p.funding, p.mark);
  for (const h of hlAssets) addRate(h.symbol, "hyperliquid", h.funding, h.markPx);

  // Lighter: join details + funding by marketId
  const ltPriceMap = new Map(ltDetails.map(d => [d.marketId, d.lastTradePrice]));
  const ltSymMap = new Map(ltDetails.map(d => [d.marketId, d.symbol]));
  for (const fr of ltFunding) {
    const sym = fr.symbol || ltSymMap.get(fr.marketId) || "";
    const mp = fr.markPrice || ltPriceMap.get(fr.marketId) || 0;
    addRate(sym, "lighter", fr.rate, mp);
  }

  return rateMap;
}

function findArbEntryForPair(symbol: string, longExchange?: string, shortExchange?: string): ExecutionRecord | null {
  const entries = readExecutionLog({ type: "arb_entry", symbol });
  const successful = entries.filter(e => e.status === "success");
  if (!successful.length) return null;

  // Try matching by arbPairId first (new format)
  if (longExchange && shortExchange) {
    const pairId = `${symbol.toUpperCase()}:${longExchange}:${shortExchange}`;
    const byPairId = successful.find(e => e.meta?.arbPairId === pairId);
    if (byPairId) return byPairId;

    // Also try matching by exchange field (e.g. "pacifica+hyperliquid")
    const byExchange = successful.find(e =>
      e.meta?.longExchange === longExchange && e.meta?.shortExchange === shortExchange
    );
    if (byExchange) return byExchange;
  }

  // Fallback: return most recent entry for this symbol (legacy records without arbPairId)
  return successful[0];
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

            // Look up entry info from execution log (match by pair)
            const entryLog = findArbEntryForPair(symbol, longPos.exchange, shortPos.exchange);
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

        // Compute basis risk from mark prices
        const basis = computeBasisRisk(p.longPosition.markPrice, p.shortPosition.markPrice);
        const basisStr = basis.divergencePct > 0
          ? (basis.warning
            ? chalk.red(`${basis.divergencePct.toFixed(1)}%`)
            : chalk.gray(`${basis.divergencePct.toFixed(1)}%`))
          : chalk.gray("-");

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
          basisStr,
          holdStr,
          formatPnl(p.netPnl),
        ];
      });

      console.log(makeTable(
        ["Symbol", "Long", "Short", "Size", "Entry", "Mark", "uPnL", "Funding", "Spread", "Basis", "Hold", "Net PnL"],
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
    .option("--pair <pair>", "Specify arb pair as longExchange:shortExchange (e.g. pacifica:hyperliquid)")
    .action(async (symbol: string, opts: { dryRun?: boolean; pair?: string }) => {
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

      // Find all possible arb pairs (long on one exchange, short on another)
      const possiblePairs: { long: typeof allPositions[0]; short: typeof allPositions[0] }[] = [];
      const longs = allPositions.filter(p => p.side === "long");
      const shorts = allPositions.filter(p => p.side === "short");
      for (const l of longs) {
        for (const s of shorts) {
          if (l.exchange !== s.exchange) possiblePairs.push({ long: l, short: s });
        }
      }

      // If --pair specified, filter to that specific pair
      let longPos: typeof allPositions[0] | undefined;
      let shortPos: typeof allPositions[0] | undefined;

      if (opts.pair) {
        const [longEx, shortEx] = opts.pair.split(":");
        const match = possiblePairs.find(p => p.long.exchange === longEx && p.short.exchange === shortEx);
        if (match) {
          longPos = match.long;
          shortPos = match.short;
        }
      } else if (possiblePairs.length === 1) {
        longPos = possiblePairs[0].long;
        shortPos = possiblePairs[0].short;
      } else if (possiblePairs.length > 1) {
        // Multiple pairs found — require explicit --pair selection
        const msg = `Multiple arb pairs found for ${sym}. Use --pair to specify which one to close.`;
        if (isJson()) {
          return printJson(jsonOk({
            error: msg,
            pairs: possiblePairs.map(p => ({
              arbPairId: `${sym}:${p.long.exchange}:${p.short.exchange}`,
              longExchange: p.long.exchange,
              shortExchange: p.short.exchange,
              longSize: p.long.size,
              shortSize: p.short.size,
            })),
          }));
        }
        console.log(chalk.red(`  ${msg}\n`));
        console.log(chalk.white("  Available pairs:"));
        for (const p of possiblePairs) {
          console.log(chalk.gray(`    --pair ${p.long.exchange}:${p.short.exchange}  (long ${p.long.size} / short ${p.short.size})`));
        }
        console.log();
        return;
      }

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
      const arbPairId = `${sym}:${longPos.exchange}:${shortPos.exchange}`;
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
          arbPairId,
          longExchange: longPos.exchange,
          shortExchange: shortPos.exchange,
          unrealizedPnl: totalUpnl,
          estimatedFees: totalFees,
          netPnl,
          results,
          exitReason: "manual",
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
            avgEntrySpread: 0,
            avgExitSpread: 0,
            avgSpreadDecay: 0,
            byExchangePair: [],
            byTimeOfDay: [],
            optimalHoldTime: null,
          },
          period: periodDays,
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.gray("  No arb trades found in this period.\n"));
        return;
      }

      // Group entries by arbPairId (or symbol fallback for legacy) to match entry/exit pairs
      const entryMap = new Map<string, ExecutionRecord[]>();
      const closeMap = new Map<string, ExecutionRecord[]>();

      function getPairKey(record: ExecutionRecord): string {
        // Use arbPairId if available (new format), fallback to symbol (legacy)
        const arbPairId = record.meta?.arbPairId as string | undefined;
        if (arbPairId) return arbPairId;
        return record.symbol.toUpperCase();
      }

      for (const entry of arbEntries) {
        const key = getPairKey(entry);
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
            const exitReason = matchingClose.meta?.exitReason as string | null ?? null;

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
              exitReason,
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
              exitReason: null,
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

      // Compute enhanced analytics
      const statsInput: ArbTradeForStats[] = trades.map(t => ({
        symbol: t.symbol,
        exchanges: t.exchanges,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        holdDurationMs: t.holdDurationMs,
        entrySpread: t.entrySpread,
        exitSpread: t.exitSpread,
        netReturn: t.netReturn,
        status: t.status,
      }));
      const enhanced = computeEnhancedStats(statsInput);

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
        avgEntrySpread: enhanced.avgEntrySpread,
        avgExitSpread: enhanced.avgExitSpread,
        avgSpreadDecay: enhanced.avgSpreadDecay,
        byExchangePair: enhanced.byExchangePair,
        byTimeOfDay: enhanced.byTimeOfDay,
        optimalHoldTime: enhanced.optimalHoldTime,
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
            t.exitReason ?? "-",
          ];
        });

        console.log(makeTable(
          ["Symbol", "Exchanges", "Entry", "Exit", "Hold", "Spread", "Size", "Gross", "Funding", "Fees", "Net", "Status", "Reason"],
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

      // ── Exchange Pair Performance ──
      if (enhanced.byExchangePair.length > 0) {
        console.log(chalk.cyan.bold("\n  Exchange Pair Performance\n"));
        const pairRows = enhanced.byExchangePair.map(p => [
          chalk.white.bold(p.pair),
          String(p.trades),
          `${p.winRate.toFixed(0)}%`,
          formatPnl(p.avgNetPnl),
          p.avgHoldTime,
        ]);
        console.log(makeTable(
          ["Pair", "Trades", "Win%", "Avg PnL", "Avg Hold"],
          pairRows,
        ));
      }

      // ── Time of Day Performance ──
      if (enhanced.byTimeOfDay.length > 0) {
        console.log(chalk.cyan.bold("\n  Time of Day Performance\n"));
        const todRows = enhanced.byTimeOfDay.map(b => [
          chalk.white(b.bucket),
          String(b.trades),
          `${b.winRate.toFixed(0)}%`,
          formatPnl(b.avgNetPnl),
        ]);
        console.log(makeTable(
          ["UTC", "Trades", "Win%", "Avg PnL"],
          todRows,
        ));
      }

      // ── Spread Decay & Optimal Hold ──
      if (enhanced.optimalHoldTime) {
        console.log(`    Optimal hold time: ~${enhanced.optimalHoldTime} (median of winning trades)`);
      }
      if (enhanced.avgEntrySpread > 0 && enhanced.avgExitSpread >= 0) {
        console.log(`    Avg spread decay: ${enhanced.avgEntrySpread.toFixed(1)}% -> ${enhanced.avgExitSpread.toFixed(1)}% over avg ${summary.avgHoldTime ?? "-"}`);
      }
      console.log();
    });

  // ── arb rebalance ──

  arb
    .command("rebalance")
    .description("Cross-exchange balance rebalancing for arb")
    .option("--check", "Show current balance distribution")
    .option("--target <ratio>", "Target distribution ratio (e.g., '50:50' for 2 exchanges, '33:33:33' for 3)")
    .option("--amount <usd>", "Total amount to rebalance")
    .option("--dry-run", "Show plan without executing")
    .option("--exchanges <list>", "Comma-separated exchanges", "lighter,pacifica,hyperliquid")
    .action(async (opts: {
      check?: boolean; target?: string; amount?: string;
      dryRun?: boolean; exchanges: string;
    }) => {
      const exchangeNames = opts.exchanges.split(",").map(e => e.trim());
      const adapters = new Map<string, ExchangeAdapter>();

      for (const name of exchangeNames) {
        try {
          adapters.set(name, await getAdapterForExchange(name));
        } catch { /* skip unavailable */ }
      }

      if (adapters.size === 0) {
        if (isJson()) return printJson(jsonOk({ error: "No exchanges available" }));
        console.error(chalk.red("\n  No exchanges available. Check credentials.\n"));
        return;
      }

      // Default to --check if no action specified
      if (!opts.target && !opts.check) {
        opts.check = true;
      }

      const snapshots = await fetchAllBalances(adapters);
      const totalEquity = snapshots.reduce((s, e) => s + e.equity, 0);
      const totalAvailable = snapshots.reduce((s, e) => s + e.available, 0);

      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : e.toUpperCase();
      const exChain = (e: string) => e === "pacifica" ? "Solana" : e === "hyperliquid" ? "Hyperliquid" : e === "lighter" ? "Arbitrum" : "unknown";

      if (opts.check) {
        // Show current balance distribution
        if (isJson()) {
          return printJson(jsonOk({
            balances: snapshots.map(s => ({
              exchange: s.exchange,
              abbr: exAbbr(s.exchange),
              chain: exChain(s.exchange),
              equity: s.equity,
              available: s.available,
              marginUsed: s.marginUsed,
              unrealizedPnl: s.unrealizedPnl,
              allocationPct: totalEquity > 0 ? (s.equity / totalEquity) * 100 : 0,
            })),
            totalEquity,
            totalAvailable,
          }));
        }

        console.log(chalk.cyan("\n  Cross-Exchange Balance Distribution\n"));

        const rows = snapshots.map(s => {
          const pct = totalEquity > 0 ? ((s.equity / totalEquity) * 100).toFixed(1) : "0.0";
          return [
            chalk.white.bold(exAbbr(s.exchange).padEnd(4)),
            chalk.gray(exChain(s.exchange).padEnd(12)),
            `$${formatUsd(s.equity)}`,
            `$${formatUsd(s.available)}`,
            `$${formatUsd(s.marginUsed)}`,
            s.unrealizedPnl >= 0
              ? chalk.green(`+$${formatUsd(s.unrealizedPnl)}`)
              : chalk.red(`-$${formatUsd(Math.abs(s.unrealizedPnl))}`),
            `${pct}%`,
          ];
        });

        console.log(makeTable(["Exch", "Chain", "Equity", "Available", "Margin", "uPnL", "Alloc%"], rows));
        console.log(chalk.cyan.bold("  Totals"));
        console.log(`  Total Equity:    $${formatUsd(totalEquity)}`);
        console.log(`  Total Available: $${formatUsd(totalAvailable)}`);
        console.log(`  Exchanges:       ${snapshots.length}\n`);
        return;
      }

      // Parse target ratios
      if (!opts.target) {
        console.error(chalk.red("  --target required (e.g., '50:50' or '33:33:33')"));
        return;
      }

      const ratios = opts.target.split(":").map(Number);
      if (ratios.length !== snapshots.length || ratios.some(isNaN)) {
        console.error(chalk.red(`  Target ratio must have ${snapshots.length} parts (one per exchange), got '${opts.target}'`));
        return;
      }

      const ratioSum = ratios.reduce((a, b) => a + b, 0);
      const weights: Record<string, number> = {};
      snapshots.forEach((s, i) => {
        weights[s.exchange] = ratios[i] / ratioSum;
      });

      // Compute plan
      const plan = computeRebalancePlan(snapshots, { weights, minMove: 10, reserve: 10 });

      if (plan.moves.length === 0) {
        if (isJson()) return printJson(jsonOk({ status: "balanced", moves: [], snapshots }));
        console.log(chalk.green("\n  Already balanced -- no moves needed.\n"));
        return;
      }

      // If --amount specified, scale moves proportionally
      let moves = plan.moves;
      if (opts.amount) {
        const requestedAmount = parseFloat(opts.amount);
        const totalMoveAmount = moves.reduce((s, m) => s + m.amount, 0);
        if (totalMoveAmount > 0) {
          const scale = Math.min(1, requestedAmount / totalMoveAmount);
          moves = moves.map(m => ({ ...m, amount: Math.floor(m.amount * scale) })).filter(m => m.amount >= 10);
        }
      }

      // Get bridge route info for each move
      const moveDetails = await Promise.all(moves.map(async (m) => {
        const srcChain = EXCHANGE_TO_CHAIN[m.from] ?? "unknown";
        const dstChain = EXCHANGE_TO_CHAIN[m.to] ?? "unknown";
        let bridgeFee = 0;
        let bridgeProvider = "same-chain";
        let bridgeTime = "instant";

        if (srcChain !== dstChain && srcChain !== "unknown" && dstChain !== "unknown") {
          try {
            const quote = await getBestQuote(srcChain, dstChain, m.amount, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000");
            bridgeFee = quote.fee;
            bridgeProvider = quote.provider;
            bridgeTime = `~${Math.ceil(quote.estimatedTime / 60)}min`;
          } catch {
            bridgeFee = 0.5; // fallback estimate
            bridgeProvider = "cctp";
            bridgeTime = "~3min";
          }
        }

        return {
          ...m,
          srcChain,
          dstChain,
          bridgeFee,
          bridgeProvider,
          bridgeTime,
        };
      }));

      if (isJson()) {
        return printJson(jsonOk({
          status: opts.dryRun ? "dry_run" : "planned",
          target: weights,
          moves: moveDetails,
          snapshots,
          totalEquity,
        }));
      }

      console.log(chalk.cyan("\n  Rebalance Plan\n"));

      // Show current vs target
      const stateRows = snapshots.map(s => {
        const targetPct = (weights[s.exchange] * 100).toFixed(1);
        const currentPct = totalEquity > 0 ? ((s.equity / totalEquity) * 100).toFixed(1) : "0.0";
        const targetUsd = totalAvailable * weights[s.exchange];
        const diff = s.available - targetUsd;
        const diffStr = diff >= 0
          ? chalk.green(`+$${formatUsd(diff)}`)
          : chalk.red(`-$${formatUsd(Math.abs(diff))}`);
        return [
          chalk.white.bold(exAbbr(s.exchange)),
          `$${formatUsd(s.available)}`,
          `${currentPct}%`,
          `$${formatUsd(targetUsd)}`,
          `${targetPct}%`,
          diffStr,
        ];
      });

      console.log(makeTable(["Exch", "Available", "Current%", "Target$", "Target%", "Diff"], stateRows));

      // Show moves
      console.log(chalk.cyan.bold("\n  Transfers\n"));
      for (let i = 0; i < moveDetails.length; i++) {
        const m = moveDetails[i];
        console.log(chalk.white.bold(`  Move ${i + 1}: $${m.amount} ${exAbbr(m.from)} -> ${exAbbr(m.to)}`));
        console.log(chalk.gray(`    Route: ${m.srcChain} -> ${m.dstChain} via ${m.bridgeProvider}`));
        console.log(chalk.gray(`    Fee: ~$${m.bridgeFee.toFixed(2)} | Time: ${m.bridgeTime}`));
        console.log();
      }

      const totalFees = moveDetails.reduce((s, m) => s + m.bridgeFee, 0);
      console.log(chalk.gray(`  Total bridge fees: ~$${totalFees.toFixed(2)}`));

      if (opts.dryRun) {
        console.log(chalk.yellow("\n  [DRY RUN] No transfers executed.\n"));
      } else {
        console.log(chalk.yellow("\n  To execute, use: perp rebalance execute --auto-bridge\n"));
      }
    });
}
