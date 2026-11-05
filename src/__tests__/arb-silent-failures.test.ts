/**
 * Silent-failure audit fixes (H1, H2, M1/M2, M6, M10, M13): a failed venue / dex read is
 * reported and treated as UNKNOWN — never as empty, 0, healthy or "gone". fetch is mocked.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PerpError } from "../errors.js";

// No shared on-disk cache: every read is live, and a partial read must not be cached.
const setCachedSpy = vi.fn();
vi.mock("../cache.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../cache.js")>();
  return { ...orig, getCached: () => null, setCached: (...a: unknown[]) => setCachedSpy(...a), withCache: async (_k: string, _t: number, f: () => Promise<unknown>) => f() };
});

import { scanDexArb, fetchAllDexAssetsDetailed } from "../dex-asset-map.js";
import { dexCloseBlockedBy, collectArbPnlPositions, arbPnlPairStatus } from "../commands/arb-auto.js";
import { checkChainMargins, marginEntryBlocks } from "../cross-chain-margin.js";
import { portfolioAprLine, resolveRebalanceAdapters, signedUsd, spotPerpFundingView } from "../commands/arb/index.js";
import { handleBasisScan } from "../commands/arb.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCachedSpy.mockReset();
});

// ── H1: HIP-3 dex read failure ──

function hip3Fetch(failDex: string | null) {
  const universe = (dex: string) => [{ name: dex === "hl" ? "TSLA" : `${dex}:TSLA`, maxLeverage: 10, szDecimals: 2 }];
  const ctx = (funding: string) => [{ markPx: "250", funding, openInterest: "100000", dayNtlVlm: "1000000" }];
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { type: string; dex?: string };
    if (body.type === "allPerpMetas") {
      return { ok: true, status: 200, json: async () => [{ universe: universe("hl") }, { universe: universe("xyz") }, { universe: universe("flx") }] };
    }
    const dex = body.dex ?? "hl";
    if (dex === failDex) return { ok: false, status: 429, json: async () => ({}) };
    const funding = dex === "hl" ? "0.00001" : dex === "xyz" ? "0.0001" : "0.00005";
    return { ok: true, status: 200, json: async () => [{ universe: universe(dex) }, ctx(funding)] };
  });
}

describe("H1: HIP-3 dex failure is explicit, never 'pair disappeared'", () => {
  it("a failed dex is returned in failedDexes (not silently empty) and the partial read is not cached", async () => {
    vi.stubGlobal("fetch", hip3Fetch("xyz"));
    const res = await fetchAllDexAssetsDetailed();
    expect(Object.keys(res.failedDexes)).toEqual(["xyz"]);
    expect(res.failedDexes.xyz).toMatch(/429/);
    expect(res.assets.some(a => a.dex === "xyz")).toBe(false);
    expect(setCachedSpy).not.toHaveBeenCalled();
  });

  it("scanDexArb with one failing dex → positions on that dex get no close decision", async () => {
    vi.stubGlobal("fetch", hip3Fetch("xyz"));
    const { pairs, failedDexes } = await scanDexArb({ minAnnualSpread: 0, includeNative: true });
    // xyz pairs are gone from the scan — but because xyz is unread, not because they closed.
    expect(pairs.some(p => p.long.dex === "xyz" || p.short.dex === "xyz")).toBe(false);
    expect(dexCloseBlockedBy({ longDex: "hl", shortDex: "xyz" }, failedDexes)).toBe("xyz");
    expect(dexCloseBlockedBy({ longDex: "xyz", shortDex: "flx" }, failedDexes)).toBe("xyz");
    // A pair on dexes that WERE read is evaluated normally.
    expect(dexCloseBlockedBy({ longDex: "hl", shortDex: "flx" }, failedDexes)).toBeNull();
  });

  it("a complete read reports no failures and is cached", async () => {
    vi.stubGlobal("fetch", hip3Fetch(null));
    const { pairs, failedDexes } = await scanDexArb({ minAnnualSpread: 0 });
    expect(failedDexes).toEqual({});
    expect(pairs.length).toBe(3);
    expect(setCachedSpy).toHaveBeenCalledTimes(1);
  });
});

// ── M2 / M1: unknown margin blocks entries ──

function balAdapter(getBalance: () => Promise<unknown>): ExchangeAdapter {
  return { getBalance: vi.fn(getBalance) } as unknown as ExchangeAdapter;
}

describe("M2/M1: a failed margin read is unknown and blocks new entries", () => {
  it("rejected venue → unknown (not dropped), and marginEntryBlocks blocks it", async () => {
    const adapters = new Map<string, ExchangeAdapter>([
      ["hyperliquid", balAdapter(async () => ({ equity: "1000", marginUsed: "100", available: "900", unrealizedPnl: "0" }))],
      ["lighter", balAdapter(async () => { throw new Error("timeout"); })],
    ]);
    const check = await checkChainMargins(adapters, 30);
    expect(check.statuses.map(s => s.exchange)).toEqual(["hyperliquid"]);
    expect(check.unknown).toEqual([{ exchange: "lighter", error: "timeout" }]);
    const blocks = marginEntryBlocks(check, 30);
    expect(blocks).toEqual([{ exchange: "lighter", level: "unknown", marginPct: null, threshold: null, error: "timeout" }]);
  });

  it("non-numeric balance → unknown, never a NaN ratio that passes every check", async () => {
    const adapters = new Map<string, ExchangeAdapter>([
      ["pacifica", balAdapter(async () => ({ equity: "n/a", marginUsed: "0", available: "0", unrealizedPnl: "0" }))],
    ]);
    const check = await checkChainMargins(adapters, 30);
    expect(check.statuses).toEqual([]);
    expect(check.unknown[0].exchange).toBe("pacifica");
    expect(marginEntryBlocks(check, 30)[0].level).toBe("unknown");
  });

  it("critical / low margins still block with their levels", () => {
    const blocks = marginEntryBlocks({
      statuses: [
        { exchange: "a", chain: "x", equity: 100, usedMargin: 90, freeMargin: 10, marginRatio: 10, belowThreshold: true },
        { exchange: "b", chain: "x", equity: 100, usedMargin: 80, freeMargin: 20, marginRatio: 20, belowThreshold: true },
        { exchange: "c", chain: "x", equity: 100, usedMargin: 10, freeMargin: 90, marginRatio: 90, belowThreshold: false },
      ],
      unknown: [],
    }, 30);
    expect(blocks.map(b => [b.exchange, b.level])).toEqual([["a", "critical"], ["b", "low"]]);
  });
});

// ── H2: arb pnl venue read failure ──

describe("H2: arb pnl surfaces a failed venue and marks its pairs unknown", () => {
  it("failed venue → positionErrors; read-only venue → notConfigured; single leg is unknown, not naked", async () => {
    const pos = (side: "long" | "short") => ({ symbol: "SOL", side, size: "1", entryPrice: "100", markPrice: "101", liquidationPrice: null, unrealizedPnl: "1", leverage: 2 });
    const adapters: Record<string, unknown> = {
      hyperliquid: { getPositions: async () => [pos("long")] },
      lighter: { getPositions: async () => { throw new Error("429 Too Many Requests"); } },
      pacifica: { isReadOnly: true, getPositions: async () => [] },
    };
    const res = await collectArbPnlPositions(["hyperliquid", "lighter", "pacifica"], async (ex) => adapters[ex] as ExchangeAdapter);
    expect(res.positions.map(p => `${p.exchange}:${p.side}`)).toEqual(["hyperliquid:long"]);
    expect(res.positionErrors).toEqual({ lighter: "429 Too Many Requests" });
    expect(res.notConfigured).toEqual(["pacifica"]);
    expect(arbPnlPairStatus(res.positions, Object.keys(res.positionErrors))).toBe("unknown");
  });

  it("adapter init failure is also reported", async () => {
    const res = await collectArbPnlPositions(["aster"], async () => { throw new Error("bad key"); });
    expect(res.positionErrors).toEqual({ aster: "bad key" });
  });

  it("pair status: both sides read → arb; one side with every venue read → single", () => {
    expect(arbPnlPairStatus([{ side: "long" }, { side: "short" }], ["lighter"])).toBe("arb");
    expect(arbPnlPairStatus([{ side: "long" }], [])).toBe("single");
  });
});

// ── M6: arb rebalance venue policy ──

describe("M6: arb rebalance — unavailable venue", () => {
  const get = async (ex: string): Promise<ExchangeAdapter> => {
    if (ex === "lighter") throw new Error("no API key");
    return { name: ex } as unknown as ExchangeAdapter;
  };

  it("explicitly listed venue → PerpError naming venue + cause", async () => {
    const err = await resolveRebalanceAdapters(["hyperliquid", "lighter"], true, get).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).message).toMatch(/lighter.*no API key/);
    expect((err as PerpError).structured.remediation).toBeTruthy();
  });

  it("default list → skipped with a warning naming venue + cause", async () => {
    const warn = vi.fn();
    const out = await resolveRebalanceAdapters(["hyperliquid", "lighter"], false, get, warn);
    expect([...out.keys()]).toEqual(["hyperliquid"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/lighter unavailable.*no API key/));
  });
});

// ── M10: spot-perp funding with no rate ──

describe("M10: spot-perp funding view", () => {
  it("missing perp rate → rate, direction and daily estimate are unknown (null), never 0", () => {
    expect(spotPerpFundingView(undefined, 1000)).toEqual({ hourlyRate: null, annualPct: null, direction: null, dailyFundingEstimate: null });
  });

  it("published rate → numbers and direction; the perp leg is short, so a negative rate is a daily cost", () => {
    const v = spotPerpFundingView({ exchange: "hyperliquid", rate: -0.0001, fundingHours: 1 }, 1000);
    expect(v.hourlyRate).toBeCloseTo(-0.0001);
    expect(v.direction).toBe("sell-spot-long-perp");
    expect(v.dailyFundingEstimate).toBeCloseTo(-2.4);
  });
});

describe("arb status text: funding can be a net cost", () => {
  it("a negative amount prints -$x", () => {
    expect(signedUsd(-1.5)).toBe("-$1.5000");
    expect(signedUsd(2)).toBe("$2.0000");
  });

  it("a negative portfolio APR keeps its Summary row; exactly 0 has none", () => {
    expect(portfolioAprLine(-12.34)).toContain("-12.3%");
    expect(portfolioAprLine(0)).toBeNull();
  });
});

// ── M13: Aster funding endpoint failure ──

describe("M13: basis scan reports an Aster endpoint failure", () => {
  it("Aster HTTP error is surfaced on stderr, not silently absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("asterdex")) return { ok: false, status: 503, json: async () => ({}) };
      throw new Error("offline");
    }));
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await handleBasisScan(() => true, { minBasis: "0" });
    expect(errs.some(e => /aster fetch failed: .*503/.test(e))).toBe(true);
  });
});
