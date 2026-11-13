/**
 * HIP-3 fan-outs (`market list --hip3`, `account positions|orders --hip3`) must surface a dex whose
 * read failed (SSOT Rule #2) — never drop it as if it had no markets / positions. One dex (km)
 * fails with HTTP 429; xyz answers. Single venue: `meta.errors["hip3:<dex>"]`, `data` keeps its shape
 * (the rows, or { main, hip3 } when a dex has rows); all venues: the `data.errors` map. Real adapter;
 * `fetch` replays responses recorded live 2026-10-19 (no account with a dex position was recorded:
 * XYZ_CHS adds one to the recorded empty account); no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { Command } from "commander";
import { registerMarketCommands } from "../../commands/market.js";
import { registerAccountCommands } from "../../commands/account.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import REC from "../fixtures/hyperliquid/read-path-2026-10-19.json";
import HL_ACCOUNT_FRAMES from "../fixtures/ws/hyperliquid/private-clearinghouseState.json";

type Body = Record<string, unknown>;
const ADDR = "0xabcdef0000000000000000000000000000000001";
const EMPTY_CHS = HL_ACCOUNT_FRAMES.frames[0].data.clearinghouseState;
const XYZ_CHS = { ...EMPTY_CHS, assetPositions: [{ type: "oneWay", position: { coin: "xyz:TSLA", szi: "1.0", entryPx: "400.0", positionValue: "410.0", unrealizedPnl: "10.0", liquidationPx: null, leverage: { type: "isolated", value: 5 }, marginUsed: "82.0" } }] };

function recordedAnswer(b: Body): Response {
  const dex = b.dex as string | undefined;
  if (dex === "km" && b.type !== "meta" && b.type !== "perpDexs") return new Response("Too Many Requests", { status: 429 });
  const byDex = (native: unknown, xyz: unknown, km: unknown, other: unknown) => (dex === undefined || dex === "" ? native : dex === "xyz" ? xyz : dex === "km" ? km : other);
  const routes: Record<string, () => unknown> = {
    meta: () => byDex(REC.meta, REC.xyzMeta, REC.kmMeta, { universe: [] }),
    metaAndAssetCtxs: () => byDex(REC.metaAndAssetCtxs, REC.xyzMetaAndAssetCtxs, null, [{ universe: [] }, []]),
    allMids: () => REC.allMids,
    perpDexs: () => REC.perpDexs,
    allPerpMetas: () => REC.allPerpMetas,
    userAbstraction: () => "disabled",
    clearinghouseState: () => (dex === "xyz" ? XYZ_CHS : EMPTY_CHS),
    frontendOpenOrders: () => [],
  };
  const r = routes[String(b.type)];
  if (!r) throw new Error(`unexpected info ${String(b.type)}`);
  return new Response(JSON.stringify(r()), { status: 200 });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function recordedAdapter(): Promise<HyperliquidAdapter> {
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => recordedAnswer(JSON.parse(String(init?.body)) as Body)));
  const hl = new HyperliquidAdapter(undefined, false);
  hl.setAddress(ADDR);
  await hl.init();
  return hl;
}

async function runJson(register: (p: Command, hl: ExchangeAdapter) => void, argv: string[]): Promise<{ ok: boolean; data: Record<string, unknown>; meta: Record<string, unknown> }> {
  const hl = await recordedAdapter();
  const program = new Command();
  program.exitOverride();
  program.option("-e, --exchange <exchange>", "", "hyperliquid");
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  register(program, hl as unknown as ExchangeAdapter);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await program.parseAsync(["node", "perp", ...argv]);
  return JSON.parse(out[out.length - 1]);
}

const onlyHl = (hl: ExchangeAdapter) => async (ex: string) => { if (ex !== "hyperliquid") throw new Error(`${ex}: not under test`); return hl; };
const market = (p: Command, hl: ExchangeAdapter) => registerMarketCommands(p, async () => hl, () => true, onlyHl(hl));
const account = (p: Command, hl: ExchangeAdapter) => registerAccountCommands(p, async () => hl, () => true, onlyHl(hl));

const KM_429 = { "hip3:km": { code: "RATE_LIMITED", message: expect.stringContaining("HTTP 429") } };

describe("HIP-3 fan-out: a failed dex is reported, not dropped", () => {
  it("market list --hip3 (-e hyperliquid): xyz markets + meta.errors['hip3:km']", async () => {
    const env = await runJson(market, ["-e", "hyperliquid", "market", "list", "--hip3"]);
    expect(Object.keys(env.data).sort()).toEqual(["hip3", "main"]);
    const hip3 = env.data.hip3 as Record<string, unknown[]>;
    expect(hip3.xyz.length).toBe(3);
    expect(hip3.km).toBeUndefined();
    expect(env.meta.errors).toEqual(KM_429);
  });

  it("market list --hip3 (all venues): errors['hip3:km']", async () => {
    const env = await runJson(market, ["market", "list", "--hip3"]);
    const exchanges = env.data.exchanges as Record<string, unknown[]>;
    expect(exchanges["hip3:xyz"].length).toBe(3);
    expect((env.data.errors as Record<string, string>)["hip3:km"]).toContain("HTTP 429");
  });

  it("account positions --hip3 (-e hyperliquid): xyz position + meta.errors['hip3:km']", async () => {
    const env = await runJson(account, ["-e", "hyperliquid", "account", "positions", "--hip3"]);
    expect(Object.keys(env.data).sort()).toEqual(["hip3", "main"]);
    const hip3 = env.data.hip3 as Record<string, { symbol: string }[]>;
    expect(hip3.xyz.map(p => p.symbol)).toEqual(["xyz:TSLA"]);
    expect(env.meta.errors).toEqual(KM_429);
  });

  it("account orders --hip3 (-e hyperliquid): no orders anywhere — data stays the (empty) row list, the km failure is in meta.errors", async () => {
    const env = await runJson(account, ["-e", "hyperliquid", "account", "orders", "--hip3"]);
    expect(env.data).toEqual([]);
    expect(env.meta.errors).toEqual(KM_429);
  });
});
