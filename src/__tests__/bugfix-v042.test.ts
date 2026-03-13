/**
 * Tests for v0.4.2 bug fixes (BUG 1–7).
 */
import { describe, it, expect, vi } from "vitest";

// ── BUG 1: HL editOrder preserves original side ──
describe("BUG 1: HL editOrder preserves side", () => {
  it("editOrder passes existing order side (sell) to modifyOrder", async () => {
    // Dynamically import to avoid top-level side effects
    const mod = await import("../exchanges/hyperliquid.js");
    const HyperliquidAdapter = mod.HyperliquidAdapter;

    // Create a partial mock: override getOpenOrders and modifyOrder
    const adapter = Object.create(HyperliquidAdapter.prototype);
    adapter.getOpenOrders = vi.fn().mockResolvedValue([
      { orderId: "42", symbol: "ETH", side: "sell", price: "3000", size: "0.1", filled: "0", status: "open", type: "limit" },
    ]);
    adapter.modifyOrder = vi.fn().mockResolvedValue({ status: "ok" });

    await adapter.editOrder("ETH", "42", "3100", "0.1");

    expect(adapter.modifyOrder).toHaveBeenCalledWith("ETH", 42, "sell", "3100", "0.1");
  });

  it("editOrder defaults to buy when order not found in open orders", async () => {
    const mod = await import("../exchanges/hyperliquid.js");
    const HyperliquidAdapter = mod.HyperliquidAdapter;

    const adapter = Object.create(HyperliquidAdapter.prototype);
    adapter.getOpenOrders = vi.fn().mockResolvedValue([]);
    adapter.modifyOrder = vi.fn().mockResolvedValue({ status: "ok" });

    await adapter.editOrder("ETH", "999", "3100", "0.1");

    // Falls back to "buy" when order not found
    expect(adapter.modifyOrder).toHaveBeenCalledWith("ETH", 999, "buy", "3100", "0.1");
  });
});

// ── BUG 2: Lighter getMarkPrice throws on 0 ──
describe("BUG 2: Lighter getMarkPrice throws on zero", () => {
  it("marketOrder throws when mark price is 0", async () => {
    const mod = await import("../exchanges/lighter.js");
    const LighterAdapter = mod.LighterAdapter;

    // Create mock adapter that simulates getMarkPrice returning 0
    const adapter = Object.create(LighterAdapter.prototype);
    adapter._readOnly = false;
    adapter._signer = {};
    adapter._marketMap = new Map([["BTC", 0]]);
    adapter._marketDecimals = new Map([["BTC", { size: 4, price: 2 }]]);
    adapter.ensureSigner = vi.fn();
    adapter.getNextNonce = vi.fn().mockResolvedValue(1);
    adapter.getMarketIndex = vi.fn().mockReturnValue(0);
    adapter.toTicks = vi.fn().mockReturnValue({ baseAmount: 10000, priceTicks: 0 });

    // Mock restGet to return 0 mark price
    adapter.restGet = vi.fn().mockResolvedValue({
      order_book_details: [{ symbol: "BTC", last_trade_price: 0 }],
    });

    await expect(adapter.marketOrder("BTC", "buy", "0.001")).rejects.toThrow(
      /Cannot determine mark price/
    );
  });
});

// ── BUG 3: inferTickSize float precision ──
// (Covered in smart-order.test.ts — "rounds tick size to eliminate floating-point noise")

