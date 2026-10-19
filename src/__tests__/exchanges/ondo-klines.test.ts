/**
 * Ondo `market kline` (QA 0.15.0): GET /v1/perps/candles buckets minute-based resolutions from the
 * requested `from` (from=10:01:07 → candles at :01) and appends a zero-volume bucket that opens
 * after `to`. The adapter floors `from` to the interval boundary and drops candles past the end.
 * Rows below: live mainnet response of 2026-10-19 (BTC-USD.P, resolution 60, from aligned to 07:00).
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";

const LIVE_ALIGNED = [
  { startTime: "2026-10-19T07:00:00Z", open: "82727", high: "83046", low: "82565", close: "82604", volume: "12.6828" },
  { startTime: "2026-10-19T08:00:00Z", open: "82613", high: "82849", low: "82462", close: "82699", volume: "13.5261" },
  { startTime: "2026-10-19T09:00:00Z", open: "82704", high: "82989", low: "82614", close: "82644", volume: "12.1482" },
  { startTime: "2026-10-19T10:00:00Z", open: "82642", high: "82776", low: "82601", close: "82639", volume: "2.5816" },
  // Opens after the requested end (10:11:01) — a placeholder bucket the venue appends.
  { startTime: "2026-10-19T11:00:00Z", open: "82639", high: "82639", low: "82639", close: "82639", volume: "0" },
];

function adapterReturning(rows: unknown[]) {
  const get = vi.fn().mockResolvedValue(rows);
  const a = Object.create(OndoAdapter.prototype) as OndoAdapter;
  (a as unknown as { client: unknown }).client = { get };
  return { a, get };
}

const REQ_START = Date.parse("2026-10-19T07:01:07Z");
const REQ_END = Date.parse("2026-10-19T10:11:01Z");

describe("Ondo getKlines", () => {
  it("floors `from` to the interval boundary for minute/hour resolutions", async () => {
    const { a, get } = adapterReturning(LIVE_ALIGNED);
    await a.getKlines("BTC", "1h", REQ_START, REQ_END);
    expect(get.mock.calls[0][1]).toMatchObject({ resolution: "60", from: Date.parse("2026-10-19T07:00:00Z") / 1000 });
    await a.getKlines("BTC", "15m", REQ_START, REQ_END);
    expect(get.mock.calls[1][1]).toMatchObject({ resolution: "15", from: Date.parse("2026-10-19T07:00:00Z") / 1000 });
  });

  it("leaves day/week resolutions to the venue (already aligned)", async () => {
    const { a, get } = adapterReturning(LIVE_ALIGNED);
    await a.getKlines("BTC", "1d", REQ_START, REQ_END);
    expect(get.mock.calls[0][1]).toMatchObject({ resolution: "1D", from: Math.floor(REQ_START / 1000) });
  });

  it("every candle opens on the boundary and none opens after the requested end", async () => {
    const { a } = adapterReturning(LIVE_ALIGNED);
    const k = await a.getKlines("BTC", "1h", REQ_START, REQ_END);
    expect(k.map(c => new Date(c.time).toISOString())).toEqual([
      "2026-10-19T07:00:00.000Z", "2026-10-19T08:00:00.000Z", "2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z",
    ]);
    expect(k.every(c => c.time % 3_600_000 === 0 && c.time <= REQ_END)).toBe(true);
  });
});
