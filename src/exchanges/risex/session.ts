/**
 * RISEx signing context: the EIP-712 domain, the permit target (router) and the maintenance flag,
 * fetched at runtime and checked against the per-network pins (typed-data.ts RISEX_PINS) before
 * anything is signed. Also the master / signer nonce allocation and on-chain permission reads.
 */

import { Interface, getAddress } from "ethers";
import { PerpError } from "../../errors.js";
import { assertRpcChainId, evmProvider } from "../../evm-master-tx.js";
import type { Network } from "../venue-types.js";
import type { RisexClient } from "./client.js";
import { allocateNonce, parseRemoteNonceState } from "./nonce.js";
import {
  assertPinned, EIP1967_IMPLEMENTATION_SLOT, RISEX_AUTH_IFACE, RISEX_FORBIDDEN_BITS, RISEX_PERMISSION_IDS, RISEX_PINS,
  RISEX_TRADING_BIT, RISEX_TRADING_PERMISSION, type NonceSlot, type RisexDomain,
} from "./typed-data.js";

export interface RisexSigningContext {
  domain: RisexDomain;
  router: string;
  auth: string;
}

interface SystemConfig {
  addresses?: { router?: unknown; auth?: unknown };
  is_maintenance_mode?: unknown;
  maintenance_message?: unknown;
  maintenance_end_time?: unknown;
}

/** Refuse writes during venue maintenance (system config `is_maintenance_mode`). */
export function assertNotMaintenance(cfg: SystemConfig): void {
  if (cfg.is_maintenance_mode === true) {
    const end = typeof cfg.maintenance_end_time === "string" && /^\d+$/.test(cfg.maintenance_end_time)
      ? new Date(Number(cfg.maintenance_end_time) * 1000).toISOString() : null;
    throw new PerpError("EXCHANGE_UNREACHABLE", `RISEx is in maintenance${typeof cfg.maintenance_message === "string" && cfg.maintenance_message !== "" ? `: ${cfg.maintenance_message}` : ""} — nothing was sent`, {
      exchange: "risex", sent: false, remediation: end !== null ? `Retry after ${end}` : "Retry after the maintenance window",
    });
  }
}

export async function loadSigningContext(client: RisexClient, net: Network): Promise<RisexSigningContext> {
  const [d, cfg] = await Promise.all([
    client.get<{ name?: unknown; version?: unknown; chain_id?: unknown; verifying_contract?: unknown }>("/v1/auth/eip712-domain"),
    client.get<SystemConfig>("/v1/system/config"),
  ]);
  if (typeof d.name !== "string" || typeof d.version !== "string" || typeof d.chain_id !== "string" || typeof d.verifying_contract !== "string") {
    throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/auth/eip712-domain: malformed response", { exchange: "risex" });
  }
  const router = cfg.addresses?.router;
  const auth = cfg.addresses?.auth;
  if (typeof router !== "string" || typeof auth !== "string") {
    throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/system/config: no addresses.router / addresses.auth", { exchange: "risex" });
  }
  const domain: RisexDomain = { name: d.name, version: d.version, chainId: Number(d.chain_id), verifyingContract: d.verifying_contract };
  assertPinned(net, domain, router, auth);
  assertNotMaintenance(cfg);
  return { domain, router, auth };
}

/** Allocate (and burn) the next nonce pair for `account` (see nonce.ts). */
export function allocateAccountNonce(client: RisexClient, net: Network, account: string, dir?: string): Promise<NonceSlot> {
  return allocateNonce(net, account, async () => parseRemoteNonceState(await client.get(`/v1/nonce-state/${account.toLowerCase()}`)), dir);
}

export interface RisexSessionKey {
  /** uint32 unix seconds (word 0). */
  expiration: number;
  /** Permission bitmap (word 1); a new signer has 0xffffffff. */
  bitmap: bigint;
  /** 1 = Active, 3 = Revoked (word 2). */
  status: number;
}

export interface RisexChainReader {
  hasPermission(account: string, signer: string, permission: number): Promise<boolean>;
  isNonceUsed(account: string, slot: NonceSlot): Promise<boolean>;
  /** Raw `sessionKeys(account, signer)` (selector 0x96ade1f9): three 32-byte words. */
  sessionKey(account: string, signer: string): Promise<RisexSessionKey>;
  /** Whether permission id `id` exists (hasPermission does not revert for it). RPC failures throw. */
  permissionIdExists(id: number): Promise<boolean>;
  /** EIP-1967 implementation address of `proxy`. */
  implementationOf(proxy: string): Promise<string>;
  /** Authorization.getAccountRegistry(). */
  accountRegistry(): Promise<string>;
}

