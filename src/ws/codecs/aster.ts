/**
 * Aster codec (§6.1, public only in 0.15.0). One combined-stream socket (`/stream`, frames
 * {stream, data}) with `!markPrice@arr@1s` (every symbol, 1 s) + `!ticker@arr` (only changed symbols).
 * r = accruing current-period rate (Phase 0: == premiumIndex.lastFundingRate ≠ last settled).
 * The funding interval is per market from the LABELLED REST source `rest:/fapi/v3/fundingInfo`
 * (hourly refresh; missing → null). OI and the predicted rate are not published (null).
 * The directory is exchangeInfo (all quotes; base/quote never parsed from the suffix). markPrice@arr
 * also carries symbols that exchangeInfo does not list (delisted/hidden, no base/quote metadata):
 * those are learnt from rest:/fapi/v3/premiumIndex at bootstrap and skipped by documented rule.
 * Unknown stream names are accepted silently by the venue → only fixed stream names are used.
 *
 * Docs: github.com/asterdex/api-docs (V3 futures); fixtures src/__tests__/fixtures/ws/aster/.
 */

import { badShape, fetchJson } from "../directory.js";
import { isAsterListedPerpetual } from "../aster-market.js";
import { VENUE_STATIC } from "../venue-static.js";
import type { CodecContext, DecodedEvent, MarketDirectoryEntry, MarketPatch, VenueCodec, WireSub } from "../types.js";
import {
  badFieldsError, capabilities, compact, dec, isObj, ts, parseFrame, protocolError, readDec, readTs, unrecognised, type Obj,
} from "./common.js";

const S = VENUE_STATIC.aster;
const MARK = "!markPrice@arr@1s";
const TICKER = "!ticker@arr";
const TICKER_STALE_MS = 15_000; // only changed symbols per frame
const FUNDING_INFO = "rest:/fapi/v3/fundingInfo" as const;

interface AsterData {
  intervals: Map<string, number>;
  intervalsAt: number | null;
  /** In premiumIndex (and markPrice@arr) but not in exchangeInfo. */
  unlisted: Set<string>;
}

/** Per-symbol intervals; malformed rows are reported (count + examples), their markets stay null. */
async function fetchIntervals(ctx: CodecContext): Promise<{ intervals: Map<string, number>; warnings: string[] }> {
  const raw = await fetchJson(ctx.fetch, "aster", `${ctx.restUrl}/fapi/v3/fundingInfo`);
  if (!Array.isArray(raw)) throw badShape("aster", "GET /fapi/v3/fundingInfo is not an array");
  const m = new Map<string, number>();
  const bad: string[] = [];
  for (const r of raw) {
    if (isObj(r) && typeof r.symbol === "string" && typeof r.fundingIntervalHours === "number" && r.fundingIntervalHours > 0) {
      m.set(r.symbol, r.fundingIntervalHours);
    } else {
      bad.push(isObj(r) && typeof r.symbol === "string" ? r.symbol : "?");
    }
  }
  const warnings = bad.length === 0 ? [] : [
    `aster ${FUNDING_INFO}: ${bad.length} malformed row(s) (${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", …" : ""}); their funding interval is null`,
  ];
  return { intervals: m, warnings };
}

