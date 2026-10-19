/**
 * QFEX public data from REAL captured payloads (public GET /refdata, /md/contracts and one MDS
 * market_stats frame, 2026-10-04; trimmed to a few symbols): markets, symbols, canonical
 * mapping, non-USD refusal, sessions, funding rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import "../../exchanges/venues/index.js";
import { getVenue } from "../../exchanges/venue.js";
import { QFEX_ENDPOINTS, qfexVenue } from "../../exchanges/venues/qfex.js";
import {
  buildQfexFundingRates, buildQfexMarkets, qfexPlainSymbol, qfexTradable, qfexUnderlyingOpen, qfexVenueSymbol, toQfexInstrument,
  type QfexContractRow, type QfexInstrument,
} from "../../exchanges/qfex/public.js";
import { parseMarketStats } from "../../exchanges/qfex/ws-transport.js";
import { toLegacyMarketInfo } from "../../exchanges/venue-types.js";
import { PerpError } from "../../errors.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/qfex/${name}`, import.meta.url), "utf8"));
const refdata = fixture("refdata.json") as { data: unknown[] };
const contracts = fixture("contracts.json") as { data: QfexContractRow[] };
const snap = parseMarketStats(fixture("mds-market-stats.json") as Record<string, unknown>);
const instruments: QfexInstrument[] = refdata.data.map(toQfexInstrument);
const bySymbol = (s: string): QfexInstrument => instruments.find(i => i.venueSymbol === s) as QfexInstrument;
const NOW = Date.UTC(2026, 9, 4, 14, 50, 0); // just after the capture

describe("venue definition", () => {
  it("is registered as qfex (alias qf) with the documented hosts for both networks", () => {
    const def = getVenue("qf");
    expect(def).toBe(qfexVenue);
    expect(def.family).toBe("qfex");
    expect(def.masterKeyKind).toBe("none");
    expect(def.agentKeyKind).toBe("hmac");
    expect(def.secretStorage).toEqual({ kind: "perp-keystore", dir: "qfex-agents" });
    expect(QFEX_ENDPOINTS.mainnet).toEqual({ rest: "https://api.qfex.com", tradeWs: "wss://trade.qfex.com", mdsWs: "wss://mds.qfex.com", banker: "https://banker.qfex.com" });
    expect(QFEX_ENDPOINTS.testnet).toEqual({ rest: "https://api.qfex.io", tradeWs: "wss://trade.qfex.io", mdsWs: "wss://mds.qfex.io", banker: "https://banker.qfex.io" });
    expect(def.networks.testnet?.restUrl).toBe("https://api.qfex.io");
    expect(def.spot).toBeNull();
  });

  it("declares the capabilities: funding unverified, tpsl separateOrders, native amend (Q5 passed), generated client ids", () => {
    expect(qfexVenue.fundingVerified).toBe(false);
    const caps = qfexVenue.capabilities!;
    expect(caps.tpsl).toBe("separateOrders");
    expect(caps.amend).toBe("native");
    expect(caps.orderAck).toBe("async");
    expect(caps.clientOrderId).toBe(true);
    expect(caps.timeInForce).toEqual(["GTC", "IOC", "FOK", "ALO"]);
    expect(caps.marginModes).toEqual(["cross"]);
    expect(caps.withdrawAssets).toBeNull(); // API withdrawals off (QFEX_WITHDRAW_ENABLED)
  });

  it("rate limit takes a quarter of the venue budget with the documented weights", () => {
    expect(qfexVenue.rateLimit.refillPerSec).toBe(50);
    expect(qfexVenue.rateLimit.weights).toMatchObject({ add_order: 1, get_user_orders: 5, cancel_all_orders: 2, get_order: 2, subscribe: 0.1 });
    expect(qfexVenue.rateLimit.weights).not.toHaveProperty("cancel_on_disconnect");
  });
});

describe("symbols", () => {
  it("USD markets drop the suffix; other quotes keep it", () => {
    expect(qfexPlainSymbol("AAPL-USD")).toBe("AAPL");
    expect(qfexPlainSymbol("SKHYNIX-KRW")).toBe("SKHYNIX-KRW");
    expect(qfexVenueSymbol("aapl")).toBe("AAPL-USD");
    expect(qfexVenueSymbol("AAPL-USD")).toBe("AAPL-USD");
    expect(qfexVenueSymbol("skhynix-krw")).toBe("SKHYNIX-KRW");
    expect(qfexVenueSymbol("AAPL-PERP")).toBe("AAPL-USD");
    expect(() => qfexVenueSymbol(" ")).toThrow(PerpError);
  });
});

describe("instruments from /refdata alone (order-entry precision)", () => {
  it("AAPL: tick, lot, min/max quantity, band, leverage, allowed order types and TIFs", () => {
    const i = bySymbol("AAPL-USD");
    expect(i).toMatchObject({
      symbol: "AAPL", status: "ACTIVE", assetClass: "equity", tickSize: "0.01", lotSize: "0.001", minQuantity: "0.01",
      maxQuantity: "10000000", maxLeverage: 10, quoteAsset: "USD", marginAsset: "USDC",
      orderTypes: ["LIMIT", "MARKET", "ALO"], timeInForce: ["GTC", "IOC", "FOK"],
    });
    expect(i.band).toEqual({ lower: "316.73283923", upper: "350.07313809" });
  });

  it("classifies commodities, indices and pre-IPO", () => {
    expect(bySymbol("CL-USD").assetClass).toBe("commodity");
    expect(bySymbol("US100-USD").assetClass).toBe("index");
    expect(bySymbol("OPENAI-USD").assetClass).toBe("preIpo");
    expect(bySymbol("ANTHROPIC-USD").assetClass).toBe("preIpo");
  });

  it("an unknown product category is an error, not a guess", () => {
    const raw = { ...(refdata.data[0] as object), product_category: "CRYPTO" };
    expect(() => toQfexInstrument(raw)).toThrow(/cannot classify/);
  });

  it("non-USD quotes and non-ACTIVE instruments are not tradable", () => {
    expect(qfexTradable(bySymbol("AAPL-USD"))).toBe(true);
    expect(bySymbol("SKHYNIX-KRW").quoteAsset).toBe("KRW");
    expect(qfexTradable(bySymbol("SKHYNIX-KRW"))).toBe(false);
    const inactive = instruments.find(i => i.status !== "ACTIVE") as QfexInstrument;
    expect(qfexTradable(inactive)).toBe(false);
  });
});

describe("markets (refdata + MDS snapshot; no /md/contracts)", () => {
  const { markets, activeWithoutMark } = buildQfexMarkets(instruments, snap, NOW);
  const market = (s: string) => markets.find(m => m.venueSymbol === s)!;

  it("AAPL maps to a VenueMarket with the mark from MDS and funding left null (unverified)", () => {
    const m = market("AAPL-USD");
    expect(m).toMatchObject({
      venue: "qfex", symbol: "AAPL", canonical: "AAPL", assetClass: "equity", settle: "USDC", quoteAsset: "USD",
      tickSize: "0.01", stepSize: "0.001", minSize: "0.01", minNotional: null, maxLeverage: 10, marginTiers: null,
      fundingRate: null, indexPrice: null, tradable: true, fundingRateBasis: { kind: "perHours", hours: 1 }, settlementIntervalHours: 1,
    });
    expect(m.markPrice).toBe(snap.marks.get("AAPL-USD")!.price);
    expect(toLegacyMarketInfo(m)).toMatchObject({ symbol: "AAPL", fundingRate: null, sizeDecimals: 3, maxLeverage: 10 });
  });

  it("explicit canonical mapping only: GOLD, CL, US100 map; NATGAS and pre-IPO do not", () => {
    expect(market("GOLD-USD").canonical).toBe("GOLD");
    expect(market("CL-USD").canonical).toBe("CRUDE_OIL_WTI");
    expect(market("US100-USD").canonical).toBe("NDX");
    expect(markets.find(m => m.venueSymbol === "OPENAI-USD")?.canonical ?? null).toBeNull();
  });

  it("a non-USD market is listed with its quote asset, no canonical symbol and tradable false", () => {
    const m = market("SKHYNIX-KRW");
    expect(m.symbol).toBe("SKHYNIX-KRW");
    expect(m.quoteAsset).toBe("KRW");
    expect(m.canonical).toBeNull();
    expect(m.tradable).toBe(false);
  });

  it("a market without a mark is left out (never priced from something else); active ones are reported", () => {
    const empty = buildQfexMarkets(instruments, { marks: new Map(), openInterest: new Map(), volumeNotional: new Map() }, NOW);
    expect(empty.markets).toEqual([]);
    expect(empty.activeWithoutMark).toContain("AAPL-USD");
    expect(empty.activeWithoutMark).not.toContain(instruments.find(i => i.status !== "ACTIVE")!.venueSymbol);
    expect(activeWithoutMark.every(s => !snap.marks.has(s))).toBe(true);
  });

  it("the session carries the refdata price band", () => {
    const m = market("AAPL-USD");
    expect(m.session?.priceBand).toEqual({ lower: "316.73283923", upper: "350.07313809" });
    expect(m.session?.marginMultiplier).toBeNull();
  });
});

describe("market hours → underlyingOpen (tz-aware; regular session only)", () => {
  const hours = bySymbol("AAPL-USD").marketHours;
  it("is open on a weekday inside the regular session, closed pre-market and at the weekend", () => {
    expect(qfexUnderlyingOpen(hours, Date.UTC(2026, 9, 5, 14, 0, 0))).toBe(true);   // Mon 10:00 New York
    expect(qfexUnderlyingOpen(hours, Date.UTC(2026, 9, 5, 12, 0, 0))).toBe(false);  // Mon 08:00 (pre-market)
    expect(qfexUnderlyingOpen(hours, Date.UTC(2026, 9, 4, 15, 0, 0))).toBe(false);  // Sunday
  });
  it("no schedule / no tz → null (unknown), never a guess", () => {
    expect(qfexUnderlyingOpen(null, NOW)).toBeNull();
    expect(qfexUnderlyingOpen({ monday: [] }, NOW)).toBeNull();
    expect(qfexUnderlyingOpen({ tz: "Not/AZone" }, NOW)).toBeNull();
  });
});

describe("funding rows (explicit, flagged reads only)", () => {
  it("carry the raw funding_rate with the hourly basis; a past next-funding timestamp is null", () => {
    const { rates, unlisted } = buildQfexFundingRates(instruments, contracts.data, snap.marks, NOW);
    expect(unlisted).toEqual([]);
    const aapl = rates.find(r => r.venueSymbol === "AAPL-USD")!;
    // Captured Sun 2026-10-04 10:50 ET (weekend session): the venue's "0" is no funding → null + marketClosed.
    expect(aapl).toMatchObject({ venue: "qfex", symbol: "AAPL", canonical: "AAPL", rate: null, marketClosed: true, basis: { kind: "perHours", hours: 1 } });
    expect(aapl.markPrice).toBe(snap.marks.get("AAPL-USD")!.price);
    expect(aapl.nextFundingTime).toBe(1791126000 * 1000);
    const cl = rates.find(r => r.venueSymbol === "CL-USD")!;
    expect(cl.nextFundingTime).toBeNull(); // 1791014356 is before the capture time
    expect(rates.find(r => r.venueSymbol === "OPENAI-USD")!.rate).toBe("-0.00000004");
    expect(rates.find(r => r.venueSymbol === "SKHYNIX-KRW")!.canonical).toBeNull();
  });

  it("a contract missing from /refdata is reported, not classified by guess; a missing funding_rate is an error", () => {
    const extra = [...contracts.data, { ticker_id: "NEW-USD", funding_rate: "0", next_funding_rate: "0", next_funding_rate_timestamp: 1 }];
    expect(buildQfexFundingRates(instruments, extra, snap.marks, NOW).unlisted).toEqual(["NEW-USD"]);
    const bad = [{ ...contracts.data.find(c => c.ticker_id === "AAPL-USD")!, funding_rate: "" }];
    expect(() => buildQfexFundingRates(instruments, bad, snap.marks, NOW)).toThrow(/no funding_rate/);
  });

  it("a row without a mark keeps markPrice null (index / last are never substituted)", () => {
    const { rates } = buildQfexFundingRates(instruments, contracts.data, new Map(), NOW);
    expect(rates.every(r => r.markPrice === null)).toBe(true);
  });
});
