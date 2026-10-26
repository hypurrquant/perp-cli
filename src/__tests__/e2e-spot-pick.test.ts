/**
 * E2E runner spot-phase auto-selection (scripts/e2e/lib.ts pickSpotMarket). Live testnet run
 * 2026-10-02: `--venue hyperliquid --phase all` stopped with preflight-failed "spot phase needs
 * --spot-symbol and --spot-size". The runner now picks the most liquid quote-asset spot market
 * whose minimum order fits the cap. Fixtures: public testnet data read 2026-10-02.
 */
import { describe, it, expect } from "vitest";
import { isBookRejection, NO_TWO_SIDED_BOOK, pickSpotMarket, pickSpotMarketWithBook, spotBookProblem, type SpotBook, type SpotCandidate } from "../../scripts/e2e/lib.js";

// POST https://api.hyperliquid-testnet.xyz/info {type:"spotMetaAndAssetCtxs"} — top pairs by dayNtlVlm.
const HL_TESTNET: SpotCandidate[] = [
  { symbol: "PUCKY", quote: "USDC", mark: 29.4, twoSided: true, mid: 30.962, volume24hUsd: 27030.96384, step: "1", minSize: null, minNotional: 10, bookRef: "@1204" },
  { symbol: "PURR", quote: "USDC", mark: 4.6252, twoSided: true, mid: 4.60235, volume24hUsd: 6067.7597, step: "1", minSize: null, minNotional: 10, bookRef: "PURR/USDC" },
  { symbol: "TTW1", quote: "USDC", mark: 0.8, twoSided: true, mid: 0.7625, volume24hUsd: 519.48, step: "0.01", minSize: null, minNotional: 10, bookRef: "@1300" },
  { symbol: "PURR", quote: "DENIM", mark: 46, twoSided: true, mid: 92.5, volume24hUsd: 89.3872, step: "1", minSize: null, minNotional: 10, bookRef: "@1325" },
  { symbol: "KANAMA", quote: "USDC", mark: 0.0037, twoSided: false, mid: null, volume24hUsd: 0, step: "1", minSize: null, minNotional: 10, bookRef: "@9" },
];
// GET https://testnet.zklighter.elliot.ai/api/v1/orderBooks?filter=spot + orderBookDetails?filter=spot
const LT_TESTNET: SpotCandidate[] = [
  { symbol: "ETH", quote: "USDC", mark: 2700, twoSided: null, mid: null, volume24hUsd: 113.67, step: "0.0001", minSize: 0.005, minNotional: 10, bookRef: "4098" },
  { symbol: "LIT", quote: "USDC", mark: null, twoSided: null, mid: null, volume24hUsd: 0, step: "0.01", minSize: 1, minNotional: 0.001, bookRef: "4099" },
];

describe("pickSpotMarket", () => {
  it("HL testnet: skips the top-volume pair whose book mid is > 2% off its mark, picks PURR at the $15 order floor", () => {
    const { pick, rejected } = pickSpotMarket(HL_TESTNET, "USDC", 100, 100, null);
    expect(pick).toMatchObject({ symbol: "PURR", size: "4" }); // ceil(max(15, 10 × 1.1) / 4.6252) = ceil(3.24) = 4
    expect(pick!.notional).toBeGreaterThanOrEqual(15);
    expect(rejected).toEqual(expect.arrayContaining([
      { symbol: "PUCKY", reason: expect.stringMatching(/> 2% off the mark/) },
      { symbol: "PURR", reason: "quote DENIM (need USDC)" },
      { symbol: "KANAMA", reason: "no two-sided book" },
    ]));
  });

  it("Lighter testnet: min size vs min notional vs the $15 floor → the largest, on the size grid; no price → rejected", () => {
    const { pick, rejected } = pickSpotMarket(LT_TESTNET, "USDC", 100, 100, null);
    expect(pick).toMatchObject({ symbol: "ETH", size: "0.0056" }); // 15 / 2700 = 0.00556 → 0.0056 > min size 0.005 > 11 / 2700
    expect(pickSpotMarket(LT_TESTNET, "USDC", 100, 100, null, 0).pick).toMatchObject({ symbol: "ETH", size: "0.0050" }); // no floor: min size wins
    expect(rejected).toEqual([{ symbol: "LIT", reason: "no public price" }]);
  });

  it("a venue minimum above the $15 floor wins (× the 1.1 buffer)", () => {
    const { pick } = pickSpotMarket([{ ...LT_TESTNET[0], minSize: null, minNotional: 20 }], "USDC", 100, 100, null);
    expect(pick).toMatchObject({ symbol: "ETH", size: "0.0082" }); // 20 × 1.1 / 2700 = 0.00815 → 0.0082
  });

  it("cap too small → no pick, with every reason (the runner fails with them)", () => {
    const { pick, rejected } = pickSpotMarket(LT_TESTNET, "USDC", 12, 100, null);
    expect(pick).toBeNull();
    expect(rejected[0]).toEqual({ symbol: "ETH", reason: expect.stringMatching(/worst case > cap \$12/) });
  });

  it("a market with no published minimum is never sized on a guess", () => {
    const { pick, rejected } = pickSpotMarket([{ ...LT_TESTNET[0], minSize: null, minNotional: null }], "USDC", 100, 100, null);
    expect(pick).toBeNull();
    expect(rejected[0].reason).toBe("no published minimum order");
  });

  it("volume ranks first; unpublished volume ranks last", () => {
    const a = { ...LT_TESTNET[0], symbol: "A", volume24hUsd: null };
    const b = { ...LT_TESTNET[0], symbol: "B", volume24hUsd: 1 };
    expect(pickSpotMarket([a, b], "USDC", 100, 100, null).pick?.symbol).toBe("B");
  });
});

