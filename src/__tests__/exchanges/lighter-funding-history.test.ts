/**
 * Lighter / Lighter RH `market funding` (QA 0.15.0): the history was ONE row stamped "now" from
 * the current /funding-rates value (a fraction per 8 h), whatever `-l` was. It now reads the
 * settled prints of GET /api/v1/fundings — PERCENT per 1 h, unsigned + `direction` — converted to
 * a signed fraction per 1 h. Fixtures: live mainnet responses (BTC, market_id 1, 2026-10-19).
 */
import { describe, it, expect, vi } from "vitest";
import { LighterAdapter, lighterFundingRow } from "../../exchanges/lighter.js";
import LIVE from "../fixtures/lighter/fundings-btc-live.json";
import LIVE_SHORT from "../fixtures/lighter/fundings-btc-short-live.json";

function makeAdapter(venue: "lighter" | "lighter-rh", body: unknown) {
  const a = new LighterAdapter("0xabc", true, undefined, venue);
  const t = a as unknown as Record<string, unknown>;
  t._marketMap = new Map([["BTC", 1]]);
  t.ensureMarketMap = async () => {};
  const restGet = vi.fn(async () => body);
  t.restGet = restGet;
  return { a, restGet };
}

describe("Lighter getFundingHistory", () => {
  it("reads /fundings and returns the last `limit` settled hourly prints (not one row at now)", async () => {
    const { a, restGet } = makeAdapter("lighter", LIVE);
    const rows = await a.getFundingHistory("BTC", 5);
    expect(restGet).toHaveBeenCalledWith("/fundings", expect.objectContaining({ market_id: "1", resolution: "1h" }));
    expect(rows).toHaveLength(5);
    const last = LIVE.fundings[LIVE.fundings.length - 1];
    expect(rows[4]).toEqual({ time: last.timestamp * 1000, rate: "0.000012", price: null, intervalHours: 1, rateKind: "lastSettled" });
    expect(rows.map(r => r.time)).toEqual([...rows.map(r => r.time)].sort((x, y) => x - y));
    expect(new Set(rows.map(r => r.time)).size).toBe(5);
  });

  it("percent per hour → fraction (value / mark = rate / 100); direction short → negative", () => {
    const f = LIVE.fundings[LIVE.fundings.length - 1];
    const row = lighterFundingRow("lighter", f);
    // value is the USD funding per 1 BTC: value / rate-as-fraction ≈ the BTC mark (~82.8k).
    expect(Number(f.value) / Number(row.rate)).toBeGreaterThan(70_000);
    expect(Number(f.value) / Number(row.rate)).toBeLessThan(95_000);
    expect(lighterFundingRow("lighter", LIVE_SHORT.fundings[0]).rate).toBe("-0.000004");
  });

  it("malformed rows and an unknown direction → EXCHANGE_ERROR (never guessed)", async () => {
    expect(() => lighterFundingRow("lighter", { timestamp: 1, rate: "0.001", direction: "flat" })).toThrow(/direction/);
    expect(() => lighterFundingRow("lighter", { timestamp: 1, rate: "-0.001", direction: "long" })).toThrow(/unsigned/);
    await expect(makeAdapter("lighter", { code: 200 }).a.getFundingHistory("BTC", 3)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("Lighter RH uses the same endpoint and units", async () => {
    const { a } = makeAdapter("lighter-rh", LIVE);
    expect((await a.getFundingHistory("BTC", 2)).every(r => r.intervalHours === 1 && r.rateKind === "lastSettled")).toBe(true);
  });

  it("-l outside 1..750 → INVALID_PARAMS", async () => {
    await expect(makeAdapter("lighter", LIVE).a.getFundingHistory("BTC", 0)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
  });
});

describe("scoreFunding normalizes by the row's own interval", () => {
  it("Lighter hourly prints are not divided by the venue's 8 h quote basis", async () => {
    const { scoreFunding } = await import("../../bot/strategies/funding-arb-utils.js");
    const { a } = makeAdapter("lighter", LIVE);
    const s = await scoreFunding(a, "BTC", "lighter", 5);
    // 0.000012 per hour × 8760 × 100 = 10.512 % APR (÷ 8 would read 1.314 %).
    expect(s?.annualized).toBeCloseTo(10.512, 2);
  });
});
