/**
 * Public-address positions (0.15.1): `account positions --address`, MCP get_positions_by_address.
 *  - Lighter: every account of the address (sub-accounts), rows tagged accountIndex; the venue's
 *    zero-size rows are dropped; --account-index narrows; an address without an account is empty.
 *  - Hyperliquid: native + every HIP-3 dex (one request each); a failing dex (or dex list) is an
 *    error entry + warning, its rows missing — the other rows are kept.
 *  - The keyed getPositions and the public read share one row mapper.
 *  - Without -e: every supporting venue; a venue that fails (address format) is an errors entry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

import "../exchanges/venues/index.js";
import { fetchPositionsByAddress, listPublicPositionVenues } from "../exchanges/venue.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hlPositionRows } from "../exchanges/hyperliquid.js";
import { lighterPositionRows } from "../exchanges/lighter.js";
import { readPositionsByAddressAll } from "../positions-by-address.js";
import { runCli } from "./conformance/harness.js";

const ADDR = "0x00000000000000000000000000000000000a0001";

const lighterPos = (symbol: string, position: string, extra: Record<string, unknown> = {}) => ({
  market_id: symbol === "ETH" ? 0 : 1, symbol, initial_margin_fraction: "20.00", sign: 1, position,
  avg_entry_price: position === "0" ? "0" : "2000.5", position_value: position === "0" ? "0" : String(Number(position) * 2001.25),
  unrealized_pnl: "1.5", liquidation_price: "0", margin_mode: 0, ...extra,
});
const LIGHTER_ACCOUNTS = {
  code: 200, total: 2,
  accounts: [
    // main account: only zero-size rows (markets it once traded)
    { account_index: 700, account_type: 0, positions: [lighterPos("ETH", "0"), lighterPos("BTC", "0.0000")] },
    // sub-account: one open ETH short, one zero row
    { account_index: 701, account_type: 1, positions: [lighterPos("ETH", "1.5", { sign: -1 }), lighterPos("BTC", "0")] },
  ],
};
const ORDER_BOOKS = { code: 200, order_books: [{ symbol: "ETH", market_id: 0, market_type: "perp", supported_price_decimals: 2, supported_size_decimals: 4 }] };

const hlState = (rows: Array<{ coin: string; szi: string }>) => ({
  marginSummary: {}, assetPositions: rows.map(r => ({ type: "oneWay", position: {
    coin: r.coin, szi: r.szi, entryPx: "100.5", positionValue: String(Math.abs(Number(r.szi)) * 101), unrealizedPnl: "0.5",
    liquidationPx: null, leverage: { type: "cross", value: 3 },
  } })),
});

/** Route stubbed fetches; `routes` keys match a URL substring or an info `type`/`dex`. */
function stubFetch(route: (url: string, body: Record<string, unknown> | null) => Response | null): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (u: unknown, init?: { body?: unknown }) => {
    const url = String(u);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    const r = route(url, body);
    if (r === null) throw new Error(`unexpected request ${url} ${init?.body ?? ""}`);
    return r;
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Lighter: sub-accounts and zero-size rows", () => {
  const route = (url: string) => (url.includes("/account?by=l1_address") ? json(LIGHTER_ACCOUNTS) : url.includes("/orderBooks") ? json(ORDER_BOOKS) : null);

  it("every account of the address; zero-size rows dropped; rows tagged accountIndex; mark at the market's price decimals", async () => {
    stubFetch(route);
    const r = await fetchPositionsByAddress("lighter", "mainnet", ADDR);
    expect(r.positions).toEqual([{
      symbol: "ETH", side: "short", size: "1.5", entryPrice: "2000.5", markPrice: "2001.25", liquidationPrice: null,
      unrealizedPnl: "1.5", leverage: 5, marginMode: "cross", accountIndex: 701,
    }]);
    expect(r.errors).toEqual({});
  });

  it("--account-index narrows to one account; an index the address does not own is INVALID_PARAMS listing its accounts", async () => {
    const f = stubFetch(route);
    expect((await fetchPositionsByAddress("lighter", "mainnet", ADDR, { accountIndex: 700 })).positions).toEqual([]);
    // the main account has no open position: no price-decimals read
    expect(f.mock.calls.filter(c => String(c[0]).includes("/orderBooks"))).toHaveLength(0);
    await expect(fetchPositionsByAddress("lighter", "mainnet", ADDR, { accountIndex: 5 })).rejects.toMatchObject({
      structured: { code: "INVALID_PARAMS", message: expect.stringContaining("700, 701") },
    });
  });

  it("an address without a Lighter account (HTTP 400 code 21100) is an empty answer with a note", async () => {
    stubFetch(url => (url.includes("/account?by=l1_address") ? json({ code: 21100, message: "account not found" }, 400) : null));
    const r = await fetchPositionsByAddress("lighter-rh", "mainnet", ADDR);
    expect(r).toEqual({ positions: [], errors: {}, notes: ["no Lighter RH account for this address"] });
  });

  it("keyed and public rows come from the same mapper (lighterPositionRows)", () => {
    const keyed = lighterPositionRows(LIGHTER_ACCOUNTS.accounts[1].positions, "lighter", s => (s === "ETH" ? 2 : undefined));
    expect(keyed).toEqual([expect.objectContaining({ symbol: "ETH", markPrice: "2001.25", size: "1.5" })]);
  });
});

