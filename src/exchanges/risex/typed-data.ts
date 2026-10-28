/**
 * RISEx EIP-712 typed data, action hashes and order packing (developer.rise.trade "Integration",
 * checked by RISEx against the mainnet contracts on 2026-08-07).
 *
 * Every signature uses ONE domain: GET /v1/auth/eip712-domain (name "RISEx", version "1",
 * chainId, verifyingContract = the Authorization contract = system-config `addresses.auth`).
 * The permit `target` is the RISExUniversalRouter (`addresses.router`), never the auth contract.
 * Both are pinned per network below and cross-checked at runtime: a mismatch refuses to sign.
 *
 * Type strings are hashed literally (no spaces). Golden typehashes (read off the mainnet
 * Authorization contract) are asserted in tests.
 *
 * Signer permissions (Authorization contract, verified on mainnet 2026-10-14): `sessionKeys`
 * stores a permission bitmap (new signers: 0xffffffff = all); `hasPermission(account, signer, p)`
 * accepts p = 0..4. Every router action (place / cancel / cancel-all / leverage / margin) checks
 * permission 2 (`verifyWitnessSignature(…, permission = 2, …)`, traced on mainnet router txs) —
 * RISEX_TRADING_PERMISSION. perp-cli restricts a signer to trading-only by disabling every other
 * permission with a `DisablePermission` signed by the SIGNER itself (typehash below, matched against
 * the contract's DISABLE_PERMISSION_TYPEHASH(); a master-signed one reverts InvalidSignerSignature),
 * sent on-chain by the master. EnablePermission must be signed by the account, so a signer cannot
 * restore what it gave up (both checked by eth_call on testnet 2026-10-14). The calldata outcomes,
 * revert selectors, the permission-id map and the router traces are recorded in
 * src/__tests__/fixtures/risex/permissions-evidence.json (asserted by risex-evidence.test.ts). The
 * implementation source is not verified on the explorer, so permission NAMES are unknown.
 */

