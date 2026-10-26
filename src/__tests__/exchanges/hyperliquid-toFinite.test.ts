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

async function buildAdapter(stateOrPos: {
  type: "balance" | "positions";
  payload: unknown;
  mode?: "standard" | "unified" | "portfolio";
  spotPayload?: unknown;
  collateralToken?: number;
  /** info spotMetaAndAssetCtxs (portfolio-margin pricing). */
  spotMeta?: unknown;
}) {
  const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
  const hl = new HyperliquidAdapter(undefined, false);
  hl.setAddress("0xabcdef0000000000000000000000000000000001");
  // Default to "standard" mode (most direct path to the guards on
  // margin.accountValue and s.withdrawable). Override via opts.mode to
  // exercise the spot-USDC and portfolio-collateral branches.
  (hl as unknown as { _getAbstractionMode: () => Promise<string> })._getAbstractionMode =
    vi.fn().mockResolvedValue(stateOrPos.mode ?? "standard");
  (hl as unknown as { _getClearinghouseState: () => Promise<unknown> })._getClearinghouseState =
    vi.fn().mockResolvedValue(stateOrPos.payload);
  (hl as unknown as { _getSpotClearinghouseState: () => Promise<unknown> })._getSpotClearinghouseState =
    vi.fn().mockResolvedValue(stateOrPos.spotPayload ?? { balances: [] });
  // Collateral token index (meta.collateralToken) — USDC = 0 unless overridden.
  (hl as unknown as { _getCollateralToken: () => Promise<number> })._getCollateralToken =
    vi.fn().mockResolvedValue(stateOrPos.collateralToken ?? 0);
  (hl as unknown as { _infoPost: (b: { type: string }) => Promise<unknown> })._infoPost = vi.fn(async (b: { type: string }) => {
    if (b.type === "spotMetaAndAssetCtxs" && stateOrPos.spotMeta !== undefined) return stateOrPos.spotMeta;
    throw new Error(`unexpected info ${b.type}`);
  });
  return hl;
}

/** spotMetaAndAssetCtxs with USDC-quoted pairs: HYPE (150) @ 80, UBTC (197) @ 60000. */
const SPOT_META = [
  { universe: [{ tokens: [150, 0], index: 0 }, { tokens: [197, 0], index: 1 }] },
  [{ markPx: "80", dayNtlVlm: "1000" }, { markPx: "60000", dayNtlVlm: "1000" }],
];

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

// ─── Supplementary verification (보조 검증) ──────────────────────────────────
//
// Phase B docker QA only exercised HL `unified` mode (the user's mainnet
// account abstraction setting). The `standard` mode (the test default
// above) and the new `unified`/`portfolio` branches were not reachable
// in live QA — flipping the user's HL account-mode via
// `perp wallet manage account-mode <mode>` writes to the venue and
// requires explicit user consent (STRICT rule, QA workflow §3).
//
// Unit-level coverage below pins the spot-USDC + portfolio-collateral
// guard paths that the live QA could not reach. Code paths exercised:
//   - unified mode: src/exchanges/hyperliquid.ts:506-507 (spot USDC total/hold)
//   - portfolio mode: src/exchanges/hyperliquid.ts:513 (non-USDC filter)
describe("HyperliquidAdapter.getBalance — unified mode spot-USDC guards", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("unified mode: clean spot USDC payload computes equity from spotTotal", async () => {
    const hl = await buildAdapter({
      type: "balance",
      mode: "unified",
      payload: {
        marginSummary: { totalMarginUsed: "0" },
        crossMarginSummary: {},
        withdrawable: "0",
        assetPositions: [],
      },
      spotPayload: {
        balances: [
          { coin: "USDC", token: 0, total: "1000", hold: "100" },
        ],
      },
    });
    const bal = await hl.getBalance();
    expect(bal.equity).toBe("1000");
    expect(bal.available).toBe("900");
  });

  it("unified mode: throws when spot USDC total is NaN", async () => {
    const hl = await buildAdapter({
      type: "balance",
      mode: "unified",
      payload: {
        marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {},
        withdrawable: "0", assetPositions: [],
      },
      spotPayload: {
        balances: [{ coin: "USDC", token: 0, total: "NaN", hold: "0" }],
      },
    });
    await expect(hl.getBalance()).rejects.toThrow(/spotBalance.USDC.total.*not a finite/);
  });

  it("unified mode: throws when spot USDC hold is empty string '' (qa/2026-05-16 strict policy)", async () => {
    const hl = await buildAdapter({
      type: "balance",
      mode: "unified",
      payload: {
        marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {},
        withdrawable: "0", assetPositions: [],
      },
      spotPayload: {
        balances: [{ coin: "USDC", token: 0, total: "1000", hold: "" }],
      },
    });
    await expect(hl.getBalance()).rejects.toThrow(/spotBalance.USDC.hold.*empty string/);
  });
});