describe("Hyperliquid: native + every HIP-3 dex", () => {
  const route = (failing: Set<string>, dexListFails = false) => (url: string, body: Record<string, unknown> | null): Response | null => {
    if (!url.endsWith("/info") || body === null) return null;
    if (body.type === "perpDexs") return dexListFails ? json({ error: "boom" }, 500) : json([null, { name: "xyz" }, { name: "flx" }]);
    if (body.type !== "clearinghouseState") return null;
    if (body.dex === undefined) return json(hlState([{ coin: "BTC", szi: "-0.5" }, { coin: "ETH", szi: "0.0" }]));
    if (failing.has(String(body.dex))) return json({ error: "dex down" }, 500);
    return json(hlState(body.dex === "xyz" ? [{ coin: "xyz:GOLD", szi: "2" }] : []));
  };

  it("rows of every dex, tagged dex (null = native); HIP-3 symbols keep the dex prefix; szi 0 dropped", async () => {
    const f = stubFetch(route(new Set()));
    const r = await fetchPositionsByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.positions.map(p => [p.symbol, p.side, p.dex])).toEqual([["BTC", "short", null], ["xyz:GOLD", "long", "xyz"]]);
    expect(r.errors).toEqual({});
    // one request per dex: native + perpDexs + 2 dexes
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("one dex failing: its error is listed, the other rows are kept; the CLI says so in meta.warnings / meta.errors", async () => {
    stubFetch(route(new Set(["flx"])));
    const r = await fetchPositionsByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.positions.map(p => p.symbol)).toEqual(["BTC", "xyz:GOLD"]);
    expect(Object.keys(r.errors)).toEqual(["hip3:flx"]);
    const run = await runCli(["-e", "hyperliquid", "account", "positions", "--address", ADDR]);
    expect(run.envelope.ok).toBe(true);
    expect((run.envelope.data as unknown[]).length).toBe(2);
    expect(run.envelope.meta?.warnings).toEqual([expect.stringMatching(/^hyperliquid hip3:flx unavailable .*missing from this answer$/)]);
    expect(Object.keys(run.envelope.meta?.errors as object)).toEqual(["hip3:flx"]);
  });

  it("the dex list failing: native rows kept, errors.hip3 set", async () => {
    stubFetch(route(new Set(), true));
    const r = await fetchPositionsByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.positions.map(p => p.symbol)).toEqual(["BTC"]);
    expect(Object.keys(r.errors)).toEqual(["hip3"]);
  });

  it("the native read failing fails the venue (never an empty answer)", async () => {
    stubFetch((url, body) => (body?.type === "clearinghouseState" && body.dex === undefined ? json({ error: "down" }, 500) : route(new Set())(url, body)));
    await expect(fetchPositionsByAddress("hyperliquid", "mainnet", ADDR)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR", message: expect.stringContaining("HTTP 500") } });
  });

  it("keyed and public rows come from the same mapper (hlPositionRows): only the symbol naming differs", () => {
    const state = hlState([{ coin: "BTC", szi: "-0.5" }]);
    const pub = hlPositionRows(state, c => c);
    const keyed = hlPositionRows(state, c => `${c}-PERP`);
    expect(pub).toEqual(keyed.map(r => ({ ...r, symbol: "BTC" })));
  });

  it("--symbol filters by plain asset (GOLD matches xyz:GOLD)", async () => {
    stubFetch(route(new Set()));
    const run = await runCli(["-e", "hyperliquid", "account", "positions", "--address", ADDR, "--symbol", "gold"]);
    expect((run.envelope.data as Array<{ symbol: string }>).map(p => p.symbol)).toEqual(["xyz:GOLD"]);
  });
});