export const aster: VenueCodec = {
  venue: "aster",
  capabilities: capabilities({
    testnet: true,
    user: false,
    fields: {
      mark: true, index: true, bestBid: false, bestAsk: false, last: true, predictedRate: false,
      nextFundingTime: true, fundingInterval: true, openInterest: false, volume24hNotional: true,
    },
    notes: {
      bestBid: "Use the bookTicker bbo channel (Phase 2)",
      bestAsk: "Use the bookTicker bbo channel (Phase 2)",
      predictedRate: "Not published; `rate` (r) is the accruing current-period rate",
      openInterest: "Not on WS (REST only)",
      fundingInterval: `Labelled REST source ${FUNDING_INFO}, refreshed hourly; missing → null`,
      volume24hNotional: "!ticker@arr q (quote-asset volume)",
      user: "KNOWN GAP in 0.15.0: no Aster user channels (signed USER_STREAM listenKey) — kind:\"user\" rejects CAPABILITY_UNSUPPORTED; arrives in 0.15.1",
      bbo: "<symbol>@bookTicker; `u` orders frames (non-contiguous)",
    },
  }),
  url: (n) => `${S.wsUrl[n]}/stream`,
  restUrl: (n) => S.restUrl[n],
  secretKeys: ["listenKey"],
  // A user-data stream URL ends in the listenKey (/ws/<listenKey>).
  secretUrlPatterns: [/(?<=asterdex(?:-testnet)?\.com\/(?:ws|stream)\/)[A-Za-z0-9]{20,}/g],
  ping: S.ping,
  limits: S.limits,
  closesOnBadSubscribe: false,
  staleAfterMs: S.staleAfterMs,
  openInterest: { unit: null, sides: null },
  refresh: {
    source: FUNDING_INFO,
    everyMs: 3_600_000,
    async run(ctx, dir) {
      const d = dir.data as AsterData;
      const r = await fetchIntervals(ctx);
      d.intervals = r.intervals;
      d.intervalsAt = ctx.clock();
      return r.warnings;
    },
  },

  async loadDirectory(ctx) {
    const [info, fi, premium] = await Promise.all([
      fetchJson(ctx.fetch, "aster", `${ctx.restUrl}/fapi/v3/exchangeInfo`),
      fetchIntervals(ctx),
      fetchJson(ctx.fetch, "aster", `${ctx.restUrl}/fapi/v3/premiumIndex`),
    ]);
    if (!isObj(info) || !Array.isArray(info.symbols)) throw badShape("aster", "GET /fapi/v3/exchangeInfo has no symbols array");
    if (!Array.isArray(premium)) throw badShape("aster", "GET /fapi/v3/premiumIndex is not an array");
    const intervals = fi.intervals;
    const entries: MarketDirectoryEntry[] = [];
    const listed = new Set<string>();
    for (const s of info.symbols) {
      if (!isObj(s) || typeof s.symbol !== "string" || typeof s.baseAsset !== "string") {
        throw badShape("aster", "exchangeInfo symbol without symbol/baseAsset");
      }
      // Not a listed perpetual (SETTLING, PENDING_TRADING, contractType "") → not in the
      // directory, the same rule as the CLI adapter (isAsterListedPerpetual).
      if (!isAsterListedPerpetual(s)) continue;
      const quote = typeof s.quoteAsset === "string" && s.quoteAsset !== "" ? s.quoteAsset : null;
      listed.add(s.symbol);
      const hours = intervals.get(s.symbol);
      entries.push({
        venue: "aster", dex: null, symbol: s.symbol, venueSymbol: s.symbol, base: s.baseAsset, quote,
        canonical: ctx.canonicalize("aster", { venueSymbol: s.symbol, dex: null, base: s.baseAsset, quote }),
        rateIntervalHours: hours === undefined ? null : hours,
        settlementIntervalHours: hours === undefined ? null : hours,
        source: "rest:/fapi/v3/exchangeInfo",
      });
    }
    const unlisted = new Set<string>();
    for (const p of premium) if (isObj(p) && typeof p.symbol === "string" && !listed.has(p.symbol)) unlisted.add(p.symbol);
    return { entries, data: { intervals, intervalsAt: ctx.clock(), unlisted } satisfies AsterData, warnings: fi.warnings };
  },

  fundingMeta(entry, dir) {
    const d = dir.data as AsterData;
    const h = d.intervals.get(entry.symbol);
    return {
      rateKind: "accruing", rateSource: "ws",
      rateIntervalHours: h === undefined ? null : h,
      settlementIntervalHours: h === undefined ? null : h,
      intervalSource: h === undefined ? null : FUNDING_INFO,
      intervalAsOf: h === undefined ? null : d.intervalsAt,
      marketClosed: null,
    };
  },

  wiresFor(target, _dir, staleOverrideMs): WireSub[] {
    const all: WireSub[] = [
      { key: MARK, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: {} },
      { key: TICKER, staleAfterMs: staleOverrideMs === null ? TICKER_STALE_MS : staleOverrideMs, params: {} },
    ];
    if (target.kind === "allMarkets") return all;
    const out: WireSub[] = target.channels.includes("market") ? all : [];
    if (target.channels.includes("bbo")) out.push({ key: `${target.symbol.toLowerCase()}@bookTicker`, staleAfterMs: null, params: { symbol: target.symbol } });
    return out;
  },
  user: null,
  encodeSubscribe: (w, reqId) => JSON.stringify({ method: "SUBSCRIBE", params: [w.key], id: reqId }),
  encodeUnsubscribe: (w, reqId) => JSON.stringify({ method: "UNSUBSCRIBE", params: [w.key], id: reqId }),

  decode(text, dir): DecodedEvent[] {
    const p = parseFrame(text);
    if (!p.ok) return [p.ev];
    const f = p.v;
    if (!isObj(f)) return [unrecognised("aster")];
    if ("result" in f && typeof f.id === "number") {
      // {id, result:null} = SUBSCRIBE/UNSUBSCRIBE ack; {id, result:[…]} = LIST_SUBSCRIPTIONS answer.
      return f.result === null ? [{ t: "ack", wire: null, reqId: f.id, unsubscribe: false }] : [{ t: "ignore", what: "list-subscriptions" }];
    }
    if (isObj(f.error)) {
      const msg = typeof f.error.msg === "string" ? f.error.msg : JSON.stringify(f.error);
      const message = `aster error${typeof f.error.code === "number" ? ` ${f.error.code}` : ""}: ${msg}`;
      // {error, id}: the answer to our (UN)SUBSCRIBE request `id` → fatal for that channel.
      if (typeof f.id === "number") return [{ ...(protocolError(message) as Extract<DecodedEvent, { t: "error" }>), fatal: true, reqId: f.id }];
      return [protocolError(message)];
    }
    if (typeof f.stream !== "string") return [unrecognised("aster")];
    const d = dir.data as AsterData;
    if (f.stream === MARK) return decodeArr(MARK, f.data, d, markPatch);
    if (f.stream === TICKER) return decodeArr(TICKER, f.data, d, tickerPatch);
    if (f.stream.endsWith("@bookTicker")) return decodeBookTicker(f.stream, f.data);
    return [unrecognised("aster")];
  },
};

