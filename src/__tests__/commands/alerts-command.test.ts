import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import "../../exchanges/venues/index.js";
import { listVenuesWithRole, type VenueDefinition } from "../../exchanges/venue.js";
import type { VenueFundingRate } from "../../exchanges/venue-types.js";

// In-memory settings: alert rules only, no messaging service configured.
const store: { alerts: { rules: Array<Record<string, unknown>>; intervalSec: number; cooldownMin: number; telegram?: { botToken: string; chatId: string } } } = {
  alerts: { rules: [], intervalSec: 300, cooldownMin: 60 },
};
vi.mock("../../settings.js", () => ({
  loadSettings: () => store,
  saveSettings: () => {},
}));
const { sent } = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("../../telegram.js", async (orig) => ({
  ...(await orig<typeof import("../../telegram.js")>()),
  sendTelegramMessage: vi.fn(async (_cfg: unknown, msg: string) => { sent.push(msg); }),
}));

const { registerAlertCommands } = await import("../../commands/alerts.js");

/** Root program with the real root `-e, --exchange` option (default pacifica), like the CLI. */
function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.option("-e, --exchange <exchange>", "Exchange", "pacifica");
  p.option("--json", "JSON");
  registerAlertCommands(p, () => true);
  return p;
}

const row = (venue: string, symbol: string, canonical: string, rate: string): VenueFundingRate => ({
  venue: venue as VenueFundingRate["venue"], venueSymbol: symbol, symbol, canonical, rate,
  basis: { kind: "perHours", hours: 1 }, markPrice: "100", nextFundingTime: null,
});
const ROWS: Record<string, VenueFundingRate[]> = {
  ondo: [row("ondo", "XAU", "GOLD", "0.00001")],
  "lighter-rh": [row("lighter-rh", "XAU", "GOLD", "0.00002")],
};

/** The funding comparison the daemon reads: every market-data venue answers ROWS. */
function stubVenues(): void {
  for (const def of listVenuesWithRole("marketData") as VenueDefinition[]) {
    vi.spyOn(def.publicData, "fetchFundingRates").mockResolvedValue(ROWS[def.id] ?? []);
  }
}

beforeEach(() => {
  store.alerts.rules = [];
  delete store.alerts.telegram;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("alerts add --exchange (also the root option)", () => {
  it("stores the venue filter given as --exchange after the subcommand", async () => {
    await program().parseAsync(["node", "perp", "--json", "alerts", "add", "ETH", "50", "--exchange", "hl"]);
    expect(store.alerts.rules[0]).toMatchObject({ symbol: "ETH", exchange: "hyperliquid" });
  });

  it("without --exchange the rule covers every venue — the root default venue is not taken as a filter", async () => {
    await program().parseAsync(["node", "perp", "--json", "alerts", "add", "BTC", "10"]);
    expect(store.alerts.rules[0]).toMatchObject({ symbol: "BTC", exchange: "*" });
  });
});

describe("alerts on venue tickers / aliases (live 2026-11-04: an XAU rule never fired, the comparison row is GOLD)", () => {
  it("alerts add stores a venue ticker as its canonical key (XAU → GOLD)", async () => {
    await program().parseAsync(["node", "perp", "--json", "alerts", "add", "XAU", "30"]);
    expect(store.alerts.rules[0]).toMatchObject({ symbol: "GOLD" });
  });

  it("alerts add reads no funding rate (works offline): the rule is stored with every venue unreachable", async () => {
    const reads = (listVenuesWithRole("marketData") as VenueDefinition[]).map(def => vi.spyOn(def.publicData, "fetchFundingRates").mockRejectedValue(new Error("offline")));
    await program().parseAsync(["node", "perp", "--json", "alerts", "add", "XAU", "30"]);
    expect(store.alerts.rules).toHaveLength(1);
    for (const r of reads) expect(r).not.toHaveBeenCalled();
  });

  it("alerts remove XAU removes the GOLD rule", async () => {
    store.alerts.rules = [{ id: "GOLD-*-1", symbol: "GOLD", exchange: "*", threshold: 30, direction: "above", enabled: true }];
    await program().parseAsync(["node", "perp", "--json", "alerts", "remove", "XAU"]);
    expect(store.alerts.rules).toEqual([]);
  });

  it("the daemon fires a rule stored with a venue ticker (XAU) on the canonical row (GOLD)", async () => {
    store.alerts.rules = [{ id: "XAU-*-1", symbol: "XAU", exchange: "*", threshold: 1, direction: "above", enabled: true }];
    store.alerts.telegram = { botToken: "test-token", chatId: "1" };
    stubVenues();
    sent.length = 0;
    // The foreground daemon never returns: its interval is faked and its SIGINT handler removed after.
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const sigint = process.listeners("SIGINT");
    void program().parseAsync(["node", "perp", "alerts", "start"]);
    try {
      await vi.waitFor(() => expect(sent.some(m => m.startsWith("GOLD funding alert"))).toBe(true));
    } finally {
      for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.off("SIGINT", l);
      vi.useRealTimers();
    }
  });
});

describe("alerts test / start without a messaging service", () => {
  it.each([["test"], ["start"]])("%s → INVALID_PARAMS, never a silent success", async (sub) => {
    await expect(program().parseAsync(["node", "perp", "--json", "alerts", sub])).rejects.toMatchObject({
      structured: { code: "INVALID_PARAMS" },
    });
  });
});
