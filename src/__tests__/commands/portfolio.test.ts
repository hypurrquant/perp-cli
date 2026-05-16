/**
 * Tests for src/commands/portfolio.ts — unified portfolio command.
 *
 * Covers: snapshot, single-exchange, multi-exchange filter, arb, health,
 * stdin input, error envelopes, JSON structure, risk levels, connection errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { Readable } from "stream";

// ── Mock shared-api (ping functions) BEFORE module imports ────────────────

const mockPingPacifica = vi.fn();
const mockPingHyperliquid = vi.fn();
const mockPingLighter = vi.fn();

vi.mock("../../shared-api.js", () => ({
  pingPacifica: () => mockPingPacifica(),
  pingHyperliquid: () => mockPingHyperliquid(),
  pingLighter: () => mockPingLighter(),
}));

// ── Mock funding-rates ─────────────────────────────────────────────────────

const mockFetchAllFundingRates = vi.fn();

vi.mock("../../funding-rates.js", () => ({
  fetchAllFundingRates: (...args: unknown[]) => mockFetchAllFundingRates(...args),
  TOP_SYMBOLS: ["BTC", "ETH", "SOL"],
}));

// ── Mock funding-history ───────────────────────────────────────────────────

vi.mock("../../funding-history.js", () => ({
  saveFundingSnapshot: vi.fn(),
  getHistoricalAverages: vi.fn().mockReturnValue(new Map()),
}));

// ── Mock HyperliquidSpotAdapter / LighterSpotAdapter (not needed in tests) ─

vi.mock("../../exchanges/hyperliquid-spot.js", () => ({
  HyperliquidSpotAdapter: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getSpotBalances: vi.fn().mockResolvedValue([]),
    getSpotMarkets: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../../exchanges/lighter-spot.js", () => ({
  LighterSpotAdapter: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getSpotBalances: vi.fn().mockResolvedValue([]),
    getSpotMarkets: vi.fn().mockResolvedValue([]),
  })),
}));

// ── Mock dashboard (runServe path not tested here) ─────────────────────────

vi.mock("../../dashboard/index.js", () => ({
  startDashboard: vi.fn().mockResolvedValue({ port: 3456, close: vi.fn() }),
}));

// ── Import module under test after mocks ─────────────────────────────────

const { registerPortfolioCommand } = await import("../../commands/portfolio.js");

// ── Helpers ───────────────────────────────────────────────────────────────

/** Synthetic balance object returned by mock adapters */
function makeBalance(equity = "1000", available = "800", marginUsed = "200", unrealizedPnl = "50") {
  return { equity, available, marginUsed, unrealizedPnl };
}

/** Create a mock adapter for a given exchange */
function makeMockAdapter(opts: {
  equity?: string;
  marginUsed?: string;
  throwError?: string;
} = {}) {
  if (opts.throwError) {
    return vi.fn().mockRejectedValue(new Error(opts.throwError));
  }
  return vi.fn().mockResolvedValue({
    getBalance: vi.fn().mockResolvedValue(makeBalance(opts.equity ?? "1000", "800", opts.marginUsed ?? "200")),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    address: "0xTestAddress",
  });
}

/**
 * Build a test program with the portfolio command registered.
 * `adapterFactory` is called per exchange name and should return an adapter or throw.
 */
function makeProgram(adapterFactory?: (exchange: string) => Promise<unknown>) {
  const prog = new Command();
  prog.exitOverride();
  prog
    .option("-e, --exchange <exchange>", "Exchange", "pacifica")
    .option("--json", "JSON output");

  const defaultFactory = async () => ({
    getBalance: vi.fn().mockResolvedValue(makeBalance()),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getFundingPayments: vi.fn().mockResolvedValue([]),
    address: "0xDefaultAddr",
  });

  registerPortfolioCommand(
    prog,
    adapterFactory ?? defaultFactory as never,
    () => prog.opts().json === true,
    "1.0.0-test",
  );

  return prog;
}

/** Capture stdout/stderr output during a command run */
interface Captured {
  stdoutLines: string[];
  stderrLines: string[];
}

