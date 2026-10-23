/**
 * perp-cli/ws option validation (blind dogfood round 2): bad options throw INVALID_PARAMS up front
 * instead of raw TypeErrors / misleading retryable errors; unknown channels are INVALID_PARAMS (only
 * book/trades are CAPABILITY_UNSUPPORTED until 0.15.1); unknown symbols carry "did you mean" hints;
 * the auth error names the purpose once.
 */
import { describe, expect, it } from "vitest";
import { arcus, aster, createFundingComparator, createVenueStream, hyperliquid, lighter, lighterRh, pacifica } from "../../ws/index.js";
import type { VenueCodec, VenueStreamOptions } from "../../ws/index.js";
import { WsError } from "../../ws/errors.js";
import { ARCUS_ROUTES, ASTER_ROUTES, LIGHTER_ROUTES, PACIFICA_ROUTES, fakeFetch, fakeTransport } from "./helpers.js";

function syncError(fn: () => unknown): WsError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WsError);
    return e as WsError;
  }
  throw new Error("expected a synchronous throw");
}

function stream(codec: VenueCodec, routes: Record<string, unknown>, extra: VenueStreamOptions = {}) {
  const t = fakeTransport();
  return { t, s: createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null, ...extra }) };
}

describe("createFundingComparator options", () => {
  it("an unknown kind throws INVALID_PARAMS listing the allowed kinds (no later TypeError)", () => {
    const e = syncError(() => createFundingComparator({ streams: [], kind: "nxt" as never }));
    expect(e.structured).toMatchObject({ code: "INVALID_PARAMS" });
    expect(e.message).toContain("\"nxt\"");
    for (const k of ["current", "next", "predicted", "lastSettled", "accruing"]) expect(e.structured.remediation).toContain(`"${k}"`);
  });

  it.each([
    ["streams not an array", { streams: "x" }],
    ["streams with a non-stream", { streams: [{}] }],
    ["minVenues 0", { streams: [], minVenues: 0 }],
    ["minVenues 1.5", { streams: [], minVenues: 1.5 }],
    ["include not an array", { streams: [], include: "BTC" }],
    ["staleAfterMs negative", { streams: [], staleAfterMs: -1 }],
    ["canonicalize not a function", { streams: [], canonicalize: 1 }],
  ])("%s → INVALID_PARAMS", (_n, opts) => {
    expect(syncError(() => createFundingComparator(opts as never)).structured.code).toBe("INVALID_PARAMS");
  });

  it("valid options still construct", () => {
    const c = createFundingComparator({ streams: [], kind: "next", minVenues: 1, include: ["BTC"], staleAfterMs: 5000 });
    expect(c.rows()).toEqual([]);
    c.close();
  });
});

describe("createVenueStream arguments", () => {
  it("an unknown network throws INVALID_PARAMS (not a retryable EXCHANGE_UNREACHABLE later)", () => {
    const t = fakeTransport();
    const e = syncError(() => createVenueStream(hyperliquid, { network: "mainet" as never, transport: t.factory, fetch: fakeFetch({}) }));
    expect(e.structured).toMatchObject({ code: "INVALID_PARAMS", retryable: false });
    expect(e.message).toContain("\"mainet\"");
    expect(e.structured.remediation).toContain("\"mainnet\"");
    expect(e.structured.remediation).toContain("\"testnet\"");
    expect(t.sockets).toHaveLength(0);
  });

  it("a supported testnet still works; an unsupported one keeps CAPABILITY_UNSUPPORTED", async () => {
    expect(() => stream(hyperliquid, {}, { network: "testnet" })).not.toThrow();
    const { s } = stream(lighterRh, {}, { network: "testnet" });
    await expect(s.subscribe({ kind: "allMarkets" }).ready).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
  });

  it.each([
    ["undefined", undefined],
    ["a venue name", "hyperliquid"],
    ["an unknown venue object", { venue: "binance" }],
    ["a partial codec", { venue: "hyperliquid" }],
  ])("codec = %s → INVALID_PARAMS with the import remediation", (_n, codec) => {
    const e = syncError(() => createVenueStream(codec as never, { transport: fakeTransport().factory }));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(e.structured.remediation).toBe("Pass a codec export, e.g. import { hyperliquid } from '@hypurrquant/perp-ws' (or 'perp-cli/ws')");
  });
});

