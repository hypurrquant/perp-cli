import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifyError, PerpError, ERROR_CODES, type ErrorCode } from "../errors.js";
import { jsonError, withJsonErrors } from "../utils.js";

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

  it("classifies AEAD/decryption failure as INVALID_PASSPHRASE", () => {
    // The exact NAPI error message thrown by @open-wallet-standard/core
    // when the AEAD tag check fails (wrong passphrase or tampered ciphertext).
    const r = classifyError(new Error("decryption failed: aead::Error"));
    expect(r.code).toBe("INVALID_PASSPHRASE");
    expect(r.status).toBe(401);
    expect(r.retryable).toBe(false);
    expect(r.remediation).toMatch(/passphrase/i);
  });

  it("INVALID_PASSPHRASE matches generic 'decryption failed' messages too", () => {
    expect(classifyError(new Error("Decryption failed")).code).toBe("INVALID_PASSPHRASE");
    expect(classifyError(new Error("decryption error: tag mismatch")).code).toBe("INVALID_PASSPHRASE");
  });

  it("INVALID_PASSPHRASE is distinct from PASSPHRASE_REQUIRED", () => {
    expect(classifyError(new Error("passphrase required")).code).toBe("PASSPHRASE_REQUIRED");
    expect(classifyError(new Error("aead::Error")).code).toBe("INVALID_PASSPHRASE");
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

  it("retryable codes are all 4xx (≥429 or 423 LOCK_HELD) or 5xx", () => {
    for (const val of Object.entries(ERROR_CODES)) {
      const [key, entry] = val;
      if (entry.retryable) {
        // LOCK_HELD uses 423 (Locked) by design — it is retryable after a short wait
        const allowed = entry.status === 423 || entry.status >= 429;
        expect(allowed, `${key} has retryable=true but unexpected status ${entry.status}`).toBe(true);
      }
    }
  });

  // Regression guard for 198f196: the ad-hoc strings "FATAL" (index.ts
  // top-level catch) and "INVALID_EXCHANGE" (market hip3 path) used to ship
  // via `jsonError(code as never, ...)` without being registered in
  // ERROR_CODES — they slipped past the type system and reached callers as
  // codes with no status/retryable/remediation. The fix routes both through
  // existing registered codes (classifyError for the catch-all; INVALID_PARAMS
  // with remediation for hip3). Pin the absence to prevent reintroduction.
  it("ad-hoc codes retired in 198f196 are not in ERROR_CODES", () => {
    const retired = ["FATAL", "INVALID_EXCHANGE"];
    for (const code of retired) {
      expect(
        Object.prototype.hasOwnProperty.call(ERROR_CODES, code),
        `${code} was retired in 198f196 — must not be reintroduced as a registered code`,
      ).toBe(false);
    }
  });
});

describe("classifyError — never returns an unregistered code (198f196 regression guard)", () => {
  // Before 198f196, the top-level catch in src/index.ts hard-coded
  // jsonError("FATAL", msg) for any non-PerpError thrown out of an action,
  // so a typo'd Lighter symbol shipped as { code: "FATAL" } — no status,
  // no retryable, no remediation. The fix routes such errors through
  // classifyError. Pin that the classifier output is always a registered
  // ERROR_CODES entry, regardless of input shape.

  it("a network-flavored Error becomes EXCHANGE_UNREACHABLE (registered), not 'FATAL'", () => {
    const r = classifyError(new Error("fetch failed: ECONNREFUSED"));
    expect(r.code).toBe("EXCHANGE_UNREACHABLE");
    expect(ERROR_CODES).toHaveProperty(r.code);
  });

  it("a typo'd symbol Error becomes SYMBOL_NOT_FOUND (registered), not 'FATAL'", () => {
    const r = classifyError(new Error("Symbol BTCUSDX not found"));
    expect(r.code).toBe("SYMBOL_NOT_FOUND");
    expect(ERROR_CODES).toHaveProperty(r.code);
  });

  it("a wholly unknown Error message falls back to UNKNOWN (registered), not 'FATAL'", () => {
    const r = classifyError(new Error("something went wrong in a way nobody pattern-matched"));
    expect(r.code).toBe("UNKNOWN");
    expect(ERROR_CODES).toHaveProperty(r.code);
  });

  it("a non-Error thrown value (string / object) still resolves to a registered code", () => {
    // Defensive: pre-fix code path would have called String(err) and
    // labeled "FATAL". Now `classifyError` handles non-Error inputs
    // via extractErrorMessage + pattern matching.
    const r1 = classifyError("raw string thrown");
    expect(ERROR_CODES).toHaveProperty(r1.code);
    const r2 = classifyError({ message: "raw object thrown" });
    expect(ERROR_CODES).toHaveProperty(r2.code);
  });
});

