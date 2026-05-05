import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { stripVTControlCharacters } from "node:util";

const TEST_HOME = resolve(os.tmpdir(), `perp-landing-test-${process.pid}`);

vi.stubEnv("HOME", TEST_HOME);

const { setAgent } = await import("../agent-wallet/store.js");
const { asterAgentMissing, renderLandingExchangeLine, LANDING_EXCHANGES } = await import("../landing.js");
const { listExchanges } = await import("../exchanges/registry.js");

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

describe("LANDING_EXCHANGES sync — multi-adapter enumeration guard (Section 9)", () => {
  // Defends against the silent-drift class of bug we keep hitting: a new
  // exchange gets added to the adapter registry but the no-arg `perp`
  // landing page (or any consumer of LANDING_EXCHANGES) keeps showing the
  // old 4. Enumeration lives in two places — registry.ts and landing.ts —
  // and only the registry is the SSOT.
  it("matches the adapter registry — drift means a new exchange was added without updating landing.ts", () => {
    const landing = [...LANDING_EXCHANGES].sort();
    const registry = listExchanges().sort();
    expect(landing).toEqual(registry);
  });

  it("renders a distinct, non-empty label for every LANDING_EXCHANGES member (no exchangeLabel inline-switch fallthrough)", () => {
    // exchangeLabel() in landing.ts is an inline ternary chain; if a 5th
    // exchange is added to LANDING_EXCHANGES without updating that switch
    // it silently falls through to the last arm's label ("Aster"). This
    // test catches that footgun by asserting all labels are unique.
    const labels = LANDING_EXCHANGES.map((ex) => {
      const line = stripVTControlCharacters(renderLandingExchangeLine({
        exchange: ex,
        ok: true,
        equity: 1234.56,
        positions: 0,
      }, false));
      const m = /●\s+(\S+)/.exec(line);
      return m?.[1] ?? "";
    });
    expect(labels).toHaveLength(LANDING_EXCHANGES.length);
    expect(new Set(labels).size).toBe(LANDING_EXCHANGES.length);
    for (const label of labels) {
      expect(label).not.toBe("");
      expect(label).toMatch(/^[A-Z][a-zA-Z]+$/);
    }
  });
});
