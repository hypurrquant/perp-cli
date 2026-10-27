/**
 * RISEx: exact units, typed-data golden vectors, order packing, the nonce manager, error / outcome
 * classification, the read paths and the trading paths — all with mocked fetch and an in-memory
 * test key (no network, no real wallet). Live checks are in the integration suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// The RISEx trading code is shipped but switched off in 0.15.0 (read-only phase): enable it here.
vi.mock("../../exchanges/venues/risex-release.js", () => ({ RISEX_TRADING_ENABLED: true }));
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet, verifyTypedData, getAddress } from "ethers";
import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenue, resolveVenueId } from "../../exchanges/venue.js";
import { LocalEvmSigner } from "../../signer/evm-local.js";
import { nsToMs, nsToMsOrNull, toPriceTicks, toSizeSteps, wadToDecimal } from "../../exchanges/risex/units.js";
import {
  cancelAllHash, headerFlags, leverageHash, packOrder, placeOrderHash, permitSignatureBase64, RISEX_GOLDEN_TYPEHASHES,
  RISEX_NON_TRADING_PERMISSIONS, RISEX_PINS, RISEX_TYPES, signPermit, typeHash, typeString, unpackOrder, assertPinned,
  type RisexPrimaryType,
} from "../../exchanges/risex/typed-data.js";
import { allocateNonce, bitConsumed, nextSlot, RISEX_MAX_BIT } from "../../exchanges/risex/nonce.js";
import { RisexClient, RisexSendUnknown, revertNameOf } from "../../exchanges/risex/client.js";
import { toRisexFundingRates, toRisexVenueMarkets, type RisexRawMarket } from "../../exchanges/risex/public.js";
import { RisexAdapter } from "../../exchanges/risex/adapter.js";
import { restrictSignerToTrading } from "../../exchanges/risex/agent.js";
import { assertTradingOnlyOnChain } from "../../exchanges/risex/session.js";
import { newVenueClientOrderId } from "../../exchanges/trading-v2.js";


/** On-chain reader extras: the reviewed implementation, no permission id ≥5, a bitmap from `low` (bits 5–31 set, as on a new signer). */
const chainExtras = (low: () => number) => ({
  sessionKey: async () => ({ expiration: 2_000_000_000, bitmap: 0xffffffe0n | BigInt(low()), status: 1 }),
  permissionIdExists: async () => false,
  implementationOf: async (proxy: string) => ({ [RISEX_PINS.mainnet.auth.toLowerCase()]: RISEX_PINS.mainnet.authImplementation, [RISEX_PINS.mainnet.router.toLowerCase()]: RISEX_PINS.mainnet.routerImplementation, [RISEX_PINS.mainnet.accountRegistry.toLowerCase()]: RISEX_PINS.mainnet.accountRegistryImplementation } as Record<string, string>)[proxy.toLowerCase()] as string,
  accountRegistry: async () => RISEX_PINS.mainnet.accountRegistry,
});
/** The live permission model (Authorization bytecode 0x4252): mask(1) = every bit ("all"), else 1 << p. */
const maskOf = (p: number) => (p === 1 ? 0x1f : 1 << p);

const MAINNET = "https://api.rise.trade";
const DOMAIN = { name: "RISEx", version: "1", chainId: 4153, verifyingContract: RISEX_PINS.mainnet.auth };
const CFG = { addresses: { router: RISEX_PINS.mainnet.router, auth: RISEX_PINS.mainnet.auth }, is_maintenance_mode: false };

function market(over: Partial<RisexRawMarket> & { market_id: string; name: string }): RisexRawMarket {
  return {
    config: { name: over.name, step_size: "0.000001", step_price: "0.1", max_leverage: "25", min_order_size: "0.00015", unlocked: true, match_price_band: "0.02" },
    mark_price: "83425.592259767000092250", index_price: "83429.668195683538", open_interest: "204.62", quote_volume_24h: "46147397.06",
    funding_interval: "3600000000000", next_funding_time: "1791910800000000000", current_funding_rate: "0.000014990672003283",
    predicted_funding_rate: "0", post_only: false, reduce_only: false, active: true, category: "crypto", search_tags: ["crypto"],
    ...over,
  } as RisexRawMarket;
}
const MARKETS = [
  market({ market_id: "1", name: "BTC/USDC" }),
  market({ market_id: "13", name: "DOGE/USDC [deprecated-1779958099]", active: false, category: "" }),
  market({ market_id: "17", name: "XAU/USDC", category: "commodity" }),
  market({ market_id: "27", name: "SPY/USDC", category: "index_etf" }),
  market({ market_id: "39", name: "SOXL/USDC", category: "stocks", search_tags: ["etf", "stocks"] }),
  market({ market_id: "40", name: "NEW/USDC", reduce_only: true }),
  market({ market_id: "41", name: "ODD/USDC", funding_interval: "28800000000000" }),
];

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, request_id: "r" }), { status });
const err = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message }, request_id: "r" }), { status });

let fetchMock: ReturnType<typeof vi.fn>;
let nonceDir: string;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => { throw new Error(`unexpected network call: ${url}`); });
  vi.stubGlobal("fetch", fetchMock);
  nonceDir = mkdtempSync(join(tmpdir(), "risex-nonce-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(nonceDir, { recursive: true, force: true });
});

describe("venue definition", () => {
  it("risex: trading venue, alias rise, hourly verified funding, app-only funds", () => {
    const def = getVenue("rise");
    expect(def.id).toBe("risex");
    expect(resolveVenueId("risex")).toBe("risex");
    expect(def.roles).toEqual(["marketData", "account", "trading"]);
    expect(def.fundingRateBasis).toEqual({ kind: "perHours", hours: 1 });
    expect(def.capabilities?.withdrawAssets).toBeNull();
    expect(def.capabilities?.timeInForce).toEqual(["GTC", "IOC", "FOK", "ALO"]);
    expect(def.apiStatus.kind).toBe("official");
  });
});

