import { describe, expect, it } from "vitest";
import { fetchAllBalances } from "../rebalance.js";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter, ExchangeBalance } from "../exchanges/interface.js";

/**
 * Regression coverage for the Rule #2 guard added in ed533cb at
 * src/rebalance.ts:44-77. A NaN/Infinity venue balance must reject the
 * affected adapter's branch of `Promise.allSettled` so the rebalance
 * plan never sums corrupt inputs. Remaining adapters must still produce
 * fulfilled snapshots — partial result, not all-or-nothing.
 */

function makeAdapter(name: string, bal: ExchangeBalance | (() => Promise<ExchangeBalance>)): ExchangeAdapter {
  return {
    name,
    getBalance: typeof bal === "function" ? bal : async () => bal,
  } as unknown as ExchangeAdapter;
}

const CLEAN: ExchangeBalance = {
  equity: "1000",
  available: "800",
  marginUsed: "200",
  unrealizedPnl: "0",
};

describe("rebalance.fetchAllBalances — non-finite balance guard (Rule #2)", () => {
  it("returns clean snapshots when every adapter reports finite values", async () => {
    const adapters = new Map<string, ExchangeAdapter>([
      ["hyperliquid", makeAdapter("hyperliquid", CLEAN)],
      ["pacifica", makeAdapter("pacifica", { ...CLEAN, equity: "500" })],
      ["lighter", makeAdapter("lighter", { ...CLEAN, equity: "250" })],
    ]);

    const snaps = await fetchAllBalances(adapters);
    expect(snaps).toHaveLength(3);
    expect(snaps.map((s) => s.exchange).sort()).toEqual(["hyperliquid", "lighter", "pacifica"]);
    expect(snaps.find((s) => s.exchange === "hyperliquid")).toEqual({
      exchange: "hyperliquid",
      equity: 1000,
      available: 800,
      marginUsed: 200,
      unrealizedPnl: 0,
    });
  });

  it("drops the adapter that returns NaN equity, keeps the others (partial result, not all-or-nothing)", async () => {
    const adapters = new Map<string, ExchangeAdapter>([
      ["hyperliquid", makeAdapter("hyperliquid", CLEAN)],
      // venue returns "NaN" / "" / "null" → Number(...) == NaN
      ["aster", makeAdapter("aster", { ...CLEAN, equity: "NaN" })],
      ["pacifica", makeAdapter("pacifica", { ...CLEAN, equity: "500" })],
    ]);

    const snaps = await fetchAllBalances(adapters);
    expect(snaps).toHaveLength(2);
    expect(snaps.map((s) => s.exchange).sort()).toEqual(["hyperliquid", "pacifica"]);
    expect(snaps.find((s) => s.exchange === "aster")).toBeUndefined();
  });

  it("rejects on Infinity / -Infinity / non-numeric strings / empty strings for any of the 4 balance fields", async () => {
    const cases: { label: string; bal: ExchangeBalance }[] = [
      { label: "equity Infinity", bal: { ...CLEAN, equity: "Infinity" } },
      { label: "available -Infinity", bal: { ...CLEAN, available: "-Infinity" } },
      { label: "marginUsed garbage", bal: { ...CLEAN, marginUsed: "abc" } },
      { label: "unrealizedPnl garbage", bal: { ...CLEAN, unrealizedPnl: "garbage" } },
      // qa/2026-05-16 strict policy: empty venue field is corruption.
      // Number("") === 0 in JS would silently pass the finiteness check and
      // surface a phantom $0 balance in the plan — closed by the explicit
      // `=== ""` rejection at rebalance.ts:55-60.
      { label: "equity empty string", bal: { ...CLEAN, equity: "" } },
      { label: "available empty string", bal: { ...CLEAN, available: "" } },
      { label: "marginUsed empty string", bal: { ...CLEAN, marginUsed: "" } },
      { label: "unrealizedPnl empty string", bal: { ...CLEAN, unrealizedPnl: "" } },
    ];

    for (const { label, bal } of cases) {
      const adapters = new Map<string, ExchangeAdapter>([
        ["hyperliquid", makeAdapter("hyperliquid", CLEAN)],
        ["bad", makeAdapter("bad", bal)],
      ]);
      const snaps = await fetchAllBalances(adapters);
      expect(snaps, label).toHaveLength(1);
      expect(snaps[0]?.exchange, label).toBe("hyperliquid");
    }
  });

  it("returns an empty array when every adapter reports non-finite balance (degenerate input → empty plan, not crash)", async () => {
    const adapters = new Map<string, ExchangeAdapter>([
      ["a", makeAdapter("a", { ...CLEAN, equity: "NaN" })],
      ["b", makeAdapter("b", { ...CLEAN, available: "Infinity" })],
    ]);
    const snaps = await fetchAllBalances(adapters);
    expect(snaps).toEqual([]);
  });

  it("the rejection inside Promise.allSettled is a PerpError(EXCHANGE_ERROR) tagged with the exchange name", async () => {
    // Direct shape assertion — the adapter mapping inside fetchAllBalances
    // throws PerpError("EXCHANGE_ERROR", ..., { exchange: name }) so the
    // structured envelope downstream consumers see is exchange-attributed.
    const throwingMap = async () => {
      const bal: ExchangeBalance = { ...CLEAN, equity: "NaN" };
      const equity = Number(bal.equity);
      const available = Number(bal.available);
      const marginUsed = Number(bal.marginUsed);
      const unrealizedPnl = Number(bal.unrealizedPnl);
      if (!Number.isFinite(equity) || !Number.isFinite(available) ||
          !Number.isFinite(marginUsed) || !Number.isFinite(unrealizedPnl)) {
        throw new PerpError(
          "EXCHANGE_ERROR",
          `aster returned non-finite balance: equity=${bal.equity} available=${bal.available} marginUsed=${bal.marginUsed} unrealizedPnl=${bal.unrealizedPnl}`,
          { exchange: "aster" },
        );
      }
    };

    await expect(throwingMap()).rejects.toBeInstanceOf(PerpError);
    try {
      await throwingMap();
    } catch (e) {
      const err = e as PerpError;
      expect(err.structured.code).toBe("EXCHANGE_ERROR");
      // PerpError lifts `remediation` to top-level but leaves the rest of
      // `details` in `structured.details` (see errors.ts:194-199), so the
      // exchange tag lives at `structured.details.exchange`.
      expect((err.structured.details as { exchange?: string } | undefined)?.exchange).toBe("aster");
      expect(err.message).toMatch(/non-finite balance/);
    }
  });

  it("propagates adapter.getBalance() throw via Promise.allSettled — unrelated to the new guard but pinned for completeness", async () => {
    const adapters = new Map<string, ExchangeAdapter>([
      ["hyperliquid", makeAdapter("hyperliquid", CLEAN)],
      ["lighter", makeAdapter("lighter", async () => { throw new Error("network down"); })],
    ]);
    const snaps = await fetchAllBalances(adapters);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.exchange).toBe("hyperliquid");
  });
});
