import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HyperliquidOutcomeAdapter } from "../../exchanges/hyperliquid-outcome.js";
import { PerpError } from "../../errors.js";

/**
 * Integration-style tests for `getView()` — the assembly of all 5
 * extracted helpers (`_computeUnderlying`, `_computeMidSum`,
 * `_computeTimeStatus`, `_assertOutcomeRange`, `_trimBook`) plus the
 * SDK call shape (`_infoPost`, `getOrderbook`).
 *
 * The 35 helper unit tests cover the math but cannot catch a regression
 * where Hyperliquid's `/info` payload shape changes (e.g. allMids keys
 * its prices differently, l2Book bids array format flips, outcomeMeta
 * loses a field). This file mocks `_infoPost` at the adapter level and
 * asserts the assembled `OutcomeView` against the expected shape.
 *
 * What is NOT covered here (out of scope for this file):
 *  - real network behavior (TLS / 5xx / 429) — failure-modes cycle
 *  - position fetching / placeOrder / cancelOrder — separate file
 */

type MockOutcomeMeta = {
  outcomes: Array<{
    outcome: number;
    name: string;
    description: string;
    sideSpecs: Array<{ name: string }>;
  }>;
  questions: unknown[];
};

const liveBtcBinaryMeta: MockOutcomeMeta = {
  outcomes: [
    {
      outcome: 2,
      name: "Recurring",
      description: "class:priceBinary|underlying:BTC|expiry:20260505-0600|targetPrice:79980|period:1d",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
    },
  ],
  questions: [],
};

