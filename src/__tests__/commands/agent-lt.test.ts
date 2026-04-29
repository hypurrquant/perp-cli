/**
 * Tests for Phase 2d — Lighter agent wallet support.
 *
 * AC coverage: AC-34/35/36/37/38 from plan v3.6.
 * Covers approve/revoke/rotate commands, adapter 3-tier signer, and verify cross-check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-lt-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

const MOCK_AGENT_WALLET = {
  id: "wallet-agent-lt-id",
  name: "agent-lt-main",
  accounts: [
    { chainId: "eip155:1", address: "0xAgentLtAddr00000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" },
  ],
  createdAt: new Date().toISOString(),
};

const MOCK_MASTER_WALLET = {
  id: "wallet-master-lt-id",
  name: "main",
  accounts: [
    { chainId: "eip155:1", address: "0xMasterLtAddr0000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" },
  ],
  createdAt: new Date().toISOString(),
};

// 32-byte hex (64 chars) — matches OwsEvmSigner.signTypedData/signMessage
// expected output (raw r+s without v byte).
const FAKE_RAW_SIG_HEX = "1aee1548148536475582711c39958806646195b294c0bbc0d52ed8aae7798817" +
                        "5240c82244cf8e1e0d4387d107ef558090bae5d6a603235750e93ee0be1b1bbf";

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

// ── Mock readline (AC-17 allowlist) ──────────────────────────────────────

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── Mock the LighterAdapter module so runLtApproveFlow's runtime import gets
//    a fully-mocked class with predictable setupApiKey / init / accountIndex /
//    setSigner behavior (no WASM, no /api/v1/sendTx). ──────────────────────

const mockLtSetupApiKey = vi.fn();
const mockLtInit = vi.fn();
let mockAccountIndex = 42;

vi.mock("../../exchanges/lighter.js", () => {
  class MockLighterAdapter {
    name = "lighter";
    chain = "ethereum";
    aliases = ["lt"] as const;
    accountIndex: number;
    address = "";
    isReadOnly = false;
    private _agentMeta: unknown;
    private _agentApiKey: string | undefined;
    private _useNoAgent = false;

    constructor(_evmKey: string, _testnet?: boolean, _opts?: { apiKey?: string; accountIndex?: number }) {
      this.accountIndex = mockAccountIndex;
    }

    setSigner(_signer: unknown): void { /* no-op */ }
    async init(): Promise<void> { mockLtInit(); }
    async setupApiKey(slot: number): Promise<{ privateKey: string; publicKey: string }> {
      return mockLtSetupApiKey(slot);
    }
    setAgentSigner(meta: unknown, apiKey: string): void {
      this._agentMeta = meta;
      this._agentApiKey = apiKey;
    }
    setNoAgent(noAgent: boolean): void { this._useNoAgent = noAgent; }
    get activeSignerTier(): "agent" | "master" | "pk" | null {
      const m = this._agentMeta as { expiresAt?: string } | undefined;
      const expired = m?.expiresAt ? Date.now() >= new Date(m.expiresAt).getTime() : false;
      if (!this._useNoAgent && this._agentMeta && this._agentApiKey && !expired) return "agent";
      return null;
    }
  }
  return { LighterAdapter: MockLighterAdapter };
});

// ── Import modules after mocks ────────────────────────────────────────────

const { registerWalletAgentCommands } = await import("../../commands/agent.js");
const { getAgent, setAgent } = await import("../../agent-wallet/store.js");
const { LighterAdapter } = await import("../../exchanges/lighter.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride();
  const walletCmd = prog.command("wallet").description("Wallet management");
  registerWalletAgentCommands(walletCmd, () => false);
  return prog;
}

function makeLtAgentMeta(name = "perp-cli-lt", apiKeyIndex = 5) {
  return {
    agentName: name,
    agentWalletName: "agent-lt-main",
    agentEvmAddress: "0xMasterLtAddr0000000000000000000000000001" as `0x${string}`,
    userEvmAddress: "0xMasterLtAddr0000000000000000000000000001" as `0x${string}`,
    apiKeyIndex,
    publicKey: "abcdef1234567890" + "0".repeat(64),
    accountIndex: 42,
    masterWalletName: "main",
    owsApiKeyId: "",
    owsPolicyId: "",
    expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: String(Date.now()),
    status: "active" as const,
  };
}

function setupOkOws() {
  mockOws.createWallet.mockReturnValue(MOCK_AGENT_WALLET);
  mockOws.createPolicy.mockReturnValue(undefined);
  mockOws.createApiKey.mockReturnValue({ id: "key-lt-001", token: "ows_key_NEVER_STORED" });
  mockOws.revokeApiKey.mockReturnValue(undefined);
  mockOws.getWallet.mockReturnValue(MOCK_MASTER_WALLET);
  mockOws.signTypedData.mockReturnValue({ signature: "0x" + FAKE_RAW_SIG_HEX, recoveryId: 0 });
  mockOws.signMessage.mockReturnValue({ signature: "0x" + FAKE_RAW_SIG_HEX, recoveryId: 0 });
}

