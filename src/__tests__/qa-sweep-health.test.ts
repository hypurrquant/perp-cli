/**
 * Pre-release QA sweep (0.15.0) — `perp health` probed only pacifica / hyperliquid / lighter /
 * aster. It now runs the same probe as `perp portfolio --health` and the MCP health_check
 * (src/venue-health.ts): every registered venue, read-only venues through their public
 * market-data read, unofficial APIs tagged, venues without an environment on the network listed
 * under `skipped` (never silently dropped). No registered venue is read through an unofficial API
 * since TxFlow published its official API, so the unofficial split is exercised by
 * relabelling TxFlow for one test (asUnofficial).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../cli-flags.js";
import { registerRiskCommands } from "../commands/risk.js";
import { probeVenueHealth } from "../venue-health.js";
import { listVenues } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";

let restoreApiStatus: (() => void) | null = null;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; restoreApiStatus?.(); restoreApiStatus = null; });

/** Relabel one registered venue as read through an unofficial API for the current test. */
function asUnofficial(id: string): void {
  const def = listVenues().find((v) => v.id === id)!;
  const saved = def.apiStatus;
  (def as { apiStatus: typeof def.apiStatus }).apiStatus = { kind: "unofficial", note: "test", docs: null };
  restoreApiStatus = () => { (def as { apiStatus: typeof def.apiStatus }).apiStatus = saved; };
}

function offline() {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  for (const v of listVenues()) vi.spyOn(v.publicData, "fetchMarkets").mockRejectedValue(new Error(`${v.id} offline`));
}

describe("probeVenueHealth", () => {
  it("mainnet: one probe per registered venue, each failure with its message", async () => {
    offline();
    const h = await probeVenueHealth("mainnet");
    expect(h.probes.map((p) => p.venue)).toEqual(listVenues().map((v) => v.id));
    expect(h.skipped).toEqual([]);
    expect(h.allHealthy).toBe(false);
    for (const p of h.probes) expect(p.error).toEqual(expect.any(String));
  });

  it("read-only TxFlow is probed through its market-data read and tagged official", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const txflow = listVenues().find((v) => v.id === "txflow")!;
    const fetchMarkets = vi.spyOn(txflow.publicData, "fetchMarkets").mockResolvedValue([]);
    const h = await probeVenueHealth("mainnet", ["txflow", "aster"]);
    expect(fetchMarkets).toHaveBeenCalledWith("mainnet", { funding: false }); // a health probe needs no funding read
    expect(h.probes).toEqual([
      expect.objectContaining({ venue: "txflow", ok: true, probe: "markets", status: null, error: null, apiStatus: "official" }),
      expect.objectContaining({ venue: "aster", ok: true, probe: "ping", status: 200, apiStatus: "official" }),
    ]);
  });

  it("testnet: a venue without a testnet environment is listed under skipped with the reason", async () => {
    offline();
    const h = await probeVenueHealth("testnet");
    const noTestnet = listVenues().filter((v) => v.networks.testnet === null).map((v) => v.id);
    expect(noTestnet).toContain("txflow");
    expect(h.skipped.map((s) => s.venue)).toEqual(noTestnet);
    expect(h.skipped[0].reason).toMatch(/no testnet environment/);
    expect(h.probes.map((p) => p.venue)).toEqual(listVenues().filter((v) => v.networks.testnet !== null).map((v) => v.id));
  });
});

describe("perp health", () => {
  async function health(argv: string[]) {
    const program = new Command();
    program.exitOverride();
    addRootSafetyOptions(program).option("--json");
    registerRiskCommands(program, async () => { throw new Error("no adapter needed"); }, () => program.opts().json === true);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", ...argv]);
    return out;
  }

  it("--json covers every registered venue (not the former 4): official venues in exchanges, unofficial ones listed separately", async () => {
    asUnofficial("txflow");
    offline();
    const out = await health(["--json", "health"]);
    const env = JSON.parse(out[0]);
    expect(env.ok).toBe(true);
    expect(env.data.network).toBe("mainnet");
    const official = listVenues().filter((v) => v.apiStatus.kind === "official").map((v) => v.id);
    expect(env.data.exchanges.map((e: { exchange: string }) => e.exchange)).toEqual(official);
    expect(env.data.unofficial.map((e: { exchange: string }) => e.exchange)).toEqual(["txflow"]);
    expect(env.data.unofficial[0]).toMatchObject({ status: "down", probe: "markets", apiStatus: "unofficial", error: expect.any(String) });
    for (const e of env.data.exchanges) expect(e).toHaveProperty("error"); // always present: null when ok
    expect(env.data.healthy).toBe(false);
    expect(env.data.allHealthy).toBe(false);
    expect(env.data.skipped).toEqual([]);
  });

  it("`healthy` counts official-API venues only: an unofficial venue being down does not flip it", async () => {
    asUnofficial("txflow");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    for (const v of listVenues()) {
      if (v.id === "txflow") vi.spyOn(v.publicData, "fetchMarkets").mockRejectedValue(new Error("txflow offline"));
      else vi.spyOn(v.publicData, "fetchMarkets").mockResolvedValue([]);
    }
    const env = JSON.parse((await health(["--json", "health"]))[0]);
    expect(env.data.healthy).toBe(true);
    expect(env.data.allHealthy).toBe(false);
    expect(env.data.unofficial[0]).toMatchObject({ exchange: "txflow", status: "down", error: "txflow offline" });
  });

  it("-n testnet reports TxFlow as skipped", async () => {
    offline();
    const env = JSON.parse((await health(["-n", "testnet", "--json", "health"]))[0]);
    expect(env.data.network).toBe("testnet");
    expect(env.data.skipped.map((s: { venue: string }) => s.venue)).toContain("txflow");
  });
});
