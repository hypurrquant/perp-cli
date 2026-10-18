/**
 * Review fixes (PR #18) — outcome classification after send, per-order cancel-all collection,
 * user-price grid refusal, and no-silent-default reads. No network: every adapter is a
 * prototype-only instance with its I/O members stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Wallet } from "ethers";
import "../../exchanges/venues/index.js";
import { PerpError, isDefiniteOrderFailure, isTransportFailure } from "../../errors.js";
import { HyperliquidAdapter, hlRequirePriceOnGrid } from "../../exchanges/hyperliquid.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import { PacificaSpotAdapter } from "../../exchanges/pacifica-spot.js";
import { LighterAdapter, lighterRowField } from "../../exchanges/lighter.js";
import { LighterSpotAdapter } from "../../exchanges/lighter-spot.js";
import { AsterAdapter } from "../../exchanges/aster.js";
import { AsterSpotAdapter } from "../../exchanges/aster-spot.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { QfexAdapter } from "../../exchanges/qfex/adapter.js";
import { ArcusSpotChain } from "../../exchanges/arcus/spot-chain.js";
import { getVenue, requireCapabilities } from "../../exchanges/venue.js";

type Rec = Record<string, unknown>;
/** A prototype-only adapter whose (incl. private) members a test stubs and calls freely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const proto = (cls: { prototype: object }): Loose => Object.create(cls.prototype) as Loose;
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof PerpError)) throw new Error(`expected a PerpError, got ${String(e)}`);
  return e.structured.code;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("errors.isTransportFailure — the bare word 'network' is not a transport failure", () => {
  it.each(["wrong network", "unsupported network: base", "Network mismatch: expected arbitrum", "network fee too high"])("%s → false", (msg) => {
    expect(isTransportFailure(new Error(msg))).toBe(false);
  });
  it.each(["network error", "NetworkError when attempting to fetch resource.", "Network request failed", "network failure", "network unreachable"])("%s → true", (msg) => {
    expect(isTransportFailure(new Error(msg))).toBe(true);
  });
});

describe("Hyperliquid price grid (user-supplied prices are refused, never rounded)", () => {
  it.each([
    ["3012.5", 2, 6, "3012.5"], ["0.012345", 0, 6, "0.012345"], ["123456", 3, 6, "123456"], ["100000", 5, 6, "100000"],
    ["0.0001234", 1, 8, "0.0001234"], ["007.50", 1, 6, "7.5"],
  ] as const)("%s (szDecimals %d, max %d) → on grid %s", (px, sz, max, want) => {
    expect(hlRequirePriceOnGrid(px, sz, max, "limit price")).toBe(want);
  });
  it.each([
    ["3012.55", 2, 6], ["123456.5", 0, 6], ["0.12345", 3, 6], ["1.123", 4, 6], ["0.0001234", 2, 8],
  ] as const)("%s (szDecimals %d, max %d) → INVALID_TICK", (px, sz, max) => {
    let err: unknown = null;
    try { hlRequirePriceOnGrid(px, sz, max, "limit price"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).structured.code).toBe("INVALID_TICK");
    expect((err as PerpError).structured.remediation).toMatch(/on-grid price/);
  });
  it.each(["abc", "1e3", "-5", "0", " ", "0x10"])("%s → INVALID_PARAMS", (px) => {
    expect(() => hlRequirePriceOnGrid(px, 2, 6, "limit price")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
  it("buy 3012.55 is NOT rounded up to 3012.6 — refused before anything is sent", async () => {
    const a = proto(HyperliquidAdapter);
    a.getAssetIndex = vi.fn().mockResolvedValue(1);
    a.getSzDecimals = vi.fn().mockReturnValue(2);
    const send = vi.fn();
    a._signAndSendAction = send;
    expect(await codeOf(a.limitOrder("ETH", "buy", "3012.55", "0.1"))).toBe("INVALID_TICK");
    expect(send).not.toHaveBeenCalled();
  });
  it("modifyOrder with an off-grid price → INVALID_TICK, nothing sent", async () => {
    const a = proto(HyperliquidAdapter);
    a.getAssetIndex = vi.fn().mockResolvedValue(1);
    a.getSzDecimals = vi.fn().mockReturnValue(2);
    const send = vi.fn();
    a._signAndSendAction = send;
    expect(await codeOf(a.modifyOrder("ETH", 7, "buy", "3012.55", "0.1", { reduceOnly: false, tif: "Gtc" }))).toBe("INVALID_TICK");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Hyperliquid _validateVenueAck — a missing per-entry verdict after send is ORDER_PENDING", () => {
  const a = proto(HyperliquidAdapter);
  it.each([
    ["order", { status: "ok", response: { type: "order", data: { statuses: [] } } }],
    ["modify 7", { status: "ok", response: { type: "default" } }],
    ["cancel 7", { status: "ok" }],
  ])("%s → ORDER_PENDING (not retryable)", (what, res) => {
    let err: unknown = null;
    try { a._validateVenueAck(res, what); } catch (e) { err = e; }
    expect((err as PerpError).structured).toMatchObject({ code: "ORDER_PENDING", retryable: false });
    expect((err as PerpError).structured.remediation).toMatch(/Do NOT/);
  });
});

describe("Hyperliquid cancelAllOrders — every order is attempted", () => {
  const order = (id: string) => ({ orderId: id, symbol: "BTC", side: "buy" as const, price: "1", size: "1", filled: "0", status: "open", type: "limit", triggerPrice: null });
  const ok = { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } };
  const refused = (msg: string) => ({ status: "ok", response: { type: "cancel", data: { statuses: [{ error: msg }] } } });
  const adapter = (replies: unknown[]) => {
    const a = proto(HyperliquidAdapter);
    a.ensureSigner = vi.fn();
    a.getOpenOrders = vi.fn().mockResolvedValue(["1", "2", "3"].map(order));
    a.getAssetIndex = vi.fn().mockResolvedValue(0);
    const send = vi.fn();
    for (const r of replies) send.mockResolvedValueOnce(r);
    a._signAndSendAction = send;
    return { a, send };
  };
  it("a refused cancel in the middle does not stop the rest → ORDER_PARTIAL with per-order results", async () => {
    const { a, send } = adapter([ok, refused("Order has invalid size."), ok]);
    const err = await a.cancelAllOrders().catch((e: unknown) => e) as PerpError;
    expect(send).toHaveBeenCalledTimes(3);
    expect(err.structured.code).toBe("ORDER_PARTIAL");
    expect((err.structured.details?.results as Rec[]).map(r => r.outcome)).toEqual(["cancelled", "failed", "cancelled"]);
  });
  it("'already canceled, or filled' entries are reported as gone, not fatal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { a, send } = adapter([refused("Order was never placed, already canceled, or filled. asset=0"), ok, ok]);
    const res = await a.cancelAllOrders();
    expect(send).toHaveBeenCalledTimes(3);
    expect(res).toHaveLength(2);
  });
  it("every cancel refused → ORDER_REJECTED; an unknown ack among them → ORDER_PENDING", async () => {
    expect(await codeOf(adapter([refused("x"), refused("y"), refused("z")]).a.cancelAllOrders())).toBe("ORDER_REJECTED");
    expect(await codeOf(adapter([refused("x"), { status: "ok" }, refused("z")]).a.cancelAllOrders())).toBe("ORDER_PENDING");
  });
});

describe("Hyperliquid getOpenOrders — no silent oid / price / size defaults", () => {
  it.each(["oid", "limitPx", "sz"])("row without %s → EXCHANGE_ERROR", async (k) => {
    const a = proto(HyperliquidAdapter);
    a._address = "0x0000000000000000000000000000000000000001";
    a._dex = "";
    a._assetMap = new Map();
    const row: Rec = { coin: "BTC", side: "B", oid: 5, limitPx: "100", sz: "1" };
    delete row[k];
    a._infoPost = vi.fn().mockResolvedValue([row]);
    expect(await codeOf(a.getOpenOrders())).toBe("EXCHANGE_ERROR");
  });
});

describe("Pacifica cancelAllOrders — every order is attempted", () => {
  const order = (id: string, type = "limit") => ({ orderId: id, symbol: "BTC", side: "buy" as const, price: "1", size: "1", filled: "0", status: "open", type, triggerPrice: null });
  const adapter = (cancel: (id: string) => Promise<unknown>) => {
    const a = proto(PacificaAdapter);
    a.ensureSigner = vi.fn();
    a.getOpenOrders = vi.fn().mockResolvedValue([order("1"), order("2"), order("3")]);
    const c = vi.fn((_s: string, id: string) => cancel(id));
    a.cancelOrder = c;
    return { a, c };
  };
  it("a 4xx refusal in the middle → the rest still cancelled, ORDER_PARTIAL", async () => {
    const { a, c } = adapter(async (id) => {
      if (id === "2") throw new Error("POST /orders/cancel failed (422): {\"error\":\"Failed to cancel order\"}");
      return { success: true };
    });
    const err = await a.cancelAllOrders().catch((e: unknown) => e) as PerpError;
    expect(c).toHaveBeenCalledTimes(3);
    expect(err.structured.code).toBe("ORDER_PARTIAL");
  });
  it("all refused (incl. a body refusal) → ORDER_REJECTED; a transport failure → ORDER_PENDING", async () => {
    expect(await codeOf(adapter(async (id) => {
      if (id === "1") return { success: false, error: "nope" };
      throw new Error("POST /orders/cancel failed (400): bad");
    }).a.cancelAllOrders())).toBe("ORDER_REJECTED");
    expect(await codeOf(adapter(async () => { throw new TypeError("fetch failed"); }).a.cancelAllOrders())).toBe("ORDER_PENDING");
  });
  it("the open-orders read failing → not sent (definite), nothing cancelled", async () => {
    const { a, c } = adapter(async () => ({ success: true }));
    a.getOpenOrders = vi.fn().mockRejectedValue(new Error("GET /orders failed (500)"));
    const err = await a.cancelAllOrders().catch((e: unknown) => e);
    expect(isDefiniteOrderFailure(err)).toBe(true);
    expect(c).not.toHaveBeenCalled();
  });
});

describe("Pacifica spot", () => {
  it("open order with a side other than bid / ask → EXCHANGE_ERROR (never mapped to sell)", async () => {
    const a = proto(PacificaSpotAdapter);
    a.init = vi.fn();
    a._spot = new Map([["BTC", { symbol: "BTC-USDC", base_asset: "BTC" }]]);
    a._perp = { publicKey: "pk", sdk: { getOrders: vi.fn().mockResolvedValue([{ order_id: 1, symbol: "BTC-USDC", side: "long", price: "1", initial_amount: "1", filled_amount: "0" }]) } };
    expect(await codeOf(a.getSpotOpenOrders(null))).toBe("EXCHANGE_ERROR");
  });
  it("a pre-send failure (mark read) → not sent (definite)", async () => {
    const a = proto(PacificaSpotAdapter);
    a.init = vi.fn();
    a._resolve = vi.fn().mockReturnValue({ symbol: "BTC-USDC", lot_size: "0.001", tick_size: "0.1", base_asset: "BTC" });
    a._mark = vi.fn().mockRejectedValue(new Error("GET /info/prices failed (500)"));
    const err = await a.spotMarketOrder("BTC/USDC", "buy", "0.01", { slippage: { bps: 50, source: "default" } }).catch((e: unknown) => e);
    expect(isDefiniteOrderFailure(err)).toBe(true);
  });
});

describe("Lighter", () => {
  const lighter = () => {
    const a = proto(LighterAdapter);
    a.name = "lighter";
    a._testnet = false;
    return a;
  };
  it("pollTx stops on HTTP 429 without Retry-After (one read, reported pending)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = lighter();
    const get = vi.fn().mockRejectedValue(new PerpError("RATE_LIMITED", "lighter: rate limited (HTTP 429)"));
    a.restGet = get;
    const st = await (a.pollTx as (h: string, n: number) => Promise<Rec>).call(a, "0xh", 10);
    expect(st.kind).toBe("pending");
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("pollTx honours a Retry-After that fits the window, then polls again", async () => {
    vi.useFakeTimers();
    const a = lighter();
    const get = vi.fn()
      .mockRejectedValueOnce(new PerpError("RATE_LIMITED", "429", { retryAfterMs: 1000 }))
      .mockResolvedValue({ code: 200, status: 0, hash: "0xh" });
    a.restGet = get;
    const p = (a.pollTx as (h: string, n: number) => Promise<Rec>).call(a, "0xh", 10);
    await vi.advanceTimersByTimeAsync(500);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("orderStatusRow by client id keeps only rows on the symbol's market; several → refused", async () => {
    const a = lighter();
    a.ensureMarketMap = vi.fn();
    a.getMarketIndex = vi.fn().mockReturnValue(1);
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([
      { client_order_index: 7, market_index: 2, order_id: "other-market" },
      { client_order_index: 7, market_index: 1, order_id: "ours" },
    ]);
    expect(await a.orderStatusRow("ETH", { kind: "clientOrderId", value: "7" })).toMatchObject({ order_id: "ours" });
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([{ client_order_index: 7, market_index: 2, order_id: "x" }]);
    expect(await codeOf(a.orderStatusRow("ETH", { kind: "clientOrderId", value: "7" }))).toBe("ORDER_NOT_FOUND");
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([
      { client_order_index: 7, market_index: 1, order_id: "a" }, { client_order_index: 7, market_index: 1, order_id: "b" },
    ]);
    expect(await codeOf(a.orderStatusRow("ETH", { kind: "clientOrderId", value: "7" }))).toBe("INVALID_PARAMS");
  });
  it("getBalance: no account → EXCHANGE_ERROR, not a zero balance; unreadable assets → EXCHANGE_ERROR", async () => {
    const a = lighter();
    a._address = "0x0000000000000000000000000000000000000001";
    a._accountIndex = 3;
    a._network = { collateral: ["USDC"] };
    a.fetchAccount = vi.fn().mockResolvedValue(null);
    expect(await codeOf(a.getBalance())).toBe("EXCHANGE_ERROR");
    const acct = { total_asset_value: "10", available_balance: "5", collateral: "8", positions: [] };
    a.fetchAccount = vi.fn().mockResolvedValue(acct);
    expect(await codeOf(a.getBalance())).toBe("EXCHANGE_ERROR");
    a.fetchAccount = vi.fn().mockResolvedValue({ ...acct, assets: [{ symbol: "USDC", balance: "2" }] });
    expect((await a.getBalance()).equity).toBe("12");
    a.fetchAccount = vi.fn().mockResolvedValue({ ...acct, assets: [] });
    expect((await a.getBalance()).equity).toBe("10");
  });
  it("lighterRowField: missing / empty → EXCHANGE_ERROR (no '0' / 'open' defaults)", () => {
    expect(lighterRowField({ price: "1.5" }, "price", "lighter")).toBe("1.5");
    expect(() => lighterRowField({ price: "" }, "price", "lighter")).toThrow(PerpError);
    expect(() => lighterRowField({}, "status", "lighter")).toThrow(/no status/);
  });
});

describe("Lighter spot ↔ perp transfer amount — exact decimal scaling", () => {
  const spot = () => {
    const a = proto(LighterSpotAdapter);
    a.name = "lighter";
    const signTransfer = vi.fn().mockReturnValue({ error: "stop-here" });
    a._lt = { isReadOnly: false, accountIndex: 5, collateralAssetIndex: 3, collateralSymbol: "USDC", signer: { signTransfer }, _apiKeyIndex: 4 };
    a._restGetAuth = vi.fn().mockResolvedValue({ code: 200, transfer_fee_usdc: 0 });
    a._getNextNonce = vi.fn().mockResolvedValue(1);
    return { a, signTransfer };
  };
  it("0.29 USDC → 290000 units (Math.floor(0.29 * 1e6) would give 289999)", async () => {
    const { a, signTransfer } = spot();
    await expect(a.transferToSpot("0.29", "USDC")).rejects.toThrow(/stop-here/);
    expect(signTransfer.mock.calls[0][0]).toMatchObject({ amount: 290000 });
  });
  it("more than 6 decimals → INVALID_TICK before any request", async () => {
    const { a } = spot();
    expect(await codeOf(a.transferToSpot("1.0000001", "USDC"))).toBe("INVALID_TICK");
    expect(a._restGetAuth).not.toHaveBeenCalled();
  });
});

describe("Aster", () => {
  it("HTTP 429 on a signed request → RATE_LIMITED (retryable), sent:false, Retry-After carried", async () => {
    const a = proto(AsterAdapter);
    const res = new Response("{}", { status: 429, headers: { "Retry-After": "3" } });
    const err = await (a._handleAsterResponse as (r: Response, m: string, p: string) => Promise<unknown>).call(a, res, "POST", "/fapi/v3/order").catch((e: unknown) => e) as PerpError;
    expect(err.structured).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(err.structured.details).toMatchObject({ sent: false, httpStatus: 429, retryAfterMs: 3000 });
    expect(isDefiniteOrderFailure(err)).toBe(true);
  });

  const spot = (signed: () => Promise<unknown>) => {
    const a = proto(AsterSpotAdapter);
    a._perp = { activeAgentMeta: () => null };
    a._tranCounter = 0;
    a._signed = vi.fn(signed);
    return a;
  };
  it("spot↔perp transfer: 5xx / unreadable 2xx / socket reset → ORDER_PENDING", async () => {
    expect(await codeOf(spot(async () => { throw new PerpError("EXCHANGE_ERROR", "POST failed (502)", { httpStatus: 502 }); }).transferToSpot("5", "USDT"))).toBe("ORDER_PENDING");
    expect(await codeOf(spot(async () => { throw new PerpError("EXCHANGE_ERROR", "malformed JSON", { httpStatus: 200, responseUnreadable: true }); }).transferToSpot("5", "USDT"))).toBe("ORDER_PENDING");
    expect(await codeOf(spot(async () => { throw new Error("read ECONNRESET"); }).transferToSpot("5", "USDT"))).toBe("ORDER_PENDING");
  });
  it("spot↔perp transfer: 2xx with a status other than SUCCESS → ORDER_PENDING; a 4xx → ACTION_REJECTED", async () => {
    expect(await codeOf(spot(async () => ({ tranId: 1, status: "PROCESSING" })).transferToSpot("5", "USDT"))).toBe("ORDER_PENDING");
    expect(await codeOf(spot(async () => { throw new PerpError("EXCHANGE_ERROR", "POST failed (400)", { httpStatus: 400 }); }).transferToSpot("5", "USDT"))).toBe("ACTION_REJECTED");
    expect(await spot(async () => ({ tranId: 1, status: "SUCCESS" })).transferToSpot("5", "USDT")).toEqual({ tranId: 1, status: "SUCCESS" });
  });
});

describe("Ondo position stop — the new stop is identified against the pre-POST order list", () => {
  const PAIR = { market: "ETH-USD.P", baseIncrement: "0.001", quoteIncrement: "0.1" };
  const SL = { orderId: "sl-new", market: PAIR.market, side: "sell", price: "0", size: "0.005", filledSize: "0", filledCost: "0", fee: "0", createdAt: "x", type: "stopMarket", stopOrderType: "stopLoss", status: "untriggered", triggerPrice: "2573.5", reduceOnly: true };
  const stopReq = { symbol: "ETH", side: "sell" as const, type: "stopMarket" as const, size: "0.005", price: null, triggerPrice: "2573.5", triggerSource: null, tif: null, reduceOnly: true, clientOrderId: null, slippage: null, tpsl: null };
  const ondo = (getPage: () => Promise<unknown>) => {
    const def = getVenue("ondo");
    const a = proto(OndoAdapter);
    const post = vi.fn().mockResolvedValue({ market: PAIR.market, positionDirection: "long", stopLoss: "2573.5" });
    Object.assign(a, { venue: def, caps: requireCapabilities(def), network: "mainnet", builderFee: null, client: { getPage: vi.fn(getPage), post } });
    a.pairOf = vi.fn().mockResolvedValue(PAIR);
    a.markPriceOf = vi.fn().mockResolvedValue("2700");
    return { a: a as unknown as OndoAdapter, post };
  };
  it("an older identical stop listed before the POST is never taken for the new one", async () => {
    const older = { ...SL, orderId: "sl-old" };
    let n = 0;
    const { a } = ondo(async () => ({ result: n++ === 0 ? [older] : [older, SL] }));
    expect(await a.placeOrder(stopReq)).toMatchObject({ orderId: "sl-new" });
  });
  it("only the older identical stop listed after the POST → ORDER_PENDING", async () => {
    const older = { ...SL, orderId: "sl-old" };
    const { a } = ondo(async () => ({ result: [older] }));
    expect(await codeOf(a.placeOrder(stopReq))).toBe("ORDER_PENDING");
  });
  it("the read after the POST fails → ORDER_PENDING (do NOT resubmit)", async () => {
    let n = 0;
    const { a } = ondo(async () => { if (n++ === 0) return { result: [] }; throw new PerpError("TIMEOUT", "GET /v1/perps/orders timed out"); });
    const err = await a.placeOrder(stopReq).catch((e: unknown) => e) as PerpError;
    expect(err.structured.code).toBe("ORDER_PENDING");
    expect(err.structured.remediation).toMatch(/Do NOT resubmit/);
  });
  it("the read before the POST fails → not sent, no POST", async () => {
    const { a, post } = ondo(async () => { throw new PerpError("TIMEOUT", "GET timed out"); });
    const err = await a.placeOrder(stopReq).catch((e: unknown) => e);
    expect(isDefiniteOrderFailure(err)).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("QFEX settledByHistory — partially filled then cancelled is not 'filled'", () => {
  it.each([
    [{ order_id: "o1", filled_qty: 0.5, terminal_status: "CANCELLED" }, /^partially filled \(0\.5\) before the cancel/],
    [{ order_id: "o1", filled_qty: 1, terminal_status: "FILLED" }, /^filled$/],
    [{ order_id: "o1", filled_qty: 0, terminal_status: "CANCELLED" }, /^cancelled$/],
  ])("%j → %s", async (row, want) => {
    const a = proto(QfexAdapter);
    a.client = { get: vi.fn().mockResolvedValue({ data: [row] }) };
    expect(await (a.settledByHistory as (s: string, id: string) => Promise<string>).call(a, "AAPL-USD", "o1")).toMatch(want);
  });
});

describe("Arcus Permit2 approve — sent but not mined stays ORDER_PENDING", () => {
  it("receipt timeout → ORDER_PENDING with 'Do NOT send another approve' (never the retryable TIMEOUT)", async () => {
    const w = Wallet.createRandom();
    const chain = new ArcusSpotChain("http://127.0.0.1:1", 46630) as unknown as Rec;
    chain.chainChecked = true;
    chain.provider = {
      estimateGas: vi.fn().mockResolvedValue(50_000n),
      getFeeData: vi.fn().mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      getBalance: vi.fn().mockResolvedValue(10n ** 18n),
      getTransactionCount: vi.fn().mockResolvedValue(0),
      broadcastTransaction: vi.fn().mockResolvedValue({ hash: "0xabc" }),
      waitForTransaction: vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "TIMEOUT" })),
    };
    const sign = async (tx: { unsignedHash: string }) => w.signingKey.sign(tx.unsignedHash).serialized;
    const approve = (chain as unknown as ArcusSpotChain).approvePermit2.bind(chain);
    const err = await approve("0x1111111111111111111111111111111111111111", w.address, sign as never).catch((e: unknown) => e) as PerpError;
    expect(err.structured.code).toBe("ORDER_PENDING");
    expect(err.structured.remediation).toMatch(/Do NOT send another approve/);
  });
});

describe("Pacifica market order / amend — post-send unknowns", () => {
  it("terminal cancelled row WITHOUT filled_amount after send → ORDER_PENDING (never a plain Error)", async () => {
    vi.useFakeTimers();
    const a = proto(PacificaAdapter);
    a.ensureSigner = vi.fn();
    a.builderCode = vi.fn().mockResolvedValue(null);
    a.client = {
      createMarketOrder: vi.fn().mockResolvedValue({ success: true, data: { order_id: 42 } }),
      getOrderHistoryById: vi.fn().mockResolvedValue({ data: [{ order_id: 42, order_status: "cancelled", created_at: 1 }] }),
    };
    const p = a.marketOrder("BTC", "buy", "0.01", { reduceOnly: false, slippage: { bps: 50, source: "default" } }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600);
    const err = await p as PerpError;
    expect(err).toBeInstanceOf(PerpError);
    expect(err.structured.code).toBe("ORDER_PENDING");
    expect(err.structured.remediation).toMatch(/Do NOT resubmit/);
  });

  it("amend (GTC cancel→replace): an order without a readable filled_amount is refused BEFORE the cancel", async () => {
    const a = proto(PacificaAdapter);
    a.ensureSigner = vi.fn();
    const cancel = vi.fn();
    a.client = {
      getOrders: vi.fn().mockResolvedValue([{ order_id: 9, symbol: "BTC", order_type: "limit", side: "bid", client_order_id: null }]),
      getInfo: vi.fn().mockResolvedValue([{ symbol: "BTC", tick_size: "1", lot_size: "0.001", instrument_type: "perpetual" }]),
      cancelOrder: cancel,
    };
    a.getMarkets = vi.fn().mockResolvedValue([{ symbol: "BTC", stepSize: "0.001" }]);
    const err = await a.amendKeepingTif("BTC", "9", "100", "0.01", "GTC").catch((e: unknown) => e) as PerpError;
    expect(err.structured).toMatchObject({ code: "EXCHANGE_ERROR", message: expect.stringMatching(/no readable filled_amount/) });
    expect(err.structured.details?.sent).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });
});
