/**
 * Public Pacifica price fetchers (arb, funding-arb): `/info/prices` also lists spot markets
 * (live mainnet 2026-10-18: SOL-USDC). Only GET /info rows with instrument_type "perpetual" pass.
 * fetch is mocked; no on-disk cache.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../cache.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../cache.js")>();
  return { ...orig, withCache: async (_k: string, _t: number, f: () => Promise<unknown>) => f() };
});

import { fetchPacificaPrices, fetchPacificaPricesRaw, parsePacificaRaw } from "../api/public/pacifica.js";

const price = (symbol: string, mark: string) => ({ symbol, mark, funding: "0.0001", next_funding: "0.0001" });

function stubFetch(info: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.endsWith("/info/prices")
      ? { success: true, data: [price("BTC", "100000"), price("SOL-USDC", "103"), price("SOL", "103.2")] }
      : url.endsWith("/info") ? { success: true, data: info } : null;
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body, text: async () => "" };
  }));
}

afterEach(() => vi.unstubAllGlobals());

const INFO = [
  { symbol: "BTC", instrument_type: "perpetual" },
  { symbol: "SOL", instrument_type: "perpetual" },
  { symbol: "SOL-USDC", instrument_type: "spot" },
];

describe("Pacifica public prices: perps only", () => {
  it("fetchPacificaPrices (funding-arb) drops the spot row", async () => {
    stubFetch(INFO);
    expect((await fetchPacificaPrices()).map((p) => p.symbol)).toEqual(["BTC", "SOL"]);
  });

  it("fetchPacificaPricesRaw + parsePacificaRaw (arb) drop the spot row", async () => {
    stubFetch(INFO);
    const { prices, rates } = parsePacificaRaw(await fetchPacificaPricesRaw());
    expect([...prices.keys()]).toEqual(["BTC", "SOL"]);
    expect(rates.has("SOL-USDC")).toBe(false);
  });

  it("an /info row without instrument_type → EXCHANGE_ERROR (cannot be classified)", async () => {
    stubFetch([...INFO, { symbol: "ETH" }]);
    await expect(fetchPacificaPricesRaw()).rejects.toMatchObject({ message: expect.stringContaining("ETH has no instrument_type") });
  });
});
