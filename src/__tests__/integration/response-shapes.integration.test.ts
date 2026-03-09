import { describe, it, expect, beforeAll } from "vitest";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import {
  fetchAllDexAssets,
  findDexArbPairs,
  scanDexArb,
  type DexAsset,
  type DexArbPair,
} from "../../dex-asset-map.js";
import { startEventStream, type StreamEvent } from "../../event-stream.js";

/**
 * Integration tests: validate that ALL API response shapes match what
 * user-facing code expects.
 *
 * Hits real Hyperliquid mainnet API (read-only, no private key needed).
 * Catches shape mismatches between live API data and our TypeScript interfaces.
 *
 * Run:
 *   pnpm --filter perp-cli test -- --testPathPattern response-shapes.integration
 */

// Dummy private key for read-only operations (never signs anything)
const DUMMY_KEY = "0x" + "1".repeat(64);

/**
 * Find a market by base symbol, handling possible suffixes (e.g., "BTC-PERP").
 * The SDK may return symbols with or without a -PERP suffix depending on version.
 */
function findMarket<T extends { symbol: string }>(
  markets: T[],
  base: string,
): T | undefined {
  return (
    markets.find((m) => m.symbol === base) ??
    markets.find((m) => m.symbol === `${base}-PERP`) ??
    markets.find((m) => m.symbol.toUpperCase().startsWith(base.toUpperCase()))
  );
}

