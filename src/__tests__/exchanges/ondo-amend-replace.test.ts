/**
 * OndoAdapter.amendOrder — cancel → replace: Ondo has no native
 * amend. req.size is the new OPEN size; fills that raced the cancel reduce the replacement:
 *
 *   replace = size − max(0, filledAtCancel − filledAtRead), floored to baseIncrement
 *
 * Price/size are validated BEFORE the cancel; the replacement keeps side / reduceOnly /
 * post-only (encoded in the generated client id).
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { getVenue, requireCapabilities } from "../../exchanges/venue.js";
import { PerpError } from "../../errors.js";

const N_CLOID = `pcli-n-${"a".repeat(32)}`;
const P_CLOID = `pcli-p-${"b".repeat(32)}`;
const PAIR = { market: "TSLA-USD.P", baseIncrement: "0.01", quoteIncrement: "0.05" };

/** Writable view of the OndoAdapter members this fixture sets on a prototype-only instance. */
type OndoInternals = {
  venue: OndoAdapter["venue"];
  caps: OndoAdapter["caps"];
  network: OndoAdapter["network"];
  client: OndoAdapter["client"];
  pairOf: OndoAdapter["pairOf"];
};

function order(over: Record<string, unknown> = {}) {
  return {
    orderId: "o1", market: PAIR.market, side: "buy", type: "limit", status: "open", price: "100", size: "1",
    filledSize: "0", filledCost: "0", reduceOnly: false, timeInForce: "GTC", clientOrderId: N_CLOID, ...over,
  };
}

function adapterWith(opts: { original?: Record<string, unknown>; cancelled?: Record<string, unknown>; post?: (path: string, body: Record<string, unknown>) => Promise<unknown>; del?: () => Promise<unknown> }) {
  const original = order(opts.original);
  const client = {
    get: vi.fn().mockResolvedValue(original),
    delete: vi.fn(opts.del ?? (async () => ({ ...original, status: "canceled", ...opts.cancelled }))),
    post: vi.fn(opts.post ?? (async (_p: string, body: Record<string, unknown>) => order({ orderId: "o2", size: body.size, price: body.price, clientOrderId: body.clientOrderId }))),
  };
  const def = getVenue("ondo");
  const a = Object.create(OndoAdapter.prototype) as OndoAdapter;
  const ai = a as unknown as OndoInternals;
  ai.venue = def;
  ai.caps = requireCapabilities(def);
  ai.network = "mainnet";
  ai.client = client as unknown as OndoInternals["client"];
  ai.pairOf = vi.fn().mockResolvedValue(PAIR);
  return { a, client };
}

const amend = (a: OndoAdapter, price: string, size: string, tif: "GTC" | "ALO" | null = null, forceTif = false) =>
  a.amendOrder({ symbol: "TSLA", ref: { kind: "orderId", value: "o1" }, price, size, tif, forceTif });

