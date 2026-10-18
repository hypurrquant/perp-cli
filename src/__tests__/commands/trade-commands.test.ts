import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerTradeCommands } from "../../commands/trade.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import { PerpError } from "../../errors.js";

// ── Mock dependencies to prevent file I/O ──

vi.mock("../../execution-log.js", () => ({
  logExecution: vi.fn(),
}));

vi.mock("../../client-id-tracker.js", () => ({
  generateClientId: vi.fn(() => "test-id-123"),
  logClientId: vi.fn(),
  isOrderDuplicate: vi.fn(() => false),
}));

// trade scale-tp / scale-in read the venue minimum from the venue's public market list
// (TradingV2.getVenueMarkets → legacy-public for the mock venue): served from here, no network.
const venueMinimums = { minSize: null as string | null, minNotional: null as string | null };
vi.mock("../../funding/legacy-public.js", () => ({
  legacyPublicData: () => ({
    fetchFundingRates: async () => [],
    fetchMarkets: async () => ["BTC", "ETH"].map(symbol => ({ symbol, ...venueMinimums })),
  }),
}));

vi.mock("../../trade-validator.js", () => ({
  // enforceOrderRisk is the manual-order risk gate; stub it to a no-op pass so
  // these command-mapping tests exercise the order path without the risk fetch.
  // The gate itself is covered by enforce-order-risk.test.ts.
  enforceOrderRisk: vi.fn().mockResolvedValue(undefined),
  validateTrade: vi.fn().mockResolvedValue({
    valid: true,
    checks: [],
    warnings: [],
    timestamp: new Date().toISOString(),
  }),
}));

// Quarantine writes ~/.perp/bot-quarantine.json (isolated HOME in tests); spy on it so the
// unknown-outcome paths can assert the symbol was quarantined.
vi.mock("../../bot/quarantine.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../bot/quarantine.js")>();
  return { ...orig, quarantineSymbol: vi.fn(orig.quarantineSymbol) };
});

// Import mocked modules so we can control their behavior per-test
import { generateClientId, logClientId, isOrderDuplicate } from "../../client-id-tracker.js";
import { logExecution } from "../../execution-log.js";
import { QUARANTINE_FILE, quarantineSymbol } from "../../bot/quarantine.js";
import { rmSync } from "node:fs";

// ── Mock adapter factory ──
//
// The mock is registered under a REAL venue id ("hyperliquid"): every trade command
// resolves the venue definition (capabilities, slippage bound) from adapter.name, and an
// unregistered name is UNKNOWN_VENUE. Hyperliquid = legacy TradingV2 wrapper, native amend,
// client order ids = 128-bit hex cloids, per-order cancel proof via statuses[0] === "success".
//
// Positions and open orders are STATEFUL: trade close / close-all / flatten / reduce verify
// every close as a measured position delta (closePerpVerified, / CHANGELOG
// "trade close / close-all / flatten / reduce use closePerpVerified"), and cancel-all /
// flatten re-list open orders after cancelling (cancelAllV2). A static getPositions would
// make every close ORDER_PENDING (quarantine), which is exactly what must not pass silently.

const VENUE = "hyperliquid";
/** Default slippage bound resolved for every market-type order (settings.defaultSlippageBps, isolated HOME). */
const DEFAULT_SLIPPAGE = { bps: 50, source: "default" };
const MARKET_SYMBOLS = ["BTC", "ETH", "SOL", "DOGE", "ARB", "MATIC", "AVAX", "LINK", "NEAR", "APT", "OP"];

function market(symbol: string) {
  return {
    symbol, markPrice: "100", indexPrice: "100", fundingRate: "0.0001", volume24h: "1000000", openInterest: "500000",
    maxLeverage: 20, sizeDecimals: 4, stepSize: "0.0001", fundingHours: 1, marginTiers: null,
  };
}

type Pos = { symbol: string; side: "long" | "short"; size: string; entryPrice: string; markPrice: string; liquidationPrice: string | null; unrealizedPnl: string; leverage: number };
type Ord = { orderId: string; symbol: string; side: "buy" | "sell"; price: string; size: string; filled: string; status: string; type: string };

/** HL-shaped IOC fill ack (statuses[0].filled). */
function hlFilled(size: string) {
  return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: size, avgPx: "100", oid: 1 } }] } } };
}

/**
 * Venue state shared by getPositions / marketOrder / getOpenOrders / cancelOrder.
 * A market order moves the position like the venue would (reduce on the opposite side,
 * open/increase otherwise); `onOrder` lets a test record call order.
 */
function liveVenue(initialPositions: Pos[] = [], initialOrders: Ord[] = [], onOrder?: (symbol: string) => void) {
  let positions: Pos[] = initialPositions.map(p => ({ ...p }));
  let orders: Ord[] = initialOrders.map(o => ({ ...o }));
  const applyFill = (symbol: string, side: "buy" | "sell", size: string) => {
    const qty = Number(size);
    const p = positions.find(x => x.symbol === symbol);
    const signed = (p ? (p.side === "long" ? 1 : -1) * Number(p.size) : 0) + (side === "buy" ? qty : -qty);
    positions = positions.filter(x => x.symbol !== symbol);
    if (Math.abs(signed) > 1e-12) {
      positions.push({ ...(p ?? { symbol, entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }),
        symbol, side: signed > 0 ? "long" : "short", size: String(Number(Math.abs(signed).toFixed(10))) });
    }
  };
  return {
    getPositions: vi.fn(async () => positions.map(p => ({ ...p }))),
    getOpenOrders: vi.fn(async () => orders.map(o => ({ ...o }))),
    marketOrder: vi.fn(async (symbol: string, side: "buy" | "sell", size: string) => {
      onOrder?.(`marketOrder:${symbol}`);
      applyFill(symbol, side, size);
      return hlFilled(size);
    }),
    cancelOrder: vi.fn(async (_symbol: string, orderId: string) => {
      onOrder?.(`cancelOrder:${orderId}`);
      orders = orders.filter(o => o.orderId !== orderId);
      return { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } };
    }),
  };
}

function openOrder(orderId: string, symbol: string): Ord {
  return { orderId, symbol, side: "buy", price: "90", size: "1", filled: "0", status: "open", type: "limit" };
}

