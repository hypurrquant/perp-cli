/**
 * QFEX read path (0.15.1), on real mainnet responses recorded 2026-10-16..19
 * (fixtures/qfex/*-status-2026-10-19.json, funding-*.json):
 *  - funding history: a window outside the market's funding hours (docs.qfex.com/qfex/funding:
 *    "Funding is only active during a symbol's configured market_hours", rate 0 outside) is
 *    `rate: null, marketClosed: true`, not a "0" rate; the bot scorer skips those windows;
 *  - /refdata DELISTED (EUR-USD) and INACTIVE (USD-JPY, ZHIPU-HKD) markets: tradable false with
 *    their status, and every per-symbol read refuses them;
 *  - non-USD markets: the 24h notional is in the quote currency (SAMSUNG-KRW: KRW), so
 *    volume24h (USD) is null and the local figure is volume24hQuote, labelled by quoteAsset;
 *  - market info: the current (unverified, labelled) funding rate, consistent with market funding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { Command } from "commander";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

const marketStats = vi.fn();
vi.mock("../../exchanges/qfex/ws-transport.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/qfex/ws-transport.js")>()),
  fetchQfexMarketStats: (...a: unknown[]) => marketStats(...a),
}));

import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { READ_ONLY_CREDENTIALS } from "../../exchanges/venue.js";
import { qfexVenue } from "../../exchanges/venues/qfex.js";
import { QfexAdapter } from "../../exchanges/qfex/adapter.js";
import { parseMarketStats } from "../../exchanges/qfex/ws-transport.js";
import { scoreFunding } from "../../bot/strategies/funding-arb-utils.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import { registerMarketCommands } from "../../commands/market.js";

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/qfex/${name}`, import.meta.url), "utf8"));
const REFDATA = fx("refdata-status-2026-10-19.json");
const CONTRACTS = fx("contracts-status-2026-10-19.json");
const MDS = fx("mds-market-stats-status-2026-10-19.json") as Record<string, unknown>;
const FUNDING_AAPL_WEEKEND = fx("funding-aapl-weekend-2026-10-19.json"); // Fri 2026-10-16 18:00Z → Mon 10:00Z
const FUNDING_SAMSUNG_FRI = fx("funding-samsung-2026-10-16.json"); // Fri 2026-10-16 00:00Z → 22:00Z

let routes: Record<string, unknown>;
let requests: URL[];

function reply(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
}

function adapter(): QfexAdapter {
  return new QfexAdapter(qfexVenue, { network: "mainnet", credentials: READ_ONLY_CREDENTIALS, noAgent: false, hlDex: null, readOnly: true, noBuilder: false });
}

async function rejection(p: Promise<unknown>): Promise<PerpError> {
  try { await p; } catch (e) { return e as PerpError; }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  requests = [];
  routes = { "/refdata": REFDATA, "/md/contracts": CONTRACTS };
  marketStats.mockReset();
  marketStats.mockImplementation(async () => parseMarketStats(MDS));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const body = routes[url.pathname];
    if (body === undefined) throw new Error(`unexpected request ${url.href}`);
    return reply(body);
  }));
});

describe("QFEX funding history: closed market hours", () => {
  it("AAPL-USD weekend windows are rate null + marketClosed, trading-hour windows keep their rate", async () => {
    routes["/funding/AAPL-USD"] = FUNDING_AAPL_WEEKEND;
    const h = await adapter().getFundingHistory("AAPL", 65);
    expect(h).toHaveLength(65);
    const at = (iso: string) => h.find(r => r.time === Date.parse(iso));
    // Window labelled T = the hour before T. Sat 00:00Z = Fri 19:00–20:00 ET (post_market): funded.
    expect(at("2026-10-17T00:00:00Z")).toEqual({ time: Date.parse("2026-10-17T00:00:00Z"), rate: "0.00000687", price: null, intervalHours: 1, rateKind: "lastSettled", marketClosed: false });
    // Fri 20:00 ET → Sun 20:00 ET (weekend session): the venue printed 0 — no funding.
    expect(at("2026-10-17T01:00:00Z")).toEqual({ time: Date.parse("2026-10-17T01:00:00Z"), rate: null, price: null, intervalHours: 1, rateKind: null, marketClosed: true });
    expect(at("2026-10-19T00:00:00Z")).toMatchObject({ rate: null, marketClosed: true });
    // Sun 20:00–21:00 ET: funding resumes (docs: US equities Sunday 20:00 – Friday 20:00 ET).
    expect(at("2026-10-19T01:00:00Z")).toMatchObject({ rate: "-0.00000007", marketClosed: false });
    expect(h.filter(r => r.marketClosed === true)).toHaveLength(48);
    expect(h.some(r => r.rate === "0")).toBe(false);
  });

  it("SAMSUNG-KRW: only the KRX session (09:00–15:30 KST) funds; the zeros around it are closed", async () => {
    routes["/funding/SAMSUNG-KRW"] = FUNDING_SAMSUNG_FRI;
    const h = await adapter().getFundingHistory("SAMSUNG-KRW", 24);
    const open = h.filter(r => r.marketClosed === false).map(r => new Date(r.time).toISOString().slice(11, 13));
    expect(open).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
    expect(h.filter(r => r.marketClosed === true).every(r => r.rate === null)).toBe(true);
  });

  it("a 0 printed inside a trading session stays a real 0 (AAPL-USD Tue 2026-10-13 11:00–12:00 ET)", async () => {
    routes["/funding/AAPL-USD"] = { data: [{ symbol: "AAPL-USD", intervalMinutes: 60, windowStart: "2026-10-13T16:00:00Z", rate: 0 }] };
    expect(await adapter().getFundingHistory("AAPL", 1)).toEqual([
      { time: Date.parse("2026-10-13T16:00:00Z"), rate: "0", price: null, intervalHours: 1, rateKind: "lastSettled", marketClosed: false },
    ]);
  });

  it("the funding scorer averages only the funded windows (closed hours are not 0s)", async () => {
    routes["/funding/AAPL-USD"] = FUNDING_AAPL_WEEKEND;
    const a = adapter();
    const score = await scoreFunding(a as unknown as ExchangeAdapter, "AAPL", "qfex", 65);
    const funded = (await a.getFundingHistory("AAPL", 65)).filter(r => r.marketClosed === false).map(r => Number(r.rate));
    expect(score?.payments).toBe(17);
    expect(score?.avgRate).toBeCloseTo(funded.reduce((s, r) => s + r, 0) / funded.length, 15);
  });
});

describe("QFEX listing state", () => {
  it("DELISTED / INACTIVE markets are tradable false with their /refdata status; fundingRate null", async () => {
    const rows = await adapter().getMarkets();
    const by = (s: string) => rows.find(m => m.symbol === s);
    expect(by("EUR")).toMatchObject({ tradable: false, status: "DELISTED", fundingRate: null });
    expect(by("USD-JPY")).toMatchObject({ tradable: false, status: "INACTIVE", fundingRate: null });
    expect(by("ZHIPU-HKD")).toMatchObject({ tradable: false, status: "INACTIVE" });
    expect(by("AAPL")).toMatchObject({ tradable: true, status: "ACTIVE", quoteAsset: "USD" });
  });

  it("every per-symbol read of a non-ACTIVE market refuses with one error, before any market-data request", async () => {
    const a = adapter();
    const cases: Array<[() => Promise<unknown>, string, string]> = [
      [() => a.getOrderbook("EUR"), "EUR-USD", "DELISTED"],
      [() => a.getFundingHistory("EUR-USD", 5), "EUR-USD", "DELISTED"],
      [() => a.getKlines("USD-JPY", "1h", 0, 3_600_000), "USD-JPY", "INACTIVE"],
      [() => a.getMarketInfo("zhipu-hkd"), "ZHIPU-HKD", "INACTIVE"],
    ];
    for (const [read, sym, status] of cases) {
      requests = [];
      const e = await rejection(read());
      expect(e.structured).toMatchObject({ code: "SYMBOL_NOT_FOUND", details: expect.objectContaining({ status }) });
      expect(e.message).toBe(`QFEX ${sym} is ${status.toLowerCase()} (status ${status}) — not a live market`);
      expect(requests.every(u => u.pathname === "/refdata")).toBe(true);
    }
  });
});

describe("QFEX non-USD markets", () => {
  it("SAMSUNG-KRW: prices and the 24h notional are KRW → volume24h null, volume24hQuote labelled by quoteAsset", async () => {
    const krw = (await adapter().getMarkets()).find(m => m.symbol === "SAMSUNG-KRW");
    expect(krw).toMatchObject({ quoteAsset: "KRW", volume24h: null, volume24hQuote: "9827529.912", markPrice: "221580" });
    const usd = (await adapter().getMarkets()).find(m => m.symbol === "AAPL");
    expect(usd).toMatchObject({ volume24h: "1624169.13611", volume24hQuote: "1624169.13611" });
  });
});

describe("QFEX market info funding", () => {
  it("shows the current /md/contracts rate, labelled unverified (market list stays null)", async () => {
    const info = await adapter().getMarketInfo("AAPL");
    expect(info).toMatchObject({ symbol: "AAPL", fundingRate: "0.00000048", fundingVerified: false, status: "ACTIVE", tradable: true });
    expect(info.fundingNote).toMatch(/UNVERIFIED/);
  });
});

describe("QFEX text output", () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function run(...args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMarketCommands(program, async () => adapter() as unknown as ExchangeAdapter, () => false);
    await program.parseAsync(["node", "perp", ...args]);
    // eslint-disable-next-line no-control-regex
    return out.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  }

  it("KRW prices carry the currency, never a $ (market info, market list)", async () => {
    const info = await run("market", "info", "SAMSUNG-KRW");
    expect(info).toContain("Mark Price:     221,580.00 KRW");
    expect(info).toContain("24h Volume:     9,827,529.91 KRW");
    expect(info).toMatch(/UNVERIFIED/);
    expect(info).not.toMatch(/\$221/);
    const list = await run("market", "list");
    expect(list).toContain("221,580.00 KRW");
    expect(list).toContain("$342.31");
  });

  it("market funding prints closed windows as \"market closed\", not +0.0000%", async () => {
    routes["/funding/AAPL-USD"] = FUNDING_AAPL_WEEKEND;
    const text = await run("market", "funding", "AAPL", "-l", "65");
    expect(text.match(/market closed/g)).toHaveLength(48);
    expect(text).not.toMatch(/│ 0\.0000%/); // a closed window printed as a 0 rate (0.15.0)
  });
});

describe("QFEX non-USD candles", () => {
  // Probe 2026-10-19 11:00–11:01Z: 1m candle usdVolume == Σ price × size of the MDS `trade` tape (KRW).
  const PROBE = fx("samsung-krw-candles-trades-2026-10-19.json") as {
    candles: { candles: Array<{ startedAt: string; usdVolume: string }> };
    trades: Array<{ time: string; price: string; size: string }>;
  };

  it("the recorded usdVolume is the KRW trade notional (probe), so quoteVolume (USD) is null", async () => {
    for (const c of PROBE.candles.candles) {
      const minute = c.startedAt.slice(0, 16);
      const krw = PROBE.trades.filter(t => t.time.startsWith(minute)).reduce((s, t) => s + Number(t.price) * Number(t.size), 0);
      expect(Number(c.usdVolume)).toBeCloseTo(krw, 3);
    }
    routes["/candles/SAMSUNG-KRW"] = PROBE.candles;
    const k = await adapter().getKlines("SAMSUNG-KRW", "1m", Date.parse("2026-10-19T11:00:00Z"), Date.parse("2026-10-19T11:02:00Z"));
    expect(k).toHaveLength(2);
    expect(k.every(r => r.quoteVolume === null)).toBe(true);
  });
});
