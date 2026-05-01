import { describe, it, expect } from "vitest";
import { TypedDataEncoder } from "ethers";
import {
  ASTER_DOMAIN_A,
  ASTER_DOMAIN_B,
  ASTER_DOMAIN_B_TESTNET,
  ORDER_TYPES,
  buildApproveAgentTypedData,
  buildDelAgentTypedData,
  buildOrderQueryStringMsg,
  buildOrderTypedData,
  buildApproveBuilderTypedData,
  getAsterDomainB,
} from "../../exchanges/aster-typed-data.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const USER = "0xabcdef1234567890abcdef1234567890abcdef12" as const;
const AGENT = "0x1234567890abcdef1234567890abcdef12345678" as const;
const BUILDER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const NONCE_MICROS = 1714234567890000;
const EXPIRED_MS = 1714234567890;

// ── Test 1: perp-only ApproveAgent ────────────────────────────────────────────

describe("buildApproveAgentTypedData — perp-only (no IpWhitelist, no Builder)", () => {
  const result = buildApproveAgentTypedData({
    user: USER,
    agentAddress: AGENT,
    agentName: "perp-cli-aster",
    expiredMs: EXPIRED_MS,
    canPerpTrade: true,
    canSpotTrade: false,
    canWithdraw: false,
    nonceMicros: NONCE_MICROS,
  });

  it("returns correct domain (ASTER_DOMAIN_A)", () => {
    expect(result.domain).toEqual(ASTER_DOMAIN_A);
  });

  it("primaryType is ApproveAgent", () => {
    expect(result.primaryType).toBe("ApproveAgent");
  });

  it("message.AgentName matches param", () => {
    expect(result.message["AgentName"]).toBe("perp-cli-aster");
  });

  it("message.User matches param", () => {
    expect(result.message["User"]).toBe(USER);
  });

  it("message.Expired is a string", () => {
    expect(typeof result.message["Expired"]).toBe("string");
    expect(result.message["Expired"]).toBe(String(EXPIRED_MS));
  });

  it("message.Nonce is a string", () => {
    expect(typeof result.message["Nonce"]).toBe("string");
    expect(result.message["Nonce"]).toBe(String(NONCE_MICROS));
  });

  it("no IpWhitelist in types when not provided", () => {
    const fieldNames = result.types.ApproveAgent.map((f) => f.name);
    expect(fieldNames).not.toContain("IpWhitelist");
  });

  it("no Builder fields in types when not provided", () => {
    const fieldNames = result.types.ApproveAgent.map((f) => f.name);
    expect(fieldNames).not.toContain("Builder");
    expect(fieldNames).not.toContain("MaxFeeRate");
    expect(fieldNames).not.toContain("BuilderName");
  });

  it("types and message are structurally consistent (field count)", () => {
    const typeFieldNames = result.types.ApproveAgent.map((f) => f.name);
    const messageKeys = Object.keys(result.message);
    expect(typeFieldNames).toEqual(messageKeys);
  });

  it("exact deep-equal fixture match", () => {
    expect(result).toEqual({
      domain: ASTER_DOMAIN_A,
      types: {
        ApproveAgent: [
          { name: "AgentName",    type: "string"  },
          { name: "AgentAddress", type: "string"  },
          { name: "Expired",      type: "uint256" },
          { name: "CanSpotTrade", type: "bool"    },
          { name: "CanPerpTrade", type: "bool"    },
          { name: "CanWithdraw",  type: "bool"    },
          { name: "AsterChain",   type: "string"  },
          { name: "User",         type: "string"  },
          { name: "Nonce",        type: "uint256" },
        ],
      },
      primaryType: "ApproveAgent",
      message: {
        AgentName:    "perp-cli-aster",
        AgentAddress: AGENT,
        Expired:      String(EXPIRED_MS),
        CanSpotTrade: false,
        CanPerpTrade: true,
        CanWithdraw:  false,
        AsterChain:   "Mainnet",
        User:         USER,
        Nonce:        String(NONCE_MICROS),
      },
    });
  });
});

// ── Test 2: ApproveAgent with empty-string IpWhitelist ───────────────────────

