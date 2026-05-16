import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

/** Read settings.json under the temp HOME — returns parsed object or {} */
function readTestSettings(): { owsActiveWallet?: string } {
  const path = resolve(TEST_HOME, ".perp/settings.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Run perp CLI inside the isolated temp HOME, returning stdout or throwing. */
function runPerp(args: string, timeoutMs = 30_000): string {
  return execSync(`npx tsx src/index.ts ${args}`, {
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, HOME: TEST_HOME, NODE_NO_WARNINGS: "1" },
  });
}

/**
 * End-to-end coverage for the `wallet balance` OWS-aware path
 * (dc1c1e0). Pre-fix, vault-based setups (no legacy `active` mapping,
 * `~/.perp/.env` empty) returned `INVALID_PARAMS: No wallets configured`
 * even though the OWS vault held a working wallet. The fix in
 * src/commands/wallet.ts:971-1008 now consults `settings.owsActiveWallet`
 * and fetches on-chain balances for every EVM and Solana account in the
 * vault before falling through to the legacy `.env` path.
 *
 * This test is intentionally a real-vault + real-CLI integration test:
 *
 *  - Uses the real `@open-wallet-standard/core` NAPI module (no mock).
 *  - Creates a real OWS vault on disk inside an isolated HOME, with
 *    real BIP-39 mnemonic derivation, real EVM/Solana addresses.
 *  - Spawns the real `perp` CLI subprocess with `--json wallet balance`,
 *    pointing HOME at the temp vault directory.
 *  - The CLI's network calls to Sepolia / Solana devnet RPCs are NOT
 *    mocked. The wallet is a fresh burner with zero balance, so the
 *    network response is deterministic in shape (empty / zero balances).
 *
 * Trade-off recorded: this test depends on Sepolia + Solana devnet RPC
 * availability. If the test machine is offline or those endpoints
 * return 5xx, the test fails loudly — which is the intended behavior
 * per the qa/2026-05-16 directive ("실제 테스트"). Skip the integration
 * suite (`pnpm test:integration`) when offline.
 */

const TEST_HOME = resolve(tmpdir(), `perp-wallet-ows-test-${process.pid}`);
const TEST_WALLET_NAME = `qa-vault-${process.pid}`;
const TEST_PASSPHRASE = "qa-2026-05-16-strict-policy";

let createdWalletEvmAddr: string | undefined;
let createdWalletSolanaAddr: string | undefined;

beforeAll(async () => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  mkdirSync(resolve(TEST_HOME, ".ows"), { recursive: true });

  // Step 1: create a real OWS vault inside TEST_HOME by briefly
  // pointing HOME at it. The NAPI module reads HOME on each call so
  // this is the canonical isolation hook used in OWS itself.
  const originalHome = process.env.HOME;
  process.env.HOME = TEST_HOME;
  try {
    const ows = await import("@open-wallet-standard/core");
    const wallet = ows.createWallet(TEST_WALLET_NAME, TEST_PASSPHRASE, 12);
    createdWalletEvmAddr = wallet.accounts.find((a) =>
      (a as { chainId: string }).chainId.startsWith("eip155:"),
    )?.address;
    createdWalletSolanaAddr = wallet.accounts.find((a) =>
      (a as { chainId: string }).chainId.startsWith("solana:"),
    )?.address;
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  }

  // Step 2: write the perp settings file so the wallet command picks up
  // owsActiveWallet on the next invocation.
  writeFileSync(
    resolve(TEST_HOME, ".perp/settings.json"),
    JSON.stringify({ owsActiveWallet: TEST_WALLET_NAME }, null, 2),
  );
});