function mockAdapter(overrides?: Record<string, unknown>) {
  return {
    name: VENUE,
    ...liveVenue(),
    limitOrder: vi.fn().mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 11 } }] } } }),
    stopOrder: vi.fn().mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } }),
    cancelAllOrders: vi.fn().mockResolvedValue({ cancelled: 3 }),
    editOrder: vi.fn().mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 12 } }] } } }),
    setLeverage: vi.fn().mockResolvedValue({ leverage: 10 }),
    getBalance: vi.fn().mockResolvedValue({
      equity: "1000",
      available: "800",
      marginUsed: "200",
      unrealizedPnl: "0",
    }),
    getMarkets: vi.fn().mockResolvedValue(MARKET_SYMBOLS.map(market)),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getTradeHistory: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ExchangeAdapter;
}

/** Expected 4th marketOrder argument: every market order states reduceOnly + the resolved slippage. */
const entryOpts = { reduceOnly: false, slippage: DEFAULT_SLIPPAGE };
const closeOpts = { reduceOnly: true, slippage: DEFAULT_SLIPPAGE };

// ── Helper: create a program, register commands, and parse ──

function createProgram(adapter: ExchangeAdapter) {
  const program = new Command();
  addRootSafetyOptions(program);
  program.exitOverride(); // Prevent process.exit on parse errors
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerTradeCommands(
    program,
    async () => adapter,
    () => false, // isJson = false
  );
  return program;
}

async function run(adapter: ExchangeAdapter, args: string[]) {
  const program = createProgram(adapter);
  // Suppress console output during tests
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await program.parseAsync(["node", "perp", ...args]);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

// ── Shared setup ──

beforeEach(() => {
  vi.clearAllMocks();
  // Reset isOrderDuplicate to default: not a duplicate
  vi.mocked(isOrderDuplicate).mockReturnValue(false);
  venueMinimums.minSize = null;
  venueMinimums.minNotional = null;
  // An earlier test's unknown-outcome close quarantines BTC; opening orders now refuse a
  // quarantined symbol, so every test starts with an empty quarantine (isolated HOME).
  rmSync(QUARANTINE_FILE, { force: true });
});

// ══════════════════════════════════════════════════════════════
// 1. Market Order -- parameter correctness
// ══════════════════════════════════════════════════════════════

describe("trade market -- parameter correctness", () => {
  it("calls adapter.marketOrder with uppercased symbol, lowercased side, and string size", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.1", entryOpts);
  });

  it("uppercases mixed-case symbol", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "Eth", "sell", "2.5"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "sell", "2.5", entryOpts);
  });

  it("lowercases the side argument", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "sol", "BUY", "5"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("SOL", "buy", "5", entryOpts);
  });

  it("passes size as a string, not a number", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.001"]);

    const args = vi.mocked(adapter.marketOrder).mock.calls[0];
    expect(typeof args[2]).toBe("string");
    expect(args[2]).toBe("0.001");
  });

  it("rejects invalid side (exits with error)", async () => {
    const adapter = mockAdapter();
    // errorAndExit calls process.exit(1), which we can catch via exitOverride or mock
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "market", "btc", "long", "1"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════
// 2. Market Order -- client ID flow
// ══════════════════════════════════════════════════════════════

describe("trade market -- client ID flow", () => {
  // BEHAVIOR CHANGE: the mock venue (hyperliquid) sends no client order id, so --client-id /
  // --auto-id are refused before anything is sent — never accepted and then dropped.
  it("--client-id that is not a Hyperliquid cloid → INVALID_PARAMS, nothing sent or tracked", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "market", "btc", "buy", "0.1", "--client-id", "my-id"]))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(logClientId).not.toHaveBeenCalled();
  });

  it("--client-id <cloid> is sent to the adapter and tracked", async () => {
    const adapter = mockAdapter();
    const cloid = "0x1234567890abcdef1234567890abcdef";
    await run(adapter, ["trade", "market", "btc", "buy", "0.1", "--client-id", cloid]);
    expect(vi.mocked(adapter.marketOrder).mock.calls[0][3]).toMatchObject({ clientOrderId: cloid });
    expect(logClientId).toHaveBeenCalledWith(expect.objectContaining({ clientOrderId: cloid, status: "submitted" }));
  });

  it("--auto-id generates a valid cloid (0x + 32 hex) and sends it", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1", "--auto-id"]);
    const sent = (vi.mocked(adapter.marketOrder).mock.calls[0][3] as { clientOrderId?: string }).clientOrderId;
    expect(sent).toMatch(/^0x[0-9a-f]{32}$/);
    expect(generateClientId).not.toHaveBeenCalled();
  });

  it("--smart with a client id is refused (the smart path sends none)", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "market", "btc", "buy", "0.1", "--smart", "--client-id", "my-id"]))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });

  it("duplicate detection: when isOrderDuplicate returns true, adapter is NOT called", async () => {
    vi.mocked(isOrderDuplicate).mockReturnValue(true);
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1", "--client-id", "dup-id"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    // logClientId should NOT be called for duplicates
    expect(logClientId).not.toHaveBeenCalled();
  });

  it("without --auto-id or --client-id: no client ID tracking", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1"]);

    expect(generateClientId).not.toHaveBeenCalled();
    expect(logClientId).not.toHaveBeenCalled();
    // Adapter still called
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Limit Order -- parameter correctness
// ══════════════════════════════════════════════════════════════

describe("trade limit -- parameter correctness", () => {
  it("calls adapter.limitOrder with uppercased symbol, lowercased side, price, size", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "eth", "sell", "2000", "1.5"]);

    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
    // TradingV2 states reduceOnly + the default TIF (GTC) on every limit order.
    expect(adapter.limitOrder).toHaveBeenCalledWith("ETH", "sell", "2000", "1.5", { reduceOnly: false, tif: "GTC" });
  });

  it("all four args are strings", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "65000", "0.05"]);

    const args = vi.mocked(adapter.limitOrder).mock.calls[0];
    expect(typeof args[0]).toBe("string"); // symbol
    expect(typeof args[1]).toBe("string"); // side
    expect(typeof args[2]).toBe("string"); // price
    expect(typeof args[3]).toBe("string"); // size
  });

  it("--auto-id on hyperliquid sends a generated cloid with the limit order", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "60000", "0.1", "--auto-id"]);
    const opts = vi.mocked(adapter.limitOrder).mock.calls[0][4] as { clientOrderId?: string };
    expect(opts.clientOrderId).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it("duplicate detection prevents execution for limit orders too", async () => {
    vi.mocked(isOrderDuplicate).mockReturnValue(true);
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "60000", "0.1", "--client-id", "dup"]);

    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Stop Order -- parameter correctness
