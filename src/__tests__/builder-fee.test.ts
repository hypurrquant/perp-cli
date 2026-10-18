/**
 * Builder fees — uniform, default OFF (src/exchanges/builder-fee.ts).
 *
 *  - default: no settings.builder entry → no builder field on ANY venue's order payload
 *  - configured + approved → the exact per-venue fields (HL builder {b,f}, Pacifica
 *    builder_code, Aster builder + feeRate, Ondo builderCode incl. position stops)
 *  - approval missing / unknown → sent WITHOUT the fee + a note (never fails the order)
 *  - strict settings validation (caps, identity format, unsupported venues)
 *  - spot (Pacifica) and HIP-3 exclusion, --no-builder, legacy migration notice,
 *    PACIFICA_BUILDER_CODE / DEBRIDGE_* env vars no longer read.
 *
 * No network (fetch is mocked per test); HOME isolated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Keypair } from "@solana/web3.js";

const TEST_HOME = resolve(os.tmpdir(), `perp-builder-fee-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);
const SETTINGS = resolve(TEST_HOME, ".perp", "settings.json");

await import("../exchanges/venues/index.js");
const { loadSettings } = await import("../settings.js");
const bf = await import("../exchanges/builder-fee.js");
const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
const { PacificaAdapter } = await import("../exchanges/pacifica.js");
const { PacificaSpotAdapter } = await import("../exchanges/pacifica-spot.js");
const { AsterAdapter } = await import("../exchanges/aster.js");
const { OndoAdapter } = await import("../exchanges/ondo/adapter.js");
const { getVenue, requireCapabilities, listVenues } = await import("../exchanges/venue.js");
const { createPacifica } = await import("../exchanges/venues/create-helpers.js");
const { placeTpSlLeg } = await import("../exchanges/legacy-trading-v2.js");
const { jobArgv } = await import("../jobs.js");
const { buildProgram } = await import("../cli-program.js");
const { getDebridgeQuote } = await import("../bridge-engine.js");

type Gate = InstanceType<typeof bf.BuilderFeeGate>;

const HL_BUILDER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const ASTER_BUILDER = "0x1111111111111111111111111111111111111111";
const slippage = { bps: 50, source: "default" as const };

function writeSettings(obj: Record<string, unknown>): void {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(obj));
}

function gate(venue: "hyperliquid" | "pacifica" | "aster" | "ondo", entry: Record<string, unknown>, approval: (() => Promise<import("../exchanges/builder-fee.js").BuilderApproval>) | null, opts: { noBuilder?: boolean; network?: "mainnet" | "testnet" } = {}): Gate {
  const g = bf.resolveBuilderGate(venue, { network: opts.network ?? "mainnet", noBuilder: opts.noBuilder === true, readOnly: false },
    { [venue]: entry } as never, approval === null ? null : async () => approval(), () => "0xacct");
  if (g === null) throw new Error("expected a gate");
  return g;
}
const approved = async () => ({ status: "approved" as const, maxFeeBps: 10 });

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  bf.resetBuilderApprovalCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Capability declarations ──

describe("venue capability", () => {
  it("every venue declares builderFee; lighter / lighter-rh / arcus are unsupported", () => {
    const byId = Object.fromEntries(listVenues().map(v => [v.id, v.builderFee]));
    expect(byId.lighter).toBeNull();
    expect(byId["lighter-rh"]).toBeNull();
    expect(byId.arcus).toBeNull();
    expect(byId.hyperliquid).toMatchObject({ approval: "master", perpCapBps: 10, spotCapBps: 100, hip3: false });
    expect(byId.pacifica).toMatchObject({ approval: "master", spotCapBps: null, feeKind: "max" });
    expect(byId.aster).toMatchObject({ approval: "master", perpCapBps: 10, testnet: false });
    expect(byId.ondo).toMatchObject({ approval: "none", perpCapBps: 10 });
    expect(byId.qfex).toMatchObject({ approval: "none", feeKind: "share", perpCapBps: null });
    for (const v of ["lighter", "lighter-rh", "arcus"] as const) {
      expect(() => bf.requireBuilderCapability(v)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }) }));
    }
  });
});

// ── Settings ──

describe("settings.builder — default off + strict validation", () => {
  it("ships empty: no builder for any venue, no deBridge affiliate", () => {
    const s = loadSettings();
    expect(s.builder).toEqual({});
    expect(s.bridge.debridgeAffiliate).toBeNull();
    for (const v of listVenues()) expect(bf.builderTargetOf(s.builder, v.id)).toBeNull();
    expect("pacifica" in s.referralCodes).toBe(false);
  });

  it("parses valid entries; targets are normalized (address lowercase)", () => {
    writeSettings({ builder: { hyperliquid: { address: HL_BUILDER, feeBps: 1 }, pacifica: { code: "ABC123", feeBps: 2.5 }, ondo: { code: "my_code-1", feeBps: 10 } } });
    const s = loadSettings();
    expect(bf.builderTargetOf(s.builder, "hyperliquid")).toEqual({ venue: "hyperliquid", identity: HL_BUILDER.toLowerCase(), feeBps: 1 });
    expect(bf.builderTargetOf(s.builder, "pacifica")).toEqual({ venue: "pacifica", identity: "ABC123", feeBps: 2.5 });
    expect(bf.builderTargetOf(s.builder, "aster")).toBeNull();
  });

  it.each([
    ["fee above the venue cap", { hyperliquid: { address: HL_BUILDER, feeBps: 10.1 } }, /exceeds the hyperliquid cap of 10 bps/],
    ["zero fee", { hyperliquid: { address: HL_BUILDER, feeBps: 0 } }, /> 0/],
    ["HL fee not in tenths of a bp", { hyperliquid: { address: HL_BUILDER, feeBps: 0.15 } }, /0.1 bps increment/],
    ["bad address", { aster: { address: "0x123", feeBps: 1 } }, /20-byte EVM address/],
    ["pacifica code not alphanumeric", { pacifica: { code: "bad code", feeBps: 1 } }, /builder.pacifica.code/],
    ["pacifica code > 16 chars", { pacifica: { code: "A".repeat(17), feeBps: 1 } }, /builder.pacifica.code/],
    ["unsupported venue (lighter)", { lighter: { accountIndex: 1, feeBps: 1 } }, /lighter does not support builder fees/],
    ["unsupported venue (arcus)", { arcus: { code: "x", feeBps: 1 } }, /arcus does not support builder fees/],
    ["unknown key", { ondo: { code: "x", feeBps: 1, extra: true } }, /unknown key "extra"/],
    ["unknown venue", { nope: { code: "x", feeBps: 1 } }, /unknown venue/],
  ])("rejects %s with INVALID_PARAMS", (_n, builder, msg) => {
    writeSettings({ builder });
    expect(() => loadSettings()).toThrow(msg);
    expect(() => loadSettings()).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });

  it("`perp settings set builder.<venue>` validates strictly and never writes an invalid entry", async () => {
    const run = async (args: string[]) => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((m) => { lines.push(String(m)); });
      const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
      await program.parseAsync(["node", "perp", "--json", ...args]);
      vi.restoreAllMocks();
      return JSON.parse(lines.join("\n"));
    };
    let r = await run(["settings", "set", "builder.hyperliquid", `${HL_BUILDER},11`]);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_PARAMS");
    expect(loadSettings().builder).toEqual({});

    r = await run(["settings", "set", "builder.lighter", "1,1"]);
    expect(r.error.code).toBe("CAPABILITY_UNSUPPORTED");

    // L5: no --yes in --json / non-interactive mode → refused, nothing written; the fee is shown
    r = await run(["settings", "set", "builder.hl", `${HL_BUILDER},1.5`]);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_PARAMS");
    expect(r.error.message).toMatch(/1\.5 bps on YOUR hyperliquid perp orders/);
    expect(r.error.remediation).toMatch(/--yes/);
    expect(loadSettings().builder).toEqual({});

    r = await run(["settings", "set", "builder.hl", `${HL_BUILDER},1.5`, "--yes"]);
    expect(r.ok).toBe(true);
    expect(loadSettings().builder.hyperliquid).toEqual({ address: HL_BUILDER, feeBps: 1.5 });

    // ondo has no approval step: the confirmation is the only gate before the fee is charged
    r = await run(["settings", "set", "builder.ondo", "mycode,2"]);
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/no venue approval step/);
    expect(loadSettings().builder.ondo).toBeUndefined();
    r = await run(["settings", "set", "builder.ondo", "mycode,2", "--yes"]);
    expect(r.ok).toBe(true);
    r = await run(["settings", "unset", "builder.ondo"]);

    r = await run(["settings", "unset", "builder.hyperliquid"]);
    expect(r.ok).toBe(true);
    expect(loadSettings().builder).toEqual({});
    process.exitCode = 0;
  });
});

// ── Migration (referralCodes.pacifica was a per-order builder code) ──

describe("legacy referralCodes.pacifica migration", () => {
  it("drops the key, never attaches it, and prints a one-time notice", () => {
    writeSettings({ referralCodes: { pacifica: "PERPCLI", hyperliquid: "HYPERCASH", lighter: "718585MY" } });
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { err.push(String(c)); return true; });
    const s = loadSettings();
    expect(s.builder.pacifica).toBeUndefined();
    expect(err.join("")).toMatch(/referralCodes\.pacifica \("PERPCLI"\).*no longer attached.*builder\.pacifica/s);
    const onDisk = JSON.parse(readFileSync(SETTINGS, "utf-8"));
    expect(onDisk.referralCodes).toEqual({ hyperliquid: "HYPERCASH", lighter: "718585MY" });
    err.length = 0;
    loadSettings();
    expect(err.join("")).toBe(""); // one-time
  });

  it("an empty legacy value is dropped silently", () => {
    writeSettings({ referralCodes: { pacifica: "" } });
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    loadSettings();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Env vars are no longer read ──

describe("env vars are not builder / affiliate sources", () => {
  it("PACIFICA_BUILDER_CODE is ignored: no gate, no builder_code on orders", async () => {
    vi.stubEnv("PACIFICA_BUILDER_CODE", "EVILCODE");
    const pk = JSON.stringify(Array.from(Keypair.generate().secretKey));
    const adapter = await createPacifica({
      network: "mainnet", credentials: { pk, owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent: null },
      noAgent: true, hlDex: null, readOnly: false, noBuilder: false,
    }) as InstanceType<typeof PacificaAdapter>;
    expect(adapter.builderFee).toBeNull();
    const createMarketOrder = vi.fn().mockResolvedValue({ success: true, data: {} });
    (adapter as unknown as { client: Record<string, unknown> }).client = { createMarketOrder, setRequestAgentWallet: () => {} };
    await adapter.marketOrder("BTC", "buy", "0.1", { reduceOnly: true, slippage });
    expect(createMarketOrder.mock.calls[0][3]).toBeNull();
    vi.unstubAllEnvs();
    vi.stubEnv("HOME", TEST_HOME);
  });

  it("DEBRIDGE_* env vars are ignored; settings bridge.debridgeAffiliate is the only source", async () => {
    vi.stubEnv("DEBRIDGE_REFERRAL_CODE", "999");
    vi.stubEnv("DEBRIDGE_AFFILIATE_FEE_PERCENT", "0.5");
    vi.stubEnv("DEBRIDGE_AFFILIATE_FEE_RECIPIENT", "0xdead");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ estimation: { srcChainTokenIn: { amount: "1000000" }, dstChainTokenOut: { amount: "990000" } }, fixFee: "1000000000000000" }) };
    }));
    await getDebridgeQuote("arbitrum", "base", 1, "0xa", "0xb");
    expect(urls[0]).not.toMatch(/referralCode|affiliateFee/);

    writeSettings({ bridge: { debridgeAffiliate: { referralCode: "123", feePercent: 0.1, feeRecipient: "0xfee" } } });
    await getDebridgeQuote("arbitrum", "base", 1, "0xa", "0xb");
    const q = new URL(urls[1]).searchParams;
    expect(q.get("referralCode")).toBe("123");
    expect(q.get("affiliateFeePercent")).toBe("0.1");
    expect(q.get("affiliateFeeRecipient")).toBe("0xfee");
    vi.unstubAllEnvs();
    vi.stubEnv("HOME", TEST_HOME);
  });

  it("bridge.debridgeAffiliate needs feePercent and feeRecipient together", () => {
    writeSettings({ bridge: { debridgeAffiliate: { referralCode: null, feePercent: 0.1, feeRecipient: null } } });
    expect(() => loadSettings()).toThrow(/set together/);
  });
});

// ── Gate decisions ──

describe("BuilderFeeGate", () => {
  it("not configured / read-only → no gate at all (no notes)", () => {
    expect(bf.resolveBuilderGate("hyperliquid", { network: "mainnet", noBuilder: false, readOnly: false }, {}, approved, () => "")).toBeNull();
    expect(bf.resolveBuilderGate("hyperliquid", { network: "mainnet", noBuilder: false, readOnly: true }, { hyperliquid: { address: HL_BUILDER, feeBps: 1 } }, approved, () => "")).toBeNull();
  });

  it("approved → applied (exact fee, lowercase identity)", async () => {
    const d = await gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, approved).decide({ hip3: false });
    expect(d).toEqual({ applied: { venue: "hyperliquid", identity: HL_BUILDER.toLowerCase(), feeBps: 1, feeKind: "exact", approvedMaxBps: 10 }, note: null });
  });

  it("approval missing → not attached + note pointing at `wallet builder approve`", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const d = await gate("hyperliquid", { address: HL_BUILDER, feeBps: 2 }, async () => bf.approvalFromMax(1, 2)).decide({ hip3: false });
    expect(d.applied).toBeNull();
    expect(d.note).toMatch(/approval .* missing \(approved max: 1 bps, configured: 2 bps\).*perp wallet builder approve hyperliquid/);
  });

  it("approval unknown (read failed) → not attached + note; read once per process (cached)", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const read = vi.fn(async () => { throw new Error("HTTP 502"); });
    const g = gate("pacifica", { code: "ABC", feeBps: 1 }, read);
    const d1 = await g.decide({ hip3: false });
    const d2 = await g.decide({ hip3: false });
    expect(d1.applied).toBeNull();
    expect(d1.note).toMatch(/could not be confirmed \(HTTP 502\)/);
    expect(d2).toEqual(d1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1); // warned once
  });

  it("--no-builder → never attached (no approval read)", async () => {
    const read = vi.fn(approved);
    const d = await gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, read, { noBuilder: true }).decide({ hip3: false });
    expect(d).toEqual({ applied: null, note: "builder fee not attached: disabled by --no-builder" });
    expect(read).not.toHaveBeenCalled();
  });

  it("HIP-3 → never attached", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const d = await gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, approved).decide({ hip3: true });
    expect(d.applied).toBeNull();
    expect(d.note).toMatch(/HIP-3/);
  });

  it("aster testnet → never attached (no testnet builder flow)", async () => {
    const d = await gate("aster", { address: ASTER_BUILDER, feeBps: 1 }, approved, { network: "testnet" }).decide({ hip3: false });
    expect(d.applied).toBeNull();
    expect(d.note).toMatch(/testnet has no builder-fee flow/);
  });

  it("ondo (no approval step) → attached from settings alone", async () => {
    const d = await gate("ondo", { code: "c1", feeBps: 2.5 }, null).decide({ hip3: false });
    expect(d.applied).toEqual({ venue: "ondo", identity: "c1", feeBps: 2.5, feeKind: "exact", approvedMaxBps: null });
  });

  it("unit conversions", () => {
    expect(bf.bpsToRate(1)).toBe("0.0001");
    expect(bf.bpsToRate(2.5)).toBe("0.00025");
    expect(bf.hlFeeTenthsBps(1)).toBe(10);
    expect(bf.hlMaxFeeRatePercent(1)).toBe("0.01%");
    expect(bf.hlMaxFeeRatePercent(10)).toBe("0.1%");
    expect(bf.rateToBps("0.0001")).toBe(1);
  });
});

// ── Per-venue order payloads ──

function hl(assetIndex = 0) {
  const a = new HyperliquidAdapter(undefined, false);
  const sent: Array<Record<string, unknown>> = [];
  const h = a as unknown as Record<string, unknown>;
  h.ensureSigner = () => {};
  h.getAssetIndex = async () => assetIndex;
  h.getSzDecimals = () => 5;
  h.computeProtectionPrice = async () => ({ referencePrice: "100000", protectionPrice: "100500", appliedBps: 50 });
  h._signAndSendAction = vi.fn(async (action: Record<string, unknown>) => {
    sent.push(action);
    return { status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } };
  });
  h._validateOrderFill = () => {};
  h._validateVenueAck = () => {};
  h._invalidateAccountCache = async () => {};
  return { a, sent };
}

describe("L1: approval cache TTL + builder-related rejection", () => {
  it("an approval read is reused for BUILDER_APPROVAL_TTL_MS, then read again", async () => {
    const read = vi.fn(approved);
    const g = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, read);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await g.decide({ hip3: false });
    await g.decide({ hip3: false });
    expect(read).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + bf.BUILDER_APPROVAL_TTL_MS - 1);
    await g.decide({ hip3: false });
    expect(read).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + bf.BUILDER_APPROVAL_TTL_MS);
    await g.decide({ hip3: false });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a builder-related order rejection invalidates the cache and returns remediation — the order is NOT retried", async () => {
    const { a } = hl();
    const read = vi.fn(approved);
    a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, read);
    const h = a as unknown as Record<string, unknown>;
    const send = vi.fn(async () => { throw new Error("Builder fee has not been approved."); });
    h._signAndSendAction = send;
    await a.builderDecision(0);
    expect(read).toHaveBeenCalledTimes(1);
    const leg = { symbol: "BTC", closeSide: "sell" as const, size: "0.1", trigger: "90000", kind: "sl" as const, limitPrice: null, slippage };
    const err = await placeTpSlLeg(a, "mainnet", leg).catch(e => e);
    expect(send).toHaveBeenCalledTimes(1); // no automatic retry
    expect(err.structured.message).toMatch(/Builder fee has not been approved/);
    expect(err.structured.remediation).toMatch(/NOT retried/);
    expect(err.structured.remediation).toMatch(/--no-builder/);
    expect(err.structured.remediation).toMatch(/wallet builder approve hyperliquid/);
    await a.builderDecision(0);
    expect(read).toHaveBeenCalledTimes(2); // cache dropped → re-read
  });

  it("an unrelated rejection is passed through unchanged and keeps the cache", async () => {
    const read = vi.fn(approved);
    const { a } = hl();
    a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, read);
    await a.builderDecision(0);
    const e = new Error("Insufficient margin");
    expect(bf.builderRejectionOf(a, e)).toBe(e);
    await a.builderDecision(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("an unknown outcome that mentions the builder keeps its own code and 'do NOT resubmit' remediation", async () => {
    const { PerpError: PE, orderOutcomeUnknown } = await import("../errors.js");
    const read = vi.fn(approved);
    const { a } = hl();
    a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, read);
    await a.builderDecision(0);
    const pending = orderOutcomeUnknown("hyperliquid", "order with builder fee", new Error("socket hang up"));
    expect(bf.builderRejectionOf(a, pending)).toBe(pending);
    const partial = new PE("ORDER_PARTIAL", "builder leg accepted, other leg failed", { remediation: "keep me" });
    expect(bf.builderRejectionOf(a, partial)).toBe(partial);
    const transport = new Error("fetch failed while sending builder order");
    expect(bf.builderRejectionOf(a, transport)).toBe(transport);
    const retryable = new PE("EXCHANGE_ERROR", "builder fee read timed out");
    expect(bf.builderRejectionOf(a, retryable)).toBe(retryable);
    // A definite rejection is still re-described.
    const definite = new PE("ORDER_REJECTED", "Builder fee has not been approved.");
    expect((bf.builderRejectionOf(a, definite) as InstanceType<typeof PE>).structured.remediation).toMatch(/NOT retried/);
  });
});

describe("Hyperliquid order action", () => {
  it("default off: market / limit / trigger actions carry no builder", async () => {
    const { a, sent } = hl();
    await a.marketOrder("BTC", "buy", "0.1", { reduceOnly: false, slippage });
    await a.limitOrder("BTC", "buy", "100000", "0.1", { tif: "GTC" });
    await a.triggerOrder("BTC", "sell", "0.1", "90000", "sl", { isMarket: true });
    expect(sent).toHaveLength(3);
    for (const s of sent) expect("builder" in s).toBe(false);
  });

  it("configured + approved: builder { b: lowercase address, f: tenths of a bp } on every order action, key order type/orders/grouping/builder", async () => {
    const { a, sent } = hl();
    a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 2.5 }, approved);
    await a.marketOrder("BTC", "buy", "0.1", { reduceOnly: false, slippage });
    await a.limitOrder("BTC", "buy", "100000", "0.1", { tif: "GTC" });
    await a.triggerOrder("BTC", "sell", "0.1", "90000", "sl", { isMarket: true });
    for (const s of sent) {
      expect(s.builder).toEqual({ b: HL_BUILDER.toLowerCase(), f: 25 });
      expect(Object.keys(s)).toEqual(["type", "orders", "grouping", "builder"]);
    }
  });

  it("HIP-3 asset (id ≥ 100000) or a dex adapter: no builder", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { a, sent } = hl(110_000);
    a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, approved);
    await a.marketOrder("xyz:TSLA", "buy", "1", { reduceOnly: false, slippage });
    expect("builder" in sent[0]).toBe(false);
    const dex = hl(0);
    dex.a.setDex("xyz");
    dex.a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, approved);
    await dex.a.marketOrder("TSLA", "buy", "1", { reduceOnly: false, slippage });
    expect("builder" in dex.sent[0]).toBe(false);
  });

  it("approval unknown → order still sent, without builder", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { a, sent } = hl();
    a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, async () => ({ status: "unknown" as const, reason: "timeout" }));
    await a.marketOrder("BTC", "buy", "0.1", { reduceOnly: false, slippage });
    expect(sent).toHaveLength(1);
    expect("builder" in sent[0]).toBe(false);
  });

  it("TradingV2 TP/SL leg records execution.builderFee (and none by default)", async () => {
    const { a } = hl();
    const leg = { symbol: "BTC", closeSide: "sell" as const, size: "0.1", trigger: "90000", kind: "sl" as const, limitPrice: null, slippage };
    const off = await placeTpSlLeg(a, "mainnet", leg);
    expect(off.execution.builderFee).toBeNull();
    a.builderFee = gate("hyperliquid", { address: HL_BUILDER, feeBps: 1 }, approved);
    const on = await placeTpSlLeg(a, "mainnet", leg);
    expect(on.execution.builderFee).toEqual({ venue: "hyperliquid", identity: HL_BUILDER.toLowerCase(), feeBps: 1, feeKind: "exact", approvedMaxBps: 10 });
  });

  it("builderApprovalOf reads info maxBuilderFee (tenths of a bp) for the account", async () => {
    const a = new HyperliquidAdapter(undefined, false);
    a.setAddress("0x00000000000000000000000000000000000000aa");
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => 10 }; }));
    const t = { venue: "hyperliquid" as const, identity: HL_BUILDER.toLowerCase(), feeBps: 1 };
    expect(await a.builderApprovalOf(t)).toEqual({ status: "approved", maxFeeBps: 1 });
    expect(bodies[0]).toEqual({ type: "maxBuilderFee", user: "0x00000000000000000000000000000000000000aa", builder: HL_BUILDER.toLowerCase() });
    expect(await a.builderApprovalOf({ ...t, feeBps: 2 })).toEqual({ status: "notApproved", maxFeeBps: 1 });
  });
});

function pac() {
  const a = new PacificaAdapter(Keypair.generate(), "mainnet");
  const ok = vi.fn().mockResolvedValue({ success: true, data: {} });
  const client = { createMarketOrder: ok, createLimitOrder: vi.fn().mockResolvedValue({ success: true, data: {} }), createStopOrder: vi.fn().mockResolvedValue({ success: true }), setTPSL: vi.fn().mockResolvedValue({ success: true }), setRequestAgentWallet: () => {}, getInfo: vi.fn() };
  (a as unknown as { client: unknown }).client = client;
  return { a, client };
}

describe("Pacifica builder_code", () => {
  it("default off: market / limit / stop / position TP/SL send no builder code", async () => {
    const { a, client } = pac();
    await a.marketOrder("BTC", "buy", "0.1", { reduceOnly: true, slippage });
    await a.limitOrder("BTC", "buy", "100", "0.1", { tif: "GTC" });
    await a.stopOrder("BTC", "sell", "0.1", "90");
    await a.setPositionTpSl("BTC", "long", { tp: "110", tpLimit: null, sl: null });
    for (const f of [client.createMarketOrder, client.createLimitOrder, client.createStopOrder, client.setTPSL]) {
      expect(f.mock.calls[0][3]).toBeNull();
    }
  });

  it("configured + approved: the configured code on every perp order endpoint", async () => {
    const { a, client } = pac();
    a.builderFee = gate("pacifica", { code: "ABC123", feeBps: 1 }, approved);
    await a.marketOrder("BTC", "buy", "0.1", { reduceOnly: true, slippage });
    await a.limitOrder("BTC", "buy", "100", "0.1", { tif: "GTC" });
    await a.stopOrder("BTC", "sell", "0.1", "90");
    await a.setPositionTpSl("BTC", "long", { tp: "110", tpLimit: null, sl: null });
    for (const f of [client.createMarketOrder, client.createLimitOrder, client.createStopOrder, client.setTPSL]) {
      expect(f.mock.calls[0][3]).toBe("ABC123");
    }
  });

  it("spot orders never carry it, even when the perp side is configured + approved", async () => {
    const { a, client } = pac();
    a.builderFee = gate("pacifica", { code: "ABC123", feeBps: 1 }, approved);
    const spot = new PacificaSpotAdapter(a) as unknown as Record<string, unknown>;
    spot.init = async () => {};
    spot._resolve = () => ({ symbol: "SOL-USDC", lot_size: "0.01", tick_size: "0.01", base_asset: "SOL" });
    spot._checkNotional = () => {};
    spot._mark = async () => "100";
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await (spot as unknown as InstanceType<typeof PacificaSpotAdapter>).spotMarketOrder("SOL", "sell", "1", { slippage });
    await (spot as unknown as InstanceType<typeof PacificaSpotAdapter>).spotLimitOrder("SOL", "sell", "100", "1", { tif: "GTC" });
    expect(client.createMarketOrder.mock.calls[0][3]).toBeNull();
    expect(client.createLimitOrder.mock.calls[0][3]).toBeNull();
  });

  it("builderApprovalOf (feeKind max): approved only while the approved max_fee_rate ≤ the configured fee (the user's consent)", async () => {
    const { a, client } = pac();
    (client as Record<string, unknown>).getBuilderApprovals = vi.fn().mockResolvedValue([{ builder_code: "ABC123", max_fee_rate: "0.0002" }]);
    expect(await a.builderApprovalOf({ venue: "pacifica", identity: "ABC123", feeBps: 2 })).toEqual({ status: "approved", maxFeeBps: 2 });
    expect(await a.builderApprovalOf({ venue: "pacifica", identity: "ABC123", feeBps: 3 })).toEqual({ status: "approved", maxFeeBps: 2 });
    expect(await a.builderApprovalOf({ venue: "pacifica", identity: "ABC123", feeBps: 1 })).toEqual({ status: "aboveConsent", maxFeeBps: 2 });
    expect(await a.builderApprovalOf({ venue: "pacifica", identity: "OTHER", feeBps: 1 })).toEqual({ status: "notApproved", maxFeeBps: null });
  });

  it("M2: an approved max above the configured fee is NOT attached; the note and status report the real approved max", async () => {
    const { a, client } = pac();
    (client as Record<string, unknown>).getBuilderApprovals = vi.fn().mockResolvedValue([{ builder_code: "ABC123", max_fee_rate: "0.0008" }]);
    a.builderFee = gate("pacifica", { code: "ABC123", feeBps: 1 }, () => a.builderApprovalOf({ venue: "pacifica", identity: "ABC123", feeBps: 1 }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const d = await a.builderDecision();
    expect(d.applied).toBeNull();
    expect(d.note).toMatch(/approved max for ABC123 is 8 bps, above the configured 1 bps/);
    await a.marketOrder("BTC", "buy", "0.1", { reduceOnly: false, slippage });
    expect(client.createMarketOrder.mock.calls[0][3]).toBeNull();

    // within consent: attached, with the real approved max recorded
    (client as Record<string, unknown>).getBuilderApprovals = vi.fn().mockResolvedValue([{ builder_code: "ABC123", max_fee_rate: "0.00005" }]);
    bf.resetBuilderApprovalCache();
    expect((await a.builderDecision()).applied).toEqual({ venue: "pacifica", identity: "ABC123", feeBps: 1, feeKind: "max", approvedMaxBps: 0.5 });
  });
});

function aster() {
  const a = new AsterAdapter(undefined, false);
  const posted: Array<Record<string, unknown>> = [];
  const h = a as unknown as Record<string, unknown>;
  h._resolveSigner = () => ({ tier: "pk", signer: {}, signerAddress: "0xs", userAddress: "0xu" });
  h.computeProtectionPrice = async () => ({ referencePrice: "100", protectionPrice: "100.5", appliedBps: 50 });
  h._symbolPriceFilters = async () => ({ tickSize: "0.1" });
  h._signedPostEip712 = vi.fn(async (_p: string, params: Record<string, unknown>) => { posted.push(params); return { status: "FILLED", executedQty: "1", orderId: 1 }; });
  return { a, posted };
}

describe("Aster builder + feeRate", () => {
  it("default off: no builder / feeRate params", async () => {
    const { a, posted } = aster();
    await a.marketOrder("BTC", "buy", "1", { reduceOnly: false, slippage });
    await a.limitOrder("BTC", "buy", "100.1", "1", { tif: "GTC" });
    await a.stopOrder("BTC", "sell", "1", "90.1", { reduceOnly: true, kind: "sl" });
    for (const p of posted) {
      expect("builder" in p).toBe(false);
      expect("feeRate" in p).toBe(false);
    }
  });

  it("configured + approved: builder + feeRate (decimal) on market / limit / stop", async () => {
    const { a, posted } = aster();
    a.builderFee = gate("aster", { address: ASTER_BUILDER, feeBps: 2.5 }, approved);
    await a.marketOrder("BTC", "buy", "1", { reduceOnly: false, slippage });
    await a.limitOrder("BTC", "buy", "100.1", "1", { tif: "GTC" });
    await a.stopOrder("BTC", "sell", "1", "90.1", { reduceOnly: true, kind: "sl" });
    for (const p of posted) expect(p).toMatchObject({ builder: ASTER_BUILDER, feeRate: "0.00025" });
  });

  it("builderApprovalOf: list rows → verdict; an unrecognized response → unknown (never guessed)", async () => {
    const { a } = aster();
    const t = { venue: "aster" as const, identity: ASTER_BUILDER, feeBps: 1 };
    (a as unknown as Record<string, unknown>).signedRequest = vi.fn().mockResolvedValue([{ builder: ASTER_BUILDER.toUpperCase().replace("0X", "0x"), maxFeeRate: "0.0001" }]);
    expect(await a.builderApprovalOf(t)).toEqual({ status: "approved", maxFeeBps: 1 });
    (a as unknown as Record<string, unknown>).signedRequest = vi.fn().mockResolvedValue([]);
    expect(await a.builderApprovalOf(t)).toEqual({ status: "notApproved", maxFeeBps: null });
    (a as unknown as Record<string, unknown>).signedRequest = vi.fn().mockResolvedValue({ weird: 1 });
    expect((await a.builderApprovalOf(t)).status).toBe("unknown");
  });
});

const PAIR = { market: "TSLA-USD.P", baseIncrement: "0.01", quoteIncrement: "0.05" };

/** Writable view of the OndoAdapter members this fixture sets on a prototype-only instance. */
type OndoA = InstanceType<typeof OndoAdapter>;
type OndoInternals = {
  venue: OndoA["venue"];
  caps: OndoA["caps"];
  network: OndoA["network"];
  client: OndoA["client"];
  pairOf: OndoA["pairOf"];
  markPriceOf: OndoA["markPriceOf"];
};

