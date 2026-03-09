import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the funding-rates module.
 *
 * These test the core comparison/normalization logic using mocked API responses.
 * Integration tests that hit real APIs live in integration/.
 */

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocking fetch
const { fetchAllFundingRates, fetchSymbolFundingRates, TOP_SYMBOLS } = await import("../funding-rates.js");

// ── Helpers to build mock API responses ──

function makePacificaResponse(rates: { symbol: string; funding: number; mark: number }[]) {
  return { data: rates };
}

function makeHyperliquidResponse(
  assets: { name: string }[],
  ctxs: { funding: number; markPx: number }[]
) {
  return [{ universe: assets }, ctxs];
}

function makeLighterResponse(
  details: { market_id: number; symbol: string; last_trade_price: number }[],
  fundingRates: { market_id: number; symbol?: string; rate: number }[]
) {
  return {
    details: { order_book_details: details },
    funding: { funding_rates: fundingRates },
  };
}

function setupMockFetch(opts: {
  pac?: { symbol: string; funding: number; mark: number }[];
  hl?: { assets: { name: string }[]; ctxs: { funding: number; markPx: number }[] };
  lt?: {
    details: { market_id: number; symbol: string; last_trade_price: number }[];
    funding: { market_id: number; symbol?: string; rate: number }[];
  };
  pacError?: boolean;
  hlError?: boolean;
  ltError?: boolean;
}) {
  mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Pacifica
    if (urlStr.includes("pacifica.fi")) {
      if (opts.pacError) throw new Error("Pacifica API error");
      return {
        json: async () => makePacificaResponse(opts.pac ?? []),
      };
    }

    // Hyperliquid
    if (urlStr.includes("hyperliquid.xyz")) {
      if (opts.hlError) throw new Error("HL API error");
      const hl = opts.hl ?? { assets: [], ctxs: [] };
      return {
        json: async () => makeHyperliquidResponse(hl.assets, hl.ctxs),
      };
    }

    // Lighter - two endpoints
    if (urlStr.includes("zklighter") && urlStr.includes("orderBookDetails")) {
      if (opts.ltError) throw new Error("Lighter API error");
      const lt = opts.lt ?? { details: [], funding: [] };
      return {
        json: async () => ({ order_book_details: lt.details }),
      };
    }
    if (urlStr.includes("zklighter") && urlStr.includes("funding-rates")) {
      if (opts.ltError) throw new Error("Lighter API error");
      const lt = opts.lt ?? { details: [], funding: [] };
      return {
        json: async () => ({ funding_rates: lt.funding }),
      };
    }

    throw new Error(`Unexpected fetch: ${urlStr}`);
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ──────────────────────────────────────────────
// TOP_SYMBOLS
// ──────────────────────────────────────────────

describe("TOP_SYMBOLS", () => {
  it("includes major crypto assets", () => {
    expect(TOP_SYMBOLS).toContain("BTC");
    expect(TOP_SYMBOLS).toContain("ETH");
    expect(TOP_SYMBOLS).toContain("SOL");
  });

  it("has at least 10 symbols", () => {
    expect(TOP_SYMBOLS.length).toBeGreaterThanOrEqual(10);
  });
});

// ──────────────────────────────────────────────
// fetchAllFundingRates
// ──────────────────────────────────────────────

describe("fetchAllFundingRates", () => {
  it("fetches from all 3 exchanges in parallel and compares", async () => {
    setupMockFetch({
      pac: [
        { symbol: "BTC", funding: 0.0008, mark: 60000 },
        { symbol: "ETH", funding: 0.0004, mark: 3000 },
      ],
      hl: {
        assets: [{ name: "BTC" }, { name: "ETH" }],
        ctxs: [
          { funding: 0.0002, markPx: 60100 },
          { funding: 0.0001, markPx: 3010 },
        ],
      },
      lt: {
        details: [
          { market_id: 1, symbol: "BTC", last_trade_price: 59900 },
          { market_id: 2, symbol: "ETH", last_trade_price: 2990 },
        ],
        funding: [
          { market_id: 1, rate: 0.0005 },
          { market_id: 2, rate: 0.0002 },
        ],
      },
    });

    const snapshot = await fetchAllFundingRates();

    expect(snapshot.timestamp).toBeTruthy();
    expect(snapshot.exchangeStatus.pacifica).toBe("ok");
    expect(snapshot.exchangeStatus.hyperliquid).toBe("ok");
    expect(snapshot.exchangeStatus.lighter).toBe("ok");
    expect(snapshot.symbols.length).toBe(2);

    // Should be sorted by spread descending
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    expect(btc).toBeTruthy();
    expect(btc!.rates.length).toBe(3);
    expect(btc!.maxSpreadAnnual).toBeGreaterThan(0);
  });

  it("identifies correct long/short direction", async () => {
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.001, mark: 60000 }],
      hl: {
        assets: [{ name: "BTC" }],
        ctxs: [{ funding: 0.00005, markPx: 60100 }],
      },
    });

    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    expect(btc).toBeTruthy();
    // PAC funding is higher -> short PAC (get paid), long HL (pay less)
    // HL rate per hour = 0.00005, PAC rate per hour = 0.001/8 = 0.000125
    // HL hourly < PAC hourly -> long on HL, short on PAC
    expect(btc!.longExchange).toBe("hyperliquid");
    expect(btc!.shortExchange).toBe("pacifica");
  });

  it("filters by symbols when specified", async () => {
    setupMockFetch({
      pac: [
        { symbol: "BTC", funding: 0.0008, mark: 60000 },
        { symbol: "ETH", funding: 0.0004, mark: 3000 },
      ],
      hl: {
        assets: [{ name: "BTC" }, { name: "ETH" }],
        ctxs: [
          { funding: 0.0001, markPx: 60100 },
          { funding: 0.00005, markPx: 3010 },
        ],
      },
    });

    const snapshot = await fetchAllFundingRates({ symbols: ["BTC"] });
    expect(snapshot.symbols.length).toBe(1);
    expect(snapshot.symbols[0].symbol).toBe("BTC");
  });

  it("filters by minimum spread", async () => {
    setupMockFetch({
      pac: [
        { symbol: "BTC", funding: 0.001, mark: 60000 },   // high spread
        { symbol: "ETH", funding: 0.00011, mark: 3000 },   // tiny spread
      ],
      hl: {
        assets: [{ name: "BTC" }, { name: "ETH" }],
        ctxs: [
          { funding: 0.00005, markPx: 60100 },
          { funding: 0.0001, markPx: 3010 },
        ],
      },
    });

    const snapshot = await fetchAllFundingRates({ minSpread: 50 });
    // Only BTC should have a spread > 50%
    for (const s of snapshot.symbols) {
      expect(s.maxSpreadAnnual).toBeGreaterThanOrEqual(50);
    }
  });

  it("requires at least 2 exchanges for a symbol", async () => {
    setupMockFetch({
      pac: [{ symbol: "UNIQUE_PAC", funding: 0.001, mark: 100 }],
      hl: { assets: [], ctxs: [] },
    });

    const snapshot = await fetchAllFundingRates();
    // UNIQUE_PAC only on pacifica -> should be excluded
    const unique = snapshot.symbols.find(s => s.symbol === "UNIQUE_PAC");
    expect(unique).toBeUndefined();
  });

  it("handles exchange errors gracefully", async () => {
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.0008, mark: 60000 }],
      hlError: true,
      lt: {
        details: [{ market_id: 1, symbol: "BTC", last_trade_price: 59900 }],
        funding: [{ market_id: 1, rate: 0.0005 }],
      },
    });

    const snapshot = await fetchAllFundingRates();
    expect(snapshot.exchangeStatus.hyperliquid).toBe("error");
    expect(snapshot.exchangeStatus.pacifica).toBe("ok");
    expect(snapshot.exchangeStatus.lighter).toBe("ok");
    // BTC should still be available (2 exchanges: pac + lt)
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    expect(btc).toBeTruthy();
    expect(btc!.rates.length).toBe(2);
  });

  it("prefers HL mark price as most liquid", async () => {
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.0008, mark: 59000 }],
      hl: {
        assets: [{ name: "BTC" }],
        ctxs: [{ funding: 0.0001, markPx: 60000 }],
      },
      lt: {
        details: [{ market_id: 1, symbol: "BTC", last_trade_price: 59500 }],
        funding: [{ market_id: 1, rate: 0.0005 }],
      },
    });

    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    expect(btc!.bestMarkPrice).toBe(60000); // HL price preferred
  });

  it("estimates positive hourly income for favorable spreads", async () => {
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.002, mark: 60000 }],
      hl: {
        assets: [{ name: "BTC" }],
        ctxs: [{ funding: -0.0001, markPx: 60000 }],
      },
    });

    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    // Large positive spread -> positive estimated income
    expect(btc!.estHourlyIncomeUsd).toBeGreaterThan(0);
  });

  it("returns results sorted by spread descending", async () => {
    setupMockFetch({
      pac: [
        { symbol: "SMALL", funding: 0.0002, mark: 100 },
        { symbol: "BIG", funding: 0.003, mark: 200 },
      ],
      hl: {
        assets: [{ name: "SMALL" }, { name: "BIG" }],
        ctxs: [
          { funding: 0.0001, markPx: 100 },
          { funding: 0.00005, markPx: 200 },
        ],
      },
    });

    const snapshot = await fetchAllFundingRates();
    if (snapshot.symbols.length >= 2) {
      expect(snapshot.symbols[0].maxSpreadAnnual).toBeGreaterThanOrEqual(
        snapshot.symbols[1].maxSpreadAnnual,
      );
    }
  });
});

