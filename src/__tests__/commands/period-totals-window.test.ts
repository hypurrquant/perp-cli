/**
 * Period totals read the whole period, or say how far back they reach — never a history that may end
 * inside the period summed as the total. Coverage is proven, not assumed: a windowed read that fit
 * its budget (Hyperliquid, Aster funding), a list whose end is proven (Lighter), or rows reaching
 * past the window start. Everything else is a lower bound (portfolio funding24h null, `account pnl`
 * fundingIncomplete / tradesIncomplete). Real adapters; only `fetch` (Aster: the signed request) is
 * stubbed — no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { Keypair } from "@solana/web3.js";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerPortfolioCommand } from "../../commands/portfolio.js";
import { registerAccountCommands } from "../../commands/account.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { PacificaAdapter, PACIFICA_ACCOUNT_HISTORY_PAGE, PACIFICA_MAX_PAGES } from "../../exchanges/pacifica.js";
import { AsterAdapter, ASTER_INCOME_MAX_PAGES } from "../../exchanges/aster.js";
import { LighterAdapter } from "../../exchanges/lighter.js";
import { coverageNote, coveredFrom, fundingPaymentsInWindow, type ExchangeAdapter } from "../../exchanges/interface.js";
import { invalidateCache } from "../../cache.js";
import type { AgentMeta } from "../../settings.js";
import HL_RECORDED from "../fixtures/hyperliquid/read-path-2026-10-19.json";
import HL_ACCOUNT_FRAMES from "../fixtures/ws/hyperliquid/private-clearinghouseState.json";
import PAC_MARKET_DATA from "../fixtures/pacifica/market-data-live.json";

// portfolio --serve: the dashboard server itself is not started (its port is all the envelope needs).
vi.mock("../../dashboard/index.js", async (importOriginal) => ({ ...(await importOriginal<object>()), startDashboard: vi.fn(async () => ({ port: 4567 })) }));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

// ── Hyperliquid ──
/** Main-dex coin names (the recorded meta holds 4; history rows are scoped by name, not by meta). */
const coins = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`);
type HlFundingRow = { time: number; hash: string; delta: { type: string; coin: string; usdc: string; szi: string; fundingRate: string } };
/** `names` funded hourly for `hours` hours up to now: userFunding rows (docs shape), oldest first (the venue's order). */
const hlFunding = (names: string[], hours: number): HlFundingRow[] => Array.from({ length: hours }, (_, h) => names.map(coin => ({
  time: NOW - (hours - 1 - h) * HOUR - 60_000, hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  delta: { type: "funding", coin, usdc: "-1.0", szi: "1.0", fundingRate: "0.0001" },
}))).flat();
const hlFill = (coin: string, time: number) => ({ coin, side: "B", px: "100", sz: "1", time, fee: "0.1" });
const HL_SPOT_META = { tokens: [{ name: "USDC", index: 0, szDecimals: 8, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054" }], universe: [] };

/** A real HyperliquidAdapter over a stubbed /info (recorded meta, an empty recorded account); `fundingRequests()` counts userFunding reads. */
async function hlAdapter(rows: HlFundingRow[], fills: unknown[] = []): Promise<{ hl: HyperliquidAdapter; fundingRequests: () => number }> {
  let funding = 0;
  const answer = (b: Record<string, unknown>): unknown => {
    switch (b.type) {
      case "meta": return HL_RECORDED.meta;
      case "perpDexs": return HL_RECORDED.perpDexs;
      case "userAbstraction": return "disabled";
      case "clearinghouseState": return HL_ACCOUNT_FRAMES.frames[0].data.clearinghouseState;
      case "spotClearinghouseState": return { balances: [] };
      case "spotMeta": return HL_SPOT_META;
      case "spotMetaAndAssetCtxs": return [HL_SPOT_META, []];
      case "frontendOpenOrders": return [];
      case "userFills": return fills;
      case "userFunding":
        funding++;
        // Rows in [startTime, endTime] (both inclusive, docs), oldest first, at most 500 per response (live 2026-10-13).
        return rows.filter(r => r.time >= Number(b.startTime) && (b.endTime === undefined || r.time <= Number(b.endTime))).slice(0, 500);
      default: throw new Error(`unexpected info ${String(b.type)}`);
    }
  };
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => json(answer(JSON.parse(String(init?.body))))));
  const hl = new HyperliquidAdapter(undefined, false);
  hl.setAddress("0xabcdef0000000000000000000000000000000001");
  await hl.init();
  return { hl, fundingRequests: () => funding };
}

// ── Pacifica (account history lists paged with cursor / has_more; row order not documented) ──
const PAC_ACCOUNT = { balance: "1000", account_equity: "1000", available_to_spend: "1000", available_to_withdraw: "1000", pending_interest: "0", total_margin_used: "0", spot_balances: [] };
/** GET /funding/history rows (recorded shape), one per `stepMs` back from now. */
const pacFunding = (n: number, stepMs: number) => Array.from({ length: n }, (_, i) => ({ history_id: i, symbol: "ETH", side: "bid", amount: "1", payout: "-1", rate: "0.0001", created_at: NOW - i * stepMs }));
/** GET /trades/history rows (docs shape). */
const pacTrade = (time: number) => ({ history_id: time, symbol: "ETH", amount: "1", price: "100", fee: "0.1", side: "open_long", created_at: time });
/** A page of `limit` rows from `cursor` (an offset here; opaque to the adapter) and the docs envelope: has_more while rows remain. */
function pacPage(rows: unknown[], url: URL): Response {
  const off = Number(url.searchParams.get("cursor") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const more = off + limit < rows.length;
  return json({ success: true, data: rows.slice(off, off + limit), next_cursor: more ? String(off + limit) : null, has_more: more, error: null, code: null });
}
/** A real PacificaAdapter over stubbed REST; `requests` lists every URL asked. */
function pacificaAdapter(funding: unknown[], trades: Array<{ created_at: number }> = []): ExchangeAdapter & { requests: URL[] } {
  const requests: URL[] = [];
  const routes: Record<string, (u: URL) => Response> = {
    "/account": () => json({ success: true, data: PAC_ACCOUNT, error: null, code: null }),
    "/info": () => json(PAC_MARKET_DATA.info),
    "/info/prices": () => json({ success: true, data: [], error: null, code: null }),
    "/positions": () => json({ success: true, data: [], error: null, code: null }),
    "/orders": () => json({ success: true, data: [], error: null, code: null }),
    // start_time / end_time filter the trades (docs); the funding list takes no time filter.
    "/trades/history": (u) => pacPage(trades.filter(t => t.created_at >= Number(u.searchParams.get("start_time") ?? "0") && t.created_at <= Number(u.searchParams.get("end_time") ?? String(Infinity))), u),
    "/funding/history": (u) => pacPage(funding, u),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const u = urlOf(input);
    requests.push(u);
    const route = routes[u.pathname.replace("/api/v1", "")];
    if (!route) throw new Error(`unexpected Pacifica request ${u.pathname}`);
    return route(u);
  }));
  return Object.assign(new PacificaAdapter(Keypair.generate(), "mainnet"), { requests });
}
/** More funding rows than the page budget can read: the list's end is never seen. */
const PAC_OVER_BUDGET = PACIFICA_ACCOUNT_HISTORY_PAGE * PACIFICA_MAX_PAGES + 1;
const NOT_PROVEN = "no row read proves how far back the venue's history reaches";

// ── Aster ──
/** A real AsterAdapter whose signed request reads `income` (rows in [startTime, endTime]); `incomeRequests()` counts them. */
function asterAdapter(income: Array<{ symbol: string; incomeType: string; income: string; time: number }>): { ast: AsterAdapter; incomeRequests: () => number } {
  let requests = 0;
  const ast = new AsterAdapter(undefined, false);
  const t = ast as unknown as Record<string, unknown>;
  t._resolveSigner = () => ({ kind: "agent", signer: {}, agent: {} });
  t._signedGetEip712 = async (path: string, q: Record<string, string>) => {
    switch (path) {
      case "/fapi/v3/income":
        requests++;
        // At most `limit` (1000, the endpoint max) rows of [startTime, endTime].
        return income.filter(r => r.incomeType === q.incomeType && r.time >= Number(q.startTime) && r.time <= Number(q.endTime)).slice(0, Number(q.limit));
      case "/fapi/v3/accountWithJoinMargin": return { positions: [] };
      case "/fapi/v3/openOrders": await new Promise(r => setTimeout(r, 5)); return []; // a read takes time: the period started before it
      case "/fapi/v3/userTrades": return [];
      default: throw new Error(`unexpected ${path}`);
    }
  };
  vi.spyOn(ast, "getBalance").mockResolvedValue({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" });
  vi.spyOn(ast, "getPositions").mockResolvedValue([]);
  return { ast, incomeRequests: () => requests };
}
const asterFunding = (ageMs: number) => ({ symbol: "BTCUSDT", incomeType: "FUNDING_FEE", income: "-1", time: NOW - ageMs });

// ── Lighter ──
/** A real LighterAdapter over stubbed REST: a short positionFunding list that ends (no next_cursor). */
async function lighterAdapter(fundingAgesMs: number[]): Promise<LighterAdapter> {
  (LighterAdapter as unknown as { _wasmClients: Map<string, unknown> })._wasmClients.clear();
  vi.spyOn(LighterAdapter as unknown as { _createWasmClient: () => Promise<unknown> }, "_createWasmClient")
    .mockResolvedValue({ createClient: () => undefined, createAuthToken: () => "auth-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = urlOf(input).pathname.replace("/api/v1", "");
    if (path === "/orderBooks") return json({ code: 200, order_books: [{ symbol: "ETH", market_id: 0, market_type: "perp", status: "active", supported_size_decimals: 4, supported_price_decimals: 2 }] });
    if (path === "/positionFunding") return json({ code: 200, position_fundings: fundingAgesMs.map(age => ({ timestamp: Math.floor((NOW - age) / 1000), market_id: 0, change: "-1" })) });
    throw new Error(`unexpected Lighter request ${path}`);
  }));
  const agent = {
    agentName: "default", agentWalletName: "lt-agent", agentEvmAddress: "0x00000000000000000000000000000000000000aa",
    userEvmAddress: "0x00000000000000000000000000000000000000bb", apiKeyIndex: 4, accountIndex: 77,
    expiresAt: new Date(NOW + DAY).toISOString(), masterWalletName: "main", owsApiKeyId: "ows_key_test",
    owsPolicyId: "policy-test", approvedAt: new Date(NOW).toISOString(), permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false }, asterApprovalNonce: "0",
  } as AgentMeta;
  const a = LighterAdapter.forVenue("lighter", "", false);
  a.setAgentSigner(agent, "ab".repeat(40));
  a.setAddress(agent.userEvmAddress);
  await a.init();
  return a;
}

async function runJson(register: (p: Command) => void, argv: string[]): Promise<{ data: Record<string, unknown>; meta: Record<string, unknown> }> {
  const prog = new Command();
  prog.exitOverride();
  addRootSafetyOptions(prog).option("-e, --exchange <exchange>", "Exchange", "pacifica").option("--json", "JSON output");
  register(prog);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await prog.parseAsync(["node", "perp", ...argv]);
  const joined = out.join("");
  return JSON.parse(joined.slice(joined.indexOf("{")));
}
const portfolio = (venue: string, a: unknown) => runJson(p => registerPortfolioCommand(p, async () => a as ExchangeAdapter, () => true, "test"), ["-e", venue, "--json", "portfolio"]);
const accountPnl = (venue: string, a: unknown, period: string) => runJson(p => registerAccountCommands(p, async () => a as ExchangeAdapter, () => true), ["-e", venue, "--json", "account", "pnl", "--period", period]);
const ISO_NOTE = "\\d{4}-\\d\\d-\\d\\dT[^ ]*";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  invalidateCache(); // the real account cache (isolated TMPDIR): every test reads its own answers
});

describe("Hyperliquid reads the funding window", () => {
  it("portfolio funding24h sums all 240 rows of the last 24 h (not the newest 200)", async () => {
    const { hl } = await hlAdapter(hlFunding(coins(10), 24));
    const { data } = await portfolio("hyperliquid", hl);
    expect(data.totals).toMatchObject({ funding24h: -240, fundingIncomplete: false });
  });

  it("a window larger than one page: every one of 7200 rows of 30 days, each once", async () => {
    const { hl } = await hlAdapter(hlFunding(coins(10), 720));
    const start = NOW - 30 * DAY;
    const w = await hl.getFundingPaymentsSince(start);
    expect(w.from).toBe(start);
    expect(new Set(w.rows.map(r => `${r.time}|${r.symbol}`)).size).toBe(7200);
    expect(w.rows).toHaveLength(7200);
  });

  it("a window past the page budget: the newest stretch [from, now], whole, with how far back it reached", async () => {
    const rows = hlFunding(coins(21), 720);
    const { hl } = await hlAdapter(rows);
    const start = NOW - 30 * DAY;
    const w = await hl.getFundingPaymentsSince(start);
    expect(w.from).toBeGreaterThan(start);
    expect(w.rows.length).toBeGreaterThan(0);
    expect(w.rows).toHaveLength(rows.filter(r => r.time >= w.from).length);
    expect(Math.min(...w.rows.map(r => r.time))).toBeGreaterThanOrEqual(w.from);
  });

  it("account pnl --period 30d past the page budget: the sum of what was read, fundingIncomplete + how far back", async () => {
    const { hl } = await hlAdapter(hlFunding(coins(21), 720));
    const { data, meta } = await accountPnl("hyperliquid", hl, "30d");
    expect(data).toMatchObject({ fundingIncomplete: true, funding: -(data.fundingPayments as number) });
    expect(data.fundingPayments as number).toBeGreaterThan(0);
    expect(data.fundingPayments as number).toBeLessThan(21 * 720);
    expect(meta.warnings).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^funding read back to ${ISO_NOTE} only — totals are a lower bound$`))]));
  });

  it("window 0 on a 30-day, 7200-row history: complete (nothing older exists, no budget spent before the first funding)", async () => {
    const { hl } = await hlAdapter(hlFunding(coins(10), 720));
    const w = await hl.getFundingPaymentsSince(0);
    expect(w.from).toBe(0);
    expect(w.rows).toHaveLength(7200);
  });

  it("window 0 on a 30-day, 7200-row history reads it in 17 requests or fewer (was 20 and partial)", async () => {
    const { hl, fundingRequests } = await hlAdapter(hlFunding(coins(10), 720));
    await hl.getFundingPaymentsSince(0);
    expect(fundingRequests()).toBeLessThanOrEqual(17);
  });

  it("window 0 on a 10-day, 720-row history reads it whole in 5 requests or fewer (was 16)", async () => {
    const { hl, fundingRequests } = await hlAdapter(hlFunding(coins(3), 240));
    const w = await hl.getFundingPaymentsSince(0);
    expect(w).toMatchObject({ from: 0 });
    expect(w.rows).toHaveLength(720);
    expect(fundingRequests()).toBeLessThanOrEqual(5);
  });
});