describe("HyperliquidAdapter.getBalance — portfolio margin equity", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  const PM_STATE = { marginSummary: { totalMarginUsed: "5" }, crossMarginSummary: {}, withdrawable: "0", assetPositions: [{ position: { unrealizedPnl: "1.5" } }] };

  // Shape of a live portfolio-margin account (2026-10-26): borrowed USDC (negative total), HYPE
  // supplied as collateral (ltv), a memecoin without ltv.
  it("equity = collateral token total + Σ ltv collateral × spot USDC price; non-collateral rows are not counted", async () => {
    const hl = await buildAdapter({
      type: "balance", mode: "portfolio", payload: PM_STATE, spotMeta: SPOT_META,
      spotPayload: {
        portfolioMarginRatio: "0.52",
        balances: [
          { coin: "USDC", token: 0, total: "-18", hold: "-28", ltv: "0.0", borrowed: "23" },
          { coin: "HYPE", token: 150, total: "0.5", hold: "0.3", ltv: "0.65", supplied: "0.5" },
          { coin: "FATCAT", token: 126, total: "43", hold: "0" },
        ],
      },
    });
    const bal = await hl.getBalance() as unknown as Record<string, unknown>;
    expect(Number(bal.equity)).toBeCloseTo(-18 + 0.5 * 80, 9); // 22
    expect(bal.available).toBe("10"); // USDC total − hold
    expect(bal.marginUsed).toBe("5");
    expect(bal.portfolioMarginRatio).toBe("0.52");
    expect(bal.collateral).toEqual([
      { token: "USDC", total: "-18", priceUsd: "1", valueUsd: "-18", ltv: "0.0", borrowed: "23", supplied: null },
      { token: "HYPE", total: "0.5", priceUsd: "80", valueUsd: "40", ltv: "0.65", borrowed: null, supplied: "0.5" },
    ]);
  });

  it("throws when a collateral total is NaN (corruption is never filtered out)", async () => {
    const hl = await buildAdapter({
      type: "balance", mode: "portfolio", payload: PM_STATE, spotMeta: SPOT_META,
      spotPayload: { balances: [{ coin: "USDC", token: 0, total: "500", hold: "0", ltv: "0.0" }, { coin: "HYPE", token: 150, total: "NaN", hold: "0", ltv: "0.65" }] },
    });
    await expect(hl.getBalance()).rejects.toThrow(/spotBalance.HYPE.total.*not a finite/);
  });

  it("throws when a collateral total is empty string ''", async () => {
    const hl = await buildAdapter({
      type: "balance", mode: "portfolio", payload: PM_STATE, spotMeta: SPOT_META,
      spotPayload: { balances: [{ coin: "USDC", token: 0, total: "500", hold: "0" }, { coin: "UBTC", token: 197, total: "", hold: "0", ltv: "0.5" }] },
    });
    await expect(hl.getBalance()).rejects.toThrow(/spotBalance.UBTC.total.*empty string/);
  });

  it("a held collateral token without a USDC spot price → PRICE_STALE (never valued at a guess)", async () => {
    const hl = await buildAdapter({
      type: "balance", mode: "portfolio", payload: PM_STATE, spotMeta: SPOT_META,
      spotPayload: { balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }, { coin: "USDT0", token: 268, total: "50", hold: "0", ltv: "0.9" }] },
    });
    await expect(hl.getBalance()).rejects.toMatchObject({ structured: { code: "PRICE_STALE" } });
  });

  it("collateral is matched by token index (meta.collateralToken), not by coin name", async () => {
    const payload = {
      marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {},
      withdrawable: "0", assetPositions: [],
    };
    const balances = [
      { coin: "USDT0", token: 268, total: "999", hold: "9" },
      { coin: "USDC", token: 0, total: "500", hold: "0" },
    ];
    const native = await buildAdapter({ type: "balance", mode: "unified", payload, spotPayload: { balances } });
    expect((await native.getBalance()).equity).toBe("500");
    // A dex whose collateral token is USDT0 (index 268) reads that row.
    const usdtDex = await buildAdapter({ type: "balance", mode: "unified", payload, spotPayload: { balances }, collateralToken: 268 });
    const b = await usdtDex.getBalance();
    expect(b.equity).toBe("999");
    expect(b.available).toBe("990");
  });

  it("unified mode with no collateral row → equity 0 (venue omits zero balances)", async () => {
    const hl = await buildAdapter({
      type: "balance", mode: "unified",
      payload: { marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {}, withdrawable: "0", assetPositions: [] },
      spotPayload: { balances: [{ coin: "HYPE", token: 150, total: "3", hold: "0" }] },
    });
    expect((await hl.getBalance()).equity).toBe("0");
  });
});

