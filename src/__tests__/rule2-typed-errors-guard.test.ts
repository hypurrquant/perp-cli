/**
 * Guard: no NEW plain `throw new Error(` in src/commands, src/exchanges, src/bot.
 *
 * A plain Error carries no typed code; it only gets one from the string heuristic in
 * src/errors.ts `classifyError`, so agents see a guessed code instead of a stable one. New
 * failures use `PerpError` (typed code + remediation). The existing ones are a RATCHET: per-file
 * counts below may only go down.
 *
 *  - count went UP   → throw `PerpError` (src/errors.ts) instead of `Error`.
 *  - count went DOWN → good: lower that file's number below (the failure prints the new map).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatBaseline, ratchetProblems, rel, sourceFiles, stripCommentsAndStrings } from "./helpers/strip-source.js";

const DIRS = ["src/commands", "src/exchanges", "src/bot"];
const PLAIN_THROW = /\bthrow\s+(?:new\s+)?Error\s*\(/g;

/** Baseline: plain `throw new Error(` per file (files not listed must stay at 0). */
const BASELINE: Record<string, number> = {
  "src/bot/conditions.ts": 1,
  "src/bot/engine.ts": 1,
  "src/bot/strategies/claude-agent.ts": 1,
  "src/bot/strategies/funding-arb-strategy.ts": 1,
  "src/bot/strategies/funding-auto.ts": 1,
  "src/bot/strategies/grid-strategy.ts": 4,
  "src/bot/strategies/spot-perp-executor.ts": 2,
  "src/commands/account.ts": 1,
  "src/commands/alerts.ts": 1,
  "src/commands/arb-auto.ts": 1,
  "src/commands/arb/index.ts": 1,
  "src/commands/builder.ts": 1,
  "src/commands/funds-onchain.ts": 4,
  "src/commands/funds.ts": 34,
  "src/commands/manage.ts": 3,
  "src/commands/pacifica-earn.ts": 3,
  "src/commands/portfolio.ts": 6,
  "src/commands/rebalance.ts": 5,
  "src/commands/trade.ts": 5,
  "src/commands/wallet.ts": 8,
  "src/exchanges/arcus/adapter.ts": 1,
  "src/exchanges/arcus/agent.ts": 1,
  "src/exchanges/arcus/signing.ts": 2,
  "src/exchanges/arcus/spot.ts": 3,
  "src/exchanges/aster.ts": 5,
  "src/exchanges/hyperliquid-spot.ts": 1,
  "src/exchanges/hyperliquid.ts": 1,
  "src/exchanges/interface.ts": 1,
  "src/exchanges/lighter-rh-deposit.ts": 2,
  "src/exchanges/lighter-spot.ts": 16,
  "src/exchanges/lighter.ts": 26,
  "src/exchanges/ondo/adapter.ts": 1,
  "src/exchanges/pacifica-presigned.ts": 1,
  "src/exchanges/pacifica-typed-data.ts": 1,
  "src/exchanges/pacifica.ts": 1,
  "src/exchanges/precision.ts": 1,
  "src/exchanges/qfex/public.ts": 1,
  "src/exchanges/rate-limiter.ts": 1,
  "src/exchanges/registry.ts": 1,
  "src/exchanges/spot-factory.ts": 5,
  "src/exchanges/txflow/public.ts": 1,
  "src/exchanges/venue-types.ts": 2,
  "src/exchanges/venue.ts": 2,
  "src/exchanges/venues/arcus.ts": 1,
  "src/exchanges/venues/aster.ts": 1,
  "src/exchanges/venues/hyperliquid.ts": 1,
  "src/exchanges/venues/lighter-rh.ts": 1,
  "src/exchanges/venues/lighter.ts": 1,
  "src/exchanges/venues/ondo.ts": 1,
  "src/exchanges/venues/pacifica.ts": 1,
};

function count(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const dir of DIRS) {
    for (const f of sourceFiles(dir)) {
      const n = stripCommentsAndStrings(readFileSync(f, "utf8")).match(PLAIN_THROW)?.length ?? 0;
      if (n) counts[rel(f)] = n;
    }
  }
  return counts;
}

describe("rule 2 guard: typed errors", () => {
  it("scans the command / exchange / bot sources", () => {
    expect(DIRS.flatMap(sourceFiles).length).toBeGreaterThan(40);
  });

  it("plain throw new Error( does not exceed the per-file baseline", () => {
    const actual = count();
    const problems = ratchetProblems(actual, BASELINE, {
      raise: "use PerpError (src/errors.ts) with a typed code, not a plain Error",
      lower: "violations were removed — lower this baseline (thanks)",
    });
    expect(problems, `${problems.join("\n")}\n\nCurrent counts (paste as BASELINE):\n${formatBaseline(actual)}`).toEqual([]);
  });
});