import { AbiCoder, Interface, Signature, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { PerpError } from "../../errors.js";
import type { EvmSigner } from "../../signer/interface.js";
import type { Network } from "../venue-types.js";
import { UINT24_MAX, UINT32_MAX, UINT64_MAX } from "./units.js";

// ── Pins ──

export interface RisexPins {
  chainId: number;
  /** Authorization contract = EIP-712 verifyingContract. */
  auth: string;
  /** RISExUniversalRouter = permit target. */
  router: string;
  /** JSON-RPC for the on-chain permission restriction / reads; null = none known. */
  rpcUrl: string | null;
  /**
   * EIP-1967 implementation of the Authorization proxy whose permission model was reviewed
   * (ids 0..4; ids ≥5 rejected by ABI enum decoding). An upgrade refuses trading until re-reviewed.
   */
  authImplementation: string;
  /** EIP-1967 implementation of the RISExUniversalRouter proxy (every permit-gated action). */
  routerImplementation: string;
  /** The account registry the Authorization contract reads (`getAccountRegistry()`; its getUserId is STATICCALLed by hasPermission / sessionKeys). */
  accountRegistry: string;
  /** EIP-1967 implementation of the account registry proxy. */
  accountRegistryImplementation: string;
}

/** Verified 2026-10-14 from GET /v1/system/config and /v1/auth/eip712-domain on each network. */
export const RISEX_PINS: Readonly<Record<Network, RisexPins>> = {
  mainnet: {
    chainId: 4153,
    auth: "0x0D919DAA3f12AE715744Eb648c00066c5DBd66f0",
    router: "0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e",
    rpcUrl: "https://rpc.risechain.com",
    // eth_getStorageAt(auth, EIP-1967 implementation slot), 2026-10-14.
    authImplementation: "0xCCCb0483342d77AbC4337f3e12514eC8E78b3e28",
    routerImplementation: "0xe2da7a94a81fe9ee58f70ebce862a176280092ae",
    accountRegistry: "0x1238991cac4e65902c08213e79909a9c813eebc3",
    accountRegistryImplementation: "0x531a0c7687cbaf02383b21443619487eb18b91e5",
  },
  testnet: {
    chainId: 11155931,
    auth: "0x6da86f486b5e6536358f5b122dbe184522ca0ee3",
    router: "0x980b8621b8e03c3f396e1dc34c00b14d84f2a20f",
    // eth_chainId 0xaa39db = 11155931 (verified); the testnet system config lists no RPC.
    rpcUrl: "https://testnet.riselabs.xyz",
    authImplementation: "0xc5b84461547eb5397a7c3fd067abfcbc24b53663",
    // Re-reviewed 2026-10-28 (bytecode; source unverified): upgrade of 2026-10-27 only adds three batch
    // place/cancel entries whose permits are checked with permission 2 (trading) on the same Authorization.
    routerImplementation: "0x91916671d82987b9b7a2aa01a3bf00ae878ef908",
    accountRegistry: "0xf733038054cfb47fa9da1a1d6e79be6fb61f0a70",
    accountRegistryImplementation: "0x99ccc05d52b69bd889a8ab4bc7c12b47aca94b58",
  },
};

export interface RisexDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** Check a fetched domain + router against the pins. Throws EXCHANGE_ERROR (nothing is signed). */
export function assertPinned(net: Network, domain: RisexDomain, router: string, auth: string): void {
  const pin = RISEX_PINS[net];
  const problems: string[] = [];
  if (domain.name !== "RISEx" || domain.version !== "1") problems.push(`domain ${domain.name}/${domain.version} (expected RISEx/1)`);
  if (domain.chainId !== pin.chainId) problems.push(`chainId ${domain.chainId} (pinned ${pin.chainId})`);
  if (domain.verifyingContract.toLowerCase() !== pin.auth.toLowerCase()) problems.push(`verifyingContract ${domain.verifyingContract} (pinned ${pin.auth})`);
  if (auth.toLowerCase() !== pin.auth.toLowerCase()) problems.push(`addresses.auth ${auth} (pinned ${pin.auth})`);
  if (router.toLowerCase() !== pin.router.toLowerCase()) problems.push(`addresses.router ${router} (pinned ${pin.router})`);
  if (problems.length > 0) {
    throw new PerpError("EXCHANGE_ERROR", `RISEx ${net} signing configuration changed: ${problems.join("; ")} — nothing was signed`, {
      exchange: "risex",
      remediation: "RISEx redeployed or changed its contracts. perp-cli refuses to sign against unpinned addresses; update perp-cli (RISEX_PINS)",
    });
  }
}

// ── Types ──

type Fields = Array<{ name: string; type: string }>;

export const RISEX_TYPES = {
  RegisterSigner: [
    { name: "account", type: "address" }, { name: "signer", type: "address" }, { name: "message", type: "string" },
    { name: "expiration", type: "uint32" }, { name: "nonceAnchor", type: "uint48" }, { name: "nonceBitmap", type: "uint8" },
  ] as Fields,
  VerifySigner: [
    { name: "account", type: "address" }, { name: "nonceAnchor", type: "uint48" }, { name: "nonceBitmap", type: "uint8" },
  ] as Fields,
  RevokeSigner: [
    { name: "account", type: "address" }, { name: "signer", type: "address" },
    { name: "nonceAnchor", type: "uint48" }, { name: "nonceBitmap", type: "uint8" },
  ] as Fields,
  VerifyWitness: [
    { name: "account", type: "address" }, { name: "target", type: "address" }, { name: "hash", type: "bytes32" },
    { name: "nonceAnchor", type: "uint48" }, { name: "nonceBitmap", type: "uint8" }, { name: "deadline", type: "uint32" },
  ] as Fields,
  DisablePermission: [
    { name: "account", type: "address" }, { name: "signer", type: "address" }, { name: "permission", type: "uint8" },
    { name: "nonceAnchor", type: "uint48" }, { name: "nonceBitmap", type: "uint8" },
  ] as Fields,
} as const;

export type RisexPrimaryType = keyof typeof RISEX_TYPES;

/** Canonical EIP-712 type string ("Name(type a,type b)"). */
export function typeString(primary: RisexPrimaryType): string {
  return `${primary}(${RISEX_TYPES[primary].map(f => `${f.type} ${f.name}`).join(",")})`;
}

export function typeHash(primary: RisexPrimaryType): string {
  return keccak256(toUtf8Bytes(typeString(primary)));
}

/** Read off the mainnet Authorization contract (docs "Verification" + eth_call 2026-10-14). */
export const RISEX_GOLDEN_TYPEHASHES: Readonly<Record<RisexPrimaryType, string>> = {
  RegisterSigner: "0xa526f63b3968e56ae1b177ce9b3dc29766e0891e6397a9c23cf8c53ee8fc8f62",
  VerifySigner: "0x4d298dcceb691695f582cc337308236426a0c97201a31834625e8eadc44d4230",
  RevokeSigner: "0x36db7f392f548b56f37d89469115d138685addf06be45684f9e5b0e8b5d28000",
  VerifyWitness: "0x055e6bcbf2ba5ff1c2ba5dc95b6648a5de6aaab3185251a34e3b88c11e116821",
  DisablePermission: "0xd0246e99c52bee7c7802e154da708a9795b727ad05cb8463639505c1baf0f897",
};

// ── Permissions ──

/** The permission every router action checks (place / cancel / cancel-all / leverage / margin). */
export const RISEX_TRADING_PERMISSION = 2;
/** EIP-1967 implementation slot (keccak256("eip1967.proxy.implementation") − 1). */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Permission ids are masks over the 32-bit `sessionKeys` bitmap (Authorization bytecode 0x4252,
 * identical on testnet and mainnet, codehash 0xa067268e…7381): mask(p) = 1 << p, except
 * mask(1) = 0xffffffff ("all"). hasPermission(p) = (bitmap & mask(p)) == mask(p);
 * disablePermission(p) clears mask(p) — so disabling 1 wipes every bit, trading included
 * (testnet 2026-10-28). A new signer holds 0xffffffff.
 *
 * Trading-only = bits 0, 3, 4 clear and bit 2 set. Bit 1 and bits 5–31 are no permission on
 * their own (every entry point takes p < 5 and goes through the mask) and stay set: the result
 * of the restriction is 0xffffffe6, where hasPermission(0..4) = {2} and "all" (1) is false.
 */
export const RISEX_PERMISSION_ALL = 1;
/** Bits that must be clear on a trading-only signer (ids 0, 3, 4). */
export const RISEX_FORBIDDEN_BITS = 0b11001n;
/** Bit of the trading permission (id 2). */
export const RISEX_TRADING_BIT = 1n << 2n;

/** Valid permission ids (hasPermission reverts above 4). */
export const RISEX_PERMISSION_IDS: readonly number[] = [0, 1, 2, 3, 4];
/** Permissions perp-cli disables right after registration: 0, 3, 4 — never 1 ("all": clears trading too). */
export const RISEX_NON_TRADING_PERMISSIONS: readonly number[] = RISEX_PERMISSION_IDS.filter(p => p !== RISEX_TRADING_PERMISSION && p !== RISEX_PERMISSION_ALL);

export const RISEX_AUTH_IFACE = new Interface([
  "function disablePermission(address account, address signer, uint48 nonceAnchor, uint8 nonceBitmap, uint8 permission, bytes signature)",
  "function hasPermission(address account, address signer, uint8 permission) view returns (bool)",
  "function getSessionKeyStatus(address account, address signer) view returns (uint8)",
]);

// ── Action hashes ──

const coder = AbiCoder.defaultAbiCoder();
const selector = (name: string) => keccak256(toUtf8Bytes(name));

export const ACTION = {
  PLACE_ORDER: "RISE_PERPS_PLACE_ORDER_V1",
  CANCEL_ORDER: "RISE_PERPS_CANCEL_ORDER_V1",
  CANCEL_ALL_ORDERS: "RISE_PERPS_CANCEL_ALL_ORDERS_V1",
  UPDATE_LEVERAGE: "RISE_PERPS_UPDATE_LEVERAGE_V1",
  UPDATE_MARGIN_MODE: "RISE_PERPS_UPDATE_MARGIN_MODE_V1",
} as const;

export const SIDE = { buy: 0, sell: 1 } as const;
export const ORDER_TYPE = { market: 0, limit: 1 } as const;
/** Venue TIF codes. ALO is GTC + post_only. */
export const TIF_CODE = { GTC: 0, GTT: 1, FOK: 2, IOC: 3 } as const;
export const STP_EXPIRE_MAKER = 0;
export const MARGIN_MODE_CODE = { cross: 0, isolated: 1 } as const;

export interface PackedOrderFields {
  marketId: number;
  sizeSteps: bigint;
  priceTicks: bigint;
  side: 0 | 1;
  postOnly: boolean;
  reduceOnly: boolean;
  stpMode: number;
  orderType: 0 | 1;
  tif: 0 | 1 | 2 | 3;
}

/** uint88 order word: [87:70] market, [69:38] size steps, [37:14] price ticks, [13:6] flags, [5:1] version 1. */
export function packOrder(o: PackedOrderFields): bigint {
  if (!Number.isInteger(o.marketId) || o.marketId < 0 || o.marketId > 0xffff) throw new PerpError("INVALID_PARAMS", `RISEx market id ${o.marketId} out of uint16 range`);
  if (o.sizeSteps <= 0n || o.sizeSteps > UINT32_MAX) throw new PerpError("INVALID_PARAMS", `RISEx size steps ${o.sizeSteps} out of uint32 range`);
  if (o.priceTicks < 0n || o.priceTicks > UINT24_MAX) throw new PerpError("INVALID_PARAMS", `RISEx price ticks ${o.priceTicks} out of uint24 range`);
  const flags = (o.side & 1) | ((o.postOnly ? 1 : 0) << 1) | ((o.reduceOnly ? 1 : 0) << 2)
    | ((o.stpMode & 3) << 3) | ((o.orderType & 1) << 5) | ((o.tif & 3) << 6);
  return (BigInt(o.marketId) << 70n) | (o.sizeSteps << 38n) | (o.priceTicks << 14n) | (BigInt(flags) << 6n) | (1n << 1n);
}

/** Inverse of packOrder (tests / diagnostics). */
export function unpackOrder(word: bigint): PackedOrderFields & { version: number } {
  const flags = Number((word >> 6n) & 0xffn);
  return {
    marketId: Number((word >> 70n) & 0xffffn),
    sizeSteps: (word >> 38n) & UINT32_MAX,
    priceTicks: (word >> 14n) & UINT24_MAX,
    side: (flags & 1) as 0 | 1,
    postOnly: ((flags >> 1) & 1) === 1,
    reduceOnly: ((flags >> 2) & 1) === 1,
    stpMode: (flags >> 3) & 3,
    orderType: ((flags >> 5) & 1) as 0 | 1,
    tif: ((flags >> 6) & 3) as 0 | 1 | 2 | 3,
    version: Number((word >> 1n) & 0x1fn),
  };
}

/** Header flags: 0x01 permit (always), 0x04 client order id present. Builder (0x02) / TTL (0x10) are never sent. */
export function headerFlags(clientOrderId: bigint): number {
  return 0x01 | (clientOrderId !== 0n ? 0x04 : 0);
}

/** keccak256(abi.encode(sel, uint8 header, uint88 order, uint16 builderId=0, uint64 clientOrderId, uint16 ttl=0)). */
export function placeOrderHash(order: bigint, clientOrderId: bigint): string {
  if (clientOrderId < 0n || clientOrderId > UINT64_MAX) throw new PerpError("INVALID_PARAMS", `RISEx client order id ${clientOrderId} out of uint64 range`);
  return keccak256(coder.encode(
    ["bytes32", "uint8", "uint256", "uint16", "uint64", "uint16"],
    [selector(ACTION.PLACE_ORDER), headerFlags(clientOrderId), order, 0, clientOrderId, 0],
  ));
}

export function cancelOrderHash(marketId: number, restingOrderId: bigint): string {
  return keccak256(coder.encode(["bytes32", "uint256", "uint256"], [selector(ACTION.CANCEL_ORDER), BigInt(marketId), restingOrderId]));
}

export function cancelAllHash(marketId: number): string {
  return keccak256(coder.encode(["bytes32", "uint256"], [selector(ACTION.CANCEL_ALL_ORDERS), BigInt(marketId)]));
}

export function leverageHash(marketId: number, leverage: number): string {
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 255) throw new PerpError("INVALID_PARAMS", `RISEx leverage must be an integer 1..255 (got ${leverage})`);
  return keccak256(coder.encode(["bytes32", "uint16", "uint8"], [selector(ACTION.UPDATE_LEVERAGE), marketId, leverage]));
}

