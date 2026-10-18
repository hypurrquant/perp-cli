/**
 * Root-flag safety regressions, parsed through the REAL root program (buildProgram — the
 * same tree src/index.ts parses):
 *
 *  C1  `--dry-run` is root-only. A subcommand-level copy is swallowed by the root (Commander
 *      13, non-positional options) and used to run LIVE. Both argv positions must dry-run.
 *  C2  `-n` is a validated choice — a typo (e.g. "Testnet") is a usage error, never mainnet.
 *  H1  default-deny: every command that does not explicitly honor --dry-run rejects it with
 *      INVALID_PARAMS before its action runs; fund movements honor it (sent:false, nothing sent).
 *  H2  `strategy run --dry-run` refuses strategies that cannot simulate.
 *
 * No network: venue adapters are stubs, bridge quotes/execution and key loading are mocked,
 * global fetch throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Command } from "commander";

const stubAdapter = {
  name: "hyperliquid",
  address: "0x1111111111111111111111111111111111111111",
  publicKey: "PacPub1111111111111111111111111111111111111",
  withdraw: vi.fn(),
  usdTransfer: vi.fn(),
  marketOrder: vi.fn(),
  limitOrder: vi.fn(),
  setLeverage: vi.fn(),
  getBalance: vi.fn(async () => ({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" })),
  getPositions: vi.fn(async () => []),
  getOpenOrders: vi.fn(async () => []),
  getMarkets: vi.fn(async () => []),
};

vi.mock("../exchanges/venue.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../exchanges/venue.js")>();
  return {
    ...orig,
    getVenue: (input: string) => {
      const def = orig.getVenue(input);
      return def.create === null ? def : { ...def, create: async () => stubAdapter };
    },
  };
});

const SOL_SECRET = await (async () => {
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  return bs58.encode(Keypair.generate().secretKey);
})();
const loadPrivateKey = vi.fn(async (exchange: string) => (exchange === "pacifica" ? SOL_SECRET : `0x${"42".repeat(32)}`));
vi.mock("../config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../config.js")>();
  return { ...orig, hasCredentials: vi.fn(async () => false), loadPrivateKey };
});

const executeBestBridge = vi.fn();
const checkBridgeGasBalance = vi.fn();
vi.mock("../bridge-engine.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../bridge-engine.js")>();
  return {
    ...orig,
    executeBestBridge,
    checkBridgeGasBalance,
    getAllQuotes: vi.fn(async (src: string, dst: string, amt: number) => [{
      provider: "cctp", srcChain: src, dstChain: dst, amountIn: amt, amountOut: amt, fee: 0,
      estimatedTime: 60, gasIncluded: true, raw: null,
    }]),
  };
});

const startJob = vi.fn((o: { strategy: string; cliArgs: string[] }) => ({ id: "job1", ...o }));
vi.mock("../jobs.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../jobs.js")>();
  return { ...orig, startJob };
});

const executePlan = vi.fn(async () => ({ status: "dry_run", steps: [] }));
vi.mock("../plan-executor.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../plan-executor.js")>();
  return { ...orig, executePlan };
});

const runBot = vi.fn(async () => ({ fills: 0, totalPnl: 0, runtime: 0 }));
vi.mock("../bot/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../bot/index.js")>();
  return { ...orig, runBot };
});

const { buildProgram } = await import("../cli-program.js");
const { allCommands, commandPath, honorsDryRun, networkOf, parseNetwork } = await import("../cli-flags.js");
const { assertStrategySimulatable, dryRunAdapter, NON_SIMULATABLE_STRATEGIES } = await import("../bot/engine.js");

function program(): Command {
  const { program: p } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
  for (const c of [p, ...allCommands(p)]) {
    c.exitOverride();
    c.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  }
  return p;
}

let out: string[];
const fetchSpy = vi.fn(async (url: unknown) => { throw new Error(`unexpected network call: ${String(url)}`); });

beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const run = (args: string[]) => program().parseAsync(["node", "perp", ...args]);
const lastJson = (): { ok: boolean; data?: Record<string, unknown> } => JSON.parse(out.filter(l => l.trim().startsWith("{")).at(-1)!);

// ── C1: --dry-run in either argv position ────────────────────────────────────

describe("C1 — root --dry-run honored wherever it appears (real root program)", () => {
  it.each([
    [["--json", "--dry-run", "funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "5"]],
    [["--json", "funds", "bridge", "send", "--from", "arbitrum", "--to", "base", "--amount", "5", "--dry-run"]],
  ])("funds bridge send %j → quotes only, nothing sent", async (argv) => {
    await run(argv);
    expect(executeBestBridge).not.toHaveBeenCalled();
    expect(checkBridgeGasBalance).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false } });
  });

  it.each([
    [["--json", "--dry-run", "funds", "bridge", "exchange", "--from", "lighter", "--to", "pacifica", "--amount", "5"]],
    [["--json", "funds", "bridge", "exchange", "--from", "lighter", "--to", "pacifica", "--amount", "5", "--dry-run"]],
  ])("funds bridge exchange %j → nothing sent", async (argv) => {
    await run(argv);
    expect(executeBestBridge).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false } });
  });

  it("funds bridge exchange hyperliquid → pacifica (HyperCore → Solana CCTP) is refused: NO_BRIDGE_ROUTE, nothing sent", async () => {
    await expect(run(["--json", "--dry-run", "funds", "bridge", "exchange", "--from", "hyperliquid", "--to", "pacifica", "--amount", "5"]))
      .rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
    expect(executeBestBridge).not.toHaveBeenCalled();
  });

  it.each([
    [["--json", "--dry-run", "-e", "hl", "funds", "withdraw", "hyperliquid", "100"]],
    [["--json", "-e", "hl", "funds", "withdraw", "hyperliquid", "100", "--dry-run"]],
  ])("funds withdraw hyperliquid %j → plan, adapter.withdraw never called", async (argv) => {
    await run(argv);
    expect(stubAdapter.withdraw).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, action: "withdraw", venue: "hyperliquid", amount: "100" } });
  });

  it.each([
    [["--json", "--dry-run", "strategy", "plan", "execute", "PLAN"]],
    [["--json", "strategy", "plan", "execute", "PLAN", "--dry-run"]],
  ])("strategy plan execute %j → executePlan(dryRun: true)", async (argv) => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "plan.json");
    writeFileSync(file, JSON.stringify({ version: "1.0", steps: [{ id: "s1", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.001" } }] }));
    await run(argv.map(a => (a === "PLAN" ? file : a)));
    expect(executePlan).toHaveBeenCalledTimes(1);
    expect((executePlan.mock.calls[0] as unknown[])[2]).toMatchObject({ dryRun: true });
  });

  it.each([
    [["--json", "--dry-run", "arb", "auto", "--background"]],
    [["--json", "arb", "auto", "--background", "--dry-run"]],
  ])("arb auto --background %j → the background child inherits --dry-run", async (argv) => {
    await run(argv);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(startJob.mock.calls[0][0]).toMatchObject({ dryRun: true });
    const { jobArgv } = await vi.importActual<typeof import("../jobs.js")>("../jobs.js");
    expect(jobArgv(startJob.mock.calls[0][0] as never, "j")).toContain("--dry-run");
  });

  it("arb auto --background WITHOUT --dry-run → child is live (no --dry-run injected)", async () => {
    await run(["--json", "arb", "auto", "--background"]);
    expect(startJob.mock.calls[0][0]).toMatchObject({ dryRun: false });
    expect(startJob.mock.calls[0][0].cliArgs).not.toContain("--dry-run");
  });

  it("no command in the tree re-declares --dry-run / -n / --network (the root would swallow it)", () => {
    const offenders = allCommands(program()).flatMap(c =>
      c.options.filter(o => o.long === "--dry-run" || o.long === "--network" || o.short === "-n").map(o => `${commandPath(c)} ${o.flags}`));
    expect(offenders).toEqual([]);
  });
});

// ── C2: -n validation ────────────────────────────────────────────────────────

describe("C2 — -n is validated, never coerced to mainnet", () => {
  it.each([["Testnet"], ["main"], ["tesnet"]])("-n %s → usage error before any action", async (net) => {
    await expect(run(["--json", "-n", net, "--dry-run", "-e", "hl", "funds", "withdraw", "hyperliquid", "1"]))
      .rejects.toThrow(/Allowed choices are mainnet, testnet/);
    expect(stubAdapter.withdraw).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("-n testnet reaches the command as testnet", async () => {
    await run(["--json", "-n", "testnet", "--dry-run", "-e", "hl", "funds", "withdraw", "hyperliquid", "1"]);
    expect(lastJson()).toMatchObject({ ok: true, data: { network: "testnet" } });
  });

  it("networkOf / parseNetwork throw INVALID_PARAMS on anything but mainnet/testnet", () => {
    expect(parseNetwork("mainnet")).toBe("mainnet");
    expect(parseNetwork("testnet")).toBe("testnet");
    for (const bad of [undefined, "Mainnet", "", "devnet"]) {
      expect(() => parseNetwork(bad)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
    }
    const p = program();
    p.setOptionValue("network", "Testnet");
    expect(() => networkOf(p)).toThrow(/Invalid network/);
  });
});

// ── H1: default-deny dry-run guard + fund movements ──────────────────────────

/**
 * Every command allowed to see --dry-run. Adding a command here is a reviewed decision: it
 * must return a plan (sent:false) before loading keys or signing. Everything else is refused.
 */
