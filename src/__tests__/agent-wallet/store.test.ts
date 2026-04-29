import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import os from "os";

// Use a temp dir so tests don't touch the real ~/.perp
const TEST_HOME = resolve(os.tmpdir(), `perp-store-test-${process.pid}`);

// Patch HOME before any module import so loadSettings/saveSettings use the temp dir
vi.stubEnv("HOME", TEST_HOME);

// Now import after env is stubbed
const { getAgent, setAgent, deleteAgent, listAgents } = await import(
  "../../agent-wallet/store.js"
);

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
  // Clean up temp dir between tests
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

describe("store round-trip", () => {
  it("setAgent → getAgent returns the stored meta", () => {
    const meta = makeAgent("perp-cli-aster");
    setAgent("aster", meta);
    const loaded = getAgent("aster", "perp-cli-aster");
    expect(loaded).not.toBeNull();
    expect(loaded?.agentName).toBe("perp-cli-aster");
    expect(loaded?.owsApiKeyId).toBe("key-perp-cli-aster");
  });

  it("getAgent without name returns first non-partial agent", () => {
    const partial = makeAgent("partial-agent", "partial");
    const active = makeAgent("active-agent", "active");
    setAgent("aster", partial);
    setAgent("aster", active);
    const loaded = getAgent("aster");
    expect(loaded?.agentName).toBe("active-agent");
  });

  it("getAgent returns null when no agents registered", () => {
    expect(getAgent("aster")).toBeNull();
    expect(getAgent("aster", "nonexistent")).toBeNull();
  });

  it("deleteAgent removes the entry and returns true", () => {
    const meta = makeAgent("to-delete");
    setAgent("aster", meta);
    expect(getAgent("aster", "to-delete")).not.toBeNull();
    const deleted = deleteAgent("aster", "to-delete");
    expect(deleted).toBe(true);
    expect(getAgent("aster", "to-delete")).toBeNull();
  });

  it("deleteAgent returns false when agent does not exist (idempotent)", () => {
    expect(deleteAgent("aster", "nonexistent")).toBe(false);
  });

  it("listAgents returns all agents when no exchange filter", () => {
    setAgent("aster", makeAgent("a1"));
    setAgent("aster", makeAgent("a2"));
    const list = listAgents();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("listAgents filters by exchange", () => {
    setAgent("aster", makeAgent("a1"));
    const list = listAgents("aster");
    expect(list.every((e) => e.exchange === "aster")).toBe(true);
  });
});

describe("lockfile race (LOCK_HELD)", () => {
  it("second setAgent call while lock is held throws LOCK_HELD", () => {
    const LOCKS_DIR = resolve(TEST_HOME, ".perp", "locks");
    mkdirSync(LOCKS_DIR, { recursive: true });
    const lockFile = resolve(LOCKS_DIR, "agent-approve-aster.lock");

    // Simulate a live lock from an EXTERNAL PID (PID 1 / launchd is always alive).
    // Must NOT use process.pid — same-PID locks are treated as re-entrant by setAgent.
    writeFileSync(lockFile, `1\n${new Date().toISOString()}`);

    const meta = makeAgent("race-agent");
    expect(() => setAgent("aster", meta)).toThrowError(
      expect.objectContaining({
        structured: expect.objectContaining({ code: "LOCK_HELD" }),
      }),
    );
  });
});
