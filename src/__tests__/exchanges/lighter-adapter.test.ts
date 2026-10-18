import { describe, it, expect, vi } from "vitest";
import { LighterAdapter } from "../../exchanges/lighter.js";
import type { AgentMeta } from "../../settings.js";
import { PerpError as mod_PerpError } from "../../errors.js";
import { lighterFamilyNetworks } from "../../exchanges/venues/lighter-family.js";

describe("LighterAdapter.withdraw — USDC 6-decimal scaling (P0 under-scale regression)", () => {
  function makeAdapter() {
    const a = new LighterAdapter("0xabc", true);
    const signWithdraw = vi.fn().mockResolvedValue({ txType: 13, txInfo: "{}", txHash: "0x" });
    (a as unknown as { ensureSigner: () => void }).ensureSigner = () => {};
    (a as unknown as { getNextNonce: () => Promise<number> }).getNextNonce = async () => 7;
    (a as unknown as { _signer: { signWithdraw: typeof signWithdraw } })._signer = { signWithdraw } as never;
    (a as unknown as { sendTx: (s: unknown) => Promise<unknown> }).sendTx = async () => ({ code: 200, tx_hash: "ab" });
    // The withdraw is polled to executed (M6); the poll itself is covered in premainnet/lighter.test.ts.
    (a as unknown as { awaitTxExecuted: () => Promise<void> }).awaitTxExecuted = async () => {};
    return { a, signWithdraw };
  }

  it("scales human USDC to smallest units (100 → 100_000_000) for the low-level signer", async () => {
    const { a, signWithdraw } = makeAdapter();
    await a.withdraw("100", "");
    expect(signWithdraw).toHaveBeenCalledTimes(1);
    const params = signWithdraw.mock.calls[0][0] as { usdcAmount: number; assetIndex: number };
    expect(params.usdcAmount).toBe(100_000_000);
    expect(params.assetIndex).toBe(3); // USDC default
  });

  it("throws rather than signing a sub-unit (dust) withdrawal", async () => {
    const { a, signWithdraw } = makeAdapter();
    await expect(a.withdraw("0.0000001", "")).rejects.toThrow(/below the minimum unit/);
    expect(signWithdraw).not.toHaveBeenCalled();
  });
});

// These cover the pure / state-machine surface of LighterAdapter that does not
// require the WASM signer or any REST call: the constructor only assigns
// fields, so an instance can be built with a dummy key and its market maps
// injected directly. The hot signing/order paths still rely on live API and
// are exercised by the integration suite.

describe("LighterAdapter.getMarketIndex", () => {
  function makeAdapter(): LighterAdapter {
    const a = new LighterAdapter("0xabc", true);
    (a as unknown as { _marketMap: Map<string, number> })._marketMap = new Map([
      ["BTC", 1],
      ["ETH", 2],
    ]);
    return a;
  }

  it("returns the market index for a known symbol", () => {
    expect(makeAdapter().getMarketIndex("BTC")).toBe(1);
    expect(makeAdapter().getMarketIndex("ETH")).toBe(2);
  });

  it("upcases the symbol before lookup (case-insensitive)", () => {
    expect(makeAdapter().getMarketIndex("btc")).toBe(1);
    expect(makeAdapter().getMarketIndex("eth")).toBe(2);
  });

  it("throws for an unknown market", () => {
    expect(() => makeAdapter().getMarketIndex("DOGE")).toThrow(/Unknown Lighter market: DOGE/);
  });
});

