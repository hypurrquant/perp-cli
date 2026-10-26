/**
 * Public-address balances: `account balance --address`, MCP get_balance_by_address.
 *  - Hyperliquid: the equity source follows the account's abstraction mode exactly as the keyed
 *    getBalance (one function, hlBalanceOf); spot rows from spotClearinghouseState; HIP-3 dexes with
 *    a non-zero account value; a failing dex is an error entry + warning (unknown, not zero); the
 *    per-dex fan-out is paced (concurrency cap + token bucket).
 *  - Lighter: one row per account of the address (balance + spot assets), --account-index narrows,
 *    no account → empty + note.
 *  - Pacifica: the keyed balance with its extras + spot_balances; RISEx: summary, spot null.
 *  - Refusals before I/O; `account balance` without --address keeps the rename error.
 *  - Without -e: every supporting venue; CLI ⇄ MCP same data.
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
import { fetchBalanceByAddress, listPublicBalanceVenues, listPublicPositionVenues, listVenues } from "../exchanges/venue.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { HL_DEX_FANOUT_BURST, HL_DEX_FANOUT_CONCURRENCY, hlDexFanOut } from "../exchanges/public-positions.js";
import { readBalanceByAddress, readBalanceByAddressAll } from "../balance-by-address.js";
import { runCli } from "./conformance/harness.js";
import { BalanceByAddress, issues } from "./conformance/contracts.js";

const ADDR = "0x00000000000000000000000000000000000b0001";
const SOL_ADDR = "So11111111111111111111111111111111111111112";

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
const infoTypes = (f: ReturnType<typeof vi.fn>): string[] => f.mock.calls.map(c => {
  const b = (c[1] as { body?: string } | undefined)?.body;
  return b === undefined ? String(c[0]) : String((JSON.parse(b) as { type: string; dex?: string }).type) + ((JSON.parse(b) as { dex?: string }).dex !== undefined ? `:${(JSON.parse(b) as { dex: string }).dex}` : "");
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

// ── Hyperliquid ──

const hlChs = (accountValue: string, withdrawable: string, marginUsed: string, upnls: string[]) => ({
  marginSummary: { accountValue, totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: marginUsed },
  crossMarginSummary: { accountValue, totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: marginUsed },
  withdrawable,
  assetPositions: upnls.map((u, i) => ({ type: "oneWay", position: { coin: `C${i}`, szi: "1.0", entryPx: "1", positionValue: "1", unrealizedPnl: u, liquidationPx: null, leverage: { type: "cross", value: 3 } } })),
});
const HL_SPOT = { balances: [
  { coin: "USDC", token: 0, total: "1737.36042112", hold: "724.975946", entryNtl: "0.0" },
  { coin: "HYPE", token: 150, total: "0.00646473", hold: "0.0", entryNtl: "0.55639488" },
] };

function hlRoute(opts: { mode: string; dexes?: string[]; failingDex?: Set<string>; dexListFails?: boolean; dexValue?: Record<string, string> }) {
  return (url: string, body: Record<string, unknown> | null): Response | null => {
    if (!url.endsWith("/info") || body === null) return null;
    switch (body.type) {
      case "userAbstraction": return json(opts.mode);
      case "spotClearinghouseState": return json(HL_SPOT);
      case "meta": return json({ universe: [], collateralToken: 0 });
      case "perpDexs": return opts.dexListFails ? json({ error: "boom" }, 500) : json([null, ...(opts.dexes ?? []).map(name => ({ name }))]);
      case "clearinghouseState": {
        if (body.dex === undefined) return json(hlChs("568.566325", "0.0", "724.975946", ["8.12555", "-968.4758"]));
        const dex = String(body.dex);
        if (opts.failingDex?.has(dex)) return json({ error: "dex down" }, 500);
        const v = opts.dexValue?.[dex] ?? "0.0";
        return json(hlChs(v, v, "0.0", []));
      }
      default: return null;
    }
  };
}

describe("Hyperliquid: the equity source follows the abstraction mode (keyed getBalance math)", () => {
  it("unified: equity / available are the spot USDC row (total, total − hold); perp accountValue not added; accountMode + a note say so", async () => {
    stubFetch(hlRoute({ mode: "unifiedAccount" }));
    const r = await fetchBalanceByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.balance).toEqual({ equity: "1737.36042112", available: String(1737.36042112 - 724.975946), marginUsed: "724.975946", unrealizedPnl: String(8.12555 - 968.4758) });
    expect(r.accountMode).toBe("unified");
    expect(r.notes).toEqual([expect.stringMatching(/^account mode unified: .*already moves with perp PnL.*clearinghouse \(accountValue 568\.566325, withdrawable 0\.0\) is a per-dex view and is not added$/)]);
  });

  // Live shape of a portfolio-margin account (2026-10-26, 0x157a…): borrowed USDC, HYPE collateral.
  it("portfolio margin: equity = USDC total + HYPE × spot price; collateral rows priced and marked shared; ratio surfaced", async () => {
    const pm = { portfolioMarginRatio: "0.517", balances: [
      { coin: "USDC", token: 0, total: "-18.03", hold: "-28.13", entryNtl: "0.0", ltv: "0.0", borrowed: "23.13" },
      { coin: "FATCAT", token: 126, total: "43.36", hold: "0.0", entryNtl: "1.16" },
      { coin: "HYPE", token: 150, total: "0.6695", hold: "0.4661", entryNtl: "0.0", ltv: "0.65", supplied: "0.6695" },
    ] };
    const base = hlRoute({ mode: "portfolioMargin" });
    stubFetch((url, body) => {
      if (body?.type === "spotClearinghouseState") return json(pm);
      if (body?.type === "spotMetaAndAssetCtxs") return json([{ universe: [{ tokens: [150, 0], index: 0 }, { tokens: [126, 0], index: 1 }] }, [{ markPx: "76.4", dayNtlVlm: "1" }, { markPx: "0.0306", dayNtlVlm: "1" }]]);
      return base(url, body);
    });
    const r = await fetchBalanceByAddress("hyperliquid", "mainnet", ADDR);
    const bal = r.balance as unknown as Record<string, unknown>;
    expect(r.accountMode).toBe("portfolio");
    expect(Number(bal.equity)).toBeCloseTo(-18.03 + 0.6695 * 76.4, 9);
    expect(bal.available).toBe(String(-18.03 - -28.13));
    expect(bal.portfolioMarginRatio).toBe("0.517");
    expect((bal.collateral as Array<{ token: string }>).map(c => c.token)).toEqual(["USDC", "HYPE"]);
    expect(r.spot?.map(x => [x.token, x.shared])).toEqual([["USDC", true], ["FATCAT", false], ["HYPE", true]]);
  });

  it("standard: equity = perp accountValue, available = withdrawable; no meta read", async () => {
    const f = stubFetch(hlRoute({ mode: "disabled" }));
    const r = await fetchBalanceByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.balance).toMatchObject({ equity: "568.566325", available: "0" });
    expect(r.accountMode).toBe("standard");
    expect(r.notes).toEqual([]);
    expect(infoTypes(f)).not.toContain("meta");
  });

  it("spot rows come from spotClearinghouseState; in unified mode the USDC row is marked shared", async () => {
    stubFetch(hlRoute({ mode: "unifiedAccount" }));
    const r = await fetchBalanceByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.spot).toEqual([
      { token: "USDC", total: "1737.36042112", available: String(1737.36042112 - 724.975946), held: "724.975946", entryNtl: "0.0", shared: true },
      { token: "HYPE", total: "0.00646473", available: "0.00646473", held: "0.0", entryNtl: "0.55639488", shared: false },
    ]);
    expect(issues(BalanceByAddress, (await readBalanceByAddress("hyperliquid", "mainnet", ADDR)).data)).toBe("");
  });

  it("an unreadable spot balance row is EXCHANGE_ERROR, never a 0", async () => {
    stubFetch((url, body) => (body?.type === "spotClearinghouseState" ? json({ balances: [{ coin: "USDC", token: 0, total: null, hold: "0" }] }) : hlRoute({ mode: "disabled" })(url, body)));
    await expect(fetchBalanceByAddress("hyperliquid", "mainnet", ADDR)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("keyed and public balances are the same function: a read-only HyperliquidAdapter on the same answers gives the same balance", async () => {
    // A unique address: the keyed adapter's account / mode reads go through the shared TTL cache.
    const addr = "0x00000000000000000000000000000000000b0f01";
    stubFetch(hlRoute({ mode: "unifiedAccount" }));
    const pub = await fetchBalanceByAddress("hyperliquid", "mainnet", addr);
    const keyed = new HyperliquidAdapter();
    keyed.setAddress(addr);
    expect(await keyed.getBalance()).toEqual(pub.balance);
  });

  it("an unrecognized abstraction mode fails the venue (no default)", async () => {
    stubFetch(hlRoute({ mode: "somethingNew" }));
    await expect(fetchBalanceByAddress("hyperliquid", "mainnet", ADDR)).rejects.toMatchObject({ structured: { message: expect.stringContaining("UNKNOWN_ACCOUNT_MODE") } });
  });

  it("the native read failing fails the venue (never an empty answer)", async () => {
    stubFetch((url, body) => (body?.type === "clearinghouseState" && body.dex === undefined ? json({ error: "down" }, 500) : hlRoute({ mode: "disabled" })(url, body)));
    await expect(fetchBalanceByAddress("hyperliquid", "mainnet", ADDR)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("Hyperliquid HIP-3 dex balances", () => {
  it("only dexes with a non-zero account value are listed, each the dex's own perp clearinghouse", async () => {
    stubFetch(hlRoute({ mode: "unifiedAccount", dexes: ["xyz", "flx"], dexValue: { xyz: "42.5" } }));
    const r = await fetchBalanceByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.dexes).toEqual({ xyz: { equity: "42.5", available: "42.5", marginUsed: "0", unrealizedPnl: "0" } });
    expect(r.errors).toEqual({});
  });

  it("a failing dex is errors[hip3:<dex>] and a CLI warning (unknown, not zero); the other dexes are kept", async () => {
    stubFetch(hlRoute({ mode: "disabled", dexes: ["xyz", "flx"], failingDex: new Set(["flx"]), dexValue: { xyz: "1" } }));
    const r = await fetchBalanceByAddress("hyperliquid", "mainnet", ADDR);
    expect(Object.keys(r.dexes ?? {})).toEqual(["xyz"]);
    expect(Object.keys(r.errors)).toEqual(["hip3:flx"]);
    const run = await runCli(["-e", "hyperliquid", "account", "balance", "--address", ADDR]);
    expect(run.envelope.ok).toBe(true);
    expect(run.envelope.meta?.warnings).toEqual([expect.stringMatching(/^hyperliquid hip3:flx unavailable .*unknown, not zero\)$/)]);
    expect(Object.keys(run.envelope.meta?.errors as object)).toEqual(["hip3:flx"]);
  });

  it("the dex list failing: the native balance is kept, errors.hip3 set", async () => {
    stubFetch(hlRoute({ mode: "disabled", dexListFails: true }));
    const r = await fetchBalanceByAddress("hyperliquid", "mainnet", ADDR);
    expect(r.balance?.equity).toBe("568.566325");
    expect(Object.keys(r.errors)).toEqual(["hip3"]);
  });
});

describe("HIP-3 fan-out pacing (hlDexFanOut)", () => {
  const dexes = Array.from({ length: 30 }, (_, i) => `d${i}`);

  it(`at most ${HL_DEX_FANOUT_CONCURRENCY} reads in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await hlDexFanOut("testnet", dexes.slice(0, 12), async (d) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(res => setTimeout(res, 5));
      inFlight--;
      return d;
    });
    expect(peak).toBeLessThanOrEqual(HL_DEX_FANOUT_CONCURRENCY);
    expect(r.map(x => (x.status === "fulfilled" ? x.value : null))).toEqual(dexes.slice(0, 12));
  });

  it("requests beyond the burst wait for the venue refill instead of firing at once", async () => {
    vi.useFakeTimers();
    let started = 0;
    const p = hlDexFanOut("mainnet", dexes, async (d) => { started++; return d; });
    await vi.advanceTimersByTimeAsync(0);
    // clearinghouseState weighs 2: the burst admits HL_DEX_FANOUT_BURST / 2 requests at t = 0.
    expect(started).toBeLessThanOrEqual(HL_DEX_FANOUT_BURST / 2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).every(x => x.status === "fulfilled")).toBe(true);
    expect(started).toBe(30);
  });

  it("a failed read stays that dex's; nothing is retried", async () => {
    const calls: string[] = [];
    const r = await hlDexFanOut("testnet", ["a", "b"], async (d) => { calls.push(d); if (d === "a") throw new Error("429"); return d; });
    expect(r[0].status).toBe("rejected");
    expect(r[1]).toEqual({ status: "fulfilled", value: "b" });
    expect(calls).toEqual(["a", "b"]);
  });
});

// ── Lighter ──

const ltAccount = (index: number, extra: Record<string, unknown>) => ({
  account_index: index, account_type: index === 700 ? 0 : 1, account_trading_mode: 0,
  collateral: "100.5", available_balance: "80.25", total_asset_value: "101.75",
  positions: [{ market_id: 0, symbol: "ETH", position: "0.1", unrealized_pnl: "1.25" }],
  assets: [{ symbol: "USDC", asset_id: 3, balance: "10.000000", locked_balance: "0.000000" }, { symbol: "ETH", asset_id: 1, balance: "0.5", locked_balance: "0.1" }],
  ...extra,
});
const LT_ACCOUNTS = { code: 200, total: 2, accounts: [ltAccount(700, {}), ltAccount(701, { total_asset_value: "5", collateral: "5", available_balance: "5", positions: [], assets: [] })] };

describe("Lighter: one row per account of the address", () => {
  it("each account's balance (total_asset_value + spot collateral) and spot assets; balance / spot null at the top", async () => {
    stubFetch(url => (url.includes("/account?by=l1_address") ? json(LT_ACCOUNTS) : null));
    const r = await fetchBalanceByAddress("lighter", "mainnet", ADDR);
    expect(r.balance).toBeNull();
    expect(r.spot).toBeNull();
    expect(r.accounts).toEqual([
      {
        accountIndex: 700,
        balance: { equity: String(101.75 + 10), available: "80.25", marginUsed: String(100.5 - 80.25), unrealizedPnl: "1.25" },
        spot: [
          { token: "USDC", total: "10.000000", available: "10", held: "0.000000", shared: false },
          { token: "ETH", total: "0.5", available: "0.4", held: "0.1", shared: false },
        ],
      },
      { accountIndex: 701, balance: { equity: "5", available: "5", marginUsed: "0", unrealizedPnl: "0" }, spot: [] },
    ]);
    expect(issues(BalanceByAddress, (await readBalanceByAddress("lighter", "mainnet", ADDR)).data)).toBe("");
  });

  it("--account-index narrows; an index the address does not own is INVALID_PARAMS listing its accounts", async () => {
    stubFetch(url => (url.includes("/account?by=l1_address") ? json(LT_ACCOUNTS) : null));
    expect((await fetchBalanceByAddress("lighter", "mainnet", ADDR, { accountIndex: 701 })).accounts?.map(a => a.accountIndex)).toEqual([701]);
    await expect(fetchBalanceByAddress("lighter", "mainnet", ADDR, { accountIndex: 5 })).rejects.toMatchObject({
      structured: { code: "INVALID_PARAMS", message: expect.stringContaining("700, 701") },
    });
  });

  it("an address without a Lighter RH account is an empty answer with a note (not an error)", async () => {
    stubFetch(url => (url.includes("/account?by=l1_address") ? json({ code: 21100, message: "account not found" }, 400) : null));
    const r = await fetchBalanceByAddress("lighter-rh", "mainnet", ADDR);
    expect(r).toMatchObject({ balance: null, spot: null, accounts: [], errors: {}, notes: ["no Lighter RH account for this address"] });
  });
});

// ── Pacifica / RISEx ──

const PAC_ACCOUNT = { success: true, data: {
  balance: "4730.207244", account_equity: "3634.308012", available_to_spend: "2495.195745", available_to_withdraw: "2495.195745",
  pending_interest: "0", total_margin_used: "1119.653067",
  spot_balances: [{ symbol: "SOL", amount: "0.96", available_to_withdraw: "0.96" }],
}, error: null, code: null };

describe("Pacifica and RISEx", () => {
  it("Pacifica: the keyed balance with its extras, spot = USDC (shared) + spot_balances", async () => {
    stubFetch(url => (url.includes("/account?account=") ? json(PAC_ACCOUNT)
      : url.includes("/positions?account=") ? json({ success: true, data: [] })
      : url.includes("/info/prices") ? json({ success: true, data: [] }) : null));
    const r = await fetchBalanceByAddress("pacifica", "mainnet", SOL_ADDR);
    expect(r.balance).toEqual({
      equity: "3634.308012", available: "2495.195745", marginUsed: "1119.653067", unrealizedPnl: "0.0000",
      usdcBalance: "4730.207244", borrowedUsdc: "0", pendingInterest: "0", availableToWithdraw: "2495.195745",
    });
    expect(r.spot).toEqual([
      { token: "USDC", total: "4730.207244", available: "2495.195745", held: "2235.011499", shared: true },
      { token: "SOL", total: "0.96", available: "0.96", held: "0", shared: false },
    ]);
    expect(issues(BalanceByAddress, (await readBalanceByAddress("pacifica", "mainnet", SOL_ADDR)).data)).toBe("");
  });

  it("RISEx: the portfolio summary; spot null (no spot market)", async () => {
    stubFetch(url => (url.includes("/v1/portfolio/details") ? json({ data: { summary: { total_account_value: "12.5", free_collateral: "10", total_initial_margin: "2.5", total_unrealized_pnl: "-0.5" }, positions: [] } }) : null));
    const r = await fetchBalanceByAddress("risex", "mainnet", ADDR);
    expect(r.balance).toEqual({ equity: "12.5", available: "10", marginUsed: "2.5", unrealizedPnl: "-0.5" });
    expect(r.spot).toBeNull();
  });
});

// ── Refusals, CLI, fan-out, MCP ──

describe("refusals before any request; the rename pointer without --address", () => {
  it("the supporting venues are exactly the public-position venues", () => {
    expect(listPublicBalanceVenues().map(v => v.id).sort()).toEqual(listPublicPositionVenues().map(v => v.id).sort());
  });

  const unsupported = listVenues().filter(v => !listPublicBalanceVenues().includes(v));
  for (const def of unsupported) {
    it(`perp -e ${def.id} account balance --address … → CAPABILITY_UNSUPPORTED (publicBalance), nothing sent`, async () => {
      const f = stubFetch(() => null);
      const r = await runCli(["-e", def.id, "account", "balance", "--address", ADDR]);
      expect(r.docs).toBe(1);
      expect(r.envelope.error?.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(r.envelope.error?.message).toMatch(/publicBalance/);
      expect(String(r.envelope.error?.remediation)).toContain("hyperliquid");
      expect(f).not.toHaveBeenCalled();
    });
  }

  it("a wrong address format is INVALID_PARAMS, nothing sent", async () => {
    const f = stubFetch(() => null);
    expect((await runCli(["-e", "pacifica", "account", "balance", "--address", ADDR])).envelope.error?.code).toBe("INVALID_PARAMS");
    expect((await runCli(["-e", "hyperliquid", "account", "balance", "--address", SOL_ADDR])).envelope.error?.code).toBe("INVALID_PARAMS");
    expect(f).not.toHaveBeenCalled();
  });

  it("--account-index on a venue with one account per address is INVALID_PARAMS, nothing sent", async () => {
    const f = stubFetch(() => null);
    const r = await runCli(["-e", "hyperliquid", "account", "balance", "--address", ADDR, "--account-index", "1"]);
    expect(r.envelope.error?.code).toBe("INVALID_PARAMS");
    expect(f).not.toHaveBeenCalled();
  });

  it("`account balance` without --address keeps the rename error (INVALID_PARAMS → portfolio)", async () => {
    const f = stubFetch(() => null);
    const r = await runCli(["-e", "hyperliquid", "account", "balance"]);
    expect(r.envelope.error?.code).toBe("INVALID_PARAMS");
    expect(r.envelope.error?.message).toBe("'account balance' was renamed in v0.12 — use 'portfolio' instead.");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("fan-out without -e, and the MCP tool", () => {
  const route = (url: string, body: Record<string, unknown> | null): Response | null => {
    if (url.endsWith("/info")) return hlRoute({ mode: "disabled" })(url, body);
    if (url.includes("/account?by=l1_address")) return json({ code: 21100, message: "account not found" }, 400);
    if (url.includes("/v1/portfolio/details")) return json({ data: { summary: { total_account_value: "0", free_collateral: "0", total_initial_margin: "0", total_unrealized_pnl: "0" }, positions: [] } });
    return null;
  };

  it("every supporting venue; an address of the wrong format for a venue is that venue's INVALID_PARAMS entry", async () => {
    stubFetch(route);
    const r = await readBalanceByAddressAll("mainnet", ADDR);
    expect(Object.keys(r.venues).sort()).toEqual(["hyperliquid", "lighter", "lighter-rh", "risex"]);
    expect(r.venues.hyperliquid.balance?.equity).toBe("568.566325");
    expect(r.errors.pacifica?.code).toBe("INVALID_PARAMS");
    expect(r.notes.lighter).toEqual(["no Lighter account for this address"]);
    const run = await runCli(["account", "balance", "--address", ADDR]);
    expect(run.envelope.ok).toBe(true);
    expect(run.envelope.meta).toMatchObject({ address: ADDR, source: "public" });
  });

  it("MCP get_balance_by_address ⇄ CLI: the same data and meta for one venue", async () => {
    stubFetch(route);
    if (tools.size === 0) await import("../mcp-server.js");
    const mcp = JSON.parse((await tools.get("get_balance_by_address")!({ exchange: "hl", address: ADDR })).content[0].text) as { ok: boolean; data: unknown; meta: Record<string, unknown> };
    const cli = (await runCli(["-e", "hyperliquid", "account", "balance", "--address", ADDR])).envelope;
    expect(mcp.ok).toBe(true);
    expect(issues(BalanceByAddress, cli.data)).toBe("");
    expect(mcp.data).toEqual(cli.data);
    expect(mcp.data).toMatchObject({ exchange: "hyperliquid", address: ADDR, accountMode: "standard", dexes: {} });
    const strip = (m: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => k !== "timestamp" && k !== "network"));
    expect(strip(mcp.meta)).toEqual(strip(cli.meta));
  });

  it("MCP without exchange reads every venue; an unsupported venue → CAPABILITY_UNSUPPORTED (isError), nothing sent", async () => {
    const f = stubFetch(route);
    if (tools.size === 0) await import("../mcp-server.js");
    const all = JSON.parse((await tools.get("get_balance_by_address")!({ address: ADDR })).content[0].text) as { ok: boolean; data: { venues: Record<string, unknown>; errors: Record<string, { code: string }> } };
    expect(all.ok).toBe(true);
    expect(Object.keys(all.data.venues).sort()).toEqual(["hyperliquid", "lighter", "lighter-rh", "risex"]);
    expect(all.data.errors.pacifica.code).toBe("INVALID_PARAMS");
    f.mockClear();
    const no = await tools.get("get_balance_by_address")!({ exchange: "aster", address: ADDR });
    expect(no.isError).toBe(true);
    expect(JSON.parse(no.content[0].text).code).toBe("CAPABILITY_UNSUPPORTED");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("docs follow the registry", () => {
  it("docs/venues.md support matrix: the balance-by-address column is ✅ exactly for the supporting venues", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../../docs/venues.md"), "utf8").split("\n");
    const headerLine = readme.find(l => l.startsWith("| Venue | Market data (CLI) |"))!;
    const header = headerLine.split("|").map(c => c.trim());
    const col = header.findIndex(c => c.startsWith("Balance by address"));
    expect(col).toBeGreaterThan(0);
    const start = readme.indexOf(headerLine) + 2;
    const rows = readme.slice(start).filter((l, i, a) => a.slice(0, i + 1).every(x => x.startsWith("|"))).map(l => l.split("|").map(c => c.trim()));
    const yes = rows.filter(r => r[col].startsWith("✅")).map(r => r[1].split(" (")[0]).sort();
    expect(yes).toEqual(listPublicBalanceVenues().map(v => v.displayName).sort());
  });
});
