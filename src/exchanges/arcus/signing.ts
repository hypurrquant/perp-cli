/**
 * Arcus request signing (docs.arcus.xyz/api-reference/authentication).
 *
 * Two Ed25519 schemes, both signed by the agent API key:
 * - Scheme 1 (typed payload): placeOrder / cancelOrder / modifyOrder and every
 *   element of batchPlaceOrders / batchCancelOrders. The signed bytes are a
 *   compact, key-sorted JSON object of engine-native integers:
 *     place  (op 1, op 4 = untriggered TPSL leg):
 *       {"ad","ai"[,"c"],"ct","g","m","op","p","q","r","s","t","v"}
 *     cancel (op 2): {"ad","ai"[,"c"],"ct"[,"id"],"m","op","v"}  (exactly one of id / c)
 *     modify (op 3): {"ad","ai"[,"c"],"ct","g"[,"id"],"m","op","p","q","r","s","t","v"}
 *       identity per ARCUS_MODIFY_SIGNED_IDENTITY (UNVERIFIED — see below)
 * - Scheme 2 (legacy message): cancelAllOrders, setLeverage (and, by the docs'
 *   "everything else" rule, scheduleCancel — unverified):
 *     ed25519(timestampNs + action + canonicalJson(body))
 *
 * Time units: `ct` and X-Timestamp are Unix NANOseconds;
 * signed `g` is NANOseconds; the request body `goodTilTime` is a MICROsecond
 * decimal string (g = goodTilTime × 1000).
 *
 * Master-wallet operations (createApiKey / revokeApiKey / withdraw / transfer)
 * are secp256k1 EIP-712 typed data; builders for those live at the bottom.
 */

import { PerpError } from "../../errors.js";

/** Raw Ed25519 detached signer (OWS agent wallet or tweetnacl). No prefixing. */
export type Ed25519SignFn = (message: Uint8Array) => Promise<Uint8Array>;

// ── Canonical JSON ──

/**
 * Compact JSON with keys sorted (recursively), no whitespace. `bigint` values
 * are emitted as unquoted integers (engine-native ticks / quantums / ns).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
      return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

// ── Scheme 1 enums ──

export const ARCUS_SIDE = { buy: 0, sell: 1 } as const;
/** Signed TIF codes: 0 GTT, 1 FOK, 2 IOC, 3 ALO. */
export const ARCUS_TIF_CODE = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 } as const;
export type ArcusTif = keyof typeof ARCUS_TIF_CODE;

export const ARCUS_OP = { place: 1, cancel: 2, modify: 3, placeUntriggered: 4, withdraw: 5 } as const;

/** Payload version (`v`). */
const PAYLOAD_VERSION = 1;

/** clientId charset per docs: [A-Za-z0-9_-], 1–36 chars. Signed verbatim. */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;

export function assertArcusClientId(c: string): void {
  if (!CLIENT_ID_RE.test(c)) {
    throw new PerpError("INVALID_PARAMS", `Arcus clientId "${c}" must match [A-Za-z0-9_-]{1,36}`);
  }
}

function lowerAddress(ad: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(ad)) throw new PerpError("INVALID_PARAMS", `Invalid Arcus master address "${ad}"`);
  return ad.toLowerCase();
}

// ── Scheme 1 payloads ──

export interface ArcusPlaceFields {
  /** Master EVM address (lowercased when signing). */
  address: string;
  accountIndex: number;
  clientId: string | null;
  /** X-Timestamp, ns. */
  ctNs: bigint;
  /** goodTilTime, ns (= body µs × 1000). */
  goodTilNs: bigint;
  marketId: number;
  /** price ÷ top-level market tickSize (exact). */
  priceTicks: bigint;
  /** size ÷ stepSize (exact). */
  quantums: bigint;
  reduceOnly: boolean;
  side: "buy" | "sell";
  tif: ArcusTif;
}

function placeLikeObject(op: number, f: ArcusPlaceFields, orderId: string | null): Record<string, unknown> {
  if (f.clientId !== null) assertArcusClientId(f.clientId);
  return {
    ad: lowerAddress(f.address),
    ai: f.accountIndex,
    c: f.clientId ?? undefined,          // omitted entirely when absent
    ct: f.ctNs,
    g: f.goodTilNs,
    id: orderId ?? undefined,
    m: f.marketId,
    op,
    p: f.priceTicks,
    q: f.quantums,
    r: f.reduceOnly ? 1 : 0,
    s: ARCUS_SIDE[f.side],
    t: ARCUS_TIF_CODE[f.tif],
    v: PAYLOAD_VERSION,
  };
}

/** op 1 (plain order) or op 4 (TPSL / untriggered leg inside a batch grouping). */
export function placePayload(f: ArcusPlaceFields, untriggered: boolean): string {
  return canonicalJson(placeLikeObject(untriggered ? ARCUS_OP.placeUntriggered : ARCUS_OP.place, f, null));
}

