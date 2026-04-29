import { Command } from "commander";
import type { ExchangeAdapter, ExchangePosition, ExchangeOrder } from "../exchanges/index.js";
import { makeTable, formatUsd, formatPnl, printJson, jsonOk, jsonError, symbolMatch, withJsonErrors } from "../utils.js";
import chalk from "chalk";
import { hasPacificaSdk, isDexCapable } from "../exchanges/capabilities.js";

const EXCHANGES = ["pacifica", "hyperliquid", "lighter", "aster"] as const;

function pac(adapter: ExchangeAdapter) {
  if (!hasPacificaSdk(adapter)) throw new Error("Market settings are only available on Pacifica.");
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


  // ── HIP-3 dex helper: fetch data from all deployed dexes in parallel ──

  async function fetchHip3Data<T>(
    hlAdapter: ExchangeAdapter & import("../exchanges/capabilities.js").DexCapable,
    fetcher: (dexAdapter: ExchangeAdapter & import("../exchanges/capabilities.js").DexCapable) => Promise<T[]>,
  ): Promise<{ dex: string; items: T[] }[]> {
    const dexes = await hlAdapter.listDeployedDexes();
    const results = await Promise.allSettled(
      dexes.map(async (d) => {
        // Clone adapter with dex set
        const dexAdapter = Object.create(hlAdapter) as ExchangeAdapter & import("../exchanges/capabilities.js").DexCapable;
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
            if (opts.hip3 && ex === "hyperliquid" && isDexCapable(adapter)) {
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
              if (opts.hip3 && ex === "hyperliquid" && isDexCapable(adapter)) {
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
      if (opts.hip3 && isDexCapable(adapter)) {
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
            if (opts.hip3 && ex === "hyperliquid" && isDexCapable(adapter)) {
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
              if (opts.hip3 && ex === "hyperliquid" && isDexCapable(adapter)) {
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
      if (opts.hip3 && isDexCapable(adapter)) {
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

      // Pacifica: use dedicated SDK endpoint
      if (hasPacificaSdk(adapter)) {
        const sdk = adapter.sdk as Record<string, (...args: any[]) => any>;
        const settings = await sdk.getAccountSettings(adapter.publicKey);
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
        return;
      }

      // HL / Lighter: derive settings from open positions
      const positions = await adapter.getPositions();
      if (positions.length === 0) {
        if (isJson()) return printJson(jsonOk([]));
        console.log(chalk.gray("\n  No open positions — settings shown per active position.\n"));
        return;
      }
      const settings = positions.map(p => ({
        symbol: p.symbol,
        leverage: p.leverage,
        margin_mode: "cross" as string, // HL/Lighter default to cross
      }));
      if (isJson()) return printJson(jsonOk(settings));
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
    .alias("funding")
    .description("Personal funding payment history")
    .option("-n, --limit <n>", "Number of records", "200")
    .action(async (opts: { limit: string }) => {
      const adapter = await getAdapter();
      const payments = await adapter.getFundingPayments(parseInt(opts.limit));
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
      let p: ReturnType<typeof pac>;
      try {
        const adapter = await getAdapter();
        p = pac(adapter);
      } catch (err) {
        if (isJson()) return printJson(jsonError("EXCHANGE_ERROR", err instanceof Error ? err.message : String(err)));
        console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
        return;
      }
      const sdk = p.sdk as Record<string, (...args: any[]) => any>;
      const orders = await sdk.getTWAPOrders(p.publicKey);
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

}
