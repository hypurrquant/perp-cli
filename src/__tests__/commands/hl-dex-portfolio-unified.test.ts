/**
 * `perp -e hyperliquid --dex xyz portfolio` on a unified (userAbstraction "unifiedAccount")
 * account: the dex adapter's getBalance() reports the spot collateral row as equity (the spot
 * balance is the truth source in unified mode, every perp dex included), so the spot rows of a
 * dex-scoped read must mark that row `shared` — otherwise portfolio adds the same USDC twice.
 * Real HyperliquidAdapter / HyperliquidSpotAdapter; only `fetch` is stubbed (recorded meta and
 * empty account, no recorded spotMeta exists), no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerPortfolioCommand } from "../../commands/portfolio.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import REC from "../fixtures/hyperliquid/read-path-2026-10-19.json";
import HL_ACCOUNT_FRAMES from "../fixtures/ws/hyperliquid/private-clearinghouseState.json";

const ADDR = "0xabcdef0000000000000000000000000000000001";
type Body = Record<string, unknown>;

const SPOT_META = {
  tokens: [{ name: "USDC", index: 0, szDecimals: 8, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054" }, { name: "PURR", index: 1, szDecimals: 0, tokenId: "0xc1fb593aeffbeb02f85e0308e9956a90" }],
  universe: [{ name: "PURR/USDC", tokens: [1, 0], index: 0, isCanonical: true }],
};

/** USDC 1000 in spot; the xyz dex holds no position (its perp state is empty in unified mode). */
function infoAnswer(b: Body): unknown {
  const routes: Record<string, () => unknown> = {
    meta: () => REC.xyzMeta,
    perpDexs: () => REC.perpDexs,
    userAbstraction: () => "unifiedAccount",
    clearinghouseState: () => HL_ACCOUNT_FRAMES.frames[0].data.clearinghouseState,
    spotClearinghouseState: () => ({ balances: [{ coin: "USDC", token: 0, total: "1000.0", hold: "0.0", entryNtl: "0.0" }] }),
    allMids: () => REC.allMids,
    spotMeta: () => SPOT_META,
    spotMetaAndAssetCtxs: () => [SPOT_META, [{ markPx: "0.2", midPx: "0.2", prevDayPx: "0.2", dayNtlVlm: "1000", circulatingSupply: "1" }]],
    frontendOpenOrders: () => [],
    openOrders: () => [],
    userFunding: () => [],
  };
  const r = routes[String(b.type)];
  if (!r) throw new Error(`unexpected info ${String(b.type)}`);
  return r();
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function dexAdapter(): Promise<HyperliquidAdapter> {
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => new Response(JSON.stringify(infoAnswer(JSON.parse(String(init?.body)) as Body)), { status: 200 })));
  const hl = new HyperliquidAdapter(undefined, false);
  hl.setAddress(ADDR);
  hl.setDex("xyz");
  await hl.init();
  return hl;
}

describe("HL unified account + --dex: spot USDC is counted once", () => {
  it("dex getBalance reports the spot USDC as equity; spot rows mark it shared", async () => {
    const hl = await dexAdapter();
    expect(hl.accountMode).toBe("unified");
    expect((await hl.getBalance()).equity).toBe("1000");
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    const spot = new HyperliquidSpotAdapter(hl);
    const rows = await spot.getSpotBalances();
    expect(rows.map(r => [r.token, r.shared])).toEqual([["USDC", true]]);
  });

  it("portfolio totals: accountValueUsd = 1000, not 2000", async () => {
    const hl = await dexAdapter();
    const prog = new Command();
    prog.exitOverride();
    addRootSafetyOptions(prog).option("-e, --exchange <exchange>", "Exchange", "pacifica").option("--json", "JSON output");
    registerPortfolioCommand(prog, async () => hl as unknown as ExchangeAdapter, () => prog.opts().json === true, "1.0.0-test");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await prog.parseAsync(["node", "perp", "-e", "hyperliquid", "--json", "portfolio"]);
    const joined = out.join("");
    const env = JSON.parse(joined.slice(joined.indexOf("{")));
    expect(env.ok).toBe(true);
    const [entry] = env.data.exchanges;
    expect(entry.spot.map((b: { token: string; shared: boolean }) => [b.token, b.shared])).toEqual([["USDC", true]]);
    expect(entry.perp.equity).toBe("1000");
    expect(entry.totalAccountValueUsd).toBe(1000);
    expect(env.data.totals.accountValueUsd).toBe(1000);
    expect(env.data.totals.spotValueUsd).toBe(0);
  });
});
