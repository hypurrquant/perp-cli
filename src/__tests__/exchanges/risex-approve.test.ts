/**
 * RISEx signer approve orchestration (approveRisexAgentWith) with a fake OWS vault, a fake chain
 * reader / sender and mocked HTTP — no network, no real wallet. Every exit that keeps a key records
 * its meta as NOT trading-only; every exit that can revoke does, and drops the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import "../../exchanges/venues/index.js";
import { getVenue } from "../../exchanges/venue.js";
import type { EvmSigner } from "../../signer/interface.js";
import type { RisexAgentMeta } from "../../settings.js";
import { RisexClient } from "../../exchanges/risex/client.js";
import { RISEX_PINS } from "../../exchanges/risex/typed-data.js";
import { approveRisexAgentWith, risexAgentWalletName, type RisexApproveDeps } from "../../exchanges/risex/agent.js";
import { PerpError } from "../../errors.js";

/** On-chain reader extras: the reviewed implementation, no permission id ≥5, a bitmap from `low` (bits 5–31 set, as on a new signer). */
const chainExtras = (low: () => number) => ({
  sessionKey: async () => ({ expiration: 2_000_000_000, bitmap: 0xffffffe0n | BigInt(low()), status: 1 }),
  permissionIdExists: async () => false,
  implementationOf: async (proxy: string) => ({ [RISEX_PINS.mainnet.auth.toLowerCase()]: RISEX_PINS.mainnet.authImplementation, [RISEX_PINS.mainnet.router.toLowerCase()]: RISEX_PINS.mainnet.routerImplementation, [RISEX_PINS.mainnet.accountRegistry.toLowerCase()]: RISEX_PINS.mainnet.accountRegistryImplementation } as Record<string, string>)[proxy.toLowerCase()] as string,
  accountRegistry: async () => RISEX_PINS.mainnet.accountRegistry,
});
/** The live permission model (Authorization bytecode 0x4252): mask(1) = every bit ("all"), else 1 << p. */
const maskOf = (p: number) => (p === 1 ? 0x1f : 1 << p);
const hasBits = (low: number, p: number) => (low & maskOf(p)) === maskOf(p);

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, request_id: "r" }), { status });
const err = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message }, request_id: "r" }), { status });

function walletSigner(): EvmSigner {
  const w = Wallet.createRandom();
  return { getAddress: () => w.address, signTypedData: (d, t, v) => w.signTypedData(d, t, v), signMessage: m => w.signMessage(m) };
}

type Over = { register?: () => Response; status?: number; statusRead?: () => Response; revoke?: () => Response };
let fetchMock: ReturnType<typeof vi.fn>;
let posts: string[];
function routes(o: Over = {}): void {
  posts = [];
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    if (init?.method === "POST") posts.push(url.pathname);
    switch (url.pathname) {
      case "/v1/auth/eip712-domain": return ok({ name: "RISEx", version: "1", chain_id: "4153", verifying_contract: RISEX_PINS.mainnet.auth });
      case "/v1/system/config": return ok({ addresses: { router: RISEX_PINS.mainnet.router, auth: RISEX_PINS.mainnet.auth }, is_maintenance_mode: false });
      case "/v1/auth/register-signer": return o.register ? o.register() : ok({ transaction_hash: "0xreg", success: true });
      case "/v1/auth/session-key-status": return o.statusRead ? o.statusRead() : ok({ status: o.status ?? 1 });
      case "/v1/auth/revoke-signer": return o.revoke ? o.revoke() : ok({ transaction_hash: "0xrev", success: true });
    }
    if (url.pathname.startsWith("/v1/nonce-state/")) return ok({ nonce_anchor: "3", current_bitmap_index: 0, bitmap: "0x0" });
    throw new Error(`unrouted ${url.pathname}`);
  });
}

let nonceDir: string;
let wallets: Set<string>;
let low: number;
let saved: RisexAgentMeta[];

