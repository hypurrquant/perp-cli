/**
 * The ONE table of MEASURED server row caps and supported candle intervals (docs/TESTING.md §5.4).
 *
 * Rule: a documented limit is not trusted until it is measured live; every entry records how and
 * when it was measured. The measurement evidence is the recorded fixture
 * (src/__tests__/fixtures/conformance/ranges-<venue>.json, untrimmed cap cells): a full page at the
 * cap plus the probe of the next page.
 */
import { FUNDING_HISTORY_CAP } from "../../bot/strategies/funding-arb-utils.js";
import { BOOK_DEPTH_MAX } from "../../commands/market.js";
import { ARCUS_HISTORY_CAP } from "../../exchanges/arcus/adapter.js";
import { ASTER_KLINE_INTERVALS } from "../../exchanges/aster.js";
import { EXTENDED_CANDLES_PAGE_CAP, EXTENDED_FUNDING_PAGE_CAP, EXTENDED_KLINE_INTERVALS, EXTENDED_MAX_RECORDS, EXTENDED_TRADES_CAP } from "../../exchanges/extended/adapter.js";
import { GRVT_FUNDING_CAP, GRVT_KLINE_INTERVALS, GRVT_TRADES_CAP } from "../../exchanges/grvt/adapter.js";
import { LIGHTER_CANDLE_INTERVALS, LIGHTER_CANDLES_PER_CALL, LIGHTER_KLINE_MAX_PAGES, LIGHTER_RECENT_TRADES_MAX } from "../../exchanges/lighter.js";
import { LIGHTER_BOOK_ORDERS_LIMIT } from "../../exchanges/lighter-public.js";
import { PACIFICA_FUNDING_PAGE, PACIFICA_KLINE_INTERVALS, PACIFICA_KLINE_MAX_BARS, PACIFICA_MAX_PAGES, PACIFICA_TRADES_CAP } from "../../exchanges/pacifica.js";
import { HL_BOOK_LEVELS_CAP, HL_CANDLE_CAP, HL_CANDLE_INTERVAL_MS, HL_FUNDING_HISTORY_MAX_LIMIT, HL_RECENT_TRADES_CAP } from "../../exchanges/hyperliquid.js";
import { RISEX_BOOK_MAX, KLINE_INTERVAL_MS as RISEX_KLINE_INTERVAL_MS, RISEX_TRADES_CAP } from "../../exchanges/risex/adapter.js";
import { TXFLOW_KLINE_INTERVALS } from "../../exchanges/txflow/adapter.js";
import type { VenueId } from "../../exchanges/venue-types.js";

export interface ServerCap {
  venue: VenueId;
  /** The endpoint as the venue names it. */
  endpoint: string;
  /** The read command that crosses the cap. */
  command: "kline" | "funding";
  /** Rows the server returns at most per request, as MEASURED. */
  measuredRows: number;
  /** What the venue documents (null = undocumented). */
  documentedRows: number | null;
  /** Behaviour above the cap, as measured. */
  above: "truncates" | "empty";
  measuredOn: string;
  how: string;
  /** The cap-crossing request of the conformance cell (rows = the range / limit asked for). */
  request: { interval: string; rows: number } | { limit: number };
  /** Marks the capped request among the cell's requests (URL or body substring). */
  match: string;
  /**
   * The measurement of the NEXT page, recorded with the full page (record mode): the request(s) a
   * paging implementation needs, built from the capped request and its response.
   */
  nextPage(capped: { url: string; body: string | null; response: unknown }): Array<{ url: string; body: string | null }>;
}

/** Extended pages backwards: the next page ends 1 ms before the oldest row of this one. */
function extendedNextPage(capped: { url: string; response: unknown }): Array<{ url: string; body: null }> {
  const rows = ((capped.response as { data?: Array<{ T: number }> }).data ?? []);
  if (rows.length === 0) return [];
  const oldest = Math.min(...rows.map(r => r.T));
  const u = new URL(capped.url);
  u.searchParams.set("endTime", String(oldest - 1));
  return [{ url: u.toString(), body: null }];
}

