import { describe, it, expect } from "vitest";
import {
  formatUsd, formatPnl, formatPercent, printJson, errorAndExit,
  symbolMatch, jsonOk, jsonError, withJsonErrors, logSettledRejections,
} from "../utils.js";

describe("formatUsd", () => {
  it("formats numeric strings", () => {
    expect(formatUsd("1234.5")).toBe("1,234.50");
  });

  it("formats numbers", () => {
    expect(formatUsd(99999.999)).toBe("100,000.00");
  });

  it("returns original string for NaN", () => {
    expect(formatUsd("abc")).toBe("abc");
  });

  it("formats zero", () => {
    expect(formatUsd(0)).toBe("0.00");
  });

  it("formats negative numbers", () => {
    expect(formatUsd(-42.1)).toBe("-42.10");
  });
});

describe("formatPnl", () => {
  it("positive PnL has + prefix", () => {
    const result = formatPnl(100);
    expect(result).toContain("+$100.00");
  });

  it("negative PnL has - prefix", () => {
    const result = formatPnl(-50);
    expect(result).toContain("-$50.00");
  });

  it("zero PnL", () => {
    const result = formatPnl(0);
    expect(result).toContain("$0.00");
  });

  it("handles string input", () => {
    const result = formatPnl("123.456");
    expect(result).toContain("$123.46");
  });

  it("handles NaN", () => {
    expect(formatPnl("abc")).toBe("abc");
  });
});

describe("formatPercent", () => {
  it("positive percent", () => {
    const result = formatPercent(0.0015);
    expect(result).toContain("+0.1500%");
  });

  it("negative percent", () => {
    const result = formatPercent(-0.0025);
    expect(result).toContain("-0.2500%");
  });

  it("zero percent", () => {
    const result = formatPercent(0);
    expect(result).toContain("0.0000%");
  });

  it("handles NaN", () => {
    expect(formatPercent("abc")).toBe("abc");
  });
});

describe("printJson", () => {
  it("outputs valid JSON to console", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    printJson({ a: 1, b: "hello" });

    console.log = origLog;
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toEqual({ a: 1, b: "hello" });
  });

  it("handles arrays", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    printJson([1, 2, 3]);

    console.log = origLog;
    expect(JSON.parse(logs[0])).toEqual([1, 2, 3]);
  });
});

// ── Symbol matching (pre-existing public helper, was uncovered) ──

describe("symbolMatch", () => {
  it("matches identical strings (case-insensitive)", () => {
    expect(symbolMatch("BTC", "BTC")).toBe(true);
    expect(symbolMatch("btc", "BTC")).toBe(true);
    expect(symbolMatch("BTC", "btc")).toBe(true);
  });

  it("matches candidate with -PERP suffix against bare target", () => {
    expect(symbolMatch("BTC-PERP", "BTC")).toBe(true);
    expect(symbolMatch("eth-perp", "ETH")).toBe(true);
  });

  it("does NOT match bare candidate against target with -PERP suffix (asymmetric)", () => {
    // Pinned current behavior: matching is only candidate→target, not reverse.
    // If callers need symmetric matching they must normalize the target first.
    expect(symbolMatch("BTC", "BTC-PERP")).toBe(false);
  });

  it("rejects different bases", () => {
    expect(symbolMatch("BTC", "ETH")).toBe(false);
    expect(symbolMatch("BTC-PERP", "ETH")).toBe(false);
  });
});

// ── JSON envelope contract (jsonOk / jsonError) — agent / MCP consumers depend on shape ──

describe("jsonOk", () => {
  it("wraps payload as {ok:true, data, meta.timestamp(ISO)}", () => {
    const res = jsonOk({ x: 1 });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ x: 1 });
    expect(typeof res.meta?.timestamp).toBe("string");
    // ISO 8601 round-trip
    expect(new Date(res.meta!.timestamp).toISOString()).toBe(res.meta!.timestamp);
  });

  it("merges meta overrides while always emitting timestamp", () => {
    const res = jsonOk("payload", { exchange: "hyperliquid", duration_ms: 42 });
    expect(res.meta?.exchange).toBe("hyperliquid");
    expect(res.meta?.duration_ms).toBe(42);
    expect(typeof res.meta?.timestamp).toBe("string");
  });
});

