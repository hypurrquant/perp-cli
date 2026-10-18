/**
 * placePerpVerified / closePerpVerified: a resolved order call
 * is not a fill. The fill is the venue-final IOC report cross-checked against the measured
 * position delta, else the measured delta (≥ 80%); anything unprovable is ORDER_PENDING.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified, rejectedLotSize, trimFirstLegToHedge } from "../../bot/perp-order.js";
import { PerpError } from "../../errors.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import { isPositionGone } from "../../bot/strategies/funding-arb-utils.js";

type Signed = number; // long > 0, short < 0

/**
 * Venue mock: `net` is the BTC position. `fill(side, size)` decides how much of each order
 * actually executes (default: all of it). `outcome` (optional) makes the adapter
 * IocOutcomeCapable and reports a venue-final filled size for each raw result.
 */
function venue(opts: {
  net?: Signed;
  fill?: (side: "buy" | "sell", size: number) => number;
  order?: (side: "buy" | "sell", size: string) => Promise<unknown>;
  outcome?: (raw: unknown) => { filledSize: string; final: true } | null;
  positionsError?: () => Error | null;
} = {}) {
  const state = { net: opts.net ?? 0 };
  const getPositions = vi.fn(async () => {
    const err = opts.positionsError?.();
    if (err) throw err;
    if (Math.abs(state.net) < 1e-12) return [];
    return [{ symbol: "BTC", side: state.net > 0 ? "long" : "short", size: String(Math.abs(state.net)), entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }];
  });
  const marketOrder = vi.fn(async (_sym: string, side: "buy" | "sell", size: string) => {
    if (opts.order) return opts.order(side, size);
    const q = opts.fill ? opts.fill(side, Number(size)) : Number(size);
    state.net += side === "buy" ? q : -q;
    return { filled: String(q) };
  });
  const adapter: Record<string, unknown> = { name: "hyperliquid", getPositions, marketOrder };
  if (opts.outcome) adapter.iocOutcomeOf = opts.outcome;
  return { adapter: adapter as unknown as ExchangeAdapter, state, getPositions, marketOrder };
}

const SLIP = { bps: 50, source: "default" as const };