/** Decode the 96-byte `sessionKeys` return (expiration, bitmap, status). */
export function decodeSessionKey(raw: string): RisexSessionKey {
  if (!/^0x[0-9a-fA-F]{192}$/.test(raw)) {
    throw new PerpError("EXCHANGE_ERROR", `RISEx sessionKeys returned ${raw.length} hex chars (expected 3 words)`, { exchange: "risex" });
  }
  const word = (k: number) => BigInt(`0x${raw.slice(2 + 64 * k, 66 + 64 * k)}`);
  return { expiration: Number(word(0)), bitmap: word(1), status: Number(word(2)) };
}

/** What to do when a pinned RISEx contract changed (F4): everything signed is refused until re-review. */
export function risexUpgradeRemediation(net: Network): string {
  const n = net === "testnet" ? " -n testnet" : "";
  return "Every signed RISEx action is refused through perp-cli until the new contract is reviewed — this includes cancel and cancel-all, which also go through a permit. " +
    "Manage open orders and positions in the RISEx app (app.rise.trade). If you do not trust the new implementation, revoke the signer: " +
    `perp${n} wallet agent revoke risex <name>. Update perp-cli once a release has reviewed the new implementation.`;
}

/**
 * The contracts perp-cli reviewed are still the ones deployed (read-only): the EIP-1967
 * implementations of the Authorization, the router and the account registry, the registry address
 * the Authorization reads, and no permission id ≥ 5. Any change → POLICY_DENIED (fail closed).
 * The RISEx admin can upgrade any of them; this is the detection, not a prevention.
 */
export async function assertReviewedContracts(chain: RisexChainReader, net: Network): Promise<void> {
  const pin = RISEX_PINS[net];
  const refuse = (what: string) => new PerpError("POLICY_DENIED", `RISEx ${what} — its permission model must be re-reviewed before perp-cli signs anything`, {
    exchange: "risex", remediation: risexUpgradeRemediation(net),
  });
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const [authImpl, routerImpl, registry] = await Promise.all([
    chain.implementationOf(pin.auth), chain.implementationOf(pin.router), chain.accountRegistry(),
  ]);
  if (!same(authImpl, pin.authImplementation)) throw refuse(`Authorization contract was upgraded (implementation ${authImpl}, reviewed ${pin.authImplementation})`);
  if (!same(routerImpl, pin.routerImplementation)) throw refuse(`router was upgraded (implementation ${routerImpl}, reviewed ${pin.routerImplementation})`);
  if (!same(registry, pin.accountRegistry)) throw refuse(`Authorization now reads account registry ${registry} (reviewed ${pin.accountRegistry})`);
  const registryImpl = await chain.implementationOf(pin.accountRegistry);
  if (!same(registryImpl, pin.accountRegistryImplementation)) throw refuse(`account registry was upgraded (implementation ${registryImpl}, reviewed ${pin.accountRegistryImplementation})`);
  if (await chain.permissionIdExists(RISEX_PERMISSION_IDS.length)) {
    throw refuse(`now has permission id ${RISEX_PERMISSION_IDS.length}: signers approved by perp-cli may hold it (their bitmap bits ≥5 are set)`);
  }
}

/**
 * Prove on chain that `signer` can only trade for `account` (read-only):
 *  1. assertReviewedContracts (pinned implementations of Authorization / router / account registry,
 *     no permission id ≥ 5) — bits 5–31 of the bitmap, which a new signer holds and which cannot be
 *     cleared, map to no permission while this holds;
 *  2. the signer is Active (raw status 1) and unexpired, and its raw bitmap has bits 0, 3, 4 clear
 *     and bit 2 set (permission masks: typed-data.ts — bit 1 alone is no permission);
 *  3. hasPermission(0..4) agrees ({2} only) — so the verdict does not rest on the bit mapping alone.
 * Throws POLICY_DENIED (never a default) when any check fails; RPC failures propagate.
 */
