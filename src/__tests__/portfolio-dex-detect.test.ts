/**
 * portfolio --serve HIP-3 auto-detect (audit M7): a failed clearinghouseState read is
 * "positions unknown" (null + stderr warning), never "0 positions" — the dex stays in the
 * dashboard instead of being hidden. fetch is mocked; nothing reaches the network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { autoDetectHip3Dexes, checkDexPositions, fetchHip3DexNames } from "../commands/portfolio.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

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

/** fetch stub routing info requests by body: perpDexs → `dexes`, clearinghouseState → `positions[dex]`. */
function stubInfo(dexes: () => Promise<Response>, positions: Record<string, string[]>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { type: string; dex?: string };
    if (body.type === "perpDexs") { calls.push("perpDexs"); return dexes(); }
    calls.push(`clearinghouseState:${body.dex}`);
    return new Response(JSON.stringify({ assetPositions: (positions[body.dex ?? ""] ?? []).map(coin => ({ position: { coin, szi: "1" } })) }));
  }));
  return calls;
}

const PERP_DEXS = [null, { name: "xyz" }, { name: "para" }, { name: "newdex" }];
const adapterFor = async (dex: string) => ({ name: `hl:${dex}` }) as unknown as ExchangeAdapter;

describe("fetchHip3DexNames (live perpDexs, no fixed list)", () => {
  it("returns every named dex and skips the native null entry", async () => {
    stubInfo(async () => new Response(JSON.stringify(PERP_DEXS)), {});
    await expect(fetchHip3DexNames()).resolves.toEqual(["xyz", "para", "newdex"]);
  });

  it("HTTP error / non-array / nameless entry → throws (never a substitute list)", async () => {
    stubInfo(async () => new Response("rate limited", { status: 429 }), {});
    await expect(fetchHip3DexNames()).rejects.toThrow(/HTTP 429/);
    stubInfo(async () => new Response(JSON.stringify({ error: "x" })), {});
    await expect(fetchHip3DexNames()).rejects.toThrow(/expected an array/);
    stubInfo(async () => new Response(JSON.stringify([null, { deployer: "0x1" }])), {});
    await expect(fetchHip3DexNames()).rejects.toThrow(/entry 1 has no dex name/);
  });
});

describe("autoDetectHip3Dexes", () => {
  it("scans every dex perpDexs returns — a dex added later is picked up", async () => {
    const calls = stubInfo(async () => new Response(JSON.stringify(PERP_DEXS)), { newdex: ["newdex:FOO"], para: ["para:AVGO"] });
    const r = await autoDetectHip3Dexes(ADDR, adapterFor, false);
    expect(r.error).toBeNull();
    expect(r.exchanges.map(e => e.name).sort()).toEqual(["hl:newdex", "hl:para"]);
    expect(calls.filter(c => c.startsWith("clearinghouseState")).sort()).toEqual(["clearinghouseState:newdex", "clearinghouseState:para", "clearinghouseState:xyz"]);
  });

  it("dex list read fails → error surfaced, no dex scanned (not 'no positions')", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const calls = stubInfo(async () => { throw new Error("ECONNRESET"); }, { xyz: ["xyz:GOLD"] });
    const r = await autoDetectHip3Dexes(ADDR, adapterFor, false);
    expect(r.exchanges).toEqual([]);
    expect(r.error).toMatch(/HIP-3 dex list unavailable.*ECONNRESET/);
    expect(calls).toEqual(["perpDexs"]);
    expect(err.mock.calls.some(c => String(c[0]).includes("hl:hip3"))).toBe(true);
  });
});
