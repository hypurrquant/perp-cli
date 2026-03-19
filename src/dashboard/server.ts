/**
 * Live Dashboard Server — HTTP + WebSocket for real-time portfolio monitoring.
 *
 * Polls all configured exchange adapters and pushes updates to connected clients.
 * Includes cross-exchange arb data: funding rate comparison + dex arb scan.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { ExchangeAdapter, ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeMarketInfo } from "../exchanges/index.js";
import { getUI } from "./ui.js";
import { WsFeedManager, type WsFeedState } from "./ws-feeds.js";

export interface DashboardExchange {
  name: string;
  adapter: ExchangeAdapter;
}

export interface ArbOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  spreadAnnual: number;
  estHourlyUsd: number;
  rates: { exchange: string; annualizedPct: number; hourlyRate: number; markPrice: number }[];
}

export interface DexArbOpportunity {
  underlying: string;
  longDex: string;
  shortDex: string;
  annualSpread: number;
  priceGapPct: number;
  viability: string;
}

export interface DexAssetRow {
  base: string;
  dexes: { dex: string; rate: number; annualizedPct: number; markPrice: number; oi: number }[];
}

export interface DashboardSnapshot {
  timestamp: string;
  exchanges: {
    name: string;
    balance: ExchangeBalance;
    positions: ExchangePosition[];
    orders: ExchangeOrder[];
    topMarkets: ExchangeMarketInfo[];
  }[];
  totals: {
    equity: number;
    available: number;
    marginUsed: number;
    unrealizedPnl: number;
    positionCount: number;
    orderCount: number;
  };
  arb: {
    opportunities: ArbOpportunity[];
    dexArb: DexArbOpportunity[];
    dexAssets: DexAssetRow[];
    dexNames: string[];
    exchangeStatus: Record<string, string>;
  };
}

export interface DashboardOpts {
  port?: number;
  pollInterval?: number; // ms, default 5000
  arbInterval?: number;  // ms, default 30000 (arb data is heavier, poll less often)
  signal?: AbortSignal;
}

// Cached arb data (polled less frequently)
let cachedArb: DashboardSnapshot["arb"] = { opportunities: [], dexArb: [], dexAssets: [], dexNames: [], exchangeStatus: {} };
// Cached market data (polled with arb cycle — market metadata rarely changes)
const cachedMarkets = new Map<string, ExchangeMarketInfo[]>();

/**
 * Find an available port starting from the given port.
 */