describe("buildApproveAgentTypedData — empty-string IpWhitelist", () => {
  const result = buildApproveAgentTypedData({
    user: USER,
    agentAddress: AGENT,
    agentName: "perp-cli-aster",
    expiredMs: EXPIRED_MS,
    canPerpTrade: true,
    canSpotTrade: false,
    canWithdraw: false,
    ipWhitelist: "",
    nonceMicros: NONCE_MICROS,
  });

  it("IpWhitelist field present in types array", () => {
    const ipField = result.types.ApproveAgent.find((f) => f.name === "IpWhitelist");
    expect(ipField).toEqual({ name: "IpWhitelist", type: "string" });
  });

  it("IpWhitelist is positioned between AgentAddress and Expired in types", () => {
    const names = result.types.ApproveAgent.map((f) => f.name);
    const agentAddrIdx = names.indexOf("AgentAddress");
    const ipIdx = names.indexOf("IpWhitelist");
    const expiredIdx = names.indexOf("Expired");
    expect(ipIdx).toBe(agentAddrIdx + 1);
    expect(expiredIdx).toBe(ipIdx + 1);
  });

  it("message.IpWhitelist is empty string", () => {
    expect(result.message["IpWhitelist"]).toBe("");
  });

  it("types and message keys are in sync", () => {
    const typeFieldNames = result.types.ApproveAgent.map((f) => f.name);
    const messageKeys = Object.keys(result.message);
    expect(typeFieldNames).toEqual(messageKeys);
  });
});

// ── Test 3: ApproveAgent with full Builder triple ─────────────────────────────

describe("buildApproveAgentTypedData — full Builder triple", () => {
  const result = buildApproveAgentTypedData({
    user: USER,
    agentAddress: AGENT,
    agentName: "perp-cli-aster",
    expiredMs: EXPIRED_MS,
    canPerpTrade: true,
    canSpotTrade: false,
    canWithdraw: false,
    builder: BUILDER,
    maxFeeRate: "0.0005",
    builderName: "HypurrQuant",
    nonceMicros: NONCE_MICROS,
  });

  it("Builder, MaxFeeRate, BuilderName present in types", () => {
    const names = result.types.ApproveAgent.map((f) => f.name);
    expect(names).toContain("Builder");
    expect(names).toContain("MaxFeeRate");
    expect(names).toContain("BuilderName");
  });

  it("Builder triple appears after CanWithdraw and before AsterChain", () => {
    const names = result.types.ApproveAgent.map((f) => f.name);
    const canWithdrawIdx = names.indexOf("CanWithdraw");
    const builderIdx = names.indexOf("Builder");
    const maxFeeRateIdx = names.indexOf("MaxFeeRate");
    const builderNameIdx = names.indexOf("BuilderName");
    const asterChainIdx = names.indexOf("AsterChain");
    expect(builderIdx).toBe(canWithdrawIdx + 1);
    expect(maxFeeRateIdx).toBe(builderIdx + 1);
    expect(builderNameIdx).toBe(maxFeeRateIdx + 1);
    expect(asterChainIdx).toBe(builderNameIdx + 1);
  });

  it("message contains all three Builder fields", () => {
    expect(result.message["Builder"]).toBe(BUILDER);
    expect(result.message["MaxFeeRate"]).toBe("0.0005");
    expect(result.message["BuilderName"]).toBe("HypurrQuant");
  });

  it("types and message keys are in sync", () => {
    const typeFieldNames = result.types.ApproveAgent.map((f) => f.name);
    const messageKeys = Object.keys(result.message);
    expect(typeFieldNames).toEqual(messageKeys);
  });

  it("Builder without BuilderName omits BuilderName", () => {
    const noBuilderName = buildApproveAgentTypedData({
      user: USER,
      agentAddress: AGENT,
      agentName: "perp-cli-aster",
      expiredMs: EXPIRED_MS,
      canPerpTrade: true,
      canSpotTrade: false,
      canWithdraw: false,
      builder: BUILDER,
      maxFeeRate: "0.0005",
      nonceMicros: NONCE_MICROS,
    });
    const names = noBuilderName.types.ApproveAgent.map((f) => f.name);
    expect(names).toContain("Builder");
    expect(names).toContain("MaxFeeRate");
    expect(names).not.toContain("BuilderName");
  });
});

