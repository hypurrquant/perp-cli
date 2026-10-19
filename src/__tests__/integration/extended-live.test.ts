/**
 * Live, read-only checks (gated): PERP_EXTENDED_LIVE=1. Extended public reads on mainnet and
 * testnet (Sepolia) still parse; funding is still a fraction per hour with the documented interest
 * baseline; the applied-funding history is hourly. Nothing is signed or sent.
 */
import { describe, it, expect } from "vitest";
import "../../exchanges/venues/index.js";
import { getVenue } from "../../exchanges/venue.js";
import { ExtendedPublicAdapter } from "../../exchanges/extended/adapter.js";
import { fetchExtendedFundingRates, fetchExtendedMarkets } from "../../exchanges/extended/public.js";

describe.skipIf(process.env.PERP_EXTENDED_LIVE !== "1")("Extended live public reads", () => {
  for (const net of ["mainnet", "testnet"] as const) {
    it(`${net}: markets, funding, book, trades, funding history`, async () => {
      const markets = await fetchExtendedMarkets(net);
      expect(markets.length).toBeGreaterThan(net === "mainnet" ? 100 : 1);
      const btc = markets.find(m => m.symbol === "BTC");
      expect(btc).toBeDefined();
      expect(btc!.fundingRateBasis).toEqual({ kind: "perHours", hours: 1 });
      const rates = await fetchExtendedFundingRates(net);
      expect(rates.length).toBeGreaterThan(0);
      if (net === "mainnet") {
        // A fraction per hour (not percent): every rate is far below 1 %/h, and the crypto
        // interest baseline 0.01 %/8 h ("0.000013") is common.
        for (const r of rates) expect(Math.abs(Number(r.rate))).toBeLessThan(0.02);
        expect(rates.filter(r => r.rate === "0.000013").length).toBeGreaterThan(10);
      }
      const a = new ExtendedPublicAdapter(getVenue("extended"), net);
      // Parses on both networks; the Sepolia book can be empty (bid / ask "0" on 2026-10-19).
      const book = await a.getOrderbook("BTC");
      if (net === "mainnet") {
        expect(book.bids.length + book.asks.length).toBeGreaterThan(0);
        expect((await a.getRecentTrades("BTC", 5)).length).toBeGreaterThan(0);
        const h = await a.getFundingHistory("BTC", 4);
        expect(h.length).toBeGreaterThan(1);
        expect(Math.round((h[0].time - h[1].time) / 3_600_000)).toBe(1);
      }
    });
  }
});
