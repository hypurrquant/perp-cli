/**
 * The ONE table of MEASURED server row caps and supported candle intervals (docs/TESTING.md §5.4).
 *
 * Rule: a documented limit is not trusted until it is measured live; every entry records how and
 * when it was measured. The measurement evidence is the recorded fixture
 * (src/__tests__/fixtures/conformance/ranges-<venue>.json, untrimmed cap cells): a full page at the
 * cap plus the probe of the next page.
 */
import { EXTENDED_KLINE_INTERVALS } from "../../exchanges/extended/adapter.js";
import { GRVT_KLINE_INTERVALS } from "../../exchanges/grvt/adapter.js";
import { KLINE_INTERVAL_MS as RISEX_KLINE_INTERVAL_MS } from "../../exchanges/risex/adapter.js";
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
    measuredRows: 2800, documentedRows: 10_000, above: "truncates", measuredOn: "2026-10-19",
    how: "limit=3001 (1m, 3000-minute range): 2800 rows; the next page (endTime = oldest − 1 ms) holds 2800 more. Docs: limit ≤ 10000",
    request: { interval: "1m", rows: 3000 },
    match: "/info/candles/", nextPage: extendedNextPage,
  },
  {
    venue: "extended", endpoint: "GET /api/v1/info/{market}/funding", command: "funding",
    measuredRows: 1000, documentedRows: 10_000, above: "truncates", measuredOn: "2026-10-19",
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

/** Endpoints whose cap is NOT measured yet — their documented limits are not trusted (no paging claims). */
export const UNMEASURED_CAPS: Readonly<Partial<Record<VenueId, string>>> = {
  hyperliquid: "candleSnapshot (docs: 5000 most recent candles), fundingHistory (docs: 500 per response)",
  pacifica: "GET /kline, GET /funding_rate/history",
  lighter: "GET /candles (count_back), GET /fundings",
  "lighter-rh": "GET /candles (count_back), GET /fundings",
  aster: "GET /fapi/v3/klines (docs: limit ≤ 1500 — the adapter pages, ASTER_KLINE_MAX_PAGES), GET /fapi/v3/fundingRate (docs: ≤ 1000)",
  arcus: "candles, funding history",
  qfex: "GET /candles, GET /funding",
  risex: "candles, funding history",
  grvt: "kline, funding (docs: limit ≤ 1000)",
  ondo: "candles (authenticated)",
};

const keys = (o: object | ReadonlySet<string>): string[] => (o instanceof Set ? [...o] : Object.keys(o));

/**
 * Supported `market kline` intervals per venue: the adapter's own table where it has one (imported,
 * so the two cannot drift), else the venue documentation. A venue with no candles has none.
 */
export const KLINE_INTERVALS: Readonly<Record<VenueId, readonly string[]>> = {
  hyperliquid: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"],
  pacifica: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"],
  // Measured 2026-10-19: resolution=1w → HTTP 400 "invalid param" (not offered).
  lighter: ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"],
  "lighter-rh": ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"],
  aster: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"],
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
