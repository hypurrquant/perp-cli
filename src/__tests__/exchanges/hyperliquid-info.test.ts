/**
 * HyperliquidAdapter /info reads without the `hyperliquid` npm SDK: raw venue
 * coins on the wire, the former "<COIN>-PERP" display names preserved, the
 * per-user abstraction mode (HIP-3 included) and the "default" mode warning.
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

import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";

const USER = "0xabcdef0000000000000000000000000000000001";

function adapterWith(routes: Record<string, (b: Record<string, unknown>) => unknown>, dex = "") {
  const hl = new HyperliquidAdapter(undefined, true);
  if (dex) hl.setDex(dex);
  hl.setAddress(USER);
  const calls: Record<string, unknown>[] = [];
  (hl as unknown as { _infoPost: (b: Record<string, unknown>) => Promise<unknown> })._infoPost = async (b) => {
    calls.push(b);
    const r = routes[String(b.type)];
    if (!r) throw new Error(`unexpected info ${String(b.type)}`);
    return r(b);
  };
  return { hl, calls };
}

const META = { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4, marginMode: "noCross" }], collateralToken: 0 };

afterEach(() => vi.restoreAllMocks());

describe("native perps: raw coins on the wire, '-PERP' display names", () => {
  it("init + getOrderbook('BTC-PERP') posts l2Book coin 'BTC' (no nSigFigs aggregation)", async () => {
    const { hl, calls } = adapterWith({
      meta: () => META,
      userAbstraction: () => "disabled",
      l2Book: () => ({ levels: [[{ px: "100", sz: "1" }], [{ px: "101", sz: "2" }]] }),
    });
    await hl.init();
    expect(await hl.getAssetIndex("BTC")).toBe(0);
    expect(hl.marginModeOf("ETH")).toBe("noCross");
    const book = await hl.getOrderbook("BTC-PERP");
    expect(calls.find(c => c.type === "l2Book")).toEqual({ type: "l2Book", coin: "BTC" });
    expect(book).toEqual({ bids: [["100", "1"]], asks: [["101", "2"]] });
  });

  it("getMarkets lists plain coins (venueSymbol = the wire coin) from raw metaAndAssetCtxs", async () => {
    const { hl } = adapterWith({
      meta: () => META,
      metaAndAssetCtxs: () => [{ universe: META.universe, marginTables: [] }, [{ markPx: "50000", funding: "0.0000125" }, { markPx: "3000" }]],
      allMids: () => ({ BTC: "50001", ETH: "3001" }),
    });
    const m = await hl.getMarkets();
    expect(m.map(x => x.symbol)).toEqual(["BTC", "ETH"]);
    expect(m.map(x => (x as { venueSymbol?: string }).venueSymbol)).toEqual(["BTC", "ETH"]);
    expect(m.map(x => x.stepSize)).toEqual(["0.00001", "0.0001"]); // 10^-szDecimals
    expect(m[0].markPrice).toBe("50000");
    expect(m[0].fundingRate).toBe("0.0000125");
  });

  it("getOpenOrders / getPositions map raw coins and B/A sides (spot rows are not perp orders)", async () => {
    const { hl } = adapterWith({
      meta: () => META,
      userAbstraction: () => "disabled",
      frontendOpenOrders: () => [{ oid: 7, coin: "ETH", side: "A", limitPx: "3100", sz: "0.5", isTrigger: false, orderType: "Limit" }, { oid: 8, coin: "@107", side: "B", limitPx: "40", sz: "1", isTrigger: false, orderType: "Limit" }],
      clearinghouseState: () => ({ assetPositions: [{ position: { coin: "BTC", szi: "-0.1", entryPx: "50000", positionValue: "5000", unrealizedPnl: "1", leverage: { value: 3 } } }] }),
    });
    await hl.init();
    const orders = await hl.getOpenOrders();
    // The "@107" row is a SPOT order: the perp adapter does not list it (pre-mainnet review M8).
    expect(orders.map(o => [o.symbol, o.side])).toEqual([["ETH-PERP", "sell"]]);
    const pos = await hl.getPositions();
    expect(pos[0]).toMatchObject({ symbol: "BTC-PERP", side: "short", size: "0.1" });
  });

  it("getKlines posts candleSnapshot with the raw coin", async () => {
    const { hl, calls } = adapterWith({
      meta: () => META,
      userAbstraction: () => "disabled",
      candleSnapshot: () => [{ t: 1, o: "1", h: "2", l: "0.5", c: "1.5", v: "10", n: 3 }],
    });
    await hl.init();
    const start = Date.now() - 3_600_000; // inside HL's 5000-candle window (an older start is refused up front)
    const k = await hl.getKlines("BTC-PERP", "1h", start, start + 10);
    expect(calls.find(c => c.type === "candleSnapshot")).toEqual({ type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: start, endTime: start + 10 } });
    expect(k[0]).toMatchObject({ time: 1, close: "1.5", trades: 3 });
  });
});

describe("account abstraction is per user (HIP-3 included)", () => {
  const perpState = { marginSummary: { accountValue: "0", totalMarginUsed: "0" }, withdrawable: "0", assetPositions: [] };

  it("HIP-3 dex adapter of a unified user reads equity from spot state by collateral token index", async () => {
    const { hl, calls } = adapterWith({
      meta: (b) => (b.dex === "xyz" ? { universe: [], collateralToken: 268 } : META),
      perpDexs: () => [null, { name: "xyz" }],
      userAbstraction: () => "unifiedAccount",
      clearinghouseState: () => perpState,
      spotClearinghouseState: () => ({ balances: [
        { coin: "USDC", token: 0, total: "100", hold: "0" },
        { coin: "USDT0", token: 268, total: "250", hold: "50" },
      ] }),
    }, "xyz");
    await hl.init();
    expect(hl.isUnifiedAccount).toBe(true);
    const bal = await hl.getBalance();
    expect(bal.equity).toBe("250");
    expect(bal.available).toBe("200");
    expect(calls.some(c => c.type === "userAbstraction")).toBe(true);
  });

  it("'default' mode with 0 perp equity but spot USDC → stderr remediation (not a silent 0)", async () => {
    const { hl } = adapterWith({
      meta: () => META,
      userAbstraction: () => "default",
      clearinghouseState: () => perpState,
      spotClearinghouseState: () => ({ balances: [{ coin: "USDC", token: 0, total: "42", hold: "0" }] }),
    });
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => { lines.push(String(c)); return true; });
    await hl.init();
    expect(hl.isUnifiedAccount).toBe(false);
    const bal = await hl.getBalance();
    expect(bal.equity).toBe("0");
    const out = lines.join("");
    expect(out).toMatch(/"default"/);
    expect(out).toMatch(/42 USDC/);
    expect(out).toMatch(/account-mode unified/);
    expect(out).toMatch(/spot-transfer to-perp/);
  });

  it("'default' mode with perp equity > 0 → no spot read, no warning", async () => {
    const { hl, calls } = adapterWith({
      meta: () => META,
      userAbstraction: () => "default",
      clearinghouseState: () => ({ ...perpState, marginSummary: { accountValue: "10", totalMarginUsed: "0" }, withdrawable: "10" }),
    });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await hl.init();
    expect((await hl.getBalance()).equity).toBe("10");
    expect(calls.some(c => c.type === "spotClearinghouseState")).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("meta without collateralToken → EXCHANGE_ERROR (collateral never guessed)", async () => {
    const { hl } = adapterWith({
      meta: () => ({ universe: [] }),
      userAbstraction: () => "unifiedAccount",
      clearinghouseState: () => perpState,
      spotClearinghouseState: () => ({ balances: [] }),
    });
    await expect(hl.getBalance()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});
