/**
 * Arcus codec (§6.1, C1). All markets = ONE `markets` subscription: a full all-market snapshot
 * (`subscribed`, then `channel_data` every ~5 s and on funding apply). It carries markPrice (no
 * oraclePrices subscription needed), fundingRate = last applied (lastSettled; Phase 0: == REST
 * /v1/fundingRates latest), nextFundingRate = predicted, nextFundingAt in unix SECONDS, openInterest
 * base (one side), volume24hNotional USD (volume24h is base).
 * Errors are {type:"error", message} with no channel/id.
 *
 * Docs: docs.arcus.xyz/api-reference/market-data/markets; fixtures src/__tests__/fixtures/ws/arcus/.
 */

import { badShape, fetchJson } from "../directory.js";
import { isArcusOnlineMarket } from "../arcus-market.js";
import { VENUE_STATIC } from "../venue-static.js";
import type { DecodedEvent, FillRow, MarketDirectoryEntry, MarketPatch, OrderRow, PositionRow, UserDelta, VenueCodec, WireSub } from "../types.js";
import {
  badFieldsError, capabilities, compact, dec, idOf, isObj, level, parseFrame, pick, protocolError, readDec, readTs, ts, unrecognised, type Obj,
} from "./common.js";

const S = VENUE_STATIC.arcus;
const MARKETS = "markets";

interface ArcusData {
  idToSymbol: Map<string, string>;
}

export const arcus: VenueCodec = {
  venue: "arcus",
  capabilities: capabilities({
    testnet: true,
    user: true,
    fields: {
      mark: true, index: true, bestBid: false, bestAsk: false, last: true, predictedRate: true,
      nextFundingTime: true, fundingInterval: true, openInterest: true, volume24hNotional: true,
    },
    notes: {
      bestBid: "Not in `markets`; use the bbo channel (Phase 2)",
      bestAsk: "Not in `markets`; use the bbo channel (Phase 2)",
      openInterest: "Base units, one side (~60 s venue cadence)",
      user: "By address, no auth (subaccount → accountIndex). account re-snapshots every 5 s; userFills replays on resubscribe (deduped by tradeId). Streaming `account` order events carry no balances and are not emitted",
      bbo: "bbo{market}; lastSequenceId orders frames (non-contiguous)",
      clientId: "orders and fills: clientId (omitted by the venue when the order had none → null)",
      liquidationPrice: "not published (WS or REST) → always null",
      fee: "fill `fee`; feeToken not stated → null",
    },
  }),
  url: (n) => S.wsUrl[n],
  restUrl: (n) => S.restUrl[n],
  secretKeys: [],
  secretUrlPatterns: [],
  ping: S.ping,
  limits: S.limits,
  closesOnBadSubscribe: false,
  staleAfterMs: S.staleAfterMs,
  openInterest: { unit: "base", sides: "one" },
  refresh: null,

  async loadDirectory(ctx) {
    const raw = await fetchJson(ctx.fetch, "arcus", `${ctx.restUrl}/v1/markets`);
    if (!isObj(raw) || !Array.isArray(raw.markets)) throw badShape("arcus", "GET /v1/markets has no markets array");
    const entries: MarketDirectoryEntry[] = [];
    const idToSymbol = new Map<string, string>();
    for (const m of raw.markets) {
      if (!isObj(m) || typeof m.marketDisplayName !== "string" || typeof m.marketId !== "number" || typeof m.baseAsset !== "string") {
        throw badShape("arcus", "market without marketDisplayName/marketId/baseAsset");
      }
      // OFFLINE markets stream placeholder zeros (mark / index / rate / OI / volume "0"): not in
      // the directory — the CLI's rule (isArcusOnlineMarket), never 0 for unknown.
      if (!isArcusOnlineMarket(m)) continue;
      const quote = typeof m.quoteAsset === "string" ? m.quoteAsset : null;
      idToSymbol.set(String(m.marketId), m.marketDisplayName);
      entries.push({
        venue: "arcus", dex: null, symbol: m.marketDisplayName, venueSymbol: m.marketDisplayName, base: m.baseAsset, quote,
        canonical: ctx.canonicalize("arcus", { venueSymbol: m.marketDisplayName, dex: null, base: m.baseAsset, quote }),
        rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/v1/markets",
      });
    }
    return { entries, data: { idToSymbol } satisfies ArcusData };
  },

  fundingMeta: () => ({
    rateKind: "lastSettled", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
    intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
  }),

  wiresFor(target, _dir, staleOverrideMs): WireSub[] {
    const markets: WireSub = { key: MARKETS, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: { channel: MARKETS } };
    if (target.kind === "allMarkets") return [markets];
    const out: WireSub[] = [];
    if (target.channels.includes("market")) out.push(markets);
    if (target.channels.includes("bbo")) out.push({ key: `bbo:${target.symbol}`, staleAfterMs: null, params: { channel: "bbo", id: target.symbol } });
    return out;
  },
  user: {
    inPageSecrets: false,
    wires(ref, channels) {
      if (ref.venue !== "arcus") return [];
      const w = (channel: string): WireSub => ({
        key: channel, staleAfterMs: null,
        params: { channel, id: ref.address, ...(ref.subaccount === null ? {} : { accountIndex: ref.subaccount }) },
      });
      const out: WireSub[] = [];
      if (channels.includes("account")) out.push(w("account"));
      if (channels.includes("positions")) out.push(w("positions"));
      if (channels.includes("orders")) out.push(w("orders"));
      if (channels.includes("fills")) out.push(w("userFills"));
      return out;
    },
  },
  encodeSubscribe: (w) => JSON.stringify({ type: "subscribe", ...w.params }),
  encodeUnsubscribe: (w) => JSON.stringify({ type: "unsubscribe", ...w.params }),

  decode(text, dir): DecodedEvent[] {
    const p = parseFrame(text);
    if (!p.ok) return [p.ev];
    const f = p.v;
    if (!isObj(f) || typeof f.type !== "string") return [unrecognised("arcus")];
    switch (f.type) {
      case "connected":
        return [{ t: "ignore", what: "connected" }];
      case "pong":
        return [{ t: "pong" }];
      case "unsubscribed":
        return [{ t: "ack", wire: wireOf(f), reqId: null, unsubscribe: true }];
      case "error":
        return [protocolError(`arcus error: ${typeof f.message === "string" ? f.message : JSON.stringify(f)}`)];
      case "subscribed":
      case "channel_data": {
        const d = dir.data as ArcusData;
        switch (f.channel) {
          case MARKETS: return decodeMarkets(f, d);
          case "bbo": return decodeBbo(f);
          case "account": return decodeAccount(f);
          case "positions": return decodePositions(f, d);
          case "orders": return decodeOrders(f, d);
          case "userFills": return decodeFills(f, d);
          default: return [unrecognised("arcus")];
        }
      }
      default:
        return [unrecognised("arcus")];
    }
  },
};