describe("units (exact)", () => {
  it("WAD → decimal", () => {
    expect(wadToDecimal("1143307000000000000")).toBe("1.143307");
    expect(wadToDecimal("-2905000000000000000")).toBe("-2.905");
    expect(wadToDecimal("200000000000000")).toBe("0.0002");
    expect(wadToDecimal("0")).toBe("0");
    expect(wadToDecimal("1")).toBe("0.000000000000000001");
    expect(() => wadToDecimal("1.5")).toThrow(PerpError);
  });
  it("ns → ms; '0' / '' → null", () => {
    expect(nsToMs("1791910800000000000")).toBe(1791910800000);
    expect(nsToMsOrNull("0")).toBeNull();
    expect(nsToMsOrNull("")).toBeNull();
  });
  it("size steps / price ticks: exact, refused off-grid, bounded", () => {
    expect(toSizeSteps("0.0002", "0.000001")).toBe(200n);
    expect(toPriceTicks("55024.8", "0.1")).toBe(550248n);
    expect(() => toPriceTicks("55024.85", "0.1")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_TICK" }) }));
    expect(() => toSizeSteps("0.0000005", "0.000001")).toThrow(PerpError);
    expect(() => toPriceTicks("1677721.6", "0.1")).toThrow(/uint24/);
    expect(() => toSizeSteps("4294.967296", "0.000001")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "SIZE_TOO_LARGE" }) }));
  });
});

describe("typed data golden vectors", () => {
  it("typehashes equal the mainnet Authorization contract values", () => {
    for (const k of Object.keys(RISEX_GOLDEN_TYPEHASHES) as RisexPrimaryType[]) expect(typeHash(k)).toBe(RISEX_GOLDEN_TYPEHASHES[k]);
    expect(typeString("VerifyWitness")).toBe("VerifyWitness(address account,address target,bytes32 hash,uint48 nonceAnchor,uint8 nonceBitmap,uint32 deadline)");
  });

  it("order packing round-trips the documented layout", () => {
    const f = { marketId: 1, sizeSteps: 200n, priceTicks: 550248n, side: 0 as const, postOnly: true, reduceOnly: false, stpMode: 0, orderType: 1 as const, tif: 0 as const };
    const word = packOrder(f);
    const flags = 0 | (1 << 1) | (1 << 5) | (0 << 6);
    expect(word).toBe((1n << 70n) | (200n << 38n) | (550248n << 14n) | (BigInt(flags) << 6n) | (1n << 1n));
    expect(unpackOrder(word)).toEqual({ ...f, version: 1 });
    const sell = unpackOrder(packOrder({ ...f, side: 1, postOnly: false, reduceOnly: true, orderType: 0, tif: 3 }));
    expect(sell).toMatchObject({ side: 1, reduceOnly: true, orderType: 0, tif: 3, postOnly: false });
    expect(() => packOrder({ ...f, priceTicks: 16_777_216n })).toThrow(PerpError);
  });

  it("header flags / action hashes are deterministic and commit to their operands", () => {
    expect(headerFlags(0n)).toBe(0x01);
    expect(headerFlags(5n)).toBe(0x05);
    const w = packOrder({ marketId: 1, sizeSteps: 200n, priceTicks: 550248n, side: 0, postOnly: true, reduceOnly: false, stpMode: 0, orderType: 1, tif: 0 });
    expect(placeOrderHash(w, 0n)).not.toBe(placeOrderHash(w, 1n));
    expect(cancelAllHash(1)).not.toBe(cancelAllHash(2));
    expect(leverageHash(1, 10)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => leverageHash(1, 0)).toThrow(PerpError);
  });

  it("permit: signer-signed VerifyWitness against the router, base64 65 bytes, recovers the signer", async () => {
    const key = Wallet.createRandom();
    const signer = await LocalEvmSigner.create(key.privateKey);
    const account = getAddress("0x938a104179a2d23dec249a968ecd5b4f8b857cac");
    const hash = cancelAllHash(1);
    const permit = await signPermit({ signer, account, router: RISEX_PINS.mainnet.router, domain: DOMAIN, actionHash: hash, slot: { anchor: 7n, bit: 3 }, deadline: 1_900_000_000 });
    const bytes = Buffer.from(permit.signature, "base64");
    expect(bytes.length).toBe(65);
    const recovered = verifyTypedData({ ...DOMAIN, verifyingContract: getAddress(DOMAIN.verifyingContract) }, { VerifyWitness: RISEX_TYPES.VerifyWitness },
      { account, target: getAddress(RISEX_PINS.mainnet.router), hash, nonceAnchor: 7n, nonceBitmap: 3, deadline: 1_900_000_000 }, `0x${bytes.toString("hex")}`);
    expect(recovered).toBe(signer.getAddress());
    expect(permit).toMatchObject({ nonce_anchor: "7", nonce_bitmap_index: 3, deadline: 1_900_000_000, signer: signer.getAddress() });
    expect(() => permitSignatureBase64("0x1234")).toThrow(PerpError);
  });

  it("pins: a changed router / auth / chain is refused before signing", () => {
    expect(() => assertPinned("mainnet", DOMAIN, RISEX_PINS.mainnet.router, RISEX_PINS.mainnet.auth)).not.toThrow();
    expect(() => assertPinned("mainnet", DOMAIN, "0x0000000000000000000000000000000000000001", RISEX_PINS.mainnet.auth)).toThrow(/router/);
    expect(() => assertPinned("mainnet", { ...DOMAIN, chainId: 1 }, RISEX_PINS.mainnet.router, RISEX_PINS.mainnet.auth)).toThrow(/chainId/);
  });
});