function decodeBookTicker(wire: string, d: unknown): DecodedEvent[] {
  if (!isObj(d) || d.e !== "bookTicker" || typeof d.s !== "string") return [protocolError(`aster ${wire} frame without bookTicker data`, wire)];
  const bad: string[] = [];
  const out: DecodedEvent[] = [{
    t: "bbo", wire, symbol: d.s, seq: typeof d.u === "number" ? d.u : null,
    bid: dec(d, "b", bad), bidSize: dec(d, "B", bad), ask: dec(d, "a", bad), askSize: dec(d, "A", bad), venueTs: ts(d, "E", bad),
  }];
  if (bad.length > 0) out.push(badFieldsError("aster", wire, [{ symbol: d.s, fields: bad }]));
  return out;
}

function markPatch(r: Obj, bad: string[]): MarketPatch | null {
  if (r.e !== "markPriceUpdate" || typeof r.s !== "string") return null;
  const venueTs = readTs(r, "E", bad);
  return compact({
    symbol: r.s,
    venueTs: venueTs === undefined ? null : venueTs,
    mark: readDec(r, "p", bad),
    index: readDec(r, "i", bad),
    rate: readDec(r, "r", bad),
    nextFundingTime: readTs(r, "T", bad),
  }) as MarketPatch;
}

function tickerPatch(r: Obj, bad: string[]): MarketPatch | null {
  if (r.e !== "24hrTicker" || typeof r.s !== "string") return null;
  const venueTs = readTs(r, "E", bad);
  return compact({
    symbol: r.s,
    venueTs: venueTs === undefined ? null : venueTs,
    last: readDec(r, "c", bad),
    volume24hNotional: readDec(r, "q", bad),
  }) as MarketPatch;
}

function decodeArr(wire: string, data: unknown, d: AsterData, fn: (r: Obj, bad: string[]) => MarketPatch | null): DecodedEvent[] {
  if (!Array.isArray(data)) return [protocolError(`aster ${wire} data is not an array`, wire)];
  const patches: MarketPatch[] = [];
  const badRows: Array<{ symbol: string; fields: string[] }> = [];
  let unrecognisedRows = 0;
  for (const r of data) {
    if (!isObj(r)) { unrecognisedRows++; continue; }
    const bad: string[] = [];
    const patch = fn(r, bad);
    if (patch === null) { unrecognisedRows++; continue; }
    if (d.unlisted.has(patch.symbol)) continue; // not in exchangeInfo (see header)
    patches.push(patch);
    if (bad.length > 0) badRows.push({ symbol: patch.symbol, fields: bad });
  }
  const out: DecodedEvent[] = [{ t: "market", wire, patches }];
  if (unrecognisedRows > 0) out.push(protocolError(`aster ${wire}: ${unrecognisedRows} unrecognised row(s)`, wire));
  if (badRows.length > 0) out.push(badFieldsError("aster", wire, badRows));
  return out;
}