const DRY_RUN_COMMANDS = [
  "arb auto", "arb close", "arb exec", "arb rebalance",
  "funds address-book add",
  "funds bridge exchange", "funds bridge send",
  "funds deposit aster", "funds deposit hyperliquid", "funds deposit lighter cctp", "funds deposit lighter ethereum", "funds deposit lighter-rh", "funds deposit ondo", "funds deposit pacifica", "funds deposit qfex",
  // Refusing subcommands (app-only RISEx funds; market-data-only TxFlow / Variational / GRVT): refused also under --dry-run.
  "funds deposit risex", "funds deposit txflow", "funds deposit variational", "funds deposit grvt",
  "funds faucet pacifica", "funds faucet risex",
  "funds rebalance execute", "funds transfer",
  "funds withdraw arcus", "funds withdraw aster", "funds withdraw hyperliquid", "funds withdraw lighter", "funds withdraw ondo", "funds withdraw pacifica", "funds withdraw qfex",
  "funds withdraw risex", "funds withdraw txflow", "funds withdraw variational", "funds withdraw grvt",
  "outcome buy", "outcome sell",
  // Pacifica Print / vaults: --dry-run prints the exact message + body, signs and sends nothing.
  "print cancel", "print deposit", "vault deposit", "vault withdraw",
  "wallet manage referral set", "wallet builder approve", "wallet builder revoke",
  "strategy plan execute", "strategy run",
  "trade buy", "trade cancel", "trade cancel-all", "trade close", "trade close-all", "trade edit", "trade flatten", "trade leverage",
  "trade atomic", "trade limit", "trade market", "trade reduce", "trade scale-in", "trade scale-tp", "trade sell", "trade split",
  "trade spot-buy", "trade spot-cancel", "trade spot-limit", "trade spot-sell", "trade spot-transfer", "trade stop", "trade tpsl",
].sort();

