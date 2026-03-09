import { describe, it, expect, vi, beforeEach } from "vitest";
import { executePlan, type ExecutionPlan } from "../../plan-executor.js";
import type {
  ExchangeAdapter,
  ExchangePosition,
  ExchangeBalance,
} from "../../exchanges/interface.js";

vi.mock("../../execution-log.js", () => ({ logExecution: vi.fn() }));

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

function createMockAdapter(overrides?: {
  positions?: ExchangePosition[];
  balance?: Partial<ExchangeBalance>;
}) {
  const positions: ExchangePosition[] = overrides?.positions ?? [];
  const balance: ExchangeBalance = {
    equity: "10000",
    available: "8000",
    marginUsed: "2000",
    unrealizedPnl: "0",
    ...overrides?.balance,
  };

  return {
    name: "mock",
    getMarkets: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(balance),
    getPositions: vi.fn().mockResolvedValue(positions),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    marketOrder: vi.fn().mockResolvedValue({ orderId: "m-1" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "l-1" }),
    editOrder: vi.fn().mockResolvedValue({ orderId: "e-1" }),
    cancelOrder: vi.fn().mockResolvedValue({ cancelled: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ cancelled: true }),
    setLeverage: vi.fn().mockResolvedValue({ ok: true }),
    stopOrder: vi.fn().mockResolvedValue({ orderId: "s-1" }),
  } as any;
}

// ---------------------------------------------------------------------------
// 1. Open long BTC with stop loss
// ---------------------------------------------------------------------------

describe("Scenario 1: Open long BTC with stop loss", () => {
  it("executes setLeverage -> marketOrder (buy) -> stopOrder (sell) in dependency order", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "lev", action: "set_leverage", params: { symbol: "BTC", leverage: 10 } },
        { id: "buy", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" }, dependsOn: "lev" },
        { id: "sl", action: "stop_order", params: { symbol: "BTC", side: "sell", size: "0.01", triggerPrice: "60000" }, dependsOn: "buy" },
      ],
    };

    const result = await executePlan(adapter, plan);

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.status === "success")).toBe(true);

    // setLeverage: symbol, leverage, marginMode (default "cross")
    expect(adapter.setLeverage).toHaveBeenCalledTimes(1);
    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 10, "cross");

    // marketOrder: symbol, side, size
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.01");

    // stopOrder: symbol, side, size, triggerPrice, opts
    // CRITICAL: stop loss side is SELL (opposite of long)
    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "BTC", "sell", "0.01", "60000",
      { limitPrice: undefined, reduceOnly: false },
    );

    // Verify call order
    const setLevOrder = adapter.setLeverage.mock.invocationCallOrder[0];
    const buyOrder = adapter.marketOrder.mock.invocationCallOrder[0];
    const slOrder = adapter.stopOrder.mock.invocationCallOrder[0];
    expect(setLevOrder).toBeLessThan(buyOrder);
    expect(buyOrder).toBeLessThan(slOrder);
  });
});

// ---------------------------------------------------------------------------
// 2. Delta-neutral hedge
// ---------------------------------------------------------------------------

describe("Scenario 2: Delta-neutral hedge", () => {
  it("opens long BTC and short ETH with correct sides", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "long", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" } },
        { id: "short", action: "market_order", params: { symbol: "ETH", side: "sell", size: "0.1" } },
      ],
    };

    const result = await executePlan(adapter, plan);

    expect(result.status).toBe("completed");
    expect(adapter.marketOrder).toHaveBeenCalledTimes(2);

    // First call: long BTC
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "buy", "0.01");
    // Second call: short ETH
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "sell", "0.1");
  });
});

// ---------------------------------------------------------------------------
// 3. Emergency close all
// ---------------------------------------------------------------------------

