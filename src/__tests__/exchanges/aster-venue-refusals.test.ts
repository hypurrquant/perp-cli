/**
 * Aster venue refusals → definite PerpError codes (asterdex/api-docs V3 "Error Codes").
 * Live mainnet 2026-10-05 shapes:
 *   cancel of a filled order            → 400 {"code":-2011,"msg":"Unknown order sent."}
 *   reduce-only limit with no position  → 400 {"code":-2022,"msg":"ReduceOnly Order is rejected."}
 *   marginType ISOLATED on a flat SOL   → 400 {"code":-4050,"msg":"Cross balance insufficient."}
 *   crossing post-only (GTX, RESULT)    → 200 {status:"EXPIRED", executedQty:"0"}
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../../exchanges/venues/index.js";
import { AsterAdapter, asterOrderRejection } from "../../exchanges/aster.js";
import { AsterSpotAdapter } from "../../exchanges/aster-spot.js";
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { PerpError } from "../../errors.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import { seedAsterDirectory } from "./aster-directory.js";

type Sent = { method: string; path: string; params: URLSearchParams };

/** A real adapter whose signing is stubbed; every venue request is answered by `answer` and recorded. */
function build(answer: (s: Sent) => { status: number; body: unknown }) {
  const a = new AsterAdapter(undefined, false);
  seedAsterDirectory(a, ["BTCUSD1"]);
  const h = a as unknown as Record<string, unknown>;
  h._resolveSigner = vi.fn().mockReturnValue({ tier: "agent", signer: {}, signerAddress: "0xagent", userAddress: "0xuser" });
  h._buildSignedQueryString = vi.fn(async (params: Record<string, string>) => new URLSearchParams(params).toString());
  h._symbolPriceFilters = vi.fn().mockResolvedValue({ tickSize: "0.01" });
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const s = { method: init?.method ?? "GET", path: u.pathname, params: u.searchParams };
    sent.push(s);
    const r = answer(s);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
  return { a, sent };
}

afterEach(() => vi.unstubAllGlobals());

const refuse = (code: number, msg: string) => () => ({ status: 400, body: { code, msg } });

describe("Aster cancel: -2011 CANCEL_REJECTED is a definite ORDER_REJECTED", () => {
  it("perp DELETE /fapi/v3/order", async () => {
    const { a, sent } = build(refuse(-2011, "Unknown order sent."));
    const e = await a.cancelOrder("SOL", "777").catch((x: unknown) => x) as PerpError;
    expect(e.structured).toMatchObject({ code: "ORDER_REJECTED", retryable: false, details: { exchange: "aster", orderId: "777", venueCode: -2011 } });
    expect(e.message).toMatch(/-2011 CANCEL_REJECTED/);
    expect(sent).toHaveLength(1); // not retried
    expect(sent[0]).toMatchObject({ method: "DELETE", path: "/fapi/v3/order" });
  });

  it("another cancel refusal keeps its own classification (not relabelled -2011)", async () => {
    const { a } = build(refuse(-1121, "Invalid symbol."));
    const e = await a.cancelOrder("NOPE", "1").catch((x: unknown) => x) as PerpError;
    expect(e.structured.details?.venueCode).toBe(-1121);
    expect(e.message).not.toMatch(/CANCEL_REJECTED/);
  });

  it("spot DELETE /api/v3/order (same signed-request path)", async () => {
    const { a, sent } = build(refuse(-2011, "Unknown order sent."));
    const spot = new AsterSpotAdapter(a);
    const s = spot as unknown as Record<string, unknown>;
    s._resolve = () => ({ wire: "ASTERUSDT", base: "ASTER", quote: "USDT" });
    s._requireSpotPermission = () => undefined;
    const e = await spot.spotCancelOrder("ASTER/USDT", "42").catch((x: unknown) => x) as PerpError;
    expect(e.structured).toMatchObject({ code: "ORDER_REJECTED", retryable: false, details: { venueCode: -2011, orderId: "42" } });
    expect(sent[0]).toMatchObject({ method: "DELETE", path: "/api/v3/order" });
  });
});