describe("Hyperliquid trades: userFills is the latest 2000 fills — fewer is the whole list", () => {
  it("account pnl --period all: 5 fills (fewer than 2000) are the whole list — not flagged", async () => {
    const { hl } = await hlAdapter([], Array.from({ length: 5 }, (_, i) => hlFill(coins(1)[0], NOW - (i + 1) * DAY)));
    const { data } = await accountPnl("hyperliquid", hl, "all");
    expect(data).toMatchObject({ trades: 5, tradesIncomplete: false });
  });

  it("2000 fills all inside the period: flagged, read back to the oldest fill", async () => {
    const fills = Array.from({ length: 2000 }, (_, i) => hlFill(coins(1)[0], NOW - (i + 1) * 60_000));
    const { hl } = await hlAdapter([], fills);
    const { data, meta } = await accountPnl("hyperliquid", hl, "30d");
    expect(data).toMatchObject({ tradesIncomplete: true });
    expect(meta.warnings).toEqual(expect.arrayContaining([`trades read back to ${new Date(NOW - 2000 * 60_000).toISOString()} only — totals are a lower bound`]));
  });

  it("a fill older than the period proves it: not flagged", async () => {
    const { hl } = await hlAdapter([], [hlFill(coins(1)[0], NOW - DAY), hlFill(coins(1)[0], NOW - 40 * DAY)]);
    const { data } = await accountPnl("hyperliquid", hl, "30d");
    expect(data).toMatchObject({ tradesIncomplete: false });
  });
});

