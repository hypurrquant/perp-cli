/**
 * MCP options tools (read-only, keyless): get_option_expiries / get_option_chain / get_option_quote
 * return the options JSON in the {ok,data,meta} envelope; errors keep their structured code.
 * Fetch is faked with the recorded Derive responses (fixtures/derive).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "derive");
const fx = (name: string): unknown => JSON.parse(readFileSync(resolve(FIX, name), "utf-8"));
const ROUTES: Record<string, unknown> = {
  get_all_instruments: fx("get_all_instruments.ETH.json"),
  get_tickers: fx("get_tickers.ETH.20261019.json"),
  get_instrument: fx("error.instrument_not_found.json"),
  get_ticker: fx("error.ticker_not_found.json"),
};

let methods: string[];
beforeEach(async () => {
  methods = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const m = url.split("/public/")[1];
    methods.push(m);
    if (!url.startsWith("https://api.derive.xyz/v3/public/") || !(m in ROUTES)) throw new Error(`unexpected network call: ${url}`);
    return new Response(JSON.stringify(ROUTES[m]), { status: 200 });
  }));
  if (tools.size === 0) await import("../mcp-server.js");
});

const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await tools.get(tool)!(args);
  return { isError: r.isError === true, env: JSON.parse(r.content[0].text) as Record<string, unknown> & { data?: Record<string, unknown>; meta: Record<string, unknown> } };
};

describe("MCP options tools", () => {
  it("are registered", () => {
    for (const t of ["get_option_expiries", "get_option_chain", "get_option_quote"]) expect(tools.has(t)).toBe(true);
  });

  it("get_option_expiries", async () => {
    const { isError, env } = await call("get_option_expiries", { venue: "derive", underlying: "ETH" });
    expect(isError).toBe(false);
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ schema: 1, venue: "derive", underlying: "ETH" });
    expect(env.meta).toMatchObject({ venue: "derive", count: 2, network: "mainnet" });
  });

  it("get_option_chain with strikes → one get_tickers call", async () => {
    const { env } = await call("get_option_chain", { venue: "derive", underlying: "ETH", strikes: 3 });
    expect(env.ok).toBe(true);
    expect((env.data!.rows as unknown[]).length).toBe(3);
    expect(methods).toEqual(["get_all_instruments", "get_tickers"]);
  });

  it("get_option_quote unknown instrument → SYMBOL_NOT_FOUND envelope", async () => {
    const { isError, env } = await call("get_option_quote", { venue: "derive", instrument: "ETH-20261225-3333-P" });
    expect(isError).toBe(true);
    expect(env).toMatchObject({ ok: false, code: "SYMBOL_NOT_FOUND", retryable: false });
  });

  it("a non-options venue → CAPABILITY_UNSUPPORTED, zero fetch", async () => {
    const { env } = await call("get_option_expiries", { venue: "hyperliquid", underlying: "ETH" });
    expect(env).toMatchObject({ ok: false, code: "CAPABILITY_UNSUPPORTED" });
    expect(methods).toEqual([]);
  });
});
