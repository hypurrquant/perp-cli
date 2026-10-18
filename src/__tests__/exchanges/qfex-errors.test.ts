/**
 * QFEX status / error-frame / REST → PerpError mapping.
 */
import { describe, it, expect } from "vitest";
import {
  QFEX_ORDER_STATUSES, parseRetryAfterMs, qfexBankerError, qfexErrFrameError, qfexErrIsDefiniteRefusal,
  qfexOrderStatusError, qfexRestError, qfexStatusClass,
} from "../../exchanges/qfex/errors.js";
import { isDefiniteOrderFailure } from "../../errors.js";

describe("order_response.status classes", () => {
  it.each([
    ["ACK", "ack"], ["FILLED", "fill"], ["MODIFIED", "modified"],
    ["IOC_PARTIALLY_FILLED", "terminal"], ["IOC_CANCELLED", "terminal"], ["CANCELLED", "terminal"], ["CANCELLED_STP", "terminal"], ["EXPIRED", "terminal"],
    ["FAILED_MARGIN_CHECK", "reject"], ["REJECTED_MARKET_CLOSED", "reject"], ["NO_SUCH_ORDER", "reject"],
    ["SOMETHING_NEW", "unknown"], ["", "unknown"],
  ])("%s → %s", (status, cls) => {
    expect(qfexStatusClass(status)).toBe(cls);
  });

  it("every documented status is classified (none is 'unknown')", () => {
    for (const s of QFEX_ORDER_STATUSES) expect(qfexStatusClass(s), s).not.toBe("unknown");
  });
});

describe("engine rejection → PerpError", () => {
  const ctx = { what: "add_order AAPL-USD", band: { lower: "316.73", upper: "350.07" } };
  it.each([
    ["INVALID_PRICE", "INVALID_PARAMS"], ["INVALID_QUANTITY", "INVALID_PARAMS"], ["INVALID_ORDER_TYPE", "INVALID_PARAMS"],
    ["INVALID_TIME_IN_FORCE", "INVALID_PARAMS"], ["INVALID_CLIENT_ORDER_ID", "INVALID_PARAMS"], ["NO_CHANGE_NO_UPDATE", "INVALID_PARAMS"],
    ["INVALID_TICK_SIZE_PRECISION_QUANTITY", "INVALID_PARAMS"], ["INVALID_TICK_SIZE_PRECISION_PRICE", "INVALID_TICK"],
    ["PRICE_GREATER_THAN_MAX_PRICE", "INVALID_PARAMS"], ["REJECTED_LESS_THAN_MIN_PRICE_BAND", "INVALID_PARAMS"],
    ["QUANTITY_LESS_THAN_MIN_QUANTITY", "SIZE_TOO_SMALL"], ["REJECTED_LESS_THAN_MIN_NOTIONAL", "SIZE_TOO_SMALL"],
    ["QUANTITY_GREATER_THAN_MAX_QUANTITY", "SIZE_TOO_LARGE"], ["BAD_SYMBOL", "SYMBOL_NOT_FOUND"],
    ["NOT_FOUND", "ORDER_NOT_FOUND"], ["NO_SUCH_ORDER", "ORDER_NOT_FOUND"], ["CANNOT_MODIFY_NO_SUCH_ORDER", "ORDER_NOT_FOUND"],
    ["CANNOT_MODIFY_PARTIAL_FILL", "ORDER_REJECTED"], ["CANNOT_MODIFY_ALO_WOULD_CROSS", "ORDER_REJECTED"], ["REJECTED", "ORDER_REJECTED"],
    ["REJECTED_FAILED_TO_PROCESS", "ORDER_REJECTED"], ["REJECTED_MARKET_CLOSED", "ORDER_REJECTED"],
    ["FAILED_MARGIN_CHECK", "MARGIN_INSUFFICIENT"],
    ["REJECTED_WOULD_BREACH_MAX_POSITION", "RISK_VIOLATION"], ["REJECTED_OPEN_INTEREST_LIMIT", "RISK_VIOLATION"],
    ["REJECTED_TOO_MANY_OPEN_ORDERS", "RISK_VIOLATION"], ["USER_IN_LIQUIDATION", "RISK_VIOLATION"],
    ["PERMISSION_DENIED", "POLICY_DENIED"], ["USER_NOT_FOUND", "AGENT_NOT_REGISTERED"], ["RATE_LIMITED", "RATE_LIMITED"],
  ])("%s → %s", (status, code) => {
    const e = qfexOrderStatusError(status, ctx, { status });
    expect(e.structured.code).toBe(code);
    expect(e.structured.details?.venueStatus).toBe(status);
  });

  it("band rejections carry the band; a closed market carries reason marketClosed", () => {
    expect(qfexOrderStatusError("PRICE_GREATER_THAN_MAX_PRICE", ctx, null).structured.details?.band).toEqual(ctx.band);
    expect(qfexOrderStatusError("FAILED_MARGIN_CHECK", ctx, null).structured.details?.band).toBeUndefined();
    expect(qfexOrderStatusError("REJECTED_MARKET_CLOSED", ctx, null).structured.details?.reason).toBe("marketClosed");
  });

  it("every mapped rejection is a definite order failure except RATE_LIMITED (surfaced, never retried by perp-cli)", () => {
    for (const s of QFEX_ORDER_STATUSES) {
      if (qfexStatusClass(s) !== "reject") continue;
      const e = qfexOrderStatusError(s, ctx, null);
      expect(isDefiniteOrderFailure(e) || e.structured.code === "RATE_LIMITED" || e.structured.code === "ORDER_NOT_FOUND", s).toBe(true);
    }
  });
});

