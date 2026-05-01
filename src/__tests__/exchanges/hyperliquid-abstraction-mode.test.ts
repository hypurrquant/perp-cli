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

// ─── Codex v0.12.12 final QA #1: isUnifiedAccount tracks abstraction mode ───
// Replaces the static `readonly isUnifiedAccount = true` field that caused
// portfolio.ts and bot strategies to silently undercount standard-mode HL
// accounts (perp equity excludes spot USDC under standard, but portfolio.ts
// dropped spot USDC on the assumption of unified). isUnifiedAccount is now
// populated during init() from _getAbstractionMode().
describe("HyperliquidAdapter.isUnifiedAccount — derived from abstraction mode (C1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("standard mode → isUnifiedAccount === false (portfolio must add spot USDC)", async () => {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hl = new HyperliquidAdapter(undefined, false);
    hl.setAddress("0xabcdef0000000000000000000000000000000001");
    (hl as unknown as { _infoPost: (b: unknown) => Promise<unknown> })._infoPost =
      vi.fn().mockResolvedValue("disabled");
    // Stub sdk.connect / asset map loader so init() reaches the mode lookup
    (hl as unknown as { sdk: { connect: () => Promise<void> }; _loadAssetMap: () => Promise<void> }).sdk =
      { connect: vi.fn().mockResolvedValue(undefined) } as unknown as { connect: () => Promise<void> };
    (hl as unknown as { _loadAssetMap: () => Promise<void> })._loadAssetMap =
      vi.fn().mockResolvedValue(undefined);

    await hl.init();
    expect(hl.isUnifiedAccount).toBe(false);
  });

  it("default (legacy unset) → isUnifiedAccount === false (standard semantics)", async () => {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hl = new HyperliquidAdapter(undefined, false);
    hl.setAddress("0xabcdef0000000000000000000000000000000002");
    (hl as unknown as { _infoPost: (b: unknown) => Promise<unknown> })._infoPost =
      vi.fn().mockResolvedValue("default");
    (hl as unknown as { sdk: { connect: () => Promise<void> }; _loadAssetMap: () => Promise<void> }).sdk =
      { connect: vi.fn().mockResolvedValue(undefined) } as unknown as { connect: () => Promise<void> };
    (hl as unknown as { _loadAssetMap: () => Promise<void> })._loadAssetMap =
      vi.fn().mockResolvedValue(undefined);

    await hl.init();
    expect(hl.isUnifiedAccount).toBe(false);
  });

  it("unifiedAccount → isUnifiedAccount === true (spot USDC already in perp equity)", async () => {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hl = new HyperliquidAdapter(undefined, false);
    hl.setAddress("0xabcdef0000000000000000000000000000000003");
    (hl as unknown as { _infoPost: (b: unknown) => Promise<unknown> })._infoPost =
      vi.fn().mockResolvedValue("unifiedAccount");
    (hl as unknown as { sdk: { connect: () => Promise<void> }; _loadAssetMap: () => Promise<void> }).sdk =
      { connect: vi.fn().mockResolvedValue(undefined) } as unknown as { connect: () => Promise<void> };
    (hl as unknown as { _loadAssetMap: () => Promise<void> })._loadAssetMap =
      vi.fn().mockResolvedValue(undefined);

    await hl.init();
    expect(hl.isUnifiedAccount).toBe(true);
  });

  it("portfolioMargin → isUnifiedAccount === true", async () => {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hl = new HyperliquidAdapter(undefined, false);
    hl.setAddress("0xabcdef0000000000000000000000000000000004");
    (hl as unknown as { _infoPost: (b: unknown) => Promise<unknown> })._infoPost =
      vi.fn().mockResolvedValue("portfolioMargin");
    (hl as unknown as { sdk: { connect: () => Promise<void> }; _loadAssetMap: () => Promise<void> }).sdk =
      { connect: vi.fn().mockResolvedValue(undefined) } as unknown as { connect: () => Promise<void> };
    (hl as unknown as { _loadAssetMap: () => Promise<void> })._loadAssetMap =
      vi.fn().mockResolvedValue(undefined);

    await hl.init();
    expect(hl.isUnifiedAccount).toBe(true);
  });

  it("HIP-3 dex account (standard semantics) → isUnifiedAccount === false", async () => {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hl = new HyperliquidAdapter(undefined, false);
    hl.setAddress("0xabcdef0000000000000000000000000000000005");
    hl.setDex("km"); // any HIP-3 dex name → _getAbstractionMode short-circuits to "standard"
    // _infoPost is still consulted by other paths; not by mode lookup for dex
    (hl as unknown as { _infoPost: (b: unknown) => Promise<unknown> })._infoPost =
      vi.fn().mockResolvedValue("unifiedAccount"); // even if venue would say unified, dex short-circuits
    (hl as unknown as { sdk: { connect: () => Promise<void> }; _loadAssetMap: () => Promise<void> }).sdk =
      { connect: vi.fn().mockResolvedValue(undefined) } as unknown as { connect: () => Promise<void> };
    (hl as unknown as { _loadAssetMap: () => Promise<void> })._loadAssetMap =
      vi.fn().mockResolvedValue(undefined);

    await hl.init();
    expect(hl.isUnifiedAccount).toBe(false);
  });

  it("read-only init (no address) leaves default false (no userAbstraction call)", async () => {
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hl = new HyperliquidAdapter(undefined, false);
    // No setAddress() before init — read-only path
    const infoPost = vi.fn().mockResolvedValue("unifiedAccount");
    (hl as unknown as { _infoPost: (b: unknown) => Promise<unknown> })._infoPost = infoPost;
    (hl as unknown as { sdk: { connect: () => Promise<void> }; _loadAssetMap: () => Promise<void> }).sdk =
      { connect: vi.fn().mockResolvedValue(undefined) } as unknown as { connect: () => Promise<void> };
    (hl as unknown as { _loadAssetMap: () => Promise<void> })._loadAssetMap =
      vi.fn().mockResolvedValue(undefined);

    await hl.init();
    expect(hl.isUnifiedAccount).toBe(false);
    expect(infoPost).not.toHaveBeenCalled();
  });
});
