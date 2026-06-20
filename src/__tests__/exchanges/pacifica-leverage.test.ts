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
