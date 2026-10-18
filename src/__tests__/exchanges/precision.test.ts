/**
 * Order-entry precision: sizes floor to the lot, protection prices align
 * TOWARD crossing (buy up / sell down), limit prices off tick are REJECTED (never rounded).
 */
import { describe, it, expect, vi } from "vitest";
import {
  alignProtectionPrice, floorSize, floorToStep, lotStepOf, requireOnTick, slippagePrice,
} from "../../exchanges/precision.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { structured?: { code?: string } }).structured?.code; }
  return undefined;
}

describe("floorSize", () => {
  it("floors to the step (never rounds up)", () => {
    expect(floorSize("0.12999", "0.001")).toBe("0.129");
    expect(floorSize("2.997", "1")).toBe("2");
  });

  it("keeps an on-step size unchanged and normalized", () => {
    expect(floorSize("0.100", "0.001")).toBe("0.1");
    expect(floorSize("100", "0.0001")).toBe("100");
  });

  it("is exact on float-hostile values (0.3 / 0.1 step)", () => {
    expect(floorSize("0.3", "0.1")).toBe("0.3");
    expect(floorSize("1.0000000001", "0.1")).toBe("1");
  });

  it("throws SIZE_TOO_SMALL when the floor is zero", () => {
    expect(code(() => floorSize("0.0009", "0.001"))).toBe("SIZE_TOO_SMALL");
  });

  it("rejects exponent / non-decimal input instead of coercing it", () => {
    expect(code(() => floorSize("1e-3", "0.001"))).toBe("INVALID_PARAMS");
    expect(code(() => floorSize(" 1", "0.001"))).toBe("INVALID_PARAMS");
  });

  it("rejects a non-positive step", () => {
    expect(code(() => floorSize("1", "0"))).toBe("INVALID_PARAMS");
  });
});

describe("alignProtectionPrice — toward crossing", () => {
  it("buy protection rounds UP to the tick (never tighter than the bound)", () => {
    expect(alignProtectionPrice("100.0001", "0.01", "buy")).toBe("100.01");
  });

  it("sell protection rounds DOWN to the tick", () => {
    expect(alignProtectionPrice("99.9999", "0.01", "sell")).toBe("99.99");
  });

  it("an on-tick price is unchanged for both sides", () => {
    expect(alignProtectionPrice("100.5", "0.5", "buy")).toBe("100.5");
    expect(alignProtectionPrice("100.5", "0.5", "sell")).toBe("100.5");
  });

  it("a sell protection that aligns to zero is rejected", () => {
    expect(code(() => alignProtectionPrice("0.004", "0.01", "sell"))).toBe("INVALID_PARAMS");
  });
});

describe("requireOnTick — limit prices are validated, never rounded", () => {
  it("returns an on-tick price normalized", () => {
    expect(requireOnTick("100.50", "0.01")).toBe("100.5");
  });

  it("throws INVALID_TICK for an off-tick price", () => {
    expect(code(() => requireOnTick("100.005", "0.01"))).toBe("INVALID_TICK");
  });

  it("throws INVALID_PARAMS for zero / negative prices", () => {
    expect(code(() => requireOnTick("0", "0.01"))).toBe("INVALID_PARAMS");
    expect(code(() => requireOnTick("-1", "0.01"))).toBe("INVALID_PARAMS");
  });
});

describe("slippagePrice", () => {
  it("buy = mark × (1 + bps), sell = mark × (1 − bps)", () => {
    expect(Number(slippagePrice("100", "buy", 50))).toBeCloseTo(100.5, 10);
    expect(Number(slippagePrice("100", "sell", 50))).toBeCloseTo(99.5, 10);
  });

  it("throws PRICE_STALE on a non-positive / non-finite mark", () => {
    expect(code(() => slippagePrice("0", "buy", 50))).toBe("PRICE_STALE");
    expect(code(() => slippagePrice("NaN", "buy", 50))).toBe("PRICE_STALE");
  });

  it("refuses a sell bound of ≥ 100%", () => {
    expect(code(() => slippagePrice("100", "sell", 10_000))).toBe("INVALID_PARAMS");
  });
});

describe("floorToStep — measured fills", () => {
  it("floors a measured fill onto the lot grid", () => {
    expect(floorToStep(0.12345, "0.01")).toBe("0.12");
  });

  it("absorbs float noise just below a lot multiple", () => {
    expect(floorToStep(0.3 - 1e-12, "0.1")).toBe("0.3");
  });

  it("a fill below one lot floors to zero (callers must treat it as unusable)", () => {
    expect(Number(floorToStep(0.004, "0.01"))).toBe(0);
  });
});

describe("lotStepOf", () => {
  const adapter = (markets: unknown[]) => ({ name: "hyperliquid", getMarkets: vi.fn().mockResolvedValue(markets) }) as unknown as ExchangeAdapter;

  it("uses the market stepSize", async () => {
    await expect(lotStepOf(adapter([{ symbol: "BTC", stepSize: "0.001", sizeDecimals: 5 }]), "btc")).resolves.toBe("0.001");
  });

  it("falls back to 10^-sizeDecimals when stepSize is null", async () => {
    await expect(lotStepOf(adapter([{ symbol: "BTC-PERP", stepSize: null, sizeDecimals: 3 }]), "BTC")).resolves.toBe("0.001");
    await expect(lotStepOf(adapter([{ symbol: "BTC", stepSize: null, sizeDecimals: 0 }]), "BTC")).resolves.toBe("1");
  });

  it("throws EXCHANGE_ERROR when the venue publishes no lot at all (never guesses)", async () => {
    await expect(lotStepOf(adapter([{ symbol: "BTC", stepSize: null, sizeDecimals: null }]), "BTC"))
      .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("matches a bare symbol against the HIP-3 dex-prefixed market (XYZ100 → xyz:XYZ100)", async () => {
    await expect(lotStepOf(adapter([{ symbol: "xyz:XYZ100", stepSize: null, sizeDecimals: 4 }]), "XYZ100")).resolves.toBe("0.0001");
    // An exact match wins over a dex-prefixed one.
    await expect(lotStepOf(adapter([{ symbol: "km:BTC", stepSize: "0.1", sizeDecimals: 1 }, { symbol: "BTC", stepSize: "0.001", sizeDecimals: 3 }]), "BTC")).resolves.toBe("0.001");
  });

  it("refuses a bare symbol listed on more than one dex (never picks one)", async () => {
    await expect(lotStepOf(adapter([{ symbol: "km:US500", stepSize: "0.1", sizeDecimals: 1 }, { symbol: "xyz:US500", stepSize: "0.01", sizeDecimals: 2 }]), "US500"))
      .rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
  });

  it("throws SYMBOL_NOT_FOUND for an unknown market", async () => {
    await expect(lotStepOf(adapter([]), "BTC")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
  });
});
