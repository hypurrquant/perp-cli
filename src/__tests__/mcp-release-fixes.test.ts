/**
 * MCP release fixes (0.14.0 audit). No network: adapter creation, TradingV2 send, the risk gate,
 * global fetch and every venue's public market read are mocked / stubbed.
 *
 *  1. trade_execute settles what placeAndConfirm RETURNS: non-final → ORDER_PENDING (executed:false,
 *     pending:true, top-level remediation, log "unverified"); final rejected / cancelled with nothing
 *     filled → ORDER_REJECTED (log "failed"); cancelled after a partial fill → executed + partial.
 *  2. an unknown outcome (thrown or returned) on an opening order quarantines the symbol, so the
 *     gate refuses an agent's resubmit; quarantine entries are network-scoped under MCP.
 *  3. trade_preview runs trade_execute's pre-send checks read-only and reports refusals.
 *  4. explain_command / suggest_command follow the real `trade stop` argument order; suggest_command
 *     defaults to settings.defaultExchange; deposit / withdraw venue lists match the command tree.
 *  5. per-venue failures land in meta.errors (no silent skip); unknown arb prices stay null; the
 *     public orderbook refuses HTTP / payload failures.
 *  6. health_check probes every registered venue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type ResourceHandler = () => Promise<{ contents: { text: string }[] }>;
const tools = new Map<string, ToolHandler>();
const resources = new Map<string, ResourceHandler>();
type PromptHandler = () => { messages: { content: { text: string } }[] };
const prompts = new Map<string, PromptHandler>();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, h: ToolHandler) { tools.set(name, h); }
    resource(name: string, _uri: string, _m: unknown, h: ResourceHandler) { resources.set(name, h); }
    prompt(name: string, _d: string, _a: unknown, h: PromptHandler) { prompts.set(name, h); }
    async connect() { /* no transport in tests */ }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));

const fakeAdapter = {
  name: "hyperliquid",
  getPositions: vi.fn(async () => [] as unknown[]),
  getBalance: vi.fn(async () => ({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" })),
  getOrderbook: vi.fn(async () => ({ bids: [["99", "1"]], asks: [["101", "1"]] })),
  getMarkets: vi.fn(async () => []),
  getFundingPayments: vi.fn(async () => [] as unknown[]),
  getTradeHistory: vi.fn(async () => [] as unknown[]),
};
const creds = { has: true };
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  hasCredentials: async () => creds.has,
  resolveCredentials: async () => ({}),
}));
vi.mock("../exchanges/venues/create-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exchanges/venues/create-helpers.js")>()),
  createHyperliquid: async () => fakeAdapter,
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
  validateTrade: vi.fn(async () => ({ valid: true, checks: [], warnings: [] })),
}));
const settingsOverride: { defaultExchange: string } = { defaultExchange: "" };
vi.mock("../settings.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../settings.js")>();
  return { ...orig, loadSettings: () => ({ ...orig.loadSettings(), defaultExchange: settingsOverride.defaultExchange }) };
});
const arbState: { positions: unknown[] } = { positions: [] };
vi.mock("../arb/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../arb/state.js")>()),
  loadArbState: () => ({ positions: arbState.positions }),
}));

// An instance that never declares its network: it sees (and clears) entries of every network.
const { clearQuarantine } = await import("../bot/quarantine.js");
const { buildProgram } = await import("../cli-program.js");

async function loadServer(network?: "testnet"): Promise<void> {
  tools.clear();
  resources.clear();
  prompts.clear();
  vi.resetModules();
  if (network === undefined) delete process.env["PERP_NETWORK"];
  else process.env["PERP_NETWORK"] = network;
  await import("../mcp-server.js");
}

type Envelope = {
  ok: boolean; code?: string; error?: string; remediation?: string; executed?: boolean; pending?: boolean;
  result?: Record<string, unknown>; meta: Record<string, unknown>; data?: Record<string, unknown>;
};
const parse = (r: { content: { text: string }[] }): Envelope => JSON.parse(r.content[0].text);

