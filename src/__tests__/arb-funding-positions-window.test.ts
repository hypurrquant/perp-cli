/**
 * `arb scan --positions` "Actual 24h": the funding received / paid over the last 24 h, read for
 * that window — never a capped list filtered to it. A read not proven to cover the 24 h gives
 * actual24h null with the reason in fundingHistoryErrors (never a partial sum). No network: the
 * adapter is a plain object.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExchangeAdapter, ExchangeFundingPayment } from "../exchanges/interface.js";
import { handleFundingPositions } from "../commands/arb.js";

const HOUR = 3_600_000;
const NOW = Date.now();

/** One ETH long on `hyperliquid`; funding reads as given. */
function adapter(funding: Partial<ExchangeAdapter>): ExchangeAdapter {
  return {
    name: "hyperliquid",
    getPositions: vi.fn().mockResolvedValue([
      { symbol: "ETH", side: "long", size: "1", entryPrice: "3500", markPrice: "3500", liquidationPrice: null, unrealizedPnl: "0", leverage: 2 },
    ]),
    getMarkets: vi.fn().mockResolvedValue([{ symbol: "ETH", markPrice: "3500", indexPrice: "3500", fundingRate: "0.0001", fundingHours: 1 }]),
    ...funding,
  } as unknown as ExchangeAdapter;
}

const payments = (n: number): ExchangeFundingPayment[] => Array.from({ length: n }, (_, i) => ({ time: NOW - i * 60_000, symbol: "ETH", payment: "-1" }));

async function run(a: ExchangeAdapter): Promise<{ positions: Array<{ actual24h: { net: number } | null }>; fundingHistoryErrors: Record<string, string> }> {
  let out = "";
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out += args.map(String).join(" ") + "\n"; });
  try {
    await handleFundingPositions(() => true, async () => a, { exchanges: "hyperliquid" });
  } finally {
    log.mockRestore();
  }
  return JSON.parse(out.trim()).data;
}

afterEach(() => vi.restoreAllMocks());

describe("arb scan --positions: Actual 24h covers the 24 h or is null", () => {
  it("a capped list whose rows all fall inside the 24 h (reach not proven): actual24h null, not a partial sum", async () => {
    const res = await run(adapter({ getFundingPayments: vi.fn().mockResolvedValue([{ time: NOW - HOUR, symbol: "ETH", payment: "-1" }]) }));
    expect(res.positions[0].actual24h).toBeNull();
  });

  it("that venue's fundingHistoryErrors says how far back the read reached", async () => {
    const res = await run(adapter({ getFundingPayments: vi.fn().mockResolvedValue([{ time: NOW - HOUR, symbol: "ETH", payment: "-1" }]) }));
    expect(res.fundingHistoryErrors.hyperliquid).toBe(`funding history read back to ${new Date(NOW - HOUR).toISOString()} only — the 24 h total is unknown`);
  });

  it("a windowed read covering the 24 h: every payment counts, past 100 rows", async () => {
    const rows = payments(150);
    const res = await run(adapter({
      getFundingPayments: vi.fn(async (limit = 100) => rows.slice(0, limit)),
      getFundingPaymentsSince: vi.fn().mockResolvedValue({ rows, from: NOW - 25 * HOUR }),
    }));
    expect(res.positions[0].actual24h?.net).toBe(-150);
  });
});