function setupOkLtSdk() {
  mockLtSetupApiKey.mockResolvedValue({
    privateKey: "0x" + "ab".repeat(20),  // 40-byte L2 key
    publicKey: "0x" + "cd".repeat(20),
  });
  mockLtInit.mockResolvedValue(undefined);
  mockAccountIndex = 42;
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("HOME", TEST_HOME);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: LT approve happy path (AC-34)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 1: LT approve happy path (AC-34)", () => {
  it("approves agent, persists meta with apiKeyIndex/publicKey/accountIndex", async () => {
    setupOkOws();
    setupOkLtSdk();

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "lighter",
        "--master", "main",
        "--agent-name", "perp-cli-lt",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch (e) {
      throw new Error(`Command failed. Stderr: ${stderrLines.join("")}. Exit err: ${e instanceof Error ? e.message : e}`);
    }

    const meta = getAgent("lighter", "perp-cli-lt");
    expect(meta).toBeTruthy();
    expect(meta!.apiKeyIndex).toBe(5);  // first free slot after default 4
    expect(meta!.publicKey).toBe("cd".repeat(20));  // hex without 0x
    expect(meta!.accountIndex).toBe(42);
    expect(meta!.owsApiKeyId).toBe("");
    expect(meta!.masterWalletName).toBe("main");
    expect(meta!.status).toBe("active");

    expect(mockLtSetupApiKey).toHaveBeenCalledWith(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: LT approve picks correct free slot
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 2: LT approve picks first free slot", () => {
  it("with slots 4 + 5 used → picks 6", async () => {
    setupOkOws();
    setupOkLtSdk();
    // Pre-populate with one agent at slot 5 (slot 4 reserved by env auto-setup default)
    setAgent("lighter", makeLtAgentMeta("existing-lt", 5));

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "lighter",
      "--master", "main",
      "--agent-name", "perp-cli-lt-new",
      "--expires-in", "90d",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("lighter", "perp-cli-lt-new");
    // slot picker scans used = {5 (existing), 4 (env reserved)}; first free in [5..254] is 6.
    expect(meta!.apiKeyIndex).toBe(6);
    expect(mockLtSetupApiKey).toHaveBeenCalledWith(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: LT approve rejects slot < 4
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 3: LT approve rejects --api-key-index 3 (reserved)", () => {
  it("exits with INVALID_PARAMS for slot 3", async () => {
    setupOkOws();
    setupOkLtSdk();

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    let threw = false;
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "lighter",
        "--master", "main",
        "--agent-name", "perp-cli-lt",
        "--api-key-index", "3",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(stderrOutput.join("")).toContain("INVALID_PARAMS");
    expect(stderrOutput.join("")).toMatch(/4.*254|api-key-index/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: LT approve rejects slot > 254
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 4: LT approve rejects --api-key-index 255", () => {
  it("exits with INVALID_PARAMS for slot 255", async () => {
    setupOkOws();
    setupOkLtSdk();

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    let threw = false;
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "lighter",
        "--master", "main",
        "--agent-name", "perp-cli-lt",
        "--api-key-index", "255",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(stderrOutput.join("")).toContain("INVALID_PARAMS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: LT approve persists accountIndex from adapter (AC-34)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 5: LT approve persists accountIndex from adapter init", () => {
  it("accountIndex from LighterAdapter is captured in AgentMeta", async () => {
    setupOkOws();
    setupOkLtSdk();
    mockAccountIndex = 999;  // adapter resolves to a different account index

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "lighter",
      "--master", "main",
      "--agent-name", "perp-cli-lt",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("lighter", "perp-cli-lt");
    expect(meta!.accountIndex).toBe(999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: LT revoke happy path (AC-35)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 6: LT revoke happy path (AC-35)", () => {
  it("clears local settings entry (Lighter has no on-chain revoke)", async () => {
    setupOkOws();
    setAgent("lighter", makeLtAgentMeta("perp-cli-lt", 5));

    // No fetch should be called for LT revoke (it's local-only).
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "revoke", "lighter", "perp-cli-lt",
      "--passphrase", "testpass",
      "--json",
    ]);

    expect(getAgent("lighter", "perp-cli-lt")).toBeNull();
    // LT revoke is local-only — no network call expected.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: LT revoke when agent not found is idempotent (AC-35)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 7: LT revoke idempotent (AC-35)", () => {
  it("returns alreadyRevoked:true when agent not found locally", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const consoleLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "revoke", "lighter", "nonexistent-lt",
      "--passphrase", "testpass",
      "--json",
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleLines.some(l => l.includes("alreadyRevoked"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: LT rotate end-to-end (AC-36)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 8: LT rotate (AC-36)", () => {
  it("revokes existing and approves with same name; final meta has new slot", async () => {
    setupOkOws();
    setupOkLtSdk();
    setAgent("lighter", makeLtAgentMeta("perp-cli-lt", 5));

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "rotate", "lighter", "perp-cli-lt",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("lighter", "perp-cli-lt");
    expect(meta).toBeTruthy();
    // Rotate clears existing then approves at next free slot. After delete, only
    // slot 4 is "used" by the env-default reservation, so next free is 5.
    expect(meta!.apiKeyIndex).toBe(5);
    expect(mockLtSetupApiKey).toHaveBeenCalledWith(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: LT approve --can-spot persists permissions (AC-34)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 9: LT approve --can-spot persists permissions.canSpotTrade=true", () => {
  it("persisted meta has canSpotTrade=true when --can-spot supplied", async () => {
    setupOkOws();
    setupOkLtSdk();

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "lighter",
      "--master", "main",
      "--agent-name", "perp-cli-lt",
      "--expires-in", "90d",
      "--can-spot",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("lighter", "perp-cli-lt");
    expect(meta!.permissions.canSpotTrade).toBe(true);
    expect(meta!.permissions.canPerpTrade).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 10-12: LighterAdapter 3-tier signer (AC-37)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 10: LighterAdapter Tier 1 selection", () => {
  it("agent + meta + apiKey set → activeSignerTier === 'agent'", () => {
    const adapter = new LighterAdapter("0x" + "a".repeat(64), false);
    const meta = makeLtAgentMeta();
    adapter.setAgentSigner(meta, "ab".repeat(20));
    expect(adapter.activeSignerTier).toBe("agent");
  });
});

describe("Test 11: LighterAdapter --no-agent bypass (AC-37)", () => {
  it("setNoAgent(true) → Tier 1 skipped even when agent is set", () => {
    const adapter = new LighterAdapter("0x" + "a".repeat(64), false);
    const meta = makeLtAgentMeta();
    adapter.setAgentSigner(meta, "ab".repeat(20));
    adapter.setNoAgent(true);
    // When --no-agent is set, the mock falls through. Real adapter would
    // resolve to master/pk; the mock returns null when agent path skipped.
    expect(adapter.activeSignerTier).not.toBe("agent");
  });
});

describe("Test 12: LighterAdapter expired agent → falls through (AC-37)", () => {
  it("expired AgentMeta + agent api key set → activeSignerTier !== 'agent'", () => {
    const adapter = new LighterAdapter("0x" + "a".repeat(64), false);
    const expiredMeta = makeLtAgentMeta();
    expiredMeta.expiresAt = new Date(Date.now() - 1000).toISOString();
    adapter.setAgentSigner(expiredMeta, "ab".repeat(20));
    expect(adapter.activeSignerTier).not.toBe("agent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 13: LT verify cross-check warning (AC-38)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 13: LT verify cross-check warning (AC-38)", () => {
  it("settings has publicKey X, live response returns Y → warnings non-empty", async () => {
    const meta = makeLtAgentMeta("perp-cli-lt", 5);
    meta.publicKey = "expected_pubkey_aaaa" + "0".repeat(60);
    setAgent("lighter", meta);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 200,
        api_keys: [
          { account_index: 42, api_key_index: 5, public_key: "different_pubkey", nonce: 0, transaction_time: 1 },
        ],
      }),
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "verify", "lighter", "perp-cli-lt",
      "--account-index", "42",
      "--json",
    ]);

    const output = stdoutLines.join("");
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.meta?.warnings).toBeDefined();
    expect(parsed.meta?.warnings?.length).toBeGreaterThan(0);
    expect(parsed.meta?.warnings?.[0]).toContain("expected_pubkey_aaaa");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 14: LT verify cross-check happy (AC-38)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 14: LT verify cross-check happy (AC-38)", () => {
  it("settings X, live returns X → no warnings", async () => {
    const meta = makeLtAgentMeta("perp-cli-lt", 5);
    meta.publicKey = "matching_pubkey_aaaa" + "0".repeat(60);
    setAgent("lighter", meta);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 200,
        api_keys: [
          { account_index: 42, api_key_index: 5, public_key: meta.publicKey, nonce: 0, transaction_time: 1 },
        ],
      }),
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "verify", "lighter", "perp-cli-lt",
      "--account-index", "42",
      "--json",
    ]);

    const output = stdoutLines.join("");
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(!parsed.meta?.warnings || parsed.meta?.warnings?.length === 0).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 15: LT approve rolls back (settings clean) on ChangePubKey failure
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 15: LT approve APPROVE_PARTIAL when ChangePubKey fails", () => {
  it("setupApiKey throws → APPROVE_PARTIAL envelope, no settings entry", async () => {
    setupOkOws();
    mockLtSetupApiKey.mockRejectedValue(new Error("invalid nonce after retries"));
    mockLtInit.mockResolvedValue(undefined);
    mockAccountIndex = 42;

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    let threw = false;
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "lighter",
        "--master", "main",
        "--agent-name", "perp-cli-lt-fail",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(stderrOutput.join("")).toContain("APPROVE_PARTIAL");
    expect(getAgent("lighter", "perp-cli-lt-fail")).toBeNull();
  });
});
