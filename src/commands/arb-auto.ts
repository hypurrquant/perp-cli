import { Command } from "commander";
import chalk from "chalk";
import { formatUsd, printJson, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { computeExecutableSize } from "../liquidity.js";
import { computeAnnualSpread, toHourlyRate } from "../funding.js";
import {
  fetchPacificaPricesRaw, parsePacificaRaw,
  fetchHyperliquidMetaRaw, parseHyperliquidMetaRaw,
  fetchLighterOrderBookDetailsRaw, fetchLighterFundingRatesRaw, parseLighterRaw,
} from "../shared-api.js";
import { scanDexArb, type DexArbPair } from "../dex-asset-map.js";
import { logExecution, readExecutionLog } from "../execution-log.js";
import { smartOrder } from "../smart-order.js";
import {
  type SettleStrategy,
  type ArbNotifyEvent,
  getMinutesSinceSettlement,
  aggressiveSettleBoost,
  estimateFundingUntilSettlement,
  computeBasisRisk,
  notifyIfEnabled,
} from "../arb-utils.js";
import {
  checkChainMargins, isCriticalMargin, shouldBlockEntries,
  computeAutoSize,
} from "../cross-chain-margin.js";
import {
  loadArbState,
  saveArbState,
  addPosition as persistAddPosition,
  removePosition as persistRemovePosition,
  updatePosition as persistUpdatePosition,
  createInitialState,
  type ArbPositionState,
} from "../arb-state.js";

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
  pacMarkPrice: number;
  hlMarkPrice: number;
  ltMarkPrice: number;
}

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  size: number;
  entrySpread: number;
  entryTime: string;
  entryMarkPrice: number;
  accumulatedFundingUsd: number;  // estimated funding collected so far
  lastCheckTime: number;          // unix ms of last spread check
}

// ── Fee-Adjusted Net Spread Calculation ──

import { getTakerFee } from "../constants.js";

/**
 * Compute the estimated round-trip cost as a percentage of notional.
 * Round-trip = 4 × taker fee + 2 × slippage (entry + exit for both legs).
 */
export function computeRoundTripCostPct(
  longExchange: string,
  shortExchange: string,
  slippagePct: number = 0.05,
): number {
  const longFee = getTakerFee(longExchange) * 100; // convert to pct
  const shortFee = getTakerFee(shortExchange) * 100;
  // Entry: long taker + short taker + slippage on each
  // Exit:  long taker + short taker + slippage on each
  return 2 * (longFee + shortFee) + 2 * slippagePct;
}

/**
 * Compute net annualized spread after deducting round-trip costs amortized over hold period.
 *
 * Net = grossAnnualPct - (roundTripCostPct / holdDays * 365) - (bridgeCostPct annualized)
 *
 * @param grossAnnualPct - Gross annual spread in %
 * @param holdDays - Expected holding period in days for cost amortization
 * @param roundTripCostPct - Total round-trip cost as % of notional
 * @param bridgeCostUsd - One-way bridge cost in USD (doubled for round-trip)
 * @param positionSizeUsd - Position size per leg in USD (for bridge cost %)
 */
export function computeNetSpread(
  grossAnnualPct: number,
  holdDays: number,
  roundTripCostPct: number,
  bridgeCostUsd: number = 0,
  positionSizeUsd: number = 0,
): number {
  const annualizedCostPct = (roundTripCostPct / holdDays) * 365;
  let bridgeCostAnnualPct = 0;
  if (bridgeCostUsd > 0 && positionSizeUsd > 0) {
    const bridgeRoundTripPct = (bridgeCostUsd * 2 / positionSizeUsd) * 100;
    bridgeCostAnnualPct = (bridgeRoundTripPct / holdDays) * 365;
  }
  return grossAnnualPct - annualizedCostPct - bridgeCostAnnualPct;
}

// ── Funding Settlement Timing ──

import { SETTLEMENT_SCHEDULES } from "../arb-utils.js";

/**
 * Get the next settlement time for an exchange.
 * @returns Date of next settlement
 */
export function getNextSettlement(exchange: string, now: Date = new Date()): Date {
  const schedule = SETTLEMENT_SCHEDULES[exchange.toLowerCase()];
  if (!schedule || schedule.length === 0) {
    // Default: every hour
    return getNextSettlement("pacifica", now);
  }

  const currentHour = now.getUTCHours();
  const currentMinutes = now.getUTCMinutes();
  const currentSeconds = now.getUTCSeconds();

  // Find the next settlement hour strictly in the future
  // A settlement at the current hour is "next" only if we haven't reached it yet (min=0, sec=0)
  for (const hour of schedule) {
    if (hour > currentHour || (hour === currentHour && currentMinutes === 0 && currentSeconds === 0)) {
      // This settlement is still in the future (or exactly now)
      // But skip if hour === currentHour and we're past minute 0
      if (hour === currentHour && (currentMinutes > 0 || currentSeconds > 0)) continue;
      const next = new Date(now);
      next.setUTCHours(hour, 0, 0, 0);
      return next;
    }
  }

  // Wrap to next day's first settlement
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(schedule[0], 0, 0, 0);
  return next;
}

/**
 * Check if we are within N minutes before a settlement event on either exchange.
 * If so, we should avoid entering positions (rates may change).
 */
export function isNearSettlement(
  longExchange: string,
  shortExchange: string,
  bufferMinutes: number = 5,
  now: Date = new Date(),
): { blocked: boolean; exchange?: string; minutesUntil?: number } {
  for (const exch of [longExchange, shortExchange]) {
    const nextSettle = getNextSettlement(exch, now);
    const minutesUntil = (nextSettle.getTime() - now.getTime()) / (1000 * 60);
    if (minutesUntil <= bufferMinutes && minutesUntil >= 0) {
      return { blocked: true, exchange: exch, minutesUntil };
    }
  }
  return { blocked: false };
}

/**
 * Detect if the funding spread has reversed direction for an open position.
 * A reversal means the long exchange now has a HIGHER hourly rate than the short exchange,
 * meaning we're now paying on both sides instead of collecting.
 */
export function isSpreadReversed(
  longExchange: string,
  shortExchange: string,
  snapshot: FundingSnapshot,
): boolean {
  const rateFor = (e: string) =>
    e === "pacifica" ? snapshot.pacRate : e === "hyperliquid" ? snapshot.hlRate : snapshot.ltRate;
  const longHourly = toHourlyRate(rateFor(longExchange), longExchange);
  const shortHourly = toHourlyRate(rateFor(shortExchange), shortExchange);
  // Reversed if the long side rate exceeds the short side rate
  return longHourly > shortHourly;
}

