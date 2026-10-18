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

  it("a non-object /info row → EXCHANGE_ERROR with remediation (no TypeError)", async () => {
    stubFetch([...INFO, null]);
    await expect(fetchPacificaPricesRaw()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR", remediation: expect.any(String) }, message: expect.stringContaining("row is not an object") });
  });

  it("an /info row without instrument_type → EXCHANGE_ERROR (cannot be classified)", async () => {
    stubFetch([...INFO, { symbol: "ETH" }]);
    await expect(fetchPacificaPricesRaw()).rejects.toMatchObject({ message: expect.stringContaining("ETH has no instrument_type") });
  });
});

describe("Pacifica public prices with the REAL file cache (JSON on disk)", () => {
  async function freshModules() {
    vi.doUnmock("../cache.js");
    vi.resetModules();
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "perp-cache-test-"));
    vi.stubEnv("TMPDIR", dir); // cache.ts resolves its dir from os.tmpdir() at import
    const pub = await import("../api/public/pacifica.js");
    const arb = await import("../commands/arb.js");
    return { dir, pub, arb };
  }

  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("fetchPacificaPricesRaw then fetchPacificaPrices within the TTL both work (the perp list is cached JSON-safe)", async () => {
    const { dir, pub } = await freshModules();
    stubFetch(INFO);
    expect([...pub.parsePacificaRaw(await pub.fetchPacificaPricesRaw()).prices.keys()]).toEqual(["BTC", "SOL"]);
    expect((await pub.fetchPacificaPrices()).map((p) => p.symbol)).toEqual(["BTC", "SOL"]);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const entry = JSON.parse(readFileSync(join(dir, "perp-cli-cache", "pub_pac_mainnet_perps_list.json"), "utf8")) as { data: unknown };
    expect(entry.data).toEqual(["BTC", "SOL"]);
  });

  it("/info 500 with /info/prices OK → the Pacifica leg rejects visibly; the other venues still appear", async () => {
    const { arb } = await freshModules();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => { errors.push(String(m)); });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.endsWith("/info/prices") ? { success: true, data: [price("BTC", "100000")] }
        : url.endsWith("api.pacifica.fi/api/v1/info") ? null
        : url.includes("hyperliquid") ? { BTC: "100005" }
        : url.endsWith("/api/v1/orderBookDetails") ? { order_book_details: [{ symbol: "BTC", last_trade_price: 100010 }] }
        : undefined;
      if (body === undefined) throw new Error(`unexpected ${url}`);
      return { ok: body !== null, status: body === null ? 500 : 200, json: async () => body, text: async () => "internal error" };
    }));
    const snaps = await arb.fetchAllPrices();
    expect(snaps.map((x) => [x.symbol, x.pacPrice, x.hlPrice, x.ltPrice])).toEqual([["BTC", null, 100005, 100010]]);
    expect(errors.some((e) => e.includes("[arb] pacifica fetch failed") && e.includes("500"))).toBe(true);
    vi.restoreAllMocks();
  });
});
