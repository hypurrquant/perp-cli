/**
 * Tests for the funds command tree post-consolidation (v0.11+).
 *
 * Verifies:
 *  - The cross-chain `bridge` subtree (chains/quote/send/exchange/status)
 *    is reachable as `perp funds bridge ...` (relocated from the old
 *    top-level `perp bridge ...`).
 *  - The inter-exchange `rebalance` subtree (check/plan/execute) is
 *    reachable as `perp funds rebalance ...` (relocated from the old
 *    top-level `perp rebalance ...`).
 *  - Existing `funds deposit / withdraw / transfer / info` paths still
 *    register cleanly.
 *  - The legacy paths (`perp bridge`, `perp rebalance`, the old CCTP-only
 *    `perp funds bridge --from ...`, and `perp funds bridge-status`) all
 *    error with `unknown command`.
 *
 * These tests assert on registration topology only — handler behavior
 * for the underlying bridge / rebalance commands is unchanged and is
 * covered elsewhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-fm-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Imports (no heavy mocks needed: we only inspect topology) ──────────────

const { registerFundsCommands } = await import("../../commands/funds.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride();
  // Tolerate stray text on stderr/stdout from action handlers without
  // polluting test output (we only inspect topology, not behavior).
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerFundsCommands(
    prog,
    () => {
      throw new Error("getAdapter should not be called for topology checks");
    },
    () => true /* json */,
    () => "mainnet" as const,
    async () => {
      throw new Error("getAdapterForExchange should not be called for topology checks");
    },
  );
  return prog;
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describe("funds merge — top-level commands consolidated under funds", () => {
  it("`funds` is registered with bridge + rebalance + lifecycle subtrees", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds");
    expect(funds).toBeTruthy();
    const subs = funds!.commands.map((c) => c.name()).sort();
    // Existing tree
    expect(subs).toEqual(expect.arrayContaining([
      "deposit", "withdraw", "transfer", "info",
    ]));
    // Newly merged subtrees
    expect(subs).toEqual(expect.arrayContaining(["bridge", "rebalance"]));
  });

  it("`funds bridge` subtree exposes chains / quote / send / exchange / status", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds")!;
    const bridge = funds.commands.find((c) => c.name() === "bridge");
    expect(bridge).toBeTruthy();
    const bridgeSubs = bridge!.commands.map((c) => c.name()).sort();
    expect(bridgeSubs).toEqual(expect.arrayContaining([
      "chains", "quote", "send", "exchange", "status",
    ]));
  });

  it("`funds bridge send` accepts the multi-provider option set", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds")!;
    const bridge = funds.commands.find((c) => c.name() === "bridge")!;
    const send = bridge.commands.find((c) => c.name() === "send");
    expect(send).toBeTruthy();
    const optionLongFlags = send!.options.map((o) => o.long).filter(Boolean);
    // Required + provider selection + dry-run + fast finality
    expect(optionLongFlags).toEqual(expect.arrayContaining([
      "--from", "--to", "--amount", "--provider", "--dry-run", "--fast",
    ]));
  });

  it("`funds bridge exchange` accepts the multi-provider option set", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds")!;
    const bridge = funds.commands.find((c) => c.name() === "bridge")!;
    const exch = bridge.commands.find((c) => c.name() === "exchange");
    expect(exch).toBeTruthy();
    const optionLongFlags = exch!.options.map((o) => o.long).filter(Boolean);
    expect(optionLongFlags).toEqual(expect.arrayContaining([
      "--from", "--to", "--amount", "--provider",
    ]));
  });

  it("`funds rebalance` subtree exposes check / plan / execute", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds")!;
    const rebalance = funds.commands.find((c) => c.name() === "rebalance");
    expect(rebalance).toBeTruthy();
    const rebalanceSubs = rebalance!.commands.map((c) => c.name()).sort();
    expect(rebalanceSubs).toEqual(["check", "execute", "plan"]);
  });

  it("`funds rebalance execute` accepts orchestration options", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds")!;
    const rebalance = funds.commands.find((c) => c.name() === "rebalance")!;
    const execute = rebalance.commands.find((c) => c.name() === "execute");
    expect(execute).toBeTruthy();
    const optionLongFlags = execute!.options.map((o) => o.long).filter(Boolean);
    expect(optionLongFlags).toEqual(expect.arrayContaining([
      "--exchanges", "--min-move", "--reserve",
      "--dry-run", "--withdraw-only", "--auto-bridge",
    ]));
  });

  it("`funds deposit` retains pacifica / hyperliquid / lighter handlers", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds")!;
    const deposit = funds.commands.find((c) => c.name() === "deposit");
    expect(deposit).toBeTruthy();
    const depositSubs = deposit!.commands.map((c) => c.name()).sort();
    expect(depositSubs).toEqual(expect.arrayContaining([
      "pacifica", "hyperliquid", "lighter",
    ]));
  });

  it("`funds withdraw` retains pacifica / hyperliquid / lighter handlers", () => {
    const prog = makeProgram();
    const funds = prog.commands.find((c) => c.name() === "funds")!;
    const withdraw = funds.commands.find((c) => c.name() === "withdraw");
    expect(withdraw).toBeTruthy();
    const withdrawSubs = withdraw!.commands.map((c) => c.name()).sort();
    expect(withdrawSubs).toEqual(["hyperliquid", "lighter", "pacifica"]);
  });
});

describe("funds merge — legacy and dropped paths fail", () => {
  /**
   * After the v0.11+ hard-cut, the following paths must not exist on a
   * program that only registers the `funds` subtree. Commander.js with
   * `exitOverride()` raises a CommanderError on unknown commands, which
   * we surface here as a thrown error.
   */
  function expectUnknown(args: string[]) {
    const prog = makeProgram();
    return expect(prog.parseAsync(args)).rejects.toThrow();
  }

  it("top-level `bridge` is not a valid command (moved under funds)", async () => {
    await expectUnknown(["node", "perp", "bridge", "chains"]);
  });

  it("top-level `rebalance` is not a valid command (moved under funds)", async () => {
    await expectUnknown(["node", "perp", "rebalance", "check"]);
  });

  it("`funds bridge --from <chain>` (old CCTP-only flag form) is gone — must use a subcommand", async () => {
    // The old form had `funds.command("bridge")` with required --from/--to/
    // --amount/--recipient flags directly on `bridge`. After consolidation,
    // `bridge` is a parent group and requires a subcommand (chains|quote|
    // send|exchange|status). Passing `--from arbitrum --to base` directly
    // must be rejected because there is no longer a top-level `bridge`
    // action — only nested subcommands.
    await expectUnknown([
      "node", "perp", "funds", "bridge",
      "--from", "arbitrum",
      "--to", "base",
      "--amount", "100",
      "--recipient", "0xabc",
    ]);
  });

  it("`funds bridge-status` is not a valid command (replaced by `funds bridge status`)", async () => {
    await expectUnknown([
      "node", "perp", "funds", "bridge-status",
      "--hash", "0xdeadbeef",
    ]);
  });
});
