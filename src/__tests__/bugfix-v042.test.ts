/**
 * Tests for v0.4.2 bug fixes (BUG 1–7).
 */
import { describe, it, expect, vi } from "vitest";

// ── BUG 1: HL editOrder preserves original side ──
// modifyOrder now also carries the original order's TIF ("HL modifyOrder의
// tif: \"Gtc\" 하드코딩 → 원 주문 tif 전달 (frontendOpenOrders)"), so fixtures carry `tif`.
describe("BUG 1: HL editOrder preserves side", () => {
  // editOrder reads the RAW frontendOpenOrders record (not the mapped
  // getOpenOrders, which hardcodes type:"limit" and drops reduceOnly).
  const mkAdapter = async (rawOrders: Record<string, unknown>[]) => {
    const mod = await import("../exchanges/hyperliquid.js");
    const adapter = Object.create(mod.HyperliquidAdapter.prototype);
    adapter._address = "0xabc";
    adapter._dex = undefined;
    adapter._infoPost = vi.fn().mockResolvedValue(rawOrders);
    adapter.modifyOrder = vi.fn().mockResolvedValue({ status: "ok" });
    return adapter;
  };

  it("editOrder passes existing order side (sell) to modifyOrder", async () => {
    const adapter = await mkAdapter([
      { oid: 42, coin: "ETH", side: "A", limitPx: "3000", sz: "0.1", isTrigger: false, reduceOnly: false, tif: "Gtc" },
    ]);

    await adapter.editOrder("ETH", "42", "3100", "0.1");

    expect(adapter.modifyOrder).toHaveBeenCalledWith("ETH", 42, "sell", "3100", "0.1", { reduceOnly: false, tif: "Gtc" });
  });

  it("editOrder preserves reduceOnly across the modify", async () => {
    const adapter = await mkAdapter([
      { oid: 42, coin: "ETH", side: "A", limitPx: "3000", sz: "0.1", isTrigger: false, reduceOnly: true, tif: "Gtc" },
    ]);

    await adapter.editOrder("ETH", "42", "3100", "0.1");

    expect(adapter.modifyOrder).toHaveBeenCalledWith("ETH", 42, "sell", "3100", "0.1", { reduceOnly: true, tif: "Gtc" });
  });

  it("editOrder preserves a post-only (Alo) TIF instead of re-placing it as Gtc", async () => {
    const adapter = await mkAdapter([
      { oid: 42, coin: "ETH", side: "B", limitPx: "3000", sz: "0.1", isTrigger: false, reduceOnly: false, tif: "Alo" },
    ]);

    await adapter.editOrder("ETH", "42", "3100", "0.1");

    expect(adapter.modifyOrder).toHaveBeenCalledWith("ETH", 42, "buy", "3100", "0.1", { reduceOnly: false, tif: "Alo" });
  });

  it("editOrder refuses (CAPABILITY_UNSUPPORTED) when the order's TIF is unknown — never guesses Gtc", async () => {
    const adapter = await mkAdapter([
      { oid: 42, coin: "ETH", side: "A", limitPx: "3000", sz: "0.1", isTrigger: false, reduceOnly: false },
    ]);

    await expect(adapter.editOrder("ETH", "42", "3100", "0.1")).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(adapter.modifyOrder).not.toHaveBeenCalled();
  });

  it("editOrder FAILS CLOSED when the order is not among the open orders", async () => {
    // Rule #2: the previous behaviour defaulted the side to "buy", which would
    // rewrite a resting sell order to the opposite side and can open or flip a
    // position. Refuse instead of guessing.
    const adapter = await mkAdapter([]);

    await expect(adapter.editOrder("ETH", "999", "3100", "0.1")).rejects.toThrow(
      /not among the open orders/
    );
    expect(adapter.modifyOrder).not.toHaveBeenCalled();
  });

  it("editOrder refuses to edit a trigger (stop/TP) order", async () => {
    const adapter = await mkAdapter([
      { oid: 7, coin: "ETH", side: "A", limitPx: "3000", sz: "0.1", isTrigger: true, orderType: "Stop Market" },
    ]);

    await expect(adapter.editOrder("ETH", "7", "3100", "0.1")).rejects.toThrow(
      /non-trigger orders/
    );
    expect(adapter.modifyOrder).not.toHaveBeenCalled();
  });
});

