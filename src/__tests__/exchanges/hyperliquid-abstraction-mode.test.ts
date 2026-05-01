/**
 * Unit tests for HyperliquidAdapter._getAbstractionMode (C3 fix).
 *
 * Validates:
 *  - "unifiedAccount"  → "unified"
 *  - "portfolioMargin" → "portfolio"
 *  - "disabled"        → "standard"
 *  - "default"         → "standard"  (legacy v0.12.9)
 *  - "dexAbstraction"  → "unified"   (C3 fix: legacy 4th HL mode)
 *  - unknown           → throws PerpError(INVALID_PARAMS)
 *
 * The cache layer is bypassed by stubbing `withCache` to invoke the producer
 * directly; SDK construction is short-circuited by setting walletAddress.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../cache.js", async () => {
  return {
    withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
    TTL_ACCOUNT: 1000,
    TTL_MARKETS: 1000,
    TTL_PRICES: 1000,
  };
});

describe("HyperliquidAdapter._getAbstractionMode — C3 mapping", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function buildAdapter(rawMode: unknown) {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hl = new HyperliquidAdapter(undefined, false);
    hl.setAddress("0xabcdef0000000000000000000000000000000001");
    // Stub _infoPost to return the raw mode string
    (hl as unknown as { _infoPost: (b: unknown) => Promise<unknown> })._infoPost =
      vi.fn().mockResolvedValue(rawMode);
    return hl;
  }

  it("'unifiedAccount' maps to 'unified'", async () => {
    const hl = await buildAdapter("unifiedAccount");
    await expect(hl._getAbstractionMode()).resolves.toBe("unified");
  });

  it("'portfolioMargin' maps to 'portfolio'", async () => {
    const hl = await buildAdapter("portfolioMargin");
    await expect(hl._getAbstractionMode()).resolves.toBe("portfolio");
  });

  it("'disabled' maps to 'standard'", async () => {
    const hl = await buildAdapter("disabled");
    await expect(hl._getAbstractionMode()).resolves.toBe("standard");
  });

  it("'default' maps to 'standard' (v0.12.9 regression guard)", async () => {
    const hl = await buildAdapter("default");
    await expect(hl._getAbstractionMode()).resolves.toBe("standard");
  });

  it("'dexAbstraction' maps to 'unified' (C3 fix: legacy 4th HL mode)", async () => {
    const hl = await buildAdapter("dexAbstraction");
    await expect(hl._getAbstractionMode()).resolves.toBe("unified");
  });

  it("unknown mode throws INVALID_PARAMS with remediation", async () => {
    const hl = await buildAdapter("someUnknownMode");
    let err: unknown;
    try {
      await hl._getAbstractionMode();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const e = err as { structured?: { code?: string; remediation?: string } };
    expect(e.structured?.code).toBe("INVALID_PARAMS");
    expect(e.structured?.remediation ?? "").toContain("Settings");
  });
});
