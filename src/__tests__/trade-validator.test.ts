import { describe, it, expect, vi } from "vitest";
import { validateTrade, type TradeCheckParams } from "../trade-validator.js";

// Mock the dynamic import of risk.js to avoid file I/O
vi.mock("../risk.js", () => ({
  assessRisk: vi.fn().mockReturnValue({
    level: "low",
    violations: [],
    metrics: {
      totalEquity: 1000,
      totalUnrealizedPnl: 0,
      totalMarginUsed: 200,
      totalExposure: 500,
      positionCount: 0,
      marginUtilization: 20,
      largestPositionUsd: 0,
      maxLeverageUsed: 0,
    },
    limits: {
      maxDrawdownUsd: 500,
      maxPositionUsd: 5000,
      maxTotalExposureUsd: 20000,
      dailyLossLimitUsd: 200,
      maxPositions: 10,
      maxLeverage: 20,
      maxMarginUtilization: 80,
    },
    canTrade: true,
  }),
  preTradeCheck: vi.fn().mockReturnValue({ allowed: true }),
}));

// ── Mock adapter factory ──

function mockAdapter(overrides?: Partial<Record<string, unknown>>) {
  return {
    name: "test-exchange",
    getMarkets: vi.fn().mockResolvedValue([
      {
        symbol: "BTC-PERP",
        markPrice: "60000",
        indexPrice: "60000",
        fundingRate: "0.0001",
        volume24h: "1000000",
        openInterest: "500000",
        maxLeverage: 20,
      },
      {
        symbol: "ETH-PERP",
        markPrice: "3000",
        indexPrice: "3000",
        fundingRate: "0.00005",
        volume24h: "500000",
        openInterest: "250000",
        maxLeverage: 15,
      },
    ]),
    getBalance: vi.fn().mockResolvedValue({
      equity: "10000",
      available: "8000",
      marginUsed: "2000",
      unrealizedPnl: "0",
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({
      bids: [
        ["59990", "1"],
        ["59980", "2"],
        ["59970", "3"],
      ],
      asks: [
        ["60010", "1"],
        ["60020", "2"],
        ["60030", "3"],
      ],
    }),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    marketOrder: vi.fn().mockResolvedValue({ orderId: "m1" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "l1" }),
    editOrder: vi.fn().mockResolvedValue({}),
    cancelOrder: vi.fn().mockResolvedValue({}),
    cancelAllOrders: vi.fn().mockResolvedValue({}),
    setLeverage: vi.fn().mockResolvedValue({}),
    stopOrder: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any;
}

// ──────────────────────────────────────────────
// 1. Symbol Validity
// ──────────────────────────────────────────────

describe("validateTrade — symbol validity", () => {
  it("passes when symbol is found exactly", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC-PERP",
      side: "buy",
      size: 0.01,
    });
    const symbolCheck = result.checks.find(c => c.check === "symbol_valid");
    expect(symbolCheck?.passed).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("matches BTC to BTC-PERP (suffix matching)", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    const symbolCheck = result.checks.find(c => c.check === "symbol_valid");
    expect(symbolCheck?.passed).toBe(true);
    expect(symbolCheck?.message).toContain("BTC");
  });

  it("matches btc case-insensitively to BTC-PERP", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "btc",
      side: "buy",
      size: 0.01,
    });
    const symbolCheck = result.checks.find(c => c.check === "symbol_valid");
    expect(symbolCheck?.passed).toBe(true);
  });

  it("returns invalid early when symbol is not found", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "DOGE",
      side: "buy",
      size: 1,
    });
    expect(result.valid).toBe(false);
    const symbolCheck = result.checks.find(c => c.check === "symbol_valid");
    expect(symbolCheck?.passed).toBe(false);
    expect(symbolCheck?.message).toContain("DOGE");
    // Should return early — only one check
    expect(result.checks).toHaveLength(1);
    expect(result.estimatedCost).toBeUndefined();
  });

  it("handles -PERP suffix stripping (input=BTC-PERP, market=BTC-PERP)", async () => {
    const adapter = mockAdapter({
      getMarkets: vi.fn().mockResolvedValue([
        { symbol: "BTC-PERP", markPrice: "60000", indexPrice: "60000", fundingRate: "0.0001", volume24h: "1000000", openInterest: "500000", maxLeverage: 20 },
      ]),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC-PERP",
      side: "buy",
      size: 0.01,
    });
    expect(result.checks.find(c => c.check === "symbol_valid")?.passed).toBe(true);
  });

  it("handles market without -PERP suffix matching input with -PERP suffix", async () => {
    // Market returns "BTC", user queries "BTC-PERP"
    const adapter = mockAdapter({
      getMarkets: vi.fn().mockResolvedValue([
        { symbol: "BTC", markPrice: "60000", indexPrice: "60000", fundingRate: "0.0001", volume24h: "1000000", openInterest: "500000", maxLeverage: 20 },
      ]),
    });
    // The code logic: ms === sym → "BTC" === "BTC-PERP" (no), ms === `${sym}-PERP` → "BTC" === "BTC-PERP-PERP" (no), ms.replace(/-PERP$/, "") === sym → "BTC" === "BTC-PERP" (no)
    // So BTC-PERP input won't match "BTC" market. This tests the current behavior.
    const result = await validateTrade(adapter, {
      symbol: "BTC-PERP",
      side: "buy",
      size: 0.01,
    });
    // "BTC" won't match "BTC-PERP" — ms=BTC, sym=BTC-PERP: ms !== sym, `${sym}-PERP`="BTC-PERP-PERP" !== "BTC", ms.replace(/-PERP$/,"")="BTC" !== "BTC-PERP"
    expect(result.checks.find(c => c.check === "symbol_valid")?.passed).toBe(false);
  });
});