// ── Test 4: buildDelAgentTypedData ────────────────────────────────────────────

describe("buildDelAgentTypedData", () => {
  const result = buildDelAgentTypedData({
    user: USER,
    agentAddress: AGENT,
    nonceMicros: NONCE_MICROS,
  });

  it("primaryType is DelAgent", () => {
    expect(result.primaryType).toBe("DelAgent");
  });

  it("domain is ASTER_DOMAIN_A (chainId 56)", () => {
    expect(result.domain).toEqual(ASTER_DOMAIN_A);
    expect(result.domain.chainId).toBe(56);
  });

  it("message contains AgentAddress", () => {
    expect(result.message["AgentAddress"]).toBe(AGENT);
  });

  it("message contains User", () => {
    expect(result.message["User"]).toBe(USER);
  });

  it("message contains Nonce as string", () => {
    expect(typeof result.message["Nonce"]).toBe("string");
    expect(result.message["Nonce"]).toBe(String(NONCE_MICROS));
  });

  it("message contains AsterChain defaulting to Mainnet", () => {
    expect(result.message["AsterChain"]).toBe("Mainnet");
  });

  it("Testnet asterChain is respected", () => {
    const testnet = buildDelAgentTypedData({
      user: USER,
      agentAddress: AGENT,
      nonceMicros: NONCE_MICROS,
      asterChain: "Testnet",
    });
    expect(testnet.message["AsterChain"]).toBe("Testnet");
  });
});

// ── Test 5: buildOrderQueryStringMsg ─────────────────────────────────────────

