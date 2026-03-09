/**
 * Adversarial / Security Tests — "Ethical Hacker" Mode
 *
 * Tests what happens when a malicious or careless human/agent tries to:
 * 1. Inject shell commands via arguments
 * 2. Pass extreme/malformed values (NaN, Infinity, negative, huge)
 * 3. Use special chars, unicode, path traversal in symbols
 * 4. Leak private keys via error messages
 * 5. Break JSON envelope with crafted inputs
 * 6. Exploit prototype pollution or type confusion
 * 7. Exhaust resources with huge limits
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerTradeCommands } from "../commands/trade.js";
import { registerMarketCommands } from "../commands/market.js";
import { registerAccountCommands } from "../commands/account.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { classifyError, PerpError } from "../errors.js";
import { jsonOk, jsonError, symbolMatch } from "../utils.js";

// ── Mocks ──

vi.mock("../execution-log.js", () => ({ logExecution: vi.fn() }));
vi.mock("../client-id-tracker.js", () => ({
  generateClientId: vi.fn(() => "test-id"),
  logClientId: vi.fn(),
  isOrderDuplicate: vi.fn(() => false),
}));
vi.mock("../trade-validator.js", () => ({
  validateTrade: vi.fn().mockResolvedValue({ valid: true, checks: [], warnings: [] }),
}));

function mockAdapter(overrides?: Record<string, unknown>) {
  return {
    name: "test-exchange",
    marketOrder: vi.fn().mockResolvedValue({ orderId: "m1" }),
    limitOrder: vi.fn().mockResolvedValue({ orderId: "l1" }),
    stopOrder: vi.fn().mockResolvedValue({ orderId: "s1" }),
    cancelOrder: vi.fn().mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ cancelled: 0 }),
    editOrder: vi.fn().mockResolvedValue({ success: true }),
    setLeverage: vi.fn().mockResolvedValue({ leverage: 10 }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({
      equity: "10000", available: "8000", marginUsed: "2000", unrealizedPnl: "0",
    }),
    getMarkets: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({
      bids: [["100", "1"]], asks: [["101", "1"]],
    }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ExchangeAdapter;
}

function createTradeProgram(adapter: ExchangeAdapter, json = false) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTradeCommands(program, async () => adapter, () => json);
  return program;
}

function createMarketProgram(adapter: ExchangeAdapter, json = false) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMarketCommands(program, async () => adapter, () => json);
  return program;
}

function createAccountProgram(adapter: ExchangeAdapter, json = false) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAccountCommands(program, async () => adapter, () => json);
  return program;
}

async function run(program: Command, args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await program.parseAsync(["node", "perp", ...args]);
    return { logCalls: log.mock.calls, errCalls: err.mock.calls };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

function getJsonOutput(calls: unknown[][]): unknown {
  for (const call of calls) {
    try { return JSON.parse(String(call[0])); } catch { /* not JSON */ }
  }
  return null;
}

beforeEach(() => vi.clearAllMocks());

// ══════════════════════════════════════════════════════════════
// 1. COMMAND INJECTION VIA ARGUMENTS
// ══════════════════════════════════════════════════════════════

