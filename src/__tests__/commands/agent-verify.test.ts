/**
 * Tests for `perp agent verify` command (Plan v3.3 AC-21/22/23).
 *
 * Covers: Aster, Hyperliquid, Pacifica, Lighter single-DEX happy paths,
 * auth-field assertions, mismatch warnings, aggregate mode, partial failure,
 * empty-result registered=false, and JSON envelope shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-av-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

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

// ── Mock globalThis.fetch ─────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Import modules after mocks ────────────────────────────────────────────

const { registerWalletAgentCommands } = await import("../../commands/agent.js");
const { loadSettings, saveSettings } = await import("../../settings.js");

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

/** Captured stdout/stderr lines during a command run */
interface Captured {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

async function runVerify(args: string[]): Promise<Captured> {
  const captured: Captured = { stdout: [], stderr: [], exitCode: null };

  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    captured.stdout.push(String(chunk));
    return true;
  });
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((...msgs: unknown[]) => {
    captured.stdout.push(msgs.map(String).join(" "));
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    captured.stderr.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
    captured.exitCode = typeof code === "number" ? code : 1;
    throw new Error(`process.exit(${code})`);
  });

  try {
    const prog = makeProgram();
    await prog.parseAsync(["node", "perp", "wallet", "agent", "verify", ...args]);
  } catch (err) {
    // Swallow exit throws and commander's exitOverride
    if (!(err instanceof Error) || (!err.message.startsWith("process.exit") && !err.message.includes("outputHelp"))) {
      if (captured.exitCode === null) {
        outSpy.mockRestore();
        consoleSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
        throw err;
      }
    }
  } finally {
    outSpy.mockRestore();
    consoleSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return captured;
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  mockFetch.mockReset();

  // Default OWS mock: EVM wallet for Aster master signer
  mockOws.getWallet.mockReturnValue({
    id: "wallet-master",
    accounts: [
      { chainId: "eip155:56", address: "0xMASTER0000000000000000000000000000000001" },
      { chainId: "solana:mainnet", address: "MasterSolanaPubkey11111111111111111111111" },
    ],
  });
  // 64-byte (r+s) hex sig + canonical recoveryId; canonicalizeOwsSignature
  // appends v=0x1b to produce the 65-byte EIP-712 signature production code expects.
  mockOws.signTypedData.mockReturnValue({
    signature: "0x" + "aa".repeat(32) + "bb".repeat(32),
    recoveryId: 0,
  });
  mockOws.signMessage.mockReturnValue({ signature: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899" });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

// ── Setup settings with owsActiveWallet ──────────────────────────────────

function initSettings(extra: Record<string, unknown> = {}) {
  const settings = loadSettings();
  saveSettings({ ...settings, owsActiveWallet: "main", ...extra } as ReturnType<typeof loadSettings>);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("perp agent verify", () => {

  // 1. Aster local-cache verify (live API path is unsupported per FE pattern)
  it("aster — returns local cache from settings.agents.aster with unsupported-warning", async () => {
    const settings = loadSettings();
    const agents = {
      aster: {
        "perp-cli-aster": {
          agentName: "perp-cli-aster",
          agentWalletName: "agent-aster-main",
          agentEvmAddress: "0xAGENT0000000000000000000000000000000001" as `0x${string}`,
          userEvmAddress: "0xMASTER0000000000000000000000000000000001" as `0x${string}`,
          masterWalletName: "main",
          owsApiKeyId: "k",
          owsPolicyId: "p",
          expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          approvedAt: new Date().toISOString(),
          permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
          asterApprovalNonce: "1",
          status: "active" as const,
        },
      },
    };
    saveSettings({ ...settings, owsActiveWallet: "main", agents } as ReturnType<typeof loadSettings>);

    const out = await runVerify(["aster", "--json"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.registered).toBe(true);
    expect(json.data.count).toBe(1);
    expect(json.data.items[0]).toMatchObject({
      agentAddress: "0xAGENT0000000000000000000000000000000001",
      canPerpTrade: true,
      source: "local-cache",
    });
    expect(json.data.exchange).toBe("aster");
    // No live HTTP call should be made
    expect(mockFetch).not.toHaveBeenCalled();
    expect(json.meta.warnings.join(" ")).toMatch(/unsupported|local cache/i);
  });

  // 3. HL happy path — registered:true, correct body shape
  it("hyperliquid happy path — registered:true, unauth body", async () => {
    initSettings();
    const hlItem = { address: "0xAGENT0000000000000000000000000000000001", validUntil: 9999999999, name: "test" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [hlItem],
    });

    const out = await runVerify(["hyperliquid", "--json", "--master-address", "0xMASTER0000000000000000000000000000000001"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.registered).toBe(true);
    expect(json.data.count).toBe(1);

    // Verify request body shape
    const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
    expect(body.type).toBe("extraAgents");
    expect(body.user).toBe("0xmaster0000000000000000000000000000000001"); // lowercase
  });

  // 4. HL unauth — no signature field in body
  it("hyperliquid — request body keys are exactly [type, user] (no signature)", async () => {
    initSettings();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await runVerify(["hl", "--json", "--master-address", "0xMASTER0000000000000000000000000000000001"]);

    const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(["type", "user"]);
  });

  // 5. PAC happy path — api_keys returned, body shape correct
  it("pacifica happy path — registered:true, body contains type:list_api_keys", async () => {
    initSettings();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { api_keys: [{ api_key: "key1", created_at: 1234 }] },
      }),
    });

    const out = await runVerify(["pacifica", "--json", "--master", "main"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.registered).toBe(true);
    expect(json.data.count).toBe(1);

    const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
    expect(body.type).toBe("list_api_keys");
    expect(body.agent_wallet).toBeNull();
    expect(body.expiry_window).toBe(5000);
    expect(typeof body.timestamp).toBe("number");
    expect(typeof body.account).toBe("string");
  });

  // 6. PAC — Ed25519 signature present (base58-shaped string)
  it("pacifica — body has signature field (non-empty string, base58 chars only)", async () => {
    initSettings();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { api_keys: [] } }),
    });

    await runVerify(["pac", "--json", "--master", "main"]);

    const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
    expect(typeof body.signature).toBe("string");
    expect((body.signature as string).length).toBeGreaterThan(0);
    // Base58 alphabet only
    expect(body.signature).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/);
  });

  // 7. LT happy path — url has account_index, items returned
  it("lighter happy path — URL has account_index param, items preserved", async () => {
    initSettings();
    const ltItem = { account_index: 1, api_key_index: 4, nonce: 0, public_key: "abc123", transaction_time: 123 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, api_keys: [ltItem] }),
    });

    const out = await runVerify(["lighter", "--json", "--account-index", "1"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.registered).toBe(true);
    expect(json.data.count).toBe(1);
    expect(json.data.items[0]).toMatchObject({ api_key_index: 4, public_key: "abc123" });

    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain("account_index=1");
  });

  // 8. LT unauth — GET, no body, no Authorization header
  it("lighter — fetch called with GET, no body, no Authorization header", async () => {
    initSettings();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, api_keys: [] }),
    });

    await runVerify(["lt", "--json", "--account-index", "1"]);

    const callOpts = mockFetch.mock.calls[0][1] as RequestInit | undefined;
    // GET request — either method GET or no method (default GET)
    if (callOpts?.method) {
      expect(callOpts.method.toUpperCase()).toBe("GET");
    }
    expect(callOpts?.body).toBeFalsy();
    const headers = callOpts?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
    expect(headers?.["authorization"]).toBeUndefined();
  });

  // 9. Aster — agentName not in local cache surfaces "no local entry" warning
  it("aster agentName not in local cache — meta.warnings includes 'no local entry'", async () => {
    const settings = loadSettings();
    const agents = {
      aster: {
        agent1: {
          agentName: "agent1",
          agentWalletName: "agent-aster-main",
          agentEvmAddress: "0xEXPECTED000000000000000000000000000000001" as `0x${string}`,
          userEvmAddress: "0xMASTER0000000000000000000000000000000001" as `0x${string}`,
          masterWalletName: "main",
          owsApiKeyId: "key-001",
          owsPolicyId: "policy-001",
          expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          approvedAt: new Date().toISOString(),
          permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
          asterApprovalNonce: "12345000000",
          status: "active" as const,
        },
      },
    };
    saveSettings({ ...settings, owsActiveWallet: "main", agents } as ReturnType<typeof loadSettings>);

    // Ask about an agent name that isn't in the cache
    const out = await runVerify(["aster", "missing-agent", "--json"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.meta.warnings).toBeDefined();
    expect(json.meta.warnings.some((w: string) => /no local entry/i.test(w))).toBe(true);
  });

  // 10. Aggregate happy — all 4 DEXs, 4-key data object
  it("aggregate happy path — 4-key data object with registered/count/items per DEX", async () => {
    // Aster slot reads from settings.agents.aster (live API path is unsupported)
    const settings = loadSettings();
    const agents = {
      aster: {
        a: {
          agentName: "a",
          agentWalletName: "agent-aster-main",
          agentEvmAddress: "0xA000000000000000000000000000000000000001" as `0x${string}`,
          userEvmAddress: "0xMASTER0000000000000000000000000000000001" as `0x${string}`,
          masterWalletName: "main",
          owsApiKeyId: "k",
          owsPolicyId: "p",
          expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          approvedAt: new Date().toISOString(),
          permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
          asterApprovalNonce: "1",
          status: "active" as const,
        },
      },
    };
    saveSettings({ ...settings, owsActiveWallet: "main", agents } as ReturnType<typeof loadSettings>);
    mockFetch.mockReset();

    // Route remaining DEXs by URL so order of parallel fetch calls doesn't matter
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("hyperliquid.xyz")) {
        return Promise.resolve({ ok: true, json: async () => [{ address: "0xB", validUntil: 9999, name: "b" }] });
      }
      if (typeof url === "string" && url.includes("pacifica.fi")) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { api_keys: [{ api_key: "k1" }] } }) });
      }
      if (typeof url === "string" && url.includes("zklighter")) {
        return Promise.resolve({ ok: true, json: async () => ({ code: 200, api_keys: [{ api_key_index: 4, public_key: "pk1", nonce: 0, transaction_time: 100 }] }) });
      }
      return Promise.reject(new Error(`Unexpected fetch url: ${url}`));
    });

    const out = await runVerify(["--json", "--master", "main", "--master-address", "0xMASTER0000000000000000000000000000000001", "--account-index", "1"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data).toHaveProperty("aster");
    expect(json.data).toHaveProperty("hyperliquid");
    expect(json.data).toHaveProperty("pacifica");
    expect(json.data).toHaveProperty("lighter");
    expect((json.data.aster as Record<string, unknown>).registered).toBe(true);
    expect((json.data.aster as Record<string, unknown>).count).toBe(1);
  });

  // 11. Aggregate partial failure — one DEX fails, others succeed
  it("aggregate partial failure — lighter 500 → error slot, others ok, top-level ok:true", async () => {
    // Aster reads from settings; clear cache so registered:false
    const settings = loadSettings();
    saveSettings({ ...settings, owsActiveWallet: "main", agents: { aster: {} } } as ReturnType<typeof loadSettings>);
    mockFetch.mockReset();

    // Route by URL; lighter throws network error. (Aster is not fetched.)
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("hyperliquid.xyz")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (typeof url === "string" && url.includes("pacifica.fi")) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { api_keys: [] } }) });
      }
      if (typeof url === "string" && url.includes("zklighter")) {
        return Promise.reject(new Error("network error on lighter"));
      }
      return Promise.reject(new Error(`Unexpected fetch url: ${url}`));
    });

    const out = await runVerify(["--json", "--master", "main", "--master-address", "0xMASTER0000000000000000000000000000000001", "--account-index", "1"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    // lighter slot should have error
    expect(json.data.lighter).toHaveProperty("error");
    expect((json.data.lighter as { error: { message: string } }).error.message).toMatch(/network error/i);
    // aster (empty cache), hl, pacifica should be ok (registered:false, count:0)
    expect((json.data.aster as Record<string, unknown>).count).toBe(0);
    expect((json.data.aster as Record<string, unknown>).registered).toBe(false);
  });

  // 12. Empty result → registered=false, count=0, items=[]
  it("aster empty cache — registered=false, count=0, items=[], no fetch", async () => {
    const settings = loadSettings();
    saveSettings({ ...settings, owsActiveWallet: "main", agents: { aster: {} } } as ReturnType<typeof loadSettings>);
    mockFetch.mockReset();

    const out = await runVerify(["aster", "--json"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.registered).toBe(false);
    expect(json.data.count).toBe(0);
    expect(json.data.items).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(json.meta.warnings.join(" ")).toMatch(/non-authoritative|local cache/i);
  });

  // 13. JSON envelope shape — meta.timestamp is ISO-8601
  it("JSON envelope — meta.timestamp is ISO-8601 string", async () => {
    initSettings();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const out = await runVerify(["aster", "--json", "--master", "main"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.meta).toBeDefined();
    expect(typeof json.meta.timestamp).toBe("string");
    // ISO-8601 regex: YYYY-MM-DDTHH:mm:ss...Z
    expect(json.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Must be parseable as a date
    expect(isNaN(Date.parse(json.meta.timestamp))).toBe(false);
  });

  // 14. Aster non-JSON text output renders expiry (regression: text reader uses `expired`, not `expiresAt`)
  it("aster text output renders expired ms — not '—'", async () => {
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const expiresMs = Date.parse(expiresAt);
    const settings = loadSettings();
    const agents = {
      aster: {
        "perp-cli-aster": {
          agentName: "perp-cli-aster",
          agentWalletName: "agent-aster-main",
          agentEvmAddress: "0xAGENT0000000000000000000000000000000001" as `0x${string}`,
          userEvmAddress: "0xMASTER0000000000000000000000000000000001" as `0x${string}`,
          masterWalletName: "main",
          owsApiKeyId: "k",
          owsPolicyId: "p",
          expiresAt,
          approvedAt: new Date().toISOString(),
          permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
          asterApprovalNonce: "1",
          status: "active" as const,
        },
      },
    };
    saveSettings({ ...settings, owsActiveWallet: "main", agents } as ReturnType<typeof loadSettings>);

    // No --json: text output
    const out = await runVerify(["aster"]);
    const text = out.stdout.join("");
    // Renderer reads `expired` (ms epoch) — value should be the parsed ms, NOT "—"
    expect(text).toContain(String(expiresMs));
    expect(text).not.toMatch(/\| {2}—/);
  });

  // 14b. Aggregate text mode surfaces per-DEX warnings (regression: warnings were dropped)
  it("aggregate text mode includes per-DEX warnings", async () => {
    const settings = loadSettings();
    saveSettings({ ...settings, owsActiveWallet: "main", agents: { aster: {} } } as ReturnType<typeof loadSettings>);
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("hyperliquid.xyz")) return Promise.resolve({ ok: true, json: async () => [] });
      if (url.includes("pacifica.fi")) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { api_keys: [] } }) });
      if (url.includes("zklighter")) return Promise.resolve({ ok: true, json: async () => ({ code: 200, api_keys: [] }) });
      return Promise.reject(new Error(`Unexpected fetch url: ${url}`));
    });

    // No --json: text output (aggregate over all 4 DEX)
    const out = await runVerify(["--master", "main", "--master-address", "0xMASTER0000000000000000000000000000000001", "--account-index", "1"]);
    const text = out.stdout.join("");
    // Aster warning must appear in text output
    expect(text).toMatch(/non-authoritative|local cache/i);
    expect(text).toContain("[warn]");
  });

  // 15. Aster locally-expired cache surfaces warning
  it("aster locally-expired entry → meta.warnings flags expiry", async () => {
    const expiresAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // 1 day ago
    const settings = loadSettings();
    const agents = {
      aster: {
        "stale-agent": {
          agentName: "stale-agent",
          agentWalletName: "agent-aster-main",
          agentEvmAddress: "0xAGENT0000000000000000000000000000000099" as `0x${string}`,
          userEvmAddress: "0xMASTER0000000000000000000000000000000001" as `0x${string}`,
          masterWalletName: "main",
          owsApiKeyId: "k",
          owsPolicyId: "p",
          expiresAt,
          approvedAt: new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString(),
          permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
          asterApprovalNonce: "1",
          status: "active" as const,
        },
      },
    };
    saveSettings({ ...settings, owsActiveWallet: "main", agents } as ReturnType<typeof loadSettings>);

    const out = await runVerify(["aster", "--json"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.meta.warnings.some((w: string) => /locally expired/i.test(w))).toBe(true);
  });

});