// ──────────────────────────────────────────────
// 2. Balance Checks
// ──────────────────────────────────────────────

describe("validateTrade — balance check", () => {
  it("passes when balance is sufficient", async () => {
    const adapter = mockAdapter();
    // BTC at 60000, size 0.01 = $600 notional, at 20x leverage = $30 margin
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    const balCheck = result.checks.find(c => c.check === "balance_sufficient");
    expect(balCheck?.passed).toBe(true);
    expect(balCheck?.message).toContain(">=");
  });

  it("fails when balance is insufficient", async () => {
    const adapter = mockAdapter({
      getBalance: vi.fn().mockResolvedValue({
        equity: "100",
        available: "10",
        marginUsed: "90",
        unrealizedPnl: "0",
      }),
    });
    // BTC at 60000, size 1 = $60000 notional, at 20x = $3000 margin. Available is $10
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 1,
    });
    const balCheck = result.checks.find(c => c.check === "balance_sufficient");
    expect(balCheck?.passed).toBe(false);
    expect(balCheck?.message).toContain("Insufficient");
  });

  it("skips balance check for reduce-only orders (always passes)", async () => {
    const adapter = mockAdapter({
      getBalance: vi.fn().mockResolvedValue({
        equity: "1",
        available: "0",
        marginUsed: "1",
        unrealizedPnl: "0",
      }),
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC-PERP", side: "long", size: "1", entryPrice: "60000", markPrice: "60000", liquidationPrice: "50000", unrealizedPnl: "0", leverage: 10 },
      ]),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "sell",
      size: 0.5,
      reduceOnly: true,
    });
    const balCheck = result.checks.find(c => c.check === "balance_sufficient");
    expect(balCheck?.passed).toBe(true);
    expect(balCheck?.message).toContain("Reduce-only");
  });

  it("uses custom leverage for margin calculation", async () => {
    const adapter = mockAdapter({
      getBalance: vi.fn().mockResolvedValue({
        equity: "1000",
        available: "500",
        marginUsed: "500",
        unrealizedPnl: "0",
      }),
    });
    // BTC at 60000, size 0.1 = $6000 notional. At 2x leverage = $3000 margin > $500 available
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.1,
      leverage: 2,
    });
    const balCheck = result.checks.find(c => c.check === "balance_sufficient");
    expect(balCheck?.passed).toBe(false);
  });
});

// ──────────────────────────────────────────────
// 3. Price Freshness
// ──────────────────────────────────────────────

describe("validateTrade — price freshness", () => {
  it("passes when limit price is within 3% of mark", async () => {
    const adapter = mockAdapter();
    // Mark = 60000, price = 60500 → deviation = 500/60000 = 0.83%
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
      price: 60500,
      type: "limit",
    });
    const priceCheck = result.checks.find(c => c.check === "price_fresh");
    expect(priceCheck?.passed).toBe(true);
    expect(priceCheck?.message).toContain("within normal range");
  });

  it("passes with warning when price deviates 3–10% from mark", async () => {
    const adapter = mockAdapter();
    // Mark = 60000, price = 63000 → deviation = 3000/60000 = 5%
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
      price: 63000,
      type: "limit",
    });
    const priceCheck = result.checks.find(c => c.check === "price_fresh");
    expect(priceCheck?.passed).toBe(true);
    expect(priceCheck?.message).toContain("5.0%");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes("5.0%"))).toBe(true);
  });

  it("fails when price deviates more than 10% from mark", async () => {
    const adapter = mockAdapter();
    // Mark = 60000, price = 70000 → deviation = 10000/60000 = 16.7%
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
      price: 70000,
      type: "limit",
    });
    const priceCheck = result.checks.find(c => c.check === "price_fresh");
    expect(priceCheck?.passed).toBe(false);
    expect(priceCheck?.message).toContain("deviates");
    expect(result.valid).toBe(false);
  });

  it("passes with mark price info when no limit price provided (market order)", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    const priceCheck = result.checks.find(c => c.check === "price_fresh");
    expect(priceCheck?.passed).toBe(true);
    expect(priceCheck?.message).toContain("60000");
  });
});

