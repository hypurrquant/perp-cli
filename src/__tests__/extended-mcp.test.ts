/**
 * MCP: every account / trading tool refuses Extended (market data only in this version, official API)
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
  ["get_balance", { exchange: "extended" }],
  ["get_positions", { exchange: "ext" }],
  ["get_open_orders", { exchange: "extended" }],
  ["trade_preview", { exchange: "extended", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false }],
  ["trade_execute", { exchange: "extended", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false }],
  ["trade_close", { exchange: "extended", symbol: "BTC" }],
  // Limit / reduce-only / leverage-bearing order paths (the MCP server has no cancel / leverage /
  // withdraw / transfer tool: those are CLI-only and covered by extended.test.ts's refusal table).
  ["trade_execute", { exchange: "extended", symbol: "BTC", side: "sell", size: "0.001", orderType: "limit", price: "90000", reduceOnly: true }],
  ["trade_preview", { exchange: "x10", symbol: "BTC", side: "buy", size: "0.001", orderType: "limit", price: "50000", reduceOnly: false }],
];

describe("MCP write / account tools refuse extended", () => {
  for (const [tool, args] of CALLS) {
    it(`${tool} → CAPABILITY_UNSUPPORTED, zero fetch`, async () => {
      const h = tools.get(tool);
      expect(h).toBeDefined();
      const r = await h!(args);
      const env = JSON.parse(r.content[0].text) as { ok: boolean; code?: string };
      expect(env.ok).toBe(false);
      expect(env.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe("MCP get_markets labels Extended's unverified funding (keyless path; Extended has no credentialed path)", () => {
  it("rows and meta carry fundingVerified false; apiStatus official; no venueApi", async () => {
    const { getVenue } = await import("../exchanges/venue.js");
    const def = getVenue("extended");
    const market = {
      venue: "extended", venueSymbol: "BTC-USD", symbol: "BTC", canonical: "BTC", assetClass: "crypto", settle: "USD", quoteAsset: "USD",
      markPrice: "81000", indexPrice: "81001", fundingRate: "0.000013", fundingRateBasis: { kind: "perHours", hours: 1 }, settlementIntervalHours: 1,
      openInterest: "1", volume24h: "1", tickSize: "1", stepSize: "0.00001", minSize: "0.0001", minNotional: null, maxLeverage: 50, marginTiers: null, session: null, tradable: true,
    };
    const spy = vi.spyOn(def.publicData, "fetchMarkets").mockResolvedValue([market as never]);
    try {
      const r = JSON.parse((await tools.get("get_markets")!({ exchange: "ext" })).content[0].text) as { ok: boolean; data: Array<Record<string, unknown>>; meta: Record<string, unknown> };
      expect(r.ok).toBe(true);
      expect(r.data).toEqual([{ ...market, fundingVerified: false }]);
      expect(r.meta).toMatchObject({ source: "public", apiStatus: "official", fundingVerified: false, fundingNote: expect.stringContaining("Extended: funding rate UNVERIFIED") });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
