/**
 * Pacifica's compared funding rate is the LAST SETTLED hourly rate (`funding`, = WS prices `rate`)
 * on every path — CLI market rows, the public directory (MCP, arb scan) and arb auto's raw read —
 * never the predicted `next_funding` (CLI rows: `predictedFundingRate`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { parsePacificaRaw } from "../../api/public/pacifica.js";
import { legacyPublicData } from "../../funding/legacy-public.js";

afterEach(() => vi.unstubAllGlobals());

describe("Pacifica settled funding rate", () => {
  it("arb auto's raw parse reads funding, not next_funding", () => {
    const { rates } = parsePacificaRaw({ data: [{ symbol: "BTC", funding: "0.0000125", next_funding: "0.00009", mark: "82000" }] });
    expect(rates.get("BTC")).toBe(0.0000125);
  });

  it("public directory row: fundingRate = funding (lastSettled)", async () => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async (u: string) => String(u).endsWith("/info/prices")
      ? json({ success: true, data: [{ symbol: "BTC", mark: "82000", oracle: "82000", funding: "0.0000125", next_funding: "0.00009" }] })
      : json({ success: true, data: [{ symbol: "BTC", instrument_type: "perpetual", tick_size: "1", lot_size: "0.00001", max_leverage: 50 }] })));
    const [m] = await legacyPublicData("pacifica").fetchMarkets("mainnet");
    expect(m.fundingRate).toBe("0.0000125");
    const [r] = await legacyPublicData("pacifica").fetchFundingRates("mainnet");
    expect(r.rate).toBe("0.0000125");
  });
});
