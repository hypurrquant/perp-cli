/**
 * CLI ⇄ WS directory parity (HypurrQuant_FE parity check + perp-ws QA, 0.15.0):
 *  N/E. Aster: the WS directory had no status filter — 23 SETTLING perps and 6 PENDING_TRADING rows
 *       (contractType "", e.g. MBLUSDT, which never emits) streamed while the CLI lists PERPETUAL +
 *       TRADING only. One helper (isAsterListedPerpetual) now decides for both.
 *  O/A. Arcus: OFFLINE markets (F, BAC, CCL, VT, SGOV, RVI-USD) streamed placeholder "0" values;
 *       they are not in the WS directory, as in the CLI (isArcusOnlineMarket).
 *  E.  Canonical-null rows (Aster BTCU / BTCUSD1) are never "did you mean" candidates for BTC.
 * Rows: the live /fapi/v3/exchangeInfo and /v1/markets shapes (2026-10-19).
 */
import { describe, it, expect } from "vitest";
import { createVenueStream, suggestSymbols } from "../../ws/stream.js";
import { aster } from "../../ws/codecs/aster.js";
import { arcus } from "../../ws/codecs/arcus.js";
import { isAsterListedPerpetual } from "../../ws/aster-market.js";
import { isArcusOnlineMarket } from "../../ws/arcus-market.js";
import { onlineArcusMarkets } from "../../exchanges/arcus/public.js";
import { ASTER_ROUTES, ARCUS_ROUTES, fakeFetch, fakeTransport } from "./helpers.js";

describe("Aster directory eligibility (shared with the CLI adapter)", () => {
  it("SETTLING and PENDING_TRADING / contractType \"\" rows are not listed", () => {
    expect(isAsterListedPerpetual({ contractType: "PERPETUAL", status: "TRADING" })).toBe(true);
    expect(isAsterListedPerpetual({ contractType: "PERPETUAL", status: "SETTLING" })).toBe(false);
    expect(isAsterListedPerpetual({ contractType: "", status: "PENDING_TRADING" })).toBe(false);
  });

  it("WS markets() leaves TONUSDT (SETTLING) and MBLUSDT (PENDING_TRADING) out", async () => {
    const s = createVenueStream(aster, { transport: fakeTransport().factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null });
    const syms = (await s.markets()).map(e => e.symbol);
    expect(syms).toContain("BTCUSDT");
    expect(syms).not.toContain("TONUSDT");
    expect(syms).not.toContain("MBLUSDT");
    await s.close();
  });
});

describe("Arcus directory eligibility (shared with the CLI)", () => {
  it("OFFLINE markets are not in the WS directory nor the CLI list", async () => {
    const s = createVenueStream(arcus, { transport: fakeTransport().factory, fetch: fakeFetch(ARCUS_ROUTES), visibility: null });
    const syms = (await s.markets()).map(e => e.symbol);
    expect(syms).toEqual(["BTC-USD", "ETH-USD", "MSFT-USD"]);
    await s.close();
    const raw = (ARCUS_ROUTES["GET https://api.arcus.xyz/v1/markets"] as { markets: Array<{ status: string; marketDisplayName: string }> }).markets;
    expect(onlineArcusMarkets(raw as never).map(m => (m as { marketDisplayName: string }).marketDisplayName)).toEqual(syms);
    expect(isArcusOnlineMarket({ status: "OFFLINE" })).toBe(false);
  });
});

describe("did-you-mean suggestions skip canonical-null rows", () => {
  it("BTC suggests BTCUSDT, not BTCU / BTCUSD1", () => {
    const entries = [
      { symbol: "BTCUSDT", canonical: "BTC", base: "BTC" },
      { symbol: "BTCU", canonical: null, base: "BTC" },
      { symbol: "BTCUSD1", canonical: null, base: "BTC" },
    ];
    expect(suggestSymbols("BTC", entries)).toEqual(["BTCUSDT"]);
    expect(suggestSymbols("btcu", entries)).toEqual(["BTCU"]); // its own symbol still matches
  });
});
