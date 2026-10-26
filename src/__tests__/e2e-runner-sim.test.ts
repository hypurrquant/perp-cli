/**
 * E2E runner — simulated run at --max-usd 30 on a $10-minimum venue (unit ≈ $15, the MIN_ORDER_USD floor). The real runLeg
 * drives a FAKE CLI (in-memory venue state) and a fake built venue definition: nothing is spawned
 * and nothing reaches a venue.
 *
 * Review finding H2: at the default mainnet cap any second order was skipped by the run-wide
 * exposure check while its dependent checks still ran → the run aborted leaving a resting order
 * or a spot holding. Now: an edit is valued as the replacement delta; a skipped step skips its
 * dependents (never fails them); a definite failure runs a cleanup of what the run created; an
 * unknown outcome stops with no further write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CliResult, Envelope, RunReport } from "../../scripts/e2e/lib.js";

const h = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "perp-e2e-sim-"));
  const dir = path.join(root, "dist", "exchanges", "venues");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const netCfg = `{ restUrl: "https://fake-venue.test", collateral: ["USDC"], settlementChain: "solana", signingChainId: null, collateralAssetIndex: null, rpcUrl: null, depositPins: null }`;
  fs.writeFileSync(path.join(dir, "index.js"), `export const ALL_VENUES = [{
    id: "pacifica", displayName: "Fake", networks: { testnet: ${netCfg}, mainnet: ${netCfg} }, fundingRateBasis: "1h",
    capabilities: { timeInForce: ["GTC", "IOC", "ALO"], tpsl: "positionLevel", amend: "native", orderAck: "sync", marketOrder: "slippageBounded", marginModes: ["cross"], withdrawAssets: ["USDC"] },
    spot: { accountModel: "separate", quoteAssets: { testnet: ["USDC"], mainnet: ["USDC"] }, capabilities: { limitOrder: true, orderbook: true, cancel: true, transfer: true } },
    publicData: {
      fetchMarkets: async () => [{ symbol: "ETH", markPrice: "2700", tickSize: "0.1", stepSize: "0.0001", minSize: null, minNotional: "10", maxLeverage: 50, tradable: true }],
      fetchFundingRates: async () => [],
    },
  }];\n`);
  return { root, cli: { run: null as null | ((argv: string[]) => { env: unknown; exit: number; stdout?: string }) } };
});

vi.mock("../../scripts/e2e/lib.js", async importOriginal => {
  const real = await importOriginal<typeof import("../../scripts/e2e/lib.js")>();
  return {
    ...real,
    REPO_ROOT: h.root,
    killSwitchActive: () => false,
    isInteractive: () => false,
    runCli: async (argv: string[]): Promise<CliResult> => {
      const r = h.cli.run!(argv);
      return { argv, command: real.displayCommand(argv), exitCode: r.exit, timedOut: false, durationMs: 1, stdout: r.stdout ?? "", stderr: "", envelope: r.env as Envelope | null };
    },
  };
});

import { parseArgs, runLeg } from "../../scripts/e2e/run.js";

// ── Fake venue ───────────────────────────────────────────────────────────────

interface Order { orderId: string; symbol: string; side: string; price: string; size: string; type: string; filled: string }
interface Faults { brokenEdit: boolean; hideSpotOrders: boolean; marketBuyUnknown: boolean; otherPosition: boolean }

function fakeVenue(faults: Partial<Faults> = {}) {
  const f: Faults = { brokenEdit: false, hideSpotOrders: false, marketBuyUnknown: false, otherPosition: false, ...faults };
  const st = { orders: [] as Order[], pos: 0, perpAvail: 50, spotUsdc: 0, spotSol: 0, spotOrders: [] as Array<{ orderId: string }>, nextId: 100, writes: [] as string[] };
  const ok = (data: unknown) => ({ env: { ok: true, data }, exit: 0 });
  const err = (code: string, message = code) => ({ env: { ok: false, error: { code, message } }, exit: 1 });
  const id = () => String(st.nextId++);
  const flag = (a: string[], name: string): string | null => { const i = a.indexOf(name); return i === -1 ? null : a[i + 1]; };

  const run = (argv: string[]) => {
    if (argv[0] === "--version") return { env: null, exit: 0, stdout: "0.0.0-sim\n" };
    const a = argv.filter((x, i) => x !== "--json" && !["-n", "-e"].includes(x) && !["-n", "-e"].includes(argv[i - 1]));
    const [g, c, ...r] = a;
    if (g === "strategy") return ok({ entries: [] });
    if (g === "wallet") return c === "agent" && r[0] === "list" ? ok([{ name: "sim", network: "testnet", source: "approved" }]) : ok({});
    if (g === "market") return c === "mid" ? ok({ bid: "2699.9", ask: "2700.1" }) : ok([{ symbol: "ETH" }]);
    if (g === "portfolio") return ok({ exchanges: [{ perp: { equity: "50", available: String(st.perpAvail) } }] });
    if (g === "account" && c === "positions") {
      return ok([
        ...(st.pos !== 0 ? [{ symbol: "ETH", side: "long", size: String(st.pos), markPrice: "2700" }] : []),
        ...(f.otherPosition ? [{ symbol: "BTC", side: "long", size: "0.0003", markPrice: "60000" }] : []),
      ]);
    }
    if (g === "account" && c === "orders") return ok(st.orders);
    if (g !== "trade") throw new Error(`fake CLI: unhandled ${a.join(" ")}`);
    if (c !== "spot-balance" && c !== "spot-orders" && c !== "status") st.writes.push(a.slice(1).join(" "));
    switch (c) {
      case "leverage": case "status": return ok({});
      case "limit": {
        const [sym, side, price, size] = r; const tif = flag(r, "--tif");
        if (tif === "IOC") return ok({ orderId: id(), status: "cancelled", finality: "final", filledSize: "0" });
        if (tif === "ALO" && side === "buy" && Number(price) >= 2700.1) return err("ORDER_REJECTED", "post-only would cross");
        const o = { orderId: id(), symbol: sym, side, price, size, type: "limit", filled: "0" };
        st.orders.push(o);
        return ok({ orderId: o.orderId, status: "open", finality: "final", execution: { tifSent: tif } });
      }
      case "edit": {
        const o = st.orders.find(x => x.orderId === r[1]);
        if (o === undefined) return err("ORDER_NOT_FOUND");
        if (!f.brokenEdit) { o.price = r[2]; o.size = r[3]; }
        return ok({ orderId: o.orderId, execution: { method: "native", tifSent: "ALO" } });
      }
      case "cancel": case "cancel-stop": {
        const i = st.orders.findIndex(x => x.orderId === r[1]);
        if (i === -1) return err("ORDER_NOT_FOUND");
        st.orders.splice(i, 1);
        return ok({ cancelled: [{ value: r[1] }] });
      }
      case "cancel-all": st.orders = []; return ok({});
      case "market": {
        if (f.marketBuyUnknown && !r.includes("--tp")) return err("EXCHANGE_ERROR", "gateway timeout");
        st.pos += Number(r[2]);
        return ok({ orderId: id(), status: "filled", finality: "final", filledSize: r[2], verifiedFilledSize: r[2], tpsl: { method: "positionLevel" } });
      }
      case "tpsl": return Number(flag(r, "--tp")) < 2700 ? err("INVALID_PARAMS", "TP below mark on a long") : ok({ method: "positionLevel", legs: [] });
      case "stop": {
        const o = { orderId: id(), symbol: r[0], side: r[1], price: r[3], size: r[2], type: "stop", filled: "0" };
        st.orders.push(o);
        return ok({ orderId: o.orderId, reduceOnly: true });
      }
      case "reduce": { const d = st.pos / 2; st.pos -= d; return ok({ sizeReduced: String(d) }); }
      case "close": if (st.pos === 0) return err("POSITION_NOT_FOUND"); st.pos = 0; return ok({});
      case "flatten": st.orders = []; st.pos = 0; return ok({});
      case "spot-balance": return ok({ balances: [
        { token: "USDC", available: st.spotUsdc.toFixed(6), total: st.spotUsdc.toFixed(6) },
        ...(st.spotSol > 0 ? [{ token: "SOL", available: String(st.spotSol), total: String(st.spotSol) }] : []),
      ] });
      case "spot-transfer": {
        const amt = Number(r[1]) * (r[0] === "to-spot" ? 1 : -1);
        st.perpAvail -= amt; st.spotUsdc += amt;
        return ok({ execution: { method: "transfer" } });
      }
      case "spot-buy": st.spotSol += Number(r[1]); st.spotUsdc -= Number(r[1]) * 120; return ok({ order: { status: "filled", finality: "final", filledSize: r[1] } });
      case "spot-sell": st.spotSol = Number((st.spotSol - Number(r[1])).toFixed(6)); st.spotUsdc += Number(r[1]) * 120; return ok({ order: { status: "filled", finality: "final", filledSize: r[1] } });
      case "spot-limit": { const o = { orderId: id() }; st.spotOrders.push(o); return ok({ order: { orderId: o.orderId, status: "open", finality: "final" } }); }
      case "spot-orders": return ok({ orders: f.hideSpotOrders ? [] : st.spotOrders });
      case "spot-cancel": {
        const i = st.spotOrders.findIndex(x => x.orderId === r[1]);
        if (i === -1) return err("ORDER_NOT_FOUND");
        st.spotOrders.splice(i, 1);
        return ok({});
      }
      default: throw new Error(`fake CLI: unhandled ${a.join(" ")}`);
    }
  };
  return { st, run };
}

/** Public spot data of the fake venue (Pacifica shapes): one SOL-USDC market, $10 minimum, two-sided book at 120. */
function fakeFetch(url: string | URL | Request): Promise<Response> {
  const u = String(url);
  const json = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200 }));
  if (u.endsWith("/info")) return json({ data: [{ instrument_type: "spot", symbol: "SOL-USDC", base_asset: "SOL", lot_size: "0.001", min_order_size: "10" }] });
  if (u.endsWith("/info/prices")) return json({ data: [{ symbol: "SOL-USDC", mark: "120", volume_24h: "1000" }] });
  if (u.includes("/book?symbol=")) return json({ data: { l: [[{ p: "119.9" }], [{ p: "120.1" }]] } });
  return Promise.reject(new Error(`fake fetch: unexpected ${u}`));
}

