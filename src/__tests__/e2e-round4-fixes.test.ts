/**
 * Round-4 testnet E2E findings (2026-10-02). Fixtures are the venue responses recorded in
 * ~/.perp/e2e-reports/2026-10-02T05-*-testnet.json.
 *
 * 1. HL spot `spot-limit` with {"statuses":[{"error":"Insufficient spot balance asset=10000"}]}
 *    was reported status "pending" (runner stopped) — it is a definite venue rejection.
 * 2. Lighter: `account positions` read 0 right after a final 0.09 fill (the pre-trade risk read
 *    was served from the 15 s acct: disk cache) → writes invalidate the cache; the runner polls.
 * 3. Lighter RH: an orderbook read failure was swallowed into an empty book.
 * 4. Pacifica: cancel-all hit /orders/cancel for the position-level TP/SL (take_profit_market /
 *    stop_loss_market, price 0, amount 0) → 422 "Failed to cancel order" ×2 → ORDER_PARTIAL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invalidateCache = vi.fn();
vi.mock("../cache.js", async (orig) => ({ ...(await orig() as object), invalidateCache: (p?: string) => invalidateCache(p) }));

import "../exchanges/venues/index.js";
import { HyperliquidSpotAdapter } from "../exchanges/hyperliquid-spot.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { toTradingV2 } from "../exchanges/legacy-trading-v2.js";
import { PacificaAdapter, isPacificaStopType } from "../exchanges/pacifica.js";
import { PacificaClient } from "../pacifica/client.js";
import { orderCells } from "../commands/account.js";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter, ExchangeOrder } from "../exchanges/interface.js";
import { pollUntil, spotBuyLanded } from "../../scripts/e2e/lib.js";

beforeEach(() => invalidateCache.mockClear());

// ── 1. Hyperliquid spot limit: venue-final ─────────────────────────────────

/** HL spot adapter with spot meta for PURR (index 0, szDecimals 0) and a mocked exchangeAction. */
function hlSpot(response: unknown | Error) {
  const exchangeAction = vi.fn(async () => { if (response instanceof Error) throw response; return response; });
  const hl = {
    exchangeAction,
    // the real per-entry validator (no network)
    _validateVenueAck: (HyperliquidAdapter.prototype as unknown as { _validateVenueAck: (r: unknown, w: string) => void })._validateVenueAck,
  };
  const spot = new HyperliquidSpotAdapter(hl as never);
  const s = spot as unknown as { _initialized: boolean; _spotAssetMap: Map<string, number>; _spotDecimals: Map<string, unknown> };
  s._initialized = true;
  s._spotAssetMap.set("PURR", 0);
  s._spotDecimals.set("PURR", { size: 0, price: 6 });
  return { spot, exchangeAction };
}

describe("HL spot limit order is venue-final (round-4 #1)", () => {
  it("statuses[0].error (Insufficient spot balance) → ORDER_REJECTED, never pending", async () => {
    const { spot } = hlSpot({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient spot balance asset=10000" }] } } });
    const err = await spot.spotLimitOrder("PURR", "buy", "4.3939", "3", { tif: "GTC" }).catch(e => e);
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).structured.code).toBe("ORDER_REJECTED");
    expect((err as PerpError).message).toMatch(/Insufficient spot balance asset=10000/);
  });

  it("resting {oid} → the raw ack is returned (CLI maps it to open/final) and the acct cache is dropped", async () => {
    const raw = { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 61625530001 } }] } } };
    const { spot, exchangeAction } = hlSpot(raw);
    await expect(spot.spotLimitOrder("PURR", "buy", "4.3939", "3", { tif: "GTC" })).resolves.toBe(raw);
    const action = (exchangeAction.mock.calls[0] as unknown[])[0] as { orders: Array<{ a: number; p: string; s: string }> };
    expect(action.orders[0]).toMatchObject({ a: 10000, p: "4.3939", s: "3" });
    expect(invalidateCache).toHaveBeenCalledWith("acct");
  });

  it("a transport failure after sending → ORDER_PENDING (do not resubmit)", async () => {
    const { spot } = hlSpot(new TypeError("fetch failed"));
    const err = await spot.spotLimitOrder("PURR", "buy", "4.3939", "3").catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_PENDING");
  });

  it("spot cancel validates the order id before sending", async () => {
    const { spot, exchangeAction } = hlSpot({});
    await expect(spot.spotCancelOrder("PURR", "abc")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(exchangeAction).not.toHaveBeenCalled();
  });

  it("market buy: the reported 3.0 fill vs the 2.9979 credited (fee in PURR) lands", () => {
    // s-buy filled {"totalSz":"3.0","avgPx":"4.6252"}; the PURR balance afterwards read 2.9979.
    expect(spotBuyLanded(0, 2.9979, 3)).toBe(true);
    expect(spotBuyLanded(0, 0, 3)).toBe(false); // stale read → keep polling
  });
});

