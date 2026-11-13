/** The scanner behind the rule2-* guard tests blanks prose but keeps code and line numbers. */
import { describe, expect, it } from "vitest";
import { balancedParens, stripCommentsAndStrings } from "./helpers/strip-source.js";

describe("stripCommentsAndStrings", () => {
  it("blanks line and block comments", () => {
    const out = stripCommentsAndStrings("a // throw new Error(\nb /* fetch( */ c");
    expect(out).not.toMatch(/throw|fetch/);
    expect(out).toContain("a");
    expect(out).toContain("c");
  });
  it("blanks string text but keeps the quotes", () => {
    expect(stripCommentsAndStrings(`x("fetch(", 'throw new Error(')`)).not.toMatch(/fetch|throw/);
  });
  it("keeps code inside template ${} and blanks the text around it", () => {
    const out = stripCommentsAndStrings("`fetch( ${fetch(u)} throw`");
    expect(out.match(/fetch/g)).toHaveLength(1);
    expect(out).not.toContain("throw");
  });
  it("keeps newlines so line numbers survive", () => {
    const src = "a\n/* x\ny */\n`p\nq`\nb";
    expect(stripCommentsAndStrings(src).split("\n")).toHaveLength(src.split("\n").length);
  });
  it("does not let an escaped quote end a string early", () => {
    expect(stripCommentsAndStrings(`"a\\" fetch( b" ok`)).not.toContain("fetch");
  });
});

describe("balancedParens", () => {
  it("returns the full nested argument list", () => {
    const t = "f(a, g(b), {c: d(e)}) tail";
    expect(balancedParens(t, 1)).toBe("(a, g(b), {c: d(e)})");
  });
});
