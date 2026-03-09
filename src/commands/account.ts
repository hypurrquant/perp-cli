import { Command } from "commander";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { makeTable, formatUsd, formatPnl, printJson, jsonOk, jsonError, symbolMatch } from "../utils.js";
import chalk from "chalk";

function pac(adapter: ExchangeAdapter): PacificaAdapter {
  if (!(adapter instanceof PacificaAdapter)) throw new Error("This command requires --exchange pacifica");
  return adapter;
}

export function registerAccountCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean
) {
  const account = program.command("account").description("Account commands");

  account
    .command("info")
    .description("Show account balance and info")
    .action(async () => {
      const adapter = await getAdapter();
      const bal = await adapter.getBalance();
      if (isJson()) return printJson(jsonOk(bal));

      console.log(chalk.cyan.bold(`\n  ${adapter.name.toUpperCase()} Account Info\n`));
      console.log(`  Equity:       $${formatUsd(bal.equity)}`);
      console.log(`  Available:    $${formatUsd(bal.available)}`);
      console.log(`  Margin Used:  $${formatUsd(bal.marginUsed)}`);
      console.log(`  Unreal. PnL:  ${formatPnl(bal.unrealizedPnl)}`);
      console.log();
    });

  account
    .command("balance")
    .description("Alias for 'account info' — show account balance")
    .action(async () => {
      const adapter = await getAdapter();
      const bal = await adapter.getBalance();
      if (isJson()) return printJson(jsonOk(bal));

      console.log(chalk.cyan.bold(`\n  ${adapter.name.toUpperCase()} Account Balance\n`));
      console.log(`  Equity:       $${formatUsd(bal.equity)}`);
      console.log(`  Available:    $${formatUsd(bal.available)}`);
      console.log(`  Margin Used:  $${formatUsd(bal.marginUsed)}`);
      console.log(`  Unreal. PnL:  ${formatPnl(bal.unrealizedPnl)}`);
      console.log();
    });

  account
    .command("positions")
    .description("Show open positions")
    .action(async () => {
      const adapter = await getAdapter();
      const positions = await adapter.getPositions();
      if (isJson()) return printJson(jsonOk(positions));

      if (positions.length === 0) {
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
      console.log(
        makeTable(["Symbol", "Side", "Size", "Entry", "Mark", "Liq", "PnL", "Lev"], rows)
      );
    });

  account
    .command("orders")
    .description("Show open orders")
    .action(async () => {
      const adapter = await getAdapter();
      const orders = await adapter.getOpenOrders();
      if (isJson()) return printJson(jsonOk(orders));

      if (orders.length === 0) {
        console.log(chalk.gray("\n  No open orders.\n"));
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
      console.log(
        makeTable(["ID", "Symbol", "Side", "Type", "Price", "Size", "Filled", "Status"], rows)
      );
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

      if (settings.length === 0) {
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

  account
    .command("portfolio")
    .description("Portfolio overview")
    .action(async () => {
      const adapter = await getAdapter();
      if (adapter instanceof PacificaAdapter) {
        const portfolio = await adapter.sdk.getPortfolio(adapter.publicKey);
        printJson(jsonOk(portfolio));
      } else if (adapter instanceof HyperliquidAdapter) {
        const state = await adapter.client.info.perpetuals.getClearinghouseState(adapter.address);
        printJson(jsonOk(state));
      }
    });

  account
    .command("balance-history")
    .description("Balance change history")
    .action(async () => {
      const adapter = await getAdapter();
      const p = pac(adapter);
      const raw = await p.sdk.getBalanceHistory(p.publicKey);
      if (isJson()) return printJson(jsonOk(raw));
      const history = ((raw as Record<string, unknown>).data ?? raw) as Record<string, unknown>[];

      if (!Array.isArray(history) || history.length === 0) {
        console.log(chalk.gray("\n  No balance history.\n"));
        return;
      }
      const rows = history.slice(0, 30).map((h) => [
        new Date(Number(h.created_at ?? h.timestamp ?? 0)).toLocaleString(),
        String(h.type ?? h.event_type ?? ""),
        formatPnl(String(h.amount ?? h.change ?? "0")),
        `$${formatUsd(String(h.balance ?? "0"))}`,
      ]);
      console.log(makeTable(["Time", "Type", "Change", "Balance"], rows));
    });

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
}