export const SERVER_CAPS: readonly ServerCap[] = [
  {
    venue: "extended", endpoint: "GET /api/v1/info/candles/{market}/trades", command: "kline",
    measuredRows: EXTENDED_CANDLES_PAGE_CAP, documentedRows: EXTENDED_MAX_RECORDS, above: "truncates", measuredOn: "2026-10-19",
    how: "limit=3001 (1m, 3000-minute range): 2800 rows; the next page (endTime = oldest − 1 ms) holds 2800 more. Docs: limit ≤ 10000",
    request: { interval: "1m", rows: 3000 },
    match: "/info/candles/", nextPage: extendedNextPage,
  },
  {
    venue: "extended", endpoint: "GET /api/v1/info/{market}/funding", command: "funding",
    measuredRows: EXTENDED_FUNDING_PAGE_CAP, documentedRows: EXTENDED_MAX_RECORDS, above: "truncates", measuredOn: "2026-10-19",
    how: "limit=1500 over 1502 h: 1000 rows; the next page (endTime = oldest − 1 ms) holds the remaining 502. Docs: limit ≤ 10000",
    request: { limit: 1500 },
    match: "/funding?", nextPage: extendedNextPage,
  },
  {
    venue: "txflow", endpoint: "POST /info candleSnapshot", command: "kline",
    measuredRows: 3000, documentedRows: null, above: "empty", measuredOn: "2026-10-19",
    how: "1m over 3500 min: HTTP 200 []; the same range as 3000 + 500 min returns 3000 + 500 rows",
    request: { interval: "1m", rows: 3500 },
    match: "candleSnapshot",
    // The same range in two requests of ≤ 3000 bars each: proves the venue holds the data.
    nextPage: capped => {
      const b = JSON.parse(capped.body ?? "{}") as { req: { startTime: number; endTime: number } };
      const mid = b.req.startTime + 3000 * 60_000;
      return [
        { url: capped.url, body: JSON.stringify({ ...b, req: { ...b.req, endTime: mid } }) },
        { url: capped.url, body: JSON.stringify({ ...b, req: { ...b.req, startTime: mid } }) },
      ];
    },
  },
];

/**
 * Endpoints without a paging cap cell here. Caps that cannot be paged are refused (REFUSED_CAPS);
 * measurements of the rest are in docs/VENUE_READ_CAPS.md.
 */
export const UNMEASURED_CAPS: Readonly<Partial<Record<VenueId, string>>> = {
  hyperliquid: `fundingHistory (docs: 500 per response — paged forward from the last row's time, -l ≤ ${HL_FUNDING_HISTORY_MAX_LIMIT}); candleSnapshot serves only the most recent ${HL_CANDLE_CAP} candles (an earlier --start is refused)`,
  pacifica: `GET /kline (${PACIFICA_KLINE_MAX_BARS} bars per call — windowed, ${PACIFICA_KLINE_MAX_BARS * PACIFICA_MAX_PAGES} per command), GET /funding_rate/history (${PACIFICA_FUNDING_PAGE} per page — cursor-paged, ${PACIFICA_FUNDING_PAGE * PACIFICA_MAX_PAGES} per command)`,
  lighter: `GET /candles (${LIGHTER_CANDLES_PER_CALL} per call — paged, ${LIGHTER_CANDLES_PER_CALL * LIGHTER_KLINE_MAX_PAGES} per command), GET /fundings (docs: 750 per call — refused above, FUNDING_HISTORY_CAP), GET /orderBookOrders (${LIGHTER_BOOK_ORDERS_LIMIT} orders)`,
  "lighter-rh": `GET /candles (${LIGHTER_CANDLES_PER_CALL} per call — paged, ${LIGHTER_CANDLES_PER_CALL * LIGHTER_KLINE_MAX_PAGES} per command), GET /fundings (docs: 750 per call — refused above, FUNDING_HISTORY_CAP), GET /orderBookOrders (${LIGHTER_BOOK_ORDERS_LIMIT} orders)`,
  aster: "GET /fapi/v3/klines (docs: limit ≤ 1500 — the adapter pages, ASTER_KLINE_MAX_PAGES), GET /fapi/v3/fundingRate (measured 1000 — refused above)",
  arcus: "candles, funding history (docs: 1000 — refused above)",
  qfex: "GET /candles, GET /funding",
  risex: "candles; /funding-rate-history (measured 1000 per page — paged by page / has_next_page)",
  grvt: "kline (measured: the next cursor runs dry after ~1000 bars — paged back by end_time), funding (measured ≥ 10,000 in one answer)",
  ondo: "candles (authenticated)",
};

/**
 * Caps that CANNOT be paged (docs/VENUE_READ_CAPS.md): a request above one is INVALID_PARAMS naming
 * the cap, never a silently shorter answer. The values are the code's own tables and constants
 * (imported), so this list and the adapters cannot drift.
 */