function deps(o: { sendFails?: boolean; gasFails?: boolean } = {}): RisexApproveDeps & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    master: walletSigner(),
    ows: {
      walletExists: n => wallets.has(n),
      createSigner: n => { wallets.add(n); return walletSigner(); },
      deleteWallet: n => { wallets.delete(n); deleted.push(n); },
    },
    client: new RisexClient("https://api.rise.trade", getVenue("risex").rateLimit, "risex:approve-test"),
    chain: { hasPermission: async (_a, _s, p) => hasBits(low, p), isNonceUsed: async () => false, ...chainExtras(() => low) },
    sender: () => async (permission) => {
      if (o.sendFails) throw new PerpError("INSUFFICIENT_BALANCE", "no gas");
      low &= ~maskOf(permission);
      return `0xtx${permission}`;
    },
    assertGas: async () => { if (o.gasFails) throw new PerpError("INSUFFICIENT_BALANCE", "no RISE-chain ETH — nothing was registered"); },
    saveMeta: m => { saved.push(m); },
    sleep: async () => undefined,
    nonceDir,
  };
}

const OPTS = { agentName: "perp-cli-risex", masterOwsWallet: "main", passphrase: "", network: "mainnet" as const, expiresAt: new Date(Date.now() + 30 * 86_400_000) };
const WALLET = risexAgentWalletName("main", "mainnet");

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  nonceDir = mkdtempSync(join(tmpdir(), "risex-approve-"));
  wallets = new Set();
  low = 0x1f;
  saved = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(nonceDir, { recursive: true, force: true });
});

