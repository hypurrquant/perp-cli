/**
 * Guard: no NEW raw `fetch(` call without a timeout (an `AbortSignal` / `signal`) in src/.
 *
 * A fetch with no signal can hang forever on a stalled venue, freezing a CLI command or a bot
 * tick. Pass `signal: AbortSignal.timeout(ms)` (or use `fetchWithTimeout` from src/http.ts). The existing
 * sites are a RATCHET: per-file counts below may only go down.
 *
 *  - count went UP   → add `signal: AbortSignal.timeout(...)` to the new call.
 *  - count went DOWN → good: lower that file's number below (the failure prints the new map).
 *    Paste the printed map over BASELINE.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { balancedParens, formatBaseline, ratchetProblems, rel, sourceFiles, stripCommentsAndStrings } from "./helpers/strip-source.js";

/** `fetch(` / `globalThis.fetch(` as a call — not `.fetch(` methods, `timedFetch(`, or `typeof fetch`. */
const FETCH_CALL = /(?<![.\w$])(?:globalThis\.)?fetch\s*\(/g;
const HAS_TIMEOUT = /\bAbortSignal\b|\bsignal\b/;

/** Baseline: raw fetch( calls without a timeout, per file (files not listed must stay at 0). */
const BASELINE: Record<string, number> = {
  "src/bot/strategies/claude-agent.ts": 1,
  "src/commands/agent.ts": 8,
  "src/commands/builder.ts": 2,
  "src/commands/funds.ts": 3,
  "src/discord.ts": 3,
  "src/exchanges/lighter.ts": 3,
  "src/telegram.ts": 3,
  "src/ws/directory.ts": 1,
};

function count(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of sourceFiles("src")) {
    const text = stripCommentsAndStrings(readFileSync(f, "utf8"));
    let n = 0;
    for (const m of text.matchAll(FETCH_CALL)) {
      const args = balancedParens(text, m.index + m[0].length - 1);
      if (!HAS_TIMEOUT.test(args)) n++;
    }
    if (n) counts[rel(f)] = n;
  }
  return counts;
}

describe("rule 2 guard: fetch timeouts", () => {
  it("scans the sources", () => {
    expect(sourceFiles("src").length).toBeGreaterThan(100);
  });

  it("fetch( without a timeout signal does not exceed the per-file baseline", () => {
    const actual = count();
    const problems = ratchetProblems(actual, BASELINE, {
      raise: "pass `signal: AbortSignal.timeout(ms)` (or the shared HTTP helper)",
      lower: "violations were removed — lower this baseline (thanks)",
    });
    expect(problems, `${problems.join("\n")}\n\nCurrent counts (paste as BASELINE):\n${formatBaseline(actual)}`).toEqual([]);
  });
});
