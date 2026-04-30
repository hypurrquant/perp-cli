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

  // 1. Aster verify is NOT_IMPLEMENTED (no-fallback policy: throw, don't synthesize)
  it("aster — throws NOT_IMPLEMENTED with remediation pointing to wallet agent list", async () => {
    initSettings();
    const out = await runVerify(["aster", "--json"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("NOT_IMPLEMENTED");
    expect(json.error.message).toMatch(/aster.*not supported|live.*agent verify.*not supported/i);
    expect(json.error.remediation).toContain("perp wallet agent list aster");
    expect(mockFetch).not.toHaveBeenCalled();
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

  // 10. Aggregate happy — Aster slot is always NOT_IMPLEMENTED error per no-fallback rule;
  //     HL/PAC/LT slots succeed via live fetch.
  it("aggregate happy path — aster slot is NOT_IMPLEMENTED error, others ok", async () => {
    initSettings();
    mockFetch.mockReset();
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
    // Aster is NOT_IMPLEMENTED (intentional throw — no fallback)
    expect(json.data.aster).toHaveProperty("error");
    expect((json.data.aster as { error: { code: string } }).error.code).toBe("NOT_IMPLEMENTED");
    // Others are live-verified
    expect((json.data.hyperliquid as Record<string, unknown>).registered).toBe(true);
    expect((json.data.pacifica as Record<string, unknown>).registered).toBe(true);
    expect((json.data.lighter as Record<string, unknown>).registered).toBe(true);
  });

  // 11. Aggregate partial failure — lighter network error; aster always NOT_IMPLEMENTED
  it("aggregate partial failure — aster NOT_IMPLEMENTED + lighter network error coexist", async () => {
    initSettings();
    mockFetch.mockReset();
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
    expect(json.data.aster).toHaveProperty("error");
    expect((json.data.aster as { error: { code: string } }).error.code).toBe("NOT_IMPLEMENTED");
    expect(json.data.lighter).toHaveProperty("error");
    expect((json.data.lighter as { error: { message: string } }).error.message).toMatch(/network error/i);
  });

  // 13. JSON envelope shape — meta.timestamp is ISO-8601 (use HL since Aster throws)
  it("JSON envelope — meta.timestamp is ISO-8601 string", async () => {
    initSettings();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const out = await runVerify(["hyperliquid", "--json", "--master-address", "0xMASTER0000000000000000000000000000000001"]);
    const json = JSON.parse(out.stdout.join(""));
    expect(json.meta).toBeDefined();
    expect(typeof json.meta.timestamp).toBe("string");
    // ISO-8601 regex: YYYY-MM-DDTHH:mm:ss...Z
    expect(json.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Must be parseable as a date
    expect(isNaN(Date.parse(json.meta.timestamp))).toBe(false);
  });

  // 14. Aster non-JSON text output surfaces NOT_IMPLEMENTED + remediation
  it("aster text output prints NOT_IMPLEMENTED error with remediation", async () => {
    initSettings();
    const out = await runVerify(["aster"]);
    const combined = out.stdout.concat(out.stderr).join("");
    expect(combined).toMatch(/NOT_IMPLEMENTED|not supported/i);
    expect(combined).toContain("perp wallet agent list aster");
  });

});