// ══════════════════════════════════════════════════════════════

describe("trade stop -- parameter correctness", () => {
  // CHANGELOG: "trade stop is reduce-only by default on every venue (protective by default);
  // --no-reduce-only lets a stop open / flip a position (--reduce-only flag removed)".
  it("stop-limit: passes limitPrice and is reduce-only by default", async () => {
    const adapter = mockAdapter();
    await run(adapter, [
      "trade", "stop", "btc", "sell", "0.1", "60000",
      "--limit-price", "59500",
    ]);

    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "BTC",
      "sell",
      "0.1",
      "60000",
      { limitPrice: "59500", reduceOnly: true },
    );
  });

  it("market trigger: reduce-only by default and carries the resolved slippage bound", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "btc", "sell", "0.1", "60000"]);

    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "BTC",
      "sell",
      "0.1",
      "60000",
      { reduceOnly: true, slippage: DEFAULT_SLIPPAGE },
    );
  });

  it("--no-reduce-only lets the stop open / flip a position", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "btc", "sell", "0.1", "60000", "--no-reduce-only"]);

    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "BTC", "sell", "0.1", "60000",
      { reduceOnly: false, slippage: DEFAULT_SLIPPAGE },
    );
  });

  it("the removed --reduce-only flag is rejected (never silently ignored)", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "stop", "btc", "sell", "0.1", "60000", "--reduce-only"])).rejects.toThrow(/unknown option '--reduce-only'/);
    expect(adapter.stopOrder).not.toHaveBeenCalled();
  });

  it("uppercases symbol for stop orders", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "eth", "buy", "1", "3500"]);

    expect(adapter.stopOrder).toHaveBeenCalledWith(
      "ETH",
      "buy",
      "1",
      "3500",
      { reduceOnly: true, slippage: DEFAULT_SLIPPAGE },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Cancel Order
// ══════════════════════════════════════════════════════════════

describe("trade cancel -- parameter correctness", () => {
  it("calls adapter.cancelOrder with uppercased symbol and orderId", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "btc", "abc123"]);

    expect(adapter.cancelOrder).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("BTC", "abc123");
  });

  it("uppercases mixed-case symbol", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "Sol", "order-456"]);

    expect(adapter.cancelOrder).toHaveBeenCalledWith("SOL", "order-456");
  });

  it("no other adapter methods are called", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "btc", "abc123"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 6. Cancel All Orders
// ══════════════════════════════════════════════════════════════

describe("trade cancel-all", () => {
  // CHANGELOG: "flatten / cancel-all cancel through cancelAllV2" — one per-order cancel for each
  // order listed open (per-order proof), then a live re-list; the venue-wide cancelAllOrders()
  // is no longer used because its result cannot prove which orders were cancelled.
  it("cancels every listed open order by id (never the unverifiable venue-wide cancelAllOrders)", async () => {
    const adapter = mockAdapter(liveVenue([], [openOrder("101", "BTC"), openOrder("102", "ETH")]));
    await run(adapter, ["trade", "cancel-all"]);

    expect(adapter.cancelOrder).toHaveBeenCalledTimes(2);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("BTC", "101");
    expect(adapter.cancelOrder).toHaveBeenCalledWith("ETH", "102");
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
  });

  it("re-lists open orders after cancelling (verification read)", async () => {
    const adapter = mockAdapter(liveVenue([], [openOrder("101", "BTC")]));
    await run(adapter, ["trade", "cancel-all"]);

    expect(adapter.getOpenOrders).toHaveBeenCalledTimes(2);
  });

  it("an order still listed open after its cancel → ORDER_PARTIAL, not reported cancelled", async () => {
    const venue = liveVenue([], [openOrder("101", "BTC")]);
    // The venue acks the cancel but the order stays open.
    venue.cancelOrder.mockImplementation(async () => ({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }));
    const adapter = mockAdapter(venue);
    await expect(run(adapter, ["trade", "cancel-all"])).rejects.toMatchObject({ structured: { code: "ORDER_PARTIAL" } });
    expect(logExecution).toHaveBeenCalledWith(expect.objectContaining({ type: "cancel", status: "unverified" }));
  });

  it("no other adapter methods are called", async () => {
    const adapter = mockAdapter(liveVenue([], [openOrder("101", "BTC")]));
    await run(adapter, ["trade", "cancel-all"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 7. Set Leverage
// ══════════════════════════════════════════════════════════════

describe("trade leverage", () => {
  it("calls adapter.setLeverage with uppercased symbol, parsed int, and 'cross' by default", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "btc", "10"]);

    expect(adapter.setLeverage).toHaveBeenCalledTimes(1);
    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 10, "cross");
  });

  it("with --isolated: passes 'isolated' as margin mode", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "btc", "10", "--isolated"]);

    expect(adapter.setLeverage).toHaveBeenCalledWith("BTC", 10, "isolated");
  });

  it("leverage is parsed as integer", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "eth", "25"]);

    const args = vi.mocked(adapter.setLeverage).mock.calls[0];
    expect(args[1]).toBe(25);
    expect(typeof args[1]).toBe("number");
  });
});

// ══════════════════════════════════════════════════════════════
// 8. Close Position -- side mapping
// ══════════════════════════════════════════════════════════════

