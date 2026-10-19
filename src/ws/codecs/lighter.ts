/**
 * Lighter / Lighter RH codec (§6.1). All markets = `market_stats/all`: the first frame
 * (`subscribed/market_stats`) has every market, then `update/market_stats` ~1 s with ONLY the
 * changed markets (each entry complete) → merged per market.
 *
 * Units (Phase 0, the key correction): WS `funding_rate` (last settled) and `current_funding_rate`
 * (predicted) are PERCENT per 1 h → converted to a fraction by an exact 2-place decimal shift,
 * rateIntervalHours = settlementIntervalHours = 1. `open_interest` is USD notional (not base), one
 * side: WS open_interest / mark = REST orderBookDetails `open_interest` (base); the venue's
 * exchangeMetrics open_interest (both sides) is ≈ 2× (live 2026-10-19, BTC: WS 174.88 M USD / mark
 * 82,387 = 2,122.7 BTC = REST; exchangeMetrics 336.6 M USD).
 * Errors arrive as {error:{code,message}} with no channel field (matched by the channel name in
 * the message). Spot markets (market_type "spot" in /api/v1/orderBooks) are not perps and skipped.
 *
 * Docs: apidocs.lighter.xyz/docs/websocket-reference; fixtures src/__tests__/fixtures/ws/lighter{,-rh}/.
 */

import { mulDecimalInt, shiftDecimal } from "../dec.js";
import { badShape, fetchJson } from "../directory.js";
import { VENUE_STATIC } from "../venue-static.js";
import { isLighterMarketLive } from "../lighter-market.js";
import type {
  DecodedEvent, Dec, FillRow, MarketDirectoryEntry, MarketPatch, OrderRow, PositionRow, UserDelta, VenueCodec, WireSub,
} from "../types.js";
import {
  badFieldsError, capabilities, compact, dec, idOf, isObj, level, nextHour, parseFrame, protocolError, readDec, ts, unrecognised, venueError, type Obj,
} from "./common.js";

const ALL = "market_stats/all";

interface LighterData {
  /** Every perp id → symbol (inactive ones too, so account rows on them keep their name). */
  idToSymbol: Map<string, string>;
  /** Market ids not streamed as markets: spot, and perps that are not live (isLighterMarketLive). */
  nonPerp: Set<string>;
  symbolToId: Map<string, string>;
}

/** Auth token lifetime requested for account_all_orders (the CLI REST path uses 1 h). */
const ORDERS_TOKEN_TTL_SEC = 3600;
const OPEN_ORDER = new Set(["open", "pending", "in-progress"]);
const ZERO = /^-?0*(\.0*)?$/;

/** best bid/ask: Lighter sends "" when that side of the book is empty (live, 2026-10-13) → null. */
function bookSide(o: Obj, key: string, bad: string[]): Dec | null | undefined {
  return o[key] === "" ? null : readDec(o, key, bad);
}

/**
 * last_trade_price: a market with no trade yet is sent as "0" / "0.00" (live 2026-10-19: GME, BE,
 * USDHKD — empty book, zero OI) — no last price, so null (unknown = null, never "0").
 */
function lastTrade(o: Obj, bad: string[]): Dec | null | undefined {
  const v = readDec(o, "last_trade_price", bad);
  return v !== undefined && v !== null && ZERO.test(v) ? null : v;
}

function percentToFraction(o: Obj, key: string, bad: string[]): Dec | null | undefined {
  const v = readDec(o, key, bad);
  if (v === undefined || v === null) return v;
  const f = shiftDecimal(v, -2);
  if (f === undefined) { bad.push(key); return undefined; }
  return f;
}

