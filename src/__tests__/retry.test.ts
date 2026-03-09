import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  withRetrySimple,
  wrapAdapterWithRetry,
  applyJitter,
  computeDelay,
  RetriesExhaustedError,
  type RetryOptions,
} from "../retry.js";
import type { StructuredError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

// ── Helpers ──

/** Create an error whose message triggers classification as the given code */
function rateLimitError() {
  return new Error("429 Too Many Requests");
}
function networkError() {
  return new Error("fetch failed");
}
function timeoutError() {
  return new Error("Request timed out");
}
function insufficientBalanceError() {
  return new Error("Insufficient balance for order");
}

// Speed up tests by using tiny delays
const FAST_OPTS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
  backoffMultiplier: 2,
};

describe("withRetry", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor = 0.8 + 0.5*0.4 = 1.0
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result on first successful attempt (no retry)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, FAST_OPTS);

    expect(result.data).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(result.totalDelayMs).toBe(0);
    expect(result.retries).toHaveLength(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error (rate limit) and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, FAST_OPTS);

    expect(result.data).toBe("recovered");
    expect(result.attempts).toBe(3);
    expect(result.retries).toHaveLength(2);
    expect(result.retries[0].error.code).toBe("RATE_LIMITED");
    expect(result.retries[1].error.code).toBe("EXCHANGE_UNREACHABLE");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on non-retryable error (insufficient balance)", async () => {
    const fn = vi.fn().mockRejectedValue(insufficientBalanceError());

    await expect(withRetry(fn, FAST_OPTS)).rejects.toThrow("Insufficient balance");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws RetriesExhaustedError when max retries exceeded", async () => {
    const fn = vi.fn().mockRejectedValue(rateLimitError());

    try {
      await withRetry(fn, { ...FAST_OPTS, maxRetries: 2 });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RetriesExhaustedError);
      const rex = err as RetriesExhaustedError;
      expect(rex.attempts).toBe(3); // 1 initial + 2 retries
      expect(rex.lastError.code).toBe("RATE_LIMITED");
      expect(rex.retries).toHaveLength(2);
    }

    // initial attempt + 2 retries + 1 final attempt = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff timing", async () => {
    // With Math.random() = 0.5, jitter factor = 1.0 (no change)
    const fn = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue("ok");

    const opts: RetryOptions = {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
    };

    const result = await withRetry(fn, opts);

    // Attempt 1 fail: delay = 100 * 2^0 = 100
    // Attempt 2 fail: delay = 100 * 2^1 = 200
    // Attempt 3 fail: delay = 100 * 2^2 = 400
    expect(result.retries[0].delayMs).toBe(100);
    expect(result.retries[1].delayMs).toBe(200);
    expect(result.retries[2].delayMs).toBe(400);
    expect(result.totalDelayMs).toBe(700);
  });

  it("respects retryAfterMs from error code (rate limit = 1000ms)", async () => {
    // Rate limit has retryAfterMs: 1000
    // With baseDelayMs=1 and multiplier=2, backoff would be tiny,
    // but retryAfterMs: 1000 should override
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValue("ok");

    const opts: RetryOptions = {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    };

    const result = await withRetry(fn, opts);

    // retryAfterMs=1000 is larger than baseDelay*multiplier^0=1, so 1000 is used
    expect(result.retries[0].delayMs).toBe(1000);
  });

  it("caps delay at maxDelayMs", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue("ok");

    const opts: RetryOptions = {
      maxRetries: 3,
      baseDelayMs: 50000, // Very large base
      maxDelayMs: 100,
      backoffMultiplier: 2,
    };

    const result = await withRetry(fn, opts);

    // 50000 would be the computed delay, but capped to 100
    expect(result.retries[0].delayMs).toBe(100);
  });

  it("calls onRetry callback on each retry", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValue("ok");

    await withRetry(fn, { ...FAST_OPTS, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(2);

    // First call: attempt 1, rate limit error
    expect(onRetry.mock.calls[0][0]).toBe(1); // attempt
    expect(onRetry.mock.calls[0][1].code).toBe("RATE_LIMITED");
    expect(typeof onRetry.mock.calls[0][2]).toBe("number"); // delayMs

    // Second call: attempt 2, timeout error
    expect(onRetry.mock.calls[1][0]).toBe(2);
    expect(onRetry.mock.calls[1][1].code).toBe("TIMEOUT");
  });

  it("uses default options when none provided", async () => {
    // Just verify it runs with defaults (maxRetries=3, baseDelay=1000, etc.)
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn);
    expect(result.data).toBe(42);
    expect(result.attempts).toBe(1);
  });
});

describe("applyJitter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies jitter within +/-20% range", () => {
    // Test minimum jitter (random=0 -> factor=0.8)
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(applyJitter(1000)).toBe(800);

    // Test maximum jitter (random=1 -> factor=1.2)
    vi.mocked(Math.random).mockReturnValue(1);
    expect(applyJitter(1000)).toBe(1200);

    // Test midpoint (random=0.5 -> factor=1.0)
    vi.mocked(Math.random).mockReturnValue(0.5);
    expect(applyJitter(1000)).toBe(1000);
  });

  it("rounds to integer", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.3); // factor = 0.92
    expect(applyJitter(100)).toBe(92);
    expect(Number.isInteger(applyJitter(100))).toBe(true);
  });
});

