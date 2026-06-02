import { describe, expect, it, vi, beforeEach } from "vitest";

// Side-effect modules — stubbed so the tests don't touch the real
// execution-log file or the client-id-tracker keystore on disk.
vi.mock("../../execution-log.js", () => ({
  logExecution: vi.fn(),
}));
vi.mock("../../client-id-tracker.js", () => ({
  generateClientId: vi.fn().mockReturnValue("test-id-deterministic"),
  logClientId: vi.fn(),
  isOrderDuplicate: vi.fn().mockReturnValue(false),
}));
// The manual-order risk gate is orthogonal to dry-run gating; stub it to a
// no-op pass so the live-order (dry-run OFF) cases reach marketOrder without
// the gate's getMarkets/getBalance/getPositions fetch. The gate has its own
// coverage in enforce-order-risk.test.ts.
vi.mock("../../trade-validator.js", () => ({
  enforceOrderRisk: vi.fn().mockResolvedValue(undefined),
  validateTrade: vi.fn().mockResolvedValue({ valid: true, checks: [], warnings: [], timestamp: "" }),
}));

import { Command } from "commander";
import { registerTradeCommands } from "../../commands/trade.js";

/**
 * Minimal ExchangeAdapter stub. Only includes the methods that the
 * dry-run gated paths in trade.ts could possibly reach. Any call to
 * marketOrder / placeOrder / closeOrder is the test failing — it means a
 * venue-bound side effect leaked through the --dry-run guard.
 */
function makeMockAdapter() {
  return {
    name: "hyperliquid",
    marketOrder: vi.fn(),
    placeOrder: vi.fn(),
    closeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getMarkets: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
  } as any;
}

function buildProgram(opts: {
  adapter: ReturnType<typeof makeMockAdapter>;
  isDryRun: boolean;
}) {
  const program = new Command();
  program.exitOverride(); // throw on parse error instead of process.exit
  program.option("--dry-run").option("--json");
  registerTradeCommands(
    program,
    async () => opts.adapter,
    () => true, // isJson — silences chalk paths
    () => opts.isDryRun,
  );
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trade --dry-run gating — venue calls must not escape (Section 7 / Rule #2)", () => {
  // --- The core guarantee: dry-run blocks every venue-bound side effect ---

  it("trade market BTC buy 0.01 --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "market", "BTC", "buy", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("trade market BTC sell 0.01 --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "market", "BTC", "sell", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("trade buy <sym> <size> shortcut --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "buy", "BTC", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("trade sell <sym> <size> shortcut --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "sell", "BTC", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  // --- Positive control: prove the test plumbing reaches marketOrder
  //     in the absence of dry-run. Without this, the negative tests
  //     could be passing because of a wiring bug, not because gating works.

  it("trade market WITHOUT --dry-run reaches adapter.marketOrder (positive control)", async () => {
    const adapter = makeMockAdapter();
    adapter.marketOrder.mockResolvedValue({ status: "ok" });
    const program = buildProgram({ adapter, isDryRun: false });

    await program.parseAsync([
      "node", "perp", "--json",
      "trade", "market", "BTC", "buy", "0.01",
    ]).catch(() => {
      // Downstream printJson / logExecution may incidentally throw with
      // mocks — we only care that marketOrder was reached at least once.
    });

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.01");
  });
});
