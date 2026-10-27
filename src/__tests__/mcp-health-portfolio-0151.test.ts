/**
 * MCP vs CLI (QA 0.15.0):
 *  - health_check had `allHealthy` but no `healthy` (the CLI's `perp health --json` has both:
 *    healthy = every official-API venue up; allHealthy includes unofficial ones).
 *  - portfolio with no credentials returned totalEquity 0 — unknown is null, plus an explicit
 *    accountState "noAccount".
 */
import { describe, it, expect, vi } from "vitest";

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
const configured = vi.hoisted(() => ({ venues: [] as string[] }));
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  hasCredentials: async () => false,
  listConfiguredAccountVenues: async () => configured.venues,
}));
vi.mock("../venue-health.js", async (orig) => ({
  ...(await orig<typeof import("../venue-health.js")>()),
  probeVenueHealth: async () => ({
    probes: [
      { venue: "hyperliquid", ok: true, latencyMs: 10, status: 200, error: null, probe: "rest", apiStatus: "official" },
      // Synthetic: TxFlow relabelled unofficial to exercise the official / unofficial split (no venue is unofficial today).
      { venue: "txflow", ok: false, latencyMs: 0, status: null, error: "down", probe: "public", apiStatus: "unofficial" },
    ],
    skipped: [],
    allHealthy: false,
  }),
}));

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text) as { ok: boolean; data: Record<string, unknown> };

describe("MCP health_check", () => {
  it("carries healthy (official venues) next to allHealthy, like perp health --json", async () => {
    await import("../mcp-server.js");
    const d = parse(await tools.get("health_check")!({})).data;
    expect(d.healthy).toBe(true);
    expect(d.allHealthy).toBe(false);
  });
});

describe("MCP portfolio", () => {
  it("no credentials → totals null and accountState noAccount (was totalEquity 0)", async () => {
    await import("../mcp-server.js");
    configured.venues = [];
    const d = parse(await tools.get("portfolio")!({})).data;
    expect(d).toMatchObject({ accountState: "noAccount", totalEquity: null, totalAvailable: null, totalMarginUsed: null, totalUnrealizedPnl: null, totalsCover: [] });
    expect((d.riskMetrics as { marginUtilization: unknown }).marginUtilization).toBeNull();
  });
});
