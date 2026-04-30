import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "../errors.js";

describe("extractErrorMessage", () => {
  it("returns Error.message for Error instances", () => {
    expect(extractErrorMessage(new Error("real error"))).toBe("real error");
  });

  it("returns string .message for plain object with string message", () => {
    expect(extractErrorMessage({ message: "plain object", code: "X" })).toBe("plain object");
  });

  it("JSON-stringifies object .message instead of producing [object Object]", () => {
    const out = extractErrorMessage({ message: { nested: "fail", code: 42 } });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"nested":"fail","code":42}');
  });

  it("JSON-stringifies the whole err when .message is missing", () => {
    const out = extractErrorMessage({ code: "FATAL", reason: "oops" });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"code":"FATAL","reason":"oops"}');
  });

  it("falls back to String(err) when JSON.stringify hits a circular ref", () => {
    const cyc: { self?: unknown } = {};
    cyc.self = cyc;
    const out = extractErrorMessage(cyc);
    expect(out).toBe("[object Object]");
  });

  it("falls back to String(err) when message is non-string and circular", () => {
    const cyc: { self?: unknown } = {};
    cyc.self = cyc;
    const out = extractErrorMessage({ message: cyc });
    expect(out).toBe("[object Object]");
  });

  it("handles primitive throws", () => {
    expect(extractErrorMessage("just a string")).toBe("just a string");
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(null)).toBe("null");
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });

  it("does not throw on Error subclasses", () => {
    class CustomError extends Error {
      constructor() { super("custom"); this.name = "CustomError"; }
    }
    expect(extractErrorMessage(new CustomError())).toBe("custom");
  });
});