function decodeMarkets(f: Obj, d: ArcusData): DecodedEvent[] {
  if (!isObj(f.contents) || !isObj(f.contents.markets)) return [protocolError("arcus markets frame without contents.markets", MARKETS)];
  const patches: MarketPatch[] = [];
  const badRows: Array<{ symbol: string; fields: string[] }> = [];
  for (const [id, m] of Object.entries(f.contents.markets)) {
    if (!isObj(m)) { badRows.push({ symbol: `#${id}`, fields: ["entry"] }); continue; }
    const known = d.idToSymbol.get(id);
    // Unknown id: emit under the frame's name so the stream reports it as "not in the directory".
    const symbol = known !== undefined ? known : typeof m.marketDisplayName === "string" ? m.marketDisplayName : `#${id}`;
    const bad: string[] = [];
    patches.push(compact({
      symbol,
      venueTs: null, // `markets` carries no frame timestamp
      mark: readDec(m, "markPrice", bad),
      index: readDec(m, "oraclePrice", bad),
      last: readDec(m, "lastTradePrice", bad),
      rate: readDec(m, "fundingRate", bad),
      predictedRate: readDec(m, "nextFundingRate", bad),
      nextFundingTime: readTs(m, "nextFundingAt", bad, 1000),
      openInterest: readDec(m, "openInterest", bad),
      volume24hNotional: readDec(m, "volume24hNotional", bad),
    }) as MarketPatch);
    if (bad.length > 0) badRows.push({ symbol, fields: bad });
  }
  const out: DecodedEvent[] = [{ t: "market", wire: MARKETS, patches }];
  if (badRows.length > 0) out.push(badFieldsError("arcus", MARKETS, badRows));
  return out;
}

function wireOf(f: Obj): string | null {
  if (f.channel === MARKETS) return MARKETS;
  if (f.channel === "bbo" && typeof f.id === "string") return `bbo:${f.id}`;
  if (f.channel === "account" || f.channel === "positions" || f.channel === "orders" || f.channel === "userFills") return f.channel;
  return null;
}

const SIDE: Record<string, "buy" | "sell"> = { BUY: "buy", SELL: "sell" };
const POS_SIDE: Record<string, "long" | "short"> = { LONG: "long", SHORT: "short" };
/** Statuses that rest on the book (docs: OPEN; TP/SL orders wait as TPSL_PLACED). */
const OPEN_STATUS = new Set(["OPEN", "TPSL_PLACED"]);
const ZERO = /^-?0*(\.0*)?$/;

