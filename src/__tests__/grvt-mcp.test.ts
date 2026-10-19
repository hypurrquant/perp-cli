/**
 * MCP and GRVT: repeated `get_prices` reuse the in-process directory / tickers (no margin_rules on
 * the price path), and market-data output labels every venue whose funding is unverified
 * (`fundingVerified: false` on rows and meta) — GRVT and QFEX newly, TxFlow unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import "../exchanges/venues/index.js";
import { getVenue, listVenues } from "../exchanges/venue.js";
import { clearGrvtCaches } from "../exchanges/grvt/public.js";
import { venueMarketRow, type VenueMarket } from "../exchanges/venue-types.js";

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
// Credentials are explicit per test (never whatever the developer's HOME holds).
const hasCreds = vi.hoisted(() => vi.fn(async (_venue: string) => false));
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  hasCredentials: hasCreds,
  resolveCredentials: vi.fn(async () => ({ pk: null, owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent: null })),
}));

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "grvt");
const fx = (n: string): unknown => JSON.parse(readFileSync(resolve(FIX, n), "utf-8"));
const TICKERS = fx("tickers.json") as Record<string, unknown>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
const grvtCalls = (endpoint: string) => fetchMock.mock.calls.filter(([u]) => String(u) === `https://market-data.grvt.io/full/v1/${endpoint}`).length;

/** A minimal market row for the venues stubbed out of the test. */
const row = (venue: string, symbol: string): VenueMarket => ({
  venue: venue as VenueMarket["venue"], venueSymbol: symbol, symbol, canonical: symbol, assetClass: "crypto", settle: "USDC", quoteAsset: "USD",
  markPrice: "100", indexPrice: null, fundingRate: "0.0001", fundingRateBasis: { kind: "perHours", hours: 1 }, settlementIntervalHours: 1,
  openInterest: null, volume24h: null, tickSize: null, stepSize: null, minSize: null, minNotional: null, maxLeverage: null, marginTiers: null,
  session: null, tradable: true,
});

/** A public row as keyless get_markets returns it: VenueMarket fields + the CLI market-row shape. */
const shaped = (m: VenueMarket) => ({ ...m, ...venueMarketRow(m) });

