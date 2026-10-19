/**
 * `market book` of a non-USD QFEX market: the book carries `quoteAsset` and the text prints the
 * cumulative notional and the spread in the quote currency ("80.00 KRW"), never a "$".
 * Real GET /md/orderbook/SAMSUNG-KRW of 2026-10-19 ~11:44Z (top 4 levels; empty levels dropped).
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
const BOOK = fx("orderbook-samsung-krw-2026-10-19.json");

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    const body = path === "/refdata" ? REFDATA : path === "/md/orderbook/SAMSUNG-KRW" ? BOOK : undefined;
    if (body === undefined) throw new Error(`unexpected request ${input}`);
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function adapter(): QfexAdapter {
  return new QfexAdapter(qfexVenue, { network: "mainnet", credentials: READ_ONLY_CREDENTIALS, noAgent: false, hlDex: null, readOnly: true, noBuilder: false });
}

describe("QFEX book quote currency", () => {
  it("the book carries quoteAsset KRW; the text shows KRW notional and spread, no $", async () => {
    expect(await adapter().getOrderbook("SAMSUNG-KRW")).toEqual({
      bids: [["219690", "0.00364"], ["219680", "0.00091"]], asks: [["219770", "0.39244"]], quoteAsset: "KRW",
    });
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMarketCommands(program, async () => adapter() as unknown as ExchangeAdapter, () => false);
    await program.parseAsync(["node", "perp", "market", "book", "SAMSUNG-KRW"]);
    // eslint-disable-next-line no-control-regex
    const text = out.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(text).toContain("Cum (KRW)");
    expect(text).toContain("spread: 80.00 KRW (0.036%)");
    expect(text).toContain("86,246.54 KRW"); // 0.39244 × 219,770
    expect(text).not.toContain("$");
  });
});
