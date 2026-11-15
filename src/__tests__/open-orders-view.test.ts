/**
 * A read-only Lighter adapter (no API key / expired agent) refuses getOpenOrders (an unknown list
 * is never "no orders" on a cancel path). The read-only VIEWS (portfolio, MCP portfolio, stream,
 * dashboard) read orders together with balances: openOrdersForView reports the orders as unknown
 * instead of losing the venue's balance and positions. Only the two signer codes are caught.
 */
import { describe, it, expect, vi } from "vitest";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { openOrdersForView } from "../exchanges/open-orders-view.js";

const failing = (e: unknown) => ({ getOpenOrders: async () => { throw e; } }) as unknown as ExchangeAdapter;

describe("openOrdersForView", () => {
  it("orders read → the list, no error", async () => {
    const orders = [{ orderId: "1", symbol: "BTC", side: "buy", price: "1", size: "1", filled: "0", status: "open", type: "limit" }];
    await expect(openOrdersForView({ getOpenOrders: async () => orders } as unknown as ExchangeAdapter)).resolves.toEqual({ orders, error: null });
  });

  it("NO_SIGNER_AVAILABLE → orders null + the reason", async () => {
    await expect(openOrdersForView(failing(new PerpError("NO_SIGNER_AVAILABLE", "needs an API key")))).resolves.toEqual({ orders: null, error: "needs an API key" });
  });

  it("AGENT_EXPIRED → orders null + the reason", async () => {
    await expect(openOrdersForView(failing(new PerpError("AGENT_EXPIRED", "agent expired at t")))).resolves.toEqual({ orders: null, error: "agent expired at t" });
  });

  it("any other failure rethrows (a transport error is not 'orders unknown')", async () => {
    await expect(openOrdersForView(failing(new PerpError("EXCHANGE_ERROR", "HTTP 503")))).rejects.toThrow("HTTP 503");
    await expect(openOrdersForView(failing(new Error("socket hang up")))).rejects.toThrow("socket hang up");
  });
});

describe("event stream: unknown orders", () => {
  it("a cycle whose orders are unknown emits no cancel / fill events for the last known orders", async () => {
    const { startEventStream } = await import("../event-stream.js");
    const order = { orderId: "o1", symbol: "BTC", side: "buy", price: "100", size: "1", filled: "0", status: "open", type: "limit" };
    let reads = 0;
    const adapter = {
      name: "lighter",
      getPositions: vi.fn(async () => []),
      getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
      getOpenOrders: vi.fn(async () => {
        if (++reads === 1) return [order];
        throw new PerpError("AGENT_EXPIRED", "agent expired"); // the agent expires after the first cycle
      }),
    } as unknown as ExchangeAdapter;
    const events: Array<{ type: string }> = [];
    const ac = new AbortController();
    const done = startEventStream(adapter, { intervalMs: 1, onEvent: e => events.push(e), signal: ac.signal });
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    ac.abort();
    await done;
    expect(events.filter(e => e.type === "order_placed")).toHaveLength(1);
    expect(events.filter(e => e.type === "order_cancelled" || e.type === "order_filled")).toEqual([]);
    expect(events.filter(e => e.type === "error")).toEqual([]); // balance + positions still read
  });
});

describe("portfolio entry: unknown orders", () => {
  it("a read-only Lighter keeps its balance and positions; openOrders null + openOrdersError", async () => {
    const { fetchExchangeEntry } = await import("../commands/portfolio.js");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const adapter = {
      name: "lighter",
      getBalance: async () => ({ equity: "100", available: "80", marginUsed: "20", unrealizedPnl: "0" }),
      getPositions: async () => [{ symbol: "ETH", side: "long", size: "1", entryPrice: "2000", markPrice: "2000", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }],
      getOpenOrders: async () => { throw new PerpError("NO_SIGNER_AVAILABLE", "This command requires a Lighter API key."); },
      getFundingPayments: async () => [],
    } as unknown as ExchangeAdapter;
    const e = await fetchExchangeEntry("lighter", async () => adapter);
    expect(e).toMatchObject({ connected: true, openOrders: null, openOrdersError: "This command requires a Lighter API key.", error: null });
    expect(e.positions).toHaveLength(1);
    expect(e.perp).not.toBeNull();
  });

  it("a venue that could not be read at all: openOrders null + the reason (never 0)", async () => {
    const { fetchExchangeEntry } = await import("../commands/portfolio.js");
    const e = await fetchExchangeEntry("lighter", async () => { throw new Error("HTTP 503"); });
    expect(e).toMatchObject({ connected: false, openOrders: null, openOrdersError: "HTTP 503", error: "HTTP 503" });
  });
});