describe("H1 — central dry-run guard (default-deny)", () => {
  it("the set of dry-run-aware commands is exactly the reviewed list", () => {
    const aware = allCommands(program()).filter(honorsDryRun).map(commandPath).sort();
    expect(aware).toEqual(DRY_RUN_COMMANDS);
  });

  it.each([
    [["wallet", "agent", "approve", "hyperliquid", "--master", "main"]],
    [["wallet", "agent", "revoke", "hyperliquid", "x"]],
    [["trade", "twap", "BTC", "buy", "0.1", "10m"]],
    [["strategy", "start", "cfg.yaml", "--background"]],
    [["setup", "--non-interactive"]],
  ])("--dry-run on a command that cannot simulate (%j) → INVALID_PARAMS, action never runs", async (args) => {
    for (const argv of [["--dry-run", ...args], [...args, "--dry-run"]]) {
      await expect(run(argv)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  });

  it.each([
    [["funds", "deposit", "pacifica", "20"], "pacifica"],
    [["funds", "deposit", "hyperliquid", "20"], "hyperliquid"],
    [["funds", "deposit", "lighter", "ethereum", "20"], "lighter"],
    [["funds", "deposit", "lighter", "cctp", "arbitrum", "20"], "lighter"],
    [["funds", "withdraw", "pacifica", "20"], "pacifica"],
    [["-e", "lighter", "funds", "withdraw", "lighter", "20"], "lighter"],
    [["-e", "lighter-rh", "funds", "withdraw", "lighter", "20"], "lighter-rh"],
  ])("%j --dry-run → plan with sent:false; no key, relayer, adapter write or network", async (args, venue) => {
    await run(["--json", "--dry-run", ...args]);
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue } });
    expect(loadPrivateKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stubAdapter.withdraw).not.toHaveBeenCalled();
    expect(stubAdapter.usdTransfer).not.toHaveBeenCalled();
  });

  it("funds transfer --dry-run evaluates the settings withdraw.hyperliquid gate: unset → POLICY_DENIED; allowlisted → plan; nothing sent", async () => {
    const dest = "0x2222222222222222222222222222222222222222";
    await expect(run(["--json", "--dry-run", "funds", "transfer", "20", dest])).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    mkdirSync(resolve(process.env.HOME as string, ".perp"), { recursive: true });
    writeFileSync(resolve(process.env.HOME as string, ".perp", "settings.json"), JSON.stringify({ withdraw: { hyperliquid: { allowlist: [dest], maxPerTx: 100, maxPerDay: 100 } } }));
    try {
      await run(["--json", "--dry-run", "funds", "transfer", "20", dest]);
      expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue: "hyperliquid" } });
    } finally {
      writeFileSync(resolve(process.env.HOME as string, ".perp", "settings.json"), JSON.stringify({}));
    }
    expect(loadPrivateKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stubAdapter.usdTransfer).not.toHaveBeenCalled();
  });
});

