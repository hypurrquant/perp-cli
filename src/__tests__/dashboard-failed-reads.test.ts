/**
 * Dashboard: a failed venue read is shown as unavailable / stale — never as a $0 balance,
 * an empty position list, or a 0 PnL (audit H5 / M8). No network: adapters are mocks and the
 * file cache is bypassed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExchangeAdapter, ExchangeBalance } from "../exchanges/interface.js";

vi.mock("../cache.js", () => ({
  TTL_ACCOUNT: 1,
  withCache: async <T>(_k: string, _t: number, fetcher: () => Promise<T>) => fetcher(),
  setCached: vi.fn(),
}));

import { mergeAndTotal, readExchangesRest, type DashboardExchangeData } from "../dashboard/server.js";
import { WsFeedManager, isFeedStale, FEED_STALE_MS, type WsFeedState } from "../dashboard/ws-feeds.js";

const BAL: ExchangeBalance = { equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "5" };

function adapter(name: string, over: Partial<Record<"getBalance" | "getPositions" | "getOpenOrders", () => Promise<unknown>>> = {}): ExchangeAdapter {
  return {
    name,
    getBalance: over.getBalance ?? (async () => BAL),
    getPositions: over.getPositions ?? (async () => []),
    getOpenOrders: over.getOpenOrders ?? (async () => []),
  } as unknown as ExchangeAdapter;
}

function entry(name: string, over: Partial<DashboardExchangeData> = {}): DashboardExchangeData {
  return { name, balance: { ...BAL }, positions: [], orders: [], topMarkets: [], marketsError: null, error: null, ...over };
}

let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;
afterEach(() => { stderrSpy?.mockRestore(); stderrSpy = null; });

describe("dashboard REST snapshot (pollSnapshot path)", () => {
  it("a failed balance / positions read is null + error, not $0 / []", async () => {
    const data = await readExchangesRest([
      { name: "pacifica", adapter: adapter("pacifica", { getBalance: async () => { throw new Error("HTTP 502"); } }) },
      { name: "lighter", adapter: adapter("lighter", { getPositions: async () => { throw new Error("timeout"); } }) },
    ]);
    const pac = data.find(d => d.name === "pacifica")!;
    expect(pac.balance).toBeNull();
    expect(pac.positions).toEqual([]);
    expect(pac.error).toContain("balance: HTTP 502");
    const lit = data.find(d => d.name === "lighter")!;
    expect(lit.positions).toBeNull();
    expect(lit.balance).toEqual(BAL);
    expect(lit.error).toContain("positions: timeout");

    const snap = mergeAndTotal(data);
    expect(snap.totals.equity).toBe(1000); // lighter only — pacifica is unknown, not 0
    expect(snap.totals.partial).toBe(true);
    expect(snap.totals.unavailable).toEqual(["pacifica.balance", "lighter.positions"]);
  });

  it("everything read → partial false", () => {
    const snap = mergeAndTotal([entry("pacifica"), entry("lighter")]);
    expect(snap.totals).toMatchObject({ equity: 2000, unrealizedPnl: 10, partial: false, unavailable: [] });
  });

  it("an unknown unrealized PnL is skipped in the total and listed", () => {
    const snap = mergeAndTotal([entry("pacifica", { balance: { ...BAL, unrealizedPnl: null } }), entry("lighter")]);
    expect(snap.totals.unrealizedPnl).toBe(5);
    expect(snap.totals.equity).toBe(2000);
    expect(snap.totals.unavailable).toEqual(["pacifica.unrealizedPnl"]);
  });

  it("an unread HIP-3 dex list is not merged as empty: listed and noted on the HL entry", () => {
    const snap = mergeAndTotal([
      entry("hyperliquid", { positions: [{ symbol: "BTC", side: "long", size: "1", entryPrice: "1", markPrice: "1", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }] }),
      entry("hl:xyz", { positions: null, balance: null, error: "positions: HTTP 500" }),
    ]);
    expect(snap.exchanges).toHaveLength(1);
    const hl = snap.exchanges[0];
    expect(hl.positions).toHaveLength(1);
    expect(hl.error).toContain("hl:xyz");
    expect(hl.balance!.unrealizedPnl).toBeNull(); // dex PnL unknown → merged PnL unknown
    expect(snap.totals.unavailable).toEqual(expect.arrayContaining(["hl:xyz.balance", "hl:xyz.positions"]));
  });
});

describe("dashboard live feeds — stale / error tracking", () => {
  const base: WsFeedState = { balance: null, positions: null, orders: null, lastUpdate: 0, mode: "rest", lastOkAt: null, lastError: null, lastErrorAt: null };

  it("isFeedStale: never read, error newer than last success, or data too old (polled or live)", () => {
    const now = 1_000_000;
    expect(isFeedStale(base, now)).toBe(true);
    expect(isFeedStale({ ...base, lastOkAt: now - 1000 }, now)).toBe(false);
    expect(isFeedStale({ ...base, lastOkAt: now - 1000, lastErrorAt: now - 500, lastError: "x" }, now)).toBe(true);
    expect(isFeedStale({ ...base, lastOkAt: now - FEED_STALE_MS - 1 }, now)).toBe(true);
    expect(isFeedStale({ ...base, mode: "ws", lastOkAt: now - FEED_STALE_MS - 1 }, now)).toBe(true); // an open socket is no proof
  });

  it("a failing REST poll leaves the data null (not $0) and records lastError; logged once", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mgr = new WsFeedManager(
      [{ name: "aster", adapter: adapter("aster", { getBalance: async () => { throw new Error("HTTP 503"); } }) }],
      { onUpdate: () => {} },
    );
    try {
      await mgr.start();
      await vi.waitFor(() => expect(mgr.getState("aster")!.lastError).toBe("rest-poll: HTTP 503"));
      const st = mgr.getState("aster")!;
      expect(st.balance).toBeNull();
      expect(st.positions).toBeNull();
      expect(isFeedStale(st)).toBe(true);
      expect(stderrSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("aster rest-poll failed")).length).toBe(1);
    } finally {
      mgr.close();
    }
  });

  it("a feed that has not read anything yet holds null, not a $0 placeholder", async () => {
    const mgr = new WsFeedManager([{ name: "aster", adapter: adapter("aster") }], { onUpdate: () => {} });
    try {
      // Not started: no data yet.
      const st = mgr.getState("aster")!;
      expect(st.balance).toBeNull();
      expect(st.lastOkAt).toBeNull();
    } finally {
      mgr.close();
    }
  });

  it("Pacifica WS positions: no mark → PnL null (not 0); a row without amount is reported, not dropped silently", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mgr = new WsFeedManager([{ name: "pacifica", adapter: adapter("pacifica") }], { onUpdate: () => {} });
    try {
      const feed = (mgr as unknown as { feeds: Map<string, { handlePositions(d: unknown): void; getState(): WsFeedState }> }).feeds.get("pacifica")!;
      feed.handlePositions([
        { s: "BTC", d: "bid", a: "0.5", p: "60000" },
        { s: "ETH", d: "ask" }, // no amount
      ]);
      const st = feed.getState();
      expect(st.positions).toHaveLength(1);
      expect(st.positions![0]).toMatchObject({ symbol: "BTC", side: "long", entryPrice: "60000", markPrice: null, unrealizedPnl: null });
      expect(st.lastError).toMatch(/^ws-account_positions: position row without symbol\/amount/);
      expect(stderrSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("pacifica ws-account_positions failed"))).toBe(true);
    } finally {
      mgr.close();
    }
  });

  it("repeated failures are logged on the first and every 20th — not on every poll", () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mgr = new WsFeedManager([{ name: "pacifica", adapter: adapter("pacifica") }], { onUpdate: () => {} });
    try {
      const feed = (mgr as unknown as { feeds: Map<string, { recordError(s: string, e: unknown): void }> }).feeds.get("pacifica")!;
      for (let i = 0; i < 40; i++) feed.recordError("rest-poll", new Error("down"));
      expect(stderrSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("pacifica rest-poll failed")).length).toBe(3); // 1st, 20th, 40th
    } finally {
      mgr.close();
    }
  });
});
