/**
 * Aster V3 EIP-712 typed-data builders.
 *
 * Pure functions — no side effects, no fs/fetch/env reads.
 * All field ordering and serialization matches the HypurrQuant_FE mainnet
 * production reference: AsterPerpAdapter.ts:456-700.
 *
 * Key conventions:
 *   - Domain A (chainId=56)  — master-signed ops: approveAgent, delAgent, approveBuilder
 *   - Domain B (chainId=1666) — agent-signed per-order ops
 *   - uint256 fields serialized as decimal strings (never BigInt) to survive JSON.stringify
 *   - EIP-712 message keys are PascalCase; HTTP query-string keys are camelCase
 */

import { PerpError } from "../errors.js";

// ── Domain constants ──────────────────────────────────────────────────────────

/** Domain A: used for master-signed ops (ApproveAgent, DelAgent, ApproveBuilder). */
export const ASTER_DOMAIN_A = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 56,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

/** Domain B: used for agent-signed per-request ops (order, cancel, leverage). */
export const ASTER_DOMAIN_B = {
  ...ASTER_DOMAIN_A,
  chainId: 1666,
} as const;

/** Domain B (testnet): chainId=714 per Aster V3 testnet docs. */
export const ASTER_DOMAIN_B_TESTNET = {
  ...ASTER_DOMAIN_A,
  chainId: 714,
} as const;

/** Returns the Domain B object for the requested network (testnet branches chainId). */
export function getAsterDomainB(testnet: boolean): typeof ASTER_DOMAIN_B | typeof ASTER_DOMAIN_B_TESTNET {
  return testnet ? ASTER_DOMAIN_B_TESTNET : ASTER_DOMAIN_B;
}

/** EIP-712 types for Domain B order signing — single msg string (URL-encoded query string). */
export const ORDER_TYPES = {
  Message: [{ name: "msg", type: "string" }],
} as const;

// ── Type helpers ──────────────────────────────────────────────────────────────

type Eip712Field = { name: string; type: string };
type AsterChain = "Mainnet" | "Testnet";

// ── buildApproveAgentTypedData ────────────────────────────────────────────────

export interface ApproveAgentParams {
  user: `0x${string}`;
  agentAddress: `0x${string}`;
  agentName: string;
  /** Unix milliseconds timestamp when the agent expires. Serialized as decimal string. */
  expiredMs: number | string;
  canPerpTrade: boolean;
  canSpotTrade: boolean;
  canWithdraw: boolean;
  /**
   * Optional IP whitelist. Include (even as "") when defined and non-null.
   * Undefined/null = field omitted from EIP-712 struct.
   */
  ipWhitelist?: string;
  /** Optional builder address. When present, Builder + MaxFeeRate are included. */
  builder?: string;
  /** Required when builder is set. */
  maxFeeRate?: string;
  /** Optional builder name. Independently gated by its own undefined-check. */
  builderName?: string;
  /** Microsecond-precision nonce (Date.now() * 1000 + counter). Serialized as decimal string. */
  nonceMicros: number | string;
  asterChain: AsterChain;
}

/**
 * Build the EIP-712 typed-data payload for `POST /fapi/v3/approveAgent`.
 *
 * Field order in types array and message object matches HypurrQuant_FE
 * AsterPerpAdapter.ts:481-533 exactly:
 *   AgentName, AgentAddress, [IpWhitelist?,] Expired, CanSpotTrade, CanPerpTrade,
 *   CanWithdraw, [Builder?, MaxFeeRate?, BuilderName?,] AsterChain, User, Nonce
 */