// ──────────────────────────────────────────────
// 4. Liquidity Check
// ──────────────────────────────────────────────

describe("validateTrade — liquidity check", () => {
  it("passes when sufficient liquidity exists", async () => {
    const adapter = mockAdapter();
    // Default orderbook: asks sum to 60010*1 + 60020*2 + 60030*3 = ~$360,140
    // Buying 0.01 BTC at ~$60000 = $600 notional
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    const liqCheck = result.checks.find(c => c.check === "liquidity_ok");
    expect(liqCheck?.passed).toBe(true);
    expect(liqCheck?.message).toContain("Sufficient liquidity");
  });

  it("fails when orderbook has insufficient liquidity", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["59990", "0.001"]],
        asks: [["60010", "0.001"]],  // only ~$60 of liquidity
      }),
    });
    // Buying 1 BTC = $60000 notional, but only $60 on asks
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 1,
    });
    const liqCheck = result.checks.find(c => c.check === "liquidity_ok");
    expect(liqCheck?.passed).toBe(false);
    expect(liqCheck?.message).toContain("Insufficient liquidity");
  });

  it("fails when slippage exceeds threshold", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [["59990", "10"]],
        asks: [
          ["60010", "0.001"],   // small amount at near price
          ["60500", "100"],     // large amount at 0.83% away — above 0.5% threshold
        ],
      }),
    });
    // Buying 10 BTC at ~$60000 = $600,000. First level covers ~$60, rest at $60500.
    // worstPrice = 60500, markPrice = 60000, slippage = 500/60000 = 0.833%
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 10,
    });
    const liqCheck = result.checks.find(c => c.check === "liquidity_ok");
    expect(liqCheck?.passed).toBe(false);
    expect(liqCheck?.message).toContain("Slippage");
  });

  it("skips liquidity check for limit orders", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
      price: 60000,
      type: "limit",
    });
    const liqCheck = result.checks.find(c => c.check === "liquidity_ok");
    expect(liqCheck?.passed).toBe(true);
    expect(liqCheck?.message).toContain("skipped");
  });

  it("uses bids for sell orders", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockResolvedValue({
        bids: [
          ["59990", "1"],
          ["59980", "2"],
        ],
        asks: [["60010", "0.0001"]],  // tiny asks
      }),
    });
    // Selling 0.01 BTC — checks bids. Bids have ample liquidity.
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "sell",
      size: 0.01,
    });
    const liqCheck = result.checks.find(c => c.check === "liquidity_ok");
    expect(liqCheck?.passed).toBe(true);
  });
});

// ──────────────────────────────────────────────
// 5. Reduce-Only / Position Exists
// ──────────────────────────────────────────────

describe("validateTrade — reduce-only position check", () => {
  it("passes when position exists with enough size", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC-PERP", side: "long", size: "1.0", entryPrice: "60000", markPrice: "60000", liquidationPrice: "50000", unrealizedPnl: "0", leverage: 10 },
      ]),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "sell",
      size: 0.5,
      reduceOnly: true,
    });
    const posCheck = result.checks.find(c => c.check === "position_exists");
    expect(posCheck?.passed).toBe(true);
    expect(posCheck?.message).toContain("Position exists");
  });

  it("fails when reduce size exceeds position size", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC-PERP", side: "long", size: "0.5", entryPrice: "60000", markPrice: "60000", liquidationPrice: "50000", unrealizedPnl: "0", leverage: 10 },
      ]),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "sell",
      size: 1.0,
      reduceOnly: true,
    });
    const posCheck = result.checks.find(c => c.check === "position_exists");
    expect(posCheck?.passed).toBe(false);
    expect(posCheck?.message).toContain("exceeds");
  });

  it("fails when no position exists for reduce-only", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "sell",
      size: 0.1,
      reduceOnly: true,
    });
    const posCheck = result.checks.find(c => c.check === "position_exists");
    expect(posCheck?.passed).toBe(false);
    expect(posCheck?.message).toContain("No position found");
  });

  it("matches position with -PERP suffix to symbol without suffix", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "ETH-PERP", side: "short", size: "10", entryPrice: "3000", markPrice: "3000", liquidationPrice: "4000", unrealizedPnl: "0", leverage: 5 },
      ]),
    });
    const result = await validateTrade(adapter, {
      symbol: "ETH",
      side: "buy",
      size: 5,
      reduceOnly: true,
    });
    const posCheck = result.checks.find(c => c.check === "position_exists");
    expect(posCheck?.passed).toBe(true);
  });

  it("does not add position_exists check for non-reduce-only orders", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    const posCheck = result.checks.find(c => c.check === "position_exists");
    expect(posCheck).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// 6. Estimated Cost
// ──────────────────────────────────────────────

describe("validateTrade — estimated cost", () => {
  it("calculates margin, fee, slippage for market order", async () => {
    const adapter = mockAdapter();
    // BTC at 60000, size 0.1 = $6000 notional, 20x leverage → margin = $300
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.1,
    });
    expect(result.estimatedCost).toBeDefined();
    const cost = result.estimatedCost!;
    // margin = 6000 / 20 = 300
    expect(cost.margin).toBeCloseTo(300, 0);
    // fee = 6000 * 0.0005 = 3
    expect(cost.fee).toBeCloseTo(3, 1);
    // slippage = 6000 * 0.001 = 6 (for market orders)
    expect(cost.slippage).toBeCloseTo(6, 1);
    // total = margin + fee + slippage
    expect(cost.total).toBeCloseTo(cost.margin + cost.fee + cost.slippage, 1);
  });

  it("sets slippage to 0 for limit orders", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.1,
      price: 60000,
      type: "limit",
    });
    expect(result.estimatedCost?.slippage).toBe(0);
  });

  it("uses specified price for limit order cost calculation", async () => {
    const adapter = mockAdapter();
    // Limit price 59000, size 0.1 = $5900 notional
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.1,
      price: 59000,
      type: "limit",
    });
    const cost = result.estimatedCost!;
    // margin = 5900 / 20 = 295
    expect(cost.margin).toBeCloseTo(295, 0);
    // fee = 5900 * 0.0005 = 2.95
    expect(cost.fee).toBeCloseTo(2.95, 1);
  });
});

