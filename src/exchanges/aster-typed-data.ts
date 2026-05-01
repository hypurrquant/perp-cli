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
  asterChain?: AsterChain;
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
  message["AsterChain"] = params.asterChain ?? "Mainnet";
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
  asterChain?: AsterChain;
}

/**
 * Build the EIP-712 typed-data payload for `DELETE /fapi/v3/agent`.
 *
 * TODO: confirm DelAgent struct vs Aster docs at Step 0b spike.
 * HypurrQuant_FE does not implement a revoke/delAgent method — this is a
 * best-effort field set mirroring the ApproveAgent terminal fields (AgentAddress,
 * AsterChain, User, Nonce) without the permission booleans.
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
    AsterChain:   params.asterChain ?? "Mainnet",
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
  asterChain?: AsterChain;
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
  message["AsterChain"] = params.asterChain ?? "Mainnet";
  message["User"]       = params.user;
  message["Nonce"]      = String(params.nonceMicros);

  return {
    domain: ASTER_DOMAIN_A,
    types: { ApproveBuilder: builderTypes },
    primaryType: "ApproveBuilder",
    message,
  };
}
