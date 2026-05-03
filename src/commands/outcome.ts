/**
 * `perp outcome` — Hyperliquid Outcome markets (HIP-4).
 *
 * Currently HL-only. Asset class is fully collateralized binary/range
 * contracts, USDH-quoted. No leverage, no liquidation. Settlement is
 * dated per-outcome.
 */

import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { HyperliquidOutcomeAdapter } from "../exchanges/hyperliquid-outcome.js";
import type {
  OutcomeMarketInfo,
  OutcomePosition,
  OutcomeOrderbook,
  OutcomeView,
} from "../exchanges/outcome-interface.js";
import { makeTable, printJson, jsonOk, jsonError, formatUsd } from "../utils.js";
import { PerpError } from "../errors.js";

export function registerOutcomeCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const outcome = program
    .command("outcome")
    .description("Hyperliquid Outcome markets (HIP-4) — binary/range contracts");

  async function getOutcomeAdapter(): Promise<HyperliquidOutcomeAdapter> {
    const adapter = await getAdapterForExchange("hyperliquid");
    if (!(adapter instanceof HyperliquidAdapter)) {
      throw new PerpError("NOT_IMPLEMENTED", "Outcome markets are only available on Hyperliquid.", {
        exchange: "hyperliquid",
        remediation: "Run with -e hyperliquid (or omit -e to use the default).",
      });
    }
    const out = new HyperliquidOutcomeAdapter(adapter);
    await out.init();
    return out;
  }

  // ── outcome list ─────────────────────────────────────────────────────────
  outcome
    .command("list")
    .alias("markets")
    .description("List active outcome markets")
    .action(async () => {
      const adapter = await getOutcomeAdapter();
      const markets = await adapter.getMarkets();
      if (isJson()) return printJson(jsonOk(markets));

      if (markets.length === 0) {
        console.log(chalk.gray("\n  No active outcome markets.\n"));
        return;
      }

      console.log(chalk.white.bold(`\n  Outcome Markets (Hyperliquid HIP-4)`));
      console.log(chalk.gray(`  Quote: USDH · No leverage · Min order $10\n`));

      for (const m of markets) {
        const expiry = m.expiryMs ? new Date(m.expiryMs).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
        console.log(`  ${chalk.cyan(`#${m.outcome}`)} ${chalk.white.bold(m.name)}  ${chalk.gray(`(${m.class ?? "?"} · ${m.underlying ?? "?"} · ${m.period ?? "?"})`)}`);
        if (m.targetPrice !== undefined) console.log(`    target: $${m.targetPrice.toLocaleString()}  expiry: ${expiry}`);
        const sideRows = m.sides.map((s) => [
          String(s.side),
          chalk.white.bold(s.name),
          s.mid ? `$${Number(s.mid).toFixed(4)}` : chalk.gray("—"),
          chalk.gray(`assetId=${s.assetId}`),
        ]);
        console.log(makeTable(["#", "side", "mid", ""], sideRows));
        console.log("");
      }
    });

  // ── outcome book <outcome> <side> ────────────────────────────────────────
  outcome
    .command("book <outcome> <side>")
    .description("Show orderbook for one outcome side (e.g., 'outcome book 1 0' or '1 yes')")
    .option("--depth <n>", "Number of levels per side", "10")
    .action(async (outcomeArg: string, sideArg: string, opts: { depth?: string }) => {
      const adapter = await getOutcomeAdapter();
      const { outcome: outcomeId, side } = await resolveOutcomeSide(adapter, outcomeArg, sideArg);
      const book = await adapter.getOrderbook(outcomeId, side);
      const depth = Math.max(1, Number(opts.depth ?? "10"));

      if (isJson()) return printJson(jsonOk(book));

      printOutcomeBook(book, depth);
    });

  // ── outcome view <outcome> ───────────────────────────────────────────────
  // Symmetric Yes/No book + underlying gap + time to expiry. Single
  // round-trip view for binary markets.
  outcome
    .command("view <outcome>")
    .alias("status")
    .description("Combined view: Yes/No books side-by-side + underlying mark gap + expiry")
    .option("--depth <n>", "Number of levels per side", "10")
    .action(async (outcomeArg: string, opts: { depth?: string }) => {
      const adapter = await getOutcomeAdapter();
      const outcomeId = Number(outcomeArg);
      if (!Number.isInteger(outcomeId) || outcomeId < 0) {
        throw new PerpError("INVALID_PARAMS", `Invalid outcome id: ${outcomeArg}`, {});
      }
      const depth = Math.max(1, Number(opts.depth ?? "10"));
      const view = await adapter.getView(outcomeId, depth);
      if (isJson()) return printJson(jsonOk(view));
      printOutcomeView(view);
    });

  // ── outcome positions ────────────────────────────────────────────────────
  outcome
    .command("positions")
    .description("Show open outcome positions")
    .action(async () => {
      const adapter = await getOutcomeAdapter();
      const positions = await adapter.getPositions();
      if (isJson()) return printJson(jsonOk(positions));

      if (positions.length === 0) {
        console.log(chalk.gray("\n  No open outcome positions.\n"));
        return;
      }

      const rows = positions.map((p) => [
        chalk.cyan(`#${p.outcome}`),
        chalk.white.bold(p.sideName),
        p.size,
        `$${formatUsd(p.entryNotional)}`,
        p.markPrice ? `$${Number(p.markPrice).toFixed(4)}` : chalk.gray("—"),
        formatPnlCell(p.unrealizedPnl),
      ]);
      console.log("\n" + makeTable(["outcome", "side", "size", "entry$", "mark", "uPnL"], rows) + "\n");
    });

  // ── outcome orders ───────────────────────────────────────────────────────
  outcome
    .command("orders")
    .description("Show open outcome orders")
    .action(async () => {
      const adapter = await getOutcomeAdapter();
      const orders = await adapter.getOpenOrders();
      if (isJson()) return printJson(jsonOk(orders));

      if (orders.length === 0) {
        console.log(chalk.gray("\n  No open outcome orders.\n"));
        return;
      }
      // HL adapter normalises open-order sides to "buy"/"sell" (see
      // HyperliquidAdapter.getOpenOrders → ExchangeOrder shape). Earlier
      // versions checked the raw "B"/"A" form, which mislabelled every buy
      // as SELL.
      const rows = (orders as Array<Record<string, unknown>>).map((o) => {
        const side = String(o.side ?? "").toLowerCase();
        const sideLabel = side === "buy" ? chalk.green("BUY") : side === "sell" ? chalk.red("SELL") : chalk.gray(String(o.side ?? ""));
        return [
          String(o.symbol ?? ""),
          sideLabel,
          String(o.size ?? ""),
          String(o.price ?? ""),
          String(o.orderId ?? ""),
        ];
      });
      console.log("\n" + makeTable(["coin", "side", "size", "price", "oid"], rows) + "\n");
    });

  // ── outcome buy / sell ───────────────────────────────────────────────────
  for (const action of ["buy", "sell"] as const) {
    outcome
      .command(`${action} <outcome> <side> <usd>`)
      .description(`${action === "buy" ? "Buy" : "Sell"} a side of an outcome (USDH notional)`)
      .option("--limit <px>", "Limit price (default: aggressive Ioc at top of book)")
      .option("--tif <tif>", "Time-in-force: gtc | ioc | alo (default: ioc for market, gtc for limit)")
      .option("--dry-run", "Print the order action without sending")
      .action(async (outcomeArg: string, sideArg: string, usdArg: string, opts: { limit?: string; tif?: string; dryRun?: boolean }, command) => {
        // Merge globals so the parent program's --dry-run flag isn't shadowed
        // by this subcommand's local options (commander v13 behavior).
        const merged = (command?.optsWithGlobals?.() ?? opts) as { limit?: string; tif?: string; dryRun?: boolean };
        const adapter = await getOutcomeAdapter();
        const { outcome: outcomeId, side } = await resolveOutcomeSide(adapter, outcomeArg, sideArg);
        const usd = Number(usdArg);
        if (!Number.isFinite(usd) || usd <= 0) {
          throw new PerpError("INVALID_PARAMS", `Invalid notional: ${usdArg}`, {});
        }

        // Resolve price + size from notional
        let price = merged.limit;
        const tif = (merged.tif?.toUpperCase() ?? (price ? "GTC" : "IOC")) as "GTC" | "IOC" | "ALO";
        if (!price) {
          const book = await adapter.getOrderbook(outcomeId, side);
          if (action === "buy") {
            const bestAsk = book.asks[0]?.[0];
            if (!bestAsk) throw new PerpError("EXCHANGE_ERROR", `No asks available for outcome ${outcomeId} side ${side}`, {});
            // Aggressive Ioc: pay 5% above best ask, capped at $1
            price = Math.min(1, Number(bestAsk) * 1.05).toFixed(5);
          } else {
            const bestBid = book.bids[0]?.[0];
            if (!bestBid) throw new PerpError("EXCHANGE_ERROR", `No bids available for outcome ${outcomeId} side ${side}`, {});
            // Aggressive Ioc: sell 5% below best bid, floored at $0
            price = Math.max(0.0001, Number(bestBid) * 0.95).toFixed(5);
          }
        }
        const size = String(Math.floor(usd / Number(price))); // outcome sizes are integer shares

        const tifMap = { GTC: "Gtc", IOC: "Ioc", ALO: "Alo" } as const;
        const tifNorm = tifMap[tif];

        const orderInfo = {
          outcome: outcomeId,
          side,
          isBuy: action === "buy",
          price,
          size,
          tif: tifNorm,
          notional: (Number(price) * Number(size)).toFixed(4),
        };

        // Validate min-notional client-side so --dry-run surfaces it too
        // (placeOrder enforces but is bypassed by --dry-run early return).
        if (Number(orderInfo.notional) < 10) {
          throw new PerpError(
            "INVALID_PARAMS",
            `Outcome order notional must be at least 10 USDH (got price=${price} * size=${size} = ${orderInfo.notional})`,
            { exchange: "hyperliquid", remediation: "Increase --usd or pass --limit so price*size >= 10" },
          );
        }

        if (merged.dryRun) {
          if (isJson()) return printJson(jsonOk({ dryRun: true, order: orderInfo }));
          console.log(chalk.yellow(`\n  [dry-run] ${action.toUpperCase()} outcome=${outcomeId} side=${side} ${size}@${price} (notional ~$${orderInfo.notional} USDH, tif=${tifNorm})\n`));
          return;
        }

        const result = await adapter.placeOrder({
          outcome: outcomeId,
          side,
          isBuy: action === "buy",
          price,
          size,
          tif: tifNorm,
        });
        if (isJson()) return printJson(jsonOk({ order: orderInfo, response: result }));
        console.log(chalk.green(`\n  ${action.toUpperCase()} placed: outcome=${outcomeId} side=${side} ${size}@${price}\n`));
        console.log(`  ${chalk.gray("response:")} ${JSON.stringify(result)}\n`);
      });
  }

  // ── outcome cancel <outcome> <side> <oid> ────────────────────────────────
  outcome
    .command("cancel <outcome> <side> <oid>")
    .description("Cancel an open outcome order")
    .action(async (outcomeArg: string, sideArg: string, oidArg: string) => {
      const adapter = await getOutcomeAdapter();
      const { outcome: outcomeId, side } = await resolveOutcomeSide(adapter, outcomeArg, sideArg);
      const oid = Number(oidArg);
      if (!Number.isInteger(oid) || oid <= 0) {
        throw new PerpError("INVALID_PARAMS", `Invalid oid: ${oidArg}`, {});
      }
      const result = await adapter.cancelOrder(outcomeId, side, oid);
      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`\n  Cancelled order ${oid} on outcome=${outcomeId} side=${side}\n`));
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function resolveOutcomeSide(
  adapter: HyperliquidOutcomeAdapter,
  outcomeArg: string,
  sideArg: string,
): Promise<{ outcome: number; side: number }> {
  const outcomeId = Number(outcomeArg);
  if (!Number.isInteger(outcomeId) || outcomeId < 0) {
    throw new PerpError("INVALID_PARAMS", `Invalid outcome id: ${outcomeArg}`, {});
  }

  // side may be: integer (0/1), name (Yes/No), or `#<enc>`/`+<enc>` where
  // enc encodes BOTH outcome and side. The encoded form is verified against
  // outcomeArg — silently picking the side digit while ignoring the outcome
  // would route the trade to the wrong market.
  let side: number | undefined;
  if (/^\d+$/.test(sideArg)) {
    side = Number(sideArg);
  } else if (/^[#+]\d+$/.test(sideArg)) {
    const enc = Number(sideArg.slice(1));
    const encodedOutcome = Math.floor(enc / 10);
    const encodedSide = enc % 10;
    if (encodedOutcome !== outcomeId) {
      throw new PerpError(
        "INVALID_PARAMS",
        `Side reference '${sideArg}' encodes outcome=${encodedOutcome} but the outcome arg is ${outcomeId}. ` +
        `Either use plain side (0/1/Yes/No) or pass outcome=${encodedOutcome}.`,
        {},
      );
    }
    side = encodedSide;
  } else {
    const markets = await adapter.getMarkets();
    const market = markets.find((m) => m.outcome === outcomeId);
    const match = market?.sides.find((s) => s.name.toLowerCase() === sideArg.toLowerCase());
    side = match?.side;
  }
  if (side === undefined || !Number.isInteger(side)) {
    throw new PerpError("INVALID_PARAMS", `Invalid side: ${sideArg} (use 0/1, Yes/No, or #<enc>)`, {});
  }
  return { outcome: outcomeId, side };
}

function printOutcomeView(view: OutcomeView): void {
  console.log(chalk.white.bold(`\n  Outcome #${view.outcome} — ${view.name}`));
  console.log(chalk.gray(`  ${view.description}`));

  // Header line: target / underlying mark / gap / expiry
  if (view.underlying) {
    const u = view.underlying;
    const target = u.targetPrice !== undefined ? `$${u.targetPrice.toLocaleString()}` : "—";
    const mark = u.markPrice !== undefined ? `$${Number(u.markPrice).toLocaleString()}` : chalk.gray("—");
    const gapStr = u.gap !== undefined && u.gapPct !== undefined
      ? (u.gap >= 0
          ? chalk.green(`+$${Math.abs(u.gap).toFixed(2)} (+${u.gapPct.toFixed(2)}%)`)
          : chalk.red(`-$${Math.abs(u.gap).toFixed(2)} (${u.gapPct.toFixed(2)}%)`))
      : chalk.gray("—");
    const itm = u.inTheMoney === "yes" ? chalk.green("Yes ITM")
      : u.inTheMoney === "no" ? chalk.red("No ITM")
      : chalk.gray("—");
    console.log(`  ${u.symbol} target ${target}  current ${mark}  gap ${gapStr}  ${itm}`);
  }
  if (view.expiryMs !== undefined) {
    const expiryStr = new Date(view.expiryMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const ttx = view.msToExpiry !== undefined ? formatDuration(view.msToExpiry) : "—";
    console.log(`  Expires: ${expiryStr}  (${ttx})`);
  }
  if (view.midSum !== undefined) {
    const sumColor = Math.abs(view.midSum - 1) < 0.01 ? chalk.gray : chalk.yellow;
    console.log(`  Implied probabilities (sum ${sumColor(view.midSum.toFixed(4))}):`);
    for (const s of view.sides) {
      const p = s.impliedProb !== undefined ? `${(s.impliedProb * 100).toFixed(1)}%` : "—";
      console.log(`    ${s.name.padEnd(6)} ${p}`);
    }
  }

  // One table per side. Stacked layout — readable on any terminal width
  // and avoids the alignment quirks that come from padding ANSI strings.
  console.log("");
  for (const s of view.sides) {
    console.log(`  ${chalk.white.bold(s.name)} book`);
    const maxLevels = Math.max(s.bids.length, s.asks.length);
    const rows: string[][] = [];
    for (let i = 0; i < maxLevels; i++) {
      const b = s.bids[i];
      const a = s.asks[i];
      rows.push([
        b ? chalk.green(b[0]) : "",
        b ? b[1] : "",
        a ? chalk.red(a[0]) : "",
        a ? a[1] : "",
      ]);
    }
    console.log(makeTable(["bid", "size", "ask", "size"], rows));
    console.log("");
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h ${m}m left`;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s % 60}s left`;
  return `${s}s left`;
}

function printOutcomeBook(book: OutcomeOrderbook, depth: number): void {
  console.log(chalk.white.bold(`\n  outcome=${book.outcome} side=${book.side}`));
  const bids = book.bids.slice(0, depth);
  const asks = book.asks.slice(0, depth);
  const rows: string[][] = [];
  const max = Math.max(bids.length, asks.length);
  for (let i = 0; i < max; i++) {
    const b = bids[i];
    const a = asks[i];
    rows.push([
      b ? `${chalk.green(b[0])} (${b[1]})` : "",
      a ? `${chalk.red(a[0])} (${a[1]})` : "",
    ]);
  }
  console.log("\n" + makeTable(["bid (size)", "ask (size)"], rows) + "\n");
}

function formatPnlCell(pnl?: string): string {
  if (pnl === undefined) return chalk.gray("—");
  const n = Number(pnl);
  return n >= 0
    ? chalk.green(`+$${formatUsd(String(n.toFixed(4)))}`)
    : chalk.red(`-$${formatUsd(String(Math.abs(n).toFixed(4)))}`);
}