// Live testnet 2026-10-02 (round 8): HL PUCKY passed the ctx midPx (31.498 vs mark 30.981) but its
// l2Book had one side → spot-buy PRICE_STALE; Lighter RH ETH/USDC had a last price but no asks →
// ORDER_REJECTED "No asks in ETH/USDC spot orderbook". The live book is now read per ranked market.
describe("pickSpotMarketWithBook (live two-sided book, every venue)", () => {
  // POST https://api.hyperliquid-testnet.xyz/info {type:"l2Book", coin:"PURR/USDC"} — best bid 4.5795 (asks present).
  const books: Record<string, SpotBook> = {
    "@1204": { bestBid: 30.5, bestAsk: null },            // PUCKY: bids only
    "PURR/USDC": { bestBid: 4.5795, bestAsk: 4.6 },
    "@1300": { bestBid: 0.79, bestAsk: 0.81 },
  };
  const read = (ref: string) => { const b = books[ref]; if (b === undefined) throw new Error(`no fixture ${ref}`); return Promise.resolve(b); };

  it("HL testnet: the preferred major (PURR) is ranked first and picked on a two-sided book", async () => {
    const reads: string[] = [];
    const { pick } = await pickSpotMarketWithBook(HL_TESTNET, "USDC", 100, 100, "PURR", ref => { reads.push(ref); return read(ref); });
    expect(pick).toMatchObject({ symbol: "PURR", size: "4", bookRef: "PURR/USDC" });
    expect(reads).toEqual(["PURR/USDC"]);
  });

  it("a one-sided top-volume book is rejected and the next ranked market is read", async () => {
    const cands = HL_TESTNET.map(c => (c.symbol === "PUCKY" ? { ...c, mid: c.mark } : c)); // ctx mid passes the static check
    const { pick, rejected } = await pickSpotMarketWithBook(cands, "USDC", 100, 100, null, read);
    expect(pick?.symbol).toBe("PURR");
    expect(rejected).toContainEqual({ symbol: "PUCKY", reason: NO_TWO_SIDED_BOOK });
  });

  it("Lighter RH testnet: ETH/USDC without asks → no pick, every reason a book rejection (runner SKIPs spot)", async () => {
    const lrh: SpotCandidate[] = [{ ...LT_TESTNET[0], mark: 2600 }];
    const { pick, rejected } = await pickSpotMarketWithBook(lrh, "USDC", 100, 100, null, () => Promise.resolve({ bestBid: 2550, bestAsk: null }));
    expect(pick).toBeNull();
    expect(rejected).toEqual([{ symbol: "ETH", reason: NO_TWO_SIDED_BOOK }]);
    expect(rejected.every(r => isBookRejection(r.reason))).toBe(true);
  });

  it("Lighter testnet (live 2026-10-02): LIT no price + ETH/USDC asks only → no pick, all venue limitations (SKIP, not a cap failure)", async () => {
    // GET /api/v1/orderBookOrders?market_id=4098&limit=3 → total_asks 1 (2700.00), total_bids 0.
    const { pick, rejected } = await pickSpotMarketWithBook(LT_TESTNET, "USDC", 100, 100, "ETH", () => Promise.resolve({ bestBid: null, bestAsk: 2700 }));
    expect(pick).toBeNull();
    expect(rejected).toEqual([{ symbol: "LIT", reason: "no public price" }, { symbol: "ETH", reason: NO_TWO_SIDED_BOOK }]);
    expect(rejected.every(r => isBookRejection(r.reason))).toBe(true);
  });

  it("a book mid > 2% off the mark is rejected (thin / broken book)", async () => {
    const { pick, rejected } = await pickSpotMarketWithBook([LT_TESTNET[0]], "USDC", 100, 100, "ETH", () => Promise.resolve({ bestBid: 2400, bestAsk: 2500 }));
    expect(pick).toBeNull();
    expect(rejected[0].reason).toMatch(/^book mid 2450 is > 2% off the mark 2700/);
    expect(isBookRejection(rejected[0].reason)).toBe(true);
  });

  it("a failed book read throws — never treated as a usable or an empty book", async () => {
    await expect(pickSpotMarketWithBook([LT_TESTNET[0]], "USDC", 100, 100, null, () => Promise.reject(new Error("HTTP 502"))))
      .rejects.toThrow("HTTP 502");
  });

  it("cap rejections are not book rejections (the runner fails, not skips)", () => {
    expect(isBookRejection("minimum order 1 ≈ $30 worst case > cap $12")).toBe(false);
    expect(spotBookProblem({ bestBid: 0, bestAsk: 1 }, 1)).toBe(NO_TWO_SIDED_BOOK);
    expect(spotBookProblem({ bestBid: 99, bestAsk: 101 }, 100)).toBeNull();
  });
});
