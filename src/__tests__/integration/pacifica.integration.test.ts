import { describe, it, expect, beforeAll } from "vitest";
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import { parseSolanaKeypair } from "../../config.js";

/**
 * Integration tests for Pacifica exchange adapter (Solana Devnet).
 *
 * Prerequisites:
 *   1. Set PACIFICA_PRIVATE_KEY env var (base58 or JSON array)
 *   2. Have devnet SOL:  solana airdrop 2 --url devnet
 *   3. Have devnet USDC deposited into Pacifica testnet
 *
 * Run: PACIFICA_PRIVATE_KEY=<key> pnpm --filter perp-cli test -- --testPathPattern integration/pacifica
 */

const SKIP = !process.env.PACIFICA_PRIVATE_KEY;

describe.skipIf(SKIP)("Pacifica Integration (Devnet)", () => {
  let adapter: PacificaAdapter;

  beforeAll(() => {
    const keypair = parseSolanaKeypair(process.env.PACIFICA_PRIVATE_KEY!);
    adapter = new PacificaAdapter(keypair, "testnet");
  });

  describe("Read-only operations", () => {
    it("fetches markets", async () => {
      const markets = await adapter.getMarkets();
      expect(markets.length).toBeGreaterThan(0);
      expect(markets[0].symbol).toBeTruthy();
      expect(Number(markets[0].maxLeverage)).toBeGreaterThan(0);
    });

    it("fetches orderbook for BTC", async () => {
      const book = await adapter.getOrderbook("BTC");
      expect(book).toHaveProperty("bids");
      expect(book).toHaveProperty("asks");
    });

    it("fetches balance", async () => {
      const balance = await adapter.getBalance();
      expect(balance).toHaveProperty("equity");
      expect(balance).toHaveProperty("available");
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
    // WARNING: These tests place REAL orders on testnet
    const TEST_SYMBOL = "BTC";
    let limitOrderId: string | undefined;

    it("places a limit buy order (far from market)", async () => {
      // Place far below market so it won't fill
      const result = await adapter.limitOrder(TEST_SYMBOL, "buy", "10000", "0.001");
      expect(result).toBeTruthy();

      // Check it appears in open orders
      const orders = await adapter.getOpenOrders();
      const myOrder = orders.find(
        (o) => o.symbol === TEST_SYMBOL && o.side === "buy" && o.price === "10000"
      );
      if (myOrder) {
        limitOrderId = myOrder.orderId;
        expect(myOrder.status).toBe("open");
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
