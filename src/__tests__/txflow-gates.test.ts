/**
 * TxFlow with trading switched ON (the shipped value, NOT mocked here): manual trading is open,
 * and what stays refused still refuses before anything is sent —
 *  - unattended automation (TWAP / DCA / grid / trailing stop / plan / bot / background job):
 *    the adapter's automationGate (TXFLOW_AUTOMATION_GATE);
 *  - builder codes, arb legs (funding unverified), deposits / withdrawals (web app only).
 * The switched-off gate is txflow.test.ts / txflow-mcp.test.ts (switch mocked off).
 *
 * No network: fetch throws on any call. HOME is isolated by the vitest setup file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import "../exchanges/venues/index.js";
import { PerpError } from "../errors.js";
import { getVenue } from "../exchanges/venue.js";
import { TXFLOW_TRADING_ENABLED } from "../exchanges/venues/txflow-release.js";
import { TxflowAdapter } from "../exchanges/txflow/adapter.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { automationGateOf, reduceOnlyGateOf } from "../exchanges/trading-v2.js";
import { runTWAP } from "../strategies/twap.js";
import { runDCA } from "../strategies/dca.js";
import { runGrid } from "../strategies/grid.js";
import { runTrailingStop } from "../strategies/trailing-stop.js";
import { executePlan } from "../plan-executor.js";
import { runBot } from "../bot/engine.js";
import { startJob } from "../jobs.js";
import { buildProgram } from "../cli-program.js";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (u: string) => { throw new Error(`unexpected network call: ${u}`); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function adapter(): TxflowAdapter {
  return new TxflowAdapter(getVenue("txflow"), "testnet", {
    account: "0x000000000000000000000000000000000000dEaD", signer: null, meta: null,
    noSignerReason: new PerpError("AGENT_NOT_REGISTERED", "No TxFlow agent is registered on this computer", { exchange: "txflow" }),
    sleep: async () => {},
  });
}

describe("TxFlow trading ships on", () => {
  it("the release switch is on and the venue has the trading role", () => {
    expect(TXFLOW_TRADING_ENABLED).toBe(true);
    expect(getVenue("txflow").roles).toContain("trading");
    expect(getVenue("txflow").gatedRoles).toBeNull();
  });

  it("manual reduce-only is open; automation is gated", () => {
    const a = adapter();
    expect(reduceOnlyGateOf(a)).toBeNull();
    const gate = automationGateOf(a) as PerpError;
    expect(gate.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(gate.message).toMatch(/unattended trading on TxFlow is not enabled until its trading path is verified live/);
  });

  it("TWAP / DCA / grid / trailing stop / plan / bot refuse before any order or read", async () => {
    const a = adapter() as unknown as ExchangeAdapter;
    const refused = async (p: Promise<unknown>) => {
      await expect(p).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    };
    await refused(runTWAP(a, { symbol: "BTC", side: "buy", totalSize: 0.01, durationSec: 60 }, undefined, () => {}));
    await refused(runDCA(a, { symbol: "BTC", side: "buy", amountPerOrder: 0.001, intervalSec: 60, totalOrders: 2 }, undefined, () => {}));
    await refused(runGrid(a, { symbol: "BTC", upperPrice: 90000, lowerPrice: 80000, grids: 3, totalSize: 0.003 } as never, undefined, () => {}));
    await refused(runTrailingStop(a, { symbol: "BTC", trailPct: 3 }, undefined, () => {}));
    await refused(executePlan(a, { version: "1.0", steps: [{ id: "a", action: "market_order", params: { symbol: "BTC", side: "buy", size: "0.001" } }] } as never));
    await refused(runBot(a, { strategy: { type: "grid" } } as never, undefined, (() => {}) as never, undefined, "silent" as never, false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("startJob refuses a txflow background job", () => {
    const base = { strategy: "twap", exchange: "txflow", network: "testnet" as const, dryRun: false, cliArgs: [], selectors: { ows: null, wallet: null, noAgent: false, dex: null, noBuilder: false } };
    expect(() => startJob(base as never)).toThrow(/^Background job "twap" refused: it would trade unattended — /);
  });
});

describe("CLI refusals with trading on (-e txflow), nothing is sent", () => {
  const run = async (args: string[]): Promise<{ ok: boolean; error?: { code: string; message: string } }> => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => { lines.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    try {
      await program.parseAsync(["node", "perp", "--json", ...args]);
    } catch (e) {
      if (!(e instanceof PerpError)) throw e;
      return { ok: false, error: e.structured as never };
    } finally {
      vi.restoreAllMocks();
      vi.stubGlobal("fetch", fetchMock);
    }
    const json = lines.map(l => l.trim()).filter(l => l.startsWith("{"));
    return JSON.parse(json[json.length - 1]);
  };

  it.each([
    ["strategy twap", ["-e", "txflow", "strategy", "twap", "BTC", "buy", "0.01", "10m"], /TWAP on txflow refused: it would trade unattended/],
    ["strategy grid", ["-e", "txflow", "strategy", "grid", "BTC", "--upper", "90000", "--lower", "80000", "--grids", "5", "--size", "0.001"], /Grid on txflow refused: it would trade unattended/],
    ["wallet builder approve", ["wallet", "builder", "approve", "txflow"], /txflow does not support builderFee/],
    ["arb exec leg", ["arb", "exec", "BTC", "txflow", "hyperliquid", "10"], /txflow does not support fundingArb/],
    ["funds withdraw", ["-e", "txflow", "funds", "withdraw", "txflow", "10"], /txflow does not support withdraw/],
  ])("%s → CAPABILITY_UNSUPPORTED", async (_n, args, message) => {
    const r = await run(args as string[]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(r.error!.message).toMatch(message as RegExp);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
