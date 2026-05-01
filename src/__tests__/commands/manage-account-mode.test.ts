/**
 * Tests for `wallet manage account-mode` — Hyperliquid account abstraction
 * mode write surface.
 *
 * Covers:
 *  - userSetAbstraction action shape (type, abstraction wire string, nonce)
 *  - EIP-712 envelope reuse (HyperliquidSignTransaction domain, chainId 42161)
 *  - --passphrase parent-shadow merge via optsWithGlobals (C5 contract)
 *  - Mode validation (rejects unknown modes with INVALID_PARAMS)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-acctmode-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

const MOCK_MASTER_WALLET = {
  id: "wallet-master-id",
  name: "main",
  accounts: [
    { chainId: "eip155:1", address: "0xMasterHLAddr0000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" },
  ],
  createdAt: new Date().toISOString(),
};

// Canonical 65-byte EIP-712 signature with valid s ≤ half-order. Reused from
// agent-hl.test.ts setup so ethers.Signature.from() accepts it.
const FAKE_SIG = "0x1aee1548148536475582711c39958806646195b294c0bbc0d52ed8aae77988175240c82244cf8e1e0d4387d107ef558090bae5d6a603235750e93ee0be1b1bbf1b";

const mockOws = {
  getWallet: vi.fn(),
  signTypedData: vi.fn(),
  signMessage: vi.fn(),
};

vi.mock("../../signer/ows-loader.js", () => ({
  loadOws: () => mockOws,
}));

// ── Mock readline (no interactive prompting) ──────────────────────────────

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── Import modules after mocks ────────────────────────────────────────────

const { registerWalletManageCommands } = await import("../../commands/manage.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride();
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  // Mirror src/index.ts: parent-level --passphrase + --network so subcommand
  // optsWithGlobals() merges resolve as expected.
  prog.option("--passphrase <pp>", "Master OWS passphrase");
  prog.option("-n, --network <network>", "Network", "mainnet");
  const wallet = prog.command("wallet").description("Wallet management");
  // Stub adapter getters; account-mode does NOT use them (it constructs a
  // fresh HyperliquidAdapter directly), so a no-op closure is sufficient.
  registerWalletManageCommands(
    wallet,
    () => Promise.reject(new Error("getAdapter not used by account-mode")) as never,
    () => true,
    () => ({}),
  );
  return prog;
}

function setupOwsForSign() {
  mockOws.getWallet.mockReturnValue(MOCK_MASTER_WALLET);
  // OwsEvmSigner.signTypedData() expects {signature, recoveryId}; it strips 0x
  // and canonicalizes to a 65-byte hex with embedded v. Provide a 64-byte r+s
  // with recoveryId=0 (canonicalized to 27 → v=0x1b).
  const rawHex = FAKE_SIG.slice(2, 2 + 128);
  mockOws.signTypedData.mockReturnValue({ signature: "0x" + rawHex, recoveryId: 0 });
  mockOws.signMessage.mockReturnValue({ signature: "0x" + rawHex, recoveryId: 0 });
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("HOME", TEST_HOME);
  // Non-TTY so resolvePassphrase falls back to env/flag without prompting.
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Set mode → standard
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet manage account-mode standard", () => {
  it("posts userSetAbstraction with abstraction='disabled' and signs EIP-712 UserSetAbstraction", async () => {
    setupOwsForSign();

    // Sequence the fetch mock so the prev-mode read returns "standard" and the
    // /exchange POST returns ok.
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      call++;
      // First N reads might be /info userAbstraction (prev-mode capture).
      // Treat any GET-less POST without action.type === "userSetAbstraction"
      // as the /info call.
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body?.type === "userAbstraction") {
        return {
          ok: true,
          status: 200,
          json: async () => "disabled",
          text: async () => '"disabled"',
        };
      }
      // userSetAbstraction action POST → ok response
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
        text: async () => JSON.stringify({ status: "ok" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "manage", "account-mode", "standard",
      "--master", "main",
      "--passphrase", "testpass",
      "--json",
    ]);

    // Find the /exchange POST that contains the userSetAbstraction action.
    const setCall = fetchMock.mock.calls.find(([, init]: [string, RequestInit]) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return body?.action?.type === "userSetAbstraction";
    });
    expect(setCall).toBeTruthy();

    const [url, init] = setCall as [string, RequestInit];
    expect(url).toContain("/exchange");
    const body = JSON.parse(init.body as string);
    expect(body.action.type).toBe("userSetAbstraction");
    expect(body.action.abstraction).toBe("disabled"); // "standard" → "disabled"
    expect(body.action.hyperliquidChain).toBe("Mainnet");
    expect(body.action.signatureChainId).toBe("0xa4b1");
    expect(body.action.user).toBe("0xMasterHLAddr0000000000000000000000000001");
    expect(typeof body.action.nonce).toBe("number");
    expect(body.nonce).toBe(body.action.nonce);
    expect(body.signature.r).toBeTruthy();
    expect(body.signature.s).toBeTruthy();
    expect(body.signature.v).toBeTruthy();
    expect(body.vaultAddress).toBeNull();

    // Confirm the EIP-712 typed-data envelope used the UserSetAbstraction primary type.
    expect(mockOws.signTypedData).toHaveBeenCalled();
    const typedDataArg = mockOws.signTypedData.mock.calls[0][2] as string;
    const parsed = JSON.parse(typedDataArg);
    expect(parsed.primaryType).toBe("HyperliquidTransaction:UserSetAbstraction");
    expect(parsed.types["HyperliquidTransaction:UserSetAbstraction"]).toEqual([
      { name: "hyperliquidChain", type: "string" },
      { name: "abstraction", type: "string" },
      { name: "nonce", type: "uint64" },
    ]);
    expect(parsed.domain.chainId).toBe(42161);
    expect(parsed.domain.name).toBe("HyperliquidSignTransaction");
    expect(parsed.message.abstraction).toBe("disabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Mode validation
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet manage account-mode rejects unknown mode", () => {
  it("invalid mode → INVALID_PARAMS without calling fetch", async () => {
    setupOwsForSign();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const errLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await expect(prog.parseAsync([
      "node", "perp", "wallet", "manage", "account-mode", "bogus",
      "--master", "main",
      "--passphrase", "testpass",
      "--json",
    ])).rejects.toThrow(/process\.exit/);

    // No /exchange call should have been made — validation rejects upstream.
    const exchangeCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes("/exchange"));
    expect(exchangeCalls.length).toBe(0);

    // INVALID_PARAMS surfaced to stderr in JSON envelope.
    expect(errLines.some(l => l.includes("INVALID_PARAMS"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: parent --passphrase shadow contract (C5)
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet manage account-mode merges parent --passphrase via optsWithGlobals", () => {
  it("parent-side --passphrase reaches OwsEvmSigner without falling back to PASSPHRASE_REQUIRED", async () => {
    setupOwsForSign();

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body?.type === "userAbstraction") {
        return {
          ok: true,
          status: 200,
          json: async () => "disabled",
          text: async () => '"disabled"',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
        text: async () => JSON.stringify({ status: "ok" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    // Parent-position --passphrase (the historical broken path before C5).
    await prog.parseAsync([
      "node", "perp", "--passphrase", "from-parent",
      "wallet", "manage", "account-mode", "unified",
      "--master", "main",
      "--json",
    ]);

    // signTypedData should have been called (i.e. resolution succeeded; we
    // didn't bail with PASSPHRASE_REQUIRED).
    expect(mockOws.signTypedData).toHaveBeenCalled();
    // And the unified mode wired through to abstraction="unifiedAccount".
    const setCall = fetchMock.mock.calls.find(([, init]: [string, RequestInit]) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return body?.action?.type === "userSetAbstraction";
    });
    expect(setCall).toBeTruthy();
    const body = JSON.parse((setCall as [string, RequestInit])[1].body as string);
    expect(body.action.abstraction).toBe("unifiedAccount");
  });
});
