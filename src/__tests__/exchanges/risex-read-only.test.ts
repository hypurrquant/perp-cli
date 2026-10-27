/**
 * RISEx read-only release phase (0.15.0, owner decision 2026-10-19): with RISEX_TRADING_ENABLED
 * false (mocked here — trading ships on since 2026-10-27; the gate must still hold if it is switched off again), every trading / signer / agent / bot / MCP-write /
 * setup entry point refuses with CAPABILITY_UNSUPPORTED (also under --dry-run) before any request,
 * while market data and public-by-address account reads keep working. No network: fetch is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, ToolHandler>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, h: ToolHandler) { tools.set(name, h); }
    resource() { /* not used */ }
    prompt() { /* not used */ }
    async connect() { /* no transport in tests */ }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../../exchanges/venues/risex-release.js", () => ({ RISEX_TRADING_ENABLED: false }));
const owsCreate = vi.fn((name: string) => ({ getAddress: () => (name === "main" ? "0x00000000000000000000000000000000000000c3" : "0x00000000000000000000000000000000000000a1") }));
vi.mock("../../signer/ows-evm.js", () => ({ OwsEvmSigner: { create: (name: string, _p: string) => owsCreate(name) } }));
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import {
  apiStatusOf, getVenue, listVenuesWithRole, requireCapabilities, roleUnsupported,
} from "../../exchanges/venue.js";
import { RISEX_TRADING_ENABLED } from "../../exchanges/venues/risex-release.js";
import { RisexAdapter } from "../../exchanges/risex/adapter.js";
import { RISEX_PINS } from "../../exchanges/risex/typed-data.js";
import { automationGateOf } from "../../exchanges/trading-v2.js";
import { resolveSetupVenue, setupVenues } from "../../commands/init.js";
import { assertAgentApproveSupported } from "../../commands/agent.js";

const GATED = /RISEx trading is planned for a later perp-cli release; in this version RISEx is read-only/;
const ACCOUNT = "0x00000000000000000000000000000000000000b2";

