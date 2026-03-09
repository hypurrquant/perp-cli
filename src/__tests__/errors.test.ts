import { describe, it, expect } from "vitest";
import { classifyError, PerpError, ERROR_CODES, type ErrorCode } from "../errors.js";

describe("classifyError — pattern matching", () => {
  it("classifies insufficient balance errors", () => {
    const r = classifyError(new Error("Insufficient balance for order"));
    expect(r.code).toBe("INSUFFICIENT_BALANCE");
    expect(r.status).toBe(400);
    expect(r.retryable).toBe(false);
  });

  it("classifies margin-specific insufficient errors before generic balance", () => {
    const r = classifyError(new Error("Margin insufficient for cross order"));
    expect(r.code).toBe("MARGIN_INSUFFICIENT");
    expect(r.status).toBe(400);
  });

  it("classifies rate limit errors", () => {
    const r = classifyError(new Error("429 Too Many Requests"));
    expect(r.code).toBe("RATE_LIMITED");
    expect(r.retryable).toBe(true);
    expect(r.retryAfterMs).toBe(1000);
  });

  it("classifies network errors", () => {
    expect(classifyError(new Error("fetch failed")).code).toBe("EXCHANGE_UNREACHABLE");
    expect(classifyError(new Error("ECONNREFUSED")).code).toBe("EXCHANGE_UNREACHABLE");
    expect(classifyError(new Error("ENOTFOUND api.example.com")).code).toBe("EXCHANGE_UNREACHABLE");
  });

  it("classifies timeout errors", () => {
    expect(classifyError(new Error("Request timed out")).code).toBe("TIMEOUT");
    expect(classifyError(new Error("ETIMEDOUT")).code).toBe("TIMEOUT");
    expect(classifyError("timeout").code).toBe("TIMEOUT");
  });

  it("classifies symbol not found", () => {
    const r = classifyError(new Error("Symbol XYZABC not found"));
    expect(r.code).toBe("SYMBOL_NOT_FOUND");
  });

  it("classifies order not found", () => {
    const r = classifyError(new Error("Order #12345 not found"));
    expect(r.code).toBe("ORDER_NOT_FOUND");
  });

  it("classifies position not found", () => {
    const r = classifyError(new Error("Position not found for BTC"));
    expect(r.code).toBe("POSITION_NOT_FOUND");
  });

  it("classifies size too small", () => {
    expect(classifyError(new Error("Order size too small")).code).toBe("SIZE_TOO_SMALL");
    expect(classifyError(new Error("Below minimum order size")).code).toBe("SIZE_TOO_SMALL");
  });

  it("classifies size too large", () => {
    expect(classifyError(new Error("Order size too large")).code).toBe("SIZE_TOO_LARGE");
    expect(classifyError(new Error("Exceeds max position size")).code).toBe("SIZE_TOO_LARGE");
  });

  it("classifies signature errors", () => {
    expect(classifyError(new Error("Signature verification failed")).code).toBe("SIGNATURE_FAILED");
  });

  it("classifies duplicate order", () => {
    expect(classifyError(new Error("Duplicate order ID")).code).toBe("DUPLICATE_ORDER");
    expect(classifyError(new Error("Order already exists")).code).toBe("DUPLICATE_ORDER");
  });

  it("classifies risk violation", () => {
    expect(classifyError(new Error("Risk limit violation")).code).toBe("RISK_VIOLATION");
  });

  it("returns EXCHANGE_ERROR when exchange is known but message is unrecognized", () => {
    const r = classifyError(new Error("Something weird happened"), "hyperliquid");
    expect(r.code).toBe("EXCHANGE_ERROR");
    expect(r.exchange).toBe("hyperliquid");
    expect(r.retryable).toBe(true);
  });

  it("returns UNKNOWN when no exchange and message is unrecognized", () => {
    const r = classifyError(new Error("Something weird happened"));
    expect(r.code).toBe("UNKNOWN");
    expect(r.retryable).toBe(false);
  });

  it("handles non-Error inputs", () => {
    const r = classifyError("rate limit exceeded");
    expect(r.code).toBe("RATE_LIMITED");
    expect(r.message).toBe("rate limit exceeded");
  });
});

describe("PerpError class", () => {
  it("creates error with structured fields", () => {
    const err = new PerpError("INSUFFICIENT_BALANCE", "Not enough USDC", { required: 100, available: 50 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PerpError");
    expect(err.message).toBe("Not enough USDC");
    expect(err.structured.code).toBe("INSUFFICIENT_BALANCE");
    expect(err.structured.status).toBe(400);
    expect(err.structured.retryable).toBe(false);
    expect(err.structured.details?.required).toBe(100);
  });

  it("has correct prototype chain", () => {
    const err = new PerpError("TIMEOUT", "Request timed out");
    expect(err instanceof PerpError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe("ERROR_CODES coverage", () => {
  it("all codes have required fields", () => {
    for (const [key, val] of Object.entries(ERROR_CODES)) {
      expect(val.code).toBe(key);
      expect(typeof val.status).toBe("number");
      expect(typeof val.retryable).toBe("boolean");
    }
  });

  it("retryable codes are all 5xx or 429", () => {
    for (const val of Object.values(ERROR_CODES)) {
      if (val.retryable) {
        expect(val.status).toBeGreaterThanOrEqual(429);
      }
    }
  });
});