export function buildApproveAgentTypedData(params: ApproveAgentParams): {
  domain: typeof ASTER_DOMAIN_A;
  types: { ApproveAgent: Eip712Field[] };
  primaryType: "ApproveAgent";
  message: Record<string, unknown>;
} {
  const ipWhitelistIncluded =
    params.ipWhitelist !== undefined && params.ipWhitelist !== null;
  const builderIncluded =
    params.builder !== undefined && params.builder !== null;

  // Build types array — insertion order must match message object order.
  const agentTypes: Eip712Field[] = [
    { name: "AgentName",    type: "string"  },
    { name: "AgentAddress", type: "string"  },
  ];
  if (ipWhitelistIncluded) {
    agentTypes.push({ name: "IpWhitelist", type: "string" });
  }
  agentTypes.push(
    { name: "Expired",      type: "uint256" },
    { name: "CanSpotTrade", type: "bool"    },
    { name: "CanPerpTrade", type: "bool"    },
    { name: "CanWithdraw",  type: "bool"    },
  );
  if (builderIncluded) {
    agentTypes.push({ name: "Builder",    type: "string" });
    agentTypes.push({ name: "MaxFeeRate", type: "string" });
    if (params.builderName !== undefined) {
      agentTypes.push({ name: "BuilderName", type: "string" });
    }
  }
  agentTypes.push(
    { name: "AsterChain", type: "string"  },
    { name: "User",       type: "string"  },
    { name: "Nonce",      type: "uint256" },
  );

  // Build message object — same insertion order as types array.
  const message: Record<string, unknown> = {
    AgentName:    params.agentName,
    AgentAddress: params.agentAddress,
  };
  if (ipWhitelistIncluded) {
    message["IpWhitelist"] = params.ipWhitelist;
  }
  // uint256 → decimal string (BigInt throws in JSON.stringify inside providers)
  message["Expired"]      = String(params.expiredMs);
  message["CanSpotTrade"] = params.canSpotTrade;
  message["CanPerpTrade"] = params.canPerpTrade;
  message["CanWithdraw"]  = params.canWithdraw;
  if (builderIncluded) {
    message["Builder"]    = params.builder;
    message["MaxFeeRate"] = params.maxFeeRate;
    if (params.builderName !== undefined) {
      message["BuilderName"] = params.builderName;
    }
  }
  message["AsterChain"] = params.asterChain;
  message["User"]       = params.user;
  message["Nonce"]      = String(params.nonceMicros);

  return {
    domain: ASTER_DOMAIN_A,
    types: { ApproveAgent: agentTypes },
    primaryType: "ApproveAgent",
    message,
  };
}

// ── buildDelAgentTypedData ────────────────────────────────────────────────────

export interface DelAgentParams {
  user: `0x${string}`;
  agentAddress: `0x${string}`;
  nonceMicros: number | string;
  asterChain: AsterChain;
}

/**
 * Build the EIP-712 typed-data payload for `DELETE /fapi/v3/agent`.
 *
 * OPEN ITEM (Aster DelAgent struct — mainnet verification): the
 * public Aster V3 docs (asterdex/api-docs, futures api v3 + testnet, checked 2026-10-02)
 * document no agent-delete endpoint or DelAgent struct, and HypurrQuant_FE has no
 * revoke method. This field set mirrors the ApproveAgent terminal fields (AgentAddress,
 * AsterChain, User, Nonce) without the permission booleans. It is only reachable on
 * mainnet (assertAgentApproveSupported refuses Aster agent management on testnet), and
 * revoke treats any non-confirming venue response as APPROVE_FAILED (assertAsterAgentDeleted),
 * so a wrong struct fails loudly instead of reporting a false revoke.
 */
export function buildDelAgentTypedData(params: DelAgentParams): {
  domain: typeof ASTER_DOMAIN_A;
  types: { DelAgent: Eip712Field[] };
  primaryType: "DelAgent";
  message: Record<string, unknown>;
} {
  const delTypes: Eip712Field[] = [
    { name: "AgentAddress", type: "string"  },
    { name: "AsterChain",   type: "string"  },
    { name: "User",         type: "string"  },
    { name: "Nonce",        type: "uint256" },
  ];

  const message: Record<string, unknown> = {
    AgentAddress: params.agentAddress,
    AsterChain:   params.asterChain,
    User:         params.user,
    Nonce:        String(params.nonceMicros),
  };

  return {
    domain: ASTER_DOMAIN_A,
    types: { DelAgent: delTypes },
    primaryType: "DelAgent",
    message,
  };
}

// ── buildOrderQueryStringMsg ──────────────────────────────────────────────────

/**
 * Encode order parameters as a URL-encoded query string.
 *
 * Deterministic key order = insertion order of `orderParams` (JS object property
 * iteration order). Caller must pre-populate `user` and `nonce` (microseconds)
 * in the dict; this function does NOT inject defaults.
 *
 * Uses `URLSearchParams` for encoding consistency with Python
 * `urllib.parse.urlencode`.
 */
export function buildOrderQueryStringMsg(
  orderParams: Record<string, string | number | boolean>,
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(orderParams)) {
    sp.append(key, String(value));
  }
  return sp.toString();
}

// ── buildOrderTypedData ───────────────────────────────────────────────────────

/**
 * Build the EIP-712 typed-data payload for agent-signed order requests.
 *
 * Domain B (chainId=1666 mainnet / 714 testnet), primaryType="Message",
 * single `msg` field containing the URL-encoded query string produced by
 * buildOrderQueryStringMsg.
 *
 * @param testnet When true, returns Domain B with chainId=714 per Aster V3
 *                testnet docs. Defaults to false (mainnet).
 */
export function buildOrderTypedData(
  orderParams: Record<string, string | number | boolean>,
  testnet = false,
): {
  domain: typeof ASTER_DOMAIN_B | typeof ASTER_DOMAIN_B_TESTNET;
  types: typeof ORDER_TYPES;
  primaryType: "Message";
  message: { msg: string };
} {
  const msg = buildOrderQueryStringMsg(orderParams);
  return {
    domain: getAsterDomainB(testnet),
    types: ORDER_TYPES,
    primaryType: "Message",
    message: { msg },
  };
}

