/**
 * portfolio --serve HIP-3 auto-detect (audit M7): a failed clearinghouseState read is
 * "positions unknown" (null + stderr warning), never "0 positions" — the dex stays in the
 * dashboard instead of being hidden. fetch is mocked; nothing reaches the network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkDexPositions, KNOWN_HIP3_DEXES } from "../commands/portfolio.js";

const ADDR = "0x1111111111111111111111111111111111111111";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("checkDexPositions", () => {
  it("counts non-zero positions on a successful read", async () => {
    stubFetch(async () => new Response(JSON.stringify({ assetPositions: [
      { position: { coin: "xyz:CL", szi: "2" } },
      { position: { coin: "xyz:GOLD", szi: "0" } },
    ] })));
    await expect(checkDexPositions(ADDR, "xyz")).resolves.toBe(1);
  });

  it("network error → null (unknown) + stderr warning, not 0", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stubFetch(async () => { throw new Error("ECONNRESET"); });
    await expect(checkDexPositions(ADDR, "xyz")).resolves.toBeNull();
    expect(err.mock.calls.some(c => String(c[0]).includes("hl:xyz positions unknown") && String(c[0]).includes("ECONNRESET"))).toBe(true);
  });

  it("HTTP error / malformed body → null, not 0", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stubFetch(async () => new Response("rate limited", { status: 429 }));
    await expect(checkDexPositions(ADDR, "flx")).resolves.toBeNull();
    stubFetch(async () => new Response(JSON.stringify({ error: "bad dex" })));
    await expect(checkDexPositions(ADDR, "flx")).resolves.toBeNull();
    stubFetch(async () => new Response(JSON.stringify({ assetPositions: [{ position: { coin: "flx:X" } }] })));
    await expect(checkDexPositions(ADDR, "flx")).resolves.toBeNull();
  });
});

describe("KNOWN_HIP3_DEXES", () => {
  it("includes every HIP-3 dex in Hyperliquid perpDexs", () => {
    for (const dex of ["xyz", "flx", "vntl", "hyna", "km", "abcd", "cash", "para", "mkts", "io"]) {
      expect(KNOWN_HIP3_DEXES).toContain(dex);
    }
  });
});
