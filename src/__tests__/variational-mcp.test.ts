/**
 * MCP: every account / trading tool refuses Variational (market data only; no public trading API yet)
 * with CAPABILITY_UNSUPPORTED and makes zero network calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  fetchMock = vi.fn(async (u: string) => { throw new Error(`unexpected network call: ${u}`); });
  vi.stubGlobal("fetch", fetchMock);
  if (tools.size === 0) await import("../mcp-server.js");
});

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["get_balance", { exchange: "variational" }],
  ["get_positions", { exchange: "var" }],
  ["get_open_orders", { exchange: "variational" }],
  ["trade_preview", { exchange: "variational", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false }],
  ["trade_execute", { exchange: "variational", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false }],
  ["trade_close", { exchange: "variational", symbol: "BTC" }],
  ["get_positions", { exchange: "omni" }],
];

describe("MCP write / account tools refuse variational", () => {
  for (const [tool, args] of CALLS) {
    it(`${tool} → CAPABILITY_UNSUPPORTED, zero fetch`, async () => {
      const h = tools.get(tool);
      expect(h).toBeDefined();
      const r = await h!(args);
      const env = JSON.parse(r.content[0].text) as { ok: boolean; code?: string };
      expect(env.ok).toBe(false);
      expect(env.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(JSON.stringify(env)).toContain("Variational is read-only (market data) in perp-cli");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