export function marginModeHash(marketId: number, mode: 0 | 1): string {
  return keccak256(coder.encode(["bytes32", "uint16", "uint8"], [selector(ACTION.UPDATE_MARGIN_MODE), marketId, mode]));
}

// ── Signing ──

export interface NonceSlot { anchor: bigint; bit: number }

export interface RisexPermit {
  account: string;
  signer: string;
  nonce_anchor: string;
  nonce_bitmap_index: number;
  deadline: number;
  signature: string;
}

function domainOf(d: RisexDomain): Record<string, unknown> {
  return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: getAddress(d.verifyingContract) };
}

/** Sign typed data and verify it recovers `expected` (an OWS canonicalization slip never leaves this process). */
export async function signChecked(signer: EvmSigner, domain: RisexDomain, primary: RisexPrimaryType, message: Record<string, unknown>): Promise<string> {
  const types = { [primary]: RISEX_TYPES[primary] };
  const sig = await signer.signTypedData(domainOf(domain), types, message);
  const recovered = verifyTypedData(domainOf(domain), types, message, sig);
  if (recovered.toLowerCase() !== signer.getAddress().toLowerCase()) {
    throw new PerpError("SIGNATURE_FAILED", `RISEx ${primary} signature recovers ${recovered}, expected ${signer.getAddress()} — nothing was sent`, { exchange: "risex" });
  }
  return Signature.from(sig).serialized;
}