async function findPort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(startPort, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : startPort;
      srv.close(() => resolve(port));
    });
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(findPort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Fetch arb data: cross-exchange funding rates + HIP-3 dex arb.
 */
async function pollArbData(): Promise<DashboardSnapshot["arb"]> {
  const opportunities: ArbOpportunity[] = [];
  const dexArb: DexArbOpportunity[] = [];
  let exchangeStatus: Record<string, string> = {};

  try {
    const { fetchAllFundingRates } = await import("../funding/rates.js");
    const snapshot = await fetchAllFundingRates({ minSpread: 5 });
    exchangeStatus = snapshot.exchangeStatus;

    for (const sym of snapshot.symbols.slice(0, 20)) {
      opportunities.push({
        symbol: sym.symbol,
        longExchange: sym.longExchange,
        shortExchange: sym.shortExchange,
        spreadAnnual: sym.maxSpreadAnnual,
        estHourlyUsd: sym.estHourlyIncomeUsd,
        rates: sym.rates.map((r) => ({
          exchange: r.exchange,
          annualizedPct: r.annualizedPct,
          hourlyRate: r.hourlyRate,
          markPrice: r.markPrice,
        })),
      });
    }
  } catch {
    // funding rates unavailable
  }

  const dexAssets: DexAssetRow[] = [];
  const dexNamesSet = new Set<string>();

  try {
    const { fetchAllDexAssets, findDexArbPairs } = await import("../dex-asset-map.js");
    const { annualizeRate } = await import("../funding/normalize.js");

    // Single fetch — used for both arb pairs and rate comparison table
    const allAssets = await fetchAllDexAssets();
    const pairs = findDexArbPairs(allAssets, { minAnnualSpread: 10 });

    for (const p of pairs.slice(0, 15)) {
      dexArb.push({
        underlying: p.underlying,
        longDex: `${p.long.dex}:${p.long.base}`,
        shortDex: `${p.short.dex}:${p.short.base}`,
        annualSpread: p.annualSpread,
        priceGapPct: p.priceGapPct,
        viability: p.viability,
      });
    }
    const byBase = new Map<string, typeof allAssets>();
    for (const a of allAssets) {
      dexNamesSet.add(a.dex);
      if (!byBase.has(a.base)) byBase.set(a.base, []);
      byBase.get(a.base)!.push(a);
    }

    // Only show assets on 2+ dexes, sorted by max spread
    for (const [base, assets] of byBase) {
      if (assets.length < 2) continue;
      const row: DexAssetRow = {
        base,
        dexes: assets.map((a) => {
          // All dex funding rates are already per-hour, same as hyperliquid
          const ann = annualizeRate(a.fundingRate, "hyperliquid");
          return { dex: a.dex, rate: a.fundingRate, annualizedPct: ann, markPrice: a.markPrice, oi: a.openInterest };
        }),
      };
      dexAssets.push(row);
    }
    // Sort by max spread across dexes
    dexAssets.sort((a, b) => {
      const spreadA = Math.max(...a.dexes.map((d) => d.annualizedPct)) - Math.min(...a.dexes.map((d) => d.annualizedPct));
      const spreadB = Math.max(...b.dexes.map((d) => d.annualizedPct)) - Math.min(...b.dexes.map((d) => d.annualizedPct));
      return spreadB - spreadA;
    });
  } catch {
    // dex arb unavailable
  }

  const dexNames = [...dexNamesSet].sort();
  return { opportunities, dexArb, dexAssets: dexAssets.slice(0, 30), dexNames, exchangeStatus };
}

/**
 * Poll all exchanges and return a unified snapshot.
 */
/** Poll market data for all exchanges (called on arb cycle, not every 5s) */
async function pollMarkets(exchanges: DashboardExchange[]): Promise<void> {
  await Promise.allSettled(
    exchanges.map(async (ex) => {
      try {
        const markets = await ex.adapter.getMarkets();
        cachedMarkets.set(ex.name, markets.slice(0, 10));
      } catch {
        // keep previous cached data
      }
    }),
  );
}

/** Build snapshot from WsFeedManager state (no REST calls needed) */
function buildSnapshotFromFeeds(feedMgr: WsFeedManager, exchanges: DashboardExchange[]): DashboardSnapshot {
  const states = feedMgr.getAllStates();
  let exchangeData: DashboardSnapshot["exchanges"] = [];

  for (const ex of exchanges) {
    const state = states.get(ex.name);
    const emptyBal: ExchangeBalance = { equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0" };
    exchangeData.push({
      name: ex.name,
      balance: state?.balance ?? emptyBal,
      positions: [...(state?.positions ?? [])],  // copy — mergeAndTotal mutates
      orders: [...(state?.orders ?? [])],
      topMarkets: cachedMarkets.get(ex.name) ?? [],
    });
  }

  return mergeAndTotal(exchangeData);
}

/** Legacy REST-based snapshot (used for /api/snapshot fallback) */
async function pollSnapshot(exchanges: DashboardExchange[], feedMgr?: WsFeedManager): Promise<DashboardSnapshot> {
  // If feedMgr is available, use WS state directly (no API calls)
  if (feedMgr) {
    return buildSnapshotFromFeeds(feedMgr, exchanges);
  }

  const { withCache, TTL_ACCOUNT } = await import("../cache.js");
  const emptyBalance: ExchangeBalance = { equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0" };
  const results = await Promise.allSettled(
    exchanges.map(async (ex) => {
      const [balance, positions, orders] = await Promise.all([
        withCache(`dash:${ex.name}:balance`, TTL_ACCOUNT, () => ex.adapter.getBalance()).catch(() => emptyBalance),
        withCache(`dash:${ex.name}:positions`, TTL_ACCOUNT, () => ex.adapter.getPositions()).catch(() => [] as ExchangePosition[]),
        withCache(`dash:${ex.name}:orders`, TTL_ACCOUNT, () => ex.adapter.getOpenOrders()).catch(() => [] as ExchangeOrder[]),
      ]);
      return { name: ex.name, balance, positions, orders, topMarkets: cachedMarkets.get(ex.name) ?? [] };
    }),
  );

  let exchangeData = results
    .filter((r): r is PromiseFulfilledResult<DashboardSnapshot["exchanges"][0]> => r.status === "fulfilled")
    .map((r) => r.value);

  return mergeAndTotal(exchangeData);
}

/** Merge HL dex entries + compute totals */
function mergeAndTotal(exchangeData: DashboardSnapshot["exchanges"]): DashboardSnapshot {
  // Merge hl:* dex entries into main hyperliquid (same wallet, dex pools are subsets of main balance)
  const hlEntry = exchangeData.find(e => e.name === "hyperliquid");
  if (hlEntry) {
    const dexEntries = exchangeData.filter(e => e.name.startsWith("hl:") && e.name !== "hyperliquid");
    // Main accountValue already includes dex pool funds — DON'T add dex balances (would double-count).
    // Only merge positions/orders, and attach dex breakdown for UI display.
    const dexBalances: { name: string; balance: ExchangeBalance }[] = [];
    let dexPnlSum = 0;
    for (const dex of dexEntries) {
      const dexName = dex.name.replace("hl:", "");
      dexBalances.push({ name: dexName, balance: { ...dex.balance } });
      hlEntry.positions.push(...dex.positions);
      hlEntry.orders.push(...dex.orders);
      dexPnlSum += Number(dex.balance.unrealizedPnl) || 0;
    }
    // Add dex unrealizedPnl to main HL balance (equity already includes dex funds, but PnL doesn't)
    if (dexPnlSum !== 0) {
      const hlPnl = Number(hlEntry.balance.unrealizedPnl) || 0;
      hlEntry.balance = { ...hlEntry.balance, unrealizedPnl: String(hlPnl + dexPnlSum) };
    }
    if (dexEntries.length > 0) {
      (hlEntry as Record<string, unknown>).dexBalances = dexBalances;
    }
    exchangeData = exchangeData.filter(e => !e.name.startsWith("hl:") || e.name === "hyperliquid");
  }

  const totals = {
    equity: 0,
    available: 0,
    marginUsed: 0,
    unrealizedPnl: 0,
    positionCount: 0,
    orderCount: 0,
  };

  for (const ex of exchangeData) {
    totals.equity += Number(ex.balance.equity) || 0;
    totals.available += Number(ex.balance.available) || 0;
    totals.marginUsed += Number(ex.balance.marginUsed) || 0;
    totals.unrealizedPnl += Number(ex.balance.unrealizedPnl) || 0;
    totals.positionCount += ex.positions.length;
    totals.orderCount += ex.orders.length;
  }

  return { timestamp: new Date().toISOString(), exchanges: exchangeData, totals, arb: cachedArb };
}

/**
 * Broadcast a message to all connected WebSocket clients.
 */
function broadcast(wss: WebSocketServer, data: unknown) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

/**
 * Start the dashboard HTTP + WebSocket server.
 */
export async function startDashboard(
  exchanges: DashboardExchange[],
  opts: DashboardOpts = {},
): Promise<{ port: number; close: () => void }> {
  const arbInterval = opts.arbInterval ?? 30000;
  const requestedPort = opts.port ?? 3456;
  const port = await findPort(requestedPort);

  const html = getUI();
  let feedMgr: WsFeedManager | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } else if (req.url === "/api/snapshot") {
      pollSnapshot(exchanges, feedMgr).then((snap) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snap));
      }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  const wss = new WebSocketServer({ server });
  const hasClients = () => wss.clients.size > 0;

  // ── WS Feed Manager: real-time account data via exchange WS APIs ──
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  const BROADCAST_DEBOUNCE_MS = 1000;

  feedMgr = new WsFeedManager(exchanges, {
    onUpdate: (_exchange, _state) => {
      // Debounce broadcasts: WS feeds fire rapidly, limit to 1/sec
      if (broadcastTimer || !hasClients()) return;
      broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        if (!hasClients()) return;
        const snap = buildSnapshotFromFeeds(feedMgr!, exchanges);
        broadcast(wss, { type: "snapshot", data: snap });
      }, BROADCAST_DEBOUNCE_MS);
    },
    signal: opts.signal,
  });

  // Send initial snapshot on connect
  wss.on("connection", async (ws) => {
    try {
      const snap = await pollSnapshot(exchanges, feedMgr);
      ws.send(JSON.stringify({ type: "snapshot", data: snap }));
    } catch {
      // ignore
    }
  });

  // Arb + market data: stays on REST polling (cross-exchange aggregation, no single WS covers it)
  let arbTimer: ReturnType<typeof setInterval> | null = null;

  const startArbPolling = () => {
    const pollArbAndMarkets = async () => {
      try {
        const [arbResult] = await Promise.allSettled([
          pollArbData(),
          pollMarkets(exchanges),
        ]);
        if (arbResult.status === "fulfilled") {
          cachedArb = arbResult.value;
        }
        if (hasClients()) {
          broadcast(wss, { type: "arb", data: cachedArb });
        }
      } catch {
        // ignore
      }
    };
    pollArbAndMarkets(); // initial fetch
    arbTimer = setInterval(pollArbAndMarkets, arbInterval);
  };

  // Handle abort signal
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      if (broadcastTimer) clearTimeout(broadcastTimer);
      if (arbTimer) clearInterval(arbTimer);
      feedMgr?.close();
      wss.close();
      server.close();
    }, { once: true });
  }

  return new Promise((resolve) => {
    server.listen(port, async () => {
      // Start WS feeds (connects to exchange WS APIs)
      await feedMgr!.start();
      // Start arb REST polling (30s cycle)
      startArbPolling();
      resolve({
        port,
        close: () => {
          if (broadcastTimer) clearTimeout(broadcastTimer);
          if (arbTimer) clearInterval(arbTimer);
          feedMgr?.close();
          wss.close();
          server.close();
        },
      });
    });
  });
}