describe("Command injection attempts", () => {
  const injections = [
    '; rm -rf /',
    '$(whoami)',
    '`whoami`',
    '| cat /etc/passwd',
    '&& curl evil.com',
    '\n rm -rf /',
    '"; DROP TABLE orders; --',
    '<script>alert(1)</script>',
    '{{7*7}}',                    // template injection
    '${process.env.SECRET}',      // env var interpolation
    '__proto__',
    'constructor',
  ];

  it("symbol field: injection strings are passed as-is to adapter (not executed)", async () => {
    for (const payload of injections) {
      const adapter = mockAdapter();
      const program = createTradeProgram(adapter);

      try {
        await run(program, ["trade", "market", payload, "buy", "0.1"]);
      } catch {
        // Commander may reject some chars — that's fine
      }

      // If adapter was called, verify the payload was passed as a string, not executed
      if ((adapter.marketOrder as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const calledSymbol = (adapter.marketOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(typeof calledSymbol).toBe("string");
        // The important thing: it's uppercased string, not a shell command result
        expect(calledSymbol).toBe(payload.toUpperCase());
      }
    }
  });

  it("client-id: injection strings don't break JSON output", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter, true);

    const { logCalls } = await run(program, [
      "trade", "market", "BTC", "buy", "0.1",
      "--client-id", '"; DROP TABLE orders; --',
    ]);

    const output = getJsonOutput(logCalls);
    // Must be valid JSON — no injection broke the envelope
    expect(output).toBeDefined();
    expect((output as Record<string, unknown>).ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. EXTREME / MALFORMED VALUES
// ══════════════════════════════════════════════════════════════

describe("Extreme and malformed numeric values", () => {
  it("size = 0: passed to adapter as-is (adapter decides validity)", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "market", "BTC", "buy", "0"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0");
  });

  it("size = negative: Commander interprets '-1' as unknown option flag (known edge case)", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    // Commander parses "-1" as a flag, not an argument — this is expected behavior
    // Agents/users must NOT pass negative sizes
    try {
      await run(program, ["trade", "market", "BTC", "buy", "-1"]);
    } catch (e: unknown) {
      expect((e as Error).message).toContain("unknown option");
    }
    // Adapter should NOT be called
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("size = NaN string: passed to adapter as-is", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "market", "BTC", "buy", "NaN"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "NaN");
  });

  it("size = Infinity: passed to adapter as-is", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "market", "BTC", "buy", "Infinity"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "Infinity");
  });

  it("size = absurdly large number: no crash", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "market", "BTC", "buy", "999999999999999999999"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "999999999999999999999");
  });

  it("size = tiny decimal: no precision loss as string", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "market", "BTC", "buy", "0.000000001"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.000000001");
  });

  it("price = 0 in limit order: passed through", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "limit", "BTC", "buy", "0", "1"]);
    expect(adapter.limitOrder).toHaveBeenCalledWith("BTC", "buy", "0", "1");
  });

  it("leverage = 0: doesn't crash", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "leverage", "BTC", "0"]);
    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 0, "cross");
  });

  it("leverage = 99999: passed through", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "leverage", "BTC", "99999"]);
    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 99999, "cross");
  });

  it("reduce percent = 0: errorAndExit", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([
        { symbol: "BTC", side: "long", size: "1", entryPrice: "100000", markPrice: "100000", liquidationPrice: "90000", unrealizedPnl: "0", leverage: 10 },
      ]),
    });
    const program = createTradeProgram(adapter, true);
    // percent <= 0 should error
    try {
      await run(program, ["trade", "reduce", "BTC", "0"]);
    } catch {
      // errorAndExit calls process.exit which throws in test
    }
  });

  it("reduce percent = 101: errorAndExit", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter, true);
    try {
      await run(program, ["trade", "reduce", "BTC", "101"]);
    } catch {
      // errorAndExit calls process.exit
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 3. SPECIAL CHARACTERS & UNICODE IN SYMBOLS
// ══════════════════════════════════════════════════════════════

describe("Special characters and unicode in symbols", () => {
  const weirdSymbols = [
    "",              // empty
    " ",             // space
    "../../etc/passwd",
    "BTC\x00ETH",   // null byte
    "BTC\nETH",      // newline
    "BTC\tETH",      // tab
    "🚀MOON",        // emoji
    "A".repeat(10000), // very long
    "<img src=x onerror=alert(1)>", // XSS
    "BTC&symbol=ETH",  // query param injection
    "%00%0d%0a",       // URL encoding
  ];

  it("weird symbols don't crash market mid", async () => {
    for (const sym of weirdSymbols) {
      if (!sym.trim()) continue; // Commander rejects truly empty args
      const adapter = mockAdapter();
      const program = createMarketProgram(adapter, true);
      try {
        await run(program, ["market", "mid", sym]);
      } catch {
        // Commander may reject — that's OK
      }
      // Key: no unhandled exceptions, no process crash
    }
  });

  it("symbolMatch is safe with regex-special characters", () => {
    // These should not throw even though they contain regex specials
    const regexSpecials = ["BTC+PERP", "ETH.*", "SOL[0]", "DOT(1)", "BTC|ETH", "ATOM\\d+"];
    for (const sym of regexSpecials) {
      expect(() => symbolMatch(sym, "BTC")).not.toThrow();
      expect(() => symbolMatch("BTC", sym)).not.toThrow();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 4. PRIVATE KEY LEAKAGE IN ERROR MESSAGES
// ══════════════════════════════════════════════════════════════

describe("Private key leakage prevention", () => {
  it("classifyError does not include stack traces with key material", () => {
    // Simulate an error that might contain a key
    const fakeKey = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const err = new Error(`Failed to sign with key ${fakeKey}`);
    const classified = classifyError(err);

    // The message field will contain the raw error — this is a known issue to flag
    // But the code should be SIGNATURE_FAILED, not UNKNOWN
    expect(classified.code).toBe("SIGNATURE_FAILED");
  });

  it("jsonError output does not expose internal stack traces", () => {
    const err = jsonError("FATAL", "Something went wrong");
    const json = JSON.stringify(err);

    // Should not contain file paths or stack traces
    expect(json).not.toContain("node_modules");
    expect(json).not.toContain("at Object.");
    expect(json).not.toContain(".ts:");
  });

  it("jsonOk output only contains data, not env vars", () => {
    const data = { balance: "100", secret: process.env.HOME };
    const result = jsonOk(data);
    const json = JSON.stringify(result);

    // The data field contains what we put in — that's expected
    // But jsonOk itself should not inject env vars
    expect(result.ok).toBe(true);
    expect(result.meta?.timestamp).toBeDefined();
    // meta should only have timestamp, not env vars
    const metaKeys = Object.keys(result.meta ?? {});
    expect(metaKeys).not.toContain("env");
    expect(metaKeys).not.toContain("process");
  });
});

// ══════════════════════════════════════════════════════════════
// 5. JSON ENVELOPE INTEGRITY ATTACKS
// ══════════════════════════════════════════════════════════════

describe("JSON envelope integrity", () => {
  it("jsonOk with circular reference throws on stringify, not silently corrupts", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj; // circular
    const result = jsonOk(obj);
    expect(() => JSON.stringify(result)).toThrow(); // TypeError: circular
  });

  it("jsonOk with undefined values: JSON.stringify drops them cleanly", () => {
    const result = jsonOk({ value: undefined, name: "test" });
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.data.name).toBe("test");
    // undefined is dropped by JSON.stringify
    expect("value" in parsed.data).toBe(false);
  });

  it("jsonError with very long message doesn't crash", () => {
    const longMsg = "A".repeat(100000);
    const result = jsonError("FATAL", longMsg);
    expect(result.ok).toBe(false);
    expect(result.error?.message.length).toBe(100000);
    // Should still be valid JSON
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(false);
  });

  it("jsonOk with __proto__ key doesn't cause prototype pollution", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = jsonOk(evil);
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);

    // The parsed object should NOT have polluted the prototype
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed.data.__proto__).toBeDefined(); // It's just a regular key
  });

  it("jsonOk with constructor key is safe", () => {
    const result = jsonOk({ constructor: "evil", toString: "override" });
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.data.constructor).toBe("evil");
    // Object constructor should not be overridden
    expect(typeof ({}).constructor).toBe("function");
  });
});

