import { Command } from "commander";
import type { ExchangeAdapter, ExchangeBalance, ExchangePosition, ExchangeOrder } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { makeTable, formatUsd, formatPnl, printJson, jsonOk, jsonError, symbolMatch, withJsonErrors } from "../utils.js";
import chalk from "chalk";
import { assessRisk, type RiskLevel, type RiskViolation } from "../risk.js";

// ── Portfolio types & helpers ──

interface ExchangeSnapshot {
  exchange: string;
  connected: boolean;
  balance: ExchangeBalance | null;
  positions: ExchangePosition[];
  openOrders: number;
  error?: string;
}

interface PortfolioSummary {
  totalEquity: number;
  totalAvailable: number;
  totalMarginUsed: number;
  totalUnrealizedPnl: number;
  totalPositions: number;
  totalOpenOrders: number;
  exchanges: ExchangeSnapshot[];
  positions: (ExchangePosition & { exchange: string })[];
  riskMetrics: {
    marginUtilization: number;  // marginUsed / equity %
    largestPosition: { symbol: string; exchange: string; notional: number } | null;
    exchangeConcentration: { exchange: string; pct: number }[];
  };
  risk: {
    level: RiskLevel;
    canTrade: boolean;
    violations: RiskViolation[];
  };
}

const EXCHANGES = ["pacifica", "hyperliquid", "lighter"] as const;