function ondo() {
  const posts: Array<[string, Record<string, unknown>]> = [];
  const client = {
    post: vi.fn(async (path: string, body: Record<string, unknown>) => {
      posts.push([path, body]);
      return path.endsWith("stop_order") ? { market: PAIR.market, positionDirection: "long", stopLoss: "90" }
        : { orderId: "o1", market: PAIR.market, side: "buy", type: "limit", status: "open", price: "100", size: "1", filledSize: "0", filledCost: "0", reduceOnly: false, timeInForce: "GTC" };
    }),
    // The stop is listed only once POST /v1/perps/stop_order was sent (the pre-POST read excludes older ids).
    getPage: vi.fn(async () => ({ result: !posts.some(([p]) => p.endsWith("stop_order")) ? [] : [{ orderId: "s1", market: PAIR.market, side: "sell", type: "stopMarket", status: "untriggered", size: "1", filledSize: "0", filledCost: "0", reduceOnly: true, closePosition: true, stopOrderType: "stopLoss", triggerPrice: "90" }] })),
  };
  const def = getVenue("ondo");
  const a = Object.create(OndoAdapter.prototype) as InstanceType<typeof OndoAdapter>;
  const ai = a as unknown as OndoInternals;
  ai.venue = def;
  ai.caps = requireCapabilities(def);
  ai.network = "mainnet";
  ai.client = client as unknown as OndoInternals["client"];
  ai.pairOf = vi.fn().mockResolvedValue(PAIR);
  ai.markPriceOf = vi.fn().mockResolvedValue("100");
  return { a, posts };
}

