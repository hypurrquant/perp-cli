import { describe, it, expect } from "vitest";
import { canonicalizeOwsSignature } from "../../signer/ows-evm.js";

// 64-byte r+s payload (128 hex chars, no 0x prefix)
const RS = "aa".repeat(32) + "bb".repeat(32);
// 65-byte sig with embedded v=0x1b (130 hex chars, no 0x prefix)
const SIG_65 = "aa".repeat(32) + "bb".repeat(32) + "1b";

describe("canonicalizeOwsSignature", () => {
  it("64-byte sig + recoveryId 0 → appends v=0x1b (27)", () => {
    const result = canonicalizeOwsSignature({ signature: "0x" + RS, recoveryId: 0 });
    expect(result).toBe("0x" + RS + "1b");
  });

  it("64-byte sig + recoveryId 1 → appends v=0x1c (28)", () => {
    const result = canonicalizeOwsSignature({ signature: "0x" + RS, recoveryId: 1 });
    expect(result).toBe("0x" + RS + "1c");
  });

  it("64-byte sig + recoveryId 27 (already canonical) → appends v=0x1b, not 0x24 (36)", () => {
    const result = canonicalizeOwsSignature({ signature: "0x" + RS, recoveryId: 27 });
    expect(result).toBe("0x" + RS + "1b");
    // Must NOT be 27+27=54=0x36
    expect(result).not.toBe("0x" + RS + "36");
  });

  it("64-byte sig + recoveryId 28 (already canonical) → appends v=0x1c", () => {
    const result = canonicalizeOwsSignature({ signature: "0x" + RS, recoveryId: 28 });
    expect(result).toBe("0x" + RS + "1c");
  });

  it("65-byte sig (length 130, embedded v) → returned as-is, recoveryId ignored", () => {
    const result = canonicalizeOwsSignature({ signature: "0x" + SIG_65, recoveryId: 99 });
    expect(result).toBe("0x" + SIG_65);
  });

  it("invalid length → throws Unexpected OWS signature length", () => {
    // 100 hex chars = 50 bytes — neither 64 nor 65
    const bad = "ab".repeat(50);
    expect(() => canonicalizeOwsSignature({ signature: bad })).toThrow(
      "Unexpected OWS signature length"
    );
  });
});