describe("LighterAdapter.toTicks — size/price → integer ticks", () => {
  // toTicks takes the size as a decimal string and FLOORS it to the size step with exact
  // decimal arithmetic (precision.ts floorSize) — never rounded up past the request.
  type ToTicks = (symbol: string, size: string, price: string) => { baseAmount: number; priceTicks: number };
  function makeAdapter(): LighterAdapter {
    const a = new LighterAdapter("0xabc", true);
    // BTC: 5 size decimals (min size 0.00001), 1 price decimal (min price 0.1)
    (a as unknown as { _marketDecimals: Map<string, { size: number; price: number }> })._marketDecimals =
      new Map([["BTC", { size: 5, price: 1 }]]);
    return a;
  }
  const toTicks = (a: LighterAdapter): ToTicks =>
    (a as unknown as { toTicks: ToTicks }).toTicks.bind(a);

  it("converts size and price using the market's decimals", () => {
    const { baseAmount, priceTicks } = toTicks(makeAdapter())("BTC", "0.001", "76000");
    expect(baseAmount).toBe(100);    // 0.001 * 1e5
    expect(priceTicks).toBe(760000); // 76000 * 1e1
  });

  it("is case-insensitive on the symbol lookup", () => {
    const { baseAmount } = toTicks(makeAdapter())("btc", "0.001", "76000");
    expect(baseAmount).toBe(100);
  });

  it("floors the size to the size step (never rounds up past the request)", () => {
    // 0.000014 → floor to 0.00001 → 1 tick
    expect(toTicks(makeAdapter())("BTC", "0.000014", "76000").baseAmount).toBe(1);
    // 0.000019 would ROUND to 2 ticks (more than requested); floor keeps it at 1
    expect(toTicks(makeAdapter())("BTC", "0.000019", "76000").baseAmount).toBe(1);
  });

  it("throws when market decimals are not loaded for the symbol", () => {
    const a = new LighterAdapter("0xabc", true);
    expect(() => toTicks(a)("BTC", "0.001", "76000")).toThrow(/No market decimals loaded for BTC/);
  });

  it("throws when the size is below the market's precision (baseAmount rounds to 0)", () => {
    // 0.000001 floors to 0 at step 0.00001 → SIZE_TOO_SMALL (dust guard)
    expect(() => toTicks(makeAdapter())("BTC", "0.000001", "76000"))
      .toThrow(/Order size 0\.000001 too small for BTC \(sizeDecimals=5/);
  });

  it("refuses an off-tick price instead of rounding it to the nearest tick (INVALID_TICK)", () => {
    const a = new LighterAdapter("0xabc", true);
    (a as unknown as { _marketDecimals: Map<string, { size: number; price: number }> })._marketDecimals =
      new Map([["TINY", { size: 2, price: 1 }]]);
    // price tick 0.1: 0.04 and 76000.05 are off the grid — refused, never rounded (0 / 76000.1)
    expect(() => toTicks(a)("TINY", "1", "0.04")).toThrow(/price 0\.04 is not on the price tick 0\.1/);
    try { toTicks(a)("TINY", "1", "76000.05"); throw new Error("no throw"); } catch (e) {
      expect((e as { structured?: { code?: string } }).structured?.code).toBe("INVALID_TICK");
    }
    expect(toTicks(a)("TINY", "1", "76000.1").priceTicks).toBe(760001);
  });
});

describe("LighterAdapter._resolveSigner / activeSignerTier — 3-tier priority", () => {
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  function makeMeta(expiresAt: string): AgentMeta {
    return {
      agentName: "agent1",
      agentWalletName: "wallet1",
      agentEvmAddress: "0x0000000000000000000000000000000000000000",
      userEvmAddress: "0x0000000000000000000000000000000000000000",
      expiresAt,
      apiKeyIndex: 5,
      accountIndex: 42,
      masterWalletName: "main",
      owsApiKeyId: "ows_key_test",
      owsPolicyId: "policy-test",
      approvedAt: new Date().toISOString(),
      permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
      asterApprovalNonce: "0",
    };
  }
  type ResolveSigner = () => { tier: "agent" | "master" | "pk" };
  const resolveSigner = (a: LighterAdapter): ResolveSigner =>
    (a as unknown as { _resolveSigner: ResolveSigner })._resolveSigner.bind(a);

  it("resolves 'pk' when only a constructor evmKey is supplied", () => {
    const a = new LighterAdapter("0xpk", true);
    expect(a.activeSignerTier).toBe("pk");
  });

  it("resolves 'master' (over pk) when an EVM signer was injected via setSigner", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setSigner({ getAddress: () => "0xMaster" } as unknown as Parameters<LighterAdapter["setSigner"]>[0]);
    expect(a.activeSignerTier).toBe("master");
  });

  it("resolves 'agent' when a non-expired agent meta + key are set", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setAgentSigner(makeMeta(future), "deadbeef");
    expect(a.activeSignerTier).toBe("agent");
  });

  it("an expired agent is AGENT_EXPIRED even when an evmKey exists (no fall-through to the master tier)", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setAgentSigner(makeMeta(past), "deadbeef");
    expect(a.activeSignerTier).toBeNull();
    expect(() => resolveSigner(a)()).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "AGENT_EXPIRED" }) }));
    // Trading paths say so too (init never loads an expired agent's key).
    expect(() => (a as unknown as { ensureSigner(): void }).ensureSigner()).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "AGENT_EXPIRED" }) }));
    a.setNoAgent(true);
    expect(a.activeSignerTier).toBe("pk");
  });

  it("ignores the agent tier when the --no-agent bypass is set", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setAgentSigner(makeMeta(future), "deadbeef");
    a.setNoAgent(true);
    expect(a.activeSignerTier).toBe("pk");
  });

  it("activeSignerTier returns null (no throw) for an expired agent with no master/pk fallback", () => {
    const a = new LighterAdapter("", true); // no evmKey
    a.setAgentSigner(makeMeta(past), "deadbeef");
    expect(a.activeSignerTier).toBeNull();
  });

  it("_resolveSigner throws AGENT_EXPIRED for an expired agent with no fallback", () => {
    const a = new LighterAdapter("", true);
    a.setAgentSigner(makeMeta(past), "deadbeef");
    expect(() => resolveSigner(a)()).toThrow(/expired/i);
  });

  it("_resolveSigner throws NO_SIGNER_AVAILABLE when nothing is configured", () => {
    const a = new LighterAdapter("", true);
    expect(() => resolveSigner(a)()).toThrow(/No signing path/i);
    expect(a.activeSignerTier).toBeNull();
  });
});

