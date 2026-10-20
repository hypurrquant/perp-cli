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

// Lighter's settled rate is the WS market_stats snapshot: served from the mocked lt.funding rows
// (rate = a fraction per 1 h → percent on the wire), never a real socket.
const wsState = vi.hoisted(() => ({ stats: {} as Record<string, { funding_rate: string; current_funding_rate: string }> }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWs extends EventEmitter {
    constructor() { super(); setTimeout(() => this.emit("open"), 0); }
    send() { setTimeout(() => this.emit("message", JSON.stringify({ type: "subscribed/market_stats", channel: "market_stats:all", market_stats: wsState.stats })), 0); }
    close() { /* closed */ }
  }
  return { default: FakeWs, WebSocket: FakeWs };
});

// Import after mocking fetch
const { fetchAllFundingRates, fetchSymbolFundingRates, TOP_SYMBOLS } = await import("../funding-rates.js");
const { invalidateCache } = await import("../cache.js");
const { clearLighterFundingStatsCache } = await import("../exchanges/lighter-public.js");

// ── Helpers to build mock API responses ──
//
// Funding rates now fan out over every "marketData" venue's publicData:
//  - Pacifica: GET /info (markets, instrument_type required) + GET /info/prices (mark,
//    next_funding = the quoted funding rate);
//  - Hyperliquid: POST /info metaAndAssetCtxs;
//  - Lighter: /api/v1/orderBookDetails (perp details incl. mark_price) + /api/v1/funding-rates
//    (own rows need market_id + symbol + rate; mark comes from the details by market_id).
// Venues the test does not configure (aster, lighter-rh, ondo, arcus) fail their fetch and are
// reported as exchangeStatus "error" — never silently empty.

