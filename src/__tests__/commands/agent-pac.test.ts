/**
 * Tests for Phase 2c — Pacifica agent wallet support.
 *
 * AC coverage: AC-29/30/31/32/33 from plan v3.5.
 * Covers approve/revoke/rotate commands, adapter 3-tier signer, and verify cross-check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";
import { Keypair } from "@solana/web3.js";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-pac-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

const MOCK_AGENT_WALLET = {
  id: "wallet-agent-pac-id",
  name: "agent-pac-main",
  accounts: [
    { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: "AgentPacBase58Address11111111111111111111111", derivationPath: "m/44'/501'/0'/0'" },
  ],
  createdAt: new Date().toISOString(),
};

const MOCK_MASTER_WALLET = {
  id: "wallet-master-pac-id",
  name: "main",
  accounts: [
    { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: "MasterPacBase58Address1111111111111111111111", derivationPath: "m/44'/501'/0'/0'" },
  ],
  createdAt: new Date().toISOString(),
};

// 64-byte Ed25519 signature in hex (no v byte — Solana Ed25519 is 64-byte fixed).
const FAKE_SIG_HEX = "1aee1548148536475582711c39958806646195b294c0bbc0d52ed8aae7798817" +
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

// ── Import modules after mocks ────────────────────────────────────────────

const { registerWalletAgentCommands } = await import("../../commands/agent.js");
const { getAgent, setAgent } = await import("../../agent-wallet/store.js");
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import { buildBindAgentMessage, buildUnbindAgentMessage } from "../../exchanges/pacifica-typed-data.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride();
  // Register `agent` as a subcommand of `wallet` to match the production
  // command tree post-consolidation (`perp wallet agent ...`).
  const walletCmd = prog.command("wallet").description("Wallet management");
  registerWalletAgentCommands(walletCmd, () => false);
  return prog;
}

function makePacAgentMeta(name = "perp-cli-pac") {
  return {
    agentName: name,
    agentWalletName: "agent-pac-main",
    agentEvmAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    userEvmAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    agentSolanaAddress: "AgentPacBase58Address11111111111111111111111",
    userSolanaAddress: "MasterPacBase58Address1111111111111111111111",
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
  mockOws.getWallet.mockReturnValue(MOCK_MASTER_WALLET);
  // OwsSolanaSigner.signMessage() calls ows.signMessage() and expects {signature, recoveryId}.
  // Pacifica signing uses 64-byte Ed25519 signatures (no recoveryId is read for solana).
  mockOws.signMessage.mockReturnValue({ signature: "0x" + FAKE_SIG_HEX, recoveryId: 0 });
}

/** Pacifica REST envelope: {success:true} */
function stubPacFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true }),
    text: async () => JSON.stringify({ success: true }),
  }));
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("HOME", TEST_HOME);
  // Ensure non-TTY so resolvePassphrase falls back to env/flag without prompting
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: PAC approve happy path (AC-29)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 1: PAC approve happy path (AC-29)", () => {
  it("approves agent, persists meta with agentSolanaAddress and userSolanaAddress", async () => {
    setupOkOws();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
      text: async () => JSON.stringify({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "pacifica",
        "--master", "main",
        "--agent-name", "perp-cli-pac",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch (e) {
      throw new Error(`Command failed. Stderr: ${stderrLines.join("")}. Exit err: ${e instanceof Error ? e.message : e}`);
    }

    const meta = getAgent("pacifica", "perp-cli-pac");
    expect(meta).toBeTruthy();
    expect(meta!.agentSolanaAddress).toBe("AgentPacBase58Address11111111111111111111111");
    expect(meta!.userSolanaAddress).toBe("MasterPacBase58Address1111111111111111111111");
    expect(meta!.owsApiKeyId).toBe("");       // Pacifica has no OWS API key
    expect(meta!.owsPolicyId).toBe("");
    expect(meta!.masterWalletName).toBe("main");
    expect(meta!.status).toBe("active");

    // Verify /api/v1/agent/bind was called with the correct shape
    expect(fetchMock).toHaveBeenCalled();
    const callUrl = fetchMock.mock.calls[0][0] as string;
    expect(callUrl).toMatch(/api\/v1\/agent\/bind/);
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(callBody.account).toBe("MasterPacBase58Address1111111111111111111111");
    expect(callBody.agent_wallet).toBe("AgentPacBase58Address11111111111111111111111");
    expect(callBody.type).toBe("bind_agent_wallet");
    expect(typeof callBody.signature).toBe("string");
    expect(typeof callBody.timestamp).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: PAC approve creates agent wallet with empty passphrase
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 2: PAC approve creates agent wallet with empty passphrase (P1 prompt-free hot-path)", () => {
  it("createWallet is called with empty string, NOT the master passphrase", async () => {
    setupOkOws();
    stubPacFetchOk();

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "pacifica",
      "--master", "main",
      "--agent-name", "perp-cli-pac",
      "--expires-in", "90d",
      "--passphrase", "supersecret",
      "--json",
    ]);

    expect(mockOws.createWallet).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-pac-/),
      "",
    );
    expect(mockOws.createWallet).not.toHaveBeenCalledWith(
      expect.anything(),
      "supersecret",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: PAC approve with custom expiry (30d)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 3: PAC approve --expires-in honored", () => {
  it("custom expiry persisted in meta.expiresAt", async () => {
    setupOkOws();
    stubPacFetchOk();
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    const before = Date.now();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "pacifica",
      "--master", "main",
      "--agent-name", "perp-cli-pac",
      "--expires-in", "30d",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("pacifica", "perp-cli-pac");
    expect(meta).toBeTruthy();
    const expiresMs = new Date(meta!.expiresAt).getTime();
    // 30 days in ms = 2592000000 — give a 60s window for test latency
    expect(expiresMs - before).toBeGreaterThanOrEqual(30 * 24 * 3600 * 1000 - 60_000);
    expect(expiresMs - before).toBeLessThanOrEqual(30 * 24 * 3600 * 1000 + 60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: PAC approve uses canonical JSON (sorted keys, no whitespace)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 4: PAC bind canonical JSON shape", () => {
  it("buildBindAgentMessage produces sorted, compact JSON", () => {
    const built = buildBindAgentMessage({
      account: "MasterPacBase58Address1111111111111111111111",
      agentWallet: "AgentPacBase58Address11111111111111111111111",
      timestamp: 1700000000000,
      expiryWindow: 5000,
    });

    // Sorted alphabetically: data < expiry_window < timestamp < type
    expect(built.canonicalJson).toBe(
      '{"data":{"agent_wallet":"AgentPacBase58Address11111111111111111111111"},"expiry_window":5000,"timestamp":1700000000000,"type":"bind_agent_wallet"}',
    );
    // No whitespace
    expect(built.canonicalJson).not.toMatch(/\s/);
    // Header captured for use in REST envelope
    expect(built.header.type).toBe("bind_agent_wallet");
    expect(built.header.timestamp).toBe(1700000000000);
    expect(built.header.expiry_window).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: PAC unbind canonical JSON
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 5: PAC unbind canonical JSON", () => {
  it("buildUnbindAgentMessage produces sorted JSON with unbind_agent_wallet type", () => {
    const built = buildUnbindAgentMessage({
      account: "MasterPacBase58Address1111111111111111111111",
      agentWallet: "AgentPacBase58Address11111111111111111111111",
      timestamp: 1700000000000,
      expiryWindow: 5000,
    });

    expect(built.canonicalJson).toBe(
      '{"data":{"agent_wallet":"AgentPacBase58Address11111111111111111111111"},"expiry_window":5000,"timestamp":1700000000000,"type":"unbind_agent_wallet"}',
    );
    expect(built.header.type).toBe("unbind_agent_wallet");
  });

  it("empty agent_wallet allowed (revoke-all convention)", () => {
    const built = buildUnbindAgentMessage({
      account: "MasterPacBase58Address1111111111111111111111",
      agentWallet: "",
      timestamp: 1700000000000,
      expiryWindow: 5000,
    });
    expect(built.canonicalJson).toContain('"agent_wallet":""');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: PAC revoke happy path (AC-30)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 6: PAC revoke happy path (AC-30)", () => {
  it("sends signed unbind action and deletes settings entry", async () => {
    setupOkOws();
    setAgent("pacifica", makePacAgentMeta());

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
      text: async () => JSON.stringify({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "revoke", "pacifica", "perp-cli-pac",
      "--passphrase", "testpass",
      "--json",
    ]);

    expect(getAgent("pacifica", "perp-cli-pac")).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(callBody.type).toBe("unbind_agent_wallet");
    expect(callBody.agent_wallet).toBe("AgentPacBase58Address11111111111111111111111");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: PAC revoke when network fails — still clears local state (best-effort)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 7: PAC revoke best-effort on network failure", () => {
  it("network error in revoke POST → settings still cleared", async () => {
    setupOkOws();
    setAgent("pacifica", makePacAgentMeta());

    const fetchMock = vi.fn().mockRejectedValue(new Error("ENETUNREACH"));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLines.push(args.map(String).join(" "));
    });

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "revoke", "pacifica", "perp-cli-pac",
      "--passphrase", "testpass",
      "--json",
    ]);

    // settings still cleared (revoke is best-effort)
    expect(getAgent("pacifica", "perp-cli-pac")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: PAC rotate end-to-end (AC-31)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 8: PAC rotate (AC-31)", () => {
  it("revokes existing and approves with same name; final settings has new agent", async () => {
    setupOkOws();
    setAgent("pacifica", makePacAgentMeta("perp-cli-pac"));

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "rotate", "pacifica", "perp-cli-pac",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("pacifica", "perp-cli-pac");
    expect(meta).toBeTruthy();
    expect(meta!.agentSolanaAddress).toBe("AgentPacBase58Address11111111111111111111111");
    // Two fetch calls: one revoke + one approve
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: PAC approve with --no-perp permission flag
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 9: PAC approve --can-spot persists permissions.canSpotTrade=true", () => {
  it("persisted meta has canSpotTrade=true when --can-spot supplied", async () => {
    setupOkOws();
    stubPacFetchOk();

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "pacifica",
      "--master", "main",
      "--agent-name", "perp-cli-pac",
      "--expires-in", "90d",
      "--can-spot",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("pacifica", "perp-cli-pac");
    expect(meta!.permissions.canSpotTrade).toBe(true);
    expect(meta!.permissions.canPerpTrade).toBe(true);  // default
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 10-12: PacificaAdapter 3-tier signer (AC-32)
// ─────────────────────────────────────────────────────────────────────────────

function makeSolanaSigner(address: string) {
  return {
    getPublicKeyBase58: () => address,
    signMessage: vi.fn().mockResolvedValue(new Uint8Array(64)),
    signTransaction: vi.fn(),
    partialSignTransaction: vi.fn(),
  };
}

describe("Test 10: PacificaAdapter Tier 1 selection", () => {
  it("agent + master + PK all set → activeSignerTier === 'agent'", () => {
    // Adapter created with a real keypair (Tier 3 PK)
    const adapter = new PacificaAdapter(Keypair.generate(), "mainnet", "PERPCLI", true);
    // Tier 2: master signer
    adapter.setSigner(makeSolanaSigner("MasterPacBase58Address1111111111111111111111") as never);
    // Tier 1: agent
    adapter.setAgentSigner(
      makePacAgentMeta(),
      makeSolanaSigner("AgentPacBase58Address11111111111111111111111") as never,
    );

    expect(adapter.activeSignerTier).toBe("agent");
  });
});

describe("Test 11: PacificaAdapter --no-agent bypass (AC-32)", () => {
  it("setNoAgent(true) → Tier 1 skipped even when agent is set", () => {
    const adapter = new PacificaAdapter(Keypair.generate(), "mainnet", "PERPCLI", true);
    adapter.setSigner(makeSolanaSigner("MasterPacBase58Address1111111111111111111111") as never);
    adapter.setAgentSigner(
      makePacAgentMeta(),
      makeSolanaSigner("AgentPacBase58Address11111111111111111111111") as never,
    );
    adapter.setNoAgent(true);
    expect(adapter.activeSignerTier).toBe("master");
  });
});

describe("Test 12: PacificaAdapter NO_SIGNER_AVAILABLE", () => {
  it("no agent, no master, hasRealKey=false → activeSignerTier is null (read-only)", () => {
    // hasRealKey=false → no Tier 3 PK
    const adapter = new PacificaAdapter(Keypair.generate(), "mainnet", "PERPCLI", false);
    expect(adapter.isReadOnly).toBe(true);
    expect(adapter.activeSignerTier).toBeNull();
  });
});

describe("Test 13: PacificaAdapter AGENT_EXPIRED with fallback", () => {
  it("expired agent + master available → falls through to master", () => {
    const adapter = new PacificaAdapter(Keypair.generate(), "mainnet", "PERPCLI", false);
    const expiredMeta = makePacAgentMeta();
    expiredMeta.expiresAt = new Date(Date.now() - 1000).toISOString();
    adapter.setAgentSigner(
      expiredMeta,
      makeSolanaSigner("AgentPacBase58Address11111111111111111111111") as never,
    );
    adapter.setSigner(makeSolanaSigner("MasterPacBase58Address1111111111111111111111") as never);
    expect(adapter.activeSignerTier).toBe("master");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 14: PAC approve rolls back on POST failure (APPROVE_PARTIAL)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 14: PAC approve rollback on POST failure", () => {
  it("Pacifica REST POST returns 500 → APPROVE_PARTIAL envelope, no settings entry", async () => {
    setupOkOws();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
      json: async () => ({ success: false, error: "internal error" }),
    }));

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    let threw = false;
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "pacifica",
        "--master", "main",
        "--agent-name", "perp-cli-pac-fail",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(stderrOutput.join("")).toContain("APPROVE_PARTIAL");
    // No settings entry should have been persisted
    expect(getAgent("pacifica", "perp-cli-pac-fail")).toBeNull();
  });
});