beforeEach(async () => {
  clearGrvtCaches();
  hasCreds.mockImplementation(async () => false);
  fetchMock = vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    if (!url.startsWith("https://market-data.grvt.io/full/v1/")) throw new Error(`unexpected network call: ${url}`);
    const endpoint = url.split("/full/v1/")[1];
    const body = JSON.parse(String(init?.body ?? "{}")) as { instrument?: string };
    if (endpoint === "instruments") return json(200, fx("instruments.json"));
    if (endpoint === "ticker") return json(200, TICKERS[body.instrument!]);
    throw new Error(`unexpected GRVT endpoint ${endpoint}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  // Every other venue answers from a stub (only GRVT goes through fetch).
  for (const v of listVenues()) if (v.id !== "grvt") vi.spyOn(v.publicData, "fetchMarkets").mockResolvedValue([row(v.id, "BTC")]);
  if (tools.size === 0) await import("../mcp-server.js");
});
afterEach(() => { vi.restoreAllMocks(); });

const call = async (tool: string, args: Record<string, unknown>) => JSON.parse((await tools.get(tool)!(args)).content[0].text) as {
  ok: boolean; data: unknown; meta: Record<string, unknown>;
};

describe("MCP get_prices with GRVT", () => {
  it("three consecutive calls: one instruments read, one ticker per market, no margin_rules", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call("get_prices", { symbols: ["BTC", "ETH"] });
      expect(r.ok).toBe(true);
    }
    expect(grvtCalls("instruments")).toBe(1);
    expect(grvtCalls("ticker")).toBe(9);
    expect(grvtCalls("margin_rules")).toBe(0);
  });
});

describe("MCP get_markets labels unverified funding", () => {
  it("grvt (official, unverified): rows and meta carry fundingVerified false; apiStatus official", async () => {
    const r = await call("get_markets", { exchange: "grvt" });
    expect(r.ok).toBe(true);
    const rows = r.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(9);
    expect(rows.every(x => x.fundingVerified === false && x.venueApi === undefined)).toBe(true);
    expect(r.meta).toMatchObject({ apiStatus: "official", fundingVerified: false, fundingNote: expect.stringContaining("GRVT: funding rate UNVERIFIED") });
  });

  it("qfex gains fundingVerified false; txflow venueApi too; a verified venue states fundingVerified true", async () => {
    expect(getVenue("qfex").fundingVerified).toBe(false);
    const q = await call("get_markets", { exchange: "qfex" });
    expect((q.data as Array<Record<string, unknown>>)[0]).toEqual({ ...shaped(row("qfex", "BTC")), fundingVerified: false });
    expect(q.meta).toMatchObject({ apiStatus: "official", fundingVerified: false });

    const t = await call("get_markets", { exchange: "txflow" });
    expect((t.data as Array<Record<string, unknown>>)[0]).toEqual({ ...shaped(row("txflow", "BTC")), venueApi: "unofficial", fundingVerified: false });
    expect(t.meta).toMatchObject({ apiStatus: "unofficial", fundingVerified: false, apiNote: expect.stringContaining("UNOFFICIAL API") });
    expect(t.meta.fundingNote).toBeUndefined();

    const r = await call("get_markets", { exchange: "risex" });
    expect((r.data as Array<Record<string, unknown>>)[0]).toEqual({ ...shaped(row("risex", "BTC")), fundingVerified: true });
    expect(r.meta.fundingVerified).toBeUndefined();
  });
});

describe("MCP get_markets keyless rows: the CLI market-row shape (one mapper, venueMarketRow)", () => {
  it("every CLI market-row field is present (public row without tick / lot / leverage → null), no VenueMarket field dropped", async () => {
    const r = await call("get_markets", { exchange: "risex" });
    const first = (r.data as Array<Record<string, unknown>>)[0];
    for (const f of ["symbol", "markPrice", "indexPrice", "fundingRate", "volume24h", "openInterest", "maxLeverage", "sizeDecimals", "stepSize", "fundingHours", "marginTiers", "tradable", "status", "quoteAsset", "fundingRateKind"]) {
      expect(first, f).toHaveProperty(f);
    }
    for (const f of Object.keys(row("risex", "BTC"))) expect(first, f).toHaveProperty(f);
    expect(first).toMatchObject({ sizeDecimals: null, stepSize: null, maxLeverage: null, fundingHours: 1, fundingRateKind: "lastSettled" });
  });
});

describe("MCP get_markets through the credentialed adapter branch", () => {
  it("qfex with credentials: the adapter's rows get the same fundingVerified label; meta too", async () => {
    hasCreds.mockImplementation(async (venue: string) => venue === "qfex");
    const legacy = { symbol: "AAPL", markPrice: "250", indexPrice: null, fundingRate: "0.0001", volume24h: null, openInterest: null, maxLeverage: 10, sizeDecimals: 2, stepSize: "0.01", fundingHours: 1, marginTiers: null };
    const getMarkets = vi.fn(async () => [legacy]);
    const qfex = getVenue("qfex") as { create: (ctx: unknown) => Promise<unknown> };
    const create = vi.spyOn(qfex, "create").mockImplementation(async () => ({ name: "qfex", getMarkets }));
    const r = await call("get_markets", { exchange: "qfex" });
    expect(create).toHaveBeenCalled();
    expect(getMarkets).toHaveBeenCalled();
    expect(r.meta.source).toBeUndefined(); // adapter branch, not the public fallback
    expect(r.data).toEqual([{ ...legacy, fundingVerified: false }]);
    expect(r.meta).toMatchObject({ apiStatus: "official", fundingVerified: false, fundingNote: expect.stringContaining("UNVERIFIED") });
  });
});