// ── buildApproveBuilderTypedData ──────────────────────────────────────────────

export interface ApproveBuilderParams {
  builder: string;
  maxFeeRate: string;
  builderName?: string;
  user: `0x${string}`;
  nonceMicros: number | string;
  asterChain: AsterChain;
}

/**
 * Build the EIP-712 typed-data payload for `POST /fapi/v3/approveBuilder`.
 *
 * Domain A (chainId=56), primaryType="ApproveBuilder".
 * Default-path field order from HypurrQuant_FE AsterPerpAdapter.ts:630-651:
 *   Builder, MaxFeeRate, AsterChain, User, Nonce
 * `BuilderName` is a forward-compatible extension (HQ_FE omits it); included
 * only when explicitly provided so the default path stays byte-equivalent to
 * the production reference.
 *
 * Must be called BEFORE approveAgent so Aster fee attribution is set up
 * before the first order.
 */
export function buildApproveBuilderTypedData(params: ApproveBuilderParams): {
  domain: typeof ASTER_DOMAIN_A;
  types: { ApproveBuilder: Eip712Field[] };
  primaryType: "ApproveBuilder";
  message: Record<string, unknown>;
} {
  const builderTypes: Eip712Field[] = [
    { name: "Builder",    type: "string"  },
    { name: "MaxFeeRate", type: "string"  },
  ];
  if (params.builderName !== undefined) {
    builderTypes.push({ name: "BuilderName", type: "string" });
  }
  builderTypes.push(
    { name: "AsterChain", type: "string"  },
    { name: "User",       type: "string"  },
    { name: "Nonce",      type: "uint256" },
  );

  const message: Record<string, unknown> = {
    Builder:    params.builder,
    MaxFeeRate: params.maxFeeRate,
  };
  if (params.builderName !== undefined) {
    message["BuilderName"] = params.builderName;
  }
  message["AsterChain"] = params.asterChain;
  message["User"]       = params.user;
  message["Nonce"]      = String(params.nonceMicros);

  return {
    domain: ASTER_DOMAIN_A,
    types: { ApproveBuilder: builderTypes },
    primaryType: "ApproveBuilder",
    message,
  };
}

// ── buildDelBuilderTypedData ──────────────────────────────────────────────────

export interface DelBuilderParams {
  builder: string;
  user: `0x${string}`;
  nonceMicros: number | string;
  asterChain: AsterChain;
}

/**
 * EIP-712 payload for `DELETE /fapi/v3/builder` (revoke a builder approval).
 * Source: asterdex/api-docs demo/aster-code.py `delBuilder` — main-wallet signed,
 * primaryType "DelBuilder", fields = the request params with the first letter
 * upper-cased in insertion order: Builder, AsterChain, User, Nonce (Domain A).
 */
export function buildDelBuilderTypedData(params: DelBuilderParams): {
  domain: typeof ASTER_DOMAIN_A;
  types: { DelBuilder: Eip712Field[] };
  primaryType: "DelBuilder";
  message: Record<string, unknown>;
} {
  return {
    domain: ASTER_DOMAIN_A,
    types: {
      DelBuilder: [
        { name: "Builder",    type: "string"  },
        { name: "AsterChain", type: "string"  },
        { name: "User",       type: "string"  },
        { name: "Nonce",      type: "uint256" },
      ],
    },
    primaryType: "DelBuilder",
    message: { Builder: params.builder, AsterChain: params.asterChain, User: params.user, Nonce: String(params.nonceMicros) },
  };
}

// ── buildRegisterAndApproveAgentTypedData ─────────────────────────────────────

/** signatureChainId for an EVM `user` on POST /fapi/v3/registerAndApproveAgent (101 = Solana). */
export const ASTER_REGISTER_AGENT_EVM_CHAIN_ID = 56;

export interface RegisterAndApproveAgentParams {
  user: `0x${string}`;
  /** Microsecond timestamp; server tolerance ±10 s, never reused. */
  nonceMicros: number | string;
  agentName: string;
  agentAddress: `0x${string}`;
  /** Agent expiry, Unix milliseconds. */
  expiredMs: number | string;
  signatureChainId: number;
  canSpotTrade: boolean;
  canPerpTrade: boolean;
  canWithdraw: boolean;
  /** Space-delimited IPs / CIDRs; "" when none. Must be non-empty when canWithdraw. */
  ipWhitelist: string;
}

