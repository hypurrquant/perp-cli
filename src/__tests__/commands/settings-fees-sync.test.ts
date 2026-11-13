/**
 * `perp settings fees sync` saves the venue's own fee answer, never a stale stand-in (SSOT Rule #2):
 * an answer without the rate field saves nothing for that venue and is reported in meta.errors.
 * Real HyperliquidAdapter; only fetch is stubbed. HOME is isolated (helpers/isolate-home.ts); no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerSettingsCommands } from "../../commands/settings.js";
import { loadSettings } from "../../settings.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

// info userFees with the fields settings.ts reads documented (activeReferralDiscount, dailyUserVlm,
// feeSchedule, userCrossRate, userAddRate) — `userCrossRate` left out (a renamed / dropped field).
const USER_FEES_WITHOUT_CROSS_RATE = { activeReferralDiscount: "0.0", dailyUserVlm: [], feeSchedule: { cross: "0.00045", add: "0.00015" }, userAddRate: "0.00015" };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("settings fees sync", () => {
  it("a Hyperliquid userFees answer without userCrossRate saves no fee (no stale 0.035% default) and reports it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const type = (JSON.parse(init.body) as { type: string }).type;
      if (type !== "userFees") throw new Error(`unexpected info ${type}`);
      return new Response(JSON.stringify(USER_FEES_WITHOUT_CROSS_RATE), { status: 200 });
    }));
    const hl = new HyperliquidAdapter(undefined, false);
    hl.setAddress("0xabcdef0000000000000000000000000000000001");
    const program = new Command();
    program.exitOverride();
    program.option("-e, --exchange <exchange>", "Exchange", "hyperliquid");
    registerSettingsCommands(program, () => true, async () => hl as unknown as ExchangeAdapter);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await program.parseAsync(["node", "perp", "-e", "hyperliquid", "settings", "fees", "sync"]);
    const env = JSON.parse(out.join(""));
    expect(env.data.hyperliquid).toBeUndefined();
    expect(env.meta.errors.hyperliquid).toMatchObject({ code: "EXCHANGE_ERROR", message: expect.stringContaining("userCrossRate") });
    expect(loadSettings().fees.hyperliquid).toEqual({ taker: 0.00045, maker: 0.00015 });
  });
});