async function fetchFundingSpreads(): Promise<FundingSnapshot[]> {
  const [pacRes, hlRes, ltDetailsRes, ltFundingRes] = await Promise.all([
    fetchPacificaPricesRaw(),
    fetchHyperliquidMetaRaw(),
    fetchLighterOrderBookDetailsRaw(),
    fetchLighterFundingRatesRaw(),
  ]);

  const { rates: pacRates, prices: pacPrices } = parsePacificaRaw(pacRes);
  const { rates: hlRates, prices: hlPrices } = parseHyperliquidMetaRaw(hlRes);
  const { rates: ltRates, prices: ltPrices } = parseLighterRaw(ltDetailsRes, ltFundingRes);

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

    const norm = (r: ExchangeRate) => toHourlyRate(r.rate, r.exchange);
    available.sort((a, b) => norm(a) - norm(b));
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
      pacMarkPrice: pacPrices.get(sym) ?? 0,
      hlMarkPrice: hlPrices.get(sym) ?? 0,
      ltMarkPrice: ltPrices.get(sym) ?? 0,
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
    .option("--min-size <usd>", "Min position size floor for auto-sizing ($ notional)", "30")
    .option("--max-positions <n>", "Max simultaneous arb positions", "5")
    .option("--symbols <list>", "Comma-separated symbols to monitor (default: all)")
    .option("--interval <seconds>", "Check interval", "60")
    .option("--hold-days <days>", "Expected hold period for cost amortization", "7")
    .option("--bridge-cost <usd>", "One-way bridge cost in USD", "0.5")
    .option("--no-reversal-exit", "Disable emergency exit on spread reversal")
    .option("--settle-aware", "Avoid entries near funding settlement (default: true)")
    .option("--no-settle-aware", "Disable settlement timing awareness")
    .option("--min-margin <pct>", "Warn/block when margin ratio drops below this %", "30")
    .option("--settle-strategy <mode>", "Settlement timing: block (default), aggressive, off", "block")
    .option("--max-basis <pct>", "Max basis risk (mark price divergence %)", "3")
    .option("--notify <url>", "Webhook URL for notifications (Discord/Telegram/generic)")
    .option("--notify-events <events>", "Comma-separated events: entry,exit,reversal,margin,basis", "entry,exit,reversal,margin,basis")
    .option("--cooldown <minutes>", "Minutes to wait before re-entering a closed symbol", "30")
    .option("--dry-run", "Simulate without executing trades")
    .option("--background", "Run in background (tmux)")
    .action(async (opts: {
      minSpread: string; closeSpread: string; size: string; minSize: string;
      maxPositions: string; symbols?: string; interval: string;
      holdDays: string; bridgeCost: string;
      reversalExit?: boolean; settleAware?: boolean;
      minMargin: string;
      settleStrategy: string; maxBasis: string;
      cooldown: string;
      notify?: string; notifyEvents: string;
      dryRun?: boolean; background?: boolean;
    }) => {
      if (opts.background) {
        const { startJob } = await import("../jobs.js");
        const cliArgs = [
          `--min-spread`, opts.minSpread,
          `--close-spread`, opts.closeSpread,
          `--size`, opts.size,
          `--max-positions`, opts.maxPositions,
          `--interval`, opts.interval,
          `--hold-days`, opts.holdDays,
          `--bridge-cost`, opts.bridgeCost,
          `--min-margin`, opts.minMargin,
          `--cooldown`, opts.cooldown,
          ...(opts.symbols ? [`--symbols`, opts.symbols] : []),
          ...(opts.dryRun ? [`--dry-run`] : []),
          ...(opts.reversalExit === false ? [`--no-reversal-exit`] : []),
          ...(opts.settleAware === false ? [`--no-settle-aware`] : []),
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
      const sizeIsAuto = opts.size.toLowerCase() === "auto";
      const sizeUsd = sizeIsAuto ? 0 : parseFloat(opts.size);
      const maxPositions = parseInt(opts.maxPositions);
      const intervalMs = parseInt(opts.interval) * 1000;
      const holdDays = parseFloat(opts.holdDays);
      const bridgeCostUsd = parseFloat(opts.bridgeCost);
      const reversalExitEnabled = opts.reversalExit !== false;
      const settleAwareEnabled = opts.settleAware !== false;
      // --no-settle-aware overrides --settle-strategy to "off"
      const settleStrategy = !settleAwareEnabled ? "off" as SettleStrategy : (opts.settleStrategy || "block") as SettleStrategy;
      const maxBasisPct = parseFloat(opts.maxBasis);
      const webhookUrl = opts.notify;
      const notifyEvents: ArbNotifyEvent[] = opts.notifyEvents
        .split(",").map(e => e.trim()).filter(Boolean) as ArbNotifyEvent[];
      const minMarginPct = parseFloat(opts.minMargin);
      const minSizeUsd = parseFloat(opts.minSize);
      const filterSymbols = opts.symbols?.split(",").map(s => s.trim().toUpperCase());
      const dryRun = !!opts.dryRun || process.argv.includes("--dry-run");

      const cooldownMinutes = parseFloat(opts.cooldown);
      const openPositions: ArbPosition[] = [];
      // Track which exchanges have low margin (block entries)
      const blockedExchanges = new Set<string>();
      // Track close times per symbol to prevent close→re-entry loops
      const closeCooldowns = new Map<string, number>(); // symbol → close timestamp ms

      // -- State Persistence: Initialize or recover --
      const daemonConfig = {
        minSpread,
        closeSpread,
        size: (typeof sizeIsAuto !== "undefined" && sizeIsAuto ? "auto" : sizeUsd) as number | "auto",
        holdDays,
        bridgeCost: bridgeCostUsd,
        maxPositions,
        settleStrategy: settleAwareEnabled ? "aware" : "disabled",
      };
      let daemonState = loadArbState();
      if (daemonState && daemonState.positions.length > 0) {
        // Crash recovery: restore positions from persisted state
        for (const persisted of daemonState.positions) {
          openPositions.push({
            symbol: persisted.symbol,
            longExchange: persisted.longExchange,
            shortExchange: persisted.shortExchange,
            size: persisted.longSize,
            entrySpread: persisted.entrySpread,
            entryTime: persisted.entryTime,
            entryMarkPrice: persisted.entryLongPrice,
            accumulatedFundingUsd: persisted.accumulatedFunding,
            lastCheckTime: new Date(persisted.lastCheckTime).getTime(),
          });
        }
        daemonState.lastStartTime = new Date().toISOString();
        saveArbState(daemonState);
        if (!isJson()) {
          console.log(chalk.yellow(`  Recovered ${openPositions.length} position(s) from previous session.`));
        }
      } else {
        daemonState = createInitialState(daemonConfig);
        saveArbState(daemonState);
      }

      // SIGINT handler: clean up interval and save final state before exit
      let cycleInterval: ReturnType<typeof setInterval> | null = null;
      const handleSigint = () => {
        if (cycleInterval) clearInterval(cycleInterval);
        const finalState = loadArbState();
        if (finalState) {
          finalState.lastScanTime = new Date().toISOString();
          saveArbState(finalState);
        }
        if (!isJson()) console.log(chalk.yellow("\n  Daemon stopped. State saved.\n"));
        process.exit(0);
      };
      process.on("SIGINT", handleSigint);


      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Funding Rate Arb Bot\n"));
        console.log(`  Mode:          ${dryRun ? chalk.yellow("DRY RUN") : chalk.green("LIVE")}`);
        console.log(`  Enter spread:  >= ${minSpread}% annual (net, after fees)`);
        console.log(`  Close spread:  <= ${closeSpread}% annual`);
        console.log(`  Size per leg:  ${sizeIsAuto ? chalk.cyan("auto (dynamic)") : `$${sizeUsd}`}`);
        if (sizeIsAuto) console.log(`  Min size:      $${minSizeUsd} (floor for auto)`);
        console.log(`  Max positions: ${maxPositions}`);
        console.log(`  Hold period:   ${holdDays} days (cost amortization)`);
        console.log(`  Bridge cost:   $${bridgeCostUsd} per transfer`);
        console.log(`  Min margin:    ${minMarginPct}% (block entries below this)`);
        console.log(`  Max basis:     ${maxBasisPct}% (warn on price divergence)`);
        console.log(`  Reversal exit: ${reversalExitEnabled ? chalk.green("ON") : chalk.yellow("OFF")}`);
        console.log(`  Settle strat:  ${settleStrategy === "aggressive" ? chalk.cyan("AGGRESSIVE") : settleStrategy === "off" ? chalk.yellow("OFF") : chalk.green("BLOCK")}`);
        console.log(`  Cooldown:      ${cooldownMinutes}m (re-entry delay after close)`);
        console.log(`  Notifications: ${webhookUrl ? chalk.green("ON") : chalk.gray("OFF")}${webhookUrl ? ` (${notifyEvents.join(",")})` : ""}`);
        console.log(`  Symbols:       ${filterSymbols?.join(", ") || "all"}`);
        console.log(`  Interval:      ${opts.interval}s`);
        console.log(chalk.gray("\n  Monitoring... (Ctrl+C to stop)\n"));
      }

      const cycle = async () => {
        // Sync in-memory positions with persisted state (handles CLI manual closes)
        const syncState = loadArbState();
        if (syncState) {
          const persistedSymbols = new Set(syncState.positions.map(p => p.symbol));
          // Remove positions that were closed externally (e.g. via `perp arb close`)
          for (let i = openPositions.length - 1; i >= 0; i--) {
            if (!persistedSymbols.has(openPositions[i].symbol)) {
              console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} SYNC: ${openPositions[i].symbol} removed (closed externally)`));
              openPositions.splice(i, 1);
            }
          }
          // Recover positions that exist in state but not in memory (e.g. added by another process)
          for (const persisted of syncState.positions) {
            if (!openPositions.some(p => p.symbol === persisted.symbol)) {
              console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} SYNC: recovering ${persisted.symbol} from state`));
              openPositions.push({
                symbol: persisted.symbol,
                longExchange: persisted.longExchange,
                shortExchange: persisted.shortExchange,
                size: persisted.longSize,
                entrySpread: persisted.entrySpread,
                entryTime: persisted.entryTime,
                entryMarkPrice: persisted.entryLongPrice,
                accumulatedFundingUsd: persisted.accumulatedFunding,
                lastCheckTime: new Date(persisted.lastCheckTime).getTime(),
              });
            }
          }
        }

        // Heartbeat check
        const heartbeatState = loadArbState();
        if (heartbeatState?.lastSuccessfulScanTime) {
          const lastSuccessMs = new Date(heartbeatState.lastSuccessfulScanTime).getTime();
          const minutesSinceSuccess = (Date.now() - lastSuccessMs) / (1000 * 60);
          if (minutesSinceSuccess > 5) {
            console.log(chalk.yellow(`  ${new Date().toLocaleTimeString()} HEARTBEAT WARNING: no successful scan for ${minutesSinceSuccess.toFixed(0)} minutes`));
            await notifyIfEnabled(webhookUrl, notifyEvents, "heartbeat", {
              lastScanTime: heartbeatState.lastSuccessfulScanTime,
              minutesAgo: minutesSinceSuccess,
            });
          }
        }

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
            let shouldClose = false;
            let closeReason = "";

            // Check spread-based close
            if (currentSpread <= closeSpread) {
              shouldClose = true;
              closeReason = `spread ${currentSpread.toFixed(1)}% <= ${closeSpread}%`;
            }

            // Check reversal-based close
            if (!shouldClose && reversalExitEnabled && isSpreadReversed(pos.longExchange, pos.shortExchange, current)) {
              shouldClose = true;
              closeReason = "REVERSAL DETECTED — long exchange now has higher rate than short";
              await notifyIfEnabled(webhookUrl, notifyEvents, "reversal", {
                symbol: pos.symbol, longExchange: pos.longExchange, shortExchange: pos.shortExchange,
              });
            }

            // Check basis risk (mark price divergence) — use prices from fetchFundingSpreads, no extra API calls
            {
              const priceFor = (e: string) =>
                e === "pacifica" ? current.pacMarkPrice : e === "hyperliquid" ? current.hlMarkPrice : current.ltMarkPrice;
              const bLP = priceFor(pos.longExchange);
              const bSP = priceFor(pos.shortExchange);
              if (bLP > 0 && bSP > 0) {
                const basis = computeBasisRisk(bLP, bSP, maxBasisPct);
                if (basis.warning) {
                  const bExA = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
                  console.log(chalk.yellow(
                    `  ${now} BASIS RISK ${pos.symbol}: Long ${bExA(pos.longExchange)} $${bLP.toFixed(4)} / ` +
                    `Short ${bExA(pos.shortExchange)} $${bSP.toFixed(4)} | Divergence: ${basis.divergencePct.toFixed(1)}%`
                  ));
                  await notifyIfEnabled(webhookUrl, notifyEvents, "basis", {
                    symbol: pos.symbol, longExchange: pos.longExchange, shortExchange: pos.shortExchange,
                    divergencePct: basis.divergencePct,
                  });
                }
              }
            }

            if (shouldClose) {
              console.log(chalk.yellow(`  ${now} CLOSE ${pos.symbol} — ${closeReason}`));
              const exitReason = closeReason.includes("REVERSAL") ? "reversal"
                : closeReason.includes("spread") ? "spread"
                : "manual";

              if (!dryRun) {
                try {
                  const longAdapter = await getAdapterForExchange(pos.longExchange);
                  const shortAdapter = await getAdapterForExchange(pos.shortExchange);

                  // Close both legs simultaneously with verification
                  const [longResult, shortResult] = await Promise.allSettled([
                    longAdapter.marketOrder(pos.symbol, "sell", String(pos.size)),
                    shortAdapter.marketOrder(pos.symbol, "buy", String(pos.size)),
                  ]);

                  const longOk = longResult.status === "fulfilled";
                  const shortOk = shortResult.status === "fulfilled";

                  if (longOk && shortOk) {
                    logExecution({
                      type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                      symbol: pos.symbol, side: "close", size: String(pos.size),
                      status: "success", dryRun: false,
                      meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, currentSpread, reason: closeReason, exitReason },
                    });
                    console.log(chalk.green(`  ${now} CLOSED ${pos.symbol} — both legs`));
                    persistRemovePosition(pos.symbol);
                    closeCooldowns.set(pos.symbol, Date.now());
                    openPositions.splice(i, 1);
                    await notifyIfEnabled(webhookUrl, notifyEvents, "exit", {
                      symbol: pos.symbol, longExchange: pos.longExchange, shortExchange: pos.shortExchange,
                      pnl: pos.accumulatedFundingUsd,
                      duration: `${Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 3600000)}h`,
                    });
                  } else if (longOk !== shortOk) {
                    // One leg closed, one failed — retry the failed leg
                    const failedSide = longOk ? "short" : "long";
                    const failedAdapter = longOk ? shortAdapter : longAdapter;
                    const retryAction = longOk ? "buy" : "sell";
                    const failedErr = longOk
                      ? (shortResult as PromiseRejectedResult).reason
                      : (longResult as PromiseRejectedResult).reason;

                    console.log(chalk.yellow(`  ${now} PARTIAL CLOSE ${pos.symbol}: ${failedSide} leg failed — retrying...`));

                    let retryOk = false;
                    for (let attempt = 1; attempt <= 2; attempt++) {
                      try {
                        await failedAdapter.marketOrder(pos.symbol, retryAction, String(pos.size));
                        retryOk = true;
                        console.log(chalk.green(`  ${now} RETRY OK ${pos.symbol}: ${failedSide} leg closed (attempt ${attempt})`));
                        break;
                      } catch (retryErr) {
                        console.log(chalk.red(`  ${now} RETRY ${attempt}/2 FAILED ${pos.symbol}: ${retryErr instanceof Error ? retryErr.message : retryErr}`));
                      }
                    }

                    if (retryOk) {
                      logExecution({
                        type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                        symbol: pos.symbol, side: "close", size: String(pos.size),
                        status: "success", dryRun: false,
                        meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, currentSpread, reason: closeReason, exitReason, retried: failedSide },
                      });
                      persistRemovePosition(pos.symbol);
                      closeCooldowns.set(pos.symbol, Date.now());
                      openPositions.splice(i, 1);
                    } else {
                      // One leg is closed, other still open — log but DON'T remove from tracking
                      logExecution({
                        type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                        symbol: pos.symbol, side: "close", size: String(pos.size),
                        status: "failed", dryRun: false,
                        error: `Partial close: ${failedSide} failed (${failedErr instanceof Error ? failedErr.message : String(failedErr)}). Retry failed.`,
                        meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, reason: closeReason, exitReason, partialClose: true },
                      });
                      console.log(chalk.red.bold(
                        `  ${now} PARTIAL CLOSE ${pos.symbol}: ${failedSide} still open — MANUAL CLOSE REQUIRED`
                      ));
                      await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                        exchange: longOk ? pos.shortExchange : pos.longExchange,
                        marginPct: 0, threshold: 0, symbol: pos.symbol,
                        message: `PARTIAL CLOSE: ${failedSide} leg still open after retry. Manual close required.`,
                      });
                      // Do NOT splice — keep tracking so next cycle retries
                    }
                  } else {
                    // Both legs failed — keep position, retry next cycle
                    const longErr = (longResult as PromiseRejectedResult).reason;
                    const shortErr = (shortResult as PromiseRejectedResult).reason;
                    logExecution({
                      type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                      symbol: pos.symbol, side: "close", size: String(pos.size),
                      status: "failed", dryRun: false,
                      error: `Both legs failed. Long: ${longErr instanceof Error ? longErr.message : String(longErr)}, Short: ${shortErr instanceof Error ? shortErr.message : String(shortErr)}`,
                      meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, reason: closeReason, exitReason },
                    });
                    console.error(chalk.red(`  ${now} CLOSE FAILED ${pos.symbol}: both legs — will retry next cycle`));
                    // Do NOT splice — retry next cycle
                  }
                } catch (err) {
                  logExecution({
                    type: "arb_close", exchange: `${pos.longExchange}+${pos.shortExchange}`,
                    symbol: pos.symbol, side: "close", size: String(pos.size),
                    status: "failed", dryRun: false,
                    error: err instanceof Error ? err.message : String(err),
                    meta: { longExchange: pos.longExchange, shortExchange: pos.shortExchange, reason: closeReason, exitReason },
                  });
                  console.error(chalk.red(`  ${now} CLOSE FAILED ${pos.symbol}: ${err instanceof Error ? err.message : err}`));
                  // Do NOT splice — retry next cycle
                }
              } else {
                // Dry run — remove from tracking
                persistRemovePosition(pos.symbol);
                closeCooldowns.set(pos.symbol, Date.now());
                openPositions.splice(i, 1);
              }
            }
          }

          // Log next settlement times and funding estimation
          if (!isJson() && settleStrategy !== "off") {
            const nowDate = new Date();
            const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
            const nextHL = getNextSettlement("hyperliquid", nowDate);
            const nextPAC = getNextSettlement("pacifica", nowDate);
            const nextLT = getNextSettlement("lighter", nowDate);
            const fmtMin = (d: Date) => Math.max(0, Math.round((d.getTime() - nowDate.getTime()) / 60000));
            const hoursUntilPAC = (nextPAC.getTime() - nowDate.getTime()) / 3600000;
            const hUTC = nextPAC.getUTCHours().toString().padStart(2, "0");
            console.log(chalk.gray(
              `  ${now} Next settlements: HL ${fmtMin(nextHL)}m | PAC ${fmtMin(nextPAC)}m | LT ${fmtMin(nextLT)}m`
            ));
            for (const fPos of openPositions) {
              const fSnap = filtered.find(s => s.symbol === fPos.symbol);
              if (!fSnap) continue;
              const fRateFor = (e: string) => e === "pacifica" ? fSnap.pacRate : e === "hyperliquid" ? fSnap.hlRate : fSnap.ltRate;
              const fHlHourly = toHourlyRate(fRateFor("hyperliquid"), "hyperliquid");
              const fPacHourly = toHourlyRate(fRateFor("pacifica"), "pacifica");
              const fNotional = fPos.size * fSnap.markPrice;
              const fEst = estimateFundingUntilSettlement(fHlHourly, fPacHourly, fNotional, hoursUntilPAC);
              console.log(chalk.gray(
                `  ${now} ${fPos.symbol} Next PAC: ${hUTC}:00 UTC (${hoursUntilPAC.toFixed(1)}h) | ` +
                `HL cum: ~$${fEst.hlCumulative.toFixed(4)} | PAC pmt: ~$${fEst.pacPayment.toFixed(4)} | ` +
                `Net: ~$${fEst.netFunding.toFixed(4)}`
              ));
            }
          }

          // ── Cross-chain margin monitoring ──
          blockedExchanges.clear();

          // Exchange status check — infer from fetchFundingSpreads results
          // If an exchange returned rates in the scan, it's up. No extra API calls needed.
          const downExchanges = new Set<string>();
          const hasHL = filtered.some(s => s.hlRate !== 0) || spreads.some(s => s.hlRate !== 0);
          const hasLT = filtered.some(s => s.ltRate !== 0) || spreads.some(s => s.ltRate !== 0);
          const hasPAC = filtered.some(s => s.pacRate !== 0) || spreads.some(s => s.pacRate !== 0);
          if (!hasHL) { downExchanges.add("hyperliquid"); blockedExchanges.add("hyperliquid"); }
          if (!hasLT) { downExchanges.add("lighter"); blockedExchanges.add("lighter"); }
          if (!hasPAC) { downExchanges.add("pacifica"); blockedExchanges.add("pacifica"); }
          for (const name of downExchanges) {
            console.log(chalk.red(`  ${now} EXCHANGE DOWN: ${name} — blocking new entries`));
          }

          // Mark existing positions on down exchanges as degraded
          for (const pos of openPositions) {
            if (downExchanges.has(pos.longExchange) || downExchanges.has(pos.shortExchange)) {
              console.log(chalk.yellow(
                `  ${now} DEGRADED ${pos.symbol}: ${downExchanges.has(pos.longExchange) ? pos.longExchange : pos.shortExchange} is down`
              ));
            }
          }

          try {
            // Only check margins when we have open positions (avoid slow adapter init)
            const needMarginCheck = openPositions.length > 0;
            const adaptersMap = new Map<string, ExchangeAdapter>();
            if (needMarginCheck) {
              const marginExchanges = ["hyperliquid", "lighter", "pacifica"];
              for (const name of marginExchanges) {
                try { adaptersMap.set(name, await getAdapterForExchange(name)); } catch { /* skip */ }
              }
            }
            if (adaptersMap.size > 0) {
              const marginStatuses = await checkChainMargins(adaptersMap, minMarginPct);
              for (const ms of marginStatuses) {
                if (isCriticalMargin(ms)) {
                  console.log(chalk.red.bold(
                    `  ${now} EMERGENCY: ${ms.exchange} margin ratio ${ms.marginRatio.toFixed(1)}% — CRITICAL (below 15%)`
                  ));
                  blockedExchanges.add(ms.exchange);
                  await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                    exchange: ms.exchange, marginPct: ms.marginRatio, threshold: 15,
                  });
                } else if (shouldBlockEntries(ms, minMarginPct)) {
                  console.log(chalk.yellow(
                    `  ${now} WARNING: ${ms.exchange} margin ${ms.marginRatio.toFixed(1)}% below ${minMarginPct}% — blocking new entries`
                  ));
                  blockedExchanges.add(ms.exchange);
                  await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                    exchange: ms.exchange, marginPct: ms.marginRatio, threshold: minMarginPct,
                  });
                }
              }
            }
          } catch { /* margin check failed, continue without blocking */ }

          // Check for entry conditions
          if (openPositions.length < maxPositions) {
            for (const snap of filtered) {
              if (openPositions.some(p => p.symbol === snap.symbol)) continue;
              if (openPositions.length >= maxPositions) break;

              // Cooldown: skip if recently closed to prevent close→re-entry loops
              const lastCloseMs = closeCooldowns.get(snap.symbol);
              if (lastCloseMs && cooldownMinutes > 0) {
                const elapsedMin = (Date.now() - lastCloseMs) / 60000;
                if (elapsedMin < cooldownMinutes) {
                  console.log(chalk.gray(
                    `  ${now} SKIP ${snap.symbol}: cooldown ${(cooldownMinutes - elapsedMin).toFixed(0)}m remaining`
                  ));
                  continue;
                }
                // Cooldown expired, clean up
                closeCooldowns.delete(snap.symbol);
              }

              const grossSpread = Math.abs(snap.spread);

              // Determine direction using all 3 exchanges: short the high-funding, long the low-funding
              const longExchange = snap.longExch;
              const shortExchange = snap.shortExch;

              // Block entries if either exchange has low margin
              if (blockedExchanges.has(longExchange) || blockedExchanges.has(shortExchange)) {
                if (!isJson()) {
                  console.log(chalk.gray(
                    `  ${now} SKIP ${snap.symbol}: margin too low on ${blockedExchanges.has(longExchange) ? longExchange : shortExchange}`
                  ));
                }
                continue;
              }

              // Compute net spread after fees and bridge costs
              const roundTripCost = computeRoundTripCostPct(longExchange, shortExchange);
              const effectiveSizeUsd = sizeIsAuto ? 100 : sizeUsd; // Use $100 for net spread calc when auto
              const netSpread = computeNetSpread(grossSpread, holdDays, roundTripCost, bridgeCostUsd, effectiveSizeUsd);

              // Settlement timing check with strategy
              if (settleStrategy === "block") {
                const settlCheck = isNearSettlement(longExchange, shortExchange);
                if (settlCheck.blocked) {
                  console.log(chalk.gray(
                    `  ${now} SKIP ${snap.symbol}: ${settlCheck.minutesUntil?.toFixed(1)}m before ${settlCheck.exchange} settlement`
                  ));
                  continue;
                }
              }

              // In aggressive mode, boost score for post-settlement entries
              let settleBoostMultiplier = 1.0;
              if (settleStrategy === "aggressive") {
                settleBoostMultiplier = aggressiveSettleBoost(longExchange, shortExchange, 10, new Date());
                if (settleBoostMultiplier > 1.0) {
                  console.log(chalk.cyan(
                    `  ${now} BOOST ${snap.symbol}: post-settlement ${((settleBoostMultiplier - 1) * 100).toFixed(0)}% score boost`
                  ));
                }
              }

              // --min-spread compares against NET spread (with settle boost applied)
              const effectiveNetSpread = netSpread * settleBoostMultiplier;
              if (effectiveNetSpread < minSpread) continue;

              const rateForExch = (e: string) => e === "pacifica" ? snap.pacRate : e === "hyperliquid" ? snap.hlRate : snap.ltRate;

              console.log(chalk.green(
                `  ${now} ENTER ${snap.symbol} — gross ${grossSpread.toFixed(1)}% net ${netSpread.toFixed(1)}%` +
                ` | Long ${longExchange} (${(rateForExch(longExchange) * 100).toFixed(4)}%)` +
                ` | Short ${shortExchange} (${(rateForExch(shortExchange) * 100).toFixed(4)}%)`
              ));

              // Calculate size in asset units from USD and mark price
              if (snap.markPrice <= 0) {
                console.error(chalk.red(`  ${now} SKIP ${snap.symbol}: no mark price available`));
                continue;
              }

              // Dynamic sizing: compute auto size if --size auto
              let actualSizeUsd = sizeUsd;
              if (sizeIsAuto) {
                try {
                  const longAdapter = await getAdapterForExchange(longExchange);
                  const shortAdapter = await getAdapterForExchange(shortExchange);
                  actualSizeUsd = await computeAutoSize(longAdapter, shortAdapter, snap.symbol, 0.3);
                  if (actualSizeUsd <= 0) {
                    console.log(chalk.gray(`  ${now} SKIP ${snap.symbol}: auto-size returned $0 (insufficient depth/margin)`));
                    continue;
                  }
                  console.log(chalk.gray(`  ${now} Auto-size ${snap.symbol}: $${actualSizeUsd}`));
                } catch (err) {
                  console.log(chalk.gray(`  ${now} SKIP ${snap.symbol}: auto-size failed — ${err instanceof Error ? err.message : err}`));
                  continue;
                }
              }

              if (sizeIsAuto && actualSizeUsd < minSizeUsd) {
                console.log(chalk.gray(`  ${now} SKIP ${snap.symbol}: auto-size $${actualSizeUsd} below min $${minSizeUsd}`));
                continue;
              }
              const sizeInAsset = (actualSizeUsd / snap.markPrice).toFixed(4);

              if (!dryRun) {
                try {
                  const longAdapter = await getAdapterForExchange(longExchange);
                  const shortAdapter = await getAdapterForExchange(shortExchange);

                  // Use Promise.allSettled for safe dual-leg entry
                  const [longResult, shortResult] = await Promise.allSettled([
                    longAdapter.marketOrder(snap.symbol, "buy", sizeInAsset),
                    shortAdapter.marketOrder(snap.symbol, "sell", sizeInAsset),
                  ]);

                  const longOk = longResult.status === "fulfilled";
                  const shortOk = shortResult.status === "fulfilled";

                  if (longOk && shortOk) {
                    // Both legs filled successfully
                    logExecution({
                      type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                      symbol: snap.symbol, side: "entry", size: sizeInAsset,
                      status: "success", dryRun: false,
                      meta: { longExchange, shortExchange, grossSpread, netSpread, roundTripCost, markPrice: snap.markPrice },
                    });
                    console.log(chalk.green(`  ${now} FILLED ${snap.symbol} — both legs @ ${sizeInAsset} units ($${actualSizeUsd} / $${snap.markPrice.toFixed(2)})`));

                    // Verify actual fill sizes by querying positions
                    let verifiedLongSize = sizeInAsset;
                    let verifiedShortSize = sizeInAsset;
                    try {
                      const [longPositions, shortPositions] = await Promise.all([
                        longAdapter.getPositions(),
                        shortAdapter.getPositions(),
                      ]);
                      const longPos = longPositions.find(p => p.symbol.toUpperCase().includes(snap.symbol));
                      const shortPos = shortPositions.find(p => p.symbol.toUpperCase().includes(snap.symbol));
                      if (longPos) verifiedLongSize = longPos.size;
                      if (shortPos) verifiedShortSize = shortPos.size;
                      if (verifiedLongSize !== sizeInAsset || verifiedShortSize !== sizeInAsset) {
                        console.log(chalk.yellow(
                          `  ${now} SIZE MISMATCH ${snap.symbol}: requested ${sizeInAsset}, actual long=${verifiedLongSize} short=${verifiedShortSize}`
                        ));
                      }
                    } catch {
                      // Position query failed — use requested size as fallback
                      console.log(chalk.gray(`  ${now} Could not verify fill sizes for ${snap.symbol}, using requested size`));
                    }

                    // Persist to state file immediately (crash-safe)
                    const entryTime = new Date().toISOString();
                    persistAddPosition({
                      id: `${snap.symbol}-${Date.now()}`,
                      symbol: snap.symbol,
                      longExchange,
                      shortExchange,
                      longSize: parseFloat(verifiedLongSize),
                      shortSize: parseFloat(verifiedShortSize),
                      entryTime,
                      entrySpread: grossSpread,
                      entryLongPrice: snap.markPrice,
                      entryShortPrice: snap.markPrice,
                      accumulatedFunding: 0,
                      lastCheckTime: entryTime,
                    });

                    await notifyIfEnabled(webhookUrl, notifyEvents, "entry", {
                      symbol: snap.symbol, longExchange, shortExchange,
                      size: actualSizeUsd, netSpread,
                    });
                  } else if (longOk !== shortOk) {
                    // One leg filled, one failed — ROLLBACK the successful leg
                    const filledSide = longOk ? "long" : "short";
                    const failedSide = longOk ? "short" : "long";
                    const filledAdapter = longOk ? longAdapter : shortAdapter;
                    const rollbackAction = longOk ? "sell" : "buy"; // reverse the filled side
                    const failedErr = longOk
                      ? (shortResult as PromiseRejectedResult).reason
                      : (longResult as PromiseRejectedResult).reason;

                    console.log(chalk.yellow(
                      `  ${now} PARTIAL FILL ${snap.symbol}: ${filledSide} OK, ${failedSide} FAILED — rolling back...`
                    ));

                    // Attempt rollback with max 2 retries
                    let rollbackOk = false;
                    for (let attempt = 1; attempt <= 2; attempt++) {
                      try {
                        await filledAdapter.marketOrder(snap.symbol, rollbackAction, sizeInAsset);
                        rollbackOk = true;
                        console.log(chalk.green(`  ${now} ROLLBACK ${snap.symbol}: ${filledSide} leg closed (attempt ${attempt})`));
                        break;
                      } catch (rollbackErr) {
                        console.log(chalk.red(
                          `  ${now} ROLLBACK ATTEMPT ${attempt}/2 FAILED ${snap.symbol}: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`
                        ));
                      }
                    }

                    logExecution({
                      type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                      symbol: snap.symbol, side: "entry", size: sizeInAsset,
                      status: "failed", dryRun: false,
                      error: `Partial fill: ${failedSide} failed (${failedErr instanceof Error ? failedErr.message : String(failedErr)}). Rollback: ${rollbackOk ? "success" : "FAILED"}`,
                      meta: { longExchange, shortExchange, grossSpread, netSpread, partialFill: filledSide, rollbackSuccess: rollbackOk },
                    });

                    if (!rollbackOk) {
                      // Critical: manual intervention required
                      console.log(chalk.red.bold(
                        `  ${now} IMBALANCE ${snap.symbol}: ${filledSide} leg open, rollback failed — MANUAL CLOSE REQUIRED`
                      ));
                      await notifyIfEnabled(webhookUrl, notifyEvents, "margin", {
                        exchange: longOk ? longExchange : shortExchange,
                        marginPct: 0,
                        threshold: 0,
                        symbol: snap.symbol,
                        message: `IMBALANCE: ${filledSide} leg filled on ${longOk ? longExchange : shortExchange}, ${failedSide} failed, rollback failed. Manual close required.`,
                      });
                    }
                    continue; // don't add to openPositions
                  } else {
                    // Both legs failed
                    const longErr = (longResult as PromiseRejectedResult).reason;
                    const shortErr = (shortResult as PromiseRejectedResult).reason;
                    logExecution({
                      type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                      symbol: snap.symbol, side: "entry", size: sizeInAsset,
                      status: "failed", dryRun: false,
                      error: `Both legs failed. Long: ${longErr instanceof Error ? longErr.message : String(longErr)}, Short: ${shortErr instanceof Error ? shortErr.message : String(shortErr)}`,
                      meta: { longExchange, shortExchange, grossSpread, netSpread },
                    });
                    console.error(chalk.red(`  ${now} ENTRY FAILED ${snap.symbol}: both legs rejected`));
                    continue;
                  }
                } catch (err) {
                  logExecution({
                    type: "arb_entry", exchange: `${longExchange}+${shortExchange}`,
                    symbol: snap.symbol, side: "entry", size: sizeInAsset,
                    status: "failed", dryRun: false,
                    error: err instanceof Error ? err.message : String(err),
                    meta: { longExchange, shortExchange, grossSpread, netSpread },
                  });
                  console.error(chalk.red(`  ${now} ENTRY FAILED ${snap.symbol}: ${err instanceof Error ? err.message : err}`));
                  continue;
                }
              }

              const posEntryTime = new Date().toISOString();
              openPositions.push({
                symbol: snap.symbol,
                longExchange,
                shortExchange,
                size: parseFloat(sizeInAsset),
                entrySpread: grossSpread,
                entryTime: posEntryTime,
                entryMarkPrice: snap.markPrice,
                accumulatedFundingUsd: 0,
                lastCheckTime: Date.now(),
              });

              // Persist for dry-run mode too (tracks what would have been entered)
              if (dryRun) {
                persistAddPosition({
                  id: `${snap.symbol}-${Date.now()}`,
                  symbol: snap.symbol,
                  longExchange,
                  shortExchange,
                  longSize: parseFloat(sizeInAsset),
                  shortSize: parseFloat(sizeInAsset),
                  entryTime: posEntryTime,
                  entrySpread: grossSpread,
                  entryLongPrice: snap.markPrice,
                  entryShortPrice: snap.markPrice,
                  accumulatedFunding: 0,
                  lastCheckTime: posEntryTime,
                });
              }
            }
          }

          // Accumulate estimated funding income & show status
          if (openPositions.length > 0) {
            const nowMs = Date.now();
            for (const pos of openPositions) {
              const current = filtered.find(s => s.symbol === pos.symbol);
              if (!current) continue;
              const elapsedHours = (nowMs - pos.lastCheckTime) / (1000 * 60 * 60);
              const notional = pos.size * current.markPrice;
              // Estimate funding collected: normalize all rates to hourly before comparing
              const rateFor = (e: string) => e === "pacifica" ? current.pacRate : e === "hyperliquid" ? current.hlRate : current.ltRate;
              const longHourly = toHourlyRate(rateFor(pos.longExchange), pos.longExchange);
              const shortHourly = toHourlyRate(rateFor(pos.shortExchange), pos.shortExchange);
              // Income = short gets paid positive funding, long pays; net = (shortRate - longRate) * notional * hours
              const hourlyIncome = (shortHourly - longHourly) * notional;
              pos.accumulatedFundingUsd += hourlyIncome * elapsedHours;
              pos.lastCheckTime = nowMs;
            }

            const totalFunding = openPositions.reduce((s, p) => s + p.accumulatedFundingUsd, 0);
            const fundingColor = totalFunding >= 0 ? chalk.green : chalk.red;
            console.log(chalk.gray(
              `  ${now} Status: ${openPositions.length} positions | ` +
              `Est. funding: ${fundingColor(`$${totalFunding.toFixed(4)}`)} — ` +
              openPositions.map(p =>
                `${p.symbol}(${p.entrySpread.toFixed(0)}% $${p.accumulatedFundingUsd.toFixed(3)})`
              ).join(", ")
            ));
          }

          // Update heartbeat: mark successful scan
          const stateForHeartbeat = loadArbState();
          if (stateForHeartbeat) {
            stateForHeartbeat.lastSuccessfulScanTime = new Date().toISOString();
            stateForHeartbeat.lastScanTime = new Date().toISOString();
            saveArbState(stateForHeartbeat);
          }
        } catch (err) {
          console.error(chalk.gray(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        }
      };

      await cycle();
      cycleInterval = setInterval(cycle, intervalMs);
      await new Promise(() => {}); // keep alive
    });

  // ── arb scan ── (one-shot spread scan)

  arb
    .command("scan")
    .description("Scan current funding rate spreads (perp-perp or spot-perp)")
    .option("--mode <mode>", "Scan mode: perp-perp, spot-perp, all", "perp-perp")
    .option("--min <pct>", "Min annual spread to show", "10")
    .option("--top <n>", "Return only top N results (for JSON output)")
    .option("--hold-days <days>", "Expected hold period for cost calc", "7")
    .option("--bridge-cost <usd>", "One-way bridge cost in USD", "0.5")
    .option("--size <usd>", "Position size per leg ($) for cost calc", "100")
    .action(async (opts: { mode: string; min: string; top?: string; holdDays: string; bridgeCost: string; size: string }) => {
      const minSpread = parseFloat(opts.min);
      const holdDays = parseFloat(opts.holdDays);
      const bridgeCostUsd = parseFloat(opts.bridgeCost);
      const sizeUsd = parseFloat(opts.size);

      // ── spot-perp mode ──
      if (opts.mode === "spot-perp" || opts.mode === "all") {
        if (!isJson()) console.log(chalk.cyan("\n  Scanning spot+perp funding opportunities...\n"));
        const { fetchSpotPerpSpreads } = await import("../funding/rates.js");
        const { spreads: spotSpreads } = await fetchSpotPerpSpreads({ minSpread });

        if (isJson() && opts.mode === "spot-perp") {
          let result = spotSpreads.map(s => ({
            mode: "spot-perp" as const, symbol: s.symbol, perpExchange: s.perpExchange,
            spotExchanges: s.spotExchanges, annualSpreadPct: s.annualSpreadPct,
            perpFundingRate: s.perpFundingRate, direction: s.direction,
            markPrice: s.bestMarkPrice, estHourlyIncomeUsd: s.estHourlyIncomeUsd,
          }));
          if (opts.top) result = result.slice(0, parseInt(opts.top));
          return printJson(jsonOk(result));
        }

        if (!isJson()) {
          if (spotSpreads.length === 0) {
            console.log(chalk.gray(`  No spot+perp opportunities above ${minSpread}%\n`));
          } else {
            console.log(chalk.gray(`  ${"SYMBOL".padEnd(8)} ${"SPREAD".padEnd(8)} ${"PERP EX".padEnd(9)} ${"SPOT EX".padEnd(12)} ${"FUND".padEnd(12)} DIRECTION`));
            for (const s of spotSpreads.slice(0, parseInt(opts.top ?? "30"))) {
              const spreadColor = s.annualSpreadPct >= 30 ? chalk.green : chalk.yellow;
              const dir = s.direction === "long-spot-short-perp" ? "Spot+Short" : "Sell+Long";
              console.log(
                `  ${chalk.white.bold(s.symbol.padEnd(8))} ` +
                `${spreadColor(`${s.annualSpreadPct.toFixed(1)}%`.padEnd(8))} ` +
                `${s.perpExchange.slice(0, 8).padEnd(9)} ` +
                `${s.spotExchanges.join(",").slice(0, 11).padEnd(12)} ` +
                `${(s.perpFundingRate * 100).toFixed(4).padEnd(12)}% ` +
                dir
              );
            }
            console.log(chalk.gray(`\n  ${spotSpreads.length} spot+perp opportunities (spot funding = 0%)`));
          }
        }

        if (opts.mode === "spot-perp") return;
        if (!isJson()) console.log(""); // separator
      }

      // ── perp-perp mode (default) ──
      if (!isJson()) console.log(chalk.cyan("  Scanning perp-perp funding rate spreads...\n"));

      const spreads = await fetchFundingSpreads();
      const filtered = spreads.filter(s => Math.abs(s.spread) >= minSpread);

      if (isJson()) {
        let enriched = filtered.map(s => {
          const grossSpread = Math.abs(s.spread);
          const rtCost = computeRoundTripCostPct(s.longExch, s.shortExch);
          const net = computeNetSpread(grossSpread, holdDays, rtCost, bridgeCostUsd, sizeUsd);
          return { mode: "perp-perp" as const, symbol: s.symbol, longExch: s.longExch, shortExch: s.shortExch, markPrice: s.markPrice, grossSpread, netSpread: net, estFeesPct: rtCost };
        }).sort((a, b) => b.netSpread - a.netSpread);
        if (opts.top) enriched = enriched.slice(0, parseInt(opts.top));
        return printJson(jsonOk(enriched));
      }

      if (filtered.length === 0) {
        console.log(chalk.gray(`  No perp-perp spreads above ${minSpread}%\n`));
        return;
      }

      // Header
      console.log(
        chalk.gray(`  ${"SYMBOL".padEnd(8)} ${"GROSS".padEnd(8)} ${"NET".padEnd(8)} ${"FEES".padEnd(7)} ${"DIR".padEnd(7)} RATES`)
      );

      for (const s of filtered) {
        const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : "LT";
        const direction = `${exAbbr(s.shortExch)}>${exAbbr(s.longExch)}`;
        const grossSpread = Math.abs(s.spread);
        const rtCost = computeRoundTripCostPct(s.longExch, s.shortExch);
        const netSpread = computeNetSpread(grossSpread, holdDays, rtCost, bridgeCostUsd, sizeUsd);
        const grossColor = grossSpread >= 30 ? chalk.green : chalk.yellow;
        const netColor = netSpread >= 20 ? chalk.green : netSpread >= 0 ? chalk.yellow : chalk.red;
        const rates: string[] = [];
        if (s.pacRate) rates.push(`PAC:${(s.pacRate * 100).toFixed(4)}%`);
        if (s.hlRate) rates.push(`HL:${(s.hlRate * 100).toFixed(4)}%`);
        if (s.ltRate) rates.push(`LT:${(s.ltRate * 100).toFixed(4)}%`);
        console.log(
          `  ${chalk.white.bold(s.symbol.padEnd(8))} ` +
          `${grossColor(`${grossSpread.toFixed(1)}%`.padEnd(8))} ` +
          `${netColor(`${netSpread.toFixed(1)}%`.padEnd(8))} ` +
          `${chalk.gray(`${rtCost.toFixed(2)}%`.padEnd(7))} ` +
          `${direction.padEnd(7)} ` +
          rates.join(" ")
        );
      }

      console.log(chalk.gray(`\n  ${filtered.length} opportunities above ${minSpread}% gross annual spread`));
      console.log(chalk.gray(`  Net spread assumes ${holdDays}d hold, $${bridgeCostUsd} bridge cost, $${sizeUsd} size`));
      console.log(chalk.gray(`  * Spreads are estimates based on current rates — actual may vary`));
      console.log(chalk.gray(`  Use 'perp arb auto --min-spread ${minSpread}' to auto-trade\n`));
    });

  // ── arb exec ── (validate orderbook + simultaneous dual-leg entry)

  arb
    .command("exec")
    .description("Execute arb: validate orderbook depth on both exchanges, then enter both legs simultaneously")
    .argument("<symbol>", "Symbol (e.g. BTC, ETH, ICP)")
    .argument("<longExch>", "Exchange to go LONG on (hl, pac, lighter)")
    .argument("<shortExch>", "Exchange to go SHORT on (hl, pac, lighter)")
    .argument("<sizeUsd>", "Position size per leg in USD")
    .option("--max-slippage <pct>", "Max slippage % per leg", "0.5")
    .option("--leverage <n>", "Set leverage before entry (both exchanges)")
    .option("--isolated", "Use isolated margin mode")
    .option("--smart", "Smart execution: IOC limit at best bid/ask + 1 tick (reduces slippage)")
    .action(async (symbol: string, longExch: string, shortExch: string, sizeUsdStr: string, opts: {
      maxSlippage: string; leverage?: string; isolated?: boolean; smart?: boolean;
    }) => {
      const sym = symbol.toUpperCase();
      const sizeUsd = parseFloat(sizeUsdStr);
      const maxSlippage = parseFloat(opts.maxSlippage);

      // Resolve exchange aliases
      const aliasMap: Record<string, string> = { hl: "hyperliquid", pac: "pacifica", lt: "lighter" };
      longExch = aliasMap[longExch.toLowerCase()] || longExch.toLowerCase();
      shortExch = aliasMap[shortExch.toLowerCase()] || shortExch.toLowerCase();

      if (longExch === shortExch) {
        if (isJson()) return printJson(jsonOk({ error: "longExch and shortExch must be different" }));
        console.log(chalk.red("  Long and short exchange must be different."));
        return;
      }

      const longAdapter = await getAdapterForExchange(longExch);
      const shortAdapter = await getAdapterForExchange(shortExch);

      // 1. Set leverage if requested
      if (opts.leverage) {
        const lev = parseInt(opts.leverage);
        const mode = opts.isolated ? "isolated" : "cross";
        if (!isJson()) console.log(chalk.gray(`  Setting leverage ${lev}x ${mode} on both exchanges...`));
        const [longLev, shortLev] = await Promise.allSettled([
          longAdapter.setLeverage(sym, lev, mode),
          shortAdapter.setLeverage(sym, lev, mode),
        ]);
        if (longLev.status === "rejected") {
          const msg = `Failed to set leverage on ${longExch}: ${longLev.reason instanceof Error ? longLev.reason.message : longLev.reason}`;
          if (isJson()) return printJson(jsonOk({ error: msg }));
          console.log(chalk.red(`  ${msg}`)); return;
        }
        if (shortLev.status === "rejected") {
          const msg = `Failed to set leverage on ${shortExch}: ${shortLev.reason instanceof Error ? shortLev.reason.message : shortLev.reason}`;
          if (isJson()) return printJson(jsonOk({ error: msg }));
          console.log(chalk.red(`  ${msg}`)); return;
        }
      }

      // 2. Fetch orderbooks simultaneously
      if (!isJson()) console.log(chalk.gray(`  Checking orderbook depth on both exchanges...`));
      const [longBook, shortBook] = await Promise.all([
        longAdapter.getOrderbook(sym),
        shortAdapter.getOrderbook(sym),
      ]);

      // 3. Validate: long side buys from asks, short side sells into bids
      const longCheck = computeExecutableSize(longBook.asks, sizeUsd, maxSlippage);
      const shortCheck = computeExecutableSize(shortBook.bids, sizeUsd, maxSlippage);

      const validation = {
        long: { exchange: longExch, side: "buy", depthUsd: longCheck.depthUsd, canFill: longCheck.canFillFull, slippagePct: longCheck.slippagePct, maxSizeBase: longCheck.maxSize },
        short: { exchange: shortExch, side: "sell", depthUsd: shortCheck.depthUsd, canFill: shortCheck.canFillFull, slippagePct: shortCheck.slippagePct, maxSizeBase: shortCheck.maxSize },
      };

      if (!longCheck.canFillFull || !shortCheck.canFillFull) {
        // Use the smaller fillable amount
        const fillableUsd = Math.min(
          longCheck.maxSize * longCheck.avgFillPrice,
          shortCheck.maxSize * shortCheck.avgFillPrice,
        );
        const result = {
          error: "Insufficient orderbook depth",
          requestedUsd: sizeUsd,
          fillableUsd: Math.round(fillableUsd * 100) / 100,
          validation,
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.red(`\n  Insufficient depth for $${sizeUsd}:`));
        console.log(chalk.gray(`    ${longExch} asks: $${longCheck.depthUsd.toFixed(0)} depth, ${longCheck.canFillFull ? "OK" : "NOT ENOUGH"}`));
        console.log(chalk.gray(`    ${shortExch} bids: $${shortCheck.depthUsd.toFixed(0)} depth, ${shortCheck.canFillFull ? "OK" : "NOT ENOUGH"}`));
        console.log(chalk.yellow(`  Max fillable: $${fillableUsd.toFixed(2)}\n`));
        return;
      }

      // 4. Compute matched size in base asset (use the smaller side)
      // Round down to each exchange's lot size (inferred from orderbook)
      const inferDecimals = (levels: [string, string][]) => {
        for (const [, s] of levels) {
          const dot = s.indexOf(".");
          if (dot >= 0) return s.length - dot - 1;
        }
        return 0;
      };
      const longDecimals = inferDecimals(longBook.asks);
      const shortDecimals = inferDecimals(shortBook.bids);
      const decimals = Math.min(longDecimals, shortDecimals);
      const matchedBase = Math.min(longCheck.recommendedSize, shortCheck.recommendedSize);
      const matchedSize = (Math.floor(matchedBase * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
      const avgPrice = (longCheck.avgFillPrice + shortCheck.avgFillPrice) / 2;
      const matchedUsd = matchedBase * avgPrice;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Arb Exec: ${sym}${opts.smart ? " (smart order)" : ""}`));
        console.log(chalk.gray(`    LONG  ${longExch}: buy  ${matchedSize} (~$${(matchedBase * longCheck.avgFillPrice).toFixed(2)}, slippage ${longCheck.slippagePct.toFixed(3)}%)`));
        console.log(chalk.gray(`    SHORT ${shortExch}: sell ${matchedSize} (~$${(matchedBase * shortCheck.avgFillPrice).toFixed(2)}, slippage ${shortCheck.slippagePct.toFixed(3)}%)`));
        console.log(chalk.gray(`    Executing both legs simultaneously...\n`));
      }

      // 5. Execute both legs simultaneously
      const execLong = opts.smart
        ? smartOrder(longAdapter, sym, "buy", matchedSize).then(r => r.result)
        : longAdapter.marketOrder(sym, "buy", matchedSize);
      const execShort = opts.smart
        ? smartOrder(shortAdapter, sym, "sell", matchedSize).then(r => r.result)
        : shortAdapter.marketOrder(sym, "sell", matchedSize);
      const [longResult, shortResult] = await Promise.allSettled([execLong, execShort]);

      const longOk = longResult.status === "fulfilled";
      const shortOk = shortResult.status === "fulfilled";

      if (longOk && shortOk) {
        // 6. Verify both positions actually exist (some exchanges return success but silently reject)
        const [longPositions, shortPositions] = await Promise.all([
          longAdapter.getPositions().catch(() => []),
          shortAdapter.getPositions().catch(() => []),
        ]);
        const longPos = longPositions.find(p => p.symbol.toUpperCase().startsWith(sym));
        const shortPos = shortPositions.find(p => p.symbol.toUpperCase().startsWith(sym));

        if (!longPos && !shortPos) {
          // Both silently rejected
          const result = { status: "both_rejected", symbol: sym, size: matchedSize, message: "Both exchanges accepted order but no positions opened. Check min order size." };
          if (isJson()) return printJson(jsonOk(result));
          console.log(chalk.red(`  Both orders accepted but no positions opened. Min order size not met?\n`));
          return;
        }

        if (!longPos || !shortPos) {
          // One side silently rejected — close the other
          const openSide = longPos ? "long" : "short";
          const openAdapter = longPos ? longAdapter : shortAdapter;
          if (!isJson()) console.log(chalk.yellow(`  ${openSide} opened but other side silently rejected — closing ${openSide}...`));
          try { await openAdapter.marketOrder(sym, longPos ? "sell" : "buy", matchedSize); } catch { /* best effort */ }
          const result = { status: "silent_reject", symbol: sym, openedSide: openSide, closedSide: longPos ? "short" : "long", message: "One leg silently rejected (likely min order size). Rolled back." };
          if (isJson()) return printJson(jsonOk(result));
          console.log(chalk.yellow(`  Rolled back ${openSide} leg. Check exchange min order sizes.\n`));
          return;
        }

        logExecution({
          type: "arb_entry", exchange: `${longExch}+${shortExch}`,
          symbol: sym, side: "entry", size: matchedSize,
          status: "success", dryRun: false,
          meta: { longExch, shortExch, matchedUsd, longSlippage: longCheck.slippagePct, shortSlippage: shortCheck.slippagePct },
        });
        const result = {
          status: "filled", symbol: sym, size: matchedSize, notionalUsd: Math.round(matchedUsd * 100) / 100,
          long: { exchange: longExch, side: "buy", size: longPos.size, slippagePct: longCheck.slippagePct },
          short: { exchange: shortExch, side: "sell", size: shortPos.size, slippagePct: shortCheck.slippagePct },
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`  FILLED: ${sym} ${matchedSize} units (~$${matchedUsd.toFixed(2)})`));
        console.log(chalk.green(`    LONG  ${longExch} ✓ (${longPos.size})`));
        console.log(chalk.green(`    SHORT ${shortExch} ✓ (${shortPos.size})\n`));
      } else if (longOk !== shortOk) {
        // One leg failed — rollback
        const filledSide = longOk ? "long" : "short";
        const failedSide = longOk ? "short" : "long";
        const filledAdapter = longOk ? longAdapter : shortAdapter;
        const rollbackAction: "buy" | "sell" = longOk ? "sell" : "buy";
        const failedErr = longOk
          ? (shortResult as PromiseRejectedResult).reason
          : (longResult as PromiseRejectedResult).reason;

        if (!isJson()) console.log(chalk.yellow(`  PARTIAL: ${filledSide} OK, ${failedSide} FAILED — rolling back...`));

        let rollbackOk = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            if (opts.smart) {
              await smartOrder(filledAdapter, sym, rollbackAction, matchedSize, { reduceOnly: true });
            } else {
              await filledAdapter.marketOrder(sym, rollbackAction, matchedSize);
            }
            rollbackOk = true;
            break;
          } catch { /* retry */ }
        }

        logExecution({
          type: "arb_entry", exchange: `${longExch}+${shortExch}`,
          symbol: sym, side: "entry", size: matchedSize,
          status: "failed", dryRun: false,
          error: `Partial: ${failedSide} failed (${failedErr instanceof Error ? failedErr.message : String(failedErr)}). Rollback: ${rollbackOk ? "ok" : "FAILED"}`,
        });

        const result = {
          status: "partial_fill", symbol: sym, filledSide, failedSide,
          failedError: failedErr instanceof Error ? failedErr.message : String(failedErr),
          rollback: rollbackOk ? "success" : "FAILED — MANUAL CLOSE REQUIRED",
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(rollbackOk
          ? chalk.yellow(`  Rollback OK — no open exposure.\n`)
          : chalk.red.bold(`  ROLLBACK FAILED — ${filledSide} leg still open. Close manually!\n`));
      } else {
        // Both failed
        const longErr = (longResult as PromiseRejectedResult).reason;
        const shortErr = (shortResult as PromiseRejectedResult).reason;
        const result = {
          status: "both_failed", symbol: sym,
          longError: longErr instanceof Error ? longErr.message : String(longErr),
          shortError: shortErr instanceof Error ? shortErr.message : String(shortErr),
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.red(`  Both legs failed:`));
        console.log(chalk.red(`    LONG:  ${result.longError}`));
        console.log(chalk.red(`    SHORT: ${result.shortError}\n`));
      }
    });

  // ── arb spot-exec ── (spot+perp arb execution)

  arb
    .command("spot-exec")
    .description("Execute spot+perp arb: buy spot + short perp simultaneously")
    .argument("<symbol>", "Symbol (e.g. ETH, BTC)")
    .argument("<spotExch>", "Spot exchange: hl (Hyperliquid) or lt (Lighter)")
    .argument("<perpExch>", "Perp exchange: hl, lt, pac")
    .argument("<sizeUsd>", "Position size per leg in USD")
    .option("--max-slippage <pct>", "Max slippage % per leg", "0.5")
    .option("--leverage <n>", "Set leverage on perp side before entry")
    .option("--isolated", "Use isolated margin mode on perp side")
    .option("--dry-run", "Simulate without executing trades")
    .action(async (symbol: string, spotExch: string, perpExch: string, sizeUsdStr: string, opts: {
      maxSlippage: string; leverage?: string; isolated?: boolean; dryRun?: boolean;
    }) => {
      const sym = symbol.toUpperCase();
      const sizeUsd = parseFloat(sizeUsdStr);
      const maxSlippage = parseFloat(opts.maxSlippage);
      const dryRun = !!opts.dryRun || process.argv.includes("--dry-run");

      // Resolve exchange aliases
      const aliasMap: Record<string, string> = { hl: "hyperliquid", pac: "pacifica", lt: "lighter" };
      spotExch = aliasMap[spotExch.toLowerCase()] || spotExch.toLowerCase();
      perpExch = aliasMap[perpExch.toLowerCase()] || perpExch.toLowerCase();

      // Validate spot exchange
      if (!["hyperliquid", "lighter"].includes(spotExch)) {
        const msg = `Spot exchange must be hl or lt (got ${spotExch}). Pacifica is perp-only.`;
        if (isJson()) return printJson(jsonOk({ error: msg }));
        console.log(chalk.red(`  ${msg}`));
        return;
      }

      // Load spot adapter
      const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");
      const { LighterSpotAdapter } = await import("../exchanges/lighter-spot.js");

      let spotAdapter: import("../exchanges/spot-interface.js").SpotAdapter;
      if (spotExch === "hyperliquid") {
        const hlAdapter = await getAdapterForExchange("hyperliquid") as import("../exchanges/hyperliquid.js").HyperliquidAdapter;
        const hlSpot = new HyperliquidSpotAdapter(hlAdapter);
        await hlSpot.init();
        spotAdapter = hlSpot;
      } else {
        const ltAdapter = await getAdapterForExchange("lighter") as import("../exchanges/lighter.js").LighterAdapter;
        const ltSpot = new LighterSpotAdapter(ltAdapter);
        await ltSpot.init();
        spotAdapter = ltSpot;
      }

      const perpAdapter = await getAdapterForExchange(perpExch);

      // 1. Set perp leverage if requested
      if (opts.leverage) {
        const lev = parseInt(opts.leverage);
        const mode = opts.isolated ? "isolated" : "cross";
        if (!isJson()) console.log(chalk.gray(`  Setting perp leverage ${lev}x ${mode} on ${perpExch}...`));
        try {
          await perpAdapter.setLeverage(sym, lev, mode);
        } catch (e) {
          const msg = `Failed to set leverage: ${e instanceof Error ? e.message : e}`;
          if (isJson()) return printJson(jsonOk({ error: msg }));
          console.log(chalk.red(`  ${msg}`)); return;
        }
      }

      // 2. Auto-transfer USDC to spot account if needed
      if (spotExch === "hyperliquid") {
        const hlSpot = spotAdapter as import("../exchanges/hyperliquid-spot.js").HyperliquidSpotAdapter;
        const transferAmt = Math.ceil(sizeUsd * 1.1);
        try {
          const xferResult = await hlSpot.transferUsdcToSpot(transferAmt) as { status?: string; response?: string };
          if (xferResult?.status === "err" && xferResult.response?.includes("unified")) {
            if (!isJson()) console.log(chalk.gray(`  Unified account — no USDC transfer needed`));
          } else if (xferResult?.status !== "err") {
            if (!isJson()) console.log(chalk.gray(`  Transferred $${transferAmt} USDC perp→spot`));
            await new Promise(r => setTimeout(r, 500));
          }
        } catch {
          // Non-critical — may be unified account or already have balance
        }
      } else if (spotExch === "lighter") {
        // Lighter requires explicit USDC transfer from perp → spot account
        const ltSpot = spotAdapter as import("../exchanges/lighter-spot.js").LighterSpotAdapter;
        const transferAmt = Math.ceil(sizeUsd * 1.1);
        try {
          const xferResult = await ltSpot.transferUsdcToSpot(transferAmt);
          if (!isJson()) console.log(chalk.gray(`  Transferred $${transferAmt} USDC perp→spot on Lighter`));
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!isJson()) console.log(chalk.yellow(`  USDC transfer warning: ${msg}`));
          // Continue — spot order may still work if spot balance already exists
        }
      }

      // 3. Fetch orderbooks simultaneously
      const spotSymbol = `${sym}/USDC`;
      if (!isJson()) console.log(chalk.gray(`  Checking orderbook depth (spot ${spotExch} + perp ${perpExch})...`));
      const [spotBook, perpBook] = await Promise.all([
        spotAdapter.getSpotOrderbook(spotSymbol),
        perpAdapter.getOrderbook(sym),
      ]);

      // 3a. Price cross-validation: verify spot and perp are the same underlying
      //     Prevents wrong-token trades if index mapping is incorrect
      const spotMid = spotBook.bids.length > 0 && spotBook.asks.length > 0
        ? (Number(spotBook.bids[0][0]) + Number(spotBook.asks[0][0])) / 2 : 0;
      const perpMid = perpBook.bids.length > 0 && perpBook.asks.length > 0
        ? (Number(perpBook.bids[0][0]) + Number(perpBook.asks[0][0])) / 2 : 0;

      if (spotMid > 0 && perpMid > 0) {
        const priceDeviation = Math.abs(spotMid - perpMid) / perpMid * 100;
        if (priceDeviation > 5) {
          const msg = `Price mismatch: spot mid $${spotMid.toFixed(4)} vs perp mid $${perpMid.toFixed(4)} (${priceDeviation.toFixed(1)}% deviation). Possible wrong token index — aborting.`;
          if (isJson()) return printJson(jsonOk({ error: msg, spotMid, perpMid, deviationPct: priceDeviation }));
          console.log(chalk.red(`\n  ${msg}`));
          return;
        }
      } else if (spotMid === 0) {
        const msg = `Empty spot orderbook for ${sym} — cannot verify token identity`;
        if (isJson()) return printJson(jsonOk({ error: msg }));
        console.log(chalk.red(`\n  ${msg}`));
        return;
      }

      // 3b. Validate depth
      const spotCheck = computeExecutableSize(spotBook.asks, sizeUsd, maxSlippage);
      const perpCheck = computeExecutableSize(perpBook.bids, sizeUsd, maxSlippage);

      if (!spotCheck.canFillFull || !perpCheck.canFillFull) {
        const fillableUsd = Math.min(
          spotCheck.maxSize * spotCheck.avgFillPrice,
          perpCheck.maxSize * perpCheck.avgFillPrice,
        );
        if (isJson()) return printJson(jsonOk({
          error: "Insufficient orderbook depth",
          requestedUsd: sizeUsd, fillableUsd: Math.round(fillableUsd * 100) / 100,
          spot: { exchange: spotExch, depthUsd: spotCheck.depthUsd, canFill: spotCheck.canFillFull },
          perp: { exchange: perpExch, depthUsd: perpCheck.depthUsd, canFill: perpCheck.canFillFull },
        }));
        console.log(chalk.red(`\n  Insufficient depth for $${sizeUsd}:`));
        console.log(chalk.gray(`    ${spotExch} spot asks: $${spotCheck.depthUsd.toFixed(0)}`));
        console.log(chalk.gray(`    ${perpExch} perp bids: $${perpCheck.depthUsd.toFixed(0)}`));
        return;
      }

      // 4. Compute matched size
      const inferDecimals = (levels: [string, string][]) => {
        for (const [, s] of levels) {
          const dot = s.indexOf(".");
          if (dot >= 0) return s.length - dot - 1;
        }
        return 0;
      };
      const spotDecimals = inferDecimals(spotBook.asks);
      const perpDecimals = inferDecimals(perpBook.bids);
      const decimals = Math.min(spotDecimals, perpDecimals);
      const matchedBase = Math.min(spotCheck.recommendedSize, perpCheck.recommendedSize);
      const matchedSize = (Math.floor(matchedBase * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
      const avgPrice = (spotCheck.avgFillPrice + perpCheck.avgFillPrice) / 2;
      const matchedUsd = matchedBase * avgPrice;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Spot+Perp Arb: ${sym}`));
        console.log(chalk.gray(`    SPOT  ${spotExch}: buy  ${matchedSize} (~$${(matchedBase * spotCheck.avgFillPrice).toFixed(2)})`));
        console.log(chalk.gray(`    PERP  ${perpExch}: sell ${matchedSize} (~$${(matchedBase * perpCheck.avgFillPrice).toFixed(2)})`));
        console.log(chalk.gray(`    Executing both legs simultaneously...\n`));
      }

      // 5. Execute both legs (or return dry-run result)
      if (dryRun) {
        const result = {
          status: "filled", mode: "spot-perp", symbol: sym, dryRun: true,
          size: matchedSize, notionalUsd: Math.round(matchedUsd * 100) / 100,
          spot: { exchange: spotExch, side: "buy", size: matchedSize },
          perp: { exchange: perpExch, side: "sell", size: matchedSize },
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.cyan(`  [DRY-RUN] Would execute: spot buy ${matchedSize} on ${spotExch} + perp sell ${matchedSize} on ${perpExch}`));
        return;
      }

      // Same exchange (e.g. Lighter) shares nonce → must execute sequentially
      // Different exchanges → execute simultaneously for speed
      const validatePerpFill = (r: unknown) => {
        const res = r as { status?: string; response?: { type?: string; data?: { statuses?: Array<Record<string, unknown>> } } };
        const statuses = res?.response?.data?.statuses;
        if (statuses && statuses.length > 0) {
          const st = statuses[0];
          if (st.error) throw new Error(`Perp sell ${sym}: ${st.error}`);
          const filled = st.filled as { totalSz?: string } | undefined;
          if (filled && Number(filled.totalSz ?? 0) === 0) {
            throw new Error(`Perp sell ${sym}: 0 fill`);
          }
        }
        return r;
      };

      let spotResult: PromiseSettledResult<unknown>;
      let perpResult: PromiseSettledResult<unknown>;

      if (spotExch === perpExch) {
        // Sequential: spot first, then perp (avoids nonce collision on same exchange)
        spotResult = await spotAdapter.spotMarketOrder(spotSymbol, "buy", matchedSize)
          .then(r => ({ status: "fulfilled" as const, value: r }))
          .catch(e => ({ status: "rejected" as const, reason: e }));
        if (spotResult.status === "fulfilled") {
          perpResult = await perpAdapter.marketOrder(sym, "sell", matchedSize)
            .then(validatePerpFill)
            .then(r => ({ status: "fulfilled" as const, value: r }))
            .catch(e => ({ status: "rejected" as const, reason: e }));
        } else {
          perpResult = { status: "rejected" as const, reason: new Error("Skipped: spot failed") };
        }
      } else {
        // Parallel: different exchanges, no nonce conflict
        [spotResult, perpResult] = await Promise.allSettled([
          spotAdapter.spotMarketOrder(spotSymbol, "buy", matchedSize),
          perpAdapter.marketOrder(sym, "sell", matchedSize).then(validatePerpFill),
        ]);
      }

      const spotOk = spotResult.status === "fulfilled";
      const perpOk = perpResult.status === "fulfilled";

      if (spotOk && perpOk) {
        // Log execution
        logExecution({
          type: "arb_entry", exchange: `spot:${spotExch}+${perpExch}`,
          symbol: sym, side: "entry", size: matchedSize,
          status: "success", dryRun: false,
          meta: { mode: "spot-perp", spotExch, perpExch, matchedUsd },
        });

        // Persist position state
        persistAddPosition({
          id: `${sym}-spot-${Date.now()}`,
          symbol: sym,
          longExchange: spotExch,
          shortExchange: perpExch,
          longSize: parseFloat(matchedSize),
          shortSize: parseFloat(matchedSize),
          entryTime: new Date().toISOString(),
          entrySpread: 0, // Will be updated on next scan
          entryLongPrice: spotCheck.avgFillPrice,
          entryShortPrice: perpCheck.avgFillPrice,
          accumulatedFunding: 0,
          lastCheckTime: new Date().toISOString(),
          mode: "spot-perp",
          spotExchange: spotExch,
          spotSymbol: spotSymbol,
        });

        // Return leftover USDC from spot back to perp (non-unified HL accounts)
        if (spotExch === "hyperliquid") {
          try {
            const hlSpot = spotAdapter as import("../exchanges/hyperliquid-spot.js").HyperliquidSpotAdapter;
            const bals = await hlSpot.getSpotBalances();
            const usdcBal = bals.find(b => b.token.startsWith("USDC"));
            const leftover = Number(usdcBal?.available ?? 0);
            if (leftover > 1) {
              const xfer = await hlSpot.transferUsdcToPerp(Math.floor(leftover)) as { status?: string; response?: string };
              if (xfer?.status !== "err") {
                if (!isJson()) console.log(chalk.gray(`  Returned ~$${Math.floor(leftover)} USDC to perp account`));
              }
            }
          } catch { /* non-critical — unified accounts don't need transfer */ }
        }

        const result = {
          status: "filled", mode: "spot-perp", symbol: sym,
          size: matchedSize, notionalUsd: Math.round(matchedUsd * 100) / 100,
          spot: { exchange: spotExch, side: "buy", size: matchedSize },
          perp: { exchange: perpExch, side: "sell", size: matchedSize },
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`  FILLED: ${sym} ${matchedSize} units (~$${matchedUsd.toFixed(2)})`));
        console.log(chalk.green(`    SPOT  ${spotExch} ✓ (bought ${matchedSize})`));
        console.log(chalk.green(`    PERP  ${perpExch} ✓ (shorted ${matchedSize})\n`));
      } else if (spotOk !== perpOk) {
        // One leg failed — rollback
        const filledSide = spotOk ? "spot" : "perp";
        const failedSide = spotOk ? "perp" : "spot";
        const failedErr = spotOk
          ? (perpResult as PromiseRejectedResult).reason
          : (spotResult as PromiseRejectedResult).reason;
        const failedErrMsg = failedErr instanceof Error ? failedErr.message : String(failedErr);

        if (!isJson()) {
          console.log(chalk.yellow(`  PARTIAL: ${filledSide} OK, ${failedSide} FAILED — rolling back...`));
          console.log(chalk.red(`    Reason: ${failedErrMsg}`));
        }

        let rollbackOk = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            if (spotOk) {
              await spotAdapter.spotMarketOrder(spotSymbol, "sell", matchedSize);
            } else {
              await perpAdapter.marketOrder(sym, "buy", matchedSize);
            }
            rollbackOk = true;
            break;
          } catch { /* retry */ }
        }

        logExecution({
          type: "arb_entry", exchange: `spot:${spotExch}+${perpExch}`,
          symbol: sym, side: "entry", size: matchedSize,
          status: "failed", dryRun: false,
          error: `Partial: ${failedSide} failed (${failedErrMsg}). Rollback: ${rollbackOk ? "ok" : "FAILED"}`,
        });

        const result = {
          status: "partial_fill", mode: "spot-perp", symbol: sym,
          filledSide, failedSide,
          failedError: failedErrMsg,
          rollback: rollbackOk ? "success" : "FAILED — MANUAL CLOSE REQUIRED",
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(rollbackOk
          ? chalk.yellow(`  Rollback OK — no open exposure.\n`)
          : chalk.red.bold(`  ROLLBACK FAILED — ${filledSide} leg still open. Close manually!\n`));
      } else {
        // Both failed
        const spotErr = (spotResult as PromiseRejectedResult).reason;
        const perpErr = (perpResult as PromiseRejectedResult).reason;
        const result = {
          status: "both_failed", mode: "spot-perp", symbol: sym,
          spotError: spotErr instanceof Error ? spotErr.message : String(spotErr),
          perpError: perpErr instanceof Error ? perpErr.message : String(perpErr),
        };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.red(`  Both legs failed:`));
        console.log(chalk.red(`    SPOT:  ${result.spotError}`));
        console.log(chalk.red(`    PERP:  ${result.perpError}\n`));
      }
    });

  // ── arb spot-close ── (close spot+perp arb position)

  arb
    .command("spot-close")
    .description("Close a spot+perp arb position: sell spot + buy back perp")
    .argument("<symbol>", "Symbol (e.g. ETH)")
    .option("--spot-exch <exchange>", "Spot exchange (hl or lt)")
    .option("--perp-exch <exchange>", "Perp exchange (hl, lt, pac)")
    .action(async (symbol: string, opts: { spotExch?: string; perpExch?: string }) => {
      const sym = symbol.toUpperCase();

      // Try to find the position from state
      const state = loadArbState();
      const pos = state?.positions.find(p =>
        p.symbol.toUpperCase() === sym && p.mode === "spot-perp"
      );

      const aliasMap: Record<string, string> = { hl: "hyperliquid", pac: "pacifica", lt: "lighter" };
      const spotExch = aliasMap[opts.spotExch?.toLowerCase() ?? ""] || opts.spotExch?.toLowerCase() || pos?.spotExchange || pos?.longExchange;
      const perpExch = aliasMap[opts.perpExch?.toLowerCase() ?? ""] || opts.perpExch?.toLowerCase() || pos?.shortExchange;

      if (!spotExch || !perpExch) {
        const msg = "Cannot determine exchanges. Specify --spot-exch and --perp-exch, or ensure the position is tracked in state.";
        if (isJson()) return printJson(jsonOk({ error: msg }));
        console.log(chalk.red(`  ${msg}`));
        return;
      }

      // Load adapters
      const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");
      const { LighterSpotAdapter } = await import("../exchanges/lighter-spot.js");

      let spotAdapter: import("../exchanges/spot-interface.js").SpotAdapter;
      if (spotExch === "hyperliquid") {
        const hlAdapter = await getAdapterForExchange("hyperliquid") as import("../exchanges/hyperliquid.js").HyperliquidAdapter;
        const hlSpot = new HyperliquidSpotAdapter(hlAdapter);
        await hlSpot.init();
        spotAdapter = hlSpot;
      } else {
        const ltAdapter = await getAdapterForExchange("lighter") as import("../exchanges/lighter.js").LighterAdapter;
        const ltSpot = new LighterSpotAdapter(ltAdapter);
        await ltSpot.init();
        spotAdapter = ltSpot;
      }

      const perpAdapter = await getAdapterForExchange(perpExch);
      const spotSymbol = `${sym}/USDC`;

      // Find how much to close
      const perpPositions = await perpAdapter.getPositions();
      const perpPos = perpPositions.find(p =>
        p.symbol.replace("-PERP", "").toUpperCase() === sym && p.side === "short"
      );

      if (!perpPos) {
        const msg = `No short perp position found for ${sym} on ${perpExch}`;
        if (isJson()) return printJson(jsonOk({ error: msg }));
        console.log(chalk.red(`  ${msg}`)); return;
      }

      const closeSize = perpPos.size;
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Closing Spot+Perp Arb: ${sym}`));
        console.log(chalk.gray(`    SPOT  ${spotExch}: sell ${closeSize}`));
        console.log(chalk.gray(`    PERP  ${perpExch}: buy  ${closeSize} (close short)`));
        console.log(chalk.gray(`    Executing...\n`));
      }

      // Same exchange → sequential (nonce collision), different → parallel
      let spotResult: PromiseSettledResult<unknown>;
      let perpResult: PromiseSettledResult<unknown>;

      if (spotExch === perpExch) {
        // Sequential: sell spot first, then close perp
        spotResult = await spotAdapter.spotMarketOrder(spotSymbol, "sell", closeSize)
          .then(r => ({ status: "fulfilled" as const, value: r }))
          .catch(e => ({ status: "rejected" as const, reason: e }));
        perpResult = await perpAdapter.marketOrder(sym, "buy", closeSize)
          .then(r => ({ status: "fulfilled" as const, value: r }))
          .catch(e => ({ status: "rejected" as const, reason: e }));
      } else {
        [spotResult, perpResult] = await Promise.allSettled([
          spotAdapter.spotMarketOrder(spotSymbol, "sell", closeSize),
          perpAdapter.marketOrder(sym, "buy", closeSize),
        ]);
      }

      const spotOk = spotResult.status === "fulfilled";
      const perpOk = perpResult.status === "fulfilled";

      if (spotOk && perpOk) {
        // Remove from state
        persistRemovePosition(sym);

        logExecution({
          type: "arb_close", exchange: `spot:${spotExch}+${perpExch}`,
          symbol: sym, side: "exit", size: closeSize,
          status: "success", dryRun: false,
          meta: { mode: "spot-perp" },
        });

        // Return spot USDC proceeds back to perp account
        if (spotExch === "lighter") {
          try {
            const ltSpot = spotAdapter as import("../exchanges/lighter-spot.js").LighterSpotAdapter;
            const bals = await ltSpot.getSpotBalances();
            const usdcBal = bals.find(b => b.token === "USDC");
            const leftover = Number(usdcBal?.available ?? 0);
            if (leftover > 0.01) {
              await ltSpot.transferUsdcToPerp(leftover);
              if (!isJson()) console.log(chalk.gray(`  Returned ~$${leftover.toFixed(2)} USDC spot→perp on Lighter`));
            }
          } catch { /* non-critical */ }
        } else if (spotExch === "hyperliquid") {
          try {
            const hlSpot = spotAdapter as import("../exchanges/hyperliquid-spot.js").HyperliquidSpotAdapter;
            const bals = await hlSpot.getSpotBalances();
            const usdcBal = bals.find(b => b.token.startsWith("USDC"));
            const leftover = Number(usdcBal?.available ?? 0);
            if (leftover > 1) {
              await hlSpot.transferUsdcToPerp(Math.floor(leftover));
            }
          } catch { /* non-critical */ }
        }

        if (isJson()) return printJson(jsonOk({ status: "closed", mode: "spot-perp", symbol: sym, size: closeSize }));
        console.log(chalk.green(`  CLOSED: ${sym} ${closeSize} units`));
        console.log(chalk.green(`    SPOT  ${spotExch}: sold ✓`));
        console.log(chalk.green(`    PERP  ${perpExch}: bought (closed short) ✓\n`));
      } else {
        const errors: string[] = [];
        if (!spotOk) errors.push(`Spot sell failed: ${(spotResult as PromiseRejectedResult).reason}`);
        if (!perpOk) errors.push(`Perp buy failed: ${(perpResult as PromiseRejectedResult).reason}`);
        const result = { status: "partial_close", symbol: sym, spotOk, perpOk, errors };
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.red(`  Close partially failed:`));
        for (const e of errors) console.log(chalk.red(`    ${e}`));
        console.log(chalk.yellow(`  Manual intervention may be needed.\n`));
      }
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
      const TAKER_FEE = getTakerFee("default");

      // Fetch actual settled funding payments from each exchange
      const actualFundingByExSymbol = new Map<string, number>(); // "exchange:SYMBOL" → total settled USD
      for (const exName of exchangeNames) {
        try {
          const adapter = await getAdapterForExchange(exName);
          const payments = await adapter.getFundingPayments(100);
          for (const fp of payments) {
            const sym = fp.symbol.replace("-PERP", "").toUpperCase();
            const key = `${exName}:${sym}`;
            actualFundingByExSymbol.set(key, (actualFundingByExSymbol.get(key) ?? 0) + Number(fp.payment));
          }
        } catch {
          // exchange not configured or API error, skip
        }
      }

      if (isJson()) {
        const result = [...bySymbol.entries()].map(([symbol, positions]) => {
          const spread = spreadMap.get(symbol);
          // Sum actual funding across exchanges for this symbol
          let actualFunding = 0;
          for (const p of positions) {
            actualFunding += actualFundingByExSymbol.get(`${p.exchange}:${symbol}`) ?? 0;
          }
          return { symbol, positions, currentSpread: spread?.spread ?? 0, actualFunding };
        });
        return printJson(jsonOk(result));
      }

      let totalUpnl = 0;
      let totalFees = 0;
      let totalEstFunding = 0;
      let totalActualFunding = 0;

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
          const grossSpread = Math.abs(spread.spread);
          const rtCost = computeRoundTripCostPct(spread.longExch, spread.shortExch);
          const netSpread = computeNetSpread(grossSpread, 7, rtCost, 0.5, 100);
          const grossColor = grossSpread >= 20 ? chalk.green : grossSpread >= 10 ? chalk.yellow : chalk.gray;
          const netColor = netSpread >= 15 ? chalk.green : netSpread >= 0 ? chalk.yellow : chalk.red;
          // Estimate hourly funding income for this pair
          const longPos = positions.find(p => p.side === "long");
          const shortPos = positions.find(p => p.side === "short");
          if (longPos && shortPos) {
            const avgNotional = (longPos.size * longPos.mark + shortPos.size * shortPos.mark) / 2;
            const hourlyIncome = (grossSpread / 100) / (24 * 365) * avgNotional;
            const dailyIncome = hourlyIncome * 24;
            console.log(chalk.cyan(
              `    Gross: ${grossColor(`${grossSpread.toFixed(1)}%`)} | ` +
              `Net: ${netColor(`${netSpread.toFixed(1)}%`)} | ` +
              `Fees: ${chalk.gray(`${rtCost.toFixed(2)}%`)} | ` +
              `Est. income: $${hourlyIncome.toFixed(4)}/hr, $${dailyIncome.toFixed(3)}/day`
            ));

            // Look up entry time from execution log for funding estimation
            const entryLog = readExecutionLog({ type: "arb_entry", symbol }).filter(e => e.status === "success")[0];
            const entryTime = entryLog?.timestamp ? new Date(entryLog.timestamp).getTime() : null;
            const holdHours = entryTime ? (Date.now() - entryTime) / (1000 * 60 * 60) : null;

            // Estimated funding based on current spread × hold time
            const estFunding = holdHours !== null ? hourlyIncome * holdHours : 0;

            // Actual settled funding from exchange APIs
            let actualFunding = 0;
            for (const p of positions) {
              actualFunding += actualFundingByExSymbol.get(`${p.exchange}:${symbol}`) ?? 0;
            }

            totalEstFunding += estFunding;
            totalActualFunding += actualFunding;

            const diff = actualFunding - estFunding;
            const diffColor = Math.abs(diff) < 0.01 ? chalk.gray : diff >= 0 ? chalk.green : chalk.red;
            const fmtVal = (v: number) => v >= 0 ? `$${v.toFixed(4)}` : `-$${Math.abs(v).toFixed(4)}`;
            console.log(chalk.white(
              `    Funding: Est. ${chalk.yellow(fmtVal(estFunding))} / ` +
              `Actual ${chalk.cyan(fmtVal(actualFunding))} / ` +
              `Diff: ${diffColor(fmtVal(diff))}`
            ));
          }
        }
        console.log();
      }

      // Summary
      const exitFees = allPositions.reduce((s, p) => s + p.size * p.mark * TAKER_FEE, 0);
      totalFees += exitFees;
      const netPnl = totalUpnl - totalFees + totalActualFunding;

      console.log(chalk.white.bold("  Summary"));
      const upnlColor = totalUpnl >= 0 ? chalk.green : chalk.red;
      const netColor = netPnl >= 0 ? chalk.green : chalk.red;
      console.log(`    Unrealized PnL:  ${upnlColor(`$${totalUpnl.toFixed(4)}`)}`);
      console.log(`    Est. fees (in+out): ${chalk.red(`-$${totalFees.toFixed(4)}`)}`);
      if (totalActualFunding !== 0 || totalEstFunding !== 0) {
        const fundingDiff = totalActualFunding - totalEstFunding;
        const diffPct = totalEstFunding !== 0 ? ((fundingDiff / Math.abs(totalEstFunding)) * 100).toFixed(1) : "N/A";
        console.log(`    Est. funding:    ${chalk.yellow(`$${totalEstFunding.toFixed(4)}`)}`);
        console.log(`    Actual funding:  ${chalk.cyan(`$${totalActualFunding.toFixed(4)}`)}`);
        console.log(`    Funding diff:    ${fundingDiff >= 0 ? chalk.green(`+$${fundingDiff.toFixed(4)}`) : chalk.red(`-$${Math.abs(fundingDiff).toFixed(4)}`)} (${diffPct}%)`);
      }
      console.log(`    Net (if closed now): ${netColor(`$${netPnl.toFixed(4)}`)}`);
      console.log(chalk.gray(`    (Fees assume ${(TAKER_FEE * 100).toFixed(3)}% taker. Actual may vary.)`));
      console.log(chalk.gray(`    * Net includes actual settled funding where available.\n`));
    });

  // ── arb monitor ── (live monitoring with liquidity)

  arb
    .command("monitor")
    .description("Live-monitor funding spreads with liquidity data")
    .option("--min <pct>", "Min annual spread to show", "20")
    .option("--interval <sec>", "Refresh interval in seconds", "60")
    .option("--top <n>", "Show top N opportunities", "15")
    .option("--check-liquidity", "Check orderbook depth (slower)")
    .option("--hold-days <days>", "Expected hold period for net spread calc", "7")
    .option("--bridge-cost <usd>", "One-way bridge cost in USD", "0.5")
    .option("--size <usd>", "Position size per leg ($) for cost calc", "100")
    .action(async (opts: { min: string; interval: string; top: string; checkLiquidity?: boolean; holdDays: string; bridgeCost: string; size: string }) => {
      const minSpread = parseFloat(opts.min);
      const intervalSec = parseInt(opts.interval);
      const topN = parseInt(opts.top);
      const checkLiq = opts.checkLiquidity ?? false;
      const holdDays = parseFloat(opts.holdDays);
      const bridgeCostUsd = parseFloat(opts.bridgeCost);
      const sizeUsd = parseFloat(opts.size);
      let cycle = 0;

      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Funding Arb Monitor"));
        console.log(chalk.gray(`  Min spread: ${minSpread}% | Refresh: ${intervalSec}s | Top: ${topN}`));
        console.log(chalk.gray(`  Net spread: ${holdDays}d hold, $${bridgeCostUsd} bridge, $${sizeUsd} size`));
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
              const grossSpread = Math.abs(s.spread);
              const rtCost = computeRoundTripCostPct(s.longExch, s.shortExch);
              const netSpread = computeNetSpread(grossSpread, holdDays, rtCost, bridgeCostUsd, sizeUsd);
              const grossColor = grossSpread >= 50 ? chalk.green.bold
                : grossSpread >= 30 ? chalk.green
                : chalk.yellow;
              const netColor = netSpread >= 20 ? chalk.green : netSpread >= 0 ? chalk.yellow : chalk.red;

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
                `${grossColor(`${grossSpread.toFixed(1)}%`.padEnd(8))} ` +
                `${netColor(`net:${netSpread.toFixed(1)}%`.padEnd(12))} ` +
                `${direction.padEnd(7)} ` +
                rates.join(" ") +
                liqInfo
              );
            }
            console.log(chalk.gray(`  * Net spreads are predicted estimates (${holdDays}d hold, $${bridgeCostUsd} bridge)`));
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
                      symbol: pos.underlying, side: "close", size: String(pos.size),
                      status: "success", dryRun: false,
                      meta: { longDex: pos.longDex, shortDex: pos.shortDex, reason, longSymbol: pos.longSymbol, shortSymbol: pos.shortSymbol },
                    });
                    if (!isJson()) console.log(chalk.green(`  ${now} CLOSED ${pos.underlying} — both legs`));
                  } catch (err) {
                    logExecution({
                      type: "arb_close", exchange: `${pos.longDex}+${pos.shortDex}`,
                      symbol: pos.underlying, side: "close", size: String(pos.size),
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
  const { HYPERLIQUID_API_URL } = await import("../shared-api.js");
  const res = await fetch(HYPERLIQUID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: symbol }),
  });
  const json = await res.json();
  const bids = json.levels?.[0] ?? [];
  return bids.slice(0, 10).map((l: Record<string, string>) => [Number(l.px), Number(l.sz)] as [number, number]);
}

async function fetchLighterOrderbook(symbol: string): Promise<[number, number][]> {
  const { LIGHTER_API_URL } = await import("../shared-api.js");
  const detailsRes = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookDetails`);
  const details = await detailsRes.json();
  const m = ((details as Record<string, unknown>).order_book_details as Array<Record<string, unknown>> ?? [])
    .find(d => d.symbol === symbol);
  if (!m) return [];
  const marketId = Number(m.market_id);
  const obRes = await fetch(`${LIGHTER_API_URL}/api/v1/orderBookOrders?market_id=${marketId}&limit=10`);
  const ob = await obRes.json();
  const bids = (ob as Record<string, unknown>).bids as Array<Record<string, string>> ?? [];
  return bids.map(l => [Number(l.price), Number(l.remaining_base_amount)] as [number, number]);
}
