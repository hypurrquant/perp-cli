/**
 * Arcus CLI reads (audit 0.15.0):
 *  T4. An OFFLINE market (F-USD …) was SYMBOL_NOT_FOUND on `info` but `trades` / `funding` /
 *      `kline` answered ok [] and `book` / `mid` ORDER_NOT_FOUND 404. Every market-data read of a
 *      non-ONLINE market now refuses with one SYMBOL_NOT_FOUND naming the status, before a request.
 *  T2. `--limit` above 1000 was silently capped at 1000 for trades and funding; now INVALID_PARAMS.
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { ArcusAdapter } from "../../exchanges/arcus/adapter.js";

const MARKET = (status: string) => ({ marketDisplayName: "F-USD", marketId: 11, status, baseAsset: "F", quoteAsset: "USD", tickSize: "0.01", stepSize: "0.0000001", tickTiers: null });

function adapter(status: string) {
  const get = vi.fn(async () => ({ trades: [], fundingRates: [], bids: [], asks: [], candles: [] }));
  const a = Object.create(ArcusAdapter.prototype) as ArcusAdapter;
  Object.assign(a as object, { market: vi.fn(async () => MARKET(status)), client: { get } });
  return { a, get };
}

describe("Arcus OFFLINE market reads", () => {
  it.each([
    ["book", (a: ArcusAdapter) => a.getOrderbook("F")],
    ["trades", (a: ArcusAdapter) => a.getRecentTrades("F", 10)],
    ["funding", (a: ArcusAdapter) => a.getFundingHistory("F", 10)],
    ["kline", (a: ArcusAdapter) => a.getKlines("F", "1h", 0, 3_600_000)],
  ])("%s → SYMBOL_NOT_FOUND naming OFFLINE, no request", async (_n, read) => {
    const { a, get } = adapter("OFFLINE");
    await expect(read(a)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", message: expect.stringContaining("OFFLINE") }) });
    expect(get).not.toHaveBeenCalled();
  });

  it("an ONLINE market still reads", async () => {
    const { a, get } = adapter("ONLINE");
    await a.getRecentTrades("F", 10);
    expect(get).toHaveBeenCalled();
  });
});

describe("Arcus history limits", () => {
  it("above 1000 → INVALID_PARAMS (was silently 1000)", async () => {
    const { a, get } = adapter("ONLINE");
    await expect(a.getRecentTrades("F", 1001)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
    await expect(a.getFundingHistory("F", 5000)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) });
    expect(get).not.toHaveBeenCalled();
  });
});
