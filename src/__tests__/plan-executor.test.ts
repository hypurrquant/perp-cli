import { describe, it, expect, vi } from "vitest";
import { validatePlan, executePlan, type ExecutionPlan } from "../plan-executor.js";

// Mock execution-log to prevent file I/O during tests
vi.mock("../execution-log.js", () => ({
  logExecution: vi.fn().mockReturnValue({ id: "mock", timestamp: new Date().toISOString() }),
}));

// ── Mock adapter ──
function mockAdapter(overrides?: Partial<Record<string, (...args: any[]) => any>>) {
  return {
    name: "test",
    getMarkets: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "0" }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    marketOrder: vi.fn().mockResolvedValue({ orderId: "m1", status: "filled" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "l1", status: "open" }),
    stopOrder: vi.fn().mockResolvedValue({ orderId: "s1" }),
    cancelOrder: vi.fn().mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ cancelled: 0 }),
    setLeverage: vi.fn().mockResolvedValue({ leverage: 10 }),
    ...overrides,
  } as any;
}

describe("validatePlan — structural validation", () => {
  it("accepts valid plan", () => {
    const plan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" } },
        { id: "2", action: "wait", params: { ms: 500 } },
      ],
    };
    const r = validatePlan(plan);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects non-object input", () => {
    expect(validatePlan(null).valid).toBe(false);
    expect(validatePlan("bad").valid).toBe(false);
  });

  it("rejects wrong version", () => {
    const r = validatePlan({ version: "2.0", steps: [{ id: "1", action: "wait", params: { ms: 1 } }] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("version");
  });

  it("rejects missing steps", () => {
    const r = validatePlan({ version: "1.0" });
    expect(r.valid).toBe(false);
  });

  it("rejects empty steps array", () => {
    const r = validatePlan({ version: "1.0", steps: [] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("no steps");
  });

  it("rejects duplicate step IDs", () => {
    const r = validatePlan({
      version: "1.0",
      steps: [
        { id: "dup", action: "wait", params: { ms: 1 } },
        { id: "dup", action: "wait", params: { ms: 2 } },
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("duplicate"))).toBe(true);
  });

  it("rejects invalid action", () => {
    const r = validatePlan({ version: "1.0", steps: [{ id: "1", action: "fly_to_moon", params: {} }] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("invalid action");
  });

  it("requires symbol/side/size for order actions", () => {
    const r = validatePlan({
      version: "1.0",
      steps: [{ id: "1", action: "market_order", params: {} }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("symbol"))).toBe(true);
    expect(r.errors.some(e => e.includes("side"))).toBe(true);
    expect(r.errors.some(e => e.includes("size"))).toBe(true);
  });

  it("requires price for limit_order", () => {
    const r = validatePlan({
      version: "1.0",
      steps: [{ id: "1", action: "limit_order", params: { symbol: "BTC", side: "buy", size: "1" } }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("price"))).toBe(true);
  });

  it("requires triggerPrice for stop_order", () => {
    const r = validatePlan({
      version: "1.0",
      steps: [{ id: "1", action: "stop_order", params: { symbol: "BTC", side: "sell", size: "1" } }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("triggerPrice"))).toBe(true);
  });

  it("requires ms for wait", () => {
    const r = validatePlan({ version: "1.0", steps: [{ id: "1", action: "wait", params: {} }] });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("ms"))).toBe(true);
  });

  it("rejects invalid onFailure value", () => {
    const r = validatePlan({
      version: "1.0",
      steps: [{ id: "1", action: "wait", params: { ms: 1 }, onFailure: "panic" }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("onFailure"))).toBe(true);
  });

  it("detects broken dependsOn reference", () => {
    const r = validatePlan({
      version: "1.0",
      steps: [{ id: "1", action: "wait", params: { ms: 1 }, dependsOn: "nonexistent" }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("dependsOn"))).toBe(true);
  });
});

describe("executePlan — dry run", () => {
  it("dry run produces dry_run status for all steps", async () => {
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" } },
        { id: "2", action: "check_balance", params: {} },
      ],
    };
    const adapter = mockAdapter();
    const r = await executePlan(adapter, plan, { dryRun: true });

    expect(r.status).toBe("dry_run");
    expect(r.steps).toHaveLength(2);
    for (const s of r.steps) {
      expect(s.status).toBe("dry_run");
    }
    // No actual calls should have been made
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });
});

describe("executePlan — live execution", () => {
  it("executes market_order and wait sequentially", async () => {
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" } },
        { id: "2", action: "wait", params: { ms: 10 } },
      ],
    };
    const adapter = mockAdapter();
    const r = await executePlan(adapter, plan);

    expect(r.status).toBe("completed");
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].status).toBe("success");
    expect(r.steps[1].status).toBe("success");
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.1");
  });

  it("executes check_balance and validates minimum", async () => {
    const adapter = mockAdapter();
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [{ id: "1", action: "check_balance", params: { minAvailable: 500 } }],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("completed");
    expect(r.steps[0].status).toBe("success");
  });

  it("fails check_balance when balance is too low", async () => {
    const adapter = mockAdapter({
      getBalance: vi.fn().mockResolvedValue({ equity: "100", available: "50", marginUsed: "50", unrealizedPnl: "0" }),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [{ id: "1", action: "check_balance", params: { minAvailable: 500 } }],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("failed");
    expect(r.steps[0].status).toBe("failed");
  });
});

describe("executePlan — failure modes", () => {
  it("aborts on failure by default", async () => {
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockRejectedValue(new Error("Insufficient balance")),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "100" } },
        { id: "2", action: "wait", params: { ms: 1 } },
      ],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("failed");
    expect(r.steps).toHaveLength(1); // step 2 never reached
    expect(r.steps[0].status).toBe("failed");
  });

  it("skips failed step when onFailure=skip", async () => {
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockRejectedValue(new Error("Insufficient balance")),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "100" }, onFailure: "skip" },
        { id: "2", action: "wait", params: { ms: 1 } },
      ],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("completed");
    expect(r.steps[0].status).toBe("skipped");
    expect(r.steps[1].status).toBe("success");
  });

  it("rolls back on failure when onFailure=rollback", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue(new Error("Price stale")),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" } },
        { id: "2", action: "limit_order", params: { symbol: "ETH", side: "sell", size: "1", price: "2000" }, onFailure: "rollback" },
      ],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("failed");
    expect(r.steps[0].status).toBe("success");
    expect(r.steps[1].status).toBe("rolled_back");
    // cancelAllOrders called during rollback
    expect(adapter.cancelAllOrders).toHaveBeenCalled();
  });

  it("skips step when dependency failed (abort)", async () => {
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockRejectedValue(new Error("fail")),
      // Step 1 will abort by default, so step 2 never runs
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" } },
        { id: "2", action: "wait", params: { ms: 1 }, dependsOn: "1" },
      ],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("failed");
    expect(r.steps).toHaveLength(1); // step 2 never reached due to abort
    expect(r.steps[0].status).toBe("failed");
  });

  it("skips dependent step when dependency status is failed", async () => {
    // Use two steps where step 1 fails with skip, then step 2 depends on step 3 which fails
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "wait", params: { ms: 1 } },
        { id: "2", action: "limit_order", params: { symbol: "BTC", side: "buy", size: "1", price: "50000" }, onFailure: "skip" },
        { id: "3", action: "wait", params: { ms: 1 }, dependsOn: "2" },
      ],
    };
    const r = await executePlan(adapter, plan);
    // Step 2 is skipped (onFailure=skip), step 3 runs because "skipped" != "failed"
    expect(r.steps[0].status).toBe("success");
    expect(r.steps[1].status).toBe("skipped");
    // Step 3 still runs — skipped deps are treated as present but not "failed"
    expect(r.steps[2].status).toBe("success");
  });
});

describe("executePlan — action types", () => {
  it("executes set_leverage", async () => {
    const adapter = mockAdapter();
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [{ id: "1", action: "set_leverage", params: { symbol: "BTC", leverage: 10, marginMode: "cross" } }],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("completed");
    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 10, "cross");
  });

  it("executes cancel_order", async () => {
    const adapter = mockAdapter();
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [{ id: "1", action: "cancel_order", params: { symbol: "BTC", orderId: "abc123" } }],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("completed");
    expect(adapter.cancelOrder).toHaveBeenCalledWith("BTC", "abc123");
  });

  it("executes close_position", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "0.5", entryPrice: "65000", unrealizedPnl: "100", liquidationPrice: "60000", markPrice: "66000", leverage: "10", marginMode: "cross" },
      ]),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [{ id: "1", action: "close_position", params: { symbol: "BTC" } }],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("completed");
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.5");
  });

  it("fails close_position when no position exists", async () => {
    const adapter = mockAdapter();
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [{ id: "1", action: "close_position", params: { symbol: "BTC" } }],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("failed");
    expect(r.steps[0].error?.message).toContain("No position found");
  });
});