const ok = (data: unknown) => new Response(JSON.stringify({ data, request_id: "r" }), { status: 200 });
const MARKET = {
  market_id: "1",
  config: { name: "BTC/USDC", step_size: "0.000001", step_price: "0.1", max_leverage: "25", min_order_size: "0.00015", unlocked: true, match_price_band: "0.02" },
  mark_price: "83425.5", index_price: "83429.6", open_interest: "204.62", quote_volume_24h: "46147397.06",
  funding_interval: "3600000000000", next_funding_time: "1791910800000000000", current_funding_rate: "0.000014990672003283",
  predicted_funding_rate: "0", post_only: false, reduce_only: false, active: true, category: "crypto", search_tags: ["crypto"],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (u: string) => {
    const url = new URL(u);
    if (url.pathname === "/v1/markets") return ok({ markets: [MARKET] });
    if (url.pathname === "/v1/portfolio/details") {
      return ok({
        summary: { total_account_value: "1000.5", free_collateral: "900", total_initial_margin: "100.5", total_unrealized_pnl: "-1.25" },
        positions: [{ market_id: "1", size: "-0.5", avg_entry_price: "80000", mark_price: "83000", liquidation_price: "0", unrealized_pnl: "-1.25", leverage: "10", margin_mode: 0 }],
      });
    }
    if (url.pathname === "/v1/system/config") return ok({ addresses: { router: RISEX_PINS.mainnet.router, auth: RISEX_PINS.mainnet.auth }, is_maintenance_mode: false });
    throw new Error(`unexpected network call: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const writeCalls = () => fetchMock.mock.calls.filter(([u]) => !/\/v1\/(markets|portfolio\/details)/.test(String(u)));

describe("release switch + venue definition", () => {
  it("ships with RISEx trading switched off", () => {
    expect(RISEX_TRADING_ENABLED).toBe(false);
  });

  it("roles = market data + account; trading is gated (not removed); official API", () => {
    const def = getVenue("risex");
    expect(def.roles).toEqual(["marketData", "account"]);
    expect(def.gatedRoles?.roles).toEqual(["trading"]);
    expect(def.capabilities).not.toBeNull(); // the trading description stays for phase 2
    expect(def.apiStatus).toEqual({ kind: "official" });
    expect(apiStatusOf("risex")).toBe("official");
    expect(listVenuesWithRole("marketData").map(v => v.id)).toContain("risex");
    expect(listVenuesWithRole("account").map(v => v.id)).toContain("risex");
    expect(listVenuesWithRole("trading").map(v => v.id)).not.toContain("risex");
  });

  it("roleUnsupported / requireCapabilities give the uniform phase refusal", () => {
    const e = roleUnsupported(getVenue("risex"), "trading");
    expect(e.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(e.message).toMatch(GATED);
    expect(e.structured.remediation).toMatch(/app\.rise\.trade/);
    expect(() => requireCapabilities(getVenue("risex"))).toThrow(GATED);
  });

  it("TxFlow keeps its own unofficial-API refusal", () => {
    expect(roleUnsupported(getVenue("txflow"), "trading").message).toMatch(/unofficial read-only API/);
  });
});

describe("adapter: reads work, every write refuses before any request", () => {
  // A signer IS present: the release gate must refuse before it is ever used.
  const spySigner = {
    getAddress: vi.fn(() => "0x00000000000000000000000000000000000000a1"),
    signTypedData: vi.fn(async () => "0x"),
    signMessage: vi.fn(async () => "0x"),
  };
  const adapter = () => new RisexAdapter(getVenue("risex"), "mainnet", {
    account: ACCOUNT, signer: spySigner, meta: null, noSignerReason: null,
  });

  it("market data and account reads (public by address)", async () => {
    const a = adapter();
    expect((await a.getVenueMarkets()).map(m => m.symbol)).toEqual(["BTC"]);
    expect(await a.getBalance()).toEqual({ equity: "1000.5", available: "900", marginUsed: "100.5", unrealizedPnl: "-1.25" });
    expect((await a.getPositions())[0]).toMatchObject({ symbol: "BTC", side: "short", size: "0.5" });
  });

  const writes: Array<[string, (a: RisexAdapter) => Promise<unknown>]> = [
    ["placeOrder", a => a.placeOrder({ symbol: "BTC", side: "buy", type: "limit", size: "0.001", price: "50000", triggerPrice: null, triggerSource: null, tif: "GTC", reduceOnly: false, clientOrderId: null, slippage: null, tpsl: null })],
    ["marketOrder", a => a.marketOrder("BTC", "buy", "0.001", { reduceOnly: false, slippage: { bps: 50, source: "flag" } as never })],
    ["limitOrder", a => a.limitOrder("BTC", "buy", "50000", "0.001", { tif: "GTC" })],
    ["cancelByRef", a => a.cancelByRef("BTC", { kind: "orderId", value: "1" })],
    ["cancelOrder", a => a.cancelOrder("BTC", "1")],
    ["cancelAllV2", a => a.cancelAllV2(null)],
    ["cancelAllOrders", a => a.cancelAllOrders()],
    ["applyLeverage", a => a.applyLeverage("BTC", 5, "isolated")],
    ["setLeverage", a => a.setLeverage("BTC", 5)],
    ["testnetFaucet", a => a.testnetFaucet()],
  ];
  for (const [name, call] of writes) {
    it(`${name} → CAPABILITY_UNSUPPORTED (phase refusal), nothing sent`, async () => {
      await expect(call(adapter())).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" }, message: expect.stringMatching(GATED) });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(spySigner.signTypedData).not.toHaveBeenCalled();
      expect(spySigner.signMessage).not.toHaveBeenCalled();
    });
  }

  it("automation (bots / TWAP / grid / funding-arb) is refused with the phase refusal", () => {
    const gate = automationGateOf(adapter());
    expect(gate?.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(gate?.message).toMatch(GATED);
  });
});

describe("setup / agent entry points", () => {
  it("setup: RISEx is not offered and is refused as a --venues / --default-venue entry", () => {
    expect(setupVenues().map(v => v.id)).not.toContain("risex");
    expect(() => resolveSetupVenue("risex", "mainnet")).toThrow(GATED);
    expect(() => resolveSetupVenue("rise", "mainnet")).toThrow(GATED);
  });

  it("agent approve / revoke / rotate are refused", () => {
    for (const op of ["approve", "revoke", "rotate"] as const) {
      expect(() => assertAgentApproveSupported("risex", "mainnet", op)).toThrow(GATED);
    }
  });
});

describe("CLI entry points (with and without --dry-run)", () => {
  type Env = { ok: boolean; data?: unknown; error?: { code: string; message: string; remediation?: string } };
  const run = async (args: string[]): Promise<Env> => {
    const { buildProgram } = await import("../../cli-program.js");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation((m) => { out.push(String(m)); return true; });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw Object.assign(new Error("__exit__"), { exitCode: code }); }) as never);
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    try {
      await program.parseAsync(["node", "perp", "--json", ...args]);
    } catch (e) {
      if (e instanceof PerpError) return { ok: false, error: e.structured as never };
      if ((e as Error).message !== "__exit__") throw e;
    } finally {
      vi.restoreAllMocks();
    }
    return JSON.parse(out.join("").trim()) as Env;
  };

  const gated: string[][] = [
    ["-e", "risex", "trade", "market", "BTC", "buy", "0.001"],
    ["-e", "risex", "trade", "buy", "BTC", "0.001"],
    ["-e", "risex", "trade", "sell", "BTC", "0.001"],
    ["-e", "risex", "trade", "split", "BTC", "buy", "100"],
    ["-e", "risex", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["-e", "risex", "trade", "cancel", "BTC", "123"],
    ["-e", "risex", "trade", "cancel-all"],
    ["-e", "risex", "trade", "stop", "BTC", "sell", "0.001", "50000"],
    ["-e", "risex", "trade", "tpsl", "BTC", "long", "--tp", "90000"],
    ["-e", "risex", "trade", "edit", "BTC", "123", "50000", "0.001"],
    ["-e", "risex", "trade", "leverage", "BTC", "5"],
    ["-e", "risex", "trade", "close-all"],
    ["-e", "risex", "trade", "close", "BTC"],
    ["-e", "risex", "trade", "flatten"],
    ["-e", "risex", "trade", "reduce", "BTC", "50"],
    ["-e", "risex", "trade", "check", "BTC", "buy", "0.001"],
    ["-e", "risex", "trade", "atomic", "--usd", "20", "--long", "BTC", "--short", "ETH"],
    ["-e", "risex", "trade", "twap", "BTC", "buy", "0.01", "10m"],
    ["-e", "risex", "trade", "scale-in", "BTC", "buy", "--levels", "60000:50,59000:50", "--size", "0.001"],
    ["-e", "risex", "trade", "scale-tp", "BTC", "--levels", "90000:50,95000:50"],
    ["-e", "risex", "trade", "spot-buy", "BTC", "0.001"],
    ["-e", "risex", "trade", "spot-sell", "BTC", "0.001"],
    ["-e", "risex", "trade", "spot-limit", "BTC", "buy", "50000", "0.001"],
    ["-e", "risex", "trade", "spot-cancel", "BTC", "1"],
    ["-e", "risex", "trade", "spot-transfer", "to-spot", "10"],
    ["-e", "risex", "trade", "cancel-stop", "BTC", "1"],
    ["-e", "risex", "trade", "cancel-twap", "BTC", "1"],
    ["-e", "rise", "trade", "market", "BTC", "buy", "0.001"],
    ["trade", "multi", "risex:BTC:buy:0.001", "hyperliquid:BTC:sell:0.001"],
    ["arb", "exec", "BTC", "risex", "hyperliquid", "100"],
    ["arb", "exec", "BTC", "hyperliquid", "risex", "100"],
    ["wallet", "agent", "approve", "risex"],
    ["wallet", "agent", "import", "risex"],
    ["wallet", "agent", "revoke", "risex", "perp-cli-risex"],
    ["wallet", "agent", "rotate", "risex"],
    ["-n", "testnet", "funds", "faucet", "risex"],
  ];
  for (const base of gated) {
    for (const args of [base, ["--dry-run", ...base]]) {
      it(`perp ${args.join(" ")} → CAPABILITY_UNSUPPORTED (read-only release), nothing sent`, async () => {
        const env = await run(args);
        expect(env.ok).toBe(false);
        expect(env.error!.code).toBe("CAPABILITY_UNSUPPORTED");
        expect(env.error!.message).toMatch(GATED);
        expect(writeCalls()).toEqual([]);
      });
    }
  }

  describe("strategies and plans (the gate runs before the adapter is built — no key opened)", () => {
    const dir = mkdtempSync(join(tmpdir(), "risex-gate-"));
    const planFile = join(dir, "plan.json");
    writeFileSync(planFile, JSON.stringify({ version: "1.0", steps: [{ id: "1", action: "set_leverage", params: { symbol: "BTC", leverage: 5 } }, { id: "2", action: "cancel_all", params: {} }] }));
    const configFile = join(dir, "bot.json");
    writeFileSync(configFile, JSON.stringify({ exchange: "risex", symbol: "BTC", strategy: { type: "grid" } }));
    const strategies: string[][] = [
      ["-e", "risex", "strategy", "plan", "execute", planFile],
      ["-e", "risex", "strategy", "run", "grid", "BTC", "--headless"],
      ["strategy", "run", "grid", "BTC", "--headless", "--exchanges", "hyperliquid,risex"],
      ["strategy", "start", configFile, "--headless"],
      ["-e", "risex", "strategy", "grid", "BTC", "--upper", "90000", "--lower", "80000"],
      ["-e", "risex", "strategy", "quick-grid", "BTC"],
      ["-e", "risex", "strategy", "dca", "BTC", "buy", "10", "1m"],
      ["-e", "risex", "strategy", "twap", "BTC", "buy", "0.01", "10m"],
      ["-e", "risex", "strategy", "trailing-stop", "BTC", "--trail", "2"],
      ["strategy", "funding-arb", "--exchanges", "hyperliquid,risex"],
    ];
    for (const base of strategies) {
      for (const args of [base, ["--dry-run", ...base]]) {
        it(`perp ${args.join(" ")} → CAPABILITY_UNSUPPORTED`, async () => {
          const create = vi.spyOn(getVenue("risex"), "create" as never);
          const env = await run(args);
          expect(env.ok).toBe(false);
          // --dry-run on a command that cannot simulate is refused by the dry-run guard first (INVALID_PARAMS).
          if (env.error!.code === "INVALID_PARAMS") expect(env.error!.message).toMatch(/does not support --dry-run/);
          else {
            expect(env.error!.code).toBe("CAPABILITY_UNSUPPORTED");
            expect(env.error!.message).toMatch(GATED);
          }
          expect(create).not.toHaveBeenCalled();
          expect(writeCalls()).toEqual([]);
        });
      }
    }
  });

  describe("wallet agent revoke risex", () => {
    const META = {
      kind: "risex", agentName: "perp-cli-risex", agentWalletName: "agent-risex-main",
      signerAddress: "0x00000000000000000000000000000000000000a1", accountAddress: ACCOUNT,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      permissions: { tradingOnly: true, disabled: [0, 3, 4], verifiedAt: "2026-10-14T00:00:00Z" },
      network: "mainnet", approvedAt: "2026-10-14T00:00:00Z", source: "approved",
    };
    const writeMeta = () => {
      const d = resolve(process.env.HOME as string, ".perp");
      mkdirSync(d, { recursive: true });
      writeFileSync(resolve(d, "settings.json"), JSON.stringify({ agents: { risex: { "perp-cli-risex": META } } }));
    };

    it("the on-chain revoke stays gated", async () => {
      writeMeta();
      const env = await run(["wallet", "agent", "revoke", "risex", "perp-cli-risex"]);
      expect(env.error!.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("--force only clears the local record (nothing signed or sent)", async () => {
      writeMeta();
      const env = await run(["wallet", "agent", "revoke", "risex", "perp-cli-risex", "--force"]);
      expect(env).toMatchObject({ ok: true, data: { revoked: false, local: true, txHash: null } });
      const { getVenueAgent } = await import("../../agent-wallet/store.js");
      expect(getVenueAgent("risex", "perp-cli-risex")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("perp -e risex market list still works (public data)", async () => {
    const env = await run(["-e", "risex", "market", "list"]);
    expect(env.ok).toBe(true);
    expect((env.data as Array<{ symbol: string }>).map(m => m.symbol)).toEqual(["BTC"]);
  });
});

describe("MCP write tools", () => {
  const args: Record<string, Record<string, unknown>> = {
    trade_preview: { exchange: "risex", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false },
    trade_execute: { exchange: "risex", symbol: "BTC", side: "buy", size: "0.001", orderType: "market", reduceOnly: false },
    trade_close: { exchange: "rise", symbol: "BTC" },
  };
  for (const name of Object.keys(args)) {
    it(`${name} on risex → CAPABILITY_UNSUPPORTED before any credential or request`, async () => {
      if (tools.size === 0) await import("../../mcp-server.js");
      const r = await tools.get(name)!(args[name]);
      const env = JSON.parse(r.content[0].text) as { ok: boolean; code?: string; error?: string };
      expect(env.ok).toBe(false);
      expect(env.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(env.error).toMatch(GATED);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("market data tools still serve RISEx", async () => {
    if (tools.size === 0) await import("../../mcp-server.js");
    const r = await tools.get("get_markets")!({ exchange: "risex" });
    const env = JSON.parse(r.content[0].text) as { ok: boolean; data?: unknown };
    expect(env.ok).toBe(true);
    expect(JSON.stringify(env.data)).toContain("BTC");
  });
});

describe("RisexAdapter.create while trading is gated", () => {
  const meta = {
    kind: "risex", agentName: "perp-cli-risex", agentWalletName: "agent-risex-stale",
    signerAddress: "0x00000000000000000000000000000000000000a1", accountAddress: ACCOUNT,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    permissions: { tradingOnly: true, disabled: [0, 3, 4], verifiedAt: "2026-10-14T00:00:00Z" },
    network: "mainnet", approvedAt: "2026-10-14T00:00:00Z", source: "approved",
  };
  const ctx = (owsWallet: string | null) => ({
    network: "mainnet" as const, noAgent: false, hlDex: null, readOnly: false, noBuilder: false,
    credentials: { pk: null, owsWallet, owsPassphrase: "", owsKeyToken: null, agent: meta as never },
  });

  it("with a master wallet: reads its address, never opens the stored signer's key", async () => {
    owsCreate.mockClear();
    const a = await RisexAdapter.create(getVenue("risex"), ctx("main"));
    expect(owsCreate.mock.calls.map(c => c[0])).toEqual(["main"]);
    expect(a.accountAddress()).toBe("0x00000000000000000000000000000000000000c3");
    expect((await a.getBalance()).equity).toBe("1000.5");
  });

  it("without a master wallet: reads the recorded account, opens no key at all", async () => {
    owsCreate.mockClear();
    const a = await RisexAdapter.create(getVenue("risex"), ctx(null));
    expect(owsCreate).not.toHaveBeenCalled();
    expect(a.accountAddress()).toBe(ACCOUNT);
  });
});

describe("executePlan / runBot refuse a gated venue (dry-run included)", () => {
  const fake = { name: "risex" } as never;
  it("executePlan", async () => {
    const { executePlan } = await import("../../plan-executor.js");
    for (const dryRun of [false, true]) {
      await expect(executePlan(fake, { version: "1.0", steps: [{ id: "1", action: "cancel_all", params: {} }] } as never, { dryRun }))
        .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    }
  });
  it("runBot", async () => {
    const { runBot } = await import("../../bot/engine.js");
    for (const dryRun of [false, true]) {
      await expect(runBot(fake, { strategy: { type: "grid" } } as never, undefined, () => undefined, undefined, "headless" as never, dryRun))
        .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    }
  });
});

describe("funding comparisons label read-only legs (data stays visible)", () => {
  it("pairExecutability", async () => {
    const { pairExecutability } = await import("../../funding/rates.js");
    expect(pairExecutability("hyperliquid", "risex")).toEqual({ executable: false, readOnlyLegs: ["risex"], unverifiedLegs: [] });
    expect(pairExecutability("hyperliquid", "pacifica")).toEqual({ executable: true, readOnlyLegs: [], unverifiedLegs: [] });
  });
});