export const REFUSED_CAPS: ReadonlyArray<{ venue: VenueId; command: "book" | "trades" | "funding"; max: number }> = [
  ...Object.entries(BOOK_DEPTH_MAX).map(([venue, max]) => ({ venue: venue as VenueId, command: "book" as const, max })),
  ...Object.entries(FUNDING_HISTORY_CAP).map(([venue, max]) => ({ venue: venue as VenueId, command: "funding" as const, max })),
  { venue: "hyperliquid", command: "trades", max: HL_RECENT_TRADES_CAP },
  { venue: "pacifica", command: "trades", max: PACIFICA_TRADES_CAP },
  { venue: "lighter", command: "trades", max: LIGHTER_RECENT_TRADES_MAX },
  { venue: "lighter-rh", command: "trades", max: LIGHTER_RECENT_TRADES_MAX },
  { venue: "risex", command: "trades", max: RISEX_TRADES_CAP },
  { venue: "extended", command: "trades", max: EXTENDED_TRADES_CAP },
  { venue: "grvt", command: "trades", max: GRVT_TRADES_CAP },
  { venue: "arcus", command: "trades", max: ARCUS_HISTORY_CAP },
];

/** Adapter constants that the CLI tables above restate: each pair must agree (ranges test). */
export const CAP_TABLE_AGREEMENT: ReadonlyArray<{ what: string; table: number | undefined; adapter: number }> = [
  { what: "BOOK_DEPTH_MAX.hyperliquid = HL_BOOK_LEVELS_CAP", table: BOOK_DEPTH_MAX.hyperliquid, adapter: HL_BOOK_LEVELS_CAP },
  { what: "BOOK_DEPTH_MAX.risex = RISEX_BOOK_MAX", table: BOOK_DEPTH_MAX.risex, adapter: RISEX_BOOK_MAX },
  { what: "FUNDING_HISTORY_CAP.hyperliquid = HL_FUNDING_HISTORY_MAX_LIMIT", table: FUNDING_HISTORY_CAP.hyperliquid, adapter: HL_FUNDING_HISTORY_MAX_LIMIT },
  { what: "FUNDING_HISTORY_CAP.pacifica = PACIFICA_FUNDING_PAGE × PACIFICA_MAX_PAGES", table: FUNDING_HISTORY_CAP.pacifica, adapter: PACIFICA_FUNDING_PAGE * PACIFICA_MAX_PAGES },
  { what: "FUNDING_HISTORY_CAP.arcus = ARCUS_HISTORY_CAP", table: FUNDING_HISTORY_CAP.arcus, adapter: ARCUS_HISTORY_CAP },
  { what: "FUNDING_HISTORY_CAP.grvt = GRVT_FUNDING_CAP", table: FUNDING_HISTORY_CAP.grvt, adapter: GRVT_FUNDING_CAP },
  { what: "FUNDING_HISTORY_CAP.extended = EXTENDED_MAX_RECORDS", table: FUNDING_HISTORY_CAP.extended, adapter: EXTENDED_MAX_RECORDS },
];

const keys = (o: object | ReadonlySet<string>): string[] => (o instanceof Set ? [...o] : Object.keys(o));

/**
 * Supported `market kline` intervals per venue: the adapter's own table where it has one (imported,
 * so the two cannot drift), else the venue documentation. A venue with no candles has none.
 */
export const KLINE_INTERVALS: Readonly<Record<VenueId, readonly string[]>> = {
  hyperliquid: keys(HL_CANDLE_INTERVAL_MS),
  pacifica: keys(PACIFICA_KLINE_INTERVALS),
  // Measured 2026-10-19: resolution=1w → HTTP 400 "invalid param" (not offered).
  lighter: keys(LIGHTER_CANDLE_INTERVALS),
  "lighter-rh": keys(LIGHTER_CANDLE_INTERVALS),
  aster: keys(ASTER_KLINE_INTERVALS),
  // src/exchanges/arcus/adapter.ts CANDLE_TIMEFRAMES (not exported).
  arcus: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w"],
  // src/exchanges/qfex/adapter.ts resolution map (not exported).
  qfex: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
  risex: keys(RISEX_KLINE_INTERVAL_MS),
  txflow: keys(TXFLOW_KLINE_INTERVALS),
  grvt: keys(GRVT_KLINE_INTERVALS),
  extended: keys(EXTENDED_KLINE_INTERVALS),
  // Credential-gated candles (keyless suite cannot read them) / no candles at all.
  ondo: [],
  variational: [],
};

/** An interval no venue offers: must be refused before any I/O. */
export const UNSUPPORTED_INTERVAL = "7m";

const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 30 * 86_400_000 };
export function intervalMs(iv: string): number {
  const m = /^(\d+)([mhdwM])$/.exec(iv);
  if (!m) throw new Error(`bad interval ${iv}`);
  return Number(m[1]) * UNIT[m[2]];
}
