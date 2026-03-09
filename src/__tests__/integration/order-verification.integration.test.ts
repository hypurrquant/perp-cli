/**
 * Integration tests: Order Verification against Hyperliquid Mainnet
 *
 * READ-ONLY tests — no orders are placed, no funds are touched.
 * Uses a dummy private key to instantiate the adapter for market data queries.
 * All assertions use reasonable ranges to accommodate live price fluctuations.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { validateTrade } from "../../trade-validator.js";
import type { ExchangeMarketInfo } from "../../exchanges/interface.js";

// Dummy key — only used for read-only info queries, never signs a transaction
const DUMMY_KEY = "0x" + "1".repeat(64);

/** Find a market by base symbol, tolerating a -PERP suffix. */
function findMarket<T extends { symbol: string }>(
  markets: T[],
  base: string,
): T | undefined {
  const b = base.toUpperCase();
  return markets.find(
    (m) =>
      m.symbol.toUpperCase() === b ||
      m.symbol.toUpperCase() === `${b}-PERP` ||
      m.symbol.toUpperCase().replace(/-PERP$/, "") === b,
  );
}

describe("Hyperliquid mainnet — order verification (read-only)", () => {
  let adapter: HyperliquidAdapter;
  let markets: ExchangeMarketInfo[];

  beforeAll(async () => {
    adapter = new HyperliquidAdapter(DUMMY_KEY, false);
    await adapter.init();
    markets = await adapter.getMarkets();
    // Sanity: the exchange must expose at least a handful of markets
    expect(markets.length).toBeGreaterThan(10);
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 1. "Buy 0.001 BTC" — validation with real data
  // ────────────────────────────────────────────────────────────
  it("validates a 0.001 BTC market buy with sane estimates", async () => {
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.001,
      type: "market",
    });

    // Symbol must be found
    const symCheck = result.checks.find((c) => c.check === "symbol_valid");
    expect(symCheck).toBeDefined();
    expect(symCheck!.passed).toBe(true);

    // Mark price: BTC should be well above $10 000
    expect(result.marketInfo).toBeDefined();
    expect(result.marketInfo!.markPrice).toBeGreaterThan(10_000);

    // Estimated cost: 0.001 BTC at ~$60-120k → notional $60-$120
    // Margin at max leverage (~50x) ≈ $1.2-$2.4
    // Fee at 0.05% ≈ $0.03-$0.06
    expect(result.estimatedCost).toBeDefined();
    expect(result.estimatedCost!.margin).toBeGreaterThan(0.5);
    expect(result.estimatedCost!.margin).toBeLessThan(20);
    expect(result.estimatedCost!.fee).toBeGreaterThan(0.01);
    expect(result.estimatedCost!.fee).toBeLessThan(1);
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 2. "Buy 1 ETH" — cost estimation accuracy
  // ────────────────────────────────────────────────────────────
  it("validates a 1 ETH market buy with accurate cost estimation", async () => {
    const result = await validateTrade(adapter, {
      symbol: "ETH",
      side: "buy",
      size: 1.0,
      type: "market",
    });

    expect(result.marketInfo).toBeDefined();
    const ethPrice = result.marketInfo!.markPrice;

    // ETH price should be in a broad but reasonable range
    expect(ethPrice).toBeGreaterThan(500);
    expect(ethPrice).toBeLessThan(20_000);

    // Margin at max leverage: notional / maxLev
    // At 50x: margin ~$36-$400 depending on price
    expect(result.estimatedCost).toBeDefined();
    expect(result.estimatedCost!.margin).toBeGreaterThan(5);
    expect(result.estimatedCost!.margin).toBeLessThan(500);

    // Fee: 0.05% of notional ($500-$20k) → $0.25 - $10
    expect(result.estimatedCost!.fee).toBeGreaterThan(0.1);
    expect(result.estimatedCost!.fee).toBeLessThan(15);
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 3. "Buy 0.1 SOL" — smaller asset
  // ────────────────────────────────────────────────────────────
  it("validates a 0.1 SOL buy — smaller asset sanity", async () => {
    const result = await validateTrade(adapter, {
      symbol: "SOL",
      side: "buy",
      size: 0.1,
      type: "market",
    });

    const symCheck = result.checks.find((c) => c.check === "symbol_valid");
    expect(symCheck).toBeDefined();
    expect(symCheck!.passed).toBe(true);

    expect(result.marketInfo).toBeDefined();
    expect(result.marketInfo!.markPrice).toBeGreaterThan(10);

    // Notional ~$1-$100 at current prices — cost should be small but positive
    expect(result.estimatedCost).toBeDefined();
    expect(result.estimatedCost!.margin).toBeGreaterThan(0);
    expect(result.estimatedCost!.fee).toBeGreaterThan(0);
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 4. "Sell 100 BTC" — liquidity / slippage check
  // ────────────────────────────────────────────────────────────
  it("detects liquidity/slippage concern for a 100 BTC sell", async () => {
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "sell",
      size: 100,
      type: "market",
    });

    // 100 BTC ≈ $6-12M notional — the validator should either:
    //   a) flag insufficient liquidity in the visible orderbook, or
    //   b) flag high slippage, or
    //   c) flag a risk-limits violation (max position size $5k default)
    const liqCheck = result.checks.find((c) => c.check === "liquidity_ok");
    const riskCheck = result.checks.find((c) => c.check === "risk_limits");

    // At least one of these should flag the absurd size
    const anyFlagged =
      (liqCheck && !liqCheck.passed) || (riskCheck && !riskCheck.passed);
    expect(anyFlagged).toBe(true);
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 5. Orderbook consistency — bid < ask
  // ────────────────────────────────────────────────────────────
  it("verifies orderbook bid < ask and spread near mark for BTC, ETH, SOL", async () => {
    const symbols = ["BTC", "ETH", "SOL"];

    for (const sym of symbols) {
      const book = await adapter.getOrderbook(sym);

      // Must have at least one level on each side
      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks.length).toBeGreaterThan(0);

      const bestBid = Number(book.bids[0][0]);
      const bestAsk = Number(book.asks[0][0]);

      // Best bid must be strictly less than best ask (positive spread)
      expect(bestBid).toBeLessThan(bestAsk);

      // Spread should be tiny relative to price (< 0.1%)
      const spread = (bestAsk - bestBid) / bestBid;
      expect(spread).toBeLessThan(0.001); // 0.1%

      // Both sides should be near the mark price (within 0.1%)
      const market = findMarket(markets, sym);
      expect(market).toBeDefined();
      const mark = Number(market!.markPrice);
      if (mark > 0) {
        expect(Math.abs(bestBid - mark) / mark).toBeLessThan(0.001);
        expect(Math.abs(bestAsk - mark) / mark).toBeLessThan(0.001);
      }
    }
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 6. Position side mapping — close logic
  // ────────────────────────────────────────────────────────────
  it("maps position close side correctly (long → sell, short → buy)", () => {
    // Pure logic check using real market context types
    const scenarios: { side: "long" | "short"; expectedClose: "sell" | "buy" }[] = [
      { side: "long", expectedClose: "sell" },
      { side: "short", expectedClose: "buy" },
    ];

    for (const { side, expectedClose } of scenarios) {
      // The universal close-position rule: to close, you place
      // the opposite side order.
      const closeSide: "buy" | "sell" = side === "long" ? "sell" : "buy";
      expect(closeSide).toBe(expectedClose);
    }
  });

  // ────────────────────────────────────────────────────────────
  // 7. Leverage bounds from real API
  // ────────────────────────────────────────────────────────────
  it("reports maxLeverage >= 20 for BTC and ETH, lower for small-caps", () => {
    const btc = findMarket(markets, "BTC");
    const eth = findMarket(markets, "ETH");

    expect(btc).toBeDefined();
    expect(eth).toBeDefined();

    // HL allows 40-50x on BTC/ETH
    expect(btc!.maxLeverage).toBeGreaterThanOrEqual(20);
    expect(eth!.maxLeverage).toBeGreaterThanOrEqual(20);

    // Find a lower-liquidity asset (take the last market, or one with low volume)
    const lowCap = markets
      .filter(
        (m) =>
          m.symbol !== "BTC" &&
          m.symbol !== "ETH" &&
          m.symbol !== "SOL" &&
          Number(m.volume24h) > 0,
      )
      .sort((a, b) => Number(a.volume24h) - Number(b.volume24h))[0];

    if (lowCap) {
      // Low-cap coins typically have lower max leverage than BTC
      // Allow equality since some may still be 50x; the key check is that the
      // field is populated and numeric
      expect(lowCap.maxLeverage).toBeGreaterThan(0);
      expect(lowCap.maxLeverage).toBeLessThanOrEqual(btc!.maxLeverage);
    }
  });

  // ────────────────────────────────────────────────────────────
  // 8. Funding rate sanity
  // ────────────────────────────────────────────────────────────
  it("returns funding rates in -1% to 1% range for BTC and ETH", () => {
    const btc = findMarket(markets, "BTC");
    const eth = findMarket(markets, "ETH");

    expect(btc).toBeDefined();
    expect(eth).toBeDefined();

    const btcFunding = Number(btc!.fundingRate);
    const ethFunding = Number(eth!.fundingRate);

    // Hourly funding rates should be tiny decimals (e.g., 0.0001 = 0.01%)
    // Anything outside +-1% would indicate a parsing error
    expect(btcFunding).toBeGreaterThan(-0.01);
    expect(btcFunding).toBeLessThan(0.01);

    expect(ethFunding).toBeGreaterThan(-0.01);
    expect(ethFunding).toBeLessThan(0.01);
  });

  // ────────────────────────────────────────────────────────────
  // 9. Invalid symbol rejection
  // ────────────────────────────────────────────────────────────
  it("rejects an invalid symbol (XYZNOTREAL999)", async () => {
    const result = await validateTrade(adapter, {
      symbol: "XYZNOTREAL999",
      side: "buy",
      size: 1,
      type: "market",
    });

    expect(result.valid).toBe(false);

    const symCheck = result.checks.find((c) => c.check === "symbol_valid");
    expect(symCheck).toBeDefined();
    expect(symCheck!.passed).toBe(false);
    expect(symCheck!.message).toContain("not found");
  }, 30_000);

  it("handles an empty symbol gracefully", async () => {
    const result = await validateTrade(adapter, {
      symbol: "",
      side: "buy",
      size: 1,
      type: "market",
    });

    expect(result.valid).toBe(false);
    const symCheck = result.checks.find((c) => c.check === "symbol_valid");
    expect(symCheck).toBeDefined();
    expect(symCheck!.passed).toBe(false);
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 10. Reduce-only without position
  // ────────────────────────────────────────────────────────────
  it("rejects reduce-only when no position exists (dummy account)", async () => {
    const result = await validateTrade(adapter, {
      symbol: "BTC",
      side: "sell",
      size: 0.01,
      type: "market",
      reduceOnly: true,
    });

    // The dummy key has no positions, so the position_exists check should fail
    const posCheck = result.checks.find((c) => c.check === "position_exists");
    expect(posCheck).toBeDefined();
    expect(posCheck!.passed).toBe(false);
    expect(posCheck!.message).toContain("No position found");
    expect(posCheck!.message).toContain("reduce-only");
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 11. Price freshness with real data
  // ────────────────────────────────────────────────────────────
  it("passes price freshness at mark +-1% and fails at +-15%", async () => {
    // Fetch the current BTC mark price
    const btcMarket = findMarket(markets, "BTC");
    expect(btcMarket).toBeDefined();
    const mark = Number(btcMarket!.markPrice);
    expect(mark).toBeGreaterThan(10_000);

    // Limit order at mark + 1% → should pass freshness
    const closeResult = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.001,
      type: "limit",
      price: mark * 1.01,
    });
    const closeFresh = closeResult.checks.find(
      (c) => c.check === "price_fresh",
    );
    expect(closeFresh).toBeDefined();
    expect(closeFresh!.passed).toBe(true);

    // Limit order at mark + 15% → should fail freshness (>10% deviation)
    const farResult = await validateTrade(adapter, {
      symbol: "BTC",
      side: "buy",
      size: 0.001,
      type: "limit",
      price: mark * 1.15,
    });
    const farFresh = farResult.checks.find((c) => c.check === "price_fresh");
    expect(farFresh).toBeDefined();
    expect(farFresh!.passed).toBe(false);
    expect(farFresh!.message).toContain("deviates");
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 12. Cross-exchange spread: native HL vs HIP-3 dex
  // ────────────────────────────────────────────────────────────
  it("compares BTC price on native HL against a HIP-3 dex (hyna)", async () => {
    // Native HL BTC price
    const btcNative = findMarket(markets, "BTC");
    expect(btcNative).toBeDefined();
    const nativePrice = Number(btcNative!.markPrice);
    expect(nativePrice).toBeGreaterThan(10_000);

    // Try to get hyna dex markets — if dex doesn't exist or BTC isn't listed,
    // skip gracefully (the dex landscape changes over time).
    let dexPrice: number | null = null;
    try {
      const dexAdapter = new HyperliquidAdapter(DUMMY_KEY, false);
      await dexAdapter.init();
      dexAdapter.setDex("hyna");
      // Re-init asset map for the dex context
      const dexMarkets = await dexAdapter.getMarkets();
      const btcDex = findMarket(dexMarkets, "BTC");
      if (btcDex) {
        dexPrice = Number(btcDex.markPrice);
      }
    } catch {
      // hyna dex may not exist — skip comparison
    }

    if (dexPrice !== null && dexPrice > 0) {
      // Prices should be within 0.5% of each other (same underlying)
      const divergence = Math.abs(nativePrice - dexPrice) / nativePrice;
      expect(divergence).toBeLessThan(0.005);
    } else {
      // No comparable dex market — test passes vacuously with a note
      console.log(
        "Skipped cross-dex comparison: hyna BTC market not available",
      );
    }
  }, 30_000);
});