describe("Response Shape Validation (Hyperliquid Mainnet)", () => {
  let adapter: HyperliquidAdapter;

  beforeAll(async () => {
    adapter = new HyperliquidAdapter(DUMMY_KEY, false);
    await adapter.init();
  }, 30000);

  // ── 1. ExchangeMarketInfo shape ──────────────────────────────────────

  describe("1. ExchangeMarketInfo shape", () => {
    it("every market has all required fields with correct types", async () => {
      const markets = await adapter.getMarkets();

      expect(markets.length).toBeGreaterThanOrEqual(10);

      // BTC and ETH must be present (may have -PERP suffix)
      const btc = findMarket(markets, "BTC");
      const eth = findMarket(markets, "ETH");
      expect(btc).toBeTruthy();
      expect(eth).toBeTruthy();

      for (const m of markets) {
        // symbol: non-empty string
        expect(typeof m.symbol).toBe("string");
        expect(m.symbol.length).toBeGreaterThan(0);

        // markPrice: string, parseable as number > 0
        expect(typeof m.markPrice).toBe("string");
        const mark = Number(m.markPrice);
        expect(Number.isNaN(mark)).toBe(false);
        expect(mark).toBeGreaterThan(0);

        // indexPrice: string
        expect(typeof m.indexPrice).toBe("string");

        // fundingRate: string, parseable as number
        expect(typeof m.fundingRate).toBe("string");
        const funding = Number(m.fundingRate);
        expect(Number.isNaN(funding)).toBe(false);

        // volume24h: string
        expect(typeof m.volume24h).toBe("string");

        // openInterest: string
        expect(typeof m.openInterest).toBe("string");

        // maxLeverage: number > 0
        expect(typeof m.maxLeverage).toBe("number");
        expect(m.maxLeverage).toBeGreaterThan(0);
      }
    }, 30000);
  });

  // ── 2. Orderbook shape ───────────────────────────────────────────────

  describe("2. ExchangeOrder shape (getOrderbook)", () => {
    it("BTC orderbook has correct bid/ask tuple structure", async () => {
      const book = await adapter.getOrderbook("BTC");

      // bids and asks are arrays
      expect(Array.isArray(book.bids)).toBe(true);
      expect(Array.isArray(book.asks)).toBe(true);

      // Both have entries
      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks.length).toBeGreaterThan(0);

      // Each entry is a [price, size] tuple of strings
      for (const [price, size] of book.bids) {
        expect(typeof price).toBe("string");
        expect(typeof size).toBe("string");
        expect(Number.isNaN(Number(price))).toBe(false);
        expect(Number.isNaN(Number(size))).toBe(false);
      }
      for (const [price, size] of book.asks) {
        expect(typeof price).toBe("string");
        expect(typeof size).toBe("string");
        expect(Number.isNaN(Number(price))).toBe(false);
        expect(Number.isNaN(Number(size))).toBe(false);
      }

      // Spread is positive: best bid < best ask
      const bestBid = Number(book.bids[0][0]);
      const bestAsk = Number(book.asks[0][0]);
      expect(bestBid).toBeLessThan(bestAsk);
    }, 30000);
  });

  // ── 3. HIP-3 Deployed Dexes shape ───────────────────────────────────

  describe("3. HIP-3 Deployed Dexes shape", () => {
    it("listDeployedDexes returns correctly shaped dex entries", async () => {
      const dexes = await adapter.listDeployedDexes();

      expect(Array.isArray(dexes)).toBe(true);
      expect(dexes.length).toBeGreaterThanOrEqual(3);

      for (const dex of dexes) {
        // name: non-empty string
        expect(typeof dex.name).toBe("string");
        expect(dex.name.length).toBeGreaterThan(0);

        // assets: string array with length > 0
        expect(Array.isArray(dex.assets)).toBe(true);
        expect(dex.assets.length).toBeGreaterThan(0);
        for (const asset of dex.assets) {
          expect(typeof asset).toBe("string");
        }
      }

      // Known dex "xyz" is present
      const xyz = dexes.find((d) => d.name === "xyz");
      expect(xyz).toBeTruthy();

      // Asset names from deployed dexes contain ":" prefix (e.g., "xyz:TSLA")
      for (const dex of dexes) {
        for (const asset of dex.assets) {
          expect(asset).toContain(":");
        }
      }
    }, 30000);
  });

  // ── 4. DexAsset shape from fetchAllDexAssets ─────────────────────────

  describe("4. DexAsset shape from fetchAllDexAssets", () => {
    let allAssets: DexAsset[];

    beforeAll(async () => {
      allAssets = await fetchAllDexAssets();
    }, 30000);

    it("every asset has all required fields with correct types", () => {
      expect(allAssets.length).toBeGreaterThan(200);

      for (const asset of allAssets) {
        // raw: non-empty string
        expect(typeof asset.raw).toBe("string");
        expect(asset.raw.length).toBeGreaterThan(0);

        // base: non-empty string
        expect(typeof asset.base).toBe("string");
        expect(asset.base.length).toBeGreaterThan(0);

        // dex: non-empty string
        expect(typeof asset.dex).toBe("string");
        expect(asset.dex.length).toBeGreaterThan(0);

        // markPrice: number > 0
        expect(typeof asset.markPrice).toBe("number");
        expect(asset.markPrice).toBeGreaterThan(0);

        // fundingRate: number (not NaN)
        expect(typeof asset.fundingRate).toBe("number");
        expect(Number.isNaN(asset.fundingRate)).toBe(false);

        // maxLeverage: number
        expect(typeof asset.maxLeverage).toBe("number");

        // openInterest: number
        expect(typeof asset.openInterest).toBe("number");

        // volume24h: number
        expect(typeof asset.volume24h).toBe("number");

        // szDecimals: number >= 0
        expect(typeof asset.szDecimals).toBe("number");
        expect(asset.szDecimals).toBeGreaterThanOrEqual(0);
      }
    });

    it("assets come from at least 4 different dexes", () => {
      const dexes = new Set(allAssets.map((a) => a.dex));
      expect(dexes.size).toBeGreaterThanOrEqual(4);
    });
  });

  // ── 5. DexArbPair shape from findDexArbPairs ────────────────────────

  describe("5. DexArbPair shape from findDexArbPairs", () => {
    it("TSLA pairs across dexes have correct shape and constraints", async () => {
      const allAssets = await fetchAllDexAssets();
      const tslaAssets = allAssets.filter((a) => a.base === "TSLA");

      // TSLA should exist on multiple dexes
      expect(tslaAssets.length).toBeGreaterThanOrEqual(2);

      const pairs = findDexArbPairs(tslaAssets);
      expect(pairs.length).toBeGreaterThanOrEqual(1);

      for (const pair of pairs) {
        // underlying: string
        expect(typeof pair.underlying).toBe("string");
        expect(pair.underlying).toBe("TSLA");

        // long and short: DexAsset objects
        expect(pair.long).toBeTruthy();
        expect(pair.short).toBeTruthy();
        expect(typeof pair.long.dex).toBe("string");
        expect(typeof pair.short.dex).toBe("string");

        // long.dex !== short.dex
        expect(pair.long.dex).not.toBe(pair.short.dex);

        // priceGapPct < 5 (same underlying, prices should be close)
        expect(pair.priceGapPct).toBeLessThan(5);

        // annualSpread: reasonable number (not NaN, not Infinity)
        expect(typeof pair.annualSpread).toBe("number");
        expect(Number.isNaN(pair.annualSpread)).toBe(false);
        expect(Number.isFinite(pair.annualSpread)).toBe(true);
      }
    }, 30000);
  });

  // ── 6. scanDexArb full pipeline ──────────────────────────────────────

  describe("6. scanDexArb full pipeline", () => {
    it("returns sorted array with valid pairs", async () => {
      const pairs = await scanDexArb({ minAnnualSpread: 5 });

      expect(Array.isArray(pairs)).toBe(true);

      // Sorted by annualSpread descending
      for (let i = 1; i < pairs.length; i++) {
        expect(pairs[i].annualSpread).toBeLessThanOrEqual(
          pairs[i - 1].annualSpread,
        );
      }

      // Every pair has all required fields and no same-dex pairs
      for (const pair of pairs) {
        expect(typeof pair.underlying).toBe("string");
        expect(pair.underlying.length).toBeGreaterThan(0);

        expect(pair.long).toBeTruthy();
        expect(pair.short).toBeTruthy();
        expect(pair.long.dex).not.toBe(pair.short.dex);

        expect(typeof pair.annualSpread).toBe("number");
        expect(pair.annualSpread).toBeGreaterThanOrEqual(5);
        expect(Number.isFinite(pair.annualSpread)).toBe(true);

        expect(typeof pair.priceGapPct).toBe("number");
        expect(Number.isFinite(pair.priceGapPct)).toBe(true);
      }
    }, 30000);
  });

  // ── 7. Event stream shape (single poll cycle) ───────────────────────

  describe("7. Event stream shape (single poll cycle)", () => {
    it("emits correctly shaped events without crashing", async () => {
      const events: StreamEvent[] = [];
      const controller = new AbortController();

      // Run a single poll cycle then abort
      const streamPromise = startEventStream(adapter, {
        intervalMs: 100_000, // large interval so we only get one poll
        onEvent: (event) => {
          events.push(event);
        },
        signal: controller.signal,
      });

      // Wait briefly for the initial poll to complete, then abort
      await new Promise((resolve) => setTimeout(resolve, 5000));
      controller.abort();

      // Wait for the stream to finish
      await streamPromise;

      // With a dummy key, positions/orders may be empty but the poll should
      // complete without crashing. Any emitted events must conform to shape.
      for (const event of events) {
        // type: valid EventType string
        expect(typeof event.type).toBe("string");
        expect(event.type.length).toBeGreaterThan(0);

        // exchange: string
        expect(typeof event.exchange).toBe("string");
        expect(event.exchange).toBe("hyperliquid");

        // timestamp: ISO format string
        expect(typeof event.timestamp).toBe("string");
        expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);

        // data: object
        expect(typeof event.data).toBe("object");
        expect(event.data).not.toBeNull();
      }
    }, 30000);
  });

  // ── 8. Funding rate / price sanity checks ────────────────────────────

  describe("8. Funding rate and price sanity checks", () => {
    it("BTC and ETH have reasonable funding rates and prices", async () => {
      const markets = await adapter.getMarkets();

      // Handle possible -PERP suffix from SDK
      const btc = findMarket(markets, "BTC");
      const eth = findMarket(markets, "ETH");

      expect(btc).toBeTruthy();
      expect(eth).toBeTruthy();

      // BTC funding rate between -0.01 and 0.01 (1% per period is extreme)
      const btcFunding = Number(btc!.fundingRate);
      expect(btcFunding).toBeGreaterThan(-0.01);
      expect(btcFunding).toBeLessThan(0.01);

      // ETH funding rate between -0.01 and 0.01
      const ethFunding = Number(eth!.fundingRate);
      expect(ethFunding).toBeGreaterThan(-0.01);
      expect(ethFunding).toBeLessThan(0.01);

      // BTC mark price > $100 (catches off-by-order-of-magnitude parsing bugs)
      const btcPrice = Number(btc!.markPrice);
      expect(btcPrice).toBeGreaterThan(100);

      // ETH mark price > $10
      const ethPrice = Number(eth!.markPrice);
      expect(ethPrice).toBeGreaterThan(10);
    }, 30000);
  });
});
