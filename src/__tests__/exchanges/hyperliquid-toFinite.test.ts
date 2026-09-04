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
          { coin: "USDC-SPOT", total: "1000", hold: "100" },
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
        balances: [{ coin: "USDC-SPOT", total: "NaN", hold: "0" }],
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
        balances: [{ coin: "USDC-SPOT", total: "1000", hold: "" }],
      },
    });
    await expect(hl.getBalance()).rejects.toThrow(/spotBalance.USDC.hold.*empty string/);
  });
});

describe("HyperliquidAdapter.getBalance — portfolio mode collateral filter guards", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("portfolio mode: clean payload with non-USDC HYPE collateral computes USDC-only equity", async () => {
    const hl = await buildAdapter({
      type: "balance",
      mode: "portfolio",
      payload: {
        marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {},
        withdrawable: "0", assetPositions: [],
      },
      spotPayload: {
        balances: [
          { coin: "USDC-SPOT", total: "500", hold: "0" },
          { coin: "HYPE", total: "10", hold: "0" },
        ],
      },
    });
    const bal = await hl.getBalance();
    // Equity reflects USDC only (HYPE counted via warn, not equity sum).
    expect(bal.equity).toBe("500");
  });

  it("portfolio mode: throws when non-USDC collateral total is NaN (filter no longer silently drops corruption)", async () => {
    const hl = await buildAdapter({
      type: "balance",
      mode: "portfolio",
      payload: {
        marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {},
        withdrawable: "0", assetPositions: [],
      },
      spotPayload: {
        balances: [
          { coin: "USDC-SPOT", total: "500", hold: "0" },
          { coin: "HYPE", total: "NaN", hold: "0" },
        ],
      },
    });
    await expect(hl.getBalance()).rejects.toThrow(/spotBalance.HYPE.total.*not a finite/);
  });

  it("portfolio mode: throws when non-USDC collateral total is empty string ''", async () => {
    const hl = await buildAdapter({
      type: "balance",
      mode: "portfolio",
      payload: {
        marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {},
        withdrawable: "0", assetPositions: [],
      },
      spotPayload: {
        balances: [
          { coin: "USDC-SPOT", total: "500", hold: "0" },
          { coin: "BTC", total: "", hold: "0" },
        ],
      },
    });
    await expect(hl.getBalance()).rejects.toThrow(/spotBalance.BTC.total.*empty string/);
  });

  it("portfolio mode: USDC-prefix balances are exempt from the filter (USDC-SPOT, USDC-PERP, etc.)", async () => {
    // Filter at hyperliquid.ts:512 skips `coin.startsWith("USDC")` before
    // calling parseFiniteVenueNumber — so a NaN USDC-PERP entry should NOT
    // throw via the filter (it's already excluded from non-USDC scan).
    const hl = await buildAdapter({
      type: "balance",
      mode: "portfolio",
      payload: {
        marginSummary: { totalMarginUsed: "0" }, crossMarginSummary: {},
        withdrawable: "0", assetPositions: [],
      },
      spotPayload: {
        balances: [
          { coin: "USDC-SPOT", total: "500", hold: "0" },
          // NaN here would throw if the filter incorrectly entered the
          // parseFiniteVenueNumber branch for USDC-prefixed coins. The
          // current filter correctly skips USDC-* upfront so this is a no-op.
          { coin: "USDC-PERP", total: "NaN", hold: "0" },
        ],
      },
    });
    const bal = await hl.getBalance();
    expect(bal.equity).toBe("500");
  });
});

/**
 * Portfolio-mode collateral list must match the venue's eligible assets.
 *
 * trading/portfolio-margin.md caps and trading/account-abstraction-modes.md
 * ("eligible assets, which are currently HYPE, BTC, USDC, USDT") define the set.
 * The list previously read ["HYPE","BTC","USDH"] — USDH is not collateral at
 * all, and USDT was missing, so a portfolio account holding USDT collateral got
 * NO warning that its collateral is excluded from the reported equity.
 */
describe("HyperliquidAdapter portfolio-mode collateral warning", () => {
  const buildPortfolioAdapter = async (balances: Array<Record<string, unknown>>) => {
    const mod = await import("../../exchanges/hyperliquid.js");
    const adapter = Object.create(mod.HyperliquidAdapter.prototype);
    adapter._address = "0xabc";
    adapter._dex = undefined;
    adapter._getAbstractionMode = vi.fn().mockResolvedValue("portfolio");
    adapter._getSpotClearinghouseState = vi.fn().mockResolvedValue({ balances });
    adapter._getClearinghouseState = vi.fn().mockResolvedValue({
      marginSummary: {}, crossMarginSummary: {}, assetPositions: [],
    });
    return adapter;
  };

  const warningsFor = async (balances: Array<Record<string, unknown>>) => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => { lines.push(String(c)); return true; });
    try {
      const adapter = await buildPortfolioAdapter(balances);
      await adapter.getBalance();
    } finally {
      spy.mockRestore();
    }
    return lines.join("");
  };

  it("warns about USDT collateral (previously invisible)", async () => {
    const out = await warningsFor([
      { coin: "USDC", total: "100", hold: "0" },
      { coin: "USDT", total: "500", hold: "0" },
    ]);
    expect(out).toMatch(/USDT=500/);
  });

  it("still warns about HYPE and BTC collateral", async () => {
    const out = await warningsFor([
      { coin: "USDC", total: "100", hold: "0" },
      { coin: "HYPE", total: "10", hold: "0" },
      { coin: "BTC", total: "1", hold: "0" },
    ]);
    expect(out).toMatch(/HYPE=10/);
    expect(out).toMatch(/BTC=1/);
  });

  it("does not treat USDH as collateral — it is not an eligible asset", async () => {
    const out = await warningsFor([
      { coin: "USDC", total: "100", hold: "0" },
      { coin: "USDH", total: "999", hold: "0" },
    ]);
    expect(out).not.toMatch(/USDH/);
  });
});
