/**
 * Hyperliquid codec (§6.1). All markets = ONE `allDexsAssetCtxs` subscription (every dex), filtered
 * client-side by opts.hip3Dexes. Its ctx arrays are POSITIONAL (no coin): index i = meta{dex}.universe[i]
 * — the directory loads meta per selected dex and every frame is length-checked (mismatch →
 * WS_PROTOCOL_ERROR for that dex, never mis-assigned). kind:"market" uses `activeAssetCtx{coin}`.
 * An unknown coin in a subscribe makes HL drop the socket (no error frame) → coins are validated
 * against the directory before sending (closesOnBadSubscribe).
 *
 * Docs: hyperliquid.gitbook.io …/api/websocket/subscriptions; Phase 0 fixtures in
 * src/__tests__/fixtures/ws/hyperliquid/.
 */

import { badShape, fetchJson } from "../directory.js";
import { WsError } from "../errors.js";
import { sumDecimals } from "../dec.js";
import { VENUE_STATIC } from "../venue-static.js";
import type {
  CodecDirectory, DecodedEvent, FillRow, MarketDirectoryEntry, MarketPatch, OrderRow, PositionRow, UserDelta, VenueCodec, WireSub,
} from "../types.js";
import {
  badFieldsError, capabilities, compact, dec, idOf, isObj, nextHour, parseFrame, pick, protocolError, readDec, ts, unrecognised, type Obj,
} from "./common.js";

const S = VENUE_STATIC.hyperliquid;
const ALL = "allDexsAssetCtxs";
const PER_COIN_STALE_MS = 10_000;

interface HlDex {
  /** Universe names by position; null = delisted (not a market, skipped by documented rule). */
  names: Array<string | null>;
}
interface HlData {
  /** "" = native dex. Only the selected dexes. */
  dexes: Map<string, HlDex>;
}

function data(dir: CodecDirectory): HlData {
  return dir.data as HlData;
}

function universeOf(v: unknown, dex: string): Array<{ name: string; delisted: boolean }> & { collateralToken?: unknown } {
  if (!isObj(v) || !Array.isArray(v.universe)) throw badShape("hyperliquid", `meta${dex ? `{dex:${dex}}` : ""} has no universe array`);
  const out = v.universe.map((u: unknown) => {
    if (!isObj(u) || typeof u.name !== "string") throw badShape("hyperliquid", `meta${dex ? `{dex:${dex}}` : ""} universe entry has no name`);
    return { name: u.name, delisted: u.isDelisted === true };
  });
  return Object.assign(out, { collateralToken: v.collateralToken });
}

function patchFromCtx(symbol: string, ctx: Obj, recvTs: number, bad: string[]): MarketPatch {
  return compact({
    symbol,
    venueTs: null, // ctx frames carry no timestamp
    mark: readDec(ctx, "markPx", bad),
    index: readDec(ctx, "oraclePx", bad),
    rate: readDec(ctx, "funding", bad),
    openInterest: readDec(ctx, "openInterest", bad),
    volume24hNotional: readDec(ctx, "dayNtlVlm", bad),
    nextFundingTime: nextHour(recvTs), // hourly settlement (venue-definition)
  }) as MarketPatch;
}

function subscriptionKey(sub: unknown): string | null {
  if (!isObj(sub)) return null;
  if (sub.type === ALL) return ALL;
  if (sub.type === "activeAssetCtx" && typeof sub.coin === "string") return `activeAssetCtx:${sub.coin}`;
  if (sub.type === "bbo" && typeof sub.coin === "string") return `bbo:${sub.coin}`;
  // The server echoes dex:"" for the native dex (Phase 0 private-control fixture).
  if (sub.type === "clearinghouseState" || sub.type === "openOrders") return `${sub.type}:${typeof sub.dex === "string" ? sub.dex : ""}`;
  if (sub.type === "orderUpdates" || sub.type === "userFills") return sub.type;
  return null;
}