function symbolOf(o: Obj, d: ArcusData): string | null {
  if (typeof o.marketId === "number") {
    const s = d.idToSymbol.get(String(o.marketId));
    if (s !== undefined) return s;
  }
  if (typeof o.marketDisplayName === "string") return o.marketDisplayName;
  if (typeof o.market === "string") return o.market;
  return null;
}

function decodeBbo(f: Obj): DecodedEvent[] {
  if (typeof f.id !== "string" || !isObj(f.contents)) return [protocolError("arcus bbo frame without id/contents")];
  const wire = `bbo:${f.id}`;
  const c = f.contents;
  const bad: string[] = [];
  const [bid, bidSize] = level(c.bestBid, bad, "bestBid");
  const [ask, askSize] = level(c.bestAsk, bad, "bestAsk");
  const out: DecodedEvent[] = [{
    t: "bbo", wire, symbol: f.id, seq: typeof c.lastSequenceId === "number" ? c.lastSequenceId : null,
    bid, bidSize, ask, askSize, venueTs: ts(c, "timestamp", bad, 1e-3), // µs
  }];
  if (bad.length > 0) out.push(badFieldsError("arcus", wire, [{ symbol: f.id, fields: bad }]));
  return out;
}

function decodeAccount(f: Obj): DecodedEvent[] {
  if (!isObj(f.contents)) return [protocolError("arcus account frame without contents", "account")];
  const c = f.contents;
  // Streaming order-centric events (contents.type PLACED/CANCELED/…) carry only netQuoteBalance; the
  // 5 s isSnapshot re-push carries the account state (docs) → only snapshots become account events.
  if (c.isSnapshot !== true) return [{ t: "ignore", what: "account order event" }];
  if (c.noActivity === true) return [{ t: "ack", wire: "account", reqId: null, unsubscribe: false }];
  const bad: string[] = [];
  const out: DecodedEvent[] = [{
    t: "user", wire: "account",
    deltas: [{
      kind: "account", snapshot: true, dex: null, venueTs: null,
      equity: dec(c, "accountEquity", bad), available: dec(c, "freeCollateral", bad), marginUsed: null, unrealizedPnl: null,
    }],
  }];
  if (bad.length > 0) out.push(badFieldsError("arcus", "account", [{ symbol: "account", fields: bad }]));
  return out;
}

/**
 * Position fields (docs.arcus.xyz channels#positions: the snapshot map "has the same shape as positions in
 * REST GET /v1/positions"; that schema lists marketId, marketDisplayName, side, size ("Signed position
 * quantity. Positive for long, negative for short"), averageEntryPrice, cumulativeFunding, marginMode,
 * borrowedCapital, marginUsed, positionValueNotional, unrealizedPnl, markPx, sequenceNumber). No
 * leverage and no liquidation price are published → null. Streaming deltas carry a subset (docs example:
 * side/size/averageEntryPrice); absent fields are null for that row. (The main wallet had no open
 * position during the Phase 0 / Phase 2 live runs, so this mapping is from the docs.)
 */
function positionRow(p: Obj, d: ArcusData, bad: string[]): PositionRow | null {
  const symbol = symbolOf(p, d);
  if (symbol === null) { bad.push("market"); return null; }
  const size = dec(p, "size", bad); // signed (docs: positive long, negative short)
  return {
    symbol, dex: null, side: pick(POS_SIDE, p.side), size: size === null ? null : size.replace(/^-/, ""),
    entryPrice: dec(p, "averageEntryPrice", bad), markPrice: dec(p, "markPx", bad), positionValue: dec(p, "positionValueNotional", bad),
    unrealizedPnl: dec(p, "unrealizedPnl", bad),
    liquidationPrice: null, // Arcus publishes no liquidation price (REST GET /v1/positions has none either)
    marginUsed: dec(p, "marginUsed", bad), leverage: null, venueTs: null,
  };
}

function decodePositions(f: Obj, d: ArcusData): DecodedEvent[] {
  if (!isObj(f.contents)) return [protocolError("arcus positions frame without contents", "positions")];
  const c = f.contents;
  const bad: string[] = [];
  let delta: UserDelta;
  if (c.isSnapshot === true) {
    if (!isObj(c.positions)) return [protocolError("arcus positions snapshot without positions", "positions")];
    const rows = Object.values(c.positions).map(p => (isObj(p) ? positionRow(p, d, bad) : null)).filter((r): r is PositionRow => r !== null);
    delta = { kind: "positions", snapshot: true, scope: "", rows, remove: [] };
  } else {
    // One position per frame; a closed one arrives as FLAT with zeroed financials (docs).
    const row = positionRow(c, d, bad);
    if (row === null) return [badFieldsError("arcus", "positions", [{ symbol: "position", fields: bad }])];
    const flat = c.side === "FLAT" || row.size === null || ZERO.test(row.size);
    delta = { kind: "positions", snapshot: false, scope: "", rows: flat ? [] : [row], remove: flat ? [row.symbol] : [] };
  }
  const out: DecodedEvent[] = [{ t: "user", wire: "positions", deltas: [delta] }];
  if (bad.length > 0) out.push(badFieldsError("arcus", "positions", [{ symbol: "positions", fields: bad }]));
  return out;
}

