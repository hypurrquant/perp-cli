/**
 * QFEX current funding rate (fetchFundingRates → funding/rates.ts → arb scan, `perp funding`,
 * saveFundingSnapshot, averages): a market outside its funding hours is `rate: null,
 * marketClosed: true` (the venue's 0 there is "no funding"), and the aggregated rates skip it.
 * Real /refdata + /md/contracts captured 2026-10-19T11:27:45Z (Mon 20:27 KST / 07:27 ET).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildQfexFundingRates, toQfexInstrument } from "../../exchanges/qfex/public.js";
import { fetchVenuesRates } from "../../funding/rates.js";
import type { VenueDefinition } from "../../exchanges/venue.js";
import type { QfexContractRow } from "../../exchanges/qfex/public.js";

const NOW = JSON.parse(readFileSync(new URL("../fixtures/qfex/funding-now-2026-10-19T1127Z.json", import.meta.url), "utf8")) as {
  capturedAt: string; refdata: { data: unknown[] }; contracts: { data: QfexContractRow[] };
};
const AT = Date.parse(NOW.capturedAt);
const instruments = NOW.refdata.data.map(toQfexInstrument);
const marks = new Map([
  ["AAPL-USD", { price: "342.45", time: AT }], ["ABCL-USD", { price: "11.95", time: AT }],
  ["SAMSUNG-KRW", { price: "220030", time: AT }], ["KIOXIA-JPY", { price: "13621", time: AT }],
]);

function fakeQfex(rows: ReturnType<typeof buildQfexFundingRates>["rates"]): VenueDefinition {
  return {
    id: "qfex", fundingVerified: true, apiStatus: { kind: "official" },
    publicData: { fetchFundingRates: async () => rows, fetchMarkets: async () => [] },
  } as unknown as VenueDefinition;
}

describe("QFEX current funding rate in closed hours", () => {
  it("KRX / TSE closed (20:27 KST): SAMSUNG-KRW, KIOXIA-JPY null + marketClosed; AAPL pre-market and ABCL's in-session 0 stay", () => {
    const { rates } = buildQfexFundingRates(instruments, NOW.contracts.data, marks, AT);
    const by = (s: string) => rates.find(r => r.venueSymbol === s);
    expect(by("SAMSUNG-KRW")).toMatchObject({ rate: null, marketClosed: true });
    expect(by("KIOXIA-JPY")).toMatchObject({ rate: null, marketClosed: true });
    expect(by("AAPL-USD")).toMatchObject({ rate: "0.00000007", marketClosed: false });
    expect(by("ABCL-USD")).toMatchObject({ rate: "0", marketClosed: false }); // pre_market: a real 0
  });

  it("weekend: AAPL-USD's venue 0 (as GET /funding printed every weekend hour) is closed; aggregated rates skip it", async () => {
    // The recorded Monday row, read on Sat 2026-10-17 12:00Z with the 0 the venue printed for that
    // hour (fixtures/qfex/funding-aapl-weekend-2026-10-19.json windowStart 2026-10-17T13:00Z: 0).
    const sat = Date.parse("2026-10-17T12:00:00Z");
    const aapl = NOW.contracts.data.filter(c => c.ticker_id === "AAPL-USD").map(c => ({ ...c, funding_rate: "0" }));
    const { rates } = buildQfexFundingRates(instruments, aapl, marks, sat);
    expect(rates).toMatchObject([{ venueSymbol: "AAPL-USD", rate: null, marketClosed: true }]);

    const weekend = await fetchVenuesRates([fakeQfex(rates)], "mainnet", true);
    expect(weekend.rates).toEqual([]); // never ranked / snapshotted / averaged as a 0
    const open = await fetchVenuesRates([fakeQfex(buildQfexFundingRates(instruments, NOW.contracts.data, marks, AT).rates)], "mainnet", true);
    expect(open.rates.map(r => [r.symbol, r.fundingRate])).toEqual([["AAPL", 0.00000007], ["ABCL", 0]]);
  });
});