const execLog = (): Array<Record<string, unknown>> => {
  const f = resolve(process.env.HOME!, ".perp", "executions.jsonl");
  return existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const quarantineFile = (): Record<string, { symbol: string; strategy: string; network: string | null }> => {
  const f = resolve(process.env.HOME!, ".perp", "bot-quarantine.json");
  if (!existsSync(f)) return {};
  const raw = JSON.parse(readFileSync(f, "utf-8")) as { entries?: Record<string, { symbol: string; strategy: string; network: string | null }> };
  return raw.entries ?? {};
};

function placed(over: Record<string, unknown>): Record<string, unknown> {
  return {
    venue: "hyperliquid", symbol: "BTC", status: "filled", finality: "final", orderId: "1", clientOrderId: null,
    filledSize: "0.01", avgPrice: "100", venueRaw: { ok: true }, execution: null, remediation: null, ...over,
  };
}

const BUY = { exchange: "hyperliquid", symbol: "BTC", side: "buy", size: "0.01", orderType: "market", reduceOnly: false };

beforeEach(() => {
  placeAndConfirm.mockReset().mockResolvedValue(placed({}));
  enforceOrderRisk.mockReset().mockResolvedValue(undefined);
  fakeAdapter.getPositions.mockReset().mockResolvedValue([]);
  fakeAdapter.getFundingPayments.mockReset().mockResolvedValue([]);
  fakeAdapter.getTradeHistory.mockReset().mockResolvedValue([]);
  creds.has = true;
  settingsOverride.defaultExchange = "";
  arbState.positions = [];
  for (const s of ["BTC", "ETH", "SOL"]) clearQuarantine(s, null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("1. trade_execute settles the returned OrderResult", () => {
  it("non-final result → ORDER_PENDING, executed:false, pending:true, remediation at top level; logged unverified; symbol quarantined", async () => {
    await loadServer();
    placeAndConfirm.mockResolvedValue(placed({ status: "accepted", finality: "pending", filledSize: null, remediation: "Order not final after 15s — do NOT resubmit; check: perp trade status 1" }));
    const before = execLog().length;
    const r = await tools.get("trade_execute")!(BUY);
    const e = parse(r);
    expect(r.isError).toBe(true);
    expect(e).toMatchObject({ ok: false, code: "ORDER_PENDING", executed: false, pending: true });
    expect(e.remediation).toMatch(/do NOT resubmit/);
    expect(e.result).toMatchObject({ finality: "pending", status: "accepted" });
    expect(execLog().slice(before)).toEqual([expect.objectContaining({ status: "unverified", meta: expect.objectContaining({ source: "mcp" }) })]);
    expect(Object.values(quarantineFile())).toContainEqual(expect.objectContaining({ symbol: "BTC", strategy: "mcp-execute" }));

    // The agent's resubmit is refused by the gate (nothing sent a second time).
    const again = await tools.get("trade_execute")!(BUY);
    expect(parse(again).code).toBe("RISK_VIOLATION");
    expect(placeAndConfirm).toHaveBeenCalledTimes(1);
  });

  it("final cancelled with nothing filled → ORDER_REJECTED, executed:false, logged failed, no quarantine", async () => {
    await loadServer();
    placeAndConfirm.mockResolvedValue(placed({ status: "cancelled", filledSize: "0" }));
    const before = execLog().length;
    const r = await tools.get("trade_execute")!(BUY);
    expect(parse(r)).toMatchObject({ ok: false, code: "ORDER_REJECTED", executed: false });
    expect(execLog().slice(before)).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(Object.values(quarantineFile()).filter((q) => q.symbol === "BTC")).toEqual([]);
  });

  it("final rejected → ORDER_REJECTED", async () => {
    await loadServer();
    placeAndConfirm.mockResolvedValue(placed({ status: "rejected", filledSize: null }));
    expect(parse(await tools.get("trade_execute")!(BUY))).toMatchObject({ ok: false, code: "ORDER_REJECTED" });
  });

  it("final cancelled with an unreported fill → ORDER_PENDING (the fill is unknown)", async () => {
    await loadServer();
    placeAndConfirm.mockResolvedValue(placed({ status: "cancelled", filledSize: null }));
    expect(parse(await tools.get("trade_execute")!(BUY))).toMatchObject({ ok: false, code: "ORDER_PENDING", pending: true });
  });

  it("cancelled after a partial fill → executed with the real filledSize, partial:true (never reported as full)", async () => {
    await loadServer();
    placeAndConfirm.mockResolvedValue(placed({ status: "cancelled", filledSize: "0.004" }));
    const before = execLog().length;
    const r = await tools.get("trade_execute")!(BUY);
    const e = parse(r);
    expect(e.ok).toBe(true);
    expect(e.data).toMatchObject({ executed: true, partial: true, filledSize: "0.004", requestedSize: "0.01" });
    expect(String(e.data!.warning)).toMatch(/Partially filled: 0\.004 of 0\.01/);
    expect(execLog().slice(before)).toEqual([expect.objectContaining({ status: "success", size: "0.004", meta: expect.objectContaining({ partial: true, requested: "0.01" }) })]);
  });

  it("final filled → executed, partial:false", async () => {
    await loadServer();
    const e = parse(await tools.get("trade_execute")!(BUY));
    expect(e.data).toMatchObject({ executed: true, partial: false, filledSize: "0.01" });
  });
});

describe("2. trade_execute quarantines on a thrown unknown outcome", () => {
  it("transport failure after send (opening order) → ORDER_PENDING + pending:true + quarantine; resubmit refused", async () => {
    await loadServer();
    placeAndConfirm.mockRejectedValue(new Error("socket hang up"));
    const e = parse(await tools.get("trade_execute")!({ ...BUY, symbol: "ETH" }));
    expect(e).toMatchObject({ code: "ORDER_PENDING", executed: false, pending: true });
    expect(Object.values(quarantineFile())).toContainEqual(expect.objectContaining({ symbol: "ETH", strategy: "mcp-execute", network: "mainnet" }));
    expect(parse(await tools.get("trade_execute")!({ ...BUY, symbol: "ETH" })).code).toBe("RISK_VIOLATION");
    expect(placeAndConfirm).toHaveBeenCalledTimes(1);
  });

  it("a reduce-only order with an unknown outcome is not quarantined (it cannot open exposure)", async () => {
    await loadServer();
    placeAndConfirm.mockRejectedValue(new Error("socket hang up"));
    const e = parse(await tools.get("trade_execute")!({ ...BUY, symbol: "SOL", side: "sell", reduceOnly: true }));
    expect(e.code).toBe("ORDER_PENDING");
    expect(Object.values(quarantineFile()).filter((q) => q.symbol === "SOL")).toEqual([]);
  });

  it("a definite failure is not quarantined and says executed:false", async () => {
    await loadServer();
    const { PerpError } = await import("../errors.js");
    placeAndConfirm.mockRejectedValue(new PerpError("ORDER_REJECTED", "venue rejected: size below minimum"));
    const e = parse(await tools.get("trade_execute")!(BUY));
    expect(e).toMatchObject({ code: "ORDER_REJECTED", executed: false });
    expect(e.pending).toBeUndefined();
    expect(Object.values(quarantineFile()).filter((q) => q.symbol === "BTC")).toEqual([]);
  });
});

describe("2b. network-scoped quarantine under MCP", () => {
  it("a testnet server writes testnet-tagged entries; a mainnet server is not blocked by them", async () => {
    await loadServer("testnet");
    placeAndConfirm.mockRejectedValueOnce(new Error("socket hang up"));
    expect(parse(await tools.get("trade_execute")!(BUY)).code).toBe("ORDER_PENDING");
    expect(Object.values(quarantineFile())).toContainEqual(expect.objectContaining({ symbol: "BTC", strategy: "mcp-execute", network: "testnet" }));
    expect(parse(await tools.get("trade_execute")!(BUY)).code).toBe("RISK_VIOLATION");

    await loadServer();
    const r = await tools.get("trade_execute")!(BUY);
    expect(parse(r).ok).toBe(true);
    expect(parse(r).meta.network).toBe("mainnet");
  });

  it("a mainnet-only entry does not block the testnet server", async () => {
    await loadServer();
    const q = await import("../bot/quarantine.js"); // the mainnet server's instance (network declared)
    q.quarantineSymbol("test", "ETH", "mainnet unknown outcome", "check ETH", () => {});
    expect(Object.values(quarantineFile())).toContainEqual(expect.objectContaining({ symbol: "ETH", network: "mainnet" }));
    expect(parse(await tools.get("trade_execute")!({ ...BUY, symbol: "ETH" })).code).toBe("RISK_VIOLATION");

    await loadServer("testnet");
    const r = await tools.get("trade_execute")!({ ...BUY, symbol: "ETH" });
    expect(parse(r).ok).toBe(true);
    expect(parse(r).meta.network).toBe("testnet");
  });
});

describe("3. trade_preview runs the pre-send checks read-only", () => {
  it("quarantined symbol → valid:false with RISK_VIOLATION + remediation; reduce-only passes the quarantine", async () => {
    await loadServer();
    const q = await import("../bot/quarantine.js");
    q.quarantineSymbol("test", "BTC", "unknown outcome", "check BTC", () => {});
    const d = parse(await tools.get("trade_preview")!(BUY)).data!;
    expect(d.valid).toBe(false);
    expect(d.refusals).toEqual([expect.objectContaining({ check: "gate", code: "RISK_VIOLATION", remediation: expect.stringMatching(/quarantine-clear BTC/) })]);
    const ro = parse(await tools.get("trade_preview")!({ ...BUY, side: "sell", reduceOnly: true })).data!;
    expect(ro.refusals).toEqual([]);
    expect(ro.valid).toBe(true);
    expect(placeAndConfirm).not.toHaveBeenCalled();
  });

  it("risk violation → valid:false with the gate's code; the gate ran with force:false and the requested reduceOnly", async () => {
    await loadServer();
    const { PerpError } = await import("../errors.js");
    enforceOrderRisk.mockRejectedValue(new PerpError("RISK_VIOLATION", "Order blocked by local risk limits", { remediation: "perp risk limits" }));
    const d = parse(await tools.get("trade_preview")!(BUY)).data!;
    expect(d.valid).toBe(false);
    expect(d.refusals).toEqual([expect.objectContaining({ check: "gate", code: "RISK_VIOLATION", remediation: "perp risk limits" })]);
    expect(enforceOrderRisk.mock.calls[0][1]).toMatchObject({ symbol: "BTC", force: false, reduceOnly: false });
  });

  it("order validation refusals (bad TIF, limit without price) are reported with their code", async () => {
    await loadServer();
    const tifBad = parse(await tools.get("trade_preview")!({ ...BUY, orderType: "limit", price: "100", tif: "NOPE" })).data!;
    expect(tifBad.valid).toBe(false);
    expect(tifBad.refusals).toContainEqual(expect.objectContaining({ check: "order", code: expect.any(String), message: expect.stringMatching(/NOPE|tif|TIF/i) }));
    const noPrice = parse(await tools.get("trade_preview")!({ ...BUY, orderType: "limit" })).data!;
    expect(noPrice.refusals).toContainEqual(expect.objectContaining({ check: "order", code: "INVALID_PARAMS" }));
  });

  it("unparseable size → valid:false (size refusal), notional unknown (null), nothing checked as if it were 0", async () => {
    await loadServer();
    const d = parse(await tools.get("trade_preview")!({ ...BUY, size: "1,000" })).data!;
    expect(d.valid).toBe(false);
    expect(d.refusals).toEqual([expect.objectContaining({ check: "size", code: "INVALID_PARAMS" })]);
    expect((d.estimate as Record<string, unknown>).notionalUsd).toBeNull();
    expect(enforceOrderRisk).not.toHaveBeenCalled();
  });

  it("a clean order → valid:true, no refusals", async () => {
    await loadServer();
    const d = parse(await tools.get("trade_preview")!(BUY)).data!;
    expect(d).toMatchObject({ valid: true, refusals: [] });
  });
});

describe("4. command templates follow the real argument order", () => {
  const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
  const trade = program.commands.find((c) => c.name() === "trade")!;

  it("explain_command lists positional parameters in the commander order for every explained trade subcommand", async () => {
    await loadServer();
    const subs = ["market", "limit", "stop", "twap", "edit", "check", "reduce", "leverage", "cancel", "tpsl", "close", "scale-in"];
    for (const sub of subs) {
      const cmd = trade.commands.find((c) => c.name() === sub)!;
      const declared = cmd.registeredArguments.map((a) => a.name());
      const line = `perp trade ${sub} ${declared.map((n) => `v_${n}`).join(" ")}`;
      const d = parse(await tools.get("explain_command")!({ command: line })).data!;
      const params = (d.parameters as { name: string; value?: string }[]).filter((p) => !p.name.startsWith("--"));
      const names = params.map((p) => (p.name === "symbol" && declared[0] === "symbolOrOrderId" ? "symbolOrOrderId" : p.name));
      expect({ sub, names }).toEqual({ sub, names: declared });
      // Each parameter's value is the token at its own position.
      expect({ sub, values: params.map((p) => p.value) }).toEqual({ sub, values: declared.map((n) => `v_${n}`) });
    }
  });

  it("explain_command: trade stop <symbol> <side> <size> <stopPrice>", async () => {
    await loadServer();
    const d = parse(await tools.get("explain_command")!({ command: "perp trade stop BTC sell 0.1 50000" })).data!;
    expect(d.parameters).toEqual([
      expect.objectContaining({ name: "symbol", value: "BTC" }),
      expect.objectContaining({ name: "side", value: "sell" }),
      expect.objectContaining({ name: "size", value: "0.1" }),
      expect.objectContaining({ name: "stopPrice", value: "50000" }),
    ]);
  });

  it("suggest_command stop: size before stopPrice", async () => {
    await loadServer();
    const d = parse(await tools.get("suggest_command")!({ goal: "set a stop loss on BTC", exchange: "hyperliquid" })).data!;
    const cmds = (d.steps as { command: string }[]).map((s) => s.command);
    expect(cmds).toContain("perp -e hyperliquid --json trade stop BTC <side> <size> <stopPrice>");
  });
});

describe("4b/6. suggest_command defaults and fund routes", () => {
  it("default exchange = settings.defaultExchange (aliases resolved); unset → pacifica like the CLI's -e", async () => {
    await loadServer();
    settingsOverride.defaultExchange = "hl";
    expect(parse(await tools.get("suggest_command")!({ goal: "portfolio overview" })).data!.exchange).toBe("hyperliquid");
    settingsOverride.defaultExchange = "";
    expect(parse(await tools.get("suggest_command")!({ goal: "portfolio overview" })).data!.exchange).toBe("pacifica");
    const bad = await tools.get("suggest_command")!({ goal: "portfolio", exchange: "nope" });
    expect(bad.isError).toBe(true);
  });

  it("lighter deposit takes a route; a venue without a CLI deposit gets funds info, not a broken command", async () => {
    await loadServer();
    const lt = parse(await tools.get("suggest_command")!({ goal: "deposit 100", exchange: "lighter" })).data!;
    expect((lt.steps as { command: string }[]).map((s) => s.command)).toContain("perp --json funds deposit lighter ethereum 100");
    const ar = parse(await tools.get("suggest_command")!({ goal: "deposit 100", exchange: "arcus" })).data!;
    expect((ar.steps as { command: string }[]).map((s) => s.command)).toContain("perp --json funds info");
    expect(JSON.stringify(ar.steps)).not.toMatch(/funds deposit arcus/);
  });

  it("MCP deposit / withdraw venue lists equal the real funds deposit / withdraw subcommands", async () => {
    await loadServer();
    const mod = await import("../mcp-server.js");
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    const funds = program.commands.find((c) => c.name() === "funds")!;
    const venueSubs = (n: string) => funds.commands.find((c) => c.name() === n)!.commands.map((c) => c.name());
    const { listVenues } = await import("../exchanges/venue.js");
    const ids = new Set(listVenues().map((v) => v.id as string));
    // Refusing deposit subcommands (RISEx: app-only funds; TxFlow / Variational / GRVT / Extended: market data only) are not MCP routes.
    const refusingDeposit = new Set(["risex", "txflow", "variational", "grvt", "extended"]);
    expect([...mod.MCP_DEPOSIT_VENUES].sort()).toEqual(venueSubs("deposit").filter((n) => ids.has(n) && !refusingDeposit.has(n)).sort());
    // A venue that declares no withdraw asset (Ondo: API cannot withdraw; QFEX: switched off) keeps
    // a refusing subcommand but is not an MCP route.
    const { getVenue } = await import("../exchanges/venue.js");
    const withdrawable = (n: string) => (getVenue(n).capabilities?.withdrawAssets ?? null) !== null;
    expect([...mod.MCP_WITHDRAW_VENUES].sort()).toEqual(venueSubs("withdraw").filter((n) => ids.has(n) && withdrawable(n)).sort());
  });
});

describe("5. no silent per-venue skips", () => {
  it("get_funding_analysis / get_pnl_analysis: a failing venue is reported in meta.errors", async () => {
    await loadServer();
    fakeAdapter.getFundingPayments.mockRejectedValue(new Error("funding endpoint 503"));
    const f = parse(await tools.get("get_funding_analysis")!({ period: "30d", exchange: "hyperliquid" }));
    expect(f.ok).toBe(true);
    expect(f.meta.errors).toEqual({ hyperliquid: expect.stringMatching(/funding endpoint 503/) });
    const p = parse(await tools.get("get_pnl_analysis")!({ period: "30d", exchange: "hyperliquid" }));
    expect(p.meta.errors).toEqual({ hyperliquid: expect.stringMatching(/funding endpoint 503/) });
  });

  it("get_arb_compare: failed venue reads → funding / pricePnl / totals null (never the entry price), reason in meta.errors", async () => {
    await loadServer();
    arbState.positions = [{
      id: "a", symbol: "BTC", longExchange: "hyperliquid", shortExchange: "hyperliquid", longSize: 1, shortSize: 1,
      entryTime: new Date(Date.now() - 86_400_000).toISOString(), entrySpread: 10, entryLongPrice: 100, entryShortPrice: 101,
      accumulatedFunding: 0, lastCheckTime: new Date().toISOString(),
    }];
    fakeAdapter.getFundingPayments.mockRejectedValue(new Error("venue down"));
    const e = parse(await tools.get("get_arb_compare")!({ period: "all" }));
    expect(e.meta.errors).toEqual({ hyperliquid: expect.stringMatching(/venue down/) });
    const row = (e.data!.positions as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ funding: null, pricePnl: null, totalPnl: null, roi: null, annualizedRoi: null });
    expect(e.data!.totals).toEqual({ funding: null, pricePnl: null, totalPnl: null });
  });

  it("get_arb_compare: venue answered but no live leg → price PnL unknown (null), funding known", async () => {
    await loadServer();
    arbState.positions = [{
      id: "a", symbol: "BTC", longExchange: "hyperliquid", shortExchange: "hyperliquid", longSize: 1, shortSize: 1,
      entryTime: new Date().toISOString(), entrySpread: 10, entryLongPrice: 100, entryShortPrice: 101,
      accumulatedFunding: 0, lastCheckTime: new Date().toISOString(),
    }];
    const e = parse(await tools.get("get_arb_compare")!({ period: "all" }));
    expect(e.meta.errors).toEqual({});
    expect((e.data!.positions as Record<string, unknown>[])[0]).toMatchObject({ funding: 0, pricePnl: null, totalPnl: null });
  });

  it("market://prices resource: per-venue failures in meta.errors", async () => {
    await loadServer();
    const { listVenuesWithRole } = await import("../exchanges/venue.js");
    const venues = listVenuesWithRole("marketData");
    for (const v of venues) vi.spyOn(v.publicData, "fetchMarkets").mockRejectedValue(new Error(`${v.id} offline`));
    const out = JSON.parse((await resources.get("market_prices")!()).contents[0].text) as { meta: { errors: Record<string, string> } };
    expect(Object.keys(out.meta.errors).sort()).toEqual(venues.map((v) => v.id).sort());
  });

  it("public orderbook (no credentials): HTTP error → EXCHANGE_ERROR; null body → SYMBOL_NOT_FOUND; bad payload → EXCHANGE_ERROR (never an empty book)", async () => {
    await loadServer();
    creds.has = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const http = parse(await tools.get("get_orderbook")!({ exchange: "hyperliquid", symbol: "BTC" }));
    expect(http).toMatchObject({ ok: false, code: "EXCHANGE_ERROR" });
    expect(http.meta.exchange).toBe("hyperliquid");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 200 })));
    expect(parse(await tools.get("get_orderbook")!({ exchange: "hyperliquid", symbol: "NOPE" }))).toMatchObject({ ok: false, code: "SYMBOL_NOT_FOUND" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ coin: "BTC" }), { status: 200 })));
    expect(parse(await tools.get("get_orderbook")!({ exchange: "hyperliquid", symbol: "BTC" }))).toMatchObject({ ok: false, code: "EXCHANGE_ERROR" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ levels: [[{ px: "99", sz: "1" }], [{ px: "101", sz: "2" }]] }), { status: 200 })));
    const okBook = parse(await tools.get("get_orderbook")!({ exchange: "hyperliquid", symbol: "BTC" }));
    expect(okBook.data).toEqual({ bids: [["99", "1"]], asks: [["101", "2"]] });
  });
});

describe("6. health_check covers every registered venue", () => {
  it("reports one probe per venue (covered = registry) with the failure reason", async () => {
    await loadServer();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { listVenues } = await import("../exchanges/venue.js");
    for (const v of listVenues()) vi.spyOn(v.publicData, "fetchMarkets").mockRejectedValue(new Error(`${v.id} offline`));
    const d = parse(await tools.get("health_check")!({})).data!;
    const ids = listVenues().map((v) => v.id);
    expect(d.covered).toEqual(ids);
    expect(d.allHealthy).toBe(false);
    for (const id of ids) expect(d[id]).toMatchObject({ ok: false, error: expect.any(String), statusText: "unreachable" });
  });
});

describe("6b. model-facing text", () => {
  it("trading-guide lists every registered venue and the HIP-3 scope", async () => {
    await loadServer();
    const { listVenues } = await import("../exchanges/venue.js");
    const text = prompts.get("trading-guide")!().messages[0].content.text;
    for (const v of listVenues()) expect(text).toContain(`**${v.id}**`);
    expect(text).toMatch(/native perps only \(HIP-3 dexes via the CLI --dex\)/);
    expect(text).not.toMatch(/estimated price, fees/);
  });
});