function makeLighter(venue: "lighter" | "lighter-rh", quote: string): VenueCodec {
  const S = VENUE_STATIC[venue];
  return {
    venue,
    capabilities: capabilities({
      testnet: S.wsUrl.testnet !== null,
      user: true,
      fields: {
        mark: true, index: true, bestBid: true, bestAsk: true, last: true, predictedRate: true,
        nextFundingTime: true, fundingInterval: true, openInterest: true, volume24hNotional: true,
      },
      notes: {
        rate: "WS funding is PERCENT per 1 h on the wire; emitted as a fraction per 1 h",
        nextFundingTime: "Hourly settlement rule (venue-definition)",
        openInterest: "USD notional, ONE side (= REST orderBookDetails open_interest, base, × mark; the venue's own exchangeMetrics kind=open_interest is ≈ 2× — both sides). Not stated in the API docs; live-verified 2026-10-19",
        user: "By accountIndex. user_stats / account_all_positions / account_all_trades need no auth; account_all_orders needs CredentialProvider.authToken (re-called at 80 % TTL). account_all_trades does not replay → gap refetch-required for fills after a reconnect",
        clientId: "orders: client_order_id; fills: ask_/bid_client_id_str of our side; 0 = no client id → null",
        liquidationPrice: "liquidation_price; \"0\" (no liquidation price, e.g. well-covered cross margin) → null, as in the CLI REST path",
        fee: "taker_fee / maker_fee are a rate in 1e-6 of usd_amount (omitted when 0): fee = usd_amount × rate × 1e-6 in the collateral token",
        bbo: "ticker/{market_id}; `nonce` orders frames (non-contiguous)",
        ...(S.wsUrl.testnet === null ? { "network:testnet": "Testnet WS answers HTTP 403 (CloudFront)" } : {}),
      },
    }),
    url: (n) => S.wsUrl[n],
    restUrl: (n) => S.restUrl[n],
    secretKeys: ["auth"],
    secretUrlPatterns: [],
    ping: S.ping,
    limits: S.limits,
    closesOnBadSubscribe: false,
    staleAfterMs: S.staleAfterMs,
    openInterest: { unit: "usd", sides: "one" },
    refresh: null,

    async loadDirectory(ctx) {
      const raw = await fetchJson(ctx.fetch, venue, `${ctx.restUrl}/api/v1/orderBooks`);
      if (!isObj(raw) || !Array.isArray(raw.order_books)) throw badShape(venue, "GET /api/v1/orderBooks has no order_books array");
      const entries: MarketDirectoryEntry[] = [];
      const idToSymbol = new Map<string, string>();
      const nonPerp = new Set<string>();
      for (const m of raw.order_books) {
        if (!isObj(m) || typeof m.symbol !== "string" || typeof m.market_id !== "number") {
          throw badShape(venue, "orderBooks entry without symbol/market_id");
        }
        const id = String(m.market_id);
        if (m.market_type !== "perp") { nonPerp.add(id); continue; }
        idToSymbol.set(id, m.symbol);
        // Inactive / frozen perps are not live markets (the CLI's market list applies the same rule).
        if (!isLighterMarketLive(m)) { nonPerp.add(id); continue; }
        entries.push({
          venue, dex: null, symbol: m.symbol, venueSymbol: m.symbol, base: m.symbol, quote,
          canonical: ctx.canonicalize(venue, { venueSymbol: m.symbol, dex: null, base: m.symbol, quote }),
          rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/api/v1/orderBooks",
        });
      }
      const symbolToId = new Map(Array.from(idToSymbol, ([id, sym]) => [sym, id] as [string, string]));
      return { entries, data: { idToSymbol, nonPerp, symbolToId } satisfies LighterData };
    },

    fundingMeta: () => ({
      rateKind: "lastSettled", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
      intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
    }),

    wiresFor(target, dir, staleOverrideMs): WireSub[] {
      const all: WireSub = { key: ALL, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: { channel: ALL } };
      if (target.kind === "allMarkets") return [all];
      const out: WireSub[] = [];
      if (target.channels.includes("market")) out.push(all);
      if (target.channels.includes("bbo")) {
        const id = (dir.data as LighterData).symbolToId.get(target.symbol) as string; // symbol validated by the stream
        out.push({ key: `ticker/${id}`, staleAfterMs: null, params: { channel: `ticker/${id}` } });
      }
      return out;
    },
    user: {
      inPageSecrets: false,
      wires(ref, channels) {
        if (ref.venue !== venue) return [];
        const a = ref.accountIndex;
        const w = (ch: string, extra: Partial<WireSub> = {}): WireSub => ({ key: `${ch}/${a}`, staleAfterMs: null, params: { channel: `${ch}/${a}` }, ...extra });
        const out: WireSub[] = [];
        if (channels.includes("account")) out.push(w("user_stats"));
        if (channels.includes("positions")) out.push(w("account_all_positions"));
        if (channels.includes("orders")) out.push(w("account_all_orders", { auth: { purpose: `${venue}:account_all_orders`, maxTtlSec: ORDERS_TOKEN_TTL_SEC } }));
        if (channels.includes("fills")) out.push(w("account_all_trades", { gaps: { onReconnect: ["fills"] } }));
        return out;
      },
    },
    encodeSubscribe: (w, _reqId, auth) => JSON.stringify({ type: "subscribe", channel: w.params.channel, ...(auth === null ? {} : { auth }) }),
    encodeUnsubscribe: (w) => JSON.stringify({ type: "unsubscribe", channel: w.params.channel }),

    decode(text, dir, recvTs): DecodedEvent[] {
      const p = parseFrame(text);
      if (!p.ok) return [p.ev];
      const f = p.v;
      if (!isObj(f)) return [unrecognised(venue)];
      if (isObj(f.error)) return [decodeError(venue, f.error)];
      switch (f.type) {
        case "connected":
          return [{ t: "ignore", what: "connected" }];
        case "pong":
          return [{ t: "pong" }];
        case "unsubscribed":
          return [{ t: "ack", wire: channelToWire(f.channel), reqId: null, unsubscribe: true }];
        case "subscribed/market_stats":
        case "update/market_stats":
          if (f.channel !== "market_stats:all") return [unrecognised(venue)];
          return decodeStats(venue, f, dir.data as LighterData, recvTs);
        default: {
          const ty = typeof f.type === "string" ? /^(subscribed|update)\/(user_stats|account_all_positions|account_all_orders|account_all_trades|ticker)$/.exec(f.type) : null;
          const wire = channelToWire(f.channel);
          if (ty === null || wire === null) return [unrecognised(venue)];
          const snapshot = ty[1] === "subscribed";
          const d = dir.data as LighterData;
          switch (ty[2]) {
            case "user_stats": return decodeUserStats(venue, wire, f, snapshot);
            case "account_all_positions": return decodePositions(venue, wire, f, d, snapshot);
            case "account_all_orders": return decodeOrders(venue, wire, f, d, snapshot);
            case "account_all_trades": return decodeTrades(venue, wire, f, d, snapshot, quote);
            default: return decodeTicker(venue, wire, f, d);
          }
        }
      }
    },
  };
}