const ondoLimit = { symbol: "TSLA", side: "buy" as const, type: "limit" as const, size: "1", price: "100", triggerPrice: null, triggerSource: null, tif: "GTC" as const, reduceOnly: false, clientOrderId: null, slippage: null, tpsl: null };
const ondoStop = { ...ondoLimit, side: "sell" as const, type: "stopMarket" as const, price: null, triggerPrice: "90", tif: null, reduceOnly: true };

describe("Ondo builderCode", () => {
  it("default off: neither orders nor position stops carry builderCode; execution.builderFee null", async () => {
    const { a, posts } = ondo();
    const r1 = await a.placeOrder(ondoLimit);
    const r2 = await a.placeOrder(ondoStop);
    for (const [, body] of posts) expect("builderCode" in body).toBe(false);
    expect(r1.execution.builderFee).toBeNull();
    expect(r2.execution.builderFee).toBeNull();
  });

  it("configured: { code, feeRateBpsFractional } on orders AND explicitly on position stops; recorded in execution", async () => {
    const { a, posts } = ondo();
    a.builderFee = gate("ondo", { code: "mycode", feeBps: 2.5 }, null);
    const r1 = await a.placeOrder(ondoLimit);
    const r2 = await a.placeOrder(ondoStop);
    expect(posts.map(([p]) => p)).toEqual(["/v1/perps/orders", "/v1/perps/stop_order"]);
    for (const [, body] of posts) expect(body.builderCode).toEqual({ code: "mycode", feeRateBpsFractional: 2.5 });
    for (const r of [r1, r2]) expect(r.execution.builderFee).toEqual({ venue: "ondo", identity: "mycode", feeBps: 2.5, feeKind: "exact", approvedMaxBps: null });
  });

  it("--no-builder: not attached, the note says why", async () => {
    const { a, posts } = ondo();
    a.builderFee = gate("ondo", { code: "mycode", feeBps: 2.5 }, null, { noBuilder: true });
    const r = await a.placeOrder(ondoLimit);
    expect("builderCode" in posts[0][1]).toBe(false);
    expect(r.execution.builderFee).toBeNull();
    expect(r.execution.notes).toContain("builder fee not attached: disabled by --no-builder");
  });
});