function json(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

function pacificaInfo(rates: { symbol: string }[]) {
  return { success: true, data: rates.map(r => ({ symbol: r.symbol, instrument_type: "perpetual", max_leverage: 20, tick_size: "0.01", lot_size: "0.001", min_order_size: "10" })) };
}

function pacificaPrices(rates: { symbol: string; funding: number; mark: number; next_funding?: number }[]) {
  return { success: true, data: rates.map(r => ({ symbol: r.symbol, mark: String(r.mark), oracle: String(r.mark), funding: String(r.funding), next_funding: String(r.next_funding ?? r.funding), open_interest: "1000", volume_24h: "100000" })) };
}

function makeHyperliquidResponse(
  assets: { name: string }[],
  ctxs: { funding: number; markPx: number }[]
) {
  return [
    { universe: assets.map(a => ({ szDecimals: 3, maxLeverage: 20, ...a })) },
    ctxs.map(c => ({ funding: String(c.funding), markPx: String(c.markPx), oraclePx: String(c.markPx), openInterest: "1000", dayNtlVlm: "100000" })),
  ];
}

function lighterDetails(details: { market_id: number; symbol: string; last_trade_price: number }[]) {
  return {
    order_book_details: details.map(d => ({
      symbol: d.symbol, market_id: d.market_id, market_type: "perp", status: "active",
      price_decimals: 2, size_decimals: 4, min_base_amount: "0.001", min_quote_amount: "10",
      min_initial_margin_fraction: 500, mark_price: String(d.last_trade_price),
    })),
  };
}

function lighterFunding(
  details: { market_id: number; symbol: string }[],
  fundingRates: { market_id: number; symbol?: string; rate: number; exchange?: string }[],
) {
  const symbolOf = (id: number) => details.find(d => d.market_id === id)?.symbol;
  return { funding_rates: fundingRates.map(fr => ({ exchange: "lighter", symbol: fr.symbol ?? symbolOf(fr.market_id), ...fr })) };
}

function setupMockFetch(opts: {
  pac?: { symbol: string; funding: number; mark: number; next_funding?: number }[];
  hl?: { assets: { name: string }[]; ctxs: { funding: number; markPx: number }[] };
  lt?: {
    details: { market_id: number; symbol: string; last_trade_price: number }[];
    funding: { market_id: number; symbol?: string; rate: number; exchange?: string }[];
  };
  pacError?: boolean;
  hlError?: boolean;
  ltError?: boolean;
}) {
  wsState.stats = Object.fromEntries((opts.lt?.funding ?? []).map(f => [String(f.market_id), { funding_rate: String(f.rate * 100), current_funding_rate: String(f.rate * 100) }]));
  mockFetch.mockImplementation(async (url: string | URL) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Pacifica: /info (markets) and /info/prices (mark + funding)
    if (urlStr.includes("pacifica.fi")) {
      if (opts.pacError) throw new Error("Pacifica API error");
      return json(urlStr.includes("/info/prices") ? pacificaPrices(opts.pac ?? []) : pacificaInfo(opts.pac ?? []));
    }

    // Hyperliquid
    if (urlStr.includes("hyperliquid.xyz")) {
      if (opts.hlError) throw new Error("HL API error");
      const hl = opts.hl ?? { assets: [], ctxs: [] };
      return json(makeHyperliquidResponse(hl.assets, hl.ctxs));
    }

    // Lighter - two endpoints
    if (urlStr.includes("zklighter") && urlStr.includes("orderBookDetails")) {
      if (opts.ltError) throw new Error("Lighter API error");
      return json(lighterDetails((opts.lt ?? { details: [] }).details));
    }
    if (urlStr.includes("zklighter") && urlStr.includes("funding-rates")) {
      if (opts.ltError) throw new Error("Lighter API error");
      const lt = opts.lt ?? { details: [], funding: [] };
      return json(lighterFunding(lt.details, lt.funding));
    }

    // aster / lighter-rh / ondo / arcus are not part of these scenarios.
    throw new Error(`Unexpected fetch: ${urlStr}`);
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  invalidateCache();
  clearLighterFundingStatsCache();
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
    // HL rate per hour = 0.00005, PAC rate per hour = 0.001
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
      expect(snapshot.symbols[0].maxSpreadAnnual!).toBeGreaterThanOrEqual(
        snapshot.symbols[1].maxSpreadAnnual!,
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

// ──────────────────────────────────────────────
// Pacifica nextFundingTime semantic guard
// (regression: pacifica's next_funding API field is the next-period funding
//  RATE — not a unix-ms timestamp. Mapping it into the schema's
//  nextFundingTime field polluted cross-DEX comparisons.)
// ──────────────────────────────────────────────

describe("Pacifica nextFundingTime guard", () => {
  it("nextFundingTime is the next top of the hour (docs: hourly settlement), never the API's next_funding rate", async () => {
    // Pacifica's API exposes next_funding as a small decimal (rate). Mock it
    // here as a value that would clearly be invalid as a unix-ms timestamp
    // (negative + sub-millisecond).
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.0001, mark: 60000, next_funding: -0.00014299 }],
      hl: { assets: [{ name: "BTC" }], ctxs: [{ funding: 0.00005, markPx: 60100 }] },
    });

    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    expect(btc).toBeTruthy();
    const pacEntry = btc!.rates.find(r => r.exchange === "pacifica");
    expect(pacEntry).toBeTruthy();
    // The API's next_funding (a rate) MUST NOT leak into nextFundingTime. The time is not published;
    // Pacifica documents settlement at the end of each 1 h interval (on the hour) — the next one.
    const hour = 3_600_000;
    expect(pacEntry!.nextFundingTime! % hour).toBe(0);
    expect(pacEntry!.nextFundingTime! - Date.now()).toBeGreaterThan(0);
    expect(pacEntry!.nextFundingTime! - Date.now()).toBeLessThanOrEqual(hour);
    const hlEntry = btc!.rates.find(r => r.exchange === "hyperliquid")!;
    expect(hlEntry.nextFundingTime).toBe(pacEntry!.nextFundingTime);
    // The compared rate is the last settled `funding` (legacy-public.ts pacificaRows), not the
    // predicted next_funding; the row says so.
    expect(pacEntry!.fundingRate).toBe(0.0001);
    expect(pacEntry!.rateKind).toBe("lastSettled");
  });
});

