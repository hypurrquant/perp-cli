/**
 * `perp backtest grid --days N` over Hyperliquid 1h candles. Only the most recent 5000 candles
 * exist (~208 days of 1h), so a longer --days is clamped to that window up front (window-based,
 * not inferred from the first row) and reported (dataFrom / truncated). The read goes through
 * HyperliquidAdapter.getKlines. Responses recorded live 2026-10-19 (first 3 / last 3 rows of 5002).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../cache.js", async () => ({
  withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  fetchAndCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidateCache: () => {},
  TTL_ACCOUNT: 1000,
  TTL_MARKETS: 1000,
  TTL_PRICES: 1000,
}));

import { Command } from "commander";
import { registerBacktestCommands } from "../../commands/backtest.js";
import REC from "../fixtures/hyperliquid/read-path-2026-10-19.json";

const C = REC.candles1hETH365d;
const H = 3_600_000;
const DAY = 24 * H;

async function run(argv: string[], json: boolean) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(C.req.endTime);
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    requests.push(body);
    const answer = body.type === "meta" ? REC.meta : body.type === "candleSnapshot" ? [...C.head, ...C.tail] : null;
    return new Response(JSON.stringify(answer), { status: answer === null ? 500 : 200 });
  }));
  const program = new Command();
  program.exitOverride();
  registerBacktestCommands(program, () => json);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  await program.parseAsync(["node", "perp", "backtest", "grid", ...argv]);
  const candleReq = requests.find(b => b.type === "candleSnapshot")?.req as { startTime: number; endTime: number; coin: string; interval: string };
  return { out, candleReq };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ARGS = (days: string) => ["--symbol", "ETH", "--upper", "5000", "--lower", "1000", "--days", days];

describe("backtest grid vs HL's 5000-candle window", () => {
  it("--days 365: the start is clamped into the window; JSON reports dataFrom = clamped start, truncated", async () => {
    const { out, candleReq } = await run(ARGS("365"), true);
    const clamped = C.req.endTime - 5000 * H + H;
    expect(candleReq).toMatchObject({ coin: "ETH", interval: "1h", startTime: clamped, endTime: C.req.endTime });
    const env = JSON.parse(out[out.length - 1]);
    expect(env.data).toMatchObject({ period: "365 days", dataFrom: new Date(clamped).toISOString(), truncated: true });
  });

  it("--days 365 human output warns with the covered days", async () => {
    const { out } = await run(ARGS("365"), false);
    expect(out.join("\n")).toMatch(/Truncated:.*most recent 5000 1h candles — start clamped to .* \(208\.3 of 365 days\)/);
  });

  it("--days 7: inside the window — requested start sent, truncated false", async () => {
    const { out, candleReq } = await run(ARGS("7"), true);
    expect(candleReq.startTime).toBe(C.req.endTime - 7 * DAY);
    const env = JSON.parse(out[out.length - 1]);
    expect(env.data).toMatchObject({ dataFrom: new Date(C.req.endTime - 7 * DAY).toISOString(), truncated: false });
  });
});
