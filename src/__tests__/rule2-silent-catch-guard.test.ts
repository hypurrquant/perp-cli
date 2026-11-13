/**
 * Guard: an empty `catch` swallows a failure — it must say WHY in a comment (best-effort
 * cleanup, probe, shutdown…). Every existing empty catch in src/ already does, so this is exact
 * (no baseline): a new bare `catch {}` / `catch (e) {}` fails.
 *
 * Fix: log / rethrow (SSOT Rule #2), or keep the catch and write the reason inside it:
 *   catch { /* best-effort: file may already be gone *\/ }
 *
 * Deliberately NOT guarded: `catch { return <default>; }` (23 sites) and `.catch(() => undefined)`.
 * Those are mostly legitimate probes (`isX()` → false, cache miss → null) and cannot be told
 * apart from a swallowed real failure without type information, so a guard would be noise.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lineOf, rel, sourceFiles, stripCommentsAndStrings } from "./helpers/strip-source.js";

const CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;

/** Index just past the `}` matching the `{` at `open`, in comment/string-stripped text. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

export function bareEmptyCatches(raw: string): number[] {
  const text = stripCommentsAndStrings(raw); // same offsets as raw
  const lines: number[] = [];
  for (const m of text.matchAll(CATCH)) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(text, open);
    if (end < 0) continue;
    const emptyCode = text.slice(open + 1, end - 1).trim() === "";
    const hasComment = /\/\/|\/\*/.test(raw.slice(open + 1, end - 1));
    if (emptyCode && !hasComment) lines.push(lineOf(text, m.index));
  }
  return lines;
}

describe("rule 2 guard: empty catch", () => {
  it("detects a bare empty catch and accepts a commented one", () => {
    expect(bareEmptyCatches("try { a(); } catch {}")).toEqual([1]);
    expect(bareEmptyCatches("try { a(); } catch (e) {\n }")).toEqual([1]);
    expect(bareEmptyCatches("try { a(); } catch { /* best-effort */ }")).toEqual([]);
    expect(bareEmptyCatches("try { a(); } catch {\n // gone already\n}")).toEqual([]);
    expect(bareEmptyCatches("try { a(); } catch { log(); }")).toEqual([]);
  });

  it("no src file has an empty catch without an explanatory comment", () => {
    const found = sourceFiles("src").flatMap(f => bareEmptyCatches(readFileSync(f, "utf8")).map(l => `${rel(f)}:${l}`));
    expect(found, "empty catch swallows the failure — log/rethrow it, or write why inside the catch (SSOT Rule #2)").toEqual([]);
  });
});