/** 65-byte r‖s‖v hex → base64 (the permit field is protobuf bytes). */
export function permitSignatureBase64(hexSig: string): string {
  const bytes = Buffer.from(hexSig.replace(/^0x/, ""), "hex");
  if (bytes.length !== 65) throw new PerpError("SIGNATURE_FAILED", `RISEx permit signature is ${bytes.length} bytes, expected 65`, { exchange: "risex" });
  return bytes.toString("base64");
}

/** The signer's VerifyWitness permit for one action hash. */
export async function signPermit(p: {
  signer: EvmSigner; account: string; router: string; domain: RisexDomain; actionHash: string; slot: NonceSlot; deadline: number;
}): Promise<RisexPermit> {
  if (p.slot.bit < 0 || p.slot.bit > 207) throw new PerpError("INVALID_PARAMS", `RISEx nonce bit ${p.slot.bit} out of 0..207`);
  const message = {
    account: getAddress(p.account), target: getAddress(p.router), hash: p.actionHash,
    nonceAnchor: p.slot.anchor, nonceBitmap: p.slot.bit, deadline: p.deadline,
  };
  const sig = await signChecked(p.signer, p.domain, "VerifyWitness", message);
  return {
    account: getAddress(p.account),
    signer: getAddress(p.signer.getAddress()),
    nonce_anchor: p.slot.anchor.toString(),
    nonce_bitmap_index: p.slot.bit,
    deadline: p.deadline,
    signature: permitSignatureBase64(sig),
  };
}
