/**
 * Review N4: MCP `trade_execute` / `trade_close` go through the CLI's safety path
 * (risk gate with no force over MCP, quarantine reject for non-reduce-only, execution +
 * client-id log) and every result reports the network, which comes from PERP_NETWORK
 * validated by the same parser as `-n`. HOME is isolated by the vitest setup file; no
 * network I/O (adapter creation, TradingV2 send and the risk gate are mocked).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, ToolHandler>();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, h: ToolHandler) { tools.set(name, h); }
    resource() { /* not exercised */ }
    prompt() { /* not exercised */ }
    async connect() { /* no transport in tests */ }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));

const createCtx: { network: string }[] = [];
const fakeAdapter = {
  name: "hyperliquid",
  getPositions: vi.fn(async () => [] as unknown[]),
  marketOrder: vi.fn(async () => ({})),
  lotStepOf: () => "0.1", // HL-style lot step from the loaded meta
};
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  hasCredentials: async () => true,
  resolveCredentials: async () => ({}),
}));
vi.mock("../exchanges/venues/create-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exchanges/venues/create-helpers.js")>()),
  createHyperliquid: async (ctx: { network: string }) => { createCtx.push(ctx); return fakeAdapter; },
}));
vi.mock("../exchanges/legacy-trading-v2.js", () => ({ tradingV2Of: () => ({}) }));
const placeAndConfirm = vi.fn();
vi.mock("../exchanges/trading-v2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exchanges/trading-v2.js")>()),
  placeAndConfirm: (...a: unknown[]) => placeAndConfirm(...a),
}));
const enforceOrderRisk = vi.fn();
vi.mock("../trade-validator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../trade-validator.js")>()),
  enforceOrderRisk: (...a: unknown[]) => enforceOrderRisk(...a),
}));

const { clearQuarantine } = await import("../bot/quarantine.js");
const { resolveMcpNetwork } = await import("../mcp-trade-guard.js");

function placed(): Record<string, unknown> {
  return {
    status: "filled", finality: "final", orderId: "1", clientOrderId: null, filledSize: "0.01", avgPrice: "100",
    venueRaw: { ok: true }, execution: null,
  };
}

async function loadServer(network: string | undefined): Promise<void> {
  tools.clear();
  vi.resetModules();
  if (network === undefined) delete process.env["PERP_NETWORK"];
  else process.env["PERP_NETWORK"] = network;
  await import("../mcp-server.js");
}

function parse(r: { content: { text: string }[] }): { ok: boolean; code?: string; meta: { network: string }; data?: Record<string, unknown> } {
  return JSON.parse(r.content[0].text);
}

