/**
 * Perp-perp entry paths (arb auto, funding-arb-v2, funding-auto): a long rollback and a
 * long-excess trim size their residual on the MARKET LOT, never on the decimals the entry size
 * prints. A "30" entry has 0 printed decimals: a 2.1 residual floored to 2 (rollback) or an
 * excess floored to 2 (trim) left 0.1 long open while the entry read as rolled back / hedged.
 */
import { describe, it, expect, vi } from "vitest";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type { StrategyContext } from "../bot/strategy-types.js";
import { openPerpPairVerified } from "../commands/arb-auto.js";
import { FundingArbV2Strategy } from "../bot/strategies/funding-arb-v2.js";
import "../bot/strategies/funding-auto.js";
import { getStrategy } from "../bot/strategy-registry.js";

/** One venue holding `SOL`; `fills` decides each order's executed size in turn (default: all of it). */
function venue(name: string, opts: { fills?: Array<(q: number) => number>; reject?: boolean } = {}) {
  let net = 0;
  const fills = [...(opts.fills ?? [])];
  const marketOrder = vi.fn(async (_s: string, side: "buy" | "sell", size: string) => {
    if (opts.reject === true) throw new PerpError("ORDER_REJECTED", `${name} rejected`, { exchange: name });
    const q = (fills.shift() ?? ((x: number) => x))(Number(size));
    net += side === "buy" ? q : -q;
    return { filled: String(q) };
  });
  const getPositions = vi.fn(async () => Math.abs(net) < 1e-12 ? [] : [{
    symbol: "SOL", side: net > 0 ? "long" : "short", size: String(Number(Math.abs(net).toFixed(10))),
    entryPrice: "0.5", markPrice: "0.5", liquidationPrice: null, unrealizedPnl: "0", leverage: 1,
  }]);
  const adapter = { name, marketOrder, getPositions, lotStepOf: () => "0.1" } as unknown as ExchangeAdapter;
  return { adapter, marketOrder, net: () => net };
}

const ctx = () => ({ log: vi.fn(), state: new Map<string, unknown>([["priceCache", new Map([["hyperliquid:SOL", 0.5]])]]) }) as unknown as StrategyContext;
const opp = { symbol: "SOL", longExchange: "hyperliquid", shortExchange: "aster" };
const SHORT_PARTIAL = (q: number) => q * 0.93; // 27.9 of 30 (≥ 80%: accepted, measured)

describe("arb auto openPerpPairVerified", () => {
  const open = (long: ReturnType<typeof venue>, short: ReturnType<typeof venue>) => openPerpPairVerified({
    source: "arb-auto", sym: "SOL", longAdapter: long.adapter, longExch: "hyperliquid", longSym: "SOL",
    shortAdapter: short.adapter, shortExch: "aster", shortSym: "SOL", size: "30", smart: false, log: vi.fn(),
  });

  it("rollback: the long's residual is floored to the lot (30, 27.9 closed → closes 2.1)", async () => {
    const long = venue("hyperliquid", { fills: [q => q, SHORT_PARTIAL] });
    const r = await open(long, venue("aster", { reject: true }));
    expect(long.marketOrder).toHaveBeenNthCalledWith(3, "SOL", "sell", "2.1", expect.objectContaining({ reduceOnly: true }));
    expect(r.status).toBe("not_opened");
    expect(long.net()).toBeCloseTo(0, 9);
  });

  it("trim: the long's excess is floored to the lot (30 vs 27.9 → trims 2.1)", async () => {
    const long = venue("hyperliquid");
    const r = await open(long, venue("aster", { fills: [SHORT_PARTIAL] }));
    expect(long.marketOrder).toHaveBeenNthCalledWith(2, "SOL", "sell", "2.1", expect.objectContaining({ reduceOnly: true }));
    expect(r).toMatchObject({ status: "opened", trimmed: "2.1" });
  });
});

describe("funding-arb-v2 openPosition", () => {
  type Opener = { openPosition(c: StrategyContext, o: typeof opp, size: string, l: ExchangeAdapter, s: ExchangeAdapter): Promise<string | null> };

  it("rollback: the long's residual is floored to the lot (30, 27.9 closed → closes 2.1)", async () => {
    const long = venue("hyperliquid", { fills: [q => q, SHORT_PARTIAL] });
    await (new FundingArbV2Strategy() as unknown as Opener).openPosition(ctx(), opp, "30", long.adapter, venue("aster", { reject: true }).adapter);
    expect(long.marketOrder).toHaveBeenNthCalledWith(3, "SOL", "sell", "2.1", expect.objectContaining({ reduceOnly: true }));
    expect(long.net()).toBeCloseTo(0, 9);
  });

  it("trim: the long's excess is floored to the lot (30 vs 27.9 → trims 2.1)", async () => {
    const long = venue("hyperliquid");
    await (new FundingArbV2Strategy() as unknown as Opener).openPosition(ctx(), opp, "30", long.adapter, venue("aster", { fills: [SHORT_PARTIAL] }).adapter);
    expect(long.marketOrder).toHaveBeenNthCalledWith(2, "SOL", "sell", "2.1", expect.objectContaining({ reduceOnly: true }));
  });
});

describe("funding-auto openPosition", () => {
  type Opener = { openPosition(c: StrategyContext, o: typeof opp, a: Map<string, ExchangeAdapter>, usd: number): Promise<boolean> };
  // $15 at $0.5 → size "30" (0 printed decimals).
  const run = (long: ReturnType<typeof venue>, short: ReturnType<typeof venue>) =>
    (getStrategy("funding-auto")!({} as never) as unknown as Opener).openPosition(ctx(), opp, new Map([["hyperliquid", long.adapter], ["aster", short.adapter]]), 15);

  it("rollback: the long's residual is floored to the lot (30, 27.9 closed → closes 2.1)", async () => {
    const long = venue("hyperliquid", { fills: [q => q, SHORT_PARTIAL] });
    await run(long, venue("aster", { reject: true }));
    expect(long.marketOrder).toHaveBeenNthCalledWith(1, "SOL", "buy", "30", expect.anything());
    expect(long.marketOrder).toHaveBeenNthCalledWith(3, "SOL", "sell", "2.1", expect.objectContaining({ reduceOnly: true }));
    expect(long.net()).toBeCloseTo(0, 9);
  });

  it("trim: the long's excess is floored to the lot (30 vs 27.9 → trims 2.1)", async () => {
    const long = venue("hyperliquid");
    await run(long, venue("aster", { fills: [SHORT_PARTIAL] }));
    expect(long.marketOrder).toHaveBeenNthCalledWith(2, "SOL", "sell", "2.1", expect.objectContaining({ reduceOnly: true }));
  });
});
