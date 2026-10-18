/**
 * Live Dashboard Server — HTTP + WebSocket for real-time portfolio monitoring.
 *
 * Polls all configured exchange adapters and pushes updates to connected clients.
 * Includes cross-exchange arb data: funding rate comparison + dex arb scan.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { ExchangeAdapter, ExchangeOrder, ExchangeMarketInfo } from "../exchanges/index.js";
import { getUI } from "./ui.js";
import { WsFeedManager, isFeedStale, type DashboardBalance, type DashboardPosition } from "./ws-feeds.js";

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

/**
 * JSON shape served on /api/snapshot and pushed over the WS ("snapshot" messages).
 *
 * A venue part that could not be read is null — never a $0 balance / empty list:
 *   exchanges[].balance / positions / orders: null = unavailable, the reason is in `error`.
 *   exchanges[].balance.unrealizedPnl, positions[].entryPrice / markPrice / unrealizedPnl: null = unknown.
 *   exchanges[].feed: live-feed health (WS manager only) — stale = no fresh data (see isFeedStale).
 *   totals cover only the known values; totals.partial = some venue part was left out,
 *   totals.unavailable lists which ("<venue>.<part>").
 */
export interface DashboardExchangeData {
  name: string;
  balance: DashboardBalance | null;
  positions: DashboardPosition[] | null;
  orders: ExchangeOrder[] | null;
  topMarkets: ExchangeMarketInfo[];
  /** Why topMarkets could not be refreshed (the list shown is the last good read); null = fresh. */
  marketsError: string | null;
  /** Why a part is null / the feed is stale; null = everything read. */
  error: string | null;
  feed?: { mode: "ws" | "rest" | "connecting"; lastOkAt: number | null; lastError: string | null; stale: boolean };
  dexBalances?: { name: string; balance: DashboardBalance | null }[];
}

export interface DashboardSnapshot {
  timestamp: string;
  exchanges: DashboardExchangeData[];
  totals: {
    equity: number;
    available: number;
    marginUsed: number;
    unrealizedPnl: number;
    positionCount: number;
    orderCount: number;
    /** true = some venue part (or a stale feed) is not reflected in these sums. */
    partial: boolean;
    /** "<venue>.<part>" left out of the sums (balance, unrealizedPnl, positions, orders, stale). */
    unavailable: string[];
  };
  arb: {
    opportunities: ArbOpportunity[];
    dexArb: DexArbOpportunity[];
    dexAssets: DexAssetRow[];
    dexNames: string[];
    exchangeStatus: Record<string, string>;
    /** Error message per venue (or "funding" when the whole fetch failed). */
    exchangeErrors: Record<string, string>;
  };
}

export interface DashboardOpts {
  port?: number;
  pollInterval?: number; // ms, default 5000
  arbInterval?: number;  // ms, default 30000 (arb data is heavier, poll less often)
  signal?: AbortSignal;
}