describe("Scenario 3: Emergency close all", () => {
  it("cancels all orders then closes BTC long by selling", async () => {
    const adapter = createMockAdapter({
      positions: [
        {
          symbol: "BTC",
          side: "long",
          size: "0.5",
          entryPrice: "65000",
          markPrice: "64000",
          liquidationPrice: "55000",
          unrealizedPnl: "-500",
          leverage: 10,
        },
      ],
    });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "cancel", action: "cancel_all", params: {} },
        { id: "close", action: "close_position", params: { symbol: "BTC" }, dependsOn: "cancel" },
      ],
    };

    const result = await executePlan(adapter, plan);

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(2);

    // cancelAllOrders called first
    expect(adapter.cancelAllOrders).toHaveBeenCalledTimes(1);

    // close_position fetches positions, then sells the long
    expect(adapter.getPositions).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    // CRITICAL: closing a LONG = must SELL, not buy
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.5");

    // Verify order: cancel before market order
    const cancelCallOrder = adapter.cancelAllOrders.mock.invocationCallOrder[0];
    const marketCallOrder = adapter.marketOrder.mock.invocationCallOrder[0];
    expect(cancelCallOrder).toBeLessThan(marketCallOrder);
  });
});

// ---------------------------------------------------------------------------
// 4. Scale in: multiple buys with wait
// ---------------------------------------------------------------------------