// ──────────────────────────────────────────────
// fetchSymbolFundingRates
// ──────────────────────────────────────────────

describe("fetchSymbolFundingRates", () => {
  it("returns comparison for a single symbol", async () => {
    setupMockFetch({
      pac: [{ symbol: "ETH", funding: 0.0004, mark: 3000 }],
      hl: {
        assets: [{ name: "ETH" }, { name: "BTC" }],
        ctxs: [
          { funding: 0.0001, markPx: 3010 },
          { funding: 0.0002, markPx: 60000 },
        ],
      },
    });

    const result = await fetchSymbolFundingRates("ETH");
    expect(result).toBeTruthy();
    expect(result!.symbol).toBe("ETH");
    expect(result!.rates.length).toBe(2);
  });

  it("returns null when symbol not found on 2+ exchanges", async () => {
    setupMockFetch({
      pac: [],
      hl: {
        assets: [{ name: "NOEXIST" }],
        ctxs: [{ funding: 0.0001, markPx: 100 }],
      },
    });

    const result = await fetchSymbolFundingRates("NOEXIST");
    expect(result).toBeNull();
  });

  it("is case-insensitive", async () => {
    setupMockFetch({
      pac: [{ symbol: "SOL", funding: 0.0005, mark: 150 }],
      hl: {
        assets: [{ name: "SOL" }],
        ctxs: [{ funding: 0.0001, markPx: 151 }],
      },
    });

    const result = await fetchSymbolFundingRates("sol");
    expect(result).toBeTruthy();
    expect(result!.symbol).toBe("SOL");
  });
});

