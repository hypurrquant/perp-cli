import { describe, expect, it } from "vitest";
import { HyperliquidOutcomeAdapter } from "../../exchanges/hyperliquid-outcome.js";

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
});
