/**
 * Tests for the strategy command tree post-consolidation (v0.11+).
 *
 * Verifies:
 *  - The 17 bot algorithm commands previously registered under
 *    `perp bot ...` are now reachable as `perp strategy ...`.
 *  - The 3 scripted-plan subcommands previously registered under
 *    top-level `perp plan ...` are now reachable as nested
 *    `perp strategy plan {validate|execute|example}`.
 *  - The 5 `jobs` subcommands are now reachable as `perp background ...`.
 *  - The legacy paths (`perp bot ...`, `perp plan ...`, `perp jobs ...`)
 *    all error with `unknown command`.
 *
 * Topology-only — no handler behavior asserted here. Handler behavior
 * for bot / plan / jobs subcommands is unchanged and covered elsewhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-sm-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Imports (no heavy mocks: we only inspect topology) ────────────────────

const { registerStrategyCommands } = await import("../../commands/bot.js");
const { registerBackgroundCommands } = await import("../../commands/jobs.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  prog.exitOverride();
  // Tolerate stray text on stderr/stdout from action handlers without
  // polluting test output (we only inspect topology, not behavior).
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerStrategyCommands(
    prog,
    async () => {
      throw new Error("getAdapter should not be called for topology checks");
    },
    async () => {
      throw new Error("getAdapterForExchange should not be called for topology checks");
    },
    () => true /* json */,
  );
  registerBackgroundCommands(prog, () => true /* json */);
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

describe("strategy merge — top-level commands consolidated under strategy", () => {
  it("`strategy` is registered with the 17 bot subcommands plus a `plan` subgroup", () => {
    const prog = makeProgram();
    const strategy = prog.commands.find((c) => c.name() === "strategy");
    expect(strategy).toBeTruthy();
    const subs = strategy!.commands.map((c) => c.name());
    // Existing bot algorithms
    expect(subs).toEqual(expect.arrayContaining([
      "start", "quick-grid", "quick-dca", "quick-arb",
      "delta-neutral", "preset-list", "preset", "list-strategies",
      "apex", "reflect", "run", "example",
      "twap", "funding-arb", "grid", "dca", "trailing-stop",
    ]));
    // Newly nested scripted-plan subgroup
    expect(subs).toContain("plan");
  });

  it("`strategy plan` subgroup exposes validate / execute / example", () => {
    const prog = makeProgram();
    const strategy = prog.commands.find((c) => c.name() === "strategy")!;
    const plan = strategy.commands.find((c) => c.name() === "plan");
    expect(plan).toBeTruthy();
    const planSubs = plan!.commands.map((c) => c.name()).sort();
    expect(planSubs).toEqual(["example", "execute", "validate"]);
  });

  it("`strategy plan validate` accepts a file argument", () => {
    const prog = makeProgram();
    const strategy = prog.commands.find((c) => c.name() === "strategy")!;
    const plan = strategy.commands.find((c) => c.name() === "plan")!;
    const validate = plan.commands.find((c) => c.name() === "validate");
    expect(validate).toBeTruthy();
    // Commander stores a `<file>` arg as a registered argument
    const args = validate!.registeredArguments.map((a) => a.name());
    expect(args).toContain("file");
  });

  it("`strategy plan execute` accepts --dry-run", () => {
    const prog = makeProgram();
    const strategy = prog.commands.find((c) => c.name() === "strategy")!;
    const plan = strategy.commands.find((c) => c.name() === "plan")!;
    const execute = plan.commands.find((c) => c.name() === "execute");
    expect(execute).toBeTruthy();
    const optionLongFlags = execute!.options.map((o) => o.long).filter(Boolean);
    expect(optionLongFlags).toContain("--dry-run");
  });

  it("`strategy plan example` is reachable (no required args)", () => {
    const prog = makeProgram();
    const strategy = prog.commands.find((c) => c.name() === "strategy")!;
    const plan = strategy.commands.find((c) => c.name() === "plan")!;
    const example = plan.commands.find((c) => c.name() === "example");
    expect(example).toBeTruthy();
    expect(example!.registeredArguments).toEqual([]);
  });

  it("`background` is registered with list / stop / logs / remove / clean", () => {
    const prog = makeProgram();
    const background = prog.commands.find((c) => c.name() === "background");
    expect(background).toBeTruthy();
    const subs = background!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(expect.arrayContaining([
      "clean", "list", "logs", "remove", "stop",
    ]));
  });
});

describe("strategy merge — legacy and dropped top-level paths fail", () => {
  /**
   * After the v0.11+ hard-cut, the following paths must not exist on a
   * program that only registers the `strategy` and `background` subtrees.
   * Commander.js with `exitOverride()` raises a CommanderError on unknown
   * commands, which we surface here as a thrown error.
   */
  function expectUnknown(args: string[]) {
    const prog = makeProgram();
    return expect(prog.parseAsync(args)).rejects.toThrow();
  }

  it("top-level `bot` is not a valid command (renamed to strategy)", async () => {
    await expectUnknown(["node", "perp", "bot", "list-strategies"]);
  });

  it("top-level `plan` is not a valid command (moved under strategy)", async () => {
    await expectUnknown(["node", "perp", "plan", "example"]);
  });

  it("top-level `jobs` is not a valid command (renamed to background)", async () => {
    await expectUnknown(["node", "perp", "jobs", "list"]);
  });
});
