import { describe, it, expect } from "vitest";
import { classifyError } from "../../errors.js";

/**
 * Verify OWS-specific matchers are resolved BEFORE the generic sign / not-found
 * blocks (plan requirement: new matchers inserted ABOVE errors.ts:61-78).
 */
describe("classifyError — OWS / agent-wallet codes (ordering test)", () => {
  it('"wallet is locked, cannot sign" → WALLET_LOCKED (not SIGNATURE_FAILED)', () => {
    const r = classifyError(new Error("wallet is locked, cannot sign"));
    expect(r.code).toBe("WALLET_LOCKED");
    expect(r.status).toBe(423);
    expect(r.retryable).toBe(false);
  });

  it('"Wallet locked" → WALLET_LOCKED', () => {
    const r = classifyError(new Error("Wallet locked"));
    expect(r.code).toBe("WALLET_LOCKED");
  });

  it('"key not found in vault" → KEY_NOT_FOUND (not SYMBOL_NOT_FOUND or default)', () => {
    const r = classifyError(new Error("key not found in vault"));
    expect(r.code).toBe("KEY_NOT_FOUND");
    expect(r.status).toBe(404);
  });

  it('"api key not found" → KEY_NOT_FOUND', () => {
    const r = classifyError(new Error("api key not found"));
    expect(r.code).toBe("KEY_NOT_FOUND");
  });

  it('"policy denied for chain eip155:1" → POLICY_DENIED', () => {
    const r = classifyError(new Error("policy denied for chain eip155:1"));
    expect(r.code).toBe("POLICY_DENIED");
    expect(r.status).toBe(403);
    expect(r.retryable).toBe(false);
  });

  it('"Agent not registered" → AGENT_NOT_REGISTERED', () => {
    const r = classifyError(new Error("Agent not registered"));
    expect(r.code).toBe("AGENT_NOT_REGISTERED");
    expect(r.status).toBe(401);
  });

  it('"agent expired" → AGENT_EXPIRED', () => {
    const r = classifyError(new Error("agent expired"));
    expect(r.code).toBe("AGENT_EXPIRED");
    expect(r.status).toBe(401);
  });

  it('"lock held by PID 1234" → LOCK_HELD', () => {
    const r = classifyError(new Error("lock held by PID 1234"));
    expect(r.code).toBe("LOCK_HELD");
    expect(r.status).toBe(423);
    expect(r.retryable).toBe(true);
    expect(r.retryAfterMs).toBe(5000);
  });

  it('"passphrase required to unlock" → PASSPHRASE_REQUIRED', () => {
    const r = classifyError(new Error("passphrase required to unlock"));
    expect(r.code).toBe("PASSPHRASE_REQUIRED");
    expect(r.status).toBe(401);
  });

  it('"partial approval failed" → APPROVE_PARTIAL', () => {
    const r = classifyError(new Error("partial approval failed"));
    expect(r.code).toBe("APPROVE_PARTIAL");
    expect(r.status).toBe(500);
  });

  it('"no signer available" → NO_SIGNER_AVAILABLE', () => {
    const r = classifyError(new Error("no signer available for this exchange"));
    expect(r.code).toBe("NO_SIGNER_AVAILABLE");
    expect(r.status).toBe(401);
    expect(r.retryable).toBe(false);
  });

  it('"signer unavailable" → NO_SIGNER_AVAILABLE', () => {
    const r = classifyError(new Error("signer unavailable"));
    expect(r.code).toBe("NO_SIGNER_AVAILABLE");
  });

  // Regression: generic sign matcher must NOT shadow wallet-locked messages
  it('"Signature verification failed" still → SIGNATURE_FAILED', () => {
    const r = classifyError(new Error("Signature verification failed"));
    expect(r.code).toBe("SIGNATURE_FAILED");
  });

  // Regression: generic not-found matcher for symbols still works
  it('"Symbol XYZABC not found" still → SYMBOL_NOT_FOUND', () => {
    const r = classifyError(new Error("Symbol XYZABC not found"));
    expect(r.code).toBe("SYMBOL_NOT_FOUND");
  });
});
