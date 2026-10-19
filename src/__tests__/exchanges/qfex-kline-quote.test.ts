/**
 * `market kline` of a non-USD QFEX market: rows carry `quoteAsset` and the text prints the quote
 * currency ("221,910.00 KRW"), never a "$" (0.15.0 printed "$221,910.00").
 * Real SAMSUNG-KRW 1m candles of 2026-10-19 11:00–11:01Z (fixtures/qfex/samsung-krw-candles-trades-2026-10-19.json).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { Command } from "commander";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import "../../exchanges/venues/index.js";
import { READ_ONLY_CREDENTIALS } from "../../exchanges/venue.js";
import { qfexVenue } from "../../exchanges/venues/qfex.js";
import { QfexAdapter } from "../../exchanges/qfex/adapter.js";
import { registerMarketCommands } from "../../commands/market.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/qfex/${name}`, import.meta.url), "utf8"));
const REFDATA = fx("refdata-status-2026-10-19.json");
const CANDLES = (fx("samsung-krw-candles-trades-2026-10-19.json") as { candles: { candles: Array<{ open: string }> } }).candles;

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    const body = path === "/refdata" ? REFDATA : path === "/candles/SAMSUNG-KRW" ? CANDLES : undefined;
    if (body === undefined) throw new Error(`unexpected request ${input}`);
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function adapter(): QfexAdapter {
  return new QfexAdapter(qfexVenue, { network: "mainnet", credentials: READ_ONLY_CREDENTIALS, noAgent: false, hlDex: null, readOnly: true, noBuilder: false });
}

describe("QFEX kline quote currency", () => {
  it("rows carry quoteAsset KRW; the text table prints KRW prices without $", async () => {
    const rows = await adapter().getKlines("SAMSUNG-KRW", "1m", Date.parse("2026-10-19T11:00:00Z"), Date.parse("2026-10-19T11:02:00Z"));
    expect(rows.every(r => r.quoteAsset === "KRW")).toBe(true);

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMarketCommands(program, async () => adapter() as unknown as ExchangeAdapter, () => false);
    await program.parseAsync(["node", "perp", "market", "kline", "SAMSUNG-KRW", "1m", "--start", String(Date.parse("2026-10-19T11:00:00Z")), "--end", String(Date.parse("2026-10-19T11:02:00Z"))]);
    // eslint-disable-next-line no-control-regex
    const text = out.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    const open = Number(CANDLES.candles[CANDLES.candles.length - 1].open).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(text).toContain(`${open} KRW`);
    expect(text).not.toMatch(/\$\d/);
  });
});
