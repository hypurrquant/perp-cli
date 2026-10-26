/**
 * `perp market` over the real HyperliquidAdapter replaying responses recorded live on 2026-10-19
 * (fixtures/hyperliquid/read-path-2026-10-19.json): venue caps that cannot be paged are
 * INVALID_PARAMS naming the cap; `book -d` applies to JSON; delisted HIP-3 names and dexes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

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

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

type Body = Record<string, unknown>;

function recordedAdapter(dex = "", candles: unknown[] = []): HyperliquidAdapter {
  const hl = new HyperliquidAdapter(undefined, false);
  if (dex) hl.setDex(dex);
  const routes: Record<string, (b: Body) => unknown> = {
    meta: (b) => (b.dex === "km" ? REC.kmMeta : REC.meta),
    metaAndAssetCtxs: (b) => (b.dex === "km" ? REC.kmMetaAndAssetCtxs : REC.metaAndAssetCtxs),
    allMids: () => REC.allMids,
    perpDexs: () => REC.perpDexs,
    allPerpMetas: () => REC.allPerpMetas,
    recentTrades: () => REC.recentTradesBTC,
    l2Book: () => REC.l2BookBTC,
    candleSnapshot: () => candles,
  };
  (hl as unknown as { _infoPost: (b: Body) => Promise<unknown> })._infoPost = async (b) => {
    const r = routes[String(b.type)];
    if (!r) throw new Error(`unexpected info ${String(b.type)}`);
    return r(b);
  };
  return hl;
}

async function run(adapter: HyperliquidAdapter, argv: string[], json = false) {
  const program = new Command();
  program.exitOverride();
  program.option("-e, --exchange <exchange>", "", "hyperliquid");
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMarketCommands(program, async () => adapter as unknown as ExchangeAdapter, () => json);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  await program.parseAsync(["node", "perp", "-e", "hyperliquid", ...argv]);
  return { text: strip(out.join("\n")), last: () => JSON.parse(out[out.length - 1]), exitCode: process.exitCode };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(REC.recordedAt); });
afterEach(() => { process.exitCode = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("market trades: HL's 10-trade tape", () => {
  it("default --limit (20) → min(20, cap) = the 10 rows served, no refusal", async () => {
    const env = (await run(recordedAdapter(), ["market", "trades", "BTC"], true)).last();
    expect(env.ok).toBe(true);
    expect(env.data).toHaveLength(10);
    expect(env.meta.venueCap).toBeUndefined();
  });

  it("explicit --limit 20 → INVALID_PARAMS naming the cap of 10", async () => {
    const r = await run(recordedAdapter(), ["market", "trades", "BTC", "--limit", "20"], true).catch((e: unknown) => e);
    expect(r).toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(String((r as Error).message)).toContain("exceeds the venue cap of 10");
  });

  it("explicit --limit 4 → 4 rows", async () => {
    const env = (await run(recordedAdapter(), ["market", "trades", "BTC", "--limit", "4"], true)).last();
    expect(env.data).toHaveLength(4);
  });
});

describe("market book -d N", () => {
  it("--json -d 5 → 5 levels per side", async () => {
    const env = (await run(recordedAdapter(), ["market", "book", "BTC", "-d", "5"], true)).last();
    expect(env.data.bids).toHaveLength(5);
    expect(env.data.asks).toHaveLength(5);
  });

  it("-d 50 → INVALID_PARAMS naming the cap of 20", async () => {
    const r = await run(recordedAdapter(), ["market", "book", "BTC", "-d", "50"], true).catch((e: unknown) => e);
    expect(r).toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(String((r as Error).message)).toContain("max 20 levels per side");
  });
});

describe("market kline: a start before the 5000-candle window is refused", () => {
  const c = REC.candles1m10d;

  it("--start 10 days back at 1m → INVALID_PARAMS with the earliest allowed start", async () => {
    const argv = ["market", "kline", "BTC", "1m", "--start", String(c.req.startTime), "--end", String(c.req.endTime)];
    const r = await run(recordedAdapter("", [...c.head, ...c.tail]), argv, true).catch((e: unknown) => e);
    expect(r).toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(String((r as Error).message)).toContain(`earliest allowed start is ${new Date(REC.recordedAt - 5000 * 60_000).toISOString()}`);
  });

  it("default range (24 h) → candles, the last one closed:false", async () => {
    const env = (await run(recordedAdapter("", REC.candles1h24h.rows), ["market", "kline", "BTC", "1h"], true)).last();
    expect(env.data).toHaveLength(REC.candles1h24h.rows.length);
    expect(env.data.at(-1).closed).toBe(false);
    expect(env.meta.venueCap).toBeUndefined();
  });
});

describe("market info / hip3 on delisted HIP-3 markets", () => {
  it("--dex km market info US500 → SYMBOL_NOT_FOUND delisted, remediation names --dex km", async () => {
    const r = await run(recordedAdapter("km"), ["market", "info", "US500"], true);
    const env = r.last();
    expect(env.error).toMatchObject({ code: "SYMBOL_NOT_FOUND", message: "km:US500 is delisted on Hyperliquid (positions / history still readable)" });
    expect(env.error.remediation).toBe("List live markets: perp -e hyperliquid --dex km market list");
    expect(r.exitCode).toBe(1);
  });

  it("market hip3 marks fully delisted dexes and shows the deployer", async () => {
    const r = await run(recordedAdapter(), ["market", "hip3"]);
    const kmLine = r.text.split("\n").find(l => /│\s*km\s*│/.test(l))!;
    expect(kmLine).toContain("delisted");
    expect(kmLine).toContain("0x71f0...29ec");
    const xyzLine = r.text.split("\n").find(l => /│\s*xyz\s*│/.test(l))!;
    expect(xyzLine).toMatch(/│\s*115\s*│/);
  });
});