/** Frame channel "name:id" → wire key "name/id". */
function channelToWire(ch: unknown): string | null {
  if (typeof ch !== "string") return null;
  const m = /^(market_stats|user_stats|account_all_positions|account_all_orders|account_all_trades|ticker):(\w+)$/.exec(ch);
  return m === null ? null : `${m[1]}/${m[2]}`;
}

function decodeError(venue: string, e: Obj): DecodedEvent {
  const code = typeof e.code === "number" ? e.code : null;
  const message = typeof e.message === "string" ? e.message : JSON.stringify(e);
  // No channel field: match the channel named in the message.
  const m = /(market_stats|user_stats|account_all_positions|account_all_orders|account_all_trades|ticker)[:/](\w+)/.exec(message);
  const wire = m === null ? null : `${m[1]}/${m[2]}`;
  if (code === 20001) {
    return venueError("WS_AUTH_FAILED", `${venue} error 20001: ${message}`, wire, wire !== null,
      "account_all_orders needs a valid auth token from CredentialProvider.authToken (expired, wrong account, or wrong API key)");
  }
  if (code === 30005) return venueError("INVALID_PARAMS", `${venue} error 30005: ${message}`, wire, wire !== null, null);
  return protocolError(`${venue} error ${code === null ? "?" : code}: ${message}`, wire);
}