describe("Ondo cancel→replace size formula", () => {
  it("no raced fill → replacement = requested open size, same side/reduceOnly/TIF", async () => {
    const { a, client } = adapterWith({ original: { filledSize: "0.2" }, cancelled: { filledSize: "0.2" } });
    const r = await amend(a, "101", "0.5");
    expect(client.post).toHaveBeenCalledWith("/v1/perps/orders", expect.objectContaining({
      market: PAIR.market, side: "buy", type: "limit", price: "101", size: "0.5", reduceOnly: false, timeInForce: "GTC",
    }));
    expect(r.orderId).toBe("o2");
    expect(r.execution.method).toBe("cancelReplace");
  });

  it("a fill that raced the cancel is subtracted (0.5 − (0.35 − 0.2) = 0.35)", async () => {
    const { a, client } = adapterWith({ original: { filledSize: "0.2" }, cancelled: { filledSize: "0.35" } });
    await amend(a, "101", "0.5");
    expect(client.post).toHaveBeenCalledWith("/v1/perps/orders", expect.objectContaining({ size: "0.35" }));
  });

  it("the replacement is floored to baseIncrement", async () => {
    const { a, client } = adapterWith({ cancelled: { filledSize: "0.005" } });
    await amend(a, "101", "0.5");
    expect(client.post).toHaveBeenCalledWith("/v1/perps/orders", expect.objectContaining({ size: "0.49" }));
  });

  it("raced fill ≥ requested size → no replacement placed", async () => {
    const { a, client } = adapterWith({ cancelled: { filledSize: "0.6" } });
    const r = await amend(a, "101", "0.5");
    expect(client.post).not.toHaveBeenCalled();
    expect(r.execution.notes.join(" ")).toMatch(/no replacement placed/);
  });

  it("fully filled before the cancel → no replacement", async () => {
    const { a, client } = adapterWith({ cancelled: { status: "fullyfilled", filledSize: "1" } });
    const r = await amend(a, "101", "0.5");
    expect(client.post).not.toHaveBeenCalled();
    expect(r.status).toBe("filled");
  });

  it("post-only original (generated id) → replacement stays post-only", async () => {
    const { a, client } = adapterWith({ original: { clientOrderId: P_CLOID } });
    await amend(a, "101", "0.5");
    const body = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.postOnly).toBe(true);
    expect(String(body.clientOrderId)).toMatch(/^pcli-p-/);
  });

  it("resting reduce-only original → refused BEFORE the cancel (the venue only takes a reduce-only limit as IOC)", async () => {
    // venues/ondo.ts reduceOnlyTif ["IOC"]: a reduce-only GTC replacement would be refused with
    // reduce_only_invalid_tif only after the original was already cancelled.
    const { a, client } = adapterWith({ original: { reduceOnly: true, side: "sell" } });
    await expect(amend(a, "100", "0.5")).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("Ondo cancel→replace — validation before cancel, honest outcomes after", () => {
  it("off-tick price → INVALID_TICK, the original is NOT cancelled", async () => {
    const { a, client } = adapterWith({});
    await expect(amend(a, "101.02", "0.5")).rejects.toMatchObject({ structured: { code: "INVALID_TICK" } });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("size below the step → SIZE_TOO_SMALL, the original is NOT cancelled", async () => {
    const { a, client } = adapterWith({});
    await expect(amend(a, "101", "0.001")).rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("unknown original attributes (non-generated client id) without --tif → refused before cancel", async () => {
    const { a, client } = adapterWith({ original: { clientOrderId: "my-own-id" } });
    await expect(amend(a, "101", "0.5")).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("--tif that flips post-only without --force-tif → INVALID_PARAMS before cancel", async () => {
    const { a, client } = adapterWith({});
    await expect(amend(a, "101", "0.5", "ALO")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("cancel transport failure → ORDER_PENDING, nothing placed", async () => {
    const { a, client } = adapterWith({ del: async () => { throw new Error("socket hang up"); } });
    await expect(amend(a, "101", "0.5")).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("cancel answered with a non-canceled status → ORDER_PENDING, nothing placed", async () => {
    const { a, client } = adapterWith({ cancelled: { status: "pending" } });
    await expect(amend(a, "101", "0.5")).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("replacement refused (4xx) → ORDER_PARTIAL; replacement 5xx → ORDER_PENDING", async () => {
    const refused = adapterWith({ post: async () => { throw new PerpError("INVALID_PARAMS", "bad", { httpStatus: 400 }); } });
    await expect(amend(refused.a, "101", "0.5")).rejects.toMatchObject({ structured: { code: "ORDER_PARTIAL" } });
    const unknown = adapterWith({ post: async () => { throw new PerpError("EXCHANGE_ERROR", "bad gateway", { httpStatus: 502 }); } });
    await expect(amend(unknown.a, "101", "0.5")).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });
});

describe("Ondo replacement returned as venue 'pending' is read back", () => {
  it("pending → GET /v1/perps/orders/{id} until open → final open", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({
      original: { filledSize: "0" }, cancelled: { filledSize: "0" },
      post: async (_p, body) => order({ orderId: "o2", status: "pending", size: body.size, price: body.price, clientOrderId: body.clientOrderId }),
    });
    client.get
      .mockResolvedValueOnce(order()) // the original, read before the cancel
      .mockResolvedValueOnce(order({ orderId: "o2", status: "pending", price: "101", size: "0.5" }))
      .mockResolvedValueOnce(order({ orderId: "o2", status: "open", price: "101", size: "0.5" }));
    const p = amend(a, "101", "0.5");
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(client.get).toHaveBeenLastCalledWith("/v1/perps/orders/o2", null);
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "o2" });
  });
});
