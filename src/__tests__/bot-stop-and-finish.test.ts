/**
 * Live 2026-10-12 (Aster):
 *  20. `background stop` killed the tmux session at once — a quick-grid job's resting orders
 *      stayed live. Stop now SIGINTs the job's node process, waits, and only then kills ("forced").
 *  21. `quick-dca --orders 2` kept running after both orders: DCA reports isDone → the bot ends.
 *  22. delta-neutral read a $10 spot buy as a "daily loss" (perp equity only) and then paused
 *      300 s ignoring SIGINT: multi-venue equity counts spot holdings; the pause is interruptible.
 *  23. Bots print the positions they leave open at stop, with the close command.
 * Live 2026-10-13 (delta-neutral HL spot + Pacifica short, --json --headless):
 *  24. The stop summary omitted the HL spot leg and suggested closing the short alone: spot-perp
 *      bots list the spot holdings and suggest `arb close --spot-exch --perp-exch`; every
 *      openPositions entry of the JSON "done" line carries its `close` command.
 *  25. In JSON mode the stop summary went only to the log file: it is written to stderr.
 *  26. Equity was reported as 0 all run (a held HIP-4 outcome token has no spot price → botEquity
 *      throws): unknown equity is null, the reason is logged once, and no equity condition fires on it.
 *  27. The HIP-4 outcome token itself is valued at its outcome mid (getHoldingPrices, quoted in the
 *      venue's spot quote) — equity known; a token whose price can't be read keeps equity unknown.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  const st = { sessionAlive: true };
  const execFileSync = vi.fn((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "has-session") { if (!st.sessionAlive) throw new Error("no session"); return ""; }
    if (cmd === "tmux" && args[0] === "list-panes") return "4242\n";
    if (cmd === "tmux" && args[0] === "kill-session") { st.sessionAlive = false; return ""; }
    if (cmd === "ps") return "  4242     1 sh\n  4243  4242 node\n  4244  4242 tee\n";
    return "";
  });
  return { st, execFileSync };
});
const execFileSync = h.execFileSync;
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: h.execFileSync }));

// Bot spot venues: only the test's HL stub has a spot adapter (h.spot), created outside the factory.
const sp = vi.hoisted(() => ({ spot: null as unknown }));
vi.mock("../exchanges/spot-factory.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/spot-factory.js")>()),
  getBotSpotAdapter: async (name: string) => name === "hyperliquid" ? sp.spot : null,
  spotNetworkOf: () => "mainnet",
}));

const { stopJob } = await import("../jobs.js");
import "../exchanges/venues/index.js";
import { DCAStrategy } from "../bot/strategies/dca-strategy.js";
import { registerAdapterNetwork } from "../exchanges/adapter-network.js";
import { openPositionsAtStop, runBot, UNKNOWN_EQUITY_STOP_TICKS } from "../bot/engine.js";
import { evaluateCondition } from "../bot/conditions.js";
import type { BotConfig } from "../bot/config.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

function writeJob(id: string) {
  const dir = join(process.env.HOME as string, ".perp", "jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, strategy: "bot:grid", exchange: "aster", params: { symbol: "SOL" }, tmuxSession: `perp-${id}`, startedAt: "t", status: "running" }));
}

describe("background stop (20)", () => {
  beforeEach(() => { h.st.sessionAlive = true; execFileSync.mockClear(); });

  it("SIGINTs the job's node process (not tee) and reports graceful when it exits in time", async () => {
    writeJob("aaaa0001");
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig: string) => { expect([pid, sig]).toEqual([4243, "SIGINT"]); setTimeout(() => { h.st.sessionAlive = false; }, 100); return true; }) as never);
    const r = await stopJob("aaaa0001", 5_000);
    expect(r).toMatchObject({ outcome: "graceful", note: null });
    expect(execFileSync.mock.calls.some(c => (c[1] as string[])[0] === "kill-session")).toBe(false);
    kill.mockRestore();
  });

  it("a job that ignores SIGINT is killed after the timeout and reported as forced", async () => {
    writeJob("aaaa0002");
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const r = await stopJob("aaaa0002", 300);
    expect(r).toMatchObject({ outcome: "forced" });
    expect(r!.note).toMatch(/did not exit within/);
    expect(execFileSync.mock.calls.some(c => (c[1] as string[])[0] === "kill-session")).toBe(true);
    kill.mockRestore();
  });
});

describe("DCA isDone (21)", () => {
  it("done once total_orders were placed; 0 = never", async () => {
    const s = new DCAStrategy();
    const ctx = { config: { amount: 0.05, interval_sec: 1, total_orders: 2 }, state: new Map(), log: () => {}, symbol: "SOL" } as never;
    await s.init(ctx, {} as never);
    expect(s.isDone(ctx)).toBe(false);
    (ctx as { state: Map<string, unknown> }).state.set("dcaOrdersPlaced", 2);
    expect(s.isDone(ctx)).toBe(true);
    (ctx as { config: Record<string, unknown> }).config.total_orders = 0;
    expect(s.isDone(ctx)).toBe(false);
  });
});

describe("engine: DCA total ends the bot (21) and open positions are reported at stop (23)", () => {
  it("quick-dca 2 orders → both sent, the bot ends by itself, and the open position is logged with its close command", async () => {
    let pos = 0;
    const marketOrder = vi.fn(async () => { pos += 0.05; return { status: "FILLED", avgPrice: "109" }; });
    const a = {
      name: "aster",
      getMarkets: vi.fn(async () => [{ symbol: "SOL", markPrice: "109", indexPrice: "109", fundingRate: "0", volume24h: "1", openInterest: "1", maxLeverage: 10, stepSize: "0.01" }]),
      getKlines: vi.fn(async () => []), getOrderbook: vi.fn(async () => ({ bids: [], asks: [] })),
      getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
      getPositions: vi.fn(async () => pos > 0 ? [{ symbol: "SOL", side: "long", size: pos.toFixed(2), entryPrice: "109", markPrice: "109", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }] : []),
      getOpenOrders: vi.fn(async () => []), cancelAllOrders: vi.fn(async () => ({})), marketOrder,
    } as unknown as ExchangeAdapter;
    registerAdapterNetwork(a, "mainnet");
    vi.doMock("../bot/quote-rules.js", async (orig) => ({ ...(await orig<typeof import("../bot/quote-rules.js")>()), quoteRulesOf: async () => ({ tickSize: "0.01", stepSize: "0.01", minSize: null, minNotional: "5" }) }));
    const config: BotConfig = {
      name: "t-dca", exchange: "aster", symbol: "SOL", strategy: { type: "dca", amount: 0.05, interval_sec: 0, total_orders: 2, side: "buy" } as never,
      entry_conditions: [{ type: "always", value: 0 }], exit_conditions: [{ type: "time_after", value: 20 }],
      risk: { max_position_usd: 1000, max_daily_loss: 100, max_drawdown: 200, pause_after_loss_sec: 0, max_open_bots: 1 },
      monitor_interval_sec: 0.02,
    };
    const log = vi.fn();
    const t0 = Date.now();
    await runBot(a, config, undefined, log, undefined, "headless", false);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(marketOrder).toHaveBeenCalledTimes(2);
    const lines = log.mock.calls.map(c => String(c[0])).join("\n");
    expect(lines).toMatch(/SOL: long 0\.10 on aster — close: perp -e aster trade close SOL/);
  }, 20_000);
});

const bal = { equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" };
const pos = (symbol: string, side: "long" | "short", size: string) => ({ symbol, side, size, entryPrice: "42", markPrice: "42", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 });
function venue(name: string, positions: ReturnType<typeof pos>[]): ExchangeAdapter {
  return {
    name, isUnifiedAccount: true,
    getMarkets: vi.fn(async () => [{ symbol: "SOL", markPrice: "109", indexPrice: "109", fundingRate: "0", volume24h: "1", openInterest: "1", maxLeverage: 10, stepSize: "0.01" }]),
    getKlines: vi.fn(async () => []), getOrderbook: vi.fn(async () => ({ bids: [], asks: [] })),
    getBalance: vi.fn(async () => bal), getPositions: vi.fn(async () => positions),
    getOpenOrders: vi.fn(async () => []), cancelAllOrders: vi.fn(async () => ({})),
    marketOrder: vi.fn(async () => ({ status: "FILLED", avgPrice: "109" })),
  } as unknown as ExchangeAdapter;
}
const hlSpot = (balances: Array<{ token: string; total: string; shared?: boolean }>, markets: Array<{ baseToken: string; markPrice: string | null }>) => ({
  name: "hyperliquid-spot",
  getSpotBalances: vi.fn(async () => balances.map(b => ({ ...b, available: b.total, held: "0" }))),
  getSpotMarkets: vi.fn(async () => markets.map(m => ({ ...m, quoteToken: "USDC", symbol: `${m.baseToken}/USDC` }))),
});

describe("stop summary of a spot-perp bot (24)", () => {
  it("a spot holding + a perp short of one symbol is one pair closed with arb close --spot-exch/--perp-exch; tokens without a spot market are not listed", async () => {
    sp.spot = hlSpot([{ token: "HYPE", total: "0.1301" }, { token: "USDC", total: "5" }, { token: "+14881", total: "3" }], [{ baseToken: "HYPE", markPrice: "42" }]);
    const hl = venue("hyperliquid", []);
    const pac = venue("pacifica", [pos("HYPE", "short", "0.13")]);
    const log = vi.fn();
    const out = await openPositionsAtStop(hl, "ALL", new Map([["hyperliquid", hl], ["pacifica", pac]]), log, true);
    const close = "perp arb close HYPE --spot-exch hyperliquid --perp-exch pacifica";
    expect(out).toEqual([
      { exchange: "pacifica", symbol: "HYPE", side: "short", size: "0.13", close },
      { exchange: "hyperliquid", symbol: "HYPE", side: "spot", size: "0.1301", close },
    ]);
    const lines = log.mock.calls.map(c => String(c[0])).join("\n");
    expect(lines).toContain(`HYPE: spot 0.1301 on hyperliquid / short 0.13 on pacifica — close the pair: ${close}`);
    expect(lines).not.toMatch(/trade close HYPE/);
  });

  it("an unhedged spot leg is listed with its spot-sell command; a non-spot bot never lists spot", async () => {
    sp.spot = hlSpot([{ token: "HYPE", total: "0.13" }], [{ baseToken: "HYPE", markPrice: "42" }]);
    const hl = venue("hyperliquid", []);
    expect(await openPositionsAtStop(hl, "ALL", new Map([["hyperliquid", hl]]), () => {}, true))
      .toEqual([{ exchange: "hyperliquid", symbol: "HYPE", side: "spot", size: "0.13", close: "perp -e hyperliquid trade spot-sell HYPE 0.13" }]);
    expect(await openPositionsAtStop(hl, "ALL", new Map([["hyperliquid", hl]]), () => {}, false)).toEqual([]);
  });

  it("a perp-perp pair keeps arb close --pair; a lone perp keeps trade close", async () => {
    sp.spot = null;
    const a = venue("aster", [pos("SOL", "long", "1"), pos("ETH", "long", "2")]);
    const b = venue("lighter", [pos("SOL", "short", "1")]);
    const out = await openPositionsAtStop(a, "ALL", new Map([["lighter", b]]), () => {}, true);
    expect(out.map(p => p.close)).toEqual(["perp arb close SOL --pair aster:lighter", "perp -e aster trade close ETH", "perp arb close SOL --pair aster:lighter"]);
  });
});

function dcaConfig(name: string): BotConfig {
  return {
    name, exchange: "aster", symbol: "SOL", strategy: { type: "dca", amount: 0.05, interval_sec: 0, total_orders: 1, side: "buy" } as never,
    entry_conditions: [{ type: "always", value: 0 }], exit_conditions: [{ type: "time_after", value: 20 }],
    risk: { max_position_usd: 1000, max_daily_loss: 1, max_drawdown: 1, pause_after_loss_sec: 0, max_open_bots: 1 },
    monitor_interval_sec: 0.02,
  };
}

describe("JSON mode stop summary (25) and unknown equity (26)", () => {
  vi.doMock("../bot/quote-rules.js", async (orig) => ({ ...(await orig<typeof import("../bot/quote-rules.js")>()), quoteRulesOf: async () => ({ tickSize: "0.01", stepSize: "0.01", minSize: null, minNotional: "5" }) }));

  it("--json: the stop summary reaches stderr; the done line's openPositions carry `close`", async () => {
    sp.spot = null;
    const a = venue("aster", [pos("SOL", "long", "0.05")]);
    registerAdapterNetwork(a, "mainnet");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runBot(a, dcaConfig("t-json-stop"), undefined, () => {}, undefined, "json", false);
      const err = stderr.mock.calls.map(c => String(c[0])).join("");
      expect(err).toMatch(/Open positions at stop/);
      expect(err).toMatch(/SOL: long 0\.05 on aster — close: perp -e aster trade close SOL/);
      const done = stdout.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("{")).map(l => JSON.parse(l)).find(j => j.event === "done");
      expect(done.openPositions).toEqual([{ exchange: "aster", symbol: "SOL", side: "long", size: "0.05", close: "perp -e aster trade close SOL" }]);
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  }, 20_000);

  it("an unpriced spot token makes equity unknown: null in every status line and the done line, reason logged once, no risk stop", async () => {
    sp.spot = hlSpot([{ token: "+14881", total: "3" }], []);
    const a = venue("aster", []);
    const hl = venue("hyperliquid", []);
    registerAdapterNetwork(a, "mainnet");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Deterministic (no wall-clock exit): the run ends by itself after exactly
      // UNKNOWN_EQUITY_STOP_TICKS ticks of unknown equity — one status line per tick.
      const cfg = { ...dcaConfig("t-eq-null"), exit_conditions: [{ type: "time_after" as const, value: 3600 }], strategy: { type: "dca", amount: 0.05, interval_sec: 3600, total_orders: 0, side: "buy" } as never };
      await expect(runBot(a, cfg, undefined, () => {}, new Map([["hyperliquid", hl]]), "json", false))
        .rejects.toThrow(new RegExp(`equity unknown for ${UNKNOWN_EQUITY_STOP_TICKS} consecutive ticks`));
      const json = stdout.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("{")).map(l => JSON.parse(l));
      const status = json.filter(j => j.event === undefined);
      expect(status).toHaveLength(UNKNOWN_EQUITY_STOP_TICKS);
      for (const j of status) expect(j).toMatchObject({ equity: null, peakEquity: null });
      // Entries are blocked while equity is unknown: the DCA never sends an order.
      expect(a.marketOrder).not.toHaveBeenCalled();
      expect(json.find(j => j.event === "done")).toMatchObject({ equity: null, peakEquity: null });
      const warnings = stderr.mock.calls.map(c => String(c[0])).filter(l => /equity reported as unknown/.test(l));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/no market price/);
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  }, 20_000);

  it("a held HIP-4 outcome token priced by getHoldingPrices (USDC quote) is valued: equity known; a non-quote-asset price stays unknown", async () => {
    const holding = (quoteToken: string | null) => ({
      ...hlSpot([{ token: "+14881", total: "3" }], [{ baseToken: "HYPE", markPrice: "42" }]),
      getHoldingPrices: vi.fn(async (tokens: readonly string[]) => tokens.map(token => ({ token, quoteToken, markPrice: "0.9" }))),
    });
    const a = venue("aster", []);
    const hl = venue("hyperliquid", []);
    registerAdapterNetwork(a, "mainnet");
    const cfg = { ...dcaConfig("t-eq-hip4"), exit_conditions: [{ type: "time_after" as const, value: 0.3 }], strategy: { type: "dca", amount: 0.05, interval_sec: 3600, total_orders: 0, side: "buy" } as never };
    const run = async () => {
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        // Unknown equity all run ends the run with an error after UNKNOWN_EQUITY_STOP_TICKS; the done line is printed first.
        await runBot(a, cfg, undefined, () => {}, new Map([["hyperliquid", hl]]), "json", false).catch((e: unknown) => {
          if (!/equity unknown for/.test(String(e))) throw e;
        });
        return stdout.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("{")).map(l => JSON.parse(l)).find(j => j.event === "done");
      } finally { stdout.mockRestore(); stderr.mockRestore(); }
    };
    sp.spot = holding("USDC");
    // aster 100 + hyperliquid 100 (unified: spot USDC shared) + 3 × 0.9 outcome tokens
    expect((await run()).equity).toBeCloseTo(202.7, 6);
    expect((sp.spot as ReturnType<typeof holding>).getHoldingPrices).toHaveBeenCalledWith(["+14881"]);
    sp.spot = holding("USDH");
    expect((await run()).equity).toBeNull();
  }, 20_000);

  it("multi-venue equity skips the spot rows a venue marks shared (already in its equity: HL portfolio-margin collateral)", async () => {
    sp.spot = hlSpot([{ token: "HYPE", total: "1", shared: true }, { token: "PURR", total: "10", shared: false }], [{ baseToken: "HYPE", markPrice: "42" }, { baseToken: "PURR", markPrice: "0.2" }]);
    const a = venue("aster", []);
    const hl = venue("hyperliquid", []);
    registerAdapterNetwork(a, "mainnet");
    const cfg = { ...dcaConfig("t-eq-shared"), exit_conditions: [{ type: "time_after" as const, value: 0.3 }], strategy: { type: "dca", amount: 0.05, interval_sec: 3600, total_orders: 0, side: "buy" } as never };
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runBot(a, cfg, undefined, () => {}, new Map([["hyperliquid", hl]]), "json", false);
      const done = stdout.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("{")).map(l => JSON.parse(l)).find(j => j.event === "done");
      // aster 100 + hyperliquid 100 (its equity holds the HYPE collateral) + 10 PURR × 0.2
      expect(done.equity).toBeCloseTo(202, 6);
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  }, 20_000);

  it("equity conditions never fire on unknown equity", () => {
    const snap = { price: 1, volatility24h: 0, fundingRate: 0, rsi: NaN, spreadPct: 0 } as never;
    const ctx = { equity: null, peakEquity: null, startTime: Date.now(), dailyPnl: 0 };
    for (const type of ["balance_below", "balance_above", "max_drawdown"] as const) {
      expect(evaluateCondition({ type, value: 50 } as never, snap, ctx)).toBe(false);
    }
    expect(evaluateCondition({ type: "balance_below", value: 50 } as never, snap, { ...ctx, equity: 10, peakEquity: 10 })).toBe(true);
  });
});
