/**
 * 0.15.1 review follow-ups: strict spot-perp price estimate (no 0 / NaN sizing), whitelist read
 * errors keep their code, Aster's empty-result guard under the exact-case listsSymbol.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPriceEstimate } from "../bot/strategies/funding-arb-utils.js";
import { computeMatchedSize, computeSpotPerpMatchedSize } from "../arb-sizing.js";
import { readDepositWhitelist } from "../exchanges/pacifica-vaults.js";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

afterEach(() => vi.restoreAllMocks());

const withMarkets = (rows: Array<{ symbol: string; markPrice: string }>, fail?: Error) =>
  ({ getMarkets: vi.fn(async () => { if (fail) throw fail; return rows; }) }) as unknown as ExchangeAdapter;

describe("getPriceEstimate", () => {
  it("a positive finite mark → the number", async () => {
    await expect(getPriceEstimate(withMarkets([{ symbol: "BTC", markPrice: "82387.1" }]), "BTC", "BTC")).resolves.toBe(82387.1);
  });
  it("not listed → null; Pacifica's \"-\" mark / 0 → null (never NaN or 0)", async () => {
    await expect(getPriceEstimate(withMarkets([{ symbol: "ETH", markPrice: "1" }]), "BTC", "BTC")).resolves.toBeNull();
    await expect(getPriceEstimate(withMarkets([{ symbol: "BTC", markPrice: "-" }]), "BTC", "BTC")).resolves.toBeNull();
    await expect(getPriceEstimate(withMarkets([{ symbol: "BTC", markPrice: "0" }]), "BTC", "BTC")).resolves.toBeNull();
  });
  it("a failed market read propagates (was swallowed as 0)", async () => {
    const err = new PerpError("RATE_LIMITED", "429");
    await expect(getPriceEstimate(withMarkets([], err), "BTC", "BTC")).rejects.toBe(err);
  });
});

describe("sizing never returns a \"NaN\" size", () => {
  it("NaN / Infinity price → null", () => {
    expect(computeSpotPerpMatchedSize(100, Number("-"), "hyperliquid", "pacifica")).toBeNull();
    expect(computeSpotPerpMatchedSize(100, Infinity, "hyperliquid", "pacifica")).toBeNull();
    expect(computeMatchedSize(100, Number.NaN, "hyperliquid", "pacifica")).toBeNull();
  });
});

describe("Pacifica deposit whitelist read (unofficial endpoint)", () => {
  it("unreadable → { addresses: null, error: <code> }, never a bare null", async () => {
    const c = { getEnvelope: vi.fn(async () => { throw new PerpError("RATE_LIMITED", "429 Too Many Requests"); }) };
    await expect(readDepositWhitelist(c as never, "vault")).resolves.toEqual({ addresses: null, error: "RATE_LIMITED" });
  });
  it("readable → the addresses, error null", async () => {
    const c = { getEnvelope: vi.fn(async () => ({ success: true, data: { addresses: ["a"] } })) };
    await expect(readDepositWhitelist(c as never, "vault")).resolves.toEqual({ addresses: ["a"], error: null });
  });
});

describe("Aster funding: a lower-case caller still passes the exact-case guard", () => {
  it("\"btc\" with an empty answer and BTC listed → [] (not SYMBOL_NOT_FOUND)", async () => {
    const { AsterAdapter } = await import("../exchanges/aster.js");
    const a = new AsterAdapter(undefined, false);
    (a as unknown as Record<string, unknown>)._publicGet = vi.fn(async () => []);
    (a as unknown as Record<string, unknown>).getMarkets = vi.fn(async () => [{ symbol: "BTC" }]);
    await expect(a.getFundingHistory("btc")).resolves.toEqual([]);
  });
});

// Keep the recorded Lighter directory honest: it is the source the REST / WS / public-data tests share.
it("recorded Lighter details carry the static metadata the public-data path validates", () => {
  const f = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/lighter/markets-live.json"), "utf8")) as { lighter: { orderBookDetails: { order_book_details: Array<Record<string, unknown>> } } };
  expect(f.lighter.orderBookDetails.order_book_details.every((d) => Number.isInteger(d.price_decimals) && typeof d.min_base_amount === "string")).toBe(true);
});
