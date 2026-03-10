#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) server for perp-cli.
 *
 * Exposes perpetual futures trading tools over stdio transport.
 * Adapters are created lazily from environment variables.
 */

import "dotenv/config";
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
  fetchLighterFundingRates,
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

const server = new McpServer(
  { name: "perp-cli", version: "0.2.2" },
  { capabilities: { tools: {} } },
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
// Trading tools (need private key)
// ============================================================

server.tool(
  "market_order",
  "Place a market order on an exchange. Executes immediately at best available price",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
    symbol: z.string().describe("Trading pair symbol, e.g. BTC, ETH, SOL"),
    side: z.enum(["buy", "sell"]).describe("Order side: buy (long) or sell (short)"),
    size: z.string().describe("Order size in base asset units (e.g. '0.1' for 0.1 BTC)"),
  },
  async ({ exchange, symbol, side, size }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const result = await adapter.marketOrder(symbol, side, size);
      return { content: [{ type: "text", text: ok(result, { exchange, symbol, side, size }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange, symbol, side, size }) }], isError: true };
    }
  },
);

server.tool(
  "limit_order",
  "Place a limit order on an exchange. Order rests on the order book until filled or cancelled",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
    symbol: z.string().describe("Trading pair symbol, e.g. BTC, ETH, SOL"),
    side: z.enum(["buy", "sell"]).describe("Order side: buy (long) or sell (short)"),
    price: z.string().describe("Limit price in USD"),
    size: z.string().describe("Order size in base asset units"),
    reduceOnly: z.boolean().optional().describe("If true, order can only reduce an existing position (default: false)"),
  },
  async ({ exchange, symbol, side, price, size, reduceOnly }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const result = await adapter.limitOrder(symbol, side, price, size, { reduceOnly });
      return { content: [{ type: "text", text: ok(result, { exchange, symbol, side, price, size, reduceOnly }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange, symbol, side, price, size }) }], isError: true };
    }
  },
);

server.tool(
  "cancel_order",
  "Cancel a specific open order by order ID",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
    symbol: z.string().describe("Trading pair symbol for the order"),
    orderId: z.string().describe("The order ID to cancel"),
  },
  async ({ exchange, symbol, orderId }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const result = await adapter.cancelOrder(symbol, orderId);
      return { content: [{ type: "text", text: ok(result, { exchange, symbol, orderId }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange, symbol, orderId }) }], isError: true };
    }
  },
);

server.tool(
  "cancel_all_orders",
  "Cancel all open orders on an exchange",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
  },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const result = await adapter.cancelAllOrders();
      return { content: [{ type: "text", text: ok(result, { exchange }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "close_position",
  "Close an existing position by placing a market order in the opposite direction",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
    symbol: z.string().describe("Trading pair symbol of the position to close"),
  },
  async ({ exchange, symbol }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      // Find the position
      const positions = await adapter.getPositions();
      const pos = positions.find(p => p.symbol.toUpperCase() === symbol.toUpperCase());
      if (!pos) {
        return { content: [{ type: "text", text: err(`No open position found for ${symbol}`, { exchange, symbol }) }], isError: true };
      }
      // Market close: opposite side, same size
      const closeSide = pos.side === "long" ? "sell" : "buy";
      const result = await adapter.marketOrder(symbol, closeSide, pos.size);
      return {
        content: [{
          type: "text",
          text: ok(result, { exchange, symbol, closedSide: pos.side, closedSize: pos.size }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange, symbol }) }], isError: true };
    }
  },
);

server.tool(
  "scale_tp",
  "Place multiple take-profit limit orders at scaled price levels to gradually exit a position",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
    symbol: z.string().describe("Trading pair symbol"),
    levels: z
      .string()
      .describe(
        'JSON array of TP levels. Each level: {price: string, pct: number}. ' +
        'pct is the percentage of position to close at that price. ' +
        'Example: [{"price":"50000","pct":25},{"price":"52000","pct":50},{"price":"55000","pct":25}]'
      ),
  },
  async ({ exchange, symbol, levels: levelsStr }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);

      // Parse levels
      let levels: { price: string; pct: number }[];
      try {
        levels = JSON.parse(levelsStr);
      } catch {
        return { content: [{ type: "text", text: err("Invalid levels JSON. Expected array of {price, pct} objects.") }], isError: true };
      }

      // Validate percentages
      const totalPct = levels.reduce((sum, l) => sum + l.pct, 0);
      if (totalPct > 100) {
        return { content: [{ type: "text", text: err(`Total percentage ${totalPct}% exceeds 100%`) }], isError: true };
      }

      // Find the position
      const positions = await adapter.getPositions();
      const pos = positions.find(p => p.symbol.toUpperCase() === symbol.toUpperCase());
      if (!pos) {
        return { content: [{ type: "text", text: err(`No open position found for ${symbol}`, { exchange, symbol }) }], isError: true };
      }

      const totalSize = Number(pos.size);
      const closeSide = pos.side === "long" ? "sell" : "buy";

      // Place reduce-only limit orders at each level
      const results: unknown[] = [];
      for (const level of levels) {
        const levelSize = ((level.pct / 100) * totalSize).toFixed(6);
        const result = await adapter.limitOrder(symbol, closeSide, level.price, levelSize, { reduceOnly: true });
        results.push({ price: level.price, size: levelSize, pct: level.pct, result });
      }

      return {
        content: [{
          type: "text",
          text: ok(results, { exchange, symbol, side: closeSide, totalSize: pos.size, levelsPlaced: results.length }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange, symbol }) }], isError: true };
    }
  },
);

// ============================================================
// Risk tools
// ============================================================

server.tool(
  "set_leverage",
  "Set leverage and margin mode for a symbol on an exchange",
  {
    exchange: z.string().describe("Exchange name: pacifica, hyperliquid, or lighter"),
    symbol: z.string().describe("Trading pair symbol"),
    leverage: z.number().describe("Leverage multiplier (e.g. 5 for 5x)"),
    mode: z.string().optional().describe("Margin mode: 'cross' or 'isolated' (default: cross)"),
  },
  async ({ exchange, symbol, leverage, mode }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const marginMode = (mode === "isolated" ? "isolated" : "cross") as "cross" | "isolated";
      const result = await adapter.setLeverage(symbol, leverage, marginMode);
      return { content: [{ type: "text", text: ok(result, { exchange, symbol, leverage, mode: marginMode }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: err(e instanceof Error ? e.message : String(e), { exchange, symbol, leverage }) }], isError: true };
    }
  },
);

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