// Cached arb data (polled less frequently)
let cachedArb: DashboardSnapshot["arb"] = { opportunities: [], dexArb: [], dexAssets: [], dexNames: [], exchangeStatus: {}, exchangeErrors: {} };
// Cached market data (polled with arb cycle — market metadata rarely changes)
const cachedMarkets = new Map<string, ExchangeMarketInfo[]>();
/** venue → why its last markets refresh failed (cleared on the next good read). */
const marketsErrors = new Map<string, string>();

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
  let exchangeErrors: Record<string, string> = {};

  try {
    const { fetchAllFundingRates } = await import("../funding/rates.js");
    const snapshot = await fetchAllFundingRates({ minSpread: 5 });
    exchangeStatus = snapshot.exchangeStatus;
    exchangeErrors = snapshot.exchangeErrors;

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
  } catch (e) {
    exchangeStatus = { funding: "error" };
    exchangeErrors = { funding: e instanceof Error ? e.message : String(e) };
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
          // Venue ref: "hyperliquid" for native, "hl:<dex>" for HIP-3 (same basis)
          const ann = annualizeRate(a.fundingRate, a.dex === "hl" ? "hyperliquid" : `hl:${a.dex}`);
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
  } catch (e) {
    // Reported next to the funding errors — an empty dex table is never shown as "no opportunities".
    exchangeStatus = { ...exchangeStatus, dexArb: "error" };
    exchangeErrors = { ...exchangeErrors, dexArb: e instanceof Error ? e.message : String(e) };
  }

  const dexNames = [...dexNamesSet].sort();
  return { opportunities, dexArb, dexAssets: dexAssets.slice(0, 30), dexNames, exchangeStatus, exchangeErrors };
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
        marketsErrors.delete(ex.name);
      } catch (e) {
        // The last good list stays on screen, flagged by marketsError (never shown as fresh).
        const msg = e instanceof Error ? e.message : String(e);
        if (!marketsErrors.has(ex.name)) process.stderr.write(`[warn] dashboard ${ex.name} markets refresh failed: ${msg}\n`);
        marketsErrors.set(ex.name, msg);
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
    if (!state) {
      exchangeData.push({ name: ex.name, balance: null, positions: null, orders: null, topMarkets: cachedMarkets.get(ex.name) ?? [], marketsError: marketsErrors.get(ex.name) ?? null, error: "no feed" });
      continue;
    }
    const stale = isFeedStale(state);
    exchangeData.push({
      name: ex.name,
      // Not read yet = null (unavailable), never a $0 / empty placeholder.
      balance: state.balance,
      positions: state.positions ? [...state.positions] : null,  // copy — mergeAndTotal mutates
      orders: state.orders ? [...state.orders] : null,
      topMarkets: cachedMarkets.get(ex.name) ?? [], marketsError: marketsErrors.get(ex.name) ?? null,
      error: state.lastError ?? (state.lastOkAt === null ? "no data received yet" : null),
      feed: { mode: state.mode, lastOkAt: state.lastOkAt, lastError: state.lastError, stale },
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

  return mergeAndTotal(await readExchangesRest(exchanges));
}

/**
 * REST read of every venue. A failed read is null + its reason in `error` — never a $0
 * balance or an empty position / order list (those would read as "flat, no money").
 */
export async function readExchangesRest(exchanges: DashboardExchange[]): Promise<DashboardExchangeData[]> {
  const { withCache, TTL_ACCOUNT } = await import("../cache.js");
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return Promise.all(
    exchanges.map(async (ex) => {
      const [balance, positions, orders] = await Promise.allSettled([
        withCache(`dash:${ex.name}:balance`, TTL_ACCOUNT, () => ex.adapter.getBalance()),
        withCache(`dash:${ex.name}:positions`, TTL_ACCOUNT, () => ex.adapter.getPositions()),
        withCache(`dash:${ex.name}:orders`, TTL_ACCOUNT, () => ex.adapter.getOpenOrders()),
      ]);
      const errs: string[] = [];
      if (balance.status === "rejected") errs.push(`balance: ${errText(balance.reason)}`);
      if (positions.status === "rejected") errs.push(`positions: ${errText(positions.reason)}`);
      if (orders.status === "rejected") errs.push(`orders: ${errText(orders.reason)}`);
      return {
        name: ex.name,
        balance: balance.status === "fulfilled" ? balance.value : null,
        positions: positions.status === "fulfilled" ? positions.value : null,
        orders: orders.status === "fulfilled" ? orders.value : null,
        topMarkets: cachedMarkets.get(ex.name) ?? [], marketsError: marketsErrors.get(ex.name) ?? null,
        error: errs.length > 0 ? errs.join("; ") : null,
      };
    }),
  );
}

/** Merge HL dex entries + compute totals. Unknown (null) parts are skipped and listed in totals.unavailable. */
export function mergeAndTotal(exchangeData: DashboardExchangeData[]): DashboardSnapshot {
  const unavailable: string[] = [];
  for (const ex of exchangeData) {
    if (ex.balance === null) unavailable.push(`${ex.name}.balance`);
    else if (ex.balance.unrealizedPnl === null) unavailable.push(`${ex.name}.unrealizedPnl`);
    if (ex.positions === null) unavailable.push(`${ex.name}.positions`);
    if (ex.orders === null) unavailable.push(`${ex.name}.orders`);
    if (ex.feed?.stale) unavailable.push(`${ex.name}.stale`);
  }

  // Merge hl:* dex entries into main hyperliquid (same wallet, dex pools are subsets of main balance)
  const hlEntry = exchangeData.find(e => e.name === "hyperliquid");
  if (hlEntry) {
    const dexEntries = exchangeData.filter(e => e.name.startsWith("hl:") && e.name !== "hyperliquid");
    // Main accountValue already includes dex pool funds — DON'T add dex balances (would double-count).
    // Only merge positions/orders, and attach dex breakdown for UI display.
    const dexBalances: { name: string; balance: DashboardBalance | null }[] = [];
    let dexPnlSum = 0;
    let dexPnlUnknown = false;
    for (const dex of dexEntries) {
      const dexName = dex.name.replace("hl:", "");
      dexBalances.push({ name: dexName, balance: dex.balance ? { ...dex.balance } : null });
      // An unread dex list is not merged; it is listed in totals.unavailable and in hlEntry.error below.
      if (hlEntry.positions && dex.positions) hlEntry.positions.push(...dex.positions);
      if (hlEntry.orders && dex.orders) hlEntry.orders.push(...dex.orders);
      if (dex.balance?.unrealizedPnl == null) dexPnlUnknown = true;
      else dexPnlSum += Number(dex.balance.unrealizedPnl);
      if (dex.error) hlEntry.error = hlEntry.error ? `${hlEntry.error}; ${dex.name}: ${dex.error}` : `${dex.name}: ${dex.error}`;
    }
    // Add dex unrealizedPnl to main HL balance (equity already includes dex funds, but PnL doesn't)
    if (hlEntry.balance && hlEntry.balance.unrealizedPnl !== null) {
      hlEntry.balance = {
        ...hlEntry.balance,
        unrealizedPnl: dexPnlUnknown ? null : String(Number(hlEntry.balance.unrealizedPnl) + dexPnlSum),
      };
    }
    if (dexEntries.length > 0) hlEntry.dexBalances = dexBalances;
    exchangeData = exchangeData.filter(e => !e.name.startsWith("hl:") || e.name === "hyperliquid");
  }

  const totals: DashboardSnapshot["totals"] = {
    equity: 0,
    available: 0,
    marginUsed: 0,
    unrealizedPnl: 0,
    positionCount: 0,
    orderCount: 0,
    partial: unavailable.length > 0,
    unavailable,
  };

  for (const ex of exchangeData) {
    if (ex.balance) {
      totals.equity += Number(ex.balance.equity);
      totals.available += Number(ex.balance.available);
      totals.marginUsed += Number(ex.balance.marginUsed);
      if (ex.balance.unrealizedPnl !== null) totals.unrealizedPnl += Number(ex.balance.unrealizedPnl);
    }
    if (ex.positions) totals.positionCount += ex.positions.length;
    if (ex.orders) totals.orderCount += ex.orders.length;
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[warn] dashboard initial snapshot failed: ${msg}\n`);
      ws.send(JSON.stringify({ type: "error", data: { message: `initial snapshot failed: ${msg}` } }));
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
        } else {
          // Keep the last good opportunities on screen but mark them as not refreshed.
          const msg = arbResult.reason instanceof Error ? arbResult.reason.message : String(arbResult.reason);
          process.stderr.write(`[warn] dashboard arb refresh failed: ${msg}\n`);
          cachedArb = { ...cachedArb, exchangeStatus: { ...cachedArb.exchangeStatus, arb: "error" }, exchangeErrors: { ...cachedArb.exchangeErrors, arb: msg } };
        }
        if (hasClients()) {
          broadcast(wss, { type: "arb", data: cachedArb });
        }
      } catch (e) {
        process.stderr.write(`[warn] dashboard arb broadcast failed: ${e instanceof Error ? e.message : String(e)}\n`);
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
    server.listen(port, "127.0.0.1", async () => {
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