async function fetchExchangeSnapshot(
  name: string,
  getAdapter: (ex: string) => Promise<ExchangeAdapter>,
): Promise<ExchangeSnapshot> {
  try {
    const adapter = await getAdapter(name);
    const [balance, positions, orders] = await Promise.all([
      adapter.getBalance(),
      adapter.getPositions(),
      adapter.getOpenOrders(),
    ]);
    return {
      exchange: name,
      connected: true,
      balance,
      positions,
      openOrders: orders.length,
    };
  } catch (err) {
    return {
      exchange: name,
      connected: false,
      balance: null,
      positions: [],
      openOrders: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildSummary(snapshots: ExchangeSnapshot[]): PortfolioSummary {
  let totalEquity = 0;
  let totalAvailable = 0;
  let totalMarginUsed = 0;
  let totalUnrealizedPnl = 0;
  let totalPositions = 0;
  let totalOpenOrders = 0;
  const allPositions: (ExchangePosition & { exchange: string })[] = [];

  for (const snap of snapshots) {
    if (snap.balance) {
      totalEquity += Number(snap.balance.equity);
      totalAvailable += Number(snap.balance.available);
      totalMarginUsed += Number(snap.balance.marginUsed);
      totalUnrealizedPnl += Number(snap.balance.unrealizedPnl);
    }
    totalPositions += snap.positions.length;
    totalOpenOrders += snap.openOrders;
    for (const pos of snap.positions) {
      allPositions.push({ ...pos, exchange: snap.exchange });
    }
  }

  // Risk metrics
  const marginUtilization = totalEquity > 0 ? (totalMarginUsed / totalEquity) * 100 : 0;

  let largestPosition: PortfolioSummary['riskMetrics']['largestPosition'] = null;
  for (const pos of allPositions) {
    const notional = Math.abs(Number(pos.size) * Number(pos.markPrice));
    if (!largestPosition || notional > largestPosition.notional) {
      largestPosition = { symbol: pos.symbol, exchange: pos.exchange, notional };
    }
  }

  const exchangeConcentration = snapshots
    .filter(s => s.balance && Number(s.balance.equity) > 0)
    .map(s => ({
      exchange: s.exchange,
      pct: totalEquity > 0 ? (Number(s.balance!.equity) / totalEquity) * 100 : 0,
    }))
    .sort((a, b) => b.pct - a.pct);

  // Full risk assessment (reuses same data, no extra API calls)
  const riskBalances = snapshots
    .filter(s => s.balance)
    .map(s => ({ exchange: s.exchange, balance: s.balance! }));
  const riskPositions = allPositions.map(p => ({ exchange: p.exchange, position: p }));
  const assessment = assessRisk(riskBalances, riskPositions);

  return {
    totalEquity,
    totalAvailable,
    totalMarginUsed,
    totalUnrealizedPnl,
    totalPositions,
    totalOpenOrders,
    exchanges: snapshots,
    positions: allPositions,
    riskMetrics: {
      marginUtilization,
      largestPosition,
      exchangeConcentration,
    },
    risk: {
      level: assessment.level,
      canTrade: assessment.canTrade,
      violations: assessment.violations,
    },
  };
}

function pac(adapter: ExchangeAdapter): PacificaAdapter {
  if (!(adapter instanceof PacificaAdapter)) throw new Error("Market settings are only available on Pacifica.");
  return adapter;
}

export function registerAccountCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
) {
  const account = program.command("account").description("Account commands");

  // ── Single exchange balance fetch (used by both single + multi mode) ──

  interface ExBalanceResult {
    exchange: string;
    perp: ExchangeBalance;
    spot: { token: string; total: string; available: string; held: string; valueUsd?: number }[];
    funding24h: number;
    fundingPayments24h: number;
    totalSpotValueUsd: number;
    totalAccountValueUsd: number;
    unifiedAccount: boolean;  // HL unified: perp equity already includes spot USDC
  }

  async function fetchExchangeBalance(
    exName: string,
    adapter: ExchangeAdapter,
  ): Promise<ExBalanceResult> {
    const name = exName.toLowerCase();

    const [bal, fundingPayments] = await Promise.all([
      adapter.getBalance(),
      adapter.getFundingPayments(200).catch(() => [] as { time: number; symbol: string; payment: string }[]),
    ]);

    let spotBalances: { token: string; total: string; available: string; held: string; valueUsd?: number }[] = [];
    try {
      if (name === "hyperliquid") {
        const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");
        const hlSpot = new HyperliquidSpotAdapter(adapter as HyperliquidAdapter);
        await hlSpot.init();
        const raw = await hlSpot.getSpotBalances();
        const markets = await hlSpot.getSpotMarkets();
        const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
        const stripSuffix = (t: string) => t.replace(/-SPOT$/i, "").toUpperCase();
        spotBalances = raw
          .filter(b => Number(b.total) > 0)
          .map(b => {
            const base = stripSuffix(b.token);
            return {
              ...b,
              valueUsd: base === "USDC" ? Number(b.total) : (priceMap.get(base) ?? 0) * Number(b.total),
            };
          });
      } else if (name === "lighter") {
        const { LighterAdapter } = await import("../exchanges/lighter.js");
        const { LighterSpotAdapter } = await import("../exchanges/lighter-spot.js");
        const ltSpot = new LighterSpotAdapter(adapter as InstanceType<typeof LighterAdapter>);
        await ltSpot.init();
        const raw = await ltSpot.getSpotBalances();
        const markets = await ltSpot.getSpotMarkets();
        const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
        spotBalances = raw
          .filter(b => Number(b.total) > 0)
          .map(b => ({
            ...b,
            valueUsd: b.token === "USDC" || b.token === "USDC_SPOT"
              ? Number(b.total)
              : (priceMap.get(b.token.toUpperCase()) ?? 0) * Number(b.total),
          }));
      }
    } catch { /* spot not available */ }

    // HL unified account: perp equity already includes spot USDC balance.
    // Detect by checking if adapter is HL without a dex override.
    const isUnified = name === "hyperliquid" && !(adapter as HyperliquidAdapter).dex;

    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    const recent = fundingPayments.filter(f => f.time >= cutoff24h);
    const funding24h = recent.reduce((sum, f) => sum + Number(f.payment), 0);
    const totalSpotUsd = spotBalances.reduce((s, b) => s + (b.valueUsd ?? 0), 0);

    // For unified accounts, equity already contains USDC spot value.
    // Only add non-USDC spot token values to avoid double-counting.
    const nonUsdcSpotUsd = isUnified
      ? spotBalances
          .filter(b => {
            const tk = b.token.replace(/-SPOT$/i, "").toUpperCase();
            return tk !== "USDC";
          })
          .reduce((s, b) => s + (b.valueUsd ?? 0), 0)
      : totalSpotUsd;

    return {
      exchange: name,
      perp: bal,
      spot: spotBalances,
      funding24h,
      fundingPayments24h: recent.length,
      totalSpotValueUsd: totalSpotUsd,
      totalAccountValueUsd: Number(bal.equity) + nonUsdcSpotUsd,
      unifiedAccount: isUnified,
    };
  }

  function printSingleBalance(exName: string, r: ExBalanceResult) {
    console.log(chalk.cyan.bold(`\n  ${exName.toUpperCase()} Account Balance`));
    if (r.unifiedAccount) console.log(chalk.gray("  (Unified account — perp & spot share single balance)\n"));
    else console.log();

    console.log(chalk.white.bold(r.unifiedAccount ? "  Account" : "  Perp Account"));
    console.log(`    Equity:       $${formatUsd(r.perp.equity)}`);
    console.log(`    Available:    $${formatUsd(r.perp.available)}`);
    console.log(`    Margin Used:  $${formatUsd(r.perp.marginUsed)}`);
    console.log(`    Unreal. PnL:  ${formatPnl(r.perp.unrealizedPnl)}`);

    // For unified, show non-USDC spot holdings (USDC is already in equity)
    const displaySpot = r.unifiedAccount
      ? r.spot.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
      : r.spot;

    if (displaySpot.length > 0) {
      console.log(chalk.white.bold("\n  Spot Holdings"));
      const rows = displaySpot.map(b => [
        chalk.white.bold(b.token),
        b.total,
        b.available,
        b.held !== "0" ? b.held : chalk.gray("-"),
        b.valueUsd ? `$${formatUsd(b.valueUsd)}` : chalk.gray("-"),
      ]);
      console.log(makeTable(["Token", "Total", "Available", "Held", "Value"], rows));
    }

    console.log(chalk.white.bold("  Funding (24h)"));
    console.log(`    Payments:     ${r.fundingPayments24h}`);
    console.log(`    Total:        ${formatPnl(r.funding24h)}`);

    // Only show Total breakdown when there are non-USDC spot tokens adding value
    const nonUsdcSpotValue = displaySpot.reduce((s, b) => s + (b.valueUsd ?? 0), 0);
    if (nonUsdcSpotValue > 0) {
      console.log(chalk.white.bold("\n  Total"));
      console.log(`    Equity:       $${formatUsd(r.perp.equity)}`);
      console.log(`    Spot (other): $${formatUsd(nonUsdcSpotValue)}`);
      console.log(`    Total Value:  $${formatUsd(r.totalAccountValueUsd)}`);
    }
  }

  account
    .command("balance")
    .description("Account overview: perp balance, spot holdings, and 24h funding")
    .action(async () => {
      // Detect if user explicitly set -e (single exchange mode)
      const explicitExchange = program.getOptionValueSource?.("exchange") === "cli";

      // Multi-exchange mode: show all exchanges
      if (!explicitExchange && getAdapterForExchange) {
        const results: ExBalanceResult[] = [];
        const errors: Record<string, string> = {};

        await Promise.all(EXCHANGES.map(async (ex) => {
          try {
            const adapter = await getAdapterForExchange(ex);
            results.push(await fetchExchangeBalance(ex, adapter));
          } catch (err) {
            errors[ex] = err instanceof Error ? err.message : String(err);
          }
        }));

        // Sort by equity desc
        results.sort((a, b) => b.totalAccountValueUsd - a.totalAccountValueUsd);

        if (isJson()) {
          const grandTotal = results.reduce((s, r) => s + r.totalAccountValueUsd, 0);
          return printJson(jsonOk({
            exchanges: results,
            errors: Object.keys(errors).length > 0 ? errors : undefined,
            totalEquity: results.reduce((s, r) => s + Number(r.perp.equity), 0),
            totalSpotValueUsd: results.reduce((s, r) => {
              if (r.unifiedAccount) {
                return s + r.spot
                  .filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
                  .reduce((ss, b) => ss + (b.valueUsd ?? 0), 0);
              }
              return s + r.totalSpotValueUsd;
            }, 0),
            totalAccountValueUsd: grandTotal,
            totalFunding24h: results.reduce((s, r) => s + r.funding24h, 0),
          }));
        }

        console.log(chalk.cyan.bold("\n  All Exchanges — Account Balance\n"));

        // Summary table
        // For unified accounts, Spot column shows non-USDC only (USDC already in Equity)
        const balRows = results.map(r => {
          const nonUsdcSpot = r.unifiedAccount
            ? r.spot
                .filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
                .reduce((s, b) => s + (b.valueUsd ?? 0), 0)
            : r.totalSpotValueUsd;
          return [
            chalk.white.bold(r.exchange) + (r.unifiedAccount ? chalk.gray(" ★") : ""),
            `$${formatUsd(r.perp.equity)}`,
            `$${formatUsd(r.perp.available)}`,
            `$${formatUsd(r.perp.marginUsed)}`,
            nonUsdcSpot > 0 ? `$${formatUsd(nonUsdcSpot)}` : chalk.gray("-"),
            formatPnl(r.funding24h),
            `$${formatUsd(r.totalAccountValueUsd)}`,
          ];
        });

        const grandEquity = results.reduce((s, r) => s + Number(r.perp.equity), 0);
        const grandSpot = results.reduce((s, r) => {
          if (r.unifiedAccount) {
            return s + r.spot
              .filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
              .reduce((ss, b) => ss + (b.valueUsd ?? 0), 0);
          }
          return s + r.totalSpotValueUsd;
        }, 0);
        const grandFunding = results.reduce((s, r) => s + r.funding24h, 0);
        const grandTotal = results.reduce((s, r) => s + r.totalAccountValueUsd, 0);

        balRows.push([
          chalk.cyan.bold("TOTAL"),
          chalk.cyan.bold(`$${formatUsd(grandEquity)}`),
          "",
          "",
          grandSpot > 0 ? chalk.cyan.bold(`$${formatUsd(grandSpot)}`) : "",
          formatPnl(grandFunding),
          chalk.cyan.bold(`$${formatUsd(grandTotal)}`),
        ]);

        console.log(makeTable(["Exchange", "Equity", "Available", "Margin", "Spot", "Funding 24h", "Total"], balRows));

        if (results.some(r => r.unifiedAccount)) {
          console.log(chalk.gray("  ★ Unified account — Equity includes spot USDC, Spot shows non-USDC tokens only\n"));
        }

        // Spot details per exchange (for unified, skip USDC as it's in equity)
        for (const r of results) {
          const displaySpot = r.unifiedAccount
            ? r.spot.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
            : r.spot;
          if (displaySpot.length > 0) {
            console.log(chalk.white.bold(`  ${r.exchange.toUpperCase()} Spot Holdings`));
            const rows = displaySpot.map(b => [
              chalk.white.bold(b.token),
              b.total,
              b.valueUsd ? `$${formatUsd(b.valueUsd)}` : chalk.gray("-"),
            ]);
            console.log(makeTable(["Token", "Total", "Value"], rows));
          }
        }

        // Errors
        for (const [ex, msg] of Object.entries(errors)) {
          console.log(chalk.gray(`  ${ex}: ${msg}`));
        }

        console.log();
        return;
      }

      // Single exchange mode (explicit -e or no getAdapterForExchange)
      const adapter = await getAdapter();
      const exName = adapter.name.toLowerCase();
      const result = await fetchExchangeBalance(exName, adapter);

      if (isJson()) return printJson(jsonOk(result));

      printSingleBalance(exName, result);
      console.log();
    });

  // ── HIP-3 dex helper: fetch data from all deployed dexes in parallel ──

  async function fetchHip3Data<T>(
    hlAdapter: HyperliquidAdapter,
    fetcher: (dexAdapter: HyperliquidAdapter) => Promise<T[]>,
  ): Promise<{ dex: string; items: T[] }[]> {
    const dexes = await hlAdapter.listDeployedDexes();
    const results = await Promise.allSettled(
      dexes.map(async (d) => {
        // Clone adapter with dex set
        const dexAdapter = Object.create(hlAdapter) as HyperliquidAdapter;
        dexAdapter.setDex(d.name);
        const items = await fetcher(dexAdapter);
        return { dex: d.name, items };
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<{ dex: string; items: T[] }> => r.status === "fulfilled")
      .map(r => r.value)
      .filter(r => r.items.length > 0);
  }

  account
    .command("positions")
    .description("Show open positions")
    .option("--hip3", "Include HIP-3 dex positions (Hyperliquid)")
    .action(async (opts: { hip3?: boolean }) => {
      const explicitExchange = program.getOptionValueSource?.("exchange") === "cli";

      if (!explicitExchange && getAdapterForExchange) {
        const allRows: string[][] = [];
        const errors: Record<string, string> = {};

        await Promise.all(EXCHANGES.map(async (ex) => {
          try {
            const adapter = await getAdapterForExchange(ex);
            const positions = await adapter.getPositions();
            for (const p of positions) {
              allRows.push([
                chalk.white.bold(p.symbol),
                chalk.gray(ex.slice(0, 3).toUpperCase()),
                p.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
                p.size,
                `$${formatUsd(p.entryPrice)}`,
                `$${formatUsd(p.markPrice)}`,
                p.liquidationPrice === "N/A" ? chalk.gray("N/A") : `$${formatUsd(p.liquidationPrice)}`,
                formatPnl(p.unrealizedPnl),
                `${p.leverage}x`,
              ]);
            }
            // --hip3: fetch HIP-3 dex positions for HL
            if (opts.hip3 && ex === "hyperliquid" && adapter instanceof HyperliquidAdapter) {
              const hip3 = await fetchHip3Data(adapter, a => a.getPositions());
              for (const { dex, items } of hip3) {
                for (const p of items) {
                  allRows.push([
                    chalk.white.bold(p.symbol),
                    chalk.magenta(dex),
                    p.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
                    p.size,
                    `$${formatUsd(p.entryPrice)}`,
                    `$${formatUsd(p.markPrice)}`,
                    p.liquidationPrice === "N/A" ? chalk.gray("N/A") : `$${formatUsd(p.liquidationPrice)}`,
                    formatPnl(p.unrealizedPnl),
                    `${p.leverage}x`,
                  ]);
                }
              }
            }
          } catch (err) {
            errors[ex] = err instanceof Error ? err.message : String(err);
          }
        }));

        if (isJson()) {
          const grouped: Record<string, ExchangePosition[]> = {};
          await Promise.all(EXCHANGES.map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              grouped[ex] = await adapter.getPositions();
              if (opts.hip3 && ex === "hyperliquid" && adapter instanceof HyperliquidAdapter) {
                const hip3 = await fetchHip3Data(adapter, a => a.getPositions());
                for (const { dex, items } of hip3) grouped[`hip3:${dex}`] = items;
              }
            } catch { /* skip */ }
          }));
          return printJson(jsonOk({ exchanges: grouped, errors: Object.keys(errors).length > 0 ? errors : undefined }));
        }

        if (allRows.length === 0) {
          console.log(chalk.gray("\n  No open positions across all exchanges.\n"));
          for (const [ex, msg] of Object.entries(errors)) console.log(chalk.gray(`  ${ex}: ${msg}`));
          return;
        }

        console.log(makeTable(["Symbol", "Exch", "Side", "Size", "Entry", "Mark", "Liq", "PnL", "Lev"], allRows));
        for (const [ex, msg] of Object.entries(errors)) console.log(chalk.gray(`  ${ex}: ${msg}`));
        return;
      }

      // Single exchange mode
      const adapter = await getAdapter();
      const positions = await adapter.getPositions();

      // --hip3: append HIP-3 dex positions
      const hip3Positions: { dex: string; items: ExchangePosition[] }[] = [];
      if (opts.hip3 && adapter instanceof HyperliquidAdapter) {
        hip3Positions.push(...await fetchHip3Data(adapter, a => a.getPositions()));
      }

      if (isJson()) {
        if (hip3Positions.length > 0) {
          const hip3Map: Record<string, ExchangePosition[]> = {};
          for (const { dex, items } of hip3Positions) hip3Map[dex] = items;
          return printJson(jsonOk({ main: positions, hip3: hip3Map }));
        }
        return printJson(jsonOk(positions));
      }

      if (positions.length === 0 && hip3Positions.length === 0) {
        console.log(chalk.gray("\n  No open positions.\n"));
        return;
      }

      const rows = positions.map((p) => [
        chalk.white.bold(p.symbol),
        p.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
        p.size,
        `$${formatUsd(p.entryPrice)}`,
        `$${formatUsd(p.markPrice)}`,
        p.liquidationPrice === "N/A" ? chalk.gray("N/A") : `$${formatUsd(p.liquidationPrice)}`,
        formatPnl(p.unrealizedPnl),
        `${p.leverage}x`,
      ]);
      if (rows.length > 0) {
        console.log(makeTable(["Symbol", "Side", "Size", "Entry", "Mark", "Liq", "PnL", "Lev"], rows));
      }

      for (const { dex, items } of hip3Positions) {
        console.log(chalk.magenta.bold(`\n  HIP-3: ${dex}`));
        const dexRows = items.map((p) => [
          chalk.white.bold(p.symbol),
          p.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
          p.size,
          `$${formatUsd(p.entryPrice)}`,
          `$${formatUsd(p.markPrice)}`,
          p.liquidationPrice === "N/A" ? chalk.gray("N/A") : `$${formatUsd(p.liquidationPrice)}`,
          formatPnl(p.unrealizedPnl),
          `${p.leverage}x`,
        ]);
        console.log(makeTable(["Symbol", "Side", "Size", "Entry", "Mark", "Liq", "PnL", "Lev"], dexRows));
      }
    });

  account
    .command("orders")
    .description("Show open orders")
    .option("--hip3", "Include HIP-3 dex orders (Hyperliquid)")
    .action(async (opts: { hip3?: boolean }) => {
      const explicitExchange = program.getOptionValueSource?.("exchange") === "cli";

      if (!explicitExchange && getAdapterForExchange) {
        const allRows: string[][] = [];
        const errors: Record<string, string> = {};

        await Promise.all(EXCHANGES.map(async (ex) => {
          try {
            const adapter = await getAdapterForExchange(ex);
            const orders = await adapter.getOpenOrders();
            for (const o of orders) {
              allRows.push([
                o.orderId,
                chalk.white.bold(o.symbol),
                chalk.gray(ex.slice(0, 3).toUpperCase()),
                o.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
                o.type,
                `$${formatUsd(o.price)}`,
                o.size,
                o.filled,
                o.status,
              ]);
            }
            // --hip3: fetch HIP-3 dex orders for HL
            if (opts.hip3 && ex === "hyperliquid" && adapter instanceof HyperliquidAdapter) {
              const hip3 = await fetchHip3Data(adapter, a => a.getOpenOrders());
              for (const { dex, items } of hip3) {
                for (const o of items) {
                  allRows.push([
                    o.orderId,
                    chalk.white.bold(o.symbol),
                    chalk.magenta(dex),
                    o.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
                    o.type,
                    `$${formatUsd(o.price)}`,
                    o.size,
                    o.filled,
                    o.status,
                  ]);
                }
              }
            }
          } catch (err) {
            errors[ex] = err instanceof Error ? err.message : String(err);
          }
        }));

        if (isJson()) {
          const grouped: Record<string, unknown[]> = {};
          await Promise.all(EXCHANGES.map(async (ex) => {
            try {
              const adapter = await getAdapterForExchange(ex);
              grouped[ex] = await adapter.getOpenOrders();
              if (opts.hip3 && ex === "hyperliquid" && adapter instanceof HyperliquidAdapter) {
                const hip3 = await fetchHip3Data(adapter, a => a.getOpenOrders());
                for (const { dex, items } of hip3) grouped[`hip3:${dex}`] = items;
              }
            } catch { /* skip */ }
          }));
          return printJson(jsonOk({ exchanges: grouped, errors: Object.keys(errors).length > 0 ? errors : undefined }));
        }

        if (allRows.length === 0) {
          console.log(chalk.gray("\n  No open orders across all exchanges.\n"));
          for (const [ex, msg] of Object.entries(errors)) console.log(chalk.gray(`  ${ex}: ${msg}`));
          return;
        }

        console.log(makeTable(["ID", "Symbol", "Exch", "Side", "Type", "Price", "Size", "Filled", "Status"], allRows));
        for (const [ex, msg] of Object.entries(errors)) console.log(chalk.gray(`  ${ex}: ${msg}`));
        return;
      }

      // Single exchange mode
      const adapter = await getAdapter();
      const orders = await adapter.getOpenOrders();

      // --hip3: append HIP-3 dex orders
      const hip3Orders: { dex: string; items: ExchangeOrder[] }[] = [];
      if (opts.hip3 && adapter instanceof HyperliquidAdapter) {
        hip3Orders.push(...await fetchHip3Data(adapter, a => a.getOpenOrders()));
      }

      if (isJson()) {
        if (hip3Orders.length > 0) {
          const hip3Map: Record<string, ExchangeOrder[]> = {};
          for (const { dex, items } of hip3Orders) hip3Map[dex] = items;
          return printJson(jsonOk({ main: orders, hip3: hip3Map }));
        }
        return printJson(jsonOk(orders));
      }

      if (orders.length === 0 && hip3Orders.length === 0) {
        console.log(chalk.gray("\n  No open orders.\n"));
        return;
      }

      if (orders.length > 0) {
        const rows = orders.map((o) => [
          o.orderId,
          chalk.white.bold(o.symbol),
          o.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
          o.type,
          `$${formatUsd(o.price)}`,
          o.size,
          o.filled,
          o.status,
        ]);
        console.log(
          makeTable(["ID", "Symbol", "Side", "Type", "Price", "Size", "Filled", "Status"], rows)
        );
      }

      for (const { dex, items } of hip3Orders) {
        console.log(chalk.magenta.bold(`\n  HIP-3: ${dex}`));
        const dexRows = items.map((o) => [
          o.orderId,
          chalk.white.bold(o.symbol),
          o.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
          o.type,
          `$${formatUsd(o.price)}`,
          o.size,
          o.filled,
          o.status,
        ]);
        console.log(makeTable(["ID", "Symbol", "Side", "Type", "Price", "Size", "Filled", "Status"], dexRows));
      }
    });

  account
    .command("history")
    .description("Order history")
    .action(async () => {
      const adapter = await getAdapter();
      const orders = await adapter.getOrderHistory(30);
      if (isJson()) return printJson(jsonOk(orders));
      if (orders.length === 0) {
        console.log(chalk.gray("\n  No order history.\n"));
        return;
      }
      const rows = orders.map((o) => [
        o.orderId,
        chalk.white.bold(o.symbol),
        o.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
        o.type,
        `$${formatUsd(o.price)}`,
        o.size,
        o.filled,
        o.status,
      ]);
      console.log(makeTable(["ID", "Symbol", "Side", "Type", "Price", "Size", "Filled", "Status"], rows));
    });

  account
    .command("settings")
    .description("Show per-market account settings (leverage, margin mode)")
    .action(async () => {
      const adapter = await getAdapter();
      const p = pac(adapter);
      const settings = await p.sdk.getAccountSettings(p.publicKey);
      if (isJson()) return printJson(jsonOk(settings));

      if (!Array.isArray(settings) || settings.length === 0) {
        console.log(chalk.gray("\n  No market settings configured.\n"));
        return;
      }

      const rows = settings.map((s) => [
        chalk.white.bold(s.symbol),
        s.margin_mode,
        `${s.leverage}x`,
      ]);
      console.log(makeTable(["Symbol", "Margin Mode", "Leverage"], rows));
    });

  account
    .command("trades")
    .description("Trade history (fills)")
    .action(async () => {
      const adapter = await getAdapter();
      const trades = await adapter.getTradeHistory(30);
      if (isJson()) return printJson(jsonOk(trades));
      if (trades.length === 0) {
        console.log(chalk.gray("\n  No trade history.\n"));
        return;
      }
      const rows = trades.map((t) => [
        new Date(t.time).toLocaleString(),
        chalk.white.bold(t.symbol),
        t.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
        `$${formatUsd(t.price)}`,
        t.size,
        `$${formatUsd(t.fee)}`,
      ]);
      console.log(makeTable(["Time", "Symbol", "Side", "Price", "Size", "Fee"], rows));
    });

  account
    .command("funding-history")
    .description("Personal funding payment history")
    .action(async () => {
      const adapter = await getAdapter();
      const payments = await adapter.getFundingPayments(30);
      if (isJson()) return printJson(jsonOk(payments));
      if (payments.length === 0) {
        console.log(chalk.gray("\n  No funding history.\n"));
        return;
      }
      const rows = payments.map((h) => [
        new Date(h.time).toLocaleString(),
        chalk.white.bold(h.symbol),
        formatPnl(h.payment),
      ]);
      console.log(makeTable(["Time", "Symbol", "Payment"], rows));
    });

  // "account portfolio" removed — use top-level "portfolio" for cross-exchange view
  // or "account balance" for single-exchange balance

  // "account balance-history" removed — Pacifica-only, rarely used

  account
    .command("margin <symbol>")
    .description("Margin details for a specific symbol position")
    .action(async (symbol: string) => {
      const sym = symbol.toUpperCase();
      try {
        const adapter = await getAdapter();

        const [balance, positions] = await Promise.all([
          adapter.getBalance(),
          adapter.getPositions(),
        ]);

        const pos = positions.find(p => symbolMatch(p.symbol, sym));
        if (!pos) {
          if (isJson()) return printJson(jsonError("POSITION_NOT_FOUND", `No open position for ${sym}`));
          console.log(chalk.gray(`\n  No open position for ${sym}.\n`));
          return;
        }

        const positionNotional = Math.abs(Number(pos.size) * Number(pos.markPrice));
        const marginRequired = pos.leverage > 0 ? positionNotional / pos.leverage : 0;
        const marginPct = Number(balance.equity) > 0
          ? (marginRequired / Number(balance.equity) * 100)
          : 0;

        const data = {
          symbol: pos.symbol,
          side: pos.side,
          size: pos.size,
          entryPrice: pos.entryPrice,
          markPrice: pos.markPrice,
          leverage: pos.leverage,
          notional: positionNotional.toFixed(2),
          marginRequired: marginRequired.toFixed(2),
          marginPctOfEquity: marginPct.toFixed(2),
          liquidationPrice: pos.liquidationPrice,
          unrealizedPnl: pos.unrealizedPnl,
          accountEquity: balance.equity,
          accountAvailable: balance.available,
        };

        if (isJson()) return printJson(jsonOk(data));

        console.log(chalk.cyan.bold(`\n  ${pos.symbol} Margin Details\n`));
        console.log(`  Side:             ${pos.side === "long" ? chalk.green("LONG") : chalk.red("SHORT")}`);
        console.log(`  Size:             ${pos.size}`);
        console.log(`  Entry:            $${formatUsd(pos.entryPrice)}`);
        console.log(`  Mark:             $${formatUsd(pos.markPrice)}`);
        console.log(`  Leverage:         ${pos.leverage}x`);
        console.log(`  Notional:         $${formatUsd(positionNotional)}`);
        console.log(`  Margin Required:  $${formatUsd(marginRequired)}`);
        console.log(`  Margin % Equity:  ${marginPct.toFixed(2)}%`);
        console.log(`  Liquidation:      ${pos.liquidationPrice === "N/A" ? chalk.gray("N/A") : `$${formatUsd(pos.liquidationPrice)}`}`);
        console.log(`  Unrealized PnL:   ${formatPnl(pos.unrealizedPnl)}`);
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

  // ── PnL Report ──

  account
    .command("pnl")
    .description("PnL summary: realized (from trades), unrealized (from positions), and funding")
    .option("--period <period>", "Period filter: today, 7d, 30d, all", "all")
    .action(async (opts: { period: string }) => {
      const adapter = await getAdapter();

      // Gather data in parallel
      const [trades, positions, fundingPayments, balance] = await Promise.all([
        adapter.getTradeHistory(200),
        adapter.getPositions(),
        adapter.getFundingPayments(200),
        adapter.getBalance(),
      ]);

      // Period filter
      const now = Date.now();
      const periodMs: Record<string, number> = {
        today: 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
        all: Infinity,
      };
      const cutoff = now - (periodMs[opts.period] ?? Infinity);

      const filteredTrades = trades.filter(t => t.time >= cutoff);
      const filteredFunding = fundingPayments.filter(f => f.time >= cutoff);

      // Realized PnL: group trades by symbol, compute net P&L
      const symbolPnl = new Map<string, { buyCost: number; buyQty: number; sellRevenue: number; sellQty: number; fees: number }>();
      for (const t of filteredTrades) {
        if (!symbolPnl.has(t.symbol)) {
          symbolPnl.set(t.symbol, { buyCost: 0, buyQty: 0, sellRevenue: 0, sellQty: 0, fees: 0 });
        }
        const entry = symbolPnl.get(t.symbol)!;
        const price = parseFloat(t.price);
        const size = parseFloat(t.size);
        const fee = Math.abs(parseFloat(t.fee));
        entry.fees += fee;
        if (t.side === "buy") {
          entry.buyCost += price * size;
          entry.buyQty += size;
        } else {
          entry.sellRevenue += price * size;
          entry.sellQty += size;
        }
      }

      // Calculate realized PnL per symbol (closed quantity only)
      let totalRealizedPnl = 0;
      let totalFees = 0;
      const symbolRows: string[][] = [];

      for (const [symbol, data] of symbolPnl) {
        const closedQty = Math.min(data.buyQty, data.sellQty);
        let realizedPnl = 0;
        if (closedQty > 0) {
          const avgBuy = data.buyCost / data.buyQty;
          const avgSell = data.sellRevenue / data.sellQty;
          realizedPnl = (avgSell - avgBuy) * closedQty;
        }
        totalRealizedPnl += realizedPnl;
        totalFees += data.fees;
        symbolRows.push([
          chalk.white.bold(symbol),
          String(filteredTrades.filter(t => t.symbol === symbol).length),
          formatPnl(String(realizedPnl.toFixed(2))),
          `$${formatUsd(String(data.fees.toFixed(2)))}`,
        ]);
      }

      // Unrealized PnL from positions
      let totalUnrealizedPnl = 0;
      const posRows: string[][] = [];
      for (const p of positions) {
        const upnl = parseFloat(p.unrealizedPnl);
        totalUnrealizedPnl += upnl;
        posRows.push([
          chalk.white.bold(p.symbol),
          p.side === "long" ? chalk.green("LONG") : chalk.red("SHORT"),
          p.size,
          `$${formatUsd(p.entryPrice)}`,
          formatPnl(p.unrealizedPnl),
        ]);
      }

      // Funding income
      let totalFunding = 0;
      for (const f of filteredFunding) {
        totalFunding += parseFloat(f.payment);
      }

      const netPnl = totalRealizedPnl + totalUnrealizedPnl + totalFunding - totalFees;

      if (isJson()) {
        return printJson(jsonOk({
          period: opts.period,
          realizedPnl: totalRealizedPnl,
          unrealizedPnl: totalUnrealizedPnl,
          funding: totalFunding,
          fees: totalFees,
          netPnl,
          equity: parseFloat(balance.equity),
          trades: filteredTrades.length,
          positions: positions.length,
          fundingPayments: filteredFunding.length,
        }));
      }

      const periodLabel = opts.period === "all" ? "All Time" : opts.period === "today" ? "Today" : `Last ${opts.period}`;
      console.log(chalk.cyan.bold(`\n  ${adapter.name.toUpperCase()} PnL Report — ${periodLabel}\n`));

      // Trade PnL by symbol
      if (symbolRows.length > 0) {
        console.log(chalk.white.bold("  Realized PnL by Symbol"));
        console.log(makeTable(["Symbol", "Trades", "Realized PnL", "Fees"], symbolRows));
      }

      // Open positions
      if (posRows.length > 0) {
        console.log(chalk.white.bold("  Open Positions"));
        console.log(makeTable(["Symbol", "Side", "Size", "Entry", "uPnL"], posRows));
      }

      // Summary
      console.log(chalk.cyan.bold("  Summary"));
      console.log(`  Realized PnL:    ${formatPnl(String(totalRealizedPnl.toFixed(2)))}`);
      console.log(`  Unrealized PnL:  ${formatPnl(String(totalUnrealizedPnl.toFixed(2)))}`);
      console.log(`  Funding Income:  ${formatPnl(String(totalFunding.toFixed(2)))}`);
      console.log(`  Total Fees:      ${chalk.red(`-$${formatUsd(String(totalFees.toFixed(2)))}`)}`);
      console.log(`  ─────────────────────`);
      const netColor = netPnl >= 0 ? chalk.green : chalk.red;
      console.log(`  Net PnL:         ${netColor(`${netPnl >= 0 ? "+" : ""}$${Math.abs(netPnl).toFixed(2)}`)}`);
      console.log(`  Equity:          $${formatUsd(balance.equity)}`);
      console.log(`  Trades:          ${filteredTrades.length} | Positions: ${positions.length} | Funding: ${filteredFunding.length}`);
      console.log();
    });

  account
    .command("twap-orders")
    .description("Active TWAP orders")
    .action(async () => {
      const adapter = await getAdapter();
      const p = pac(adapter);
      const orders = await p.sdk.getTWAPOrders(p.publicKey);
      if (isJson()) return printJson(jsonOk(orders));

      if (!orders || orders.length === 0) {
        console.log(chalk.gray("\n  No active TWAP orders.\n"));
        return;
      }
      const rows = (orders as Record<string, unknown>[]).map((o) => [
        String(o.twap_order_id ?? o.id ?? ""),
        chalk.white.bold(String(o.symbol ?? "")),
        String(o.side) === "bid" ? chalk.green("BUY") : chalk.red("SELL"),
        String(o.amount ?? ""),
        String(o.filled_amount ?? "0"),
        `${o.duration_in_seconds ?? ""}s`,
      ]);
      console.log(makeTable(["ID", "Symbol", "Side", "Size", "Filled", "Duration"], rows));
    });

  // ── Portfolio (top-level command) ──

  if (getAdapterForExchange) {
    program
      .command("portfolio")
      .description("Cross-exchange portfolio overview (all exchanges at once)")
      .option("--exchange <exchanges>", "Comma-separated exchanges to include (default: all)")
      .action(async (opts: { exchange?: string }) => {
        await withJsonErrors(isJson(), async () => {
          const exchanges = opts.exchange
            ? opts.exchange.split(",").map(e => e.trim())
            : [...EXCHANGES];

          const snapshots = await Promise.all(
            exchanges.map(ex => fetchExchangeSnapshot(ex, getAdapterForExchange)),
          );

          const summary = buildSummary(snapshots);

          if (isJson()) {
            return printJson(jsonOk(summary));
          }

          // ── Header ──
          console.log(chalk.cyan.bold("\n  Cross-Exchange Portfolio\n"));

          // ── Balance Summary ──
          console.log(chalk.white.bold("  Balances"));
          const balRows = snapshots.map(s => {
            if (!s.connected) {
              return [chalk.white(s.exchange), chalk.red("disconnected"), "-", "-", "-", chalk.gray(s.error ?? "")];
            }
            const b = s.balance!;
            return [
              chalk.white.bold(s.exchange),
              `$${formatUsd(b.equity)}`,
              `$${formatUsd(b.available)}`,
              `$${formatUsd(b.marginUsed)}`,
              formatPnl(b.unrealizedPnl),
              chalk.green("connected"),
            ];
          });
          // Totals row
          balRows.push([
            chalk.cyan.bold("TOTAL"),
            chalk.cyan.bold(`$${formatUsd(summary.totalEquity)}`),
            chalk.cyan.bold(`$${formatUsd(summary.totalAvailable)}`),
            chalk.cyan.bold(`$${formatUsd(summary.totalMarginUsed)}`),
            formatPnl(summary.totalUnrealizedPnl),
            "",
          ]);
          console.log(makeTable(["Exchange", "Equity", "Available", "Margin Used", "uPnL", "Status"], balRows));

          // ── Positions ──
          if (summary.positions.length > 0) {
            console.log(chalk.white.bold("\n  Open Positions"));
            const posRows = summary.positions.map(p => {
              const sideColor = p.side === "long" ? chalk.green : chalk.red;
              const notional = Math.abs(Number(p.size) * Number(p.markPrice));
              return [
                chalk.white.bold(p.symbol),
                chalk.gray(p.exchange),
                sideColor(p.side.toUpperCase()),
                p.size,
                `$${formatUsd(p.entryPrice)}`,
                `$${formatUsd(p.markPrice)}`,
                formatPnl(p.unrealizedPnl),
                `$${formatUsd(notional)}`,
                `${p.leverage}x`,
              ];
            });
            console.log(makeTable(
              ["Symbol", "Exchange", "Side", "Size", "Entry", "Mark", "uPnL", "Notional", "Lev"],
              posRows,
            ));
          } else {
            console.log(chalk.gray("\n  No open positions.\n"));
          }

          // ── Risk Metrics ──
          console.log(chalk.white.bold("\n  Risk Metrics"));
          const levelColor = {
            low: chalk.green,
            medium: chalk.yellow,
            high: chalk.red,
            critical: chalk.bgRed.white,
          }[summary.risk.level];
          console.log(`  Risk Level:         ${levelColor(summary.risk.level.toUpperCase())}`);
          console.log(`  Can Trade:          ${summary.risk.canTrade ? chalk.green("YES") : chalk.red("NO")}`);
          const mu = summary.riskMetrics.marginUtilization;
          const muColor = mu < 30 ? chalk.green : mu < 60 ? chalk.yellow : chalk.red;
          console.log(`  Margin Utilization: ${muColor(`${mu.toFixed(1)}%`)}`);

          if (summary.riskMetrics.largestPosition) {
            const lp = summary.riskMetrics.largestPosition;
            console.log(`  Largest Position:   ${lp.symbol} on ${lp.exchange} ($${formatUsd(lp.notional)})`);
          }

          if (summary.riskMetrics.exchangeConcentration.length > 0) {
            console.log(`  Exchange Allocation:`);
            for (const ec of summary.riskMetrics.exchangeConcentration) {
              const bar = "\u2588".repeat(Math.round(ec.pct / 5)) + "\u2591".repeat(20 - Math.round(ec.pct / 5));
              console.log(`    ${ec.exchange.padEnd(12)} ${bar} ${ec.pct.toFixed(1)}%`);
            }
          }
          if (summary.risk.violations.length > 0) {
            console.log(chalk.red.bold("\n  Risk Violations"));
            for (const v of summary.risk.violations) {
              const sevColor = { low: chalk.green, medium: chalk.yellow, high: chalk.red, critical: chalk.bgRed.white }[v.severity];
              console.log(`    ${sevColor(v.severity.toUpperCase().padEnd(8))} ${v.message}`);
            }
          }
          console.log();
        });
      });
  }
}
