import { describe, it, expect, vi } from "vitest";
import { validatePlan, executePlan, type ExecutionPlan } from "../plan-executor.js";
import { PerpError } from "../errors.js";

// Mock execution-log to prevent file I/O during tests
vi.mock("../execution-log.js", () => ({
  logExecution: vi.fn().mockReturnValue({ id: "mock", timestamp: new Date().toISOString() }),
}));

// ── Mock adapter ──
//
// Registered venue id ("hyperliquid"): market steps resolve the slippage bound per venue
// (an unregistered name is UNKNOWN_VENUE). Positions are STATEFUL — market_order and
// close_position steps are verified by the measured position delta (placePerpVerified /
// closePerpVerified, CHANGELOG "perp plan execute: market_order and close_position steps
// are verified by the position delta"), so marketOrder moves the position like the venue.

type Pos = { symbol: string; side: "long" | "short"; size: string; entryPrice: string; markPrice: string; liquidationPrice: string | null; unrealizedPnl: string; leverage: number };

const DEFAULT_SLIPPAGE = { bps: 50, source: "default" };
const entryOpts = { reduceOnly: false, slippage: DEFAULT_SLIPPAGE };
const closeOpts = { reduceOnly: true, slippage: DEFAULT_SLIPPAGE };

function liveVenue(initial: Pos[] = []) {
  let positions: Pos[] = initial.map(p => ({ ...p }));
  const applyFill = (symbol: string, side: "buy" | "sell", size: string) => {
    const p = positions.find(x => x.symbol === symbol);
    const signed = (p ? (p.side === "long" ? 1 : -1) * Number(p.size) : 0) + (side === "buy" ? 1 : -1) * Number(size);
    positions = positions.filter(x => x.symbol !== symbol);
    if (Math.abs(signed) > 1e-12) {
      positions.push({ ...(p ?? { symbol, entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }),
        symbol, side: signed > 0 ? "long" : "short", size: String(Number(Math.abs(signed).toFixed(10))) });
    }
  };
  return {
    getPositions: vi.fn(async () => positions.map(p => ({ ...p }))),
    marketOrder: vi.fn(async (symbol: string, side: "buy" | "sell", size: string) => {
      applyFill(symbol, side, size);
      return { orderId: "m1", status: "filled" };
    }),
  };
}

/** A typed definite rejection (nothing was placed) — the only thrown value an order step treats as "failed". */
function rejected(msg: string) {
  return new PerpError("ORDER_REJECTED", msg);
}