describe("HL modifyOrder surfaces per-order rejections", () => {
  // modifyOrder requires opts { reduceOnly, tif } (the original order's attributes).
  const OPTS = { reduceOnly: false, tif: "Gtc" };
  const mkAdapter = async (sendResult: unknown) => {
    const mod = await import("../exchanges/hyperliquid.js");
    const adapter = Object.create(mod.HyperliquidAdapter.prototype);
    adapter.getAssetIndex = vi.fn().mockResolvedValue(1);
    adapter.getSzDecimals = vi.fn().mockReturnValue(2);
    adapter._signAndSendAction = vi.fn().mockResolvedValue(sendResult);
    return adapter;
  };

  it("throws when statuses[0] carries an error even though the envelope is ok", async () => {
    // HL returns status:"ok" for a REJECTED modify — the verdict is per-order.
    // Pre-fix this was reported to the user as a green success.
    const adapter = await mkAdapter({
      status: "ok",
      response: { type: "order", data: { statuses: [{ error: "Order would immediately match" }] } },
    });

    await expect(adapter.modifyOrder("ETH", 42, "buy", "3100", "0.1", OPTS)).rejects.toThrow(
      /rejected: Order would immediately match/
    );
  });

  it("throws when the response carries no per-order status at all", async () => {
    const adapter = await mkAdapter({ status: "ok", response: { type: "order", data: { statuses: [] } } });

    await expect(adapter.modifyOrder("ETH", 42, "buy", "3100", "0.1", OPTS)).rejects.toThrow(
      /no order status in response/
    );
  });

  it("sends the original reduceOnly + tif on the modify wire (never a hardcoded Gtc)", async () => {
    const ok = { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 43 } }] } } };
    const adapter = await mkAdapter(ok);

    await adapter.modifyOrder("ETH", 42, "sell", "3100", "0.1", { reduceOnly: true, tif: "Alo" });
    const order = adapter._signAndSendAction.mock.calls[0][0].modifies[0].order;
    expect(order.r).toBe(true);
    expect(order.t).toEqual({ limit: { tif: "Alo" } });
  });

  it("returns the result when the modify actually rests", async () => {
    const ok = { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 43 } }] } } };
    const adapter = await mkAdapter(ok);

    await expect(adapter.modifyOrder("ETH", 42, "buy", "3100", "0.1", OPTS)).resolves.toEqual(ok);
  });
});

// ── BUG 2: Lighter market order never prices off a zero / missing reference ──
// The reference price is now the orderbook mid (, LIGHTER_REFERENCE_PRICE_SOURCE):
// a book missing a side → PRICE_STALE, and the order is NOT signed or sent (definite, pre-send).
describe("BUG 2: Lighter marketOrder refuses without a usable reference price", () => {
  const build = async (book: unknown) => {
    const mod = await import("../exchanges/lighter.js");
    const adapter = Object.create(mod.LighterAdapter.prototype);
    adapter.name = "lighter";
    adapter._readOnly = false;
    adapter._signer = {};
    adapter._marketMap = new Map([["BTC", 0]]);
    adapter._marketDecimals = new Map([["BTC", { size: 4, price: 2 }]]);
    adapter.ensureSigner = vi.fn();
    adapter.ensureMarketMap = vi.fn();
    adapter.getNextNonce = vi.fn().mockResolvedValue(1);
    adapter.getMarketIndex = vi.fn().mockReturnValue(0);
    adapter.restGet = vi.fn().mockResolvedValue(book);
    adapter.signOrder = vi.fn();
    adapter.sendTx = vi.fn();
    return adapter;
  };
  const opts = { reduceOnly: false, slippage: { bps: 50, source: "default" as const } };

  it("rejects (not sent) when the book has no bids — nothing signed or sent", async () => {
    const adapter = await build({ bids: [], asks: [{ price: "100" }] });
    await expect(adapter.marketOrder("BTC", "buy", "0.001", opts)).rejects.toThrow(/orderbook has no bids/);
    expect(adapter.signOrder).not.toHaveBeenCalled();
    expect(adapter.sendTx).not.toHaveBeenCalled();
  });

  it("treats zero-priced levels as missing (never a 0 reference price)", async () => {
    const adapter = await build({ bids: [{ price: "0" }], asks: [{ price: "0" }] });
    await expect(adapter.marketOrder("BTC", "buy", "0.001", opts)).rejects.toMatchObject({ structured: { code: "PRICE_STALE" } });
    expect(adapter.sendTx).not.toHaveBeenCalled();
  });
});

// ── BUG 3: inferTickSize float precision ──
// (Covered in smart-order.test.ts — "rounds tick size to eliminate floating-point noise")