function decodeStats(venue: string, f: Obj, d: LighterData, recvTs: number): DecodedEvent[] {
  if (!isObj(f.market_stats)) return [protocolError(`${venue} ${ALL} frame without market_stats`, ALL)];
  const venueTs = typeof f.timestamp === "number" ? f.timestamp : null;
  const patches: MarketPatch[] = [];
  const badRows: Array<{ symbol: string; fields: string[] }> = [];
  for (const [id, r] of Object.entries(f.market_stats)) {
    if (d.nonPerp.has(id)) continue; // spot market (not a perp)
    if (!isObj(r)) { badRows.push({ symbol: `#${id}`, fields: ["entry"] }); continue; }
    const known = d.idToSymbol.get(id);
    // Unknown id: emit under the frame's symbol so the stream reports it as "not in the directory".
    const symbol = known !== undefined ? known : typeof r.symbol === "string" ? r.symbol : `#${id}`;
    const bad: string[] = [];
    patches.push(compact({
      symbol,
      venueTs,
      mark: readDec(r, "mark_price", bad),
      index: readDec(r, "index_price", bad),
      bestBid: bookSide(r, "best_bid_price", bad),
      bestAsk: bookSide(r, "best_ask_price", bad),
      last: lastTrade(r, bad),
      rate: percentToFraction(r, "funding_rate", bad),
      predictedRate: percentToFraction(r, "current_funding_rate", bad),
      openInterest: readDec(r, "open_interest", bad),
      volume24hNotional: readDec(r, "daily_quote_token_volume", bad),
      nextFundingTime: nextHour(recvTs), // hourly settlement (venue-definition)
    }) as MarketPatch);
    if (bad.length > 0) badRows.push({ symbol, fields: bad });
  }
  const out: DecodedEvent[] = [{ t: "market", wire: ALL, patches }];
  if (badRows.length > 0) out.push(badFieldsError(venue, ALL, badRows));
  return out;
}

export const lighter: VenueCodec = makeLighter("lighter", "USDC");
/** Lighter RH: separate directory (different market ids); USDG collateral. */
export const lighterRh: VenueCodec = makeLighter("lighter-rh", "USDG");


function accountOf(wire: string): string {
  return wire.slice(wire.indexOf("/") + 1);
}

/** Liquidation price: the venue sends "0" (or ≤ 0) when the position has none → null (src/exchanges/lighter.ts positions). */
function positivePrice(v: Dec | null): Dec | null {
  return v !== null && Number(v) > 0 ? v : null;
}

/**
 * Client order index (string form preferred). Valid ids are 1 … 2^48 − 1 (the CLI refuses 0 and its
 * order-event matcher treats 0 as "no client id": src/exchanges/lighter.ts lighterClientOrderIndex /
 * lighterEventOutcome) → 0 = none → null.
 */
function clientIdOf(str: unknown, num: unknown): string | null {
  const id = idOf(str) === null ? idOf(num) : idOf(str);
  return id === null || /^0+$/.test(id) ? null : id;
}

function decodeUserStats(venue: string, wire: string, f: Obj, snapshot: boolean): DecodedEvent[] {
  if (!isObj(f.stats)) return [protocolError(`${venue} ${wire} frame without stats`, wire)];
  const bad: string[] = [];
  const out: DecodedEvent[] = [{
    t: "user", wire,
    deltas: [{
      kind: "account", snapshot, dex: null, venueTs: ts(f, "timestamp", bad),
      equity: dec(f.stats, "portfolio_value", bad), available: dec(f.stats, "available_balance", bad),
      marginUsed: null, // margin_usage is a ratio, not an amount
      unrealizedPnl: null,
    }],
  }];
  if (bad.length > 0) out.push(badFieldsError(venue, wire, [{ symbol: "account", fields: bad }]));
  return out;
}

