import { describe, it, expect, beforeAll } from "vitest";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";

/**
 * Integration tests for Hyperliquid exchange adapter (Testnet).
 *
 * Prerequisites:
 *   1. Set HYPERLIQUID_PRIVATE_KEY env var (0x-prefixed EVM private key, 66 chars)
 *   2. Have testnet ETH on Arbitrum Sepolia (for gas)
 *   3. Have testnet USDC deposited into Hyperliquid testnet
 *
 * Run: HYPERLIQUID_PRIVATE_KEY=<key> pnpm --filter perp-cli test -- --testPathPattern integration/hyperliquid
 */

const SKIP = !process.env.HYPERLIQUID_PRIVATE_KEY;

describe.skipIf(SKIP)("Hyperliquid Integration (Testnet)", () => {
  let adapter: HyperliquidAdapter;

  beforeAll(async () => {
    adapter = new HyperliquidAdapter(process.env.HYPERLIQUID_PRIVATE_KEY!, true);
    await adapter.init();
  }, 30000);

  describe("Read-only operations", () => {
    it("initializes and has address", () => {
      expect(adapter.address).toBeTruthy();
      expect(adapter.address.startsWith("0x")).toBe(true);
    });

    it("fetches markets", async () => {
      const markets = await adapter.getMarkets();
      expect(markets.length).toBeGreaterThan(0);
      const btc = markets.find((m) => m.symbol === "BTC");
      expect(btc).toBeTruthy();
      expect(Number(btc!.markPrice)).toBeGreaterThan(0);
    });

    it("resolves asset index for BTC", async () => {
      const idx = await adapter.getAssetIndex("BTC");
      expect(typeof idx).toBe("number");
      expect(idx).toBeGreaterThanOrEqual(0);
    });

    it("fetches orderbook for BTC", async () => {
      const book = await adapter.getOrderbook("BTC");
      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks.length).toBeGreaterThan(0);
    });

    it("fetches balance", async () => {
      const balance = await adapter.getBalance();
      expect(balance).toHaveProperty("equity");
      expect(Number(balance.equity)).toBeGreaterThanOrEqual(0);
    });

    it("fetches positions", async () => {
      const positions = await adapter.getPositions();
      expect(Array.isArray(positions)).toBe(true);
    });

    it("fetches open orders", async () => {
      const orders = await adapter.getOpenOrders();
      expect(Array.isArray(orders)).toBe(true);
    });
  });

  describe("Trading operations", () => {
    const TEST_SYMBOL = "BTC";
    let limitOrderId: string | undefined;

    it("places a limit buy order (far from market)", async () => {
      const result = await adapter.limitOrder(TEST_SYMBOL, "buy", "10000", "0.001");
      expect(result).toBeTruthy();

      const orders = await adapter.getOpenOrders();
      const myOrder = orders.find(
        (o) => o.symbol === TEST_SYMBOL && o.side === "buy"
      );
      if (myOrder) {
        limitOrderId = myOrder.orderId;
      }
    });

    it("cancels the limit order", async () => {
      if (!limitOrderId) return;
      const result = await adapter.cancelOrder(TEST_SYMBOL, limitOrderId);
      expect(result).toBeTruthy();
    });

    it("cancel all orders succeeds", async () => {
      const result = await adapter.cancelAllOrders();
      expect(result).toBeTruthy();
    });
  });
});
