/**
 * QFEX gates outside the adapter:
 *  - funding exclusion: fetchVenuesRates drops unverified-funding venues unless asked; funding
 *    strategies and arb legs refuse them;
 *  - MCP: a reduce-only order on a reduce-only-gated venue is refused before any read / risk call;
 *  - CLI: user --client-id refused, --tp/--sl / tpsl / edit refused before anything is sent,
 *    withdraw gate (dry-run evaluates it; changing it needs a terminal), approve → import.
 *
 * No network: fetch throws on any call. HOME is isolated by the vitest setup file.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const enforceOrderRisk = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../trade-validator.js", async (orig) => ({
  ...(await orig<typeof import("../trade-validator.js")>()),
  enforceOrderRisk: (...a: unknown[]) => enforceOrderRisk(...a),
}));

import "../exchanges/venues/index.js";
import { PerpError } from "../errors.js";
import { assertFundingArbVenue, getVenue, listVenues, type VenueDefinition } from "../exchanges/venue.js";
import type { VenueFundingRate } from "../exchanges/venue-types.js";
import { fetchVenuesRates } from "../funding/rates.js";
import { assertFundingArbLegs } from "../bot/strategies/funding-arb-utils.js";
import { FundingArbV2Strategy } from "../bot/strategies/funding-arb-v2.js";
import type { StrategyContext } from "../bot/strategy-types.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { mcpPreTradeGate, mcpReduceOnlyGate } from "../mcp-trade-guard.js";
import { QFEX_AUTOMATION_VERIFIED, QFEX_RESTING_REDUCE_ONLY_VERIFIED, qfexAutomationGate, qfexReduceOnlyGate } from "../exchanges/qfex/signing.js";
import { assertCanClosePositions, automationGateOf, reduceOnlyGateOf } from "../exchanges/trading-v2.js";
import { qfexVenue } from "../exchanges/venues/qfex.js";
import { QfexAdapter } from "../exchanges/qfex/adapter.js";
import { READ_ONLY_CREDENTIALS } from "../exchanges/venue.js";
import { runTWAP } from "../strategies/twap.js";
import { runDCA } from "../strategies/dca.js";
import { runGrid } from "../strategies/grid.js";
import { runFundingArb } from "../strategies/funding-arb.js";
import { runTrailingStop } from "../strategies/trailing-stop.js";
import { executePlan } from "../plan-executor.js";
import { runBot } from "../bot/engine.js";
import { startJob } from "../jobs.js";
import { saveVenueSecret } from "../agent-wallet/venue-keystore.js";
import { loadSettings, validateWithdrawGate } from "../settings.js";
import { buildProgram } from "../cli-program.js";

const SETTINGS = resolve(process.env.HOME as string, ".perp", "settings.json");
const PUB = "qfex_pub_gates_test";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const DEST = "0x89abcdef0123456789abcdef0123456789abcdef";

function writeSettings(obj: Record<string, unknown>): void {
  mkdirSync(resolve(process.env.HOME as string, ".perp"), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(obj));
}

const AGENTS = {
  qfex: {
    "web-qfex": {
      kind: "qfex", agentName: "web-qfex", publicKey: PUB, keystorePath: "", accountId: ACCOUNT, isPrimaryAccount: true,
      permissions: { viewPositions: true, viewBalance: true, viewOrders: true, executeOrders: null, depositWithdraw: null },
      network: "mainnet", approvedAt: "2026-10-04T00:00:00Z", source: "imported",
    },
  },
};

function codeOf(fn: () => unknown): PerpError {
  try { fn(); } catch (e) { return e as PerpError; }
  throw new Error("expected a throw");
}

beforeAll(() => {
  saveVenueSecret("qfex-agents", PUB, JSON.stringify({ publicKey: PUB, secret: "qfex_secret_gates_test" }), "");
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  if (existsSync(SETTINGS)) rmSync(SETTINGS);
  enforceOrderRisk.mockClear();
  fetchMock = vi.fn(async (url: string) => { throw new Error(`unexpected network call: ${url}`); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

// ── Funding exclusion ──

describe("funding exclusion (venue flag fundingVerified)", () => {
  const row = (venue: string): VenueFundingRate => ({
    venue: venue as VenueFundingRate["venue"], venueSymbol: "AAPL", symbol: "AAPL", canonical: "AAPL", rate: "0.0001",
    basis: { kind: "perHours", hours: 1 }, markPrice: "100", nextFundingTime: null,
  });
  const fake = (id: string, fundingVerified: boolean) => {
    const fetchFundingRates = vi.fn(async () => [row(id)]);
    const def = { ...getVenue("ondo"), id, fundingVerified, publicData: { fetchFundingRates, fetchMarkets: vi.fn(async () => []) } } as unknown as VenueDefinition;
    return { def, fetchFundingRates };
  };

  it("qfex, txflow (rate kind undocumented, no funding history), variational (predicted, no settled-payment check) grvt (indicative rate) and extended (no settled-payment check; `_24_5` equities print 0 off hours) are the only venues with unverified funding", () => {
    expect(listVenues().filter(v => !v.fundingVerified).map(v => v.id)).toEqual(["qfex", "txflow", "variational", "grvt", "extended"]);
  });

  it("fetchVenuesRates drops an unverified venue (not even fetched) unless includeUnverified", async () => {
    const ok = fake("ondo", true);
    const unverified = fake("qfex", false);
    const dropped = await fetchVenuesRates([ok.def, unverified.def], "mainnet", false);
    expect(dropped.rates.map(r => r.exchange)).toEqual(["ondo"]);
    expect(dropped.exchangeStatus).toEqual({ ondo: "ok" });
    expect(unverified.fetchFundingRates).not.toHaveBeenCalled();

    const included = await fetchVenuesRates([ok.def, unverified.def], "mainnet", true);
    expect(included.rates.map(r => `${r.exchange}:${r.fundingVerified}`)).toEqual(["ondo:true", "qfex:false"]);
    expect(unverified.fetchFundingRates).toHaveBeenCalledTimes(1);
  });

  it("assertFundingArbVenue refuses qfex (and its alias) with the uniform unsupported response; verified venues pass", () => {
    for (const ref of ["qfex", "qf", "QFEX"]) {
      const e = codeOf(() => assertFundingArbVenue(ref));
      expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(e.structured.details).toMatchObject({ venue: "qfex", feature: "fundingArb" });
      expect(e.structured.remediation).toMatch(/--include-unverified/);
    }
    for (const ref of ["hyperliquid", "hl:xyz", "ondo", "lighter-rh"]) expect(() => assertFundingArbVenue(ref)).not.toThrow();
    expect(codeOf(() => assertFundingArbVenue("nope")).structured.code).toBe("UNKNOWN_VENUE");
  });

  const ctxWith = (primary: string, extra: string[]): StrategyContext => ({
    adapter: { name: primary } as ExchangeAdapter, symbol: "AAPL", config: {}, tick: 0, log: () => undefined,
    state: new Map<string, unknown>([["extraAdapters", new Map(extra.map(n => [n, { name: n } as ExchangeAdapter]))]]),
  });

  it("funding strategies refuse qfex as a leg — primary or extra adapter — when they start", async () => {
    expect(codeOf(() => assertFundingArbLegs(ctxWith("hyperliquid", ["qfex"]))).structured.details).toMatchObject({ feature: "fundingArb" });
    expect(codeOf(() => assertFundingArbLegs(ctxWith("qfex", ["hyperliquid"]))).structured.details).toMatchObject({ feature: "fundingArb" });
    expect(() => assertFundingArbLegs(ctxWith("hyperliquid", ["lighter", "mock-venue"]))).not.toThrow();
    await expect(new FundingArbV2Strategy().init(ctxWith("hyperliquid", ["qfex"]), {} as never))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
  });
});

// ── MCP ──

describe("MCP reduce-only gate", () => {
  const gated = { name: "qfex", reduceOnlyGate: () => qfexReduceOnlyGate(null) } as unknown as ExchangeAdapter;
  const open = { name: "qfex", reduceOnlyGate: () => qfexReduceOnlyGate("boolean") } as unknown as ExchangeAdapter;
  const plain = { name: "hyperliquid" } as unknown as ExchangeAdapter;

  it("trade_close path: refused up front with the uniform unsupported response", () => {
    const e = codeOf(() => mcpReduceOnlyGate(gated));
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.structured.details).toMatchObject({ venue: "qfex", feature: "reduceOnly" });
    expect(() => mcpReduceOnlyGate(open)).not.toThrow();
    expect(() => mcpReduceOnlyGate(plain)).not.toThrow();
  });

  it("trade_execute path: a reduce-only order is refused BEFORE the risk gate runs; other orders reach it", async () => {
    await expect(mcpPreTradeGate(gated, { symbol: "AAPL", size: 1, price: null, reduceOnly: true }, () => undefined))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(enforceOrderRisk).not.toHaveBeenCalled();
    await mcpPreTradeGate(gated, { symbol: "AAPL", size: 1, price: null, reduceOnly: false }, () => undefined);
    expect(enforceOrderRisk).toHaveBeenCalledTimes(1);
    expect(enforceOrderRisk.mock.calls[0][1]).toMatchObject({ force: false });
  });
});

// ── Automation gate ──

describe("automation gate: unattended flows are refused on QFEX while stops are refused; manual reduce-only stays open", () => {
  const calls = { marketOrder: vi.fn(), limitOrder: vi.fn(), getMarkets: vi.fn(), getBalance: vi.fn(), getPositions: vi.fn() };
  // The shape of QfexAdapter today: reduce-only open (Q2), automation gated.
  const qfex = { name: "qfex", reduceOnlyGate: () => qfexReduceOnlyGate("boolean"), automationGate: () => qfexAutomationGate(null), ...calls } as unknown as ExchangeAdapter;
  const verified = { name: "qfex", reduceOnlyGate: () => qfexReduceOnlyGate("boolean"), automationGate: () => qfexAutomationGate(true) } as unknown as ExchangeAdapter;
  const plain = { name: "hyperliquid" } as unknown as ExchangeAdapter;
  beforeEach(() => { for (const f of Object.values(calls)) f.mockReset(); });

  it("both constants ship unset: automation refused, resting reduce-only refused (IOC only)", () => {
    expect(QFEX_AUTOMATION_VERIFIED).toBeNull();
    expect(QFEX_RESTING_REDUCE_ONLY_VERIFIED).toBeNull();
    expect(qfexVenue.capabilities!.reduceOnlyTif).toEqual(["IOC"]);
  });

  it("qfexAutomationGate: null → the uniform unsupported response; true → open", () => {
    const e = qfexAutomationGate(null) as PerpError;
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.structured.details).toMatchObject({ venue: "qfex", feature: "automation" });
    expect(e.structured.remediation).toMatch(/manual commands.*Q2 \/ Q4/);
    expect(qfexAutomationGate(true)).toBeNull();
  });

  it("the real QfexAdapter reports the automation gate while its reduce-only gate is open", () => {
    const a = new QfexAdapter(qfexVenue, { network: "mainnet", credentials: READ_ONLY_CREDENTIALS, noAgent: false, hlDex: null, readOnly: true, noBuilder: false });
    expect(reduceOnlyGateOf(a)).toBeNull(); // manual close / reduce / flatten ask only this one
    expect((automationGateOf(a) as PerpError).structured.details).toMatchObject({ feature: "automation" });
    expect(automationGateOf(plain)).toBeNull();
  });

  it("assertCanClosePositions: reduce-only gate first, then the automation gate; open and ungated adapters pass", () => {
    const e = codeOf(() => assertCanClosePositions(qfex, "TWAP on qfex"));
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.message).toMatch(/^TWAP on qfex refused: it would trade unattended — /);
    expect(e.structured.details).toMatchObject({ venue: "qfex", feature: "automation" });
    expect(e.structured.remediation).toMatch(/manual commands/);

    const both = { name: "qfex", reduceOnlyGate: () => qfexReduceOnlyGate(null), automationGate: () => qfexAutomationGate(null) };
    const first = codeOf(() => assertCanClosePositions(both, "Bot"));
    expect(first.message).toMatch(/could open a position it cannot close/);
    expect(first.structured.details).toMatchObject({ feature: "reduceOnly" });

    expect(() => assertCanClosePositions(verified, "Bot")).not.toThrow();
    expect(() => assertCanClosePositions(plain, "Bot")).not.toThrow();
  });

  it("TWAP / DCA / grid / funding-arb / trailing stop / plan / bot refuse before any order or read", async () => {
    const refused = async (p: Promise<unknown>) => {
      await expect(p).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { feature: "automation" } } });
    };
    await refused(runTWAP(qfex, { symbol: "AAPL", side: "buy", totalSize: 1, durationSec: 60 }, undefined, () => {}));
    await refused(runDCA(qfex, { symbol: "AAPL", side: "buy", amountPerOrder: 1, intervalSec: 60, totalOrders: 2 }, undefined, () => {}));
    await refused(runGrid(qfex, { symbol: "AAPL", upperPrice: 2, lowerPrice: 1, grids: 3, totalSize: 1 } as never, undefined, () => {}));
    await refused(runFundingArb(new Map([["hyperliquid", plain], ["qfex", qfex]]), {} as never, undefined, () => {}));
    await refused(runTrailingStop(qfex, { symbol: "AAPL", trailPct: 3 }, undefined, () => {}));
    await refused(executePlan(qfex, { version: "1.0", steps: [{ id: "a", action: "market_order", params: { symbol: "AAPL", side: "buy", size: "1" } }] } as never));
    await refused(runBot(qfex, { strategy: { type: "grid" } } as never, undefined, (() => {}) as never, undefined, "silent" as never, false));
    await refused(runBot(plain, { strategy: { type: "grid" } } as never, undefined, (() => {}) as never, new Map([["qfex", qfex]]), "silent" as never, false));
    for (const f of Object.values(calls)) expect(f).not.toHaveBeenCalled();
  });

  it("startJob refuses a qfex background job before tmux is touched (venue or exchange, any case)", () => {
    const base = { strategy: "twap", exchange: "qfex", network: "mainnet" as const, dryRun: false, cliArgs: [], selectors: { ows: null, wallet: null, noAgent: false, dex: null, noBuilder: false } };
    for (const o of [base, { ...base, exchange: "hyperliquid", venue: "QFEX" }]) {
      const e = codeOf(() => startJob(o as never));
      expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(e.message).toMatch(/^Background job "twap" refused: it would trade unattended — /);
      expect(e.structured.details).toMatchObject({ venue: "qfex", feature: "automation" });
    }
  });
});

// ── CLI ──

describe("CLI gates (-e qfex), nothing is sent", () => {
  const run = async (args: string[]): Promise<{ ok: boolean; error?: { code: string; message: string; remediation?: string; details?: Record<string, unknown> }; data?: Record<string, unknown> }> => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { lines.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    try {
      await program.parseAsync(["node", "perp", "--json", ...args]);
    } catch (e) {
      // Commands without their own JSON error wrapper throw to the CLI's top-level handler.
      if (!(e instanceof PerpError)) throw e;
      return { ok: false, error: e.structured as never };
    } finally {
      vi.restoreAllMocks();
      vi.stubGlobal("fetch", fetchMock);
    }
    const json = lines.map(l => l.trim()).filter(l => l.startsWith("{"));
    return JSON.parse(json[json.length - 1]);
  };

  it("--client-id is refused on qfex (generated ids only)", async () => {
    writeSettings({ agents: AGENTS });
    const r = await run(["-e", "qfex", "trade", "market", "AAPL", "buy", "1", "--client-id", "my-order-1"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(r.error!.details).toMatchObject({ feature: "clientOrderId" });
    expect(r.error!.remediation).toMatch(/Omit --client-id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["market --tp", ["trade", "market", "AAPL", "buy", "1", "--tp", "400"]],
    ["limit --sl", ["trade", "limit", "AAPL", "buy", "330", "1", "--tif", "IOC", "--sl", "300"]],
    ["tpsl", ["trade", "tpsl", "AAPL", "long", "--sl", "300"]],
  ])("%s → no longer refused up front (Q21 passed): it goes on to read the venue", async (_n, args) => {
    writeSettings({ agents: AGENTS });
    const r = await run(["-e", "qfex", ...args]);
    expect(r.ok).toBe(false); // this suite's fetch throws on any call
    expect(r.error!.details).not.toMatchObject({ feature: "stopOrder" });
    expect(fetchMock).toHaveBeenCalled();
  });

  it.each([
    ["limit --reduce-only (default GTC)", ["trade", "limit", "AAPL", "sell", "330", "1", "--reduce-only"]],
    ["limit --reduce-only --tif ALO", ["trade", "limit", "AAPL", "sell", "330", "1", "--reduce-only", "--tif", "ALO"]],
  ])("%s → restingReduceOnly unsupported before any read or send (IOC only)", async (_n, args) => {
    writeSettings({ agents: AGENTS });
    const r = await run(["-e", "qfex", ...args]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(r.error!.details).toMatchObject({ feature: "restingReduceOnly" });
    expect(r.error!.remediation).toMatch(/Use --tif IOC, or set a take-profit \/ stop-loss on the position instead: perp trade tpsl AAPL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["close", ["trade", "close", "AAPL"]],
    ["close-all", ["trade", "close-all"]],
    ["reduce", ["trade", "reduce", "AAPL", "50"]],
    ["limit --reduce-only --tif IOC", ["trade", "limit", "AAPL", "sell", "330", "1", "--reduce-only", "--tif", "IOC"]],
  ])("%s is a manual command — not gated by reduce-only or automation: it goes on to read the account", async (_n, args) => {
    writeSettings({ agents: AGENTS });
    const r = await run(["-e", "qfex", ...args]);
    expect(r.ok).toBe(false); // this suite's fetch throws on any call
    expect(r.error!.code).not.toBe("CAPABILITY_UNSUPPORTED");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("trade edit is no longer refused up front (Q5 passed): it goes on to read the order", async () => {
    writeSettings({ agents: AGENTS });
    const r = await run(["-e", "qfex", "trade", "edit", "AAPL", "o1", "330", "1"]);
    expect(r.ok).toBe(false); // fetch throws
    expect(r.error!.details ?? {}).not.toMatchObject({ feature: "amend" });
  });

  it("funds withdraw qfex is disabled: CAPABILITY_UNSUPPORTED live and under --dry-run, even with the gate set; nothing sent", async () => {
    writeSettings({ withdraw: { qfex: { allowlist: [DEST], maxPerTx: 100, maxPerDay: 200 } } });
    for (const argv of [
      ["--dry-run", "funds", "withdraw", "qfex", "10", "--to", DEST],
      ["funds", "withdraw", "qfex", "10", "--to", DEST],
      ["funds", "withdraw", "qfex"],
    ]) {
      const r = await run(argv);
      expect(r.error!.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(r.error!.remediation).toMatch(/QFEX web app/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("funds deposit qfex: --dry-run plans without a call; TRON is unsupported", async () => {
    const plan = await run(["--dry-run", "funds", "deposit", "qfex"]);
    expect(plan.data).toMatchObject({ dryRun: true, sent: false, venue: "qfex", asset: "USDC" });
    const tron = await run(["--dry-run", "funds", "deposit", "qfex", "--chain", "tron"]);
    expect(tron.error!.details).toMatchObject({ feature: "depositTron" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settings set withdraw.qfex is refused under --json / without a terminal (no --yes); nothing is saved", async () => {
    const r = await run(["settings", "set", "withdraw.qfex", `${DEST},100,200`]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("POLICY_DENIED");
    expect(r.error!.remediation).toMatch(/without --json/);
    expect(loadSettings().withdraw).toEqual({});
    const yes = await run(["settings", "set", "withdraw.qfex", `${DEST},100,200`, "--yes"]);
    expect(yes.error!.code).toBe("POLICY_DENIED"); // --yes does not confirm a withdraw gate
    expect(loadSettings().withdraw).toEqual({});
    const bad = await run(["settings", "set", "withdraw.qfex", `${DEST},100`]);
    expect(bad.error!.code).toBe("INVALID_PARAMS");
  });

  it("settings unset withdraw.qfex turns withdrawals off again (no confirmation needed)", async () => {
    writeSettings({ withdraw: { qfex: { allowlist: [DEST], maxPerTx: 100, maxPerDay: 200 } } });
    expect(loadSettings().withdraw.qfex).toEqual({ allowlist: [DEST], maxPerTx: 100, maxPerDay: 200 });
    const r = await run(["settings", "unset", "withdraw.qfex"]);
    expect(r.ok).toBe(true);
    expect(loadSettings().withdraw).toEqual({});
  });
});

describe("settings.withdraw validation", () => {
  const invalid = (p: string) => new PerpError("INVALID_PARAMS", p);
  it("ships empty; accepts a valid gate (addresses lowercased, de-duplicated)", () => {
    expect(loadSettings().withdraw).toEqual({});
    expect(validateWithdrawGate("qfex", { allowlist: [DEST.toUpperCase().replace("0X", "0x"), DEST], maxPerTx: 1, maxPerDay: 2 }, invalid))
      .toEqual({ allowlist: [DEST], maxPerTx: 1, maxPerDay: 2 });
  });
  it.each([
    ["a venue without a gate", "ondo", { allowlist: [DEST], maxPerTx: 1, maxPerDay: 1 }, /no withdraw gate/],
    ["a non-address", "qfex", { allowlist: ["TXYZ"], maxPerTx: 1, maxPerDay: 1 }, /EVM addresses/],
    ["a missing maxPerDay", "qfex", { allowlist: [DEST], maxPerTx: 1 }, /maxPerDay/],
    ["zero maxPerTx", "qfex", { allowlist: [DEST], maxPerTx: 0, maxPerDay: 1 }, /maxPerTx/],
    ["maxPerDay below maxPerTx", "qfex", { allowlist: [DEST], maxPerTx: 5, maxPerDay: 1 }, /below maxPerTx/],
    ["an unknown key", "qfex", { allowlist: [DEST], maxPerTx: 1, maxPerDay: 1, extra: 1 }, /unknown key "extra"/],
  ])("rejects %s", (_n, venue, raw, msg) => {
    expect(() => validateWithdrawGate(venue, raw, invalid)).toThrow(msg);
  });
  it("a malformed settings.withdraw makes loadSettings fail (never ignored)", () => {
    writeSettings({ withdraw: { qfex: { allowlist: [DEST] } } });
    expect(() => loadSettings()).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
});
