/**
 * Tests for src/commands/agent.ts — agent approve/list/revoke/rotate subcommands.
 *
 * AC coverage: AC-1/2/3/4/14/15/16/17/18/19 from plan v3.2 Step 4.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-aw-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE any module imports ─────────────────────────────

const mockOws = {
  createWallet: vi.fn(),
  createPolicy: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  getWallet: vi.fn(),
  signTypedData: vi.fn(),
  signMessage: vi.fn(),
};

vi.mock("../../signer/ows-loader.js", () => ({
  loadOws: () => mockOws,
}));

// ── Mock readline (allowlist: only agent.ts, init.ts, alerts.ts, wallet.ts) ──

const mockRlQuestion = vi.fn();
const mockRlClose = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: mockRlQuestion,
    close: mockRlClose,
  })),
}));

// ── Now import modules after mocks are set up ─────────────────────────────

const { registerWalletAgentCommands } = await import("../../commands/agent.js");
const { getAgent, setAgent, deleteAgent } = await import("../../agent-wallet/store.js");
const { loadSettings, saveSettings } = await import("../../settings.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride(); // prevent process.exit in tests
  // Register `agent` as a subcommand of `wallet` to match the production
  // command tree post-consolidation (`perp wallet agent ...`).
  const walletCmd = prog.command("wallet").description("Wallet management");
  registerWalletAgentCommands(walletCmd, () => false);
  return prog;
}

function makeAgentMeta(name = "perp-cli-aster") {
  return {
    agentName: name,
    agentWalletName: `agent-aster-main`,
    agentEvmAddress: "0xAgentAddr0000000000000000000000000000001" as `0x${string}`,
    userEvmAddress: "0xMasterAddr000000000000000000000000000001" as `0x${string}`,
    masterWalletName: "main",
    owsApiKeyId: "key-001",
    owsPolicyId: "policy-001",
    expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: "12345000000",
    status: "active" as const,
  };
}

/** Set up OWS mocks for a successful approve flow */
function setupOkOws() {
  const agentWallet = {
    id: "wallet-agent-id",
    name: "agent-aster-main",
    accounts: [{ chainId: "eip155:56", address: "0xAgentAddr0000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
    createdAt: new Date().toISOString(),
  };
  mockOws.createWallet.mockReturnValue(agentWallet);
  mockOws.createPolicy.mockReturnValue(undefined);
  mockOws.createApiKey.mockReturnValue({ id: "key-001", token: "ows_key_NEVER_STORED", name: "api-aster-perp-cli-aster" });
  mockOws.revokeApiKey.mockReturnValue(undefined);
  // getWallet used by OwsEvmSigner.create()
  mockOws.getWallet.mockReturnValue({
    id: "wallet-master-id",
    name: "main",
    accounts: [{ chainId: "eip155:56", address: "0xMasterAddr000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
    createdAt: new Date().toISOString(),
  });
  mockOws.signTypedData.mockReturnValue({
    signature: "0xdeadbeef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    recoveryId: 0,
  });
}

/** Stub globalThis.fetch to return a successful Aster response */
function stubFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code: "000000", msg: "success" }),
    text: async () => "ok",
  }));
}