function orderRow(o: Obj, d: ArcusData, bad: string[]): OrderRow | null {
  const id = idOf(o.orderId);
  const symbol = symbolOf(o, d);
  if (id === null || symbol === null) { bad.push("orderId/market"); return null; }
  const size = dec(o, "originalSize", bad);
  return {
    orderId: id, clientId: idOf(o.clientId), symbol, dex: null, side: pick(SIDE, o.side),
    type: typeof o.type === "string" ? o.type : null, status: typeof o.status === "string" ? o.status : null,
    price: dec(o, "price", bad), size, filled: dec(o, "filledSize", bad), remaining: dec(o, "remainingSize", bad),
    reduceOnly: typeof o.reduceOnly === "boolean" ? o.reduceOnly : null,
    createdAt: ts(o, "createdAt", bad, 1e-3), updatedAt: ts(o, "updatedAt", bad, 1e-3), // µs
  };
}

function decodeOrders(f: Obj, d: ArcusData): DecodedEvent[] {
  if (!isObj(f.contents)) return [protocolError("arcus orders frame without contents", "orders")];
  const c = f.contents;
  const bad: string[] = [];
  let delta: UserDelta;
  if (c.isSnapshot === true) {
    // openOrders only: recentClosedOrders are terminal (docs: never merge them into working orders).
    if (!Array.isArray(c.openOrders)) return [protocolError("arcus orders snapshot without openOrders", "orders")];
    const rows = c.openOrders.map(o => (isObj(o) ? orderRow(o, d, bad) : null)).filter((r): r is OrderRow => r !== null);
    delta = { kind: "orders", snapshot: true, scope: "", rows, remove: [] };
  } else {
    const row = orderRow(c, d, bad);
    if (row === null) return [badFieldsError("arcus", "orders", [{ symbol: "order", fields: bad }])];
    const open = row.status !== null && OPEN_STATUS.has(row.status);
    delta = { kind: "orders", snapshot: false, scope: "", rows: open ? [row] : [], remove: open ? [] : [row.orderId] };
  }
  const out: DecodedEvent[] = [{ t: "user", wire: "orders", deltas: [delta] }];
  if (bad.length > 0) out.push(badFieldsError("arcus", "orders", [{ symbol: "orders", fields: bad }]));
  return out;
}

function fillRow(x: Obj, d: ArcusData, bad: string[]): FillRow | null {
  const id = idOf(x.tradeId);
  const symbol = symbolOf(x, d);
  if (id === null || symbol === null) { bad.push("tradeId/market"); return null; }
  // Snapshot rows use price/size; the documented streaming shape uses fillPrice/fillSize.
  const price = "price" in x ? dec(x, "price", bad) : dec(x, "fillPrice", bad);
  const size = "size" in x ? dec(x, "size", bad) : dec(x, "fillSize", bad);
  return {
    fillId: id, clientId: idOf(x.clientId), symbol, dex: null, side: pick(SIDE, x.side), price, size, fee: dec(x, "fee", bad), feeToken: null,
    closedPnl: dec(x, "closedPnl", bad), orderId: idOf(x.orderId),
    liquidity: x.role === "MAKER" ? "maker" : x.role === "TAKER" ? "taker" : null,
    time: ts(x, "createdAt", bad, 1e-3), // µs
  };
}

function decodeFills(f: Obj, d: ArcusData): DecodedEvent[] {
  if (!isObj(f.contents)) return [protocolError("arcus userFills frame without contents", "userFills")];
  const c = f.contents;
  const bad: string[] = [];
  const list = c.isSnapshot === true ? (Array.isArray(c.fills) ? c.fills : null) : [c];
  if (list === null) return [protocolError("arcus userFills snapshot without fills", "userFills")];
  const fills = list.map(x => (isObj(x) ? fillRow(x, d, bad) : null)).filter((r): r is FillRow => r !== null);
  const out: DecodedEvent[] = [{ t: "user", wire: "userFills", deltas: [{ kind: "fills", snapshot: c.isSnapshot === true, fills }] }];
  if (bad.length > 0) out.push(badFieldsError("arcus", "userFills", [{ symbol: "fills", fields: bad }]));
  return out;
}
