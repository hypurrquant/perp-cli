/**
 * Pacifica codec (§6.1). All markets = `prices` (one subscription, every ~3 s). funding = last
 * settled hourly rate, next_funding = predicted (Phase 0: == REST funding_rate history). open_interest
 * is base units; volume_24h USD. No bid/ask in `prices` (bbo channel, Phase 2).
 * An unknown symbol is acked with no data and no error frame → symbols are validated first.
 * The directory is the `instrument_type: "perpetual"` rows of GET /info (spot rows such as SOL-USDC are
 * also in /info and `prices`). A row without instrument_type cannot be classified: it is left out and
 * reported as a directory warning (non-fatal EXCHANGE_ERROR on each subscription; the other markets stream).
 * Every wire carries `group` = its channel `source` (venue cap: 20 per channel per connection; the stream
 * spreads further ones over more sockets, venue-static.ts).
 *
 * Docs: docs.pacifica.fi/api-documentation/api/websocket; fixtures in
 * src/__tests__/fixtures/ws/pacifica/.
 */

import { badShape, fetchJson } from "../directory.js";
import { isPacificaPerpetual } from "../pacifica-instrument.js";
import { VENUE_STATIC } from "../venue-static.js";
import type { DecodedEvent, FillRow, MarketDirectoryEntry, MarketPatch, OrderRow, PositionRow, VenueCodec, WireSub } from "../types.js";
import {
  badFieldsError, capabilities, compact, dec, idOf, isObj, parseFrame, protocolError, readDec, readTs, ts, unrecognised, pick,
} from "./common.js";

const S = VENUE_STATIC.pacifica;
const PRICES = "prices";

interface PacificaData {
  /** /info symbols that are not perps (spot, any other instrument_type): their `prices` rows are skipped. */
  nonPerp: Set<string>;
}

function sourceKey(d: unknown): string | null {
  if (!isObj(d) || typeof d.source !== "string") return null;
  return typeof d.symbol === "string" ? `${d.source}:${d.symbol}` : d.source;
}