// ─── Codex v0.12.12 final QA #2: classifyError preserves PerpError ────────
// Previously classifyError ignored err instanceof PerpError and re-derived
// the code from message text — so a typed PerpError("NOT_IMPLEMENTED", ...,
// {remediation}) became {code: "SIGNATURE_FAILED"} with no remediation.
describe("classifyError — PerpError preservation (C2)", () => {
  it("preserves NOT_IMPLEMENTED code and remediation from PerpError", () => {
    const err = new PerpError(
      "NOT_IMPLEMENTED",
      "Aster requires agent for signed paths",
      { remediation: "perp wallet agent approve aster --master <wallet>" },
    );
    const r = classifyError(err);
    expect(r.code).toBe("NOT_IMPLEMENTED");
    expect(r.message).toBe("Aster requires agent for signed paths");
    expect(r.remediation).toBe("perp wallet agent approve aster --master <wallet>");
    expect(r.status).toBe(501);
  });

  it("preserves AGENT_EXPIRED code from PerpError without re-deriving from text", () => {
    // Message would normally pattern-match "expire" → but that pattern doesn't
    // exist in classifyError; the real risk is a typed error getting mapped
    // to UNKNOWN. Verify the typed code wins regardless.
    const err = new PerpError(
      "AGENT_EXPIRED",
      "Agent has expired (rotate via --rotate)",
      { remediation: "perp wallet agent approve aster --rotate" },
    );
    const r = classifyError(err, "aster");
    expect(r.code).toBe("AGENT_EXPIRED");
    expect(r.exchange).toBe("aster");
    expect(r.remediation).toBe("perp wallet agent approve aster --rotate");
  });

  it("PerpError with details preserves details field", () => {
    const err = new PerpError(
      "INSUFFICIENT_BALANCE",
      "Not enough USDC",
      { required: 100, available: 50 },
    );
    const r = classifyError(err);
    expect(r.code).toBe("INSUFFICIENT_BALANCE");
    expect(r.details?.required).toBe(100);
    expect(r.details?.available).toBe(50);
  });

  it("PerpError without remediation does not surface a remediation field", () => {
    const err = new PerpError("TIMEOUT", "Request timed out");
    const r = classifyError(err);
    expect(r.code).toBe("TIMEOUT");
    expect(r.remediation).toBeUndefined();
  });

  it("plain Error still falls through to message-pattern classification", () => {
    // Regression guard: PerpError check must NOT swallow plain Error
    const r = classifyError(new Error("Insufficient balance"));
    expect(r.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("classifyError fills in exchange from caller arg when PerpError didn't set one", () => {
    const errNoEx = new PerpError("NOT_IMPLEMENTED", "test");
    const r = classifyError(errNoEx, "hyperliquid");
    expect(r.code).toBe("NOT_IMPLEMENTED");
    expect(r.exchange).toBe("hyperliquid");
  });
});

// ─── jsonError + withJsonErrors envelope serialization (C2) ───────────────
describe("jsonError envelope — remediation surfaced at error.* (C2)", () => {
  it("includes remediation at top level of error block when provided", () => {
    const env = jsonError("NOT_IMPLEMENTED", "Aster requires agent", {
      status: 501,
      retryable: false,
      remediation: "perp wallet agent approve aster --master <wallet>",
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("NOT_IMPLEMENTED");
    expect(env.error?.message).toBe("Aster requires agent");
    expect(env.error?.remediation).toBe("perp wallet agent approve aster --master <wallet>");
    expect(env.error?.status).toBe(501);
    expect(env.error?.retryable).toBe(false);
  });

  it("omits remediation field when not provided", () => {
    const env = jsonError("TIMEOUT", "Request timed out", { status: 504, retryable: true });
    expect(env.error?.remediation).toBeUndefined();
  });
});

describe("withJsonErrors — PerpError end-to-end (C2)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("thrown PerpError surfaces correct code AND remediation in JSON envelope", async () => {
    await withJsonErrors(true, async () => {
      throw new PerpError(
        "NOT_IMPLEMENTED",
        "Aster requires agent for signed paths",
        { remediation: "perp wallet agent approve aster --master <wallet>" },
      );
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0][0]);
    const parsed = JSON.parse(printed) as { ok: boolean; error: { code: string; message: string; remediation?: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("NOT_IMPLEMENTED");
    expect(parsed.error.message).toBe("Aster requires agent for signed paths");
    expect(parsed.error.remediation).toBe("perp wallet agent approve aster --master <wallet>");
  });

  it("non-JSON mode prints both message and remediation when present", async () => {
    await withJsonErrors(false, async () => {
      throw new PerpError(
        "AGENT_EXPIRED",
        "Agent expired",
        { remediation: "perp wallet agent approve aster --rotate" },
      );
    });

    expect(logSpy).not.toHaveBeenCalled();
    const all = errSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(all).toContain("Agent expired");
    expect(all).toContain("Remediation: perp wallet agent approve aster --rotate");
  });

  it("plain Error in JSON mode classifies via message and emits envelope without remediation", async () => {
    await withJsonErrors(true, async () => {
      throw new Error("Insufficient balance");
    });

    const printed = String(logSpy.mock.calls[0][0]);
    const parsed = JSON.parse(printed) as { error: { code: string; remediation?: string } };
    expect(parsed.error.code).toBe("INSUFFICIENT_BALANCE");
    expect(parsed.error.remediation).toBeUndefined();
  });
});