function makeAdapter(opts?: { meta?: MockOutcomeMeta; allMids?: Record<string, string>; bookFor?: (coin: string) => unknown; }) {
  const hlStub = { isTestnet: false } as unknown as Parameters<typeof HyperliquidOutcomeAdapter.prototype.constructor>[0];
  const adapter = new HyperliquidOutcomeAdapter(hlStub as any);

  const meta = opts?.meta ?? liveBtcBinaryMeta;
  const allMids = opts?.allMids ?? {
    "#20": "0.965075",
    "#21": "0.034925",
    BTC: "80718.5",
  };
  // Hyperliquid `/info` l2Book response shape:
  //   { coin, time, levels: [bidsObjArr, asksObjArr] }
  // where each level is { px: string, sz: string }.
  const bookFor = opts?.bookFor ?? ((coin: string) => {
    if (coin === "#20") return {
      coin, time: 1_700_000_000_000,
      levels: [
        [{ px: "0.96", sz: "10" }, { px: "0.95", sz: "5" }],
        [{ px: "0.97", sz: "8" }, { px: "0.98", sz: "12" }],
      ],
    };
    if (coin === "#21") return {
      coin, time: 1_700_000_000_000,
      levels: [
        [{ px: "0.03", sz: "10" }, { px: "0.02", sz: "5" }],
        [{ px: "0.04", sz: "8" }, { px: "0.05", sz: "12" }],
      ],
    };
    return { coin, time: 0, levels: [[], []] };
  });

  vi.spyOn(adapter as any, "_infoPost").mockImplementation(async (body: any) => {
    if (body.type === "outcomeMeta") return meta;
    if (body.type === "allMids") return allMids;
    if (body.type === "l2Book") return bookFor(body.coin);
    throw new Error(`Unexpected _infoPost call: ${JSON.stringify(body)}`);
  });

  return adapter;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin clock to one minute before the BTC binary expiry so msToExpiry
  // is deterministic across re-runs (60_000 ms).
  vi.setSystemTime(new Date(Date.UTC(2026, 4, 5, 5, 59, 0)));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HyperliquidOutcomeAdapter.getView — integration with mocked SDK", () => {
  it("assembles OutcomeView from outcomeMeta + allMids + l2Book responses", async () => {
    const adapter = makeAdapter();
    const view = await adapter.getView(2, 3);

    expect(view.outcome).toBe(2);
    expect(view.name).toBe("Recurring");
    expect(view.class).toBe("priceBinary");
    expect(view.period).toBe("1d");
    expect(view.expiryMs).toBe(Date.UTC(2026, 4, 5, 6, 0));
    expect(view.msToExpiry).toBe(60_000);
    expect(view.serverTime).toBe(Date.UTC(2026, 4, 5, 5, 59, 0));

    // Underlying — composed from _computeUnderlying
    expect(view.underlying).not.toBeNull();
    expect(view.underlying!.symbol).toBe("BTC");
    expect(view.underlying!.markPrice).toBe("80718.5");
    expect(view.underlying!.gap).toBeCloseTo(738.5, 6);
    expect(view.underlying!.inTheMoney).toBe("yes");

    // Sides — composed from _trimBook + side metadata
    expect(view.sides).toHaveLength(2);
    expect(view.sides[0].name).toBe("Yes");
    expect(view.sides[0].encoding).toBe(20);
    expect(view.sides[0].assetId).toBe(100_000_020);
    expect(view.sides[0].mid).toBe("0.965075");
    expect(view.sides[0].impliedProb).toBeCloseTo(0.965075, 6);
    expect(view.sides[0].bestBid).toBe("0.96");
    expect(view.sides[0].bestAsk).toBe("0.97");
    expect(view.sides[1].name).toBe("No");
    expect(view.sides[1].encoding).toBe(21);

    // midSum — composed from _computeMidSum
    expect(view.midSum).toBeCloseTo(1.0, 4);
  });

  it("propagates depth into bids/asks length", async () => {
    const adapter = makeAdapter();
    const view = await adapter.getView(2, 1);
    expect(view.sides[0].bids).toHaveLength(1);
    expect(view.sides[0].asks).toHaveLength(1);
  });

  it("throws SYMBOL_NOT_FOUND for unknown outcome id", async () => {
    const adapter = makeAdapter();
    await expect(adapter.getView(999, 3)).rejects.toThrow(PerpError);
    await expect(adapter.getView(999, 3)).rejects.toThrow(/Unknown outcome id/);
  });

  it("throws EXCHANGE_ERROR when outcomeMeta payload shape changes (no `outcomes` field)", async () => {
    const adapter = makeAdapter({
      meta: { questions: [] } as unknown as MockOutcomeMeta,
    });
    await expect(adapter.getView(2, 3)).rejects.toThrow(/outcomeMeta returned unexpected shape/);
  });

  it("returns gap/inTheMoney undefined/null when allMids drops the underlying perp symbol", async () => {
    // Simulates an allMids snapshot where BTC perp price is briefly
    // absent (HL has had momentary cache misses on rare symbols).
    const adapter = makeAdapter({
      allMids: { "#20": "0.5", "#21": "0.5" }, // no BTC entry
    });
    const view = await adapter.getView(2, 3);
    expect(view.underlying).not.toBeNull();
    expect(view.underlying!.markPrice).toBeUndefined();
    expect(view.underlying!.gap).toBeUndefined();
    expect(view.underlying!.gapPct).toBeUndefined();
    expect(view.underlying!.inTheMoney).toBeNull();
  });

  it("returns midSum undefined when allMids drops a side's encoding", async () => {
    // Simulates allMids missing one side's mint coin — _computeMidSum
    // must refuse to fabricate a sum (Rule #2).
    const adapter = makeAdapter({
      allMids: { "#20": "0.5", BTC: "80000" }, // missing #21
    });
    const view = await adapter.getView(2, 3);
    expect(view.sides[0].mid).toBe("0.5");
    expect(view.sides[1].mid).toBeUndefined();
    expect(view.midSum).toBeUndefined();
  });

  it("throws EXCHANGE_ERROR when l2Book omits `levels` (Rule #2 — no fabricated empty book)", async () => {
    // Pinned regression for the silent fallback at getOrderbook line 419
    // (`book?.levels ?? [[], []]`) which used to mask a malformed venue
    // payload as an empty book. Now throws so the caller can react.
    const adapter = makeAdapter({
      bookFor: (coin) => ({ coin, time: 0 }), // `levels` field missing
    });
    await expect(adapter.getView(2, 3)).rejects.toThrow(/malformed payload/);
  });

  it("throws EXCHANGE_ERROR when l2Book `levels` is not a tuple of two arrays", async () => {
    const adapter = makeAdapter({
      bookFor: (coin) => ({ coin, time: 0, levels: [[]] }), // length 1 instead of 2
    });
    await expect(adapter.getView(2, 3)).rejects.toThrow(/malformed payload/);
  });
});