/**
 * Non-USDC withdrawals must refuse rather than mis-scale.
 *
 * `_withdrawRaw` hardcodes the 1e6 factor, which is USDC's scale specifically
 * (assetDetails id 3: decimals 6, l1_decimals 6). ETH (id 1) and LIT (id 2)
 * report decimals 8 with l1_decimals 18, so the same factor would sign a
 * withdrawal ~100x too small — the exact class of defect 966ffc0 fixed for USDC.
 * The correct factor is not determinable here (the docs say "the ERC20's
 * decimals" while the L2 registry carries a different `decimals`), so this is a
 * Rule #2 refusal, not a guess.
 */
describe("LighterAdapter.withdraw — non-USDC assets refuse instead of mis-scaling", () => {
  const buildAdapter = async () => {
    const mod = await import("../../exchanges/lighter.js");
    const adapter = Object.create(mod.LighterAdapter.prototype);
    adapter.ensureSigner = vi.fn();
    adapter.getNextNonce = vi.fn().mockResolvedValue(1);
    adapter.sendTx = vi.fn().mockResolvedValue({ code: 200, tx_hash: "ab" });
    adapter.awaitTxExecuted = vi.fn().mockResolvedValue(undefined);
    adapter._apiKeyIndex = 4;
    adapter._accountIndex = 42;
    // Object.create bypasses the constructor: set the venue network config it would derive
    // (collateral / collateralAssetIndex come from venues/lighter-family.ts).
    adapter._network = lighterFamilyNetworks("lighter").mainnet;
    adapter.venueId = "lighter";
    adapter.name = "lighter";
    adapter._signer = { signWithdraw: vi.fn().mockResolvedValue({ txType: 13, txInfo: "{}" }) };
    return adapter;
  };

  it("refuses asset id 1 (ETH)", async () => {
    const adapter = await buildAdapter();
    await expect(adapter.withdraw("1", "", { assetId: 1 })).rejects.toThrow(/only supports USDC/);
    expect(adapter._signer.signWithdraw).not.toHaveBeenCalled();
  });

  it("refuses asset id 2 (LIT)", async () => {
    const adapter = await buildAdapter();
    await expect(adapter.withdraw("1", "", { assetId: 2 })).rejects.toThrow(/only supports USDC/);
    expect(adapter._signer.signWithdraw).not.toHaveBeenCalled();
  });

  it("still signs USDC (asset id 3) scaled by 1e6", async () => {
    const adapter = await buildAdapter();
    await adapter.withdraw("100", "", { assetId: 3 });
    expect(adapter._signer.signWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ usdcAmount: 100_000_000, assetIndex: 3 }),
    );
  });

  it("defaults to USDC when no assetId is supplied", async () => {
    const adapter = await buildAdapter();
    await adapter.withdraw("5", "");
    expect(adapter._signer.signWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ usdcAmount: 5_000_000, assetIndex: 3 }),
    );
  });
});

