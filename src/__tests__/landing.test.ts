import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { stripVTControlCharacters } from "node:util";

const TEST_HOME = resolve(os.tmpdir(), `perp-landing-test-${process.pid}`);

vi.stubEnv("HOME", TEST_HOME);

const { setAgent } = await import("../agent-wallet/store.js");
const { asterAgentMissing, renderLandingExchangeLine } = await import("../landing.js");

function makeAgent(name: string, status: "active" | "partial" = "active") {
  return {
    agentName: name,
    agentWalletName: `agent-aster-${name}`,
    agentEvmAddress: `0x000000000000000000000000000000000000000${name.length}` as `0x${string}`,
    userEvmAddress: "0x0000000000000000000000000000000000000099" as `0x${string}`,
    masterWalletName: "main",
    owsApiKeyId: `key-${name}`,
    owsPolicyId: `policy-${name}`,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: "1000",
    status,
  } as const;
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

describe("asterAgentMissing", () => {
  it("returns true when settings has no Aster agent", () => {
    expect(asterAgentMissing()).toBe(true);
  });

  it("returns false when settings has an active Aster agent", () => {
    setAgent("aster", makeAgent("active-agent"));
    expect(asterAgentMissing()).toBe(false);
  });
});

describe("renderLandingExchangeLine", () => {
  it("prints 'agent required' only when failed Aster + agent missing + agent-related error code", () => {
    const asterMissingAgentErr = stripVTControlCharacters(renderLandingExchangeLine({
      exchange: "aster",
      ok: false,
      equity: 0,
      positions: 0,
      errorCode: "NOT_IMPLEMENTED",
    }, true));
    const asterPresent = stripVTControlCharacters(renderLandingExchangeLine({
      exchange: "aster",
      ok: false,
      equity: 0,
      positions: 0,
      errorCode: "NOT_IMPLEMENTED",
    }, false));
    const pacificaMissing = stripVTControlCharacters(renderLandingExchangeLine({
      exchange: "pacifica",
      ok: false,
      equity: 0,
      positions: 0,
    }, true));

    expect(asterMissingAgentErr).toContain("agent required");
    expect(asterMissingAgentErr).toContain("perp wallet agent approve aster");
    expect(asterPresent).not.toContain("agent required");
    expect(asterPresent).toContain("—");
    expect(pacificaMissing).not.toContain("agent required");
    expect(pacificaMissing).toContain("—");
  });

  it("falls through to red dash when Aster failed for a non-agent reason (Rule #2)", () => {
    const asterNetworkErr = stripVTControlCharacters(renderLandingExchangeLine({
      exchange: "aster",
      ok: false,
      equity: 0,
      positions: 0,
      errorCode: "EXCHANGE_ERROR",
    }, true));
    const asterUnknownErr = stripVTControlCharacters(renderLandingExchangeLine({
      exchange: "aster",
      ok: false,
      equity: 0,
      positions: 0,
    }, true));

    expect(asterNetworkErr).not.toContain("agent required");
    expect(asterNetworkErr).toContain("—");
    expect(asterUnknownErr).not.toContain("agent required");
    expect(asterUnknownErr).toContain("—");
  });

  it("renders agent-required hint for AGENT_EXPIRED and NO_SIGNER_AVAILABLE (any agent-related code)", () => {
    for (const code of ["AGENT_EXPIRED", "NO_SIGNER_AVAILABLE", "NOT_IMPLEMENTED"]) {
      const out = stripVTControlCharacters(renderLandingExchangeLine({
        exchange: "aster",
        ok: false,
        equity: 0,
        positions: 0,
        errorCode: code,
      }, true));
      expect(out).toContain("agent required");
    }
  });
});
