/**
 * Session-close boundary (review B2-1): GOLD-USD's Friday session closes at "17:00:00" ET
 * (inclusive, on the hour). The hour after it (Fri 17:00–18:00 ET = window labelled 22:00Z) is
 * outside market_hours and the venue printed 0 — it is closed, on both the history path and the
 * current-rate path. Real GET /funding/GOLD-USD 2026-10-16 18:00Z–10-17 01:00Z and /refdata.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import "../../exchanges/venues/index.js";
import { READ_ONLY_CREDENTIALS } from "../../exchanges/venue.js";
import { qfexVenue } from "../../exchanges/venues/qfex.js";
import { QfexAdapter } from "../../exchanges/qfex/adapter.js";
import { buildQfexFundingRates, toQfexInstrument, type QfexContractRow } from "../../exchanges/qfex/public.js";

const FX = JSON.parse(readFileSync(new URL("../fixtures/qfex/gold-session-close-2026-10-16.json", import.meta.url), "utf8")) as {
  refdata: { data: unknown[] }; funding: unknown; contracts: { data: QfexContractRow[] };
};

describe("QFEX session-close boundary (GOLD-USD Fri close 17:00:00 ET)", () => {
  it("history: the 22:00Z window (Fri 17:00–18:00 ET) is closed; 21:00Z (16:00–17:00) keeps its rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      const body = path === "/refdata" ? FX.refdata : path === "/funding/GOLD-USD" ? FX.funding : undefined;
      if (body === undefined) throw new Error(`unexpected request ${input}`);
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
    }));
    const a = new QfexAdapter(qfexVenue, { network: "mainnet", credentials: READ_ONLY_CREDENTIALS, noAgent: false, hlDex: null, readOnly: true, noBuilder: false });
    const h = await a.getFundingHistory("GOLD", 8);
    const at = (iso: string) => h.find(r => r.time === Date.parse(iso));
    expect(at("2026-10-16T21:00:00Z")).toMatchObject({ rate: "0.00000556", marketClosed: false });
    expect(at("2026-10-16T22:00:00Z")).toMatchObject({ rate: null, marketClosed: true });
    expect(h.filter(r => r.marketClosed === true).map(r => new Date(r.time).toISOString())).toEqual([
      "2026-10-16T22:00:00.000Z", "2026-10-16T23:00:00.000Z", "2026-10-17T00:00:00.000Z", "2026-10-17T01:00:00.000Z",
    ]);
    vi.unstubAllGlobals();
  });

  it("current rate: read during Fri 17:00–18:00 ET with the venue's 0 → null + marketClosed; 16:30 ET stays open", () => {
    const instruments = FX.refdata.data.map(toQfexInstrument);
    const zero = FX.contracts.data.map(c => ({ ...c, funding_rate: "0" }));
    const after = buildQfexFundingRates(instruments, zero, new Map(), Date.parse("2026-10-16T21:30:00Z")).rates;
    expect(after).toMatchObject([{ venueSymbol: "GOLD-USD", rate: null, marketClosed: true }]);
    const before = buildQfexFundingRates(instruments, zero, new Map(), Date.parse("2026-10-16T20:30:00Z")).rates;
    expect(before).toMatchObject([{ venueSymbol: "GOLD-USD", rate: "0", marketClosed: false }]);
  });
});
