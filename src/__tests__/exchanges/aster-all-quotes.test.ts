/**
 * Aster lists every TRADING perpetual on every surface (CLI adapter, public directory / MCP, WS),
 * any quote. Cross-venue matching stays safe: only the USDT listing is matchable; USD1 / U ones are
 * canonical null, so arb never takes a non-USDT-margined Aster leg.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { legacyPublicData } from "../../funding/legacy-public.js";
import { asterCliSymbol, asterMatchable } from "../../ws/aster-market.js";

afterEach(() => vi.unstubAllGlobals());

const sym = (symbol: string, baseAsset: string, quoteAsset: string) => ({
  symbol, baseAsset, quoteAsset, contractType: "PERPETUAL", status: "TRADING", marginAsset: quoteAsset, underlyingSubType: [], filters: [],
});
const SYMBOLS = [sym("BTCUSDT", "BTC", "USDT"), sym("BTCUSD1", "BTC", "USD1"), sym("BTCU", "BTC", "U"), sym("GPROUSD1", "GPRO", "USD1")];

describe("Aster: every quote listed, only the USDT listing matchable", () => {
  it("CLI symbol: base for USDT, venue symbol otherwise", () => {
    expect(SYMBOLS.map(asterCliSymbol)).toEqual(["BTC", "BTCUSD1", "BTCU", "GPROUSD1"]);
  });

  it("matchable: the USDT listing only (USD1 / U margin is not handled by arb)", () => {
    expect(SYMBOLS.map(s => asterMatchable(s))).toEqual([true, false, false, false]);
  });

  it("public directory (MCP get_markets, arb) lists all four; canonical BTC once, the rest null", async () => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes("exchangeInfo")) return json({ symbols: SYMBOLS });
      if (url.includes("premiumIndex")) return json(SYMBOLS.map(s => ({ symbol: s.symbol, markPrice: "100", indexPrice: "100", lastFundingRate: "0.0001", nextFundingTime: 0 })));
      if (url.includes("ticker/24hr")) return json([]);
      if (url.includes("fundingInfo")) return json(SYMBOLS.map(s => ({ symbol: s.symbol, fundingIntervalHours: 8 })));
      throw new Error(`unexpected ${url}`);
    }));
    const rows = await legacyPublicData("aster").fetchMarkets("mainnet");
    expect(rows.map(r => [r.symbol, r.venueSymbol, r.quoteAsset, r.canonical])).toEqual([
      ["BTC", "BTCUSDT", "USDT", "BTC"],
      ["BTCUSD1", "BTCUSD1", "USD1", null],
      ["BTCU", "BTCU", "U", null],
      ["GPROUSD1", "GPROUSD1", "USD1", null],
    ]);
  });
});