/**
 * EIP-712 payload for `POST /fapi/v3/registerAndApproveAgent` (asterdex/api-docs
 * eeddec8, V3 futures v3 + testnet, added 2026-05-12). Unauthenticated endpoint;
 * the user's wallet signs the literal (not URL-encoded) parameter string
 *   user=…&nonce=…&agentName=…&agentAddress=…&expired=…&signatureChainId=…&canSpotTrade=…&canPerpTrade=…&canWithdraw=…&ipWhitelist=…
 * wrapped as Message{msg} under domain AsterSignTransaction / v1 / chainId =
 * signatureChainId (56 for EVM) / zero verifyingContract. Unlike approveAgent
 * this carries no AsterChain field — the host selects the network.
 */
export function buildRegisterAndApproveAgentTypedData(params: RegisterAndApproveAgentParams): {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: typeof ORDER_TYPES;
  primaryType: "Message";
  message: { msg: string };
  /** Request parameters in signing order (the caller appends `signature`). */
  params: [string, string][];
} {
  if (params.canWithdraw && params.ipWhitelist.trim().length === 0) {
    throw new PerpError("INVALID_PARAMS", "Aster registerAndApproveAgent requires an IP whitelist when withdraw permission is granted", {
      remediation: "Pass --ip-whitelist \"<ip> <ip/cidr>\" (space-separated), or drop --can-withdraw",
    });
  }
  for (const [k, v] of [["agentName", params.agentName], ["ipWhitelist", params.ipWhitelist]] as const) {
    // The signed msg is a raw k=v&… string — a '&' or '=' inside a value would make it ambiguous.
    if (/[&=]/.test(v)) {
      throw new PerpError("INVALID_PARAMS", `Aster registerAndApproveAgent: ${k} must not contain '&' or '='`, {
        remediation: k === "agentName" ? "Choose an --agent-name without '&' or '='" : "Separate IP whitelist entries with spaces",
      });
    }
  }
  const entries: [string, string][] = [
    ["user", params.user],
    ["nonce", String(params.nonceMicros)],
    ["agentName", params.agentName],
    ["agentAddress", params.agentAddress],
    ["expired", String(params.expiredMs)],
    ["signatureChainId", String(params.signatureChainId)],
    ["canSpotTrade", String(params.canSpotTrade)],
    ["canPerpTrade", String(params.canPerpTrade)],
    ["canWithdraw", String(params.canWithdraw)],
    ["ipWhitelist", params.ipWhitelist],
  ];
  return {
    domain: {
      name: "AsterSignTransaction",
      version: "1",
      chainId: params.signatureChainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: ORDER_TYPES,
    primaryType: "Message",
    message: { msg: entries.map(([k, v]) => `${k}=${v}`).join("&") },
    params: entries,
  };
}

// ── buildWithdrawTypedData ────────────────────────────────────────────────────

/** EIP-712 types of the EVM withdraw signature (field names contain spaces — they are part of the type hash). */
export const ASTER_WITHDRAW_TYPES = {
  Action: [
    { name: "type", type: "string" },
    { name: "destination", type: "address" },
    { name: "destination Chain", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "fee", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "aster chain", type: "string" },
  ],
} as const;

export interface WithdrawTypedDataParams {
  /** Destination chain id — also the EIP-712 domain chainId (docs: "The chainId of the withdraw chain"). */
  chainId: number;
  /** `destination Chain` name: 1 → "ETH", 56 → "BSC", 42161 → "Arbitrum". */
  chainName: string;
  /** Receipt address — the account's own registered address. */
  receiver: string;
  /** Currency name, e.g. "USDT". */
  asset: string;
  /** Amount in token units, the SAME string sent as the `amount` request param. */
  amount: string;
  /** Fee in token units, the SAME string sent as the `fee` request param. */
  fee: string;
  /** ms timestamp × 1000, decimal string; sent as the `userNonce` request param. */
  userNonce: string;
}

/**
 * Master-signed EVM withdraw signature (`userSignature` of POST /fapi/v3/aster/user-withdraw).
 * Source: asterdex/api-docs demo/aster-deposit-withdrawal.md "EVM Withdraw Signature" and
 * asterdex/API-demo futures-v3-demo/58_withdrawEvm.js. Domain name "Aster" (NOT the
 * "AsterSignTransaction" API-auth domain); `aster chain` is the fixed string "Mainnet".
 */
export function buildWithdrawTypedData(p: WithdrawTypedDataParams): {
  domain: { name: "Aster"; version: "1"; chainId: number; verifyingContract: string };
  types: typeof ASTER_WITHDRAW_TYPES;
  primaryType: "Action";
  message: Record<string, string>;
} {
  return {
    domain: { name: "Aster", version: "1", chainId: p.chainId, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: ASTER_WITHDRAW_TYPES,
    primaryType: "Action",
    message: {
      "type": "Withdraw",
      "destination": p.receiver,
      "destination Chain": p.chainName,
      "token": p.asset,
      "amount": p.amount,
      "fee": p.fee,
      "nonce": p.userNonce,
      "aster chain": "Mainnet",
    },
  };
}
