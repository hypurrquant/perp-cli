/**
 * Adapter-shape regression for PacificaAdapter.getBalance / getPositions
 * after Phase 2.5 migrated 8 sites to `parseFiniteVenueNumber`
 * (shared util, qa/2026-05-16).
 *
 * Pre-migration, every `Number(... ?? 0)` site silently coerced NaN /
 * empty-string / non-numeric venue payloads to 0 — phantom $0 balance
 * or zero-size position indistinguishable from real empty state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

async function buildAdapter(opts: {
  account?: Record<string, unknown>;
  positions?: Array<Record<string, unknown>>;
  prices?: Array<{ symbol: string; mark: string }>;
}) {
  const { PacificaAdapter } = await import("../../exchanges/pacifica.js");
  const kp = Keypair.generate();
  const pac = new PacificaAdapter(kp, "mainnet");

  const account = opts.account ?? { account_equity: "1000", available_to_spend: "800" };
  const positions = opts.positions ?? [];
  const prices = opts.prices ?? [];

  // Stub the leaf data sources used by getBalance / getPositions
  (pac as unknown as { client: { getAccount: () => Promise<unknown>; getAccountSettings: () => Promise<unknown> } }).client = {
    getAccount: vi.fn().mockResolvedValue(account),
    getAccountSettings: vi.fn().mockResolvedValue([]),
  };
  (pac as unknown as { _getPositions: () => Promise<unknown> })._getPositions =
    vi.fn().mockResolvedValue(positions);
  (pac as unknown as { _getPrices: () => Promise<unknown> })._getPrices =
    vi.fn().mockResolvedValue(prices);
  return pac;
}

describe("PacificaAdapter.getBalance — parseFiniteVenueNumber guards (Phase 2.5)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clean payload returns numeric balance unchanged", async () => {
    const pac = await buildAdapter({
      account: { account_equity: "1000", available_to_spend: "800" },
      positions: [{ symbol: "BTC", side: "bid", amount: "0.5", entry_price: "50000", unrealized_pnl: "100" }],
    });
    const bal = await pac.getBalance();
    expect(bal.equity).toBe("1000");
    expect(bal.available).toBe("800");
    expect(bal.unrealizedPnl).toBe("100.0000");
  });

  it("throws when position.unrealized_pnl is NaN", async () => {
    const pac = await buildAdapter({
      positions: [{ symbol: "BTC", side: "bid", amount: "0.5", entry_price: "50000", unrealized_pnl: "NaN" }],
    });
    await expect(pac.getBalance()).rejects.toThrow(/position.unrealized_pnl.*not a finite/);
  });

  it("throws when position.amount is the empty string '' (qa/2026-05-16 strict policy)", async () => {
    const pac = await buildAdapter({
      positions: [{ symbol: "BTC", side: "bid", amount: "", entry_price: "50000", unrealized_pnl: "0" }],
    });
    await expect(pac.getBalance()).rejects.toThrow(/position.amount.*empty string/);
  });

  it("tags structured.details.exchange = 'pacifica' on the thrown PerpError", async () => {
    const pac = await buildAdapter({
      positions: [{ symbol: "BTC", side: "bid", amount: "Infinity", entry_price: "50000", unrealized_pnl: "0" }],
    });
    try {
      await pac.getBalance();
      expect.fail("expected throw");
    } catch (e) {
      const err = e as { structured: { code: string; details?: { exchange?: string } } };
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      expect(err.structured.details?.exchange).toBe("pacifica");
    }
  });
});

describe("PacificaAdapter.getPositions — parseFiniteVenueNumber guards (Phase 2.5)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clean payload returns positions unchanged", async () => {
    const pac = await buildAdapter({
      positions: [{ symbol: "BTC", side: "bid", amount: "0.5", entry_price: "50000", unrealized_pnl: "0", leverage: 10 }],
      prices: [{ symbol: "BTC", mark: "51000" }],
    });
    const pos = await pac.getPositions();
    expect(pos).toHaveLength(1);
    expect(pos[0].size).toBe("0.5");
    expect(pos[0].side).toBe("long");
  });

  it("throws when position.entry_price is non-numeric", async () => {
    const pac = await buildAdapter({
      positions: [{ symbol: "BTC", side: "bid", amount: "0.5", entry_price: "abc", unrealized_pnl: "0" }],
    });
    await expect(pac.getPositions()).rejects.toThrow(/position.entry_price.*not a finite/);
  });

  it("throws when mark price (from priceMap or position fallback) is non-finite", async () => {
    const pac = await buildAdapter({
      positions: [{ symbol: "BTC", side: "bid", amount: "0.5", entry_price: "50000", unrealized_pnl: "0", mark_price: "NaN" }],
      prices: [],
    });
    await expect(pac.getPositions()).rejects.toThrow(/position.mark.*not a finite/);
  });
});
