/**
 * Adapter-shape regression for AsterAdapter.getBalance / getPositions
 * after Phase 2.4 migrated 7 sites to `parseFiniteVenueNumber`
 * (shared util, qa/2026-05-16).
 *
 * Pre-migration, every `Number(... ?? 0)` site silently coerced NaN /
 * empty-string / non-numeric venue payloads to 0 — phantom $0 balance
 * indistinguishable from a real empty account. The shared helper now
 * throws EXCHANGE_ERROR tagged with `exchange: "aster"`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

async function buildAdapter(account: unknown, positionRisk: unknown[] = []) {
  const { AsterAdapter } = await import("../../exchanges/aster.js");
  const ast = new AsterAdapter(undefined, false);
  // Stub _resolveSigner so getBalance doesn't try to pick an agent/master
  (ast as unknown as { _resolveSigner: () => unknown })._resolveSigner =
    vi.fn().mockReturnValue({ kind: "agent", signer: {}, agent: {} });
  // Route signed GETs by path: GET /fapi/v3/positionRisk (mark + liquidation
  // enrichment in getPositions) returns its own array; every other signed GET
  // (accountWithJoinMargin for getBalance/getPositions) returns `account`.
  (ast as unknown as { _signedGetEip712: (...args: unknown[]) => Promise<unknown> })._signedGetEip712 =
    vi.fn().mockImplementation((path: string) =>
      Promise.resolve(path === "/fapi/v3/positionRisk" ? positionRisk : account));
  // getPositions no longer calls _publicGet (positionRisk replaced the premiumIndex
  // mark-price probe); keep a defensive stub so any incidental public read is empty.
  (ast as unknown as { _publicGet: (...args: unknown[]) => Promise<unknown> })._publicGet =
    vi.fn().mockResolvedValue([]);
  // Bypass cache by clearing it on every call
  (ast as unknown as { _accountCache: unknown; _positionsCache: unknown })._accountCache = undefined;
  (ast as unknown as { _accountCache: unknown; _positionsCache: unknown })._positionsCache = undefined;
  return ast;
}

describe("AsterAdapter.getBalance — parseFiniteVenueNumber guards (Phase 2.4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clean payload returns numeric balance unchanged", async () => {
    const ast = await buildAdapter({
      totalWalletBalance: "1000", totalUnrealizedProfit: "50",
      availableBalance: "800", totalInitialMargin: "200",
    });
    const bal = await ast.getBalance();
    expect(bal.equity).toBe("1050");
    expect(bal.available).toBe("800");
    expect(bal.marginUsed).toBe("200");
    expect(bal.unrealizedPnl).toBe("50");
  });

  it("throws when totalWalletBalance is NaN", async () => {
    const ast = await buildAdapter({
      totalWalletBalance: "NaN", totalUnrealizedProfit: "50",
      availableBalance: "800", totalInitialMargin: "200",
    });
    await expect(ast.getBalance()).rejects.toThrow(/totalWalletBalance.*not a finite/);
  });

  it("throws when availableBalance is empty string '' (qa/2026-05-16 strict policy)", async () => {
    const ast = await buildAdapter({
      totalWalletBalance: "1000", totalUnrealizedProfit: "50",
      availableBalance: "", totalInitialMargin: "200",
    });
    await expect(ast.getBalance()).rejects.toThrow(/availableBalance.*empty string/);
  });

  it("tags structured.details.exchange = 'aster' on the thrown PerpError", async () => {
    const ast = await buildAdapter({
      totalWalletBalance: "Infinity", totalUnrealizedProfit: "50",
      availableBalance: "800", totalInitialMargin: "200",
    });
    try {
      await ast.getBalance();
      expect.fail("expected throw");
    } catch (e) {
      const err = e as { structured: { code: string; details?: { exchange?: string } } };
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      expect(err.structured.details?.exchange).toBe("aster");
    }
  });
});

describe("AsterAdapter.getPositions — parseFiniteVenueNumber guards (Phase 2.4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clean payload returns positions unchanged", async () => {
    const ast = await buildAdapter({
      totalWalletBalance: "1000", totalUnrealizedProfit: "0",
      availableBalance: "800", totalInitialMargin: "200",
      positions: [
        { symbol: "BTCUSDT", positionAmt: "0.5", entryPrice: "50000", unrealizedProfit: "0", leverage: "10" },
      ],
    });
    const pos = await ast.getPositions();
    expect(pos).toHaveLength(1);
    expect(pos[0].size).toBe("0.5");
    expect(pos[0].leverage).toBe(10);
  });

  it("throws when position.positionAmt is non-numeric", async () => {
    const ast = await buildAdapter({
      totalWalletBalance: "1000", totalUnrealizedProfit: "0",
      availableBalance: "800", totalInitialMargin: "200",
      positions: [{ symbol: "BTCUSDT", positionAmt: "abc", entryPrice: "50000", leverage: "10" }],
    });
    await expect(ast.getPositions()).rejects.toThrow(/position.positionAmt.*not a finite/);
  });

  it("leverage missing falls back to 1 (legitimate omission)", async () => {
    const ast = await buildAdapter({
      totalWalletBalance: "1000", totalUnrealizedProfit: "0",
      availableBalance: "800", totalInitialMargin: "200",
      positions: [{ symbol: "BTCUSDT", positionAmt: "0.5", entryPrice: "50000" }],
    });
    const pos = await ast.getPositions();
    expect(pos[0].leverage).toBe(1);
  });

  it("enriches markPrice + liquidationPrice from /fapi/v3/positionRisk", async () => {
    const ast = await buildAdapter(
      {
        totalWalletBalance: "1000", totalUnrealizedProfit: "0",
        availableBalance: "800", totalInitialMargin: "200",
        positions: [{ symbol: "BTCUSDT", positionAmt: "0.5", entryPrice: "50000", unrealizedProfit: "0", leverage: "10" }],
      },
      [{ symbol: "BTCUSDT", markPrice: "63000.5", liquidationPrice: "41250.7", positionAmt: "0.5" }],
    );
    const pos = await ast.getPositions();
    expect(pos).toHaveLength(1);
    expect(pos[0].markPrice).toBe("63000.5");
    expect(pos[0].liquidationPrice).toBe("41250.7");
  });

  it("mark/liquidation fall back to '0' when positionRisk omits the symbol (best-effort)", async () => {
    const ast = await buildAdapter(
      {
        totalWalletBalance: "1000", totalUnrealizedProfit: "0",
        availableBalance: "800", totalInitialMargin: "200",
        positions: [{ symbol: "BTCUSDT", positionAmt: "0.5", entryPrice: "50000", leverage: "10" }],
      },
      [], // positionRisk returns no rows → no enrichment
    );
    const pos = await ast.getPositions();
    expect(pos[0].markPrice).toBe("0");
    expect(pos[0].liquidationPrice).toBe("0");
  });
});
