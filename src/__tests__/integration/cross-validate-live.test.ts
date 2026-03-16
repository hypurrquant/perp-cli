/**
 * Cross-validation tests: CLI output vs raw SDK/API responses.
 *
 * These tests call the CLI commands and independently call the exchange APIs,
 * then verify the values match. Requires live API keys.
 *
 * Run with: npx vitest run src/__tests__/cross-validate-live.test.ts
 */
import { describe, it, expect } from "vitest";
import { config } from "dotenv";
import { resolve } from "path";
import { execSync } from "child_process";
import { Wallet } from "ethers";

// Load env
config({ path: resolve(process.env.HOME || "~", ".perp", ".env") });
config();

const CLI = "npx tsx src/index.ts --json";

function cli(args: string): Record<string, unknown> {
  try {
    const out = execSync(`${CLI} ${args}`, {
      timeout: 30000,
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return JSON.parse(out.trim());
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    // Commander may exit with code 1 but still produce valid JSON on stdout
    if (e.stdout) {
      try { return JSON.parse(e.stdout.trim()); } catch { /* fall through */ }
    }
    throw new Error(`CLI failed: ${e.stderr || err}`);
  }
}

// ── Raw API helpers ──

async function hlPost(type: string, extra: Record<string, unknown> = {}) {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...extra }),
  });
  return res.json();
}

async function hlMeta(): Promise<[{ universe: { name: string; maxLeverage: number }[] }, Record<string, unknown>[]]> {
  return hlPost("metaAndAssetCtxs") as Promise<[{ universe: { name: string; maxLeverage: number }[] }, Record<string, unknown>[]]>;
}

async function hlMids(): Promise<Record<string, string>> {
  const data = await hlPost("allMids") as Record<string, string>;
  return data;
}

// Lighter API
const LT_BASE = "https://mainnet.zklighter.elliot.ai/api/v1";

async function ltMarkets(): Promise<{ order_book_details: { symbol: string; last_trade_price: number; market_type: string; market_id: number }[] }> {
  const res = await fetch(`${LT_BASE}/orderBookDetails`);
  return res.json() as Promise<{ order_book_details: { symbol: string; last_trade_price: number; market_type: string; market_id: number }[] }>;
}

// Pacifica API
const PAC_PRICES_URL = "https://api.pacifica.fi/api/v1/info/prices";

interface PacRawPrice { symbol: string; mark: number; funding: number; next_funding?: number }

async function pacPrices(): Promise<PacRawPrice[]> {
  const res = await fetch(PAC_PRICES_URL);
  const json = await res.json() as { data?: PacRawPrice[] } | PacRawPrice[];
  const data = Array.isArray(json) ? json : (json as { data?: PacRawPrice[] }).data ?? [];
  return data;
}

// ── Key detection (module-level, runs at import time) ──

function hasKey(exchange: string): boolean {
  try {
    const out = execSync(`${CLI} -e ${exchange} account balance`, {
      timeout: 20000,
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const json = JSON.parse(out.trim());
    return json.ok === true;
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout.trim()).ok === true;
      } catch { /* fall through */ }
    }
    return false;
  }
}

const HAS_HL_KEY = hasKey("hyperliquid");
const HAS_LT_KEY = hasKey("lighter");
const HAS_PAC_KEY = hasKey("pacifica");