describe("Pacifica row-skip on non-finite venue payload (Phase 4, qa/2026-05-16)", () => {
  // src/api/public/pacifica.ts:25-35 already guards against NaN/Infinity
  // funding/mark and silently skips the row (no throw — partial-result UX
  // for funding aggregation, by design). Pin the contract so a future
  // "fix" that promotes the silent skip to an error doesn't accidentally
  // crash multi-DEX scans.

  it("drops a Pacifica row where funding is NaN, keeps clean rows", async () => {
    invalidateCache();
    setupMockFetch({
      pac: [
        { symbol: "BTC", funding: 0.0001, mark: 60000 },
        // Corrupted: non-numeric funding → must be filtered out by
        // src/api/public/pacifica.ts:30 (Number.isFinite guard).
        { symbol: "ETH", funding: "garbage" as unknown as number, mark: 3000 },
      ],
      hl: {
        assets: [{ name: "BTC" }, { name: "ETH" }],
        ctxs: [
          { funding: 0.00005, markPx: 60100 },
          { funding: 0.00003, markPx: 3001 },
        ],
      },
      lt: { details: [], funding: [] },
    });

    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    const eth = snapshot.symbols.find(s => s.symbol === "ETH");
    expect(btc?.rates.find(r => r.exchange === "pacifica")).toBeTruthy();
    // ETH had a corrupt funding → pacifica row dropped. ETH presence in the
    // snapshot depends on whether at least one exchange returned a valid row;
    // primary assertion is that pacifica is NOT in the ETH rate list.
    expect(eth?.rates.find(r => r.exchange === "pacifica")).toBeUndefined();
  });

  it("drops a Pacifica row where mark is non-finite or <= 0", async () => {
    invalidateCache();
    setupMockFetch({
      pac: [
        { symbol: "BTC", funding: 0.0001, mark: 60000 },
        // mark <= 0 → must be skipped (a $0 mark would corrupt arb sizing).
        { symbol: "ETH", funding: 0.0001, mark: 0 },
        // mark = NaN string → also skipped (Number(NaN-string)=NaN, not finite).
        { symbol: "SOL", funding: 0.0001, mark: "NaN" as unknown as number },
      ],
      hl: {
        assets: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }],
        ctxs: [
          { funding: 0.00005, markPx: 60100 },
          { funding: 0.00005, markPx: 3001 },
          { funding: 0.00005, markPx: 150 },
        ],
      },
      lt: { details: [], funding: [] },
    });
    const snapshot = await fetchAllFundingRates();
    const eth = snapshot.symbols.find(s => s.symbol === "ETH");
    const sol = snapshot.symbols.find(s => s.symbol === "SOL");
    expect(eth?.rates.find(r => r.exchange === "pacifica")).toBeUndefined();
    expect(sol?.rates.find(r => r.exchange === "pacifica")).toBeUndefined();
  });
});

