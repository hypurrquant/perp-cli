/**
 * Adapter-shape regression for HyperliquidAdapter.getBalance /
 * getPositions after Phase 2.3 migrated 10 sites to
 * `parseFiniteVenueNumber` (shared util, qa/2026-05-16).
 *
 * Pre-migration, every `Number(... ?? 0)` site silently coerced NaN /
 * Infinity / non-numeric / empty-string venue payloads to 0 — surfacing
 * a phantom `$0 balance` indistinguishable from a real empty account.
 * The shared helper now throws EXCHANGE_ERROR tagged with
 * `exchange: "hyperliquid"`.
 *
 * Mirrors the lighter adapter-shape pattern that the same helper
 * displaced (the deleted `lighter-toFinite.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PerpError } from "../../errors.js";

vi.mock("../../cache.js", async () => ({
  withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  TTL_ACCOUNT: 1000,
  TTL_MARKETS: 1000,
  TTL_PRICES: 1000,
}));

async function buildAdapter(stateOrPos: { type: "balance" | "positions"; payload: unknown }) {
  const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
  const hl = new HyperliquidAdapter(undefined, false);
  hl.setAddress("0xabcdef0000000000000000000000000000000001");
  // Stub the abstraction mode probe so getBalance picks the "standard"
  // branch (most direct path to the new guards on margin.accountValue
  // and s.withdrawable).
  (hl as unknown as { _getAbstractionMode: () => Promise<string> })._getAbstractionMode =
    vi.fn().mockResolvedValue("standard");
  (hl as unknown as { _getClearinghouseState: () => Promise<unknown> })._getClearinghouseState =
    vi.fn().mockResolvedValue(stateOrPos.payload);
  return hl;
}

describe("HyperliquidAdapter.getBalance — parseFiniteVenueNumber guards (Phase 2.3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("standard mode: clean payload returns numeric balance unchanged", async () => {
    const hl = await buildAdapter({
      type: "balance",
      payload: {
        marginSummary: { totalMarginUsed: "200", accountValue: "1000" },
        crossMarginSummary: {},
        withdrawable: "800",
        assetPositions: [{ position: { unrealizedPnl: "50" } }],
      },
    });
    const bal = await hl.getBalance();
    expect(bal.equity).toBe("1000");
    expect(bal.available).toBe("800");
    expect(bal.marginUsed).toBe("200");
    expect(bal.unrealizedPnl).toBe("50");
  });

  it("throws EXCHANGE_ERROR when marginSummary.accountValue is NaN", async () => {
    const hl = await buildAdapter({
      type: "balance",
      payload: {
        marginSummary: { totalMarginUsed: "200", accountValue: "NaN" },
        crossMarginSummary: {},
        withdrawable: "800",
        assetPositions: [],
      },
    });
    // Note: avoid `.toThrow(PerpError)` here — vi.resetModules() in beforeEach
    // creates a fresh PerpError class per test run, so the instanceof check
    // fails against the test file's separately-imported PerpError. The message
    // regex below pins the contract without class-identity coupling.
    await expect(hl.getBalance()).rejects.toThrow(/marginSummary.accountValue.*not a finite/);
  });

  it("throws EXCHANGE_ERROR when withdrawable is an empty string '' (qa/2026-05-16 strict policy)", async () => {
    const hl = await buildAdapter({
      type: "balance",
      payload: {
        marginSummary: { totalMarginUsed: "200", accountValue: "1000" },
        crossMarginSummary: {},
        withdrawable: "",
        assetPositions: [],
      },
    });
    await expect(hl.getBalance()).rejects.toThrow(/withdrawable.*empty string/);
  });

  it("throws EXCHANGE_ERROR when a position's unrealizedPnl is non-numeric", async () => {
    const hl = await buildAdapter({
      type: "balance",
      payload: {
        marginSummary: { totalMarginUsed: "200", accountValue: "1000" },
        crossMarginSummary: {},
        withdrawable: "800",
        assetPositions: [{ position: { unrealizedPnl: "garbage" } }],
      },
    });
    await expect(hl.getBalance()).rejects.toThrow(/position.unrealizedPnl.*not a finite/);
  });

  it("tags structured.details.exchange = 'hyperliquid' on the thrown PerpError", async () => {
    const hl = await buildAdapter({
      type: "balance",
      payload: {
        marginSummary: { totalMarginUsed: "Infinity", accountValue: "1000" },
        crossMarginSummary: {},
        withdrawable: "800",
        assetPositions: [],
      },
    });
    try {
      await hl.getBalance();
      expect.fail("expected throw");
    } catch (e) {
      const err = e as PerpError;
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      expect((err.structured as { details?: { exchange?: string } }).details?.exchange).toBe("hyperliquid");
    }
  });
});

describe("HyperliquidAdapter.getPositions — parseFiniteVenueNumber guards (Phase 2.3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clean payload returns positions unchanged", async () => {
    const hl = await buildAdapter({
      type: "positions",
      payload: {
        assetPositions: [
          {
            position: {
              coin: "BTC", szi: "0.5", entryPx: "50000", positionValue: "25000",
              liquidationPx: "40000", unrealizedPnl: "0", leverage: { value: 10 },
            },
          },
        ],
      },
    });
    const positions = await hl.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("BTC");
    expect(positions[0].side).toBe("long");
    expect(positions[0].size).toBe("0.5");
    expect(positions[0].leverage).toBe(10);
  });

  it("throws when position.szi is NaN (was silently filtered as zero pre-Phase 2.3)", async () => {
    const hl = await buildAdapter({
      type: "positions",
      payload: {
        assetPositions: [{ position: { coin: "BTC", szi: "NaN" } }],
      },
    });
    await expect(hl.getPositions()).rejects.toThrow(/position.szi.*not a finite/);
  });

  it("throws when position.positionValue is non-numeric and present", async () => {
    const hl = await buildAdapter({
      type: "positions",
      payload: {
        assetPositions: [{
          position: {
            coin: "BTC", szi: "0.5", entryPx: "50000",
            positionValue: "abc", liquidationPx: "40000", unrealizedPnl: "0",
            leverage: { value: 10 },
          },
        }],
      },
    });
    await expect(hl.getPositions()).rejects.toThrow(/position.positionValue.*not a finite/);
  });

  it("leverage.value undefined falls back to default 1 (legitimate omission)", async () => {
    const hl = await buildAdapter({
      type: "positions",
      payload: {
        assetPositions: [{
          position: {
            coin: "BTC", szi: "0.5", entryPx: "50000", positionValue: "25000",
            liquidationPx: "40000", unrealizedPnl: "0", leverage: {},
          },
        }],
      },
    });
    const positions = await hl.getPositions();
    expect(positions[0].leverage).toBe(1);
  });
});
