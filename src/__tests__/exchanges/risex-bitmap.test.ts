/**
 * M1: trading-only is proven from the RAW sessionKeys bitmap (+ the pinned Authorization / Router /
 * AccountRegistry implementations, a "no permission id ≥5" probe and a per-id hasPermission
 * cross-check), at approve, at verify and before permits (re-checked after a TTL). Mocked chain
 * reader / HTTP; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// The RISEx trading code is shipped but switched off in 0.15.0 (read-only phase): enable it here.
vi.mock("../../exchanges/venues/risex-release.js", () => ({ RISEX_TRADING_ENABLED: true }));
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import "../../exchanges/venues/index.js";
import { getVenue } from "../../exchanges/venue.js";
import { PerpError } from "../../errors.js";
import { LocalEvmSigner } from "../../signer/evm-local.js";
import { assertTradingOnlyOnChain, decodeSessionKey, type RisexChainReader } from "../../exchanges/risex/session.js";
import { RISEX_PINS } from "../../exchanges/risex/typed-data.js";
import { RisexAdapter } from "../../exchanges/risex/adapter.js";
import { verifyRisexAgent } from "../../exchanges/risex/agent.js";
import type { RisexAgentMeta } from "../../settings.js";

const ACCOUNT = "0x938a104179a2D23DeC249A968ecd5B4F8B857cac";
const SIGNER = "0x00000000000000000000000000000000000000a1";

type ReaderOpts = {
  bitmap?: bigint; status?: number; impl?: string; routerImpl?: string; registry?: string; registryImpl?: string; id5?: boolean;
  /** hasPermission answers (default: derived from the bitmap). */
  has?: (p: number) => boolean;
};
function reader(o: ReaderOpts = {}): RisexChainReader & { reads: () => number } {
  let reads = 0;
  const pin = RISEX_PINS.mainnet;
  const impls: Record<string, string> = {
    [pin.auth.toLowerCase()]: o.impl ?? pin.authImplementation,
    [pin.router.toLowerCase()]: o.routerImpl ?? pin.routerImplementation,
    [pin.accountRegistry.toLowerCase()]: o.registryImpl ?? pin.accountRegistryImplementation,
  };
  return {
    reads: () => reads,
    hasPermission: async (_a, _s, p) => (o.has ? o.has(p) : (((o.bitmap ?? 0xffffffe4n) >> BigInt(p)) & 1n) === 1n),
    isNonceUsed: async () => false,
    sessionKey: async () => { reads++; return { expiration: 2_000_000_000, bitmap: o.bitmap ?? 0xffffffe4n, status: o.status ?? 1 }; },
    permissionIdExists: async () => o.id5 ?? false,
    implementationOf: async proxy => impls[proxy.toLowerCase()] as string,
    accountRegistry: async () => o.registry ?? pin.accountRegistry,
  };
}

describe("decodeSessionKey (layout recorded on mainnet: expiration, bitmap, status)", () => {
  it("decodes the 3-word return", () => {
    const raw = "0x000000000000000000000000000000000000000000000000000000006af66b1600000000000000000000000000000000000000000000000000000000ffffffff0000000000000000000000000000000000000000000000000000000000000001";
    expect(decodeSessionKey(raw)).toEqual({ expiration: 1794534166, bitmap: 0xffffffffn, status: 1 });
    expect(() => decodeSessionKey("0x01")).toThrow(PerpError);
  });
});

describe("assertTradingOnlyOnChain", () => {
  it("accepts ids 0..4 = {2} with bits 5–31 set (they map to no permission)", async () => {
    await expect(assertTradingOnlyOnChain(reader(), "mainnet", ACCOUNT, SIGNER)).resolves.toMatchObject({ bitmap: 0xffffffe4n });
  });
  it.each([
    ["a new (unrestricted) signer, bitmap 0xffffffff", { bitmap: 0xffffffffn }, /not trading-only/],
    ["trading bit off", { bitmap: 0xffffffe0n }, /not trading-only/],
    ["revoked signer", { status: 3 }, /status 3/],
    ["an upgraded Authorization implementation", { impl: "0x0000000000000000000000000000000000000bad" }, /upgraded/],
    ["a new permission id 5", { id5: true }, /permission id 5/],
    ["an upgraded router implementation", { routerImpl: "0x0000000000000000000000000000000000000bad" }, /router was upgraded/],
    ["a different account registry", { registry: "0x0000000000000000000000000000000000000bad" }, /account registry 0x/],
    ["an upgraded account registry implementation", { registryImpl: "0x0000000000000000000000000000000000000bad" }, /account registry was upgraded/],
    ["hasPermission disagreeing with the bitmap", { has: (p: number) => p === 2 || p === 4 }, /hasPermission disagrees/],
  ] as Array<[string, ReaderOpts, RegExp]>)("refuses %s → POLICY_DENIED", async (_n, o, re) => {
    const e = await assertTradingOnlyOnChain(reader(o), "mainnet", ACCOUNT, SIGNER).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.message).toMatch(re);
  });

  it("an upgrade refusal says cancels are refused too, where to manage orders, and how to revoke", async () => {
    const e = await assertTradingOnlyOnChain(reader({ routerImpl: "0x0000000000000000000000000000000000000bad" }), "mainnet", ACCOUNT, SIGNER).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.remediation).toMatch(/cancel and cancel-all/);
    expect(e.structured.remediation).toMatch(/app\.rise\.trade/);
    expect(e.structured.remediation).toMatch(/wallet agent revoke risex <name>/);
    expect(e.structured.remediation).toMatch(/Update perp-cli/);
  });
});