describe("trade close -- side mapping", () => {
  it("LONG position -> calls marketOrder with 'sell' (opposite side)", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        {
          symbol: "BTC",
          side: "long",
          size: "0.5",
          entryPrice: "60000",
          markPrice: "61000",
          liquidationPrice: "50000",
          unrealizedPnl: "500",
          leverage: 10,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.5", closeOpts);
  });

  it("SHORT position -> calls marketOrder with 'buy' (opposite side)", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        {
          symbol: "ETH",
          side: "short",
          size: "3.0",
          entryPrice: "3000",
          markPrice: "2900",
          liquidationPrice: "4000",
          unrealizedPnl: "300",
          leverage: 5,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "eth"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "buy", "3.0", closeOpts);
  });

  it("no position -> error, adapter.marketOrder NOT called", async () => {
    const adapter = mockAdapter({
      ...liveVenue([]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "close", "btc"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("uses the full position size to close", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        {
          symbol: "SOL",
          side: "long",
          size: "100",
          entryPrice: "150",
          markPrice: "155",
          liquidationPrice: "120",
          unrealizedPnl: "500",
          leverage: 3,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "sol"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("SOL", "sell", "100", closeOpts);
  });

  it("logs execution after closing", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        {
          symbol: "BTC",
          side: "long",
          size: "0.1",
          entryPrice: "60000",
          markPrice: "61000",
          liquidationPrice: "50000",
          unrealizedPnl: "100",
          leverage: 10,
        },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(logExecution).toHaveBeenCalledTimes(1);
    expect(logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "market_order",
        symbol: "BTC",
        side: "sell",
        size: "0.1",
        meta: expect.objectContaining({ action: "close", originalSide: "long" }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 9. Close All -- iterates all positions
// ══════════════════════════════════════════════════════════════

describe("trade close-all -- iterates all positions", () => {
  it("3 positions (BTC long, ETH short, SOL long) -> 3 marketOrder calls with correct opposite sides", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "0.5", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "500", leverage: 10 },
        { symbol: "ETH", side: "short", size: "5.0", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "500", leverage: 5 },
        { symbol: "SOL", side: "long", size: "100", entryPrice: "150", markPrice: "155", liquidationPrice: "120", unrealizedPnl: "500", leverage: 3 },
      ]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(3);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "sell", "0.5", closeOpts);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "buy", "5.0", closeOpts);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(3, "SOL", "sell", "100", closeOpts);
  });

  it("0 positions -> no marketOrder calls", async () => {
    const adapter = mockAdapter({
      ...liveVenue([]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("logs execution for each closed position", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "0.5", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "500", leverage: 10 },
        { symbol: "ETH", side: "short", size: "2.0", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "200", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(logExecution).toHaveBeenCalledTimes(2);
    expect(logExecution).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        symbol: "BTC",
        side: "sell",
        meta: expect.objectContaining({ action: "close-all", originalSide: "long" }),
      }),
    );
    expect(logExecution).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        symbol: "ETH",
        side: "buy",
        meta: expect.objectContaining({ action: "close-all", originalSide: "short" }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 10. Flatten -- cancel + close
// ══════════════════════════════════════════════════════════════

describe("trade flatten -- cancel + close", () => {
  it("cancels every open order first (per-order), then closes each position reduce-only on the opposite side", async () => {
    const callOrder: string[] = [];
    const adapter = mockAdapter(liveVenue(
      [
        { symbol: "BTC", side: "long", size: "1.0", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 },
        { symbol: "ETH", side: "short", size: "10", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "1000", leverage: 5 },
      ],
      [openOrder("201", "BTC"), openOrder("202", "ETH")],
      (call) => callOrder.push(call),
    ));
    await run(adapter, ["trade", "flatten"]);

    // Verify order: cancel first, then close positions
    expect(callOrder).toEqual(["cancelOrder:201", "cancelOrder:202", "marketOrder:BTC", "marketOrder:ETH"]);

    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
    expect(adapter.marketOrder).toHaveBeenCalledTimes(2);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "sell", "1.0", closeOpts);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "buy", "10", closeOpts);
  });

  it("with no positions and no orders: lists open orders, but sends no cancel and no marketOrder", async () => {
    const adapter = mockAdapter(liveVenue([]));
    await run(adapter, ["trade", "flatten"]);

    expect(adapter.getOpenOrders).toHaveBeenCalled();
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("a close whose position never moves → ORDER_PARTIAL and the symbol is quarantined (never reported closed)", async () => {
    vi.useFakeTimers();
    try {
      const venue = liveVenue([
        { symbol: "BTC", side: "long", size: "1", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 },
      ]);
      // The venue acknowledges the close but the position does not move (outcome unknown).
      venue.marketOrder.mockImplementation(async (_s: string, _side: string, size: string) => hlFilled(size));
      const adapter = mockAdapter(venue);
      const p = run(adapter, ["trade", "flatten"]);
      await vi.runAllTimersAsync();
      await p;
      // withJsonErrors prints the ORDER_PARTIAL and sets a non-zero exit code.
      expect(process.exitCode).toBe(1);
      expect(quarantineSymbol).toHaveBeenCalledWith("trade-close", "BTC", expect.stringContaining("outcome unknown"), expect.any(String), expect.any(Function));
      expect(logExecution).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTC", status: "unverified" }));
      expect(logExecution).not.toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTC", status: "success" }));
    } finally {
      process.exitCode = undefined;
      vi.useRealTimers();
    }
  });

  it("logs execution for each position closed during flatten", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "SOL", side: "long", size: "50", entryPrice: "150", markPrice: "155", liquidationPrice: "120", unrealizedPnl: "250", leverage: 3 },
      ]),
    });
    await run(adapter, ["trade", "flatten"]);

    expect(logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "market_order",
        symbol: "SOL",
        side: "sell",
        size: "50",
        meta: expect.objectContaining({ action: "flatten", originalSide: "long" }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 11. Reduce -- percentage calculation
// ══════════════════════════════════════════════════════════════

describe("trade reduce -- percentage calculation", () => {
  it("BTC long size=10, reduce 50% -> marketOrder('BTC', 'sell', '5')", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "5", closeOpts);
  });

  it("BTC short size=4, reduce 25% -> marketOrder('BTC', 'buy', '1')", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "short", size: "4", entryPrice: "60000", markPrice: "59000", liquidationPrice: "70000", unrealizedPnl: "4000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "25"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "1", closeOpts);
  });

  // QFEX live 2026-10-05: `trade reduce GOLD 50` on 0.003 sent 0.001 — the size was floored to the
  // decimals the position size printed (0.001), not to the market lot (GOLD-USD lot_size 0.0001).
  it("floors to the market lot step, not to the position size's printed decimals (0.003 × 50% → 0.0015)", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "ETH", side: "long", size: "0.003", entryPrice: "3000", markPrice: "3100", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "eth", "50"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "sell", "0.0015", closeOpts);
  });

  it("a coarser lot than the position's decimals floors down to the lot (0.0033 × 50%, lot 0.001 → 0.001)", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "ETH", side: "long", size: "0.0033", entryPrice: "3000", markPrice: "3100", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 },
      ]),
      getMarkets: vi.fn().mockResolvedValue([{ ...market("ETH"), sizeDecimals: 3, stepSize: "0.001" }]),
    });
    await run(adapter, ["trade", "reduce", "eth", "50"]);
    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "sell", "0.001", closeOpts);
  });

  it("unknown lot step → refused before any order (never sized off the printed decimals)", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "ETH", side: "long", size: "0.003", entryPrice: "3000", markPrice: "3100", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 },
      ]),
      getMarkets: vi.fn().mockResolvedValue([{ ...market("ETH"), sizeDecimals: null, stepSize: null }]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "eth", "50"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("reduce 100% -> closes full position", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "ETH", side: "long", size: "5", entryPrice: "3000", markPrice: "3100", liquidationPrice: "2500", unrealizedPnl: "500", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "eth", "100"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("ETH", "sell", "5", closeOpts);
  });

  it("no position -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      ...liveVenue([]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "50"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("invalid percent 0 -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "0"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("invalid percent 101 -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "101"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("invalid percent -1 -> error, no adapter call", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await run(adapter, ["trade", "reduce", "btc", "-1"]);
    } catch {
      // Expected
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("logs execution with reduce metadata", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "10", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "10000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "market_order",
        symbol: "BTC",
        side: "sell",
        size: "5",
        // closeVerified logs the verified close: requested size + action/originalSide
        // (percent/originalSize are reported in the command output, not the execution log).
        meta: expect.objectContaining({ action: "reduce", originalSide: "long", requested: "5" }),
        status: "success",
      }),
    );
  });

  // trade reduce sizes from the position's own size string, floored to the market lot step
  // (100% = the exact position size), never larger than the position.
  it("fractional percentage: reduce 33.3% of size 9 -> floored to the market lot 0.0001 ('2.997')", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "9", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "9000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "33.3"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    // 9 * 33.3 / 100 = 2.997, on the 0.0001 lot (the position printing "9" does not make the lot 1)
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "2.997", closeOpts);
  });
});

