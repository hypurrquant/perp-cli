/**
 * MCP and TxFlow: the account read tools (get_balance / get_positions / get_open_orders) cover
 * TxFlow — without credentials they refuse with NO_SIGNER_AVAILABLE before any request; with a
 * stored agent they read the AGENT's account (`user` = the account address, never the agent's)
 * from the recorded testnet answers. Trading tools refuse while the release switch is off (mocked
 * off here — trading ships on since 2026-10-28; the gate must hold if it is switched off again).
 * The OWS signer is faked (no vault in unit tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, ToolHandler>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, h: ToolHandler) { tools.set(name, h); }
    resource() { /* not used */ }
    prompt() { /* not used */ }
    async connect() { /* no transport in tests */ }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../exchanges/venues/txflow-release.js", () => ({ TXFLOW_TRADING_ENABLED: false }));
const AGENT = "0x00000000000000000000000000000000000a6e47";
vi.mock("../signer/ows-evm.js", () => ({
  OwsEvmSigner: { create: () => ({ getAddress: () => AGENT, signTypedData: async () => { throw new Error("no signing in this test"); }, signMessage: async () => "0x" }) },
}));

const FIX = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/txflow/account-reads-testnet.json"), "utf8")) as {
  reads: Record<string, { httpStatus: number; body: unknown }>;
};
const ACCOUNT = "0x000000000000000000000000000000000000dEaD";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  fetchMock = vi.fn(async (u: string) => { throw new Error(`unexpected network call: ${u}`); });
  vi.stubGlobal("fetch", fetchMock);
  if (tools.size === 0) await import("../mcp-server.js");
});

const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await tools.get(tool)!(args);
  return JSON.parse(r.content[0].text) as { ok: boolean; code?: string; data?: unknown };
};

describe("MCP trading tools on txflow: switched off (txflow-release.ts) → CAPABILITY_UNSUPPORTED, zero fetch", () => {
  const TRADE: Array<[string, Record<string, unknown>]> = [
    ["trade_preview", { exchange: "txflow", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false }],
    ["trade_execute", { exchange: "txflow", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false }],
    ["trade_close", { exchange: "txflow", symbol: "BTC" }],
  ];
  for (const [tool, args] of TRADE) {
    it(`${tool} → CAPABILITY_UNSUPPORTED`, async () => {
      const env = await call(tool, args);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe("MCP account read tools on txflow without credentials", () => {
  const CALLS: Array<[string, Record<string, unknown>]> = [
    ["get_balance", { exchange: "txflow" }],
    ["get_positions", { exchange: "txf" }],
    ["get_open_orders", { exchange: "txflow" }],
  ];
  for (const [tool, args] of CALLS) {
    it(`${tool} → NO_SIGNER_AVAILABLE, zero fetch`, async () => {
      const env = await call(tool, args);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("NO_SIGNER_AVAILABLE");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe("MCP read tools with a stored TxFlow agent", () => {
  it("get_positions / get_balance / get_open_orders read the agent's ACCOUNT", async () => {
    const { setVenueAgent } = await import("../agent-wallet/store.js");
    setVenueAgent("txflow", {
      kind: "txflow", agentName: "perp-cli-txflow", agentWalletName: "agent-txflow-main", agentAddress: AGENT, accountAddress: ACCOUNT,
      network: "mainnet", approvedAt: "2026-10-27T00:00:00.000Z", source: "approved",
    });
    const users: unknown[] = [];
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { type: string; user?: string; offset?: number };
      if (b.user !== undefined) users.push(b.user);
      // The recording is the whole list: page 0 serves it, the next page is empty.
      // tpslOrders: no position TP/SL on the recorded account (the same empty-list envelope).
      const key = b.type === "clearinghouseState" ? "clearinghouseState.position" : b.type === "triggerOrders" || b.type === "tpslOrders" ? "triggerOrders.empty" : b.type;
      const rec = FIX.reads[key];
      if (rec === undefined) throw new Error(`unexpected /info ${b.type}`);
      if (b.type === "frontendOpenOrders" && (b.offset ?? 0) > 0) {
        return new Response(JSON.stringify({ ...(rec.body as object), data: [] }), { status: rec.httpStatus });
      }
      return new Response(JSON.stringify(rec.body), { status: rec.httpStatus });
    });
    const pos = await call("get_positions", { exchange: "txflow" });
    expect(pos.ok).toBe(true);
    expect((pos.data as Array<{ symbol: string }>).map(p => p.symbol)).toEqual(["BZ", "BTC", "ETH"]);
    const bal = await call("get_balance", { exchange: "txflow" });
    expect(bal.ok).toBe(true);
    const orders = await call("get_open_orders", { exchange: "txflow" });
    expect((orders.data as Array<{ symbol: string }>).map(o => o.symbol)).toEqual(["BZ", "BTC"]);
    expect(users.length).toBeGreaterThan(0);
    expect(users.every(u => u === ACCOUNT)).toBe(true);
  });
});
