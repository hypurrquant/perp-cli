import { describe, it, expect, vi } from "vitest";

// Pin loadRiskLimits to a deterministic, tight limit set so the gate's behavior
// does not depend on whether the host has a ~/.perp/risk.json. assessRisk and
// preTradeCheck keep their real implementations — we are testing the actual
// gate logic, only the *source* of the limits is stubbed.
vi.mock("../risk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../risk.js")>();
  return {
    ...actual,
    loadRiskLimits: () => ({
      maxDrawdownUsd: 100000,
      maxPositionUsd: 5000,
      maxTotalExposureUsd: 20000,
      dailyLossLimitUsd: 50000,
      maxPositions: 10,
      maxLeverage: 20,
      maxMarginUtilization: 95,
      minLiquidationDistance: 5,
    }),
  };
});

import { enforceOrderRisk } from "../trade-validator.js";

function mockAdapter(over?: Record<string, any>) {
  return {
    name: "test",
    getMarkets: vi.fn().mockResolvedValue([
      { symbol: "BTC", markPrice: "20000", indexPrice: "20000", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 50 },
    ]),
    getBalance: vi.fn().mockResolvedValue({ equity: "10000", available: "10000", marginUsed: "0", unrealizedPnl: "0" }),
    getPositions: vi.fn().mockResolvedValue([]),
    ...over,
  } as any;
}

describe("enforceOrderRisk — manual-order risk gate", () => {
  it("skips entirely for reduce-only orders (no fetch, no throw)", async () => {
    const a = mockAdapter();
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 1000, price: 20000, reduceOnly: true })).resolves.toBeUndefined();
    expect(a.getBalance).not.toHaveBeenCalled();
    expect(a.getMarkets).not.toHaveBeenCalled();
    expect(a.getPositions).not.toHaveBeenCalled();
  });

  it("skips entirely when --force is set (no fetch, no throw)", async () => {
    const a = mockAdapter();
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 1000, price: 20000, force: true })).resolves.toBeUndefined();
    expect(a.getBalance).not.toHaveBeenCalled();
  });

  it("throws RISK_VIOLATION when notional exceeds maxPositionUsd (explicit price, no market fetch)", async () => {
    const a = mockAdapter();
    // 1 * 20000 = 20000 > maxPositionUsd 5000
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 1, price: 20000 }))
      .rejects.toMatchObject({ structured: { code: "RISK_VIOLATION" } });
    // price was supplied → no need to resolve markPrice
    expect(a.getMarkets).not.toHaveBeenCalled();
  });

  it("passes when notional is within the limit", async () => {
    const a = mockAdapter();
    // 0.1 * 20000 = 2000 < 5000
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 0.1, price: 20000 })).resolves.toBeUndefined();
  });

  it("resolves markPrice via getMarkets when no explicit price (market order path)", async () => {
    const a = mockAdapter();
    // size 1 * markPrice 20000 = 20000 > 5000 → throws, and getMarkets WAS used
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 1 }))
      .rejects.toMatchObject({ structured: { code: "RISK_VIOLATION" } });
    expect(a.getMarkets).toHaveBeenCalledTimes(1);
  });

  it("throws SYMBOL_NOT_FOUND when the symbol has no market to price against", async () => {
    const a = mockAdapter({ getMarkets: vi.fn().mockResolvedValue([]) });
    await expect(enforceOrderRisk(a, { symbol: "ZZZ", size: 1 }))
      .rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
  });

  it("fails closed with PRICE_STALE when markPrice is non-finite (Rule #2, --force can bypass)", async () => {
    const a = mockAdapter({
      getMarkets: vi.fn().mockResolvedValue([{ symbol: "BTC", markPrice: "NaN", indexPrice: "0", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 50 }]),
    });
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 1 }))
      .rejects.toMatchObject({ structured: { code: "PRICE_STALE" } });
  });

  it("surfaces a remediation hint that mentions --force", async () => {
    const a = mockAdapter();
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 1, price: 20000 }))
      .rejects.toMatchObject({ structured: { remediation: expect.stringMatching(/--force/) } });
  });

  it("blocks a within-position-limit order that would breach total exposure", async () => {
    // One existing 4000 position + a new 3000 order = 7000 > maxTotalExposureUsd? No (20000).
    // Use an existing position near the exposure cap instead.
    const a = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "ETH", side: "long", size: "10", entryPrice: "1800", markPrice: "1800", unrealizedPnl: "0", liquidationPrice: "1000", leverage: "2" },
      ]),
    });
    // existing exposure = 10 * 1800 = 18000; new 0.2 * 20000 = 4000 → 22000 > 20000 cap
    await expect(enforceOrderRisk(a, { symbol: "BTC", size: 0.2, price: 20000 }))
      .rejects.toMatchObject({ structured: { code: "RISK_VIOLATION" } });
  });
});
