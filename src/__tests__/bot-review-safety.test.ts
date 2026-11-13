/**
 * Review findings (PR #18) — bot engine, bot strategies, DCA / TWAP, quarantine network scope:
 *  3. funding-arb-v2 recovers held pairs at init (unpaired / mismatched → quarantine); the engine
 *     runs strategy.onStop on every stop path (SIGINT included), exactly once.
 *  4. DCA / TWAP: ORDER_PENDING stops the run + quarantines; unknown fill → ORDER_PENDING; a
 *     failed price-limit read skips the order; TWAP counts the venue-reported fill.
 *  5. funding-arb recovery quarantines single legs and size-mismatched pairs.
 *  6. unknown equity blocks opening orders (reduce-only still sent) and stops after N ticks.
 *  7. a failed start's leftover orders are cancelled before the retry.
 *  9. a multi-symbol ("ALL") bot never sends an account-wide cancel.
 * 11. quarantine entries are network-scoped (legacy entries = mainnet).
 * 12. a failed orderbook / klines read skips the tick of a strategy that reads them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

vi.mock("../exchanges/spot-factory.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/spot-factory.js")>()),
  getBotSpotAdapter: vi.fn(async () => null),
}));
vi.mock("../bot/quote-rules.js", async (orig) => ({
  ...(await orig<typeof import("../bot/quote-rules.js")>()),
  quoteRulesOf: async () => ({ tickSize: "0.01", stepSize: "0.01", minSize: null, minNotional: null }),
}));
vi.mock("../execution-log.js", () => ({ logExecution: vi.fn(), pruneExecutionLog: vi.fn() }));

import "../exchanges/venues/index.js";
import { runBot, UNKNOWN_EQUITY_STOP_TICKS } from "../bot/engine.js";
import { registerStrategy } from "../bot/strategy-registry.js";
import type { BotConfig } from "../bot/config.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type { StrategyAction, StrategyContext } from "../bot/strategy-types.js";
import { FundingArbV2Strategy } from "../bot/strategies/funding-arb-v2.js";
import { FundingArbStrategy } from "../bot/strategies/funding-arb-strategy.js";
import {
  quarantineFile, clearQuarantine, isQuarantined, listQuarantine, quarantineEntryFor, quarantineSymbol,
  resetQuarantineNetwork, setQuarantineNetwork,
} from "../bot/quarantine.js";
import { runDCA } from "../strategies/dca.js";
import { runTWAP } from "../strategies/twap.js";
import { PerpError } from "../errors.js";

const noop = () => {};

beforeEach(() => {
  rmSync(quarantineFile(), { force: true });
  resetQuarantineNetwork();
});
afterEach(() => resetQuarantineNetwork());

function venue(name: string, over: Record<string, unknown> = {}): ExchangeAdapter {
  return {
    name,
    getMarkets: vi.fn(async () => [{ symbol: "ETH", markPrice: "100", indexPrice: "100", fundingRate: "0", volume24h: "1", openInterest: "1", maxLeverage: 10 }]),
    getKlines: vi.fn(async () => []),
    getOrderbook: vi.fn(async () => ({ bids: [], asks: [] })),
    getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    cancelAllOrders: vi.fn(async () => ({})),
    limitOrder: vi.fn(async () => ({ status: "open", filledSize: "0" })),
    marketOrder: vi.fn(async (_s: string, _side: string, size: string) => ({ status: "filled", filledSize: size })),
    getFundingPayments: vi.fn(async () => []),
    ...over,
  } as unknown as ExchangeAdapter;
}

function config(type: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    name: `t-${type}`, exchange: "hyperliquid", symbol: "ETH", strategy: { type } as never,
    entry_conditions: [{ type: "always", value: 0 }], exit_conditions: [{ type: "time_after", value: 3600 }],
    risk: { max_position_usd: 1000, max_daily_loss: 1e9, max_drawdown: 1e9, pause_after_loss_sec: 0, max_open_bots: 1 },
    monitor_interval_sec: 0.01,
    ...over,
  };
}

const limit = (side: "buy" | "sell", reduceOnly: boolean): StrategyAction => ({ type: "place_order", side, price: "100", size: "1", orderType: "limit", reduceOnly });

/** The engine's own SIGINT listener (added by runBot), called directly — no real signal is raised. */
async function engineSigint(before: Set<Function>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const added = process.listeners("SIGINT").filter(l => !before.has(l));
    if (added.length > 0) { for (const l of added) (l as () => void)(); return; }
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("engine SIGINT listener not found");
}