function decodePositions(venue: string, wire: string, f: Obj, d: LighterData, snapshot: boolean): DecodedEvent[] {
  if (!isObj(f.positions)) return [protocolError(`${venue} ${wire} frame without positions`, wire)];
  const bad: string[] = [];
  const rows: PositionRow[] = [];
  const remove: string[] = [];
  const venueTs = ts(f, "transaction_time", bad, 1e-3); // µs
  for (const [id, p] of Object.entries(f.positions)) {
    if (!isObj(p)) { bad.push(`#${id}`); continue; }
    const known = d.idToSymbol.get(id);
    const symbol = known !== undefined ? known : typeof p.symbol === "string" ? p.symbol : `#${id}`;
    const size = dec(p, "position", bad);
    if (size === null || ZERO.test(size)) { remove.push(symbol); continue; } // flat (the venue lists every market touched)
    rows.push({
      symbol, dex: null, side: p.sign === 1 ? "long" : p.sign === -1 ? "short" : null, size: size.replace(/^-/, ""),
      entryPrice: dec(p, "avg_entry_price", bad), markPrice: null, positionValue: dec(p, "position_value", bad),
      unrealizedPnl: dec(p, "unrealized_pnl", bad), liquidationPrice: positivePrice(dec(p, "liquidation_price", bad)),
      marginUsed: dec(p, "allocated_margin", bad), leverage: null, venueTs,
    });
  }
  const out: DecodedEvent[] = [{ t: "user", wire, deltas: [{ kind: "positions", snapshot, scope: "", rows, remove: snapshot ? [] : remove }] }];
  if (bad.length > 0) out.push(badFieldsError(venue, wire, [{ symbol: "positions", fields: bad }]));
  return out;
}

function decodeOrders(venue: string, wire: string, f: Obj, d: LighterData, snapshot: boolean): DecodedEvent[] {
  if (!isObj(f.orders)) return [protocolError(`${venue} ${wire} frame without orders`, wire)];
  const bad: string[] = [];
  const rows: OrderRow[] = [];
  const remove: string[] = [];
  for (const [mkt, list] of Object.entries(f.orders)) {
    if (!Array.isArray(list)) { bad.push(`orders[${mkt}]`); continue; }
    for (const o of list) {
      const id = isObj(o) ? (idOf(o.order_id) === null ? idOf(o.order_index) : idOf(o.order_id)) : null;
      if (!isObj(o) || id === null) { bad.push("order_id"); continue; }
      if (!OPEN_ORDER.has(String(o.status))) { remove.push(id); continue; }
      const known = d.idToSymbol.get(String(o.market_index));
      rows.push({
        orderId: id, clientId: clientIdOf(o.client_order_id, o.client_order_index), symbol: known !== undefined ? known : `#${String(o.market_index)}`, dex: null,
        side: typeof o.is_ask === "boolean" ? (o.is_ask ? "sell" : "buy") : null,
        type: typeof o.type === "string" ? o.type : null, status: typeof o.status === "string" ? o.status : null,
        price: dec(o, "price", bad), size: dec(o, "initial_base_amount", bad), filled: dec(o, "filled_base_amount", bad),
        remaining: dec(o, "remaining_base_amount", bad), reduceOnly: typeof o.reduce_only === "boolean" ? o.reduce_only : null,
        createdAt: ts(o, "created_at", bad), updatedAt: ts(o, "updated_at", bad),
      });
    }
  }
  const out: DecodedEvent[] = [{ t: "user", wire, deltas: [{ kind: "orders", snapshot, scope: "", rows, remove: snapshot ? [] : remove }] }];
  if (bad.length > 0) out.push(badFieldsError(venue, wire, [{ symbol: "orders", fields: bad }]));
  return out;
}

/**
 * Fee: Trade.taker_fee / maker_fee are integers "omitted if zero" (websocket reference). Unit: a RATE in
 * 1e-6 of usd_amount — the CLI's trade history reads them the same way (src/exchanges/lighter.ts
 * getTradeHistory; live rows: a liquidation carries 10000 = 1 %, the orderBooks liquidation_fee of
 * 1.0000 %). fee = usd_amount × rate × 1e-6, in the collateral token; a missing rate field = 0 (documented
 * omitempty); a missing usd_amount → null.
 */
function feeOf(t: Obj, maker: boolean | null, bad: string[]): Dec | null {
  if (maker === null) return null;
  const rate = maker ? t.maker_fee : t.taker_fee;
  if (rate !== undefined && (typeof rate !== "number" || !Number.isInteger(rate))) { bad.push(maker ? "maker_fee" : "taker_fee"); return null; }
  const usd = dec(t, "usd_amount", bad);
  if (usd === null) return null;
  const fee = mulDecimalInt(usd, rate === undefined ? 0 : rate, -6);
  if (fee === undefined) { bad.push("usd_amount"); return null; }
  return fee;
}

