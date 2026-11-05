/**
 * Period totals read the whole period, or say how far back they reach — never a capped history
 * summed as the total. Hyperliquid reads the window (userFunding; past its page budget, the newest
 * stretch it could read, labelled); a venue with only the capped getFundingPayments(200) whose rows
 * all fall inside the period is a lower bound (portfolio funding24h null, `account pnl`
 * fundingIncomplete). No network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerPortfolioCommand } from "../../commands/portfolio.js";
import { registerAccountCommands } from "../../commands/account.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

const HOUR = 3_600_000;
const NOW = Date.now();
const START_30D = NOW - 30 * 24 * HOUR;
const coins = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`);
type FundingRow = { time: number; hash: string; delta: { type: string; coin: string; usdc: string; szi: string; fundingRate: string; nSamples: null } };
/** `names` funded hourly for `hours` hours up to now: userFunding rows, oldest first (the venue's order). */
const fundingRows = (names: string[], hours: number): FundingRow[] => Array.from({ length: hours }, (_, h) => names.map(coin => ({
  time: NOW - (hours - 1 - h) * HOUR - 60_000, hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  delta: { type: "funding", coin, usdc: "-1.0", szi: "1.0", fundingRate: "0.0001", nSamples: null },
}))).flat();
const SPOT_META = { tokens: [{ name: "USDC", index: 0, szDecimals: 8, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054" }], universe: [] };
const EMPTY_CHS = { marginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" }, crossMarginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" }, withdrawable: "0.0", assetPositions: [] };

/** A real HyperliquidAdapter whose info responses come from `rows` (and an empty account). */
async function hlAdapter(rows: FundingRow[]): Promise<HyperliquidAdapter> {
  const names = [...new Set(rows.map(r => r.delta.coin))];
  const info = (b: Record<string, unknown>): Promise<unknown> => {
    const routes: Record<string, () => unknown> = {
      meta: () => ({ universe: names.map(name => ({ name, szDecimals: 3, maxLeverage: 10 })) }),
      perpDexs: () => [null],
      userAbstraction: () => "disabled",
      clearinghouseState: () => EMPTY_CHS,
      spotClearinghouseState: () => ({ balances: [] }),
      spotMeta: () => SPOT_META,
      spotMetaAndAssetCtxs: () => [SPOT_META, []],
      frontendOpenOrders: () => [],
      userFills: () => [],
      // Rows in [startTime, endTime] (both inclusive, docs), oldest first, at most 500 per response (live 2026-10-13).
      userFunding: () => rows.filter(r => r.time >= Number(b.startTime) && (b.endTime === undefined || r.time <= Number(b.endTime))).slice(0, 500),
    };
    const r = routes[String(b.type)];
    return r ? Promise.resolve(r()) : Promise.reject(new Error(`unexpected info ${String(b.type)}`));
  };
  vi.spyOn(HyperliquidAdapter.prototype as unknown as { _infoPost: typeof info }, "_infoPost").mockImplementation(info);
  const hl = new HyperliquidAdapter(undefined, false);
  hl.setAddress("0xabcdef0000000000000000000000000000000001");
  await hl.init();
  return hl;
}

/** A venue without a windowed read: getFundingPayments(200) answers 200 rows, all of the last hour. */
const cappedVenue = {
  name: "pacifica",
  getBalance: async () => ({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" }),
  getPositions: async () => [], getOpenOrders: async () => [], getTradeHistory: async () => [],
  getFundingPayments: async (limit = 200) => Array.from({ length: limit }, (_, i) => ({ time: NOW - i * 1000, symbol: "BTC", payment: "-1" })),
} as unknown as ExchangeAdapter;

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

afterEach(() => { vi.restoreAllMocks(); });

describe("period totals cover the period or say how far back they reach", () => {
  it("portfolio funding24h on Hyperliquid sums all 240 rows of the last 24 h (not the newest 200)", async () => {
    const hl = await hlAdapter(fundingRows(coins(10), 24));
    const { data } = await runJson(p => registerPortfolioCommand(p, async () => hl as unknown as ExchangeAdapter, () => true, "test"), ["-e", "hyperliquid", "--json", "portfolio"]);
    expect(data.totals).toMatchObject({ funding24h: -240, fundingIncomplete: false });
  });

  it("Hyperliquid window larger than one page: every one of 7200 rows of 30 days, each once", async () => {
    const hl = await hlAdapter(fundingRows(coins(10), 720));
    const w = await hl.getFundingPaymentsSince(START_30D);
    expect(w.from).toBe(START_30D);
    expect(new Set(w.rows.map(r => `${r.time}|${r.symbol}`)).size).toBe(7200);
    expect(w.rows).toHaveLength(7200);
  });

  it("Hyperliquid window past the page budget: the newest stretch [from, now], whole, with how far back it reached", async () => {
    const rows = fundingRows(coins(21), 720);
    const hl = await hlAdapter(rows);
    const w = await hl.getFundingPaymentsSince(START_30D);
    expect(w.from).toBeGreaterThan(START_30D);
    expect(w.rows.length).toBeGreaterThan(0);
    expect(w.rows).toHaveLength(rows.filter(r => r.time >= w.from).length);
    expect(Math.min(...w.rows.map(r => r.time))).toBeGreaterThanOrEqual(w.from);
  });

  it("account pnl --period 30d past the Hyperliquid page budget: the sum of what was read, fundingIncomplete + how far back", async () => {
    const hl = await hlAdapter(fundingRows(coins(21), 720));
    const { data, meta } = await runJson(p => registerAccountCommands(p, async () => hl as unknown as ExchangeAdapter, () => true), ["-e", "hyperliquid", "--json", "account", "pnl", "--period", "30d"]);
    expect(data).toMatchObject({ fundingIncomplete: true, funding: -(data.fundingPayments as number) });
    expect(data.fundingPayments as number).toBeGreaterThan(0);
    expect(data.fundingPayments as number).toBeLessThan(21 * 720);
    expect(meta.warnings).toEqual([expect.stringMatching(/^funding read back to \d{4}-\d\d-\d\dT.* only — totals are a lower bound$/)]);
  });

  it("portfolio: a capped history whose 200 rows all fall in the last 24 h is unknown (funding24h null, fundingIncomplete)", async () => {
    const { data } = await runJson(p => registerPortfolioCommand(p, async () => cappedVenue, () => true, "test"), ["-e", "pacifica", "--json", "portfolio"]);
    expect((data.exchanges as Array<Record<string, unknown>>)[0]).toMatchObject({ funding24h: null, fundingError: expect.stringContaining("reaches back to") });
    expect(data.totals).toMatchObject({ funding24h: 0, fundingIncomplete: true });
  });

  it("account pnl --period 30d: a capped funding history inside the period is flagged fundingIncomplete", async () => {
    const { data } = await runJson(p => registerAccountCommands(p, async () => cappedVenue, () => true), ["-e", "pacifica", "--json", "account", "pnl", "--period", "30d"]);
    expect(data).toMatchObject({ funding: -200, fundingPayments: 200, fundingIncomplete: true, tradesIncomplete: false });
  });
});
