#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) server for perp-cli.
 *
 * Read-only advisor mode: provides market data, account balance, and CLI command suggestions.
 * Does NOT execute trades directly — instead suggests CLI commands for the user to run.
 * Adapters are created lazily from environment variables.
 */

import "dotenv/config";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import { loadPrivateKey, parseSolanaKeypair, type Exchange } from "./config.js";
import { PacificaAdapter } from "./exchanges/pacifica.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";
import { LighterAdapter } from "./exchanges/lighter.js";
import {
  fetchPacificaPrices,
  fetchHyperliquidMeta,
  fetchLighterOrderBookDetails,
  pingPacifica,
  pingHyperliquid,
  pingLighter,
} from "./shared-api.js";
import { fetchAllFundingRates } from "./funding-rates.js";

// ── Adapter cache & factory ──

const adapters = new Map<string, ExchangeAdapter>();

async function getOrCreateAdapter(exchange: string): Promise<ExchangeAdapter> {
  const key = exchange.toLowerCase();
  if (adapters.has(key)) return adapters.get(key)!;

  const pk = await loadPrivateKey(key as Exchange);

  let adapter: ExchangeAdapter;
  switch (key) {
    case "pacifica": {
      const keypair = parseSolanaKeypair(pk);
      adapter = new PacificaAdapter(keypair);
      break;
    }
    case "hyperliquid": {
      const hl = new HyperliquidAdapter(pk);
      await hl.init();
      adapter = hl;
      break;
    }
    case "lighter": {
      const lt = new LighterAdapter(pk);
      await lt.init();
      adapter = lt;
      break;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}. Supported: pacifica, hyperliquid, lighter`);
  }

  adapters.set(key, adapter);
  return adapter;
}

// ── JSON envelope helpers ──

function ok(data: unknown, meta?: Record<string, unknown>) {
  return JSON.stringify({ ok: true, data, meta }, null, 2);
}

function err(error: string, meta?: Record<string, unknown>) {
  return JSON.stringify({ ok: false, error, meta }, null, 2);
}

// ── MCP Server ──

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

const server = new McpServer(
  { name: "perp-cli", version: _pkg.version },
  { capabilities: { tools: {}, resources: {} } },
);

// ============================================================
// Market Data tools (read-only, no private key needed)
// ============================================================

server.tool(
  "get_markets",
  "Get all available perpetual futures markets on an exchange, including price, funding rate, volume, and max leverage",
  { exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter") },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const markets = await adapter.getMarkets();
      return { content: [{ type: "text", text: ok(markets, { exchange, count: markets.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_orderbook",
  "Get the order book (bids and asks) for a symbol on an exchange",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
    symbol: z.string().describe("Trading pair symbol, e.g. BTC, ETH, SOL"),
  },
  async ({ exchange, symbol }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const book = await adapter.getOrderbook(symbol);
      return { content: [{ type: "text", text: ok(book, { exchange, symbol }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange, symbol }) }], isError: true };
    }
  },
);

server.tool(
  "get_funding_rates",
  "Compare funding rates across all 3 exchanges (Pacifica, Hyperliquid, Lighter). Returns rates per symbol with spread analysis",
  {
    symbols: z
      .array(z.string())
      .optional()
      .describe("Filter to specific symbols (e.g. ['BTC','ETH']). Omit for all available"),
    minSpread: z.number().optional().describe("Minimum annualized spread % to include (default: 0)"),
  },
  async ({ symbols, minSpread }) => {
    try {
      const snapshot = await fetchAllFundingRates({ symbols, minSpread });
      return {
        content: [{
          type: "text",
          text: ok(snapshot, { symbolCount: snapshot.symbols.length, exchangeStatus: snapshot.exchangeStatus }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  },
);

server.tool(
  "get_prices",
  "Get cross-exchange prices for symbols. Fetches mark prices from all 3 exchanges for comparison",
  {
    symbols: z
      .array(z.string())
      .optional()
      .describe("Symbols to fetch prices for (e.g. ['BTC','ETH']). Omit for top assets"),
  },
  async ({ symbols }) => {
    try {
      const [pacifica, hl, lighter] = await Promise.all([
        fetchPacificaPrices(),
        fetchHyperliquidMeta(),
        fetchLighterOrderBookDetails(),
      ]);

      const filter = symbols ? new Set(symbols.map(s => s.toUpperCase())) : null;

      // Build symbol → exchange prices map
      const priceMap = new Map<string, Record<string, number>>();
      for (const p of pacifica) {
        const sym = p.symbol.toUpperCase();
        if (filter && !filter.has(sym)) continue;
        if (!priceMap.has(sym)) priceMap.set(sym, {});
        priceMap.get(sym)!.pacifica = p.mark;
      }
      for (const a of hl) {
        const sym = a.symbol.toUpperCase();
        if (filter && !filter.has(sym)) continue;
        if (!priceMap.has(sym)) priceMap.set(sym, {});
        priceMap.get(sym)!.hyperliquid = a.markPx;
      }
      for (const m of lighter) {
        const sym = m.symbol.toUpperCase();
        if (filter && !filter.has(sym)) continue;
        if (!priceMap.has(sym)) priceMap.set(sym, {});
        priceMap.get(sym)!.lighter = m.lastTradePrice;
      }

      const data = Array.from(priceMap.entries()).map(([symbol, prices]) => ({ symbol, prices }));
      return { content: [{ type: "text", text: ok(data, { count: data.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  },
);

// ============================================================
// Account tools (need private key)
// ============================================================

server.tool(
  "get_balance",
  "Get account balance (equity, available margin, margin used, unrealized PnL) on an exchange",
  { exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter") },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const balance = await adapter.getBalance();
      return { content: [{ type: "text", text: ok(balance, { exchange }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_positions",
  "Get all open positions on an exchange, including size, entry price, PnL, leverage",
  { exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter") },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const positions = await adapter.getPositions();
      return { content: [{ type: "text", text: ok(positions, { exchange, count: positions.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_open_orders",
  "Get all open/pending orders on an exchange",
  { exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter") },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const orders = await adapter.getOpenOrders();
      return { content: [{ type: "text", text: ok(orders, { exchange, count: orders.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "portfolio",
  "Cross-exchange portfolio summary: balances, positions, and risk metrics across all exchanges",
  {},
  async () => {
    const EXCHANGES = ["pacifica", "hyperliquid", "lighter"] as const;

    interface ExchangeSnapshot {
      exchange: string;
      connected: boolean;
      balance: { equity: string; available: string; marginUsed: string; unrealizedPnl: string } | null;
      positions: Awaited<ReturnType<ExchangeAdapter["getPositions"]>>;
      openOrders: number;
      error?: string;
    }

    const snapshots: ExchangeSnapshot[] = await Promise.all(
      EXCHANGES.map(async (name) => {
        try {
          const adapter = await getOrCreateAdapter(name);
          const [balance, positions, orders] = await Promise.all([
            adapter.getBalance(),
            adapter.getPositions(),
            adapter.getOpenOrders(),
          ]);
          return { exchange: name, connected: true, balance, positions, openOrders: orders.length };
        } catch (e) {
          return {
            exchange: name,
            connected: false,
            balance: null,
            positions: [],
            openOrders: 0,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    let totalEquity = 0;
    let totalAvailable = 0;
    let totalMarginUsed = 0;
    let totalUnrealizedPnl = 0;
    let totalPositions = 0;
    let totalOpenOrders = 0;
    const allPositions: (Awaited<ReturnType<ExchangeAdapter["getPositions"]>>[number] & { exchange: string })[] = [];

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

    const marginUtilization = totalEquity > 0 ? (totalMarginUsed / totalEquity) * 100 : 0;

    let largestPosition: { symbol: string; exchange: string; notional: number } | null = null;
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

    const summary = {
      totalEquity,
      totalAvailable,
      totalMarginUsed,
      totalUnrealizedPnl,
      totalPositions,
      totalOpenOrders,
      exchanges: snapshots,
      positions: allPositions,
      riskMetrics: { marginUtilization, largestPosition, exchangeConcentration },
    };

    return { content: [{ type: "text", text: ok(summary) }] };
  },
);

// ============================================================
// Advisory tools (suggest CLI commands, do NOT execute trades)
// ============================================================

server.tool(
  "suggest_command",
  "Given a natural language trading goal, suggest the exact perp CLI commands to run. Does NOT execute anything — only returns commands for the user to review and run manually",
  {
    goal: z.string().describe("Natural language goal, e.g. 'buy 0.1 BTC on pacifica', 'close all positions', 'check funding arb opportunities'"),
    exchange: z.string().optional().describe("Preferred exchange (default: pacifica). Options: pacifica, hyperliquid, lighter"),
  },
  async ({ goal, exchange }) => {
    try {
      const ex = exchange ?? "pacifica";
      const g = goal.toLowerCase();
      const steps: { step: number; command: string; description: string; dangerous?: boolean }[] = [];

      if (g.includes("buy") || g.includes("long")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "<size>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook and liquidity` },
          { step: 2, command: `perp -e ${ex} --json account balance`, description: "Check available balance and margin" },
          { step: 3, command: `perp -e ${ex} --json trade check ${symbol} buy ${size}`, description: "Pre-flight validation (dry run)" },
          { step: 4, command: `perp -e ${ex} --json trade market ${symbol} buy ${size}`, description: `Buy ${size} ${symbol} at market`, dangerous: true },
          { step: 5, command: `perp -e ${ex} --json account positions`, description: "Verify position opened" },
        );
      } else if (g.includes("sell") || g.includes("short")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "<size>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook and liquidity` },
          { step: 2, command: `perp -e ${ex} --json account balance`, description: "Check available balance and margin" },
          { step: 3, command: `perp -e ${ex} --json trade check ${symbol} sell ${size}`, description: "Pre-flight validation (dry run)" },
          { step: 4, command: `perp -e ${ex} --json trade market ${symbol} sell ${size}`, description: `Sell ${size} ${symbol} at market`, dangerous: true },
          { step: 5, command: `perp -e ${ex} --json account positions`, description: "Verify position opened" },
        );
      } else if (g.includes("limit")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "<size>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook for price levels` },
          { step: 2, command: `perp -e ${ex} --json account balance`, description: "Check available balance" },
          { step: 3, command: `perp -e ${ex} --json trade limit ${symbol} ${side} <price> ${size}`, description: `Place limit ${side} order`, dangerous: true },
          { step: 4, command: `perp -e ${ex} --json account orders`, description: "Verify order placed" },
        );
      } else if (g.includes("close") || g.includes("exit") || g.includes("flatten")) {
        const symbol = extractSymbol(g);
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Get current positions" },
        );
        if (g.includes("flatten")) {
          steps.push(
            { step: 2, command: `perp -e ${ex} --json trade flatten`, description: "Cancel all orders + close all positions", dangerous: true },
          );
        } else if (symbol) {
          steps.push(
            { step: 2, command: `perp -e ${ex} --json trade close ${symbol}`, description: `Close ${symbol} position at market`, dangerous: true },
          );
        } else {
          steps.push(
            { step: 2, command: `perp -e ${ex} --json trade cancel-all`, description: "Cancel any open orders first", dangerous: true },
            { step: 3, command: `perp -e ${ex} --json trade close-all`, description: "Close all positions at market", dangerous: true },
          );
        }
      } else if (g.includes("tp") || g.includes("take profit") || g.includes("scale-tp")) {
        const symbol = extractSymbol(g) || "<symbol>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position size and entry" },
          { step: 2, command: `perp -e ${ex} --json market book ${symbol}`, description: "Check current prices" },
          { step: 3, command: `perp -e ${ex} --json trade scale-tp ${symbol} --levels '<price1>:25%,<price2>:50%,<price3>:25%'`, description: "Place scaled take-profit orders", dangerous: true },
        );
      } else if (g.includes("scale-in") || g.includes("scale in") || g.includes("dca in")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: "Check current prices" },
          { step: 2, command: `perp -e ${ex} --json account balance`, description: "Check available balance" },
          { step: 3, command: `perp -e ${ex} --json trade scale-in ${symbol} ${side} --levels '<price1>:<size>,<price2>:<size>'`, description: "Place scaled entry orders at multiple levels", dangerous: true },
        );
      } else if (g.includes("tpsl") || g.includes("tp/sl") || g.includes("tp sl") || (g.includes("take profit") && g.includes("stop loss"))) {
        const symbol = extractSymbol(g) || "<symbol>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position" },
          { step: 2, command: `perp -e ${ex} --json trade tpsl ${symbol} ${side} --tp <price> --sl <price>`, description: "Set TP/SL bracket orders", dangerous: true },
          { step: 3, command: `perp -e ${ex} --json account orders`, description: "Verify TP/SL orders placed" },
        );
      } else if (g.includes("trailing") || g.includes("trail")) {
        const symbol = extractSymbol(g) || "<symbol>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position" },
          { step: 2, command: `perp -e ${ex} --json trade trailing-stop ${symbol}`, description: "Set trailing stop order", dangerous: true },
        );
      } else if (g.includes("stop") || g.includes("sl") || g.includes("stop loss")) {
        const symbol = extractSymbol(g) || "<symbol>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position" },
          { step: 2, command: `perp -e ${ex} --json trade stop ${symbol} <side> <stopPrice> <size>`, description: "Place stop order", dangerous: true },
        );
      } else if (g.includes("split") || g.includes("depth") || (g.includes("large") && (g.includes("order") || g.includes("buy") || g.includes("sell")))) {
        const symbol = extractSymbol(g) || "<symbol>";
        const amount = extractNumber(g) || "<usd>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook depth` },
          { step: 2, command: `perp -e ${ex} --json account balance`, description: "Check available balance" },
          { step: 3, command: `perp -e ${ex} --json trade split ${symbol} ${side} ${amount}`, description: `Split ${side} $${amount} ${symbol} into depth-based slices`, dangerous: true },
          { step: 4, command: `perp -e ${ex} --json account positions`, description: "Verify position opened" },
        );
      } else if (g.includes("twap")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const size = extractNumber(g) || "<size>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account balance`, description: "Check available balance" },
          { step: 2, command: `perp -e ${ex} --json trade twap ${symbol} ${side} ${size} <duration>`, description: `TWAP ${side} ${size} ${symbol} over duration`, dangerous: true },
        );
      } else if (g.includes("reduce")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const pct = extractNumber(g) || "<percent>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position size" },
          { step: 2, command: `perp -e ${ex} --json trade reduce ${symbol} ${pct}`, description: `Reduce ${symbol} position by ${pct}%`, dangerous: true },
        );
      } else if (g.includes("edit") || g.includes("modify order")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account orders`, description: "List open orders to find order ID" },
          { step: 2, command: `perp -e ${ex} --json trade edit <symbol> <orderId> <newPrice> <newSize>`, description: "Modify the order", dangerous: true },
        );
      } else if (g.includes("arb") || g.includes("arbitrage")) {
        steps.push(
          { step: 1, command: "perp --json arb scan --min 5", description: "Scan funding rate arbitrage opportunities" },
          { step: 2, command: "perp --json arb scan --gaps", description: "Check cross-exchange price gaps" },
          { step: 3, command: "perp --json arb scan --hip3", description: "HIP-3 cross-dex arb opportunities (Hyperliquid)" },
        );
      } else if (g.includes("funding")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp --json arb scan --rates`, description: `Funding rates across all exchanges` },
            { step: 2, command: `perp -e ${ex} --json market funding ${symbol}`, description: `${symbol} funding history` },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json arb scan --rates", description: "Funding rates across all exchanges" },
            { step: 2, command: "perp --json arb scan --min 5", description: "Funding rate arb opportunities" },
          );
        }
      } else if (g.includes("bridge") || g.includes("transfer") || g.includes("cross-chain")) {
        const amount = extractNumber(g) || "<amount>";
        steps.push(
          { step: 1, command: "perp --json bridge chains", description: "List supported chains" },
          { step: 2, command: `perp --json bridge quote --from <chain> --to <chain> --amount ${amount}`, description: "Get bridge quote with fees" },
          { step: 3, command: `perp --json bridge send --from <chain> --to <chain> --amount ${amount}`, description: "Execute bridge transfer", dangerous: true },
          { step: 4, command: "perp --json bridge status <orderId>", description: "Track bridge completion" },
        );
      } else if (g.includes("grid") || g.includes("dca") || g.includes("bot")) {
        const symbol = extractSymbol(g) || "<symbol>";
        if (g.includes("grid")) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: "Check current price" },
            { step: 2, command: `perp -e ${ex} --json bot quick-grid ${symbol}`, description: "Start grid bot", dangerous: true },
            { step: 3, command: "perp --json jobs list", description: "Verify bot is running" },
          );
        } else if (g.includes("dca")) {
          const amount = extractNumber(g) || "<amount>";
          const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
          steps.push(
            { step: 1, command: `perp -e ${ex} --json account balance`, description: "Check available balance" },
            { step: 2, command: `perp -e ${ex} --json bot quick-dca ${symbol} ${side} ${amount} <interval>`, description: "Start DCA bot", dangerous: true },
            { step: 3, command: "perp --json jobs list", description: "Verify bot is running" },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json bot preset-list", description: "List available bot presets" },
            { step: 2, command: `perp -e ${ex} --json bot quick-arb`, description: "Start arb bot", dangerous: true },
            { step: 3, command: "perp --json jobs list", description: "Verify bot is running" },
          );
        }
      } else if (g.includes("backtest")) {
        if (g.includes("grid")) {
          steps.push(
            { step: 1, command: "perp --json backtest grid", description: "Backtest grid strategy on historical data" },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json backtest funding-arb", description: "Backtest funding arb strategy" },
          );
        }
      } else if (g.includes("setup") || g.includes("init") || g.includes("configure") || g.includes("connect") || g.includes("set key") || g.includes("set wallet") || g.includes("private key")) {
        steps.push(
          { step: 1, command: "perp --json wallet show", description: "Check if any wallets are already configured" },
          { step: 2, command: "perp --json wallet set <exchange> <privateKey>", description: "Set private key for exchange (exchange: pacifica, hyperliquid, lighter, or aliases: hl, pac, lt)" },
          { step: 3, command: "perp --json wallet set <exchange> <privateKey> --default", description: "Set key + make it the default exchange" },
          { step: 4, command: "perp --json wallet show", description: "Verify wallet is configured (shows public address)" },
        );
      } else if (g.includes("wallet") || g.includes("balance") || g.includes("on-chain")) {
        steps.push(
          { step: 1, command: "perp --json wallet show", description: "Show configured wallets with public addresses" },
          { step: 2, command: "perp --json wallet balance", description: "Check on-chain balances" },
        );
      } else if (g.includes("risk")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json risk status`, description: "Portfolio risk overview" },
          { step: 2, command: `perp -e ${ex} --json risk limits`, description: "Current position limits" },
        );
      } else if (g.includes("analytic") || g.includes("performance") || g.includes("pnl") || g.includes("p&l")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json history summary`, description: "Trading performance summary" },
          { step: 2, command: `perp -e ${ex} --json history pnl`, description: "P&L breakdown" },
          { step: 3, command: `perp -e ${ex} --json history funding`, description: "Funding payment history" },
        );
      } else if (g.includes("history") || g.includes("log") || g.includes("audit")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json history list`, description: "Execution audit trail" },
          { step: 2, command: `perp -e ${ex} --json history stats`, description: "Execution statistics" },
        );
      } else if (g.includes("live") || g.includes("watch") || g.includes("realtime")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `${symbol} orderbook` },
            { step: 2, command: `perp -e ${ex} --json market trades ${symbol}`, description: `${symbol} recent trades` },
            { step: 3, command: `perp --json arb scan --gaps --live`, description: "Live cross-exchange price gap monitor" },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json arb scan --gaps --live", description: "Live cross-exchange price gap monitor" },
            { step: 2, command: `perp -e ${ex} --json market prices`, description: "Current prices across exchanges" },
          );
        }
      } else if (g.includes("gap")) {
        steps.push(
          { step: 1, command: "perp --json arb scan --gaps", description: "Cross-exchange price gaps" },
          { step: 2, command: "perp --json arb scan --gaps --live", description: "Live gap monitor" },
        );
      } else if (g.includes("rebalance")) {
        steps.push(
          { step: 1, command: "perp --json rebalance check", description: "Check balance distribution" },
          { step: 2, command: "perp --json rebalance plan", description: "Generate rebalance plan" },
          { step: 3, command: "perp --json rebalance execute", description: "Execute rebalance", dangerous: true },
        );
      } else if (g.includes("job") || g.includes("running") || g.includes("background")) {
        steps.push(
          { step: 1, command: "perp --json jobs list", description: "List running background jobs" },
        );
      } else if (g.includes("dex") || g.includes("hip-3") || g.includes("hip3")) {
        steps.push(
          { step: 1, command: "perp --json -e hl market hip3", description: "List HIP-3 deployed dexes" },
          { step: 2, command: "perp --json -e hl --dex <name> market list", description: "Show markets on a specific dex" },
        );
      } else if (g.includes("plan") || g.includes("composite") || g.includes("multi-step")) {
        steps.push(
          { step: 1, command: "perp plan example", description: "Show example execution plan format" },
          { step: 2, command: "perp --json plan validate <file>", description: "Validate plan file" },
          { step: 3, command: "perp --json plan execute <file> --dry-run", description: "Dry-run the plan", dangerous: true },
        );
      } else if (g.includes("status") || g.includes("check") || g.includes("overview") || g.includes("portfolio")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json status`, description: "Full account overview" },
          { step: 2, command: `perp -e ${ex} --json account positions`, description: "Detailed positions" },
          { step: 3, command: `perp -e ${ex} --json account orders`, description: "Open orders" },
          { step: 4, command: "perp --json portfolio", description: "Cross-exchange portfolio summary" },
        );
      } else if (g.includes("deposit")) {
        const amount = extractNumber(g) || "<amount>";
        steps.push(
          { step: 1, command: "perp --json wallet balance", description: "Check wallet balance" },
          { step: 2, command: `perp --json funds deposit ${ex} ${amount}`, description: `Deposit $${amount} to ${ex}`, dangerous: true },
          { step: 3, command: `perp -e ${ex} --json account balance`, description: "Verify deposit arrived" },
        );
      } else if (g.includes("withdraw")) {
        const amount = extractNumber(g) || "<amount>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account balance`, description: "Check available balance" },
          { step: 2, command: `perp --json funds withdraw ${ex} ${amount}`, description: `Withdraw $${amount} from ${ex}`, dangerous: true },
          { step: 3, command: "perp --json wallet balance", description: "Verify withdrawal received" },
        );
      } else if (g.includes("leverage")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const lev = extractNumber(g) || "<leverage>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json risk status`, description: "Check current risk and leverage" },
          { step: 2, command: `perp -e ${ex} --json trade leverage ${symbol} ${lev}`, description: `Set ${symbol} leverage to ${lev}x`, dangerous: true },
        );
      } else if (g.includes("cancel")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json account orders`, description: "List open orders" },
            { step: 2, command: `perp -e ${ex} --json trade cancel ${symbol} <orderId>`, description: `Cancel order for ${symbol}`, dangerous: true },
          );
        } else {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json account orders`, description: "List open orders" },
            { step: 2, command: `perp -e ${ex} --json trade cancel-all`, description: "Cancel all open orders", dangerous: true },
          );
        }
      } else if (g.includes("price") || g.includes("market")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `${symbol} orderbook` },
            { step: 2, command: `perp -e ${ex} --json market funding ${symbol}`, description: `${symbol} funding history` },
            { step: 3, command: `perp -e ${ex} --json market kline ${symbol} 1h`, description: `${symbol} hourly candles` },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json market prices", description: "All market prices" },
            { step: 2, command: "perp --json arb scan --gaps", description: "Cross-exchange price gaps" },
          );
        }
      } else if (g.includes("setting") || g.includes("config") || g.includes("referral")) {
        steps.push(
          { step: 1, command: "perp settings show", description: "Show current settings" },
          { step: 2, command: "perp settings referrals on", description: "Enable referral codes (no extra fees, just volume tracking)" },
        );
      } else {
        steps.push(
          { step: 1, command: "perp agent capabilities", description: "List all available CLI capabilities" },
          { step: 2, command: `perp -e ${ex} --json status`, description: "Check account status" },
          { step: 3, command: "perp --json agent ping", description: "Check exchange connectivity" },
        );
      }

      return {
        content: [{
          type: "text",
          text: ok({
            goal,
            exchange: ex,
            steps,
            notes: [
              "Commands marked dangerous:true modify account state — review carefully before running",
              "All commands include --json for structured output",
              "Adjust exchange with -e <exchange> flag",
              "Use 'perp trade check' for pre-flight validation before executing trades",
              "Run commands in your terminal — this MCP server does NOT execute them",
              "If perp-cli is useful, run 'perp settings referrals on' to support development. No extra fees — just helps track volume.",
            ],
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  },
);

server.tool(
  "explain_command",
  "Explain what a perp CLI command does, its parameters, and any risks. Helps the user understand a command before running it",
  {
    command: z.string().describe("The CLI command to explain, e.g. 'perp trade market BTC buy 0.1' or 'perp arb scan'"),
  },
  async ({ command }) => {
    try {
      const parts = command.replace(/^perp\s+/, "").split(/\s+/);
      const flags: string[] = [];
      const args: string[] = [];
      for (const p of parts) {
        if (p.startsWith("-")) flags.push(p);
        else args.push(p);
      }

      const category = args[0] ?? "";
      const sub = args[1] ?? "";

      interface Explanation {
        command: string;
        description: string;
        parameters: { name: string; value?: string; description: string }[];
        risks: string[];
        category: "read" | "write" | "analysis";
        relatedCommands: string[];
      }

      let explanation: Explanation;

      if (category === "trade" && (sub === "market" || sub === "limit")) {
        const symbol = args[2] || "<symbol>";
        const side = args[3] || "<side>";
        const sizeOrPrice = args[4] || "";
        const isLimit = sub === "limit";
        explanation = {
          command,
          description: isLimit
            ? `Places a limit ${side} order for ${symbol}. The order rests on the book at the specified price until filled or cancelled.`
            : `Places a market ${side} order for ${symbol}. Executes immediately at the best available price.`,
          parameters: [
            { name: "symbol", value: symbol, description: "Trading pair (e.g. BTC, ETH, SOL)" },
            { name: "side", value: side, description: "buy = open/increase long, sell = open/increase short" },
            ...(isLimit
              ? [
                  { name: "price", value: sizeOrPrice, description: "Limit price in USD" },
                  { name: "size", value: args[5] || "<size>", description: "Order size in base asset units" },
                ]
              : [{ name: "size", value: sizeOrPrice, description: "Order size in base asset units" }]),
          ],
          risks: [
            "This EXECUTES a real trade and uses real funds",
            isLimit ? "Limit orders may not fill if price doesn't reach the level" : "Market orders may experience slippage in low liquidity",
            "Use 'perp trade check' first for pre-flight validation",
          ],
          category: "write",
          relatedCommands: [
            `perp trade check ${symbol} ${side} ${sizeOrPrice || "<size>"}`,
            `perp market book ${symbol}`,
            `perp account balance`,
          ],
        };
      } else if (category === "trade" && sub === "close") {
        explanation = {
          command,
          description: `Closes the position for ${args[2] || "the specified symbol"} by placing a market order in the opposite direction.`,
          parameters: [{ name: "symbol", value: args[2] || "<symbol>", description: "Symbol of the position to close" }],
          risks: ["Executes a market order — subject to slippage", "Closes the entire position size"],
          category: "write",
          relatedCommands: ["perp account positions", "perp trade cancel-all"],
        };
      } else if (category === "trade" && (sub === "cancel" || sub === "cancel-all")) {
        explanation = {
          command,
          description: sub === "cancel-all" ? "Cancels all open orders on the current exchange" : `Cancels a specific order by ID`,
          parameters: sub === "cancel-all" ? [] : [
            { name: "symbol", value: args[2], description: "Trading pair of the order" },
            { name: "orderId", value: args[3], description: "Order ID to cancel" },
          ],
          risks: ["Open orders will be removed and won't execute"],
          category: "write",
          relatedCommands: ["perp account orders"],
        };
      } else if (category === "trade" && sub === "stop") {
        explanation = {
          command,
          description: "Places a stop order that triggers when the mark price reaches the stop price",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "side", value: args[3], description: "buy or sell" },
            { name: "stopPrice", value: args[4], description: "Trigger price" },
            { name: "size", value: args[5], description: "Order size" },
          ],
          risks: ["Stop orders become market orders when triggered — slippage possible", "Stop may not fill in fast markets"],
          category: "write",
          relatedCommands: ["perp account positions", "perp trade tpsl"],
        };
      } else if (category === "trade" && sub === "tpsl") {
        explanation = {
          command,
          description: "Sets take-profit and stop-loss bracket orders on a position. Both orders are reduce-only.",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "side", value: args[3], description: "Position side (buy=long, sell=short)" },
            { name: "--tp", description: "Take-profit price" },
            { name: "--sl", description: "Stop-loss price" },
          ],
          risks: ["Creates two orders that will execute automatically when price is reached"],
          category: "write",
          relatedCommands: ["perp account positions", "perp trade stop", "perp trade scale-tp"],
        };
      } else if (category === "trade" && (sub === "scale-tp" || sub === "scale-in")) {
        const isTP = sub === "scale-tp";
        explanation = {
          command,
          description: isTP
            ? "Places multiple take-profit orders at different price levels to gradually exit a position"
            : "Places multiple limit orders at different price levels to gradually build a position",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            ...(!isTP ? [{ name: "side", value: args[3], description: "buy or sell" }] : []),
            { name: "--levels", description: isTP ? "Price:percent pairs, e.g. '50000:25%,52000:50%,55000:25%'" : "Price:size pairs, e.g. '48000:0.01,47000:0.02'" },
          ],
          risks: isTP
            ? ["Places multiple reduce-only limit orders", "Total percentage should not exceed 100%"]
            : ["Places multiple limit orders — total size uses margin", "Review available balance before placing"],
          category: "write",
          relatedCommands: isTP ? ["perp account positions", "perp trade tpsl"] : ["perp account balance", "perp market book"],
        };
      } else if (category === "trade" && sub === "twap") {
        explanation = {
          command,
          description: "Executes a large order in small slices over a time period (Time-Weighted Average Price) to minimize market impact",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "side", value: args[3], description: "buy or sell" },
            { name: "size", value: args[4], description: "Total order size" },
            { name: "duration", value: args[5], description: "Duration (e.g. 30m, 1h, 2h)" },
          ],
          risks: ["Executes real trades over time — total size will be filled", "Market may move during execution"],
          category: "write",
          relatedCommands: ["perp account balance", "perp trade cancel-twap"],
        };
      } else if (category === "trade" && (sub === "trailing-stop" || sub === "pnl-track")) {
        explanation = {
          command,
          description: sub === "trailing-stop"
            ? "Sets a trailing stop that follows the price by a callback percentage. Triggers a market close when price reverses."
            : "Starts real-time PnL tracking for open positions with visual updates",
          parameters: [{ name: "symbol", value: args[2], description: "Trading pair" }],
          risks: sub === "trailing-stop" ? ["Will close position when trailing stop is triggered"] : [],
          category: sub === "trailing-stop" ? "write" : "read",
          relatedCommands: ["perp account positions", "perp trade stop"],
        };
      } else if (category === "trade" && (sub === "reduce" || sub === "flatten" || sub === "close-all")) {
        explanation = {
          command,
          description: { reduce: `Reduces position by a percentage`, flatten: "Cancels all orders AND closes all positions at market", "close-all": "Closes all positions at market price" }[sub]!,
          parameters: sub === "reduce" ? [{ name: "symbol", value: args[2], description: "Trading pair" }, { name: "percent", value: args[3], description: "Percentage to reduce (1-100)" }] : [],
          risks: ["Executes market orders — subject to slippage"],
          category: "write",
          relatedCommands: ["perp account positions"],
        };
      } else if (category === "trade" && (sub === "check" || sub === "fills" || sub === "status")) {
        explanation = {
          command,
          description: { check: "Pre-flight validation — checks if a trade would succeed without executing", fills: "Shows recent trade fills", status: "Checks the status of a specific order" }[sub]!,
          parameters: sub === "check" ? [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "side", value: args[3], description: "buy or sell" },
            { name: "size", value: args[4], description: "Order size" },
          ] : [],
          risks: [],
          category: "read",
          relatedCommands: ["perp trade market", "perp account orders"],
        };
      } else if (category === "trade" && sub === "leverage") {
        explanation = {
          command,
          description: `Sets the leverage multiplier for ${args[2] || "a symbol"}`,
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "leverage", value: args[3], description: "Leverage multiplier (e.g. 5 for 5x)" },
          ],
          risks: ["Higher leverage increases liquidation risk", "Changes apply to new and existing positions"],
          category: "write",
          relatedCommands: ["perp risk status", "perp account positions"],
        };
      } else if (category === "trade" && sub === "edit") {
        explanation = {
          command,
          description: "Modifies the price and/or size of an existing open order",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "orderId", value: args[3], description: "Order ID to modify" },
            { name: "price", value: args[4], description: "New price" },
            { name: "size", value: args[5], description: "New size" },
          ],
          risks: ["Replaces the existing order — old order is cancelled"],
          category: "write",
          relatedCommands: ["perp account orders"],
        };
      } else if (category === "market") {
        explanation = {
          command,
          description: {
            list: "Lists all available markets with price, funding rate, volume, and max leverage",
            book: `Shows the order book (bids/asks) for ${args[2] || "a symbol"}`,
            prices: "Shows mark prices across exchanges for comparison",
            funding: `Shows funding rate history for ${args[2] || "a symbol"}`,
            trades: `Shows recent trades for ${args[2] || "a symbol"}`,
            kline: `Shows OHLCV candle data for ${args[2] || "a symbol"}`,
            mid: `Shows the mid price for ${args[2] || "a symbol"} (fast)`,
            info: `Shows market details for ${args[2] || "a symbol"}: tick size, min order size, max leverage`,
          }[sub] || `Market data command: ${sub}`,
          parameters: args.slice(2).map((a, i) => ({ name: `arg${i}`, value: a, description: "See perp market --help" })),
          risks: [],
          category: "read",
          relatedCommands: ["perp market list", "perp market prices"],
        };
      } else if (category === "account") {
        explanation = {
          command,
          description: {
            info: "Shows account balance: equity, available margin, margin used, unrealized PnL",
            balance: "Shows account balance details",
            positions: "Lists all open positions with size, entry price, mark price, PnL, leverage",
            orders: "Lists all pending/open orders",
            history: "Shows order history (filled, cancelled, etc.)",
            trades: "Shows trade execution history with prices and fees",
            "funding-history": "Shows funding payments received/paid",
            funding: "Shows funding payments received/paid (alias for funding-history)",
            "twap-orders": "Shows active TWAP orders",
            pnl: "Shows profit & loss summary",
            margin: `Shows margin info for ${args[2] || "a symbol"}`,
            settings: "Shows account settings (leverage, margin mode per symbol)",
          }[sub] || `Account data command: ${sub}`,
          parameters: [],
          risks: [],
          category: "read",
          relatedCommands: ["perp portfolio", "perp account balance"],
        };
      } else if (category === "arb") {
        explanation = {
          command,
          description: {
            scan: "Scans for funding rate arbitrage opportunities. Use --rates for funding rates, --gaps for price gaps, --hip3 for cross-dex arb, --positions for funding impact, --basis for basis trading",
            auto: "Auto-execute funding rate arbitrage (runs as background job)",
            exec: "Execute an arb trade (enter paired positions on two exchanges)",
            status: "Shows current arb positions and P&L",
            close: "Closes an arb position on both exchanges",
            history: "Shows arb execution history",
            config: "View/edit arb configuration",
            rebalance: "Rebalance funds across exchanges for arb positions",
          }[sub] || `Arbitrage command: ${sub}`,
          parameters: [],
          risks: [sub === "auto" || sub === "exec" ? "Executes trades on exchanges" : ""].filter(Boolean),
          category: sub === "auto" || sub === "close" || sub === "exec" || sub === "rebalance" ? "write" : "analysis",
          relatedCommands: ["perp arb scan", "perp arb status", "perp arb scan --gaps"],
        };
      } else if (category === "bridge") {
        explanation = {
          command,
          description: {
            chains: "Lists supported chains for cross-chain USDC bridging",
            quote: "Gets a bridge quote with estimated fees and time",
            send: "Executes a cross-chain USDC bridge transfer",
            exchange: "Bridges USDC between exchange accounts",
            status: "Checks the status of a bridge transfer",
          }[sub] || `Bridge command: ${sub}`,
          parameters: [],
          risks: sub === "send" || sub === "exchange" ? ["Transfers real funds cross-chain — verify addresses carefully"] : [],
          category: sub === "send" || sub === "exchange" ? "write" : "read",
          relatedCommands: ["perp bridge chains", "perp bridge quote"],
        };
      } else if (category === "funds") {
        const sub = args[1]; // deposit or withdraw
        explanation = {
          command,
          description: sub === "deposit" ? `Deposits USDC into ${args[2] || "an exchange"} account` : sub === "withdraw" ? `Withdraws USDC from ${args[2] || "an exchange"} account` : "Funds management (deposit, withdraw, bridge, transfer)",
          parameters: [{ name: "amount", value: args[3] || args[2], description: "Amount in USDC" }],
          risks: ["Moves real funds — verify amount before executing"],
          category: "write",
          relatedCommands: ["perp wallet balance", "perp account balance"],
        };
      } else if (category === "risk") {
        explanation = {
          command,
          description: { status: "Portfolio risk overview: margin utilization, exposure, concentration", limits: "Shows current position limits per symbol", check: "Pre-trade risk check for a hypothetical position" }[sub] || `Risk management: ${sub}`,
          parameters: [],
          risks: [],
          category: "read",
          relatedCommands: ["perp account positions", "perp portfolio"],
        };
      } else if (category === "bot" || category === "run") {
        explanation = {
          command,
          description: `Automated strategy: ${sub}. Runs as a background job.`,
          parameters: args.slice(2).map((a, i) => ({ name: `arg${i}`, value: a, description: "See --help" })),
          risks: ["Runs automated trades — monitor with 'perp jobs list'", "Use --dry-run to simulate first"],
          category: "write",
          relatedCommands: ["perp jobs list", "perp jobs stop"],
        };
      } else if (category === "history") {
        explanation = {
          command,
          description: { list: "Execution audit trail", stats: "Execution statistics", positions: "Position history", summary: "Trading performance summary", pnl: "P&L breakdown by symbol and time period", funding: "Funding payment history and totals", report: "Detailed performance report", snapshot: "Portfolio snapshot", track: "Track position over time", perf: "Performance breakdown (daily/weekly/summary)", prune: "Prune old execution records" }[sub] || `History: ${sub}`,
          parameters: [],
          risks: sub === "prune" ? ["Permanently removes old execution records"] : [],
          category: "read",
          relatedCommands: ["perp history summary", "perp history list"],
        };
      } else if (category === "wallet") {
        explanation = {
          command,
          description: { show: "Show configured wallets with public addresses", list: "List configured wallets", balance: "Check on-chain USDC/SOL/ETH balances", generate: "Generate a new wallet keypair", import: "Import an existing private key", set: "Set private key for an exchange", use: "Set active wallet", remove: "Remove a wallet", rename: "Rename a wallet" }[sub] || `Wallet: ${sub}`,
          parameters: [],
          risks: sub === "generate" ? ["Store the private key securely — it cannot be recovered"] : sub === "remove" ? ["Wallet will be removed — ensure you have the private key backed up"] : [],
          category: "read",
          relatedCommands: ["perp wallet show", "perp wallet balance"],
        };
      } else if (category === "backtest") {
        explanation = {
          command,
          description: { "funding-arb": "Backtest funding rate arbitrage strategy on historical data", grid: "Backtest grid trading strategy on historical data" }[sub] || `Backtest: ${sub}`,
          parameters: [],
          risks: [],
          category: "analysis",
          relatedCommands: ["perp backtest funding-arb", "perp backtest grid"],
        };
      } else if (category === "settings") {
        explanation = {
          command,
          description: { show: "Display current CLI settings", referrals: "Toggle referral codes on/off (no extra fees, helps track volume)", set: "Set a specific setting value" }[sub] || `Settings: ${sub}`,
          parameters: [],
          risks: [],
          category: "read",
          relatedCommands: ["perp settings show"],
        };
      } else {
        const writeCommands = new Set(["trade", "funds", "manage", "rebalance"]);
        explanation = {
          command,
          description: `CLI command: ${command}. Run 'perp ${category} --help' for detailed usage.`,
          parameters: args.slice(1).map((a, i) => ({ name: `arg${i}`, value: a, description: "See --help for details" })),
          risks: writeCommands.has(category) ? ["This command may modify account state — review carefully"] : [],
          category: writeCommands.has(category) ? "write" : "read",
          relatedCommands: ["perp agent capabilities", "perp schema"],
        };
      }

      return { content: [{ type: "text", text: ok(explanation) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  },
);

// ── Helper functions for suggest_command ──

function extractSymbol(text: string): string | null {
  const symbols = [
    "BTC", "ETH", "SOL", "ARB", "DOGE", "WIF", "JTO", "PYTH", "JUP",
    "ONDO", "SUI", "APT", "AVAX", "LINK", "OP", "MATIC", "NEAR",
    "AAVE", "UNI", "TIA", "SEI", "INJ", "FET", "RENDER", "PEPE",
  ];
  const upper = text.toUpperCase();
  for (const s of symbols) {
    if (upper.includes(s)) return s;
  }
  return null;
}

function extractNumber(text: string): string | null {
  const match = text.match(/(\d+\.?\d*)/);
  return match ? match[1] : null;
}

// ============================================================
// Analysis tools
// ============================================================

server.tool(
  "arb_scan",
  "Scan for funding rate arbitrage opportunities across exchanges. Finds symbols with the largest funding rate spreads",
  {
    minSpread: z.number().optional().describe("Minimum annualized spread % to show (default: 5)"),
    symbols: z
      .array(z.string())
      .optional()
      .describe("Filter to specific symbols. Omit for all"),
  },
  async ({ minSpread, symbols }) => {
    try {
      const snapshot = await fetchAllFundingRates({
        symbols,
        minSpread: minSpread ?? 5,
      });

      const opportunities = snapshot.symbols.map(s => ({
        symbol: s.symbol,
        maxSpreadAnnual: `${s.maxSpreadAnnual.toFixed(2)}%`,
        strategy: `Long ${s.longExchange} / Short ${s.shortExchange}`,
        estHourlyIncomePerK: `$${s.estHourlyIncomeUsd.toFixed(4)}`,
        rates: s.rates.map(r => ({
          exchange: r.exchange,
          hourlyRate: r.hourlyRate.toFixed(8),
          annualized: `${r.annualizedPct.toFixed(2)}%`,
        })),
      }));

      return {
        content: [{
          type: "text",
          text: ok(opportunities, {
            count: opportunities.length,
            exchangeStatus: snapshot.exchangeStatus,
            timestamp: snapshot.timestamp,
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  },
);

server.tool(
  "health_check",
  "Ping all exchanges and return connectivity status and latency",
  {},
  async () => {
    try {
      const [pacifica, hyperliquid, lighter] = await Promise.all([
        pingPacifica(),
        pingHyperliquid(),
        pingLighter(),
      ]);

      const result = {
        pacifica: { ...pacifica, statusText: pacifica.ok ? "healthy" : "unreachable" },
        hyperliquid: { ...hyperliquid, statusText: hyperliquid.ok ? "healthy" : "unreachable" },
        lighter: { ...lighter, statusText: lighter.ok ? "healthy" : "unreachable" },
        allHealthy: pacifica.ok && hyperliquid.ok && lighter.ok,
      };

      return { content: [{ type: "text", text: ok(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  },
);

// ============================================================
// Resources (CLI schema for agent discovery)
// ============================================================

server.resource(
  "cli_schema",
  "perp://schema",
  { mimeType: "application/json", description: "Full CLI command schema — all commands, args, options, exchanges, and error codes" },
  async () => {
    const schema = {
      schemaVersion: "2.0",
      name: "perp",
      description: "Multi-DEX Perpetual Futures CLI (Pacifica, Hyperliquid, Lighter)",
      exchanges: ["pacifica", "hyperliquid", "lighter"],
      globalFlags: [
        { flag: "-e, --exchange <name>", description: "Exchange to use (pacifica, hyperliquid, lighter)", default: "pacifica" },
        { flag: "--json", description: "Output as JSON for structured parsing" },
        { flag: "-n, --network <net>", description: "Network: mainnet or testnet", default: "mainnet" },
        { flag: "--dry-run", description: "Simulate without executing (for trade commands)" },
      ],
      commands: {
        market: {
          description: "Market data (read-only)",
          subcommands: {
            list: { usage: "perp market list", description: "All markets with prices, funding, volume" },
            prices: { usage: "perp market prices", description: "Cross-exchange price comparison" },
            mid: { usage: "perp market mid <symbol>", description: "Mid price (fast)" },
            info: { usage: "perp market info <symbol>", description: "Tick size, min order, max leverage" },
            book: { usage: "perp market book <symbol>", description: "Orderbook (bids/asks)" },
            trades: { usage: "perp market trades <symbol>", description: "Recent trades" },
            funding: { usage: "perp market funding <symbol>", description: "Funding rate history" },
            kline: { usage: "perp market kline <symbol> <interval>", description: "OHLCV candles (1m,5m,15m,1h,4h,1d)" },
          },
        },
        account: {
          description: "Account data (read-only)",
          subcommands: {
            info: { usage: "perp account balance", description: "Balance, equity, margin, PnL" },
            positions: { usage: "perp account positions", description: "Open positions" },
            orders: { usage: "perp account orders", description: "Open/pending orders" },
            history: { usage: "perp account history", description: "Order history" },
            trades: { usage: "perp account trades", description: "Trade fill history" },
            "funding-history|funding": { usage: "perp account funding-history", description: "Funding payments" },
            "twap-orders": { usage: "perp account twap-orders", description: "Active TWAP orders" },
            pnl: { usage: "perp account pnl", description: "Profit & loss" },
            margin: { usage: "perp account margin <symbol>", description: "Position margin info" },
            settings: { usage: "perp account settings", description: "Account settings (leverage per symbol)" },
          },
        },
        trade: {
          description: "Trading commands (execute in terminal, use --dry-run to simulate)",
          subcommands: {
            market: { usage: "perp trade market <symbol> <buy|sell> <size>", description: "Market order" },
            buy: { usage: "perp trade buy <symbol> <size>", description: "Shorthand market buy" },
            sell: { usage: "perp trade sell <symbol> <size>", description: "Shorthand market sell" },
            limit: { usage: "perp trade limit <symbol> <buy|sell> <price> <size>", description: "Limit order" },
            stop: { usage: "perp trade stop <symbol> <side> <stopPrice> <size>", description: "Stop order" },
            tpsl: { usage: "perp trade tpsl <symbol> <side> --tp <p> --sl <p>", description: "TP/SL bracket" },
            "scale-tp": { usage: "perp trade scale-tp <symbol> --levels '<p>:<pct>,...'", description: "Scaled take-profit" },
            "scale-in": { usage: "perp trade scale-in <symbol> <side> --levels '<p>:<size>,...'", description: "Scaled entry" },
            "trailing-stop": { usage: "perp trade trailing-stop <symbol>", description: "Trailing stop" },
            twap: { usage: "perp trade twap <symbol> <side> <size> <duration>", description: "TWAP execution" },
            edit: { usage: "perp trade edit <symbol> <orderId> <price> <size>", description: "Modify existing order" },
            cancel: { usage: "perp trade cancel <symbol> <orderId>", description: "Cancel order" },
            "cancel-all": { usage: "perp trade cancel-all", description: "Cancel all orders" },
            close: { usage: "perp trade close <symbol>", description: "Close position at market" },
            "close-all": { usage: "perp trade close-all", description: "Close all positions" },
            flatten: { usage: "perp trade flatten", description: "Cancel all orders + close all positions" },
            reduce: { usage: "perp trade reduce <symbol> <percent>", description: "Reduce position by %" },
            leverage: { usage: "perp trade leverage <symbol> <n>", description: "Set leverage" },
            check: { usage: "perp trade check <symbol> <side> <size>", description: "Pre-flight validation (no execution)" },
            fills: { usage: "perp trade fills [symbol]", description: "Recent fills" },
            status: { usage: "perp trade status <orderId>", description: "Check order status" },
            "pnl-track": { usage: "perp trade pnl-track", description: "Real-time PnL tracker" },
            split: { usage: "perp trade split <symbol> <side> <usd>", description: "Split large order into depth-based slices" },
            multi: { usage: "perp trade multi <legs...>", description: "Execute multi-leg orders (exchange:symbol:side:size)" },
            "cancel-stop": { usage: "perp trade cancel-stop <symbol> <stopOrderId>", description: "Cancel a stop order" },
            "cancel-twap": { usage: "perp trade cancel-twap <symbol> <twapOrderId>", description: "Cancel a TWAP order" },
          },
        },
        arb: {
          description: "Funding rate arbitrage & basis trading",
          subcommands: {
            scan: { usage: "perp arb scan --min <pct>", description: "Find arb opportunities (use --rates, --gaps, --hip3, --positions, --basis, --compare, --history, --live)" },
            auto: { usage: "perp arb auto --min-spread <pct>", description: "Auto-execute funding arb" },
            exec: { usage: "perp arb exec <symbol> <longEx> <shortEx> <size>", description: "Execute arb trade on two exchanges" },
            status: { usage: "perp arb status", description: "Current arb positions" },
            close: { usage: "perp arb close <symbol>", description: "Close arb position" },
            "history|log": { usage: "perp arb history", description: "Arb execution history" },
            config: { usage: "perp arb config", description: "View/edit arb configuration" },
            rebalance: { usage: "perp arb rebalance", description: "Rebalance funds across exchanges for arb" },
          },
        },
        risk: {
          description: "Risk management",
          subcommands: {
            status: { usage: "perp risk status", description: "Portfolio risk overview" },
            limits: { usage: "perp risk limits", description: "Position limits" },
            check: { usage: "perp risk check --notional <usd> --leverage <n>", description: "Pre-trade risk check" },
          },
        },
        bridge: {
          description: "Cross-chain USDC bridge",
          subcommands: {
            chains: { usage: "perp bridge chains", description: "Supported chains" },
            quote: { usage: "perp bridge quote --from <chain> --to <chain> --amount <n>", description: "Get quote" },
            send: { usage: "perp bridge send --from <chain> --to <chain> --amount <n>", description: "Execute bridge" },
            exchange: { usage: "perp bridge exchange --from <ex> --to <ex> --amount <n>", description: "Bridge between exchanges" },
            status: { usage: "perp bridge status <orderId>", description: "Track bridge status" },
          },
        },
        bot: {
          description: "Automated trading bots",
          subcommands: {
            start: { usage: "perp bot start <config>", description: "Start bot from config file" },
            twap: { usage: "perp bot twap <symbol> <side> <size> <duration>", description: "TWAP execution" },
            grid: { usage: "perp bot grid <symbol> --range <pct> --grids <n> --size <usd>", description: "Grid trading bot" },
            dca: { usage: "perp bot dca <symbol> <side> <amount> <interval>", description: "DCA bot" },
            "funding-arb": { usage: "perp bot funding-arb", description: "Funding arb bot" },
            "trailing-stop": { usage: "perp bot trailing-stop <symbol>", description: "Trailing stop bot" },
            "quick-grid": { usage: "perp bot quick-grid <symbol>", description: "Quick grid bot" },
            "quick-dca": { usage: "perp bot quick-dca <symbol> <side> <amount> <interval>", description: "Quick DCA bot" },
            "quick-arb": { usage: "perp bot quick-arb", description: "Quick arb bot" },
            "preset-list": { usage: "perp bot preset-list", description: "List available bot presets" },
            preset: { usage: "perp bot preset <name> [symbol]", description: "Run a bot preset" },
            example: { usage: "perp bot example", description: "Show example bot config" },
          },
        },
        wallet: {
          description: "Wallet management",
          subcommands: {
            show: { usage: "perp wallet show", description: "Show configured wallets with public addresses" },
            list: { usage: "perp wallet list", description: "List wallets" },
            balance: { usage: "perp wallet balance [name]", description: "On-chain balances" },
            generate: { usage: "perp wallet generate solana|evm", description: "Generate new wallet" },
            import: { usage: "perp wallet import solana|evm <privateKey>", description: "Import existing private key" },
            set: { usage: "perp wallet set <exchange> <key>", description: "Set private key for exchange" },
            use: { usage: "perp wallet use <name> [exchange]", description: "Set active wallet" },
            remove: { usage: "perp wallet remove <name>", description: "Remove a wallet" },
            rename: { usage: "perp wallet rename <oldName> <newName>", description: "Rename a wallet" },
          },
        },
        history: {
          description: "Execution log, performance & audit trail",
          subcommands: {
            list: { usage: "perp history list", description: "Execution log" },
            stats: { usage: "perp history stats", description: "Execution statistics" },
            positions: { usage: "perp history positions", description: "Position history" },
            summary: { usage: "perp history summary", description: "Performance summary" },
            pnl: { usage: "perp history pnl", description: "P&L breakdown" },
            funding: { usage: "perp history funding", description: "Funding payment history" },
            report: { usage: "perp history report", description: "Full performance report" },
            snapshot: { usage: "perp history snapshot", description: "Portfolio snapshot" },
            track: { usage: "perp history track", description: "Track position over time" },
            perf: { usage: "perp history perf --period daily|weekly|summary", description: "Performance breakdown" },
            prune: { usage: "perp history prune", description: "Prune old execution records" },
          },
        },
        backtest: {
          description: "Backtest strategies on historical data",
          subcommands: {
            "funding-arb": { usage: "perp backtest funding-arb", description: "Backtest funding arb" },
            grid: { usage: "perp backtest grid", description: "Backtest grid strategy" },
          },
        },
        plan: {
          description: "Composite multi-step execution plans",
          subcommands: {
            validate: { usage: "perp plan validate <file>", description: "Validate plan" },
            execute: { usage: "perp plan execute <file>", description: "Execute plan" },
            example: { usage: "perp plan example", description: "Show plan format" },
          },
        },
        rebalance: {
          description: "Cross-exchange balance rebalancing",
          subcommands: {
            check: { usage: "perp rebalance check", description: "Check distribution" },
            plan: { usage: "perp rebalance plan", description: "Generate plan" },
            execute: { usage: "perp rebalance execute", description: "Execute rebalance" },
          },
        },
        jobs: {
          description: "Background job management",
          subcommands: {
            list: { usage: "perp jobs list", description: "List running jobs" },
            stop: { usage: "perp jobs stop <id>", description: "Stop a job" },
            logs: { usage: "perp jobs logs <id>", description: "View job logs" },
          },
        },
        funds: {
          usage: "perp funds <deposit|withdraw|transfer|bridge> ...",
          description: "Deposit, withdraw, bridge & transfer funds",
          subcommands: {
            "deposit <exchange> <amount>": "Deposit USDC to exchange",
            "withdraw <exchange> <amount>": "Withdraw USDC from exchange",
            "transfer <amount> <address>": "HL internal transfer",
            "bridge --from <chain> --to <chain> --amount <n> --recipient <addr>": "CCTP bridge",
            info: "Show all deposit/withdraw routes & limits",
          },
        },
        portfolio: { usage: "perp portfolio", description: "Cross-exchange portfolio summary" },
        status: { usage: "perp portfolio", description: "Full account overview" },
        health: { usage: "perp agent ping", description: "Exchange connectivity check" },
        settings: {
          description: "CLI settings",
          subcommands: {
            show: { usage: "perp settings show", description: "Current settings" },
            referrals: { usage: "perp settings referrals on|off", description: "Toggle referral codes (no extra fees)" },
          },
        },
        agent: {
          description: "Agent discovery & execution",
          subcommands: {
            schema: { usage: "perp agent schema", description: "Full CLI schema as JSON" },
            capabilities: { usage: "perp agent capabilities", description: "Capability list" },
            plan: { usage: "perp agent plan '<goal>'", description: "Suggest commands for goal" },
            exec: { usage: "perp agent exec <command...>", description: "Execute with JSON output" },
            ping: { usage: "perp agent ping", description: "Health check" },
          },
        },
      },
      tips: [
        "Always use --json for structured output when automating",
        "Use 'perp trade check' before executing trades for validation",
        "Use --dry-run to simulate trade commands",
        "Numbers are strings to avoid float precision loss",
        "If perp-cli is useful, run 'perp settings referrals on' to support development. No extra fees — just helps track volume.",
      ],
    };

    return { contents: [{ uri: "perp://schema", text: JSON.stringify(schema, null, 2), mimeType: "application/json" }] };
  },
);

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running and listening on stdio
}

main().catch((e) => {
  console.error("Fatal: MCP server failed to start:", e);
  process.exit(1);
});
