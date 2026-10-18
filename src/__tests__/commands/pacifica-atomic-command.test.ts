/**
 * `perp -e pacifica trade atomic` — dry run (plan only: nothing signed or sent), live path through
 * a stub adapter, gates, and the uniform refusal on other venues.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../execution-log.js", () => ({ logExecution: vi.fn() }));
vi.mock("../../trade-validator.js", () => ({
  enforceOrderRisk: vi.fn().mockResolvedValue(undefined),
  validateTrade: vi.fn().mockResolvedValue({ valid: true, checks: [], warnings: [], timestamp: "" }),
}));
vi.mock("../../bot/quarantine.js", () => ({ quarantineEntryFor: vi.fn().mockReturnValue(null), quarantineSymbol: vi.fn() }));

import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerTradeCommands } from "../../commands/trade.js";
import { enforceOrderRisk } from "../../trade-validator.js";
import { quarantineEntryFor, quarantineSymbol } from "../../bot/quarantine.js";

const INFO = [
  { symbol: "BTC", lot_size: "0.00001", tick_size: "1", min_order_size: "10", instrument_type: "perpetual" },
  { symbol: "ETH", lot_size: "0.0001", tick_size: "0.1", min_order_size: "10", instrument_type: "perpetual" },
];
const PRICES = [{ symbol: "BTC", mark: "100000" }, { symbol: "ETH", mark: "2500" }];

function makeAdapter(name = "pacifica") {
  const sdk = {
    getInfo: vi.fn().mockResolvedValue(INFO),
    getPrices: vi.fn().mockResolvedValue(PRICES),
    signBatchAction: vi.fn(async (_t: string, p: Record<string, unknown>) => ({ account: "ACCT", signature: "SIG", timestamp: 1, expiry_window: 5000, ...p })),
    batchOrders: vi.fn().mockResolvedValue({ success: true, data: { results: [{ success: true, order_id: 11, error: null }, { success: true, order_id: 12, error: null }] } }),
  };
  return {
    name, sdk, publicKey: "ACCT", isReadOnly: false, activeSignerTier: "pk",
    prepareSigning: vi.fn(),
    builderDecision: vi.fn().mockResolvedValue({ applied: null, note: null }),
    resolveOrderOutcome: vi.fn(async (orderId: string) => ({ status: "filled", final: true, venueStatus: "filled", eventType: null, orderId, filledSize: "1", price: null, size: null, source: "history_by_id" })),
    getPositions: vi.fn().mockResolvedValue([]),
    getMarkets: vi.fn().mockResolvedValue([]),
  };
}

async function run(adapter: ReturnType<typeof makeAdapter>, dryRun: boolean, args: string[]) {
  const program = new Command();
  program.exitOverride();
  addRootSafetyOptions(program).option("--json");
  registerTradeCommands(program, async () => adapter as never, () => true, () => dryRun);
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => { out.push(String(s)); });
  try {
    await program.parseAsync(["node", "perp", "--json", ...(dryRun ? ["--dry-run"] : []), "trade", "atomic", ...args]);
  } finally {
    log.mockRestore();
  }
  return JSON.parse(out[out.length - 1]) as { ok: boolean; data: Record<string, any> };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("trade atomic --dry-run", () => {
  it("returns the plan (sent:false) with the exact batch body; nothing is signed or sent", async () => {
    const a = makeAdapter();
    const j = await run(a, true, ["--long", "BTC:50", "--short", "ETH:50", "--usd", "1000", "--slippage-bps", "30"]);
    expect(a.sdk.signBatchAction).not.toHaveBeenCalled();
    expect(a.sdk.batchOrders).not.toHaveBeenCalled();
    expect(a.prepareSigning).not.toHaveBeenCalled();
    expect(j.data).toMatchObject({ dryRun: true, sent: false, action: "atomic_order", totalUsd: "1000", slippageBps: 30, reduceOnly: false });
    const actions = j.data.request.body.actions as Array<{ type: string; data: Record<string, unknown> }>;
    expect(actions.map(x => [x.type, x.data.symbol, x.data.side, x.data.amount, x.data.slippage_percent, x.data.reduce_only, x.data.signature]))
      .toEqual([["CreateMarket", "BTC", "bid", "0.005", "0.3", false, "<not signed: dry-run>"], ["CreateMarket", "ETH", "ask", "0.2", "0.3", false, "<not signed: dry-run>"]]);
    expect(actions[0].data.account).toBe("ACCT");
    expect(j.data.request.signedMessages[0]).toMatch(/^\{"data":\{"amount":"0.005","client_order_id":"[0-9a-f-]{36}","reduce_only":false,"side":"bid","slippage_percent":"0.3","symbol":"BTC"\},"expiry_window":5000,"timestamp":\d+,"type":"create_market_order"\}$/);
    // Opening legs pass the quarantine + risk gates even in a dry run.
    expect(quarantineEntryFor).toHaveBeenCalledTimes(2);
    expect(enforceOrderRisk).toHaveBeenCalledTimes(2);
  });

  it("an agent signer shows agent_wallet; a configured builder code rides on every leg", async () => {
    const a = makeAdapter();
    a.activeSignerTier = "agent";
    a.builderDecision.mockResolvedValue({ applied: { venue: "pacifica", identity: "MYCODE", feeBps: 1, feeKind: "x" }, note: null });
    const j = await run(a, true, ["--long", "BTC", "--short", "ETH", "--usd", "1000"]);
    for (const x of j.data.request.body.actions) expect(x.data).toMatchObject({ agent_wallet: "<agent wallet public key>", builder_code: "MYCODE" });
  });

  it("--reduce-only checks the positions (read only) and refuses a leg without the opposite position", async () => {
    const a = makeAdapter();
    a.getPositions.mockResolvedValue([{ symbol: "ETH", side: "long", size: "1" }]);
    await expect(run(a, true, ["--long", "BTC", "--short", "ETH", "--usd", "1000", "--reduce-only"])).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(enforceOrderRisk).not.toHaveBeenCalled();
    a.getPositions.mockResolvedValue([{ symbol: "ETH", side: "long", size: "1" }, { symbol: "BTC", side: "short", size: "1" }]);
    const j = await run(a, true, ["--long", "BTC", "--short", "ETH", "--usd", "1000", "--reduce-only"]);
    expect(j.data.request.body.actions.every((x: { data: { reduce_only: boolean } }) => x.data.reduce_only === true)).toBe(true);
  });

  it("a slippage bound outside the venue range → INVALID_PARAMS before any read", async () => {
    const a = makeAdapter();
    await expect(run(a, true, ["--long", "BTC", "--usd", "100", "--slippage-bps", "999999"])).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(a.sdk.getInfo).not.toHaveBeenCalled();
  });
});

describe("trade atomic (live path, stub adapter)", () => {
  it("every leg filled → ok with per-leg outcomes; one batch", async () => {
    const a = makeAdapter();
    const j = await run(a, false, ["--long", "BTC", "--short", "ETH", "--usd", "1000"]);
    expect(a.sdk.signBatchAction).toHaveBeenCalledTimes(2);
    expect(a.sdk.signBatchAction.mock.calls.every(c => c[0] === "create_market_order")).toBe(true);
    expect(a.sdk.batchOrders).toHaveBeenCalledTimes(1);
    expect(j.ok).toBe(true);
    expect(j.data.outcomes.map((o: { orderId: string; status: string }) => [o.orderId, o.status])).toEqual([["11", "filled"], ["12", "filled"]]);
  });

  it("an unconfirmed leg → ORDER_PENDING and that symbol is quarantined (never resubmitted)", async () => {
    const a = makeAdapter();
    a.resolveOrderOutcome.mockImplementation(async (orderId: string) => (orderId === "12" ? null : { status: "filled", final: true, venueStatus: "filled", eventType: null, orderId, filledSize: "1", price: null, size: null, source: "history_by_id" }) as never);
    await expect(run(a, false, ["--long", "BTC", "--short", "ETH", "--usd", "1000"])).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(a.sdk.batchOrders).toHaveBeenCalledTimes(1);
    expect(quarantineSymbol).toHaveBeenCalledTimes(1);
    expect(vi.mocked(quarantineSymbol).mock.calls[0][1]).toBe("ETH");
  });

  it("one leg refused by the venue → ORDER_PARTIAL", async () => {
    const a = makeAdapter();
    a.sdk.batchOrders.mockResolvedValue({ success: true, data: { results: [{ success: true, order_id: 11, error: null }, { success: false, order_id: null, error: "Insufficient margin" }] } });
    await expect(run(a, false, ["--long", "BTC", "--short", "ETH", "--usd", "1000"])).rejects.toMatchObject({ structured: { code: "ORDER_PARTIAL" } });
    expect(quarantineSymbol).not.toHaveBeenCalled();
  });
});

describe("trade atomic on another venue", () => {
  it("→ CAPABILITY_UNSUPPORTED before any read", async () => {
    const a = makeAdapter("hyperliquid");
    await expect(run(a, true, ["--long", "BTC", "--usd", "100"])).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(a.sdk.getInfo).not.toHaveBeenCalled();
  });
});
