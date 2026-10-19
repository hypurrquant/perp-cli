/** Test helpers for perp-cli/ws: fake transport, fake fetch, fixture loading, fixture directories. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FetchLike, WsFactory, WsLike } from "../../ws/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures/ws");

export function fixtureFrames(venue: string, name: string): unknown[] {
  return (JSON.parse(readFileSync(resolve(FIXTURES, venue, `${name}.json`), "utf8")) as { frames: unknown[] }).frames;
}

export class FakeWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closedWith = { code, reason }; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  message(frame: unknown): void { this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) }); }
  serverClose(code = 1006, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason, wasClean: false }); }
  sentJson(): unknown[] { return this.sent.map(s => JSON.parse(s) as unknown); }
}

export function fakeTransport(): { factory: WsFactory; sockets: FakeWs[]; last(): FakeWs } {
  const sockets: FakeWs[] = [];
  return {
    factory: (url: string) => { const ws = new FakeWs(url); sockets.push(ws); return ws; },
    sockets,
    last: () => sockets[sockets.length - 1],
  };
}

/** Routes: "GET <url>" or "POST <url> <body.type>[:<body.dex>]" → JSON. */
export function fakeFetch(routes: Record<string, unknown>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init?: { method?: string; body?: string }) => {
    let key = `${init?.method ?? "GET"} ${url}`;
    if (init?.body !== undefined) {
      const b = JSON.parse(init.body) as { type?: string; dex?: string };
      key += ` ${b.type}${b.dex !== undefined ? `:${b.dex}` : ""}`;
    }
    calls.push(key);
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

/** Directories matching the trimmed Phase 0 fixtures. */
export const HL_ROUTES = {
  "POST https://api.hyperliquid.xyz/info perpDexs": [null, { name: "xyz" }, { name: "abcd" }],
  "POST https://api.hyperliquid.xyz/info spotMeta": { tokens: [{ index: 0, name: "USDC" }] },
  "POST https://api.hyperliquid.xyz/info meta": {
    collateralToken: 0,
    universe: [{ name: "BTC" }, { name: "ETH" }, { name: "ATOM" }, { name: "MATIC", isDelisted: true }, { name: "DYDX" }, { name: "SOL" }],
  },
  "POST https://api.hyperliquid.xyz/info meta:xyz": {
    collateralToken: 0,
    universe: ["XYZ100", "TSLA", "NVDA", "GOLD", "HOOD", "INTC"].map(n => ({ name: `xyz:${n}` })),
  },
  "POST https://api.hyperliquid.xyz/info meta:abcd": { collateralToken: 0, universe: [{ name: "abcd:USA500" }] },
};

export const PACIFICA_ROUTES = {
  // Live /info rows carry instrument_type; SOL-USDC is a spot row (also in `prices`), not a perp.
  "GET https://api.pacifica.fi/api/v1/info": {
    success: true,
    data: [
      ...["BTC", "ETH", "FARTCOIN", "TSLA"].map(symbol => ({ symbol, instrument_type: "perpetual", base_asset: symbol })),
      { symbol: "SOL-USDC", instrument_type: "spot", base_asset: "SOL" },
    ],
  },
};

export const LIGHTER_ROUTES = {
  "GET https://mainnet.zklighter.elliot.ai/api/v1/orderBooks": {
    code: 200,
    order_books: [
      { symbol: "ETH", market_id: 0, market_type: "perp" },
      { symbol: "BTC", market_id: 1, market_type: "perp" },
      { symbol: "NATGAS", market_id: 158, market_type: "perp" },
      { symbol: "ETH/USDC", market_id: 2048, market_type: "spot" },
    ],
  },
};

export const LIGHTER_RH_ROUTES = {
  "GET https://api.rh.lighter.xyz/api/v1/orderBooks": {
    code: 200,
    order_books: [
      { symbol: "ETH", market_id: 0, market_type: "perp" },
      { symbol: "BTC", market_id: 1, market_type: "perp" },
      { symbol: "ZEC", market_id: 4, market_type: "perp" },
    ],
  },
};

const asterSym = (symbol: string, baseAsset: string, quoteAsset: string) => ({ symbol, baseAsset, quoteAsset, contractType: "PERPETUAL", status: "TRADING" });
export const ASTER_ROUTES = {
  "GET https://fapi.asterdex.com/fapi/v3/exchangeInfo": {
    symbols: [
      asterSym("ASTERUSDT", "ASTER", "USDT"), asterSym("BTCUSDT", "BTC", "USDT"), asterSym("ETHUSDT", "ETH", "USDT"),
      asterSym("BTCUSD1", "BTC", "USD1"), asterSym("1000PEPEUSDT", "1000PEPE", "USDT"), asterSym("CLUSD1", "CL", "USD1"),
      asterSym("JPMUSDT", "JPM", "USDT"), asterSym("SOLUSDT", "SOL", "USDT"),
      // Live exchangeInfo rows (2026-10-19) that are not listed perps: SETTLING (being delisted) and
      // PENDING_TRADING with contractType "" — never in the directory.
      { symbol: "TONUSDT", baseAsset: "TON", quoteAsset: "USDT", contractType: "PERPETUAL", status: "SETTLING" },
      { symbol: "MBLUSDT", baseAsset: "MBL", quoteAsset: "USDT", contractType: "", status: "PENDING_TRADING" },
    ],
  },
  // PYTHUSDT is in premiumIndex/markPrice@arr but not exchangeInfo (unlisted → skipped by rule).
  "GET https://fapi.asterdex.com/fapi/v3/premiumIndex": [{ symbol: "BTCUSDT" }, { symbol: "PYTHUSDT" }],
  // ETHUSDT deliberately missing → interval null.
  "GET https://fapi.asterdex.com/fapi/v3/fundingInfo": [
    { symbol: "BTCUSDT", fundingIntervalHours: 8 }, { symbol: "BTCUSD1", fundingIntervalHours: 8 }, { symbol: "ASTERUSDT", fundingIntervalHours: 4 },
  ],
};

export const ARCUS_ROUTES = {
  "GET https://api.arcus.xyz/v1/markets": {
    markets: [
      { marketDisplayName: "BTC-USD", marketId: 1, baseAsset: "BTC", quoteAsset: "USD", status: "ONLINE" },
      { marketDisplayName: "ETH-USD", marketId: 2, baseAsset: "ETH", quoteAsset: "USD", status: "ONLINE" },
      { marketDisplayName: "MSFT-USD", marketId: 32, baseAsset: "MSFT", quoteAsset: "USD", status: "ONLINE" },
      // Live /v1/markets row of an OFFLINE market (2026-10-19): never in the directory.
      { marketDisplayName: "F-USD", marketId: 11, baseAsset: "F", quoteAsset: "USD", status: "OFFLINE" },
    ],
  },
};

/** Let pending promise chains (directory load → subscribe) settle. */
export async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
