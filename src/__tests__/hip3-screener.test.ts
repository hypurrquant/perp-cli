import { describe, it, expect, vi } from "vitest";
import {
  computeBookScore,
  screenHip3Markets,
  resolveScreenerConfig,
  DEFAULT_SCREENER_CONFIG,
  Hip3MarketRotation,
  DEFAULT_ROTATION_CONFIG,
  type Hip3Candidate,
  type OrderbookSnapshot,
  type ScoredMarket,
  type MmHooks,
} from "../bot/screeners/hip3-screener.js";

// ────────────────────────────────────────────────────────────
//  Fixture helpers
// ────────────────────────────────────────────────────────────

function candidate(dex: string, base: string, price = 100): Hip3Candidate {
  return {
    coin: `${dex}:${base}`,
    base,
    dex,
    markPrice: price,
    szDecimals: 2,
    maxLeverage: 5,
    openInterest: 0,
    volume24h: 0,
  };
}

function book(bestBid: number, bestAsk: number, depth = 10): OrderbookSnapshot {
  // Build a 5-level book symmetrically around the provided BBO.
  const tick = (bestAsk - bestBid) || 0.01;
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 0; i < 5; i++) {
    bids.push([String(bestBid - tick * i), String(depth)]);
    asks.push([String(bestAsk + tick * i), String(depth)]);
  }
  return { bids, asks };
}

function scored(coin: string, scoreValue: number): ScoredMarket {
  const [dex, base] = coin.split(":");
  return {
    ...candidate(dex, base),
    score: {
      spreadBps: 100,
      depthUsd: 10_000,
      score: scoreValue,
      mid: 100,
      bestBid: 99,
      bestAsk: 101,
    },
  };
}

// ════════════════════════════════════════════════════════════
//  computeBookScore — pure scoring
// ════════════════════════════════════════════════════════════

describe("computeBookScore", () => {
  it("returns null on empty bids", () => {
    expect(computeBookScore([], [["100", "1"]])).toBeNull();
  });

  it("returns null on empty asks", () => {
    expect(computeBookScore([["100", "1"]], [])).toBeNull();
  });

  it("returns null on crossed book", () => {
    // best bid 101 vs best ask 100 → crossed
    expect(computeBookScore([["101", "1"]], [["100", "1"]])).toBeNull();
  });

  it("returns null on equal bid/ask (zero spread)", () => {
    expect(computeBookScore([["100", "1"]], [["100", "1"]])).toBeNull();
  });

  it("computes spreadBps for a normal top-1 book", () => {
    const res = computeBookScore([["100", "2"]], [["101", "2"]]);
    expect(res).not.toBeNull();
    // spread = 1, mid = 100.5, bps = 1/100.5*10000 ≈ 99.5025
    expect(res!.spreadBps).toBeCloseTo(99.5025, 3);
    expect(res!.bestBid).toBe(100);
    expect(res!.bestAsk).toBe(101);
    expect(res!.mid).toBe(100.5);
  });

  it("sums depth across top-5 levels both sides, ignoring level 6+", () => {
    // Use 6 levels so we can verify the 5-level cap.
    const bids: [string, string][] = [
      ["100", "1"], ["99", "1"], ["98", "1"], ["97", "1"], ["96", "1"], ["95", "9999"],
    ];
    const asks: [string, string][] = [
      ["101", "1"], ["102", "1"], ["103", "1"], ["104", "1"], ["105", "1"], ["106", "9999"],
    ];
    const res = computeBookScore(bids, asks);
    // Top-5 bids: 100+99+98+97+96 = 490
    // Top-5 asks: 101+102+103+104+105 = 515
    // Total: 1005. Level 6 (95 / 106) is ignored.
    expect(res!.depthUsd).toBeCloseTo(1005, 3);
  });

  it("score formula matches spreadBps * sqrt(max(depthUsd, 1))", () => {
    const res = computeBookScore([["100", "2"]], [["101", "2"]]);
    // depth = 200 + 202 = 402, spreadBps ≈ 99.5025
    // score ≈ 99.5025 * sqrt(402)
    const expected = 99.5025 * Math.sqrt(402);
    expect(res!.score).toBeCloseTo(expected, 1);
  });

  it("handles large (million-dollar) books without overflow", () => {
    const big = [["100000", "100"]] as [string, string][];
    const bigAsk = [["100001", "100"]] as [string, string][];
    const res = computeBookScore(big, bigAsk);
    expect(res).not.toBeNull();
    expect(Number.isFinite(res!.score)).toBe(true);
  });

  it("ignores non-numeric levels gracefully without crashing", () => {
    const bids: [string, string][] = [["100", "2"], ["bad", "junk"], ["98", "1"]];
    const asks: [string, string][] = [["101", "2"]];
    const res = computeBookScore(bids, asks);
    expect(res).not.toBeNull();
    // Depth is Σ(px * sz), with the bad row silently skipped:
    //   bids: 100*2 + (skipped) + 98*1 = 298
    //   asks: 101*2 = 202
    // Total: 500
    expect(res!.depthUsd).toBeCloseTo(298 + 202, 3);
  });
});