/**
 * Which order identity the signed modify payload (op 3) carries.
 *
 * UNVERIFIED — the Arcus docs contradict each other:
 *  - openapi.yml (info.description) and the modify-order page: modifyOrder payload
 *    `…"g":N,[,"id":"…"],"m":N…  (exactly one of id / c)` — the request body also takes
 *    exactly one of orderId / clientId;
 *  - authentication page: always `id`, plus `c` "only if the resting order was placed
 *    with a client id … the engine rejects a mismatch".
 * Default follows the openapi spec ("idOnly": sign `id`, never `c`; the body sends
 * orderId only). "idAndClientId" is the authentication-page variant. Settled by the "Arcus modify signature identity" testnet check.
 */
export type ArcusModifyIdentity = "idOnly" | "idAndClientId";
export const ARCUS_MODIFY_SIGNED_IDENTITY: ArcusModifyIdentity = "idOnly";

/** op 3. Signs `id`; echoes the resting order's `c` only in the "idAndClientId" variant. */
export function modifyPayload(f: ArcusPlaceFields, orderId: string, identity: ArcusModifyIdentity = ARCUS_MODIFY_SIGNED_IDENTITY): string {
  if (orderId.length === 0) throw new PerpError("INVALID_PARAMS", "Arcus modifyOrder requires the server orderId");
  const fields = identity === "idOnly" ? { ...f, clientId: null } : f;
  return canonicalJson(placeLikeObject(ARCUS_OP.modify, fields, orderId));
}

export interface ArcusCancelFields {
  address: string;
  accountIndex: number;
  ctNs: bigint;
  marketId: number;
  ref: { kind: "orderId"; value: string } | { kind: "clientOrderId"; value: string };
}

/** op 2 — exactly one of `id` (server order id) or `c` (client id). */
export function cancelPayload(f: ArcusCancelFields): string {
  if (f.ref.kind === "clientOrderId") assertArcusClientId(f.ref.value);
  return canonicalJson({
    ad: lowerAddress(f.address),
    ai: f.accountIndex,
    c: f.ref.kind === "clientOrderId" ? f.ref.value : undefined,
    ct: f.ctNs,
    id: f.ref.kind === "orderId" ? f.ref.value : undefined,
    m: f.marketId,
    op: ARCUS_OP.cancel,
    v: PAYLOAD_VERSION,
  });
}

/** op 5 — API-key withdraw (only for keys provisioned with the `withdraw` permission). */
export function withdrawPayload(f: { address: string; accountIndex: number; ctNs: bigint; nonce: string; amountQuantums: bigint }): string {
  return canonicalJson({
    ad: lowerAddress(f.address),
    ai: f.accountIndex,
    ct: f.ctNs,
    n: f.nonce,
    op: ARCUS_OP.withdraw,
    q: f.amountQuantums,
    v: PAYLOAD_VERSION,
  });
}

// ── Scheme 2 ──

/** `ts + action + canonicalJson(body)`, no delimiters. The same canonical body string must be sent as the HTTP body. */
export function scheme2Message(tsNs: bigint, action: string, canonicalBody: string): string {
  return `${tsNs.toString()}${action}${canonicalBody}`;
}

// ── Ed25519 helpers ──

export async function signUtf8Hex(sign: Ed25519SignFn, message: string): Promise<string> {
  const sig = await sign(new TextEncoder().encode(message));
  if (sig.length !== 64) {
    throw new PerpError("SIGNATURE_FAILED", `Arcus: Ed25519 signature must be 64 bytes (got ${sig.length})`);
  }
  return Buffer.from(sig).toString("hex");
}

let lastNs = 0n;

/**
 * Unix time in nanoseconds (ms × 1e6), strictly increasing within the process
 * so two requests in the same millisecond never share a `ct` replay slot.
 */
export function nowNs(): bigint {
  let t = BigInt(Date.now()) * 1_000_000n;
  if (t <= lastNs) t = lastNs + 1n;
  lastNs = t;
  return t;
}

// ── EIP-712 (master EVM wallet) ──

export type Eip712Types = Record<string, Array<{ name: string; type: string }>>;

export interface ArcusTypedData {
  domain: Record<string, unknown>;
  /** Contains ONLY the primary type (OwsEvmSigner takes the first key as primaryType). */
  types: Eip712Types;
  primaryType: string;
  message: Record<string, unknown>;
}

/** BridgeVault (withdraw / transfer verifyingContract) per signing chain id. */
export const ARCUS_BRIDGE_VAULT: Readonly<Record<number, `0x${string}`>> = {
  4663: "0x14b107cf534239c59571b066cb6497a321da897c",
  46630: "0x9a6d3499149fea853efe775a3577701539054eaf",
};

function bridgeVault(chainId: number): `0x${string}` {
  const v = ARCUS_BRIDGE_VAULT[chainId];
  if (!v) throw new PerpError("INVALID_PARAMS", `No Arcus BridgeVault known for chainId ${chainId}`);
  return v;
}

function apiKeyDomain(chainId: number): Record<string, unknown> {
  // No verifyingContract (docs: API keys are pure off-chain auth).
  return { name: "Arcus API Key", version: "1", chainId };
}