describe("jsonError", () => {
  it("returns {ok:false, error.code, error.message, meta.timestamp}", () => {
    const res = jsonError("INVALID_PARAMS", "bad input");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
    expect(res.error?.message).toBe("bad input");
    expect(typeof res.meta?.timestamp).toBe("string");
  });

  it("propagates optional status / retryable / retryAfterMs / remediation / details", () => {
    const res = jsonError("RATE_LIMIT", "throttled", {
      status: 429,
      retryable: true,
      retryAfterMs: 5000,
      remediation: "Back off 5s and retry",
      details: { exchange: "hyperliquid" },
    });
    expect(res.error?.status).toBe(429);
    expect(res.error?.retryable).toBe(true);
    expect(res.error?.retryAfterMs).toBe(5000);
    expect(res.error?.remediation).toBe("Back off 5s and retry");
    expect(res.error?.details).toEqual({ exchange: "hyperliquid" });
  });

  it("OMITS optional fields entirely when not provided (avoids null/undefined leakage in JSON output)", () => {
    const res = jsonError("CODE", "msg");
    expect(res.error).not.toHaveProperty("status");
    expect(res.error).not.toHaveProperty("retryable");
    expect(res.error).not.toHaveProperty("retryAfterMs");
    expect(res.error).not.toHaveProperty("remediation");
    expect(res.error).not.toHaveProperty("details");
  });

  it("retains retryable=false without spuriously adding retryAfterMs", () => {
    const res = jsonError("CODE", "msg", { retryable: false });
    expect(res.error?.retryable).toBe(false);
    expect(res.error).not.toHaveProperty("retryAfterMs");
  });
});

// ── logSettledRejections — SSOT Rule #2 stderr helper for Promise.allSettled fan-outs ──

describe("logSettledRejections", () => {
  it("emits one stderr line per rejected outcome with [prefix] label and reason", () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    try {
      logSettledRejections(
        [
          { status: "fulfilled", value: "A-ok" },
          { status: "rejected", reason: new Error("boom") },
          { status: "fulfilled", value: "C-ok" },
          { status: "rejected", reason: "string-reason" },
        ],
        ["A", "B", "C", "D"],
        "arb-auto",
      );
    } finally {
      console.error = origErr;
    }

    expect(errs).toHaveLength(2);
    expect(errs[0]).toBe("[arb-auto] B fetch failed: boom");
    expect(errs[1]).toBe("[arb-auto] D fetch failed: string-reason");
  });

  it("falls back to index-N label when labels array is shorter than settled array", () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    try {
      logSettledRejections(
        [{ status: "rejected", reason: new Error("x") }],
        [],
        "pre",
      );
    } finally {
      console.error = origErr;
    }
    expect(errs).toEqual(["[pre] index-0 fetch failed: x"]);
  });

  it("emits nothing when every outcome is fulfilled (no quiet stderr noise)", () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    try {
      logSettledRejections(
        [{ status: "fulfilled", value: 1 }, { status: "fulfilled", value: 2 }],
        ["a", "b"],
        "p",
      );
    } finally {
      console.error = origErr;
    }
    expect(errs).toHaveLength(0);
  });
});

// ── withJsonErrors — JSON envelope wrapping vs stderr passthrough ──

describe("withJsonErrors", () => {
  it("returns the resolved value when the action succeeds (passthrough)", async () => {
    const res = await withJsonErrors(true, async () => 42);
    expect(res).toBe(42);
  });

  it("emits a JSON envelope to stdout and returns undefined when isJson=true and action throws", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    let res: unknown;
    try {
      res = await withJsonErrors(true, async () => { throw new Error("boom"); });
    } finally {
      console.log = origLog;
    }
    expect(res).toBeUndefined();
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error?.message ?? "")).toContain("boom");
  });

  it("writes a chalk-formatted line to stderr (not JSON) and returns undefined when isJson=false and action throws", async () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    let res: unknown;
    try {
      res = await withJsonErrors(false, async () => { throw new Error("boom"); });
    } finally {
      console.error = origErr;
    }
    expect(res).toBeUndefined();
    // Stripped of ANSI color codes
    const joined = errs.join("\n").replace(/\[[0-9;]*m/g, "");
    expect(joined).toContain("boom");
  });
});
