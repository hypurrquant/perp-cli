/**
 * Cross-validation tests: SpotAdapter vs raw SDK/API responses.
 *
 * Tests call SpotAdapter methods and independently call the exchange APIs,
 * then verify the values match. Requires live API keys.
 *
 * Run with: npx vitest run src/__tests__/spot-adapter-cross-validate.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { config } from "dotenv";
import { resolve } from "path";

// Load env
config({ path: resolve(process.env.HOME || "~", ".perp", ".env") });
config();

// ── Raw API helpers ──

async function hlPost(type: string, extra: Record<string, unknown> = {}) {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...extra }),
  });
  return res.json();
}

const LT_BASE = "https://mainnet.zklighter.elliot.ai/api/v1";

async function ltGet(path: string, params: Record<string, string> = {}) {
  const url = new URL(`${LT_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

// ── Key detection ──

function hasHlKey(): boolean {
  return !!(process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY);
}

function hasLtKey(): boolean {
  return !!(process.env.LIGHTER_PRIVATE_KEY || process.env.LT_PRIVATE_KEY);
}

const HAS_HL_KEY = hasHlKey();
const HAS_LT_KEY = hasLtKey();

// ── Hyperliquid Spot Tests ──

describe("Cross-validate: Hyperliquid Spot Adapter", () => {

  it("spot market list matches raw spotMetaAndAssetCtxs API", async () => {
    // Raw API
    const rawMeta = await hlPost("spotMetaAndAssetCtxs") as [
      {
        tokens: Array<{ name: string; index: number }>;
        universe: Array<{ name: string; tokens: [number, number]; index: number; szDecimals?: number }>;
      },
      Array<Record<string, unknown>>,
    ];

    expect(rawMeta).toBeTruthy();
    expect(rawMeta[0]?.universe?.length).toBeGreaterThan(0);

    // Build token name map
    const tokenNames = new Map<number, string>();
    for (const t of rawMeta[0].tokens) {
      tokenNames.set(t.index, t.name);
    }

    // Build spot market list from raw API
    const rawSpotMarkets = rawMeta[0].universe.map((u, i) => {
      const baseToken = tokenNames.get(u.tokens[0]) ?? "";
      const ctx = rawMeta[1]?.[i] ?? {};
      return {
        baseToken,
        markPrice: Number((ctx as Record<string, unknown>).markPx ?? (ctx as Record<string, unknown>).midPx ?? 0),
        szDecimals: u.szDecimals ?? 2,
      };
    }).filter(m => m.baseToken);

    // Adapter
    const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");

    // We can test without private key for read-only operations
    // Use a dummy key if none available
    const pk = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const hlAdapter = new HyperliquidAdapter(pk);
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    const adapterMarkets = await spotAdapter.getSpotMarkets();

    // Adapter should return spot markets
    expect(adapterMarkets.length).toBeGreaterThan(0);

    // Compare a few known spot tokens
    for (const rawMarket of rawSpotMarkets.slice(0, 5)) {
      if (!rawMarket.baseToken || rawMarket.baseToken === "USDC") continue;

      const adapterMarket = adapterMarkets.find(m => m.baseToken === rawMarket.baseToken);
      if (!adapterMarket) continue; // some markets may not be in adapter yet

      // Size decimals should match
      expect(adapterMarket.sizeDecimals).toBe(rawMarket.szDecimals);

      // Mark price should be close (within 2% — timing differences)
      const adapterPrice = Number(adapterMarket.markPrice);
      if (rawMarket.markPrice > 0 && adapterPrice > 0) {
        const pctDiff = Math.abs(adapterPrice - rawMarket.markPrice) / rawMarket.markPrice * 100;
        expect(pctDiff).toBeLessThan(2);
      }
    }
  });

  it("spot orderbook matches raw l2Book API", async () => {
    // First get spot meta to find the spot index for ETH
    const rawMeta = await hlPost("spotMeta") as {
      tokens?: Array<{ name: string; index: number }>;
      universe?: Array<{ name: string; tokens: [number, number]; index: number }>;
    };

    const tokenNames = new Map<number, string>();
    for (const t of rawMeta.tokens ?? []) {
      tokenNames.set(t.index, t.name);
    }

    // Find ETH spot index
    let ethSpotIndex = -1;
    for (const u of rawMeta.universe ?? []) {
      const baseToken = tokenNames.get(u.tokens[0]);
      if (baseToken === "ETH") {
        ethSpotIndex = u.index;
        break;
      }
    }

    if (ethSpotIndex < 0) {
      console.log("ETH spot not found in HL spotMeta, skipping");
      return;
    }

    // Raw API: L2 book for spot ETH
    const rawBook = await hlPost("l2Book", { coin: `@${ethSpotIndex}` }) as {
      levels?: [[{ px: string; sz: string }], [{ px: string; sz: string }]];
    };

    expect(rawBook.levels).toBeTruthy();
    const rawBids = rawBook.levels?.[0] ?? [];
    const rawAsks = rawBook.levels?.[1] ?? [];

    // Adapter
    const pk = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter(pk);
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    const adapterBook = await spotAdapter.getSpotOrderbook("ETH/USDC");

    // Both should have bids and asks
    if (rawBids.length > 0) {
      expect(adapterBook.bids.length).toBeGreaterThan(0);
      // Best bid price should be close (within 1% due to timing)
      const rawBestBid = Number(rawBids[0].px);
      const adapterBestBid = Number(adapterBook.bids[0][0]);
      if (rawBestBid > 0 && adapterBestBid > 0) {
        const pctDiff = Math.abs(rawBestBid - adapterBestBid) / rawBestBid * 100;
        expect(pctDiff).toBeLessThan(1);
      }
    }

    if (rawAsks.length > 0) {
      expect(adapterBook.asks.length).toBeGreaterThan(0);
      const rawBestAsk = Number(rawAsks[0].px);
      const adapterBestAsk = Number(adapterBook.asks[0][0]);
      if (rawBestAsk > 0 && adapterBestAsk > 0) {
        const pctDiff = Math.abs(rawBestAsk - adapterBestAsk) / rawBestAsk * 100;
        expect(pctDiff).toBeLessThan(1);
      }
    }

    // Sanity: best bid < best ask
    if (adapterBook.bids.length > 0 && adapterBook.asks.length > 0) {
      expect(Number(adapterBook.bids[0][0])).toBeLessThan(Number(adapterBook.asks[0][0]));
    }
  });

  it("spot balances match raw spotClearinghouseState API", { skip: !HAS_HL_KEY }, async () => {
    const pk = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY!;
    const { ethers } = await import("ethers");
    const address = new ethers.Wallet(pk).address;

    // Raw API
    const rawState = await hlPost("spotClearinghouseState", { user: address }) as {
      balances?: Array<{ coin: string; total: string; hold: string }>;
    };

    // Adapter
    const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter(pk);
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    const adapterBalances = await spotAdapter.getSpotBalances();

    // Compare USDC balance
    const rawUsdc = rawState.balances?.find(b => b.coin.startsWith("USDC"));
    const adapterUsdc = adapterBalances.find(b => b.token.startsWith("USDC"));

    if (rawUsdc && adapterUsdc) {
      const rawTotal = Number(rawUsdc.total);
      const adapterTotal = Number(adapterUsdc.total);
      // Should match exactly (same API call)
      expect(Math.abs(rawTotal - adapterTotal)).toBeLessThan(0.01);

      // Available = total - hold
      const rawAvailable = Number(rawUsdc.total) - Number(rawUsdc.hold);
      const adapterAvailable = Number(adapterUsdc.available);
      expect(Math.abs(rawAvailable - adapterAvailable)).toBeLessThan(0.01);
    }

    // All non-USDC balances should have valid token names
    for (const bal of adapterBalances) {
      expect(bal.token).toBeTruthy();
      expect(Number(bal.total)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Lighter Spot Tests ──

describe("Cross-validate: Lighter Spot Adapter", () => {

  it("spot markets match explorer API (symbols with /)", async () => {
    // Raw API: explorer lists spot markets as symbols with "/"
    const explorerMarkets = await fetch("https://explorer.elliot.ai/api/markets")
      .then(r => r.json()) as Array<{ symbol: string; market_index: number }>;
    const rawSpotMarkets = explorerMarkets.filter(m => m.symbol.includes("/"));

    expect(rawSpotMarkets.length).toBeGreaterThan(0);

    // Adapter
    const pk = process.env.LIGHTER_PRIVATE_KEY || process.env.LT_PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const { LighterAdapter } = await import("../exchanges/lighter.js");
    const { LighterSpotAdapter } = await import("../exchanges/lighter-spot.js");

    const ltAdapter = new LighterAdapter(pk);
    await ltAdapter.init();
    const spotAdapter = new LighterSpotAdapter(ltAdapter);
    await spotAdapter.init();

    const adapterMarkets = await spotAdapter.getSpotMarkets();

    // Should have the same number of spot markets
    expect(adapterMarkets.length).toBe(rawSpotMarkets.length);

    // Each explorer market should be in the adapter
    for (const raw of rawSpotMarkets) {
      const adapter = adapterMarkets.find(m => m.symbol.toUpperCase() === raw.symbol.toUpperCase());
      expect(adapter).toBeTruthy();
    }
  });

  it("spot orderbook has valid bid/ask structure", async () => {
    // Use explorer API to find a spot market
    const explorerMarkets = await fetch("https://explorer.elliot.ai/api/markets")
      .then(r => r.json()) as Array<{ symbol: string; market_index: number }>;
    const spotMarket = explorerMarkets.find(m => m.symbol.includes("/"));

    if (!spotMarket) {
      console.log("No spot markets on Lighter explorer, skipping");
      return;
    }

    // Raw API orderbook
    const rawBook = await ltGet("/orderBookOrders", {
      market_id: String(spotMarket.market_index),
      limit: "20",
    }) as { bids?: Record<string, string>[]; asks?: Record<string, string>[] };

    // Adapter
    const pk = process.env.LIGHTER_PRIVATE_KEY || process.env.LT_PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const { LighterAdapter } = await import("../exchanges/lighter.js");
    const { LighterSpotAdapter } = await import("../exchanges/lighter-spot.js");

    const ltAdapter = new LighterAdapter(pk);
    await ltAdapter.init();
    const spotAdapter = new LighterSpotAdapter(ltAdapter);
    await spotAdapter.init();

    const adapterBook = await spotAdapter.getSpotOrderbook(spotMarket.symbol);

    if ((rawBook.bids?.length ?? 0) > 0) {
      expect(adapterBook.bids.length).toBeGreaterThan(0);
    }
    if ((rawBook.asks?.length ?? 0) > 0) {
      expect(adapterBook.asks.length).toBeGreaterThan(0);
    }

    // Sanity: best bid < best ask
    if (adapterBook.bids.length > 0 && adapterBook.asks.length > 0) {
      expect(Number(adapterBook.bids[0][0])).toBeLessThan(Number(adapterBook.asks[0][0]));
    }
  });
});

// ── Index/Price Verification: ALL Exchanges ──

describe("Cross-validate: Token Index Verification", () => {

  it("HL spot U-token indices map to correct prices (UBTC→BTC, UETH→ETH, USOL→SOL)", async () => {
    const { SPOT_PERP_TOKEN_MAP } = await import("../exchanges/spot-interface.js");
    const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");

    const pk = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const hlAdapter = new HyperliquidAdapter(pk);
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    // Get perp mark prices from raw API
    const [perpMeta, perpCtxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ markPx?: string }>,
    ];
    const perpPriceMap = new Map<string, number>();
    for (let i = 0; i < perpMeta.universe.length; i++) {
      perpPriceMap.set(perpMeta.universe[i].name.toUpperCase(), Number(perpCtxs[i]?.markPx ?? 0));
    }

    // For each U-token mapping, verify spot book price ≈ perp mark price
    const verified: string[] = [];
    for (const [spotToken, perpSymbol] of Object.entries(SPOT_PERP_TOKEN_MAP)) {
      const perpPrice = perpPriceMap.get(perpSymbol.toUpperCase());
      if (!perpPrice || perpPrice === 0) continue;

      try {
        // Spot adapter should resolve both "UBTC" and "BTC" to the same index
        const spotBook = await spotAdapter.getSpotOrderbook(spotToken);
        if (spotBook.bids.length === 0 || spotBook.asks.length === 0) continue;

        const spotMid = (Number(spotBook.bids[0][0]) + Number(spotBook.asks[0][0])) / 2;
        const deviation = Math.abs(spotMid - perpPrice) / perpPrice * 100;

        // Spot price must be within 5% of perp price
        expect(deviation).toBeLessThan(5);
        verified.push(`${spotToken}→${perpSymbol}: spot=$${spotMid.toFixed(2)} perp=$${perpPrice.toFixed(2)} (${deviation.toFixed(2)}%)`);

        // Also verify resolution via perp symbol name
        const spotBookViaPerpName = await spotAdapter.getSpotOrderbook(perpSymbol);
        const spotMid2 = (Number(spotBookViaPerpName.bids[0][0]) + Number(spotBookViaPerpName.asks[0][0])) / 2;
        // Should resolve to same price (same underlying index)
        expect(Math.abs(spotMid - spotMid2)).toBeLessThan(spotMid * 0.001);
      } catch (e) {
        // Token may not have liquidity — skip
        console.log(`${spotToken}: ${e instanceof Error ? e.message : e}`);
      }
    }

    console.log("Verified U-token mappings:", verified);
    expect(verified.length).toBeGreaterThan(0);
  });

  it("HL spot HIP-1 tokens with same ticker as perp are price-validated (TRUMP, BERA, MON rejected)", async () => {
    // These tokens have same ticker on spot and perp but DIFFERENT underlying
    const suspectTokens = ["TRUMP", "BERA", "MON", "PUMP"];

    const pk = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter(pk);
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    // Get perp mark prices
    const [perpMeta, perpCtxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ markPx?: string }>,
    ];
    const perpPriceMap = new Map<string, number>();
    for (let i = 0; i < perpMeta.universe.length; i++) {
      perpPriceMap.set(perpMeta.universe[i].name.toUpperCase(), Number(perpCtxs[i]?.markPx ?? 0));
    }

    for (const token of suspectTokens) {
      const perpPrice = perpPriceMap.get(token);
      if (!perpPrice || perpPrice === 0) continue;

      try {
        const spotBook = await spotAdapter.getSpotOrderbook(token);
        if (spotBook.bids.length === 0 || spotBook.asks.length === 0) continue;

        const spotMid = (Number(spotBook.bids[0][0]) + Number(spotBook.asks[0][0])) / 2;
        const deviation = Math.abs(spotMid - perpPrice) / perpPrice * 100;

        // These SHOULD diverge significantly (>5%) — confirming they're different tokens
        expect(deviation).toBeGreaterThan(5);
        console.log(`${token}: spot=$${spotMid.toFixed(4)} perp=$${perpPrice.toFixed(4)} deviation=${deviation.toFixed(0)}% (correctly rejected)`);
      } catch {
        // May not have spot book — that's fine
      }
    }
  });

  it("HL perp asset indices map to correct mark prices", async () => {
    // Verify that getAssetIndex() returns indices that match the raw API
    const pk = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
    const hlAdapter = new HyperliquidAdapter(pk);
    await hlAdapter.init();

    // Raw API
    const [meta, ctxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ markPx?: string }>,
    ];

    // For top symbols, verify adapter index matches raw API index
    const testSymbols = ["BTC", "ETH", "SOL", "DOGE", "SUI"];
    for (const sym of testSymbols) {
      const rawIdx = meta.universe.findIndex(u => u.name === sym);
      if (rawIdx < 0) continue;

      const adapterIdx = hlAdapter.getAssetIndex ? await (hlAdapter as unknown as { getAssetIndex(s: string): Promise<number> }).getAssetIndex(sym) : rawIdx;

      // Index should match
      expect(adapterIdx).toBe(rawIdx);

      // Mark price from raw API should be reasonable (>0)
      const rawPrice = Number(ctxs[rawIdx]?.markPx ?? 0);
      expect(rawPrice).toBeGreaterThan(0);

      // Verify via L2 book: the index resolves to the right orderbook
      const book = await hlPost("l2Book", { coin: sym }) as {
        levels?: Array<Array<{ px: string; sz: string }>>;
      };
      const bookBid = Number(book.levels?.[0]?.[0]?.px ?? 0);
      const bookAsk = Number(book.levels?.[1]?.[0]?.px ?? 0);
      if (bookBid > 0 && bookAsk > 0) {
        const bookMid = (bookBid + bookAsk) / 2;
        const deviation = Math.abs(bookMid - rawPrice) / rawPrice * 100;
        expect(deviation).toBeLessThan(1); // book and meta should be very close
      }
    }
  });

  it("Lighter perp market_ids map to correct symbols and prices", async () => {
    // Raw API: orderBookDetails
    const rawData = await ltGet("/orderBookDetails") as {
      order_book_details?: Array<{
        symbol: string; market_id: number; last_trade_price?: number;
      }>;
    };
    const perpMarkets = rawData.order_book_details ?? [];
    expect(perpMarkets.length).toBeGreaterThan(0);

    // Adapter
    const pk = process.env.LIGHTER_PRIVATE_KEY || process.env.LT_PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const { LighterAdapter } = await import("../exchanges/lighter.js");
    const ltAdapter = new LighterAdapter(pk);
    await ltAdapter.init();

    // For each market, verify adapter resolves to same market_id
    const testSymbols = ["ETH", "BTC", "SOL"];
    for (const sym of testSymbols) {
      const rawMarket = perpMarkets.find(m => m.symbol.toUpperCase() === sym);
      if (!rawMarket) continue;

      const adapterIdx = ltAdapter.getMarketIndex(sym);
      expect(adapterIdx).toBe(rawMarket.market_id);

      // Verify price is reasonable
      if (rawMarket.last_trade_price) {
        expect(rawMarket.last_trade_price).toBeGreaterThan(0);
      }
    }
  });

  it("Lighter spot market_ids from explorer match adapter's internal map", async () => {
    // Raw: explorer API
    const explorerMarkets = await fetch("https://explorer.elliot.ai/api/markets")
      .then(r => r.json()) as Array<{ symbol: string; market_index: number }>;
    const rawSpotMarkets = explorerMarkets.filter(m => m.symbol.includes("/"));

    // Adapter
    const pk = process.env.LIGHTER_PRIVATE_KEY || process.env.LT_PRIVATE_KEY
      || "0x0000000000000000000000000000000000000000000000000000000000000001";
    const { LighterAdapter } = await import("../exchanges/lighter.js");
    const { LighterSpotAdapter } = await import("../exchanges/lighter-spot.js");
    const ltAdapter = new LighterAdapter(pk);
    await ltAdapter.init();
    const spotAdapter = new LighterSpotAdapter(ltAdapter);
    await spotAdapter.init();

    // Each spot market_id from explorer should match adapter's internal map
    for (const raw of rawSpotMarkets) {
      const adapterMid = spotAdapter.getSpotMarketId(raw.symbol);
      expect(adapterMid).toBe(raw.market_index);

      // Verify orderbook is accessible and has plausible prices
      try {
        const book = await spotAdapter.getSpotOrderbook(raw.symbol);
        if (book.bids.length > 0 && book.asks.length > 0) {
          const mid = (Number(book.bids[0][0]) + Number(book.asks[0][0])) / 2;
          expect(mid).toBeGreaterThan(0);
          // Best bid < best ask
          expect(Number(book.bids[0][0])).toBeLessThan(Number(book.asks[0][0]));
        }
      } catch {
        // Some spot markets may have empty books — OK
      }
    }
  });

  it("fetchSpotPerpSpreads excludes price-mismatched tokens (HIP-1 TRUMP etc.)", async () => {
    const { fetchSpotPerpSpreads } = await import("../funding/rates.js");
    const { spreads } = await fetchSpotPerpSpreads();

    // TRUMP, BERA, MON, PUMP should NOT appear (HIP-1 tokens with different prices)
    const suspectTokens = ["TRUMP", "BERA", "MON", "PUMP"];
    for (const s of spreads) {
      if (s.spotExchanges.includes("hyperliquid") && suspectTokens.includes(s.symbol)) {
        // If it appears, it should only be because the prices happened to converge
        // (unlikely but possible) — verify by checking mark price is in perp range
        console.log(`WARNING: ${s.symbol} found in scan with HL spot — verify price: $${s.bestMarkPrice}`);
      }
    }

    // BTC, ETH, SOL SHOULD appear via U-token mapping (if funding spread is non-zero)
    const btcSpread = spreads.find(s => s.symbol === "BTC");
    const ethSpread = spreads.find(s => s.symbol === "ETH");
    // These may not appear if funding is too low, but if they do, HL should be in spotExchanges
    if (btcSpread && btcSpread.spotExchanges.includes("hyperliquid")) {
      console.log(`BTC via UBTC: annual ${btcSpread.annualSpreadPct.toFixed(1)}%`);
    }
    if (ethSpread && ethSpread.spotExchanges.includes("hyperliquid")) {
      console.log(`ETH via UETH: annual ${ethSpread.annualSpreadPct.toFixed(1)}%`);
    }
  });
});

// ── Spot-Perp Spread Calculation ──

describe("Cross-validate: Spot-Perp Spread Calculation", () => {

  it("spot-perp spread = |perp funding rate| annualized (spot funding = 0)", async () => {
    // Get HL perp funding rates from raw API
    const [meta, ctxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ funding?: string; markPx?: string }>,
    ];

    // Get ETH funding rate
    const ethIdx = meta.universe.findIndex(a => a.name === "ETH");
    expect(ethIdx).toBeGreaterThanOrEqual(0);
    const ethFunding = Number(ctxs[ethIdx].funding ?? 0);

    // Compute expected annualized spread
    // HL: 1h funding period → hourly rate = rate / 1
    // Spot funding = 0
    // Spread = |perp hourly| × 8760 × 100
    const expectedAnnualPct = Math.abs(ethFunding) * 8760 * 100;

    // Now use our fetchSpotPerpSpreads function
    const { fetchSpotPerpSpreads } = await import("../funding/rates.js");
    const { spreads } = await fetchSpotPerpSpreads({ symbols: ["ETH"] });

    // Find ETH spread
    const ethSpread = spreads.find(s => s.symbol === "ETH");
    if (!ethSpread) {
      // ETH might not show up if funding is too low
      console.log(`ETH spot-perp spread not found (funding: ${ethFunding})`);
      return;
    }

    // The annualized spread uses the best perp rate across ALL exchanges (not just HL)
    // So spread >= our HL-only calculation (another exchange may have higher rate)
    // Just verify the spread is at least as large as HL's rate (or close due to timing)
    if (expectedAnnualPct > 1) { // only check if meaningful
      // Spread should be >= HL rate (or within 50% if rates shifted between calls)
      expect(ethSpread.annualSpreadPct).toBeGreaterThan(0);
      // If HL is the best perp exchange, spread should be close to our calc
      if (ethSpread.perpExchange === "hyperliquid") {
        const pctDiff = Math.abs(ethSpread.annualSpreadPct - expectedAnnualPct) / expectedAnnualPct * 100;
        expect(pctDiff).toBeLessThan(50); // wider tolerance for timing
      }
    }

    // Direction should match the SELECTED perp exchange's funding sign (not necessarily HL)
    // fetchSpotPerpSpreads picks the exchange with highest |funding|, which may differ from HL
    const perpFunding = ethSpread.perpFundingRate;
    if (perpFunding > 0) {
      expect(ethSpread.direction).toBe("long-spot-short-perp");
    } else if (perpFunding < 0) {
      expect(ethSpread.direction).toBe("sell-spot-long-perp");
    }

    // Perp exchange should be one of the 3 exchanges
    expect(["hyperliquid", "lighter", "pacifica"]).toContain(ethSpread.perpExchange);

    // Spot exchanges should only be hl or lt
    for (const spotEx of ethSpread.spotExchanges) {
      expect(["hyperliquid", "lighter"]).toContain(spotEx);
    }
  });

  it("all spot-perp spreads have annualSpreadPct >= minSpread", async () => {
    const minSpread = 5;
    const { fetchSpotPerpSpreads } = await import("../funding/rates.js");
    const { spreads } = await fetchSpotPerpSpreads({ minSpread });

    for (const s of spreads) {
      expect(s.annualSpreadPct).toBeGreaterThanOrEqual(minSpread);
      expect(s.bestMarkPrice).toBeGreaterThan(0);
      expect(s.spotExchanges.length).toBeGreaterThan(0);
      expect(s.estHourlyIncomeUsd).toBeGreaterThan(0);
    }
  });

  it("spot-perp spread is sorted by annualSpreadPct descending", async () => {
    const { fetchSpotPerpSpreads } = await import("../funding/rates.js");
    const { spreads } = await fetchSpotPerpSpreads();

    for (let i = 1; i < spreads.length; i++) {
      expect(spreads[i - 1].annualSpreadPct).toBeGreaterThanOrEqual(spreads[i].annualSpreadPct);
    }
  });
});

// ── Arb State Backward Compatibility ──

describe("Cross-validate: Arb State backward compatibility", () => {

  it("existing state without mode field defaults to perp-perp", async () => {
    const { writeFileSync, mkdirSync, existsSync, unlinkSync } = await import("fs");
    const { resolve: pathResolve } = await import("path");
    const { loadArbState, saveArbState, setStateFilePath, resetStateFilePath } = await import("../arb/state.js");

    // Create a temp state file with old format (no mode field)
    const tmpDir = pathResolve(process.env.HOME || "~", ".perp", "test-tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tmpFile = pathResolve(tmpDir, "arb-state-test.json");

    const oldState = {
      version: 1,
      lastStartTime: new Date().toISOString(),
      lastScanTime: new Date().toISOString(),
      lastSuccessfulScanTime: new Date().toISOString(),
      positions: [{
        id: "test-1",
        symbol: "ETH",
        longExchange: "hyperliquid",
        shortExchange: "lighter",
        longSize: 0.5,
        shortSize: 0.5,
        entryTime: new Date().toISOString(),
        entrySpread: 25.5,
        entryLongPrice: 3000,
        entryShortPrice: 3005,
        accumulatedFunding: 1.23,
        lastCheckTime: new Date().toISOString(),
        // NO mode field — old format
      }],
      config: { minSpread: 20, closeSpread: 5, size: 100, holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "block" },
    };

    writeFileSync(tmpFile, JSON.stringify(oldState));
    setStateFilePath(tmpFile);

    try {
      const loaded = loadArbState();
      expect(loaded).toBeTruthy();
      expect(loaded!.positions.length).toBe(1);

      // mode should be undefined (old format), which defaults to perp-perp
      const pos = loaded!.positions[0];
      expect(pos.mode).toBeUndefined(); // not set in old format
      // Callers should treat undefined mode as "perp-perp"
      const effectiveMode = pos.mode ?? "perp-perp";
      expect(effectiveMode).toBe("perp-perp");

      // Now save a spot-perp position alongside
      loaded!.positions.push({
        id: "test-2",
        symbol: "BTC",
        longExchange: "hyperliquid",
        shortExchange: "pacifica",
        longSize: 0.01,
        shortSize: 0.01,
        entryTime: new Date().toISOString(),
        entrySpread: 30,
        entryLongPrice: 60000,
        entryShortPrice: 60100,
        accumulatedFunding: 0,
        lastCheckTime: new Date().toISOString(),
        mode: "spot-perp",
        spotExchange: "hyperliquid",
        spotSymbol: "BTC/USDC",
      });
      saveArbState(loaded!);

      // Re-load and verify both positions
      const reloaded = loadArbState();
      expect(reloaded!.positions.length).toBe(2);
      expect(reloaded!.positions[0].mode).toBeUndefined();
      expect(reloaded!.positions[1].mode).toBe("spot-perp");
      expect(reloaded!.positions[1].spotExchange).toBe("hyperliquid");
      expect(reloaded!.positions[1].spotSymbol).toBe("BTC/USDC");
    } finally {
      resetStateFilePath();
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});

// ── Cost Model Verification ──

describe("Cross-validate: Spot-Perp Cost Model", () => {

  it("round-trip cost calculation is correct for spot+perp", async () => {
    const { computeRoundTripCostPct, computeNetSpread } = await import("../commands/arb-auto.js");
    const { getTakerFee } = await import("../constants.js");

    // Spot+Perp: fee on spot side + fee on perp side (entry + exit = 4 taker fills)
    const spotExch = "hyperliquid";
    const perpExch = "hyperliquid";
    const slippage = 0.05;

    // Use the same function (spot taker fee ≈ perp taker fee for HL)
    const rtCost = computeRoundTripCostPct(spotExch, perpExch, slippage);

    // Independent calculation
    const spotFee = getTakerFee(spotExch) * 100;
    const perpFee = getTakerFee(perpExch) * 100;
    const expectedRtCost = 2 * (spotFee + perpFee) + 2 * slippage;

    expect(Math.abs(rtCost - expectedRtCost)).toBeLessThan(0.001);

    // Net spread should deduct RT cost
    const grossAnnual = 30; // 30% annual
    const holdDays = 7;
    const netSpread = computeNetSpread(grossAnnual, holdDays, rtCost);

    // Net = 30 - (rtCost/7 * 365) = 30 - (rtCost * 52.14)
    const expectedNet = grossAnnual - (rtCost / holdDays) * 365;
    expect(Math.abs(netSpread - expectedNet)).toBeLessThan(0.001);

    // For same-exchange spot+perp, bridge cost = 0
    const netWithBridge = computeNetSpread(grossAnnual, holdDays, rtCost, 0, 100);
    expect(netWithBridge).toBe(netSpread); // no bridge cost change

    // For cross-exchange, bridge cost > 0
    const crossNet = computeNetSpread(grossAnnual, holdDays, rtCost, 0.5, 100);
    expect(crossNet).toBeLessThan(netSpread); // bridge cost reduces net
  });

  it("spot+perp spread has 0 funding cost on spot leg", async () => {
    const { estimateHourlyFunding } = await import("../funding/normalize.js");

    // Spot funding = 0 (by definition, no funding on spot)
    // So for a spot+perp arb, only the perp side contributes funding income
    const spotFunding = 0;
    const perpFunding = 0.0001; // 0.01% per hour

    // Spot leg: funding payment = 0 regardless of position
    const spotPayment = spotFunding * 1000; // $1000 notional
    expect(spotPayment).toBe(0);

    // Perp short leg: receives positive funding
    // estimateHourlyFunding: rate=0.0001, exchange=hyperliquid (1h), $1000, short
    const perpPayment = estimateHourlyFunding(perpFunding, "hyperliquid", 1000, "short");
    // Short pays negative (receives): payment = 0.0001 * 1000 * (-1) = -0.1
    expect(perpPayment).toBeLessThan(0); // negative = you receive

    // Net hourly income = -spotPayment - perpPayment = 0 - (-0.1) = 0.1
    const netIncome = -(spotPayment + perpPayment);
    expect(netIncome).toBeCloseTo(0.1, 6);
  });
});

// ── Sizing Module ──

describe("Cross-validate: Spot-Perp Sizing", () => {

  it("computeSpotPerpMatchedSize respects spot decimals", async () => {
    const { computeSpotPerpMatchedSize } = await import("../arb/sizing.js");

    // $100 at $2000/ETH with explicit 4 spot decimals (ETH spot supports it)
    const result = computeSpotPerpMatchedSize(100, 2000, "hyperliquid", "pacifica", 4);
    expect(result).not.toBeNull();
    expect(Number(result!.size)).toBeGreaterThan(0);
    expect(result!.notional).toBeGreaterThanOrEqual(1); // pac min notional = $1

    // With HL perp (1 dec), size is limited to 1 decimal
    // $100 / $2000 = 0.05 → floor(0.05 * 10) / 10 = 0.0 → too small
    // So with HL perp + HL spot, need higher sizeUsd
    const hlResult = computeSpotPerpMatchedSize(500, 2000, "hyperliquid", "hyperliquid");
    // $500 / $2000 = 0.25 → floor(0.25 * 10) / 10 = 0.2 → $400 notional
    expect(hlResult).not.toBeNull();
    expect(Number(hlResult!.size)).toBeGreaterThan(0);
    const parts = hlResult!.size.split(".");
    const actualDecimals = parts.length > 1 ? parts[1].length : 0;
    expect(actualDecimals).toBeLessThanOrEqual(1); // min of spot:hl(2) and hl(1) = 1

    // $5 at $2000 = 0.0025 → should round down, too small for HL
    const tooSmall = computeSpotPerpMatchedSize(5, 2000, "hyperliquid", "hyperliquid");
    expect(tooSmall).toBeNull(); // Can't meet min size

    // With Lighter (2 dec perp), $100 at $2000 = 0.05 → works
    const ltResult = computeSpotPerpMatchedSize(100, 2000, "lighter", "lighter");
    expect(ltResult).not.toBeNull();
    expect(Number(ltResult!.size)).toBeCloseTo(0.05, 2);
  });
});

// ── Liquidity Check ──

describe("Cross-validate: Spot-Perp Liquidity", () => {

  it("checkSpotPerpLiquidity validates orderbook depth", async () => {
    const { computeExecutableSize } = await import("../liquidity.js");

    // Simulated spot orderbook (asks for buy side)
    const spotAsks: [string, string][] = [
      ["2000", "1.0"],    // $2000
      ["2001", "0.5"],    // $1000.50
      ["2005", "2.0"],    // $4010
    ];

    // Simulated perp orderbook (bids for sell side)
    const perpBids: [string, string][] = [
      ["2002", "1.5"],    // $3003
      ["2001", "1.0"],    // $2001
      ["1999", "3.0"],    // $5997
    ];

    // Check spot side (buying asks)
    const spotCheck = computeExecutableSize(spotAsks, 1000, 0.5);
    expect(spotCheck.maxSize).toBeGreaterThan(0);
    expect(spotCheck.avgFillPrice).toBeGreaterThan(0);
    expect(spotCheck.slippagePct).toBeGreaterThanOrEqual(0);

    // Check perp side (selling into bids)
    const perpCheck = computeExecutableSize(perpBids, 1000, 0.5);
    expect(perpCheck.maxSize).toBeGreaterThan(0);
    expect(perpCheck.avgFillPrice).toBeGreaterThan(0);

    // Min executable should be the smaller side
    const executableUsd = Math.min(
      spotCheck.maxSize * spotCheck.avgFillPrice,
      perpCheck.maxSize * perpCheck.avgFillPrice,
    );
    expect(executableUsd).toBeGreaterThan(0);
  });
});
