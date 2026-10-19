/**
 * Pre-release QA sweep (0.15.0) — `perp market` / `perp trade` output.
 *  1. Open interest is base-asset units on every venue: shown as "<n> <BASE>" (info adds the
 *     notional at mark, labelled), never "$<n>".
 *  2. null (not published) renders as "-" — index, volume, OI, kline volume / trades.
 *  3. Kline times are ISO (UTC) on every venue, never the host locale ("2026. 10. 13. PM 4:00:00").
 *  4. `market info <unknown>` → SYMBOL_NOT_FOUND with the market-list remediation, exit 1.
 *  5. A HIP-3 dex symbol keeps its lower-case prefix ("xyz:XYZ100", not "XYZ:XYZ100") in the
 *     book header and the dry-run echo.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../execution-log.js", () => ({ logExecution: vi.fn() }));
vi.mock("../../client-id-tracker.js", () => ({
  generateClientId: vi.fn().mockReturnValue("test-id"),
  logClientId: vi.fn(),
  isOrderDuplicate: vi.fn().mockReturnValue(false),
}));
vi.mock("../../trade-validator.js", () => ({
  enforceOrderRisk: vi.fn().mockResolvedValue(undefined),
  validateTrade: vi.fn().mockResolvedValue({ valid: true, checks: [], warnings: [], timestamp: "" }),
}));

import { Command } from "commander";
import { registerMarketCommands } from "../../commands/market.js";
import { registerTradeCommands } from "../../commands/trade.js";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { normalizeSymbolArg } from "../../utils.js";
import type { ExchangeAdapter, ExchangeMarketInfo } from "../../exchanges/interface.js";

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

const BTC: ExchangeMarketInfo = {
  symbol: "BTC-PERP", markPrice: "83000", indexPrice: null, fundingRate: "0.0001", volume24h: null, openInterest: "37936.02",
  maxLeverage: 40, sizeDecimals: 5, stepSize: null, fundingHours: null, marginTiers: null,
};

async function run(adapter: Partial<ExchangeAdapter>, argv: string[], json = false) {
  const program = new Command();
  program.exitOverride();
  program.option("-e, --exchange <exchange>", "", "hyperliquid");
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMarketCommands(program, async () => ({ name: "hyperliquid", ...adapter } as ExchangeAdapter), () => json);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  await program.parseAsync(["node", "perp", ...argv]);
  return { text: strip(out.join("\n")), out, exitCode: process.exitCode };
}

describe("1+2. open interest units and null → '-'", () => {
  it("market info: OI in base units with the labelled mark notional; index / volume null → '-'", async () => {
    const { text } = await run({ getMarkets: async () => [BTC] }, ["market", "info", "BTC"]);
    expect(text).toMatch(/Open Interest:\s+37,936\.02 BTC \(≈ \$3,148,689,660(\.\d+)? at mark\)/);
    expect(text).not.toMatch(/Open Interest:\s+\$/);
    expect(text).toMatch(/Index Price:\s+-/);
    expect(text).toMatch(/24h Volume:\s+-/);
  });

  it("market info: OI not published → '-'", async () => {
    const { text } = await run({ getMarkets: async () => [{ ...BTC, openInterest: null }] }, ["market", "info", "BTC"]);
    expect(text).toMatch(/Open Interest:\s+-/);
  });

  it("market list: the OI column is labelled base and carries no '$'", async () => {
    const { text } = await run({ getMarkets: async () => [BTC] }, ["-e", "hyperliquid", "market", "list"]);
    expect(text).toContain("OI (base)");
    expect(text).toContain("37,936.02 BTC");
    expect(text).not.toContain("$37,936");
  });

  it("a HIP-3 symbol's base drops the dex prefix", async () => {
    const { text } = await run({ getMarkets: async () => [{ ...BTC, symbol: "xyz:XYZ100", openInterest: "12.5" }] }, ["market", "info", "xyz:XYZ100"]);
    expect(text).toMatch(/Open Interest:\s+12\.5 XYZ100/);
  });
});

describe("3. kline output", () => {
  it("ISO times; null volume / trades → '-'", async () => {
    const t = Date.UTC(2026, 9, 13, 7, 0, 0);
    const { text } = await run({
      getKlines: async () => [{ time: t, open: "1", high: "2", low: "0.5", close: "1.5", volume: null, quoteVolume: null, trades: null }],
    }, ["market", "kline", "BTC", "1h"]);
    expect(text).toContain("2026-10-13T07:00:00.000Z");
    const row = text.split("\n").find((l) => l.includes("2026-10-13T07:00:00.000Z"))!;
    expect(row.split("│").map((c) => c.trim()).filter(Boolean).slice(-2)).toEqual(["-", "-"]);
  });
});

describe("4. market info <unknown symbol>", () => {
  it("JSON: SYMBOL_NOT_FOUND with remediation, exit 1", async () => {
    const { out, exitCode } = await run({ getMarkets: async () => [BTC] }, ["market", "info", "NOPE"], true);
    const env = JSON.parse(out[out.length - 1]);
    expect(env).toMatchObject({ ok: false, error: { code: "SYMBOL_NOT_FOUND", remediation: "List markets: perp -e hyperliquid market list" } });
    expect(exitCode).toBe(1);
  });

  it("human: Error + Remediation lines, exit 1", async () => {
    const { text, exitCode } = await run({ getMarkets: async () => [BTC] }, ["market", "info", "NOPE"]);
    expect(text).toContain("Market NOPE not found on hyperliquid");
    expect(text).toContain("Remediation: List markets: perp -e hyperliquid market list");
    expect(exitCode).toBe(1);
  });
});

describe("4c. market trades: rows an adapter skipped are counted in meta", () => {
  it("meta.skippedRows = { count, reason } when the adapter annotated the tape", async () => {
    const { TAPE_SKIPPED } = await import("../../exchanges/interface.js");
    const rows = Object.assign([{ time: 1, symbol: "BTC", side: "buy", price: "1", size: "1", fee: null }], { [TAPE_SKIPPED]: { count: 2, reason: "undocumented event_type \"x\"" } });
    const { out } = await run({ getRecentTrades: async () => rows } as Partial<ExchangeAdapter>, ["market", "trades", "BTC"], true);
    const env = JSON.parse(out[out.length - 1]);
    expect(env.data).toHaveLength(1);
    expect(env.meta.skippedRows).toEqual({ count: 2, reason: "undocumented event_type \"x\"" });
  });
});

describe("4b. market info <delisted>", () => {
  it("SYMBOL_NOT_FOUND says the market is delisted (positions / history still readable)", async () => {
    const { out, exitCode } = await run({
      getMarkets: async () => [BTC],
      delistedMessage: (s: string) => (s.toUpperCase() === "MATIC" ? "MATIC is delisted on Hyperliquid (positions / history still readable)" : null),
    } as Partial<ExchangeAdapter>, ["market", "info", "MATIC"], true);
    const env = JSON.parse(out[out.length - 1]);
    expect(env.error).toMatchObject({ code: "SYMBOL_NOT_FOUND", message: "MATIC is delisted on Hyperliquid (positions / history still readable)" });
    expect(env.error.remediation).toMatch(/perp -e hyperliquid market list/);
    expect(exitCode).toBe(1);
  });
});

describe("5. HIP-3 dex symbol display", () => {
  it("normalizeSymbolArg keeps the dex prefix lower case", () => {
    expect(normalizeSymbolArg("xyz:xyz100")).toBe("xyz:XYZ100");
    expect(normalizeSymbolArg("XYZ:XYZ100")).toBe("xyz:XYZ100");
    expect(normalizeSymbolArg("btc")).toBe("BTC");
  });

  it("book header and the symbol sent to the adapter", async () => {
    const getOrderbook = vi.fn(async () => ({ bids: [["99", "1"]] as [string, string][], asks: [["101", "1"]] as [string, string][] }));
    const { text } = await run({ getOrderbook }, ["market", "book", "xyz:XYZ100"]);
    expect(text).toContain("Orderbook: xyz:XYZ100 (hyperliquid)");
    expect(getOrderbook).toHaveBeenCalledWith("xyz:XYZ100");
  });

  it("trade market --dry-run echoes xyz:XYZ100", async () => {
    const program = new Command();
    program.exitOverride();
    addRootSafetyOptions(program).option("--json");
    registerTradeCommands(program, async () => ({ name: "hyperliquid" }) as unknown as ExchangeAdapter, () => true, () => true);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", "--dry-run", "--json", "trade", "market", "xyz:XYZ100", "buy", "0.001"]);
    const env = JSON.parse(out.find((l) => l.includes("dryRun"))!);
    expect(env.data.symbol).toBe("xyz:XYZ100");
  });
});

describe("market prices: Pacifica returns the normalized market rows (QA 0.15.0)", () => {
  it("JSON is getMarkets(), never the raw /info/prices fields (funding / mark / mid / oracle / next_funding)", async () => {
    // Raw row as the 0.15.0 output printed it (QA prices_pacifica.json).
    const raw = { funding: "0.0000125", mark: "152.32", mid: "152.265", next_funding: "0.00001077", open_interest: "1269.17", oracle: "152.401133", symbol: "AAVE", timestamp: 1792404059021, volume_24h: "62980.0938", yesterday_price: "154.11" };
    const AAVE: ExchangeMarketInfo = { ...BTC, symbol: "AAVE", markPrice: "152.32", indexPrice: "152.401133", fundingRate: "0.00001077", volume24h: "62980.0938", openInterest: "1269.17", fundingHours: 1 };
    const out: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.option("-e, --exchange <exchange>", "", "pacifica");
    registerMarketCommands(program, async () => ({ name: "pacifica", publicKey: "PacPubKey1111", sdk: { getPrices: async () => [raw] }, getMarkets: async () => [AAVE] } as unknown as ExchangeAdapter), () => true);
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", "-e", "pacifica", "market", "prices"]);
    const j = JSON.parse(out.join("\n"));
    expect(j.data).toEqual([AAVE]);
    expect(Object.keys(j.data[0])).toEqual(expect.arrayContaining(["markPrice", "indexPrice", "fundingRate"]));
    expect(j.data[0]).not.toHaveProperty("mid");
  });
});

describe("market list|prices without -e covers every market-data venue (QA 0.15.0)", () => {
  it("txflow, variational, grvt and extended are fanned out, not only the account-role venues", async () => {
    await import("../../exchanges/venues/index.js");
    const { MARKET_DATA_VENUES } = await import("../../commands/market.js");
    expect(MARKET_DATA_VENUES).toEqual(expect.arrayContaining(["txflow", "variational", "grvt", "extended", "hyperliquid", "pacifica", "lighter", "lighter-rh", "aster", "ondo", "arcus", "qfex", "risex"]));
    const asked: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.option("-e, --exchange <exchange>", "", "hyperliquid");
    registerMarketCommands(program, async () => { throw new Error("single-venue path"); }, () => true,
      async (ex: string) => { asked.push(ex); return { name: ex, getMarkets: async () => [] } as unknown as ExchangeAdapter; });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["node", "perp", "market", "list"]);
    expect(asked).toEqual(expect.arrayContaining(["txflow", "variational", "grvt", "extended"]));
  });
});
