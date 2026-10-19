import { describe, expect, it } from "vitest";
import { HyperliquidOutcomeAdapter } from "../../exchanges/hyperliquid-outcome.js";
import { PerpError } from "../../errors.js";

describe("HyperliquidOutcomeAdapter — pure helpers", () => {
  describe("encoding & assetId", () => {
    it("encodes per HIP-4 formula 10*outcome + side", () => {
      expect(HyperliquidOutcomeAdapter.encoding(0, 0)).toBe(0);
      expect(HyperliquidOutcomeAdapter.encoding(1, 0)).toBe(10);
      expect(HyperliquidOutcomeAdapter.encoding(1, 1)).toBe(11);
      expect(HyperliquidOutcomeAdapter.encoding(7, 3)).toBe(73);
    });

    it("derives asset id from offset 100,000,000 + encoding", () => {
      expect(HyperliquidOutcomeAdapter.assetId(0, 0)).toBe(100_000_000);
      expect(HyperliquidOutcomeAdapter.assetId(1, 0)).toBe(100_000_010);
      expect(HyperliquidOutcomeAdapter.assetId(1, 1)).toBe(100_000_011);
    });
  });

  describe("coin name conventions", () => {
    it("renders mint-style coin (l2Book/candle/allMids) with `#` prefix", () => {
      expect(HyperliquidOutcomeAdapter.mintCoin(1, 0)).toBe("#10");
      expect(HyperliquidOutcomeAdapter.mintCoin(1, 1)).toBe("#11");
    });

    it("renders balance coin (spotClearinghouseState) with `+` prefix", () => {
      expect(HyperliquidOutcomeAdapter.balanceCoin(1, 0)).toBe("+10");
      expect(HyperliquidOutcomeAdapter.balanceCoin(1, 1)).toBe("+11");
    });

    it("decodes balance coin back to (outcome, side)", () => {
      expect(HyperliquidOutcomeAdapter.decodeBalanceCoin("+10")).toEqual({ outcome: 1, side: 0 });
      expect(HyperliquidOutcomeAdapter.decodeBalanceCoin("+11")).toEqual({ outcome: 1, side: 1 });
      expect(HyperliquidOutcomeAdapter.decodeBalanceCoin("+73")).toEqual({ outcome: 7, side: 3 });
    });

    it("returns null for non-outcome balance coin names", () => {
      expect(HyperliquidOutcomeAdapter.decodeBalanceCoin("USDC")).toBeNull();
      expect(HyperliquidOutcomeAdapter.decodeBalanceCoin("USDH")).toBeNull();
      expect(HyperliquidOutcomeAdapter.decodeBalanceCoin("#10")).toBeNull(); // mint prefix, not balance prefix
      expect(HyperliquidOutcomeAdapter.decodeBalanceCoin("+abc")).toBeNull();
    });
  });

  describe("parseDescription", () => {
    it("parses the live BTC binary outcome description", () => {
      const parsed = HyperliquidOutcomeAdapter.parseDescription(
        "class:priceBinary|underlying:BTC|expiry:20260504-0600|targetPrice:78213|period:1d",
      );
      expect(parsed.class).toBe("priceBinary");
      expect(parsed.underlying).toBe("BTC");
      expect(parsed.targetPrice).toBe(78213);
      expect(parsed.period).toBe("1d");
      expect(parsed.expiryMs).toBe(Date.UTC(2026, 4, 4, 6, 0));
    });

    it("returns partial struct when fields missing", () => {
      const parsed = HyperliquidOutcomeAdapter.parseDescription("class:priceBinary|underlying:BTC");
      expect(parsed.class).toBe("priceBinary");
      expect(parsed.underlying).toBe("BTC");
      expect(parsed.expiryMs).toBeUndefined();
      expect(parsed.targetPrice).toBeUndefined();
      expect(parsed.period).toBeUndefined();
    });

    it("ignores malformed expiry strings instead of throwing", () => {
      const parsed = HyperliquidOutcomeAdapter.parseDescription("expiry:not-a-date");
      expect(parsed.expiryMs).toBeUndefined();
    });

    it("returns empty struct for empty / non-keyed description", () => {
      expect(HyperliquidOutcomeAdapter.parseDescription("")).toEqual({});
      expect(HyperliquidOutcomeAdapter.parseDescription("plain text without colons")).toEqual({});
    });
  });

  describe("_assertOrderStatusOk — venue rejection surfacing (Rule #2)", () => {
    it("passes silently for resting status", () => {
      expect(() => HyperliquidOutcomeAdapter._assertOrderStatusOk({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } },
      })).not.toThrow();
    });

    it("passes silently for filled status", () => {
      expect(() => HyperliquidOutcomeAdapter._assertOrderStatusOk({
        status: "ok",
        response: { type: "order", data: { statuses: [{ filled: { oid: 1, totalSz: "10", avgPx: "0.5" } }] } },
      })).not.toThrow();
    });

    it("a per-entry insufficient-balance error inside status:ok → definite INSUFFICIENT_BALANCE (live 2026-10-12)", () => {
      const result = {
        status: "ok",
        response: { type: "order", data: { statuses: [{ error: "Insufficient spot balance asset=100014881" }] } },
      };
      let err: PerpError | null = null;
      try { HyperliquidOutcomeAdapter._assertOrderStatusOk(result); } catch (e) { err = e as PerpError; }
      expect(err).toBeInstanceOf(PerpError);
      expect(err!.structured).toMatchObject({ code: "INSUFFICIENT_BALANCE", retryable: false });
      expect(err!.message).toContain("Insufficient spot balance asset=100014881");
    });

    it("any other per-entry error → ORDER_REJECTED (never retryable EXCHANGE_ERROR)", () => {
      let err: PerpError | null = null;
      try {
        HyperliquidOutcomeAdapter._assertOrderStatusOk({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order must have minimum value of 10 USDC." }] } } });
      } catch (e) { err = e as PerpError; }
      expect(err!.structured).toMatchObject({ code: "ORDER_REJECTED", retryable: false });
    });

    it("throws PerpError on missing/empty statuses array", () => {
      expect(() => HyperliquidOutcomeAdapter._assertOrderStatusOk({})).toThrow(PerpError);
      expect(() => HyperliquidOutcomeAdapter._assertOrderStatusOk({ response: { data: { statuses: [] } } })).toThrow(PerpError);
    });
  });

  describe("_computeUnderlying — outcome view settlement status (Rule #2)", () => {
    it("returns null when description has no underlying field", () => {
      expect(HyperliquidOutcomeAdapter._computeUnderlying({}, {})).toBeNull();
      expect(HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceBinary", targetPrice: 100 },
        { BTC: "100" },
      )).toBeNull();
    });

    it("classifies priceBinary in-the-money when mark > target", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceBinary", underlying: "BTC", targetPrice: 79980 },
        { BTC: "80718.5" },
      );
      expect(u).not.toBeNull();
      expect(u!.inTheMoney).toBe("yes");
      expect(u!.gap).toBeCloseTo(738.5, 6);
      expect(u!.gapPct).toBeCloseTo(0.9233558, 5);
      expect(u!.markPrice).toBe("80718.5");
      expect(u!.targetPrice).toBe(79980);
    });

    it("classifies priceBinary out-of-the-money when mark < target", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceBinary", underlying: "BTC", targetPrice: 90000 },
        { BTC: "80000" },
      );
      expect(u!.inTheMoney).toBe("no");
      expect(u!.gap).toBe(-10000);
      expect(u!.gapPct).toBeCloseTo(-11.1111, 3);
    });

    it("classifies priceBinary as 'yes' when gap is exactly 0 (Yes = mark >= target)", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceBinary", underlying: "ETH", targetPrice: 3000 },
        { ETH: "3000" },
      );
      expect(u!.inTheMoney).toBe("yes");
      expect(u!.gap).toBe(0);
      expect(u!.gapPct).toBe(0);
    });

    it("leaves inTheMoney null for non-priceBinary class — gap still computed, classification suppressed", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceRange", underlying: "BTC", targetPrice: 80000 },
        { BTC: "85000" },
      );
      expect(u!.inTheMoney).toBeNull();
      expect(u!.gap).toBe(5000);
      expect(u!.gapPct).toBeCloseTo(6.25, 6);
    });

    it("leaves inTheMoney null when class is missing entirely (Rule #2 — no guessing)", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { underlying: "BTC", targetPrice: 80000 },
        { BTC: "85000" },
      );
      expect(u!.inTheMoney).toBeNull();
      expect(u!.gap).toBe(5000);
    });

    it("leaves gap/gapPct undefined when mark price is missing for the symbol", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceBinary", underlying: "FOO", targetPrice: 100 },
        { BTC: "80000" },
      );
      expect(u!.markPrice).toBeUndefined();
      expect(u!.gap).toBeUndefined();
      expect(u!.gapPct).toBeUndefined();
      expect(u!.inTheMoney).toBeNull();
    });

    it("leaves gap/gapPct undefined when targetPrice is missing", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceBinary", underlying: "BTC" },
        { BTC: "80000" },
      );
      expect(u!.markPrice).toBe("80000");
      expect(u!.gap).toBeUndefined();
      expect(u!.gapPct).toBeUndefined();
      expect(u!.inTheMoney).toBeNull();
    });

    it("uppercases the underlying symbol before allMids lookup", () => {
      const u = HyperliquidOutcomeAdapter._computeUnderlying(
        { class: "priceBinary", underlying: "btc", targetPrice: 80000 },
        { BTC: "85000" },
      );
      expect(u!.symbol).toBe("BTC");
      expect(u!.source).toBe("BTC");
      expect(u!.markPrice).toBe("85000");
      expect(u!.inTheMoney).toBe("yes");
    });
  });

  describe("_computeMidSum — symmetry invariant for binary outcomes", () => {
    it("sums impliedProb across all sides when each side has a finite probability", () => {
      // Healthy binary market: mids ≈ 1.0 in total
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: 0.965 },
        { impliedProb: 0.034 },
      ])).toBeCloseTo(0.999, 3);
    });

    it("returns undefined when even one side is missing impliedProb", () => {
      // Half-loaded view shouldn't claim a sum — would mislead arb scanners
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: 0.5 },
        { impliedProb: undefined },
      ])).toBeUndefined();
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: undefined },
        { impliedProb: 0.5 },
      ])).toBeUndefined();
    });

    it("returns undefined when any side has a non-finite impliedProb (NaN / Infinity)", () => {
      // Defends against `Number(mid)` producing NaN from a malformed venue payload
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: NaN },
        { impliedProb: 0.5 },
      ])).toBeUndefined();
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: 0.5 },
        { impliedProb: Infinity },
      ])).toBeUndefined();
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: -Infinity },
        { impliedProb: 0.5 },
      ])).toBeUndefined();
    });

    it("returns undefined for an empty side list (no inference from no data)", () => {
      expect(HyperliquidOutcomeAdapter._computeMidSum([])).toBeUndefined();
    });

    it("preserves arithmetic faithfully — sum can be < 1 (unfilled book) or > 1 (crossed)", () => {
      // _computeMidSum is a pure aggregator; classification (fair / arb /
      // suspicious) is the caller's responsibility, not this helper's.
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: 0.4 },
        { impliedProb: 0.4 },
      ])).toBeCloseTo(0.8, 6);
      expect(HyperliquidOutcomeAdapter._computeMidSum([
        { impliedProb: 0.6 },
        { impliedProb: 0.6 },
      ])).toBeCloseTo(1.2, 6);
    });
  });

  describe("_computeTimeStatus — deterministic clock for outcome view", () => {
    const EXPIRY = Date.UTC(2026, 4, 5, 6, 0); // 2026-05-05 06:00 UTC (live BTC binary)

    it("returns positive msToExpiry when now is before expiry", () => {
      const now = EXPIRY - 60_000;
      const r = HyperliquidOutcomeAdapter._computeTimeStatus(EXPIRY, now);
      expect(r.serverTime).toBe(now);
      expect(r.msToExpiry).toBe(60_000);
    });

    it("returns msToExpiry === 0 exactly at expiry (edge of settlement)", () => {
      const r = HyperliquidOutcomeAdapter._computeTimeStatus(EXPIRY, EXPIRY);
      expect(r.msToExpiry).toBe(0);
    });

    it("returns negative msToExpiry after expiry — caller decides expired UX (Rule #2)", () => {
      // Deliberately does NOT clamp to 0 or treat as expired here; that
      // classification belongs to the consumer (CLI / view renderer).
      const now = EXPIRY + 5_000;
      const r = HyperliquidOutcomeAdapter._computeTimeStatus(EXPIRY, now);
      expect(r.msToExpiry).toBe(-5_000);
    });

    it("returns msToExpiry undefined when expiry is unknown", () => {
      const now = Date.UTC(2026, 4, 5);
      const r = HyperliquidOutcomeAdapter._computeTimeStatus(undefined, now);
      expect(r.serverTime).toBe(now);
      expect(r.msToExpiry).toBeUndefined();
    });
  });

  describe("_assertOutcomeRange — pure (outcome, side) gate (Rule #2)", () => {
    it("accepts the valid (outcome, side) range without throwing", () => {
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(0, 0)).not.toThrow();
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(1, 0)).not.toThrow();
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(1, 9)).not.toThrow();
      // boundary: outcome=9_999_999, side=9 → encoding=99_999_999 = MAX_ENCODING
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(9_999_999, 9)).not.toThrow();
    });

    it("rejects outcome that is NaN / non-integer / negative — previously could pass silently", () => {
      // Each of these would slip through the old `encoding > MAX_ENCODING`
      // post-check because Number.isInteger(NaN)=false; without the
      // pre-check `encoding = NaN` and the comparison was always false.
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(NaN, 0)).toThrow(PerpError);
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(-1, 0)).toThrow(PerpError);
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(0.5, 0)).toThrow(PerpError);
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(Infinity, 0)).toThrow(PerpError);
    });

    it("rejects side outside 0..9 — encoding scheme is single digit", () => {
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(1, 10)).toThrow(/Side must be an integer/);
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(1, -1)).toThrow(/Side must be an integer/);
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(1, NaN)).toThrow(/Side must be an integer/);
      expect(() => HyperliquidOutcomeAdapter._assertOutcomeRange(1, 1.5)).toThrow(/Side must be an integer/);
    });

    it("rejects encoding overflow (outcome=10_000_000, side=0 → encoding=100_000_000)", () => {
      try {
        HyperliquidOutcomeAdapter._assertOutcomeRange(10_000_000, 0);
        expect.fail("expected to throw");
      } catch (e) {
        const err = e as PerpError;
        expect(err.structured.code).toBe("INVALID_PARAMS");
        expect(err.message).toMatch(/Encoding 100000000 overflows/);
      }
    });
  });

  describe("_trimBook — depth + malformed-payload gate (Rule #2)", () => {
    const book = {
      bids: [
        ["0.96", "10"],
        ["0.95", "20"],
        ["0.94", "30"],
      ] as [string, string][],
      asks: [
        ["0.97", "5"],
        ["0.98", "15"],
      ] as [string, string][],
    };

    it("trims to the requested depth and surfaces best bid/ask", () => {
      const r = HyperliquidOutcomeAdapter._trimBook(book, 2);
      expect(r.bids).toEqual([["0.96", "10"], ["0.95", "20"]]);
      expect(r.asks).toEqual([["0.97", "5"], ["0.98", "15"]]);
      expect(r.bestBid).toBe("0.96");
      expect(r.bestAsk).toBe("0.97");
    });

    it("depth=0 returns empty bids/asks and undefined best prices", () => {
      const r = HyperliquidOutcomeAdapter._trimBook(book, 0);
      expect(r.bids).toEqual([]);
      expect(r.asks).toEqual([]);
      expect(r.bestBid).toBeUndefined();
      expect(r.bestAsk).toBeUndefined();
    });

    it("depth larger than book length returns the full book — no padding, no error", () => {
      const r = HyperliquidOutcomeAdapter._trimBook(book, 9999);
      expect(r.bids).toHaveLength(3);
      expect(r.asks).toHaveLength(2);
    });

    it("rejects negative depth — previously slice(0, -1) silently dropped the last entry", () => {
      expect(() => HyperliquidOutcomeAdapter._trimBook(book, -1)).toThrow(/Depth must be a non-negative integer/);
    });

    it("rejects NaN / Infinity / fractional depth (caller bug, not a venue issue)", () => {
      expect(() => HyperliquidOutcomeAdapter._trimBook(book, NaN)).toThrow(/Depth must be a non-negative integer/);
      expect(() => HyperliquidOutcomeAdapter._trimBook(book, Infinity)).toThrow(/Depth must be a non-negative integer/);
      expect(() => HyperliquidOutcomeAdapter._trimBook(book, 1.5)).toThrow(/Depth must be a non-negative integer/);
    });

    it("throws EXCHANGE_ERROR when the venue payload is missing bids or asks (Rule #2: don't fabricate empty book)", () => {
      try {
        HyperliquidOutcomeAdapter._trimBook({ bids: undefined, asks: book.asks } as any, 5);
        expect.fail("expected to throw");
      } catch (e) {
        const err = e as PerpError;
        expect(err.structured.code).toBe("EXCHANGE_ERROR");
        expect(err.message).toMatch(/missing bids\/asks/);
      }
      expect(() => HyperliquidOutcomeAdapter._trimBook(null as any, 5)).toThrow(/missing bids\/asks/);
      expect(() => HyperliquidOutcomeAdapter._trimBook({ bids: [], asks: null } as any, 5)).toThrow(/missing bids\/asks/);
    });

    it("empty book returns empty arrays and undefined best prices", () => {
      const r = HyperliquidOutcomeAdapter._trimBook({ bids: [], asks: [] }, 10);
      expect(r.bids).toEqual([]);
      expect(r.asks).toEqual([]);
      expect(r.bestBid).toBeUndefined();
      expect(r.bestAsk).toBeUndefined();
    });
  });

  describe("_assertCancelStatusOk", () => {
    it("passes for 'success' status string", () => {
      expect(() => HyperliquidOutcomeAdapter._assertCancelStatusOk({
        status: "ok",
        response: { type: "cancel", data: { statuses: ["success"] } },
      })).not.toThrow();
    });

    it("throws when statuses[0] is an error object", () => {
      expect(() => HyperliquidOutcomeAdapter._assertCancelStatusOk({
        status: "ok",
        response: { type: "cancel", data: { statuses: [{ error: "Order already filled" }] } },
      })).toThrow(PerpError);
    });
  });
});