/**
 * cancel-all is per-order on PERP markets only.
 *
 * The account-wide CancelAllOrders tx (market index 255) also cancels the account's SPOT orders,
 * and its sendTx ack was reported as success without the tx being polled. cancelAllOrders now
 * cancels each listed perp order and polls each cancel to executed (pre-mainnet review M6).
 */
describe("LighterAdapter.cancelAllOrders — per perp order, never the account-wide tx", () => {
  const buildAdapter = async () => {
    const mod = await import("../../exchanges/lighter.js");
    const adapter = Object.create(mod.LighterAdapter.prototype);
    adapter.ensureSigner = vi.fn();
    adapter.getOpenOrders = vi.fn().mockResolvedValue([
      { orderId: "10", symbol: "ETH" }, { orderId: "11", symbol: "BTC" },
    ]);
    adapter.cancelOrder = vi.fn(async (_s: string, id: string) => ({ code: 200, tx_hash: `h${id}` }));
    adapter.awaitTxExecuted = vi.fn().mockResolvedValue(undefined);
    adapter._signer = { signCancelAllOrders: vi.fn() };
    return adapter;
  };

  it("never signs CancelAllOrders (market 255); cancels each perp order and polls each tx", async () => {
    const adapter = await buildAdapter();
    await adapter.cancelAllOrders();
    expect(adapter._signer.signCancelAllOrders).not.toHaveBeenCalled();
    expect(adapter.cancelOrder.mock.calls.map((c: unknown[]) => c[1])).toEqual(["10", "11"]);
    expect(adapter.awaitTxExecuted).toHaveBeenCalledTimes(2);
  });

  it("a cancel tx that is not executed surfaces (never a silent success)", async () => {
    const adapter = await buildAdapter();
    adapter.awaitTxExecuted = vi.fn().mockRejectedValue(new mod_PerpError("ORDER_PENDING", "tx not executed"));
    await expect(adapter.cancelAllOrders("ETH")).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(adapter.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it("a failed cancel does not stop the rest: every order is attempted, the error carries per-order results", async () => {
    const adapter = await buildAdapter();
    adapter.name = "lighter";
    adapter.cancelOrder = vi.fn(async (_s: string, id: string) => {
      if (id === "10") throw new mod_PerpError("ORDER_REJECTED", "order not found");
      return { code: 200, tx_hash: `h${id}` };
    });
    const err = await adapter.cancelAllOrders().catch((e: unknown) => e) as InstanceType<typeof mod_PerpError>;
    expect(adapter.cancelOrder).toHaveBeenCalledTimes(2);
    expect(err.structured.code).toBe("ORDER_PARTIAL");
    expect(err.structured.details?.results).toEqual([
      { orderId: "10", symbol: "ETH", cancelled: false, code: "ORDER_REJECTED", error: "order not found" },
      { orderId: "11", symbol: "BTC", cancelled: true, code: null, error: null },
    ]);
  });

  it("nothing cancelled: all definite refusals → ORDER_REJECTED, an unknown outcome → ORDER_PENDING", async () => {
    const adapter = await buildAdapter();
    adapter.name = "lighter";
    adapter.cancelOrder = vi.fn().mockRejectedValue(new mod_PerpError("ORDER_REJECTED", "refused"));
    await expect(adapter.cancelAllOrders()).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
    adapter.cancelOrder = vi.fn().mockRejectedValue(new mod_PerpError("ORDER_PENDING", "unknown"));
    await expect(adapter.cancelAllOrders()).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });
});

describe("LighterAdapter docs alignment (apidocs.lighter.xyz)", () => {
  it("updateLeverage truncates 10000/leverage like the official SDK int()", async () => {
    const mod = await import("../../exchanges/lighter.js");
    const adapter = Object.create(mod.LighterAdapter.prototype);
    adapter.ensureSigner = vi.fn();
    adapter.ensureMarketMap = vi.fn();
    adapter.getNextNonce = vi.fn().mockResolvedValue(1);
    adapter.getMarketIndex = vi.fn().mockReturnValue(0);
    adapter._signer = { signUpdateLeverage: vi.fn().mockResolvedValue({ txType: 20, txInfo: "{}" }) };
    adapter.sendTx = vi.fn().mockResolvedValue({ code: 200 });
    adapter.awaitTxExecuted = vi.fn();
    await adapter.updateLeverage("ETH", 3); // 3333.33 → 3333
    await adapter.updateLeverage("ETH", 7); // 1428.57 → 1428 (Math.round gave 1429)
    expect(adapter._signer.signUpdateLeverage.mock.calls.map((c: Array<{ fraction: number }>) => c[0].fraction)).toEqual([3333, 1428]);
  });

  it("getOpenOrders is one request for all perp markets; an order on an unlisted market_index throws", async () => {
    const mod = await import("../../exchanges/lighter.js");
    const adapter = Object.create(mod.LighterAdapter.prototype);
    Object.assign(adapter, { _address: "0xabc", _accountIndex: 5, _readOnly: false, venueId: "lighter-rh", name: "lighter-rh" });
    adapter._marketMap = new Map([["ETH", 0], ["BTC", 1]]);
    adapter.ensureMarketMap = vi.fn();
    const row = (id: string, market: number) => ({ order_id: id, market_index: market, is_ask: true, price: "2", initial_base_amount: "1", filled_base_amount: "0", status: "open", type: "limit" });
    adapter.restGetAuth = vi.fn().mockResolvedValue({ orders: [row("1", 0), row("2", 1)] });
    expect((await adapter.getOpenOrders()).map((o: { symbol: string }) => o.symbol)).toEqual(["ETH", "BTC"]);
    expect(adapter.restGetAuth).toHaveBeenCalledTimes(1);
    adapter.restGetAuth = vi.fn().mockResolvedValue({ orders: [row("3", 77)] });
    await expect(adapter.getOpenOrders()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    adapter.restGetAuth = vi.fn().mockResolvedValue({ code: 200 });
    await expect(adapter.getOpenOrders()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("lighterPostSendTx: a timeout after the send is ORDER_PENDING", async () => {
    const mod = await import("../../exchanges/lighter.js");
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(mod.lighterPostSendTx("https://lt.test", { txType: 14, txInfo: "{}" }, "lighter", "order", "order"))
        .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("LighterSpotAdapter docs alignment", () => {
  const spotFor = async (lt: Record<string, unknown>) => {
    const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
    const spot = Object.create(LighterSpotAdapter.prototype);
    spot._lt = lt;
    spot.name = "lighter";
    return spot;
  };

  it("self-transfer signs the fee read from transferFeeInfo (charged on top, must match exactly)", async () => {
    const signTransfer = vi.fn().mockReturnValue({ txType: 12, txInfo: "{}" });
    const spot = await spotFor({ isReadOnly: false, accountIndex: 7, collateralAssetIndex: 3, collateralSymbol: "USDC", _apiKeyIndex: 2, signer: { signTransfer } });
    spot._restGetAuth = vi.fn().mockResolvedValue({ code: 200, transfer_fee_usdc: 1500 });
    spot._getNextNonce = vi.fn().mockResolvedValue(9);
    spot._sendTx = vi.fn().mockResolvedValue({ code: 200 });
    await spot.transferToSpot("5", "USDC");
    expect(spot._restGetAuth).toHaveBeenCalledWith("/transferFeeInfo", { account_index: "7", to_account_index: "7" });
    expect(signTransfer.mock.calls[0][0]).toMatchObject({ amount: 5_000_000, usdcFee: 1500, fromRouteType: 0, toRouteType: 1 });
  });

  it("an unusable transferFeeInfo answer sends nothing", async () => {
    const signTransfer = vi.fn();
    const spot = await spotFor({ isReadOnly: false, accountIndex: 7, collateralAssetIndex: 3, collateralSymbol: "USDC", _apiKeyIndex: 2, signer: { signTransfer } });
    spot._restGetAuth = vi.fn().mockResolvedValue({ code: 200 });
    spot._sendTx = vi.fn();
    await expect(spot.transferToPerp("5", "USDC")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    expect(signTransfer).not.toHaveBeenCalled();
    expect(spot._sendTx).not.toHaveBeenCalled();
  });
});

/**
 * Market orders must honour reduceOnly.
 *
 * `reduceOnly` is a first-class field on the Lighter order struct
 * (`ReduceOnly uint8 json:"ro"`), not a limit-only one. marketOrder used to
 * `void opts` and hardcode 0, so every close/rollback that asked for
 * reduce-only went out as a plain market order — one sized above the live
 * position could FLIP it. The venue enforces the constraint itself
 * (21732 "reduce only increases position"), so passing it through turns a
 * silent flip into an honest rejection. Reachable from smart-order's close and
 * fallback paths (smart-order.ts:157,188,210). Same defect 6812c86 fixed on
 * Hyperliquid.
 */
describe("LighterAdapter.marketOrder — reduceOnly is honoured", () => {
  const buildAdapter = async () => {
    const mod = await import("../../exchanges/lighter.js");
    const adapter = Object.create(mod.LighterAdapter.prototype);
    adapter.ensureSigner = vi.fn();
    adapter.ensureMarketMap = vi.fn();
    adapter.getNextNonce = vi.fn().mockResolvedValue(1);
    adapter.getMarketIndex = vi.fn().mockReturnValue(0);
    adapter.getReferencePrice = vi.fn().mockResolvedValue(100);
    adapter.toTicks = vi.fn().mockReturnValue({ baseAmount: 1000, priceTicks: 200 });
    adapter.protectionFor = vi.fn().mockReturnValue({ protection: {}, priceTicks: 200 });
    adapter.clientOrderIndexFor = vi.fn().mockReturnValue(1);
    adapter.signOrder = vi.fn().mockResolvedValue({ txType: 14, txInfo: "{}" });
    adapter.sendTx = vi.fn().mockResolvedValue({ ok: true });
    adapter.awaitIocOutcome = vi.fn().mockResolvedValue({});
    adapter.name = "lighter";
    return adapter;
  };
  // marketOrder opts are required (interface.ts): reduceOnly + the resolved slippage bound.
  const slippage = { bps: 50, source: "default" as const };

  it("sends reduceOnly=1 when the caller asks to reduce only", async () => {
    const adapter = await buildAdapter();
    await adapter.marketOrder("BTC", "sell", "0.01", { reduceOnly: true, slippage }).catch(() => {});
    expect(adapter.signOrder).toHaveBeenCalledWith(
      expect.objectContaining({ reduceOnly: 1, orderType: 1 }),
    );
  });

  it("sends reduceOnly=0 for a normal entry", async () => {
    const adapter = await buildAdapter();
    await adapter.marketOrder("BTC", "buy", "0.01", { reduceOnly: false, slippage }).catch(() => {});
    expect(adapter.signOrder).toHaveBeenCalledWith(
      expect.objectContaining({ reduceOnly: 0 }),
    );
  });

  it("passes the resolved slippage bound to the protection price", async () => {
    const adapter = await buildAdapter();
    await adapter.marketOrder("BTC", "buy", "0.01", { reduceOnly: false, slippage }).catch(() => {});
    expect(adapter.protectionFor).toHaveBeenCalledWith("BTC", "buy", 100, slippage, expect.anything());
    expect(adapter.signOrder).toHaveBeenCalledWith(
      expect.objectContaining({ reduceOnly: 0 }),
    );
  });
});
