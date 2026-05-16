import { describe, it, expect, vi } from "vitest";
import { startEventStream, type StreamEvent } from "../event-stream.js";

function mockAdapter(overrides?: Record<string, any>) {
  return {
    name: "test",
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "0" }),
    ...overrides,
  } as any;
}

describe("startEventStream — basic polling", () => {
  it("emits heartbeat after 12 cycles", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let pollCount = 0;

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 13) controller.abort();
        return [];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const heartbeats = events.filter(e => e.type === "heartbeat");
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0].data.cycle).toBe(12);
    expect(heartbeats[0].exchange).toBe("test");
  });

  it("emits position_opened when new position appears", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return []; // first poll: no positions
        controller.abort();
        return [{ symbol: "BTC", side: "long", size: "0.1", entryPrice: "65000", unrealizedPnl: "50", liquidationPrice: "60000", markPrice: "65500" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const opened = events.filter(e => e.type === "position_opened");
    expect(opened.length).toBe(1);
    expect(opened[0].data.symbol).toBe("BTC");
    expect(opened[0].data.side).toBe("long");
  });

  it("emits position_closed when position disappears", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return [{ symbol: "ETH", side: "short", size: "5", entryPrice: "2000", unrealizedPnl: "-10", liquidationPrice: "2200", markPrice: "2010" }];
        controller.abort();
        return []; // position gone
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const closed = events.filter(e => e.type === "position_closed");
    expect(closed.length).toBe(1);
    expect(closed[0].data.symbol).toBe("ETH");
  });

  it("emits position_updated when size changes", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return [{ symbol: "SOL", side: "long", size: "10", entryPrice: "100", unrealizedPnl: "0", liquidationPrice: "80", markPrice: "100" }];
        controller.abort();
        return [{ symbol: "SOL", side: "long", size: "20", entryPrice: "100", unrealizedPnl: "0", liquidationPrice: "80", markPrice: "100" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const updated = events.filter(e => e.type === "position_updated");
    expect(updated.length).toBe(1);
    expect(updated[0].data.prevSize).toBe("10");
    expect(updated[0].data.size).toBe("20");
  });
});

describe("startEventStream — order diffs", () => {
  it("emits order_placed for new orders", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return [];
        controller.abort();
        return [{ orderId: "o1", symbol: "BTC", side: "buy", price: "60000", size: "0.1", status: "open" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const placed = events.filter(e => e.type === "order_placed");
    expect(placed.length).toBe(1);
    expect(placed[0].data.orderId).toBe("o1");
  });

  it("emits order_cancelled when order disappears without position change", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return [{ orderId: "o1", symbol: "BTC", side: "buy", price: "60000", size: "0.1", status: "open" }];
        controller.abort();
        return []; // order gone
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const cancelled = events.filter(e => e.type === "order_cancelled");
    expect(cancelled.length).toBe(1);
  });
});

describe("startEventStream — balance updates", () => {
  it("emits balance_update when equity changes significantly", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getBalance: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return { equity: "1000.00", available: "800.00", marginUsed: "200", unrealizedPnl: "0" };
        controller.abort();
        return { equity: "1050.50", available: "850.50", marginUsed: "200", unrealizedPnl: "50.50" };
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const balanceUpdates = events.filter(e => e.type === "balance_update");
    expect(balanceUpdates.length).toBe(1);
    expect(balanceUpdates[0].data.equity).toBe("1050.50");
    expect(balanceUpdates[0].data.prevEquity).toBe("1000.00");
  });

  it("does not emit balance_update for tiny changes", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getBalance: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return { equity: "1000.00", available: "800.00", marginUsed: "200", unrealizedPnl: "0" };
        controller.abort();
        return { equity: "1000.005", available: "800.005", marginUsed: "200", unrealizedPnl: "0.005" };
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const balanceUpdates = events.filter(e => e.type === "balance_update");
    expect(balanceUpdates.length).toBe(0);
  });
});