async function simulate(faults: Partial<Faults> = {}) {
  const venue = fakeVenue(faults);
  h.cli.run = venue.run;
  const opts = parseArgs(["--venue", "pacifica", "--network", "testnet", "--phase", "trade,spot", "--yes-testnet", "--max-usd", "30", "--leverage", "5", "--pace-ms", "1"]);
  const report: RunReport = {
    tool: "perp-e2e", version: 1, startedAt: new Date().toISOString(), finishedAt: null, venue: opts.venue, cliVenue: "pacifica", dex: null, network: opts.network,
    phases: opts.phases, dryRun: false, operatorAuthorized: false, cliVersion: null, gitCommit: null, options: {}, market: null, sizing: null, hip3: null,
    capabilities: null, prerequisites: [], steps: [], designItems: {}, stopReason: null, cleanup: [], result: "pass",
  };
  const refused = await runLeg(opts, report, null);
  const outcome = (id: string) => report.steps.find(s => s.id === id)?.outcome ?? null;
  return { report, refused, st: venue.st, outcome };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("simulated run at --max-usd 30, unit ≈ $15", () => {
  it("trade + spot pass: the edit is valued as a replacement, nothing is left open", async () => {
    const { report, refused, st, outcome } = await simulate();
    expect(refused).toBeNull();
    expect(report.stopReason).toBeNull();
    expect(report.result).toBe("pass");
    expect(report.steps.filter(s => s.outcome === "fail" || s.outcome === "stopped")).toEqual([]);
    expect((report.sizing as { unitNotional: number; marginNeededAtPeakUsd: number }).unitNotional).toBeCloseTo(15.12, 2);
    expect((report.sizing as { marginNeededAtPeakUsd: number }).marginNeededAtPeakUsd).toBeCloseTo((15.12 * 2) / 5, 2);
    // Every order-placing step ran under the $30 cap (none skipped).
    for (const id of ["t-limit-gtc", "t-edit", "t-edit-check", "t-cancel", "t-limit-alo", "t-entry-tpsl", "t-market-buy", "t-market-buy-2", "t-limit-sell-far", "t-flatten",
      "s-buy", "s-sell", "s-limit", "s-orders", "s-cancel", "s-limit-alo", "s-cancel-alo", "s-transfer-out"]) {
      expect(outcome(id), id).not.toBe("skipped");
      expect(outcome(id), id).not.toBeNull();
    }
    expect(st.writes).toContain("leverage ETH 5");
    // Spot order: buy → sell → far limit (the limit reuses the sell proceeds: 1.05 × notional moved in).
    const ids = report.steps.map(s => s.id);
    expect(ids.indexOf("s-buy")).toBeLessThan(ids.indexOf("s-sell"));
    expect(ids.indexOf("s-sell")).toBeLessThan(ids.indexOf("s-limit"));
    expect(st.writes).toContain("spot-transfer to-spot 15.75"); // 1.05 × the $15 spot order
    // Venue is clean.
    expect(st.orders).toEqual([]);
    expect(st.spotOrders).toEqual([]);
    expect(st.pos).toBe(0);
    expect(st.spotSol).toBe(0);
    expect(st.spotUsdc).toBeLessThan(0.01);
  });

  it("steps over the cap are skipped WITH their dependents — the run does not fail and leaves nothing open", async () => {
    // $18 already open on another symbol: every $15 order would exceed the $30 cap.
    const { report, st, outcome } = await simulate({ otherPosition: true });
    expect(report.stopReason).toBeNull();
    expect(report.result).toBe("pass");
    expect(report.steps.filter(s => s.outcome === "fail" || s.outcome === "stopped")).toEqual([]);
    for (const id of ["t-limit-gtc", "t-edit", "t-cancel", "t-limit-alo", "t-cancel-alo", "t-entry-tpsl", "t-tpsl-crossed", "t-close-1", "t-market-buy", "t-stop", "t-cancel-stop", "t-tpsl", "t-reduce", "t-close-2",
      "s-buy", "s-sell", "s-limit", "s-orders", "s-cancel"]) {
      expect(outcome(id), id).toBe("skipped");
    }
    for (const id of ["t-orders-gtc-check", "t-edit-check", "t-cancel-check", "t-entry-pos-check", "t-stop-visible"]) expect(outcome(id), id).toBeNull();
    expect(report.steps.find(s => s.id === "t-edit")?.note).toMatch(/prerequisite t-limit-gtc was skipped/);
    // No order, position or spot write was sent; the quote moved to spot came back.
    expect(st.writes.filter(w => /^(limit|market|edit|stop|spot-buy|spot-sell|spot-limit) /.test(w))).toEqual([]);
    expect(outcome("s-transfer-out")).toBe("pass");
    expect(st.spotUsdc).toBeLessThan(0.01);
    expect(st.pos).toBe(0);
  });

  it("a failed check after the edit → cleanup cancels the resting order this run placed", async () => {
    const { report, st, outcome } = await simulate({ brokenEdit: true });
    expect(report.result).toBe("fail");
    expect(report.stopReason).toMatch(/edited order does not show/);
    expect(outcome("c-cancel-all")).toBe("observed");
    expect(outcome("c-done")).toBe("observed");
    expect(st.orders).toEqual([]);
    expect(st.pos).toBe(0);
  });

  it("a failed spot check → cleanup cancels the spot order and moves the quote back", async () => {
    const { report, st, outcome } = await simulate({ hideSpotOrders: true });
    expect(report.result).toBe("fail");
    expect(report.stopReason).toMatch(/s-orders/);
    expect(report.steps.some(s => s.id.startsWith("c-spot-cancel-") && s.outcome === "observed")).toBe(true);
    expect(outcome("c-spot-transfer-out")).toBe("observed");
    expect(st.spotOrders).toEqual([]);
    expect(st.spotSol).toBe(0);
    expect(st.spotUsdc).toBeLessThan(0.01);
  });

  it("an UNKNOWN write outcome stops the run and sends nothing more (no cleanup writes)", async () => {
    const { report, st } = await simulate({ marketBuyUnknown: true });
    expect(report.result).toBe("stopped");
    expect(report.stopReason).toMatch(/t-market-buy: EXCHANGE_ERROR is not a definite rejection/);
    expect(report.steps.filter(s => s.phase === "cleanup")).toEqual([]);
    expect(st.writes[st.writes.length - 1]).toMatch(/^market ETH buy /);
  });
});