// ── BUG 4: cancelAllOrders respects symbol filter ──
describe("BUG 4: cancelAllOrders respects symbol filter", () => {
  it("Pacifica cancelAllOrders filters by symbol", async () => {
    const mod = await import("../exchanges/pacifica.js");
    const PacificaAdapter = mod.PacificaAdapter;

    const adapter = Object.create(PacificaAdapter.prototype);
    adapter._hasRealKey = true;
    adapter.client = { setRequestAgentWallet: vi.fn() };
    adapter.getOpenOrders = vi.fn().mockResolvedValue([
      { orderId: "1", symbol: "SOL", side: "buy", price: "100", size: "1", filled: "0", status: "open", type: "limit" },
      { orderId: "2", symbol: "BTC", side: "sell", price: "50000", size: "0.01", filled: "0", status: "open", type: "limit" },
      { orderId: "3", symbol: "SOL", side: "sell", price: "110", size: "1", filled: "0", status: "open", type: "limit" },
    ]);
    adapter.cancelOrder = vi.fn().mockResolvedValue({ ok: true });

    await adapter.cancelAllOrders("SOL");

    // Should only cancel SOL orders (IDs 1 and 3)
    expect(adapter.cancelOrder).toHaveBeenCalledTimes(2);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("SOL", "1");
    expect(adapter.cancelOrder).toHaveBeenCalledWith("SOL", "3");
  });

  // CHANGELOG: "Pacifica cancel-all per-order" — never the venue `cancel_all` with
  // all_symbols:true (it would also cancel SPOT orders); each listed perp order is cancelled
  // by id so the result carries per-order proof.
  it("Pacifica cancelAllOrders with no symbol cancels each open perp order by id (never all_symbols)", async () => {
    const mod = await import("../exchanges/pacifica.js");
    const PacificaAdapter = mod.PacificaAdapter;

    const adapter = Object.create(PacificaAdapter.prototype);
    adapter._hasRealKey = true;
    adapter.ensureSigner = vi.fn();
    adapter.client = {
      cancelAllOrders: vi.fn().mockResolvedValue({ ok: true }),
      setRequestAgentWallet: vi.fn(),
    };
    adapter.getOpenOrders = vi.fn().mockResolvedValue([
      { orderId: "1", symbol: "SOL", side: "buy", price: "100", size: "1", filled: "0", status: "open", type: "limit" },
      { orderId: "2", symbol: "BTC", side: "sell", price: "50000", size: "0.01", filled: "0", status: "open", type: "limit" },
    ]);
    adapter.cancelOrder = vi.fn().mockResolvedValue({ success: true });

    await adapter.cancelAllOrders();

    expect(adapter.cancelOrder).toHaveBeenCalledTimes(2);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("SOL", "1");
    expect(adapter.cancelOrder).toHaveBeenCalledWith("BTC", "2");
    expect(adapter.client.cancelAllOrders).not.toHaveBeenCalled();
  });

  it("Lighter cancelAllOrders filters by symbol", async () => {
    const mod = await import("../exchanges/lighter.js");
    const LighterAdapter = mod.LighterAdapter;

    const adapter = Object.create(LighterAdapter.prototype);
    adapter._readOnly = false;
    adapter.ensureSigner = vi.fn();
    adapter.getOpenOrders = vi.fn().mockResolvedValue([
      { orderId: "10", symbol: "ETH", side: "buy", price: "3000", size: "0.1", filled: "0", status: "open", type: "limit" },
      { orderId: "20", symbol: "BTC", side: "sell", price: "50000", size: "0.01", filled: "0", status: "open", type: "limit" },
    ]);
    adapter.cancelOrder = vi.fn().mockResolvedValue({ ok: true });
    adapter.awaitTxExecuted = vi.fn().mockResolvedValue(undefined); // each cancel is polled to executed

    await adapter.cancelAllOrders("ETH");

    expect(adapter.cancelOrder).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrder).toHaveBeenCalledWith("ETH", "10");
  });
});

// ── BUG 5: HL getAssetIndex retries on empty map ──
describe("BUG 5: HL getAssetIndex retries on empty map", () => {
  it("retries _loadAssetMap when map is empty", async () => {
    const mod = await import("../exchanges/hyperliquid.js");
    const HyperliquidAdapter = mod.HyperliquidAdapter;

    const adapter = Object.create(HyperliquidAdapter.prototype);
    adapter._assetMap = new Map();
    adapter._assetMapReverse = new Map();
    adapter._dex = "";

    // _loadAssetMap populates the map on retry
    adapter._loadAssetMap = vi.fn().mockImplementation(async () => {
      adapter._assetMap.set("BTC", 0);
      adapter._assetMap.set("ETH", 1);
    });
    adapter.resolveSymbol = vi.fn().mockReturnValue("BTC");

    const idx = await adapter.getAssetIndex("BTC");
    expect(adapter._loadAssetMap).toHaveBeenCalledTimes(1);
    expect(idx).toBe(0);
  });

  it("does not retry when map is already populated", async () => {
    const mod = await import("../exchanges/hyperliquid.js");
    const HyperliquidAdapter = mod.HyperliquidAdapter;

    const adapter = Object.create(HyperliquidAdapter.prototype);
    adapter._assetMap = new Map([["BTC", 0]]);
    adapter._assetMapReverse = new Map([[0, "BTC"]]);
    adapter._loadAssetMap = vi.fn();
    adapter.resolveSymbol = vi.fn().mockReturnValue("BTC");

    const idx = await adapter.getAssetIndex("BTC");
    expect(adapter._loadAssetMap).not.toHaveBeenCalled();
    expect(idx).toBe(0);
  });
});

