/**
 * Fixes for the E2E dry-run findings. Network is mocked.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { registerFundsCommands, chainLabel, lighterFamilyWithdrawSummary } from "../commands/funds.js";
import { listVenues, getVenue } from "../exchanges/venue.js";
import { ensureVenuesRegistered } from "../exchanges/venues/index.js";
import { asterVenue } from "../exchanges/venues/aster.js";
import { QFEX_WITHDRAW_NETWORK } from "../exchanges/venues/qfex.js";
import { legacyPublicBaseUrl } from "../api/public/urls.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import { ArcusAdapter } from "../exchanges/arcus/adapter.js";
import { OndoAdapter } from "../exchanges/ondo/adapter.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PerpError } from "../errors.js";

ensureVenuesRegistered();

const rhDeposit = vi.hoisted(() => ({
  plan: vi.fn(async (p: { depositor: string; amount: string; routeType: 0 | 1 }) => ({
    network: "mainnet", rpcUrl: "https://rpc.example", chainId: 4663, contract: "0xC0", asset: "USDG", assetIndex: 3,
    token: "0x70", decimals: 6, amount: p.amount, amountRaw: 5_000_000n, routeType: p.routeType, depositor: p.depositor,
    tokenBalance: 10_000_000n, allowance: 0n, needsApprove: true,
  })),
  execute: vi.fn(async () => ({ approveTxHash: "0xa", depositTxHash: "0xd" })),
}));
vi.mock("../exchanges/lighter-rh-deposit.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/lighter-rh-deposit.js")>()),
  planLighterRhDeposit: rhDeposit.plan,
  executeLighterRhDeposit: rhDeposit.execute,
}));

afterEach(() => {
  vi.restoreAllMocks();
  rhDeposit.plan.mockClear();
  rhDeposit.execute.mockClear();
  vi.unstubAllGlobals();
});

// ── #1 Aster testnet host ─────────────────────────────────────────────────

describe("#1 Aster testnet host comes from the venue definition", () => {
  it("venue definition carries the documented REST + WS hosts", () => {
    expect(asterVenue.networks.mainnet.restUrl).toBe("https://fapi.asterdex.com");
    expect(asterVenue.networks.mainnet.wsUrl).toBe("wss://fstream.asterdex.com");
    expect(asterVenue.networks.testnet?.restUrl).toBe("https://fapi.asterdex-testnet.com");
    expect(asterVenue.networks.testnet?.wsUrl).toBe("wss://fstream.asterdex-testnet.com");
  });

  it("public data path serves testnet from networks.testnet (no NOT_IMPLEMENTED)", () => {
    expect(legacyPublicBaseUrl("aster", "testnet")).toBe(asterVenue.networks.testnet?.restUrl);
    expect(legacyPublicBaseUrl("aster", "mainnet")).toBe(asterVenue.networks.mainnet.restUrl);
  });

  it("publicData.fetchMarkets('testnet') requests the testnet host", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      throw new Error("network blocked in test");
    }));
    await expect(asterVenue.publicData.fetchMarkets("testnet")).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith("https://fapi.asterdex-testnet.com/")).toBe(true);
  });

  it("AsterAdapter(testnet) talks to fapi.asterdex-testnet.com, ignoring ASTER_TESTNET_URL", async () => {
    vi.stubEnv("ASTER_TESTNET_URL", "https://should-not-be-used.example");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
    }));
    const { AsterAdapter } = await import("../exchanges/aster.js");
    await new AsterAdapter(undefined, true).init();
    expect(urls[0]).toMatch(/^https:\/\/fapi\.asterdex-testnet\.com\/fapi\/v3\/time/);
    vi.unstubAllEnvs();
  });
});

// ── #2 Lighter market list must not be an empty success ───────────────────

type Detail = Record<string, unknown>;
function lighterWithDetails(details: Detail[] | undefined): LighterAdapter {
  const lt = LighterAdapter.forVenue("lighter-rh", "", false);
  const internals = lt as unknown as Record<string, unknown>;
  internals.ensureMarketMap = async () => {};
  internals.restGet = async (path: string) => {
    if (path !== "/orderBookDetails") throw new Error(`unexpected ${path}`);
    return details === undefined ? {} : { order_book_details: details };
  };
  // /funding-rates carries no mark price (live) — only the rate.
  internals.getFundingRates = async () => new Map([["TSLA", { rate: "0.00003", markPrice: null }]]);
  return lt;
}

describe("#2 LighterAdapter.getMarkets reads the mark from orderBookDetails", () => {
  it("lists markets keyless with orderBookDetails mark/index price", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lt = lighterWithDetails([
      { symbol: "TSLA", market_id: 10, market_type: "perp", status: "active", mark_price: "355.77", index_price: "355.44", min_initial_margin_fraction: 500 },
      { symbol: "ETH", market_id: 0, market_type: "perp", status: "active", mark_price: "2697.15", index_price: "2698.54", min_initial_margin_fraction: 500 },
      { symbol: "USDG/X", market_id: 99, market_type: "spot", mark_price: "1" },
    ]);
    const markets = await lt.getMarkets();
    expect(markets.map(m => m.symbol)).toEqual(["TSLA", "ETH"]);
    expect(markets[0].markPrice).toBe("355.77");
    expect(markets[0].indexPrice).toBe("355.44");
    expect(markets[0].fundingRate).toBe("0.00003");
  });

  it("perps listed but none with a mark → EXCHANGE_ERROR, not an empty success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lt = lighterWithDetails([{ symbol: "TSLA", market_id: 10, market_type: "perp", status: "active", min_initial_margin_fraction: 500 }]);
    await expect(lt.getMarkets()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("missing order_book_details array → EXCHANGE_ERROR", async () => {
    const lt = lighterWithDetails(undefined);
    await expect(lt.getMarkets()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

// ── #3 market commands use the public (read-only) adapter ─────────────────

describe("#3 market commands are wired to read-only adapters", () => {
  it("index.ts registers market commands with the public getters (credentials never resolved)", () => {
    const src = readFileSync(resolve(__dirname, "../cli-program.ts"), "utf8");
    // 5th argument: the credentialed getter, used only for klines a venue serves to an authenticated account (Ondo candles).
    expect(src).toContain("registerMarketCommands(program, getPublicAdapter, isJson, getPublicAdapterForExchange, getAdapter)");
    expect(src).toMatch(/const readOnly = publicOnly \|\| !\(await hasCredentials\(def\.id, cli\)\)/);
  });
});

// ── #4 / #5 funds withdraw / deposit surface ──────────────────────────────

function fundsProgram(getAdapterForExchange: (ex: string) => Promise<ExchangeAdapter>, network: "mainnet" | "testnet" = "mainnet"): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.option("--dry-run");
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerFundsCommands(
    prog,
    async () => { throw new Error("getAdapter not expected"); },
    () => true,
    () => network,
    getAdapterForExchange,
  );
  return prog;
}

function captureJson(): { out: () => Record<string, unknown> } {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  return { out: () => JSON.parse(lines.join("\n")) as Record<string, unknown> };
}

const DEST = "0x000000000000000000000000000000000000dEaD";
const OWNER = "0x1111111111111111111111111111111111111111";

function fakeArcus(withdraw = vi.fn(async () => ({ ok: true }))): { adapter: ExchangeAdapter; withdraw: typeof withdraw } {
  const a = Object.create(ArcusAdapter.prototype) as Record<string, unknown>;
  Object.defineProperty(a, "withdrawDestination", { get: () => OWNER });
  a.withdraw = withdraw;
  return { adapter: a as unknown as ExchangeAdapter, withdraw };
}

describe("#4 funds withdraw ondo (refused) / arcus / aster", () => {
  it.each([
    [["--dry-run", "funds", "withdraw", "ondo", "5", "--to", DEST]],
    [["funds", "withdraw", "ondo", "5", "--to", DEST]],
    [["funds", "withdraw", "ondo"]],
  ])("ondo %j → CAPABILITY_UNSUPPORTED (API cannot withdraw), adapter never created", async (argv) => {
    const get = vi.fn(async () => { throw new Error("must not create an adapter"); });
    await expect(fundsProgram(get).parseAsync(argv, { from: "user" }))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { venue: "Ondo Perps", feature: "withdraw" }, remediation: expect.stringContaining("web app") } });
    expect(get).not.toHaveBeenCalled();
    expect(getVenue("ondo").capabilities?.withdrawAssets).toBeNull();
  });

  it("OndoAdapter.withdraw refuses before any request (rebalance / MCP paths)", async () => {
    const a = Object.create(OndoAdapter.prototype) as OndoAdapter;
    await expect(a.withdraw("5", DEST)).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
  });

  it("arcus --dry-run targets the account owner and sends nothing", async () => {
    const { adapter, withdraw } = fakeArcus();
    const cap = captureJson();
    await fundsProgram(async ex => { expect(ex).toBe("arcus"); return adapter; })
      .parseAsync(["--dry-run", "funds", "withdraw", "arcus", "2"], { from: "user" });
    expect(withdraw).not.toHaveBeenCalled();
    expect(cap.out()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue: "arcus", asset: "USDG", destination: OWNER, chain: "Robinhood Chain" } });
  });

  it("arcus sends to the owner; a different --to is refused", async () => {
    const { adapter, withdraw } = fakeArcus();
    captureJson();
    await fundsProgram(async () => adapter).parseAsync(["funds", "withdraw", "arcus", "2"], { from: "user" });
    expect(withdraw).toHaveBeenCalledWith("2", OWNER);
    await expect(fundsProgram(async () => adapter).parseAsync(["funds", "withdraw", "arcus", "2", "--to", DEST], { from: "user" }))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("aster on testnet → uniform CAPABILITY_UNSUPPORTED, adapter never created; mainnet declares USDT, USDC", async () => {
    const get = vi.fn(async () => { throw new Error("must not create an adapter"); });
    await expect(fundsProgram(get, "testnet").parseAsync(["funds", "withdraw", "aster", "5"], { from: "user" }))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { venue: "Aster", feature: "withdraw" } } });
    expect(get).not.toHaveBeenCalled();
    expect(asterVenue.capabilities?.withdrawAssets).toEqual(["USDT", "USDC"]);
  });

  it("aster --dry-run plans (BNB Chain default) without creating an adapter", async () => {
    const get = vi.fn(async () => { throw new Error("must not create an adapter"); });
    const cap = captureJson();
    await fundsProgram(get).parseAsync(["--dry-run", "funds", "withdraw", "aster", "5"], { from: "user" });
    expect(get).not.toHaveBeenCalled();
    expect(cap.out()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue: "aster", asset: "USDT", amount: "5", chain: "BNB Chain", chainId: 56 } });
  });

  it("aster --dry-run --asset USDC plans USDC; an unlisted asset is refused before any adapter", async () => {
    const get = vi.fn(async () => { throw new Error("must not create an adapter"); });
    const cap = captureJson();
    await fundsProgram(get).parseAsync(["--dry-run", "funds", "withdraw", "aster", "5", "--chain", "arbitrum", "--asset", "usdc"], { from: "user" });
    expect(cap.out()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue: "aster", asset: "USDC", chainId: 42161 } });
    await expect(fundsProgram(get).parseAsync(["--dry-run", "funds", "withdraw", "aster", "5", "--asset", "BTC"], { from: "user" }))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("negative / malformed amounts are refused", async () => {
    const { adapter } = fakeArcus();
    await expect(fundsProgram(async () => adapter).parseAsync(["funds", "withdraw", "arcus", "abc"], { from: "user" }))
      .rejects.toBeInstanceOf(PerpError);
  });
});

describe("#5 Lighter-family withdraw help + lighter-rh deposit wiring", () => {
  it("withdraw lighter help is derived from the venue definitions (USDG → Robinhood Chain for RH)", () => {
    const prog = fundsProgram(async () => { throw new Error("no"); });
    const wd = prog.commands.find(c => c.name() === "funds")!.commands.find(c => c.name() === "withdraw")!;
    const lt = wd.commands.find(c => c.name() === "lighter")!;
    expect(lt.description()).toContain(lighterFamilyWithdrawSummary());
    expect(lighterFamilyWithdrawSummary()).toBe("-e lighter: USDC → Ethereum; -e lighter-rh: USDG → Robinhood Chain");
    const ondo = wd.commands.find(c => c.name() === "ondo")!;
    expect(ondo.description()).toContain("Not available");
  });

  it("deposit lighter-rh is registered with the venue collateral in its help", () => {
    const prog = fundsProgram(async () => { throw new Error("no"); });
    const dep = prog.commands.find(c => c.name() === "funds")!.commands.find(c => c.name() === "deposit")!;
    const rh = dep.commands.find(c => c.name() === "lighter-rh")!;
    expect(rh.description()).toContain("USDG");
    expect(rh.description()).toContain("Robinhood Chain");
  });

  it("deposit lighter-rh on testnet → CAPABILITY_UNSUPPORTED before any adapter/credential", async () => {
    const get = vi.fn(async () => { throw new Error("must not create an adapter"); });
    await expect(fundsProgram(get, "testnet").parseAsync(["funds", "deposit", "lighter-rh", "5"], { from: "user" }))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { feature: "deposit" } } });
    expect(get).not.toHaveBeenCalled();
  });

  it("deposit lighter-rh --dry-run plans with the master address and sends nothing", async () => {
    const lt = LighterAdapter.forVenue("lighter-rh", "", false);
    (lt as unknown as { _address: string })._address = OWNER;
    const cap = captureJson();
    await fundsProgram(async ex => { expect(ex).toBe("lighter-rh"); return lt; })
      .parseAsync(["--dry-run", "funds", "deposit", "lighter-rh", "5"], { from: "user" });
    expect(rhDeposit.plan).toHaveBeenCalledWith({ network: "mainnet", amount: "5", depositor: OWNER, routeType: 0 });
    expect(rhDeposit.execute).not.toHaveBeenCalled();
    expect(cap.out()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue: "lighter-rh", asset: "USDG", depositor: OWNER, needsApprove: true } });
  });

  it("deposit lighter-rh (live path) signs through the adapter's L1 digest signer", async () => {
    const lt = LighterAdapter.forVenue("lighter-rh", "", false);
    (lt as unknown as { _address: string })._address = OWNER;
    captureJson();
    const prog = fundsProgram(async () => lt);
    prog.option("--ows <name>"); // master selected on this machine (the guard only checks it is configured)
    await prog.parseAsync(["--ows", "main", "funds", "deposit", "lighter-rh", "5", "--route", "1"], { from: "user" });
    expect(rhDeposit.execute).toHaveBeenCalledTimes(1);
    const signer = (rhDeposit.execute.mock.calls[0] as unknown as [unknown, (d: string) => Promise<string>])[1];
    await expect(signer(`0x${"11".repeat(32)}`)).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
  });

  it("deposit lighter-rh (live) without a master wallet on this computer → NO_SIGNER_AVAILABLE before any adapter", async () => {
    const get = vi.fn(async () => { throw new Error("must not create an adapter"); });
    await expect(fundsProgram(get).parseAsync(["funds", "deposit", "lighter-rh", "5"], { from: "user" }))
      .rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    expect(get).not.toHaveBeenCalled();
    expect(rhDeposit.execute).not.toHaveBeenCalled();
  });

  it("every venue that declares withdrawAssets has a chain label", () => {
    for (const def of listVenues()) {
      if (def.capabilities === null || def.capabilities.withdrawAssets === null) continue;
      for (const net of ["mainnet", "testnet"] as const) {
        const cfg = def.networks[net];
        if (cfg === null) continue;
        // Venues that settle off-chain pay out on a public chain (qfex: Arbitrum One).
        const chain = def.id === "qfex" ? QFEX_WITHDRAW_NETWORK : cfg.settlementChain;
        expect(() => chainLabel(chain), `${def.id} ${net} ${chain}`).not.toThrow();
      }
    }
    expect(() => chainLabel("nowhere")).toThrow();
  });

  it("lighter-rh mainnet has the Robinhood Chain RPC; testnet has none", () => {
    expect(getVenue("lighter-rh").networks.mainnet.rpcUrl).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(getVenue("lighter-rh").networks.testnet?.rpcUrl).toBeNull();
  });

  it("LighterAdapter.signL1Transaction without an OWS master → NO_SIGNER_AVAILABLE", async () => {
    const lt = LighterAdapter.forVenue("lighter-rh", "", false);
    const { Transaction } = await import("ethers");
    const tx = Transaction.from({ type: 2, chainId: 4663n, nonce: 0, to: `0x${"11".repeat(20)}`, data: "0x", value: 0n, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    await expect(lt.signL1Transaction(tx)).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
  });
});

// ── #6 no stale venue counts ──────────────────────────────────────────────

describe("#6 docs carry no stale venue counts", () => {
  it("README and plugin marketplace do not say '4 DEX'", () => {
    for (const f of ["../../README.md", "../../.claude-plugin/marketplace.json"]) {
      const text = readFileSync(resolve(__dirname, f), "utf8");
      expect(text, f).not.toMatch(/\b(4|four) (DEX|DEXes|DEXs|exchanges)\b/i);
    }
  });
});