describe("Aster order paths resolve USD1 (the base) to USD1USDT — never the USD1 quote suffix", () => {
  const ok = () => ({ status: 200, body: { code: 200, msg: "success", orderId: 1, status: "CANCELED" } });
  it("cancel / cancel-all send USD1USDT; a position row's symbol round-trips to the same venue symbol", async () => {
    const { a, sent } = build(ok);
    await a.cancelOrder("USD1", "1").catch(() => undefined);
    await a.cancelAllOrders("USD1").catch(() => undefined);
    expect(sent.map(x => x.params.get("symbol"))).toEqual(["USD1USDT", "USD1USDT"]);
    const h = a as unknown as { _fromApi(s: string): string; _apiSymbol(s: string): Promise<string> };
    expect(await h._apiSymbol(h._fromApi("USD1USDT"))).toBe("USD1USDT"); // close of a USD1 position
    expect(await h._apiSymbol(h._fromApi("BTCUSD1"))).toBe("BTCUSD1");
  });
});

describe("Aster POST /fapi/v3/order: a documented 4xx business code is a definite refusal", () => {
  it.each([
    [-2022, "ReduceOnly Order is rejected.", "ORDER_REJECTED", /-2022 REDUCE_ONLY_REJECT/],
    [-2010, "New order rejected.", "ORDER_REJECTED", /-2010 NEW_ORDER_REJECTED/],
    [-2018, "Balance is insufficient.", "INSUFFICIENT_BALANCE", /-2018 BALANCE_NOT_SUFFICIENT/],
    [-2019, "Margin is insufficient.", "MARGIN_INSUFFICIENT", /-2019/],
    [-2021, "Order would immediately trigger.", "ORDER_REJECTED", /-2021 ORDER_WOULD_IMMEDIATELY_TRIGGER/],
    [-2025, "Reach max open order limit.", "ORDER_REJECTED", /-2025 MAX_OPEN_ORDER_EXCEEDED/],
    [-4004, "Quantity less than min quantity.", "SIZE_TOO_SMALL", /-4004/],
    [-4005, "Quantity greater than max quantity.", "SIZE_TOO_LARGE", /-4005/],
    [-4014, "Price not increased by tick size.", "INVALID_TICK", /-4014/],
    [-4164, "Order's notional must be no smaller than 5.0", "SIZE_TOO_SMALL", /-4164 MIN_NOTIONAL/],
    [-2020, "Unable to fill.", "ORDER_REJECTED", /-2020 UNABLE_TO_FILL/],
    [-1003, "Too many requests.", "ORDER_REJECTED", /-1003 TOO_MANY_REQUESTS/],
  ] as const)("%i → %s (non-retryable)", async (code, msg, perpCode, text) => {
    const { a, sent } = build(refuse(code, msg));
    const e = await a.limitOrder("SOL", "sell", "130.70", "0.05", { reduceOnly: true }).catch((x: unknown) => x) as PerpError;
    expect(e).toBeInstanceOf(PerpError);
    expect(e.structured).toMatchObject({ code: perpCode, retryable: false, details: { exchange: "aster", venueCode: code, httpStatus: 400 } });
    expect(e.message).toMatch(text);
    expect(e.message).toContain(msg);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["HTTP 503", 503, { code: -1001, msg: "Internal error" }],
    ["-1007 TIMEOUT", 408, { code: -1007, msg: "Timeout waiting for response from backend server." }],
    ["-1001 DISCONNECTED", 400, { code: -1001, msg: "Internal error; unable to process your request. Please try again." }],
    ["-1006 UNEXPECTED_RESP", 400, { code: -1006, msg: "An unexpected response was received from the message bus." }],
  ] as const)("%s stays an unknown outcome (ORDER_PENDING)", async (_name, status, body) => {
    const { a } = build(() => ({ status, body }));
    await expect(a.limitOrder("SOL", "buy", "130.70", "0.05")).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });

  it("no code / an undocumented code is left as classified (never relabelled a definite refusal)", () => {
    const noCode = new PerpError("EXCHANGE_ERROR", "POST /fapi/v3/order failed (400): bad gateway page", { exchange: "aster", httpStatus: 400 });
    expect(asterOrderRejection(noCode)).toBe(noCode);
    const undocumented = new PerpError("EXCHANGE_ERROR", "x", { exchange: "aster", httpStatus: 400, venueCode: -9999 });
    expect(asterOrderRejection(undocumented)).toBe(undocumented);
  });

  it("the venue's -1000 signature refusal keeps its definite SIGNATURE_FAILED", async () => {
    const { a } = build(refuse(-1000, "Signature check failed"));
    await expect(a.limitOrder("SOL", "buy", "130.70", "0.05")).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
  });
});