// ── BUG 7: cli-spec version from package.json ──
describe("BUG 7: cli-spec reads version from package.json", () => {
  it("version is not hardcoded '0.1.0'", async () => {
    const { getCliSpec } = await import("../cli-spec.js");
    const { Command } = await import("commander");
    const program = new Command();
    program.name("perp");
    const spec = getCliSpec(program);
    expect(spec.version).not.toBe("0.1.0");
    // Should match the version in package.json
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version: string };
    expect(spec.version).toBe(pkg.version);
  });
});

/**
 * Every HL action path must check the PER-ENTRY verdict, not just the envelope.
 *
 * HL answers `status:"ok"` even when the individual order/cancel/trigger was
 * rejected — the real verdict is `response.data.statuses[]`, where acceptance is
 * `{filled}` / `{resting}` / the string "success" and rejection is `{error}`.
 * `_signAndSendAction` throws only on the envelope, so limit orders, trigger
 * (TP/SL) orders and cancels all reported rejections to the user as success.
 * `trade scale-tp` even logged status "success" and printed an OK column,
 * because its per-level try/catch never saw a thrown error.
 */
describe("HL per-entry acknowledgement is validated on every action path", () => {
  const OK = (statuses: unknown[]) => ({ status: "ok", response: { type: "order", data: { statuses } } });
  const REJECT = OK([{ error: "Order price cannot be more than 95% away from the reference price" }]);

  const mkAdapter = async (sendResult: unknown) => {
    const mod = await import("../exchanges/hyperliquid.js");
    const adapter = Object.create(mod.HyperliquidAdapter.prototype);
    adapter.ensureSigner = vi.fn();
    adapter.getAssetIndex = vi.fn().mockResolvedValue(1);
    adapter.getSzDecimals = vi.fn().mockReturnValue(2);
    adapter._invalidateAccountCache = vi.fn();
    adapter._signAndSendAction = vi.fn().mockResolvedValue(sendResult);
    return adapter;
  };

  it("limitOrder throws when the venue rejects the order", async () => {
    const adapter = await mkAdapter(REJECT);
    await expect(adapter.limitOrder("ETH", "buy", "3000", "0.1")).rejects.toThrow(/order rejected: Order price/);
  });

  it("limitOrder resolves when the order rests", async () => {
    const adapter = await mkAdapter(OK([{ resting: { oid: 5 } }]));
    await expect(adapter.limitOrder("ETH", "buy", "3000", "0.1")).resolves.toBeDefined();
  });

  it("triggerOrder (TP/SL) throws when the venue rejects it", async () => {
    const adapter = await mkAdapter(REJECT);
    await expect(
      adapter.triggerOrder("ETH", "sell", "0.1", "4000", "tp", { reduceOnly: true }),
    ).rejects.toThrow(/TP trigger order for ETH rejected/);
  });

  it("triggerOrder names the SL leg distinctly so a half-set bracket is legible", async () => {
    const adapter = await mkAdapter(REJECT);
    await expect(
      adapter.triggerOrder("ETH", "sell", "0.1", "2000", "sl", { reduceOnly: true }),
    ).rejects.toThrow(/SL trigger order for ETH rejected/);
  });

  it("cancelOrder throws when the cancel is refused (already filled / unknown oid)", async () => {
    const adapter = await mkAdapter(OK([{ error: "Order was never placed, already canceled, or filled" }]));
    await expect(adapter.cancelOrder("ETH", "42")).rejects.toThrow(/cancel 42 rejected/);
  });

  it("cancelOrder accepts the plain \"success\" status string", async () => {
    // HL cancels answer with a bare string, not an object — it must not be
    // mistaken for a rejection.
    const adapter = await mkAdapter(OK(["success"]));
    await expect(adapter.cancelOrder("ETH", "42")).resolves.toBeDefined();
  });

  it("throws when the response carries no statuses at all", async () => {
    const adapter = await mkAdapter({ status: "ok", response: { type: "order", data: { statuses: [] } } });
    await expect(adapter.limitOrder("ETH", "buy", "3000", "0.1")).rejects.toThrow(/no order status in response/);
  });
});
