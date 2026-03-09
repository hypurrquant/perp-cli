import { describe, it, expect, beforeAll } from "vitest";
import { LighterAdapter } from "../../exchanges/lighter.js";

/**
 * Integration tests for Lighter exchange adapter (Mainnet ONLY — no testnet available).
 *
 * ⚠️  WARNING: Lighter has NO testnet. These tests run on MAINNET with REAL funds.
 *     Only run if you understand the risks and have funded an account.
 *
 * Prerequisites:
 *   1. Set LIGHTER_PRIVATE_KEY env var (0x-prefixed EVM private key, 66 chars)
 *   2. Have ETH on Ethereum L1 for gas (~$3-10 per tx)
 *   3. Have USDC deposited into Lighter (mainnet)
 *
 * Run: LIGHTER_PRIVATE_KEY=<key> LIGHTER_INTEGRATION=1 pnpm --filter perp-cli test -- --testPathPattern integration/lighter
 */

// Require BOTH the key AND explicit opt-in flag (since this is mainnet)
const SKIP = !process.env.LIGHTER_PRIVATE_KEY || !process.env.LIGHTER_INTEGRATION;

describe.skipIf(SKIP)("Lighter Integration (Mainnet)", () => {
  let adapter: LighterAdapter;

  beforeAll(async () => {
    adapter = new LighterAdapter(process.env.LIGHTER_PRIVATE_KEY!);
    await adapter.init();
  }, 30000);

  describe("Read-only operations (safe)", () => {
    it("initializes with account index", () => {
      expect(adapter.accountIndex).toBeGreaterThanOrEqual(0);
    });

    it("fetches markets", async () => {
      const markets = await adapter.getMarkets();
      expect(Array.isArray(markets)).toBe(true);
    });

    it("fetches orderbook", async () => {
      const book = await adapter.getOrderbook("BTC");
      expect(book).toHaveProperty("bids");
      expect(book).toHaveProperty("asks");
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

  // Trading tests intentionally omitted for Lighter (mainnet = real money)
  // Use the CLI manually for trade testing: perp trade limit BTC buy 10000 0.001 --exchange lighter
});