describe("Aster post-only (GTX) is read from the RESULT response", () => {
  const order = (over: Record<string, unknown>) => ({
    orderId: 9001, symbol: "SOLUSDT", status: "NEW", type: "LIMIT", timeInForce: "GTX", side: "BUY",
    price: "131.00", origQty: "0.05", executedQty: "0", avgPrice: "0.0000", ...over,
  });
  const place = (a: AsterAdapter) => toTradingV2(a as unknown as ExchangeAdapter, "mainnet").placeOrder({
    symbol: "SOL", side: "buy", type: "limit", size: "0.05", price: "131.00", triggerPrice: null, triggerSource: null,
    tif: "GTX", reduceOnly: false, clientOrderId: null, slippage: null, tpsl: null,
  });

  it("EXPIRED with executedQty 0 (it would have crossed) → cancelled, final — never 'open'", async () => {
    const { a, sent } = build(() => ({ status: 200, body: order({ status: "EXPIRED" }) }));
    (a as unknown as { lotStepOf: () => string }).lotStepOf = () => "0.01";
    const r = await place(a);
    expect(sent[0].params.get("newOrderRespType")).toBe("RESULT");
    expect(sent[0].params.get("timeInForce")).toBe("GTX");
    expect(r).toMatchObject({ status: "cancelled", finality: "final", filledSize: "0", orderId: "9001" });
  });

  it("NEW (it rests) → open, final", async () => {
    const { a } = build(() => ({ status: 200, body: order({}) }));
    (a as unknown as { lotStepOf: () => string }).lotStepOf = () => "0.01";
    expect(await place(a)).toMatchObject({ status: "open", finality: "final" });
  });
});

describe("Aster margin-type refusal: accurate message, nothing changed", () => {
  it("-4050 on ISOLATED while flat → ACTION_REJECTED naming the venue code; the leverage request is not sent", async () => {
    const { a, sent } = build(refuse(-4050, "Cross balance insufficient."));
    const e = await a.setLeverage("SOL", 3, "isolated").catch((x: unknown) => x) as PerpError;
    expect(e.structured).toMatchObject({ code: "ACTION_REJECTED", retryable: false, details: { venueCode: -4050 } });
    expect(e.message).toMatch(/refused to switch SOL to isolated margin \(-4050 CROSS_BALANCE_INSUFFICIENT: .*Cross balance insufficient\..*\) — margin mode and leverage are unchanged/);
    expect(e.structured.remediation).toMatch(/Multi-Assets mode/);
    expect(sent.map(s => s.path)).toEqual(["/fapi/v3/marginType"]);
  });

  it("-4048 (open position) names the position; -4046 (no change needed) still proceeds to the leverage update", async () => {
    const pos = build(refuse(-4048, "Margin type cannot be changed if there exists position."));
    await expect(pos.a.setLeverage("SOL", 3, "isolated")).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED", details: { venueCode: -4048 } } });
    const same = build(s => s.path === "/fapi/v3/marginType" ? { status: 400, body: { code: -4046, msg: "No need to change margin type." } } : { status: 200, body: { leverage: 3, symbol: "SOLUSDT" } });
    await same.a.setLeverage("SOL", 3, "isolated");
    expect(same.sent.map(s => s.path)).toEqual(["/fapi/v3/marginType", "/fapi/v3/leverage"]);
  });
});