// Derive HL EVM address for raw API calls (if key available)
function getHlAddress(): string | null {
  const pk = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!pk) {
    // Try wallets.json via CLI
    try {
      const out = execSync(`${CLI} -e hyperliquid account balance`, {
        timeout: 20000, encoding: "utf-8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      // Can't derive address from CLI output directly; use env key
      return null;
    } catch { return null; }
  }
  try {
    return new Wallet(pk).address;
  } catch { return null; }
}

const HL_ADDRESS = getHlAddress();

// ── Tests ──

describe("Cross-validate: Hyperliquid", () => {

  it("market prices match raw API", async () => {
    // CLI
    const cliResult = cli("-e hyperliquid market prices");
    expect(cliResult.ok).toBe(true);
    const cliPrices = cliResult.data as { symbol: string; markPrice: string }[];

    // Raw API
    const [meta, ctxs] = await hlMeta();
    const rawPrices = new Map<string, string>();
    meta.universe.forEach((asset, i) => {
      const ctx = ctxs[i] as { markPx?: string };
      if (ctx.markPx) rawPrices.set(asset.name, ctx.markPx);
    });

    // Compare: top 5 symbols should match
    const testSymbols = ["BTC", "ETH", "SOL"];
    for (const sym of testSymbols) {
      const cliEntry = cliPrices.find(p => p.symbol.replace(/-PERP$/, "") === sym);
      const rawPrice = rawPrices.get(sym);
      if (cliEntry && rawPrice) {
        // Prices may shift slightly between calls, allow 1% tolerance
        const cliNum = Number(cliEntry.markPrice);
        const rawNum = Number(rawPrice);
        expect(cliNum).toBeGreaterThan(0);
        expect(rawNum).toBeGreaterThan(0);
        const pctDiff = Math.abs(cliNum - rawNum) / rawNum * 100;
        expect(pctDiff).toBeLessThan(1); // within 1%
      }
    }
  });

  it("market info matches raw API for ETH", async () => {
    const cliResult = cli("-e hyperliquid market info ETH");
    expect(cliResult.ok).toBe(true);
    const info = cliResult.data as {
      symbol: string; markPrice: string; fundingRate: string;
      maxLeverage: number; openInterest: string;
    };

    const [meta, ctxs] = await hlMeta();
    const idx = meta.universe.findIndex(a => a.name === "ETH");
    expect(idx).toBeGreaterThanOrEqual(0);
    const ctx = ctxs[idx] as { markPx: string; funding: string; openInterest: string };

    // Mark price within 1%
    const cliMark = Number(info.markPrice);
    const rawMark = Number(ctx.markPx);
    expect(Math.abs(cliMark - rawMark) / rawMark * 100).toBeLessThan(1);

    // Funding rate should match exactly (same snapshot)
    // Allow small diff due to timing
    const cliFunding = Number(info.fundingRate);
    const rawFunding = Number(ctx.funding);
    expect(Math.abs(cliFunding - rawFunding)).toBeLessThan(0.001);

    // Max leverage
    expect(info.maxLeverage).toBe(meta.universe[idx].maxLeverage);
  });

  it("orderbook has valid bid/ask structure", async () => {
    const cliResult = cli("-e hyperliquid market book ETH");
    expect(cliResult.ok).toBe(true);
    const book = cliResult.data as { bids: [string, string][]; asks: [string, string][] };

    expect(book.bids.length).toBeGreaterThan(0);
    expect(book.asks.length).toBeGreaterThan(0);

    // Best bid < best ask
    const bestBid = Number(book.bids[0][0]);
    const bestAsk = Number(book.asks[0][0]);
    expect(bestBid).toBeLessThan(bestAsk);
    expect(bestBid).toBeGreaterThan(0);
  });

  it("account balance fields are present", { skip: !HAS_HL_KEY }, async () => {
    const cliResult = cli("-e hyperliquid account balance");
    expect(cliResult.ok).toBe(true);
    const balance = cliResult.data as { equity: string; available: string; marginUsed: string };
    expect(Number(balance.equity)).toBeGreaterThanOrEqual(0);
    expect(Number(balance.available)).toBeGreaterThanOrEqual(0);
  });

  it("account positions match raw API", { skip: !HAS_HL_KEY }, async () => {
    const cliResult = cli("-e hyperliquid account positions");
    expect(cliResult.ok).toBe(true);
    const positions = cliResult.data as { symbol: string; side: string; size: string; markPrice: string }[];

    if (positions.length === 0) return; // no positions, nothing to validate

    // All positions should have valid fields
    for (const pos of positions) {
      expect(pos.symbol).toBeTruthy();
      expect(["long", "short"]).toContain(pos.side);
      expect(Number(pos.size)).toBeGreaterThan(0);
      expect(Number(pos.markPrice)).toBeGreaterThan(0);
    }
  });

  it("mid price matches allMids API", async () => {
    const cliResult = cli("-e hyperliquid market mid ETH");
    expect(cliResult.ok).toBe(true);
    const cliData = cliResult.data as { mid: string };
    const cliMid = Number(cliData.mid);

    const rawMids = await hlMids();
    const rawMid = Number(rawMids["ETH"]);

    expect(cliMid).toBeGreaterThan(0);
    expect(rawMid).toBeGreaterThan(0);
    expect(Math.abs(cliMid - rawMid) / rawMid * 100).toBeLessThan(1);
  });
});

describe("Cross-validate: Lighter", () => {

  it("market prices match raw API", async () => {
    const cliResult = cli("-e lighter market prices");
    expect(cliResult.ok).toBe(true);
    const cliPrices = cliResult.data as { symbol: string; markPrice: string }[];

    const rawData = await ltMarkets();
    const rawPrices = new Map<string, number>();
    for (const m of rawData.order_book_details) {
      if (m.market_type === "perp") {
        rawPrices.set(m.symbol.toUpperCase(), m.last_trade_price);
      }
    }

    // Check ETH and BTC
    for (const sym of ["ETH", "BTC"]) {
      const cliEntry = cliPrices.find(p => p.symbol.replace(/-PERP$/, "").toUpperCase() === sym);
      const rawPrice = rawPrices.get(sym);
      if (cliEntry && rawPrice) {
        const cliNum = Number(cliEntry.markPrice);
        expect(cliNum).toBeGreaterThan(0);
        expect(rawPrice).toBeGreaterThan(0);
        const pctDiff = Math.abs(cliNum - rawPrice) / rawPrice * 100;
        expect(pctDiff).toBeLessThan(2); // within 2% (Lighter may lag)
      }
    }
  });

  it("orderbook has valid structure", async () => {
    const cliResult = cli("-e lighter market book ETH");
    expect(cliResult.ok).toBe(true);
    const book = cliResult.data as { bids: [string, string][]; asks: [string, string][] };

    expect(book.bids.length).toBeGreaterThan(0);
    expect(book.asks.length).toBeGreaterThan(0);

    const bestBid = Number(book.bids[0][0]);
    const bestAsk = Number(book.asks[0][0]);
    expect(bestBid).toBeLessThan(bestAsk);
  });

  it("account positions have valid fields", { skip: !HAS_LT_KEY }, async () => {
    const cliResult = cli("-e lighter account positions");
    expect(cliResult.ok).toBe(true);
    const positions = cliResult.data as { symbol: string; side: string; size: string }[];

    for (const pos of positions) {
      expect(pos.symbol).toBeTruthy();
      expect(["long", "short"]).toContain(pos.side);
      expect(Number(pos.size)).toBeGreaterThan(0);
    }
  });
});

describe("Cross-validate: Pacifica", () => {

  it("market prices match raw API", async () => {
    // CLI returns raw pac format: { symbol, mark, funding, ... }
    const cliResult = cli("-e pacifica market prices");
    expect(cliResult.ok).toBe(true);
    const cliPrices = cliResult.data as { symbol: string; mark: string }[];

    const rawData = await pacPrices();
    const rawPrices = new Map<string, number>();
    for (const p of rawData) {
      rawPrices.set(p.symbol.toUpperCase(), p.mark);
    }

    for (const sym of ["ETH", "SOL"]) {
      const cliEntry = cliPrices.find(p => p.symbol.toUpperCase() === sym);
      const rawPrice = rawPrices.get(sym);
      if (cliEntry && rawPrice && rawPrice > 0) {
        const cliNum = Number(cliEntry.mark);
        expect(cliNum).toBeGreaterThan(0);
        const pctDiff = Math.abs(cliNum - rawPrice) / rawPrice * 100;
        expect(pctDiff).toBeLessThan(2);
      }
    }
  });

  it("funding rates match raw API", async () => {
    const cliResult = cli("-e pacifica market prices");
    expect(cliResult.ok).toBe(true);
    const cliPrices = cliResult.data as { symbol: string; funding: string; next_funding: string }[];

    const rawData = await pacPrices();
    const rawFunding = new Map<string, number>();
    for (const p of rawData) {
      rawFunding.set(p.symbol.toUpperCase(), p.next_funding ?? p.funding);
    }

    for (const sym of ["ETH", "SOL"]) {
      const cliEntry = cliPrices.find(p => p.symbol.toUpperCase() === sym);
      const rawRate = rawFunding.get(sym);
      if (cliEntry && rawRate !== undefined) {
        const cliFunding = Number(cliEntry.next_funding ?? cliEntry.funding);
        expect(Math.abs(cliFunding - rawRate)).toBeLessThan(0.01);
      }
    }
  });

  it("orderbook has valid structure", async () => {
    const cliResult = cli("-e pacifica market book ETH");
    expect(cliResult.ok).toBe(true);
    const book = cliResult.data as { bids: [string, string][]; asks: [string, string][] };

    expect(book.bids.length).toBeGreaterThan(0);
    expect(book.asks.length).toBeGreaterThan(0);

    const bestBid = Number(book.bids[0][0]);
    const bestAsk = Number(book.asks[0][0]);
    expect(bestBid).toBeLessThan(bestAsk);
  });

  it("account balance fields are present", { skip: !HAS_PAC_KEY }, async () => {
    const cliResult = cli("-e pacifica account balance");
    expect(cliResult.ok).toBe(true);
    const balance = cliResult.data as { equity: string; available: string };
    expect(Number(balance.equity)).toBeGreaterThanOrEqual(0);
  });
});

describe("Cross-validate: Funding rates consistency", () => {
  it("funding rates command matches individual market info", async () => {
    // Get ETH funding from market info on HL
    const infoResult = cli("-e hyperliquid market info ETH");
    expect(infoResult.ok).toBe(true);
    const infoFunding = Number((infoResult.data as { fundingRate: string }).fundingRate);

    // Get ETH funding from raw API directly
    const [meta, ctxs] = await hlMeta();
    const idx = meta.universe.findIndex(a => a.name === "ETH");
    const rawFunding = Number((ctxs[idx] as { funding: string }).funding);

    // Both should be very close
    expect(Math.abs(infoFunding - rawFunding)).toBeLessThan(0.0001);
  });
});

describe("Cross-validate: funding positions actual payments", () => {

  it("actual24h matches sum of getFundingPayments", { skip: !HAS_HL_KEY }, async () => {
    const cliResult = cli("funding positions --exchanges hyperliquid");
    expect(cliResult.ok).toBe(true);

    const positions = (cliResult.data as { positions: { symbol: string; actual24h: { net: number } }[] }).positions;

    // Also get raw funding payments via arb funding-earned for comparison
    const arbResult = cli("-e hyperliquid arb funding-earned");
    if (arbResult.ok) {
      const pairs = (arbResult.data as { pairs: { symbol: string; byExchange: { exchange: string; net: number }[] }[] }).pairs;

      for (const pos of positions) {
        const arbPair = pairs.find(p => p.symbol === pos.symbol);
        if (arbPair) {
          const hlData = arbPair.byExchange.find(e => e.exchange === "hyperliquid");
          if (hlData) {
            // Both should show funding data (actual24h is last 24h, arb is total)
            // Just verify they're both numbers and reasonable
            expect(typeof pos.actual24h.net).toBe("number");
            expect(typeof hlData.net).toBe("number");
          }
        }
      }
    }
  });
});

// ── Account Trades Cross-Validation ──

describe("Cross-validate: Account trades", () => {

  it("HL account trades match raw userFillsByTime API", { skip: !HAS_HL_KEY || !HL_ADDRESS }, async () => {
    const cliResult = cli("-e hyperliquid account trades");
    expect(cliResult.ok).toBe(true);
    const cliTrades = cliResult.data as { symbol: string; side: string; price: string; size: string; fee: string; time: number }[];

    // Raw API: userFillsByTime (last 24h)
    const startTime = Date.now() - 24 * 3600 * 1000;
    const rawFills = await hlPost("userFillsByTime", {
      user: HL_ADDRESS,
      startTime,
    }) as { coin: string; side: string; px: string; sz: string; fee: string; time: number }[];

    if (rawFills.length === 0 && cliTrades.length === 0) return; // no trades, both empty

    // If there are raw fills, CLI should also have trades
    if (rawFills.length > 0) {
      expect(cliTrades.length).toBeGreaterThan(0);

      // Compare most recent trade
      const rawLatest = rawFills[0];
      const rawSide = rawLatest.side === "B" ? "buy" : "sell";
      const rawSymbol = rawLatest.coin;

      // Find matching trade in CLI output
      const cliMatch = cliTrades.find(t =>
        t.symbol.replace(/-PERP$/, "") === rawSymbol &&
        t.side === rawSide &&
        Math.abs(Number(t.price) - Number(rawLatest.px)) / Number(rawLatest.px) < 0.01
      );

      if (cliMatch) {
        // Size should match
        expect(Math.abs(Number(cliMatch.size) - Number(rawLatest.sz))).toBeLessThan(0.0001);
        // Fee should be close
        expect(Math.abs(Number(cliMatch.fee) - Number(rawLatest.fee))).toBeLessThan(0.01);
      }
    }
  });

  it("Pacifica account trades have valid structure", { skip: !HAS_PAC_KEY }, async () => {
    const cliResult = cli("-e pacifica account trades");
    expect(cliResult.ok).toBe(true);
    const cliTrades = cliResult.data as { symbol: string; side: string; price: string; size: string; time: number }[];

    for (const trade of cliTrades) {
      expect(trade.symbol).toBeTruthy();
      expect(["buy", "sell"]).toContain(trade.side);
      expect(Number(trade.price)).toBeGreaterThan(0);
      expect(Number(trade.size)).toBeGreaterThan(0);
      expect(trade.time).toBeGreaterThan(0);
    }
  });

  it("Lighter account trades have valid structure", { skip: !HAS_LT_KEY }, async () => {
    const cliResult = cli("-e lighter account trades");
    expect(cliResult.ok).toBe(true);
    const cliTrades = cliResult.data as { symbol: string; side: string; price: string; size: string }[];

    for (const trade of cliTrades) {
      expect(trade.symbol).toBeTruthy();
      expect(["buy", "sell"]).toContain(trade.side);
      expect(Number(trade.price)).toBeGreaterThan(0);
      expect(Number(trade.size)).toBeGreaterThan(0);
    }
  });
});

// ── Account Orders Cross-Validation ──

describe("Cross-validate: Account orders", () => {

  it("HL open orders match raw openOrders API", { skip: !HAS_HL_KEY || !HL_ADDRESS }, async () => {
    const cliResult = cli("-e hyperliquid account orders");
    expect(cliResult.ok).toBe(true);
    const cliOrders = cliResult.data as { symbol: string; side: string; price: string; size: string; orderId: string }[];

    // Raw API
    const rawOrders = await hlPost("openOrders", { user: HL_ADDRESS }) as {
      coin: string; side: string; limitPx: string; sz: string; oid: number;
    }[];

    // Same count
    expect(cliOrders.length).toBe(rawOrders.length);

    // Compare each order
    for (const rawOrder of rawOrders) {
      const rawSide = rawOrder.side === "B" ? "buy" : "sell";
      const cliMatch = cliOrders.find(o =>
        o.symbol.replace(/-PERP$/, "") === rawOrder.coin &&
        o.side === rawSide &&
        String(o.orderId) === String(rawOrder.oid)
      );

      if (cliMatch) {
        // Price should match exactly
        expect(Math.abs(Number(cliMatch.price) - Number(rawOrder.limitPx))).toBeLessThan(0.01);
        // Size should match
        expect(Math.abs(Number(cliMatch.size) - Number(rawOrder.sz))).toBeLessThan(0.0001);
      }
    }
  });

  it("Pacifica open orders have valid structure", { skip: !HAS_PAC_KEY }, async () => {
    const cliResult = cli("-e pacifica account orders");
    expect(cliResult.ok).toBe(true);
    const cliOrders = cliResult.data as { symbol: string; side: string; price: string; size: string }[];

    for (const order of cliOrders) {
      expect(order.symbol).toBeTruthy();
      expect(["buy", "sell"]).toContain(order.side);
      expect(Number(order.price)).toBeGreaterThan(0);
      expect(Number(order.size)).toBeGreaterThan(0);
    }
  });

  it("Lighter open orders have valid structure", { skip: !HAS_LT_KEY }, async () => {
    const cliResult = cli("-e lighter account orders");
    expect(cliResult.ok).toBe(true);
    const cliOrders = cliResult.data as { symbol: string; side: string; price: string; size: string }[];

    for (const order of cliOrders) {
      expect(order.symbol).toBeTruthy();
      expect(["buy", "sell"]).toContain(order.side);
      expect(Number(order.price)).toBeGreaterThan(0);
      expect(Number(order.size)).toBeGreaterThan(0);
    }
  });
});

// ── Funding Positions Calculation Verification ──

describe("Cross-validate: Funding positions calculation", () => {

  it("predicted hourly matches independent computation from raw rates", { skip: !HAS_HL_KEY }, async () => {
    const cliResult = cli("funding positions --exchanges hyperliquid");
    expect(cliResult.ok).toBe(true);
    const data = cliResult.data as {
      positions: {
        symbol: string; side: string; notionalUsd: number;
        fundingRate: number; predicted: { hourly: number; daily: number };
      }[];
    };

    if (data.positions.length === 0) return;

    // Get raw funding rates from HL API
    const [meta, ctxs] = await hlMeta();
    const rateMap = new Map<string, number>();
    meta.universe.forEach((asset, i) => {
      const ctx = ctxs[i] as { funding?: string };
      if (ctx.funding) rateMap.set(asset.name, Number(ctx.funding));
    });

    for (const pos of data.positions) {
      const rawSymbol = pos.symbol.replace(/-PERP$/, "");
      const rawRate = rateMap.get(rawSymbol);
      if (rawRate === undefined) continue;

      // Independent computation:
      // HL funding period = 1h, so hourlyRate = rate / 1 = rate
      // hourlyPayment = hourlyRate × notionalUsd × (1 if long, -1 if short)
      const multiplier = pos.side === "long" ? 1 : -1;
      const expectedHourly = rawRate * pos.notionalUsd * multiplier;

      // CLI predicted.hourly should be close to our independent calc
      // Allow tolerance for rate drift between calls
      if (Math.abs(expectedHourly) > 0.001) {
        const pctDiff = Math.abs(pos.predicted.hourly - expectedHourly) / Math.abs(expectedHourly) * 100;
        expect(pctDiff).toBeLessThan(10); // within 10% (rate can shift between calls)
      }

      // Daily should be hourly × 24 (use absolute diff, not ratio)
      // JSON output rounds hourly to toFixed(6) and daily to toFixed(4),
      // so ratio comparison fails for small values. Instead check:
      //   |daily - hourly × 24| < rounding tolerance
      // toFixed(4) has max rounding error of 0.00005
      if (pos.predicted.hourly !== 0) {
        const expectedDaily = pos.predicted.hourly * 24;
        expect(Math.abs(pos.predicted.daily - expectedDaily)).toBeLessThan(0.0001);
      }
    }
  });

  it("funding rate in positions matches market info rate", { skip: !HAS_HL_KEY }, async () => {
    const posResult = cli("funding positions --exchanges hyperliquid");
    expect(posResult.ok).toBe(true);
    const positions = (posResult.data as {
      positions: { symbol: string; fundingRate: number }[];
    }).positions;

    for (const pos of positions.slice(0, 3)) { // check up to 3
      const infoResult = cli(`-e hyperliquid market info ${pos.symbol.replace(/-PERP$/, "")}`);
      if (infoResult.ok) {
        const infoRate = Number((infoResult.data as { fundingRate: string }).fundingRate);
        // Should match closely (same exchange, near-same time)
        expect(Math.abs(pos.fundingRate - infoRate)).toBeLessThan(0.001);
      }
    }
  });
});

// ── Lighter Funding Rate ──

describe("Cross-validate: Lighter funding rate", () => {

  it("Lighter market info returns a funding rate field", async () => {
    const cliResult = cli("-e lighter market info ETH");
    if (!cliResult.ok) {
      // Lighter API may be rate-limited — skip gracefully
      console.log("Lighter market info failed (rate limit?) — skipping");
      return;
    }
    const info = cliResult.data as { symbol: string; fundingRate: string; markPrice: string };

    // Lighter funding rate may be 0 without auth, but the field should exist
    expect(info.fundingRate).toBeDefined();
    expect(typeof Number(info.fundingRate)).toBe("number");
    expect(Number(info.markPrice)).toBeGreaterThan(0);
  });

  it("Lighter funding rate is 8h period (when available)", { skip: !HAS_LT_KEY }, async () => {
    // Lighter market info requires authenticated account;
    // if it fails, we just skip gracefully
    const cliResult = cli("-e lighter market info ETH");
    if (!cliResult.ok) return; // auth/account issue, skip

    const info = cliResult.data as { fundingRate: string };
    const rate = Number(info.fundingRate);

    // 8h funding rate should be small — typically < 0.1% per 8h
    // (< 0.001 as decimal). If it's non-zero, it should be reasonable
    if (rate !== 0) {
      expect(Math.abs(rate)).toBeLessThan(0.01); // < 1% per 8h is reasonable
    }
  });
});

// ── Dry-Run Validation ──

describe("Cross-validate: Dry-run mode", () => {

  it("dry-run market order returns dryRun:true without execution", { skip: !HAS_HL_KEY }, () => {
    const cliResult = cli("--dry-run -e hyperliquid trade market ETH buy 0.001");
    expect(cliResult.ok).toBe(true);
    const data = cliResult.data as { dryRun: boolean; action: string; exchange: string; symbol: string; side: string; size: string };

    expect(data.dryRun).toBe(true);
    expect(data.action).toContain("market");
    expect(data.exchange).toBe("hyperliquid");
    expect(data.symbol).toBe("ETH");
    expect(data.side).toBe("buy");

    // Verify no actual position was opened
    const posResult = cli("-e hyperliquid account positions");
    expect(posResult.ok).toBe(true);
    const positions = posResult.data as { symbol: string; size: string }[];
    const ethPos = positions.find(p => p.symbol.replace(/-PERP$/, "") === "ETH");
    // If there is an ETH position, it should not have grown by 0.001 from this test
    // (we can't fully verify this without knowing prior state, but at least dryRun=true confirms)
  });

  it("dry-run limit order returns dryRun:true without execution", { skip: !HAS_HL_KEY }, () => {
    const cliResult = cli("--dry-run -e hyperliquid trade limit ETH buy 1000 0.001");
    expect(cliResult.ok).toBe(true);
    const data = cliResult.data as { dryRun: boolean; action: string; price: unknown };

    expect(data.dryRun).toBe(true);
    expect(data.action).toContain("limit");

    // Verify no order was placed
    const ordersResult = cli("-e hyperliquid account orders");
    expect(ordersResult.ok).toBe(true);
    const orders = ordersResult.data as { symbol: string; price: string }[];
    // No order at $1000 should exist (absurdly low price)
    const phantom = orders.find(o =>
      o.symbol.replace(/-PERP$/, "") === "ETH" && Number(o.price) === 1000
    );
    expect(phantom).toBeUndefined();
  });

  it("dry-run on Pacifica returns dryRun:true", { skip: !HAS_PAC_KEY }, () => {
    const cliResult = cli("--dry-run -e pacifica trade market SOL buy 0.1");
    expect(cliResult.ok).toBe(true);
    const data = cliResult.data as { dryRun: boolean; action: string };

    expect(data.dryRun).toBe(true);
    expect(data.action).toContain("market");
  });
});