describe("Scenario 4: Scale in with wait", () => {
  it("buys ETH twice with a wait pause in between, then checks position", async () => {
    const adapter = createMockAdapter({
      positions: [
        {
          symbol: "ETH",
          side: "long",
          size: "2",
          entryPrice: "3000",
          markPrice: "3100",
          liquidationPrice: "2500",
          unrealizedPnl: "200",
          leverage: 5,
        },
      ],
    });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "buy1", action: "market_order", params: { symbol: "ETH", side: "buy", size: "1" } },
        { id: "wait", action: "wait", params: { ms: 100 }, dependsOn: "buy1" },
        { id: "buy2", action: "market_order", params: { symbol: "ETH", side: "buy", size: "1" }, dependsOn: "wait" },
        { id: "check", action: "check_position", params: { symbol: "ETH", mustExist: true }, dependsOn: "buy2" },
      ],
    };

    const before = Date.now();
    const result = await executePlan(adapter, plan);
    const elapsed = Date.now() - before;

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(4);
    expect(result.steps.every(s => s.status === "success")).toBe(true);

    // marketOrder called exactly twice, both buy ETH 1
    expect(adapter.marketOrder).toHaveBeenCalledTimes(2);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "ETH", "buy", "1");
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "buy", "1");

    // Wait actually paused at least ~100ms
    expect(elapsed).toBeGreaterThanOrEqual(90); // allow small timing margin

    // check_position succeeded (position exists)
    expect(adapter.getPositions).toHaveBeenCalled();
    const checkStep = result.steps.find(s => s.stepId === "check");
    expect(checkStep?.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// 5. Rollback on failure
// ---------------------------------------------------------------------------

describe("Scenario 5: Rollback on failure", () => {
  it("rolls back (cancelAllOrders) when a step with onFailure=rollback throws", async () => {
    const adapter = createMockAdapter();

    // limitOrder will fail
    adapter.limitOrder.mockRejectedValueOnce(new Error("Insufficient margin"));

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "buy", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" } },
        { id: "fail", action: "limit_order", params: { symbol: "ETH", side: "sell", size: "1", price: "2000" }, dependsOn: "buy", onFailure: "rollback" },
      ],
    };

    const result = await executePlan(adapter, plan);

    // Overall status is failed
    expect(result.status).toBe("failed");

    // Step 1 succeeded
    const buyStep = result.steps.find(s => s.stepId === "buy");
    expect(buyStep?.status).toBe("success");

    // Step 2 rolled back
    const failStep = result.steps.find(s => s.stepId === "fail");
    expect(failStep?.status).toBe("rolled_back");
    expect(failStep?.error?.message).toContain("Insufficient margin");

    // Rollback called cancelAllOrders (the rollback function cancels all for market_order steps)
    expect(adapter.cancelAllOrders).toHaveBeenCalled();

    // marketOrder was called once (the buy), limitOrder was called once (the failing sell)
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Skip non-critical step
// ---------------------------------------------------------------------------

describe("Scenario 6: Skip non-critical step", () => {
  it("continues execution when a step with onFailure=skip fails", async () => {
    const adapter = createMockAdapter();

    // stopOrder will fail
    adapter.stopOrder.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "buy", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" } },
        { id: "tp", action: "stop_order", params: { symbol: "BTC", side: "sell", size: "0.01", triggerPrice: "100000" }, onFailure: "skip" },
        { id: "check", action: "check_balance", params: {} },
      ],
    };

    const result = await executePlan(adapter, plan);

    // Overall: completed (skip doesn't cause failure)
    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(3);

    // Step 1 succeeded
    expect(result.steps[0].status).toBe("success");

    // Step 2 was skipped
    expect(result.steps[1].status).toBe("skipped");
    expect(result.steps[1].error?.message).toContain("Rate limit exceeded");

    // Step 3 still executed successfully
    expect(result.steps[2].status).toBe("success");
    expect(adapter.getBalance).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Balance gate
// ---------------------------------------------------------------------------

describe("Scenario 7: Balance gate - don't trade if balance too low", () => {
  it("aborts the plan when check_balance fails with onFailure=abort", async () => {
    const adapter = createMockAdapter({
      balance: { available: "800", equity: "800", marginUsed: "0", unrealizedPnl: "0" },
    });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "gate", action: "check_balance", params: { minAvailable: 10000 }, onFailure: "abort" },
        { id: "buy", action: "market_order", params: { symbol: "BTC", side: "buy", size: "1" }, dependsOn: "gate" },
      ],
    };

    const result = await executePlan(adapter, plan);

    // Plan failed/aborted at the gate
    expect(result.status).toBe("failed");

    // Gate step failed
    const gateStep = result.steps.find(s => s.stepId === "gate");
    expect(gateStep?.status).toBe("failed");
    expect(gateStep?.error?.message).toContain("$800");
    expect(gateStep?.error?.message).toContain("$10000");

    // CRITICAL: marketOrder was NEVER called — the safety gate worked
    expect(adapter.marketOrder).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Close position side correctness (CRITICAL)
// ---------------------------------------------------------------------------

describe("Scenario 8: Close position side correctness", () => {
  it("closes a LONG position by SELLING (not buying)", async () => {
    const adapter = createMockAdapter({
      positions: [
        {
          symbol: "BTC",
          side: "long",
          size: "0.5",
          entryPrice: "65000",
          markPrice: "66000",
          liquidationPrice: "55000",
          unrealizedPnl: "500",
          leverage: 10,
        },
      ],
    });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "close", action: "close_position", params: { symbol: "BTC" } },
      ],
    };

    const result = await executePlan(adapter, plan);

    expect(result.status).toBe("completed");
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    // MUST be sell to close a long — if this were "buy", user doubles their position!
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.5");
  });

  it("closes a SHORT position by BUYING (not selling)", async () => {
    const adapter = createMockAdapter({
      positions: [
        {
          symbol: "ETH",
          side: "short",
          size: "2.0",
          entryPrice: "3500",
          markPrice: "3400",
          liquidationPrice: "4000",
          unrealizedPnl: "200",
          leverage: 5,
        },
      ],
    });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "close", action: "close_position", params: { symbol: "ETH" } },
      ],
    };

    const result = await executePlan(adapter, plan);

    expect(result.status).toBe("completed");
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    // MUST be buy to close a short — if this were "sell", user doubles their position!
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "buy", "2.0");
  });

  it("fails gracefully when closing a non-existent position", async () => {
    const adapter = createMockAdapter({ positions: [] });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "close", action: "close_position", params: { symbol: "SOL" } },
      ],
    };

    const result = await executePlan(adapter, plan);

    // Default onFailure is "abort"
    expect(result.status).toBe("failed");
    const closeStep = result.steps.find(s => s.stepId === "close");
    expect(closeStep?.status).toBe("failed");
    expect(closeStep?.error?.message).toContain("No position found for SOL");
    // No market order placed
    expect(adapter.marketOrder).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Dry run doesn't execute
// ---------------------------------------------------------------------------