describe("startEventStream — liquidation warnings", () => {
  it("emits liquidation_warning when within threshold", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        controller.abort();
        // markPrice=100, liqPrice=92 → 8% distance
        return [{ symbol: "SOL", side: "long", size: "10", entryPrice: "95", unrealizedPnl: "50", liquidationPrice: "92", markPrice: "100" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      liquidationWarningPct: 10,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const warnings = events.filter(e => e.type === "liquidation_warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0].riskLevel).toBe("warning");
    expect(warnings[0].data.distancePct).toBe(8);
  });

  it("emits margin_call when critically close (<3%)", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        controller.abort();
        // markPrice=100, liqPrice=98 → 2% distance
        return [{ symbol: "SOL", side: "long", size: "10", entryPrice: "95", unrealizedPnl: "50", liquidationPrice: "98", markPrice: "100" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const calls = events.filter(e => e.type === "margin_call");
    expect(calls.length).toBe(1);
    expect(calls[0].riskLevel).toBe("critical");
  });

  it("skips liquidation check for N/A liquidation price", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [{ symbol: "SOL", side: "long", size: "10", entryPrice: "95", unrealizedPnl: "50", liquidationPrice: "N/A", markPrice: "100" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const warnings = events.filter(e => e.type === "liquidation_warning" || e.type === "margin_call");
    expect(warnings.length).toBe(0);
  });
});

describe("startEventStream — non-finite numeric guards (Rule #2)", () => {
  // Regression coverage for the guards added in ed533cb at
  // src/event-stream.ts:131-136 (mark/liq) and 201-203 (balance). A NaN
  // would silently fail `> 0` / `> 0.01` comparisons (NaN comparisons are
  // always false), suppressing the very alerts users rely on. The fix
  // surfaces corruption via `console.warn` and skips the affected branch.

  it("suppresses liquidation_warning / margin_call when markPrice is NaN, logs warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: StreamEvent[] = [];
    const controller = new AbortController();

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        controller.abort();
        // NaN-producing markPrice; finite liqPrice. Pre-fix code computed
        // `(NaN - 92) / NaN * 100` → NaN, which would silently fail every
        // `< 3` and `< 10` comparison, hiding the alert.
        return [{ symbol: "SOL", side: "long", size: "10", entryPrice: "95", unrealizedPnl: "50", liquidationPrice: "92", markPrice: "NaN" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(events.filter((e) => e.type === "liquidation_warning" || e.type === "margin_call")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-finite mark\/liquidation for SOL on test/));
    warn.mockRestore();
  });

  it("suppresses liquidation_warning when markPrice is the empty string '' (qa/2026-05-16 strict policy)", async () => {
    // Number("") === 0 in JS — pre-fix code would pass the finiteness check,
    // then `mark > 0` would be false, silently skipping the alert without
    // surfacing the payload break. Strict policy now adds an explicit ""
    // rejection at event-stream.ts:131-134.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: StreamEvent[] = [];
    const controller = new AbortController();

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [{ symbol: "ETH", side: "long", size: "1", entryPrice: "3000", unrealizedPnl: "0", liquidationPrice: "2700", markPrice: "" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(events.filter((e) => e.type === "liquidation_warning" || e.type === "margin_call")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-finite mark\/liquidation for ETH/));
    warn.mockRestore();
  });

  it("suppresses liquidation_warning when liquidationPrice is non-numeric (not 'N/A')", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: StreamEvent[] = [];
    const controller = new AbortController();

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [{ symbol: "BTC", side: "long", size: "1", entryPrice: "50000", unrealizedPnl: "0", liquidationPrice: "garbage", markPrice: "50000" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(events.filter((e) => e.type === "liquidation_warning" || e.type === "margin_call")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-finite mark\/liquidation for BTC/));
    warn.mockRestore();
  });

  it("stays silent (no warn) when liquidationPrice is exactly 'N/A' — venue sentinel, not corruption", async () => {
    // The guard explicitly preserves the 'N/A' sentinel as a non-warn case
    // (event-stream.ts:132). Otherwise every non-positioned exchange would
    // spam the console on every poll.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [{ symbol: "BTC", side: "long", size: "1", entryPrice: "50000", unrealizedPnl: "0", liquidationPrice: "N/A", markPrice: "NaN" }];
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: () => {},
      signal: controller.signal,
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("suppresses balance_update when current balance has a non-finite field, logs warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getBalance: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return { equity: "1000.00", available: "800.00", marginUsed: "200", unrealizedPnl: "0" };
        controller.abort();
        // Second cycle: venue returned a corrupt equity. Pre-fix code would
        // compute `Math.abs(NaN - 1000) = NaN`, fail `NaN > 0.01`, and
        // silently swallow the balance_update.
        return { equity: "NaN", available: "850", marginUsed: "200", unrealizedPnl: "0" };
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(events.filter((e) => e.type === "balance_update")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-finite balance values for test/));
    warn.mockRestore();
  });

  it("suppresses balance_update when current equity is the empty string '' (qa/2026-05-16 strict policy)", async () => {
    // Pre-fix: Number("") === 0, so `Math.abs(0 - 1000) = 1000 > 0.01` would
    // fire a balance_update event with data.equity="" — laundering corruption
    // as a synthetic delta. Strict policy at event-stream.ts:204-209 catches
    // the "" upfront and skips the emit with a warn instead.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getBalance: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return { equity: "1000.00", available: "800.00", marginUsed: "200", unrealizedPnl: "0" };
        controller.abort();
        return { equity: "", available: "850", marginUsed: "200", unrealizedPnl: "0" };
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(events.filter((e) => e.type === "balance_update")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-finite balance values for test/));
    warn.mockRestore();
  });

  it("suppresses balance_update when previous balance was non-finite (recovery cycle should not re-emit)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getBalance: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum === 1) return { equity: "NaN", available: "800.00", marginUsed: "200", unrealizedPnl: "0" };
        controller.abort();
        return { equity: "1050.50", available: "850", marginUsed: "200", unrealizedPnl: "50" };
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(events.filter((e) => e.type === "balance_update")).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("startEventStream — error handling", () => {
  it("emits error event when adapter throws", async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let callNum = 0;

    const adapter = mockAdapter({
      getPositions: vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum >= 2) controller.abort();
        throw new Error("API unreachable");
      }),
    });

    await startEventStream(adapter, {
      intervalMs: 1,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    const errors = events.filter(e => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].data.message).toContain("API unreachable");
  });
});
