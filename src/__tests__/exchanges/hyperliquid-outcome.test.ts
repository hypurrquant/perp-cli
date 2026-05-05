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

    it("throws PerpError when venue embeds an error in statuses[0] despite top-level status:ok", () => {
      const result = {
        status: "ok",
        response: { type: "order", data: { statuses: [{ error: "Insufficient USDH balance" }] } },
      };
      expect(() => HyperliquidOutcomeAdapter._assertOrderStatusOk(result)).toThrow(PerpError);
      try {
        HyperliquidOutcomeAdapter._assertOrderStatusOk(result);
      } catch (e) {
        const err = e as PerpError;
        expect(err.structured.code).toBe("EXCHANGE_ERROR");
        expect(err.message).toContain("Insufficient USDH balance");
      }
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
