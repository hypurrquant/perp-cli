/**
 * Definite vs unknown order failures (errors.ts): only a typed definite
 * code means "not placed". Anything raised after sending — untyped errors, transport
 * failures, 5xx, non-definite PerpErrors — is an UNKNOWN outcome (ORDER_PENDING, never
 * resubmitted, never read as a rejection).
 */
import { describe, it, expect } from "vitest";
import {
  DEFINITE_ORDER_FAILURE_CODES, PerpError, isDefiniteOrderFailure, isTransportFailure,
  isUnknownOutcomeServerError, orderNotSent, orderOutcomeUnknown, sendFailure,
} from "../errors.js";

describe("isDefiniteOrderFailure", () => {
  it.each(["ORDER_REJECTED", "INVALID_PARAMS", "INSUFFICIENT_BALANCE", "SIZE_TOO_SMALL", "INVALID_TICK", "PRICE_STALE", "CAPABILITY_UNSUPPORTED"] as const)(
    "%s is definite (not placed)", (code) => {
      expect(isDefiniteOrderFailure(new PerpError(code, "x"))).toBe(true);
    });

  it.each(["ORDER_PENDING", "EXCHANGE_ERROR", "EXCHANGE_UNREACHABLE", "TIMEOUT", "RATE_LIMITED", "UNKNOWN"] as const)(
    "%s is NOT definite (outcome unknown)", (code) => {
      expect(isDefiniteOrderFailure(new PerpError(code, "x"))).toBe(false);
    });

  it("an untyped Error is never definite, whatever its message says", () => {
    expect(isDefiniteOrderFailure(new Error("Order rejected: insufficient margin"))).toBe(false);
    expect(isDefiniteOrderFailure("rejected")).toBe(false);
  });

  it("details.sent === false (a local refusal) is definite whatever the code; the code alone is not", () => {
    expect(isDefiniteOrderFailure(new PerpError("POSITION_NOT_FOUND", "no position — not sent", { sent: false }))).toBe(true);
    expect(isDefiniteOrderFailure(new PerpError("TIMEOUT", "connect timed out", { sent: false }))).toBe(true);
    // classifyError derives POSITION_NOT_FOUND from message text: the code alone proves nothing.
    expect(isDefiniteOrderFailure(new PerpError("POSITION_NOT_FOUND", "position not found"))).toBe(false);
    expect(DEFINITE_ORDER_FAILURE_CODES.has("POSITION_NOT_FOUND")).toBe(false);
    expect(isDefiniteOrderFailure(new PerpError("EXCHANGE_ERROR", "x", { sent: true }))).toBe(false);
    expect(isDefiniteOrderFailure(new PerpError("EXCHANGE_ERROR", "x", { sent: "false" }))).toBe(false);
  });

  it("orderNotSent / sendFailure still re-type a not-sent error that carries a retryable code", () => {
    const notSent = new PerpError("TIMEOUT", "connect timed out", { sent: false });
    expect(orderNotSent("qfex", "add_order", notSent).structured.code).toBe("ORDER_REJECTED");
    expect(sendFailure("qfex", "add_order", notSent).structured.code).toBe("ORDER_REJECTED");
  });

  it("ORDER_PENDING / ORDER_PARTIAL are not in the definite set", () => {
    expect(DEFINITE_ORDER_FAILURE_CODES.has("ORDER_PENDING")).toBe(false);
    expect(DEFINITE_ORDER_FAILURE_CODES.has("ORDER_PARTIAL")).toBe(false);
  });
});

describe("orderNotSent / orderOutcomeUnknown", () => {
  it("orderNotSent keeps a definite PerpError unchanged", () => {
    const e = new PerpError("INSUFFICIENT_BALANCE", "no margin");
    expect(orderNotSent("hyperliquid", "buy 1 BTC", e)).toBe(e);
  });

  it("orderNotSent turns any pre-send failure into ORDER_REJECTED (definitely not placed)", () => {
    const r = orderNotSent("hyperliquid", "buy 1 BTC", new Error("signing failed"));
    expect(r.structured.code).toBe("ORDER_REJECTED");
    expect(r.message).toContain("not sent");
  });

  it("orderOutcomeUnknown → ORDER_PENDING with a do-not-resubmit remediation", () => {
    const r = orderOutcomeUnknown("aster", "sell 1 ETH", new Error("socket hang up"));
    expect(r.structured.code).toBe("ORDER_PENDING");
    expect(r.structured.retryable).toBe(false);
    expect(r.structured.remediation).toMatch(/Do NOT resubmit/);
  });

  it("orderOutcomeUnknown keeps an existing ORDER_PENDING unchanged", () => {
    const p = new PerpError("ORDER_PENDING", "already unknown");
    expect(orderOutcomeUnknown("aster", "x", p)).toBe(p);
  });
});

describe("isTransportFailure / isUnknownOutcomeServerError", () => {
  it.each(["fetch failed", "read ECONNRESET", "connect ETIMEDOUT", "socket hang up", "request timed out", "network error"])(
    "'%s' is a transport failure", (msg) => {
      expect(isTransportFailure(new Error(msg))).toBe(true);
    });

  it("TypeError / SyntaxError (unparseable body) / AbortError are transport failures", () => {
    expect(isTransportFailure(new TypeError("x"))).toBe(true);
    expect(isTransportFailure(new SyntaxError("Unexpected token <"))).toBe(true);
    const abort = new Error("aborted"); abort.name = "AbortError";
    expect(isTransportFailure(abort)).toBe(true);
  });

  it("a plain venue message is not a transport failure; a PerpError never is", () => {
    expect(isTransportFailure(new Error("Reduce only order would increase position"))).toBe(false);
    expect(isTransportFailure(new PerpError("EXCHANGE_UNREACHABLE", "fetch failed"))).toBe(false);
  });

  it("HL / Pacifica 5xx after the POST are unknown-outcome server errors; 4xx are not", () => {
    expect(isUnknownOutcomeServerError(new Error("HL exchange API error (502): Bad Gateway"))).toBe(true);
    expect(isUnknownOutcomeServerError(new Error("POST /orders/create_market failed (503): unavailable"))).toBe(true);
    expect(isUnknownOutcomeServerError(new Error("POST /orders/create_market failed (400): bad lot"))).toBe(false);
    expect(isUnknownOutcomeServerError(new PerpError("EXCHANGE_ERROR", "HL exchange API error (502)"))).toBe(false);
  });
});
