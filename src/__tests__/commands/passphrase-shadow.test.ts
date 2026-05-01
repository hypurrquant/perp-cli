/**
 * Tests for the parent --passphrase shadow fix (C5).
 *
 * Background: src/index.ts defines `--passphrase <pp>` on the parent program
 * for HL Tier 2 OWS adapter init paths. Subcommands `wallet generate/import`,
 * `wallet agent approve/revoke/rotate`, and `setup --non-interactive` ALSO
 * defined `--passphrase <pp>` on the subcommand. Commander v13 binds the
 * same-named flag to the parent, so `opts.passphrase` on the subcommand
 * action was always undefined — `--passphrase X` silently fell back to
 * empty-string encryption (wallet generate) or threw PASSPHRASE_REQUIRED
 * (agent approve / setup).
 *
 * Fix: each affected action calls `command.optsWithGlobals()` to merge
 * parent + subcommand options, so the flag works on either side.
 *
 * These tests construct a program with the parent --passphrase option
 * defined (mirroring src/index.ts) and assert the resolved passphrase
 * matches the flag value, regardless of whether it was placed on the
 * parent or the subcommand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-pp-shadow-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

const mockOws = {
  createWallet: vi.fn(),
  importWalletPrivateKey: vi.fn(),
  importWalletMnemonic: vi.fn(),
  exportWallet: vi.fn(),
};

vi.mock("../../signer/ows-loader.js", () => ({
  loadOws: () => mockOws,
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { registerInitCommand } = await import("../../commands/init.js");
const { registerWalletCommands } = await import("../../commands/wallet.js");

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a program that mirrors src/index.ts wiring: a parent program with
 * `--passphrase <pp>` defined globally, plus the wallet + setup subtrees.
 * This is the topology where the shadow bug surfaces.
 */
function makeProgramWithParentPassphrase() {
  const prog = new Command();
  prog.exitOverride();
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  // Mirror src/index.ts:83 — parent-level --passphrase flag.
  prog.option("--passphrase <pp>", "Master OWS passphrase");
  registerWalletCommands(prog, () => true /* json */);
  registerInitCommand(prog);
  return prog;
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  delete process.env.OWS_PASSPHRASE;
  mockOws.createWallet.mockReturnValue({
    id: "w-pp-shadow",
    name: "test-wallet",
    accounts: [
      { chainId: "eip155:1", address: "0xabc", derivationPath: "m/44'/60'/0'/0/0" },
      { chainId: "solana:mainnet", address: "Sol1", derivationPath: "m/44'/501'/0'/0'" },
    ],
    createdAt: new Date().toISOString(),
  });
  mockOws.importWalletPrivateKey.mockReturnValue({
    id: "w-pp-shadow-import",
    name: "imported",
    accounts: [
      { chainId: "eip155:1", address: "0xdef", derivationPath: "m/44'/60'/0'/0/0" },
    ],
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  delete process.env.OWS_PASSPHRASE;
  process.exitCode = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("--passphrase parent/subcommand shadow fix (C5)", () => {
  it("wallet generate --passphrase ABC encrypts with ABC, not empty", async () => {
    const prog = makeProgramWithParentPassphrase();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Subcommand position — historically broken before C5 because Commander v13
    // binds --passphrase to the parent's same-named flag.
    await prog.parseAsync([
      "node", "perp", "wallet", "generate", "test-wallet", "--passphrase", "ABC",
    ]);

    expect(mockOws.createWallet).toHaveBeenCalledTimes(1);
    // 1st arg: walletName, 2nd arg: passphrase, 3rd arg: word count.
    expect(mockOws.createWallet.mock.calls[0][1]).toBe("ABC");

    consoleSpy.mockRestore();
  });

  it("wallet generate works when --passphrase is on the parent (perp --passphrase X wallet generate)", async () => {
    const prog = makeProgramWithParentPassphrase();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Parent position — the historical "working" path (because Commander
    // bound the flag to the parent regardless).
    await prog.parseAsync([
      "node", "perp", "--passphrase", "DEF", "wallet", "generate", "test-wallet",
    ]);

    expect(mockOws.createWallet).toHaveBeenCalledTimes(1);
    expect(mockOws.createWallet.mock.calls[0][1]).toBe("DEF");

    consoleSpy.mockRestore();
  });

  it("setup --non-interactive --passphrase XYZ creates a wallet with XYZ", async () => {
    const prog = makeProgramWithParentPassphrase();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await prog.parseAsync([
      "node", "perp", "setup", "--non-interactive",
      "--wallet-name", "main",
      "--passphrase", "XYZ",
    ]);

    expect(mockOws.createWallet).toHaveBeenCalledTimes(1);
    expect(mockOws.createWallet).toHaveBeenCalledWith("main", "XYZ");

    consoleSpy.mockRestore();
  });

  it("wallet import --passphrase JKL encrypts with JKL", async () => {
    const prog = makeProgramWithParentPassphrase();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Use a syntactically valid EVM hex key (66 chars with 0x prefix) so the
    // action reaches importWalletPrivateKey.
    const evmKey = "0x" + "1".repeat(64);
    await prog.parseAsync([
      "node", "perp", "wallet", "import", evmKey,
      "--name", "imported",
      "--passphrase", "JKL",
    ]);

    expect(mockOws.importWalletPrivateKey).toHaveBeenCalledTimes(1);
    // signature: (name, key, passphrase, ...).
    expect(mockOws.importWalletPrivateKey.mock.calls[0][2]).toBe("JKL");

    consoleSpy.mockRestore();
  });
});
