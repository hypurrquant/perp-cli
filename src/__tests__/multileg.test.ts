/**
 * Tests for multi-leg order parsing and execution logic.
 */
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

function createMockAdapter(overrides: Record<string, unknown> = {}) {
  return {
    name: "test",
    marketOrder: vi.fn().mockResolvedValue({ orderId: "123" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "456" }),
    getBalance: vi.fn().mockResolvedValue({ equity: "100", available: "80", marginUsed: "20", unrealizedPnl: "0" }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    ...overrides,
  };
}

async function setupMultileg(
  getAdapter: (exchange: string) => Promise<unknown>,
) {
  const { registerMultilegCommands } = await import("../commands/multileg.js");
  const program = new Command();
  program.exitOverride();
  registerMultilegCommands(
    program,
    getAdapter as (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
    () => true, // isJson
  );
  return program;
}

describe("Multi-leg order", () => {
  it("executes both legs simultaneously", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:buy:0.01", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).toHaveBeenCalledTimes(2);
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "buy", "0.01");
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "sell", "0.01");
  });

  it("resolves exchange aliases (hl→hyperliquid, lit→lighter)", async () => {
    const adapters = new Map<string, unknown>();
    const getAdapter = vi.fn().mockImplementation(async (ex: string) => {
      if (!adapters.has(ex)) adapters.set(ex, createMockAdapter({ name: ex }));
      return adapters.get(ex);
    });

    const program = await setupMultileg(getAdapter);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:BTC:buy:0.001", "lit:BTC:sell:0.001"], { from: "user" });
    process.stdout.write = origWrite;

    expect(getAdapter).toHaveBeenCalledWith("hyperliquid");
    expect(getAdapter).toHaveBeenCalledWith("lighter");
  });

  it("rejects single leg (needs at least 2)", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:buy:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    // No orders should be placed
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for invalid leg format", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "bad_format", "hl:ETH:buy:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for invalid side", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:long:0.01", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for invalid size", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:buy:abc", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for unknown exchange", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "binance:ETH:buy:0.01", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("rolls back filled legs when one fails", async () => {
    const successAdapter = createMockAdapter({
      marketOrder: vi.fn()
        .mockResolvedValueOnce({ orderId: "filled" })
        .mockResolvedValueOnce({ orderId: "rollback" }),
    });
    const failAdapter = createMockAdapter({
      marketOrder: vi.fn().mockRejectedValue(new Error("Insufficient balance")),
    });

    const getAdapter = vi.fn().mockImplementation(async (ex: string) => {
      return ex === "hyperliquid" ? successAdapter : failAdapter;
    });

    const program = await setupMultileg(getAdapter);

    // Suppress all output
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:buy:0.01", "pac:ETH:sell:0.01"], { from: "user" });

    process.stdout.write = origWrite;

    // HL: buy (fill) + sell (rollback) = 2 calls
    expect(successAdapter.marketOrder).toHaveBeenCalledTimes(2);
    expect(successAdapter.marketOrder).toHaveBeenNthCalledWith(1, "ETH", "buy", "0.01");
    expect(successAdapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "sell", "0.01");

    // Pac: 1 failed call
    expect(failAdapter.marketOrder).toHaveBeenCalledTimes(1);
  });

  it("supports 3+ legs", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(
      ["multi", "hl:ETH:buy:0.01", "pac:SOL:buy:1", "lit:BTC:sell:0.001"],
      { from: "user" },
    );

    process.stdout.write = origWrite;

    expect(adapter.marketOrder).toHaveBeenCalledTimes(3);
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "buy", "0.01");
    expect(adapter.marketOrder).toHaveBeenCalledWith("SOL", "buy", "1");
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.001");
  });
});