function decodeTrades(venue: string, wire: string, f: Obj, d: LighterData, snapshot: boolean, quote: string): DecodedEvent[] {
  // The `subscribed/` snapshot carries `trades: {}` or `[]` (Phase 0: no replay of recent fills).
  const groups: unknown[] = Array.isArray(f.trades) ? [f.trades] : isObj(f.trades) ? Object.values(f.trades) : [];
  if (!Array.isArray(f.trades) && !isObj(f.trades)) return [protocolError(`${venue} ${wire} frame without trades`, wire)];
  const acct = accountOf(wire);
  const bad: string[] = [];
  const fills: FillRow[] = [];
  for (const g of groups) {
    if (!Array.isArray(g)) { bad.push("trades[]"); continue; }
    for (const t of g) {
      const id = isObj(t) ? (idOf(t.trade_id_str) === null ? idOf(t.trade_id) : idOf(t.trade_id_str)) : null;
      if (!isObj(t) || id === null) { bad.push("trade_id"); continue; }
      const isAsk = String(t.ask_account_id) === acct;
      const isBid = String(t.bid_account_id) === acct;
      const known = d.idToSymbol.get(String(t.market_id));
      const base = {
        fillId: id, symbol: known !== undefined ? known : `#${String(t.market_id)}`, dex: null,
        price: dec(t, "price", bad), size: dec(t, "size", bad), closedPnl: null, time: ts(t, "timestamp", bad),
      };
      const leg = (ask: boolean): FillRow => {
        const maker = typeof t.is_maker_ask === "boolean" ? t.is_maker_ask === ask : null;
        const fee = feeOf(t, maker, bad);
        return {
          ...base, side: ask ? "sell" : "buy",
          orderId: ask ? (idOf(t.ask_id_str) === null ? idOf(t.ask_id) : idOf(t.ask_id_str)) : (idOf(t.bid_id_str) === null ? idOf(t.bid_id) : idOf(t.bid_id_str)),
          clientId: ask ? clientIdOf(t.ask_client_id_str, t.ask_client_id) : clientIdOf(t.bid_client_id_str, t.bid_client_id),
          liquidity: maker === null ? null : maker ? "maker" : "taker",
          fee, feeToken: fee === null ? null : quote,
        };
      };
      // A self-trade has our account on both sides: two fills sharing the trade id (deduped by id + side).
      if (isAsk) fills.push(leg(true));
      if (isBid) fills.push(leg(false));
      if (!isAsk && !isBid) fills.push({ ...base, side: null, orderId: null, clientId: null, liquidity: null, fee: null, feeToken: null });
    }
  }
  const out: DecodedEvent[] = [{ t: "user", wire, deltas: [{ kind: "fills", snapshot, fills } satisfies UserDelta] }];
  if (bad.length > 0) out.push(badFieldsError(venue, wire, [{ symbol: "fills", fields: bad }]));
  return out;
}

function decodeTicker(venue: string, wire: string, f: Obj, d: LighterData): DecodedEvent[] {
  if (!isObj(f.ticker)) return [protocolError(`${venue} ${wire} frame without ticker`, wire)];
  const id = accountOf(wire);
  const known = d.idToSymbol.get(id);
  const bad: string[] = [];
  const [ask, askSize] = level(f.ticker.a, bad, "a");
  const [bid, bidSize] = level(f.ticker.b, bad, "b");
  const out: DecodedEvent[] = [{
    t: "bbo", wire, symbol: known !== undefined ? known : `#${id}`, seq: typeof f.nonce === "number" ? f.nonce : null,
    bid, bidSize, ask, askSize, venueTs: ts(f, "timestamp", bad),
  }];
  if (bad.length > 0) out.push(badFieldsError(venue, wire, [{ symbol: known !== undefined ? known : id, fields: bad }]));
  return out;
}