// ══════════════════════════════════════════════════════════════
// 12. Edit Order
// ══════════════════════════════════════════════════════════════

describe("trade edit", () => {
  it("calls adapter.editOrder with uppercased symbol, orderId, price, size", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "btc", "order123", "65000", "0.2"]);

    expect(adapter.editOrder).toHaveBeenCalledTimes(1);
    expect(adapter.editOrder).toHaveBeenCalledWith("BTC", "order123", "65000", "0.2");
  });

  it("preserves orderId exactly as provided (case-sensitive)", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "eth", "MyOrder-ABC", "3000", "1"]);

    expect(adapter.editOrder).toHaveBeenCalledWith("ETH", "MyOrder-ABC", "3000", "1");
  });

  it("no other adapter methods are called", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "btc", "order123", "65000", "0.2"]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 13. TP/SL side mapping verification (via stopOrder on generic adapter)
// ══════════════════════════════════════════════════════════════

describe("trade tpsl -- side mapping for generic (Lighter-style) adapter", () => {
  // Note: The tpsl command uses instanceof checks (PacificaAdapter, HyperliquidAdapter, LighterAdapter).
  // Our mock adapter won't match any instanceof check, so it will hit the `else` branch
  // and call errorAndExit. However, we CAN test the side mapping logic indirectly
  // through the close/reduce commands, which is already tested above.
  //
  // For completeness, we verify the side mapping expectation documented in the spec:
  // - BUY position (long): close side = "sell"
  // - SELL position (short): close side = "buy"

  it("LONG position close side is 'sell'", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "1.0", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "1.0", closeOpts);
  });

  it("SHORT position close side is 'buy'", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "short", size: "1.0", entryPrice: "60000", markPrice: "59000", liquidationPrice: "70000", unrealizedPnl: "1000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "close", "btc"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "1.0", closeOpts);
  });

  it("close-all maps sides correctly for mixed positions", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "0.5", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "500", leverage: 10 },
        { symbol: "ETH", side: "short", size: "5.0", entryPrice: "3000", markPrice: "2900", liquidationPrice: "4000", unrealizedPnl: "500", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "close-all"]);

    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "BTC", "sell", "0.5", closeOpts);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "buy", "5.0", closeOpts);
  });

  it("reduce on LONG uses 'sell'", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "2", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "2000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "1", closeOpts);
  });

  it("reduce on SHORT uses 'buy'", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "short", size: "2", entryPrice: "60000", markPrice: "59000", liquidationPrice: "70000", unrealizedPnl: "2000", leverage: 10 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "btc", "50"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "1", closeOpts);
  });
});

// ══════════════════════════════════════════════════════════════
// 14. Symbol uppercasing -- cross-cutting concern
// ══════════════════════════════════════════════════════════════

describe("symbol uppercasing -- cross-cutting", () => {
  it("market order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "doge", "buy", "100"]);
    expect(vi.mocked(adapter.marketOrder).mock.calls[0][0]).toBe("DOGE");
  });

  it("limit order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "arb", "sell", "1.5", "50"]);
    expect(vi.mocked(adapter.limitOrder).mock.calls[0][0]).toBe("ARB");
  });

  it("stop order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "matic", "buy", "1.0", "100"]);
    expect(vi.mocked(adapter.stopOrder).mock.calls[0][0]).toBe("MATIC");
  });

  it("cancel order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "cancel", "avax", "id1"]);
    expect(vi.mocked(adapter.cancelOrder).mock.calls[0][0]).toBe("AVAX");
  });

  it("edit order uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "edit", "link", "o1", "20", "5"]);
    expect(vi.mocked(adapter.editOrder).mock.calls[0][0]).toBe("LINK");
  });

  it("leverage uppercases", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "near", "5"]);
    expect(vi.mocked(adapter.setLeverage).mock.calls[0][0]).toBe("NEAR");
  });

  it("close uppercases", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "APT", side: "long", size: "10", entryPrice: "10", markPrice: "11", liquidationPrice: "8", unrealizedPnl: "10", leverage: 5 },
      ]),
    });
    await run(adapter, ["trade", "close", "apt"]);
    expect(vi.mocked(adapter.marketOrder).mock.calls[0][0]).toBe("APT");
  });

  it("reduce uppercases", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "OP", side: "short", size: "20", entryPrice: "2", markPrice: "1.9", liquidationPrice: "3", unrealizedPnl: "2", leverage: 3 },
      ]),
    });
    await run(adapter, ["trade", "reduce", "op", "50"]);
    expect(vi.mocked(adapter.marketOrder).mock.calls[0][0]).toBe("OP");
  });
});

