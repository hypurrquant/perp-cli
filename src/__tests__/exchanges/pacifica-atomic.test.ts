/**
 * Pacifica Atomic basket (src/exchanges/pacifica-atomic.ts) — request building, signing, response
 * parsing and the unknown-outcome path, against the docs' own examples:
 *  - rest-api/orders/batch-order: the CreateMarket action example and the 200 response example;
 *  - rest-api/orders/create-market-order: signing type "create_market_order";
 *  - api/signing: message = recursively key-sorted compact JSON {data, expiry_window, timestamp, type}.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PerpError } from "../../errors.js";
import {
  ATOMIC_MAX_LEGS_PER_SIDE, DRY_RUN_SIGNATURE, atomicBatchError, atomicDryRunPlan, atomicIncompleteError, atomicLegClientOrderId,
  atomicLegOutcome, atomicLegPayload, atomicMarketsOf, executeAtomic, parseAtomicBatchResponse, parseAtomicLegs,
  requireAtomicReduceOnly, sizeAtomicLegs, type AtomicLeg, type AtomicLegOutcome,
} from "../../exchanges/pacifica-atomic.js";
import type { MarketInfo, PriceInfo } from "../../pacifica/types/market.js";

const info = (symbol: string, lot: string, min: string, type = "perpetual") =>
  ({ symbol, lot_size: lot, tick_size: "1", min_order_size: min, instrument_type: type }) as unknown as MarketInfo;
const price = (symbol: string, mark: string) => ({ symbol, mark }) as unknown as PriceInfo;

const INFO = [info("BTC", "0.00001", "10"), info("ETH", "0.0001", "10"), info("kBONK", "1", "10"), info("SOL-USDC", "0.01", "10", "spot")];
const PRICES = [price("BTC", "100000"), price("ETH", "2500"), price("kBONK", "0.003"), price("SOL-USDC", "100")];

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return e instanceof PerpError ? e.structured.code : `plain: ${String(e)}`; }
  return undefined;
}

describe("parseAtomicLegs", () => {
  it("SYMBOL[:WEIGHT]; no weight = 1; --long = buy, --short = sell", () => {
    expect(parseAtomicLegs(["BTC:50"], ["ETH"])).toEqual([
      { symbol: "BTC", side: "buy", weight: 50 },
      { symbol: "ETH", side: "sell", weight: 1 },
    ]);
  });

  it("refuses more than 5 legs per side, no legs, bad weights and duplicate markets (case-insensitive)", () => {
    const six = Array.from({ length: ATOMIC_MAX_LEGS_PER_SIDE + 1 }, (_, i) => `S${i}`);
    expect(codeOf(() => parseAtomicLegs(six, []))).toBe("INVALID_PARAMS");
    expect(codeOf(() => parseAtomicLegs([], []))).toBe("INVALID_PARAMS");
    expect(codeOf(() => parseAtomicLegs(["BTC:0"], []))).toBe("INVALID_PARAMS");
    expect(codeOf(() => parseAtomicLegs(["BTC:-1"], []))).toBe("INVALID_PARAMS");
    expect(codeOf(() => parseAtomicLegs(["BTC:abc"], []))).toBe("INVALID_PARAMS");
    expect(codeOf(() => parseAtomicLegs(["BT C"], []))).toBe("INVALID_PARAMS");
    expect(codeOf(() => parseAtomicLegs(["BTC"], ["btc"]))).toBe("INVALID_PARAMS");
    expect(parseAtomicLegs(["A", "B", "C", "D", "E"], ["F", "G", "H", "I", "J"])).toHaveLength(10);
  });
});

describe("atomicMarketsOf / sizeAtomicLegs", () => {
  it("docs example: $1,000 split 50/50 between a BTC long and an ETH short → $500 each at the mark", () => {
    const specs = parseAtomicLegs(["BTC:50"], ["ETH:50"]);
    const legs = sizeAtomicLegs(specs, "1000", atomicMarketsOf(specs, INFO, PRICES));
    expect(legs.map(l => [l.symbol, l.side, l.size, l.notionalUsd])).toEqual([["BTC", "buy", "0.005", 500], ["ETH", "sell", "0.2", 500]]);
  });

  it("floors each leg to its lot and resolves the venue spelling (kBONK)", () => {
    const specs = parseAtomicLegs(["kbonk:1"], ["BTC:2"]);
    const legs = sizeAtomicLegs(specs, "100", atomicMarketsOf(specs, INFO, PRICES));
    expect(legs[0]).toMatchObject({ symbol: "kBONK", size: "11111" }); // 33.33 / 0.003 = 11111.1 → lot 1
    expect(legs[1]).toMatchObject({ symbol: "BTC", size: "0.00066" }); // 66.67 / 100000 = 0.00066666 → lot 0.00001
  });

  it("unknown / spot symbol → SYMBOL_NOT_FOUND; missing lot or minimum → EXCHANGE_ERROR (no default); no mark → PRICE_STALE", () => {
    expect(codeOf(() => atomicMarketsOf(parseAtomicLegs(["NOPE"], []), INFO, PRICES))).toBe("SYMBOL_NOT_FOUND");
    // A spot row (instrument_type "spot") is not a perp market.
    expect(codeOf(() => atomicMarketsOf(parseAtomicLegs(["SOLX"], []), [...INFO, info("SOLX", "0.01", "10", "spot")], [...PRICES, price("SOLX", "100")]))).toBe("SYMBOL_NOT_FOUND");
    expect(codeOf(() => atomicMarketsOf(parseAtomicLegs(["BTC"], []), [{ ...INFO[0], lot_size: undefined } as unknown as MarketInfo], PRICES))).toBe("EXCHANGE_ERROR");
    expect(codeOf(() => atomicMarketsOf(parseAtomicLegs(["BTC"], []), [{ ...INFO[0], min_order_size: "" } as MarketInfo], PRICES))).toBe("EXCHANGE_ERROR");
    expect(codeOf(() => atomicMarketsOf(parseAtomicLegs(["BTC"], []), INFO, []))).toBe("PRICE_STALE");
    expect(codeOf(() => atomicMarketsOf(parseAtomicLegs(["BTC"], []), INFO, [price("BTC", "0")]))).toBe("PRICE_STALE");
  });

  it("a leg below one lot or below the venue's USD minimum → SIZE_TOO_SMALL (nothing sent)", () => {
    const specs = parseAtomicLegs(["BTC"], ["ETH"]);
    const m = atomicMarketsOf(specs, INFO, PRICES);
    expect(codeOf(() => sizeAtomicLegs(specs, "1", m))).toBe("SIZE_TOO_SMALL"); // 0.5 USD BTC < one lot ($1)
    expect(codeOf(() => sizeAtomicLegs(specs, "15", m))).toBe("SIZE_TOO_SMALL"); // $7.5 legs < $10 minimum
    expect(codeOf(() => sizeAtomicLegs(specs, "0", m))).toBe("INVALID_PARAMS");
  });
});

describe("requireAtomicReduceOnly", () => {
  const legs = (side: "buy" | "sell", size = "0.1") => [{ symbol: "ETH", side, size } as AtomicLeg];
  it("a sell leg needs a long of at least its size; a buy leg a short", () => {
    expect(() => requireAtomicReduceOnly(legs("sell"), [{ symbol: "ETH", side: "long", size: "0.2" }])).not.toThrow();
    expect(() => requireAtomicReduceOnly(legs("buy"), [{ symbol: "ETH", side: "short", size: "0.1" }])).not.toThrow();
    expect(codeOf(() => requireAtomicReduceOnly(legs("sell"), [{ symbol: "ETH", side: "short", size: "1" }]))).toBe("INVALID_PARAMS");
    expect(codeOf(() => requireAtomicReduceOnly(legs("sell"), []))).toBe("INVALID_PARAMS");
    expect(codeOf(() => requireAtomicReduceOnly(legs("sell", "0.3"), [{ symbol: "ETH", side: "long", size: "0.2" }]))).toBe("INVALID_PARAMS");
  });
});

describe("leg payload, dry-run plan and the signed message (docs batch-order CreateMarket example)", () => {
  // docs batch-order: { type: "CreateMarket", data: { account, signature, timestamp: 1749190500355, expiry_window: 5000,
  //   symbol: "ETH", amount: "1.0", side: "ask", slippage_percent: "0.5", reduce_only: false } }
  const DOC_PAYLOAD = { symbol: "ETH", amount: "1.0", side: "ask", slippage_percent: "0.5", reduce_only: false };
  const DOC_TS = 1749190500355;

  it("atomicDryRunPlan reproduces the docs' action shape and the canonical create_market_order message", () => {
    const plan = atomicDryRunPlan([DOC_PAYLOAD], { account: "42trU9A5...", agentWallet: null, timestamp: DOC_TS, expiryWindow: 5000 });
    expect(plan.endpoint).toBe("POST /api/v1/orders/batch");
    expect(plan.body).toEqual({
      actions: [{
        type: "CreateMarket",
        data: { account: "42trU9A5...", signature: DRY_RUN_SIGNATURE, timestamp: DOC_TS, expiry_window: 5000, ...DOC_PAYLOAD },
      }],
    });
    expect(plan.signedMessages[0]).toBe(
      `{"data":{"amount":"1.0","reduce_only":false,"side":"ask","slippage_percent":"0.5","symbol":"ETH"},"expiry_window":5000,"timestamp":${DOC_TS},"type":"create_market_order"}`,
    );
  });

  it("an agent signer adds agent_wallet; the default expiry window is the client's (5000 ms)", () => {
    const plan = atomicDryRunPlan([DOC_PAYLOAD], { account: "MASTER", agentWallet: "AGENT", timestamp: DOC_TS });
    expect(plan.body.actions[0].data).toMatchObject({ account: "MASTER", agent_wallet: "AGENT", expiry_window: 5000 });
  });

  it("atomicLegPayload: bps → slippage_percent, side bid/ask, reduce_only, client_order_id, builder_code only when given", () => {
    const leg = { symbol: "BTC", side: "buy", size: "0.005" } as AtomicLeg;
    const p = atomicLegPayload(leg, { reduceOnly: true, slippageBps: 50, clientOrderId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", builderCode: null });
    expect(p).toEqual({ symbol: "BTC", amount: "0.005", side: "bid", slippage_percent: "0.5", reduce_only: true, client_order_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479" });
    expect(atomicLegPayload({ ...leg, side: "sell" }, { reduceOnly: false, slippageBps: 25, clientOrderId: "x", builderCode: "MYCODE" }))
      .toMatchObject({ side: "ask", slippage_percent: "0.25", builder_code: "MYCODE" });
  });

  it("generated leg client ids are full UUIDs outside the reserved 5ac1f prefix", () => {
    for (let i = 0; i < 200; i++) {
      const id = atomicLegClientOrderId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(id.startsWith("5ac1f")).toBe(false);
    }
  });
});

describe("parseAtomicBatchResponse (docs 200 example)", () => {
  // docs batch-order Status 200.
  const DOC_RESPONSE = {
    success: true,
    data: { results: [{ success: true, order_id: 470506, error: null }, { success: true, order_id: null, error: null }] },
    error: null, code: null,
  };

  it("one ack per leg in order; accepted rows keep their order_id (null when the venue gives none)", () => {
    expect(parseAtomicBatchResponse(DOC_RESPONSE, 2)).toEqual([{ kind: "accepted", orderId: "470506" }, { kind: "accepted", orderId: null }]);
  });

  it("a refused row is rejected; a row without a definite success/error is unknown", () => {
    const raw = { success: true, data: { results: [{ success: false, order_id: null, error: "Insufficient balance" }, { success: null }, 7] } };
    expect(parseAtomicBatchResponse(raw, 3).map(a => a.kind)).toEqual(["rejected", "unknown", "unknown"]);
  });

  it("no results array, a count mismatch, or a non-object body → ORDER_PENDING (never assumed)", () => {
    expect(codeOf(() => parseAtomicBatchResponse(DOC_RESPONSE, 3))).toBe("ORDER_PENDING");
    expect(codeOf(() => parseAtomicBatchResponse({ success: false, error: "x" }, 1))).toBe("ORDER_PENDING");
    expect(codeOf(() => parseAtomicBatchResponse(null, 1))).toBe("ORDER_PENDING");
    expect(codeOf(() => parseAtomicBatchResponse([], 1))).toBe("ORDER_PENDING");
  });
});

describe("atomicBatchError", () => {
  it("HTTP 400 → ORDER_REJECTED (documented whole-request refusal); 429 → RATE_LIMITED (sent:false); other 4xx → ORDER_PENDING", () => {
    expect(atomicBatchError(new Error('POST /orders/batch failed (400): {"error":"Invalid batch operation parameters","code":400}')).structured.code).toBe("ORDER_REJECTED");
    const rl = atomicBatchError(new Error("POST /orders/batch failed (429): slow down"));
    expect(rl.structured.code).toBe("RATE_LIMITED");
    expect(rl.structured.details?.sent).toBe(false);
    expect(atomicBatchError(new Error('POST /orders/batch failed (422): {"error":"x","code":0}')).structured.code).toBe("ORDER_PENDING");
    expect(atomicBatchError(new Error("socket hang up")).structured.code).toBe("ORDER_PENDING");
  });

  it("keeps an already-typed error (the client's ORDER_PENDING after a send)", () => {
    const e = new PerpError("ORDER_PENDING", "x");
    expect(atomicBatchError(e)).toBe(e);
  });
});

describe("atomicLegOutcome / atomicIncompleteError", () => {
  const leg = { symbol: "BTC", side: "buy", size: "0.005" } as AtomicLeg;
  const hist = (status: "filled" | "partiallyFilled" | "cancelled" | "rejected", filled: string) =>
    ({ status, final: true, venueStatus: status === "partiallyFilled" ? "cancelled" : status, eventType: null, orderId: "1", filledSize: filled, price: null, size: null, source: "history_by_id" }) as const;
  const out = (status: AtomicLegOutcome["status"]) => ({ status } as AtomicLegOutcome);

  it("maps acks + history rows; an accepted leg without order_id or without a confirmed row is unknown", () => {
    expect(atomicLegOutcome(leg, "c", { kind: "accepted", orderId: "1" }, hist("filled", "0.005")).status).toBe("filled");
    expect(atomicLegOutcome(leg, "c", { kind: "accepted", orderId: "1" }, hist("partiallyFilled", "0.002"))).toMatchObject({ status: "partiallyFilled", filledSize: "0.002" });
    expect(atomicLegOutcome(leg, "c", { kind: "accepted", orderId: "1" }, hist("cancelled", "0")).status).toBe("notFilled");
    expect(atomicLegOutcome(leg, "c", { kind: "accepted", orderId: "1" }, hist("rejected", "0")).status).toBe("rejected");
    expect(atomicLegOutcome(leg, "c", { kind: "accepted", orderId: "1" }, null).status).toBe("unknown");
    expect(atomicLegOutcome(leg, "c", { kind: "accepted", orderId: null }, null).status).toBe("unknown");
    expect(atomicLegOutcome(leg, "c", { kind: "rejected", error: "no" }, null)).toMatchObject({ status: "rejected", detail: "no" });
    expect(atomicLegOutcome(leg, "c", { kind: "unknown", reason: "?" }, null).status).toBe("unknown");
  });

  it("all filled → null; any unknown → ORDER_PENDING; nothing filled → ORDER_REJECTED; else ORDER_PARTIAL", () => {
    expect(atomicIncompleteError([out("filled"), out("filled")])).toBeNull();
    expect(atomicIncompleteError([out("filled"), out("unknown")])?.structured.code).toBe("ORDER_PENDING");
    expect(atomicIncompleteError([out("rejected"), out("notFilled")])?.structured.code).toBe("ORDER_REJECTED");
    expect(atomicIncompleteError([out("filled"), out("rejected")])?.structured.code).toBe("ORDER_PARTIAL");
    expect(atomicIncompleteError([out("partiallyFilled"), out("filled")])?.structured.code).toBe("ORDER_PARTIAL");
  });
});

describe("executeAtomic — real Ed25519 signing, one POST, unknown outcome never resubmitted", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => { fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function setup() {
    const { PacificaAdapter } = await import("../../exchanges/pacifica.js");
    const kp = Keypair.generate();
    const adapter = new PacificaAdapter(kp, "mainnet");
    const resolve = vi.spyOn(adapter, "resolveOrderOutcome").mockImplementation(async (orderId) =>
      ({ status: "filled", final: true, venueStatus: "filled", eventType: "fulfill_market", orderId, filledSize: "0.2", price: null, size: null, source: "history_by_id" }));
    const specs = parseAtomicLegs(["BTC:50"], ["ETH:50"]);
    const legs = sizeAtomicLegs(specs, "1000", atomicMarketsOf(specs, INFO, PRICES));
    const payloads = legs.map((l, i) => atomicLegPayload(l, { reduceOnly: false, slippageBps: 50, clientOrderId: `00000000-0000-4000-8000-00000000000${i}`, builderCode: null }));
    return { adapter, kp, resolve, legs, payloads };
  }

  it("each action is signed as create_market_order over the sorted message; both legs go in ONE request", async () => {
    const { adapter, kp, legs, payloads } = await setup();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { results: [{ success: true, order_id: 11, error: null }, { success: true, order_id: 12, error: null }] } }), { status: 200 }));
    const { outcomes } = await executeAtomic(adapter, legs, payloads);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.pacifica.fi/api/v1/orders/batch");
    const body = JSON.parse(String(init.body)) as { actions: Array<{ type: string; data: Record<string, unknown> }> };
    expect(body.actions.map(a => a.type)).toEqual(["CreateMarket", "CreateMarket"]);
    for (const [i, a] of body.actions.entries()) {
      const { account, signature, timestamp, expiry_window, ...payload } = a.data;
      expect(account).toBe(kp.publicKey.toBase58());
      expect(payload).toEqual(payloads[i]);
      expect(expiry_window).toBe(5000);
      const msg = atomicDryRunPlan([payload], { account: null, agentWallet: null, timestamp: timestamp as number }).signedMessages[0];
      expect(nacl.sign.detached.verify(new TextEncoder().encode(msg), bs58.decode(String(signature)), kp.publicKey.toBytes())).toBe(true);
    }
    expect(outcomes.map(o => [o.symbol, o.orderId, o.status])).toEqual([["BTC", "11", "filled"], ["ETH", "12", "filled"]]);
  });

  it("HTTP 500 after sending → ORDER_PENDING; the batch is sent exactly once and no fill is read", async () => {
    const { adapter, resolve, legs, payloads } = await setup();
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(executeAtomic(adapter, legs, payloads)).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a timeout / reset after sending → ORDER_PENDING (sent once)", async () => {
    const { adapter, legs, payloads } = await setup();
    fetchSpy.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    await expect(executeAtomic(adapter, legs, payloads)).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("HTTP 400 → ORDER_REJECTED (definite: no leg processed)", async () => {
    const { adapter, legs, payloads } = await setup();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "Invalid batch operation parameters", code: 400 }), { status: 400 }));
    await expect(executeAtomic(adapter, legs, payloads)).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("a leg accepted without order_id stays unknown → the basket is ORDER_PENDING", async () => {
    const { adapter, resolve, legs, payloads } = await setup();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { results: [{ success: true, order_id: 11, error: null }, { success: true, order_id: null, error: null }] } }), { status: 200 }));
    const { outcomes } = await executeAtomic(adapter, legs, payloads);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(outcomes[1]).toMatchObject({ status: "unknown", clientOrderId: payloads[1].client_order_id });
    expect(atomicIncompleteError(outcomes)?.structured.code).toBe("ORDER_PENDING");
  });

  it("signing fails → nothing is sent (ORDER_REJECTED)", async () => {
    const { adapter, legs, payloads } = await setup();
    (adapter as unknown as { _solanaSigner: { signMessage: () => Promise<never>; getPublicKeyBase58: () => string } })._solanaSigner = {
      signMessage: async () => { throw new Error("device locked"); }, getPublicKeyBase58: () => "X",
    };
    await expect(executeAtomic(adapter, legs, payloads)).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