describe("error frames", () => {
  const echo = { type: "add_order", params: { client_order_id: "c1" } };

  it.each([
    ["RateLimited", "RATE_LIMITED"], ["InvalidJSONFormat", "INVALID_PARAMS"], ["InvalidParameter", "INVALID_PARAMS"],
    ["InvalidOrder", "INVALID_PARAMS"], ["InvalidOrderId", "INVALID_PARAMS"], ["PermissionDenied", "POLICY_DENIED"],
    ["KycRequired", "POLICY_DENIED"], ["TncRequired", "POLICY_DENIED"], ["AlreadyAuthenticated", "EXCHANGE_ERROR"], ["ServerError", "EXCHANGE_ERROR"],
    ["SomethingNew", "EXCHANGE_ERROR"],
  ])("%s → %s", (errorCode, code) => {
    expect(qfexErrFrameError({ errorCode, message: null, echo }, "add_order").structured.code).toBe(code);
  });

  it("a refusal is definite only with a matching echo; ServerError and unknown codes never are", () => {
    expect(qfexErrIsDefiniteRefusal({ errorCode: "InvalidParameter", message: null, echo }, true)).toBe(true);
    expect(qfexErrIsDefiniteRefusal({ errorCode: "InvalidParameter", message: null, echo }, false)).toBe(false);
    expect(qfexErrIsDefiniteRefusal({ errorCode: "RateLimited", message: null, echo: null }, false)).toBe(false);
    expect(qfexErrIsDefiniteRefusal({ errorCode: "ServerError", message: null, echo }, true)).toBe(false);
    expect(qfexErrIsDefiniteRefusal({ errorCode: "SomethingNew", message: null, echo }, true)).toBe(false);
  });

  it("retry-after is parsed from the message (ms and seconds); absent → null", () => {
    expect(parseRetryAfterMs("Too many requests. Please retry after 200ms.")).toBe(200);
    expect(parseRetryAfterMs("Rate limit exceeded, retry after 3 seconds")).toBe(3000);
    expect(parseRetryAfterMs("Rate limit exceeded")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(qfexErrFrameError({ errorCode: "RateLimited", message: "retry after 1.5 s", echo }, "x").structured.details?.retryAfterMs).toBe(1500);
  });

  it("KYC / terms remediation names the fix", () => {
    expect(qfexErrFrameError({ errorCode: "KycRequired", message: null, echo }, "x").structured.remediation).toMatch(/KYC/);
    expect(qfexErrFrameError({ errorCode: "TncRequired", message: null, echo }, "x").structured.remediation).toMatch(/Terms/);
  });
});

describe("REST problem+json", () => {
  const problem = (title: string, detail: string) => JSON.stringify({ title, detail, status: 0 });

  it.each([
    [401, "SIGNATURE_FAILED"], [403, "POLICY_DENIED"], [429, "RATE_LIMITED"], [400, "INVALID_PARAMS"], [422, "INVALID_PARAMS"], [500, "EXCHANGE_ERROR"], [503, "EXCHANGE_ERROR"],
  ])("api HTTP %i → %s", (status, code) => {
    const e = qfexRestError("GET", "/user/positions", status, problem("Nope", "because"));
    expect(e.structured.code).toBe(code);
    expect(e.message).toContain("Nope: because");
    expect(e.structured.details?.httpStatus).toBe(status);
  });

  it("banker 400 is a definite refusal; insufficient withdrawable balance is named", () => {
    expect(qfexBankerError("POST", "/withdraw", 400, problem("Bad Request", "invalid address")).structured.code).toBe("ACTION_REJECTED");
    const e = qfexBankerError("POST", "/withdraw", 400, problem("Bad Request", "insufficient withdrawable balance"));
    expect(e.structured.code).toBe("INSUFFICIENT_BALANCE");
    expect(e.structured.remediation).toMatch(/Withdrawable Balance/);
  });

  it("banker 401 is decided by the body: terms not accepted → POLICY_DENIED, otherwise SIGNATURE_FAILED", () => {
    expect(qfexBankerError("POST", "/withdraw", 401, problem("Unauthorized", "terms not accepted")).structured.code).toBe("POLICY_DENIED");
    expect(qfexBankerError("POST", "/withdraw", 401, problem("Unauthorized", "invalid signature")).structured.code).toBe("SIGNATURE_FAILED");
  });

  it("banker 403 → POLICY_DENIED mentioning the permission and the web-app 2FA path; 5xx → EXCHANGE_ERROR", () => {
    const e = qfexBankerError("POST", "/withdraw", 403, problem("Forbidden", "no permission"));
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.structured.remediation).toMatch(/Deposit and withdraw/);
    expect(e.structured.remediation).toMatch(/two-factor/);
    expect(qfexBankerError("GET", "/address", 502, "bad gateway").structured.code).toBe("EXCHANGE_ERROR");
  });
});