/** Portfolio-margin note and the spot rows' `shared` flag (collateral is counted in the perp equity). */
describe("HyperliquidAdapter portfolio-margin note and shared spot rows", () => {
  it("the stderr note lists the priced collateral; a row without ltv (USDH) is not collateral", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => { lines.push(String(c)); return true; });
    try {
      const hl = await buildAdapter({
        type: "balance", mode: "portfolio", spotMeta: SPOT_META,
        payload: { marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {}, withdrawable: "0", assetPositions: [] },
        spotPayload: { balances: [
          { coin: "USDC", token: 0, total: "100", hold: "0", ltv: "0.0" },
          { coin: "HYPE", token: 150, total: "10", hold: "0", ltv: "0.65" },
          { coin: "USDH", token: 360, total: "999", hold: "0" },
        ] },
      });
      expect((await hl.getBalance()).equity).toBe("900"); // 100 + 10 × 80
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("");
    expect(out).toMatch(/USDC 100 \+ HYPE 10 × 80/);
    expect(out).not.toMatch(/USDH/);
  });

  it("hlSpotBalanceRows: USDC and every ltv row are shared on a unified / portfolio account, nothing on standard", async () => {
    const { hlSpotBalanceRows } = await import("../../exchanges/hyperliquid-spot.js");
    const balances = [
      { coin: "USDC", token: 0, total: "-18", hold: "0", ltv: "0.0" },
      { coin: "HYPE", token: 150, total: "0.5", hold: "0", ltv: "0.65" },
      { coin: "FATCAT", token: 126, total: "43", hold: "0" },
    ];
    expect(hlSpotBalanceRows({ balances }, true).map(r => [r.token, r.shared])).toEqual([["USDC", true], ["HYPE", true], ["FATCAT", false]]);
    expect(hlSpotBalanceRows({ balances }, false).every(r => !r.shared)).toBe(true);
  });

  it("hlSpotUsdPricesOf: USDC-quoted pairs only, the larger 24h notional wins, USDC = 1", async () => {
    const { hlSpotUsdPricesOf } = await import("../../exchanges/hyperliquid.js");
    const prices = hlSpotUsdPricesOf([
      { universe: [{ tokens: [150, 0], index: 0 }, { tokens: [150, 0], index: 1 }, { tokens: [150, 268], index: 2 }] },
      [{ markPx: "79", dayNtlVlm: "10" }, { markPx: "80", dayNtlVlm: "500" }, { markPx: "99", dayNtlVlm: "9999" }],
    ]);
    expect(prices.get(150)).toBe(80);
    expect(prices.get(0)).toBe(1);
    expect(() => hlSpotUsdPricesOf({})).toThrow(/expected \[meta, ctxs\]/);
  });
});