// ── 2. Read-after-write: acct cache + runner polling ───────────────────────

describe("account writes drop the shared acct: cache (round-4 #2)", () => {
  it("every Pacifica POST invalidates acct (also when the POST fails)", async () => {
    const client = new PacificaClient({ network: "testnet" } as never);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"success":false,"error":"Failed to cancel order","code":5}', { status: 422 }));
    const post = (client as unknown as { post: (p: string, b: object) => Promise<unknown> }).post.bind(client);
    await post("/orders/stop/cancel", {});
    await expect(post("/orders/cancel", {})).rejects.toThrow(/422/);
    expect(invalidateCache).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });
});

describe("runner pollUntil (round-4 #2a)", () => {
  it("re-reads until the position matches the verified fill (lagging read 0 → 0.09)", async () => {
    const reads = [0, 0, 0.09];
    const r = await pollUntil(async i => reads[i], p => Math.abs(p - 0.09) <= 0.005, { sleep: async () => {} });
    expect(r).toEqual({ value: 0.09, reads: 3, settled: true });
  });

  it("is bounded: gives up after the timeout with the last value (never loops forever)", async () => {
    let t = 0;
    const r = await pollUntil(async () => 0, p => p === 0.09, { timeoutMs: 10_000, intervalMs: 1_500, now: () => t, sleep: async ms => { t += ms; } });
    expect(r.settled).toBe(false);
    expect(r.value).toBe(0);
    expect(r.reads).toBe(7); // t = 0 … 9000
  });
});

// ── 3. Lighter orderbook: no swallow ───────────────────────────────────────

