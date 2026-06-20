/**
 * Regression guard for PacificaAdapter.stopOrder trigger_price_type mapping
 * (qa/2026-06-20 API-drift follow-up).
 *
 * Pacifica's create-stop-order documents an optional `trigger_price_type`
 * (mark_price | last_trade_price | mid_price; default mark_price). The adapter
 * exposes it via a short CLI alias (mark | last | mid) and must map it to the
 * venue value, omitting the field entirely when the caller does not request one
 * so the signed payload stays byte-identical to the venue default.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

async function buildAdapter() {
  const { PacificaAdapter } = await import("../../exchanges/pacifica.js");
  const pac = new PacificaAdapter(Keypair.generate(), "mainnet");
  const createStopOrder = vi.fn().mockResolvedValue({ ok: true });
  (pac as unknown as { client: { createStopOrder: typeof createStopOrder } }).client = {
    createStopOrder,
  } as never;
  return { pac, createStopOrder };
}

type StopParams = { stop_order: { trigger_price_type?: string; stop_price: string; amount: string } };

describe("PacificaAdapter.stopOrder — trigger_price_type mapping", () => {
  it.each([
    ["mark", "mark_price"],
    ["last", "last_trade_price"],
    ["mid", "mid_price"],
  ] as const)("maps triggerType '%s' → '%s'", async (triggerType, expected) => {
    const { pac, createStopOrder } = await buildAdapter();
    await pac.stopOrder("BTC", "buy", "0.1", "60000", { triggerType });
    const params = createStopOrder.mock.calls[0][0] as StopParams;
    expect(params.stop_order.trigger_price_type).toBe(expected);
  });

  it("omits trigger_price_type when triggerType is not provided (venue default)", async () => {
    const { pac, createStopOrder } = await buildAdapter();
    await pac.stopOrder("BTC", "sell", "0.1", "60000", { reduceOnly: true });
    const params = createStopOrder.mock.calls[0][0] as StopParams;
    expect(params.stop_order.trigger_price_type).toBeUndefined();
  });
});