describe("Scenario 9: Dry run doesn't execute", () => {
  it("returns dry_run status without calling any adapter trading methods", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "lev", action: "set_leverage", params: { symbol: "BTC", leverage: 10 } },
        { id: "buy", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" }, dependsOn: "lev" },
        { id: "sl", action: "stop_order", params: { symbol: "BTC", side: "sell", size: "0.01", triggerPrice: "60000" }, dependsOn: "buy" },
      ],
    };

    const result = await executePlan(adapter, plan, { dryRun: true });

    // Overall status is dry_run
    expect(result.status).toBe("dry_run");
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.status === "dry_run")).toBe(true);

    // ALL adapter methods have 0 calls
    expect(adapter.setLeverage).toHaveBeenCalledTimes(0);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(0);
    expect(adapter.stopOrder).toHaveBeenCalledTimes(0);
    expect(adapter.limitOrder).toHaveBeenCalledTimes(0);
    expect(adapter.cancelOrder).toHaveBeenCalledTimes(0);
    expect(adapter.cancelAllOrders).toHaveBeenCalledTimes(0);
    expect(adapter.getPositions).toHaveBeenCalledTimes(0);
    expect(adapter.getBalance).toHaveBeenCalledTimes(0);

    // Each step records what it would have done
    for (const step of result.steps) {
      expect((step.result as { wouldExecute: boolean }).wouldExecute).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Dependency chain failure propagation
// ---------------------------------------------------------------------------

describe("Scenario 10: Dependency chain failure propagation", () => {
  it("skips dependent steps when a step fails with default abort", async () => {
    const adapter = createMockAdapter();

    // Step A (market_order) will fail
    adapter.marketOrder.mockRejectedValueOnce(new Error("Exchange down"));

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "A", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" } },
        { id: "B", action: "limit_order", params: { symbol: "BTC", side: "buy", size: "0.02", price: "60000" }, dependsOn: "A" },
        { id: "C", action: "stop_order", params: { symbol: "BTC", side: "sell", size: "0.01", triggerPrice: "55000" }, dependsOn: "B" },
      ],
    };

    const result = await executePlan(adapter, plan);

    // A fails with default abort -> plan stops immediately, B and C never run
    expect(result.status).toBe("failed");

    // Only A is in the results (abort exits immediately)
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].stepId).toBe("A");
    expect(result.steps[0].status).toBe("failed");

    // B and C never executed
    expect(adapter.limitOrder).toHaveBeenCalledTimes(0);
    expect(adapter.stopOrder).toHaveBeenCalledTimes(0);
  });

  it("skips A but still runs B (dependsOn skipped step is not treated as failed) and C", async () => {
    const adapter = createMockAdapter();

    // Step A will fail but is marked skip
    adapter.marketOrder.mockRejectedValueOnce(new Error("Exchange down"));

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "A", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" }, onFailure: "skip" },
        { id: "B", action: "limit_order", params: { symbol: "BTC", side: "buy", size: "0.02", price: "60000" }, dependsOn: "A" },
        { id: "C", action: "check_balance", params: {} },
      ],
    };

    const result = await executePlan(adapter, plan);

    // The executor dependency check only blocks on dep.status === "failed", NOT "skipped".
    // So A is skipped (not "failed"), B's dependency sees a non-failed dep and proceeds, C runs too.
    expect(result.steps).toHaveLength(3);

    expect(result.steps[0].stepId).toBe("A");
    expect(result.steps[0].status).toBe("skipped");

    // B runs because "skipped" !== "failed" in the dependency check
    expect(result.steps[1].stepId).toBe("B");
    expect(result.steps[1].status).toBe("success");

    expect(result.steps[2].stepId).toBe("C");
    expect(result.steps[2].status).toBe("success");

    // marketOrder called once (A, which failed), limitOrder called once (B succeeded)
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).toHaveBeenCalledWith("BTC", "buy", "60000", "0.02");
    expect(adapter.getBalance).toHaveBeenCalledTimes(1);
  });

  it("blocks dependsOn when a step actually fails (status=failed), not skipped", async () => {
    const adapter = createMockAdapter();

    // Step A will fail with default onFailure=abort... but we need "failed" status recorded.
    // With abort, the executor returns immediately so B never enters.
    // To get a "failed" status in completedSteps while continuing, we need a special setup:
    // A fails+abort -> only A in results, plan stops. B never runs.
    adapter.marketOrder.mockRejectedValueOnce(new Error("Exchange down"));

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "A", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" } },
        { id: "B", action: "limit_order", params: { symbol: "BTC", side: "buy", size: "0.02", price: "60000" }, dependsOn: "A" },
      ],
    };

    const result = await executePlan(adapter, plan);

    // Default onFailure=abort causes immediate return
    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe("failed");

    // B never ran
    expect(adapter.limitOrder).toHaveBeenCalledTimes(0);
  });

  it("skipped status does NOT propagate through dependency chain: A(skip) -> B(dep A) -> C(dep B) all run", async () => {
    const adapter = createMockAdapter();

    adapter.marketOrder.mockRejectedValueOnce(new Error("fail"));

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "A", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.01" }, onFailure: "skip" },
        { id: "B", action: "limit_order", params: { symbol: "BTC", side: "buy", size: "0.02", price: "60000" }, dependsOn: "A" },
        { id: "C", action: "stop_order", params: { symbol: "BTC", side: "sell", size: "0.01", triggerPrice: "55000" }, dependsOn: "B" },
      ],
    };

    const result = await executePlan(adapter, plan);

    // The executor only blocks on dep.status === "failed". "skipped" is NOT "failed",
    // so B proceeds (dep A exists and is not failed), and C proceeds (dep B exists and is success).
    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].status).toBe("skipped");  // A failed but skipped
    expect(result.steps[1].status).toBe("success");   // B runs (A's "skipped" != "failed")
    expect(result.steps[2].status).toBe("success");   // C runs (B succeeded)

    // A's market order attempted (failed), B's limit order ran, C's stop order ran
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("cancel_all with empty symbol passes undefined", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "c", action: "cancel_all", params: {} },
      ],
    };

    await executePlan(adapter, plan);

    // Empty string from params -> cancelAllOrders(undefined)
    expect(adapter.cancelAllOrders).toHaveBeenCalledWith(undefined);
  });

  it("set_leverage uses isolated margin mode when specified", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "lev", action: "set_leverage", params: { symbol: "ETH", leverage: 20, marginMode: "isolated" } },
      ],
    };

    await executePlan(adapter, plan);

    expect(adapter.setLeverage).toHaveBeenCalledWith("ETH", 20, "isolated");
  });

  it("check_position with mustExist=true throws when position absent", async () => {
    const adapter = createMockAdapter({ positions: [] });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "chk", action: "check_position", params: { symbol: "SOL", mustExist: true } },
      ],
    };

    const result = await executePlan(adapter, plan);

    expect(result.status).toBe("failed");
    const step = result.steps[0];
    expect(step.status).toBe("failed");
    expect(step.error?.message).toContain("SOL");
    expect(step.error?.message).toContain("not found");
  });

  it("limit_order passes all arguments correctly", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "lim", action: "limit_order", params: { symbol: "ETH", side: "buy", price: "3000", size: "2.5" } },
      ],
    };

    await executePlan(adapter, plan);

    expect(adapter.limitOrder).toHaveBeenCalledWith("ETH", "buy", "3000", "2.5");
  });

  it("stop_order passes limitPrice and reduceOnly options", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        {
          id: "stop",
          action: "stop_order",
          params: {
            symbol: "BTC",
            side: "sell",
            size: "0.1",
            triggerPrice: "58000",
            limitPrice: "57500",
            reduceOnly: true,
          },
        },
      ],
    };

    await executePlan(adapter, plan);

    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "BTC", "sell", "0.1", "58000",
      { limitPrice: "57500", reduceOnly: true },
    );
  });

  it("cancel_order passes symbol and orderId", async () => {
    const adapter = createMockAdapter();

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "cx", action: "cancel_order", params: { symbol: "BTC", orderId: "order-abc-123" } },
      ],
    };

    await executePlan(adapter, plan);

    expect(adapter.cancelOrder).toHaveBeenCalledWith("BTC", "order-abc-123");
  });

  it("symbols are uppercased consistently", async () => {
    const adapter = createMockAdapter({
      positions: [
        {
          symbol: "BTC",
          side: "long",
          size: "1",
          entryPrice: "65000",
          markPrice: "65000",
          liquidationPrice: "55000",
          unrealizedPnl: "0",
          leverage: 10,
        },
      ],
    });

    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "buy", action: "market_order", params: { symbol: "btc", side: "buy", size: "0.1" } },
        { id: "close", action: "close_position", params: { symbol: "btc" }, dependsOn: "buy" },
      ],
    };

    await executePlan(adapter, plan);

    // market_order uppercases the symbol
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "buy", "0.1");
    // close_position uppercases for lookup and uses position's original symbol
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "BTC", "sell", "1");
  });
});