/** Run a promise that may poll with real-time delays under fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("placePerpVerified — measured path (adapter reports no venue-final outcome)", () => {
  it("full fill: returns the measured position delta", async () => {
    const v = venue();
    const r = await placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP });
    expect(r.filledSize).toBeCloseTo(1, 12);
    expect(v.marketOrder).toHaveBeenCalledWith("BTC", "buy", "1", { reduceOnly: false, slippage: SLIP });
  });

  it("passes reduceOnly through to the venue order", async () => {
    const v = venue({ net: 2 });
    await placePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { reduceOnly: true, slippage: SLIP });
    expect(v.marketOrder).toHaveBeenCalledWith("BTC", "sell", "1", { reduceOnly: true, slippage: SLIP });
  });

  it("≥ 80% measured counts as filled (capped at the requested size)", async () => {
    const v = venue({ fill: (_s, q) => q * 0.85 });
    const r = await placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP });
    expect(r.filledSize).toBeCloseTo(0.85, 12);
  });

  it("acknowledged but the position never moves → ORDER_PENDING (never assumed filled)", async () => {
    vi.useFakeTimers();
    const v = venue({ fill: () => 0 });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP })).catch(e => e);
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).structured.code).toBe("ORDER_PENDING");
    expect(isOutcomeUnknown(err)).toBe(true);
  });

  it("an untyped error after which the position moved → filled (never read as a rejection)", async () => {
    const state = { net: 0 };
    const v = venue({ order: async (_side, size) => { state.net += Number(size); throw new Error("socket hang up"); } });
    v.getPositions.mockImplementation(async () => state.net === 0 ? [] : [{ symbol: "BTC", side: "long", size: String(state.net), entryPrice: "1", markPrice: "1", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }]);
    const r = await placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP });
    expect(r.filledSize).toBeCloseTo(1, 12);
    expect(r.raw).toBeNull();
  });

  it("a transport error with no movement → ORDER_PENDING", async () => {
    vi.useFakeTimers();
    const v = venue({ order: async () => { throw new Error("fetch failed"); } });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_PENDING");
  });

  it("a typed definite rejection is rethrown unchanged (nothing measured)", async () => {
    const rejection = new PerpError("INSUFFICIENT_BALANCE", "not enough margin");
    const v = venue({ order: async () => { throw rejection; } });
    await expect(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP })).rejects.toBe(rejection);
    expect(v.getPositions).toHaveBeenCalledTimes(1); // only the pre-order read
  });

  it("a local no-position refusal (POSITION_NOT_FOUND, details.sent false — QFEX) is definite: reduceOnlyFlat at once, no poll", async () => {
    const refusal = new PerpError("POSITION_NOT_FOUND", "QFEX AAPL-USD: no open position to reduce — the reduce-only order was not sent", { exchange: "qfex", sent: false });
    const v = venue({ net: 0, order: async () => { throw refusal; } });
    const err = await placePerpVerified(v.adapter, "qfex", "BTC", "sell", "1", { reduceOnly: true, slippage: SLIP }).catch(e => e); // real timers: nothing waits
    expect((err as PerpError).structured.code).toBe("ORDER_REJECTED");
    expect((err as PerpError).structured.details?.reduceOnlyFlat).toBe(true);
    expect(isOutcomeUnknown(err)).toBe(false); // callers do not quarantine
    expect(isPositionGone(err)).toBe(true);
    expect(v.getPositions).toHaveBeenCalledTimes(1); // only the pre-order read
  });

  it("a venue-side POSITION_NOT_FOUND without details.sent is NOT definite by its code (measured as before)", async () => {
    vi.useFakeTimers();
    const v = venue({ net: 1, order: async () => { throw new PerpError("POSITION_NOT_FOUND", "position not found"); } });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { reduceOnly: true, slippage: SLIP })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_PENDING");
    expect(v.getPositions.mock.calls.length).toBeGreaterThan(1);
  });

  it("reduce-only plain venue error with the position flat before AND after → ORDER_REJECTED (reduceOnlyFlat)", async () => {
    vi.useFakeTimers();
    const v = venue({ net: 0, order: async () => { throw new Error("Reduce only order would increase position"); } });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { reduceOnly: true, slippage: SLIP })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_REJECTED");
    expect((err as PerpError).structured.details?.reduceOnlyFlat).toBe(true);
  });

  it("reduce-only TRANSPORT error while flat stays ORDER_PENDING (post-send: cannot prove nothing happened)", async () => {
    vi.useFakeTimers();
    const v = venue({ net: 0, order: async () => { throw new Error("ETIMEDOUT"); } });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { reduceOnly: true, slippage: SLIP })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_PENDING");
  });

  it("plain lot-size rejection with no movement → ORDER_REJECTED carrying details.lotSize", async () => {
    vi.useFakeTimers();
    const v = venue({ order: async () => { throw new Error("Order size 0.15 is not a multiple of lot size 0.1"); } });
    const err = await settle(placePerpVerified(v.adapter, "pacifica", "BTC", "buy", "0.15", { slippage: SLIP })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_REJECTED");
    expect(rejectedLotSize(err)).toBe(0.1);
  });

  it("HL per-order status error in an 'ok' envelope → ORDER_REJECTED", async () => {
    const v = venue({ order: async () => ({ status: "ok", response: { data: { statuses: [{ error: "Insufficient margin" }] } } }) });
    await expect(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP }))
      .rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("pre-order position read failure → ORDER_REJECTED and NO order is sent", async () => {
    const v = venue({ positionsError: () => new Error("503") });
    await expect(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP }))
      .rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
    expect(v.marketOrder).not.toHaveBeenCalled();
  });

  it("non-positive size → INVALID_PARAMS before anything is read or sent", async () => {
    const v = venue();
    await expect(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "0", { slippage: SLIP }))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(v.getPositions).not.toHaveBeenCalled();
    expect(v.marketOrder).not.toHaveBeenCalled();
  });
});

describe("placePerpVerified — venue-final IOC outcome", () => {
  const reportsFilled = (raw: unknown) => ({ filledSize: (raw as { filled: string }).filled, final: true as const });

  it("venue-final PARTIAL fill agreeing with the delta → filledSize = the venue-reported size (no 80% rule)", async () => {
    const v = venue({ fill: (_s, q) => q * 0.3, outcome: reportsFilled });
    const r = await placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP, stepSize: "0.1" });
    expect(r.filledSize).toBeCloseTo(0.3, 12);
  });

  it("venue-final ZERO fill and the position did not move → ORDER_REJECTED (definite)", async () => {
    vi.useFakeTimers();
    const v = venue({ fill: () => 0, outcome: reportsFilled });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP, stepSize: "0.1" })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_REJECTED");
    expect((err as PerpError).message).toContain("venue-final");
  });

  it("venue-final zero but the position DID move → the measured delta is used", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const v = venue({ outcome: () => ({ filledSize: "0", final: true }) });
    const r = await placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP, stepSize: "0.1" });
    expect(r.filledSize).toBeCloseTo(1, 12);
    stderr.mockRestore();
  });

  it("venue-final fill that the position delta never confirms → ORDER_PENDING", async () => {
    vi.useFakeTimers();
    const v = venue({ fill: () => 0, outcome: () => ({ filledSize: "1", final: true }) });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP, stepSize: "0.1" })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_PENDING");
  });

  it("venue reports MORE than ordered → ORDER_PENDING (unusable report)", async () => {
    const v = venue({ outcome: () => ({ filledSize: "2", final: true }) });
    await expect(placePerpVerified(v.adapter, "hyperliquid", "BTC", "buy", "1", { slippage: SLIP, stepSize: "0.1" }))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });

  it("reduce-only venue-final zero while flat before and after → ORDER_REJECTED with reduceOnlyFlat", async () => {
    vi.useFakeTimers();
    const v = venue({ net: 0, fill: () => 0, outcome: reportsFilled });
    const err = await settle(placePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { reduceOnly: true, slippage: SLIP, stepSize: "0.1" })).catch(e => e);
    expect((err as PerpError).structured.code).toBe("ORDER_REJECTED");
    expect((err as PerpError).structured.details?.reduceOnlyFlat).toBe(true);
  });
});

describe("closePerpVerified — residual handling", () => {
  it("full close → residual 0, one order", async () => {
    const v = venue({ net: 1 });
    const r = await closePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { slippage: SLIP });
    expect(r).toEqual({ closed: 1, residual: 0, note: null });
    expect(v.marketOrder).toHaveBeenCalledTimes(1);
  });

  it("partial first close → ONE reduce-only market close of the measured residual", async () => {
    let calls = 0;
    const v = venue({ net: 1, fill: (_s, q) => (++calls === 1 ? q * 0.85 : q) });
    const r = await closePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { slippage: SLIP, decimals: 4 });
    expect(v.marketOrder).toHaveBeenCalledTimes(2);
    expect(v.marketOrder).toHaveBeenNthCalledWith(2, "BTC", "sell", "0.1500", { // floored to `decimals` (fillSizeString)
      reduceOnly: true, slippage: SLIP });
    expect(r.residual).toBe(0);
    expect(r.closed).toBeCloseTo(1, 9);
  });

  it("residual close that fails is REPORTED (residual > 0 + note), never retried again", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const v = venue({ net: 1, fill: (_s, q) => (++calls === 1 ? q * 0.85 : 0) });
    const r = await settle(closePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { slippage: SLIP, decimals: 4 }));
    expect(v.marketOrder).toHaveBeenCalledTimes(2);
    expect(r.residual).toBeCloseTo(0.15, 9);
    expect(r.note).toMatch(/residual close of 0\.1500 unconfirmed/);
  });

  it("first close outcome unknown → ORDER_PENDING propagates (caller quarantines)", async () => {
    vi.useFakeTimers();
    const v = venue({ net: 1, fill: () => 0 });
    const err = await settle(closePerpVerified(v.adapter, "hyperliquid", "BTC", "sell", "1", { slippage: SLIP })).catch(e => e);
    expect(isOutcomeUnknown(err)).toBe(true);
  });
});

describe("trimFirstLegToHedge", () => {
  it("reduces the first leg by exactly this trade's excess, reduce-only", async () => {
    const v = venue({ net: 1 });
    const excess = await trimFirstLegToHedge(v.adapter, "hyperliquid", "BTC", "buy", 1, 0.7, 4);
    expect(excess).toBe("0.3000"); // floored to 4 decimals
    expect(v.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.3000", { reduceOnly: true, slippage: expect.objectContaining({ bps: 50 }) });
  });

  it("legs already matched → '0', nothing sent", async () => {
    const v = venue({ net: 1 });
    await expect(trimFirstLegToHedge(v.adapter, "hyperliquid", "BTC", "buy", 1, 1, 4)).resolves.toBe("0");
    expect(v.marketOrder).not.toHaveBeenCalled();
  });
});
