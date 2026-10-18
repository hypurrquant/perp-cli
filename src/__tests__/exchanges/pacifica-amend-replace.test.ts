/**
 * PacificaAdapter.amendKeepingTif — cancel → replace: the native edit
 * re-creates an order as ALO, so a non-ALO order is cancelled and replaced. The replacement
 * size is the requested open size MINUS what filled between the read and the cancel:
 *
 *   replace = size − max(0, filledAtCancel − filledAtRead), floored to the lot
 *
 * so a fill that raced the cancel is never re-bought. Validation (lot, tick) happens BEFORE
 * the original is cancelled; once cancelled, an unreadable fill / refused replacement is
 * reported (ORDER_PARTIAL), never retried blindly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PacificaAdapter, pacificaClientOrderId } from "../../exchanges/pacifica.js";

const GTC_CLOID = pacificaClientOrderId("GTC");

/** Writable view of the PacificaAdapter members this fixture sets on a prototype-only instance. */
type PacificaInternals = {
  client: PacificaAdapter["client"];
  account: PacificaAdapter["account"];
  signMessage: PacificaAdapter["signMessage"];
  ensureSigner: PacificaAdapter["ensureSigner"];
};

function adapterWith(opts: {
  original?: Record<string, unknown>;
  filledAtCancel?: string;
  status?: "cancelled" | "filled";
  history?: () => Promise<unknown>;
  createLimitOrder?: (...a: unknown[]) => Promise<unknown>;
  tick?: string;
  lot?: string;
}) {
  const original = {
    order_id: 42, symbol: "BTC", side: "bid", order_type: "limit", price: "100", initial_amount: "1",
    filled_amount: "0", reduce_only: false, client_order_id: GTC_CLOID, ...opts.original,
  };
  const client = {
    setRequestAgentWallet: vi.fn(),
    getOrders: vi.fn().mockResolvedValue([original]),
    getInfo: vi.fn().mockResolvedValue([{ symbol: "BTC", instrument_type: "perpetual", tick_size: opts.tick ?? "0.1", lot_size: opts.lot ?? "0.01" }]),
    cancelOrder: vi.fn().mockResolvedValue({ success: true }),
    getOrderHistoryById: vi.fn(opts.history ?? (async () => ({
      data: [{ order_id: 42, order_status: opts.status ?? "cancelled", filled_amount: opts.filledAtCancel ?? "0", created_at: 1 }],
    }))),
    createLimitOrder: vi.fn(opts.createLimitOrder ?? (async () => ({ success: true, data: { order_id: 43 } }))),
  };
  const a = Object.create(PacificaAdapter.prototype) as PacificaAdapter;
  const ai = a as unknown as PacificaInternals;
  ai.client = client as unknown as PacificaInternals["client"];
  ai.account = "acct";
  ai.signMessage = vi.fn();
  ai.ensureSigner = vi.fn();
  a.getMarkets = vi.fn().mockResolvedValue([{ symbol: "BTC", stepSize: opts.lot ?? "0.01", sizeDecimals: 2 }]);
  return { a, client };
}

/** amendKeepingTif polls the history with 500 ms sleeps. */
async function run<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

afterEach(() => vi.useRealTimers());

