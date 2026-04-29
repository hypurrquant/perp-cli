import { describe, it, expect } from "vitest";
import { isExpired, daysUntilExpiry, formatExpiry } from "../../agent-wallet/expiry.js";
import type { AgentMeta } from "../../settings.js";

function makeMeta(expiresAt: string): AgentMeta {
  return {
    agentName: "test-agent",
    agentWalletName: "agent-aster-main",
    agentEvmAddress: "0x0000000000000000000000000000000000000001",
    userEvmAddress: "0x0000000000000000000000000000000000000099",
    masterWalletName: "main",
    owsApiKeyId: "ows_key_test",
    owsPolicyId: "policy-test",
    expiresAt,
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: "1000",
    status: "active",
  };
}

describe("isExpired", () => {
  it("returns false for an agent expiring in the future", () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(isExpired(makeMeta(future))).toBe(false);
  });

  it("returns false for an agent expiring in exactly 7 days", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isExpired(makeMeta(future))).toBe(false);
  });

  it("returns true for an agent that has already expired", () => {
    const past = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(isExpired(makeMeta(past))).toBe(true);
  });
});

describe("daysUntilExpiry", () => {
  it("returns a positive float for a future expiry", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const days = daysUntilExpiry(makeMeta(future));
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("returns a negative value for an expired agent", () => {
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const days = daysUntilExpiry(makeMeta(past));
    expect(days).toBeLessThan(0);
  });
});

describe("formatExpiry", () => {
  it("includes 'expires in' and the date for a future expiry", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatExpiry(makeMeta(future));
    expect(result).toMatch(/expires in/);
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("includes 'expired' for a past expiry", () => {
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatExpiry(makeMeta(past));
    expect(result).toMatch(/expired/);
  });
});