describe("engine: onStop on every stop path (3)", () => {
  it("SIGINT while running → strategy.onStop runs once, then the bot's orders are cancelled", async () => {
    const onStop = vi.fn(async () => [] as StrategyAction[]);
    let started!: () => void;
    const startedP = new Promise<void>(r => { started = r; });
    registerStrategy("t-sigint", () => ({ name: "t-sigint", init: async () => {}, onTick: async () => { started(); return []; }, onStop } as never));
    const a = venue("hyperliquid");
    const before = new Set<Function>(process.listeners("SIGINT"));
    const run = runBot(a, config("t-sigint"), undefined, noop, undefined, "headless", false);
    await startedP;
    await engineSigint(before);
    await run;
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(a.cancelAllOrders).toHaveBeenCalledWith("ETH");
    expect((onStop.mock.invocationCallOrder[0])).toBeLessThan((a.cancelAllOrders as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it("an exit (time_after) runs onStop in the exit phase — the shutdown path does not run it again", async () => {
    const onStop = vi.fn(async () => [] as StrategyAction[]);
    registerStrategy("t-once", () => ({ name: "t-once", init: async () => {}, onTick: async () => [], onStop } as never));
    await runBot(venue("hyperliquid"), config("t-once", { exit_conditions: [{ type: "time_after", value: 0.05 }] }), undefined, noop, undefined, "headless", false);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("engine: unknown equity (6)", () => {
  it("opening orders are dropped (reduce-only still sent) while equity is unknown; the bot stops after UNKNOWN_EQUITY_STOP_TICKS", async () => {
    let unknown = false;
    let reads = 0;
    const sent: Array<{ reduceOnly: boolean; unknown: boolean }> = [];
    const a = venue("hyperliquid", {
      // Start read + 2 tick reads known, then every read fails.
      getBalance: vi.fn(async () => {
        if (++reads > 3) { unknown = true; throw new Error("balance down"); }
        return { equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" };
      }),
      limitOrder: vi.fn(async (_s: string, _side: string, _p: string, _sz: string, o: { reduceOnly?: boolean }) => {
        sent.push({ reduceOnly: o.reduceOnly === true, unknown });
        return { status: "open", filledSize: "0" };
      }),
    });
    registerStrategy("t-eq", () => ({ name: "t-eq", init: async () => {}, onTick: async () => [limit("buy", false), limit("sell", true)], onStop: async () => [] } as never));
    await expect(runBot(a, config("t-eq"), undefined, noop, undefined, "headless", false))
      .rejects.toThrow(new RegExp(`equity unknown for ${UNKNOWN_EQUITY_STOP_TICKS} consecutive ticks`));
    expect(sent.some(o => !o.unknown && !o.reduceOnly)).toBe(true); // entries while known
    expect(sent.some(o => o.unknown && o.reduceOnly)).toBe(true); // reduce-only kept while unknown
    expect(sent.filter(o => o.unknown && !o.reduceOnly)).toEqual([]); // no opening order while unknown
  });

  it("equity unknown from the start → the strategy is never started (no entry)", async () => {
    const init = vi.fn(async () => {});
    registerStrategy("t-eq0", () => ({ name: "t-eq0", init, onTick: async () => [limit("buy", false)], onStop: async () => [] } as never));
    const a = venue("hyperliquid", { getBalance: vi.fn(async () => { throw new Error("down"); }) });
    await expect(runBot(a, config("t-eq0"), undefined, noop, undefined, "headless", false)).rejects.toThrow(/equity unknown/);
    expect(init).not.toHaveBeenCalled();
    expect(a.limitOrder).not.toHaveBeenCalled();
  });
});

describe("engine: failed start cleanup (7)", () => {
  it("a start that failed after its first order cancels the leftovers before the retry (no stacked batch)", async () => {
    let n = 0;
    const a = venue("hyperliquid", {
      limitOrder: vi.fn(async () => { if (++n === 2) throw new Error("second order rejected"); return { status: "open", filledSize: "0" }; }),
    });
    let ticks = 0;
    registerStrategy("t-start", () => ({ name: "t-start", init: async () => {}, onTick: async () => { ticks++; return ticks <= 2 ? [limit("buy", false), limit("sell", false)] : []; }, onStop: async () => [] } as never));
    await runBot(a, config("t-start", { exit_conditions: [{ type: "time_after", value: 0.15 }] }), undefined, noop, undefined, "headless", false);
    const lo = (a.limitOrder as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const ca = (a.cancelAllOrders as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    // order 1 ok, order 2 throws → cancel → retry places orders 3, 4
    expect(lo.length).toBeGreaterThanOrEqual(4);
    expect(ca[0]).toBeGreaterThan(lo[1]);
    expect(ca[0]).toBeLessThan(lo[2]);
  });
});

describe("engine: multi-symbol bot never cancels account-wide (9)", () => {
  it("symbol ALL: no cancelAllOrders, even for a cancel_all action", async () => {
    registerStrategy("t-all", () => ({ name: "t-all", init: async () => {}, onTick: async () => [], onStop: async () => [{ type: "cancel_all" }] } as never));
    const a = venue("hyperliquid");
    await runBot(a, config("t-all", { symbol: "ALL", exit_conditions: [{ type: "time_after", value: 0.05 }] }), undefined, noop, undefined, "headless", false);
    expect(a.cancelAllOrders).not.toHaveBeenCalled();
  });
});

describe("engine: unknown market data (12)", () => {
  it("a strategy that reads the orderbook / klines is not run on a failed read (logged once)", async () => {
    const onTick = vi.fn(async () => []);
    const init = vi.fn(async () => {});
    registerStrategy("mean-reversion", () => ({ name: "mean-reversion", init, onTick, onStop: async () => [] } as never));
    const log = vi.fn();
    const a = venue("hyperliquid", { getOrderbook: vi.fn(async () => { throw new Error("book down"); }) });
    await runBot(a, config("mean-reversion", { exit_conditions: [{ type: "time_after", value: 0.1 }] }), undefined, log, undefined, "headless", false);
    expect(init).not.toHaveBeenCalled();
    expect(onTick).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(c => /market data unknown/.test(String(c[0])))).toHaveLength(1);
  });
});

function arbCtx(primary: ExchangeAdapter, extra: ExchangeAdapter[]): StrategyContext {
  const ctx = { adapter: primary, symbol: "ALL", config: { sizeUsd: 10 }, state: new Map<string, unknown>(), tick: 0, log: vi.fn() } as unknown as StrategyContext;
  ctx.state.set("extraAdapters", new Map(extra.map(a => [a.name, a])));
  return ctx;
}
const pos = (symbol: string, side: "long" | "short", size: string) => ({ symbol, side, size, entryPrice: "1", markPrice: "1", unrealizedPnl: "0", liquidationPrice: "0", leverage: 1 });

describe("funding-arb-v2 recovery at init (3)", () => {
  it("an exactly size-matched long/short is recovered; a single leg and a mismatched pair are quarantined with both sizes", async () => {
    const hl = venue("hyperliquid", { getPositions: vi.fn(async () => [pos("BTC", "long", "0.01"), pos("ETH", "long", "1"), pos("SOL", "short", "3")]) });
    const as = venue("aster", { getPositions: vi.fn(async () => [pos("BTC", "short", "-0.01"), pos("ETH", "short", "-0.5")]) });
    const ctx = arbCtx(hl, [as]);
    const s = new FundingArbV2Strategy();
    await s.init(ctx, {} as never);
    expect(ctx.state.get("positions")).toEqual([expect.objectContaining({ symbol: "BTC", longExchange: "hyperliquid", shortExchange: "aster", size: "0.01" })]);
    expect(quarantineEntryFor("ETH", noop)?.reason).toMatch(/sizes do not match.*long 1 on hyperliquid.*short 0\.5 on aster/);
    expect(quarantineEntryFor("SOL", noop)?.reason).toMatch(/unpaired SOL/);
    expect(isQuarantined("BTC", noop)).toBe(false);
  });

  it("a venue whose positions cannot be read fails the start (never 'nothing held')", async () => {
    const hl = venue("hyperliquid", { getPositions: vi.fn(async () => { throw new Error("down"); }) });
    await expect(new FundingArbV2Strategy().init(arbCtx(hl, [venue("aster")]), {} as never)).rejects.toThrow(/positions unreadable at start/);
  });

  it("onStop cancels only the bot's symbols on each venue (never account-wide) and returns no cancel_all", async () => {
    const hl = venue("hyperliquid", { getPositions: vi.fn(async () => []) });
    const as = venue("aster");
    const ctx = arbCtx(hl, [as]);
    const s = new FundingArbV2Strategy();
    await s.init(ctx, {} as never);
    expect(await s.onStop(ctx)).toEqual([]);
    expect(hl.cancelAllOrders).not.toHaveBeenCalled();
    expect(as.cancelAllOrders).not.toHaveBeenCalled();
  });
});

describe("funding-arb recovery (5)", () => {
  it("single legs and size-mismatched pairs are quarantined; only an exact pair is tracked", async () => {
    const hl = venue("hyperliquid", { getPositions: vi.fn(async () => [pos("BTC", "long", "0.01"), pos("ETH", "long", "1"), pos("DOGE", "long", "100")]) });
    const as = venue("aster", { getPositions: vi.fn(async () => [pos("BTC", "short", "0.01"), pos("ETH", "short", "0.9")]) });
    const ctx = arbCtx(hl, [as]);
    const s = new FundingArbStrategy() as unknown as { recoverPositions(a: Map<string, ExchangeAdapter>, c: StrategyContext): Promise<{ recovered: Array<{ symbol: string }> }> };
    const { recovered } = await s.recoverPositions(new Map([["hyperliquid", hl], ["aster", as]]), ctx);
    expect(recovered.map(r => r.symbol)).toEqual(["BTC"]);
    expect(quarantineEntryFor("ETH", noop)?.reason).toMatch(/sizes do not match.*long 1 on hyperliquid.*short 0\.9 on aster/);
    expect(quarantineEntryFor("DOGE", noop)?.reason).toMatch(/unpaired DOGE/);
  });
});

describe("DCA / TWAP outcome handling (4)", () => {
  const pending = () => new PerpError("ORDER_PENDING", "timeout — outcome unknown");

  it("DCA: ORDER_PENDING stops the run, quarantines the symbol and surfaces ORDER_PENDING (never resubmitted)", async () => {
    const a = venue("hyperliquid", { marketOrder: vi.fn(async () => { throw pending(); }) });
    await expect(runDCA(a, { symbol: "ETH", side: "buy", amountPerOrder: 1, intervalSec: 0.001, totalOrders: 5 }, undefined, noop))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(a.marketOrder).toHaveBeenCalledTimes(1);
    expect(quarantineEntryFor("ETH", noop)?.strategy).toBe("dca");
  });

  it("DCA: a result without a venue-reported fill size → ORDER_PENDING (never counted as the size sent)", async () => {
    const a = venue("hyperliquid", { marketOrder: vi.fn(async () => ({ orderId: "x" })) });
    await expect(runDCA(a, { symbol: "ETH", side: "buy", amountPerOrder: 1, intervalSec: 0.001, totalOrders: 2 }, undefined, noop))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(isQuarantined("ETH", noop)).toBe(true);
  });

  it("DCA: a failed price-limit read skips the order (no order sent blind)", async () => {
    const a = venue("hyperliquid", { getMarkets: vi.fn(async () => { throw new Error("markets down"); }) });
    const log = vi.fn();
    const r = await runDCA(a, { symbol: "ETH", side: "buy", amountPerOrder: 1, intervalSec: 0.001, totalOrders: 1, priceLimit: 200, maxRuntime: 0.05 }, undefined, log);
    expect(a.marketOrder).not.toHaveBeenCalled();
    expect(r.ordersPlaced).toBe(0);
    expect(log.mock.calls.some(c => /Price unknown .*markets down/.test(String(c[0])))).toBe(true);
  });

  it("TWAP: `filled` is the venue-reported fill, not the requested slice", async () => {
    const a = venue("hyperliquid", { marketOrder: vi.fn(async () => ({ status: "filled", filledSize: "0.3" })) });
    const r = await runTWAP(a, { symbol: "ETH", side: "buy", totalSize: 2, durationSec: 0.02, slices: 2 }, undefined, noop);
    expect(r.filled).toBeCloseTo(0.6, 9);
  });

  it("TWAP: ORDER_PENDING / unknown fill → stops, quarantines, ORDER_PENDING", async () => {
    const a = venue("hyperliquid", { marketOrder: vi.fn(async () => { throw pending(); }) });
    await expect(runTWAP(a, { symbol: "ETH", side: "buy", totalSize: 2, durationSec: 0.02, slices: 4 }, undefined, noop))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(a.marketOrder).toHaveBeenCalledTimes(1);
    expect(quarantineEntryFor("ETH", noop)?.strategy).toBe("twap");
    clearQuarantine("ETH", null);
    const b = venue("hyperliquid", { marketOrder: vi.fn(async () => ({ orderId: 1 })) });
    await expect(runTWAP(b, { symbol: "ETH", side: "buy", totalSize: 2, durationSec: 0.02, slices: 2 }, undefined, noop))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });
});

describe("quarantine network scope (11)", () => {
  it("a testnet entry does not block mainnet and vice versa; an undeclared process sees both", () => {
    setQuarantineNetwork("testnet");
    quarantineSymbol("arb-auto", "BTC", "r", "m", noop);
    expect(isQuarantined("BTC", noop)).toBe(true);
    setQuarantineNetwork("mainnet");
    expect(isQuarantined("BTC", noop)).toBe(false);
    quarantineSymbol("arb-auto", "ETH", "r", "m", noop);
    setQuarantineNetwork("testnet");
    expect(isQuarantined("ETH", noop)).toBe(false);
    resetQuarantineNetwork();
    expect(isQuarantined("BTC", noop) && isQuarantined("ETH", noop)).toBe(true);
    const f = JSON.parse(readFileSync(quarantineFile(), "utf8"));
    expect(Object.keys(f.entries).sort()).toEqual(["arb-auto:ETH", "testnet:arb-auto:BTC"]);
  });

  it("legacy (untagged) entries apply to mainnet only; an entry set without a declared network applies everywhere", () => {
    mkdirSync(dirname(quarantineFile()), { recursive: true });
    writeFileSync(quarantineFile(), JSON.stringify({ version: 1, entries: { "funding-arb:SOL": { strategy: "funding-arb", symbol: "SOL", reason: "old", remediation: "m", time: "t" } } }));
    setQuarantineNetwork("mainnet");
    expect(isQuarantined("SOL", noop)).toBe(true);
    setQuarantineNetwork("testnet");
    expect(isQuarantined("SOL", noop)).toBe(false);
    resetQuarantineNetwork();
    quarantineSymbol("trade-close", "DOGE", "r", "m", noop);
    setQuarantineNetwork("testnet");
    expect(isQuarantined("DOGE", noop)).toBe(true);
    expect(listQuarantine().map(e => e.symbol)).toEqual(["DOGE"]);
    // A testnet clear leaves the mainnet entry alone.
    expect(clearQuarantine("SOL", null)).toEqual([]);
    setQuarantineNetwork("mainnet");
    expect(isQuarantined("SOL", noop)).toBe(true);
  });
});
