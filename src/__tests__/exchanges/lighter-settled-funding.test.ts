/**
 * Lighter / Lighter RH market rows carry the LAST SETTLED hourly rate, per 1 h, from the WS
 * `market_stats/all` snapshot (= the newest /fundings print, = the perp-ws `rate`); REST
 * /funding-rates (predicted × 8) is not read for market rows. Ambiguous tickers are listed as
 * "unclassified" (canonical null).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { sent, state } = vi.hoisted(() => ({ sent: [] as string[], state: { frames: [] as unknown[], sockets: 0, closeOnSubscribe: false, silent: false } }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWs extends EventEmitter {
    constructor(readonly url: string) { super(); state.sockets++; setTimeout(() => this.emit("open"), 0); }
    send(d: string) {
      sent.push(d);
      if (state.closeOnSubscribe) { setTimeout(() => this.emit("close", 1006), 0); return; }
      if (state.silent) return; // open, subscribed, never answers
      for (const f of state.frames) setTimeout(() => this.emit("message", JSON.stringify(f)), 0);
    }
    close() { /* closed */ }
  }
  return { default: FakeWs, WebSocket: FakeWs };
});

import "../../exchanges/venues/index.js";
import { clearLighterFundingStatsCache, fetchLighterFundingStats, lighterFundingStatsWarning, lighterPublicData } from "../../exchanges/lighter-public.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sent.length = 0; state.sockets = 0; state.closeOnSubscribe = false; state.silent = false; vi.useRealTimers(); clearLighterFundingStatsCache(); });
const snap = (stats: Record<string, unknown>) => ({ type: "subscribed/market_stats", channel: "market_stats:all", market_stats: stats });

const detail = (symbol: string, market_id: number) => ({
  symbol, market_id, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, min_base_amount: "0.001", min_quote_amount: "10",
  min_initial_margin_fraction: 200, mark_price: "100", index_price: "100", open_interest: 1, daily_quote_token_volume: 1,
});

describe("Lighter settled funding (market_stats snapshot)", () => {
  it("reads funding_rate / current_funding_rate (percent per 1 h) as fractions per 1 h, keyed by market_id", async () => {
    // "connected" and an update frame (changed markets only) before the snapshot are skipped.
    state.frames = [{ type: "connected" }, { type: "update/market_stats", channel: "market_stats:all", market_stats: { "0": { funding_rate: "9" } } },
      snap({ "0": { funding_rate: "0.0012", current_funding_rate: "0.0009" }, "1": { funding_rate: "-0.0004", current_funding_rate: null } })];
    const m = await fetchLighterFundingStats("lighter", "testnet");
    expect(JSON.parse(sent[0])).toEqual({ type: "subscribe", channel: "market_stats/all" });
    expect(m.get(0)).toEqual({ rate: "0.000012", predictedRate: "0.000009" });
    expect(m.get(1)).toEqual({ rate: "-0.000004", predictedRate: null });
  });

  it("public directory: settled rate per 1 h, BB listed as unclassified (canonical null); funding rows per 1 h", async () => {
    state.frames = [snap({ "1": { funding_rate: "0.0012", current_funding_rate: "0.0009" }, "7": { funding_rate: "0.0001", current_funding_rate: "0.0001" } })];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ order_book_details: [detail("BTC", 1), detail("BB", 7)] }), { status: 200 })));
    const rows = await lighterPublicData("lighter-rh").fetchMarkets("mainnet");
    expect(rows.find(r => r.symbol === "BTC")).toMatchObject({ fundingRate: "0.000012", fundingRateBasis: { kind: "perHours", hours: 1 } });
    expect(rows.find(r => r.symbol === "BB")).toMatchObject({ assetClass: "unclassified", canonical: null });
    const rates = await lighterPublicData("lighter-rh").fetchFundingRates("mainnet");
    expect(rates.find(r => r.symbol === "BTC")).toMatchObject({ rate: "0.000012", basis: { kind: "perHours", hours: 1 }, markPrice: "100" });
    // Docs: "Funding payments occur at each hour mark" — the next top of the hour (not published).
    const next = rates.find(r => r.symbol === "BTC")!.nextFundingTime!;
    expect(next % 3_600_000).toBe(0);
    expect(next - Date.now()).toBeGreaterThan(0);
    expect(next - Date.now()).toBeLessThanOrEqual(3_600_000);
  });

  it("nextTopOfHourMs: the next UTC hour mark, strictly after now", async () => {
    const { nextTopOfHourMs } = await import("../../exchanges/venue-types.js");
    expect(nextTopOfHourMs(Date.UTC(2026, 9, 19, 21, 17))).toBe(Date.UTC(2026, 9, 19, 22));
    expect(nextTopOfHourMs(Date.UTC(2026, 9, 19, 21))).toBe(Date.UTC(2026, 9, 19, 22));
    expect(nextTopOfHourMs(Date.UTC(2026, 9, 19, 23, 59, 59, 999))).toBe(Date.UTC(2026, 9, 20, 0));
  });

  it("a socket closed before the snapshot fails fast; the failure is remembered (no new socket) and named by the warning", async () => {
    state.closeOnSubscribe = true;
    await expect(fetchLighterFundingStats("lighter", "mainnet")).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_UNREACHABLE", message: expect.stringContaining("closed (code 1006)") }) });
    await expect(fetchLighterFundingStats("lighter", "mainnet")).rejects.toBeTruthy();
    expect(state.sockets).toBe(1);
    expect(lighterFundingStatsWarning("lighter", "mainnet")).toMatch(/fundingRate null — settled funding rate unavailable \(EXCHANGE_UNREACHABLE: .*closed/);
  });

  it("a malformed value is null with a warning (never 0)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.frames = [snap({ "1": { symbol: "BTC", funding_rate: "abc", current_funding_rate: "0.0001" } })];
    const m = await fetchLighterFundingStats("lighter", "mainnet");
    expect(m.get(1)).toEqual({ rate: null, predictedRate: "0.000001" });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/malformed funding value .*BTC/);
  });

  it("Lighter RH testnet (no WS endpoint): CAPABILITY_UNSUPPORTED with the reason; listing rows null, never the predicted rate", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fetchLighterFundingStats("lighter-rh", "testnet")).rejects.toMatchObject({ structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED", message: expect.stringContaining("no WebSocket endpoint") }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ order_book_details: [detail("BTC", 1)] }), { status: 200 })));
    const [row] = await lighterPublicData("lighter-rh").fetchMarkets("testnet");
    expect(row.fundingRate).toBeNull();
    expect(lighterFundingStatsWarning("lighter-rh", "testnet")).toMatch(/CAPABILITY_UNSUPPORTED: .*no WebSocket endpoint/);
  });

  it("funding: false (marks / precision only) opens no socket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ order_book_details: [detail("BTC", 1)] }), { status: 200 })));
    const [row] = await lighterPublicData("lighter").fetchMarkets("mainnet", { funding: false });
    expect(row.markPrice).toBe("100");
    expect(state.sockets).toBe(0);
  });

  it("a socket that never answers times out after 4 s with EXCHANGE_UNREACHABLE", async () => {
    vi.useFakeTimers();
    state.silent = true;
    const p = fetchLighterFundingStats("lighter", "mainnet");
    const done = expect(p).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_UNREACHABLE", message: expect.stringContaining("no snapshot within 4 s") }) });
    await vi.advanceTimersByTimeAsync(3_900);
    let settled = false;
    p.catch(() => {}).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await done;
  });
});
