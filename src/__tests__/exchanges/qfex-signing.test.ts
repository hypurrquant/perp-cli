/**
 * QFEX signing vectors + wire-number conversion + the unverified-format gates
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  QFEX_MODIFY_KEEPS_CLIENT_ID, QFEX_REDUCE_ONLY_WIRE, QFEX_USER_ID_IS_ACCOUNT, decimalsEqual, fromWireNumber, isZeroDecimal,
  qfexNonce, qfexReduceOnlyGate, qfexRestHeaders, qfexSignature, qfexWsAuthMessage, reduceOnlyWireValue, subDecimals,
  sumDecimals, toWireNumber, weightedAveragePrice,
} from "../../exchanges/qfex/signing.js";
import { PerpError } from "../../errors.js";

const CREDS = { publicKey: "qfex_pub_xxxxx", secret: "qfex_secret_yyyyyy" };
const NONCE = "c0ffee00c0ffee00c0ffee00c0ffee00";
const TS = 1760545414;
// printf 'c0ffee00c0ffee00c0ffee00c0ffee00:1760545414' | openssl dgst -sha256 -hmac 'qfex_secret_yyyyyy'
const SIG = "12b3673e49f1a9c5c361108c3ff613daf287ad54b935d3a7bde94b2f51483260";

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { return (e as PerpError).structured.code; }
  return "no error";
}

describe("QFEX HMAC", () => {
  it("signs `${nonce}:${unix_ts}` with HMAC-SHA256, hex (openssl vector)", () => {
    expect(qfexSignature(CREDS.secret, NONCE, TS)).toBe(SIG);
    expect(qfexSignature(CREDS.secret, NONCE, TS)).toBe(createHmac("sha256", CREDS.secret).update(`${NONCE}:${TS}`).digest("hex"));
  });

  it("nonce is 32 lowercase hex chars and unique", () => {
    const a = qfexNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(qfexNonce()).not.toBe(a);
  });

  it("refuses a non-hex nonce and a non-integer timestamp", () => {
    expect(codeOf(() => qfexSignature("s", "not hex", TS))).toBe("INVALID_PARAMS");
    expect(codeOf(() => qfexSignature("s", NONCE, 1.5))).toBe("INVALID_PARAMS");
  });

  it("REST headers: the four auth headers, timestamp in seconds, account header only when given", () => {
    const h = qfexRestHeaders(CREDS, null, TS * 1000 + 999, NONCE);
    expect(h).toEqual({
      "x-qfex-public-key": CREDS.publicKey, "x-qfex-hmac-signature": SIG, "x-qfex-nonce": NONCE, "x-qfex-timestamp": String(TS),
    });
    const sub = qfexRestHeaders(CREDS, "22222222-2222-4222-8222-222222222222", TS * 1000, NONCE);
    expect(sub["x-qfex-requested-account-id"]).toBe("22222222-2222-4222-8222-222222222222");
    expect(JSON.stringify(h)).not.toContain(CREDS.secret);
  });

  it("WS auth message: hmac block, explicit account_id, builder_code only when set", () => {
    const acct = "11111111-1111-4111-8111-111111111111";
    const m = qfexWsAuthMessage(CREDS, acct, null, TS * 1000, NONCE);
    expect(m).toEqual({ type: "auth", params: { hmac: { public_key: CREDS.publicKey, nonce: NONCE, unix_ts: TS, signature: SIG }, account_id: acct } });
    const b = qfexWsAuthMessage(CREDS, acct, "33333333-3333-4333-8333-333333333333", TS * 1000, NONCE);
    expect(b.params.builder_code).toBe("33333333-3333-4333-8333-333333333333");
    expect(JSON.stringify(b)).not.toContain(CREDS.secret);
  });
});

describe("QFEX wire numbers", () => {
  it("toWireNumber converts exact decimals", () => {
    expect(toWireNumber("333.41", "price")).toBe(333.41);
    expect(toWireNumber("0.001", "quantity")).toBe(0.001);
    expect(toWireNumber("10", "quantity")).toBe(10);
  });

  it("refuses more than 15 significant digits, exponents, negatives and junk", () => {
    expect(codeOf(() => toWireNumber("1234567890.1234567", "price"))).toBe("INVALID_PARAMS");
    expect(codeOf(() => toWireNumber("1e3", "price"))).toBe("INVALID_PARAMS");
    expect(codeOf(() => toWireNumber("-1", "price"))).toBe("INVALID_PARAMS");
    expect(codeOf(() => toWireNumber("", "price"))).toBe("INVALID_PARAMS");
  });

  it("fromWireNumber quantizes to the step's decimals (float noise removed)", () => {
    expect(fromWireNumber(0.1 + 0.2, "0.001", "quantity")).toBe("0.3");
    expect(fromWireNumber(2.708, "0.001", "quantity")).toBe("2.708");
    expect(fromWireNumber(251.25, "0.01", "price")).toBe("251.25");
    expect(fromWireNumber(0, "0.001", "quantity")).toBe("0");
    expect(fromWireNumber(1841400, "100", "price")).toBe("1841400");
  });

  it("fromWireNumber refuses non-numbers and negatives", () => {
    expect(codeOf(() => fromWireNumber("1", "0.01", "price"))).toBe("EXCHANGE_ERROR");
    expect(codeOf(() => fromWireNumber(NaN, "0.01", "price"))).toBe("EXCHANGE_ERROR");
    expect(codeOf(() => fromWireNumber(-1, "0.01", "price"))).toBe("EXCHANGE_ERROR");
  });
});

describe("QFEX decimal math (no float ===)", () => {
  it("sums, subtracts and compares exactly", () => {
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals([])).toBe("0");
    expect(subDecimals("1", "0.7", "x")).toBe("0.3");
    expect(decimalsEqual("0.30", "0.3")).toBe(true);
    expect(decimalsEqual("0.3", "0.31")).toBe(false);
    expect(isZeroDecimal("0.000")).toBe(true);
    expect(codeOf(() => subDecimals("0.1", "0.2", "x"))).toBe("EXCHANGE_ERROR");
  });

  it("weighted average price on BigInt", () => {
    expect(weightedAveragePrice([{ price: "100", quantity: "1" }, { price: "101", quantity: "3" }])).toBe("100.75");
    expect(weightedAveragePrice([{ price: "333.41", quantity: "0.5" }])).toBe("333.41");
    expect(weightedAveragePrice([])).toBeNull();
  });
});

describe("QFEX live-checked wire facts (hard gates while UNSET)", () => {
  it("reduce_only is a JSON boolean (Q2, 2026-10-05); MODIFIED keeps the client id (Q5, 2026-10-12); user_id meaning is not asserted", () => {
    expect(QFEX_REDUCE_ONLY_WIRE).toBe("boolean");
    expect(QFEX_MODIFY_KEEPS_CLIENT_ID).toBe(true);
    expect(QFEX_USER_ID_IS_ACCOUNT).toBeNull();
  });

  it("an unset reduce_only format refuses with the uniform unsupported response pointing at Q2", () => {
    const gate = qfexReduceOnlyGate(null);
    expect(gate).toBeInstanceOf(PerpError);
    expect(gate!.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(gate!.structured.details).toMatchObject({ venue: "qfex", feature: "reduceOnly" });
    expect(gate!.structured.remediation).toMatch(/Q2/);
    expect(qfexReduceOnlyGate("boolean")).toBeNull();
  });

  it("reduceOnlyWireValue encodes per the verified format", () => {
    expect(reduceOnlyWireValue("boolean", true)).toBe(true);
    expect(reduceOnlyWireValue("integer", true)).toBe(1);
    expect(reduceOnlyWireValue("integer", false)).toBe(0);
  });
});