// ── H2: bot dry-run ──────────────────────────────────────────────────────────

describe("H2 — strategy dry-run", () => {
  it("strategy run <non-simulatable> --dry-run → INVALID_PARAMS before any adapter is built", async () => {
    for (const s of NON_SIMULATABLE_STRATEGIES) {
      await expect(run(["--dry-run", "strategy", "run", s])).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    }
    expect(stubAdapter.getBalance).not.toHaveBeenCalled();
  });

  it.each([
    [["--json", "--dry-run", "strategy", "run", "grid", "BTC", "--param", "upper=110", "--param", "lower=90", "--param", "grids=5", "--param", "size=0.01"]],
    [["--json", "strategy", "run", "grid", "BTC", "--param", "upper=110", "--param", "lower=90", "--param", "grids=5", "--param", "size=0.01", "--dry-run"]],
  ])("strategy run grid %j → runBot(..., isDryRun=true)", async (argv) => {
    await run(argv);
    expect(runBot).toHaveBeenCalledTimes(1);
    expect((runBot.mock.calls[0] as unknown[])[6]).toBe(true);
  });

  it("assertStrategySimulatable accepts action-based strategies", () => {
    expect(() => assertStrategySimulatable("grid")).not.toThrow();
    expect(() => assertStrategySimulatable("funding-arb")).toThrow(/cannot simulate/);
  });

  it("dryRunAdapter blocks every venue write but passes reads through", async () => {
    const a = dryRunAdapter(stubAdapter as never) as unknown as typeof stubAdapter;
    expect(() => a.marketOrder()).toThrow(/blocked/);
    expect(() => a.withdraw()).toThrow(/blocked/);
    expect(() => a.setLeverage()).toThrow(/blocked/);
    await expect(a.getBalance()).resolves.toMatchObject({ equity: "1000" });
    expect(stubAdapter.marketOrder).not.toHaveBeenCalled();
  });

  it("dryRunAdapter is an allowlist (L4): an unknown / newly added method is blocked, non-function props pass", () => {
    const extra = { ...stubAdapter, someFutureWrite: vi.fn(), setupApiKey: vi.fn(), init: vi.fn() };
    const a = dryRunAdapter(extra as never) as unknown as typeof extra;
    expect(() => a.someFutureWrite()).toThrow(/only read methods are allowed/);
    expect(() => a.setupApiKey()).toThrow(/blocked/);
    expect(() => a.init()).toThrow(/blocked/);
    expect(extra.someFutureWrite).not.toHaveBeenCalled();
    expect(a.name).toBe("hyperliquid");
    expect(a.address).toBe(stubAdapter.address);
  });
});