describe("fan-out without -e, and the MCP tool", () => {
  const route = (url: string, body: Record<string, unknown> | null): Response | null => {
    if (url.endsWith("/info") && body?.type === "perpDexs") return json([null]);
    if (url.endsWith("/info") && body?.type === "clearinghouseState") return json(hlState([{ coin: "SOL", szi: "3" }]));
    if (url.includes("/account?by=l1_address")) return json({ code: 21100, message: "account not found" }, 400);
    if (url.includes("/v1/portfolio/details")) return json({ data: { summary: {}, positions: [] } });
    return null;
  };

  it("every supporting venue; an address of the wrong format for a venue is that venue's INVALID_PARAMS entry", async () => {
    stubFetch(route);
    const r = await readPositionsByAddressAll("mainnet", ADDR);
    expect(Object.keys(r.venues).sort()).toEqual(["hyperliquid", "lighter", "lighter-rh", "risex"]);
    expect(r.venues.hyperliquid.map(p => p.symbol)).toEqual(["SOL"]);
    expect(r.errors.pacifica?.code).toBe("INVALID_PARAMS");
    expect(r.notes.lighter).toEqual(["no Lighter account for this address"]);
    const run = await runCli(["account", "positions", "--address", ADDR]);
    expect(run.envelope.ok).toBe(true);
    expect((run.envelope.data as { venues: Record<string, unknown[]> }).venues.hyperliquid).toHaveLength(1);
    expect(run.envelope.meta).toMatchObject({ address: ADDR, source: "public" });
  });

  it("MCP get_positions_by_address: rows + meta; unsupported venue → CAPABILITY_UNSUPPORTED (isError), nothing sent", async () => {
    const f = stubFetch(route);
    if (tools.size === 0) await import("../mcp-server.js");
    const ok = await tools.get("get_positions_by_address")!({ exchange: "hl", address: ADDR });
    const env = JSON.parse(ok.content[0].text) as { ok: boolean; data: Array<{ symbol: string; dex: string | null }>; meta: Record<string, unknown> };
    expect(env.ok).toBe(true);
    expect(env.data).toEqual([expect.objectContaining({ symbol: "SOL", dex: null })]);
    expect(env.meta).toMatchObject({ exchange: "hyperliquid", address: ADDR, source: "public", count: 1 });
    f.mockClear();
    const no = await tools.get("get_positions_by_address")!({ exchange: "aster", address: ADDR });
    expect(no.isError).toBe(true);
    expect(JSON.parse(no.content[0].text).code).toBe("CAPABILITY_UNSUPPORTED");
    expect(f).not.toHaveBeenCalled();
  });

  it("--account-index / --symbol without --address are INVALID_PARAMS", async () => {
    stubFetch(() => null);
    const run = await runCli(["-e", "lighter", "account", "positions", "--account-index", "1"]);
    expect(run.envelope.error?.code).toBe("INVALID_PARAMS");
  });
});

describe("docs follow the registry", () => {
  it("docs/venues.md support matrix: the --address column is ✅ exactly for the supporting venues", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../../docs/venues.md"), "utf8").split("\n");
    const header = readme.find(l => l.startsWith("| Venue | Market data (CLI) |"))!.split("|").map(c => c.trim());
    const col = header.findIndex(c => c.startsWith("Positions by address"));
    expect(col).toBeGreaterThan(0);
    const start = readme.indexOf(readme.find(l => l.startsWith("| Venue | Market data (CLI) |"))!) + 2;
    const rows = readme.slice(start).filter((l, i, a) => a.slice(0, i + 1).every(x => x.startsWith("|"))).map(l => l.split("|").map(c => c.trim()));
    const yes = rows.filter(r => r[col].startsWith("✅")).map(r => r[1].split(" (")[0]).sort();
    expect(yes).toEqual(listPublicPositionVenues().map(v => v.displayName).sort());
  });
});