// ══════════════════════════════════════════════════════════════
// 15. No unexpected extra adapter calls
// ══════════════════════════════════════════════════════════════

describe("no unexpected extra adapter calls", () => {
  it("market order only calls marketOrder", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "market", "btc", "buy", "0.1"]);

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.stopOrder).not.toHaveBeenCalled();
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
    expect(adapter.editOrder).not.toHaveBeenCalled();
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.getPositions).not.toHaveBeenCalled();
  });

  it("limit order only calls limitOrder", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "limit", "btc", "buy", "60000", "0.1"]);

    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.stopOrder).not.toHaveBeenCalled();
  });

  it("stop order only calls stopOrder", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "stop", "btc", "sell", "0.1", "60000"]);

    expect(adapter.stopOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });

  it("leverage only calls setLeverage", async () => {
    const adapter = mockAdapter();
    await run(adapter, ["trade", "leverage", "btc", "10"]);

    expect(adapter.setLeverage).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("flatten only lists/cancels orders, reads positions and sends reduce-only market closes", async () => {
    const adapter = mockAdapter(liveVenue(
      [{ symbol: "BTC", side: "long", size: "1", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 }],
      [openOrder("301", "BTC")],
    ));
    await run(adapter, ["trade", "flatten"]);

    expect(adapter.cancelOrder).toHaveBeenCalledTimes(1);
    expect(adapter.cancelAllOrders).not.toHaveBeenCalled();
    // One read to list positions + the verified close's before/after reads.
    expect(vi.mocked(adapter.getPositions).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "1", closeOpts);
    expect(adapter.limitOrder).not.toHaveBeenCalled();
    expect(adapter.stopOrder).not.toHaveBeenCalled();
    expect(adapter.editOrder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// 14. Scale-in / scale-tp catch handlers — non-Error throws
//     surface real message instead of "[object Object]"
// ══════════════════════════════════════════════════════════════

describe("scale-in catch handler — robust error formatting", () => {
  it("logs JSON-stringified .message when err is { message: { nested } }", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue({ message: { nested: "fail", code: 7 } }),
    });
    // An untyped throw from the send leaves the outcome unknown → ORDER_PENDING (never ok:true).
    await expect(run(adapter, ["trade", "scale-in", "BTC", "buy", "--levels", "5000:100", "--size", "0.001"]))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });

    const failedCalls = vi.mocked(logExecution).mock.calls
      .map(c => c[0] as { status?: string; error?: string })
      .filter(c => c.status === "unverified");
    expect(failedCalls.length).toBeGreaterThan(0);
    for (const call of failedCalls) {
      expect(call.error).not.toBe("[object Object]");
      expect(call.error).toContain("nested");
    }
  });

  it("logs JSON-stringified err when err has no .message (plain structured object)", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue({ code: "FATAL", reason: "oops" }),
    });
    // An untyped throw from the send leaves the outcome unknown → ORDER_PENDING (never ok:true).
    await expect(run(adapter, ["trade", "scale-in", "BTC", "buy", "--levels", "5000:100", "--size", "0.001"]))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });

    const failedCalls = vi.mocked(logExecution).mock.calls
      .map(c => c[0] as { status?: string; error?: string })
      .filter(c => c.status === "unverified");
    expect(failedCalls.length).toBeGreaterThan(0);
    for (const call of failedCalls) {
      expect(call.error).not.toBe("[object Object]");
      expect(call.error).toContain("FATAL");
    }
  });

  it("preserves message string when err is { message: 'plain string' }", async () => {
    const adapter = mockAdapter({
      limitOrder: vi.fn().mockRejectedValue({ message: "real error", code: "X" }),
    });
    // An untyped throw from the send leaves the outcome unknown → ORDER_PENDING (never ok:true).
    await expect(run(adapter, ["trade", "scale-in", "BTC", "buy", "--levels", "5000:100", "--size", "0.001"]))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });

    const failedCalls = vi.mocked(logExecution).mock.calls
      .map(c => c[0] as { status?: string; error?: string })
      .filter(c => c.status === "unverified");
    expect(failedCalls.length).toBeGreaterThan(0);
    for (const call of failedCalls) {
      expect(call.error).toBe("real error");
    }
  });
});

describe("scale-tp --size is bounded by the position; trade reduce asks the reduce-only gate up front", () => {
  const long1 = [{ symbol: "BTC", side: "long" as const, size: "1", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 }];

  it("scale-tp --size above the position → SIZE_TOO_LARGE, nothing sent", async () => {
    const adapter = mockAdapter({ ...liveVenue(long1) });
    await expect(run(adapter, ["trade", "scale-tp", "BTC", "--levels", "70000:100", "--size", "1.5"])).rejects.toMatchObject({
      structured: { code: "SIZE_TOO_LARGE", details: { position: "1", positionSide: "long" }, remediation: expect.stringMatching(/--size of at most 1/) },
    });
    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });

  it("scale-tp --size equal to the position is placed", async () => {
    const adapter = mockAdapter({ ...liveVenue(long1) });
    await run(adapter, ["trade", "scale-tp", "BTC", "--levels", "70000:100", "--size", "1"]);
    expect(adapter.limitOrder).toHaveBeenCalledTimes(1);
  });

  it("trade reduce on a reduce-only-gated venue is refused before the position is read", async () => {
    const gate = new PerpError("CAPABILITY_UNSUPPORTED", "reduce-only is gated", { feature: "reduceOnly" });
    const adapter = mockAdapter({ ...liveVenue(long1), reduceOnlyGate: () => gate });
    await run(adapter, ["trade", "reduce", "BTC", "50"]); // withJsonErrors prints the gate and sets the exit code
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(adapter.getPositions).not.toHaveBeenCalled();
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });
});