export async function assertTradingOnlyOnChain(chain: RisexChainReader, net: Network, account: string, signer: string): Promise<RisexSessionKey> {
  await assertReviewedContracts(chain, net);
  const sk = await chain.sessionKey(account, signer);
  const low = sk.bitmap & 0x1fn;
  const notTradingOnly = (why: string) => new PerpError("POLICY_DENIED", `RISEx signer ${signer} is not trading-only on chain (${why})`, {
    exchange: "risex", signer, bitmap: `0x${sk.bitmap.toString(16)}`, status: sk.status,
    remediation: "Revoke it (perp wallet agent revoke risex <name>) and approve a new signer",
  });
  if (sk.status !== 1 || (sk.bitmap & RISEX_FORBIDDEN_BITS) !== 0n || (sk.bitmap & RISEX_TRADING_BIT) === 0n) {
    throw notTradingOnly(`status ${sk.status}, permission bitmap 0x${sk.bitmap.toString(16)}, bits 4..0 = 0b${low.toString(2).padStart(5, "0")}, required bits 0, 3, 4 clear and bit 2 set`);
  }
  // hasPermission ignores the status and the expiration; the raw status 1 above does not either.
  if (!(sk.expiration > Math.floor(Date.now() / 1000))) throw notTradingOnly(`expired at ${new Date(sk.expiration * 1000).toISOString()}`);
  const per = await Promise.all(RISEX_PERMISSION_IDS.map(async id => [id, await chain.hasPermission(account, signer, id)] as const));
  const wrong = per.filter(([id, on]) => on !== (id === RISEX_TRADING_PERMISSION));
  if (wrong.length > 0) throw notTradingOnly(`hasPermission disagrees with the bitmap: ${wrong.map(([id, on]) => `${id}=${on}`).join(", ")}`);
  return sk;
}

const SESSION_KEYS_IFACE = new Interface(["function sessionKeys(address account, address signer) view returns (bytes32, bytes32, bytes32)"]);
const ZERO_ONE = "0x0000000000000000000000000000000000000001";
const ZERO_TWO = "0x0000000000000000000000000000000000000002";

const NONCE_IFACE_FN = "function isNonceUsed(address account, uint48 nonceAnchor, uint8 nonceBitmap) view returns (bool)";

/** Read-only on-chain reads against the pinned Authorization contract. */
export function chainReader(net: Network): RisexChainReader {
  const pin = RISEX_PINS[net];
  if (pin.rpcUrl === null) {
    throw new PerpError("NOT_IMPLEMENTED", `RISEx ${net} has no known RPC endpoint`, { exchange: "risex" });
  }
  const rpc = evmProvider(pin.rpcUrl, pin.chainId);
  const rpcUrl = pin.rpcUrl;
  // The RPC must serve the pinned chain before any answer from it is trusted (same check as the sender).
  let chainChecked: Promise<void> | null = null;
  const checked = () => (chainChecked ??= assertRpcChainId(rpc, rpcUrl, pin.chainId, "risex").catch(e => { chainChecked = null; throw e; }));
  return {
    async hasPermission(account, signer, permission) {
      if (!RISEX_PERMISSION_IDS.includes(permission)) throw new PerpError("INVALID_PARAMS", `RISEx permission ${permission} is not 0..4`);
      await checked();
      const raw = await rpc.call({ to: pin.auth, data: RISEX_AUTH_IFACE.encodeFunctionData("hasPermission", [account, signer, permission]) });
      return RISEX_AUTH_IFACE.decodeFunctionResult("hasPermission", raw)[0] as boolean;
    },
    async sessionKey(account, signer) {
      await checked();
      return decodeSessionKey(await rpc.call({ to: pin.auth, data: SESSION_KEYS_IFACE.encodeFunctionData("sessionKeys", [account, signer]) }));
    },
    async permissionIdExists(id) {
      await checked();
      try {
        await rpc.call({ to: pin.auth, data: RISEX_AUTH_IFACE.encodeFunctionData("hasPermission", [ZERO_ONE, ZERO_TWO, id]) });
        return true;
      } catch (e) {
        // A revert (enum decode of an unknown id) answers "no"; anything else is a failed read.
        if ((e as { code?: unknown }).code === "CALL_EXCEPTION") return false;
        throw e;
      }
    },
    async implementationOf(proxy) {
      await checked();
      const word = await rpc.getStorage(proxy, EIP1967_IMPLEMENTATION_SLOT);
      return getAddress(`0x${word.slice(-40)}`);
    },
    async accountRegistry() {
      await checked();
      const word = await rpc.call({ to: pin.auth, data: "0x0ab142ed" }); // getAccountRegistry()
      if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw new PerpError("EXCHANGE_ERROR", "RISEx getAccountRegistry(): malformed return", { exchange: "risex" });
      return getAddress(`0x${word.slice(-40)}`);
    },
    async isNonceUsed(account, slot) {
      await checked();
      const i = new Interface([NONCE_IFACE_FN]);
      const raw = await rpc.call({ to: pin.auth, data: i.encodeFunctionData("isNonceUsed", [account, slot.anchor, slot.bit]) });
      return i.decodeFunctionResult("isNonceUsed", raw)[0] as boolean;
    },
  };
}