describe("approveRisexAgentWith", () => {
  it("success: registered, restricted on-chain, meta trading-only (persisted by the caller)", async () => {
    routes();
    const meta = await approveRisexAgentWith(OPTS, deps());
    expect(meta.permissions).toMatchObject({ tradingOnly: true, disabled: [0, 3, 4] });
    expect(posts).toEqual(["/v1/auth/register-signer"]);
    expect(wallets.has(WALLET)).toBe(true);
    expect(saved).toEqual([]);
  });

  it("permission 1 is the \"all\" mask (live testnet): only 0, 3, 4 are disabled → bits 4..0 = 0b00110, hasPermission {2}", async () => {
    routes();
    const d = deps();
    const sent: number[] = [];
    const inner = d.sender;
    d.sender = signer => { const send = inner(signer); return async (permission, slot, sig) => { sent.push(permission); return send(permission, slot, sig); }; };
    const meta = await approveRisexAgentWith(OPTS, d);
    expect(sent).toEqual([0, 3, 4]);
    expect(meta.permissions).toMatchObject({ tradingOnly: true });
    expect(low).toBe(0b00110);
    expect([0, 1, 2, 3, 4].filter(p => hasBits(low, p))).toEqual([2]);
  });

  it("an upgraded contract (pin mismatch) refuses in the pre-check, before anything is created or registered", async () => {
    routes();
    const d = deps();
    d.chain = { ...d.chain, implementationOf: async () => "0x0000000000000000000000000000000000000bad" };
    await expect(approveRisexAgentWith(OPTS, d)).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    expect(posts).toEqual([]);
    expect(wallets.size).toBe(0);
  });

  it("a new permission id ≥5 refuses in the pre-check", async () => {
    routes();
    const d = deps();
    d.chain = { ...d.chain, permissionIdExists: async () => true };
    await expect(approveRisexAgentWith(OPTS, d)).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    expect(posts).toEqual([]);
  });

  it("the gas pre-check refuses before anything is created or registered", async () => {
    routes();
    await expect(approveRisexAgentWith(OPTS, deps({ gasFails: true }))).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    expect(posts).toEqual([]);
    expect(wallets.size).toBe(0);
  });

  it("restriction failure → automatic revoke, key deleted, APPROVE_FAILED, nothing recorded", async () => {
    routes();
    const d = deps({ sendFails: true });
    await expect(approveRisexAgentWith(OPTS, d)).rejects.toMatchObject({ structured: { code: "APPROVE_FAILED" } });
    expect(posts).toEqual(["/v1/auth/register-signer", "/v1/auth/revoke-signer"]);
    expect(d.deleted).toEqual([WALLET]);
    expect(saved).toEqual([]);
  });

  it("restriction failure + revoke failure → APPROVE_PARTIAL, key kept and recorded as NOT trading-only", async () => {
    routes({ revoke: () => err(400, "FailedPrecondition", "revoke reverted") });
    const d = deps({ sendFails: true });
    const e = await approveRisexAgentWith(OPTS, d).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("APPROVE_PARTIAL");
    expect(e.structured.remediation).toMatch(/wallet agent revoke risex perp-cli-risex/);
    expect(wallets.has(WALLET)).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].permissions.tradingOnly).toBe(false);
  });

  it("not Active after polling → revoked and dropped (APPROVE_FAILED); revoke failure → APPROVE_PARTIAL + recorded", async () => {
    routes({ status: 0 });
    const d = deps();
    await expect(approveRisexAgentWith(OPTS, d)).rejects.toMatchObject({ structured: { code: "APPROVE_FAILED" } });
    expect(posts).toContain("/v1/auth/revoke-signer");
    expect(d.deleted).toEqual([WALLET]);
    expect(saved).toEqual([]);

    wallets.clear();
    routes({ status: 0, revoke: () => err(500, "Internal", "E0701") });
    await expect(approveRisexAgentWith(OPTS, deps())).rejects.toMatchObject({ structured: { code: "APPROVE_PARTIAL" } });
    expect(wallets.has(WALLET)).toBe(true);
    expect(saved[0].permissions.tradingOnly).toBe(false);
  });

  it("a failing status read after registration is treated as not Active: revoked + dropped, or kept + recorded", async () => {
    routes({ statusRead: () => err(503, "Unavailable", "upstream down") });
    const d = deps();
    const e = await approveRisexAgentWith(OPTS, d).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("APPROVE_FAILED");
    expect(e.message).toMatch(/could not be read/);
    expect(posts).toContain("/v1/auth/revoke-signer");
    expect(d.deleted).toEqual([WALLET]);
    expect(saved).toEqual([]);

    wallets.clear();
    routes({ statusRead: () => { throw new TypeError("fetch failed"); }, revoke: () => err(500, "Internal", "E0701") });
    await expect(approveRisexAgentWith(OPTS, deps())).rejects.toMatchObject({ structured: { code: "APPROVE_PARTIAL" } });
    expect(wallets.has(WALLET)).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].permissions.tradingOnly).toBe(false);
  });

  it("bits that stay set after the disable transactions (raw bitmap not trading-only) fail the approve → auto-revoke", async () => {
    routes();
    const d = deps();
    d.chain = { ...d.chain, ...chainExtras(() => 0b11111) };
    await expect(approveRisexAgentWith(OPTS, d)).rejects.toMatchObject({ structured: { code: "APPROVE_FAILED" } });
    expect(posts).toContain("/v1/auth/revoke-signer");
    expect(d.deleted).toEqual([WALLET]);
  });

  it("register outcome unknown → ORDER_PENDING, key kept and recorded (verify / revoke can see it)", async () => {
    routes({ register: () => err(503, "Unavailable", "E0702 SequencerUnavailable") });
    const e = await approveRisexAgentWith(OPTS, deps()).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.remediation).toMatch(/wallet agent verify risex perp-cli-risex/);
    expect(wallets.has(WALLET)).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "risex", agentName: "perp-cli-risex", permissions: { tradingOnly: false, verifiedAt: null } });
  });

  it("a definite register rejection drops the key and records nothing", async () => {
    routes({ register: () => err(400, "InvalidArgument", "bad signature") });
    const d = deps();
    await expect(approveRisexAgentWith(OPTS, d)).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
    expect(d.deleted).toEqual([WALLET]);
    expect(saved).toEqual([]);
  });
});
