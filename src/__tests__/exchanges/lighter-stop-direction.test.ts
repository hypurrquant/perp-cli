import { describe, it, expect } from "vitest";
import { classifyTriggerOrderType } from "../../exchanges/lighter.js";

describe("classifyTriggerOrderType — Lighter trigger orderType routing", () => {
  const MARK = 76000;

  describe("STOP_LOSS direction (protective)", () => {
    it("buy with trigger above mark → STOP_LOSS market (2)", () => {
      expect(classifyTriggerOrderType("buy", 80000, MARK, true)).toBe(2);
    });
    it("buy with trigger above mark → STOP_LOSS_LIMIT (3)", () => {
      expect(classifyTriggerOrderType("buy", 80000, MARK, false)).toBe(3);
    });
    it("sell with trigger below mark → STOP_LOSS market (2)", () => {
      expect(classifyTriggerOrderType("sell", 70000, MARK, true)).toBe(2);
    });
    it("sell with trigger below mark → STOP_LOSS_LIMIT (3)", () => {
      expect(classifyTriggerOrderType("sell", 70000, MARK, false)).toBe(3);
    });
  });

  describe("TAKE_PROFIT direction (target)", () => {
    it("buy with trigger below mark → TAKE_PROFIT market (4)", () => {
      expect(classifyTriggerOrderType("buy", 60000, MARK, true)).toBe(4);
    });
    it("buy with trigger below mark → TAKE_PROFIT_LIMIT (5)", () => {
      expect(classifyTriggerOrderType("buy", 60000, MARK, false)).toBe(5);
    });
    it("sell with trigger above mark → TAKE_PROFIT market (4)", () => {
      expect(classifyTriggerOrderType("sell", 90000, MARK, true)).toBe(4);
    });
    it("sell with trigger above mark → TAKE_PROFIT_LIMIT (5)", () => {
      expect(classifyTriggerOrderType("sell", 90000, MARK, false)).toBe(5);
    });
  });

  describe("tie-at-mark cases (protective default)", () => {
    it("buy with trigger == mark → STOP_LOSS (2)", () => {
      expect(classifyTriggerOrderType("buy", MARK, MARK, true)).toBe(2);
    });
    it("sell with trigger == mark → STOP_LOSS (2)", () => {
      expect(classifyTriggerOrderType("sell", MARK, MARK, true)).toBe(2);
    });
  });

  it("never returns 0 or 1 (regular orderType — WASM signer rejects with triggerPrice)", () => {
    const allCases: Array<[("buy"|"sell"), number, boolean]> = [
      ["buy", 1, true], ["buy", 1, false],
      ["buy", 1e9, true], ["buy", 1e9, false],
      ["sell", 1, true], ["sell", 1, false],
      ["sell", 1e9, true], ["sell", 1e9, false],
    ];
    for (const [side, trigger, isMarket] of allCases) {
      const t = classifyTriggerOrderType(side, trigger, MARK, isMarket);
      expect([2, 3, 4, 5]).toContain(t);
    }
  });
});
