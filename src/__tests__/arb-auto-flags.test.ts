/**
 * `arb auto` numeric flags (round-2 review): `--cooldown abc` parsed to NaN and silently disabled
 * the cooldown. Every numeric flag is validated before anything runs (also before --background).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../exchanges/venues/index.js";
import { assertArbAutoFlags } from "../commands/arb-auto.js";
import { runCli } from "./conformance/harness.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("arb auto flag validation", () => {
  const bad: Array<[string, string]> = [
    ["--cooldown", "abc"], ["--cooldown", "-1"], ["--min-spread", "x"], ["--close-spread", ""], ["--size", "0"], ["--size", "ten"],
    ["--min-size", "-5"], ["--max-positions", "0"], ["--max-positions", "1.5"], ["--interval", "abc"], ["--hold-days", "0"],
    ["--bridge-cost", "NaN"], ["--min-margin", "x"], ["--max-basis", "0"], ["--min-oi", "-1"], ["--settle-strategy", "later"], ["--min-grade", "Z"],
  ];
  for (const [flag, value] of bad) {
    it(`perp arb auto ${flag} "${value}" → INVALID_PARAMS, nothing sent`, async () => {
      const fetchMock = vi.fn(async () => { throw new Error("I/O before validation"); });
      vi.stubGlobal("fetch", fetchMock);
      const r = await runCli(["arb", "auto", flag, value]);
      expect(r.envelope.ok).toBe(false);
      expect(r.envelope.error?.code, r.envelope.error?.message).toBe("INVALID_PARAMS");
      expect(r.envelope.error?.message).toContain(flag);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
  it("defaults and valid values pass (size auto, cooldown 0, interval 0)", () => {
    expect(() => assertArbAutoFlags({ minSpread: "30", closeSpread: "5", size: "auto", minSize: "30", maxPositions: "5", interval: "0", holdDays: "7", bridgeCost: "0", minMargin: "30", maxBasis: "3", cooldown: "0", minOi: "50000", settleStrategy: "block", minGrade: "c" })).not.toThrow();
  });
});