describe("Pacifica cancel→replace size formula", () => {
  it("nothing filled meanwhile → replacement = requested size, same side / TIF / reduce-only", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({ original: { filled_amount: "0.2" }, filledAtCancel: "0.2" });
    const r = await run(a.amendKeepingTif("BTC", "42", "101", "0.5", null));
    expect(r.method).toBe("cancelReplace");
    expect(r.replacedSize).toBe("0.5");
    expect(client.createLimitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTC", price: "101", amount: "0.5", side: "bid", reduce_only: false, tif: "GTC" }),
      "acct", expect.any(Function), null);
  });

  it("a fill that raced the cancel is subtracted (0.5 − (0.35 − 0.2) = 0.35)", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({ original: { filled_amount: "0.2" }, filledAtCancel: "0.35" });
    const r = await run(a.amendKeepingTif("BTC", "42", "101", "0.5", null));
    expect(r.replacedSize).toBe("0.35");
    expect(r.filledBeforeCancel).toBe("0.35");
    expect(client.createLimitOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: "0.35" }), "acct", expect.any(Function), null);
  });

  it("the replacement is floored to the lot", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({ original: { filled_amount: "0" }, filledAtCancel: "0.005", lot: "0.01" });
    const r = await run(a.amendKeepingTif("BTC", "42", "101", "0.5", null));
    expect(r.replacedSize).toBe("0.49"); // 0.495 floored
    expect(client.createLimitOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: "0.49" }), "acct", expect.any(Function), null);
  });

  it("raced fill ≥ requested size → no replacement placed (never re-buys)", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({ original: { filled_amount: "0" }, filledAtCancel: "0.6" });
    const r = await run(a.amendKeepingTif("BTC", "42", "101", "0.5", null));
    expect(r.replacedSize).toBeNull();
    expect(client.createLimitOrder).not.toHaveBeenCalled();
  });

  it("order filled completely before the cancel → no replacement, filledCompletely", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({ status: "filled", filledAtCancel: "1" });
    const r = await run(a.amendKeepingTif("BTC", "42", "101", "0.5", null));
    expect(r.filledCompletely).toBe(true);
    expect(client.createLimitOrder).not.toHaveBeenCalled();
  });

  it("reduce-only original → the replacement is reduce-only too", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({ original: { reduce_only: true, side: "ask" } });
    await run(a.amendKeepingTif("BTC", "42", "99", "0.5", null));
    expect(client.createLimitOrder).toHaveBeenCalledWith(expect.objectContaining({ reduce_only: true, side: "ask" }), "acct", expect.any(Function), null);
  });
});

describe("Pacifica cancel→replace — validation before cancel, honest reporting after", () => {
  it("off-tick replacement price → INVALID_TICK and the original is NOT cancelled", async () => {
    const { a, client } = adapterWith({ tick: "0.5" });
    await expect(a.amendKeepingTif("BTC", "42", "100.3", "0.5", null)).rejects.toMatchObject({ structured: { code: "INVALID_TICK" } });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("size below the lot → SIZE_TOO_SMALL and the original is NOT cancelled", async () => {
    const { a, client } = adapterWith({ lot: "0.01" });
    await expect(a.amendKeepingTif("BTC", "42", "100", "0.001", null)).rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("fill at cancel unreadable → ORDER_PARTIAL (original gone, nothing replaced)", async () => {
    vi.useFakeTimers();
    const { a, client } = adapterWith({ history: async () => { throw new Error("503"); } });
    await expect(run(a.amendKeepingTif("BTC", "42", "101", "0.5", null))).rejects.toMatchObject({ structured: { code: "ORDER_PARTIAL" } });
    expect(client.createLimitOrder).not.toHaveBeenCalled();
  });

  it("replacement transport failure → ORDER_PENDING (do not resubmit)", async () => {
    vi.useFakeTimers();
    const { a } = adapterWith({ createLimitOrder: async () => { throw new Error("fetch failed"); } });
    await expect(run(a.amendKeepingTif("BTC", "42", "101", "0.5", null))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });

  it("replacement refused by the venue (4xx) → ORDER_PARTIAL", async () => {
    vi.useFakeTimers();
    const { a } = adapterWith({ createLimitOrder: async () => { throw new Error("POST /orders/create failed (400): bad"); } });
    await expect(run(a.amendKeepingTif("BTC", "42", "101", "0.5", null))).rejects.toMatchObject({ structured: { code: "ORDER_PARTIAL" } });
  });

  it("ALO order → native edit (no cancel)", async () => {
    const { a, client } = adapterWith({ original: { client_order_id: pacificaClientOrderId("ALO") } });
    (a as unknown as { editOrder: unknown }).editOrder = vi.fn().mockResolvedValue({ success: true, data: { order_id: 50 } });
    const r = await a.amendKeepingTif("BTC", "42", "101", "0.5", null);
    expect(r.method).toBe("nativeAmend");
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("--tif that flips post-only without --force-tif is refused before anything is sent", async () => {
    const { a, client } = adapterWith({});
    await expect(a.amendKeepingTif("BTC", "42", "101", "0.5", "ALO")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });
});
