/**
 * MCP portfolio: a venue whose open orders are unknown (read-only Lighter / expired agent) keeps
 * its balance and positions; totalOpenOrders sums the known venues and openOrdersUnknown lists the rest.
 */
import { describe, it, expect, vi } from "vitest";
import { PerpError } from "../errors.js";

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
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  hasCredentials: async () => true,
  resolveCredentials: async () => ({}),
  listConfiguredAccountVenues: async () => ["hyperliquid", "lighter"],
}));
const BAL = { equity: "100", available: "80", marginUsed: "20", unrealizedPnl: "0" };
const POS = { symbol: "ETH", side: "long", size: "1", entryPrice: "2000", markPrice: "2000", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 };
vi.mock("../exchanges/venues/create-helpers.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/venues/create-helpers.js")>()),
  createHyperliquid: async () => ({ name: "hyperliquid", getBalance: async () => BAL, getPositions: async () => [], getOpenOrders: async () => [{ orderId: "1" }, { orderId: "2" }] }),
  createLighterFamily: async () => ({
    name: "lighter", getBalance: async () => BAL, getPositions: async () => [POS],
    getOpenOrders: async () => { throw new PerpError("AGENT_EXPIRED", "lighter agent API key (slot 3) expired"); },
  }),
}));

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text) as { ok: boolean; data: Record<string, unknown> };

describe("MCP portfolio: unknown open orders", () => {
  it("the Lighter balance + position are counted; totalOpenOrders covers HL only and lists lighter as unknown", async () => {
    await import("../mcp-server.js");
    const d = parse(await tools.get("portfolio")!({})).data;
    expect(d).toMatchObject({ totalEquity: 200, totalPositions: 1, totalOpenOrders: 2, openOrdersUnknown: ["lighter"] });
    const lighter = (d.exchanges as Array<Record<string, unknown>>).find(e => e.exchange === "lighter");
    expect(lighter).toMatchObject({ connected: true, openOrders: null, openOrdersError: "lighter agent API key (slot 3) expired" });
  });
});