afterAll(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("perp wallet balance — OWS-aware path (dc1c1e0)", { timeout: 45_000 }, () => {
  it("creates real OWS vault with both EVM and Solana accounts derivable", () => {
    expect(createdWalletEvmAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(createdWalletSolanaAddr).toBeTruthy();
    expect(typeof createdWalletSolanaAddr).toBe("string");
  });

  it("`perp --json wallet balance --testnet` returns OWS-shaped envelope when settings.owsActiveWallet is set", () => {
    const stdout = execSync(`npx tsx src/index.ts --json wallet balance --testnet`, {
      encoding: "utf-8",
      timeout: 40_000,
      env: {
        ...process.env,
        HOME: TEST_HOME,
        NODE_NO_WARNINGS: "1",
      },
    });

    const parsed = JSON.parse(stdout);

    // The OWS-aware branch emits `jsonOk(owsResults)` where each entry is
    // `{ wallet, chain, address, balances }`. The legacy `.env` branch
    // would have a different shape (per-exchange entries). Pin the OWS
    // shape so a regression that drops the branch is loud.
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data.length).toBeGreaterThanOrEqual(2);

    for (const result of parsed.data) {
      expect(result.wallet).toBe(TEST_WALLET_NAME);
      expect(result.chain === "evm" || result.chain === "solana").toBe(true);
      expect(typeof result.address).toBe("string");
      expect(result.address.length).toBeGreaterThan(0);
      expect(Array.isArray(result.balances)).toBe(true);
    }

    // Verify both chain branches fire — the bug regressed when only one
    // of the two account types was iterated.
    const chains = parsed.data.map((r: { chain: string }) => r.chain).sort();
    expect(chains).toContain("evm");
    expect(chains).toContain("solana");

    // The fresh-burner addresses must round-trip — fixed at vault creation.
    const evmResult = parsed.data.find((r: { chain: string }) => r.chain === "evm");
    const solResult = parsed.data.find((r: { chain: string }) => r.chain === "solana");
    expect(evmResult?.address).toBe(createdWalletEvmAddr);
    expect(solResult?.address).toBe(createdWalletSolanaAddr);
  });

  it("falls through to the legacy '.env' path with INVALID_PARAMS when owsActiveWallet is missing", () => {
    // Wipe owsActiveWallet so the OWS branch is skipped. Should land in
    // the existing fall-through error path (INVALID_PARAMS — preserved
    // by dc1c1e0 as the true terminal state).
    writeFileSync(
      resolve(TEST_HOME, ".perp/settings.json"),
      JSON.stringify({ owsActiveWallet: "" }, null, 2),
    );

    let stdout = "";
    let exitCode = 0;
    try {
      stdout = execSync(`npx tsx src/index.ts --json wallet balance --testnet`, {
        encoding: "utf-8",
        timeout: 20_000,
        env: {
          ...process.env,
          HOME: TEST_HOME,
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      stdout = e.stdout ?? "";
      exitCode = e.status ?? 1;
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_PARAMS");
    expect(parsed.error.message).toMatch(/No wallets configured/);
    expect(exitCode).toBe(1);

    // Restore for any subsequent tests in this file.
    writeFileSync(
      resolve(TEST_HOME, ".perp/settings.json"),
      JSON.stringify({ owsActiveWallet: TEST_WALLET_NAME }, null, 2),
    );
  });

  // ── owsActiveWallet mutation parity (wallet generate / use / remove) ──
  //
  // Pre-existing tests only exercised `wallet balance`. The other wallet
  // subcommands also mutate `settings.owsActiveWallet` and never had a
  // regression guard. Each test below runs the real CLI inside the same
  // isolated HOME and inspects `~/.perp/settings.json` after the command
  // to verify the mutation.
  //
  // State carries across these tests intentionally — each starts from
  // the known post-state of the previous one, mirroring how a user moves
  // through the wallet lifecycle on a single machine.

  const SECOND_WALLET = `qa-second-${process.pid}`;
  const THIRD_WALLET = `qa-third-${process.pid}`;

  it("`wallet generate` does NOT auto-switch owsActiveWallet when one is already set", () => {
    // Pre-condition: owsActiveWallet === TEST_WALLET_NAME (restored by prior test).
    expect(readTestSettings().owsActiveWallet).toBe(TEST_WALLET_NAME);

    runPerp(`--json wallet generate ${SECOND_WALLET} --passphrase ${TEST_PASSPHRASE}`);

    // The second wallet exists in the vault but owsActiveWallet stays put —
    // L364-367 auto-set only fires when no active wallet is set yet.
    expect(readTestSettings().owsActiveWallet).toBe(TEST_WALLET_NAME);
  });

  it("`wallet use <name>` switches owsActiveWallet to the named OWS vault", () => {
    runPerp(`--json wallet use ${SECOND_WALLET}`);
    expect(readTestSettings().owsActiveWallet).toBe(SECOND_WALLET);
  });

  it("`wallet generate` AUTO-sets owsActiveWallet when none is set", () => {
    // Clear active first so the auto-set path fires (L364 only sets when
    // settings.owsActiveWallet is empty/falsy).
    writeFileSync(
      resolve(TEST_HOME, ".perp/settings.json"),
      JSON.stringify({ owsActiveWallet: "" }, null, 2),
    );
    expect(readTestSettings().owsActiveWallet).toBe("");

    runPerp(`--json wallet generate ${THIRD_WALLET} --passphrase ${TEST_PASSPHRASE}`);

    expect(readTestSettings().owsActiveWallet).toBe(THIRD_WALLET);
  });

  it("`wallet remove <name>` clears owsActiveWallet when removing the active wallet", () => {
    // Pre-condition: owsActiveWallet === THIRD_WALLET (set by prior test).
    expect(readTestSettings().owsActiveWallet).toBe(THIRD_WALLET);

    runPerp(`--json wallet remove ${THIRD_WALLET}`);

    // L862-865 explicitly clears owsActiveWallet when the removed wallet matches.
    expect(readTestSettings().owsActiveWallet).toBe("");
  });
});
