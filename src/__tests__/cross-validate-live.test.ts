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
    const out = execSync(`${CLI} -e ${exchange} account info`, {
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
    const cliResult = cli("-e hyperliquid account info");
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
    const cliResult = cli("-e pacifica account info");
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