function mockAdapter(overrides?: Partial<Record<string, (...args: any[]) => any>>) {
  return {
    name: "hyperliquid",
    getMarkets: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "0" }),
    ...liveVenue(),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
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
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.1", entryOpts);
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
      // Typed definite rejection: an untyped Error would be measured (outcome unknown → pending).
      marketOrder: vi.fn().mockRejectedValue(new PerpError("INSUFFICIENT_BALANCE", "Insufficient balance")),
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
      // Typed definite rejection: an untyped Error would be measured (outcome unknown → pending).
      marketOrder: vi.fn().mockRejectedValue(new PerpError("INSUFFICIENT_BALANCE", "Insufficient balance")),
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

  // CHANGELOG: "onFailure: rollback now actually reverses filled market-order steps (reduce-only
  // closePerpVerified for the MEASURED fill) and cancels resting orders only on the plan step's
  // symbol (previously cancelAllOrders() on every symbol, errors swallowed, fills left open)".
  it("rolls back on failure when onFailure=rollback: reverses the filled market step reduce-only", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue(rejected("Price stale")),
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
    expect(r.steps[0].status).toBe("rolled_back");
    expect(r.steps[1].status).toBe("rolled_back");
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "BTC", "sell", "0.1", closeOpts);
    expect(await adapter.getPositions()).toEqual([]);
    // Never the venue-wide cancel (it would cancel the user's unrelated orders).
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
    expect(r.quarantined).toEqual([]);
  });

  it("rollback cancels only the failed plan's own resting order (by id), not every order", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockResolvedValue({ orderId: "777", status: "open" }),
      stopOrder: vi.fn().mockRejectedValue(rejected("bad trigger")),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "limit_order", params: { symbol: "ETH", side: "buy", size: "1", price: "2000" } },
        { id: "2", action: "stop_order", params: { symbol: "ETH", side: "sell", size: "1", triggerPrice: "1900" }, onFailure: "rollback" },
      ],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("failed");
    expect(r.steps[0].status).toBe("cancelled");
    expect(adapter.cancelOrder).toHaveBeenCalledWith("ETH", "777");
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
  });

  it("a failed reversal is rollback_failed and quarantines the symbol", async () => {
    const venue = liveVenue();
    const fill = venue.marketOrder;
    const adapter = mockAdapter({
      getPositions: venue.getPositions,
      // Entry fills (position moves); the reduce-only reversal is definitively rejected.
      marketOrder: vi.fn()
        .mockImplementationOnce((symbol: string, side: "buy" | "sell", size: string) => fill(symbol, side, size))
        .mockRejectedValueOnce(rejected("reduce-only rejected")),
      limitOrder: vi.fn().mockRejectedValue(rejected("Price stale")),
    });
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [
        { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" } },
        { id: "2", action: "limit_order", params: { symbol: "ETH", side: "sell", size: "1", price: "2000" }, onFailure: "rollback" },
      ],
    };
    const r = await executePlan(adapter, plan);
    expect(r.steps[0].status).toBe("rollback_failed");
    expect(r.steps[0].error?.code).toBe("ROLLBACK_FAILED");
    expect(r.status).toBe("quarantined");
    expect(r.quarantined).toEqual(["BTC"]);
  });

  it("an order step whose outcome is unknown is pending: plan stops, symbol quarantined, never rolled back", async () => {
    vi.useFakeTimers();
    try {
      // The venue acknowledges but the position never moves → ORDER_PENDING after the poll schedule.
      const adapter = mockAdapter({ marketOrder: vi.fn().mockResolvedValue({ orderId: "m1" }) });
      const plan: ExecutionPlan = {
        version: "1.0",
        steps: [
          { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" }, onFailure: "rollback" },
          { id: "2", action: "wait", params: { ms: 1 } },
        ],
      };
      const p = executePlan(adapter, plan);
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r.status).toBe("pending");
      expect(r.steps).toHaveLength(1);
      expect(r.steps[0].status).toBe("pending");
      expect(r.steps[0].error?.code).toBe("ORDER_PENDING");
      expect(r.quarantined).toEqual(["BTC"]);
      // Never resubmitted / reversed.
      expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an untyped error from a market order is NOT read as a rejection (measured → pending)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = mockAdapter({ marketOrder: vi.fn().mockRejectedValue(new Error("socket hang up")) });
      const plan: ExecutionPlan = {
        version: "1.0",
        steps: [{ id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.1" }, onFailure: "skip" }],
      };
      const p = executePlan(adapter, plan);
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r.status).toBe("pending");
      expect(r.steps[0].status).toBe("pending");
      expect(r.quarantined).toEqual(["BTC"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips step when dependency failed (abort)", async () => {
    const adapter = mockAdapter({
      marketOrder: vi.fn().mockRejectedValue(rejected("fail")),
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
      limitOrder: vi.fn().mockRejectedValue(rejected("fail")),
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
    // CHANGELOG: "dependsOn now blocks unless the dependency succeeded (a skipped / pending /
    // rolled-back dependency used to let the step run)".
    expect(r.steps[0].status).toBe("success");
    expect(r.steps[1].status).toBe("skipped");
    expect(r.steps[2].status).toBe("skipped");
    expect(r.steps[2].error?.code).toBe("DEPENDENCY_FAILED");
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
    const adapter = mockAdapter(liveVenue([
      { symbol: "BTC", side: "long", size: "0.5", entryPrice: "65000", unrealizedPnl: "100", liquidationPrice: "60000", markPrice: "66000", leverage: 10 },
    ]));
    const plan: ExecutionPlan = {
      version: "1.0",
      steps: [{ id: "1", action: "close_position", params: { symbol: "BTC" } }],
    };
    const r = await executePlan(adapter, plan);
    expect(r.status).toBe("completed");
    // Reduce-only, sized from the live position, verified (CHANGELOG "Plan close_position is reduce-only").
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.5", closeOpts);
    expect(r.steps[0].result).toEqual({ symbol: "BTC", side: "sell", size: "0.5", closed: 0.5 });
  });

  it("rollback: a partial reverse's residual is floored to the market lot, not the decimals the step size prints (10, 9.3 filled → closes 0.7)", async () => {
    const venue = liveVenue();
    const fill = venue.marketOrder.getMockImplementation()!;
    venue.marketOrder
      .mockImplementationOnce(async (s: string, side: "buy" | "sell") => fill(s, side, "10")) // the entry fills 10
      .mockImplementationOnce(async (s: string, side: "buy" | "sell") => fill(s, side, "9.3")); // the reverse fills 9.3 of 10
    const adapter = mockAdapter({ ...venue, lotStepOf: () => "0.1", limitOrder: vi.fn().mockRejectedValue(rejected("Price stale")) });
    const r = await executePlan(adapter, { version: "1.0", steps: [
      { id: "1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "10" } },
      { id: "2", action: "limit_order", params: { symbol: "ETH", side: "sell", size: "1", price: "2000" }, onFailure: "rollback" },
    ] });
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(3, "BTC", "sell", "0.7", closeOpts);
    expect(r.steps[0].status).toBe("rolled_back");
    expect(await adapter.getPositions()).toEqual([]);
  });

  it("close_position: a partial close's residual is floored to the market lot, not the decimals the size prints (10, 9.3 filled → 0.7)", async () => {
    const venue = liveVenue([{ symbol: "BTC", side: "long", size: "10", entryPrice: "65000", unrealizedPnl: "0", liquidationPrice: null, markPrice: "66000", leverage: 10 }]);
    const fill = venue.marketOrder.getMockImplementation()!;
    venue.marketOrder.mockImplementationOnce(async (s: string, side: "buy" | "sell") => fill(s, side, "9.3")); // the venue fills 9.3 of 10
    const adapter = mockAdapter({ ...venue, getMarkets: vi.fn().mockResolvedValue([{ symbol: "BTC", markPrice: "66000", indexPrice: "66000", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 40, sizeDecimals: 1, stepSize: "0.1", fundingHours: 1, marginTiers: null }]) });
    await executePlan(adapter, { version: "1.0", steps: [{ id: "1", action: "close_position", params: { symbol: "BTC" } }] });
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "BTC", "sell", "0.7", closeOpts);
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
