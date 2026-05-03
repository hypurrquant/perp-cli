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