export const hyperliquid: VenueCodec = {
  venue: "hyperliquid",
  capabilities: capabilities({
    testnet: true,
    user: true,
    fields: {
      mark: true, index: true, bestBid: false, bestAsk: false, last: false, predictedRate: false,
      nextFundingTime: true, fundingInterval: true, openInterest: true, volume24hNotional: true,
    },
    notes: {
      bestBid: "Not in asset ctxs; use the bbo channel (Phase 2)",
      bestAsk: "Not in asset ctxs; use the bbo channel (Phase 2)",
      last: "Not in asset ctxs",
      predictedRate: "HL publishes no predicted rate; `rate` (ctx.funding) is the accruing current-hour rate",
      nextFundingTime: "Hourly settlement rule (venue-definition)",
      openInterest: "Base units, one side",
      user: "By address, no auth. clearinghouseState/openOrders per selected dex (opts.hip3Dexes); userFills is replayable (deduped by tid)",
      clientId: "orders: cloid (null when the order has none). fills: cloid only when the frame carries it (WsFill documents none) — else null; join OrderRow.clientId by orderId",
      liquidationPrice: "liquidationPx (null when the venue sends null, e.g. no liquidation risk)",
      fee: "fee in feeToken (negative = rebate)",
      bbo: "bbo{coin}: full top of book per frame, no sequence",
    },
  }),
  url: (n) => S.wsUrl[n],
  restUrl: (n) => S.restUrl[n],
  secretKeys: [],
  secretUrlPatterns: [],
  ping: S.ping,
  limits: S.limits,
  closesOnBadSubscribe: true,
  staleAfterMs: S.staleAfterMs,
  openInterest: { unit: "base", sides: "one" },
  refresh: null,

  async loadDirectory(ctx) {
    const info = (body: Obj) => fetchJson(ctx.fetch, "hyperliquid", `${ctx.restUrl}/info`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let hip3: string[] = [];
    if (ctx.hip3Dexes === "all" || ctx.hip3Dexes.length > 0) {
      const raw = await info({ type: "perpDexs" });
      if (!Array.isArray(raw)) throw badShape("hyperliquid", "perpDexs is not an array");
      const names = raw.filter(isObj).map(d => d.name).filter((n): n is string => typeof n === "string");
      if (ctx.hip3Dexes === "all") hip3 = names;
      else {
        const unknown = ctx.hip3Dexes.filter(d => !names.includes(d));
        if (unknown.length > 0) {
          throw new WsError("INVALID_PARAMS", `hyperliquid: unknown HIP-3 dex(es) ${unknown.join(", ")}`, {
            exchange: "hyperliquid", remediation: `Known dexes: ${names.join(", ")}`,
          });
        }
        hip3 = ctx.hip3Dexes.slice();
      }
    }
    const [spot, ...metas] = await Promise.all([
      info({ type: "spotMeta" }),
      info({ type: "meta" }),
      ...hip3.map(dex => info({ type: "meta", dex })),
    ]);
    const tokens = new Map<number, string>();
    if (isObj(spot) && Array.isArray(spot.tokens)) {
      for (const t of spot.tokens) if (isObj(t) && typeof t.index === "number" && typeof t.name === "string") tokens.set(t.index, t.name);
    }
    const dexes = new Map<string, HlDex>();
    const entries: MarketDirectoryEntry[] = [];
    ["", ...hip3].forEach((dex, i) => {
      const uni = universeOf(metas[i], dex);
      const ct = uni.collateralToken;
      const quoteName = typeof ct === "number" ? tokens.get(ct) : undefined;
      const quote = quoteName === undefined ? null : quoteName;
      dexes.set(dex, { names: uni.map(u => (u.delisted ? null : u.name)) });
      for (const u of uni) {
        if (u.delisted) continue;
        const base = dex === "" ? u.name : u.name.slice(u.name.indexOf(":") + 1);
        const d = dex === "" ? null : dex;
        entries.push({
          venue: "hyperliquid", dex: d, symbol: u.name, venueSymbol: u.name, base, quote,
          canonical: ctx.canonicalize("hyperliquid", { venueSymbol: u.name, dex: d, base, quote }),
          rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/info",
        });
      }
    });
    return { entries, data: { dexes } satisfies HlData };
  },

  fundingMeta: () => ({
    rateKind: "accruing", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
    intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
  }),

  wiresFor(target, _dir, staleOverrideMs): WireSub[] {
    if (target.kind === "allMarkets") {
      return [{ key: ALL, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: { type: ALL } }];
    }
    const out: WireSub[] = [];
    if (target.channels.includes("market")) {
      out.push({
        key: `activeAssetCtx:${target.symbol}`,
        staleAfterMs: staleOverrideMs === null ? PER_COIN_STALE_MS : staleOverrideMs,
        params: { type: "activeAssetCtx", coin: target.symbol },
      });
    }
    // bbo frames arrive only on a top-of-book change: no stale check (a quiet book is not a dead socket).
    if (target.channels.includes("bbo")) out.push({ key: `bbo:${target.symbol}`, staleAfterMs: null, params: { type: "bbo", coin: target.symbol } });
    return out;
  },
  user: {
    inPageSecrets: false,
    wires(ref, channels, dir) {
      if (ref.venue !== "hyperliquid") return [];
      const user = ref.address;
      const dexes = Array.from(data(dir).dexes.keys());
      const dexParam = (dex: string) => (dex === "" ? {} : { dex });
      const out: WireSub[] = [];
      if (channels.includes("account") || channels.includes("positions")) {
        for (const dex of dexes) out.push({ key: `clearinghouseState:${dex}`, staleAfterMs: null, params: { type: "clearinghouseState", user, ...dexParam(dex) } });
      }
      if (channels.includes("orders")) {
        for (const dex of dexes) out.push({ key: `openOrders:${dex}`, staleAfterMs: null, params: { type: "openOrders", user, ...dexParam(dex) } });
        out.push({ key: "orderUpdates", staleAfterMs: null, params: { type: "orderUpdates", user } });
      }
      if (channels.includes("fills")) out.push({ key: "userFills", staleAfterMs: null, params: { type: "userFills", user } });
      return out;
    },
  },
  encodeSubscribe: (w) => JSON.stringify({ method: "subscribe", subscription: w.params }),
  encodeUnsubscribe: (w) => JSON.stringify({ method: "unsubscribe", subscription: w.params }),

  decode(text, dir, recvTs): DecodedEvent[] {
    const p = parseFrame(text);
    if (!p.ok) return [p.ev];
    const f = p.v;
    if (!isObj(f) || typeof f.channel !== "string") return [unrecognised("hyperliquid")];
    switch (f.channel) {
      case "pong":
        return [{ t: "pong" }];
      case "subscriptionResponse": {
        if (!isObj(f.data)) return [unrecognised("hyperliquid")];
        return [{ t: "ack", wire: subscriptionKey(f.data.subscription), reqId: null, unsubscribe: f.data.method === "unsubscribe" }];
      }
      case "error": {
        const text = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
        // The error echoes the rejected request ("…request: {json}") → fatal for that channel.
        const wire = rejectedWire(text);
        return [{ t: "error", code: "WS_PROTOCOL_ERROR", message: `hyperliquid error: ${text}`, wire, fatal: wire !== null, remediation: null }];
      }
      case ALL:
        return decodeAll(f, data(dir), recvTs);
      case "clearinghouseState":
        return decodeClearinghouse(f.data);
      case "openOrders":
        return decodeOpenOrders(f.data);
      case "orderUpdates":
        return decodeOrderUpdates(f.data, data(dir));
      case "userFills":
        return decodeFills(f.data);
      case "bbo":
        return decodeBbo(f.data);
      case "activeAssetCtx": {
        if (!isObj(f.data) || typeof f.data.coin !== "string" || !isObj(f.data.ctx)) return [protocolError("hyperliquid activeAssetCtx frame without coin/ctx")];
        const wire = `activeAssetCtx:${f.data.coin}`;
        const bad: string[] = [];
        const out: DecodedEvent[] = [{ t: "market", wire, patches: [patchFromCtx(f.data.coin, f.data.ctx, recvTs, bad)] }];
        if (bad.length > 0) out.push(badFieldsError("hyperliquid", wire, [{ symbol: f.data.coin, fields: bad }]));
        return out;
      }
      default:
        return [unrecognised("hyperliquid")];
    }
  },
};

function dexOf(coin: string): string | null {
  const i = coin.indexOf(":");
  return i < 0 ? null : coin.slice(0, i);
}

const SIDE: Record<string, "buy" | "sell"> = { B: "buy", A: "sell" };

function abs(d: string | null): string | null {
  return d === null ? null : d.replace(/^-/, "");
}

function accountUnrealized(rows: readonly PositionRow[], bad: readonly string[]): string | null {
  if (bad.includes("assetPositions") || bad.includes("assetPositions[]")) return null;
  const values: string[] = [];
  for (const r of rows) {
    if (r.unrealizedPnl === null) return null;
    values.push(r.unrealizedPnl);
  }
  const sum = sumDecimals(values);
  return sum === undefined ? null : sum;
}

function decodeClearinghouse(d: unknown): DecodedEvent[] {
  if (!isObj(d) || typeof d.dex !== "string" || !isObj(d.clearinghouseState)) return [protocolError("hyperliquid clearinghouseState frame without dex/clearinghouseState")];
  const wire = `clearinghouseState:${d.dex}`;
  const cs = d.clearinghouseState;
  const bad: string[] = [];
  const ms = isObj(cs.marginSummary) ? cs.marginSummary : null;
  if (ms === null) bad.push("marginSummary");
  const venueTs = ts(cs, "time", bad);
  const rows: PositionRow[] = [];
  if (!Array.isArray(cs.assetPositions)) bad.push("assetPositions");
  else for (const ap of cs.assetPositions) {
    const p = isObj(ap) && isObj(ap.position) ? ap.position : null;
    if (p === null || typeof p.coin !== "string") { bad.push("assetPositions[]"); continue; }
    const szi = dec(p, "szi", bad);
    const lev = isObj(p.leverage) ? dec(p.leverage, "value", bad) : null;
    rows.push({
      symbol: p.coin, dex: dexOf(p.coin),
      side: szi === null ? null : szi.startsWith("-") ? "short" : "long",
      size: abs(szi), entryPrice: dec(p, "entryPx", bad), markPrice: null,
      positionValue: dec(p, "positionValue", bad), unrealizedPnl: dec(p, "unrealizedPnl", bad),
      liquidationPrice: dec(p, "liquidationPx", bad), marginUsed: dec(p, "marginUsed", bad), leverage: lev, venueTs,
    });
  }
  const deltas: UserDelta[] = [
    {
      kind: "account", snapshot: true, dex: d.dex === "" ? null : d.dex, venueTs,
      equity: ms === null ? null : dec(ms, "accountValue", bad),
      available: dec(cs, "withdrawable", bad),
      marginUsed: ms === null ? null : dec(ms, "totalMarginUsed", bad),
      // clearinghouseState has no account-level unrealizedPnl, but the frame carries every
      // position of this dex with its own `unrealizedPnl`: the account value is their exact sum
      // ("0" with no position). null when any position's value is missing (unknown, never guessed).
      unrealizedPnl: accountUnrealized(rows, bad),
    },
    { kind: "positions", snapshot: true, scope: d.dex, rows, remove: [] },
  ];
  const out: DecodedEvent[] = [{ t: "user", wire, deltas }];
  if (bad.length > 0) out.push(badFieldsError("hyperliquid", wire, [{ symbol: "account", fields: bad }]));
  return out;
}

function orderRow(o: Obj, bad: string[], status: string | null): OrderRow | null {
  const id = idOf(o.oid);
  if (id === null || typeof o.coin !== "string") { bad.push("oid/coin"); return null; }
  const sz = dec(o, "sz", bad);
  const orig = dec(o, "origSz", bad);
  return {
    orderId: id, clientId: typeof o.cloid === "string" ? o.cloid : null, symbol: o.coin, dex: dexOf(o.coin),
    side: pick(SIDE, o.side),
    type: typeof o.orderType === "string" ? o.orderType : null, status,
    price: dec(o, "limitPx", bad), size: orig, filled: null, remaining: sz,
    reduceOnly: typeof o.reduceOnly === "boolean" ? o.reduceOnly : null,
    createdAt: ts(o, "timestamp", bad), updatedAt: null,
  };
}

function decodeOpenOrders(d: unknown): DecodedEvent[] {
  if (!isObj(d) || typeof d.dex !== "string" || !Array.isArray(d.orders)) return [protocolError("hyperliquid openOrders frame without dex/orders")];
  const wire = `openOrders:${d.dex}`;
  const bad: string[] = [];
  const rows = d.orders.map(o => (isObj(o) ? orderRow(o, bad, "open") : null)).filter((r): r is OrderRow => r !== null);
  const out: DecodedEvent[] = [{ t: "user", wire, deltas: [{ kind: "orders", snapshot: true, scope: d.dex, rows, remove: [] }] }];
  if (bad.length > 0) out.push(badFieldsError("hyperliquid", wire, [{ symbol: "orders", fields: bad }]));
  return out;
}

function decodeOrderUpdates(d: unknown, hl: HlData): DecodedEvent[] {
  if (!Array.isArray(d)) return [protocolError("hyperliquid orderUpdates data is not an array", "orderUpdates")];
  const bad: string[] = [];
  const byScope = new Map<string, { rows: OrderRow[]; remove: string[] }>();
  for (const u of d) {
    if (!isObj(u) || !isObj(u.order) || typeof u.status !== "string") { bad.push("update"); continue; }
    const row = orderRow(u.order, bad, u.status);
    if (row === null) continue;
    const scope = row.dex === null ? "" : row.dex;
    // orderUpdates covers every dex; only the selected ones (opts.hip3Dexes) have an openOrders snapshot.
    if (!hl.dexes.has(scope)) continue;
    let g = byScope.get(scope);
    if (g === undefined) { g = { rows: [], remove: [] }; byScope.set(scope, g); }
    // Only "open" rests on the book; every other status (filled, canceled, rejected, …) leaves it.
    if (u.status === "open") g.rows.push({ ...row, updatedAt: ts(u, "statusTimestamp", bad) });
    else g.remove.push(row.orderId);
  }
  const deltas: UserDelta[] = Array.from(byScope, ([scope, g]) => ({ kind: "orders", snapshot: false, scope, rows: g.rows, remove: g.remove }));
  const out: DecodedEvent[] = [{ t: "user", wire: "orderUpdates", deltas }];
  if (bad.length > 0) out.push(badFieldsError("hyperliquid", "orderUpdates", [{ symbol: "orders", fields: bad }]));
  return out;
}

function decodeFills(d: unknown): DecodedEvent[] {
  if (!isObj(d) || !Array.isArray(d.fills)) return [protocolError("hyperliquid userFills frame without fills", "userFills")];
  const bad: string[] = [];
  const fills: FillRow[] = [];
  for (const f of d.fills) {
    const id = isObj(f) ? idOf(f.tid) : null;
    if (!isObj(f) || id === null || typeof f.coin !== "string") { bad.push("tid/coin"); continue; }
    fills.push({
      // WsFill documents no cloid; read it when the frame carries one (join OrderRow.clientId by orderId otherwise).
      fillId: id, clientId: typeof f.cloid === "string" ? f.cloid : null, symbol: f.coin, dex: dexOf(f.coin),
      side: pick(SIDE, f.side),
      price: dec(f, "px", bad), size: dec(f, "sz", bad), fee: dec(f, "fee", bad),
      feeToken: typeof f.feeToken === "string" ? f.feeToken : null, closedPnl: dec(f, "closedPnl", bad),
      orderId: idOf(f.oid), liquidity: typeof f.crossed === "boolean" ? (f.crossed ? "taker" : "maker") : null,
      time: ts(f, "time", bad),
    });
  }
  const out: DecodedEvent[] = [{ t: "user", wire: "userFills", deltas: [{ kind: "fills", snapshot: d.isSnapshot === true, fills }] }];
  if (bad.length > 0) out.push(badFieldsError("hyperliquid", "userFills", [{ symbol: "fills", fields: bad }]));
  return out;
}

function decodeBbo(d: unknown): DecodedEvent[] {
  if (!isObj(d) || typeof d.coin !== "string" || !Array.isArray(d.bbo) || d.bbo.length !== 2) return [protocolError("hyperliquid bbo frame without coin/bbo[2]")];
  const wire = `bbo:${d.coin}`;
  const bad: string[] = [];
  const side = (l: unknown): [string | null, string | null] => {
    if (l === null) return [null, null]; // that side of the book is empty
    if (!isObj(l)) { bad.push("level"); return [null, null]; }
    return [dec(l, "px", bad), dec(l, "sz", bad)];
  };
  const [bid, bidSize] = side(d.bbo[0]);
  const [ask, askSize] = side(d.bbo[1]);
  const out: DecodedEvent[] = [{ t: "bbo", wire, symbol: d.coin, seq: null, bid, bidSize, ask, askSize, venueTs: ts(d, "time", bad) }];
  if (bad.length > 0) out.push(badFieldsError("hyperliquid", wire, [{ symbol: d.coin, fields: bad }]));
  return out;
}

function rejectedWire(text: string): string | null {
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    const req = JSON.parse(text.slice(at)) as unknown;
    return isObj(req) && req.method === "subscribe" ? subscriptionKey(req.subscription) : null;
  } catch {
    return null;
  }
}