describe("buildOrderQueryStringMsg", () => {
  const orderParams = {
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: "0.01",
    user: USER,
    nonce: "1714234567890000",
  };

  const result = buildOrderQueryStringMsg(orderParams);

  it("result is a non-empty string", () => {
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("all keys round-trip through URLSearchParams", () => {
    const parsed = new URLSearchParams(result);
    expect(parsed.get("symbol")).toBe("BTCUSDT");
    expect(parsed.get("side")).toBe("BUY");
    expect(parsed.get("quantity")).toBe("0.01");
    expect(parsed.get("user")).toBe(USER);
    expect(parsed.get("nonce")).toBe("1714234567890000");
  });

  it("contains user= and nonce= in output", () => {
    expect(result).toContain("user=");
    expect(result).toContain("nonce=");
  });

  it("key ordering is insertion order (symbol before user before nonce)", () => {
    const symbolIdx = result.indexOf("symbol=");
    const userIdx = result.indexOf("user=");
    const nonceIdx = result.indexOf("nonce=");
    expect(symbolIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(nonceIdx);
  });

  it("numeric values are stringified", () => {
    const withNumber = buildOrderQueryStringMsg({ price: 50000, user: USER, nonce: 123456 });
    const parsed = new URLSearchParams(withNumber);
    expect(parsed.get("price")).toBe("50000");
  });

  it("boolean values are stringified", () => {
    const withBool = buildOrderQueryStringMsg({ reduceOnly: true, user: USER, nonce: 123456 });
    const parsed = new URLSearchParams(withBool);
    expect(parsed.get("reduceOnly")).toBe("true");
  });
});

// ── Test 6: buildOrderTypedData ───────────────────────────────────────────────

describe("buildOrderTypedData", () => {
  const orderParams = {
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: "0.01",
    user: USER,
    nonce: "1714234567890000",
  };

  const result = buildOrderTypedData(orderParams);

  it("domain.chainId is 1666 (ASTER_DOMAIN_B)", () => {
    expect(result.domain.chainId).toBe(1666);
    expect(result.domain).toEqual(ASTER_DOMAIN_B);
  });

  it("primaryType is Message", () => {
    expect(result.primaryType).toBe("Message");
  });

  it("types equals ORDER_TYPES", () => {
    expect(result.types).toEqual(ORDER_TYPES);
  });

  it("message.msg is a string", () => {
    expect(typeof result.message.msg).toBe("string");
  });

  it("message.msg contains user= and nonce=", () => {
    expect(result.message.msg).toContain("user=");
    expect(result.message.msg).toContain("nonce=");
  });

  it("message.msg is the URL-encoded query string", () => {
    const expected = buildOrderQueryStringMsg(orderParams);
    expect(result.message.msg).toBe(expected);
  });
});

// ── Test 7: buildApproveBuilderTypedData ──────────────────────────────────────

describe("buildApproveBuilderTypedData", () => {
  const result = buildApproveBuilderTypedData({
    builder: BUILDER,
    maxFeeRate: "0.0005",
    user: USER,
    nonceMicros: NONCE_MICROS,
  });

  it("primaryType is ApproveBuilder", () => {
    expect(result.primaryType).toBe("ApproveBuilder");
  });

  it("domain is ASTER_DOMAIN_A (chainId 56)", () => {
    expect(result.domain).toEqual(ASTER_DOMAIN_A);
  });

  it("types contains Builder, MaxFeeRate, AsterChain, User, Nonce in order", () => {
    const names = result.types.ApproveBuilder.map((f) => f.name);
    expect(names).toEqual(["Builder", "MaxFeeRate", "AsterChain", "User", "Nonce"]);
  });

  it("message.Builder matches param", () => {
    expect(result.message["Builder"]).toBe(BUILDER);
  });

  it("message.MaxFeeRate matches param", () => {
    expect(result.message["MaxFeeRate"]).toBe("0.0005");
  });

  it("message.AsterChain defaults to Mainnet", () => {
    expect(result.message["AsterChain"]).toBe("Mainnet");
  });

  it("message.Nonce is a decimal string", () => {
    expect(typeof result.message["Nonce"]).toBe("string");
    expect(result.message["Nonce"]).toBe(String(NONCE_MICROS));
  });

  it("BuilderName included when provided", () => {
    const withName = buildApproveBuilderTypedData({
      builder: BUILDER,
      maxFeeRate: "0.0005",
      builderName: "HypurrQuant",
      user: USER,
      nonceMicros: NONCE_MICROS,
    });
    const names = withName.types.ApproveBuilder.map((f) => f.name);
    expect(names).toEqual(["Builder", "MaxFeeRate", "BuilderName", "AsterChain", "User", "Nonce"]);
    expect(withName.message["BuilderName"]).toBe("HypurrQuant");
  });

  it("types and message keys are in sync", () => {
    const typeFieldNames = result.types.ApproveBuilder.map((f) => f.name);
    const messageKeys = Object.keys(result.message);
    expect(typeFieldNames).toEqual(messageKeys);
  });
});

// ── Test 8: uint256-decimal-string regression ─────────────────────────────────

describe("uint256 decimal-string regression (BigInt guard)", () => {
  const result = buildApproveAgentTypedData({
    user: USER,
    agentAddress: AGENT,
    agentName: "perp-cli-aster",
    expiredMs: 1714234567890,   // number
    canPerpTrade: true,
    canSpotTrade: false,
    canWithdraw: false,
    nonceMicros: 1714234567890000,  // number
  });

  it("Expired is typeof string in message", () => {
    expect(typeof result.message["Expired"]).toBe("string");
  });

  it("Nonce is typeof string in message", () => {
    expect(typeof result.message["Nonce"]).toBe("string");
  });

  it("JSON.stringify does not throw (BigInt regression guard)", () => {
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("Expired value is correct decimal string", () => {
    expect(result.message["Expired"]).toBe("1714234567890");
  });

  it("Nonce value is correct decimal string", () => {
    expect(result.message["Nonce"]).toBe("1714234567890000");
  });
});

// ── Test 9: chainId differentiation ──────────────────────────────────────────

describe("chainId differentiation between ASTER_DOMAIN_A and ASTER_DOMAIN_B", () => {
  it("ASTER_DOMAIN_A.chainId is 56", () => {
    expect(ASTER_DOMAIN_A.chainId).toBe(56);
  });

  it("ASTER_DOMAIN_B.chainId is 1666", () => {
    expect(ASTER_DOMAIN_B.chainId).toBe(1666);
  });

  it("chainIds are different", () => {
    expect(ASTER_DOMAIN_A.chainId).not.toBe(ASTER_DOMAIN_B.chainId);
  });

  it("verifyingContract is identical between domains (40-zero address)", () => {
    expect(ASTER_DOMAIN_A.verifyingContract).toBe(ASTER_DOMAIN_B.verifyingContract);
    expect(ASTER_DOMAIN_A.verifyingContract).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    // Exactly 40 hex chars after 0x
    expect(ASTER_DOMAIN_A.verifyingContract.slice(2)).toHaveLength(40);
  });

  it("name and version are identical between domains", () => {
    expect(ASTER_DOMAIN_A.name).toBe(ASTER_DOMAIN_B.name);
    expect(ASTER_DOMAIN_A.version).toBe(ASTER_DOMAIN_B.version);
  });
});

// ── Test 10: EIP-712 hash equivalence (ethers TypedDataEncoder) ───────────────

describe("EIP-712 hash equivalence via ethers TypedDataEncoder", () => {
  const params = {
    user: USER,
    agentAddress: AGENT,
    agentName: "perp-cli-aster",
    expiredMs: EXPIRED_MS,
    canPerpTrade: true,
    canSpotTrade: false,
    canWithdraw: false,
    nonceMicros: NONCE_MICROS,
  };

  const { domain, types, message } = buildApproveAgentTypedData(params);

  it("TypedDataEncoder.hash returns a 0x-prefixed 66-char string", () => {
    const hash = TypedDataEncoder.hash(domain, types, message);
    expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(hash).toHaveLength(66);
  });

  it("hash is deterministic (same inputs → same output)", () => {
    const hash1 = TypedDataEncoder.hash(domain, types, message);
    const hash2 = TypedDataEncoder.hash(domain, types, message);
    expect(hash1).toBe(hash2);
  });

  it("different nonce → different hash", () => {
    const { domain: d2, types: t2, message: m2 } = buildApproveAgentTypedData({
      ...params,
      nonceMicros: NONCE_MICROS + 1,
    });
    const hash1 = TypedDataEncoder.hash(domain, types, message);
    const hash2 = TypedDataEncoder.hash(d2, t2, m2);
    expect(hash1).not.toBe(hash2);
  });
});

// ── Test 11: PascalCase invariant ─────────────────────────────────────────────

describe("PascalCase key invariant in EIP-712 message", () => {
  const result = buildApproveAgentTypedData({
    user: USER,
    agentAddress: AGENT,
    agentName: "perp-cli-aster",
    expiredMs: EXPIRED_MS,
    canPerpTrade: true,
    canSpotTrade: false,
    canWithdraw: false,
    nonceMicros: NONCE_MICROS,
  });

  it("message has AgentName (not agentName)", () => {
    expect("AgentName" in result.message).toBe(true);
    expect("agentName" in result.message).toBe(false);
  });

  it("message has AgentAddress (not agentAddress)", () => {
    expect("AgentAddress" in result.message).toBe(true);
    expect("agentAddress" in result.message).toBe(false);
  });

  it("message has User (not user)", () => {
    expect("User" in result.message).toBe(true);
    expect("user" in result.message).toBe(false);
  });

  it("message has Nonce (not nonce)", () => {
    expect("Nonce" in result.message).toBe(true);
    expect("nonce" in result.message).toBe(false);
  });

  it("message has Expired (not expiredMs or expired)", () => {
    expect("Expired" in result.message).toBe(true);
    expect("expiredMs" in result.message).toBe(false);
    expect("expired" in result.message).toBe(false);
  });

  it("buildOrderQueryStringMsg uses camelCase keys (not PascalCase)", () => {
    const qs = buildOrderQueryStringMsg({ symbol: "BTCUSDT", user: USER, nonce: NONCE_MICROS });
    const parsed = new URLSearchParams(qs);
    // camelCase keys round-trip
    expect(parsed.get("user")).toBe(USER);
    expect(parsed.get("nonce")).toBe(String(NONCE_MICROS));
    // PascalCase keys should NOT be present in the query string
    expect(parsed.get("User")).toBeNull();
    expect(parsed.get("Nonce")).toBeNull();
  });
});

// ── Test 12: Deterministic ordering of types array ────────────────────────────

describe("deterministic ordering of types array", () => {
  const result = buildApproveAgentTypedData({
    user: USER,
    agentAddress: AGENT,
    agentName: "perp-cli-aster",
    expiredMs: EXPIRED_MS,
    canPerpTrade: true,
    canSpotTrade: false,
    canWithdraw: false,
    nonceMicros: NONCE_MICROS,
  });

  it("field-name array matches expected sequence (no IpWhitelist, no Builder)", () => {
    const names = result.types.ApproveAgent.map((f) => f.name);
    expect(names).toEqual([
      "AgentName",
      "AgentAddress",
      "Expired",
      "CanSpotTrade",
      "CanPerpTrade",
      "CanWithdraw",
      "AsterChain",
      "User",
      "Nonce",
    ]);
  });

  it("field-type array matches expected sequence", () => {
    const types = result.types.ApproveAgent.map((f) => f.type);
    expect(types).toEqual([
      "string",   // AgentName
      "string",   // AgentAddress
      "uint256",  // Expired
      "bool",     // CanSpotTrade
      "bool",     // CanPerpTrade
      "bool",     // CanWithdraw
      "string",   // AsterChain
      "string",   // User
      "uint256",  // Nonce
    ]);
  });

  it("field-name array with IpWhitelist + full Builder triple matches expected sequence", () => {
    const full = buildApproveAgentTypedData({
      user: USER,
      agentAddress: AGENT,
      agentName: "perp-cli-aster",
      expiredMs: EXPIRED_MS,
      canPerpTrade: true,
      canSpotTrade: true,
      canWithdraw: false,
      ipWhitelist: "192.168.1.0/24",
      builder: BUILDER,
      maxFeeRate: "0.0005",
      builderName: "HypurrQuant",
      nonceMicros: NONCE_MICROS,
    });
    const names = full.types.ApproveAgent.map((f) => f.name);
    expect(names).toEqual([
      "AgentName",
      "AgentAddress",
      "IpWhitelist",
      "Expired",
      "CanSpotTrade",
      "CanPerpTrade",
      "CanWithdraw",
      "Builder",
      "MaxFeeRate",
      "BuilderName",
      "AsterChain",
      "User",
      "Nonce",
    ]);
  });
});

// ── C6: Testnet chainId=714 ───────────────────────────────────────────────────

describe("Domain B testnet branching (C6)", () => {
  it("ASTER_DOMAIN_B_TESTNET.chainId is 714", () => {
    expect(ASTER_DOMAIN_B_TESTNET.chainId).toBe(714);
  });

  it("getAsterDomainB(false) returns mainnet (chainId=1666)", () => {
    expect(getAsterDomainB(false).chainId).toBe(1666);
    expect(getAsterDomainB(false)).toEqual(ASTER_DOMAIN_B);
  });

  it("getAsterDomainB(true) returns testnet (chainId=714)", () => {
    expect(getAsterDomainB(true).chainId).toBe(714);
    expect(getAsterDomainB(true)).toEqual(ASTER_DOMAIN_B_TESTNET);
  });

  it("buildOrderTypedData defaults to mainnet (chainId=1666)", () => {
    const result = buildOrderTypedData({ symbol: "BTCUSDT", user: USER, nonce: NONCE_MICROS });
    expect(result.domain.chainId).toBe(1666);
  });

  it("buildOrderTypedData(testnet=true) emits chainId=714", () => {
    const result = buildOrderTypedData({ symbol: "BTCUSDT", user: USER, nonce: NONCE_MICROS }, true);
    expect(result.domain.chainId).toBe(714);
  });

  it("testnet and mainnet share name/version/verifyingContract (only chainId differs)", () => {
    expect(ASTER_DOMAIN_B_TESTNET.name).toBe(ASTER_DOMAIN_B.name);
    expect(ASTER_DOMAIN_B_TESTNET.version).toBe(ASTER_DOMAIN_B.version);
    expect(ASTER_DOMAIN_B_TESTNET.verifyingContract).toBe(ASTER_DOMAIN_B.verifyingContract);
    expect(ASTER_DOMAIN_B_TESTNET.chainId).not.toBe(ASTER_DOMAIN_B.chainId);
  });
});