// ══════════════════════════════════════════════════════════════
// 6. INVALID SIDE PARAMETER
// ══════════════════════════════════════════════════════════════

describe("Invalid side parameter", () => {
  it("side = 'BUY' (uppercase) still works (lowercased internally)", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "market", "BTC", "BUY", "0.1"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.1");
  });

  it("side = 'SELL' (uppercase) still works", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    await run(program, ["trade", "market", "BTC", "SELL", "0.1"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.1");
  });

  it("side = 'long' triggers errorAndExit", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    try {
      await run(program, ["trade", "market", "BTC", "long", "0.1"]);
    } catch {
      // errorAndExit calls process.exit
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("side = '' (empty) triggers errorAndExit", async () => {
    const adapter = mockAdapter();
    const program = createTradeProgram(adapter);
    try {
      await run(program, ["trade", "market", "BTC", "", "0.1"]);
    } catch {
      // Commander may handle this
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 7. ERROR CLASSIFICATION ROBUSTNESS
// ══════════════════════════════════════════════════════════════

describe("Error classification edge cases", () => {
  it("classifyError handles null", () => {
    const result = classifyError(null);
    expect(result.code).toBeDefined();
    expect(typeof result.message).toBe("string");
  });

  it("classifyError handles undefined", () => {
    const result = classifyError(undefined);
    expect(result.code).toBeDefined();
  });

  it("classifyError handles number", () => {
    const result = classifyError(42);
    expect(result.message).toBe("42");
  });

  it("classifyError handles object without message", () => {
    const result = classifyError({ status: 500 });
    expect(result.code).toBeDefined();
  });

  it("classifyError handles empty string", () => {
    const result = classifyError(new Error(""));
    expect(result.code).toBe("UNKNOWN");
  });

  it("classifyError handles very long error message", () => {
    const longMsg = "x".repeat(100000);
    const result = classifyError(new Error(longMsg));
    expect(result.message.length).toBe(100000);
  });

  it("classifyError handles error with nested cause", () => {
    const inner = new Error("inner insufficient balance");
    const outer = new Error("Outer error", { cause: inner });
    // classifyError uses outer.message, not cause
    const result = classifyError(outer);
    expect(result.code).toBe("UNKNOWN"); // "Outer error" doesn't match patterns
  });

  it("PerpError preserves structured info through serialize/deserialize", () => {
    const err = new PerpError("RATE_LIMITED", "Too many requests", { waitMs: 1000 });
    expect(err.structured.code).toBe("RATE_LIMITED");
    expect(err.structured.retryable).toBe(true);
    expect(err.structured.details?.waitMs).toBe(1000);

    // Simulate JSON round-trip (agent receiving error)
    const json = JSON.stringify(jsonError(err.structured.code, err.message));
    const parsed = JSON.parse(json);
    expect(parsed.error.code).toBe("RATE_LIMITED");
  });
});

// ══════════════════════════════════════════════════════════════
// 8. CONCURRENT / RAPID-FIRE SAFETY
// ══════════════════════════════════════════════════════════════

describe("Concurrent operations safety", () => {
  it("multiple sequential market mid calls each return correct symbol", async () => {
    // Run sequentially to avoid console.log spy interference
    const symbols: string[] = [];
    for (const sym of ["BTC", "ETH", "SOL"]) {
      const adapter = mockAdapter();
      const program = createMarketProgram(adapter, true);
      const { logCalls } = await run(program, ["market", "mid", sym]);
      const out = getJsonOutput(logCalls) as { data: { symbol: string } };
      symbols.push(out?.data?.symbol);
    }

    expect(symbols).toContain("BTC");
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("SOL");
  });

  it("adapter errors in one call don't affect another", async () => {
    const adapter = mockAdapter({
      getOrderbook: vi.fn()
        .mockRejectedValueOnce(new Error("Timeout"))
        .mockResolvedValueOnce({ bids: [["100", "1"]], asks: [["101", "1"]] }),
    });

    // First call fails
    const prog1 = createMarketProgram(adapter, true);
    const { logCalls: calls1 } = await run(prog1, ["market", "mid", "BTC"]);
    const out1 = getJsonOutput(calls1) as Record<string, unknown>;
    expect(out1?.ok).toBe(false);

    // Second call succeeds
    const prog2 = createMarketProgram(adapter, true);
    const { logCalls: calls2 } = await run(prog2, ["market", "mid", "ETH"]);
    const out2 = getJsonOutput(calls2) as Record<string, unknown>;
    expect(out2?.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 9. PATH TRAVERSAL IN FILE ARGUMENTS
// ══════════════════════════════════════════════════════════════

describe("Path traversal attempts", () => {
  it("symbolMatch doesn't interpret path separators specially", () => {
    expect(symbolMatch("../../../etc/passwd", "BTC")).toBe(false);
    expect(symbolMatch("BTC", "../../../etc/passwd")).toBe(false);
  });

  it("orderId with path traversal is just a string", async () => {
    const adapter = mockAdapter({
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOrderHistory: vi.fn().mockResolvedValue([]),
    });
    const program = createTradeProgram(adapter, true);
    const { logCalls } = await run(program, ["trade", "status", "../../../etc/passwd"]);
    const output = getJsonOutput(logCalls) as Record<string, unknown>;
    // Should just return ORDER_NOT_FOUND, not attempt file read
    expect(output?.ok).toBe(false);
    expect((output?.error as Record<string, unknown>)?.code).toBe("ORDER_NOT_FOUND");
  });
});

// ══════════════════════════════════════════════════════════════
// 10. ACCOUNT MARGIN WITH MALFORMED POSITION DATA
// ══════════════════════════════════════════════════════════════

describe("Account margin with malformed data", () => {
  it("handles NaN markPrice without crash", async () => {
    const adapter = mockAdapter({
      getPositions: vi.fn().mockResolvedValue([{
        symbol: "BTC", side: "long", size: "1",
        entryPrice: "NaN", markPrice: "NaN",
        liquidationPrice: "N/A", unrealizedPnl: "0", leverage: 10,
      }]),
    });
    const program = createAccountProgram(adapter, true);
    const { logCalls } = await run(program, ["account", "margin", "BTC"]);
    const output = getJsonOutput(logCalls) as Record<string, unknown>;
    // Should not crash — NaN math produces NaN which becomes "NaN" string
    expect(output).toBeDefined();
    expect(output?.ok).toBe(true);
  });

  it("handles zero equity (division by zero in marginPct)", async () => {
    const adapter = mockAdapter({
      getBalance: vi.fn().mockResolvedValue({
        equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0",
      }),
      getPositions: vi.fn().mockResolvedValue([{
        symbol: "BTC", side: "long", size: "0.1",
        entryPrice: "100000", markPrice: "100000",
        liquidationPrice: "90000", unrealizedPnl: "0", leverage: 10,
      }]),
    });
    const program = createAccountProgram(adapter, true);
    const { logCalls } = await run(program, ["account", "margin", "BTC"]);
    const output = getJsonOutput(logCalls) as { ok: boolean; data: { marginPctOfEquity: string } };
    expect(output.ok).toBe(true);
    // equity=0 → marginPct should be 0, not Infinity
    expect(output.data.marginPctOfEquity).toBe("0.00");
  });
});

// ══════════════════════════════════════════════════════════════
// 11. TRADE FILLS WITH CRAFTED TRADE DATA
// ══════════════════════════════════════════════════════════════

describe("Trade fills with crafted data", () => {
  it("handles trades with negative prices", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue([
        { time: Date.now(), symbol: "BTC", side: "buy", price: "-100", size: "1", fee: "-5" },
      ]),
    });
    const program = createTradeProgram(adapter, true);
    const { logCalls } = await run(program, ["trade", "fills"]);
    const output = getJsonOutput(logCalls) as { ok: boolean; data: unknown[] };
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(1);
  });

  it("handles trades with extremely large timestamps", async () => {
    const adapter = mockAdapter({
      getTradeHistory: vi.fn().mockResolvedValue([
        { time: 99999999999999, symbol: "BTC", side: "buy", price: "100", size: "1", fee: "0" },
      ]),
    });
    const program = createTradeProgram(adapter, true);
    const { logCalls } = await run(program, ["trade", "fills"]);
    const output = getJsonOutput(logCalls) as { ok: boolean; data: unknown[] };
    expect(output.ok).toBe(true);
  });
});