describe("market channels", () => {
  it.each([
    ["an unknown channel", ["ticker"]],
    ["an unknown channel next to a valid one", ["market", "ticker"]],
    ["empty channels", []],
  ])("%s → INVALID_PARAMS listing the valid channels (no 0.15.1 promise for it)", async (_n, channels) => {
    const { s, t } = stream(pacifica, PACIFICA_ROUTES);
    const err = await s.subscribe({ kind: "market", symbol: "BTC", channels: channels as never }).ready.then(() => null, (e: unknown) => e as WsError);
    expect(err?.structured.code).toBe("INVALID_PARAMS");
    for (const c of ["market", "bbo", "book", "trades"]) expect(err?.structured.remediation).toContain(`"${c}"`);
    if (channels.includes("ticker")) expect(err?.message).toContain("\"ticker\"");
    expect(t.sockets).toHaveLength(0);
  });

  it("book / trades are CAPABILITY_UNSUPPORTED (planned, no version promised)", async () => {
    const { s } = stream(pacifica, PACIFICA_ROUTES);
    const err = await s.subscribe({ kind: "market", symbol: "BTC", channels: ["trades"] }).ready.then(() => null, (e: unknown) => e as WsError);
    expect(err?.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(err?.structured.remediation).toContain("planned, not yet available");
  });
});

describe("unknown symbol hints", () => {
  it.each([
    ["arcus", arcus, ARCUS_ROUTES, "BTC", ["BTC-USD"]],
    ["aster", aster, ASTER_ROUTES, "BTC", ["BTCUSDT"]], // BTCUSD1 is canonical null (not a second BTC): no base hint
    ["aster (case)", aster, ASTER_ROUTES, "btcusdt", ["BTCUSDT"]],
    ["pacifica (case)", pacifica, PACIFICA_ROUTES, "btc", ["BTC"]],
  ] as const)("%s → a did-you-mean hint from the directory", async (_n, codec, routes, symbol, want) => {
    const { s } = stream(codec, routes);
    const err = await s.subscribe({ kind: "market", symbol, channels: ["market"] }).ready.then(() => null, (e: unknown) => e as WsError);
    expect(err?.structured.code).toBe("INVALID_PARAMS");
    expect(err?.message).toContain(`did you mean ${want.join(" / ")} for ${symbol}`);
    expect(err?.structured.details).toEqual({ suggestions: { [symbol]: want } });
    expect(err?.structured.remediation).toContain("case-sensitive");
  });

  it("no hint when nothing matches", async () => {
    const { s } = stream(arcus, ARCUS_ROUTES);
    const err = await s.subscribe({ kind: "allMarkets", symbols: ["NOPE"] }).ready.then(() => null, (e: unknown) => e as WsError);
    expect(err?.message).toBe("arcus: unknown symbol(s) NOPE");
  });
});

describe("auth error message", () => {
  it("a provider without authToken names the purpose once (no doubled venue prefix)", async () => {
    const { s } = stream(lighter, LIGHTER_ROUTES, { credentials: { user: async () => ({ venue: "lighter", accountIndex: 1000001 }) } });
    const err = await s.subscribe({ kind: "user", channels: ["orders"] }).ready.then(() => null, (e: unknown) => e as WsError);
    expect(err?.structured.code).toBe("WS_AUTH_FAILED");
    expect(err?.message).toMatch(/^lighter:account_all_orders needs an auth token/);
    expect(err?.message).not.toContain("lighter: lighter:");
  });
});

describe("transport factory errors", () => {
  const routes = PACIFICA_ROUTES;
  it("a definite structured error (another bundle's WsError shape) closes the stream with its code — no reconnect", async () => {
    let calls = 0;
    const transport = () => {
      calls++;
      throw Object.assign(new Error("needs ws"), { structured: { code: "INVALID_PARAMS", message: "needs ws", retryable: false, remediation: "npm install ws" } });
    };
    const s = createVenueStream(pacifica, { transport, fetch: fakeFetch(routes), visibility: null });
    const err = await s.subscribe({ kind: "allMarkets" }).ready.then(() => null, (e: unknown) => e as WsError);
    expect(err?.structured).toMatchObject({ code: "INVALID_PARAMS", remediation: "npm install ws" });
    expect(s.state).toMatchObject({ status: "closed", reason: { code: "INVALID_PARAMS", remediation: "npm install ws" } });
    expect(calls).toBe(1);
  });

  it("a plain Error (transient) still reconnects with the handshake remediation", async () => {
    const transport = () => { throw new Error("boom"); };
    const s = createVenueStream(pacifica, { transport, fetch: fakeFetch(routes), visibility: null });
    const states: string[] = [];
    s.onState(st => states.push(st.status));
    s.subscribe({ kind: "allMarkets" });
    await new Promise(r => setTimeout(r, 20));
    expect(s.state).toMatchObject({ status: "reconnecting", reason: { code: "EXCHANGE_UNREACHABLE" } });
    await s.close();
  });
});
