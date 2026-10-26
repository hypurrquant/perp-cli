/**
 * Live-mainnet findings 2026-10-05:
 *  - Pacifica `--client-id` was accepted and dropped. docs.pacifica.fi create-limit-order:
 *    `client_order_id` "Full UUID string"; cancel-order accepts `client_order_id` ("required (if no OID)").
 *    The id is now sent (UUID validated), reported, and usable for cancel / status.
 *  - Ondo refuses a resting reduce-only order (400 `reduce_only_invalid_tif`): capability
 *    reduceOnlyTif ["IOC"] refuses it before sending.
 *  - Ondo cancel-all covers untriggered stops; the stale `excluded` note is gone.
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { PacificaAdapter, requirePacificaClientOrderId, pacificaClientOrderId } from "../../exchanges/pacifica.js";
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import type { OndoQuery } from "../../exchanges/ondo/client.js";
import { getVenue, requireCapabilities } from "../../exchanges/venue.js";
import { validateOrderRequest } from "../../exchanges/trading-v2.js";
import type { OrderRequest } from "../../exchanges/venue-types.js";
import { klinesNeedAuth } from "../../exchanges/capabilities.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import type { OndoTestAdapter, PacificaTestAdapter } from "../helpers/internals.js";

const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function pacifica(client: PacificaTestAdapter["client"]) {
  const a = Object.create(PacificaAdapter.prototype) as PacificaTestAdapter;
  a.ensureSigner = vi.fn();
  a.client = { getInfo: async () => ["BTC", "ETH", "SOL"].map((symbol) => ({ symbol, instrument_type: "perpetual" })), ...client };
  a.account = "acct";
  a.signMessage = vi.fn();
  a._hasRealKey = true;
  a.builderCode = vi.fn(async () => null);
  a.withOrderOutcome = vi.fn(async (raw: unknown) => raw);
  return a;
}

describe("Pacifica client order id", () => {
  it("a non-UUID id is INVALID_PARAMS before anything is sent", async () => {
    const createLimitOrder = vi.fn();
    const a = pacifica({ createLimitOrder });
    await expect(a.limitOrder("ETH", "buy", "2489.8", "0.0041", { clientOrderId: "adv1791149343" }))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(createLimitOrder).not.toHaveBeenCalled();
  });

  it("a UUID is sent as client_order_id and reported on the result", async () => {
    const createLimitOrder = vi.fn(async () => ({ success: true, data: { order_id: 7 } }));
    const a = pacifica({ createLimitOrder });
    const raw = await a.limitOrder("ETH", "buy", "2489.8", "0.0041", { clientOrderId: UUID }) as Record<string, unknown>;
    expect((createLimitOrder.mock.calls[0] as unknown[])[0]).toMatchObject({ client_order_id: UUID });
    expect(raw.clientOrderId).toBe(UUID);
  });

  it("without a caller id the generated TIF-encoding UUID is sent and reported (--auto-id)", async () => {
    const createLimitOrder = vi.fn(async () => ({ success: true, data: { order_id: 7 } }));
    const a = pacifica({ createLimitOrder });
    const raw = await a.limitOrder("ETH", "buy", "2489.8", "0.0041", { tif: "GTC" }) as Record<string, unknown>;
    const sent = ((createLimitOrder.mock.calls[0] as unknown[])[0] as { client_order_id: string }).client_order_id;
    expect(sent).toMatch(/^5ac1f1[0-9a-f]{2}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(raw.clientOrderId).toBe(sent);
  });

  it("a caller id in the reserved generated layout must state the order's own TIF", () => {
    const alo = pacificaClientOrderId("ALO");
    expect(requirePacificaClientOrderId(alo, "ALO")).toBe(alo);
    expect(() => requirePacificaClientOrderId(alo, "GTC")).toThrow(/reserved 5ac1f prefix/);
  });

  it("cancel c:<uuid> resolves the open order from GET /orders and reports the client reference", async () => {
    const cancelOrder = vi.fn(async () => ({ success: true }));
    const a = pacifica({
      getOrders: vi.fn(async () => [{ order_id: 42, client_order_id: UUID, symbol: "ETH", order_type: "limit" }]),
      cancelOrder,
    });
    Object.defineProperty(a, "name", { value: "pacifica" });
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "mainnet").cancelByRef("ETH", { kind: "clientOrderId", value: UUID });
    expect((cancelOrder.mock.calls[0] as unknown[])[0]).toEqual({ symbol: "ETH", order_id: 42 });
    expect(r.cancelled).toEqual([{ kind: "clientOrderId", value: UUID }]);
  });

  it("cancel c:<uuid> with no such open order → ORDER_NOT_FOUND, nothing sent", async () => {
    const cancelOrder = vi.fn();
    const a = pacifica({ getOrders: vi.fn(async () => []), getOrderHistory: vi.fn(async () => []), cancelOrder });
    Object.defineProperty(a, "name", { value: "pacifica" });
    await expect(toTradingV2(a as unknown as ExchangeAdapter, "mainnet").cancelByRef("ETH", { kind: "clientOrderId", value: UUID }))
      .rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it("status c:<uuid> reads the order's history_by_id rows", async () => {
    const a = pacifica({
      getOrders: vi.fn(async () => [{ order_id: 42, client_order_id: UUID, symbol: "ETH", order_type: "limit" }]),
      getOrderHistoryById: vi.fn(async () => [{ order_id: 42, order_status: "open", filled_amount: "0", created_at: 1, client_order_id: UUID, price: "2489.8", initial_amount: "0.0041" }]),
    });
    Object.defineProperty(a, "name", { value: "pacifica" });
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "mainnet").getOrderStatus("", { kind: "clientOrderId", value: UUID });
    expect(r).toMatchObject({ orderId: "42", clientOrderId: UUID, status: "open", finality: "final", symbol: "ETH" });
  });

  it("pacifica, hyperliquid (cloid) and aster (newClientOrderId) declare client order ids", () => {
    expect(requireCapabilities(getVenue("pacifica")).clientOrderId).toBe(true);
    expect(requireCapabilities(getVenue("hyperliquid")).clientOrderId).toBe(true);
    expect(requireCapabilities(getVenue("aster")).clientOrderId).toBe(true);
  });
});

describe("Ondo reduce-only limit orders must be IOC", () => {
  const def = getVenue("ondo");
  const caps = requireCapabilities(def);
  const req = (tif: "GTC" | "IOC" | "ALO", reduceOnly: boolean): OrderRequest => ({
    symbol: "ETH", side: "sell", type: "limit", size: "0.005", price: "2850", triggerPrice: null, triggerSource: null,
    tif, reduceOnly, clientOrderId: null, slippage: null, tpsl: null,
  });

  it.each(["GTC", "ALO"] as const)("resting reduce-only %s → CAPABILITY_UNSUPPORTED naming trade tpsl", (tif) => {
    try {
      validateOrderRequest(def, caps, req(tif, true));
      throw new Error("not refused");
    } catch (e) {
      expect(e).toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { feature: "restingReduceOnly" } } });
      expect((e as { structured: { remediation: string } }).structured.remediation).toMatch(/perp trade tpsl ETH .*--size.*-e ondo/);
    }
  });

  it("reduce-only IOC and resting non-reduce-only orders pass", () => {
    expect(() => validateOrderRequest(def, caps, req("IOC", true))).not.toThrow();
    expect(() => validateOrderRequest(def, caps, req("GTC", false))).not.toThrow();
  });

  it("the adapter refuses before sending (legacy limitOrder shim, default GTC)", async () => {
    const a = Object.create(OndoAdapter.prototype) as OndoTestAdapter;
    const post = vi.fn();
    a.venue = def; a.caps = caps; a.network = "mainnet"; a.client = { post };
    await expect(a.limitOrder("ETH", "sell", "2850", "0.005", { reduceOnly: true }))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("other venues place resting reduce-only orders (reduceOnlyTif null)", () => {
    for (const id of ["pacifica", "hyperliquid", "lighter", "lighter-rh", "aster", "arcus"]) {
      expect(requireCapabilities(getVenue(id)).reduceOnlyTif).toBeNull();
    }
  });
});

describe("Ondo cancel-all and klines", () => {
  it("cancels open orders and untriggered stopMarket / takeProfitMarket; no stale `excluded` note", async () => {
    const def = getVenue("ondo");
    const row = (orderId: string, type: string, status: string) => ({ orderId, market: "ETH-USD.P", type, status, side: "sell", price: "0", size: "0.005", filledSize: "0", filledCost: "0" });
    const open = [row("o1", "limit", "open")];
    const stops = [row("s1", "stopMarket", "untriggered"), row("t1", "takeProfitMarket", "untriggered")];
    const getPage = vi.fn(async (_p: string, q: OndoQuery | null) => ({ result: q?.status === "open" ? open : stops, nextCursor: null }));
    const del = vi.fn(async (_p: string, q: OndoQuery | null) => ({ successfulCancels: String(q?.orderIDs).split(",").map(orderId => ({ orderId })), failedCancels: null }));
    const a = Object.create(OndoAdapter.prototype) as OndoTestAdapter;
    a.venue = def; a.caps = requireCapabilities(def); a.network = "mainnet"; a.client = { getPage, delete: del };
    const r = await a.cancelAllV2(null);
    expect(del).toHaveBeenCalledWith("/v1/perps/orders/batch", { orderIDs: "o1,s1,t1" });
    expect(r.cancelled.map(c => c.value)).toEqual(["o1", "s1", "t1"]);
    expect(r.venueRaw).not.toHaveProperty("excluded");
  });

  it("Ondo klines need the registered key; other adapters do not", () => {
    const def = getVenue("ondo");
    const a = new OndoAdapter(def, { network: "mainnet", credentials: { pk: null, owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent: null }, noAgent: false, hlDex: null, readOnly: true, noBuilder: false });
    expect(klinesNeedAuth(a)).toBe(true);
    expect(klinesNeedAuth({ name: "pacifica" } as unknown as ExchangeAdapter)).toBe(false);
  });
});