// ════════════════════════════════════════════════════════════
//  resolveScreenerConfig
// ════════════════════════════════════════════════════════════

describe("resolveScreenerConfig", () => {
  it("returns defaults when no overrides", () => {
    expect(resolveScreenerConfig()).toEqual(DEFAULT_SCREENER_CONFIG);
  });

  it("merges overrides on top of defaults", () => {
    const cfg = resolveScreenerConfig({ minSpreadBps: 50, maxL2Calls: 5 });
    expect(cfg.minSpreadBps).toBe(50);
    expect(cfg.maxL2Calls).toBe(5);
    // untouched defaults remain
    expect(cfg.minDepthUsd).toBe(DEFAULT_SCREENER_CONFIG.minDepthUsd);
    expect(cfg.minScore).toBe(DEFAULT_SCREENER_CONFIG.minScore);
  });
});

// ════════════════════════════════════════════════════════════
//  screenHip3Markets — orchestrator
// ════════════════════════════════════════════════════════════

describe("screenHip3Markets", () => {
  it("returns empty array for empty candidates without calling fetchBook", async () => {
    const fetchBook = vi.fn();
    const result = await screenHip3Markets({ candidates: [], fetchBook });
    expect(result).toEqual([]);
    expect(fetchBook).not.toHaveBeenCalled();
  });

  it("scores candidates and sorts by score descending", async () => {
    const cands = [
      candidate("xyz", "A"),
      candidate("flx", "B"),
      candidate("km", "C"),
    ];
    const fetchBook = vi.fn(async (coin: string): Promise<OrderbookSnapshot | null> => {
      if (coin === "xyz:A") return book(100, 101, 10);      // tight + shallow
      if (coin === "flx:B") return book(100, 110, 50);      // wide + deep → highest score
      if (coin === "km:C") return book(100, 105, 20);       // mid
      return null;
    });
    const result = await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { minSpreadBps: 5, minDepthUsd: 100, maxL2Calls: 10 },
    });
    expect(result.map(m => m.coin)).toEqual(["flx:B", "km:C", "xyz:A"]);
    // Sorted strictly descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score.score).toBeGreaterThanOrEqual(result[i].score.score);
    }
  });

  it("respects maxL2Calls budget — only calls fetchBook up to the cap", async () => {
    const cands = Array.from({ length: 10 }, (_, i) => candidate("xyz", `A${i}`));
    const fetchBook = vi.fn(async () => book(100, 105, 10));
    await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { maxL2Calls: 3, minSpreadBps: 5, minDepthUsd: 0 },
    });
    expect(fetchBook).toHaveBeenCalledTimes(3);
  });

  it("filters out markets below minSpreadBps", async () => {
    const cands = [candidate("xyz", "TIGHT"), candidate("xyz", "WIDE")];
    const fetchBook: (c: string) => Promise<OrderbookSnapshot | null> = async (coin) => {
      if (coin === "xyz:TIGHT") return book(100, 100.01, 10);  // ≈ 1 bps
      return book(100, 105, 10);                                // ≈ 488 bps
    };
    const result = await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { minSpreadBps: 10, minDepthUsd: 0 },
    });
    expect(result.map(m => m.coin)).toEqual(["xyz:WIDE"]);
  });

  it("filters out markets below minDepthUsd", async () => {
    const cands = [candidate("xyz", "THIN"), candidate("xyz", "THICK")];
    const fetchBook: (c: string) => Promise<OrderbookSnapshot | null> = async (coin) => {
      if (coin === "xyz:THIN") return book(100, 105, 0.01);   // trivial depth
      return book(100, 105, 100);                              // plenty
    };
    const result = await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { minSpreadBps: 0, minDepthUsd: 1000 },
    });
    expect(result.map(m => m.coin)).toEqual(["xyz:THICK"]);
  });

  it("drops dexes that are not in config.dexes before spending call budget", async () => {
    const cands = [
      candidate("xyz", "A"),
      candidate("flx", "B"),
      candidate("km", "C"),
    ];
    const fetchBook = vi.fn(async () => book(100, 105, 10));
    await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { dexes: ["xyz", "km"], minSpreadBps: 0, minDepthUsd: 0, maxL2Calls: 20 },
    });
    expect(fetchBook).toHaveBeenCalledTimes(2);
    const called = fetchBook.mock.calls.map(c => c[0]);
    expect(called).not.toContain("flx:B");
  });

  it("drops coins that are not in config.coins before spending call budget", async () => {
    const cands = [
      candidate("xyz", "TSLA"),
      candidate("xyz", "NVDA"),
      candidate("flx", "TSLA"),
    ];
    const fetchBook = vi.fn(async () => book(100, 105, 10));
    await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { coins: ["TSLA"], minSpreadBps: 0, minDepthUsd: 0, maxL2Calls: 20 },
    });
    expect(fetchBook).toHaveBeenCalledTimes(2);
    const called = fetchBook.mock.calls.map(c => c[0]);
    expect(called).toEqual(expect.arrayContaining(["xyz:TSLA", "flx:TSLA"]));
    expect(called).not.toContain("xyz:NVDA");
  });

  it("survives fetchBook errors for individual coins and still consumes their budget slot", async () => {
    const cands = [candidate("xyz", "OK"), candidate("xyz", "BROKEN"), candidate("xyz", "OK2")];
    const fetchBook = vi.fn(async (coin: string): Promise<OrderbookSnapshot | null> => {
      if (coin === "xyz:BROKEN") throw new Error("network");
      return book(100, 105, 10);
    });
    const result = await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { minSpreadBps: 0, minDepthUsd: 0, minScore: 0 },
    });
    expect(result.map(m => m.coin).sort()).toEqual(["xyz:OK", "xyz:OK2"]);
    // Budget accounting: all three slots are consumed regardless of throw
    // (rate-limit weight is already spent by the HTTP request that failed).
    expect(fetchBook).toHaveBeenCalledTimes(3);
  });

  it("applies per-symbol minSpreadBps override (can only raise, never lower)", async () => {
    const cands = [candidate("xyz", "A"), candidate("vntl", "SPACEX")];
    const fetchBook: FetchBook = async (coin) => {
      // Both at ~488 bps, above the global 10 but...
      // vntl:SPACEX override = 1000 bps → filtered out.
      // xyz:A has no override → passes.
      return book(100, 105, 10);
    };
    const result = await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: {
        minSpreadBps: 10,
        minDepthUsd: 0,
        symbolMinSpreadBps: { "vntl:SPACEX": 1000 },
      },
    });
    expect(result.map(m => m.coin)).toEqual(["xyz:A"]);
  });

  it("null fetchBook result is treated as 'skip' without throwing", async () => {
    const cands = [candidate("xyz", "A"), candidate("xyz", "NULL")];
    const fetchBook: FetchBook = async (coin) => {
      if (coin === "xyz:NULL") return null;
      return book(100, 105, 10);
    };
    const result = await screenHip3Markets({
      candidates: cands,
      fetchBook,
      config: { minSpreadBps: 0, minDepthUsd: 0 },
    });
    expect(result.map(m => m.coin)).toEqual(["xyz:A"]);
  });
});

