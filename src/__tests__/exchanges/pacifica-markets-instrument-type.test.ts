/**
 * PacificaAdapter.getMarkets lists only GET /info rows with instrument_type "perpetual"
 * (docs.pacifica.fi get-market-info; live mainnet 2026-10-18: 77 "perpetual" + 1 "spot" SOL-USDC).
 * A row without instrument_type cannot be classified → EXCHANGE_ERROR (no guess).
 */
import { describe, it, expect, vi } from "vitest";
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import { PerpError } from "../../errors.js";

type Internals = { client: PacificaAdapter["client"] };

function adapterWith(info: Array<Record<string, unknown>>): PacificaAdapter {
  const a = Object.create(PacificaAdapter.prototype) as PacificaAdapter;
  (a as unknown as Internals).client = {
    getInfo: vi.fn().mockResolvedValue(info),
    getPrices: vi.fn().mockResolvedValue([{ symbol: "BTC", mark: "100", oracle: "100", volume_24h: "1", open_interest: "2" }]),
  } as unknown as Internals["client"];
  return a;
}

const row = (symbol: string, instrument_type?: string) => ({
  symbol, lot_size: "0.001", max_leverage: 10, funding_rate: "0", next_funding_rate: "0",
  ...(instrument_type === undefined ? {} : { instrument_type }),
});

describe("Pacifica getMarkets: instrument_type", () => {
  it("keeps perpetual rows; spot and any other type are not perps", async () => {
    const markets = await adapterWith([row("BTC", "perpetual"), row("SOL-USDC", "spot"), row("X", "dated_future")]).getMarkets();
    expect(markets.map((m) => m.symbol)).toEqual(["BTC"]);
  });

  it("a row without instrument_type → EXCHANGE_ERROR naming the row", async () => {
    const p = adapterWith([row("BTC", "perpetual"), row("ETH")]).getMarkets();
    await expect(p).rejects.toBeInstanceOf(PerpError);
    await expect(p).rejects.toMatchObject({ message: expect.stringContaining("ETH has no instrument_type") });
  });
});