describe("computeDelay", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor = 1.0
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const defaultOpts = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
  };

  it("computes exponential backoff", () => {
    const error: StructuredError = { code: "TIMEOUT", message: "timed out", status: 504, retryable: true };

    expect(computeDelay(1, error, defaultOpts)).toBe(1000);  // 1000 * 2^0
    expect(computeDelay(2, error, defaultOpts)).toBe(2000);  // 1000 * 2^1
    expect(computeDelay(3, error, defaultOpts)).toBe(4000);  // 1000 * 2^2
  });

  it("uses retryAfterMs when larger than backoff", () => {
    const error: StructuredError = {
      code: "RATE_LIMITED", message: "429", status: 429, retryable: true, retryAfterMs: 5000,
    };

    // Attempt 1: backoff = 1000, retryAfterMs = 5000 -> 5000
    expect(computeDelay(1, error, defaultOpts)).toBe(5000);
    // Attempt 3: backoff = 4000, retryAfterMs = 5000 -> 5000
    expect(computeDelay(3, error, defaultOpts)).toBe(5000);
    // Attempt 4: backoff = 8000, retryAfterMs = 5000 -> 8000
    expect(computeDelay(4, error, defaultOpts)).toBe(8000);
  });

  it("caps at maxDelayMs", () => {
    const error: StructuredError = { code: "TIMEOUT", message: "timed out", status: 504, retryable: true };
    const opts = { ...defaultOpts, maxDelayMs: 3000 };

    expect(computeDelay(3, error, opts)).toBe(3000); // 4000 capped to 3000
  });
});

describe("withRetrySimple", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns data directly without metadata", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValue({ price: "100.00" });

    const data = await withRetrySimple(fn, 3);

    expect(data).toEqual({ price: "100.00" });
  });

  it("throws on non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(insufficientBalanceError());
    await expect(withRetrySimple(fn)).rejects.toThrow("Insufficient balance");
  });

  it("uses default maxRetries when not specified", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetrySimple(fn);
    expect(result).toBe("ok");
  });
});

describe("wrapAdapterWithRetry", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockAdapter(overrides?: Partial<ExchangeAdapter>): ExchangeAdapter {
    return {
      name: "mock-exchange",
      getMarkets: vi.fn().mockResolvedValue([]),
      getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
      getRecentTrades: vi.fn().mockResolvedValue([]),
      getFundingHistory: vi.fn().mockResolvedValue([]),
      getKlines: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue({ equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0" }),
      getPositions: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOrderHistory: vi.fn().mockResolvedValue([]),
      getTradeHistory: vi.fn().mockResolvedValue([]),
      getFundingPayments: vi.fn().mockResolvedValue([]),
      marketOrder: vi.fn().mockResolvedValue({ orderId: "123" }),
      limitOrder: vi.fn().mockResolvedValue({ orderId: "456" }),
      editOrder: vi.fn().mockResolvedValue({}),
      cancelOrder: vi.fn().mockResolvedValue({}),
      cancelAllOrders: vi.fn().mockResolvedValue({}),
      setLeverage: vi.fn().mockResolvedValue({}),
      stopOrder: vi.fn().mockResolvedValue({}),
      ...overrides,
    };
  }

  it("passes through the name property without wrapping", () => {
    const adapter = createMockAdapter();
    const wrapped = wrapAdapterWithRetry(adapter, FAST_OPTS);

    expect(wrapped.name).toBe("mock-exchange");
  });

  it("proxies async method calls through to the original adapter", async () => {
    const mockMarkets = [{ symbol: "BTC-PERP", markPrice: "50000" }];
    const adapter = createMockAdapter({
      getMarkets: vi.fn().mockResolvedValue(mockMarkets),
    });

    const wrapped = wrapAdapterWithRetry(adapter, FAST_OPTS);
    const result = await wrapped.getMarkets();

    expect(result).toEqual(mockMarkets);
    expect(adapter.getMarkets).toHaveBeenCalledTimes(1);
  });

  it("retries async methods on retryable errors", async () => {
    const getBalance = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValue({ equity: "1000", available: "500", marginUsed: "500", unrealizedPnl: "50" });

    const adapter = createMockAdapter({ getBalance });
    const wrapped = wrapAdapterWithRetry(adapter, FAST_OPTS);

    const result = await wrapped.getBalance();

    expect(result).toEqual({ equity: "1000", available: "500", marginUsed: "500", unrealizedPnl: "50" });
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it("passes arguments through to the wrapped method", async () => {
    const marketOrder = vi.fn().mockResolvedValue({ orderId: "abc" });
    const adapter = createMockAdapter({ marketOrder });
    const wrapped = wrapAdapterWithRetry(adapter, FAST_OPTS);

    await wrapped.marketOrder("BTC-PERP", "buy", "0.1");

    expect(marketOrder).toHaveBeenCalledWith("BTC-PERP", "buy", "0.1");
  });

  it("does not retry non-retryable errors from wrapped methods", async () => {
    const marketOrder = vi.fn().mockRejectedValue(insufficientBalanceError());
    const adapter = createMockAdapter({ marketOrder });
    const wrapped = wrapAdapterWithRetry(adapter, FAST_OPTS);

    await expect(wrapped.marketOrder("BTC-PERP", "buy", "999")).rejects.toThrow("Insufficient balance");
    expect(marketOrder).toHaveBeenCalledTimes(1);
  });

  it("respects retry options passed to wrapAdapterWithRetry", async () => {
    const getPositions = vi.fn().mockRejectedValue(timeoutError());
    const adapter = createMockAdapter({ getPositions });

    const wrapped = wrapAdapterWithRetry(adapter, { ...FAST_OPTS, maxRetries: 1 });

    await expect(wrapped.getPositions()).rejects.toBeInstanceOf(RetriesExhaustedError);
    // 1 initial + 1 retry = 2 calls
    expect(getPositions).toHaveBeenCalledTimes(2);
  });
});
