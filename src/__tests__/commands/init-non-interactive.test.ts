/**
 * Tests for `perp setup --non-interactive` (Phase: clean-state QA C3).
 *
 * Verifies the agent-friendly onboarding path:
 *  - Drives wallet creation + default-exchange selection without TTY.
 *  - Resolves passphrase via flag OR OWS_PASSPHRASE env (the 3-path resolver).
 *  - Throws PASSPHRASE_REQUIRED when nothing provides a passphrase and stdin
 *    is non-TTY.
 *  - Validates --default-exchange against the canonical 4-DEX list.
 *  - Does NOT call readline.createInterface (i.e. zero prompts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-init-ni-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

const mockOws = {
  createWallet: vi.fn(),
};

vi.mock("../../signer/ows-loader.js", () => ({
  loadOws: () => mockOws,
}));

// Track readline.createInterface calls — non-interactive mode must not call it.
const readlineCreateInterface = vi.fn();
vi.mock("readline", () => ({
  createInterface: (...args: unknown[]) => {
    readlineCreateInterface(...args);
    // Return a minimal stub in case something does try to use it.
    return {
      question: vi.fn(),
      close: vi.fn(),
    };
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { registerInitCommand } = await import("../../commands/init.js");
const { loadSettings } = await import("../../settings.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride();
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerInitCommand(prog);
  return prog;
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  mockOws.createWallet.mockReturnValue({
    id: "w-init-ni",
    name: "main",
    accounts: [
      { chainId: "eip155:1", address: "0xabc", derivationPath: "m/44'/60'/0'/0/0" },
      { chainId: "solana:mainnet", address: "Sol1", derivationPath: "m/44'/501'/0'/0'" },
    ],
    createdAt: new Date().toISOString(),
  });
  // Force OWS_PASSPHRASE absence by default so individual tests can opt in.
  delete process.env.OWS_PASSPHRASE;
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  delete process.env.OWS_PASSPHRASE;
  // Reset the saved exitCode between tests.
  process.exitCode = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setup --non-interactive (C3)", () => {
  it("creates the wallet, sets default-exchange, and bypasses readline", async () => {
    const prog = makeProgram();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await prog.parseAsync([
      "node",
      "perp",
      "setup",
      "--non-interactive",
      "--wallet-name",
      "main",
      "--passphrase",
      "testpass",
      "--default-exchange",
      "hyperliquid",
    ]);

    // Wallet created with the supplied passphrase.
    expect(mockOws.createWallet).toHaveBeenCalledTimes(1);
    expect(mockOws.createWallet).toHaveBeenCalledWith("main", "testpass");

    // Settings updated.
    const settings = loadSettings();
    expect(settings.owsActiveWallet).toBe("main");
    expect(settings.defaultExchange).toBe("hyperliquid");

    // Zero readline prompts — no TTY interaction whatsoever.
    expect(readlineCreateInterface).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("falls back to OWS_PASSPHRASE env when --passphrase is omitted", async () => {
    process.env.OWS_PASSPHRASE = "envpass";
    const prog = makeProgram();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await prog.parseAsync([
      "node",
      "perp",
      "setup",
      "--non-interactive",
      "--wallet-name",
      "main",
    ]);

    expect(mockOws.createWallet).toHaveBeenCalledWith("main", "envpass");
    expect(readlineCreateInterface).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("rejects an unknown --default-exchange with INVALID_PARAMS", async () => {
    const prog = makeProgram();
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation((m) => {
        stderrChunks.push(String(m));
      });

    await prog.parseAsync([
      "node",
      "perp",
      "setup",
      "--non-interactive",
      "--passphrase",
      "x",
      "--default-exchange",
      "ftx", // invalid
    ]);

    // No wallet should be created — validation runs first.
    expect(mockOws.createWallet).not.toHaveBeenCalled();
    // Caller-friendly INVALID_PARAMS error surfaces in stderr.
    expect(stderrChunks.join("\n")).toMatch(/INVALID_PARAMS/);
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it("throws PASSPHRASE_REQUIRED when no passphrase source is available", async () => {
    // No --passphrase flag, no OWS_PASSPHRASE env. resolvePassphrase reads
    // stdin only when isTTY === false; the test runner here keeps stdin TTY,
    // so the resolver returns null and the action throws PASSPHRASE_REQUIRED.
    const prog = makeProgram();
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation((m) => {
        stderrChunks.push(String(m));
      });

    // Force stdin.isTTY = true to exercise the in-process branch.
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await prog.parseAsync([
        "node",
        "perp",
        "setup",
        "--non-interactive",
        "--wallet-name",
        "main",
      ]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }

    expect(mockOws.createWallet).not.toHaveBeenCalled();
    expect(stderrChunks.join("\n")).toMatch(/PASSPHRASE_REQUIRED/);
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });
});
