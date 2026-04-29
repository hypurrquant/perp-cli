/**
 * Tests for the wallet command tree post-consolidation (v0.11+).
 *
 * Verifies:
 *  - The OWS sub-namespaces (`policy`, `key`) and lifecycle commands
 *    (`backup`, `setup`, `deposit`, `rotate`, `restore`) are reachable
 *    under `perp wallet ...` (relocated from the old `perp ows ...`).
 *  - The DEX-side agent subtree is reachable under `perp wallet agent ...`
 *    (relocated from the old top-level `perp agent ...`).
 *  - The legacy command paths (`ows`, top-level `agent`) and the dropped
 *    x402 commands (`pay`, `discover`) all error with `unknown command`.
 *
 * Light mocks — only enough to exercise registration topology and reach
 * the action handlers. Full handler behavior is covered elsewhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-wm-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

const mockOws = {
  createWallet: vi.fn(),
  createPolicy: vi.fn(),
  listPolicies: vi.fn(),
  getPolicy: vi.fn(),
  deletePolicy: vi.fn(),
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
  getWallet: vi.fn(),
  listWallets: vi.fn(),
  deleteWallet: vi.fn(),
  importWalletPrivateKey: vi.fn(),
  importWalletMnemonic: vi.fn(),
  exportWallet: vi.fn(),
};

// wallet.ts (and agent.ts) call loadOws() from signer/ows-loader.js.
// Mock that wrapper so all OWS calls land on mockOws regardless of how the
// command tree imports it (matches the pattern used by agent-wallet.test.ts).
vi.mock("../../signer/ows-loader.js", () => ({
  loadOws: () => mockOws,
}));

// ── Import modules after mocks ────────────────────────────────────────────

const { registerWalletCommands } = await import("../../commands/wallet.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride();
  // Tolerate stray text on stderr from action handlers without polluting test output.
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerWalletCommands(prog, () => true /* json */);
  return prog;
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  // Default OWS return values for the few "happy" paths we exercise.
  mockOws.listPolicies.mockReturnValue([]);
  mockOws.listApiKeys.mockReturnValue([]);
  mockOws.listWallets.mockReturnValue([]);
  mockOws.createPolicy.mockReturnValue(undefined);
  mockOws.createApiKey.mockReturnValue({ id: "key-001", token: "ows_key_TEST", name: "k" });
  mockOws.createWallet.mockReturnValue({
    id: "w1",
    name: "test-wallet",
    accounts: [
      { chainId: "eip155:1", address: "0xabc", derivationPath: "m/44'/60'/0'/0/0" },
      { chainId: "solana:mainnet", address: "Sol1", derivationPath: "m/44'/501'/0'/0'" },
    ],
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describe("wallet merge — relocated commands are reachable", () => {
  it("wallet policy create reaches OWS createPolicy handler", async () => {
    const prog = makeProgram();
    const printed: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((m) => { printed.push(String(m)); });

    await prog.parseAsync([
      "node", "perp", "wallet", "policy", "create",
      "--id", "pol-1",
      "--name", "test policy",
    ]);

    expect(mockOws.createPolicy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it("wallet policy list reaches OWS listPolicies handler", async () => {
    const prog = makeProgram();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await prog.parseAsync(["node", "perp", "wallet", "policy", "list"]);

    expect(mockOws.listPolicies).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("wallet key create reaches OWS createApiKey handler", async () => {
    const prog = makeProgram();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await prog.parseAsync([
      "node", "perp", "wallet", "key", "create",
      "--name", "trading-bot",
      "--wallets", "main",
      "-p", "",
    ]);

    expect(mockOws.createApiKey).toHaveBeenCalledTimes(1);
    expect(mockOws.createApiKey.mock.calls[0][0]).toBe("trading-bot");
    consoleSpy.mockRestore();
  });

  it("wallet key revoke reaches OWS revokeApiKey handler", async () => {
    const prog = makeProgram();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await prog.parseAsync(["node", "perp", "wallet", "key", "revoke", "key-xyz"]);

    expect(mockOws.revokeApiKey).toHaveBeenCalledWith("key-xyz");
    consoleSpy.mockRestore();
  });

  it("wallet generate is registered and produces a wallet", async () => {
    const prog = makeProgram();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await prog.parseAsync(["node", "perp", "wallet", "generate", "merge-test"]);

    expect(mockOws.createWallet).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("wallet agent subtree is registered (approve subcommand exists)", () => {
    const prog = makeProgram();
    const wallet = prog.commands.find((c) => c.name() === "wallet");
    expect(wallet).toBeTruthy();
    const agent = wallet!.commands.find((c) => c.name() === "agent");
    expect(agent).toBeTruthy();
    const approve = agent!.commands.find((c) => c.name() === "approve");
    expect(approve).toBeTruthy();
    // verify all 5 documented subcommands are present
    const subs = agent!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(expect.arrayContaining(["approve", "list", "revoke", "rotate", "verify"]));
  });

  it("wallet has the absorbed lifecycle commands (deposit, setup, backup, restore, rotate)", () => {
    const prog = makeProgram();
    const wallet = prog.commands.find((c) => c.name() === "wallet");
    expect(wallet).toBeTruthy();
    const subs = wallet!.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining([
      "deposit", "setup", "backup", "restore", "rotate",
      "policy", "key", "agent",
    ]));
  });
});

describe("wallet merge — legacy and dropped paths fail", () => {
  /**
   * After the v0.11 hard-cut, the following paths must not exist on a
   * program that only registers the `wallet` subtree. Commander.js with
   * `exitOverride()` raises a CommanderError on unknown commands, which
   * we surface here as a thrown error.
   */
  function expectUnknown(args: string[]) {
    const prog = makeProgram();
    return expect(prog.parseAsync(args)).rejects.toThrow();
  }

  it("top-level `ows` is not a valid command", async () => {
    await expectUnknown(["node", "perp", "ows", "list"]);
  });

  it("top-level `agent` is not a valid command", async () => {
    await expectUnknown(["node", "perp", "agent", "list"]);
  });

  it("`wallet pay` (x402) is not registered (dropped)", async () => {
    await expectUnknown(["node", "perp", "wallet", "pay", "https://example.com"]);
  });

  it("`wallet discover` (x402) is not registered (dropped)", async () => {
    await expectUnknown(["node", "perp", "wallet", "discover"]);
  });
});