// ──────────────────────────────────────────────
// 3-DEX direction logic
// ──────────────────────────────────────────────

describe("3-DEX direction logic", () => {
  it("picks correct long/short when lighter has best rate", async () => {
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.0006, mark: 60000 }],  // mid
      hl: {
        assets: [{ name: "BTC" }],
        ctxs: [{ funding: 0.0002, markPx: 60100 }],  // highest (HL is hourly, so 0.0002/hr > others/8h)
      },
      lt: {
        details: [{ market_id: 1, symbol: "BTC", last_trade_price: 59900 }],
        funding: [{ market_id: 1, rate: 0.0001 }],  // lowest (0.0001/8h)
      },
    });

    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    expect(btc).toBeTruthy();
    // Lighter has lowest hourly rate -> long on lighter
    // HL has highest hourly rate -> short on HL
    expect(btc!.longExchange).toBe("lighter");
    expect(btc!.shortExchange).toBe("hyperliquid");
  });

  it("picks pacifica as short when it has highest rate", async () => {
    setupMockFetch({
      pac: [{ symbol: "ETH", funding: 0.005, mark: 3000 }],  // highest (0.005/8h = 0.000625/hr)
      hl: {
        assets: [{ name: "ETH" }],
        ctxs: [{ funding: 0.0001, markPx: 3010 }],  // 0.0001/hr
      },
      lt: {
        details: [{ market_id: 2, symbol: "ETH", last_trade_price: 2990 }],
        funding: [{ market_id: 2, rate: 0.0002 }],  // 0.0002/8h = 0.000025/hr (lowest)
      },
    });

    const snapshot = await fetchAllFundingRates();
    const eth = snapshot.symbols.find(s => s.symbol === "ETH");
    expect(eth).toBeTruthy();
    expect(eth!.shortExchange).toBe("pacifica");
    expect(eth!.longExchange).toBe("lighter");
  });
});
