/**
 * Regression guard: PacificaAdapter.getPositions must not fabricate 1x leverage.
 *
 * /positions has no reliable leverage field and default-leverage positions are blank
 * in /account/settings, so the old `?? 1` showed every default-leverage position as
 * 1x and made marginRequired = notional/leverage wrong. Leverage is now derived from
 * the position's own margin (entry-notional / margin), preferring an explicit API
 * leverage when present.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";

async function build(positions: Array<Record<string, unknown>>, prices: Array<{ symbol: string; mark: string }>) {
  const pac = new PacificaAdapter(Keypair.generate(), "mainnet");
  (pac as unknown as { client: unknown }).client = { setRequestAgentWallet: vi.fn() };
  (pac as unknown as { _getPositions: () => Promise<unknown> })._getPositions = vi.fn().mockResolvedValue(positions);
  (pac as unknown as { _getPrices: () => Promise<unknown> })._getPrices = vi.fn().mockResolvedValue(prices);
  return pac;
}

describe("PacificaAdapter.getPositions — leverage (no fabricated 1x)", () => {
  it("derives effective leverage from margin when the API omits leverage (60000/3000 = 20x)", async () => {
    const pac = await build(
      [{ symbol: "BTC", side: "bid", amount: "1", entry_price: "60000", margin: "3000", mark_price: "60000", unrealized_pnl: "0", liquidation_price: "50000" }],
      [{ symbol: "BTC", mark: "60000" }],
    );
    const pos = await pac.getPositions();
    expect(pos[0].leverage).toBe(20);
  });

  it("prefers an explicit API leverage over the margin-derived value when present", async () => {
    // margin 300 → derived would be 3000*2/300 = 20x, but the API says 10x → use 10x.
    const pac = await build(
      [{ symbol: "ETH", side: "ask", amount: "2", entry_price: "3000", margin: "300", leverage: 10, mark_price: "3000", unrealized_pnl: "0", liquidation_price: "3300" }],
      [{ symbol: "ETH", mark: "3000" }],
    );
    const pos = await pac.getPositions();
    expect(pos[0].leverage).toBe(10);
  });

  it("reads the legacy margin_used field name when margin is absent", async () => {
    const pac = await build(
      [{ symbol: "SOL", side: "bid", amount: "10", entry_price: "150", margin_used: "300", mark_price: "150", unrealized_pnl: "0", liquidation_price: "120" }],
      [{ symbol: "SOL", mark: "150" }],
    );
    const pos = await pac.getPositions();
    expect(pos[0].leverage).toBe(5); // 150*10/300 = 5x
  });
});

/**
 * Cross positions carry no `margin` — the spec documents it as "only shown when
 * isolated" — so the margin derivation collapses to 0 and the old chain fell
 * through to a fabricated 1x on the MOST COMMON case. The documented default for
 * a cross position is the market's max leverage (get-account-settings.md: margin
 * settings "default to cross margin and leverage default to max ... will return
 * blank"), so that is what fills the gap now.
 */
describe("PacificaAdapter.getPositions — cross-margin leverage default", () => {
  const buildWithMarkets = async (
    positions: Array<Record<string, unknown>>,
    prices: Array<{ symbol: string; mark: string }>,
    markets: Array<{ symbol: string; maxLeverage: number }> | Error,
  ) => {
    const pac = await build(positions, prices);
    const getMarkets = markets instanceof Error
      ? vi.fn().mockRejectedValue(markets)
      : vi.fn().mockResolvedValue(markets);
    (pac as unknown as { getMarkets: () => Promise<unknown> }).getMarkets = getMarkets;
    return { pac, getMarkets };
  };

  it("uses the market max leverage for a cross position with margin '0'", async () => {
    const { pac } = await buildWithMarkets(
      [{ symbol: "BTC", side: "bid", amount: "1", entry_price: "60000", margin: "0", isolated: false, mark_price: "60000", unrealized_pnl: "0", liquidation_price: "50000" }],
      [{ symbol: "BTC", mark: "60000" }],
      [{ symbol: "BTC", maxLeverage: 40 }],
    );
    const pos = await pac.getPositions();
    expect(pos[0].leverage).toBe(40);
  });

  it("does NOT fetch markets when every position already resolved its leverage", async () => {
    // An isolated position derives from its own margin, so the extra call must
    // not happen — a positions read should not depend on market info when it
    // does not need to.
    const { pac, getMarkets } = await buildWithMarkets(
      [{ symbol: "BTC", side: "bid", amount: "1", entry_price: "60000", margin: "3000", isolated: true, mark_price: "60000", unrealized_pnl: "0", liquidation_price: "50000" }],
      [{ symbol: "BTC", mark: "60000" }],
      [{ symbol: "BTC", maxLeverage: 40 }],
    );
    const pos = await pac.getPositions();
    expect(pos[0].leverage).toBe(20);
    expect(getMarkets).not.toHaveBeenCalled();
  });

  it("falls back to 1 only when the market carries no max leverage", async () => {
    const { pac } = await buildWithMarkets(
      [{ symbol: "WIF", side: "bid", amount: "1", entry_price: "2", margin: "0", isolated: false, mark_price: "2", unrealized_pnl: "0", liquidation_price: "1" }],
      [{ symbol: "WIF", mark: "2" }],
      [],
    );
    const pos = await pac.getPositions();
    expect(pos[0].leverage).toBe(1);
  });

  it("surfaces a markets fetch failure instead of silently defaulting to 1x", async () => {
    // Rule #2: when the value IS needed and cannot be obtained, fail rather
    // than fabricate.
    const { pac } = await buildWithMarkets(
      [{ symbol: "BTC", side: "bid", amount: "1", entry_price: "60000", margin: "0", isolated: false, mark_price: "60000", unrealized_pnl: "0", liquidation_price: "50000" }],
      [{ symbol: "BTC", mark: "60000" }],
      new Error("markets unavailable"),
    );
    await expect(pac.getPositions()).rejects.toThrow(/markets unavailable/);
  });
});