function decodeAll(f: Obj, d: HlData, recvTs: number): DecodedEvent[] {
  if (!isObj(f.data) || !Array.isArray(f.data.ctxs)) return [protocolError(`hyperliquid ${ALL} frame without data.ctxs`, ALL)];
  const out: DecodedEvent[] = [];
  const patches: MarketPatch[] = [];
  const badRows: Array<{ symbol: string; fields: string[] }> = [];
  const seen = new Set<string>();
  for (const pair of f.data.ctxs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !Array.isArray(pair[1])) {
      out.push(protocolError(`hyperliquid ${ALL}: malformed [dex, ctxs] entry`, ALL));
      continue;
    }
    const dex = pair[0];
    const sel = d.dexes.get(dex);
    if (sel === undefined) continue; // dex not selected by opts.hip3Dexes (client-side filter, by design)
    seen.add(dex);
    const ctxs = pair[1] as unknown[];
    if (ctxs.length !== sel.names.length) {
      out.push(protocolError(
        `hyperliquid ${ALL}: dex "${dex}" has ${ctxs.length} ctxs but the directory has ${sel.names.length} markets — not assigned (recreate the stream to reload meta)`,
        ALL,
      ));
      continue;
    }
    ctxs.forEach((ctx, i) => {
      const name = sel.names[i];
      if (name === null) return; // delisted (meta isDelisted) — not a market
      if (!isObj(ctx)) { badRows.push({ symbol: name, fields: ["ctx"] }); return; }
      const bad: string[] = [];
      patches.push(patchFromCtx(name, ctx, recvTs, bad));
      if (bad.length > 0) badRows.push({ symbol: name, fields: bad });
    });
  }
  for (const dex of d.dexes.keys()) {
    if (!seen.has(dex)) out.push(protocolError(`hyperliquid ${ALL}: selected dex "${dex}" missing from the frame`, ALL));
  }
  if (badRows.length > 0) out.push(badFieldsError("hyperliquid", ALL, badRows));
  return [{ t: "market", wire: ALL, patches }, ...out];
}