describe("HyperliquidOutcomeAdapter — per-outcome quote token", () => {
  type Meta = { outcomes: Array<Record<string, unknown>>; questions: unknown[] };
  function adapter(meta: Meta, balances: Array<Record<string, unknown>>) {
    const exchangeAction = async () => ({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } });
    const hl = { address: "0xabc", isTestnet: false, exchangeAction } as never;
    const a = new HyperliquidOutcomeAdapter(hl);
    const h = a as unknown as Record<string, unknown>;
    h._outcomeMeta = meta;
    h._initialized = true;
    h._invalidateAccountCache = async () => {};
    h._infoPost = async (body: { type: string }) => body.type === "spotClearinghouseState" ? { balances } : {};
    return a;
  }
  const meta = (quoteToken: unknown): Meta => ({
    outcomes: [{ outcome: 1488, name: "x", description: "", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken, venue: "out" }],
    questions: [],
  });

  it("quoteTokenOf reads outcomeMeta quoteToken; missing → EXCHANGE_ERROR; unknown outcome → SYMBOL_NOT_FOUND", () => {
    expect(adapter(meta("USDC"), []).quoteTokenOf(1488)).toBe("USDC");
    expect(() => adapter(meta(undefined), []).quoteTokenOf(1488)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
    expect(() => adapter(meta("USDC"), []).quoteTokenOf(7)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }) }));
  });

  it("buy pre-check uses the outcome's quote token balance (USDC), not USDH", async () => {
    const usdhOnly = adapter(meta("USDC"), [{ coin: "USDH", total: "11.39", hold: "0" }, { coin: "USDC", total: "2.1", hold: "0" }]);
    await expect(usdhOnly.placeOrder({ outcome: 1488, side: 0, isBuy: true, price: "0.5", size: "22" }))
      .rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" }, message: expect.stringContaining("Insufficient USDC") });
    const usdc = adapter(meta("USDC"), [{ coin: "USDC", total: "12", hold: "0" }]);
    await expect(usdc.placeOrder({ outcome: 1488, side: 0, isBuy: true, price: "0.5", size: "22" })).resolves.toBeDefined();
  });

  it("minimum order value is 10 of the quote token", async () => {
    await expect(adapter(meta("USDC"), []).placeOrder({ outcome: 1488, side: 0, isBuy: false, price: "0.5", size: "10" }))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" }, message: expect.stringContaining("10 USDC") });
  });
});

describe("HIP-4 template outcomes (QA 0.15.0)", () => {
  it("a template:binaryPrice description (live) yields underlying, threshold and time", async () => {
    const { HyperliquidOutcomeAdapter } = await import("../../exchanges/hyperliquid-outcome.js");
    const p = HyperliquidOutcomeAdapter.parseDescription("perp:ZEC|priceDescription:the Pyth ZEC/USD price|seconds:90|threshold:1057|time:20261023-0800");
    expect(p).toEqual({ underlying: "ZEC", targetPrice: 1057, expiryMs: Date.UTC(2026, 9, 23, 8, 0) });
    const u = HyperliquidOutcomeAdapter._computeUnderlying({ ...p, class: "priceBinary" }, { ZEC: "1100" });
    expect(u).toMatchObject({ symbol: "ZEC", markPrice: "1100", targetPrice: 1057, inTheMoney: "yes" });
  });
});
