/**
 * One market row, one value set: the keyless public row (venueMarketRow) carries the same
 * fundingRateKind and status the CLI adapters set (GRVT predicted, Extended accruing, Variational
 * predicted; the venue's listing status where it states one).
 */
import { describe, expect, it } from "vitest";
import { fundingRateKindOf, venueMarketRow, type VenueMarket } from "../../exchanges/venue-types.js";

const m = (venue: VenueMarket["venue"], extra: Partial<VenueMarket> = {}): VenueMarket => ({
  venue, venueSymbol: "BTC", symbol: "BTC", canonical: "BTC", assetClass: "crypto", settle: "USD", quoteAsset: "USD", markPrice: "1", indexPrice: null,
  fundingRate: "0.0001", fundingRateBasis: { kind: "perHours", hours: 1 }, settlementIntervalHours: 1, openInterest: null, volume24h: null,
  tickSize: null, stepSize: "0.001", minSize: null, minNotional: null, maxLeverage: null, marginTiers: null, session: null, tradable: true, ...extra,
});

describe("keyless row values = CLI row values", () => {
  it.each([["grvt", "predicted"], ["extended", "accruing"], ["variational", "predicted"], ["lighter", "lastSettled"], ["pacifica", "lastSettled"], ["hyperliquid", "accruing"]] as const)("%s fundingRateKind %s", (venue, kind) => {
    expect(fundingRateKindOf(venue, "0.0001")).toBe(kind);
    expect(fundingRateKindOf(venue, null)).toBeNull();
  });
  it("status is the venue's listing status when it states one, else null", () => {
    expect(venueMarketRow(m("extended", { status: "ACTIVE" })).status).toBe("ACTIVE");
    expect(venueMarketRow(m("ondo")).status).toBeNull();
    expect(venueMarketRow(m("ondo")).sizeDecimals).toBe(3);
  });
});
