import { describe, it, expect } from "vitest";
import { formatUsd, formatPnl, formatPercent, printJson, errorAndExit } from "../utils.js";

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