describe("3-DEX direction logic", () => {
  it("picks correct long/short when lighter has best rate", async () => {
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.00006, mark: 60000 }],  // hourly = 0.00006
      hl: {
        assets: [{ name: "BTC" }],
        ctxs: [{ funding: 0.0002, markPx: 60100 }],  // hourly = 0.0002 (highest)
      },
      lt: {
        details: [{ market_id: 1, symbol: "BTC", last_trade_price: 59900 }],
        funding: [{ market_id: 1, rate: 0.00001 }],  // 8h rate, hourly = 0.00001/8 (lowest)
      },
    });

    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC");
    expect(btc).toBeTruthy();
    // Lighter has lowest hourly rate (0.00001/8) -> long on lighter
    // HL has highest hourly rate (0.0002) -> short on HL
    expect(btc!.longExchange).toBe("lighter");
    expect(btc!.shortExchange).toBe("hyperliquid");
  });

  it("picks pacifica as short when it has highest rate", async () => {
    setupMockFetch({
      pac: [{ symbol: "ETH", funding: 0.0005, mark: 3000 }],  // hourly = 0.0005 (highest)
      hl: {
        assets: [{ name: "ETH" }],
        ctxs: [{ funding: 0.0001, markPx: 3010 }],  // hourly = 0.0001 (mid)
      },
      lt: {
        details: [{ market_id: 2, symbol: "ETH", last_trade_price: 2990 }],
        funding: [{ market_id: 2, rate: 0.000025 }],  // 8h rate, hourly = 0.000025/8 (lowest)
      },
    });

    const snapshot = await fetchAllFundingRates();
    const eth = snapshot.symbols.find(s => s.symbol === "ETH");
    expect(eth).toBeTruthy();
    expect(eth!.shortExchange).toBe("pacifica");
    expect(eth!.longExchange).toBe("lighter");
  });
});

// ──────────────────────────────────────────────
// arb scan --compare: the argument is looked up by its canonical key (0.15.1 F9)
// ──────────────────────────────────────────────

describe("fetchSymbolFundingRates canonicalizes the argument", () => {
  // Hyperliquid side: metaAndAssetCtxs recorded live 2026-10-19 (kPEPE / BTC rows).
  const recordedHl = async () => (await import("./fixtures/hyperliquid/read-path-2026-10-19.json")).default.metaAndAssetCtxs;

  function setupRecordedHl(hlBody: unknown, pac: { symbol: string; funding: number; mark: number }[]) {
    setupMockFetch({ pac });
    const pacOnly = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string | URL) => (String(url).includes("hyperliquid.xyz") ? json(hlBody) : pacOnly(url)));
  }

  it.each(["kPEPE", "KPEPE", "1000PEPE", "kpepe-perp"])("--compare %s finds HL kPEPE ≡ Pacifica 1000PEPE", async (arg) => {
    const hl = await recordedHl();
    const pepeMark = Number((hl[1] as Array<{ markPx: string }>)[3].markPx);
    setupRecordedHl(hl, [{ symbol: "1000PEPE", funding: 0.0001, mark: pepeMark }]);
    const result = await fetchSymbolFundingRates(arg);
    expect(result).toBeTruthy();
    expect(result!.symbol).toBe("1000PEPE");
    expect(result!.rates.map(r => r.exchange).sort()).toEqual(["hyperliquid", "pacifica"]);
  });

  it("--compare UBTC (HL spot wrapper alias) compares BTC", async () => {
    const hl = await recordedHl();
    const btcMark = Number((hl[1] as Array<{ markPx: string }>)[0].markPx);
    setupRecordedHl(hl, [{ symbol: "BTC", funding: 0.0001, mark: btcMark }]);
    const result = await fetchSymbolFundingRates("UBTC");
    expect(result!.symbol).toBe("BTC");
  });
});

describe("SymbolFundingComparison.mixedKinds (the perp-ws comparator flag)", () => {
  it("Pacifica lastSettled vs Hyperliquid accruing → mixedKinds true; each rate names its kind", async () => {
    setupMockFetch({
      pac: [{ symbol: "BTC", funding: 0.0001, mark: 60000 }],
      hl: { assets: [{ name: "BTC" }], ctxs: [{ funding: 0.00005, markPx: 60010 }] },
    });
    const snapshot = await fetchAllFundingRates();
    const btc = snapshot.symbols.find(s => s.symbol === "BTC")!;
    expect(btc.rates.map(r => [r.exchange, r.rateKind]).sort()).toEqual([["hyperliquid", "accruing"], ["pacifica", "lastSettled"]]);
    expect(btc.mixedKinds).toBe(true);
  });
});