describe("nonce manager", () => {
  it("fresh anchor from the chain state; successor bits; 207 → next anchor bit 0", () => {
    expect(nextSlot({ anchor: 5n, currentBitmapIndex: 3 }, null)).toEqual({ anchor: 6n, bit: 0 });
    expect(nextSlot({ anchor: 5n, currentBitmapIndex: 3 }, { anchor: 6n, bit: 4 })).toEqual({ anchor: 6n, bit: 5 });
    // local older than the chain → the chain wins (max of the two)
    expect(nextSlot({ anchor: 9n, currentBitmapIndex: 0 }, { anchor: 6n, bit: 4 })).toEqual({ anchor: 10n, bit: 0 });
    expect(nextSlot({ anchor: 6n, currentBitmapIndex: 0 }, { anchor: 6n, bit: RISEX_MAX_BIT })).toEqual({ anchor: 7n, bit: 0 });
    // successor beyond anchor + 1 is refused, never guessed
    expect(() => nextSlot({ anchor: 5n, currentBitmapIndex: 0 }, { anchor: 6n, bit: RISEX_MAX_BIT })).toThrow(PerpError);
  });

  it("each allocation is persisted before use: sequential calls never repeat a pair (restart-safe)", async () => {
    const remote = async () => ({ anchor: 5n, currentBitmapIndex: 0 });
    const a = await allocateNonce("mainnet", "0xAbC", remote, nonceDir);
    const b = await allocateNonce("mainnet", "0xabc", remote, nonceDir);
    expect(a).toEqual({ anchor: 6n, bit: 0 });
    expect(b).toEqual({ anchor: 6n, bit: 1 });
    // A failed / unknown send does not give the bit back: the next allocation moves on.
    const c = await allocateNonce("mainnet", "0xabc", remote, nonceDir);
    expect(c).toEqual({ anchor: 6n, bit: 2 });
    // Other network: independent state.
    expect(await allocateNonce("testnet", "0xabc", remote, nonceDir)).toEqual({ anchor: 6n, bit: 0 });
  });

  it("a held lock (live holder) → LOCK_HELD (no pair handed out)", async () => {
    writeFileSync(join(nonceDir, "mainnet-0xdef.json.lock"), `${process.pid}\n${Date.now()}\nother`);
    const t0 = Date.now();
    await expect(allocateNonce("mainnet", "0xdef", async () => ({ anchor: 1n, currentBitmapIndex: 0 }), nonceDir))
      .rejects.toMatchObject({ structured: { code: "LOCK_HELD" } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_000);
  }, 15_000);

  it("a stale lock (old AND holder process gone) is taken over safely", async () => {
    const lock = join(nonceDir, "mainnet-0xfed.json.lock");
    writeFileSync(lock, `999999999\n${Date.now()}\ndead`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const slot = await allocateNonce("mainnet", "0xfed", async () => ({ anchor: 1n, currentBitmapIndex: 0 }), nonceDir);
    expect(slot).toEqual({ anchor: 2n, bit: 0 });
    expect(readdirSync(nonceDir).filter(f => f.includes(".lock"))).toEqual([]);
  });

  it("an empty / unparseable young lock is respected (never stolen) → LOCK_HELD", async () => {
    writeFileSync(join(nonceDir, "mainnet-0xe0.json.lock"), "");
    await expect(allocateNonce("mainnet", "0xe0", async () => ({ anchor: 1n, currentBitmapIndex: 0 }), nonceDir))
      .rejects.toMatchObject({ structured: { code: "LOCK_HELD" } });
  }, 15_000);

  it("an old lock whose holder is still alive is respected → LOCK_HELD", async () => {
    const lock = join(nonceDir, "mainnet-0xa1.json.lock");
    writeFileSync(lock, `${process.pid}\n0\nlive`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await expect(allocateNonce("mainnet", "0xa1", async () => ({ anchor: 1n, currentBitmapIndex: 0 }), nonceDir))
      .rejects.toMatchObject({ structured: { code: "LOCK_HELD" } });
  }, 15_000);

  it("concurrent allocations in one process get distinct pairs", async () => {
    const remote = async () => ({ anchor: 2n, currentBitmapIndex: 0 });
    const slots = await Promise.all(Array.from({ length: 8 }, () => allocateNonce("mainnet", "0x123", remote, nonceDir)));
    expect(new Set(slots.map(s => `${s.anchor}:${s.bit}`)).size).toBe(8);
  });

  it("bitConsumed reads the bitmap only for the same anchor", () => {
    expect(bitConsumed({ anchor: 6n, bitmap: "0x5" }, { anchor: 6n, bit: 2 })).toBe(true);
    expect(bitConsumed({ anchor: 6n, bitmap: "0x5" }, { anchor: 6n, bit: 1 })).toBe(false);
    expect(bitConsumed({ anchor: 5n, bitmap: "0x5" }, { anchor: 6n, bit: 0 })).toBe(false);
    expect(bitConsumed({ anchor: 7n, bitmap: "0x5" }, { anchor: 6n, bit: 0 })).toBeNull();
  });
});

describe("client error classification", () => {
  const client = () => new RisexClient(MAINNET, { capacity: 100, refillPerSec: 100, weights: null }, "risex:test");

  it("4xx gRPC rejection on a write → ORDER_REJECTED (sent: false) with the decoded revert", async () => {
    fetchMock.mockResolvedValueOnce(err(400, "FailedPrecondition", "FailedPrecondition: PlaceOrder reverted: InvalidNonceIndex(uint8) => (208)"));
    const e = await client().post("/v1/orders/place", {}, "place order").catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.structured.details).toMatchObject({ sent: false, revert: "InvalidNonceIndex" });
    expect(revertNameOf("x reverted: SignerNotAuthorized(address) => (0x1)")).toBe("SignerNotAuthorized");
  });

  it("5xx / timeout / reset on a write → unknown outcome (never a rejection)", async () => {
    fetchMock.mockResolvedValueOnce(err(500, "Internal", "E0701 ChainTransactionFailed"));
    await expect(client().post("/v1/orders/place", {}, "place order")).rejects.toBeInstanceOf(RisexSendUnknown);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    await expect(client().post("/v1/orders/place", {}, "place order")).rejects.toBeInstanceOf(RisexSendUnknown);
  });

  it("no connection at all → not sent; 429 → RATE_LIMITED (sent: false)", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(client().post("/v1/orders/place", {}, "place order")).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE", details: { sent: false } } });
    fetchMock.mockResolvedValueOnce(err(429, "ResourceExhausted", "tx quota exceeded"));
    await expect(client().post("/v1/orders/place", {}, "place order")).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
  });

  it("reads: error envelope → EXCHANGE_ERROR / INVALID_PARAMS; missing data → EXCHANGE_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(err(400, "InvalidArgument", "time range is not valid"));
    await expect(client().get("/v1/x")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "r" }), { status: 200 }));
    await expect(client().get("/v1/x")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("public mapping", () => {
  it("excludes inactive / deprecated, flags reduce-only, classifies, hourly funding only for 1h interval", () => {
    const warn = vi.fn();
    const ms = toRisexVenueMarkets(MARKETS, warn);
    const by = Object.fromEntries(ms.map(m => [m.symbol, m]));
    expect(by.DOGE).toBeUndefined();
    expect(by.BTC).toMatchObject({ venueSymbol: "1", tickSize: "0.1", stepSize: "0.000001", minSize: "0.00015", maxLeverage: 25, fundingRate: "0.000014990672003283", markPrice: "83425.59225976700009225", tradable: true });
    expect(by.XAU).toMatchObject({ assetClass: "commodity", canonical: "GOLD" });
    expect(by.SPY.assetClass).toBe("etf");
    expect(by.SOXL.assetClass).toBe("etf");
    expect(by.NEW.tradable).toBe(false);
    expect(by.ODD.fundingRate).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not 1h"));
    const rates = toRisexFundingRates(MARKETS, ms);
    expect(rates.find(r => r.symbol === "BTC")).toMatchObject({ rate: "0.000014990672003283", basis: { kind: "perHours", hours: 1 }, nextFundingTime: 1791910800000 });
    expect(rates.find(r => r.symbol === "ODD")).toBeUndefined();
  });
});

// ── Adapter with mocked HTTP ──

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

function routeFetch(routes: Route[]): void {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    for (const r of routes) {
      const res = await r(url, init);
      if (res !== undefined) return res;
    }
    throw new Error(`unrouted ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
  });
}

const ACCOUNT = "0x938a104179a2D23DeC249A968ecd5B4F8B857cac";
const base: Route[] = [
  url => url.pathname === "/v1/markets" ? ok({ markets: MARKETS }) : undefined,
  url => url.pathname === "/v1/auth/eip712-domain" ? ok({ name: "RISEx", version: "1", chain_id: "4153", verifying_contract: RISEX_PINS.mainnet.auth }) : undefined,
  url => url.pathname === "/v1/system/config" ? ok(CFG) : undefined,
  url => url.pathname.startsWith("/v1/nonce-state/") ? ok({ nonce_anchor: "10", current_bitmap_index: 0, bitmap: "0x0" }) : undefined,
];

async function adapter(opts: { signer?: boolean; chain?: { isNonceUsed: () => Promise<boolean> }; quarantine?: (s: string) => void } = {}) {
  const signer = opts.signer === false ? null : await LocalEvmSigner.create(Wallet.createRandom().privateKey);
  return new RisexAdapter(getVenue("risex"), "mainnet", {
    account: ACCOUNT, signer, meta: null,
    noSignerReason: signer === null ? new PerpError("AGENT_NOT_REGISTERED", "no signer") : null,
    nonceDir, sleep: async () => undefined,
    chain: { hasPermission: async (_a: string, _s: string, p: number) => p === 2, isNonceUsed: opts.chain?.isNonceUsed ?? (async () => false), ...chainExtras(() => 0b00100) },
    quarantine: opts.quarantine ?? (() => undefined),
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("adapter: account reads (public by address)", () => {
  it("balance / positions from portfolio details; '0' liquidation price → null; funding sign: positive = received", async () => {
    routeFetch([...base,
      url => url.pathname === "/v1/portfolio/details" ? ok({
        summary: { total_account_value: "1000.5", free_collateral: "900", total_initial_margin: "100.5", total_unrealized_pnl: "-1.25" },
        positions: [
          { market_id: "1", size: "-0.5", avg_entry_price: "80000", mark_price: "83000", liquidation_price: "0", unrealized_pnl: "-1.25", leverage: "10", margin_mode: 0 },
          { market_id: "17", size: "0", avg_entry_price: "0", mark_price: "2400", liquidation_price: "0", unrealized_pnl: "0", leverage: "0", margin_mode: 0 },
        ],
      }) : undefined,
      url => url.pathname === "/v1/account/funding-payments" ? ok({ records: [
        { market_id: "1", funding_payment: "0.0074", block_time: "1791907200000000000", entry_type: "funding" },
        { market_id: "1", funding_payment: "-1.2889", block_time: "1791903600000000000", entry_type: "funding" },
      ] }) : undefined,
    ]);
    const a = await adapter({ signer: false });
    expect(await a.getBalance()).toEqual({ equity: "1000.5", available: "900", marginUsed: "100.5", unrealizedPnl: "-1.25" });
    const pos = await a.getPositions();
    expect(pos).toEqual([{ symbol: "BTC", side: "short", size: "0.5", entryPrice: "80000", markPrice: "83000", liquidationPrice: null, unrealizedPnl: "-1.25", leverage: 10, marginMode: "cross" }]);
    const fp = await a.getFundingPayments();
    expect(fp.map(p => p.payment)).toEqual(["-0.0074", "1.2889"]);
    expect(fp[0].time).toBe(1791907200000);
  });

  it("writes without a signer refuse before any request", async () => {
    const a = await adapter({ signer: false });
    await expect(a.cancelAllV2(null)).rejects.toMatchObject({ structured: { code: "AGENT_NOT_REGISTERED" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("adapter: placeOrder", () => {
  const req = (over: Record<string, unknown> = {}) => ({
    symbol: "BTC", side: "buy" as const, type: "limit" as const, size: "0.0002", price: "55024.8", triggerPrice: null, triggerSource: null,
    tif: "ALO" as const, reduceOnly: false, clientOrderId: "123456789", slippage: null, tpsl: null, ...over,
  });

  it("limit ALO: integer fields, post_only, client id, permit; resting order read back", async () => {
    let placed: Record<string, unknown> | null = null;
    routeFetch([...base,
      (url, init) => url.pathname === "/v1/orders/place" ? (placed = bodyOf(init), ok({ order_id: "0xabc", block_number: "24301441", filled_quantity: "" })) : undefined,
      url => url.pathname === "/v1/orders/by-id/0xabc" ? ok({ order: { id: "0xabc", price: "55024.8", size: "0.0002", market_id: "1", side: "BUY", type: "LIMIT", time_in_force: "GTC", post_only: true, reduce_only: false, filled_size: "0", status: "ORDER_STATUS_OPEN", avg_price: "0", client_order_id: "123456789", created_at: "1" } }) : undefined,
    ]);
    const a = await adapter();
    const r = await a.placeOrder(req());
    expect(placed).toMatchObject({ market_id: 1, size_steps: 200, price_ticks: 550248, side: 0, post_only: true, reduce_only: false, order_type: 1, time_in_force: 0, client_order_id: "123456789", builder_id: 0, ttl_units: 0, no_retry: true });
    const permit = (placed as unknown as { permit: Record<string, unknown> }).permit;
    expect(permit).toMatchObject({ account: ACCOUNT, nonce_anchor: "11", nonce_bitmap_index: 0 });
    expect(Buffer.from(String(permit.signature), "base64").length).toBe(65);
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "0xabc", clientOrderId: "123456789" });
  });

  it("market IOC: slippage-bounded protection price on the tick grid, WAD fill → filled", async () => {
    let placed: Record<string, unknown> | null = null;
    routeFetch([...base,
      (url, init) => url.pathname === "/v1/orders/place" ? (placed = bodyOf(init), ok({ order_id: "0xdef", block_number: "1", filled_quantity: "200000000000000" })) : undefined,
    ]);
    const a = await adapter();
    const r = await a.placeOrder(req({ type: "market", price: null, tif: null, clientOrderId: null, slippage: { bps: 100, source: "flag" } }));
    expect(placed).toMatchObject({ order_type: 1, time_in_force: 3, post_only: false }); // LIMIT IOC: the venue's MARKET type ignores the price (live testnet)
    // mark 83425.59… × 1.01 = 84259.85 → ceil to the 0.1 tick = 84259.9
    expect((placed as unknown as Record<string, unknown>).price_ticks).toBe(842599);
    expect(String((placed as unknown as Record<string, unknown>).client_order_id)).toMatch(/^[1-9]\d+$/);
    expect(r).toMatchObject({ status: "filled", filledSize: "0.0002", finality: "final" });
    expect(r.execution).toMatchObject({ method: "protectedIoc", protectionPrice: "84259.9", slippageBps: 100 });
  });

  it("the match band is checked on the tick-aligned price actually sent", async () => {
    // 199 bps fits the 2% band, but on a 1000-tick grid the aligned limit lands outside it.
    const coarse = MARKETS.map(m => m.market_id === "1" ? { ...m, mark_price: "83425.5", config: { ...m.config, step_price: "1000" } } : m);
    routeFetch([url => url.pathname === "/v1/markets" ? ok({ markets: coarse }) : undefined, ...base]);
    const a = await adapter();
    await expect(a.placeOrder(req({ type: "market", price: null, tif: null, size: "0.0002", slippage: { bps: 199, source: "flag" } })))
      .rejects.toThrow(/outside RISEx's match price band/);
  });

  it("malformed venue numbers are errors, never zero / unbounded", async () => {
    const badLev = MARKETS.map(m => m.market_id === "1" ? { ...m, config: { ...m.config, max_leverage: "abc" } } : m);
    routeFetch([url => url.pathname === "/v1/markets" ? ok({ markets: badLev }) : undefined, ...base]);
    await expect((await adapter()).applyLeverage("BTC", 5, null)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    routeFetch([...base, url => url.pathname === "/v1/account/position" ? ok({ position: { size: "", margin_mode: 0 } }) : undefined]);
    await expect((await adapter()).applyLeverage("BTC", 5, null)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    // An unknown margin_mode is an error, never "cross".
    routeFetch([...base, url => url.pathname === "/v1/account/position" ? ok({ position: { size: "0", margin_mode: 7 } }) : undefined]);
    await expect((await adapter()).applyLeverage("BTC", 5, "cross")).rejects.toThrow(/unknown margin_mode/);
    routeFetch([...base, url => url.pathname === "/v1/portfolio/details" ? ok({ summary: {}, positions: [{ market_id: "1", size: "1", avg_entry_price: "1", mark_price: "1", liquidation_price: "0", unrealized_pnl: "0", leverage: "1" }] }) : undefined]);
    await expect((await adapter({ signer: false })).getPositions()).rejects.toThrow(/unknown margin_mode/);
  });

  it("refusals before signing: wider than the match band, off-tick, below min, reduce-only market, stop orders", async () => {
    routeFetch(base);
    const a = await adapter();
    await expect(a.placeOrder(req({ type: "market", price: null, tif: null, slippage: { bps: 300, source: "flag" } }))).rejects.toThrow(/match price band/);
    await expect(a.placeOrder(req({ price: "55024.85" }))).rejects.toMatchObject({ structured: { code: "INVALID_TICK" } });
    await expect(a.placeOrder(req({ size: "0.0001" }))).rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
    await expect(a.placeOrder(req({ symbol: "NEW" }))).rejects.toThrow(/reduce-only mode/);
    await expect(a.stopOrder()).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    await expect(a.amendOrder({ symbol: "BTC", ref: { kind: "orderId", value: "x" }, price: "1", size: "1", tif: null })).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes("/v1/orders/place"))).toBe(false);
  });

  it("venue revert → ORDER_REJECTED with the decoded error; the nonce bit stays burned", async () => {
    routeFetch([...base,
      url => url.pathname === "/v1/orders/place" ? err(400, "FailedPrecondition", "FailedPrecondition: PlaceOrder reverted: SignerNotAuthorized(address) => (0x1)") : undefined,
    ]);
    const a = await adapter();
    await expect(a.placeOrder(req())).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED", details: { revert: "SignerNotAuthorized" } } });
    let placed: Record<string, unknown> | null = null;
    routeFetch([...base,
      (url, init) => url.pathname === "/v1/orders/place" ? (placed = bodyOf(init), ok({ order_id: "", block_number: "1", filled_quantity: "0" })) : undefined,
    ]);
    await a.placeOrder(req({ tif: "IOC" }));
    expect((placed as unknown as { permit: { nonce_bitmap_index: number } }).permit.nonce_bitmap_index).toBe(1);
  });

  it("unknown outcome, nonce not consumed → ORDER_PENDING (do NOT resubmit) + quarantine, never resent", async () => {
    let sends = 0;
    routeFetch([...base,
      url => url.pathname === "/v1/orders/place" ? (sends++, err(503, "Unavailable", "E0702 SequencerUnavailable")) : undefined,
    ]);
    const quarantine = vi.fn();
    const a = await adapter({ quarantine });
    const e = await a.placeOrder(req()).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.remediation).toMatch(/Do NOT resubmit/);
    expect(e.structured.details).toMatchObject({ clientOrderId: "123456789", nonceConsumed: false });
    expect(sends).toBe(1);
    expect(quarantine).toHaveBeenCalledWith("BTC", expect.stringContaining("c:123456789"), expect.any(String));
  });

  it("unknown outcome with the default quarantine: the quarantine file exists when the error is thrown", async () => {
    routeFetch([...base,
      url => url.pathname === "/v1/orders/place" ? err(503, "Unavailable", "E0702 SequencerUnavailable") : undefined,
    ]);
    const signer = await LocalEvmSigner.create(Wallet.createRandom().privateKey);
    const a = new RisexAdapter(getVenue("risex"), "mainnet", {
      account: ACCOUNT, signer, meta: null, noSignerReason: null, nonceDir, sleep: async () => undefined,
      chain: { hasPermission: async (_a: string, _s: string, p: number) => p === 2, isNonceUsed: async () => { throw new Error("rpc down"); }, ...chainExtras(() => 0b00100) },
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const e = await a.placeOrder(req({ clientOrderId: "424242" })).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.details).toMatchObject({ nonceConsumed: null, reconcileError: expect.stringContaining("rpc down") });
    const { QUARANTINE_FILE } = await import("../../bot/quarantine.js");
    expect(existsSync(QUARANTINE_FILE)).toBe(true);
    expect(readFileSync(QUARANTINE_FILE, "utf-8")).toContain("c:424242");
  });

  it("unknown outcome, nonce consumed and the client id found → reconciled final result", async () => {
    routeFetch([...base,
      url => url.pathname === "/v1/orders/place" ? err(504, "Unavailable", "gateway timeout") : undefined,
      url => url.pathname === "/v1/orders" ? ok({ orders: [{ id: "0xfeed", price: "55024.8", size: "0.0002", market_id: "1", side: "BUY", type: "LIMIT", time_in_force: "GTC", post_only: true, reduce_only: false, filled_size: "0", status: "ORDER_STATUS_OPEN", avg_price: "0", client_order_id: "123456789", created_at: "1" }] }) : undefined,
    ]);
    const quarantine = vi.fn();
    const a = await adapter({ chain: { isNonceUsed: async () => true }, quarantine });
    const r = await a.placeOrder(req());
    expect(r).toMatchObject({ status: "open", orderId: "0xfeed", clientOrderId: "123456789" });
    expect(r.execution.notes).toContain("reconciled");
    expect(quarantine).not.toHaveBeenCalled();
  });
});

describe("adapter: cancel / cancel-all / leverage", () => {
  const OPEN = [{ order_id: "0xa1", resting_order_id: "25769803884", market_id: 1, side: 0, size_steps: 200, price_ticks: 550248, order_type: 1, time_in_force: 0, post_only: true, reduce_only: false, client_order_id: "77" }];

  it("cancel by client id signs the resting order id; unknown outcome → pending, not failed", async () => {
    let body: Record<string, unknown> | null = null;
    routeFetch([...base,
      url => url.pathname === "/v1/orders/open" ? ok({ orders: OPEN }) : undefined,
      (url, init) => url.pathname === "/v1/orders/cancel" ? (body = bodyOf(init), ok({ tx_hash: "0x1", block_number: "1", success: true })) : undefined,
    ]);
    const a = await adapter();
    const r = await a.cancelByRef("BTC", { kind: "clientOrderId", value: "77" });
    expect(body).toMatchObject({ market_id: 1, order_id: "0xa1" });
    expect(r.cancelled).toEqual([{ kind: "orderId", value: "0xa1" }]);
    routeFetch([...base,
      url => url.pathname === "/v1/orders/open" ? ok({ orders: OPEN }) : undefined,
      url => url.pathname === "/v1/orders/cancel" ? err(500, "Internal", "E0701") : undefined,
    ]);
    const p = await a.cancelByRef("BTC", { kind: "orderId", value: "0xa1" });
    expect(p.cancelled).toEqual([]);
    expect(p.pending).toHaveLength(1);
    await expect(a.cancelByRef("BTC", { kind: "orderId", value: "0xnope" })).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
  });

  const byId = (status: string, filled = "0") => (url: URL) => url.pathname === "/v1/orders/by-id/0xa1"
    ? ok({ order: { id: "0xa1", price: "55024.8", size: "0.0002", market_id: "1", side: "BUY", type: "LIMIT", time_in_force: "GTC", post_only: true, reduce_only: false, filled_size: filled, status, avg_price: "0", client_order_id: "77", created_at: "1" } })
    : undefined;

  it("cancel-all per market; proven only when the order is gone afterwards AND cancelled by id", async () => {
    let lists = 0;
    routeFetch([...base,
      url => url.pathname === "/v1/orders/open" ? ok({ orders: lists++ === 0 ? OPEN : [] }) : undefined,
      url => url.pathname === "/v1/orders/cancel-all" ? ok({ tx_hash: "0x2", block_number: "2", success: true }) : undefined,
      byId("ORDER_STATUS_CANCELLED"),
    ]);
    const a = await adapter();
    const r = await a.cancelAllV2(null);
    expect(r.cancelled).toEqual([{ kind: "orderId", value: "0xa1" }]);
    expect(r.pending).toEqual([]);
  });

  it("cancel-all: the open list lagging the tx (live testnet) is re-read, not reported pending; a fill instead of a cancel → failed", async () => {
    let lists = 0;
    routeFetch([...base,
      // listed before + 3 lagging reads after the cancel-all, then gone
      url => url.pathname === "/v1/orders/open" ? ok({ orders: lists++ <= 3 ? OPEN : [] }) : undefined,
      url => url.pathname === "/v1/orders/cancel-all" ? ok({ tx_hash: "0x2", block_number: "2", success: true }) : undefined,
      byId("ORDER_STATUS_CANCELLED"),
    ]);
    const r = await (await adapter()).cancelAllV2(null);
    expect(r.cancelled).toEqual([{ kind: "orderId", value: "0xa1" }]);
    expect(r.pending).toEqual([]);

    lists = 0;
    routeFetch([...base,
      url => url.pathname === "/v1/orders/open" ? ok({ orders: lists++ === 0 ? OPEN : [] }) : undefined,
      url => url.pathname === "/v1/orders/cancel-all" ? ok({ tx_hash: "0x2", block_number: "2", success: true }) : undefined,
      byId("ORDER_STATUS_FILLED", "0.0002"),
    ]);
    const f = await (await adapter()).cancelAllV2(null);
    expect(f.cancelled).toEqual([]);
    expect(f.failed).toEqual([{ ref: { kind: "orderId", value: "0xa1" }, error: "left the open list filled (not cancelled)" }]);
  });

  it("margin-mode switch with an open position is refused before sending; leverage bounded by the market", async () => {
    routeFetch([...base,
      url => url.pathname === "/v1/account/position" ? ok({ position: { size: "0.1", margin_mode: 0 } }) : undefined,
      url => url.pathname === "/v1/account/leverage" ? ok({ transaction_hash: "0x3", block_number: "3", receipt: { status: 1 } }) : undefined,
    ]);
    const a = await adapter();
    await expect(a.applyLeverage("BTC", 5, "isolated")).rejects.toThrow(/position is open/);
    await expect(a.applyLeverage("BTC", 26, null)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    const r = await a.applyLeverage("BTC", 5, null);
    expect(r).toMatchObject({ leverage: 5, marginMode: "cross" });
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes("/v1/account/margin-mode"))).toHaveLength(0);
  });
});

describe("iocOutcomeOf (market orders are LIMIT IOC read back by id)", () => {
  const res = (status: string, method = "protectedIoc", finality = "final") => ({ venue: "risex", status, finality, filledSize: status === "filled" ? "0.1" : "0", execution: { method } });
  it("filled / cancelled are venue-final; partiallyFilled (possibly a lagging OPEN record), limits and pending reads are not", async () => {
    const a = await adapter();
    expect(a.iocOutcomeOf(res("filled"))).toEqual({ filledSize: "0.1", final: true });
    // Live testnet 2026-10-28: a close with no liquidity inside the bound — cancelled, nothing filled.
    expect(a.iocOutcomeOf(res("cancelled"))).toEqual({ filledSize: "0", final: true });
    expect(a.iocOutcomeOf(res("partiallyFilled"))).toBeNull();
    expect(a.iocOutcomeOf(res("cancelled", "limit"))).toBeNull();
    expect(a.iocOutcomeOf(res("cancelled", "protectedIoc", "pending"))).toBeNull();
    expect(a.iocOutcomeOf({ status: "ok" })).toBeNull();
  });
});

describe("trading-only proof (permission masks: 1 = all)", () => {
  /** Chain reader for a raw bitmap under the live mask model (mask(1) = every bit). */
  const chainFor = (bitmap: bigint, expiration = 2_000_000_000) => {
    const mask = (p: number) => (p === 1 ? 0xffffffffn : 1n << BigInt(p));
    return {
      hasPermission: async (_a: string, _s: string, p: number) => (bitmap & mask(p)) === mask(p), isNonceUsed: async () => false,
      ...chainExtras(() => 0), sessionKey: async () => ({ expiration, bitmap, status: 1 }),
    };
  };
  const S = "0x97Aff841E119524bC015BE9C062D4697FeE2a2A1";

  it("accepts the live restricted state 0xffffffe6 (bit 1 and bits 5–31 set, hasPermission {2})", async () => {
    await expect(assertTradingOnlyOnChain(chainFor(0xffffffe6n), "mainnet", ACCOUNT, S)).resolves.toMatchObject({ bitmap: 0xffffffe6n });
  });

  it("refuses a wiped bitmap (disable 1), a leftover bit 0 / 3 / 4, and an expired key", async () => {
    for (const bm of [0x0n, 0xffffffe7n, 0xffffffeen, 0xfffffff6n]) {
      await expect(assertTradingOnlyOnChain(chainFor(bm), "mainnet", ACCOUNT, S)).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    }
    await expect(assertTradingOnlyOnChain(chainFor(0xffffffe6n, 1_000), "mainnet", ACCOUNT, S)).rejects.toThrow(/expired/);
  });
});

describe("signer restriction (on-chain, trading-only)", () => {
  it("the SIGNER signs DisablePermission for every non-trading permission; final state proven", async () => {
    routeFetch(base);
    const signer = await LocalEvmSigner.create(Wallet.createRandom().privateKey);
    let low = 0x1f;
    const sent: Array<{ permission: number; signer: string }> = [];
    const r = await restrictSignerToTrading({
      client: new RisexClient(MAINNET, getVenue("risex").rateLimit, "risex:test"), network: "mainnet",
      ctx: { domain: DOMAIN, router: RISEX_PINS.mainnet.router, auth: RISEX_PINS.mainnet.auth },
      account: ACCOUNT, signer, nonceDir,
      chain: { hasPermission: async (_a, _s, p) => (low & maskOf(p)) === maskOf(p), isNonceUsed: async () => false, ...chainExtras(() => low) },
      send: async (permission, slot, signature) => {
        const rec = verifyTypedData({ ...DOMAIN, verifyingContract: getAddress(DOMAIN.verifyingContract) }, { DisablePermission: RISEX_TYPES.DisablePermission },
          { account: ACCOUNT, signer: signer.getAddress(), permission, nonceAnchor: slot.anchor, nonceBitmap: slot.bit }, signature);
        sent.push({ permission, signer: rec });
        low &= ~maskOf(permission);
        return `0xtx${permission}`;
      },
    });
    expect(sent.map(s => s.permission)).toEqual([0, 3, 4]); // never 1: the "all" mask would clear trading too
    expect(sent.every(s => s.signer === signer.getAddress())).toBe(true);
    expect(r.disabled.map(d => d.permission)).toEqual([0, 3, 4]);
    expect(low).toBe(0b00110);
  });

  it("a state that is not trading-only after the sends is a failure (never stored as restricted)", async () => {
    routeFetch(base);
    const signer = await LocalEvmSigner.create(Wallet.createRandom().privateKey);
    await expect(restrictSignerToTrading({
      client: new RisexClient(MAINNET, getVenue("risex").rateLimit, "risex:test"), network: "mainnet",
      ctx: { domain: DOMAIN, router: RISEX_PINS.mainnet.router, auth: RISEX_PINS.mainnet.auth },
      account: ACCOUNT, signer, nonceDir,
      chain: { hasPermission: async () => true, isNonceUsed: async () => false, ...chainExtras(() => 0b11111) },
      send: async () => "0xtx",
    })).rejects.toMatchObject({ structured: { code: "APPROVE_FAILED" } });
  });
});

describe("client order ids", () => {
  it("generated RISEx ids are uint64 decimals", () => {
    const id = newVenueClientOrderId(getVenue("risex"));
    expect(id).toMatch(/^[1-9]\d{0,19}$/);
    expect(BigInt(id) < 2n ** 64n).toBe(true);
  });
});

describe("CLI refusals (no I/O)", () => {
  type Env = { ok: boolean; error?: { code: string; message: string; remediation?: string } };
  const run = async (args: string[]): Promise<Env> => {
    const { buildProgram } = await import("../../cli-program.js");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation((m) => { out.push(String(m)); return true; });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw Object.assign(new Error("__exit__"), { exitCode: code }); }) as never);
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    try {
      await program.parseAsync(["node", "perp", "--json", ...args]);
    } catch (e) {
      if (e instanceof PerpError) return { ok: false, error: e.structured as never };
      if ((e as Error).message !== "__exit__") throw e;
    } finally {
      vi.restoreAllMocks();
      vi.stubGlobal("fetch", fetchMock);
    }
    return JSON.parse(out.join("").trim()) as Env;
  };

  for (const args of [
    ["funds", "deposit", "risex", "10"], ["--dry-run", "funds", "deposit", "risex", "10"],
    ["funds", "withdraw", "risex", "10"], ["--dry-run", "funds", "withdraw", "risex", "10", "--to", "0x0000000000000000000000000000000000000001"],
  ]) {
    it(`perp ${args.join(" ")} → CAPABILITY_UNSUPPORTED pointing to the RISEx app`, async () => {
      const env = await run(args);
      expect(env.ok).toBe(false);
      expect(env.error!.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(env.error!.remediation).toMatch(/app\.rise\.trade/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("wallet agent import risex is refused before reading any key (restricted signers only)", async () => {
    const env = await run(["wallet", "agent", "import", "risex"]);
    expect(env.error!.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(env.error!.remediation).toMatch(/wallet agent approve risex/);
  });

  it("funds faucet risex is refused on mainnet", async () => {
    const env = await run(["funds", "faucet", "risex"]);
    expect(env.error!.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