// ── QFEX: fee SHARE (feeKind "share", feeBps null) ──

describe("QFEX builder code (fee share)", () => {
  const CODE = "11111111-1111-4111-8111-111111111111";

  it("capability: no cap / increment / approval; testnet off", () => {
    expect(getVenue("qfex").builderFee).toEqual({
      approval: "none", identity: "code", perpCapBps: null, spotCapBps: null, hip3: null, testnet: false,
      feeStepBps: null, feeKind: "share", docs: "https://docs.qfex.com/qfex/builder-code",
    });
  });

  it("settings entry is { code: <uuid> } only; the target carries feeBps null (never 0)", () => {
    writeSettings({ builder: { qfex: { code: CODE.toUpperCase() } } });
    const s = loadSettings();
    expect(s.builder.qfex).toEqual({ code: CODE.toUpperCase() });
    expect(bf.builderTargetOf(s.builder, "qfex")).toEqual({ venue: "qfex", identity: CODE, feeBps: null });
    expect(bf.feeText({ feeBps: null })).toBe("fee share (no extra fee)");
    expect(bf.feeText({ feeBps: 2.5 })).toBe("2.5 bps");
    expect(() => bf.requireFeeBps({ venue: "qfex", feeBps: null })).toThrow(/no fee/);
    expect(bf.requireFeeBps({ venue: "ondo", feeBps: 2 })).toBe(2);
  });

  it.each([
    ["a feeBps key", { qfex: { code: CODE, feeBps: 1 } }, /unknown key "feeBps"/],
    ["a non-UUID code", { qfex: { code: "my-code" } }, /must be a UUID/],
    ["a missing code", { qfex: {} }, /must be a UUID/],
    ["a non-object", { qfex: CODE }, /must be \{ code: <uuid> \}/],
  ])("rejects %s with INVALID_PARAMS", (_n, builder, msg) => {
    writeSettings({ builder });
    expect(() => loadSettings()).toThrow(msg);
    expect(() => loadSettings()).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });

  it("gate: attached from settings alone with feeKind share and feeBps null; --no-builder / testnet skip it", async () => {
    const mk = (opts: { noBuilder?: boolean; network?: "mainnet" | "testnet" }) => bf.resolveBuilderGate("qfex",
      { network: opts.network ?? "mainnet", noBuilder: opts.noBuilder === true, readOnly: false }, { qfex: { code: CODE } }, null, () => "");
    expect(await mk({})!.decide({ hip3: false })).toEqual({ applied: { venue: "qfex", identity: CODE, feeBps: null, feeKind: "share", approvedMaxBps: null }, note: null });
    expect((await mk({ noBuilder: true })!.decide({ hip3: false })).note).toBe("builder fee not attached: disabled by --no-builder");
    expect((await mk({ network: "testnet" })!.decide({ hip3: false })).note).toMatch(/qfex testnet has no builder-fee flow/);
  });

  it("`perp settings set builder.qfex <uuid>` needs confirmation and discloses attribution (you pay the normal fee)", async () => {
    const run = async (args: string[]) => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((m) => { lines.push(String(m)); });
      const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
      await program.parseAsync(["node", "perp", "--json", ...args]);
      vi.restoreAllMocks();
      return JSON.parse(lines.join("\n"));
    };
    let r = await run(["settings", "set", "builder.qfex", CODE]);
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(new RegExp(`your qfex fills are attributed to ${CODE}; you pay the normal fee`));
    expect(r.error.remediation).toMatch(/builder\.qfex <uuid> --yes/);
    expect(loadSettings().builder.qfex).toBeUndefined();

    r = await run(["settings", "set", "builder.qfex", `${CODE},1`]);
    expect(r.error.code).toBe("INVALID_PARAMS"); // "<uuid>,<feeBps>" is not a UUID: a fee cannot be configured

    r = await run(["settings", "set", "builder.qfex", CODE, "--yes"]);
    expect(r.ok).toBe(true);
    expect(loadSettings().builder.qfex).toEqual({ code: CODE });
    r = await run(["settings", "unset", "builder.qfex"]);
    expect(loadSettings().builder).toEqual({});
    process.exitCode = 0;
  });
});

// ── CLI / jobs plumbing ──

describe("--no-builder flag", () => {
  it("is a root flag and is inherited by background jobs", () => {
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    expect(program.options.some(o => o.long === "--no-builder")).toBe(true);
    const argv = jobArgv({ strategy: "x", exchange: "hl", params: {}, network: "mainnet", dryRun: false, selectors: { ows: null, wallet: null, noAgent: false, dex: null, noBuilder: true }, cliArgs: ["arb", "auto"] }, "id1");
    expect(argv).toContain("--no-builder");
    const off = jobArgv({ strategy: "x", exchange: "hl", params: {}, network: "mainnet", dryRun: false, selectors: { ows: null, wallet: null, noAgent: false, dex: null, noBuilder: false }, cliArgs: ["arb", "auto"] }, "id2");
    expect(off).not.toContain("--no-builder");
  });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});