// ════════════════════════════════════════════════════════════
//  Hip3MarketRotation — state machine
// ════════════════════════════════════════════════════════════

describe("Hip3MarketRotation", () => {
  it("enters top N markets by score on the first update (empty → top 2)", () => {
    const rot = new Hip3MarketRotation({ maxActive: 2 });
    const delta = rot.update([scored("xyz:A", 100), scored("xyz:B", 200), scored("xyz:C", 50)]);
    expect(delta.entered.map(m => m.coin)).toEqual(["xyz:B", "xyz:A"]);
    expect(delta.exited).toEqual([]);
    expect(rot.activeMarkets().sort()).toEqual(["xyz:A", "xyz:B"]);
  });

  it("is idempotent — re-applying the same scored list yields empty delta", () => {
    const rot = new Hip3MarketRotation({ maxActive: 2 });
    const list = [scored("xyz:A", 100), scored("xyz:B", 200)];
    rot.update(list);
    const delta = rot.update(list);
    expect(delta.entered).toEqual([]);
    expect(delta.exited).toEqual([]);
  });

  it("exits a market that degrades below entryScore × exitScoreRatio", () => {
    const rot = new Hip3MarketRotation({ maxActive: 3, exitScoreRatio: 0.5 });
    rot.update([scored("xyz:A", 100), scored("xyz:B", 200)]);
    // xyz:A halved → 49 < 100 * 0.5, should exit. xyz:B still healthy.
    const delta = rot.update([scored("xyz:A", 49), scored("xyz:B", 200)]);
    expect(delta.exited).toEqual(["xyz:A"]);
    expect(rot.activeMarkets()).toEqual(["xyz:B"]);
  });

  it("exits a market that disappears from the scored list entirely", () => {
    const rot = new Hip3MarketRotation({ maxActive: 3 });
    rot.update([scored("xyz:A", 100), scored("xyz:B", 200)]);
    const delta = rot.update([scored("xyz:B", 200)]);
    expect(delta.exited).toEqual(["xyz:A"]);
    expect(rot.activeMarkets()).toEqual(["xyz:B"]);
  });

  it("replaces the weakest active when a higher-scoring candidate appears at maxActive cap", () => {
    const rot = new Hip3MarketRotation({ maxActive: 2 });
    rot.update([scored("xyz:A", 100), scored("xyz:B", 200)]);
    const delta = rot.update([
      scored("xyz:A", 100),
      scored("xyz:B", 200),
      scored("xyz:C", 500), // newcomer with best score
    ]);
    // xyz:A (lowest active) should be evicted in favour of xyz:C
    expect(delta.exited).toEqual(["xyz:A"]);
    expect(delta.entered.map(m => m.coin)).toEqual(["xyz:C"]);
    expect(rot.activeMarkets().sort()).toEqual(["xyz:B", "xyz:C"]);
  });

  it("does not replace when the newcomer is weaker than all active markets", () => {
    const rot = new Hip3MarketRotation({ maxActive: 2 });
    rot.update([scored("xyz:A", 100), scored("xyz:B", 200)]);
    const delta = rot.update([
      scored("xyz:A", 100),
      scored("xyz:B", 200),
      scored("xyz:C", 10), // weaker than both active
    ]);
    expect(delta.entered).toEqual([]);
    expect(delta.exited).toEqual([]);
  });

  it("invokes onMarketEntered / onMarketExited hooks exactly once per transition", () => {
    const entered: string[] = [];
    const exited: string[] = [];
    const hooks: MmHooks = {
      onMarketEntered: (m) => entered.push(m.coin),
      onMarketExited: (c) => exited.push(c),
    };
    const rot = new Hip3MarketRotation({ maxActive: 2 }, hooks);
    rot.update([scored("xyz:A", 100), scored("xyz:B", 200)]);
    rot.update([scored("xyz:A", 49), scored("xyz:B", 200), scored("xyz:C", 300)]);
    expect(entered).toEqual(["xyz:B", "xyz:A", "xyz:C"]);
    expect(exited).toEqual(["xyz:A"]);
  });

  it("accepts an isSelfOrder hook scaffold (Option B #3) without affecting rotation behaviour", () => {
    const isSelfOrder = vi.fn(() => false);
    const hooks: MmHooks = { isSelfOrder };
    const rot = new Hip3MarketRotation({ maxActive: 1 }, hooks);
    rot.update([scored("xyz:A", 100)]);
    // Rotation itself never calls isSelfOrder — it's a scaffold for future
    // MM strategies. Verify the signature is callable by downstream code:
    expect(hooks.isSelfOrder!("xyz:A", "buy", 100)).toBe(false);
    // Rotation state unaffected
    expect(rot.activeMarkets()).toEqual(["xyz:A"]);
  });

  it("uses DEFAULT_ROTATION_CONFIG when no overrides are provided", () => {
    const rot = new Hip3MarketRotation();
    const list = Array.from({ length: 10 }, (_, i) => scored(`xyz:C${i}`, 100 - i));
    const delta = rot.update(list);
    expect(delta.entered.length).toBe(DEFAULT_ROTATION_CONFIG.maxActive);
  });
});

import type { FetchBook } from "../bot/screeners/hip3-screener.js";
