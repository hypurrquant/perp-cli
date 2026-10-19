/**
 * Per-dex Hyperliquid adapters (`market list --hip3`, account HIP-3 fan-out) must not share
 * state with the native adapter. Object.create(adapter) + setDex() cleared the PARENT's asset
 * maps (shared through the prototype) and read the parent's markets cache, so a native read
 * after the fan-out lost its symbols. Replays responses recorded live 2026-10-19.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../cache.js", async () => ({
  withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  fetchAndCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidateCache: () => {},
  TTL_ACCOUNT: 1000,
  TTL_MARKETS: 1000,
  TTL_PRICES: 1000,
}));

import { Command } from "commander";
import { registerMarketCommands } from "../../commands/market.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import REC from "../fixtures/hyperliquid/read-path-2026-10-19.json";

type Body = Record<string, unknown>;

/** Every adapter built from this prototype (incl. per-dex copies) answers from the recording. */
function recordedPost(this: HyperliquidAdapter, b: Body): Promise<unknown> {
  const dex = b.dex as string | undefined;
  const byDex = (native: unknown, xyz: unknown, km: unknown) => (dex === undefined ? native : dex === "xyz" ? xyz : dex === "km" ? km : { universe: [] });
  const routes: Record<string, () => unknown> = {
    meta: () => byDex(REC.meta, REC.xyzMeta, REC.kmMeta),
    metaAndAssetCtxs: () => (dex === undefined || dex === "xyz" || dex === "km" ? byDex(REC.metaAndAssetCtxs, REC.xyzMetaAndAssetCtxs, REC.kmMetaAndAssetCtxs) : [{ universe: [] }, []]),
    allMids: () => REC.allMids,
    perpDexs: () => REC.perpDexs,
    allPerpMetas: () => REC.allPerpMetas,
    userAbstraction: () => "disabled",
  };
  const r = routes[String(b.type)];
  return r ? Promise.resolve(r()) : Promise.reject(new Error(`unexpected info ${String(b.type)}`));
}

afterEach(() => { vi.restoreAllMocks(); });

function recordedAdapter(): HyperliquidAdapter {
  vi.spyOn(HyperliquidAdapter.prototype as unknown as { _infoPost: typeof recordedPost }, "_infoPost").mockImplementation(recordedPost);
  return new HyperliquidAdapter(undefined, false);
}

describe("market list --hip3 leaves the native adapter intact", () => {
  it("a native read after the --hip3 fan-out still resolves BTC; dex groups hold dex markets", async () => {
    const hl = recordedAdapter();
    await hl.init();
    expect(await hl.getAssetIndex("BTC")).toBe(0);

    const program = new Command();
    program.exitOverride();
    program.option("-e, --exchange <exchange>", "", "hyperliquid");
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMarketCommands(program, async () => hl as unknown as ExchangeAdapter, () => true);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", "-e", "hyperliquid", "market", "list", "--hip3"]);
    const env = JSON.parse(out[out.length - 1]);

    // the xyz group is xyz's markets, not the native list served from a shared cache
    expect(env.data.hip3.xyz.map((m: { symbol: string }) => m.symbol)).toEqual(["xyz:XYZ100", "xyz:TSLA", "xyz:GOLD"]);
    expect(env.data.main.map((m: { symbol: string }) => m.symbol)).toContain("BTC-PERP");

    // the native adapter is unchanged — checked first with the reads that do NOT reload an
    // empty asset map (sync symbol resolution / szDecimals, as order sizing uses them)
    expect(hl.dex).toBe("");
    expect(hl.resolveSymbol("BTC")).toBe("BTC-PERP");
    expect(hl.getSzDecimals("BTC")).toBe(5);
    expect(await hl.getAssetIndex("BTC")).toBe(0);
    await expect(hl.getAssetIndex("XYZ100")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
    expect((await hl.getMarkets()).map(m => m.symbol)).toContain("BTC-PERP");
  });
});

describe("forDex: an independent per-dex adapter", () => {
  it("own dex, own asset maps / caches; shares only the account configuration", async () => {
    const hl = recordedAdapter();
    hl.setAddress("0xabcdef0000000000000000000000000000000001");
    await hl.init();
    const xyz = hl.forDex("xyz");
    expect(xyz).toBeInstanceOf(HyperliquidAdapter);
    expect(xyz).not.toBe(hl);
    expect(xyz.dex).toBe("xyz");
    expect(xyz.address).toBe(hl.address);
    expect(xyz.isTestnet).toBe(hl.isTestnet);
    expect(await xyz.getAssetIndex("XYZ100")).toBe(110000);
    expect((await xyz.getMarkets()).map(m => m.symbol)).toEqual(["xyz:XYZ100", "xyz:TSLA", "xyz:GOLD"]);
    expect(await hl.getAssetIndex("BTC")).toBe(0);
    await expect(hl.getAssetIndex("XYZ100")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
  });
});