// ── BUG 4: cancelAllOrders respects symbol filter ──
describe("BUG 4: cancelAllOrders respects symbol filter", () => {
  it("Pacifica cancelAllOrders filters by symbol", async () => {
    const mod = await import("../exchanges/pacifica.js");
    const PacificaAdapter = mod.PacificaAdapter;

    const adapter = Object.create(PacificaAdapter.prototype);
    adapter.getOpenOrders = vi.fn().mockResolvedValue([
      { orderId: "1", symbol: "SOL", side: "buy", price: "100", size: "1", filled: "0", status: "open", type: "limit" },
      { orderId: "2", symbol: "BTC", side: "sell", price: "50000", size: "0.01", filled: "0", status: "open", type: "limit" },
      { orderId: "3", symbol: "SOL", side: "sell", price: "110", size: "1", filled: "0", status: "open", type: "limit" },
    ]);
    adapter.cancelOrder = vi.fn().mockResolvedValue({ ok: true });

    await adapter.cancelAllOrders("SOL");

    // Should only cancel SOL orders (IDs 1 and 3)
    expect(adapter.cancelOrder).toHaveBeenCalledTimes(2);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("SOL", "1");
    expect(adapter.cancelOrder).toHaveBeenCalledWith("SOL", "3");
  });

  it("Pacifica cancelAllOrders cancels all when no symbol", async () => {
    const mod = await import("../exchanges/pacifica.js");
    const PacificaAdapter = mod.PacificaAdapter;

    const adapter = Object.create(PacificaAdapter.prototype);
    adapter.client = {
      cancelAllOrders: vi.fn().mockResolvedValue({ ok: true }),
    };
    adapter.account = "test-account";
    adapter.signMessage = vi.fn();

    await adapter.cancelAllOrders();

    expect(adapter.client.cancelAllOrders).toHaveBeenCalledWith(
      { all_symbols: true, exclude_reduce_only: false },
      "test-account",
      expect.any(Function),
    );
  });

  it("Lighter cancelAllOrders filters by symbol", async () => {
    const mod = await import("../exchanges/lighter.js");
    const LighterAdapter = mod.LighterAdapter;

    const adapter = Object.create(LighterAdapter.prototype);
    adapter._readOnly = false;
    adapter.ensureSigner = vi.fn();
    adapter.getOpenOrders = vi.fn().mockResolvedValue([
      { orderId: "10", symbol: "ETH", side: "buy", price: "3000", size: "0.1", filled: "0", status: "open", type: "limit" },
      { orderId: "20", symbol: "BTC", side: "sell", price: "50000", size: "0.01", filled: "0", status: "open", type: "limit" },
    ]);
    adapter.cancelOrder = vi.fn().mockResolvedValue({ ok: true });

    await adapter.cancelAllOrders("ETH");

    expect(adapter.cancelOrder).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("ETH", "10");
  });
});

// ── BUG 5: HL getAssetIndex retries on empty map ──
describe("BUG 5: HL getAssetIndex retries on empty map", () => {
  it("retries _loadAssetMap when map is empty", async () => {
    const mod = await import("../exchanges/hyperliquid.js");
    const HyperliquidAdapter = mod.HyperliquidAdapter;

    const adapter = Object.create(HyperliquidAdapter.prototype);
    adapter._assetMap = new Map();
    adapter._assetMapReverse = new Map();
    adapter._dex = "";

    // _loadAssetMap populates the map on retry
    adapter._loadAssetMap = vi.fn().mockImplementation(async () => {
      adapter._assetMap.set("BTC", 0);
      adapter._assetMap.set("ETH", 1);
    });
    adapter.resolveSymbol = vi.fn().mockReturnValue("BTC");

    const idx = await adapter.getAssetIndex("BTC");
    expect(adapter._loadAssetMap).toHaveBeenCalledTimes(1);
    expect(idx).toBe(0);
  });

  it("does not retry when map is already populated", async () => {
    const mod = await import("../exchanges/hyperliquid.js");
    const HyperliquidAdapter = mod.HyperliquidAdapter;

    const adapter = Object.create(HyperliquidAdapter.prototype);
    adapter._assetMap = new Map([["BTC", 0]]);
    adapter._assetMapReverse = new Map([[0, "BTC"]]);
    adapter._loadAssetMap = vi.fn();
    adapter.resolveSymbol = vi.fn().mockReturnValue("BTC");

    const idx = await adapter.getAssetIndex("BTC");
    expect(adapter._loadAssetMap).not.toHaveBeenCalled();
    expect(idx).toBe(0);
  });
});

// ── BUG 7: cli-spec version from package.json ──
describe("BUG 7: cli-spec reads version from package.json", () => {
  it("version is not hardcoded '0.1.0'", async () => {
    const { getCliSpec } = await import("../cli-spec.js");
    const { Command } = await import("commander");
    const program = new Command();
    program.name("perp");
    const spec = getCliSpec(program);
    expect(spec.version).not.toBe("0.1.0");
    // Should match the version in package.json
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version: string };
    expect(spec.version).toBe(pkg.version);
  });
});