function assertApiKeyAccountIndex(i: number): void {
  if (!(Number.isInteger(i) && ((i >= 0 && i <= 9) || i === 255))) {
    throw new PerpError("INVALID_PARAMS", `Arcus API key accountIndex must be 0–9 or 255 (got ${i})`);
  }
}

function assertPubHex(h: string): void {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new PerpError("INVALID_PARAMS", `Arcus API key must be 64 lowercase hex chars`);
}

/**
 * createApiKey typed data. Always uses the accountIndex-bearing type (valid for
 * every index, mandatory for 1–9/255); with a nonce, the combined type.
 */
export function createApiKeyTypedData(p: {
  chainId: number; apiWalletName: string; publicKeyHex: string; validUntilMs: number; accountIndex: number; nonce: string | null;
}): ArcusTypedData {
  assertApiKeyAccountIndex(p.accountIndex);
  assertPubHex(p.publicKeyHex);
  const fields = [
    { name: "apiWalletName", type: "string" },
    { name: "apiWalletPublicKey", type: "string" },
    { name: "validUntil", type: "uint256" },
    ...(p.nonce !== null ? [{ name: "nonce", type: "string" }] : []),
    { name: "accountIndex", type: "uint8" },
  ];
  return {
    domain: apiKeyDomain(p.chainId),
    types: { CreateApiKey: fields },
    primaryType: "CreateApiKey",
    message: {
      apiWalletName: p.apiWalletName,
      apiWalletPublicKey: p.publicKeyHex,
      validUntil: p.validUntilMs,
      ...(p.nonce !== null ? { nonce: p.nonce } : {}),
      accountIndex: p.accountIndex,
    },
  };
}

/** revokeApiKey typed data (no validUntil). */
export function revokeApiKeyTypedData(p: {
  chainId: number; apiWalletName: string; publicKeyHex: string; accountIndex: number; nonce: string | null;
}): ArcusTypedData {
  assertApiKeyAccountIndex(p.accountIndex);
  assertPubHex(p.publicKeyHex);
  const fields = [
    { name: "apiWalletName", type: "string" },
    { name: "apiWalletPublicKey", type: "string" },
    ...(p.nonce !== null ? [{ name: "nonce", type: "string" }] : []),
    { name: "accountIndex", type: "uint8" },
  ];
  return {
    domain: apiKeyDomain(p.chainId),
    types: { RevokeApiKey: fields },
    primaryType: "RevokeApiKey",
    message: {
      apiWalletName: p.apiWalletName,
      apiWalletPublicKey: p.publicKeyHex,
      ...(p.nonce !== null ? { nonce: p.nonce } : {}),
      accountIndex: p.accountIndex,
    },
  };
}

/** Withdraw-to-self typed data. `amountQuantums`: quote quantums (1e9 = $1), sent as a decimal string. */
export function withdrawTypedData(p: {
  chainId: number; ethereumAddress: string; accountIndex: number; amountQuantums: bigint; nonce: string;
}): ArcusTypedData {
  return {
    domain: { name: "Arcus Withdraw", version: "1", chainId: p.chainId, verifyingContract: bridgeVault(p.chainId) },
    types: {
      Withdraw: [
        { name: "ethereumAddress", type: "address" },
        { name: "accountIndex", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "Withdraw",
    message: {
      ethereumAddress: p.ethereumAddress,
      accountIndex: p.accountIndex,
      amount: p.amountQuantums.toString(),
      nonce: p.nonce,
    },
  };
}

/** Internal subaccount transfer typed data. */
export function transferTypedData(p: {
  chainId: number; ethereumAddress: string; fromAccountIndex: number; toAccountIndex: number; amountQuantums: bigint; nonce: string;
}): ArcusTypedData {
  return {
    domain: { name: "Arcus Transfer", version: "1", chainId: p.chainId, verifyingContract: bridgeVault(p.chainId) },
    types: {
      Transfer: [
        { name: "ethereumAddress", type: "address" },
        { name: "fromAccountIndex", type: "uint8" },
        { name: "toAccountIndex", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "Transfer",
    message: {
      ethereumAddress: p.ethereumAddress,
      fromAccountIndex: p.fromAccountIndex,
      toAccountIndex: p.toAccountIndex,
      amount: p.amountQuantums.toString(),
      nonce: p.nonce,
    },
  };
}

/** Split a 65-byte 0x-hex signature into Arcus `{r, s, v}` with v ∈ {0x1b, 0x1c}. */
export function splitEvmSignature(sig: string): { r: string; s: string; v: string } {
  const hex = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (hex.length !== 130) {
    throw new PerpError("SIGNATURE_FAILED", `Arcus: expected a 65-byte EVM signature (got ${hex.length / 2} bytes)`);
  }
  let v = parseInt(hex.slice(128, 130), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw new PerpError("SIGNATURE_FAILED", `Arcus: unexpected signature v=${v}`);
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v: `0x${v.toString(16)}` };
}

/** 1 quote quantum = 1e-9 USDG. */
export const QUOTE_QUANTUM = "0.000000001";