// ──────────────────────────────────────────────
// 7. Market Info
// ──────────────────────────────────────────────

describe("validateTrade — market info output", () => {
  it("returns marketInfo for valid symbols", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "ETH",
      side: "buy",
      size: 1,
    });
    expect(result.marketInfo).toBeDefined();
    expect(result.marketInfo?.symbol).toBe("ETH");
    expect(result.marketInfo?.markPrice).toBe(3000);
    expect(result.marketInfo?.fundingRate).toBeCloseTo(0.00005);
    expect(result.marketInfo?.maxLeverage).toBe(15);
  });

  it("does not include marketInfo when symbol not found", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "NONEXISTENT",
      side: "buy",
      size: 1,
    });
    expect(result.marketInfo).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// 8. Leverage Warning
// ──────────────────────────────────────────────

describe("validateTrade — leverage warning", () => {
  it("warns when requested leverage exceeds max", async () => {
    const adapter = mockAdapter();
    // BTC-PERP maxLeverage is 20
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
      leverage: 50,
    });
    expect(result.warnings.some(w => w.includes("50x") && w.includes("20x"))).toBe(true);
  });
});

// ──────────────────────────────────────────────
// 9. Error Resilience
// ──────────────────────────────────────────────

describe("validateTrade — error resilience", () => {
  it("handles getMarkets failure gracefully", async () => {
    const adapter = mockAdapter({
      getMarkets: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    // Markets failed → returns empty array → symbol not found
    expect(result.valid).toBe(false);
    expect(result.checks[0].check).toBe("symbol_valid");
    expect(result.checks[0].passed).toBe(false);
  });

  it("handles getBalance failure gracefully", async () => {
    const adapter = mockAdapter({
      getBalance: vi.fn().mockRejectedValue(new Error("auth error")),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    // Balance defaults to 0 available → balance check fails for non-zero orders
    const balCheck = result.checks.find(c => c.check === "balance_sufficient");
    expect(balCheck).toBeDefined();
    // available = 0, marginRequired = 600/20=30, so should fail
    expect(balCheck?.passed).toBe(false);
  });

  it("handles getOrderbook failure gracefully", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    // Orderbook defaults to empty → liquidity check skipped
    const liqCheck = result.checks.find(c => c.check === "liquidity_ok");
    expect(liqCheck?.passed).toBe(true);
    expect(liqCheck?.message).toContain("skipped");
  });
});

// ──────────────────────────────────────────────
// 10. Overall Validity
// ──────────────────────────────────────────────

describe("validateTrade — overall validity", () => {
  it("returns valid=true when all checks pass", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    expect(result.valid).toBe(true);
    expect(result.checks.every(c => c.passed)).toBe(true);
  });

  it("returns valid=false if any check fails", async () => {
    const adapter = mockAdapter({
      getBalance: vi.fn().mockResolvedValue({
        equity: "1",
        available: "0",
        marginUsed: "1",
        unrealizedPnl: "0",
      }),
    });
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 1,
    });
    expect(result.valid).toBe(false);
  });

  it("includes a timestamp in ISO format", async () => {
    const adapter = mockAdapter();
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
    });
    expect(result.timestamp).toBeDefined();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