const execLog = (): Array<Record<string, unknown>> => {
  const f = resolve(process.env.HOME!, ".perp", "executions.jsonl");
  return existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

const BUY = { exchange: "hyperliquid", symbol: "BTC", side: "buy", size: "0.01", orderType: "market", reduceOnly: false };

beforeEach(() => {
  placeAndConfirm.mockReset().mockResolvedValue(placed());
  enforceOrderRisk.mockReset().mockResolvedValue(undefined);
  createCtx.length = 0;
  clearQuarantine("BTC", null);
});

describe("resolveMcpNetwork (PERP_NETWORK)", () => {
  it("unset → mainnet (documented default); valid values pass; anything else throws", () => {
    expect(resolveMcpNetwork(undefined)).toBe("mainnet");
    expect(resolveMcpNetwork("testnet")).toBe("testnet");
    expect(() => resolveMcpNetwork("Testnet")).toThrow(/Invalid network/);
    expect(() => resolveMcpNetwork("")).toThrow(/Invalid network/);
  });
});

describe("MCP trade_execute safety path", () => {
  it("risk violation → refused before anything is sent; risk gate called with force:false", async () => {
    await loadServer(undefined);
    // vi.resetModules() gives the server a fresh module graph: build errors from IT, so instanceof holds.
    const { PerpError } = await import("../errors.js");
    enforceOrderRisk.mockRejectedValue(new PerpError("RISK_VIOLATION", "Order blocked by local risk limits"));
    const r = await tools.get("trade_execute")!(BUY);
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe("RISK_VIOLATION");
    expect(parse(r).meta.network).toBe("mainnet");
    expect(placeAndConfirm).not.toHaveBeenCalled();
    expect(enforceOrderRisk.mock.calls[0][1]).toMatchObject({ symbol: "BTC", force: false, reduceOnly: false });
  });

  it("quarantined symbol → non-reduce-only refused, reduce-only allowed", async () => {
    await loadServer(undefined);
    const { quarantineSymbol } = await import("../bot/quarantine.js");
    quarantineSymbol("test", "BTC", "unknown outcome", "check BTC", () => {});
    const r = await tools.get("trade_execute")!(BUY);
    expect(parse(r).code).toBe("RISK_VIOLATION");
    expect(JSON.stringify(parse(r))).toMatch(/quarantined/);
    expect(placeAndConfirm).not.toHaveBeenCalled();

    const r2 = await tools.get("trade_execute")!({ ...BUY, side: "sell", reduceOnly: true });
    expect(parse(r2).ok).toBe(true);
    expect(placeAndConfirm).toHaveBeenCalledTimes(1);
  });

  it("success → execution log entry (source mcp + network) and meta.network", async () => {
    await loadServer(undefined);
    const before = execLog().length;
    const r = await tools.get("trade_execute")!(BUY);
    expect(parse(r).ok).toBe(true);
    expect(parse(r).meta.network).toBe("mainnet");
    const rec = execLog().slice(before);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ type: "market_order", exchange: "hyperliquid", symbol: "BTC", status: "success", dryRun: false, meta: { source: "mcp", network: "mainnet" } });
  });

  it("send failure → logged as failed and surfaced", async () => {
    await loadServer(undefined);
    const { PerpError } = await import("../errors.js");
    placeAndConfirm.mockRejectedValue(new PerpError("ORDER_REJECTED", "venue rejected: size below minimum"));
    const before = execLog().length;
    const r = await tools.get("trade_execute")!(BUY);
    expect(r.isError).toBe(true);
    expect(execLog().slice(before)[0]).toMatchObject({ status: "failed", meta: { source: "mcp" } });
  });

  it("PERP_NETWORK=testnet → adapter built on testnet and every result reports testnet", async () => {
    await loadServer("testnet");
    const r = await tools.get("trade_execute")!(BUY);
    expect(parse(r).ok).toBe(true);
    expect(createCtx[0].network).toBe("testnet");
    expect(parse(r).meta.network).toBe("testnet");
  });

  it("invalid PERP_NETWORK → the server refuses to load (no silent mainnet)", async () => {
    await expect(loadServer("main")).rejects.toThrow(/Invalid network/);
    delete process.env["PERP_NETWORK"];
  });
});

describe("MCP trade_close: verified close", () => {
  it("a partial close's residual is floored to the market lot, not the decimals the size prints (10, 9.3 filled → closes 0.7)", async () => {
    await loadServer(undefined);
    let held = 10;
    fakeAdapter.getPositions.mockImplementation(async () => held > 0 ? [{ symbol: "BTC", side: "long", size: String(held), entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }] : []);
    placeAndConfirm.mockImplementation(async () => { held = 0.7; return placed(); }); // the venue fills 9.3 of 10
    fakeAdapter.marketOrder.mockImplementation(async () => { held = 0; return {}; });
    try {
      const r = await tools.get("trade_close")!({ exchange: "hyperliquid", symbol: "BTC" });
      expect(fakeAdapter.marketOrder).toHaveBeenCalledWith("BTC", "sell", "0.7", expect.objectContaining({ reduceOnly: true }));
      expect(parse(r).data).toMatchObject({ closed: true, closedSize: "10", residual: "0" });
    } finally {
      fakeAdapter.getPositions.mockImplementation(async () => []);
    }
  });
});

describe("MCP trade_execute: unknown outcome", () => {
  it("transport failure after send → logged unverified (never 'failed'), ORDER_PENDING surfaced", async () => {
    await loadServer(undefined);
    placeAndConfirm.mockRejectedValue(new Error("socket hang up"));
    const before = execLog().length;
    const r = await tools.get("trade_execute")!(BUY);
    expect(parse(r).code).toBe("ORDER_PENDING");
    expect(execLog().slice(before)[0]).toMatchObject({ status: "unverified", meta: { source: "mcp" } });
  });
});