describe("Aster: getFundingPayments stops at 7 days, a period total reads its window", () => {
  it("account pnl --period 30d counts a funding payment 25 days old", async () => {
    const { ast } = asterAdapter([asterFunding(HOUR), asterFunding(25 * DAY)]);
    const { data } = await accountPnl("aster", ast, "30d");
    expect(data).toMatchObject({ fundingPayments: 2, funding: -2 });
  });

  it("a window older than 7 days keeps a label: income retention past the documented 7 days is not proven", async () => {
    const { ast } = asterAdapter([asterFunding(HOUR), asterFunding(25 * DAY)]);
    const { data } = await accountPnl("aster", ast, "30d");
    expect(data).toMatchObject({ fundingIncomplete: true });
  });

  it("--period all with fewer than 1000 rows: one income request (was 60, ending incomplete)", async () => {
    const { ast, incomeRequests } = asterAdapter([asterFunding(HOUR), asterFunding(25 * DAY)]);
    const w = await ast.getFundingPaymentsSince(0);
    expect(incomeRequests()).toBe(1);
    expect(w.rows).toHaveLength(2);
  });

  it("a 30-day window (MCP's default) with fewer than 1000 rows: one income request (was 31)", async () => {
    const { ast, incomeRequests } = asterAdapter([asterFunding(HOUR)]);
    await ast.getFundingPaymentsSince(NOW - 30 * DAY);
    expect(incomeRequests()).toBe(1);
  });

  it("account pnl --period 30d: trades (found through 7 days of income, userTrades' default 7 days) are flagged tradesIncomplete", async () => {
    const { ast } = asterAdapter([]);
    const { data, meta } = await accountPnl("aster", ast, "30d");
    expect(data).toMatchObject({ tradesIncomplete: true });
    expect(meta.warnings).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^trades read back to ${ISO_NOTE} only — totals are a lower bound$`))]));
  });

  it("account pnl --period 7d: a short trade list covers the 7 days — not flagged", async () => {
    const { ast } = asterAdapter([]);
    const { data } = await accountPnl("aster", ast, "7d");
    expect(data).toMatchObject({ tradesIncomplete: false, fundingIncomplete: false });
  });

  it("a full first answer past the request cap: day slices newest first, the rows of the newest stretch, labelled", async () => {
    // 1000 rows over the last 50 days fill the whole-window answer; each day slice holds 20.
    const spread = Array.from({ length: 1000 }, (_, i) => asterFunding(i * 72 * 60_000 + HOUR));
    const { ast, incomeRequests } = asterAdapter([...spread, asterFunding(80 * DAY)]);
    const start = NOW - 90 * DAY;
    const w = await ast.getFundingPaymentsSince(start);
    expect(incomeRequests()).toBe(ASTER_INCOME_MAX_PAGES);
    expect(w.from).toBeGreaterThan(start);
    expect(w.rows).toHaveLength(1000);
  });

  it("a full day slice is split and re-read newest first: no row lost, the window complete", async () => {
    const dense = Array.from({ length: 1500 }, (_, i) => asterFunding(i * 40_000 + 1000));
    const { ast } = asterAdapter(dense);
    const start = NOW - 2 * DAY;
    const w = await ast.getFundingPaymentsSince(start);
    expect(w.from).toBe(start);
    expect(w.rows).toHaveLength(1500);
    expect(w.rows.map(r => r.time)).toEqual([...w.rows.map(r => r.time)].sort((a, b) => b - a));
  });
});

describe("Lighter follows the cursor to the end of the list", () => {
  it("a short funding list is the whole history: complete, even with no row past the window", async () => {
    const lt = await lighterAdapter([HOUR]);
    const w = await fundingPaymentsInWindow(lt, NOW - 30 * DAY);
    expect(w).toMatchObject({ complete: true });
    expect(w.rows).toHaveLength(1);
  });
});

describe("Pacifica: an account history list the venue ends (has_more false) is the whole list, whatever its order", () => {
  it("portfolio: a short funding list the venue ends is the whole history → funding24h sums the rows of the 24 h", async () => {
    const { data } = await portfolio("pacifica", pacificaAdapter(pacFunding(3, 1000)));
    expect((data.exchanges as Array<Record<string, unknown>>)[0]).toMatchObject({ funding24h: -3 });
  });

  it("account pnl --period all: 450 funding rows over 3 pages (cursor) are all counted, complete", async () => {
    const { data } = await accountPnl("pacifica", pacificaAdapter(pacFunding(450, 1000)), "all");
    expect(data).toMatchObject({ fundingPayments: 450, funding: -450, fundingIncomplete: false });
  });

  it("an oldest-first answer gives the same total", async () => {
    const { data } = await portfolio("pacifica", pacificaAdapter(pacFunding(3, 20 * HOUR).reverse()));
    expect(data.totals).toMatchObject({ funding24h: -2, fundingIncomplete: false });
  });

  it("account pnl --period all: trades the venue ends are the whole list — not flagged", async () => {
    const { data } = await accountPnl("pacifica", pacificaAdapter([], [pacTrade(NOW - DAY)]), "all");
    expect(data).toMatchObject({ trades: 1, tradesIncomplete: false });
  });

  it("trades are asked for [period start, now] (start_time / end_time)", async () => {
    const pac = pacificaAdapter([], []);
    await accountPnl("pacifica", pac, "7d");
    const asked = pac.requests.find(u => u.pathname.endsWith("/trades/history"))!;
    expect(Number(asked.searchParams.get("start_time"))).toBeGreaterThanOrEqual(NOW - 7 * DAY);
    expect(Number(asked.searchParams.get("end_time"))).toBeGreaterThanOrEqual(NOW);
  });
});

describe("a list longer than the read budget proves nothing (its order is not documented)", () => {
  it("portfolio: funding past the page budget → funding24h null with fundingError", async () => {
    const { data } = await portfolio("pacifica", pacificaAdapter(pacFunding(PAC_OVER_BUDGET, 1000)));
    expect((data.exchanges as Array<Record<string, unknown>>)[0]).toMatchObject({ funding24h: null, fundingError: `funding history: ${NOT_PROVEN} — the 24 h total is unknown` });
  });

  it("portfolio: no venue's funding was read → totals.funding24h null (unknown), not 0", async () => {
    const { data } = await portfolio("pacifica", pacificaAdapter(pacFunding(PAC_OVER_BUDGET, 1000)));
    expect(data.totals).toMatchObject({ funding24h: null, fundingIncomplete: true });
  });

  it("account pnl --period 30d: the rows read are summed and flagged fundingIncomplete", async () => {
    const { data } = await accountPnl("pacifica", pacificaAdapter(pacFunding(PAC_OVER_BUDGET, 1000)), "30d");
    expect(data).toMatchObject({ funding: -(PAC_OVER_BUDGET - 1), fundingPayments: PAC_OVER_BUDGET - 1, fundingIncomplete: true });
  });
});

describe("coverage of an empty list does not depend on the clock", () => {
  it("coveredFrom: an empty list with an unproven reach → Infinity (not the read time)", () => {
    expect(coveredFrom([], 200, null, 1_000)).toBe(Infinity);
  });

  it("coverageNote of an empty list's coverage says nothing proves the reach, however late it is written", () => {
    expect(coverageNote("funding", coveredFrom([], 200, null, 1_000))).toBe(`funding: ${NOT_PROVEN}`);
  });
});

describe("portfolio --serve envelope", () => {
  it("totals.funding24h is null (no venue's funding read yet), not 0", async () => {
    const prog = new Command();
    prog.exitOverride();
    addRootSafetyOptions(prog).option("-e, --exchange <exchange>", "Exchange", "pacifica").option("--json", "JSON output");
    registerPortfolioCommand(prog, async () => pacificaAdapter([]), () => true, "test");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    void prog.parseAsync(["node", "perp", "-e", "pacifica", "--json", "portfolio", "--serve"]); // serves until stopped: never settles
    await vi.waitFor(() => expect(out.join("")).toMatch(/"mode": ?"serve"/));
    const joined = out.join("");
    const env = JSON.parse(joined.slice(joined.indexOf("{"))) as { data: { totals: Record<string, unknown> } };
    expect(env.data.totals.funding24h).toBeNull();
  });
});