describe("scale-tp catch handler — robust error formatting", () => {
  it("logs JSON-stringified .message when limitOrder rejects with object .message", async () => {
    const adapter = mockAdapter({
      ...liveVenue([
        { symbol: "BTC", side: "long", size: "1", entryPrice: "60000", markPrice: "61000", liquidationPrice: "50000", unrealizedPnl: "1000", leverage: 10 },
      ]),
      limitOrder: vi.fn().mockRejectedValue({ message: { server: "down", code: 503 } }),
    });
    await expect(run(adapter, ["trade", "scale-tp", "BTC", "--levels", "70000:100"]))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });

    const failedCalls = vi.mocked(logExecution).mock.calls
      .map(c => c[0] as { status?: string; error?: string })
      .filter(c => c.status === "unverified");
    expect(failedCalls.length).toBeGreaterThan(0);
    for (const call of failedCalls) {
      expect(call.error).not.toBe("[object Object]");
      expect(call.error).toContain("server");
    }
  });
});

// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// Scaled orders: lot-sized levels, venue minimum, honest outcome codes
// ══════════════════════════════════════════════════════════════

describe("scale-tp / scale-in — level sizing and outcome", () => {
  const longEth = (size: string) => liveVenue([
    { symbol: "ETH", side: "long", size, entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 },
  ]);
  const rejected = () => new PerpError("ORDER_REJECTED", "venue said no", { exchange: VENUE });

  it("floors every level to the lot and gives the remainder to the last (0.0041 split 50/50 → 0.002 + 0.0021)", async () => {
    const adapter = mockAdapter({ ...longEth("0.0041") });
    await run(adapter, ["trade", "scale-tp", "ETH", "--levels", "110:50,120:50"]);
    expect(vi.mocked(adapter.limitOrder).mock.calls.map(c => [c[2], c[3], c[4]])).toEqual([
      ["110", "0.002", { reduceOnly: true, tif: "GTC" }],
      ["120", "0.0021", { reduceOnly: true, tif: "GTC" }],
    ]);
  });

  it("finds the position under the venue's own symbol form (Hyperliquid 'ETH-PERP', HIP-3 'xyz:NVDA') and closes on its side", async () => {
    const hl = mockAdapter({ ...liveVenue([
      { symbol: "ETH-PERP", side: "short", size: "0.004", entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 },
    ]) });
    await run(hl, ["trade", "scale-tp", "ETH", "--levels", "90:50,80:50"]);
    expect(vi.mocked(hl.limitOrder).mock.calls.map(c => [c[1], c[3]])).toEqual([["buy", "0.002"], ["buy", "0.002"]]);

    // --size overrides the total only; the side still comes from the position (never a guessed "sell").
    const dex = mockAdapter({ ...liveVenue([
      { symbol: "xyz:ETH", side: "short", size: "1", entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 },
    ]) });
    await run(dex, ["trade", "scale-tp", "ETH", "--levels", "90:100", "--size", "0.5"]);
    expect(vi.mocked(dex.limitOrder).mock.calls.map(c => [c[1], c[3]])).toEqual([["buy", "0.5"]]);
  });

  it("no position → INVALID_PARAMS, with or without --size; nothing sent", async () => {
    for (const extra of [[], ["--size", "1"]]) {
      const adapter = mockAdapter();
      await expect(run(adapter, ["trade", "scale-tp", "ETH", "--levels", "110:100", ...extra]))
        .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
      expect(adapter.limitOrder).not.toHaveBeenCalled();
    }
  });

  it("a level under the venue minimum notional → SIZE_TOO_SMALL, nothing sent (reduce-only is not exempt)", async () => {
    venueMinimums.minNotional = "10";
    const adapter = mockAdapter({ ...longEth("0.0041") });
    await expect(run(adapter, ["trade", "scale-tp", "ETH", "--levels", "110:50,120:50"]))
      .rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });

  it("HIP-3 dex market (not in the public market list): Hyperliquid's venue-wide $10 minimum still refuses the levels before sending", async () => {
    // Live 2026-10-05: scale-tp NVDA --dex xyz on 0.047 sent both levels; the venue refused "Order must have minimum value of $10".
    const dex = mockAdapter({
      ...liveVenue([{ symbol: "xyz:NVDA", side: "long", size: "0.047", entryPrice: "180", markPrice: "180", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 }]),
      getMarkets: vi.fn().mockResolvedValue([{ ...market("xyz:NVDA"), sizeDecimals: 3, stepSize: "0.001" }]),
    });
    await expect(run(dex, ["trade", "scale-tp", "NVDA", "--levels", "190:50,200:50"]))
      .rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL", details: { minNotional: "10" } } });
    expect(dex.limitOrder).not.toHaveBeenCalled();
  });

  it("a level below one lot → SIZE_TOO_SMALL, nothing sent", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "scale-in", "ETH", "buy", "--levels", "90:1,80:99", "--size", "0.001"]))
      .rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
    expect(adapter.limitOrder).not.toHaveBeenCalled();
  });

  it("every level definitely refused → ORDER_REJECTED listing the failed levels", async () => {
    const adapter = mockAdapter({ limitOrder: vi.fn().mockRejectedValue(rejected()) });
    const err = await run(adapter, ["trade", "scale-in", "ETH", "buy", "--levels", "90:50,80:50", "--size", "1"]).catch(e => e) as PerpError;
    expect(err.structured.code).toBe("ORDER_REJECTED");
    expect((err.structured.details as { failed: unknown[]; placed: unknown[] }).failed).toHaveLength(2);
    expect((err.structured.details as { placed: unknown[] }).placed).toHaveLength(0);
    expect(adapter.limitOrder).toHaveBeenCalledTimes(2);
  });

  it("some placed, some refused → ORDER_PARTIAL with both lists", async () => {
    const limitOrder = vi.fn()
      .mockResolvedValueOnce({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 11 } }] } } })
      .mockRejectedValueOnce(rejected());
    const adapter = mockAdapter({ limitOrder });
    const err = await run(adapter, ["trade", "scale-in", "ETH", "buy", "--levels", "90:50,80:50", "--size", "1"]).catch(e => e) as PerpError;
    expect(err.structured.code).toBe("ORDER_PARTIAL");
    const d = err.structured.details as { placed: Array<{ price: string }>; failed: Array<{ price: string }> };
    expect(d.placed.map(l => l.price)).toEqual(["90"]);
    expect(d.failed.map(l => l.price)).toEqual(["80"]);
  });

  it("an unknown outcome → ORDER_PENDING and the remaining levels are NOT sent", async () => {
    const limitOrder = vi.fn().mockRejectedValueOnce(new Error("fetch failed"));
    const adapter = mockAdapter({ limitOrder });
    const err = await run(adapter, ["trade", "scale-in", "ETH", "buy", "--levels", "90:40,80:30,70:30", "--size", "1"]).catch(e => e) as PerpError;
    expect(err.structured.code).toBe("ORDER_PENDING");
    expect(limitOrder).toHaveBeenCalledTimes(1);
    const d = err.structured.details as { unknown: unknown[]; notSent: unknown[] };
    expect(d.unknown).toHaveLength(1);
    expect(d.notSent).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════
// TP/SL direction validation (CHANGELOG "--tp/--sl ... Direction checked
// before the entry is sent (long: tp > ref > sl, short: reverse)") — nothing is sent on a
// wrong-side trigger, which would otherwise fire immediately.
// ══════════════════════════════════════════════════════════════

describe("entry --tp/--sl direction (mark = 100)", () => {
  it("long entry with tp BELOW mark → INVALID_PARAMS, no order sent", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "market", "btc", "buy", "0.1", "--tp", "95", "--sl", "90"]))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("long entry with sl ABOVE mark → INVALID_PARAMS, no order sent", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "market", "btc", "buy", "0.1", "--sl", "105"]))
      .rejects.toThrow(/stop-loss 105 must be below/);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("short entry: tp must be below and sl above the mark", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "market", "btc", "sell", "0.1", "--tp", "110", "--sl", "90"]))
      .rejects.toThrow(/take-profit 110 must be below.*stop-loss 90 must be above/);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("a trigger exactly AT the reference price is rejected (strict inequality)", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "market", "btc", "buy", "0.1", "--tp", "100"]))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("--tp/--sl with --reduce-only is refused before anything is sent", async () => {
    const adapter = mockAdapter();
    await expect(run(adapter, ["trade", "market", "btc", "buy", "0.1", "--reduce-only", "--tp", "110"]))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("correct long tp/sl on a separateOrders venue: verified entry, then reduce-only tp/sl triggers sized to the fill", async () => {
    const triggerOrder = vi.fn().mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } });
    const adapter = mockAdapter({ triggerOrder });
    await run(adapter, ["trade", "market", "btc", "buy", "0.1", "--tp", "110", "--sl", "90"]);

    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.1", entryOpts);
    expect(triggerOrder).toHaveBeenCalledTimes(2);
    expect(triggerOrder).toHaveBeenNthCalledWith(1, "BTC", "sell", "0.1", "110", "tp", expect.objectContaining({ reduceOnly: true, isMarket: true }));
    expect(triggerOrder).toHaveBeenNthCalledWith(2, "BTC", "sell", "0.1", "90", "sl", expect.objectContaining({ reduceOnly: true, isMarket: true }));
  });

  it("entry against an existing OPPOSITE position is refused (TP/SL would protect a position that does not exist)", async () => {
    const triggerOrder = vi.fn();
    const adapter = mockAdapter({
      triggerOrder,
      ...liveVenue([{ symbol: "BTC", side: "short", size: "1", entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }]),
    });
    await expect(run(adapter, ["trade", "market", "btc", "buy", "0.1", "--tp", "110"]))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(triggerOrder).not.toHaveBeenCalled();
  });
});