export const pacifica: VenueCodec = {
  venue: "pacifica",
  capabilities: capabilities({
    testnet: true,
    user: true,
    fields: {
      mark: true, index: true, bestBid: false, bestAsk: false, last: false, predictedRate: true,
      nextFundingTime: false, fundingInterval: true, openInterest: true, volume24hNotional: true,
    },
    notes: {
      bestBid: "`prices` has no bid/ask; use the bbo channel (Phase 2)",
      bestAsk: "`prices` has no bid/ask; use the bbo channel (Phase 2)",
      last: "Not in `prices`",
      nextFundingTime: "Not in `prices`",
      openInterest: "Base units",
      user: "By account (Solana address), no auth. account_order_updates / account_trades send no snapshot → gap refetch-required for orders (at subscribe and after a reconnect) and fills (after a reconnect)",
      bbo: "bbo{symbol} ≤ 20 per connection (more are spread over further sockets); `li` orders frames (non-contiguous)",
      positions: "account_positions envelope `li` orders snapshots: an older one than the last applied is dropped",
      clientId: "orders and fills: `I` (client order id; null when the order has none)",
      liquidationPrice: "`l` (null when not applicable, per the venue)",
      fee: "trade `f`; feeToken not stated → null",
    },
  }),
  url: (n) => S.wsUrl[n],
  restUrl: (n) => S.restUrl[n],
  secretKeys: [],
  secretUrlPatterns: [/PF-API-KEY=[^&\s"']+/gi],
  ping: S.ping,
  limits: S.limits,
  closesOnBadSubscribe: false,
  staleAfterMs: S.staleAfterMs,
  openInterest: { unit: "base", sides: null },
  refresh: null,

  async loadDirectory(ctx) {
    const raw = await fetchJson(ctx.fetch, "pacifica", `${ctx.restUrl}/info`);
    if (!isObj(raw) || !Array.isArray(raw.data)) throw badShape("pacifica", "GET /info has no data array");
    const entries: MarketDirectoryEntry[] = [];
    const nonPerp = new Set<string>();
    const unclassified: string[] = [];
    for (const m of raw.data) {
      if (!isObj(m) || typeof m.symbol !== "string") throw badShape("pacifica", "GET /info market without symbol");
      if (typeof m.instrument_type !== "string") { unclassified.push(m.symbol); nonPerp.add(m.symbol); continue; }
      if (!isPacificaPerpetual(m)) { nonPerp.add(m.symbol); continue; }
      const base = m.symbol; // Pacifica perp symbols are the base asset (BTC, kBONK, …)
      const quote = "USDC"; // venue collateral / quote (venue definition)
      entries.push({
        venue: "pacifica", dex: null, symbol: m.symbol, venueSymbol: m.symbol, base, quote,
        canonical: ctx.canonicalize("pacifica", { venueSymbol: m.symbol, dex: null, base, quote }),
        rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/api/v1/info",
      });
    }
    const warnings = unclassified.length === 0 ? [] : [
      `pacifica GET /info: ${unclassified.length} market(s) without instrument_type left out (cannot tell perp from spot): ${unclassified.slice(0, 10).join(", ")}${unclassified.length > 10 ? ", …" : ""}`,
    ];
    return { entries, data: { nonPerp } satisfies PacificaData, warnings };
  },

  fundingMeta: () => ({
    rateKind: "lastSettled", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
    intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
  }),

  wiresFor(target, _dir, staleOverrideMs): WireSub[] {
    const prices: WireSub = { key: PRICES, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, group: PRICES, params: { source: PRICES } };
    if (target.kind === "allMarkets") return [prices];
    const out: WireSub[] = [];
    if (target.channels.includes("market")) out.push(prices);
    if (target.channels.includes("bbo")) out.push({ key: `bbo:${target.symbol}`, staleAfterMs: null, group: "bbo", params: { source: "bbo", symbol: target.symbol } });
    return out;
  },
  user: {
    inPageSecrets: false,
    wires(ref, channels) {
      if (ref.venue !== "pacifica") return [];
      const w = (source: string, gaps?: WireSub["gaps"]): WireSub => ({ key: source, staleAfterMs: null, group: source, params: { source, account: ref.account }, ...(gaps === undefined ? {} : { gaps }) });
      const out: WireSub[] = [];
      if (channels.includes("account")) out.push(w("account_info"));
      if (channels.includes("positions")) out.push(w("account_positions"));
      if (channels.includes("orders")) out.push(w("account_order_updates", { onReconnect: ["orders"], onSubscribe: ["orders"] }));
      if (channels.includes("fills")) out.push(w("account_trades", { onReconnect: ["fills"] }));
      return out;
    },
  },
  encodeSubscribe: (w) => JSON.stringify({ method: "subscribe", params: w.params }),
  encodeUnsubscribe: (w) => JSON.stringify({ method: "unsubscribe", params: w.params }),

  decode(text, dir): DecodedEvent[] {
    const p = parseFrame(text);
    if (!p.ok) return [p.ev];
    const f = p.v;
    if (!isObj(f) || typeof f.channel !== "string") return [unrecognised("pacifica")];
    switch (f.channel) {
      case "pong":
        return [{ t: "pong" }];
      case "subscribe":
      case "unsubscribe":
        return [{ t: "ack", wire: sourceKey(f.data), reqId: null, unsubscribe: f.channel === "unsubscribe" }];
      case "account_info":
        return decodeAccount(f.data);
      case "account_positions":
        return decodePositions(f.data, f.li);
      case "account_order_updates":
        return decodeOrders(f.data);
      case "account_trades":
        return decodeTrades(f.data);
      case "bbo":
        return decodeBbo(f.data);
      case PRICES: {
        if (!Array.isArray(f.data)) return [unrecognised("pacifica")];
        const patches: MarketPatch[] = [];
        const badRows: Array<{ symbol: string; fields: string[] }> = [];
        const out: DecodedEvent[] = [];
        const nonPerp = (dir.data as PacificaData).nonPerp;
        for (const r of f.data) {
          if (!isObj(r) || typeof r.symbol !== "string") { badRows.push({ symbol: "?", fields: ["symbol"] }); continue; }
          if (nonPerp.has(r.symbol)) continue; // spot market (not a perp)
          const bad: string[] = [];
          patches.push(compact({
            symbol: r.symbol,
            venueTs: (() => { const t = readTs(r, "timestamp", bad); return t === undefined ? null : t; })(),
            mark: readDec(r, "mark", bad),
            index: readDec(r, "oracle", bad),
            rate: readDec(r, "funding", bad),
            predictedRate: readDec(r, "next_funding", bad),
            openInterest: readDec(r, "open_interest", bad),
            volume24hNotional: readDec(r, "volume_24h", bad),
          }) as MarketPatch);
          if (bad.length > 0) badRows.push({ symbol: r.symbol, fields: bad });
        }
        if (badRows.length > 0) out.push(badFieldsError("pacifica", PRICES, badRows));
        return [{ t: "market", wire: PRICES, patches }, ...out];
      }
      default:
        return [unrecognised("pacifica")];
    }
  },
};

const BOOK_SIDE: Record<string, "buy" | "sell"> = { bid: "buy", ask: "sell" };
// account_trades `ts`: the trade side relative to the position.
const TRADE_SIDE: Record<string, "buy" | "sell"> = { open_long: "buy", close_short: "buy", open_short: "sell", close_long: "sell" };
const OPEN_STATUSES = new Set(["open", "partially_filled"]);

function decodeAccount(d: unknown): DecodedEvent[] {
  if (!isObj(d)) return [protocolError("pacifica account_info frame without data", "account_info")];
  const bad: string[] = [];
  const out: DecodedEvent[] = [{
    t: "user", wire: "account_info",
    deltas: [{
      kind: "account", snapshot: true, dex: null, venueTs: ts(d, "t", bad), // every frame carries the full account
      equity: dec(d, "ae", bad), available: dec(d, "as", bad), marginUsed: dec(d, "mu", bad),
      unrealizedPnl: null, // not in account_info
    }],
  }];
  if (bad.length > 0) out.push(badFieldsError("pacifica", "account_info", [{ symbol: "account", fields: bad }]));
  return out;
}

function decodePositions(d: unknown, li: unknown): DecodedEvent[] {
  // Every frame is the account's full position set ("closed" = an empty array; docs). The envelope
  // `li` orders the sets (docs: Last ID): the stream drops one older than the last applied.
  if (!Array.isArray(d)) return [protocolError("pacifica account_positions data is not an array", "account_positions")];
  const bad: string[] = [];
  const rows: PositionRow[] = [];
  for (const p of d) {
    if (!isObj(p) || typeof p.s !== "string") { bad.push("position"); continue; }
    const side = pick(BOOK_SIDE, p.d);
    rows.push({
      symbol: p.s, dex: null, side: side === null ? null : side === "buy" ? "long" : "short",
      size: dec(p, "a", bad), entryPrice: dec(p, "p", bad), markPrice: null, positionValue: null, unrealizedPnl: null,
      liquidationPrice: dec(p, "l", bad), marginUsed: dec(p, "m", bad), leverage: null, venueTs: ts(p, "t", bad),
    });
  }
  const out: DecodedEvent[] = [{
    t: "user", wire: "account_positions", seq: typeof li === "number" ? li : null,
    deltas: [{ kind: "positions", snapshot: true, scope: "", rows, remove: [] }],
  }];
  if (bad.length > 0) out.push(badFieldsError("pacifica", "account_positions", [{ symbol: "positions", fields: bad }]));
  return out;
}

function decodeOrders(d: unknown): DecodedEvent[] {
  if (!Array.isArray(d)) return [protocolError("pacifica account_order_updates data is not an array", "account_order_updates")];
  const bad: string[] = [];
  const rows: OrderRow[] = [];
  const remove: string[] = [];
  for (const o of d) {
    const id = isObj(o) ? idOf(o.i) : null;
    if (!isObj(o) || id === null || typeof o.s !== "string") { bad.push("order"); continue; }
    if (!OPEN_STATUSES.has(String(o.os))) { remove.push(id); continue; }
    const size = dec(o, "a", bad);
    const filled = dec(o, "f", bad);
    rows.push({
      orderId: id, clientId: typeof o.I === "string" ? o.I : null, symbol: o.s, dex: null, side: pick(BOOK_SIDE, o.d),
      type: typeof o.ot === "string" ? o.ot : null, status: typeof o.os === "string" ? o.os : null,
      price: dec(o, "ip", bad), size, filled, remaining: null,
      reduceOnly: typeof o.r === "boolean" ? o.r : null, createdAt: ts(o, "ct", bad), updatedAt: ts(o, "ut", bad),
    });
  }
  const out: DecodedEvent[] = [{ t: "user", wire: "account_order_updates", deltas: [{ kind: "orders", snapshot: false, scope: "", rows, remove }] }];
  if (bad.length > 0) out.push(badFieldsError("pacifica", "account_order_updates", [{ symbol: "orders", fields: bad }]));
  return out;
}

function decodeTrades(d: unknown): DecodedEvent[] {
  if (!Array.isArray(d)) return [protocolError("pacifica account_trades data is not an array", "account_trades")];
  const bad: string[] = [];
  const fills: FillRow[] = [];
  for (const t of d) {
    const h = isObj(t) ? idOf(t.h) : null;
    const i = isObj(t) ? idOf(t.i) : null;
    if (!isObj(t) || h === null || typeof t.s !== "string") { bad.push("h/s"); continue; }
    fills.push({
      fillId: i === null ? h : `${h}:${i}`, clientId: typeof t.I === "string" ? t.I : null,
      symbol: t.s, dex: null, side: pick(TRADE_SIDE, t.ts), price: dec(t, "p", bad), size: dec(t, "a", bad),
      fee: dec(t, "f", bad), feeToken: null, closedPnl: dec(t, "n", bad), orderId: i,
      liquidity: t.te === "fulfill_maker" ? "maker" : t.te === "fulfill_taker" ? "taker" : null, time: ts(t, "t", bad),
    });
  }
  const out: DecodedEvent[] = [{ t: "user", wire: "account_trades", deltas: [{ kind: "fills", snapshot: false, fills }] }];
  if (bad.length > 0) out.push(badFieldsError("pacifica", "account_trades", [{ symbol: "fills", fields: bad }]));
  return out;
}

function decodeBbo(d: unknown): DecodedEvent[] {
  if (!isObj(d) || typeof d.s !== "string") return [protocolError("pacifica bbo frame without symbol")];
  const wire = `bbo:${d.s}`;
  const bad: string[] = [];
  const out: DecodedEvent[] = [{
    t: "bbo", wire, symbol: d.s, seq: typeof d.li === "number" ? d.li : null,
    bid: dec(d, "b", bad), bidSize: dec(d, "B", bad), ask: dec(d, "a", bad), askSize: dec(d, "A", bad), venueTs: ts(d, "t", bad),
  }];
  if (bad.length > 0) out.push(badFieldsError("pacifica", wire, [{ symbol: d.s, fields: bad }]));
  return out;
}