describe("Lighter getOrderbook surfaces failures (round-4 #3)", () => {
  async function lighterRh(get: () => Promise<unknown>) {
    const { LighterAdapter } = await import("../exchanges/lighter.js");
    const a = Object.create(LighterAdapter.prototype) as InstanceType<typeof LighterAdapter>;
    const o = a as unknown as Record<string, unknown>;
    o._marketMap = new Map([["TSLA", 112]]);
    o.restGet = vi.fn(get);
    return a;
  }

  it("a failed read throws (was: an empty book)", async () => {
    const a = await lighterRh(async () => { throw new Error("GET /orderBookOrders failed (502): bad gateway"); });
    await expect(a.getOrderbook("TSLA")).rejects.toThrow(/502/);
  });

  it("an unknown symbol is SYMBOL_NOT_FOUND (was: an empty book)", async () => {
    const a = await lighterRh(async () => ({}));
    await expect(a.getOrderbook("NOPE")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
  });

  it("RH testnet TSLA (market_id 112): the venue's empty book is returned as such", async () => {
    // GET https://api.rh-testnet.lighter.xyz/api/v1/orderBookOrders?market_id=112&limit=50 (2026-10-02)
    const a = await lighterRh(async () => ({ code: 200, total_asks: 0, asks: [], total_bids: 0, bids: [] }));
    await expect(a.getOrderbook("TSLA")).resolves.toEqual({ bids: [], asks: [] });
    expect((a as unknown as { restGet: ReturnType<typeof vi.fn> }).restGet).toHaveBeenCalledWith("/orderBookOrders", { market_id: "112", limit: "250" });
  });

  it("levels map price / remaining_base_amount", async () => {
    const a = await lighterRh(async () => ({ asks: [{ price: "2718.26", remaining_base_amount: "70.1989" }], bids: [{ price: "2717.90", remaining_base_amount: "1.5" }] }));
    await expect(a.getOrderbook("TSLA")).resolves.toEqual({ bids: [["2717.90", "1.5"]], asks: [["2718.26", "70.1989"]] });
  });
});

// ── 4. Pacifica position-level TP/SL ───────────────────────────────────────

/** GET /orders rows after `trade market SOL buy 0.09 --tp 128.85 --sl 116.57` (testnet 2026-10-02). */
const PAC_TPSL_ROWS = [
  { order_id: 404321273, client_order_id: null, symbol: "SOL", side: "ask", price: "0", initial_amount: "0", filled_amount: "0", cancelled_amount: "0", stop_price: "116.57", order_type: "stop_loss_market", stop_parent_order_id: null, trigger_price_type: "mark", reduce_only: true, created_at: 1, updated_at: 1 },
  { order_id: 404321272, client_order_id: null, symbol: "SOL", side: "ask", price: "0", initial_amount: "0", filled_amount: "0", cancelled_amount: "0", stop_price: "128.85", order_type: "take_profit_market", stop_parent_order_id: null, trigger_price_type: "mark", reduce_only: true, created_at: 1, updated_at: 1 },
];

describe("Pacifica position-level TP/SL (round-4 #4)", () => {
  it("account orders: type + trigger price, 'market' / 'position' instead of price 0 / size 0", async () => {
    const a = Object.create(PacificaAdapter.prototype) as PacificaAdapter;
    const o = a as unknown as Record<string, unknown>;
    o._hasRealKey = true;
    o._account = "acct";
    Object.defineProperty(a, "account", { get: () => "acct" });
    o.client = { getOrders: vi.fn(async () => PAC_TPSL_ROWS), getInfo: vi.fn(async () => []) };
    const rows = await a.getOpenOrders();
    expect(rows.map(r => [r.orderId, r.type, r.triggerPrice])).toEqual([
      ["404321273", "stop_loss_market", "116.57"],
      ["404321272", "take_profit_market", "128.85"],
    ]);
    expect(orderCells(rows[0])).toEqual(["stop_loss_market", "$116.57", "market", "position"]);
    const plain: ExchangeOrder = { orderId: "1", symbol: "SOL", side: "buy", price: "117.14", size: "0.10", filled: "0", status: "open", type: "limit", triggerPrice: null };
    expect(orderCells(plain)).toEqual(["limit", "-", "$117.14", "0.10"]);
  });

  it("stop / TP / SL order types", () => {
    for (const t of ["stop_loss_market", "take_profit_market", "stop_market", "stop_limit", "take_profit_limit", "stop_loss_limit"]) expect(isPacificaStopType(t)).toBe(true);
    for (const t of ["limit", "market", ""]) expect(isPacificaStopType(t)).toBe(false);
  });

  function pac(lists: ExchangeOrder[][]) {
    let i = 0;
    const getOpenOrders = vi.fn(async () => lists[Math.min(i++, lists.length - 1)]);
    const cancelOrder = vi.fn(async () => { throw new Error('POST /orders/cancel failed (422): {"success":false,"data":null,"error":"Failed to cancel order","code":5}'); });
    const cancelStopOrder = vi.fn(async () => ({ success: true }));
    const adapter = { name: "pacifica", getOpenOrders, cancelOrder, cancelStopOrder } as unknown as ExchangeAdapter;
    return { v2: toTradingV2(adapter, "testnet"), cancelOrder, cancelStopOrder, getOpenOrders };
  }
  const tpsl = (id: string, type: string, trigger: string): ExchangeOrder =>
    ({ orderId: id, symbol: "SOL", side: "sell", price: "0", size: "0", filled: "0", status: "open", type, triggerPrice: trigger });

  it("cancel-all cancels position TP/SL via the stop-order endpoint, then the re-list confirms", async () => {
    const m = pac([[tpsl("404321273", "stop_loss_market", "116.57"), tpsl("404321272", "take_profit_market", "128.85")], []]);
    const r = await m.v2.cancelAllV2(null);
    expect(r.cancelled.map(x => x.value).sort()).toEqual(["404321272", "404321273"]);
    expect(r.failed).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(m.cancelStopOrder).toHaveBeenCalledWith("SOL", "404321273");
    expect(m.cancelStopOrder).toHaveBeenCalledWith("SOL", "404321272");
    expect(m.cancelOrder).not.toHaveBeenCalled();
    expect(m.getOpenOrders).toHaveBeenCalledTimes(2);
  });

  it("a TP/SL still listed after the stop cancel → pending (re-list wins)", async () => {
    const leg = tpsl("404321273", "stop_loss_market", "116.57");
    const m = pac([[leg], [leg]]);
    const r = await m.v2.cancelAllV2(null);
    expect(r.cancelled).toEqual([]);
    expect(r.pending?.map(p => p.ref?.value)).toEqual(["404321273"]);
  });

  it("legacy adapter cancelAllOrders also routes stop types to cancelStopOrder", async () => {
    const a = Object.create(PacificaAdapter.prototype) as PacificaAdapter;
    const o = a as unknown as Record<string, unknown>;
    o.ensureSigner = () => {};
    o.getOpenOrders = vi.fn(async () => [tpsl("404321272", "take_profit_market", "128.85"), { ...tpsl("7", "limit", "0"), triggerPrice: null, price: "100", size: "1" }]);
    o.cancelStopOrder = vi.fn(async () => ({ success: true }));
    o.cancelOrder = vi.fn(async () => ({ success: true }));
    await a.cancelAllOrders();
    expect(o.cancelStopOrder).toHaveBeenCalledWith("SOL", "404321272");
    expect(o.cancelOrder).toHaveBeenCalledWith("SOL", "7");
  });
});
