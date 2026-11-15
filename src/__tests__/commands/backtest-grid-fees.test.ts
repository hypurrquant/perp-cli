/**
 * `perp backtest grid` charges the Hyperliquid taker fee per simulated trade (its candles are
 * Hyperliquid's): the published base tier (constants.ts), never the stale flat 0.035%. Real
 * adapter; fetch serves the 1h ETH candles and meta recorded live 2026-10-19 (no network).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerBacktestCommands } from "../../commands/backtest.js";
import { getTakerFee } from "../../constants.js";
import REC from "../fixtures/hyperliquid/read-path-2026-10-19.json";

const C = REC.candles1hETH365d;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("backtest grid fees", () => {
  it("tradingFees = trades × size × last close × the Hyperliquid taker fee (0.045%)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(C.req.endTime);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const type = (JSON.parse(init.body) as { type: string }).type;
      const answer = type === "meta" ? REC.meta : type === "candleSnapshot" ? [...C.head, ...C.tail] : null;
      return new Response(JSON.stringify(answer), { status: answer === null ? 500 : 200 });
    }));
    const program = new Command();
    program.exitOverride();
    registerBacktestCommands(program, () => true);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", "backtest", "grid", "--symbol", "ETH", "--upper", "2460", "--lower", "2400", "--grids", "13", "--days", "7", "--size", "1"]);
    const data = JSON.parse(out[out.length - 1]).data as { totalTrades: number; tradingFees: string };
    expect(getTakerFee("hyperliquid")).toBe(0.00045);
    expect(data.totalTrades).toBeGreaterThan(0);
    const lastClose = Number(C.tail[C.tail.length - 1].c);
    expect(data.tradingFees).toBe(`$${(data.totalTrades * lastClose * 0.00045).toFixed(2)}`);
  });
});
