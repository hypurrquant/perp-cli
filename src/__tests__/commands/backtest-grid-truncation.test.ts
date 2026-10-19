/**
 * `perp backtest grid --days 365` reads 1h candles straight from candleSnapshot, which serves only
 * the most recent 5000 candles (~208 days). Replayed from a response recorded live 2026-10-19
 * (first 3 / last 3 rows of 5002): the covered period is reported (dataFrom / truncated).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerBacktestCommands } from "../../commands/backtest.js";
import REC from "../fixtures/hyperliquid/read-path-2026-10-19.json";

const C = REC.candles1hETH365d;

async function run(argv: string[], json: boolean) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(C.req.endTime);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([...C.head, ...C.tail]), { status: 200 })));
  const program = new Command();
  program.exitOverride();
  registerBacktestCommands(program, () => json);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  await program.parseAsync(["node", "perp", "backtest", "grid", ...argv]);
  return out;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ARGS = ["--symbol", "ETH", "--upper", "5000", "--lower", "1000", "--days", "365"];

describe("backtest grid over more than HL's 5000-candle window", () => {
  it("--json reports dataFrom (first candle) and truncated: true", async () => {
    const out = await run(ARGS, true);
    const env = JSON.parse(out[out.length - 1]);
    expect(env.data).toMatchObject({ period: "365 days", dataFrom: new Date(C.head[0].t).toISOString(), truncated: true });
  });

  it("human output warns with the covered days", async () => {
    const out = (await run(ARGS, false)).join("\n");
    expect(out).toMatch(/Truncated:.*most recent 5000 candles — data starts 2026-03-25T01:00:00\.000Z \(208\.\d of 365 days\)/);
  });
});
