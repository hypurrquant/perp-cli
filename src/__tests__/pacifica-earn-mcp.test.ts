/**
 * MCP: Pacifica Print / vault tools are read-only (GET only, nothing signed) and no money-moving
 * Print / vault write tool is exposed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const FX = resolve(__dirname, "fixtures/pacifica-earn");
const fixture = (n: string): unknown => JSON.parse(readFileSync(resolve(FX, n), "utf8"));
const env = (data: unknown) => ({ success: true, data });
let methods: string[];

beforeEach(async () => {
  methods = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string }) => {
    methods.push(init?.method ?? "GET");
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    const body = path === "/game/config" ? fixture("game-config.json")
      : path === "/game/accounts" ? fixture("game-accounts.json")
        : path === "/game/history_summary" ? fixture("game-history-summary-page.json")
          : path === "/info/prices" ? env([{ symbol: "BTC", mark: "70000" }])
            : path === "/info" ? env([{ symbol: "BTC", tick_size: "1" }])
              : path === "/lake/list" ? fixture("lake-list.json")
                : path === "/lake/get_deposit_whitelist" ? fixture("lake-deposit-whitelist.json")
                  : path === "/account" ? env({ account_equity: "1", available_to_withdraw: "1" })
                    : path === "/positions" ? env([])
                      : null;
    if (body === null) throw new Error(`unexpected ${path}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  if (tools.size === 0) await import("../mcp-server.js");
});

const ACC = "5E4hcGqA9FxxeWP2oaz4UBgxitEP2GjB9CkCRDtucRek";

describe("Pacifica Print / vault MCP tools", () => {
  it.each([
    ["pacifica_print_products", {}],
    ["pacifica_print_quote", { game: "BTC_24H", direction: "long", deposit: "100", strike: "69000", leverage: "10", cycles: 7 }],
    ["pacifica_print_positions", { account: ACC }],
    ["pacifica_print_positions", { account: ACC, history: true, limit: 2 }],
    ["pacifica_vaults", {}],
    ["pacifica_vaults", { vault: "The Hatch", account: ACC }],
  ])("%s %j → ok, GET only", async (name, args) => {
    const h = tools.get(name);
    expect(h).toBeDefined();
    const r = await h!(args);
    const out = JSON.parse(r.content[0].text) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(methods.every((m) => m === "GET")).toBe(true);
  });

  it("quote reports the preview fields an agent needs", async () => {
    const r = await tools.get("pacifica_print_quote")!({ game: "BTC_24H", direction: "long", deposit: "100", strike: "69000", leverage: "10" });
    expect(JSON.parse(r.content[0].text).data).toMatchObject({ maxLoss: "100", leverage: "10", docsLiquidationPrice: "62100", estimatedPremium: null });
  });

  it("an invalid quote is a structured error", async () => {
    const r = await tools.get("pacifica_print_quote")!({ game: "BTC_24H", direction: "long", deposit: "5", strike: "69000", leverage: "10" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe("INVALID_PARAMS");
  });

  it("no Print / vault write tool is exposed", () => {
    const names = [...tools.keys()].filter((n) => n.startsWith("pacifica_"));
    expect(names.sort()).toEqual(["pacifica_print_positions", "pacifica_print_products", "pacifica_print_quote", "pacifica_vaults"]);
  });
});