// ── L10: secrets on argv ─────────────────────────────────────────────────────

describe("L10 — root -k is rejected, --passphrase warns (real root program)", () => {
  it.each([
    [["-k", "0x" + "11".repeat(32), "--json", "account", "balance"]],
    [["--json", "account", "balance", "--private-key", "0x" + "11".repeat(32)]],
  ])("%j → INVALID_PARAMS before any action / key use", async (argv) => {
    const err = await run(argv).then(() => null, (e: unknown) => e);
    expect((err as { structured?: { code?: string } }).structured?.code).toBe("INVALID_PARAMS");
    expect((err as Error).message).toMatch(/-k\/--private-key is rejected/);
    expect((err as { structured?: { remediation?: string } }).structured?.remediation).toMatch(/perp wallet set/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--passphrase still parses but prints a loud deprecation warning on stderr", async () => {
    const errs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { errs.push(String(c)); return true; });
    await run(["--passphrase", "pp", "--json", "settings", "show"]).catch(() => { /* the command outcome is irrelevant */ });
    expect(errs.join("")).toMatch(/--passphrase on the command line is DEPRECATED/);
  });
});

// ── --dex is Hyperliquid-only: never dropped for another -e venue ───────────

describe("root --dex with a non-Hyperliquid -e venue (real root program)", () => {
  const codeOf = async (argv: string[]): Promise<string | undefined> => {
    try {
      await run(argv);
    } catch (e) {
      return (e as { structured?: { code?: string } }).structured?.code;
    }
    return (lastJson() as { error?: { code?: string } }).error?.code;
  };

  it.each([
    [["--json", "-e", "pacifica", "--dex", "xyz", "account", "positions"]],
    [["--json", "-e", "pacifica", "--dex", "xyz", "market", "list"]],
  ])("%j → INVALID_PARAMS, the venue is never read", async (argv) => {
    expect(await codeOf(argv)).toBe("INVALID_PARAMS");
    expect(stubAdapter.getPositions).not.toHaveBeenCalled();
    expect(stubAdapter.getMarkets).not.toHaveBeenCalled();
  });

  it("--dex with the DEFAULT exchange (no -e typed) names it as the default; public reads (market mid) are refused too", async () => {
    const { program: p } = buildProgram({ defaultExchange: "pacifica", version: "test" });
    for (const c of [p, ...allCommands(p)]) { c.exitOverride(); c.configureOutput({ writeErr: () => {}, writeOut: () => {} }); }
    let err: { structured?: { code?: string }; message?: string } | undefined;
    try { await p.parseAsync(["node", "perp", "--json", "--dex", "xyz", "market", "mid", "GOLD"]); } catch (e) { err = e as typeof err; }
    const code = err?.structured?.code ?? (lastJson() as { error?: { code?: string } }).error?.code;
    const message = err?.message ?? (lastJson() as { error?: { message?: string } }).error?.message;
    expect(code).toBe("INVALID_PARAMS");
    expect(message).toContain("the default exchange (pacifica)");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("-e hyperliquid --dex xyz is accepted", async () => {
    await run(["--json", "-e", "hyperliquid", "--dex", "xyz", "account", "positions"]);
    expect(stubAdapter.getPositions).toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ ok: true });
  });
});