function captureOutput(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdoutLines: [], stderrLines: [] };

  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    captured.stdoutLines.push(String(s));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    captured.stderrLines.push(String(s));
    return true;
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.stdoutLines.push(args.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.stderrLines.push(args.map(String).join(" "));
  });

  return {
    captured,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

/** Parse captured stdout lines into first JSON envelope found */
function parseEnvelope(lines: string[]): Record<string, unknown> {
  const combined = lines.join("");
  // Find first JSON object
  const idx = combined.indexOf("{");
  if (idx === -1) throw new Error(`No JSON in output: ${combined.slice(0, 200)}`);
  return JSON.parse(combined.slice(idx)) as Record<string, unknown>;
}

// ── Default mock ping responses ───────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPingPacifica.mockResolvedValue({ ok: true, latencyMs: 10, status: 200 });
  mockPingHyperliquid.mockResolvedValue({ ok: true, latencyMs: 10, status: 200 });
  mockPingLighter.mockResolvedValue({ ok: true, latencyMs: 10, status: 200 });
  // Default fetch for aster ping in health mode
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Default snapshot (all 4 exchanges)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 1: Default snapshot (all 4 exchanges)", () => {
  it("scope=all, mode=snapshot, exchanges.length=4, totals.accountValueUsd is sum", async () => {
    const factory = vi.fn().mockResolvedValue({
      getBalance: vi.fn().mockResolvedValue(makeBalance("500")),
      getPositions: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getFundingPayments: vi.fn().mockResolvedValue([]),
      address: "0xAddr",
    });

    const prog = makeProgram(factory as never);
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.scope).toBe("all");
    expect(data.mode).toBe("snapshot");
    const exchanges = data.exchanges as unknown[];
    expect(exchanges).toHaveLength(4);
    const totals = data.totals as Record<string, number>;
    // Each exchange has equity=500, no spot, so total = 4 * 500 = 2000
    expect(totals.accountValueUsd).toBeCloseTo(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1b: positions[] entries carry liquidationPrice (qa/2026-05-16)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 1b: positions[] surfaces liquidationPrice from adapter", () => {
  // Prior to qa/2026-05-16 the portfolio map dropped `liquidationPrice` from
  // each position entry — surfaced by docker QA cross-validation against
  // `account positions` which DID include the field. Pinning here so the
  // field passes through end-to-end and the portfolio UI can show
  // liq-distance without a second adapter round-trip.
  it("includes liquidationPrice in each positions[] entry alongside markPrice/entryPrice", async () => {
    const factory = vi.fn().mockResolvedValue({
      getBalance: vi.fn().mockResolvedValue(makeBalance("100")),
      getPositions: vi.fn().mockResolvedValue([
        {
          symbol: "BTC", side: "long", size: "0.5",
          entryPrice: "50000", markPrice: "51000",
          liquidationPrice: "40000",
          unrealizedPnl: "500", leverage: 10,
        },
      ]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getFundingPayments: vi.fn().mockResolvedValue([]),
      address: "0xAddr",
    });

    const prog = makeProgram(factory as never);
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "-e", "hyperliquid", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    const exchanges = data.exchanges as Array<Record<string, unknown>>;
    const positions = exchanges[0].positions as Array<Record<string, unknown>>;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      symbol: "BTC",
      entryPrice: "50000",
      markPrice: "51000",
      liquidationPrice: "40000",
      unrealizedPnl: "500",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Single-exchange filter via global -e
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 2: Single-exchange via global -e flag", () => {
  it("perp -e hyperliquid portfolio → scope=single, exchanges.length=1, name=hyperliquid", async () => {
    const prog = makeProgram();
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      // Provide -e before the subcommand so getOptionValueSource("exchange") === "cli"
      await prog.parseAsync(["node", "perp", "-e", "hyperliquid", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.scope).toBe("single");
    const exchanges = data.exchanges as Array<Record<string, unknown>>;
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].name).toBe("hyperliquid");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: --exchanges list filter
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 3: --exchanges list filter", () => {
  it("--exchanges hyperliquid,pacifica → scope=all, exchanges.length=2, names match", async () => {
    const prog = makeProgram();
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio", "--exchanges", "hyperliquid,pacifica"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.scope).toBe("all");
    const exchanges = data.exchanges as Array<Record<string, unknown>>;
    expect(exchanges).toHaveLength(2);
    const names = exchanges.map(e => e.name);
    expect(names).toContain("hyperliquid");
    expect(names).toContain("pacifica");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: --arb flag includes arb key
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 4: --arb flag includes arb key", () => {
  it("arb.topOpportunities is array with correct shape", async () => {
    mockFetchAllFundingRates.mockResolvedValue({
      symbols: [
        {
          symbol: "BTC",
          maxSpreadAnnual: 150,
          shortExchange: "hyperliquid",
          longExchange: "pacifica",
          rates: [
            { exchange: "hyperliquid", rate: 0.0001 },
            { exchange: "pacifica", rate: -0.0001 },
          ],
        },
        {
          symbol: "ETH",
          maxSpreadAnnual: 80,
          shortExchange: "pacifica",
          longExchange: "lighter",
          rates: [
            { exchange: "pacifica", rate: 0.0001 },
            { exchange: "lighter", rate: -0.0001 },
          ],
        },
      ],
    });

    const prog = makeProgram();
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio", "--arb"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.arb).toBeDefined();
    const arb = data.arb as Record<string, unknown>;
    const opps = arb.topOpportunities as Array<Record<string, unknown>>;
    expect(Array.isArray(opps)).toBe(true);
    expect(opps.length).toBeLessThanOrEqual(5);
    if (opps.length > 0) {
      const first = opps[0];
      expect(first).toHaveProperty("symbol");
      expect(first).toHaveProperty("spreadAnnual");
      expect(first).toHaveProperty("direction");
      expect(first).toHaveProperty("longExchange");
      expect(first).toHaveProperty("shortExchange");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: --health mode
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 5: --health mode", () => {
  it("mode=health, data.health.exchanges has 4 keys, data.health.anyDown is boolean", async () => {
    const prog = makeProgram();
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio", "--health"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.mode).toBe("health");
    expect(data.health).toBeDefined();
    const health = data.health as Record<string, unknown>;
    const exchangeKeys = Object.keys(health.exchanges as object);
    expect(exchangeKeys).toHaveLength(4);
    expect(typeof health.anyDown).toBe("boolean");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: --stdin JSON input parses correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 6: --stdin JSON input parses correctly", () => {
  it("stdin {exchanges:[hyperliquid,pacifica]} → 2 exchanges, no arb key by default", async () => {
    // Mock stdin to emit JSON then end
    const stdinJson = JSON.stringify({ exchanges: ["hyperliquid", "pacifica"] });
    const mockStdin = new Readable({
      read() {
        this.push(stdinJson);
        this.push(null);
      },
    });
    const origStdin = process.stdin;

    // Replace process.stdin temporarily
    Object.defineProperty(process, "stdin", {
      value: mockStdin,
      configurable: true,
      writable: true,
    });
    (mockStdin as NodeJS.ReadableStream & { setEncoding?: (enc: string) => void }).setEncoding = vi.fn();

    const prog = makeProgram();
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio", "--stdin"]);
    } finally {
      restore();
      exitSpy.mockRestore();
      Object.defineProperty(process, "stdin", {
        value: origStdin,
        configurable: true,
        writable: true,
      });
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    const exchanges = data.exchanges as unknown[];
    expect(exchanges).toHaveLength(2);
    expect(data.arb).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: --stdin malformed JSON → INVALID_PARAMS
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 7: --stdin malformed JSON → INVALID_PARAMS", () => {
  it("garbage stdin → exit 1 + error envelope with INVALID_PARAMS", async () => {
    const mockStdin = new Readable({
      read() {
        this.push("not valid json }{{{");
        this.push(null);
      },
    });
    const origStdin = process.stdin;

    Object.defineProperty(process, "stdin", {
      value: mockStdin,
      configurable: true,
      writable: true,
    });
    (mockStdin as NodeJS.ReadableStream & { setEncoding?: (enc: string) => void }).setEncoding = vi.fn();

    const prog = makeProgram();
    const { captured, restore } = captureOutput();

    let exitCode: number | null = null;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 1;
      throw new Error(`exit(${code})`);
    }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio", "--stdin"]);
    } catch {
      // expected — process.exit throws
    } finally {
      restore();
      exitSpy.mockRestore();
      Object.defineProperty(process, "stdin", {
        value: origStdin,
        configurable: true,
        writable: true,
      });
    }

    expect(exitCode).toBe(1);
    const combined = captured.stdoutLines.join("");
    const envelope = JSON.parse(combined) as Record<string, unknown>;
    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe("INVALID_PARAMS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Unknown exchange name → INVALID_PARAMS
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 8: Unknown exchange name → INVALID_PARAMS error envelope", () => {
  it("--exchanges foobar → ok:false, code=INVALID_PARAMS", async () => {
    const prog = makeProgram();
    const { captured, restore } = captureOutput();

    let exitCode: number | null = null;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 1;
      throw new Error(`exit(${code})`);
    }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio", "--exchanges", "foobar"]);
    } catch {
      // expected
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    const combined = captured.stdoutLines.join("");
    const envelope = JSON.parse(combined) as Record<string, unknown>;
    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe("INVALID_PARAMS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: JSON envelope structure conforms
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 9: JSON envelope structure conforms to spec", () => {
  it("all required keys present with correct types", async () => {
    const prog = makeProgram();
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;

    // Required top-level keys in data
    expect(typeof data.version).toBe("string");
    expect(data.scope === "all" || data.scope === "single").toBe(true);
    expect(["snapshot", "health", "watch", "serve"]).toContain(data.mode);
    expect(Array.isArray(data.exchanges)).toBe(true);
    expect(typeof data.totals).toBe("object");
    expect(typeof data.risk).toBe("object");

    // totals keys
    const totals = data.totals as Record<string, unknown>;
    expect(typeof totals.equity).toBe("number");
    expect(typeof totals.spotValueUsd).toBe("number");
    expect(typeof totals.accountValueUsd).toBe("number");
    expect(typeof totals.marginUsed).toBe("number");
    expect(typeof totals.marginPct).toBe("number");
    expect(typeof totals.funding24h).toBe("number");

    // risk keys
    const risk = data.risk as Record<string, unknown>;
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(risk.level);
    expect(typeof risk.marginPct).toBe("number");

    // meta.timestamp
    const meta = envelope.meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(typeof meta.timestamp).toBe("string");
    expect(isNaN(Date.parse(meta.timestamp as string))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Risk level transitions
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 10: Risk level transitions", () => {
  it("marginPct < 30 → LOW", async () => {
    // equity=1000, marginUsed=100 → 10% → LOW
    const factory = vi.fn().mockResolvedValue({
      getBalance: vi.fn().mockResolvedValue(makeBalance("1000", "900", "100")),
      getPositions: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getFundingPayments: vi.fn().mockResolvedValue([]),
      address: "0xAddr",
    });

    const prog = makeProgram(factory as never);
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const data = (parseEnvelope(captured.stdoutLines).data) as Record<string, unknown>;
    expect((data.risk as Record<string, unknown>).level).toBe("LOW");
  });

  it("30 <= marginPct < 60 → MEDIUM", async () => {
    // equity=1000, marginUsed=400 → 40% → MEDIUM (across 4 exchanges = 40/100 = 40%)
    const factory = vi.fn().mockResolvedValue({
      getBalance: vi.fn().mockResolvedValue(makeBalance("1000", "600", "400")),
      getPositions: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getFundingPayments: vi.fn().mockResolvedValue([]),
      address: "0xAddr",
    });

    const prog = makeProgram(factory as never);
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const data = (parseEnvelope(captured.stdoutLines).data) as Record<string, unknown>;
    expect((data.risk as Record<string, unknown>).level).toBe("MEDIUM");
  });

  it("marginPct >= 60 → HIGH", async () => {
    // equity=1000, marginUsed=700 → 70% → HIGH
    const factory = vi.fn().mockResolvedValue({
      getBalance: vi.fn().mockResolvedValue(makeBalance("1000", "300", "700")),
      getPositions: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getFundingPayments: vi.fn().mockResolvedValue([]),
      address: "0xAddr",
    });

    const prog = makeProgram(factory as never);
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const data = (parseEnvelope(captured.stdoutLines).data) as Record<string, unknown>;
    expect((data.risk as Record<string, unknown>).level).toBe("HIGH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: Connection error per exchange surfaces in entry
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 11: Connection error per exchange surfaces in entry", () => {
  it("when getAdapterForExchange throws, that exchange has connected:false and error message", async () => {
    const factory = vi.fn().mockImplementation(async (exchange: string) => {
      if (exchange === "hyperliquid") {
        throw new Error("connection refused");
      }
      return {
        getBalance: vi.fn().mockResolvedValue(makeBalance()),
        getPositions: vi.fn().mockResolvedValue([]),
        getOpenOrders: vi.fn().mockResolvedValue([]),
        getFundingPayments: vi.fn().mockResolvedValue([]),
        address: "0xAddr",
      };
    });

    const prog = makeProgram(factory as never);
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio"]);
    } finally {
      restore();
      exitSpy.mockRestore();
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    const exchanges = data.exchanges as Array<Record<string, unknown>>;
    const hlEntry = exchanges.find(e => e.name === "hyperliquid");
    expect(hlEntry).toBeDefined();
    expect(hlEntry!.connected).toBe(false);
    expect(typeof hlEntry!.error).toBe("string");
    expect(hlEntry!.error).toContain("connection refused");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: stdin overrides CLI --exchanges flag
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 12: stdin overrides CLI --exchanges flag", () => {
  it("--exchanges aster + stdin {exchanges:[hyperliquid]} → stdin wins, exchanges[0].name=hyperliquid", async () => {
    const stdinJson = JSON.stringify({ exchanges: ["hyperliquid"] });
    const mockStdin = new Readable({
      read() {
        this.push(stdinJson);
        this.push(null);
      },
    });
    const origStdin = process.stdin;

    Object.defineProperty(process, "stdin", {
      value: mockStdin,
      configurable: true,
      writable: true,
    });
    (mockStdin as NodeJS.ReadableStream & { setEncoding?: (enc: string) => void }).setEncoding = vi.fn();

    const prog = makeProgram();
    const { captured, restore } = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    try {
      await prog.parseAsync(["node", "perp", "--json", "portfolio", "--exchanges", "aster", "--stdin"]);
    } finally {
      restore();
      exitSpy.mockRestore();
      Object.defineProperty(process, "stdin", {
        value: origStdin,
        configurable: true,
        writable: true,
      });
    }

    const envelope = parseEnvelope(captured.stdoutLines);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    const exchanges = data.exchanges as Array<Record<string, unknown>>;
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].name).toBe("hyperliquid");
  });
});