describe("trade tpsl <symbol> <long|short> — checked against the live position", () => {
  const longBtc = () => liveVenue([{ symbol: "BTC", side: "long", size: "2", entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }]);

  it("long position: tp below mark → INVALID_PARAMS, no trigger sent", async () => {
    const triggerOrder = vi.fn();
    const adapter = mockAdapter({ ...longBtc(), triggerOrder });
    await expect(run(adapter, ["trade", "tpsl", "btc", "long", "--tp", "90"])).rejects.toThrow(/take-profit 90 must be above the mark price 100/);
    expect(triggerOrder).not.toHaveBeenCalled();
  });

  it("positionSide that does not match the live position → INVALID_PARAMS", async () => {
    const triggerOrder = vi.fn();
    const adapter = mockAdapter({ ...longBtc(), triggerOrder });
    await expect(run(adapter, ["trade", "tpsl", "btc", "short", "--tp", "90"])).rejects.toThrow(/is long, not short/);
    expect(triggerOrder).not.toHaveBeenCalled();
  });

  it("buy/sell are no longer accepted as positionSide", async () => {
    const adapter = mockAdapter(longBtc());
    await expect(run(adapter, ["trade", "tpsl", "btc", "buy", "--tp", "110"])).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("valid long tp/sl: reduce-only triggers on the close side sized to the live position", async () => {
    const triggerOrder = vi.fn().mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } });
    const adapter = mockAdapter({ ...longBtc(), triggerOrder });
    await run(adapter, ["trade", "tpsl", "btc", "long", "--tp", "110", "--sl", "90"]);
    expect(triggerOrder).toHaveBeenCalledWith("BTC", "sell", "2", "110", "tp", expect.objectContaining({ reduceOnly: true }));
    expect(triggerOrder).toHaveBeenCalledWith("BTC", "sell", "2", "90", "sl", expect.objectContaining({ reduceOnly: true }));
  });

  it("--size larger than the position → INVALID_PARAMS", async () => {
    const triggerOrder = vi.fn();
    const adapter = mockAdapter({ ...longBtc(), triggerOrder });
    await expect(run(adapter, ["trade", "tpsl", "btc", "long", "--tp", "110", "--size", "3"])).rejects.toThrow(/exceeds the BTC position size 2/);
    expect(triggerOrder).not.toHaveBeenCalled();
  });
});