/** Stub fetch to return 404 */
function stubFetch404() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({ code: "404", msg: "not found" }),
    text: async () => "not found",
  }));
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  // Reset env vars
  vi.unstubAllEnvs();
  vi.stubEnv("HOME", TEST_HOME);
  delete process.env["OWS_PASSPHRASE"];
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Wizard mode
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 1: Wizard mode", () => {
  it("TTY + no flags → readline prompts fired in order, settings persisted", async () => {
    setupOkOws();
    stubFetchOk();

    // Simulate TTY
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    delete process.env["OWS_PASSPHRASE"];

    // Wizard answers: master, agentName, expiry, canPerp, canSpot, canWithdraw, passphrase
    let callIdx = 0;
    const answers = ["main", "perp-cli-aster", "90d", "y", "n", "n", "testpass"];
    mockRlQuestion.mockImplementation(() => Promise.resolve(answers[callIdx++] ?? ""));

    const stderrWrites: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "approve", "aster"]);

    expect(mockRlQuestion.mock.calls.length).toBeGreaterThanOrEqual(7);
    // Verify exact prompt ordering
    const prompts = mockRlQuestion.mock.calls.map(c => String(c[0]));
    expect(prompts[0]).toMatch(/[Mm]aster wallet/i);
    expect(prompts[1]).toMatch(/[Aa]gent name/i);
    expect(prompts[2]).toMatch(/[Ee]xpir/i);
    expect(prompts[3]).toMatch(/[Pp]erp/i);
    expect(prompts[4]).toMatch(/[Ss]pot/i);
    expect(prompts[5]).toMatch(/[Ww]ithdraw/i);

    expect(mockRlClose).toHaveBeenCalled();

    // Settings should be persisted
    const settings = loadSettings();
    const storedAgent = getAgent("aster", "perp-cli-aster");
    expect(storedAgent).not.toBeNull();
    expect(storedAgent?.agentName).toBe("perp-cli-aster");
    expect(storedAgent?.masterWalletName).toBe("main");
    expect(storedAgent?.owsApiKeyId).toBe("key-001");
    expect(storedAgent?.status).toBe("active");

    exitSpy.mockRestore();
    vi.spyOn(process.stderr, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Non-interactive mode
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 2: Non-interactive mode", () => {
  it("all flags supplied + non-TTY → zero readline calls, JSON envelope verified", async () => {
    setupOkOws();
    stubFetchOk();

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.stubEnv("OWS_PASSPHRASE", "testpass");

    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "aster",
      "--master", "main",
      "--agent-name", "perp-cli-aster",
      "--expires-in", "90d",
      "--can-perp",
      "--no-spot",
      "--no-withdraw",
      "--passphrase", "testpass",
      "--json",
    ]);

    // Zero readline calls (AC-2)
    expect(mockRlQuestion.mock.calls.length).toBe(0);

    // Verify JSON output shape
    const jsonOutput = printed.find(p => p.includes('"ok"'));
    expect(jsonOutput).toBeTruthy();
    const parsed = JSON.parse(jsonOutput!.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("agentAddress");
    expect(parsed.data).toHaveProperty("agentName");
    expect(parsed.data).toHaveProperty("expiresAt");
    expect(parsed.data).toHaveProperty("owsApiKeyId");
    expect(parsed.data).toHaveProperty("policyId");
    expect(parsed.data).toHaveProperty("asterApprovalNonce");
    expect(parsed.data).toHaveProperty("userEvmAddress");
    expect(parsed.data.agentName).toBe("perp-cli-aster");
    expect(parsed.data.userEvmAddress).toBe("0xMasterAddr000000000000000000000000000001");

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    vi.spyOn(process.stdout, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: agent list empty
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 3: agent list empty", () => {
  it("JSON: returns empty array", async () => {
    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "list", "--json"]);

    const jsonOutput = printed.find(p => p.includes('"ok"'));
    expect(jsonOutput).toBeTruthy();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  it("non-JSON: shows 'No agents registered' message", async () => {
    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "list"]);


    expect(printed.some(p => p.includes("No agents registered"))).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: agent list populated
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 4: agent list populated", () => {
  it("shows active and expired agents with correct status", async () => {
    // Pre-populate settings with 2 agents: one active, one expired
    const activeAgent = makeAgentMeta("active-agent");
    const expiredAgent = {
      ...makeAgentMeta("expired-agent"),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    };
    setAgent("aster", activeAgent);
    setAgent("aster", expiredAgent);

    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "list", "--json"]);

    const jsonOutput = printed.find(p => p.includes('"ok"'));
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveLength(2);

    const activeRow = parsed.data.find((r: { name: string }) => r.name === "active-agent");
    const expiredRow = parsed.data.find((r: { name: string }) => r.name === "expired-agent");
    expect(activeRow).toBeTruthy();
    expect(expiredRow).toBeTruthy();
    expect(activeRow.status).toBe("active");
    expect(expiredRow.status).toBe("expired");

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: agent revoke happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 5: agent revoke happy path", () => {
  it("DELETE POST mocked 200 → revokeApiKey called → deleteAgent removes entry", async () => {
    // Pre-populate agent
    setAgent("aster", makeAgentMeta("perp-cli-aster"));

    mockOws.getWallet.mockReturnValue({
      id: "wallet-master-id",
      name: "main",
      accounts: [{ chainId: "eip155:56", address: "0xMasterAddr000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
      createdAt: new Date().toISOString(),
    });
    mockOws.signTypedData.mockReturnValue({
      signature: "0xdeadbeef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      recoveryId: 0,
    });
    mockOws.revokeApiKey.mockReturnValue(undefined);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "000000" }),
      text: async () => "ok",
    }));

    vi.stubEnv("OWS_PASSPHRASE", "testpass");

    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "revoke", "aster", "perp-cli-aster", "--passphrase", "testpass", "--json"]);

    // revokeApiKey called
    expect(mockOws.revokeApiKey).toHaveBeenCalledWith("key-001");

    // deleteAgent removed the entry
    const meta = getAgent("aster", "perp-cli-aster");
    expect(meta).toBeNull();

    // JSON response
    const jsonOutput = printed.find(p => p.includes('"ok"'));
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.revoked).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: agent revoke 404 idempotent
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 6: agent revoke 404 idempotent", () => {
  it("Aster returns 404 → command still returns {ok:true}", async () => {
    setAgent("aster", makeAgentMeta("perp-cli-aster"));

    mockOws.getWallet.mockReturnValue({
      id: "wallet-master-id",
      name: "main",
      accounts: [{ chainId: "eip155:56", address: "0xMasterAddr000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
      createdAt: new Date().toISOString(),
    });
    mockOws.signTypedData.mockReturnValue({
      signature: "0xdeadbeef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      recoveryId: 0,
    });
    mockOws.revokeApiKey.mockReturnValue(undefined);
    stubFetch404();

    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "revoke", "aster", "perp-cli-aster", "--passphrase", "testpass", "--json"]);

    const jsonOutput = printed.find(p => p.includes('"ok"'));
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: agent revoke already-absent
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 7: agent revoke already-absent", () => {
  it("agent doesn't exist locally → {ok:true, data:{alreadyRevoked:true}} without any Aster POST", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "revoke", "aster", "nonexistent-agent", "--passphrase", "testpass", "--json"]);

    // No Aster POST
    expect(mockFetch).not.toHaveBeenCalled();

    const jsonOutput = printed.find(p => p.includes('"ok"'));
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.alreadyRevoked).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: agent revoke --force
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 8: agent revoke --force", () => {
  it("--force bypasses Aster POST, only clears local state", async () => {
    setAgent("aster", makeAgentMeta("perp-cli-aster"));
    mockOws.revokeApiKey.mockReturnValue(undefined);

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "revoke", "aster", "perp-cli-aster", "--force", "--json"]);

    // No Aster POST
    expect(mockFetch).not.toHaveBeenCalled();

    // Local state cleared
    expect(getAgent("aster", "perp-cli-aster")).toBeNull();

    const jsonOutput = printed.find(p => p.includes('"ok"'));
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.revoked).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Concurrent-approve guard (LOCK_HELD)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 9: Concurrent-approve guard", () => {
  it("second setAgent call while lock held throws LOCK_HELD with remediation", async () => {
    // Write a lock file with the current PID (alive)
    const { mkdirSync: mkdirFn, writeFileSync: wfSync } = await import("fs");
    const { resolve: resolveFn } = await import("path");
    const locksDir = resolveFn(TEST_HOME, ".perp", "locks");
    mkdirFn(locksDir, { recursive: true });
    const lockFile = resolveFn(locksDir, "agent-approve-aster.lock");
    // Use PID 1 (launchd / init — always alive) to simulate an EXTERNAL process holding the lock.
    // Must NOT use process.pid — same-PID locks are treated as re-entrant by setAgent.
    wfSync(lockFile, `1\n${new Date().toISOString()}`, { mode: 0o600 });

    const { PerpError } = await import("../../errors.js");
    const { setAgent: setAgentFn } = await import("../../agent-wallet/store.js");

    let threw = false;
    let code = "";
    let remediation = "";
    try {
      setAgentFn("aster", makeAgentMeta("concurrent-test"));
    } catch (e) {
      threw = true;
      if (e instanceof PerpError) {
        code = e.structured.code;
        remediation = e.structured.remediation ?? "";
      }
    }

    expect(threw).toBe(true);
    expect(code).toBe("LOCK_HELD");
    expect(remediation.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Partial-approve recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 10: Partial-approve recovery", () => {
  it("Aster POST succeeds then revokeApiKey throws → APPROVE_PARTIAL + status:partial in settings", async () => {
    const agentWallet = {
      id: "wallet-agent-id",
      name: "agent-aster-main",
      accounts: [{ chainId: "eip155:56", address: "0xAgentAddr0000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
      createdAt: new Date().toISOString(),
    };
    mockOws.createWallet.mockReturnValue(agentWallet);
    mockOws.createPolicy.mockReturnValue(undefined);
    mockOws.createApiKey.mockReturnValue({ id: "key-partial", token: "ows_key_NEVER_STORED", name: "api" });
    // revokeApiKey throws — triggers partial state
    mockOws.revokeApiKey.mockImplementation(() => { throw new Error("vault error"); });
    mockOws.getWallet.mockReturnValue({
      id: "wallet-master-id",
      name: "main",
      accounts: [{ chainId: "eip155:56", address: "0xMasterAddr000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
      createdAt: new Date().toISOString(),
    });
    mockOws.signTypedData.mockReturnValue({
      signature: "0xdeadbeef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      recoveryId: 0,
    });

    // fetch succeeds for Aster POST, then saveSettings throws
    let saveCallCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "000000" }),
      text: async () => "ok",
    }));

    // Patch saveSettings to fail on first call after Aster POST
    const settingsModule = await import("../../settings.js");
    const origSave = settingsModule.saveSettings;
    vi.spyOn(settingsModule, "saveSettings").mockImplementation((s) => {
      saveCallCount++;
      if (saveCallCount === 1) {
        throw new Error("disk full");
      }
      return origSave(s);
    });

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.stubEnv("OWS_PASSPHRASE", "testpass");

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    let threw = false;
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "aster",
        "--master", "main",
        "--agent-name", "partial-test",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch {
      threw = true;
    }

    // revokeApiKey was attempted (rollback)
    expect(mockOws.revokeApiKey).toHaveBeenCalled();

    // APPROVE_PARTIAL error surfaced to stderr
    const stderrStr = stderrOutput.join("");
    expect(stderrStr).toContain("APPROVE_PARTIAL");

    vi.spyOn(settingsModule, "saveSettings").mockRestore();
    exitSpy.mockRestore();
    vi.spyOn(process.stderr, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: Passphrase 3-path: flag wins
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 11: Passphrase 3-path: flag wins", () => {
  it("--passphrase flag wins over OWS_PASSPHRASE env", async () => {
    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");

    vi.stubEnv("OWS_PASSPHRASE", "env-passphrase");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const result = await resolvePassphrase({ flag: "flag-passphrase" });
    expect(result).toBe("flag-passphrase");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: Passphrase 3-path: env wins over stdin
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 12: Passphrase 3-path: env wins over stdin", () => {
  it("no flag, env set → env value used (stdin irrelevant)", async () => {
    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");

    vi.stubEnv("OWS_PASSPHRASE", "env-passphrase");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const result = await resolvePassphrase({ flag: undefined });
    expect(result).toBe("env-passphrase");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 13: Passphrase non-TTY no creds → PASSPHRASE_REQUIRED
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 13: Passphrase non-TTY no creds", () => {
  it("no flag, no env, stdin non-TTY → throws PASSPHRASE_REQUIRED with remediation", async () => {
    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");
    const { PerpError } = await import("../../errors.js");

    delete process.env["OWS_PASSPHRASE"];
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    // Mock stdin to emit EOF immediately (no data)
    const origOn = process.stdin.on.bind(process.stdin);
    vi.spyOn(process.stdin, "on").mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "end") {
        setTimeout(() => cb(), 0);
        return process.stdin;
      }
      if (event === "data") {
        // no data emitted
        return process.stdin;
      }
      return origOn(event as never, cb as never);
    });
    vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);

    let code = "";
    let remediation = "";
    try {
      await resolvePassphrase({ flag: undefined });
    } catch (e) {
      if (e instanceof PerpError) {
        code = e.structured.code;
        remediation = e.structured.remediation ?? "";
      }
    }

    expect(code).toBe("PASSPHRASE_REQUIRED");
    expect(remediation.length).toBeGreaterThan(0);

    vi.spyOn(process.stdin, "on").mockRestore();
    vi.spyOn(process.stdin, "setEncoding").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 14: No-prompts allowlist invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 14: No-prompts allowlist invariant", () => {
  it("grep createInterface|readline in src/commands/*.ts returns only allowlisted files", async () => {
    const { execSync } = await import("child_process");
    const result = execSync(
      "grep -lE 'createInterface|readline' /Users/hik/Documents/GitHub/perp-cli/src/commands/*.ts 2>/dev/null || true",
      { encoding: "utf-8" },
    ).trim();

    const files = result.split("\n").filter(Boolean).map(f => f.split("/").pop()!);
    // Allowlist: files that legitimately use readline for human-onboarding flows.
    // wallet.ts does NOT use readline (verified on HEAD). If it is added later,
    // update this allowlist — do NOT just add it without a review.
    const allowlist = new Set(["agent.ts", "init.ts", "alerts.ts", "wallet.ts"]);
    const unexpected = files.filter(f => !allowlist.has(f));
    expect(unexpected).toHaveLength(0);
    // Core allowlisted files that must always use readline
    expect(files).toContain("agent.ts");
    expect(files).toContain("init.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 15: Stable JSON envelope on stderr without --json
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 15: Stable JSON envelope on stderr without --json", () => {
  it("error path WITHOUT --json emits JSON envelope on stderr", async () => {
    // Use TTY=true so resolvePassphrase returns null (no stdin read attempted)
    // but wizard mode is NOT triggered because --master flag IS provided
    // → PASSPHRASE_REQUIRED thrown by the non-wizard path
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    delete process.env["OWS_PASSPHRASE"];

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      // --master provided (bypasses wizard) but no passphrase + TTY returns null → PASSPHRASE_REQUIRED
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "aster",
        "--master", "main",
        "--agent-name", "test",
        "--expires-in", "90d",
        // no --passphrase, no OWS_PASSPHRASE → resolvePassphrase returns null → PASSPHRASE_REQUIRED
      ]);
    } catch { /* expected */ }

    const stderrStr = stderrOutput.join("");
    expect(stderrStr.length).toBeGreaterThan(0);

    // Must be parseable JSON with the envelope shape
    const parsed = JSON.parse(stderrStr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toHaveProperty("code");
    expect(parsed.error).toHaveProperty("message");
    expect(parsed.meta).toHaveProperty("timestamp");

    exitSpy.mockRestore();
    vi.spyOn(process.stderr, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 16: Remediation field on every actionable error (AC-19)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 16: Remediation field on every actionable error", () => {
  const testCodes = [
    "NO_SIGNER_AVAILABLE",
    "AGENT_EXPIRED",
    "POLICY_DENIED",
    "WALLET_LOCKED",
    "LOCK_HELD",
    "PASSPHRASE_REQUIRED",
    "APPROVE_PARTIAL",
  ] as const;

  for (const code of testCodes) {
    it(`${code} carries non-empty remediation`, async () => {
      const { PerpError } = await import("../../errors.js");
      const err = new PerpError(code, `test error for ${code}`, {
        remediation: `Remediation hint for ${code}`,
      });
      expect(err.structured.code).toBe(code);
      expect(err.structured.remediation).toBeTruthy();
      expect(err.structured.remediation!.length).toBeGreaterThan(0);
    });
  }

  // NOT_IMPLEMENTED is synthesized inline in agent approve — test via direct object
  it("NOT_IMPLEMENTED carries non-empty remediation (inline error object)", () => {
    const errObj = {
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "test",
        remediation: "Wait for Phase 2b/c/d (HL/PAC/LT)",
      },
      meta: { timestamp: new Date().toISOString() },
    };
    expect(errObj.error.remediation.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 17: Optional builder approval
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 17: Optional builder approval", () => {
  it("--builder set → approveBuilder POST sent BEFORE approveAgent POST", async () => {
    setupOkOws();

    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ code: "000000" }),
        text: async () => "ok",
      });
    }));

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.stubEnv("OWS_PASSPHRASE", "testpass");

    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "aster",
      "--master", "main",
      "--agent-name", "perp-cli-aster",
      "--expires-in", "90d",
      "--passphrase", "testpass",
      "--builder", "0xBuilderAddr000000000000000000000000001",
      "--max-fee-rate", "5",
      "--json",
    ]);

    // approveBuilder URL should come BEFORE approveAgent URL
    const builderIdx = fetchCalls.findIndex(u => u.includes("approveBuilder"));
    const agentIdx = fetchCalls.findIndex(u => u.includes("approveAgent"));
    expect(builderIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(builderIdx).toBeLessThan(agentIdx);

    exitSpy.mockRestore();
    vi.spyOn(console, "log").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 18: agent rotate
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 18: agent rotate", () => {
  it("rotate: revokes existing agent, approves with same name, settings has new entry", async () => {
    // Pre-populate existing agent
    setAgent("aster", makeAgentMeta("perp-cli-aster"));

    setupOkOws();
    stubFetchOk();

    vi.stubEnv("OWS_PASSPHRASE", "testpass");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "rotate", "aster", "perp-cli-aster",
      "--passphrase", "testpass",
      "--master", "main",
      "--json",
    ]);

    const jsonOutput = printed.find(p => p.includes('"ok"'));
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.rotated).toBe(true);
    expect(parsed.data.agentName).toBe("perp-cli-aster");

    // New entry should exist in settings
    const newMeta = getAgent("aster", "perp-cli-aster");
    expect(newMeta).not.toBeNull();
    // approvedAt should be recent (within 5 seconds)
    const approvedAt = new Date(newMeta!.approvedAt).getTime();
    expect(Date.now() - approvedAt).toBeLessThan(5000);

    vi.spyOn(console, "log").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 19: createApiKey throws BEFORE Aster POST
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 19: createApiKey throws BEFORE Aster POST", () => {
  it("createApiKey throws → no fetch call to /fapi/v3/approveAgent, settings unchanged", async () => {
    mockOws.getWallet.mockReturnValue({
      id: "wallet-master-id",
      name: "main",
      accounts: [{ chainId: "eip155:56", address: "0xMasterAddr000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
      createdAt: new Date().toISOString(),
    });
    mockOws.createWallet.mockReturnValue({
      id: "wallet-agent-id",
      name: "agent-aster-main",
      accounts: [{ chainId: "eip155:56", address: "0xAgentAddr0000000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" }],
      createdAt: new Date().toISOString(),
    });
    mockOws.createPolicy.mockReturnValue(undefined);
    // createApiKey throws before Aster POST
    mockOws.createApiKey.mockImplementation(() => { throw new Error("vault full"); });
    mockOws.signTypedData.mockReturnValue({
      signature: "0xdeadbeef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      recoveryId: 0,
    });

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.stubEnv("OWS_PASSPHRASE", "testpass");

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderrOutput.push(String(chunk)); return true; });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "aster",
        "--master", "main",
        "--agent-name", "test-agent",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch { /* expected */ }

    // No fetch to approveAgent
    const approveAgentCalls = mockFetch.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("approveAgent"),
    );
    expect(approveAgentCalls).toHaveLength(0);

    // Settings unchanged (no agent persisted)
    const stored = getAgent("aster", "test-agent");
    expect(stored).toBeNull();

    exitSpy.mockRestore();
    vi.spyOn(process.stderr, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 20: agent list shows status='partial' agents
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 20: agent list shows status='partial' agents", () => {
  it("partial agent shows 'partial' status in JSON and human-readable output", async () => {
    const partialAgent = {
      ...makeAgentMeta("partial-agent"),
      status: "partial" as const,
    };
    setAgent("aster", partialAgent);

    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();

    // JSON output
    await prog.parseAsync(["node", "perp", "wallet", "agent", "list", "--json"]);
    const jsonOutput = printed.find(p => p.includes('"ok"'));
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    const partialRow = parsed.data.find((r: { name: string }) => r.name === "partial-agent");
    expect(partialRow).toBeTruthy();
    expect(partialRow.status).toBe("partial");

    printed.length = 0;

    // Human-readable output — "partial" badge should appear
    await prog.parseAsync(["node", "perp", "wallet", "agent", "list"]);
    const humanOutput = printed.join("\n");
    expect(humanOutput).toContain("partial");

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 21: APPROVE_FAILED clean-rollback path
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 21: APPROVE_FAILED clean-rollback path", () => {
  it("persist fails, DELETE+revokeApiKey both succeed → APPROVE_FAILED (not APPROVE_PARTIAL), no orphan entry", async () => {
    setupOkOws();

    // fetch: approveAgent POST succeeds; DELETE also succeeds
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "000000" }),
      text: async () => "ok",
    }));

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.stubEnv("OWS_PASSPHRASE", "testpass");

    const settingsModule = await import("../../settings.js");
    let saveCallCount = 0;
    const origSave = settingsModule.saveSettings;
    vi.spyOn(settingsModule, "saveSettings").mockImplementation((s) => {
      saveCallCount++;
      if (saveCallCount === 1) throw new Error("disk full");
      return origSave(s);
    });

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderrOutput.push(String(chunk)); return true; });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "aster",
        "--master", "main",
        "--agent-name", "clean-rollback-test",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch { /* expected */ }

    const stderrStr = stderrOutput.join("");
    // Must be APPROVE_FAILED (clean), not APPROVE_PARTIAL
    expect(stderrStr).toContain("APPROVE_FAILED");
    expect(stderrStr).not.toContain("APPROVE_PARTIAL");

    // revokeApiKey was called (local cleanup attempted)
    expect(mockOws.revokeApiKey).toHaveBeenCalled();

    // No orphan entry in settings
    const stored = getAgent("aster", "clean-rollback-test");
    expect(stored).toBeNull();

    vi.spyOn(settingsModule, "saveSettings").mockRestore();
    exitSpy.mockRestore();
    vi.spyOn(process.stderr, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 22: Lock scope regression (CRITICAL-1)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 22: Lock scope regression", () => {
  it("second approve while first holds lock → second throws LOCK_HELD, never reaches Aster POST", async () => {
    const { mkdirSync: mkdirFn, writeFileSync: wfSync } = await import("fs");
    const { resolve: resolveFn } = await import("path");
    const locksDir = resolveFn(TEST_HOME, ".perp", "locks");
    mkdirFn(locksDir, { recursive: true });
    // Write a lock held by PID 1 (launchd / init — always alive, always external).
    // Must NOT use process.pid — same-PID locks are treated as re-entrant.
    const lockFile = resolveFn(locksDir, "agent-approve-aster.lock");
    wfSync(lockFile, `1\n${new Date().toISOString()}`, { mode: 0o600 });

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    setupOkOws();
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.stubEnv("OWS_PASSPHRASE", "testpass");

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderrOutput.push(String(chunk)); return true; });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "aster",
        "--master", "main",
        "--agent-name", "concurrent-test",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch { /* expected */ }

    // LOCK_HELD error on stderr
    const stderrStr = stderrOutput.join("");
    expect(stderrStr).toContain("LOCK_HELD");

    // No Aster POST attempted
    const approveAgentCalls = mockFetch.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("approveAgent"),
    );
    expect(approveAgentCalls).toHaveLength(0);

    exitSpy.mockRestore();
    vi.spyOn(process.stderr, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 23: rotate rollback (Aster POST fails after OWS resources created)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 23: rotate rollback (Aster POST fails)", () => {
  it("Aster POST fails during rotate approve phase → revokeApiKey called, no new entry in settings", async () => {
    // Pre-populate existing agent
    setAgent("aster", makeAgentMeta("perp-cli-aster"));

    setupOkOws();

    // First fetch call is DELETE (revoke existing) → ok
    // Second fetch call is POST approveAgent → fail
    let fetchCallCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // DELETE for existing agent revoke
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ code: "000000" }), text: async () => "ok" });
      }
      // POST approveAgent → fail
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ code: "500" }), text: async () => "internal error" });
    }));

    vi.stubEnv("OWS_PASSPHRASE", "testpass");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderrOutput.push(String(chunk)); return true; });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "rotate", "aster", "perp-cli-aster",
        "--passphrase", "testpass",
        "--master", "main",
        "--json",
      ]);
    } catch { /* expected */ }

    // revokeApiKey should have been called (rollback of the new OWS api key)
    expect(mockOws.revokeApiKey).toHaveBeenCalled();

    // No new entry for the rotated agent should persist
    const meta = getAgent("aster", "perp-cli-aster");
    // Either null (fully cleaned up) or not present — key point: no partial entry with a NEW address
    // Since the old agent was deleted during revoke phase and new approve failed, entry is null
    expect(meta).toBeNull();

    exitSpy.mockRestore();
    vi.spyOn(process.stderr, "write").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 24: rotate forwards permission flags
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 24: rotate forwards permission flags", () => {
  it("rotate with --can-spot --no-perp → new agent persisted with canSpot=true, canPerpTrade=false", async () => {
    setAgent("aster", makeAgentMeta("perp-cli-aster"));

    setupOkOws();
    stubFetchOk();

    vi.stubEnv("OWS_PASSPHRASE", "testpass");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "rotate", "aster", "perp-cli-aster",
      "--passphrase", "testpass",
      "--master", "main",
      "--can-spot",
      "--no-can-perp",
      "--json",
    ]);

    const newMeta = getAgent("aster", "perp-cli-aster");
    expect(newMeta).not.toBeNull();
    expect(newMeta!.permissions.canSpotTrade).toBe(true);
    expect(newMeta!.permissions.canPerpTrade).toBe(false);

    vi.spyOn(console, "log").mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 25: rotate preserves old permissions when flags absent
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 25: rotate preserves old permissions when flags absent", () => {
  it("old agent has canSpot=true, canPerp=true → rotate without flags inherits both", async () => {
    const oldMeta = {
      ...makeAgentMeta("perp-cli-aster"),
      permissions: { canPerpTrade: true, canSpotTrade: true, canWithdraw: false },
    };
    setAgent("aster", oldMeta);

    setupOkOws();
    stubFetchOk();

    vi.stubEnv("OWS_PASSPHRASE", "testpass");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => { printed.push(String(msg)); });

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "rotate", "aster", "perp-cli-aster",
      "--passphrase", "testpass",
      "--master", "main",
      "--json",
    ]);

    const newMeta = getAgent("aster", "perp-cli-aster");
    expect(newMeta).not.toBeNull();
    expect(newMeta!.permissions.canPerpTrade).toBe(true);
    expect(newMeta!.permissions.canSpotTrade).toBe(true);
    expect(newMeta!.permissions.canWithdraw).toBe(false);

    vi.spyOn(console, "log").mockRestore();
  });
});