describe("verifyRisexAgent", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { status: 1 } }), { status: 200 }))));
  afterEach(() => vi.restoreAllMocks());
  const meta = { kind: "risex", agentName: "a", agentWalletName: "w", signerAddress: SIGNER, accountAddress: ACCOUNT, expiresAt: new Date(Date.now() + 1e9).toISOString(), permissions: { tradingOnly: true, disabled: [0, 3, 4], verifiedAt: "x" }, network: "mainnet", approvedAt: "x", source: "approved" } as RisexAgentMeta;

  it("trading-only bitmap → tradingOnly with the raw bitmap reported", async () => {
    expect(await verifyRisexAgent(meta, reader())).toMatchObject({ active: true, tradingOnly: true, bitmap: "0xffffffe4", reason: null });
  });
  it("a new permission id or an unrestricted bitmap → tradingOnly false with the reason", async () => {
    expect(await verifyRisexAgent(meta, reader({ id5: true }))).toMatchObject({ tradingOnly: false, reason: expect.stringMatching(/permission id 5/) });
    expect(await verifyRisexAgent(meta, reader({ bitmap: 0xffffffffn }))).toMatchObject({ tradingOnly: false, bitmap: "0xffffffff" });
  });
});

describe("adapter: proof once per session before the first permit", () => {
  let nonceDir: string;
  let posts: string[];
  beforeEach(() => {
    nonceDir = mkdtempSync(join(tmpdir(), "risex-bitmap-"));
    posts = [];
    const ok = (data: unknown) => new Response(JSON.stringify({ data, request_id: "r" }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
      const url = new URL(u);
      if (init?.method === "POST") posts.push(url.pathname);
      if (url.pathname === "/v1/markets") return ok({ markets: [{ market_id: "1", config: { name: "BTC/USDC", step_size: "0.000001", step_price: "0.1", max_leverage: "25", min_order_size: "0.00015", unlocked: true, match_price_band: "0.02" }, mark_price: "83000", funding_interval: "3600000000000", post_only: false, reduce_only: false, active: true, category: "crypto" }] });
      if (url.pathname === "/v1/auth/eip712-domain") return ok({ name: "RISEx", version: "1", chain_id: "4153", verifying_contract: RISEX_PINS.mainnet.auth });
      if (url.pathname === "/v1/system/config") return ok({ addresses: { router: RISEX_PINS.mainnet.router, auth: RISEX_PINS.mainnet.auth }, is_maintenance_mode: false });
      if (url.pathname.startsWith("/v1/nonce-state/")) return ok({ nonce_anchor: "1", current_bitmap_index: 0, bitmap: "0x0" });
      if (url.pathname === "/v1/orders/place") return ok({ order_id: "", block_number: "1", filled_quantity: "200000000000000" });
      throw new Error(`unrouted ${url.pathname}`);
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(nonceDir, { recursive: true, force: true }); });

  const order = { symbol: "BTC", side: "buy" as const, type: "limit" as const, size: "0.0002", price: "55024.8", triggerPrice: null, triggerSource: null, tif: "IOC" as const, reduceOnly: false, clientOrderId: "11", slippage: null, tpsl: null };
  const make = async (chain: RisexChainReader) => new RisexAdapter(getVenue("risex"), "mainnet", {
    account: ACCOUNT, signer: await LocalEvmSigner.create(Wallet.createRandom().privateKey), meta: null, noSignerReason: null, nonceDir, sleep: async () => undefined, chain, quarantine: () => undefined,
  });

  it("an unrestricted signer is refused before anything is signed or sent", async () => {
    const a = await make(reader({ bitmap: 0xffffffffn }));
    await expect(a.placeOrder(order)).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    expect(posts).toEqual([]);
  });

  it("the proof is re-checked after the TTL: a contract upgrade mid-session stops trading (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const o: ReaderOpts = {};
      const r = reader(o);
      const live: RisexChainReader = { ...r, implementationOf: async p => (o.impl !== undefined && p.toLowerCase() === RISEX_PINS.mainnet.auth.toLowerCase() ? o.impl : r.implementationOf(p)) };
      const a = await make(live);
      await a.placeOrder(order);
      vi.setSystemTime(Date.now() + 30_000);
      await a.placeOrder({ ...order, clientOrderId: "12" }); // within the TTL: no re-check
      expect(r.reads()).toBe(1);
      o.impl = "0x0000000000000000000000000000000000000bad"; // the Authorization is upgraded
      vi.setSystemTime(Date.now() + 61_000);
      await expect(a.placeOrder({ ...order, clientOrderId: "13" })).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
      expect(posts).toEqual(["/v1/orders/place", "/v1/orders/place"]);
      // A failed proof is not cached: once restored, the next action proves again and trades.
      o.impl = undefined;
      await a.placeOrder({ ...order, clientOrderId: "14" });
      expect(posts).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a trading-only signer is proven once, then orders flow", async () => {
    const r = reader();
    const a = await make(r);
    await a.placeOrder(order);
    await a.placeOrder({ ...order, clientOrderId: "12" });
    expect(posts).toEqual(["/v1/orders/place", "/v1/orders/place"]);
    expect(r.reads()).toBe(1);
  });
});
